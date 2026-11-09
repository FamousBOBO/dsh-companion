/**
 * **混合型机器人生态的评测指标层**（`13-G4` 补充修订 §6）。
 *
 * 这一层只做一件事：把一批**逐条评测记录**（JSON 对象）折叠成可比的分层指标。它不产生数据、
 * 不读盘、不联网、不看时钟，也不调用任何生产判定——同样的输入永远出同样的输出，因此可以离线重放。
 *
 * 五条纪律（每一条都对应一次具体的误读）：
 *
 *   1. **必须分层**。§6 最后一段写得很明确：Bot 数量多会掩盖人类互动能力的问题。所以
 *      `aggregate()` 同时给**总体**与四个 `sceneLabel` 分层，两层用**同一套判据**算——
 *      不是"总体一份口径、分层另一份"，那样两层就没法互相印证。
 *
 *   2. **没有标注就是 null，不是 0**。自然度 / Bot-to-Bot 讨论质量 / 人格独立性是 §7 的
 *      **人工盲评**指标：没有人工标注时返回 `null` 且 `status: 'needs-human-label'`。
 *      绝不能用"回复长度""和别的 Bot 的相似度"这类代理值顶上去——那是拿机器偏好冒充人的判断，
 *      而读报告的人会把它当成一次评测结论。
 *
 *   3. **分母为 0 也是 null**。0/0 是"没有样本"，0/5 是"0%"，两件事在报告里必须长得不一样。
 *      把 0/0 写成 0% 会让"这一层什么都没测"看起来像"这一层全错"。
 *
 *   4. **§6 明写不算失败的，不进失败计数**：对 Bot 沉默、没回应每一个人类发言、没加入每个话题、
 *      没模仿群内其他 Bot——这些只出现在 `behavior`（行为分布）里。`failures` 只收**确定的坏**：
 *      坏输出、目标没命中、代码 veto、身份标签对不上、自己都判了 high 风险还生成候选发言。
 *
 *   5. **不猜身份**。身份相关指标只用记录里**采集侧已按注册表核对过**的计数（`identity` 块）。
 *      本层绝不从正文、昵称、回复速度或"像 AI 的措辞"推断谁是 Bot（§2.1 最后一条约束）。
 *
 * 本层会读的记录字段（缺省即"没有这个数"，一律不补 0）：
 *   sceneLabel / action / decisionTier / targetValid / veto / candidateText / targetKind /
 *   targetUserId / botParticipants / participantRegistryVersion / botLoopRisk / semanticDuplicate /
 *   alreadyAnswered / newInformation / topicShifted / topicShiftRecognized / latencyMs / tokens /
 *   personaVersion / modelName / source，以及两个由采集侧注入的可选块：
 *     `identity`: { labeled, correct, unknownTotal, unknownRetained }
 *       —— 事件发生时按注册表逐人核对的结果，本层只汇总；
 *     `humanLabels`: { naturalness, discussionQuality, personaIndependence, imitatesOtherBot }
 *       —— §7 盲评分数（0–1；1–5 分制先用 normalizeHumanLabels 换算）；没有就是没有。
 */

/** 指标层版本：判据一变就要加一，读报告的人据此判断"这份报告是按哪套口径算的"。 */
export const METRICS_VERSION = 1

/** §1.1 的四个场景标签（顺序即报告顺序）。 */
export const SCENE_LABELS = ['bot_to_bot', 'bot_to_human', 'mixed_group', 'unknown_participant']

/** 场景标签 → 报告里的标题（与修订文档 §1.1 的表格用同一套叫法）。 */
export const SCENE_TITLES = {
  bot_to_bot: 'Bot → Bot',
  bot_to_human: 'Bot → Human',
  mixed_group: 'Mixed → Group',
  unknown_participant: 'Unknown → Group',
}

