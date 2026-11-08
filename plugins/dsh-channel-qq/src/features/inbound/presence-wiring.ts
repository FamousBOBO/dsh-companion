/** 群聊旁听与自主接话的**装配**：配置 → 旁听环 + 判断执行器。
 *
 * 为什么单独一个文件：这段装配要同时拿到宿主上下文（模型接缝）、当前平台、sent-log 与
 * 配置，写进 `inbound/index.ts` 会把那个文件顶到单文件上限之外（`check:size`），
 * 也会让"关掉这个能力时不造任何对象"这条判据淹没在别的装配里。
 *
 * **关着时一个对象都不造**（只留一行日志说明新代码确实加载了、但这套能力关着）——
 * 于是关掉开关就等于回到旧行为；这是本项目的通用做法，也是这次的应急回滚手段。
 *
 * 文件内的分层（`wirePresence` 只做编排，每段依赖各有自己的构造函数）：
 *   - {@link personaDeps}：群聊可见的人格快照（P0 §4.2）；
 *   - {@link memoryRecall}：群记忆召回（P1 §5.4）；
 *   - {@link publishEvents}：把时间线视图发给兄弟插件行（P3 §7.2）。
 */

import { AmbientStore } from '../../app/inbound/ambient-store.js'
import { GroupPresence } from '../../app/inbound/presence-runtime.js'
import { createHostComplete } from '../../adapters/dsh-host/completion.js'
import { dataRootOfDshHome, readGroupPersona, type GroupPersonaDeps } from '../../adapters/dsh-host/group-persona.js'
import { openGroupMemory, recallGroupMemory, rememberGroupFacts } from '../../adapters/dsh-host/group-memory.js'
import { publishServiceToPeers } from '../../adapters/dsh-host/service-registry.js'
import { afterSpeakHandler } from './presence-afterspeak.js'
import { socialResource } from './presence-resource.js'
import { DEFAULTS, positiveOr } from '../../app/inbound/presence-flow.js'
import { systemClock } from '../../ports/clock.js'
import { JsonlLogStream } from '../../adapters/fs-store/log-stream.js'
import { modeNoteOf, modeRuns, resolveMode, type GroupPresenceMode } from '../../core/presence-mode.js'
import * as path from 'node:path'
import type { LogStream } from '../../ports/store.js'
import type { PresenceObserver } from '../../app/inbound/group-ambient.js'
import type { GroupMemoryRecall } from '../../app/inbound/group-memory-contract.js'
import type { CandidateFact } from '../../core/group-memory-extract.js'
import type { SentLogHub } from '../../sent-log.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { SubHost } from '../plugin-kit.js'

/** 装配结果：环永远有（便宜、纯内存），执行器只在打开时才有。 */
export interface PresenceWiring {
  readonly ambient: AmbientStore
  readonly presence?: PresenceObserver
  readonly dispose: () => void
}

/**
 * 人格快照的取用（**每轮现取**：快照自带版本号，人格文件改了要在下一轮生效）。
 *
 * 这条路径没有系统提示词、没有会话，所以人格只能从这条缝进提示词；适配层拿不到就
 * 返回 `null`，提示词里明说"这次拿不到完整人格"，而不是让它自由发挥。
 * 日志只在**来源变了**时打一行——每轮都打会把群里其它日志淹掉。
 */
function personaReader(host: SubHost): () => ReturnType<typeof readGroupPersona>['snapshot'] {
  const deps: GroupPersonaDeps = {
    context: () => host.bridge.tagContext(),
    // 桥是可选通道（新布局下 home 的父目录才是套件根，能不能解析到取决于部署形态）。
    bridge: () => null,
    dataRoot: () => dataRootOfDshHome(host.dshHome),
    log: host.log,
  }
  let last = ''
  return () => {
    const read = readGroupPersona(deps)
    const note = read.snapshot === null ? `none(${read.reason})` : `${read.via} v${read.snapshot.version}`
    if (note !== last) {
      last = note
      host.log(`presence: 人格快照 ${note}`)
    }
    return read.snapshot
  }
}

/**
 * 群记忆召回（P1 §5.4）。
 *
 * 打不开库不是错误：`recallGroupMemory` 返回空结果，群聊照常跑（§5.5 的要求）。
 * 日志同样只在**可用性变了**时打一行。
 */
