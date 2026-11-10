/**
 * **混合机器人生态评测的人读报告**（`13-G4` 补充修订 §6 末段 + §8）。
 *
 * 这个文件的全部工作就是把 `metrics.mjs` 的聚合结果排成 markdown。它**不做任何计算**：
 * 不重新算比率、不把 null 补成 0、不在渲染时改口径。想看一个数怎么来的，去 metrics.mjs。
 *
 * 四条渲染纪律：
 *   1. **先总体、后分层**，四层各自一张小表。§6 最后一句就是这个顺序的理由：只给一个总分，
 *      Bot 数量多的分层会把人类互动能力的问题盖住。
 *   2. **没有样本的层说"该场景无样本"**，不输出一行 0。0% 与"没测"在报告里必须长得不一样，
 *      否则读者会把"这一层什么都没跑"读成"这一层全错"。
 *   3. **百分比列只放数字**（列头写 %），分母为 0 的格子放"—"。这不是排版偏好：它从物理上
 *      杜绝了"0 样本被渲染成 0%"这种事——那种行只要出现一次，下一个人就会把它当成绩引用。
 *   4. **证据级别照 `docs/07-verification-status.md` 的五级**，并且必须有一行说明
 *      "real-send 恒为 0 且这是设计使然而非未测"。这一行不能省：读报告的人第一反应就是
 *      "为什么发送是 0，是不是没跑"，省掉它就等于让人自己猜。
 *
 * 纯函数：不读盘、不联网、不看时钟（要时间就由调用方给 `generatedAt`）。
 */

import { METRICS_VERSION, SCENE_LABELS, SCENE_TITLES, directionOf, redact } from './metrics.mjs'

/** 报告格式版本：段落结构变了要加一，贴进工单时能对上用的是哪一版排版。 */
export const REPORT_VERSION = 1

/** 五级证据（顺序照 docs/07，不自创词汇）。 */
export const EVIDENCE_LEVELS = ['offline-test', 'host-load', 'real-api', 'real-inbound', 'real-send']

/** 占位符：分母为 0 或"需要人工标注"时统一用它，避免任何人把它读成 0。 */
const DASH = '—'

/** 比率 → 百分数列里的**数字**（不带百分号；分母为 0 → —）。 */
function pctCell(metric) {
  if (metric === undefined || metric === null) return DASH
  if (metric.value === null || metric.value === undefined) return DASH
  return (metric.value * 100).toFixed(1)
}

/** 分子/分母；没有分母时写 0/0 会误导，所以直接 —。 */
function fractionCell(metric) {
  if (metric === undefined || metric === null) return DASH
  if (!(metric.denominator > 0)) return DASH
  return String(metric.numerator) + '/' + String(metric.denominator)
}

/** 状态列：说人话，别让人去查代码。 */
function statusCell(metric) {
  if (metric === undefined || metric === null) return DASH
  if (metric.status === 'needs-human-label') return '需要人工标注'
  if (metric.status === 'no-samples') return '无样本'
  return '有样本'
}

/** 一张指标表（十行，顺序照 §6）。人工评分类：值要么是均分，要么是 —，绝不出现代理值。
 *  方向列是必须的：0.0 在"准确率"里是零分，在"重复率"里是满分，字面看不出区别。 */
function metricTable(section) {
  const lines = ['| 指标 | 值（%） | 方向 | 分子/分母 | 状态 |', '|---|---|---|---|---|']
  for (const key of Object.keys(section.metrics)) {
    const metric = section.metrics[key]
    const value = metric.status === 'needs-human-label' ? DASH : pctCell(metric)
    const direction = directionOf(key) ?? DASH
    lines.push('| ' + metric.label + ' | ' + value + ' | ' + direction + ' | ' + fractionCell(metric) + ' | ' + statusCell(metric) + ' |')
  }
  return lines
}

