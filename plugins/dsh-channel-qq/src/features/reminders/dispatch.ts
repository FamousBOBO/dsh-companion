/**
 * **一条提醒的投递现场**（2026-11-10 修复：原子领取 + 结构化日志）。
 *
 * 拆成单独文件的理由有两条，都不是审美：
 *   1. `runner.ts` 贴着 400 行硬上限（`scripts/check-size.mjs`），而这段是"单独一条怎么发"，
 *      与"下一拍什么时候醒"无关；
 *   2. 事件日志的字段表是**运维与测试共用的契约**：字段名写在一处，才可能被 grep 与断言钉住。
 *
 * 字段要求（任务书第三阶段第 9 条）：`reminderId`、`scheduledAt`、`observedAt`、`latenessMs`、
 * `claimedAt`、`sendStartedAt`、`sendCompletedAt`、`attempt`、失败原因。**不含正文**——
 * 提醒内容可能是私事，而日志会被贴进 issue。
 *
 * 为什么要"先落盘领一次再发"：以前只有进程内一个 `running` 布尔量。两个宿主扫同一个提醒
 * 文件（或一次 `send` 卡住超过一拍、定时器重入）时，两边会各发一次。现在认领是**一次事务**
 * （读-判-写），第二个扫描者只会拿到 `STALE_STATE`。
 */

import type { Reminder, ReminderStore } from './store.js'
import { claimStateOf, DEFAULT_CLAIM_TTL_MS } from './claim.js'
import { outcomeOf, type ReminderOutcome } from './outcome.js'

/**
 * 认领者标识：**必须进程内唯一**，不只是"进程唯一"。
 *
 * 为什么加序号：同一个进程里可以有两个 runner（插件被装配两次、或测试里同时跑两个宿主）。
 * 只用 `pid` 时两者标识相同 ⇒ `claimStateOf()` 把对方的认领判成 `mine`（"我自己已经领过"），
 * 于是两边都发一次——那正是这一层要防的重复外发。pid + 序号之后，跨进程靠 pid 区分，
 * 同进程靠序号区分，两种重复都挡得住。
 */
let ownerSeq = 0
export function claimOwnerOf(pid: number = process.pid): string {
  ownerSeq += 1
  return `pid-${String(pid)}#${String(ownerSeq)}`
}

export interface ClaimOutcome {
  /** 本拍由我们发。`dryRun` 下也是 `true`（但不落盘，见下）。 */
  readonly claimed: boolean
  readonly claimedAt: number | null
  /** `true` = 上一次认领过期、已按 unknown 收敛（本拍不发）。 */
  readonly stale: boolean
}

/**
 * **领一次**（非 dryRun 才落盘）。三种结局：
 *   - `claimed`：本拍由我们发；
 *   - `!claimed && !stale`：别人正持有（或已触发）⇒ 本拍跳过，**不是失败**；
 *   - `stale`：上一次认领过期 ⇒ 盘上分不清"发之前崩"还是"发之后崩" ⇒ 收敛成 `unknown`，不重发。
 *
 * `dryRun` 下**不认领**：演练承诺"整条入口零写入"（round6 D4 / round4 B2），而认领会落盘。
 * 代价是演练不验并发——已写进 `docs/reminders-dispatch-timing.md` 的"未覆盖项"。
 */
export async function claimForDispatch(input: {
  readonly store: ReminderStore
  readonly reminder: Reminder
  readonly owner: string
  readonly now: number
  readonly dryRun: boolean
  readonly log: (line: string) => void
}): Promise<ClaimOutcome> {
  const { store, reminder, owner, now, dryRun, log } = input
  if (dryRun) return { claimed: true, claimedAt: null, stale: false }
  // **老测试替身**（`fakeReminderStore` 之类）只实现投递用得到的那几个方法。缺 `claim()` 时
  // 退化成"进程内串行"（修复前的行为）并**说出来**：生产里的 `ReminderStore` 一定有它，
  // 所以这条只在替身上出现；静默跳过会让"多实例只发一次"看起来生效却其实没跑。
  if (typeof (store as { claim?: unknown }).claim !== 'function') {
    log(`reminders: ${reminder.id} 的 store 不支持认领（没有 claim()），退化成进程内串行：多实例并发防护不生效`)
    return { claimed: true, claimedAt: null, stale: false }
  }
  const state = claimStateOf(reminder, owner, now)
  if (state.kind === 'stale') {
    // **不重发**：过期认领意味着"上一次可能已经发出去了"。按未知收敛，等人工确认。
    try {
      await store.resolveStaleClaim(reminder.id, now)
      log(`reminders: ${reminder.id} 上一次认领（${state.by}，到 ${String(state.until)}）已过期，结果未知`
        + ' → 记为 unknown，不自动重发（人工确认后再收敛）')
    } catch (error) {
      log(`reminders: ${reminder.id} 的过期认领**没写进盘**（${error instanceof Error ? error.message : String(error)}）：盘上仍是旧认领，下一拍还会碰到同一个现场`)
    }
    return { claimed: false, claimedAt: null, stale: true }
  }
  const mutation = await store.claim(reminder.id, owner, now, DEFAULT_CLAIM_TTL_MS)
  if (!mutation.ok) {
    if (mutation.code === 'STALE_STATE') {
      log(`reminders: ${reminder.id} 本拍不发：${mutation.message}（别的实例/另一拍正在处理）`)
    } else {
      log(`reminders: ${reminder.id} 认领被拒（${mutation.code}：${mutation.message}）`)
    }
    return { claimed: false, claimedAt: null, stale: false }
  }
  return { claimed: true, claimedAt: mutation.value.claim?.at ?? now, stale: false }
}

