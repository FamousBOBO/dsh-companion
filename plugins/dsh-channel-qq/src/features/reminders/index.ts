/** 提醒子插件（P5.1 / P2.5-3A）：存储 + 到点轮询器 + 工具面 + 后台资源 + 投递。
 *
 * 投递是**直发**（不过 agent）：提醒是对一个时刻的承诺，让模型决定要不要
 * 转达会把它变成 best-effort（原 `deliverReminder` 的注释即此意）。
 *
 * P1-02（安全）：`reminders.enabled=false` 时**不启动轮询器**——工具那四处判断只
 * 管"能不能新建提醒"，管不住"已经在盘上的提醒每 30 秒投一次"。两条都堵上。
 *
 * **P2.5-3A 的四条改动都在 `deliver()` 里**（顺序不许换）：
 *
 *   1. **日程 CAS**（3A-4）：`occurrence.id + revision` 先向运行时换一次"仍然有效"
 *      的确认；取消/改期/时区/DST 之后 revision 不再匹配 → 不投（terminal，不重试）。
 *   2. **共享闸门**（3A-1）：`contact.outboundBudget()`——免打扰/冷却/配额与 contact
 *      是同一份判据、同一本账。被拒 → 不投、不消耗（`skipped`），等它自己变好。
 *   3. **dryRun**（3A-3）：走完全部闸门，但**不真发**、不记账、不写 dispatched；
 *      日志里明确是 `dryRun` 而不是"已发送"。
 *   4. **真发 + 记账 + 事件**：拿到平台回执才算 `sent`（→ `contact.account()` +
 *      `occurrence-dispatched`）；拿不到回执或抛错 → `unknown`（不重试，等人工收敛）。
 */

import { ReminderStore, type Reminder } from './store.js'
import { ReminderRunner, type ReminderOutcome } from './runner.js'
import { agendaPortOf, identityOfReminder, liveSeams, nextOccurrenceOf, type AgendaIdentity } from './agenda-seam.js'
import { CATCH_UP_WINDOW_MS } from './catch-up.js'
import { registerReminderTools } from './tools.js'
import { storeOptions } from '../plugin-kit.js'
import { resolveRoomPolicy } from '../../core/room-policy.js'
import { groupRoom, dmRoom } from '../../core/room.js'
import type { QQChannelConfig } from '../../config.js'
import type { ContactService } from '../contact/types.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { SubHost, SubPlugin } from '../plugin-kit.js'

/**
 * 运行时侧的两条接缝（**缺省 = 什么都不做**，并在日志里说清楚）。
 *
 * 为什么是接缝而不是直接调用：`agenda_occurrences` 的读取与 `occurrence-dispatched`
 * 的写入都在宿主的 agenda 运行时里，本插件只拿得到"提醒要不要响"。把这两个动作做成
 * 可注入的函数，QQ 侧就能在没有 agenda 的部署里照常工作（不假装校验过日程）。
 */
export interface ReminderDeliverySeams {
  /** 3A-4：发送前用 `revision` 做一次 CAS；`ok=false` 表示这条日程已经不是原来的样子。 */
  readonly casOccurrence?: (occurrenceId: string, revision: number, identity?: AgendaIdentity) => Promise<{ ok: boolean; reason?: string }>
  /** 3A-5：真发成功后写 `agenda/occurrence-dispatched`（QQ 侧写，不打开 activityConsumer）。 */
  readonly emitDispatched?: (occurrenceId: string, revision: number, at: number, identity?: AgendaIdentity) => void
  /**
   * **等结果的** dispatched（终审 B3b）：`ok=false` 表示事件没写成功 ⇒ 调用方记一条待办，
   * 由 runner 下一拍补（**不改变投递结论**）。永不抛错。
   */
  readonly dispatchNow?: (
    occurrenceId: string,
    revision: number,
    at: number,
    identity?: AgendaIdentity,
  ) => Promise<{ ok: boolean; code?: string }>
}

