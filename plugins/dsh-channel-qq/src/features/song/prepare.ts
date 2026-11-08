/** 流水线的前三步：拿到分P → 定下这一段（起点 + 长度）→ 产出语音条。**同歌缓存的决策在这里**。
 *
 * 为什么把它从 `pipeline.ts` 拆出来：那三步合起来已经两百行（下载、定位、收句尾、翻唱、
 * 每一步的失败翻译），而 `pipeline.ts` 要压在 400 行硬上限之内，还要继续管"四步的顺序、
 * 发送三态、缩短重试"。拆的边界不是"代码变多了"，而是**职责**：这里回答"这一段是什么、
 * 有没有现成的"，`pipeline.ts` 回答"发不发得出去"。
 *
 * 缓存的三个决定，都写在这条链路的顺序里：
 *
 *   1. **`videoInfo` 省不掉**：两个缓存键里都有 `cid`（多P 视频的第一个分P 常常是预告），
 *      而 `cid` 只能从视频信息里挑。它是一次便宜的 HTTP，不是 90 秒的 python。
 *   2. **方案命中就跳过下载与定位**：`bili.downloadAudio` 与 `chorus.locate` 都不再跑。
 *   3. **音轨是"按需"的**（`LazyAudio`）：命中成品时它一次都不下载。唯一会用到它的是
 *      "网关嫌长、要继续缩短"——那时必须重做一次翻唱，而重做需要音轨。**宁可多等几秒
 *      下载，也不要因为"缓存命中所以做不了"而少发一条语音条。**
 */

import * as path from 'node:path'
import type { SongConfig } from '../../config/sections/song.js'
import { MIN_PHRASE_CLIP_SECONDS, clipLengthFor } from './phrase.js'
import {
  readClip, readPlan, rememberClip, rememberPlan, type CacheContext,
} from './cache-flow.js'
import { SongStepError } from './types.js'
import type { BiliPage, CoverResult, SongRequest } from './types.js'
import type { PipelineDeps, PipelineHooks } from './pipeline.js'

/** 音轨的"按需"来源：命中缓存时先不下载，真要重做才下（一次 HTTP，几秒）。 */
export interface LazyAudio {
  /** 已经下好了就是那个路径，否则 `null`。 */
  readonly file: () => string | null
  readonly get: () => Promise<string>
}

/** 前三步的产物。`cover` 可能来自缓存，也可能是刚做出来的。 */
export interface Prepared {
  readonly chorusStart: number
  readonly cover: CoverResult
  /** 网关嫌长要重做时取音轨：命中缓存的那条路会到这时才真的下载。 */
  readonly ensureAudio: () => Promise<string>
  /** 重做出来的成品也进缓存（`seconds` 不同 → 天然是另一个键）。 */
  readonly rememberClip: (cover: CoverResult) => Promise<void>
}

/** 这次要裁的那一段：起点与句尾（`phaseEnds` 只用于收尾，不进缓存）。 */
interface ChorusSpan {
  readonly start: number
  readonly phraseEnds: readonly number[]
}

/** 定下来的方案：起点、长度、置信度，以及它是不是从方案缓存里读出来的。 */
interface ChorusPlan {
  readonly chorusStart: number
  readonly seconds: number
  readonly confidence: number
  readonly fromCache: boolean
}

/** 挑分P：优先 part 里带歌名的那个，否则第一个。多P 视频里第一个常常是预告。 */
function pickPage(pages: readonly BiliPage[], song: string): BiliPage | null {
  if (pages.length === 0) return null
  const key = song.trim().toLowerCase()
  if (key !== '') {
    const hit = pages.find((page) => page.part.toLowerCase().includes(key))
    if (hit !== undefined) return hit
  }
  return pages[0] ?? null
}

/**
 * 建一条"按需下载"的音轨：第一次 `get()` 才落盘，之后复用同一个文件。
 *
 * 失败也翻译成 `downloading` 这一步的错误（`runTask` 会记成 `failed` 并带上原因）；
 * 失败之后 `get()` 可以再试一次——缩短重试是这条链路上唯一会重试的地方，它值得一次机会。
 */
