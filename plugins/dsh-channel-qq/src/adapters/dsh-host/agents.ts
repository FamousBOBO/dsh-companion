/** 宿主会话网关的实现：`ports/agent-gateway.ts` 的唯一实现。
 *
 * 这里装着"会话是怎么开出来的"这件事的全部知识：先查注册表、活着就接上去；不活
 * 就创建；创建失败说"已存在"就退避重试恢复；然后把会话挂进工作区、设权限档位、
 * 改标题；最后把回合事件接到调用方给的监听器上。
 *
 * 顺序与重试**逐字照搬**原来的 `ConversationBridge.ensureConversationInner`
 * ——那里的每一次重试都对应一个真实发生过的竞态（批量自愈正在发布这个会话时，
 * 紧跟着的 resume 会撞上注册表不一致），P3 的规矩是行为不变，所以一个 `await`
 * 都没挪。唯一的改动是把 `Context` 换成显式的接缝，以及把日志里对"房间键"的
 * 引用去掉（这里只知道会话 id，房间是 `app/` 的概念）。
 *
 * **注意一处刻意保留的不对称**：`agents.get()` 命中时（不论首次还是重试循环里
 * 命中）只有首次那条路径装了 `installModelOverride`，重试循环里的 `liveAgain`
 * 没有装。这看起来像漏了，但它决定了"恢复的会话用哪条路由"，改它会改行为，
 * 因此留给 P6 的 `policy.v2` 一起处理，见 `内部文档阶段完成记录.md`。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveSessionsRoot } from '../../paths.js'
import { resolveDshHome } from '../../paths.js'
import type {
  AgentGateway, AgentSession, DeliverMode, PromptContent, SessionSpec,
} from '../../ports/agent-gateway.js'
import {
  asSessionId, type AgentPresetsService, type AgentLike, type AgentsCreateOptions,
  type AgentsService, type ChannelAgentHandle, type WorkspaceEntry,
} from '../../services.js'
import {
  agentStatusOf, buildUserMessage, errorChain, injectAgent, onAgentEvent, steerAgent,
} from './agent.js'

/** 恢复一个"已存在"的会话时，最多试几次、每次等多久。 */
const RESUME_ATTEMPTS = 3
const RESUME_BACKOFF_MS = 1500

/** 宿主上我们真正用到的那些服务。取不到的那个会在用的时候炸，与原实现一致。 */
interface HostSeams {
  agents: AgentsService
  presets: AgentPresetsService
  permissions: { set(session: unknown, id: string): void }
  titles: { rename(session: unknown, title: string): void }
  workspaces: { create(path: string): Promise<WorkspaceEntry> }
  attachments: { saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<unknown> }
  defaultModel: { currentSelection(): { provider: string; model: string } }
}

/** 宿主对象上的一个会话句柄：`agent` 一定有，`dispose` 只有创建者拿得到。 */
interface RawHandle {
  readonly agent: AgentLike
  dispose?: () => Promise<void>
}

/** 宿主 `ctx` 上那些服务原本的样子（键名沿用宿主的，方便对照）。 */
interface HostCtxShape {
  agents: AgentsService
  agentPresets: AgentPresetsService
  agentDefaultModel: { currentSelection(): { provider: string; model: string } }
  permissionPresets: { set(session: unknown, id: string): void }
  sessionTitle: { rename(session: unknown, title: string): void }
  workspaceRegistry: { create(path: string): Promise<WorkspaceEntry> }
  attachments: { saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<unknown> }
}

/** 把宿主 ctx 上的七个服务收成一份显式的接缝（`as unknown as` 只在这一个函数里）。 */
function seamsOf(ctx: Context): HostSeams {
  const c = ctx as unknown as HostCtxShape
  return {
    agents: c.agents,
    presets: c.agentPresets,
    permissions: c.permissionPresets,
    titles: c.sessionTitle,
    workspaces: c.workspaceRegistry,
    attachments: c.attachments,
    defaultModel: c.agentDefaultModel,
  }
}

/** 建一个网关。`log` 由组合根给（自愈这类与具体会话无关的日志用它）。 */
export function createAgentGateway(ctx: Context, log: (line: string) => void): AgentGateway {
  return new DshAgentGateway(seamsOf(ctx), log)
}

