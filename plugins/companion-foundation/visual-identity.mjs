/** Visual identity — the authoritative "who she is" data the media layer draws with.
 *
 * The audit found **no** visual-identity implementation in this repository on any branch:
 * `git grep -i "visual-identity|visualIdentity|resolveCompanionVisualState"` matched
 * nothing on main, dev, expressions, feat/prompt-engine and feat/group-social-p0. The
 * image prompt therefore had to hard-code the character description inside the tool
 * description text, which is exactly the drift the brief describes: the model wrote the
 * clothing itself and the picture disagreed with the wardrobe.
 *
 * This module is the missing half of `resolveCompanionVisualState()`: identity data, keyed
 * by persona, read from a file the operator owns. It **never guesses**: a missing file, a
 * missing persona entry, or an empty appearance returns `state: 'not-configured'` with an
 * empty English clause, and the media layer then declines to claim it drew the character.
 *
 * File shape (`<root>/home/companion/visual-identity.json`, git-ignored with the rest of
 * `home/`):
 *
 *   {
 *     "schemaVersion": 1,
 *     "personas": {
 *       "<personaId>": {
 *         "name":    { "zh": "…", "en": "…" },
 *         "source":  { "zh": "…", "en": "…" },     // the work the character comes from
 *         "appearance": { "zh": "…", "en": "…" },  // invariant looks: hair, eyes, build
 *         "provenance": { "source": "user", "updatedAt": "2026-11-10T…" }
 *       }
 *     }
 *   }
 *
 * Nothing here is written into memory, health or sleep data, and nothing here is generated
 * by a model: it is operator-authored text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WARDROBE_SLOTS } from './wardrobe-schema.mjs';
import { wardrobeEnglishClause, wardrobeContextReport, resolveWardrobeState } from './wardrobe-state.mjs';
import { loadWardrobeConfig } from './wardrobe-context.mjs';

export const VISUAL_IDENTITY_SCHEMA_VERSION = 1;

export function visualIdentityFile(root) {
  return path.join(root, 'home/companion/visual-identity.json');
}

function text(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function localeText(value, max = 400) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { zh: text(value.zh, max), en: text(value.en, max) };
  }
  return { zh: text(value, max), en: '' };
}

/** Read one persona's identity. Never throws; a broken file is `unreadable`, not `guess`. */
export function loadVisualIdentity({ root, personaId = '' } = {}) {
  const file = visualIdentityFile(root);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, code: 'identity-missing', state: 'not-configured', file, identity: null };
    }
    return { ok: false, code: 'identity-unreadable', state: 'not-configured', file, identity: null, detail: String(error?.message ?? error).slice(0, 200) };
  }
  const personas = parsed && typeof parsed === 'object' ? parsed.personas : null;
  // `typeof [] === 'object'`, so an array has to be rejected explicitly: otherwise a file with
  // `"personas": []` would be reported as "missing for this persona" instead of "invalid",
  // which sends the operator looking for the wrong thing.
  if (!personas || typeof personas !== 'object' || Array.isArray(personas)) {
    return { ok: false, code: 'identity-invalid', state: 'not-configured', file, identity: null };
  }
  // The persona key is tried literally first; an installation that renamed the persona id
  // keeps its identity only if it also renamed the key, and that is deliberate: silently
  // borrowing another persona's appearance is the failure mode this guards against.
  const row = personas[personaId];
  if (!row || typeof row !== 'object') {
    return { ok: false, code: 'identity-missing-for-persona', state: 'not-configured', file, identity: null, available: Object.keys(personas).slice(0, 10) };
  }
  const identity = {
    name: localeText(row.name, 80),
    source: localeText(row.source, 120),
    appearance: localeText(row.appearance, 600),
    provenance: row.provenance && typeof row.provenance === 'object'
      ? { source: text(row.provenance.source, 40) || 'user', updatedAt: text(row.provenance.updatedAt, 40) }
      : { source: 'user', updatedAt: '' },
  };
  const complete = Boolean((identity.name.en || identity.name.zh) && (identity.appearance.en || identity.appearance.zh));
  return { ok: complete, code: complete ? 'ok' : 'identity-incomplete', state: complete ? 'configured' : 'not-configured', file, identity };
}

/** Identity clause for an English image prompt, or a reason it is unavailable. */
export function identityEnglishClause(identity) {
  if (!identity) return { ok: false, code: 'identity-missing', clause: '' };
  const parts = [];
  const name = text(identity.name?.en, 80);
  const source = text(identity.source?.en, 120);
  if (name && source) parts.push(`${name} from ${source}`);
  else if (name) parts.push(name);
  const appearance = text(identity.appearance?.en, 600);
  if (appearance) parts.push(appearance);
  if (!parts.length) return { ok: false, code: 'identity-missing', clause: '' };
  return { ok: true, code: 'ok', clause: parts.join(', ') };
}

