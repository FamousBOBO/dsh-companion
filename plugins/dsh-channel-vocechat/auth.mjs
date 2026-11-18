// 用户身份的认证层：一个 refresh_token，一对不断轮换的 token，一个续期单例。
//
// 实测事实（2026-11-17，evidence/user-protocol-test.json）：
//
//   - `/api/token/renew` 只校验 refresh_token，请求体里的 `token` 写什么都行。
//   - renew 会返回 **新的 token 和新的 refresh_token**，并且把新 refresh_token
//     **写回数据库的 `refresh_token` 表**。
//   - access token 只活 **300 秒**；refresh_token 活 864000000 秒（约 10000 天）。
//   - `refresh_token` 表唯一键是 `(uid, device)`：同一 device 重新登录会覆盖前一条，
//     也就是说**同一身份只能有一个活跃会话**。
//
// 由这些事实推出三条设计：
//
//   1. **不自存轮换值。** 数据库是权威；插件若自己存一份，一旦与库不一致两边都会失效。
//      默认从 `<dataRoot>/../../vocechat/vocechat-data/db/db.sqlite` 读，也可由 `credentialFile`
//      指定一个只含 refreshToken 的 JSON（服务器没装在本机时用）。
//   2. **续期单例。** 两个并发 renew 会互相把对方的 refresh 作废（DB 只留最后一条）。
//      所以所有续期走同一个 promise，并发调用者共享同一次结果。
//   3. **401 必须同步续期。** 401 时不重试原请求；先 renew，再重来。
//      否则只会拿到无限 401。

import fs from 'node:fs';

const DEFAULT_DB_HINT = 'vocechat-data/db/db.sqlite';

function readJsonOrNull(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 从 VoceChat 的 SQLite 里读 refresh_token。
 *
 * 用 `node:sqlite`（Node ≥ 24，本项目对 Node 的硬性要求就是 ≥ 24）。只读打开：绝不写别人的库。
 * 读不到就返回 null，由调用方决定走哪条降级。
 *
 * **必须按 device 过滤。** `refresh_token` 表的唯一键是 `(uid, device)`，同一个 uid 可以有好几行
 * （手机、浏览器、本插件、一次性取证脚本各一行）。原来的查询是
 * `where uid = ? order by updated_at desc limit 1` —— 它取的是"**最近**更新过的那一行"，
 * 也就是**最近登录/续期过的那个客户端**，不一定是本插件自己的。
 *
 * 这不是理论风险，2026-11-17 实测出过一次事故：主机上的验证脚本用同样的查询去取 uid=1 的凭据
 * 并 `/api/token/renew`，而 renew 会**轮换** refresh_token（旧的那份只能再撑一代宽限期）。
 * 脚本连跑几次，就把主人手机上那一代挤成了两代以前 → 手机之后每条请求 401，
 * 表现成"能进但不能发消息也不能改头像"。
 *
 * 指定了 `deviceName` 时只认那一行，取不到就**返回 null 并报出来**，而不是随便拿一行顶上：
 * 拿错一行会让两个客户端互相把对方的凭据转掉，症状是间歇性 401，比直接报错难查得多。
 *
 * 为什么是动态 import：`node:sqlite` 在纯 ESM 模块里只能 `await import()`；`require` 在这里不可达。
 */
async function readRefreshTokenFromDb(dbFile, uid, deviceName) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const device = String(deviceName ?? '').trim();
      const row = device
        ? db.prepare('select token from refresh_token where uid = ? and device = ? limit 1').get(Number(uid), device)
        : db.prepare('select token from refresh_token where uid = ? order by updated_at desc limit 1').get(Number(uid));
      return typeof row?.token === 'string' && row.token ? row.token : null;
    } finally {
      try { db.close(); } catch { /* closing a read-only handle cannot fail meaningfully */ }
    }
  } catch {
    return null;
  }
}

