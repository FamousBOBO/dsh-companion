/**
 * Prompt Engine — 结构化规划（Structured / Strict 的 Planner 阶段）。
 *
 * 依据 `PROMPT-ENGINE-CONTRACT.md` §2.5。纯函数：不读文件、不写文件、不发网络请求、
 * 不调用模型。模型调用由 `prompt-engine.mjs` 负责，这里只提供**提示词**与**校验**。
 *
 * 三条边界（任务书 §4.3 / §8）：
 *   1. Planner 只规划，不生成正文；产物与正文分离。
 *   2. JSON 必须过 Schema 校验；字段长度与数组数量有上限。
 *   3. 校验失败允许一次格式修复；再失败由引擎降级 Guided —— 本文件只如实回答 ok/errors。
 */

export const PLAN_SCHEMA_VERSION = 1;

/** 字段长度与数组数量上限。所有截断都发生在这里，调用方不必再自己 clamp。 */
export const PLAN_LIMITS = Object.freeze({
  goal: 240,
  constraints: 6,
  constraint: 120,
  time: 60,
  location: 60,
  participants: 6,
  participant: 40,
  knownFacts: 8,
  unknownFact: 120,
  unknowns: 6,
  characters: 5,
  characterId: 40,
  intention: 160,
  attitude: 80,
  knowledgeBoundary: 6,
  boundary: 80,
  operatorSummary: 200,
  nextBeat: 200,
  reviewIssues: 6,
  reviewIssue: 120,
  corrections: 6,
  correction: 120,
  styleProfile: 40,
  outputFormat: 40,
  renderedChars: 900,
  repairEchoChars: 4000,
});

/** 允许的 taskType / styleProfile / outputContract.format。 */
export const PLAN_ENUMS = Object.freeze({
  taskType: ['chat', 'companion', 'roleplay', 'task'],
  styleProfile: ['chat', 'companion', 'implicit-roleplay', 'roleplay-narrative', 'task'],
  format: ['natural_prose', 'structured_answer', 'short_reply'],
  operatorStatus: ['done', 'skipped', 'not-needed'],
});

const OPERATOR_NAMES = Object.freeze(['DIG', 'LORE', 'ARC', 'REVIEW']);

function clip(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function clipList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = clip(item, maxChars);
    if (!text) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * 从模型回复里取出 JSON 对象。
 *
 * 容忍 ```json 围栏、前后寒暄、以及前后多余文本；取**第一个**能解析的完整对象。
 * 解析不出来时返回 `ok: false`，从不抛错。
 *
 * @param {unknown} text
 * @returns {{ ok: boolean, value: object|null, error: string }}
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, value: null, error: 'empty' };
  const source = text.replace(/^\uFEFF/, '');

  // 1. 先试整串（最常见：模型只回了 JSON）。
  const direct = tryParse(source);
  if (direct.ok) return direct;

  // 2. 再去掉 markdown 围栏后试。
  const fenced = source.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) {
    const inner = tryParse(fenced[1]);
    if (inner.ok) return inner;
  }

  // 3. 最后做括号配对扫描：从每个 `{` 起找匹配的 `}`，取第一个解析成功的对象。
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = tryParse(source.slice(start, index + 1));
          if (candidate.ok) return candidate;
          break;
        }
      }
    }
  }
  return { ok: false, value: null, error: 'no-json-object' };
}

function tryParse(text) {
  try {
    const value = JSON.parse(String(text ?? '').trim());
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value, error: '' };
    return { ok: false, value: null, error: 'not-object' };
  } catch (error) {
    return { ok: false, value: null, error: `parse-failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 120) };
  }
}

/**
 * 按 Schema 校验并归一化一份规划。
 *
 * 返回的 `plan` 是**安全副本**：按 `PLAN_LIMITS` 截断、丢弃未知字段、数组限量。
 * `errors[].code` ∈ `not-object | wrong-version | missing | too-long | too-many | bad-enum | bad-type`。
 *
 * @param {unknown} value
 * @param {{limits?: object}} [options]
 * @returns {{ ok: boolean, plan: object|null, errors: Array<{path: string, code: string}> }}
 */
