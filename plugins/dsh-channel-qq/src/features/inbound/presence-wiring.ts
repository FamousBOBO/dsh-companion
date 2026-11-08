/** 群聊旁听与自主接话的**装配**：配置 → 旁听环 + 判断执行器。
 *
 * 为什么单独一个文件：这段装配要同时拿到宿主上下文（模型接缝）、当前平台、sent-log 与
 * 配置，写进 `inbound/index.ts` 会把那个文件顶到单文件上限之外（`check:size`），
 * 也会让"关掉这个能力时不造任何对象"这条判据淹没在别的装配里。
 *
 * **关着时一个对象都不造**（只留一行日志说明新代码确实加载了、但这套能力关着）——
 * 于是关掉开关就等于回到旧行为；这是本项目的通用做法，也是这次的应急回滚手段。
 */

import { AmbientStore } from '../../app/inbound/ambient-store.js'
import { GroupPresence } from '../../app/inbound/presence-runtime.js'
import { createHostComplete } from '../../adapters/dsh-host/completion.js'
import { dataRootOfDshHome, readGroupPersona, type GroupPersonaDeps } from '../../adapters/dsh-host/group-persona.js'
import { systemClock } from '../../ports/clock.js'
import type { PresenceObserver } from '../../app/inbound/group-ambient.js'
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
  // 人格快照：**每轮现取**（快照自带版本号），解析路径与失败原因由适配层给。
  // 这条路径没有系统提示词、没有会话，所以人格只能从这条缝进提示词；适配层拿不到就
  // 返回 null，提示词里明说"这次拿不到完整人格"，而不是让它自由发挥。
  const personaDeps: GroupPersonaDeps = {
    context: () => host.bridge.tagContext(),
    // 桥是可选通道（新布局下 home 的父目录才是套件根，能不能解析到取决于部署形态）。
    bridge: () => null,
    dataRoot: () => dataRootOfDshHome(host.dshHome),
    log: host.log,
  }
  let lastPersonaNote = ''
  const presence = new GroupPresence({
    config: () => host.config,
    clock: systemClock,
    log: host.log,
    platform: () => host.get('platform')?.platform ?? fallbackPlatform,
    persona: () => {
      const read = readGroupPersona(personaDeps)
      // 只在"来源变了"时打一行：每轮都打会把群里其它日志淹掉。
      const note = read.snapshot === null
        ? `none(${read.reason})`
        : `${read.via} v${read.snapshot.version}`
      if (note !== lastPersonaNote) {
        lastPersonaNote = note
        host.log(`presence: 人格快照 ${note}`)
      }
      return read.snapshot
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
  host.log(`presence: 已启用（白名单群 ${JSON.stringify(host.config.presence.groups)}；`
    + '未 @ 时也会自己搭话：能接就接、没话可说就沉默，受最小间隔与每小时额度约束）')
  return { ambient, presence, dispose: () => presence.dispose() }
}
