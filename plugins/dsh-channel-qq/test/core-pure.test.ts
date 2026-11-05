/** `core/` 的纯函数单测。
 *
 * 这些函数原来都是 `ConversationBridge` 的私有方法（或者干脆内联在 89 行的
 * `handleEvent` 里），要测它们只能构造一整个 bridge：宿主、WebSocket、网络取回器、
 * 冻结时钟缺一不可。搬进 `core/` 之后它们不再读全局状态，于是这里可以直接
 * 列出"什么输入出什么结果"——P3 的完成判据就是这么被钉住的。
 *
 * 时区必须先定死再加载被测模块：`renderMessageLine` 打的是本地 `HH:MM`，
 * 不固定 `TZ` 的话输出会随开发机漂移（`golden.test.ts` 同样的做法）。
 */

process.env.TZ = 'Asia/Shanghai'

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { dmRoom, groupRoom, roomOf, sessionIdOf, splitRoom } = await import('../src/core/room.js')
const { isCalled, reactionHintOf, talkChanceOf } = await import('../src/core/trigger.js')
const { decideFlush, isBatchFull, queueChars } = await import('../src/core/batching.js')
const { GATEWAY_RETRY_MAX, classifyFailure, gatewayBackoffMs } = await import('../src/core/retry-policy.js')
const { renderMessageLine } = await import('../src/core/message/render.js')
const { parseInbound } = await import('../src/core/message/parse.js')
const { localDayKey, timeContext } = await import('../src/core/schedule/stamp.js')
type OneBotEvent = import('../src/types.js').OneBotEvent

const SELF = 1705
const GROUP = 107
const MASTER = 280

/** 一条群消息；段与时间都可以覆写。 */
function groupEvent(over: Partial<OneBotEvent> = {}): OneBotEvent {
  return {
    time: Math.floor(Date.parse('2026-10-16T14:31:00+08:00') / 1000),
    self_id: SELF,
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP,
    user_id: 999,
    message_id: 4242,
    sender: { user_id: 999, nickname: '小明' },
    message: [{ type: 'text', data: { text: '在吗' } }],
    ...over,
  } as OneBotEvent
}

// ── room ────────────────────────────────────────────────────────────────────

test('core/room：房间键的拼法是承重结构，钉死它', () => {
  assert.equal(groupRoom(107), 'group-107')
  assert.equal(dmRoom(280), 'dm-280')
  assert.equal(sessionIdOf('group-107'), 'qq-group-107')
  assert.deepEqual(splitRoom('group-107'), { isGroup: true, chatId: 107 })
  assert.deepEqual(splitRoom('dm-280'), { isGroup: false, chatId: 280 })
  assert.equal(splitRoom('group-'), null, '缺数字不算群')
  assert.equal(splitRoom('channel-1'), null, '不认识的前缀不许猜')
})

test('core/room：从事件推房间，非群非私聊返回 null', () => {
  assert.equal(roomOf(groupEvent()), 'group-107')
  assert.equal(roomOf(groupEvent({ message_type: 'private', user_id: MASTER })), 'dm-280')
  assert.equal(roomOf(groupEvent({ message_type: undefined })), null)
})

// ── trigger ─────────────────────────────────────────────────────────────────

const TRIGGER = {
  keywordTriggers: ['bot', '机器人'],
  keywordReactions: [{ keywords: ['早'], reaction: '打招呼要短' }],
  primaryGroup: GROUP,
  talkValue: 0.6,
  primaryTalkValue: null,
}

test('core/trigger：私聊永远算叫我；群里要 @ 或关键词', () => {
  const dm = groupEvent({ message_type: 'private', user_id: MASTER })
  assert.equal(isCalled(dm, parseInbound(dm), TRIGGER), true)

  const plain = groupEvent()
  assert.equal(isCalled(plain, parseInbound(plain), TRIGGER), false)

  const at = groupEvent({ message: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: '在吗' } }] })
  assert.equal(isCalled(at, parseInbound(at), TRIGGER), true)

  const kw = groupEvent({ message: [{ type: 'text', data: { text: 'bot在吗' } }] })
  assert.equal(isCalled(kw, parseInbound(kw), TRIGGER), true)
})

test('core/trigger：@ 别人不算叫我；判据用的是显示渲染（所以占位符能命中）', () => {
  const other = groupEvent({ message: [{ type: 'at', data: { qq: '12345' } }, { type: 'text', data: { text: '你在吗' } }] })
  assert.equal(isCalled(other, parseInbound(other), TRIGGER), false)
  const image = groupEvent({ message: [{ type: 'image', data: { file: 'x' } }] })
  assert.equal(isCalled(image, parseInbound(image), { ...TRIGGER, keywordTriggers: ['发图'] }), false)
  assert.equal(isCalled(image, parseInbound(image), { ...TRIGGER, keywordTriggers: ['[图片]'] }), true)
})

