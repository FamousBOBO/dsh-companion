import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openRuntimeDb } from '../companion-runtime/lib/db.mjs';
import { createP2 } from '../companion-runtime/lib/p2.mjs';
import { scopeKey as scopeKeyOf } from '../companion-runtime/lib/scope.mjs';
import { describeShareChain } from './share-diagnostics.mjs';
import { assessShareableActivity, shareCandidateForActivity } from './share-producer.mjs';
import { contactSharePort } from './contact-share-port.mjs';
import { createServiceBridge } from './service-bridge.mjs';

// P2.5 分享链的**真实小样本**测试（隔离根 + 临时 SQLite + 真实代码）。
//
// 这个文件钉的是"活动 → 候选 → 既有 contact 闸门 → 账本"这一条链，以及它**没做**什么：
//   · runtime 侧用的是真的 `lib/p2.mjs`、真的 `lib/db.mjs`、真的 `p2_share_candidates` 表；
//   · contact 侧用的是**生产实际加载的那份构建产物**
//     （`plugins/dsh-channel-qq/build/lib-adaptive-followup-20261103/features/contact/`，
//     与 `cordis.patch.yml` 指到同一个目录）—— 真的 `evaluateGate`、真的 `createSharePort`、
//     真的 6 小时 TTL 与 `gateReasonOf` 透传，**不是**在测试里重写一份闸门；
//   · worker 那一跳（`worker.tick` 里 `pickDue → consider → attemptSend`）**没有**在这里跑：
//     它需要账本 store、租约和 sender，属于 QQ 侧的集成测试。本文件把那一跳换成
//     "按 types.ts 的形状从 `propose` 入参造候选 → 调真闸门 → 记录结论"的最小替身，
//     并把它记在 `gateVerdicts` 里断言。**没有任何通道对象存在 ⇒ 这个文件不可能发出消息。**
//
// 四条测试对应任务书的四条要求：
//   ①`share.enabled=false` → 零候选（回归）；②已确认活动 → 候选 → 真闸门评估 → 账本状态正确；
//   ③候选过期 → 诊断可见（过期条数 / 最后过期时间 / 原因分布）；④诊断自己不说谎
//   （`sent` 永远是 null、缺库/缺表报 code 而不是 0）。

const here = path.dirname(fileURLToPath(import.meta.url));
// The QQ channel is a **sibling package with its own build step**. The release
// repository stores sources only (D6), so this test resolves the built contact
// module from a stable location and skips — never passes — when it is absent.
// `DSH_QQ_CONTACT_BUILD` points at a different output directory when needed.
const CONTACT_BUILD_CANDIDATES = [
  process.env.DSH_QQ_CONTACT_BUILD,
  path.resolve(here, '../dsh-channel-qq/build/lib/features/contact'),
  path.resolve(here, '../dsh-channel-qq/build/lib-adaptive-followup-20261103/features/contact'),
].filter(Boolean);
const CONTACT_BUILD = CONTACT_BUILD_CANDIDATES.find(dir => fs.existsSync(path.join(dir, 'gate.js')) && fs.existsSync(path.join(dir, 'share-port.js'))) ?? '';
const SKIP = CONTACT_BUILD
  ? false
  : 'the QQ channel build output (features/contact/gate.js) is missing; run `npm run build` in the suite root before `npm run verify`';
const builtUrl = name => pathToFileURL(path.join(CONTACT_BUILD || here, name)).href;
const { evaluateGate } = CONTACT_BUILD ? await import(builtUrl('gate.js')) : { evaluateGate: null };
const { createSharePort, readShareEnabled, shareTargetOf } = CONTACT_BUILD
  ? await import(builtUrl('share-port.js'))
  : { createSharePort: null, readShareEnabled: null, shareTargetOf: null };

