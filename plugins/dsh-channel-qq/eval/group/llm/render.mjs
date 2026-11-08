/**
 * **人读报告**（终端输出）与机读报告的组装。
 *
 * 一条硬规矩：**离线通道与真实模型通道分成两段打印，绝不合成一个准确率**（计划 §2.3）。
 * 原因不是排版偏好：
 *   - 离线那段的 73.3% / 42.3% 是"写死的模型输出 + 代码判定"的结果，**不是模型表现**；
 *   - 这一段是"真实模型输出 + 同一套代码判定"，没有人标注金标准，也就没有"准确率"可言。
 * 把两段拼成一个数，读的人会以为拿到了"模型在群里的准确率"——那是本计划 §6 点名要避免的事。
 *
 * 所以这里的排版是：先印离线（并标明"这是邻居的成绩，不是本通道的"），再印真实模型，
 * 各自带自己的口径、分母与证据级别；中间一条分隔线，不给任何"合计"。
 */

/** 终端宽度下的对齐（CJK 算两格；报告里会混排中英文）。 */
export function pad(text, width) {
  const value = String(text ?? '')
  const actual = [...value].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return value + ' '.repeat(Math.max(0, width - actual))
}

/** 百分比；`null` 明确印成"没有数据"，不印 0%。 */
export function percent(value) {
  return value === null || value === undefined ? '—（无数据）' : `${(value * 100).toFixed(1)}%`
}

/** 毫秒；`null` 印破折号。 */
function ms(value) {
  return value === null || value === undefined ? '—' : `${String(value)}ms`
}

/** token 数；`null` 印"—"。 */
function tokens(value) {
  return value === null || value === undefined ? '—' : String(value)
}

/** 一段标题。 */
function heading(text) {
  return `\n═══ ${text} ═══`
}

/**
 * 第一段：离线代码回放（**引用离线通道自己的报告**，不在这里重算）。
 * @param {object|null} offline `eval/group/run.mjs --json` 的输出（或 null）
 * @param {string} [failure] 取不到离线报告时的原因
 */
export function renderOfflineSection(offline, failure = '') {
  const lines = [heading('第一段 · 离线代码回放（offline-test，不是本通道的成绩）')]
  if (offline === null) {
    lines.push('  离线通道本次没有出成绩：' + (failure === '' ? '未运行（--no-offline）' : failure))
    lines.push('  说明：这一段为空**不影响**下面的真实模型通道；两段成绩互不推导。')
    return lines
  }
  const totals = offline.totals ?? {}
  const metrics = offline.metrics ?? {}
  const gates = Array.isArray(offline.gates) ? offline.gates : []
  lines.push(`  口径：模型输出是语料里写死的固定输入，测的是代码侧判定与执行边界（证据级别 offline-test）。`)
  lines.push(`  用例 ${String(totals.total ?? '?')} 条 · PASS ${String(totals.pass ?? '?')} · FAIL ${String(totals.fail ?? '?')} · WARN ${String(totals.warn ?? '?')} · 硬门槛 ${gates.every((gate) => gate.ok) ? '全过' : '有未达标'}`)
  lines.push(`  插话准确率 ${percent(metrics.interjectionPrecision)} · 机会参与率 ${percent(metrics.opportunityParticipation)} · 目标选择 ${percent(metrics.targetSelection)}`)
  lines.push(`  错误目标拒绝率 ${percent(metrics.badTargetRejection)} · 坏输出拦截率 ${percent(metrics.badOutputInterception)} · 沉默正确率（隐私/争执，代码侧）${percent(metrics.silenceRate)}`)
  lines.push('  ⚠ 这两组数属于**离线通道**：上面那三个百分比的分母是人工写死的模型输出，不能当作真实模型效果。')
  if (typeof offline.note === 'string' && offline.note !== '') lines.push('  注：' + offline.note)
  return lines
}

