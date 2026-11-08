/** 一条点歌任务的流水线：**发送**与"网关嫌长怎么办"。前三步（下载/定位/翻唱）在 `prepare.ts`。
 *
 * 为什么把这个文件拆成两半：四步里前三步的产物只喂给下一步，而第四步的判据完全不同
 * ——它要过闸门、要处理"发出去了但没回执"、要在网关嫌长时**保持同一个副歌起点**缩短重做。
 * 前一半回答"这一段音频是什么"（含同歌缓存的决策），后一半回答"发不发得出去"。
 *
 * 三个必须写明的取舍：
 *
 *   1. **副歌定位失败不是"点歌失败"**（私聊入口）：上层会回一句"没找准副歌，
 *      给我一个时间点或换一条视频"。所以 `prepare.ts` 把"定位不可靠"与"定位脚本坏了"
 *      都收敛成同一个 `SongStepError('chorus')`，由上层按入口决定说法。
 *   2. **发送有三态，只有一态会重发**：`ok` 记 `sent`、确定失败记 `failed`、
 *      回执未知记 `unknown-send` 且**绝不重发**。网关嫌语音条长时的缩短重试
 *      只在"确定失败 + 看起来是长度问题"时做，且**保持同一个副歌起点**。
 *   3. **闸门在发送之前**，而不是在入队时：一首歌要跑两三分钟，授权、免打扰、
 *      日上限这些判据必须用**发送那一刻**的事实（那时用户可能刚说了话、
 *      或者管理员刚把开关关了）。入队时只判"队列满不满"。
 *
 * 同歌缓存对这里的唯一影响：命中时音轨还没下载，缩短重试需要它时**才**去下
 * （`Prepared.ensureAudio`）。缓存不能变成"网关嫌长时就没法重做"的理由。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Clock } from '../../ports/clock.js'
import type { SongConfig } from '../../config/sections/song.js'
import type {
  BiliPort, ChorusPort, CoverPort, SendGatePort, SongCandidate, SongCachePort, SongRequest,
  SongStage, VoicePort,
} from './types.js'
import { SongStepError } from './types.js'
import { prepareSong, renderCover, type Prepared } from './prepare.js'

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
  /**
   * 同歌缓存（**可选**）。没注入或 `cacheEnabled=false` 时完全按老路走：
   * 四步一次不省。做成可选是为了让既有测试与 `e2e-acceptance` 不必改。
   */
  readonly cache?: SongCachePort
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

/** 网关嫌长时的缩短短度阶梯（都保持同一个副歌起点）。
 *
 * 档位按 59 s 的基线往下排：45 s 已经明显短了但还是一整段副歌，30/20/15 是最后几档。
 * 每一档都比上一档短一大截——网关的上限是个数，卡在一两秒的差别上重做一次翻唱
 * （本机约 70 秒）换不来任何东西。 */
const SHORTEN_STEPS = [45, 30, 20, 15] as const
/** 短于这个长度就不再尝试缩短：再短就听不出是副歌了。
 *
 * 阶梯自己也会走完（最后一档 15 s），所以它是"下限的下限"——网关连 15 s 都不收时，
 * 多半不是长度问题，重做一次翻唱只会白花 70 秒。 */
const SHORTEST_SECONDS = 10

/** `prepare.ts` 的实现（下载/定位/翻唱/缓存决策）；这个文件只负责顺序与发送。 */
export { downloadHint } from './prepare.js'

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

/**
 * 整条链路：前三步交给 `prepare.ts`（含缓存），这里只把成品送出去。
 *
 * 账本阶段**可以跳步**（命中缓存时 `chorus` / `covering` 不一定被推进），但终态不变：
 * 成功就是 `sent`。`SongStage` 是稳定枚举，不为缓存新增阶段——那会动账本校验与
 * `stageText`，而"这次快是因为缓存"是日志的事，不是账本的事。
 */
async function walk(
  deps: PipelineDeps,
  request: SongRequest,
  hooks: PipelineHooks,
  signal: AbortSignal,
  workDir: string,
): Promise<PipelineOutcome> {
  const prepared = await prepareSong(deps, request, hooks, signal, workDir, deps.config())
  // 发送之前**再查一次取消**：前面的翻唱要跑一两分钟，这期间用户完全可能改主意。
  // 少了这一查，"取消"只是"不再看结果"——语音条照样会发出去。
  await step(signal, 'sending', '取消（发送之前）')
  await hooks.advance('sending', { chorusStart: prepared.chorusStart, seconds: prepared.cover.seconds })
  return await deliver(deps, request, prepared, workDir, hooks, signal)
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

/** 第 4 步：过闸门，然后发送（被拦下就说清楚是哪一道）。 */
async function deliver(
  deps: PipelineDeps,
  request: SongRequest,
  prepared: Prepared,
  workDir: string,
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
  return await sendWithShortenRetry(deps, request, prepared, workDir, hooks, signal)
}

/** 删任务目录（失败只记一行日志：清理不该把成功变成失败）。 */
async function removeWorkDir(deps: PipelineDeps, workDir: string): Promise<void> {
  await fs.rm(workDir, { recursive: true, force: true }).catch((error: unknown) => {
    deps.log(`song: 清理任务目录失败（${reasonOf(error, '删除失败')}）`)
  })
}

/**
 * 发送 + "网关嫌长"时的缩短重试。
 *
 * **缩短只改长度，不改起点**：`chorusStart` 一路不变，所以第二次听到的仍然是副歌开头。
 * 重试次数上限就是 `SHORTEN_STEPS` 的长度，且**只对确定失败**重试——回执未知一律
 * 直接停止（那条可能已经到了）。
 *
 * 重做出来的那一条也进缓存：它的 `seconds` 与原来不同，所以在成品缓存里天然是另一个键。
 * 下次同一首歌被同一个网关同样拒收时，连缩短这一步都不必重跑。
 */
async function sendWithShortenRetry(
  deps: PipelineDeps,
  request: SongRequest,
  prepared: Prepared,
  workDir: string,
  hooks: PipelineHooks,
  signal: AbortSignal,
): Promise<PipelineOutcome> {
  const config = deps.config()
  let cover = prepared.cover
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
    await hooks.advance('covering', { chorusStart: prepared.chorusStart })
    try {
      // 命中缓存时音轨还没下载：这里才去下（一次 HTTP，几秒），而不是因为缓存而做不成。
      const audioFile = await prepared.ensureAudio()
      cover = await renderCover(
        deps, audioFile, workDir, prepared.chorusStart, Math.min(shorter, config.seconds), request.keyUp, signal,
      )
      await prepared.rememberClip(cover)
    } catch (error) {
      // 缩短之后翻唱失败：这一条已经不可能发出去，按失败收场（不再继续缩短）。
      return { stage: 'failed', detail: reasonOf(error, '缩短后翻唱失败'), messageId: null }
    }
    await hooks.advance('covering', { chorusStart: prepared.chorusStart, seconds: cover.seconds })
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