// 固定的 UTC 时刻 = 2026-11-09 11:00 Asia/Shanghai（不在默认免打扰窗口里）。
const T0 = Date.UTC(2026, 10, 9, 3, 0, 0);
const OWNER = 10000001; // 假主人号：本文件里没有任何真实 QQ 号
const SCOPE = Object.freeze({ userId: 'owner-test', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);
const SIX_HOURS = 6 * 3_600_000;

/**
 * 生产口径的 contact 配置（**数字抄自 `home/profiles/desktop/cordis.patch.yml` 的 contact 段**，
 * 但房间键换成本文件里的假主人号）：`enabled/dryRun=false/allowExternalSend=true`、
 * 免打扰空、额度无限、`maxCatchupHours:24`、`shareTtlMs:6h`。
 */
function productionLikeContactConfig(overrides = {}) {
  return {
    enabled: true,
    dryRun: false,
    allowExternalSend: true,
    sendMode: 'turn',
    timezone: 'Asia/Shanghai',
    allowedRooms: [`dm-${OWNER}`],
    quietHours: [],
    settleWindowMs: 120_000,
    maxCandidates: 50,
    shareTtlMs: SIX_HOURS,
    globalCooldownMs: 1_800_000,
    perRoomCooldownMs: 3_600_000,
    dailyQuotaGlobal: Infinity,
    dailyQuotaPerRoom: Infinity,
    maxUnansweredStreak: 3,
    pollIntervalMs: 60_000,
    followUpIdleMs: 21_600_000,
    followUpIntervalMs: 86_400_000,
    maxCatchupHours: 24,
    maxPerTick: 1,
    ...overrides,
  };
}

function emptyCounters() {
  return {
    day: '2026-11-09',
    sentTodayGlobal: 0,
    sentTodayByRoom: {},
    lastSentAt: null,
    lastSentAtByRoom: {},
    unansweredStreakByRoom: {},
    draftCallsToday: 0,
    lastDraftFailureAt: null,
    draftFailureStreak: 0,
  };
}

const runtimeFacts = room => ({
  connected: true,
  roomBound: true,
  turnRunningByRoom: { [room]: false },
  toolRunning: false,
  lastUserMessageAtByRoom: { [room]: null },
  queueDepthByRoom: { [room]: 0 },
  deliveredDedupeKeys: [],
});

/**
 * 隔离世界：临时根 + 临时 SQLite（真文件，不是 `:memory:` —— 诊断面要用**另一个只读连接**读它）。
 */
function world(t, { shareEnabled = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-real-'));
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  const dbFile = path.join(root, 'home/companion/companion-runtime.db');
  const clockBox = { now: T0 };
  const clock = () => clockBox.now;
  const db = openRuntimeDb({ file: dbFile, now: clock });
  // 租约要跨得过"把假时钟往前推几小时"：默认 10 分钟在过期场景里会被推没，
  // 于是 `assertLeaseHeld` 抛错 → 状态迁移根本没发生（那测的就不是过期了）。
  db.acquireLease({ owner: 'owner-test', generation: 'gen-test', ttlMs: 365 * 24 * 3_600_000 });
  db.commitProjection({ scope: KEY, generation: 'gen-test', payload: {}, updatedAt: T0 });
  // contact 的分享端口**每次提交都现读**这个文件（`readShareEnabled`），所以它就是那个开关。
  const configPath = path.join(root, 'home/companion/runtime.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ p2: { share: { enabled: shareEnabled, maxPending: 5 } } }));
  t.after(() => {
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  });
  const config = {
    timeZone: 'Asia/Shanghai',
    p2: {
      planning: { enabled: true },
      activities: { enabled: true },
      share: { enabled: shareEnabled, maxPending: 5 },
    },
  };
  return { root, db, dbFile, configPath, clock, clockBox, config };
}

function controller(worldRef, { sharePort = null } = {}) {
  return createP2({
    db: worldRef.db,
    config: worldRef.config,
    clock: worldRef.clock,
    owner: 'owner-test',
    generation: 'gen-test',
    getMode: () => 'active',
    isActive: () => true,
    emit: () => {},
    options: { sharePort, onError: () => {} },
  });
}

const rowOf = (db, id) => db.get('SELECT status, decision_reason FROM p2_share_candidates WHERE candidate_id = ?', id) ?? {};

/**
 * contact 侧的**真**分享端口 + worker 的最小替身（真闸门，无 sender、无通道）。
 *
 * `attempt` 就是生产里 `worker.tick(now)` 的位置。这里不做发送，只问真闸门并记录结论；
 * 所以 `gateVerdicts` 只证明"闸门真的跑过"，不证明"发出去了"。
 */
function contactPortOf(worldRef, { log = [], gateVerdicts = [], proposed = [], gateConfig = {}, budget = null, proposeOutcome = 'accepted' } = {}) {
  const config = productionLikeContactConfig(gateConfig);
  const room = `dm-${OWNER}`;
  const port = createSharePort({
    enabled: () => readShareEnabled(worldRef.configPath),
    target: () => shareTargetOf({ owner: OWNER, personaId: 'bot' }),
    propose: async input => { proposed.push(input); return { outcome: proposeOutcome, note: proposeOutcome === 'rejected' ? '闸门不放行' : '', candidateId: 'c-test' }; },
    attempt: async () => {
      const input = proposed[proposed.length - 1];
      if (input === undefined) return;
      // types.ts 的 ContactCandidate 形状，字段全部来自**真的** propose 入参（不是编的）。
      const candidate = {
        id: `c-${proposed.length}`,
        source: input.source,
        reason: input.reason,
        evidenceSource: input.evidenceSource,
        evidenceIds: input.evidenceIds,
        scope: input.scope,
        target: input.target,
        priority: 0,
        earliestAt: input.earliestAt,
        expiresAt: input.expiresAt,
        dedupeKey: input.dedupeKey,
        version: 1,
        authorization: input.authorization,
        state: 'pending',
        attempts: 0,
        createdAt: input.earliestAt,
        updatedAt: input.earliestAt,
        lastSuppressedReason: null,
      };
      gateVerdicts.push(evaluateGate({
        candidate,
        now: worldRef.clock(),
        config,
        counters: emptyCounters(),
        runtime: runtimeFacts(room),
        deliveryDedupeKeys: [],
      }));
    },
    now: () => worldRef.clock(),
    log: line => log.push(line),
    ttlMs: () => config.shareTtlMs,
    ...(budget === null ? {} : { budget }),
  });
  return port;
}

/**
 * 生产接线的那一跳（**这是重点**）：
 *
 * QQ 插件把 contact 的 `SharePort` 用 `serviceBridge.publish('companionContactShare', …)` 发布
 * （`src/plugin.ts` 的 `publishSharePort`），foundation 的 `contactSharePort(ctx, root)` 再把它
 * 解析出来，**用 `submit()` 这个名字**交给 runtime（`lib/p2.mjs` 探的是 `port.submit`）。
 *
 * 所以只发布 contact 的 `SharePort` 还不够：它只有 `submitShare` / `submitShareCandidate`，
 * **没有 `submit`**。少了 foundation 这层 wrapper，runtime 会一路报 `share-port-unavailable`。
 * 这个测试走的就是完整的三跳，而不是把 wrapper 省掉。
 */
function wireThroughFoundation(t, worldRef, contactOptions = {}) {
  const contactPort = contactPortOf(worldRef, contactOptions);
  const bridge = createServiceBridge(worldRef.root);
  const unpublish = bridge.publish('companionContactShare', contactPort, { ready: () => true });
  t.after(() => { try { unpublish(); } catch { /* already gone */ } });
  const port = contactSharePort({ get: () => undefined }, worldRef.root);
  assert.equal(port.sink, 'contact-service', '宿主真的解析到了 contact 的分享端口（不是 JSONL 兜底）');
  return { port, contactPort };
}

// ── ① 回归：`share.enabled=false` ⇒ 零候选、零外发 ────────────────────────────────

test('share.enabled=false → 零候选（runtime / contact 端口 / 生产者三处都关死）', { skip: SKIP }, async t => {
  const w = world(t, { shareEnabled: false });
  const log = [];
  const gateVerdicts = [];
  const proposed = [];
  const port = contactPortOf(w, { log, gateVerdicts, proposed });
  const p2 = controller(w, { sharePort: port });

  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a1', title: '不该被创建', body: '正文' });
  assert.equal(made.ok, false);
  assert.equal(made.code, 'share-disabled');
  assert.equal(Number(w.db.get('SELECT COUNT(*) AS n FROM p2_share_candidates WHERE scope = ?', KEY)?.n ?? 0), 0, '零候选');

  // 就算有人绕过 runtime 直接调端口，contact 也自己看一眼开关（不靠调用方守规矩）。
  const direct = await port.submitShareCandidate({ scopeKey: KEY, candidateId: 'shr_x', title: '直接调端口' });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'share-disabled');
  assert.equal(proposed.length, 0, 'contact 一条候选都没建');
  assert.equal(gateVerdicts.length, 0, '闸门都没跑');
  assert.equal(log.length, 0, '连日志都没有：说明它真的在开关那一行就回头了');
});

test('share.enabled=false → 生产者（活动→候选）直接拒绝，不碰 runtime', { skip: SKIP }, async t => {
  let created = 0;
  const cognitive = {
    listActivities: () => ({ ok: true, activities: [{ activityId: 'a1', status: 'done', reality: 'actual_tool_activity', consumed: 100 }] }),
    createShareCandidate: () => { created += 1; return { ok: true, candidateId: 'shr_y' }; },
  };
  const result = shareCandidateForActivity({ cognitive, config: { p2: { share: { enabled: false } } }, sessionId: 's1', activityId: 'a1', title: '标题' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'share-disabled');
  assert.equal(created, 0, '开关关着时连 createShareCandidate 都不该被调');
});

// ── ② 一条已确认活动 → 候选 → 真闸门评估 → 账本状态正确（不真发）─────────────────

test('已完成的真活动 → 候选 → 真 contact 闸门判 send → 账本 queued（不是 sent，也没有任何发送）', { skip: SKIP }, async t => {
  const w = world(t, { shareEnabled: true });
  const log = [];
  const gateVerdicts = [];
  const proposed = [];
  const { port, contactPort } = wireThroughFoundation(t, w, { log, gateVerdicts, proposed });
  const p2 = controller(w, { sharePort: port });

  // 生产者：把"已确认活动"翻译成候选（判据与 runtime 的 recordExperience 同一套）
  const created = shareCandidateForActivity({
    cognitive: {
      listActivities: () => ({
        ok: true,
        activities: [{
          activityId: 'act-read-1', kind: 'read', status: 'done', reality: 'actual_tool_activity',
          consumed: 1200, artifactRef: '', artifactVersion: 0, target: 'notes.md',
        }],
      }),
      createShareCandidate: input => p2.createShareCandidate({ ...input, scopeKey: KEY }),
    },
    config: w.config,
    sessionId: 's1',
    activityId: 'act-read-1',
    title: '读完了一篇讲极光的文章',
    body: '看到一句：极光的绿色来自氧原子。',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.evidence, 'activity:done+evidenced');
  assert.equal(rowOf(w.db, created.candidateId).status, 'pending');

  // 投递一拍：真的 contact 端口 → 真的 propose 形状 → 真的 evaluateGate
  const delivered = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(delivered.queued, 1, JSON.stringify(delivered));

  // (a) contact 拿到的是一条**授权为 standing** 的分享候选，TTL 正好 6 小时
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].source, 'share-intent');
  assert.equal(proposed[0].evidenceSource, 'p2-share');
  assert.deepEqual(proposed[0].evidenceIds, [created.candidateId]);
  assert.equal(proposed[0].dedupeKey, `share:${created.candidateId}`);
  assert.equal(proposed[0].authorization.kind, 'standing', '分享是"她自己决定"，不是用户原话');
  assert.equal(proposed[0].authorization.quote, null);
  assert.equal(proposed[0].expiresAt - proposed[0].earliestAt, SIX_HOURS, 'contact 侧分享 TTL = 6h');

  // (b) **真闸门**判了什么（生产口径配置：免打扰空、额度无限、通道在、房间绑定好）
  assert.equal(gateVerdicts.length, 1);
  assert.deepEqual(gateVerdicts[0], { verdict: 'send', reason: 'ok' });

  // (c) runtime 账本：`queued` + reason `contact-queued`，**绝不是 sent**
  const row = rowOf(w.db, created.candidateId);
  assert.equal(row.status, 'queued');
  assert.equal(row.decision_reason, 'contact-queued');
  assert.notEqual(row.status, 'sent');
  // 幂等：再投一拍不会把同一条候选送第二次
  await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(proposed.length, 1, 'queued 的候选离开 eligible 集合');
  assert.equal(gateVerdicts.length, 1);
});

test('闸门判 defer（免打扰）时 runtime 仍然记 queued —— "进了账本"不等于"闸门放行"', { skip: SKIP }, async t => {
  const w = world(t, { shareEnabled: true });
  const gateVerdicts = [];
  const proposed = [];
  // 免打扰 11:00→12:00：T0 正好落在里面
  const { port } = wireThroughFoundation(t, w, { gateVerdicts, proposed, gateConfig: { quietHours: [{ from: '11:00', to: '12:00' }] } });
  const p2 = controller(w, { sharePort: port });

  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a-q', title: '免打扰里的候选', body: '正文' });
  const delivered = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(delivered.queued, 1);

  // 真闸门：defer + quiet-hours（候选留着，等窗口过去）
  assert.deepEqual(gateVerdicts[0], { verdict: 'defer', reason: 'quiet-hours' });
  // 但 contact 端口照旧回 ok:true（CONTRACT §13.11.2 的已知语义），于是 runtime 记 queued。
  assert.equal(rowOf(w.db, made.candidateId).status, 'queued');
  // ⇒ 这一格就是"打开 share 之前必须先能看见的东西"：queued 不能当成"发出去了"。
  const chain = describeShareChain({ root: w.root, dbFile: w.dbFile, now: w.clock() });
  assert.equal(chain.ok, true);
  assert.equal(chain.queued.count, 1);
  assert.equal(chain.queued.contactAckAfterQueued, 'unknown');
  assert.equal(chain.sent.value, null);
  assert.equal(chain.sent.honest, 'not-wired');
  assert.equal(chain.expired.count, 0);
});

// ── ③ 候选过期 → 诊断可见（过期条数 / 最后过期时间 / 原因分布）────────────────────

test('重试耗尽 → 候选 expired → 诊断里能查到条数、最后过期时间与原因分布', { skip: SKIP }, async t => {
  const w = world(t, { shareEnabled: true });
  const gateVerdicts = [];
  const proposed = [];
  // 真闸门判 defer（免打扰）→ 真的 contact share-port 把**真原因** `quiet-hours` 透传给 runtime。
  // 用 `quiet-hours` 而不是 `cooldown:room`：runtime 的可重试词表里只有前者（见下一个用例的发现）。
  const { port } = wireThroughFoundation(t, w, {
    gateVerdicts,
    proposed,
    proposeOutcome: 'rejected',
    gateConfig: { quietHours: [{ from: '11:00', to: '12:00' }] },
    budget: async () => ({ allowed: false, reason: 'quiet-hours' }),
  });
  const p2 = controller(w, { sharePort: port });

  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a-night', title: '一直落在免打扰里', body: '正文' });
  assert.equal(made.ok, true);

  // 每一拍都以 `quiet-hours`（可重试）被拒，退避 30s 起翻倍、封顶 30min。
  // 8 次即 `SHARE_MAX_ATTEMPTS`，第 8 次落 `expired`。
  let last = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    last = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
    w.clockBox.now += 31 * 60_000; // 走过任何退避
  }
  assert.equal(last.expired, 1, JSON.stringify(last));
  assert.equal(last.reasons['quiet-hours'], 1, '原因是闸门给的真原因，不是"rejected"');

  const row = rowOf(w.db, made.candidateId);
  assert.equal(row.status, 'expired');
  assert.equal(row.decision_reason, 'expired:quiet-hours', '过期行保留原因（greppable）');

  // 诊断面：条数 / 最后过期时刻 / 原因分布（去掉 runtime 的 `expired:` 前缀，与丢弃原因同一套词表）
  const chain = describeShareChain({ root: w.root, dbFile: w.dbFile, now: w.clock() });
  assert.equal(chain.ok, true);
  assert.equal(chain.expired.count, 1);
  assert.equal(chain.expired.reasons[0].reason, 'quiet-hours');
  assert.equal(chain.expired.reasons[0].count, 1);
  assert.equal(chain.expired.lastAt, Number(w.db.get("SELECT decision_at FROM p2_share_candidates WHERE candidate_id = ?", made.candidateId).decision_at));
  assert.ok(chain.expired.lastAgeMs !== null && chain.expired.lastAgeMs >= 0);
  // 丢弃账里也能看到这一条（expired 属于"没出去"的终态）
  assert.equal(chain.dropped.byState.expired, 1);
  assert.ok(chain.dropped.reasons.some(item => item.reason === 'expired:quiet-hours' && item.count === 1));
  // 诊断仍然不说"发了"
  assert.equal(chain.sent.value, null);
});

test('已修复：闸门的 `cooldown:room` / `quota:global` 现在被判为可重试，不再当终态丢掉', { skip: SKIP }, async t => {
  // 2026-11-03 Lead 应用了 runtime P4（`SHARE_GATE_RETRYABLE` 补上 contact 真实透传的原因串）。
  // 本用例原先断言的是**修前缺陷**（`terminalGated: 1` + 无重试簿 ⇒ 永远不发）；修复后必须反转：
  // 冷却/额度是 `defer`，候选留在账本里等，重试簿有记录，下一拍仍会被选中。
  const w = world(t, { shareEnabled: true });
  const proposed = [];
  const { port } = wireThroughFoundation(t, w, {
    proposed,
    proposeOutcome: 'rejected',
    budget: async () => ({ allowed: false, reason: 'cooldown:room' }),
  });
  const p2 = controller(w, { sharePort: port });

  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a-cool', title: '被冷却挡住', body: '正文' });
  assert.equal(made.ok, true);
  const result = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });

  assert.equal(result.retryableGated, 1, JSON.stringify(result));
  assert.equal(result.terminalGated, 0, '冷却不是拒绝');
  assert.equal(rowOf(w.db, made.candidateId).status, 'gated');
  assert.equal(rowOf(w.db, made.candidateId).decision_reason, 'cooldown:room');
  assert.ok(w.db.get('SELECT meta_key FROM runtime_meta WHERE meta_key = ?', `p2_share_retry:${made.candidateId}`),
    '有重试簿 ⇒ 冷却过后还能再发（修前这里没有记录，等于永久放弃）');

  // 下一拍仍会重新审视它（这才是"过一会儿还能发"的机制）；
  // 具体是否立刻再看取决于退避窗口，因此这里只断言"没有被判死"。
  const again = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(rowOf(w.db, made.candidateId).status, 'gated', '仍留在账本里，不是 expired');
  assert.ok(Number(again.examined) >= 0);

  // 诊断仍能看见它，并且给出的是"等"的原因而不是"丢"。
  const chain = describeShareChain({ root: w.root, dbFile: w.dbFile, now: w.clock() });
  assert.equal(chain.dropped.count, 1);
  assert.equal(chain.dropped.byState.gated, 1);
  assert.ok(chain.dropped.reasons.some(item => item.reason === 'cooldown:room' && item.count === 1));
});