function lazyAudio(
  deps: PipelineDeps,
  bvid: string,
  cid: number,
  workDir: string,
  signal: AbortSignal,
  config: SongConfig,
): LazyAudio {
  const dest = path.join(workDir, 'audio.wav')
  let current: string | null = null
  let pending: Promise<string> | null = null
  const start = async (): Promise<string> => {
    try {
      await deps.bili.downloadAudio(bvid, cid, dest, {
        timeoutMs: config.downloadTimeoutMs, signal,
      }).catch((error: unknown) => {
        throw new SongStepError('downloading', downloadHint(reasonOf(error, '下载音轨失败')))
      })
      current = dest
      return dest
    } finally {
      pending = null
    }
  }
  return {
    file: () => current,
    get: async () => {
      if (current !== null) return current
      const started = pending ?? start()
      pending = started
      return await started
    },
  }
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

/** 副歌起点：用户给了就直接用；否则定位；不可靠按"这一步失败"处理。 */
async function locateChorus(
  deps: PipelineDeps,
  request: SongRequest,
  audioFile: string,
  config: SongConfig,
  signal: AbortSignal,
): Promise<ChorusSpan & { readonly confidence: number }> {
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
  return { start: pick.startSeconds, phraseEnds: pick.phraseEnds, confidence: pick.confidence }
}

/**
 * 这次要裁多长：在不超过 `config.seconds` 的前提下尽量收在一句歌词的结束处。
 *
 * 兜底与日志都在一起：没有可用句尾（空数组、全越界、太平给不出）时退回上限，
 * 并且**明说**是按上限硬切——否则"为什么这条正好 59.0 s"只能靠猜。
 */
function clipSecondsFor(
  deps: PipelineDeps,
  request: SongRequest,
  span: ChorusSpan,
  config: SongConfig,
): number {
  // 下限不许高过上限：操作员可以把上限调到 10 s，那时"至少 20 秒"是自相矛盾的。
  const minSeconds = Math.min(MIN_PHRASE_CLIP_SECONDS, config.seconds)
  const seconds = clipLengthFor(span.start, span.phraseEnds, config.seconds, minSeconds)
  if (seconds < config.seconds) {
    deps.log(`song: ${request.id} 收在句尾：${span.start.toFixed(1)}s + ${seconds.toFixed(1)}s`
      + `（上限 ${String(config.seconds)}s，候选句尾 ${String(span.phraseEnds.length)} 个）`)
  } else {
    deps.log(`song: ${request.id} 没找到句尾，按 ${String(config.seconds)}s 硬切`)
  }
  return seconds
}

/** 跑翻唱；失败统一翻译（python 崩了 / 超时 / 产物校验不过都是"这一步没做成"）。 */
export async function renderCover(
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
 * 缓存的决策入口：没开开关或没注入端口，就是"没有缓存"（行为与加缓存之前逐字一致）。
 *
 * `cacheEnabled=false` 的判断放在这里而不是装配期：配置是热生效的，改完立刻该起作用，
 * 不该等子插件重挂。
 */
function cacheContextOf(
  deps: PipelineDeps,
  request: SongRequest,
  bvid: string,
  cid: number,
  config: SongConfig,
): CacheContext | null {
  const cache = deps.cache
  if (cache === undefined || !config.cacheEnabled) return null
  return {
    cache, log: deps.log, taskId: request.id, bvid, cid,
    keyUp: request.keyUp, maxSeconds: config.seconds, minConfidence: config.minConfidence,
  }
}

/**
 * 定下这一段：用户给的时间 → 方案缓存 → 真定位。
 *
 * 用户给的时间**优先于缓存**：那是这一次的明确要求，不是"上次的结论"。它也照样进
 * 成品缓存的查找（键里是起点与长度，与人怎么得出它无关）。
 */
async function planFor(
  deps: PipelineDeps,
  request: SongRequest,
  hooks: PipelineHooks,
  signal: AbortSignal,
  audio: LazyAudio,
  config: SongConfig,
  cache: CacheContext | null,
): Promise<ChorusPlan> {
  if (request.chorusAt !== null && Number.isFinite(request.chorusAt) && request.chorusAt >= 0) {
    deps.log(`song: ${request.id} 用用户给的副歌时间 ${request.chorusAt.toFixed(1)}s`)
    // 用户给的时间点没有配套的句尾：这一条按上限硬切（不猜句子边界）。
    const span: ChorusSpan = { start: request.chorusAt, phraseEnds: [] }
    return { chorusStart: span.start, seconds: clipSecondsFor(deps, request, span, config), confidence: 1, fromCache: false }
  }
  if (cache !== null) {
    const hit = await readPlan(cache)
    if (hit !== null) {
      deps.log(`song: ${request.id} 方案命中缓存（跳过下载与副歌定位，上次副歌 `
        + `${hit.chorusStart.toFixed(1)}s / ${hit.seconds.toFixed(1)}s）`)
      return { ...hit, fromCache: true }
    }
  }
  await hooks.advance('chorus')
  const pick = await locateChorus(deps, request, await audio.get(), config, signal)
  return {
    chorusStart: pick.start,
    seconds: clipSecondsFor(deps, request, pick, config),
    confidence: pick.confidence,
    fromCache: false,
  }
}

/** 前三步的入口：视频信息 → 方案（缓存或定位）→ 成品（缓存或翻唱）。 */
export async function prepareSong(
  deps: PipelineDeps,
  request: SongRequest,
  hooks: PipelineHooks,
  signal: AbortSignal,
  workDir: string,
  config: SongConfig,
): Promise<Prepared> {
  const bvid = request.bvid ?? ''
  await hooks.advance('downloading', { bvid })
  if (bvid === '') throw new SongStepError('downloading', '没有可用的 BV 号（选歌那一步没给出视频）')
  const info = await deps.bili.videoInfo(bvid, signal)
  const page = pickPage(info.pages, request.song)
  if (page === null) throw new SongStepError('downloading', `${bvid} 没有可用的分P`)
  const audio = lazyAudio(deps, bvid, page.cid, workDir, signal, config)
  const cache = cacheContextOf(deps, request, bvid, page.cid, config)

  const plan = await planFor(deps, request, hooks, signal, audio, config, cache)
  await hooks.advance('chorus', { chorusStart: plan.chorusStart })

  const hit = cache === null ? null : await readClip(cache, plan.chorusStart, plan.seconds)
  if (hit !== null) {
    deps.log(`song: ${request.id} 命中缓存（跳过下载与翻唱，上次副歌 `
      + `${plan.chorusStart.toFixed(1)}s / ${plan.seconds.toFixed(1)}s）`)
    return preparedOf(plan, hit, audio, cache)
  }
  if (cache !== null) {
    deps.log(plan.fromCache
      ? `song: ${request.id} 方案命中但成品没缓存，照常翻唱（副歌 ${plan.chorusStart.toFixed(1)}s）`
      : `song: ${request.id} 缓存未命中，照常做`)
  }
  await hooks.advance('covering', { chorusStart: plan.chorusStart })
  const cover = await renderCover(
    deps, await audio.get(), workDir, plan.chorusStart, plan.seconds, request.keyUp, signal,
  )
  await hooks.advance('covering', { chorusStart: plan.chorusStart, seconds: cover.seconds })
  if (cache !== null) {
    await rememberPlan(cache, plan)
    await rememberClip(cache, cover.chorusStart, cover.seconds, cover.voiceFile)
  }
  return preparedOf(plan, cover, audio, cache)
}

/** 把"这次用的这一段 + 音轨来源 + 回写缓存"打包成 `pipeline.ts` 需要的东西。 */
function preparedOf(
  plan: ChorusPlan,
  cover: CoverResult,
  audio: LazyAudio,
  cache: CacheContext | null,
): Prepared {
  return {
    chorusStart: plan.chorusStart,
    cover,
    ensureAudio: audio.get,
    rememberClip: async (next) => {
      if (cache === null) return
      await rememberClip(cache, next.chorusStart, next.seconds, next.voiceFile)
    },
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
