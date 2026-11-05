// Planning material assembly for P2 (contract v1.2 section 3, external-run gap).
//
// The real-host run planned `read "翻几页闲书"` with no `targetRef`: the model was handed an
// empty material object, so it had no persona, no public entry point and nothing it could
// copy into a source reference. The runtime already owns the DB-derived half (agenda,
// activities, receipts, interests, plans, budget); this module owns the half only the
// plugin can know — the character's own persona text, the real capability list and the
// concrete public sources — and assembles both into one labelled object.
//
// Two rules:
//   1. Nothing is invented. Every section either carries real content or says `missing`.
//   2. Nothing volatile leaks into the material: the planner re-reads it after the model
//      call and rejects the plan when the digest changed, so the public-source list is
//      cached per topic/day instead of being re-searched.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseScopeKey } from './autonomy-memory.mjs';

export const PERSONA_FILE = 'workspace/PERSONA.md';
export const MAX_PERSONA_CHARS = 1200;
export const DEFAULT_SEED_LIMIT = 3;
export const DEFAULT_SEED_VERIFY = 1;
export const MAX_OPPORTUNITY_SEEDS = 3;

/** The material sections this module can answer itself, in label order. */
export const FOUNDATION_SECTIONS = Object.freeze(['persona', 'capabilities', 'publicEntry', 'preferences']);
/** Sections that can only come from the runtime database (labelled `missing` without it). */
export const RUNTIME_SECTIONS = Object.freeze(['fixedAgenda', 'plan', 'lockedSlots', 'runningActivities', 'goals', 'commitments', 'interests', 'recentPlans', 'opportunities', 'budget']);

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