test('core/trigger：概率与语气提示', () => {
  assert.equal(talkChanceOf(TRIGGER, { isGroup: true, chatId: GROUP }), 0.6, '主群没单独设就是同一个值')
  assert.equal(talkChanceOf(TRIGGER, { isGroup: true, chatId: 1 }), 0.6)
  assert.equal(
    talkChanceOf({ ...TRIGGER, primaryTalkValue: 0.9 }, { isGroup: true, chatId: GROUP }),
    0.9,
    '主群单独设了就用它',
  )
  assert.equal(
    talkChanceOf({ ...TRIGGER, primaryTalkValue: 0.9 }, { isGroup: false, chatId: GROUP }),
    0.6,
    '私聊不吃主群概率',
  )
  const early = groupEvent({ message: [{ type: 'text', data: { text: '早上好' } }] })
  assert.equal(reactionHintOf(TRIGGER, early), '打招呼要短')
  assert.equal(reactionHintOf(TRIGGER, groupEvent()), null)
})

// ── batching ────────────────────────────────────────────────────────────────

const LIMITS = { maxMessages: 20, maxChars: 100 }

test('core/batching：条数或字数任一触顶就算满', () => {
  assert.equal(queueChars(['ab', 'cde']), 5)
  assert.equal(isBatchFull(['a', 'b'], LIMITS), false)
  assert.equal(isBatchFull(['x'.repeat(100)], LIMITS), true, '字数触顶')
  assert.equal(isBatchFull(Array.from({ length: 20 }, () => 'a'), LIMITS), true, '条数触顶')
})

const BASE_FLUSH = {
  lines: 3,
  images: 0,
  busy: false,
  immediate: false,
  nowMs: 1000,
  backoffUntilMs: 0,
  chance: 1,
  roll: () => 0,
}

test('core/batching：四种裁决', () => {
  assert.equal(decideFlush({ ...BASE_FLUSH, lines: 0 }).kind, 'empty')
  assert.deepEqual(decideFlush({ ...BASE_FLUSH, busy: true }), { kind: 'defer', why: 'busy' })
  assert.deepEqual(decideFlush({ ...BASE_FLUSH, backoffUntilMs: 2000 }), { kind: 'defer', why: 'backoff' })
  assert.deepEqual(decideFlush({ ...BASE_FLUSH, chance: 0.5, roll: () => 0.9 }), { kind: 'drop', lines: 3 })
  assert.equal(decideFlush({ ...BASE_FLUSH, chance: 0.5, roll: () => 0.1 }).kind, 'flush')
})

test('core/batching：被叫到时既不掷骰子也不看退避（随机流不被消耗）', () => {
  let rolled = 0
  const decision = decideFlush({
    ...BASE_FLUSH,
    busy: true,
    immediate: true,
    chance: 0,
    backoffUntilMs: 10 ** 12,
    roll: () => { rolled += 1; return 0.99 },
  })
  assert.equal(decision.kind, 'flush', 'immediate 跳过忙、退避与概率')
  assert.equal(rolled, 0, '一次都没掷——提前求值会凭空消耗随机流')
  assert.deepEqual(decideFlush({ ...BASE_FLUSH, busy: true }), { kind: 'defer', why: 'busy' }, '同样的输入非 immediate 则重新排期')
})

// ── retry-policy ────────────────────────────────────────────────────────────

test('core/retry-policy：退避是 30s 起、翻倍、封顶 3 分钟', () => {
  const mid = (attempt: number): number => gatewayBackoffMs(attempt, () => 0.5)
  assert.equal(mid(1), 30_000)
  assert.equal(mid(2), 60_000)
  assert.equal(mid(3), 120_000)
  assert.equal(mid(4), 180_000, '翻倍到 180s 就到顶')
  assert.equal(mid(8), 180_000, '封顶之后不再涨')
  assert.equal(gatewayBackoffMs(1, () => 0), 24_000, '下抖动 -20%')
  assert.equal(gatewayBackoffMs(1, () => 1), 36_000, '上抖动 +20%（roll 的定义域是 [0,1)，这里取上界）')
  assert.equal(GATEWAY_RETRY_MAX, 8)
})

