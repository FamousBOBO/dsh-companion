/** **空闲跟进**这一条候选来源（连同"今天"的日键换算）。从 `index.ts` 拆出来只为两件事：
 *   - `index.ts` 已经贴着 400 行硬上限（`scripts/check-size.mjs`）；
 *   - "什么时候该想起主人"是**业务规则**（6 小时静默、24 小时补算视界、一天最多一条），
 *     而 `index.ts` 的职责是装配。混在一起时，调阈值要读一遍装配代码。
 *
 * 这条来源**故意**独立于提醒 runner：到期提醒的唯一拥有者是 `features/reminders/runner.ts`，
 * 门控里那条 `reminders-owns` 就是这条边界（见 `gate.ts`）。它只提候选、不发送——
 * 发不发由 `gate.ts` 判、怎么发由 `sender.ts` 做。
 *
 * 它写下的候选长这样（2026-11 之前的真实生产形态）：
 * `reason` = 一句通用理由（**不含聊天内容**）、`evidenceIds` = 一条 `chat:<会话>:<秒>` 指针
 * （**没有解析器**，见 `draft-readers.evidenceOf`）。所以"跟进得具体"完全取决于起草时
 * 有没有真的读到上下文——那正是 P2.5-3D 在做的事。
 */

import type { SubHost } from '../plugin-kit.js'
import { localDayKey } from '../../core/schedule/stamp.js'
import type { ContactService } from './types.js'

/** 未配置时保留旧部署的 6 小时阈值；活跃部署通过配置覆盖。 */
const IDLE_MS = 6 * 3_600_000

/**
 * 按配置时区算"今天"（空串 = 跟随宿主 TZ；时区名不认识就退回宿主 TZ，不抛）。
 *
 * 为什么不是 `localDayKey(new Date(now))`：跨时区部署时"今天"必须与门控的免打扰、
 * 预算的跨日归零用同一个时区，否则一天可能出现两个日键（额度被算两次）。
 */
export function dayKeyFor(timeZone: string, now: number): string {
  if (timeZone === '') return localDayKey(new Date(now))
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(now))
  } catch {
    return localDayKey(new Date(now))
  }
}

/**
 * Independent follow-up source: the owner's DM, after 6h of silence and within the
 * catch-up window, proposes at most one generic follow-up per local day. It is
 * deliberately independent of the reminders runner; reminders remain the sole owner
 * of due reminders (gate drops explicit-reminder candidates).
 */
export async function proposeIdleFollowUp(
  host: SubHost,
  service: ContactService,
  now: number,
): Promise<void> {
  const owner = host.config.admins[0]
  if (owner === undefined) return
  const room = `dm-${String(owner)}`
  const record = host.get('inbound')?.registry.get(room)
  if (record === undefined) return
  const event = record.lastEvent
  if (event === undefined) return
  if (event.post_type !== 'message' || event.user_id !== owner) return
  const at = Number(event.time) * 1000
  if (!Number.isFinite(at) || at <= 0) return
  const idleMs = now - at
  const idleThreshold = Math.max(60_000, host.config.contact.followUpIdleMs ?? IDLE_MS)
  if (idleMs < idleThreshold) return
  const interval = Math.max(60_000, host.config.contact.followUpIntervalMs ?? 24 * 3_600_000)
  if (idleMs > host.config.contact.maxCatchupHours * 3_600_000) return
  const day = dayKeyFor(host.config.contact.timezone, now)
  const result = await service.propose({
    source: 'follow-up',
    reason: '距离上次私聊已经有一段时间，可以轻轻跟进一下近况',
    evidenceSource: 'chat',
    evidenceIds: [`chat:${record.sessionId}:${String(event.time)}`],
    scope: { userId: owner, personaId: host.config.agentPreset, worldId: '' },
    target: { channel: 'qq', room, isGroup: false, chatId: owner },
    priority: 50,
    earliestAt: now,
    expiresAt: now + Math.min(interval, 6 * 3_600_000),
    dedupeKey: interval >= 24 * 3_600_000
      ? `followup:${room}:idle:${day}`
      : `followup:${room}:idle:${day}:${String(Math.floor(now / interval))}`,
    authorization: { kind: 'none', by: null, at: null, quote: null },
  })
  if (result.outcome === 'accepted') host.log(`contact: follow-up 候选入库（${room}）`)
}
