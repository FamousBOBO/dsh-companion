/** 入站素材：引用的那条消息、附带的图片、收到的文件。
 *
 * 这三件事都发生在"消息进来了、还没交给模型"之间，而且都是**慢 IO**（调 QQ 接口、
 * 下载、落盘）。原来它们躺在 `bridge.ts` 的文件级函数里，与流水线逻辑混在一起；
 * 搬出来之后它们各自有名字、可以被单独测，也不会让流水线读起来像一段下载脚本。
 *
 * 依赖都是端口（`QQApi` / `HttpClient` / `AgentGateway`）与一个收件箱适配器，
 * 所以这一层没有 `node:*`。
 */

import type { OneBotEvent } from '../../types.js'
import { parseInbound, type ParsedInbound } from '../../core/message/parse.js'
import { extensionOf, sniffMediaType } from '../../core/message/media.js'
import type { AgentGateway } from '../../ports/agent-gateway.js'
import type { HttpClient } from '../../ports/http.js'
import type { QQApi } from '../../ports/platform.js'
import type { BlobStore } from '../../ports/blob-store.js'

/**
 * 从消息里存下来的单个文件上限。
 *
 * 原来**没有上限**：一个大文件就能把内存吃掉（整份字节都在 Buffer 里）。
 * 30MB 是"够用且炸不掉进程"的折中，超了就当没收到。
 */
export const MAX_INBOUND_FILE_BYTES = 30 * 1024 * 1024

/** 一条消息最多收几个文件（多的当没看见，免得一个人刷十几个文件把回合塞满）。 */
const MAX_FILES_PER_MESSAGE = 3

/** 这一层要的东西：三个端口 + 实时配置 + 日志。 */
export interface AttachmentDeps {
  readonly api: QQApi
  readonly http: HttpClient
  readonly gateway: AgentGateway
  /** 收件箱与本机文件（IO 全在适配器里，见 R8）。 */
  readonly blobs: BlobStore
  /** 实时读配置：看图开关与"每条最多几张"都要跟着后台改。 */
  readonly config: () => { readonly imageRecognition: { readonly enabled: boolean; readonly maxPerMessage: number } }
  readonly log: (line: string) => void
}

/** 引用上下文最多带多少字（模型只需要知道"在说哪件事"）。 */
const QUOTE_CHARS = 120

/**
 * 把被引用的那条消息拉成一行前缀（MaiBot 风格的灵活引用）。
 *
 * 拉不到就返回 null：引用是**锦上添花**，失败不该影响这一条消息本身。
 */
export async function fetchQuoted(
  deps: AttachmentDeps,
  event: OneBotEvent,
  parsed: ParsedInbound,
): Promise<string | null> {
  const { api, log } = deps
  if (parsed.replyToMessageId === null) return null
  try {
    const data = await api.getMessage(parsed.replyToMessageId) as {
      sender?: { user_id?: number; nickname?: string; card?: string }
      raw_message?: string
      message?: OneBotEvent['message']
    }
    const text = (data.raw_message
      ?? (data.message !== undefined ? parseInbound({ message: data.message } as OneBotEvent).text : '')).trim()
    const who = data.sender?.card?.trim() || data.sender?.nickname || `QQ${data.sender?.user_id ?? '?'}`
    if (text === '') {
      log?.(`quoted msg ${parsed.replyToMessageId}: fetched but empty text`)
      return null
    }
    log?.(`quoted msg ${parsed.replyToMessageId} from ${who}: ${text.slice(0, 60)}`)
    return `[引用 ${who}(${data.sender?.user_id ?? '?'}）：${text.slice(0, QUOTE_CHARS)}] `
  } catch (error) {
    log?.(`quoted msg ${parsed.replyToMessageId} fetch failed: ${String(error)}`)
    return null
  }
}

/** 下载一张图：先按消息里的地址取（带闸门），失败再问 NapCat 要本机文件。 */
async function downloadImage(deps: AttachmentDeps, url: string): Promise<Uint8Array | null> {
  if (url !== '') {
    // 消息里的图片地址 = 别人给的地址。
    const res = await deps.http.request(url, { limit: MAX_INBOUND_FILE_BYTES }).catch(() => null)
    if (res !== null && res.ok) return new Uint8Array(res.bytes)
  }
  // 兜底：让 NapCat 给出本机路径（同一台机器）。
  try {
    const data = await deps.api.getImage(url)
    if (typeof data?.file === 'string') return await deps.blobs.readLocal(data.file)
  } catch {
    // fall through
  }
  return null
}

/**
 * 把入站图片下载并**持久化**成附件，好让视觉模型原生看到它们。
 *
 * 关掉 `imageRecognition` 时直接返回空数组（不下载、不落盘）。
 */