function textOf(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Plain-text summary of the persona file: headings and emphasis stripped, bounded.
 *
 * The text is *real* persona content (the same file the chat system prompt uses); the
 * version string is a short hash of the whole file so a persona edit changes the planning
 * material digest instead of silently reusing yesterday's reading of the character.
 */
export function personaSummary(raw, maxChars = MAX_PERSONA_CHARS) {
  const limit = Math.max(80, Math.trunc(Number(maxChars) || MAX_PERSONA_CHARS));
  const kept = [];
  let used = 0;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (/^```/.test(trimmed)) continue;
    const text = trimmed
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim();
    if (!text || /^[-=_]{3,}$/.test(text)) continue;
    if (used + text.length + 1 > limit) break;
    kept.push(text);
    used += text.length + 1;
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function firstText(...values) {
  for (const value of values) {
    const text = textOf(value).trim();
    if (text) return text.slice(0, 120);
  }
  return '';
}

/**
 * Build the materials port.
 *
 * @param root       companion root (persona + identity live under it)
 * @param identity   the foundation identity store (optional: persona id only)
 * @param web        the public web port from autonomy-web.mjs (optional)
 * @param options    { readRoots, artifactRoot, timeZone, personaFile, personaMaxChars,
 *                     seedLimit, seedVerify, continuity, now }
 */
export function createMaterialsPort({ root, identity = null, web = null, options = {} } = {}) {
  const base = path.resolve(root ?? '.');
  const personaFile = path.resolve(base, options.personaFile ?? PERSONA_FILE);
  const identityFile = path.resolve(base, 'home/companion/identity.json');
  const readRoots = Array.isArray(options.readRoots) ? options.readRoots : [];
  const artifactRoot = textOf(options.artifactRoot).trim();
  const seedLimit = Math.max(1, Math.trunc(Number(options.seedLimit) || DEFAULT_SEED_LIMIT));
  const seedVerify = Math.max(0, Math.trunc(Number(options.seedVerify ?? DEFAULT_SEED_VERIFY) || 0));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  function personaId() {
    try {
      const identityValue = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      return textOf(identityValue?.persona).trim();
    } catch { return ''; }
  }

  function readPersonaFile() {
    try { return fs.readFileSync(personaFile, 'utf8'); } catch { return ''; }
  }

  /** Real persona summary, or `null` when the file is missing (never an empty string). */
  function persona() {
    const raw = readPersonaFile();
    if (!raw.trim()) return null;
    const excerpt = personaSummary(raw, options.personaMaxChars ?? MAX_PERSONA_CHARS);
    if (!excerpt) return null;
    return { excerpt, version: sha256(raw).slice(0, 8), source: options.personaFile ?? PERSONA_FILE, personaId: personaId() };
  }

  /**
   * Explicit life preferences. The foundation has no truthful store for these (the memory
   * engine owns user preferences and this module must not open it), so the honest answer is
   * an empty list with `preferencesSource:'missing'` unless the runtime supplies one.
   */
  function preferences() {
    return { items: [], source: 'missing' };
  }

  /** P1 goals/commitments for one scope through the injected provider. */
  function continuity({ scopeKey } = {}) {
    const scope = parseScopeKey(scopeKey);
    if (!scope) return { goals: [], commitments: [], source: 'missing', reason: 'scope-unparsed' };
    if (typeof options.continuity !== 'function') return { goals: [], commitments: [], source: 'missing', reason: 'provider-absent', scope };
    let value;
    try { value = options.continuity({ scopeKey, scope }); } catch { return { goals: [], commitments: [], source: 'missing', reason: 'provider-failed', scope }; }
    if (!value || typeof value !== 'object') return { goals: [], commitments: [], source: 'missing', reason: 'provider-empty', scope };
    const goals = (Array.isArray(value.goals) ? value.goals : [])
      .map(goal => ({ title: textOf(goal?.title ?? goal?.proposition ?? '').slice(0, 100), deadlineAt: Number(goal?.deadlineAt ?? goal?.dueAt ?? 0) || 0 }))
      .filter(goal => goal.title);
    const commitments = (Array.isArray(value.commitments) ? value.commitments : [])
      .map(item => ({ body: textOf(item?.body ?? item?.text ?? item?.title ?? '').slice(0, 120), dueAt: Number(item?.dueAt ?? 0) || 0 }))
      .filter(item => item.body);
    // `state`/`reason` must survive this wrapper: they are how an absent or failed provider stays
    // distinguishable from "this user has no goals". Dropping them here was one of the reasons the
    // section could look wired while being empty.
    return {
      goals,
      commitments,
      source: textOf(value.source) || 'p1-runtime',
      state: textOf(value.state) || 'ok',
      reason: textOf(value.reason, 60),
    };
  }

  function webDescribe() {
    try { return web?.describe?.() ?? null; } catch { return null; }
  }

  /**
   * What the character can really do right now, as the prompt renderer expects it: an
   * array of `{name, available, reason}`. Runtime truth (when supplied) wins for the base
   * capabilities; search is added here because only this side owns the web port.
   */
  function capabilityList(runtime) {
    const described = webDescribe();
    const runtimeCaps = isRecord(runtime?.capabilities) ? runtime.capabilities : null;
    const pick = (id, fallback) => {
      const fromRuntime = runtimeCaps?.[id];
      if (fromRuntime && typeof fromRuntime === 'object') {
        return { name: id, available: fromRuntime.available === true, reason: fromRuntime.available === true ? '' : textOf(fromRuntime.reason) || 'unavailable' };
      }
      return { name: id, ...fallback };
    };
    const list = [
      pick('read', { available: readRoots.length > 0, reason: readRoots.length ? '' : 'no-read-roots' }),
      pick('explore', described?.explore ? { available: described.explore.available === true, reason: described.explore.reason || '' } : { available: false, reason: 'port-not-mounted' }),
      { name: 'search', available: described?.search?.available === true, reason: described?.search?.reason || (described ? '' : 'port-not-mounted') },
      pick('write', { available: Boolean(artifactRoot), reason: artifactRoot ? '' : 'no-artifact-root' }),
      pick('bilibili', { available: false, reason: 'provider-not-ready' }),
      pick('image', { available: false, reason: 'not-implemented' }),
      pick('media', { available: false, reason: 'not-implemented' }),
      pick('mc', { available: false, reason: 'not-implemented' }),
    ];
    return list;
  }

  /** The topic one planning run is about: soft direction, then goal, then open opportunity. */
  function topicOf(runtime) {
    return firstText(
      ...(Array.isArray(runtime?.interests) ? runtime.interests.map(item => item?.title) : []),
      ...(Array.isArray(runtime?.goals) ? runtime.goals.map(item => item?.title) : []),
      ...(Array.isArray(runtime?.continuity?.goals) ? runtime.continuity.goals.map(item => item?.title) : []),
      ...(Array.isArray(runtime?.opportunities) ? runtime.opportunities.map(item => item?.source) : []),
    );
  }

  /**
   * Budget gate handed to the web port. The port must not open a socket on an unreadable
   * day; when the runtime slice is present but its budget view is not, we say so instead of
   * spending blind.
   */
  function budgetGate(runtime) {
    if (!isRecord(runtime)) return undefined;
    const remaining = Number(runtime?.budget?.requests?.remaining);
    if (Number.isFinite(remaining)) return { remaining };
    return { ok: false, code: 'budget-unknown' };
  }

  async function publicEntry(runtime, scopeKey, at) {
    const entry = { source: 'config.p2.autonomy', allowedSources: [], seedUrls: [], state: 'port-not-mounted', seeds: [], verified: 0 };
    if (!web) return entry;
    const described = webDescribe();
    const allowedSources = Array.isArray(described?.allowedSources) ? described.allowedSources : [];
    const seedUrls = Array.isArray(described?.seedUrls) ? described.seedUrls : [];
    if (!allowedSources.length && !seedUrls.length) return { ...entry, state: 'source-allowlist-empty' };
    const interests = (runtime?.interests ?? []).filter(item => item?.title);
    const index = interests.length ? Math.floor(at / 86400000) % interests.length : 0;
    const topic = interests[index]?.title || (described?.searchProvider === 'dsh' ? '' : topicOf(runtime));
    let result;
    try {
      result = await web.seeds({ topic, scopeKey, at, limit: seedLimit, verify: seedVerify, budget: budgetGate(runtime),
        excludeUrls: (runtime?.finishedActivities ?? []).map(item => item.target).filter(Boolean) });
    } catch (error) {
      return { ...entry, allowedSources, seedUrls, state: 'seeds-failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 80) };
    }
    const seeds = (Array.isArray(result?.seeds) ? result.seeds : []).slice(0, seedLimit).map(item => ({
      url: textOf(item.url),
      title: textOf(item.title).slice(0, 100),
      snippet: textOf(item.snippet).slice(0, 120),
      verified: item.verified === true,
      source: textOf(item.source) || 'search',
      ...(textOf(item.reason) ? { reason: textOf(item.reason) } : {}),
    }));
    return {
      source: 'config.p2.autonomy',
      allowedSources,
      seedUrls,
      state: result?.ok === true ? 'ok' : textOf(result?.code) || 'unavailable',
      topic: textOf(result?.topic),
      seeds,
      verified: seeds.filter(item => item.verified).length,
      // `cached` is deliberately not part of the material: the planner re-reads the material
      // after the model call and rejects a changed digest, so a cache-hit flag must never
      // differ between the two reads.
    };
  }

  /**
   * One planning material object. `runtime` is the runtime's own DB-derived slice; without
   * it every runtime section is labelled `missing` instead of being silently empty.
   */
  function localReadingTargets() {
    const base = path.resolve(root, artifactRoot);
    const result = [];
    function visit(folder, depth = 0) {
      if (depth > 3 || result.length >= 24) return;
      let entries;
      try { entries = fs.readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)); } catch { return; }
      for (const entry of entries) {
        if (result.length >= 24) break;
        if (entry.isSymbolicLink()) continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) visit(file, depth + 1);
        else if (entry.isFile() && /\.(txt|md|markdown)$/i.test(entry.name)) result.push(path.relative(base, file).split(path.sep).join('/'));
      }
    }
    for (const dir of ['library', 'sources']) visit(path.join(base, dir));
    return result;
  }
  async function materials(input = {}) {
    const at = Number(input.now) || Number(now()) || Date.now();
    const scopeKey = textOf(input.scopeKey);
    const runtime = isRecord(input.runtime) ? input.runtime : null;
    const personaValue = runtime?.persona ?? persona();
    const preferenceValue = Array.isArray(runtime?.preferences) ? { items: runtime.preferences, source: 'runtime' } : preferences();
    // E4: the provider may be a function (evaluated per call) or a plain object. Either way the
    // result carries `state` so "no goals" and "cannot see goals" are different facts downstream.
    // A function provider is authoritative: it is evaluated per call with the real scope. The copy
    // inside the runtime material is only a fallback — preferring it served whatever the runtime had
    // computed for itself, which is how the section stayed empty while looking wired.
    const rawContinuity = typeof continuity === 'function'
      ? continuity({ scopeKey })
      : (runtime?.continuity ? { goals: [], commitments: [], ...runtime.continuity } : continuity({ scopeKey }));
    const continuityValue = { goals: [], commitments: [], state: 'ok', reason: '', source: '', ...rawContinuity };
    const entry = await publicEntry(runtime, scopeKey, at);
    const entrySeeds = entry.seeds.slice(0, Math.max(MAX_OPPORTUNITY_SEEDS, seedLimit)).map(seed => ({
      kind: 'public-source',
      source: seed.title ? `${seed.url} — ${seed.title}` : seed.url,
      verified: seed.verified === true,
    }));
    const runtimeOpportunities = Array.isArray(runtime?.opportunities) ? runtime.opportunities : [];
    const listOf = (value) => (Array.isArray(value) ? value : []);
    // "Knowable but empty" is different from "not supplied": an empty agenda from the
    // runtime means the day really has no fixed appointment; an absent key means nobody
    // told us and the model must not be led to believe the day is free.
    const supplied = key => Boolean(runtime) && Object.prototype.hasOwnProperty.call(runtime, key);
    const sources = {
      persona: personaValue ? 'workspace/PERSONA.md' : 'missing',
      preferences: preferenceValue.items.length ? preferenceValue.source : 'missing',
      fixedAgenda: supplied('fixedAgenda') ? 'runtime' : 'missing',
      plan: supplied('plan') ? 'runtime' : 'missing',
      lockedSlots: supplied('lockedSlots') ? 'runtime' : 'missing',
      runningActivities: supplied('runningActivities') ? 'runtime' : 'missing',
      goals: listOf(continuityValue.goals).length
        ? (textOf(continuityValue.source) || 'runtime')
        : (continuityValue.state === 'ok' ? 'runtime' : 'not-wired'),
      commitments: listOf(continuityValue.commitments).length
        ? (textOf(continuityValue.source) || 'runtime')
        : (continuityValue.state === 'ok' ? 'runtime' : 'not-wired'),
      interests: supplied('interests') ? 'runtime' : 'missing',
      recentPlans: supplied('recentPlans') ? 'runtime' : 'missing',
      opportunities: entrySeeds.length ? 'runtime+public-web' : (supplied('opportunities') ? 'runtime' : 'missing'),
      capabilities: 'ports',
      publicEntry: entry.state === 'ok' ? 'config.p2.autonomy+live-search' : 'config.p2.autonomy',
      budget: supplied('budget') && runtime.budget ? 'runtime' : 'missing',
    };
    const material = {
      scopeKey,
      day: textOf(input.day),
      now: at,
      timeZone: textOf(input.timeZone ?? options.timeZone),
      persona: personaValue,
      personaSource: sources.persona,
      preferences: preferenceValue.items,
      preferencesSource: sources.preferences,
      fixedAgenda: listOf(runtime?.fixedAgenda),
      plan: runtime?.plan ?? null,
      lockedSlots: listOf(runtime?.lockedSlots),
      runningActivities: listOf(runtime?.runningActivities),
      finishedActivities: listOf(runtime?.finishedActivities),
      planningPreferences: runtime?.planningPreferences ?? {},
      entryPoints: [...listOf(runtime?.runningActivities).filter(item => ['read','explore'].includes(item.kind)).map(item => item.target).filter(Boolean), ...localReadingTargets().filter(target => !listOf(runtime?.finishedActivities).some(item => item.target === target))],
      lastReceipts: listOf(runtime?.lastReceipts),
      goals: listOf(continuityValue.goals),
      continuity: { state: textOf(continuityValue.state) || 'not-wired', reason: textOf(continuityValue.reason, 60) },
      commitments: listOf(continuityValue.commitments),
      interests: listOf(runtime?.interests),
      recentPlans: listOf(runtime?.recentPlans),
      // Concrete, copyable sources lead the list: the planner renders these lines and the
      // model can put one straight into `targetRef`. DB opportunities follow.
      opportunities: [...entrySeeds, ...runtimeOpportunities],
      capabilities: capabilityList(runtime),
      capabilityDetail: isRecord(runtime?.capabilities) ? runtime.capabilities : null,
      publicEntry: entry,
      budget: runtime?.budget ?? null,
      sources,
      missing: Object.keys(sources).filter(key => sources[key] === 'missing'),
    };
    return material;
  }

  function describe() {
    const personaValue = persona();
    const entry = webDescribe();
    return {
      port: 'planning-materials',
      persona: personaValue ? { source: personaValue.source, version: personaValue.version, chars: personaValue.excerpt.length, personaId: personaValue.personaId } : { source: 'missing' },
      continuity: typeof options.continuity === 'function' ? 'wired' : 'absent',
      publicEntry: entry ? { allowedSources: entry.allowedSources.length, seedUrls: entry.seedUrls.length, search: entry.search } : 'port-not-mounted',
      seedLimit,
      seedVerify,
      readRoots: readRoots.length,
      artifactRoot,
      runtimeSections: [...RUNTIME_SECTIONS],
    };
  }

  return { materials, persona, preferences, continuity, describe };
}
