// 用户端点客户端：把「一个普通用户能做的事」封装成四个动词，外加历史与成员。
//
// 实测契约（2026-11-17，VoceChat 0.5.40，evidence/user-protocol-test.json）：
//
//   POST /api/group/{gid}/send      Content-Type 即消息类型，body 即原文  → 200, body = mid
//   POST /api/user/{uid}/send       同上
//   GET  /api/user/me               自己的资料                            → 200
//   GET  /api/group/{gid}           频道详情 + members + owner            → 200（**必须先是成员**，否则 403）
//   GET  /api/group/{gid}/history   频道历史                              → 200
//   GET  /api/user/{uid}/history    私聊历史                              → 200
//   GET  /api/user/contacts         联系人                                → 200
//   GET  /api/user/{other}          读别人资料                            → **403**（设计如此，不是 bug）
//
// 三条设计约束：
//
//   1. **401 时同步续期一次，然后重来。** 不重试原请求：token 只活 5 分钟，原地重试只会无限 401。
//   2. **只有一次续期重试。** 第二次 401 直接上抛 —— 那说明 refresh_token 也坏了，重试没意义。
//   3. **目标仍是判别式对象。** `{channel}` / `{user}`，沿用 V1 的形状，适配层不用改。
//
// 与 V1 的 `http-api.mjs` 的区别：多了 history/group/contacts，send 走用户端点而不是 Bot 端点。

const ACCEPTED = new Set(['text/plain', 'text/markdown']);

export class VoceChatApiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'VoceChatApiError';
    this.code = code;
    this.status = extra.status ?? null;
    this.body = extra.body ?? null;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

function codeForStatus(status) {
  if (status === 400) return 'payload';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 413) return 'too-large';
  if (status === 415) return 'unsupported-content-type';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return `http-${status}`;
}

