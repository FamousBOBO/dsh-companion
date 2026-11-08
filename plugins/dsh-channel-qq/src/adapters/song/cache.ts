/** 同歌缓存适配器：两层键值 + `ffprobe` 时长核对 + 按"最久没用"淘汰。
 *
 * 为什么缓存要有这么一层（而不是在 `features/` 里直接读写文件）：三件事都是 IO 知识——
 * 文件怎么落（原子写、临时文件、`rename` 在 Windows 上会偶发 EPERM）、时长怎么核
 * （`ffprobe` 的输出形状）、旧条目怎么删（列目录 + 读记账）。`check-layers` 的 R4
 * 也把"整份覆盖写"收在 `adapters/`；`features/` 只做"这次用不用缓存"的决策。
 *
 * 布局（`<dshHome>/channel-qq/song-cache/`，`data/` 已 gitignore）：
 *
 *     plans/<方案键>.json      {chorusStart, seconds, confidence, savedAt, lastUsedAt}
 *     clips/<成品键>.mp3       语音条本体（约 0.4–1 MB）
 *     clips/<成品键>.json      记账 {bytes, savedAt, lastUsedAt}
 *
 * 三个必须写下来的判据：
 *
 *   1. **命中前一定量时长**（`getClip` 里 `ffprobe`，容差沿用 `cover.ts` 的
 *      `DURATION_TOLERANCE_SECONDS` = 0.75 s）。缓存文件可能被手工删过一半、被安全
 *      软件截断、被磁盘写坏——**发出半条语音条比慢 90 秒糟得多**，所以时长对不上
 *      就当未命中，并把那条删掉（不删的话每次命中都白量一次）。
 *   2. **有文件没记账 / 有记账没文件，都算孤儿**：前者是写到一半被打断，后者是
 *      文件被手工删了。两种都在 `prune` 里清掉，并且只记一行日志——缓存清理出错
 *      绝不能变成"这条点歌失败"。
 *   3. **记账用 `lastUsedAt`（命中时刷新）而不是 `savedAt`**：淘汰要按"最久没用"，
 *      否则常点的那首歌会因为"做的时间早"被反复淘汰，等于缓存对它从来没生效。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { atomicWriteJson, readJsonFileOrNull } from '../fs-store/atomic.js'
import { DURATION_TOLERANCE_SECONDS, ffprobeOf, probeDuration } from './cover.js'
import { clipCacheKey, planCacheKey } from '../../features/song/cache-key.js'
import type {
  CachedClip, ProcessPort, SongCachePort, SongPlanRecord,
} from '../../features/song/types.js'

export interface SongCacheOptions {
  /** 缓存根（`<dshHome>/channel-qq/song-cache`）。 */
  readonly root: string
  readonly process: ProcessPort
  /** `ffmpeg` 路径：`ffprobe` 与它同目录、同名不同前缀（与 `cover.ts` 同一套推导）。 */
  readonly ffmpegPath: string
  readonly log: (line: string) => void
  /** 每层最多几条（配置热生效：每次淘汰现取）。 */
  readonly maxEntries: () => number
  /** 现在几毫秒（`lastUsedAt` 用）；由装配侧注入，测试可给固定值。 */
  readonly now: () => number
  /** `ffprobe` 的超时（毫秒）。它只是读一个头，15 s 已经极宽。 */
  readonly probeTimeoutMs?: number
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000

/** 方案文件的磁盘形状（比 `SongPlanRecord` 多两个记账字段）。 */
interface PlanFile extends SongPlanRecord {
  readonly savedAt: number
  readonly lastUsedAt: number
}

/** 成品记账的磁盘形状。`bytes` 只为诊断（"缓存里那条多大"）。 */
interface ClipMetaFile {
  readonly bytes: number
  readonly savedAt: number
  readonly lastUsedAt: number
}

/** 一次清理的结果（只用来拼那一行日志）。 */
interface PruneTally {
  removed: number
  orphans: number
}

/** 一个缓存端口的全部不变事实（建一次，五个方法共用）。 */
interface Rig {
  readonly proc: ProcessPort
  readonly ffprobePath: string
  readonly probeTimeoutMs: number
  readonly plansDir: string
  readonly clipsDir: string
  readonly log: (line: string) => void
  readonly now: () => number
  readonly limit: () => number
}

function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPlanFile(value: unknown): value is PlanFile {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return isStamp(record['chorusStart']) && isStamp(record['seconds'])
    && isStamp(record['confidence']) && isStamp(record['lastUsedAt'])
}

function isClipMeta(value: unknown): value is ClipMetaFile {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return isStamp(record['bytes']) && isStamp(record['lastUsedAt'])
}