/** 每条用例的对照行（场景 / 解析档 / 动作 / 流程结局 / 代码 veto / 延迟 / token / 目标号）。 */
function caseLine(caseSummary) {
  const target = caseSummary.target.messageId === null ? '' : ` #${String(caseSummary.target.messageId)}`
  const veto = caseSummary.veto === null ? '' : `veto ${String(caseSummary.veto)}`
  const action = caseSummary.action === null ? '-' : caseSummary.action
  const stability = caseSummary.stability.stable ? '' : `  ⚠ ${String(caseSummary.stability.unique.length)} 种结果（重跑不一致）`
  const trip = caseSummary.tripwire ? '  ✗ 绊线被触发（HARD FAIL）' : ''
  const total = caseSummary.tokens.totalTokens
  return `  ${pad(caseSummary.sceneId, 6)}${pad(String(caseSummary.inputHash ?? '-').slice(0, 8), 10)}${pad(caseSummary.tier, 10)}${pad(action, 8)}${pad(caseSummary.execution, 8)}`
    + `${pad(ms(caseSummary.latencyMs), 9)}${pad(`${tokens(total)} tok`, 10)}${pad(veto, 34)}${target}${stability}${trip}`
}

/**
 * 第二段：真实模型通道。
 * @param {object} report 运行器组装好的报告（`report.real`）
 */
