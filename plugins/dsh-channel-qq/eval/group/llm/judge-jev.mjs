/**
 * **本地 Jev 判断的评测**（P10）：同一批语料，走本地打分器那一路，看它判出什么。
 *
 *   node eval/group/llm/judge-jev.mjs              # 真打分器（需要 JEV_* 环境变量，见下）
 *   node eval/group/llm/judge-jev.mjs --selftest   # 假打分器：只验管道，不验准确率
 *   node eval/group/llm/judge-jev.mjs --json       # stdout 只印机读 JSON
 *   node eval/group/llm/judge-jev.mjs --case G01   # 只跑几条（可重复）
 *
 * 环境变量（`--selftest` 不需要任何一个）：
 *   JEV_SCORE_BIN     jev-score 可执行文件
 *   JEV_MODEL         GGUF 权重
 *   JEV_TOKENIZER_DIR tokenizer 目录（下面要有 tokenizer.json 与 tokenizer_config.json）
 *
 * 三条不变量（与 `run.mjs` 同源，改这个文件前先读）：
 *   1. **零发送**：这里连平台端口都不造——判断层不发东西，`speak` 那一步不接。
 *      所以"有没有发出去"这件事在本评测里根本不存在，不需要绊线。
 *   2. **不重写判断器**：九门问句、决策表、折判、渲染器全部 `import` 生产模块。
 *      这个文件里唯一的"本地逻辑"是**把语料转成 `JudgeRequest`**。
 *   3. **两段成绩分开印**：`--selftest` 是管道自检（不报准确率），真打分器那段才报。
 *      把两者合起来算一个数，会让"管道通了"看起来像"判得准"。
 *
 * 退出码：0 跑完；1 有硬失败（管道抛错 / 判定与 `exec` 冲突）；2 用法或配置问题。
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { CASES } from '../corpus.mjs'
import { renderJudgeState } from '../../../build/lib/app/inbound/judge-state.js'
import { ALL_GATES } from '../../../build/lib/config/sections/judge.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 与本机实测一致的参数（见 `docs/groups/p10-jev-judge.md` §3）。 */
const SCORER_OPTIONS = {
  contextSize: 2048,
  ubatch: 256,
  seqMax: 4,
  outputsMax: 64,
  nGpuLayers: 99,
  threads: 6,
}

/** 语料里的 `scope` 决定"判错算不算失败"。 */
const HARD_SCOPES = new Set(['code-boundary', 'pipeline'])

/**
 * 载入生产模块（`build/lib` 优先，缺了退到 `src/*.ts` + 本目录的 resolve hook）。
 *
 * 为什么允许退到源码：评测要在"还没 build"的树上也能跑；报告里会写明用了哪一条。
 */
async function loadImpl() {
  const specifiers = {
    gates: ['../../../build/lib/app/inbound/judge-gates.js', '../../../build/lib/adapters/jev/render-v1.js'],
    scorer: [
      '../../../build/lib/adapters/jev/scorer-client.js',
      '../../../build/lib/adapters/jev/scorer-protocol.js',
    ],
    verdict: ['../../../build/lib/app/inbound/judge-verdict.js'],
    local: ['../../../build/lib/adapters/jev/local-judge.js'],
  }
  const out = { source: 'build' }
  try {
    out.gates = await import(specifiers.gates[0])
    out.renderer = await import(specifiers.gates[1])
    out.scorer = await import(specifiers.scorer[0])
    out.protocol = await import(specifiers.scorer[1])
    out.verdict = await import(specifiers.verdict[0])
    out.local = await import(specifiers.local[0])
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    throw new Error('缺少构建产物：先跑 `npm run build:lib`（本评测不重复实现判断逻辑，只 import 生产模块）')
  }
  return out
}

