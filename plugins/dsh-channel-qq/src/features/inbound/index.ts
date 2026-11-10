/** 入站子插件（P5.1）：会话运行时（登记表 / 回合 / 通知 / 组包 / 流水线）、
 * QQ 事件分发、以及主 sent-log（工具面与后台都读它）。
 *
 * 装配工厂从 `src/plugin.ts` 搬来（那里的 `createRuntime()` 是 P3 拆 `bridge.ts`
 * 的产物；P5 把它收进本子插件）。事件分发原来长在 `ChannelQQ.onEvent` 里：
 * 旁路观察先跑（同步、发射后不管），通知走裁决，消息进流水线。
 */

import { ConversationRegistry } from '../../app/conversation/registry.js'
import { GatewayHealth } from '../../app/conversation/gateway-health.js'
import { PromptComposer } from '../../app/conversation/prompt-composer.js'
import { syncInstructionRegion } from './instruction-region.js'

import { TurnLauncher } from '../../app/conversation/turns.js'
import { InboundPipeline } from '../../app/inbound/pipeline.js'
import { NoticeHandler } from '../../app/inbound/notices.js'
import { compileSignatures, type OutputSignatureRules } from '../../core/injection/signatures.js'
import { RuleInjectionScanner } from '../../core/injection/scan.js'
import { createPolicyScreening, policyEnabled, TrustTrackingTurns } from '../../app/policy/tool-policy.js'
import { turnTrust } from '../../core/trust.js'
import { createBlobStore } from '../../adapters/fs-store/blob-store.js'
import { findPackageRoot } from '../../adapters/persona/fs-pack.js'
import { systemClock, systemRandom } from '../../ports/clock.js'
import { systemHttp } from '../../adapters/http/client.js'
import { transcribeOne, turnHooksOf } from './runtime-helpers.js'
import { maybeHandleAccessCommand } from '../access/commands.js'
import { createSentLogHub } from '../../sent-log.js'
import { readJson } from '../../read-json.js'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import { announceToolsV2Switch, syncToolsRegion } from '../tools-v2/index.js'
import { lazyEvidence } from './lazy-evidence.js'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OneBotEvent } from '../../types.js'
import type { InjectionScanner } from '../../ports/injection.js'
import type { SentLogReader } from '../../app/conversation/turns.js'
import type { createAgentGateway } from '../../adapters/dsh-host/agents.js'
import type { QQChannelConfig } from '../../config.js'
import type { ChatPlatform, QQApi } from '../../ports/platform.js'
import type { MemoryEvidence } from '../../ports/memory.js'
import type { KbEvidence } from '../../ports/kb.js'
import type { GatewayErrorBus, PlatformParts, SubHost, SubPlugin } from '../plugin-kit.js'
import type { TurnHooks } from '../../ports/turn-hooks.js'
import { createAdminCommand, startReceiptPoller } from '../approval/index.js'
import { maybeHandleResetCommand } from './reset-command.js'
import { createRuntimeNoteRefresher } from './runtime-note.js'
import { approvalEnabled } from '../approval/store.js'
import { ScreeningPacketComposer } from './screening-composer.js'
import { wirePresence } from './presence-wiring.js'
import { runtimeDepsOf } from './runtime-deps.js'
import { isSlashCommandText } from '../../core/commands.js'
import { rawText } from '../../core/message/parse.js'
import type { AmbientStore } from '../../app/inbound/ambient-store.js'
import type { PresenceObserver } from '../../app/inbound/group-ambient.js'
import type { RegistryFile } from '../../core/participant.js'
export { ScreeningPacketComposer } from './screening-composer.js'
export { syncInstructionRegion, writeInstructionRegion, type InstructionRegionStatus } from './instruction-region.js'

/** 组装出来的一套入站侧对象。 */
export interface ChannelRuntime {
  readonly registry: ConversationRegistry
  readonly turns: TurnLauncher
  readonly notices: NoticeHandler
  readonly pipeline: InboundPipeline
}

