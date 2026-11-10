/**
 * Prompt Engine — 认知算子与 Style Profile 模块目录（T2）。
 *
 * 依据 `PROMPT-ENGINE-CONTRACT.md` §2.4。本文件是**纯数据 + 纯函数**：
 * 不读文件、不写文件、不发网络请求、不调用模型、不读时间与随机数。
 *
 * 模块 ID / kind / priority / scenes 是外部契约（配置黑名单与测试逐字依赖），
 * 只能按合同表格新增，不能改名或改优先级。
 */

/**
 * 五个 Style Profile（`route.profile` 的唯一取值）。
 * `scenes` 里写满这五个即表示"全部档位生效"。
 */
export const PROMPT_PROFILES = Object.freeze([
  'chat',
  'companion',
  'implicit-roleplay',
  'roleplay-narrative',
  'task',
]);

const ALL_PROFILES = PROMPT_PROFILES;

/** 算子取值里哪些算"本轮需要这个模块"（`off` 与缺省都算不需要）。 */
const ACTIVE_OPERATOR_VALUES = new Set(['on', 'light', 'optional']);

/** 三个思考等级（与 `route.thinkingMode` 一一对应）。 */
export const THINKING_MODES = Object.freeze(['guided', 'structured', 'strict']);

/**
 * 模块目录。数组顺序 = 同优先级时的稳定排序依据；不要重排。
 *
 * 字段含义见合同 §2.4：
 * - `scenes`     profile 白名单；写 `ALL_PROFILES` 表示所有档位
 * - `operators`  非空 ⇒ 只有列出的算子为 on/light/optional 时才加入
 * - `charBudget` 该模块自身的目标字数（文档用；真正裁剪由 compose 的整模块预算负责）
 * - `render(ctx)` 返回中文提示词正文，`ctx = { route, config, personaPresent }`
 */
