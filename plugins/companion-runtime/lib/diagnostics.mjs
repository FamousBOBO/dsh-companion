import { CONSUMERS } from './events.mjs';
import { DEFAULT_CONFIG } from './config.mjs';
import { p2Observability } from './observability.mjs';

/**
 * A legacy count: `0` when the query succeeds and the table is genuinely empty (or does not exist yet,
 * which is a real "no rows" answer for a fresh database), and **`null`** when the query itself failed.
 * round-5 review: the old version answered `0` for both, so a broken database looked healthy.
 */
function count(db, sql, ...params) {
  try {
    const row = db.get(sql, ...params);
    return Number(row?.n ?? 0);
  } catch (error) {
    const code = String(error?.code ?? '');
    if (code === 'ERR_SQLITE_ERROR' && /no such table/i.test(String(error?.message ?? ''))) return 0;
    return null;
  }
}

export function consumerCounts(db, scopeKey) {
  const out = {};
  for (const consumer of Object.keys(CONSUMERS)) {
    out[consumer] = scopeKey
      ? count(db, 'SELECT COUNT(*) AS n FROM consumer_receipts WHERE consumer = ? AND scope = ?', consumer, scopeKey)
      : count(db, 'SELECT COUNT(*) AS n FROM consumer_receipts WHERE consumer = ?', consumer);
  }
  return out;
}

export function goalCounts(db, scopeKey) {
  const where = scopeKey ? 'WHERE scope = ?' : '';
  const params = scopeKey ? [scopeKey] : [];
  return {
    active: count(db, `SELECT COUNT(*) AS n FROM goals ${where}${where ? ' AND' : 'WHERE'} status IN ('proposed','accepted','running','paused')`, ...params),
    overdue: count(db, `SELECT COUNT(*) AS n FROM goals ${where}${where ? ' AND' : 'WHERE'} overdue = 1`, ...params),
    completed: count(db, `SELECT COUNT(*) AS n FROM goals ${where}${where ? ' AND' : 'WHERE'} status = 'completed'`, ...params),
    openCommitments: count(db, `SELECT COUNT(*) AS n FROM commitments ${where}${where ? ' AND' : 'WHERE'} status = 'open'`, ...params),
  };
}

export function beliefCounts(db, scopeKey) {
  const where = scopeKey ? 'WHERE scope = ?' : '';
  const params = scopeKey ? [scopeKey] : [];
  return {
    current: count(db, `SELECT COUNT(*) AS n FROM beliefs ${where}${where ? ' AND' : 'WHERE'} status IN ('supported','unknown')`, ...params),
    unknown: count(db, `SELECT COUNT(*) AS n FROM beliefs ${where}${where ? ' AND' : 'WHERE'} status = 'unknown'`, ...params),
    superseded: count(db, `SELECT COUNT(*) AS n FROM beliefs ${where}${where ? ' AND' : 'WHERE'} status = 'superseded'`, ...params),
    refuted: count(db, `SELECT COUNT(*) AS n FROM beliefs ${where}${where ? ' AND' : 'WHERE'} status = 'refuted'`, ...params),
  };
}

export function outboxCounts(db, scopeKey) {
  const where = scopeKey ? 'WHERE scope = ?' : '';
  const params = scopeKey ? [scopeKey] : [];
  return {
    queued: count(db, `SELECT COUNT(*) AS n FROM memory_outbox ${where}${where ? ' AND' : 'WHERE'} status = 'queued'`, ...params),
    sent: count(db, `SELECT COUNT(*) AS n FROM memory_outbox ${where}${where ? ' AND' : 'WHERE'} status = 'sent'`, ...params),
    failed: count(db, `SELECT COUNT(*) AS n FROM memory_outbox ${where}${where ? ' AND' : 'WHERE'} status = 'failed'`, ...params),
  };
}

/**
 * H1/H2 diagnostic defaults. A capability that is not loaded or not registered must
 * say so instead of looking healthy: `state: 'pending-load'` is the honest answer for
 * code that has not been mounted yet (C5 §12.5.10).
 */
