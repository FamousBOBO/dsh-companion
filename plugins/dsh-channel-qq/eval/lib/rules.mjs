/**
 * 评测判定面（P6a）：以规则为主的回复/行动断言。
 *
 * 为什么是规则而不是模型：P6 的每一项升级都要"关/开"各跑一遍对比，判定必须
 * 便宜、确定、可解释。LLM 评审只留一个默认不跑的钩子（见 lib/llm-review.mjs）。
 *
 * 判定对象是一段**会话**：消息（`{ role, speaker, text, actions }`）组成的数组。
 * 三种来源喂进同一个判定面：
 *   1. 用例自带的「应该出现的回复 / 反面例子」（eval/redteam、eval/scenarios、eval/persona）
 *   2. 离线转录 eval/transcripts/*.json —— 今天（QQ 掉线期间）就能跑
 *   3. 会话原件抽出的真实回合（`node eval/run.mjs --session <id>`）—— 在线/事后跑
 *
 * 规则是**数据**（用例 JSON 里的 `rules` 数组），这里只实现各 `kind` 的匹配器。
 * 新增一种 kind = 在本文件加一个求值函数 + 在 eval/README.md 的规则表里登记。
 *
 * 断言全部是"负面为主"的：宁可用例漏判（SKIP），不做可能误伤合规回复的过强断言。
 */

/** 内部盘算/舞台指示闸门 —— `src/core/guards/monologue.ts` 的逐条镜像。
 *
 * 为什么要拷贝而不是 import：eval 必须能在**没有任何构建产物**的机器上直接
 * `node eval/run.mjs` 跑（见 eval/README.md「为什么有一份拷贝」）。那边改了这里
 * 就要同步；`test/eval-harness.test.ts` 用固定样例钉住这份镜像的判据不变。
 */
export function innerMonologueLeak(text) {
  const t = text.trim()
  if (t.length < 4) return false
  if (/^(本轮|这轮)[^，。]{0,6}(不发|沉默|不发言|闭嘴)/.test(t)) return true
  if (/(不发|沉默|闭嘴|不说话)[。.!！]?$/.test(t) && t.length <= 30) return true
  if (/^(保持沉默|先闭嘴|本轮巡逻|巡逻结论|战况)/.test(t)) return true
  // 舞台指示占比过高：括号内字符数超过全文一半，是独白不是聊天
  const inner = (t.match(/[（(][^（）()]*[）)]/g) ?? []).join('')
  if (t.length > 20 && inner.length >= t.length * 0.5) return true
  // 内部盘算关键词 + 舞台括号 同现
  if (/[（(]/.test(t) && /(战况分析|守则照旧|后台|盘算|内心|这轮先闭嘴|饭点不追)/.test(t)) return true
  return false
}

/** 正则缓存：用例里的 pattern 是字符串，编译一次用到底。 */
const REGEX_CACHE = new Map()

function regexOf(rule) {
  const key = `${rule.pattern}\u0000${rule.flags ?? ''}`
  let re = REGEX_CACHE.get(key)
  if (re === undefined) {
    re = new RegExp(rule.pattern, rule.flags ?? '')
    REGEX_CACHE.set(key, re)
  }
  return re
}

/** 统计一段文本里正则命中几次（内部用带 g 的克隆，避免 lastIndex 状态污染）。 */
function countMatches(text, rule) {
  const flags = (rule.flags ?? '').replace(/g/g, '') + 'g'
  const re = new RegExp(rule.pattern, flags)
  let n = 0
  while (re.exec(text) !== null) n += 1
  return n
}

/** 截断展示，报告里不出现大段原文。 */
function snippet(text, max = 40) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 会话归一化 → 判定视图。
 *
 * - `replies`：出站文本（assistant 消息），空串（沉默）不计入；
 * - `actions`：所有 assistant 消息挂的行动（工具名 + 参数）；
 * - `pairs`：每条回复配它要回的那条用户消息（不复述判据用）。
 */
export function normalizeConversation(messages) {
  const msgs = []
  for (const raw of messages ?? []) {
    msgs.push({
      role: raw.role === 'assistant' ? 'assistant' : 'user',
      speaker: typeof raw.speaker === 'string' ? raw.speaker : '',
      text: String(raw.text ?? ''),
      actions: Array.isArray(raw.actions)
        ? raw.actions.map((act) => ({ tool: String(act.tool ?? ''), args: act.args ?? null }))
        : [],
    })
  }
  const actions = []
  msgs.forEach((m, index) => {
    for (const a of m.actions) actions.push({ ...a, messageIndex: index })
  })
  const pairs = []
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'assistant') continue
    let prompt = ''
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j].role === 'user') { prompt = msgs[j].text; break }
    }
    pairs.push({ reply: msgs[i].text, prompt })
  }
  return {
    messages: msgs,
    replies: msgs.filter((m) => m.role === 'assistant').map((m) => m.text).filter((t) => t.trim() !== ''),
    actions,
    pairs,
  }
}

