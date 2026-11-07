/** 一条点歌任务的流水线：下载 → 定位副歌 → 翻唱 → 发送。
 *
 * 为什么把"一条任务怎么跑"单独成一个文件（而不是塞进队列）：队列关心的是
 * **串行、去重、日上限、清理**（那是调度），这里关心的是**这条链路的顺序与失败边界**
 * （那是业务）。两者混在一起时，"卡在哪一步"这个问题就会被调度代码淹没。
 *
 * 四步的顺序不是可以随意换的：副歌定位要**整条音轨**（只听 25 秒片段判断不出
 * "这段旋律重复了几次"）；翻唱要**副歌起点**（否则切出来的片段不知道从哪裁）；
 * 发送要**成品**。每一步的产物只喂给下一步，中间产物落在任务目录里，任务结束就删。
 *
 * 三个必须写明的取舍：
 *
 *   1. **副歌定位失败不是"点歌失败"**（私聊入口）：上层会回一句"没找准副歌，
 *      给我一个时间点或换一条视频"。所以这里把"定位不可靠"与"定位脚本坏了"都
 *      收敛成同一个 `SongStepError('chorus')`，由上层按入口决定说法。
 *   2. **发送有三态，只有一态会重发**：`ok` 记 `sent`、确定失败记 `failed`、
 *      回执未知记 `unknown-send` 且**绝不重发**。网关嫌语音条长时的缩短重试
 *      只在"确定失败 + 看起来是长度问题"时做，且**保持同一个副歌起点**。
 *   3. **闸门在发送之前**，而不是在入队时：一首歌要跑两三分钟，授权、免打扰、
 *      日上限这些判据必须用**发送那一刻**的事实（那时用户可能刚说了话、
 *      或者管理员刚把开关关了）。入队时只判"队列满不满"。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Clock } from '../../ports/clock.js'
import type {
  BiliPort, ChorusPort, CoverPort, CoverResult, SendGatePort, SongCandidate,
  SongRequest, SongStage, VoicePort,
} from './types.js'
import { SongStepError } from './types.js'
import type { SongConfig } from '../../config/sections/song.js'

/** 流水线需要的全部外部能力（装配在 `features/song/index.ts`）。 */
export interface PipelineDeps {
  readonly bili: BiliPort
  readonly chorus: ChorusPort
  readonly cover: CoverPort
  readonly voice: VoicePort
  readonly gate: SendGatePort
  readonly clock: Clock
  readonly config: () => SongConfig
  readonly log: (line: string) => void
  /** 任务目录的父目录（每个任务一个子目录，结束即删）。 */
  readonly workRoot: string
}

/** 阶段推进的回调（队列据此写账本）；**不抛**的实现由队列保证。 */
export interface PipelineHooks {
  readonly advance: (stage: SongStage, patch?: {
    readonly bvid?: string
    readonly chorusStart?: number
    readonly seconds?: number
  }) => Promise<void>
}

/** 一条任务的结局。`detail` 只在 `failed` / `unknown-send` 上有值。 */
export interface PipelineOutcome {
  readonly stage: 'sent' | 'dry-run' | 'failed' | 'unknown-send'
  readonly detail: string | null
  readonly messageId: number | null
}

/** 网关嫌长时的缩短短度阶梯（都保持同一个副歌起点）。 */
const SHORTEN_STEPS = [15, 10] as const
/** 阶梯里最短的那一档；到它就不再重试（再短就听不出是副歌了）。 */
const SHORTEST_SECONDS = 10

/**
 * 一次发送的确定失败**是不是"太长了"**。
 *
 * 为什么要这层判断：缩短意味着**重新翻唱一遍**（本机约 70 秒）。把任何确定失败都
 * 当"太长"重跑，一次"没连上 NapCat"会白白多跑两分钟，而且用户什么也没收到。
 * 反过来，只按错误文本判断又太脆——所以判据是"文本像长度问题 + 当前还不够短"，
 * 两者都成立才重试，最多两次。
 */
export function looksLikeLengthRejection(detail: string, seconds: number): boolean {
  if (seconds <= SHORTEST_SECONDS) return false
  return /太长|过长|too long|payload|size|大小|体积|file|record|silk|语音|amr|格式|format/i.test(detail)
}

