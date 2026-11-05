/** 语音条转写（从 pipeline 拆出：那边有 400 行硬上限）。失败只记日志，从不致命。 */

export async function transcribeVoiceOf(
  transcribe: (messageId: number) => Promise<string | null>,
  log: (line: string) => void,
  event: { message_id?: number },
  parsed: { recordCount: number },
): Promise<string | null> {
  if (parsed.recordCount === 0 || typeof event.message_id !== 'number') return null
  try {
    const text = await transcribe(event.message_id)
    if (text === null) return null
    log(`voice ${event.message_id} transcribed: ${text.slice(0, 60)}`)
    return text
  } catch (error) {
    log(`voice ${event.message_id} STT failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
