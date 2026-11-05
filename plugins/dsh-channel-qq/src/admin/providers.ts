/** 后台「模型供应商」页的 HTTP 面（读列表 / 实测 / 切默认 / 保存）。
 *
 * 逻辑本体在 `adapters/dsh-host/providers.ts`（宿主知识那一层）；这里只管路由
 * 形状、审计与错误包装——与 routes-data.ts 的其它路由同一套约定。依赖面走
 * `AdminDeps.providers`（可选：宿主没提供 settings 服务时整页回答 503）。
 */

import type * as http from 'node:http'
import type { Json } from './config-engine.js'
import type { AdminDeps } from './types.js'
import { messageOf } from './util.js'

export interface ProvidersRouteEnv {
  deps: AdminDeps
  json: (res: http.ServerResponse, status: number, body: unknown) => void
  readBody: (req: http.IncomingMessage) => Promise<Json>
  audit: (ip: string, method: string, reqPath: string, action: string, summary: string, result?: 'ok' | 'error') => Promise<void>
  clientIp: (req: http.IncomingMessage) => string
}

async function readRoute(env: ProvidersRouteEnv, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    env.json(res, 405, { error: '用 GET' })
    return
  }
  const surface = env.deps.providers!
  const result = await surface.list()
  env.json(res, 200, result)
}

async function testRoute(env: ProvidersRouteEnv, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    env.json(res, 405, { error: '用 POST' })
    return
  }
  const body = await env.readBody(req)
  const name = String(body.name ?? '')
  const ip = env.clientIp(req)
  try {
    const report = await env.deps.providers!.test(name)
    const passed = report.steps.filter((s) => s.ok).length
    await env.audit(ip, 'POST', '/api/providers/test', 'providers.test',
      `实测供应商 ${name}：${passed}/${report.steps.length} 档通过`, report.ok ? 'ok' : 'error')
    env.json(res, 200, { ok: true, report })
  } catch (error) {
    await env.audit(ip, 'POST', '/api/providers/test', 'providers.test', `实测供应商 ${name} 失败：${messageOf(error)}`, 'error')
    env.json(res, 400, { error: messageOf(error) })
  }
}

async function defaultRoute(env: ProvidersRouteEnv, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    env.json(res, 405, { error: '用 POST' })
    return
  }
  const body = await env.readBody(req)
  const provider = String(body.provider ?? '')
  const model = String(body.model ?? '')
  const ip = env.clientIp(req)
  try {
    const note = await env.deps.providers!.setDefault(provider, model)
    await env.audit(ip, 'POST', '/api/providers/default', 'providers.default', note)
    env.json(res, 200, { ok: true, note })
  } catch (error) {
    await env.audit(ip, 'POST', '/api/providers/default', 'providers.default', `切换失败：${messageOf(error)}`, 'error')
    env.json(res, 400, { error: messageOf(error) })
  }
}

async function saveRoute(env: ProvidersRouteEnv, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    env.json(res, 405, { error: '用 POST' })
    return
  }
  const body = await env.readBody(req)
  const ip = env.clientIp(req)
  const models = modelsOf(body.models)
  const input = {
    name: String(body.name ?? ''),
    baseURL: String(body.baseURL ?? ''),
    model: String(body.model ?? ''),
    vision: body.vision === true,
    ...(models === undefined ? {} : { models }),
    ...body.displayName === undefined ? {} : { displayName: String(body.displayName) },
    ...body.api === undefined ? {} : { api: String(body.api) },
    ...body.apiKey === undefined ? {} : { apiKey: String(body.apiKey) },
    ...body.apiKeyEnv === undefined ? {} : { apiKeyEnv: String(body.apiKeyEnv) },
    ...body.headers === undefined ? {} : { headers: body.headers as Record<string, string> },
  }
  try {
    const note = await env.deps.providers!.save(input)
    // 摘要不含密钥值——审计里只记名字。
    await env.audit(ip, 'POST', '/api/providers/save', 'providers.save', `保存供应商 ${input.name}（${input.baseURL}）`)
    env.json(res, 200, { ok: true, note })
  } catch (error) {
    await env.audit(ip, 'POST', '/api/providers/save', 'providers.save', `保存供应商 ${input.name} 失败：${messageOf(error)}`, 'error')
    env.json(res, 400, { error: messageOf(error) })
  }
}

async function removeRoute(env: ProvidersRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'DELETE') {
    env.json(res, 405, { error: '用 DELETE' })
    return
  }
  const name = url.searchParams.get('name') ?? ''
  const ip = env.clientIp(req)
  try {
    const note = await env.deps.providers!.remove(name)
    await env.audit(ip, 'DELETE', '/api/providers', 'providers.remove', note)
    env.json(res, 200, { ok: true, note })
  } catch (error) {
    await env.audit(ip, 'DELETE', '/api/providers', 'providers.remove', `删除供应商 ${name} 失败：${messageOf(error)}`, 'error')
    env.json(res, 400, { error: messageOf(error) })
  }
}

async function discoverRoute(env: ProvidersRouteEnv, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    env.json(res, 405, { error: '用 POST' })
    return
  }
  const body = await env.readBody(req)
  const name = String(body.name ?? '')
  const ip = env.clientIp(req)
  try {
    const data = await env.deps.providers!.discover(name)
    await env.audit(ip, 'POST', '/api/providers/discover', 'providers.discover', `拉取 ${name} 的模型列表：${data.models.length} 个`)
    env.json(res, 200, { ok: true, ...data })
  } catch (error) {
    await env.audit(ip, 'POST', '/api/providers/discover', 'providers.discover', `拉取 ${name} 失败：${messageOf(error)}`, 'error')
    env.json(res, 400, { error: messageOf(error) })
  }
}

/** 表单里的模型数组：逐项校验，坏项丢弃（不因为一行没填好整次保存失败）。 */
function modelsOf(raw: unknown): Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; vision?: boolean }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; vision?: boolean }> = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const id = String(record.id ?? '').trim()
    if (id === '') continue
    out.push({
      id,
      ...(typeof record.name === 'string' && record.name !== '' ? { name: record.name } : {}),
      ...(typeof record.contextWindow === 'number' && Number.isInteger(record.contextWindow) && record.contextWindow > 0
        ? { contextWindow: record.contextWindow } : {}),
      ...(typeof record.maxTokens === 'number' && Number.isInteger(record.maxTokens) && record.maxTokens > 0
        ? { maxTokens: record.maxTokens } : {}),
      ...(record.vision === true ? { vision: true } : {}),
    })
  }
  return out.length === 0 ? undefined : out
}

/** 供应商路由：`/api/providers` 前缀下的一切。命中返回 true。 */
export async function routeProviders(env: ProvidersRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname
  if (!route.startsWith('/api/providers')) return false
  if (env.deps.providers === undefined) {
    env.json(res, 503, { error: '宿主未提供供应商管理所需的接口（settings / agentDefaultModel）' })
    return true
  }
  try {
    if (route === '/api/providers') {
      if (req.method === 'DELETE') { await removeRoute(env, req, res, url); return true }
      await readRoute(env, req, res)
      return true
    }
    if (route === '/api/providers/test') { await testRoute(env, req, res); return true }
    if (route === '/api/providers/default') { await defaultRoute(env, req, res); return true }
    if (route === '/api/providers/save') { await saveRoute(env, req, res); return true }
    if (route === '/api/providers/discover') { await discoverRoute(env, req, res); return true }
    env.json(res, 404, { error: `未知的供应商接口 ${route}` })
    return true
  } catch (error) {
    env.json(res, 500, { error: messageOf(error) })
    return true
  }
}
