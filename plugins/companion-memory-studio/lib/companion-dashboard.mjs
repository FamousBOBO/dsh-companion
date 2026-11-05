import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scopeKey, databaseFile } from '../../companion-runtime/lib/scope.mjs';

// Separate read-only connection: never acquires the runtime writer lease or migrates.
export async function companionDashboard(request, kernel) {
  const viewer = kernel.viewer(await kernel.internal());
  const scope = scopeKey(viewer);
  const readJson = relative => {
    try { return JSON.parse(fs.readFileSync(path.join(kernel.root, relative), 'utf8')); }
    catch { return null; }
  };
  const config = readJson('home/companion/runtime.config.json');
  const media = readJson('home/media/config.json');
  const contact = readJson('home/channel-qq/contact.json');
  const result = {
    observedAt: new Date().toISOString(), persona: viewer.personaId,
    runtime: { available: false, enabled: config?.enabled ?? null, mode: config?.mode ?? 'unknown',
      agenda: config?.agenda?.enabled ?? null, heartbeat: config?.heartbeat?.enabled ?? null,
      pollIntervalMs: config?.heartbeat?.pollIntervalMs ?? null, bridge: config?.bridge?.enabled ?? null },
    media: media ? Object.fromEntries(['enabled', 'vision', 'speech', 'image', 'screen'].map(key =>
      [key, key === 'enabled' ? Boolean(media[key]) : Boolean(media[key]?.enabled)])) : null,
    sections: {}, unavailable: [],
  };
  // Only the bound owner's private delivery counters; no draft bodies or tokens.
  const room = `dm-${viewer.userId}`;
  const counters = contact?.counters;
  result.contact = counters ? {
    day: counters.day, sentToday: counters.sentTodayByRoom?.[room] ?? 0,
    lastSentAt: counters.lastSentAtByRoom?.[room] ?? null,
    unanswered: counters.unansweredStreakByRoom?.[room] ?? 0,
  } : null;
  const queries = {
    state: 'SELECT slots, evaluated_at FROM role_state WHERE scope=?',
    goals: 'SELECT goal_id, title, status, deadline_at, next_step, waiting_on, updated_at FROM goals WHERE scope=? ORDER BY updated_at DESC LIMIT 100',
    commitments: 'SELECT commitment_id, body, status, due_at, updated_at FROM commitments WHERE scope=? ORDER BY updated_at DESC LIMIT 100',
    working: 'SELECT focus_goal_id, focus_kind, pending_goal, revision, updated_at FROM working_memory WHERE scope=?',
    beliefs: 'SELECT belief_id, proposition, status, confidence, valid_until, updated_at FROM beliefs WHERE scope=? ORDER BY updated_at DESC LIMIT 100',
    agenda: 'SELECT item_id, title, category, rule_kind, time_zone, local_date, local_time, status FROM agenda_items WHERE scope=? ORDER BY updated_at DESC LIMIT 100',
    occurrences: 'SELECT occurrence_id, item_id, scheduled_at, status FROM agenda_occurrences WHERE scope=? ORDER BY scheduled_at DESC LIMIT 100',
    heartbeat: 'SELECT consumer, cycles, settled_until, paused_at, updated_at FROM heartbeat_cursor WHERE scope=?',
    events: 'SELECT event_id, kind, occurred_at, reality_status, evidence_status FROM domain_events WHERE scope=? ORDER BY seq DESC LIMIT 100',
    bridge: 'SELECT outbox_id, namespace, status, attempts, updated_at FROM memory_outbox WHERE scope=? ORDER BY updated_at DESC LIMIT 100',
    proposals: 'SELECT proposal_id, kind, decision, created_at FROM shadow_proposals WHERE scope=? ORDER BY created_at DESC LIMIT 100',
    p2_plan: 'SELECT plan_id, day, version, status, window_start, window_end, summary, committed_at FROM p2_plans WHERE scope=? ORDER BY committed_at DESC LIMIT 1',
    p2_slots: 'SELECT slot_id, plan_id, start_at, end_at, kind, activity, title, flexibility, status, locked, reality, intent, target_ref FROM p2_plan_slots WHERE scope=? ORDER BY start_at DESC LIMIT 40',
    p2_activities: `SELECT activity_id, plan_slot_id, kind, adapter, reality, status, target, consumed_prefix, total_units, artifact_version, source_hash, started_at, paused_at, ended_at, updated_at,
      CASE WHEN kind = 'bilibili' AND json_valid(checkpoint) THEN json_extract(checkpoint, '$.bilibiliRound.status') END AS bili_status,
      CASE WHEN kind = 'bilibili' AND json_valid(checkpoint) THEN json_extract(checkpoint, '$.bilibiliRound.watched') END AS bili_watched
      FROM p2_activities WHERE scope=? ORDER BY updated_at DESC LIMIT 20`,
    p2_receipts: 'SELECT activity_id, operation, ok, code, at FROM p2_activity_receipts WHERE scope=? ORDER BY at DESC LIMIT 20',
    p2_share: 'SELECT candidate_id, title, status, created_at FROM p2_share_candidates WHERE scope=? ORDER BY created_at DESC LIMIT 20',
    p2_opportunities: 'SELECT opportunity_id, kind, source, status, created_at FROM p2_opportunities WHERE scope=? ORDER BY created_at DESC LIMIT 20',
    p2_interests: 'SELECT interest_id, kind, title, status, strength, last_touched FROM p2_interests WHERE scope=? ORDER BY last_touched DESC LIMIT 20',
  };
  let db;
  try {
    const file = databaseFile(kernel.root);
    if (fs.existsSync(file)) {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout=1000; BEGIN');
      result.runtime.available = true;
      for (const [key, sql] of Object.entries(queries)) {
        try { result.sections[key] = db.prepare(sql).all(scope); }
        catch { result.unavailable.push(key); }
      }
      db.exec('COMMIT');
    }
  } finally { db?.close(); }
  // H5 life view: current / up next / finished today / unfinished, built only from the rows
  // above. A plan is not an experience: slots are "planned" until a receipt exists, and a
  // simulated activity is labelled as such in every group.
  result.life = buildLife(result, config, Date.now());
  return kernel.ok(result);
}

