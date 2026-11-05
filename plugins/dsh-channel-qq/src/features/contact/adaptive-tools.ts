import { createHash } from 'node:crypto'
import { registerSpecs, type ToolRunContext } from '../../adapters/dsh-host/tools.js'
import { turnTrust } from '../../core/trust.js'
import type { SubHost } from '../plugin-kit.js'
import type { ContactStore } from './store.js'
import type { ContactCandidate, ContactService } from './types.js'
import { editAdaptive } from './adaptive-tools-state.js'

function owned(host: SubHost, context?: ToolRunContext): { owner: number; room: string; session: string } {
  const owner = host.config.admins[0]
  const session = `qq-dm-${String(owner)}`
  const trust = turnTrust.get(session)
  if (!owner || context?.agentId !== session || (trust !== 'master' && trust !== 'system')) throw new Error('followup:owner-session-required')
  return { owner, room: `dm-${String(owner)}`, session }
}
function time(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?$/.test(value)) return NaN
  return Date.parse(value.replace(' ', 'T'))
}
function rows(store: ContactStore, owner: number): ContactCandidate[] {
  return store.listCandidates().filter(row => row.intent && row.scope.userId === owner && !row.target.isGroup)
}
async function add(host: SubHost, store: ContactStore, service: ContactService, args: Record<string, unknown>, identity: ReturnType<typeof owned>) {
  const now = Date.now(), at = time(args.at), end = args.expiresAt === undefined ? at + 3_600_000 : time(args.expiresAt)
  const purpose = String(args.purpose ?? '').trim()
  if (!purpose || purpose.length > 300 || !Number.isFinite(at) || at <= now || at > now + 7 * 86_400_000
    || !Number.isFinite(end) || end <= at || end > at + 24 * 3_600_000) throw new Error('followup:invalid-purpose-or-window')
  const event = host.get('inbound')?.registry.get(identity.room)?.lastEvent
  const source = event?.post_type === 'message' && event.user_id === identity.owner ? `qq:${String(event.message_id)}` : undefined
  const dedupe = createHash('sha256').update(`${identity.owner}|${new Date(at).toISOString().slice(0, 10)}|${purpose.replace(/\s+/g, '')}`).digest('hex')
  const result = await service.propose({ source: 'follow-up', reason: purpose, evidenceSource: 'planned-followup',
    evidenceIds: source ? [source] : [], scope: { userId: identity.owner, personaId: host.config.agentPreset, worldId: '' },
    target: { channel: 'qq', room: identity.room, isGroup: false, chatId: identity.owner }, earliestAt: at, expiresAt: end,
    dedupeKey: `adaptive:${dedupe}`, authorization: { kind: 'none', by: null, at: null, quote: null },
    intent: { schemaVersion: 1, purpose, originSessionId: identity.session, evaluations: 0, ...(source ? { originMessageId: source } : {}) } })
  return { ...result, candidates: rows(store, identity.owner).filter(row => row.id === result.candidateId) }
}
export function registerAdaptiveTools(host: SubHost, store: ContactStore, service: ContactService): () => void {
  return registerSpecs(host.bridge.toolHost(), [{ name: 'qq_followup',
    description: '自主跟进意图：add 记录未来为何想联系，届时结合最新对话决定发送/完成/取消/延后；list 查看；resolve 按最新消息证据结束（fulfilled 或 dismiss）；cancel 放弃；reschedule 改期。自己想到的关心用本工具，用户明确要求的定时通知仍用 qq_remind。仅当前主人私聊可用。',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['add', 'list', 'resolve', 'cancel', 'reschedule'] }, purpose: { type: 'string' },
      at: { type: ['string', 'number'], description: 'Unix 毫秒或 YYYY-MM-DD HH:mm' }, expiresAt: { type: ['string', 'number'] },
      id: { type: 'string' }, expectedVersion: { type: 'number', description: 'resolve/cancel/reschedule 必填，来自 list 或当前意图版本' }, outcome: { type: 'string', enum: ['fulfilled', 'dismiss'] },
      evidenceIds: { type: 'array', items: { type: 'string' }, description: 'resolve 必填，例如 qq:123；引用意图创建以来当前房间的真实可读消息' },
    } }, run: async (args, context) => {
      const identity = owned(host, context)
      if (host.config.contact.adaptiveFollowUp === false) return { ok: false, code: 'followup:disabled' }
      if (args.action === 'list') return { candidates: rows(store, identity.owner) }
      if (args.action === 'add') return await add(host, store, service, args, identity)
      return await editAdaptive(host, store, args, identity, time)
    } }], host.log, 'adaptive-followup')
}
