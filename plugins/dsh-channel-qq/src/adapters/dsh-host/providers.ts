/** 模型供应商的宿主接入（后台「模型供应商」页的服务端逻辑）。
 *
 * 复用的是 dsh 原生三层接口，不碰任何配置文件：
 *   - `settings.describe()/update()/mutate()`——llm-pi-ai 的 providers 设置；
 *   - `agentDefaultModel.currentSelection()/saveSelection()`——默认模型与切换；
 *   - `credentials.describe()/resolve()/set()`——apiKeyEnv 引用的凭据。
 *
 * 本文件**不 import 任何宿主包**：宿主服务一律结构化类型（见下面的 *Seam），
 * 所以不需要进 `scripts/layers-baseline.json` 的棘轮名单。
 */

import { catalogContextOf, modelCatalog } from './model-catalog.js'
import type { CatalogEntry } from './model-catalog.js'
import { systemHttp } from '../http/client.js'
import { HEADER_PRESETS, normalizeHeaders, presetById } from './provider-headers.js'
import { runProbes } from './provider-probes.js'

/** 结构化类型：宿主 settings 服务里本文件用到的方法。 */
export interface SettingsSeam {
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; revision: number; value: unknown }>
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  /** 删除某个设置路径（用来删供应商）。 */
  mutate(ns: string, ops: Array<{ op: 'unset'; path: string[] }>, expectedRevision?: number): Promise<void>
}

/** 结构化类型：宿主 credentials 服务。ref 运行时就是字符串。 */
export interface CredentialsSeam {
  describe(ref: string): Promise<{ configured: boolean }>
  resolve(ref: string): Promise<{ value?: string } | undefined>
  set(ref: string, value: string): Promise<void>
}

/** 结构化类型：宿主 agentDefaultModel 服务。 */
export interface DefaultModelSeam {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
  saveSelection(next: { provider: string; model: string }): Promise<void>
}

export interface ProvidersHost {
  settings?: SettingsSeam
  credentials?: CredentialsSeam
  agentDefaultModel?: DefaultModelSeam
}

/** 一个模型的配置（id + 可选能力）。 */
export interface ProviderModel {
  id: string
  name?: string
  /** 上下文窗口（token）；不填时按宿主默认值估算。 */
  contextWindow?: number
  /** 最大输出 token。 */
  maxTokens?: number
  /** 声明图片输入。 */
  vision?: boolean
}

/** 内置模型目录的一条（来自 models.dev）。 */
/** 列表里的一项供应商（绝不包含密钥值——只有引用名与"配没配"）。 */
export interface ProviderSummary {
  name: string
  displayName: string
  baseURL: string
  api: string
  apiKeyEnv: string
  keyConfigured: boolean
  models: string[]
  /** 完整模型配置（后台编辑表单回填 contextWindow / maxTokens）。 */
  modelDetails: ProviderModel[]
  /** 第一个模型是否声明了图片输入（编辑表单回填用）。 */
  vision: boolean
  headers: Record<string, string>
}

export interface ProviderTestStep {
  step: string
  ok: boolean
  ms: number
  httpStatus?: number
  note?: string
}

export interface ProviderTestReport {
  name: string
  protocol: string
  model: string
  ok: boolean
  steps: ProviderTestStep[]
}

export interface SaveProviderInput {
  name: string
  displayName?: string
  baseURL: string
  /** openai-completions | openai-responses | anthropic-messages */
  api?: string
  model: string
  /** 完整模型列表；给了就覆盖 `model`（兼容旧调用方）。 */
  models?: ProviderModel[]
  /** 声明图片输入（写进 models[].input，仅对没有 models 的旧调用方生效）。 */
  vision?: boolean
  /** 自定义请求头（整组替换；空对象 = 清空）。 */
  headers?: Record<string, string>
  /** 新密钥明文；给了就写进凭据缝，不给则沿用现有。 */
  apiKey?: string
  apiKeyEnv?: string
}

