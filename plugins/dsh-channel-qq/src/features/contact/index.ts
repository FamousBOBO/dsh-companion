/** 主动消息子插件（A1/A3）：把账本、发送器、节拍器与服务面**装**进一个 fiber。
 *
 * 为什么是子插件而不是又一段 `plugin.ts` 的分支：它有自己的生命周期（定时器、跨进程
 * 租约、账本文件），这些东西必须能在卸载时被一次收干净——卸载顺序就是"停表 → 等在途
 * 发送 → 释放租约"（见 `ContactWorker.dispose`）。
 *
 * 本文件只做三件事：**从宿主取事实**（平台连没连、房间有没有回合在跑）、**把四件东西
 * 互相接上**（store / sender / worker / service）、**注册诊断资源**。判定在 `gate.ts`、
 * 起草在 `model.ts`、发送在 `sender.ts`（合同类型在 `sender-contract.ts`）、节拍在
 * `worker.ts`、账本在 `store.ts`+`ledger.ts`、服务合同在 `service.ts`、**取数与回调
 * 工厂在 `wiring-facts.ts`**。
 *
 * 默认什么都不做：`enabled=false`、`dryRun=true`、`allowExternalSend=false`（配置默认值）。
 * 装上去之后账本可以记账、诊断可以看，但一条消息都不会真的发出去，也不会调用模型。
 */

import { createAdaptiveDecisionPort } from './adaptive-host.js'
import { registerAdaptiveTools } from './adaptive-tools.js'
import type { ContactConfig } from '../../config/sections/contact.js'
import { systemClock, systemRandom, type Clock } from '../../ports/clock.js'
import { createHostDraftPort } from './draft-host.js'
import { createHostDrafts } from './draft-wiring.js'
import { authorizedSleepText } from './sleep-summary.js'
import { ContactSender } from './sender.js'
import { createContactService } from './service.js'
import type { ContactService } from './types.js'
import { buildStore, identityOf } from './assembly.js'
import { PARALLEL_WARNING, parallelProactiveRisk } from './parallel-warning.js'
import { sharePortFor } from './share-port.js'
import { ContactStore } from './store.js'
import { ContactWorker, type ContactRoomFacts } from './worker.js'
import { storeOptions, type SubHost, type SubPlugin } from '../plugin-kit.js'
import {
  executionSnapshotOf,
  roomFactsOf,
  runtimeOf,
  sleepEnqueueAllowedOf,
  sourceCandidatesOf,
  transportOf,
} from './wiring-facts.js'

// 日键与"空闲跟进"候选来源搬到了 `followup.ts`（业务规则，不是装配）；这里再导出一次，既有 import 点不必改。
export { dayKeyFor, proposeIdleFollowUp } from './followup.js'

/** host → worker（apply 造、start 启、dispose 收，三处要拿到同一个对象）。 */
const workers = new WeakMap<SubHost, ContactWorker>()
/** host → store（卸载时还要用一次：释放租约、启动告警写诊断）。 */
const stores = new WeakMap<SubHost, ContactStore>()

function buildSender(
  host: SubHost,
  store: ContactStore,
  roomFacts: (room: string) => ContactRoomFacts,
  clock: Clock,
  log: (line: string) => void,
): ContactSender {
  return new ContactSender({
    sleepText: (candidate, now) => authorizedSleepText(host, candidate, now),
    log,
    clock,
    transport: transportOf(host),
    turns: () => host.get('inbound')?.turns,
    identity: () => identityOf(host),
    // 决策与执行之间的窗口：候选与房间事实在这里**重读一遍**（见 sender.ts 的注记）。
    // 候选已不在账本里时返回 undefined，sender 会判 cancelled（宁可不发）。
    refresh: (candidateId, room) => ({
      candidate: store.candidate(candidateId),
      runtime: runtimeOf(store, roomFacts, room),
    }),
    // 暂停/卸载/失去租约：`refresh` 看不出来的两件事，只能由装配方注入这个谓词。
    isFrozen: () => (workers.get(host)?.isFrozen ?? false) || store.lease === null,
    // 投递记录上挂着领取时的代次；对不上就是"这条已经不属于我了"（内存快判，便宜）。
    leaseEpoch: () => store.lease?.epoch ?? null,
    /**
     * F41：执行点的**一次读盘 + 最后断言租约**（见 `executionSnapshotOf` 的注记）。
     * 注意这里**没有** `verifyOwnership`/`liveFacts`：所有权与事实出自同一次快照，
     * 否则就是"断言之后又读了一次盘"——那正是 Codex 复现出来的窗口。
     */
    liveSnapshot: executionSnapshotOf(store, roomFacts, log),
    /** F3：门控重跑用**当前**配置（后台改完立刻生效，不用等下一次 tick）。 */
    config: () => host.config.contact,
    /** P1/R5：执行点的**异步版本复核**（人设摘要 / 历史尾游标），只读廉价资料。 */
    verifyDraft: createHostDrafts(host, store, roomFacts, clock, log).verify,
    /** P1/R5：`direct` 的草稿**必须**带冻结版本；缺失 = 无法比较 = 不发。 */
    requireDraftRevision: () => host.config.contact.sendMode === 'direct',
    // P1：最后那道**同步**闸要能看见租约还在不在、这条投递行还是不是我的（都是内存快照）。
    lease: () => store.lease,
    deliveryRow: (id: string) => store.state.outbox[id],
    // 一次发送等这么久还没回执就记 unknown：宁可承认不知道，也不重发。
    timeoutMs: 30_000,
  })
}

