import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './config-store.mjs';

/**
 * The job/artifact ledger.
 *
 * It lives under `<dataDir>/media/state/` (gitignored), never in the repository,
 * and it stores NO prompt text and no media bytes — only digests and metadata.
 * Generation records are personal data; a repo must never carry them.
 */

export function createLedger({ dataDir, now = () => new Date(), keepArtifacts = 500 } = {}) {
  if (!dataDir) throw new Error('createLedger needs dataDir');
  const file = path.join(dataDir, 'media', 'state', 'ledger.json');
  let state = { schemaVersion: 1, jobs: {}, artifacts: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.schemaVersion === 1) state = { ...state, ...parsed };
  } catch { /* first run */ }

  const persist = () => writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);

  const prune = () => {
    const artifacts = Object.values(state.artifacts).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const extra of artifacts.slice(keepArtifacts)) delete state.artifacts[extra.artifactId];
    const jobs = Object.values(state.jobs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const extra of jobs.slice(keepArtifacts)) delete state.jobs[extra.jobId];
  };

  return {
    file,
    createJob({ kind, provider, model = '', requestDigest = '' }) {
      const jobId = crypto.randomUUID();
      const job = {
        jobId,
        kind,
        provider,
        model,
        requestDigest,
        state: 'running',
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        error: null,
      };
      state.jobs[jobId] = job;
      persist();
      return { ...job };
    },
    finishJob(jobId, { state: nextState, error = null, artifactId = null, bytes = 0 }) {
      const job = state.jobs[jobId];
      if (!job) return undefined;
      job.state = nextState;
      job.error = error;
      job.artifactId = artifactId;
      job.bytes = bytes;
      job.updatedAt = now().toISOString();
      prune();
      persist();
      return { ...job };
    },
    putArtifact(artifact) {
      state.artifacts[artifact.artifactId] = { ...artifact, createdAt: now().toISOString() };
      prune();
      persist();
      return { ...artifact };
    },
    getJob(jobId) {
      return state.jobs[jobId] ? { ...state.jobs[jobId] } : undefined;
    },
    listJobs(limit = 10) {
      return Object.values(state.jobs)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit)
        .map(job => ({ ...job }));
    },
    listArtifacts(limit = 10) {
      return Object.values(state.artifacts)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit)
        .map(item => ({ ...item }));
    },
    summary() {
      return { jobs: Object.keys(state.jobs).length, artifacts: Object.keys(state.artifacts).length, file };
    },
  };
}

/**
 * Write one produced artefact under `<dataDir>/media/artifacts/<kind>/`.
 * The filename is the content digest, so a private original filename never
 * reaches the ledger, the log or a downstream message.
 */
export function writeArtifact({ dataDir, kind, bytes, extension }) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = path.join(dataDir, 'media', 'artifacts', kind);
  fs.mkdirSync(dir, { recursive: true });
  const absolute = path.join(dir, `${digest.slice(0, 32)}.${extension}`);
  fs.writeFileSync(absolute, bytes, { mode: 0o600 });
  return { artifactId: `sha256:${digest}`, absolutePath: absolute, sha256: digest, bytes: bytes.length };
}

export function digestOf(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 32);
}
