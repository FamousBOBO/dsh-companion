// 记忆档案 Studio · Host API 内核。
//
// 这一层只做四件事：拿到引擎的 internal() 管理句柄、把 owner 身份固定成
// viewer、维护统一的 JSON 信封，以及把任何异常收成一个可读的错误码。
// 它不碰 SQLite（db.mjs 的职责），也不做业务判断（read/write 的职责）。

import { redactSecrets, truncate } from '../../companion-memory/lib/text.mjs';

// 契约 §4：所有响应固定来源与 schema 版本，方便前端做兼容判断。
export const SOURCE = 'companion-memory';
export const SCHEMA_VERSION = 1;

// 响应头固定：JSON + 禁止缓存（记忆数据可能随时变化，且属于隐私内容）。
export const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

// 契约允许的错误码。业务失败一律 ok:false；HTTP 状态码只表达 400/404/500。
const ERROR_CODES = new Set(['bad-request', 'not-found', 'db-unavailable', 'denied', 'internal']);

/** 可预期的业务错误；status 只在 400/404/500 时有意义。 */
export class ApiError extends Error {
  constructor(code, message, status = 200) {
    super(message);
    this.name = 'ApiError';
    this.code = ERROR_CODES.has(code) ? code : 'internal';
    this.status = [400, 404, 500].includes(status) ? status : 200;
  }
}

/** 把信封对象变成 Response；序列化失败时退化为 internal 错误，绝不抛出。 */
export function respond(payload, status = 200) {
  let body = '';
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify(errorEnvelope('internal', '响应序列化失败。', defaultMeta()));
  }
  return new Response(body, { status, headers: JSON_HEADERS });
}

export function defaultMeta() {
  return { source: SOURCE, schemaVersion: SCHEMA_VERSION, observedAt: new Date().toISOString() };
}

export function okEnvelope(data, extraMeta = null) {
  return { ok: true, data, meta: { ...defaultMeta(), ...(extraMeta ?? {}) } };
}

export function errorEnvelope(code, message, metaValue = defaultMeta()) {
  return { ok: false, error: { code, message }, meta: metaValue };
}

// ---------------------------------------------------------------------------
// 参数小工具：所有外部输入都先收敛再使用，绝不把原样字符串塞进查询或日志。
// ---------------------------------------------------------------------------