async function readBody(response) {
  try {
    const text = await response.text();
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** `{channel:|user:}` → `{kind, id}`, or null. Ids are 1-based. */
function targetOf(target) {
  const t = target && typeof target === 'object' ? target : {};
  if (t.channel !== undefined && t.channel !== null) {
    const id = Number(t.channel);
    return Number.isInteger(id) && id >= 1 ? { kind: 'channel', id } : null;
  }
  if (t.user !== undefined && t.user !== null) {
    const id = Number(t.user);
    return Number.isInteger(id) && id >= 1 ? { kind: 'user', id } : null;
  }
  return null;
}

/**
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {object} input.auth     createAuth() result — provides `token()` and `refreshNow()`
 * @param {number} [input.timeoutMs]
 * @param {typeof fetch} [input.fetchImpl]
 */
export function createUserApi({ baseUrl, auth, timeoutMs = 15000, fetchImpl = null } = {}) {
  const origin = String(baseUrl ?? '').replace(/\/+$/, '');
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new VoceChatApiError('no-fetch', '运行时没有 fetch');
  if (!auth || typeof auth.token !== 'function') throw new VoceChatApiError('no-auth', '缺少 auth');

  /**
   * One call with a bounded 401 recovery.
   * @param {string} method
   * @param {string} path
   * @param {{text?: string|null, contentType?: string|null, json?: unknown}} [options]
   */
  async function request(method, path, { text = null, contentType = null, json = undefined } = {}) {
    if (!origin) throw new VoceChatApiError('not-configured', 'baseUrl 未配置');

    const attempt = async () => {
      const token = await auth.token();
      const headers = { 'x-api-key': token };
      let body;
      if (json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (text !== null) {
        if (contentType) headers['content-type'] = contentType;
        body = text;
      } else if (contentType) {
        headers['content-type'] = contentType;
      } else {
        headers.accept = 'application/json';
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await doFetch(`${origin}${path}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        throw new VoceChatApiError(
          aborted ? 'timeout' : 'network',
          aborted ? `请求超时（${timeoutMs}ms）：${method} ${path}` : `网络错误：${method} ${path}`,
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
      }

      const responseBody = await readBody(response);
      if (!response.ok) {
        throw new VoceChatApiError(
          codeForStatus(response.status),
          `${method} ${path} → ${response.status}${responseBody ? `：${responseBody.slice(0, 160)}` : ''}`,
          { status: response.status, body: responseBody },
        );
      }
      return { status: response.status, body: responseBody };
    };

    try {
      return await attempt();
    } catch (error) {
      // Design note 1 & 2: renew once on 401, then retry once. Never loop.
      if (error instanceof VoceChatApiError && error.code === 'unauthorized') {
        await auth.refreshNow();
        return attempt();
      }
      throw error;
    }
  }

  /** Send one text message. Body is the raw text; the content type is the message type. */
  async function send(target, text, contentType = 'text/plain') {
    const t = targetOf(target);
    if (!t) throw new VoceChatApiError('bad-target', '目标必须是 {channel:n} 或 {user:n}（id ≥ 1）');
    if (!ACCEPTED.has(contentType)) {
      throw new VoceChatApiError('unsupported-content-type', `只接受 text/plain 与 text/markdown，收到 ${contentType}`);
    }
    const payload = String(text ?? '');
    if (payload.trim() === '') throw new VoceChatApiError('empty-text', '文本为空，平台会拒绝或发出空消息');

    const path = t.kind === 'channel' ? `/api/group/${t.id}/send` : `/api/user/${t.id}/send`;
    const { body } = await request('POST', path, { text: payload, contentType });

    const trimmed = String(body ?? '').trim();
    if (trimmed === '') return { mid: null };
    const asNumber = Number(trimmed.replace(/^"|"$/g, ''));
    return { mid: Number.isFinite(asNumber) ? asNumber : null };
  }

  /** History of a channel or DM. Returns the platform's array verbatim (newest first per measurement). */
  async function history(target, { limit = 30, before = null } = {}) {
    const t = targetOf(target);
    if (!t) throw new VoceChatApiError('bad-target', '目标必须是 {channel:n} 或 {user:n}');
    const n = Number(limit);
    const capped = Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 30;
    const path = t.kind === 'channel' ? `/api/group/${t.id}/history` : `/api/user/${t.id}/history`;
    const query = `?limit=${capped}${before === null ? '' : `&before=${Number(before)}`}`;
    const { body } = await request('GET', `${path}${query}`);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new VoceChatApiError('bad-response', `${path} 返回的不是 JSON`);
    }
    // A non-array body is a protocol surprise, not "no history". Returning [] would let the
    // adapter conclude "this conversation is empty" when the truth is "we did not understand the
    // answer" — the two need different responses, so this throws.
    if (!Array.isArray(parsed)) throw new VoceChatApiError('bad-response', `${path} 返回的不是 JSON 数组`);
    return parsed;
  }

  /** Channel detail: name, members, owner. Requires being a member (403 otherwise). */
  async function channel(gid) {
    const id = Number(gid);
    if (!Number.isInteger(id) || id < 1) throw new VoceChatApiError('bad-target', `gid 无效：${gid}`);
    const { body } = await request('GET', `/api/group/${id}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new VoceChatApiError('bad-response', 'GET /api/group/{gid} 返回的不是 JSON');
    }
  }

  /** Own profile. */
  async function me() {
    const { body } = await request('GET', '/api/user/me');
    try {
      return JSON.parse(body);
    } catch {
      throw new VoceChatApiError('bad-response', 'GET /api/user/me 返回的不是 JSON');
    }
  }

  /** Contacts. */
  async function contacts() {
    const { body } = await request('GET', '/api/user/contacts');
    try {
      const parsed = JSON.parse(body);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new VoceChatApiError('bad-response', 'GET /api/user/contacts 返回的不是 JSON');
    }
  }

  /** One harmless authenticated round trip. Never throws. */
  async function status() {
    const started = Date.now();
    try {
      const profile = await me();
      return {
        ok: true,
        uid: profile?.uid ?? null,
        name: profile?.name ?? null,
        isAdmin: profile?.is_admin === true,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof VoceChatApiError ? error.code : 'unknown',
        message: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
        latencyMs: Date.now() - started,
      };
    }
  }

  return {
    send,
    history,
    channel,
    me,
    contacts,
    status,
    describe() {
      return { origin: origin || null, timeoutMs };
    },
  };
}

export { ACCEPTED as ACCEPTED_CONTENT_TYPES, targetOf, codeForStatus };
