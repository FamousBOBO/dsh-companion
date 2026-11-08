#!/usr/bin/env node
/**
 * 群聊社交**离线回放**评测（§9.1 / §9.2）。
 *
 *   node eval/group/run.mjs              # 全部用例，打印表格 + 写 last-report.json
 *   node eval/group/run.mjs --json       # 机读输出（stdout 纯 JSON）
 *   node eval/group/run.mjs --case G07   # 只跑一条（可重复）
 *   node eval/group/run.mjs --list       # 列出用例与它压的那道闸
 *
 * **零网络、零模型调用、零真实 QQ。** 每条用例把「人工标注的群聊场景」和「模型本该给出的
 * 那一行决策 JSON」都当**固定输入**，然后跑**线上同一份代码**（解析器 → 校验器 → 限频 →
 * 假平台发送 → 记账），看它把这一行输出收敛成什么。
 *
 * 它验证的是**代码侧判定与执行边界**——动作合法性、目标消息号是否在本轮消息里、目标是否
 * 在时间窗内、限频、长度、@/CQ 码、隐私场景有没有真的漏出去。它**不验证模型判断力**：
 * 模型输出是我们写死的，场景是我们标好的。口径与边界见同目录 README。
 *
 * 退出码：0 = 硬门槛全过；1 = 有硬门槛未达标（隐私越界 / 错误目标或坏输出被放行 /
 * 代码侧结论与标注不符）；2 = 用法或语料错误。
 */

import { writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { CASES, MIN_PER_SCENE, SCENES } from './corpus.mjs'
import {
  ACTIONS,
  DEFAULTS,
  IMPL,
  fakeClock,
  fakeComplete,
  fakePlatform,
  fakePresenceState,
  judgeEntries,
  parseSocialDecision,
  runPresenceCycle,
  sendsMessage,
  validateSocialDecision,
} from './adapter.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPORT_FILE = path.join(HERE, 'last-report.json')

/** 用法/语料错误（退出码 2），区别于"门槛未达标"（退出码 1）。 */
class UsageError extends Error {}

const USAGE = [
  '群聊社交离线回放评测 · eval/group/run.mjs',
  '',
  '用法：',
  '  node eval/group/run.mjs              全部用例（离线、零模型调用）',
  '  node eval/group/run.mjs --json       机读输出（stdout 纯 JSON）',
  '  node eval/group/run.mjs --case G07   只跑一条（可重复）',
  '  node eval/group/run.mjs --list       列出用例与它压的那道闸',
  '',
  '退出码：0 硬门槛全过 · 1 硬门槛未达标 · 2 用法/语料错误。每次运行写 eval/group/last-report.json。',
  '',
].join('\n')

/** 风险分类：报告里按这个分组算拦截率。 */
const BAD_TARGET_RISKS = ['bad-target', 'out-of-window']
const BAD_OUTPUT_RISKS = ['malformed', 'mention', 'length']
const RATE_RISKS = ['rate-limit']

/** 会真的发消息的动作。 */
const SENDING_ACTIONS = ['reply', 'join', 'react']

// ── 语料自检（语料写错要在加载期就炸，而不是在指标里悄悄变成 0） ──────────────

function validateCorpus(cases) {
  const seen = new Set()
  for (const c of cases) {
    if (seen.has(c.id)) throw new UsageError('用例 id 重复：' + c.id)
    seen.add(c.id)
    if (!SCENES.includes(c.scene)) throw new UsageError(c.id + ' 的 scene 不认识：' + String(c.scene))
    if (!ACTIONS.includes(c.expect.action)) {
      throw new UsageError(c.id + ' 的 expect.action 不认识：' + String(c.expect.action) + '（可用 ' + ACTIONS.join('/') + '）')
    }
    if (!['send', 'silent', 'block', 'no-receipt'].includes(c.expect.exec)) {
      throw new UsageError(c.id + ' 的 expect.exec 不认识：' + String(c.expect.exec))
    }
    if (typeof c.modelOutput !== 'string') throw new UsageError(c.id + ' 缺 modelOutput（固定输入）')
    if (!Array.isArray(c.background) || c.background.length === 0) throw new UsageError(c.id + ' 缺 background')
    for (const m of c.background) {
      if (typeof m.messageId !== 'number' || typeof m.atMs !== 'number') {
        throw new UsageError(c.id + ' 的背景消息要有数字 messageId 与 atMs')
      }
    }
    if (c.expect.silence === true && c.scope !== 'model-judgment' && c.expect.exec !== 'silent') {
      throw new UsageError(c.id + ' 标注了 silence:true 但 expect.exec 不是 silent（隐私类不许标"该发"）')
    }
    for (const pattern of c.expect.forbid ?? []) {
      try {
        void new RegExp(pattern)
      } catch (error) {
        throw new UsageError(c.id + ' 的 forbid 正则编译失败：' + pattern + '（' + String(error instanceof Error ? error.message : error) + '）')
      }
    }
  }
  for (const scene of SCENES) {
    const n = cases.filter((c) => c.scene === scene).length
    if (n < MIN_PER_SCENE) {
      throw new UsageError('场景「' + scene + '」只有 ' + String(n) + ' 条，§9.1 要求至少 ' + String(MIN_PER_SCENE) + ' 条')
    }
  }
}

// ── 跑一条用例 ──────────────────────────────────────────────────────────────

/** 用例的"现在"：默认取最后一条背景消息之后 2 秒（不读系统时间，重放稳定）。 */
function nowOf(c) {
  if (typeof c.nowMs === 'number') return c.nowMs
  return Math.max(...c.background.map((m) => m.atMs)) + 2_000
}

/**
 * 跑一条用例：把固定模型输出喂进**真实的**一次社交决策流程。
 *
 * 返回的是"线上这一轮到底发生了什么"：放行并发出去了 / 沉默 / 被代码拦下 / 发出但没有回执。
 */
async function runCase(c) {
  const nowMs = nowOf(c)
  const replyMaxChars = DEFAULTS.replyMaxChars
  const windowMs = DEFAULTS.replyWindowMs
  const settings = {
    judgeIntervalMs: DEFAULTS.judgeIntervalMs,
    judgeMaxEntries: DEFAULTS.judgeMaxEntries,
    judgeMaxChars: DEFAULTS.judgeMaxChars,
    judgeTimeoutMs: DEFAULTS.judgeTimeoutMs,
    judgeMaxTokens: DEFAULTS.judgeMaxTokens,
    speakMinIntervalMs: DEFAULTS.speakMinIntervalMs,
    speakMaxPerHour: DEFAULTS.speakMaxPerHour,
    replyMaxChars,
    replyWindowMs: windowMs,
    memoryBudgetChars: DEFAULTS.memoryBudgetChars,
  }
  const clock = fakeClock(nowMs)
  const { platform, sends } = fakePlatform(c.receipt ?? 'ok')
  const complete = fakeComplete(c.modelOutput)
  const state = fakePresenceState({ nowMs, ...(c.limit ?? {}) })
  const logs = []
  /** 解析结果（流程内部会再走一遍；这里单独跑一次是为了让报告能区分"模型说沉默"与"输出不可用"）。 */
  const parsed = parseSocialDecision(c.modelOutput, decisionContextFor(c, nowMs, replyMaxChars, windowMs))
  const validated = parsed.kind === 'decision' && sendsMessage(parsed.decision.action)
    ? validateSocialDecision(parsed.decision, decisionContextFor(c, nowMs, replyMaxChars, windowMs))
    : null

  const outcome = await runPresenceCycle(
    {
      groupId: 1000000003,
      settings,
      state,
      background: judgeEntries(c.background),
      sentLines: c.botRecent ?? [],
      nowLabel: '21:58',
      persona: null,
    },
    {
      clock,
      log: (line) => { logs.push(line) },
      platform: () => platform,
      complete,
      recordSent: async () => {},
    },
  )

  const lastSend = sends.length > 0 ? sends[sends.length - 1] : null
  return {
    outcome,
    parsed,
    validated,
    exec: execOf(outcome),
    sends: sends.length,
    text: lastSend === null ? '' : textOfMessage(lastSend.message),
    target: outcome.kind === 'spoke' && outcome.action === 'reply' ? outcome.targetMessageId : null,
    sentQuote: lastSend === null ? null : quotedIdOf(lastSend.message),
    modelCalls: complete.calls.length,
    logs,
  }
}

function decisionContextFor(c, nowMs, replyMaxChars, windowMs) {
  return {
    messages: c.background.map((entry) => ({ messageId: entry.messageId, atMs: entry.atMs })),
    replyMaxChars,
    nowMs,
    windowMs,
  }
}

/** 结论四分类（报告列与指标都按这个）。 */
function execOf(outcome) {
  if (outcome.kind === 'spoke') return 'send'
  if (outcome.kind === 'silent') return 'silent'
  if (outcome.kind === 'failed' && /回执/.test(outcome.detail)) return 'no-receipt'
  return 'block'
}

/** 从发出去的消息段里取正文（真实流程发的是 OneBot 消息段）。 */
function textOfMessage(message) {
  if (!Array.isArray(message)) return ''
  return message
    .filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment.data?.text ?? ''))
    .join('')
    .trim()
}

