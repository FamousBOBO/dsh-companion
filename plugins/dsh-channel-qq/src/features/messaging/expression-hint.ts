import type { QQToolDeps } from '../tool-deps.js'

/** Read-only shortlist after a successful final DM send. Never sends or retries. */
export async function expressionHint(
  deps: Pick<QQToolDeps, 'expressionCandidates' | 'log'>,
  args: { isGroup?: unknown; target?: unknown; phase?: unknown },
  text: string,
): Promise<Record<string, unknown>> {
  if (args.isGroup === true || args.phase === 'progress' || !deps.expressionCandidates) return {}
  try {
    const raw = await deps.expressionCandidates({ isGroup: false, target: String(args.target), query: text, limit: 3 })
    const found = raw as { send?: boolean; candidates?: unknown[]; reasonCode?: string; fitScore?: number; diagnostics?: { cause?: string } } | undefined
    deps.log('DM expression shortlist: ' + (found?.reasonCode ?? 'unavailable'))
    if (!found) return {}
    if (found.send !== true || !Array.isArray(found.candidates) || found.candidates.length === 0) {
      return { expression: { checked: true, send: false, reason: found.diagnostics?.cause || found.reasonCode || 'no-candidates', ...(typeof found.fitScore === 'number' ? { fitScore: found.fitScore } : {}) } }
    }
    return { expression: { candidates: found.candidates.slice(0, 3), hint: '可选一张用 expression_reply(mode=sticker_only) 发送；正文已发。' } }
  } catch {
    deps.log('DM expression shortlist failed; text delivery unaffected')
    return {}
  }
}
