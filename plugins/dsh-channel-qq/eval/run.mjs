#!/usr/bin/env node
/**
 * 评测基线跑分器（P6a）。
 *
 *   node eval/run.mjs                      # 全部离线套件（QQ 掉线期间也能跑）
 *   node eval/run.mjs --suite redteam      # 只跑一个套件（可重复）
 *   node eval/run.mjs --transcript <文件>  # 只跑一条转录（可重复）
 *   node eval/run.mjs --session <会话id>   # 对会话原件抽出的真实回合跑判定
 *       [--cwd <工作区路径>] [--case redteam/D1] [--json]
 *   node eval/run.mjs --llm-review         # 启用 LLM 评审钩子（默认不跑）
 *
 * 退出码：0 = 无 FAIL；1 = 有 FAIL；2 = 用法/配置/文件错误。
 * 每次运行都写 eval/last-report.json —— P6 每项升级"关/开"对比就 diff 它。
 *
 * 判定面与规则种类见 lib/rules.mjs；用例/转录格式见 eval/README.md。
 */

import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readdir } from 'node:fs/promises'
import * as path from 'node:path'

import { compileRules, judge } from './lib/rules.mjs'
import { loadCaseSuite, caseChecks, loadTranscript, transcriptParts, transcriptRuleSources } from './lib/load.mjs'
import { readSessionLog, parseRecords, extractTurns, conversationFromTurns, resolveSessionsRoot } from './lib/session.mjs'
import { renderHuman, writeReportFile } from './lib/report.mjs'
import { reviewWithLlm } from './lib/llm-review.mjs'

const EVAL_DIR = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_SUITES = ['redteam', 'scenarios', 'persona']

/** 用法/配置错误（退出码 2），区别于"评测失败"（退出码 1）。 */
class UsageError extends Error {}

const USAGE = `评测基线（P6a）· eval/run.mjs

用法：
  node eval/run.mjs                       全部离线套件（redteam / scenarios / persona）
  node eval/run.mjs --suite <名>          只跑一个套件（可重复；memory 为占位提示）
  node eval/run.mjs --transcript <文件>   只跑一条转录（可重复）
  node eval/run.mjs --session <会话id>    对会话原件抽出的真实回合跑判定
      --cwd <工作区路径>   会话所在项目目录（缺省 _no-cwd）
      --case redteam/D1    只跑该用例的规则（缺省 persona-base 人设规则）
  node eval/run.mjs --json                机读输出（stdout 纯 JSON）
  node eval/run.mjs --llm-review          启用 LLM 评审钩子（需配置 EVAL_LLM_BASE_URL，默认不跑）

退出码：0 无 FAIL · 1 有 FAIL · 2 用法/配置/文件错误。每次运行写 eval/last-report.json。
`

// ── 通用装配 ────────────────────────────────────────────────────────────────

function summarize(items) {
  return {
    pass: items.filter((i) => i.status === 'PASS').length,
    fail: items.filter((i) => i.status === 'FAIL').length,
    skip: items.filter((i) => i.status === 'SKIP').length,
    total: items.length,
  }
}

function packSuite(items) {
  return { items, summary: summarize(items) }
}

function summarizeFailed(result) {
  return result.failed.map((f) => `[${f.id}] ${f.detail}`).join('；')
}

function totalsOf(suites) {
  const t = { pass: 0, fail: 0, skip: 0, total: 0 }
  for (const suite of Object.values(suites)) {
    t.pass += suite.summary.pass
    t.fail += suite.summary.fail
    t.skip += suite.summary.skip
    t.total += suite.summary.total
  }
  return t
}

/** 收集全部失败条目（给 LLM 评审钩子）。 */
function collectFailures(report) {
  const out = []
  for (const [suiteName, suite] of Object.entries(report.suites)) {
    for (const item of suite.items) {
      if (item.status !== 'FAIL') continue
      for (const f of item.failures ?? []) {
        out.push({ suite: suiteName, item: item.id, rule: f.id, detail: f.detail })
      }
    }
  }
  return out
}

// ── 离线套件模式 ────────────────────────────────────────────────────────────

/** 一条用例的离线检查结果（好例必须全过、反例必须被抓）。 */
function caseItem(c, rules) {
  const checks = caseChecks(c)
  if (checks.goods.length === 0 && checks.bads.length === 0) {
    return {
      id: c.id, type: 'case', status: 'SKIP',
      detail: '需要活体 agent（用 --session 或把真实回复写进转录）',
      failures: [],
    }
  }
  const failures = []
  let goodOk = 0
  let badOk = 0
  for (const g of checks.goods) {
    const r = judge(g.messages, rules)
    if (r.ok) goodOk += 1
    else failures.push({ id: `${c.id}·${g.label}`, detail: summarizeFailed(r) })
  }
  for (const b of checks.bads) {
    const r = judge(b.messages, rules)
    if (!r.ok) badOk += 1
    else failures.push({ id: `${c.id}·${b.label}`, detail: `反面例子没有被任何规则抓住（判据太松）${b.note !== '' ? `：${b.note}` : ''}` })
  }
  return {
    id: c.id, type: 'case',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    detail: `好例 ${goodOk}/${checks.goods.length} 通过 · 反例 ${badOk}/${checks.bads.length} 被抓`,
    failures: failures.slice(0, 6),
  }
}

