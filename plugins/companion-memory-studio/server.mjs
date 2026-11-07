// 记忆档案 Studio · Host HTTP API 挂载点。
//
// 路由键统一为 `METHOD path`，值是 (request) => Promise<Response>，
// 全部经 kernel 的信封与错误兜底。registerStudioApi 在没有 Connection 服务
// 的 composition 里静默跳过（不影响宿主启动）。

import { createKernel, errorEnvelope, respond } from './lib/api-kernel.mjs';
import * as operator from './lib/operator.mjs';
import { personaSettings } from './lib/persona-settings.mjs';
import { chatSettings } from './lib/chat-settings.mjs';
import * as read from './lib/read.mjs';
import * as write from './lib/write.mjs';
import * as health from './lib/health.mjs';
import { collectorTerminals } from './lib/collector-terminals.mjs';
import { companionDashboard } from './lib/companion-dashboard.mjs';
// The health service is owned by a sibling plugin row; `resolveHealthService` is the one place that
// knows how to reach it (ctx → process registry → service bridge).
import { resolveHealthService } from '../companion-foundation/health-service-ref.mjs';
import { resolveSuitePaths } from '../companion-foundation/suite-paths.mjs';

/**
 * The companion **data** root (D2), not the checkout root: the health bridge keys its
 * registry and diagnostics by this path, so using the source directory here would
 * split the key (two services for one home) and write `home/health/` into the repo.
 */
export const STUDIO_ROOT = resolveSuitePaths({ moduleUrl: import.meta.url }).dataRoot;

export const API_PREFIX = '/api/companion-memory';
/** 健康接口的独立前缀（契约 §13）；meta.source 也跟着换成 `companion-health`。 */
export const HEALTH_API_PREFIX = health.HEALTH_PREFIX;

// 精确路径匹配；参数走 query string / JSON body。
export const ROUTES = Object.freeze([
  { name: 'collector-terminals', method: 'GET', path: `${API_PREFIX}/collector-terminals`, handler: collectorTerminals },
  { name: 'collector-terminal-control', method: 'POST', path: `${API_PREFIX}/collector-terminals`, handler: collectorTerminals },
  {name:'chat-settings',method:'GET',path:`${API_PREFIX}/chat-settings`,handler:chatSettings},
  {name:'chat-settings-save',method:'POST',path:`${API_PREFIX}/chat-settings`,handler:chatSettings},
  {name:'restart-status',method:'GET',path:`${API_PREFIX}/restart-status`,handler:operator.pendingRestart},
  {name:'persona',method:'GET',path:`${API_PREFIX}/persona`,handler:personaSettings},
  {name:'persona-save',method:'POST',path:`${API_PREFIX}/persona`,handler:personaSettings},
  {name:'runtime-logs-stream',method:'GET',path:`${API_PREFIX}/runtime-logs/stream`,handler:operator.runtimeLogsStream},
  {name:'web-panel-control',method:'POST',path:`${API_PREFIX}/web-panel-control`,handler:operator.webPanelControl},
  {name:'runtime-settings',method:'GET',path:`${API_PREFIX}/runtime-settings`,handler:operator.runtimeSettings},
  {name:'runtime-settings-write',method:'POST',path:`${API_PREFIX}/runtime-settings`,handler:operator.runtimeSettings},
  {name:'runtime-logs',method:'GET',path:`${API_PREFIX}/runtime-logs`,handler:operator.runtimeLogs},
  {name:'web-panel',method:'GET',path:`${API_PREFIX}/web-panel`,handler:operator.webPanel},
  {name:'web-panel-write',method:'POST',path:`${API_PREFIX}/web-panel`,handler:operator.webPanel},
  { name: 'companion', method: 'GET', path: `${API_PREFIX}/companion`, handler: companionDashboard },
  { name: 'summary', method: 'GET', path: `${API_PREFIX}/summary`, handler: read.summary },
  { name: 'memories', method: 'GET', path: `${API_PREFIX}/memories`, handler: read.memories },
  { name: 'memory-detail', method: 'GET', path: `${API_PREFIX}/memory`, handler: read.memoryDetail },
  { name: 'memory-write', method: 'POST', path: `${API_PREFIX}/memory`, handler: write.memoryWrite },
  { name: 'wiki', method: 'GET', path: `${API_PREFIX}/wiki`, handler: read.wikiIndex },
  { name: 'wiki-page', method: 'GET', path: `${API_PREFIX}/wiki-page`, handler: read.wikiPage },
  { name: 'wiki-page-write', method: 'POST', path: `${API_PREFIX}/wiki-page`, handler: write.wikiPageWrite },
  { name: 'preview', method: 'GET', path: `${API_PREFIX}/preview`, handler: read.preview },
  { name: 'reviews', method: 'GET', path: `${API_PREFIX}/reviews`, handler: read.reviews },
  { name: 'review-write', method: 'POST', path: `${API_PREFIX}/review`, handler: write.reviewAction },
  { name: 'settings', method: 'GET', path: `${API_PREFIX}/settings`, handler: read.settings },
  { name: 'settings-write', method: 'POST', path: `${API_PREFIX}/settings`, handler: write.settingsWrite },
  { name: 'settings-test', method: 'POST', path: `${API_PREFIX}/settings/test`, handler: write.settingsProbe },
  { name: 'timeline', method: 'GET', path: `${API_PREFIX}/timeline`, handler: read.timeline },
  { name: 'maintenance', method: 'POST', path: `${API_PREFIX}/maintenance`, handler: write.maintenance },
  { name: 'plan-slot', method: 'POST', path: `${API_PREFIX}/plan-slot`, handler: write.planSlotAction },
  // task-40: 纠正裁决。GET 只读列表（含旧记忆正文），POST 是**唯一**的写入口，
  // 且它只调 runtime 的 `resolveAmbiguousCorrection()`（事件/审计都在 runtime 侧）。
  { name: 'corrections', method: 'GET', path: `${API_PREFIX}/corrections`, handler: read.corrections },
  { name: 'corrections-write', method: 'POST', path: `${API_PREFIX}/corrections`, handler: write.correctionResolve },
]);

