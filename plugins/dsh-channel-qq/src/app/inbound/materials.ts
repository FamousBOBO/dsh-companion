/** 取材：一条入站消息的**重活**（语音转写、收文件、拉引用、下载图片）。
 *
 * 从流水线里搬出来的理由只有两条，但都是硬的：
 *  1. 它同时用到 HTTP、宿主附件存储、协议端 API 三种副作用端口，是流水线里唯一
 *     "每个字段都可能是网络请求"的地方；搬出来之后流水线只剩"什么时候值得付这笔钱"；
 *  2. `check:size` 对单文件有硬上限，而旁听把入站路径变长了——继续堆在 `pipeline.ts`
 *     里会先撞上限、再逼着人去删注释。
 *
 * **纯旁听不走这里**（见 `group-ambient.ts`）：路过的一条群消息只做纯渲染，
 * 不下载、不转写。这是"旁听便宜"这条要求的物理落点。
 */

import { attachImages, fetchQuoted, receiveFiles, type AttachmentDeps } from './attachments.js'
import { expandForwards } from './forward-expand.js'
import { transcribeVoiceOf } from './transcribe.js'
import type { OneBotEvent } from '../../types.js'
import type { ParsedInbound } from '../../core/message/parse.js'
import type { AgentGateway } from '../../ports/agent-gateway.js'
import type { BlobStore } from '../../ports/blob-store.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { HttpClient } from '../../ports/http.js'
import type { Clock } from '../../ports/clock.js'

/** 一包的素材（步骤 3 的产物）。 */
export interface Materials {
  readonly voiceText: string | null
  readonly forwardText: string | null
  readonly receivedFiles: string[]
  readonly quoted: string | null
  readonly imageRefs: unknown[]
}

/** 取材要用到的端口（全部由组合根注入；这里不认识宿主，也不碰 node:*）。 */
export interface MaterialsDeps {
  readonly platform: () => ChatPlatform
  readonly gateway: AgentGateway
  readonly blobs: BlobStore
  readonly http: HttpClient
  readonly clock: Clock
  readonly log: (line: string) => void
  readonly config: () => { readonly imageRecognition: { readonly enabled: boolean; readonly maxPerMessage: number } }
  readonly transcribe: (messageId: number) => Promise<string | null>
}

/** 步骤 2+3：解析之后的取材（语音、文件、引用、图片）。 */
export async function gatherMaterials(
  deps: MaterialsDeps,
  event: OneBotEvent,
  parsed: ParsedInbound,
): Promise<Materials> {
  const attachments: AttachmentDeps = {
    api: deps.platform().api,
    http: deps.http,
    gateway: deps.gateway,
    blobs: deps.blobs,
    config: () => deps.config(),
    log: deps.log,
  }
  const voiceText = await transcribeVoiceOf(deps.transcribe, deps.log, event, parsed)
  const forwardText = await expandForwards(() => deps.platform().api, parsed, deps.log)
  // 私聊里的文件落进工作区收件箱，交给 agent 处理。
  const receivedFiles = await receiveFiles(attachments, parsed, deps.clock.now(), { groupId: event.group_id })
  // 灵活引用上下文 + 视觉附件，两条路都要用。
  const quoted = await fetchQuoted(attachments, event, parsed)
  const imageRefs = await attachImages(attachments, parsed.imageUrls)
  return { voiceText, forwardText, receivedFiles, quoted, imageRefs }
}