let seams: ReminderDeliverySeams = {}

/** 装配侧注入（测试与将来的 agenda 适配器都走这里）。 */
export function configureReminderSeams(next: ReminderDeliverySeams): void {
  seams = next
}

// 生命周期侧（启动清理 / 卸载落盘 / 后台资源列表）在 `lifecycle.ts`：这里 import 进来用，并再导出保持对外契约不变。
import { disposeStore, pruneOnStartup, registerRemindersResource, resourceListOf , setupReminderRuntime } from './lifecycle.js'

export { disposeStore, pruneOnStartup, resourceListOf }

function roomKeyOf(reminder: Reminder): string {
  return reminder.room === 'group' ? groupRoom(reminder.target) : dmRoom(reminder.target)
}

/** 平台回执里有没有 `message_id`（有才敢说"发出去了"）。 */
function hasReceipt(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  const id = (result as { message_id?: unknown }).message_id
  return typeof id === 'number' || (typeof id === 'string' && id !== '')
}

/**
 * 投一条提醒，返回三态结论（记账由 runner 做，见 `runner.ts`）。
 *
 * 顺序即 3A 的四步；任何一步否决都**不消耗**这条提醒（除了日程失效与回执缺失：
 * 那两种按 contact 的 unknown 语义进 terminal，等人工收敛）。
 *
 * 导出是为了能直接测这四步的顺序（`test/outbound-3a.test.ts`）——它不是给别的
 * 模块调的入口：发送方仍然是 runner。
 */
/**
 * 日程 CAS（3A-4）：这条提醒的日程还"是我以为的那一版"吗。
 *
 * 演练（dryRun）**不问**——问了会在运行时那边留下一次"投递尝试"。没有 occurrence 的历史数据
 * 直接放行（它们本来就没绑）。失效按 contact 的 unknown 同款处理：terminal、不重试、留证据。
 */
async function scheduleVerdict(
  host: SubHost,
  reminder: Reminder,
  occurrence: { id: string; revision: number } | null,
  dryRun: boolean,
): Promise<'ok' | 'stale' | 'blocked'> {
  if (dryRun || occurrence === null || seams.casOccurrence === undefined) return 'ok'
  const check = await seams.casOccurrence(occurrence.id, occurrence.revision, identityOfReminder(reminder))
  if (check.ok) return 'ok'
  const why = check.reason ?? 'revision-mismatch'
  // 问不出真相（incompatible/failed/absent）⇒ 不放行也不消耗：本拍 skipped、下一拍重试（细节见设计）。
  if (why === 'agenda-incompatible' || why === 'agenda-probe-failed' || why === 'agenda-absent') {
    host.log(`reminders: ${reminder.id} 的日程判定不可用（${why}）→ 本拍不投递、**也不消耗**这条提醒`)
    return 'blocked'
  }
  host.log(`reminders: ${reminder.id} 日程已失效（${why}），不投递`)
  return 'stale'
}

/**
 * 共享闸门（3A-1）：免打扰 / 冷却 / 配额 / 通道，与 contact 同一份判据同一本账。
 *
 * **round7**：以前注释写"只读"，实际不然——contact 的账本读取在**损坏/版本不匹配**时会
 * **删旧 `.corrupt` 并 rename 当前账本**（`ledger-io.ts:81-90`）。演练模式下绝不能发生这种事，
 * 所以 **dryRun 直接不评估闸门**（代价：演练看不出"这会儿会不会被拦"，如实写进日志与文档）。
 */
async function gateAllows(host: SubHost, reminder: Reminder, room: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) {
    host.log('reminders: 演练模式不评估共享闸门（账本读取在损坏/版本不匹配时会隔离账本，演练不得触发这种写动作）')
    return true
  }
  const contact = host.get('contact') as ContactService | undefined
  if (contact === undefined) {
    host.log('reminders: 没有 contact 服务，跳过共享闸门（只有提醒自己的开关生效）')
    return true
  }
  const budget = await contact.outboundBudget({ room, sender: 'reminders' })
  if (budget.allowed) return true
  host.log(`reminders: ${reminder.id} 被共享闸门拦下（${budget.reason}），不投递`)
  return false
}

