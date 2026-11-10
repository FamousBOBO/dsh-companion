/**
 * 混合生态评测层（eval/group/mirror/metrics.mjs + report.mjs）的单测。
 *
 * 这里的断言几乎全在**反例**一侧，因为这一层的失败方式不是崩溃，而是"给出一个看起来很专业的错数"：
 *   - 0/0 被写成 0%，读者会以为"这一层全错"，其实什么都没跑；
 *   - 人工评分缺失时拿代理值顶上，读者会以为"做过盲评了"；
 *   - 把"对 Bot 沉默"记进失败，等于把 §6 明写的正确行为记成缺陷。
 * 所以下面的用例多数在检查"**没有**出现某个数"，而不是"出现了某个数"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregate,
  directionOf,
  normalizeHumanLabels,
  redact,
  METRICS_VERSION,
  METRIC_DEFS,
  HUMAN_RATED_METRICS,
  SCENE_LABELS,
  SCENE_TITLES,
} from '../eval/group/mirror/metrics.mjs'
import { renderReport, REPORT_VERSION, EVIDENCE_LEVELS } from '../eval/group/mirror/report.mjs'

/** 一条最简记录：只给必需字段，其余留空（本层遇到缺字段一律当"没有这个数"）。 */
function rec(overrides = {}) {
  return {
    runId: 'R1',
    sceneLabel: 'bot_to_bot',
    participantRegistryVersion: 'reg-v1',
    botParticipants: [],
    humanParticipants: [],
    unknownParticipants: [],
    action: 'silent',
    decisionTier: 'decision',
    targetValid: null,
    veto: null,
    candidateText: undefined,
    personaVersion: 'p1',
    modelName: 'm1',
    latencyMs: 100,
    tokens: { promptTokens: 10, completionTokens: 5 },
    source: 'napcat-mirror',
    ...overrides,
  }
}

/** 一条"确实产生了候选发言"的记录。 */
function spoke(overrides = {}) {
  return rec({ action: 'reply', candidateText: '这句是候选发言', targetValid: true, ...overrides })
}

/** 四个场景各 2 条 → 8 条。 */
function fourScenesTwoEach() {
  const out = []
  for (const label of SCENE_LABELS) {
    out.push(rec({ sceneLabel: label, runId: label + '-1', action: 'silent' }))
    out.push(rec({ sceneLabel: label, runId: label + '-2', action: 'observe' }))
  }
  return out
}

// ── 分层 ──────────────────────────────────────────────────────────────────

test('四场景各 2 条：总体 8 条，每层各 2 条', () => {
  const result = aggregate(fourScenesTwoEach())
  assert.equal(result.records, 8)
  assert.equal(result.overall.samples, 8)
  for (const label of SCENE_LABELS) {
    assert.equal(result.byScene[label].samples, 2, label + ' 层的样本量应当是 2')
  }
})

test('分层一定包含全部四个标签（没样本的层也在，值为 null 而不是缺键）', () => {
  const result = aggregate([rec({ sceneLabel: 'bot_to_bot' })])
  assert.deepEqual(Object.keys(result.byScene).sort(), [...SCENE_LABELS].sort())
  assert.equal(result.byScene.mixed_group.samples, 0)
  assert.equal(result.byScene.bot_to_human.metrics.participantIdentificationAccuracy.value, null)
})

test('分层与总体用同一套判据：总体的分子 = 四层分子之和', () => {
  const records = fourScenesTwoEach().map((one, index) => ({
    ...one,
    identity: { labeled: 2, correct: index === 0 ? 1 : 2, unknownTotal: 1, unknownRetained: 1 },
  }))
  const result = aggregate(records)
  const sum = SCENE_LABELS.reduce((total, label) => total + result.byScene[label].metrics.participantIdentificationAccuracy.numerator, 0)
  assert.equal(result.overall.metrics.participantIdentificationAccuracy.numerator, sum)
  assert.equal(result.overall.metrics.participantIdentificationAccuracy.denominator, 16)
})

test('场景标签缺失或写错 → 按 unknown_participant 计，并单独点名（不悄悄折进总体）', () => {
  const result = aggregate([
    rec({ runId: 'ok', sceneLabel: 'bot_to_bot' }),
    rec({ runId: 'bad', sceneLabel: 'bot2bot' }),
    rec({ runId: 'missing', sceneLabel: undefined }),
  ])
  assert.equal(result.records, 3)
  assert.equal(result.byScene.unknown_participant.samples, 2)
  assert.equal(result.byScene.bot_to_bot.samples, 1)
  assert.equal(result.unlabeledScenes.length, 2)
})

