/**
 * host-wiring.mjs 的离线测试（补注入线路）。
 *
 * 这些用例证明的是**接线本身**，不是「真能发到 QQ」：
 *   - 发送器调的是宿主工具（`tools.execute`），参数形状与 `qq_message` / `qq_sticker` 对齐；
 *   - 工具报错 / 返回 `ok:false` / 返回 `message_id` 三种结果各映射成什么；
 *   - 没有工具表、没有 fetch、没有 identity 时**降级为「这一路没有」**，不抛、不假装；
 *   - `offers()` 与入库用的是同一个作用域判定（未授权的私聊不会被说成「收」）；
 *   - 入站适配把一张消息里的每张图各入队一次，且**同步返回**（不 await 下载）。
 *
 * 全程零网络、零 QQ：http 是假的，tools 也是假的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TOOL_AGENT, createHostWiring, createIngestBridge, createIngestHttp, createOffers,
  createOwnerCheck, createQqSender, readOwner, withToolAgent,
} from '../src/host-wiring.mjs';
import { openExpressionDb } from '../src/db.mjs';
import { createLibrary } from '../src/library.mjs';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.mjs';

const CLOCK = 1_700_000_000_000;
const SALT = 'salt-for-tests';
const OWNER_ID = '1000000001';

function makePng(width = 2, height = 2, extra = 0) {
  const buffer = Buffer.alloc(33 + extra, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** 假 http：记录调用，永不发请求；返回值模仿 security.createGuardedHttp 的形状。 */
function fakeHttp(bytes = makePng()) {
  const calls = [];
  return {
    calls,
    get: async (url, options = {}) => {
      calls.push({ url: String(url), maxBytes: options.maxBytes });
      return { ok: true, status: 200, bytes, mime: 'image/png', finalUrl: String(url), hops: [String(url)] };
    },
  };
}

/**
 * 假工具表：`get(name)` 返回一个占位定义，`execute(exec)` 记录调用并回放预设结果。
 * 形状对齐 `dsh-tools` 的 `ToolRuntime`：`execute` 收到的是 `{callId, name, arguments, agent?, parent?, signal?}`，
 * 返回的是 `{isError:false, value}` / `{isError:true, error:{message}}`（不是抛异常）。
 */
function fakeTools({ names = ['qq_message', 'qq_sticker'], reply = () => ({ isError: false, value: { message_id: 1 } }) } = {}) {
  const calls = [];
  return {
    calls,
    get: name => (names.includes(name) ? { name } : undefined),
    execute: async exec => {
      calls.push(exec);
      return reply(exec);
    },
  };
}