export function clampInt(value, min, max, fallback) {
  // 缺失参数（null/''）必须回退默认值：Number(null) === 0 会被误当成合法最小值。
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function clampNumber(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 只接受白名单枚举，其余一律回退（不报错，避免 UI 少一个参数就打不开页面）。 */
export function pickEnum(value, allowed, fallback = '') {
  const text = String(value ?? '').trim();
  return allowed.includes(text) ? text : fallback;
}

/** 长度受限的文本参数；去掉首尾空白并截断，替代直接透传。 */
export function textValue(value, maxChars = 200) {
  return truncate(String(value ?? '').trim(), maxChars);
}

/** 列表/预览用短文本：脱敏、压成一行、限长。 */
export function safePreview(value, maxChars = 140) {
  const text = redactSecrets(String(value ?? '')).replace(/[\r\n\t]+/g, ' ').trim();
  return truncate(text, maxChars);
}

/**
 * `mentionPolicy` 语义说明（曾有一个 `isHiddenRecord()` 在这里，已删除）：
 *
 * `avoid_unless_asked` 表达的是「**模型**不要主动提起这件事」，它约束模型发言，
 * 不是「**主人**能不能在管理台看自己的记忆」。记忆库是用户本人的数据，管理台就是给
 * 主人审核、修订自己数据的界面，所以视图层不按 `mentionPolicy` 抹正文（2026-10-31 决策）。
 * 需要「看的时候也隐藏」的话，那是另一个独立的隐私模式，不要把它塞回这里。
 */

/** URL 解析容错：host 注入的 request.url 一定是绝对地址，测试里也允许相对路径。 */
function searchParamsOf(request) {
  const raw = String(request?.url ?? '');
  try {
    return new URL(raw).searchParams;
  } catch {
    const index = raw.indexOf('?');
    return new URLSearchParams(index >= 0 ? raw.slice(index + 1) : '');
  }
}

// ---------------------------------------------------------------------------
// 内核
// ---------------------------------------------------------------------------

/**
 * @param engine    引擎门面（plugins/companion-memory/index.mjs），必须带 internal()
 * @param identity  身份服务（仅用于说明来源；viewer 一律走 internal().viewer()）
 * @param root      工作区根目录（日志/路径诊断用，不直接读写）
 * @param log       可选日志回调，只接收固定 code，不接收正文或用户输入
 */
export function createKernel({ engine = null, identity = null, root = '', log = null } = {}) {
  // 日志只允许固定字段；调用方传什么都不会带出记忆正文。
  const logger = typeof log === 'function' ? log : () => {};

  const meta = extra => ({ ...defaultMeta(), ...(extra ?? {}) });

  const fail = (code, message, { status = 200, extraMeta = null } = {}) => (
    respond(errorEnvelope(code, message, meta(extraMeta)), status)
  );

  return {
    log: logger,
    meta,

    /** 拿到引擎的管理句柄；引擎缺失或初始化失败都收敛为 db-unavailable。 */
    async internal() {
      if (!engine || typeof engine.internal !== 'function') {
        throw new ApiError('db-unavailable', '记忆引擎当前不可用。', 200);
      }
      try {
        return await engine.internal();
      } catch {
        throw new ApiError('db-unavailable', '记忆引擎当前不可用。', 200);
      }
    },

    /** 需要读写数据库的接口统一走这里；null 句柄返回 db-unavailable 信封。 */
    requireDb(internal) {
      if (!internal || !internal.db) throw new ApiError('db-unavailable', '记忆库当前不可用。', 200);
      return internal.db;
    },

    /**
     * owner 视角；不接受浏览器传入的 userId/personaId/worldId。
     * 身份缺失时用 denied（这不是路由错误，所以 HTTP 200）。
     */
    viewer(internal) {
      let viewer = null;
      try {
        viewer = typeof internal?.viewer === 'function' ? internal.viewer() : null;
      } catch {
        viewer = null;
      }
      const userId = String(viewer?.userId ?? '').trim();
      const personaId = String(viewer?.personaId ?? '').trim();
      if (!userId || !personaId) throw new ApiError('denied', '没有可用的用户绑定。', 200);
      return {
        userId,
        personaId,
        worldId: viewer.worldId == null ? '' : String(viewer.worldId),
        sessionId: viewer.sessionId == null ? '' : String(viewer.sessionId),
        displayName: String(viewer.displayName ?? ''),
      };
    },

    query(request) {
      return searchParamsOf(request);
    },

    /** 读取 JSON 请求体；空体视为 {}，坏 JSON 视为 bad-request（400）。 */
    async body(request) {
      let raw = '';
      try {
        raw = typeof request?.text === 'function' ? await request.text() : '';
      } catch {
        throw new ApiError('bad-request', '请求体无法读取。', 400);
      }
      if (!String(raw).trim()) return {};
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        throw new ApiError('bad-request', '请求体不是合法的 JSON。', 400);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ApiError('bad-request', '请求体必须是 JSON 对象。', 400);
      }
      return parsed;
    },

    /** 成功响应。 */
    ok(data, extraMeta = null) {
      return respond(okEnvelope(data, extraMeta), 200);
    },

    /** 明确的失败响应（read/write 内部也可以直接抛 ApiError）。 */
    fail,

    /**
     * 统一兜底：ApiError 转成对应的错误码与状态码；未知异常只记录固定 code，
     * 不把 message/堆栈写进日志，也不返回给前端。
     */
    guard(routeName, handler) {
      return async request => {
        try {
          return await handler(request);
        } catch (error) {
          if (error instanceof ApiError) {
            logger('route-failed', { route: routeName, code: error.code, status: error.status });
            return fail(error.code, error.message, { status: error.status });
          }
          logger('route-error', { route: routeName, code: 'internal' });
          return fail('internal', '管理接口内部错误。', { status: 500 });
        }
      };
    },

    // identity/root/engine 目前只用于上下文（版本号、诊断路径）；viewer 仍然只从
    // internal() 取，浏览器无法注入身份。
    identity,
    root,
    engine,
  };
}

/** 纠正裁决的证据格式（一处定义，读/写两侧共用：前端展示的那句 == 真正记下的那句）。 */
export function correctionEvidence(operator, at) {
  return `后台人工裁决 at ${new Date(at).toISOString()} by ${String(operator ?? '')}`;
}
