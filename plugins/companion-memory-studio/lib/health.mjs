// 记忆档案 Studio · 健康数据接口（`/api/companion-health/*`，契约 §13）。
//
// 这一层是 companion-health 插件在 Studio 里的**只读展示面**，职责边界刻意很窄：
//   - GET 全部只读：把 `service.*()` 的返回值洗一遍再包信封，绝不发网络请求、绝不自己开
//     SQLite 连接（单写者原则：健康库的写者只有 health 插件自己）；
//   - POST /sync 是本前缀里**唯一**会碰网络的地方，且由 service 去碰，这里只做 5 分钟冷却；
//   - POST /maintenance 只调 service 已有的能力；service 没暴露的能力如实回 unsupported-action。
//   - POST /pulse 只驱动 `companion-health` 的心跳会话状态机与授权开关（`health.pulse.live`），
//     心率数据本身不进这一层：不落库、不缓存、不写日志（契约 design/pulse-bond-20261103.md §7）。
//
// 信封：`api-kernel` 的 `defaultMeta()` 固定 `source: 'companion-memory'`，而契约要求健康接口
// 的 `meta.source === 'companion-health'`。**不改 api-kernel**，这里自己拼 meta，
// 成功/失败两条路径都用它，所以整个前缀的 meta 是自洽的。
//
// 隐私（契约 §13 / §14）：任何返回都在 `stripPrivate()` 里过一遍，键名命中
// uid / token / uniqueId / devId / rawRef / payload 一律剔除。宁可少给字段，也不给凭证。

import { clampInt, pickEnum, respond } from './api-kernel.mjs';

export const HEALTH_PREFIX = '/api/companion-health';
/** 契约 §13：健康接口的 meta.source 固定这个值（不是 'companion-memory'）。 */
export const HEALTH_SOURCE = 'companion-health';
export const HEALTH_SCHEMA_VERSION = 1;

/** 契约 §13：手动同步冷却 5 分钟。 */
export const SYNC_COOLDOWN_MS = 5 * 60 * 1000;

/** 契约 §11.4 的趋势指标白名单；不在白名单里的值一律回退到 `steps`（见 healthTrends）。 */
export const TREND_METRICS = Object.freeze([
  'steps', 'distance_m', 'kcal', 'heart_rate', 'resting_heart_rate', 'stress', 'spo2', 'intensity',
]);
export const DEFAULT_TREND_METRIC = 'steps';

/** 契约 §13：维护动作白名单。 */
export const MAINTENANCE_ACTIONS = Object.freeze(['pause', 'resume', 'integrity', 'backup']);

/** 契约 §10：`health.connect` 就是"采集开关"，pause/resume 通过它表达，状态可持久、可回滚。 */
export const COLLECTOR_CAPABILITY = 'health.connect';

/**
 * 心跳共振（`design/pulse-bond-20261103.md` §4.4 / §7）。
 *
 * 两条路由：`GET /pulse` 读现场读数，`POST /pulse` 驱动会话状态机。
 * 与既有 7 条健康路由同规矩：不碰网络、不碰 SQLite、不自己算生理指标 ——
 * 环形缓冲、档位、基线、safety 全在 `companion-health` 的 `pulse.mjs` 里，
 * 这里只做「参数收敛 → 调 facade → 套信封」。
 *
 * 心跳数据只属于这一条链路：不写库、不进日志、不进 `meta`，也不出现在别的页面。
 */
export const PULSE_SESSION_ACTIONS = Object.freeze(['start', 'stop', 'mark']);
/**
 * 授权开关（`health.pulse.live`）也需要一条写路径，而健康前缀里唯一能写 consents 的
 * `POST /maintenance` 被 action 白名单绑死在采集器（`health.connect`）上。
 * 契约 §7 的 `POST /pulse` 因此多认一个 `consent` 动作：capability 固定，
 * 不接受调用方自带 capability（否则这里就成了一条任意授权写入口）。
 */