export const MODULES = Object.freeze([
  {
    id: 'route.header',
    label: 'Route Header',
    kind: 'header',
    priority: 95,
    dedupeKey: '',
    scenes: ALL_PROFILES,
    operators: [],
    charBudget: 40,
    // Contract-level "this does not change the persona / do not invent missing modules" lives once,
    // in `companion:prompt-contract` (the static section). Repeating it in every dynamic block is
    // the duplication the P3 pass removes; this header now only frames what follows.
    render: () => '【本轮写法】以下条目只管这一轮怎么写；没出现的就是这一轮不需要。',
  },
  {
    id: 'mode.chat-frame',
    label: 'Chat Frame',
    kind: 'mode',
    priority: 90,
    dedupeKey: 'mode',
    scenes: ['chat'],
    operators: [],
    charBudget: 60,
    // "不铺陈场景 / 不写成文章" duplicated the anti-ai style module and pulled narration rules
    // into plain chat; only the positive requirement stays.
    render: () => '【闲聊】像熟人聊天：直接回应他那件事，通常一两句，需要再展开。',
  },
  {
    id: 'mode.companion-frame',
    label: 'Companion Frame',
    kind: 'mode',
    priority: 90,
    dedupeKey: 'mode',
    scenes: ['companion'],
    operators: [],
    charBudget: 110,
    render: () => '【陪伴】先接住情绪再处理事情：承认他的处境，再给一句能落地的话。不安慰过头，不说教，不做长篇分析；他只说累的时候就停在陪着。',
  },
  {
    id: 'mode.implicit-frame',
    label: 'Implicit Roleplay Frame',
    kind: 'mode',
    priority: 90,
    dedupeKey: 'mode',
    scenes: ['implicit-roleplay'],
    operators: [],
    charBudget: 110,
    render: () => '【轻量叙事】以自然对白为主，可夹少量贴合语境的动作或神态；不突然大段描写环境，不宣布模式切换，也不要求他先说明开始角色扮演。',
  },
  {
    id: 'mode.roleplay-frame',
    label: 'Roleplay Narrative Frame',
    kind: 'mode',
    priority: 90,
    dedupeKey: 'mode',
    scenes: ['roleplay-narrative'],
    operators: [],
    charBudget: 110,
    render: () => '【叙事】用第一人称即时视角写这场戏：对白与动作交替，白描具体可感；守角色知识边界，只写他知道的事，不加解释性旁白，不强行升华总结，不替用户决定行动。',
  },
  {
    id: 'mode.task-frame',
    label: 'Task Frame',
    kind: 'mode',
    priority: 90,
    dedupeKey: 'mode',
    scenes: ['task'],
    operators: [],
    charBudget: 110,
    render: () => '【任务】直接给结论和做法：先答问题，再给必要步骤或代码。不铺垫情绪，不加场景描写，不写与问题无关的寒暄。',
  },
  {
    id: 'thinking.guided',
    label: 'Thinking Guided',
    kind: 'thinking',
    priority: 70,
    dedupeKey: 'thinking',
    scenes: ALL_PROFILES,
    operators: [],
    charBudget: 40,
    // "Think it through, do not show the working" is not a scene instruction for a model that
    // already reasons; kept only as the one line that still changes output shape.
    render: () => '【思考·引导】思考过程不外露，正文只给结论和他用得上的细节。',
  },
  {
    id: 'thinking.structured',
    label: 'Thinking Structured',
    kind: 'thinking',
    priority: 70,
    dedupeKey: 'thinking',
    scenes: ALL_PROFILES,
    operators: [],
    charBudget: 80,
    render: () => '【思考·结构化】遵循已校验的规划结果，不另起结构；规划只用来组织回答，不写进正文，也不解释自己是怎么想的。',
  },
  {
    id: 'thinking.strict',
    label: 'Thinking Strict',
    kind: 'thinking',
    priority: 70,
    dedupeKey: 'thinking',
    scenes: ALL_PROFILES,
    operators: [],
    charBudget: 80,
    render: () => '【思考·严格】按审查意见改写一次即可：只修被指出的问题，其余保持不变；不复述审查过程，不写改稿说明。',
  },
  {
    id: 'operator.dig',
    label: 'Operator DIG',
    kind: 'operator',
    priority: 80,
    dedupeKey: '',
    scenes: ALL_PROFILES,
    operators: ['DIG'],
    charBudget: 60,
    // DIG owns "what did he actually mean"; the "do not restate his words" half moves to the
    // anti-AI style module so exactly one module carries it.
    render: () => '【DIG·辨认】先弄清这句话真正在说什么、在意什么，再回应那件事；不替他补全没说出口的意思，不把猜测当事实。',
  },
  {
    id: 'operator.lore',
    label: 'Operator LORE',
    kind: 'operator',
    priority: 78,
    dedupeKey: '',
    scenes: ALL_PROFILES,
    operators: ['LORE'],
    charBudget: 130,
    render: () => '【LORE·设定】需要时再取用已有设定与记忆，冲突以最新说法为准；没有依据就不编。可以不调用，也可以整轮跳过，不必每次都补背景。',
  },
  {
    id: 'operator.arc',
    label: 'Operator ARC',
    kind: 'operator',
    priority: 76,
    dedupeKey: '',
    scenes: ALL_PROFILES,
    operators: ['ARC'],
    charBudget: 130,
    render: () => '【ARC·推进】让对话自然往下走，不催剧情、不靠制造冲突或悬念推动；他想停在当下就停，本轮不推进也完全可以。',
  },
  {
    id: 'operator.review',
    label: 'Operator REVIEW',
    kind: 'operator',
    priority: 74,
    dedupeKey: '',
    scenes: ALL_PROFILES,
    operators: ['REVIEW'],
    charBudget: 60,
    // REVIEW used to re-state the truthfulness check that `style.universal` and the Foundation
    // continuity section already own. What is left is the review-only behaviour: self-check
    // quietly, never print a checklist, never lengthen the reply.
    render: () => '【REVIEW·自检】写完快速核对有没有答非所问或硬加建议；有问题就地改，不输出检查清单，不拖长回复。',
  },
  {
    id: 'style.anti-ai-chat',
    label: 'Anti-AI Chat',
    kind: 'style',
    priority: 62,
    dedupeKey: '',
    scenes: ['chat'],
    operators: [],
    charBudget: 100,
    // The single owner of "do not restate him, do not answer a small question with an essay".
    // DIG no longer repeats the restating rule, and the chat frame no longer repeats the length
    // rule, so one module covers both without contradicting them.
    render: () => '【像人聊天】别复述他的话再回应；小问题别答成小作文，不强行补一句下一步建议。允许短回一句、吐槽或直接换话题。',
  },
  {
    id: 'style.emotional-companion',
    label: 'Emotional Companion',
    kind: 'style',
    priority: 62,
    dedupeKey: '',
    scenes: ['companion'],
    operators: [],
    charBudget: 200,
    render: () => '【陪伴语气】口语、具体、有温度：说人话，不写成评估或分析报告的口气，不贴标签、不做诊断、不讲课；少说“你应该”，多问他此刻怎么想。',
  },
  {
    id: 'style.implicit-roleplay',
    label: 'Implicit Roleplay Style',
    kind: 'style',
    priority: 62,
    dedupeKey: '',
    scenes: ['implicit-roleplay'],
    operators: [],
    charBudget: 200,
    render: () => '【轻量扮演】保持角色口吻，像聊天时顺手带一点神态和动作；幅度小、贴合当下情境，不描写房间陈设，不切换成小说腔。',
  },
  {
    id: 'style.roleplay-narrative',
    label: 'Roleplay Narrative Style',
    kind: 'style',
    priority: 62,
    dedupeKey: '',
    scenes: ['roleplay-narrative'],
    operators: [],
    charBudget: 200,
    render: () => '【叙事写法】白描为主：写看得见听得到的动作、对白与少量环境，用有限视角，只写角色知道的；不加解释性旁白说明含义，不在段尾升华总结，不写角色感知不到的信息。',
  },
  {
    id: 'style.task-clear',
    label: 'Task Clear Style',
    kind: 'style',
    priority: 62,
    dedupeKey: '',
    scenes: ['task'],
    operators: [],
    charBudget: 200,
    render: () => '【任务写法】先给结果再给理由，步骤编号、能省则省；代码和命令原样给，不写“希望这对你有帮助”这类客套。',
  },
  {
    id: 'style.anti-deepseek',
    label: 'Anti-DeepSeek Idioms',
    kind: 'style',
    priority: 50,
    dedupeKey: '',
    scenes: ALL_PROFILES,
    operators: [],
    charBudget: 170,
    render: ctx => (ctx?.route?.profile === 'task' ? ANTI_DEEPSEEK_TASK : ANTI_DEEPSEEK_FULL),
  },
  {
    id: 'style.universal',
    label: 'Universal Style',
    kind: 'style',
    priority: 40,
    dedupeKey: '',
    scenes: ALL_PROFILES,
    operators: [],
    charBudget: 40,
    render: () => '【通用】不编造现实事实与共同经历；不确定就说不知道。',
  },
]);

