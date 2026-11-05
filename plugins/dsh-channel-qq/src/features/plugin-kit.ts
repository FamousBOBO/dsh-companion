/** 功能子插件的契约与最小加载宿主（P5.1–P5.3）。
 *
 * 每个 `features/<名字>/index.ts` 导出一个 `SubPlugin`：名字、关心的配置路径、
 * 装配逻辑，以及可选的就地热更新/启动钩子。`src/plugin.ts`（根服务）把每个子插件
 * 包成真正的 cordis fiber（生命周期归 fiber：卸载时跑 apply 返回的 disposer），
 * 本文件提供中间层：
 *
 *   - `SubHost` 是子插件能看到的全部世界：活动配置、根日志、**服务袋**（互相协作
 *     只经服务名与 `provide`/`get`/`need`）、后台资源注册表与宿主桥；
 *   - 为什么不在 features 里直接用 cordis 的 `Service`/`inject`：那会把
 *     `@deepseek-ai/*` 的 import 散进每个功能目录（R2 棘轮与 04 §16 都要求宿主
 *     形状只出现在 `adapters/dsh-host/`）。这里用结构化的服务袋等价替代：
 *     `requires` 在挂载时断言（相当于 inject 的"未就绪不启动"），装载顺序由根的表
 *     决定；子插件之间不互相 import，只经服务袋或事件；
 *   - `SectionHost` 按声明顺序装载、逆序卸载；配置保存后按"补丁命中了哪些点路径"
 *     只重载对应的子插件：声明了 `reload` 的走就地钩子（保住实例身份：登录会话、
 *     socket、store），没有的 dispose 后按新配置重挂（A8 意义上的真重载）。
 *
 * 本文件不碰 IO、时钟与宿主包。
 */

import type { QQChannelConfig } from '../config.js'
import type { AdminResource } from '../admin.js'
import type { ProvidersSurface } from '../adapters/dsh-host/providers.js'
import type { OneBotClient } from '../onebot.js'
import type { ChatPlatform, QQApi } from '../ports/platform.js'
import type { MemoryEvidence, MemorySearch, MemoryService } from '../ports/memory.js'
import type { OutboundQueue } from '../outbound.js'
import type { PersonaPack } from '../ports/persona.js'
import type { PromptComposer } from '../app/conversation/prompt-composer.js'
import type { ConversationRegistry } from '../app/conversation/registry.js'
import type { TurnLauncher } from '../app/conversation/turns.js'
import type { NoticeHandler } from '../app/inbound/notices.js'
import type { InboundPipeline } from '../app/inbound/pipeline.js'
import type { InboundObservers } from './observers/inbound.js'
import type { EmojiLibrary } from '../emoji-library.js'
import type { EmojiStore } from '../emoji.js'
import type { SentLog, SentLogHub } from '../sent-log.js'
import type { KnowledgeStore } from '../knowledge.js'
import type { AffectionStore } from '../affection.js'
import type { QuoteStore } from './quotes/store.js'
import type { ReminderStore } from './reminders/store.js'
import type { LearnStore } from './learn/store.js'
import type { FloodGuard } from './flood/guard.js'
import type { createAgentGateway } from '../adapters/dsh-host/agents.js'
import type { AgentRegistry, PresetRegistry } from '../adapters/dsh-host/services.js'
import type { ToolHost } from '../adapters/dsh-host/tools.js'
import type { SkillDrafts, SkillHost } from '../ports/skills.js'
import type { KbEvidence, KbService } from '../ports/kb.js'
import type { HealthProbe } from '../ports/health.js'
import type { SessionSizeProbe } from '../adapters/dsh-host/session-size.js'
import type { RuntimeFacts } from '../ports/runtime.js'
import type { UsageProbe } from '../ports/usage.js'
import type { Interaction } from './interaction/index.js'
import type { MetricsService } from './metrics/service.js'
import type { HistoryService } from './history/service.js'
import type { Reliability } from './reliability/service.js'
import type { AccessService } from './access/service.js'
import type { ChatLogRecorder } from './chatlog/index.js'
import type { ContactService } from './contact/types.js'
import type { SharePort } from './contact/share-port.js'

