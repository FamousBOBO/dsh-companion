// Same service as DSH web_search/web_fetch; no duplicated provider or credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { guardUrl } from './autonomy-web.mjs';
import { extractPlainText } from '../companion-runtime/lib/activity-adapters.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const cap = (n, fallback, maximum) => Math.max(1, Math.min(maximum, Number(n) || fallback));

export function createHostWebPort({ ctx, root, allowedSources = [], seedUrls = [], topics = [],
  maxBytes = 1000000, timeoutMs = 30000, maxSearchesPerDay = 6, now = Date.now } = {}) {
  const file = path.join(root, 'home/companion/reading-web-cache.json');
  let cache, loading;
  let pending = Promise.resolve();
  const flights = new Map();
  const service = () => { try { return ctx?.get?.('web') ?? null; } catch { return null; } };
  // round-3 A1: `noAnswer` separates "we could not ask" (unknown, no retry) from "the server
  // answered no" (failed, retry allowed).
  const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, results: [], ...extra });
  async function nativeSearch(web, request, signal) {
    try { return await web.search(request, signal); }
    catch (error) {
      if (error.code !== 'WEB_PROVIDER_CREDENTIAL_MISSING') throw error;
      // The native provider only discovers account auth inside an Account-model turn.
      // A background job has no initiator. Reuse its exact implementation/settings,
      // resolving the already signed-in account through the Host's trusted-endpoint gate.
      const account = ctx?.get?.('deepseekAccount');
      const provider = web.searchProviders?.get?.('deepseek-official');
      if (!account?.resolveToken || typeof provider?.resolveOptions !== 'function') throw error;
      const options = provider.resolveOptions();
      const background = new provider.constructor(() => ({ ...options,
        resolveAccountToken: endpoint => account.resolveToken(endpoint) }));
      return await background.search(request, signal);
    }
  }
  const day = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  async function load() {
    loading ??= (async () => {
      try { const value = JSON.parse(await fs.readFile(file, 'utf8')); if (value.version === 1) cache = value; } catch { /* new cache */ }
      cache ??= { version: 1, searches: {}, pages: {} };
      cache.searches ??= {}; cache.pages ??= {};
    })();
    await loading;
  }
  async function save() {
    pending = pending.catch(() => {}).then(async () => {
      for (const [key, limit] of [['searches', 96], ['pages', 24]]) {
        cache[key] = Object.fromEntries(Object.entries(cache[key]).sort((a,b) => b[1].at-a[1].at).slice(0, limit));
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(cache), 'utf8');
      await fs.rename(temporary, file);
    });
    await pending;
  }
  async function fetchPage({ url, scopeKey = '' } = {}) {
    const guard = guardUrl(url, allowedSources);
    if (!guard.ok) return guard;
    await load();
    const key = hash(`${scopeKey}\n${guard.url}`);
    if (cache.pages[key] && Number(now()) - cache.pages[key].at < 86400000) return { ...cache.pages[key].value };
    if (flights.has(key)) return flights.get(key);
    const work = (async () => {
      const web = service();
      // round-3 A1: no transport = no answer (never a definite failure).
      if (!web?.fetch) return fail('host-fetch-unavailable', 'DSH Fetch not mounted', { noAnswer: true });
      try {
        const result = await web.fetch({ url: guard.url }, AbortSignal.timeout(timeoutMs));
        const final = guardUrl(result?.url || guard.url, allowedSources);
        if (!final.ok) return final;
        const status = Number(result?.statusCode || 0);
        if (status < 200 || status >= 300) return fail('source-fetch-failed', `http-${status}`, { status });
        if (result.truncated) return fail('source-truncated', 'DSH Fetch returned a partial body');
        if (!['html','text'].includes(result?.body?.kind)) return fail('source-invalid', 'unsupported-body-kind');
        const raw = String(result.body.content ?? '');
        if (Buffer.byteLength(raw) > maxBytes) return fail('source-too-large', 'maxSourceBytes');
        const extracted = extractPlainText({ text: raw, contentType: result.body.kind === 'html' ? 'text/html' : 'text/plain' });
        if (!extracted.text.trim()) return fail('source-empty', 'no readable text');
        const value = { ok: true, status, finalUrl: final.url, title: extracted.title || new URL(final.url).hostname,
          text: extracted.text, contentType: 'text/plain', bytes: Buffer.byteLength(extracted.text), sha256: hash(extracted.text), provider: 'dsh-web', truncated: false };
        cache.pages[key] = { at: Number(now()), value };
        await save();
        return value;
      } catch (error) {
        // Same rule: a thrown transport error is the absence of an answer. An HTTP status above is a
        // real answer (the server spoke), so that path stays a definite failure.
        return fail(error.code || 'host-fetch-failed', String(error.message || error).slice(0,180), { noAnswer: true });
      }
    })();
    flights.set(key, work);
    try { return await work; } finally { flights.delete(key); }
  }
  async function search({ query, limit = 6, scopeKey = '', at = now() } = {}) {
    const text = String(query ?? '').trim().slice(0,200);
    if (!text) return fail('source-invalid','empty-query');
    await load();
    const stamp = day(at), key = hash(`account-background-v1\n${scopeKey}\n${stamp}\n${text}`);
    if (flights.has(key)) return flights.get(key);
    if (cache.searches[key]) return cache.searches[key].value;
    const work = (async () => {
      const web = service();
      if (!web?.search) return fail('host-search-unavailable','DSH Search not mounted');
      const used = Object.values(cache.searches).filter(row => row.day === stamp && row.scopeKey === scopeKey).length;
      if (used >= maxSearchesPerDay) return fail('search-daily-limit','background search budget');
      // Failed calls and interrupted calls count too, including across host restarts.
      const row = { at: Number(at), day: stamp, scopeKey, value: fail('search-pending','search not completed') };
      cache.searches[key] = row;
      await save();
      try {
        const result = await nativeSearch(web, { query: text, maxResults: cap(limit,6,12) }, AbortSignal.timeout(Math.max(timeoutMs,60000)));
        const seen = new Set();
        const results = (Array.isArray(result?.sources) ? result.sources : []).filter(item => {
          const valid = guardUrl(item?.url,allowedSources);
          if (!valid.ok || seen.has(valid.url)) return false;
          seen.add(valid.url); return true;
        }).slice(0,cap(limit,6,12)).map(item => ({ url: new URL(item.url).href, title: String(item.title ?? '').slice(0,160),
          snippet: String(item.snippet ?? '').slice(0,240), source: 'dsh-search' }));
        row.value = { ok: true, provider: 'dsh-web', query: text, results };
      } catch (error) { row.value = fail(error.code || 'host-search-failed',String(error.message || error).slice(0,180)); }
      await save();
      return row.value;
    })();
    flights.set(key,work);
    try { return await work; } finally { flights.delete(key); }
  }
  async function seeds({ topic = '', scopeKey = '', limit = 6, verify = 2, budget, at = now(), excludeUrls = [] } = {}) {
    if (budget && (budget.ok === false || Number(budget.remaining) <= 0)) return { ...fail('budget-blocked','planning budget'), seeds: [] };
    const fallback = topics.length ? topics[parseInt(hash(day(at)).slice(0,6),16)%topics.length] : '';
    const query = String(topic || fallback).trim();
    const found = query ? await search({ query,scopeKey,limit,at }) : fail('no-interest','no search topic');
    const seen = new Set(excludeUrls), seeds = [];
    for (const item of [...(found.results || []), ...seedUrls.map(url => ({ url,title:'',source:'configured-source' }))]) {
      if (seeds.length >= cap(limit,6,12)) break;
      if (seen.has(item.url) || !guardUrl(item.url,allowedSources).ok) continue;
      seen.add(item.url); seeds.push({ ...item,verified:false });
    }
    for (const item of seeds.slice(0,Math.max(0,Number(verify)||0))) {
      const page = await fetchPage({ url:item.url,scopeKey });
      item.verified = page.ok === true;
      if (page.ok) { item.title = page.title || item.title; item.readableChars = page.text.length; }
      else item.reason = page.code;
    }
    const eligible = seeds.filter(item => !item.reason);
    return { ok:eligible.length>0,code:eligible.length?'':found.code||'no-sources',topic:query,seeds:eligible };
  }
  function describe() {
    const web = service();
    return { port:'dsh-web',allowedSources:[...allowedSources],seedUrls:[...seedUrls],searchProvider:'dsh',
      explore:{ available:typeof web?.fetch==='function',reason:web?.fetch?'':'host-fetch-unavailable' },
      search:{ available:typeof web?.search==='function',reason:web?.search?'':'host-search-unavailable' } };
  }
  return { fetchPage,search,seeds,describe,discoverLinks:async()=>fail('not-supported','use DSH Search') };
}