export const PULSE_CONSENT_ACTION = 'consent';
export const PULSE_CONSENT_CAPABILITY = 'health.pulse.live';
export const PULSE_ACTIONS = Object.freeze([...PULSE_SESSION_ACTIONS, PULSE_CONSENT_ACTION]);
/** 契约 §6：`mark` 的标签 ≤40 字；`start` 的分钟数 1..120（service 会再夹 5..120）。 */
export const PULSE_LABEL_MAX = 40;
export const PULSE_MINUTES_MIN = 1;
export const PULSE_MINUTES_MAX = 120;

// `reason` 白名单：`studio-ui` 是 Studio 页面按钮实际发的值（src/client/pages-health.js），
// 原样传给 service 才能让 health_sync_runs 的审计反映"是谁点的"；未知值回退 'manual'。
const SYNC_REASONS = Object.freeze(['manual', 'poll', 'retry', 'studio-ui']);

/** 契约 §14：这些键名里出现的值一律不得外传。 */
const PRIVATE_KEY = /uid|token|uniqueid|devid|raw_ref|rawref|payload/i;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** 递归清洗的深度上限：避免畸形/自引用结构把请求拖死。 */
const MAX_SCRUB_DEPTH = 12;

const MISSING_MESSAGE = '健康服务当前没有挂载。';

// ---------------------------------------------------------------------------
// 信封：成功与失败都带 `source: 'companion-health'`。
// ---------------------------------------------------------------------------

export function healthMeta() {
  return {
    source: HEALTH_SOURCE,
    schemaVersion: HEALTH_SCHEMA_VERSION,
    observedAt: new Date().toISOString(),
  };
}

/** 成功信封；`data` 先过 `stripPrivate()`。 */
function success(data) {
  return respond({ ok: true, data: stripPrivate(data ?? null), meta: healthMeta() }, 200);
}

/**
 * 失败信封：`{ ok:false, error:{ code, message, errorCode? }, meta }`。
 * HTTP 状态码只表达参数/方法错误（400）；"服务不可用""冷却中"这类业务状态一律 200，
 * 前端按 `error.code` 分流 —— 与 Studio 既有信封一致。
 *
 * `errorCode` 是**同一类失败的不同原因**（例如 `pulse-unreachable` 下的
 * `device-not-found` / `connect-timeout`），原样透出，让页面能说清"该去开广播还是重试"。
 * 它只在服务真的给了的时候出现，既有 7 条路由的信封形状一个字没变。
 */
function failure(code, message, { status = 200, data, errorCode } = {}) {
  const error = { code: String(code || 'health-unavailable'), message: String(message || '') };
  const reason = errorCode == null ? '' : String(errorCode).trim();
  if (reason) error.errorCode = reason;
  const payload = { ok: false, error, meta: healthMeta() };
  if (data !== undefined) payload.data = stripPrivate(data);
  return respond(payload, status);
}

function unavailable() {
  return failure('health-unavailable', MISSING_MESSAGE);
}

function badRequest(message) {
  return failure('bad-request', message, { status: 400 });
}

// ---------------------------------------------------------------------------
// 隐私兜底（契约 §14）：递归剔掉 uid / token / uniqueId / devId / rawRef / payload。
// ---------------------------------------------------------------------------

function scrub(value, depth) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'bigint') return Number(value);
  if (type !== 'object') return value; // string / number / boolean
  if (depth > MAX_SCRUB_DEPTH) return null;
  if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map || value instanceof Set) return scrub([...value], depth + 1);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) continue;
    out[key] = scrub(item, depth + 1);
  }
  return out;
}

/**
 * 隐私兜底：深拷贝一份并删掉所有命中 `PRIVATE_KEY` 的键。
 * 导出是为了让测试能直接证明"无论哪一层漏了字段，最后这一道都会拦下来"。
 */
export function stripPrivate(value) {
  return scrub(value, 0);
}

// ---------------------------------------------------------------------------
// 服务惰性依赖 + 参数收敛
// ---------------------------------------------------------------------------

/**
 * 取健康服务。`options.health` 是惰性 getter（`server.mjs` 注入
 * `() => ctx.get('companionHealth')`），因为 health 插件可能没装、也可能晚挂载：
 * 每次请求现取一次，挂上就有、摘掉就回 health-unavailable，不会缓存住一个死引用。
 */
