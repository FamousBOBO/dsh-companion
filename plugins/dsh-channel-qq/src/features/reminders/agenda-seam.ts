/** 提醒 ↔ H1 日程的**适配层**（P2.5-3A-4「补水」）。
 *
 * 裁决（`design/p2.5-decisions-outbound.md` 补 4）：**时间的事实来源只有一个 —— runtime 的
 * H1 日程；存储归 QQ，时间归 runtime。** QQ 侧因此要两件事：
 *
 *   1. **写入路径**：建提醒时先向 agenda 建日程，拿到 `occurrenceId + revision` 再存进提醒
 *      （`ReminderStore.add({ occurrence })`）。没有生产者，接缝接上也永远没人校验。
 *   2. **两条接缝**：`casOccurrence`（发送前问一句"还是那一版吗"）与
 *      `emitDispatched`（真发成功后写 `agenda/occurrence-dispatched`）。
 *
 * 为什么单独一个文件：foundation 的富签名（`{occurrenceId, revision, at}` /
 * `{occurrenceId, revision, at, receipt}` → `{ok, revision, code…}`）与 QQ 侧要的最小形状
 * 不是一回事，映射集中在这里，提醒主流程就只看见两个窄函数。
 *
 * **诚实降级**：没有 agenda 服务时提醒照建、但**没有 occurrence**，工具返回值里必须明说
 * "未与日程绑定，改期/取消不会自动失效"——不许假装绑定了。
 */

import { dmRoom, groupRoom, sessionIdOf } from '../../core/room.js'
import type { ReminderDeliverySeams } from './index.js'

/** foundation `companion:agenda` 上我们用到的那几个能力（富签名，照 foundation 原样）。 */
/**
 * **QQ 侧身份**（round5 C4 后半）：runtime 用 `identity.resolve(sessionId)` 解出 scope，
 * **不传 sessionId 的调用一律 `not-found`**，无论其余参数多正确。
 * 与建日程（`tools.ts::sessionIdOfForRoom`）用**同一个**派生规则：`qq-dm-<uid>` / `qq-group-<gid>`。
 */
export interface AgendaIdentity { readonly sessionId: string }

/** 从一条提醒派生身份（房间 + 目标 → canonical sessionId）。目标非法时 `undefined`（诚实降级）。 */
export function identityOfReminder(reminder: { readonly room: string; readonly target: number }): AgendaIdentity | undefined {
  if (!Number.isFinite(reminder.target) || reminder.target <= 0) return undefined
  const sessionId = sessionIdOf(reminder.room === 'group' ? groupRoom(reminder.target) : dmRoom(reminder.target))
  return sessionId === '' ? undefined : { sessionId }
}

export interface AgendaPort {
  /** 建一条日程；返回它的 `occurrenceId` 与初始 `revision`。 */
  createSchedule?(input: {
    readonly text: string
    readonly at: number
    readonly room: 'group' | 'dm'
    readonly target: number
    readonly createdBy: number
    /**
     * **必须能解析出 scope**（终审 B3-A）：foundation 用它去问 runtime，runtime 由 binding/sessionId
     * 解 scope；缺失时建不出绑定。拿不到就**不要传**，适配层会诚实降级（提醒照建、无 occurrence）。
     */
    readonly sessionId?: string
  }): Promise<{ ok: boolean; occurrenceId?: string; revision?: number; occurrence?: { id?: string; revision?: number }; code?: string }>
  /** 发送前的 CAS：这一版还是我以为的那一版吗。 */
  casOccurrence?(input: {
    readonly occurrenceId: string
    readonly revision: number
    readonly at: number
  }): Promise<{ ok: boolean; revision?: number; code?: string; actualRevision?: number }>
  /** 真发成功后的回执事件。 */
  markOccurrenceDispatched?(input: {
    readonly occurrenceId: string
    readonly revision: number
    readonly at: number
    readonly receipt: unknown
  }): Promise<{ ok: boolean; revision?: number; code?: string }>
  /**
   * **可选**：给同一个日程取"下一版"（周期提醒重绑用）。runtime 若没实现，适配层会退回
   * `createSchedule()` 新建一条（语义上说得通：下一轮本来就是新的一次机会）。
   */
  nextOccurrence?(input: {
    readonly occurrenceId: string
    readonly at: number
  }): Promise<{ ok: boolean; occurrenceId?: string; revision?: number; occurrence?: { id?: string; revision?: number }; code?: string }>
}