/**
 * §6 表逐条对应的十个指标（顺序即报告顺序；键名即报告里的行）。
 *
 * direction 不能省。"Bot 重复响应率 0.0"和"跨 Bot 回复对象准确率 0.0"字面一样，含义相反：
 * 前者**越低越好**，后者**越高越好**。报告里不写方向，读者就会把满分读成零分。
 * neutral 那一项（循环风险识别率）是**覆盖率**不是好坏——它高只说明这批里被判成高风险的
 * 场景多，得和 loopRisk 分布一起看。
 */
export const METRIC_DEFS = [
  { key: 'participantIdentificationAccuracy', label: '参与者识别准确率', direction: 'higher-better' },
  { key: 'unknownRetentionRate', label: 'Unknown 保留率', direction: 'higher-better' },
  { key: 'botRepeatResponseRate', label: 'Bot 重复响应率', direction: 'higher-worse' },
  { key: 'botLoopRiskDetectionRate', label: 'Bot 循环风险识别率', direction: 'neutral' },
  { key: 'crossBotTargetAccuracy', label: '跨 Bot 回复对象准确率', direction: 'higher-better' },
  { key: 'mixedTopicSwitchAccuracy', label: '混合话题切换准确率', direction: 'higher-better' },
  { key: 'botToHumanNaturalness', label: 'Bot-to-Human 自然度（人工）', direction: 'higher-better' },
  { key: 'botToBotDiscussionQuality', label: 'Bot-to-Bot 讨论质量（人工）', direction: 'higher-better' },
  { key: 'personaIndependence', label: '人格独立性（人工）', direction: 'higher-better' },
  { key: 'wastedParticipationRate', label: '无价值参与率', direction: 'higher-worse' },
]

/** 方向 → 报告列里的中文（读报告的人不该为了看懂一列去翻代码）。 */
const DIRECTION_TITLES = { 'higher-better': '越高越好', 'higher-worse': '越低越好', neutral: '覆盖率（非好坏）' }

/** 某个指标的方向说明（report.mjs 用；未知键返回 null，不编一个默认方向）。 */
export function directionOf(key) {
  const def = METRIC_DEFS.find((item) => item.key === key)
  if (def === undefined) return null
  return DIRECTION_TITLES[def.direction] ?? null
}

/**
 * 人工评分类指标（§7 盲评）：**没有标注时必须 null**。
 *
 * 为什么单列一张表而不是在计算时逐个 if：这是一条硬约束，单列之后测试能直接遍历它断言，
 * 代码里也不会出现"第四个人忘了写 status"。
 */
export const HUMAN_RATED_METRICS = ['botToHumanNaturalness', 'botToBotDiscussionQuality', 'personaIndependence']

/** 人工评分在记录里的字段名（中心列 ↔ 盲评表的分项）。 */
const HUMAN_LABEL_FIELDS = {
  botToHumanNaturalness: 'naturalness',
  botToBotDiscussionQuality: 'discussionQuality',
  personaIndependence: 'personaIndependence',
}

/**
 * 盲评分数按场景收口：自然度只在"场景里有人类"的分层里有定义，讨论质量只在"场景里有别的 Bot"
 * 的分层里有定义。为什么不在全局混算：把 Bot-to-Bot 的评分摊进总体自然度，等于用一群机器人的
 * 分数回答"她对人类自然不自然"——正是 §6 最后一段要防的那种掩盖。
 */
const LABEL_SCENES = {
  naturalness: ['bot_to_human', 'mixed_group'],
  discussionQuality: ['bot_to_bot', 'mixed_group'],
  personaIndependence: ['bot_to_bot', 'bot_to_human', 'mixed_group', 'unknown_participant'],
}

/** 会产生候选发言的动作（有话说；发不发得出是后面的事）。 */
const CANDIDATE_ACTIONS = new Set(['reply', 'join', 'react'])

/**
 * 长数字串（**≥5 位**）脱敏，与 `eval/group/llm/record.mjs` 同一口径。
 *
 * 为什么评测层也要脱敏：记录里的 `veto` 理由与 `decisionTier` 常复述背景，而真实部署里那些
 * 数字就是群号与 QQ 号。报告会被贴进工单和聊天窗口，脱敏必须落在**生成报告的这一层**，
 * 不能指望上游每次都记得洗。
 */
