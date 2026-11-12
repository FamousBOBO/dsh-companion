/**
 * Prompt Engine — 配置读取 / 校验 / 默认值（T1）。
 *
 * 依据 `PROMPT-ENGINE-CONTRACT.md` §2.1。纯读：只读一个 JSON 文件，**从不创建、从不覆盖**，
 * 非法内容一律安全回退到默认值并留下 warnings，绝不抛错——配置坏了不能影响聊天。
 */

import fs from 'node:fs';
import path from 'node:path';

export const PROMPT_CONFIG_VERSION = 1;

/** 交互模式（用户显式控制）。`auto` 是默认：由路由自主判断。 */
export const PROMPT_INTERACTION_MODES = Object.freeze(['auto', 'chat', 'companion', 'roleplay', 'task']);

/** 认知执行等级（§8）。 */
export const PROMPT_THINKING_MODES = Object.freeze(['guided', 'structured', 'strict']);

/** 引擎模式（§10）：`off` 完全不改变对话；`shadow` 只算不注入；`active` 正式注入。 */
export const PROMPT_MODES = Object.freeze(['off', 'shadow', 'active']);

/** 路由实际会输出的四个场景模式（`roleplay` 由强度细分，见 §2.2）。 */
export const ROUTE_MODES = Object.freeze(['chat', 'companion', 'roleplay', 'task']);

/** 预算钳制范围：低于 120 不够表达任何一条规则，高于 4000 会挤占宿主提示词。 */
export const BUDGET_MIN = 120;
export const BUDGET_MAX = 4000;

/** 配置默认值：与任务书 §10 的默认配置逐字一致，只是补齐了 `modules` / `routing` 两项。 */
export const DEFAULT_PROMPT_CONFIG = Object.freeze({
  schemaVersion: PROMPT_CONFIG_VERSION,
  enabled: false,
  mode: 'off',
  interactionMode: 'auto',
  thinkingMode: Object.freeze({ chat: 'guided', companion: 'guided', roleplay: 'guided', task: 'guided' }),
  planner: Object.freeze({
    enabled: false,
    provider: '',
    model: '',
    reasoningEffort: 'low',
    maxInputChars: 8000,
    maxOutputTokens: 800,
    timeoutMs: 20000,
    maxCallsPerTurn: 1,
  }),
  review: Object.freeze({ enabled: false, maxRepairCalls: 1 }),
  budgets: Object.freeze({ chat: 600, companion: 800, roleplay: 1300, task: 500 }),
  modules: Object.freeze({ disabled: Object.freeze([]) }),
  routing: Object.freeze({ carryOverTurns: 6, maxHistoryTurns: 12 }),
});

/** 配置文件的固定位置：`<数据根>/home/companion/prompt-engine.config.json`（任务书 §10）。 */
export function promptConfigFile(root) {
  if (!root) return '';
  return path.join(String(root), 'home', 'companion', 'prompt-engine.config.json');
}

function clampNumber(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, Math.trunc(number)));
}

function pickEnum(value, allowed, fallback, warnings, label) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (allowed.includes(text)) return text;
  warnings.push(`${label}: 非法的取值 ${JSON.stringify(text)}，已回落到 ${fallback}`);
  return fallback;
}

function pickString(value, maxChars, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxChars);
}

/**
 * 归一化一份配置。导出是为了让测试与 Studio（P2）能校验用户输入，而不必经过文件。
 *
 * @param {unknown} raw 任意用户输入
 * @returns {{ config: object, warnings: string[] }}
 */
