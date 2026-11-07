/** 语音条发送：成功回执 / 超时即回执未知（且只 push 一次）/ 抛错不重试。
 *
 * 全程离线：假 `QQApi` + 假 `OutboundQueue`，文件只用临时目录里的小 mp3
 * （`napcatFileArg` 会把它内联成 `base64://`，不依赖任何 NapCat 配置）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { OutboundQueue } from '../src/outbound.js'
import type { OneBotMessage } from '../src/types.js'
import type { QQApi, SendResult } from '../src/ports/platform.js'

const { createVoicePort } = await import('../src/adapters/song/voice.js')

const ROOM = 'dm-10001'
const CHAT = 10001

/** 假出站链：记录每次 `push`（"到底有没有重复入队"的唯一事实来源）。 */
function fakeOut(impl: (task: () => Promise<unknown>) => Promise<unknown>) {
  const pushes: Array<() => Promise<unknown>> = []
  const out = {
    async push<T>(task: () => Promise<T>): Promise<T> {
      pushes.push(task)
      return await impl(task) as T
    },
  }
  return { out: out as unknown as OutboundQueue, pushes }
}

/** 假 QQApi：只实现私聊发送，其余方法用 Proxy 兜底（这里不该被调用到）。 */
function fakeApi(send: (userId: number, message: OneBotMessage) => Promise<SendResult>) {
  const sent: Array<{ userId: number; message: OneBotMessage }> = []
  const api = new Proxy({} as QQApi, {
    get(_target, prop): unknown {
      if (prop === 'sendPrivateMessage') {
        return async (userId: number, message: OneBotMessage): Promise<SendResult> => {
          sent.push({ userId, message })
          return await send(userId, message)
        }
      }
      throw new Error(`测试里的假 QQApi 不该调用 ${String(prop)}`)
    },
  })
  return { api, sent }
}