// 深度冻结：目录是只读常量，任何调用方都不能改到别人的输入。
for (const module of MODULES) {
  Object.freeze(module.scenes);
  Object.freeze(module.operators);
  Object.freeze(module);
}

/** 完整版：普通聊天/陪伴/叙事都按这套降低频率。 */
const ANTI_DEEPSEEK_FULL = '【降低套话】降频提示，不是禁词：对偶式“不是X，而是Y”“不像X，更像Y”、微微/一瞬/一拍这类填充词、抽象比喻、动作后解释情绪、连续并列短句、段尾强行总结、固定转折词。靠风格指导降频，不破坏正常中文表达，“不是”“没有”“其实”照常用。';

/** task 档用的精简版：任务回答里几乎没有叙事，只留真正会犯的几条。 */
const ANTI_DEEPSEEK_TASK = '【降低套话】少用对偶句、抽象比喻、动作后解释情绪和段尾强行总结；这些是降频提示不是禁词，正常中文照写。';

/** 模块 ID 列表（声明顺序）；配置黑名单与测试都用它。 */
export const MODULE_IDS = Object.freeze(MODULES.map(module => module.id));

const MODULE_INDEX = new Map(MODULES.map((module, index) => [module.id, index]));

/** 每个 ID 的稳定位置（同优先级排序依据）。 */
export function moduleOrder(id) {
  return MODULE_INDEX.has(id) ? MODULE_INDEX.get(id) : Number.MAX_SAFE_INTEGER;
}

function normalizeDisabled(disabled) {
  if (!Array.isArray(disabled)) return new Set();
  return new Set(disabled.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()));
}

/**
 * 为什么这个模块不进本轮 —— 返回 `''` 表示合格。
 * 合同允许的 reason：`scene` | `operator` | `disabled`（其余由 compose 负责）。
 * 思考等级不匹配与算子未激活同归 `operator`：两者都是"本轮模式不需要它"。
 */
