/** One bounded correction for a DM answer left in the web UI. Never replay tool calls. */
export class DmDeliveryGuard {
  private turn = -1
  private text = false
  private called = false
  private corrected = false
  private committed = false

  observe(frame: { type?: string; turn?: number; chunk?: { type?: string; blockType?: string; text?: string }; outcome?: { kind?: string; eventType?: string } }): void {
    if (frame.type === "start") {
      if (frame.turn !== this.turn) {
        this.turn = frame.turn ?? -1
        this.text = false; this.called = false; this.corrected = false
      }
      this.committed = false
    }
    const chunk = frame.chunk
    if (chunk?.type === "text-delta" && chunk.text?.trim()) this.text = true
    if (chunk?.type === "block-start" && chunk.blockType === "tool-call") this.called = true
    if (frame.type === "end") this.committed = frame.outcome?.kind === "committed" && frame.outcome.eventType === "assistant/message"
  }

  correction(toolVisible: boolean): boolean {
    if (!toolVisible || !this.committed || !this.text || this.called || this.corrected) return false
    this.corrected = true
    return true
  }
}