const DAY_MS = 86400000;

/**
 * 近期经历投影（P2.5-2 E7）：**只读**地把"最近已经发生过的活动"整理成人话。
 *
 * 三件事必须说清：
 *  1. 它**是投影不是权威**：数据只来自 `p2_activities` + `p2_activity_receipts` 两段已经读出来的行
 *     （`companionDashboard` 用 `readOnly: true` 的连接取的行），这里一个字节都不写回。
 *     权威始终是事件书 + runner：本函数只是把行翻译成"完成 / 失败 / 跳过 / 待复核"。
 *  2. **结果不能从 `status` 单读**：`status='done'` 也可能没有 finish 回执，而 `status='running'`
 *     的行可能已经拿到 `finish ok=1`（生产上见过 slot 停在 `started` 而活动真完成）。所以判据是
 *     "回执优先、状态兜底"，与 `outcomeOf()` 同口径。
 *  3. **还在跑的（running）不算"经历"**：它属于"现在正在做"，已经在 `current.activities` 里。
 *     把 running 混进"最近经历"就是拿计划冒充发生。
 */
export function buildExperience(activities = [], receipts = [], now = Date.now()) {
  const finishedOk = new Set();
  const reviewed = new Map();
  for (const row of Array.isArray(receipts) ? receipts : []) {
    const activityId = row?.activity_id;
    if (!activityId) continue;
    if (String(row.operation) === 'finish' && Number(row.ok) === 1) finishedOk.add(String(activityId));
    // `review ok=0` = 复核没过 ⇒ 待复核（与 life 视图同一证据口径）。
    if (String(row.operation) === 'review' && Number(row.ok) === 0) reviewed.set(String(activityId), String(row.code ?? '').slice(0, 60));
  }
  const RESULT = {
    completed: { label: '完成', tone: 'ok' },
    failed: { label: '失败', tone: 'warn' },
    skipped: { label: '跳过', tone: 'neutral' },
    review: { label: '待复核', tone: 'warn' },
  };
  const resultOf = activity => {
    const status = String(activity?.status ?? '');
    const id = String(activity?.activity_id ?? '');
    if (finishedOk.has(id) || status === 'done') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'abandoned') return 'skipped';
    if (status === 'paused' || reviewed.has(id)) return 'review';
    return null; // running / 未知：不属于"已经发生"
  };
  const items = [];
  for (const activity of Array.isArray(activities) ? activities : []) {
    const result = resultOf(activity);
    if (result === null) continue;
    const at = Number(activity.ended_at) || Number(activity.updated_at) || 0;
    items.push({
      activityId: activity.activity_id,
      kind: String(activity.kind ?? '').slice(0, 40),
      target: String(activity.target ?? '').slice(0, 120),
      result,
      resultLabel: RESULT[result].label,
      tone: RESULT[result].tone,
      at,
      // "来源"分两层：谁跑的（adapter）与是不是模拟（reality）——模拟的那条永远不许读成真的。
      source: String(activity.adapter ?? '').slice(0, 60),
      reality: String(activity.reality ?? '').slice(0, 60),
      simulated: String(activity.reality ?? '') === 'simulated_world',
    });
  }
  items.sort((a, b) => b.at - a.at);
  const counts = { completed: 0, failed: 0, skipped: 0, review: 0 };
  for (const item of items) counts[item.result] += 1;
  return {
    // 页面必须把这句话显示出来：让读的人知道"这不是权威状态"。
    authority: 'projection',
    note: '只读投影：由活动与回执派生，不是权威状态（权威是事件书与 runner）。',
    source: 'p2_activities + p2_activity_receipts',
    observedAt: Number.isFinite(now) ? now : Date.now(),
    items: items.slice(0, 10),
    counts,
    total: items.length,
    emptyNote: '暂无经历',
  };
}

