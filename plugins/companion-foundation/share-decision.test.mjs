import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANDIDATE_NOTE,
  DEFAULT_DECISION_CONFIG,
  REASON_CLASS,
  SHARE_REASON,
  bilibiliVideoUrl,
  createFinishedActivityShareHook,
  decideShare,
  deriveBilibiliEvidence,
  produceCandidateForFinishedActivity,
} from './share-decision.mjs';

// 任务包 F 的合成用例。**零网络、零模型、零发送、零真实数据库**：
//   * 活动 / checkpoint / evidence / history 全是本文件造的字面量；
//   * `cognitive` 是一个内存桩，只记录被调用的参数；
//   * BV 号是合成标识（不对应真实视频），标题/摘要一律是测试杜撰的假字符串，不当事实使用。
//
// 这一组用例要证明的三件事（对应审计 doc 21 §1 的第 5、6 段断点）：
//   1. 决策是**具名**的：每条拒绝都有理由码，且理由码的处置分类可复核；
//   2. 生产是**受开关控制 + 幂等 + fail-closed** 的：同一活动只能建一条候选；
//   3. 诚实性：`method:'transcript'` 必须被说出来，候选正文绝不说“看过画面”，
//      返回值的 `note` 绝不说“已送达”。

const here = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const SCOPE = 'u:synthetic-owner|p:bot|w:world:default';
const BV1 = 'BV1Sa4y1Z7Zb';
const BV2 = 'BV1Gt4y1P7Nc';

/** 生产开关打开的配置（**不是**真实 `runtime.config.json` 的快照）。 */
function configOn(overrides = {}) {
  return { p2: { share: { enabled: true, maxPending: 5, decision: overrides } } };
}

/** 一条完成了的真 B站活动行（合成）。 */
function finishedActivity(overrides = {}) {
  return {
    activityId: 'act-bili-0001',
    kind: 'bilibili',
    reality: 'actual_tool_activity',
    status: 'done',
    endedAt: T0,
    updatedAt: T0,
    // 陷阱：B站活动行的 consumedPrefix 恒 0（`lib/activities.mjs:857-859` 只写 0，
    // progress 分支 B站不走）。任何拿它当证据的代码都会误判“没看过”。
    consumedPrefix: 0,
    totalUnits: 0,
    checkpoint: {
      bilibiliRound: {
        roundId: 'act-bili-0001',
        status: 'completed',
        watched: 1,
        evidence: [{ kind: 'watch', videoId: BV1, consumedSeconds: 540, method: 'transcript' }],
      },
    },
    ...overrides,
  };
}

/** 显式证据（调用方从 provider 回读的 shape）。 */
function evidenceWith(overrides = {}) {
  return {
    roundId: 'act-bili-0001',
    roundStatus: 'completed',
    items: [{ kind: 'watch', videoId: BV1, consumedSeconds: 540, method: 'transcript' }],
    summary: '这一期讲的是把一件旧工具修好再用起来的过程，重点在于判断值不值得修。',
    ...overrides,
  };
}

/** 只读的 runtime 桩：记录每一次 `createShareCandidate` 调用。 */
function stubCognitive({ failWith = null, throwWith = null, listed = null } = {}) {
  const calls = [];
  let created = 0;
  return {
    calls,
    createShareCandidate(input) {
      created += 1;
      calls.push({ fn: 'createShareCandidate', input });
      if (throwWith !== null) throw throwWith;
      if (failWith !== null) return failWith;
      return { ok: true, candidateId: `shr_${String(created).padStart(4, '0')}`, duplicate: false };
    },
    shareCandidates(input) {
      calls.push({ fn: 'shareCandidates', input });
      return listed === null ? { ok: false, code: 'unavailable' } : { ok: true, candidates: listed };
    },
  };
}

function produceOptions(extra = {}) {
  return {
    cognitive: extra.cognitive ?? stubCognitive(),
    config: extra.config ?? configOn(),
    sessionId: extra.sessionId ?? 'synthetic-session',
    scopeKey: extra.scopeKey ?? SCOPE,
    activity: extra.activity ?? finishedActivity(),
    evidence: extra.evidence ?? evidenceWith(),
    now: extra.now ?? T0 + 60_000,
    history: extra.history,
  };
}