export interface RuntimeDeps {
  readonly config: QQChannelConfig
  readonly platform: ChatPlatform
  readonly gateway: ReturnType<typeof createAgentGateway>
  readonly health: GatewayHealth
  readonly prompts: PromptComposer
  readonly log: (line: string) => void
  /** 每包的知识库召回（memory 子插件提供，晚于本插件挂载，所以是取值函数）。 */
  readonly knowledge: () => { readonly entries: unknown[]; search(q: string, top?: number): Array<{ content: string }> } | null
  /** 记忆证据（memory 子插件提供；没装就是 undefined，组包退回旧的关键词召回）。 */
  readonly memoryEvidence?: MemoryEvidence
  /** 知识库证据（kb 子插件提供；装载顺序在 inbound 之后，用惰性取值）。 */
  readonly kbEvidence?: KbEvidence
  /** 语音转写（provider 的事，装配时从 stt 适配器接过来）。 */
  readonly transcribe: (messageId: number) => Promise<string | null>
  /** 注入特征扫描器（P6c；表坏掉时为 null = 不打标、不拦截）。 */
  readonly screen?: { readonly scanner: InjectionScanner | null }
  /** 取某个房间的出站消息日志（"她最近说过什么"）。文件位置是部署知识。 */
  readonly openSentLog: (room: string) => Promise<SentLogReader>
  /** 管理员本地命令（审批网关）；未启用的部署为 undefined。 */
  readonly adminCommand?: (text: string, userId: number) => Promise<string | null>
  /** 模型错误投递（换血看门狗消费）。 */
  readonly onGatewayError?: (room: string, detail: string) => void
  /** 每包开头的运行环境事实（模型 / 图片能力 / 窗口）。 */
  readonly runtimeNote?: () => string
  /** 回合生命周期钩子（A1 交互提示；interaction 子插件提供）。 */
  readonly turnHooks?: TurnHooks
  /** 群聊旁听缓冲（`presence` 装配的产物；缺省 = 无旁听）。 */
  readonly ambient?: AmbientStore
  /** 自主接话执行器（缺省 = 只旁听、被 @ 时带背景，不主动开口）。 */
  readonly presence?: PresenceObserver
  /** 参与者注册表（P9-G4 §2.2）：同步读法；没开注册表时缺省。 */
  readonly participants?: () => RegistryFile | null
}

/** 会话登记表：房间 → 会话，四条件路径共用同一份并发保护。 */
function createRegistry(deps: RuntimeDeps, gateway: ReturnType<typeof createAgentGateway>): ConversationRegistry {
  return new ConversationRegistry({
    gateway,
    health: deps.health,
    clock: systemClock,
    random: systemRandom,
    log: deps.log,
    config: () => deps.config,
    nudge: () => deps.prompts.gatewayNudge(),
    ...deps.onGatewayError === undefined ? {} : { onGatewayError: deps.onGatewayError },
    ...deps.turnHooks === undefined ? {} : { turnHooks: deps.turnHooks },
  })
}

/** 发起回合：主动私聊 / 定时任务 / 后台指令，投递状态归回合账本。 */
function createTurns(registry: ConversationRegistry, deps: RuntimeDeps): TurnLauncher {
  // P6c：包装类在每次 submit 前把"发起人档位 + 包污点"落进信任账本（policy.v2 关着时直通）。
  return new TrustTrackingTurns({
    registry,
    prompts: deps.prompts,
    clock: systemClock,
    log: deps.log,
    config: () => deps.config,
    openSentLog: deps.openSentLog,
    ...deps.runtimeNote === undefined ? {} : { runtimeNote: deps.runtimeNote },
    ...deps.turnHooks === undefined ? {} : { hooks: deps.turnHooks },
  }, {
    ledger: turnTrust,
    admins: () => deps.config.admins,
    enabled: () => policyEnabled(deps.config),
  })
}

/** 通知：戳一戳裁决与群事件合并。 */
function createNotices(registry: ConversationRegistry, turns: TurnLauncher, deps: RuntimeDeps): NoticeHandler {
  return new NoticeHandler({
    registry,
    turns,
    prompts: deps.prompts,
    platform: () => deps.platform,
    clock: systemClock,
    config: () => deps.config,
    log: deps.log,
  })
}

// ── 注入特征（P6c policy.v2） ────────────────────────────────────────────────

/** 规则表的加载结果：入站扫描器 + 出站规则；坏表加载不出来时整份为 null。 */
export interface SignatureBundle {
  readonly scanner: RuleInjectionScanner
  readonly output: OutputSignatureRules
}

/** 默认路径的加载缓存（规则表是发布物，运行中不重读；改规则要重启）。 */
let signaturesCache: { bundle: SignatureBundle | null } | null = null

/**
 * 读插件自带的注入特征表（`assets/injection/signatures.json`）并编译。
 *
 * 为什么读盘在这里（features 侧）：`src/core/` 是可重放层，不许碰文件（R8）。
 * **坏表绝不挡对话**：读不到、解析不了、版本不认识，一律降级为"没有规则"，
 * 记一行日志继续跑（规则表是第二道防线，不是对话的前置条件）。
 *
 * @param file 指定文件（测试用）；缺省走包内资产并缓存。
 */
