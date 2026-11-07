/** 组合根（P5.1–P5.5）：解析配置、挂子插件、按段热重载。
 *
 * 这里原来是 778 行的 god class；P5 之后只剩四件事：
 *   - 解析两层配置（cordis 行 → 后台落盘覆盖）并起日志出口；
 *   - 把 `sections.ts` 的装载表交给 `SectionHost`，每个子插件包成一个真 cordis
 *     fiber（生命周期归 fiber：卸载就是执行 apply 返回的 disposer）；
 *   - 把宿主能力（工具表 / agent 网关 / 预设与会话注册表）经 `HostBridge`
 *     转成结构化接缝——features/ 里因此看不到一行 `@deepseek-ai/*`；
 *   - 配置保存后的热重载入口 `applyEffects(patch)`：只有声明关心补丁路径的
 *     子插件会动作。
 */

import { installFollowupContext } from './adapters/dsh-host/followup-context.js'
import { loadCompanionBridge, type CompanionBridge } from './adapters/dsh-host/companion-bridge.js'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import * as path from 'node:path'
import { loadAdminOverride, resolveConfig, type QQChannelConfig } from './config.js'
import { resolveDshHome } from './paths.js'
import { configureFileBoundary } from './local-file.js'
import {
  configureAgendaPort, configureAgendaProbe, probeAgendaCandidates, type AgendaPort, type AgendaProbe,
} from './features/reminders/agenda-seam.js'
import type { SharePort } from './features/contact/share-port.js'
import { publishServiceSafely, verifyPublished } from './features/service-publish.js'
import { createLogSink, createLogger, defaultLogFiles } from './adapters/log/logger.js'
import type { LogSink } from './ports/logger.js'
import { createAgentGateway } from './adapters/dsh-host/agents.js'
import { createProvidersSurface } from './adapters/dsh-host/providers.js'
import { agentRegistry, installToolGate, presetRegistry } from './adapters/dsh-host/services.js'
import { toolStats } from './adapters/dsh-host/tools.js'
import { installSkills } from './adapters/dsh-host/skills.js'
import { createSessionSizeProbe } from './adapters/dsh-host/session-size.js'
import { createUsageProbe } from './adapters/dsh-host/usage.js'
import { readRuntimeFacts } from './adapters/dsh-host/runtime-info.js'
import { guardTemplateKey, policyEnabled } from './app/policy/tool-policy.js'
import { toolsV2Enabled } from './features/tools-v2/index.js'
import { SendSignatureGuard } from './core/guards/output-signatures.js'
import { UrlSafetyGuard } from './core/guards/url-safety.js'
import { platformApiRef } from './features/platform/index.js'
import { turnTrust } from './core/trust.js'
import { loadSignatureBundle } from './features/inbound/index.js'
import { createToolGateHooks, ToolGateController } from './features/qq-tools/register.js'
import type { AdminResource } from './admin.js'
import { SectionHost } from './features/plugin-kit.js'
import type { Dispose, HostBridge, SectionHostEnv, SubHost, SubPlugin } from './features/plugin-kit.js'
import { SECTION_PLUGINS } from './sections.js'

export class ChannelQQ extends Service {
  static inject = [
    'llm',
    'agents',
    'agentPresets',
    'agentDefaultModel',
    'permissionPresets',
    'sessionTitle',
    'workspaceRegistry',
    'tools',
    'attachments',
  ]

  private readonly config: QQChannelConfig
  private readonly log: (line: string) => void
  private readonly logSink: { sink: LogSink; start: () => Promise<void> }
  /** 后台资源表：子插件各自 `registerResource` 的**活对象**，直接交给面板。 */
  private readonly resources: Record<string, AdminResource> = {}
  private serviceBridge: CompanionBridge | null = null
  private sections: SectionHost | null = null
  private gateway: ReturnType<typeof createAgentGateway> | null = null
  /** 工具闸门（P6c policy.v2 / P6d tools.v2）；两个开关都关着时恒为 null——一个监听器都不注册。 */
  private toolGate: ToolGateController | null = null

