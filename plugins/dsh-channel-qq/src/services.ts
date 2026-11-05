/** Minimal structural views of the harness services this channel consumes.
 *
 * The real declarations come from the harness packages via Cordis declaration
 * merging at runtime; here they are deliberately narrow so the plugin builds
 * against `@deepseek-ai/cordis` alone and cannot grow hidden dependencies on
 * host internals. Shapes mirror the call sites in `packages/webhook/webhook/src/session.ts`.
 */

import type { Context, Service } from '@deepseek-ai/cordis'

export type SessionId = string & { readonly __session: 'SessionId' }
export function asSessionId(value: string): SessionId {
  return value as SessionId
}

/** Content block subset used for prompts and tool render output. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Vision block referencing an attachment saved through ctx.attachments. */
export interface ImageBlock {
  readonly type: 'image'
  readonly attachment: unknown
}

export type PromptBlock = TextBlock | ImageBlock

export interface AgentPresetInfo {
  readonly id: string
}

/** `ctx.agentPresets` — the real registry is `AgentPresetRegistry`; `mount()`
 * inside an agent's setup callback is what binds a preset to it. */
export interface AgentPresetsService {
  resolve(id: string): Promise<AgentPresetInfo>
  mount(agentCtx: Context, id: string): Promise<unknown>
}

/** `ctx.permissionPresets` — capability gating stays harness-owned (its defaults, not ours). */
export interface PermissionPresetsService {
  resolve(id: string): unknown
  set(session: unknown, id: string): void
}

/** `ctx.workspaceRegistry` — durable workspace records; one per channel deployment. */
export interface WorkspaceEntry {
  readonly path: string
  attachSession(sessionId: SessionId): Promise<void>
}

export interface WorkspaceRegistryService {
  create(path: string): Promise<WorkspaceEntry>
}

/** `ctx.agentDefaultModel` */
export interface AgentDefaultModelService {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
  /** 保存默认模型选择（宿主没有 configEditor 时它自己会保持现状——那是宿主的约定）。 */
  saveSelection(next: { provider: string; model: string }): Promise<void>
}

/** `ctx.settings`（dsh-settings 的读写面；只取本插件用到的两个方法）。 */
export interface SettingsService {
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; revision: number; value: unknown }>
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  /** 按路径改设置（本插件只用到 `unset`：删一个供应商）。 */
  mutate(ns: string, ops: Array<{ op: 'unset'; path: string[] }>, expectedRevision?: number): Promise<void>
}

/** `ctx.credentials`（dsh-credentials；ref 运行时就是字符串，credentialRef 只是类型包装）。 */
export interface CredentialsService {
  describe(ref: string): Promise<{ configured: boolean }>
  resolve(ref: string): Promise<{ value?: string } | undefined>
  set(ref: string, value: string): Promise<void>
}

/** `ctx.sessionTitle` */
export interface SessionTitleService {
  rename(session: unknown, title: string): void
}

/** The subset of a live agent the channel needs. `agents.get()` returns this directly. */
export interface AgentLike {
  readonly session: unknown
  /** Agent-plane context; present on live agents, used to remount presets on resume. */
  readonly ctx?: Context
  followup(message: unknown): void
}

/** `agents.create()` wraps the agent in a handle. */
export interface ChannelAgentHandle {
  readonly agent: AgentLike
}

export interface AgentsCreateOptions {
  /** Exact id for a fresh session; mutually exclusive with resumeSessionId. */
  sessionId?: SessionId
  /** Resume existing persisted history under this id instead of creating fresh. */
  resumeSessionId?: SessionId
  signal?: AbortSignal
  meta: { cwd: string; agentPreset: string }
  agentOptions: { provider: string; model: string; maxTokens?: number }
  setup?(agentCtx: Context): Promise<void>
}

/** Resume options: the persisted session id plus per-agent options and setup. */
export interface AgentsResumeOptions {
  resumeSessionId: SessionId
  agentOptions?: { provider: string; model: string; maxTokens?: number }
  setup?(agentCtx: Context): Promise<void>
}

/** `ctx.agents` */
export interface AgentsService {
  create(options: AgentsCreateOptions): Promise<ChannelAgentHandle>
  resume(options: AgentsResumeOptions): Promise<ChannelAgentHandle>
  get(sessionId: SessionId): AgentLike | undefined
}

/** `ctx.tools` */
export interface ToolsService {
  register(definition: Record<string, unknown>): () => void
}

/** `ctx.attachments` — durable image storage for vision prompts. */
export interface AttachmentsService {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentsService
    agentPresets: AgentPresetsService
    agentDefaultModel: AgentDefaultModelService
    permissionPresets: PermissionPresetsService
    settings: SettingsService
    credentials: CredentialsService
    sessionTitle: SessionTitleService
    workspaceRegistry: WorkspaceRegistryService
    tools: ToolsService
    channelQQ: Service
  }
}

/** Attribution for a channel-injected user message.
 *
 * `kind` must not be `plugin`: the v4 session format refuses that value
 * ("retired plugin wrappers"). `user` is what the harness's own channel
 * producers send, and the extra field keeps our attribution. */
export interface FollowupSource {
  readonly kind: 'user'
  readonly plugin: string
}