/** 行为分布：§6 明写"不算失败"的那几类在这里出现，且**只**在这里出现。 */
function behaviorLines(section) {
  const behavior = section.behavior
  const actions = section.actions
  return [
    '- 动作分布：silent ' + String(actions.silent) + ' · observe ' + String(actions.observe)
      + ' · reply ' + String(actions.reply) + ' · join ' + String(actions.join)
      + ' · react ' + String(actions.react),
    '- 候选发言：' + String(behavior.candidates) + ' 条 · 无候选（沉默或观察）：' + String(behavior.noCandidateRuns) + ' 条',
    '- **对 Bot 场景保持沉默**：' + String(behavior.silentOnBotScene) + ' 条（§6 明写这不算失败，只作分布）',
    '- 选择观察：' + String(behavior.observed) + ' 条（同上，不算失败）',
    '- 观察到"模仿其他 Bot"标记：' + String(behavior.imitatedOtherBot) + ' 条（行为观察，不是人格独立性分数）',
  ]
}

/** 失败计数：只有确定的坏。 */
function failureLines(section) {
  const failure = section.failures
  return [
    '- 坏输出（invalid）：' + String(failure.invalidOutput) + ' 条',
    '- 回复目标未命中：' + String(failure.targetMiss) + ' 条',
    '- 代码 veto：' + String(failure.codeVeto) + ' 条',
    '- 身份标签与注册表不一致：' + String(failure.identityMismatch) + ' 条',
    '- 自己判了 high 风险仍产出候选发言：' + String(failure.highRiskCandidate) + ' 条',
    '- 含至少一条失败的记录：' + String(failure.failingRuns) + ' 条',
  ]
}

/** 某一层的正文：0 样本时只写一句"该场景无样本"，**不输出表**。 */
function sceneSection(label, section) {
  const lines = []
  lines.push('### ' + (SCENE_TITLES[label] ?? label) + '（' + label + '）')
  lines.push('')
  if (section.samples === 0) {
    lines.push('该场景无样本（0 条记录）：本节不出分数，也不参与任何跨层比较。')
    lines.push('')
    return lines
  }
  lines.push('样本量：**' + String(section.samples) + '** 条记录。')
  lines.push('')
  lines.push(...metricTable(section))
  lines.push('')
  if (section.needsHumanLabel.length > 0) {
    lines.push('本节仍在等人工盲评的指标：' + section.needsHumanLabel.join(' / ')
      + '（§7 盲评未做，因此为 null，而不是 0）。')
    lines.push('')
  }
  return lines
}

/** 证据级别段：五级逐条给出"本报告是否构成证据"+ 为什么。 */
function evidenceSection(extra) {
  const rows = [
    ['offline-test', '是', 'metrics / report 是纯函数，有可复现命令与通过计数'],
    ['host-load', '否', '本层不装载插件、不起宿主'],
    ['real-api', extra.realApi ? '是' : '否', extra.realApi
      ? '记录来自真实模型通道（由采集侧标注）'
      : '本报告只消费已落盘的记录，不发起模型调用'],
    ['real-inbound', extra.realInbound ? '是' : '否', extra.realInbound
      ? '记录来自 NapCat 镜像的真实入站事件'
      : '没有真实入站事件穿过本层'],
    ['real-send', '否（恒为 0）', 'Mirror-only：平台上行始终为零'],
  ]
  const lines = ['| 级别 | 本报告是否构成证据 | 说明 |', '|---|---|---|']
  for (const [level, yes, why] of rows) lines.push('| ' + level + ' | ' + yes + ' | ' + why + ' |')
  lines.push('')
  lines.push('> **real-send 恒为 0 条，这是设计使然（Mirror-only），不是未测。**')
  lines.push('> 本层从不发送任何 QQ 消息；"零发送"在这里是约束，不是成绩，也不是缺口。')
  lines.push('')
  lines.push('口径说明：docs/07 的五级是 offline-test / host-load / real-api / real-send / hardware；')
  lines.push('real-inbound 是镜像通道验收表（docs/12a、docs/12b）里的一级，本报告沿用它的叫法。')
  return lines
}