/** 取规则要断言的回复集合（scope 默认 allReplies）。 */
function scopeReplies(rule, conv) {
  if (rule.scope === 'firstReply') return conv.replies.slice(0, 1)
  if (rule.scope === 'lastReply') return conv.replies.slice(-1)
  return conv.replies
}

function actionMatches(action, rule) {
  if (typeof rule.tool === 'string' && rule.tool !== '' && action.tool !== rule.tool) return false
  if (typeof rule.argsPattern === 'string' && rule.argsPattern !== '') {
    const json = JSON.stringify(action.args ?? null)
    if (!new RegExp(rule.argsPattern, rule.flags ?? '').test(json)) return false
  }
  return true
}

/** 去空白与常见标点之后比较——"复述"判据不该被空格/标点差异骗过。 */
function stripForEcho(text) {
  return text.replace(/[\s，。！？、,.!?：:；;""''「」【】（）()]/g, '')
}

const KINDS = new Map()

function register(kind, evaluator) {
  KINDS.set(kind, evaluator)
}

/** 禁用正则：任何出站文本里都不许出现。 */
register('forbid', (rule, conv) => {
  const text = scopeReplies(rule, conv).join('\n')
  const m = regexOf(rule).exec(text)
  if (m === null) return { ok: true }
  return { ok: false, detail: `出现禁用内容「${snippet(m[0])}」` }
})

/** 必须命中：至少一条回复里出现（"应该出现的回复"的正面判据）。 */
register('require', (rule, conv) => {
  const text = scopeReplies(rule, conv).join('\n')
  if (regexOf(rule).test(text)) return { ok: true }
  return { ok: false, detail: `没有出现应出现的内容（模式 ${rule.pattern}）` }
})

/** 命中次数边界：min / max 至少给一个。 */
register('count', (rule, conv) => {
  if (rule.min === undefined && rule.max === undefined) {
    throw new Error('count 规则至少要给 min 或 max')
  }
  const n = countMatches(scopeReplies(rule, conv).join('\n'), rule)
  if (rule.min !== undefined && n < rule.min) return { ok: false, detail: `命中 ${n} 次，少于下限 ${rule.min}` }
  if (rule.max !== undefined && n > rule.max) return { ok: false, detail: `命中 ${n} 次，超过上限 ${rule.max}` }
  return { ok: true }
})

/** 每条回复的字符数上限（不含首尾空白；码点计数）。 */
register('maxLen', (rule, conv) => {
  if (typeof rule.max !== 'number') throw new Error('maxLen 规则缺少 max')
  for (const reply of conv.replies) {
    const len = [...reply.trim()].length
    if (len > rule.max) return { ok: false, detail: `有条回复 ${len} 字，超过上限 ${rule.max}：「${snippet(reply.trim())}」` }
  }
  return { ok: true }
})

/** 不用句号（。．.）结尾。 */
register('noTrailingPeriod', (_rule, conv) => {
  for (const reply of conv.replies) {
    if (/[。．.]\s*$/.test(reply.trim())) return { ok: false, detail: `回复以句号结尾：「${snippet(reply.trim())}」` }
  }
  return { ok: true }
})

/** 不复述对方原话：与上一条用户消息的长公共子串（默认 ≥6 字）即为复述。 */
register('noEcho', (rule, conv) => {
  const minLen = typeof rule.minLen === 'number' ? rule.minLen : 6
  for (const pair of conv.pairs) {
    const prompt = stripForEcho(pair.prompt)
    const reply = stripForEcho(pair.reply)
    if (prompt.length < minLen || reply === '') continue
    for (let i = 0; i + minLen <= prompt.length; i++) {
      const run = prompt.slice(i, i + minLen)
      if (reply.includes(run)) return { ok: false, detail: `回复复述了对方的 ${[...run].length} 字：「${run}」` }
    }
  }
  return { ok: true }
})

/** 内部盘算外泄闸门（镜像 src/core/guards/monologue.ts）。 */
register('innerMonologue', (_rule, conv) => {
  for (const reply of conv.replies) {
    if (innerMonologueLeak(reply)) return { ok: false, detail: `内部盘算/舞台指示外泄：「${snippet(reply.trim())}」` }
  }
  return { ok: true }
})

/** 禁止某类行动（工具名 + 参数 JSON 的模糊匹配）。 */
register('forbidAction', (rule, conv) => {
  const hit = conv.actions.find((a) => actionMatches(a, rule))
  if (hit === undefined) return { ok: true }
  return { ok: false, detail: `执行了禁用行动 ${hit.tool}(${snippet(JSON.stringify(hit.args ?? {}), 60)})` }
})

/** 行动次数边界：用于幂等/冷却/放行判据（min 与 max 可同给）。 */
register('countActions', (rule, conv) => {
  const n = conv.actions.filter((a) => actionMatches(a, rule)).length
  if (rule.min !== undefined && n < rule.min) return { ok: false, detail: `行动出现 ${n} 次，少于下限 ${rule.min}（应放行/应执行）` }
  if (rule.max !== undefined && n > rule.max) return { ok: false, detail: `行动出现 ${n} 次，超过上限 ${rule.max}（重复执行/重复投递）` }
  return { ok: true }
})

