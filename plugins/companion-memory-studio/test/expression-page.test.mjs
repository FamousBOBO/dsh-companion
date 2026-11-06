import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 表情包管理页的**逻辑**测试。
 *
 * 页面是浏览器片段（纯脚本 + P 原语），所以这里在 Node 里用一个最小 P 把片段执行一遍，
 * 只测它导出的纯函数：六态映射、端点解析、指标格式化（缺值必须「—」）、模拟结果渲染、
 * 图库视图与未启用态。DOM 交互由 scripts/smoke-client.mjs 覆盖，两处不重复。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '..');
const source = fs.readFileSync(path.join(moduleRoot, 'src/client/pages-expression.js'), 'utf8');

function loadPageModule() {
  const P = {
    css() {},
    registerPage() {},
    h(type, props, ...children) { return { type, props: { ...(props || {}), children } }; },
    useApi() { return { data: null, error: null, loading: true }; },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect() {},
    useMemo(factory) { return factory(); },
    useRef() { return { current: null }; },
    ui: {},
    ApiError: class ApiError extends Error {
      constructor(message, status, code) { super(message); this.status = status; this.code = code; }
    },
    failText: error => String((error && error.message) || error || ''),
    confirm: () => true,
    notice: () => {},
    fmt: {
      bytes: value => `${value} B`,
      number: value => String(value),
    },
  };
  // 片段是 IIFE：`(function (P) { ... })(P)`，用 P 当参数执行即可拿到 P.expressionPage。
  // eslint-disable-next-line no-new-func
  new Function('P', source)(P);
  return P.expressionPage;
}

const page = loadPageModule();

// ---------------------------------------------------------------------------
// 受控 descriptor / config（形状取自 companion-expression 的 /page + /config）
// ---------------------------------------------------------------------------

const STATES = [
  { id: 'disabled', label: '功能关闭' },
  { id: 'unconfigured', label: '未配置' },
  { id: 'not-connected', label: '尚未接入' },
  { id: 'saved-untested', label: '已保存、未测试' },
  { id: 'test-ok', label: '测试通过' },
  { id: 'test-failed', label: '测试失败' },
];

const API = {
  page: 'GET /api/companion-expression/page',
  config: 'GET /api/companion-expression/config',
  save: 'POST /api/companion-expression/config',
  assets: 'GET /api/companion-expression/assets',
  asset: 'GET /api/companion-expression/asset',
  action: 'POST /api/companion-expression/asset',
  thumb: 'GET /api/companion-expression/thumb',
  sources: 'GET /api/companion-expression/sources',
  grants: 'POST /api/companion-expression/grants',
  deliveries: 'GET /api/companion-expression/deliveries',
  metrics: 'GET /api/companion-expression/metrics',
  simulate: 'POST /api/companion-expression/simulate',
};

