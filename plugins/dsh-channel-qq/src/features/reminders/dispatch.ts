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
import type { ClaimExpectation } from './claim.js'
import { startClaimRenewal } from './claim-renewal.js'
import { outcomeOf, type ReminderOutcome } from './outcome.js'
import type { Clock } from '../../ports/clock.js'
import { randomUUID } from 'node:crypto'

/**
 * 认领者标识：**必须全局唯一**，不能只靠 pid + 进程内序号。
 *
 * 为什么：pid 只在**同一个 PID namespace** 内唯一。容器/沙箱共享提醒文件时，两边的 pid 完全
 * 可能都是 1，进程内序号也都是 1 ⇒ 标识撞车 ⇒ `claimStateOf()` 把对方的认领判成 `mine`
 * （"我自己已经领过"）⇒ **两边都发**。pid 与序号只留作诊断信息，唯一性由随机令牌承担。
 *
 * 纪律：
 *   - **每个 runner 实例生成一次**（`runner.ts` 的字段初始化），续租/释放/收敛全部复用同一个它；
 *     每次 `claim()` 重新生成会让续租与释放都找不到自己的租约。
 *   - **不进普通日志**：随机令牌只是归属凭据，排障看 pid 与序号就够了（见 `shortOwner()`）。
 */
let ownerSeq = 0
export function claimOwnerOf(pid: number = process.pid): string {
  ownerSeq += 1
  return `pid-${String(pid)}#${String(ownerSeq)}#${randomUUID()}`
}

/**
 * 日志用的**脱敏**认领者标识：只留 `pid-N#seq`，丢掉随机令牌。
 *
 * 为什么不在日志里打全串：令牌是"能不能续租/释放/收敛"的凭据，日志会被整段贴进 issue。
 */
export function shortOwner(owner: string): string {
  const parts = owner.split('#')
  return parts.length >= 2 ? `${parts[0]}#${parts[1]}` : owner
}

/** 一行普通人能读的"这一轮是谁"（`at` + `occurrence` 一起打，否则分不清换绑前后）。 */
function roundOf(item: Reminder): string {
  const occurrence = item.occurrence ?? null
  return (occurrence === null ? `at=${String(item.at)} occurrence=null` : `at=${String(item.at)} occurrence=${occurrence.id}@${String(occurrence.revision)}`)
}

export interface ClaimOutcome {
  /** 本拍由我们发。`dryRun` 下也是 `true`（但不落盘，见下）。 */
  readonly claimed: boolean
  readonly claimedAt: number | null
  /** `true` = 上一次认领过期、已按 unknown 收敛（本拍不发）。 */
  readonly stale: boolean
  /**
   * **认领成功时，锁内最新的那一行**（第三轮 P1-A：投递链的**唯一权威对象**）。
   *
   * 为什么必须有它：调用方手上的 `reminder` 是**拍头的内存快照**，从它到认领之间，
   * 别的实例可能已经把这一轮推进/换绑（周期提醒发完就会推进 `at`）。既然 reducer 用的是
   * 锁内重读的磁盘草稿，那"发什么、记什么、日志写什么"就必须用**同一份**草稿，
   * 否则日志里的 `scheduledAt` 与事实不是同一轮，`recordSent()` 也可能按旧 `at` 记账。
   */
  readonly reminder: Reminder | null
}

