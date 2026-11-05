/** 渠道健康告警（PR #4）：探针必须真的问链路、告警/恢复/限频、开关。
 *
 * 重点回归：`isConnected()` 为真但 `get_status` 失败（2026-10-19 的真实故障）
 * 时必须告警——不能因为 WS readyState 是 OPEN 就跳过探针。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { ChannelHealthMonitor } = await import('../src/features/channel-health/index.js')

function harness(opts: { enabled?: boolean; status?: () => Promise<unknown> } = {}) {
  let now = 1_000_000
  const sent: string[] = []
  const logs: string[] = []
  const monitor = new ChannelHealthMonitor({
    client: { isConnected: () => true } as never,
    api: {
      getStatus: opts.status ?? (async () => ({ online: true, good: true })),
      sendPrivateMessage: async (_id: number, message: Array<{ data: { text: string } }>) => {
        sent.push(message[0]!.data.text)
        return { message_id: sent.length }
      },
    } as never,
    out: { push: async (task: () => Promise<unknown>) => await task() } as never,
    enabled: () => opts.enabled !== false,
    admins: () => [280],
    log: (line) => logs.push(line),
    thresholdMs: 60_000,
    realertMs: 300_000,
    now: () => now,
  })
  return {
    monitor,
    sent,
    logs,
    advance(ms: number) { now += ms },
  }
}

test('渠道健康：WS 连着但 get_status 失败 → 仍然告警', async () => {
  const h = harness({ status: async () => { throw new Error('link dead') } })
  h.monitor.start()
  h.monitor.dispose()
  h.advance(61_000)
  await h.monitor.tick()
  assert.equal(h.monitor.isAlerting(), true)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0] ?? '', /通道告警/)
})

test('渠道健康：同场故障限频；恢复后再报一句并解除', async () => {
  let ok = false
  const h = harness({ status: async () => {
    if (!ok) throw new Error('down')
    return { online: true, good: true }
  } })
  h.monitor.start()
  h.monitor.dispose()
  h.advance(61_000)
  await h.monitor.tick()
  assert.equal(h.sent.length, 1)
  h.advance(100_000)
  await h.monitor.tick()
  assert.equal(h.sent.length, 1, '限频期内不重复')
  h.advance(300_000)
  await h.monitor.tick()
  assert.equal(h.sent.length, 2, '超过 realert 再报一次')
  ok = true
  h.advance(61_000)
  await h.monitor.tick()
  assert.equal(h.monitor.isAlerting(), false)
  assert.equal(h.sent.length, 3)
  assert.match(h.sent.at(-1) ?? '', /恢复/)
})

test('渠道健康：开关关着 → 不探、不发', async () => {
  const h = harness({ enabled: false, status: async () => { throw new Error('down') } })
  h.advance(600_000)
  await h.monitor.tick()
  assert.equal(h.sent.length, 0)
  assert.equal(h.monitor.isAlerting(), false)
})

test('渠道健康：入站消息到达即视为恢复', async () => {
  const h = harness({ status: async () => { throw new Error('down') } })
  h.monitor.start()
  h.monitor.dispose()
  h.advance(61_000)
  await h.monitor.tick()
  assert.equal(h.monitor.isAlerting(), true)
  h.monitor.onInbound()
  assert.equal(h.monitor.isAlerting(), false)
  assert.match(h.sent.at(-1) ?? '', /恢复/)
})
