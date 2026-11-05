/** 技能接缝：把本插件的技能仓库接进宿主的技能注册表与 `/name` 触发点。
 *
 * 宿主的三件套（`skill` / `skill-filesystem` / `tool-skill`）默认在 `dsh-base` 里
 * 挂着，所以这里**不实现发现逻辑**，只做两件事：
 *
 *   1. `registerProvider`：把**全局可见**的技能交给宿主目录（模型能自动看到并
 *      用 `skill` 工具加载）。范围受限的技能不进宿主目录——否则它们的描述会
 *      出现在每个房间的提示词里，`qq_skill` 才是它们唯一入口。
 *   2. `onPreStep`：把用户消息第一行的 `/name` 变成一次加载（宿主只认它自己
 *      provider 里 `user-invocable` 的技能，我们的技能一律标成 user-invocable=false，
 *      由这里按**当前房间**判可见范围后再注入）。
 *
 * 宿主形状只出现在 `adapters/`（R2）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  HostSkillEntry, HostSkillProviderSpec, SkillTriggerHandler, SkillTriggerHit,
} from '../../ports/skills.js'

export type { HostSkillEntry, HostSkillProviderSpec, SkillTriggerHandler, SkillTriggerHit }

/** 我们注册的 provider 名（与宿主的 filesystem provider 区分开）。 */
export const PROVIDER_NAME = 'channel-qq-skills'

/** 优先级：比项目根（100/200）更靠前——后台管理的技能是明确点名要用的。 */
const PROVIDER_RANK = 50

/** `ctx.skills` 的窄形状（只声明用到的方法）。 */
interface SkillsRegistry {
  registerProvider(
    create: (control: { readonly signal: AbortSignal; readonly invalidate: () => void }) => {
      name: string
      list: (options: unknown) => Promise<unknown>
      get: (candidate: unknown, options: unknown) => Promise<unknown>
    },
  ): () => void
}

/** 用户输入里空白分隔的 `/name`（与宿主同一个语法：小写字母数字与连字符）。
 *
 * 为什么不是"只认开头"：入站组包会在用户文字前拼房间指令（几行），所以真正的
 * 用户那句话并不在第一行。宿主自己的实现也是全文扫描 + 词边界。 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$|[，。！？,.!?])/

/** 从这一步的 claimed messages 里取**最后一条**用户输入的文本。 */
function lastUserText(messages: readonly unknown[]): string {
  let text = ''
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const message = raw as { source?: { kind?: unknown }; content?: unknown }
    if (message.source?.kind !== 'user') continue
    if (!Array.isArray(message.content)) continue
    const parts: string[] = []
    for (const block of message.content) {
      if (block !== null && typeof block === 'object') {
        const b = block as { type?: unknown; text?: unknown }
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
    }
    if (parts.length > 0) text = parts.join('\n')
  }
  return text
}

/** 取技能注册表；宿主没装 skill 服务时为 undefined。 */
function registryOf(ctx: Context): SkillsRegistry | undefined {
  return ctx.get('skills') as SkillsRegistry | undefined
}

/**
 * 注册 provider 与 `/name` 触发。
 *
 * @returns 卸载器；宿主没有 skill 服务时返回 `undefined`（功能整体降级，
 *          但后台管理仍然可用——那部分不依赖宿主）。
 */
export function installSkills(
  ctx: Context,
  provider: HostSkillProviderSpec,
  trigger: SkillTriggerHandler,
  log: (line: string) => void,
): (() => void) | undefined {
  const registry = registryOf(ctx)
  if (registry === undefined) {
    log('skills: 宿主没有 skill 服务，本插件的技能只保留后台管理与 qq_skill 工具')
    return undefined
  }
  const handle = registerProvider(registry, provider, log)
  const stopWatch = watchSignature(provider, handle.invalidate, log)
  const stopTrigger = watchTrigger(ctx, trigger, log)
  return () => { stopWatch(); stopTrigger(); handle.dispose() }
}

/** 一个技能在宿主目录里的形状（list/get 共用）。 */
function summaryOf(entry: HostSkillEntry, providerName: string): Record<string, unknown> {
  return {
    name: entry.name,
    description: entry.description,
    ...entry.whenToUse === '' ? {} : { whenToUse: entry.whenToUse },
    invocation: { modelInvocable: true, userInvocable: false },
    source: 'custom',
    provider: providerName,
    rank: PROVIDER_RANK,
    locator: { name: entry.name },
    metadata: {},
  }
}