export function validatePlan(value, { limits = PLAN_LIMITS } = {}) {
  const errors = [];
  const add = (path, code) => errors.push({ path, code });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    add('$', 'not-object');
    return { ok: false, plan: null, errors };
  }
  const version = value.schemaVersion === undefined ? PLAN_SCHEMA_VERSION : Number(value.schemaVersion);
  if (version !== PLAN_SCHEMA_VERSION) {
    add('schemaVersion', 'wrong-version');
    return { ok: false, plan: null, errors };
  }

  const taskType = typeof value.taskType === 'string' ? value.taskType : 'chat';
  if (!PLAN_ENUMS.taskType.includes(taskType)) add('taskType', 'bad-enum');

  const intentIn = value.intent && typeof value.intent === 'object' ? value.intent : {};
  const goal = clip(intentIn.goal, limits.goal);
  if (!goal) add('intent.goal', 'missing');
  const constraints = clipList(intentIn.constraints, limits.constraints, limits.constraint);
  if (Array.isArray(intentIn.constraints) && intentIn.constraints.length > limits.constraints) add('intent.constraints', 'too-many');

  const sceneIn = value.scene && typeof value.scene === 'object' ? value.scene : {};
  const scene = {
    time: clip(sceneIn.time, limits.time),
    location: clip(sceneIn.location, limits.location),
    participants: clipList(sceneIn.participants, limits.participants, limits.participant),
    knownFacts: clipList(sceneIn.knownFacts, limits.knownFacts, limits.unknownFact),
    unknowns: clipList(sceneIn.unknowns, limits.unknowns, limits.unknownFact),
  };
  if (Array.isArray(sceneIn.participants) && sceneIn.participants.length > limits.participants) add('scene.participants', 'too-many');
  if (Array.isArray(sceneIn.knownFacts) && sceneIn.knownFacts.length > limits.knownFacts) add('scene.knownFacts', 'too-many');
  if (Array.isArray(sceneIn.unknowns) && sceneIn.unknowns.length > limits.unknowns) add('scene.unknowns', 'too-many');

  const charactersIn = Array.isArray(value.characters) ? value.characters : [];
  const characters = [];
  for (const [index, raw] of charactersIn.entries()) {
    if (characters.length >= limits.characters) {
      add('characters', 'too-many');
      break;
    }
    if (!raw || typeof raw !== 'object') {
      add(`characters[${index}]`, 'bad-type');
      continue;
    }
    const id = clip(raw.id, limits.characterId);
    if (!id) {
      add(`characters[${index}].id`, 'missing');
      continue;
    }
    characters.push({
      id,
      intention: clip(raw.intention, limits.intention),
      attitude: clip(raw.attitude, limits.attitude),
      knowledgeBoundary: clipList(raw.knowledgeBoundary, limits.knowledgeBoundary, limits.boundary),
    });
  }

  const operatorsIn = value.operators && typeof value.operators === 'object' ? value.operators : {};
  const operators = {};
  for (const name of OPERATOR_NAMES) {
    const raw = operatorsIn[name] && typeof operatorsIn[name] === 'object' ? operatorsIn[name] : {};
    const status = typeof raw.status === 'string' ? raw.status : 'done';
    if (!PLAN_ENUMS.operatorStatus.includes(status)) add(`operators.${name}.status`, 'bad-enum');
    operators[name] = {
      status: PLAN_ENUMS.operatorStatus.includes(status) ? status : 'done',
      summary: clip(raw.summary, limits.operatorSummary),
      ...(name === 'ARC' ? { nextBeat: clip(raw.nextBeat, limits.nextBeat) } : {}),
      ...(name === 'REVIEW'
        ? {
            issues: clipList(raw.issues, limits.reviewIssues, limits.reviewIssue),
            corrections: clipList(raw.corrections, limits.corrections, limits.correction),
          }
        : {}),
    };
  }

  const styleProfile = typeof value.styleProfile === 'string' ? value.styleProfile : 'chat';
  if (!PLAN_ENUMS.styleProfile.includes(styleProfile)) add('styleProfile', 'bad-enum');

  const outputIn = value.outputContract && typeof value.outputContract === 'object' ? value.outputContract : {};
  const format = typeof outputIn.format === 'string' ? outputIn.format : 'natural_prose';
  if (!PLAN_ENUMS.format.includes(format)) add('outputContract.format', 'bad-enum');

  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    taskType: PLAN_ENUMS.taskType.includes(taskType) ? taskType : 'chat',
    intent: { goal, constraints },
    scene,
    characters,
    operators,
    styleProfile: PLAN_ENUMS.styleProfile.includes(styleProfile) ? styleProfile : 'chat',
    outputContract: { format: PLAN_ENUMS.format.includes(format) ? format : 'natural_prose' },
  };

  // 只有"缺关键字段"或"枚举越界"才算失败；超长/超量已在上面安全截断，只记录不改判。
  const fatal = errors.filter(error => ['not-object', 'wrong-version', 'missing', 'bad-enum', 'bad-type'].includes(error.code));
  return { ok: fatal.length === 0, plan, errors };
}

const PLAN_RULES = [
  '你只输出一个 JSON 对象，不写正文，不写解释，不调用任何工具。',
  '不知道的字段留空字符串或空数组，绝不编造事实、时间、地点或人物经历。',
  '这份规划只用于组织接下来的回答；它本身不会展示给用户。',
  'operators 里 DIG/LORE/ARC/REVIEW 各自给 status（done/skipped/not-needed）与一句 summary；',
  '不需要的算子就写 skipped，不要为了填满而编内容。',
];

