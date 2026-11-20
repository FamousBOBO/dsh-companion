/**
 * **用真实私聊消息测本地 Jev 判断**（P10 收尾）。
 *
 *   node eval/group/llm/judge-jev-real.mjs [--limit N] [--window 6] [--json]
 *
 * 输入不是人造语料，而是**从真实 QQ 私聊里抽出来的原话**
 * （`E:\llm-eval\dm-lines.json`，1040 条去重后的消息行；不进仓库，含用户原话）。
 *
 * 为什么值得单独跑：`judge-jev.mjs` 那份语料是给**生成式**判断写的，期望
 * "回一句具体的话"，而本地 Jev 只能从 13 条短语里选——那份语料上它注定低分
 * （表达能力差异，不是判断力差异，见 `docs/groups/p10-jev-judge.md` §3.1）。
 * 真实消息上没有这个问题：这里只问"这一轮该不该说话"。
 *
 * 口径：
 *   1. **一轮 = 最近 N 条真实消息**（默认 6 条，私聊"你一句我一句"的节奏）。
 *      按 1 条滑动，所以 1040 条 → 1034 轮；
 *   2. **不比对文案**：只统计九门各判成什么、动作分布、理由分布；
 *   3. **真打分器 + 生产装配**：`createRenderer` / `createScorerClient` /
 *      `createLocalJudge` / `ruleTable` / `foldVerdict` 全部 import，不重写。
 *      门的事实值靠包一层 `scorer.score` 把原始 logit 截下来再自己算概率
 *      （`probabilitiesOf` 没导出，这里按同一条公式复算）。
 *
 * 退出码：0 跑完；2 缺环境变量或资产。
 */

import * as path from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  GATE_ORDER,
  gateFactsFrom,
  ruleTable,
} from '../../../build/lib/app/inbound/judge-gates.js'
import { renderJudgeState } from '../../../build/lib/app/inbound/judge-state.js'
import { createRenderer, readoutOf } from '../../../build/lib/adapters/jev/render-v1.js'
import { createScorerClient } from '../../../build/lib/adapters/jev/scorer-client.js'
import { createLocalJudge } from '../../../build/lib/adapters/jev/local-judge.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/**
 * 真实消息语料。默认读 `dm-lines.local.json`（与脚本同目录；已在 `.gitignore` 里，
 * 含用户原话，绝不入库）。换一份用 `JEV_REAL_CORPUS` 覆盖绝对路径。
 */
const CORPUS = process.env['JEV_REAL_CORPUS'] ?? path.resolve(HERE, 'dm-lines.local.json')

const SCORER_OPTIONS = {
  contextSize: 2048, ubatch: 256, seqMax: 4, outputsMax: 64, nGpuLayers: 99, threads: 6,
}
const TEMPERATURE = 0.8800546821789332
const FIXED_NOW = 1_792_000_000_000
/**
 * 时钟：判断本身不读时间，但打分器的**超时**要用 `setTimeout`——所以必须给全套。
 * 这里用生产那份 `systemClock`（`ports/clock.ts` 里就有），只把 `now()` 钉死，
 * 好让区间可重放。
 */
function fixedClock() {
  const now = () => FIXED_NOW
  return {
    now,
    date: () => new Date(FIXED_NOW),
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(handle), unref: () => handle.unref() }
    },
    setInterval: (fn, ms) => {
      const handle = setInterval(fn, ms)
      return { cancel: () => clearInterval(handle), unref: () => handle.unref() }
    },
  }
}
const clock = fixedClock()

/** 一条语料行 → `JudgeLine`（私聊只有一个发送者，消息号按序合成）。 */
function linesOf(rows) {
  return rows.map((row, index) => ({
    messageId: 900_000 + index,
    name: row.name,
    userId: row.uid,
    text: row.body,
    self: false,
    atMs: FIXED_NOW - (rows.length - index) * 60_000,
  }))
}

/** 与 `probabilitiesOf` 同一条公式（softmax over (yes-no)/T），但**统一报 `true` 的概率**。
 *
 * 为什么不是报"选中项的概率"：选中项多半是 `false`，那个 0.88 会让人以为
 * "这门的概率很高"——恰恰相反，它意味着 `p(true)=0.12`。余量要对着 0.5 看。
 */
function trueProbabilityOf(rows) {
  const scores = rows.map((row) => (row[0] - row[1]) / TEMPERATURE)
  const top = Math.max(...scores)
  const exps = scores.map((score) => Math.exp(score - top))
  const total = exps.reduce((sum, value) => sum + value, 0)
  return exps[1] / total
}

