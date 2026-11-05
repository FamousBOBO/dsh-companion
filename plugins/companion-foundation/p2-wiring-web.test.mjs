import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  MAX_LINKS_CAP,
  createWebPort,
  guardUrl,
  hostAllowed,
  isPrivateHost,
} from './autonomy-web.mjs';
import { createAutonomyPorts } from './autonomy.mjs';

// Contract v1.2 section 4: the public web port must search, discover links and fetch pages
// under the allowlist policy, re-validating the host *before* every request and again after
// redirects. Every test here injects a fake fetch: the suite stays offline and deterministic;
// the one real-network smoke test lives in `p2-wiring-web-live.test.mjs` and is skipped (with
// the skip in its name) when the machine has no network.

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');

/** Minimal fetch Response double: status, headers.get, url and an async body. */
function response({ status = 200, url = '', contentType = 'text/html; charset=utf-8', body = '', headers = {} } = {}) {
  return {
    status,
    url,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'location') return headers.location ?? null;
        return headers[key] ?? null;
      },
    },
    body: (async function* stream() {
      if (body !== '') yield Buffer.from(body, 'utf8');
    })(),
  };
}

/** Route by URL; records every request so a test can prove what was (not) fetched. */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-web-'));
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const PAGE = '<html><head><title>桥 Bridge</title></head><body><script>var x=1</script><p>Hello &amp; welcome</p></body></html>';
const LINKS = `<html><body>
  <a href="/b">B</a>
  <a href="/b#frag">B again</a>
  <a href="https://example.com/c">C</a>
  <a href="https://evil.test/x">Evil</a>
  <a href="mailto:someone@example.com">Mail</a>
  <a href="javascript:void(0)">JS</a>
  <a href="http://127.0.0.1/secret">Local</a>
  <a href="#top">Top</a>
</body></html>`;

// ---------------------------------------------------------------------------
// allowlist and private-host policy
// ---------------------------------------------------------------------------

test('allowlist matching keeps the domain-suffix rule and the full-URL rule', () => {
  const allow = ['example.com', 'https://api.other.test/v1', 'wikipedia.org'];
  assert.equal(hostAllowed('https://example.com/a', allow), true);
  assert.equal(hostAllowed('https://sub.example.com/a', allow), true, 'a bare domain rule also matches its subdomains');
  assert.equal(hostAllowed('https://notexample.com/a', allow), false, 'suffix matching must not be a substring match');
  assert.equal(hostAllowed('https://api.other.test/x', allow), true);
  assert.equal(hostAllowed('https://cdn.other.test/x', allow), false, 'a full-URL rule matches that host only');
  assert.equal(hostAllowed('https://en.wikipedia.org/wiki/Bridge', allow), true);
  assert.equal(hostAllowed('ftp://example.com/a', allow), false);
  assert.equal(hostAllowed('not a url', allow), false);
  assert.equal(hostAllowed('https://example.com/a', []), false, 'an empty allowlist allows nothing');
});

test('private, loopback and link-local hosts are detected, public hosts are not', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', 'localhost', 'printer.local', '::1', '[::1]', 'fe80::1', 'fd00::1']) {
    assert.equal(isPrivateHost(host), true, `${host} must be treated as private`);
  }
  for (const host of ['en.wikipedia.org', '8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
    assert.equal(isPrivateHost(host), false, `${host} must stay public`);
  }
});

test('guardUrl refuses a private host that is not explicitly listed, and allows one that is', () => {
  const refused = guardUrl('http://127.0.0.1:8080/admin', ['example.com']);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'source-private-host');
  assert.equal(refused.reason, 'private-host-not-allowlisted');
  const allowed = guardUrl('http://127.0.0.1:8080/admin', ['127.0.0.1']);
  assert.equal(allowed.ok, true, 'an explicit allowlist entry is the only way to reach a private host');
  assert.equal(guardUrl('https://example.com/x', ['example.com']).ok, true);
  assert.equal(guardUrl('https://evil.test/x', ['example.com']).code, 'source-invalid');
  assert.equal(guardUrl('https://user:pass@example.com/x', ['example.com']).reason, 'credentials-in-url');
  assert.equal(guardUrl('file:///etc/passwd', ['example.com']).reason, 'unsupported-protocol');
  assert.equal(guardUrl('', []).reason, 'empty-url');
});

