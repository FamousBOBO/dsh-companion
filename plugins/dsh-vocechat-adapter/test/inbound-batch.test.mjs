// 攒批之后交给模型的那段话。
//
// 这里最容易出的错是**单条消息的提示词被悄悄改动**：加了攒批之后，
// 主人只发一句话的那条路径必须与加之前逐字节相同，否则以前调好的表达会被无声改写。
// 另一头是多条：必须让模型看出"这是同一段话的几句"，否则它会逐条各答一遍 ——
// 那正是加缓冲要避免的结果。

import test from 'node:test';
import assert from 'node:assert/strict';

import { inboundBatch, inboundLine } from '../index.mjs';

function event(mid, content, extra = {}) {
  return { kind: 'chat', mid, fromUid: 1, target: { user: 4 }, content, contentType: 'text/plain', ...extra };
}

test('单条时与 inboundLine 逐字节相同（旧提示词不能被改写）', () => {
  const one = event(11, '在吗');
  assert.equal(inboundBatch([one]), inboundLine(one));
});

test('空批次返回空串（不合成一条假消息）', () => {
  assert.equal(inboundBatch([]), '');
  assert.equal(inboundBatch(null), '');
});

test('多条时逐条带 mid 列出，并说明它们是一段话的几句', () => {
  const text = inboundBatch([event(21, '在吗'), event(22, '问你个事'), event(23, '昨天那个文件你放哪了')]);
  assert.match(text, /连着发了 3 条/);
  assert.match(text, /mid 21…23/);
  assert.match(text, /\[21\] 在吗/);
  assert.match(text, /\[22\] 问你个事/);
  assert.match(text, /\[23\] 昨天那个文件你放哪了/);
  assert.match(text, /按整体回应一次，不要逐条各答一遍/);
});

test('正文里的换行被缩进保留，不会被压成一行', () => {
  const text = inboundBatch([event(31, '第一行\n第二行'), event(32, '收尾')]);
  assert.match(text, /\[31\] 第一行\n    第二行/);
});

test('频道事件用 gid 说明地点，私聊用对方 uid', () => {
  const group = inboundBatch([
    event(41, 'a', { target: { channel: 1 } }),
    event(42, 'b', { target: { channel: 1 } }),
  ]);
  assert.match(group, /频道 gid=1/);
  const dm = inboundBatch([event(43, 'a'), event(44, 'b')]);
  assert.match(dm, /私聊（对方 uid=1）/);
});

test('空正文的那几条不占行（但仍算在条数里，因为平台确实发过来了）', () => {
  const text = inboundBatch([event(51, '有内容'), event(52, '   '), event(53, '也有内容')]);
  assert.match(text, /连着发了 3 条/);
  assert.equal(text.includes('[52]'), false, '空白正文不该出现一个空行号');
});

test('两条也算攒批（不只是三条以上）', () => {
  const text = inboundBatch([event(61, '嗯'), event(62, '在的')]);
  assert.match(text, /连着发了 2 条/);
  assert.match(text, /按整体回应一次/);
});