  constructor(ctx: ConstructorParameters<typeof Service>[0], config: unknown) {
    super(ctx, 'channelQQ')
    // Two config layers, lowest first: the cordis row's user patch, then the
    // admin panel's persisted override (see `resolveConfig` in config.ts).
    this.config = resolveConfig(config as Partial<QQChannelConfig>, loadAdminOverride(resolveDshHome()))
    // The harness console logger only surfaces warnings by default; mirror
    // channel activity to a file so connection and reply-capture issues stay
    // debuggable（文本行照旧写 `channel-qq.log`，并排写结构化 JSONL）。
    this.logSink = createLogSink({
      ...defaultLogFiles(resolveDshHome()),
      onError: (message: string) => { ctx.logger.warn(`channel-qq: log write failed: ${message}`) },
    })
    const logger = createLogger(this.logSink.sink, 'qq')
    this.log = (line: string) => {
      ctx.logger.info(`channel-qq: ${line}`)
      // 时间戳由 logger 统一生成（本地时间 + 显式偏移，不是 `toISOString()` 的 UTC）。
      logger.line(line)
    }
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    const config = this.config
    this.serviceBridge = await loadCompanionBridge(resolveDshHome(), this.log)
    // 日志封顶：启动时各裁一次（见 adapters/log/logger.ts），失败不影响启动。
    await this.logSink.start()
    // P1-05：文件出站边界（不依赖任何开关）。允许三个根：工作区 + 插件自己的数据目录
    // （表情库/表情包/点歌临时文件在后者里）+ 套件的媒体目录（`<dshHome>/media/…`，media 与
    // expression 的产物都落在这里，且那个位置是群聊侧「只许从 home/media 发图」定的，不能挪）。
    // 少这个根，模型拿着正确绝对路径也会被「不在允许的目录里」拒掉（2026-11-07 实测）。
    // 它仍然是一个**目录**边界，不是关掉校验：三个根之外照样拒。
    configureFileBoundary({
      roots: [config.workspacePath, path.join(resolveDshHome(), 'channel-qq'), path.join(resolveDshHome(), 'media')]
        .filter((item): item is string => typeof item === 'string' && item !== ''),
    })
    // P2.5-3A-4 补水：找 runtime/foundation 的 agenda 服务。找不到就**诚实降级**（提醒照建、
    // 但没有日程绑定，工具返回里会写明），绝不假装绑定了。
    // **终审 round4 C4**：探到就注入，同时登记**惰性解析器**——foundation 常常比我们晚发布，
    // 只在启动探一次的话之后永远接不上；提醒那边每次用到都会重新问一次（见 `liveSeams`）。
    const agenda = this.resolveAgendaPort()
    configureAgendaPort(agenda)
    configureAgendaProbe(() => this.probeAgendaPort(), (line) => { this.log(line) })
    this.log(agenda === null
      ? 'reminders: 启动时没有 agenda 服务 → 提醒先不与日程绑定；之后每次用到会重新探测（发布了就自动接上）'
      : 'reminders: agenda 服务已就绪 → 提醒会绑定 occurrence 并在发送前 CAS（每次用到时重新探测）')
    // P1-05：admins 为空时"私聊代发群消息"会被边界拒（没有主人可授权），而且访问审批、
    // 后台命令也一并不通——这是配置缺失，不是安全特性，启动时喊一声。
    if (config.admins.length === 0) {
      this.log('安全：admins 是空的。访问审批/后台命令/私聊代发群消息都会不可用；请在后台设置主人 QQ。')
    }
    this.log(`starting (mode=${config.connection.mode}, url=${config.connection.url}, selfId=${config.selfId}, admin=${config.admin.enabled ? config.admin.port : 'off'})`)
    const sections = new SectionHost(this.environment())
    this.sections = sections
    // 先交出卸载器再装载：任何一段挂不上时，已经挂上的段仍会被逆序卸干净。
    yield async () => {
      this.toolGate?.stop()
      await sections.disposeAll()
    }
    await sections.mountAll(SECTION_PLUGINS)
    // 工具闸门（policy.v2 / tools.v2）：都默认关 ⇒ 这里一个监听器都不注册。
    await this.syncToolGate()
    // 全部装配完成后再按装载顺序跑 start 钩子：client.start → reattachAll →
    // scheduler.start → admin.start（与原实现一致）。
    await sections.startAll()
    // P2.5-3B 前置：contact 装配完之后，把分享入口发布到宿主 ctx（三档回退 + 日志，
    // 失败不拖垮挂载）。必须在 mountAll/startAll 之后——那之前 contactShare 还没 provide。
    const submit = (input: Parameters<SharePort['submitShareCandidate']>[0]) => {
      const current = sections.get('contactShare')
      if (!current) return Promise.resolve({ ok: false, code: 'share-port-unavailable' })
      return current.submitShareCandidate(input)
    }
    const share = { submitShareCandidate: submit, submitShare: submit }
    this.publishSharePort(share)
    const unpublish = this.serviceBridge?.publish('companionContactShare', share, {
      ready: () => this.ctx.fiber.state === 2 && sections.get('contactShare') !== undefined,
    })
    yield () => { unpublish?.() }
    yield installFollowupContext(this.ctx, () => sections.get('contact')?.status().candidates ?? [], config.admins[0], () => config.contact.adaptiveFollowUp !== false, this.log)
  }