// ---------------------------------------------------------------------------
// fetchPage hardening
// ---------------------------------------------------------------------------

test('fetchPage reduces an allowed page to text and keeps the hash', async t => {
  tempRoot(t);
  const fetchImpl = fakeFetch(() => response({ url: 'https://example.com/page', body: PAGE }));
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl });
  const page = await web.fetchPage({ url: 'https://example.com/page' });
  assert.equal(page.ok, true);
  assert.equal(page.status, 200);
  assert.equal(page.title, '桥 Bridge');
  assert.equal(page.text, 'Hello & welcome', 'script bodies never reach the text');
  assert.equal(page.sha256, sha256(page.text));
  assert.equal(page.bytes, Buffer.byteLength(PAGE));
  assert.equal(fetchImpl.calls.length, 1);
});

test('fetchPage refuses a host outside the allowlist without any request', async () => {
  const fetchImpl = fakeFetch(() => response({ body: PAGE }));
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl });
  const page = await web.fetchPage({ url: 'https://evil.test/page' });
  assert.equal(page.ok, false);
  assert.equal(page.reason, 'host-not-allowed');
  assert.equal(fetchImpl.calls.length, 0, 'the refusal happens before the request');
});

test('a redirect to a forbidden host is refused before the second request', async () => {
  const fetchImpl = fakeFetch(url => {
    if (url === 'https://example.com/a') return response({ status: 302, url, headers: { location: 'http://evil.test/x' } });
    return response({ url, body: PAGE });
  });
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl });
  const page = await web.fetchPage({ url: 'https://example.com/a' });
  assert.equal(page.ok, false);
  assert.equal(page.reason, 'host-not-allowed');
  assert.deepEqual(fetchImpl.calls.map(call => call.url), ['https://example.com/a'], 'the forbidden hop is never requested');
});

test('a redirect to a private host is refused even when the origin host is allowed', async () => {
  const fetchImpl = fakeFetch(url => {
    if (url === 'https://example.com/a') return response({ status: 301, url, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    return response({ url, body: PAGE });
  });
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl });
  const page = await web.fetchPage({ url: 'https://example.com/a' });
  assert.equal(page.ok, false);
  assert.equal(page.code, 'source-private-host');
  assert.equal(fetchImpl.calls.length, 1);
});

test('an allowed redirect is followed and the final URL is reported', async t => {
  tempRoot(t);
  const fetchImpl = fakeFetch(url => {
    if (url === 'https://example.com/a') return response({ status: 302, url, headers: { location: '/b' } });
    return response({ url: 'https://example.com/b', body: PAGE });
  });
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl });
  const page = await web.fetchPage({ url: 'https://example.com/a' });
  assert.equal(page.ok, true);
  assert.equal(page.redirects, 1);
  assert.equal(page.finalUrl, 'https://example.com/b');
  assert.deepEqual(fetchImpl.calls.map(call => call.url), ['https://example.com/a', 'https://example.com/b']);
});

test('the final URL is re-validated after the last hop, not only before the first', async () => {
  // A proxy (or a compromised origin) answering with a different final URL must not be trusted.
  const fetchImpl = fakeFetch(() => response({ url: 'https://evil.test/lp', body: PAGE }));
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl });
  const page = await web.fetchPage({ url: 'https://example.com/page' });
  assert.equal(page.ok, false);
  assert.match(page.reason, /^redirect-left-allowlist:/);
});