export interface ProvidersSurface {
  list(): Promise<{ ok: true; current: { provider: string; model: string } | null; providers: ProviderSummary[]; presets: typeof HEADER_PRESETS; catalog: readonly CatalogEntry[] } | { ok: false; note: string }>
  test(name: string): Promise<ProviderTestReport>
  setDefault(provider: string, model: string): Promise<string>
  save(input: SaveProviderInput): Promise<string>
  remove(name: string): Promise<string>
  /** 从供应商的 `/v1/models` 拉模型 id 列表（OpenAI 兼容端点）。 */
  discover(name: string): Promise<{ models: string[]; note: string }>
}

/** 供应商在 settings 文档里的原始形状（只取我们读写的字段）。 */
interface RawProvider {
  displayName?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  models?: Array<{ id?: string; name?: string; input?: string[]; contextWindow?: number; maxTokens?: number }>
  headers?: Record<string, string>
}

/** settings 里的 models → 后台表单用的结构。 */
function modelDetailsOf(raw: RawProvider): ProviderModel[] {
  return (raw.models ?? []).map((model) => ({
    id: String(model.id ?? ''),
    ...typeof model.name === 'string' && model.name !== '' ? { name: model.name } : {},
    ...typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {},
    ...typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {},
    ...Array.isArray(model.input) && model.input.includes('image') ? { vision: true } : {},
  })).filter((model) => model.id !== '')
}

const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 找 llm-pi-ai 在 settings 文档里的那一条（ns 是 profile entry id，包含即可）。 */
function findPiAiEntry(settings: SettingsSeam): { ns: string; revision: number; providers: Record<string, RawProvider> } | null {
  for (const entry of settings.describe()) {
    if (!String(entry.ns).includes('llm-pi-ai')) continue
    const value = isRecord(entry.value) ? entry.value : {}
    const providers = isRecord(value.providers) ? value.providers as Record<string, RawProvider> : {}
    return { ns: entry.ns, revision: entry.revision, providers }
  }
  return null
}

/** 凭据是否已配置：环境变量优先（当前部署的形态），其次凭据缝的记录。 */
async function keyConfigured(host: ProvidersHost, ref: string): Promise<boolean> {
  if (ref === '') return false
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv !== '') return true
  try {
    return (await host.credentials?.describe(ref))?.configured === true
  } catch {
    return false
  }
}

/** 取密钥明文用于实测：环境变量 → 凭据缝。取不到返回 undefined。 */
async function resolveKey(host: ProvidersHost, ref: string): Promise<string | undefined> {
  if (ref === '') return undefined
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  try {
    return (await host.credentials?.resolve(ref))?.value
  } catch {
    return undefined
  }
}

function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** 读出某个供应商，找不到就抛。 */
function requireProvider(host: ProvidersHost, name: string): RawProvider {
  const found = host.settings === undefined ? null : findPiAiEntry(host.settings)
  const raw = found?.providers[name]
  if (raw === undefined) throw new Error(`没有名为 ${name} 的供应商`)
  return raw
}

function makeList(host: ProvidersHost): ProvidersSurface['list'] {
  return async () => {
    if (host.settings === undefined || host.agentDefaultModel === undefined) {
      return { ok: false as const, note: '宿主未提供 settings / agentDefaultModel 服务，供应商管理不可用' }
    }
    const found = findPiAiEntry(host.settings)
    if (found === null) return { ok: false as const, note: '未在 settings 文档里找到 llm-pi-ai 条目' }
    const providers: ProviderSummary[] = []
    for (const [name, raw] of Object.entries(found.providers)) {
      providers.push({
        name,
        displayName: raw.displayName ?? name,
        baseURL: raw.baseURL ?? '',
        api: raw.api ?? 'openai-completions',
        apiKeyEnv: raw.apiKeyEnv ?? '',
        keyConfigured: await keyConfigured(host, raw.apiKeyEnv ?? ''),
        models: (raw.models ?? []).map((m) => String(m.id ?? '')).filter((id) => id !== ''),
        modelDetails: modelDetailsOf(raw),
        vision: Array.isArray(raw.models?.[0]?.input) && raw.models[0].input.includes('image'),
        headers: raw.headers ?? {},
      })
    }
    return { ok: true as const, current: host.agentDefaultModel.currentSelection(), providers, presets: HEADER_PRESETS, catalog: modelCatalog() }
  }
}

