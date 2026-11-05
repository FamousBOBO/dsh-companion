import { createHash } from 'node:crypto';
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STATUSES = new Set(['completed', 'failed', 'unknown', 'quota-exhausted']);
const INTERACTIONS = new Set(['like', 'favorite', 'comment', 'reply', 'message']);

function evidenceOf(value) {
  if (value?.kind === 'report' && value.written === true) return { kind: 'report', written: true };
  if (value?.kind === 'watch' && /^BV[a-zA-Z0-9]{10}$/.test(value.videoId)
    && Number.isFinite(value.consumedSeconds) && value.consumedSeconds > 0) {
    return { kind: 'watch', videoId: value.videoId, consumedSeconds: value.consumedSeconds,
      ...(value.method === 'transcript' ? { method: value.method } : {}) };
  }
  if (value?.kind === 'interaction' && INTERACTIONS.has(value.action)
    && typeof value.targetId === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value.targetId)
    && ['confirmed', 'failed', 'unknown'].includes(value.status)) {
    return { kind: 'interaction', action: value.action, targetId: value.targetId, status: value.status };
  }
  return null;
}

export function summarizeBilibiliRound(result, roundId) {
  if (result?.roundId !== roundId || !STATUSES.has(result?.status)) {
    return { roundId, status: 'unknown', evidence: [], watched: 0 };
  }
  const evidence = Array.isArray(result.evidence) ? result.evidence.slice(0, 100).map(evidenceOf).filter(Boolean) : [];
  const watched = new Set(evidence.filter(item => item.kind === 'watch').map(item => item.videoId)).size;
  return { roundId, status: result.status, evidence, watched };
}

function readRound(file, roundId) {
  const evidence = [];
  let status = 'unknown';
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { roundId, status, evidence };
  }
  // A killed writer can leave a partial last line. Only complete records count.
  for (const line of lines.slice(0, -1)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const fact = evidenceOf(row);
    if (fact) evidence.push(fact);
    if (STATUSES.has(row?.terminal)) status = row.terminal;
  }
  return { roundId, status, evidence };
}

/** The adapter calls record only for observed effects, independently of its Markdown report. */
export function createBilibiliRounds({ directory, execute, now = Date.now }) {
  return async function run({ roundId, deadlineAt, signal }) {
    if (typeof roundId !== 'string' || !roundId || roundId.length > 256 || !Number.isFinite(deadlineAt)) {
      throw new TypeError('Invalid Bilibili round request');
    }
    mkdirSync(directory, { recursive: true });
    const key = createHash('sha256').update(roundId).digest('hex');
    const claim = join(directory, key);
    const journal = join(claim, 'result.ndjson');
    if (existsSync(claim)) return readRound(journal, roundId);
    if (signal?.aborted || deadlineAt <= now()) return { roundId, status: 'failed', evidence: [] };
    try {
      mkdirSync(claim);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return readRound(journal, roundId);
    }

    let terminal = 'unknown';
    let closed = false;
    const timeout = AbortSignal.timeout(Math.min(2_147_483_647, Math.max(0, Math.ceil(deadlineAt - now()))));
    const executionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const record = value => {
      if (closed) throw new Error('Bilibili round already settled');
      const fact = evidenceOf(value);
      if (!fact) throw new TypeError('Invalid Bilibili evidence');
      appendFileSync(journal, JSON.stringify(fact) + '\n', { flush: true });
    };
    try {
      const result = await execute({ roundId, deadlineAt, signal: executionSignal, record, journalPath: journal });
      if (!executionSignal.aborted && deadlineAt > now() && STATUSES.has(result?.status)) terminal = result.status;
    } catch {
      // The child may have reached Bilibili before its reply was lost.
    } finally {
      closed = true;
      appendFileSync(journal, JSON.stringify({ terminal }) + '\n', { flush: true });
    }
    return readRound(journal, roundId);
  };
}
