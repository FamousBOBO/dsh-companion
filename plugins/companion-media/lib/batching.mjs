// Inbound aggregation rules.
//
// The QQ channel already batches OneBot messages; the companion pipeline also
// debounces text. Stacking both silently drops pictures, so the media layer owns
// one explicit rule set:
//   * text keeps a 7s trailing window, capped by a 15s maximum wait;
//   * an image holds the window open a little longer (8s) so "look at this" and
//     the picture land in the same turn;
//   * a repeated event id is processed once.

export function createTurnAggregator({
  trailingWindowMs = 7000,
  maxWaitMs = 15000,
  imageWindowMs = 8000,
  now = () => Date.now(),
} = {}) {
  const sessions = new Map();

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { items: [], openerAt: 0, lastAt: 0, deadline: 0, seen: new Set(), timer: null };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function waitFor(state) {
    const hasImage = state.items.some(item => item.kind === 'image' || item.kind === 'sticker' || item.kind === 'screen');
    const window = hasImage ? imageWindowMs : trailingWindowMs;
    return Math.max(0, Math.min(state.lastAt + window, state.openerAt + maxWaitMs) - now());
  }

  return {
    /** Add one event; returns `{ duplicated, readyInMs }`. */
    push(sessionId, event) {
      const state = stateFor(sessionId);
      const id = event?.eventId ?? `${event?.kind ?? 'event'}:${event?.at ?? now()}`;
      if (state.seen.has(id)) return { duplicated: true, readyInMs: waitFor(state) };
      state.seen.add(id);
      if (state.seen.size > 500) state.seen.delete(state.seen.values().next().value);
      const at = event?.at ?? now();
      if (!state.items.length) state.openerAt = at;
      state.lastAt = at;
      state.items.push({ ...event, eventId: id, at });
      return { duplicated: false, readyInMs: waitFor(state) };
    },
    /** Take the pending batch, or null when nothing is pending. */
    take(sessionId) {
      const state = sessions.get(sessionId);
      if (!state?.items.length) return null;
      if (waitFor(state) > 0) return null;
      const items = state.items;
      state.items = [];
      state.openerAt = 0;
      state.lastAt = 0;
      return {
        sessionId,
        items,
        hasImage: items.some(item => ['image', 'sticker', 'screen'].includes(item.kind)),
        text: items.filter(item => item.kind === 'text').map(item => item.text ?? '').join('\n').trim(),
        images: items.filter(item => ['image', 'sticker', 'screen'].includes(item.kind)),
      };
    },
    pending(sessionId) {
      const state = sessions.get(sessionId);
      return state ? state.items.slice() : [];
    },
    reset(sessionId) {
      sessions.delete(sessionId);
    },
    readyInMs(sessionId) {
      const state = sessions.get(sessionId);
      return state ? waitFor(state) : 0;
    },
  };
}

/**
 * Compose the model-facing text for one turn.
 * The picture placeholder survives a failed inspection: a turn must never
 * degrade into caption-only text with no sign that an image was attached.
 */
export function composeTurnText({ text = '', visionResults = [], notes = [] } = {}) {
  const sections = [];
  if (text.trim()) sections.push(text.trim());
  for (const result of visionResults) {
    if (result?.ok && result.description) {
      sections.push(`【图片内容】${result.description}`);
    } else if (result?.placeholder) {
      sections.push(result.placeholder);
    } else {
      sections.push('【图片】这一张我没看清，先不猜内容。');
    }
  }
  for (const note of notes) if (note) sections.push(note);
  return sections.join('\n');
}