// ── 分母为 0 → null ───────────────────────────────────────────────────────

test('分母为 0 → null（不是 0），并标 no-samples', () => {
  const result = aggregate([rec({ action: 'silent' })])
  const metric = result.overall.metrics.botRepeatResponseRate
  assert.equal(metric.value, null)
  assert.equal(metric.denominator, 0)
  assert.equal(metric.status, 'no-samples')
  // 0/0 与 0/5 必须长得不一样：下面这条是 0 值但有分母。
  const zero = aggregate([spoke({ botParticipants: ['bot-a'], semanticDuplicate: false })]).overall.metrics.botRepeatResponseRate
  assert.equal(zero.value, 0)
  assert.equal(zero.denominator, 1)
  assert.equal(zero.status, 'ok')
})

test('完全空输入：所有指标 null，不抛', () => {
  const result = aggregate([])
  assert.equal(result.records, 0)
  assert.equal(result.overall.samples, 0)
  for (const key of Object.keys(result.overall.metrics)) {
    assert.equal(result.overall.metrics[key].value, null, key + ' 在没有样本时必须是 null')
  }
  // 人工评分类即使 0 样本也仍然是"需要人工标注"，不是"无样本"——两者都要能被报告说清。
  assert.deepEqual(result.overall.needsHumanLabel, [...HUMAN_RATED_METRICS])
})

test('非数组 / 非对象条目被过滤，不抛', () => {
  const result = aggregate([null, 42, 'x', rec({ sceneLabel: 'bot_to_bot' })])
  assert.equal(result.records, 1)
  assert.equal(aggregate(undefined).records, 0)
})

// ── 人工评分：没有标注就是 null ───────────────────────────────────────────

test('没有人工标注 → 自然度 / 讨论质量 / 人格独立性 全为 null 且标 needs-human-label', () => {
  const result = aggregate([spoke({ sceneLabel: 'bot_to_human' }), spoke({ sceneLabel: 'bot_to_bot' })])
  for (const key of HUMAN_RATED_METRICS) {
    const metric = result.overall.metrics[key]
    assert.equal(metric.value, null, key + ' 不许拿代理值顶替')
    assert.equal(metric.status, 'needs-human-label')
  }
  assert.deepEqual(result.overall.needsHumanLabel, [...HUMAN_RATED_METRICS])
})

test('有候选发言、有重复、有延迟 —— 照样不产生自然度代理值', () => {
  const result = aggregate([
    spoke({ sceneLabel: 'bot_to_human', semanticDuplicate: false, latencyMs: 800, candidateText: '很长很长的一句候选发言，内容完整' }),
  ])
  // 这一条是"绝不能用回复长度/延迟/重复度冒充质量"的守卫断言。
  assert.equal(result.overall.metrics.botToHumanNaturalness.value, null)
  assert.equal(result.overall.metrics.botToHumanNaturalness.status, 'needs-human-label')
})

test('有人工标注 → 有值且状态 ok；自然度只在含人类的分层里计入', () => {
  const result = aggregate([
    spoke({ sceneLabel: 'bot_to_human', humanLabels: { naturalness: 0.8 } }),
    spoke({ sceneLabel: 'bot_to_human', humanLabels: { naturalness: 0.6 } }),
    // Bot → Bot 的自然度不该被计入（那里没有人类），但人格独立性可以。
    spoke({ sceneLabel: 'bot_to_bot', humanLabels: { naturalness: 1, personaIndependence: 0.5 } }),
  ])
  assert.equal(result.overall.metrics.botToHumanNaturalness.value, 0.7)
  assert.equal(result.overall.metrics.botToHumanNaturalness.status, 'ok')
  assert.equal(result.byScene.bot_to_bot.metrics.botToHumanNaturalness.value, null)
  assert.equal(result.byScene.bot_to_bot.metrics.personaIndependence.value, 0.5)
})

test('1–5 分制要先归一化：normalizeHumanLabels 不会擅自猜量纲', () => {
  assert.deepEqual(normalizeHumanLabels({ naturalness: 4 }, { scale: 5 }), { naturalness: 0.75 })
  assert.deepEqual(normalizeHumanLabels({ naturalness: 0.75 }), { naturalness: 0.75 })
  // 没声明量纲却给 4 分：不猜，原样保留 → 后续 labelValue 会把它当"没有"。
  const result = aggregate([spoke({ sceneLabel: 'bot_to_human', humanLabels: { naturalness: 4 } })])
  assert.equal(result.overall.metrics.botToHumanNaturalness.value, null)
})

