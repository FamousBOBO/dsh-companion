/**
 * Studio management API for the expression library — the route table only.
 *
 * This file contains **no library logic**: every call lands on an injected service facade
 * (`getConfig` / `saveConfig` / `listAssets` / `getAsset` / `assetAction` / `thumbBytes` /
 * `listSources` / `grantScope` / `listDeliveries` / `metrics` / `simulate`). Keeping the handlers
 * separate from the library is what lets the whole HTTP surface be tested offline with a fake
 * service, exactly like `companion-media/src/http-api.mjs`.
 *
 * Four safety rules are implemented here in code, not promised in a document:
 *
 *   1. **`assetId` is the only client-side identifier.** Every GET/POST input is scanned: an input
 *      name that mentions `path`/`file`, or a value carrying `..`, a backslash, a drive letter or
 *      a leading `/`, is refused with 400 `bad-input` before it can reach the service. Free-text
 *      keys (`text` / `query` / `note`) are exempt from the *value* scan (a chat snippet may
 *      legitimately contain "…"), but still may not carry a NUL byte.
 *   2. **`GET /thumb` re-validates the path.** The service returns the library's `file_path`
 *      together with the bytes; the handler takes `realpath` of it and refuses anything that is
 *      not inside the assets root (403 `thumb-path-outside-root`). A quarantined asset is only
 *      served when the caller passes `allowQuarantine=1` — and even then it may only come from
 *      the quarantine directory.
 *   3. **Every POST is an explicit action; no GET triggers a model call.** `GET` handlers only
 *      read. `/simulate` is the only endpoint that evaluates a decision, and it is read-only by
 *      contract: it returns a plan and `sending: false`, and the service has no way to deliver
 *      from it.
 *   4. **Origin is loopback-only and no CORS header is ever sent.** A cross-site `Origin` gets 403
 *      on every route, including `GET`.
 *
 * When the module is not enabled (no service was built), every route answers a readable
 * 「未启用」 instead of 500 — a page that opens onto "not enabled, here is the snippet" is
 * strictly better than one that opens onto a stack trace.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ENABLE_SNIPPET, pageDescriptor, API_PREFIX } from './ui-page.mjs';
import { DEFAULT_CONFIG, normalizeConfig } from './config.mjs';
import { describeScope } from './scopes.mjs';

export { API_PREFIX };

const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** The stable codes this surface produces. `statusFor` maps them to HTTP status. */
export const Code = Object.freeze({
  BAD_INPUT: 'expression-bad-input',
  NOT_FOUND: 'expression-not-found',
  DISABLED: 'expression-disabled',
  FORBIDDEN: 'expression-forbidden',
  QUARANTINED: 'expression-thumb-quarantined',
  PATH_UNVERIFIED: 'expression-thumb-path-unverified',
  PATH_OUTSIDE: 'expression-thumb-path-outside-root',
  CONFIG_INVALID: 'expression-config-invalid',
  UPSTREAM: 'expression-service-failed',
});

const STATUS_BY_CODE = new Map([
  [Code.BAD_INPUT, 400],
  [Code.CONFIG_INVALID, 400],
  [Code.DISABLED, 503],
  [Code.FORBIDDEN, 403],
  [Code.QUARANTINED, 403],
  [Code.PATH_UNVERIFIED, 400],
  [Code.PATH_OUTSIDE, 403],
  [Code.NOT_FOUND, 404],
]);

export class ExpressionError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ExpressionError';
    this.code = code;
    if (typeof status === 'number') this.status = status;
  }
}

const fail = (code, message) => new ExpressionError(code, message);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function originAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  return LOCAL_ORIGIN.test(String(origin).trim());
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Keys whose *value* is user content, not an identifier. Their values skip the path scan. */
const CONTENT_KEYS = new Set([
  'text', 'query', 'note', 'summary', 'reason',
  // 语义卡里的字面/意图/情绪等是**内容**：它们只落库与 FTS，永远不进文件系统。
  'literal', 'ocr', 'intents', 'emotions', 'tone', 'rhetoric', 'scenes', 'avoidwhen',
]);
const DRIVE_LETTER = /^[A-Za-z]:/;