test('redirect chains are bounded', async () => {
  const fetchImpl = fakeFetch(url => response({ status: 302, url, headers: { location: '/next' } }));
  const web = createWebPort({ allowedSources: ['example.com'], maxRedirects: 1, fetchImpl });
  const page = await web.fetchPage({ url: 'https://example.com/a' });
  assert.equal(page.ok, false);
  assert.equal(page.reason, 'too-many-redirects');
  assert.equal(fetchImpl.calls.length, 2, 'the first hop plus exactly one redirect');
});

test('maxRedirects 0 really allows no redirect at all', async () => {
  const fetchImpl = fakeFetch(url => response({ status: 302, url, headers: { location: '/next' } }));
  const web = createWebPort({ allowedSources: ['example.com'], maxRedirects: 0, fetchImpl });
  const page = await web.fetchPage({ url: 'https://example.com/a' });
  assert.equal(page.ok, false);
  assert.equal(page.reason, 'too-many-redirects');
  assert.equal(fetchImpl.calls.length, 1, 'the redirect is refused before the second request');
});

test('an oversized body is refused mid-stream', async () => {
  const big = 'x'.repeat(4096);
  const web = createWebPort({ allowedSources: ['example.com'], maxBytes: 512, fetchImpl: fakeFetch(() => response({ body: big })) });
  const page = await web.fetchPage({ url: 'https://example.com/big' });
  assert.equal(page.ok, false);
  assert.equal(page.reason, 'too-large');
});

test('a non-text content type is refused instead of being decoded', async () => {
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl: fakeFetch(() => response({ contentType: 'application/pdf', body: '%PDF-1.7' })) });
  const page = await web.fetchPage({ url: 'https://example.com/file.pdf' });
  assert.equal(page.ok, false);
  assert.equal(page.reason, 'unsupported-content-type');
});

test('a plain-text page keeps its text untouched and carries no title', async () => {
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl: fakeFetch(() => response({ contentType: 'text/plain', body: 'line one\nline two' })) });
  const page = await web.fetchPage({ url: 'https://example.com/notes.txt' });
  assert.equal(page.ok, true);
  assert.equal(page.text, 'line one\nline two');
  assert.equal(page.title, '');
});

// ---------------------------------------------------------------------------
// link discovery
// ---------------------------------------------------------------------------

test('discoverLinks returns absolute, deduped, same-host-or-allowlisted links only', async t => {
  tempRoot(t);
  const fetchImpl = fakeFetch(() => response({ url: 'https://example.com/page', body: LINKS }));
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl });
  const found = await web.discoverLinks({ url: 'https://example.com/page' });
  assert.equal(found.ok, true);
  assert.deepEqual(found.links.map(link => link.url), ['https://example.com/b', 'https://example.com/c']);
  assert.equal(found.found, 2);
  assert.equal(found.kept, 2);
  assert.equal(found.truncated, false, 'the fragment duplicate and the refused hosts never count');
});

test('discoverLinks is bounded by maxLinksPerPage and reports truncation', async () => {
  const body = Array.from({ length: 6 }, (_value, index) => `<a href="/p${index}">p${index}</a>`).join('');
  const web = createWebPort({ allowedSources: ['example.com'], maxLinksPerPage: 2, fetchImpl: fakeFetch(() => response({ url: 'https://example.com/page', body })) });
  const found = await web.discoverLinks({ url: 'https://example.com/page' });
  assert.equal(found.links.length, 2);
  assert.equal(found.found, 6);
  assert.equal(found.truncated, true);
  assert.equal(found.limit, 2);
});

test('discoverLinks caps an oversized limit request', async () => {
  const web = createWebPort({ allowedSources: ['example.com'], maxLinksPerPage: 500, fetchImpl: fakeFetch(() => response({ url: 'https://example.com/p', body: LINKS })) });
  assert.equal(web.describe().maxLinksPerPage, MAX_LINKS_CAP);
  const found = await web.discoverLinks({ url: 'https://example.com/p', limit: 9999 });
  assert.equal(found.limit, MAX_LINKS_CAP);
});