/**
 * **The one read-only resolution both the prompt and the media layer use.**
 *
 * Returns identity (from `visual-identity.json`) and the current outfit (from the wardrobe
 * resolver) for the **same** persona, plus a single English `imageClause` that already
 * contains both. Requirements from the brief (§9) that this shape enforces:
 *
 *  - identity comes from identity data, clothing comes from the wardrobe, and neither is
 *    invented by a model;
 *  - both are keyed by the same `personaId`, so a persona switch cannot leave the previous
 *    persona's face or clothes behind;
 *  - the result is read-only: it exposes no data directory, no file handles and no writer,
 *    which is what makes it safe to publish across the plugin boundary;
 *  - `subject=other` callers simply do not call it.
 *
 * @param {object} input
 * @param {string} input.root       companion data root
 * @param {string} input.personaId  persona bound to the session
 * @param {string} [input.sessionId]
 * @param {number} [input.now]
 * @param {string} [input.timeZone]
 * @param {object} [input.activity] currently running activity (evidence, not a plan)
 * @param {object} [input.schedule] schedule occurrence whose window contains now
 */
export function resolveCompanionVisualState({
  root,
  personaId = '',
  sessionId = '',
  now = Date.now(),
  timeZone = '',
  activity = null,
  schedule = null,
  explicit = null,
} = {}) {
  const identityLoaded = loadVisualIdentity({ root, personaId });
  const wardrobe = resolveWardrobeState({
    root, personaId, sessionId, now, timeZone, activity, schedule, explicit,
  });
  const clothing = wardrobeEnglishClause(wardrobe);
  const identityClause = identityEnglishClause(identityLoaded.identity);

  const missing = [];
  if (!identityLoaded.ok) missing.push('identity');
  if (!wardrobe.ok) missing.push('wardrobe');
  if (wardrobe.ok && !clothing.ok) missing.push('wardrobe-english');

  // The clause is only ever assembled from the two authoritative halves. A partial
  // resolution is reported as partial: the media layer must be able to refuse rather than
  // draw half a character and let the model fill the rest in.
  const parts = [];
  if (identityClause.ok) parts.push(identityClause.clause);
  if (clothing.ok) parts.push(`wearing ${clothing.clause}`);
  const imageClause = parts.join(', ');

  return {
    ok: missing.length === 0,
    code: missing.length === 0 ? 'ok' : (wardrobe.ok ? identityLoaded.code : wardrobe.code),
    personaId,
    sessionId,
    at: Number(now) || Date.now(),
    identity: {
      state: identityLoaded.state,
      code: identityLoaded.code,
      name: identityLoaded.identity?.name?.zh || identityLoaded.identity?.name?.en || '',
      nameEn: identityLoaded.identity?.name?.en || '',
      source: identityLoaded.identity?.source?.zh || '',
      sourceEn: identityLoaded.identity?.source?.en || '',
      appearanceZh: identityLoaded.identity?.appearance?.zh || '',
      appearanceEn: identityLoaded.identity?.appearance?.en || '',
      provenance: identityLoaded.identity?.provenance ?? null,
    },
    wardrobe: {
      ok: wardrobe.ok === true,
      code: wardrobe.code ?? (wardrobe.ok ? 'ok' : 'unresolved'),
      context: wardrobe.context ?? '',
      contextLabel: wardrobe.contextLabel ?? '',
      outfitId: wardrobe.outfitId ?? '',
      reason: wardrobe.reason ?? '',
      isOverride: wardrobe.isOverride === true,
      override: wardrobe.override ?? null,
      pieces: wardrobe.pieces ?? {},
      missing: wardrobe.missing ?? [],
      source: 'wardrobe-resolver',
      hint: wardrobe.hint ?? '',
      clothingClause: clothing.ok ? clothing.clause : '',
      missingEnglish: clothing.missingEnglish ?? [],
    },
    identityClause: identityClause.ok ? identityClause.clause : '',
    imageClause,
    missing,
    notes: [
      ...(identityLoaded.ok ? [] : [`identity:${identityLoaded.code}`]),
      ...(wardrobe.ok ? [] : [`wardrobe:${wardrobe.code}`]),
    ],
  };
}

/** Slot-ordered, human-readable summary for diagnostics pages and reports. */
export function describeVisualState(state) {
  if (!state) return '无法读取角色视觉状态。';
  const rows = [];
  rows.push(`人格：${state.personaId || '(未指定)'}`);
  rows.push(`身份：${state.identity?.state === 'configured' ? `${state.identity.name}（${state.identity.source}）` : `未配置（${state.identity?.code}）`}`);
  if (state.wardrobe?.ok) {
    rows.push(`场景：${state.wardrobe.contextLabel}（${state.wardrobe.reason}）`);
    for (const slot of WARDROBE_SLOTS) {
      const piece = state.wardrobe.pieces?.[slot];
      if (piece) rows.push(`  ${slot}: ${piece.nameZh || piece.nameEn}`);
    }
  } else {
    rows.push(`服装：无法确定（${state.wardrobe?.code}）`);
  }
  return rows.join('\n');
}

/**
 * Diagnostics: the per-scene availability of the wardrobe plus whether the identity file is
 * usable. No private text beyond the operator's own identity file.
 */
export function visualStateReport({ root, personaId = '', now = Date.now(), config = null } = {}) {
  const settings = config ?? loadWardrobeConfig(root, {});
  const identity = loadVisualIdentity({ root, personaId });
  const contexts = wardrobeContextReport({ root, personaId, now, config: settings });
  return {
    ok: identity.ok === true && contexts.ok === true,
    personaId,
    identity: { state: identity.state, code: identity.code, file: identity.file, name: identity.identity?.name?.zh ?? '' },
    contexts: contexts.contexts,
    timeZone: contexts.timeZone,
  };
}