function forbiddenName(name) {
  const key = String(name ?? '').toLowerCase();
  if (!key) return false;
  return key.includes('path') || key.includes('file') || key.includes('\\') || key === '.' || key === '..';
}

/**
 * Refuse any path-shaped input.
 *
 * Names are scanned everywhere (a body key called `file` is refused even when its value looks
 * innocent). Values are scanned except for the free-text keys above. The scan runs *before* the
 * service is touched, so nothing path-shaped can reach the filesystem at any depth.
 */
export function assertSafeInput(value, { name = '', allowContent = false, depth = 0 } = {}) {
  if (depth > 8) throw fail(Code.BAD_INPUT, '入参嵌套过深。');
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeInput(item, { name: `${name}[${index}]`, allowContent, depth: depth + 1 }));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenName(key)) throw fail(Code.BAD_INPUT, `入参不允许出现路径类字段：${key}。客户端只能传 assetId。`);
      assertSafeInput(item, { name: key, allowContent: CONTENT_KEYS.has(String(key).toLowerCase()), depth: depth + 1 });
    }
    return;
  }
  if (typeof value !== 'string') return;
  if (value.includes('\u0000')) throw fail(Code.BAD_INPUT, '入参包含非法字符。');
  if (allowContent) return;
  if (value.includes('..')) throw fail(Code.BAD_INPUT, `入参不允许包含「..」：${value.slice(0, 40)}。`);
  if (value.includes('\\')) throw fail(Code.BAD_INPUT, `入参不允许包含反斜杠：${value.slice(0, 40)}。`);
  if (DRIVE_LETTER.test(value)) throw fail(Code.BAD_INPUT, `入参不允许是盘符路径：${value.slice(0, 40)}。`);
  if (value.startsWith('/')) throw fail(Code.BAD_INPUT, `入参不允许是绝对路径：${value.slice(0, 40)}。`);
}

function readString(source, key, { max = 200, allowEmpty = false } = {}) {
  const raw = source?.[key];
  if (raw === undefined || raw === null) return allowEmpty ? '' : null;
  const text = String(raw).trim();
  if (!text) return allowEmpty ? '' : null;
  return text.slice(0, max);
}

function requireAssetId(source) {
  const assetId = readString(source, 'assetId', { max: 200 });
  if (!assetId) throw fail(Code.BAD_INPUT, '缺少 assetId。页面只能按 assetId 操作素材。');
  if (/[\\/]/.test(assetId) || assetId.includes('..')) throw fail(Code.BAD_INPUT, 'assetId 不能包含路径字符。');
  return assetId;
}

function requireChatId(source) {
  const raw = source?.chatId ?? source?.id;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) throw fail(Code.BAD_INPUT, 'chatId 必须是正整数。');
  return number;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Normalise the service's answer into the `{ ok, ... }` envelope every handler returns. */
function fromService(result) {
  if (result === undefined || result === null) return { ok: true };
  if (typeof result !== 'object') return { ok: true, value: result };
  if (result.ok === false) {
    const error = result.error ?? { code: Code.UPSTREAM, message: String(result.message ?? '操作没有完成。') };
    return { ok: false, error };
  }
  return { ok: true, ...result };
}

/** Strip UI-only decorations (`rank`, `score` are fine; a nested path is not) from asset rows. */
function assetRow(row) {
  if (!row || typeof row !== 'object') return null;
  const { filePath, file_path, ...rest } = row; // eslint-disable-line camelcase
  // A row is allowed to carry counts and labels; it is never allowed to carry bytes or a path.
  return { ...rest, assetId: String(rest.assetId ?? rest.id ?? '') };
}

const ACTIONS = new Set(['approve', 'resend-review', 'quarantine', 'disable', 'delete', 'edit-card']);

function cardPayload(raw) {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(Code.BAD_INPUT, 'card 必须是对象。');
  const limit = (value, max) => (Array.isArray(value)
    ? value.map(item => String(item ?? '').trim()).filter(Boolean).slice(0, 12).map(item => item.slice(0, max))
    : []);
  return {
    literal: readString(raw, 'literal', { max: 300, allowEmpty: true }),
    intents: limit(raw.intents, 80),
    emotions: limit(raw.emotions, 80),
    tone: limit(raw.tone, 80),
    rhetoric: limit(raw.rhetoric, 80),
    scenes: limit(raw.scenes, 120),
    avoidWhen: limit(raw.avoidWhen, 120),
    note: readString(raw, 'note', { max: 300, allowEmpty: true }),
  };
}