// ── §6 明写"不算失败"的四类 ───────────────────────────────────────────────

test('对 Bot 沉默不计失败，只出现在行为分布里', () => {
  const result = aggregate([rec({ sceneLabel: 'bot_to_bot', action: 'silent', botParticipants: ['b1', 'b2'] })])
  assert.equal(result.overall.failures.failingRuns, 0)
  assert.equal(result.overall.failures.invalidOutput, 0)
  assert.equal(result.overall.behavior.silentOnBotScene, 1)
  assert.equal(result.overall.behavior.silentRate, 1)
})

test('没回应每一句 / 没加入每个话题 / 没模仿别的 Bot：都不进失败计数', () => {
  const result = aggregate([
    rec({ sceneLabel: 'bot_to_human', action: 'silent', humanParticipants: ['h1'] }),
    rec({ sceneLabel: 'mixed_group', action: 'observe', botParticipants: ['b1'], humanParticipants: ['h1'] }),
    spoke({ sceneLabel: 'bot_to_bot', humanLabels: { imitatesOtherBot: true } }),
  ])
  assert.equal(result.overall.failures.failingRuns, 0)
  assert.equal(result.overall.behavior.observed, 1)
  assert.equal(result.overall.behavior.imitatedOtherBot, 1)
  // 观察率/沉默率只是分布，报告里不能把它写成失败。
  assert.equal(result.overall.behavior.silentRate, 0.3333)
})

// ── 确定的坏：这五类才进 failures ─────────────────────────────────────────

test('坏输出计失败', () => {
  const result = aggregate([rec({ decisionTier: 'invalid', action: 'invalid' })])
  assert.equal(result.overall.failures.invalidOutput, 1)
  assert.equal(result.overall.failures.failingRuns, 1)
})

test('回复目标未命中计失败，非 reply 动作即使 targetValid=false 也不算', () => {
  assert.equal(aggregate([spoke({ targetValid: false })]).overall.failures.targetMiss, 1)
  assert.equal(aggregate([rec({ action: 'react', targetValid: false })]).overall.failures.targetMiss, 0)
})

test('代码 veto、身份不一致、高风险仍出候选：各自计一条', () => {
  const vetoed = aggregate([spoke({ veto: 'target-not-present' })])
  assert.equal(vetoed.overall.failures.codeVeto, 1)
  const mismatch = aggregate([spoke({ identity: { labeled: 3, correct: 2, unknownTotal: 1, unknownRetained: 1 } })])
  assert.equal(mismatch.overall.failures.identityMismatch, 1)
  const risky = aggregate([spoke({ botParticipants: ['b1', 'b2'], botLoopRisk: 'high' })])
  assert.equal(risky.overall.failures.highRiskCandidate, 1)
})

// ── 十个指标逐条 ──────────────────────────────────────────────────────────

test('指标定义与 §6 表一一对应（十个，顺序一致，且都真的算得出来）', () => {
  assert.equal(METRIC_DEFS.length, 10)
  const result = aggregate([rec()])
  assert.deepEqual(Object.keys(result.overall.metrics), METRIC_DEFS.map((def) => def.key))
  assert.equal(result.version, METRICS_VERSION)
})

test('Bot 重复响应率：分母是"有别的 Bot 时的候选发言"', () => {
  const result = aggregate([
    spoke({ botParticipants: ['b1'], semanticDuplicate: true }),
    spoke({ botParticipants: ['b1'], semanticDuplicate: false }),
    // 没有别的 Bot 的候选发言不进分母。
    spoke({ botParticipants: [], semanticDuplicate: true }),
    // 沉默不进分母。
    rec({ action: 'silent', botParticipants: ['b1'], semanticDuplicate: true }),
  ])
  assert.equal(result.overall.metrics.botRepeatResponseRate.denominator, 2)
  assert.equal(result.overall.metrics.botRepeatResponseRate.numerator, 1)
  assert.equal(result.overall.metrics.botRepeatResponseRate.value, 0.5)
})

