/**
 * Prompt Engine — 组合、排序、去重、预算裁剪（T2）。
 *
 * 依据 `PROMPT-ENGINE-CONTRACT.md` §2.3。纯函数：不读文件、不写文件、不发网络请求、
 * 不调用模型、不读时钟。所有输入都来自参数。
 *
 * 依赖方向（单向）：`prompt-compose` → `prompt-modules`。这里**不** import
 * `prompt-config` / `prompt-router` / `prompt-engine`，避免反向依赖。
 */

import { MODULES, MODULE_IDS, moduleOrder, moduleSkipReason, modulesFor } from './prompt-modules.mjs';

/**
 * 一轮最多注入的模块数量。
 *
 * 取 10 而不是 8：目录里每档的候选数分别是 chat 8 / companion 9 / task 9 / implicit 10 / immersive 10，
 * 用 8 会把 `style.universal`（"不编造现实事实与共同经历"）在非 chat 档挤掉——那是**行为红线**，
 * 不该被一个数量上限裁掉。真正限制注入量的是字符预算（`budgets.<mode>`），模块计数只防病态膨胀。
 */
export const MAX_MODULES = 10;

/** 合同的默认预算；当 `config.budgets[mode]` 缺失或非法时用它兜底。 */
export const DEFAULT_BUDGETS = Object.freeze({ chat: 600, companion: 800, roleplay: 1300, task: 500 });

/** 预算钳制范围，与 `prompt-config` 的 §2.1 一致：越界值只在这里被夹住，不改配置对象。 */
const BUDGET_FLOOR = 120;
const BUDGET_CEIL = 4000;

const FALLBACK_BUDGET = 600;

/** `skippedModules[].reason` 的完整枚举（合同 §2.3）。 */
export const SKIP_REASONS = Object.freeze(['scene', 'operator', 'disabled', 'budget', 'duplicate', 'empty']);

function clampBudget(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.floor(number);
  if (rounded < BUDGET_FLOOR) return BUDGET_FLOOR;
  if (rounded > BUDGET_CEIL) return BUDGET_CEIL;
  return rounded;
}

/**
 * 本轮预算。`mode` 是 `route.mode`（`chat|companion|roleplay|task`）；先读
 * `config.budgets[mode]`，缺失时再看 `config.budgets[profile]`，最后退回 600。
 * 越界值只在这里被夹到 `[120, 4000]`，**不修改** `config`。
 */
export function budgetFor({ config, mode, profile } = {}) {
  const budgets = config?.budgets ?? {};
  const pick = budgets?.[mode] ?? budgets?.[profile];
  const fallback = DEFAULT_BUDGETS[mode] ?? DEFAULT_BUDGETS[profile] ?? FALLBACK_BUDGET;
  if (pick === undefined || pick === null) return fallback;
  return clampBudget(pick, fallback);
}

/**
 * 合并黑名单：`config.modules.disabled` + 调用方 `extraDisabled`（例如运行时开关）。
 * 去重后保持稳定顺序，便于诊断与测试断言。
 */
export function disabledList({ config, extraDisabled = [] } = {}) {
  const merged = [];
  const seen = new Set();
  const push = value => {
    if (typeof value !== 'string') return;
    const id = value.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    merged.push(id);
  };
  for (const id of Array.isArray(config?.modules?.disabled) ? config.modules.disabled : []) push(id);
  for (const id of Array.isArray(extraDisabled) ? extraDisabled : []) push(id);
  return merged;
}

/**
 * 稳定排序：`priority` 降序，同优先级按 `MODULES` 声明顺序（`moduleOrder`）。
 * 未知 ID 排在最后（正常路径不会出现，防御性处理）。
 */
export function compareModules(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return moduleOrder(a.id) - moduleOrder(b.id);
}

/**
 * 安全渲染：`render` 抛错、返回非字符串或空白时一律视为"空模块"。
 * 空模块由调用方记为 `skippedModules: [{ id, reason: 'empty' }]`，不会出现在 `text` 里。
 */
