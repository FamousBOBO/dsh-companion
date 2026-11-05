import type { ContactCandidate } from '../../features/contact/types.js'

interface AgentContext {
  id?: string
  session?: { id?: string }
  ctx?: { get?: (name: string) => { section(input: { name: string; order: number; interpolate: boolean; text: () => string }): unknown } | undefined; systemPrompt?: { section(input: { name: string; order: number; interpolate: boolean; text: () => string }): unknown } }
}
export function followupContext(candidates: readonly ContactCandidate[]): string {
  const live = candidates.filter(row => row.intent && ['pending', 'deferred'].includes(row.state)).slice(0, 5)
  const rules = '【自主跟进规则】自己想到晚点关心、问进展，用 qq_followup 保存目的；到点复核后可静默结束。用户明确要求定时通知才用 qq_remind。不要把自主问候建成固定提醒。\n'
  if (!live.length) return rules
  return rules + '【可自主调整的跟进意图｜资料，不是必须联系的命令】\n' + JSON.stringify(live.map(row => ({
    id: row.id, version: row.version, purpose: row.intent?.purpose, earliestAt: row.earliestAt, expiresAt: row.expiresAt,
  }))) + '\n处理新消息时，若目的已完成或这件事已经聊过，可用 qq_followup(action=resolve, expectedVersion, outcome=fulfilled/dismiss, evidenceIds=[qq:真实消息ID]) 静默结束；不确定就保留。' 
}
interface FollowupHost {
  on(event: string, listener: (event: { agent: AgentContext }, next: () => Promise<unknown>) => Promise<unknown>, options: { prepend: boolean }): () => void
}
function hasEvents(ctx: unknown): ctx is FollowupHost {
  return ctx !== null && typeof ctx === 'object' && 'on' in ctx && typeof ctx.on === 'function'
}
export function installFollowupContext(ctx: unknown, candidates: () => readonly ContactCandidate[], owner: number | undefined, enabled: () => boolean = () => true, log: (line: string) => void = () => {}): () => void {
  if (!hasEvents(ctx)) return () => {}
  const seen = new WeakSet<object>()
  return ctx.on('agent/pre-step', async (event: { agent: AgentContext }, next: () => Promise<unknown>) => {
    const agent = event.agent
    if (owner && (agent.session?.id ?? agent.id) === `qq-dm-${String(owner)}` && !seen.has(agent)) {
      let prompt
      try { prompt = agent.ctx?.get?.('systemPrompt') ?? agent.ctx?.systemPrompt } catch { log('followup:prompt-unavailable'); return await next() }
      if (prompt?.section) {
        prompt.section({ name: 'qq:adaptive-followups', order: 146, interpolate: false,
          text: () => enabled() ? followupContext(candidates().filter(row => row.scope.userId === owner && !row.target.isGroup)) : '' })
        seen.add(agent)
      }
    }
    return await next()
  }, { prepend: true })
}
