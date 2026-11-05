import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWebPort } from './autonomy-web.mjs';

// Real-network smoke for the public web port (contract v1.2 section 4).
//
// The skip is in the test *name* on purpose: when this machine has no network the result
// must be readable as "not verified", never as "passed". The offline suite
// `p2-wiring-web.test.mjs` covers every behaviour deterministically.
//
// Observed on this machine (2026-10-30, D:\Bot\dsh-companion):
//   Wikipedia query API  HTTP 200 ~1.34 s
//   Wikipedia opensearch HTTP 200 ~1.46 s
//   DuckDuckGo HTML      HTTP 200 ~2.72 s (redirect-wrapped hrefs)
// so `wikipedia` is the default provider and `duckduckgo-html` stays an option.

const LIVE_TIMEOUT_MS = 20000;
// A real Wikipedia article is ~1.6 MB of HTML; the production cap is 200 KB on purpose
// (the explore adapter has its own excerpt cap), so the live smoke raises the cap instead
// of pretending the page is small.
const LIVE_MAX_BYTES = 3_000_000;

test('LIVE-NETWORK (skipped, never silently passed, when the network is unavailable): real Wikipedia search, fetch and link discovery', async t => {
  const web = createWebPort({
    allowedSources: ['en.wikipedia.org', 'zh.wikipedia.org'],
    searchProvider: 'wikipedia',
    maxLinksPerPage: 8,
    maxBytes: LIVE_MAX_BYTES,
    timeoutMs: LIVE_TIMEOUT_MS,
  });

  const searchStarted = Date.now();
  const found = await web.search({ query: 'suspension bridge', limit: 3 });
  const searchMs = Date.now() - searchStarted;
  if (!found.ok) {
    if (found.code === 'source-fetch-failed') {
      t.skip(`network unavailable: search returned ${found.code}/${found.reason} after ${searchMs} ms`);
      return;
    }
    // Any other refusal is a port defect, not a network problem: it must fail, not skip.
    assert.fail(`search refused a real allowlisted provider: ${found.code}/${found.reason}`);
  }
  assert.ok(found.results.length >= 1, 'the provider is expected to return at least one hit');
  const first = found.results[0];
  assert.match(first.url, /^https:\/\/[a-z]{2}\.wikipedia\.org\/wiki\//);
  assert.ok(first.title.length > 0);
  t.diagnostic(`search: ${found.results.length} hits in ${searchMs} ms via ${found.provider}; first=${first.url}`);

  const fetchStarted = Date.now();
  const page = await web.fetchPage({ url: first.url });
  const fetchMs = Date.now() - fetchStarted;
  if (!page.ok) {
    if (page.code === 'source-fetch-failed') {
      t.skip(`network unavailable between search and fetch: ${page.code}/${page.reason} after ${fetchMs} ms`);
      return;
    }
    assert.fail(`fetch refused a real allowlisted page: ${page.code}/${page.reason}`);
  }
  assert.equal(page.status, 200);
  assert.match(page.finalUrl, /^https:\/\/[a-z]{2}\.wikipedia\.org\/wiki\//);
  assert.ok(page.text.length > 500, 'a real article has real text');
  assert.doesNotMatch(page.text.slice(0, 200), /<(html|head|script)/i, 'HTML was reduced to text');
  assert.match(page.sha256, /^[0-9a-f]{64}$/);
  assert.equal(page.redirects, 0);
  t.diagnostic(`fetch: ${page.bytes} bytes, ${page.text.length} chars, ${fetchMs} ms, sha256=${page.sha256.slice(0, 16)}…`);

  const links = await web.discoverLinks({ url: first.url, limit: 5 });
  assert.equal(links.ok, true);
  assert.ok(links.links.length >= 1, 'an article page carries links');
  assert.ok(links.links.length <= 5, 'discovery is bounded');
  assert.equal(new Set(links.links.map(link => link.url)).size, links.links.length, 'links are deduped');
  for (const link of links.links) assert.match(link.url, /^https:\/\/[a-z]{2}\.wikipedia\.org\//);
  t.diagnostic(`links: kept ${links.kept}/${links.found} (truncated=${links.truncated})`);
});

test('LIVE-NETWORK (offline-safe, no request is made): a private host stays refused before any socket is opened', async t => {
  const web = createWebPort({ allowedSources: ['en.wikipedia.org'], timeoutMs: LIVE_TIMEOUT_MS });
  const refused = await web.fetchPage({ url: 'http://127.0.0.1:1/never' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'source-private-host', 'the guard runs before the socket, so this holds online and offline');
});
