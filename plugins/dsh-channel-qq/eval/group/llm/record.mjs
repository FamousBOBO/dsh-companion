/**
 * **逐条记录与聚合**（计划 §2.3 的"每条样本保存：匿名场景 ID、输入 hash、persona 版本、
 * 模型与推理档位、输出 JSON、目标 ID 是否命中、代码 veto、耗时、token、估算成本、异常码"）。
 *
 * 两条纪律：
 *   1. **只记录，不判定**。`tier` / `veto` / `targetValid` 全部来自生产导出
 *      （`parseSocialDecision` / `validateSocialDecision` / `sendsMessage`）的返回值，
 *      这个文件里没有任何"我觉得这句该不该发"的判断。判"该不该"的是人，方法在 README。
 *   2. **不写真实群号 / QQ 号**。群号用固定假号（`port.mjs` 的 `FAKE_GROUP_ID`），
 *      模型输出与理由在落盘前统一脱敏（任何 9 位以上的数字串都换成 `<长数字号>`）：
 *      模型会复述背景里的号，而真实部署里那些号就是群成员/群号。
 */

import { createHash } from 'node:crypto'

/** 一条记录的版本号：字段形状改了要加一，读报告的人据此判断"这条是不是老格式"。 */
export const RECORD_VERSION = 1

/** 输入 hash：生产提示词 + 判断设置 + 模型标识。提示词一变（人格/消息/记忆/长度上限）它就变。 */
export function inputHashOf({ prompt, settings, model }) {
  const hash = createHash('sha256')
  hash.update(String(prompt ?? ''))
  hash.update('\u0000')
  hash.update(JSON.stringify(settings ?? {}))
  hash.update('\u0000')
  hash.update(String(model ?? ''))
  return hash.digest('hex').slice(0, 16)
}

/**
 * 长数字串（**≥6 位**）脱敏。
 *
 * 口径：QQ 号 5–11 位、群号 6–12 位、19 位是加密群的形状。**≥5 位**一律抹掉：宁可多抹，
 * 也不要在某次真实语料重放里把群号/成员号写进 JSONL——这份文件会被贴进工单与聊天窗口。
 * 语料里的假消息号是 3–4 位（`504`、`1322`），保留它们才能对着语料读报告；
 * 语料里的假成员号（`10015` 这类 5 位）会被一起抹掉，那是刻意的：报告不需要复述任何人的号。
 */
export function redact(text) {
  return String(text ?? '').replace(/\d{5,}/g, '<长数字号>')
}

/**
 * 判"模型输出落在哪一档"——用的全是生产导出，一行判定都没有。
 *
 * @param {object} args
 * @param {string} args.raw 模型原始输出
 * @param {object} args.ctx `DecisionContext`（messages / replyMaxChars / nowMs / windowMs）
 * @param {object} args.decisionModule `parseSocialDecision` / `validateSocialDecision` / `sendsMessage`
 */
export function tierOf({ raw, ctx, decisionModule }) {
  const parsed = decisionModule.parseSocialDecision(raw, ctx)
  if (parsed.kind === 'silent') return { tier: 'silent', reason: parsed.reason }
  if (parsed.kind === 'invalid') return { tier: 'invalid', reason: parsed.reason }
  const decision = parsed.decision
  if (!decisionModule.sendsMessage(decision.action)) {
    return { tier: 'decision', action: decision.action, reason: decision.reason, wouldSend: false, veto: null }
  }
  const checked = decisionModule.validateSocialDecision(decision, ctx)
  return {
    tier: 'decision',
    action: decision.action,
    reason: decision.reason,
    wouldSend: true,
    text: decision.text,
    targetMessageId: decision.action === 'reply' ? decision.targetMessageId : undefined,
    veto: checked.ok ? null : checked.reason,
  }
}