export function redact(text) {
  return String(text ?? '').replace(/\d{5,}/g, '<长数字号>')
}

/** 有限数才算数（NaN / undefined / 字符串一律当"没有这个数"）。 */
function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 比率：分母为 0 → null（不是 0）。保留 4 位，避免报告里出现 0.30000000000000004。 */
function ratio(numerator, denominator) {
  if (!(denominator > 0)) return null
  return Number((numerator / denominator).toFixed(4))
}

/** 均值：没有样本 → null。 */
function meanOf(values) {
  const list = values.filter(isNum)
  if (list.length === 0) return null
  const sum = list.reduce((total, value) => total + value, 0)
  return Number((sum / list.length).toFixed(4))
}

/** 分位（报告的技术段落用；空集给 null，不拿 0 冒充"没有延迟"）。 */
function percentile(values, pct) {
  const list = values.filter(isNum).sort((a, b) => a - b)
  if (list.length === 0) return null
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil((pct / 100) * list.length) - 1))
  return list[index]
}

/** 一条记录是不是"产生了候选发言"（有话说，不管最后有没有被闸门拦下）。 */
function hasCandidate(record) {
  if (!CANDIDATE_ACTIONS.has(record.action)) return false
  return typeof record.candidateText === 'string' && record.candidateText.trim() !== ''
}

/** 场景里有几个已登记的 Bot（"Bot 循环"至少要两个才谈得上）。 */
function botCountOf(record) {
  return Array.isArray(record.botParticipants) ? record.botParticipants.length : 0
}

/** 记录里的身份核对块是否可用（四个计数都得是有限数，否则整块当没有）。 */
function identityOf(record) {
  const block = record.identity
  if (block === null || typeof block !== 'object') return null
  const out = {}
  for (const key of ['labeled', 'correct', 'unknownTotal', 'unknownRetained']) {
    const value = block[key]
    if (!isNum(value)) return null
    out[key] = value
  }
  return out
}

/** 一条记录指向的对象是不是已登记的 Bot（"跨 Bot 回复对象"的分母）。 */
function targetsKnownBot(record) {
  if (record.targetKind === 'known_bot') return true
  if (record.targetKind === 'known_human' || record.targetKind === 'unknown' || record.targetKind === 'self') return false
  const bots = Array.isArray(record.botParticipants) ? record.botParticipants : []
  const target = record.targetUserId
  return isNum(target) && bots.some((bot) => String(bot) === String(target))
}

/** 盲评分数：只收 0–1；别的量纲一律当"没有"（1–5 分制先走 normalizeHumanLabels）。 */
function labelValue(raw) {
  return isNum(raw) && raw >= 0 && raw <= 1 ? raw : null
}

/**
 * 把 1–5 分制的盲评分数换算成 0–1。
 *
 * 为什么不自动嗅探量纲：自动嗅探会让"某次只给了 1 分"被当成 0 分，报告里就凭空出现一个低分。
 * 量纲由**采集侧**声明（`scale` 参数），这里只做换算。
 */
export function normalizeHumanLabels(labels, { scale = 1 } = {}) {
  const out = {}
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!isNum(value)) continue
    out[key] = scale === 1 ? value : Number(((value - 1) / (scale - 1)).toFixed(4))
  }
  return out
}

