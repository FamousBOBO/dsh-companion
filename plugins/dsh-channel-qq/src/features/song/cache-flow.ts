/** 同歌缓存的**决策层**：查什么、什么时候信、什么时候落盘。IO 全在 `adapters/song/cache.ts`。
 *
 * 为什么这一层不直接写盘：`check-layers` 的 R4/R8 把"整份写文件"与"读时钟"收在
 * `adapters/`，而 `features/` 只该回答"这次要不要用缓存"。于是这里的每个函数都
 * 只做两件事：**调端口**、**在日志里说清楚为什么这次快/为什么这次照旧**。
 *
 * 三处刻意的取舍：
 *
 *   1. **缓存不是承诺，失败一律当"没有缓存"**。读不了、写不进、键算不出来，
 *      都只记一行日志然后照常跑完整链路——一次读盘失败不该让一首歌做不出来。
 *   2. **置信度门槛是"现在"的**。方案里存着上次的 `confidence`，命中时用**当前**
 *      `minConfidence` 再判一次：门槛调高之后旧记录必须立刻失效，否则"我把门槛提到
 *      0.8"就变成一句空话（旧方案仍然会被当成可靠）。
 *   3. **命中时的日志要能回答"为什么这次很快"**。所以两种情况分开说：
 *      连下载都省了（成品命中）与只省了翻唱（定位之后才命中）。
 */

import type { CoverResult, SongCachePort, SongPlanRecord } from './types.js'

/** 一次任务里与缓存有关、且不随步骤变化的事实（`prepare.ts` 建一次）。 */
export interface CacheContext {
  readonly cache: SongCachePort
  readonly log: (line: string) => void
  /** 任务 id（日志前缀用；缓存本身**不按任务区分**）。 */
  readonly taskId: string
  readonly bvid: string
  readonly cid: number
  readonly keyUp: number
  /** 语音条长度上限（`song.seconds`）；它进方案键。 */
  readonly maxSeconds: number
  /** 副歌定位置信度门槛（`song.minConfidence`）；命中时按**当前**值复判。 */
  readonly minConfidence: number
}

/** 方案命中/定位得出的这一段：起点、长度、置信度。 */
export interface SongPlanFacts {
  readonly chorusStart: number
  readonly seconds: number
  readonly confidence: number
}

/** 错误 → 一句短话（日志用；不带栈）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 查方案缓存。返回 `null` = 当作没有缓存（没这条、坏了、或置信度不够当前门槛）。
 *
 * 命中时**不**在这里打"命中缓存"那句话：真正的收益是"连下载都省了"，
 * 那要等成品层也命中才成立（见 `prepare.ts`）。这里只说明定位被跳过。
 */
export async function readPlan(ctx: CacheContext): Promise<SongPlanFacts | null> {
  const key = ctx.cache.planKey(ctx.bvid, ctx.cid, ctx.keyUp, ctx.maxSeconds)
  let record: SongPlanRecord | null
  try {
    record = await ctx.cache.getPlan(key)
  } catch (error) {
    ctx.log(`song: ${ctx.taskId} 读方案缓存出错（${reasonOf(error)}），当作没有缓存`)
    return null
  }
  if (record === null) return null
  if (record.confidence < ctx.minConfidence) {
    // 门槛调高之后旧方案不再可靠：宁可重做一次定位（几秒），也不要发一段当时就"不够可靠"的副歌。
    ctx.log(`song: ${ctx.taskId} 方案缓存的置信度 ${record.confidence.toFixed(2)} 低于当前门槛 `
      + `${ctx.minConfidence.toFixed(2)}，当作没有缓存`)
    return null
  }
  return { chorusStart: record.chorusStart, seconds: record.seconds, confidence: record.confidence }
}

/**
 * 查成品缓存。命中就得到一个**可以直接发送**的 `CoverResult`（`voiceFile` 指向缓存文件）。
 *
 * 时长核对不在这里：`getClip` 内部用 `ffprobe` 比过，差太多会把那条缓存删掉并返回
 * `null`——"半条语音条"这种事故必须在适配器那一层就被挡住，而不是靠调用方记得查。
 */
export async function readClip(
  ctx: CacheContext,
  chorusStart: number,
  seconds: number,
): Promise<CoverResult | null> {
  const key = ctx.cache.clipKey(ctx.bvid, ctx.cid, ctx.keyUp, chorusStart, seconds)
  let clip: { readonly file: string; readonly durationSeconds: number } | null
  try {
    clip = await ctx.cache.getClip(key, seconds)
  } catch (error) {
    ctx.log(`song: ${ctx.taskId} 读成品缓存出错（${reasonOf(error)}），当作没有缓存`)
    return null
  }
  if (clip === null) return null
  return {
    voiceFile: clip.file,
    durationSeconds: clip.durationSeconds,
    chorusStart,
    seconds,
    keyUp: ctx.keyUp,
    // 缓存命中的产物没有这次运行的 summary：写明来源，别让诊断把它当成一台新跑出来的。
    summary: { cache: 'hit', source: 'song-cache' },
  }
}

/** 落方案缓存（只有真定位出来/用户给了时间之后才写；命中时不用重写）。 */
export async function rememberPlan(ctx: CacheContext, plan: SongPlanFacts): Promise<void> {
  const key = ctx.cache.planKey(ctx.bvid, ctx.cid, ctx.keyUp, ctx.maxSeconds)
  try {
    await ctx.cache.putPlan(key, plan)
  } catch (error) {
    ctx.log(`song: ${ctx.taskId} 写方案缓存失败（${reasonOf(error)}），不影响这一条`)
  }
}

/**
 * 落成品缓存（短视频也会落到自己的键下：`seconds` 在键里）。
 *
 * `sourceFile` 是任务目录里的 `voice.mp3`——任务结束时它会被删，所以必须复制一份。
 */
export async function rememberClip(
  ctx: CacheContext,
  chorusStart: number,
  seconds: number,
  sourceFile: string,
): Promise<void> {
  const key = ctx.cache.clipKey(ctx.bvid, ctx.cid, ctx.keyUp, chorusStart, seconds)
  try {
    await ctx.cache.putClip(key, sourceFile)
  } catch (error) {
    ctx.log(`song: ${ctx.taskId} 写成品缓存失败（${reasonOf(error)}），不影响这一条`)
  }
}
