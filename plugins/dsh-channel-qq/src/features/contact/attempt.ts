/** 从"门控放行"到"账本结清"这一段：备文案 → 领投递 → 交发送器 → 结算 → 记账。
 *
 * 为什么从 `worker.ts` 拆出来：worker 的职责是"什么时候看、看几条"（节拍），这一段是
 * "一条候选真的要出门时按什么顺序做"（顺序 + 冻结复查 + 起草预算）。两者共用同一个
 * 数据但节奏完全不同：节拍每 60 秒一次、无 I/O 之外的状态；发送则**慢**（模型几十秒、
 * 平台往返几百毫秒），而且这段时间里世界会变（被暂停、被取消、被别的实例接管）。
 *
 * 三条顺序不许换：
 *   1. **起草在领投递之前**：没文案就没必要在账本上留下一条 `running`；
 *   2. **先领后发**：`claimDelivery` 落盘成功才发送——进程死在发送中途时，读盘的人能
 *      看到 `running`，降级成 `unknown`（承认不知道）而不是重发；
 *   3. **冻结即停**：两个 `isFrozen()` 检查（起草前、领投递前）之间隔着模型调用，
 *      这就是操作者按暂停最可能落进来的窗口。冻结后**什么都不留下**——不建投递行、
 *      不改候选；恢复后从账本现状重新判。
 */

import { reviewAdaptive } from './adaptive-review.js'
import type { AdaptiveDecisionPort } from './adaptive-host.js'
import type { ContactConfig } from '../../config/sections/contact.js'
import type { Clock } from '../../ports/clock.js'
import type { DraftPort } from './model.js'
import { draftWithBudget, pruneDraftCalls } from './model.js'
import { describeDraftContext, sufficientContext, type DraftContext, type DraftRevision } from './draft-context.js'
import { scopeIssue } from './precheck.js'
import type { ContactIdentity, ContactSender } from './sender.js'
import { StaleLeaseError, type ContactStore, type DeliverySettlement } from './store.js'
import { afterSend, deferCandidate, dropCandidate, type TransitionDeps } from './transitions.js'
import type { ContactCandidate, ContactDelivery, ContactRuntimeFacts } from './types.js'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 每小时突发预算用的内存环（重启从零开始是可接受的：每日那条才是持久化的）。 */
export interface DraftRing {
  calls: number[]
}

export interface AttemptDeps {
  readonly sleepText?: (candidate: ContactCandidate, now: number) => string | null
  readonly adaptivePort?: AdaptiveDecisionPort
  readonly store: ContactStore
  readonly sender: ContactSender
  readonly clock: Clock
  readonly log: (line: string) => void
  readonly transitions: TransitionDeps
  /** 草稿端口现取：卸载之后不该再拿旧引用。 */
  readonly draftPort: () => DraftPort | null
  /**
   * 起草上下文的来源（P2.5-3D / Slice C0）。
   *
   * **只在"门控已放行、即将调模型"的这一段被调用**——心跳/被门控挡住的候选一次都不读库。
   * 缺省（历史用例、`turn` 模式）＝ 不组装上下文，行为与修复前逐字相同。
   */
  readonly draftContext?: { build(candidate: ContactCandidate, now: number): Promise<DraftContext> }
  /** `paused || stopped`：冻结之后这一段只做"什么都不做"。 */
  readonly isFrozen: () => boolean
  readonly drafts: DraftRing
  /**
   * 当前人格/世界（**起草前**的作用域断言）。
   *
   * 为什么起草前也要判一次：门控（`gate.ts`）管的是"该不该说"，作用域自洽在
   * `precheck.scopeIssue` 里；可候选的 `scope.userId` 与 `target.chatId` 对不上时，
   * 起草会**先把别人房间的对话读进上下文**、再在发送前被拦下（A2 §5.6 的"身份不匹配"
   * 那一行要求起草前就断言）。这里直接复用 `scopeIssue`，不另写一套判据。
   */
  readonly identity?: () => ContactIdentity
}