export async function loadSignatureBundle(
  log: (line: string) => void,
  file?: string,
): Promise<SignatureBundle | null> {
  if (file === undefined && signaturesCache !== null) return signaturesCache.bundle
  // 包根的找法沿用 fs-pack 的向上查找：源码树 / lib / lib-test 三种深度都要能命中。
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url))) ?? '.'
  const target = file ?? path.join(root, 'assets', 'injection', 'signatures.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(target, 'utf8'))
  } catch (error) {
    log(`policy: 注入特征表读取失败（${target}），本次按没有规则处理：${error instanceof Error ? error.message : String(error)}`)
    if (file === undefined) signaturesCache = { bundle: null }
    return null
  }
  const compiled = compileSignatures(parsed)
  if (!compiled.ok) {
    log(`policy: 注入特征表未通过校验（${compiled.reason}），本次按没有规则处理`)
    if (file === undefined) signaturesCache = { bundle: null }
    return null
  }
  const bundle: SignatureBundle = {
    scanner: new RuleInjectionScanner(compiled.value.input),
    output: compiled.value.output,
  }
  if (file === undefined) signaturesCache = { bundle }
  return bundle
}

/** 组装整套入站侧对象。 */
function createRuntime(deps: RuntimeDeps): ChannelRuntime {
  const gateway = deps.gateway
  const registry = createRegistry(deps, gateway)
  const turns = createTurns(registry, deps)
  const notices = createNotices(registry, turns, deps)
  const packets = new ScreeningPacketComposer({
    prompts: deps.prompts,
    clock: systemClock,
    config: () => deps.config,
    log: deps.log,
    knowledge: deps.knowledge,
    ...(deps.memoryEvidence === undefined ? {} : { memoryEvidence: deps.memoryEvidence }),
    ...(deps.kbEvidence === undefined ? {} : { kbEvidence: deps.kbEvidence }),
    sentBlockFor: (room: string) => turns.sentBlockFor(room),
    // 本群连续性（P7-A）：**每次现取**——执行器可能还没建好、也可能被热重载换掉；
    // 关着（`presence.mode='off'`）时返回 null，组包产物与 P6 逐字节一致。
    continuityView: () => deps.presence?.scopedEventsView?.() ?? null,
    // 注入结果回报（P7-C）：区分"这个群没数据"与"这个群没资格拿"，两个数字放在一起才有用。
    noteContinuity: (groupId, outcome) => deps.presence?.noteContinuity?.(groupId, outcome),
  }, createPolicyScreening({
    enabled: () => policyEnabled(deps.config),
    scanner: () => deps.screen?.scanner ?? null,
    admins: () => deps.config.admins,
    ledger: turnTrust,
  }))
  const pipeline = new InboundPipeline({
    config: () => deps.config,
    registry,
    turns,
    prompts: deps.prompts,
    platform: () => deps.platform,
    gateway,
    // 收件箱与宿主的本机文件：IO 全在适配器里（app/ 不许碰 node:*，见 R8）。
    blobs: createBlobStore(() => deps.config.workspacePath ?? ''),
    http: systemHttp,
    clock: systemClock,
    random: systemRandom,
    health: deps.health,
    log: deps.log,
    transcribe: deps.transcribe,
    knowledge: deps.knowledge,
    packets,
    ...(deps.ambient === undefined ? {} : { ambient: deps.ambient }),
    ...(deps.presence === undefined ? {} : { presence: deps.presence }),
    ...(deps.participants === undefined ? {} : { participants: deps.participants }),
    ...deps.adminCommand === undefined ? {} : { adminCommand: deps.adminCommand },
  })
  return { registry, turns, notices, pipeline }
}

