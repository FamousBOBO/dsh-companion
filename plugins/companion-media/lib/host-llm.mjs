import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Code, mediaError } from './errors.mjs';

// Host LLM bridge for the media layer.
//
// Mirrors `companion-foundation/host-llm.mjs` (the canonical integration) but
// adds image content blocks, which the media layer needs for sticker and screen
// vision. Both go through the real `ctx.llm` service; nothing here talks to a
// provider endpoint directly.

const DEFAULT_TIMEOUT_MS = 90_000;

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

function resolveLlmService(ctx) {
  try {
    if (typeof ctx?.get === 'function') {
      const service = ctx.get('llm');
      if (service) return service;
    }
  } catch { /* fall through */ }
  try {
    return ctx?.llm ?? null;
  } catch {
    return null;
  }
}

function resolveRoute(ctx, provider, model) {
  if (provider && model) return { provider, model };
  let selection = null;
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : null;
    if (service && typeof service.currentSelection === 'function') selection = service.currentSelection();
  } catch { selection = null; }
  return {
    provider: provider || selection?.provider || '',
    model: model || selection?.model || '',
    ...(selection?.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
  };
}

/** Resolve the host attachments service without a hard `inject` requirement. */
export function resolveAttachments(ctx) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get('attachments') ?? null;
  } catch { /* ignore */ }
  return null;
}

/**
 * @param ctx Cordis context exposing `llm` (and optionally `attachments`).
 * @param deps attachments service, used to persist images before a request.
 * @returns `{ available, describe, completeText, inspectImages }`
 */
export async function createMediaHost(ctx, { attachments = null, describe = 'companion-media' } = {}) {
  const runtime = process.env.DSH_COMPANION_MODULE_ROOT;
  const available = () => Boolean(resolveLlmService(ctx)?.prepareCall);
  let module = null;
  const load = async () => {
    if (module) return module;
    if (!runtime) throw mediaError(Code.HOST_LLM_UNAVAILABLE, 'DSH_COMPANION_MODULE_ROOT is not set');
    module = await import(pathToFileURL(path.join(runtime, '@deepseek-ai/dsh-llm/lib/index.js')).href);
    if (!module.BlockAssembler || !module.createUserMessage) {
      throw mediaError(Code.HOST_LLM_UNAVAILABLE, 'the host LLM module does not export the streaming helpers');
    }
    return module;
  };

  async function call({ system = '', input = '', content = null, provider, model, maxTokens = 900, timeoutMs = DEFAULT_TIMEOUT_MS, sessionId, signal, purpose = describe }) {
    const llm = resolveLlmService(ctx);
    if (!llm?.prepareCall) throw mediaError(Code.HOST_LLM_UNAVAILABLE, 'the host LLM service is unavailable');
    const route = resolveRoute(ctx, provider, model);
    if (!route.provider || !route.model) throw mediaError(Code.HOST_LLM_UNAVAILABLE, 'no model route is configured (provider/model)');
    const { BlockAssembler, createUserMessage } = await load();
    const effectiveSessionId = (typeof sessionId === 'string' && sessionId.trim()) || `${purpose}-${process.pid}`;
    const parts = content ?? [{ type: 'text', text: input }];
    const messages = [createUserMessage({ content: parts, source: { kind: 'companion-media' } })];

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error(`${purpose} timed out`)); }, timeoutMs);
    const combined = joinSignals([signal, controller.signal].filter(Boolean));
    try {
      const prepared = await llm.prepareCall({ ...route, maxTokens }, combined);
      const options = { ...prepared.config, messages, system, purpose, signal: combined, sessionId: effectiveSessionId };
      const assembler = new BlockAssembler();
      for await (const chunk of prepared.stream(options)) {
        if (combined?.aborted) break;
        assembler.push(chunk);
      }
      if (timedOut) throw mediaError(Code.TIMEOUT, `${purpose} timed out after ${timeoutMs} ms`);
      if (combined?.aborted) throw mediaError(Code.CANCELLED, `${purpose} was aborted`);
      const finish = assembler.finish;
      if (finish?.kind === 'error' || finish?.reason?.kind === 'error') {
        const failure = finish?.failure ?? finish?.reason?.failure ?? {};
        throw mediaError(failure.code ?? Code.BACKEND_FAILED, `model call failed: ${failure.code ?? 'ERROR'}: ${failure.message ?? 'unknown'}`);
      }
      if (finish?.kind === 'aborted' || finish?.reason?.kind === 'aborted') {
        throw mediaError(Code.CANCELLED, 'model call aborted');
      }
      const text = blocksToText(assembler.blocks());
      if (!text) throw mediaError(Code.BACKEND_FAILED, 'the model returned no visible text');
      return { text, provider: route.provider, model: route.model, sessionId: effectiveSessionId };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    available,
    describe: () => ({ available: available(), attachments: Boolean(attachments), purpose: describe }),
    async completeText({ system, input, provider, model, maxTokens, timeoutMs, sessionId, signal, purpose }) {
      return call({ system, input, provider, model, maxTokens, timeoutMs, sessionId, signal, purpose });
    },
    /** Inspect images through the image-capable route, never as a text URL. */
    async inspectImages({ images, prompt, provider, model, timeoutMs = DEFAULT_TIMEOUT_MS, sessionId, signal }) {
      if (!attachments?.saveImages) throw mediaError(Code.ATTACHMENTS_UNAVAILABLE, 'the host attachment service is unavailable');
      const refs = await attachments.saveImages(images.map(image => ({ data: image.bytes, mediaType: image.mime })));
      const content = [
        { type: 'text', text: prompt },
        ...refs.map(ref => ({ type: 'image', attachment: ref })),
      ];
      return call({ content, provider, model, timeoutMs, sessionId, signal, purpose: 'companion-media-vision' });
    },
  };
}
