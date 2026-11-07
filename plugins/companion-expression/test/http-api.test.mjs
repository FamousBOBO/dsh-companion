import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Studio HTTP 面的离线验收（`src/studio.mjs`）。
 *
 * 只测**路由层**：假 service 的方法名逐一对齐 `studio.mjs` 里真实调用的那 11 个
 * （`getConfig` / `saveConfig` / `listAssets` / `getAsset` / `assetAction` / `thumbBytes` /
 * `listSources` / `grantScope` / `listDeliveries` / `metrics` / `simulate`），并返回
 * `http.mjs` facade 的真实形状。名字对不上会被 Proxy 立刻炸出来，而不是悄悄拿到 undefined。
 *
 * 钉住：未启用不 500、Origin 只认 loopback、入参只认 assetId、缩略图字节必须落在 assetsRoot
 * 内、`/simulate` 恒定 `sending:false`、`POST /config` 的拒绝理由来自上游校验器本身。
 */

const { createExpressionHandlers, assertSafeInput, Code, API_PREFIX } = await import('../src/studio.mjs');
const { DEFAULT_CONFIG, normalizeConfig, validateConfig } = await import('../src/config.mjs');
const { ENABLE_SNIPPET } = await import('../src/ui-page.mjs');

const BASE = 'http://127.0.0.1:1234';
const CONFIG = normalizeConfig(DEFAULT_CONFIG).config;
const ROUTE_NAMES = ['page', 'config', 'assets', 'asset', 'thumb', 'sources', 'grants', 'deliveries', 'metrics', 'simulate'];
const REQUIRED_KEYS = [
  `GET ${API_PREFIX}/page`, `GET ${API_PREFIX}/config`, `POST ${API_PREFIX}/config`,
  `GET ${API_PREFIX}/assets`, `GET ${API_PREFIX}/asset`, `POST ${API_PREFIX}/asset`,
  `GET ${API_PREFIX}/thumb`, `GET ${API_PREFIX}/sources`, `POST ${API_PREFIX}/grants`,
  `GET ${API_PREFIX}/deliveries`, `GET ${API_PREFIX}/metrics`, `POST ${API_PREFIX}/simulate`,
];
const METHOD_NAMES = ['getConfig', 'saveConfig', 'listAssets', 'getAsset', 'assetAction',
  'thumbBytes', 'listSources', 'grantScope', 'listDeliveries', 'metrics', 'simulate'];
const SERVICE_PROPS = new Set([...METHOD_NAMES, 'paths', 'assetsRoot', 'dataRoot', 'calls']);

/** 假 service：默认返回值照 `http.mjs` 的 facade 写，`overrides` 只覆盖关心的那一个。 */
function fakeService(overrides = {}) {
  const calls = [];
  const defaults = {
    getConfig: () => ({
      ok: true, config: CONFIG, exists: true, file: '/tmp/config.json', warnings: [],
      status: { moduleEnabled: true, configExists: true, channelConnected: true },
    }),
    // 用**真实**校验器：「400 带上游 reason」是真的带上游原话，不是测试自己编的字符串。
    saveConfig: (patch) => {
      const checked = validateConfig(patch);
      return checked.ok === false
        ? { ok: false, error: { code: Code.CONFIG_INVALID, message: checked.error } }
        : { ok: true, saved: true, config: checked.config, warnings: checked.warnings ?? [] };
    },
    listAssets: () => ({
      ok: true, total: 1,
      items: [{ id: 'asset-1', filePath: '/tmp/leak.png', kind: 'image', mime: 'image/png', byteSize: 4, createdAt: 1 }],
    }),
    getAsset: assetId => ({
      ok: true, asset: { assetId, kind: 'image', mime: 'image/png' }, card: { literal: '笑死' },
      // originScope 在 facade 里已经被映射成 scope；这里给映射后的形状。
      sources: [{ scope: 'group:100', firstSeen: 1, consentRef: null }],
      deliveries: [{ planId: 'p1', status: 'confirmed' }], feedback: [{ signal: 'praise' }],
    }),
    assetAction: input => ({ ok: true, ...input }),
    thumbBytes: () => ({ ok: false, error: { code: Code.NOT_FOUND, message: '没有这个素材。' } }),
    listSources: () => ({ ok: true, items: [{ scope: 'group:100', kind: 'group' }, { scope: 'curated_public', kind: 'curated' }] }),
    grantScope: input => ({ ok: true, granted: input.granted, kind: input.kind, chatId: input.chatId }),
    listDeliveries: ({ limit }) => ({
      ok: true, total: 3,
      items: [{ planId: 'p1', status: 'confirmed' }, { planId: 'p2', status: 'failed' }, { planId: 'p3', status: 'unknown' }].slice(0, limit),
    }),
    metrics: () => ({ ok: true, delivery: { confirmed: 1, failed: 0, total: 1 }, feedback: { praise: 1, reject: 0 }, precision: 1, repeat7d: 1, leak: null, p95: null }),
    simulate: () => ({ ok: true, sending: false, decision: { send: false, reasonCode: 'text-only-low-fit' }, candidates: [{ assetId: 'asset-1' }], plan: { mode: 'text-only' } }),
  };
  const target = { calls };
  for (const name of METHOD_NAMES) {
    target[name] = (...args) => {
      calls.push({ name, args });
      return (overrides[name] ?? defaults[name])(...args);
    };
  }
  // 未知属性立即失败：这是「假 service 必须与源码调用一致」的硬保证。
  const service = new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'symbol') return obj[prop];
      if (!SERVICE_PROPS.has(prop)) throw new Error(`studio.mjs 访问了假 service 未声明的方法：${String(prop)}`);
      return obj[prop];
    },
  });
  return { service, calls };
}

