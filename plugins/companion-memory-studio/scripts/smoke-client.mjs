#!/usr/bin/env node
// 无浏览器的客户端冒烟测试：用最小 React 运行时把 `client.js` 真正执行一遍，
// 逐个点开侧栏面板里的 7 个页面，喂真实形状的假响应，确认没有渲染崩溃、
// 页面都注册齐全、且数据确实进了 DOM。它不替代浏览器验证，只拦「一打开就白屏」。
//
// 用法：node scripts/smoke-client.mjs [--verbose]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const verbose = process.argv.includes('--verbose');
const artifact = path.join(root, 'client.js');

if (!fs.existsSync(artifact)) {
  console.error(`缺少 ${artifact}，先运行 node scripts/build-client.mjs`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 最小 React：只实现这些页面真正用到的部分（无并发、无优先级，够用即可）
// ---------------------------------------------------------------------------

const Fragment = Symbol('fragment');
const instances = new Map();
const cleanups = new Map();
let currentInstance = null;
let dirty = false;
const renderStack = [];
const tagStack = [];
let pendingEffects = [];

function createElement(type, props, ...children) {
  const merged = { ...(props || {}) };
  const flat = [];
  const push = (child) => {
    if (Array.isArray(child)) child.forEach(push);
    else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child);
  };
  children.forEach(push);
  // 与 React 一致：有位置子节点时覆盖 props.children；只写了 children 属性时保留它。
  if (flat.length > 0) merged.children = flat;
  else if (!('children' in merged)) merged.children = [];
  return { $$el: true, type, props: merged };
}

function hooksOf(key) {
  if (!instances.has(key)) instances.set(key, { hooks: [], cursor: 0, effectDeps: [] });
  return instances.get(key);
}

function useState(initial) {
  const instance = currentInstance;
  const index = instance.cursor++;
  if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial;
  const set = (next) => {
    const previous = instance.hooks[index];
    const value = typeof next === 'function' ? next(previous) : next;
    if (!Object.is(value, previous)) {
      instance.hooks[index] = value;
      dirty = true;
    }
  };
  return [instance.hooks[index], set];
}

function useRef(initial) {
  const instance = currentInstance;
  const index = instance.cursor++;
  if (!(index in instance.hooks)) instance.hooks[index] = { current: initial };
  return instance.hooks[index];
}

function sameDeps(next, previous) {
  if (!previous || previous.length !== next.length) return false;
  return next.every((value, index) => Object.is(value, previous[index]));
}

function useMemo(factory, deps) {
  const instance = currentInstance;
  const index = instance.cursor++;
  const list = deps || [];
  const slot = instance.hooks[index];
  if (!slot || !sameDeps(list, slot.deps)) instance.hooks[index] = { value: factory(), deps: list };
  return instance.hooks[index].value;
}

function useCallback(callback, deps) {
  return useMemo(() => callback, deps);
}

function useEffect(effect, deps) {
  const instance = currentInstance;
  const index = instance.cursor++;
  const list = deps || [];
  const previous = instance.effectDeps[index];
  if (!sameDeps(list, previous)) {
    instance.effectDeps[index] = list;
    pendingEffects.push({ key: `${instance.key}#${index}`, effect });
  }
}

function useId() {
  const instance = currentInstance;
  return useMemo(() => `smoke-${instance.key}`, []);
}

class Component {
  constructor(props) { this.props = props; }
  setState() { dirty = true; }
  forceUpdate() { dirty = true; }
}

const React = {
  createElement, Fragment, useState, useEffect, useMemo, useRef, useCallback, useId,
  Component, PureComponent: Component, StrictMode: Fragment,
  useLayoutEffect: useEffect,
};

// ---------------------------------------------------------------------------
// 渲染器
// ---------------------------------------------------------------------------

function renderNode(node, keyPath) {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string' || typeof node === 'number') return { type: 'text', value: String(node), props: {} };
  if (Array.isArray(node)) return { type: 'array', children: node.map((child, index) => renderNode(child, `${keyPath}.${index}`)), props: {} };
  if (!node.$$el) return { type: 'text', value: String(node), props: {} };

  const { type, props } = node;
  const children = props.children || [];
  if (type === Fragment) return { type: 'array', props, children: children.map((child, index) => renderNode(child, `${keyPath}.${index}`)) };

  if (typeof type === 'string') {
    tagStack.push(`${type}${props && props.className ? `.${String(props.className).split(' ')[0]}` : ''}`);
    const rendered = children.map((child, index) => renderNode(child, `${keyPath}.${index}`));
    tagStack.pop();
    return { type: 'tag', tag: type, props, children: rendered };
  }

  if (typeof type === 'function') {
    const instance = hooksOf(keyPath);
    // 真 React 在组件类型变化时会丢弃旧状态；这里照做，否则「切页」会读到上一页的 hooks。
    if (instance.type !== type) {
      instance.type = type;
      instance.hooks = [];
      instance.effectDeps = [];
    }
    instance.key = keyPath;
    instance.cursor = 0;
    const previous = currentInstance;
    currentInstance = instance;
    renderStack.push(type.name || type.displayName || "anonymous");
    let output;
    try {
      output = type(props);
    } finally {
      renderStack.pop();
      currentInstance = previous;
    }
    return renderNode(output, `${keyPath}~`);
  }

  throw new Error(`无法渲染的节点类型：${String(type)}（位置 ${keyPath}，props ${Object.keys(props || {}).join(',')}，栈 ${renderStack.join(' > ')}，标签 ${tagStack.join(' > ')}）`);
}

function flushEffects() {
  const list = pendingEffects;
  pendingEffects = [];
  for (const { key, effect } of list) {
    const previous = cleanups.get(key);
    if (typeof previous === 'function') previous();
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.set(key, cleanup);
    else cleanups.delete(key);
  }
}

async function renderUntilStable(element) {
  let tree = null;
  for (let pass = 0; pass < 80; pass += 1) {
    dirty = false;
    pendingEffects = [];
    tree = renderNode(element, 'root');
    flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!dirty) return tree;
  }
  throw new Error('渲染在 80 轮内没有稳定（可能是 setState 无限循环）');
}