// 探测的纯逻辑（能力校验 + 候选解析）在 `agenda-probe.ts`：这里只再导出，保持对外契约不变。
export { AGENDA_SERVICE_CANDIDATES, agendaPortCapability, probeAgendaCandidates } from './agenda-probe.js'

let port: AgendaPort | null = null

/** **惰性解析器**（终审 round4 C4）：每次用到 agenda 时重新问一次宿主。 */
let resolver: (() => AgendaPort | null) | null = null

/**
 * **端口探测结果的三态之外还有一档**（round7）：只看"有没有对象"会把三种完全不同的情况
 * 混成一句 `absent`：
 *
 * | 状态 | 含义 | CAS 该不该放行 |
 * |---|---|---|
 * | `ok` | 拿到能力齐全的端口 | 正常问 CAS |
 * | `absent` | 宿主**没有**这个服务（没装 / 还没发布） | **不放行**（走到 CAS 就说明这条提醒已绑定；问不出真相 ≠ 没绑） |
 * | `incompatible` | 有对象但**能力不全**（旧版本 / 撞名） | **不许放行**（问不出真相，不能假装没绑） |
 * | `failed` | 探测本身**抛错**（`ctx.get` 抛） | **不许放行**（同上） |
 *
 * 以前 `incompatible` / `failed` 都被折成 `absent` ⇒ **已绑定 occurrence 的提醒会绕过 CAS**。
 * **task-66** 再把 `absent` 也改成不放行：三条"问不出真相"的状态在 CAS 与 dispatch 上口径一致（都不放行）。
 */
export type AgendaProbeState = 'ok' | 'absent' | 'incompatible' | 'failed'

/** 探测器的返回值：端口 + 它为什么是这个状态。 */
export interface AgendaProbe {
  readonly port: AgendaPort | null
  readonly state: AgendaProbeState
}

/** 装配侧注入（`plugin.ts` 从宿主 `companion:agenda` 取到之后调它）。 */
export function configureAgendaPort(next: AgendaPort | null): void {
  port = next
  probeState = next === null ? 'absent' : 'ok'
}

/**
 * **登记探测器**（round7）：返回 `{ port, state }`，让"没装 / 能力不全 / 探测抛错"三件事分得开。
 *
 * 传 `null` = 取消探测（回到"只用 `configureAgendaPort` 注入的对象"）。
 */
export function configureAgendaProbe(
  next: (() => AgendaProbe) | null,
  log?: (line: string) => void,
): void {
  probe = next
  if (log !== undefined) logger = log
  nullStreak = 0
}

/**
 * **登记惰性解析器**（终审 round4 C4）：`agenda` 服务常常**比我们晚发布**
 * （foundation 还没起来），启动时探一次就固定成 `null` 的话，之后永远接不上。
 *
 * 传 `null` = 取消惰性解析。**保留这个签名是为了测试与旧装配**：它把"有端口"记成 `ok`、
 * "没端口"记成 `absent`（分不出 `incompatible` / `failed`——要分就用 `configureAgendaProbe`）。
 */
export function configureAgendaResolver(
  next: (() => AgendaPort | null) | null,
  log?: (line: string) => void,
): void {
  resolver = next
  configureAgendaProbe(next === null ? null : () => {
    const found = next()
    return found === null ? { port: null, state: 'absent' } : { port: found, state: 'ok' }
  }, log)
}

