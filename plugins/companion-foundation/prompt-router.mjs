/**
 * Prompt Engine — 交互场景路由（T1）。
 *
 * 依据 `PROMPT-ENGINE-CONTRACT.md` §2.2。纯函数：不读文件、不发请求、不调用模型、不读时钟
 * （`now` 由调用方传入）。会话状态由调用方保存，本文件只做"给定上一状态 + 本轮输入 ⇒ 新状态"。
 *
 * 三条设计红线（任务书 §6 / §16.E）：
 *   1. 显式控制优先，`auto` 才自主判断；
 *   2. **单条消息永远不能得出 immersive**——immersive 只来自显式控制，或已在沉浸中的承接；
 *   3. 不使用"全局静态关键词表决定 RP"，只用结构信号（成对对白引号、动作星号、代码围栏、
 *      第二人称承接、任务请求语气），且信号只影响置信度与 subtle，不单独构成立即的沉浸判定。
 */

import { thinkingModeFor } from './prompt-config.mjs';

export const ROUTE_SCHEMA_VERSION = 1;

/** 场景模式。`roleplay` 由强度细分成 implicit / narrative 两档 profile。 */
export const MODES = Object.freeze(['chat', 'companion', 'roleplay', 'task']);
export const INTENSITIES = Object.freeze(['normal', 'subtle', 'immersive']);
export const PROFILES = Object.freeze(['chat', 'companion', 'implicit-roleplay', 'roleplay-narrative', 'task']);

/** 与合同 §2.2 表格逐字一致的算子激活表。 */
const OPERATOR_TABLE = Object.freeze({
  'chat/normal': Object.freeze({ DIG: 'on', LORE: 'off', ARC: 'off', REVIEW: 'optional' }),
  'companion/normal': Object.freeze({ DIG: 'on', LORE: 'optional', ARC: 'off', REVIEW: 'optional' }),
  'roleplay/normal': Object.freeze({ DIG: 'on', LORE: 'optional', ARC: 'light', REVIEW: 'optional' }),
  'roleplay/subtle': Object.freeze({ DIG: 'on', LORE: 'optional', ARC: 'light', REVIEW: 'optional' }),
  'roleplay/immersive': Object.freeze({ DIG: 'on', LORE: 'on', ARC: 'on', REVIEW: 'on' }),
  'task/normal': Object.freeze({ DIG: 'on', LORE: 'optional', ARC: 'off', REVIEW: 'optional' }),
});

const OPERATORS = Object.freeze(['DIG', 'LORE', 'ARC', 'REVIEW']);

/** `mode/intensity` ⇒ 唯一 profile（合同 §2.2）。 */
export function profileFor(mode, intensity) {
  const safeMode = MODES.includes(mode) ? mode : 'chat';
  const safeIntensity = INTENSITIES.includes(intensity) ? intensity : 'normal';
  if (safeMode === 'chat') return 'chat';
  if (safeMode === 'companion') return 'companion';
  if (safeMode === 'task') return 'task';
  return safeIntensity === 'immersive' ? 'roleplay-narrative' : 'implicit-roleplay';
}

/** `mode/intensity` ⇒ 算子激发表（返回值是拷贝，调用方可以安全修改）。 */
export function routeOperators(mode, intensity) {
  const profile = profileFor(mode, intensity);
  const key = profile === 'implicit-roleplay' || profile === 'roleplay-narrative'
    ? `roleplay/${intensity === 'immersive' ? 'immersive' : intensity === 'subtle' ? 'subtle' : 'normal'}`
    : `${profile}/normal`;
  const row = OPERATOR_TABLE[key] ?? OPERATOR_TABLE['chat/normal'];
  const operators = {};
  for (const name of OPERATORS) operators[name] = row[name];
  return operators;
}

/** 新会话的初始状态（惰性、可安全当作 `previousState` 缺失时的替代）。 */
export function initialState(sessionId = '') {
  return {
    sessionId: String(sessionId ?? ''),
    mode: 'chat',
    intensity: 'normal',
    profile: 'chat',
    source: 'default',
    turns: 0,
    sceneTurns: 0,
    calmTurns: 0,
    thinkingMode: 'guided',
    resume: null,
    explicitMode: '',
    explicitIntensity: '',
    updatedAt: '',
  };
}

