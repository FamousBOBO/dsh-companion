import { BUDGET, RETRIEVAL_DEFAULTS } from './policy.mjs';
import { normalizeText } from './text.mjs';

import { cosineSimilarity } from './embed.mjs';

// Ranking and packing helpers shared by the recall path.
//
//   lexical FTS5 candidates ─┐
//                             ├─ fuse()      reciprocal rank fusion, one rank per channel
//   vector candidates ───────┘
//                                  ↓
//   mmrSelect()      maximal marginal relevance: keep relevant, drop near duplicates
//                                  ↓
//   packBudget()     identity / stable / related / current character budget
//
// Everything here is a pure function: same input, same output, no clock, no I/O,
// no module level mutable state. Ties are always broken by the caller's input
// order so a recall is reproducible in tests and in explain logs.

/** Injection sections in fill priority order (CONTRACT.md §12 / plan §7.2). */
export const SECTIONS = Object.freeze(['identity', 'stable', 'related', 'current']);

/** Keywords for the near duplicate check when a candidate has no vector. */
const FINGERPRINT_CHARS = 32;
/** Cosine at or above this value is treated as "the same fact twice". */
const DUPLICATE_SIMILARITY = 0.98;

const SECTION_ALIASES = Object.freeze({
  identity: 'identity',
  stable: 'stable',
  stablefacts: 'stable',
  stable_facts: 'stable',
  related: 'related',
  current: 'current',
  recent: 'current',
  session: 'current',
  session_recent: 'current',
});

/**
 * Default section weights, taken from policy.BUDGET as *ratios*.
 * `BUDGET.identity` is an absolute character count while the other sections are
 * fractions of the total, so identity is converted with `BUDGET.total` first;
 * only the ratio between the four sections matters here.
 */
const DEFAULT_SECTION_WEIGHTS = Object.freeze({
  identity: BUDGET.identity / BUDGET.total,
  stable: BUDGET.stableFacts,
  related: BUDGET.related,
  current: BUDGET.current,
});

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Code-unit id order: deterministic, unlike locale aware comparison. */
function compareIds(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value[Symbol.iterator] === 'function') return [...value];
  return [value];
}

function entryId(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  const id = entry.id ?? entry.memoryId ?? entry.memory_id ?? entry.record?.id;
  return typeof id === 'string' ? id : id == null ? '' : String(id);
}

function entryScore(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  return numberOr(entry.score ?? entry.rank, 0);
}

function entryText(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  const text = entry.text ?? entry.value ?? entry.record?.value ?? entry.record?.content ?? '';
  return typeof text === 'string' ? text : String(text ?? '');
}

function sectionOf(entry) {
  const raw = entry?.section ?? entry?.record?.section ?? '';
  const key = String(raw ?? '').trim().toLowerCase();
  return SECTION_ALIASES[key] ?? 'related';
}

/**
 * Reciprocal rank fusion: `score = Σ 1 / (k + rank)`, rank starting at 1.
 *
 * Each channel is ranked by its own score (input order breaks ties), so the two
 * channels can contribute completely different scales without calibration. An id
 * found by both channels keeps both contributions and reports both channels;
 * results come back by descending fused score, ties broken by id.
 *
 * @param {{ lexical?: Array<{id: string, score?: number}>, semantic?: Array<{id: string, score?: number}>,
 *           rrfK?: number, minScore?: number }} input
 * @returns {Array<{ id: string, score: number, channels: string[] }>}
 */
export function fuse({ lexical, semantic, rrfK = RETRIEVAL_DEFAULTS.rrfK, minScore = 0 } = {}) {
  const k = Math.max(1, numberOr(rrfK, RETRIEVAL_DEFAULTS.rrfK));
  const floor = numberOr(minScore, 0);
  const merged = new Map();

  const addChannel = (name, entries) => {
    const ranked = [];
    for (const entry of toArray(entries)) {
      const id = entryId(entry);
      if (!id) continue;
      ranked.push({ id, score: entryScore(entry), order: ranked.length });
    }
    // Stable sort: higher score first, original order for equal scores.
    ranked.sort((left, right) => right.score - left.score || left.order - right.order);
    const seen = new Set();
    ranked.forEach((item, index) => {
      if (seen.has(item.id)) return; // one rank per channel per id
      seen.add(item.id);
      const contribution = 1 / (k + index + 1);
      const existing = merged.get(item.id);
      if (existing) {
        existing.score += contribution;
        if (!existing.channels.includes(name)) existing.channels.push(name);
      } else {
        merged.set(item.id, { id: item.id, score: contribution, channels: [name] });
      }
    });
  };

  addChannel('lexical', lexical);
  addChannel('semantic', semantic);

  return [...merged.values()]
    .filter(item => item.score > floor)
    .sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
}

