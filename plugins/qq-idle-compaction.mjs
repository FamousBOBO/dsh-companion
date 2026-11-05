/** qq-idle-compaction：QQ 会话空闲时做一次上下文压缩（可选，**默认关闭**）。
 *
 * 为什么默认关：它每 60 秒醒一次，命中条件时会调用宿主的压缩服务——压缩会走到
 * 模型（计费），属于"后台模型任务"。装好套件就自己开始花调用额度不是默认行为。
 *
 * ## 怎么打开（读两处，环境变量优先）
 *
 * 1. **套件配置**（推荐，用户不需要学环境变量）：`<套件根>/config/suite.json` 里
 *
 *        { "qqIdleCompaction": true }
 *
 *    套件根 = 从本文件所在目录向上找第一个 `package.json` 且 `name === "dsh-companion-suite"`
 *    的目录（与套件其它模块同一条规则）；也可用 `DSH_COMPANION_SUITE_ROOT` 直接指定。
 * 2. **环境变量覆盖**：`QQ_IDLE_COMPACTION=1` 打开、`QQ_IDLE_COMPACTION=0` 强制关闭
 *    （显式写 `0` 时以它为准，用来在某个 profile/命令行里临时压掉配置）。
 *
 * 两者都没有 = 关。**关着时一个定时器都不注册**（`apply()` 直接返回，只写一行日志）。
 *
 * 另两个可调项（都有默认值）：
 *   - `QQ_IDLE_COMPACTION_TZ`（默认 `Asia/Shanghai`）：判断"夜里不做"的时区；
 *   - `QQ_IDLE_COMPACTION_FROM_HOUR`（默认 `4`）：这个整点之前不跑（不半夜烧调用）。
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'qq-idle-compaction';
export const inject = ['agents', 'tokenMeter', 'llm', 'compaction'];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** 套件根识别用的包名（与套件根 `package.json` 一致）。 */
const SUITE_PACKAGE_NAME = 'dsh-companion-suite';
/** 向上找套件根的最多层数（模块可能在 `plugins/` 里，也可能被链进 profile）。 */
const MAX_WALK_UP = 6;

/** `true/false/1/0/yes/no` 都认；其余一律当"没设"（`null`），交给下一层判。 */
function flag(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '') return null;
  if (/^(1|true|yes|on)$/.test(text)) return true;
  if (/^(0|false|no|off)$/.test(text)) return false;
  return null;
}

function isSuiteRoot(dir) {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return false;
  try {
    return JSON.parse(readFileSync(file, 'utf8'))?.name === SUITE_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * 套件根：`DSH_COMPANION_SUITE_ROOT` → 从本文件向上找 `dsh-companion-suite` 的 `package.json`。
 * 找不到返回 `null`（那就只剩环境变量这一条路，默认仍然是关）。
 */
export function findSuiteRoot(env = process.env, from = fileURLToPath(new URL('.', import.meta.url))) {
  const explicit = env.DSH_COMPANION_SUITE_ROOT;
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim());
  let dir = path.resolve(from);
  for (let depth = 0; depth < MAX_WALK_UP; depth++) {
    if (isSuiteRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 套件配置里的 `qqIdleCompaction`：`true` / `false`，没写或读不出来都是 `null`（= 没表态）。
 *
 * 读不出来**不报错**：一个坏掉的 suite.json 不该让插件加载失败，更不该因此变成"开着"。
 */
export function readSuiteFlag(suiteRoot) {
  if (suiteRoot === null || suiteRoot === undefined) return null;
  const file = path.join(suiteRoot, 'config', 'suite.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const value = parsed?.qqIdleCompaction;
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/** 三者的判定顺序：环境变量（显式）→ `config/suite.json` → 默认关。 */
export function decide(env = process.env, suiteRoot = findSuiteRoot(env)) {
  const fromEnv = flag(env.QQ_IDLE_COMPACTION);
  if (fromEnv !== null) return { enabled: fromEnv, source: 'env' };
  const fromConfig = readSuiteFlag(suiteRoot);
  if (fromConfig !== null) return { enabled: fromConfig, source: 'config/suite.json' };
  return { enabled: false, source: 'default' };
}

export function enabled(env = process.env, suiteRoot = findSuiteRoot(env)) {
  return decide(env, suiteRoot).enabled;
}

function hourOf(now, timeZone) {
  const hour = new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(now))
    .find((part) => part.type === 'hour');
  return Number(hour?.value);
}

function lastTurnTime(session) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type === 'turn/end' || event?.type === 'turn/start') return event.time;
  }
}

export function apply(ctx) {
  const decision = decide();
  if (!decision.enabled) {
    console.log(`[qq-idle-compaction] disabled (source: ${decision.source}; `
      + 'set "qqIdleCompaction": true in config/suite.json or QQ_IDLE_COMPACTION=1 to enable)');
    return;
  }

  const timeZone = process.env.QQ_IDLE_COMPACTION_TZ || 'Asia/Shanghai';
  const fromHour = Number(process.env.QQ_IDLE_COMPACTION_FROM_HOUR ?? 4);
  const startHour = Number.isFinite(fromHour) ? fromHour : 4;
  const controller = new AbortController();
  const retryAfter = new WeakMap();
  let running = false;

  async function tick() {
    if (running || controller.signal.aborted) return;
    if (hourOf(Date.now(), timeZone) < startHour) return;
    running = true;
    try {
      for (const agent of ctx.agents.roots()) {
        if (controller.signal.aborted) break;
        const { session } = agent;
        if (!/^qq-(?:dm|group)-\d+$/.test(session.id) || agent.status !== 'idle') continue;
        const now = Date.now();
        if ((retryAfter.get(session) ?? 0) > now) continue;
        const lastTurn = lastTurnTime(session);
        if (!Number.isFinite(lastTurn) || now - lastTurn <= HOUR_MS) continue;
        const seq = session.seq;
        const route = session.requestHeader()?.config;
        if (!route?.provider || !route?.model) continue;
        try {
          const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
          const window = info.context?.contextWindow;
          if (controller.signal.aborted || session.seq !== seq || agent.status !== 'idle') continue;
          if (!Number.isFinite(window) || window <= 0) continue;
          const { totalTokens } = ctx.tokenMeter.measure(session);
          if (!Number.isFinite(totalTokens) || totalTokens <= 0.9 * window) continue;
          if (hourOf(Date.now(), timeZone) < startHour) break;
          retryAfter.set(session, Date.now() + HOUR_MS);
          const result = await ctx.compaction.compactNow(agent, controller.signal);
          if (result) console.log(`[qq-idle-compaction] ${session.id} compacted (${totalTokens}/${window} tokens)`);
        } catch (error) {
          if (!controller.signal.aborted) console.warn(`[qq-idle-compaction] ${session.id}: ${error.message}`);
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick().catch(error => console.warn(`[qq-idle-compaction] ${error.message}`));
  }, MINUTE_MS);
  timer.unref?.();
  ctx.on('dispose', () => {
    clearInterval(timer);
    controller.abort();
  });
  console.log(`[qq-idle-compaction] scheduled (source: ${decision.source}, `
    + `${startHour}:00–24:00 ${timeZone}, >90% window, >1h idle)`);
}
