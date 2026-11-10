/** 群事件时间线的**跨插件行取用面**（P3 §7.2）：让「被 @ 的群回合」看得到"她自己刚说过什么"。
 *
 * 为什么需要这一层：提供方是 `dsh-channel-qq`（它才知道群消息与自主发言），消费方是
 * `companion-group` 的系统提示词段。两者在合成里是**兄弟行**，`ctx.provide` 跨不过去
 * （2026-11-04 健康服务事故的同一个结论），所以这里走进程级注册表，键是套件 data root。
 *
 * 与服务名一致：`companionGroupEvents`（`plugins/companion-group/group-continuity.mjs` 里
 * 的 `GROUP_CONTINUITY_SERVICE_NAME` 就是它）。形状只有两个方法，且**都允许缺失**：
 *
 *   { recentSelf(limit): Array<{ text: string, atMs: number, kind: string }>,
 *     topic(): string | null }
 *
 * 任何一步拿不到都返回 `null`——消费方会把"没有事件服务"渲染成"还没有记录"，
 * 这比留白诚实，也比让模型凭印象补一句强。
 */

import { PORTS_SYMBOL, rootVariants, scopedKeys } from './service-registry.js'

/** 服务名（与 companion-group 的 GROUP_CONTINUITY_SERVICE_NAME 一致）。 */
export const GROUP_EVENTS_SERVICE = 'companionGroupEvents'

/** 时间线服务的最小面。 */
export interface GroupEventsService {
  recentSelf(limit: number): Array<{ text: string; atMs: number; kind: string }>
  topic(): string | null
}

/** 一次解析的结果：服务 + 它从哪来（诊断用，不含正文）。 */
export interface GroupEventsHandle {
  readonly service: GroupEventsService | null
  readonly via: 'ctx' | 'registry' | 'none'
  readonly reason: string
}

/** 形状判定：两个方法都是函数才算接上。形状不对 = 没有，**不猜**。 */
export function asGroupEventsService(raw: unknown): GroupEventsService | null {
  if (raw === null || typeof raw !== 'object') return null
  const shape = raw as { recentSelf?: unknown; topic?: unknown }
  if (typeof shape.recentSelf !== 'function' || typeof shape.topic !== 'function') return null
  return shape as unknown as GroupEventsService
}

/**
 * 解析事件服务（**绝不抛**）。
 *
 * 顺序：`ctx.get` → 进程注册表。注册表里先试**复合键**（`companionGroupEvents\0<root>`），
 * 再试裸 dataRoot —— 裸键会被 `companion-health` 占用（同进程先后挂载，一键一记录），
 * 这是 2026-11-08 实测过的。
 */
export function resolveGroupEvents(input: {
  context: () => unknown
  dataRoot: string | null
}): GroupEventsHandle {
  try {
    const ctx = input.context() as { get?: (key: string) => unknown } | null | undefined
    if (typeof ctx?.get === 'function') {
      const local = asGroupEventsService(ctx.get(GROUP_EVENTS_SERVICE))
      if (local !== null) return { service: local, via: 'ctx', reason: '' }
    }
  } catch {
    /* 继续试注册表 */
  }
  try {
    const holder: unknown = Reflect.get(process, PORTS_SYMBOL)
    if (!(holder instanceof Map)) return { service: null, via: 'none', reason: 'no-registry' }
    const root = input.dataRoot
    if (root === null || root === '') return { service: null, via: 'none', reason: 'no-root' }
    // 复合键优先、裸键最后：裸键会被 companion-health 占用（同进程后挂载者覆盖）。
    const keys = [...scopedKeys(GROUP_EVENTS_SERVICE, root), ...rootVariants(root)]
    for (const key of keys) {
      const entry = (holder as Map<string, unknown>).get(key) as
        | { service?: unknown; ready?: () => boolean }
        | undefined
      if (entry === undefined) continue
      let usable = true
      try {
        usable = typeof entry.ready === 'function' ? entry.ready() !== false : true
      } catch {
        usable = false
      }
      if (!usable) continue
      const service = asGroupEventsService(entry.service)
      if (service !== null) return { service, via: 'registry', reason: '' }
    }
    return { service: null, via: 'none', reason: 'registry-miss' }
  } catch {
    return { service: null, via: 'none', reason: 'registry-threw' }
  }
}