/** 引用段里的目标号（线上真正塞进 `{type:'reply'}` 的那个 id）。 */
function quotedIdOf(message) {
  if (!Array.isArray(message)) return null
  const segment = message.find((item) => item?.type === 'reply')
  if (segment === undefined) return null
  const raw = String(segment.data?.id ?? '')
  return /^\d+$/.test(raw) ? Number(raw) : null
}

// ── 判定 ────────────────────────────────────────────────────────────────────

/**
 * 这条用例"代码侧"的结论。
 *
 * 三件事分开记（Lead 的口径）：
 *   1. `silent`（模型正常说"不说话"）——**正确沉默**，不是失败；
 *   2. `invalid`（坏 JSON/数组/未知动作/空正文/超长/@/CQ 码）——**坏输出**，要被拦；
 *   3. `validated-by-code`（目标不存在/超窗）——决策形状对、被执行器拦下。
 * 混在一起会让"模型很懂礼貌地沉默"看起来像"模型一直输出坏东西"。
 */
function judgeCase(c, run) {
  const notes = []
  const vetoMiss = c.expect.veto === undefined ? false : !(vetoReasonOf(run) ?? '').includes(c.expect.veto)
  const conform = run.exec === c.expect.exec && !vetoMiss
  if (run.exec !== c.expect.exec) notes.push('期望 ' + c.expect.exec + '，实际 ' + run.exec + '（' + shortReason(run) + '）')
  if (vetoMiss) notes.push('被拦下了，但理由不是 ' + c.expect.veto + '（实际：' + (vetoReasonOf(run) ?? '无') + '）——那道闸没被压到')
  const forbidHits = run.sends > 0
    ? (c.expect.forbid ?? []).filter((pattern) => new RegExp(pattern).test(run.text))
    : []
  const idealAgrees = c.expect.action === 'silent'
    ? run.sends === 0
    : (c.expect.action === 'observe' ? run.sends === 0 : actionAgrees(c, run))
  const judged = c.scope === 'model-judgment'
  let status
  if (!conform) status = judged ? 'WARN' : 'FAIL'
  else if (judged && !idealAgrees) status = 'WARN'
  else if (forbidHits.length > 0) status = 'WARN'
  else status = 'PASS'
  return { status, conform, idealAgrees, forbidHits, notes }
}

/** 动作对不对得上：reply 还要看是不是回对了那条（引用段里的号）。 */
function actionAgrees(c, run) {
  const actual = run.outcome.kind === 'spoke' ? run.outcome.action : 'silent'
  if (actual !== c.expect.action) return false
  const want = c.expect.targetMessageId
  if (want === null || want === undefined) return true
  return run.target === want && run.sentQuote === want
}

/**
 * 限频类用例还要对"被哪一条挡下的"：被**别的**闸门挡住是另一回事（例如目标号写错先被
 * 拦下），只有理由对得上才算真的压到了那道闸。语料用 `expect.veto` 标注。
 */
function vetoReasonOf(run) {
  if (run.outcome.kind === 'silent') return run.outcome.reason
  if (run.outcome.kind === 'failed') return run.outcome.detail
  return null
}

function shortReason(run) {
  if (run.outcome.kind === 'silent') return run.outcome.reason
  if (run.outcome.kind === 'failed') return run.outcome.detail
  return '放行 ' + run.outcome.action + '「' + run.text + '」'
}

// ── 指标 ────────────────────────────────────────────────────────────────────

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(3))
}

