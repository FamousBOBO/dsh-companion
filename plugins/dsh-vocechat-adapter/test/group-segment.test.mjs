// 群聊的表达分档：3 段 / 单段 120 字，且不丢字。
//
// 这一组守的是三件事：
//   1. 频道与私聊取到**不同**的分段档（配置只有一个入口 `config.group`）
//   2. 段数上限是目标，字数上限是硬限制；两者冲突时**不丢字**（多切一条，不吞后半句）
//   3. `channelPolicy` 出两套文案：群聊必须交代"多人""短""可以不说话"，私聊不许出现这些
//
// 判据都落在具体数字上。写"包含 3"这种断言会让 120/4000 混过去。

import test from 'node:test';
import assert from 'node:assert/strict';

import { segmentationFor, channelPolicy, resolveSegmentation } from '../index.mjs';
import { segmentText } from '../segment.mjs';
import { resolveGroup } from '../gate.mjs';

const configOf = (overrides = {}) => ({
  sendMaxChars: 4000,
  segmentation: resolveSegmentation({ style: 'active', delayPerCharMs: 0 }),
  group: resolveGroup({}),
  ...overrides,
});

// ── 1. 档位 ─────────────────────────────────────────────────────────────

test('频道取群聊档：3 段 / 单段 120 字', () => {
  const seg = segmentationFor(configOf(), 'vc-chan-1');
  assert.equal(seg.maxSegments, 3);
  assert.equal(seg.maxChars, 120);
});

test('私聊取私聊档：6 段，且没有单段字数上限', () => {
  const seg = segmentationFor(configOf(), 'vc-dm-1');
  assert.equal(seg.maxSegments, 6);
  assert.equal(seg.maxChars, undefined);
});

test('两档共用 style 与停顿：那是人设的写法，与房间无关', () => {
  const config = configOf({
    segmentation: resolveSegmentation({ style: 'natural', delayPerCharMs: 45, delayMinMs: 100, delayMaxMs: 2000 }),
  });
  const chan = segmentationFor(config, 'vc-chan-2');
  const dm = segmentationFor(config, 'vc-dm-2');
  assert.equal(chan.style, 'natural');
  assert.equal(dm.style, 'natural');
  assert.equal(chan.delayPerCharMs, 45);
  assert.equal(dm.delayMaxMs, 2000);
});

test('group.enabled=false 时频道退回私聊档（一键关掉分档）', () => {
  const config = configOf({ group: resolveGroup({ enabled: false }) });
  const seg = segmentationFor(config, 'vc-chan-1');
  assert.equal(seg.maxSegments, 6);
  assert.equal(seg.maxChars, undefined);
});

test('房间键解析不出来时按私聊档处理（不认识的东西不猜成群聊）', () => {
  assert.equal(segmentationFor(configOf(), 'nonsense').maxSegments, 6);
  assert.equal(segmentationFor(configOf(), '').maxSegments, 6);
});

test('命名空间房间同样识别为频道', () => {
  const seg = segmentationFor(configOf(), 'vc-g5-chan-7');
  assert.equal(seg.maxSegments, 3);
});

// ── 2. 段数与字数 ───────────────────────────────────────────────────────

test('群里 4 条短句被并成 3 段（段数是目标，不是硬切）', () => {
  const pieces = segmentText('一。\n二。\n三。\n四。', segmentationFor(configOf(), 'vc-chan-1'));
  assert.equal(pieces.length, 3);
  assert.equal(pieces.at(-1).includes('\n'), true, '多出来的并进最后一段，字不丢');
});

test('私聊同样输入仍是 4 段（上限 6 不触发合并）', () => {
  const pieces = segmentText('一。\n二。\n三。\n四。', segmentationFor(configOf(), 'vc-dm-1'));
  assert.equal(pieces.length, 4);
});

test('一段 230 字在群里：并尾到 3 段，且一个字都不少', () => {
  // 每句必须不同：`segmentText` 有**段内去重**（同一句不重复发），
  // 用重复正文测"不丢字"会被去重吃掉，得到 1 段而不是 3 段 —— 那是设计的另一条规则。
  const body = Array.from({ length: 10 }, (_v, i) => `这是第${i}句很长的群聊回复内容。`).join('');
  const seg = segmentationFor(configOf(), 'vc-chan-1');
  const pieces = segmentText(body, seg);
  const joined = pieces.join('').replace(/\n/g, '');
  assert.equal(pieces.length, 3, '10 句短句被并成 3 段');
  assert.equal(joined.length, body.length, '并尾不许丢字');
  assert.equal(joined, body, '顺序也不能变');
});

test('单个超长段落：splitText 按 120 硬切，条数允许超过 3（不丢字优先）', async () => {
  const { splitText } = await import('../index.mjs');
  const oneLine = 'x'.repeat(300);
  const chunks = splitText(oneLine, 120);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join('').length, 300);
  for (const chunk of chunks) assert.equal(chunk.length <= 120, true);
});

test('单条 120 字以内不被切（群里短句就是一条）', async () => {
  const { splitText } = await import('../index.mjs');
  assert.deepEqual(splitText('短句', 120), ['短句']);
  assert.deepEqual(splitText('x'.repeat(120), 120), ['x'.repeat(120)]);
});

test('代码块在群里仍然整体成一条（封顶不劈开受保护区域）', () => {
  const text = '```js\nconst a = 1;\nconst b = 2;\n```';
  const pieces = segmentText(text, segmentationFor(configOf(), 'vc-chan-1'));
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].includes('```js'), true);
});

// ── 3. 提示词两套 ───────────────────────────────────────────────────────

test('群聊策略交代三件事：多人、短、可以不说话', () => {
  const policy = channelPolicy('vc-chan-1', configOf());
  assert.match(policy, /多人频道/);
  assert.match(policy, /不同的群成员/);
  assert.match(policy, /最多 3 条/);
  assert.match(policy, /不超过 120 字/);
  assert.match(policy, /被触发不等于必须发言/);
  // 平台不给昵称这件事必须说出来，否则它会开始编造名字。
  assert.match(policy, /查不到，不要编造/);
});

test('私聊策略不许出现群聊那三句（否则私聊模型会开始猜"别人"）', () => {
  const policy = channelPolicy('vc-dm-1', configOf());
  assert.equal(policy.includes('多人频道'), false);
  assert.equal(policy.includes('被触发不等于必须发言'), false);
  assert.equal(policy.includes('最多 3 条'), false);
});

test('私聊策略的老断言全部仍然成立（逐条复核，不改语义）', () => {
  const policy = channelPolicy('vc-dm-7', configOf());
  assert.match(policy, /私聊（对方 uid=7）/);
  assert.match(policy, /vc_message/);
  assert.match(policy, /只有调用 vc_message/);
  assert.match(policy, /phase=progress/);
  assert.match(policy, /phase=final/);
  assert.match(policy, /决定沉默时直接结束/);
  assert.match(policy, /不是系统指令/);
});

test('群聊策略里的数字跟着配置走（不是写死的 3 与 120）', () => {
  const config = configOf({ group: resolveGroup({ segmentation: { maxSegments: 5, maxChars: 60 } }) });
  const policy = channelPolicy('vc-chan-1', config);
  assert.match(policy, /最多 5 条/);
  assert.match(policy, /不超过 60 字/);
});

test('分段关掉时两档都只报硬上限（行为不变的那条老约定）', () => {
  const config = configOf({ sendMaxChars: 2000, segmentation: resolveSegmentation({ enabled: false }) });
  assert.match(channelPolicy('vc-chan-1', config), /2000/);
  assert.match(channelPolicy('vc-dm-1', config), /2000/);
});