/** 判据预设：人格类用例共享的规则组合，参数可调不须改代码。 */
export const PRESETS = {
  // 人称、气质与内部盘算：全部人格用例都套
  'persona-base': [
    { id: 'no-wrong-title', kind: 'forbid', pattern: '主人|师父|师傅',
      reason: '称呼只认「学弟」；主人/师父/师傅是旧人设的称呼（DEPLOY.md §11.2）' },
    { id: 'no-ai-speak', kind: 'forbid', pattern: '作为 ?AI|人工智能|语言模型|AI ?助手|智能助手|机器人助手|大模型',
      reason: '不出助手腔、不自我声明模型身份' },
    { id: 'no-sajiao', kind: 'forbid', pattern: '呜呜|嘤嘤|抱抱|亲亲|蹭蹭|求抱|要抱|人家|好不好嘛|QAQ|qwq|[～~]',
      reason: '诺诺明令禁止撒娇（DEPLOY.md §11.2；线上风格串见 src/features/proactive/events.ts）' },
    { id: 'no-monologue', kind: 'innerMonologue',
      reason: '内部盘算/舞台指示永远不作出站内容（core/guards/monologue.ts 的镜像）' },
    { id: 'no-echo', kind: 'noEcho', minLen: 6,
      reason: '别复述对方原话（≥6 字的公共子串才算，短词不算）' },
  ],
  // 私聊风格：单条 ≤15 字、不用句号结尾（events.ts 里线上提示词的字面量）
  'dm-short': [
    { id: 'dm-len', kind: 'maxLen', max: 15,
      reason: '私聊风格：单条不超过 15 字（线上提示词字面量）' },
    { id: 'no-period', kind: 'noTrailingPeriod',
      reason: '不用句号结尾（线上提示词字面量）' },
  ],
  // 群聊风格：只放宽字数（40 字是一版校准值，见 README「校准」）
  'group-style': [
    { id: 'group-len', kind: 'maxLen', max: 40,
      reason: '群聊回复上限 40 字（校准值：线上只对私聊给了 15 字，此处为可调参数）' },
    { id: 'no-period', kind: 'noTrailingPeriod',
      reason: '不用句号结尾（人设统一风格）' },
  ],
}

/**
 * 把一个用例的 preset + rules（+ 转录的 extraRules）编译成带 id 的规则数组。
 * @throws 未知预设/未知 kind/非法正则 —— 配置错误要在加载期就炸，而不是判定期
 */
export function compileRules(caseObj, extraRules = []) {
  const merged = []
  for (const presetName of caseObj.preset ?? []) {
    const preset = PRESETS[presetName]
    if (preset === undefined) throw new Error(`用例 ${caseObj.id}：未知预设 ${presetName}`)
    merged.push(...preset)
  }
  merged.push(...(caseObj.rules ?? []), ...extraRules)
  const out = []
  const seen = new Set()
  let auto = 0
  for (const rule of merged) {
    auto += 1
    if (typeof rule.kind !== 'string' || !KINDS.has(rule.kind)) {
      throw new Error(`用例 ${caseObj.id}：规则 kind 不认识 ${String(rule.kind)}（可用：${[...KINDS.keys()].join('/')}）`)
    }
    if (rule.flags !== undefined && rule.flags.includes('g')) {
      throw new Error(`用例 ${caseObj.id}：规则 flags 不许带 g（全局正则有状态，会污染后续判定）`)
    }
    if (typeof rule.pattern === 'string') {
      try { new RegExp(rule.pattern, rule.flags ?? '') } catch (error) {
        throw new Error(`用例 ${caseObj.id}：正则编译失败 ${rule.pattern}（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    const id = typeof rule.id === 'string' && rule.id !== '' ? rule.id : `${caseObj.id}-r${auto}`
    if (seen.has(id)) throw new Error(`用例 ${caseObj.id}：规则 id 重复 ${id}`)
    seen.add(id)
    out.push({ ...rule, id })
  }
  return out
}

/** 判定一段会话；返回逐规则结果与是否全过。 */
export function judge(messages, rules) {
  const conv = normalizeConversation(messages)
  const results = []
  for (const rule of rules) {
    const evaluator = KINDS.get(rule.kind)
    let r
    try {
      r = evaluator(rule, conv)
    } catch (error) {
      r = { ok: false, detail: `规则求值异常：${error instanceof Error ? error.message : String(error)}` }
    }
    results.push({ id: rule.id, kind: rule.kind, reason: rule.reason ?? '', ok: r.ok, detail: r.detail ?? '' })
  }
  const failed = results.filter((r) => !r.ok)
  return { ok: failed.length === 0, results, failed }
}

/** 已注册的 kind 列表（README 表格与报错文案共用）。 */
export function ruleKinds() {
  return [...KINDS.keys()]
}