function planShape(limits) {
  return [
    '{',
    `  "schemaVersion": ${PLAN_SCHEMA_VERSION},`,
    '  "taskType": "chat|companion|roleplay|task",',
    '  "intent": { "goal": "", "constraints": [] },',
    '  "scene": { "time": "", "location": "", "participants": [], "knownFacts": [], "unknowns": [] },',
    `  "characters": [{ "id": "", "intention": "", "attitude": "", "knowledgeBoundary": [] }],`,
    '  "operators": {',
    '    "DIG": { "status": "done", "summary": "" },',
    '    "LORE": { "status": "done", "summary": "" },',
    '    "ARC": { "status": "done", "nextBeat": "" },',
    '    "REVIEW": { "status": "done", "issues": [], "corrections": [] }',
    '  },',
    '  "styleProfile": "chat|companion|implicit-roleplay|roleplay-narrative|task",',
    '  "outputContract": { "format": "natural_prose|structured_answer|short_reply" }',
    '}',
    `字段上限：goal≤${limits.goal} 字，constraints≤${limits.constraints} 条，characters≤${limits.characters} 个，`,
    'knownFacts≤8 条，每个 summary≤200 字。',
  ].join('\n');
}

/**
 * 构造 Planner 的提示词。
 *
 * `input.length <= config.planner.maxInputChars` 是硬约束：超长时按"旧→新"裁剪上下文，
 * 永远保留当前的用户消息（否则规划针对的是过去）。
 *
 * @returns {{ system: string, input: string }}
 */
export function buildPlannerPrompt({
  route = null,
  persona = '',
  memoryContext = '',
  workingMemory = '',
  userMessage = '',
  config = null,
  limits = PLAN_LIMITS,
} = {}) {
  const maxInputChars = Math.max(1000, Math.min(40000, Number(config?.planner?.maxInputChars) || 8000));
  const system = [
    '你是内部规划器，为一个陪伴型角色准备下一轮的写作规划。',
    ...PLAN_RULES,
    '',
    '输出 schema：',
    planShape(limits),
  ].join('\n');

  const mode = String(route?.mode ?? 'chat');
  const intensity = String(route?.intensity ?? 'normal');
  const profile = String(route?.profile ?? 'chat');
  const operators = route?.operators && typeof route.operators === 'object' ? route.operators : {};
  const operatorLine = OPERATOR_NAMES
    .map(name => `${name}=${String(operators[name] ?? 'off')}`)
    .join(' ');

  // 先拼"必须保留"的部分（尾部），再从旧到新把可选上下文补进剩余空间。
  const tail = [
    `【本轮场景】mode=${mode} intensity=${intensity} profile=${profile} 算子=${operatorLine}`,
    `【用户当前这句】${clip(userMessage, 600) || '(空)'}`,
    '只输出 JSON。',
  ].join('\n');
  const head = ['【角色设定摘要】', clip(persona, 1200) || '(未提供)'].join('\n');

  let remaining = maxInputChars - system.length - head.length - tail.length - 4;
  const optional = [];
  for (const [label, text] of [['【长期记忆摘要】', memoryContext], ['【当前工作记忆】', workingMemory]]) {
    const body = clip(text, 2400);
    if (!body) continue;
    const block = [label, body].join('\n');
    if (block.length > remaining) {
      // 宁可少给上下文，也不越过 maxInputChars。
      continue;
    }
    optional.push(block);
    remaining -= block.length + 1;
  }

  let input = [head, ...optional, tail].join('\n');
  if (input.length > maxInputChars) {
    // 最后一道保险：从头部裁掉设定摘要的超长部分。
    const overflow = input.length - maxInputChars;
    input = [ ['【角色设定摘要】', clip(persona, Math.max(120, 1200 - overflow))].join('\n'), ...optional, tail ].join('\n').slice(-maxInputChars);
  }
  return { system: system.slice(0, 2400), input: input.slice(0, maxInputChars) };
}

/** 一次格式修复的提示词：只要求修 JSON，不要重做规划。 */
export function buildRepairPrompt({ rawText = '', errors = [], config = null, limits = PLAN_LIMITS } = {}) {
  const maxInputChars = Math.max(1000, Math.min(40000, Number(config?.planner?.maxInputChars) || 8000));
  const errorText = (Array.isArray(errors) ? errors : [])
    .slice(0, 8)
    .map(error => `${String(error?.path ?? '$')}: ${String(error?.code ?? 'invalid')}`)
    .join('; ');
  const echo = clip(String(rawText ?? ''), Math.min(limits.repairEchoChars, Math.max(600, maxInputChars - 700)));
  const system = [
    '你是内部格式修复器。上一份规划不是合法 JSON 或不符合 schema。',
    '只输出修正后的 JSON 对象，不写正文、不解释、不调用工具，也不要改变原来的规划意图。',
    '输出 schema：',
    planShape(limits),
  ].join('\n');
  const input = [
    `【校验失败项】${errorText || '$: not-json'}`,
    '【上一次的输出】',
    echo,
    '只输出 JSON。',
  ].join('\n');
  return { system: system.slice(0, 2400), input: input.slice(0, maxInputChars) };
}