function text(tree) {
  if (!tree) return '';
  if (tree.type === 'text') return tree.value;
  return (tree.children || []).map(text).join('');
}

function walk(tree, visit) {
  if (!tree) return;
  visit(tree);
  (tree.children || []).forEach((child) => walk(child, visit));
}

function findBy(tree, predicate) {
  let found = null;
  walk(tree, (node) => { if (!found && predicate(node)) found = node; });
  return found;
}

function findAll(tree, predicate) {
  const list = [];
  walk(tree, (node) => { if (predicate(node)) list.push(node); });
  return list;
}

// ---------------------------------------------------------------------------
// 浏览器环境替身
// ---------------------------------------------------------------------------

const FIXTURES = {
  companion: {
    persona: 'bot', observedAt: '2026-10-28T01:00:00.000Z',
    runtime: { available: true, mode: 'active', enabled: true, agenda: true, heartbeat: true, bridge: true },
    sections: { state: [], events: [] }, unavailable: [],
    life: {
      state: 'upcoming',
      switches: { planning: true, activities: true, share: false },
      planControls: { enabled: true, actions: ['lock', 'unlock', 'skip'] },
      plan: { planId: 'plan_fixture', day: '2026-10-28', version: 2, summary: 'FIXTURE-PLAN 傍晚读一点诗', windowStart: 1793000000000, windowEnd: 1793100000000 },
      current: { slot: null, activities: [] },
      next: [{
        slotId: 'slot_fixture_1', startAt: 1793052000000, endAt: 1793055600000, kind: 'activity',
        activity: 'read', title: 'FIXTURE-NEXT 读《春晓》', flexibility: 'fixed', status: 'planned',
        locked: 0, controls: ['lock', 'skip'], minutes: 60,
      }],
      ended: [], pending: [], skipped: [], receipts: [], share: { pending: 0, enabled: false },
      interests: [], opportunities: [],
    },
  },
  summary: {
    version: '0.4.0', backend: 'sqlite', reason: null, database: 'C:/tmp/home/memory/companion-memory.db',
    observedAt: '2026-10-28T01:00:00.000Z',
    counts: { memories: 773, confirmed: 773, pending: 0, superseded: 2, archived: 1, events: 781, embeddings: 773, wikiPages: 4, relations: 12 },
    scopeCounts: [{ scope: 'user_global', count: 28 }, { scope: 'user_persona', count: 270 }, { scope: 'persona_self', count: 475 }],
    kindCounts: [{ kind: 'fact', count: 400 }, { kind: 'preference', count: 200 }, { kind: 'event', count: 173 }],
    jobs: { pending: 0, running: 0, failed: 1, done: 4, lastError: 'llm-timeout' },
    channels: {
      fts: 'ok',
      embedding: { provider: 'local', model: 'hash-bigram-256', note: '本地字面近似，不是神经语义向量' },
      extraction: { enabled: true, minMessages: 6, model: 'deepseek-v4.1-flash' },
      wiki: { enabled: true, pages: 4, dir: 'C:/tmp/home/memory/wiki' },
    },
    config: { backend: 'sqlite', extractionEnabled: true, semanticEnabled: true, budgetChars: 2400, topK: 8, coverageFloor: 0.15 },
    integrity: { checkedAt: '2026-10-28T00:30:00.000Z', ok: true },
    recent: [{ id: 'mem_fixture_1', kind: 'fact', scope: 'user_global', status: 'confirmed', policy: 'direct', preview: 'FIXTURE-RECENT 用户喜欢雨天', updatedAt: '2026-10-28T00:20:00.000Z' }],
  },
  memories: {
    items: [
      { id: 'mem_fixture_1', kind: 'fact', scope: 'user_global', status: 'confirmed', policy: 'direct', key: 'weather', preview: 'FIXTURE-VAULT 用户喜欢雨天', importance: 0.8, confidence: 0.9, updatedAt: '2026-10-28T00:20:00.000Z', hidden: false },
      { id: 'mem_fixture_2', kind: 'preference', scope: 'user_persona', status: 'confirmed', policy: 'avoid_unless_asked', key: 'secret', preview: '（已隐藏）', importance: 0.5, confidence: 0.6, updatedAt: '2026-10-27T22:00:00.000Z', hidden: true },
    ],
    total: 2, offset: 0, limit: 25, query: '',
  },
  memory: {
    id: 'mem_fixture_1', key: 'weather', value: 'FIXTURE-DETAIL 用户喜欢雨天', kind: 'fact', scope: 'user_global',
    status: 'confirmed', policy: 'direct', importance: 0.8, confidence: 0.9, subject: 'user', predicate: 'likes:rain',
    realityLevel: 'explicit_user_statement', sourceKind: 'desktop_fact', tags: ['user_confirmed'], validFrom: '2026-10-28T00:00:00.000Z',
    validTo: null, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:20:00.000Z', revision: 2, supersedesId: null,
    hidden: false, revealable: true,
    evidence: [{ sourceId: 'evt_1', sessionId: 'sess_fixture', seq: 3, role: 'user', occurredAt: '2026-10-28T00:00:00.000Z', excerpt: 'FIXTURE-EVIDENCE 用户说自己喜欢雨天' }],
    revisions: [{ id: 'rev_1', operation: 'create', actor: 'system', reason: 'capture', at: '2026-10-28T00:00:00.000Z', oldId: '', newId: 'mem_fixture_1' }],
    related: [],
  },
  wiki: { pages: [{ pageId: 'index', topic: '索引', scope: 'system', path: 'index.md', revision: 3, status: 'compiled', notes: '' }, { pageId: 'user-profile', topic: '用户画像', scope: 'user_persona', path: 'user-profile.md', revision: 5, status: 'compiled', notes: 'FIXTURE-NOTES' }], topics: [{ id: 'user-profile', topic: '用户画像', path: 'user-profile.md' }], dir: 'C:/tmp/home/memory/wiki' },
  'wiki-page': { pageId: 'user-profile', topic: '用户画像', path: 'user-profile.md', exists: true, content: '# 用户画像\n\n- FIXTURE-WIKI 用户喜欢雨天\n- 常听《三体》', compiledAt: '2026-10-28T00:10:00.000Z', revision: 5, notes: 'FIXTURE-NOTES', manualNotes: 'FIXTURE-NOTES', generatedBytes: 2048 },
  preview: {
    query: '雨天', characters: 421, budgetChars: 2400, truncated: false,
    entries: [{ id: 'mem_fixture_1', kind: 'fact', scope: 'user_global', policy: 'direct', preview: 'FIXTURE-HIT 用户喜欢雨天', score: 0.87, reason: 'fts+vector' }],
    explain: { coverage: 0.42, coverageFloor: 0.15, stages: { fts: 3, vector: 2, fused: 3, mmr: 1 }, dropped: [{ reason: 'coverage_below_floor' }] },
    rendered: 'FIXTURE-INJECT 【记忆】用户喜欢雨天',
  },
  reviews: { pending: [{ id: 'mem_pending_1', kind: 'fact', scope: 'user_global', policy: 'direct', value: 'FIXTURE-PENDING 候选事实', confidence: 0.55, updatedAt: '2026-10-28T00:30:00.000Z', reasons: ['model_candidate'], hidden: false }], failedJobs: [{ id: 'job_fixture_1', type: 'extract', streamKey: 'sess_fixture', attempts: 2, lastError: 'llm-timeout', updatedAt: '2026-10-28T00:40:00.000Z' }] },
  settings: {
    configPath: 'C:/tmp/home/companion/memory.config.json', backend: 'sqlite', restartRequiredHint: true,
    editable: { backend: 'sqlite', extractionEnabled: true, minMessages: 6, semanticEnabled: true, budgetChars: 2400, topK: 8, rrfK: 60, mmrLambda: 0.72, coverageFloor: 0.15, embeddingProvider: 'local', wikiAutoCompile: true, wikiMaxEntriesPerTopic: 40 },
  },
  corrections: {
    available: true, operator: 'u:10001',
    evidenceHint: '后台人工裁决 at 2026-10-28T01:00:00.000Z by u:10001',
    count: 2, resolved: 1, pendingRetries: 0, resolvedListAvailable: true,
    recent: [
      {
        recordId: 'rec_fixture_1', at: 1761600000000,
        candidates: [
          { recordId: 'mem_fixture_old_1', text: 'FIXTURE-OLD-1 用户喜欢热闹', truncated: false, at: 1761500000000, kind: 'preference', missing: false },
          { recordId: 'mem_fixture_old_2', text: 'FIXTURE-OLD-2 用户住在北京', truncated: true, at: 1761500001000, kind: 'fact', missing: false },
        ],
      },
      {
        recordId: 'rec_fixture_2', at: 1761600001000,
        candidates: [
          { recordId: 'mem_fixture_old_3', text: '', truncated: false, at: 0, kind: '', missing: true },
        ],
      },
    ],
    resolvedRecent: [
      { recordId: 'rec_done_1', supersededIds: ['mem_fixture_old_9'], supersededCount: 1, operator: 'u:10001', at: 1761590000000, outcome: 'resolved-superseded' },
    ],
  },
  timeline: { items: [{ at: '2026-10-28T00:20:00.000Z', type: 'user/message', sessionId: 'sess_fixture', seq: 4, role: 'user', preview: 'FIXTURE-EVENT 用户聊到雨天', hidden: false }] },
};