/** 语料的一条 → `JudgeRequest`（唯一的"本地逻辑"）。 */
function requestOf(testCase) {
  const nowMs = testCase.background.at(-1)?.atMs ?? 0
  const lines = testCase.background.map((entry) => ({
    messageId: entry.messageId ?? null,
    name: entry.name ?? '',
    userId: entry.userId,
    text: entry.text,
    self: entry.self === true,
    atMs: entry.atMs,
  }))
  return {
    groupId: 1_000_000_004,
    lines,
    state: renderJudgeState(
      testCase.background.map((entry) => ({
        messageId: entry.messageId ?? null,
        name: entry.name ?? '',
        userId: entry.userId,
        text: entry.text,
        self: entry.self === true,
        atMs: entry.atMs,
      })),
      '2026-11-08 22:00',
    ),
    nowMs,
    replyMaxChars: 70,
    windowMs: 600_000,
  }
}

/**
 * 假打分器：返回**确定性**的 logit，只证明管道能跑通（不证明判得准）。
 *
 * 分数按问句的**位置**给：前三门（`tech_issue` / `help_open` / `one_to_one`）判 true，
 * 其余 false；短语四项按位置给不同的概率，其中一项**刻意低于门槛**——
 * 自检要覆盖"低置信度 → 不说话"那条分支，否则最保守的那条路径从来没被执行过。
 */
function fakeScorer() {
  return {
    info: () => ({ desc: 'fake', nCtx: 2048, nSeqMax: 4, nUbatch: 256, loadMs: 0, systemInfo: 'CPU : SSE3 = 1' }),
    async close() { /* 没有进程 */ },
    async score(input) {
      // 每道问句的 `slots` 一个槽位一个选项（`noul` 是 `[false, true]`，`choice` 按选项顺序）。
      // 打分器只给每个槽位的 `yes` / `no` 两行 logit，所以"选中某个选项"= 在那个槽位上让
      // `yes - no` 明显为正、其余槽位明显为负。
      const results = input.questions.map((question, index) => question.slots.map((_slot, position) => {
        if (index < 9) {
          // 九门：前三门（tech_issue / help_open / one_to_one）要成立，其余不成立。
          const wantTrue = index < 3
          const chosen = wantTrue ? 1 : 0
          return position === chosen ? [2.0, -2.0] : [-2.0, 2.0]
        }
        if (index === 10) {
          // 第三个短语库（`casual`）刻意给一个**低置信度**的分数：自检要覆盖
          // "短语没把握 → 这一轮不说"那条分支，否则最保守的路径从来没被执行过。
          return [-0.05, 0.05]
        }
        // 其余短语库与目标：第一个选项胜出。
        return position === 0 ? [2.0, -2.0] : [-2.0, 2.0]
      }))
      return { kind: 'scores', results, totalMs: 0 }
    },
  }
}

/** 真打分器（按环境变量装配）。 */
async function realScorer(impl) {
  const { JEV_SCORE_BIN: bin, JEV_MODEL: model, JEV_TOKENIZER_DIR: tokenizerDir } = process.env
  if (bin === undefined || model === undefined || tokenizerDir === undefined) {
    return null
  }
  const { readFileSync } = await import('node:fs')
  const { Tokenizer } = await import('@huggingface/tokenizers')
  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(path.join(tokenizerDir, 'tokenizer.json'), 'utf8')),
    JSON.parse(readFileSync(path.join(tokenizerDir, 'tokenizer_config.json'), 'utf8')),
  )
  const readoutConfig = JSON.parse(readFileSync(path.join(path.dirname(model), 'readout_config.json'), 'utf8'))
  const renderer = impl.renderer.createRenderer(tokenizer, impl.renderer.readoutOf(readoutConfig))
  renderer.verify()
  return {
    renderer,
    temperature: 0.8800546821789332,
    scorer: impl.scorer.createScorerClient(
      { binaryPath: bin, modelPath: model, ...SCORER_OPTIONS },
      undefined,
    ),
  }
}

/**
 * **净效果**：这一轮群里到底有没有多出一句话。
 *
 * 语料里的 `expect.exec` 有三种（`send` / `silent` / `block`），但 `block` 是
 * **给"模型提了一个坏建议、被代码拦下"这类用例**写的——那条路径的前提是"有个模型输出"。
 * 本地 Jev 这一路不接收模型输出（判断与决断是同一个函数），所以它永远不会"提出坏建议再被拦"。
 *
 * 于是比对只能在**净效果**层面做：`send` = 多一句话，`silent`/`block` = 没有多话。
 * 这不是把标准放松——`code-boundary` 那些用例真正要守的是"这一轮不许说话"
 * （隐私、吵架、越界引用、超长正文），而"没说话"就是守住了。
 * 报告里会把两类分开印，读者能看出哪几条是"表达能力差异"而不是"守没守住"。
 */
