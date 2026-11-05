/** 后台的"数据面"路由：工作区文件 / 预设 / 会话 / 资源表 / 动作 / 指令注入。
 *
 * 从 `admin.ts` 拆出（体量棘轮：单文件 400 行 / 单函数 60 行）。这些路由只依赖
 * 五件事——`AdminDeps`、`json`、`readBody`、`audit`、`clientIp`——所以收一个窄
 * 环境 `DataRouteEnv` 而不是整个 `AdminServer`；每个分支的行为与拆分前逐字一致。
 */

import type * as http from 'node:http'
import type { Json } from './config-engine.js'
import type { AdminDeps } from './types.js'
import { messageOf } from './util.js'

export interface DataRouteEnv {
  deps: AdminDeps
  json: (res: http.ServerResponse, status: number, body: unknown) => void
  readBody: (req: http.IncomingMessage) => Promise<Json>
  audit: (ip: string, method: string, reqPath: string, action: string, summary: string, result?: 'ok' | 'error') => Promise<void>
  clientIp: (req: http.IncomingMessage) => string
}

// ── 读 ─────────────────────────────────────────────────────────────────────

async function readFilesRoute(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL, route: string): Promise<boolean> {
  if (route === '/api/files' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (env.deps.files === undefined) {
      env.json(res, 503, { error: '未配置工作区，文件管理不可用' })
      return true
    }
    env.json(res, 200, { ok: true, ...await env.deps.files.list(url.searchParams.get('path') ?? '') })
    return true
  }
  if (route === '/api/files/read') {
    if (env.deps.files === undefined) {
      env.json(res, 503, { error: '未配置工作区，文件管理不可用' })
      return true
    }
    env.json(res, 200, { ok: true, ...await env.deps.files.read(url.searchParams.get('path') ?? '') })
    return true
  }
  return false
}

async function readAuxRoute(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL, route: string): Promise<boolean> {
  if (route === '/api/presets') {
    if (env.deps.presets === undefined) {
      env.json(res, 503, { error: '预设注册表不可用' })
      return true
    }
    env.json(res, 200, {
      ok: true,
      current: env.deps.presets.current(),
      default: env.deps.config.agentPreset,
      presets: await env.deps.presets.list(),
    })
    return true
  }
  if (route === '/api/presets/doc') {
    if (env.deps.presets === undefined) {
      env.json(res, 503, { error: '预设注册表不可用' })
      return true
    }
    const id = url.searchParams.get('id') ?? env.deps.presets.current()
    env.json(res, 200, { ok: true, ...await env.deps.presets.doc(id) })
    return true
  }
  if (route === '/api/sessions' && req.method === 'GET') {
    if (env.deps.sessions === undefined) {
      env.json(res, 503, { error: '会话管理不可用' })
      return true
    }
    env.json(res, 200, { ok: true, sessions: await env.deps.sessions.list() })
    return true
  }
  return false
}

async function readResourceRoute(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL, route: string): Promise<boolean> {
  const match = /^\/api\/resource\/([A-Za-z0-9_-]+)$/.exec(route)
  if (match === null || (req.method !== 'GET' && req.method !== 'HEAD')) return false
  const name = match[1]!
  const resource = env.deps.resources[name]
  if (resource === undefined) {
    env.json(res, 404, { error: `未知资源 ${name}` })
    return true
  }
  if (resource.list === undefined) {
    env.json(res, 405, { error: `${name} 不支持读取` })
    return true
  }
  env.json(res, 200, { ok: true, data: await resource.list(url.searchParams) })
  return true
}

export async function routeReadData(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL, route: string): Promise<boolean> {
  if (await readFilesRoute(env, req, res, url, route)) return true
  if (await readAuxRoute(env, req, res, url, route)) return true
  return await readResourceRoute(env, req, res, url, route)
}

// ── 写（文件 / 预设 / 会话）────────────────────────────────────────────────

async function writeFilesRoute(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname
  const ip = env.clientIp(req)
  if (route === '/api/files/write' && req.method === 'POST') {
    if (env.deps.files === undefined) { env.json(res, 503, { error: '未配置工作区，文件管理不可用' }); return true }
    const body = await env.readBody(req)
    const result = await env.deps.files.write(String(body.path ?? ''), String(body.content ?? ''))
    await env.audit(ip, 'POST', route, 'file.write', `写入 ${result.path}（${result.bytes} 字节）`)
    env.json(res, 200, { ok: true, ...result })
    return true
  }
  if (route === '/api/files/create' && req.method === 'POST') {
    if (env.deps.files === undefined) { env.json(res, 503, { error: '未配置工作区，文件管理不可用' }); return true }
    const body = await env.readBody(req)
    const result = await env.deps.files.create(String(body.path ?? ''), String(body.content ?? ''))
    await env.audit(ip, 'POST', route, 'file.create', `新建 ${result.path}`)
    env.json(res, 200, { ok: true, ...result })
    return true
  }
  if (route === '/api/files' && req.method === 'DELETE') {
    if (env.deps.files === undefined) { env.json(res, 503, { error: '未配置工作区，文件管理不可用' }); return true }
    const result = await env.deps.files.remove(url.searchParams.get('path') ?? '')
    await env.audit(ip, 'DELETE', route, 'file.delete', `删除 ${result.path}`)
    env.json(res, 200, { ok: true, ...result })
    return true
  }
  return false
}

