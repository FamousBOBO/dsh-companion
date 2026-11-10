/** Persona wardrobe — compat facade over the v2 model, plus the two write paths.
 *
 * History: v1 of this file (still readable below as the outer API) could only answer
 * "what do I own" and "today's deterministic outfit". It had no scene concept, no
 * sleepwear, and a single `current` slot that expired at midnight. The v2 work is spread
 * over three modules so each one can be tested alone:
 *
 *   wardrobe-schema.mjs    persisted shape, seed inventory, reversible v1 → v2 migration
 *   wardrobe-context.mjs   clock + life classification (everyday/home/sleep/outdoor/special)
 *   wardrobe-state.mjs     priority resolution: explicit → override → activity → window → rotation
 *   wardrobe-evidence.mjs  what the runtime says is happening *now* (never a plan)
 *
 * This file keeps the historical entry points working (`loadWardrobe`, `saveWardrobe`,
 * `currentOutfit`, `wardrobeDetail`, `setOutfit`, `renderWardrobePrompt`) because the
 * media plugin and the shipped tests import them. Two of them carry a documented
 * behaviour change:
 *
 *   - `wardrobeDetail(scope='today')` now answers with the **resolved current state**
 *     (scene, reason, missing slots) instead of "today's rotation". Old fields are still
 *     present, so a caller that only reads `items`/`source`/`instruction` is unaffected.
 *   - `setOutfit` writes a **timed override** instead of the v1 `current` slot, and
 *     accepts `context` / `until` / `clearOverride`. The old call shape (itemIds +
 *     instruction) still means "wear this for the rest of the local day".
 *
 * Nothing here sends, schedules, calls a model or touches memory. The only writes are
 * the wardrobe file itself (atomic, with a `.previous` copy).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  OVERRIDE_CONTEXT_ANY,
  SEED_REVISION,
  WARDROBE_CONTEXTS,
  WARDROBE_CONTEXT_LABELS,
  WARDROBE_SCHEMA_VERSION,
  WARDROBE_SLOTS,
  WARDROBE_SLOT_LABELS,
  baseWardrobeFile,
  commitMigration,
  endOfLocalDay,
  loadWardrobeFor,
  localDate,
  normalizeItem,
  normalizeOutfit,
  normalizeOverride,
  normalizePieces,
  normalizeWardrobe,
  resolvePieces,
  saveWardrobeFor,
  seedWardrobe,
  selectOutfitForContext,
  wardrobeFileFor,
  wardrobeSeed,
} from './wardrobe-schema.mjs';
import { loadWardrobeConfig } from './wardrobe-context.mjs';
import {
  describeWardrobeState,
  renderWardrobeSnapshot,
  resolveWardrobeState,
  wardrobeContextReport,
  wardrobeEnglishClause,
} from './wardrobe-state.mjs';

/** Kept for import compatibility with v1 callers; the real version is v2. */
export const WARDROBE_VERSION = WARDROBE_SCHEMA_VERSION;
export { WARDROBE_SLOTS, WARDROBE_SLOT_LABELS, WARDROBE_CONTEXTS, WARDROBE_CONTEXT_LABELS, SEED_REVISION };

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** v2 document for a root (persona-unaware; the tools pass the persona explicitly). */
export function loadWardrobe(root, { personaId = '', now = Date.now() } = {}) {
  const loaded = loadWardrobeFor({ root, personaId, now });
  if (loaded.ok && loaded.wardrobe) return loaded.wardrobe;
  return seedWardrobe({ personaId, now });
}

/**
 * Persist a document for a root.
 *
 * v1-shaped payloads (`{items:[{name,slot,description}], current:{...}}`) are accepted and
 * upgraded on the way in, because that is exactly what the media tests and any third-party
 * script still pass.
 */