/** **放回认领**（`skipped` / `dry-run` 之后）：这一轮什么都没发，让下一拍还能试。 */
export async function releaseAfterSkip(input: {
  readonly store: ReminderStore
  readonly id: string
  readonly dryRun: boolean
  readonly log: (line: string) => void
}): Promise<void> {
  if (input.dryRun) return
  // 与 `claimForDispatch` 同一套退化规则：替身没有 `releaseClaim()` 就没什么可放回的。
  if (typeof (input.store as { releaseClaim?: unknown }).releaseClaim !== 'function') return
  try {
    await input.store.releaseClaim(input.id)
  } catch (error) {
    input.log(`reminders: ${input.id} 的认领**没能放回**（${error instanceof Error ? error.message : String(error)}）：要等认领到期（TTL）后才会再被领取`)
  }
}

/** 一次投递的结构化字段（键名是契约：改它等于改运维的 grep 与测试断言）。 */
export interface DispatchRecord {
  readonly reminderId: string
  readonly scheduledAt: number
  readonly observedAt: number
  readonly latenessMs: number
  readonly claimedAt: number | null
  readonly sendStartedAt: number
  readonly sendCompletedAt: number
  readonly attempt: number
  readonly outcome: string
  readonly reason: string | null
}

/**
 * 一行结构化日志：`key=value`，空格分隔，**正文不入日志**。
 *
 * 为什么是 `key=value` 而不是 JSON：这一行要和既有中文日志混在同一个文件里被人读，
 * 同时又要能被 `grep 'latenessMs='` 抓出来统计。JSON 在这两件事上都更差。
 */
export function formatDispatchLine(record: DispatchRecord): string {
  const parts = [
    `reminderId=${record.reminderId}`,
    `scheduledAt=${String(record.scheduledAt)}`,
    `observedAt=${String(record.observedAt)}`,
    `latenessMs=${String(record.latenessMs)}`,
    `claimedAt=${record.claimedAt === null ? 'null' : String(record.claimedAt)}`,
    `sendStartedAt=${String(record.sendStartedAt)}`,
    `sendCompletedAt=${String(record.sendCompletedAt)}`,
    `attempt=${String(record.attempt)}`,
    `outcome=${record.outcome}`,
  ]
  if (record.reason !== null && record.reason !== '') parts.push(`reason="${record.reason.replace(/"/g, "'")}"`)
  return `reminders: dispatch ${parts.join(' ')}`
}

/** 投递一条的依赖（runner 提供；本模块不知道"还有下一拍吗"）。 */
export interface DispatchDeps {
  readonly store: ReminderStore
  readonly owner: string
  readonly now: () => number
  readonly dryRun: () => boolean
  readonly allow: (r: Reminder) => boolean
  readonly send: (r: Reminder) => Promise<string>
  /** `sent` 出口的记账（推进/换绑一次落盘）。`false` = 写失败，必须中止本拍。 */
  readonly recordSent: (r: Reminder) => Promise<boolean>
  /** `unknown` 出口的记账；抛错 = 状态没写进去（调用方要停表）。 */
  readonly markUnknown: (id: string, reason: string) => Promise<void>
  /** 记账失败 ⇒ 停表（不许自动重发）。 */
  readonly haltDispatch: (reason: string, reminderId: string) => void
  readonly log: (line: string) => void
}

/**
 * **发一条**（认领 → 闸门 → 真发 → 记账 → 结构化日志），返回 `false` = 本拍必须中止。
 *
 * 顺序是契约，别换：
 *   1. 白名单/开关（`allow`）：不允许发的**不认领、不消耗**；
 *   2. 认领（落盘一次事务）：抢不到就本拍跳过——这是"多 worker 只发一次"的全部机制；
 *   3. 真发 + 记账；
 *   4. 无论什么结论都写一行**结构化日志**（`latenessMs` 是事后复盘的唯一硬证据）。
 *
 * `skipped` / `dry-run` 之后**放回认领**：这一轮什么都没发，下一拍还得能试。
 */
