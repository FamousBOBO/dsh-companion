import { createDb } from './db.mjs';
import { applyEvent, consumersFor, listEvents, CONSUMERS } from './events.mjs';
import { scopeKey, parseScope } from './scope.mjs';

const PROJECTION_TABLES = [
  {
    name: 'goals',
    sql: 'SELECT goal_id, title, source, authorization, status, revision, overdue, deadline_at, next_step, waiting_on, completed_steps, superseded_by, checkpoint FROM goals WHERE scope = ? ORDER BY goal_id',
  },
  {
    name: 'commitments',
    sql: 'SELECT commitment_id, goal_id, body, status, due_at, revision, closed_reason FROM commitments WHERE scope = ? ORDER BY commitment_id',
  },
  {
    name: 'working_memory',
    sql: 'SELECT scope, focus_goal_id, focus_kind, pending_goal, revision, view FROM working_memory WHERE scope = ?',
  },
  {
    name: 'wm_checkpoints',
    sql: 'SELECT checkpoint_id, goal_id, revision, reason, payload FROM wm_checkpoints WHERE scope = ? ORDER BY checkpoint_id',
  },
  {
    name: 'beliefs',
    sql: 'SELECT belief_id, proposition, status, confidence, roots, independence, revision, superseded_by, reason, valid_until FROM beliefs WHERE scope = ? ORDER BY belief_id',
  },
  {
    name: 'belief_evidence',
    sql: 'SELECT belief_id, evidence_id, root_id, relation FROM belief_evidence WHERE belief_id IN (SELECT belief_id FROM beliefs WHERE scope = ?) ORDER BY belief_id, evidence_id, relation',
  },
  {
    name: 'belief_dependents',
    sql: 'SELECT dependent_id, belief_id, kind, status FROM belief_dependents WHERE belief_id IN (SELECT belief_id FROM beliefs WHERE scope = ?) ORDER BY dependent_id, belief_id',
  },
  // H1 agenda (C5 §12.2): definitions and occurrences are written only through the
  // `agenda` consumer, so replay must reproduce them row for row. Wall-clock
  // `created_at`/`updated_at` are excluded for the same reason the P1 tables exclude
  // them: a replay is not a re-occurrence.
  {
    name: 'agenda_items',
    sql: 'SELECT item_id, revision, title, category, source, rule_kind, time_zone, local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery, goal_ref, commitment_ref, request_key, resolution FROM agenda_items WHERE scope = ? ORDER BY item_id',
  },
  {
    name: 'agenda_occurrences',
    sql: 'SELECT occurrence_id, item_id, slot_key, definition_revision, scheduled_at, slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id FROM agenda_occurrences WHERE scope = ? ORDER BY occurrence_id',
  },
  // P2 autonomy (contract section 2): every one of these is written only through the
  // `autonomy` consumer, so a replay must reproduce them row for row. The operational
  // tables (p2_plan_runs / p2_budget_ledger) are deliberately absent: model tokens and
  // budget reservations are accounting, not replay content.
  {
    name: 'p2_plans',
    sql: 'SELECT plan_id, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes FROM p2_plans WHERE scope = ? ORDER BY plan_id',
  },
  {
    name: 'p2_plan_slots',
    sql: 'SELECT slot_id, plan_id, day, start_at, end_at, kind, activity, title, detail, flexibility, intent, target_ref, status, agenda_item_id, agenda_occurrence_id FROM p2_plan_slots WHERE scope = ? ORDER BY slot_id',
  },
  {
    name: 'p2_opportunities',
    sql: 'SELECT opportunity_id, kind, source, dedupe_key, weight, expires_at, status, payload FROM p2_opportunities WHERE scope = ? ORDER BY opportunity_id',
  },
  {
    name: 'p2_interests',
    sql: 'SELECT interest_id, kind, title, note, status, strength, origin, ref, last_touched FROM p2_interests WHERE scope = ? ORDER BY interest_id',
  },
  {
    name: 'p2_activities',
    sql: 'SELECT activity_id, plan_slot_id, kind, adapter, capability, reality, status, target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_version, started_at, paused_at, ended_at FROM p2_activities WHERE scope = ? ORDER BY activity_id',
  },
  {
    name: 'p2_activity_receipts',
    sql: 'SELECT receipt_id, activity_id, operation, ok, code, detail, source_hash, consumed_from, consumed_to, artifact_ref, at, generation FROM p2_activity_receipts WHERE scope = ? ORDER BY receipt_id',
  },
  {
    name: 'p2_share_candidates',
    sql: 'SELECT candidate_id, activity_id, kind, title, body, source_ref, status, decision_at, decision_reason FROM p2_share_candidates WHERE scope = ? ORDER BY candidate_id',
  },
];