/**
 * 六个指标（口径写在 README 的表格里，改这里必须同步改 README）。
 *
 * | 指标 | 分子 | 分母 |
 * |---|---|---|
 * | 插话准确率 | 发出去的用例里，人工标注也认为该发的 | 实际发出去的用例数 |
 * | 机会参与率 | 标注认为有参与机会、且真的发出去了 | 标注认为有参与机会的用例数 |
 * | 目标选择准确率 | 引用段里的号 == 标注目标号 | 标注了目标号且真的发出去的用例数 |
 * | 错误目标拒绝率 | 编造/超窗目标被拦下 | 这类用例总数 |
 * | 坏输出拦截率 | 一条都没发出去 | 坏输出类用例总数 |
 * | 沉默正确率（隐私/争执） | 一条都没发出去 | 隐私/争执类用例总数 |
 */
function metricsOf(rows) {
  const sent = rows.filter((row) => row.run.sends > 0)
  const intended = rows.filter((row) => SENDING_ACTIONS.includes(row.c.expect.action))
  const silentCases = rows.filter((row) => row.c.expect.silence === true)
  // 目标选择只看 reply：只有 reply 会真的发出引用段（join/react 按设计就是纯文本，
  // 把它们的 targetMessageId 算进来等于要求一个线上不存在的可见标记）。
  const targeted = sent.filter((row) => row.c.expect.action === 'reply' && typeof row.c.expect.targetMessageId === 'number')
  // 隐私/争执指标只统计**代码侧能保证**的用例；model-judgment 的那条单列在 gaps，
  // 混进分母会把"提示词没兜住"记成"代码漏了"，把代码那 7 条 100% 稀释掉。
  const codeSilenceCases = silentCases.filter((row) => row.c.scope !== 'model-judgment')
  const modelJudgmentSilence = silentCases.filter((row) => row.c.scope === 'model-judgment')
  // 只有"模型输出本身可执行"的机会才算真的机会：故意写坏的那批目的是压拦截率。
  const usableOpportunity = intended.filter((row) => row.run.parsed.kind === 'decision'
    && (row.run.validated === null || row.run.validated.ok === true))
  const badTarget = rows.filter((row) => BAD_TARGET_RISKS.includes(row.c.risk))
  const badOutput = rows.filter((row) => BAD_OUTPUT_RISKS.includes(row.c.risk))
  const rate = rows.filter((row) => RATE_RISKS.includes(row.c.risk))
  const parseKinds = { decision: 0, silent: 0, invalid: 0 }
  for (const row of rows) parseKinds[row.run.parsed.kind] += 1
  const blockedByCode = rows.filter((row) => row.run.validated !== null && row.run.validated.ok === false)
  return {
    interjectionPrecision: ratio(sent.filter((row) => SENDING_ACTIONS.includes(row.c.expect.action)).length, sent.length),
    opportunityParticipation: ratio(sent.filter((row) => SENDING_ACTIONS.includes(row.c.expect.action)).length, intended.length),
    opportunityParticipationUsable: ratio(usableOpportunity.filter((row) => row.run.sends > 0).length, usableOpportunity.length),
    targetSelection: ratio(targeted.filter((row) => row.run.sentQuote === row.c.expect.targetMessageId).length, targeted.length),
    badTargetRejection: ratio(badTarget.filter((row) => row.run.sends === 0).length, badTarget.length),
    badOutputInterception: ratio(badOutput.filter((row) => row.run.sends === 0).length, badOutput.length),
    silenceRate: ratio(codeSilenceCases.filter((row) => row.run.sends === 0).length, codeSilenceCases.length),
    silenceRateAll: ratio(silentCases.filter((row) => row.run.sends === 0).length, silentCases.length),
    supporting: {
      boundaryConformance: ratio(rows.filter((row) => row.judged.conform).length, rows.length),
      rateLimitEnforcement: ratio(rate.filter((row) => row.run.sends === 0).length, rate.length),
    },
    parseKinds,
    counts: {
      cases: rows.length,
      sent: sent.length,
      silent: rows.filter((row) => row.run.exec === 'silent').length,
      blocked: rows.filter((row) => row.run.exec === 'block').length,
      noReceipt: rows.filter((row) => row.run.exec === 'no-receipt').length,
      modelCalls: rows.reduce((sum, row) => sum + row.run.modelCalls, 0),
      blockedByCode: blockedByCode.length,
    },
    sampled: {
      silentByModel: parseKinds.silent,
      invalidOutput: parseKinds.invalid,
      codeSilenceCases: codeSilenceCases.length,
      modelJudgmentSilenceCases: modelJudgmentSilence.length,
      intendedOpportunities: intended.length,
      usableOpportunities: usableOpportunity.length,
    },
  }
}

