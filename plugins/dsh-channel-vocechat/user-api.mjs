// 用户端点客户端：把「一个普通用户能做的事」封装成几个动词，外加历史与成员。
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
// 文件的三个端点（2026-11-18 实测补齐，见 docs/35-media-capability-audit-20261118.md）：
//
//   POST /api/resource/file/prepare  application/json，body {"content_type":"image/png"} → 200 "<file_id>"
//   POST /api/resource/file/upload   multipart/form-data                     → 200 {path,size,hash,…}
//                                    chunk_data=<字节>  chunk_is_last=true  file_id=<uuid>
//   GET  /api/resource/file?file_path=<urlencoded path>                      → 200 原始字节
//
// 发媒体消息：**content-type 是 `vocechat/file`，body 是 `{"path":"…"}`**。
// 直接把字节当 body 发（`image/png`）会 415；在 markdown 里塞 `![](...)` 只会变成一段
// 带链接的文本，客户端不当图片。这两条都是实测结论，不是推断。
//
// 三条设计约束：
//
//   1. **401 时同步续期一次，然后重来。** 不重试原请求：token 只活 5 分钟，原地重试只会无限 401。
//   2. **只有一次续期重试。** 第二次 401 直接上抛 —— 那说明 refresh_token 也坏了，重试没意义。
//   3. **目标仍是判别式对象。** `{channel}` / `{user}`，沿用 V1 的形状，适配层不用改。
//
// 与 V1 的 `http-api.mjs` 的区别：多了 history/group/contacts/file，send 走用户端点而不是 Bot 端点。

const ACCEPTED = new Set(['text/plain', 'text/markdown']);

/**
 * 媒体消息的 content-type。单独一个常量而不是并进 `ACCEPTED`：文本走 `send()`，
 * 媒体走 `sendFile()`，两条路的参数与失败模式完全不同，混在一个白名单里只会让
 * "传了 path 但走了文本通道"这种错误在运行时才暴露。
 */