function requestOf(key, { query = '', body, origin } = {}) {
  const [method, route] = key.split(' ');
  const headers = {};
  if (origin) headers.origin = origin;
  const init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  return new Request(`${BASE}${route}${query ? `?${query}` : ''}`, init);
}

async function call(handlers, key, opts = {}) {
  const res = await handlers[key](requestOf(key, opts));
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { res, status: res.status, contentType: res.headers.get('content-type') ?? '', body: isJson ? await res.json().catch(() => null) : null };
}

const countOf = (calls, name) => calls.filter(c => c.name === name).length;

test('路由表：12 条，key 全是 METHOD /api/companion-expression/xxx', () => {
  const handlers = createExpressionHandlers(null);
  const keys = Object.keys(handlers);
  assert.equal(keys.length, REQUIRED_KEYS.length);
  for (const key of keys) {
    assert.match(key, /^(GET|POST) \/api\/companion-expression\/[a-z]+$/, `路由 key 形状不对：${key}`);
    assert.ok(ROUTE_NAMES.includes(key.split('/').pop()), `未知路由：${key}`);
  }
  for (const key of REQUIRED_KEYS) assert.equal(typeof handlers[key], 'function', `缺路由：${key}`);
  for (const key of keys) assert.equal(typeof handlers[key].disabled, 'function', `${key} 未挂未启用分支`);
});

test('未启用（service=null）：每个路由 200 + expression-disabled + enableSnippet，绝不 500、绝不抛', async () => {
  const handlers = createExpressionHandlers(null);
  for (const key of Object.keys(handlers)) {
    const { status, body } = await call(handlers, key);
    assert.equal(status, 200, `${key} 未启用必须是 200，实际 ${status}`);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, Code.DISABLED);
    assert.ok(body.error.message.includes('未启用'), `${key} 的说明必须可读`);
    assert.equal(body.enableSnippet, ENABLE_SNIPPET, `${key} 必须带启用片段`);
  }
  // /page 额外给一份默认配置形状，state 必须是 disabled，且 api 表与路由表一致。
  const page = await call(handlers, `GET ${API_PREFIX}/page`);
  assert.equal(page.body.page.id, 'companion-expression');
  assert.equal(page.body.page.state, 'disabled');
  assert.equal(page.body.page.capabilities.canSend, false);
  assert.equal(page.body.page.capabilities.canTest, false);
  assert.deepEqual(Object.values(page.body.page.api).sort(), [...REQUIRED_KEYS].sort());
});