/** 一条转录的运行结果（主会话必须全过、替换进去的反例必须被抓）。 */
function transcriptItem(t, sources) {
  const rules = compileRules(sources.case, sources.extraRules)
  const parts = transcriptParts(t)
  const failures = []
  const main = judge(parts.main, rules)
  if (!main.ok) failures.push({ id: `${t.id}·主会话`, detail: summarizeFailed(main) })
  let countered = 0
  for (const c of parts.counters) {
    const r = judge(c.messages, rules)
    if (!r.ok) countered += 1
    else failures.push({ id: `${t.id}·${c.label}`, detail: `反面回复没有被抓住${c.note !== '' ? `：${c.note}` : ''}` })
  }
  return {
    id: t.id, type: 'transcript', case: t.case ?? '（自述规则）',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    detail: `回合 ${parts.main.length} 条 · 反例 ${countered}/${parts.counters.length} 被抓`,
    failures: failures.slice(0, 6),
  }
}

/** 转录目录里所有能跑起来的转录（引用的用例不在本次套件里 → 跳过）。 */
async function loadTranscriptSuite(lookup) {
  const dir = path.join(EVAL_DIR, 'transcripts')
  let names
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const t = await loadTranscript(path.join(dir, name))
    const sources = transcriptRuleSources(t, lookup)
    if (sources === null) continue
    out.push({ t, sources })
  }
  return out
}


/**
 * 记忆 60 题基准（P6e·e4）：调 `eval/memory/run.mjs`，把它的一条结论搬进报告。
 *
 * 它是**测量**不是判定：未达门槛记 `WARN`（不是 FAIL），因为这条基准第一次跑出来
 * 的一定是基线——要让 `npm run eval` 变红得显式 `node eval/memory/run.mjs --enforce`。
 * 语料不在仓库里（真实日记），所以缺语料时记 SKIP 并指路。
 */
function memoryBenchItem() {
  const script = path.join(EVAL_DIR, 'memory', 'run.mjs')
  const res = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf-8' })
  if (res.status === 2) {
    return {
      id: 'memory-60q', type: 'suite-note', status: 'SKIP',
      detail: '记忆基准需要真实语料：把工作区 memory/ 放到 eval/memory/.cache/memory，或用 --corpus 指定（见 eval/memory/README.md）',
      failures: [],
    }
  }
  let report
  try {
    report = JSON.parse(res.stdout)
  } catch {
    return { id: 'memory-60q', type: 'suite-note', status: 'FAIL', detail: `记忆基准输出读不懂：${(res.stderr ?? '').slice(0, 200)}`, failures: [] }
  }
  const ok = report.recallAtK >= report.thresholds.recallAtK
  return {
    id: 'memory-60q',
    type: 'suite-note',
    status: ok ? 'PASS' : 'WARN',
    detail: `recall@${report.k} ${report.recallAtK}（门槛 ${report.thresholds.recallAtK}）· 拒答代理 ${report.refusal.ok}/${report.refusal.total} · p95 ${report.latency.p95}ms · 注入最大 ${report.injectChars.max} 字 · ${report.activeRecords} 条记录`
      + (ok ? '' : ' —— 未达门槛：`memory.v2` 保持默认关，明细见 eval/memory/last-report.json'),
    failures: [],
  }
}

async function offlineMode(values) {
  const suiteNames = [...new Set(values.suite !== undefined && values.suite.length > 0 ? values.suite : DEFAULT_SUITES)]
  for (const name of suiteNames) {
    if (!DEFAULT_SUITES.includes(name) && name !== 'memory') {
      throw new UsageError(`未知套件 ${name}（可用：${[...DEFAULT_SUITES, 'memory'].join(' / ')}）`)
    }
  }
  const report = { mode: 'offline', suites: {} }
  const lookup = new Map()
  for (const name of suiteNames) {
    if (name === 'memory') {
      report.suites.memory = packSuite([memoryBenchItem()])
      continue
    }
    const cases = await loadCaseSuite(path.join(EVAL_DIR, name))
    const items = []
    for (const c of cases) {
      let rules
      try {
        rules = compileRules(c)
      } catch (error) {
        throw new UsageError(`${error instanceof Error ? error.message : String(error)}（${c._file}）`)
      }
      lookup.set(`${name}/${c.id}`, { suite: name, case: c, rules })
      items.push(caseItem(c, rules))
    }
    report.suites[name] = packSuite(items)
  }
  for (const { t, sources } of await loadTranscriptSuite(lookup)) {
    const item = transcriptItem(t, sources)
    if (report.suites[sources.suite] === undefined) report.suites[sources.suite] = packSuite([])
    report.suites[sources.suite].items.push(item)
    report.suites[sources.suite].summary = summarize(report.suites[sources.suite].items)
  }
  return report
}

// ── 单条转录模式 ────────────────────────────────────────────────────────────

