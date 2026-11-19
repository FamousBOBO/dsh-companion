// 频道（群聊）门控：成员 + 概率。
//
// 这一档存在的理由见 `gate.mjs` 头注释：私聊的 `allowUsers` 白名单套到频道上会把
// 「群里其他人说话」全部拒掉（实测 uid 2/4/5 全落 `user-not-allowed`），而直接放开
// 又会让"任何人都能驱动模型"成立。所以频道是三条判据：频道白名单 → 成员 → 概率。
//
// 五组断言，每组对应一个会真的发生的错：
//   1. 私聊路径一字未变（旧的五条规则还在，且不受 group 配置影响）
//   2. 成员放行 / 非成员拒绝（`false` 是事实，不是"不知道"）
//   3. 成员表取不到时 fail-closed 到白名单（`null` 是不知道，不能当成不在）
//   4. 概率 0/1/中间值 + 注入骰子的确定性
//   5. 三态原因码分得开（运维要靠它判断是"不在群里"还是"表读不到"）

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate, idList, resolveGroup } from '../gate.mjs';

const chat = (overrides = {}) => ({
  kind: 'chat', mid: 1, fromUid: 1, target: { channel: 1 }, content: 'hello', contentType: 'text/plain', ...overrides,
});

/** 一个概率恒为 1 的门（除概率专项外，其余用例不让骰子制造随机失败）。 */
function gateOf({ users = [1], groups = [1], self = 4, group = {} } = {}) {
  return createGate({
    allowUsers: idList(users),
    allowGroups: idList(groups),
    selfUid: self,
    group: { talkProbability: 1, ...group },
  });
}

// ── 1. 私聊路径不变 ─────────────────────────────────────────────────────

test('私聊仍然只认 allowUsers：频道配置不影响它', () => {
  const gate = gateOf({ users: [1], groups: [], group: { talkProbability: 0 } });
  assert.equal(gate.decide(chat({ target: { user: 4 } })).allow, true);
  assert.equal(gate.decide(chat({ target: { user: 4 }, fromUid: 9 })).reason, 'user-not-allowed:9');
});

test('空白名单在私聊里仍然是 deny-all（fail-closed 没有被频道档削弱）', () => {
  const gate = createGate({ allowUsers: [], allowGroups: [1], selfUid: 4, group: { talkProbability: 1 } });
  assert.equal(gate.decide(chat()).allow, false);
  assert.equal(gate.describe().failClosed, true);
});

test('信封规则在频道路径上同样先生效：非 chat / 自己发的 / 空正文', () => {
  const gate = gateOf();
  assert.equal(gate.decideChannel(chat({ kind: 'users_snapshot' }), { isMember: true }).reason, 'kind:users_snapshot');
  assert.equal(gate.decideChannel(chat({ fromUid: 4 }), { isMember: true }).reason, 'from-self');
  assert.equal(gate.decideChannel(chat({ content: '   ' }), { isMember: true }).reason, 'empty-text');
});

test('decideChannel 收到私聊事件时退回私聊判定（不发明第二条规则）', () => {
  const gate = gateOf({ users: [1], groups: [] });
  assert.equal(gate.decideChannel(chat({ target: { user: 4 } })).allow, true);
});

// ── 2. 成员 ─────────────────────────────────────────────────────────────

test('频道成员放行：不在 allowUsers 里的成员也能触发', () => {
  const gate = gateOf({ users: [1] });
  const decision = gate.decideChannel(chat({ fromUid: 5 }), { isMember: true });
  assert.equal(decision.allow, true);
  assert.equal(decision.gid, 1);
  assert.equal(decision.from, 5);
});

test('非成员被拒，原因码写明是"不在群里"而不是"表读不到"', () => {
  const gate = gateOf({ users: [1] });
  const decision = gate.decideChannel(chat({ fromUid: 9 }), { isMember: false });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'not-a-member:9');
});

test('频道不在 allowGroups 里：成员也不行', () => {
  const gate = gateOf({ groups: [2] });
  assert.equal(gate.decideChannel(chat({ target: { channel: 1 } }), { isMember: true }).reason, 'channel-not-allowed:1');
});

// ── 3. 成员表不可用：fail-closed ────────────────────────────────────────

test('成员表取不到时：白名单里的人仍然通过（通道不因此死掉）', () => {
  const gate = gateOf({ users: [1] });
  const decision = gate.decideChannel(chat({ fromUid: 1 }), { isMember: null });
  assert.equal(decision.allow, true);
});

test('成员表取不到时：白名单外的人被拒，原因码是 members-unavailable', () => {
  const gate = gateOf({ users: [1] });
  const decision = gate.decideChannel(chat({ fromUid: 5 }), { isMember: null });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'members-unavailable:5');
});