/** 列目录；不存在/读不了都当空（第一次运行就没有目录，那不该是错误）。 */
async function listNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

/** 删一个文件；删不掉也不算错（它可能本来就不存在，或正被杀毒软件占着）。 */
async function drop(file: string): Promise<void> {
  try {
    await fs.rm(file, { force: true })
  } catch {
    /* 清垃圾失败不该让任何事失败 */
  }
}

/** 方案层（只有 JSON）与成品层（mp3 + JSON）的路径拼法。 */
function metaFileOf(dir: string, key: string): string {
  return path.join(dir, `${key}.json`)
}

function bodyFileOf(dir: string, key: string): string {
  return path.join(dir, `${key}.mp3`)
}

/** 刷新"最久没用"的记账（命中时调）。记账写不进去不影响这一次命中。 */
async function touch(file: string, value: unknown): Promise<void> {
  try {
    await atomicWriteJson(file, value)
  } catch {
    /* 记账写失败只会让这条更容易被淘汰，不影响正确性 */
  }
}

/** 量一次真实时长（秒）；读不出来就抛——调用方一律翻译成"当作未命中"。 */
async function measure(rig: Rig, file: string): Promise<number> {
  const result = await rig.proc.run(rig.ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file,
  ], { timeoutMs: rig.probeTimeoutMs })
  if (result.code !== 0) {
    throw new Error(`ffprobe 退出码 ${String(result.code)}，读不到缓存文件的时长`)
  }
  return probeDuration(result.stdout)
}

