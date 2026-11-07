/** 自主选歌与后台点歌表：两件"不是用户发起"的事。
 *
 * 为什么单独一个文件：它们与 `index.ts` 的装配是两种责任——
 *   - `autoPickOnce()` 是**被动入口**：由主动联系在它自己的节拍上调用一次，
 *     挑一首歌、走同一个队列。它不起定时器、不自己判"现在能不能发"；
 *   - `registerResource()` 是**诊断入口**：后台「音乐」页看到的那张表。
 *
 * 两者都不持有自己的状态，全部经由装配期的 `WeakMap` 拿到同一个队列与 B站适配器。
 * 这样"自主选歌"与"私聊点歌"用的是**同一个串行队列、同一套闸门、同一本账**——
 * 两条路径各有各的队列，就必然会各发一条。
 */

import * as path from 'node:path'
import { songDayKey, rotationIndex } from './day.js'
import { keyUpFor } from './gender.js'
import { selectSource } from './tools.js'
import type { SongQueue } from './queue.js'
import type { BiliPort } from './types.js'
import type { SongConfig } from '../../config/sections/song.js'
import type { Clock } from '../../ports/clock.js'
import type { SubHost } from '../plugin-kit.js'

/** 装配期存下来的运行时（`index.ts` 写，这里读）。 */
export interface SongRuntime {
  readonly queue: SongQueue
  readonly bili: BiliPort
}

/** 一个 host 一份运行时；子插件重挂时自然被替换。 */
export const runtimes = new WeakMap<SubHost, SongRuntime>()

/** `歌名 歌手` → 两段（第一段是歌名，其余是歌手；歌名里通常没有空格）。 */
export function splitPoolEntry(entry: string): [string, string] {
  const parts = entry.trim().split(/\s+/)
  const song = parts[0] ?? ''
  return [song, parts.slice(1).join(' ').trim()]
}

/** 一次自主选歌要用的材料：干净曲目池、主人、日期、队列。`null` = 这一轮不做（理由已记录）。 */
interface AutoFacts {
  readonly runtime: SongRuntime
  readonly ownerId: number
  readonly day: string
  readonly pool: readonly string[]
  /** 本次生效的点歌配置（`preferFemale` / `maleKeyUp` 要一起带下去）。 */
  readonly config: SongConfig
}

/**
 * 收齐"能不能做"的前置事实。每一处"不做"都写一句只有这里会说的理由——
 * 自主行为最容易被误会成坏了，而实际原因常常只是"曲目没填"。
 */
async function collectFacts(
  host: SubHost,
  clock: Clock,
  say: (line: string) => void,
): Promise<AutoFacts | null> {
  const config: SongConfig = host.config.song
  if (!config.enabled || !config.autoPick) return null
  const runtime = runtimes.get(host)
  if (runtime === undefined) {
    say('song: 自主选歌跳过（外部环境未配置）')
    return null
  }
  const pool = config.autoSongs.filter((item) => item.trim() !== '')
  if (pool.length === 0) {
    say('song: 自主选歌跳过（曲目为空）')
    return null
  }
  const ownerId = host.config.admins[0]
  if (ownerId === undefined) {
    say('song: 自主选歌跳过（没有配主人 QQ）')
    return null
  }
  const day = songDayKey(clock.now())
  if (day === null) {
    say('song: 自主选歌跳过（算不出今天的日期）')
    return null
  }
  if (await runtime.queue.autoQuotaLeft(day) <= 0) {
    say('song: 自主选歌跳过（今天的额度已用完）')
    return null
  }
  return { runtime, ownerId, day, pool, config }
}

/**
 * 自主选歌：主动联系调用它一次。成功入队返回 true；没做/被拦/失败都 false。
 *
 * 每一次"不做"都有一句具体理由（日志里能看到），因为自主行为最容易被误会成
 * "坏了"——而实际原因往往是"今天的额度用完了"或"曲目没填"。
 */
export async function autoPickOnce(
  host: SubHost,
  clock: Clock,
  log?: (line: string) => void,
): Promise<boolean> {
  const say = log ?? ((line: string): void => { host.log(line) })
  const facts = await collectFacts(host, clock, say)
  if (facts === null) return false

  // 按日期轮换：同一天永远是同一首（可复现，也不会"重试时换歌"）。
  const [song, artist] = splitPoolEntry(facts.pool[rotationIndex(facts.day, facts.pool.length)] ?? '')
  if (song === '') return false
  const room = `dm-${String(facts.ownerId)}`
  say(`song: 自主选歌「${song}${artist === '' ? '' : ` / ${artist}`}」（${facts.day}）`)
  return await submitAuto(facts, { song, artist, room }, say)
}

/** 选源 + 入队。与私聊入口共用同一套判据：分不出唯一原唱就跳过这一轮（不猜）。 */
async function submitAuto(
  facts: AutoFacts,
  pick: { song: string; artist: string; room: string },
  say: (line: string) => void,
): Promise<boolean> {
  try {
    const selection = await selectSource(facts.runtime.bili, pick.song, pick.artist, '', say, {
      preferFemale: facts.config.preferFemale,
    })
    if (selection.chosen === null) {
      say(`song: 自主选歌「${pick.song}」分不出唯一原唱，跳过这一轮（不猜）`)
      return false
    }
    // 与私聊入口同一条准则：尽量女声；确定是男声才升八度。
    const keyUp = facts.config.preferFemale ? keyUpFor(selection.gender, facts.config.maleKeyUp) : 0
    const result = await facts.runtime.queue.enqueue({
      id: `auto-${facts.day}-${String(facts.ownerId)}`,
      entry: 'auto',
      room: pick.room,
      chatId: facts.ownerId,
      dedupeKey: `auto:${facts.day}:${pick.room}`,
      song: pick.song,
      artist: pick.artist,
      bvid: selection.chosen.bvid,
      chorusAt: null,
      keyUp,
      requestedAt: Date.now(),
    })
    if (!result.accepted) say(`song: 自主选歌未受理（${result.note}）`)
    else say(`song: 自主选歌入队（${selection.chosen.bvid}，keyUp=${String(keyUp)}）`)
    return result.accepted
  } catch (error) {
    say(`song: 自主选歌失败（${error instanceof Error ? error.message : String(error)}）`)
    return false
  }
}

/** 后台「音乐」页的点歌表：最近几条 + 环境状态（**只读**，真发不由它决定）。 */
export function registerSongResource(
  host: SubHost,
  queue: SongQueue,
  config: () => SongConfig,
  dshHome: string,
): void {
  host.registerResource('song', {
    label: '点歌翻唱',
    list: async () => ({
      enabled: config().enabled,
      autoPick: config().autoPick,
      dryRun: config().dryRun,
      allowExternalSend: config().allowExternalSend,
      seconds: config().seconds,
      autoSongs: config().autoSongs,
      workRoot: path.join(dshHome, 'channel-qq', 'song'),
      tasks: queue.status(20),
    }),
    actions: {
      cancel: async (body) => {
        const taskId = String(body.taskId ?? '')
        if (taskId === '') throw new Error('taskId 不能为空')
        return { cancelled: await queue.cancel(taskId, '后台取消') }
      },
    },
  })
}
