// channel-vocechat — cordis plugin entry (V2: 用户身份 + SSE).
//
// 这个插件仍然**只做传输**：用户端点客户端、SSE 入站、事件归一化、落盘与幂等、一个发布端口。
// 它不认识会话、agent、房间键、人格、提示词、模型工具 —— 那些在陪伴插件侧。
//
// V1 → V2 的唯一架构变化：
//
//   V1  Bot（uid=2）+ 平台 POST 到本机 3011
//   V2  普通用户（uid=4）+ 插件主动连 `/api/user/events`
//
// 换来的（全部实测，见 evidence/user-protocol-test.json）：
//
//   - 不用开端口，不用管理员配 webhook_url
//   - `after_mid` 补播：断线期间的事件能补回来（Bot 侧是永久丢）
//   - 能读频道历史、频道成员、联系人（Bot 全 401）
//
// 换来的代价：
//
//   - access token 只活 5 分钟，必须自动续期
//   - refresh_token 唯一键是 `(uid, device)`：同一身份只能一个活跃会话
//   - 读别人资料 403：发送者只能显示 from_uid
//
// 挂载规则（与 V1 相同，每条都是因为违反过才成为规则）：
//
//   1. **失败不许拖垮宿主。** 一切都有守卫；读不到凭据也照常挂载、照常发布端口、如实解释自己。
//   2. **什么都不必需。** `inject: []`，没有依赖顺序可以搞错。
//   3. **先发布再启动。** 消费者在激活期间看到对象（和一句明确的「还没连上」），而不是 undefined。
//   4. **重新激活安全。** 宿主 reload 会重跑 `apply()`；单例保证一个进程只有一个 SSE 循环
//      和一个 store —— 第二个循环会把 cursor 打架，第二个 store 会重复落盘。
//   5. **`enabled: false` 就是惰性。** 不连接、不续期、不写盘。

import path from 'node:path';

import { resolveConfig, DEFAULTS } from './config.mjs';
import { createAuth } from './auth.mjs';
import { createUserApi } from './user-api.mjs';
import { createStore } from './store.mjs';
import { createSseClient } from './sse.mjs';
import { createPort } from './port.mjs';
import { createHealthProbe } from './health.mjs';
import { publishPort, describeKeys, PORT_NAME } from './publish.mjs';

export const name = 'channel-vocechat';
export const inject = [];
export const version = '0.2.0';

/** Process-local singleton: one SSE loop, one store, one published port. */
let singleton = null;

function note(text) {
  try { console.log(`[channel-vocechat] ${String(text).slice(0, 400)}`); } catch { /* ignore */ }
}

/**
 * 套件数据根（`.../data`）。
 * 顺序：`DSH_COMPANION_DATA_DIR` → `dirname(DSH_HOME)` → 模块相对回落。
 *
 * **必须与消费侧算出同一个字符串**，否则发布会成功但没人读得到（静默失败）。
 * `info()` 与 `diag/mount.json` 都留了两侧的键拼写，运行时可比对。
 */
