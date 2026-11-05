// Public web discovery port for P2 (contract v1.2 section 4).
//
// Before this module the explore capability was a single-URL fetch: usable only when the
// operator already knew the exact address. This port gives the character a real public
// entry point — search, link discovery and hardened page fetch — while keeping every
// request inside `config.p2.autonomy.allowedSources` and refusing private networks unless
// a host is *explicitly* listed there.
//
// Rules enforced on every hop (never only before the first request):
//   * protocol must be http/https, no credentials in the URL;
//   * the host must match the allowlist (domain suffix rule, same as before);
//   * loopback / private / link-local / reserved hosts are refused unless explicitly listed;
//   * redirects are followed manually and every hop is re-validated;
//   * the final URL is re-validated again after the last redirect;
//   * bodies are byte-capped, content types are narrowed per call site, HTML becomes text.
//
// Nothing here writes memory, sends messages or touches the filesystem.

import crypto from 'node:crypto';

export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_BYTES = 200000;
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_MAX_LINKS = 12;
export const MAX_LINKS_CAP = 50;
export const MAX_REDIRECTS_CAP = 5;
export const MAX_SEARCH_RESULTS = 20;
export const DEFAULT_USER_AGENT = 'dsh-companion/0.4 (+p2-public-web; no credentials)';
export const SEED_CACHE_MAX = 40;

const TEXT_CONTENT = /^(text\/html|text\/plain|text\/markdown|application\/xhtml\+xml|text\/xhtml)/i;
const HTML_CONTENT = /^(text\/html|application\/xhtml\+xml|text\/xhtml)/i;
const JSON_CONTENT = /^(application\/(json|[a-z0-9.+-]+\+json)|text\/json)/i;

/** Search providers this port can actually talk to. `none` disables discovery honestly. */
export const SEARCH_PROVIDERS = Object.freeze(['wikipedia', 'wikipedia-zh', 'wikipedia-en', 'duckduckgo-html', 'none']);
export const DEFAULT_SEARCH_PROVIDER = 'wikipedia';

// The provider hosts are part of the allowlist policy: a search is only issued to a host
// the operator already listed, so search never widens what the character may read.
const PROVIDER_HOSTS = Object.freeze({
  'wikipedia': Object.freeze(['en.wikipedia.org', 'zh.wikipedia.org']),
  'wikipedia-zh': Object.freeze(['zh.wikipedia.org']),
  'wikipedia-en': Object.freeze(['en.wikipedia.org']),
  'duckduckgo-html': Object.freeze(['html.duckduckgo.com']),
  'none': Object.freeze([]),
});

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

function textOf(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d{1,6});/g, (_match, code) => {
      const value = Number(code);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ' ';
    });
}