/** platform 子插件提供的四件套（传输对象 + 端口 + 出站队列）。 */
export interface PlatformParts {
  readonly client: OneBotClient
  readonly platform: ChatPlatform
  readonly api: QQApi
  readonly out: OutboundQueue
}

/** persona 子插件提供的人格包与组包器。 */
export interface PersonaParts {
  readonly pack: PersonaPack
  readonly composer: PromptComposer
}

/** inbound 子插件提供的入站运行时四件套。 */
export interface InboundParts {
  readonly registry: ConversationRegistry
  readonly turns: TurnLauncher
  readonly notices: NoticeHandler
  readonly pipeline: InboundPipeline
}

/** 表情子插件提供的库（索引 + 语义检索）与偷取/发送存储。 */
export interface EmojiParts {
  readonly library: EmojiLibrary
  readonly store: EmojiStore
}

/** 记忆子插件提供的知识库与抽取函数。 */
export interface KnowledgeParts {
  readonly store: KnowledgeStore
  /** 从一段文本抽取知识条目（未配置提取器时返回 0）。 */
  readonly extract: (source: string, text: string) => Promise<number>
}

/** 会话换血服务（session-reset 提供；inbound 的管理员指令调用它）。 */
export interface SessionResetService {
  reset(room: string, reason: string): Promise<{ ok: boolean; note: string }>
}

/** 网关错误信号：inbound 在每次 agent/error 时投递，session-reset 消费。 */
export interface GatewayErrorBus {
  handler?: (room: string, detail: string) => void
}

/** 服务袋：子插件互相协作的唯一直达通道。 */
export interface ServiceBag {
  platform?: PlatformParts
  persona?: PersonaParts
  inbound?: InboundParts
  sentLog?: SentLog
  /** 按房间取 SentLog 的 hub（写侧按房间记账，读侧复用同一实例）。 */
  sentLogHub?: SentLogHub
  emoji?: EmojiParts
  knowledge?: KnowledgeParts
  /** 记忆证据块（P6e；记忆子插件提供。入站组包"想起点什么"走它）。 */
  memoryEvidence?: MemoryEvidence
  /** P0 即时抽取的回合钩子（begin 带本回合消息，end 触发带外沉淀）。 */
  memoryCapture?: { begin(room: string, turn: { text: string; speakerId?: number; speakerName?: string }): void; end(room: string): void }
  /** 社交面：request 事件处理（好友申请/群邀请）+ 管理员私聊指令。 */
  social?: {
    handleRequest(event: unknown): Promise<void>
    commandHandler(text: string, userId: number): Promise<boolean>
  }
  /** 记忆服务（P6e）：工具面的主动召回与写入走它。 */
  memory?: MemoryService
  /** 深召回（原文块）：agent 主动搜索用，不进自动注入。 */
  memorySearch?: MemorySearch
  /** 知识库服务（知识库子插件提供；工具与后台走它）。 */
  kb?: KbService
  /** 知识库证据块（每回合自动注入；injectTop=0 时恒为空串）。 */
  kbEvidence?: KbEvidence
  /** 技能草稿（记忆候选晋升 → 技能待审区）。 */
  skillDrafts?: SkillDrafts
  affection?: AffectionStore
  quotes?: QuoteStore
  reminders?: ReminderStore
  /** 提醒轮询器的**只读诊断面**（与 `/api/resource/reminders` 同源；理由见 `runner-status.ts`）。 */
  remindersRunner?: { status(): import('./reminders/runner-status.js').RunnerStatus }
  learn?: LearnStore
  flood?: FloodGuard
  observers?: InboundObservers
  /** 发送侧健康探测（platform 提供；后台 `/api/healthz` 与运维脚本读它）。 */
  health?: HealthProbe
  /** 网关错误总线（inbound 提供；换血看门狗消费）。 */
  gatewayErrors?: GatewayErrorBus
  /** 会话换血（session-reset 提供；inbound 的 `/换血` 指令调用）。 */
  sessionReset?: SessionResetService
  /** 回合交互提示（interaction 提供；inbound 的回合钩子惰性取用）。 */
  interaction?: Interaction
  /** 指标采集（metrics 提供；回合钩子与出站失败计数用）。 */
  metrics?: MetricsService
  /** 服务端历史（history 提供；检索回源与群日报用）。 */
  history?: HistoryService
  /** 回合告知（reliability 提供；慢回合/永久失败提示）。 */
  reliability?: Reliability
  /** 访问门控（access 提供；入站分发最前面判定）。 */
  access?: AccessService
  /** 渠道健康守望（channel-health 提供；入站事件到达时记活）。 */
  channelHealth?: { onInbound(): void }
  /** 原话簿（chatlog 提供；入站消息原样记录）。 */
  chatlog?: ChatLogRecorder
  /**
   * 主动消息的候选与投递账本（contact 提供）。
   *
   * 只暴露 propose/cancel/setPaused/status——**没有**"立刻发一条"的直通口：
   * 发送必须经过 worker 的门控，否则"最终授权由代码强制"就只是注释。
   */
  contact?: ContactService
  /**
   * 分享候选的**唯一**入口（P2.5-3B）：由 contact 子插件 provide，根插件再 `ctx.provide` 给宿主。
   *
   * 为什么两个方法名：foundation 的 `contactSharePort()` 实际探测的是
   * `service.submitShareCandidate`，而任务书里写的是 `submitShare`；两个都给，谁都不用改。
   */
  contactShare?: SharePort
}

