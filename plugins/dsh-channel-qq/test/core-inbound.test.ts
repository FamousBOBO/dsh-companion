/** 入站侧新抽出来的纯逻辑：上下文预算、图片类型、通知文案。
 *
 * 这三段原是 `bridge.ts` 里的内联代码或私有方法——没有直接测试，只能端到端撞。
 * 搬进 `core/` 之后逐条测一遍；它们各自都有一个"看着像小事、错了很难查"的点。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { compactContext } = await import('../src/core/text/budget.js')
const { sniffMediaType, extensionOf } = await import('../src/core/message/media.js')
const { noticeKind, describeNotice } = await import('../src/core/message/notice.js')
type OneBotEvent = import('../src/types.js').OneBotEvent

// ── 上下文预算 ──────────────────────────────────────────────────────────────

test('compactContext：没超预算就一个字不动', () => {
  const text = 'a\nbb\nccc'
  assert.deepEqual(compactContext(text, 0), { text, dropped: 0 }, '0 = 不限')
  assert.deepEqual(compactContext(text, 100), { text, dropped: 0 })
})

test('compactContext：超预算时丢最老的行、保留最新的', () => {
  const lines = ['一', '二', '三', '四', '五']
  const result = compactContext(lines.join('\n'), 5)
  assert.equal(result.text, '四\n五', '保留最新的两行（每行 + 换行 = 2 字符）')
  assert.equal(result.dropped, 3)
})

test('compactContext：预算再小也至少留一行', () => {
  const result = compactContext('很长的一行\n短的', 1)
  assert.equal(result.text, '短的', '丢空整包比超预算更糟')
  assert.equal(result.dropped, 1)
})

// ── 图片类型 ────────────────────────────────────────────────────────────────

test('sniffMediaType：按魔数判断，认不出来按 jpeg', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  assert.equal(sniffMediaType(png), 'image/png')
  assert.equal(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  // 判据是 `length > 6`，所以正好 6 字节的头**认不出来**（原实现如此，原样保留）。
  assert.equal(sniffMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/jpeg')
  assert.equal(sniffMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00])), 'image/gif')
  const webp = new Uint8Array(16)
  webp[0] = 0x52; webp[8] = 0x57; webp[9] = 0x45
  assert.equal(sniffMediaType(webp), 'image/webp')
  assert.equal(sniffMediaType(new Uint8Array([1, 2, 3])), 'image/jpeg', '认不出来按 jpeg（原行为）')
})

test('extensionOf：从媒体类型取后缀', () => {
  assert.equal(extensionOf('image/png'), 'png')
  assert.equal(extensionOf('image/jpeg'), 'jpeg')
})

// ── 通知文案 ────────────────────────────────────────────────────────────────

const notice = (fields: Partial<OneBotEvent>): OneBotEvent =>
  ({ time: 0, self_id: 1, post_type: 'notice', ...fields }) as OneBotEvent

test('noticeKind：认得的通知类型，认不出来返回 null', () => {
  assert.equal(noticeKind(notice({ notice_type: 'notify', sub_type: 'poke' })), 'poke')
  assert.equal(noticeKind(notice({ notice_type: 'notify', sub_type: 'honor' })), 'group_honor')
  assert.equal(noticeKind(notice({ notice_type: 'notify', sub_type: 'something' })), null)
  assert.equal(noticeKind(notice({ notice_type: 'group_increase' })), 'group_increase')
  assert.equal(noticeKind(notice({ notice_type: 'group_recall' })), 'group_recall')
  assert.equal(noticeKind(notice({ notice_type: 'lucky_king' })), null, '不认识的不许猜')
})

test('describeNotice：几种典型事件的中文行', () => {
  const line = (fields: Partial<OneBotEvent>): string | null =>
    describeNotice(notice(fields), noticeKind(notice(fields)) ?? '')

  assert.equal(line({ notice_type: 'group_increase', user_id: 7 }), 'QQ7 进群了')
  assert.equal(line({ notice_type: 'group_increase', user_id: 7, operator_id: 8 }), 'QQ7 被 QQ8 拉进群了')
  assert.equal(line({ notice_type: 'group_decrease', user_id: 7, sub_type: 'kick_me' }), '咱自己被踢出群了')
  assert.equal(line({ notice_type: 'group_decrease', user_id: 7, sub_type: 'leave' }), 'QQ7 退群了')
  assert.equal(line({ notice_type: 'group_ban', user_id: 0, duration: 300 }), '全员禁言开启了（300 秒）')
  assert.equal(line({ notice_type: 'group_ban', user_id: 7, duration: 60 }), 'QQ7 被禁言 60 秒')
  assert.equal(line({ notice_type: 'group_admin', user_id: 7, sub_type: 'set' }), 'QQ7 成了管理员')
  assert.equal(line({ notice_type: 'group_card', user_id: 7, card_new: '新名', card_old: '旧名' }), 'QQ7 的群名片改成了「新名」（原来是「旧名」）')
  // 荣誉走的是 `notify` 家族（`notice_type: 'notify'` + `sub_type: 'honor'`）。
  assert.equal(
    line({ notice_type: 'notify', sub_type: 'honor', user_id: 7, honor_type: 'talkative' }),
    '群荣誉：QQ7 拿到了 talkative',
  )
})

test('describeNotice：撤回代操作与无用户的荣誉', () => {
  assert.equal(
    describeNotice(notice({ notice_type: 'group_recall', user_id: 7, operator_id: 8 }), 'group_recall'),
    'QQ7 撤回了一条消息（QQ8 代撤回）',
  )
  assert.equal(
    describeNotice(notice({ notice_type: 'group_recall', user_id: 7, operator_id: 7 }), 'group_recall'),
    'QQ7 撤回了一条消息',
    '自己撤回自己不带括号',
  )
})