function makeTest(host: ProvidersHost): ProvidersSurface['test'] {
  return async (name: string) => {
    const raw = requireProvider(host, name)
    const baseURL = normalizeBaseURL(raw.baseURL ?? '')
    if (baseURL === '') throw new Error(`${name} 没配 baseURL`)
    const model = String(raw.models?.[0]?.id ?? '')
    if (model === '') throw new Error(`${name} 没配模型`)
    const key = await resolveKey(host, raw.apiKeyEnv ?? '')
    if (key === undefined) throw new Error(`${name} 的密钥未配置（${raw.apiKeyEnv ?? '未写 apiKeyEnv'}）`)
    const protocol = PROTOCOLS.includes((raw.api ?? 'openai-completions') as typeof PROTOCOLS[number])
      ? (raw.api ?? 'openai-completions')
      : 'openai-completions'
    const steps = await runProbes({ protocol, baseURL, key, model, headers: raw.headers ?? {} })
    return { name, protocol, model, ok: steps.every((s) => s.ok), steps }
  }
}

function makeSetDefault(host: ProvidersHost): ProvidersSurface['setDefault'] {
  return async (provider: string, model: string) => {
    if (host.agentDefaultModel === undefined) throw new Error('宿主未提供 agentDefaultModel 服务')
    const raw = requireProvider(host, provider)
    const models = (raw.models ?? []).map((m) => String(m.id ?? ''))
    if (!models.includes(model)) throw new Error(`${provider} 没有模型 ${model}（现有：${models.join('、')}）`)
    await host.agentDefaultModel.saveSelection({ provider, model })
    return `默认模型已切到 ${provider}/${model}（下一次模型调用生效）`
  }
}

function validateSave(input: SaveProviderInput): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.name)) throw new Error('供应商名必须是小写字母/数字/连字符（llm-pi-ai 的路由名规则）')
  if (normalizeBaseURL(input.baseURL) === '') throw new Error('baseURL 不能为空')
  const hasList = Array.isArray(input.models) && input.models.some((model) => model.id.trim() !== '')
  if (!hasList && input.model.trim() === '') throw new Error('模型 id 不能为空')
  if (input.api !== undefined && !PROTOCOLS.includes(input.api as typeof PROTOCOLS[number])) {
    throw new Error(`不支持的协议 ${input.api}（可选：${PROTOCOLS.join('、')}）`)
  }
}

