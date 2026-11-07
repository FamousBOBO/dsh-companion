/**
 * `apply()` 的宿主接线离线测试：**从 ctx 取发送器，不靠补丁配置**。
 *
 * 这一层是原审计里最硬的缺口：`qqSender` 从来不注入，于是打开 `delivery.enabled` 也只是
 * 「闸门开着、没有出口」。这里用假 ctx（假工具表 + 假 fetch）证明四件事：
 *   1. `apply` 能从 `ctx.tools` 把 `qq_message` / `qq_sticker` 的执行器接成 `qqSender`；
 *   2. 接上之后 `expression_reply` **不再**报 `sender-unavailable`（而是走到第二/第三道闸）；
 *   3. 接上之后入站端口 `observe()` **不再**报 `ingest-not-injected`，`offers()` 与入库同口径；
 *   4. 拿不到工具表时仍照常注册四个工具、照常发端口，但如实报「没有出口」。
 *
 * 仍然零网络、零 QQ：工具是假的、fetch 是假的；「真发到 QQ」只能由操作者显式触发，
 * 不在离线测试的证词范围内（docs/07-verification-status.md）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORT_SYMBOL, apply, resetServiceForTests } from '../src/index.mjs';
import { saveConfig } from '../src/config.mjs';
import { currentToolAgent } from '../src/host-wiring.mjs';
import { privateScope } from '../src/scopes.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
const OWNER = '1000000001';
const CLOCK = 1_700_000_000_000;

/** 假工具表：形状对齐 `dsh-tools` 的 ToolRuntime（`get` / `execute` / `register` 都在）。 */
function fakeTools({ reply = () => ({ isError: false, value: { message_id: 1 } }) } = {}) {
  const calls = [];
  const registered = [];
  return {
    calls,
    registered,
    get: name => (name === 'qq_message' || name === 'qq_sticker' ? { name } : undefined),
    execute: async exec => { calls.push(exec); return reply(exec); },
    register: tool => { registered.push(tool); },
  };
}

/** 假 fetch：只回一张最小 PNG 的字节（给采集 http 用；测试里不触发真实下载）。 */
function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const bytes = Buffer.alloc(33, 0x11);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(2, 16);
    bytes.writeUInt32BE(2, 20);
    return {
      ok: true, status: 200,
      headers: { get: name => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => bytes,
      body: null,
    };
  };
  return { calls, fetchImpl };
}

/** 临时数据根（含 `home/expression`、`home/companion`）。 */
function tempRoot(prefix = 'exp-apply-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'home', 'expression'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home', 'companion'), { recursive: true });
  return dir;
}

/** 删临时目录：采集管道可能在后台还在写文件，Windows 下要给几次重试。 */
function rmTemp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 40 }); } catch { /* 测试目录，删不掉就算了 */ }
}

function writeModuleConfig(dir, overrides = {}) {
  const file = path.join(dir, 'home', 'expression', 'config.json');
  const saved = saveConfig({
    file, dataRoot: dir,
    raw: { enabled: true, delivery: { enabled: false }, capture: { ownerPrivate: true }, ...overrides },
  });
  assert.equal(saved.ok, true, `配置要写得进去：${saved.error ?? ''}`);
  return file;
}

const ENV_ON = extra => ({
  DSH_COMPANION_MODULES_EXPRESSION: '1',
  DSH_COMPANION_SUITE_ROOT: SUITE_ROOT,
  DSH_COMPANION_OWNER_ID: OWNER,
  ...extra,
});

/**
 * 每个用例一个干净的进程级状态：`singleton` 会被 `apply` 跨调用复用（生产上是对的），
 * 测试里必须复位，否则第二组配置根本读不进来。
 */
async function scenario({ dir, tools = fakeTools(), fetchImpl = fakeFetch().fetchImpl, ctxExtra = {} }, body) {
  writeModuleConfig(dir, ctxExtra.moduleConfig ?? {});
  resetServiceForTests();
  const saved = { ...process.env };
  Object.assign(process.env, { DSH_COMPANION_DATA_DIR: dir });
  try {
    const ctx = tools === null
      ? { provide() {}, effect() {}, on() {} }
      : { tools, provide() {}, effect() {}, on() {} };
    const events = [];
    const dispose = await apply(ctx, {
      env: ENV_ON({ DSH_COMPANION_DATA_DIR: dir }),
      ...(fetchImpl === null ? {} : { fetchImpl }),
    });
    return await body({ dispose, tools, ctx });
  } finally {
    resetServiceForTests();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmTemp(dir);
  }
}

test('apply 从 ctx 接上发送器：delivery 关着时报 delivery-disabled（不是 sender-unavailable）', async () => {
  const dir = tempRoot();
  await scenario({ dir, ctxExtra: { moduleConfig: { delivery: { enabled: false } } } }, async ({ dispose, tools }) => {
    assert.equal(typeof dispose, 'function');
    const reply = tools.registered.find(tool => tool.name === 'expression_reply');
    const out = JSON.parse(await reply.execute({ assetId: 'ast_abc123456', action: 'send', target: OWNER }, {}));
    assert.equal(out.ok, false);
    // 关键区别：发送器已经接上了，所以拦住它的是**第二道闸**，不是「没有出口」。
    assert.equal(out.reasonCode, 'delivery-disabled', `实际原因码：${out.reasonCode}`);
    dispose();
    assert.equal(process[PORT_SYMBOL], undefined);
  });
});

