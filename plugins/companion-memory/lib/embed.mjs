import { createHash } from 'node:crypto';

import { redactSecrets, terms } from './text.mjs';

// Vector channel for the companion memory engine.
//
// Two implementations sit behind one provider object:
//
//   * `local`  – signed feature hashing over `terms(text)` (sha256 derived slot
//                plus sign bit, L2 normalised). Zero dependency, zero network,
//                fully deterministic, so it can run inside the desktop app with
//                no model download and no startup cost.
//   * `remote` – OpenAI compatible `POST {baseUrl}/v1/embeddings`. Optional and
//                strictly best effort: missing config, non-2xx answers, broken
//                JSON, dimension mismatches, timeouts and network errors all
//                degrade to the local channel; three consecutive failures open a
//                five minute circuit breaker so a dead endpoint cannot add
//                latency to every chat turn.
//
// HONESTY NOTE ON THE LOCAL CHANNEL: this is a *lexical* approximation, not a
// neural semantic vector. Texts that share Chinese bigrams or latin words land
// close together (and a shared bigram set gives partial credit), but it does not
// represent meaning: "拿铁" is not near "咖啡" unless they share characters. It
// is deliberately named `hash-bigram-<dims>` so a row in `memory_embeddings`
// never pretends to be a real model embedding. Swap `provider: 'remote'` when a
// real encoder is available; the two channels are interchangeable for cosine
// ranking, but their vectors must never be mixed in one index (the provider,
// model and dimensions triple keys the index).
//
// Degradation contract (CONTRACT.md §9/§13): no public function in this module
// may throw into the chat path. Local hashing cannot fail for well formed input
// and every remote path is wrapped so that a failure returns local vectors.
//
// Identity contract: a batch of vectors never claims a model that did not produce
// it. `embed()` tags every batch with `source` = { provider, model, dimensions,
// version, degraded } and callers must use that as the *index key*; a degraded
// remote call reports `provider: 'local'` + `hash-bigram-<dims>`, never the
// remote model name. `provider`/`model` on the provider object and in `health()`
// describe the configured target only (see `health().lastSource` for reality).

/** Vector layout version. Bump when the local hash scheme changes so indexes rebuild. */
export const EMBEDDING_VERSION = 1;

export const DEFAULT_DIMENSIONS = 256;
export const LOCAL_MODEL_PREFIX = 'hash-bigram';
/** Name of the default local model: `hash-bigram-256`. */
export const LOCAL_MODEL = `${LOCAL_MODEL_PREFIX}-${DEFAULT_DIMENSIONS}`;
export const EMBEDDING_PROVIDERS = Object.freeze(['local', 'remote', 'off']);
export const DEFAULT_TIMEOUT_MS = 4000;
/** Consecutive remote failures that open the circuit breaker. */
export const FAILURE_THRESHOLD = 3;
/** How long the breaker stays open before the next probe (5 minutes). */
export const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

const MIN_DIMENSIONS = 8;
const MAX_DIMENSIONS = 4096;
const MAX_ERROR_CHARS = 200;

function toDimensions(value, fallback = DEFAULT_DIMENSIONS) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_DIMENSIONS, Math.max(MIN_DIMENSIONS, Math.trunc(number)));
}

function toCount(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** Honest model name for the local channel: the dimension is part of the name. */
export function localModelName(dimensions = DEFAULT_DIMENSIONS) {
  return `${LOCAL_MODEL_PREFIX}-${toDimensions(dimensions)}`;
}

/** Coerce anything into a list of strings; a bare string counts as one item. */
function toTexts(input) {
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) return input.map(item => String(item ?? ''));
  if (input == null) return [];
  if (typeof input[Symbol.iterator] === 'function') return [...input].map(item => String(item ?? ''));
  return [String(input)];
}

function l2Normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    if (Number.isFinite(value)) sum += value * value;
    else vector[i] = 0;
  }
  if (!(sum > 0)) return vector;
  const scale = 1 / Math.sqrt(sum);
  for (let i = 0; i < vector.length; i++) vector[i] = vector[i] * scale;
  return vector;
}

/**
 * Deterministic signed feature hashing of `terms(text)` into `dimensions` floats.
 *
 * Each token (Chinese overlapping bigram or latin word, as produced by
 * lib/text.mjs) is hashed with sha256: the first four bytes pick the slot, one
 * bit of the digest picks the sign. Collisions are expected and allowed; the
 * signed projection keeps them from systematically inflating similarity.
 * The result is L2 normalised, so cosine similarity is just a dot product.
 *
 * Same text + same dimensions => byte identical vector, on every platform and
 * every process. Empty text (or text made only of stop words) => all zeros, and
 * `cosineSimilarity` reports 0 against anything for a zero vector.
 */
