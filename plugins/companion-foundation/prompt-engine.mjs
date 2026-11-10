import { loadPromptConfig, effectivePromptMode, promptConfigFile } from './prompt-config.mjs?v=0.1.0';
import { routeTurn, initialState } from './prompt-router.mjs?v=0.1.0';
import { composePrompt } from './prompt-compose.mjs?v=0.1.0';
import { promptContractSection } from './prompt-modules.mjs?v=0.1.0';
import { buildPlannerPrompt, buildRepairPrompt, extractJsonObject, validatePlan, renderPlanForWriter } from './prompt-plan.mjs?v=0.1.0';
import { lintText } from './prompt-lint.mjs?v=0.1.0';

// Prompt Engine：companion-foundation 内部的纯业务编排层。
//
// 这一层只做三件事：读配置、按会话路由、把模块组合成一段独立的注入文本。它**不是**第二条对话
// 注入入口：`index.mjs` 仍然只有那一个 `agent/pre-step`，本模块只是被它调用一次，产物作为
// `companion-prompt-profile` section 追加进既有快照。
//
// 三条铁律：
//   1. `enabled: false` 或 `mode: 'off'` ⇒ 不注入、不注册、不调用模型（完全惰性）。
//   2. `mode: 'shadow'` ⇒ 照常路由与组合，但**不改变消息**，只留诊断。
//   3. 任何异常都退化成“没有 prompt 文本”，绝不让这一轮聊天失败。

/** 会话状态上限：内存 LRU，不落库、不跨进程、不与群聊共享。 */
export const MAX_SESSIONS = 200;
/** 规划产物作为 Writer 指导时的字符上限；它有自己的额度，不占用 Memory 2400 / Runtime 320。 */
export const PLAN_GUIDANCE_CHARS = 900;

const PURPOSE_PLAN = 'companion-prompt-plan';

function emptySnapshot(reason, extra = {}) {
  return {
    text: '',
    chars: 0,
    budgetChars: 0,
    profile: '',
    mode: 'chat',
    intensity: 'normal',
    thinkingMode: 'guided',
    selectedModules: [],
    skippedModules: [],
    state: null,
    plan: null,
    planState: reason,
    shadowed: false,
    errors: [],
    ...extra,
  };
}

/**
 * 从宿主 session 日志里取最近若干轮对话，只保留角色与文本。
 *
 * 只读 `agent.session.log`，不访问任何私有记忆或其它会话。拿不到就返回空数组——路由会退化为
 * “只有当前这条消息”的判断，而不是伪造上下文。
 */
export function historyFromSession(agent, limit = 12) {
  const log = agent?.session?.log;
  if (!Array.isArray(log)) return [];
  const turns = [];
  for (const event of log) {
    const type = event?.type;
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const data = event.data ?? {};
    // 只认真正的用户消息；companion 自己追加的 snapshot 是 source.kind = 'companion-memory'。
    const role = type === 'user/message' ? 'user' : 'assistant';
    if (role === 'user' && data?.source?.kind !== undefined && data.source.kind !== 'user') continue;
    const content = data?.content ?? data?.message?.content ?? [];
    const text = Array.isArray(content)
      ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ')
      : '';
    if (!text.trim()) continue;
    turns.push({ role, text: text.slice(0, 1200) });
  }
  return turns.slice(-Math.max(1, limit));
}

/** 从 pre-step 的 decision 里取本轮用户原文；拿不到就返回空串。 */
export function latestUserText(decision) {
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.source?.kind !== 'user') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
    if (text.trim()) return text.slice(-500);
  }
  return '';
}

/**
 * @param options.root 数据根（含 `home/companion/`）
 * @param options.ctx Cordis 上下文（仅用于取宿主 LLM；可为空）
 * @param options.env 环境变量（测试注入）
 * @param options.now 时间源（测试注入）
 */