/**
 * 健康数据路由（契约 §13，Owner-only 只读 + 两个明确动作）。
 *
 * 独立成一张表而不是混进 `ROUTES`，只是为了让"记忆库路由"与"健康路由"各自可读、
 * 各自可被测试按表断言；注册时两张表合成 `ALL_ROUTES`，**无条件**一起挂（见
 * `registerStudioApi` 里的说明）：health 服务没挂上时这些路径仍然存在，
 * 回 `health-unavailable`（HTTP 200），不会 404、也不会因为 profile 顺序变化而失联。
 */
export const HEALTH_ROUTES = Object.freeze([
  { name: 'health-status', method: 'GET', path: `${HEALTH_API_PREFIX}/status`, handler: health.healthStatus },
  { name: 'health-sources', method: 'GET', path: `${HEALTH_API_PREFIX}/sources`, handler: health.healthSources },
  { name: 'health-today', method: 'GET', path: `${HEALTH_API_PREFIX}/today`, handler: health.healthToday },
  { name: 'health-trends', method: 'GET', path: `${HEALTH_API_PREFIX}/trends`, handler: health.healthTrends },
  { name: 'health-sleep', method: 'GET', path: `${HEALTH_API_PREFIX}/sleep`, handler: health.healthSleep },
  { name: 'health-sync', method: 'POST', path: `${HEALTH_API_PREFIX}/sync`, handler: health.healthSync },
  {
    name: 'health-maintenance', method: 'POST', path: `${HEALTH_API_PREFIX}/maintenance`,
    handler: health.healthMaintenance,
  },
  // 心跳共振（design/pulse-bond-20261103.md §7）：GET 读现场读数，POST 驱动会话与授权开关。
  // 同一路径两条方法共用一条 group（Exact Fetch 按 path 去重，见 groupRoutesByPath）。
  { name: 'health-pulse', method: 'GET', path: `${HEALTH_API_PREFIX}/pulse`, handler: health.pulseStatus },
  { name: 'health-pulse-action', method: 'POST', path: `${HEALTH_API_PREFIX}/pulse`, handler: health.pulseAction },
  // 主动关怀（`health.care.proactive`）：只读。**没有** POST —— 开启/关闭走既有的
  // `POST /pulse` 的 consent 动作（同一条写路径），这里不新增第二条改授权的口子。
  { name: 'health-care', method: 'GET', path: `${HEALTH_API_PREFIX}/care`, handler: health.healthCare },
]);

/** 全部路由（记忆库 + 健康）；`createStudioHandlers` / `groupRoutesByPath` 的默认输入。 */
export const ALL_ROUTES = Object.freeze([...ROUTES, ...HEALTH_ROUTES]);