export function saveWardrobe(root, wardrobe, { personaId = '', now = Date.now() } = {}) {
  const version = Number(wardrobe?.schemaVersion ?? wardrobe?.version);
  const document = version >= WARDROBE_SCHEMA_VERSION
    ? normalizeWardrobe(wardrobe, { personaId, now })
    : {
      ...normalizeWardrobe(wardrobe, { personaId, now }),
      items: (wardrobe?.items ?? []).map(normalizeItem).filter(Boolean),
      outfits: (wardrobe?.outfits ?? []).map(normalizeOutfit).filter(Boolean),
      overrides: (wardrobe?.overrides ?? []).map(normalizeOverride).filter(Boolean),
    };
  const saved = saveWardrobeFor({ root, personaId: personaId || document.ownerPersona, wardrobe: document, now });
  return saved.wardrobe;
}

/** v1 shape of one resolved item, so old renderers keep working. */
function legacyItem(piece) {
  if (!piece) return null;
  return {
    id: piece.id,
    slot: piece.slot,
    name: piece.nameZh || piece.nameEn,
    nameZh: piece.nameZh,
    nameEn: piece.nameEn,
    description: piece.descZh || piece.descEn,
    descriptionEn: piece.descEn,
  };
}

/**
 * Deterministic outfit for the current scene, computed **without** touching the runtime.
 *
 * Kept because it is the pure, synchronous primitive the shipped tests assert on and the
 * media plugin used to import. Anything that can see the runtime should call
 * `resolveWardrobeState` instead, which additionally honours activity/override evidence.
 */
export function currentOutfit(wardrobe, now = Date.now(), timeZone = 'Asia/Shanghai') {
  const normalized = normalizeWardrobe(wardrobe, { now });
  const zone = normalized.timeZone || timeZone;
  const date = localDate(now, zone);
  const config = { ...loadWardrobeConfig(process.cwd(), { timeZone: zone }), timeZone: zone };
  const state = resolveWardrobeState({ root: '', personaId: normalized.ownerPersona, now, config, document: normalized });
  if (state.ok) {
    return {
      date,
      source: state.isOverride ? 'explicit' : 'daily',
      instruction: state.override?.instruction ?? '',
      items: WARDROBE_SLOTS.map(slot => legacyItem(state.pieces?.[slot])).filter(Boolean),
      context: state.context,
      reason: state.reason,
      outfitId: state.outfitId,
    };
  }
  return { date, source: 'missing', instruction: '', items: [], context: state.context ?? '', reason: state.code ?? 'unresolved' };
}

function itemLine(item, { withDescription = true } = {}) {
  const label = WARDROBE_SLOT_LABELS[item.slot] ?? item.slot;
  const description = withDescription && item.description ? `（${item.description}）` : '';
  return `${label}：${item.name}${description}`;
}

/**
 * Legacy full-wardrobe prompt renderer.
 *
 * **Not registered as a system-prompt section any more.** The section is now a short
 * static truthfulness rule and the current outfit arrives per turn through
 * `agent/pre-step` (`renderWardrobeSnapshot`), which is what stops the same clothes being
 * injected twice and stops "today's rotation" masquerading as "what she is wearing now".
 * The function stays for compatibility and for the `scope=today` text body.
 */
export function renderWardrobePrompt(root, now = Date.now(), timeZone = 'Asia/Shanghai', maxChars = 900) {
  const wardrobe = loadWardrobe(root, { now });
  const outfit = currentOutfit(wardrobe, now, timeZone);
  if (wardrobe.items.length === 0 && wardrobe.tendency === '') return '';
  const lines = ['【衣柜与当前衣物】'];
  if (wardrobe.tendency) lines.push(`整体服饰倾向：${wardrobe.tendency}`);
  if (outfit.items.length > 0) {
    const why = outfit.source === 'explicit'
      ? '，用户/剧情指定'
      : `，按衣柜轮换（${WARDROBE_CONTEXT_LABELS[outfit.context] ?? outfit.context}）`;
    lines.push(`今天穿（${outfit.date}${why}）：`);
    for (const item of outfit.items) lines.push(`- ${itemLine(item)}`);
    if (outfit.instruction) lines.push(`换装说明：${outfit.instruction}`);
  } else {
    lines.push('衣柜里还没有可穿的衣物；不要凭空编造穿着。');
  }
  lines.push('这是当前真实着装；需要衣物的细节描述再调用 companion_wardrobe_detail，不要声称衣柜里没有的衣服。');
  return lines.join('\n').slice(0, maxChars);
}

