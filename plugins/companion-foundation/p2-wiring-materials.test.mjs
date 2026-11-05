import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createWebPort } from './autonomy-web.mjs';
import { createMaterialsPort } from './autonomy-materials.mjs';
import { createAutonomyPorts } from './autonomy.mjs';

// Contract v1.2 §3 (planning material + foreground priority), fixing the external-run gap
// where the planner received an empty object: no persona, no public entry point, and an
// unexecutable `read` slot without `targetRef`.
//
// Every test uses a throwaway companion root and a fake fetch; the host `agents` service is
// faked, never the real one.

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const T0 = Date.UTC(2026, 9, 30, 3, 0, 0);
const SCOPE = 'u:10001|p:bot|w:world:default';

const PERSONA_MD = `# bot

## 性格
喜欢拍照，好奇心重，说话轻快。
遇到不懂的事会直接问。

## 习惯
晚上喜欢翻书，也会整理白天的照片。
`;

const PAGE = '<html><head><title>Bridge</title></head><body><p>一座桥的故事。</p></body></html>';
const TOPIC = '桥';
const TOPIC_SEARCH_URL = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(TOPIC)}&srlimit=3&srprop=snippet&format=json&utf8=1`;
const TOPIC_JSON = JSON.stringify({ query: { search: [{ title: 'Bridge', snippet: '桥的结构' }] } });

function response({ status = 200, url = '', contentType = 'text/html; charset=utf-8', body = '' } = {}) {
  return {
    status,
    url,
    headers: { get: name => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    body: (async function* stream() { if (body) yield Buffer.from(body, 'utf8'); })(),
  };
}

function fakeFetch() {
  const calls = [];
  const impl = async url => {
    calls.push(String(url));
    if (String(url) === TOPIC_SEARCH_URL) return response({ contentType: 'application/json', body: TOPIC_JSON });
    if (String(url).startsWith('https://en.wikipedia.org/wiki/')) return response({ url: String(url), body: PAGE });
    return response({ status: 404, body: '' });
  };
  impl.calls = calls;
  return impl;
}

function makeRoot(t, { persona = PERSONA_MD, identity = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-materials-'));
  for (const dir of ['workspace', 'home/companion']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  if (persona !== null) fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), persona, 'utf8');
  if (identity) {
    fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
      schemaVersion: 1, persona: 'bot',
      owner: { id: '10001', displayName: '测试', platform: 'qq' },
      desktop: { mode: 'local-owner', userId: '10001' },
      sessions: {},
    }, null, 2), 'utf8');
  }
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

function makeWeb(fetchImpl, { seedUrls = ['https://en.wikipedia.org/wiki/Bridge'] } = {}) {
  return createWebPort({
    allowedSources: ['en.wikipedia.org'],
    seedUrls,
    fetchImpl,
    now: () => T0,
    dayKey: () => '2026-10-30',
  });
}

/** The runtime's own DB-derived slice, as `p2Materials` produces it today. */
function runtimeSlice(overrides = {}) {
  return {
    timeZone: 'Asia/Shanghai',
    now: T0,
    day: '2026-10-30',
    fixedAgenda: [{ startAt: T0 - 3600000, endAt: T0, title: '和他说好的一小时', authorization: 'plan' }],
    runningActivities: [{ kind: 'read', target: '书', consumed_prefix: 1200, total_units: 3000, status: 'running' }],
    lastReceipts: [{ operation: 'step', ok: 1, code: '' }],
    interests: [{ kind: 'project', title: TOPIC, note: '一直在想桥' }],
    opportunities: [],
    recentPlans: [{ day: '2026-10-29', version: 1, status: 'committed', summary: '读了两页' }],
    capabilities: { read: { available: true, reason: '' }, explore: { available: true, reason: '' }, write: { available: true, reason: '' }, bilibili: { available: true } },
    budget: { requests: { limit: 64, used: 3, remaining: 61 } },
    persona: null,
    continuity: null,
    preferences: [],
    plan: { planId: 'plan_1', day: '2026-10-30', version: 2, summary: '安静的一天' },
    lockedSlots: [{ slotId: 'slot_9', startAt: T0 + 60000, endAt: T0 + 660000, title: '锁住的一段' }],
    ...overrides,
  };
}

function makeMaterials(root, { fetchImpl = fakeFetch(), continuity = null } = {}) {
  return createMaterialsPort({
    root,
    web: makeWeb(fetchImpl),
    options: {
      readRoots: ['workspace'],
      artifactRoot: 'workspace/companion-works',
      timeZone: 'Asia/Shanghai',
      continuity,
      now: () => T0,
    },
  });
}

// ---------------------------------------------------------------------------
// persona
// ---------------------------------------------------------------------------

test('materials carry the real persona text, never an empty placeholder', async t => {
  const root = makeRoot(t);
  const port = makeMaterials(root);
  const material = await port.materials({ scopeKey: SCOPE, day: '2026-10-30', now: T0, runtime: runtimeSlice() });
  assert.equal(material.personaSource, 'workspace/PERSONA.md');
  assert.match(material.persona.excerpt, /喜欢拍照/, 'the summary is the character file, not a guess');
  assert.doesNotMatch(material.persona.excerpt, /^#/m, 'markdown headings are stripped');
  assert.equal(material.persona.version, sha256(PERSONA_MD).slice(0, 8), 'the version tracks the file content');
  assert.equal(material.persona.personaId, 'bot');
  assert.equal(material.missing.includes('persona'), false);
});

test('a missing persona file is labelled missing instead of silently empty', async t => {
  const root = makeRoot(t, { persona: null });
  const port = makeMaterials(root);
  const material = await port.materials({ scopeKey: SCOPE, day: '2026-10-30', now: T0, runtime: runtimeSlice() });
  assert.equal(material.persona, null);
  assert.equal(material.personaSource, 'missing');
  assert.ok(material.missing.includes('persona'));
  assert.equal(port.describe().persona.source, 'missing');
});

// ---------------------------------------------------------------------------
// capabilities and public entry points
// ---------------------------------------------------------------------------

test('materials name the real capabilities and at least one concrete public entry point', async t => {
  const root = makeRoot(t);
  const fetchImpl = fakeFetch();
  const port = makeMaterials(root, { fetchImpl });
  const material = await port.materials({ scopeKey: SCOPE, day: '2026-10-30', now: T0, runtime: runtimeSlice() });

  const byName = Object.fromEntries(material.capabilities.map(item => [item.name, item]));
  assert.equal(byName.read.available, true, 'read roots are configured');
  assert.equal(byName.explore.available, true, 'the allowlist is non-empty');
  assert.equal(byName.search.available, true, 'the provider host is allowlisted');
  assert.equal(byName.write.available, true);
  assert.equal(byName.bilibili.available, true, 'a mounted Bilibili provider survives the materials projection');
  assert.equal(byName.image.available, false);

  assert.equal(material.publicEntry.state, 'ok');
  assert.deepEqual(material.publicEntry.allowedSources, ['en.wikipedia.org']);
  assert.ok(material.publicEntry.seeds.length >= 1, 'the planner gets a real URL it can copy');
  assert.equal(material.publicEntry.seeds[0].verified, true);
  assert.match(material.publicEntry.seeds[0].url, /^https:\/\/en\.wikipedia\.org\/wiki\//);
  // The existing planner prompt renders `opportunities`, so the same URL must appear there.
  const firstOpportunity = material.opportunities[0];
  assert.equal(firstOpportunity.kind, 'public-source');
  assert.match(firstOpportunity.source, /^https:\/\/en\.wikipedia\.org\/wiki\//, 'the model can put this straight into targetRef');
  assert.equal(material.sources.publicEntry, 'config.p2.autonomy+live-search');
});

test('an exhausted budget stops the live search instead of spending it', async t => {
  const root = makeRoot(t);
  const fetchImpl = fakeFetch();
  const port = makeMaterials(root, { fetchImpl });
  const material = await port.materials({
    scopeKey: SCOPE, day: '2026-10-30', now: T0,
    runtime: runtimeSlice({ budget: { requests: { limit: 64, used: 64, remaining: 0 } } }),
  });
  assert.equal(material.publicEntry.state, 'budget-exhausted');
  assert.deepEqual(material.publicEntry.seeds, []);
  assert.equal(fetchImpl.calls.length, 0, 'not one request was made');
  assert.equal(material.budget.requests.remaining, 0, 'the model is told the day is out of budget');
});

test('two material reads in one run stay byte-identical and cost one search', async t => {
  const root = makeRoot(t);
  const fetchImpl = fakeFetch();
  const port = makeMaterials(root, { fetchImpl });
  const first = await port.materials({ scopeKey: SCOPE, day: '2026-10-30', now: T0, runtime: runtimeSlice() });
  const callsAfterFirst = fetchImpl.calls.length;
  const second = await port.materials({ scopeKey: SCOPE, day: '2026-10-30', now: T0, runtime: runtimeSlice() });
  assert.equal(fetchImpl.calls.length, callsAfterFirst, 'the second read is served from the day cache');
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'pre/post-model material digests cannot drift');
});

// ---------------------------------------------------------------------------
// runtime slice passthrough and labelling
// ---------------------------------------------------------------------------

test('the runtime slice is passed through and labelled runtime', async t => {
  const root = makeRoot(t);
  const port = makeMaterials(root);
  const runtime = runtimeSlice();
  const material = await port.materials({ scopeKey: SCOPE, day: '2026-10-30', now: T0, runtime });
  assert.deepEqual(material.fixedAgenda, runtime.fixedAgenda);
  assert.deepEqual(material.plan, runtime.plan);
  assert.deepEqual(material.lockedSlots, runtime.lockedSlots);
  assert.deepEqual(material.runningActivities, runtime.runningActivities);
  assert.deepEqual(material.interests, runtime.interests);
  assert.deepEqual(material.budget, runtime.budget);
  for (const key of ['fixedAgenda', 'plan', 'lockedSlots', 'runningActivities', 'interests', 'recentPlans', 'budget']) {
    assert.equal(material.sources[key], 'runtime', `${key} must be labelled runtime`);
    assert.equal(material.missing.includes(key), false, `${key} is not missing`);
  }
});

test('without the runtime slice every database section is labelled missing', async t => {
  const root = makeRoot(t);
  const port = makeMaterials(root);
  const material = await port.materials({ scopeKey: SCOPE, day: '2026-10-30', now: T0 });
  for (const key of ['fixedAgenda', 'plan', 'lockedSlots', 'runningActivities', 'interests', 'recentPlans', 'budget']) {
    assert.equal(material.sources[key], 'missing', `${key} must say missing, not pretend the day is free`);
    assert.ok(material.missing.includes(key));
  }
  assert.equal(material.personaSource, 'workspace/PERSONA.md', 'the plugin half is still real');
  assert.equal(material.publicEntry.state, 'ok');
});

test('goals and commitments come from the P1 continuity provider', async t => {
  const root = makeRoot(t);
  const seen = [];
  const port = makeMaterials(root, {
    continuity: ({ scopeKey, scope }) => {
      seen.push({ scopeKey, scope });
      return { goals: [{ title: '修屋顶', deadlineAt: T0 + 86400000 }], commitments: [{ body: '周五前回复他', dueAt: T0 + 172800000 }] };
    },
  });
  const material = await port.materials({ scopeKey: SCOPE, day: '2026-10-30', now: T0, runtime: runtimeSlice() });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].scope.userId, '10001');
  assert.deepEqual(material.goals, [{ title: '修屋顶', deadlineAt: T0 + 86400000 }]);
  assert.deepEqual(material.commitments, [{ body: '周五前回复他', dueAt: T0 + 172800000 }]);
  assert.equal(material.sources.goals, 'p1-runtime');
  assert.equal(material.sources.commitments, 'p1-runtime');
});

// ---------------------------------------------------------------------------
// foreground priority
// ---------------------------------------------------------------------------

function mountPorts(t, { agents } = {}) {
  const root = makeRoot(t);
  return createAutonomyPorts({
    root,
    ctx: { get: name => (name === 'agents' ? agents : undefined) },
    options: { allowedSources: ['en.wikipedia.org'], seedUrls: ['https://en.wikipedia.org/wiki/Bridge'], fetchImpl: fakeFetch(), now: () => T0 },
  });
}

test('isForegroundBusy is true while a session is running', async t => {
  const ports = mountPorts(t, { agents: { list: () => [{ status: 'running' }, { status: 'idle' }] } });
  assert.equal(ports.isForegroundBusy(), true);
  assert.equal(ports.ports.isForegroundBusy(), true, 'also reachable through the ports bag');
});

test('isForegroundBusy is false only when the host lists live idle agents', async t => {
  const ports = mountPorts(t, { agents: { list: () => [{ status: 'idle' }, { status: 'idle', session: { status: 'idle' } }] } });
  assert.equal(ports.isForegroundBusy(), false);
});

test('isForegroundBusy fails closed when the agents service is absent, broken or unenumerable', async t => {
  assert.equal(mountPorts(t, {}).isForegroundBusy(), true, 'no service mount');
  assert.equal(mountPorts(t, { agents: {} }).isForegroundBusy(), true, 'service without list()');
  assert.equal(mountPorts(t, { agents: { list: () => { throw new Error('boom'); } } }).isForegroundBusy(), true, 'list() throws');
  assert.equal(mountPorts(t, { agents: { list: () => ({ nope: true }) } }).isForegroundBusy(), true, 'list() is not an array');
  assert.equal(mountPorts(t, { agents: { list: () => [{ session: { status: 'running' } }] } }).isForegroundBusy(), true, 'a running session counts too');
});

// ---------------------------------------------------------------------------
// port surface
// ---------------------------------------------------------------------------

test('createAutonomyPorts exposes materials, persona, continuity and the foreground hook', async t => {
  const ports = mountPorts(t, { agents: { list: () => [] } });
  assert.equal(typeof ports.materials, 'function');
  assert.equal(typeof ports.persona, 'function');
  assert.equal(typeof ports.continuity, 'function');
  assert.equal(typeof ports.preferences, 'function');
  assert.equal(typeof ports.isForegroundBusy, 'function');
  assert.equal(typeof ports.ports.seeds, 'function');
  const described = ports.describe();
  assert.equal(described.materials.port, 'planning-materials');
  assert.equal(described.materials.persona.source, 'workspace/PERSONA.md');
  assert.equal(described.foreground.wired, true);
  assert.equal(described.web.seedCount, 1);
  const persona = ports.persona();
  assert.match(persona.excerpt, /喜欢拍照/);
});
