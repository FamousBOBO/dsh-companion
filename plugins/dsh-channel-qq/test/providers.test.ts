/** 供应商面的测试：假宿主（settings / credentials / agentDefaultModel），不发真网络。
 *
 * 覆盖的是**可判定**的部分：列表形状、密钥配置判定、切换/保存/删除的校验和写入
 * 调用、请求头预设与协议形状。五档实测（`test()`）打真网络，不在这里测。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createProvidersSurface } = await import('../src/adapters/dsh-host/providers.js')
const { presetById, normalizeHeaders } = await import('../src/adapters/dsh-host/provider-headers.js')
const { buildBody, probeUrl, authHeaders } = await import('../src/adapters/dsh-host/provider-probes.js')

interface ProviderPatch {
  baseURL?: string
  apiKeyEnv?: string
  api?: string
  headers?: Record<string, string>
  models?: Array<{ id?: string; input?: string[] }>
}

interface Write {
  ns: string
  patch: { providers?: Record<string, ProviderPatch> }
  revision?: number
}

function fakeHost(overrides: { keyFromEnv?: string } = {}) {
  const writes: Write[] = []
  const unsets: Array<{ ns: string; ops: Array<{ op: 'unset'; path: string[] }>; revision?: number }> = []
  const saved: Array<{ provider: string; model: string }> = []
  const keys: Array<{ ref: string; value: string }> = []
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 3,
      value: {
        providers: {
          windhub: {
            displayName: 'windhub 网关',
            api: 'openai-completions',
            baseURL: 'https://example.com/v1',
            apiKeyEnv: 'TEST_PROVIDERS_KEY',
            models: [{ id: 'deepseek-v4.1-flash' }],
          },
          other: {
            displayName: '别的供应商',
            api: 'openai-completions',
            baseURL: 'https://other.example/v1',
            apiKeyEnv: 'OTHER_KEY',
            models: [{ id: 'other-model' }],
          },
        },
      },
    }],
    update: async (ns: string, patch: object, revision?: number) => { writes.push({ ns, patch: patch as Write['patch'], revision }) },
    mutate: async (ns: string, ops: Array<{ op: 'unset'; path: string[] }>, revision?: number) => { unsets.push({ ns, ops, revision }) },
  }
  const credentials = {
    describe: async () => ({ configured: true }),
    resolve: async () => ({ value: 'sk-from-store' }),
    set: async (ref: string, value: string) => { keys.push({ ref, value }) },
  }
  const agentDefaultModel = {
    currentSelection: () => ({ provider: 'windhub', model: 'deepseek-v4.1-flash' }),
    saveSelection: async (next: { provider: string; model: string }) => { saved.push(next) },
  }
  if (overrides.keyFromEnv !== undefined) process.env.TEST_PROVIDERS_KEY = overrides.keyFromEnv
  return { host: { settings, credentials, agentDefaultModel }, writes, unsets, saved, keys }
}

test('list：列出 providers、当前默认与密钥配置状态', async () => {
  const { host } = fakeHost({ keyFromEnv: 'sk-env' })
  const surface = createProvidersSurface(host)
  assert.ok(surface !== undefined)
  const result = await surface.list()
  assert.equal(result.ok, true)
  if (result.ok !== true) return
  assert.deepEqual(result.current, { provider: 'windhub', model: 'deepseek-v4.1-flash' })
  assert.equal(result.providers.length, 2)
  const p = result.providers[0]!
  assert.equal(p.name, 'windhub')
  assert.equal(p.baseURL, 'https://example.com/v1')
  assert.deepEqual(p.models, ['deepseek-v4.1-flash'])
  assert.equal(p.keyConfigured, true)
  assert.ok(Array.isArray(result.presets))
  delete process.env.TEST_PROVIDERS_KEY
})

test('list：环境变量没有时回退到凭据缝判定', async () => {
  const { host } = fakeHost()
  const surface = createProvidersSurface(host)!
  const result = await surface.list()
  assert.equal(result.ok, true)
  if (result.ok !== true) return
  assert.equal(result.providers[0]!.keyConfigured, true)
})

test('宿主没有 settings 时整面不可用（undefined，而不是假装能用）', () => {
  assert.equal(createProvidersSurface({}), undefined)
})

test('setDefault：未知供应商、未知模型都拒绝；合法则调 saveSelection', async () => {
  const { host, saved } = fakeHost()
  const surface = createProvidersSurface(host)!
  await assert.rejects(() => surface.setDefault('nope', 'x'), /没有名为 nope 的供应商/)
  await assert.rejects(() => surface.setDefault('windhub', 'nope-model'), /没有模型 nope-model/)
  assert.equal(saved.length, 0)
  const note = await surface.setDefault('windhub', 'deepseek-v4.1-flash')
  assert.match(note, /windhub\/deepseek-v4\.1-flash/)
  assert.deepEqual(saved, [{ provider: 'windhub', model: 'deepseek-v4.1-flash' }])
})

test('save：路由名校验、写 settings 的形状（含凭据引用）与版本号', async () => {
  const { host, writes } = fakeHost()
  const surface = createProvidersSurface(host)!
  await assert.rejects(() => surface.save({ name: 'Bad_Name', baseURL: 'https://x/v1', model: 'm' }), /小写字母/)
  await assert.rejects(() => surface.save({ name: 'ok', baseURL: '  ', model: 'm' }), /baseURL/)
  await assert.rejects(() => surface.save({ name: 'ok', baseURL: 'https://x/v1', model: '  ' }), /模型/)
  assert.equal(writes.length, 0)

  await surface.save({ name: 'acme', displayName: 'Acme', baseURL: 'https://api.acme.example/v1/', model: 'acme-1', vision: true })
  assert.equal(writes.length, 1)
  const write = writes[0]!
  assert.equal(write.ns, 'llm-pi-ai')
  assert.equal(write.revision, 3)
  const provider = write.patch.providers!['acme']!
  assert.equal(provider.baseURL, 'https://api.acme.example/v1')
  assert.equal(provider.apiKeyEnv, 'ACME_API_KEY')
  assert.deepEqual(provider.models, [{ id: 'acme-1', input: ['text', 'image'] }])
})

test('save：给了密钥明文就写凭据缝，没给就只写配置', async () => {
  const { host, keys } = fakeHost()
  const surface = createProvidersSurface(host)!
  await surface.save({ name: 'w2', baseURL: 'https://x/v1', model: 'm', apiKey: ' sk-secret ' })
  assert.deepEqual(keys, [{ ref: 'W2_API_KEY', value: 'sk-secret' }])
  await surface.save({ name: 'w3', baseURL: 'https://x/v1', model: 'm', apiKeyEnv: 'CUSTOM_ENV' })
  assert.equal(keys.length, 1)
})

test('请求头：保留名 user-agent 被拒；名字必须是 token；值不能含控制字符', () => {
  assert.throws(() => normalizeHeaders({ 'user-agent': 'claude-cli/1' }), /宿主接管/)
  assert.throws(() => normalizeHeaders({ 'bad name': 'x' }), /名字不合法/)
  assert.throws(() => normalizeHeaders({ 'x-a': 'a\nb' }), /控制字符/)
  assert.deepEqual(normalizeHeaders({ 'x-app': 'cli', empty: '' }), { 'x-app': 'cli' })
})

test('预设：CC 与 Codex 的头是核实过的原文，且都不含 user-agent', () => {
  const cc = presetById('claude-code')
  assert.equal(cc.headers['x-app'], 'cli')
  assert.equal(cc.headers['anthropic-version'], '2023-06-01')
  assert.match(cc.headers['anthropic-beta'] ?? '', /claude-code-20250219/)
  const codex = presetById('codex')
  assert.equal(codex.headers.originator, 'codex_cli_rs')
  assert.equal(codex.headers['OpenAI-Beta'], 'responses=experimental')
  for (const p of [cc, codex]) {
    assert.equal(Object.keys(p.headers).some((k) => k.toLowerCase() === 'user-agent'), false)
  }
  assert.throws(() => presetById('nope'), /没有名为 nope/)
})

test('实测请求：三种协议的路径、认证头与请求体形状', () => {
  assert.equal(probeUrl('https://x/v1', 'openai-completions'), 'https://x/v1/chat/completions')
  assert.equal(probeUrl('https://x/v1/', 'openai-responses'), 'https://x/v1/responses')
  assert.equal(probeUrl('https://x/v1', 'anthropic-messages'), 'https://x/v1/messages')
  const cc = authHeaders('anthropic-messages', 'k', { 'x-app': 'cli' })
  assert.equal(cc['x-api-key'], 'k')
  assert.equal(cc['anthropic-version'], '2023-06-01')
  assert.equal(cc['x-app'], 'cli')
  assert.equal(cc.authorization, undefined)
  assert.equal(authHeaders('openai-completions', 'k', {}).authorization, 'Bearer k')
  const body = JSON.parse(buildBody('openai-responses', 'm', { tools: true }))
  assert.equal(body.model, 'm')
  assert.equal(typeof body.input, 'string')
  assert.ok(Array.isArray(body.tools))
  const anth = JSON.parse(buildBody('anthropic-messages', 'm', { stream: true }))
  assert.equal(anth.stream, true)
  assert.ok(Array.isArray(anth.messages))
})

test('save：协议与请求头写进配置；非法协议被拒', async () => {
  const { host, writes } = fakeHost()
  const surface = createProvidersSurface(host)!
  await surface.save({ name: 'cc', baseURL: 'https://api.anthropic.com/v1', model: 'claude-x', api: 'anthropic-messages', headers: { 'x-app': 'cli' } })
  const provider = writes[0]!.patch.providers!['cc']!
  assert.equal(provider.api, 'anthropic-messages')
  assert.deepEqual(provider.headers, { 'x-app': 'cli' })
  await assert.rejects(() => surface.save({ name: 'x', baseURL: 'https://x', model: 'm', api: 'nope' }), /不支持的协议/)
})

test('remove：默认供应商拒绝删除；其余按路径 unset', async () => {
  const { host, unsets } = fakeHost()
  const surface = createProvidersSurface(host)!
  await assert.rejects(() => surface.remove('windhub'), /当前默认供应商/)
  assert.equal(unsets.length, 0)
  const note = await surface.remove('other')
  assert.match(note, /已删除/)
})
