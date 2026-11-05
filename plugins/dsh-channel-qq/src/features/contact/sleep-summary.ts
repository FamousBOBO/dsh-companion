import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SubHost } from '../plugin-kit.js'
import type { ContactCandidate, ContactService } from './types.js'

interface SleepSummary {
  readonly sourceId: string
  readonly sleepDate: string
  readonly expiresAt: number
  readonly text: string
}

function readSummary(host: SubHost, now: number): { owner: number; summary: SleepSummary } | null {
  const owner = host.config.admins[0]
  if (owner === undefined || host.config.contact.sleepSummaryRecipient !== String(owner)) return null
  try {
    const registry = Reflect.get(process, Symbol.for('dsh.companion.ports.v1')) as Map<string, {
      ready(): boolean
      service: { qqCareCandidate?(): SleepSummary | null }
    }> | undefined
    const entry = registry?.get(dirname(realpathSync(host.dshHome)))
    const summary = entry?.ready() ? entry.service.qqCareCandidate?.() : null
    if (!summary || !Number.isFinite(summary.expiresAt) || summary.expiresAt <= now) return null
    return { owner, summary }
  } catch {
    return null
  }
}

function deliveryKey(owner: number, summary: SleepSummary): string {
  return `health-sleep:${owner}:${summary.sleepDate}`
}

export function authorizedSleepText(host: SubHost, candidate: ContactCandidate, now: number): string | null {
  const current = readSummary(host, now)
  if (!current || candidate.source !== 'health-sleep' || candidate.target.isGroup) return null
  const { owner, summary } = current
  if (candidate.scope.userId !== owner || candidate.target.chatId !== owner) return null
  if (candidate.dedupeKey !== deliveryKey(owner, summary) || candidate.evidenceIds[0] !== summary.sourceId) return null
  return summary.text
}

export async function proposeSleepSummary(host: SubHost, service: ContactService, now: number): Promise<void> {
  const current = readSummary(host, now)
  if (!current) return
  const { owner, summary } = current
  await service.propose({
    source: 'health-sleep',
    reason: '主人授权的睡眠摘要',
    evidenceSource: 'health:sleep',
    evidenceIds: [summary.sourceId],
    scope: { userId: owner, personaId: host.config.agentPreset, worldId: '' },
    target: { channel: 'qq', room: `dm-${owner}`, isGroup: false, chatId: owner },
    earliestAt: now,
    expiresAt: summary.expiresAt,
    dedupeKey: deliveryKey(owner, summary),
    authorization: { kind: 'none', by: null, at: null, quote: null },
  })
}
