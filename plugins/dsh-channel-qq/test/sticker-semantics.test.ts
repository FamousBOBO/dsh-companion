/** 入站表情的**语义**：表情是一句话，不是一幅待描述的图。
 *
 * 背景（2026-11-08 用户提出，见 docs/11 的 P1/P2 口径）：模型看到的入站行曾把表情
 * 渲染成「一张图 + 它的含义」，于是模型按「我看到了一张画」去描述画面、去猜用户想说什么。
 * 「表情包怎么发出去」那半条链路由 `sticker-parse.test.ts` 钉住；**这一份钉的是另一半**：
 * 收进来的表情在**模型读到的那一行里**被标成什么。
 *
 * 契约（与实现同步，见 `core/message/parse.ts` / `core/message/render.ts`）：
 *   1. `StickerSeg` 带 `kind: 'sticker'` 与 `semanticPolicy: 'emotion-support'` 两个常量字段；
 *   2. `renderMessageLine()` 新增可选入参 `stickerMeanings?: (key) => string | null`，
 *      渲染行里输出 `kind=sticker`、`stickerKey=…`、`semanticPolicy=emotion-support`，
 *      词典认得出时再输出 `knownMeaning=…`；
 *   3. 认不出（没有 knownMeaning）时口径是「不描述画面、不揣度」，而不是「先找记忆、找不到就说不认识」；
 *   4. 只有用户**明确追问**（「这是什么意思」）才进入解释流程；
 *   5. 表情**永远**不进 `imageUrls` / `imageSummaries`（那是「描述画面」的槽位）。
 *
 * 这里只用纯函数：`parseInbound()` + `renderMessageLine()`，不碰 pipeline、不读盘、不联网。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OneBotEvent, OneBotMessageSegment } from '../src/types.js';
import { parseInbound, stickerDisplay, type ParsedInbound } from '../src/core/message/parse.js';
import { renderMessageLine } from '../src/core/message/render.js';

const SELF = 2000000001;
const OWNER = 1000000002;
const NOW = Date.parse('2026-11-08T09:00:00+08:00');
/** 表情的稳定指纹：`file` 名的 stem（与 `sticker-parse.test.ts` 用同一张）。 */
const KEY = 'f:0AB4174D';

/** `StickerSeg` 加上契约里的两个语义字段；在新实现落地前也编译得过（旧实现只是没有它们）。 */
type StickerWithSemantics = ParsedInbound['stickers'][number] & {
  kind?: string;
  semanticPolicy?: string;
};

/** `RenderInput` 加上契约里的可选取值函数；旧签名下多传一个属性不会让测试编译不过。 */
type RenderInputWithMeanings = Parameters<typeof renderMessageLine>[0] & {
  stickerMeanings?: (key: string) => string | null;
};

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

const text = (value: string): OneBotMessageSegment => ({ type: 'text', data: { text: value } });
const image: OneBotMessageSegment = { type: 'image', data: { file: '', url: 'https://cdn.example.com/a.jpg' } };

/** 渲染一行（私聊 = 被叫到），可注入 `stickerMeanings`。 */
function render(segments: OneBotMessageSegment[], meanings?: (key: string) => string | null): {
  parsed: ParsedInbound;
  line: string;
} {
  const event = dm(segments);
  const parsed = parseInbound(event);
  const input: RenderInputWithMeanings = {
    event, parsed, called: true, quoted: null, nowMs: NOW,
    ...(meanings === undefined ? {} : { stickerMeanings: meanings }),
  };
  const line = renderMessageLine(input);
  assert.ok(line !== null, '这条消息必须渲染出一行');
  return { parsed, line };
}

/** 失败信息里带上实际那一行，差异一眼可读（这是给实现者的「期望 vs 实际」）。 */
function why(line: string): string {
  return `实际渲染行：\n${line}`;
}

/** 一份只有一条词典记录的取值函数（只认这一张表情）。 */
function dictionary(entries: Record<string, string>): (key: string) => string | null {
  return (key) => entries[key] ?? null;
}