test('Bot 循环风险识别率：只在至少两个已登记 Bot 的场景上算', () => {
  const result = aggregate([
    rec({ botParticipants: ['b1', 'b2'], botLoopRisk: 'high' }),
    rec({ botParticipants: ['b1', 'b2'], botLoopRisk: 'low' }),
    // 只有一个 Bot：谈不上循环，不进分母。
    rec({ botParticipants: ['b1'], botLoopRisk: 'high' }),
  ])
  assert.equal(result.overall.metrics.botLoopRiskDetectionRate.denominator, 2)
  assert.equal(result.overall.metrics.botLoopRiskDetectionRate.value, 0.5)
  assert.deepEqual(result.overall.loopRisk, { low: 1, medium: 0, high: 2, unknown: 0 })
})

test('跨 Bot 回复对象准确率：只算指向已登记 Bot 的候选发言', () => {
  const result = aggregate([
    spoke({ targetKind: 'known_bot', targetValid: true }),
    spoke({ targetKind: 'known_bot', targetValid: false }),
    // 指向人类的候选发言不进这个分母。
    spoke({ targetKind: 'known_human', targetValid: true }),
  ])
  assert.equal(result.overall.metrics.crossBotTargetAccuracy.denominator, 2)
  assert.equal(result.overall.metrics.crossBotTargetAccuracy.value, 0.5)
})

test('混合话题切换准确率：只统计采集侧标了"话题确实变了"的记录', () => {
  const result = aggregate([
    rec({ topicShifted: true, topicShiftRecognized: true }),
    rec({ topicShifted: true, topicShiftRecognized: false }),
    rec({ topicShifted: false, topicShiftRecognized: false }),
  ])
  assert.equal(result.overall.metrics.mixedTopicSwitchAccuracy.denominator, 2)
  assert.equal(result.overall.metrics.mixedTopicSwitchAccuracy.value, 0.5)
})

test('无价值参与率：分母是有 newInformation 判定的候选发言', () => {
  const result = aggregate([
    spoke({ newInformation: false }),
    spoke({ newInformation: true }),
    rec({ action: 'silent' }),
  ])
  assert.equal(result.overall.metrics.wastedParticipationRate.denominator, 2)
  assert.equal(result.overall.metrics.wastedParticipationRate.value, 0.5)
})

test('参与者识别准确率与 Unknown 保留率来自采集侧的核对块', () => {
  const result = aggregate([
    spoke({ identity: { labeled: 4, correct: 3, unknownTotal: 2, unknownRetained: 2 } }),
    spoke({ identity: { labeled: 2, correct: 2, unknownTotal: 1, unknownRetained: 0 } }),
  ])
  assert.equal(result.overall.metrics.participantIdentificationAccuracy.value, 0.8333)
  assert.equal(result.overall.metrics.unknownRetentionRate.value, 0.6667)
  // 缺这个块时不是 0，是"没有样本"。
  assert.equal(aggregate([spoke()]).overall.metrics.participantIdentificationAccuracy.value, null)
})

// ── 工具函数与不变性 ──────────────────────────────────────────────────────

test('redact 把 ≥5 位数字串换成占位符（3–4 位保留）', () => {
  assert.equal(redact('群 123456789 里的 504'), '群 <长数字号> 里的 504')
  assert.equal(redact('短号 1234'), '短号 1234')
  assert.equal(redact(undefined), '')
})

test('aggregate 是纯函数：同样输入两次结果完全相同', () => {
  const records = fourScenesTwoEach()
  assert.deepEqual(aggregate(records), aggregate(records))
})

test('延迟与 token 只汇总有数的记录（缺 usage 记 missing，不补 0）', () => {
  const result = aggregate([
    rec({ latencyMs: 100, tokens: { promptTokens: 10, completionTokens: 5 } }),
    rec({ latencyMs: undefined, tokens: undefined }),
  ])
  assert.equal(result.overall.latency.samples, 1)
  assert.equal(result.overall.tokens.prompt, 10)
  assert.equal(result.overall.tokens.missingUsage, 1)
})

// ── 报告 ──────────────────────────────────────────────────────────────────

test('报告给每个指标标方向：重复率是"越低越好"，准确率是"越高越好"', () => {
  assert.equal(directionOf('botRepeatResponseRate'), '越低越好')
  assert.equal(directionOf('crossBotTargetAccuracy'), '越高越好')
  assert.equal(directionOf('botLoopRiskDetectionRate'), '覆盖率（非好坏）')
  assert.equal(directionOf('not-a-metric'), null)
  const md = renderReport(aggregate([spoke({ botParticipants: ['b1'], semanticDuplicate: false })]))
  assert.ok(md.includes('越低越好'))
  assert.ok(md.includes('越高越好'))
})

