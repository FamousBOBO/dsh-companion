import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 设置搜索面板的**结构**测试（复核报告 N1 / N2 / N3 / N9）。
 *
 * 面板是浏览器片段（纯脚本 + P 原语），DOM 交互由 `scripts/smoke-client.mjs` 覆盖；
 * 这里在 Node 里用最小 P 把片段执行一遍，只数**结构事实**：
 *   - 同屏到底有几个 `role="dialog"`（N1：设置页曾经两个）；
 *   - `onKeyDown` 挂在几个节点上（N3：曾经两层都挂，一次按键执行两遍）；
 *   - 点遮罩能不能关闭，以及遮罩有没有真的铺满视口的 CSS（N9）；
 *   - 关闭时会不会把焦点还给打开它的控件（N2）。
 *
 * `SETTINGS_SEARCH_SRC=<path>` 可以把片段换成任意一份实现 —— 用来证明这些断言
 * 在修复前的代码上真的会红（不是"改完就绿"）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '..');
const sourcePath = process.env.SETTINGS_SEARCH_SRC
  || path.join(moduleRoot, 'src/client/settings-search.js');
const source = fs.readFileSync(sourcePath, 'utf8');

/** 一个最小 P：只提供片段真正用到的东西。 */
function createHarness() {
  let cssText = '';
  const hooks = new Map(); // key -> { cursor, states, ranEffects, cleanups }
  let currentKey = '';
  let cursor = 0;
  const pendingEffects = [];

  const P = {
    css(text) { cssText += text; },
    h(type, props, ...children) {
      const merged = { ...(props || {}) };
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
      if (flat.length) merged.children = flat;
      return { type, props: merged };
    },
    useState(initial) {
      const entry = hooks.get(currentKey);
      const index = cursor++;
      if (!(index in entry.states)) {
        entry.states[index] = typeof initial === 'function' ? initial() : initial;
      }
      const set = (next) => {
        entry.states[index] = typeof next === 'function' ? next(entry.states[index]) : next;
      };
      return [entry.states[index], set];
    },
    useEffect(effect) {
      const entry = hooks.get(currentKey);
      const index = cursor++;
      pendingEffects.push({ entry, index, effect });
    },
    useRef(initial) {
      const entry = hooks.get(currentKey);
      const index = cursor++;
      if (!(index in entry.refs)) entry.refs[index] = { current: initial ?? null };
      return entry.refs[index];
    },
    useMemo(factory) { return factory(); },
    useId: () => 'id',
    // 面板的数据源：空查询回一份稳定目录，够渲染出下拉项即可。
    useApi() { return { data: { matches: [], catalog: null, returned: 0, total: 0 }, error: null, loading: false, reload: () => {} }; },
    api: { get: () => ({ data: { matches: [], catalog: null, returned: 0, total: 0 }, error: null, loading: false }) },
    nav: { go: () => {} },
    toastOnce: () => {},
    notice: () => {},
    ui: {
      Icon: 'icon',
      Button: 'button',
      ErrorBox: 'errorbox',
      Badge: 'badge',
    },
  };

  // eslint-disable-next-line no-new-func
  new Function('P', source)(P);

  /**
   * 递归展开函数组件。
   *
   * `SettingsSearchHost` 返回的是 `h(CatalogPanel, {...})` —— 一个"元素"，类型是组件本身。
   * 真实运行时会把组件渲染成 DOM；这里的假 h 只造元素，所以必须显式展开，否则数到的是
   * 一个函数而永远不是 `role="dialog"`。每条路径一个独立 key，等于真实运行时的每实例状态。
   */
  function expand(node, key) {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const child = render(key, node.type, node.props || {});
      return expand(child, key);
    }
    const children = node.props && node.props.children;
    if (children === undefined) return node;
    const list = Array.isArray(children) ? children : [children];
    const rendered = list.map((item, index) => expand(item, `${key}/${index}`));
    return { ...node, props: { ...node.props, children: Array.isArray(children) ? rendered : rendered[0] } };
  }

  /** 渲染一个组件（每个 key 一份独立的 hook 状态），并把新注册的 effect 跑一次。 */
  function render(key, component, props) {
    currentKey = key;
    cursor = 0;
    if (!hooks.has(key)) hooks.set(key, { states: [], refs: [], ranEffects: new Set(), cleanups: [] });
    const entry = hooks.get(key);
    pendingEffects.length = 0;
    const tree = component(props || {});
    for (const item of pendingEffects) {
      const marker = item.index;
      if (item.entry.ranEffects.has(marker)) continue;
      item.entry.ranEffects.add(marker);
      const cleanup = item.effect();
      if (typeof cleanup === 'function') item.entry.cleanups.push(cleanup);
    }
    return tree;
  }

  /** 模拟"整棵树重新渲染时面板被移除"：跑所有已注册的 cleanup。 */
  function unmountAll() {
    for (const key of [...hooks.keys()]) unmount(key);
  }

  /** 模拟真实卸载：跑该 key 注册过的所有 cleanup。 */
  function unmount(key) {
    const entry = hooks.get(key);
    if (!entry) return;
    for (const cleanup of entry.cleanups) {
      try { cleanup(); } catch { /* 忽略 */ }
    }
    entry.cleanups.length = 0;
    entry.ranEffects.clear();
    hooks.delete(key);
  }

  const collect = (tree, predicate) => collectExpanded(expand, tree, predicate);
  return { P, render, expand, collect, unmount, unmountAll, cssText: () => cssText };
}