/** `turn` 模式的指令：人格包会再包装一层，所以这里只说"为什么开口"。 */
function turnDirective(candidate: ContactCandidate): string {
  if (candidate.intent) return `【已复核的自主跟进意图】目的：${candidate.intent.purpose}。这是后台触发，不是用户新消息。
请结合当前完整对话自然跟进；如果最新消息表明目的已完成或已聊过，直接静默结束。不要把这条意图再建成固定提醒；需要发言时使用当前 QQ 路由工具。`

  return `【自主联系机会｜由当前 QQ 会话执行】
候选缘由：${candidate.reason}
这是后台触发，不是主人刚发来的消息。沿用当前私聊的完整上下文、人设、记忆和工具，自行判断现在有没有具体想聊、关心、分享或跟进的事；有合适内容就自然主动联系，不用等待主人提问，避免反复问候或催回复；不合适可直接沉默结束。
主人已授权你自行创建、调整和取消提醒或日程。可把真实待办、约好的后续、自己的活动和下次联系意图落到可用工具；先查看已有安排，避免重复。自己的生活安排用 companion_schedule_*；自己想到稍后关心、跟进进展用 qq_followup(action=add,purpose,at)，只有用户明确要求的定时通知才用 qq_remind(action=add/add_at)，isGroup=false，target=${String(candidate.target.chatId)}。日程本身不会自动发消息，只有提醒工具成功才承诺到点提醒。
若有建提醒或排日程等工具操作，先完成，再用当前路由的发送工具发最终消息；只输出文字不会送到 QQ。不得把候选理由说成主人刚说的话，也不得编造活动结果。`
}

/** 投递记录（同一条候选复用同一行：重试不会在账本里堆出一串影子）。 */
function buildDelivery(store: ContactStore, candidate: ContactCandidate, mode: 'turn' | 'direct', text: string, now: number): ContactDelivery {
  const id = `d-${candidate.id}`
  const prev = store.state.outbox[id]
  return {
    id,
    candidateId: candidate.id,
    dedupeKey: candidate.dedupeKey,
    target: candidate.target,
    scope: candidate.scope,
    text,
    state: 'pending',
    attempts: prev?.attempts ?? 0,
    leaseOwner: null,
    epoch: 0,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    submittedAt: null,
    confirmedAt: null,
    receipt: null,
    lastError: null,
    mode,
  }
}

/**
 * 作用域自洽**先判**（P2.5-3D，A2 §5.6 的"身份不匹配"那一行）。
 *
 * 判据直接复用 `precheck.scopeIssue`（同源，不另写一套）：候选的 `scope.userId` 与
 * `target.chatId` 对不上时，起草会**先把别人房间的对话读进上下文**、再在发送前被拦下——
 * 那样既浪费一次读库，也把不该出现的内容放进了提示词。这里提前返回 `true` 表示
 * "已处理（判 cancelled + 记账），这一条不要继续"。
 */
async function rejectWrongScope(
  deps: AttemptDeps,
  candidate: ContactCandidate,
  now: number,
  epoch: number,
): Promise<boolean> {
  const scope = deps.identity === undefined ? null : scopeIssue(candidate, candidate.target, deps.identity())
  if (scope === null) return false
  deps.log(`contact: 候选 ${candidate.id} 作用域不自洽（${scope}），不起草也不发送`)
  await deps.store.noteReason(`${candidate.id} ${scope}`, now, epoch).catch(() => false)
  await dropCandidate(deps.transitions, candidate, scope, now, epoch)
  return true
}

/**
 * 一条候选要出门时走这里。
 *
 * 起草的预算与退避**只有一份账**（`model.ts` 的 `draftWithBudget`）：它自己判
 * `canDraft`、自己加/清退避，这里只把更新后的 `counters` 落盘——否则
 * `counters.draftCallsToday` 永远不增长，重启后等于预算无限。
 */