/**
 * Resolve the root that `GET /thumb` must stay inside.
 *
 * The real library exposes its paths (`paths.assets` / `paths.quarantine` from
 * `expressionPaths()`). When it does not, the same layout is derived from the service's `dataRoot`
 * — `<dataRoot>/home/expression/assets`, which is the one place `paths.mjs` puts the bytes. When
 * neither is available the handler refuses to serve bytes rather than serving an unverified path.
 */
function assetsRootOf(service, options) {
  const explicit = service?.paths?.assets ?? service?.assetsRoot ?? options?.assetsRoot ?? null;
  if (explicit) return path.resolve(String(explicit));
  const dataRoot = service?.dataRoot ?? options?.dataRoot ?? null;
  return dataRoot ? path.join(path.resolve(String(dataRoot)), 'home', 'expression', 'assets') : null;
}

function quarantineRootOf(service, options) {
  const explicit = service?.paths?.quarantine ?? options?.quarantineRoot ?? null;
  if (explicit) return path.resolve(String(explicit));
  const dataRoot = service?.dataRoot ?? options?.dataRoot ?? null;
  return dataRoot ? path.join(path.resolve(String(dataRoot)), 'home', 'expression', 'quarantine') : null;
}

function realpathOrNull(candidate) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(candidate) : fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Verify the bytes the service wants to hand out.
 *
 * Returns the verified `filePath`, or throws `{code}` with the reason. The check is `realpath`
 * based on purpose: a symlink inside the assets directory that points at `config/persona.md`
 * must be refused, and `path.relative` alone would not catch it.
 */
function verifyThumbPath(service, options, filePath, { allowQuarantine }) {
  const assetsRoot = assetsRootOf(service, options);
  if (!assetsRoot) {
    throw fail(Code.PATH_UNVERIFIED, '服务没有给出素材根目录，无法校验缩略图路径；拒绝返回未校验的字节。');
  }
  if (!filePath) {
    throw fail(Code.PATH_UNVERIFIED, '服务没有给出缩略图的真实路径，无法校验；拒绝返回未校验的字节。');
  }
  const real = realpathOrNull(filePath);
  if (!real) throw fail(Code.NOT_FOUND, '缩略图文件已不存在（可能已被清理或删除）。');
  const rootReal = realpathOrNull(assetsRoot) ?? assetsRoot;
  if (inside(rootReal, real)) return real;
  if (allowQuarantine) {
    // 隔离区的字节只在**显式** allowQuarantine=1 时才出得去，并且必须落在隔离目录里：
    // 隔离区与素材目录两条 root 都是 realpath 之后才比较，符号链接绕不过去。
    const quarantine = quarantineRootOf(service, options);
    const quarantineReal = quarantine ? (realpathOrNull(quarantine) ?? path.resolve(String(quarantine))) : null;
    if (quarantineReal && inside(quarantineReal, real)) return real;
  }
  throw fail(Code.PATH_OUTSIDE, '缩略图不在素材目录内，拒绝返回（只允许 home/expression/assets）。');
}

/**
 * Build the route table.
 *
 * @param {object|null} service the facade described in CONTRACT.md; `null` = module not enabled
 * @param {{assetsRoot?: string, quarantineRoot?: string}} [options]
 */