// ---------------------------------------------------------------------------
// 1. 开关 / 入参 / fail-closed 的门
// ---------------------------------------------------------------------------

test('share-disabled：开关关着就一行都不写，理由码可查', () => {
  const cognitive = stubCognitive();
  const decision = decideShare({ activity: finishedActivity(), evidence: evidenceWith(), config: { p2: { share: { enabled: false } } }, now: T0 + 60_000 });
  assert.equal(decision.share, false);
  assert.equal(decision.reasonCode, 'share-disabled');
  assert.equal(REASON_CLASS[decision.reasonCode].terminal, true);
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive, config: { p2: { share: { enabled: false } } } }));
  assert.equal(produced.ok, false);
  assert.equal(produced.created, false);
  assert.equal(produced.reasonCode, 'share-disabled');
  assert.equal(cognitive.calls.length, 0, 'no candidate is created while the switch is off');
});

test('reality / status 门：模拟世界与未完成一律拒绝（具名码）', () => {
  const simulated = decideShare({
    activity: finishedActivity({ reality: 'simulated_world' }), evidence: evidenceWith(), config: configOn(), now: T0 + 60_000,
  });
  assert.equal(simulated.reasonCode, 'simulated-not-shared');
  assert.equal(simulated.share, false);

  const running = decideShare({
    activity: finishedActivity({ status: 'running', endedAt: 0 }), evidence: evidenceWith(), config: configOn(), now: T0 + 60_000,
  });
  assert.equal(running.reasonCode, 'not-done');
  // 未完成不是“永远不行”，等的是新事件而不是重试同一份快照。
  assert.equal(REASON_CLASS['not-done'].retry, true);

  const missing = decideShare({ config: configOn(), now: T0 });
  assert.equal(missing.reasonCode, 'invalid-input');
});

test('report 不算观看证据：只有 report 的 round 给 no-evidence', () => {
  const activity = finishedActivity({
    checkpoint: { bilibiliRound: { roundId: 'r1', status: 'completed', watched: 0, evidence: [{ kind: 'report', written: true }] } },
  });
  const decision = decideShare({ activity, config: configOn(), now: T0 + 60_000 });
  assert.equal(decision.reasonCode, 'no-evidence');
  assert.equal(decision.facts.videoIds.length, 0, 'a report yields no video id');
});

test('只有 watched 计数、没有 BV 条目 ⇒ no-video-id（不猜 BV、不猜链接）', () => {
  const activity = finishedActivity({
    checkpoint: { bilibiliRound: { roundId: 'r2', status: 'completed', watched: 3, evidence: [] } },
  });
  const decision = decideShare({ activity, config: configOn(), now: T0 + 60_000 });
  assert.equal(decision.reasonCode, 'no-video-id');
  assert.deepEqual(decision.facts.links, []);
});

test('BV 号不是 12 位就不合法：bilibiliVideoUrl 只由合法 BV 拼', () => {
  assert.equal(bilibiliVideoUrl(BV1), `https://www.bilibili.com/video/${BV1}`);
  assert.equal(bilibiliVideoUrl('BV1'), '');
  assert.equal(bilibiliVideoUrl(''), '');
  assert.equal(bilibiliVideoUrl('https://evil.example/x'), '');
});

test('round 终态：failed / quota-exhausted / unknown 各自具名，unknown 不重试', () => {
  for (const [status, code, retry] of [
    ['failed', 'round-failed', false],
    ['quota-exhausted', 'round-quota-exhausted', false],
    ['unknown', 'round-unknown', false],
  ]) {
    const decision = decideShare({
      activity: finishedActivity({ status: 'failed' }),
      evidence: { roundId: 'r', roundStatus: status, items: [{ kind: 'watch', videoId: BV1, consumedSeconds: 900 }] },
      config: configOn(), now: T0 + 60_000,
    });
    assert.equal(decision.reasonCode, code, status);
    assert.equal(decision.share, false);
    assert.equal(REASON_CLASS[code].retry, retry, `${code} must not be silently retried`);
  }
  // unknown 是终态：生产者不会因此多调一次 runtime。
  const cognitive = stubCognitive();
  const produced = produceCandidateForFinishedActivity(produceOptions({
    cognitive,
    activity: finishedActivity({ status: 'failed' }),
    evidence: { roundId: 'r', roundStatus: 'unknown', items: [{ kind: 'watch', videoId: BV1, consumedSeconds: 900 }] },
  }));
  assert.equal(produced.reasonCode, 'round-unknown');
  assert.equal(cognitive.calls.filter(call => call.fn === 'createShareCandidate').length, 0);
});

