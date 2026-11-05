import { readableAdaptiveEvidence } from './adaptive-intent.js'
import type { SubHost } from '../plugin-kit.js'
import type { ContactStore } from './store.js'
import type { DraftHistoryPort } from './draft-context.js'

export async function editAdaptive(host: SubHost, store: ContactStore, args: Record<string, unknown>,
  identity: { owner: number; room: string }, time: (input: unknown) => number): Promise<{ ok: boolean; code: string }> {
  const id = String(args.id ?? ''), now = Date.now()
  if (!['resolve', 'cancel', 'reschedule'].includes(String(args.action))) throw new Error('followup:invalid-action')
  const row = store.listCandidates().find(candidate => candidate.id === id)
  if (!row?.intent || row.scope.userId !== identity.owner || row.target.room !== identity.room) throw new Error('followup:not-owned')
  if (!Number.isInteger(args.expectedVersion) || args.expectedVersion !== row.version) return { ok: false, code: 'followup:stale-version' }
  const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.filter((v): v is string => typeof v === 'string') : []
  if (args.action === 'resolve') {
    if (!['fulfilled', 'dismiss'].includes(String(args.outcome))) throw new Error('followup:invalid-outcome')
    const history = host.get('history') as DraftHistoryPort | undefined
    const evidence = await history?.search(identity.room, {}) ?? []
    if (!evidenceIds.length || evidenceIds.length > 8 || evidenceIds.some(id => !evidence.some(line => `qq:${String(line.id)}` === id && line.time * 1000 >= row.createdAt && readableAdaptiveEvidence(line.text) && (args.outcome !== 'fulfilled' || line.userId === identity.owner)))) throw new Error('followup:evidence-unavailable')
  }
  const at = time(args.at), end = args.expiresAt === undefined ? at + 3_600_000 : time(args.expiresAt)
  if (args.action === 'reschedule' && (!Number.isFinite(at) || at <= now || at > now + 7 * 86_400_000 || !Number.isFinite(end) || end <= at || end > at + 24 * 3_600_000)) throw new Error('followup:invalid-window')
  const changed = await store.write(ledger => {
    const current = ledger.candidates[id]
    if (!current?.intent || current.version !== row.version || !['pending', 'deferred'].includes(current.state)) return false
    if (Object.values(ledger.outbox).some(d => d.candidateId === id && ['running', 'submitted', 'confirmed', 'unknown'].includes(d.state))) return false
    const outcome = args.action === 'cancel' ? 'cancelled-by-owner-session' : String(args.outcome)
    ledger.candidates[id] = args.action === 'reschedule'
      ? { ...current, earliestAt: at, expiresAt: end, version: current.version + 1, updatedAt: now, state: 'pending',
          intent: { ...current.intent, evaluations: 0, decision: undefined }, lastSuppressedReason: 'followup:rescheduled' }
      : { ...current, state: 'cancelled', version: current.version + 1, updatedAt: now, lastSuppressedReason: 'followup:' + outcome,
          intent: { ...current.intent, ...(args.action === 'resolve' ? { decision: { action: args.outcome === 'fulfilled' ? 'fulfilled' : 'dismiss', at: now, evidenceIds } as const } : {}) } }
    return true
  })
  return { ok: changed, code: changed ? 'followup:updated' : 'followup:stale-or-in-flight' }
}