/**
 * 硬门槛：只在**代码侧能保证**的事情上失败。
 *
 * 1. 隐私/争执类（标注 `silence: true`）里代码放行了一条 —— 真实越界；
 * 2. 编造的目标号 / 超窗目标被放行 —— 会发错对象；
 * 3. 坏输出被放行（坏 JSON / 数组 / 超长 / @ / CQ 码）—— 会发出半句话或错对象；
 * 4. 限频失效（额度/冷却用尽还发）—— 会变成刷屏；
 * 5. 代码侧结论与人工标注的 `expect.exec` 不符（含"该发的没发"与"不该发的发了"）。
 *
 * 模型判断缺口（`scope: 'model-judgment'`）**不进硬门槛**：代码侧根本不判语义，
 * 把它算成代码缺陷会掩盖真实分工；把它从报告里删掉才是粉饰。它们单列在 `gaps`。
 */
function gatesOf(rows) {
  const privacyLeak = rows.filter((row) => row.c.expect.silence === true && row.c.scope !== 'model-judgment' && row.run.sends > 0)
  const badTargetReleased = rows.filter((row) => BAD_TARGET_RISKS.includes(row.c.risk) && row.run.sends > 0)
  const badOutputReleased = rows.filter((row) => BAD_OUTPUT_RISKS.includes(row.c.risk) && row.run.sends > 0)
  const rateLimitFail = rows.filter((row) => RATE_RISKS.includes(row.c.risk) && row.run.sends > 0)
  const conformFail = rows.filter((row) => !row.judged.conform && row.c.scope !== 'model-judgment')
  return [
    { id: 'privacy-silence', name: '隐私/争执类 100% 沉默', ok: privacyLeak.length === 0, detail: describeRows(privacyLeak) },
    { id: 'bad-target-rejected', name: '编造目标 / 超窗目标被拦下', ok: badTargetReleased.length === 0, detail: describeRows(badTargetReleased) },
    { id: 'bad-output-rejected', name: '坏输出（坏 JSON / 数组 / 超长 / @ / CQ）被拦下', ok: badOutputReleased.length === 0, detail: describeRows(badOutputReleased) },
    { id: 'rate-limit-enforced', name: '额度 / 冷却用尽时说不出话', ok: rateLimitFail.length === 0, detail: describeRows(rateLimitFail) },
    { id: 'code-boundary-conformance', name: '代码侧结论与人工标注一致', ok: conformFail.length === 0, detail: conformFail.length === 0 ? '全部一致' : conformFail.map((row) => row.c.id + '：期望 ' + row.c.expect.exec + '，实际 ' + row.run.exec).join('；') },
  ]
}

function describeRows(rows) {
  if (rows.length === 0) return '无'
  return rows.map((row) => row.c.id + ' 发出「' + row.run.text + '」').join('；')
}
// ── 报告渲染（与 eval/lib/report.mjs 同一套形状：suites.items[].status/detail） ──

