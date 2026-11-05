import type { ContactCandidate } from './types.js'
import type { AttemptDeps } from './attempt.js'
import type { ContactConfig } from '../../config/sections/contact.js'
import type { DraftContext, DraftRevision } from './draft-context.js'
import { sufficientContext } from './draft-context.js'
import { parseAdaptiveDecision, readableAdaptiveEvidence } from './adaptive-intent.js'
import { reserveAdaptive, settleAdaptive, parkAdaptive } from './adaptive-state.js'
import { pruneDraftCalls, canDraft } from './model.js'

function adaptiveEnabled(config: ContactConfig): boolean { return config.adaptiveFollowUp !== false }
function sameContext(a: DraftContext, b: DraftContext): boolean {
  return a.revision.historyCursor === b.revision.historyCursor && a.revision.personaDigest === b.revision.personaDigest
    && JSON.stringify(a.revision.roomCursor) === JSON.stringify(b.revision.roomCursor)
    && JSON.stringify(a.revision.binding) === JSON.stringify(b.revision.binding)
}
export async function reviewAdaptive(deps: AttemptDeps, candidate: ContactCandidate, now: number, epoch: number,
  config: ContactConfig): Promise<{ candidate: ContactCandidate; revision: DraftRevision } | null> {
  if (!candidate.intent || !adaptiveEnabled(config) || deps.isFrozen() || !deps.adaptivePort || !deps.draftContext) return null
  deps.drafts.calls = pruneDraftCalls(deps.drafts.calls, now)
  if (!canDraft(deps.store.state.counters, { ...config, draftModel: true }, { now, recentCalls: deps.drafts.calls }).allowed) return null
  let context
  try { context = await deps.draftContext.build(candidate, now) } catch { await parkAdaptive(deps.store, candidate, now, epoch, 'followup:context-unavailable'); return null }
  if (deps.isFrozen()) return null
  if (!sufficientContext(context).ok) { await parkAdaptive(deps.store, candidate, now, epoch, 'followup:context-unavailable'); return null }
  deps.drafts.calls = pruneDraftCalls(deps.drafts.calls, now)
  const reserved = await reserveAdaptive(deps.store, candidate, now, epoch, config, deps.drafts.calls)
  if (!reserved?.intent) return null
  deps.drafts.calls.push(now)
  let attempt
  try { attempt = await deps.adaptivePort.decide({ intent: reserved.intent, context, now, createdAt: candidate.createdAt }) }
  catch { attempt = { called: true, text: '', failed: true } }
  const at = deps.clock.now()
  if (!attempt.called) {
    const index = deps.drafts.calls.indexOf(now)
    if (index >= 0) deps.drafts.calls.splice(index, 1)
  }
  const ids = context.history.flatMap(line => line.id && line.at >= candidate.createdAt && readableAdaptiveEvidence(line.text) ? [line.id] : [])
  const parsed = !attempt.called || attempt.failed ? null : parseAdaptiveDecision(attempt.text, ids, at)
  let decision = parsed
  if (decision?.action === 'fulfilled' && decision.evidenceIds.some(id => !context.history.some(line => line.id === id && line.who === 'user'))) decision = null
  let fresh
  try { fresh = await deps.draftContext.build(reserved, at) } catch { fresh = context; decision = null }
  if (deps.isFrozen() || !adaptiveEnabled(config) || !sufficientContext(fresh).ok || !sameContext(context, fresh)) decision = null
  const settled = await settleAdaptive(deps.store, reserved, decision, at, epoch, attempt.called, attempt.failed === true || (attempt.called && !parsed))
  deps.log('contact: adaptive ' + candidate.id + ' -> ' + (settled?.lastSuppressedReason ?? 'stale-version'))
  if (!settled || decision?.action !== 'send' || settled.state !== 'pending') return null
  return { candidate: settled, revision: { ...fresh.revision, candidateVersion: settled.version, candidateUpdatedAt: settled.updatedAt } }
}