function netOf(exec) {
  return exec === 'send' ? 'send' : 'no-send'
}
function execOf(verdict, settings) {
  if (verdict.kind === 'no-route') return { exec: 'block', why: `no-route:${verdict.detail}` }
  if (verdict.kind === 'invalid') return { exec: 'block', why: `invalid:${verdict.reason}` }
  if (verdict.action === 'silent') return { exec: 'silent', why: verdict.reason }
  if (verdict.action === 'observe') return { exec: 'silent', why: `${verdict.reason}（observe）` }
  const chars = [...verdict.text].length
  if (chars > settings.replyMaxChars) return { exec: 'block', why: `too-long:${String(chars)}` }
  if (verdict.text.includes('@') || /\[cq:/i.test(verdict.text)) return { exec: 'block', why: 'mention' }
  return { exec: 'send', why: `${verdict.action}:${verdict.reason}` }
}

/** 跑一条。 */
async function runCase(testCase, build, clock, selftest) {
  const port = build.port
  const request = requestOf(testCase)
  const verdict = await port.decide(request)
  const outcome = execOf(verdict, { replyMaxChars: request.replyMaxChars })
  const target = verdict.kind === 'decision' && 'targetMessageId' in verdict ? verdict.targetMessageId : null
  const expected = testCase.expect ?? {}
  const problems = []
  // 假打分器的分数是哈希出来的，**它的判定与语料标注一定对不上**——那不是缺陷，
  // 而是"假打分器不代表模型的判断力"。所以自检模式只把差异列出来，不当硬失败：
  // 自检要证明的是"管道能跑到折判、折判没崩"，不是"判得准"。
  if (selftest) {
    return {
      id: testCase.id, scene: testCase.scene, scope: testCase.scope,
      expect: expected.exec, got: outcome.exec, why: outcome.why,
      action: verdict.kind === 'decision' ? verdict.action : verdict.kind,
      target, hard: false, problems, informational: true,
    }
  }
  // 只有 `code-boundary` / `pipeline` 的"这一轮有没有多话"是硬断言；`model-judgment`
  // 判错只记 WARN（那是模型该不该这么说的问题，不是代码兜不兜得住的问题）。
  if (HARD_SCOPES.has(testCase.scope ?? '') && expected.exec !== undefined
    && netOf(expected.exec) !== netOf(outcome.exec)) {
    problems.push(`净效果 ${netOf(outcome.exec)} ≠ 期望 ${netOf(expected.exec)}（${outcome.why}）`)
  }
  if (expected.silence === true && outcome.exec === 'send') problems.push('这条要求整轮不发，但判成了要发')
  if (expected.targetMessageId !== null && expected.targetMessageId !== undefined
    && outcome.exec === 'send' && expected.action === 'reply' && target !== expected.targetMessageId) {
    problems.push(`引用 #${String(target)} ≠ 期望 #${String(expected.targetMessageId)}`)
  }
  return {
    id: testCase.id,
    scene: testCase.scene,
    scope: testCase.scope,
    expect: expected.exec,
    got: outcome.exec,
    why: outcome.why,
    action: verdict.kind === 'decision' ? verdict.action : verdict.kind,
    target,
    hard: problems.length > 0,
    problems,
  }
}

const { values } = parseArgs({
  options: {
    selftest: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    case: { type: 'string', multiple: true },
    repeat: { type: 'string' },
  },
})

const impl = await loadImpl()
const wanted = values.case ?? []
const selected = wanted.length > 0 ? CASES.filter((item) => wanted.includes(item.id)) : CASES
if (selected.length === 0) {
  console.error(`没有匹配的用例：\$\{wanted.join(', ')\}`)
  process.exit(2)
}

// 依赖全部现造：假打分器不碰 GPU，真打分器第一次会 spawn（约 0.9 秒）。
const clock = { now: () => Date.now(), date: () => new Date(), setTimeout: (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(handle) }
}, setInterval: (fn, ms) => {
  const handle = setInterval(fn, ms)
  return { cancel: () => clearInterval(handle) }
} }

