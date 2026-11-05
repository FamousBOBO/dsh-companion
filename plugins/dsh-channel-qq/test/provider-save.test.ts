/** 供应商保存（后台）：models 数组必须原样传给宿主，而不是只留第一个。
 *
 * 这条防的是"加第二个模型保存后只剩一个"：表单一直发 models，路由层曾经
 * 只取了 model，于是第二个模型被丢掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { routeProviders } = await import('../src/admin/providers.js')

interface ModelInput {
  id: string
  contextWindow?: number
  maxTokens?: number
}

function harness() {
  let saved: { models: ModelInput[] } | null = null
  const env: Record<string, unknown> = {
    deps: {
      providers: {
        save: async (input: { models: ModelInput[] }) => { saved = input; return 'ok' },
        list: async () => ({ ok: true, providers: [] }),
        test: async () => ({ steps: [] }),
        setDefault: async () => 'ok',
        remove: async () => 'ok',
        discover: async () => ({ models: [], note: '' }),
      },
    },
    json: (_res: unknown, status: number, body: unknown) => { env.last = { status, body } },
    readBody: async () => ({
      name: 'workbuddy', baseURL: 'http://127.0.0.1:8317/v1', model: 'global:deepseek-v4.1-flash',
      models: [
        { id: 'global:deepseek-v4.1-flash', contextWindow: 131072 },
        { id: 'deepseek-v4.1-flash-1017', maxTokens: 8192 },
        { id: '  ', contextWindow: 1 },
      ],
      api: 'openai-completions', vision: true,
    }),
    audit: async () => {},
    clientIp: () => '127.0.0.1',
    last: null,
  }
  return { env, saved: () => saved }
}

test('供应商保存：两个模型都进宿主，空 id 被丢掉', async () => {
  const h = harness()
  const handled = await routeProviders(
    h.env as never, { method: 'POST' } as never, {} as never, new URL('http://x/api/providers/save'),
  )
  assert.equal(handled, true)
  const last = h.env.last as { status: number } | null
  assert.equal(last?.status, 200)
  const input = h.saved()
  assert.ok(input !== null)
  assert.equal(input!.models.length, 2)
  assert.deepEqual(input!.models.map((m) => m.id), ['global:deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'])
  assert.equal(input!.models[0]!.contextWindow, 131072)
  assert.equal(input!.models[1]!.maxTokens, 8192)
})
