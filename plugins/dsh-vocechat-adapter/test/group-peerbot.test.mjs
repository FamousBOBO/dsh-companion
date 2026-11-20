// 防互相点火：两个陪伴实例同群时，同伴的话进上下文但**不许驱动回合**。
//
// 这一组的场景是真实的（2026-11-19 本机）：实例甲 uid=4 与实例乙 uid=5 是同一个频道 gid=1
// 的成员，各自的适配层都把"频道成员说话"当合法触发源。于是：
//
//   实例甲发言 → 实例乙看到成员 4 → 掷 0.3 → 实例乙发言 → 实例甲看到成员 5 → 掷 0.3 → …
//
// 概率只能让链变短，**不能保证它停**（尾部永远不是 0）。而每一环都是真实模型调用。
// 判据必须是硬的：`peerBots` 里的 uid 一律 `peer-bot:<uid>`，不掷骰子、不进缓冲。
//
// 五组断言：
//   1. 同伴不触发（含概率为 1 时也不触发 —— 证明是硬闸不是概率）
//   2. 同伴的判定在成员判定之后、概率之前（原因码优先级的证据）
//   3. 非同伴成员照常触发
//   4. 私聊路径不受 peerBots 影响（同一 uid 私聊仍能说话）
//   5. 配置解析与诊断

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate, idList, resolveGroup } from '../gate.mjs';

const chat = (overrides = {}) => ({
  kind: 'chat', mid: 1, fromUid: 1, target: { channel: 1 }, content: 'hello', contentType: 'text/plain', ...overrides,
});

function gateOf({ users = [1], groups = [1], self = 4, group = {} } = {}) {
  return createGate({
    allowUsers: idList(users),
    allowGroups: idList(groups),
    selfUid: self,
    // 概率恒 1：让"不触发"只能来自 peerBots，而不是骰子。
    group: { talkProbability: 1, ...group },
  });
}

// ── 1. 同伴不触发 ───────────────────────────────────────────────────────

test('同伴在群里说话不驱动回合（概率为 1 也不驱动：这是硬闸）', () => {
  const gate = gateOf({ group: { peerBots: [5], talkProbability: 1 } });
  const decision = gate.decideChannel(chat({ fromUid: 5 }), { isMember: true, roll: () => 0 });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'peer-bot:5');
});

test('平台机器人（is_bot=1 的旧 Bot）同样被挡', () => {
  const gate = gateOf({ group: { peerBots: [4, 2] } });
  assert.equal(gate.decideChannel(chat({ fromUid: 2 }), { isMember: true }).reason, 'peer-bot:2');
});

test('多个同伴都挡，且原因码带具体 uid（能分清是谁在点火）', () => {
  const gate = gateOf({ group: { peerBots: [5, 2, 7] } });
  for (const uid of [5, 2, 7]) {
    assert.equal(gate.decideChannel(chat({ fromUid: uid }), { isMember: true }).reason, `peer-bot:${uid}`);
  }
});

test('peerBots 为空时不挡任何人（单实例部署回到原行为）', () => {
  const gate = gateOf({ group: { peerBots: [] } });
  assert.equal(gate.decideChannel(chat({ fromUid: 5 }), { isMember: true }).allow, true);
});

// ── 2. 判定顺序 ─────────────────────────────────────────────────────────

test('非成员同时是同伴：报 peer-bot（本地配置的确定事实先回答）', () => {
  // 顺序是刻意的：`peerBots` 不依赖成员表，而成员表可能 403。让确定的事实先回答，
  // 运维就不会被 "members-unavailable" 引去查平台权限 —— 真正的原因是这个 uid 不该触发。
  const gate = gateOf({ group: { peerBots: [9] } });
  assert.equal(gate.decideChannel(chat({ fromUid: 9 }), { isMember: false }).reason, 'peer-bot:9');
});

test('成员表不可用 + 同伴 uid：报 peer-bot 而不是 members-unavailable', () => {
  // peerBots 是本地配置，不依赖成员表；表读不到时它的结论仍然成立。
  const gate = gateOf({ users: [1], group: { peerBots: [5] } });
  assert.equal(gate.decideChannel(chat({ fromUid: 5 }), { isMember: null }).reason, 'peer-bot:5');
});

test('同伴判定在概率之前：骰子根本不会被调用', () => {
  const gate = gateOf({ group: { peerBots: [5], talkProbability: 0.5 } });
  let calls = 0;
  const decision = gate.decideChannel(chat({ fromUid: 5 }), {
    isMember: true,
    roll: () => { calls += 1; return 0; },
  });
  assert.equal(decision.reason, 'peer-bot:5');
  assert.equal(calls, 0, '被 peer-bot 挡下时不该消耗一次随机数');
});