/** 连续几次解析不到就丢弃旧端口（`task-59` P2）。 */
export const AGENDA_NULL_STREAK_LIMIT = 3

let logger: ((line: string) => void) | null = null
let nullStreak = 0
let probe: (() => AgendaProbe) | null = null
let probeState: AgendaProbeState = 'absent'

/**
 * 取 agenda 端口：**每次都重新解析**（惰性）。五条规矩：
 *   1. 解析到就用新的（并缓存下来，供下次解析失败时兜底）；
 *   2. **偶发一次 `absent`**（宿主这一拍没给到服务）时**保留**上次的——瞬时抖动不该把已接上的端口丢掉；
 *   3. **连续 `AGENDA_NULL_STREAK_LIMIT` 次 `absent` ⇒ 丢弃旧引用**并记日志（`task-59` P2）；
 *   4. **`incompatible` / `failed` 是"问不出真相"，不是"没有服务"**（round8 P1）：
 *      ⇒ **立刻停用缓存端口**、状态原样上报（**绝不许降级成 `absent`**，那会放行 CAS）。
 *      这条不走 streak：能力不全/探测抛错一次就已经不可信，再多用一次就是把已绑定的提醒放过去。
 *   5. 解析器抛错也不炸调用方（算 `failed`）。
 */
function resolvePort(): { port: AgendaPort | null; state: AgendaProbeState } {
  if (probe !== null) {
    let result: AgendaProbe = { port: null, state: 'failed' }
    try {
      result = probe()
    } catch {
      result = { port: null, state: 'failed' }
    }
    if (result.port !== null) {
      port = result.port
      probeState = 'ok'
      nullStreak = 0
    } else if (result.state === 'incompatible' || result.state === 'failed') {
      // 规矩 4：立刻停用旧引用，状态照实上报。
      probeState = result.state
      nullStreak = 0
      if (port !== null) {
        port = null
        logger?.(`reminders: agenda 探测结果是 ${result.state}（不是"没有服务"）→ 立刻停用缓存端口，`
          + 'CAS 不放行（已绑定 occurrence 的提醒不能绕过校验）')
      }
    } else {
      probeState = result.state
      nullStreak += 1
      if (port !== null && nullStreak >= AGENDA_NULL_STREAK_LIMIT) {
        port = null
        // **round8（P1）**：清缓存**绝不许把状态改写成 `absent`**——那等于把"探测失败/能力不全"
        // 降级成"确实没有服务"，而 `absent` 是**会放行 CAS** 的那一档，已绑定 occurrence 的提醒
        // 就绕过了校验。这里只丢**引用**，状态保留 `result.state`。
        logger?.(`reminders: agenda 端口连续 ${String(nullStreak)} 次解析不到，已丢弃旧引用`
          + `（保留状态 ${result.state}；宁可明确"不可用"，也不继续用一个可能已被卸载的）`)
        nullStreak = 0
      }
    }
  }
  return { port, state: port === null ? (probeState === 'ok' ? 'absent' : probeState) : 'ok' }
}

export function agendaPortOf(): AgendaPort | null {
  return resolvePort().port
}

/** **当前探测状态**（`round7`）：`ok` / `absent` / `incompatible` / `failed`。 */
export function agendaPortState(): AgendaProbeState {
  return resolvePort().state
}

/**
 * 把 agenda 端口映射成提醒主流程要的两条窄接缝。
 *
 * 两条都被刻意"永不抛错"：
 *   - `casOccurrence`：**抛错也算不过**（`ok:false, reason:'cas-threw'`），因为"问不出来"
 *     在安全方向上等于"不能证明它还是那一版"；
 *   - `emitDispatched`：**必须自己吞异常**——它在真发成功之后被调用，抛错会把一条**已经
 *     发出去**的提醒记成 `unknown`（不会重发，但状态难看、还要人工收敛）。
 */