/** 流程结局 → 一个能进报表的粗分类（**不是**判定：判定在上面 `tierOf`）。 */
export function executionOf(outcome) {
  const detail = String(outcome.detail ?? outcome.reason ?? '')
  if (outcome.kind === 'spoke') return { exec: 'spoke', failureKind: null, label: '真的发出去了（不应该发生）' }
  if (outcome.kind === 'shadow') return { exec: 'shadow', failureKind: null, label: '被模式闸门拦下（影子）' }
  if (outcome.kind === 'silent') {
    if (/这一轮不开口/.test(detail)) return { exec: 'silent', failureKind: 'rate-limited', label: '限频/冷却拦下（没发）' }
    if (/判断为观察/.test(detail)) return { exec: 'silent', failureKind: null, label: '模型选 observe' }
    return { exec: 'silent', failureKind: null, label: '模型选沉默' }
  }
  if (/判断调用不可用/.test(detail)) return { exec: 'failed', failureKind: 'transport', label: '模型调用不可用' }
  if (/判断输出不可用/.test(detail)) return { exec: 'failed', failureKind: 'invalid-output', label: '模型输出不可用（坏 JSON/缺字段）' }
  if (/决策被代码拦下/.test(detail)) return { exec: 'failed', failureKind: 'code-veto', label: '代码 veto' }
  return { exec: 'failed', failureKind: 'send-path', label: '发送路径（绊线/回执/平台）' }
}

/** 一条用例 × 一次重复 → 一行 JSONL。 */
export function caseRecord({
  caseId,
  scene,
  scope,
  repeatIndex,
  repeatCount,
  inputHash,
  persona,
  config,
  promptChars,
  tier,
  execution,
  outcome,
  modelRequest,
  cost,
  annotated,
  nowMs,
}) {
  const usage = modelRequest?.usage ?? { promptTokens: null, completionTokens: null, totalTokens: null }
  return {
    version: RECORD_VERSION,
    /** 匿名场景 ID（语料里的 G01–G52；语料本身不含真实群号）。 */
    sceneId: caseId,
    scene,
    /** 语料标注的类别：决定"偏差算 FAIL 还是 WARN"的只有离线通道，这里只用来对照。 */
    corpusScope: scope,
    repeatIndex,
    repeatCount,
    /** 输入 hash：提示词 + 设置 + 模型的短哈希（同一条重跑应当一致）。 */
    inputHash,
    promptChars,
    persona: { version: persona.version, source: persona.source, available: persona.available },
    model: { name: config.model, temperature: config.temperature, maxTokens: modelRequest?.maxTokens ?? null, effort: modelRequest?.preferredEffort ?? null },
    /** 模型原始输出（脱敏后）。**是原文**，不是我们改写过的版本。 */
    rawOutput: redact(modelRequest?.text ?? ''),
    /** 解析档：decision / silent / invalid（来自生产 `parseSocialDecision`）。 */
    tier: tier.tier,
    tierReason: tier.reason === undefined || tier.reason === null ? null : redact(tier.reason),
    action: tier.action ?? null,
    /** 代码 veto 理由（来自生产 `validateSocialDecision`；null = 没被拦）。 */
    veto: tier.veto === null || tier.veto === undefined ? null : redact(tier.veto),
    /** 目标是否命中：模型给的号在不在本轮消息里、在不在时间窗内（生产校验的结论）。 */
    target: {
      messageId: tier.targetMessageId ?? null,
      valid: tier.veto === null || !String(tier.veto).startsWith('target-'),
      hitAnnotated: annotated?.targetMessageId === undefined || annotated?.targetMessageId === null
        ? null
        : tier.targetMessageId === annotated.targetMessageId,
    },
    /** 生产流程自己的结局（它记账、限频、走的哪条出口）。 */
    execution: execution.exec,
    executionKind: execution.failureKind,
    executionLabel: execution.label,
    outcomeReason: redact(String(outcome.detail ?? outcome.reason ?? '')),
    /** 耗时、token、成本（成本只在用户给了单价时才有数）。 */
    latencyMs: modelRequest?.latencyMs ?? null,
    tokens: { ...usage },
    cost,
    /** 异常码：'network' / 'timeout' / 'http-error' / 'bad-json' / 'empty-content' / null。 */
    errorCode: modelRequest?.errorCode ?? null,
    httpStatus: modelRequest?.httpStatus ?? null,
    nowMs,
  }
}

/** 数值分位（p50/p95）；空集给 null（不拿 0 冒充"没有延迟"）。 */
export function percentile(values, p) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (list.length === 0) return null
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1))
  return list[index]
}

