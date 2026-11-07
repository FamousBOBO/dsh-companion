/** 每人每日点歌额度：非主人 2 首/天，主人与管理员不限。
 *
 * 为什么单独一个文件而不是塞进 `queue.ts`：队列已经贴着 400 行硬上限，而这是**一条独立
 * 判据**（谁、哪一天、算几首、谁豁免）。抽出来之后它能在测试里被单独喂账本，不必为了
 * 验额度去搭一整套假适配器。
 *
 * 四条刻意的口径：
 *
 *   1. **只数人点的，不数机器人自己点的**。自主选歌走 `dailyAutoCap`，两条账不混——
 *      混了就变成"机器人昨天自己唱了一首，主人今天少一次"，那是两件无关的事。
 *   2. **"占掉一格"包括已经发出去的与还在排队/在做的**。只数 `countsAsSent` 的话，
 *      同一个人的两条并发请求会双双通过（两条都还没到终态）。这也是为什么判定放在
 *      `enqueue()` 里而不是发送之前：用户要**立刻**听到"今天额度用完了"，
 *      而不是等两分钟、歌都做好了才被告知。
 *   3. **跨日按 `Asia/Shanghai` 的自然日**（`songDayKey`），入队那一刻的日期说了算。
 *      账本行只有 `createdAt`（入队那一毫秒，与 `requestedAt` 同源），所以按它分日。
 *   4. **豁免只认 `core/trust.ts`**：`master` / `admin` 不限。管理员名单缺省是空数组，
 *      于是"没接线"时**所有人**都受额度限制——那是安全的那一侧。
 */

import { trustOfSender } from '../../core/trust.js'
import { songDayKey } from './day.js'
import { countsAsSent, isTerminal, type SongLedgerData } from './ledger.js'
import type { SongRequest } from './types.js'

/** 额度判定需要的全部事实（账本、请求、上限、管理员名单）。 */
export interface UserQuotaFacts {
  readonly ledger: SongLedgerData
  readonly request: SongRequest
  /** `config.dailyUserCap`；`0` = 不限额（与 `dailyAutoCap` 同一套口径）。 */
  readonly cap: number
  /** `config.admins`（第一个是主人）。空数组 = 谁都不豁免。 */
  readonly admins: readonly number[]
}

/** 一个人在某一天已经占掉的额度（见文件头第 2 条口径）。 */
export function usedToday(ledger: SongLedgerData, requesterId: number, dayKey: string): number {
  let used = 0
  for (const row of ledger.tasks) {
    if (row.requesterId !== requesterId) continue
    // 自主选歌那条账走 `dailyAutoCap`，一行也不能算进来。
    if (row.entry === 'auto') continue
    // 只数"发过"或"还在做"的：失败/取消/演练没有发出去，用户重新点是明确意图。
    if (!countsAsSent(row) && isTerminal(row.stage)) continue
    if (songDayKey(row.createdAt) !== dayKey) continue
    used += 1
  }
  return used
}

/**
 * 这次点歌该不该因为"每人每天几首"被拒（该拒就返回一句能直接念给用户的话）。
 *
 * 返回 `null` = 放行。`auto` 入口与拿不到点歌人的请求一律放行：前者由 `dailyAutoCap`
 * 管，后者没有可信的"谁"，判了就只会误伤。
 */
export function userQuotaRefusal(facts: UserQuotaFacts): string | null {
  const { request } = facts
  if (request.entry === 'auto' || request.requesterId === null) return null
  // `0` = 不限额；拿不到有限数（配置没接线）也按不限额：额度是成本控制，
  // 一个缺字段不该把整个点歌功能拒成"今天已经点过了"。
  if (!Number.isFinite(facts.cap) || facts.cap <= 0) return null
  const trust = trustOfSender(request.requesterId, facts.admins)
  if (trust === 'master' || trust === 'admin') return null
  const day = songDayKey(request.requestedAt)
  // 算不出"今天"只可能是时钟坏了。额度是**成本**控制、不是安全边界，所以这里不判，
  // 而不是把整个点歌功能停掉（自主选歌那边算不出日键就不发，因为那是外发决定）。
  if (day === null) return null
  const used = usedToday(facts.ledger, request.requesterId, day)
  if (used < facts.cap) return null
  return `今天已经点过 ${String(used)} 首了（每人每天 ${String(facts.cap)} 首），明天再来`
}

/**
 * 点歌人 QQ 号。**私聊一律用房间键里的号**，群里才听模型报的那个。
 *
 * 为什么私聊不信入参：私聊房间键（`dm-<QQ>`）来自会话 id，是宿主侧的强事实；工具参数
 * 却是模型从消息文本里读出来的（`core/message/render.ts` 的行标带 `(QQ号)`），既可能读
 * 错行，也可能被让写成别人——甚至写成主人号去骗"主人不受限"。私聊里那两件事本来就该是
 * 同一个号，所以直接用强事实。群里没有强事实可用（房间键是群号、不是发送者），
 * 只能接受这个近似账。
 */
export function requesterOf(
  split: { readonly isGroup: boolean; readonly chatId: number },
  raw: unknown,
): number | null {
  if (!split.isGroup) return split.chatId
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw
  return null
}