export async function attemptSend(
  deps: AttemptDeps,
  candidate: ContactCandidate,
  now: number,
  epoch: number,
  config: ContactConfig,
  runtime: ContactRuntimeFacts,
): Promise<void> {
  if (deps.isFrozen()) {
    deps.log(`contact: 已暂停/卸载，候选 ${candidate.id} 本轮不动`)
    return
  }
  if (await rejectWrongScope(deps, candidate, now, epoch)) return
  const reviewed = candidate.intent ? await reviewAdaptive(deps, candidate, now, epoch, config) : null
  if (candidate.intent && !reviewed) return
  if (reviewed) candidate = reviewed.candidate
  const health = candidate.source === 'health-sleep'
  const sleepText = health ? deps.sleepText?.(candidate, deps.clock.now()) : null
  if (health && !sleepText) {
    await dropCandidate(deps.transitions, candidate, 'health:authorization-or-source-changed', now, epoch)
    return
  }
  const composed = sleepText ? { kind: 'text' as const, text: sleepText, revision: undefined } : await composeText(deps, candidate, now, epoch, config)
  if (composed.kind === 'none') {
    // 账本上的**稳定词**保持不变（`draft:unavailable`，与门控/面板同一口径）；诊断里另记
    // 精确原因，否则一条候选一天 9 次 `draft:unavailable` 会让排查方向完全跑偏（2026-10-31 事故）。
    await deps.store.noteReason(`${candidate.id} ${composed.reason}`, now, epoch).catch(() => false)
    await deferCandidate(deps.transitions, candidate, 'draft:unavailable', now, epoch)
    return
  }
  const text = composed.text
  if (deps.isFrozen()) {
    deps.log(`contact: 已暂停/卸载，候选 ${candidate.id} 不建投递（文案丢弃）`)
    return
  }
  // 冻结起草或自主复核的版本；自主跟进的 turn 也必须带上，普通 turn 保持原语义。
  const revision = composed.revision ?? reviewed?.revision
  const delivery = buildDelivery(deps.store, candidate, health ? 'direct' : config.sendMode, health ? '[睡眠摘要]' : text, now)
  if (!(await deps.store.claimDelivery(delivery, epoch))) {
    deps.log(`contact: 投递 ${delivery.id} 已被领取/已终结，跳过（不重复发）`)
    return
  }
  const row = deps.store.listDeliveries().find((entry) => entry.id === delivery.id) ?? delivery
  // `draftedAt = now` 是"起草那一刻"；`revision` 是冻结版本（P1/R5）。两者都只活在这条请求
  // 对象上，不落账本（零 schema 改）。
  const result = await deps.sender.deliver({
    delivery: row, candidate, text, now, draftedAt: now, runtime,
    ...(revision === undefined ? {} : { revision }),
  }, config)
  await settleSend(deps, candidate, row, result, now, epoch)
}

/** 结算一条投递结果并记账（从 `attemptSend` 拆出：那里已贴着 60 行的函数上限）。 */
async function settleSend(
  deps: AttemptDeps,
  candidate: ContactCandidate,
  row: ContactDelivery,
  result: Awaited<ReturnType<ContactSender['deliver']>>,
  now: number,
  epoch: number,
): Promise<void> {
  const settlement: DeliverySettlement = {
    state: result.state,
    receipt: result.receipt,
    lastError: result.state === 'confirmed' || result.state === 'submitted' ? null : result.detail,
    ...(result.state === 'submitted' || result.state === 'confirmed' ? { submittedAt: now } : {}),
    ...(result.state === 'confirmed' ? { confirmedAt: now } : {}),
  }
  const atomic = result.state === 'confirmed' || result.state === 'submitted' || result.state === 'unknown' || result.state === 'cancelled'
  try {
    if (atomic) {
      const ok = await deps.store.settleDeliveryAndAccount(row.id, epoch, settlement, now, candidate.id, result.detail)
      if (!ok) {
        deps.log(`contact: 投递 ${row.id} 结果落盘被拒（epoch 已失效），接管时按 unknown 处理`)
        return
      }
    } else {
      await deps.store.settleDelivery(row.id, epoch, settlement, now)
    }
  } catch (error) {
    // 租约失效（发送太久被接管）：结果写不进去了，读盘时那条 running 会被降级成 unknown。
    deps.log(`contact: 投递 ${row.id} 结果落盘被拒（${describe(error)}），接管时按 unknown 处理`)
    return
  }
  await afterSend(deps.transitions, candidate, result.state, result.detail, row.attempts, now, epoch, atomic)
}

/**
 * 组装这一轮的起草上下文（P2.5-3D）：**只在门控放行之后**发生，别处一次都不读库。
 *
 * `deal: 'stop'` 的三种情形都是"**不调模型**"（A2 §5.6 的降级矩阵）：
 * 读不到最近对话 / 时区算不出来 / 裁到上限还超预算。此时把候选 `defer` 并把 `earliestAt`
 * 有界推后一拍——不推的话每一拍都会再问一次平台历史（`collect` 是一次真实往返）。
 *
 * 装配没接上下文（`deps.draftContext === undefined`）时返回 `context: undefined`：
 * 那是历史用例与 `turn` 模式的路径，行为与修复前逐字相同；生产的 `direct` 装配一定接了，
 * 而且 `draft-host` 的 `requireContext` 还会再拦一次（装配漏接 = 一次调用都不发生）。
 */