async function writeAuxRoute(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname
  const ip = env.clientIp(req)
  if (route === '/api/presets/select' && req.method === 'POST') {
    if (env.deps.presets === undefined) { env.json(res, 503, { error: '预设注册表不可用' }); return true }
    const body = await env.readBody(req)
    try {
      const note = await env.deps.presets.select(String(body.id ?? ''))
      await env.audit(ip, 'POST', route, 'preset.select', `切换人格预设 → ${String(body.id ?? '')}`)
      env.json(res, 200, { ok: true, note })
    } catch (error) {
      await env.audit(ip, 'POST', route, 'preset.select', `切换预设失败：${messageOf(error)}`.slice(0, 200), 'error')
      env.json(res, 400, { error: messageOf(error) })
    }
    return true
  }
  if (route === '/api/sessions/rebuild' && req.method === 'POST') {
    if (env.deps.sessions === undefined) { env.json(res, 503, { error: '会话管理不可用' }); return true }
    const body = await env.readBody(req)
    const result = await env.deps.sessions.rebuild(String(body.room ?? ''))
    await env.audit(ip, 'POST', route, 'session.rebuild', `重建会话 ${result.room}（移动 ${result.files} 个文件到备份）`)
    env.json(res, 200, { ok: true, ...result })
    return true
  }
  return false
}

export async function routeWriteData(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (await writeFilesRoute(env, req, res, url)) return true
  return await writeAuxRoute(env, req, res, url)
}

// ── 写（指令注入 / 动作 / 资源）────────────────────────────────────────────

async function writePromptRoute(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname
  if (route !== '/api/prompt' || req.method !== 'POST') return false
  if (env.deps.prompt === undefined) { env.json(res, 503, { error: '该通道未提供指令注入' }); return true }
  const body = await env.readBody(req)
  const text = String(body.text ?? '').trim()
  if (text === '') {
    env.json(res, 400, { error: '指令不能为空' })
    return true
  }
  const result = await env.deps.prompt(text)
  await env.audit(env.clientIp(req), 'POST', route, 'prompt.inject', `注入指令：${text.slice(0, 60)}`)
  env.deps.log(`admin: prompt injected (${text.slice(0, 40)}…)`)
  env.json(res, 200, { ok: true, result })
  return true
}

async function writeActionRoute(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname
  const match = /^\/api\/action\/([A-Za-z0-9_-]+)$/.exec(route)
  if (match === null || req.method !== 'POST') return false
  const ip = env.clientIp(req)
  const name = match[1]!
  const body = await env.readBody(req)
  if (name === 'reconnect') {
    const notes = env.deps.applyEffects === undefined
      ? ['该通道没有重连钩子']
      : await env.deps.applyEffects({ connection: env.deps.config.connection })
    await env.audit(ip, 'POST', route, 'action.reconnect', '强制重连 OneBot')
    env.json(res, 200, { ok: true, data: notes })
    return true
  }
  const resource = env.deps.resources[String(body.resource ?? '')]
  const handler = resource?.actions?.[name]
  if (handler === undefined) {
    env.json(res, 404, { error: `未知动作 ${name}` })
    return true
  }
  const data = await handler(body)
  await env.audit(ip, 'POST', route, `action.${name}`, `执行动作 ${name}（资源 ${String(body.resource ?? '')}）`)
  env.json(res, 200, { ok: true, data })
  return true
}

async function writeResourceRoute(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname
  const match = /^\/api\/resource\/([A-Za-z0-9_-]+)$/.exec(route)
  if (match === null || (req.method !== 'POST' && req.method !== 'DELETE')) return false
  const ip = env.clientIp(req)
  const name = match[1]!
  const resource = env.deps.resources[name]
  if (resource === undefined) {
    env.json(res, 404, { error: `未知资源 ${name}` })
    return true
  }
  if (req.method === 'POST') {
    if (resource.create === undefined) { env.json(res, 405, { error: `${name} 不支持写入` }); return true }
    const body = await env.readBody(req)
    const data = await resource.create(body)
    await env.audit(ip, 'POST', route, 'resource.create', `${name} 新增一条`)
    env.json(res, 200, { ok: true, data })
    return true
  }
  if (resource.remove === undefined) { env.json(res, 405, { error: `${name} 不支持删除` }); return true }
  const id = url.searchParams.get('id') ?? ''
  if (id === '') {
    env.json(res, 400, { error: '缺少 id' })
    return true
  }
  const data = await resource.remove(id)
  await env.audit(ip, 'DELETE', route, 'resource.remove', `${name} 删除 ${id}`.slice(0, 200))
  env.json(res, 200, { ok: true, data })
  return true
}

export async function routeWriteMisc(env: DataRouteEnv, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (await writePromptRoute(env, req, res, url)) return true
  if (await writeActionRoute(env, req, res, url)) return true
  return await writeResourceRoute(env, req, res, url)
}