  /**
   * Apply a config change to the running process（P5.2）。
   *
   * The panel has already merged the patch into the live config and written it
   * to disk before this runs; only the sub-plugins that declared the touched
   * dot-paths in their `watches` do anything. Returns one human-readable line
   * per action, shown in the panel's save notice.
   */
  async applyEffects(patch: Record<string, unknown>): Promise<string[]> {
    const notes = this.sections === null ? [] : await this.sections.reloadAffected(patch)
    // policy.v2 / tools.v2 可能刚被翻动：闸门的装/卸跟着开关走（幂等）。
    await this.syncToolGate()
    return notes
  }

  /**
   * 工具闸门（P6c `policy.v2` / P6d `tools.v2`）：把 `tools/pre-execute` /
   * `tools/post-execute` 挂上宿主。
   *
   * **P1-05 起它是常驻的**：闸门里带着"出站边界"（群开关 / 私聊越权 / 文件收件人），
   * 那一段不受任何开关影响，所以不能再"两个开关都关着就一个监听器都不挂"。
   * policy.v2 / tools.v2 各自的判据仍然只看自己的开关（`switches`，见 gate.ts）——
   * 常驻只是让边界总有机会跑，不是把策略表一起打开。
   */
  private async syncToolGate(): Promise<void> {
    if (this.toolGate === null) {
      const bundle = await loadSignatureBundle(this.log)
      this.toolGate = new ToolGateController({
        hooks: createToolGateHooks({
          trustOf: (sessionId) => turnTrust.get(sessionId),
          guardText: (reasonKey) => this.guardText(reasonKey),
          workspacePath: () => this.config.workspacePath,
          sendGuard: bundle === null ? null : new SendSignatureGuard(bundle.output),
          // P1-05：出站边界的配置来源（常驻；与 policy.v2 无关）。
          boundary: () => this.config,
          // 出站 URL 安检：checker 走协议端的 check_url_safely（协议端没连上时查不到，留空缓存）。
          urlGuard: new UrlSafetyGuard(async (url) => {
            try {
              return await platformApiRef.api?.checkUrlSafely(url) ?? null
            } catch {
              return null
            }
          }),
          switches: {
            policyOn: () => policyEnabled(this.config),
            toolsOn: () => toolsV2Enabled(this.config),
            admins: () => this.config.admins,
          },
          log: this.log,
        }),
        install: (hooks) => installToolGate(this.ctx, hooks, this.log),
        log: this.log,
      })
    }
    this.toolGate.sync(true)
  }

  /**
   * 把 contact 的分享入口发布到**宿主 ctx**（P2.5-3B 前置）。
   *
   * 为什么必须发布：contact 的服务原来只进自己的 ServiceBag（per-section），到不了 DSH ctx，
   * foundation 的 `contactSharePort()` 用 `ctx.get('companionContactShare') ?? ctx.get('companionContact')`
   * 永远取不到，只能退化成没人读的 JSONL sink —— 分享链消费端 0% 就是这么来的。
   *
   * 三档回退（与 agenda 的做法一致）：`ctx.provide(name, value)` → `ctx.set(name, value)` →
   * 属性赋值。**走哪档都记一行日志**；三档全失败也只记日志，**不拖垮挂载**（宿主可能没有
   * 对应 API，但 QQ 插件自己的功能不受影响）。
   *
   * 同时给 `companionContact` 别名：foundation 的探测是 `??`，两个都有更稳。
   * 注意发布出去的对象**只有** `submitShare` / `submitShareCandidate` 两个方法，不是整个 contact 服务。
   */
  private publishSharePort(port: SharePort | undefined): void {
    if (port === undefined) {
      this.log('share: 没有 contact 分享端口（contact 段未挂载）→ 宿主拿不到分享入口')
      return
    }
    // 两个名字都发：foundation 的探测是 `ctx.get('companionContactShare') ?? ctx.get('companionContact')`，
    // 两个都有更稳；发布出去的对象只有 `submitShare` / `submitShareCandidate`，不是整个 contact 服务。
    for (const name of ['companionContactShare', 'companionContact']) {
      const tier = publishServiceSafely(this.ctx, name, port, (line) => { this.log(line) })
      // 一行结论：走了哪一档 + `ctx.get` 能不能回读到。**后者才是"宿主真的拿得到"**
      // （`ctx.set` / 属性赋值在有些 cordis 版本上写得到但读不到）。
      const readable = verifyPublished(this.ctx, name)
      this.log(`share: ${name} 发布档=${tier}，ctx.get 回读=${readable ? '命中' : '未命中'}`)
    }
  }
  /**
   * 取 agenda 服务（P2.5-3A-4 补水）。**取不到就是 null**，调用方按诚实降级处理。
   *
   * 探测顺序（**首选必须是 `companionAgenda`**）：foundation 的惯例是**小驼峰**服务名
   * （它自己 `ctx.get('companionMemory')`、`ctx.get('companionContactShare')`），
   * 所以 runtime 侧 `ctx.provide('companionAgenda', agendaPort)` 才是正常路径；
   * 其余三个是历史候选/兜底，留着不吃亏。**首选错了就永远取不到**，所以顺序是承重的。
   *
   * 用 `ctx.get()`（可选查询）：宿主没装这个服务时返回 undefined，不会像属性访问那样抛
   * "cannot get property without inject"（2026-10-18 上线时踩过）。
   * 命中哪一路会打日志，排查"为什么没绑上日程"时先看这一行。
   */
  private resolveAgendaPort(): AgendaPort | null {
    return this.probeAgendaPort().port
  }

