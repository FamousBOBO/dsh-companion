/** 回合告知（A2）：慢回合只说一次、结束即撤、永久失败才告知。
 *
 * 防的是"提示反过来打扰"：重试还在跑时不能报失败；回合结束必须撤掉计时器；
 * 开关关着时一条消息都不发。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { Reliability } = await import('../src/features/reliability/service.js')

function harness(config = { slowNotice: false, slowAfterMs: 10, failureNotice: false }) {
  const sent: Array<{ isGroup: boolean; target: number; text: string }> = []
  const logs: string[] = []
  let now = 1_000_000
  const service = new Reliability({
    api: () => ({
      sendTo: async (isGroup: boolean, target: number, message: Array<{ data: { text: string } }>) => {
        sent.push({ isGroup, target, text: message[0]!.data.text })
        return { message_id: sent.length }
      },
    }) as never,
    out: () => ({ push: async (task: () => Promise<unknown>) => await task() }) as never,
    config: () => config,
    persona: () => ({ render: (key: string) => `[${key}]` }) as never,
    log: (line) => logs.push(line),
    now: () => now,
  })
  return { service, sent, logs, advance(ms: number) { now += ms } }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('回合告知：慢回合到点发一句，且只发一次', async () => {
  const h = harness({ slowNotice: true, slowAfterMs: 10, failureNotice: false })
  h.service.begin('group-107')
  await wait(25)
  assert.deepEqual(h.sent.map((s) => s.text), ['[notice/slow-turn]'])
  assert.deepEqual(h.sent[0]!.target, 107)
  h.service.end('group-107')
})

test('回合告知：回合先结束 → 计时器撤销，一句话都不发', async () => {
  const h = harness({ slowNotice: true, slowAfterMs: 20, failureNotice: false })
  h.service.begin('dm-280')
  h.service.end('dm-280')
  await wait(35)
  assert.equal(h.sent.length, 0)
})

test('回合告知：永久失败在结束时说一声；重试中不说', async () => {
  const h = harness({ slowNotice: false, slowAfterMs: 10, failureNotice: true })
  h.service.begin('dm-280')
  h.service.error('dm-280', 'retry')
  h.service.end('dm-280')
  assert.equal(h.sent.length, 0, '重试还在跑，不报失败')

  h.service.begin('dm-280')
  h.service.error('dm-280', 'permanent')
  h.service.end('dm-280')
  assert.deepEqual(h.sent.map((s) => s.text), ['[notice/turn-failed]'])
})

test('回合告知：开关关着 → 一条都不发', async () => {
  const h = harness({ slowNotice: false, slowAfterMs: 10, failureNotice: false })
  h.service.begin('group-107')
  h.service.error('group-107', 'permanent')
  h.service.end('group-107')
  await wait(20)
  assert.equal(h.sent.length, 0)
})


test('回合告知：主动/定时回合失败不发告知（没有用户回合开始）', () => {
  const h = harness({ slowNotice: false, slowAfterMs: 10, failureNotice: true })
  h.service.error('group-107', 'permanent')
  h.service.end('group-107')
  assert.equal(h.sent.length, 0)
})

test('回合告知：同一房间 10 分钟内只报一次「没处理完」', () => {
  const h = harness({ slowNotice: false, slowAfterMs: 10, failureNotice: true })
  h.service.begin('group-107')
  h.service.error('group-107', 'permanent')
  h.service.end('group-107')
  assert.equal(h.sent.length, 1)
  h.service.begin('group-107')
  h.service.error('group-107', 'permanent')
  h.service.end('group-107')
  assert.equal(h.sent.length, 1, '冷却期内不重复')
  h.advance(10 * 60_000)
  h.service.begin('group-107')
  h.service.error('group-107', 'permanent')
  h.service.end('group-107')
  assert.equal(h.sent.length, 2)
})
