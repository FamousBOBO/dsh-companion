/** 工具闸门（P6c policy.v2）：执行前裁决、执行后记账、装/卸控制器。
 *
 * 从  拆出（体量棘轮）：闸门与工具注册是两件事，拆开之后
 * register.ts 回到 400 行以内，闸门本身也能独立单测。
 */

import { SESSION_PREFIX, splitRoom } from '../../core/room.js'
import { roomKeyOf, textSentBy, type SendSignatureGuard } from '../../core/guards/output-signatures.js'
import { UrlSafetyGuard } from '../../core/guards/url-safety.js'
import { decideOutbound, type OutboundBoundaryConfig, type OutboundOrigin } from '../../core/outbound-boundary.js'
import { decideToolCall, policyEnabled, type ToolCallFacts } from '../../app/policy/tool-policy.js'
import { tierDenyFor } from '../tools-v2/index.js'
import type { Trust } from '../../core/trust.js'
import { approvalEnabled } from '../approval/store.js'
import { selfHarmGuard } from '../../core/approval/self-harm.js'
import type { ToolHost } from '../../adapters/dsh-host/tools.js'

// ── 工具闸门（P6c policy.v2）：回调与装/卸控制器 ─────────────────────────────
//
// 宿主监听器在 `adapters/dsh-host/services.ts` 的 `installToolGate`；根服务只在
// `policy.v2` 打开时安装。这里放"装没装"的状态与两个回调的组装——旧总闸门
// （上面 `assertDangerous`）与它共用同一个问题："这次调用能不能执行"。

/** "闸门真的挂上了吗"——旧总闸门据此判断能不能把裁决权让给信任表。 */
let toolGateArmed = false

export function setToolGateArmed(armed: boolean): void { toolGateArmed = armed }
export function isToolGateArmed(): boolean { return toolGateArmed }

export interface ToolGateCall {
  readonly name: string
  readonly args: unknown
  /** `exec.agent.id`——我们的会话 id 形如 `qq-group-1000000003`。 */
  readonly agentId: string | undefined
}

export type ToolGateDecision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'deny'; readonly reason: string }

export interface ToolGateHooks {
  /** 执行前裁决（`tools/pre-execute`）。 */
  decide(call: ToolGateCall): ToolGateDecision
  /** 执行后记账（`tools/post-execute`）：只记**真的发出去**的文本发送。 */
  record(call: ToolGateCall, ok: boolean): void
}

export interface ToolGateDeps {
  readonly trustOf: (sessionId: string) => Trust | undefined
  /** reason key → 面向模型的拒绝文案（人格包渲染，根服务提供）。 */
  readonly guardText: (reasonKey: string) => string
  readonly workspacePath: () => string | null
  readonly sendGuard: SendSignatureGuard | null
  /** 出站 URL 安检（渐进式缓存）；没装就是 undefined。 */
  readonly urlGuard?: UrlSafetyGuard
  /**
   * 出站边界（P1-05）要的配置：群开关、房间覆盖、主人名单。
   *
   * 这一段**不受任何开关约束**（下面 `decide` 里排在最前面）：它回答的是
   * "这个回合有没有资格动这个群/发这个文件"，和 policy.v2 的信任分级是两件事。
   */
  readonly boundary?: () => OutboundBoundaryConfig
  /** 两套规则的开关（P6d）：档位只看 toolsOn、签名与放行表只看 policyOn；缺省 = 旧行为（policyOn=true、toolsOn=false）。 */
  readonly switches?: {
    readonly policyOn?: () => boolean
    readonly toolsOn?: () => boolean
    readonly admins?: () => readonly number[]
  }
  readonly log: (line: string) => void
}