/**
 * @param {object} input
 * @param {string} input.baseUrl          `http://127.0.0.1:3009`
 * @param {number} input.uid              the user whose refresh token we use
 * @param {string} [input.deviceName]     VoceChat device name; the DB row is matched on it
 * @param {string} [input.credentialFile] JSON with `{ refreshToken }`; overrides the DB
 * @param {string} [input.dbFile]         path to VoceChat's `db.sqlite`
 * @param {number} [input.timeoutMs]
 * @param {typeof fetch} [input.fetchImpl]
 * @param {(line: string) => void} [input.log]
 */
export function createAuth({
  baseUrl,
  uid,
  deviceName = '',
  credentialFile = '',
  dbFile = '',
  timeoutMs = 15000,
  fetchImpl = null,
  log = null,
} = {}) {
  const origin = String(baseUrl ?? '').replace(/\/+$/, '');
  const doFetch = fetchImpl ?? globalThis.fetch;
  const say = message => {
    if (typeof log !== 'function') return;
    try { log(message); } catch { /* logging must never break auth */ }
  };

  /** The refresh token we last used successfully. Re-read from disk only when absent. */
  let refreshToken = '';
  let accessToken = '';
  let expiresAt = 0;
  /** In-flight renewal, so concurrent callers share one request (see design note 2). */
  let renewal = null;

  const stats = { renewals: 0, failures: 0, readFromDb: 0, readFromFile: 0, sourceReloads: 0 };

  /** Load a refresh token: credential file first (explicit), then the VoceChat database. */
  async function loadRefreshToken() {
    if (refreshToken) return refreshToken;

    const file = String(credentialFile ?? '').trim();
    if (file) {
      const parsed = readJsonOrNull(file);
      const fromFile = typeof parsed?.refreshToken === 'string' ? parsed.refreshToken.trim() : '';
      if (fromFile) {
        refreshToken = fromFile;
        stats.readFromFile += 1;
        return refreshToken;
      }
      say(`[vocechat-auth] credentialFile 里没有 refreshToken：${file}`);
    }

    const db = String(dbFile ?? '').trim();
    if (db) {
      const fromDb = await readRefreshTokenFromDb(db, uid, deviceName);
      if (fromDb) {
        refreshToken = fromDb;
        stats.readFromDb += 1;
        return refreshToken;
      }
      say(`[vocechat-auth] 数据库里没有 uid=${uid} 的 refresh_token：${db}`);
    }

    return '';
  }

  /**
   * One renewal attempt. Never runs concurrently with itself.
   *
   * `fromSource` 只是日志用：`true` 表示这一次是在「缓存被拒、已重新读源」之后的第二次尝试。
   */
  async function renewAttempt(fromSource) {
    const source = await loadRefreshToken();
    if (!source) {
      throw new AuthError('no-refresh-token', '没有可用的 refresh_token（数据库与 credentialFile 都没读到）');
    }
    if (!origin) throw new AuthError('not-configured', 'baseUrl 未配置');
    if (fromSource) say('[vocechat-auth] 用刚读到的 refresh_token 重试续期');

    let response;
    try {
      response = await doFetch(`${origin}/api/token/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The old access token is not validated by renew (measured); sending a placeholder
        // documents that we know it can be expired.
        body: JSON.stringify({ token: accessToken || 'x', refresh_token: source }),
      });
    } catch (error) {
      stats.failures += 1;
      throw new AuthError('network', `续期网络错误：${String(error?.message ?? error).slice(0, 120)}`, { cause: error });
    }

    if (!response.ok) {
      stats.failures += 1;
      const body = await safeText(response);
      throw new AuthError(
        response.status === 401 ? 'refresh-token-rejected' : 'renew-failed',
        `续期失败 ${response.status}${body ? `：${body.slice(0, 120)}` : ''}`,
        { status: response.status, body },
      );
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch {
      stats.failures += 1;
      throw new AuthError('bad-response', '续期返回的不是 JSON');
    }
    if (typeof parsed?.token !== 'string' || !parsed.token) {
      stats.failures += 1;
      throw new AuthError('bad-response', '续期返回缺少 token');
    }

    accessToken = parsed.token;
    // Keep the newest refresh token; also try to persist it when we have a file to write.
    if (typeof parsed.refresh_token === 'string' && parsed.refresh_token) {
      refreshToken = parsed.refresh_token;
      persistRefreshToken(parsed.refresh_token);
    }
    // Renew with a 5-minute lifetime; treat it as valid for 80% of the announced window so a
    // request in flight never races the expiry.
    const seconds = Number(parsed.expired_in);
    const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : 300;
    expiresAt = Date.now() + Math.floor(lifetime * 0.8) * 1000;
    stats.renewals += 1;
    say(`[vocechat-auth] renewed (expired_in=${lifetime}s, valid until ${new Date(expiresAt).toISOString()})`);
    return accessToken;
  }

  /**
   * One renewal, with one **source reload** on a rejected cached token.
   *
   * 为什么需要第二次尝试（2026-11-18 实测）：
   *   - `refreshToken` 是进程内缓存，只有第一次读源时才从数据库/credentialFile 取。
   *   - VoceChat 的 refresh_token 是**单链**的：同一 (uid, device) 只会最后一代有效，再往前一代立即
   *     401。任何第三方（验证脚本、`/api/token/login` 重新登录、手工 renew）把这条链往前推一代，
   *     本进程缓存的那份就成了"两代以前"，之后每次 renew 都是 401 —— 症状是能收不能发。
   *   - 解决它不需要人工重登：数据库里那一行是权威，重新读一次就拿到当前有效的一代。
   *     实测 `dsh-companion` 这一行被推到两代以前之后，重新读库并 renew 立刻 200。
   *
   * 只在 `refresh-token-rejected` 时重试，且只重试一次：网络错误/服务器 5xx 重读源没有意义，
   * 无限重试则会把一次明确的失败变成一把锁。
   */
  async function renewOnce() {
    try {
      return await renewAttempt(false);
    } catch (error) {
      const reloadable = error instanceof AuthError
        && error.code === 'refresh-token-rejected'
        && (String(dbFile ?? '').trim() !== '' || String(credentialFile ?? '').trim() !== '');
      if (!reloadable) throw error;
      // Drop the cached value so `loadRefreshToken()` actually re-reads the source.
      refreshToken = '';
      accessToken = '';
      expiresAt = 0;
      stats.sourceReloads = (stats.sourceReloads ?? 0) + 1;
      say('[vocechat-auth] 缓存的 refresh_token 被拒（401）→ 重新读源后再试一次');
      return await renewAttempt(true);
    }
  }

  /**
   * Write the rotated refresh token back into the credential file, when one was configured.
   * Best-effort: a failure here is reported, not fatal — the database still holds the truth.
   */
  function persistRefreshToken(token) {
    const file = String(credentialFile ?? '').trim();
    if (!file) return;
    try {
      const current = readJsonOrNull(file) ?? {};
      const next = { ...current, refreshToken: token, rotatedAt: new Date().toISOString() };
      fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      say(`[vocechat-auth] 无法回写 credentialFile：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  /** The current access token, renewing if absent or near expiry. Concurrent-safe. */
  async function token() {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    if (renewal) return renewal;
    renewal = renewOnce().finally(() => { renewal = null; });
    return renewal;
  }

  /** Force a renewal regardless of the local clock. Used on 401. */
  async function refreshNow() {
    if (renewal) return renewal;
    // Invalidate locally so `token()` cannot hand back the token that just failed.
    accessToken = '';
    expiresAt = 0;
    renewal = renewOnce().finally(() => { renewal = null; });
    return renewal;
  }

  return {
    token,
    refreshNow,
    /** Facts for `info()`. Never contains a token value. */
    describe() {
      return {
        uid: Number(uid) || 0,
        origin: origin || null,
        hasAccessToken: accessToken !== '',
        hasRefreshToken: refreshToken !== '',
        expiresAt: expiresAt || null,
        source: credentialFile ? 'credential-file' : (dbFile ? 'vocechat-db' : 'none'),
        stats: { ...stats },
      };
    },
  };
}

async function safeText(response) {
  try { return await response.text(); } catch { return ''; }
}

export class AuthError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = extra.status ?? null;
    this.body = extra.body ?? null;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

export { DEFAULT_DB_HINT };