export function sanitizePromptConfig(raw) {
  const warnings = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('顶层不是对象，整份配置按默认值处理');
  }
  if (source.schemaVersion !== undefined && Number(source.schemaVersion) !== PROMPT_CONFIG_VERSION) {
    warnings.push(`schemaVersion ${JSON.stringify(source.schemaVersion)} 不是 ${PROMPT_CONFIG_VERSION}，按 ${PROMPT_CONFIG_VERSION} 解释`);
  }

  const enabled = source.enabled === true;
  // `enabled: false` 拥有最高关闭优先级（§10）：任何 mode 都不能把它复活。
  let mode = pickEnum(source.mode, PROMPT_MODES, 'off', warnings, 'mode');
  if (!enabled) mode = 'off';
  else if (mode === 'off') {
    // enabled 但 mode 是 off：这是合法的“已安装未启用”，不报警，保持 off。
    mode = 'off';
  }

  const interactionMode = pickEnum(source.interactionMode, PROMPT_INTERACTION_MODES, 'auto', warnings, 'interactionMode');

  const thinkingSource = source.thinkingMode && typeof source.thinkingMode === 'object' ? source.thinkingMode : {};
  const thinkingMode = {};
  for (const modeKey of ROUTE_MODES) {
    thinkingMode[modeKey] = pickEnum(thinkingSource[modeKey], PROMPT_THINKING_MODES, 'guided', warnings, `thinkingMode.${modeKey}`);
  }

  const plannerSource = source.planner && typeof source.planner === 'object' ? source.planner : {};
  const planner = {
    enabled: plannerSource.enabled === true,
    provider: pickString(plannerSource.provider, 80),
    model: pickString(plannerSource.model, 120),
    reasoningEffort: pickString(plannerSource.reasoningEffort, 20, 'low') || 'low',
    maxInputChars: clampNumber(plannerSource.maxInputChars, 1000, 40000, 8000),
    maxOutputTokens: clampNumber(plannerSource.maxOutputTokens, 200, 4000, 800),
    timeoutMs: clampNumber(plannerSource.timeoutMs, 3000, 120000, 20000),
    // 每轮规划调用上限：任务书 §8 明确"每轮最多 1 次 Planner"，配置只能更小或等于 2（含一次修复）。
    maxCallsPerTurn: clampNumber(plannerSource.maxCallsPerTurn, 1, 2, 1),
  };
  if (plannerSource.maxCallsPerTurn !== undefined && Number(plannerSource.maxCallsPerTurn) > 2) {
    warnings.push('planner.maxCallsPerTurn 超过 2，已夹到 2（1 次规划 + 最多 1 次格式修复）');
  }

  const reviewSource = source.review && typeof source.review === 'object' ? source.review : {};
  const review = {
    enabled: reviewSource.enabled === true,
    maxRepairCalls: clampNumber(reviewSource.maxRepairCalls, 0, 1, 1),
  };

  const budgetSource = source.budgets && typeof source.budgets === 'object' ? source.budgets : {};
  const budgets = {};
  for (const modeKey of ROUTE_MODES) {
    const fallback = DEFAULT_PROMPT_CONFIG.budgets[modeKey];
    const value = budgetSource[modeKey];
    if (value === undefined || value === null) {
      budgets[modeKey] = fallback;
      continue;
    }
    const clamped = clampNumber(value, BUDGET_MIN, BUDGET_MAX, fallback);
    if (Number(value) !== clamped) warnings.push(`budgets.${modeKey} 超出 [${BUDGET_MIN}, ${BUDGET_MAX}]，已夹到 ${clamped}`);
    budgets[modeKey] = clamped;
  }

  const modulesSource = source.modules && typeof source.modules === 'object' ? source.modules : {};
  const disabled = Array.isArray(modulesSource.disabled)
    ? [...new Set(modulesSource.disabled.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))].slice(0, 40)
    : [];

  const routingSource = source.routing && typeof source.routing === 'object' ? source.routing : {};
  const routing = {
    carryOverTurns: clampNumber(routingSource.carryOverTurns, 1, 20, 6),
    maxHistoryTurns: clampNumber(routingSource.maxHistoryTurns, 1, 40, 12),
  };

  return {
    config: {
      schemaVersion: PROMPT_CONFIG_VERSION,
      enabled,
      mode,
      interactionMode,
      thinkingMode,
      planner,
      review,
      budgets,
      modules: { disabled },
      routing,
    },
    warnings,
  };
}

/**
 * 环境变量覆盖：只做开关，不表达复杂策略。
 *
 * `DSH_COMPANION_PROMPT_ENGINE` =
 *   `enabled` | `1` | `active` ⇒ 启用并注入
 *   `shadow` ⇒ 启用但只算不注入
 *   `off` | `0` ⇒ 关闭（覆盖文件里的 true）
 */
