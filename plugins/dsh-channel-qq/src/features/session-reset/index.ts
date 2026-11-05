/** 会话换血看门狗：会话 token 接近模型窗口时，自动备份历史并重开会话。
 *
 * 为什么放在插件而不是宿主：宿主的压缩（compaction）是第一道防线，但历史一旦
 * **已经超过**窗口，压缩自己的摘要请求也会超窗——2026-10-20 的 400 就是这么来的。
 * 换血必须在压缩之前、按体积主动发生，而尺寸只有插件侧的 tokenMeter 能读到。
 *
 * 触发条件（全部满足才动手）：
 *   1. `sessionReset.enabled`；
 *   2. 会话当前没有回合在跑（`tracker.running()` 为假）；
 *   3. 模型**声明了**上下文窗口（未知时不动，避免误杀）；
 *   4. `tokens ≥ window × thresholdRatio`。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { OverflowStreak, looksLikeOverflow, sessionExpired, shouldResetSession } from '../../core/session-reset.js'
import { formatLocalStamp } from '../../core/schedule/stamp.js'
import { encodeSegment, sessionDir } from '../../paths.js'
import type { SessionSize } from '../../adapters/dsh-host/session-size.js'
import type { ConversationRegistry } from '../../app/conversation/registry.js'
import type { SessionResetConfig } from '../../config/sections/session-reset.js'
import type { SubHost, SubPlugin } from '../plugin-kit.js'

/** 默认续接种子。 */
const DEFAULT_SEED = [
  '【会话换血】上一段对话的上下文已经清空（历史已备份）。',
  '人格与长期记忆没有变：仍按 AGENTS.md 的约定说话，长期记忆按需检索。',
  '如果主人问起，说明这次是自动换血；不需要主动补发长报告。',
].join('\n')

/** 看门狗的固定 tick（配置的检查间隔在 tick 内部判断）。 */
const TICK_MS = 60_000

/** 每个房间上次换血的时间（定期换血用）。 */
async function readResetState(host: SubHost): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(host.dshHome, 'channel-qq', 'session-reset-state.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, number>
      : {}
  } catch {
    return {}
  }
}

/** 写回换血时间表。 */
async function writeResetState(host: SubHost, state: Record<string, number>): Promise<void> {
  await atomicWriteFile(
    path.join(host.dshHome, 'channel-qq', 'session-reset-state.json'),
    JSON.stringify(state, null, 2),
  ).catch(() => {})
}

/** 记下这个房间刚换过血。 */
async function markReset(host: SubHost, room: string): Promise<void> {
  const state = await readResetState(host)
  state[room] = Date.now()
  await writeResetState(host, state)
}

/** 换血：备份历史 → 释放会话 → 写种子。下一次消息会用新会话。 */
async function resetRoom(
  host: SubHost,
  registry: ConversationRegistry,
  room: string,
  size: SessionSize,
  config: SessionResetConfig,
): Promise<void> {
  const sessionId = `qq-${room}`
  const existed = registry.get(room) !== undefined
  if (existed) {
    await registry.dispose(room)
    registry.forget(room)
  }
  let moved = 0
  let backup = ''
  try {
    const dir = sessionDir(host.config.workspacePath ?? undefined, sessionId)
    moved = (await fs.readdir(dir)).length
    const stamp = formatLocalStamp(new Date()).replace(/[:.]/g, '-')
    backup = path.join(host.dshHome, 'channel-qq', 'backups', `session-auto-${stamp}-${encodeSegment(sessionId)}`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(dir, backup)
    // 本地补丁 COMPANION-QQ-PATCH-12：备份把整个会话目录搬走之后，**必须把原路径建回来**。
    // 2026-11-04 02:26 事故：换血（231945/262144 tokens）搬走 `--C-…-workspace--/qq-dm-1429709395`
    // 后没重建，下一轮 agent 恢复会话时 `open …/session.v4.jsonl.zstd` 直接 ENOENT，
    // 界面上就是「本轮运行失败」。建一个空目录，宿主下一次 append 会自己落新文件。
    await fs.mkdir(dir, { recursive: true })
  } catch (error) {
    // 目录不存在是正常状态（会话还没落盘）；别的错误记一行继续写种子。
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      host.log(`session-reset: 备份 ${sessionId} 失败：${(error as Error).message}`)
    }
  }
  const seed = config.seed.trim() === '' ? DEFAULT_SEED : config.seed.trim()
  await atomicWriteFile(
    path.join(host.dshHome, 'channel-qq', `session-seed-${sessionId}.json`),
    JSON.stringify({ sessionId, createdAt: new Date().toISOString(), seed }, null, 2),
  )
  await markReset(host, room)
  host.log(
    `session-reset: ${sessionId} 换血（${size.tokens}/${size.contextWindow} tokens，`
    + `route ${size.provider}/${size.model}，备份 ${moved} 个文件${backup === '' ? '' : ` → ${backup}`}）`,
  )
}