const FILE_CONTENT_TYPE = 'vocechat/file';

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
   *
   * `raw` 是最低层的逃生口：媒体上传要用 multipart（`FormData` 必须由运行时自己写
   * boundary，我们不能也不该手写 `content-type`）。除此之外的路径都走上面三种显式形状，
   * 免得"随便塞个 body"变成默认行为。
   *
   * @param {string} method
   * @param {string} path
   * @param {{text?: string|null, contentType?: string|null, json?: unknown, raw?: {body: unknown, headers?: object}|null}} [options]
   */
  async function request(method, path, { text = null, contentType = null, json = undefined, raw = null } = {}) {
    if (!origin) throw new VoceChatApiError('not-configured', 'baseUrl 未配置');

    const attempt = async () => {
      const token = await auth.token();
      const headers = { 'x-api-key': token };
      let body;
      if (raw) {
        Object.assign(headers, raw.headers ?? {});
        body = raw.body;
      } else if (json !== undefined) {
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
      // 媒体上传比普通请求慢得多（一张几 MB 的图要真的走完磁盘与网络），
      // 所以允许调用方给一个独立的超时，没给就沿用默认。
      const effectiveTimeout = Number(raw?.timeoutMs) > 0 ? Number(raw.timeoutMs) : timeoutMs;
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);
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
          aborted ? `请求超时（${effectiveTimeout}ms）：${method} ${path}` : `网络错误：${method} ${path}`,
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

  /**
   * Upload one local file and get back the platform's `path` for it.
   *
   * 三步里的前两步（第三步是 `sendFile`）。三条实测约束都体现在代码里：
   *
   *   1. `prepare` 必须带 `content-type: application/json`，否则 400 "does not include the
   *      Content-Type header"。
   *   2. `file_id` **必须放进 multipart 表单**。放 query string 会得到 400 且 body 为空，
   *      什么都查不出来（这条踩过）。
   *   3. 字段名是 `chunk_data`（不是 `file`），并且 `chunk_is_last` 要显式给 `"true"`，
   *      否则 400 `parse multipart error: field chunk_data is required`。
   *   4. `prepare` 的 body 要带 `content_type`。传 `{}` 也能 200，但服务器会把文件记成
   *      `application/octet-stream`，图片在客户端变成一个"要下载的附件" ——
   *      同一个 png 两版实测对比过（见 docs/35 的复查记录）。
   *
   * @param {Buffer|Uint8Array|string} bytes 文件内容
   * @param {{filename?: string, mime?: string, timeoutMs?: number}} [options]
   * @returns {Promise<{path: string, size: number, hash: string|null, mime: string}>}
   */
  async function uploadFile(bytes, { filename = 'file', mime = 'application/octet-stream', timeoutMs = 120000 } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(Buffer.from(bytes ?? ''));
    if (data.byteLength === 0) throw new VoceChatApiError('empty-file', '文件为空，平台会拒绝');

    // 1. prepare
    //
    // `content_type` 必须在这里给：`prepare` body 传 `{}` 也能 200，但那样服务器把这条
    // 文件记成 `application/octet-stream`，客户端于是把它渲染成一个"要下载的附件"
    // 而不是图片 —— 实测对比过（同一个 png，`prepare {}` → octet-stream，
    // `prepare {content_type:"image/png"}` → image/png + 宽高）。传 Blob 的 type 不够，
    // 平台只看 prepare 里这一句。
    const prepared = await request('POST', '/api/resource/file/prepare', { json: { content_type: mime } });
    const fileId = String(prepared.body ?? '').trim().replace(/^"|"$/g, '');
    if (fileId === '') throw new VoceChatApiError('bad-response', 'prepare 没有返回 file_id');

    // 2. upload —— FormData 让运行时自己写 boundary，这里绝不能手动设 content-type
    const form = new FormData();
    form.append('chunk_data', new Blob([data], { type: mime }), filename);
    form.append('chunk_is_last', 'true');
    form.append('file_id', fileId);
    const uploaded = await request('POST', '/api/resource/file/upload', { raw: { body: form, timeoutMs } });

    let meta;
    try {
      meta = JSON.parse(uploaded.body);
    } catch {
      throw new VoceChatApiError('bad-response', 'upload 返回的不是 JSON');
    }
    const path = typeof meta?.path === 'string' ? meta.path.trim() : '';
    if (path === '') throw new VoceChatApiError('bad-response', 'upload 没有返回 path');

    return {
      path,
      size: Number(meta.size) || data.byteLength,
      hash: typeof meta.hash === 'string' ? meta.hash : null,
      mime,
      // 图片会带回真实尺寸；语音/普通文件没有这一段，保持 null 而不是编 0。
      width: Number(meta?.image_properties?.width) || null,
      height: Number(meta?.image_properties?.height) || null,
    };
  }

  /**
   * Send one already-uploaded file as a media message.
   *
   * body 必须是 `{"path": "…"}` 且 content-type 是 `vocechat/file` —— 这是实测出的唯一
   * 正确形态（裸字节 415，markdown 链接只是文本）。
   *
   * @param {{channel?: number, user?: number}} target
   * @param {string} filePath `uploadFile()` 返回的 path
   */
  async function sendFile(target, filePath) {
    const t = targetOf(target);
    if (!t) throw new VoceChatApiError('bad-target', '目标必须是 {channel:n} 或 {user:n}（id ≥ 1）');
    const path = String(filePath ?? '').trim();
    if (path === '') throw new VoceChatApiError('empty-path', '缺少已上传文件的 path');
    const url = t.kind === 'channel' ? `/api/group/${t.id}/send` : `/api/user/${t.id}/send`;
    const { body } = await request('POST', url, {
      text: JSON.stringify({ path }),
      contentType: FILE_CONTENT_TYPE,
    });
    const trimmed = String(body ?? '').trim();
    if (trimmed === '') return { mid: null };
    const asNumber = Number(trimmed.replace(/^"|"$/g, ''));
    return { mid: Number.isFinite(asNumber) ? asNumber : null };
  }

  /**
   * Download a file the platform holds.
   *
   * 参数名是 `file_path`，不是 `path` —— 用 `path` 会得到
   * `400 failed to parse parameter \`file_path\`: Type "string" expects an input`（实测）。
   */
  async function downloadFile(filePath, { timeoutMs = 120000, maxBytes = 32 * 1024 * 1024 } = {}) {
    const path = String(filePath ?? '').trim();
    if (path === '') throw new VoceChatApiError('empty-path', '缺少要下载的 file_path');
    const url = `/api/resource/file?file_path=${encodeURIComponent(path)}`;
    // 二进制不能用上面的 `readBody()`（它按 text 读），所以这里直接拿 response 的字节。
    const token = await auth.token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await doFetch(`${origin}${url}`, {
        method: 'GET',
        headers: { 'x-api-key': token },
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new VoceChatApiError(
        aborted ? 'timeout' : 'network',
        aborted ? `下载超时（${timeoutMs}ms）` : `下载网络错误：${path}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const body = await readBody(response);
      throw new VoceChatApiError(
        codeForStatus(response.status),
        `下载失败 ${response.status}${body ? `：${body.slice(0, 120)}` : ''}`,
        { status: response.status, body },
      );
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new VoceChatApiError('too-large', `文件 ${declared} 字节，超过上限 ${maxBytes}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new VoceChatApiError('too-large', `文件 ${buffer.byteLength} 字节，超过上限 ${maxBytes}`);
    }
    return {
      bytes: buffer,
      mime: String(response.headers.get('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream',
      size: buffer.byteLength,
    };
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
    uploadFile,
    sendFile,
    downloadFile,
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

export { ACCEPTED as ACCEPTED_CONTENT_TYPES, FILE_CONTENT_TYPE, targetOf, codeForStatus };