function serviceOf(options) {
  const getter = options?.health ?? options?.healthService;
  if (getter == null) return null;
  let service = null;
  try {
    service = typeof getter === 'function' ? getter() : getter;
  } catch {
    service = null;
  }
  return service && typeof service === 'object' ? service : null;
}

/** 统一调用 service：同步/异步都吃，异常收敛成 `{ ok:false }`，绝不把异常抛给宿主。 */
async function callService(service, method, args = []) {
  if (typeof service?.[method] !== 'function') return { ok: false, missing: true, value: null };
  try {
    return { ok: true, value: await service[method](...args) };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * `date` 参数只接受 `YYYY-MM-DD`，其余（空、`2026-11-3`、带时间、乱码）一律忽略，
 * 由 service 用"今天"兜底。忽略比报错好：日期是页面上的可选筛选项。
 */
function dateParam(value) {
  const text = String(value ?? '').trim();
  return DATE_ONLY.test(text) ? text : '';
}

/** `includeStages` 只认 '1' / 'true'（契约 §13 的 query 参数）。 */
function flagParam(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true';
}

/**
 * 要"回显给前端"的短参数（例如 `requestedMetric`）：压成一行、去掉控制字符、限长。
 * 回显用户输入的地方一律先收敛，绝不原样塞进响应。
 */
function safeToken(value, maxChars = 40) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/**
 * 把 service 的返回值转成信封。
 * 契约 §12：服务初始化失败时返回 `{ ok:false, code:'health-db-unavailable' }`（**没有** error 对象），
 * 所以这里两种形状都认；错误码原样透出（`health-db-unavailable` 之类），不翻译成 Studio 的码。
 * `errorCode`（同一类失败的原因，例如 `device-not-found`）一并透出，页面据此给不同建议。
 */
function fromService(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && result.ok === false) {
    const error = result.error && typeof result.error === 'object' ? result.error : {};
    const code = String(error.code ?? result.code ?? 'health-unavailable');
    const message = String(error.message ?? result.message ?? '健康数据暂时不可用。');
    const errorCode = error.errorCode ?? result.errorCode ?? null;
    return failure(code, message, { errorCode });
  }
  return success(result);
}

// ---------------------------------------------------------------------------
// GET · 只读（这五条路径全部不碰网络、不碰 SQLite）
// ---------------------------------------------------------------------------

/** GET /status → `service.status()`（契约 §11.1）。 */
export async function healthStatus(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service || typeof service.status !== 'function') return unavailable();
  const called = await callService(service, 'status');
  if (!called.ok) return failure('internal', '读取健康状态失败。');
  return fromService(called.value);
}

/** GET /sources → `service.sources()`（契约 §11.2；服务返回的是数组，不是信封）。 */
export async function healthSources(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service || typeof service.sources !== 'function') return unavailable();
  const called = await callService(service, 'sources');
  if (!called.ok) return failure('internal', '读取健康来源失败。');
  return fromService(called.value);
}

/** GET /today?date= → `service.today({ date })`（契约 §11.3）。 */
export async function healthToday(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service || typeof service.today !== 'function') return unavailable();
  const date = dateParam(kernel.query(request).get('date'));
  const called = await callService(service, 'today', [date ? { date } : {}]);
  if (!called.ok) return failure('internal', '读取今日健康数据失败。');
  return fromService(called.value);
}

/** 回退说明用的中文短标签（只进 `note`，不参与任何判断）。 */
const METRIC_LABELS = Object.freeze({
  steps: '步数', distance_m: '距离', kcal: '活动消耗', heart_rate: '心率',
  resting_heart_rate: '静息心率', stress: '压力', spo2: '血氧', intensity: '中高强度时长',
});