function scratch(): { dir: string; voice: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'song-voice-'))
  const voice = path.join(dir, 'voice.mp3')
  writeFileSync(voice, Buffer.alloc(64 * 1024, 3))
  return { dir, voice, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('成功回执：ok + message_id，且只 push 一次、发到私聊', async () => {
  const s = scratch()
  try {
    const { out, pushes } = fakeOut(async (task) => await task())
    const { api, sent } = fakeApi(async () => ({ message_id: 8123 }))
    const logs: string[] = []
    const port = createVoicePort({ api, out, log: (line) => logs.push(line), timeoutMs: 50 })

    const result = await port.sendVoice(ROOM, CHAT, s.voice)

    assert.deepEqual(result, { ok: true, messageId: 8123, unknown: false, detail: '' })
    assert.equal(pushes.length, 1, '只允许入队一次')
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.userId, CHAT)
    const message = sent[0]!.message as Array<{ type: string; data: { file: string } }>
    assert.equal(message[0]!.type, 'record')
    assert.match(message[0]!.data.file, /^base64:\/\//, '小文件走内联，不依赖 NapCat 能读路径')
    // 日志只写 room 与结果，不写文件内容（base64 那串）也不写凭据。
    assert.equal(logs.some((line) => line.includes('base64://')), false)
    assert.ok(logs.every((line) => !line.includes(s.dir)), `日志不该带临时目录：${logs.join(' | ')}`)
    assert.ok(logs.some((line) => line.includes(ROOM)))
  } finally { s.cleanup() }
})

test('超时：unknown=true、messageId=null，且 push 只被调用一次（不许重发）', async () => {
  const s = scratch()
  try {
    // 任务真的进队并真的调用了平台，但回执永远不来：
    // 这正是"消息可能已经到对方手机上了"的那种情况。
    const { out, pushes } = fakeOut(async (task) => await task())
    const { api, sent } = fakeApi(async () => await new Promise<SendResult>(() => {}))
    const logs: string[] = []
    const port = createVoicePort({ api, out, log: (line) => logs.push(line), timeoutMs: 40 })

    const result = await port.sendVoice(ROOM, CHAT, s.voice)

    assert.equal(result.ok, false)
    assert.equal(result.unknown, true, '超时只能是回执未知，不能是确定失败')
    assert.equal(result.messageId, null)
    assert.match(result.detail, /回执未知：超过 40ms/)
    assert.equal(pushes.length, 1, '超时后**不许**再 push 一次')
    assert.equal(sent.length, 1, '底层发送已经进过一次，没有第二次')
    assert.ok(logs.some((line) => line.includes('unknown')))
  } finally { s.cleanup() }
})

test('平台抛错：ok=false、unknown=false，不重试', async () => {
  const s = scratch()
  try {
    const { out, pushes } = fakeOut(async (task) => await task())
    const { api, sent } = fakeApi(async () => { throw new Error('QQ API failed: retcode=100') })
    const logs: string[] = []
    const port = createVoicePort({ api, out, log: (line) => logs.push(line), timeoutMs: 50 })

    const result = await port.sendVoice(ROOM, CHAT, s.voice)

    assert.equal(result.ok, false)
    assert.equal(result.unknown, false, '明确报错是确定失败，消息没出去')
    assert.equal(result.messageId, null)
    assert.match(result.detail, /发送失败：QQ API failed: retcode=100/)
    assert.equal(pushes.length, 1, '明确失败也不重试')
    assert.equal(sent.length, 1)
  } finally { s.cleanup() }
})

test('平台回了结果但没有 message_id：按回执未知处理（不能说"失败"再发一次）', async () => {
  const s = scratch()
  try {
    const { out, pushes } = fakeOut(async (task) => await task())
    const { api } = fakeApi(async () => ({}))
    const port = createVoicePort({ api, out, log: () => {}, timeoutMs: 50 })

    const result = await port.sendVoice(ROOM, CHAT, s.voice)

    assert.equal(result.ok, false)
    assert.equal(result.unknown, true)
    assert.match(result.detail, /没有返回 message_id/)
    assert.equal(pushes.length, 1)
  } finally { s.cleanup() }
})

test('文件读不到：确定失败，而且一次都不入队', async () => {
  const s = scratch()
  try {
    const { out, pushes } = fakeOut(async (task) => await task())
    const { api, sent } = fakeApi(async () => ({ message_id: 1 }))
    const logs: string[] = []
    const port = createVoicePort({ api, out, log: (line) => logs.push(line), timeoutMs: 50 })

    const result = await port.sendVoice(ROOM, CHAT, path.join(s.dir, 'missing.mp3'))

    assert.equal(result.ok, false)
    assert.equal(result.unknown, false)
    assert.match(result.detail, /语音文件不可用/)
    assert.equal(pushes.length, 0, '文件都没读到，不该进出站队列')
    assert.equal(sent.length, 0)
  } finally { s.cleanup() }
})

test('超时之后底层才失败：不能变成"未处理的拒绝"（那条会让进程直接死）', async () => {
  const s = scratch()
  try {
    // 平台的拒绝落在超时**之后**。如果竞速那一侧没有给 promise 挂 handler，
    // 这里就是一条 unhandledRejection —— 对"点歌"这个后台任务来说等于进程被打死。
    const late: { reject: ((error: unknown) => void) | null } = { reject: null }
    const { out, pushes } = fakeOut(async (task) => await task())
    const { api } = fakeApi(() => new Promise<SendResult>((_resolve, reject) => { late.reject = reject }))
    const port = createVoicePort({ api, out, log: () => {}, timeoutMs: 30 })

    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const result = await port.sendVoice(ROOM, CHAT, s.voice)
      assert.equal(result.unknown, true, '先到的是超时')
      late.reject?.(new Error('晚到的 retcode=100'))
      // 给那条拒绝一次被观察到的机会。
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      assert.deepEqual(unhandled, [], '晚到的失败不许变成未处理的拒绝')
      assert.equal(pushes.length, 1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  } finally { s.cleanup() }
})

test('真实体量的语音条（25 s ≈ 400 KB）也能内联发出：不撞 8 MiB 上限、不撞可读根', async () => {
  const s = scratch()
  try {
    // 与真实产物同量级：本机自测的 25 s / 44.1 kHz / 立体声 mp3 是 401 075 字节。
    // 它大于 `ALWAYS_INLINE_BYTES`（256 KiB），所以走的是"可读根里就 file://，
    // 否则 base64"那条分支；临时目录不在任何可读根里 → base64，约 535 KB。
    writeFileSync(s.voice, Buffer.alloc(401_075, 5))
    const { out, pushes } = fakeOut(async (task) => await task())
    const { api, sent } = fakeApi(async () => ({ message_id: 9001 }))
    const port = createVoicePort({ api, out, log: () => {}, timeoutMs: 50 })

    const result = await port.sendVoice(ROOM, CHAT, s.voice)

    assert.equal(result.ok, true)
    const message = sent[0]!.message as Array<{ type: string; data: { file: string } }>
    const arg = message[0]!.data.file
    assert.match(arg, /^base64:\/\//)
    assert.ok(arg.length > 500_000 && arg.length < 600_000, `base64 长度不符（${String(arg.length)}）`)
    assert.equal(pushes.length, 1)
  } finally { s.cleanup() }
})

test('默认超时 30 s：不传 timeoutMs 时登记的等待上限就是 30000ms', async () => {
  // 为什么**不用**假时钟：`sendVoice` 先做一次真实文件读取（`napcatFileArg`），
  // 那个 I/O 不受假时钟管，于是"定时器什么时候被注册"就不确定了——早先那版靠
  // `setImmediate` 轮询等到"入队"，在机器忙的时候会等不到（实测偶发一次）。
  // 这里的做法更直接：把 `setTimeout` 包一层录制器，断言**被登记的毫秒数**。
  // 平台侧秒回一个回执，于是 `raceOutcome` 的 `finally` 会把那个 30 s 定时器清掉，
  // 测试不会真的等 30 秒。
  const s = scratch()
  try {
    const original = globalThis.setTimeout
    const delays: number[] = []
    const spy = (fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): unknown => {
      if (typeof ms === 'number') delays.push(ms)
      return original(fn, ms, ...rest)
    }
    globalThis.setTimeout = spy as unknown as typeof setTimeout
    try {
      const { out, pushes } = fakeOut(async (task) => await task())
      const { api } = fakeApi(async () => ({ message_id: 42 }))
      const port = createVoicePort({ api, out, log: () => {} })

      const result = await port.sendVoice(ROOM, CHAT, s.voice)

      // 只有一条等待：`voice.ts` 不给别的用途起定时器（没有重试、没有退避）。
      assert.equal(delays.length, 1, `只该登记一个定时器，实际 ${String(delays.length)}`)
      assert.equal(delays[0], 30_000, '默认上限必须正好是 30000ms')
      assert.equal(result.ok, true)
      assert.equal(pushes.length, 1)
    } finally {
      globalThis.setTimeout = original
    }
  } finally { s.cleanup() }
})
