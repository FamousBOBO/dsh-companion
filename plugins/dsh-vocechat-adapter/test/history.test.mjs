// 频道上下文：自上次发言以来的历史。
//
// 这一层的错法都很安静：字段名猜错 = 上下文永远空；排序搞反 = 模型读到倒着的时间线；
// 水位算错 = 把自己上一轮说的话挡在外面（那恰恰是最需要接上的部分）。
// 所以断言全部落在**具体字符串**上，不做"包含某个词"的宽松匹配。
//
// 三组：
//   1. mapHistoryRow：字段名只在这里出现一次，形状不对就丢
//   2. selectRows：水位 / 本批剔除 / 排序 / 截尾
//   3. fetchContext + contextBlock：失败不编内容，成功时的段落形状
//
// 另有一组守 `inboundBatch(events, context)`：私聊（context 为空）必须逐字节不变。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapHistoryRow, mapHistoryRows, selectRows, renderRow, fetchContext, contextBlock, MAX_ROW_CHARS,
} from '../history.mjs';
import { inboundBatch, inboundLine } from '../index.mjs';

/** 实测形状：`GET /api/group/1/history`（2026-11-18，evidence/history-shape-20261118.json）。 */
const raw = (mid, fromUid, content, extra = {}) => ({
  created_at: 1794892571813,
  detail: { content, content_type: 'text/plain', expires_in: null, properties: null, type: 'normal' },
  from_uid: fromUid,
  mid,
  target: { gid: 1 },
  ...extra,
});

const event = (mid, content, extra = {}) => ({
  kind: 'chat', mid, fromUid: 2, target: { channel: 1 }, content, contentType: 'text/plain', ...extra,
});

// ── 1. 字段映射 ─────────────────────────────────────────────────────────

test('平台行 → 内部行：字段名对上实测形状', () => {
  const row = mapHistoryRow(raw(240, 2, '我看看'));
  assert.deepEqual(row, {
    mid: 240, fromUid: 2, content: '我看看', contentType: 'text/plain', createdAt: 1794892571813,
  });
});

test('正文与类型从 detail 里取（webhook 形状的顶层 content 也认，方便重用）', () => {
  const flat = mapHistoryRow({ mid: 5, from_uid: 3, content: '有内容的文本' });
  assert.equal(flat.content, '有内容的文本');
  assert.equal(flat.contentType, '');
});

test('mid 非法就丢掉：没有 mid 就不能做幂等与排序', () => {
  assert.equal(mapHistoryRow(raw(0, 2, 'x')), null);
  assert.equal(mapHistoryRow(raw('abc', 2, 'x')), null);
  assert.equal(mapHistoryRow(null), null);
  assert.equal(mapHistoryRow('nope'), null);
});

test('发送者拿不到时给 0（渲染成 uid:?），不是整条丢掉', () => {
  const row = mapHistoryRow({ mid: 7, detail: { content: '匿名' } });
  assert.equal(row.fromUid, 0);
  assert.match(renderRow(row), /uid:\?/);
});

test('mapHistoryRows 丢掉坏行但保留好行（一条坏行不该让上下文整段消失）', () => {
  const rows = mapHistoryRows([raw(1, 2, 'a'), null, raw(0, 2, 'bad'), raw(2, 3, 'b')]);
  assert.deepEqual(rows.map(row => row.mid), [1, 2]);
});

// ── 2. 筛选与排序 ───────────────────────────────────────────────────────

test('水位：只留 mid 大于"上次发出的那条"（那之后才是我没看到的）', () => {
  const rows = mapHistoryRows([raw(10, 2, 'a'), raw(11, 2, 'b'), raw(12, 2, 'c')]);
  assert.deepEqual(selectRows(rows, { watermark: 11 }).map(row => row.mid), [12]);
});

test('没有水位时全部保留（退化成"最近说过这些话"）', () => {
  const rows = mapHistoryRows([raw(10, 2, 'a'), raw(11, 2, 'b')]);
  assert.deepEqual(selectRows(rows, { watermark: null }).map(row => row.mid), [10, 11]);
});

test('本批的 mid 被剔除：同一句不能在"历史"与"正文"里出现两次', () => {
  const rows = mapHistoryRows([raw(20, 2, 'a'), raw(21, 2, 'b'), raw(22, 2, 'c')]);
  assert.deepEqual(selectRows(rows, { batchMids: [21, 22] }).map(row => row.mid), [20]);
});

test('顺序按 mid 升序，不信任平台返回顺序（实测是升序，但注释写的是降序）', () => {
  const descending = mapHistoryRows([raw(33, 2, 'c'), raw(31, 2, 'a'), raw(32, 2, 'b')]);
  assert.deepEqual(selectRows(descending).map(row => row.mid), [31, 32, 33]);
});

test('超限时保留**最近**的那些（尾部），不是最早的那些', () => {
  const rows = mapHistoryRows([1, 2, 3, 4, 5].map(mid => raw(mid, 2, `m${mid}`)));
  assert.deepEqual(selectRows(rows, { limit: 2 }).map(row => row.mid), [4, 5]);
});

test('水位与本批剔除可以叠加', () => {
  const rows = mapHistoryRows([1, 2, 3, 4, 5, 6].map(mid => raw(mid, 2, `m${mid}`)));
  assert.deepEqual(selectRows(rows, { watermark: 2, batchMids: [6], limit: 10 }).map(row => row.mid), [3, 4, 5]);
});

// ── 3. 渲染 ─────────────────────────────────────────────────────────────