/** 展开函数组件后再遍历（`collect` 因此能看见真正的 dialog / input / option）。 */
function collectExpanded(expand, tree, predicate) {
  const expanded = expand(tree, 'expanded');
  const hits = [];
  walk(expanded, (node) => { if (predicate(node)) hits.push(node); });
  return hits;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.$$el !== false && node.props) visit(node);
  const children = node.props && node.props.children;
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
  for (const child of list) walk(child, visit);
}

function collectUnused(tree, predicate) {
  const hits = [];
  walk(tree, (node) => { if (predicate(node)) hits.push(node); });
  return hits;
}

function classOf(node) {
  const value = node.props && node.props.className;
  return String(Array.isArray(value) ? value.join(' ') : (value ?? ''));
}

function makeOpener() {
  const state = { focused: 0, isConnected: true };
  return {
    tagName: 'BUTTON',
    focus() { state.focused += 1; },
    get focused() { return state.focused; },
  };
}

// ---------------------------------------------------------------------------

// 片段在模块级注册 window 监听（全局快捷键），所以测试期间需要一个最小的 window。
// 只提供 addEventListener / removeEventListener，不做真实事件派发 —— 快捷键路径由
// scripts/smoke-client.mjs 的 DOM 模拟覆盖，这里只验结构。
function withWindow(fn) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { contains: () => true, activeElement: null };
  try {
    return fn();
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else globalThis.document = previousDocument;
  }
}