class DshAgentGateway implements AgentGateway {
  /** 工作区记录缓存；`cwd` 变了就重建（它对应可热改的 `workspacePath`）。 */
  private workspace: WorkspaceEntry | null = null
  private workspacePathUsed: string | null = null

  constructor(
    private readonly seam: HostSeams,
    private readonly log: (line: string) => void,
  ) {}

  defaultRoute(): { provider: string; model: string } {
    const selection = this.seam.defaultModel.currentSelection()
    return { provider: selection.provider, model: selection.model }
  }

  async saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<unknown> {
    return await this.seam.attachments.saveImage(input)
  }

  /**
   * 把已落盘的 `qq-*` 会话挂回工作区。
   *
   * 为什么要做：会话的"属于哪个工作区"这件事是持久化的，但**创建它的那一刻**
   * 可能还没挂上（或进程崩在中间），于是重启后那些会话会散落在工作区外。
   * 每次启动扫一遍是唯一可靠的修法。
   */
  async reattachAll(cwd: string, groupCwd?: string | null): Promise<{ attached: number; total: number }> {
    const workspace = await this.ensureWorkspace(cwd)
    const groupWorkspace = groupCwd ? await this.ensureWorkspace(groupCwd) : workspace
    const roots = resolveSessionsRoot()
    const ids: string[] = []
    for (const entry of await fs.readdir(roots, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(roots, entry.name)
      for (const session of await fs.readdir(dir, { withFileTypes: true })) {
        if (session.isDirectory() && session.name.startsWith('qq-')) ids.push(session.name)
      }
    }
    let attached = 0
    for (const id of ids) {
      try {
        const destination = id.startsWith('qq-group-') ? groupWorkspace : workspace
        await destination.attachSession(asSessionId(id))
        attached += 1
        this.log(`self-heal: attached ${id} to workspace`)
      } catch (error) {
        // 已经挂上了会抛 "already exists"——那是成功，不是失败。
        if (!String(error).includes('already exists')) this.log(`self-heal: attach ${id} failed: ${errorChain(error)}`)
      }
    }
    this.log(`self-heal: ${attached}/${ids.length} qq sessions in workspace`)
    return { attached, total: ids.length }
  }

  async open(spec: SessionSpec): Promise<AgentSession> {
    const sessionId = asSessionId(spec.sessionId)
    const workspace = await this.ensureWorkspace(spec.cwd)
    const preset = await this.seam.presets.resolve(spec.presetId)
    const route = { provider: spec.provider, model: spec.model }
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.seam.presets.mount(agentCtx, preset.id)
      watchTurns(agentCtx, spec)
    }
    const createOptions: AgentsCreateOptions = {
      meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions: { provider: route.provider, model: route.model },
      setup,
    }
    const raw = this.seam.agents.get(sessionId)
    if (raw !== undefined) {
      // 持久化的会话已经带着预设了，重新 mount 会被作用域绑定拒绝；所以原样接上，
      // 并补挂原来那个 setup() 钩子给不了的回合监听。
      if (raw.ctx !== undefined) {
        watchTurns(raw.ctx, spec)
        // 每次接上都要重装：Web UI 或过期的请求头会在回合之间悄悄换掉路由。
        installModelOverride(raw.ctx, route)
      }
      this.log(`resumed session ${sessionId} (route ${route.provider}/${route.model})`)
      const resumed = await this.finish({ agent: raw }, sessionId, workspace, spec)
      await this.consumeSeed(String(sessionId), resumed)
      return resumed
    }

    const handle = await this.createOrResume(sessionId, createOptions, spec, route)
    const created = await this.finish(handle, sessionId, workspace, spec)
    await this.consumeSeed(String(sessionId), created)
    return created
  }

