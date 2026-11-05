/** 共享状态：快照 / schema / 连接状态 + 一个极简订阅器。
 *
 * 刻意不做响应式框架：页面渲染是「取当前 state → 建 DOM」，数据变化时由
 * 外壳统一 `notify()`。这样每个页面模块保持纯函数式（render(state) → Node），
 * 布局探针与交互测试不需要理解任何框架生命周期。
 */

import { api, authLost, setToken } from './api.js'

export const state = {
  /** `/api/snapshot` 的原始响应（{ ok, config, status, meta }）。 */
  snapshot: null,
  /** 掩码后的配置对象（secret 字段为空串，另有 meta.secretSet 标记"已设置"）。 */
  config: null,
  status: null,
  meta: null,
  /** `/api/schema`：{ ok, pages, sections, version }。 */
  schema: null,
  /** 配置版本（并发保护的 baseVersion）。 */
  configVersion: 0,
  /** 当前路由：{ kind: 'overview'|'module'|'system', key }。 */
  route: { kind: 'overview', key: 'overview' },
  /** SSE 状态：connecting | open | reconnecting。 */
  sse: 'connecting',
  /** 当前页面是否有未保存改动（文件编辑 / 配置表单）——beforeunload 用。 */
  dirty: false,
}

const listeners = new Set()

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notify(event) {
  for (const fn of [...listeners]) {
    try { fn(event) } catch (error) { console.error('[admin-ui] listener failed', error) }
  }
}

/** 拉快照并应用；返回原始响应（调用方判断 401 等）。 */
export async function loadSnapshot() {
  const res = await api('/api/snapshot')
  if (res.status === 200) applySnapshot(res.body)
  return res
}

export function applySnapshot(body) {
  state.snapshot = body
  state.config = body.config ?? null
  state.status = body.status ?? null
  state.meta = body.meta ?? null
  if (typeof body.meta?.configVersion === 'number') state.configVersion = body.meta.configVersion
  notify('snapshot')
}

/** 拉 schema（页面清单 + 配置段元数据）。失败时保持原值并返回响应。 */
export async function loadSchema() {
  const res = await api('/api/schema')
  if (res.status === 200) {
    state.schema = res.body
    notify('schema')
  } else if (authLost(res)) {
    setToken('')
    notify('auth-lost')
  }
  return res
}

export function setRoute(kind, key) {
  state.route = { kind, key }
  notify('route')
}

export function setSse(status) {
  if (state.sse === status) return
  state.sse = status
  notify('sse')
}

export function setDirty(dirty) {
  const next = dirty === true
  if (state.dirty === next) return
  state.dirty = next
  notify('dirty')
}

/** 点路径读取（`get(config, 'tts.voice')`）。 */
export function getPath(obj, path) {
  let cur = obj
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

/** 点路径写入（就地建中间对象；`setPath(patch, 'tts.voice', v)`）。 */
export function setPath(obj, path, value) {
  const parts = String(path).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
  return obj
}