function stripHtml(html) {
  return decodeEntities(String(html ?? '')
    // `<head>` carries the title and metadata, which the port returns separately as
    // `title`; leaving it in the text duplicated the title on every read.
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function titleOf(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
  return match ? stripHtml(match[1]).slice(0, 200) : '';
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

function normalizeRules(allowedSources) {
  return (Array.isArray(allowedSources) ? allowedSources : [])
    .map(entry => String(entry ?? '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 200);
}

/**
 * Allowlist match. Kept byte-compatible with the previous `hostAllowed`: a bare domain
 * rule also matches its subdomains, a full URL rule matches that exact host.
 */
export function hostAllowed(url, allowedSources) {
  let parsed;
  try { parsed = new URL(String(url ?? '')); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  const list = Array.isArray(allowedSources) ? allowedSources : [];
  return list.some(entry => {
    const rule = String(entry ?? '').trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return !isPrivateHost(host);
    if (rule.startsWith('http://') || rule.startsWith('https://')) {
      try { return new URL(rule).hostname.toLowerCase() === host; } catch { return false; }
    }
    return host === rule || host.endsWith(`.${rule}`);
  });
}

/**
 * Loopback / private / link-local / reserved host detection.
 *
 * This is a *literal* check on the URL host: it stops `http://127.0.0.1`, `10.x`, `::1`,
 * `192.168.x`, `.local` and friends. It does not resolve DNS, so a public name that
 * resolves to a private address is still possible; that limitation is recorded in the
 * implementation notes instead of being silently assumed away.
 */
export function isPrivateHost(host) {
  const raw = String(host ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!raw) return true;
  if (raw === 'localhost' || raw.endsWith('.localhost') || raw.endsWith('.local') || raw.endsWith('.internal') || raw.endsWith('.home.arpa')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    const parts = raw.split('.').map(Number);
    if (parts.some(part => !Number.isFinite(part) || part > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (raw.includes(':')) {
    if (raw === '::' || raw === '::1') return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(raw)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]?:/.test(raw)) return true; // fe80::/10 link local
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
    if (mapped) return isPrivateHost(mapped[1]);
    return false;
  }
  return false;
}

/**
 * One URL guard. Returns `{ ok:true, url, host }` or an honest refusal with a reason code.
 * Called before every request *and* on the final URL after redirects.
 */
export function guardUrl(raw, allowedSources) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, code: 'source-invalid', reason: 'empty-url' };
  let parsed;
  try { parsed = new URL(value); } catch { return { ok: false, code: 'source-invalid', reason: 'invalid-url' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'source-invalid', reason: 'unsupported-protocol', protocol: parsed.protocol.slice(0, 20) };
  }
  if (parsed.username || parsed.password) return { ok: false, code: 'source-invalid', reason: 'credentials-in-url' };
  const host = parsed.hostname.toLowerCase();
  const listed = hostAllowed(parsed.href, allowedSources);
  // Both halves of the contract rule: a private host without an explicit entry is refused
  // outright, and a private host that *is* listed stays reachable for local acceptance runs.
  if (isPrivateHost(host) && !listed) return { ok: false, code: 'source-private-host', reason: 'private-host-not-allowlisted', host };
  if (!listed) return { ok: false, code: 'source-invalid', reason: 'host-not-allowed', host };
  return { ok: true, url: parsed.href, host };
}

/** Absolute-path article URL for one search hit (no redirect wrapper, no query string). */
function articleUrl(host, title) {
  const slug = String(title ?? '').trim().replace(/\s+/g, '_');
  return `https://${host}/wiki/${encodeURIComponent(slug)}`;
}

/** Unwrap DuckDuckGo's `//duckduckgo.com/l/?uddg=<encoded>` redirect wrapper. */
function unwrapDuckDuckGo(href, base) {
  const value = decodeEntities(textOf(href)).trim();
  if (!value) return '';
  let absolute;
  try { absolute = new URL(value, base).href; } catch { return ''; }
  try {
    const parsed = new URL(absolute);
    if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/l/')) {
      const target = parsed.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
  } catch { /* keep the literal URL */ }
  return absolute;
}

function parseDuckDuckGoResults(html, limit) {
  const anchors = [...String(html ?? '').matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...String(html ?? '').matchAll(/<(a|div|td)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map(match => stripHtml(match[2]).slice(0, 240));
  const results = [];
  for (let index = 0; index < anchors.length && results.length < limit; index += 1) {
    const url = unwrapDuckDuckGo(anchors[index][1], 'https://duckduckgo.com/');
    if (!url) continue;
    results.push({ url, title: stripHtml(anchors[index][2]).slice(0, 200), snippet: snippets[index] ?? '' });
  }
  return results;
}

function parseWikipediaResults(payload, host, limit) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const rows = Array.isArray(body?.query?.search) ? body.query.search : [];
  const results = [];
  for (const row of rows.slice(0, limit)) {
    const title = textOf(row?.title).trim();
    if (!title) continue;
    results.push({ url: articleUrl(host, title), title: title.slice(0, 200), snippet: stripHtml(textOf(row?.snippet)).slice(0, 240) });
  }
  return results;
}

function clampLimit(value, fallback, cap) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(cap, number);
}

/** Read a fetch Response body as bytes, refusing anything over `maxBytes`. */
async function readBounded(response, maxBytes) {
  const chunks = [];
  let size = 0;
  const body = response?.body;
  if (!body) return { ok: true, raw: '', bytes: 0 };
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) return { ok: false, code: 'source-invalid', reason: 'too-large', bytes: size };
      chunks.push(buffer);
    }
  } catch (error) {
    return { ok: false, code: 'source-fetch-failed', reason: error instanceof Error ? error.message : String(error), noAnswer: true };
  }
  return { ok: true, raw: Buffer.concat(chunks).toString('utf8'), bytes: size };
}

/**
 * Build the public web port.
 *
 * @param allowedSources   `config.p2.autonomy.allowedSources` (domains or URLs)
 * @param seedUrls         `config.p2.autonomy.seedUrls` — operator-verified entry pages
 * @param searchProvider   one of SEARCH_PROVIDERS; `none` reports `search-unavailable`
 * @param maxLinksPerPage  `config.p2.autonomy.maxLinksPerPage`
 * @param fetchImpl        injectable fetch (tests never touch the network)
 */
export function createWebPort({
  allowedSources = [],
  seedUrls = [],
  searchProvider = DEFAULT_SEARCH_PROVIDER,
  maxLinksPerPage = DEFAULT_MAX_LINKS,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  userAgent = DEFAULT_USER_AGENT,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  dayKey = null,
} = {}) {
  const rules = normalizeRules(allowedSources);
  const provider = SEARCH_PROVIDERS.includes(searchProvider) ? searchProvider : DEFAULT_SEARCH_PROVIDER;
  const providerHosts = PROVIDER_HOSTS[provider] ?? [];
  const linkLimitCap = clampLimit(maxLinksPerPage, DEFAULT_MAX_LINKS, MAX_LINKS_CAP);
  const byteCap = clampLimit(maxBytes, DEFAULT_MAX_BYTES, 4 * 1024 * 1024);
  const redirectCap = Number.isFinite(Number(maxRedirects)) && Number(maxRedirects) >= 0
    ? Math.min(MAX_REDIRECTS_CAP, Math.trunc(Number(maxRedirects)))
    : DEFAULT_MAX_REDIRECTS;
  const seedList = normalizeSeeds(seedUrls);
  const seedCache = new Map();
  let lastSearch = null;

  function normalizeSeeds(input) {
    const list = Array.isArray(input) ? input : [];
    return list.map(entry => {
      if (typeof entry === 'string') return { url: entry.trim(), title: '' };
      if (entry && typeof entry === 'object' && typeof entry.url === 'string') return { url: entry.url.trim(), title: textOf(entry.title).trim() };
      return null;
    }).filter(item => item && item.url).slice(0, 50);
  }

  function allowedProviderHosts() {
    return providerHosts.filter(host => hostAllowed(`https://${host}/`, rules));
  }

  async function request(target, { accept = TEXT_CONTENT, acceptHeader = 'text/html,text/plain;q=0.9', method = 'GET' } = {}) {
    // round-3 A1: "we could not ask" is NOT "the server said no". `noAnswer` travels to the lifecycle
    // layer, which records it as `unknown` (and refuses to retry) instead of a definite failure.
    if (typeof fetchImpl !== 'function') return { ok: false, code: 'source-fetch-failed', reason: 'fetch-unavailable', noAnswer: true };
    let current = String(target ?? '');
    let redirects = 0;
    for (;;) {
      // Re-validate before *every* request: the first hop and each redirect target.
      const guard = guardUrl(current, rules);
      if (!guard.ok) return guard;
      let response;
      try {
        response = await fetchImpl(guard.url, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: acceptHeader, 'user-agent': userAgent },
        });
      } catch (error) {
        return { ok: false, code: 'source-fetch-failed', reason: error instanceof Error ? error.message : String(error), noAnswer: true };
      }
      const status = Number(response?.status ?? 0) || 0;
      if (status >= 300 && status < 400) {
        // Free the redirect body before the next hop (real fetch keeps the socket otherwise).
        try { await response.body?.cancel?.(); } catch { /* body already consumed */ }
        let location = '';
        try { location = textOf(response.headers?.get?.('location')).trim(); } catch { location = ''; }
        if (!location) return { ok: false, code: 'source-fetch-failed', status, reason: 'redirect-without-location' };
        if (redirects >= redirectCap) return { ok: false, code: 'source-invalid', status, reason: 'too-many-redirects', redirects };
        let next;
        try { next = new URL(location, guard.url).href; } catch { return { ok: false, code: 'source-invalid', status, reason: 'invalid-redirect' }; }
        redirects += 1;
        current = next;
        continue;
      }
      if (status < 200 || status >= 300) return { ok: false, code: 'source-fetch-failed', status, reason: `http-${status}` };
      let contentType = '';
      try { contentType = textOf(response.headers?.get?.('content-type')); } catch { contentType = ''; }
      if (!accept.test(contentType)) {
        return { ok: false, code: 'source-invalid', status, reason: 'unsupported-content-type', contentType: contentType.slice(0, 80) };
      }
      // Re-validate the URL the response actually came from (defence in depth: with manual
      // redirects this is the same URL, but a proxy or a test double may report another).
      const finalUrl = textOf(response?.url) || guard.url;
      const finalGuard = guardUrl(finalUrl, rules);
      if (!finalGuard.ok) return { ...finalGuard, reason: `redirect-left-allowlist:${finalGuard.reason}` };
      const body = await readBounded(response, byteCap);
      if (!body.ok) return { ...body, status };
      return { ok: true, status, contentType: contentType.slice(0, 80), raw: body.raw, bytes: body.bytes, finalUrl: finalGuard.url, redirects };
    }
  }

  async function documentOf(url, accept) {
    const fetched = await request(url, accept);
    if (!fetched.ok) return fetched;
    const isHtml = HTML_CONTENT.test(fetched.contentType);
    const text = isHtml ? stripHtml(fetched.raw) : fetched.raw.trim();
    return { ...fetched, isHtml, text, title: isHtml ? titleOf(fetched.raw) : '' };
  }

  /** Hardened page fetch: allowlist + private-host guard on every hop, capped, HTML→text. */
  async function fetchPage({ url } = {}) {
    const doc = await documentOf(url, { accept: TEXT_CONTENT });
    if (!doc.ok) return doc;
    return {
      ok: true,
      status: doc.status,
      contentType: doc.contentType,
      finalUrl: doc.finalUrl,
      title: doc.title,
      text: doc.text,
      bytes: doc.bytes,
      sha256: sha256(doc.text),
      redirects: doc.redirects,
    };
  }

  /** Absolute, deduped, bounded links from one already-allowlisted page. */
  async function discoverLinks({ url, limit } = {}) {
    const cap = clampLimit(limit, linkLimitCap, MAX_LINKS_CAP);
    const doc = await documentOf(url, { accept: HTML_CONTENT });
    if (!doc.ok) return doc;
    const base = doc.finalUrl;
    const sameHost = hostOf(base);
    const seen = new Set();
    const links = [];
    let found = 0;
    const pattern = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    let match = pattern.exec(doc.raw);
    while (match) {
      const href = decodeEntities(textOf(match[2] ?? match[3] ?? match[4])).trim();
      const label = stripHtml(match[5]).slice(0, 120);
      match = pattern.exec(doc.raw);
      if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue;
      let absolute;
      try { absolute = new URL(href, base); } catch { continue; }
      if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue;
      absolute.hash = '';
      const candidate = absolute.href;
      const host = absolute.hostname.toLowerCase();
      // Same host is always in scope for a page we were allowed to read; anything else must
      // be allowlisted. A private host that is not explicitly listed is dropped, not fetched.
      if (host !== sameHost) {
        if (isPrivateHost(host) && !hostAllowed(candidate, rules)) continue;
        if (!hostAllowed(candidate, rules)) continue;
      }
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      found += 1;
      if (links.length < cap) links.push({ url: candidate, text: label, host });
    }
    return { ok: true, finalUrl: base, host: sameHost, links, found, kept: links.length, truncated: found > links.length, limit: cap };
  }

  /** Operator-verified seed pages, validated against the same allowlist before use. */
  function seedPages({ limit } = {}) {
    const cap = clampLimit(limit, linkLimitCap, MAX_LINKS_CAP);
    const pages = [];
    const skipped = [];
    for (const seed of seedList) {
      const guard = guardUrl(seed.url, rules);
      if (!guard.ok) { skipped.push({ url: seed.url, reason: guard.reason ?? guard.code }); continue; }
      if (pages.length >= cap) break;
      pages.push({ url: guard.url, host: guard.host, title: seed.title || guard.host, snippet: 'verified-seed', source: 'seed' });
    }
    return { ok: pages.length > 0, pages, skipped, total: seedList.length, reason: pages.length ? '' : (seedList.length ? 'seeds-not-allowed' : 'no-seeds') };
  }

  /** Live check of the seed list. Every entry is fetched through the same guards. */
  async function verifySeeds({ limit } = {}) {
    const cap = clampLimit(limit, linkLimitCap, MAX_LINKS_CAP);
    const checked = [];
    for (const page of seedPages({ limit: cap }).pages) {
      const started = Number(now()) || Date.now();
      const fetched = await fetchPage({ url: page.url });
      checked.push({
        url: page.url,
        ok: fetched.ok === true,
        status: Number(fetched.status ?? 0) || 0,
        title: fetched.title || page.title,
        bytes: Number(fetched.bytes ?? 0) || 0,
        sha256: fetched.sha256 ?? '',
        ms: (Number(now()) || Date.now()) - started,
        reason: fetched.ok === true ? '' : (fetched.reason ?? fetched.code ?? ''),
      });
    }
    return { ok: checked.some(item => item.ok), seeds: checked, total: checked.length };
  }

  function dayKeyOf() {
    try {
      const value = typeof dayKey === 'function' ? dayKey() : '';
      if (typeof value === 'string' && value) return value;
    } catch { /* fall through to the UTC date */ }
    return new Date(Number(now()) || Date.now()).toISOString().slice(0, 10);
  }

  /**
   * Does the shared P2 budget allow one more request?
   *
   * The port never writes the budget ledger (that is the runtime's job); it only refuses to
   * open a socket when the caller says the day has no request left. A gate that is present
   * but unreadable counts as exhausted: never spend what cannot be accounted for.
   */
  function budgetRefusal(budget) {
    if (budget === undefined || budget === null) return '';
    if (typeof budget === 'function') {
      try { return budget({ purpose: 'p2-seeds', requests: 1 }) === false ? 'budget-exhausted' : ''; } catch { return 'budget-exhausted'; }
    }
    if (typeof budget !== 'object') return '';
    if (budget.ok === false || budget.allowed === false) return 'budget-exhausted';
    if (typeof budget.canSpend === 'function') {
      try { return budget.canSpend({ requests: 1 }) === true ? '' : 'budget-exhausted'; } catch { return 'budget-exhausted'; }
    }
    if (budget.remaining !== undefined) {
      const remaining = Number(budget.remaining);
      return Number.isFinite(remaining) && remaining >= 1 ? '' : 'budget-exhausted';
    }
    // A gate object we cannot read is treated as "no budget" rather than "unlimited".
    return Object.keys(budget).length ? 'budget-exhausted' : '';
  }

  function seedCacheKey(topic) {
    return [dayKeyOf(), provider, rules.join('|'), String(topic ?? '').toLowerCase()].join('::');
  }

  function cacheSeedResult(key, value) {
    if (seedCache.size >= SEED_CACHE_MAX) seedCache.delete(seedCache.keys().next().value);
    seedCache.set(key, value);
  }

  /**
   * Concrete candidate sources for one topic (contract v1.2 §3/§4 — the planner needs
   * something it can actually put in `targetRef`).
   *
   * Order: operator-verified seed pages first, then **one** live search. `verified:true`
   * only when the URL was really fetched and hashed by this port; anything else keeps its
   * URL but says why. Cached per topic/day so a planning run cannot drift between the
   * pre-model and post-model material reads (the planner rejects a changed digest), and
   * so one topic never costs two searches.
   */
  async function seeds({ topic, limit, budget, verify } = {}) {
    const text = String(topic ?? '').trim().slice(0, 120);
    const cap = clampLimit(limit, linkLimitCap, MAX_LINKS_CAP);
    const entryPoints = { allowedSources: [...rules], seedUrls: seedList.map(seed => seed.url) };
    if (!rules.length) return { ok: false, code: 'source-allowlist-empty', reason: 'source-allowlist-empty', topic: text, limit: cap, seeds: [], entryPoints, state: 'source-allowlist-empty', verified: 0, cached: false };
    const refusal = budgetRefusal(budget);
    if (refusal) return { ok: false, code: refusal, reason: 'no-request-left', topic: text, limit: cap, seeds: [], entryPoints, state: 'budget-exhausted', verified: 0, cached: false, budget: 'exhausted' };

    const key = seedCacheKey(text);
    const hit = seedCache.get(key);
    if (hit) return { ...hit, seeds: hit.seeds.slice(0, cap), limit: cap, cached: true };

    const entries = [];
    const seen = new Set();
    // 1) Configured seed pages, each proven by a real fetch + hash.
    for (const seed of seedList) {
      if (entries.length >= cap) break;
      if (seen.has(seed.url)) continue;
      seen.add(seed.url);
      const page = await fetchPage({ url: seed.url });
      entries.push({
        url: seed.url,
        host: hostOf(seed.url),
        title: seed.title || page.title || hostOf(seed.url),
        snippet: seed.title ? 'verified-seed' : 'seed-page',
        verified: page.ok === true,
        sha256: page.sha256 ?? '',
        bytes: Number(page.bytes ?? 0) || 0,
        reason: page.ok === true ? '' : (page.reason ?? page.code ?? ''),
        source: 'seed',
      });
    }
    // 2) One live search for the topic, then verify a bounded number of hits.
    let state = 'not-run';
    if (text && entries.length < cap) {
      if (provider === 'none') state = 'search-unavailable';
      else if (!allowedProviderHosts().length) state = 'search-not-allowed';
      else {
        const found = await search({ query: text, limit: cap });
        state = found.ok === true ? 'ok' : (found.code ?? 'search-unavailable');
        if (found.ok) {
          const verifyCap = Number.isFinite(Number(verify)) ? Math.max(0, Math.trunc(Number(verify))) : 1;
          let remainingFetches = verifyCap;
          for (const item of found.results) {
            if (entries.length >= cap) break;
            if (!item?.url || seen.has(item.url)) continue;
            seen.add(item.url);
            const canVerify = remainingFetches > 0;
            if (canVerify) remainingFetches -= 1;
            const page = canVerify ? await fetchPage({ url: item.url }) : null;
            entries.push({
              url: item.url,
              host: item.host || hostOf(item.url),
              title: item.title,
              snippet: item.snippet,
              verified: page?.ok === true,
              sha256: page?.sha256 ?? '',
              bytes: Number(page?.bytes ?? 0) || 0,
              reason: page ? (page.ok === true ? '' : (page.reason ?? page.code ?? '')) : 'not-verified',
              source: 'search',
            });
          }
        }
      }
    }
    const result = {
      ok: entries.length > 0,
      topic: text,
      limit: cap,
      seeds: entries,
      entryPoints,
      state,
      verified: entries.filter(entry => entry.verified === true).length,
      cached: false,
    };
    cacheSeedResult(key, result);
    return { ...result, seeds: entries.slice(0, cap) };
  }

  /**
   * Search the public web through one credential-free endpoint.
   *
   * The provider host must already be allowlisted: discovery never widens what the
   * character may read. A blocked or unparseable provider reports `search-unavailable`
   * instead of inventing results; `seedPages()` stays the working alternative.
   */
  async function search({ query, limit } = {}) {
    const text = String(query ?? '').trim().slice(0, 200);
    if (!text) return { ok: false, code: 'source-invalid', reason: 'empty-query', results: [] };
    if (!rules.length) return { ok: false, code: 'source-allowlist-empty', reason: 'source-allowlist-empty', results: [] };
    if (provider === 'none') return { ok: false, code: 'search-unavailable', reason: 'provider-disabled', provider, results: [] };
    const hosts = allowedProviderHosts();
    if (!hosts.length) {
      return { ok: false, code: 'search-not-allowed', reason: 'provider-host-not-allowlisted', provider, providerHosts: [...providerHosts], results: [] };
    }
    const want = clampLimit(limit, DEFAULT_MAX_LINKS, MAX_SEARCH_RESULTS);
    const started = Number(now()) || Date.now();
    const failures = [];
    const results = [];
    for (const host of hosts) {
      const isWikipedia = provider.startsWith('wikipedia');
      const url = isWikipedia
        ? `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(text)}&srlimit=${want}&srprop=snippet&format=json&utf8=1`
        : `https://${host}/html/?q=${encodeURIComponent(text)}`;
      const fetched = await request(url, isWikipedia
        ? { accept: JSON_CONTENT, acceptHeader: 'application/json' }
        : { accept: HTML_CONTENT, acceptHeader: 'text/html' });
      if (!fetched.ok) { failures.push({ host, code: fetched.code, reason: fetched.reason ?? '', status: Number(fetched.status ?? 0) || 0 }); continue; }
      let parsed = [];
      if (isWikipedia) {
        try { parsed = parseWikipediaResults(JSON.parse(fetched.raw), host, want); } catch { failures.push({ host, code: 'search-unavailable', reason: 'provider-json-invalid', status: fetched.status }); }
      } else {
        parsed = parseDuckDuckGoResults(fetched.raw, want);
      }
      if (!parsed.length) { failures.push({ host, code: 'search-unavailable', reason: 'provider-no-results', status: fetched.status }); continue; }
      for (const item of parsed) {
        if (!hostAllowed(item.url, rules)) continue;
        results.push({ ...item, host: hostOf(item.url) });
        if (results.length >= want) break;
      }
      if (results.length >= want) break;
    }
    const elapsedMs = (Number(now()) || Date.now()) - started;
    const deduped = [];
    const seen = new Set();
    for (const item of results) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      deduped.push(item);
    }
    if (!deduped.length) {
      const state = { at: Number(now()) || Date.now(), provider, code: 'search-unavailable', results: 0, elapsedMs, failures };
      lastSearch = state;
      return {
        ok: false,
        code: 'search-unavailable',
        reason: failures[0]?.reason || 'provider-blocked',
        provider,
        failures,
        results: [],
        elapsedMs,
        alternative: seedList.length ? 'seed-pages' : '',
      };
    }
    lastSearch = { at: Number(now()) || Date.now(), provider, code: '', results: deduped.length, elapsedMs, failures };
    return { ok: true, provider, results: deduped, filtered: results.length - deduped.length, elapsedMs, missed: failures };
  }

  function describe() {
    const hosts = allowedProviderHosts();
    const allowlistEmpty = rules.length === 0;
    const configured = seedPages({ limit: MAX_LINKS_CAP });
    const lastCode = lastSearch?.code ?? '';
    const exploreReason = allowlistEmpty && !configured.pages.length ? 'source-allowlist-empty' : '';
    const searchReason = allowlistEmpty
      ? 'source-allowlist-empty'
      : provider === 'none'
        ? 'search-unavailable'
        : hosts.length === 0
          ? 'search-not-allowed'
          : lastCode === 'search-unavailable' ? 'search-unavailable' : '';
    return {
      port: 'public-web',
      allowedSources: [...rules],
      seedUrls: configured.pages.map(page => page.url),
      seedCount: seedList.length,
      seedsValid: configured.pages.length,
      searchProvider: provider,
      providerHosts: [...providerHosts],
      providerHostsAllowed: hosts,
      maxLinksPerPage: linkLimitCap,
      maxBytes: byteCap,
      explore: { available: !allowlistEmpty || configured.pages.length > 0, reason: exploreReason },
      // A provider that was probed and blocked is not "available" until it answers again.
      search: { available: hosts.length > 0 && provider !== 'none' && searchReason === '', reason: searchReason },
      lastSearch: lastSearch ? { at: lastSearch.at, provider: lastSearch.provider, results: lastSearch.results, ms: lastSearch.elapsedMs, code: lastSearch.code } : null,
    };
  }

  return { fetchPage, discoverLinks, search, seeds, seedPages, verifySeeds, describe, allowedProviderHosts };
}