export function resolveDataRoot({ env = process.env, moduleUrl = import.meta.url } = {}) {
  const explicit = String(env?.DSH_COMPANION_DATA_DIR ?? '').trim();
  if (explicit) return { dataRoot: path.resolve(explicit), source: 'env:DSH_COMPANION_DATA_DIR' };
  const home = String(env?.DSH_HOME ?? '').trim();
  if (home) return { dataRoot: path.dirname(path.resolve(home)), source: 'dirname(DSH_HOME)' };
  const here = path.dirname(new URL(moduleUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return { dataRoot: path.resolve(here, '..', '..', 'data'), source: 'module:../../data' };
}

/** 惰性端口：未启用时也发布一个形状正确的对象，只是每次调用都明确说「没启用」。 */
function inertPort(config, reason) {
  const fail = async () => { throw new Error(`channel-vocechat 未启用：${reason}`); };
  return {
    send: fail,
    subscribe: () => () => {},
    history: fail,
    channel: fail,
    contacts: fail,
    me: fail,
    status: async () => ({ ok: false, state: 'disabled', reasons: [reason], checkedAt: Date.now() }),
    info: () => ({
      uid: config?.uid ?? 0,
      deviceName: config?.deviceName ?? '',
      baseHost: null,
      auth: null,
      sse: { running: false, cursor: 0, counters: null },
      subscribers: 0,
      queueDepth: 0,
      seen: 0,
      reason,
    }),
  };
}

export function apply(ctx, rawConfig) {
  const { config, problems } = resolveConfig(rawConfig, process.env, {});
  const { dataRoot, source: rootSource } = resolveDataRoot({ env: process.env });
  const keys = describeKeys(dataRoot);

  if (!config.enabled) {
    publishPort({ root: dataRoot, service: inertPort(config, 'enabled=false'), ready: () => true, log: note });
    note(`disabled (enabled=false); dataRoot=${dataRoot} (${rootSource})`);
    return;
  }

  for (const problem of problems) note(`config: ${problem}`);

  // ── 单例：reload 时复用 ────────────────────────────────────────────────
  if (singleton) {
    note('re-activation: reusing the existing SSE loop and store');
    publishPort({ root: dataRoot, service: singleton.port.service, ready: () => true, log: note });
    return;
  }

  // ── 组装 ───────────────────────────────────────────────────────────────
  const store = createStore({ dataRoot });

  const auth = createAuth({
    baseUrl: config.baseUrl,
    uid: config.uid,
    // **这句是必需的。** 不传 deviceName 时数据库查询会退化成"取该 uid 最近更新的一行"，
    // 那可能是手机、也可能是浏览器 —— 拿错一行去 renew 会把那个客户端的凭据轮换掉并把它登出
    // （2026-11-17 实测：手机因此每请求 401）。传了它就只认自己那一行。
    deviceName: config.deviceName,
    credentialFile: config.credentialFile,
    dbFile: config.dbFile,
    timeoutMs: config.auth.timeoutMs,
    log: note,
  });

  const api = createUserApi({
    baseUrl: config.baseUrl,
    auth,
    timeoutMs: config.outbound.timeoutMs,
  });

  let port = null;

  const sse = createSseClient({
    baseUrl: config.baseUrl,
    auth,
    store,
    // 首次连接需要用 history 取当前最大 mid 作为起点，否则 after_mid=0 会补播整段历史。
    api,
    seedChannel: config.seedChannel,
    onEvent: (event) => {
      // 派发是 async（订阅者可能是回合循环），但 SSE 读循环不能等它 —— 等它就会把流堵住。
      // 所以用 void 并让 port.dispatch 自己串行化；失败已在 dispatch 内部记 gap。
      if (port) void port.dispatch(event);
    },
    reconnectBaseMs: config.sse.reconnectBaseMs,
    reconnectMaxMs: config.sse.reconnectMaxMs,
    idleTimeoutMs: config.sse.idleTimeoutMs,
    log: note,
  });

  const built = createPort({ api, store, sse, auth, config, log: note });
  port = built;
  const health = createHealthProbe({ api, sse, auth, enabled: true });
  port.service.status = health;

  const release = publishPort({
    root: dataRoot,
    service: port.service,
    ready: () => true,
    log: note,
  });

  store.writeDiag('mount', {
    version,
    enabled: config.enabled,
    baseHost: config.baseUrl,
    uid: config.uid,
    deviceName: config.deviceName,
    credentialSource: config.credentialFile || config.dbFile,
    dataRoot,
    rootSource,
    keys,
    problems,
  });

  note(`mounted: uid=${config.uid} device=${config.deviceName} base=${config.baseUrl} dataRoot=${dataRoot} (${rootSource})`);
  if (problems.length) note(`problems: ${problems.join(' | ')}`);

  // ── 启动（异步、有守卫）────────────────────────────────────────────────
  const startPromise = (async () => {
    try {
      const token = await auth.token();
      note(`auth ok (token ${token ? 'acquired' : 'missing'})`);
    } catch (error) {
      // 拿不到 token 不是致命错误：SSE 循环会在下一轮自己再试一次，
      // 而 `status()` 会如实报 degraded:no-access-token。
      note(`auth failed: ${String(error?.message ?? error).slice(0, 200)}`);
    }
    await sse.start().catch(error => {
      note(`sse loop exited: ${String(error?.message ?? error).slice(0, 200)}`);
    });
  })();

  singleton = {
    port,
    store,
    auth,
    api,
    sse,
    release,
    startPromise,
    dispose: async () => {
      await sse.stop().catch(() => {});
      await startPromise.catch(() => {});
      store.flush();
      release();
      singleton = null;
      note('disposed');
    },
  };

  // ── 卸载钩子 ───────────────────────────────────────────────────────────
  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('dispose', () => { void singleton?.dispose?.(); });
    }
  } catch { /* 不是致命 */ }

  note(`${PORT_NAME} published; keys=${keys.namespaced.length + keys.bare.length}`);
}

export { DEFAULTS };
