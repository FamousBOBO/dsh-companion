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
 *   - `personaReader` / `memoryRecall` / `memoryWriter`：判断层的输入源（`presence-wiring-parts.ts`）；
 *   - `judgeWiring`：本地 Jev 那一路（`presence-wiring-judge.ts`）；
 *   - `publishEvents`：把时间线视图发给兄弟插件行（P3 §7.2，本文件）。
 */

import { AmbientStore, presenceRuns } from '../../app/inbound/ambient-store.js'
import { GroupPresence } from '../../app/inbound/presence-runtime.js'
import { createHostComplete } from '../../adapters/dsh-host/completion.js'
import { dataRootOfDshHome } from '../../adapters/dsh-host/group-persona.js'
import { createParticipantRegistry } from '../../adapters/fs-store/participant-registry.js'
import type { RegistryFile } from '../../core/participant.js'
import { publishServiceToPeers } from '../../adapters/dsh-host/service-registry.js'
import { afterSpeakHandler } from './presence-afterspeak.js'
import { judgeWiring, type JudgeWiring } from './presence-wiring-judge.js'
import { publishJudgeToPeers } from './presence-wiring-judge-publish.js'
import { memoryRecall, memoryWriter, personaReader } from './presence-wiring-parts.js'
import { socialResource } from './presence-resource.js'
import { systemClock } from '../../ports/clock.js'
import { JsonlLogStream } from '../../adapters/fs-store/log-stream.js'
import { modeNoteOf, modeRuns, resolveMode, type GroupPresenceMode } from '../../core/presence-mode.js'
import * as path from 'node:path'
import type { LogStream } from '../../ports/store.js'
import type { PresenceObserver } from '../../app/inbound/group-ambient.js'
import type { SentLogHub } from '../../sent-log.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { SubHost } from '../plugin-kit.js'