test('discoverLinks refuses a non-HTML page instead of guessing links', async () => {
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl: fakeFetch(() => response({ contentType: 'text/plain', body: 'no links here' })) });
  const found = await web.discoverLinks({ url: 'https://example.com/notes.txt' });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'unsupported-content-type');
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const WIKI_SEARCH_URL = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=bridge&srlimit=5&srprop=snippet&format=json&utf8=1';
const WIKI_JSON = JSON.stringify({
  query: { search: [
    { title: 'Bridge', snippet: 'A <span class="searchmatch">bridge</span> is a structure' },
    { title: 'Bridge (card game)', snippet: 'A card game' },
  ] },
});

test('search maps provider JSON to absolute article results', async () => {
  const fetchImpl = fakeFetch(url => (url === WIKI_SEARCH_URL ? response({ contentType: 'application/json', body: WIKI_JSON }) : response({ status: 404, body: '' })));
  const web = createWebPort({ allowedSources: ['en.wikipedia.org'], fetchImpl });
  const found = await web.search({ query: 'bridge', limit: 5 });
  assert.equal(found.ok, true);
  assert.equal(found.provider, 'wikipedia');
  assert.deepEqual(found.results.map(item => item.url), [
    'https://en.wikipedia.org/wiki/Bridge',
    'https://en.wikipedia.org/wiki/Bridge_(card_game)',
  ]);
  assert.equal(found.results[0].title, 'Bridge');
  assert.equal(found.results[0].snippet, 'A bridge is a structure', 'snippet HTML is stripped');
  assert.equal(found.results[0].host, 'en.wikipedia.org');
  assert.deepEqual(fetchImpl.calls.map(call => call.url), [WIKI_SEARCH_URL]);
  assert.equal(web.describe().search.available, true);
  assert.equal(web.describe().search.reason, '');
});

test('search only queries provider hosts that are explicitly allowlisted', async () => {
  const fetchImpl = fakeFetch(url => (url.startsWith('https://en.wikipedia.org/') ? response({ contentType: 'application/json', body: WIKI_JSON }) : response({ status: 500, body: '' })));
  const web = createWebPort({ allowedSources: ['example.com'], fetchImpl });
  const found = await web.search({ query: 'bridge', limit: 5 });
  assert.equal(found.ok, false);
  assert.equal(found.code, 'search-not-allowed');
  assert.equal(fetchImpl.calls.length, 0);
});

