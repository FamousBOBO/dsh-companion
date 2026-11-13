/** 语音条音源获取（`fetchVoiceSource`）—— 2026-11-14 的生产 bug 回归。
 *
 * 真实故障：宿主调 `get_record(messageId, 'amr')`，NapCat 返回
 * `1200 file not found`（另一种参数形态返回 `Encoder not found`）——它要调
 * ffmpeg 转码，而本机没有 ffmpeg。语音条因此一条都没进过模型。
 *
 * 正确出路是 `get_msg` 的 record 段：NapCat 已经把 silk 落盘，`path` 就是
 * 绝对路径。这批测试锁住三件事：
 *   1. `get_msg.path` 优先，且**不**依赖 get_record；
 *   2. get_record 挂掉时仍能拿到音源（退到 path / url）；
 *   3. **绝不删除 NapCat 数据目录里的原文件**（只有我们下载的才清理）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { transcribeVoiceMessage } = await import('../src/adapters/providers/stt.js')

const KEY = 'sk-test-0123456789abcdef'

/** 造一段最简 24 kHz 单声道 16 位 PCM WAV（足够走完 ASSR 前置校验）。 */
function wavBytes(seconds = 0.5): Buffer {
  const rate = 24000
  const frames = Math.round(rate * seconds)
  const data = Buffer.alloc(frames * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

const config = {
  enabled: true as const,
  backend: 'deepseek-asr' as const,
  timeoutMs: 30000,
  serverFallback: false,
  baseUrl: null,
  apiKey: null,
  model: 'whisper-1',
}

/** 一个"已解码"的 WAV 直接当音源用，绕开 silk 解码（那是 silk.ts 的事）。 */
async function withWavFile(run: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-src-'))
  const file = path.join(dir, 'ptt.wav')
  await fs.writeFile(file, wavBytes())
  try {
    await run(file)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** 替身 HTTP：下载地址一律拒，ASR 地址一律成功。 */
async function withStubbedAsr(
  run: (calls: () => { asr: number; download: number }) => Promise<void>,
): Promise<void> {
  const http = await import('../src/adapters/http/client.js')
  const original = http.systemHttp.request
  const counts = { asr: 0, download: 0 }
  http.systemHttp.request = (async (url: string) => {
    if (url.includes('/v1/tools/asr')) {
      counts.asr += 1
      const body = JSON.stringify({ request_id: 'r', text: '转写结果', duration_ms: 500 })
      return {
        status: 200, ok: true, url, bytes: Buffer.from(body, 'utf8'), truncated: false,
        header: () => null, headerValues: () => [], text: () => body,
        json: <T,>() => JSON.parse(body) as T,
      }
    }
    counts.download += 1
    throw new Error(`download blocked in test: ${url}`)
  }) as typeof http.systemHttp.request
  try {
    await run(() => ({ ...counts }))
  } finally {
    http.systemHttp.request = original
  }
}

test('生产 bug 回归：get_record 报 file not found 时，退到 get_msg.path 成功', async () => {
  await withWavFile(async (remotePath) => {
    await withStubbedAsr(async (calls) => {
      let getRecordCalled = false
      const api = {
        // NapCat 的真实失败形态
        getRecord: async () => { getRecordCalled = true; throw new Error('QQ API failed: file not found') },
        getMessage: async () => ({
          message: [{ type: 'record', data: { file: 'abc.amr', path: remotePath, url: 'https://x/y' } }],
        }),
      } as never
      const text = await transcribeVoiceMessage(api, config, 1, () => {}, {
        resolveCredentialsKey: async () => KEY,
      })
      assert.deepEqual(text, ['转写结果', 0])
      assert.equal(calls().asr, 1, '拿到音源后应调用一次 ASR')
      // `path` 命中即返回，所以 get_record 根本不该被调用——这正是修复的意义：
      // 不再依赖那条必须要 ffmpeg 的路径。
      assert.equal(getRecordCalled, false)
    })
  })
})

test('get_msg 有 path 时不依赖 get_record 也能成功', async () => {
  await withWavFile(async (remotePath) => {
    await withStubbedAsr(async (calls) => {
      let getRecordCalled = false
      const api = {
        getRecord: async () => { getRecordCalled = true; throw new Error('不该走到这里') },
        getMessage: async () => ({ message: [{ type: 'record', data: { file: 'a.amr', path: remotePath } }] }),
      } as never
      const text = await transcribeVoiceMessage(api, config, 2, () => {}, {
        resolveCredentialsKey: async () => KEY,
      })
      assert.deepEqual(text, ['转写结果', 0])
      assert.equal(calls().asr, 1)
      assert.equal(getRecordCalled, false, 'path 命中时不该白调一次 get_record')
    })
  })
})

test('绝不删除 NapCat 数据目录里的原文件', async () => {
  await withWavFile(async (remotePath) => {
    await withStubbedAsr(async () => {
      const api = {
        getRecord: async () => { throw new Error('QQ API failed: Encoder not found') },
        getMessage: async () => ({ message: [{ type: 'record', data: { file: 'a.amr', path: remotePath } }] }),
      } as never
      await transcribeVoiceMessage(api, config, 3, () => {}, { resolveCredentialsKey: async () => KEY })
      // 原文件必须还在：删掉它等于毁用户素材
      await fs.access(remotePath).then(
        () => assert.ok(true),
        () => assert.fail('NapCat 的原语音文件被误删了'),
      )
    })
  })
})

test('竞态回归：record.path 的文件晚一点才落盘，仍要等到它', async () => {
  // 2026-11-14 实测：消息到达与 NapCat 落盘在同一秒（CreationTime 与失败时间
  // 都是 02:23:27）。宿主立刻读 path → 读不到 → 退到 url 下载 → 拿到真 AMR
  // （silk-wasm 解不了）→ 整条语音失败。
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-race-'))
  const late = path.join(dir, 'late.wav')
  // 300ms 后才出现，落在 1.6 秒重试窗口内
  setTimeout(() => { void fs.writeFile(late, wavBytes()) }, 300)
  try {
    await withStubbedAsr(async (calls) => {
      const api = {
        getRecord: async () => { throw new Error('QQ API failed: Encoder not found') },
        getMessage: async () => ({ message: [{ type: 'record', data: { file: 'a.amr', path: late } }] }),
      } as never
      const text = await transcribeVoiceMessage(api, config, 6, () => {}, {
        resolveCredentialsKey: async () => KEY,
      })
      assert.deepEqual(text, ['转写结果', 0], '文件稍后出现时也要转写成功')
      assert.equal(calls().asr, 1)
      assert.equal(calls().download, 0, '不该退到那个只有 AMR 的下载分支')
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('get_msg 与 get_record 都失败时，错误消息要写清每一步的原因', async () => {
  const api = {
    getRecord: async () => { throw new Error('QQ API failed: file not found') },
    getMessage: async () => { throw new Error('get_msg boom') },
  } as never
  await assert.rejects(
    () => transcribeVoiceMessage(api, config, 4, () => {}, { resolveCredentialsKey: async () => KEY }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /get_msg 失败/)
      assert.match(message, /get_record 失败/)
      return true
    },
  )
})

test('record 段没有 path 但有 url 时，走 url 下载', async () => {
  await withStubbedAsr(async (calls) => {
    const api = {
      getRecord: async () => { throw new Error('QQ API failed: file not found') },
      getMessage: async () => ({ message: [{ type: 'record', data: { file: 'a.amr', url: 'http://127.0.0.1:9/x.amr' } }] }),
    } as never
    // 下载会打真实 HTTP（127.0.0.1:9 必拒），所以这里只断言它尝试过下载而不是静默成功
    await assert.rejects(
      () => transcribeVoiceMessage(api, config, 5, () => {}, { resolveCredentialsKey: async () => KEY }),
      (error: unknown) => error instanceof Error,
    )
    assert.equal(calls().asr, 0, '下载失败就不该调用 ASR')
    assert.equal(calls().download, 1, '应当尝试过下载')
  })
})