export function emptyAgendaStatus(enabled = false) {
  return {
    enabled,
    // A switch that is on while the module is not registered is `pending-load`, never
    // `idle`: reporting a healthy idle capability that does not exist is a lie (C5 §12.9).
    state: enabled ? 'pending-load' : 'disabled',
    pendingLoad: enabled,
    items: 0,
    occurrences: { scheduled: 0, due: 0, dispatched: 0, skipped: 0, cancelled: 0, expired: 0 },
    nextOccurrenceAt: null,
    delivery: 'none',
    reminderDelivery: enabled ? 'not-wired' : 'disabled',
  };
}

export function emptyHeartbeatStatus(enabled = false) {
  return {
    enabled,
    state: enabled ? 'pending-load' : 'disabled',
    pendingLoad: enabled,
    registered: false,
    paused: false,
    pausedReason: '',
    owner: null,
    generation: null,
    lease: { state: 'unknown', expiresAt: null, valid: false, renewFailures: 0 },
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastCycle: null,
    backlog: { due: 0, oldestDueAt: null, backlogAgeMs: null },
    cursor: { scopes: 0, settledUntilMin: null, eventSeqMax: null, rejections: 0 },
    failures: { count: 0, lastCode: null, lastAt: null },
    recovery: 'idle',
    activityDispatch: 'unavailable',
    // Shape stability for the P2.5 observability fields (CONTRACT §15.2): an unmounted heartbeat
    // has dispatched nothing, but `0` would read as a measurement, so both stay empty/null.
    activityDispatchLimit: 0,
    activityDispatchLastCycle: null,
    timer: 'stopped',
  };
}

/**
 * Diagnostic snapshot: ids, versions, counts and reason codes only — no private text,
 * no chain of thought. Safe to expose through a tool or a report file.
 */
export function status(db, {
  scopeKey, mode = 'off', config = DEFAULT_CONFIG, lease = null, generation = '',
  injection = { state: 'idle', chars: 0 }, memory = { available: false }, writable = false,
  stopped = false, dbFile = '', schemaVersion = 0, shadow = null, errors = [],
  agenda = null, heartbeat = null, observability = null, agendaPublication = null,
} = {}) {
  return {
    version: '0.1.0',
    mode,
    writable,
    stopped,
    generation,
    lease: lease ?? { state: 'none' },
    schemaVersion,
    dbFile,
    scopeKey: scopeKey ?? null,
    eventCount: scopeKey
      ? count(db, 'SELECT COUNT(*) AS n FROM domain_events WHERE scope = ?', scopeKey)
      : count(db, 'SELECT COUNT(*) AS n FROM domain_events'),
    receipts: consumerCounts(db, scopeKey),
    goals: goalCounts(db, scopeKey),
    beliefs: beliefCounts(db, scopeKey),
    outbox: outboxCounts(db, scopeKey),
    shadow: shadow ?? { count: 0, mode: 'off', lastDecision: null },
    injection,
    memory,
    agenda: agenda ?? emptyAgendaStatus(config.agenda?.enabled === true),
    heartbeat: heartbeat ?? emptyHeartbeatStatus(config.heartbeat?.enabled === true),
    /** P2.5-4C read-only projection. It is a projection of the P2 controller's state, not the authority. */
    observability: observability ?? p2Observability(db, {
      scopeKey: scopeKey ?? '',
      now: Date.now(),
      switches: { activities: config.p2?.activities?.enabled === true, planning: config.p2?.planning?.enabled === true },
      // Whatever the mount recorded about publishing the agenda service ("published but unreadable"
      // must be visible, not only logged).
      agendaPublication: agendaPublication ?? null,
    }),
    config: {
      enabled: config.enabled === true,
      mode: config.mode,
      injectionBudget: config.injection?.budgetChars ?? 0,
      bridgeEnabled: config.bridge?.enabled === true,
      agendaEnabled: config.agenda?.enabled === true,
      heartbeatEnabled: config.heartbeat?.enabled === true,
    },
    errors: errors.slice(0, 20),
  };
}
