/** DeepSeek 官方 ASR 客户端（`stt-deepseek.ts`）。
 *
 * 这里全部走零网络：`systemHttp` 与 `execFile` 都不真发请求，只断言"请求长什么样"
 * 与"错误码是什么"。ASR 按音频秒数计费，所以最要紧的两条断言是：
 *   1. 本地能判死的输入**一次请求都不发**；
 *   2. 失败**不自动重试**（重试必须由人显式发起）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const {
  ASR_MAX_BYTES,
  ASR_MAX_SECONDS,
  DEFAULT_ASR_BASE_URL,
  DEEPSEEK_API_KEY_REF,
  AsrError,
  assertSendable,
  inspectWav,
  transcribeDeepSeekWav,
} = await import('../src/adapters/providers/stt-deepseek.js')

const KEY = 'sk-test-0123456789abcdef'

/** 造一段真正的 16 位 PCM WAV：头 + 静音。 */
function wavBytes({ sampleRate = 24000, channels = 1, seconds = 1, bits = 16, format = 1 } = {}): Buffer {
  const frames = Math.round(sampleRate * seconds)
  const data = Buffer.alloc(frames * channels * (bits / 8))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(format, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * (bits / 8), 28)
  header.writeUInt16LE(channels * (bits / 8), 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** 一个临时目录，随测试结束清掉。 */
async function withWav(bytes: Buffer, run: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-test-'))
  const file = path.join(dir, 'voice.wav')
  await fs.writeFile(file, bytes)
  try {
    await run(file)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/**
 * 替身 `systemHttp`：记下每次请求，按脚本返回。
 *
 * 用真正的模块替换（`t.mock.module` 不可用于相对路径的 ESM 内部引用），
 * 所以这里替换的是模块导出的对象上的方法——`client.ts` 导出的 `systemHttp`
 * 就是同一个可写对象。
 */
async function withStubbedHttp(
  script: (url: string, options: unknown) => { status: number; body: string },
  run: (calls: Array<{ url: string; options: Record<string, unknown> }>) => Promise<void>,
): Promise<void> {
  const http = await import('../src/adapters/http/client.js')
  const original = http.systemHttp.request
  const calls: Array<{ url: string; options: Record<string, unknown> }> = []
  http.systemHttp.request = (async (url: string, options: Record<string, unknown> = {}) => {
    calls.push({ url, options })
    const { status, body } = script(url, options)
    const bytes = Buffer.from(body, 'utf8')
    return {
      status,
      ok: status >= 200 && status < 300,
      url,
      bytes,
      truncated: false,
      header: () => null,
      headerValues: () => [],
      text: () => body,
      json: <T,>() => JSON.parse(body) as T,
    }
  }) as typeof http.systemHttp.request
  try {
    await run(calls)
  } finally {
    http.systemHttp.request = original
  }
}

const OK = () => ({ status: 200, body: JSON.stringify({ request_id: 'r1', text: '你好世界', duration_ms: 1000 }) })

test('请求构造：打 /v1/tools/asr，带 Bearer，multipart 字段名是 file', async () => {
  await withWav(wavBytes({ seconds: 1 }), async (file) => {
    await withStubbedHttp(OK, async (calls) => {
      const text = await transcribeDeepSeekWav({ apiKey: KEY, baseUrl: DEFAULT_ASR_BASE_URL, timeoutMs: 30000 }, file)
      assert.equal(text, '你好世界')
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.url, 'https://api.deepseek.com/v1/tools/asr')
      const options = calls[0]?.options as { method?: string; headers?: Record<string, string>; body?: unknown }
      assert.equal(options.method, 'POST')
      assert.equal(options.headers?.Authorization, `Bearer ${KEY}`)
      const form = options.body as FormData
      assert.ok(form instanceof FormData, 'body 必须是 FormData（multipart）')
      assert.ok(form.has('file'), '音频字段名必须是 file')
      // 官方没有 model / language / response_format 这些参数，多传会被忽略但没必要。
      assert.equal(form.has('model'), false)
      assert.equal(form.has('language'), false)
      assert.equal(form.has('response_format'), false)
    })
  })
})

test('自建地址保留前缀路径，不去掉 /v1', async () => {
  await withWav(wavBytes(), async (file) => {
    await withStubbedHttp(OK, async (calls) => {
      await transcribeDeepSeekWav({ apiKey: KEY, baseUrl: 'https://relay.example/proxy/', timeoutMs: 1000 }, file)
      assert.equal(calls[0]?.url, 'https://relay.example/proxy/v1/tools/asr')
    })
  })
})

test('空文本 → null（无语音不是错误）', async () => {
  await withWav(wavBytes(), async (file) => {
    await withStubbedHttp(() => ({ status: 200, body: JSON.stringify({ request_id: 'r', text: '   ', duration_ms: 1 }) }), async (calls) => {
      const text = await transcribeDeepSeekWav({ apiKey: KEY, baseUrl: DEFAULT_ASR_BASE_URL, timeoutMs: 1000 }, file)
      assert.equal(text, null)
      assert.equal(calls.length, 1)
    })
  })
})

test('本地拒绝：非 WAV / 位深 / PCM / 采样率 / 体积 / 时长 → 一次请求都不发', async () => {
  const cases: Array<{ name: string; bytes: Buffer; code: string }> = [
    { name: '不是 RIFF/WAVE', bytes: Buffer.from('OggS not a wav at all, definitely long enough to pass 44 bytes'), code: 'ASR_UNSUPPORTED_AUDIO' },
    { name: '位深 8', bytes: wavBytes({ bits: 8 }), code: 'ASR_UNSUPPORTED_AUDIO' },
    { name: '浮点格式 3', bytes: wavBytes({ format: 3 }), code: 'ASR_UNSUPPORTED_AUDIO' },
    { name: '采样率 11025', bytes: wavBytes({ sampleRate: 11025 }), code: 'ASR_UNSUPPORTED_AUDIO' },
    { name: '超过 8 MiB', bytes: wavBytes({ sampleRate: 48000, seconds: 200 }), code: 'ASR_AUDIO_TOO_LARGE' },
    { name: '超过 120 秒', bytes: wavBytes({ sampleRate: 8000, seconds: 121 }), code: 'ASR_AUDIO_TOO_LONG' },
  ]
  for (const entry of cases) {
    await withWav(entry.bytes, async (file) => {
      await withStubbedHttp(OK, async (calls) => {
        await assert.rejects(
          () => transcribeDeepSeekWav({ apiKey: KEY, baseUrl: DEFAULT_ASR_BASE_URL, timeoutMs: 1000 }, file),
          (error: unknown) => error instanceof AsrError && error.code === entry.code,
          `${entry.name} 应判 ${entry.code}`,
        )
        assert.equal(calls.length, 0, `${entry.name}：本地拒绝时不该发请求`)
      })
    })
  }
})

test('错误码映射：每个状态码一个稳定码，且不重试', async () => {
  const table: Array<[number, string]> = [
    [400, 'ASR_INVALID_AUDIO'],
    // 鉴权失败不能归成"音频无效"：那会把人引去查音频格式。
    [401, 'ASR_AUTH'],
    [403, 'ASR_AUTH'],
    [408, 'ASR_UPLOAD_TIMEOUT'],
    [413, 'ASR_AUDIO_TOO_LARGE'],
    [429, 'ASR_RATE_LIMITED'],
    [503, 'ASR_BUSY'],
    [504, 'ASR_TIMEOUT'],
    [500, 'ASR_UPSTREAM'],
    // 实测：边缘节点对构造非法的 Key 返回 550 且 body 为空。不是文档码，如实归 UPSTREAM。
    [550, 'ASR_UPSTREAM'],
  ]
  for (const [status, code] of table) {
    await withWav(wavBytes(), async (file) => {
      await withStubbedHttp(() => ({ status, body: '{"error":{"message":"boom"}}' }), async (calls) => {
        await assert.rejects(
          () => transcribeDeepSeekWav({ apiKey: KEY, baseUrl: DEFAULT_ASR_BASE_URL, timeoutMs: 1000 }, file),
          (error: unknown) => error instanceof AsrError && error.code === code,
          `HTTP ${status} 应判 ${code}`,
        )
        assert.equal(calls.length, 1, `HTTP ${status}：只发一次，不重试`)
      })
    })
  }
})

test('空响应体也给出可读消息（550 实测就是这么回来的）', async () => {
  await withWav(wavBytes(), async (file) => {
    await withStubbedHttp(() => ({ status: 550, body: '' }), async () => {
      await assert.rejects(
        () => transcribeDeepSeekWav({ apiKey: KEY, baseUrl: DEFAULT_ASR_BASE_URL, timeoutMs: 1000 }, file),
        (error: unknown) => {
          assert.ok(error instanceof AsrError)
          assert.equal(error.code, 'ASR_UPSTREAM')
          assert.match(error.message, /响应体为空/)
          return true
        },
      )
    })
  })
})

test('上游回显密钥也会被抹掉', async () => {
  await withWav(wavBytes(), async (file) => {
    await withStubbedHttp(
      () => ({ status: 401, body: `{"error":{"message":"Authentication Fails, Your api key: ****${KEY.slice(-4)} is invalid"}}` }),
      async () => {
        await assert.rejects(
          () => transcribeDeepSeekWav({ apiKey: KEY, baseUrl: DEFAULT_ASR_BASE_URL, timeoutMs: 1000 }, file),
          (error: unknown) => {
            assert.ok(error instanceof AsrError)
            assert.equal(error.message.includes(KEY), false, '完整 Key 不能出现在错误消息里')
            return true
          },
        )
      },
    )
  })
})

test('inspectWav / assertSendable：24 kHz 单声道 1 秒算得准', () => {
  const bytes = wavBytes({ sampleRate: 24000, channels: 1, seconds: 2 })
  const facts = inspectWav(bytes)
  assert.equal(facts.sampleRate, 24000)
  assert.equal(facts.channels, 1)
  assert.equal(facts.bitsPerSample, 16)
  assert.ok(Math.abs(assertSendable(bytes) - 2) < 0.01)
})

test('限额常量与官方文档一致', () => {
  assert.equal(ASR_MAX_BYTES, 8 * 1024 * 1024)
  assert.equal(ASR_MAX_SECONDS, 120)
  assert.equal(DEEPSEEK_API_KEY_REF, 'DEEPSEEK_API_KEY')
})
