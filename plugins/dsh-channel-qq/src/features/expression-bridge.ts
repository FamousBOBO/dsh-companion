/** 入站旁路：把 QQ 消息**元数据**递给 companion-expression 的进程级端口（`Symbol.for` 的键跨模块身份
 * 不变，照 `foundation/health-service-ref.mjs`）。取不到就 `null`：不建表、不写盘、不打日志。同步、
 * 只转地址与 mface 字段、**不下载 / 不含字节 / 不 await**；先问「要不要」，抛错吞掉记一行。两种形态
 * 都认：冻结合同 `Map<dataRoot,{offers,ingest}>` 与 publisher 的裸对象 `{version,service,observe}`。
 */
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { OneBotEvent } from '../types.js'
import { parseInbound } from '../core/message/parse.js'

/** 端口注册表的键；与 `companion-expression` 发布时用的**同一个**符号。 */
export const EXPRESSION_PORT_SYMBOL = Symbol.for('dsh.companion.expression.v1')
type Route = { kind: 'dm' | 'group'; chatId: number; isOwner: boolean; senderId: number }
/** 一张图的 Vendor 元数据：`url` 是地址不是字节；mface 字段有才带。 */
export type ExpressionImage = { url: string; subType?: number | string; summary?: string; emojiId?: string; emojiPackageId?: string; key?: string }
/**
 * 一个表情的元数据。
 *
 * 与 `ExpressionImage` 分开传：表情要的是**意思**（`stickerKey` 用来认「这张以前见过」，
 * `label` 是 QQ 透出来的字面），而图片要的是像素。混在一起时下游只能当图片描述它。
 */
export type ExpressionSticker = { url: string; stickerKey: string; label: string; animated: boolean }
/** 路由 + 整条元数据（没有别的字段，所以带不出字节）。 */
export type ExpressionInbound = Route & {
  messageId: number; at: number; images: ExpressionImage[]; stickers?: ExpressionSticker[]; text?: string
}
/** 正常化后的端口：消费端只认这两个方法。 */
export interface ExpressionPort { offers(offer: Omit<Route, 'senderId'>): unknown; ingest(event: ExpressionInbound): unknown }
/** 服务袋 `expressionBridge` 那一格（观察者只经它转发；端口由本模块解析）。 */
export interface ExpressionBridgePort { forwardInbound(event: OneBotEvent, admins: readonly number[]): void }
export interface ForwardOptions { readonly admins: readonly number[]; readonly log?: (line: string) => void }
let key: string | null = null

