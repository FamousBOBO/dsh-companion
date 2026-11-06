import { createHostLlmAdapter } from '../../companion-foundation/host-llm.mjs';

/** Resolve the current DSH default on every call; share credentials with the host. */
export function createMediaHost(ctx) {
  return {
    available() { try { return typeof ctx?.get?.('llm')?.prepareCall === 'function'; } catch { return false; } },
    async completeText({system,input,maxTokens,timeoutMs,sessionId,signal,purpose}) {
      signal?.throwIfAborted();
      const adapter = await createHostLlmAdapter(ctx,{timeoutMs,purpose,allowFallback:false,reasoningEffort:''});
      const text = await adapter.complete({system,input,maxTokens,sessionId:sessionId||`${purpose||'companion-media'}-${process.pid}`,signal});
      return {text};
    },
  };
}