// ── ④ 诊断自己不说谎：缺库/缺表报 code，`queued` 的语义写清楚 ────────────────────

test('诊断：库不存在 / 表不存在都不冒充"零候选"', { skip: SKIP }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-diag-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });

  // 显式给一个不存在的文件：不吃环境变量（`DSH_COMPANION_RUNTIME_DB` 在生产机上是有值的，
  // 走缺省规则会读到**真的**运行库，那这个用例就变成了"读生产数据"）。
  const missing = describeShareChain({ root, dbFile: path.join(root, 'no-such.db'), now: T0 });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'db-missing');
  assert.equal(missing.sent.value, null);

  // 建一个**没有本 schema** 的库：不能用 `openRuntimeDb`（它会建全表，那这个用例就假绿了）。
  const dbFile = path.join(root, 'home/companion/companion-runtime.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const raw = new DatabaseSync(dbFile);
  raw.exec('CREATE TABLE unrelated (x INTEGER)');
  raw.close();
  const noTable = describeShareChain({ root, dbFile, now: T0 });
  assert.equal(noTable.ok, false);
  assert.equal(noTable.code, 'table-missing');
  assert.equal(noTable.sent.honest, 'not-wired');
});

test('诊断：pending 卡住要说出来（"在等"与"卡住"不是一个事实）', { skip: SKIP }, async t => {
  const w = world(t, { shareEnabled: true });
  const p2 = controller(w, { sharePort: null }); // 没有 contact 端口：谁都拿不走候选
  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a-stuck', title: '没人取的候选', body: '正文' });
  assert.equal(made.ok, true);

  const fresh = describeShareChain({ root: w.root, dbFile: w.dbFile, now: w.clock(), ttlMs: SIX_HOURS });
  assert.equal(fresh.pending.count, 1);
  assert.equal(fresh.pending.stuck, false);

  const later = describeShareChain({ root: w.root, dbFile: w.dbFile, now: w.clock() + SIX_HOURS + 1000, ttlMs: SIX_HOURS });
  assert.equal(later.pending.stuck, true, '超过 6h 还 pending = 投递泵没跑，不是闸门在等');
  assert.ok(later.pending.oldestAgeMs > SIX_HOURS);
});

test('生产者：模拟世界的活动、没证据的活动、没完成的活动都不产候选', { skip: SKIP }, () => {
  assert.deepEqual(assessShareableActivity({ activityId: 's', reality: 'simulated_world', status: 'done', consumed: 10 }).code, 'simulated-not-shared');
  assert.equal(assessShareableActivity({ activityId: 'n', reality: 'actual_tool_activity', status: 'running', consumed: 10 }).code, 'activity-not-done');
  assert.equal(assessShareableActivity({ activityId: 'e', reality: 'actual_tool_activity', status: 'done', consumed: 0 }).code, 'no-evidence');
  assert.equal(assessShareableActivity(null).code, 'activity-not-found');
  const good = assessShareableActivity({ activityId: 'g', reality: 'actual_tool_activity', status: 'done', artifactRef: 'w/out.md', artifactVersion: 2, consumed: 0 });
  assert.equal(good.ok, true);
  assert.equal(good.sourceRef, 'artifact:w/out.md@v2');
});