/** 空累加器：所有计数从 0 起，"有没有样本"由**分母**决定，不靠哨兵值。 */
function newAccumulator() {
  return {
    runs: 0,
    action: { silent: 0, observe: 0, reply: 0, join: 0, react: 0, other: 0 },
    candidates: 0,
    // ① 身份核对（采集侧判过的）
    labeled: 0,
    labeledCorrect: 0,
    unknownTotal: 0,
    unknownRetained: 0,
    // ② Bot 重复响应
    repeatDenominator: 0,
    repeatCandidates: 0,
    // ③ Bot 循环风险识别
    loopEligible: 0,
    loopFlagged: 0,
    loopRisk: { low: 0, medium: 0, high: 0, unknown: 0 },
    // ④ 跨 Bot 回复对象
    crossBotTargets: 0,
    crossBotHits: 0,
    // ⑤ 混合话题切换
    topicShifts: 0,
    topicShiftHits: 0,
    // ⑥ 无价值参与
    wastedDenominator: 0,
    wastedCandidates: 0,
    // ⑦ 人工评分三列
    labels: { naturalness: [], discussionQuality: [], personaIndependence: [] },
    // ⑧ §6 明写"不算失败"的行为：只进行为分布
    behavior: { silentOnBotScene: 0, observed: 0, noCandidateRuns: 0, imitatedOtherBot: 0 },
    // ⑨ 确定的坏
    failure: { invalidOutput: 0, targetMiss: 0, codeVeto: 0, identityMismatch: 0, highRiskCandidate: 0 },
    failingRuns: 0,
    latency: [],
    tokens: { prompt: 0, completion: 0, missing: 0 },
    models: new Set(),
    personas: new Set(),
    registries: new Set(),
    sources: new Set(),
    runIds: new Set(),
  }
}

/**
 * 把**一条记录**折叠进累加器。
 *
 * 刻意不做的事：不从正文推断发言者是 Bot、不拿重复度当"质量分"、不把沉默记成失败。
 */
function foldInto(acc, record, sceneLabel) {
  acc.runs += 1
  if (record.runId !== undefined && record.runId !== null) acc.runIds.add(String(record.runId))
  if (record.modelName !== undefined) acc.models.add(String(record.modelName))
  if (record.personaVersion !== undefined) acc.personas.add(String(record.personaVersion))
  if (record.participantRegistryVersion !== undefined) acc.registries.add(String(record.participantRegistryVersion))
  if (record.source !== undefined) acc.sources.add(String(record.source))

  const action = record.action
  if (action === 'silent' || action === 'observe' || action === 'reply' || action === 'join' || action === 'react') {
    acc.action[action] += 1
  } else {
    acc.action.other += 1
  }

  const candidate = hasCandidate(record)
  if (candidate) acc.candidates += 1
  else acc.behavior.noCandidateRuns += 1

  // §6 明写**不算失败**：对 Bot 保持沉默。只进行为分布，不进 failure。
  if (action === 'silent' && botCountOf(record) > 0) acc.behavior.silentOnBotScene += 1
  if (action === 'observe') acc.behavior.observed += 1

  const identity = identityOf(record)
  if (identity !== null) {
    acc.labeled += identity.labeled
    acc.labeledCorrect += identity.correct
    acc.unknownTotal += identity.unknownTotal
    acc.unknownRetained += identity.unknownRetained
  }

  const risk = record.botLoopRisk
  if (risk === 'low' || risk === 'medium' || risk === 'high') acc.loopRisk[risk] += 1
  else acc.loopRisk.unknown += 1

  // Bot 循环风险识别：只统计**至少两个已登记 Bot**的场景（一个 Bot 谈不上循环）。
  if (botCountOf(record) >= 2 && (risk === 'low' || risk === 'medium' || risk === 'high')) {
    acc.loopEligible += 1
    if (risk === 'high') acc.loopFlagged += 1
  }

  // Bot 重复响应：分母是"场景里有别的 Bot 时的候选发言"。
  if (candidate && botCountOf(record) > 0) {
    acc.repeatDenominator += 1
    if (record.semanticDuplicate === true) acc.repeatCandidates += 1
  }

  // 跨 Bot 回复对象：分母是"候选发言且目标指向一个已登记的 Bot"。
  if (candidate && targetsKnownBot(record)) {
    acc.crossBotTargets += 1
    const vetoed = typeof record.veto === 'string' && record.veto !== ''
    if (record.targetValid === true && !vetoed) acc.crossBotHits += 1
  }

  // 混合话题切换：只在采集侧标了"话题确实变了"的记录上算。
  if (record.topicShifted === true) {
    acc.topicShifts += 1
    if (record.topicShiftRecognized === true) acc.topicShiftHits += 1
  }

  // 无价值参与：分母是"候选发言且给出了 newInformation 判定"。
  if (candidate && typeof record.newInformation === 'boolean') {
    acc.wastedDenominator += 1
    if (record.newInformation === false) acc.wastedCandidates += 1
  }

  // 人工评分：按场景决定这一条该不该计入某个盲评维度。
  const labels = record.humanLabels
  if (labels !== null && typeof labels === 'object') {
    for (const [column, field] of Object.entries(HUMAN_LABEL_FIELDS)) {
      if (!LABEL_SCENES[field].includes(sceneLabel)) continue
      const value = labelValue(labels[field])
      if (value === null) continue
      acc.labels[field].push(value)
    }
    // "模仿别的 Bot"是**行为观察**，不是人格独立性分数（人格独立性只有人能评）。
    if (labels.imitatesOtherBot === true) acc.behavior.imitatedOtherBot += 1
  }

  // ── 确定的坏（只有这些进 failures）─────────────────────────────────────
  const flags = []
  if (record.decisionTier === 'invalid' || action === 'invalid') flags.push('invalidOutput')
  if (action === 'reply' && record.targetValid === false) flags.push('targetMiss')
  if (typeof record.veto === 'string' && record.veto !== '') flags.push('codeVeto')
  if (identity !== null && identity.correct < identity.labeled) flags.push('identityMismatch')
  if (candidate && risk === 'high') flags.push('highRiskCandidate')
  for (const flag of flags) acc.failure[flag] += 1
  if (flags.length > 0) acc.failingRuns += 1

  if (isNum(record.latencyMs)) acc.latency.push(record.latencyMs)
  const tokens = record.tokens
  if (tokens !== null && typeof tokens === 'object' && isNum(tokens.promptTokens) && isNum(tokens.completionTokens)) {
    acc.tokens.prompt += tokens.promptTokens
    acc.tokens.completion += tokens.completionTokens
  } else {
    acc.tokens.missing += 1
  }
}