function parseCaseRef(ref) {
  const [suite, id, ...rest] = String(ref).split('/')
  if (suite === undefined || id === undefined || rest.length > 0 || !DEFAULT_SUITES.includes(suite)) {
    throw new UsageError(`--case 要写成 <套件>/<用例>，套件限 ${DEFAULT_SUITES.join('/')}（收到 ${String(ref)}）`)
  }
  return { suite, id }
}

async function transcriptMode(values) {
  const report = { mode: 'transcript', suites: {} }
  const lookup = new Map()
  for (const file of values.transcript) {
    const t = await loadTranscript(path.resolve(file))
    if (typeof t.case === 'string') {
      const ref = parseCaseRef(t.case)
      if (!lookup.has(t.case)) {
        for (const c of await loadCaseSuite(path.join(EVAL_DIR, ref.suite))) {
          lookup.set(`${ref.suite}/${c.id}`, { suite: ref.suite, case: c, rules: compileRules(c) })
        }
      }
      if (!lookup.has(t.case)) throw new UsageError(`转录 ${t.id} 引用了不存在的用例 ${t.case}`)
    }
    const sources = transcriptRuleSources(t, lookup)
    const item = transcriptItem(t, sources)
    if (report.suites[sources.suite] === undefined) report.suites[sources.suite] = packSuite([])
    report.suites[sources.suite].items.push(item)
    report.suites[sources.suite].summary = summarize(report.suites[sources.suite].items)
  }
  return report
}

// ── 会话原件模式 ────────────────────────────────────────────────────────────

async function sessionMode(values) {
  const log = await readSessionLog({ sessionId: values.session, cwd: values.cwd, env: process.env })
  if (log === null) {
    throw new UsageError(`找不到会话 ${values.session} 的日志（DSH_SESSIONS_ROOT=${resolveSessionsRoot()}；用 --cwd 指定工作区路径）`)
  }
  const { records, badLines } = parseRecords(log.text)
  const { turns, metrics } = extractTurns(records)
  const messages = conversationFromTurns(turns)
  let rules
  let label
  if (values.case !== undefined) {
    const ref = parseCaseRef(values.case)
    const cases = await loadCaseSuite(path.join(EVAL_DIR, ref.suite))
    const c = cases.find((x) => x.id === ref.id)
    if (c === undefined) throw new UsageError(`--case ${values.case} 不存在`)
    rules = compileRules(c)
    label = values.case
  } else {
    rules = compileRules({
      id: 'live', preset: ['persona-base'],
      rules: [{ id: 'no-period', kind: 'noTrailingPeriod', reason: '不用句号结尾（人设风格）' }],
    })
    label = 'persona-base + no-period（默认；长度约束按房间不同，暂不自动判定）'
  }
  const result = judge(messages, rules)
  const item = {
    id: `session:${values.session}`, type: 'session',
    status: result.ok ? 'PASS' : 'FAIL',
    detail: `${records.length} 条记录 · ${turns.length} 轮 · 坏行 ${badLines} · 规则：${label}`,
    failures: result.failed.slice(0, 20).map((f) => ({ id: f.id, detail: f.detail })),
  }
  return {
    mode: 'session',
    suites: { session: packSuite([item]) },
    perf: { sessionId: values.session, file: log.file, frames: log.frames, skippedFrames: log.skipped, ...metrics },
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function parseCliArgs() {
  return parseArgs({
    allowPositionals: false,
    options: {
      suite: { type: 'string', multiple: true },
      transcript: { type: 'string', multiple: true },
      session: { type: 'string' },
      cwd: { type: 'string' },
      case: { type: 'string' },
      json: { type: 'boolean', default: false },
      'llm-review': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
}

async function main() {
  let values
  try {
    ;({ values } = parseCliArgs())
  } catch (error) {
    console.error(`eval: ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    return 2
  }
  if (values.help === true) {
    console.log(USAGE)
    return 0
  }
  try {
    let report
    if (values.session !== undefined) {
      report = await sessionMode(values)
    } else if (values.transcript !== undefined && values.transcript.length > 0) {
      report = await transcriptMode(values)
    } else {
      report = await offlineMode(values)
    }
    if (values['llm-review'] === true) {
      report.llmReview = await reviewWithLlm({ failures: collectFailures(report) })
    }
    report.version = 1
    report.generatedAt = new Date().toISOString()
    report.totals = totalsOf(report.suites)
    report.notes = [
      '离线判定的三级口径：好例必须全过 → 反例必须被抓 → 转录/会话复核。',
      'LLM 评审默认不跑（--llm-review 且配置 EVAL_LLM_BASE_URL 才启用），只给意见不改任何东西。',
      '性能目标（07 §5.4）是方向性的，只在对账时呈现，不自动判 PASS/FAIL。',
    ]
    await writeReportFile(path.join(EVAL_DIR, 'last-report.json'), report)
    if (values.json === true) console.log(JSON.stringify(report, null, 2))
    else console.log(renderHuman(report))
    return report.totals.fail > 0 ? 1 : 0
  } catch (error) {
    console.error(`eval: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

process.exitCode = await main()
