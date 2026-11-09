/**
 * **原子领取**（2026-11-10 修复：多 worker / 多次扫描只发一次）。
 *
 * 修之前 runner 只有一个进程内的 `running` 布尔量：同一个提醒文件被两个宿主/两个 worker
 * 扫到（或一次 `send` 卡住超过一拍、定时器重入）时，两边都会把它当"到点了"发一遍。
 * 单进程也挡不住"上一拍 send 还在飞、下一拍从盘上重新读到同一条"。
 *
 * 现在投递前先**落盘领一次**：`claim = { by, at, until }`，一次事务完成"读-判-写"，
 * 所以两个扫描者里只有一个能改成功（另一个拿到业务拒绝 `STALE_STATE`，本拍跳过）。
 *
 * 三种结局都要**显式清认领**（`release`），否则要等 TTL 到期才能再发：
 *   - `sent` / `unknown`：`markFired` / `markUnknown` 里顺手清掉（见 `store.ts`）；
 *   - `skipped` / `dry-run`：本拍什么都没发 ⇒ `releaseClaim()` 立刻放回，下一拍还能试。
 *
 * **TTL 到期不等于"可以重发"**：盘上分不清"发之前崩了"还是"发之后崩了"，所以
 * `claimStateOf()` 把过期认领判成 `stale`，由 runner 收敛成 `unknown`（结果未知、不重试），
 * 与 contact 的 unknown 口径一致。
 */

import type { Reminder } from './reminder-model.js'
import type { Edit } from './store-contract.js'
import { edited, rejected, unchanged } from './store-contract.js'

/** 认领的默认有效期：够一次 QQ 发送（含分句与限速）走完，又不至于长到让提醒空等。 */
export const DEFAULT_CLAIM_TTL_MS = 120_000

/** 认领的三种现场（runner 据此决定"发/跳过/收敛成 unknown"）。 */
export type ClaimState =
  /** 没人认领（或上一次已经放回）⇒ 可以领。 */
  | { kind: 'free' }
  /** 别人（另一个实例/另一拍）正在发，`until` 之前别再动它。 */
  | { kind: 'held'; by: string; until: number }
  /** 自己的认领还在（同一拍的重复调用）。 */
  | { kind: 'mine'; until: number }
  /** 认领过期：**结果未知**（可能发过，也可能没发）。 */
  | { kind: 'stale'; by: string; until: number }

export function claimStateOf(item: Reminder | undefined, owner: string, now: number): ClaimState {
  const claim = item?.claim ?? null
  if (claim === null) return { kind: 'free' }
  const held = claim.until > now
  if (claim.by === owner) return held ? { kind: 'mine', until: claim.until } : { kind: 'stale', by: claim.by, until: claim.until }
  return held ? { kind: 'held', by: claim.by, until: claim.until } : { kind: 'stale', by: claim.by, until: claim.until }
}

/**
 * **领一次**（同步 reducer，落盘交给事务）。
 *
 * 拒绝三种情况：没有这条、已经 `fired`（终态不再领）、别人正持有（`held`）。
 * **`stale` 不在这里拒绝**——过期认领由 runner 先收敛成 `unknown`（`resolveStaleClaim`），
 * 然后这条就不会再被领；在这里放行会让"结果未知"的条目被重发一遍。
 */
export function reduceClaim(
  draft: Reminder[],
  id: string,
  owner: string,
  now: number,
  ttlMs = DEFAULT_CLAIM_TTL_MS,
): Edit<Reminder> {
  const item = draft.find((row) => row.id === id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  if (item.fired) return rejected('NOT_APPLICABLE', '这条已经触发过，不再领取')
  const state = claimStateOf(item, owner, now)
  if (state.kind === 'held') return rejected('STALE_STATE', `已被 ${state.by} 认领到 ${String(state.until)}`)
  if (state.kind === 'stale') return rejected('STALE_STATE', `上一次认领（${state.by}）已过期，结果未知，不重复发送`)
  if (state.kind === 'mine') return unchanged({ ...item })
  item.claim = { by: owner, at: now, until: now + Math.max(1, ttlMs) }
  item.attempts = (typeof item.attempts === 'number' ? item.attempts : 0) + 1
  return edited({ ...item })
}

/** **放回**（`skipped` / `dry-run` 之后立刻调用）：不动 `attempts`，只清认领。 */
export function reduceReleaseClaim(draft: Reminder[], id: string): Edit<Reminder> {
  const item = draft.find((row) => row.id === id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  if (item.claim === undefined || item.claim === null) return unchanged({ ...item })
  delete item.claim
  return edited({ ...item })
}

/** 清认领的公共片段（`markFired` / `markUnknown` 复用，保证"一轮结束就放锁"）。 */
export function clearClaim(item: Reminder): void {
  delete item.claim
}