function memoryRecall(host: SubHost): (input: {
  groupId: number
  memberIds: readonly number[]
  topic: string
}) => GroupMemoryRecall {
  let last = ''
  return ({ groupId, memberIds, topic }) => {
    const dataRoot = dataRootOfDshHome(host.dshHome)
    const recall = recallGroupMemory({
      dataRoot,
      groupId,
      memberIds,
      topic,
      budgetChars: positiveOr(
        host.config.presence?.memoryBudgetChars ?? DEFAULTS.memoryBudgetChars,
        DEFAULTS.memoryBudgetChars,
      ),
    })
    const handle = openGroupMemory(dataRoot)
    const note = `${handle.reason}/${String(recall.group.length)}g${String(recall.member.length)}m`
    if (note !== last) {
      last = note
      const where = handle.file === '' ? '未配置路径' : handle.file
      host.log(`presence: 群记忆 ${note}${handle.reason === 'ok' ? '' : `（${where}）`}`)
    }
    return recall
  }
}

/**
 * 把时间线视图发布给**兄弟插件行**（`companion-group` 的提示词段要读它）。
 *
 * 三条口径：发布失败不影响任何东西（那一侧会渲染成"还没有记录"）；只在**唯一活跃群**时
 * 给数据（见 `GroupPresence.eventsView`）；卸载时释放，避免热重载后旧对象继续被读到。
 *
 * 只走进程注册表，不调 `host.provide`：后者的键受 `ServiceBag` 的编译期检查约束，而
 * `companionGroupEvents` 是给**另一个插件行**读的名字，不在那个袋子里。
 */
function publishEvents(host: SubHost, presence: GroupPresence): () => void {
  return publishServiceToPeers({
    name: 'companionGroupEvents',
    service: presence.eventsView(),
    root: dataRootOfDshHome(host.dshHome) ?? '',
    ready: () => true,
    log: host.log,
  })
}

/**
 * 影子日志：`shadow` 模式下"本来想发什么、为什么"的落盘记录（JSONL，一行一条）。
 *
 * 为什么必须落盘而不只是打日志：影子模式的**全部意义**是拿真实模型在真实群聊上下文里
 * 的输出去做人工盲评。控制台日志会被下一次启动刷掉，也不方便逐条标注。
 *
 * 三条约束：
 *   1. **只追加、封顶**（`LogStream` 自带 trim），不整份重写；
 *   2. **不带 message_id**：它没发出去，带上就会被下游当成"说过话"；
 *   3. **写失败只记一行日志**：影子日志是诊断资产，不能影响判断路径。
 */
