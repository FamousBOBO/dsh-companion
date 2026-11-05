import { Code, mediaError } from './errors.mjs';
import { newId, nowIso } from './ids.mjs';

// Delivery: planning, **real** execution and receipts.
//
// "The tool returned" is not "the message arrived". A plan is a list of ordered
// steps; a receipt records what the channel actually reported. Anything the
// channel did not confirm stays `unknown`, and an unknown result is never
// replayed automatically (CONTRACT §6.7).
//
// Modes (CONTRACT §5):
//   * `mock`           — plans only; a `confirmed` report is *downgraded* to `unknown`,
//                        because nothing can prove arrival. `deliver()` refuses.
//   * `desktop`        — a real host-provided channel (in-process session delivery).
//   * `onebot`         — a real OneBot v11 channel (the QQ plugin's sender).
//
// The channel is **injected** (`channelProvider`), never imported: this plugin owns
// no socket and no sender identity. A channel must expose `send(step, context)`
// returning `{ ok, state?, platformMessageId?, detail? }`. Without a channel, real
// modes fail closed (`channel-unavailable`) instead of pretending to deliver.

export const CONTENT_KINDS = ['voice', 'at', 'text', 'face', 'image', 'other'];
export const DELIVERY_MODES = ['mock', 'desktop', 'onebot'];
const REAL_MODES = ['desktop', 'onebot'];
const RECEIPT_STATES = ['planned', 'submitted', 'confirmed', 'unknown', 'failed', 'cancelled'];