export function createExpressionHandlers(service, options = {}) {
  const disabledBody = (what) => ({
    ok: false,
    error: {
      code: Code.DISABLED,
      message: `表情包模块未启用：读不到${what}。把 config/suite.json 的 modules.expression 改成 true 后重启套件。`,
    },
    enableSnippet: ENABLE_SNIPPET,
  });
  const disabledPage = () => {
    const { config } = normalizeConfig(DEFAULT_CONFIG);
    const page = pageDescriptor(config, {
      moduleEnabled: false,
      configExists: false,
      channelConnected: false,
      notes: ['模块未启用：这里显示的是默认配置的形状，不是磁盘上的配置。'],
    });
    return json({ ...disabledBody('页面描述'), page, enableSnippet: ENABLE_SNIPPET }, 200);
  };

  /**
   * Wrap one handler: origin guard → the "not enabled" answer → the handler itself → error
   * mapping. `wrapped.disabled` is attached after the route table is built (one per route), so
   * the disabled answer is defined once and reused.
   */
  const wrap = handler => {
    const wrapped = async request => {
      try {
        if (!originAllowed(request)) {
          return json({ ok: false, error: { code: Code.FORBIDDEN, message: '跨站请求被拒绝（只接受本机 loopback 来源）。' } }, 403);
        }
        if (!service) {
          const fallback = () => json(disabledBody('这个接口'), 200);
          return (typeof wrapped.disabled === 'function' ? wrapped.disabled : fallback)();
        }
        return await handler(request);
      } catch (error) {
        const code = error instanceof ExpressionError ? error.code : Code.UPSTREAM;
        const message = String(error?.message ?? error).slice(0, 400);
        const status = error instanceof ExpressionError && typeof error.status === 'number'
          ? error.status
          : (STATUS_BY_CODE.get(code) ?? 500);
        return json({ ok: false, error: { code, message } }, status);
      }
    };
    return wrapped;
  };

  const queryOf = request => Object.fromEntries(new URL(request.url).searchParams.entries());

  const handlers = {
    [`GET ${API_PREFIX}/page`]: wrap(async () => {
      const configBundle = fromService(await service.getConfig());
      if (configBundle.ok === false) return json(configBundle, STATUS_BY_CODE.get(configBundle.error?.code) ?? 400);
      const page = pageDescriptor(configBundle.config ?? {}, configBundle.status ?? {});
      return json({ ok: true, page, configBundle });
    }),

    [`GET ${API_PREFIX}/config`]: wrap(async request => {
      assertSafeInput(queryOf(request));
      const bundle = fromService(await service.getConfig());
      return json(bundle, bundle.ok ? 200 : 400);
    }),

    [`POST ${API_PREFIX}/config`]: wrap(async request => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '请求体不是 JSON 对象。' } }, 400);
      assertSafeInput(body);
      // `patch` is the sparse form; the full object is accepted too. `config.mjs` validates both.
      const payload = body.patch !== undefined ? body.patch : body;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return json({ ok: false, error: { code: Code.BAD_INPUT, message: 'patch 必须是 JSON 对象。' } }, 400);
      }
      const result = fromService(await service.saveConfig(payload));
      if (result.ok === false) {
        const status = STATUS_BY_CODE.get(result.error?.code) ?? 400;
        return json({ ...result, ok: false, error: { code: Code.CONFIG_INVALID, message: result.error?.message ?? '配置没有通过校验。' } }, status);
      }
      return json(result, 200);
    }),

    [`GET ${API_PREFIX}/assets`]: wrap(async request => {
      const query = queryOf(request);
      assertSafeInput(query);
      const result = fromService(await service.listAssets({
        query: readString(query, 'query', { max: 200, allowEmpty: true }),
        scope: readString(query, 'scope', { max: 120, allowEmpty: true }),
        moderation: readString(query, 'moderation', { max: 40, allowEmpty: true }),
        sort: readString(query, 'sort', { max: 20, allowEmpty: true }) || 'newest',
        limit: clampInt(query.limit, 1, 200, 40),
        offset: clampInt(query.offset, 0, 100000, 0),
      }));
      if (result.ok === false) return json(result, STATUS_BY_CODE.get(result.error?.code) ?? 400);
      const rawList = asArray(result.items ?? result.assets);
      return json({
        ok: true,
        items: rawList.map(assetRow).filter(Boolean),
        total: Number(result.total ?? rawList.length),
        limit: clampInt(query.limit, 1, 200, 40),
        offset: clampInt(query.offset, 0, 100000, 0),
        note: rawList.length ? '' : '图库还没有素材：授权来源之后才会开始被动收集。',
      });
    }),

    [`GET ${API_PREFIX}/asset`]: wrap(async request => {
      const query = queryOf(request);
      assertSafeInput(query);
      const assetId = requireAssetId(query);
      const result = fromService(await service.getAsset(assetId));
      if (result.ok === false) return json(result, STATUS_BY_CODE.get(result.error?.code) ?? 404);
      const asset = assetRow(result.asset ?? result);
      if (!asset || !asset.assetId) return json({ ok: false, error: { code: Code.NOT_FOUND, message: '没有这个素材。' } }, 404);
      return json({
        ok: true,
        asset,
        card: result.card ?? null,
        sources: asArray(result.sources).map(scopeRow).filter(Boolean),
        deliveries: asArray(result.deliveries).slice(0, 20),
        feedback: asArray(result.feedback).slice(0, 20),
        scopeLabels: asArray(result.sources).map(item => describeScope(item?.scope)).filter(Boolean),
      });
    }),

    [`POST ${API_PREFIX}/asset`]: wrap(async request => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '请求体不是 JSON 对象。' } }, 400);
      assertSafeInput(body);
      const assetId = requireAssetId(body);
      const action = readString(body, 'action', { max: 40 });
      if (!action || !ACTIONS.has(action)) {
        return json({ ok: false, error: { code: Code.BAD_INPUT, message: `action 必须是 ${[...ACTIONS].join(' / ')} 之一。` } }, 400);
      }
      const card = action === 'edit-card' ? cardPayload(body.card) : null;
      if (action === 'edit-card' && !card) {
        return json({ ok: false, error: { code: Code.BAD_INPUT, message: 'edit-card 需要同时提交 card。' } }, 400);
      }
      const result = fromService(await service.assetAction({ action, assetId, card, note: readString(body, 'note', { max: 300, allowEmpty: true }) }));
      if (result.ok === false) return json(result, STATUS_BY_CODE.get(result.error?.code) ?? 400);
      return json({ ...result, ok: true, action, assetId });
    }),

    [`GET ${API_PREFIX}/thumb`]: wrap(async request => {
      const query = queryOf(request);
      assertSafeInput(query);
      const assetId = requireAssetId(query);
      const allowQuarantine = ['1', 'true', 'yes'].includes(String(query.allowQuarantine ?? '').toLowerCase());
      const result = fromService(await service.thumbBytes(assetId, { allowQuarantine }));
      if (result.ok === false) {
        const code = result.error?.code;
        if (code === 'quarantined') {
          return json({
            ok: false,
            error: {
              code: Code.QUARANTINED,
              message: '这个素材在隔离区：加 allowQuarantine=1 才能在管理页里查看（仍然不会被发送）。',
            },
          }, 403);
        }
        return json(result, STATUS_BY_CODE.get(code) ?? 404);
      }
      const bytes = result.bytes;
      if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
        return json({ ok: false, error: { code: Code.UPSTREAM, message: '服务没有返回图片字节。' } }, 500);
      }
      const mime = String(result.mime ?? '');
      if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) {
        return json({ ok: false, error: { code: Code.FORBIDDEN, message: '缩略图的类型不是图片，拒绝返回。' } }, 403);
      }
      const verified = verifyThumbPath(service, options, result.filePath, { allowQuarantine });
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': mime,
          'content-length': String(body.length),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-disposition': 'inline',
        },
      });
    }),

    [`GET ${API_PREFIX}/sources`]: wrap(async request => {
      assertSafeInput(queryOf(request));
      const result = fromService(await service.listSources());
      if (result.ok === false) return json(result, STATUS_BY_CODE.get(result.error?.code) ?? 400);
      const items = asArray(result.items ?? result.sources).map(scopeRow).filter(Boolean);
      return json({
        ok: true,
        items,
        note: items.length ? '' : '还没有任何来源：被动收集从授权的那一刻才开始。',
      });
    }),

    [`POST ${API_PREFIX}/grants`]: wrap(async request => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '请求体不是 JSON 对象。' } }, 400);
      assertSafeInput(body);
      const kind = readString(body, 'kind', { max: 20 });
      if (kind !== 'group' && kind !== 'peer') {
        return json({ ok: false, error: { code: Code.BAD_INPUT, message: 'kind 必须是 group 或 peer。' } }, 400);
      }
      const chatId = requireChatId(body);
      const granted = body.granted === true;
      const flags = kind === 'group'
        ? {
          capture: body.capture === true,
          store: body.store === true,
          use: body.use === true,
          // 撤销一个群时默认连素材一起清：撤权不清文件，等于留着一份没有授权的副本。
          deleteAssets: granted ? false : body.keepAssets !== true,
        }
        : { approved: granted };
      const result = fromService(await service.grantScope({ kind, chatId, granted, flags, note: readString(body, 'note', { max: 200, allowEmpty: true }) }));
      if (result.ok === false) return json(result, STATUS_BY_CODE.get(result.error?.code) ?? 400);
      return json({ ...result, ok: true, kind, chatId, granted });
    }),

    [`GET ${API_PREFIX}/deliveries`]: wrap(async request => {
      const query = queryOf(request);
      assertSafeInput(query);
      const limit = clampInt(query.limit, 1, 100, 50);
      const result = fromService(await service.listDeliveries({
        limit,
        scope: readString(query, 'scope', { max: 120, allowEmpty: true }),
        status: readString(query, 'status', { max: 32, allowEmpty: true }),
      }));
      if (result.ok === false) return json(result, STATUS_BY_CODE.get(result.error?.code) ?? 400);
      const rawList = asArray(result.items ?? result.deliveries);
      return json({
        ok: true,
        items: rawList.slice(0, limit),
        total: Number(result.total ?? rawList.length),
        note: rawList.length ? '' : '还没有投递记录：一张图都还没有真的发出去过。',
      });
    }),

    [`GET ${API_PREFIX}/metrics`]: wrap(async request => {
      const query = queryOf(request);
      assertSafeInput(query);
      const result = fromService(await service.metrics({
        windowHours: clampInt(query.windowHours, 1, 24 * 365, 24 * 7),
        scope: readString(query, 'scope', { max: 120, allowEmpty: true }),
      }));
      if (result.ok === false) return json(result, STATUS_BY_CODE.get(result.error?.code) ?? 400);
      return json({ ...result, ok: true, windowHours: clampInt(query.windowHours, 1, 24 * 365, 24 * 7) });
    }),

    /**
     * Natural-ness lab. Read-only by contract: it evaluates the decision, returns the candidate
     * list and the plan it *would* have produced, and never touches delivery.
     */
    [`POST ${API_PREFIX}/simulate`]: wrap(async request => {
      const body = await readJson(request);
      if (body === null) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '请求体不是 JSON 对象。' } }, 400);
      assertSafeInput(body);
      const text = readString(body, 'text', { max: 2000, allowEmpty: true });
      if (!text) return json({ ok: false, error: { code: Code.BAD_INPUT, message: '给一段聊天片段再模拟。' } }, 400);
      const result = fromService(await service.simulate({
        text,
        isGroup: body.isGroup === true,
        target: readString(body, 'target', { max: 200, allowEmpty: true }),
        limit: clampInt(body.limit, 1, 10, 5),
      }));
      if (result.ok === false) return json(result, STATUS_BY_CODE.get(result.error?.code) ?? 400);
      return json({
        ok: true,
        sending: false,
        note: '模拟不会向 QQ 发送任何内容：这里只有决策、候选与「本来会发的那条」，没有投递路径。',
        decision: result.decision ?? null,
        // 假设投递总闸打开时的决策，只用于评估自然度；仍不是投递。
        decisionIfEnabled: result.decisionIfEnabled ?? null,
        candidates: asArray(result.candidates).slice(0, 10),
        plan: result.plan ?? null,
        retrieval: result.retrieval ?? null,
        scopeNote: result.scopeNote ?? '',
        hypotheticalNote: result.hypotheticalNote ?? '',
        configTouch: result.configTouch ?? null,
      });
    }),
  };

  // The "not enabled" answer for every route. Registered on purpose: a page that resolves to
  // 「未启用」 is far better than one that resolves to 404 and looks broken.
  const routeKeys = Object.keys(handlers);
  for (const key of routeKeys) {
    handlers[key].disabled = key.includes('/page') ? disabledPage : () => json(disabledBody(key.split('/').pop()), 200);
  }

  return handlers;
}

function scopeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const scope = String(row.scope ?? row.originScope ?? '');
  if (!scope) return null;
  const { originScope, ...rest } = row; // eslint-disable-line camelcase
  return { ...rest, scope, label: String(row.label ?? describeScope(scope)), describe: describeScope(scope) };
}

export default { API_PREFIX, Code, ExpressionError, createExpressionHandlers, assertSafeInput };