/* ─────────────────────────── 结构信号 ─────────────────────────── */

const QUOTE_PAIRS = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ['‘', '’']];

/**
 * 成对对白引号：`他说：「……」`。单个引号不算。
 *
 * 全角引号（「」『』“”‘’）在任何语境下都是写作/对白标记，可以直接当证据。
 * ASCII 双引号不同：技术文本里到处是 `use "strict mode"`、`set "proxy" env var`，
 * 把它当对白会让一句配置说明被路由成 roleplay。所以 ASCII 引号要求**引号内真的有汉字**
 * 才算对白——`他说 "hello"`、`set "proxy" env var` 都不再触发，而 `"你终于来了"` 仍然触发。
 * 这正是任务书 §6.3 第 6 条要的：技术问题不能被误判成戏。
 */
function hasDialogueQuote(text) {
  for (const [open, close] of QUOTE_PAIRS) {
    const first = text.indexOf(open);
    if (first < 0) continue;
    const second = text.indexOf(close, first + 1);
    if (second <= first) continue;
    if (open === '"' || open === "'") {
      const quoted = text.slice(first + 1, second);
      if (!/\p{Script=Han}/u.test(quoted)) continue;
    }
    return true;
  }
  return false;
}

/** `*抬手把门带上*` 这类动作标记。 */
function hasActionMarker(text) {
  const matches = text.match(/\*[^*\n]{2,80}\*/g);
  return Array.isArray(matches) && matches.length > 0;
}

