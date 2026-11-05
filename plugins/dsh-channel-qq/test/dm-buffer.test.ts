import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DmBuffer } from '../src/app/inbound/dm-buffer.js'

function harness() {
  let now = 0; let busy = false
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  const submitted: Array<{ packet: string; images: unknown[] }> = []
  const conv = { key: 'dm-1', queue: [] as string[], pendingImages: [] as unknown[], batchTimer: null,
    seenMessageIds: null, lastEvent: {}, tracker: { running: () => busy, busy: () => busy } }
  const cfg = { dmShortMs: 6000, dmLongMs: 1500, dmLongChars: 80, dmMaxWaitMs: 15000 }
  const buffer = new DmBuffer({
    config: () => ({ batching: cfg, imageRecognition: { maxPerMessage: 2 }, injectMode: { enabled: false } }),
    clock: { now: () => now, setTimeout: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn, cancelled: false }; timers.push(timer)
      return { cancel: () => { timer.cancelled = true } }
    } },
    packets: { composeDm: async (_c: unknown, input: { line: string }) => input.line },
    turns: { submit: (_c: unknown, packet: string, images: unknown[]) => submitted.push({ packet, images }) },
    log: () => {},
  } as never)
  return { buffer, conv, submitted, setBusy: (value: boolean) => { busy = value },
    add(text: string, id: number, images: unknown[] = []) {
      const event = { message_id: id, user_id: 1, message_type: 'private' }
      if (buffer.accept(conv as never, event as never)) buffer.enqueue(conv as never, text, images, text.length)
    },
    async advance(ms: number) {
      const end = now + ms
      while (true) {
        const timer = timers.filter(t => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!timer) break
        now = timer.at; timer.cancelled = true; timer.fn()
        for (let i = 0; i < 8; i++) await Promise.resolve()
      }
      now = end
    },
  }
}
test('short follow-on messages merge once, duplicate event is ignored, images preserved', async () => {
  const h = harness(); h.add('在吗', 1, ['image']); await h.advance(2000)
  h.add('想跟你说件事', 2); h.add('想跟你说件事', 2)
  await h.advance(5600); assert.equal(h.submitted.length, 0)
  await h.advance(1000)
  assert.deepEqual(h.submitted, [{ packet: '在吗\n想跟你说件事', images: ['image'] }])
})
test('long sentence waits only 1.5 seconds', async () => {
  const h = harness(); h.add('长'.repeat(80), 1)
  await h.advance(1499); assert.equal(h.submitted.length, 0)
  await h.advance(1); assert.equal(h.submitted.length, 1)
})
test('continuous short messages cannot extend merge window past 15 seconds', async () => {
  const h = harness()
  for (let id = 1; id <= 4; id++) { h.add('短句', id); await h.advance(4000) }
  assert.equal(h.submitted.length, 1)
  assert.equal(h.submitted[0]!.packet.split('\n').length, 4)
})
test('busy previous turn retains all pending content until idle', async () => {
  const h = harness(); h.setBusy(true); h.add('长'.repeat(80), 1)
  await h.advance(20000); assert.equal(h.submitted.length, 0)
  h.add('补充', 2); h.setBusy(false); await h.advance(500)
  assert.equal(h.submitted.length, 1)
  assert.match(h.submitted[0]!.packet, /补充/)
})