/**
 * 补发上一拍没写成的 `occurrence-dispatched`（终审 B3b）。
 *
 * 投递结论早就是 `sent` 了，这一步**只补事件**；补成功 runner 会把待办删掉。
 * 没有 agenda 接缝/没有待办 ⇒ `false`（runner 会留到下一拍，不误清）。
 */
export async function redispatchOf(reminder: Reminder): Promise<'ok' | 'absent' | 'fail'> {
  const pending = reminder.pendingDispatch ?? null
  // dryRun：**整条入口零写入**（round6 D4）——不补、不清、不加次数，留着等真的投递。
  if (pending === null || seams.dispatchNow === undefined) return 'fail'
  // 终审 round6：**恢复路径也要带身份**（正常路径一直传了，这里以前漏了 ⇒ dispatched 会 not-found）。
  const verdict = await seams.dispatchNow(pending.occurrenceId, pending.revision, pending.at, identityOfReminder(reminder))
  // 没有 agenda：这条待办无处可写 ⇒ 作废（不要累加次数白跑到放弃）。
  if (verdict.code === 'agenda-absent') return 'absent'
  return verdict.ok ? 'ok' : 'fail'
}

/**
 * **准入判定**（日程 CAS + 共享闸门），返回该拍的处置。
 *
 * **round7**：演练模式下这两步**都不许把异常变成写入**——以前闸门抛错会冒到 runner，
 * 被记成 `markUnknown()`（清 sent 字段、终结一次性或推进周期）。现在：
 * 演练里抛错 ⇒ 返回 `dry-run`（零写入）；非演练抛错 ⇒ 返回 `unknown`（不重发，等人工收敛）。
 */
async function admit(
  host: SubHost,
  reminder: Reminder,
  occurrence: { id: string; revision: number } | null,
  room: string,
  dryRun: boolean,
): Promise<'ok' | ReminderOutcome> {
  try {
    // **顺序：闸门 → CAS**（task-66 / Lead 裁定）。代价不对称： - 闸门先、CAS 失败 ⇒ 白问一次闸门，下一拍重问（**无害**） - CAS 先、闸门拒绝 ⇒ occurrence 被吃掉、用户一条没收到（**静默丢事件**）
    // 所以：先本地便宜的、可逆的；后远端贵的、不可逆的。不变量：**occurrence 只能在"确定要发"之后才认领**。
    if (!(await gateAllows(host, reminder, room, dryRun))) return 'skipped'
    const verdict = await scheduleVerdict(host, reminder, occurrence, dryRun)
    // `blocked` = 日程判定不可用：**跳过且不消耗**（走 `skipped`，runner 不会写 fired/at）。
    if (verdict === 'stale') return 'unknown'
    if (verdict === 'blocked') return 'skipped'
    return 'ok'
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (dryRun) {
      host.log(`reminders: 演练模式里闸门/日程判定抛错（${reason}）→ 按演练处理，不写任何状态`)
      return 'dry-run'
    }
    host.log(`reminders: 闸门/日程判定抛错（${reason}）→ 按 unknown 处理（不重发，等人工收敛）`)
    return 'unknown'
  }
}