export function createPromptEngine({ root, ctx = null, env = process.env, now = () => Date.now(), logger = console } = {}) {
  const sessions = new Map();
  const counters = { routes: 0, injected: 0, shadowed: 0, plannerCalls: 0, plannerFailures: 0, degraded: 0, lintRuns: 0 };
  const lastRoutes = new Map();
  const lastLint = new Map();
  let disposed = false;
  let lastConfigError = '';
  let lastPlannerError = '';
  let explicitBySession = new Map();
  let llmCache = { key: '', adapter: null, failure: null };

  const configFile = root ? promptConfigFile(root) : '';

  /** 每轮重读配置：允许操作者在不重启的情况下改档，且读失败绝不抛错。 */
  const currentConfig = () => {
    if (!root) return loadPromptConfig(null, { env, override: null }).config;
    const { config, error } = loadPromptConfig(root, { env });
    lastConfigError = error ? String(error).slice(0, 200) : '';
    return config;
  };

  const boundSession = sessionId => {
    if (sessions.has(sessionId)) {
      const state = sessions.get(sessionId);
      // 触碰一次，维持 LRU 顺序。
      sessions.delete(sessionId);
      sessions.set(sessionId, state);
      return state;
    }
    return null;
  };

  const storeSession = (sessionId, state) => {
    sessions.delete(sessionId);
    sessions.set(sessionId, state);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  /**
   * 一轮的路由结果。`explicit` 来自显式控制（配置的 interactionMode 或 setExplicit 命令）；
   * `history` 缺省为空，路由会只依据当前消息，并如实把 source 记为 `default`。
   */
  const routeFor = ({ sessionId, message = '', history = null, config = null } = {}) => {
    const activeConfig = config ?? currentConfig();
    const key = String(sessionId ?? '');
    const previous = boundSession(key) ?? null;
    const explicit = explicitBySession.get(key) ?? null;
    const turns = Array.isArray(history) ? history : [];
    const result = routeTurn({
      config: activeConfig,
      sessionId: key,
      previousState: previous,
      history: turns.slice(-Math.max(1, activeConfig.routing?.maxHistoryTurns ?? 12)),
      message,
      explicit,
      now: now(),
    });
    const route = result?.route ?? {
      ...initialState(key),
      mode: 'chat', intensity: 'normal', profile: 'chat', source: 'default',
    };
    if (result?.state) storeSession(key, result.state);
    counters.routes += 1;
    lastRoutes.set(key, {
      mode: route.mode, intensity: route.intensity, profile: route.profile,
      thinkingMode: route.thinkingMode, source: route.source, confidence: route.confidence ?? null,
      operators: route.operators ?? null, evidence: (route.evidence ?? []).slice(0, 8),
      at: new Date(now()).toISOString(),
    });
    return { route, state: result?.state ?? null, diagnostics: result?.diagnostics ?? null, config: activeConfig };
  };

  const resolvePlanner = async config => {
    const key = `${config.planner?.provider ?? ''}|${config.planner?.model ?? ''}|${config.planner?.timeoutMs ?? 0}`;
    if (llmCache.key === key && llmCache.adapter) return llmCache.adapter;
    if (llmCache.key === key && llmCache.failure) throw new Error(llmCache.failure);
    const { createHostLlmAdapter } = await import('./host-llm.mjs?v=0.4.0');
    try {
      const adapter = await createHostLlmAdapter(ctx, {
        provider: config.planner?.provider ?? '',
        model: config.planner?.model ?? '',
        reasoningEffort: config.planner?.reasoningEffort ?? 'low',
        timeoutMs: Number(config.planner?.timeoutMs ?? 20000),
        purpose: PURPOSE_PLAN,
        // 一次预算 = 一次物理生成：规划调用不允许适配器在背后重试。
        allowFallback: false,
      });
      llmCache = { key, adapter, failure: null };
      return adapter;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      llmCache = { key, adapter: null, failure: message };
      throw error;
    }
  };

  /**
   * Structured/Strict 的 Planner 阶段。
   *
   * 界限（§8 模型调用约束）：独立 purpose、独立 session 标识、超时、输出 Token 上限、每轮调用上限；
   * 不注册工具、不执行外部动作、不把规划结果给用户看。失败一律返回 `{ ok:false, degraded:true }`。
   */
  const planOnce = async ({ config, route, persona, memoryContext, workingMemory, userMessage, sessionId, signal }) => {
    const planner = config.planner ?? {};
    const maxCalls = Math.max(1, Math.min(2, Number(planner.maxCallsPerTurn) || 1));
    let calls = 0;
    const call = async prompts => {
      if (calls >= maxCalls) throw new Error('planner call budget exhausted');
      calls += 1;
      counters.plannerCalls += 1;
      const adapter = await resolvePlanner(config);
      // 适配器在构造时就带了 `allowFallback: false`（一次预算 = 一次物理生成），
      // 所以这里不再传重试开关——传了也会被工厂选项覆盖，只会误导读者。
      return adapter.complete({
        system: prompts.system,
        input: prompts.input,
        maxTokens: Math.max(200, Math.min(2000, Number(planner.maxOutputTokens) || 800)),
        signal,
        sessionId: `${sessionId}:plan`,
      });
    };

    const first = buildPlannerPrompt({ route, persona, memoryContext, workingMemory, userMessage, config });
    let raw = '';
    try {
      raw = await call(first);
    } catch (error) {
      counters.plannerFailures += 1;
      lastPlannerError = String(error?.message ?? error).slice(0, 200);
      return { ok: false, degraded: true, code: 'planner-failed', error: lastPlannerError, calls };
    }
    const extracted = extractJsonObject(raw);
    let validated = extracted.ok ? validatePlan(extracted.value) : { ok: false, plan: null, errors: [{ path: '$', code: 'not-json' }] };
    if (!validated.ok) {
      // 一次格式修复；调用预算不够就直接降级，不硬撑。
      if (calls < maxCalls) {
        try {
          const repaired = await call(buildRepairPrompt({ rawText: raw, errors: validated.errors, config }));
          const again = extractJsonObject(repaired);
          if (again.ok) validated = validatePlan(again.value);
        } catch (error) {
          counters.plannerFailures += 1;
          lastPlannerError = String(error?.message ?? error).slice(0, 200);
        }
      }
      if (!validated.ok) {
        counters.degraded += 1;
        return { ok: false, degraded: true, code: 'plan-invalid', errors: (validated.errors ?? []).slice(0, 6), calls };
      }
    }
    return { ok: true, degraded: false, plan: validated.plan, calls };
  };

  /**
   * 生成一轮要注入的 prompt 片段。
   *
   * 返回值里的 `text` 才是能进快照的东西；`shadowed: true` 时 `text` 一定是空串。
   */
  const snapshot = async ({ sessionId = '', message = '', history = null, persona = '', memoryContext = '', workingMemory = '', signal } = {}) => {
    if (disposed) return emptySnapshot('disposed');
    const config = currentConfig();
    const mode = effectivePromptMode(config);
    if (mode === 'off') return emptySnapshot('disabled', { budgetChars: Number(config.budgets?.chat ?? 0) });

    let routed;
    try {
      routed = routeFor({ sessionId, message, history, config });
    } catch (error) {
      return emptySnapshot('route-failed', { errors: [String(error?.message ?? error).slice(0, 200)] });
    }
    const { route } = routed;
    const budgetChars = Math.max(120, Math.min(4000, Number(config.budgets?.[route.mode] ?? 600) || 600));

    // Strict 只显式开启：普通聊天即使配置写了 strict 也不自动进入（§16.C）。
    const thinkingMode = route.mode === 'chat' && route.intensity === 'normal' && route.thinkingMode === 'strict'
      ? 'guided'
      : route.thinkingMode;

    let composed;
    try {
      composed = composePrompt({
        route: { ...route, thinkingMode },
        config,
        persona,
        memoryContext,
        workingMemory,
        extraDisabled: config.modules?.disabled ?? [],
      });
    } catch (error) {
      return emptySnapshot('compose-failed', { budgetChars, errors: [String(error?.message ?? error).slice(0, 200)] });
    }

    let planText = '';
    let planState = thinkingMode === 'guided' ? 'guided' : 'planner-disabled';
    let plan = null;
    const wantsPlan = (thinkingMode === 'structured' || thinkingMode === 'strict') && config.planner?.enabled === true;
    if (wantsPlan) {
      const result = await planOnce({ config, route, persona, memoryContext, workingMemory, userMessage: message, sessionId, signal });
      if (result.ok) {
        plan = result.plan;
        planState = 'planned';
        try {
          const rendered = renderPlanForWriter(plan);
          planText = typeof rendered === 'string' ? rendered.slice(0, PLAN_GUIDANCE_CHARS) : '';
        } catch { planText = ''; }
      } else {
        planState = `degraded:${result.code ?? 'unknown'}`;
        counters.degraded += 1;
      }
    } else if (thinkingMode !== 'guided') {
      planState = 'planner-not-enabled';
    }

    const text = [composed.text, planText].filter(Boolean).join('\n');
    if (mode === 'shadow') {
      counters.shadowed += 1;
      return {
        text: '',
        chars: 0,
        budgetChars,
        profile: composed.profile,
        mode: route.mode,
        intensity: route.intensity,
        thinkingMode,
        selectedModules: composed.selectedModules,
        skippedModules: composed.skippedModules,
        state: composed.state,
        plan,
        planState,
        shadowed: true,
        wouldInjectChars: text.length,
        diagnostics: routed.diagnostics,
        errors: [],
      };
    }
    counters.injected += 1;
    return {
      text,
      chars: text.length,
      budgetChars,
      profile: composed.profile,
      mode: route.mode,
      intensity: route.intensity,
      thinkingMode,
      selectedModules: composed.selectedModules,
      skippedModules: composed.skippedModules,
      state: composed.state,
      plan,
      planState,
      shadowed: false,
      diagnostics: routed.diagnostics,
      errors: [],
    };
  };

  /**
   * 回答生成之后的文风统计（P1 只检测，不改写、不回传原文、不额外调用模型）。
   * 结果只进诊断，不进入对话。
   */
  const auditReply = ({ sessionId = '', text = '', profile = '' } = {}) => {
    const config = currentConfig();
    if (effectivePromptMode(config) === 'off') return null;
    const body = typeof text === 'string' ? text : '';
    if (!body.trim()) return null;
    const last = lastRoutes.get(String(sessionId ?? ''));
    try {
      const report = lintText(body, {
        profile: profile || last?.profile || 'chat',
        mode: last?.mode || 'chat',
        operators: last?.operators ?? null,
      });
      counters.lintRuns += 1;
      if (report && typeof report === 'object') {
        // 只留统计与理由码：counts 是数字，findings 是 {code,count}。
        lastLint.set(String(sessionId ?? ''), {
          at: new Date(now()).toISOString(),
          profile: report.profile ?? profile ?? '',
          ok: report.ok === true,
          counts: report.counts ?? {},
          findings: (report.findings ?? []).slice(0, 8),
        });
      }
      return report;
    } catch {
      return null;
    }
  };

  const status = () => ({
    mode: effectivePromptMode(currentConfig()),
    enabled: currentConfig().enabled === true,
    configFile,
    configError: lastConfigError,
    plannerError: lastPlannerError,
    sessions: sessions.size,
    counters: { ...counters },
    lint: lastLint.size,
    routes: [...lastRoutes.entries()].slice(-8).map(([sessionId, value]) => ({ sessionId, ...value })),
  });

  const setExplicit = (sessionId, { mode = '', intensity = '' } = {}) => {
    const key = String(sessionId ?? '');
    if (!key) return { ok: false, code: 'session-required' };
    const next = { mode: String(mode ?? ''), intensity: String(intensity ?? '') };
    if (!next.mode && !next.intensity) explicitBySession.delete(key);
    else explicitBySession.set(key, next);
    // 显式控制改变后，旧状态不再代表当前交互。
    sessions.delete(key);
    return { ok: true, explicit: explicitBySession.get(key) ?? null };
  };

  const clearSession = sessionId => {
    const key = String(sessionId ?? '');
    const had = sessions.delete(key);
    lastRoutes.delete(key);
    lastLint.delete(key);
    explicitBySession.delete(key);
    return { ok: true, cleared: had };
  };

  const describe = () => {
    const config = currentConfig();
    return {
      mode: effectivePromptMode(config),
      enabled: config.enabled === true,
      interactionMode: config.interactionMode,
      thinkingMode: config.thinkingMode,
      budgets: config.budgets,
      planner: { enabled: config.planner?.enabled === true, provider: config.planner?.provider ?? '', model: config.planner?.model ?? '' },
      review: config.review,
      sessions: sessions.size,
    };
  };

  return {
    get mode() { return effectivePromptMode(currentConfig()); },
    get enabled() { return currentConfig().enabled === true; },
    get config() { return currentConfig(); },
    configFile,
    currentConfig,
    route: routeFor,
    snapshot,
    auditReply,
    historyFromSession,
    latestUserText,
    status,
    describe,
    setExplicit,
    clearSession,
    lintText,
    contractSection: promptContractSection,
    dispose() {
      disposed = true;
      sessions.clear();
      lastRoutes.clear();
      lastLint.clear();
      explicitBySession = new Map();
    },
  };
}

export default { createPromptEngine, historyFromSession, latestUserText, MAX_SESSIONS, PLAN_GUIDANCE_CHARS };

// 说明（给维护者，也给交付报告）：
//   - 这里没有 HTTP Provider、没有 API Key 管理：Planner 复用 host-llm.mjs 的 DSH LLM 接入。
//   - 这里不解析 `data/` 之外的任何东西，也不把任何正文写盘（配置文件名来自 prompt-config）。
//   - 模块本身不 import fs：所有磁盘读取都在 prompt-config.mjs 里，这里是纯编排。