/** 一条计数型指标：值 + 分子分母（分母必须能被人复核，否则这个数没法反驳）。 */
function metricOf(key, label, numerator, denominator) {
  return {
    key,
    label,
    value: denominator > 0 ? ratio(numerator, denominator) : null,
    numerator,
    denominator,
    status: denominator > 0 ? 'ok' : 'no-samples',
  }
}

/** 人工评分指标：**没有标注就 null + needs-human-label**，绝不拿代理值顶替。 */
function humanMetricOf(key, label, values) {
  const value = meanOf(values)
  return {
    key,
    label,
    value,
    numerator: values.length,
    denominator: values.length,
    status: value === null ? 'needs-human-label' : 'ok',
    samples: values.length,
  }
}

/** 把一层累加器收成一份可渲染的分层结果。 */
function summarize(acc) {
  const metrics = {
    participantIdentificationAccuracy: metricOf('participantIdentificationAccuracy', '参与者识别准确率', acc.labeledCorrect, acc.labeled),
    unknownRetentionRate: metricOf('unknownRetentionRate', 'Unknown 保留率', acc.unknownRetained, acc.unknownTotal),
    botRepeatResponseRate: metricOf('botRepeatResponseRate', 'Bot 重复响应率', acc.repeatCandidates, acc.repeatDenominator),
    botLoopRiskDetectionRate: metricOf('botLoopRiskDetectionRate', 'Bot 循环风险识别率', acc.loopFlagged, acc.loopEligible),
    crossBotTargetAccuracy: metricOf('crossBotTargetAccuracy', '跨 Bot 回复对象准确率', acc.crossBotHits, acc.crossBotTargets),
    mixedTopicSwitchAccuracy: metricOf('mixedTopicSwitchAccuracy', '混合话题切换准确率', acc.topicShiftHits, acc.topicShifts),
    botToHumanNaturalness: humanMetricOf('botToHumanNaturalness', 'Bot-to-Human 自然度（人工）', acc.labels.naturalness),
    botToBotDiscussionQuality: humanMetricOf('botToBotDiscussionQuality', 'Bot-to-Bot 讨论质量（人工）', acc.labels.discussionQuality),
    personaIndependence: humanMetricOf('personaIndependence', '人格独立性（人工）', acc.labels.personaIndependence),
    wastedParticipationRate: metricOf('wastedParticipationRate', '无价值参与率', acc.wastedCandidates, acc.wastedDenominator),
  }
  return {
    samples: acc.runs,
    /** §6 的十项指标（每项都带分子分母，null 与 0 可区分）。 */
    metrics,
    /** 还在等人工标注的指标（报告用它一行写清"哪几项缺人"）。 */
    needsHumanLabel: HUMAN_RATED_METRICS.filter((key) => metrics[key].status === 'needs-human-label'),
    /** 行为分布（含 §6 明写"不算失败"的那几类）。 */
    behavior: {
      ...acc.behavior,
      candidates: acc.candidates,
      /** 沉默率只是**分布**，不是评分：§6 明确"对 Bot 沉默"不算失败。 */
      silentRate: ratio(acc.action.silent, acc.runs),
      observeRate: ratio(acc.action.observe, acc.runs),
    },
    actions: { ...acc.action },
    loopRisk: { ...acc.loopRisk },
    /** 确定的坏：坏输出 / 目标未命中 / 代码 veto / 身份标签错 / 高风险仍出候选。 */
    failures: { ...acc.failure, failingRuns: acc.failingRuns },
    latency: { p50: percentile(acc.latency, 50), p95: percentile(acc.latency, 95), samples: acc.latency.length },
    tokens: {
      prompt: acc.tokens.prompt,
      completion: acc.tokens.completion,
      total: acc.tokens.prompt + acc.tokens.completion,
      missingUsage: acc.tokens.missing,
    },
    provenance: {
      models: [...acc.models].sort(),
      personas: [...acc.personas].sort(),
      registries: [...acc.registries].sort(),
      sources: [...acc.sources].sort(),
      runIds: acc.runIds.size,
    },
  }
}

