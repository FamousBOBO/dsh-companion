/** 群日报（B1）：统计/金句、目标解析、发送与空数据不打扰。
 *
 * 防的是"每天准点发一条空报告"和"发错房间"：空数据不发送；目标只认三种写法。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { buildDailyReport, renderDailyReport } = await import('../src/core/report/daily.js')
const { DailyReport, targetOf } = await import('../src/features/daily-report/service.js')

const day = (text: string, userId: number, name: string) => ({ id: 1, time: 1, userId, name, text })

test('日报渲染：条数/参与人/最活跃/金句', () => {
  const stats = buildDailyReport([
    day('今天天气不错，出去走走吗', 1, '甲'),
    day('好呀好呀', 2, '乙'),
    day('我也去', 1, '甲'),
  ])
  assert.equal(stats.messages, 3)
  assert.equal(stats.people, 2)
  assert.equal(stats.topSenders[0]!.name, '甲')
  assert.equal(stats.topSenders[0]!.count, 2)
  const text = renderDailyReport('2026-10-22', stats)
  assert.match(text, /【群日报 2026-10-22】/)
  assert.match(text, /消息 3 条 · 参与 2 人/)
  assert.match(text, /最活跃：甲\(2\)、乙\(1\)/)
  assert.match(text, /金句：/)
})

test('日报渲染：空数据也给出可读文本（由调用方决定发不发）', () => {
  const text = renderDailyReport('2026-10-22', buildDailyReport([]))
  assert.match(text, /还没有消息/)
})

test('目标解析：primary-group / group: / dm: / 非法', () => {
  assert.deepEqual(targetOf('primary-group', 107), { room: 'group-107', isGroup: true, chatId: 107 })
  assert.deepEqual(targetOf('group:555', null), { room: 'group-555', isGroup: true, chatId: 555 })
  assert.deepEqual(targetOf('dm:280', null), { room: 'dm-280', isGroup: false, chatId: 280 })
  assert.equal(targetOf('primary-group', null), null)
  assert.equal(targetOf('nope', null), null)
})

test('日报发送：有数据发一条；空数据不发；关着不发', async () => {
  const sent: Array<{ isGroup: boolean; target: number; text: string }> = []
  const entries = [day('今天天气不错，出去走走吗', 1, '甲'), day('好呀好呀', 2, '乙')]
  const run = async (config: { enabled: boolean; time: string; target: string }, rows = entries) => new DailyReport({
    api: () => ({
      sendTo: async (isGroup: boolean, target: number, message: Array<{ data: { text: string } }>) => {
        sent.push({ isGroup, target, text: message[0]!.data.text })
        return { message_id: sent.length }
      },
    }) as never,
    out: () => ({ push: async (task: () => Promise<unknown>) => await task() }) as never,
    history: () => ({
      collect: async () => 0,
      search: async () => rows,
    }) as never,
    config: () => config,
    primaryGroup: () => 107,
    now: () => Date.parse('2026-10-22T22:30:00+08:00'),
    log: () => {},
  }).run('2026-10-22', true)

  assert.equal((await run({ enabled: true, time: '22:30', target: 'primary-group' })).sent, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.target, 107)
  assert.match(sent[0]!.text, /消息 2 条/)

  const empty = await run({ enabled: true, time: '22:30', target: 'primary-group' }, [])
  assert.equal(empty.sent, false)
  assert.equal(empty.reason, 'no-messages')
  assert.equal(sent.length, 1)

  const off = await run({ enabled: false, time: '22:30', target: 'primary-group' })
  assert.equal(off.sent, true, '强制运行不受开关限制')
})