test('Origin 守卫：跨站一律 403、loopback 与无 Origin 放行、永不回 CORS 头', async () => {
  const { service } = fakeService();
  const handlers = createExpressionHandlers(service);
  for (const key of Object.keys(handlers)) {
    const evil = await call(handlers, key, { origin: 'http://evil.example' });
    assert.equal(evil.status, 403, `${key} 不该接受跨站 Origin`);
    assert.equal(evil.body.error.code, Code.FORBIDDEN);
    assert.equal(evil.res.headers.get('access-control-allow-origin'), null, `${key} 不得回 CORS 头`);
  }
  for (const origin of ['http://127.0.0.1:1234', 'http://localhost:9999', 'http://[::1]:1', undefined]) {
    const ok = await call(handlers, `GET ${API_PREFIX}/config`, { origin });
    assert.equal(ok.status, 200, `Origin=${String(origin)} 应放行`);
    assert.equal(ok.body.ok, true);
  }
  const post = await call(handlers, `POST ${API_PREFIX}/simulate`, { origin: 'http://127.0.0.1:1234', body: { text: '哈哈' } });
  assert.equal(post.status, 200);
});

test('assertSafeInput：路径类字段名 / .. / 反斜杠 / 盘符 / 绝对路径 / NUL 全拒，自由文本键豁免', () => {
  for (const bad of [{ file: 'x' }, { 'a\\b': 1 }, { posterPath: '/tmp/a.png' },
    { assetId: '../../etc/passwd' }, { assetId: 'C:\\tmp\\a.png' }, { assetId: '/etc/passwd' },
    { note2: 'x..y' }, { text: 'a\u0000b' }]) {
    assert.throws(() => assertSafeInput(bad), { code: Code.BAD_INPUT }, `${JSON.stringify(bad)} 应被拒`);
  }
  assert.doesNotThrow(() => assertSafeInput({ text: '他说的……/..' }), 'text 是自由文本，值不查路径');
  assert.doesNotThrow(() => assertSafeInput({ query: '../../etc', note: 'a\\b' }), 'query/note 同样是自由文本');
  assert.doesNotThrow(() => assertSafeInput({ assetId: 'abcd-1234', limit: 5, flags: { capture: true } }));
  assert.throws(() => assertSafeInput({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }), { code: Code.BAD_INPUT }, '嵌套过深');
});