const requests = [];
const calls = [];

function stubResponse(data) {
  return { ok: true, status: 200, json: async () => ({ ok: true, data, meta: { source: 'companion-memory', schemaVersion: 1, observedAt: '2026-10-28T01:00:00.000Z' } }) };
}

async function fakeFetch(input, init) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
  const parsed = new URL(url, 'http://127.0.0.1:52623/');
  const endpoint = parsed.pathname.replace(/^\/api\/companion-memory\/?/, '') || 'summary';
  const method = (init && init.method) || 'GET';
  const body = init && init.body ? JSON.parse(init.body) : null;
  requests.push({ method, endpoint, query: Object.fromEntries(parsed.searchParams), body });
  calls.push(endpoint);
  const key = endpoint === 'maintenance' ? 'summary' : endpoint === 'review' ? 'reviews' : endpoint;
  // 心跳「开始」失败的信封（`pulse-unreachable` + errorCode 细分）：只在显式放进去时生效。
  if (method === 'POST' && endpoint.includes('companion-health/pulse') && FIXTURES['__pulse-post-failure']) {
    return { ok: true, status: 200, json: async () => FIXTURES['__pulse-post-failure'] };
  }
  if (method === 'POST') {
    return stubResponse({ ok: true, id: 'mem_fixture_1', status: 'confirmed', revision: 3, changed: [], restartRequired: true });
  }
  if (!(key in FIXTURES)) return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'not-found', message: `fixture 缺失：${key}` } }) };
  return stubResponse(FIXTURES[key]);
}

