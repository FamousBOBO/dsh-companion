/**
 * Cordis 插件入口：`companion-expression`（设计文档 §3）。
 * 两道默认关闭的闸（AGENTS.md 硬规则 2），两处都开才可能出现真发送：
 *   1. 套件级 `modules.expression`（`config/suite.json` 或 `DSH_COMPANION_MODULES_EXPRESSION=1`）：
 *      关着就整模块不工作 —— 不 publish、不注册工具、不打开库；
 *   2. 模块级 `delivery.enabled`（`home/expression/config.json`）：关着时工具仍在（可查候选、
 *      可记反馈），但任何真实发送路径都被拒绝（`decision` 与 `delivery` 各查一次）。
 *
 * 与 `companion-health/index.mjs` 同款：`apply()` 永不抛、单例复用、先 publish 再初始化、
 * 返回 disposer（并挂 `ctx.effect`，只有当前激活轮次能拆）。入站旁路端口
 * `process[Symbol.for('dsh.companion.expression.v1')]` 只同步入队 —— 不回复、不唤醒 Agent。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_CONFIG, loadConfig } from './config.mjs';
import { expressionPaths } from './paths.mjs';
import { openExpressionDb } from './db.mjs';
import { makeScopeSalt, scopesFor } from './scopes.mjs';
import { createLibrary } from './library.mjs';
import { fromLibrary, retrieve } from './retrieval.mjs';
import { decide, quotaBucketFor } from './decision.mjs';
import { plan as buildPlan, partJobs } from './planner.mjs';
import { deliver } from './delivery.mjs';
import { createFeedback, feedbackScoreOf, isSuppressed } from './feedback.mjs';
import { createToolHandlers, parametersToJsonSchema, TOOL_SPECS } from './tools.mjs';

export const name = 'companion-expression';
export const inject = ['tools'];
export const version = '0.1.0';
export const PORT_SYMBOL = Symbol.for('dsh.companion.expression.v1');
export const MODULE_ENV = 'DSH_COMPANION_MODULES_EXPRESSION';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SUITE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

let singleton = null;
let ownerEpoch = 0;
let epoch = 0;

function note(text) {
  try { console.log(`[companion-expression] ${String(text).slice(0, 400)}`); } catch { /* ignore */ }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 套件级模块开关：环境变量优先于 `config/suite.json`；都没有就是 `false`（安全默认）。 */
export function moduleGate({ env = process.env, suiteRoot = SUITE_ROOT } = {}) {
  const fromEnv = String(env?.[MODULE_ENV] ?? '').trim().toLowerCase();
  if (fromEnv) return { enabled: !['0', 'false', 'no', 'off'].includes(fromEnv), source: `env:${MODULE_ENV}` };
  const suite = readJson(path.join(suiteRoot, 'config', 'suite.json'));
  if (suite && typeof suite === 'object' && suite.modules && typeof suite.modules.expression === 'boolean') {
    return { enabled: suite.modules.expression === true, source: 'config/suite.json:modules.expression' };
  }
  return { enabled: false, source: 'default:off' };
}

function mergeConfig(config) {
  return {
    ...DEFAULT_CONFIG, ...config,
    delivery: { ...DEFAULT_CONFIG.delivery, ...config?.delivery },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...config?.retrieval },
  };
}

/** 作用域盐：第一次用时生成并落库，之后每次读同一份；绝不把裸 QQ 号进库。 */
function saltOf(db) {
  const existing = db.meta('scope_salt');
  if (existing) return existing;
  const salt = makeScopeSalt(randomBytes);
  db.setMeta('scope_salt', salt);
  return salt;
}

/** 会话 → 作用域 + 目标。owner 判定由调用方注入，缺省一律按 peer（宁可少发，也不越权）。 */
function contextOf(state, { chatId = 0, isGroup = false } = {}) {
  const salt = saltOf(state.db);
  const isOwner = state.isOwnerFor({ chatId, isGroup }) === true;
  const scopes = scopesFor({ kind: isGroup ? 'group' : 'dm', chatId, isOwner, salt, config: state.config });
  return { scopes, salt, kind: isGroup ? 'group' : 'dm', id: Number(chatId) || 0 };
}