/** 根转交进来的宿主能力；这里也是 cordis `ctx` 唯一被"窄化"的地方。 */
export interface HostBridge {
  /** 宿主工具表的注册面（各工具注册器直接收它）。 */
  toolHost(): ToolHost
  /** agent 网关（建会话/恢复/健康回调），已由根用真 ctx 建好。 */
  agentGateway(): ReturnType<typeof createAgentGateway>
  /** 表情打标要的宿主上下文（`EmojiLibrary.tagEntry` 的第一个参数）。 */
  tagContext(): Parameters<EmojiLibrary['tagEntry']>[0]
  /** 宿主人格预设注册表（后台"人格与指令"页用）。 */
  presetRegistry(): PresetRegistry | undefined
  /** 宿主会话注册表（后台"重建会话"用）。 */
  agentRegistry(): AgentRegistry | undefined
  /** 模型供应商管理面（后台「模型供应商」页；宿主缺 settings 时为 undefined）。 */
  providersSurface(): ProvidersSurface | undefined
  /** 技能接缝：把技能仓库接进宿主的目录与 `/name` 触发（宿主没装 skill 服务时 install 返回 undefined）。 */
  skillsHost?(): SkillHost
  /** 会话体积探针（换血看门狗用：tokenMeter + 模型窗口）。 */
  sessionSize?(): SessionSizeProbe
  /** 会话计费用量（tokenUsage 投影；指标页用）。 */
  usage?(): UsageProbe
  /** 进程内工具调用/失败计数（注册口自己维护）。 */
  toolStats?(): { calls: number; failures: number }
  /** 当前模型能力（每包注入一条，用来压过历史里过时的能力描述）。 */
  runtimeFacts?(): Promise<RuntimeFacts | null>
  /** 宿主 console logger 的错误出口（事件分发层用，不写文件日志）。 */
  logHostError(message: string): void
  /** 把一次配置补丁交给根：只重载被命中的子插件。 */
  reloadSections(patch: Record<string, unknown>): Promise<string[]>
}

/** 一个卸载器；`apply` 的返回值，由持有它的 fiber 在卸载时执行。 */
export type Dispose = () => void | Promise<void>