const documentStub = {
  baseURI: 'http://127.0.0.1:52623/',
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '', style: {} }),
  head: { appendChild() {} },
  querySelector: () => null,
};
const windowStub = {
  __ModuleLoader__: { load(entry) { captured.entry = entry; } },
  confirm: () => true,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const captured = { entry: null };

// ---------------------------------------------------------------------------
// 执行产物
// ---------------------------------------------------------------------------

const moduleTable = { react: React };
const sandbox = {
  window: windowStub,
  document: documentStub,
  fetch: fakeFetch,
  URL,
  console,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  navigator: { userAgent: 'smoke' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  globalThis,
};

const factoryBody = fs.readFileSync(artifact, 'utf8');
// 产物是 `window.__ModuleLoader__.load({ id, factory })`，这里在受控作用域里执行它。
const run = new Function(
  'window', 'document', 'fetch', 'URL', 'console', 'setTimeout', 'queueMicrotask', 'requestAnimationFrame', 'navigator', 'localStorage',
  `${factoryBody}\n//# sourceURL=client.js`,
);
run(sandbox.window, sandbox.document, sandbox.fetch, URL, console, setTimeout, queueMicrotask, sandbox.requestAnimationFrame, sandbox.navigator, sandbox.localStorage);

if (!captured.entry) {
  console.error('客户端产物没有调用 window.__ModuleLoader__.load(...)');
  process.exit(1);
}
if (captured.entry.id !== '@dsh-companion/memory-studio') {
  console.error(`产物 id 不匹配：${captured.entry.id}`);
  process.exit(1);
}

const moduleExports = captured.entry.factory((name) => {
  if (!(name in moduleTable)) throw new Error(`产物请求了未提供的模块：${name}`);
  return moduleTable[name];
});

const registrations = [];
const fakeCtx = {
  effect: (fn) => {
    const cleanup = fn();
    return typeof cleanup === 'function' ? cleanup : () => {};
  },
  on: () => () => {},
  get: () => undefined,
  slots: {
    inject: (slotName, callback) => callback(),
    register: (options, component) => {
      registrations.push({ slot: options.name, id: options.id, key: options.key, options, component });
      return () => {};
    },
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
};

if (typeof moduleExports.apply !== 'function') {
  console.error('产物没有导出 apply(ctx)');
  process.exit(1);
}
moduleExports.apply(fakeCtx);

const panel = registrations.find((entry) => entry.slot === 'sidebar.panellist');
const main = registrations.find((entry) => entry.slot === 'main');
if (!panel || !main) {
  console.error(`注册不完整：slots=${registrations.map((entry) => entry.slot).join(',')}`);
  process.exit(1);
}
if (typeof panel.component !== 'function' || typeof main.component !== 'function') {
  console.error('注册项没有组件');
  process.exit(1);
}

// 图标必须真的渲染出 svg
const iconTree = await renderUntilStable(createElement(panel.component, { size: 18 }));
if (!findBy(iconTree, (node) => node.tag === 'svg')) {
  console.error('侧栏图标没有渲染出 <svg>');
  process.exit(1);
}


const failures = [];
const RAIL_LABELS = ['陪伴首页', '聊天', '生活与日程', '记忆与档案', '连接与工具', '工作区', '设置'];

let tree = await renderUntilStable(createElement(main.component, {}));

const classOf = (node) => String((node.props && node.props.className) || '');
const buttonsWith = (className) => findAll(tree, (node) => node.tag === 'button' && classOf(node).includes(className));
const railButtons = () => buttonsWith('cpx-nav-item');
const tabButtons = () => buttonsWith('cpx-tab');
const textOf = (node) => text(node).trim();

// 1. 一级导航：七个入口，顺序固定
const railLabels = railButtons().map(textOf);
if (railLabels.join('|') !== RAIL_LABELS.join('|')) {
  failures.push(`一级导航不匹配：期望 ${RAIL_LABELS.join('/')}，实际 ${railLabels.join('/')}`);
}

// 2. 首页内容：主场景 + 真实状态 + 接下来的安排
{
  const rendered = text(tree);
  if (!rendered.includes('陪伴首页')) failures.push('首页：没有页名');
  if (!rendered.includes('接下来的安排')) failures.push('首页：缺少「接下来的安排」分区');
  if (!rendered.includes('FIXTURE-NEXT')) failures.push('首页：没有渲染真实的下一个安排');
  if (!rendered.includes('需要你确认的事')) failures.push('首页：缺少「需要你确认的事」分区');
  if (findAll(tree, (node) => classOf(node).includes('cpx-aside-section')).length < 2) failures.push('首页：缺少右栏状态分区');
}

// 3. 主题三档 + 导航折叠（都要真的改变 DOM 状态）
{
  const themeButtons = buttonsWith('cpx-theme-btn');
  if (themeButtons.length !== 3) failures.push(`主题开关：期望 3 档，实际 ${themeButtons.length}`);
  const dark = themeButtons.find((node) => String(node.props.title || '').includes('深色'));
  if (!dark || typeof dark.props.onClick !== 'function') failures.push('主题开关：深色档不可点');
  else {
    dark.props.onClick();
    tree = await renderUntilStable(createElement(main.component, {}));
    const app = findBy(tree, (node) => classOf(node).includes('cpx-app'));
    if (!app || app.props['data-theme'] !== 'dark') failures.push(`主题开关：点了深色但 data-theme=${app ? app.props['data-theme'] : 'missing'}`);
  }
  const appNode = () => findBy(tree, (node) => classOf(node).includes('cpx-app'));
  const before = appNode().props['data-rail'];
  const toggles = buttonsWith('cpx-rail-toggle');
  if (!toggles.length) failures.push('找不到导航折叠按钮');
  else {
    toggles[0].props.onClick();
    tree = await renderUntilStable(createElement(main.component, {}));
    const after = appNode().props['data-rail'];
    if (before === after) failures.push(`导航折叠没有生效（${before} → ${after}）`);
    buttonsWith('cpx-rail-toggle')[0].props.onClick();
    tree = await renderUntilStable(createElement(main.component, {}));
  }
}

const clickRail = (label) => {
  const button = railButtons().find((node) => textOf(node) === label);
  if (!button || typeof button.props.onClick !== 'function') return false;
  button.props.onClick();
  return true;
};

// 4. 每个一级页面都能打开，且有自己的页名
for (const label of ['陪伴首页', '生活与日程', '连接与工具', '工作区', '设置']) {
  if (!clickRail(label)) {
    failures.push(`找不到导航：${label}`);
    continue;
  }
  tree = await renderUntilStable(createElement(main.component, {}));
  const rendered = text(tree);
  if (rendered.includes('缺少页面')) failures.push(`${label}：页面片段没有构建（显示「缺少页面」）`);
  else if (!rendered.includes(label === '设置' ? '设置' : label)) failures.push(`${label}：页名没有出现在内容里`);
  const titles = findAll(tree, (node) => classOf(node).includes('cpx-title'));
  if (!titles.length) failures.push(`${label}：没有 h1 页名`);
}

// 4b. 生活页的「最近经历（只读投影）」：空的时候说「暂无经历」而不是留白；有活动时四种结果
//     各自渲染。P2.5-2 E7：这块是**投影**，页面必须自己在标题与说明里写清楚。
{
  const lifeFixture = FIXTURES.companion.life;
  delete lifeFixture.experience;
  if (!clickRail('生活与日程')) failures.push('找不到导航：生活与日程');
  else {
    tree = await renderUntilStable(createElement(main.component, {}));
    const empty = text(tree);
    if (!empty.includes('最近经历（只读投影）')) failures.push('生活页：缺少「最近经历（只读投影）」标题');
    if (!empty.includes('暂无经历')) failures.push('生活页：空经历没有显示「暂无经历」');
  }
  lifeFixture.experience = {
    authority: 'projection',
    note: '只读投影：由活动与回执派生，不是权威状态（权威是事件书与 runner）。',
    source: 'p2_activities + p2_activity_receipts',
    counts: { completed: 1, failed: 1, skipped: 1, review: 1 },
    items: [
      { activityId: 'a1', kind: 'read', target: 'FIXTURE-EXP-1 读完一章', result: 'completed', resultLabel: '完成', tone: 'ok', at: 1793050000000, source: 'file-read', simulated: false },
      { activityId: 'a2', kind: 'write', target: 'FIXTURE-EXP-2 写作没成', result: 'failed', resultLabel: '失败', tone: 'warn', at: 1793040000000, source: 'file-write', simulated: false },
      { activityId: 'a3', kind: 'explore', target: 'FIXTURE-EXP-3 放弃了', result: 'skipped', resultLabel: '跳过', tone: 'neutral', at: 1793030000000, source: 'web', simulated: true },
      { activityId: 'a4', kind: 'read', target: 'FIXTURE-EXP-4 等内容确认', result: 'review', resultLabel: '待复核', tone: 'warn', at: 1793020000000, source: 'file-read', simulated: false },
    ],
    total: 4,
    emptyNote: '暂无经历',
  };
  if (clickRail('生活与日程')) {
    tree = await renderUntilStable(createElement(main.component, {}));
    const rendered = text(tree);
    for (const label of ['完成', '失败', '跳过', '待复核']) {
      if (!rendered.includes(label)) failures.push(`生活页经历投影：缺少结果「${label}」`);
    }
    if (!rendered.includes('FIXTURE-EXP-1')) failures.push('生活页经历投影：目标没有渲染出来');
    // 2026-11-04 文案规则：免责/口径类解释收进 ⓘ（悬停才显示），所以这里正文或 ⓘ 的
    // data-tip / aria-label 命中任一处即可，不能只认正文。
    const authorityNote = rendered.includes('不是权威状态')
      || findAll(tree, (node) => node && node.props
        && (String(node.props['data-tip'] || '').includes('不是权威状态')
          || String(node.props['aria-label'] || '').includes('不是权威状态'))).length > 0;
    if (!authorityNote) failures.push('生活页经历投影：没有标注「不是权威状态」（正文与 ⓘ 都没有）');
  }
  delete lifeFixture.experience;
}

// 4c. 审核页的「待裁决的纠正」（task-40）：计数、候选正文、截断标记、证据提示都要出现；
//     一个都不勾就提交也是合法动作（按钮文案要说清"作为补充"）。
{
  if (!clickRail('记忆与档案')) failures.push('找不到导航：记忆与档案');
  else {
    // 点开分组后必须先渲染一次，tab 按钮才挂上（与下面第 5 段同款）。
    tree = await renderUntilStable(createElement(main.component, {}));
    const tab = tabButtons().find((node) => textOf(node).includes('审核'));
    if (!tab) failures.push('记忆与档案：找不到 tab「审核」');
    else {
      tab.props.onClick();
      tree = await renderUntilStable(createElement(main.component, {}));
      const rendered = text(tree);
      if (!rendered.includes('待裁决的纠正')) failures.push('审核页：缺少「待裁决的纠正」这一块');
      if (!rendered.includes('FIXTURE-OLD-1')) failures.push('审核页：候选旧记忆的正文没有渲染');
      if (!rendered.includes('已截断')) failures.push('审核页：被截断的候选没有标「已截断」');
      if (!rendered.includes('后台人工裁决 at')) failures.push('审核页：没有把"将要记下的证据"展示出来');
      if (!rendered.includes('待裁决 2 条')) failures.push('审核页：待裁决计数没有显示');
      if (!rendered.includes('作为补充')) failures.push('审核页：全不选时的按钮文案不对');
      // 已裁决明细（只读）+ missing 候选的可读文案
      if (!rendered.includes('已作废旧记忆')) failures.push('审核页：已裁决明细没有渲染 outcome');
      if (!rendered.includes('mem_fixture_old_9')) failures.push('审核页：已裁决明细没有列出被作废的 id');
      if (!rendered.includes('该记忆已不存在')) failures.push('审核页：正文缺失的候选没有显示「该记忆已不存在」');
      const boxes = findAll(tree, (node) => node && node.props && node.props.type === 'checkbox');
      if (!boxes.length) failures.push('审核页：候选没有可勾选的复选框');
    }
  }
}

// 5. 分组入口的每个 tab 都能打开（记忆与档案、设置）
for (const groupLabel of ['记忆与档案', '设置']) {
  if (!clickRail(groupLabel)) {
    failures.push(`找不到导航：${groupLabel}`);
    continue;
  }
  tree = await renderUntilStable(createElement(main.component, {}));
  const tabs = tabButtons().map(textOf);
  if (tabs.length < 3) failures.push(`${groupLabel}：tab 数量异常（${tabs.join('/')}）`);
  for (const label of tabs) {
    const button = tabButtons().find((node) => textOf(node) === label);
    if (!button) {
      failures.push(`${groupLabel}：找不到 tab「${label}」`);
      continue;
    }
    button.props.onClick();
    tree = await renderUntilStable(createElement(main.component, {}));
    const rendered = text(tree);
    if (rendered.includes('缺少页面')) failures.push(`${groupLabel}/${label}：页面片段没有构建`);
    if (!findAll(tree, (node) => classOf(node).includes('cpx-title')).length) failures.push(`${groupLabel}/${label}：没有页名`);
    else if (rendered.length < 80) failures.push(`${groupLabel}/${label}：内容过短（${rendered.length} 字符）`);
  }
}

// 5b. 健康页的「心跳 · 实时」卡片（contract design/pulse-bond-20261103.md §7）：
//     有读数时大号 bpm + 设备 + 会话 + 三个按钮 + 授权开关都要渲染；
//     `bpm: null` 时必须显示「—」，绝不能画成 0；会话没开要说「未开始」；
//     2026-11-04 起会话默认**跟随设备**：device 模式不渲染倒计时，关掉广播后自动收口。
{
  const PULSE_ENDPOINT = '/api/companion-health/pulse';
  // 只有显式给 minutes 的老式计时会话才该出现「剩余 N 分钟」。
  // 时间点必须相对 script 运行时刻算：写成固定 epoch 的 fixture 会随时间过期，
  // 一过期 remaining 就变 0、卡片改说「即将结束」，断言「剩余」就假失败。
  const PULSE_NOW = Date.now();
  const withReading = {
    ok: true, enabled: true, sidecar: { reachable: true, baseUrl: 'http://127.0.0.1:8151' },
    connected: true, deviceLabel: 'FIXTURE-STRAP', bpm: 118, sampleAgeMs: 900, quality: 'ok',
    zone: 'racing', trend: 'up', baseline: 92, peak: { bpm: 137, at: PULSE_NOW },
    session: {
      active: true, id: 'p1', startedAt: PULSE_NOW - 60_000, endsAt: PULSE_NOW + 29 * 60_000, minutes: 30,
      mode: 'timer', remainingMs: 29 * 60_000, deviceOffMs: 30000,
    },
    series: [{ t: 1, bpm: 112 }, { t: 2, bpm: 118 }], safety: null, note: '',
  };
  FIXTURES[PULSE_ENDPOINT] = withReading;
  if (!clickRail('生活与日程')) failures.push('找不到导航：生活与日程');
  else {
    tree = await renderUntilStable(createElement(main.component, {}));
    const healthTab = tabButtons().find((node) => textOf(node).includes('健康'));
    if (!healthTab) failures.push(`生活与日程：找不到 tab「健康与睡眠」（${tabButtons().map(textOf).join('/')}）`);
    else {
      healthTab.props.onClick();
      tree = await renderUntilStable(createElement(main.component, {}));
      const rendered = text(tree);
      for (const needle of ['心跳 · 实时', '118', 'FIXTURE-STRAP', '剩余', '开始', '结束', '此刻标记', 'health.pulse.live']) {
        if (!rendered.includes(needle)) failures.push(`心跳卡：缺少「${needle}」`);
      }
      if (rendered.includes('0 bpm')) failures.push('心跳卡：出现了 0 bpm（没有读数必须写「—」）');
      if (!findAll(tree, (node) => node && node.props && node.props.type === 'checkbox').length) {
        failures.push('心跳卡：health.pulse.live 授权开关没有渲染');
      }

      // (1) device 模式：跟随设备，**不渲染倒计时**，只说从什么时候开始。
      FIXTURES[PULSE_ENDPOINT] = {
        ...withReading,
        session: {
          active: true, id: 'p2', startedAt: 1793731200000, endsAt: null, minutes: null,
          mode: 'device', remainingMs: null, deviceOffMs: 30000,
        },
      };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      tree = await renderUntilStable(createElement(main.component, {}));
      const deviceSession = text(tree);
      if (!deviceSession.includes('跟随设备')) failures.push('心跳卡：device 模式没有显示「跟随设备」');
      if (deviceSession.includes('剩余')) failures.push('心跳卡：device 模式不该出现「剩余 N 分钟」');
      if (deviceSession.includes('即将结束')) failures.push('心跳卡：device 模式不该出现「即将结束」');

      // (2) 设备被关掉、会话随之收口：三个条件都成立（disconnected + active:false + 静满 deviceOffMs）
      //     → 中性提示 + 不显示任何数字。
      const offSession = {
        active: false, id: null, startedAt: null, endsAt: null, minutes: null,
        mode: 'device', remainingMs: null, deviceOffMs: 30000,
      };
      FIXTURES[PULSE_ENDPOINT] = {
        ok: true, enabled: true, sidecar: { reachable: true }, connected: false, deviceLabel: 'FIXTURE-STRAP',
        lastErrorCode: 'disconnected', bpm: 118, sampleAgeMs: 45000, quality: 'sparse',
        zone: null, trend: 'flat', baseline: null, peak: { bpm: null, at: null },
        session: offSession, series: [{ t: 1, bpm: 112 }, { t: 2, bpm: 118 }], safety: null, note: '',
      };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      tree = await renderUntilStable(createElement(main.component, {}));
      const deviceOff = text(tree);
      if (!deviceOff.includes('设备已关闭，会话随之结束')) failures.push('心跳卡：设备关掉后没有显示「设备已关闭，会话随之结束」');
      if (deviceOff.includes('118')) failures.push('心跳卡：设备关掉后还在显示旧的 bpm 数字');
      if (!deviceOff.includes('—')) failures.push('心跳卡：设备关掉后 bpm 没有变成「—」');
      if (!deviceOff.includes('已结束')) failures.push('心跳卡：会话收口后没有显示「已结束」');

      // (2b) 主人按了「结束」（`stop` 会顺带断开 BLE）：同样是 disconnected + connected:false，
      //      但读数还很新（2 秒前，没静满 deviceOffMs）→ 只能说「已结束」，**不许**说
      //      「设备已关闭，会话随之结束」（那是把主人的主动操作说成设备故障）。
      FIXTURES[PULSE_ENDPOINT] = {
        ok: true, enabled: true, sidecar: { reachable: true }, connected: false, deviceLabel: 'FIXTURE-STRAP',
        lastErrorCode: 'disconnected', bpm: 118, sampleAgeMs: 2000, quality: 'sparse',
        zone: null, trend: 'flat', baseline: null, peak: { bpm: null, at: null },
        session: offSession, series: [{ t: 1, bpm: 112 }, { t: 2, bpm: 118 }], safety: null, note: '',
      };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      tree = await renderUntilStable(createElement(main.component, {}));
      const stopped = text(tree);
      if (!stopped.includes('已结束')) failures.push('心跳卡：主动结束后没有显示「已结束」');
      if (stopped.includes('设备已关闭，会话随之结束')) {
        failures.push('心跳卡：主动结束（stop 断 BLE）被说成了「设备已关闭，会话随之结束」');
      }

      // (2c) 只有"读数比 deviceOffMs 还旧"、没有 disconnected 信号：也不许说成设备被关掉。
      FIXTURES[PULSE_ENDPOINT] = {
        ok: true, enabled: true, sidecar: { reachable: true }, connected: false, deviceLabel: 'FIXTURE-STRAP',
        bpm: 118, sampleAgeMs: 45000, quality: 'sparse',
        zone: null, trend: 'flat', baseline: null, peak: { bpm: null, at: null },
        session: offSession, series: [], safety: null, note: '',
      };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      tree = await renderUntilStable(createElement(main.component, {}));
      const staleOnly = text(tree);
      if (staleOnly.includes('设备已关闭，会话随之结束')) {
        failures.push('心跳卡：没有 disconnected 信号时不该说「设备已关闭，会话随之结束」');
      }

      // (2d) 会话还开着但设备正在掉线（后端最多 30 s 后收口）：这是有界的瞬时窗口，
      //      用 warn 表达"正在掉线"、bpm 照旧显示（"会话还在、读数在变旧"是事实）。
      FIXTURES[PULSE_ENDPOINT] = {
        ok: true, enabled: true, sidecar: { reachable: true }, connected: false, deviceLabel: 'FIXTURE-STRAP',
        lastErrorCode: 'disconnected', bpm: 118, sampleAgeMs: 2000, quality: 'sparse',
        zone: 'racing', trend: 'flat', baseline: 92, peak: { bpm: 118, at: 1793731234567 },
        session: { ...offSession, active: true, id: 'p3', startedAt: 1793731200000 },
        series: [{ t: 1, bpm: 112 }, { t: 2, bpm: 118 }], safety: null, note: '',
      };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      tree = await renderUntilStable(createElement(main.component, {}));
      const dropping = text(tree);
      if (!dropping.includes('118')) failures.push('心跳卡：会话还开着、设备正在掉线时应当照常显示读数');
      if (dropping.includes('设备已关闭，会话随之结束')) failures.push('心跳卡：会话还开着时不该说「设备已关闭，会话随之结束」');

      // (2e) 「开始」失败的两种原因必须给两份不同的建议（Lead 裁决 2026-11-04）：
      //      device-not-found → 去手环上开「心率广播」；connect-timeout → 再点一次/重连。
      const startFail = (errorCode) => ({
        ok: false,
        error: { code: 'pulse-unreachable', message: '心率广播接收端未运行，拿不到读数。', errorCode },
        meta: { source: 'companion-health', schemaVersion: 1, observedAt: '2026-11-04T01:00:00.000Z' },
      });
      const idleSession = {
        active: false, id: null, startedAt: null, endsAt: null, minutes: null,
        mode: 'device', remainingMs: null, deviceOffMs: 30000,
      };
      FIXTURES[PULSE_ENDPOINT] = { ...withReading, session: idleSession };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const clickStart = (wantText) => {
        const button = findAll(tree, (node) => node.tag === 'button' && textOf(node) === '开始')[0];
        if (!button) {
          failures.push('心跳卡：找不到「开始」按钮');
          return false;
        }
        button.props.onClick();
        return true;
      };
      FIXTURES['__pulse-post-failure'] = startFail('device-not-found');
      tree = await renderUntilStable(createElement(main.component, {}));
      if (clickStart()) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        tree = await renderUntilStable(createElement(main.component, {}));
        const notFound = text(tree);
        if (!notFound.includes('没找到在广播的手环')) failures.push('心跳卡：device-not-found 没有给出"去手环上开广播"的建议');
        if (notFound.includes('找到了手环但没连上')) failures.push('心跳卡：device-not-found 用了超时那句文案');
      }
      FIXTURES['__pulse-post-failure'] = startFail('connect-timeout');
      if (clickStart()) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        tree = await renderUntilStable(createElement(main.component, {}));
        const timedOut = text(tree);
        if (!timedOut.includes('找到了手环但没连上（超时）')) failures.push('心跳卡：connect-timeout 没有给出重连建议');
        if (timedOut.includes('没找到在广播的手环')) failures.push('心跳卡：connect-timeout 用了"没找到"那句文案');
      }
      // 其它原因（没有 errorCode）仍沿用原来那句。
      FIXTURES['__pulse-post-failure'] = startFail(null);
      if (clickStart()) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        tree = await renderUntilStable(createElement(main.component, {}));
        const generic = text(tree);
        if (generic.includes('没找到在广播的手环') || generic.includes('找到了手环但没连上')) {
          failures.push('心跳卡：没有 errorCode 时不该乱猜失败原因');
        }
      }
      delete FIXTURES['__pulse-post-failure'];

      // 没有读数的那一拍：bpm=null → 「—」，会话未开 → 「未开始」，设备断开 → 「未连接」。
      // 轮询是 1 Hz，所以要先让下一拍真的落下来再渲染一次。
      FIXTURES[PULSE_ENDPOINT] = {
        ok: true, enabled: true, sidecar: { reachable: true }, connected: false, deviceLabel: null,
        bpm: null, sampleAgeMs: null, quality: 'no-contact', zone: null, trend: 'flat', baseline: null,
        peak: { bpm: null, at: null }, session: { active: false }, series: [], safety: null, note: '',
      };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      tree = await renderUntilStable(createElement(main.component, {}));
      const idle = text(tree);
      if (!idle.includes('—')) failures.push('心跳卡：没有读数时没有显示「—」');
      if (idle.includes('0 bpm')) failures.push('心跳卡：空读数被画成了 0 bpm');
      if (!idle.includes('未开始')) failures.push('心跳卡：会话未开始时没有显示「未开始」');
      if (!idle.includes('未连接')) failures.push('心跳卡：设备断开时没有显示「未连接」');

      // 读失败也要留着卡片并说明原因，不能整块消失。
      delete FIXTURES[PULSE_ENDPOINT];
      await new Promise((resolve) => setTimeout(resolve, 1200));
      tree = await renderUntilStable(createElement(main.component, {}));
      if (!text(tree).includes('心跳')) failures.push('心跳卡：读失败后卡片消失了');
    }
  }
}

