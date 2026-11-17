// Persistence for channel-vocechat: append-only event log + idempotency set + replay cursor.
//
// Why this is in the transport plugin and not the adapter:
//
//   The platform **does not retry**. Measured: a probe answered 500, then 60 seconds of watching,
//   and exactly one POST arrived. So the ordering rule is not negotiable — the event must be on
//   disk *before* the HTTP 200 goes back, because after that 200 there is no second chance. That
//   makes "write the file" a transport guarantee, not a business decision.
//
// What this file deliberately does NOT promise:
//
//   - **Not zero loss.** `events.jsonl` covers "our process died after we ACKed". It does not
//     cover "the process was down when the platform delivered" — those events are gone forever
//     and the only honest thing to do is log the gap.
//   - **Not durability against disk failure.** Writes are `appendFileSync` with an explicit
//     `fsync` on the ACK path; the OS can still lose the tail on power loss. Stating that plainly
//     is better than an fsync claim nobody verified.
//   - **Not unbounded.** `seen-mids` is a bounded LRU because the file is rewritten on rotation;
//     `last-processed` is one number.
//
// Layout under `<dataRoot>/home/channel-vocechat/`:
//
//   state/seen-mids.json      { key: { mids:[...], updatedAt } }  — bounded LRU, newest last
//   state/last-processed.json { mid, at }                          — replay cursor
//   events/events.jsonl        one JSON line per accepted POST: {event, raw, at}
//   events/gap.jsonl           one JSON line per gap we know about (queue full, replay skipped)
//   diag/mount.json            last mount facts (no payload, no credentials)

import fs from 'node:fs';
import path from 'node:path';

const SEEN_LIMIT = 2000
/** How many claims may pass before the cache is rewritten. */
const SEEN_FLUSH_EVERY = 50;
const DEFAULT_EVENTS_ROTATE_BYTES = 32 * 1024 * 1024;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function readJsonOrNull(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* never fatal */ }
    return false;
  }
}