/** 体积曲线：每次探测追加一行 JSONL（超过 5MB 轮转一次）。 */
async function recordSize(host: SubHost, room: string, size: SessionSize): Promise<void> {
  const file = path.join(host.dshHome, 'channel-qq', 'session-size.jsonl')
  try {
    const stat = await fs.stat(file).catch(() => null)
    if (stat !== null && stat.size > 5 * 1024 * 1024) await fs.rename(file, `${file}.1`)
    await fs.appendFile(file, `${JSON.stringify({
      at: Date.now(), room, tokens: size.tokens, window: size.contextWindow,
      provider: size.provider, model: size.model,
    })}
`)
  } catch (error) {
    host.log(`session-reset: 写体积曲线失败：${(error as Error).message}`)
  }
}

/** 连续错误触发的换血：等回合收尾（最多等 3 次），再动手。 */
async function forceReset(
  host: SubHost,
  room: string,
  streak: OverflowStreak,
  attempt = 0,
): Promise<void> {
  const registry = host.get('inbound')?.registry
  if (registry === undefined) return
  const record = registry.get(room)
  if (record !== undefined && record.tracker.running() && attempt < 3) {
    setTimeout(() => { void forceReset(host, room, streak, attempt + 1) }, 5_000).unref?.()
    return
  }
  const probe = host.bridge.sessionSize?.()
  const measured = probe === undefined ? null : await probe.measure(`qq-${room}`).catch(() => null)
  const size: SessionSize = measured ?? {
    tokens: 0, contextWindow: null, provider: 'unknown', model: 'unknown',
  }
  const config = host.config.sessionReset as SessionResetConfig
  if (config.enabled !== true) return
  try {
    await resetRoom(host, registry, room, size, config)
    streak.clear(room)
    host.log(`session-reset: ${room} 连续上下文错误，已主动换血`)
  } catch (error) {
    host.log(`session-reset: 连续错误换血 ${room} 失败：${(error as Error).message}`)
  }
}

/** 回合卡死（例如等待一个永远不会来的审批）：超时后强制换血。 */
async function handleHungTurn(
  host: SubHost,
  registry: ConversationRegistry,
  room: string,
  since: number,
  config: SessionResetConfig,
): Promise<void> {
  const limitMs = Math.max(0, Number(config.maxTurnMinutes ?? 0)) * 60_000
  if (limitMs <= 0 || since <= 0 || Date.now() - since <= limitMs) return
  host.log(`session-reset: ${room} 回合已运行 ${Math.round((Date.now() - since) / 60_000)} 分钟，判定卡死，强制换血`)
  const size: SessionSize = { tokens: 0, contextWindow: null, provider: 'unknown', model: 'unknown' }
  try {
    await resetRoom(host, registry, room, size, config)
  } catch (error) {
    host.log(`session-reset: 强制换血 ${room} 失败：${(error as Error).message}`)
  }
}