export async function deliverReminder(host: SubHost, reminder: Reminder): Promise<ReminderOutcome> {
  const parts = host.get('platform')
  if (parts === undefined) return 'skipped'
  const { api, out } = parts
  const room = roomKeyOf(reminder)
  // ① dryRun（3A-3，默认 true = 灰度）。**终审 B2 + round7/8**：这一拍**绝不动任何持久状态**。 - 返回值是独立的 `'dry-run'`，runner 见它**什么都不写**（不写 fired/at/occurrence）； - 日程 CAS 只在**真发**时问（演练不该在运行时那边留下一次"投递尝试"）；
  //   - **共享闸门在演练下不评估**（读账本遇损坏会隔离账本，那是写动作）；代价：演练看不出会不会被拦。
  const dryRun = host.config.reminders.dryRun !== false
  const occurrence = reminder.occurrence ?? null

  // ② 日程 CAS + ③ 共享闸门（含 round7 的"演练期间异常不许落 unknown"）→ admit()
  const admission = await admit(host, reminder, occurrence, room, dryRun)
  if (admission !== 'ok') return admission

  // ④ 演练：闸门跑完了，到此为止——不真发、不记账、不写 dispatched，也**不改这条提醒的状态**。
  if (dryRun) {
    host.log(`reminders: dryRun 命中 ${reminder.id} → ${room}（本来要发：${reminder.text.slice(0, 40)}；`
      + '未真发、未记账、未写事件，且**不消耗这条提醒**——退出 dryRun 后它还会响）')
    return 'dry-run'
  }

  // ⑤ **错过这一轮的周期提醒**（round5 D4）：不终结，**推进到下一轮**。 位置很关键：必须在 dryRun 判断**之后**——dryRun 下一行持久状态都不许写（B2 的规矩）， 放在前面就会变成"演练模式下把 daily/weekly 永久停掉"。
  const store = host.get('reminders')
  if (reminder.repeat !== 'none' && reminder.at < Date.now() - CATCH_UP_WINDOW_MS) {
    const skipped = store === undefined ? false : await store.skipRound(reminder.id)
    host.log(`reminders: ${reminder.id} 错过这一轮（${new Date(reminder.at).toISOString()} 早于补发窗口）`
      + `→ **只跳过这一轮**，已推进到下一轮${skipped ? '' : '（推进没落盘，下次 tick 再试）'}；周期提醒不会被终结`)
    return 'skipped'
  }

  // ⑥ **崩溃恢复**（终审 B3b）：这一轮已经发过了？那就不再发——靠 store 判定，不靠 CAS。
  // 场景：平台回执拿到后、"已发出"落盘成功后进程崩了（dispatched 还没写、runner 还没记账）。
  // 以前这种情况重启会**再发一次**；现在 `sentFor` 与这条提醒的 `at` 对得上 ⇒ 认账不发。
  if (store !== undefined && store.sentForRound(reminder.id, reminder.at)) {
    host.log(`reminders: ${reminder.id} 这一轮（${new Date(reminder.at).toISOString()}）已发过（崩溃恢复），不重发`)
  } else {
    // ⑦ 真发 + 记账 + 落盘（顺序与取舍都在 `sendOnce` 里）。
    const verdict = await sendOnce(host, store, reminder, room, api, out)
    if (verdict !== 'sent') return verdict
  }

  // ⑧ 3A-5 + B3b：投递成功后由 QQ 侧写 occurrence-dispatched；写不成功就**记待办**，
  // 由 runner 下一拍补（投递结论仍然是 `sent`，不受影响）。
  if (occurrence !== null) {
    await dispatchedOrPending(host, store, reminder, occurrence)
  }
  return 'sent'
}

/**
 * **真发一次 + 记账 + 把"已发出"落盘**（终审 B3b / B8）。
 *
 * 顺序是硬约定：平台回执 → 记账 → `store.markSent()` 落盘 → **才**允许写 dispatched。
 * `markSent` 回 `Mutation`；**故障会 reject**。两种都只说明"已发出但没落盘" ⇒ 按 `unknown` 处理
 * （`unknown` 会被写成终态，因此**不重发**）；若连 `markUnknown` 也失败 ⇒ 记账路径**无条件停表**。
 */