/** 事件分发：旁路观察先跑（同步、发射后不管），通知进裁决，消息进流水线。 */
async function dispatch(host: SubHost, runtime: ChannelRuntime, event: OneBotEvent): Promise<void> {
  try {
    // 安全门控在一切之前：不通过的消息不进观察者、不进组包、不进 agent。
    host.get('channelHealth')?.onInbound()
    if (host.get('access')?.allow(event) === false) return
    // 群聊斜杠命令一律不处理（2026-11-01 使用者要求）：不当命令、不进观察者、不进旁听、不交给模型。
    // 判定是纯函数（`core/commands.ts`）；私聊不受影响（管理员命令与审批仍在私聊）。
    if (event.post_type === 'message' && event.message_type === 'group' && isSlashCommandText(rawText(event))) {
      if (host.config.debug) host.log(`group slash command ignored (${String(event.group_id ?? '')})`)
      return
    }
    // 管理员私聊命令（待批访问/放行/拒绝）在模型之前处理。
    if (await maybeHandleAccessCommand(host, event)) return
    // 旁路观察者：群消息照旧；私聊也进（只为了让「私聊偷表情」能读到图片，
    // track() 自己按 groupEnabled 提前 return，不会把私聊喂进口癖/风控）。
    if (event.post_type === 'message' && (event.message_type === 'group' || event.message_type === 'private')) {
      host.get('observers')?.observe(event)
    }
    if (event.post_type === 'message') host.get('chatlog')?.record(event)
    if (event.post_type === 'notice') {
      await runtime.notices.handle(event)
      return
    }
    // request 类事件（好友申请/群邀请）：access.friendRequests 打开时处理，否则丢弃（旧行为）。
    if (event.post_type === 'request') {
      await host.get('social')?.handleRequest(event)
      return
    }
    if (event.post_type !== 'message') return
    await runtime.pipeline.handle(event)
  } catch (error) {
    host.bridge.logHostError(`channel-qq: event handling failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 后台「机器人发送记录」资源：读 `<dshHome>/channel-qq/sent-*.json`。 */
function registerSendlResource(host: SubHost): void {
  host.registerResource('sendl', {
    label: '机器人发送记录',
    list: async () => {
      const dir = path.join(host.dshHome, 'channel-qq')
      const names = await fs.readdir(dir).catch(() => [] as string[])
      const out: Record<string, unknown> = {}
      for (const name of names) {
        if (!name.startsWith('sent-') || !name.endsWith('.json')) continue
        const entries = await readJson<unknown[]>(path.join(dir, name), [])
        out[name.replace('sent-', '').replace('.json', '')] = entries.slice(-30)
      }
      return out
    },
  })
}

/** 主 sent-log 与后台资源：工具面（qq_search_history 等）与后台页共用同一份。 */
async function provideSentLog(host: SubHost, hub: ReturnType<typeof createSentLogHub>, primaryGroup: number | null): Promise<void> {
  const primary = await hub.for(primaryGroup !== null ? `group-${primaryGroup}` : 'group-none')
  host.provide('sentLog', primary)
  host.provide('sentLogHub', hub)
  registerSendlResource(host)
}

export const inboundPlugin: SubPlugin = {
  name: 'inbound',
  // context.v2 翻开关时要重写工作区 AGENTS.md 的指令受管区（组包行为是现取配置，不用重挂）。
  // tools.v2 同理：它决定受管区里的工具名，改开关后必须重写，否则 AGENTS.md 留着旧名字。
  watches: ['context.v2', 'context.agentInstructions', 'tools.v2'],
  requires: ['platform', 'persona', 'observers'],
  async apply(host) {
    const { config } = host
    const parts = host.need('platform')
    const health = new GatewayHealth()
    const gatewayErrors: GatewayErrorBus = {}
    host.provide('gatewayErrors', gatewayErrors)
    const runtimeNotes = createRuntimeNoteRefresher(host)
    // 同一房间只建一次 sent-log；读写共用（写侧按房间记账见 messaging/tools.ts）。
    const sentLogHub = createSentLogHub(host.dshHome, host.log)
    // 注入特征表（P6c）：坏表/版本不认识 → 降级为"没有规则"，绝不挡对话（loader 内记日志）。
    const bundle = await loadSignatureBundle(host.log)
    host.log(bundle === null
      ? 'policy: 注入特征不可用（坏表或读不到），入站不打标、出站不拦特征'
      : `policy: 注入特征表已加载（入站规则 ${bundle.scanner.ruleCount} 条）`)
    const presence = wirePresence(host, sentLogHub, parts.platform)
    const runtime = createRuntime(runtimeDepsOf({ host, config, parts, health, gatewayErrors, runtimeNotes, sentLogHub, bundle, presence }))
    host.provide('inbound', {
      registry: runtime.registry,
      turns: runtime.turns,
      notices: runtime.notices,
      pipeline: runtime.pipeline,
    })
    parts.client.on('event', (event: OneBotEvent) => {
      if (maybeHandleResetCommand(host, parts, event)) return
      void dispatch(host, runtime, event)
    })
    // 主 sent-log 与后台资源（工具面也读它）。
    await provideSentLog(host, sentLogHub, config.primaryGroup)
    // 指令层与工具面的落点：两个受管区各随挂载同步一次（翻开关走 reload，不重挂子插件）。
    host.log(`instruction region (AGENTS.md): ${await syncInstructionRegion(host)}`)
    host.log(`tools region (AGENTS.md): ${await syncToolsRegion(host)}`)
    const stopApproval = approvalEnabled() ? startReceiptPoller(host) : undefined
    return () => {
      presence.dispose()
      runtime.notices.dispose()
      stopApproval?.()
      runtimeNotes.dispose()
    }
  },
  // context.v2 翻动时重写指令受管区；组包行为本身是现取配置，无需重挂。
  async reload(host) {
    return [`context.v2 → 指令受管区：${await syncInstructionRegion(host)}`]
  },
  // 与原实现一致：client.start() 之后立刻重挂历史会话（发射后不管）。
  start(host) {
    const registry = host.need('inbound').registry
    void (async () => {
      await registry.reattachAll()
      await announceToolsV2Switch(host, registry) // 切换日说明（tools.v2）：一次性，内部自行记日志
    })()
  },
}