/** 服务端 metrics 的真实形状（CONTRACT.md §5）；precision / p95 为 null 表示"无法计算"。 */
function metricsFixture(overrides = {}) {
  return {
    ok: true,
    windowHours: 168,
    delivery: { confirmed: 3, unknown: 1, failed: 1, total: 5, confirmRate: 0.6 },
    feedback: { praise: 2, reject: 1, correction: 0, bySignal: { praise: 2, reject: 1 } },
    precision: 2 / 3,
    repeat7d: 3,
    leak: 0,
    p95Ms: 420,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

test('状态文案映射：六个状态照抄 descriptor，未知值不猜', () => {
  assert.equal(page.stateLabel(STATES, 'disabled'), '功能关闭');
  assert.equal(page.stateLabel(STATES, 'unconfigured'), '未配置');
  assert.equal(page.stateLabel(STATES, 'not-connected'), '尚未接入');
  assert.equal(page.stateLabel(STATES, 'saved-untested'), '已保存、未测试');
  assert.equal(page.stateLabel(STATES, 'test-ok'), '测试通过');
  assert.equal(page.stateLabel(STATES, 'test-failed'), '测试失败');
  assert.equal(page.stateLabel(STATES, 'made-up-state'), '未知');
  // descriptor 改了文案就跟着改：说明页面没有自己那套常量在说话
  assert.equal(page.stateLabel([{ id: 'test-ok', label: '测试通过（新口径）' }], 'test-ok'), '测试通过（新口径）');
  assert.equal(page.stateTone('test-failed'), 'danger');
  assert.equal(page.stateTone('disabled'), 'neutral');
  assert.equal(page.stateTone('made-up'), 'neutral');
});

test('端点取自 descriptor.api，不手写路径', () => {
  assert.equal(page.apiPath(API.assets, 'assets'), 'api/companion-expression/assets');
  assert.equal(page.apiPath(API.thumb, 'thumb'), 'api/companion-expression/thumb');
  assert.equal(page.apiPath(API.simulate, 'simulate'), 'api/companion-expression/simulate');
  assert.equal(page.apiPath('', 'assets'), 'api/companion-expression/assets');
  assert.equal(page.apiPath('GET relative-ish', 'x'), 'api/companion-expression/x');
});

test('指标格式化：缺值一律「—」，绝不用 0 冒充', () => {
  assert.equal(page.formatMetric(null, 'percent'), '—');
  assert.equal(page.formatMetric(undefined, 'count'), '—');
  assert.equal(page.formatMetric('', 'count'), '—');
  assert.equal(page.formatMetric('not-a-number', 'count'), '—');
  assert.equal(page.formatMetric(0, 'count'), '0', '真的 0 要显示 0');
  assert.equal(page.formatMetric(0.666, 'percent'), '67%');
  assert.equal(page.formatMetric(420, 'ms'), '420 ms');
  assert.equal(page.formatMetric(1500, 'ms'), '1.50 s');
});

test('指标视图：九个指标齐全，null 的 precision / p95 是「—」', () => {
  const view = page.metricsView(metricsFixture({ precision: null, p95Ms: null }));
  assert.deepEqual(view.rows.map(row => row.id), [
    'precision', 'context_fit', 'awkward', 'repeat_7d', 'abstain',
    'delivery_confirmed', 'unknown', 'leak', 'p95',
  ]);
  const byId = Object.fromEntries(view.rows.map(row => [row.id, row]));
  assert.equal(byId.precision.value, '—', 'null 的 precision 必须显示「—」');
  assert.equal(byId.precision.raw, null);
  assert.equal(byId.p95.value, '—');
  assert.equal(byId.leak.value, '0');
  assert.equal(byId.leak.tone, '', 'leak=0 不该报警');
  assert.equal(byId.repeat_7d.value, '3');
  assert.equal(byId.delivery_confirmed.value, '3');
  assert.equal(byId.unknown.value, '1');
  // awkward 没有单独字段时回落到 feedback.reject（口径一致，不是猜出来的数）
  assert.equal(byId.awkward.value, '1');
  // 每个指标都带口径说明，页面不需要自己解释数字
  for (const row of view.rows) assert.ok(row.hint && row.hint.length > 4, `${row.id} 缺少口径说明`);
});

test('指标视图：leak 不为 0 时报警；读不到的原因要带出来', () => {
  const view = page.metricsView(metricsFixture({ leak: 2, unavailable: ['数据库还没打开'] }));
  const leak = view.rows.find(row => row.id === 'leak');
  assert.equal(leak.value, '2');
  assert.equal(leak.tone, 'danger');
  assert.deepEqual(view.unavailable, ['数据库还没打开']);
  assert.equal(view.windowHours, 168);
});

test('指标视图：空对象不会崩，所有指标都是「—」', () => {
  const view = page.metricsView({});
  assert.equal(view.rows.length, 9);
  assert.ok(view.rows.every(row => row.value === '—' || row.value === '0'));
  assert.equal(page.metricsView(null).rows.length, 9);
  assert.equal(page.metricsView(undefined).rows.length, 9);
});

test('决策视图：send / abstain 都说清理由，reasonCode 原样展示', () => {
  const abstain = page.decisionView({ send: false, reasonCode: 'below-fit-threshold', fitScore: 0.31 });
  assert.equal(abstain.known, true);
  assert.equal(abstain.send, false);
  assert.equal(abstain.title, '不发图（只说话）');
  assert.equal(abstain.reasonCode, 'below-fit-threshold');
  assert.match(abstain.why, /below-fit-threshold/);

  const send = page.decisionView({ send: true, reasonCode: 'fits', fitScore: 0.9 });
  assert.equal(send.title, '会发一张图');

  const none = page.decisionView(null);
  assert.equal(none.known, false);
  assert.equal(none.send, null);
  assert.match(none.title, /还没有模拟结果/);

  // 缺 reasonCode 时页面不编一个原因出来
  const bare = page.decisionView({ send: false });
  assert.equal(bare.reasonCode, '');
  assert.match(bare.why, /没有给 reasonCode/);
});

test('模拟结果渲染：候选最多 5 条、常驻声明、绝不出现"已发送"', () => {
  const result = {
    ok: true,
    sending: false,
    decision: { send: true, reasonCode: 'sticker-ok', fitScore: 0.88 },
    candidates: Array.from({ length: 8 }, (_, index) => ({
      assetId: `a${index}`,
      summary: `候选 ${index}`,
      intents: ['agree', 'soften', 'joke', 'ignore', 'other'],
      avoidWhen: ['serious', 'conflict', 'spam', 'more'],
      score: 0.9 - index / 20,
    })),
    plan: {
      mode: 'text_then_sticker',
      parts: [
        { kind: 'text', text: 'FIXTURE-TEXT 好呀' },
        { kind: 'sticker', assetId: 'a0' },
      ],
    },
  };
  const view = page.simulateView(result);
  assert.equal(view.ok, true);
  assert.equal(view.banner, '模拟不会向 QQ 发送任何内容');
  assert.equal(view.candidates.length, 5, '只展示前 5 个候选');
  assert.equal(view.candidates[0].rank, 1);
  assert.equal(view.candidates[0].assetId, 'a0');
  assert.deepEqual(view.candidates[0].intents, ['agree', 'soften', 'joke', 'ignore'], '意图最多展示 4 个');
  assert.deepEqual(view.candidates[0].avoidWhen, ['serious', 'conflict', 'spam']);
  assert.equal(view.message, 'FIXTURE-TEXT 好呀');
  assert.match(view.planText, /会用的素材：a0/);
  assert.equal(view.partsCount, 2);
  assert.equal(view.sending, false);
  // 整段渲染里不许出现"已发送"这类会让人误会的字样
  assert.equal(JSON.stringify(view).includes('已发送'), false);
});

test('模拟结果渲染：只说话的计划、空候选、失败信封', () => {
  const textOnly = page.simulateView({
    ok: true,
    decision: { send: false, reasonCode: 'no-candidates' },
    candidates: [],
    plan: { mode: 'text_only', parts: [{ kind: 'text', text: '只是说句话' }] },
  });
  assert.equal(textOnly.candidates.length, 0);
  assert.equal(textOnly.planText, '本轮计划：text_only');
  assert.equal(textOnly.banner, '模拟不会向 QQ 发送任何内容');

  const noPlan = page.simulateView({ ok: true, decision: { send: false, reasonCode: 'x' }, candidates: [] });
  assert.equal(noPlan.message, '');
  assert.match(noPlan.planText, /没有生成计划/);

  const failed = page.simulateView({ ok: false, error: { message: '检索与决策还没接上' } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /还没接上/);
  assert.equal(failed.banner, '模拟不会向 QQ 发送任何内容', '失败时声明也必须在');
});

test('图库视图：只保留可渲染字段，行里不得带 file_path', () => {
  const grid = page.assetGrid({
    items: [
      { assetId: 'a1', literal: '笑着说好', moderationState: 'approved', scopeLabel: '群 100', file_path: 'C:/secret/x.png' },
      { id: 'a2', summary: '无语', moderation_state: 'review', label: '公共精选' },
      { assetId: '', literal: '没有 id 的行' },
    ],
    total: 2,
  });
  assert.deepEqual(grid.items.map(item => item.assetId), ['a1', 'a2']);
  assert.equal(grid.items[0].moderation, 'approved');
  assert.equal(grid.items[0].scopeLabel, '群 100');
  assert.equal(grid.items[1].moderation, 'review');
  const serialized = JSON.stringify(grid);
  assert.equal(serialized.includes('file_path'), false, '行里不得出现 file_path');
  assert.equal(serialized.includes('secret'), false);
  assert.equal(grid.total, 2);
});

test('图库视图：空图库给出可读说明，而不是「加载中」', () => {
  const empty = page.assetGrid({ items: [], total: 0 });
  assert.equal(empty.items.length, 0);
  assert.ok(empty.empty.length > 0);
  assert.match(empty.empty, /还没有素材/);
  // 服务端给了 note 就用服务端的说法
  assert.match(page.assetGrid({ items: [], note: 'NODE-FROM-SERVER' }).empty, /NODE-FROM-SERVER/);
  // 完全没有数据也不崩
  assert.equal(page.assetGrid(null).items.length, 0);
});

test('未启用态：给出可走通的启用片段（modules.expression=true）', () => {
  assert.match(page.ENABLE_SNIPPET, /"expression": true/);
  assert.match(page.ENABLE_SNIPPET, /"modules"/);
  assert.equal(page.isDisabledAnswer(404, null), true);
  assert.equal(page.isDisabledAnswer(200, { error: { code: 'expression-disabled' } }), true);
  assert.equal(page.isDisabledAnswer(200, { error: { code: 'no-connection' } }), true);
  assert.equal(page.isDisabledAnswer(503, null), true);
  // 真的业务错误不是"未启用"
  assert.equal(page.isDisabledAnswer(400, { error: { code: 'expression-bad-input' } }), false);
  assert.equal(page.isDisabledAnswer(500, null), false);
  assert.equal(page.isDisabledAnswer(200, { ok: true }), false);
});

test('收集规则视图：群三开关 / 对端授权分开，私聊不回推 QQ 号', () => {
  const view = page.grantsView({
    items: [
      { kind: 'group', chatId: 100, capture: true, store: true, use: false, assets: 4, scope: 'group:100' },
      { kind: 'group', scope: 'group:200', capture: false, store: false, use: true, assets: 0 },
      { kind: 'peer', chatId: 300, granted: true, label: '对端私聊 ab12…', assets: 1 },
      { kind: 'curated', scope: 'curated_public' },
      { kind: 'group', chatId: 'abc' },
    ],
  });
  assert.equal(view.groups.length, 2, '非法 chatId 的群被丢掉');
  assert.equal(view.groups[0].chatId, 100);
  assert.equal(view.groups[0].capture, true);
  assert.equal(view.groups[0].use, false);
  assert.equal(view.groups[1].chatId, 200, 'chatId 可以从 group: scope 里取出来');
  assert.equal(view.groups[1].use, true);
  assert.equal(view.peers.length, 1);
  assert.equal(view.peers[0].chatId, 300);
  assert.match(view.peers[0].label, /ab12/, '对端只显示服务端给的短标签');
  assert.equal(JSON.stringify(view.peers).includes('3000000001'), false);
  assert.equal(view.empty, '');
  assert.match(page.grantsView({ items: [] }).empty, /还没有任何授权来源/);
});

test('审核态文案：认识的照抄，不认识的原样显示', () => {
  assert.equal(page.moderationText('approved'), '已通过');
  assert.equal(page.moderationText('review'), '待复核');
  assert.equal(page.moderationText('quarantined'), '已隔离');
  assert.equal(page.moderationText('disabled'), '已禁用');
  assert.equal(page.moderationText('revoked'), '已撤销');
  assert.equal(page.moderationText('brand-new-state'), 'brand-new-state');
  assert.equal(page.moderationText(''), '未知');
});

test('时间与计数：毫秒/ISO 都认，未知给 NaN / 「—」', () => {
  assert.equal(page.toMillis(1793000000000), 1793000000000);
  assert.equal(page.toMillis('2026-10-28T00:20:00.000Z'), Date.parse('2026-10-28T00:20:00.000Z'));
  assert.ok(Number.isNaN(page.toMillis(null)));
  assert.ok(Number.isNaN(page.toMillis('')));
  assert.ok(Number.isNaN(page.toMillis('not-a-date')));
  assert.equal(page.countOrDash(0), '0');
  assert.equal(page.countOrDash(null), '—');
  assert.equal(page.countOrDash('abc'), '—');
});

test('真 descriptor 也能吃下（companion-expression 在场时）', async (t) => {
  const expressionRoot = path.resolve(moduleRoot, '..', 'companion-expression');
  if (!fs.existsSync(path.join(expressionRoot, 'src', 'ui-page.mjs'))) {
    t.skip('companion-expression 不在同级目录，跳过形状兼容性检查');
    return;
  }
  const ui = await import(pathToFileURL(path.join(expressionRoot, 'src', 'ui-page.mjs')).href);
  const config = await import(pathToFileURL(path.join(expressionRoot, 'src', 'config.mjs')).href);
  const { config: normalized } = config.normalizeConfig(config.DEFAULT_CONFIG);
  const descriptor = ui.pageDescriptor(normalized, {
    moduleEnabled: true,
    configExists: true,
    channelConnected: true,
  });

  // 六态：descriptor 给的那六个词，页面照抄
  assert.equal(descriptor.states.length, 6);
  for (const state of descriptor.states) {
    assert.equal(page.stateLabel(descriptor.states, state.id), state.label);
  }
  // canTest 恒 false：页面不能提供"测试连接"
  assert.equal(descriptor.capabilities.canTest, false);
  assert.ok(String(descriptor.capabilities.canTestReason || '').length > 10);
  // 端点用真值解析，不依赖页面里的常量
  for (const [key, spec] of Object.entries(descriptor.api)) {
    const resolved = page.apiPath(spec, key);
    assert.match(resolved, /^api\/companion-expression\//, `${key} 端点解析失败：${spec}`);
  }
  // 启用片段与页面自己的一致
  assert.equal(descriptor.meta.enableSnippet, page.ENABLE_SNIPPET);
  // 实验/模拟声明是只读
  assert.match(String(descriptor.meta.simulationPolicy), /never-sends/);
  assert.equal(descriptor.meta.testPolicy, 'explicit-only');

  // 真 metrics 路由的返回形状也能被页面摊开（这里用假数据，但字段名取自 CONTRACT）
  const view = page.metricsView(metricsFixture({ precision: null, p95Ms: null }));
  assert.equal(view.rows.length, 9);
  assert.equal(view.rows.find(row => row.id === 'precision').value, '—');
});