/**
 * GET /trends?metric=&days= → `service.trend({ metric, days })`（契约 §11.4）。
 *
 * `metric` 不在白名单（含拼错）时**回退到 `steps`**，不报 `unsupported-metric`：
 * 与 Studio 其它列表接口一致（少一个参数不该让页面打不开）。但回退**绝不静默** ——
 * 回退时 `data` 额外带 `metricFallback:true` + `requestedMetric:'<原值>'` + 一句中文 `note`，
 * 否则主人选了「血氧」却看到步数曲线，这是最容易误读的一种 bug。
 * （参数缺失/空串不算回退：那是走默认值，不带这几个字段。）
 */
export async function healthTrends(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service || typeof service.trend !== 'function') return unavailable();
  const query = kernel.query(request);
  const requested = safeToken(query.get('metric'));
  const metric = pickEnum(requested, TREND_METRICS, DEFAULT_TREND_METRIC);
  // 契约 §13：days 限 1..30；缺省 7。clampInt 自己处理 null/''/NaN。
  const days = clampInt(query.get('days'), 1, 30, 7);
  const called = await callService(service, 'trend', [{ metric, days }]);
  if (!called.ok) return failure('internal', '读取健康趋势失败。');
  const result = called.value;
  // 服务自己报错（§12 的 `{ok:false,code,message}`）：原样透出，不往上贴字段。
  if (result && typeof result === 'object' && !Array.isArray(result) && result.ok === false) {
    return fromService(result);
  }
  const fellBack = requested !== '' && requested !== metric;
  const data = result && typeof result === 'object' && !Array.isArray(result) ? { ...result } : result;
  if (fellBack && data && typeof data === 'object') {
    data.metricFallback = true;
    data.requestedMetric = requested;
    data.note = `不支持的指标「${requested}」，已改为显示${METRIC_LABELS[metric] ?? metric}。`;
  }
  return success(data);
}

/**
 * GET /sleep?date=&days=&includeStages= → `service.sleep(...)`（契约 §11.5）。
 * 没有数据时 service 会回 `availability:'awaiting_first_night'`，这里**原样透传**：
 * 不编造会话、不补阶段、不把「还没睡够一夜」说成「没有这项能力」。
 */
export async function healthSleep(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service || typeof service.sleep !== 'function') return unavailable();
  const query = kernel.query(request);
  const days = clampInt(query.get('days'), 1, 30, 7);
  const includeStages = flagParam(query.get('includeStages'));
  const date = dateParam(query.get('date'));
  const called = await callService(service, 'sleep', [date ? { date, days, includeStages } : { days, includeStages }]);
  if (!called.ok) return failure('internal', '读取睡眠数据失败。');
  return fromService(called.value);
}

// ---------------------------------------------------------------------------
// GET /care · 主动关怀（`health.care.proactive`，只读）
// ---------------------------------------------------------------------------

/**
 * 返回"现在会说什么关怀"和"已经说过的"，全部由 `companion-health` 决定。
 *
 * 这一层**不做任何判断**：授权关着时服务直接给 `items: []`，我们不补、不猜、不缓存。
 * 也不提供写路径 —— 开关走既有的 `POST /pulse` 的 consent 动作。
 */
export async function healthCare(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service || typeof service.care !== 'function') return unavailable();
  const called = await callService(service, 'care', []);
  if (!called.ok) return failure('internal', '读取主动关怀状态失败。');
  return fromService(called.value);
}

// ---------------------------------------------------------------------------
// POST /sync · 本前缀里唯一会触发网络请求的地方（冷却 5 分钟）
// ---------------------------------------------------------------------------

/**
 * 手动同步的冷却时间戳。挂在 service 实例上（WeakMap）而不是模块变量：
 * 摘掉/重挂健康服务后冷却跟着实例走，不会因为换实例把别人的额度吃掉；
 * 也不会因为 module 被多个宿主复用而互相干扰。
 */
const lastManualSyncAt = new WeakMap();

function cooldownState(service, nowMs) {
  const last = lastManualSyncAt.get(service) ?? 0;
  if (!last) return { cooling: false, nextAllowedAt: 0, retryAfterMs: 0 };
  const nextAllowedAt = last + SYNC_COOLDOWN_MS;
  const cooling = nowMs < nextAllowedAt;
  return { cooling, nextAllowedAt, retryAfterMs: cooling ? nextAllowedAt - nowMs : 0 };
}