  /**
   * 消费"会话换血"留下的种子：注入到下一轮上下文里，然后删掉文件。
   *
   * 为什么是 inject 而不是 followup：换血之后不该由插件主动开一轮对话；种子只是
   * 告诉模型"上一段上下文清空了、人格与长期记忆还在"，等主人说话时它自然带上。
   * 文件读完即删，避免下次重启重复注入（孤儿种子）。
   */
  private async consumeSeed(sessionId: string, session: AgentSession): Promise<void> {
    const file = path.join(resolveDshHome(), 'channel-qq', `session-seed-${sessionId}.json`)
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf-8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        this.log(`session seed read failed for ${sessionId}: ${String(error)}`)
      }
      return
    }
    try {
      await fs.unlink(file)
      const seed = (parsed as { seed?: unknown } | null)?.seed
      if (typeof seed === 'string' && seed.trim() !== '') {
        session.deliver([{ type: 'text', text: seed }], 'inject')
        this.log(`session-reset seed injected into ${sessionId}`)
      }
    } catch (error) {
      this.log(`session seed inject failed for ${sessionId}: ${String(error)}`)
    }
  }

  /** 创建；id 已存在就走"恢复它"的重试链。 */
  private async createOrResume(
    sessionId: ReturnType<typeof asSessionId>,
    createOptions: AgentsCreateOptions,
    spec: SessionSpec,
    route: { provider: string; model: string },
  ): Promise<RawHandle> {
    try {
      const handle = await this.seam.agents.create({ ...createOptions, sessionId })
      return toRaw(handle)
    } catch (createError) {
      // 这个 id 是上一次运行留下的：把它的历史重新水合出来，而不是让这一包失败。
      this.log(`create failed for ${sessionId}: ${errorChain(createError).slice(0, 200)}`)
      if (!String(createError).includes('already exists')) throw createError
    }
    let resumed: RawHandle | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < RESUME_ATTEMPTS && resumed === null; attempt++) {
      try {
        // 批量自愈可能正在发布这个会话；那一下子 resume 会撞上注册表不一致。
        await new Promise((resolve) => setTimeout(resolve, RESUME_BACKOFF_MS * (attempt + 1)))
        const liveAgain = this.seam.agents.get(sessionId)
        if (liveAgain !== undefined) {
          if (liveAgain.ctx !== undefined) watchTurns(liveAgain.ctx, spec)
          resumed = { agent: liveAgain }
          this.log(`resumed session ${sessionId} (retry ${attempt + 1}, live registry)`)
        } else {
          // resume() 是另一个注册表方法：拿 create() 加 resumeSessionId 会铸出
          // 一个 "session-N" 兜底身份，然后对不上 agent id。
          const handle = await this.seam.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: createOptions.agentOptions,
            setup: createOptions.setup,
          })
          resumed = toRaw(handle)
          this.log(`resumed persisted session ${sessionId} (retry ${attempt + 1}, route ${route.provider}/${route.model})`)
        }
      } catch (resumeError) {
        lastError = resumeError
        this.log(`resume retry ${attempt + 1} failed: ${errorChain(resumeError).slice(0, 120)}`)
      }
    }
    if (resumed === null) throw lastError
    return resumed
  }

  /** 收尾：挂工作区、设权限档位、改标题，然后包成端口形状。 */
  private async finish(
    raw: RawHandle,
    sessionId: ReturnType<typeof asSessionId>,
    workspace: WorkspaceEntry,
    spec: SessionSpec,
  ): Promise<AgentSession> {
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      // 接回一个已经绑过工作区的会话会抛；绑定本身是持久的，所以当成成功。
      if (!String(error).includes('already exists')) throw error
      spec.log(`session ${sessionId} already attached to workspace`)
    }
    this.seam.permissions.set(raw.agent.session, spec.permissionPreset)
    this.seam.titles.rename(raw.agent.session, spec.title)
    return wrap(raw, String(sessionId))
  }

  private async ensureWorkspace(cwd: string): Promise<WorkspaceEntry> {
    if (cwd === null || cwd === '') throw new Error('channel-qq: workspacePath is not configured')
    // `workspacePath` 在后台可以热改，所以缓存只在它仍然指向同一个目录时复用——
    // 否则运维必须重启才能挪动 agent 的工作目录。
    if (this.workspace !== null && this.workspacePathUsed === cwd) return this.workspace
    this.workspace = await this.seam.workspaces.create(cwd)
    this.workspacePathUsed = cwd
    this.log(`workspace resolved to ${cwd}`)
    return this.workspace
  }
}