export function moduleSkipReason(module, { profile, operators, thinkingMode, disabled } = {}) {
  if (!module || typeof module.id !== 'string') return 'empty';
  const disabledSet = disabled instanceof Set ? disabled : normalizeDisabled(disabled);
  if (disabledSet.has(module.id)) return 'disabled';
  if (!Array.isArray(module.scenes) || !module.scenes.includes(profile)) return 'scene';
  if (module.kind === 'thinking' && module.id !== `thinking.${thinkingMode}`) return 'operator';
  const operatorsList = Array.isArray(module.operators) ? module.operators : [];
  if (operatorsList.length > 0) {
    const active = operatorsList.some(op => ACTIVE_OPERATOR_VALUES.has(String(operators?.[op] ?? 'off')));
    if (!active) return 'operator';
  }
  return '';
}

/**
 * 本轮应当参与的模块（已按白名单/算子/思考等级过滤，未排序、未裁剪）。
 *
 * @param {{ profile?: string, operators?: object, thinkingMode?: string, disabled?: string[] }} input
 * @returns {Array<object>} 模块描述对象（引用 `MODULES` 里的冻结项，不复制、不修改）
 */
export function modulesFor({ profile = 'chat', operators = {}, thinkingMode = 'guided', disabled = [] } = {}) {
  return MODULES.filter(module => moduleSkipReason(module, { profile, operators, thinkingMode, disabled }) === '');
}

/**
 * Style Profile 的描述性元数据。**只描述**，不产生提示词；未知档位返回一个 inert 描述，
 * 便于调用方诊断而不是抛错或悄悄回落成 chat。
 */
export function styleProfileOf(profile) {
  return STYLE_PROFILES[profile] ?? {
    id: String(profile ?? ''),
    label: 'unknown',
    narration: false,
    forbidden: Object.freeze([]),
    styleModule: null,
    fallback: true,
  };
}

const STYLE_PROFILES = Object.freeze({
  chat: Object.freeze({
    id: 'chat',
    label: '闲聊',
    narration: false,
    forbidden: Object.freeze(['白描', '环境描写', '动作描写', '小说叙事']),
    styleModule: 'style.anti-ai-chat',
    tone: '日常口语，短回复为主，允许吐槽和换话题',
  }),
  companion: Object.freeze({
    id: 'companion',
    label: '陪伴',
    narration: false,
    forbidden: Object.freeze(['心理咨询报告口吻', '诊断', '贴标签', '长篇分析']),
    styleModule: 'style.emotional-companion',
    tone: '先接情绪再给一句可执行的话，不安慰过头',
  }),
  'implicit-roleplay': Object.freeze({
    id: 'implicit-roleplay',
    label: '轻量叙事',
    narration: 'light',
    forbidden: Object.freeze(['大段环境描写', '宣布模式切换', '要求用户声明开始角色扮演']),
    styleModule: 'style.implicit-roleplay',
    tone: '自然对白为主，少量贴合语境的动作',
  }),
  'roleplay-narrative': Object.freeze({
    id: 'roleplay-narrative',
    label: '叙事角色扮演',
    narration: true,
    forbidden: Object.freeze(['解释性旁白', '强制升华总结', '描写角色无法感知的信息']),
    styleModule: 'style.roleplay-narrative',
    tone: '白描、有限视角、按知识边界写',
  }),
  task: Object.freeze({
    id: 'task',
    label: '任务',
    narration: false,
    forbidden: Object.freeze(['扮演描写', '白描', '环境描写', '情绪铺垫']),
    styleModule: 'style.task-clear',
    tone: '先结论后步骤，直接回答',
  }),
});

/**
 * 静态 System Prompt Section：只解释"动态模块的解释规则"。
 * 不得包含白描/环境描写等具体风格内容（合同 §2.4），也不得与人格冲突。
 */
export function promptContractSection() {
  return {
    name: 'companion:prompt-contract',
    order: 65,
    text: '【动态写法模块】系统可能附上若干条本轮写法条目，由对话场景自动决定是否出现：没出现就是本轮不需要，不要自行补上，也不要向用户解释这些条目。取哪一档由系统判定，你不要宣布模式切换，也不要在回复里声明“现在进入某种模式”。条目与角色设定冲突时，角色认知边界优先于任何风格要求：不知道的不编，没有依据的经历不说成事实。这些条目只影响怎么写，不改变人格、身份与已知事实。',
  };
}