export function renderModuleText(module, ctx) {
  if (!module || typeof module.render !== 'function') return '';
  try {
    const text = module.render(ctx);
    return typeof text === 'string' ? text.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 按 `dedupeKey` 去重（输入必须已排好序：优先级高的在前）。
 * 同一 key 只保留第一条，其余记入 `deduped`。
 *
 * 真实目录里 `dedupeKey` 互斥的场景（`mode` / `thinking`）通常已经由场景/等级过滤掉，
 * 这里保留完整语义：任何同名 key 都只留优先级最高的一条。
 */
export function dedupeModules(candidates) {
  const seenKeys = new Set();
  const kept = [];
  const deduped = [];
  for (const module of Array.isArray(candidates) ? candidates : []) {
    const key = typeof module?.dedupeKey === 'string' && module.dedupeKey ? module.dedupeKey : '';
    if (key && seenKeys.has(key)) {
      deduped.push(module.id);
      continue;
    }
    if (key) seenKeys.add(key);
    kept.push(module);
  }
  return { kept, deduped };
}

/**
 * 预算裁剪：从**低优先级（数组末尾）**开始整模块丢弃，绝不在模块中间截断。
 *
 * @param {Array<{ module: object, text: string }>} entries 已按优先级降序排列
 * @param {number} budgetChars 总字数上限（含 `'\n'` 连接符）
 * @returns {{ kept: Array, dropped: string[], chars: number }}
 */
export function trimModulesToBudget(entries, budgetChars) {
  const list = Array.isArray(entries) ? entries : [];
  const limit = Number.isFinite(Number(budgetChars)) ? Math.max(0, Math.floor(Number(budgetChars))) : 0;
  const keepFlags = new Array(list.length).fill(true);
  const dropped = [];

  const totalOf = flags => {
    let total = 0;
    let count = 0;
    for (let index = 0; index < list.length; index += 1) {
      if (!flags[index]) continue;
      total += list[index].text.length + (count > 0 ? 1 : 0);
      count += 1;
    }
    return total;
  };

  let used = totalOf(keepFlags);
  for (let index = list.length - 1; index >= 0 && used > limit; index -= 1) {
    keepFlags[index] = false;
    dropped.push(list[index].module.id);
    used = totalOf(keepFlags);
  }

  const kept = list.filter((_, index) => keepFlags[index]);
  return { kept, dropped, chars: totalOf(keepFlags) };
}

/** 数量上限裁剪：超出 `MAX_MODULES` 的部分整模块丢弃（同样不截断）。 */
export function capModuleCount(entries, max = MAX_MODULES) {
  const list = Array.isArray(entries) ? entries : [];
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : MAX_MODULES;
  if (list.length <= limit) return { kept: list, dropped: [] };
  return { kept: list.slice(0, limit), dropped: list.slice(limit).map(entry => entry.module.id) };
}

/**
 * 组合本轮提示文本。
 *
 * @param {{
 *   route?: object, config?: object, persona?: string,
 *   memoryContext?: string, workingMemory?: string, extraDisabled?: string[],
 * }} input
 * @returns {{
 *   profile: string, text: string, chars: number, budgetChars: number,
 *   selectedModules: Array<{ id: string, priority: number, chars: number }>,
 *   skippedModules: Array<{ id: string, reason: string }>,
 *   state: { mode: string, intensity: string, thinkingMode: string,
 *            trimmed: string[], deduped: string[], budgetChars: number },
 * }}
 */
export function composePrompt({ route, config, persona, memoryContext, workingMemory, extraDisabled = [] } = {}) {
  const profile = String(route?.profile ?? 'chat');
  const mode = String(route?.mode ?? profile);
  const intensity = String(route?.intensity ?? 'normal');
  const thinkingMode = String(route?.thinkingMode ?? 'guided');
  const operators = route?.operators ?? {};
  const personaPresent = typeof persona === 'string' ? persona.trim().length > 0 : Boolean(persona);

  const budgetChars = budgetFor({ config, mode, profile });
  const disabled = disabledList({ config, extraDisabled });

  const skippedModules = [];
  const skip = (id, reason) => skippedModules.push({ id, reason });

  // 1. 场景 / 算子 / 思考等级 / 黑名单过滤。逐条走同一判定，把每个被排除的 ID 与理由
  //    都写进 `skippedModules`（不只写被预算丢掉的）。
  const eligibleIds = new Set(
    modulesFor({ profile, operators, thinkingMode, disabled }).map(module => module.id),
  );
  const candidates = [];
  for (const module of MODULES) {
    if (!eligibleIds.has(module.id)) {
      const reason = moduleSkipReason(module, { profile, operators, thinkingMode, disabled });
      skip(module.id, reason || 'scene');
      continue;
    }
    candidates.push(module);
  }

  // 2. 稳定排序：priority 降序，同优先级按目录声明顺序。
  candidates.sort(compareModules);

  // 3. 去重（dedupeKey）：同一 key 只留优先级最高的。
  const keyed = dedupeModules(candidates);
  for (const id of keyed.deduped) skip(id, 'duplicate');

  // 4. 渲染；渲染为空 ⇒ `empty`，渲染结果完全相同 ⇒ `duplicate`。
  const rendered = [];
  const seenTexts = new Set();
  for (const module of keyed.kept) {
    const text = renderModuleText(module, { route, config, personaPresent, persona, memoryContext, workingMemory });
    if (!text) {
      skip(module.id, 'empty');
      continue;
    }
    if (seenTexts.has(text)) {
      keyed.deduped.push(module.id);
      skip(module.id, 'duplicate');
      continue;
    }
    seenTexts.add(text);
    rendered.push({ module, text });
  }

  // 5. 数量上限（MAX_MODULES）：超出部分整模块丢弃。
  const counted = capModuleCount(rendered, MAX_MODULES);
  for (const id of counted.dropped) skip(id, 'budget');

  // 6. 预算：从低优先级开始整模块丢弃，绝不截断正文。
  const trimmedResult = trimModulesToBudget(counted.kept, budgetChars);
  for (const id of trimmedResult.dropped) skip(id, 'budget');

  const text = trimmedResult.kept.map(entry => entry.text).join('\n');
  const selectedModules = trimmedResult.kept.map(entry => ({
    id: entry.module.id,
    priority: entry.module.priority,
    chars: entry.text.length,
  }));

  return {
    profile,
    text,
    chars: text.length,
    budgetChars,
    selectedModules,
    skippedModules,
    state: {
      mode,
      intensity,
      thinkingMode,
      // `trimmed` = 所有因数量上限或字数预算被整模块丢弃的 ID（不含重复与空）
      trimmed: [...counted.dropped, ...trimmedResult.dropped],
      deduped: keyed.deduped,
      budgetChars,
    },
  };
}

/** 供诊断/测试：模块目录的只读摘要（不含正文）。 */
export function describeModules() {
  return MODULES.map(module => ({
    id: module.id,
    kind: module.kind,
    priority: module.priority,
    scenes: [...module.scenes],
    operators: [...module.operators],
    charBudget: module.charBudget,
  }));
}

export { MODULES, MODULE_IDS };