test('报告先总体后分层，四层标题都在', () => {
  const md = renderReport(aggregate(fourScenesTwoEach()))
  const overall = md.indexOf('## 1. 总体')
  assert.ok(overall >= 0)
  const scene = md.indexOf('## 2. 分层结果')
  assert.ok(scene > overall, '分层必须排在总体之后')
  for (const label of SCENE_LABELS) {
    assert.ok(md.includes(SCENE_TITLES[label]), label + ' 的标题应当在报告里')
  }
})

test('某场景 0 样本：写"该场景无样本"，且该段不出现任何 0 分', () => {
  const records = fourScenesTwoEach().filter((one) => one.sceneLabel !== 'unknown_participant')
  const md = renderReport(aggregate(records))
  assert.ok(md.includes('该场景无样本'))
  const section = md.slice(md.indexOf('### ' + SCENE_TITLES.unknown_participant))
  assert.ok(section.includes('该场景无样本'))
  assert.ok(!section.includes('0.0'), '无样本的层不许渲染 0 分')
  assert.ok(!section.includes('| 0 '), '无样本的层不许渲染 0 计数')
  // 整份报告里不许出现"0%"这种把"没测"读成"全错"的写法。
  assert.ok(!md.includes('0%'))
})

test('报告写明哪几项在等人工标注，且这些行不放数字', () => {
  const md = renderReport(aggregate([spoke({ sceneLabel: 'bot_to_human' })]))
  assert.ok(md.includes('需要人工标注'))
  for (const key of HUMAN_RATED_METRICS) assert.ok(md.includes(key))
  assert.ok(md.includes('需要人工标注') && md.includes('不是 0'))
})

test('报告的证据级别段：五级齐全，且有一行说明 real-send 恒为 0 是设计使然', () => {
  const md = renderReport(aggregate([rec()]), { realApi: true, realInbound: true })
  for (const level of EVIDENCE_LEVELS) assert.ok(md.includes(level), level + ' 应当在证据段里')
  assert.equal(EVIDENCE_LEVELS.length, 5)
  assert.ok(/real-send 恒为 0 条，这是设计使然/.test(md))
  assert.ok(md.includes('Mirror-only'))
})

test('报告脱敏：长数字串不出现在正文里', () => {
  const md = renderReport(aggregate([
    spoke({ runId: '123456789', modelName: 'model-1000000' }),
  ]))
  assert.ok(!/\b123456789\b/.test(md))
  assert.ok(md.includes('<长数字号>'))
})

test('空结果也出得成报告：不出表、不出现 0%，四层都说"该场景无样本"', () => {
  const md = renderReport(aggregate([]))
  assert.ok(!md.includes('0%'))
  assert.equal(md.split('该场景无样本').length - 1, 4)
  assert.ok(md.includes('样本量：**0**'))
  // 人工评分类即使 0 样本也标"需要人工标注"，不能标成"无样本"（那会读成"测过但没有"）。
  assert.ok(md.includes('需要人工标注'))
})

test('场景标签缺失时单独成节，且章节号自动顺延不跳号', () => {
  const md = renderReport(aggregate([
    rec({ runId: 'ok', sceneLabel: 'bot_to_bot' }),
    rec({ runId: 'bad', sceneLabel: 'bot2bot' }),
  ]))
  assert.ok(md.includes('场景标签缺失'))
  const headings = md.split('\n').filter((line) => line.startsWith('## '))
  headings.forEach((line, index) => {
    assert.ok(line.startsWith('## ' + String(index + 1) + '. '), '章节号应当从 1 连续：' + line)
  })
  assert.ok(headings.length >= 7)
})

test('没有标签缺失时不出现那一节（空段落不占位）', () => {
  const md = renderReport(aggregate([rec({ sceneLabel: 'bot_to_bot' })]))
  assert.ok(!md.includes('场景标签缺失'))
})

test('报告带版本号，且渲染不改口径（总体样本量与 aggregate 一致）', () => {
  const result = aggregate(fourScenesTwoEach())
  const md = renderReport(result, { generatedAt: '2026-11-09 22:00' })
  assert.ok(md.includes('报告格式版本：' + String(REPORT_VERSION)))
  assert.ok(md.includes('指标层版本：' + String(METRICS_VERSION)))
  assert.ok(md.includes('**8**'))
})