test('transcript-only-blocked：策略关掉纯字幕时拒绝，并说明原因', () => {
  const decision = decideShare({
    activity: finishedActivity(), evidence: evidenceWith(),
    config: configOn({ allowTranscriptOnly: false }), now: T0 + 60_000,
  });
  assert.equal(decision.reasonCode, 'transcript-only-blocked');
  assert.equal(decision.facts.method, 'transcript');
  assert.equal(decision.facts.methodLabel, '只读了字幕');
});

test('stale：证据超出 TTL 就拒绝（关闭期积压不自动复活）', () => {
  const decision = decideShare({
    activity: finishedActivity(), evidence: evidenceWith(), config: configOn(), now: T0 + 3 * 24 * 3600 * 1000,
  });
  assert.equal(decision.reasonCode, 'stale');
  assert.equal(decision.facts.freshness.band, 'stale');
  assert.equal(REASON_CLASS.stale.terminal, true);
});

test('预算：窗口内已满 ⇒ budget-exhausted，且是 retryable', () => {
  const history = [1, 2, 3].map(index => ({
    activityId: `act-old-${index}`, candidateId: `shr_old_${index}`, kind: 'bilibili', status: 'pending', createdAt: T0 - 3600_000,
  }));
  const decision = decideShare({ activity: finishedActivity(), evidence: evidenceWith(), config: configOn(), now: T0 + 60_000, history });
  assert.equal(decision.reasonCode, 'budget-exhausted');
  assert.equal(decision.facts.budget.state, 'exhausted');
  assert.equal(REASON_CLASS['budget-exhausted'].retry, true);
});

test('去重：历史里同活动候选 ⇒ duplicate，第二次不再调 runtime', () => {
  const history = [{ activityId: 'act-bili-0001', candidateId: 'shr_prev', kind: 'bilibili', status: 'pending', createdAt: T0 }];
  const cognitive = stubCognitive();
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive, history }));
  assert.equal(produced.reasonCode, 'duplicate');
  assert.equal(produced.created, false);
  assert.equal(cognitive.calls.filter(call => call.fn === 'createShareCandidate').length, 0, 'the runtime is not asked twice');
});

test('去重：撤回过的候选不再拦（同一活动可以再说一次）', () => {
  const history = [{ activityId: 'act-bili-0001', candidateId: 'shr_gone', kind: 'bilibili', status: 'withdrawn', createdAt: T0 }];
  const decision = decideShare({ activity: finishedActivity(), evidence: evidenceWith(), config: configOn(), now: T0 + 60_000, history });
  assert.equal(decision.share, true);
  assert.equal(decision.reasonCode, 'share-ok');
});

test('历史读不到 ≠ 没有历史：不判重复、不判预算，facts 里如实写 unavailable', () => {
  const decision = decideShare({ activity: finishedActivity(), evidence: evidenceWith(), config: configOn(), now: T0 + 60_000, history: null });
  assert.equal(decision.share, true);
  assert.equal(decision.facts.history, 'unavailable');
  assert.equal(decision.facts.budget.state, 'unavailable');
});

// ---------------------------------------------------------------------------
// 2. 相关性 / 不编感想
// ---------------------------------------------------------------------------

test('没有内容来源且策略要求摘要 ⇒ low-relevance（不编一段感想）', () => {
  const decision = decideShare({
    activity: finishedActivity(), evidence: evidenceWith({ summary: '' }),
    config: configOn({ requireContentSummary: true }), now: T0 + 60_000,
  });
  assert.equal(decision.reasonCode, 'low-relevance');
  assert.equal(decision.facts.content.source, 'absent');
});