export function renderRealSection(report) {
  const real = report.real
  const agg = real.aggregate
  const lines = [heading('第二段 · 真实模型通道（real-api，零 QQ 发送）')]
  lines.push(`  模型 ${agg.model.name}（temperature ${String(agg.model.temperature)}）· 端点 ${report.config.endpointOrigin || '（未记录）'} · 每条重复 ${String(agg.model.repeat)} 次`)
  lines.push(`  人格快照 ${report.persona.available ? `${report.persona.file}（version ${report.persona.version}）` : `不可用——${report.persona.note}`}`)
  lines.push(`  实现 ${report.impl.source} · 流程通道 ${report.channel.mode === 'presence-cycle' ? 'runPresenceCycle（含影子闸门）' : `组合通道：${report.channel.mode}`}`)
  if (report.channel.mode !== 'presence-cycle') lines.push(`  ⚠ ${report.channel.detail}`)
  lines.push('')
  lines.push(`  运行 ${String(agg.cases)} 条示例 × ${String(agg.model.repeat)} 次 = ${String(agg.runs)} 次判断（真实模型调用 ${String(agg.runs)} 次）`)
  lines.push(`  解析档：decision ${String(agg.byTier.decision)} · silent（模型说沉默）${String(agg.byTier.silent)} · invalid（输出不可用）${String(agg.byTier.invalid)}`)
  lines.push(`  有效输出率 ${percent(agg.validOutputRate)}（分母 = 全部 ${String(agg.runs)} 次；坏 JSON 不算"选择沉默"）`)
  lines.push(`  流程结局：shadow（本来要发、被闸门拦下）${String(agg.byExec.shadow)} · silent ${String(agg.byExec.silent)} · failed ${String(agg.byExec.failed)} · 真的发出去 ${String(agg.byExec.spoke)}`)
  const failure = Object.entries(agg.byFailureKind)
  if (failure.length > 0) lines.push(`  失败细分：${failure.map(([key, value]) => `${key} ${String(value)}`).join(' · ')}`)
  const errors = Object.entries(agg.byErrorCode)
  if (errors.length > 0) lines.push(`  异常码：${errors.map(([key, value]) => `${key} ${String(value)}`).join(' · ')}`)
  lines.push('')
  lines.push(`  若按 live 会发出去：${String(agg.wouldSend)} 次 · 被代码 veto：${String(agg.codeVetoed)} 次`)
  lines.push(`  目标校验：给了目标号 ${String(agg.targets.checked)} 次，其中通过 ${String(agg.targets.valid)} 次`)
  if (agg.targets.annotated > 0) {
    lines.push(`  与人工标注对照：${String(agg.targets.annotatedHits)}/${String(agg.targets.annotated)} 次目标号一致（**不是准确率**：标注是离线语料的人工偏好，不是线上真值）`)
  }
  lines.push('')
  lines.push(`  延迟：p50 ${ms(agg.latency.p50)} · p95 ${ms(agg.latency.p95)} · max ${ms(agg.latency.max)}（样本 ${String(agg.latency.samples)}）`)
  lines.push(`  token：prompt ${tokens(agg.tokens.prompt)} · completion ${tokens(agg.tokens.completion)} · 合计 ${tokens(agg.tokens.total)}${agg.tokens.missingUsage > 0 ? ` · 端点未给 usage ${String(agg.tokens.missingUsage)} 次` : ''}`)
  const cost = agg.cost
  const costText = cost.total === null
    ? `未配置单价（只报 token；配 ${cost.priceInputPerMTok === null ? 'EVAL_GROUP_LLM_PRICE_INPUT_PER_MTOK' : ''}${cost.priceInputPerMTok === null && cost.priceOutputPerMTok === null ? ' 与 ' : ''}${cost.priceOutputPerMTok === null ? 'EVAL_GROUP_LLM_PRICE_OUTPUT_PER_MTOK' : ''} 才会算钱）`
    : `合计 ${cost.total.toFixed(6)}（按每百万 token 单价；单位跟随你给的单价）`
  lines.push(`  成本：${costText}`)
  lines.push('')
  const unstable = report.real.stability.filter((item) => !item.stable)
  lines.push(`  非确定性：${String(report.real.stability.length - unstable.length)}/${String(report.real.stability.length)} 条重跑结果一致` + (unstable.length === 0 ? '' : `；不一致：${unstable.map((item) => `${item.sceneId}（${item.unique.length} 种）`).join('、')}`))
  if (report.config.repeat === 1) lines.push('  （EVAL_GROUP_LLM_REPEAT=1：同一条只跑一次，采样波动无从观察；要测波动请把它调大）')
  lines.push('')
  lines.push('  安全：')
  lines.push(`    绊线触发 ${String(report.safety.tripwireTrips)} 次 · 真的发出去的 QQ 消息 ${String(report.safety.liveSends)} 条 · 平台端口调用被拦 ${String(report.safety.blockedCalls)} 次`)
  lines.push(`    群号与 QQ 号：全程使用固定假群号 ${String(report.safety.fakeGroupId)}，报告与 JSONL 已对长数字串脱敏`)
  lines.push('')
  lines.push('  逐条（场景 / 输入hash / 解析档 / 动作 / 流程结局 / 耗时 / token / 代码 veto / 目标号）')
  for (const item of real.cases) lines.push(caseLine(item))
  return lines
}

/** 完整报告文本。 */
export function renderHuman(report) {
  const lines = []
  lines.push('群聊社交 · 真实模型影子评测（P5-C / 计划 §2.3 与 §9 任务 04）')
  lines.push(`生成时间 ${report.generatedAt} · 报告文件 ${report.files.reportJson}`)
  lines.push('证据级别：real-api（真实模型调用）+ 零 real-send（平台端口是绊线，一次都没被放行）。')
  lines.push('两段成绩分开出：第一段是邻居（离线回放）的成绩，第二段才是这次的。没有合计，也没有合并准确率。')
  lines.push(...renderOfflineSection(report.offline.report, report.offline.failure ?? ''))
  lines.push('')
  lines.push('─'.repeat(72))
  lines.push(...renderRealSection(report))
  lines.push('')
  lines.push('已知边界（不许读成"线上能发得得体"）')
  for (const note of report.notes) lines.push('  - ' + note)
  lines.push('')
  lines.push(`汇总：真实模型判断 ${String(report.real.aggregate.runs)} 次 · 绊线 ${String(report.safety.tripwireTrips)} 次 · 硬失败 ${String(report.totals.hardFails)} 条目`)
  return lines.join('\n')
}