/** One JSON line, appended and flushed. Returns false instead of throwing. */
function appendLine(file, value, { fsync = false } = {}) {
  let appended = false;
  try {
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
    appended = true;
  } catch {
    return false;
  }
  if (fsync) {
    // Re-open with 'r+' and fsync: appendFileSync leaves no handle to flush, and Windows'
    // FlushFileBuffers refuses a read-only handle, so 'r' would silently fail the durability
    // guarantee while looking like it worked.
    try {
      const fd = fs.openSync(file, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch {
      // The line is on disk in the OS cache either way; a failed fsync is reported by the caller's
      // own counters rather than pretending durability that was not achieved.
      return appended;
    }
  }
  return appended;
}

function rotateIfLarge(file, limitBytes) {
  try {
    const size = fs.statSync(file).size;
    if (size <= limitBytes) return false;
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} input
 * @param {string} input.dataRoot   suite data root (`.../data`), not `data/home`
 * @param {number} [input.seenLimit]
 * @param {number} [input.rotateBytes]
 */
export function createStore({ dataRoot, seenLimit = SEEN_LIMIT, rotateBytes = DEFAULT_EVENTS_ROTATE_BYTES } = {}) {
  // An empty or relative data root is refused rather than resolved: `path.join('', …)` yields a
  // relative path, which would scatter state into whatever the process's cwd happens to be. That
  // is worse than failing — it looks like it worked, and the next start cannot find the files.
  const rootText = String(dataRoot ?? '').trim();
  const absolute = rootText !== '' && path.isAbsolute(rootText) ? path.resolve(rootText) : null;

  const base = absolute === null ? null : path.join(absolute, 'home', 'channel-vocechat');
  const stateDir = base === null ? null : path.join(base, 'state');
  const eventsDir = base === null ? null : path.join(base, 'events');
  const diagDir = base === null ? null : path.join(base, 'diag');

  const eventsFile = eventsDir === null ? null : path.join(eventsDir, 'events.jsonl');
  const gapFile = eventsDir === null ? null : path.join(eventsDir, 'gap.jsonl');
  const seenFile = stateDir === null ? null : path.join(stateDir, 'seen-mids.json');
  const cursorFile = stateDir === null ? null : path.join(stateDir, 'last-processed.json');

  const writable = base !== null && ensureDir(stateDir) && ensureDir(eventsDir) && ensureDir(diagDir);

  // ── idempotency set ───────────────────────────────────────────────────────
  //
  // Two sources, and the ordering matters:
  //
  //   1. `events.jsonl` is the **durable truth**: every accepted mid is in it, and it is written
  //      with fsync *before* the ACK. If the process dies mid-flight, this file still knows.
  //   2. `seen-mids.json` is a **fast cache** rewritten in batches. It is allowed to lag; losing it
  //      only costs a rebuild from (1).
  //
  // The first smoke test proved why this matters: `claim()` alone persisted the cache only when the
  // LRU overflowed, so a restart with no overflow had no memory of the mids it had already handled —
  // a duplicate would have driven a second turn. Rebuilding from the log removes that hole entirely.
  const seenState = readJsonOrNull(seenFile) ?? {};
  /** Insertion-ordered Set: the tail is the newest. */
  const seen = new Set();

  /** Mids present in the event log, newest last, capped. Best-effort; never throws. */
  function midsFromEventLog(limit) {
    if (eventsFile === null) return [];
    const collect = text => {
      const out = [];
      for (const line of String(text ?? '').split('\n')) {
        if (!line.trim()) continue;
        try {
          const mid = JSON.parse(line)?.event?.mid;
          if (Number.isInteger(mid) && mid > 0) out.push(mid);
        } catch { /* a torn final line is expected after a crash; skip it */ }
      }
      return out;
    };
    let body = '';
    try { body = fs.readFileSync(eventsFile, 'utf8'); } catch { return []; }
    let rotated = '';
    try { rotated = fs.readFileSync(`${eventsFile}.1`, 'utf8'); } catch { /* no rotation yet */ }
    const all = [...collect(rotated), ...collect(body)];
    return all.slice(-limit);
  }

  for (const mid of midsFromEventLog(seenLimit)) seen.add(mid);
  if (Array.isArray(seenState.mids)) {
    for (const mid of seenState.mids) {
      if (Number.isInteger(mid) && mid > 0) seen.add(mid);
    }
  }
  while (seen.size > seenLimit) {
    const first = seen.values().next();
    if (first.done) break;
    seen.delete(first.value);
  }

  /** Rewrite the cache. Batched: called every `seenFlushEvery` claims and on flush(). */
  let claimsSinceFlush = 0;
  function persistSeen() {
    const mids = [...seen];
    while (mids.length > seenLimit) mids.shift();
    seen.clear();
    for (const m of mids) seen.add(m);
    writeJsonAtomic(seenFile, { mids, updatedAt: Date.now() });
    claimsSinceFlush = 0;
  }

  /** True when this mid was already accepted. Records it when it was not. */
  function claim(mid) {
    const m = Number(mid);
    if (!Number.isInteger(m) || m <= 0) return false;
    if (seen.has(m)) return false;
    seen.add(m);
    claimsSinceFlush += 1;
    // The cache lags on purpose: `events.jsonl` is already durable before the ACK, so this file is
    // only a warm-start optimisation. Flushing every claim would cost an fsync-grade rename per
    // message for no durability gain.
    if (seen.size > seenLimit || claimsSinceFlush >= SEEN_FLUSH_EVERY) persistSeen();
    return true;
  }

  // ── replay cursor ─────────────────────────────────────────────────────────
  const cursorState = readJsonOrNull(cursorFile) ?? {};
  let lastProcessed = Number.isInteger(cursorState.mid) ? cursorState.mid : 0;

  function setCursor(mid) {
    const m = Number(mid);
    if (!Number.isInteger(m) || m <= lastProcessed) return false;
    lastProcessed = m;
    writeJsonAtomic(cursorFile, { mid: m, at: Date.now() });
    return true;
  }

  // ── event log ─────────────────────────────────────────────────────────────

  /**
   * Persist one accepted POST. Called **before** the HTTP 200 goes back; see the header.
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  function appendEvent(event, raw) {
    if (!writable) return { ok: false, reason: 'data-dir-not-writable' };
    rotateIfLarge(eventsFile, rotateBytes);
    const ok = appendLine(eventsFile, { at: Date.now(), event, raw }, { fsync: true });
    return ok ? { ok: true } : { ok: false, reason: 'append-failed' };
  }

  /** Record a loss we can name: queue overflow, unparseable body, replay skipped. */
  function recordGap(reason, detail = null) {
    if (!writable) return false;
    return appendLine(gapFile, { at: Date.now(), reason: String(reason).slice(0, 120), detail });
  }

  function writeDiag(name, payload) {
    if (!writable) return false;
    return writeJsonAtomic(path.join(diagDir, `${String(name).replace(/[^a-z0-9-]/gi, '_')}.json`), {
      ...payload,
      pid: process.pid,
      at: new Date().toISOString(),
    });
  }

  /** Mids still in the log that the cursor has not passed. Best-effort; never throws. */
  function pendingAfterCursor(limit = 500) {
    try {
      const text = fs.readFileSync(eventsFile, 'utf8');
      const lines = text.split('\n');
      let rotated = '';
      try { rotated = fs.readFileSync(`${eventsFile}.1`, 'utf8'); } catch { /* no rotation yet */ }
      const all = `${rotated}\n${text}`.split('\n');
      const out = [];
      for (const line of all) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const mid = entry?.event?.mid;
        if (!Number.isInteger(mid) || mid <= lastProcessed) continue;
        out.push(entry);
        if (out.length >= limit) break;
      }
      void lines;
      return out;
    } catch {
      return [];
    }
  }

  return {
    // paths, for diagnostics only — never logged with credentials
    base,
    eventsFile,
    gapFile,
    // state
    claim,
    setCursor,
    getCursor: () => lastProcessed,
    seenSize: () => seen.size,
    // persistence
    appendEvent,
    recordGap,
    writeDiag,
    pendingAfterCursor,
    /** Flush the idempotency set to disk (called on dispose). */
    flush() {
      persistSeen();
      return true;
    },
  };
}