/** 一轮检查。 */
async function tick(host: SubHost, seen: Set<string>): Promise<void> {
  const config = host.config.sessionReset as SessionResetConfig
  if (config.enabled !== true) return
  const registry = host.get('inbound')?.registry
  const probe = host.bridge.sessionSize?.()
  if (registry === undefined || probe === undefined) {
    if (!seen.has('__missing')) {
      seen.add('__missing')
      host.log(`session-reset: 探针不可用（registry=${registry !== undefined} probe=${probe !== undefined}）`)
    }
    return
  }
  const rooms = registry.keys()
  if (!seen.has('__tick')) {
    seen.add('__tick')
    host.log(`session-reset: 首轮检查，活跃房间 ${rooms.length} 个`)
  }
  const state = await readResetState(host)
  const strict = new Set(String(config.strictRooms ?? '').split(',').map((room) => room.trim()).filter((room) => room !== ''))
  let stateDirty = false
  for (const room of rooms) {
    const record = registry.get(room)
    if (record === undefined) continue
    if (record.tracker.running()) {
      await handleHungTurn(host, registry, room, record.tracker.runningSince(), config)
      continue
    }
    let size
    try {
      size = await probe.measure(`qq-${room}`)
    } catch (error) {
      if (!seen.has(`__err-${room}`)) {
        seen.add(`__err-${room}`)
        host.log(`session-reset: 测量 ${room} 失败：${(error as Error).message}`)
      }
      continue
    }
    if (size === null) continue
    void recordSize(host, room, size)
    if (!seen.has(room)) {
      seen.add(room)
      host.log(`session-reset: 探测 ${room} = ${size.tokens}/${size.contextWindow ?? '?'} tokens（${size.provider}/${size.model}）`)
    }
    const ratio = strict.has(room) ? config.strictThresholdRatio : config.thresholdRatio
    const expired = sessionExpired(state[room] ?? null, Date.now(), config.maxAgeDays)
    // 本地补丁 COMPANION-QQ-PATCH-12（下半）：**换血冷却**。
    // 2026-11-04 02:26 / 02:31 连续两次换血（token 估算都是 231945，来自宿主里还没清掉的
    // 旧会话记录），第二次把第一次刚重建的空目录又搬走，于是每轮都 ENOENT。换血之后
    // 半小时内不再对同一个房间动手：宁可多留一会儿旧上下文，也不要把会话目录反复搬空。
    const RESET_COOLDOWN_MS = 30 * 60_000
    const recentlyReset = typeof state[room] === 'number' && Date.now() - state[room] < RESET_COOLDOWN_MS
    if (!expired && (recentlyReset || !shouldResetSession(size.tokens, size.contextWindow, ratio))) continue
    if (recentlyReset) host.log(`session-reset: ${room} 刚换过血（<30 分钟），跳过重复换血`)
    try {
      await resetRoom(host, registry, room, size, config)
      state[room] = Date.now()
      stateDirty = true
      if (expired) host.log(`session-reset: ${room} 到期（>${config.maxAgeDays} 天），定期换血`)
    } catch (error) {
      host.log(`session-reset: 处理 ${room} 失败：${(error as Error).message}`)
    }
  }
  if (stateDirty) await writeResetState(host, state)
}