export async function attachImages(deps: AttachmentDeps, urls: readonly string[]): Promise<unknown[]> {
  const vision = deps.config().imageRecognition
  if (!vision.enabled) return []
  const refs: unknown[] = []
  for (const url of urls.slice(0, vision.maxPerMessage)) {
    try {
      const bytes = await downloadImage(deps, url)
      if (bytes === null) continue
      const mediaType = sniffMediaType(bytes)
      const ref = await deps.gateway.saveImage({
        data: bytes,
        mediaType,
        name: `qq-image.${extensionOf(mediaType)}`,
      })
      refs.push(ref)
      deps.log(`image attached (${Math.round(bytes.length / 1024)} KB, ${mediaType})`)
    } catch (error) {
      deps.log(`image attach failed: ${String(error)}`)
    }
  }
  return refs
}

/** 文件下载的房间上下文：群文件要 group_id 才能换下载 URL。 */
export interface FileRoomContext {
  readonly groupId?: number
}

/**
 * 把消息里带的文件收进工作区收件箱，返回落盘路径（群聊与私聊都走这里）。
 *
 * 每个文件单独 try：一个坏链接不该让另外两个也收不到。
 */
export async function receiveFiles(
  deps: AttachmentDeps,
  parsed: ParsedInbound,
  nowMs: number,
  ctx: FileRoomContext = {},
): Promise<string[]> {
  if (parsed.files.length === 0) return []
  const saved: string[] = []
  for (const file of parsed.files.slice(0, MAX_FILES_PER_MESSAGE)) {
    try {
      const bytes = await downloadFileBytes(deps, file, ctx)
      if (bytes === null) throw new Error('no downloadable url')
      const target = await deps.blobs.writeInbox({ name: file.name, bytes, nowMs })
      saved.push(target)
      deps.log(`file received: ${file.name} (${Math.round(bytes.length / 1024)}KB) → inbox`)
    } catch (error) {
      deps.log(`file ${file.name} download failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return saved
}

/**
 * 一个入站文件的字节。解析顺序：
 *   1. 消息段里的地址（别人给的，过闸门）；
 *   2. 群文件 → `get_group_file_url`、私聊 → `get_private_file_url`（SnowLuma
 *      新版语义：`get_file` 只认图片/语音缓存，文件 id 它解析不了——2026-10-24
 *      起 10 次"no downloadable url"全是这个原因）；
 *   3. 最后兜底 `get_file`（兼容还认文件 id 的旧实现）。
 */
async function downloadFileBytes(
  deps: AttachmentDeps,
  file: { readonly url: string; readonly fileId: string },
  ctx: FileRoomContext = {},
): Promise<Buffer | null> {
  if (file.url !== '') {
    // 消息段里的地址 = 别人给的地址，必须过闸门。
    const res = await deps.http.request(file.url, { limit: MAX_INBOUND_FILE_BYTES }).catch(() => null)
    if (res !== null && res.ok) return Buffer.from(res.bytes)
  }
  if (file.fileId === '') return null
  // 专用 URL 接口（主路径）：失败就落到 get_file 兜底，不让一个坏接口把文件弄丢。
  const via = ctx.groupId === undefined
    ? await deps.api.getPrivateFileUrl(file.fileId).catch(() => null)
    : await deps.api.getGroupFileUrl(ctx.groupId, file.fileId).catch(() => null)
  if (typeof via?.url === 'string' && via.url !== '') {
    const res = await deps.http.request(via.url, { limit: MAX_INBOUND_FILE_BYTES }).catch(() => null)
    if (res !== null && res.ok) return Buffer.from(res.bytes)
  }
  try {
    const data = await deps.api.getFile(file.fileId)
    if (typeof data?.file === 'string' && !data.file.startsWith('http')) {
      const local = await deps.blobs.readLocal(data.file)
      return local === null ? null : Buffer.from(local)
    }
    if (typeof data?.file === 'string') {
      // NapCat 自己的文件服务就可能跑在 127.0.0.1 上，所以这一跳放行私网。
      const res = await deps.http.request(data.file, { limit: MAX_INBOUND_FILE_BYTES, allowPrivateHosts: true })
      if (res.ok) return Buffer.from(res.bytes)
    } else if (typeof data?.url === 'string' && data.url !== '') {
      const res = await deps.http.request(data.url, { limit: MAX_INBOUND_FILE_BYTES, allowPrivateHosts: true })
      if (res.ok) return Buffer.from(res.bytes)
    }
  } catch {
    // 兜底失败：交给调用方记一条"下载失败"。
  }
  return null
}