/**
 * The static system-prompt section.
 *
 * Intentionally contains **no clothing items and no current outfit**: those arrive per
 * turn from the resolver. It only states the rule that keeps the character from inventing
 * clothes, which is exactly what the brief (§8.6) asks to keep.
 */
export function renderWardrobeConstraint() {
  return '【穿着规则】当前穿什么由【当前穿着】段落给出，它来自衣柜的真实状态；没有这一段就说明现在无法确定，被问到穿着时如实说不知道，不要编造衣物、颜色或配饰。衣柜里没有的衣服不能声称正在穿。';
}

/**
 * `companion_wardrobe_detail`.
 *
 * `scope=today` (default) is the resolved current state; `slot` and `all` keep their v1
 * inventory meaning; `contexts` is new and reports per-scene availability so a missing
 * sleepwear set becomes an honest answer instead of the wrong outfit.
 */
export function wardrobeDetail(root, {
  scope = 'today', slot = '', now = Date.now(), timeZone = 'Asia/Shanghai',
  personaId = '', sessionId = '', context = '', activity = null, schedule = null,
} = {}) {
  const cleanScope = text(scope, 20) || 'today';
  const config = loadWardrobeConfig(root, { timeZone });
  const loaded = loadWardrobeFor({ root, personaId, now });
  const wardrobe = loaded.wardrobe ?? seedWardrobe({ personaId, now });

  if (cleanScope === 'slot') {
    if (!WARDROBE_SLOTS.includes(slot)) return { ok: false, code: 'need-slot', text: `请给出部位：${WARDROBE_SLOTS.join(' / ')}` };
    const rows = wardrobe.items.filter(item => item.slot === slot);
    return {
      ok: true, scope: 'slot', slot, count: rows.length,
      items: rows.map(item => ({ ...item, name: item.name.zh || item.name.en, description: item.description.zh || item.description.en })),
      text: rows.map(item => itemLine({ ...item, name: item.name.zh || item.name.en, description: item.description.zh || item.description.en })).join('\n') || '这个部位还没有衣物。',
    };
  }
  if (cleanScope === 'all') {
    const rows = wardrobe.items.map(item => ({ ...item, name: item.name.zh || item.name.en, description: item.description.zh || item.description.en }));
    return { ok: true, scope: 'all', tendency: wardrobe.tendency, count: rows.length, items: rows, text: rows.map(itemLine).join('\n') || '衣柜是空的。' };
  }
  if (cleanScope === 'contexts') {
    const report = wardrobeContextReport({ root, personaId, sessionId, now, config });
    return {
      ok: report.ok, scope: 'contexts', timeZone: report.timeZone, contexts: report.contexts,
      text: report.contexts.map(row => `${row.label}：${row.ok ? `可用（${row.outfitId}）` : `不可用（${row.code}）`}`).join('\n'),
    };
  }

  const state = resolveWardrobeState({
    root, personaId, sessionId, now, config, activity, schedule,
    explicit: WARDROBE_CONTEXTS.includes(text(context, 20)) ? { context: text(context, 20) } : null,
  });
  if (!state.ok) {
    return {
      ok: false, scope: 'today', code: state.code, hint: state.hint, context: state.context ?? '', reason: state.reason ?? state.code,
      availableContexts: state.availableContexts ?? [], items: [], text: state.hint ?? '当前穿着无法确定。',
      resolver: 'wardrobe-resolver', source: 'missing',
    };
  }
  const items = WARDROBE_SLOTS.map(row => legacyItem(state.pieces?.[row])).filter(Boolean);
  return {
    ok: true,
    scope: 'today',
    date: state.date,
    source: state.isOverride ? 'explicit' : (state.outfitId ? 'scene:rotation' : 'scene:default'),
    instruction: state.override?.instruction ?? '',
    items,
    // ── v2 additions (compatible superset of the v1 response) ──
    context: state.context,
    contextLabel: state.contextLabel,
    outfitId: state.outfitId,
    reason: state.reason,
    reasons: state.reasons,
    override: state.override,
    isOverride: state.isOverride,
    missing: state.missing,
    pieces: state.pieces,
    rotationKey: state.rotationKey,
    resolver: 'wardrobe-resolver',
    seeded: state.seeded,
    migratedFrom: state.migratedFrom,
    text: [
      `场景：${state.contextLabel}（${state.reason}）`,
      ...items.map(itemLine),
      state.missing.length ? `未穿：${state.missing.map(row => WARDROBE_SLOT_LABELS[row]).join('、')}` : '',
      state.isOverride ? `覆盖说明：${state.override?.instruction || '无'}` : '',
    ].filter(Boolean).join('\n'),
  };
}