function makeSave(host: ProvidersHost): ProvidersSurface['save'] {
  return async (input: SaveProviderInput) => {
    if (host.settings === undefined) throw new Error('宿主未提供 settings 服务')
    validateSave(input)
    const found = findPiAiEntry(host.settings)
    if (found === null) throw new Error('未在 settings 文档里找到 llm-pi-ai 条目')
    const headers = normalizeHeaders(input.headers ?? {})
    const apiKeyEnv = (input.apiKeyEnv ?? '').trim() || `${input.name.toUpperCase().replace(/-/g, '_')}_API_KEY`
    const incoming: ProviderModel[] = Array.isArray(input.models) && input.models.length > 0
      ? input.models
      : [{ id: input.model, ...input.vision === true ? { vision: true } : {} }]
    const models = incoming
      .filter((model) => model.id.trim() !== '')
      .map((model) => ({
        id: model.id.trim(),
        ...model.name !== undefined && model.name !== '' ? { name: model.name } : {},
        // 没填窗口就用内置目录补（models.dev）；仍没有就交给宿主默认值。
        ...(() => {
          const explicit = model.contextWindow !== undefined && Number.isInteger(model.contextWindow) && model.contextWindow > 0
            ? model.contextWindow
            : undefined
          const fallback = explicit ?? catalogContextOf(model.id)?.context
          return fallback === undefined ? {} : { contextWindow: fallback }
        })(),
        ...model.maxTokens !== undefined && Number.isInteger(model.maxTokens) && model.maxTokens > 0
          ? { maxTokens: model.maxTokens } : {},
        ...(() => {
          const catalog = catalogContextOf(model.id)
          // 显式勾选优先；没写时按官方能力表（models.dev）补，避免把多模态模型
          // 声明成纯文本、图片在入站预检里被替换成「图片」占位（2026-10-20）。
          const vision = model.vision === true || (model.vision === undefined && catalog?.image === true)
          return vision ? { input: ['text', 'image'] } : {}
        })(),
      }))
    if (models.length === 0) throw new Error('至少要有一个模型 id')
    const provider: RawProvider = {
      displayName: input.displayName?.trim() || input.name,
      api: input.api?.trim() || 'openai-completions',
      baseURL: normalizeBaseURL(input.baseURL),
      apiKeyEnv,
      models,
      ...Object.keys(headers).length === 0 ? {} : { headers },
    }
    await host.settings.update(found.ns, { providers: { [input.name]: provider } }, found.revision)
    let keyNote = ''
    if (input.apiKey !== undefined && input.apiKey.trim() !== '') {
      if (host.credentials === undefined) throw new Error('宿主未提供 credentials 服务，无法保存密钥')
      await host.credentials.set(apiKeyEnv, input.apiKey.trim())
      keyNote = `；密钥已写入凭据缝（${apiKeyEnv}）`
    }
    return `已保存供应商 ${input.name}${keyNote}；下一次模型调用生效`
  }
}

function makeDiscover(host: ProvidersHost): ProvidersSurface['discover'] {
  return async (name: string) => {
    const raw = requireProvider(host, name)
    const baseURL = normalizeBaseURL(raw.baseURL ?? '')
    if (baseURL === '') throw new Error(`${name} 没配 baseURL`)
    const key = await resolveKey(host, raw.apiKeyEnv ?? '')
    if (key === undefined) throw new Error(`${name} 的密钥未配置（${raw.apiKeyEnv ?? '未写 apiKeyEnv'}）`)
    const url = `${baseURL}/models`
    // 运维显式填的地址：允许私网（8317 这类本机网关就是私网）。
    const response = await systemHttp.request(url, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...raw.headers ?? {} },
      timeoutMs: 20_000,
      limit: 2 * 1024 * 1024,
      allowPrivateHosts: true,
    })
    if (!response.ok) throw new Error(`拉取模型列表失败 HTTP ${response.status}`)
    const body = response.json<{ data?: Array<{ id?: unknown }> } | Array<{ id?: unknown }>>()
    const list = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : []
    const models = list.map((entry) => String(entry.id ?? '')).filter((id) => id !== '')
    return { models, note: `从 ${url} 拉到 ${models.length} 个模型` }
  }
}

function makeRemove(host: ProvidersHost): ProvidersSurface['remove'] {
  return async (name: string) => {
    if (host.settings === undefined) throw new Error('宿主未提供 settings 服务')
    const found = findPiAiEntry(host.settings)
    if (found === null) throw new Error('未在 settings 文档里找到 llm-pi-ai 条目')
    if (found.providers[name] === undefined) throw new Error(`没有名为 ${name} 的供应商`)
    const current = host.agentDefaultModel?.currentSelection()
    if (current?.provider === name) throw new Error(`「${name}」是当前默认供应商，先切到别的再删`)
    await host.settings.mutate(found.ns, [{ op: 'unset', path: ['providers', name] }], found.revision)
    return `已删除供应商 ${name}`
  }
}

/** 组装面；宿主服务缺得太多时返回 undefined（后台显示"不可用"而不是假装能用）。 */
export function createProvidersSurface(host: ProvidersHost): ProvidersSurface | undefined {
  if (host.settings === undefined) return undefined
  return {
    list: makeList(host),
    test: makeTest(host),
    setDefault: makeSetDefault(host),
    save: makeSave(host),
    remove: makeRemove(host),
    discover: makeDiscover(host),
  }
}

/** 供后台"套用预设"用：按 id 取一份头副本。 */
export { presetById }