function shadowLogger(host: SubHost): (decision: {
  groupId: number
  action: 'reply' | 'join' | 'react'
  text: string
  targetMessageId?: number
  blockedBy: string
  atMs: number
}) => void {
  let stream: LogStream<Record<string, unknown>> | null = null
  let failed = false
  return (decision) => {
    if (failed) return
    try {
      stream ??= new JsonlLogStream<Record<string, unknown>>(
        path.join(host.dshHome, '..', 'logs', 'presence-shadow.jsonl'),
        { log: host.log },
      )
      void stream.append({
        at: new Date(decision.atMs).toISOString(),
        group: decision.groupId,
        mode: decision.blockedBy,
        action: decision.action,
        ...(decision.targetMessageId === undefined ? {} : { target: decision.targetMessageId }),
        text: decision.text,
        chars: [...decision.text].length,
      }).catch((error: unknown) => {
        host.log(`presence: 影子日志追加失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) {
      // 第一次就失败（比如目录不可写）：关掉这条路径，不要在每轮判断里重试。
      failed = true
      host.log(`presence: 影子日志不可用（已停用）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 注册后台「群社交」诊断页（P8 §5.4）。
 *
 * 为什么关着（off）时**也注册**：运维最先要看的就是「现在到底是不是关的、为什么没发」。
 * 不注册的话那一页会整个消失，而「页面没了」和「能力关着」在事故现场是两件完全不同的事。
 */
function registerSocialResource(host: SubHost, presence: GroupPresence): void {
  try {
    host.registerResource('group-social', socialResource({
      mode: () => resolveMode(host.config.presence ?? null),
      presence: () => presence,
      guardMode: guardModeOf(host),
      stickers: () => host.config.presence?.stickers === true,
      now: () => systemClock.now(),
    }))
  } catch (error) {
    // 诊断页注册失败不该影响接话本身。
    host.log(`presence: 后台诊断页注册失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * sent-log 写入（每群一份，按群号分文件）。
 *
 * 为什么失败只记日志：这条日志是"她说过什么"的持久化副本，写坏了不该让一次成功的发言
 * 变成失败（时间线里还有一份，重启之后按时间线为准）。
 */
function sentLogWriter(host: SubHost, hub: SentLogHub): (groupId: number, messageId: number | null, text: string) => Promise<void> {
  return async (groupId, messageId, text) => {
    try {
      const log = await hub.for(`group-${groupId}`)
      await log.add({ messageId, quotedId: null, text, time: systemClock.now() })
    } catch (error) {
      host.log(`presence: sent-log 写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 语义复核档位（P6-B）：每次现取；配错/取不到按 `warn`（只记不拦）。
 *
 * 为什么配错要退回 warn 而不是 enforce：一个手滑的字符串不该让整条链路突然沉默。
 */
function guardModeOf(host: SubHost): () => string {
  return () => {
    const raw = (host.config.presence ?? null)?.socialGuard
    return typeof raw === 'string' && raw !== '' ? raw : 'warn'
  }
}

/**
 * 记忆写入（P1 §5.3）：逐条落库，失败只记一行。
 *
 * 为什么打日志要"只在真写了东西时"：顺利时每轮都会有一条候选，逐轮打会把群里
 * 其它日志淹掉；而"一条都没写"是常态（大多数话不是事实），不值得记。
 */
function memoryWriter(host: SubHost): (input: {
  groupId: number
  facts: readonly CandidateFact[]
  nowMs: number
}) => void {
  return (input) => {
    try {
      const { written, merged, rejected } = rememberGroupFacts({ dataRoot: dataRootOfDshHome(host.dshHome), ...input })
      if (written + merged > 0) {
        host.log(`presence: 群 ${String(input.groupId)} 记住 ${String(written)} 条（合并 ${String(merged)}，拒 ${String(rejected)}）`)
      }
    } catch (error) {
      host.log(`presence: 群记忆写入失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 造旁听环与执行器。
 *
 * `platform` 传的是**取值函数**：通道热重载后要跟随新的 OneBot 客户端，不能把
 * `platform.api` 在装配时闭包住（2026-11-01 私聊发送器事故的同类坑）。
 */
export function wirePresence(
  host: SubHost,
  sentLogHub: SentLogHub,
  fallbackPlatform: ChatPlatform,
): PresenceWiring {
  const ambient = new AmbientStore({ log: host.log })
  // 模式解析（P5-B）：`mode` 优先，缺席时退回 `enabled` 的旧口径。
  const modeNow = (): GroupPresenceMode => resolveMode(host.config.presence ?? null)
  const mode = modeNow()
  const modeNote = modeNoteOf(host.config.presence ?? null)
  if (modeNote !== '') host.log(`presence: ${modeNote}`)
  if (!modeRuns(mode)) {
    // `off`: 连旁听都不记（旧 `enabled:false` 的行为逐字节一致）。
    host.log(`presence: 关（mode=${mode}）——不记旁听、不调模型判断、不发自主消息`)
    return { ambient, dispose: () => {} }
  }
  // 说完之后的附加动作（表情包 / 弱反馈 / 话题落地）。装配一次，内部自带每群额度账本。
  const afterSpeak = afterSpeakHandler(host, () => host.config.presence ?? null)
  // 影子日志（`shadow` 模式的全部意义）：一行 JSON 落本地文件，供人工盲评。
  // 只记"本来想发什么 + 为什么"，**不带 message_id**——它没发出去。
  const shadowLog = shadowLogger(host)
  const presence = new GroupPresence({
    config: () => host.config,
    clock: systemClock,
    log: host.log,
    platform: () => host.get('platform')?.platform ?? fallbackPlatform,
    persona: personaReader(host),
    memory: memoryRecall(host),
    afterSpeak,
    // 每次现取：后台把 live 改成 shadow 时，在途的模型结果也必须被拦下。
    mode: modeNow,
    // 语义复核档位（P6-B）：配错/取不到按 warn（只记不拦）。
    guardMode: guardModeOf(host),
    recordShadow: shadowLog,
    remember: memoryWriter(host),
    ambient,
    complete: createHostComplete({
      context: () => host.bridge.tagContext(),
      clock: systemClock,
      log: host.log,
    }),
    recordSent: sentLogWriter(host, sentLogHub),
  })
  const releaseEvents = publishEvents(host, presence)
  // 后台「群社交」页（P8 §5.4）：只读诊断。它读的就是发送闸门真正在读的那个 mode 函数，
  // 所以页面上显示的模式与「到底会不会发」永远是同一个值。
  registerSocialResource(host, presence)
  host.log(`presence: 已启用（白名单群 ${JSON.stringify(host.config.presence.groups)}；`
    + '未 @ 时也会自己搭话：能接就接、没话可说就沉默，受最小间隔与每小时额度约束）')
  return {
    ambient,
    presence,
    dispose: () => {
      try { releaseEvents() } catch { /* 释放必须幂等且不抛 */ }
      presence.dispose()
    },
  }
}