/** `apply` 的可返回形状：卸载器可缺省、可异步（纯提供型插件不返回任何东西）。 */
export type PluginEffect = void | Dispose | Promise<void | Dispose>

/** 一个功能子插件。 */
export interface SubPlugin {
  /** 唯一名（fiber 名 `qq-<name>`、诊断与测试用）。 */
  readonly name: string
  /** 关心的配置点路径：父路径命中所有子项；`'*'` = 任何变更都重载；空数组 = 不需要动作。 */
  readonly watches: '*' | readonly string[]
  /** 挂载时就必须在场的服务（inject 的等价断言）。 */
  readonly requires?: readonly (keyof ServiceBag)[]
  /** 装配；返回值（若有）是卸载器，由持有它的 fiber 在卸载时执行。 */
  apply(host: SubHost): PluginEffect
  /** 就地热更新（返回给后台的说明行）；没有它就走「卸载 → 按新配置重挂」。 */
  reload?(host: SubHost): Promise<string[]> | string[]
  /** 全部子插件挂载完之后执行一次（连 transport、起调度器、开后台）。 */
  start?(host: SubHost): Promise<void> | void
}

/** 子插件看到的宿主。 */
export interface SubHost {
  readonly config: QQChannelConfig
  readonly dshHome: string
  log(line: string): void
  get<K extends keyof ServiceBag>(name: K): ServiceBag[K]
  need<K extends keyof ServiceBag>(name: K): NonNullable<ServiceBag[K]>
  provide<K extends keyof ServiceBag>(name: K, value: NonNullable<ServiceBag[K]>): void
  registerResource(key: string, resource: AdminResource): void
  /** 后台资源表的**活对象**（AdminServer 每请求直读）。 */
  readonly resources: Record<string, AdminResource>
  reloadSections(patch: Record<string, unknown>): Promise<string[]>
  readonly bridge: HostBridge
  /** 卸载后由宿主调用：清掉本插件 provide 过的服务。 */
  cleanup(): void
}

/** 三个功能 store 共用的落盘选项（形状一致，见各自 store 的构造函数）。 */
export function storeOptions(host: SubHost): { workspacePath: string | null; dshHome: string; log: (line: string) => void } {
  return { workspacePath: host.config.workspacePath, dshHome: host.dshHome, log: host.log }
}

/**
 * 补丁里的叶子点路径。
 *
 * 空对象也算一条叶子——对齐旧 `applyEffects` 的 `key in patch` 语义
 * （`{ connection: {} }` 以前会触发重连，现在也要）。
 */
export function touchedLeafPaths(patch: Record<string, unknown>): string[] {
  const out: string[] = []
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) { out.push(prefix); return }
    const entries = Object.entries(node as Record<string, unknown>)
    if (entries.length === 0) { out.push(prefix); return }
    for (const [key, value] of entries) walk(value, prefix === '' ? key : `${prefix}.${key}`)
  }
  for (const [key, value] of Object.entries(patch)) walk(value, key)
  return out
}

/** watch 是否命中一条叶子：相等或为其祖先（`connection` 命中 `connection.url`）。 */
export function watchHit(watch: string, leaf: string): boolean {
  return leaf === watch || leaf.startsWith(`${watch}.`)
}

/** 建一个子插件的宿主；`provided` 记账供 cleanup 清袋。 */
export function createHost(env: SectionHostEnv, bag: ServiceBag, name: string): SubHost {
  const provided: Array<keyof ServiceBag> = []
  return {
    config: env.config,
    dshHome: env.dshHome,
    log: env.log,
    get: <K extends keyof ServiceBag>(key: K): ServiceBag[K] => bag[key],
    need: <K extends keyof ServiceBag>(key: K): NonNullable<ServiceBag[K]> => {
      const value = bag[key]
      if (value === undefined) {
        throw new Error(`channel-qq: 子插件 ${name} 需要的服务 ${String(key)} 尚未提供（检查装载顺序/requires）`)
      }
      return value as NonNullable<ServiceBag[K]>
    },
    provide: <K extends keyof ServiceBag>(key: K, value: NonNullable<ServiceBag[K]>): void => {
      provided.push(key)
      bag[key] = value
    },
    registerResource: (key, resource) => { env.resources[key] = resource },
    resources: env.resources,
    reloadSections: (patch) => env.bridge.reloadSections(patch),
    bridge: env.bridge,
    cleanup: () => {
      for (const key of provided.reverse()) delete bag[key]
    },
  }
}