test('the panel exists in exactly one place no matter how many triggers a page renders (N1)', () => withWindow(() => {
  const { P, render, collect } = createHarness();
  // 先把面板打开：计数要在"面板可见"的前提下做（关闭时 0 个本来就是对的）。
  const opener = makeOpener();
  const warm = render('page-warm', P.ui.SettingsSearch, { compact: false });
  collect(warm, (node) => classOf(node).includes('cpx-cat-trigger'))[0].props.onClick({ currentTarget: opener });

  // 页面壳上的全局挂载点（只渲面板）。
  const host = render('host', P.ui.SettingsSearchHost, {});
  // 设置页里的触发器（只渲按钮）—— 旧实现这里也会渲一块面板。
  const triggerA = render('page-a', P.ui.SettingsSearch, { compact: false });
  const triggerB = render('page-b', P.ui.SettingsSearch, { compact: false });

  const dialogs = [...collect(host, (node) => node.props.role === 'dialog'),
    ...collect(triggerA, (node) => node.props.role === 'dialog'),
    ...collect(triggerB, (node) => node.props.role === 'dialog')];
  assert.equal(dialogs.length, 1, `同屏 role=dialog 应为 1 个，实际 ${dialogs.length} 个`);

  const overlays = [...collect(host, (node) => classOf(node).includes('cpx-cat-overlay')),
    ...collect(triggerA, (node) => classOf(node).includes('cpx-cat-overlay')),
    ...collect(triggerB, (node) => classOf(node).includes('cpx-cat-overlay'))];
  assert.equal(overlays.length, 1, `同屏遮罩应为 1 个，实际 ${overlays.length} 个`);

  // 触发器自己不该再渲染面板，只该有一个按钮。
  for (const [name, tree] of [['page-a', triggerA], ['page-b', triggerB]]) {
    const inputs = collect(tree, (node) => node.tag === 'input' || node.type === 'input');
    assert.equal(inputs.length, 0, `${name} 不该渲染搜索输入框`);
    const button = collect(tree, (node) => node.type === 'button' && classOf(node).includes('cpx-cat-trigger'));
    assert.equal(button.length, 1, `${name} 应该有一个触发按钮`);
  }
}));
test('the panel is closed by default, and opening it happens through the shared state', () => withWindow(() => {
  const { P, render, collect } = createHarness();
  const closed = render('host', P.ui.SettingsSearchHost, {});
  assert.equal(collect(closed, (node) => node.props.role === 'dialog').length, 0, '默认不该有面板');

  const trigger = render('trigger', P.ui.SettingsSearch, { compact: false });
  const button = collect(trigger, (node) => classOf(node).includes('cpx-cat-trigger'))[0];
  assert.ok(button, '触发器必须有按钮');
  button.props.onClick({ currentTarget: makeOpener() });

  const opened = render('host', P.ui.SettingsSearchHost, {});
  assert.equal(collect(opened, (node) => node.props.role === 'dialog').length, 1, '点触发器后面板应打开');
}));
test('onKeyDown is attached to exactly one node (N3)', () => withWindow(() => {
  const { P, render, collect } = createHarness();
  const trigger = render('trigger', P.ui.SettingsSearch, { compact: false });
  collect(trigger, (node) => classOf(node).includes('cpx-cat-trigger'))[0].props.onClick({ currentTarget: makeOpener() });

  const tree = render('host', P.ui.SettingsSearchHost, {});
  const handlers = collect(tree, (node) => typeof node.props.onKeyDown === 'function');
  assert.equal(handlers.length, 1, `onKeyDown 只该挂 1 处，实际 ${handlers.length} 处`);

  // 唯一那一处必须自己带 defaultPrevented 守卫（防"将来又挂第二处"）。
  const handler = handlers[0].props.onKeyDown;
  assert.match(String(handler), /defaultPrevented/, 'keydown 处理器必须有 defaultPrevented 守卫');
}));
test('one ArrowDown moves the selection by exactly one row', () => withWindow(() => {
  const { P, render, collect } = createHarness();
  // 造两条结果，才能看出"一次走两格"。
  const original = P.useApi;
  P.useApi = () => ({
    data: {
      matches: [
        { id: 'studio:topK', label: '每轮召回条数', category: '检索', path: 'retrieval.topK', hotLevel: 'restart', status: 'configured', permission: 'host', deepLink: 'studio:settings' },
        { id: 'qq:talkValue', label: '群聊回复概率', category: '群聊', path: 'talkValue', hotLevel: 'live', status: 'configured', permission: 'owner', deepLink: 'qq:groups' },
      ],
      catalog: { totalFields: 2 },
      returned: 2,
      total: 2,
    },
    error: null, loading: false, reload: () => {},
  });

  try {
    const host = render('host', P.ui.SettingsSearchHost, {});
    // 面板默认是关的：先打开。
    const trigger = render('trigger', P.ui.SettingsSearch, { compact: false });
    collect(trigger, (node) => classOf(node).includes('cpx-cat-trigger'))[0].props.onClick({ currentTarget: makeOpener() });
    const tree = render('host', P.ui.SettingsSearchHost, {});

    const handler = collect(tree, (node) => typeof node.props.onKeyDown === 'function')[0].props.onKeyDown;
    const event = {
      key: 'ArrowDown',
      prevented: false,
      preventDefault() { this.prevented = true; this.defaultPrevented = true; },
      defaultPrevented: false,
    };
    handler(event);
    const options = collect(tree, (node) => node.props.role === 'option');
    assert.ok(options.length >= 2, `应有至少两条结果，实际 ${options.length}`);
    // 一次 ArrowDown → 第 2 条被选中（索引 1），不是第 3 条（索引 2）。
    const selected = collect(tree, (node) => node.props.role === 'option' && node.props['aria-selected'] === true);
    assert.equal(selected.length, 1, '应当只有一条被选中');
    assert.equal(selected[0].props.id, 'cpx-cat-item-1', `一次 ArrowDown 应停在索引 1，实际 ${selected[0].props.id}`);
  } finally {
    P.useApi = original;
  }
}));
test('clicking the dimmed area really closes the panel, and that layer has real CSS (N9)', () => withWindow(() => {
  const harness = createHarness();
  const { P, render, collect } = harness;

  const trigger = render('trigger', P.ui.SettingsSearch, { compact: false });
  collect(trigger, (node) => classOf(node).includes('cpx-cat-trigger'))[0].props.onClick({ currentTarget: makeOpener() });
  const tree = render('host', P.ui.SettingsSearchHost, {});
  const backdrop = collect(tree, (node) => classOf(node).includes('cpx-cat-backdrop'))[0];
  assert.ok(backdrop, '必须有遮罩节点');
  assert.equal(typeof backdrop.props.onClick, 'function', '遮罩必须能点击关闭');

  // 遮罩必须有真的定位规则：`position:absolute` + `inset:0`，否则它在 flex 行里宽度为 0，
  // onClick 挂上去等于点不到（这正是复核实测的症状）。
  const css = harness.cssText();
  const rule = css.match(/\.cpx-cat-backdrop\s*\{([^}]*)\}/);
  assert.ok(rule, '`.cpx-cat-backdrop` 必须有 CSS 规则（否则是零宽度幽灵节点）');
  assert.match(rule[1], /position\s*:\s*absolute/, '遮罩必须绝对定位');
  assert.match(rule[1], /inset\s*:\s*0|top\s*:\s*0/, '遮罩必须铺满视口');

  // 真的点它（target 就是它自己）→ 面板关闭。
  backdrop.props.onClick({ target: backdrop, currentTarget: backdrop });
  const afterClose = render('host', P.ui.SettingsSearchHost, {});
  assert.equal(collect(afterClose, (node) => node.props.role === 'dialog').length, 0, '点遮罩后面板应关闭');
}));
test('closing the panel returns focus to whatever opened it (N2)', () => withWindow(() => {
  const { P, render, collect, unmountAll } = createHarness();
  const opener = makeOpener();

  const trigger = render('trigger', P.ui.SettingsSearch, { compact: false });
  collect(trigger, (node) => classOf(node).includes('cpx-cat-trigger'))[0].props.onClick({ currentTarget: opener });
  // 必须先把面板真的渲染出来（`collect` 会展开函数组件），否则它根本没注册 effect，
  // 也就谈不上"卸载时归还焦点"。
  const host = render('host', P.ui.SettingsSearchHost, {});
  const panel = collect(host, (node) => node.props.role === 'dialog')[0];
  assert.ok(panel, '面板应当已经渲染');

  // 关闭 = 面板整棵子树消失 → 它的 cleanup 应当把焦点还给 opener。
  unmountAll();
  assert.equal(opener.focused, 1, '关闭面板时焦点必须回到打开它的控件');
}));
test('the panel is still a real modal: dialog + aria-modal + focusable panel', () => withWindow(() => {
  const { P, render, collect } = createHarness();
  const trigger = render('trigger', P.ui.SettingsSearch, { compact: false });
  collect(trigger, (node) => classOf(node).includes('cpx-cat-trigger'))[0].props.onClick({ currentTarget: makeOpener() });
  const tree = render('host', P.ui.SettingsSearchHost, {});
  const panel = collect(tree, (node) => node.props.role === 'dialog')[0];
  assert.ok(panel, '必须有 dialog');
  assert.equal(panel.props['aria-modal'], 'true');
  assert.equal(panel.props.tabIndex, -1, '面板本身要可聚焦（tabIndex=-1），Tab 陷阱才有落点');
  // 遮罩不得把面板一起盖进 aria-hidden 子树（H4 的原始缺陷）。
  const hiddenWrapper = collect(tree, (node) => node.props['aria-hidden'] === 'true');
  for (const wrapper of hiddenWrapper) {
    const inside = collect(wrapper, (node) => node.props.role === 'dialog');
    assert.equal(inside.length, 0, 'aria-hidden 子树里不能有 dialog');
  }
}));