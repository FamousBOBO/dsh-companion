import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Host LLM adapter for background memory extraction.
//
// The memory engine only knows `llm.complete({system, input, maxTokens, signal})`.
// This adapter implements that interface on top of the DSH `llm` service so the
// extraction prompt reuses the same provider/model the desktop is configured
// with, without duplicating credentials or HTTP plumbing.

const DEFAULT_TIMEOUT_MS = 120000;

function joinSignals(signals) {
  const active = signals.filter(signal => signal instanceof AbortSignal);
  if (!active.length) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim();
}

/**
 * Resolve the host LLM service without declaring `llm` in the plugin's `inject`.
 *
 * Cordis throws when a non-injected service property is read, so a hard `inject`
 * entry would make the whole companion plugin fail to mount on a profile without
 * an LLM provider. `ctx.get()` reads the registry directly and returns undefined
 * instead, which lets extraction degrade while the rest of the companion works.
 */
function resolveLlmService(ctx) {
  try {
    if (typeof ctx?.get === 'function') {
      const service = ctx.get('llm');
      if (service) return service;
    }
  } catch { /* fall through to the injected property */ }
  try {
    return ctx?.llm ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the provider/model route for a background call.
 *
 * The `llm` service requires an explicit route: a `prepareCall` without a
 * provider fails with "no adapter registered for provider undefined". Explicit
 * config wins; otherwise the host's own default-model selection is reused so a
 * background summary call stays on the same route the desktop already uses.
 */
function resolveRoute(ctx, provider, model) {
  if (provider && model) return { provider, model };
  let selection = null;
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : null;
    if (service && typeof service.currentSelection === 'function') selection = service.currentSelection();
  } catch { selection = null; }
  const resolvedProvider = provider || selection?.provider || '';
  const resolvedModel = model || selection?.model || '';
  return {
    provider: resolvedProvider,
    model: resolvedModel,
    ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
  };
}

/**
 * Build an adapter over `ctx.llm`.
 * @param ctx - Cordis context exposing the `llm` service.
 * @param options.provider - route provider name; `''` reuses the host default.
 * @param options.model - route model name; `''` reuses the host default.
 * @param options.timeoutMs - hard deadline for one completion.
 * @returns `{ provider, model, complete, describe }`
 */
export async function createHostLlmAdapter(ctx, { provider = '', model = '', timeoutMs = DEFAULT_TIMEOUT_MS, reasoningEffort = 'low', purpose = 'companion-memory-extract', allowFallback = true } = {}) {
  const runtime = process.env.DSH_COMPANION_MODULE_ROOT;
  if (!runtime) throw new Error('DSH_COMPANION_MODULE_ROOT is not set; cannot reach the host LLM module.');
  const llm = resolveLlmService(ctx);
  if (!llm || typeof llm.prepareCall !== 'function') throw new Error('The host LLM service is unavailable.');
  const route = resolveRoute(ctx, provider, model);
  if (!route.provider || !route.model) throw new Error('No summary model route is configured (provider/model).');
  const module = await import(pathToFileURL(path.join(runtime, '@deepseek-ai/dsh-llm/lib/index.js')).href);
  const { BlockAssembler, createUserMessage } = module;
  if (!BlockAssembler || !createUserMessage) throw new Error('The host LLM module does not export the streaming helpers.');

  const label = String(purpose || 'companion-memory-extract');
  const describe = () => ({ provider: route.provider, model: route.model, reasoningEffort, timeoutMs, purpose: label });

  return {
    provider: route.provider,
    model: route.model,
    describe,
    async complete({ system = '', input, maxTokens = 2000, signal, sessionId, attempts: requestedAttempts, fallbackAttempts = 3 } = {}) {
      if (typeof input !== 'string' || !input.trim()) throw new Error('Memory extraction input is empty.');
      // The provider rejects a request without a session id header
      // ("MissingSessionID: x-opencode-session-id"), so a background call must
      // always carry one: the real session when known, otherwise a stable
      // synthetic id so the request is attributable instead of dropped.
      const effectiveSessionId = (typeof sessionId === 'string' && sessionId.trim()) || `companion-memory-${process.pid}`;
      const messages = [createUserMessage({
        content: [{ type: 'text', text: input }],
        source: { kind: 'companion-memory' },
      })];

      /** One streamed generation. A reasoning model can burn the whole budget on
       *  hidden reasoning and return no visible text, which is why the caller
       *  retries with a lower/absent reasoning effort. */
      const attempt = async (effort, budget = maxTokens) => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('memory extraction timed out')); }, timeoutMs);
        const combined = joinSignals([signal, controller.signal].filter(Boolean));
        try {
          const call = await llm.prepareCall({ ...route, maxTokens: budget }, combined, controls => (
            effort ? { ...controls, reasoningEffort: effort } : controls));
          const options = {
            ...call.config,
            messages,
            system,
            purpose: label,
            signal: combined,
            sessionId: effectiveSessionId,
          };
          const assembler = new BlockAssembler();
          const chunkTypes = [];
          for await (const chunk of call.stream(options)) {
            if (combined?.aborted) break;
            if (chunkTypes.length < 12) chunkTypes.push(chunk?.type ?? '(none)');
            assembler.push(chunk);
          }
          if (timedOut) throw new Error(`memory extraction timed out after ${timeoutMs} ms`);
          if (combined?.aborted) throw new Error('memory extraction was aborted by the caller (deadline or cancellation).');
          const finish = assembler.finish;
          // The llm service reports adapter/dispatch failures as a terminal finish
          // chunk instead of throwing, so an empty block list is not the real error.
          if (finish?.kind === 'error' || finish?.reason?.kind === 'error') {
            const failure = finish?.failure ?? finish?.reason?.failure ?? {};
            const error = new Error(`model call failed: ${failure.code ?? 'ERROR'}: ${failure.message ?? 'unknown failure'}`);
            error.code = failure.code;
            error.failure = failure;
            error.chunkTypes = chunkTypes;
            throw error;
          }
          if (finish?.kind === 'aborted' || finish?.reason?.kind === 'aborted') {
            const failure = finish?.failure ?? finish?.reason?.failure ?? {};
            const error = new Error(`model call aborted: ${failure.code ?? 'ABORTED'}: ${failure.message ?? ''}`);
            error.code = failure.code ?? 'ABORTED';
            throw error;
          }
          const blocks = assembler.blocks();
          const text = blocksToText(blocks);
          const reasoningChars = (blocks ?? [])
            .filter(block => block?.type === 'reasoning' && typeof block.text === 'string')
            .reduce((sum, block) => sum + block.text.length, 0);
          return { text, reasoningChars, finish, blocks: blocks?.length ?? 0, chunkTypes };
        } finally {
          clearTimeout(timer);
        }
      };

      let result;
      try {
        result = await attempt(reasoningEffort);
      } catch (error) {
        // `allowFallback` is the P2 seam: one budget reservation must mean at most one physical
        // generation, so the hidden retries below are disabled for it. The memory engine keeps
        // the default behaviour.
        if (!isUnsupportedOption(error) || !allowFallback) throw error;
        // The route may reject the explicit effort outright.
        result = await attempt(undefined);
      }
      if (!result.text && reasoningEffort && allowFallback) {
        // Or it may spend the whole visible budget on reasoning.
        result = await attempt(undefined);
      }
      if (!result.text && isContextOverflow(result.finish?.failure ?? {}) && allowFallback) {
        result = await attempt(undefined, Math.max(400, Math.min(maxTokens, 800)));
      }
      if (!result.text) {
        const finish = result.finish ? JSON.stringify(result.finish) : 'none';
        const types = (result.chunkTypes ?? []).join(',') || 'none';
        throw new Error(`The model returned no visible text for the ${label} request `
          + `(blocks: ${result.blocks}, reasoning chars: ${result.reasoningChars}, finish: ${finish}, chunks: ${types}).`);
      }
      return result.text;    },
  };
}
