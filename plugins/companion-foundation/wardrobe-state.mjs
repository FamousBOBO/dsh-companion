/** Wardrobe resolver — the single authority on "what is she wearing right now".
 *
 * Everything that needs the current clothes goes through `resolveWardrobeState()`:
 * the `companion_wardrobe_detail` tool, the `agent/pre-step` prompt snapshot, and the
 * media layer's image prompt. One function, one answer, so the prompt and the picture
 * can never disagree (that drift is what the brief calls out as the core problem).
 *
 * Priority, highest first (contract §3.1):
 *   1. this turn's explicit request          (`explicit`)
 *   2. an unexpired override that fits the scene
 *   3. a currently happening activity/schedule
 *   4. the configured day/night window
 *   5. the per-day deterministic rotation for that scene
 *   6. that scene's default outfit
 *
 * Two consequences worth stating, because they are the whole point:
 *   - a daytime `home` override does **not** survive into the night window: it is not
 *     applicable once the automatic scene is `sleep`, so sleepwear wins;
 *   - "she went out" is never inferred from the previous turn. Outdoor clothes require
 *     an explicit request, an applicable unexpired override, or an outing that is
 *     happening *now*.
 *
 * No model call, no network, no timer, no message. Read-only apart from the explicit
 * mutations in `wardrobe.mjs` (set/clear override), which this module does not perform.
 */
import {
  WARDROBE_CONTEXTS,
  WARDROBE_CONTEXT_LABELS,
  WARDROBE_SLOTS,
  WARDROBE_SLOT_LABELS,
  OVERRIDE_CONTEXT_ANY,
  loadWardrobeFor,
  localDate,
  legacyOverrides,
  normalizePieces,
  outfitCandidates,
  resolvePieces,
  selectOutfitForContext,
} from './wardrobe-schema.mjs';
import { classifyContext, loadWardrobeConfig } from './wardrobe-context.mjs';

const GROUP_SESSION_PREFIX = 'qq-group-';
const MISSING_REASONS = Object.freeze({
  'wardrobe-missing-for-persona': '这个会话的人格还没有自己的衣柜文件；不要借用别人格的衣物，也不要说自己穿着某套衣服。',
  'wardrobe-unavailable-in-group': '群聊里不解析私人衣柜；被问到穿着时不要再具体描述衣物。',
  'no-outfits-for-context': '当前场景还没有配好的服装组合；不要编造这一套衣服。',
  'outfit-pieces-unresolvable': '当前场景的服装组合引用了衣柜里不存在的衣物；如实说这套衣服现在拿不到。',
  'wardrobe-unreadable': '衣柜文件读不出来；不要编造当前穿着。',
});

function pieceView(item) {
  if (!item) return null;
  return {
    id: item.id,
    slot: item.slot,
    contexts: item.contexts,
    nameZh: item.name?.zh ?? '',
    nameEn: item.name?.en ?? '',
    descZh: item.description?.zh ?? '',
    descEn: item.description?.en ?? '',
  };
}

const DAYTIME_CONTEXTS = new Set(['everyday', 'home', 'outdoor', 'special']);

/**
 * Does an override apply to the scene the resolver would pick on its own?
 *
 * This is the rule that makes the brief's §7.2 sentence true instead of aspirational:
 *
 *  - a **scene-tagged daytime** override (everyday/home/outdoor/special) applies during the
 *    day — including across daytime scenes, because "今天就在家" is a statement about the
 *    whole day, not only about the exact minute's classification;
 *  - it does **not** apply once the night window has put her in `sleep`. Otherwise a 14:00
 *    "stay home today" would veto sleepwear at 22:40, which is exactly the failure the
 *    brief names;
 *  - a **scene-tagged `sleep`** override applies to `sleep` (that is an explicit
 *    "put on the pajamas" statement) and to nothing else;
 *  - a **context-free** override (`any`, which is what the old `companion_outfit_set` call
 *    shape writes) applies anywhere, **except** at night when it is the legacy v1 `current`
 *    mirror: that mirror only ever described a daytime rotation, so it must not keep
 *    daytime clothes on at 02:00.
 */
