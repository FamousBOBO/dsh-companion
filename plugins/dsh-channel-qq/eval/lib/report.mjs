/**
 * 报告的渲染与落盘。
 *
 * 人读的输出（终端）与机读的输出（`--json` / eval/last-report.json）共用同一个
 * report 对象；P6 每项升级"关/开"两次跑的对比就是 diff 两份 last-report.json。
 */

import { writeFile } from 'node:fs/promises'

/**
 * 性能基线四项（07 §5.4）。数字来自交接文档实测（2026-10-14），
 * 目标值是方向性的——这里只**呈现**实测值与对照，不自动判 PASS/FAIL
 * （方向性目标要等 P6b/6d/6e 落地后按 P1 实测基线重新设定）。
 */
export const PERF_BASELINES = [
  { metric: '私聊回复耗时 p50 / p90', baseline: '51s / 94s（2026-10-14 实测）', target: '≤ 20s / ≤ 40s' },
  { metric: '每回合输入 token', baseline: '8–16 万', target: '≤ 3 万（私聊）/ ≤ 1.5 万（群聊）' },
  { metric: '群聊被 @ 到首条消息', baseline: '未测', target: '≤ 15s' },
  { metric: '工具调用失败率', baseline: '8/670（含 5 次正常守卫）', target: '不升高' },
]

function pad(s, n) {
  // 中文字符按 2 列宽粗略对齐即可，报告给人看，不要求逐列精确。
  const width = [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return s + ' '.repeat(Math.max(0, n - width))
}

/** 渲染成人读的多行文本。 */
export function renderHuman(report) {
  const lines = []
  lines.push(`评测基线（P6a · eval/） · 模式 ${report.mode} · ${report.generatedAt}`)
  for (const [name, suite] of Object.entries(report.suites)) {
    const s = suite.summary
    lines.push('')
    lines.push(`[${name}] 通过 ${s.pass} · 失败 ${s.fail} · 跳过 ${s.skip}（共 ${s.total}）`)
    for (const item of suite.items) {
      lines.push(`  ${pad(item.status, 6)}${pad(item.id, 16)}${item.detail ?? ''}`)
      for (const f of item.failures ?? []) {
        lines.push(`        ↳ [${f.id}] ${f.detail}`)
      }
    }
  }
  const t = report.totals
  lines.push('')
  lines.push(`汇总：PASS ${t.pass} · FAIL ${t.fail} · SKIP ${t.skip}${t.fail > 0 ? '（有 FAIL，退出码 1）' : ''}`)
  if (report.perf !== undefined) {
    const p = report.perf
    lines.push('')
    lines.push(`性能快照（会话 ${p.sessionId}）：轮次 ${p.durationsSec.turns} · 耗时 p50 ${p.durationsSec.p50}s / p90 ${p.durationsSec.p90}s / 最长 ${p.durationsSec.max}s`)
    lines.push(`  每回合输入 token：中位 ${p.promptTokens.p50} / 最大 ${p.promptTokens.max}`)
    lines.push(`  工具结果 ${p.toolResults.total} 次，失败 ${p.toolResults.failed} 次 · 发言 ${p.sends.total} 次（${p.sends.turnsWithSend} 轮） · 真人轮次 ${p.qqTurns}`)
    lines.push('  对照基线（07 §5.4，目标值是方向性的，不自动判定）：')
    for (const row of PERF_BASELINES) lines.push(`    ${row.metric}：实测基线 ${row.baseline} → 目标 ${row.target}`)
  }
  if (report.llmReview !== undefined) {
    const r = report.llmReview
    lines.push('')
    lines.push(r.skipped === true ? `LLM 评审：未启用（${r.reason}）` : `LLM 评审（${r.model ?? '?'}，只给意见不改任何东西）：\n${r.notes ?? r.error ?? ''}`)
  }
  return lines.join('\n')
}

/** 写一份机读报告（默认 eval/last-report.json）。 */
export async function writeReportFile(file, report) {
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return file
}