export function promptConfigFromEnv(env = process.env) {
  const raw = String(env?.DSH_COMPANION_PROMPT_ENGINE ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'enabled' || raw === '1' || raw === 'active' || raw === 'true' || raw === 'on') {
    return { enabled: true, mode: 'active' };
  }
  if (raw === 'shadow') return { enabled: true, mode: 'shadow' };
  if (raw === 'off' || raw === '0' || raw === 'false') return { enabled: false, mode: 'off' };
  return null;
}

function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return { value: JSON.parse(text), error: '' };
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'ENOENT') return { value: null, error: '' };
    return { value: null, error: `${code || 'read-failed'}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
  }
}

/**
 * 读取并归一化配置。
 *
 * @param {string|null} root 数据根；`null` 表示不读文件（只用默认值 + env）
 * @param {{env?: object, override?: object}} [options]
 * @returns {{ config: object, file: string, error: string, warnings: string[] }}
 */
export function loadPromptConfig(root, { env = process.env, override = null } = {}) {
  const file = promptConfigFile(root);
  const warnings = [];
  let onDisk = null;
  let error = '';

  if (file) {
    const read = readJsonFile(file);
    onDisk = read.value;
    error = read.error;
    if (error) warnings.push(`配置文件不可解析，已按默认值运行（${error}）`);
    else if (onDisk !== null && (typeof onDisk !== 'object' || Array.isArray(onDisk))) {
      warnings.push('配置文件顶层不是对象，已按默认值运行');
      onDisk = null;
    }
  }

  // 合并顺序：默认值 ← 文件 ← env ← 显式 override。只做第一层键的浅合并，
  // 嵌套对象整块替换，避免“文件里只写了一个子键”把默认值吃掉一半。
  const merged = { ...DEFAULT_PROMPT_CONFIG };
  const takeObject = (candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    for (const [key, value] of Object.entries(candidate)) {
      if (value === undefined) continue;
      merged[key] = value;
    }
  };
  takeObject(onDisk);
  takeObject(promptConfigFromEnv(env));
  takeObject(override);
  // 嵌套字段单独合并：否则文件里只写 `planning: {...}` 的那类子键会被默认值整块替换。
  for (const key of ['thinkingMode', 'planner', 'review', 'budgets', 'modules', 'routing']) {
    const base = DEFAULT_PROMPT_CONFIG[key];
    const mergedValue = merged[key];
    merged[key] = { ...(base ?? {}), ...(mergedValue && typeof mergedValue === 'object' ? mergedValue : {}) };
  }

  const sanitized = sanitizePromptConfig(merged);
  return { config: sanitized.config, file, error, warnings: [...warnings, ...sanitized.warnings] };
}

/**
 * 有效模式：`enabled !== true` 一律 `off`（与 runtime 同一条铁律）。
 * @returns {'off'|'shadow'|'active'}
 */
export function effectivePromptMode(config) {
  if (!config || config.enabled !== true) return 'off';
  if (!PROMPT_MODES.includes(config.mode)) return 'off';
  return config.mode === 'off' ? 'off' : config.mode;
}

/** 该场景应使用的执行等级；非法值回落 guided（普通聊天永不被自动拉进 strict）。 */
export function thinkingModeFor(config, mode) {
  const key = ROUTE_MODES.includes(mode) ? mode : 'chat';
  const value = config?.thinkingMode?.[key];
  return PROMPT_THINKING_MODES.includes(value) ? value : 'guided';
}

export default {
  PROMPT_CONFIG_VERSION,
  DEFAULT_PROMPT_CONFIG,
  PROMPT_INTERACTION_MODES,
  PROMPT_THINKING_MODES,
  PROMPT_MODES,
  ROUTE_MODES,
  BUDGET_MIN,
  BUDGET_MAX,
  promptConfigFile,
  sanitizePromptConfig,
  promptConfigFromEnv,
  loadPromptConfig,
  effectivePromptMode,
  thinkingModeFor,
};