/** 检索一次（共用同一组注入：正反馈分与显式抑制都读库）。 */
function searchFor(state, { usable, scope, query, limit = 5 }) {
  return retrieve({
    library: fromLibrary(state.library), usable, scope,
    context: { query: String(query ?? ''), intents: [], scenes: [] },
    limit, minFitScore: 0, now: state.clock(),
    feedbackScore: ({ assetId, scope: scopeKey }) => feedbackScoreOf({ db: state.db, assetId, scope: scopeKey }),
    isSuppressed: ({ assetId, scope: scopeKey }) => isSuppressed({ db: state.db, assetId, scope: scopeKey }),
  });
}

/** 候选：只读，不发图。没有候选是正常结果。 */
async function listCandidates(state, { isGroup = false, target = '', query = '', limit = 5 } = {}) {
  try {
    const ctx = contextOf(state, { chatId: Number(target) || 0, isGroup });
    if (!ctx.scopes.usable.length) {
      return { ok: true, candidates: [], send: false, reasonCode: 'scope-not-visible', message: '本会话没有可用的表情包作用域（未授权），不发图。' };
    }
    const found = searchFor(state, { usable: ctx.scopes.usable, scope: ctx.scopes.own, query, limit });
    const decision = decide({
      db: state.db, config: state.config, target: { kind: ctx.kind, id: ctx.id },
      scope: ctx.scopes.own, candidates: found.candidates, draft: '', now: state.clock(),
    });
    return {
      ok: true, candidates: found.candidates, send: decision.send, mode: decision.mode,
      reasonCode: decision.reasonCode, message: decision.message, fitScore: decision.fitScore,
      warnings: [...(found.warnings ?? []), ...state.warnings],
    };
  } catch (error) {
    return { ok: false, candidates: [], send: false, reasonCode: 'service-threw', message: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 发图：候选 → 决策 → 计划 → 投递。任何阶段失败都如实回报，不假装发过。 */
async function replyWithSticker(state, { assetId = '', mode = '', text = '', isGroup = false, target = '' } = {}) {
  if (!state.options.qqSender) {
    return { ok: false, delivered: 0, reasonCode: 'sender-unavailable', message: '没有注入 QQ 发送器：本轮不会发图。' };
  }
  if (state.config.delivery.enabled !== true) {
    return { ok: false, delivered: 0, reasonCode: 'delivery-disabled', message: 'delivery.enabled 为 false：模块已挂载但不会真发图。' };
  }
  try {
    const ctx = contextOf(state, { chatId: Number(target) || 0, isGroup });
    const found = searchFor(state, { usable: ctx.scopes.usable, scope: ctx.scopes.own, query: text, limit: 5 });
    const picked = assetId ? [{ assetId, fitScore: 1 }] : found.candidates;
    const decision = decide({
      db: state.db, config: state.config, target: { kind: ctx.kind, id: ctx.id },
      scope: ctx.scopes.own, candidates: picked, draft: text, now: state.clock(),
    });
    if (!decision.send) return { ok: false, delivered: 0, reasonCode: decision.reasonCode, message: decision.message };
    const planned = buildPlan({
      turnId: `t${Math.trunc(state.clock())}`, target: { kind: ctx.kind, id: ctx.id },
      draft: text, mode: mode || decision.mode, assetId: decision.assetId, now: state.clock(),
    });
    // 配额/冷却按**会话**算（不是按计划）：bucketKey 必须稳定，否则每条计划都会拿到一个空桶。
    const bucketKey = quotaBucketFor({ kind: ctx.kind, id: ctx.id, scope: ctx.scopes.own });
    const result = await deliver({
      plan: { ...planned, scope: ctx.scopes.own, bucketKey },
      library: state.library, db: state.db, config: state.config, dataRoot: state.dataRoot,
      qqSender: state.options.qqSender, scope: ctx.scopes.own, usable: ctx.scopes.usable,
      kind: ctx.kind, target: { kind: ctx.kind, id: ctx.id }, now: state.clock(),
    });
    return {
      ok: result.ok, delivered: result.delivered, mode: result.mode, degraded: result.degraded,
      reasonCode: result.reasonCode, parts: result.results.length, message: result.warnings?.[0] ?? '',
    };
  } catch (error) {
    return { ok: false, delivered: 0, reasonCode: 'service-threw', message: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 反馈：显式三态；沉默不记；群反馈只进图库。 */
async function recordExpressionFeedback(state, { assetId = '', action = '', note = '', isGroup = false, target = '' } = {}) {
  try {
    const ctx = contextOf(state, { chatId: Number(target) || 0, isGroup });
    return state.feedback.record({ action, assetId: assetId || null, scope: ctx.scopes.own, note, confidence: 1 });
  } catch (error) {
    return { ok: false, recorded: false, reasonCode: 'service-threw', message: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 统计：图库 + 投递 + 反馈 + 事件计数。只读，不含图片内容。 */
function libraryStats(state, { limit = 10 } = {}) {
  try {
    const counts = state.library.stats();
    const rows = state.db.all('SELECT status, count(*) AS n FROM deliveries GROUP BY status')
      .map(row => ({ status: String(row.status), n: Number(row.n) }));
    const recent = state.db.all('SELECT plan_id, part_index, asset_id, status, at FROM deliveries ORDER BY at DESC LIMIT ?',
      [Math.max(1, Math.min(50, Number(limit) || 10))])
      .map(row => ({ planId: String(row.plan_id), index: Number(row.part_index), assetId: row.asset_id ?? null, status: String(row.status), at: Number(row.at) }));
    return {
      ok: true, ...counts, deliveries: rows.reduce((sum, row) => sum + row.n, 0),
      deliveryByStatus: Object.fromEntries(rows.map(row => [row.status, row.n])), recent,
      deliveryEnabled: state.config.delivery.enabled === true, events: { ...state.events },
      integrity: state.db.integrity().ok,
    };
  } catch (error) {
    return { ok: false, reasonCode: 'stats-failed', message: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 入站旁路：同步入队，绝不 await、绝不抛。没有注入 ingest/http 就只计数。 */
function observeInbound(state, event = {}) {
  state.events.observed += 1;
  state.events.lastAt = Math.trunc(state.clock());
  if (typeof state.options.ingest !== 'function' || !state.options.http) {
    state.events.dropped += 1;
    return { ok: false, queued: false, reasonCode: 'ingest-not-injected' };
  }
  try {
    state.events.queued += 1;
    Promise.resolve(state.options.ingest(event)).catch(() => { state.events.dropped += 1; });
    return { ok: true, queued: true };
  } catch {
    state.events.dropped += 1;
    return { ok: false, queued: false, reasonCode: 'ingest-threw' };
  }
}

/**
 * 组装 service。副作用（开库、读配置）都在 try/catch 里：失败返回可读的 `{ok:false, reason}`。
 * @param {{dataRoot?: string, env?: object, qqSender?: object|null, http?: object|null,
 *   ingest?: Function|null, isOwner?: Function|null, now?: Function|null}} options
 */
export function createService(options = {}) {
  const env = options.env ?? process.env;
  const dataRoot = options.dataRoot ?? expressionPaths({ moduleUrl: import.meta.url, env }).dataRoot;
  const paths = expressionPaths({ moduleUrl: import.meta.url, env });
  const loaded = loadConfig({ file: paths.configFile, dataRoot });
  const config = mergeConfig(loaded.config);
  const clock = options.now ?? (() => Date.now());
  let db;
  try {
    db = openExpressionDb({ file: paths.dbFile, now: clock });
  } catch (error) {
    return { ok: false, disabled: true, reason: `db-open-failed: ${String(error?.message ?? error).slice(0, 160)}`, config, warnings: loaded.warnings };
  }
  const library = createLibrary({ db, assetsDir: paths.assets, now: clock });
  const state = {
    config, dataRoot, paths, db, clock, options, library,
    feedback: createFeedback({ db, library, config, now: clock }),
    events: { observed: 0, dropped: 0, queued: 0, lastAt: 0 },
    warnings: [...(loaded.warnings ?? [])],
    isOwnerFor: typeof options.isOwner === 'function' ? options.isOwner : () => false,
  };
  return {
    ok: true, config, warnings: state.warnings, library: state.library, db, paths, events: state.events,
    /** 反馈句柄（Studio 用：summary / clearSuppression 之类）。 */
    feedbackHandle: state.feedback,
    observe: event => observeInbound(state, event),
    // 下面四个就是 tools.mjs 的 service 门面（名字与那边对齐，工具只认这四个）。
    candidates: input => listCandidates(state, input),
    reply: input => replyWithSticker(state, input),
    feedback: input => recordExpressionFeedback(state, input),
    stats: input => libraryStats(state, input),
    partsOf: planLike => partJobs(planLike),
    close: () => { try { db.close(); } catch { /* already closed */ } },
  };
}

/** 宿主 defineTool：运行时从模块根动态取，取不到就返回 null（只写日志，不注册工具）。 */
async function resolveDefineTool(env = process.env, log = note) {
  const runtimeRoot = String(env?.DSH_COMPANION_MODULE_ROOT ?? '').trim();
  if (!runtimeRoot) {
    log('没有 DSH_COMPANION_MODULE_ROOT：工具不注册（宿主仍可加载本插件）。');
    return null;
  }
  try {
    const module = await import(pathToFileURL(path.join(runtimeRoot, '@deepseek-ai/dsh-tools/lib/index.js')).href);
    return typeof module.defineTool === 'function' ? module.defineTool : null;
  } catch (error) {
    log(`导入 @deepseek-ai/dsh-tools 失败（${String(error?.message ?? error).slice(0, 120)}）：工具不注册。`);
    return null;
  }
}

/** 与宿主 defineTool 相同的属性映射投影来自 tools.mjs（同一实现只有一份）。 */
export { parametersToJsonSchema };
/** 取 `ctx.tools.register`。**必须包 try**：宿主的服务是 getter/Proxy，访问本身就可能抛
 *  （实测 `ctx.tools` 的 getter 抛错会连累整个 apply）。 @returns {Function|null} */
function toolRegisterOf(ctx) {
  try {
    const tools = ctx?.tools;
    return typeof tools?.register === 'function' ? tools.register.bind(tools) : null;
  } catch (error) {
    note(`读取 ctx.tools 失败：${String(error?.message ?? error).slice(0, 160)}`);
    return null;
  }
}

/** 注册四个工具；每次注册单独 try/catch，一个坏 shim 不能让另外三个消失。 */
function registerTools(register, service, defineTool, log) {
  const handlers = createToolHandlers({ service });
  let registered = 0;
  for (const spec of TOOL_SPECS) {
    try {
      const definition = {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async (args, exec) => JSON.stringify(await handlers[spec.name](args ?? {}, exec)),
        presentCall: () => ({ card: 'generic', title: spec.name, kind: spec.kind }),
      };
      const tool = typeof defineTool === 'function' ? defineTool(definition) : definition;
      if (typeof defineTool !== 'function') tool.parameters = parametersToJsonSchema(spec.parameters);
      register(tool);
      registered += 1;
    } catch (error) {
      log(`注册 ${spec.name} 失败：${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
  return registered;
}

/** 发布入站端口（进程级）。返回释放函数，幂等。 */
function publishPort(service, log) {
  let released = false;
  const port = Object.freeze({
    version: 1, service, observe: service.observe, status: () => service.stats({ limit: 3 }),
  });
  try {
    process[PORT_SYMBOL] = port;
    log('已发布入站端口 dsh.companion.expression.v1（只入队，不回复、不唤醒 Agent）。');
  } catch (error) {
    log(`发布端口失败：${String(error?.message ?? error).slice(0, 160)}`);
  }
  return () => {
    if (released) return;
    released = true;
    try { if (process[PORT_SYMBOL] === port) delete process[PORT_SYMBOL]; } catch { /* gone */ }
  };
}

/** 取（或复用）本次进程的 service。返回 `{service, reused}`；创建失败时 service 为 null。 */
function acquireService(options, env) {
  if (singleton && singleton.ok !== false) return { service: singleton, reused: true };
  try {
    singleton = createService({ ...options, env });
  } catch (error) {
    note(`创建 service 失败：${String(error?.message ?? error).slice(0, 200)}`);
    return { service: null, reused: false };
  }
  return { service: singleton, reused: false };
}

/**
 * Cordis `apply`。永不抛；返回 disposer。
 * @param {object} ctx Cordis 上下文
 * @param {{dataRoot?: string, qqSender?: object, http?: object, ingest?: Function, isOwner?: Function,
 *   env?: object, now?: Function}} [options]
 */
export async function apply(ctx, options = {}) {
  epoch += 1;
  ownerEpoch = epoch;
  const env = options.env ?? process.env;
  const gate = moduleGate({ env, suiteRoot: SUITE_ROOT });
  if (!gate.enabled) {
    note(`modules.expression 关闭（${gate.source}）：不 publish、不注册工具、不打开图库。`);
    return undefined;
  }
  const { service, reused } = acquireService(options, env);
  if (!service) return undefined;
  if (service.ok === false) note(`图库不可用：${service.reason ?? 'unknown'}；工具仍注册，但只会如实报错。`);
  // 第三道（模块自己的）开关：`home/expression/config.json` 的 `enabled:false`。
  // 与套件级 modules.expression 一样是「整模块关闭」：不 publish、不注册工具、不留句柄。
  if (service.ok !== false && service.config?.enabled === false) {
    note('模块配置 enabled=false（home/expression/config.json）：不 publish、不注册工具。');
    try { service.close(); } catch { /* already closed */ }
    if (singleton === service) singleton = null;
    return undefined;
  }

  let release = () => {};
  try { release = publishPort(service, note); } catch (error) { note(`publish 失败：${String(error?.message ?? error).slice(0, 160)}`); }

  const defineTool = await resolveDefineTool(env, note);
  const register = toolRegisterOf(ctx);
  if (register) {
    const count = registerTools(register, service, defineTool, note);
    note(count > 0 ? `已注册 ${count} 个工具（defineTool=${typeof defineTool === 'function' ? 'host' : 'local'}）` : '工具一个也没注册：ctx.tools.register 不可用。');
  } else {
    note("ctx.tools 不可用：inject:['tools'] 未满足，工具不注册（其余能力不受影响）。");
  }
  try { if (typeof ctx?.provide === 'function') ctx.provide('companionExpression', service); } catch (error) {
    note(`provide('companionExpression') 失败：${String(error?.message ?? error).slice(0, 120)}`);
  }

  const mine = ownerEpoch;
  const dispose = () => {
    if (ownerEpoch !== mine) return;
    try { release(); } catch { /* already released */ }
    try { service.close(); } catch (error) { note(`close 失败：${String(error?.message ?? error).slice(0, 120)}`); }
    if (singleton === service) singleton = null;
  };
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, 'companion-expression: service lifetime');
    else ctx?.on?.('dispose', dispose);
  } catch (error) {
    note(`生命周期注册失败：${String(error?.message ?? error).slice(0, 160)}`);
  }
  if (reused) note('复用 service 已就绪。');
  return dispose;
}

export { createService as createExpressionService };
export default { name, inject, version, PORT_SYMBOL, apply, createService, moduleGate, parametersToJsonSchema };
