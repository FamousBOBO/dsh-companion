// V2 配置：从「Bot API Key」改成「用户 refresh_token + 设备名」。
//
// 与 V1 的差别，逐条说清：
//
//   V1 `apiKeyEnv`          → V2 `credentialFile`（一个只含 refreshToken 的 JSON）
//                             或 `dbFile`（直接读 VoceChat 的 SQLite —— 默认走这条）
//   V1 `webhook.{bind,port,pathTokenEnv,maxBodyBytes,allowedSources}`
//                          → **整段删除**：没有入站 HTTP server 了
//   V1 `botUid`            → V2 `uid`（自己的用户 id）+ `deviceName`（refresh_token 的唯一键之一）
//   V1 `outbound.maxChars` → 保留（适配层切分仍需要）
//   V1 `queue.maxPending`  → 保留（虽然 SSE 侧不再需要入站队列，适配层的回合队列仍用）
//
// 新增 {sse, auth} 两段：
//   sse.reconnectBaseMs / sse.reconnectMaxMs / sse.idleTimeoutMs
//   auth.timeoutMs
//
// 安全默认仍然是「不配置 = 什么都不做」：`enabled: false`、`baseUrl: ''`。

const DEFAULTS = {
  enabled: false,
  baseUrl: '',
  uid: 0,
  deviceName: 'dsh-companion',
  // 首次连接以这个频道的最新 mid 为起点（不补播历史）。生产里就是主频道。
  seedChannel: 1,
  credentialFile: '',
  dbFile: '',
  auth: {
    timeoutMs: 15000,
  },
  sse: {
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30000,
    idleTimeoutMs: 120000,
  },
  outbound: {
    timeoutMs: 15000,
    maxChars: 4000,
  },
  queue: {
    maxPending: 200,
  },
};

function str(value, fallback = '') {
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? fallback : text;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function posInt(value, fallback) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i > 0 ? i : fallback;
}

function nonNegInt(value, fallback = 0) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i >= 0 ? i : fallback;
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes' || t === 'on') return true;
    if (t === 'false' || t === '0' || t === 'no' || t === 'off') return false;
  }
  return fallback;
}

/** `http://host:port` → `{ origin, host, port, secure }`, or null when unusable. */
export function parseBaseUrl(raw) {
  const text = str(raw);
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search || url.hash) return null;
  return {
    origin: url.origin,
    host: url.hostname,
    port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
    secure: url.protocol === 'https:',
  };
}

/**
 * Normalize a raw cordis `config` object.
 *
 * @param {object} raw
 * @param {object} [env]
 * @param {string} [defaultDataRoot] used to derive the default VoceChat db path
 * @returns {{config: object, problems: string[]}}
 */
export function resolveConfig(raw, env = process.env, { defaultDataRoot = '' } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const au = input.auth && typeof input.auth === 'object' ? input.auth : {};
  const ss = input.sse && typeof input.sse === 'object' ? input.sse : {};
  const ob = input.outbound && typeof input.outbound === 'object' ? input.outbound : {};
  const qu = input.queue && typeof input.queue === 'object' ? input.queue : {};

  const config = {
    enabled: bool(input.enabled, DEFAULTS.enabled),
    baseUrl: str(input.baseUrl, DEFAULTS.baseUrl),
    base: parseBaseUrl(input.baseUrl),
    uid: nonNegInt(input.uid, DEFAULTS.uid),
    deviceName: str(input.deviceName, DEFAULTS.deviceName),
    seedChannel: posInt(input.seedChannel, DEFAULTS.seedChannel),
    credentialFile: str(input.credentialFile, DEFAULTS.credentialFile),
    dbFile: str(input.dbFile, DEFAULTS.dbFile),
    auth: {
      timeoutMs: posInt(au.timeoutMs, DEFAULTS.auth.timeoutMs),
    },
    sse: {
      reconnectBaseMs: posInt(ss.reconnectBaseMs, DEFAULTS.sse.reconnectBaseMs),
      reconnectMaxMs: posInt(ss.reconnectMaxMs, DEFAULTS.sse.reconnectMaxMs),
      idleTimeoutMs: posInt(ss.idleTimeoutMs, DEFAULTS.sse.idleTimeoutMs),
    },
    outbound: {
      timeoutMs: posInt(ob.timeoutMs, DEFAULTS.outbound.timeoutMs),
      maxChars: posInt(ob.maxChars, DEFAULTS.outbound.maxChars),
    },
    queue: {
      maxPending: posInt(qu.maxPending, DEFAULTS.queue.maxPending),
    },
  };

  const problems = [];
  if (config.enabled) {
    if (!config.baseUrl) problems.push('baseUrl 为空：无法连接（配置里填 http://127.0.0.1:3009）');
    else if (!config.base) problems.push(`baseUrl 无法解析为纯 origin：${config.baseUrl}`);
    if (!config.uid) problems.push('uid 为 0：必须写明这个用户在 VoceChat 里的 id（本机 companion 是 4）');
    if (!config.credentialFile && !config.dbFile) {
      problems.push('credentialFile 与 dbFile 都为空：没有 refresh_token 来源，无法登录');
    }
    if (config.sse.reconnectMaxMs < config.sse.reconnectBaseMs) {
      problems.push('sse.reconnectMaxMs 小于 reconnectBaseMs：退避区间反了');
    }
  }

  return { config, problems };
}

export { DEFAULTS };