/** 元数据段（全部脱敏：注册表版本、模型名、来源都可能带长数字）。 */
function provenanceLines(provenance) {
  const join = (values) => (values.length === 0 ? DASH : values.map((value) => redact(value)).join('、'))
  return [
    '- 模型：' + join(provenance.models),
    '- 人格版本：' + join(provenance.personas),
    '- 参与者注册表版本：' + join(provenance.registries),
    '- 来源：' + join(provenance.sources),
    '- 运行批次数：' + String(provenance.runIds),
  ]
}

/**
 * 渲染整份报告。
 *
 * @param {object} result aggregate() 的返回值
 * @param {object} [options]
 * @param {string} [options.generatedAt] 由调用方传入的时间戳（本函数不读时钟）
 * @param {boolean} [options.realApi] 记录是否来自真实模型通道
 * @param {boolean} [options.realInbound] 记录是否来自真实入站镜像
 */
export function renderReport(result, options = {}) {
  const overall = result.overall
  const lines = []
  // 章节号自增：中间某一段（比如"场景标签缺失"）只在有内容时才出现，写死数字会跳号。
  let section = 0
  const heading = (title) => {
    section += 1
    lines.push('## ' + String(section) + '. ' + title)
    lines.push('')
  }
  lines.push('# 混合机器人生态评测报告')
  lines.push('')
  lines.push('- 指标层版本：' + String(result.version ?? METRICS_VERSION) + ' · 报告格式版本：' + String(REPORT_VERSION))
  if (typeof options.generatedAt === 'string' && options.generatedAt !== '') {
    lines.push('- 生成时间：' + redact(options.generatedAt) + '（由调用方提供）')
  }
  lines.push('- 记录条数：**' + String(result.records) + '**')
  lines.push('- 分层：Bot → Bot / Bot → Human / Mixed → Group / Unknown → Group（四层独立给分）')
  lines.push('')
  lines.push('> 读法：分层结果与总体用**同一套判据**。总体分高不代表人类互动好——Bot 多的时候，')
  lines.push('> Bot → Bot 的记录会把总体拉起来，所以要逐层看（§6 末段）。')
  lines.push('')

  heading('总体')
  lines.push('样本量：**' + String(overall.samples) + '** 条记录。')
  lines.push('')
  lines.push(...metricTable(overall))
  lines.push('')
  if (overall.needsHumanLabel.length > 0) {
    lines.push('**需要人工标注的指标**（当前为 null，不是 0）：' + overall.needsHumanLabel.join(' / '))
    lines.push('')
    lines.push('上面这些是 §7 的人工盲评项（缺哪项就列哪项，不是固定三条）。本层**不提供代理值**：')
    lines.push('想让它有数，就去做盲评并按 humanLabels 字段回填，或先过 normalizeHumanLabels() 换算量纲。')
    lines.push('')
  }

  heading('分层结果')
  for (const label of SCENE_LABELS) lines.push(...sceneSection(label, result.byScene[label]))

  if (Array.isArray(result.unlabeledScenes) && result.unlabeledScenes.length > 0) {
    heading('场景标签缺失')
    lines.push('以下记录没有合法的 sceneLabel，已按 unknown_participant 计入分层，'
      + '没有悄悄折进总体：' + result.unlabeledScenes.map((id) => redact(id)).join('、'))
    lines.push('')
  }

  heading('行为分布（不是评分）')
  lines.push(...behaviorLines(overall))
  lines.push('')

  heading('失败计数（只收确定的坏）')
  lines.push(...failureLines(overall))
  lines.push('')
  lines.push('> §6 明写不算失败的四种情况**不在这里**：对 Bot 沉默、没回应每一个人类发言、')
  lines.push('> 没加入每个话题、没模仿群内其他 Bot。它们只在上一节的分布里出现。')
  lines.push('')

  heading('证据级别')
  lines.push(...evidenceSection(options))
  lines.push('')

  heading('元数据（已脱敏）')
  lines.push(...provenanceLines(overall.provenance))
  lines.push('')
  lines.push('> 任何 ≥5 位的数字串在渲染时一律替换为 <长数字号>：报告会被贴进工单与聊天窗口。')
  lines.push('')
  return lines.join('\n')
}