/** 一条用例在 N 次重复里的稳定度（非确定性只能"报告"，不能"消除"）。 */
export function stabilityOf(records) {
  const signatures = records.map((record) => `${record.tier}|${record.action ?? '-'}|${record.execution}|${record.target.messageId ?? '-'}`)
  const unique = [...new Set(signatures)]
  return {
    runs: records.length,
    unique,
    stable: unique.length === 1,
    /** 具体哪几次不一样（诊断用：同一条重跑出现两档，说明这题的答案在模型的边界上）。 */
    variations: records.map((record, index) => ({
      run: index + 1,
      tier: record.tier,
      action: record.action ?? null,
      execution: record.execution,
      target: record.target.messageId,
      rawOutput: record.rawOutput,
      latencyMs: record.latencyMs,
    })),
  }
}

/**
 * 聚合指标。**刻意不产出"准确率"**：一句"插话准确率 73%"在真实模型通道里没有定义——
 * 标注只有一份（离线语料的人工标注），把它当金标准会把"标注的偏好"说成"模型的对错"。
 * 这里给的是可复核的计数与分布；"对错"要人来评（README 里的盲评流程）。
 */
export function aggregate(records, { tripwireTrips, config, prices }) {
  const runs = records.length
  const byTier = { decision: 0, silent: 0, invalid: 0 }
  const byExec = { spoke: 0, shadow: 0, silent: 0, failed: 0 }
  const byFailure = {}
  const byError = {}
  let promptTokens = 0
  let completionTokens = 0
  let usageMissing = 0
  let costTotal = 0
  let costMissing = 0
  const latencies = []
  let wouldSend = 0
  let vetoed = 0
  let targetChecked = 0
  let targetValid = 0
  let annotatedTargets = 0
  let annotatedTargetHits = 0
  for (const record of records) {
    byTier[record.tier] = (byTier[record.tier] ?? 0) + 1
    byExec[record.execution] = (byExec[record.execution] ?? 0) + 1
    if (record.executionKind !== null) byFailure[record.executionKind] = (byFailure[record.executionKind] ?? 0) + 1
    if (record.errorCode !== null) byError[record.errorCode] = (byError[record.errorCode] ?? 0) + 1
    if (record.tokens.promptTokens === null && record.errorCode === null) usageMissing += 1
    promptTokens += record.tokens.promptTokens ?? 0
    completionTokens += record.tokens.completionTokens ?? 0
    if (record.cost?.total !== null && record.cost?.total !== undefined) costTotal += record.cost.total
    else costMissing += 1
    if (typeof record.latencyMs === 'number') latencies.push(record.latencyMs)
    if (record.tier === 'decision' && record.veto === null && record.action !== null && record.action !== 'silent' && record.action !== 'observe') wouldSend += 1
    if (record.tier === 'decision' && record.veto !== null) vetoed += 1
    if (record.target.messageId !== null) {
      targetChecked += 1
      if (record.target.valid) targetValid += 1
    }
    if (record.target.hitAnnotated !== null && record.target.hitAnnotated !== undefined) {
      annotatedTargets += 1
      if (record.target.hitAnnotated) annotatedTargetHits += 1
    }
  }
  const ratio = (numerator, denominator) => (denominator === 0 ? null : Number((numerator / denominator).toFixed(4)))
  return {
    runs,
    cases: new Set(records.map((record) => record.sceneId)).size,
    tripwireTrips,
    /** 有效输出率：拿到可解析决策（含"正常沉默"）的比例。坏 JSON 不算模型"选择沉默"。 */
    validOutputRate: ratio(byTier.decision + byTier.silent, runs),
    byTier,
    byExec,
    byFailureKind: byFailure,
    byErrorCode: byError,
    /** "如果按 live 发出去会有几条" —— 这是**观察**，不是准确率。 */
    wouldSend,
    codeVetoed: vetoed,
    targets: { checked: targetChecked, valid: targetValid, annotated: annotatedTargets, annotatedHits: annotatedTargetHits },
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length === 0 ? null : Math.max(...latencies),
      samples: latencies.length,
    },
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens,
      /** 有几条响应没带 usage（端点不给就明说，不拿 0 顶替）。 */
      missingUsage: usageMissing,
    },
    cost: {
      /** 只有两侧单价都配了才有总价；否则 null + missing 说明缺哪一侧。 */
      total: prices && (prices.inputPerMTok !== null || prices.outputPerMTok !== null) && costMissing === 0 ? costTotal : null,
      runsWithoutPrice: costMissing,
      priceInputPerMTok: prices?.inputPerMTok ?? null,
      priceOutputPerMTok: prices?.outputPerMTok ?? null,
    },
    model: { name: config.model, temperature: config.temperature, repeat: config.repeat },
  }
}