/**
 * POST /sync → `service.syncNow({ days, force, reason })`。
 *
 * `force` 的语义：允许**在没有冷却时**让 service 强制拉一次（例如主人刚改完配置）。
 * 它**不是**冷却的免死金牌 —— 冷却优先，`force:true` 也照样回 `sync-cooldown`，
 * 否则页面连点两下就能把上游打出限流（契约 §8 的 1101/429 退避就是这么来的）。
 */
export async function healthSync(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service || typeof service.syncNow !== 'function') return unavailable();

  let body;
  try {
    body = await kernel.body(request);
  } catch {
    return badRequest('请求体不是合法的 JSON 对象。');
  }

  const days = clampInt(body.days, 1, 30, 7);
  const force = body.force === true || body.force === 1 || String(body.force).toLowerCase() === 'true';
  const reason = pickEnum(body.reason, SYNC_REASONS, 'manual');

  const now = Date.now();
  const cooldown = cooldownState(service, now);
  if (cooldown.cooling) {
    // 冷却中：不调 service（也就不会发网络请求），把下一次可用的时刻如实给前端。
    // 剩余秒数也写进 message：前端在失败分支只拿 error.code/message，看不到 data。
    const seconds = Math.max(1, Math.ceil(cooldown.retryAfterMs / 1000));
    return failure('sync-cooldown', `手动同步太频繁了，请 ${seconds} 秒后再试。`, {
      data: { nextAllowedAt: new Date(cooldown.nextAllowedAt).toISOString(), retryAfterMs: cooldown.retryAfterMs },
    });
  }

  // 先记时间再调用：即便这次 service 报错，也算用掉了配额 —— 否则失败会变成"可以一直点"。
  lastManualSyncAt.set(service, now);
  const called = await callService(service, 'syncNow', [{ days, force, reason }]);
  // syncNow 契约上不抛（失败收敛成 status:'error'），真抛了也只有一个诚实结论：内部错误。
  if (!called.ok) return failure('internal', '手动同步失败。');
  return fromService(called.value);
}

// ---------------------------------------------------------------------------
// POST /maintenance · pause / resume / integrity / backup
// ---------------------------------------------------------------------------

/**
 * pause / resume：用 `health.connect` 这个 consent 表达"采集启停"（契约 §10）。
 * 为什么不用别的开关：consents 表是唯一既**持久**又**可回滚**、且 check-health 也在读的地方；
 * studio 侧临时内存标志重启就没了，主人看不出"到底还采不采"。
 * 顺序固定：先落 consent（失败就什么都不启停），再 start()/stop() 线程。
 */
async function collectorAction(service, action) {
  if (typeof service.setConsent !== 'function'
    || typeof service.start !== 'function' || typeof service.stop !== 'function') {
    return failure('unsupported-action', '健康服务没有暴露采集开关（setConsent/start/stop）。');
  }
  const enabled = action === 'resume';
  const consent = await callService(service, 'setConsent', [COLLECTOR_CAPABILITY, enabled]);
  if (!consent.ok) return failure('internal', enabled ? '恢复采集失败。' : '暂停采集失败。');
  const toggled = await callService(service, enabled ? 'start' : 'stop');
  if (!toggled.ok) return failure('internal', enabled ? '启动采集失败。' : '停止采集失败。');

  const running = await callService(service, 'isRunning');
  const consents = await callService(service, 'consents');
  return success({
    action,
    capability: COLLECTOR_CAPABILITY,
    enabled,
    running: running.ok ? Boolean(running.value) : null,
    consents: consents.ok ? consents.value : null,
  });
}

/**
 * integrity：只读 `service.status()` 里已有的 `db.integrity`，**不新开 DB 句柄**
 * （单写者原则；健康库的句柄只有 health 插件持有）。
 */