export function orderItems(items, order = CONTENT_KINDS) {
  const rank = new Map(order.map((kind, index) => [kind, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (rank.get(a.item.kind) ?? order.length) - (rank.get(b.item.kind) ?? order.length) || a.index - b.index)
    .map(entry => entry.item);
}

/**
 * Collapse the caller's items into the ones that really go on the wire.
 *
 * "Merging" is deliberately conservative and therefore explainable:
 *   * consecutive `text` items become one text step (joined with `\n`), so a model that
 *     emits two paragraphs cannot turn into two messages;
 *   * `voice_only` drops the text when a voice exists — the voice *is* the message;
 *   * images/stickers/faces keep their relative order and are never merged with text.
 */
export function mergeItems(items = [], { voiceOnly = false } = {}) {
  const hasVoice = items.some(item => item?.kind === 'voice');
  const out = [];
  let textBuffer = [];
  const flushText = () => {
    if (!textBuffer.length) return;
    const text = textBuffer.join('\n').trim();
    textBuffer = [];
    if (text) out.push({ kind: 'text', text });
  };
  for (const item of items) {
    if (!item || !item.kind) continue;
    if (item.kind === 'text') { textBuffer.push(String(item.text ?? '')); continue; }
    flushText();
    if (item.kind === 'voice' && voiceOnly && !hasVoice) continue;
    out.push(item);
  }
  flushText();
  if (voiceOnly && hasVoice) return out.filter(item => item.kind !== 'text');
  return out;
}

/**
 * Build the ordered delivery plan for one reply.
 * `voiceOnly` means the voice replaces the same text instead of doubling it.
 */
export function planDelivery({
  sessionId, channel = 'desktop', target = '', text = '', voice = null, images = [],
  items = null, mode = 'mock', voiceOnly = false, order,
} = {}) {
  if (!sessionId) throw mediaError(Code.BAD_INPUT, 'a session is required to plan delivery');
  if (!DELIVERY_MODES.includes(mode)) throw mediaError(Code.BAD_INPUT, `unsupported delivery mode: ${mode}`);
  const source = Array.isArray(items) && items.length
    ? items.slice()
    : [
      ...(voice ? [{ kind: 'voice', artifactId: voice.artifactId, path: voice.path, durationSeconds: voice.durationSeconds }] : []),
      ...(text ? [{ kind: 'text', text }] : []),
      ...images.map(image => ({ kind: image.kind === 'sticker' || image.kind === 'screen' ? image.kind : 'image', artifactId: image.artifactId, path: image.path })),
    ];
  const merged = mergeItems(source, { voiceOnly: Boolean(voiceOnly) });
  const ordered = orderItems(merged, order);
  return {
    planId: newId('plan'),
    sessionId,
    channel,
    target,
    mode,
    voiceOnly: Boolean(voiceOnly && merged.some(item => item.kind === 'voice')),
    createdAt: nowIso(),
    steps: ordered.map((item, index) => ({ ...item, step: index + 1, state: 'planned' })),
  };
}

/**
 * Create the delivery service.
 *
 * @param {object}   options
 * @param {object}   options.ledger            media ledger (`putReceipt`, `summary`)
 * @param {Function} [options.log]             diagnostic logger
 * @param {string}   [options.mode]            `mock` | `desktop` | `onebot`
 * @param {Function} [options.channelProvider] `() => channel | null`, re-read on every call so a
 *                                             hot-reloaded provider is picked up
 */
export function createDeliveryService({ ledger, log = () => {}, mode = 'mock', modeProvider = null, channelProvider = () => null, now = nowIso } = {}) {
  const receipts = [];
  const runs = [];

  function resolvedMode() {
    const current = typeof channelProvider === 'function' ? channelProvider() : null;
    // The **configured** mode always wins: it is the kill switch, so a wired channel can never
    // upgrade a deployment from `mock` to a real send. The channel may only *confirm* which real
    // transport it speaks; a mismatch is reported by `deliver()` instead of being silently used.
    const configured = typeof modeProvider === 'function' ? modeProvider() : mode;
    return { mode: DELIVERY_MODES.includes(configured) ? configured : 'mock', channel: current };
  }

  function put(receipt) {
    ledger.putReceipt(receipt);
    receipts.push(receipt);
    return receipt;
  }

  return {
    /**
     * Record what the channel reported.
     *
     * Honesty rules, in order:
     *   * `mock` + `confirmed` → downgraded to `unknown` (nothing can prove arrival);
     *   * real mode + `confirmed` **without** a `platformMessageId` → downgraded to `unknown`
     *     ("the send call returned" is not proof, exactly like the mock case);
     *   * everything else is stored as reported.
     */
    record({ planId, sessionId, channel, target, state, platformMessageId, detail } = {}) {
      if (!RECEIPT_STATES.includes(state)) {
        throw mediaError(Code.BAD_INPUT, `unsupported delivery state: ${state}`);
      }
      const { mode: currentMode } = resolvedMode();
      const downgrade = (reason) => {
        const receipt = put({
          receiptId: newId('rcpt'), planId, sessionId,
          target: { channel, id: target }, state: 'unknown', at: now(), detail: reason,
        });
        log({ event: 'delivery.downgraded', planId, reason });
        return receipt;
      };
      if (state === 'confirmed' && currentMode === 'mock') return downgrade('mock transport cannot confirm delivery');
      if (state === 'confirmed' && !platformMessageId) return downgrade('no platform message id: the send call returned, arrival is unproven');
      return put({
        receiptId: newId('rcpt'), planId, sessionId,
        target: { channel, id: target },
        state,
        ...(platformMessageId ? { platformMessageId } : {}),
        at: now(),
        ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
      });
    },

    /**
     * Execute a plan for real: steps in order, one receipt per step, stop at the first
     * non-confirmation and mark the remainder `cancelled` (never silently skipped, never
     * retried later).
     *
     * Refusals are typed instead of optimistic:
     *   * `delivery-mock`         — the deployment is in mock mode: nothing will be sent;
     *   * `channel-unavailable`   — no channel is wired, so a real send cannot happen;
     *   * `delivery-disabled`     — the caller asked for a plan with an unknown/absent mode.
     */
    async deliver({ plan = null, sessionId, channel = 'desktop', target = '', text = '', voice = null, images = [], items = null, voiceOnly = false, order } = {}) {
      const resolved = resolvedMode();
      if (resolved.mode === 'mock') {
        return { ok: false, code: 'delivery-mock', mode: resolved.mode, steps: [], receipts: [], message: 'mock mode plans only; nothing was sent' };
      }
      const sender = resolved.channel;
      if (!sender || typeof sender.send !== 'function') {
        return { ok: false, code: 'channel-unavailable', mode: resolved.mode, steps: [], receipts: [], message: 'no delivery channel is wired' };
      }
      if (typeof sender.mode === 'string' && DELIVERY_MODES.includes(sender.mode) && sender.mode !== resolved.mode) {
        // Sending a `desktop` plan through a `onebot` channel (or the reverse) is a wiring bug,
        // and a wrong-transport send is not something this layer may decide on its own.
        return {
          ok: false, code: 'channel-mode-mismatch', mode: resolved.mode, channelMode: sender.mode,
          steps: [], receipts: [], message: `configured mode ${resolved.mode} but the channel speaks ${sender.mode}`,
        };
      }
      let built = plan;
      try {
        if (!built) built = planDelivery({ sessionId, channel, target, text, voice, images, items, mode: resolved.mode, voiceOnly, order });
      } catch (error) {
        return { ok: false, code: error?.code ?? 'invalid-plan', steps: [], receipts: [], message: String(error?.message ?? error) };
      }
      const steps = [];
      const out = [];
      let failedAt = null;
      for (const step of built.steps ?? []) {
        if (failedAt !== null) {
          steps.push({ ...step, state: 'cancelled', detail: `not attempted: step ${failedAt} did not confirm` });
          continue;
        }
        let answer;
        try {
          answer = await sender.send({ ...step, planId: built.planId, sessionId: built.sessionId, channel: built.channel, target: built.target }, { mode: resolved.mode, plan: built });
        } catch (error) {
          // A throwing channel gave **no answer**: the send may have reached the platform.
          answer = { ok: false, state: 'unknown', detail: `channel threw: ${String(error?.message ?? error).slice(0, 160)}` };
        }
        const state = answer?.ok === false
          ? (answer?.state === 'failed' ? 'failed' : 'unknown')
          : (answer?.state && RECEIPT_STATES.includes(answer.state) ? answer.state : (answer?.platformMessageId ? 'confirmed' : 'submitted'));
        const receipt = this.record({
          planId: built.planId, sessionId: built.sessionId, channel: built.channel, target: built.target,
          state: state === 'planned' ? 'submitted' : state,
          platformMessageId: answer?.platformMessageId,
          detail: answer?.detail ?? (answer?.ok === false ? 'channel reported a failure' : ''),
        });
        steps.push({ ...step, state: receipt.state, receiptId: receipt.receiptId, platformMessageId: receipt.platformMessageId ?? null });
        out.push(receipt);
        if (receipt.state !== 'confirmed') failedAt = step.step;
        if (failedAt !== null) log({ event: 'delivery.stopped', planId: built.planId, step: step.step, state: receipt.state });
      }
      const confirmedCount = steps.filter(step => step.state === 'confirmed').length;
      const runState = steps.length > 0 && confirmedCount === steps.length
        ? 'confirmed'
        : (steps.some(step => step.state === 'unknown')
          ? 'unknown'
          : (steps.some(step => step.state === 'failed') ? 'failed' : 'submitted'));
      const run = {
        planId: built.planId,
        mode: resolved.mode,
        at: now(),
        steps: steps.length,
        confirmed: confirmedCount,
        state: runState,
      };
      runs.push(run);
      if (runs.length > 50) runs.shift();
      log({ event: 'delivery.run', ...run });
      return { ok: run.state === 'confirmed', state: run.state, mode: resolved.mode, planId: built.planId, plan: built, steps, receipts: out };
    },

    /** Decide what to do about a job whose delivery state is unknown. */
    reconcile({ receipt } = {}) {
      if (!receipt) return { action: 'none', reason: 'no receipt' };
      if (receipt.state === 'unknown') return { action: 'ask-user', reason: 'channel did not confirm; do not resend automatically' };
      if (receipt.state === 'failed') return { action: 'report-failure', reason: 'channel reported a failure' };
      if (receipt.state === 'submitted') return { action: 'await-confirmation', reason: 'submitted is not confirmed' };
      return { action: 'none', reason: receipt.state };
    },
    recent(limit = 10) { return receipts.slice(-limit); },

    /** Honest capability view: mode, whether a channel is really wired, and receipt counts. */
    status() {
      const resolved = resolvedMode();
      const counts = Object.fromEntries(RECEIPT_STATES.map(state => [state, 0]));
      for (const receipt of receipts) counts[receipt.state] = (counts[receipt.state] ?? 0) + 1;
      const last = runs[runs.length - 1] ?? null;
      return {
        mode: resolved.mode,
        channelWired: Boolean(resolved.channel && typeof resolved.channel.send === 'function'),
        channelName: typeof resolved.channel?.name === 'string' ? resolved.channel.name : '',
        receipts: counts,
        lastRun: last,
        lastReceiptAt: receipts.length ? receipts[receipts.length - 1].at : null,
      };
    },
  };
}
