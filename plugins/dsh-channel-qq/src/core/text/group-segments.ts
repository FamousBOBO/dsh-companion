import { segmentText } from './segment.js'

/** 一轮最多三条，按语意拆分；超出的短句合入最后一条，不丢正文。 */
export function groupSegments(text: string): string[] {
  const pieces = segmentText(text, { enabled: true, style: 'active', minLength: 8, maxSegments: Number.MAX_SAFE_INTEGER, removeTrailingPeriod: false })
  return pieces.length <= 3 ? pieces : [...pieces.slice(0, 2), pieces.slice(2).join('')]
}