/** 后台「指标」页读它画体积曲线：最近 500 行，按房间分组。 */
function registerSizeResource(host: SubHost): void {
// 后台「指标」页读它画体积曲线：最近 500 行，按房间分组。
host.registerResource('session-size', {
  label: '会话体积',
  list: async () => {
    const file = path.join(host.dshHome, 'channel-qq', 'session-size.jsonl')
    let lines: string[] = []
    try {
      lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-500)
    } catch { lines = [] }
    const rooms = new Map<string, {
      room: string; tokens: number; window: number | null; provider: string; model: string; at: number;
      points: Array<{ at: number; tokens: number }>
    }>()
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as { at?: number; room?: string; tokens?: number; window?: number | null; provider?: string; model?: string }
        if (typeof row.room !== 'string' || typeof row.tokens !== 'number') continue
        const entry = rooms.get(row.room) ?? {
          room: row.room, tokens: 0, window: null, provider: '', model: '', at: 0, points: [],
        }
        entry.tokens = row.tokens
        entry.window = typeof row.window === 'number' ? row.window : null
        entry.provider = row.provider ?? ''
        entry.model = row.model ?? ''
        entry.at = typeof row.at === 'number' ? row.at : Date.now()
        entry.points.push({ at: entry.at, tokens: row.tokens })
        if (entry.points.length > 120) entry.points.shift()
        rooms.set(row.room, entry)
      } catch { /* 坏行忽略 */ }
    }
    return { rooms: [...rooms.values()] }
  },
})
}

export const sessionResetPlugin: SubPlugin = {
  name: 'session-reset',
  watches: ['sessionReset'],
  requires: ['inbound'],
  apply(host) {
    let lastRun = 0
    let busy = false
    const seen = new Set<string>()
    const streak = new OverflowStreak()
    // 管理员 `/换血` 指令的入口；inbound 在私聊里拦下指令后调用。
    host.provide('sessionReset', {
      async reset(room: string, reason: string) {
        const registry = host.get('inbound')?.registry
        if (registry === undefined) return { ok: false, note: '会话注册表还没就绪' }
        const record = registry.get(room)
        if (record !== undefined && record.tracker.running()) return { ok: false, note: '有回合在跑，稍后再试' }
        const probe = host.bridge.sessionSize?.()
        const measured = probe === undefined ? null : await probe.measure(`qq-${room}`).catch(() => null)
        const size: SessionSize = measured ?? { tokens: 0, contextWindow: null, provider: 'unknown', model: 'unknown' }
        try {
          await resetRoom(host, registry, room, size, host.config.sessionReset as SessionResetConfig)
          host.log(`session-reset: 手动换血 ${room}（${reason}）`)
          return { ok: true, note: '历史已备份，下一句开始是新会话' }
        } catch (error) {
          return { ok: false, note: (error as Error).message }
        }
      },
    })
    // 连续 400：压缩失败时比 5 分钟一次的体积检查更快。
    const bus = host.get('gatewayErrors')
    if (bus !== undefined) {
      host.log('session-reset: 已订阅网关错误（连续 2 次同类 400 会主动换血）')
      bus.handler = (room, detail) => {
        if (!looksLikeOverflow(detail)) return
        if (!streak.hit(room, Date.now())) return
        host.log(`session-reset: ${room} 连续上下文类错误，安排换血`)
        setTimeout(() => { void forceReset(host, room, streak) }, 5_000).unref?.()
      }
    }
    const timer = setInterval(() => {
      if (busy) return
      const config = host.config.sessionReset as SessionResetConfig
      if (config.enabled !== true) return
      const intervalMs = Math.max(1, Number(config.checkIntervalMin ?? 5)) * 60_000
      if (Date.now() - lastRun < intervalMs) return
      lastRun = Date.now()
      busy = true
      void tick(host, seen).finally(() => { busy = false })
    }, TICK_MS)
    timer.unref?.()
    // 启动后先跑一次：重启后的第一分钟就发现超限会话。
    const kick = setTimeout(() => { lastRun = Date.now(); void tick(host, seen) }, 20_000)
    kick.unref?.()
    registerSizeResource(host)
    host.log(`session-reset: 看门狗已启动（每 ${host.config.sessionReset.checkIntervalMin} 分钟，比例 ${host.config.sessionReset.thresholdRatio}）`)
    return () => {
      clearInterval(timer)
      clearTimeout(kick)
      if (bus !== undefined) bus.handler = undefined
    }
  },
}