function buildWorker(
  host: SubHost,
  store: ContactStore,
  sender: ContactSender,
  roomFacts: (room: string) => ContactRoomFacts,
  clock: Clock,
  log: (line: string) => void,
  sourceCandidates?: () => Promise<void>,
): ContactWorker {
  return new ContactWorker({
    sleepText: (candidate, now) => authorizedSleepText(host, candidate, now),
    store,
    sender,
    clock,
    log,
    config: (): ContactConfig => host.config.contact,
    identity: () => identityOf(host),
    roomFacts,
    ...(sourceCandidates === undefined ? {} : { sourceCandidates }),
    // 本轮**没有**内置自动候选来源（第三轮审阅后取消了"按配置布尔接管提醒"）：
    // 候选只能由外部经服务袋 `contact.propose()` 提出（诊断/后台/其它子插件）。
    // 因此这里不传 `scanSources`；worker 的该依赖是可选的，缺省即"不扫"。
    // 草稿端口（`DraftPort`）：走宿主模型接缝的**单次短补全**，实现在 `draft-host.ts`。
    // 装上不等于用上——`draftModel` 默认 false，`draftWithBudget` 的第一道就是开关与预算，
    // 于是开箱状态下一次都不会调用；`turn` 模式也根本不走这条路（文案来自人格包）。
    adaptivePort: createAdaptiveDecisionPort({ context: () => host.bridge.tagContext(), clock, timeoutMs: () => host.config.contact.draftTimeoutMs }),
    draftPort: createHostDraftPort({
      // 与表情打标同一个入口：宿主上下文只在 `bridge` 里出现，features 不 import 宿主包。
      context: () => host.bridge.tagContext(),
      log,
      timeoutMs: () => host.config.contact.draftTimeoutMs,
      clock,
      // P2.5-3D：`direct` 模式**必须**带上下文——没带上就当场 `not-called`，
      // 绝不静默退回"没有上下文的泛化问候"（那正是 2026-10 那次事故）。
      requireContext: () => host.config.contact.sendMode === 'direct',
    }),
    // 起草上下文的取数面（P2.5-3D）：惰性服务袋 + 宿主预设 + 账本里的投递/未回复计数。
    // 装配只负责"往哪里取"，六个分区怎么读、怎么裁、缺了怎么记都在 `draft-context.ts`。
    draftContext: createHostDrafts(host, store, roomFacts, clock, log).source,
    // 点歌的"自主选歌"挂在这一拍的收尾：它经服务袋拿 `song`（不 import 那个目录），
    // 且自带免打扰/额度/授权三道闸（见 `features/song/auto.ts`）。这里只负责"到点了叫它一次"。
    afterTick: async () => { await host.get('song')?.autoPickOnce() },
  })
}

/** 诊断资源：只输出账本与稳定 reason 串（不含凭据、不含完整 URL）。 */
function registerResource(host: SubHost, worker: ContactWorker, service: { status(): unknown; cancel(id: string, reason: string): Promise<boolean> }): void {
  host.registerResource('contact', {
    label: '主动消息',
    list: () => service.status(),
    remove: async (id: string) => ({ removed: await service.cancel(id, 'admin') }),
    actions: {
      pause: () => { worker.pause(); return { paused: true } },
      resume: () => { worker.resume(); return { paused: false } },
      tick: async () => {
        await worker.tick(systemClock.now())
        return { ok: true, at: systemClock.now() }
      },
    },
  })
}