async function build() {
  const bin = process.env['JEV_SCORE_BIN']
  const model = process.env['JEV_MODEL']
  const tokenizerDir = process.env['JEV_TOKENIZER_DIR']
  if (bin === undefined || model === undefined || tokenizerDir === undefined) {
    console.error('缺环境变量：JEV_SCORE_BIN / JEV_MODEL / JEV_TOKENIZER_DIR')
    process.exit(2)
  }
  const tokenizer = new (await import('@huggingface/tokenizers')).Tokenizer(
    JSON.parse(readFileSync(path.join(tokenizerDir, 'tokenizer.json'), 'utf8')),
    JSON.parse(readFileSync(path.join(tokenizerDir, 'tokenizer_config.json'), 'utf8')),
  )
  const renderer = createRenderer(tokenizer, readoutOf(
    JSON.parse(readFileSync(path.join(path.dirname(model), 'readout_config.json'), 'utf8')),
  ))
  renderer.verify()
  const inner = createScorerClient({ binaryPath: bin, modelPath: model, ...SCORER_OPTIONS }, undefined)
  /** 抓一次打分的原始结果（门的概率要自己数，`probabilitiesOf` 没导出）。 */
  const captured = { gates: null }
  const scorer = {
    info: () => inner.info(),
    close: () => inner.close(),
    async score(input) {
      const outcome = await inner.score(input)
      if (outcome.kind === 'scores') {
        const gates = {}
        input.questions.forEach((question, index) => {
          const id = GATE_ORDER[index]
          if (id === undefined) return
          const rows = outcome.results[index]
          if (rows === undefined) return
          const probability = trueProbabilityOf(rows)
          gates[id] = { answer: probability >= 0.5 ? 'true' : 'false', probability }
        })
        captured.gates = gates
      }
      return outcome
    },
  }
  const judge = createLocalJudge({
    scorer, renderer, temperature: TEMPERATURE, clock,
    log: () => { /* 静默 */ },
    timeoutMs: 3000,
    gates: [...GATE_ORDER],
    limits: { phraseMinProbability: 0.3, replyMaxChars: 70, windowMs: 600_000 },
    targetWindow: 6,
  })
  return { judge, inner, captured }
}

async function judgeOne(judge, captured, rows) {
  const lines = linesOf(rows)
  const state = renderJudgeState(lines, '20:00')
  captured.gates = null
  const verdict = await judge.decide({
    groupId: 1_000_000_004, lines, state,
    nowMs: FIXED_NOW, replyMaxChars: 70, windowMs: 600_000, selfId: 2_668_517_323,
  })
  return { verdict, gates: captured.gates, state }
}

/** Windows 上 `file://C:\...` 不是合法 URL，必须走 `pathToFileURL`。 */
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string', default: '0' },
      window: { type: 'string', default: '6' },
      json: { type: 'boolean', default: false },
      dump: { type: 'string', default: '' },
    },
  })
  if (!existsSync(CORPUS)) {
    console.error(`语料不存在：${CORPUS}（先用 _dm_lines.py 抽一遍）`)
    process.exit(2)
  }
  const all = JSON.parse(readFileSync(CORPUS, 'utf8'))
  const windowSize = Number(values.window)
  const total = all.length - windowSize + 1
  const limit = Number(values.limit) > 0 ? Math.min(Number(values.limit), total) : total

  const { judge, inner, captured } = await build()
  // 第一次打分之后进程才 ready，所以 info 要等跑完再读（前面先占位）。
  const infoPlaceholder = { desc: '' }
  const rounds = []
  const started = Date.now()
  for (let start = 0; start < limit; start++) {
    rounds.push({ start, ...(await judgeOne(judge, captured, all.slice(start, start + windowSize))) })
  }
  const elapsed = Date.now() - started
  infoPlaceholder.desc = inner.info()?.desc ?? ''

  const actions = {}
  const reasons = {}
  const gateTrue = {}
  const gateProb = {}
  for (const round of rounds) {
    const v = round.verdict
    const key = v.kind === 'decision' ? v.action : v.kind
    actions[key] = (actions[key] ?? 0) + 1
    if (v.kind === 'decision') {
      const why = v.reason.split(':')[0]
      reasons[why] = (reasons[why] ?? 0) + 1
    }
    for (const [id, scored] of Object.entries(round.gates ?? {})) {
      gateProb[id] = gateProb[id] ?? []
      gateProb[id].push(scored.probability)
      if (scored.answer === 'true') gateTrue[id] = (gateTrue[id] ?? 0) + 1
    }
  }
  const gateStats = GATE_ORDER.map((id) => {
    const probs = (gateProb[id] ?? []).sort((a, b) => a - b)
    const p50 = probs.length ? probs[Math.floor(probs.length / 2)] : 0
    return {
      id,
      trueRate: rounds.length ? (gateTrue[id] ?? 0) / rounds.length : 0,
      trueCount: gateTrue[id] ?? 0,
      trueProbP50: Number(p50.toFixed(3)),
      marginToHalf: Number((p50 - 0.5).toFixed(3)),
    }
  })

  const report = {
    corpus: CORPUS,
    corpusSize: all.length,
    rounds: rounds.length,
    window: windowSize,
    elapsedMs: elapsed,
    perRoundMs: Math.round(elapsed / Math.max(1, rounds.length)),
    scorerInfo: infoPlaceholder,
    actions,
    reasons,
    gates: gateStats,
  }
  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`真实私聊语料 ${all.length} 条 → 判 ${report.rounds} 轮（窗口 ${windowSize} 条，1 条滑动）`)
    console.log(`打分器 ${infoPlaceholder.desc || '?'}｜总 ${elapsed} ms｜平均 ${report.perRoundMs} ms/轮\n`)
    console.log(`动作分布 ${JSON.stringify(actions)}`)
    console.log(`理由分布 ${JSON.stringify(reasons)}\n`)
    console.log('九门（判 true 的比例 / p(true) 中位数 / 离 0.5 的余量）：')
    for (const gate of gateStats) {
      console.log(`  ${gate.id.padEnd(12)} ${(gate.trueRate * 100).toFixed(0).padStart(3)}%  `
        + `p(true) p50 ${gate.trueProbP50.toFixed(3)}  `
        + `余量 ${gate.marginToHalf >= 0 ? '+' : ''}${gate.marginToHalf}`)
    }
  }
  if (values.dump !== '') {
    writeFileSync(values.dump, JSON.stringify(rounds, null, 1), 'utf8')
    console.log(`已写入 ${values.dump}`)
  }
  await inner.close()
}