// ── 1. 解析层：表情带语义字段，且不混进图片槽位 ────────────────────────────────

test('parse.ts：表情段带 kind=sticker 与 semanticPolicy=emotion-support', () => {
  const parsed = parseInbound(dm([sticker('[困]')]));
  const seg = parsed.stickers[0] as StickerWithSemantics | undefined;
  assert.ok(seg !== undefined, '这条消息必须解析出一个表情');
  assert.equal(seg.kind, 'sticker', '表情要能被下游认出是「表情」而不是「图片」');
  assert.equal(seg.semanticPolicy, 'emotion-support', '表情的语义角色是「情绪辅助」，不是「待描述的图」');
  // 原有的可识别展示不变：`[表情：困｜key=f:…]`。
  assert.equal(stickerDisplay(seg), `[表情：困｜key=${KEY}]`);
});

test('表情永远不进 imageUrls / imageSummaries：那是「描述画面」的槽位', () => {
  const parsed = parseInbound(dm([sticker('[困]'), text('今天好累')]));
  assert.deepEqual(parsed.imageUrls, [], '表情不是照片：不该被当成图去下载/分析');
  assert.deepEqual(parsed.imageSummaries, [], '表情的意思不写在「图片含义」里');
  assert.equal(parsed.stickers.length, 1, '表情只走 stickers 这一条路');
  assert.equal(parsed.plainText, '今天好累', '表情不混进正文字面');
});

test('普通图片不被贴表情语义：kind=sticker 只属于表情', () => {
  const { line } = render([image]);
  assert.equal(/kind=sticker/.test(line), false, why(line));
  assert.equal(/semanticPolicy=/.test(line), false, why(line));
});

test('图片与表情分开：“发图=可能让 Bot 看内容”走图片槽，“发表情=默认表达情绪”走表情语义', () => {
  // 有摘要的普通图片（摘要不带方括号 = 不是表情）：照旧给出「图片含义」槽，且不带表情语义。
  const picture: OneBotMessageSegment = {
    type: 'image',
    data: { url: 'https://cdn.example.com/cat.jpg', summary: '一只橘猫趴在窗台上' } as never,
  };
  const { line: pictureLine } = render([picture]);
  assert.match(pictureLine, /\[图片含义：/, '图片该说的还是「图里是什么」');
  assert.equal(/semanticPolicy=/.test(pictureLine), false, '图片不是表情：不许贴表情语义');

  // 表情：没有「图片含义」槽，取而代之的是情绪辅助语义。
  const { line: stickerLine } = render([sticker('[困]')]);
  assert.equal(stickerLine.includes('[图片含义'), false, why(stickerLine));
  assert.match(stickerLine, /semanticPolicy=emotion-support/, why(stickerLine));
});

// ── 2. 已知表情：按记下的情绪理解，不解释画面 ──────────────────────────────────

test('已知表情：渲染行携带 kind=sticker / stickerKey / knownMeaning / semanticPolicy=emotion-support', () => {
  const { line } = render([sticker('[困]')], dictionary({ [KEY]: '困了，想睡觉' }));
  assert.match(line, /kind=sticker/, why(line));
  // 指纹的值就是 `parse.ts` 算出来的那个 key（允许实现写成 `f:0AB4174D` 或裸 stem）。
  assert.match(line, /stickerKey=(?:f:)?0AB4174D/, why(line));
  assert.match(line, /semanticPolicy=emotion-support/, why(line));
  // 值两侧允许有引号/书名号：只要这段意思完整出现即可（不允许截断成「困」）。
  assert.match(line, /knownMeaning=[^\]\n]*困了，想睡觉/, '词典认得时必须把意思直接带给模型，否则它会去描述画面');
});