// 6. 原生聊天入口在没有 layout 服务时必须给出可读提示，而不是静默失败
{
  if (clickRail('聊天')) {
    tree = await renderUntilStable(createElement(main.component, {}));
    const rendered = text(tree);
    if (!rendered.includes('宿主导航')) failures.push('聊天：缺少 layout 服务时没有可读提示');
  } else {
    failures.push('找不到导航：聊天');
  }
}

const usedEndpoints = [...new Set(calls)].sort();
console.log('客户端冒烟');
console.log(`  产物   ${artifact}`);
console.log(`  注册   sidebar.panellist + main + 导航项 ${railLabels.length} 个：${railLabels.join(' / ')}`);
console.log(`  请求   ${requests.length} 次：${usedEndpoints.join(', ')}`);
console.log(`  结果   ${failures.length === 0 ? '通过' : `失败 ${failures.length} 项`}`);
for (const failure of failures) console.error(`  ✘ ${failure}`);

// 页面里可能有 setInterval（实时状态栏）：跑完把挂载的 effect 都清掉，
// 否则事件循环被占着，冒烟会一直挂着不退出。
for (const [key, cleanup] of cleanups) {
  try { cleanup(); } catch { /* 卸载失败不影响结论 */ }
  cleanups.delete(key);
}
process.exitCode = failures.length === 0 ? 0 : 1;
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 50);