/**
 * **每次用到时才去解析 agenda 的接缝**（终审 round4 C4）。
 *
 * 与 `seamsOf(agenda, log)` 的区别：那个把 `agenda` **固定**在闭包里（启动没探到就永远没有）；
 * 这个每次调用都走 `agendaPortOf()`，所以"启动时还没有、之后 foundation 发布了"也能接上。
 * 没有 agenda 时行为与"未接缝"一致（CAS 放行、dispatched 报 `agenda-absent`）。
 */
export function liveSeams(log: (line: string) => void): ReminderDeliverySeams {
  const inner = (): { seams: ReminderDeliverySeams; state: AgendaProbeState } => {
    const resolved = resolvePort()
    return { seams: resolved.port === null ? {} : seamsOf(resolved.port, log), state: resolved.state }
  }
  return {
    casOccurrence: async (occurrenceId, revision, identity) => {
      const { seams: current, state } = inner()
      if (current.casOccurrence === undefined) {
        // **task-66（第十轮 D1 第 3 条，复审连点两轮的那条）**：
        // 走到 casOccurrence 就说明**这条提醒绑了 occurrence**——没绑的根本不会进这里。
        // 所以 `absent`（宿主没这个服务）**不能**当"本来就没绑日程"放行：那是让已绑定提醒绕过版本校验。
        // 口径与 `dispatchNow` 一致：同一个状态在两条接缝上**都不放行**。
        if (state === 'absent') {
          log('reminders: agenda 服务不在（absent），但这条提醒**已绑定 occurrence** → CAS 不放行')
          return { ok: false, reason: 'agenda-absent' }
        }
        log(`reminders: agenda 端口不可用（${state}）→ CAS **不放行**（不假装"没绑日程"）`)
        return { ok: false, reason: state === 'failed' ? 'agenda-probe-failed' : `agenda-${state}` }
      }
      return await current.casOccurrence(occurrenceId, revision, identity)
    },
    dispatchNow: async (occurrenceId, revision, at, identity) => {
      const { seams: current, state } = inner()
      if (current.dispatchNow === undefined) {
        return { ok: false, code: state === 'absent' ? 'agenda-absent' : (state === 'failed' ? 'agenda-probe-failed' : `agenda-${state}`) }
      }
      return await current.dispatchNow(occurrenceId, revision, at, identity)
    },
  }
}

