import { cosineSimilarity } from './embed.mjs';
import { fuse, mmrSelect } from './fusion.mjs';
import { RETRIEVAL_DEFAULTS, isActive, scopeMatches } from './policy.mjs';
import { createReranker, RerankError } from './rerank.mjs';
import { terms } from './text.mjs';

// Hybrid recall orchestration for the companion memory engine (CONTRACT.md §12).
//
//   query ──┬─ lexical channel  db.fullTextSearch()  (FTS5 + CJK bigrams)
//           └─ semantic channel dot product against db.getEmbeddings(), computed
//                              only for a bounded candidate set
//                        ↓
//   policy double filter    status + scopeMatches() + isActive()   (second gate:
//                        ↓  the store applies the first one in SQL)
//   fusion.fuse()           reciprocal rank fusion, one rank per channel
//                        ↓
//   fusion.mmrSelect()      drop near duplicates, keep the diverse top-K
//                        ↓
//   section                 stable / related / current  (for the renderer's budget)
//
// Design rules that must not regress:
//
//   * Nothing in here may throw into a chat turn. A broken FTS expression, a dead
//     embedder, missing vectors or a malformed row all degrade to the other
//     channel (or to no injection at all) and are recorded in `explain`.
//   * The storage layer already filters owner identity and status in SQL, but
//     every returned row is filtered again through lib/policy.mjs. The storage
//     layer is not allowed to be the only gate for scope visibility.
//   * The vector channel never scans the whole table: candidates come from the
//     lexical hits plus a bounded "recent + important" pool, and their vectors are
//     read by id (`getEmbeddings({ memoryIds })`), so recall cost stays
//     proportional to `config.candidates`, not to the size of the memory. A store
//     that predates that parameter degrades to one bounded scan.
//   * The built-in `hash-bigram-*` embedder is a lexical hash, not a semantic
//     model (see lib/embed.mjs), so a hash hit must additionally share an indexed
//     token with the query and clear LOCAL_SEMANTIC_FLOOR: anything genuinely
//     related is found by FTS anyway, while everything else is hash collision
//     noise. A real embedding model bypasses both gates and is tuned with
//     `config.semanticMinScore` / `config.minScore`.
//   * A lexical hit must cover enough of the query (see passesLexicalCoverage):
//     OR-ed bigrams match anything in a large archive, and "least bad" rows must
//     not reach the prompt (plan §10.1). When every candidate is rejected the
//     answer is empty, never the recent pool.
//   * Vector identity comes from `batch.source`, never from the configured
//     provider (P1-7): a remote that degraded to local hash vectors closes the
//     semantic channel for that turn (`semantic-degraded`) instead of comparing a
//     hash vector against a neural index or skipping the hash gates.
//   * `explain` carries counts and reason codes only — never memory text.

/** Number of embedding rows a legacy (no `memoryIds`) read may scan. */
const MAX_EMBEDDING_SCAN = 1000;
/** Hard cap so a pathological reason map cannot bloat the recall log line. */
const MAX_EXPLAIN_REASONS = 12;
const MAX_EXPLAIN_CHARS = 600;
/**
 * Cosine floor for the built-in `hash-bigram-*` channel.
 *
 * That provider is a signed feature hash of the same CJK bigrams FTS already
 * indexes (see lib/embed.mjs), so it is a *lexical* approximation: any pair that
 * shares a bigram is already recalled by the FTS channel, while pairs that share
 * nothing can still land at |cos| ≈ 0.22 purely from hash collisions (measured
 * over 270 unrelated Chinese sentence pairs at 256 dimensions). A memory that is
 * only "similar" through collisions must never be injected, so the vector channel
 * requires a shared indexed token *and* a cosine above this floor before it
 * trusts a hash hit (see `sharesIndexedTerm`). Everything genuinely related
 * arrives through the lexical channel anyway.
 */
export const LOCAL_SEMANTIC_FLOOR = 0.3;

/** Injection sections, in the order the renderer fills them. */
export const RECALL_SECTIONS = Object.freeze(['stable', 'related', 'current']);