test('an empty allowlist reports source-allowlist-empty instead of searching', async () => {
  const fetchImpl = fakeFetch(() => response({ body: PAGE }));
  const web = createWebPort({ allowedSources: [], fetchImpl });
  const found = await web.search({ query: 'bridge' });
  assert.equal(found.ok, false);
  assert.equal(found.code, 'source-allowlist-empty');
  assert.equal(web.describe().explore.reason, 'source-allowlist-empty');
  assert.equal(web.describe().explore.available, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a blocked provider reports search-unavailable and points at the seed-page alternative', async () => {
  const fetchImpl = fakeFetch(() => response({ status: 503, contentType: 'text/html', body: 'blocked' }));
  const web = createWebPort({ allowedSources: ['en.wikipedia.org'], seedUrls: ['https://en.wikipedia.org/wiki/Bridge'], fetchImpl });
  const found = await web.search({ query: 'bridge', limit: 5 });
  assert.equal(found.ok, false);
  assert.equal(found.code, 'search-unavailable');
  assert.equal(found.alternative, 'seed-pages');
  assert.deepEqual(found.results, [], 'a blocked provider never invents results');
  assert.equal(web.describe().search.reason, 'search-unavailable');
  assert.equal(web.describe().search.available, false);
});

test('a provider answering with unparseable JSON is search-unavailable, not an exception', async () => {
  const web = createWebPort({ allowedSources: ['en.wikipedia.org'], fetchImpl: fakeFetch(() => response({ contentType: 'application/json', body: '{not json' })) });
  const found = await web.search({ query: 'bridge' });
  assert.equal(found.ok, false);
  assert.equal(found.code, 'search-unavailable');
  assert.equal(found.reason, 'provider-json-invalid');
});

test('the duckduckgo provider unwraps redirect wrappers and drops non-allowlisted results', async () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://en.wikipedia.org/wiki/Bridge')}">Bridge</a>
    <a class="result__snippet">A structure</a></div>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://evil.test/x')}">Evil</a>
    <a class="result__snippet">Nope</a></div>`;
  const fetchImpl = fakeFetch(url => (url.startsWith('https://html.duckduckgo.com/html/?q=') ? response({ body: html }) : response({ status: 404, body: '' })));
  const web = createWebPort({ allowedSources: ['en.wikipedia.org', 'html.duckduckgo.com'], searchProvider: 'duckduckgo-html', fetchImpl });
  const found = await web.search({ query: 'bridge', limit: 5 });
  assert.equal(found.ok, true);
  assert.deepEqual(found.results.map(item => item.url), ['https://en.wikipedia.org/wiki/Bridge']);
  assert.equal(found.results[0].title, 'Bridge');
});

test('searchProvider none disables discovery honestly', async () => {
  const fetchImpl = fakeFetch(() => response({ body: PAGE }));
  const web = createWebPort({ allowedSources: ['en.wikipedia.org'], searchProvider: 'none', fetchImpl });
  const found = await web.search({ query: 'bridge' });
  assert.equal(found.ok, false);
  assert.equal(found.code, 'search-unavailable');
  assert.equal(found.reason, 'provider-disabled');
  assert.equal(web.describe().search.available, false);
});

// ---------------------------------------------------------------------------
// verified seed pages
// ---------------------------------------------------------------------------

test('seed pages are validated against the allowlist before they are offered', async t => {
  tempRoot(t);
  const web = createWebPort({
    allowedSources: ['en.wikipedia.org'],
    seedUrls: ['https://en.wikipedia.org/wiki/Bridge', 'https://evil.test/x', { url: 'https://en.wikipedia.org/wiki/Quantum_computing', title: 'Quantum computing' }],
    fetchImpl: fakeFetch(() => response({ body: PAGE })),
  });
  const seeds = web.seedPages({ limit: 5 });
  assert.equal(seeds.total, 3);
  assert.equal(seeds.pages.length, 2);
  assert.deepEqual(seeds.pages.map(page => page.url), ['https://en.wikipedia.org/wiki/Bridge', 'https://en.wikipedia.org/wiki/Quantum_computing']);
  assert.equal(seeds.pages[1].title, 'Quantum computing');
  assert.deepEqual(seeds.skipped, [{ url: 'https://evil.test/x', reason: 'host-not-allowed' }]);
});

test('verifySeeds really fetches each allowed seed and reports status, bytes and hash', async t => {
  tempRoot(t);
  const web = createWebPort({ allowedSources: ['en.wikipedia.org'], seedUrls: ['https://en.wikipedia.org/wiki/Bridge'], fetchImpl: fakeFetch(() => response({ url: 'https://en.wikipedia.org/wiki/Bridge', body: PAGE })) });
  const verified = await web.verifySeeds();
  assert.equal(verified.ok, true);
  assert.equal(verified.seeds.length, 1);
  assert.equal(verified.seeds[0].status, 200);
  assert.equal(verified.seeds[0].title, '桥 Bridge');
  assert.equal(verified.seeds[0].sha256, sha256('Hello & welcome'));
});

test('an all-disallowed seed list reports seeds-not-allowed instead of an empty success', async () => {
  const web = createWebPort({ allowedSources: ['example.com'], seedUrls: ['https://evil.test/x'], fetchImpl: fakeFetch(() => response({ body: PAGE })) });
  const seeds = web.seedPages();
  assert.equal(seeds.ok, false);
  assert.equal(seeds.reason, 'seeds-not-allowed');
});

// ---------------------------------------------------------------------------
// concrete candidate sources for one topic
// ---------------------------------------------------------------------------

const TOPIC = '桥';
const TOPIC_SEARCH_URL = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(TOPIC)}&srlimit=3&srprop=snippet&format=json&utf8=1`;
const TOPIC_JSON = JSON.stringify({ query: { search: [
  { title: 'Bridge', snippet: 'A <span class="searchmatch">bridge</span> is a structure' },
  { title: 'Suspension bridge', snippet: 'A bridge with cables' },
] } });

function topicFetch() {
  return fakeFetch(url => {
    if (url === TOPIC_SEARCH_URL) return response({ contentType: 'application/json', body: TOPIC_JSON });
    if (url.startsWith('https://en.wikipedia.org/wiki/')) return response({ url, body: PAGE });
    return response({ status: 404, contentType: 'text/html', body: '' });
  });
}

test('seeds returns verified urls: allowlisted seeds first, then one live search', async () => {
  const fetchImpl = topicFetch();
  const web = createWebPort({
    allowedSources: ['en.wikipedia.org'],
    seedUrls: ['https://en.wikipedia.org/wiki/Bridge'],
    fetchImpl,
    now: () => Date.UTC(2026, 9, 30, 3, 0, 0),
  });
  const found = await web.seeds({ topic: TOPIC, limit: 3, budget: { remaining: 2 } });
  assert.equal(found.ok, true);
  assert.equal(found.state, 'ok');
  assert.deepEqual(found.seeds.map(seed => seed.source), ['seed', 'search'], 'the seed page wins over the identical search hit');
  assert.equal(found.seeds[0].url, 'https://en.wikipedia.org/wiki/Bridge');
  assert.equal(found.seeds[0].verified, true, 'the seed page was really fetched');
  assert.equal(found.seeds[0].sha256, sha256('Hello & welcome'), 'and hashed');
  assert.equal(found.seeds[1].url, 'https://en.wikipedia.org/wiki/Suspension_bridge');
  assert.equal(found.seeds[1].verified, true, 'the first new search hit is verified by a real fetch');
  assert.equal(found.verified, 2);
  assert.deepEqual(found.entryPoints.allowedSources, ['en.wikipedia.org']);
  assert.deepEqual(found.entryPoints.seedUrls, ['https://en.wikipedia.org/wiki/Bridge']);
  assert.equal(fetchImpl.calls.filter(call => call.url === TOPIC_SEARCH_URL).length, 1, 'exactly one live search');
});

test('seeds keeps unverified hits with their url but says why they are unverified', async () => {
  const fetchImpl = fakeFetch(url => {
    if (url === TOPIC_SEARCH_URL) return response({ contentType: 'application/json', body: TOPIC_JSON });
    return response({ status: 500, contentType: 'text/html', body: '' });
  });
  const web = createWebPort({ allowedSources: ['en.wikipedia.org'], fetchImpl, now: () => Date.UTC(2026, 9, 30, 4, 0, 0), dayKey: () => '2026-10-31' });
  const found = await web.seeds({ topic: TOPIC, limit: 3, budget: { remaining: 1 } });
  assert.equal(found.ok, true);
  assert.equal(found.seeds[0].verified, false);
  assert.equal(found.seeds[0].reason, 'http-500');
  assert.equal(found.verified, 0);
});

test('seeds refuses when the allowlist is empty', async () => {
  const fetchImpl = fakeFetch(() => response({ body: PAGE }));
  const web = createWebPort({ allowedSources: [], fetchImpl });
  const found = await web.seeds({ topic: TOPIC, budget: { remaining: 5 } });
  assert.equal(found.ok, false);
  assert.equal(found.code, 'source-allowlist-empty');
  assert.deepEqual(found.seeds, []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('seeds refuses to spend when the shared budget has no request left', async () => {
  const fetchImpl = topicFetch();
  const web = createWebPort({
    allowedSources: ['en.wikipedia.org'],
    seedUrls: ['https://en.wikipedia.org/wiki/Bridge'],
    fetchImpl,
    now: () => Date.UTC(2026, 9, 30, 3, 0, 0),
  });
  const found = await web.seeds({ topic: TOPIC, limit: 3, budget: { remaining: 0 } });
  assert.equal(found.ok, false);
  assert.equal(found.code, 'budget-exhausted');
  assert.equal(found.budget, 'exhausted');
  assert.deepEqual(found.seeds, []);
  assert.equal(fetchImpl.calls.length, 0, 'nothing is fetched on an exhausted day');

  // A gate that is present but unreadable must not be treated as unlimited either.
  const blind = await web.seeds({ topic: TOPIC, budget: { ok: false, code: 'budget-unknown' } });
  assert.equal(blind.code, 'budget-exhausted');
  assert.equal(fetchImpl.calls.length, 0);
});

test('seeds caches per topic and day so the planning digest cannot drift', async () => {
  const fetchImpl = topicFetch();
  const web = createWebPort({
    allowedSources: ['en.wikipedia.org'],
    seedUrls: ['https://en.wikipedia.org/wiki/Bridge'],
    fetchImpl,
    now: () => Date.UTC(2026, 9, 30, 3, 0, 0),
  });
  const first = await web.seeds({ topic: TOPIC, limit: 3, budget: { remaining: 2 } });
  const callsAfterFirst = fetchImpl.calls.length;
  const second = await web.seeds({ topic: TOPIC, limit: 3, budget: { remaining: 1 } });
  assert.equal(second.cached, true);
  assert.equal(fetchImpl.calls.length, callsAfterFirst, 'the second read costs no request');
  assert.deepEqual(second.seeds, first.seeds, 'the material is byte-identical for the day');
  const otherTopic = await web.seeds({ topic: '量子', limit: 3, budget: { remaining: 1 } });
  assert.equal(otherTopic.cached, false, 'a different topic is its own entry');
});

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

test('createAutonomyPorts mounts search, discoverLinks and fetchPage beside the local ports', async t => {
  const root = tempRoot(t);
  const fetchImpl = fakeFetch(url => (url === WIKI_SEARCH_URL ? response({ contentType: 'application/json', body: WIKI_JSON }) : response({ url, body: PAGE })));
  const ports = createAutonomyPorts({
    root,
    ctx: {},
    options: {
      allowedSources: ['en.wikipedia.org'],
      seedUrls: ['https://en.wikipedia.org/wiki/Bridge'],
      searchProvider: 'wikipedia',
      maxLinksPerPage: 4,
      engine: null,
      fetchImpl,
    },
  });
  assert.equal(typeof ports.ports.fetchPage, 'function');
  assert.equal(typeof ports.ports.search, 'function');
  assert.equal(typeof ports.ports.discoverLinks, 'function');
  assert.equal(typeof ports.ports.readFile, 'function');
  assert.equal(typeof ports.ports.writeFile, 'function');
  assert.equal(ports.memoryPort, null, 'no engine and no outbox means no memory port');
  const described = ports.describe();
  assert.equal(described.web.searchProvider, 'wikipedia');
  assert.equal(described.web.maxLinksPerPage, 4);
  assert.equal(described.web.seedCount, 1);
  assert.equal(described.web.explore.available, true);
  const searched = await ports.ports.search({ query: 'bridge', limit: 5 });
  assert.equal(searched.ok, true);
  assert.equal(searched.results.length, 2);
});

test('the memory port is mounted when only an outbox is wired', async t => {
  const root = tempRoot(t);
  const ports = createAutonomyPorts({
    root,
    ctx: {},
    options: { allowedSources: [], engine: null, outbox: { enqueue: async () => ({ ok: true, outboxId: 'out_1', queued: true }) } },
  });
  assert.notEqual(ports.memoryPort, null);
  assert.equal(ports.memoryPort.describe().engine, 'absent');
  assert.equal(ports.memoryPort.describe().outbox, 'wired');
});