const real = values.selftest ? null : await realScorer(impl)
if (!values.selftest && real === null) {
  console.error('没配 JEV_SCORE_BIN / JEV_MODEL / JEV_TOKENIZER_DIR。')
  console.error('要么按 `deploy/jev-server/README.md` 装好再跑，要么加 --selftest 只验管道。')
  process.exit(2)
}

const build = {
  port: impl.local.createLocalJudge({
    scorer: values.selftest ? fakeScorer() : real.scorer,
    renderer: values.selftest ? null : real.renderer,
    temperature: real?.temperature ?? 1,
    clock,
    log: () => { /* 评测不打印生产日志 */ },
    timeoutMs: 3_000,
    gates: impl.gates.parseGateList(ALL_GATES),
    limits: { phraseMinProbability: 0.3, replyMaxChars: 70, windowMs: 600_000 },
    targetWindow: 12,
    ...(values.selftest
      ? {
        // 假打分器没有渲染器：用一个直通渲染器（把状态与问句拼成 id 数组）。
        renderer: fakeRenderer(),
      }
      : {}),
  }),
}

/** 假渲染器：`ids` 只用长度参与打分，所以"渲染"退化成确定性编号。 */
function fakeRenderer() {
  const encode = (text) => [...text].map((ch) => ch.codePointAt(0) % 1000)
  return {
    rows: [9542, 874],
    verify() { /* 无需校验 */ },
    prefixIds: (state) => encode(state),
    render(state, question) {
      const names = Object.keys(question.crit ?? {}).length > 0
        ? Object.keys(question.crit)
        : (question.t === 'noul' ? ['false', 'true'] : ['0', '1', '2'])
      const ids = [...encode(state), ...encode(question.ins)]
      const slots = names.map((_, index) => ids.length + index)
      return { ids: [...ids, ...names.map(() => 0)], prefixLen: ids.length, slots, names, headTokens: names.length }
    },
  }
}

const rows = []
for (const testCase of selected) {
  const repeat = Math.max(1, Number(values.repeat ?? 1) || 1)
  for (let index = 0; index < repeat; index++) {
    try {
      rows.push(await runCase(testCase, build, clock, values.selftest))
    } catch (error) {
      rows.push({
        id: testCase.id, scene: testCase.scene, scope: testCase.scope,
        expect: testCase.expect?.exec, got: 'throw', why: String(error), action: 'throw', target: null,
        hard: true, problems: [`抛错：${String(error)}`],
      })
    }
  }
}
if (real !== null) await real.scorer.close()

const hard = rows.filter((row) => row.hard)
const summary = {
  mode: values.selftest ? 'selftest（假打分器，只验管道）' : 'real（本地 Jev 打分器）',
  cases: rows.length,
  hardFailures: hard.length,
  /** 只有真打分器那一段才有意义；`--selftest` 下不报这个数。 */
  execMatches: values.selftest ? null : rows.filter((row) => row.got === row.expect).length,
}

if (values.json) {
  console.log(JSON.stringify({ summary, rows }, null, 2))
} else {
  console.log(`\n${summary.mode}：${String(summary.cases)} 条，硬失败 ${String(summary.hardFailures)}`)
  if (summary.execMatches !== null) {
    console.log(`执行结论与人工标注一致：${String(summary.execMatches)}/${String(summary.cases)}`)
  } else {
    console.log('（假打分器模式：不报准确率——它只证明"管道能跑到折判"）')
  }
  for (const row of rows) {
    const mark = row.hard ? '✖' : (row.got === row.expect ? '✔' : '·')
    console.log(`  ${mark} ${row.id} [${row.scope}] 期望 ${String(row.expect)} → ${row.got}（${row.why}）`)
    for (const problem of row.problems) console.log(`      ${problem}`)
  }
}

process.exit(summary.hardFailures === 0 ? 0 : 1)