/** 根提供的装载环境。 */
export interface SectionHostEnv {
  readonly config: QQChannelConfig
  readonly dshHome: string
  readonly log: (line: string) => void
  readonly bridge: HostBridge
  readonly resources: Record<string, AdminResource>
  /** 运行一个子插件（真实现 = cordis fiber）并返回它的卸载器。 */
  readonly scope: (plugin: SubPlugin, host: SubHost) => Promise<Dispose>
}

interface Mounted {
  readonly plugin: SubPlugin
  readonly host: SubHost
  readonly dispose: Dispose
}

/** 装载表的管理者：顺序装载、逆序卸载、按补丁只重载命中的段。 */
export class SectionHost {
  private readonly bag: ServiceBag = {}
  private readonly mounted: Mounted[] = []

  constructor(private readonly env: SectionHostEnv) {}

  async mountAll(plugins: readonly SubPlugin[]): Promise<void> {
    for (const plugin of plugins) await this.attach(plugin)
  }

  /** 全部挂载完之后跑 start 钩子（顺序 = 装载顺序）。 */
  async startAll(): Promise<void> {
    for (const entry of this.mounted) await entry.plugin.start?.(entry.host)
  }

  /** 逆序卸载（后挂的先卸）；清掉每个插件 provide 过的服务。 */
  async disposeAll(): Promise<void> {
    while (this.mounted.length > 0) {
      const entry = this.mounted.pop()!
      await entry.dispose()
      entry.host.cleanup()
    }
  }

  /**
   * 配置保存之后：算出补丁命中的点路径，只动声明关心的子插件。
   *
   * @returns 给后台的回执行（与旧 `applyEffects` 的 notes 同义）。
   */
  async reloadAffected(patch: Record<string, unknown>): Promise<string[]> {
    const leaves = touchedLeafPaths(patch)
    const notes: string[] = []
    for (let i = 0; i < this.mounted.length; i++) {
      const entry = this.mounted[i]!
      if (!this.hits(entry.plugin, leaves)) continue
      if (entry.plugin.reload !== undefined) {
        notes.push(...await entry.plugin.reload(entry.host))
        continue
      }
      await entry.dispose()
      entry.host.cleanup()
      await this.attach(entry.plugin, i)
      notes.push(`${entry.plugin.name}: 已按新配置重载`)
    }
    return notes
  }

  /** 测试/诊断用：当前挂载顺序。 */
  mountedNames(): string[] {
    return this.mounted.map((entry) => entry.plugin.name)
  }

  /** 测试/诊断用：直读服务袋里当前的某个服务（未提供 = undefined，与 SubHost.get 同语义）。 */
  get<K extends keyof ServiceBag>(name: K): ServiceBag[K] {
    return this.bag[name]
  }

  private hits(plugin: SubPlugin, leaves: readonly string[]): boolean {
    if (plugin.watches === '*') return true
    return plugin.watches.some((watch) => leaves.some((leaf) => watchHit(watch, leaf)))
  }

  /** 跑一个插件的 apply 并登记；`at` 给定时替换该位置（重挂路径）。 */
  private async attach(plugin: SubPlugin, at = -1): Promise<Dispose> {
    const host = createHost(this.env, this.bag, plugin.name)
    for (const key of plugin.requires ?? []) host.need(key)
    const dispose = await this.env.scope(plugin, host)
    if (at < 0) this.mounted.push({ plugin, host, dispose })
    else this.mounted[at] = { plugin, host, dispose }
    return dispose
  }
}
