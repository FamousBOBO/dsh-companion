/** 同歌缓存的两层记录 + 端口契约（从 `types.ts` 拆出来，只因后者逼近 400 行硬上限）。
 *
 * 为什么单独一个文件：`types.ts` 是这条链路的共享词汇表，它已经到 400 行；
 * 缓存这一组（`SongPlanRecord` / `CachedClip` / `SongCachePort`）自成一簇——
 * 只有 `cache-flow.ts` 与 `adapters/song/cache.ts` 用得上。拆出来之后 `types.ts`
 * 仍从本文件 **re-export**，所以既有的 `import ... from './types.js'` 一行都不用改。
 */

/** 第一层（方案缓存）的记录：这首歌在这个音高与长度上限下，上次切的是哪一段。 */
export interface SongPlanRecord {
  /** 副歌起点（秒，相对整条音轨）。 */
  readonly chorusStart: number
  /** 上次裁出来的语音条长度（秒）。 */
  readonly seconds: number
  /** 上次定位的置信度（0..1）：门槛调高之后，旧记录必须能被判成"不再可靠"。 */
  readonly confidence: number
}

/** 第二层（音频缓存）的命中结果：文件已在盘上，时长已由适配器核过。 */
export interface CachedClip {
  /** 缓存文件（绝对路径，可直接交给 `VoicePort.sendVoice`）。 */
  readonly file: string
  /** `ffprobe` 实测时长（秒）；与期望值差超过容差时**不会**被返回（见适配器）。 */
  readonly durationSeconds: number
}

/**
 * 同歌缓存（两层，都落在 `<dshHome>/channel-qq/song-cache/`）。实现见 `adapters/song/cache.ts`。
 *
 * 三条契约（细节与理由见适配器头注释）：
 *   1. **命中也要量时长**：缓存文件可能被手工删一半、被安全软件截断、磁盘写坏——
 *      "半条语音条"必须在适配器那层就被挡住，不能靠调用方记得查。
 *   2. **时长不对就当未命中并删掉这条**。
 *   3. 键由 `planKey` / `clipKey` 生成，**必须带算法版本标签**（见 `cache-key.ts`）：
 *      改了分离器/模型/裁剪逻辑之后，旧缓存要被判成过期，而不是被当成有效结果复用。
 */
export interface SongCachePort {
  /** 方案键：`bvid | cid | keyUp | maxSeconds | PLAN_ALGO_TAG`。 */
  planKey(bvid: string, cid: number, keyUp: number, maxSeconds: number): string
  /** 成品键：`bvid | cid | keyUp | chorusStart | seconds | 分离上下文 | COVER_ALGO_TAG`。 */
  clipKey(
    bvid: string,
    cid: number,
    keyUp: number,
    chorusStart: number,
    seconds: number,
    separationMark: string,
  ): string
  /** 读方案；没有/损坏返回 `null`（不抛），命中时刷新"最久没用"的记账。 */
  getPlan(key: string): Promise<SongPlanRecord | null>
  /** 写方案（命中时用不到，只在真的定位成功之后写）。 */
  putPlan(key: string, value: SongPlanRecord): Promise<void>
  /**
   * 读成品。**内部用 `ffprobe` 核对时长**：与 `expectedSeconds` 差超过容差就删掉这条
   * 并返回 `null`（当作未命中）。
   */
  getClip(key: string, expectedSeconds: number): Promise<CachedClip | null>
  /** 把做好的语音条收进缓存（复制一份；源文件属于任务目录，任务结束就删）。 */
  putClip(key: string, sourceFile: string): Promise<void>
  /** 按"最久没用"淘汰到 `cacheMaxEntries`，并清掉孤儿文件；**只记一行日志，不抛**。 */
  prune(): Promise<void>
}
