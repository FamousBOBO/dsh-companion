// 远端重排序适配器（契约 §8.4）。
//
// 这一层只做一件事：把 query + 候选文本发给 OpenAI 兼容的 rerank 端点，拿回
// 每个候选的 relevance 分数。它不碰数据库、不写向量，也绝不把记忆正文写进日志。
//
// 可靠性约定：
//   * 任何失败都抛 RerankError（带固定 code），由 retrieve.recall() fail-open；
//   * 端点只做一次主请求，遇到 404/405 允许换另一种拼法重试一次（不做多轮探测）；
//   * 超时用 AbortController + timeoutMs；外部 signal 会被合并。

import { redactSecrets, truncate } from './text.mjs';

export const DEFAULT_RERANK_TIMEOUT_MS = 4000;
const MAX_DOCUMENT_CHARS = 2000;
// 只有「端点拼错了」才值得换一种拼法再试一次；401/超时/形状错误重试没有意义。
const RETRYABLE_HTTP = new Set(['rerank-http-404', 'rerank-http-405']);
const RESPONSE_SHAPES = ['results', 'data', 'output'];

/** 固定 code 的错误；message 只用于开发排查，不写日志、不回给用户。 */
export class RerankError extends Error {
  constructor(code, message = '') {
    super(message || code);
    this.name = 'RerankError';
    this.code = code;
  }
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInt(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * 端点解析（契约 §8.4）：
 *   - 已经是 `/rerank` 结尾：直接用；
 *   - `.../v1` 这类版本根：补 `/rerank`，回退到去掉版本段的 `/rerank`；
 *   - 裸根：主拼 `{base}/v1/rerank`，回退 `{base}/rerank`。
 * 返回数组是「尝试顺序」，调用方最多各发一次。
 */
export function resolveRerankUrls(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return [];
  if (/\/rerank$/i.test(base)) return [base];
  if (/\/v\d+$/i.test(base)) {
    const root = base.replace(/\/v\d+$/i, '');
    return [...new Set([`${base}/rerank`, `${root}/rerank`])];
  }
  return [`${base}/v1/rerank`, `${base}/rerank`];
}

/** apiKey 直填优先，其次 apiKeyEnv（与 lib/embed.mjs 的取值顺序一致）。 */
export function resolveRerankApiKey(settings = {}) {
  const direct = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
  if (direct) return direct;
  const envName = typeof settings.apiKeyEnv === 'string' ? settings.apiKeyEnv.trim() : '';
  if (!envName) return '';
  const fromEnv = process.env?.[envName];
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
}

function scoreOf(row) {
  const raw = row && typeof row === 'object'
    ? (row.relevance_score ?? row.score ?? row.relevance)
    : null;
  const score = Number(raw);
  return Number.isFinite(score) ? score : null;
}

/**
 * 解析三种常见形状：
 *   { results: [{ index, relevance_score }] }
 *   { data:    [{ index, score }] }
 *   { output:  { results: [...] } }
 * -> Map<index, score>；无法识别时抛 rerank-bad-shape。
 */
export function parseRerankResponse(payload) {
  let rows = null;
  if (Array.isArray(payload?.results)) rows = payload.results;
  else if (Array.isArray(payload?.data)) rows = payload.data;
  else if (Array.isArray(payload?.output?.results)) rows = payload.output.results;
  if (!rows) throw new RerankError('rerank-bad-shape');
  const scores = new Map();
  for (const row of rows) {
    const index = Number(row?.index);
    const score = scoreOf(row);
    if (!Number.isInteger(index) || index < 0 || score === null) continue;
    // 同一 index 重复时保留较大分数，避免上游重复输出把候选压下去。
    if (!scores.has(index) || score > scores.get(index)) scores.set(index, score);
  }
  if (!scores.size) throw new RerankError('rerank-bad-shape');
  return scores;
}

/** 候选文本：字符串直接用，对象取 text/value/searchText；截断且脱敏。 */
function documentText(candidate) {
  if (candidate == null) return '';
  const raw = typeof candidate === 'string'
    ? candidate
    : (candidate.text ?? candidate.value ?? candidate.searchText ?? '');
  const text = redactSecrets(String(raw ?? '')).replace(/\s+/g, ' ').trim();
  return truncate(text, MAX_DOCUMENT_CHARS);
}

function headersFor(key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

async function requestRerank(fetchImpl, url, {
  key, model, query, documents, topN, timeoutMs, signal,
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
      try { combined = AbortSignal.any([controller.signal, signal]); } catch { combined = controller.signal; }
    } else {
      try { signal.addEventListener('abort', () => controller.abort(), { once: true }); } catch { /* 忽略 */ }
    }
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: headersFor(key),
      body: JSON.stringify({
        model,
        query,
        documents,
        top_n: topN,
      }),
      signal: combined,
    });
  } catch (error) {
    if (timedOut || error?.name === 'AbortError') throw new RerankError('rerank-timeout');
    throw new RerankError('rerank-network');
  } finally {
    clearTimeout(timer);
  }
  if (!response || typeof response !== 'object') throw new RerankError('rerank-network');