test('自己发的标「你自己」：模型必须能分出哪句是它说的', () => {
  const row = mapHistoryRow(raw(50, 4, '我说的'));
  assert.match(renderRow(row, { selfUid: 4 }), /uid:4（你自己）：我说的/);
  const other = mapHistoryRow(raw(51, 2, '别人说的'));
  assert.match(renderRow(other, { selfUid: 4 }), /uid:2：别人说的/);
  assert.equal(renderRow(other, { selfUid: 4 }).includes('你自己'), false);
});

test('单条超长被截断并标记，长度有上限（上下文预算）', () => {
  const long = 'x'.repeat(MAX_ROW_CHARS + 40);
  const rendered = renderRow(mapHistoryRow(raw(60, 2, long)));
  assert.equal(rendered.includes('…'), true);
  assert.equal(rendered.length <= MAX_ROW_CHARS + 20, true);
});

test('正文内部的换行缩进对齐，避免看起来像好几条历史', () => {
  const rendered = renderRow(mapHistoryRow(raw(61, 2, '第一行\n第二行')));
  assert.match(rendered, /第一行\n    第二行/);
});

// ── 4. 取数与段落 ───────────────────────────────────────────────────────

test('fetchContext：正常路径返回渲染好的行与条数', async () => {
  const port = { history: async () => [raw(1, 2, 'a'), raw(2, 4, 'b')] };
  const result = await fetchContext({ port, target: { channel: 1 }, selfUid: 4 });
  assert.equal(result.reason, 'ok');
  assert.equal(result.rows, 2);
  assert.deepEqual(result.lines, ['[1] uid:2：a', '[2] uid:4（你自己）：b']);
});

test('fetchContext：端口缺席 / 没有 history 能力 → no-port，不抛', async () => {
  assert.equal((await fetchContext({ port: null, target: { channel: 1 } })).reason, 'no-port');
  assert.equal((await fetchContext({ port: {}, target: { channel: 1 } })).reason, 'no-port');
});

test('fetchContext：接口抛错 → error:<code>，且 rows=0 不编内容', async () => {
  const port = { history: async () => { const error = new Error('boom'); error.code = 'forbidden'; throw error; } };
  const result = await fetchContext({ port, target: { channel: 1 } });
  assert.equal(result.reason, 'error:forbidden');
  assert.deepEqual(result.lines, []);
});

test('fetchContext：非数组 → bad-response（空数组与"没看懂答案"必须分开）', async () => {
  const port = { history: async () => ({ nope: true }) };
  assert.equal((await fetchContext({ port, target: { channel: 1 } })).reason, 'bad-response');
});

test('fetchContext：过滤后为空 → no-history（这不是故障，不记 miss）', async () => {
  const port = { history: async () => [raw(3, 2, 'x')] };
  const result = await fetchContext({ port, target: { channel: 1 }, watermark: 3 });
  assert.equal(result.reason, 'no-history');
  assert.deepEqual(result.lines, []);
});

test('contextBlock：没有行就没有这一段（私聊、或有频道但无可说）', () => {
  assert.deepEqual(contextBlock([], 232), []);
  assert.deepEqual(contextBlock(null), []);
  assert.deepEqual(contextBlock([''], 1), []);
});

test('contextBlock：有水印时点名水印，没有时只说"最近说过"', () => {
  const withMark = contextBlock(['[240] uid:2：x'], 232);
  assert.match(withMark[0], /自你上次发言（mid 232）之后/);
  assert.equal(withMark.at(-1), '——');
  const without = contextBlock(['[240] uid:2：x'], null);
  assert.match(without[0], /频道里最近说过这些话/);
});

// ── 5. 入站包：私聊逐字节不变，频道才加段 ───────────────────────────────

const dmEvent = mid => ({
  kind: 'chat', mid, fromUid: 1, target: { user: 4 }, content: `m${mid}`, contentType: 'text/plain',
});

test('私聊单条：context 为空时与 inboundLine 逐字节相同', () => {
  const one = dmEvent(11);
  assert.equal(inboundBatch([one], []), inboundLine(one));
});

test('私聊多条：context 为空时输出不含任何历史字样', () => {
  const text = inboundBatch([dmEvent(21), dmEvent(22)], []);
  assert.equal(text.includes('自你上次发言'), false);
  assert.equal(text.includes('频道里最近'), false);
});

test('频道单条带上下文：上下文段在正文之前、mid 行之后', () => {
  const text = inboundBatch([event(300, '刚说的这句')], ['频道里最近说过这些话：', '[290] uid:5：之前那句', '——']);
  const lines = text.split('\n');
  assert.equal(lines[0], '【VoceChat 入站】频道 gid=1');
  assert.equal(lines[1], 'mid=300 from_uid=2 type=text/plain');
  assert.equal(lines[2], '频道里最近说过这些话：');
  assert.equal(lines[3], '[290] uid:5：之前那句');
  assert.equal(lines[4], '——');
  assert.equal(lines[5], '');
  assert.equal(lines[6], 'uid:2：刚说的这句');
});

test('频道多条带上下文：历史段在条数说明之前', () => {
  const text = inboundBatch([event(300, 'a'), event(301, 'b')], ['频道里最近说过这些话：', '[290] uid:5：x', '——']);
  const indexHistory = text.indexOf('频道里最近说过这些话');
  const indexCount = text.indexOf('连着发了 2 条');
  assert.equal(indexHistory > 0, true);
  assert.equal(indexCount > indexHistory, true);
});

test('频道行带发言人标签，私聊行不带（私聊提示词不许被改写）', () => {
  assert.match(inboundBatch([event(400, '群里的'), event(401, '两句')]), /\[400\] uid:2：群里的/);
  assert.equal(inboundBatch([dmEvent(402)]).includes('uid:1：'), false);
});
