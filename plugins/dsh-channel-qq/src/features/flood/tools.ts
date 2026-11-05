/** 刷屏风控工具面：统计 / 豁免名单 / 手动禁言（3 个工具）。
 *
 * 判定与状态机在 `./guard.js`（`FloodGuard` / `enforceFlood`），这里只有工具面。
 * 这些 spec **逐字节**来自拆分前 `src/flood.ts` 的 `registerFloodTools`——P4 的判据是
 * 工具名与参数 schema 一条都不许变（`test/golden/tools/other-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在整段里找它的边界。
 */

import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import type { FloodGuard } from './guard.js'

/** 手动禁言的秒数边界：60 秒（太短没意义）～ 30 天（QQ 上限）。 */
const MUTE_MIN_SECONDS = 60
const MUTE_MAX_SECONDS = 2_592_000

function clampMuteSeconds(raw: number): number {
  if (!Number.isFinite(raw)) return MUTE_MIN_SECONDS
  return Math.min(MUTE_MAX_SECONDS, Math.max(MUTE_MIN_SECONDS, Math.round(raw)))
}

/** `qq_flood_stats` — 查看群内刷屏风控的状态：跟踪人数、累计触发、当前阈值与动作。 */
function qqFloodStats(config: QQChannelConfig, guard: FloodGuard): ToolSpec {
  return {
    name: 'qq_flood_stats',
    description: '查看群内刷屏风控的状态：正在跟踪多少人、累计触发多少次、当前的窗口秒数/条数阈值/触发动作。想知道"这算不算刷屏"或调整阈值前先看一眼。',
    parameters: params({}),
    run: () => ({
      ...guard.stats(),
      enabled: config.flood.enabled,
      windowSec: config.flood.windowSec,
      maxMessages: config.flood.maxMessages,
      action: config.flood.action,
    }),
  }
}

/** `qq_flood_exempt` — 把某个 QQ 号加入或移出刷屏豁免名单（改的是内存配置）。 */
function qqFloodExempt(config: QQChannelConfig, log: (line: string) => void): ToolSpec {
  return {
    name: 'qq_flood_exempt',
    description: '把某个 QQ 号加入或移出刷屏豁免名单（学弟和咱自己永远豁免）。老群友偶尔连着说话被误判时用这个放行。名单改的是内存里的配置，重启后回到配置文件的值。',
    parameters: params({
      userId: { type: 'number', description: 'QQ 号' },
      remove: { type: 'boolean', description: 'true = 移出豁免名单，不传/false = 加入' },
    }, ['userId']),
    run: (args) => {
      const userId = Number(args.userId)
      if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('userId 必须是有效的 QQ 号（正整数）。')
      const current = Array.isArray(config.flood.exempt) ? config.flood.exempt : []
      const remove = args.remove === true
      // 整体换一个新数组而不是原地 push/splice：exempt 可能和 DEFAULT_CONFIG
      // 共用同一个数组引用，原地改会污染全局默认值。
      const next = remove
        ? current.filter((id) => id !== userId)
        : (current.includes(userId) ? current : [...current, userId])
      config.flood.exempt = next
      log(`flood: exempt ${remove ? '移除' : '加入'} ${userId} → [${next.join(',')}]`)
      return { ok: true, exempt: [...next] }
    },
  }
}

/** `qq_group_mute_user` — 手动禁言群里某个人（秒数夹到 60–2592000）。 */
function qqGroupMuteUser(api: QQApi, log: (line: string) => void, guard: FloodGuard): ToolSpec {
  return {
    name: 'qq_group_mute_user',
    description: '手动禁言群里某个人。只在确认对方在刷屏/闹事、口头提醒没用时用；秒数会被夹到 60–2592000（30 天）。需要机器人是群管理员，没权限会失败并报错，那时改成在群里口头提醒。',
    parameters: params({
      groupId: { type: 'number', description: '群号' },
      userId: { type: 'number', description: '要禁言的 QQ 号' },
      seconds: { type: 'number', description: '禁言秒数，60–2592000，越界会被夹住' },
    }, ['groupId', 'userId', 'seconds']),
    run: async (args) => {
      const groupId = Number(args.groupId)
      const userId = Number(args.userId)
      if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('groupId 必须是有效的群号（正整数）。')
      if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('userId 必须是有效的 QQ 号（正整数）。')
      const seconds = clampMuteSeconds(Number(args.seconds))
      try {
        await api.setGroupBan(groupId, userId, seconds)
      } catch (error) {
        throw new Error(`禁言失败：${error instanceof Error ? error.message : String(error)}。机器人可能不是该群管理员，或者对方是群主/管理员——这种情况改成在群里口头提醒。`)
      }
      // 让看门人也知道这人正被禁言，别再自动提醒一遍。
      guard.recordMute(groupId, userId)
      log(`flood: 手动禁言 ${userId}（群 ${groupId}，${seconds} 秒）`)
      return { ok: true, groupId, userId, seconds }
    },
  }
}

/** 注册刷屏风控工具（统计 / 豁免名单 / 手动禁言）。 */
export function registerFloodTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
  guard: FloodGuard,
): () => void {
  const specs: ToolSpec[] = [
    qqFloodStats(config, guard),
    qqFloodExempt(config, log),
    qqGroupMuteUser(api, log, guard),
  ]
  return registerSpecs(ctx, specs, log, 'flood')
}