export function seamsOf(agenda: AgendaPort | null, log: (line: string) => void): ReminderDeliverySeams {
  if (agenda === null) return {}
  return {
    casOccurrence: async (occurrenceId: string, revision: number, identity?: AgendaIdentity) => {
      const cas = agenda.casOccurrence
      if (cas === undefined) return { ok: true, reason: 'agenda-no-cas' }
      try {
        // C4：**必须**带 sessionId，runtime 靠它解 scope；缺了就是 not-found。
        const result = await cas({ occurrenceId, revision, at: Date.now(), ...(identity ?? {}) })
        if (result.ok) return { ok: true }
        return { ok: false, reason: result.code ?? `revision-mismatch:${String(result.actualRevision ?? '?')}` }
      } catch (error) {
        log(`reminders: 日程 CAS 抛错（按"不过"处理）：${error instanceof Error ? error.message : String(error)}`)
        return { ok: false, reason: 'cas-threw' }
      }
    },
    emitDispatched: (occurrenceId: string, revision: number, at: number, identity?: AgendaIdentity) => {
      const mark = agenda.markOccurrenceDispatched
      if (mark === undefined) return
      void Promise.resolve()
        .then(async () => await mark({ occurrenceId, revision, at, receipt: { at }, ...(identity ?? {}) }))
        .then((result) => {
          if (!result.ok) log(`reminders: occurrence-dispatched 未被接受（${result.code ?? 'unknown'}）`)
        })
        .catch((error: unknown) => {
          // **吞掉**：这条提醒已经发出去了，事件写失败不该改变投递结论。
          log(`reminders: occurrence-dispatched 写入失败（已吞，不影响投递结论）：${error instanceof Error ? error.message : String(error)}`)
        })
    },
    /**
     * **等结果的 dispatched**（终审 B3b）：与上面的 fire-and-forget 相反，它把"写没写成功"
     * 交回给调用方，好让调用方决定"记待办等下一拍补"。仍然**永不抛错**。
     */
    dispatchNow: async (occurrenceId: string, revision: number, at: number, identity?: AgendaIdentity) => {
      const mark = agenda.markOccurrenceDispatched
      if (mark === undefined) return { ok: false, code: 'agenda-no-dispatch' }
      try {
        const result = await mark({ occurrenceId, revision, at, receipt: { at }, ...(identity ?? {}) })
        return result.ok ? { ok: true } : { ok: false, code: result.code ?? 'dispatch-rejected' }
      } catch (error) {
        return { ok: false, code: `dispatch-threw:${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

/**
 * 日程结果 → 提醒要存的 occurrence（拿不到就返回 null，由调用方诚实降级）。
 *
 * **终审 B3-B**：两种形状都要吃——
 *   - 平铺：`{ ok, occurrenceId, revision }`（QQ 侧早期假设的形状）；
 *   - 嵌套：`{ ok, occurrence: { id, revision } }`（foundation 的 `nextOccurrence` 实际返回这个）。
 * 以前只读平铺，于是**每次换绑都把绑定解除**（拿不到 id ⇒ null ⇒ 清空）。先读嵌套、再回落平铺。
 */
export function occurrenceOf(
  result: {
    ok: boolean
    occurrenceId?: string
    revision?: number
    occurrence?: { id?: string; revision?: number } | null
    code?: string
  } | null,
): { id: string; revision: number } | null {
  if (result === null || !result.ok) return null
  const nested = result.occurrence ?? null
  const id = nested?.id ?? result.occurrenceId
  const revision = nested?.revision ?? result.revision
  if (typeof id !== 'string' || id === '' || typeof revision !== 'number' || !Number.isFinite(revision)) return null
  return { id, revision }
}

/**
 * **周期提醒换绑取数**（P2.5-3A-4 收尾）：问 agenda 要这条日程**下一轮**的 occurrence。
 *
 * **只用 `nextOccurrence({occurrenceId, at})`，绝不拿 `createSchedule()` 兜底**（裁决 ②）：
 * 兜底会让"每天 7 点"这种提醒每轮在事件书里新建一条日程（一天几十条无意义的 schedule 变更），
 * 污染事件书，比不绑定更糟。拿不到 ⇒ `null` ⇒ 调用方**清空绑定**（`已解除日程绑定`）。
 *
 * 永不抛错（抛错会让"本轮已发出的提醒"被记成别的状态）。
 */
export async function nextOccurrenceOf(reminder: {
  readonly at: number
  readonly room?: string
  readonly target?: number
  readonly occurrence?: { id: string; revision: number } | null
}): Promise<{ id: string; revision: number } | null> {
  const agenda = agendaPortOf()
  if (agenda === null || agenda.nextOccurrence === undefined) return null
  const scheduleId = reminder.occurrence?.id
  if (typeof scheduleId !== 'string' || scheduleId === '') return null
  // C4：**换绑取数也要带身份**——runtime 靠 `sessionId` 解 scope，缺了同样是 `not-found`，
  // 于是"拿不到下一次"会把周期提醒的绑定清空（看起来像"日程被取消了"）。
  const identity = reminder.room === undefined || reminder.target === undefined
    ? undefined
    : identityOfReminder({ room: reminder.room, target: reminder.target })
  try {
    return occurrenceOf(await agenda.nextOccurrence({ occurrenceId: scheduleId, at: reminder.at, ...(identity ?? {}) }))
  } catch {
    return null
  }
}