test('漏传 isMember 等价于"我不知道"（不是"不是成员"）', () => {
  const gate = gateOf({ users: [1] });
  assert.equal(gate.decideChannel(chat({ fromUid: 5 })).reason, 'members-unavailable:5');
  assert.equal(gate.decideChannel(chat({ fromUid: 1 })).allow, true);
});

test('传一个 Promise 进来会被当成"不知道"，不会被误判成成员', () => {
  // 这是真实的坑：`isMember` 曾经设计成闭包，而成员表是 async 的，
  // 于是 `Promise !== true` 恒成立、整个频道被判成"表不可用"。
  const gate = gateOf({ users: [1] });
  const decision = gate.decideChannel(chat({ fromUid: 5 }), { isMember: Promise.resolve(true) });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'members-unavailable:5');
});

// ── 4. 概率 ─────────────────────────────────────────────────────────────

test('talkProbability=1：每次触发都放行，不掷骰子', () => {
  const gate = gateOf({ group: { talkProbability: 1 } });
  let calls = 0;
  const decision = gate.decideChannel(chat({ fromUid: 5 }), { isMember: true, roll: () => { calls += 1; return 0.99; } });
  assert.equal(decision.allow, true);
  assert.equal(calls, 0, '概率为 1 时不该消耗一次随机数');
});

test('talkProbability=0：永不主动开口，但原因可查', () => {
  const gate = gateOf({ group: { talkProbability: 0 } });
  const decision = gate.decideChannel(chat({ fromUid: 5 }), { isMember: true, roll: () => 0 });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'chance-skip:0');
});

test('talkProbability=0.5：骰子决定，边界是"小于才放行"', () => {
  const gate = gateOf({ group: { talkProbability: 0.5 } });
  const at = value => gate.decideChannel(chat({ fromUid: 5 }), { isMember: true, roll: () => value });
  assert.equal(at(0.49).allow, true);
  assert.equal(at(0.5).allow, false, 'roll 恰好等于概率时不接话，避免阈值两侧不对称');
  assert.equal(at(0.99).allow, false);
  assert.equal(at(0).allow, true);
});

test('骰子抛错或返回 NaN 时按"接话"处理（宁可多说一句，不要静默吞话）', () => {
  const gate = gateOf({ group: { talkProbability: 0.5 } });
  assert.equal(gate.decideChannel(chat({ fromUid: 5 }), { isMember: true, roll: () => { throw new Error('rng'); } }).allow, true);
  assert.equal(gate.decideChannel(chat({ fromUid: 5 }), { isMember: true, roll: () => Number.NaN }).allow, true);
});

test('概率越界被夹紧到 [0,1]，不产生"永不成立"的意外', () => {
  assert.equal(resolveGroup({ talkProbability: 3 }).talkProbability, 1);
  assert.equal(resolveGroup({ talkProbability: -2 }).talkProbability, 0);
  assert.equal(resolveGroup({ talkProbability: 'x' }).talkProbability, 0.3);
});

// ── 5. 配置与诊断 ───────────────────────────────────────────────────────

test('resolveGroup 的默认值就是这一轮定的口径', () => {
  const group = resolveGroup(undefined);
  assert.equal(group.enabled, true);
  assert.equal(group.talkProbability, 0.3);
  assert.equal(group.historyLimit, 20);
  assert.equal(group.memberCacheMs, 60000);
  assert.equal(group.allowCorrection, false, '群里沉默合法是默认值');
  assert.equal(group.segmentation.maxSegments, 3);
  assert.equal(group.segmentation.maxChars, 120);
});

test('historyLimit 被夹到 100：平台 history 本来就封顶 100，取更多只是白等', () => {
  assert.equal(resolveGroup({ historyLimit: 500 }).historyLimit, 100);
  assert.equal(resolveGroup({ historyLimit: 0 }).historyLimit, 20);
});

test('describe() 把频道这一档的参数全部报出来（运维只读一处）', () => {
  const gate = createGate({
    allowUsers: [1], allowGroups: [1], selfUid: 4, group: { talkProbability: 0.25, historyLimit: 12 },
  });
  const d = gate.describe();
  assert.equal(d.group.talkProbability, 0.25);
  assert.equal(d.group.historyLimit, 12);
  assert.equal(d.group.maxSegments, 3);
  assert.equal(d.group.maxChars, 120);
  assert.equal(d.group.allowCorrection, false);
});

test('group.enabled=false 时频道退回私聊那套判定（可一键关掉群聊档）', () => {
  const gate = gateOf({ users: [1], group: { enabled: false } });
  // 成员 5 不在白名单里：关掉群聊档之后就不该被放行。
  assert.equal(gate.decideChannel(chat({ fromUid: 5 }), { isMember: true }).reason, 'user-not-allowed:5');
  assert.equal(gate.decideChannel(chat({ fromUid: 1 }), { isMember: true }).allow, true);
});