/** 分区键 = 套件数据根。环境变量先看；否则算一次 foundation 的结果并缓存。 */
export function expressionPortKey(): string | null {
  const explicit = String(process.env.DSH_COMPANION_DATA_DIR ?? '').trim()
  if (explicit !== '' && path.isAbsolute(explicit)) return path.normalize(explicit)
  if (key !== null) return key
  let dir = path.dirname(fileURLToPath(import.meta.url)) // 往上找 companion-foundation/suite-paths.mjs
  for (let i = 0; i < 8; i++) {
    const file = path.join(path.dirname(dir), 'companion-foundation', 'suite-paths.mjs')
    if (existsSync(file)) return (key = foundationDataRoot(file))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 让 foundation 自己算（与发布方同源）；模块缺失或抛错 ⇒ `null`，绝不猜一个路径。 */
function foundationDataRoot(file: string): string | null {
  try {
    const read = createRequire(import.meta.url)(file).resolveDataRoot as (i: { moduleUrl: string }) => { dataRoot?: unknown }
    const root = read({ moduleUrl: import.meta.url }).dataRoot
    return typeof root === 'string' && root !== '' ? path.normalize(root) : null
  } catch { return null }
}

/** 折成 `{offers, ingest}`；版本不是 v1、或没有任何入队方法 ⇒ `null`。 */
function normalize(raw: unknown): ExpressionPort | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as { version?: number; offers?: unknown; ingest?: unknown; observe?: unknown }
  const push = typeof s.ingest === 'function' ? s.ingest : s.observe
  if (Number(s.version ?? 1) !== 1 || typeof push !== 'function') return null
  const ask = typeof s.offers === 'function' ? (s.offers as (o: unknown) => unknown).bind(s) : null
  return { offers: ask ?? (() => true), ingest: (event) => (push as (e: unknown) => unknown).call(s, event) }
}

/** 当前可用的端口。纯读：一次符号取属性，最多一次 Map 查表（**不建表**）。 */
export function expressionPort(): ExpressionPort | null {
  const holder: unknown = Reflect.get(process, EXPRESSION_PORT_SYMBOL)
  const raw = holder instanceof Map ? holder.get(expressionPortKey() ?? '') : holder
  return raw === undefined || raw === null ? null : normalize(raw)
}

/** 装配用：拿到了端口就包成服务袋那一格，否则 `null`（观察者据此整段跳过）。 */
export function expressionBridgePort(log?: (line: string) => void): ExpressionBridgePort | null {
  if (expressionPort() === null) return null
  return { forwardInbound: (event, admins) => forwardInbound(event, log === undefined ? { admins } : { admins, log }) }
}

/** 一张图的元数据：URL 必有，mface 字段有才带（不塞 `undefined` 键）。 */
function imageOf(data: Record<string, unknown>): ExpressionImage {
  const image: ExpressionImage = { url: String(data.url ?? '') }
  const subType = data.subType ?? data.subtype
  if (typeof subType === 'number' || typeof subType === 'string') image.subType = subType
  for (const name of ['summary', 'emojiId', 'emojiPackageId', 'key']) {
    const value = data[name]
    if (typeof value === 'string' && value.trim() !== '') Object.assign(image, { [name]: value.trim() })
  }
  return image
}

/** 事件 → 路由；不是私聊/群消息或 id 不合法时 `null`（`isOwner` 只认 `admins`）。 */
function routeOf(event: OneBotEvent, admins: readonly number[]): Route | null {
  const senderId = typeof event.user_id === 'number' ? event.user_id : 0
  const isOwner = admins.includes(senderId)
  if (event.message_type === 'group' && typeof event.group_id === 'number' && event.group_id > 0) {
    return { kind: 'group', chatId: event.group_id, isOwner, senderId }
  }
  return event.message_type === 'private' && senderId > 0 ? { kind: 'dm', chatId: senderId, isOwner, senderId } : null
}

/** 组包：地址取自 `parseInbound().imageUrls`，mface 字段取自原始消息段（parse 没暴露）。 */
function payloadOf(event: OneBotEvent, route: Route): ExpressionInbound {
  const segments = Array.isArray(event.message) ? event.message : []
  const metas = segments.flatMap((seg) => (seg.type === 'image' && String(seg.data.url ?? '') !== '' ? [imageOf({ ...seg.data })] : []))
  const parsed = parseInbound(event)
  const raw = Number(event.time) // OneBot 的 `time` 是 unix 秒；毫秒变体原样保留。
  const at = Number.isFinite(raw) && raw > 0 ? Math.round(raw > 1e12 ? raw : raw * 1000) : 0
  const text = parsed.plainText.trim()
  // 表情单独一层：下游靠 `stickerKey` 认出「这张以前见过」，不必重新描述画面。
  const stickers: ExpressionSticker[] = parsed.stickers.map((sticker, i) => ({
    url: parsed.stickerUrls[i] ?? '', stickerKey: sticker.key, label: sticker.label, animated: sticker.animated,
  }))
  return {
    ...route, at, messageId: typeof event.message_id === 'number' ? event.message_id : 0,
    images: parsed.imageUrls.map((url, i) => metas[i] ?? { url }),
    ...(stickers.length === 0 ? {} : { stickers }),
    ...(text === '' ? {} : { text }),
  }
}

/** 旁路入口：**同步、永不抛、永不 await**。 */
export function forwardInbound(event: OneBotEvent, options: ForwardOptions): void {
  const port = expressionPort()
  if (port === null) return
  const route = routeOf(event, options.admins)
  if (route === null) return
  const log: (line: string) => void = options.log ?? ((line) => { console.log(`[channel-qq] ${line}`) })
  const why = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  try {
    if (port.offers({ kind: route.kind, chatId: route.chatId, isOwner: route.isOwner }) !== true) return
  } catch (error) { log(`expression offers 抛错，已吞掉：${why(error)}`); return }
  try { port.ingest(payloadOf(event, route)) } catch (error) { log(`expression ingest 抛错，已吞掉：${why(error)}`) }
}