function tmpDir(prefix = 'exp-wiring-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 建一套真库 + 真图库（`ingest` 只认真实现，不认桩）。 */
function harness({ configOverrides = {} } = {}) {
  const dir = tmpDir();
  const db = openExpressionDb({ file: ':memory:', now: () => CLOCK });
  const library = createLibrary({ db, assetsDir: path.join(dir, 'assets'), now: () => CLOCK });
  const { config } = normalizeConfig({ ...DEFAULT_CONFIG, ...configOverrides });
  return { dir, db, library, config, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ── 主人身份 ────────────────────────────────────────────────────────────────────

test('identity.json 决定主人：只有主人的私聊算 owner，群聊一律不算', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'home', 'companion'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'home', 'companion', 'identity.json'), JSON.stringify({ owner: { id: OWNER_ID } }), 'utf8');

    assert.deepEqual(readOwner({ dataRoot: dir, env: {} }), { id: OWNER_ID, platform: '' });
    const isOwner = createOwnerCheck({ dataRoot: dir, env: {} });
    assert.equal(isOwner({ chatId: OWNER_ID, isGroup: false }), true);
    assert.equal(isOwner({ chatId: '1000000002', isGroup: false }), false, '别人私聊不是主人');
    assert.equal(isOwner({ chatId: OWNER_ID, isGroup: true }), false, '群里即使是主人号也不算（群是公共场合）');
    assert.equal(isOwner({}), false, '空入参不认');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没有身份文件 / 文件坏掉 / 环境变量覆盖：都不抛，只如实给出结果', () => {
  const dir = tmpDir();
  try {
    assert.equal(readOwner({ dataRoot: dir, env: {} }), null, '文件不存在 ⇒ null');
    const isOwner = createOwnerCheck({ dataRoot: dir, env: {} });
    assert.equal(isOwner({ chatId: OWNER_ID }), false, '读不到主人就不要认主人');

    fs.mkdirSync(path.join(dir, 'home', 'companion'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'home', 'companion', 'identity.json'), '{ not json', 'utf8');
    assert.equal(readOwner({ dataRoot: dir, env: {} }), null, '坏文件 ⇒ null（不是崩）');

    fs.writeFileSync(path.join(dir, 'home', 'companion', 'identity.json'), JSON.stringify({ owner: {} }), 'utf8');
    assert.equal(readOwner({ dataRoot: dir, env: {} }), null, '缺 owner.id ⇒ null');

    fs.writeFileSync(path.join(dir, 'home', 'companion', 'identity.json'), JSON.stringify({ owner: { id: OWNER_ID } }), 'utf8');
    assert.equal(readOwner({ dataRoot: dir, env: { DSH_COMPANION_OWNER_ID: '999' } }).id, '999', '环境变量优先');
    assert.equal(createOwnerCheck({ dataRoot: dir, env: { DSH_COMPANION_OWNER_ID: '999' } })({ chatId: '999' }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 发送器 ──────────────────────────────────────────────────────────────────────

test('没有工具表 / 工具表缺必需方法：发送器返回 null（调用方据此报 sender-unavailable）', () => {
  assert.equal(createQqSender({ tools: null }), null);
  assert.equal(createQqSender({ tools: { get() {} } }), null, '缺 execute 不算能用');
  assert.equal(createQqSender({ tools: { execute() {} } }), null, '缺 get 不算能用');
});

test('工具名在**发送那一刻**按作用域解析：这次会话里看不到就如实报 tool-not-visible', async () => {
  const tools = fakeTools({ names: ['qq_send_group_notice'] });
  const sender = createQqSender({ tools });

  // 发送器本身还在（工具表可用），但两个名字都不在这个作用域里 ⇒ 这一次不发，并说清原因。
  const out = await sender.sendText({ kind: 'dm', target: '1000000001', text: 'x' }, {});
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tool-not-visible');
  assert.match(sender.counters.lastError, /qq_message\|qq_send_text/);
  assert.equal(tools.calls.length, 0, '看不到工具就一次也不调用');
});

test('作用域里只有旧名时用旧名：qq_send_text 也能发（不把能用的判成不能用）', async () => {
  // QQ 工具挂在 preset 作用域；不带 scope 的 get() 只看全局层，所以必须按 agent 再问一次。
  const calls = [];
  const scoped = {
    calls,
    get: (name, agent) => (agent?.id === 'qq-dm-1000000001' && name === 'qq_send_text' ? { name } : undefined),
    execute: async exec => { calls.push(exec); return { isError: false, value: { message_id: 1 } }; },
  };
  const sender = createQqSender({ tools: scoped });
  const agent = { id: 'qq-dm-1000000001' };
  const out = await withToolAgent(agent, () => sender.sendText({ kind: 'dm', target: '1000000001', text: 'x' }));
  assert.deepEqual(out, { ok: true, messageId: 1 });
  assert.equal(calls[0].name, 'qq_send_text');
  assert.deepEqual(calls[0].agent, agent);
});

test('sendText 走 qq_message 的 send 分支：参数形状与工具契约一致，结果映射成 messageId', async () => {
  const tools = fakeTools({ reply: () => ({ isError: false, value: { message_id: 4242 } }) });
  const sender = createQqSender({ tools });
  const out = await sender.sendText({ kind: 'dm', target: '1000000001', text: '在。' });

  assert.deepEqual(out, { ok: true, messageId: 4242 });
  assert.equal(tools.calls.length, 1);
  const call = tools.calls[0];
  assert.equal(call.name, 'qq_message');
  assert.deepEqual(call.arguments, { action: 'send', isGroup: false, target: 1000000001, text: '在。' });
  assert.equal(typeof call.callId, 'string');
  assert.notEqual(call.parent, undefined, '标记成嵌套派发（ptc 模式下模型直呼才被折叠）');

  const group = await sender.sendText({ kind: 'group', target: '123456', text: 'x' });
  assert.deepEqual(group, { ok: true, messageId: 4242 });
  assert.equal(tools.calls[1].arguments.isGroup, true, '群聊 → isGroup:true');
  assert.equal(tools.calls[1].arguments.target, 123456, 'target 一律数值化（工具声明的是 number）');
});

test('sendSticker 走 qq_sticker 的 send 分支：只送文件路径，不送字节', async () => {
  const tools = fakeTools({ reply: () => ({ isError: false, value: { message_id: 7 } }) });
  const sender = createQqSender({ tools });
  const out = await sender.sendSticker({ kind: 'group', target: '123456', file: 'C:\\stage\\a.png', assetId: 'ast_abc123456' });

  assert.deepEqual(out, { ok: true, messageId: 7 });
  const call = tools.calls[0];
  assert.equal(call.name, 'qq_sticker');
  assert.deepEqual(call.arguments, { action: 'send', isGroup: true, target: 123456, file: 'C:\\stage\\a.png' });
  assert.equal(JSON.stringify(call.arguments).includes('assetId'), false, '工具的入参里没有 assetId 这一项');
});

test('投递层的 target 两种形态都认；认不出的地址直接失败（绝不发成 NaN）', async () => {
  const tools = fakeTools();
  const sender = createQqSender({ tools });
  // 投递层内部传的是 `{kind, id}`；工具要的是一个 QQ 号。
  await sender.sendText({ kind: 'dm', target: { kind: 'dm', id: '1000000001' }, text: '一' });
  assert.equal(tools.calls[0].arguments.target, 1000000001, '对象形态要取出 id');
  await sender.sendText({ kind: 'group', target: { kind: 'group', chatId: 123456 }, text: '二' });
  assert.equal(tools.calls[1].arguments.target, 123456, '也认 chatId');

  for (const bad of ['', 'abc', 0, -1, null, undefined, {}, { kind: 'dm' }]) {
    const out = await sender.sendText({ kind: 'dm', target: bad, text: 'x' });
    assert.equal(out.ok, false, `非法地址应失败：${JSON.stringify(bad)}`);
    assert.equal(out.code, 'target-invalid');
  }
  assert.equal(tools.calls.length, 2, '非法地址一次都没调用工具（不产生任何外发）');
  assert.equal(sender.counters.failures >= 1, true, '失败要计数，别静默');
});

test('工具失败三态：isError ⇒ tool-error；ok:false ⇒ 透传 code；没有 message_id 也算发出去', async () => {
  const failing = fakeTools({ reply: () => ({ isError: true, error: { message: '群边界拒绝：这个群没授权' } }) });
  const out1 = await createQqSender({ tools: failing }).sendText({ kind: 'group', target: '1', text: 'x' });
  assert.equal(out1.ok, false);
  assert.equal(out1.code, 'tool-error');
  assert.match(out1.message, /群边界拒绝/);
  assert.equal(failing.calls.length, 1, '被拒也是一次真实调用（调用发生了才可能被拒）');

  const refused = fakeTools({ reply: () => ({ isError: false, value: { ok: false, code: 'window-unreachable', message: '窗口没连上' } }) });
  const out2 = await createQqSender({ tools: refused }).sendText({ kind: 'dm', target: '2', text: 'x' });
  assert.equal(out2.ok, false);
  assert.equal(out2.code, 'window-unreachable');

  const quiet = fakeTools({ reply: () => ({ isError: false, value: {} }) });
  const out3 = await createQqSender({ tools: quiet }).sendText({ kind: 'dm', target: '3', text: 'x' });
  assert.deepEqual(out3, { ok: true, status: 'sent' });
});

test('execute 抛异常 ⇒ sender-threw，且不向外扩散（投递层永远收到结构化结果）', async () => {
  const tools = { get: () => ({ name: 'qq_message' }), execute: async () => { throw new Error('运行时内部炸了'); } };
  const sender = createQqSender({ tools });
  const out = await sender.sendText({ kind: 'dm', target: '1', text: 'x' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sender-threw');
  assert.match(out.message, /运行时内部炸了/);
  assert.equal(sender.counters.calls, 1);
  assert.equal(sender.counters.failures, 1);
});

test('只合并面工具（qq_send_text / qq_send_emoji）也能接上，参数不加 action', async () => {
  const tools = fakeTools({ names: ['qq_send_text', 'qq_send_emoji'] });
  const sender = createQqSender({ tools });
  await sender.sendText({ kind: 'dm', target: '9', text: 'hi' });
  await sender.sendSticker({ kind: 'dm', target: '9', file: '/tmp/a.png' });
  assert.equal(tools.calls[0].name, 'qq_send_text');
  assert.deepEqual(tools.calls[0].arguments, { isGroup: false, target: 9, text: 'hi' });
  assert.equal(tools.calls[1].name, 'qq_send_emoji');
  assert.deepEqual(tools.calls[1].arguments, { isGroup: false, target: 9, file: '/tmp/a.png' });
});

test('发送器把「谁在发」带进工具调用：agent 从这里透传，两次调用 callId 不同', async () => {
  const tools = fakeTools();
  const sender = createQqSender({ tools });
  const agent = { id: 'qq-dm-1000000001', session: { kind: 'dm', chatId: 1000000001 } };

  await withToolAgent(agent, async () => {
    assert.equal(TOOL_AGENT.getStore(), agent, '执行期间能读到 agent');
    await sender.sendText({ kind: 'dm', target: '1000000001', text: '一' });
    await sender.sendText({ kind: 'dm', target: '1000000001', text: '二' });
  });
  assert.equal(TOOL_AGENT.getStore(), undefined, '出了作用域就没了');

  assert.deepEqual(tools.calls[0].agent, agent);
  assert.deepEqual(tools.calls[1].agent, agent);
  assert.notEqual(tools.calls[0].callId, tools.calls[1].callId, '两段发送不能被当成同一次调度');
});

// ── 采集 http + 入站适配 ────────────────────────────────────────────────────────

test('createIngestHttp：没有 fetch 就是 null；有就给一个只暴露 get 的受限实现', () => {
  assert.equal(createIngestHttp({ fetchImpl: null }), null);
  const http = createIngestHttp({ fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), body: null, arrayBuffer: async () => new ArrayBuffer(0) }) });
  assert.equal(typeof http.get, 'function');
  assert.equal(Object.keys(http).join(','), 'get', '只暴露 get：采集侧没有别的出口');
});

test('入站适配：一条消息里的每张图各入队一次，且立即返回（不等下载）', async () => {
  const env = harness({ configOverrides: { capture: { ...DEFAULT_CONFIG.capture, ownerPrivate: true } } });
  try {
    // 两张图给**不同字节**：同一个字节会被物理去重成 1 条素材，那样就看不出「每张都入队」。
    const http = fakeHttp();
    let n = 0;
    const distinct = {
      calls: http.calls,
      get: async (url, options = {}) => {
        n += 1;
        const width = 2 + n; // 立刻定下宽度：异步回调里再读 `n` 会读到后面那张图的值
        const response = await http.get(url, options);
        return { ...response, bytes: makePng(width, 2) };
      },
    };
    const bridge = createIngestBridge({
      db: env.db, library: env.library, config: env.config, http: distinct,
      salt: SALT, now: () => CLOCK,
      isOwnerFor: ({ chatId }) => String(chatId) === OWNER_ID,
    });
    assert.ok(bridge, '真库 + 真图库 + 假 http ⇒ 管道建得起来');

    const first = bridge.observe({
      kind: 'dm', chatId: Number(OWNER_ID), messageId: 1001, at: CLOCK,
      images: [{ url: 'https://cdn.example.com/a.png' }, { url: 'https://cdn.example.com/b.png' }],
    });
    // `stickers: 0` 是这次新增的那个字段：普通图片消息没有表情段（有的话单独走一条路）。
    assert.deepEqual(first, { ok: true, queued: 2, stickers: 0 });
    assert.equal(typeof first.then, 'undefined', 'observe 是同步的：拿回来的是结果，不是 promise');
    assert.equal(bridge.counters.observed, 1);
    assert.equal(env.library.stats().assets, 0, '返回时还没入库（下载是后面的事）');

    // 让微任务跑完，再看真实落库（轮询而不是死等固定毫秒：落库是异步的，测试不该赌时序）。
    for (let i = 0; i < 40 && env.library.stats().assets < 2; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(http.calls.length, 2, '两张图各下载一次');
    assert.equal(env.library.stats().assets, 2, '两张图都入库了');
  } finally {
    env.cleanup();
  }
});

test('入站适配：没有图片 URL / chatId 非法 ⇒ 不入队（不是「收了但没存」）', () => {
  const env = harness();
  try {
    const bridge = createIngestBridge({ db: env.db, library: env.library, config: env.config, http: fakeHttp(), salt: SALT, now: () => CLOCK });
    assert.deepEqual(bridge.observe({ kind: 'dm', chatId: 1, images: [] }), { ok: false, queued: 0, reasonCode: 'no-image-url' });
    assert.deepEqual(bridge.observe({ kind: 'dm', chatId: 0, images: [{ url: 'https://x/y.png' }] }), { ok: false, queued: 0, reasonCode: 'no-image-url' });
    assert.equal(bridge.counters.dropped, 2);
  } finally {
    env.cleanup();
  }
});

test('入站适配：缺盐 / 缺 http / 缺库时返回 null（宁可不挂，也不半挂）', () => {
  const env = harness();
  try {
    assert.equal(createIngestBridge({ db: env.db, library: env.library, config: env.config, http: fakeHttp(), salt: '', now: () => CLOCK }), null);
    assert.equal(createIngestBridge({ db: env.db, library: env.library, config: env.config, http: null, salt: SALT, now: () => CLOCK }), null);
    assert.equal(createIngestBridge({ db: null, library: env.library, config: env.config, http: fakeHttp(), salt: SALT, now: () => CLOCK }), null);
    assert.equal(createIngestBridge({ db: env.db, library: null, config: env.config, http: fakeHttp(), salt: SALT, now: () => CLOCK }), null);
  } finally {
    env.cleanup();
  }
});

// ── offers：先问「要不要」，与入库同一个判定 ───────────────────────────────────

test('offers 与入库同一个判定：主人私聊开、陌生人私聊关、未授权群关', () => {
  const { config } = normalizeConfig({
    ...DEFAULT_CONFIG,
    capture: { ...DEFAULT_CONFIG.capture, ownerPrivate: true, privatePeers: 'opt_in', groupEnabled: true, groups: [{ chatId: 123456, use: true }] },
  });
  const isOwnerFor = ({ chatId, isGroup }) => isGroup !== true && String(chatId) === OWNER_ID;
  const offers = createOffers({ config, salt: SALT, isOwnerFor });

  assert.equal(offers({ kind: 'dm', chatId: OWNER_ID }), true, '主人私聊：收');
  assert.equal(offers({ kind: 'dm', chatId: '1000000002' }), false, '陌生人私聊未授权：不收');
  assert.equal(offers({ kind: 'group', chatId: 123456 }), false, 'group.capture 没开就只是「可用」不是「收」');
  assert.equal(offers({ kind: 'group', chatId: 999 }), false, '没授权的群：不收');
  assert.equal(offers({}), false, '空入参：不收');
});

// ── 总装 ────────────────────────────────────────────────────────────────────────

test('createHostWiring：能接的全接上，四路都报「有」，且不改动默认关闭的 delivery', () => {
  const dir = tmpDir();
  const env = harness();
  try {
    fs.mkdirSync(path.join(dir, 'home', 'companion'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'home', 'companion', 'identity.json'), JSON.stringify({ owner: { id: OWNER_ID } }), 'utf8');
    const tools = fakeTools();
    const wiring = createHostWiring({
      ctx: { tools }, dataRoot: dir, db: env.db, library: env.library, config: env.config,
      salt: SALT, env: {}, now: () => CLOCK,
    });
    assert.deepEqual(wiring.wired, { sender: true, http: true, ingest: true, owner: true });
    assert.equal(typeof wiring.qqSender.sendText, 'function');
    assert.equal(typeof wiring.qqSender.sendSticker, 'function');
    assert.equal(typeof wiring.ingest, 'function');
    assert.equal(typeof wiring.offers, 'function');
    assert.equal(wiring.isOwner({ chatId: OWNER_ID }), true);
    assert.deepEqual(wiring.notes, [], '什么都没缺就不该有告警');
  } finally {
    env.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHostWiring：ctx.get("tools") 也能取到工具表（Cordis 照这一路给服务）', () => {
  const env = harness();
  try {
    const tools = fakeTools();
    const wiring = createHostWiring({
      ctx: { get: name => (name === 'tools' ? tools : undefined) },
      dataRoot: tmpDir(), db: env.db, library: env.library, config: env.config, salt: SALT, env: {},
    });
    assert.equal(typeof wiring.qqSender.sendText, 'function');
  } finally {
    env.cleanup();
  }
});

test('createHostWiring：没有 ctx 时发送器与主人判定为空，但采集不依赖 ctx（照常接上）', () => {
  const env = harness();
  try {
    const dir = tmpDir();
    const wiring = createHostWiring({ ctx: {}, dataRoot: dir, db: env.db, library: env.library, config: env.config, salt: SALT, env: {} });
    // 采集侧只用传入的 db/library/config/http，与 ctx 无关；拿不到工具表也不影响它。
    assert.deepEqual(wiring.wired, { sender: false, http: true, ingest: true, owner: false });
    assert.equal(wiring.qqSender, undefined, '没有发送器就别给一个假的');
    assert.equal(typeof wiring.ingest, 'function', '采集管线仍然可用');
    assert.equal(wiring.isOwner({ chatId: 1 }), false);
    assert.ok(wiring.notes.length >= 2, '缺什么必须说出来');
    assert.ok(wiring.notes.some(line => /没有可用的 QQ 发送器/.test(line)));
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    env.cleanup();
  }
});

test('createHostWiring：ctx.tools 抛异常时只记一条 note，其余照常', () => {
  const env = harness();
  try {
    const dir = tmpDir();
    const wiring = createHostWiring({
      ctx: { get: () => { throw new Error('服务没装'); } },
      dataRoot: dir, db: env.db, library: env.library, config: env.config, salt: SALT, env: {},
    });
    assert.ok(wiring.notes.some(line => /读 ctx.tools 失败/.test(line)));
    assert.equal(wiring.wired.sender, false);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    env.cleanup();
  }
});