test('接上发送器 + 打开 delivery：expression_reply 真的走到 qq_sticker，agent 与地址形状都对', async () => {
  const dir = tempRoot();
  const sent = [];
  const tools = fakeTools({ reply: exec => { sent.push(exec); return { isError: false, value: { message_id: 9001 } }; } });
  await scenario({ dir, tools, ctxExtra: { moduleConfig: { delivery: { enabled: true } } } }, async ({ dispose }) => {
    const service = process[PORT_SYMBOL]?.service;
    assert.ok(service, '端口应该在');

    // 直接进库一条素材（离线、不走网络），并**挂到真实的主人私聊作用域**：
    // 作用域键由模块自己的盐算出来，所以不能用编的字符串。
    const bytes = Buffer.alloc(33, 0x22);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(4, 16);
    bytes.writeUInt32BE(4, 20);
    const scope = privateScope({ kind: 'owner_private', chatId: Number(OWNER), salt: service.salt });
    const received = service.library.receive({
      bytes, format: { ext: 'png', mime: 'image/png', kind: 'image' }, width: 4, height: 4, moderationState: 'approved',
    });
    assert.equal(received.ok, true);
    const registered = service.library.register({
      assetId: received.assetId,
      sources: [{ originScope: scope, sourceMessageHash: 'm-1' }],
      visibility: [{ scope, approval: 'approved' }],
    });
    assert.equal(registered.ok, true, `素材要挂到 ${scope} 上`);

    const reply = tools.registered.find(tool => tool.name === 'expression_reply');
    const agent = { id: `qq-dm-${OWNER}`, session: { kind: 'dm', chatId: Number(OWNER) } };
    const out = JSON.parse(await reply.execute(
      { assetId: received.assetId, action: 'send', isGroup: false, target: OWNER },
      { agent },
    ));
    // ① 发送器确实接上了（不然会是 sender-unavailable）
    assert.notEqual(out.reasonCode, 'sender-unavailable', `发送器必须已经接上（实际：${out.reasonCode}）`);
    // ② 真的发生了一次工具调用（不是只算了个计划）
    assert.equal(sent.length, 1, `应当刚好发一次，实际 ${sent.length}；模块回话=${JSON.stringify(out)}`);
    // ③ 走的是 qq_sticker 的 send 分支，地址形状与工具契约一致
    const call = sent[0];
    assert.equal(call.name, 'qq_sticker', '发图走 qq_sticker');
    assert.equal(call.arguments.action, 'send');
    assert.equal(call.arguments.isGroup, false);
    assert.equal(call.arguments.target, Number(OWNER));
    assert.match(String(call.arguments.file), /expression-out/, '只从 home/media/expression-out 里发图');
    // ④ agent 透传：群/私聊路由与守卫都靠它
    assert.deepEqual(call.agent, agent, 'agent 必须透传到工具调用');
    // ⑤ 工具调用必须带可用的 AbortSignal（运行时直接读 `.aborted`）
    assert.equal(typeof call.signal?.aborted, 'boolean', '没有 signal 的话 dsh-tools 会直接抛 TypeError');

    dispose();
    assert.equal(currentToolAgent(), undefined, '工具执行结束后不留 agent');
  });
});

test('apply 接上采集：observe() 不再报 ingest-not-injected；offers() 与入库同口径', async () => {
  const dir = tempRoot();
  await scenario({ dir, ctxExtra: { moduleConfig: { delivery: { enabled: false }, capture: { ownerPrivate: true } } } }, async ({ dispose }) => {
    const port = process[PORT_SYMBOL];
    assert.equal(typeof port.observe, 'function');
    assert.equal(typeof port.offers, 'function', '端口必须提供 offers（通道先问这句）');

    const noImage = port.observe({ kind: 'dm', chatId: Number(OWNER), images: [] });
    assert.equal(noImage.ok, false);
    assert.equal(noImage.reasonCode, 'no-image-url');
    assert.notEqual(noImage.reasonCode, 'ingest-not-injected', '采集管线必须已经接上');

    const withImage = port.observe({
      kind: 'dm', chatId: Number(OWNER), messageId: 1, at: CLOCK,
      images: [{ url: 'https://cdn.example.com/a.png' }],
    });
    assert.equal(withImage.ok, true, '有图且已授权 ⇒ 入队');
    assert.equal(withImage.queued, 1);

    // offers 与入库同一个口径：主人私聊开；陌生人私聊关；没授权的群关。
    assert.equal(port.offers({ kind: 'dm', chatId: Number(OWNER) }), true);
    assert.equal(port.offers({ kind: 'dm', chatId: 2000000002 }), false);
    assert.equal(port.offers({ kind: 'group', chatId: 123456 }), false, '群没授权就不收');
    dispose();
  });
});

test('ctx 没有工具表时：apply 照常注册四个工具、照常发端口，但如实报「发送器没接上」', async () => {
  const dir = tempRoot();
  writeModuleConfig(dir, { delivery: { enabled: true } });
  resetServiceForTests();
  const saved = { ...process.env };
  const registered = [];
  // 复现「只有 register、没有 execute」的真实情形：工具面在，发送面不在。
  const ctx = { tools: { register: tool => registered.push(tool) }, provide() {}, effect() {}, on() {} };
  try {
    Object.assign(process.env, { DSH_COMPANION_DATA_DIR: dir });
    const dispose = await apply(ctx, { env: ENV_ON({ DSH_COMPANION_DATA_DIR: dir }) });
    assert.equal(registered.length, 4, '工具照旧注册（缺发送器不影响工具面）');
    assert.equal(typeof process[PORT_SYMBOL]?.observe, 'function', '端口照旧发布');
    const reply = registered.find(tool => tool.name === 'expression_reply');
    const out = JSON.parse(await reply.execute({ assetId: 'ast_abc123456', action: 'send', target: OWNER }, {}));
    assert.equal(out.ok, false);
    assert.equal(out.reasonCode, 'sender-unavailable', `没有工具表就只能如实说没出口（实际：${out.reasonCode}）`);
    dispose();
  } finally {
    resetServiceForTests();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmTemp(dir);
  }
});