/** 代码围栏或行内代码：最强的"这是任务不是戏"信号。 */
function hasCodeSignal(text) {
  if (/```/.test(text)) return true;
  return /`[^`\n]{2,200}`/.test(text);
}

/**
 * 任务请求语气：明确的"解释/分析/怎么写/报错/配置"等请求。
 *
 * 只有**技术或事务词汇**才算任务信号。"你今天怎么回来得这么晚"里的"怎么"是场景对话，
 * 不是任务请求——单纯疑问词永远不能把一轮降级成 task。
 */
const TASK_VOCABULARY = /(分析|解释|说明一下|介绍一下|对比|排查|修复|实现|重构|安装|配置|部署|报错|日志|函数|变量|接口|脚本|代码|命令|终端|仓库|提交|分支|版本号|语法|依赖|性能|测试用例|文档|步骤|示例|举例|公式|算法|数据库|环境变量|正则|编译|打包|单元测试)/;

function taskSignal(text) {
  if (!text) return '';
  if (hasCodeSignal(text)) return 'task-signal:code';
  if (TASK_VOCABULARY.test(text)) return 'task-signal:vocabulary';
  return '';
}

/** 第二人称 + 场景指示（"你今天怎么回来得这么晚"），需要前文有场景才成立。 */
function sceneDeixis(text) {
  const secondPerson = /(你|妳)/.test(text);
  if (!secondPerson) return false;
  return /(回来|回家|门口|楼下|屋里|房间|外面|这里|那天|那年|刚才|等一下|等我|别再|还没|走了|坐下|抬头|转头|手里|身后|身边)/.test(text);
}

/** 抽象情绪表达（"如果那天我没有离开，你会不会挽留我"）：单独出现只算情绪交流。 */
function abstractEmotion(text) {
  return /(如果|要是|假如|会不会|是不是|还记得|有没有想过|后悔|舍得|舍不得|想不想|愿不愿)/.test(text);
}

/** 情绪词：陪伴信号（不是 RP 证据）。 */
const EMOTION_WORDS = /(累|难受|难过|烦|委屈|焦虑|压力|崩|撑不住|想哭|开心|高兴|生气|害怕|孤独|emo|低落|无助|失眠|头疼|心累|想你|想见你|喜欢你|舍不得|后悔)/;

/**
 * 场景结构信号分两级。
 *
 * - **strong**：引号对白、`*动作*`。它们是"双方已经在演"的结构证据，单条消息也能给出 subtle。
 * - **weak**：第二人称场景指示（"你今天怎么回来得这么晚"）、省略号。它们只说明"像在聊某个场景"，
 *   必须有前文场景才可能升级成 RP；单独出现时最多只是普通对话。
 *
 * 任务书 §6.2 明确"不能把抽象表达本身当作 RP 的充分证据"，所以 weak 永远不够。
 */
function sceneSignals(text) {
  const strong = [];
  const weak = [];
  if (hasDialogueQuote(text)) strong.push('scene-signal:dialogue');
  if (hasActionMarker(text)) strong.push('scene-signal:action');
  if (sceneDeixis(text)) weak.push('scene-signal:deixis');
  if (/(……|\.{3,})/.test(text)) weak.push('scene-signal:ellipsis');
  return { strong, weak };
}

function countSceneSignals(text) {
  const { strong, weak } = sceneSignals(text);
  return strong.length + weak.length;
}

function lastTurns(history, count) {
  if (!Array.isArray(history)) return [];
  return history.slice(-Math.max(0, count));
}

function normalizeExplicit(explicit) {
  if (!explicit || typeof explicit !== 'object') return { mode: '', intensity: '' };
  const mode = MODES.includes(explicit.mode) ? explicit.mode : '';
  const intensity = INTENSITIES.includes(explicit.intensity) ? explicit.intensity : '';
  return { mode, intensity };
}

function explicitIntensityFor(mode, intensity) {
  if (intensity) return intensity;
  // 明确"进入 RP"⇒ 完整沉浸；其余显式模式都是 normal。
  return mode === 'roleplay' ? 'immersive' : 'normal';
}

/* ─────────────────────────── 主路由 ─────────────────────────── */

/**
 * 判断本轮怎么交互。
 *
 * @param {{
 *   config: object, sessionId?: string, previousState?: object|null,
 *   history?: Array<{role: string, text: string}>, message?: string,
 *   explicit?: {mode?: string, intensity?: string}|null, now?: number,
 * }} input
 * @returns {{ route: object, state: object, diagnostics: object }}
 */
export function routeTurn({
  config = null,
  sessionId = '',
  previousState = null,
  history = [],
  message = '',
  explicit = null,
  now = 0,
} = {}) {
  const previous = previousState && typeof previousState === 'object' ? previousState : initialState(sessionId);
  const text = typeof message === 'string' ? message : '';
  const historyLimit = Math.max(1, Math.min(40, Number(config?.routing?.maxHistoryTurns) || 12));
  const recent = lastTurns(history, historyLimit);
  const evidence = [];
  const bounded = [];

  const operatorsSignal = sceneSignals(text);
  const strongSignals = operatorsSignal.strong;
  const weakSignals = operatorsSignal.weak;
  const taskHit = taskSignal(text);
  const emotionHit = EMOTION_WORDS.test(text) ? 'emotion-signal:vocabulary' : '';
  const abstractHit = abstractEmotion(text) ? 'emotion-signal:abstract' : '';
  // 只看**用户**自己的前几轮：助手的长篇描写不能把下一轮变成 RP。
  const priorSceneStrong = recent
    .filter(turn => turn?.role === 'user')
    .reduce((sum, turn) => sum + sceneSignals(String(turn?.text ?? '')).strong.length, 0);
  const priorSceneWeak = recent
    .filter(turn => turn?.role === 'user')
    .reduce((sum, turn) => sum + sceneSignals(String(turn?.text ?? '')).weak.length, 0);

  // —— 第一层：显式控制（配置的 interactionMode 也算显式） ——
  const explicitNormalized = normalizeExplicit(explicit);
  const configured = typeof config?.interactionMode === 'string' && config.interactionMode !== 'auto'
    && MODES.includes(config.interactionMode)
    ? config.interactionMode
    : '';
  // 场景内"走神"计数：必须独立于 mode 持久化，否则一旦停在 roleplay 就永远回不去
  // （calmTurns 在 roleplay 时会被清零，用它做降档条件会死循环）。
  let nextIdle = 0;
  let mode;
  let intensity;
  let source;
  const previousIdle = Number(previous.idleTurns ?? 0) || 0;

  if (explicitNormalized.mode || configured) {
    mode = explicitNormalized.mode || configured;
    intensity = explicitIntensityFor(mode, explicitNormalized.intensity);
    source = explicitNormalized.mode ? 'explicit' : 'override';
    evidence.push(explicitNormalized.mode ? 'explicit-mode' : 'config-interaction-mode');
    if (explicitNormalized.intensity) evidence.push(`explicit-intensity:${intensity}`);
  } else {
    // —— 第二层：上下文连续性 ——
    const wasScene = previous.mode === 'roleplay';
    const wasImmersive = wasScene && previous.intensity === 'immersive';
    const persistedExplicitMode = MODES.includes(previous.explicitMode) ? previous.explicitMode : '';

    if (taskHit) {
      // 暂时切任务：保留 RP 现场，任务结束后允许自然恢复（§6.2）。
      mode = 'task';
      intensity = 'normal';
      source = 'continuity';
      evidence.push(taskHit);
      if (wasScene) evidence.push('carry-over:paused-scene');
    } else if (persistedExplicitMode) {
      // 配置/命令层面的显式模式在后续轮继续生效，直到被清除。
      mode = persistedExplicitMode;
      intensity = explicitIntensityFor(mode, previous.explicitIntensity);
      source = 'explicit';
      evidence.push('carry-over:explicit-mode');
    } else if (wasScene) {
      // 已经在场上：结构信号（本轮或前一轮用户发言）让戏继续；都没有就按"自然停顿"逐轮降档。
      const continues = strongSignals.length > 0 || priorSceneStrong > 0;
      if (continues) {
        nextIdle = 0;
        mode = 'roleplay';
        intensity = wasImmersive ? 'immersive' : 'subtle';
        source = wasImmersive ? 'carry-over' : 'continuity';
        evidence.push('carry-over:scene', ...strongSignals, ...weakSignals);
        if (priorSceneStrong > 0 && strongSignals.length === 0) evidence.push('context-signal:history-scene');
      } else {
        nextIdle = previousIdle + 1;
        if (wasImmersive && nextIdle <= 2) {
          // 前一两次走神：戏还在，强度不变（"允许场景自然停顿"）。
          mode = 'roleplay';
          intensity = 'immersive';
          source = 'carry-over';
          evidence.push('carry-over:scene-idle', `idle-turns:${nextIdle}`);
        } else if (wasImmersive && nextIdle <= 3) {
          // 第三次：降一档到轻度沉浸，而不是直接掐断。
          mode = 'roleplay';
          intensity = 'subtle';
          source = 'continuity';
          evidence.push('decay:immersive-to-subtle', `idle-turns:${nextIdle}`);
        } else if (!wasImmersive && nextIdle <= 2) {
          mode = 'roleplay';
          intensity = 'subtle';
          source = 'continuity';
          evidence.push('carry-over:subtle-idle', `idle-turns:${nextIdle}`);
        } else {
          // 持续走神：自然淡出，回到 chat/companion；现场进入 resume，之后还能接回来。
          mode = emotionHit ? 'companion' : 'chat';
          intensity = 'normal';
          source = 'continuity';
          evidence.push('decay:scene-closed', `idle-turns:${nextIdle}`);
          if (emotionHit) evidence.push(emotionHit);
        }
      }
    } else if (previous.resume && previous.resume.mode === 'roleplay' && (strongSignals.length > 0 || priorSceneStrong > 0)) {
      // 任务结束后自然恢复 RP：先回到轻度沉浸，不直接跳回原强度。
      mode = 'roleplay';
      intensity = 'subtle';
      source = 'continuity';
      evidence.push('resume:scene', ...strongSignals);
    } else if (strongSignals.length > 0) {
      // 引号对白 / 动作标记：单条消息足以判定"在演"，但只到 subtle。
      mode = 'roleplay';
      intensity = 'subtle';
      source = 'continuity';
      evidence.push(...strongSignals);
      bounded.push('single-signal-stays-subtle');
    } else if (priorSceneStrong > 0 && (weakSignals.length > 0 || abstractHit)) {
      // 前文已是场景，本轮用抽象表达/场景指示延续：仍只到 subtle。
      mode = 'roleplay';
      intensity = 'subtle';
      source = 'continuity';
      evidence.push(...weakSignals, 'context-signal:history-scene');
      if (abstractHit) evidence.push(abstractHit);
      bounded.push('immersive-requires-explicit-or-carry-over');
    } else if (emotionHit) {
      mode = 'companion';
      intensity = 'normal';
      source = 'continuity';
      evidence.push(emotionHit);
      if (weakSignals.length > 0) bounded.push('deixis-without-scene-is-not-roleplay');
    } else if (abstractHit) {
      // 抽象情绪单独出现 ⇒ 情绪交流，不是 RP（§6.2 "不能把抽象表达本身当作 RP 的充分证据"）。
      mode = 'companion';
      intensity = 'normal';
      source = 'continuity';
      evidence.push(abstractHit, 'bounded:abstract-emotion-not-roleplay');
    } else {
      mode = 'chat';
      intensity = 'normal';
      source = previous.turns > 0 ? 'continuity' : 'default';
      evidence.push('default:chat');
      if (weakSignals.length > 0 || priorSceneWeak > 0) bounded.push('signal-without-scene-evidence');
    }
  }

  // 自适应强度后再夹一次：单条消息永远拿不到 immersive（除非显式或已在沉浸中）。
  if (mode === 'roleplay' && intensity === 'immersive' && source !== 'explicit' && source !== 'override') {
    const carryOverImmersive = previous.mode === 'roleplay' && previous.intensity === 'immersive';
    if (!carryOverImmersive) {
      intensity = 'subtle';
      bounded.push('immersive-clamped');
    }
  }
  if (mode !== 'roleplay' && intensity !== 'normal') {
    bounded.push('non-roleplay-intensity-normalized');
    intensity = 'normal';
  }

  const profile = profileFor(mode, intensity);
  const operators = routeOperators(mode, intensity);
  const thinkingMode = thinkingModeFor(config, mode);

  // resume 维护：离开 RP 时记住现场（暂停或自然淡出都算），回到 RP 时清空。
  let resume = mode === 'roleplay' ? null : (previous.resume ?? null);
  if (mode === 'roleplay') {
    resume = null;
  } else if (previous.mode === 'roleplay') {
    resume = { mode: 'roleplay', intensity: previous.intensity };
    evidence.push(mode === 'task' ? 'resume:stored' : 'resume:stored-after-idle');
  }

  const sceneTurns = mode === 'roleplay' ? Number(previous.sceneTurns ?? 0) + 1 : 0;
  const calmTurns = nextIdle;

  const state = {
    sessionId: String(sessionId ?? previous.sessionId ?? ''),
    mode,
    intensity,
    profile,
    source,
    turns: Number(previous.turns ?? 0) + 1,
    sceneTurns,
    calmTurns,
    idleTurns: nextIdle,
    thinkingMode,
    resume,
    explicitMode: explicitNormalized.mode || previous.explicitMode || '',
    explicitIntensity: explicitNormalized.intensity || previous.explicitIntensity || '',
    updatedAt: Number.isFinite(now) && now > 0 ? new Date(now).toISOString() : '',
  };

  const confidence = (() => {
    if (source === 'explicit' || source === 'override') return 1;
    if (mode === 'roleplay' && intensity === 'immersive') return 0.9;
    if (mode === 'roleplay') return 0.6;
    if (mode === 'task') return taskHit ? 0.8 : 0.6;
    if (mode === 'companion') return 0.55;
    return 0.5;
  })();

  const route = {
    schemaVersion: ROUTE_SCHEMA_VERSION,
    mode,
    intensity,
    profile,
    thinkingMode,
    source,
    confidence,
    operators,
    evidence: [...new Set(evidence)].slice(0, 12),
    resume,
  };

  return {
    route,
    state,
    diagnostics: {
      reason: `${source}:${mode}/${intensity}`,
      signals: [...new Set([...strongSignals, ...weakSignals, taskHit, emotionHit, abstractHit].filter(Boolean))].slice(0, 12),
      bounded: [...new Set(bounded)],
      historyTurns: recent.length,
      priorSceneSignals: priorSceneStrong + priorSceneWeak,
    },
  };
}

export default {
  ROUTE_SCHEMA_VERSION,
  MODES,
  INTENSITIES,
  PROFILES,
  profileFor,
  routeOperators,
  initialState,
  routeTurn,
};