test('证据太薄（字幕 20 秒、无内容）⇒ low-relevance，分数低于门槛', () => {
  const decision = decideShare({
    activity: finishedActivity(),
    evidence: { roundId: 'r', roundStatus: 'completed', items: [{ kind: 'watch', videoId: BV1, consumedSeconds: 20, method: 'transcript' }] },
    config: configOn(), now: T0 + 60_000,
  });
  assert.equal(decision.reasonCode, 'low-relevance');
  assert.ok(decision.score < DEFAULT_DECISION_CONFIG.minScore);
});

test('兴趣不可用不等于没兴趣：不影响结论，只在 reasons 里说明', () => {
  const decision = decideShare({ activity: finishedActivity(), evidence: evidenceWith(), config: configOn(), now: T0 + 60_000 });
  assert.equal(decision.share, true);
  assert.equal(decision.facts.interestState, 'unavailable');
  assert.ok(decision.reasons.some(entry => entry.detail.includes('不把')), 'the reason is stated, not silently dropped');
});

test('兴趣命中会加分，但分数仍封在 [0,1]', () => {
  const plain = decideShare({ activity: finishedActivity(), evidence: evidenceWith(), config: configOn(), now: T0 + 60_000 });
  const withInterest = decideShare({
    activity: finishedActivity({ interests: [{ title: '旧工具修复', note: '', status: 'active', strength: 0.9 }] }),
    evidence: evidenceWith(), config: configOn(), now: T0 + 60_000,
  });
  assert.equal(withInterest.facts.interestState, 'available');
  assert.ok(withInterest.score >= plain.score, 'a matching interest never lowers the score');
  for (const decision of [plain, withInterest]) assert.ok(decision.score >= 0 && decision.score <= 1);
});

// ---------------------------------------------------------------------------
// 3. 生产：文本 / 身份 / 幂等 / shadow
// ---------------------------------------------------------------------------

test('share-ok ⇒ 候选带 BV、公开链接、字幕诚实标注、activity/round/evidence 关联', () => {
  const cognitive = stubCognitive();
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive }));
  assert.equal(produced.ok, true);
  assert.equal(produced.created, true);
  assert.equal(produced.reasonCode, 'share-ok');
  assert.equal(produced.candidateId, 'shr_0001');
  assert.equal(produced.note, CANDIDATE_NOTE);
  // note 必须**带否定**：只允许“不是…”“只能看…”这种说法，不允许肯定式的“已送达”。
  for (const claim of ['已发送', '已投递', '已进入 contact']) {
    assert.equal(produced.note.includes(claim), false, `the note must not claim ${claim}`);
  }
  assert.ok(produced.note.includes('不是已进 contact'));
  assert.ok(produced.note.includes('更不是已送达'));

  const input = cognitive.calls.find(call => call.fn === 'createShareCandidate').input;
  assert.equal(input.activityId, 'act-bili-0001');
  assert.equal(input.kind, 'bilibili');
  assert.equal(input.bound.userId, 'synthetic-owner');
  assert.ok(input.title.includes('字幕'), `title must say transcript: ${input.title}`);
  assert.equal(input.title.includes('看了'), false, 'a transcript-only round is never titled as watched');
  assert.ok(input.body.includes(BV1));
  assert.ok(input.body.includes(`https://www.bilibili.com/video/${BV1}`));
  assert.ok(input.body.includes('只读了字幕'), 'the body states the method');
  assert.ok(input.body.includes('没有看画面'));
  assert.ok(input.body.includes('activity=act-bili-0001'));
  assert.ok(input.body.includes('round=act-bili-0001'));
  assert.equal(input.sourceRef, produced.facts.evidenceRef);
  assert.ok(produced.facts.evidenceRef.startsWith('round:'));
  assert.ok(input.body.length <= 2000 && input.title.length <= 200);
});

test('method 未标注时正文如实说“没有写下观看方式”，不声称看过画面', () => {
  const cognitive = stubCognitive();
  const produced = produceCandidateForFinishedActivity(produceOptions({
    cognitive,
    evidence: evidenceWith({ items: [{ kind: 'watch', videoId: BV1, consumedSeconds: 900 }] }),
  }));
  assert.equal(produced.facts.method, 'unstated');
  const input = cognitive.calls.find(call => call.fn === 'createShareCandidate').input;
  assert.ok(input.body.includes('记录里没有写下观看方式'));
  assert.equal(input.body.includes('只读了字幕'), false);
  assert.equal(input.body.includes('没有看画面'), false, 'unstated is not the same as transcript');
});