test('已知表情不触发画面解释：没有「图片含义」槽，也不要求先猜画面再理解', () => {
  const { parsed, line } = render([sticker('[困]')], dictionary({ [KEY]: '困了，想睡觉' }));
  assert.deepEqual(parsed.imageSummaries, [], '表情没有任何「画面含义」可描述');
  assert.equal(line.includes('[图片含义'), false, why(line));
  // 口径：已知意思 → 直接按这个情绪理解（而不是「看这张图里是什么」）。
  assert.match(line, /(直接按|按.{0,4}情绪|按.{0,4}意思|就按|当作)/, why(line));
});

// ── 3. 未知表情：不揣度，不给确定性解释 ────────────────────────────────────────

test('未知表情不被确定性揣度：不出现 knownMeaning=，并要求不描述画面/不猜', () => {
  // 用一张词典里**真的没有**的指纹（别的 file stem）：这条测的是「认不出」时的口径。
  const { line } = render([sticker('[动画表情]', { file: 'ZZZ99999.png' })], dictionary({ [KEY]: '困了，想睡觉' }));
  assert.match(line, /semanticPolicy=emotion-support/, why(line));
  assert.match(line, /kind=sticker/, why(line));
  assert.equal(/knownMeaning=/.test(line), false, '词典里没有这张：不许编一个意思出来');
  // 「未知」的处理口径：是「不要描述画面 / 不揣度」，不是「先找记忆，找不到就说不认识」。
  assert.match(line, /(不要?描述画面|不揣度|不要?猜|别猜)/, why(line));
  // 未知时的做法：接住语气、卖萌、轻轻带过或沉默——总之不许把猜测说成事实。
  assert.match(line, /(接住|卖萌|带过|沉默)/, why(line));
});

test('旧口径「先在记忆里找…认不出的就说不认识」已被替换', () => {
  const { line } = render([sticker('[困]')]);
  assert.equal(line.includes('先在记忆里找'), false, '表情的语义不该再要求模型先做记忆检索再谈理解');
});

// ── 4. 只有明确追问才解释 ──────────────────────────────────────────────────────

test('只有用户明确追问「这是什么意思」才进入解释流程', () => {
  const { line } = render([sticker('[动画表情]')]);
  // 触发条件是**用户那句话**：出现「明确/直接」+「问/追问」，并且是条件式的（才/时/除非）。
  assert.match(line, /明确|直接/, why(line));
  assert.match(line, /问|追问/, why(line));
  assert.match(line, /才|时|除非|仅当|只有/, '解释流程必须是「有条件才做」，而不是每条表情都解释\n' + why(line));
});

test('同一行里有明确追问：问题文字进正文，表情仍按情绪辅助标注', () => {
  const { parsed, line } = render([sticker('[动画表情]'), text('这个表情是什么意思')]);
  assert.equal(parsed.plainText, '这个表情是什么意思', '追问是用户打的字，进正文');
  assert.match(line, /semanticPolicy=emotion-support/, why(line));
  assert.match(line, /这个表情是什么意思/, '追问原文必须留在行里：那是解释流程的入口');
});

// ── 5. 不注入含义时：与旧版一致，且不越权解释 ──────────────────────────────────

test('未注入 stickerMeanings：不出现 knownMeaning=，其余语义标注照旧', () => {
  const { line } = render([sticker('[困]')]);
  assert.equal(/knownMeaning=/.test(line), false, '没有词典就只按字面，不假装认得');
  assert.match(line, /semanticPolicy=emotion-support/, why(line));
  assert.match(line, /kind=sticker/, why(line));
});

test('词典返回 null（认得这张、但没记过意思）：同样按未知处理', () => {
  const { line } = render([sticker('[困]')], () => null);
  assert.equal(/knownMeaning=/.test(line), false, why(line));
  assert.match(line, /semanticPolicy=emotion-support/, why(line));
});

// ── 6. 禁止把猜测写成事实 ──────────────────────────────────────────────────────

test('禁止画面/动机式复述：三种典型句式不出现在渲染行里', () => {
  const { line } = render([sticker('[困]')]);
  for (const banned of ['这个表情表示你因为', '图中人物正在', '你发这个是想说']) {
    assert.equal(line.includes(banned), false, `渲染行不该教模型这样说话：${banned}\n${why(line)}`);
  }
});