/**
 * 把已验证的规划渲染成给 Writer 的紧凑指导。
 *
 * 只输出非空字段；总长 ≤ `PLAN_LIMITS.renderedChars`（900 字）。空规划返回空串。
 *
 * @param {object|null} plan
 * @returns {string}
 */
export function renderPlanForWriter(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const lines = [];
  const goal = clip(plan.intent?.goal, PLAN_LIMITS.goal);
  if (goal) lines.push(`目标：${goal}`);
  const constraints = clipList(plan.intent?.constraints, PLAN_LIMITS.constraints, PLAN_LIMITS.constraint);
  if (constraints.length) lines.push(`约束：${constraints.join('；')}`);

  const sceneBits = [];
  const time = clip(plan.scene?.time, PLAN_LIMITS.time);
  const location = clip(plan.scene?.location, PLAN_LIMITS.location);
  if (time) sceneBits.push(`时间 ${time}`);
  if (location) sceneBits.push(`地点 ${location}`);
  const participants = clipList(plan.scene?.participants, PLAN_LIMITS.participants, PLAN_LIMITS.participant);
  if (participants.length) sceneBits.push(`在场 ${participants.join('、')}`);
  if (sceneBits.length) lines.push(`场景：${sceneBits.join('，')}`);

  const known = clipList(plan.scene?.knownFacts, PLAN_LIMITS.knownFacts, PLAN_LIMITS.unknownFact);
  if (known.length) lines.push(`已知：${known.join('；')}`);
  const unknowns = clipList(plan.scene?.unknowns, PLAN_LIMITS.unknowns, PLAN_LIMITS.unknownFact);
  if (unknowns.length) lines.push(`未知（不要编）：${unknowns.join('；')}`);

  for (const character of Array.isArray(plan.characters) ? plan.characters.slice(0, PLAN_LIMITS.characters) : []) {
    const id = clip(character?.id, PLAN_LIMITS.characterId);
    if (!id) continue;
    const bits = [];
    const intention = clip(character?.intention, PLAN_LIMITS.intention);
    const attitude = clip(character?.attitude, PLAN_LIMITS.attitude);
    if (intention) bits.push(`意图 ${intention}`);
    if (attitude) bits.push(`态度 ${attitude}`);
    const boundary = clipList(character?.knowledgeBoundary, PLAN_LIMITS.knowledgeBoundary, PLAN_LIMITS.boundary);
    if (boundary.length) bits.push(`认知边界 ${boundary.join('、')}`);
    if (bits.length) lines.push(`角色 ${id}：${bits.join('；')}`);
  }

  for (const name of OPERATOR_NAMES) {
    const operator = plan.operators?.[name];
    if (!operator || operator.status === 'not-needed') continue;
    const bits = [];
    const summary = clip(operator.summary, PLAN_LIMITS.operatorSummary);
    if (summary) bits.push(summary);
    if (name === 'ARC') {
      const nextBeat = clip(operator.nextBeat, PLAN_LIMITS.nextBeat);
      if (nextBeat) bits.push(`下一步 ${nextBeat}`);
    }
    if (name === 'REVIEW') {
      const issues = clipList(operator.issues, PLAN_LIMITS.reviewIssues, PLAN_LIMITS.reviewIssue);
      const corrections = clipList(operator.corrections, PLAN_LIMITS.corrections, PLAN_LIMITS.correction);
      if (issues.length) bits.push(`需注意 ${issues.join('；')}`);
      if (corrections.length) bits.push(`修正 ${corrections.join('；')}`);
    }
    if (!bits.length) continue;
    lines.push(`${name}（${operator.status}）：${bits.join('；')}`);
  }

  if (!lines.length) return '';
  const rendered = ['【本轮规划】', ...lines].join('\n');
  return rendered.length > PLAN_LIMITS.renderedChars ? rendered.slice(0, PLAN_LIMITS.renderedChars) : rendered;
}

export default {
  PLAN_SCHEMA_VERSION,
  PLAN_LIMITS,
  PLAN_ENUMS,
  extractJsonObject,
  validatePlan,
  buildPlannerPrompt,
  buildRepairPrompt,
  renderPlanForWriter,
};