/** 装配结果：环永远有（便宜、纯内存），执行器只在打开时才有。 */
export interface PresenceWiring {
  readonly ambient: AmbientStore
  readonly presence?: PresenceObserver
  /**
   * 参与者注册表的同步读法（P9-G4 §2.2）；没开注册表时缺省。
   *
   * 给**采集路径**用：那条路径在每条群消息上跑，等不了异步读盘。`fileSync()` 返回的是
   * 上一次 load 的快照（装配时预热过一次，之后按 mtime 自己重读）。
   */
  readonly participants?: () => RegistryFile | null
  readonly dispose: () => void
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
/**
 * 这套能力现在到底跑不跑（P9-A2）：与收消息路径**同一个判据**（`presenceRuns`）。
 *
 * 为什么要在装配侧单独写一个：后台要显示的是"实际运行状态"，而配置里那个字符串只是
 * 输入之一（还要考虑 mode 缺席时退回 enabled、配置写错时的回退）。用同一个函数算，
 * 页面就不会和真实行为分叉。
 */
function presenceAppliesToAny(host: SubHost): boolean {
  return presenceRuns(host.config.presence ?? null)
}

/**
 * 解析运行模式并把它记进启动日志；返回"每次现取"的那个函数。
 *
 * 为什么单独一个函数：这段要在 `wirePresence` 开头把两件事说清楚——**现在是什么模式**、
 * 以及 `off` 时为什么仍然建执行器。它是"为什么关着还造对象"这条设计的唯一落点，
 * 混在装配流程里会被下一段代码淹没，而它恰恰是最容易被后来者"优化掉"的一段。
 */
function logModeOnce(host: SubHost): () => GroupPresenceMode {
  const observeOnly = host.config.connection.mode === 'mirror-observe'
  const modeNow = (): GroupPresenceMode => observeOnly
    ? (host.config.presence.mode === 'shadow' ? 'shadow' : 'off')
    : resolveMode(host.config.presence ?? null)
  const mode = modeNow()
  const modeNote = modeNoteOf(host.config.presence ?? null)
  if (modeNote !== '') host.log(`presence: ${modeNote}`)
  // P9-A2：**`off` 也照样建执行器**（几个 Map，不起定时器、不读盘）。原来的"off 直接
  // return"会让 off→shadow 必须重启才生效，与 P5-B 承诺的热切换矛盾。现在跑不跑由
  // `presenceAppliesTo` 每次现取模式决定：off 一条都不记，改回 off 下一条消息就停。
  if (!modeRuns(mode)) host.log(`presence: mode=${mode}——不记旁听、不判断、不发（改配置即可开始，不必重启）`)
  return modeNow
}

/**
 * 参与者注册表的取用面（P9-G4 §2.2）；关着时返回 `null`。
 *
 * 三条：
 *   1. `enabled` 为假 → **不造对象**（"关掉就回到旧行为"与旁听那条同一口径）；
 *   2. `allowUnknownAsBot` **永远不参与判断**：它只是给运维看的一句声明（"我们不会
 *      把未知当 bot"），代码里没有任何分支读它——真有分支就等于给了它一条生效路径；
 *   3. 读盘失败不抛：`fileSync()` 拿不到就给 `null`，判断层按"全员未确认"走。
 */
function participantRegistryOf(host: SubHost): ReturnType<typeof createParticipantRegistry> | null {
  const config = host.config.participants
  if (config === undefined || config.enabled !== true) return null
  try {
    const registry = createParticipantRegistry({
      file: config.file,
      dshHome: () => host.dshHome,
      log: host.log,
    })
    // 预热一次：让第一条群消息不必等一次读盘，也让"注册表坏了"在启动日志里就出现。
    void registry.load().then((loaded) => {
      if (loaded.kind === 'loaded') {
        const groups = loaded.file.groups.length
        const members = loaded.file.groups.reduce((sum, group) => sum + group.members.length, 0)
        host.log(`participants: 注册表已加载（${String(groups)} 个群 / ${String(members)} 名成员）`)
        if (loaded.problems.length > 0) host.log(`participants: 丢弃 ${String(loaded.problems.length)} 条不可用记录`)
      } else if (loaded.kind === 'invalid') {
        host.log(`participants: 注册表不可用（${loaded.problems.join('；')}）——所有人按"身份未确认"处理`)
      }
    }).catch(() => { /* load() 自己已经收敛了错误，这里只是兜底 */ })
    return registry
  } catch (error) {
    host.log(`participants: 注册表装配失败（已忽略，全员按身份未确认）：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function registerSocialResource(host: SubHost, presence: GroupPresence): void {
  try {
    host.registerResource('group-social', socialResource({
      mode: () => resolveMode(host.config.presence ?? null),
      presence: () => presence,
      guardMode: guardModeOf(host),
      stickers: () => host.config.presence?.stickers === true,
      // 实际会不会跑：与收消息那条路径共用同一个判据（P9-A2），不是配置字符串。
      runs: () => presenceAppliesToAny(host),
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
 * 执行器的依赖（**纯装配**：每个字段都是"怎么取"而不是"取到什么"）。
 *
 * 为什么抽成一个函数：`wirePresence` 本身只该做三件事——造零件、接线、留拆卸钩子。
 * 把这二十个字段摊在它里面会让那个函数超出行数上限，而"哪个依赖是可选的、
 * 缺省时行为是什么"这条信息也会淹没在字段列表里。
 */
function presenceDepsOf(
  host: SubHost,
  parts: {
    ambient: AmbientStore
    afterSpeak: ReturnType<typeof afterSpeakHandler>
    modeNow: () => string
    shadowLog: ReturnType<typeof shadowLogger>
    registry: ReturnType<typeof participantRegistryOf>
    judge: JudgeWiring
    fallbackPlatform: ChatPlatform
    sentLogHub: SentLogHub
  },
): ConstructorParameters<typeof GroupPresence>[0] {
  return {
    config: () => host.config,
    clock: systemClock,
    log: host.log,
    platform: () => host.get('platform')?.platform ?? parts.fallbackPlatform,
    persona: personaReader(host),
    memory: memoryRecall(host),
    afterSpeak: parts.afterSpeak,
    // 每次现取：后台把 live 改成 shadow 时，在途的模型结果也必须被拦下。
    // 同一个函数也决定"要不要跑"（off → 不记旁听），所以热切换不需要重建执行器。
    mode: parts.modeNow,
    // 语义复核档位（P6-B）：配错/取不到按 warn（只记不拦）。
    guardMode: guardModeOf(host),
    // 参与者身份（P9-G4 §2.2）：每次现取；没开注册表就是 null（全员"身份未确认"）。
    ...(parts.registry === null ? {} : { registry: () => parts.registry?.fileSync() ?? null }),
    recordShadow: parts.shadowLog,
    remember: memoryWriter(host),
    ambient: parts.ambient,
    complete: createHostComplete({
      context: () => host.bridge.tagContext(),
      clock: systemClock,
      log: host.log,
    }),
    recordSent: sentLogWriter(host, parts.sentLogHub),
    // 本地判断那一路（可选；缺省 = 只走宿主模型）。
    ...(parts.judge.port === undefined ? {} : { judge: parts.judge.port }),
    judgeBackend: parts.judge.backend,
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
  const modeNow = logModeOnce(host)
  // 说完之后的附加动作（表情包 / 弱反馈 / 话题落地）。装配一次，内部自带每群额度账本。
  const afterSpeak = afterSpeakHandler(host, () => host.config.presence ?? null)
  // 影子日志（`shadow` 模式的全部意义）：一行 JSON 落本地文件，供人工盲评。
  // 只记"本来想发什么 + 为什么"，**不带 message_id**——它没发出去。
  const shadowLog = shadowLogger(host)
  // 参与者注册表（P9-G4 §2.2）：装配一次，之后按 mtime 自己判断要不要重读。
  // 关着（`participants.enabled=false`）时**不造这个对象**——与"关掉就回到旧行为"同一条口径。
  const registry = participantRegistryOf(host)
  // 判断后端（`judge.*`）：本地 Jev 那一路关着时这里返回的对象**不带端口**，
  // 于是执行器只走宿主模型——与今日行为逐字节一致（见 `presence-wiring-judge.ts`）。
  const judge = judgeWiring(host)
  // 判断能力发布给兄弟行（VoceChat）：与 presence.enabled 无关，配了 typed 后端就发布。
  const releaseJudge = publishJudgeToPeers(host, {
    port: judge.port,
    backend: judge.backend,
    model: judge.model,
  })
  const presence = new GroupPresence(presenceDepsOf(host, { ambient, afterSpeak, modeNow, shadowLog, registry, judge, fallbackPlatform, sentLogHub }))
  const releaseEvents = publishEvents(host, presence)
  // 后台「群社交」页（P8 §5.4）：只读诊断。它读的就是发送闸门真正在读的那个 mode 函数，
  // 所以页面上显示的模式与「到底会不会发」永远是同一个值。
  registerSocialResource(host, presence)
  host.log(`presence: 已启用（白名单群 ${JSON.stringify(host.config.presence.groups)}；`
    + '未 @ 时也会自己搭话：能接就接、没话可说就沉默，受最小间隔与每小时额度约束）')
  return {
    ambient,
    presence,
    ...(registry === null ? {} : { participants: () => registry.fileSync() }),
    dispose: () => {
      try { releaseEvents() } catch { /* 释放必须幂等且不抛 */ }
      try { releaseJudge() } catch { /* 同上 */ }
      presence.dispose()
      // 打分器进程是真实资源：一次判断都没跑过时这里就是空操作。
      void judge.dispose().catch(() => { /* 回收失败不该影响卸载 */ })
    },
  }
}