function pad(text, width) {
  const actual = [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return text + ' '.repeat(Math.max(0, width - actual))
}

function summarize(items) {
  return {
    pass: items.filter((item) => item.status === 'PASS').length,
    fail: items.filter((item) => item.status === 'FAIL').length,
    warn: items.filter((item) => item.status === 'WARN').length,
    skip: 0,
    total: items.length,
  }
}

/** 指标顺序与中文名（终端表格与 README 表格用同一套）。 */
const METRICS = [
  ['interjectionPrecision', '插话准确率', true],
  ['opportunityParticipation', '机会参与率', false],
  ['targetSelection', '目标选择准确率', true],
  ['badTargetRejection', '错误目标拒绝率', true],
  ['badOutputInterception', '坏输出拦截率', true],
  ['silenceRate', '沉默正确率（隐私/争执）', true],
]

/** 指标门槛。只有**代码侧能保证**的那几项给 100% 的硬目标；参与率是行为指标，不给硬目标。 */
const METRIC_TARGETS = {
  badTargetRejection: 1,
  badOutputInterception: 1,
  silenceRate: 1,
}

/** 每个指标的分母（打印在括号里：数字不写清分母就是可以被误读的数字）。 */
const DENOMINATORS = {
  interjectionPrecision: (m) => '实际发出去 ' + String(m.counts.sent) + ' 条',
  opportunityParticipation: (m) => '标注有参与机会 ' + String(m.sampled.intendedOpportunities) + ' 条，其中模型输出可执行 ' + String(m.sampled.usableOpportunities) + ' 条（可执行口径下 ' + percent(m.opportunityParticipationUsable) + '）',
  targetSelection: (m) => '该 reply 且真的发出去的用例',
  badTargetRejection: (m) => '编造目标 / 超窗目标用例',
  badOutputInterception: (m) => '坏 JSON / 数组 / 超长 / @ / CQ 用例',
  silenceRate: (m) => '代码侧可保证的隐私/争执用例 ' + String(m.sampled.codeSilenceCases) + ' 条（含 model-judgment 的口径下 ' + percent(m.silenceRateAll) + '）',
}

function percent(value) {
  return value === null ? '—（本次无此类用例）' : (value * 100).toFixed(1) + '%'
}

function renderHuman(report) {
  const lines = []
  lines.push('群聊社交离线回放评测 · 实现 ' + report.impl.source + ' · ' + report.generatedAt)
  lines.push('口径：模型输出是语料里写死的固定输入；这里测的是**代码侧判定与执行边界**，不是模型判断力。')
  for (const [scene, suite] of Object.entries(report.suites)) {
    const s = suite.summary
    lines.push('')
    lines.push('[' + scene + '] 通过 ' + s.pass + ' · 失败 ' + s.fail + ' · 待看 ' + s.warn + '（共 ' + s.total + '）')
    for (const item of suite.items) {
      lines.push('  ' + pad(item.status, 6) + pad(item.id, 6) + item.detail)
      for (const note of item.notes ?? []) lines.push('        ↳ ' + note)
    }
  }
  lines.push('')
  lines.push('指标（分子/分母的准确口径见 eval/group/README.md 的表格）')
  for (const [key, label, targeted] of METRICS) {
    const target = METRIC_TARGETS[key]
    const mark = target === undefined ? '' : (report.metrics[key] !== null && report.metrics[key] >= target ? '  ✓ 达标' : '  ✗ 未达门槛 ' + (target * 100).toFixed(0) + '%')
    const denom = DENOMINATORS[key] === undefined ? '' : '   （' + String(DENOMINATORS[key](report.metrics)) + '）'
    lines.push('  ' + pad(label, 26) + pad(percent(report.metrics[key]), 22) + mark + denom)
  }
  const sup = report.metrics.supporting
  lines.push('  ' + pad('（参考）限频拦截率', 26) + pad(percent(sup.rateLimitEnforcement), 22))
  lines.push('  ' + pad('（参考）结论一致率', 26) + pad(percent(sup.boundaryConformance), 22))
  const c = report.metrics.counts
  lines.push('')
  lines.push('计数：用例 ' + c.cases + ' · 发出去 ' + c.sent + ' · 沉默 ' + c.silent + ' · 被代码拦下 ' + c.blocked
    + ' · 无回执 ' + c.noReceipt + ' · 假补全端口调用 ' + c.modelCalls + ' 次（真实模型调用 0 次、真实网络请求 0 次）')
  lines.push('解析分档：decision ' + report.metrics.parseKinds.decision + ' · silent（模型说沉默）' + report.metrics.parseKinds.silent
    + ' · invalid（输出不可用）' + report.metrics.parseKinds.invalid)
  lines.push('')
  lines.push('硬门槛')
  for (const gate of report.gates) {
    lines.push('  ' + (gate.ok ? 'PASS' : 'FAIL') + '  ' + gate.name + ' — ' + gate.detail)
  }
  if (report.gaps.length > 0) {
    lines.push('')
    lines.push('已知缺口（代码侧不判语义，靠提示词兜；不计入硬门槛，也不许当成已验证）')
    for (const gap of report.gaps) lines.push('  ' + gap.id + '：' + gap.detail)
  }
  const t = report.totals
  lines.push('')
  lines.push('汇总：PASS ' + t.pass + ' · FAIL ' + t.fail + ' · WARN ' + t.warn + '（共 ' + t.total + '）'
    + (t.fail > 0 ? '（有 FAIL，退出码 1）' : ''))
  lines.push('报告：' + report.reportFile)
  return lines.join('\n')
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function parseCli() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      json: { type: 'boolean', default: false },
      case: { type: 'string', multiple: true },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  return values
}

async function main() {
  let values
  try {
    values = parseCli()
  } catch (error) {
    console.error('group-eval: ' + String(error instanceof Error ? error.message : error))
    console.error(USAGE)
    return 2
  }
  if (values.help === true) {
    console.log(USAGE)
    return 0
  }
  try {
    validateCorpus(CASES)
    if (values.list === true) {
      for (const c of CASES) console.log(c.id + '  ' + pad(c.scene, 18) + pad(c.risk, 14) + c.name)
      return 0
    }
    const wanted = values.case === undefined || values.case.length === 0
      ? CASES
      : CASES.filter((c) => values.case.includes(c.id))
    if (wanted.length === 0) throw new UsageError('--case 没匹配到任何用例：' + values.case.join(','))

    const rows = []
    for (const c of wanted) {
      const run = await runCase(c)
      rows.push({ c, run, judged: judgeCase(c, run) })
    }

    const suites = {}
    for (const scene of SCENES) {
      const sceneRows = rows.filter((row) => row.c.scene === scene)
      if (sceneRows.length === 0) continue
      const items = sceneRows.map((row) => ({
        id: row.c.id,
        name: row.c.name,
        status: row.judged.status,
        detail: '期望 ' + row.c.expect.exec + ' · 实际 ' + row.run.exec
          + (row.run.sends > 0 ? '「' + row.run.text + '」' : '')
          + ' · ' + row.c.risk + ' · ' + row.c.scope,
        notes: row.judged.notes,
        expect: { exec: row.c.expect.exec, action: row.c.expect.action, direction: row.c.expect.direction },
        observed: {
          exec: row.run.exec,
          action: row.run.outcome.kind === 'spoke' ? row.run.outcome.action : null,
          text: row.run.text,
          quotedTarget: row.run.sentQuote,
          parseKind: row.run.parsed.kind,
          validate: row.run.validated,
          reason: shortReason(row.run),
        },
      }))
      suites[scene] = { items, summary: summarize(items) }
    }
    const totals = summarize(Object.values(suites).flatMap((suite) => suite.items))
    const metrics = metricsOf(rows)
    const gates = gatesOf(rows)
    const gaps = rows
      .filter((row) => row.c.scope === 'model-judgment')
      .map((row) => ({
        id: row.c.id,
        scene: row.c.scene,
        sent: row.run.sends > 0,
        detail: row.c.scene + '：'
          + (row.run.sends > 0
            ? '代码放行了「' + row.run.text + '」，而计划口径要求 ' + (row.c.expect.action === 'silent' ? '沉默' : row.c.expect.action)
            : '这一轮没发（模型自己选了沉默），但代码拦不住同样内容的输出')
          + '（' + row.c.expect.direction + '）',
      }))

    const report = {
      version: 1,
      mode: 'offline-replay',
      generatedAt: new Date().toISOString(),
      impl: { ...IMPL },
      defaults: { ...DEFAULTS },
      suites,
      totals,
      metrics,
      gates,
      gaps,
      notes: [
        '**这不是模型判断力的评测**：语料里的模型输出是人工写死的固定输入，场景与期望也是人工标注。',
        '它验证的是代码侧判定与执行边界：动作合法性、目标消息号是否在本轮消息里、引用时间窗、限频、长度、@/CQ 码、隐私沉默。',
        '证据级别：offline-test（docs/07 的五级口径）。不构成 real-api / real-send 的任何证据，也不证明"线上她说话得体"。',
        'model-judgment 用例的偏差记 WARN 并单列在 gaps：代码侧不判语义，靠提示词兜，不许当已验证。',
        '零网络、零模型调用、零真实 QQ：complete 是假端口，platform 是假端口，clock 是冻结的假时钟。',
      ],
    }
    report.reportFile = path.relative(process.cwd(), REPORT_FILE) || 'eval/group/last-report.json'
    await writeFile(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8')

    if (values.json === true) console.log(JSON.stringify(report, null, 2))
    else console.log(renderHuman(report))

    const gateFailed = gates.some((gate) => !gate.ok)
    return gateFailed || totals.fail > 0 ? 1 : 0
  } catch (error) {
    console.error('group-eval: ' + String(error instanceof Error ? error.message : error))
    return 2
  }
}

process.exitCode = await main()