/** Kinds that describe the user's stable identity rather than a story beat. */
const STABLE_KINDS = new Set(['fact', 'preference', 'profile']);

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** Accept a Date, ISO string, epoch milliseconds or a clock function. */
function asClock(value) {
  let raw = value;
  if (typeof raw === 'function') {
    try {
      raw = raw();
    } catch {
      raw = undefined;
    }
  }
  if (raw instanceof Date) {
    const time = raw.getTime();
    return Number.isFinite(time) ? time : Date.now();
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

/** Normalise the retrieval config; unknown or out-of-range values fall back. */
function resolveSettings(config) {
  const source = config && typeof config === 'object' ? config : {};
  const requestedFloor = source.semanticMinScore == null ? Number.NaN : Number(source.semanticMinScore);
  return {
    candidates: clampInt(source.candidates, 4, 200, RETRIEVAL_DEFAULTS.candidates),
    topK: clampInt(source.topK, 1, 50, RETRIEVAL_DEFAULTS.topK),
    rrfK: clampInt(source.rrfK, 1, 200, RETRIEVAL_DEFAULTS.rrfK),
    mmrLambda: clampNumber(source.mmrLambda, 0, 1, RETRIEVAL_DEFAULTS.mmrLambda),
    minScore: clampNumber(source.minScore, -1, 1, RETRIEVAL_DEFAULTS.minScore),
    coverageFloor: clampNumber(source.coverageFloor, COVERAGE_FLOOR_MIN, COVERAGE_FLOOR_MAX, DEFAULT_COVERAGE_FLOOR),
    // null means "derive from the provider"; a number overrides.
    semanticMinScore: Number.isFinite(requestedFloor)
      ? Math.min(1, Math.max(-1, requestedFloor))
      : null,
    semanticEnabled: source.semanticEnabled !== false,
  };
}

/** Is this the deterministic `hash-bigram-*` channel rather than a real model? */
function isLexicalEmbedder(embedder) {
  const provider = String(embedder?.provider ?? '').toLowerCase();
  const model = String(embedder?.model ?? '').toLowerCase();
  return provider === 'local' || model.startsWith('hash-bigram');
}

/**
 * Lexical coverage gate (plan §10.1: an unrelated question must not inject
 * unrelated old memories).
 *
 * `text.matchExpression()` ORs the query bigrams together, so in a large archive a
 * long unrelated question ("完全无关的量子力学问题") always matches *something*: bm25
 * then returns the "least bad" rows and fusion would promote the first one to a
 * rank-1 hit. Before a lexical candidate may enter the candidate pool, the *mass*
 * of the query it really contains is measured, with each term weighted by its
 * document frequency in the same scope:
 *
 *   df(t)  = confirmed rows in scope whose searchText matches t (FTS probe)
 *   N      = confirmed rows in scope (db.countMemories)
 *   idf(t) = ln(1 + N / (1 + df(t)))        // rare term => high weight
 *   coverage = Σ idf(matched) / Σ idf(all query terms)
 *
 * A record that only shares a high frequency bigram ("喜欢", "问题") therefore
 * scores low, while a record that shares a rare proper noun ("北京烤鸭") scores
 * high — which is exactly what separates an unrelated question from a long,
 * naturally phrased one about something that is really in the archive.
 *
 * Pass rule: a single term query needs one match; otherwise
 * `coverage >= floor` and `matchedTerms >= 1`. The floor comes from
 * `config.coverageFloor` (default DEFAULT_COVERAGE_FLOOR). Only the lexical
 * channel is gated; the vector channel keeps its own gates.
 *
 * The default was measured on the live 777 row archive: a totally unrelated
 * question peaks at coverage 0.0985 while a long, naturally phrased question about
 * something that really is in the archive peaks at 0.169-0.254, so 0.15 is the
 * highest floor that keeps the unrelated ones empty and the natural ones alive.
 */
export const DEFAULT_COVERAGE_FLOOR = 0.15;
const COVERAGE_FLOOR_MIN = 0.1;
const COVERAGE_FLOOR_MAX = 0.9;
/** db.fullTextSearch caps at 500 rows, so a df above that is saturated. */
const DF_SCAN_LIMIT = 500;
/** Upper bound on df probes per recall; longer queries are gated on their first terms. */
const MAX_COVERAGE_TERMS = 12;

/** Indexed terms of a record, exactly as lib/db.mjs wrote `searchText`. */
function indexedTermSet(record) {
  const indexed = String(record?.searchText ?? '');
  if (!indexed) return new Set();
  const set = new Set();
  for (const token of indexed.split(' ')) {
    if (token) set.add(token);
  }
  return set;
}

/** Shared terms of the query present in the record's indexed text. */
function matchedTermCount(record, queryTerms) {
  if (!queryTerms.size) return 0;
  const indexed = indexedTermSet(record);
  if (!indexed.size) return 0;
  let matched = 0;
  for (const term of queryTerms) {
    if (indexed.has(term)) matched += 1;
  }
  return matched;
}

/** Confirmed rows in the viewer's scope, or a df-based estimate for stubs. */
function scopeConfirmedCount(db, identity) {
  try {
    const count = Number(db.countMemories({
      userId: identity.userId,
      personaId: identity.personaId,
      worldId: identity.worldId,
      status: 'confirmed',
    }));
    if (Number.isFinite(count) && count > 0) return Math.trunc(count);
  } catch {
    // fall through to the estimate
  }
  return 0;
}

/** Document frequency of one indexed term, saturated at DF_SCAN_LIMIT. */
function termDocumentFrequency(db, identity, term) {
  try {
    const hits = db.fullTextSearch({
      userId: identity.userId,
      personaId: identity.personaId,
      worldId: identity.worldId,
      query: term,
      limit: DF_SCAN_LIMIT,
      statuses: ['confirmed'],
    });
    return Array.isArray(hits) ? hits.length : 0;
  } catch {
    return 0;
  }
}

function idfOf(df, total) {
  const n = Math.max(1, total);
  const frequency = Math.max(0, Math.min(df, n));
  return Math.log(1 + n / (1 + frequency));
}

/**
 * df/idf weights for one recall, memoised for the call: at most
 * MAX_COVERAGE_TERMS FTS probes plus one count. Falls back to equal weights when
 * the store cannot answer (a stub, a read-only failure), which degrades the gate
 * to a plain matched-ratio instead of throwing.
 */
function buildCoverageStats(db, identity, queryTerms, floor) {
  const terms = [...queryTerms].slice(0, MAX_COVERAGE_TERMS);
  const declared = scopeConfirmedCount(db, identity);
  const df = new Map();
  for (const term of terms) df.set(term, termDocumentFrequency(db, identity, term));
  let total = declared;
  if (!(total > 0)) {
    // No count available: use the largest observed df so weights stay positive
    // and keep their relative order.
    let largest = 0;
    for (const value of df.values()) largest = Math.max(largest, value);
    total = Math.max(1, largest);
  }
  const weights = new Map();
  let totalWeight = 0;
  for (const term of terms) {
    const weight = idfOf(df.get(term) ?? 0, total);
    weights.set(term, weight);
    totalWeight += weight;
  }
  return {
    floor,
    weights,
    totalWeight,
    terms: terms.length,
    best: 0,
    kept: 0,
    total: 0,
    // Single term queries only need one hit (see coveragePasses).
    single: terms.length === 1,
  };
}

/** Coverage of one record against the df/idf weights. */
function recordCoverage(record, stats, indexed = indexedTermSet(record)) {
  let matchedWeight = 0;
  let matchedTerms = 0;
  for (const [term, weight] of stats.weights) {
    if (indexed.has(term)) {
      matchedWeight += weight;
      matchedTerms += 1;
    }
  }
  return {
    coverage: stats.totalWeight > 0 ? matchedWeight / stats.totalWeight : 0,
    matchedTerms,
  };
}

function coveragePasses(stats, coverage, matchedTerms) {
  if (!stats.weights.size) return true; // no query terms: nothing to gate
  if (stats.single) return matchedTerms >= 1;
  return coverage >= stats.floor && matchedTerms >= 1;
}

/**
 * Does the record share at least one indexed token with the query?
 *
 * Only used to gate the hash channel: its vector is a signed projection of exactly
 * these tokens, so a positive dot product without a shared token is a collision,
 * not a relation. `record.searchText` is the same space separated token string FTS
 * indexes and `terms()` is the frozen primitive from lib/text.mjs, so this check
 * cannot drift from the indexed form.
 */
function sharesIndexedTerm(record, queryTerms) {
  return matchedTermCount(record, queryTerms) > 0;
}

/**
 * Does this store understand `getEmbeddings({ memoryIds })`?
 *
 * Probed once per database handle and memoised: a store that predates the
 * parameter ignores it and answers with a window of its own, while an empty
 * selection must answer with no rows at all (CONTRACT §6 as of the store-engine
 * update). That difference is the probe. Anything uncertain counts as
 * unsupported, so the caller keeps the bounded-scan fallback and never throws.
 */
const EMBEDDING_LOOKUP_SUPPORT = new WeakMap();

function embeddingLookupSupported(db, options) {
  if (EMBEDDING_LOOKUP_SUPPORT.has(db)) return EMBEDDING_LOOKUP_SUPPORT.get(db);
  let supported = false;
  try {
    const probed = db.getEmbeddings({ ...options, memoryIds: [], limit: 1 });
    supported = Array.isArray(probed) && probed.length === 0;
  } catch {
    supported = false;
  }
  EMBEDDING_LOOKUP_SUPPORT.set(db, supported);
  return supported;
}

/**
 * Vectors for the candidate set only, or `[]` when they cannot be read.
 *
 * Preferred path: `getEmbeddings({ provider, model, memoryIds, limit })`, which
 * db.mjs answers with chunked `memory_id IN (...)` reads, so a large index no
 * longer silently loses the vectors of its tail rows to the 1000 row cap. When
 * the store is unavailable, throws, or ignored `memoryIds` (old signature), the
 * read degrades to one bounded scan ordered by memory_id. Errors are reported via
 * `noteReason`, never thrown.
 */
function readCandidateVectors(db, { provider, model, memoryIds, noteReason = () => {} }) {
  const ids = Array.isArray(memoryIds)
    ? memoryIds.filter(id => typeof id === 'string' && id)
    : [];
  if (!ids.length) return [];
  if (typeof db.getEmbeddings !== 'function') return [];

  let noted = false;
  const fail = () => {
    if (noted) return;
    noted = true;
    noteReason('vector-error');
  };

  if (embeddingLookupSupported(db, { provider, model })) {
    try {
      const found = db.getEmbeddings({ provider, model, memoryIds: ids, limit: ids.length });
      const list = Array.isArray(found) ? found : [];
      const requested = new Set(ids);
      if (list.every(row => requested.has(String(row?.memoryId ?? '')))) return list;
      // It answered with a window of its own: `memoryIds` was ignored.
      EMBEDDING_LOOKUP_SUPPORT.set(db, false);
    } catch {
      fail();
      EMBEDDING_LOOKUP_SUPPORT.set(db, false);
    }
  }

  try {
    const found = db.getEmbeddings({ provider, model, limit: MAX_EMBEDDING_SCAN });
    return Array.isArray(found) ? found : [];
  } catch {
    fail();
    return [];
  }
}

/**
 * Admission floor for the vector channel. A real embedding model has its own
 * (unknown) similarity scale, so only `config.minScore` applies there; the local
 * hash channel needs the collision band above. The decision uses the *batch
 * source* (what actually produced the query vector), not the configured target.
 */
function resolveSemanticFloor(settings, source) {
  if (settings.semanticMinScore != null) return settings.semanticMinScore;
  return source?.provider === 'local'
    ? Math.max(settings.minScore, LOCAL_SEMANTIC_FLOOR)
    : settings.minScore;
}

/**
 * Identity of the batch that produced the query vector (P1-7).
 *
 * `embedder.provider`/`embedder.model` are the *configured target*; when a remote
 * endpoint fails, times out, trips its breaker or answers with the wrong
 * dimensions, embed.mjs answers with local hash vectors and reports
 * `batch.source = { provider: 'local', model: 'hash-bigram-<dims>', degraded: true }`.
 * The vector index is keyed on provider+model, so the source must be read from the
 * batch: comparing a degraded hash vector against a neural index, or gating it as
 * if it were remote, is exactly the bug this prevents.
 *
 * An older provider (or a test double) without `batch.source` keeps the previous
 * behaviour: the configured identity is assumed, `degraded: false`.
 */
function batchSourceOf(batch, embedder) {
  const declared = batch && typeof batch === 'object' ? batch.source : null;
  if (declared && typeof declared === 'object' && typeof declared.provider === 'string') {
    return {
      provider: declared.provider.toLowerCase(),
      model: String(declared.model ?? ''),
      dimensions: Number(declared.dimensions) || 0,
      degraded: declared.degraded === true,
    };
  }
  const provider = String(embedder?.provider ?? '').toLowerCase();
  return {
    provider: provider || (isLexicalEmbedder(embedder) ? 'local' : ''),
    model: String(embedder?.model ?? ''),
    dimensions: Number(embedder?.dimensions) || 0,
    degraded: false,
  };
}

/** A read path without a bound identity must not return anything. */
function normalizeViewer(viewer) {
  if (!viewer || typeof viewer !== 'object') return null;
  const userId = typeof viewer.userId === 'string' ? viewer.userId.trim() : '';
  const personaId = typeof viewer.personaId === 'string' ? viewer.personaId.trim() : '';
  if (!userId || !personaId) return null;
  const worldId = viewer.worldId == null ? '' : String(viewer.worldId);
  return { userId, personaId, worldId };
}

/**
 * Why a row may not be recalled. Empty string means "usable".
 * `scopeMatches` runs before the validity checks so a fiction row from another
 * world is reported as a scope problem, not as an expiry problem.
 */
function filterReasonFor(record, viewer, clock) {
  if (!record) return 'missing-record';
  const status = String(record.status ?? '');
  if (status !== 'confirmed') return `status-${status || 'unknown'}`;
  if (!scopeMatches(record, viewer)) return 'scope-mismatch';
  if (record.validTo) {
    const until = Date.parse(record.validTo);
    if (Number.isFinite(until) && until <= clock) return 'expired';
  }
  if (record.validFrom) {
    const from = Date.parse(record.validFrom);
    if (Number.isFinite(from) && from > clock) return 'not-yet-valid';
  }
  // Second gate: isActive() also enforces the session_recent TTL and re-checks
  // status/validity, so a future policy change cannot silently widen recall.
  if (!isActive(record, clock)) return 'inactive';
  return '';
}

/**
 * Injection section for a record (plan §7.2 budget shares).
 *   stable  – who the user is: confirmed facts, preferences, profile
 *   related – relationship, commitments, events, story and persona continuity
 *   current – transient session state
 */
export function sectionFor(record) {
  if (!record || typeof record !== 'object') return 'related';
  const scope = String(record.scope ?? '');
  if (scope === 'session_recent') return 'current';
  if (scope === 'user_global' && STABLE_KINDS.has(String(record.kind ?? ''))) return 'stable';
  return 'related';
}

function countReasons(reasons) {
  const entries = [...reasons.entries()]
    .filter(([key, count]) => key && numberOr(count, 0) > 0)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .slice(0, MAX_EXPLAIN_REASONS);
  return Object.fromEntries(entries);
}

/** Min-max 归一到 0..1；全部相等（range=0）时统一 0.5（契约 §8.4）。 */
function minMaxNormalize(values) {
  const numbers = values.map(value => numberOr(value, 0));
  if (!numbers.length) return [];
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  if (!(max > min)) return numbers.map(() => 0.5);
  return numbers.map(value => (value - min) / (max - min));
}

/**
 * 重排序混合：final = blend * normRerank + (1 - blend) * normFusion。
 *
 * `scores` 是「候选下标 -> 原始 rerank 分数」。上游按 top_n 截断时只有部分
 * 候选有分数；缺分数的候选沿用自身融合归一分数（不惩罚），这样 topN 截断
 * 不会把融合通道的头部候选一把压到末尾。并列时保持原融合顺序。
 */
function blendRanking(fused, scores, blend) {
  const fusionNorm = minMaxNormalize(fused.map(item => item.score));
  const rerankRaw = fused.map((_, index) => {
    if (!(scores instanceof Map) || !scores.has(index)) return null;
    const value = Number(scores.get(index));
    return Number.isFinite(value) ? value : null;
  });
  const available = rerankRaw.filter(value => value !== null);
  const rerankNorm = minMaxNormalize(available);
  let cursor = 0;
  const rows = fused.map((item, index) => {
    const fusion = fusionNorm[index] ?? 0.5;
    let rerank = fusion;
    if (rerankRaw[index] !== null) {
      rerank = rerankNorm[cursor] ?? fusion;
      cursor += 1;
    }
    return { item, index, score: blend * rerank + (1 - blend) * fusion };
  });
  rows.sort((left, right) => right.score - left.score || left.index - right.index);
  return rows.map(row => ({ ...row.item, score: row.score }));
}

/**
 * Hybrid recall. Always resolves; never throws.
 *
 * @param db        MemoryDatabase (lib/db.mjs) or a compatible stub.
 * @param embedder  embedding provider (lib/embed.mjs) or null to skip the vector channel.
 * @param viewer    `{ userId, personaId, worldId }`; without it nothing is returned.
 * @param query     user text; empty means "recent important confirmed facts".
 * @param config    `{ candidates, topK, rrfK, mmrLambda, minScore, semanticEnabled }`.
 * @param now       epoch ms, ISO string, Date or clock function (injected for tests).
 * @returns `{ entries: [{ record, score, channels, section }], explain }`
 *          where `explain` is `{ backend, candidates, afterFilter, afterDedupe,
 *          channels: { lexical, semantic }, filteredReasons, elapsedMs }` and
 *          contains counts/reason codes only — never memory text.
 */
export async function recall(input = {}) {
  const startedAt = Date.now();
  const explain = {
    backend: 'none',
    candidates: 0,
    afterFilter: 0,
    afterDedupe: 0,
    channels: { lexical: 0, semantic: 0 },
    filteredReasons: {},
    // df/idf coverage diagnostics: never contains memory text, only numbers.
    coverage: {
      floor: DEFAULT_COVERAGE_FLOOR, best: 0, kept: 0, total: 0, terms: 0,
    },
    elapsedMs: 0,
  };
  const reasons = new Map();
  const noteReason = (reason, count = 1) => {
    const key = String(reason ?? '');
    if (!key) return;
    reasons.set(key, (reasons.get(key) ?? 0) + count);
  };

  let collected = [];
  let coverageStats = null;
  const finish = entries => {
    collected = Array.isArray(entries) ? entries : [];
    explain.filteredReasons = countReasons(reasons);
    if (coverageStats) {
      explain.coverage = {
        floor: Math.round(coverageStats.floor * 1000) / 1000,
        best: Math.round(coverageStats.best * 10000) / 10000,
        kept: coverageStats.kept,
        total: coverageStats.total,
        terms: coverageStats.terms,
      };
    }
    explain.elapsedMs = Math.max(0, Date.now() - startedAt);
    return { entries: collected, explain };
  };

  try {
    const {
      db, embedder = null, viewer = null, query = '', config = {}, now,
      reranker: providedReranker = null, log = null,
    } = input ?? {};
    const settings = resolveSettings(config);
    explain.coverage.floor = settings.coverageFloor;
    const clock = asClock(now);
    const identity = normalizeViewer(viewer);
    if (!db || typeof db !== 'object') {
      noteReason('no-database');
      return finish([]);
    }
    if (!identity) {
      noteReason('no-viewer');
      return finish([]);
    }

    const text = String(query ?? '').trim();
    // One token set for both channels: the coverage gate and the hash overlap gate
    // must agree with each other and with the indexed form.
    const queryTerms = new Set(terms(text));
    const cache = new Map();
    const recordFor = id => {
      if (cache.has(id)) return cache.get(id);
      let record = null;
      try {
        record = typeof db.getMemory === 'function' ? db.getMemory(id) : null;
      } catch {
        record = null;
      }
      cache.set(id, record);
      return record;
    };

    // Every id that entered the pipeline, usable or not; reported as `candidates`.
    const considered = new Set();
    // id -> record that survived the policy filter; the only rows eligible for output.
    const pool = new Map();
    const lexicalScores = new Map();
    // id -> '' when usable, otherwise the reason it was rejected. A row can be
    // reached by several channels, so it is classified exactly once and counted
    // once in `filteredReasons`.
    const classified = new Map();
    const classify = record => {
      if (!record || typeof record.id !== 'string' || !record.id) return 'missing-record';
      if (classified.has(record.id)) return classified.get(record.id);
      const reason = filterReasonFor(record, identity, clock);
      classified.set(record.id, reason);
      if (reason) noteReason(reason);
      return reason;
    };

    // -- lexical channel ----------------------------------------------------
    const ensureCoverageStats = () => {
      if (!coverageStats) {
        coverageStats = buildCoverageStats(db, identity, queryTerms, settings.coverageFloor);
      }
      return coverageStats;
    };
    if (text) {
      try {
        const hits = typeof db.fullTextSearch === 'function'
          ? await db.fullTextSearch({
            userId: identity.userId,
            personaId: identity.personaId,
            worldId: identity.worldId,
            query: text,
            limit: settings.candidates,
            statuses: ['confirmed'],
          })
          : [];
        const list = Array.isArray(hits) ? hits : [];
        explain.channels.lexical = list.length;
        for (const hit of list) {
          const id = typeof hit?.id === 'string' ? hit.id : '';
          if (!id) continue;
          considered.add(id);
          const record = recordFor(id);
          if (!record) {
            // The FTS row outlived its memory row (interrupted delete/rebuild).
            noteReason('missing-record');
            continue;
          }
          if (pool.has(id)) continue;
          if (classify(record)) continue;
          // OR-ed bigrams make every long question match something; demand enough
          // df-weighted query mass before an "unrelated but least bad" row is kept.
          const stats = ensureCoverageStats();
          const { coverage, matchedTerms } = recordCoverage(record, stats);
          stats.total += 1;
          if (coverage > stats.best) stats.best = coverage;
          if (!coveragePasses(stats, coverage, matchedTerms)) {
            noteReason('low-coverage');
            continue;
          }
          stats.kept += 1;
          pool.set(id, record);
          lexicalScores.set(id, numberOr(hit.score, 0));
        }
      } catch {
        noteReason('lexical-error');
      }
    }

    // -- bounded "recent + important" pool ----------------------------------
    // Feeds the vector channel (the vector table has no by-id query) and is the
    // whole answer for an empty query. Bounded by `candidates` so recall never
    // degenerates into a full table scan.
    const recent = [];
    try {
      const rows = typeof db.listMemories === 'function'
        ? db.listMemories({
          userId: identity.userId,
          personaId: identity.personaId,
          worldId: identity.worldId,
          status: 'confirmed',
          limit: settings.candidates,
        })
        : [];
      for (const record of Array.isArray(rows) ? rows : []) {
        if (!record || typeof record.id !== 'string' || !record.id) continue;
        considered.add(record.id);
        recent.push(record);
      }
    } catch {
      noteReason('recent-error');
    }

    // Recent rows join the candidate set so the vector channel can rank a record
    // the FTS expression did not match verbatim. They carry no lexical score, so
    // they only surface when their vector is actually similar to the query.
    if (text) {
      for (const record of recent) {
        if (pool.has(record.id)) continue;
        if (classify(record)) continue;
        pool.set(record.id, record);
      }
    }

    // -- empty query: recent important facts, never the whole table ---------
    if (!text) {
      const usable = [];
      for (const record of recent) {
        if (classify(record)) continue;
        if (!pool.has(record.id)) pool.set(record.id, record);
        usable.push(record);
      }
      usable.sort((left, right) => numberOr(right.importance, 0) - numberOr(left.importance, 0)
        || String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
        || String(left.id).localeCompare(String(right.id)));
      const picked = usable.slice(0, settings.topK).map(record => ({
        record,
        score: numberOr(record.importance, 0),
        channels: [],
        section: sectionFor(record),
      }));
      explain.backend = picked.length ? 'recent' : 'none';
      explain.candidates = considered.size;
      explain.afterFilter = usable.length;
      explain.afterDedupe = picked.length;
      return finish(picked);
    }

    // -- semantic channel ---------------------------------------------------
    const semanticScores = new Map();
    const vectors = new Map();
    const semanticWanted = settings.semanticEnabled
      && embedder
      && typeof embedder.embed === 'function'
      && (typeof embedder.enabled !== 'function' || embedder.enabled() !== false);
    if (semanticWanted && pool.size) {
      try {
        const batch = await embedder.embed([text]);
        // P1-7: the *batch* decides the index key and the gate, never the
        // configured target. A degraded remote falls back to local hash vectors,
        // and comparing those against a neural index would be a vector space mixup.
        const source = batchSourceOf(batch, embedder);
        const queryVector = Array.isArray(batch) && batch.length ? batch[0] : null;
        if (source.provider === 'off') {
          noteReason('semantic-off');
        } else if (source.degraded) {
          // This turn has no trustworthy vector identity; use the lexical channel.
          noteReason('semantic-degraded');
        } else if (queryVector && queryVector.length) {
          const semanticFloor = resolveSemanticFloor(settings, source);
          const hashChannel = source.provider === 'local';
          // Read the vectors of the candidate set only, keyed by the source that
          // actually produced the query vector; a store without the by-id read
          // falls back to one bounded scan inside the helper.
          const rows = readCandidateVectors(db, {
            provider: source.provider,
            model: source.model,
            memoryIds: [...pool.keys()],
            noteReason,
          });
          for (const row of rows) {
            const id = String(row?.memoryId ?? '');
            if (!id || !pool.has(id)) continue;
            const vector = row?.vector;
            if (!vector || !vector.length) continue;
            vectors.set(id, vector);
          }
          for (const id of pool.keys()) {
            // Hash vectors only: reject anything without a shared indexed token
            // before spending a cosine, so collisions cannot leak into the prompt.
            if (hashChannel && !sharesIndexedTerm(pool.get(id), queryTerms)) {
              noteReason('semantic-no-overlap');
              continue;
            }
            const vector = vectors.get(id);
            if (!vector) {
              noteReason('missing-vector');
              continue;
            }
            const score = cosineSimilarity(queryVector, vector);
            if (!(score > semanticFloor)) {
              // Zero scores are the common case (no shared feature at all); only
              // count the ones that were positive but too weak to trust.
              if (score > settings.minScore) noteReason('semantic-below-floor');
              continue;
            }
            semanticScores.set(id, score);
          }
          explain.channels.semantic = semanticScores.size;
        } else {
          noteReason('semantic-empty');
        }
      } catch {
        noteReason('semantic-error');
      }
    } else if (semanticWanted && !pool.size) {
      noteReason('empty-candidate-pool');
    }

    // -- fusion, de-duplication, sections -----------------------------------
    const fused = fuse({
      lexical: [...lexicalScores].map(([id, score]) => ({ id, score })),
      semantic: [...semanticScores].map(([id, score]) => ({ id, score })),
      rrfK: settings.rrfK,
    });
    explain.candidates = considered.size;
    explain.afterFilter = pool.size;

    // -- rerank (contract §8.4) ----------------------------------------------
    // Runs after fusion, before MMR/budget. Every failure is fail-open: the
    // fusion order survives and only a reason code is recorded (never text).
    let ranked = fused;
    const rerankSettings = config && typeof config === 'object' ? config.rerank : null;
    if (rerankSettings && rerankSettings.enabled && text && fused.length > 1) {
      try {
        const reranker = providedReranker && typeof providedReranker.rerank === 'function'
          ? providedReranker
          : createReranker({ settings: rerankSettings, log });
        if (reranker.enabled()) {
          const outcome = await reranker.rerank({
            query: text,
            candidates: fused.map(item => ({
              id: item.id,
              text: String(pool.get(item.id)?.value ?? ''),
            })),
          });
          const scores = outcome?.scores instanceof Map ? outcome.scores : new Map();
          if (!scores.size) throw new RerankError('rerank-empty');
          ranked = blendRanking(fused, scores, clampNumber(rerankSettings.blend, 0, 1, 0.7));
          explain.rerank = {
            applied: true,
            model: String(outcome?.model ?? ''),
            latencyMs: clampInt(outcome?.latencyMs, 0, 60000, 0),
            candidates: scores.size,
          };
        }
      } catch (error) {
        // fail-open：保持融合顺序；理由码只写进 explain，日志只写固定 code。
        noteReason('rerank-unavailable');
        explain.rerank = { applied: false, model: '', latencyMs: 0, candidates: 0 };
        if (typeof log === 'function') {
          try { log({ stage: 'recall', code: `rerank:${String(error?.code ?? 'error')}` }); } catch { /* 忽略 */ }
        }
      }
    }

    const selected = ranked.length
      ? mmrSelect({
        // The value is the near-duplicate fingerprint fallback for candidates that
        // have no stored vector (contract §9: same first 32 chars counts as a dup).
        candidates: ranked.map(item => ({
          id: item.id,
          score: item.score,
          value: String(pool.get(item.id)?.value ?? ''),
        })),
        vectors,
        limit: settings.topK,
        lambda: settings.mmrLambda,
      })
      : [];
    const fusedById = new Map(ranked.map(item => [item.id, item]));
    const entries = [];
    for (const item of selected) {
      const record = pool.get(item.id) ?? recordFor(item.id);
      if (!record) continue;
      entries.push({
        record,
        // Ranking score of the active backend: the RRF fusion score here (bigger
        // means both channels agreed), per-record importance in the recent path.
        // The array order is the MMR selection order.
        score: fusedById.get(item.id)?.score ?? 0,
        channels: fusedById.get(item.id)?.channels ?? [],
        section: sectionFor(record),
      });
    }
    explain.afterDedupe = entries.length;
    if (lexicalScores.size && semanticScores.size) explain.backend = 'hybrid';
    else if (lexicalScores.size) explain.backend = 'lexical';
    else if (semanticScores.size) explain.backend = 'semantic';
    else explain.backend = 'none';
    return finish(entries);
  } catch {
    // Last line of defence: a recall failure must never fail the chat turn.
    noteReason('recall-error');
    return finish(collected);
  }
}

/**
 * One-line JSON for `logs/memory-recall.jsonl`. Contains counts and reason codes
 * only, so a log file can never become a copy of the user's memories.
 */
export function explainLine(explain) {
  try {
    const line = {
      // Backend is one of our own labels; strip anything else so a poisoned
      // caller cannot smuggle text (or a newline) into the recall log.
      backend: String(explain?.backend ?? 'none').toLowerCase().replace(/[^a-z-]/g, '').slice(0, 24) || 'none',
      candidates: clampInt(explain?.candidates, 0, 100000, 0),
      afterFilter: clampInt(explain?.afterFilter, 0, 100000, 0),
      afterDedupe: clampInt(explain?.afterDedupe, 0, 100000, 0),
      channels: {
        lexical: clampInt(explain?.channels?.lexical, 0, 100000, 0),
        semantic: clampInt(explain?.channels?.semantic, 0, 100000, 0),
      },
      filteredReasons: sanitizeReasons(explain?.filteredReasons),
      elapsedMs: clampInt(explain?.elapsedMs, 0, 600000, 0),
    };
    const serialized = JSON.stringify(line).replace(/[\r\n]+/g, ' ');
    return serialized.length > MAX_EXPLAIN_CHARS ? serialized.slice(0, MAX_EXPLAIN_CHARS) : serialized;
  } catch {
    return '{"backend":"none"}';
  }
}

/** Reason keys are generated internally, but never trust a caller's map shape. */
function sanitizeReasons(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  let kept = 0;
  for (const key of Object.keys(value).sort()) {
    if (kept >= MAX_EXPLAIN_REASONS) break;
    if (!/^[a-z0-9_-]{1,40}$/.test(key)) continue;
    const count = clampInt(value[key], 0, 100000, 0);
    if (!count) continue;
    out[key] = count;
    kept += 1;
  }
  return out;
}