  if (!response.ok) {
    const status = numberOr(response.status, 0);
    if (status === 401) throw new RerankError('rerank-http-401');
    if (status === 404) throw new RerankError('rerank-http-404');
    if (status === 405) throw new RerankError('rerank-http-405');
    throw new RerankError('rerank-http-4xx');
  }

  let payload;
  try {
    payload = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text());
  } catch {
    throw new RerankError('rerank-bad-shape');
  }
  const scores = parseRerankResponse(payload);
  const remoteModel = typeof payload?.model === 'string' && payload.model ? payload.model : '';
  return { scores, model: remoteModel };
}

/**
 * 构建重排序适配器。
 *
 * @param settings  `config.rerank`（enabled/provider/baseUrl/model/apiKey/apiKeyEnv/
 *                  timeoutMs/topN/blend）；未配置时传 undefined 也安全。
 * @param fetchImpl 可注入的 fetch（测试用），默认 globalThis.fetch。
 * @param now       可注入时钟（测量延迟）。
 * @param log       可选日志回调，只接收 { stage:'rerank', code }。
 */
export function createReranker({
  settings = {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = null,
} = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const logCode = code => {
    if (typeof log !== 'function') return;
    try { log({ stage: 'rerank', code: String(code ?? '') }); } catch { /* 日志失败不影响召回 */ }
  };

  const model = () => String(source.model ?? '').trim();
  const timeoutMs = () => clampInt(source.timeoutMs, 500, 30000, DEFAULT_RERANK_TIMEOUT_MS);

  /** 配置看起来可用才值得进入流程（key 缺失交给 rerank() 记 rerank-no-key）。 */
  const enabled = () => Boolean(source.enabled)
    && String(source.provider ?? 'remote') !== 'off'
    && Boolean(String(source.baseUrl ?? '').trim())
    && Boolean(model());

  return {
    enabled,
    model,
    resolveUrls: () => resolveRerankUrls(source.baseUrl),

    /**
     * 只发一次调用（最多因端点拼法换一次 URL）。
     * @returns {Promise<{scores: Map<number, number>, model: string, latencyMs: number}>}
     */
    async rerank({ query = '', candidates = [], signal } = {}) {
      const started = now();
      if (!enabled()) throw new RerankError('rerank-disabled');
      const key = resolveRerankApiKey(source);
      if (!key) {
        logCode('rerank-no-key');
        throw new RerankError('rerank-no-key');
      }
      const documentsAll = (Array.isArray(candidates) ? candidates : []).map(documentText);
      if (!documentsAll.length) {
        logCode('rerank-empty');
        return { scores: new Map(), model: model(), latencyMs: Math.max(0, now() - started) };
      }
      // topN 截断：只把最前面的候选送去重排（0 = 全部），未送出的候选由
      // retrieve 继续使用融合分数（见 blendRanking）。
      const requestedTopN = clampInt(source.topN, 0, 50, 0);
      const documents = requestedTopN > 0 ? documentsAll.slice(0, requestedTopN) : documentsAll;
      const topN = documents.length;

      const urls = resolveRerankUrls(source.baseUrl);
      let lastError = null;
      for (let index = 0; index < urls.length; index += 1) {
        try {
          const result = await requestRerank(fetchImpl, urls[index], {
            key,
            model: model(),
            query: String(query ?? ''),
            documents,
            topN,
            timeoutMs: timeoutMs(),
            signal,
          });
          return {
            scores: result.scores,
            model: result.model || model(),
            latencyMs: Math.max(0, now() - started),
          };
        } catch (error) {
          lastError = error instanceof RerankError ? error : new RerankError('rerank-network');
          const retryable = lastError.code === 'rerank-http-404' || lastError.code === 'rerank-http-405';
          if (!retryable || index === urls.length - 1) break;
        }
      }
      const code = lastError?.code ?? 'rerank-network';
      logCode(code);
      throw lastError ?? new RerankError('rerank-network');
    },
  };
}

export const RERANK_RESPONSE_SHAPES = Object.freeze(RESPONSE_SHAPES);
