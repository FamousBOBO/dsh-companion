/** 入站运行时的**依赖装配**（从 `index.ts` 搬出：那里有 400 行硬上限）。
 *
 * 这里只做一件事：把已经建好的对象摆进一个 `RuntimeDeps`。**没有副作用、没有判定、
 * 不读配置之外的东西**——所以它可以在测试里被单独喂假件，而挂载流程那一侧
 * （`apply`：提供服务、装事件、同步受管区、返回 dispose）读起来就只剩挂载。
 */

import { createAdminCommand } from '../approval/index.js'
import { approvalEnabled } from '../approval/store.js'
import { transcribeOne, turnHooksOf } from './runtime-helpers.js'
import { lazyEvidence } from './lazy-evidence.js'
import type { GatewayHealth } from '../../app/conversation/gateway-health.js'
import type { RuntimeDeps } from './index.js'
import type { ChatPlatform, QQApi } from '../../ports/platform.js'
import type { QQChannelConfig } from '../../config.js'
import type { GatewayErrorBus, SubHost } from '../plugin-kit.js'
import type { PresenceWiring } from './presence-wiring.js'
import type { createRuntimeNoteRefresher } from './runtime-note.js'
import type { createSentLogHub } from '../../sent-log.js'
import type { loadSignatureBundle } from './index.js'

/**
 * `apply` 里那一大段"从宿主与已建对象拼出 `RuntimeDeps`"的逻辑。
 *
 * 为什么抽出来：`apply` 是挂载流程（提供服务、装事件、同步受管区、返回 dispose），
 * 而这一段是**纯装配**（没有副作用、只把已有的东西摆进一个对象）。混在一起时
 * `apply` 会顶到函数体量上限，读的人也分不清哪几行是"挂载"哪几行是"接线"。
 */
export function runtimeDepsOf(input: {
  readonly host: SubHost
  readonly config: QQChannelConfig
  readonly parts: { readonly platform: ChatPlatform; readonly api: QQApi }
  readonly health: GatewayHealth
  readonly gatewayErrors: GatewayErrorBus
  readonly runtimeNotes: ReturnType<typeof createRuntimeNoteRefresher>
  readonly sentLogHub: ReturnType<typeof createSentLogHub>
  readonly bundle: Awaited<ReturnType<typeof loadSignatureBundle>>
  readonly presence: PresenceWiring
}): RuntimeDeps {
  const { host, config, parts, presence } = input
  return {
    config,
    platform: parts.platform,
    gateway: host.bridge.agentGateway(),
    health: input.health,
    prompts: host.need('persona').composer,
    log: host.log,
    knowledge: () => host.get('knowledge')?.store ?? null,
    ...lazyEvidence(host),
    screen: { scanner: input.bundle === null ? null : input.bundle.scanner },
    transcribe: (messageId: number) => transcribeOne(parts.api, config.stt, messageId, host.log),
    openSentLog: (room: string) => input.sentLogHub.for(room),
    onGatewayError: (room, detail) => input.gatewayErrors.handler?.(room, detail),
    // context.v2 uses the companion agent's scoped runtime context instead.
    runtimeNote: () => config.context.agentInstructions ? '' : input.runtimeNotes.note(),
    turnHooks: turnHooksOf(host),
    ambient: presence.ambient,
    ...(presence.presence === undefined ? {} : { presence: presence.presence }),
    // 参与者注册表（P9-G4 §2.2）：采集路径按它冻结"这条消息当时是谁"；没开就缺省。
    ...(presence.participants === undefined ? {} : { participants: presence.participants }),
    // 审批网关（默认关；CHANNEL_QQ_APPROVAL=1 时生效）。命令先于 agent 处理、不经模型。
    // 传取值函数而不是 `config.admins`：撤掉管理员后必须立刻失效。
    ...approvalEnabled() ? { adminCommand: createAdminCommand(() => host.config.admins, host.log) } : {},
  }
}
