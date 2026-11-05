/** 兜底链（B5）：本地 STT 不可用时走协议端；OCR 工具只在开关打开时注册。
 *
 * 防的是"兜底反而更吵"：开关关着时不能多发一个请求，工具面也不能多一个工具。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { transcribeOne } = await import('../src/features/inbound/runtime-helpers.js')
const { registerQQTools } = await import('../src/features/qq-tools/register.js')
const { resolveConfig } = await import('../src/config.js')
const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
const { fakeClient, fakeOut, toolRecorder } = await import('./fakes/host.js')

const SELF = 1
const GROUP = 107
const MASTER = 280

function apiWith(responses: Record<string, unknown>) {
  const client = fakeClient(responses)
  return { client, api: createQQApi(client as never) }
}

test('兜底：本地 STT 没配 + 开关关 → 不调用协议端', async () => {
  const { client, api } = apiWith({ fetch_ptt_text: { text: '协议端文本' } })
  const text = await transcribeOne(api, {
    enabled: false, serverFallback: false, baseUrl: null, apiKey: null, model: 'whisper-1',
  }, 9, () => {})
  assert.equal(text, null)
  assert.equal(client.calls.some((c) => c.action === 'fetch_ptt_text'), false)
})

test('兜底：本地 STT 没配 + 开关开 → 用协议端文本', async () => {
  const { client, api } = apiWith({ fetch_ptt_text: { text: ' 协议端文本 ' } })
  const text = await transcribeOne(api, {
    enabled: false, serverFallback: true, baseUrl: null, apiKey: null, model: 'whisper-1',
  }, 9, () => {})
  assert.equal(text, '协议端文本')
  assert.deepEqual(client.calls.at(-1), { action: 'fetch_ptt_text', params: { message_id: 9 } })
})

test('兜底：协议端转写失败 → 返回 null，不抛穿', async () => {
  const api = {
    getVoiceText: async () => { throw new Error('no ptt') },
  } as never
  const text = await transcribeOne(api, {
    enabled: false, serverFallback: true, baseUrl: null, apiKey: null, model: 'whisper-1',
  }, 9, () => {})
  assert.equal(text, null)
})

test('OCR：开关关着 → 工具不存在', () => {
  const { ctx, definitions } = toolRecorder()
  const { api } = apiWith({})
  const config = resolveConfig({ selfId: SELF, admins: [MASTER], primaryGroup: GROUP })
  registerQQTools(ctx, config, api, fakeOut() as never, () => {})
  assert.equal(definitions.some((d) => d.name === 'qq_read_image_text'), false)
})

test('OCR：tools.v2 打开时也没被合并面吞掉（单独注册）', () => {
  const { ctx, definitions } = toolRecorder()
  const { api } = apiWith({})
  const config = resolveConfig({
    selfId: SELF, admins: [MASTER], primaryGroup: GROUP,
    tools: { v2: true },
    imageRecognition: { enabled: true, serverOcr: true, maxPerMessage: 2 },
  })
  registerQQTools(ctx, config, api, fakeOut() as never, () => {})
  assert.equal(definitions.some((d) => d.name === 'qq_image'), true, '17 个合并工具照旧')
  assert.equal(definitions.some((d) => d.name === 'qq_read_image_text'), true, 'OCR 单独注册')
})

test('OCR：开关打开 → 从消息里取图片并识别文字', async () => {
  const { ctx, definitions } = toolRecorder()
  const { client, api } = apiWith({
    get_group_list: [{ group_id: GROUP }],
    get_msg: { message: [{ type: 'image', data: { file: 'abc.jpg' } }] },
    ocr_image: { texts: [{ text: '你好' }, { text: '  ' }], language: 'zh' },
  })
  const config = resolveConfig({
    selfId: SELF, admins: [MASTER], primaryGroup: GROUP,
    imageRecognition: { enabled: true, serverOcr: true, maxPerMessage: 2 },
  })
  registerQQTools(ctx, config, api, fakeOut() as never, () => {})
  const def = definitions.find((d) => d.name === 'qq_read_image_text')
  assert.ok(def)
  const result = await (def!.execute as (a: unknown) => Promise<unknown>)({ messageId: 5 })
  assert.deepEqual(result, { count: 1, language: 'zh', texts: ['你好'] })
  assert.deepEqual(client.calls.find((c) => c.action === 'ocr_image')?.params, { image: 'abc.jpg' })
})