/** 挑分P：优先 part 里带歌名的那个，否则第一个。多P 视频里第一个常常是预告。 */
function pickPage(pages: readonly { cid: number; part: string; duration: number }[], song: string): {
  cid: number; duration: number; part: string
} | null {
  if (pages.length === 0) return null
  const key = song.trim().toLowerCase()
  if (key !== '') {
    const hit = pages.find((page) => page.part.toLowerCase().includes(key))
    if (hit !== undefined) return hit
  }
  return pages[0] ?? null
}

/** 建一个任务目录（`<workRoot>/<taskId>`），失败即抛（没有目录就没法下载）。 */
async function makeWorkDir(workRoot: string, taskId: string): Promise<string> {
  const dir = path.join(workRoot, taskId)
  try {
    await fs.mkdir(dir, { recursive: true })
    return dir
  } catch (error) {
    throw new SongStepError('queued', `建不了任务目录：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 跑完一条任务。**返回结局，不抛**：所有失败都翻译成 `PipelineOutcome`，
 * 这样队列里不会因为一个漏掉的 `catch` 让"永远在跑"的任务占住串行队列。
 */
export async function runTask(
  deps: PipelineDeps,
  request: SongRequest,
  hooks: PipelineHooks,
  signal: AbortSignal,
): Promise<PipelineOutcome> {
  let workDir: string | null = null
  try {
    workDir = await makeWorkDir(deps.workRoot, request.id)
    return await walk(deps, request, hooks, signal, workDir)
  } catch (error) {
    const failure = error instanceof SongStepError
      ? error
      : new SongStepError('failed', reasonOf(error, '未知失败'))
    deps.log(`song: ${request.id} 失败于 ${failure.stage}：${failure.detail}`)
    return { stage: 'failed', detail: failure.detail, messageId: null }
  } finally {
    // 清理是**合同**：视频/中间音频留在盘上等于每次点歌往硬盘上扔几十 MB。
    if (workDir !== null) await removeWorkDir(deps, workDir)
  }
}

/** 四步走完的流水线本体（`runTask` 只管"兜错 + 清理"，这里只管顺序）。 */
async function walk(
  deps: PipelineDeps,
  request: SongRequest,
  hooks: PipelineHooks,
  signal: AbortSignal,
  workDir: string,
): Promise<PipelineOutcome> {
  const config = deps.config()
  // ── 1. 下载音轨 ──────────────────────────────────────────────────────
  const audioFile = await fetchAudio(deps, request, hooks, signal, workDir, config)

  // ── 2. 定位副歌 ──────────────────────────────────────────────────────
  await step(signal, 'chorus', '取消（定位副歌之前）')
  await hooks.advance('chorus')
  const chorusStart = await locateChorus(deps, request, audioFile, config, signal)
  await hooks.advance('chorus', { chorusStart })

  // ── 3. 翻唱 + 裁语音条 ──────────────────────────────────────────────
  await step(signal, 'covering', '取消（翻唱之前）')
  await hooks.advance('covering', { chorusStart })
  const cover = await renderCover(deps, audioFile, workDir, chorusStart, config.seconds, request.keyUp, signal)
  await hooks.advance('covering', { chorusStart, seconds: cover.seconds })

  // ── 4. 闸门 + 发送 ──────────────────────────────────────────────────
  // 发送之前**再查一次取消**：前面的翻唱要跑一两分钟，这期间用户完全可能改主意。
  // 少了这一查，"取消"只是"不再看结果"——语音条照样会发出去。
  await step(signal, 'sending', '取消（发送之前）')
  await hooks.advance('sending', { chorusStart, seconds: cover.seconds })
  return await deliver(deps, request, cover, audioFile, workDir, chorusStart, hooks, signal)
}

/**
 * 取消检查点：任意一步之前调一次，`AbortSignal` 已中止就抛出（`runTask` 会翻成 `cancelled`）。
 *
 * 为什么不用 `throwIfAborted()`：它抛的是 `DOMException`，而这里的失败要能被
 * `runTask` 认成"用户取消，不是失败"——所以自己抛一个带阶段的错误。
 */
function step(signal: AbortSignal, stage: SongStage, detail: string): void {
  if (signal.aborted) throw new SongStepError(stage, detail)
}

/** 第 1 步：取视频信息 → 挑分P → 下载音轨。 */
async function fetchAudio(
  deps: PipelineDeps,
  request: SongRequest,
  hooks: PipelineHooks,
  signal: AbortSignal,
  workDir: string,
  config: SongConfig,
): Promise<string> {
  const bvid = request.bvid ?? ''
  await hooks.advance('downloading', { bvid })
  if (bvid === '') throw new SongStepError('downloading', '没有可用的 BV 号（选歌那一步没给出视频）')
  const info = await deps.bili.videoInfo(bvid, signal)
  const page = pickPage(info.pages, request.song)
  if (page === null) throw new SongStepError('downloading', `${bvid} 没有可用的分P`)
  const audioFile = path.join(workDir, 'audio.wav')
  await deps.bili.downloadAudio(bvid, page.cid, audioFile, {
    timeoutMs: config.downloadTimeoutMs, signal,
  }).catch((error: unknown) => {
    throw new SongStepError('downloading', downloadHint(reasonOf(error, '下载音轨失败')))
  })
  return audioFile
}

/**
 * 下载失败时给人看的那句话。
 *
 * B站限流（429）与节点抖动（503/504）**几分钟就恢复**，而"下载音轨失败：HTTP 429"
 * 只会让人去查网络和凭据。所以这两类单独补一句"过几分钟再点"——那是唯一有效的下一步。
 * 其余错误原样透传：403/404 是权限或文件没了，猜着解释比不解释更糟。
 */
export function downloadHint(reason: string): string {
  if (/\bHTTP (429|502|503|504)\b/.test(reason)) {
    return `${reason}——B站这边暂时不可用（限流或节点抖动），过几分钟再点一次`
  }
  return reason
}

/** 第 4 步：过闸门，然后发送（被拦下就说清楚是哪一道）。 */
async function deliver(
  deps: PipelineDeps,
  request: SongRequest,
  cover: CoverResult,
  audioFile: string,
  workDir: string,
  chorusStart: number,
  hooks: PipelineHooks,
  signal: AbortSignal,
): Promise<PipelineOutcome> {
  const verdict = await deps.gate.authorize(request.room, request.entry)
  if (verdict.verdict !== 'allowed') {
    const detail = verdict.verdict === 'dry-run'
      ? '演练模式：链路全部跑通，按设置没有真的发送'
      : `外发被拦下（${verdict.reason}）：这一条没有发出去`
    deps.log(`song: ${request.id} ${verdict.verdict}（${verdict.reason}）`)
    return { stage: verdict.verdict === 'dry-run' ? 'dry-run' : 'failed', detail, messageId: null }
  }
  return await sendWithShortenRetry(deps, request, cover, audioFile, workDir, chorusStart, hooks, signal)
}

/** 删任务目录（失败只记一行日志：清理不该把成功变成失败）。 */
async function removeWorkDir(deps: PipelineDeps, workDir: string): Promise<void> {
  await fs.rm(workDir, { recursive: true, force: true }).catch((error: unknown) => {
    deps.log(`song: 清理任务目录失败（${reasonOf(error, '删除失败')}）`)
  })
}

/** 副歌起点：用户给了就直接用；否则定位；不可靠按"这一步失败"处理。 */
async function locateChorus(
  deps: PipelineDeps,
  request: SongRequest,
  audioFile: string,
  config: SongConfig,
  signal: AbortSignal,
): Promise<number> {
  if (request.chorusAt !== null && Number.isFinite(request.chorusAt) && request.chorusAt >= 0) {
    deps.log(`song: ${request.id} 用用户给的副歌时间 ${request.chorusAt.toFixed(1)}s`)
    return request.chorusAt
  }
  let pick
  try {
    pick = await deps.chorus.locate(audioFile, { signal })
  } catch (error) {
    throw new SongStepError('chorus', `副歌定位出错：${reasonOf(error, '未知错误')}`)
  }
  if (pick === null) {
    throw new SongStepError('chorus', '没找准副歌（重复段落与人声都不够明显），不猜')
  }
  if (pick.confidence < config.minConfidence) {
    throw new SongStepError('chorus',
      `副歌定位不够可靠（置信度 ${pick.confidence.toFixed(2)} < ${config.minConfidence}），不猜`)
  }
  deps.log(`song: ${request.id} 副歌 ${pick.startSeconds.toFixed(1)}s（置信度 ${pick.confidence.toFixed(2)}）`)
  return pick.startSeconds
}

/** 跑翻唱；失败统一翻译（python 崩了 / 超时 / 产物校验不过都是"这一步没做成"）。 */
async function renderCover(
  deps: PipelineDeps,
  audioFile: string,
  workDir: string,
  chorusStart: number,
  seconds: number,
  keyUp: number,
  signal: AbortSignal,
): Promise<CoverResult> {
  try {
    return await deps.cover.render({ audioFile, outDir: workDir, chorusStart, seconds, keyUp, signal })
  } catch (error) {
    throw new SongStepError('covering', `翻唱没做成：${reasonOf(error, '未知错误')}`)
  }
}

/**
 * 发送 + "网关嫌长"时的缩短重试。
 *
 * **缩短只改长度，不改起点**：`chorusStart` 一路不变，所以第二次听到的仍然是副歌开头。
 * 重试次数上限就是 `SHORTEN_STEPS` 的长度，且**只对确定失败**重试——回执未知一律
 * 直接停止（那条可能已经到了）。
 */
async function sendWithShortenRetry(
  deps: PipelineDeps,
  request: SongRequest,
  firstCover: CoverResult,
  audioFile: string,
  workDir: string,
  chorusStart: number,
  hooks: PipelineHooks,
  signal: AbortSignal,
): Promise<PipelineOutcome> {
  const config = deps.config()
  let cover = firstCover
  let attempt = 0
  for (;;) {
    // 每次发送之前查一次取消；缩短之后要重跑翻唱，所以重跑之前也要查。
    step(signal, 'sending', '取消（发送之前）')
    const result = await deps.voice.sendVoice(request.room, request.chatId, cover.voiceFile)
    if (result.ok) {
      deps.log(`song: ${request.id} 已发送（message_id=${String(result.messageId ?? '?')}，${String(cover.seconds)}s）`)
      return { stage: 'sent', detail: null, messageId: result.messageId }
    }
    if (result.unknown) {
      // **绝不重发**：回执未知意味着可能已经到了，再来一条就是第二条语音。
      deps.log(`song: ${request.id} 回执未知，停止（不再重发）`)
      return { stage: 'unknown-send', detail: result.detail, messageId: null }
    }
    const shorter = SHORTEN_STEPS[attempt]
    if (shorter === undefined || !looksLikeLengthRejection(result.detail, cover.seconds)) {
      deps.log(`song: ${request.id} 发送失败（${result.detail}）`)
      return { stage: 'failed', detail: result.detail, messageId: null }
    }
    attempt += 1
    deps.log(`song: ${request.id} 网关不接受 ${String(cover.seconds)}s，按 ${String(shorter)}s 重做（副歌起点不变）`)
    // 通知账本"长度变了"：这一次翻唱的原因是网关拒收，不是用户改主意。
    await hooks.advance('covering', { chorusStart })
    try {
      cover = await renderCover(
        deps, audioFile, workDir, chorusStart, Math.min(shorter, config.seconds), request.keyUp, signal,
      )
    } catch (error) {
      // 缩短之后翻唱失败：这一条已经不可能发出去，按失败收场（不再继续缩短）。
      return { stage: 'failed', detail: reasonOf(error, '缩短后翻唱失败'), messageId: null }
    }
    await hooks.advance('covering', { chorusStart, seconds: cover.seconds })
  }
}

/** 错误 → 给人看的一句短话（去掉栈与路径细节）。 */
function reasonOf(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    return message === '' ? fallback : message
  }
  const text = String(error).trim()
  return text === '' ? fallback : text
}

/** 选歌候选的一句话（失败时给用户"要不要换这一条"的选项）。 */
export function shortlist(candidates: readonly SongCandidate[]): string[] {
  return candidates.map((candidate) => `${candidate.title} — ${candidate.author}（${candidate.bvid}）`)
}