test('core/retry-policy：失败分类', () => {
  const fresh = { hadImages: false, textOnlyRetryDone: false }
  assert.deepEqual(classifyFailure('{"code":"RATE_LIMIT"}', fresh), { kind: 'retry' })
  assert.deepEqual(classifyFailure('{"code":"TIMEOUT"}', fresh), { kind: 'retry' })
  assert.deepEqual(classifyFailure('{"name":"SessionFormatError"}', fresh), { kind: 'permanent' })
  assert.deepEqual(
    classifyFailure('{"code":"INVALID_REQUEST"}', { hadImages: true, textOnlyRetryDone: false }),
    { kind: 'retry-text-only' },
    '带图被整个拒了：正文还在，改发纯文本',
  )
  assert.deepEqual(
    classifyFailure('{"code":"INVALID_REQUEST"}', { hadImages: true, textOnlyRetryDone: true }),
    { kind: 'permanent' },
    '纯文本也试过了，不再重试',
  )
  assert.deepEqual(
    classifyFailure('{"code":"SERVER"}', { hadImages: false, textOnlyRetryDone: false }),
    { kind: 'retry' },
    'SERVER 本身就是可重试码',
  )
})

// ── render ──────────────────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-10-16T15:04:05+08:00')

test('core/message/render：完整的一行（身份、编号、引用、@ 列表）', () => {
  const event = groupEvent({
    sender: { user_id: 999, nickname: '小明', card: '明哥', role: 'owner', title: '话痨' },
    message: [
      { type: 'text', data: { text: '在吗' } },
      { type: 'at', data: { qq: String(SELF) } },
      { type: 'at', data: { qq: '12345' } },
    ],
  })
  const line = renderMessageLine({
    event,
    parsed: parseInbound(event),
    called: true,
    quoted: '[引用 小红(777）：刚才那个] ',
    voiceText: null,
    receivedFiles: [],
    reactionHint: null,
    nowMs: NOW_MS,
  })
  assert.equal(
    line,
    // 10-30 起：跨天/隔很久再聊时把 HH:MM 扩成**完整日期**（src/core/message/render.ts:15）
      '[引用 小红(777）：刚才那个] 2026-10-16 14:31 明哥(999)[群主][头衔:话痨] #4242 [@我]：在吗[@了 #12345（含我）]',
  )
})

test('core/message/render：没有可说的内容返回 null；带图无文字用 [图片] 兜底', () => {
  const at = groupEvent({ message: [{ type: 'at', data: { qq: String(SELF) } }] })
  assert.equal(renderMessageLine({ event: at, parsed: parseInbound(at), called: true, quoted: null, nowMs: NOW_MS }), null)
  // 带 url 才算「有图」：没有 url 的图片段既没有正文也没有可下载的东西，整行作废。
  const image = groupEvent({ message: [{ type: 'image', data: { file: 'x', url: 'https://x/y.png' } }] })
  assert.equal(
    renderMessageLine({ event: image, parsed: parseInbound(image), called: false, quoted: null, nowMs: NOW_MS }),
      '2026-10-16 14:31 小明(999) #4242：[图片]',
  )
})

test('core/message/render：语气提示只在被叫到时出现', () => {
  const event = groupEvent()
  const parsed = parseInbound(event)
  const base = { event, parsed, quoted: null, reactionHint: '打招呼要短', nowMs: NOW_MS }
  assert.equal(renderMessageLine({ ...base, called: true })?.endsWith('（语气提示：打招呼要短）'), true)
  assert.equal(renderMessageLine({ ...base, called: false })?.includes('语气提示'), false, '没被叫到时不许带语气提示')
})

test('core/message/render：event.time 缺失时用注入的 nowMs 兜底', () => {
  const event = groupEvent({ time: 0 })
  const line = renderMessageLine({ event, parsed: parseInbound(event), called: false, quoted: null, nowMs: NOW_MS })
  // 10-30 起时间扩成完整日期（src/core/message/render.ts:15）：断言「完整日期 + 时分」，不钉死具体日期。
  assert.match(line ?? '', /^\d{4}-\d{2}-\d{2} 15:04 /)
})

// ── schedule ────────────────────────────────────────────────────────────────

test('core/schedule：时段分档与本地日期键', () => {
  const at = (h: number): string => timeContext(new Date(`2026-10-16T${String(h).padStart(2, '0')}:30:00+08:00`)).period
  assert.equal(at(0), '深夜')
  assert.equal(at(6), '清晨')
  assert.equal(at(9), '上午')
  assert.equal(at(12), '中午')
  assert.equal(at(15), '下午')
  assert.equal(at(18), '傍晚')
  assert.equal(at(21), '晚上')
  assert.equal(at(23), '深夜')
  assert.equal(localDayKey(new Date('2026-10-16T00:04:00+08:00')), '2026-10-16')
  assert.equal(
    localDayKey(new Date('2026-10-16T00:04:00+08:00')),
    localDayKey(new Date('2026-10-16T23:59:00+08:00')),
    '同一天的凌晨与深夜必须是同一个键（否则「一天只做一次」会做两遍）',
  )
})