export function createToolGateHooks(deps: ToolGateDeps): ToolGateHooks {
  const factsOf = (call: ToolGateCall): ToolCallFacts => {
    const sessionId = call.agentId ?? ''
    const isQqSession = sessionId.startsWith(SESSION_PREFIX)
    return {
      // 认不出归属的调用按 member 兜底——拿不到信任时最保守（不认 master）。
      trust: isQqSession ? deps.trustOf(sessionId) ?? 'member' : 'member',
      tool: call.name,
      args: isRecord(call.args) ? call.args : {},
      isQqSession,
      isGroupTurn: isQqSession ? groupTurnOf(sessionId) : true,
      workspacePath: deps.workspacePath(),
    }
  }
  return {
    decide(call) {
      // 会把自己弄断的命令、以及 P1-05 的**出站边界**：都在两个开关之前判，
      // 保证 policy.v2 / tools.v2 关着时这些硬边界照样生效。
      const preflight = preflightDenial(deps, call)
      if (preflight !== null) return { kind: 'deny', reason: preflight }
      const facts = factsOf(call)
      // tools.v2：会话档位（只看自己的开关；关着时这一段一个字节都不跑）。
      // 第三参 = **本回合**的信任档：事件书（P6f）的回合发进群会话，靠 id 前缀
      // 判不出"系统在做事"，只有信任账本知道（拿不到账本时为 null → 退回 id 判定）。
      if (deps.switches?.toolsOn?.() === true) {
        const tierKey = tierDenyFor(call, deps.switches.admins?.() ?? [], deps.trustOf(call.agentId ?? '') ?? null)
        if (tierKey !== null) {
          deps.log(`tools.v2: denied ${call.name} (session=${call.agentId ?? '?'}) reason=${tierKey}`)
          return { kind: 'deny', reason: deps.guardText(tierKey) }
        }
      }
      if (deps.switches?.policyOn?.() === false) return { kind: 'pass' }
      const blocked = checkSendSignature(deps, call, facts)
      if (blocked !== null) return { kind: 'deny', reason: blocked }
      const urlBlocked = checkUrlSafety(deps, call, facts)
      if (urlBlocked !== null) return { kind: 'deny', reason: urlBlocked }
      const verdict = decideToolCall(facts)
      if (verdict.kind === 'allow') return { kind: 'pass' }
      deps.log(`policy: denied ${call.name} (trust=${facts.trust}) reason=${verdict.reasonKey}`)
      return { kind: 'deny', reason: deps.guardText(verdict.reasonKey) }
    },
    record(call, ok) {
      if (!ok) return
      if (deps.switches?.policyOn?.() === false) return
      const facts = factsOf(call)
      if (!facts.isQqSession) return
      const text = textSentBy(call.name, facts.args)
      if (text === null) return
      if (deps.sendGuard !== null) deps.sendGuard.record(roomKeyOf(facts.args) ?? fallbackRoom(call), text)
      // 发送成功后预热 URL 安检缓存：同一链接下次经过闸门就有判定。
      if (deps.urlGuard !== undefined) void deps.urlGuard.warm(text, Date.now())
    },
  }
}

/**
 * 开关之前的**硬前置**：会把自己弄断的命令（改走审批）+ 出站边界（P1-05）。
 *
 * 两段都必须在 `policy.v2` / `tools.v2` 的开关之前判：前者是"别把自己 restart 掉"，
 * 后者是"这个回合有没有资格动这个群 / 发这个文件"。返回非 null = 拒绝文案。
 */
function preflightDenial(deps: ToolGateDeps, call: ToolGateCall): string | null {
  if (approvalEnabled()) {
    const denied = selfHarmGuard(call.name, call.args)
    if (denied !== null) {
      deps.log(`approval: blocked self-harm command (${call.name})`)
      return denied
    }
  }
  const boundary = checkBoundary(deps, call)
  if (boundary !== null) {
    deps.log(`boundary: denied ${call.name} (session=${call.agentId ?? '?'}) ${boundary}`)
    return boundary
  }
  return null
}

/**
 * 出站边界（P1-05）：群开关、私聊越权、文件收件人。**永远运行**，与两个开关无关。
 *
 * 来源（origin）从会话 id 推：`qq-dm-10001` → 私聊回合、对方 10001；`qq-group-<号>` →
 * 那个群的回合；认不出（后台注入/定时任务）时 `null` = 系统回合（`decideOutbound` 按
 * system 处理，不是陌生人）。
 */