test('transcript 与未标注混合 ⇒ mixed，正文不把它说成全部看过', () => {
  const cognitive = stubCognitive();
  const produced = produceCandidateForFinishedActivity(produceOptions({
    cognitive,
    evidence: evidenceWith({
      items: [
        { kind: 'watch', videoId: BV1, consumedSeconds: 900, method: 'transcript' },
        { kind: 'watch', videoId: BV2, consumedSeconds: 1200 },
      ],
    }),
  }));
  assert.equal(produced.facts.method, 'mixed');
  const input = cognitive.calls.find(call => call.fn === 'createShareCandidate').input;
  assert.ok(input.body.includes('部分证据只读了字幕'));
  assert.equal(produced.facts.videoIds.length, 2);
  assert.ok(input.body.includes(BV2));
});

test('幂等：同一活动第二次调用命中 runtime 的 duplicate，不新增行', () => {
  const cognitive = stubCognitive({ listed: [{ activityId: 'act-bili-0001', candidateId: 'shr_0001', kind: 'bilibili', status: 'pending', createdAt: T0 }] });
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive }));
  // 已经有一次候选在等：幂等命中，语义是“这次没新增”（ok=true、created=false）。
  assert.equal(produced.ok, true, '幂等命中算成功，但 created 必须为 false');
  assert.equal(produced.created, false);
  assert.equal(produced.duplicate, true);
  assert.equal(produced.candidateId, 'shr_0001');
  assert.equal(produced.reasonCode, 'duplicate');
  assert.equal(cognitive.calls.filter(call => call.fn === 'createShareCandidate').length, 0);
});

test('runtime 侧回 duplicate 时也落 duplicate，且不谎报 created', () => {
  const cognitive = stubCognitive({ failWith: { ok: true, candidateId: 'shr_existing', duplicate: true } });
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive }));
  assert.equal(produced.reasonCode, 'duplicate');
  assert.equal(produced.created, false);
  assert.equal(produced.candidateId, 'shr_existing');
});

test('shadow：只记录决策，绝不建候选（也就绝不外发）', () => {
  const cognitive = stubCognitive();
  const produced = produceCandidateForFinishedActivity(produceOptions({
    cognitive,
    config: { p2: { share: { enabled: true, shadow: true } } },
  }));
  assert.equal(produced.shadow, true);
  assert.equal(produced.created, false);
  assert.equal(produced.decision.share, true);
  assert.equal(cognitive.calls.length, 0);
  assert.ok(produced.note.includes('未创建候选'));
});

test('runtime 未挂：runtime-not-mounted（terminal）', () => {
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive: { shareCandidates: () => ({ candidates: [] }) } }));
  assert.equal(produced.reasonCode, 'runtime-not-mounted');
  assert.equal(REASON_CLASS['runtime-not-mounted'].terminal, true);
  assert.equal(produced.decision.share, true, 'the decision itself still says yes; only the writer is missing');
});

test('作用域：既无 sessionId 又无合法 scopeKey ⇒ scope-required（不猜默认人物/世界）', () => {
  const produced = produceCandidateForFinishedActivity(produceOptions({ sessionId: '', scopeKey: '' }));
  assert.equal(produced.reasonCode, 'scope-required');
  assert.equal(produced.created, false);
});

test('作用域：scopeKey 形状不对 ⇒ scope-required，而不是写成一条读不回来的行', () => {
  const cognitive = stubCognitive();
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive, sessionId: '', scopeKey: 'u:x' }));
  assert.equal(produced.reasonCode, 'scope-required');
  assert.equal(cognitive.calls.filter(call => call.fn === 'createShareCandidate').length, 0);
});

test('队列满 ⇒ share-queue-full（retryable），不伪装成成功', () => {
  const cognitive = stubCognitive({ failWith: { ok: false, code: 'share-queue-full' } });
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive }));
  assert.equal(produced.ok, false);
  assert.equal(produced.reasonCode, 'share-queue-full');
  assert.equal(REASON_CLASS['share-queue-full'].retry, true);
});