/**
 * **领一次**（非 dryRun 才落盘）。三种结局：
 *   - `claimed`：本拍由我们发；`reminder` 是**锁内最新的那一行**（必须用它继续投递）；
 *   - `!claimed && !stale`：别人正持有 / 快照已过期 / 已触发 ⇒ 本拍跳过，**不是失败**；
 *   - `stale`：上一次认领过期 ⇒ 盘上分不清"发之前崩"还是"发之后崩" ⇒ 收敛成 `unknown`，不重发。
 *
 * 两处 CAS（第三轮）：
 *   ① 认领带 **`expect`**（`at` + `occurrence`）：锁内重读的盘上状态已不是同一轮 ⇒ 拒；
 *   ② 收敛过期认领带 **`expectStale`**（`by` + `until`）：对方在这期间续租成功 ⇒ 拒，不许清它的锁。
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
  if (dryRun) return { claimed: true, claimedAt: null, stale: false, reminder }
  // **老测试替身**（`fakeReminderStore` 之类）只实现投递用得到的那几个方法。缺 `claim()` 时
  // 退化成"进程内串行"（修复前的行为）并**说出来**：生产里的 `ReminderStore` 一定有它，
  // 所以这条只在替身上出现；静默跳过会让"多实例只发一次"看起来生效却其实没跑。
  if (typeof (store as { claim?: unknown }).claim !== 'function') {
    log(`reminders: ${reminder.id} 的 store 不支持认领（没有 claim()），退化成进程内串行：多实例并发防护不生效`)
    return { claimed: true, claimedAt: null, stale: false, reminder }
  }
  const state = claimStateOf(reminder, owner, now)
  if (state.kind === 'stale') {
    // **不重发**：过期认领意味着"上一次可能已经发出去了"。按未知收敛，等人工确认。
    // 收敛**必须带预期值**：这期间对方可能刚好续租成功（`claim-renewal.ts`），
    // 无条件清会把一个正在进行的发送记成 unknown。
    try {
      const mutation = await store.resolveStaleClaim(reminder.id, now, {
        expectedOwner: state.by,
        expectedUntil: state.until,
      })
      if (mutation.ok) {
        log(`reminders: ${reminder.id} 上一次认领（${shortOwner(state.by)}，到 ${String(state.until)}）已过期，结果未知`
          + ' → 记为 unknown，不自动重发（人工确认后再收敛）')
      } else {
        log(`reminders: ${reminder.id} 本拍不收敛过期认领：${mutation.message}（对方仍在发或已收尾，等下一拍）`)
      }
    } catch (error) {
      log(`reminders: ${reminder.id} 的过期认领**没写进盘**（${error instanceof Error ? error.message : String(error)}）：盘上仍是旧认领，下一拍还会碰到同一个现场`)
    }
    return { claimed: false, claimedAt: null, stale: true, reminder: null }
  }
  const expect: ClaimExpectation = {
    expectedAt: reminder.at,
    expectedOccurrence: reminder.occurrence ?? null,
  }
  const mutation = await store.claim(reminder.id, owner, now, DEFAULT_CLAIM_TTL_MS, expect)
  if (!mutation.ok) {
    if (mutation.code === 'STALE_STATE') {
      log(`reminders: 本拍不发 ${reminder.id}（${roundOf(reminder)}）：${mutation.message}`)
    } else {
      log(`reminders: ${reminder.id} 认领被拒（${mutation.code}：${mutation.message}）`)
    }
    return { claimed: false, claimedAt: null, stale: false, reminder: null }
  }
  // **锁内最新那一行**：`mutation.value` 来自 reducer 的草稿（= 锁内重读的磁盘 + 本笔改动）。
  return { claimed: true, claimedAt: mutation.value.claim?.at ?? now, stale: false, reminder: mutation.value }
}

/** **放回认领**（`skipped` / `dry-run` 之后）：这一轮什么都没发，让下一拍还能试。 */
export async function releaseAfterSkip(input: {
  readonly store: ReminderStore
  readonly id: string
  readonly owner: string
  readonly dryRun: boolean
  readonly log: (line: string) => void
}): Promise<void> {
  if (input.dryRun) return
  // 与 `claimForDispatch` 同一套退化规则：替身没有 `releaseClaim()` 就没什么可放回的。
  if (typeof (input.store as { releaseClaim?: unknown }).releaseClaim !== 'function') return
  try {
    // **带 owner**：只放自己的。替别人放回会让对方下一次扫描重发一遍（而它可能正在发）。
    const mutation = await input.store.releaseClaim(input.id, input.owner)
    if (!mutation.ok) {
      input.log(`reminders: ${input.id} 的认领没有放回（${mutation.code}：${mutation.message}）：这一轮不属于本进程，保持原样`)
    }
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
  /** 续租用的时钟（缺省 = 不续租，老替身与单测不需要它）。 */
  readonly clock?: Clock
}

/**
 * **发一条**（认领 → 闸门 → 真发 → 记账 → 结构化日志），返回 `false` = 本拍必须中止。
 *
 * 顺序是契约，别换：
 *   1. 白名单/开关（`allow`）：不允许发的**不认领、不消耗**；
 *   2. 认领（一次事务 + 快照 CAS）：抢不到就本拍跳过——这是"多 worker 只发一次"的全部机制；
 *   3. **认领成功后对锁内最新对象再做一次 `allow()`**：认领前的检查用的是拍头快照，
 *      而 CAS 通过意味着"同一轮"，但房间/开关可以在这一瞬之间变（配置热改）；
 *   4. 真发 + 记账（发送期间续租认领，见 `claim-renewal.ts`）；
 *   5. 无论什么结论都写一行**结构化日志**（`latenessMs` 是事后复盘的唯一硬证据）。
 *
 * **从第 3 步起，唯一权威对象是 `claim.reminder`**（锁内最新那一行）：`send` / `recordSent` /
 * `markUnknown` / 日志 `scheduledAt` 全部用它，绝不再回退到 `reminder`。
 *
 * `skipped` / `dry-run` 之后**放回认领**：这一轮什么都没发，下一拍还得能试。
 */
export async function dispatchOne(deps: DispatchDeps, reminder: Reminder): Promise<boolean> {
  const observedAt = deps.now()
  if (!deps.allow(reminder)) {
    deps.log(`reminders: 跳过 ${reminder.id}（当前不可投递：开关关闭或房间不在白名单）`)
    return true
  }
  const dryRun = deps.dryRun()
  let claimedAt: number | null = null
  let current = reminder
  try {
    const claim = await claimForDispatch({
      store: deps.store, reminder, owner: deps.owner, now: observedAt, dryRun, log: deps.log,
    })
    if (!claim.claimed) return true
    claimedAt = claim.claimedAt
    // **认领成功就换对象**：从这里往下只有锁内最新那一行算数。
    if (claim.reminder !== null) current = claim.reminder
  } catch (error) {
    // 认领本身失败（存储故障 / 抢不到跨进程锁）⇒ 本拍不发。这与"发不出去"不同：
    // 状态没动，下一拍还会试。**绝不**在没有认领的情况下发送。
    deps.log(`reminders: ${reminder.id} 认领失败（${error instanceof Error ? error.message : String(error)}）→ 本拍不投递`)
    return true
  }
  // **二次闸门**（第三轮 P1-A）：认领前的检查用的是拍头快照；拿到锁内最新对象后必须再看一遍。
  if (!deps.allow(current)) {
    deps.log(`reminders: ${current.id} 认领后复查不允许投递（开关/白名单在认领期间变了）→ 放回认领、本拍不发`)
    // 放回失败必须说出来：`releaseAfterSkip` 内部会记日志，这里不能假定它成功。
    await releaseAfterSkip({ store: deps.store, id: current.id, owner: deps.owner, dryRun, log: deps.log })
    return true
  }
  const latenessMs = observedAt - current.at
  if (latenessMs > 1000) {
    // **迟到必须自己说出来**（任务书第三阶段第 9 条：`latenessMs`）。正常按时不刷这行噪音。
    deps.log(`reminders: ${current.id} 迟到 latenessMs=${String(latenessMs)}（计划 ${String(current.at)}，观察 ${String(observedAt)}）`)
  }

  const sendStartedAt = deps.now()
  const sent = await sendPhase(deps, current, dryRun)
  const sendCompletedAt = deps.now()

  const ok = await settle(deps, current, sent.outcome, sent.reason, dryRun)
  deps.log(formatDispatchLine({
    reminderId: current.id,
    scheduledAt: current.at,
    observedAt,
    latenessMs,
    claimedAt,
    sendStartedAt,
    sendCompletedAt,
    // 非演练：`current` 是认领后的锁内对象，`attempts` **已经**由 `reduceClaim` 加过 1；
    // 演练：压根没认领，所以这里自己 +1（否则演练日志的 `attempt` 会永远是上一次的值）。
    attempt: dryRun
      ? (typeof current.attempts === 'number' ? current.attempts : 0) + 1
      : (typeof current.attempts === 'number' ? current.attempts : 1),
    outcome: dryRun && sent.outcome === 'sent' ? 'dry-run' : sent.outcome,
    reason: sent.reason,
  }))
  return ok
}

/**
 * **真发那一段**（含续租与异常归一）—— 从 `dispatchOne` 抽出来只是为了守住 60 行函数上限，
 * 行为一字不改：抛错 = 无法证明没发出去 ⇒ `unknown`。
 */
async function sendPhase(
  deps: DispatchDeps,
  reminder: Reminder,
  dryRun: boolean,
): Promise<{ outcome: ReminderOutcome; reason: string | null }> {
  // 发送期间续租：TTL 到期不等于"发送者死了"，只等于"没人证明它活着"。
  const renewal = dryRun || deps.clock === undefined
    ? null
    : startClaimRenewal({ store: deps.store, id: reminder.id, owner: deps.owner, clock: deps.clock, log: deps.log })
  try {
    const outcome = outcomeOf(await deps.send(reminder))
    return { outcome, reason: outcome === 'unknown' ? 'unclassified' : null }
  } catch (error) {
    // 抛错 = "无法证明没发出去" ⇒ 与 contact 的 unknown 同口径：不重试。
    const reason = error instanceof Error ? error.message : String(error)
    deps.log(`reminders: send failed for ${reminder.id}: ${reason}`)
    return { outcome: 'unknown', reason }
  } finally {
    renewal?.stop()
  }
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
  await releaseAfterSkip({ store: deps.store, id: reminder.id, owner: deps.owner, dryRun, log: deps.log })
  if (outcome !== 'skipped') {
    // **终审 B2**：演练不许动任何持久状态——不写 `fired`、不推进 `at`、不改 `occurrence`。
    deps.log(`reminders: ${reminder.id} 演练过（dry-run），状态未改动，下一次到点还会响`)
  }
  return true
}