async function integrityAction(service) {
  if (typeof service.status !== 'function') {
    return failure('unsupported-action', '健康服务没有暴露状态接口，读不到完整性结果。');
  }
  const called = await callService(service, 'status');
  if (!called.ok) return failure('internal', '完整性检查失败。');
  const status = called.value;
  if (!status || typeof status !== 'object' || status.ok === false) return fromService(status);
  const db = status.db && typeof status.db === 'object' ? status.db : {};
  return success({
    action: 'integrity',
    integrity: String(db.integrity ?? 'unknown'),
    journalMode: String(db.journalMode ?? ''),
    sizeBytes: Number.isFinite(Number(db.sizeBytes)) ? Number(db.sizeBytes) : 0,
    checkedAt: new Date().toISOString(),
  });
}

/**
 * backup：**只有 service 自己暴露了备份能力才做**（WAL 一致性备份必须由库的唯一写者做，
 * studio 自己开连接就等于写出第二个 writer，违反单写者原则）。没暴露就如实回
 * unsupported-action —— 不假装成功、也不偷偷实现一份。
 *
 * 优先 `service.backup()`（companion-health 门面的名字，契约外的便捷入口，
 * 返回 `{ ok:true, path, bytes, at }` 或 `{ ok:false, code, message }`）；
 * 退而认 `service.backupTo()`（契约 §3 里 db 层的名字）。
 */
async function backupAction(service) {
  if (typeof service.backup === 'function') {
    const called = await callService(service, 'backup');
    if (!called.ok) return failure('internal', '备份失败。');
    const result = called.value;
    if (result && typeof result === 'object' && result.ok === false) {
      // 服务自己的类型化拒绝（例如 health-readonly / health-backup-failed）原样透出。
      return failure(String(result.code ?? 'unsupported-action'), String(result.message ?? '备份失败。'));
    }
    return success({
      action: 'backup',
      path: result?.path == null ? null : String(result.path),
      bytes: Number.isFinite(Number(result?.bytes)) ? Number(result.bytes) : null,
      at: result?.at == null ? null : String(result.at),
    });
  }
  if (typeof service.backupTo === 'function') {
    const called = await callService(service, 'backupTo');
    if (!called.ok) return failure('internal', '备份失败。');
    return success({ action: 'backup', result: called.value ?? null });
  }
  return failure('unsupported-action', '健康服务没有暴露备份接口；本轮不自己开 SQLite 连接。');
}

/** POST /maintenance → `{ action }` 白名单之外一律 bad-request（400）。 */
export async function healthMaintenance(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service) return unavailable();

  let body;
  try {
    body = await kernel.body(request);
  } catch {
    return badRequest('请求体不是合法的 JSON 对象。');
  }

  const action = pickEnum(body.action, MAINTENANCE_ACTIONS, '');
  if (!action) {
    return badRequest(`不支持的维护动作，只支持 ${MAINTENANCE_ACTIONS.join(' / ')}。`);
  }
  if (action === 'integrity') return integrityAction(service);
  if (action === 'backup') return backupAction(service);
  return collectorAction(service, action);
}

// ---------------------------------------------------------------------------
// 心跳共振（契约 design/pulse-bond-20261103.md §4.4 / §7）
//   GET  /pulse → `service.pulse()`（只转发这一份视图，不自己拼字段）
//   POST /pulse → `service.pulseSession({action,minutes,label})` / `service.setConsent(...)`
// 与其它 7 条同规矩：不碰网络、不碰 SQLite、不缓存、不写日志；任何路径都不许抛、不许 500。
// ---------------------------------------------------------------------------

/**
 * 服务对象在场、但没有这个方法：这既不是"没挂载"（`health-unavailable`），
 * 也不该冒充成空数据。回一个能让人看出"版本不对"的码，HTTP 仍然 200。
 */
function methodMissing(method) {
  return failure('health-method-missing', `健康服务没有暴露实时心跳接口（${method}）。`);
}

/** POST /pulse 的动作归一：大小写与空白都不算错，值不认识才算（Lead 裁决 2026-11-03）。 */
function pulseActionParam(value) {
  return pickEnum(String(value ?? '').trim().toLowerCase(), PULSE_ACTIONS, '');
}