test('runtime 抛异常 ⇒ share-create-threw，永不把异常抛给调用方', () => {
  const cognitive = stubCognitive({ throwWith: new Error('synthetic write failure') });
  assert.doesNotThrow(() => produceCandidateForFinishedActivity(produceOptions({ cognitive })));
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive }));
  assert.equal(produced.reasonCode, 'share-create-threw');
  assert.equal(REASON_CLASS['share-create-threw'].retry, true);
});

test('runtime 关开关时把它映射回 share-disabled（不在此时假装写成）', () => {
  const cognitive = stubCognitive({ failWith: { ok: false, code: 'share-disabled' } });
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive }));
  assert.equal(produced.reasonCode, 'share-disabled');
  assert.equal(produced.created, false);
});

// ---------------------------------------------------------------------------
// 4. 纯函数纪律与表完整性
// ---------------------------------------------------------------------------

test('decideShare 不改入参、不依赖系统时钟（同一输入两次结果相同）', () => {
  const activity = finishedActivity();
  const evidence = evidenceWith();
  const snapshot = JSON.stringify({ activity, evidence });
  const first = decideShare({ activity, evidence, config: configOn(), now: T0 + 60_000, history: null });
  const second = decideShare({ activity, evidence, config: configOn(), now: T0 + 60_000, history: null });
  assert.deepEqual(first, second, 'deterministic for the same injected inputs');
  assert.equal(JSON.stringify({ activity, evidence }), snapshot, 'the arguments are not mutated');
  // 没有注入 now 时不偷偷用 Date.now()：新鲜度标 unknown，结论仍可复核。
  const noClock = decideShare({ activity, evidence, config: configOn() });
  assert.equal(noClock.facts.freshness.band, 'unknown');
});

test('REASON_CLASS 覆盖 every 具名码，且分类只有 terminal/retry 两档', () => {
  for (const code of Object.values(SHARE_REASON)) {
    assert.ok(Object.hasOwn(REASON_CLASS, code), `missing classification for ${code}`);
    const entry = REASON_CLASS[code];
    assert.equal(typeof entry.terminal, 'boolean');
    assert.equal(typeof entry.retry, 'boolean');
    assert.equal(entry.terminal && entry.retry, false, `${code} cannot be both terminal and retryable`);
  }
  // 与 `lib/p2.mjs:1525-1550` 的 retryable 词表对齐（只校验我们声称对齐的那几个）。
  const P2_RETRYABLE = new Set([
    'quiet-hours', 'quota', 'cooldown', 'rate-limited', 'timeout', 'share-port-threw', 'memory-timeout',
    'share-sink-failed', 'cooldown:room', 'cooldown:global', 'quota:global', 'quota:room',
    'settle:user-active', 'turn-running', 'tool-running', 'backoff:unanswered', 'no-channel',
    'timezone-invalid', 'disabled', 'not-due',
  ]);
  // 与 `lib/p2.mjs:1551-1558` 的 terminal 词表对齐。
  const P2_TERMINAL = new Set(['share-disabled', 'dedupe', 'no-target', 'expired', 'share-port-unavailable', 'scope-mismatch']);
  for (const [code, entry] of Object.entries(REASON_CLASS)) {
    if (entry.gateCode === '') continue;
    const known = P2_RETRYABLE.has(entry.gateCode) || P2_TERMINAL.has(entry.gateCode);
    assert.ok(known, `${code} claims gate code ${entry.gateCode}, which is not in either p2 table`);
    if (P2_TERMINAL.has(entry.gateCode)) assert.equal(entry.terminal, true, `${code} maps to a terminal p2 code but is not terminal`);
    if (P2_RETRYABLE.has(entry.gateCode)) assert.equal(entry.retry, true, `${code} maps to a retryable p2 code but is not retryable`);
  }
});

// ---------------------------------------------------------------------------
// 5. 证据投影与 onFinished 适配
// ---------------------------------------------------------------------------

test('deriveBilibiliEvidence 只接受合法的 watch，忽略 report/interaction 与坏 BV', () => {
  const derived = deriveBilibiliEvidence({
    activity: finishedActivity(),
    evidence: {
      roundId: 'r', roundStatus: 'completed',
      items: [
        { kind: 'report', written: true },
        { kind: 'watch', videoId: 'BVbad', consumedSeconds: 10 },
        { kind: 'watch', videoId: BV1, consumedSeconds: 0 },
        { kind: 'watch', videoId: BV1, consumedSeconds: 540, method: 'transcript' },
        { kind: 'interaction', action: 'like', targetId: 'BV1Sa4y1Z7Zb', status: 'confirmed' },
      ],
    },
  });
  assert.equal(derived.watches.length, 1);
  assert.equal(derived.watchedIds.length, 1);
  assert.equal(derived.watches[0].method, 'transcript');
});