/**
 * 两条主动外发路径同时开着时要说的一句话（**只警告，不干预**）。
 *
 * 事件书（`proactive.v2` 的 prompt 事件）与联系候选都可能往同一个房间开口：一个说
 * "到点了该早报"，一个说"我想起一件事"。本插件**不**读对方状态、也不替操作者做决定
 * （那会把两个子系统耦成一对），只把风险写进日志与诊断；真要一起开，是操作者的事。
 */

/** 子插件本体：装配 + 生命周期（候选来源与日键在 `followup.ts`，那是业务规则不是装配）。 */
export const contactPlugin: SubPlugin = {
  name: 'contact',
  // 开关/模式/间隔改了要重挂（定时器与租约都跟着变）；阈值类的改动每次门控现取。
  watches: ['contact'],
  requires: ['platform', 'inbound', 'persona'],
  apply(host) {
    const clock: Clock = systemClock
    const log = (line: string): void => { host.log(line) }
    const roomFacts = roomFactsOf(host)
    const store = buildStore(host, clock, log)
    const sender = buildSender(host, store, roomFacts, clock, log)
    const serviceRef: { current: ContactService | null } = { current: null }
    const worker = buildWorker(host, store, sender, roomFacts, clock, log,
      sourceCandidatesOf(host, store, serviceRef, clock))
    const service = createContactService({
      sleepEnqueueAllowed: sleepEnqueueAllowedOf(host, store, roomFacts, clock),
      store,
      worker,
      clock,
      log,
      config: () => host.config.contact,
      random: () => systemRandom.next(),
      connected: () => host.get('platform')?.platform.isConnected() ?? false,
    })
    serviceRef.current = service
    workers.set(host, worker)
    stores.set(host, store)
    // P2.5-3B 前置：分享候选的唯一入口（既有 propose + worker 闸门；开关读 runtime 的
    // `p2.share.enabled`，生产 false ⇒ 一律 share-disabled、零外发）。工厂在 share-port.ts，
    // 免得这个文件继续长（它已经贴着 400 行的硬上限）。
    const sharePort = sharePortFor({
      dshHome: storeOptions(host).dshHome,
      owner: host.config.admins[0],
      personaId: identityOf(host).personaId,
      propose: async (input) => await service.propose(input),
      tick: async () => { await worker.tick(clock.now()) },
      // 只读闸门判定：被拒时把真实原因（quiet-hours / quota / cooldown…）透传给 runtime。
      budget: async (room) => await service.outboundBudget({ room, sender: 'share' }),
      now: () => clock.now(),
      // 分享候选有效期来自配置（默认 6 小时，理由写在该字段的 help 里）。
      ttlMs: () => host.config.contact.shareTtlMs,
      log,
    })
    return (async () => {
      await store.load({ sweep: false })
      host.provide('contact', service)
      host.provide('contactShare', sharePort)
      registerResource(host, worker, service)
      const removeFollowups = registerAdaptiveTools(host, store, service)
      return async () => {
        removeFollowups()
        workers.delete(host)
        stores.delete(host)
        await worker.dispose()
        await store.releaseLease().catch(() => {})
      }
    })()
  },
  start(host) {
    const worker = workers.get(host)
    if (worker === undefined) return
    const store = stores.get(host)
    const now = systemClock.now()
    // direct 模式必须配 `draftModel`：它没有模板文案路径，草稿是唯一来源。
    // 配了一半的组合（选了 direct 却没允许起草）不会报错，但**永远不会发**，
    // 所以启动时必须说一句——比让操作者对着 `draft:unavailable` 猜要好。
    if (host.config.contact.sendMode === 'direct' && !host.config.contact.draftModel) {
      host.log('contact: sendMode=direct 但 draftModel=false —— direct 模式只会产出 draft:unavailable，一条也发不出去')
    }
    if (parallelProactiveRisk(host)) {
      host.log(PARALLEL_WARNING)
      // 诊断面同样要看得到（不只活在日志里）；没有租约也要能写，所以走不带 epoch 的写。
      if (store !== undefined) void store.noteReason(PARALLEL_WARNING, now).catch(() => {})
    }
    worker.start()
    void worker.prune() // 顺手清一次很旧的终态投递（30 天）；失败不影响节拍。
  },
}