function tableRows(db, scope) {
  const out = {};
  for (const table of PROJECTION_TABLES) {
    if (table.name === 'working_memory') {
      const row = db.get(table.sql, scope);
      out[table.name] = row ? [row] : [];
    } else {
      out[table.name] = db.all(table.sql, scope);
    }
  }
  return out;
}

function stable(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.keys(item).sort().reduce((acc, key) => { acc[key] = item[key]; return acc; }, {});
    }
    return item;
  });
}

/**
 * Recovery check: replay the recorded event log into a throwaway in-memory database
 * and compare both the projection and the relational rows with the live database.
 * Replay never calls a model, never regenerates judgments and never re-sends anything.
 */
export function verifyRecovery(db, { scopeKey: key, handlers, now = () => Date.now() } = {}) {
  const scope = typeof key === 'string' ? parseScope(key) : null;
  const normalizedKey = scope ? scopeKey(scope) : (typeof key === 'string' ? key : '');
  if (!normalizedKey) throw new Error('verifyRecovery requires a scope key');
  const events = listEvents(db, { scopeKey: normalizedKey, limit: 100000 });
  const scratch = createDb({ file: ':memory:', now, pragmas: false });
  const mismatches = [];
  try {
    scratch.migrate();
    // One replay pass: every consumer that handles a kind applies it in order, with
    // the same handlers the live runtime uses.
    for (const event of events) {
      for (const consumer of consumersFor(event.kind)) {
        const handler = handlers?.[consumer];
        if (!handler) continue;
        try {
          applyEvent(scratch, { consumer, event, apply: handler });
        } catch (error) {
          mismatches.push({ consumer, eventId: event.eventId, kind: 'replay-error', message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    const liveProjection = db.projection(normalizedKey);
    const replayedProjection = scratch.projection(normalizedKey);
    if (stable(liveProjection.payload) !== stable(replayedProjection.payload)) {
      mismatches.push({ kind: 'projection-mismatch', live: liveProjection.payload, replayed: replayedProjection.payload });
    }
    if (liveProjection.version !== replayedProjection.version) {
      mismatches.push({ kind: 'version-mismatch', live: liveProjection.version, replayed: replayedProjection.version });
    }
    const live = tableRows(db, normalizedKey);
    const replayed = tableRows(scratch, normalizedKey);
    for (const table of PROJECTION_TABLES) {
      if (stable(live[table.name]) !== stable(replayed[table.name])) {
        mismatches.push({ kind: 'table-mismatch', table: table.name, live: live[table.name], replayed: replayed[table.name] });
      }
    }
    return {
      ok: mismatches.length === 0,
      scopeKey: normalizedKey,
      replayed: events.length,
      projectionVersion: liveProjection.version,
      mismatches,
    };
  } finally {
    scratch.close();
  }
}

/** Snapshot contents without private payloads; used by diagnostics and reports. */
export function snapshotSummary(db, key) {
  const projection = db.projection(key);
  return {
    scopeKey: key,
    version: projection.version,
    generation: projection.generation,
    consumers: Object.keys(CONSUMERS),
    payloadKeys: Object.keys(projection.payload ?? {}),
  };
}