/** Group today's plan slots and activities into the four life states the page shows. */
export function buildLife(result, config, now = Date.now()) {
  const sections = result?.sections ?? {};
  const slots = Array.isArray(sections.p2_slots) ? sections.p2_slots : [];
  const activities = Array.isArray(sections.p2_activities) ? sections.p2_activities : [];
  const receipts = Array.isArray(sections.p2_receipts) ? sections.p2_receipts : [];
  const agenda = Array.isArray(sections.agenda) ? sections.agenda : [];
  const occurrences = Array.isArray(sections.occurrences) ? sections.occurrences : [];
  const plan = Array.isArray(sections.p2_plan) ? sections.p2_plan[0] ?? null : null;
  const planningOn = config?.p2?.planning?.enabled === true;
  const activitiesOn = config?.p2?.activities?.enabled === true;

  // ---- evidence indexes -------------------------------------------------------
  // A slot's outcome comes from evidence (activity + receipts), never from the raw
  // `p2_plan_slots.status`: the runtime leaves a finished slot at `started` and
  // production showed `未完成` next to a real `finish ok=1` receipt because of it.
  const byPlanSlot = new Map();
  const byStart = new Map();
  for (const activity of activities) {
    const slotId = activity?.plan_slot_id;
    if (slotId) byPlanSlot.set(String(slotId), activity);
    const started = Number(activity?.started_at);
    // Older rows carry no `plan_slot_id`; the runtime starts an activity exactly at its
    // slot's `start_at`, so an exact instant match is the honest fallback join.
    if (Number.isFinite(started) && started > 0 && !byStart.has(started)) byStart.set(started, activity);
  }
  const finishedOk = new Set();
  const reviewed = new Map();
  for (const row of receipts) {
    const activityId = row?.activity_id;
    if (!activityId) continue;
    if (String(row.operation) === 'finish' && Number(row.ok) === 1) finishedOk.add(activityId);
    if (String(row.operation) === 'review' && Number(row.ok) === 0) reviewed.set(activityId, String(row.code ?? '').slice(0, 60));
  }
  const activityFor = slot => byPlanSlot.get(String(slot.slot_id)) ?? byStart.get(Number(slot.start_at)) ?? null;

  const OUTCOME_LABEL = {
    completed: '已完成',
    'rest-ended': '已结束（休息）',
    review: '待复核',
    missed: '未完成',
    upcoming: '计划中',
    skipped: '已跳过',
  };
  const OUTCOME_TONE = {
    completed: 'ok', 'rest-ended': 'neutral', review: 'warn', missed: 'warn', upcoming: 'neutral', skipped: 'warn',
  };

  /**
   * Derive what really happened to one slot.
   *
   * `completed` needs evidence: a `done` activity for that slot, or its `finish` receipt with
   * `ok=1`. A rest window that ended is `rest-ended` — rest is never a failure. `review` is a
   * paused/failed activity or a `review` receipt. Only an activity slot that ended with no
   * activity and no receipt may read `missed` (未完成).
   */
  function outcomeOf(slot, activity) {
    const status = String(slot?.status ?? '');
    if (status === 'skipped') return 'skipped';
    const startAt = Number(slot?.start_at);
    const endAt = Number(slot?.end_at);
    const ended = Number.isFinite(endAt) && endAt <= now;
    const isRest = slot?.kind === 'rest';
    if (activity) {
      if (activity.kind === 'bilibili' && activity.bili_status === 'quota-exhausted') return 'skipped';
      if (activity.status === 'done' || finishedOk.has(activity.activity_id)) return 'completed';
      if (activity.status === 'paused' || activity.status === 'failed' || reviewed.has(activity.activity_id)) return 'review';
    } else if (status === 'done') {
      // Legacy row that recorded its own completion on the slot.
      return 'completed';
    }
    if (isRest) return ended ? 'rest-ended' : 'upcoming';
    if (ended) return 'missed';
    return 'upcoming';
  }

  const inDay = slot => (plan
    ? slot.plan_id === plan.plan_id
    : Math.abs(Number(slot.start_at) - now) < DAY_MS);
  const todays = slots.filter(inDay).sort((a, b) => Number(a.start_at) - Number(b.start_at));

  const labelled = activity => ({
    activityId: activity.activity_id, kind: activity.kind, status: activity.status, reality: activity.reality,
    target: String(activity.target ?? '').slice(0, 120), consumed: Number(activity.consumed_prefix), total: Number(activity.total_units),
    artifactVersion: Number(activity.artifact_version), sourceHash: String(activity.source_hash ?? '').slice(0, 16), updatedAt: Number(activity.updated_at),
  });
  const running = activities.filter(activity => activity.status === 'running' || activity.status === 'paused').map(labelled);

  const CONTROLLABLE = new Set(['planned']);
  const slotView = slot => {
    const status = String(slot.status ?? '');
    const startAt = Number(slot.start_at);
    const endAt = Number(slot.end_at);
    const future = startAt > now;
    const locked = Number(slot.locked) === 1;
    const activity = activityFor(slot);
    const outcome = outcomeOf(slot, activity);
    const controls = CONTROLLABLE.has(status) && future ? [locked ? 'unlock' : 'lock', 'skip'] : null;
    return {
      slotId: slot.slot_id, startAt, endAt, kind: slot.kind,
      activity: slot.activity, title: String(slot.title ?? '').slice(0, 160), flexibility: slot.flexibility,
      // Trailing raw status stays for debugging; nothing renders from it any more.
      status,
      outcome,
      outcomeLabel: OUTCOME_LABEL[outcome] ?? outcome,
      outcomeTone: OUTCOME_TONE[outcome] ?? 'neutral',
      // Autonomous slots are her own arrangement, never a user commitment (H1 is that).
      origin: 'self',
      reality: String(slot.reality ?? ''),
      live: activity ? String(activity.status ?? '') : '',
      ...(activity?.kind === 'bilibili' && ['completed', 'failed', 'unknown', 'quota-exhausted'].includes(activity.bili_status) ? {
        bilibiliRound: { status: activity.bili_status, watched: Math.max(0, Number(activity.bili_watched) || 0) },
      } : {}),
      locked,
      controls,
      minutes: Math.round((endAt - startAt) / 60000),
    };
  };

  const views = todays.map(slotView);
  const byId = new Map(views.map(view => [view.slotId, view]));
  const currentSlot = todays.find(slot => Number(slot.start_at) <= now && Number(slot.end_at) > now && slot.status !== 'skipped');
  const next = views.filter(view => view.status === 'planned' && view.startAt > now).slice(0, 4);
  const ended = views.filter(view => view.endAt <= now || view.status === 'done')
    .sort((a, b) => b.endAt - a.endAt).slice(0, 8);
  const pending = views.filter(view => view.status === 'planned' && view.startAt <= now && view.endAt > now);
  const skipped = views.filter(view => view.status === 'skipped');

  // The whole timetable of the committed plan: an empty `next` must never make the plan
  // disappear from the page.
  const today = views.slice();
  // Slots owned by another (superseded) plan of the same day are history, kept apart.
  const history = slots
    .filter(slot => !inDay(slot) && Math.abs(Number(slot.start_at) - now) < 2 * DAY_MS)
    .slice(0, 8)
    .map(slotView);

  // H1 arrangements are the only "已约好" items on this page.
  const itemTitles = new Map(agenda.map(item => [item.item_id, String(item.title ?? '').slice(0, 120)]));
  const arrangements = occurrences
    .filter(row => Math.abs(Number(row.scheduled_at) - now) < DAY_MS)
    .slice(0, 8)
    .map(row => ({
      occurrenceId: row.occurrence_id, itemId: row.item_id, title: itemTitles.get(row.item_id) ?? '',
      at: Number(row.scheduled_at), status: String(row.status ?? ''), origin: 'h1',
    }));

  // "The day is over" is the plan's own window, not the last slot: a committed plan that ran
  // out of slots at 05:30 leaves the rest of the day open, and saying 今天已结束 there is the
  // same kind of lie as 未完成 next to a finish receipt.
  const windowEnd = Number(plan?.window_end ?? 0);
  const dayIsOver = Number.isFinite(windowEnd) && windowEnd > 0
    ? windowEnd <= now
    : (todays.length > 0 && todays.every(slot => Number(slot.end_at) <= now || slot.status === 'skipped'));
  let state;
  if (running.length) state = 'running';
  else if (currentSlot && currentSlot.kind === 'rest') state = 'resting';
  else if (!plan) state = planningOn ? 'no-plan' : 'no-autonomy';
  else if (next.length) state = 'upcoming';
  else if (dayIsOver) state = 'today-done';
  // A committed plan with nothing left while the day is still going: exhausted, not "done".
  else state = 'plan-exhausted';

  const REASON = {
    running: '她现在正在做计划里的一段。',
    resting: '这一段排的是休息，不需要产出。',
    upcoming: '接下来的时间段都已经排好，还没到点。',
    'today-done': '今天的时段都已经结束了。',
    'plan-exhausted': '这一版计划排的时段都已经过去，但今天还没结束：规划侧没有补充新的时段。',
    'no-plan': '自主规划开关是开的，但今天还没有生成计划。',
    'no-autonomy': '自主规划开关是关的，所以今天不会有她自己排的时段。',
  };
  const planStatus = String(plan?.status ?? '');

  return {
    state,
    reason: REASON[state] ?? '',
    switches: { planning: planningOn, activities: activitiesOn, share: config?.p2?.share?.enabled === true },
    planControls: { enabled: planningOn, actions: ['lock', 'unlock', 'skip'] },
    plan: plan ? {
      planId: plan.plan_id, day: plan.day, version: Number(plan.version),
      status: planStatus,
      summary: String(plan.summary ?? '').slice(0, 300),
      windowStart: Number(plan.window_start), windowEnd: Number(plan.window_end),
      slots: views.length,
      committedAt: Number(plan.committed_at ?? 0),
    } : null,
    planStatus,
    current: { slot: currentSlot ? byId.get(currentSlot.slot_id) ?? slotView(currentSlot) : null, activities: running },
    // The whole day's timetable of the committed plan (sorted), so the page can always show it.
    today,
    next,
    ended,
    pending,
    skipped,
    history,
    arrangements,
    receipts: receipts.slice(0, 5).map(row => ({ activityId: row.activity_id, operation: row.operation, ok: Number(row.ok) === 1, code: row.code, at: Number(row.at) })),
    experience: buildExperience(activities, receipts, now),
    share: { pending: (sections.p2_share ?? []).filter(row => row.status === 'pending').length, enabled: config?.p2?.share?.enabled === true },
    interests: (sections.p2_interests ?? []).map(row => ({ title: String(row.title ?? '').slice(0, 120), kind: row.kind, status: row.status, strength: Number(row.strength) })),
    opportunities: (sections.p2_opportunities ?? []).filter(row => row.status === 'open').map(row => ({ kind: row.kind, source: row.source, createdAt: Number(row.created_at) })),
  };
}
