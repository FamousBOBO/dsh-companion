// VoceChat event → the one internal shape the adapter consumes.
//
// The measured body (VoceChat 0.5.40, 2026-11-17, webhook-raw.jsonl is the source of truth):
//
//   {"created_at":1794892571813,
//    "detail":{"content":"event probe A",
//              "content_type":"text/plain",
//              "expires_in":null,
//              "properties":null,
//              "type":"normal"},
//    "domain":null,
//    "from_uid":1,
//    "mid":133,
//    "target":{"gid":1},
//    "widget_id":null,
//    "type":"chat"}
//
// A DM carries `"target":{"uid":2}` instead. Everything else is identical.
//
// Design rules:
//
//   1. **Never guess a meaning.** An unknown `type` or an unknown `target` key yields a normalized
//      event with `kind` preserved verbatim and `target: null`, so the adapter can decide to drop it
//      with a logged reason instead of the plugin inventing semantics.
//   2. **Never throw.** The webhook has already answered 200 by the time this runs; a throwing
//      normalizer would take down the replay loop. Bad input returns `{ok:false, reason}`.
//   3. **Keep the raw body.** `store.mjs` persists the untouched JSON next to the normalized event,
//      because the platform is not documented and a future field change must be reconstructible.
//   4. **`content_type` is data, not a filter.** Only text is observed today, but the adapter — not
//      the transport — decides what to do with a future `image/png` message.
//   5. **No Bot loop filter here.** The platform already suppresses a bot's own messages from its own
//      webhook (measured: sending does not fire the hook). Filtering `from_uid === botUid` belongs in
//      the adapter as a second, independent belt — §5.4 of the plan.

const MAX_CONTENT_CHARS = 64 * 1024;

/** `{gid:1}` / `{uid:2}` → `{channel:1}` / `{user:2}`, or null. */
export function targetOfRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.gid !== undefined && raw.gid !== null) {
    const gid = Number(raw.gid);
    if (Number.isInteger(gid) && gid >= 0) return { channel: gid };
    return null;
  }
  if (raw.uid !== undefined && raw.uid !== null) {
    const uid = Number(raw.uid);
    if (Number.isInteger(uid) && uid >= 0) return { user: uid };
    return null;
  }
  return null;
}

/**
 * Normalize one raw webhook body.
 *
 * @param {unknown} raw            parsed JSON (or any value)
 * @returns {{ok: true, event: object} | {ok: false, reason: string}}
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-an-object' };
  }

  const mid = Number(raw.mid);
  if (!Number.isInteger(mid) || mid <= 0) return { ok: false, reason: 'missing-mid' };

  const fromUid = Number(raw.from_uid);
  if (!Number.isInteger(fromUid) || fromUid < 0) return { ok: false, reason: 'missing-from-uid' };

  const target = targetOfRaw(raw.target);
  if (!target) return { ok: false, reason: 'unknown-target' };

  const detail = raw.detail && typeof raw.detail === 'object' ? raw.detail : {};
  const content = typeof detail.content === 'string' ? detail.content : '';
  if (content.length > MAX_CONTENT_CHARS) return { ok: false, reason: 'content-too-long' };

  const createdAt = Number(raw.created_at);
  const kind = typeof raw.type === 'string' && raw.type.trim() !== '' ? raw.type.trim() : '';

  return {
    ok: true,
    event: {
      // `mid` is the idempotency key the whole pipeline leans on. Never synthesised.
      mid,
      fromUid,
      target,
      content,
      // Data, not a filter: keep the platform's string verbatim so a future type is visible.
      contentType: typeof detail.content_type === 'string' ? detail.content_type : '',
      // `normal` today; kept so a future `reply`/`reaction` is distinguishable without re-parsing.
      detailType: typeof detail.type === 'string' ? detail.type : '',
      // Platform milliseconds. Kept as the platform reported it — no local-clock guesses.
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
      // Verbatim; the adapter drops anything that is not 'chat', with a logged reason.
      kind,
      // Arrival time locally observed. Separate from `createdAt` on purpose: the difference is how
      // much the platform's delivery lagged, which is real operational information.
      receivedAt: Date.now(),
    },
  };
}

/** A short, safe description for logs. Never the message text. */
export function describeEvent(event) {
  if (!event || typeof event !== 'object') return 'invalid';
  const t = event.target ?? {};
  const where = t.channel !== undefined ? `chan:${t.channel}` : t.user !== undefined ? `dm:${t.user}` : 'unknown';
  return `mid=${event.mid} from=${event.fromUid} to=${where} kind=${event.kind || '?'}`;
}