async function sendOnce(
  host: SubHost,
  store: ReminderStore | undefined,
  reminder: Reminder,
  room: string,
  api: { sendTo(group: boolean, target: number, message: OneBotMessageSegment[]): Promise<unknown> },
  out: { push<T>(send: () => Promise<T>): Promise<T> },
): Promise<ReminderOutcome> {
  const message: OneBotMessageSegment[] = [{ type: 'text', data: { text: `⏰ 到点了：${reminder.text}` } }]
  const result = await out.push(() => api.sendTo(reminder.room === 'group', reminder.target, message))
  if (!hasReceipt(result)) {
    host.log(`reminders: ${reminder.id} 已提交但拿不到回执 → unknown（不重发，等人工收敛）`)
    return 'unknown'
  }
  host.log(`reminder delivered to ${reminder.room}-${reminder.target}: ${reminder.text.slice(0, 40)}`)
  // 3A-1：**真发成功才记账**（配额是"真发出去几条"，演练与被拒都不消耗）。
  const contact = host.get('contact') as ContactService | undefined
  if (contact !== undefined) {
    await contact.account({ room, sender: 'reminders', reason: 'reminder-delivered' }).catch((error: unknown) => {
      host.log(`reminders: 共享账本记账失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  // task-66：markSent 回 Mutation，故障会 reject；两者都只说明"已发出但没落盘"⇒ 按 unknown 处理。
  let sentOk = true
  if (store !== undefined) {
    try {
      const sent = await store.markSent(reminder.id, reminder.at)
      if (!sent.ok) host.log(`reminders: ${reminder.id} 记账被业务拒绝（${sent.code}：${sent.message}）`)
      sentOk = sent.ok
    } catch (error) {
      host.log(`reminders: ${reminder.id} 已真发但"已发出"**没写进盘**（${error instanceof Error ? error.message : String(error)}）`)
      sentOk = false
    }
  }
  if (!sentOk) {
    host.log(`reminders: ${reminder.id} 已真发但状态没落盘 → 按 unknown 处理（不写 dispatched、不重发）`)
    return 'unknown'
  }
  return 'sent'
}

/** dispatched 这一步：等结果 → 成功就清待办，失败/抛错就记待办（永不改变投递结论）。 */
async function dispatchedOrPending(
  host: SubHost,
  store: ReminderStore | undefined,
  reminder: Reminder,
  occurrence: { id: string; revision: number },
): Promise<void> {
  const at = Date.now()
  const payload = { occurrenceId: occurrence.id, revision: occurrence.revision, at }
  if (seams.dispatchNow === undefined) {
    // 老装配只有 fire-and-forget：照旧发出去，但没有"成功了没有"的回执可记。
    if (seams.emitDispatched !== undefined) {
      seams.emitDispatched(occurrence.id, occurrence.revision, at, identityOfReminder(reminder))
      await store?.clearPendingDispatch(reminder.id)
    } else {
      host.log('reminders: 没有 agenda 接缝，occurrence-dispatched 未写（不假装写过）')
    }
    return
  }
  // 接缝的契约是"永不抛错"，但那是**我们自己**的实现；别人注入的桩可能抛。
  // 投递已经成功了，所以这里必须自己兜住：抛出去会被 runner 记成 unknown（冤枉一次成功）。
  let verdict: { ok: boolean; code?: string }
  try {
    verdict = await seams.dispatchNow(occurrence.id, occurrence.revision, at, identityOfReminder(reminder))
  } catch (error) {
    verdict = { ok: false, code: `dispatch-threw:${error instanceof Error ? error.message : String(error)}` }
  }
  if (verdict.ok) {
    await store?.clearPendingDispatch(reminder.id)
    return
  }
  // **"根本没有 agenda"不是"写失败"**（round4 追加）：没有接缝时不该每次投递都记一条待办、
  // 让 runner 白补 10 拍再放弃（那会把日志刷满、还把 overLimit 计数污染掉）。与老行为一致：
  // 只记一句"未写（不假装写过）"，不留待办。真正的写失败（有 fixtures 但写不进）才记待办。
  if (verdict.code === 'agenda-absent') {
    host.log('reminders: 没有 agenda 接缝，occurrence-dispatched 未写（不假装写过）')
    await store?.clearPendingDispatch(reminder.id)
    return
  }
  host.log(`reminders: ${reminder.id} occurrence-dispatched 未写成（${verdict.code ?? 'unknown'}）→ 记待办，下一拍补；投递结论仍是 sent`)
  await store?.setPendingDispatch(reminder.id, payload)
}

/**
 * 这条提醒现在能不能投（P1-02 的二次判定，纯函数）。
 *
 * 三条：开关没关 / 目标在 `allowedRooms`（没配就都算） / 群没被按群策略关掉。
 * 房间被关掉时**不消耗**提醒——配置改回来它还会响。
 */
export function reminderDeliverable(config: QQChannelConfig, reminder: Reminder): boolean {
  if (config.reminders.enabled !== true) return false
  const allow = config.reminders.allowedRooms
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(reminder.target)) return false
  if (reminder.room === 'group' && resolveRoomPolicy(config, reminder.target).enabled === false) return false
  return true
}

/**
 * `reminders` 后台资源的 `list()`：清单 + **真实测量的诊断指标**。
 *
 * `pendingDispatch` 三个数都是数出来的（没有待办时是 `0`，**不是** `not-wired`）：
 * `value` 还在等补发的事件条数、`oldestAgeMs` 最老那条等了多久、`overLimit` 补到上限后放弃的条数。
 */
export const remindersPlugin: SubPlugin = {
  name: 'reminders',
  watches: [],
  requires: ['platform'],

  async apply(host) {
    const base = storeOptions(host)
    // **P1（第三次）**：不许覆盖 workspacePath —— 生产里它是 null，Store 自己按「null ⇒ <dshHome>/channel-qq」解析。
    // 这里以前写 `?? base.dshHome`，把文件指到了 home/reminders.json（真实文件在 home/channel-qq/）。
    const store = new ReminderStore(host.config.reminders, base)
    // **P1（复审 1.3）**：构造函数就把自己注册进 OWNERS。下面任何一步抛出（典型：坏文件 +
    // `dryRun=false` ⇒ `pruneOnStartup` 抛）都必须把 store 关掉，否则同一路径后续 `new
    // ReminderStore` 永远抛 `OWNER_CONFLICT` —— "文件坏一次"会升级成"提醒子系统本进程内彻底失活"。
    try {
    await store.load()
    await pruneOnStartup(host, store)
    host.provide('reminders', store)
    // 诊断面要读 runner 的**只读现场**（停表/为什么停/软故障连击），而 runner 在下一步才建
    // ⇒ 交一个**晚绑定**取值器给资源表（`list()` 是调用时才读，不新增任何写路径）。
    let runner: ReminderRunner | null = null
    registerRemindersResource(host, store, () => runner?.status() ?? null)
    const { api, out } = host.need('platform')
    runner = setupReminderRuntime({ host, store, api, out })
    // 同一份只读现场也交给后台快照（`/api/snapshot` 的 `remindersRunner`）：资源面之外的第二个出口，
    // 两个出口读的是**同一个** `status()`，不是抄一份字段（round17 §1-17.2）。
    host.provide('remindersRunner', runner)
    const disposeTools = registerReminderTools(host.bridge.toolHost(), host.config, api, out, host.log, store)
    return async () => {
      disposeTools()
      runner?.dispose()
      await disposeStore(host, store)
    }
    } catch (error) {
      // `close()` 自己也可能抛（drain 失败）——**不许让它的错盖掉原错**。
      try { await store.close() } catch { host.log('reminders: apply 失败后关 store 也失败（原错照抛）') }
      throw error
    }
  },
}
