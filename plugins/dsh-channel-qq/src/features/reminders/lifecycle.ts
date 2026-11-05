/**
 * 提醒插件的**生命周期侧**：启动清理、卸载落盘策略、后台资源列表。
 *
 * 为什么单独一个文件：`index.ts` 已经接近 400 行硬上限（`scripts/check-size.mjs`），
 * 而这三件事与"投递判定"无关——它们是**入口/装配**的事，搬出来更清楚，也避免为了塞行数
 * 把判定逻辑揉成一团。
 */

import type { Reminder, ReminderStore } from './store.js'
import type { SubHost as SubHostForResource } from '../plugin-kit.js'
import type { SubHost } from '../plugin-kit.js'

/**
 * **启动清理**（一次性提醒触发后保留 7 天给主人回看，之后清掉，否则文件无界增长）。
 *
 * **终审 round6/round7 D4**：dryRun 下**不做**——演练承诺"整条入口零写入"，而 prune 会删行；
 * 等真的开始投递时再清。
 */
export async function pruneOnStartup(host: SubHost, store: ReminderStore): Promise<void> {
  if (host.config.reminders.dryRun !== false) {
    host.log('reminders: dryRun 生效 → 跳过启动清理（pruneFired），演练期间不写盘')
    return
  }
  // **task-66**：业务拒绝（NOT_APPLICABLE/NOT_FOUND）不是故障；**基础设施故障必须冒出去**（不许吞）。
  const pruned = await store.pruneFired()
  if (!pruned.ok) {
    host.log(`reminders: 启动清理跳过（${pruned.code}：${pruned.message}）`)
    return
  }
  if (pruned.value.length > 0) host.log(`reminders: pruned ${String(pruned.value.length)} fired one-shot reminder(s)`)
}

/**
 * **卸载（task-66）**：不再"补存"——每次成功变更在事务里已经落盘了。
 *
 * 现在只做"停止受理 → 等已受理事务跑完"（排空）。演练模式下连排空都不用等新写入（本来就没有）。
 */
export async function disposeStore(host: SubHost, store: ReminderStore): Promise<void> {
  const pending = typeof store.queueSize === 'function' ? store.queueSize() : 0
  if (pending > 0) host.log(`reminders: 卸载前排空（还在跑 ${String(pending)} 笔事务）`)
  await store.close()
  host.log('reminders: 存储已关闭（不再受理写入；已受理的事务全部完成）')
  // **task-66**：演练模式下"卸载不保存"必须说出来——用户需要知道"演练期间没有任何东西被写回"。
  if (host.config.reminders.dryRun !== false) {
    host.log('reminders: dryRun 生效 → 卸载时**不保存**（演练期间没有任何东西写回磁盘）')
  }
}

/**
 * 后台「提醒」资源列表——**与投递同一份事实**：条数、每条、待补发、补发/丢弃诊断。
 *
 * `honest: 'measured'` 是**QQ 侧自己的标注**（不是 runtime 那套四档），意思是"这些都是读出来的实数，
 * 不是估计"。改名会破坏后台契约，所以留着。
 *
 * `runtime` 是**晚绑定取值器**：资源在 `apply()` 里先注册、runner 后建（见 `index.ts`），
 * 所以这里只拿一个"调用时才解析"的函数，不拿实例——顺带保证不新增任何写路径。
 */
export function resourceListOf(store: ReminderStore, runtime?: () => RunnerStatus | null): () => {
  count: number | null
  reminders: Reminder[]
  pendingDispatch: { value: number; oldestAgeMs: number; overLimit: number }
  catchUp: {
    backlog: number; dropped: number; droppedTotal: number; droppedTruncated: boolean
    droppedLast24h: number; lastDroppedAt: number | null; windowMs: number; maxTotal: number
    droppedItems: { at: number; text: string; reason: string }[]
  }
  /** **读失败锁**（round9）：非 `null` 时 `count` 是 `null`（**不许拿 0 冒充"没有提醒"**）。 */
  readLock: { at: number; reason: string; source: string; detail: string } | null
  /**
   * **轮询器现场**（round16 §8.7/§2.2）：`null` = 还没有 runner（没装/装配失败）；
   * 否则是"有没有停表、为什么停、软故障连击几拍"——**只读**，与投递同一份事实。
   */
  runner: RunnerStatus | null
  honest: 'measured'
} {
  return () => {
    // **round9**：读不出来的时候内存里是空表。这时 `count: 0` 会被读成"没有提醒"——那是**假事实**。
    // 所以 `count` 直接给 `null`，另附 `readLock` 说明原因；前端据此显示"读失败，数据不可读"。
    const readLock = store.readFailure()
    return {
      count: readLock === null ? store.list(300).length : null,
      reminders: store.list(300),
      pendingDispatch: store.dispatchDiagnostics(),
      // 防雪崩的两个数：还在等补发的、以及**因积压被丢弃**的（`skipped-expired:backlog-overflow`）。
      catchUp: store.catchUpDiagnostics(),
      readLock,
      runner: runtime?.() ?? null,
      honest: 'measured',
    }
  }
}