export function hashEmbedding(text, { dimensions = DEFAULT_DIMENSIONS } = {}) {
  const dims = toDimensions(dimensions);
  const vector = new Float32Array(dims);
  const tokens = terms(String(text ?? ''));
  if (!tokens.length) return vector;
  for (const token of tokens) {
    const digest = createHash('sha256').update(token, 'utf8').digest();
    const slot = digest.readUInt32BE(0) % dims;
    const sign = (digest[7] & 1) === 0 ? 1 : -1;
    vector[slot] += sign;
  }
  return l2Normalize(vector);
}

/**
 * Cosine similarity of two vectors, clamped to [-1, 1].
 * Mismatched lengths, missing input and zero vectors all give 0 (never NaN),
 * which keeps a broken embedding row from poisoning a ranking.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const length = Number(a.length ?? 0);
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (length !== Number(b.length ?? 0)) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  if (!(left > 0) || !(right > 0)) return 0;
  const cosine = dot / Math.sqrt(left * right);
  if (!Number.isFinite(cosine)) return 0;
  return Math.min(1, Math.max(-1, cosine));
}

/**
 * Accepts the usual OpenAI compatible base URLs and returns the embeddings
 * endpoint: `.../v1` gains `/embeddings`, a bare host gains `/v1/embeddings`,
 * and an already complete `/embeddings` URL is left alone.
 */
export function resolveEmbeddingsUrl(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/embeddings$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
}

function resolveApiKey(settings) {
  const direct = typeof settings?.apiKey === 'string' ? settings.apiKey.trim() : '';
  if (direct) return direct;
  const envName = typeof settings?.apiKeyEnv === 'string' ? settings.apiKeyEnv.trim() : '';
  if (!envName) return '';
  const fromEnv = process.env?.[envName];
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
}

function describeError(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const safe = redactSecrets(raw).replace(/\s+/g, ' ').trim();
  if (!safe) return '未知错误';
  return safe.length > MAX_ERROR_CHARS ? `${safe.slice(0, MAX_ERROR_CHARS - 1)}…` : safe;
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Order the rows of an OpenAI/ollama style embeddings payload. */
function extractRows(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.data)) {
    const rows = payload.data.map((row, index) => ({
      index: Number.isFinite(Number(row?.index)) ? Number(row.index) : index,
      embedding: row?.embedding,
    }));
    rows.sort((left, right) => left.index - right.index);
    return rows.map(row => row.embedding);
  }
  // Ollama's native /v1/embeddings answers with a bare array of arrays.
  if (Array.isArray(payload.embeddings)) return payload.embeddings;
  return null;
}

function toVectors(payload, count, dimensions) {
  const rows = extractRows(payload);
  if (!rows) throw new Error('向量响应缺少 data 字段');
  if (rows.length !== count) throw new Error(`向量响应条数不符：期望 ${count}，实际 ${rows.length}`);
  return rows.map(row => {
    const values = row;
    if (!values || typeof values.length !== 'number') throw new Error('向量响应缺少 embedding');
    if (values.length !== dimensions) {
      throw new Error(`向量维度不符：期望 ${dimensions}，实际 ${values.length}`);
    }
    const vector = new Float32Array(dimensions);
    for (let i = 0; i < dimensions; i++) {
      const value = Number(values[i]);
      if (!Number.isFinite(value)) throw new Error('向量响应包含非法数值');
      vector[i] = value;
    }
    // Remote vectors are normalised too, so every stored vector is unit length
    // and cosine ranking stays comparable whatever the upstream model returns.
    return l2Normalize(vector);
  });
}

async function readJsonBody(response) {
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!String(text ?? '').trim()) throw new Error('向量响应为空');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('向量响应不是合法 JSON');
    }
  }
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      throw new Error('向量响应不是合法 JSON');
    }
  }
  throw new Error('向量响应不可读取');
}