async function gatherContext(
  deps: AttemptDeps,
  candidate: ContactCandidate,
  now: number,
  epoch: number,
  config: ContactConfig,
): Promise<{ kind: 'go'; context?: DraftContext } | { kind: 'stop' }> {
  const source = deps.draftContext
  if (source === undefined) return { kind: 'go' }
  const context = await source.build(candidate, now)
  const enough = sufficientContext(context)
  if (enough.ok) {
    // 诊断只写组成/条数/来源 id/裁剪与缺失原因，**不写正文**（生产日志不许出现私聊原文）。
    deps.log(`contact: 起草带上上下文：${describeDraftContext(context)}`)
    return { kind: 'go', context }
  }
  deps.log(`contact: 起草上下文不足（${enough.detail}），本轮不调模型：${describeDraftContext(context)}`)
  await deps.store
    .patchCandidate(candidate.id, { earliestAt: now + Math.max(1_000, config.pollIntervalMs) }, now, epoch)
    .catch((error: unknown) => {
      if (error instanceof StaleLeaseError) return null
      deps.log(`contact: 上下文不足时推后 earliestAt 失败：${describe(error)}`)
      return null
    })
  return { kind: 'stop' }
}

/**
 * 备文案（`turn` 用指令、`direct` 必须由模型起草）。
 *
 * 返回 `none` 时**带上精确原因**：`draft:unavailable` 是账本稳定词，但诊断需要知道
 * 是 `draft:empty`（模型回了空白）、`draft:skip`（它说算了）、`draft:reasoning-exhausted`
 * （预算被隐藏推理吃光）还是 `draft:failed`——四者的处置完全不同。
 */
async function composeText(
  deps: AttemptDeps,
  candidate: ContactCandidate,
  now: number,
  epoch: number,
  config: ContactConfig,
): Promise<{ kind: 'text'; text: string; revision?: DraftRevision } | { kind: 'none'; reason: string }> {
  if (config.sendMode === 'turn') return { kind: 'text', text: turnDirective(candidate) }
  const gathered = await gatherContext(deps, candidate, now, epoch, config)
  if (gathered.kind === 'stop') return { kind: 'none', reason: 'draft:no-context' }
  const context = gathered.context
  const outcome = await draftWithBudget(deps.draftPort(), {
    candidate,
    config,
    counters: deps.store.state.counters,
    now,
    recentCalls: deps.drafts.calls,
    ...(context === undefined ? {} : { context }),
  }, { clock: deps.clock, log: deps.log })
  // 小时环记的是"**真的向模型发起过请求**"（成功、SKIP、空文、过长、超时、失败都算），
  // 不是"拿到草稿"——`no-route`/`no-port` 那种根本没发出请求的不算（F5）。
  if (outcome.called) deps.drafts.calls = [...pruneDraftCalls(deps.drafts.calls, now), now]
  if (outcome.counters !== deps.store.state.counters) {
    await deps.store.patchCounters(outcome.counters, epoch).catch((error: unknown) => {
      if (error instanceof StaleLeaseError) return
      deps.log(`contact: 草稿计数落盘失败：${describe(error)}`)
    })
  }
  if (outcome.kind === 'draft') {
    // 冻结版本跟着草稿一起交给发送器（P1/R5）：发送前复核要拿它逐项比。
    return { kind: 'text', text: outcome.draft.text, ...(context === undefined ? {} : { revision: context.revision }) }
  }
  // 日志里两种信息都要有：一句人话（起草失败/没话可说）+ 一个**稳定词**（`draft:failed`
  // 这类），后者是排查与验收脚本唯一能 grep 的东西。
  //
  // 只有 `failed`/`timeout`/`reasoning-exhausted` 算"坏了"（它们推进退避）。`truncated`/
  // `too-long`/`skip`/`empty` 是**软失败**：模型听话地回了、只是没给出一句可发的话，
  // 不推进退避（`model.ts` 的 `noteDraftCall` 口径）——日志里把它们写成"起草失败"
  // 会让排查方向跑偏（明明模型好好的，却像是调用挂了）。
  const failed = outcome.reason === 'draft:failed' || outcome.reason === 'draft:timeout' || outcome.reason === 'draft:reasoning-exhausted'
  deps.log(failed
    ? `contact: 起草失败，这一轮没有草稿（${outcome.reason}）`
    : `contact: 这一轮没有草稿（${outcome.reason}）`)
  return { kind: 'none', reason: outcome.reason }
}