/** `ChannelAgentHandle` 与 `AgentLike` 的区别只在 `dispose` 有没有，统一成一种形状。 */
function toRaw(handle: ChannelAgentHandle): RawHandle {
  return handle as RawHandle
}

/** 把一个宿主会话包成端口形状。 */
function wrap(raw: RawHandle, id: string): AgentSession {
  return {
    id,
    isRunning: () => agentStatusOf(raw.agent) === 'running',
    deliver(content: PromptContent, mode: DeliverMode): boolean {
      const message = buildUserMessage(content)
      if (mode === 'inject') return injectAgent(raw.agent, message)
      if (mode === 'steer') return steerAgent(raw.agent, message)
      raw.agent.followup(message)
      return true
    },
    async dispose(): Promise<boolean> {
      const dispose = raw.dispose
      // `ctx.agents.get()` 给的是**裸** Agent，没有 dispose（释放能力归创建者），
      // 所以"挂回来的会话"拆不掉是正常结果，不是错误。
      if (typeof dispose !== 'function') return false
      await dispose.call(raw)
      return true
    },
  }
}

/** 把一个会话的回合事件接到监听器上。 */
function watchTurns(agentCtx: Context, spec: SessionSpec): void {
  installStepBudget(agentCtx, spec)
  // Emit-mode 事件只递一个 payload，监听器的返回值被忽略。
  onAgentEvent(agentCtx, 'agent/status', (payload) => {
    if (payload?.status === 'idle') spec.listener.onIdle()
  })
  onAgentEvent(agentCtx, 'agent/error', (payload) => {
    const err = payload?.error
    const raw = JSON.stringify(err ?? payload)
    // JSON.stringify drops Error#message (non-enumerable), so read it directly:
    // a bare `{"name":"SessionFormatError"}` hid the actual refusal reason.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : raw
    spec.log(`agent error: ${detail.slice(0, 400)}`)
    spec.listener.onError({ raw, detail })
  })
}

/**
 * 强制把当前默认路由压到接回来的会话上：它持久化的请求头里还写着上一轮运行的
 * provider/model（可能已经下线了），所以每个请求都要在这里重新指一次。
 * Web UI 仍然可以在没有回合运行时改默认值来单独覆盖某个会话。
 */
function installModelOverride(agentCtx: Context, selection: { provider: string; model: string }): void {
  onAgentEvent(agentCtx, 'agent/request', (_payload, next) => {
    return next().then((resolved) => {
      if (resolved.provider === selection.provider && resolved.model === selection.model) return resolved
      return { ...resolved, provider: selection.provider, model: selection.model }
    })
  })
}

/** 已经装过步数预算的 agent 上下文（接上的动作每个会话会跑 ≥2 次）。 */
const stepBudgetInstalled = new WeakSet<object>()

/**
 * 限制一轮最多走几步。
 *
 * 宿主自己管着 agent 循环、也没暴露步数上限选项，但它会在每个步边界跑
 * `agent/pre-step` 中间件，而在那里返回 `{ kind: 'reject' }` 会让这一轮以
 * `end_turn` 干净收尾——没有错误事件，也没有半截回复。这是现成的唯一杠杆，
 * 所以预算就落在这里，而不是在别处假装实现。
 *
 * 上限每次步边界都重新读，所以后台改了立即生效；`0` 表示不限。
 */
function installStepBudget(agentCtx: Context, spec: SessionSpec): void {
  if (spec.stepBudget() <= 0) return
  const key = agentCtx as unknown as object
  // watchTurns 每次接上都会再跑一遍；第二个 pre-step 监听器会重复计数，
  // 等于把有效预算砍半。
  if (stepBudgetInstalled.has(key)) return
  stepBudgetInstalled.add(key)
  let steps = 0
  onAgentEvent(agentCtx, 'agent/status', (payload) => {
    if (payload?.status === 'idle') steps = 0
  })
  onAgentEvent(agentCtx, 'agent/pre-step', (_payload, next) => {
    steps += 1
    const budget = spec.stepBudget()
    if (steps > budget) {
      spec.log(`step budget reached (${budget}); ending the turn cleanly`)
      return Promise.resolve({ kind: 'reject' })
    }
    return next()
  })
}