/** Normalise the accepted weight shapes into one comparable object. */
function resolveWeights(weights) {
  if (!weights || typeof weights !== 'object') return null;
  const looksLikeBudget = 'stableFacts' in weights || ('reserve' in weights && 'total' in weights);
  if (looksLikeBudget) {
    const total = Math.max(1, numberOr(weights.total, BUDGET.total));
    return {
      identity: numberOr(weights.identity, BUDGET.identity) / total,
      stable: numberOr(weights.stableFacts, BUDGET.stableFacts),
      related: numberOr(weights.related, BUDGET.related),
      current: numberOr(weights.current, BUDGET.current),
      reserve: weights.reserve,
    };
  }
  return {
    identity: numberOr(weights.identity, 0),
    stable: numberOr(weights.stable ?? weights.stableFacts, 0),
    related: numberOr(weights.related, 0),
    current: numberOr(weights.current, 0),
    reserve: weights.reserve,
  };
}

function sectionShares(weights) {
  const resolved = resolveWeights(weights);
  const raw = {};
  let sum = 0;
  for (const section of SECTIONS) {
    const value = resolved ? resolved[section] : DEFAULT_SECTION_WEIGHTS[section];
    const positive = Number.isFinite(value) && value > 0 ? value : 0;
    raw[section] = positive;
    sum += positive;
  }
  if (!(sum > 0)) {
    // All weights zero or invalid: fall back to the policy proportions rather
    // than silently packing nothing.
    sum = 0;
    for (const section of SECTIONS) {
      raw[section] = DEFAULT_SECTION_WEIGHTS[section];
      sum += raw[section];
    }
  }
  const shares = {};
  for (const section of SECTIONS) shares[section] = raw[section] / sum;
  return shares;
}

/**
 * Character caps per section for a given total budget.
 *
 * `budget` is the whole injection budget in characters. A `reserve` is kept
 * back for labels/separators; when the caller does not state one it defaults to
 * `BUDGET.reserve` but never more than 10% of the budget (otherwise a small
 * budget would reserve everything and pack nothing). The four sections then
 * share the remainder in the ratio returned by `sectionShares`.
 *
 * @returns {{ budget: number, reserve: number, allocatable: number,
 *             caps: { identity: number, stable: number, related: number, current: number } }}
 */
export function budgetCaps({ budget = BUDGET.total, weights } = {}) {
  const totalBudget = Math.max(0, Math.trunc(numberOr(budget, BUDGET.total)));
  const resolved = resolveWeights(weights);
  const fallbackReserve = Math.min(BUDGET.reserve, Math.floor(totalBudget * 0.1));
  const requestedReserve = resolved?.reserve == null ? fallbackReserve : numberOr(resolved.reserve, fallbackReserve);
  const reserve = Math.min(totalBudget, Math.max(0, Math.trunc(requestedReserve)));
  const allocatable = Math.max(0, totalBudget - reserve);
  const shares = sectionShares(weights);
  const caps = {};
  for (const section of SECTIONS) caps[section] = Math.floor(shares[section] * allocatable);
  return { budget: totalBudget, reserve, allocatable, caps };
}

/**
 * Maximal Marginal Relevance selection: `λ * relevance - (1 - λ) * maxSimilarity`.
 *
 * Relevance is the candidate score min-max normalised over the input so it is
 * comparable with a [0, 1] similarity. Similarity comes from the candidate
 * vectors when present (`vectors` may be a Map id -> Float32Array, a plain object
 * or an array parallel to `candidates`), otherwise from a text fingerprint: two
 * candidates whose first 32 normalised characters match count as duplicates.
 *
 * A candidate whose similarity to something already selected reaches
 * `DUPLICATE_SIMILARITY` is dropped outright instead of merely demoted, so a
 * near duplicate cannot win back a slot on raw relevance.
 *
 * @returns {Array<{ id: string, score: number }>} selection order, stable across
 *          runs. `score` is the MMR value and may be negative once the diversity
 *          penalty outweighs relevance; treat the array order as the ranking.
 */
