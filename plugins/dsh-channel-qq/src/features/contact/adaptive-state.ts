import type { ContactStore } from './store.js'
import type { ContactCandidate } from './types.js'
import type { AdaptiveDecision } from './adaptive-intent.js'
import { ADAPTIVE_RETRY_MS, ADAPTIVE_REVIEW_LIMIT } from './adaptive-intent.js'
import { canDraft } from './model.js'
import type { ContactConfig } from '../../config/sections/contact.js'

export async function reserveAdaptive(store: ContactStore, candidate: ContactCandidate, now: number, epoch: number,
  config: ContactConfig, recentCalls: readonly number[]): Promise<ContactCandidate | null> {
  let reserved: ContactCandidate | null = null
  await store.write(ledger => {
    const row = ledger.candidates[candidate.id]
    if (!row?.intent || row.version !== candidate.version || !['pending', 'deferred'].includes(row.state)) return false
    if (row.intent.evaluations >= ADAPTIVE_REVIEW_LIMIT) {
      ledger.candidates[row.id] = { ...row, state: 'cancelled', version: row.version + 1, updatedAt: now, lastSuppressedReason: 'followup:review-limit' }
      return true
    }
    const budget = canDraft(ledger.counters, { ...config, draftModel: true }, { now, recentCalls })
    if (!budget.allowed) return false
    ledger.counters = { ...ledger.counters, draftCallsToday: ledger.counters.draftCallsToday + 1 }
    reserved = { ...row, version: row.version + 1, updatedAt: now, earliestAt: now + ADAPTIVE_RETRY_MS,
      intent: { ...row.intent, evaluations: row.intent.evaluations + 1 }, lastSuppressedReason: 'followup:reviewing' }
    ledger.candidates[row.id] = reserved
    return true
  }, epoch)
  return reserved
}
export async function settleAdaptive(store: ContactStore, reserved: ContactCandidate, decision: AdaptiveDecision | null,
  now: number, epoch: number, called: boolean, failed: boolean): Promise<ContactCandidate | null> {
  let result: ContactCandidate | null = null
  await store.write(ledger => {
    if (!called) ledger.counters = { ...ledger.counters, draftCallsToday: Math.max(0, ledger.counters.draftCallsToday - 1) }
    if (failed && called) ledger.counters = { ...ledger.counters, draftFailureStreak: ledger.counters.draftFailureStreak + 1, lastDraftFailureAt: now }
    if (called && decision) ledger.counters = { ...ledger.counters, draftFailureStreak: 0, lastDraftFailureAt: null }
    const row = ledger.candidates[reserved.id]
    if (!row?.intent || row.version !== reserved.version || !['pending', 'deferred'].includes(row.state)) return true
    const terminal = decision?.action === 'fulfilled' || decision?.action === 'dismiss'
    const send = decision?.action === 'send'
    result = { ...row, version: row.version + 1, updatedAt: now,
      state: terminal ? 'cancelled' : send ? 'pending' : 'deferred',
      earliestAt: send ? now : row.earliestAt,
      lastSuppressedReason: 'followup:' + (decision?.action ?? (failed ? 'review-failed' : 'stale-or-unavailable')),
      intent: { ...row.intent, evaluations: called ? row.intent.evaluations : Math.max(0, row.intent.evaluations - 1),
        ...(decision ? { decision } : {}) } }
    ledger.candidates[row.id] = result
    return true
  }, epoch)
  return result
}

export async function parkAdaptive(store: ContactStore, candidate: ContactCandidate, now: number, epoch: number, reason: string): Promise<void> {
  await store.write(ledger => {
    const row = ledger.candidates[candidate.id]
    if (!row?.intent || row.version !== candidate.version || !['pending', 'deferred'].includes(row.state)) return false
    ledger.candidates[row.id] = { ...row, state: 'deferred', version: row.version + 1, updatedAt: now, earliestAt: now + ADAPTIVE_RETRY_MS, lastSuppressedReason: reason }
    return true
  }, epoch)
}
