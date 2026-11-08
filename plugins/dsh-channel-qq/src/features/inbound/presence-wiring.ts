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
import { DEFAULTS, positiveOr } from '../../app/inbound/presence-flow.js'
import { systemClock } from '../../ports/clock.js'
import type { PresenceObserver } from '../../app/inbound/group-ambient.js'
import type { GroupMemoryRecall } from '../../app/inbound/group-memory-contract.js'
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
  if (host.config.presence?.enabled !== true) {
    host.log('presence: 关（presence.enabled=false）——不记旁听、不调模型判断、不发自主消息')
    return { ambient, dispose: () => {} }
  }
  // 说完之后的附加动作（表情包 / 弱反馈 / 话题落地）。装配一次，内部自带每群额度账本。
  const afterSpeak = afterSpeakHandler(host, () => host.config.presence ?? null)
  const presence = new GroupPresence({
    config: () => host.config,
    clock: systemClock,
    log: host.log,
    platform: () => host.get('platform')?.platform ?? fallbackPlatform,
    persona: personaReader(host),
    memory: memoryRecall(host),
    afterSpeak,
    remember: (input) => {
      try {
        const { written, merged, rejected } = rememberGroupFacts({ dataRoot: dataRootOfDshHome(host.dshHome), ...input })
        // 只在真的写了东西时打日志：每轮都打会把群里其它日志淹掉。
        if (written + merged > 0) {
          host.log(`presence: 群 ${String(input.groupId)} 记住 ${String(written)} 条（合并 ${String(merged)}，拒 ${String(rejected)}）`)
        }
      } catch (error) {
        host.log(`presence: 群记忆写入失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    ambient,
    complete: createHostComplete({
      context: () => host.bridge.tagContext(),
      clock: systemClock,
      log: host.log,
    }),
    recordSent: async (groupId, messageId, text) => {
      try {
        const log = await sentLogHub.for(`group-${groupId}`)
        await log.add({ messageId, quotedId: null, text, time: systemClock.now() })
      } catch (error) {
        host.log(`presence: sent-log 写入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  })
  const releaseEvents = publishEvents(host, presence)
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