/** 复制进缓存：先写同目录临时文件再改名，读者不会看到写了一半的 mp3。 */
async function copyInto(sourceFile: string, dest: string): Promise<void> {
  const tmp = `${dest}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(sourceFile, tmp)
    await fs.rename(tmp, dest)
  } catch (error) {
    await drop(tmp)
    throw error
  }
}

/** 方案层清理：损坏的 `.json` 算孤儿；超过上限的按 `lastUsedAt` 删最旧。 */
async function prunePlans(dir: string, limit: number): Promise<PruneTally> {
  const tally: PruneTally = { removed: 0, orphans: 0 }
  const entries: Array<{ name: string; lastUsedAt: number }> = []
  for (const name of await listNames(dir)) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    const record = await readJsonFileOrNull(file, isPlanFile)
    if (record === null) {
      await drop(file)
      tally.orphans += 1
      continue
    }
    entries.push({ name, lastUsedAt: record.lastUsedAt })
  }
  entries.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
  for (const stale of entries.slice(limit)) {
    await drop(path.join(dir, stale.name))
    tally.removed += 1
  }
  return tally
}

/** 成品层清理：缺一半的成对文件算孤儿；成对的按 `lastUsedAt` 删最旧（文件与记账一起删）。 */
async function pruneClips(dir: string, limit: number): Promise<PruneTally> {
  const tally: PruneTally = { removed: 0, orphans: 0 }
  const names = await listNames(dir)
  const bodies = new Set(names.filter((name) => name.endsWith('.mp3')).map((name) => name.slice(0, -4)))
  const metas = new Set(names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)))
  const entries: Array<{ key: string; lastUsedAt: number }> = []
  for (const key of bodies) {
    const meta = metas.has(key) ? await readJsonFileOrNull(metaFileOf(dir, key), isClipMeta) : null
    if (meta === null) {
      // 有文件没记账（写到一半被打断）或记账坏了：音频本身不可信，一起清掉。
      await drop(bodyFileOf(dir, key))
      await drop(metaFileOf(dir, key))
      tally.orphans += 1
      continue
    }
    entries.push({ key, lastUsedAt: meta.lastUsedAt })
  }
  for (const key of metas) {
    if (bodies.has(key)) continue
    await drop(metaFileOf(dir, key))
    tally.orphans += 1
  }
  entries.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
  for (const stale of entries.slice(limit)) {
    await drop(bodyFileOf(dir, stale.key))
    await drop(metaFileOf(dir, stale.key))
    tally.removed += 1
  }
  return tally
}

/** 淘汰 + 清孤儿。**只记一行日志，绝不抛**：清理失败不该让任何一条点歌变成失败。 */
async function pruneAll(rig: Rig): Promise<void> {
  try {
    const cap = rig.limit()
    const plans = await prunePlans(rig.plansDir, cap)
    const clips = await pruneClips(rig.clipsDir, cap)
    const removed = plans.removed + clips.removed
    const orphans = plans.orphans + clips.orphans
    if (removed + orphans === 0) return
    rig.log(`song-cache: 淘汰 ${String(removed)} 条、清掉 ${String(orphans)} 个孤儿`
      + `（上限 ${String(cap)} 条/层，按最久没用）`)
  } catch (error) {
    rig.log(`song-cache: 清理出错（${error instanceof Error ? error.message : String(error)}），缓存继续用`)
  }
}

async function getPlanOf(rig: Rig, key: string): Promise<SongPlanRecord | null> {
  const file = metaFileOf(rig.plansDir, key)
  const record = await readJsonFileOrNull(file, isPlanFile)
  if (record === null) {
    // 不存在（rm 是空操作）或半截 JSON：都清掉，别让坏记录每次都被读一遍。
    await drop(file)
    return null
  }
  await touch(file, { ...record, lastUsedAt: rig.now() })
  return { chorusStart: record.chorusStart, seconds: record.seconds, confidence: record.confidence }
}

async function putPlanOf(rig: Rig, key: string, value: SongPlanRecord): Promise<void> {
  const stamp = rig.now()
  await atomicWriteJson(metaFileOf(rig.plansDir, key), { ...value, savedAt: stamp, lastUsedAt: stamp })
  await pruneAll(rig)
}

/**
 * 读成品。**时长核对在这里**：文件与记账缺一半、读不出时长、时长与期望差超过容差，
 * 三种都删掉这条并返回 `null`。`expectedSeconds` 不合法时直接当未命中（没东西可比）。
 */
async function getClipOf(rig: Rig, key: string, expectedSeconds: number): Promise<CachedClip | null> {
  if (!Number.isFinite(expectedSeconds)) return null
  const body = bodyFileOf(rig.clipsDir, key)
  const metaFile = metaFileOf(rig.clipsDir, key)
  const stat = await fs.stat(body).catch(() => null)
  const meta = await readJsonFileOrNull(metaFile, isClipMeta)
  if (stat === null || !stat.isFile() || meta === null) {
    // 缺一半：文件被手工删了、或记账没写成功。两种都清干净再当未命中。
    await drop(body)
    await drop(metaFile)
    return null
  }
  const durationSeconds = await measure(rig, body).catch(() => null)
  if (durationSeconds === null) {
    await drop(body)
    await drop(metaFile)
    rig.log(`song-cache: 缓存文件读不出时长，已删掉这条（${path.basename(body)}）`)
    return null
  }
  if (Math.abs(durationSeconds - expectedSeconds) > DURATION_TOLERANCE_SECONDS) {
    await drop(body)
    await drop(metaFile)
    rig.log(`song-cache: 缓存时长 ${durationSeconds.toFixed(2)}s 与期望 ${expectedSeconds.toFixed(2)}s`
      + ` 相差超过 ${String(DURATION_TOLERANCE_SECONDS)}s，已删掉这条（半条语音条比慢一点糟得多）`)
    return null
  }
  await touch(metaFile, { ...meta, bytes: stat.size, lastUsedAt: rig.now() })
  return { file: body, durationSeconds }
}

async function putClipOf(rig: Rig, key: string, sourceFile: string): Promise<void> {
  const body = bodyFileOf(rig.clipsDir, key)
  const stamp = rig.now()
  // 源文件就是缓存本体时（命中之后又把同一条落回来）只刷新记账，不重拷一份。
  if (path.resolve(sourceFile) !== path.resolve(body)) await copyInto(sourceFile, body)
  const stat = await fs.stat(body).catch(() => null)
  if (stat === null) throw new Error(`缓存文件没写成功：${path.basename(body)}`)
  await atomicWriteJson(metaFileOf(rig.clipsDir, key), { bytes: stat.size, savedAt: stamp, lastUsedAt: stamp })
  await pruneAll(rig)
}

export function createSongCachePort(options: SongCacheOptions): SongCachePort {
  const rig: Rig = {
    proc: options.process,
    ffprobePath: ffprobeOf(options.ffmpegPath),
    probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    plansDir: path.join(options.root, 'plans'),
    clipsDir: path.join(options.root, 'clips'),
    log: options.log,
    now: options.now,
    limit: () => Math.max(1, Math.floor(options.maxEntries())),
  }
  return {
    planKey: planCacheKey,
    clipKey: clipCacheKey,
    getPlan: async (key) => await getPlanOf(rig, key),
    putPlan: async (key, value) => { await putPlanOf(rig, key, value) },
    getClip: async (key, expectedSeconds) => await getClipOf(rig, key, expectedSeconds),
    putClip: async (key, sourceFile) => { await putClipOf(rig, key, sourceFile) },
    prune: async () => { await pruneAll(rig) },
  }
}