export function overrideAppliesTo(override, autoContext) {
  const scope = override?.context ?? OVERRIDE_CONTEXT_ANY;
  const legacy = override?.legacy === true;
  if (scope === OVERRIDE_CONTEXT_ANY) return !(autoContext === 'sleep' && legacy);
  if (scope === autoContext) return true;
  if (autoContext === 'sleep') return false;
  return DAYTIME_CONTEXTS.has(scope) && DAYTIME_CONTEXTS.has(autoContext);
}

/** Overrides that could apply right now: unexpired, and matching the scene or `any`. */
export function applicableOverrides(wardrobe, { now, context, personaId = '' }) {
  const rows = [...(wardrobe?.overrides ?? []), ...legacyOverrides(wardrobe, { now, timeZone: wardrobe?.timeZone || 'Asia/Shanghai' })];
  const unexpired = [];
  const expired = [];
  for (const row of rows) {
    if (personaId && row.personaId && row.personaId !== personaId) continue;
    if (!row.until || row.until <= now) { expired.push(row); continue; }
    unexpired.push(row);
  }
  // A scene-specific override outranks a context-free one, and the newest wins inside a
  // rank: "直到明天早上" is a stronger statement than an untargeted leftover.
  const ranked = unexpired
    .filter(row => overrideAppliesTo(row, context))
    .sort((a, b) => {
      const rank = row => (row.context === OVERRIDE_CONTEXT_ANY ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(b) - rank(a);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  return { active: ranked[0] ?? null, candidates: ranked, expired };
}

function missingFor(reason, extra = {}) {
  return {
    ok: false,
    code: reason,
    reason,
    hint: MISSING_REASONS[reason] ?? '当前穿着无法确定；不要编造衣物。',
    ...extra,
  };
}

/**
 * Resolve the current outfit.
 *
 * @param {object} input
 * @param {string} input.root            companion data root (contains `home/`)
 * @param {string} [input.personaId]     persona bound to this session
 * @param {string} [input.sessionId]     session id; `qq-group-*` returns `wardrobe-unavailable-in-group`
 * @param {number} [input.now]           wall clock (ms); injectable for tests
 * @param {string} [input.timeZone]      overrides the configured zone
 * @param {object} [input.activity]      the currently running activity, if any
 * @param {object} [input.schedule]      a schedule occurrence whose window contains now
 * @param {object|string} [input.explicit] this turn's explicit request
 */
export function resolveWardrobeState({
  root,
  personaId = '',
  sessionId = '',
  now = Date.now(),
  timeZone = '',
  activity = null,
  schedule = null,
  explicit = null,
  config = null,
  document = null,
} = {}) {
  if (String(sessionId ?? '').startsWith(GROUP_SESSION_PREFIX)) {
    return missingFor('wardrobe-unavailable-in-group', { personaId, sessionId, source: 'wardrobe-resolver' });
  }
  const settings = config ?? loadWardrobeConfig(root, { timeZone });
  const zone = settings.timeZone;
  // `document` lets a caller that already holds the parsed wardrobe (the media layer, the
  // shipped tests, `currentOutfit`) resolve against it directly instead of re-reading the
  // file. It is the same document shape, so the answer is still identical.
  const loaded = document
    ? { ok: true, code: 'ok', file: '', seeded: false, wardrobe: document }
    : loadWardrobeFor({ root, personaId, now });
  if (!loaded.ok) {
    return missingFor(loaded.code ?? 'wardrobe-unreadable', { personaId, sessionId, file: loaded.file ?? '', source: 'wardrobe-resolver' });
  }
  const wardrobe = loaded.wardrobe;
  const date = localDate(now, zone);

  // Classification runs **without** the explicit request first: the automatic scene is
  // what an override is judged against ("does this override fit where she actually is?")
  // and it is also the fallback scene when the turn only names items, not a scene.
  const auto = classifyContext({ now, config: settings, activity, schedule, explicit: null });
  const explicitContext = typeof explicit === 'string'
    ? explicit
    : (explicit && typeof explicit === 'object' ? String(explicit.context ?? '') : '');
  const explicitPieces = explicit && typeof explicit === 'object' ? normalizePieces(explicit.pieces) : normalizePieces({});
  const hasExplicitPieces = Object.values(explicitPieces).some(Boolean);
  const overrides = applicableOverrides(wardrobe, { now, context: auto.context, personaId });

  let context = auto.context;
  let reason = auto.reason;
  let selectedPieces = null;
  let outfitId = '';
  let overrideView = null;
  const reasons = [...auto.reasons];

  if (WARDROBE_CONTEXTS.includes(explicitContext)) {
    context = explicitContext;
    reason = 'explicit-turn';
    reasons.push('explicit-turn');
  } else if (hasExplicitPieces) {
    selectedPieces = explicitPieces;
    reason = 'explicit-turn';
    reasons.push('explicit-turn');
  } else if (overrides.active) {
    selectedPieces = overrides.active.pieces;
    reason = 'override-active';
    reasons.push('override-active');
    if (overrides.active.context !== OVERRIDE_CONTEXT_ANY && WARDROBE_CONTEXTS.includes(overrides.active.context)) {
      context = overrides.active.context;
    }
    overrideView = {
      id: overrides.active.id,
      context: overrides.active.context,
      until: overrides.active.until,
      instruction: overrides.active.instruction ?? '',
      source: overrides.active.source ?? '',
      expired: false,
      legacy: overrides.active.legacy === true,
    };
  }

  // Pick the outfit only when nothing above already fixed the pieces.
  if (!selectedPieces) {
    const picked = selectOutfitForContext(wardrobe, { context, date, personaId });
    if (!picked) {
      // No silent fallback to another scene (contract §6): report the gap and name the
      // scenes that *could* be dressed, so the answer can be concrete instead of a shrug.
      return missingFor('no-outfits-for-context', {
        personaId, sessionId, date, context, contextLabel: WARDROBE_CONTEXT_LABELS[context] ?? context,
        reason, reasons, alternative: auto.context, source: 'wardrobe-resolver',
        availableContexts: WARDROBE_CONTEXTS.filter(row => outfitCandidates(wardrobe, row).length > 0),
      });
    }
    selectedPieces = picked.pieces;
    outfitId = picked.id;
    if (reason === 'explicit-turn' || reason === 'override-active') reasons.push(hasExplicitPieces ? 'explicit-pieces' : 'rotation');
    else reasons.push('rotation');
  }

  const pieces = resolvePieces(wardrobe, selectedPieces);
  const missing = WARDROBE_SLOTS.filter(slot => !pieces[slot]);
  const unresolved = WARDROBE_SLOTS.filter(slot => selectedPieces?.[slot] && !pieces[slot]);
  if (unresolved.length) {
    return missingFor('outfit-pieces-unresolvable', {
      personaId, sessionId, date, context, contextLabel: WARDROBE_CONTEXT_LABELS[context] ?? context,
      missing, unresolved, reason, reasons, source: 'wardrobe-resolver',
    });
  }
  if (!Object.values(pieces).some(Boolean)) {
    return missingFor('outfit-pieces-unresolvable', {
      personaId, sessionId, date, context, contextLabel: WARDROBE_CONTEXT_LABELS[context] ?? context,
      missing, reason, reasons, source: 'wardrobe-resolver',
    });
  }

  return {
    ok: true,
    code: 'ok',
    personaId,
    sessionId,
    date,
    context,
    contextLabel: WARDROBE_CONTEXT_LABELS[context] ?? context,
    outfitId: outfitId || (overrideView ? `override:${overrideView.id}` : ''),
    outfit: selectedPieces,
    pieces: Object.fromEntries(WARDROBE_SLOTS.map(slot => [slot, pieceView(pieces[slot])])),
    reason,
    reasons,
    source: 'wardrobe-resolver',
    override: overrideView,
    isOverride: Boolean(overrideView),
    missing,
    rotationKey: `${date}|${personaId}|${context}`,
    nightWindow: auto.nightWindow,
    clock: auto.clock,
    activity: auto.activity ? { title: auto.activity.title ?? '', kind: auto.activity.activity ?? auto.activity.kind ?? '' } : null,
    wardrobeFile: loaded.file,
    seeded: loaded.seeded === true,
    migratedFrom: loaded.migratedFrom ?? 0,
    notes: [],
  };
}

/** Chinese one-line summary of a resolved state, used by tools and reports. */
export function describeWardrobeState(state) {
  if (!state) return '无法确定当前穿着。';
  if (!state.ok) return `${state.hint ?? '无法确定当前穿着。'}（${state.code}）`;
  const rows = WARDROBE_SLOTS
    .filter(slot => state.pieces?.[slot])
    .map(slot => `${WARDROBE_SLOT_LABELS[slot]}：${state.pieces[slot].nameZh || state.pieces[slot].nameEn}`);
  const where = state.contextLabel ?? state.context;
  return [`场景：${where}`, ...rows].join('\n');
}

/**
 * English clothing clause for image generation. **English is authoritative** — this is
 * the text the media layer puts into the prompt, so a Chinese-only wardrobe item is
 * reported as a gap instead of being guessed at.
 */
export function wardrobeEnglishClause(state) {
  if (!state?.ok) return { ok: false, code: state?.code ?? 'unresolved', clause: '', missingEnglish: [] };
  const parts = [];
  const missingEnglish = [];
  for (const slot of ['whole', 'upper', 'lower', 'feet', 'extra']) {
    const piece = state.pieces?.[slot];
    if (!piece) continue;
    const text = String(piece.descEn || piece.nameEn || '').trim();
    if (!text) { missingEnglish.push(slot); continue; }
    parts.push(text);
  }
  if (!parts.length) return { ok: false, code: 'no-english-description', clause: '', missingEnglish };
  return { ok: true, code: 'ok', clause: parts.join(', '), missingEnglish };
}

/**
 * The `agent/pre-step` snapshot. Short by design (the brief caps the added prompt
 * budget): it says the scene, the visible pieces, where the answer came from, and the
 * one thing that must not be inferred (sleepwear ≠ asleep).
 */
export function renderWardrobeSnapshot(state, { maxChars = 480 } = {}) {
  if (!state?.ok) {
    const hint = state?.hint ?? '当前穿着无法确定；不要编造衣物。';
    return `【当前穿着】\n${hint}`.slice(0, maxChars);
  }
  const rows = [];
  for (const slot of ['whole', 'upper', 'lower', 'feet', 'extra']) {
    const piece = state.pieces?.[slot];
    if (!piece) continue;
    rows.push(`- ${WARDROBE_SLOT_LABELS[slot]}：${piece.descZh || piece.nameZh || piece.nameEn}`);
  }
  const emptySlots = WARDROBE_SLOTS.filter(slot => !state.pieces?.[slot]);
  // Only "feet" is worth stating when it is empty: barefoot is a fact about the scene
  // (in bed, indoors), while "no whole-dress" is noise for a two-piece outfit.
  const emptyText = emptySlots.includes('feet') ? '- 鞋袜：没有穿鞋（在室内/已躺下）' : '';
  const source = state.isOverride
    ? `衣柜显式覆盖（${state.override?.instruction || '无说明'}，至 ${formatUntil(state.override?.until, state.nightWindow?.timeZone)}）`
    : `衣柜自动解析（${state.reason}）`;
  const lines = [
    '【当前穿着】',
    `场景：${state.contextLabel}`,
    ...rows,
    ...(emptyText ? [emptyText] : []),
    `状态来源：${source}`,
    '这是现在真实穿着的衣物；被问到穿着时按这里回答。穿着睡衣只说明换了睡衣，不代表已经睡着，也不要据此推断睡眠时长。',
  ];
  return lines.join('\n').slice(0, maxChars);
}

function formatUntil(until, timeZone = 'Asia/Shanghai') {
  const value = Number(until);
  if (!Number.isFinite(value) || value <= 0) return '未设置';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone, hourCycle: 'h23', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

/**
 * Which contexts can be resolved right now, and why the others cannot.
 *
 * The brief (§6) forbids silently falling back to the wrong scene when an outfit is
 * missing, so the honest answer is a per-scene report the model can quote.
 */
export function wardrobeContextReport({ root, personaId = '', sessionId = '', now = Date.now(), config = null } = {}) {
  const settings = config ?? loadWardrobeConfig(root, {});
  const rows = [];
  for (const context of WARDROBE_CONTEXTS) {
    // Forcing the scene is the question being asked ("can this scene be dressed at all?"),
    // which is exactly what an explicit context does. The reported `reason` is therefore
    // `explicit-turn` for every row; `code` and `missing` are the real answers.
    const state = resolveWardrobeState({ root, personaId, sessionId, now, config: settings, explicit: { context } });
    rows.push({
      context,
      label: WARDROBE_CONTEXT_LABELS[context],
      ok: state.ok === true,
      code: state.code,
      outfitId: state.outfitId ?? '',
      missing: state.missing ?? [],
    });
  }
  return { ok: rows.some(row => row.ok), contexts: rows, timeZone: settings.timeZone };
}