/**
 * 聚合：**总体 + 四个场景分层**，两层同一套判据。
 *
 * `byScene` 一定包含全部四个标签：没有样本的那层 `samples: 0`、指标值全为 `null`，
 * 因为"这一层没样本"本身就是要报告的信息；用缺键表示会让人分不清"没测"和"忘了输出"。
 * 场景标签缺失或写错的记录按 `unknown_participant` 计，并在 `unlabeledScenes` 里点名——
 * 悄悄折进总体会让"混合场景其实没测"看不出来。
 */
export function aggregate(records) {
  const list = Array.isArray(records) ? records.filter((record) => record !== null && typeof record === 'object') : []
  const overall = newAccumulator()
  const byScene = Object.fromEntries(SCENE_LABELS.map((label) => [label, newAccumulator()]))
  const unlabeledScenes = []

  for (const record of list) {
    const declared = record.sceneLabel
    const label = SCENE_LABELS.includes(declared) ? declared : 'unknown_participant'
    if (!SCENE_LABELS.includes(declared)) unlabeledScenes.push(redact(record.runId ?? '?'))
    foldInto(overall, record, label)
    foldInto(byScene[label], record, label)
  }

  return {
    version: METRICS_VERSION,
    /** 记录条数（过滤掉非对象条目之后）。 */
    records: list.length,
    /** 分层标签缺失或写错的记录（按 unknown_participant 计；报告里点名）。 */
    unlabeledScenes,
    overall: summarize(overall),
    byScene: Object.fromEntries(SCENE_LABELS.map((label) => [label, summarize(byScene[label])])),
  }
}