async function fetchRemoteVectors({
  fetchImpl, url, apiKey, model, dimensions, timeoutMs, texts, signal,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timer?.unref === 'function') timer.unref();

  let combined = controller.signal;
  if (signal && typeof signal === 'object') {
    if (signal.aborted) combined = signal;
    else if (typeof AbortSignal?.any === 'function') {
      try {
        combined = AbortSignal.any([controller.signal, signal]);
      } catch {
        combined = controller.signal;
      }
    }
  }

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: texts }),
      signal: combined,
    });
    if (!response || typeof response !== 'object') throw new Error('向量响应无效');
    if (response.ok !== true) {
      throw new Error(`向量接口返回状态 ${numberOr(response.status, 0)}`);
    }
    const payload = await readJsonBody(response);
    return toVectors(payload, texts.length, dimensions);
  } catch (error) {
    if (timedOut) throw new Error(`向量请求超时（${timeoutMs}ms）`);
    throw error instanceof Error ? error : new Error(`向量请求失败：${describeError(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the vector provider described by CONTRACT.md §9.
 *
 * HONEST IDENTITY: the configured channel and the channel that actually produced
 * a vector are two different facts, and the engine indexes by the second one.
 * `provider`/`model` on the provider object and in `health()` describe the
 * *configured target*; every `embed()` call reports what really produced those
 * vectors through `batch.source`. When a remote request fails (or its circuit is
 * open, or the remote config is unusable) the local hash fallback runs and the
 * source is `{ provider: 'local', model: 'hash-bigram-<dims>', degraded: true }`
 * — never the remote identity. Callers MUST key the vector index on `source`
 * (and compare vectors within one source), never on the configured values,
 * otherwise hash vectors and neural vectors are silently mixed into one space.
 *
 * @param config - `{ provider: 'local'|'remote'|'off', model, dimensions, baseUrl,
 *                   apiKey, apiKeyEnv, timeoutMs }` (see config.mjs `embedding`).
 * @param options - `{ fetchImpl, now }`; both injected so tests never touch the
 *                  network or the wall clock.
 * @returns `{ provider, model, dimensions, version, embed, enabled, health }`.
 *
 * `embed(texts, { signal })` resolves to an `EmbeddingBatch`: a plain Array with
 * one Float32Array per input text (so existing `batch.length`, `batch[0]`,
 * `Array.isArray()`, spread and `.map()` call sites keep working) plus two
 * non-enumerable properties:
 *
 *   `batch.vectors` — the same array, so `const { vectors, source } = await embed()`
 *                     works as well;
 *   `batch.source`  — `{ provider, model, dimensions, version, degraded }`.
 *
 * Non-enumerable keeps `JSON.stringify(batch)` a bare array and keeps
 * `assert.deepStrictEqual(batch, plainArray)` passing, so read `batch.source`
 * explicitly. A batch never mixes sources: one call is either fully remote or
 * fully local.
 *
 * Everything mutable (failure counter, breaker deadline, degradation counters)
 * lives in this closure. `embed()` never rejects.
 */
export async function createEmbeddingProvider(config = {}, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  const clock = () => {
    try {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  };
  const requested = EMBEDDING_PROVIDERS.includes(settings.provider) ? settings.provider : 'local';
  const dimensions = toDimensions(settings.dimensions);
  const timeoutMs = toCount(settings.timeoutMs, 50, 120000, DEFAULT_TIMEOUT_MS);
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : null;
  const localName = localModelName(dimensions);
  const remoteModel = String(settings.model ?? '').trim();
  const url = requested === 'remote' ? resolveEmbeddingsUrl(settings.baseUrl) : '';
  const apiKey = requested === 'remote' ? resolveApiKey(settings) : '';

  // `provider`/`model` are the configured target: 'local' → the honest hash
  // model name, 'remote' → the configured remote model (may be empty), 'off' → ''.
  const targetModel = requested === 'remote' ? remoteModel : requested === 'local' ? localName : '';

  // A remote target is only reachable with a url, a model and a fetch function.
  // Anything missing keeps this provider permanently on the local channel; every
  // call then reports a degraded local source instead of a fake remote identity.
  let bootstrapError = '';
  if (requested === 'remote') {
    if (!fetchFn) bootstrapError = '远程向量缺少 fetch 实现，已降级为本地哈希向量';
    else if (!url) bootstrapError = '远程向量缺少 baseUrl，已降级为本地哈希向量';
    else if (!remoteModel) bootstrapError = '远程向量缺少 model，已降级为本地哈希向量';
  }
  const remoteReady = requested === 'remote' && !bootstrapError;

  const state = {
    failures: 0,
    circuitOpenUntil: 0,
    lastError: '',
    degradedCount: 0,
    lastDegradedAt: '',
    lastSource: null,
    createdAt: new Date(clock()).toISOString(),
  };

  const localSource = Object.freeze({
    provider: 'local', model: localName, dimensions, version: EMBEDDING_VERSION, degraded: false,
  });
  const degradedSource = Object.freeze({
    provider: 'local', model: localName, dimensions, version: EMBEDDING_VERSION, degraded: true,
  });
  const remoteSource = Object.freeze({
    provider: 'remote', model: remoteModel, dimensions, version: EMBEDDING_VERSION, degraded: false,
  });
  const offSource = Object.freeze({
    provider: 'off', model: '', dimensions, version: EMBEDDING_VERSION, degraded: false,
  });
  // What this provider produces while it is healthy: real remote vectors, or the
  // honest local hash vectors of a local/off configuration.
  const configuredSource = requested === 'off' ? offSource : requested === 'remote' ? remoteSource : localSource;
  /** The only source a remote target may fall back to. */
  const fallbackSource = requested === 'remote' ? degradedSource : requested === 'local' ? localSource : offSource;

  function makeBatch(vectors, source) {
    Object.defineProperty(vectors, 'vectors', { value: vectors, enumerable: false });
    Object.defineProperty(vectors, 'source', { value: source, enumerable: false });
    return vectors;
  }

  function rememberSource(source) {
    state.lastSource = source;
    if (source.degraded) {
      state.degradedCount += 1;
      state.lastDegradedAt = new Date(clock()).toISOString();
    }
    return source;
  }

  function localVectors(texts) {
    return texts.map(text => {
      try {
        return hashEmbedding(text, { dimensions });
      } catch {
        return new Float32Array(dimensions);
      }
    });
  }

  function zeroVectors(texts) {
    return texts.map(() => new Float32Array(dimensions));
  }

  function noteFailure(error, when) {
    state.failures += 1;
    state.lastError = describeError(error);
    if (state.failures >= FAILURE_THRESHOLD) state.circuitOpenUntil = when + CIRCUIT_COOLDOWN_MS;
  }

  function noteSuccess() {
    state.failures = 0;
    state.circuitOpenUntil = 0;
    state.lastError = '';
  }

  async function embedGuarded(input, options = {}) {
    const texts = toTexts(input);
    // Empty batch: nothing is produced and nothing may be indexed, so the source
    // just describes the configured channel and no counters move.
    if (!texts.length) return makeBatch([], configuredSource);

    if (requested === 'off') return makeBatch(zeroVectors(texts), rememberSource(offSource));
    if (!remoteReady) return makeBatch(localVectors(texts), rememberSource(fallbackSource));

    const signal = options && typeof options === 'object' ? options.signal : undefined;
    if (state.circuitOpenUntil > clock()) return makeBatch(localVectors(texts), rememberSource(degradedSource));

    try {
      const vectors = await fetchRemoteVectors({
        fetchImpl: fetchFn, url, apiKey, model: remoteModel, dimensions, timeoutMs, texts, signal,
      });
      noteSuccess();
      return makeBatch(vectors, rememberSource(remoteSource));
    } catch (error) {
      noteFailure(error, clock());
      return makeBatch(localVectors(texts), rememberSource(degradedSource));
    }
  }

  /**
   * Embed texts. Always resolves with an `EmbeddingBatch` of the same length as
   * the input; use `batch.source` as the index key (see the factory comment).
   */
  async function embed(input, options = {}) {
    try {
      return await embedGuarded(input, options);
    } catch (error) {
      // Last line of defence: nothing here may reach the chat turn.
      noteFailure(error, clock());
      return makeBatch(localVectors(toTexts(input)), rememberSource(fallbackSource));
    }
  }

  /** Is the semantic channel switched on at all (`provider: 'off'` disables it)? */
  function enabled() {
    return requested !== 'off';
  }

  /**
   * Index/diagnostic facts.
   *
   * `provider`/`model` are the **configured target**, not what produced the last
   * vectors: for the real identity of a batch use `batch.source` (or `lastSource`
   * here). `version` + `dimensions` complete the index key together with the
   * source's provider/model; `createdAt` is when this instance was built.
   * `degradedCount` counts batches that had to fall back to local vectors,
   * `lastDegradedAt` is the ISO time of the most recent one ('' when none), and
   * `circuitOpenUntil` is 0 while the breaker is closed.
   */
  function health() {
    return {
      provider: requested,
      model: targetModel,
      dimensions,
      version: EMBEDDING_VERSION,
      failures: state.failures,
      circuitOpenUntil: state.circuitOpenUntil,
      lastError: state.lastError || bootstrapError,
      createdAt: state.createdAt,
      degradedCount: state.degradedCount,
      lastDegradedAt: state.lastDegradedAt,
      lastSource: state.lastSource,
    };
  }

  return Object.freeze({
    provider: requested,
    model: targetModel,
    dimensions,
    version: EMBEDDING_VERSION,
    embed,
    enabled,
    health,
  });
}