function checkBoundary(deps: ToolGateDeps, call: ToolGateCall): string | null {
    // QQ outbound checks do not own host filesystem or shell tools.
    if (!call.name.startsWith('qq_')) return null
  if (deps.boundary === undefined) return null
  const args = isRecord(call.args) ? call.args : {}
  const verdict = decideOutbound({
    tool: call.name,
    args,
    origin: originOf(call.agentId),
    config: deps.boundary(),
  })
  if (verdict.kind === 'allow') return null
  return `出站边界拒绝了这次调用（${verdict.code}）：${verdict.reason}`
}

/** 会话 id → 回合来源；不是 QQ 会话时 `null`。 */
function originOf(agentId: string | undefined): OutboundOrigin | null {
  if (agentId === undefined || !agentId.startsWith(SESSION_PREFIX)) return null
  const room = splitRoom(agentId.slice(SESSION_PREFIX.length))
  return room === null ? null : { isGroup: room.isGroup, chatId: room.chatId }
}

/** 出站 URL 安检（D）：缓存里判定危险的链接直接拦（渐进式，见 core/guards/url-safety）。 */
function checkUrlSafety(deps: ToolGateDeps, call: ToolGateCall, facts: ToolCallFacts): string | null {
  const guard = deps.urlGuard
  if (guard === undefined || !facts.isQqSession) return null
  const text = textSentBy(call.name, facts.args)
  if (text === null) return null
  const bad = guard.cachedBlock(text, Date.now())
  if (bad === null) return null
  deps.log(`policy: url-safety blocked ${call.name} (${bad})`)
  return deps.guardText('出站安检：这条内容里的链接被 QQ 判定为危险，先别发。')
}

function checkSendSignature(deps: ToolGateDeps, call: ToolGateCall, facts: ToolCallFacts): string | null {
  if (!facts.isQqSession || deps.sendGuard === null) return null
  const text = textSentBy(call.name, facts.args)
  if (text === null) return null
  const room = roomKeyOf(facts.args) ?? fallbackRoom(call)
  const hit = deps.sendGuard.check(room, text)
  if (hit === null) return null
  deps.log(`policy: output signature blocked ${call.name} in ${room} (${hit})`)
  return deps.guardText(hit)
}

function fallbackRoom(call: ToolGateCall): string {
  return `session:${call.agentId ?? 'unknown'}`
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 会话 id → 是不是群回合；解析不出来时按群（更严：好感的私聊豁免拿不到）。 */
function groupTurnOf(sessionId: string): boolean {
  const room = splitRoom(sessionId.slice(SESSION_PREFIX.length))
  return room === null ? true : room.isGroup
}

export interface ToolGateControllerDeps {
  readonly hooks: ToolGateHooks
  /** 实际安装（真实现 = `adapters/dsh-host/services.ts` 的 installToolGate）；装不上返回 null。 */
  readonly install: (hooks: ToolGateHooks) => (() => void) | null
  readonly log: (line: string) => void
}

/** 让"装没装"与 `policy.v2` 保持一致；幂等，关着时一个监听器都不挂。 */
export class ToolGateController {
  private dispose: (() => void) | null = null

  constructor(private readonly deps: ToolGateControllerDeps) {}

  get installed(): boolean { return this.dispose !== null }

  sync(wanted: boolean): void {
    if (wanted === this.installed) return
    if (!wanted) { this.stop(); return }
    const dispose = this.deps.install(this.deps.hooks)
    if (dispose === null) {
      this.deps.log('工具闸门：宿主没有 tools/pre-execute 接缝，闸门未装（高危工具回到旧总闸门）')
      return
    }
    this.dispose = dispose
    setToolGateArmed(true)
    this.deps.log('工具闸门已挂上（tools/pre-execute）')
  }

  stop(): void {
    if (this.dispose === null) return
    const dispose = this.dispose
    this.dispose = null
    setToolGateArmed(false)
    try {
      dispose()
    } catch (error) {
      this.deps.log(`工具闸门：卸载失败：${String(error)}`)
    }
    this.deps.log('工具闸门已卸下')
  }
}