  /**
   * **探测 agenda 端口，并把"为什么没有"分清楚**（round7）。
   *
   * 以前所有失败都折成 `null` ⇒ 三层含义被压成一层：*没装*、*装了但是旧版（能力不全）*、
   * *探测本身抛错*。后两种被当成"没装"会让 **CAS 直接放行**，已绑定 occurrence 的提醒就绕过了校验。
   *
   * 用 `ctx.get()`（可选查询）：宿主没装这个服务时返回 undefined，不会像属性访问那样抛
   * "cannot get property without inject"（2026-10-18 上线时踩过）。
   */
  private probeAgendaPort(): AgendaProbe {
    // 候选解析逻辑抽到 `agenda-seam.ts::probeAgendaCandidates`，这样测试能走**同一条代码路径**
    // （round8 的要求：不许用测试里另写的假 resolver 冒充"真实装配"）。
    return probeAgendaCandidates((name) => this.ctx.get(name) ?? (name === 'companionAgenda' ? this.serviceBridge?.resolve(name) : null), (line) => { this.log(line) })
  }

  /** reason key → 人格包里的拒绝文案；缺一段文案时退回功能性说明（绝不因此拦断对话）。 */
  private guardText(reasonKey: string): string {    const template = guardTemplateKey(reasonKey)
    const pack = this.sections?.get('persona')?.pack
    if (template !== null && pack !== undefined) {
      try {
        return pack.render(template)
      } catch {
        // 人格包缺这一段：用下面的通用说明兜底（reason key 照常带出，便于排查）。
      }
    }
    return `【策略】这个动作在当前回合被拦下了（${reasonKey}）。换个合规的做法，或先把情况告诉主人。`
  }

  /** 子插件能看到的全部世界（契约见 `features/plugin-kit.ts`）。 */
  private environment(): SectionHostEnv {
    return {
      config: this.config,
      dshHome: resolveDshHome(),
      log: this.log,
      resources: this.resources,
      bridge: this.bridge(),
      scope: async (plugin, host) => await this.mountOne(plugin, host),
    }
  }

  /** 宿主能力 → 结构化接缝；`ctx` 的宿主形状只出现在这个文件里。 */
  private bridge(): HostBridge {
    return {
      toolHost: () => this.ctx,
      tagContext: () => this.ctx,
      agentGateway: () => (this.gateway ??= createAgentGateway(this.ctx, this.log)),
      presetRegistry: () => presetRegistry(this.ctx),
      agentRegistry: () => agentRegistry(this.ctx),
      // 技能：provider 注册与 `/name` 触发都在适配器里接宿主；
      // 宿主没装 skill 服务时 install 返回 undefined，技能功能降级但后台不挂。
      skillsHost: () => ({
        install: (provider, trigger, log) => installSkills(this.ctx, provider, trigger, log),
      }),
      // 会话换血看门狗：tokenMeter 的估算 + 路由模型声明的窗口。
      sessionSize: () => createSessionSizeProbe(this.ctx),
      usage: () => createUsageProbe(this.ctx),
      toolStats,
      runtimeFacts: async () => await readRuntimeFacts(this.ctx),
      providersSurface: () => createProvidersSurface({
        // settings / credentials 用 get（可选查询）：宿主没装这两个服务时整页降级，
        // 但不能拦启动——属性访问（ctx.settings）要求先 inject，没声明会直接抛
        // "cannot get property without inject"（2026-10-18 上线时踩过）。
        settings: this.ctx.get('settings'),
        credentials: this.ctx.get('credentials'),
        agentDefaultModel: this.ctx.agentDefaultModel,
      }),
      logHostError: (message: string) => { this.ctx.logger.error(message) },
      reloadSections: async (patch: Record<string, unknown>) => await this.applyEffects(patch),
    }
  }

  /** 一个子插件 = 一个 cordis fiber；卸载器（fiber.dispose）交回 SectionHost。 */
  private async mountOne(plugin: SubPlugin, host: SubHost): Promise<Dispose> {
    const fiber = this.ctx.plugin({
      name: `qq-${plugin.name}`,
      apply: (_inner: Context, _config: QQChannelConfig) => plugin.apply(host),
    }, this.config)
    await fiber
    return () => fiber.dispose()
  }
}
