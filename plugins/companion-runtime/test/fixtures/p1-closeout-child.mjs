// A child process that holds an external effect open and then dies **hard**.
//
// The port returns a promise that never settles, so the runtime is stuck exactly where a real
// crash would leave it: the durable intent (`prepared`) is committed, and no result can ever be
// recorded. Then `process.exit(9)` — no finally, no cleanup, no chance to write an outcome.
//
// P1_PHASE:
//   prepared   — the port is never called (the intent is written, then we exit);
//   after-call — the port IS called (it appends to the marker file), then we exit.
import fs from 'node:fs';
import { openRuntimeDb } from '../../lib/db.mjs';
import { dispatchEvent } from '../../lib/events.mjs';
import { applyActivityEvent, createActivities } from '../../lib/activities.mjs';
import { applyPlanEvent } from '../../lib/planner.mjs';
import { scopeKey } from '../../lib/scope.mjs';

const T0 = Date.UTC(2026, 10, 4, 3, 0, 0);
const HOUR = 3600000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);

const dbFile = process.env.P1_DB;
const marker = process.env.P1_MARKER;
const root = process.env.P1_ROOT;
const phase = process.env.P1_PHASE;
const generation = process.env.P1_GENERATION;
const owner = '777777:child:test';

const db = openRuntimeDb({ file: dbFile, now: () => T0 });
if (!db.acquireLease({ owner, generation, ttlMs: 600000 }).ok) process.exit(2);
db.commitProjection({ scope: KEY, generation, payload: {}, updatedAt: T0 });
db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
        VALUES ('plan-child', ?, '2026-11-04', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
KEY, T0 - 6 * HOUR, T0 + 6 * HOUR, T0, T0);
db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
          flexibility, intent, target_ref, status, locked, created_at, updated_at)
        VALUES ('slot-child', 'plan-child', ?, '2026-11-04', ?, ?, 'explore', 'explore', '页面', '{"reality":"actual_tool_activity"}', 'soft', '', 'https://example.test/a', 'planned', 0, ?, ?)`,
KEY, T0 - HOUR, T0 + HOUR, T0, T0);

const activities = createActivities({
  db,
  config: {
    p2: {
      activities: {
        enabled: true, paused: false, chunkUnits: 200, maxUnitsPerStep: 4000,
        maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts',
      },
      autonomy: { allowedSources: ['example.test'] },
    },
  },
  clock: () => T0,
  owner,
  generation,
  dispatch: event => dispatchEvent(db, event, {
    handlers: { autonomy: applyActivityEvent, planner: applyPlanEvent },
    generation, owner, requireConsumers: true,
  }),
  workspace: root,
  ports: {
    readFile() { return { ok: false }; },
    writeFile() { return { ok: false }; },
    fetchPage() {
      if (phase === 'after-call') fs.appendFileSync(marker, 'fetch\n');
      // Never settles: the answer is lost with the process, which is the whole point.
      return new Promise(() => {});
    },
  },
});

try {
  // The intent is committed synchronously before the adapter is invoked, so exiting here leaves a
  // `prepared` record with no outcome — in both phases.
  activities.start({ slotId: 'slot-child', kind: 'explore' });
} catch { /* the exit below is what matters */ }
process.exit(9);
