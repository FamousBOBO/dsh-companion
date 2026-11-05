import fs from 'node:fs';
import path from 'node:path';
import { dayKey, nowIso, stableJson } from './ids.mjs';

// One process-local JSON ledger for jobs, artifacts, receipts, quotas and the
// vision cache. It is deliberately not SQLite: the memory database stays the
// single authority for memories, and media bookkeeping must be cheap to inspect,
// back up and delete. Writes are atomic (tmp + rename) and serialized per root.

const SCHEMA_VERSION = 1;

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, jobs: {}, artifacts: {}, receipts: {}, quotas: {}, cache: {} };
}


export function createLedger({ root, file = 'state/ledger.json', maxCacheItems = 300, now = nowIso } = {}) {
  if (!root) throw new Error('ledger root is required');
  const dir = path.join(root);
  const filePath = path.join(dir, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let state = emptyState();
  try {
    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (loaded?.schemaVersion === SCHEMA_VERSION) state = { ...emptyState(), ...loaded };
  } catch { /* first run or unreadable ledger starts empty */ }

  const persist = () => {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  };

  // Single writer per process: every mutation persists immediately. The ledger is
  // small, and a synchronous write keeps quota/refund decisions atomic with respect
  // to the caller that is about to spend money.
  const mutate = fn => {
    const result = fn(state);
    persist();
    return result;
  };

  return {
    filePath,
    snapshot() { return structuredClone(state); },

    getJob(jobId) { return state.jobs[jobId] ? structuredClone(state.jobs[jobId]) : undefined; },
    listJobs(limit = 20) {
      return Object.values(state.jobs)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit)
        .map(job => structuredClone(job));
    },
    findJobByIdempotencyKey(key) {
      const found = Object.values(state.jobs).find(job => job.idempotencyKey === key);
      return found ? structuredClone(found) : undefined;
    },
    /** Create one job. A repeated idempotency key returns the stored job unchanged. */
    createJob(job) {
      const existing = Object.values(state.jobs).find(item => item.idempotencyKey === job.idempotencyKey);
      if (existing) return { job: structuredClone(existing), created: false };
      const record = { attempts: 0, cancelRequested: false, ...job };
      return mutate(current => {
        current.jobs[record.jobId] = record;
        return { job: structuredClone(record), created: true };
      });
    },
    updateJob(jobId, patch) {
      return mutate(current => {
        const existing = current.jobs[jobId];
        if (!existing) return undefined;
        current.jobs[jobId] = { ...existing, ...patch, updatedAt: now() };
        return structuredClone(current.jobs[jobId]);
      });
    },

    putArtifact(artifact) {
      return mutate(current => {
        current.artifacts[artifact.artifactId] = artifact;
        return structuredClone(artifact);
      });
    },
    getArtifact(artifactId) {
      return state.artifacts[artifactId] ? structuredClone(state.artifacts[artifactId]) : undefined;
    },
    listArtifacts(limit = 20) {
      return Object.values(state.artifacts)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit)
        .map(item => structuredClone(item));
    },

    putReceipt(receipt) {
      return mutate(current => {
        current.receipts[receipt.receiptId] = receipt;
        return structuredClone(receipt);
      });
    },
    listReceipts(limit = 20) {
      return Object.values(state.receipts)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, limit)
        .map(item => structuredClone(item));
    },

    /**
     * Consume one unit of a scope quota for today.
     * `-1` means unlimited, `0` means disabled; both are reported, not guessed.
     */
    consumeQuota({ scope, limit, date = dayKey() }) {
      const key = `${scope}:${date}`;
      const used = state.quotas[key] ?? 0;
      if (limit === 0) return { allowed: false, reason: 'disabled', used, limit, scope, date };
      if (typeof limit === 'number' && limit < 0) {
        return mutate(current => {
          current.quotas[key] = used + 1;
          return { allowed: true, used: used + 1, limit, scope, date };
        });
      }
      if (used >= limit) return { allowed: false, reason: 'exhausted', used, limit, scope, date };
      return mutate(current => {
        current.quotas[key] = used + 1;
        return { allowed: true, used: used + 1, limit, scope, date };
      });
    },
    refundQuota({ scope, date = dayKey() }) {
      const key = `${scope}:${date}`;
      return mutate(current => {
        current.quotas[key] = Math.max(0, (current.quotas[key] ?? 0) - 1);
        return { used: current.quotas[key], scope, date };
      });
    },
    quotaUsed({ scope, date = dayKey() }) {
      return state.quotas[`${scope}:${date}`] ?? 0;
    },

    cacheGet(key) {
      const entry = state.cache[key];
      if (!entry) return undefined;
      return { value: entry.value, at: entry.at };
    },
    cacheSet(key, value) {
      return mutate(current => {
        current.cache[key] = { value, at: now() };
        const keys = Object.entries(current.cache).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
        while (keys.length > maxCacheItems) {
          const [oldest] = keys.shift();
          delete current.cache[oldest];
        }
        return value;
      });
    },
    cacheSize() { return Object.keys(state.cache).length; },
    cacheBust() {
      return mutate(current => {
        current.cache = {};
        return 0;
      });
    },

    /** Diagnostic view: counts and ids only, never content. */
    summary() {
      return {
        jobs: Object.keys(state.jobs).length,
        artifacts: Object.keys(state.artifacts).length,
        receipts: Object.keys(state.receipts).length,
        cache: Object.keys(state.cache).length,
        file: filePath,
      };
    },
    /** Stable digest of a request's parameters, for logs. */
    paramsDigest(params) { return stableJson(params); },
  };
}