function parseUntil(input, { now, timeZone }) {
  if (input === undefined || input === null || input === '') return endOfLocalDay(localDate(now, timeZone), timeZone);
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const raw = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return endOfLocalDay(raw, timeZone);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) {
    const parsed = Date.parse(raw.replace(' ', 'T'));
    if (Number.isFinite(parsed)) return parsed;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : NaN;
}

/**
 * `companion_outfit_set` / clear.
 *
 * Semantics, in the order the brief asks for:
 *  - an explicit change takes effect immediately (it is the highest priority next turn);
 *  - it is **timed** (`until`, default = end of the local day) instead of a bare `current`
 *    slot, so an expired override falls back to automatic resolution by itself;
 *  - it can name the scene it belongs to (`context`), which is what makes a daytime
 *    `home` override stop blocking sleepwear at 22:40;
 *  - `clearOverride` removes the override instead of writing one.
 */
export function setOutfit(root, {
  itemIds = [], instruction = '', now = Date.now(), timeZone = 'Asia/Shanghai',
  context = '', until = undefined, clearOverride = false, personaId = '', sessionId = '',
} = {}) {
  const config = loadWardrobeConfig(root, { timeZone });
  const zone = timeZone || config.timeZone;
  if (String(sessionId ?? '').startsWith('qq-group-')) {
    return { ok: false, code: 'wardrobe-unavailable-in-group', text: '群聊里不改私人衣柜。' };
  }
  const loaded = loadWardrobeFor({ root, personaId, now });
  if (!loaded.ok || !loaded.wardrobe) {
    return { ok: false, code: loaded.code ?? 'wardrobe-unreadable', text: '读不到衣柜文件；不要凭印象说换了衣服。' };
  }
  const wardrobe = loaded.wardrobe;

  if (clearOverride === true) {
    const scene = WARDROBE_CONTEXTS.includes(text(context, 20)) ? text(context, 20) : '';
    const kept = [];
    let removed = 0;
    for (const row of wardrobe.overrides) {
      if (row.until > now && (!scene || row.context === scene || row.context === OVERRIDE_CONTEXT_ANY)) {
        removed += 1;
        continue;
      }
      kept.push(row);
    }
    // The v1 `current` slot is a second source of overrides (read-only mirror). Clearing
    // the override therefore has to blank it too, or "cleared" would keep applying.
    const saved = saveWardrobeFor({ root, personaId: personaId || wardrobe.ownerPersona, now, wardrobe: { ...wardrobe, overrides: kept, current: null } });
    return {
      ok: true, cleared: removed, context: scene || OVERRIDE_CONTEXT_ANY,
      wardrobe: saved.wardrobe,
      text: removed ? `已清除 ${removed} 条换装覆盖；接下来按场景自动解析。` : '没有生效中的换装覆盖。',
    };
  }

  const ids = Array.isArray(itemIds) ? itemIds.map(id => text(id, 80)).filter(Boolean) : [];
  const resolved = ids.map(id => wardrobe.items.find(item => item.id === id || item.name.zh === id || item.name.en === id || item.name === id)).filter(Boolean);
  if (resolved.length === 0) return { ok: false, code: 'item-not-found', text: '没有找到这些衣物；先用 companion_wardrobe_detail 查看衣柜。' };

  const untilValue = parseUntil(until, { now, timeZone: zone });
  if (!Number.isFinite(untilValue) || untilValue <= now) {
    return { ok: false, code: 'bad-until', text: '覆盖有效期无法解析或已经过期；give until as YYYY-MM-DD, ISO time, or Unix ms.' };
  }
  const scene = WARDROBE_CONTEXTS.includes(text(context, 20)) ? text(context, 20) : OVERRIDE_CONTEXT_ANY;
  const pieces = normalizePieces(resolved.reduce((acc, item) => {
    if (item.slot === 'whole') acc.whole = item.id;
    else if (!acc[item.slot]) acc[item.slot] = item.id;
    return acc;
  }, {}));
  const override = normalizeOverride({
    personaId: personaId || wardrobe.ownerPersona,
    context: scene,
    pieces,
    instruction: text(instruction, 200),
    createdAt: now,
    until: untilValue,
    source: 'companion_outfit_set',
  });
  // Newest override first; expired ones are pruned only when they are older than a day, so
  // a report can still show what happened earlier today without the file growing forever.
  const kept = wardrobe.overrides.filter(row => row.id !== override.id && row.until > now - 86400_000);
  const saved = saveWardrobeFor({
    root, personaId: personaId || wardrobe.ownerPersona, now,
    wardrobe: { ...wardrobe, overrides: [override, ...kept], current: null },
  });
  const names = resolved.map(item => item.name.zh || item.name.en);
  return {
    ok: true,
    date: localDate(now, zone),
    items: resolved.map(item => ({ id: item.id, slot: item.slot, name: item.name.zh || item.name.en })),
    instruction: override.instruction,
    context: scene,
    until: untilValue,
    overrideId: override.id,
    wardrobe: saved.wardrobe,
    text: `已换成：${names.join('、')}${scene !== OVERRIDE_CONTEXT_ANY ? `（场景：${WARDROBE_CONTEXT_LABELS[scene]}）` : ''}，至 ${new Date(untilValue).toISOString()}`,
  };
}