test('GET asset / POST asset：带 file、path、反斜杠、.. 的入参 400，且从不触达 service', async () => {
  const { service, calls } = fakeService();
  const handlers = createExpressionHandlers(service);
  for (const query of ['file=../../etc/passwd', 'assetId=../../x', 'assetId=a%5Cb', 'assetId=%2Fetc%2Fpasswd', '']) {
    const { status, body } = await call(handlers, `GET ${API_PREFIX}/asset`, { query });
    assert.equal(status, 400, `GET asset?${query} 应 400`);
    assert.equal(body.error.code, Code.BAD_INPUT);
    assert.ok(body.error.message.length > 3, '错误 message 必须可读');
  }
  for (const body of [{ path: '/tmp/x.png', action: 'approve' }, { file: 'x.png', action: 'approve' },
    { assetId: 'a\\b', action: 'approve' }, { assetId: '../../x', action: 'approve' },
    { assetId: 'asset-1', action: 'explode' }, { assetId: 'asset-1', action: 'edit-card' }, 'not-json']) {
    const res = await call(handlers, `POST ${API_PREFIX}/asset`, { body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应 400`);
    assert.equal(res.body.error.code, Code.BAD_INPUT);
  }
  assert.equal(countOf(calls, 'getAsset') + countOf(calls, 'assetAction'), 0, '非法入参必须在触碰 service 之前被拒');

  const ok = await call(handlers, `POST ${API_PREFIX}/asset`, { body: { assetId: 'asset-1', action: 'approve', note: '看起来不错' } });
  assert.equal(ok.status, 200);
  assert.deepEqual({ ok: ok.body.ok, assetId: ok.body.assetId, action: ok.body.action }, { ok: true, assetId: 'asset-1', action: 'approve' });
  const arg = calls.find(c => c.name === 'assetAction').args[0];
  assert.equal(arg.card, null);
  assert.equal(arg.note, '看起来不错');

  const edit = await call(handlers, `POST ${API_PREFIX}/asset`, { body: { assetId: 'asset-1', action: 'edit-card', card: { literal: '笑死', intents: ['humor'] } } });
  assert.equal(edit.status, 200);
  assert.equal(calls.filter(c => c.name === 'assetAction').pop().args[0].card.intents[0], 'humor');
});

test('GET thumb：不存在 404；越界 403 且一个字节都不回；非法 mime / 无 root 一律拒绝', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expression-studio-thumb-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'home', 'expression', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const inside = path.join(assets, 'a.png');
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(inside, png);
  fs.writeFileSync(outside, png);
  const thumb = fakeService({ thumbBytes: () => ({ ok: true, bytes: png, mime: 'image/png', filePath: inside }) });

  const notFound = await call(createExpressionHandlers(fakeService().service, { assetsRoot: assets }), `GET ${API_PREFIX}/thumb`, { query: 'assetId=asset-1' });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, Code.NOT_FOUND);

  // 越界用的是一条**真实存在**的目录外文件：realpath 能过，越界判定必须拦住。
  const escaping = await call(createExpressionHandlers(
    fakeService({ thumbBytes: () => ({ ok: true, bytes: png, mime: 'image/png', filePath: outside }) }).service,
    { assetsRoot: assets },
  ), `GET ${API_PREFIX}/thumb`, { query: 'assetId=asset-1' });
  assert.equal(escaping.status, 403);
  assert.equal(escaping.body.error.code, Code.PATH_OUTSIDE, '越界必须是 path-outside-root');
  assert.equal(escaping.contentType.includes('image'), false, '被拒时不得返回图片字节');

  const served = await createExpressionHandlers(thumb.service, { assetsRoot: assets })[`GET ${API_PREFIX}/thumb`](
    requestOf(`GET ${API_PREFIX}/thumb`, { query: 'assetId=asset-1' }),
  );
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);

  const badMime = await call(createExpressionHandlers(
    fakeService({ thumbBytes: () => ({ ok: true, bytes: png, mime: 'text/html', filePath: inside }) }).service,
    { assetsRoot: assets },
  ), `GET ${API_PREFIX}/thumb`, { query: 'assetId=asset-1' });
  assert.equal(badMime.status, 403);
  assert.equal(badMime.body.error.code, Code.FORBIDDEN);

  // 没有可校验的 root 时，宁可拒绝也不返回未校验字节。
  const noRoot = await call(createExpressionHandlers(thumb.service), `GET ${API_PREFIX}/thumb`, { query: 'assetId=asset-1' });
  assert.equal(noRoot.status, 400);
  assert.equal(noRoot.body.error.code, Code.PATH_UNVERIFIED);
});

test('GET thumb：隔离区素材默认 403，allowQuarantine=1 时只放行隔离目录里的文件', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expression-studio-quarantine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'home', 'expression', 'assets');
  const quarantine = path.join(root, 'home', 'expression', 'quarantine');
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(quarantine, { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const qfile = path.join(quarantine, 'q.png');
  fs.writeFileSync(qfile, png);

  const { service } = fakeService({
    thumbBytes: (assetId, options) => (options?.allowQuarantine === true
      ? { ok: true, bytes: png, mime: 'image/png', filePath: qfile }
      : { ok: false, error: { code: 'quarantined', message: '这个素材在隔离区。' } }),
  });
  service.paths = { assets, quarantine };
  const handlers = createExpressionHandlers(service, { assetsRoot: assets, quarantineRoot: quarantine });

  const denied = await call(handlers, `GET ${API_PREFIX}/thumb`, { query: 'assetId=asset-1' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, Code.QUARANTINED);
  const allowed = await call(handlers, `GET ${API_PREFIX}/thumb`, { query: 'assetId=asset-1&allowQuarantine=1' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.contentType, 'image/png');
});

test('POST config：非法值 400 且带上游 reason；合法 patch / 整对象 200；service 抛错映射成 500', async () => {
  const { service, calls } = fakeService();
  const handlers = createExpressionHandlers(service);

  const bad = await call(handlers, `POST ${API_PREFIX}/config`, { body: { patch: { delivery: { maxPerTurn: 5 } } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, Code.CONFIG_INVALID, 'handler 把上游失败统一改写成 config-invalid');
  assert.match(bad.body.error.message, /maxPerTurn/, '必须带上游校验器的原话');
  assert.equal(countOf(calls, 'saveConfig'), 1);

  for (const body of [{ patch: { delivery: { maxPerTurn: 2 } } }, { delivery: { enabled: false } }]) {
    const good = await call(handlers, `POST ${API_PREFIX}/config`, { body });
    assert.equal(good.status, 200);
    assert.equal(good.body.ok, true);
  }
  const arrayBody = await call(handlers, `POST ${API_PREFIX}/config`, { body: '[]' });
  assert.equal(arrayBody.status, 400, '数组不是合法 body');
  const pathy = await call(handlers, `POST ${API_PREFIX}/config`, { body: { patch: { delivery: { file: 'x' } } } });
  assert.equal(pathy.status, 400, 'config patch 里也不许出现路径类字段');

  const boom = await call(createExpressionHandlers(fakeService({ getConfig: () => { throw new Error('库炸了'); } }).service), `GET ${API_PREFIX}/config`);
  assert.equal(boom.status, 500);
  assert.equal(boom.body.error.code, Code.UPSTREAM);
  assert.equal(String(boom.body.error.message).includes('at '), false, '不得泄漏堆栈');
});

test('POST simulate：恒定 sending:false，即使 service 谎称 sending:true；空片段 400', async () => {
  const { service, calls } = fakeService({ simulate: () => ({ ok: true, sending: true, decision: { send: true }, candidates: [{ assetId: 'asset-1' }] }) });
  const handlers = createExpressionHandlers(service);
  const res = await call(handlers, `POST ${API_PREFIX}/simulate`, { body: { text: '哈哈哈', isGroup: false, limit: 3 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sending, false, '模拟不投递：handler 自己写死 false');
  assert.equal(res.body.decision.send, true, '假设口径照实透出');
  assert.equal(res.body.candidates.length, 1);
  const arg = calls.find(c => c.name === 'simulate').args[0];
  assert.deepEqual({ text: arg.text, limit: arg.limit, isGroup: arg.isGroup }, { text: '哈哈哈', limit: 3, isGroup: false });

  const empty = await call(handlers, `POST ${API_PREFIX}/simulate`, { body: { text: '   ' } });
  assert.equal(empty.status, 400);
  assert.equal(countOf(calls, 'simulate'), 1, '空片段不得到达 service');

  const pathy = await call(handlers, `POST ${API_PREFIX}/simulate`, { body: { text: 'x', posterPath: '/tmp/a.png' } });
  assert.equal(pathy.status, 400);
});

test('GET assets / asset / sources / deliveries / metrics：信封与 clamp，绝不回文件路径', async () => {
  const { service, calls } = fakeService();
  const handlers = createExpressionHandlers(service);

  const list = await call(handlers, `GET ${API_PREFIX}/assets`, { query: 'limit=999&offset=-1&sort=oldest' });
  assert.equal(list.status, 200);
  assert.deepEqual({ ok: list.body.ok, limit: list.body.limit, offset: list.body.offset, total: list.body.total }, { ok: true, limit: 200, offset: 0, total: 1 });
  assert.equal(list.body.items[0].assetId, 'asset-1');
  assert.equal(list.body.items[0].filePath, undefined, '素材行不得携带 filePath');
  const listArg = calls.find(c => c.name === 'listAssets').args[0];
  assert.equal(listArg.sort, 'oldest');

  const detail = await call(handlers, `GET ${API_PREFIX}/asset`, { query: 'assetId=asset-1' });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.asset.assetId, 'asset-1');
  assert.equal(detail.body.card.literal, '笑死');
  assert.equal(detail.body.sources[0].label, '群 100');
  assert.deepEqual(detail.body.scopeLabels, ['群 100']);
  assert.equal(detail.body.deliveries.length, 1);

  const gone = await call(createExpressionHandlers(fakeService({ getAsset: () => ({ ok: false, error: { code: Code.NOT_FOUND, message: '没有这个素材。' } }) }).service),
    `GET ${API_PREFIX}/asset`, { query: 'assetId=nope' });
  assert.equal(gone.status, 404);

  const sources = await call(handlers, `GET ${API_PREFIX}/sources`);
  assert.equal(sources.status, 200);
  assert.equal(sources.body.items.length, 2);
  assert.equal(sources.body.items[1].label, '公共精选');

  const deliveries = await call(handlers, `GET ${API_PREFIX}/deliveries`, { query: 'limit=1&status=confirmed' });
  assert.equal(deliveries.body.items.length, 1);
  assert.equal(deliveries.body.total, 3);
  const deliveriesArg = calls.find(c => c.name === 'listDeliveries').args[0];
  assert.deepEqual({ limit: deliveriesArg.limit, status: deliveriesArg.status }, { limit: 1, status: 'confirmed' });

  const metrics = await call(handlers, `GET ${API_PREFIX}/metrics`, { query: 'windowHours=999999' });
  assert.equal(metrics.body.windowHours, 24 * 365, 'windowHours 必须被 clamp');
  assert.equal(calls.find(c => c.name === 'metrics').args[0].windowHours, 24 * 365);
  const badQuery = await call(handlers, `GET ${API_PREFIX}/metrics`, { query: 'file=../../etc/passwd' });
  assert.equal(badQuery.status, 400, 'query 里的路径类字段同样被拒');
});

test('POST grants：kind / chatId 校验；群撤销默认连素材一起清（keepAssets 可保留）', async () => {
  const { service, calls } = fakeService();
  const handlers = createExpressionHandlers(service);
  for (const body of [{ kind: 'dm', chatId: 1 }, { kind: 'group', chatId: 0 }, { kind: 'group', chatId: 'abc' }, { kind: 'group' }]) {
    const bad = await call(handlers, `POST ${API_PREFIX}/grants`, { body });
    assert.equal(bad.status, 400, `${JSON.stringify(body)} 应 400`);
    assert.equal(bad.body.error.code, Code.BAD_INPUT);
  }
  assert.equal(countOf(calls, 'grantScope'), 0, '非法授权不得到达 service');

  const peer = await call(handlers, `POST ${API_PREFIX}/grants`, { body: { kind: 'peer', chatId: 20001, granted: true } });
  assert.deepEqual({ kind: peer.body.kind, granted: peer.body.granted }, { kind: 'peer', granted: true });
  assert.deepEqual(calls.find(c => c.name === 'grantScope').args[0].flags, { approved: true });

  const revoke = await call(handlers, `POST ${API_PREFIX}/grants`, { body: { kind: 'group', chatId: 30001, granted: false } });
  assert.equal(revoke.status, 200);
  assert.equal(calls.filter(c => c.name === 'grantScope').pop().args[0].flags.deleteAssets, true, '撤销群授权默认要连素材一起清');
  const keep = await call(handlers, `POST ${API_PREFIX}/grants`, { body: { kind: 'group', chatId: 30001, granted: false, keepAssets: true } });
  assert.equal(keep.status, 200);
  assert.equal(calls.filter(c => c.name === 'grantScope').pop().args[0].flags.deleteAssets, false);

  const grant = await call(handlers, `POST ${API_PREFIX}/grants`, { body: { kind: 'group', chatId: 30001, granted: true, capture: true, store: true } });
  assert.equal(grant.body.granted, true);
  assert.deepEqual(calls.filter(c => c.name === 'grantScope').pop().args[0].flags, { capture: true, store: true, use: false, deleteAssets: false });
});

test('只读 GET 不碰任何写路径（/page /config /assets /sources /deliveries /metrics 全 200）', async () => {
  const { service, calls } = fakeService();
  const handlers = createExpressionHandlers(service);
  for (const name of ['page', 'config', 'assets', 'sources', 'deliveries', 'metrics']) {
    const res = await call(handlers, `GET ${API_PREFIX}/${name}`);
    assert.equal(res.status, 200, `GET /${name} 应 200`);
    assert.equal(res.body.ok, true);
  }
  const readOnly = new Set(['getConfig', 'listAssets', 'listSources', 'listDeliveries', 'metrics']);
  for (const entry of calls) assert.ok(readOnly.has(entry.name), `GET 只应调用只读方法，实际调了 ${entry.name}`);
});