export function mmrSelect({
  candidates,
  vectors,
  limit,
  lambda = RETRIEVAL_DEFAULTS.mmrLambda,
  duplicateSimilarity = DUPLICATE_SIMILARITY,
} = {}) {
  const items = [];
  for (const candidate of toArray(candidates)) {
    const id = entryId(candidate);
    if (!id) continue;
    const text = entryText(candidate);
    const fingerprint = normalizeText(text).slice(0, FINGERPRINT_CHARS);
    const inlineVector = candidate && typeof candidate === 'object' ? candidate.vector : undefined;
    items.push({
      id,
      score: entryScore(candidate),
      fingerprint,
      vector: inlineVector ?? lookupVector(vectors, id, items.length),
      order: items.length,
    });
  }
  if (!items.length) return [];

  const cap = limit == null
    ? RETRIEVAL_DEFAULTS.topK
    : Math.max(0, Math.trunc(numberOr(limit, RETRIEVAL_DEFAULTS.topK)));
  if (cap === 0) return [];

  const scores = items.map(item => item.score);
  const lowest = Math.min(...scores);
  const highest = Math.max(...scores);
  const spread = highest - lowest;
  for (const item of items) {
    item.relevance = spread > 0 ? (item.score - lowest) / spread : 1;
  }

  const weight = Math.min(1, Math.max(0, numberOr(lambda, RETRIEVAL_DEFAULTS.mmrLambda)));
  const threshold = Math.min(1, Math.max(0, numberOr(duplicateSimilarity, DUPLICATE_SIMILARITY)));

  const remaining = items
    .slice()
    .sort((left, right) => right.score - left.score || left.order - right.order);
  const selected = [];
  const chosen = [];

  while (selected.length < cap && remaining.length) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    let bestSimilarity = 0;
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      let maxSimilarity = 0;
      for (const picked of chosen) {
        maxSimilarity = Math.max(maxSimilarity, similarity(item, picked));
      }
      const value = weight * item.relevance - (1 - weight) * maxSimilarity;
      // Strict `>` keeps the earliest (most relevant) candidate on ties.
      if (value > bestValue + 1e-12) {
        bestValue = value;
        bestIndex = i;
        bestSimilarity = maxSimilarity;
      }
    }

    const item = remaining[bestIndex];
    remaining.splice(bestIndex, 1);
    if (chosen.length && bestSimilarity >= threshold) continue; // near duplicate: drop
    selected.push({ id: item.id, score: bestValue });
    chosen.push(item);
  }

  return selected;
}

function lookupVector(vectors, id, index) {
  if (!vectors) return null;
  if (vectors instanceof Map) {
    const found = vectors.get(id);
    return found ?? null;
  }
  if (Array.isArray(vectors)) {
    const found = vectors[index];
    return isVectorLike(found) ? found : null;
  }
  if (typeof vectors === 'object') {
    const found = vectors[id];
    return isVectorLike(found) ? found : null;
  }
  return null;
}

function isVectorLike(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.length === 'number' && value.length > 0;
}

function similarity(left, right) {
  if (isVectorLike(left.vector) && isVectorLike(right.vector)) {
    const cosine = cosineSimilarity(left.vector, right.vector);
    return Math.min(1, Math.max(0, cosine));
  }
  if (left.fingerprint && right.fingerprint) return left.fingerprint === right.fingerprint ? 1 : 0;
  return 0;
}

/**
 * Pack rendered entries into a character budget.
 *
 * Entries are grouped by section and filled in priority order
 * (identity -> stable -> related -> current); inside a section the highest score
 * wins, with input order breaking ties. Each accepted line is charged its own
 * length plus one separator character, so `used` is an upper bound on the joined
 * text. A line that does not fit its section cap or the remaining budget is
 * dropped (and the next, possibly smaller, entry is still tried so the budget is
 * not wasted). Entries sharing an id, or sharing a normalised value, are dropped
 * as duplicates.
 *
 * @param {{ entries?: Array<{id?: string, section?: string, text?: string, value?: string, score?: number}>,
 *           budget?: number, weights?: object }} input
 * @returns {{ lines: string[], used: number, dropped: Array<{id: string, section: string, reason: string}> }}
 */
export function packBudget({ entries, budget = BUDGET.total, weights } = {}) {
  const limits = budgetCaps({ budget, weights });
  const buckets = new Map(SECTIONS.map(section => [section, []]));
  const dropped = [];

  toArray(entries).forEach((entry, order) => {
    if (!entry || typeof entry !== 'object') {
      dropped.push({ id: '', section: 'related', reason: 'invalid' });
      return;
    }
    const id = entryId(entry);
    const section = sectionOf(entry);
    const text = entryText(entry);
    const value = typeof entry.value === 'string' ? entry.value : '';
    buckets.get(section).push({ id, section, text, value, score: entryScore(entry), order });
  });

  const lines = [];
  const seenIds = new Set();
  const seenValues = new Set();
  const usedBySection = new Map(SECTIONS.map(section => [section, 0]));
  let used = 0;

  for (const section of SECTIONS) {
    const items = buckets
      .get(section)
      .sort((left, right) => right.score - left.score || left.order - right.order);

    for (const item of items) {
      const drop = reason => dropped.push({ id: item.id, section, reason });
      if (!item.text) {
        drop('empty');
        continue;
      }
      if (item.id && seenIds.has(item.id)) {
        drop('duplicate-id');
        continue;
      }
      const valueKey = normalizeText(item.value || item.text);
      if (valueKey && seenValues.has(valueKey)) {
        drop('duplicate-value');
        continue;
      }
      const cost = item.text.length + 1;
      if (used + cost > limits.allocatable) {
        drop('budget');
        continue;
      }
      if ((usedBySection.get(section) ?? 0) + cost > limits.caps[section]) {
        drop('section-budget');
        continue;
      }
      lines.push(item.text);
      used += cost;
      usedBySection.set(section, (usedBySection.get(section) ?? 0) + cost);
      if (item.id) seenIds.add(item.id);
      if (valueKey) seenValues.add(valueKey);
    }
  }

  return { lines, used, dropped };
}