test('频道不在 allowGroups 里时优先报 channel-not-allowed', () => {
  const gate = gateOf({ groups: [2], group: { peerBots: [5] } });
  assert.equal(gate.decideChannel(chat({ fromUid: 5 }), { isMember: true }).reason, 'channel-not-allowed:1');
});

test('自己发的回声仍优先报 from-self（信封规则最早）', () => {
  const gate = gateOf({ self: 5, group: { peerBots: [5] } });
  assert.equal(gate.decideChannel(chat({ fromUid: 5 }), { isMember: true }).reason, 'from-self');
});

// ── 3. 非同伴成员照常 ───────────────────────────────────────────────────

test('主人与普通成员不受 peerBots 影响', () => {
  const gate = gateOf({ group: { peerBots: [5, 2] } });
  assert.equal(gate.decideChannel(chat({ fromUid: 1 }), { isMember: true }).allow, true);
  assert.equal(gate.decideChannel(chat({ fromUid: 3 }), { isMember: true }).allow, true);
});

test('peerBots 里的人是"不驱动"，不是"不可见"：历史取数不受它影响', async () => {
  // 上下文由 history.mjs 直接读平台，不经过门控 —— 这条断言把那个边界钉住。
  const { mapHistoryRows, selectRows } = await import('../history.mjs');
  const rows = mapHistoryRows([
    { mid: 10, from_uid: 5, detail: { content: '实例乙说的', content_type: 'text/plain' } },
    { mid: 11, from_uid: 1, detail: { content: '主人说的', content_type: 'text/plain' } },
  ]);
  assert.deepEqual(selectRows(rows, {}).map(row => row.mid), [10, 11]);
});

// ── 4. 私聊不受影响 ─────────────────────────────────────────────────────

test('同伴 uid 的私聊仍然能触发（peerBots 只作用于频道）', () => {
  const gate = gateOf({ users: [5], group: { peerBots: [5] } });
  const decision = gate.decide(chat({ fromUid: 5, target: { user: 4 } }));
  assert.equal(decision.allow, true);
});

// ── 5. 配置与诊断 ───────────────────────────────────────────────────────

test('resolveGroup 解析 peerBots：数字、字符串、逗号列表都吃', () => {
  // `idList` 返回 Set，保留**插入顺序**（去重靠它，排序留给 `describe()`）。
  // 所以这里比集合，不比数组顺序。
  assert.deepEqual([...resolveGroup({ peerBots: [5, 2] }).peerBots].sort(), [2, 5]);
  assert.deepEqual([...resolveGroup({ peerBots: '5, 2' }).peerBots].sort(), [2, 5]);
  assert.deepEqual([...resolveGroup({ peerBots: [5, 5, 2] }).peerBots].sort(), [2, 5], '重复要去重');
  assert.deepEqual([...resolveGroup({ peerBots: [0, -1, 'x'] }).peerBots], []);
  assert.deepEqual([...resolveGroup(undefined).peerBots], [], '缺省为空：单实例部署不需要它');
});

test('describe() 报出 peerBots（运维要能一眼看到谁被挡）', () => {
  const gate = gateOf({ group: { peerBots: [5, 2] } });
  assert.deepEqual(gate.describe().group.peerBots, [2, 5]);
});

test('peerBots 在 resolveGroup 的产物里再跑一遍不能丢（幂等）', () => {
  // 这条是真实事故的回归测试：`createGate` 拿到的 group 已经过一次 `resolveGroup`，
  // 产物里 `peerBots` 是 Set。`idList` 当时只认数组与字符串，于是 `String(set)` 得到
  // `"[object Set]"`、解析出空集合 —— 配置里写着 peerBots，日志里却是 `[]`，
  // 两个实例照样互相点火，而**所有单测都是绿的**（它们传的是原始配置）。
  const once = resolveGroup({ peerBots: [5, 2] });
  const twice = resolveGroup(once);
  assert.deepEqual([...twice.peerBots].sort(), [2, 5]);

  // 端到端：真的经过 createGate 之后仍然挡得住。
  const gate = createGate({ allowUsers: [1], allowGroups: [1], selfUid: 4, group: once });
  assert.equal(gate.decideChannel(chat({ fromUid: 5 }), { isMember: true }).reason, 'peer-bot:5');
  assert.deepEqual(gate.describe().group.peerBots, [2, 5]);
});

test('idList 吃 Set（泛化到 allowUsers / allowGroups 也走同一条路）', () => {
  assert.deepEqual([...idList(new Set([1, 2]))], [1, 2]);
  assert.deepEqual([...idList(new Set([3]))], [3]);
  assert.deepEqual([...idList([])], []);
});