/**
 * 生成路由处理器表。
 * @param engine    记忆引擎门面（必须带 internal()）
 * @param identity  身份服务（仅作上下文；viewer 一律由 internal() 提供）
 * @param root      工作区根目录
 * @param log       可选日志回调，只接收固定 code
 * @param health    可选惰性访问器 `() => service|null`；健康插件没装时返回 null 即可，
 *                  健康路由**仍然**出现在表里并回 `health-unavailable`（不会 404）。
 * @returns {Record<string, (request: Request) => Promise<Response>>}
 */
export function createStudioHandlers({ engine = null, identity = null, root = '', log = null, ...options } = {}) {
  const kernel = createKernel({ engine, identity, root, log });
  const handlers = Object.create(null);
  for (const route of ALL_ROUTES) {
    const key = `${route.method} ${route.path}`;
    // 第三个参数是宿主级可选依赖（例如 fetchImpl / runtime / health），用于设置探测与健康路由的离线测试。
    handlers[key] = kernel.guard(route.name, request => route.handler(request, kernel, options));
  }
  return handlers;
}

/**
 * Connection 的 Exact Fetch 登记表**按路径**去重（`fetchRoutes` 以 path 为键），
 * 所以同一路径上的 GET 与 POST 必须合成一条路由、在内部按方法分发；
 * 分成两条会抛 `route "..." is already registered` 并让后续路由整批失联。
 */
export function groupRoutesByPath(routes = ALL_ROUTES) {
  const grouped = new Map();
  for (const route of routes) {
    const entry = grouped.get(route.path) || { path: route.path, names: [], methods: [], handlers: new Map() };
    entry.names.push(route.name);
    if (!entry.methods.includes(route.method)) entry.methods.push(route.method);
    entry.handlers.set(route.method, route.handler);
    grouped.set(route.path, entry);
  }
  return [...grouped.values()];
}

/**
 * 注册到宿主 Connection 的 fetch 服务。缺少 Connection 时返回
 * `{ registered: 0, skipped: 'no-connection' }`，不抛错。
 */
export async function registerStudioApi(ctx, deps = {}) {
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    return { registered: 0, skipped: 'no-connection' };
  }

  // H5: the plan-slot controls must write through the live runtime (event path + lease), so
  // the handler gets a *lazy* accessor — a composition without the runtime still mounts every
  // other route and the control answers `plan-slot-unavailable` instead of lying.
  // A2: `health` 用同一套惰性写法 —— 健康服务晚挂载/被摘掉都不影响路由本身。
  const withRuntime = {
    ...deps,
    runtime: () => (typeof ctx?.get === 'function' ? (ctx.get('companionRuntime') ?? null) : null),
    // `ctx.get` alone is not enough: the health row is a *sibling* of this bundle, and a service
    // provided on a sibling's ctx is not visible here. `resolveHealthService` also tries the
    // process-wide registry and the service bridge (2026-11-04 — before this, every health route
    // answered `health-unavailable` in production while the service was running).
    health: () => resolveHealthService(ctx, STUDIO_ROOT),
  };
  const handlers = createStudioHandlers(withRuntime);
  // 宿主可能没有 ctx.effect（单测桩）；没有时直接执行注册函数。
  const effect = typeof ctx.effect === 'function' ? ctx.effect : runner => runner();

  // 同一路径上没登记的方法返回 405 信封，而不是落进 404。
  const methodNotAllowed = allowed => respond(
    errorEnvelope('bad-request', `该路径只支持 ${allowed.join(' / ')}。`),
    405,
  );

  // 契约 §13：健康路由**无条件**注册 —— 没挂上 health 服务时也照样占位并回
  // `health-unavailable`（HTTP 200），不能 404、不能崩宿主、也不依赖 profile 的挂载顺序。
  let registered = 0;
  for (const group of groupRoutesByPath(ALL_ROUTES)) {
    effect(
      () => connection.fetch.register({
        path: group.path,
        methods: group.methods,
        requestBody: 'buffered',
        fetch: request => {
          const route = handlers[`${request.method} ${group.path}`];
          if (!route) return methodNotAllowed(group.methods);
          return route(request);
        },
      }),
      `companion-memory-studio: ${group.names.join('+')} route`,
    );
    registered += 1;
  }
  return { registered, paths: [...new Set(ALL_ROUTES.map(route => route.path))] };
}