/** `consent` 只认明确的真假；`'true'` / `1` 这类线上一律收成布尔，其它都算没给。 */
function consentParam(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'off') return false;
  return null;
}

/** GET /pulse → `service.pulse()`（契约 §4.4）。只读一份视图，不追加、不改写。 */
export async function pulseStatus(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service) return unavailable();
  if (typeof service.pulse !== 'function') return methodMissing('pulse');
  const called = await callService(service, 'pulse');
  // facade 不抛（契约 §4.4）；真抛了也只可能是"读不到"，不是参数问题。
  if (!called.ok) return failure('internal', '读取实时心跳失败。');
  return fromService(called.value);
}

/**
 * `consent` 动作：授权开关 `health.pulse.live`。
 * capability 由服务端固定，请求体里的 `capability` 只允许"同一个值或省略"——
 * 否则这条路由就成了任意授权写入口（例如借它打开 `health.export`）。
 */
async function pulseConsent(service, capability, enabled) {
  if (typeof service.setConsent !== 'function') {
    return failure('unsupported-action', '健康服务没有暴露授权开关（setConsent）。');
  }
  const requested = String(capability ?? '').trim();
  if (requested && requested !== PULSE_CONSENT_CAPABILITY) {
    return badRequest(`这条路由只能改 ${PULSE_CONSENT_CAPABILITY} 的授权。`);
  }
  if (enabled === null) return badRequest('需要给出要设置的授权状态（consent: true / false）。');

  const called = await callService(service, 'setConsent', [PULSE_CONSENT_CAPABILITY, enabled]);
  if (!called.ok) return failure('internal', '写入心跳授权失败。');
  // 服务自己的类型化拒绝（health-readonly / health-consent-unknown …）原样透出，HTTP 200。
  if (called.value && typeof called.value === 'object' && called.value.ok === false) {
    return fromService(called.value);
  }
  const result = called.value && typeof called.value === 'object' ? called.value : {};
  // `enabled` 以服务读回的那份为准（它刚写完立刻回读），拿不到才用请求值。
  const effective = typeof result.enabled === 'boolean' ? result.enabled : enabled;
  return success({
    action: PULSE_CONSENT_ACTION,
    capability: PULSE_CONSENT_CAPABILITY,
    enabled: effective,
    requested: enabled,
    consents: result.consents && typeof result.consents === 'object' ? result.consents : null,
    enforced: result.enforced === undefined ? null : result.enforced,
  });
}

/**
 * POST /pulse → `{ action: 'start'|'stop'|'mark'|'consent', minutes?, label?, consent?, capability? }`。
 *
 * `minutes` / `label` 先收敛再交给 facade（`start` 之外的动作用不到它们，直接不发，
 * 免得 service 把 `label` 当成一次意外的 mark）。
 */
export async function pulseAction(request, kernel, options = {}) {
  const service = serviceOf(options);
  if (!service) return unavailable();

  let body;
  try {
    body = await kernel.body(request);
  } catch {
    return badRequest('请求体不是合法的 JSON 对象。');
  }

  const action = pulseActionParam(body.action);
  if (!action) {
    return badRequest(`不支持的心跳动作，只支持 ${PULSE_ACTIONS.join(' / ')}。`);
  }
  if (action === PULSE_CONSENT_ACTION) {
    return pulseConsent(service, body.capability, consentParam(body.consent));
  }

  if (typeof service.pulseSession !== 'function') return methodMissing('pulseSession');

  const args = { action };
  if (action === 'start') {
    const minutes = clampInt(body.minutes, PULSE_MINUTES_MIN, PULSE_MINUTES_MAX, null);
    if (minutes !== null) args.minutes = minutes;
  }
  if (action === 'mark') {
    const label = safeToken(body.label, PULSE_LABEL_MAX);
    if (label) args.label = label;
  }

  const called = await callService(service, 'pulseSession', [args]);
  if (!called.ok) {
    const message = action === 'stop' ? '结束心跳会话失败。' : action === 'mark' ? '标记此刻失败。' : '开始心跳会话失败。';
    return failure('internal', message);
  }
  return fromService(called.value);
}