test('deriveBilibiliEvidence 能读 checkpoint 形状，并保留 journalKey', () => {
  const derived = deriveBilibiliEvidence({ activity: finishedActivity() });
  assert.equal(derived.source, 'activity.bilibiliRound');
  assert.equal(derived.roundStatus, 'completed');
  assert.equal(derived.watchedIds[0], BV1);
  const decision = decideShare({ activity: finishedActivity(), config: configOn(), now: T0 + 60_000 });
  assert.equal(decision.facts.journalKey.length, 64, 'sha256 of roundId, matching the journal directory name');
});

test('createFinishedActivityShareHook：永不抛，且把 phase 映射成 status', () => {
  const cognitive = stubCognitive();
  const seen = [];
  const hook = createFinishedActivityShareHook({
    cognitive, config: configOn(), sessionId: 'synthetic-session', scopeKey: SCOPE,
    now: () => T0 + 60_000, evidenceFor: () => evidenceWith(), onDecision: produced => seen.push(produced.reasonCode),
  });
  const produced = hook({ activityId: 'act-bili-0001', kind: 'bilibili', reality: 'actual_tool_activity', phase: 'finished', at: T0, scopeKey: SCOPE });
  assert.equal(produced.reasonCode, 'share-ok');
  assert.equal(produced.created, true);
  assert.deepEqual(seen, ['share-ok']);
  // failed 的活动不会因为 phase 名不同就变成“完成”。
  assert.equal(hook({ activityId: 'act-2', kind: 'bilibili', reality: 'actual_tool_activity', phase: 'failed', at: T0 }).reasonCode, 'not-done');
  // 坏输入被兜住，而不是把异常抛进 runtime 的 finish 事务。
  assert.doesNotThrow(() => createFinishedActivityShareHook({ cognitive: null })());
  assert.equal(createFinishedActivityShareHook({ cognitive: null })().ok, false);
  assert.doesNotThrow(() => createFinishedActivityShareHook({
    cognitive, config: configOn(), scopeKey: SCOPE,
    evidenceFor: () => { throw new Error('synthetic evidence read failure'); },
    now: () => T0,
  })({ activityId: 'act-3', kind: 'bilibili', reality: 'actual_tool_activity', phase: 'finished', at: T0 }));
});

// ---------------------------------------------------------------------------
// 6. 边界：这个模块不发送、不联网、不写盘、不读真实数据
// ---------------------------------------------------------------------------

test('模块源码里没有网络/发送/文件/时钟（候选 ≠ 送达）', () => {
  const source = fs.readFileSync(path.join(here, 'share-decision.mjs'), 'utf8');
  for (const needle of ['fetch(', 'node:http', 'node:https', 'node:net', "node:fs", "from 'fs'", 'sendMessage', 'deliver(', 'Date.now', 'writeFile', 'appendFile', 'DatabaseSync']) {
    assert.equal(source.includes(needle), false, `share-decision.mjs must not contain ${needle}`);
  }
  assert.ok(source.includes('候选已写入 runtime 的候选表'), 'the candidate-vs-delivery statement is part of the module, not an afterthought');
  assert.ok(source.includes('真实送达只能看 contact'), 'the module names the only place a real delivery can be read from');
});

test('候选正文里不出现“已发送/已送达”，返回值的 note 明确区分三态', () => {
  const cognitive = stubCognitive();
  const produced = produceCandidateForFinishedActivity(produceOptions({ cognitive }));
  const input = cognitive.calls.find(call => call.fn === 'createShareCandidate').input;
  for (const word of ['已发送', '已送达', 'sent', 'delivered']) {
    assert.equal(input.body.includes(word), false, `the body must not claim ${word}`);
  }
  assert.ok(produced.note.includes('不是已进 contact'));
  assert.ok(produced.note.includes('不是已送达'));
});