export async function dispatchOne(deps: DispatchDeps, reminder: Reminder): Promise<boolean> {
  const observedAt = deps.now()
  const latenessMs = observedAt - reminder.at
  if (!deps.allow(reminder)) {
    deps.log(`reminders: 跳过 ${reminder.id}（当前不可投递：开关关闭或房间不在白名单）`)
    return true
  }
  const dryRun = deps.dryRun()
  let claimedAt: number | null = null
  try {
    const claim = await claimForDispatch({
      store: deps.store, reminder, owner: deps.owner, now: observedAt, dryRun, log: deps.log,
    })
    if (!claim.claimed) return true
    claimedAt = claim.claimedAt
  } catch (error) {
    // 认领本身失败（存储故障）⇒ 本拍不发。这与"发不出去"不同：状态没动，下一拍还会试。
    deps.log(`reminders: ${reminder.id} 认领抛错（${error instanceof Error ? error.message : String(error)}）→ 本拍不投递`)
    return true
  }
  if (latenessMs > 1000) {
    // **迟到必须自己说出来**（任务书第三阶段第 9 条：`latenessMs`）。正常按时不刷这行噪音。
    deps.log(`reminders: ${reminder.id} 迟到 latenessMs=${String(latenessMs)}（计划 ${String(reminder.at)}，观察 ${String(observedAt)}）`)
  }

  const sendStartedAt = deps.now()
  let outcome: ReminderOutcome = 'unknown'
  let reason: string | null = null
  try {
    outcome = outcomeOf(await deps.send(reminder))
    if (outcome === 'unknown') reason = 'unclassified'
  } catch (error) {
    // 抛错 = "无法证明没发出去" ⇒ 与 contact 的 unknown 同口径：不重试。
    outcome = 'unknown'
    reason = error instanceof Error ? error.message : String(error)
    deps.log(`reminders: send failed for ${reminder.id}: ${reason}`)
  }
  const sendCompletedAt = deps.now()

  const ok = await settle(deps, reminder, outcome, reason, dryRun)
  deps.log(formatDispatchLine({
    reminderId: reminder.id,
    scheduledAt: reminder.at,
    observedAt,
    latenessMs,
    claimedAt,
    sendStartedAt,
    sendCompletedAt,
    attempt: typeof reminder.attempts === 'number' ? reminder.attempts + 1 : 1,
    outcome: dryRun && outcome === 'sent' ? 'dry-run' : outcome,
    reason,
  }))
  return ok
}

/** 把四种结论落到状态上。返回 `false` = 本拍必须中止（记账失败已停表）。 */
async function settle(
  deps: DispatchDeps,
  reminder: Reminder,
  outcome: ReminderOutcome,
  reason: string | null,
  dryRun: boolean,
): Promise<boolean> {
  if (outcome === 'sent' && !dryRun) return await deps.recordSent(reminder)
  if (outcome === 'unknown' && !dryRun) {
    try {
      await deps.markUnknown(reminder.id, reason ?? 'unknown')
    } catch (error) {
      deps.log(`reminders: ${reminder.id} 的 unknown 状态**没写进去**（${error instanceof Error ? error.message : String(error)}）：内存与盘上都没记，别当成已收敛`)
      deps.haltDispatch(`unknown 没写进去：${error instanceof Error ? error.message : String(error)}`, reminder.id)
      return false
    }
    deps.log(`reminders: ${reminder.id} 记为 unknown（不自动重试，等人工收敛 ${reason ?? 'unknown'}）`)
    return true
  }
  if (outcome === 'unknown') {
    // **round8**：演练下任何出口都不许落盘——包括这条"异常/说不清"的出口。
    deps.log(`reminders: ${reminder.id} 演练里出现 unknown（${reason ?? 'unknown'}）→ **不落 unknown**，状态保持原样`)
    return true
  }
  // `sent`（演练下）/ `dry-run` / `skipped`：这一轮什么都没真发 ⇒ 放回认领，下一拍还能试。
  await releaseAfterSkip({ store: deps.store, id: reminder.id, dryRun, log: deps.log })
  if (outcome !== 'skipped') {
    // **终审 B2**：演练不许动任何持久状态——不写 `fired`、不推进 `at`、不改 `occurrence`。
    deps.log(`reminders: ${reminder.id} 演练过（dry-run），状态未改动，下一次到点还会响`)
  }
  return true
}