export { describeWardrobeState, renderWardrobeSnapshot, resolveWardrobeState, wardrobeEnglishClause, wardrobeContextReport };
export { loadWardrobeConfig } from './wardrobe-context.mjs';
export { collectLifeEvidence, hasLiveEvidence } from './wardrobe-evidence.mjs';

export const wardrobeDefaults = Object.freeze({ items: wardrobeSeed.items, outfits: wardrobeSeed.outfits, tendency: wardrobeSeed.tendency, revision: SEED_REVISION });

export { baseWardrobeFile, localDate, resolvePieces, selectOutfitForContext, seedWardrobe, WARDROBE_SCHEMA_VERSION };

/** Diagnostics helper: the file actually in use for this persona (never another's). */
export function wardrobeFile(root, personaId = '') {
  return wardrobeFileFor(root, personaId).file;
}

/** True when the file exists on disk, as opposed to the in-memory seed. */
export function wardrobeInitialised(root, personaId = '') {
  try {
    return fs.existsSync(wardrobeFileFor(root, personaId).file);
  } catch { return false; }
}

/**
 * Commit the on-disk v1 → v2 upgrade for a persona, keeping a `.v1.bak` byte copy.
 *
 * Re-exported here because `wardrobe.mjs` is the module the suite's CLI and operators
 * already know; the migration itself lives in `wardrobe-schema.mjs` so it stays a pure,
 * testable function.
 */
export function upgradeWardrobeFile({ root, personaId = '', now = Date.now() } = {}) {
  return commitMigration({ root, personaId, now });
}
