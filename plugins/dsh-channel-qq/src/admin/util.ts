/** 后台的纯辅助：环境旗标、收窄、错误整形、变更展示。
 *
 * 从 `admin.ts` 拆出（体量棘轮）。全部是无状态纯函数，行为与拆分前逐字一致——
 * `routes-data.ts` 与 `admin.ts` 共用同一份，不许各写一份。
 */

import type { ChangeEntry, Json } from './config-engine.js'
import type { PublicChange } from './types.js'

/** 环境变量按「是否被显式设成 1」判断，不做真值猜测。 */
export function envFlag(name: string): boolean {
  return (process.env[name] ?? '').trim() === '1'
}

/** 请求来源地址（审计与 healthz 门禁用；代理头不可信，只看 socket）。 */
export function clientIpOf(req: { readonly socket: { readonly remoteAddress?: string } }): string {
  return req.socket.remoteAddress ?? 'unknown'
}

export function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toJson(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

export function statusOf(error: unknown): number {
  const tagged = (error as { status?: unknown } | null)?.status
  return typeof tagged === 'number' ? tagged : 500
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function lineCount(url: URL, fallback: number): number {
  const raw = Number(url.searchParams.get('lines') ?? fallback)
  const value = Number.isFinite(raw) ? raw : fallback
  return Math.min(Math.max(Math.trunc(value), 1), 2000)
}

export function publicChange(change: ChangeEntry): PublicChange {
  return { path: change.path, label: change.label, hot: change.hot, secret: change.secret, old: change.old, new: change.new }
}

export function summaryOf(changes: ChangeEntry[], extra: string[], source?: string): string {
  const verb = source === 'rollback' ? '回滚保存' : source === 'internal' ? '内部保存' : '保存配置'
  const head = changes.length === 0
    ? `${verb}（无实际改动）`
    : `${verb} ${changes.length} 项：${changes.slice(0, 6).map((c) => c.path).join('、')}${changes.length > 6 ? ' 等' : ''}`
  return extra.length === 0 ? head : `${head}；${extra.join('；')}`
}

export function buildNote(effects: string[], restartRequired: string[], extra: string[]): string {
  return [
    '已生效并落盘。',
    ...extra,
    ...effects,
    restartRequired.length > 0 ? `这些设置仍需重启插件：${restartRequired.join(', ')}` : '',
  ].filter((part) => part !== '').join(' ')
}

/**
 * 读运行状态，最多等 `ms`。
 *
 * 快照里的 status 含一次 QQ 往返（`getGroupList`）。NapCat 忙时它可能长时间
 * 不返回，而**所有页面**都要先拿到 `/api/snapshot` 才渲染数据表——所以这里
 * 必须有上限：超时就给一个可读的占位状态，页面照常显示配置与资源表。
 */
export async function statusWithTimeout(
  status: () => Promise<Record<string, unknown>>,
  ms: number,
): Promise<Record<string, unknown>> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      status(),
      new Promise<Record<string, unknown>>((resolve) => {
        timer = setTimeout(() => resolve({
          unavailable: `状态读取超时（${Math.round(ms / 1000)} 秒）：QQ/协议端可能正忙；配置与数据表不受影响，稍后刷新即可。`,
        }), ms)
      }),
    ])
  } catch (error) {
    return { unavailable: `状态读取失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