/** 注册 provider：只交出全局可见的技能。 */
function registerProvider(
  registry: SkillsRegistry,
  provider: HostSkillProviderSpec,
  log: (line: string) => void,
): { dispose: () => void; invalidate: () => void } {
  let invalidate: () => void = () => {}
  try {
    const dispose = registry.registerProvider((control) => {
      invalidate = control.invalidate
      return {
        name: provider.name,
        async list() {
          return (await provider.list()).map((entry) => summaryOf(entry, provider.name))
        },
        async get(candidate: unknown) {
          const name = (candidate as { name?: unknown }).name
          if (typeof name !== 'string') return undefined
          const content = await provider.get(name)
          if (content === null) return undefined
          const match = (await provider.list()).find((entry) => entry.name === name)
          if (match === undefined) return undefined
          return { ...summaryOf(match, provider.name), content }
        },
      }
    })
    log(`skills: 已注册技能 provider "${provider.name}"（rank ${PROVIDER_RANK}）`)
    return { dispose, invalidate: () => invalidate() }
  } catch (error) {
    log(`skills: provider 注册失败：${(error as Error).message}`)
    return { dispose: () => {}, invalidate: () => {} }
  }
}

/** 目录签名的轮询间隔：技能很少，2 秒一次 stat 的成本可以忽略。 */
const SIGNATURE_POLL_MS = 2_000

/**
 * 轮询目录签名并让宿主的目录缓存失效。
 *
 * 为什么需要：宿主按 provider + cwd 缓存完整目录，只有 provider 主动
 * `invalidate()` 才重扫。我们的仓库是普通目录（不是宿主的 skill-filesystem
 * 根），所以后台写完、或有人手工改了文件，宿主都不知道——模型会一直看到
 * 加入第一个技能之前的旧目录。
 */
function watchSignature(
  provider: HostSkillProviderSpec,
  invalidate: () => void,
  log: (line: string) => void,
): () => void {
  if (provider.signature === undefined) return () => {}
  let last: string | null = null
  let busy = false
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const next = await provider.signature!()
      if (last !== null && next !== last) {
        invalidate()
        log('skills: 目录已变化，通知宿主重扫技能目录')
      }
      last = next
    } catch (error) {
      log(`skills: 目录签名读取失败：${(error as Error).message}`)
    } finally {
      busy = false
    }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, SIGNATURE_POLL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** 宿主 `agent/pre-step` 的结构面（该事件由 agent 包 augment，本包没有类型依赖）。 */
interface PreStepContext {
  on(
    event: 'agent/pre-step',
    listener: (event: Record<string, unknown>, next: () => Promise<unknown>) => Promise<unknown>,
  ): () => void
}

/** 挂 `/name` 触发：只有 QQ 会话参与，命中后按当前房间判范围再注入。 */
function watchTrigger(ctx: Context, trigger: SkillTriggerHandler, log: (line: string) => void): () => void {
  const onPreStep = (ctx as unknown as PreStepContext).on.bind(ctx)
  return onPreStep('agent/pre-step', async (event, next) => {
    const decision = await next() as { kind?: string; messages?: unknown[] }
    if (decision.kind === 'reject') return decision
    const agent = event.agent as { id?: unknown } | undefined
    const sessionId = typeof agent?.id === 'string' ? agent.id : ''
    if (!sessionId.startsWith('qq-')) return decision
    const text = lastUserText(Array.isArray(event.messages) ? event.messages : [])
    if (!SKILL_GESTURE.test(text)) return decision
    const hit = await trigger({ sessionId, text }).catch((error: Error) => {
      log(`skills: 触发失败：${error.message}`)
      return null
    })
    if (hit === null) return decision
    const injection = createUserMessage({
      content: [{ type: 'text', text: `<skill_content name="${hit.name}">
${hit.content}
</skill_content>` }],
      // 宿主把 `skill-invocation` 当作一种注入来源；dsh-llm 的静态联合没列它，
      // 这里按结构面转型（只在 adapters 里允许这么做）。
      source: { kind: 'skill-invocation', name: hit.name, form: 'instructions' } as never,
    })
    log(`skills: 触发 ${hit.name}（session=${sessionId}）`)
    return { ...decision, messages: [...(decision.messages ?? []), injection] }
  })
}

/** 导出给测试：从文本里取第一个 `/name`。 */
export function skillGestureName(text: string): string | null {
  const match = SKILL_GESTURE.exec(text)
  return match === null ? null : (match[2] ?? null)
}
