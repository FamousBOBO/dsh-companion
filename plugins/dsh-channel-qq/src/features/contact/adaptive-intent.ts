export type AdaptiveAction = 'send' | 'fulfilled' | 'dismiss' | 'defer'
export interface AdaptiveDecision {
  readonly action: AdaptiveAction
  readonly evidenceIds: readonly string[]
  readonly at: number
}
export interface AdaptiveIntent {
  readonly schemaVersion: 1
  readonly purpose: string
  readonly originSessionId: string
  readonly originMessageId?: string
  readonly evaluations: number
  readonly decision?: AdaptiveDecision
}
export const ADAPTIVE_REVIEW_LIMIT = 2
export const ADAPTIVE_RETRY_MS = 5 * 60_000
export function readableAdaptiveEvidence(text: string): boolean {
  return text.replace(/\[(?:CQ:[^\]]+|图片[^\]]*|image[^\]]*|表情[^\]]*|视频[^\]]*|语音[^\]]*)\]/gi, '').trim() !== ''
}
const actions: readonly string[] = ['send', 'fulfilled', 'dismiss', 'defer']
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function parseAdaptiveDecision(raw: string, evidenceIds: readonly string[], at: number): AdaptiveDecision | null {
  if (raw.length > 4000) return null
  try {
    const value: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    if (!record(value) || Object.keys(value).some(k => !['action', 'evidenceIds'].includes(k))) return null
    if (!actions.includes(String(value.action)) || !Array.isArray(value.evidenceIds)) return null
    const ids = value.evidenceIds.filter((id): id is string => typeof id === 'string')
    if (ids.length !== value.evidenceIds.length || ids.length > 8 || ids.some(id => !evidenceIds.includes(id))) return null
    const action = value.action as AdaptiveAction
    if (['fulfilled', 'dismiss'].includes(action) && !ids.length) return null
    return { action, evidenceIds: [...new Set(ids)], at }
  } catch { return null }
}
export function normalizeAdaptiveIntent(value: unknown): AdaptiveIntent | null {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.purpose !== 'string') return null
  const purpose = value.purpose.trim()
  if (!purpose || purpose.length > 300 || typeof value.originSessionId !== 'string' || !/^qq-dm-\d+$/.test(value.originSessionId)) return null
  if (!Number.isInteger(value.evaluations) || Number(value.evaluations) < 0 || Number(value.evaluations) > ADAPTIVE_REVIEW_LIMIT) return null
  if (value.originMessageId !== undefined && (typeof value.originMessageId !== 'string' || !/^qq:-?\d+$/.test(value.originMessageId))) return null
  let decision: AdaptiveDecision | undefined
  if (value.decision !== undefined) {
    if (!record(value.decision) || !Array.isArray(value.decision.evidenceIds) || !Number.isFinite(value.decision.at)) return null
    decision = parseAdaptiveDecision(JSON.stringify({ action: value.decision.action, evidenceIds: value.decision.evidenceIds }), value.decision.evidenceIds, Number(value.decision.at)) ?? undefined
    if (!decision) return null
  }
  return { schemaVersion: 1, purpose, originSessionId: value.originSessionId, evaluations: Number(value.evaluations),
    ...(value.originMessageId === undefined ? {} : { originMessageId: value.originMessageId }), ...(decision ? { decision } : {}) }
}
