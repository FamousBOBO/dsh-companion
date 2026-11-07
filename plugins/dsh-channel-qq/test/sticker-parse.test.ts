/** 入站表情：**是话，不是画**。
 *
 * 2026-11-08 用户报告：表情在入站行里显示成 `[图片][图片含义：[动画表情]]` 或
 * `[图片][图片含义：[困]]`，模型于是按「我看到了一张图」去描述它。
 *
 * 这条测试把四件事钉死：
 *   1. 表情**不再**进 `imageSummaries`（那是给人描述画面用的槽位）；
 *   2. 进的是 `stickers`，渲染成 `[表情：困｜key=f:…]`，key 能被下一轮工具用上；
 *   3. 认不出字面时写 `[表情：不认识]`——诚实，不猜；
 *   4. 普通图片的一切行为不变。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OneBotEvent, OneBotMessageSegment } from '../src/types.js';
import { parseInbound, stickerDisplay, stickerOf } from '../src/core/message/parse.js';
import { renderMessageLine } from '../src/core/message/render.js';

const SELF = 2000000001;
const OWNER = 1000000002;
const NOW = Date.parse('2026-11-08T09:00:00+08:00');

/** 一条私聊消息（时间戳用秒，与 OneBot 一致）。 */
function dm(segments: OneBotMessageSegment[]): OneBotEvent {
  return {
    post_type: 'message', message_type: 'private',
    self_id: SELF, user_id: OWNER, message_id: 7001,
    time: Math.floor(NOW / 1000),
    sender: { user_id: OWNER, nickname: '主人' },
    message: segments,
  };
}

/** 一个表情段（NapCat 的 mface 就是这个形状）。 */
function sticker(summary: string, extra: Record<string, unknown> = {}): OneBotMessageSegment {
  return {
    type: 'image',
    data: { url: 'https://cdn.example.com/s.gif', summary, sub_type: 1, file: '0AB4174D.png', ...extra } as never,
  };
}

const image: OneBotMessageSegment = { type: 'image', data: { file: '', url: 'https://cdn.example.com/a.jpg' } };

/** 渲染一条私聊行（`called` 恒 true：私聊就是被叫到）。 */
function lineOf(segments: OneBotMessageSegment[]): string {
  const event = dm(segments);
  const line = renderMessageLine({ event, parsed: parseInbound(event), called: true, quoted: null, nowMs: NOW });
  assert.ok(line !== null, '这条消息必须渲染出一行');
  return line;
}

test('表情不再进 imageSummaries：那一格是给「描述画面」用的', () => {
  const parsed = parseInbound(dm([sticker('[困]')]));
  assert.deepEqual(parsed.imageSummaries, [], '[困] 不是画面描述，不该出现在 imageSummaries');
  assert.deepEqual(parsed.imageUrls, [], '表情也不是图片：不该被当成照片去下载/分析');
  assert.equal(parsed.stickers.length, 1);
  assert.equal(parsed.stickers[0]?.label, '困');
  assert.equal(parsed.stickers[0]?.generic, false);
});

test('渲染成 [表情：困｜key=…]：字面 + 指纹，指纹留给下一轮记录用', () => {
  const line = lineOf([sticker('[困]')]);
  assert.match(line, /\[表情：困/);
  assert.match(line, /key=f:0AB4174D/, 'key 必须印出来，否则下一轮记不了这张表情');
  assert.ok(!line.includes('[图片含义'), '不许再出现「图片含义」：那是描述画面的槽位');
});

test('泛称「动画表情」= 认不出：写 [表情：不认识]，绝不猜画面', () => {
  const parsed = parseInbound(dm([sticker('[动画表情]')]));
  const first = parsed.stickers[0];
  assert.ok(first !== undefined);
  assert.equal(first.label, '');
  assert.equal(first.generic, true);
  assert.equal(stickerDisplay(first), '[表情：不认识｜key=f:0AB4174D]');
});

test('动图表情被标成 animated（记意思时要知道它是动图）', () => {
  assert.equal(stickerOf({ summary: '[动画表情]', url: 'https://x/y.gif' })?.animated, true);
  assert.equal(stickerOf({ summary: '[困]', url: 'https://x/y.png' })?.animated, false);
});

test('普通图片仍然是图片：不带上表情标记', () => {
  const parsed = parseInbound(dm([image]));
  assert.equal(parsed.stickers.length, 0, '没有表情标记的就是图片');
  assert.equal(parsed.imageUrls.length, 1);
  assert.match(lineOf([image]), /\[图片\]/, '无文字的图仍然显示 [图片]');
});

test('只有表情、没有文字：正文就是那个表情（不是「无文字」）', () => {
  const line = lineOf([sticker('[困]')]);
  assert.match(line, /：\[表情：困/, '表情要落在正文槽位——它就是这条消息说的话');
  assert.ok(!line.includes('(无文字)'));
});

test('表情与图片同一条消息：两者各归各的', () => {
  const parsed = parseInbound(dm([image, sticker('[困]')]));
  assert.equal(parsed.imageUrls.length, 1);
  assert.equal(parsed.stickers.length, 1);
  assert.equal(parsed.imageSummaries.length, 0);
});

test('三种识别来源都认：sub_type=1 / summary 带方括号 / mface 字段', () => {
  assert.notEqual(stickerOf({ sub_type: 1 }), null, 'sub_type=1');
  assert.notEqual(stickerOf({ summary: '[困]' }), null, 'summary 带方括号');
  assert.notEqual(stickerOf({ summary: '', emoji_id: 'abc' }), null, 'mface 的 emoji_id');
  assert.equal(stickerOf({ url: 'https://x/a.jpg' }), null, '普通图片不是表情');
});

test('指纹稳定：同一个 file 名每次算出同一个 key（跨消息、跨会话）', () => {
  const a = stickerOf({ summary: '[困]', file: '0AB4174D.png', sub_type: 1 });
  const b = stickerOf({ summary: '[困]', file: '0AB4174D.png', sub_type: 1 });
  assert.equal(a?.key, b?.key);
  assert.equal(a?.key, 'f:0AB4174D', 'file 名的 stem 就是指纹：QQ 每次给同一张图同一个名');
});