/**
 * 注册后台「提醒」资源（列表 / 删除 / 人工收敛）。
 *
 * **round9（P2）**：演练（dryRun）**不锁**显式管理操作——后台删除会**真的删**。
 * 这是有意为之（人主动要求的动作），但必须留痕：日志一行 + 返回值里带提示。
 */
export function registerRemindersResource(
  host: SubHost,
  store: ReminderStore,
  runtime?: () => RunnerStatus | null,
): void {
  host.registerResource('reminders', {
    label: '提醒',
    list: resourceListOf(store, runtime),
    remove: async (id) => {
      const dryRun = host.config.reminders.dryRun !== false
      if (dryRun) {
        host.log(`reminders: **演练中执行了真实删除**（${id}）——dryRun 不拦显式管理操作，这条提醒真的没了`)
      }
      const removed = await store.remove(id)
      return dryRun
        ? { removed, note: '演练中：这次删除是**真的**（dryRun 不拦后台显式删除）' }
        : { removed }
    },
    // 3A-2 的人工收敛入口：unknown 的那条由主人收成"确实发了"或"确实没发"。
    actions: {
      resolve: async (body) => {
        const id = typeof body?.id === 'string' ? body.id : ''
        const outcome = body?.outcome === 'confirmed' ? 'confirmed' : 'failed'
        return { resolved: id === '' ? false : await store.resolve(id, outcome) }
      },
    },
  })
}
import { ReminderRunner } from './runner.js'
import type { RunnerStatus } from './runner-status.js'
import { agendaPortOf, liveSeams, nextOccurrenceOf } from './agenda-seam.js'
import { configureReminderSeams, deliverReminder, redispatchOf, reminderDeliverable } from './index.js'
/**
 * **装配接缝 / 轮询器 / 日志**（从 `index.ts` 的 `apply()` 纯搬移而来）。
 *
 * 为什么搬出来：`index.ts` 已到 400 行硬上限，而这段是"入口装配"，与投递判定无关。
 * 注意：与 `index.ts` 是**函数级**循环依赖（两边都在调用时才取绑定），不会在模块初始化期用到。
 */
export function setupReminderRuntime(input: {
  host: SubHost
  store: ReminderStore
  api: unknown
  out: unknown
}): ReminderRunner {
  const { host, store, api, out } = input
  // 3A-4 接缝注入（裁决补 4 第 5 条）+ **终审 round4 C4**：接缝**惰性**解析 agenda，
  // 而不是把启动那一刻的结果固定在闭包里——foundation 常常比我们晚发布，固定住就永远接不上。
  const agenda = agendaPortOf()
  configureReminderSeams(liveSeams(host.log))
  host.log(agenda === null
    ? 'reminders: 启动时没有 agenda 服务 → 先按未接缝跑；每次用到时会重新探测（foundation 起来后自动接上）'
    : 'reminders: agenda 接缝已接上（发送前 CAS + 发出后 occurrence-dispatched；每次用到时重新探测）')
  const runner = new ReminderRunner(
    store,
    async (reminder) => await deliverReminder(host, reminder),
    host.log,
    (reminder) => reminderDeliverable(host.config, reminder),
    async (reminder) => (reminder.repeat === 'none' ? null : await nextOccurrenceOf(reminder)),
    async (reminder) => await redispatchOf(reminder),
    // round5 D4：演练模式下**一行持久状态都不写**（淘汰/收编全部跳过）。
    () => host.config.reminders.dryRun !== false,
  )
  // P1-02：关着就**不启动**。工具面照旧注册（它们自己会回"已关闭"），
  // 但后台一个定时器都不挂——"工具关了、后台还在投"正是这条审计问题。
  if (host.config.reminders.enabled === true) {
    runner.start()
  } else {
    host.log('reminders: enabled=false，轮询器不启动（已存在的提醒不会被投递）')
  }
  // 3A-3：dryRun 是**灰度开关**，启动时喊一声，免得"以为在发其实没发"。
  if (host.config.reminders.dryRun !== false) {
    host.log('reminders: dryRun=true（灰度）——提醒不会真的发出去，诊断里显示 dryRun')
  }
  return runner
}
