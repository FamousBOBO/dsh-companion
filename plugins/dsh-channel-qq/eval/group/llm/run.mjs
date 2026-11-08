/**
 * **真实模型影子评测**（P5-C / 计划 §2.3、§9 任务 04）。
 *
 *   node eval/group/llm/run.mjs                  # 真实模型 + 零 QQ 发送（需要 EVAL_GROUP_LLM_*）
 *   node eval/group/llm/run.mjs --selftest       # 本地假 OpenAI 服务，全流程自测（不联网、不要 key）
 *   node eval/group/llm/run.mjs --json           # stdout 只印机读 JSON
 *   node eval/group/llm/run.mjs --case G06       # 只跑几条（可重复）
 *   node eval/group/llm/run.mjs --no-offline     # 只出真实模型那一段（不引用离线报告）
 *   node eval/group/llm/run.mjs --repeat 3       # 同一条跑 3 次，报告采样波动
 *
 * 三条不变量（改动前先读）：
 *   1. **零发送**：平台端口是绊线（`port.mjs`）。任何一次 `sendGroupMessage` / `sendPrivateMessage` /
 *      `sendTo` 调用都先记账再抛错，该条示例记 HARD FAIL；退出码 1。
 *   2. **不重写判断器**：提示词、解析、校验、限频全部 `import` 生产模块（`impl.mjs`）。这个目录里
 *      没有本地的判定规则，连"这句话像不像该发"都不判——那要人来评，方法见 README。
 *   3. **两段成绩分开印**：离线回放与真实模型各自一段，不给合计准确率。
 *
 * 退出码：0 跑完且没有硬失败；1 有硬失败（绊线被触发 / 出现真实发送）；2 用法或配置问题
 * （含"没配 `EVAL_GROUP_LLM_BASE_URL`"——那不是失败，是没打算跑）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { CASES } from '../corpus.mjs'
import { NOT_CONFIGURED_LINES, ENV, describeConfig, readConfig } from './env.mjs'
import { loadPersona, personaSummary } from './persona.mjs'
import { FAKE_GROUP_ID, tripwireSelfTest } from './port.mjs'
import { IMPL, probeShadowGate } from './impl.mjs'
import { runCorpus, settingsOf } from './pipeline.mjs'
import { aggregate } from './record.mjs'
import { renderHuman } from './render.mjs'
import { serveForever, startFakeServer } from './fake-server.mjs'
import { runTripSelfTest, selftestChecksOf, selftestErrorPaths, selftestTripSafety } from './selftest.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPORT_JSON = path.join(HERE, 'out', 'report.json')
const REPORT_MD = path.join(HERE, 'out', 'report.md')
const REPORT_JSONL = path.join(HERE, 'out', 'cases.jsonl')
const OFFLINE_REPORT = path.join(HERE, '..', 'last-report.json')

/** 用法或配置问题（退出码 2）。 */
class UsageError extends Error {}

const USAGE = [
  '群聊社交 · 真实模型影子评测 · eval/group/llm/run.mjs',
  '',
  '用法：',
  '  node eval/group/llm/run.mjs               真实模型（需要 EVAL_GROUP_LLM_BASE_URL）',
  '  node eval/group/llm/run.mjs --selftest    本地假 OpenAI 服务跑全流程（不联网）',
  '  node eval/group/llm/run.mjs --json        机读输出（stdout 纯 JSON）',
  '  node eval/group/llm/run.mjs --case G06    只跑几条（可重复）',
  '  node eval/group/llm/run.mjs --repeat 3    同一条跑 3 次（观察采样波动）',
  '  node eval/group/llm/run.mjs --no-offline  不引用离线通道的报告',
  '  node eval/group/llm/run.mjs --out <目录>  报告落盘目录（默认 eval/group/llm/out/）',
  '  node eval/group/llm/run.mjs --persona-file <文件>  指定人格文件（默认按套件顺序找）',
  '  node eval/group/llm/run.mjs --channel composed  强制走组合通道（诊断用）',
  '  node eval/group/llm/run.mjs --dump-prompts  把生产提示词全文写到 out/prompts/（本地受控）',
  '  node eval/group/llm/run.mjs --serve-fake [--port N]  起本地假 OpenAI 服务并挂住（演练用）',
  '',
  '退出码：0 跑完 · 1 有硬失败（真实发送/绊线被触发）· 2 用法或配置问题（含未配置端点）。',
  '本通道**永不发送 QQ 消息**：平台端口是绊线，任何发送调用都会抛错并被记成 HARD FAIL。',
  '',
].join('\n')

/** 解析命令行。 */
function parseCli() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      json: { type: 'boolean', default: false },
      selftest: { type: 'boolean', default: false },
      case: { type: 'string', multiple: true },
      repeat: { type: 'string' },
      'no-offline': { type: 'boolean', default: false },
      out: { type: 'string' },
      'persona-file': { type: 'string' },
      'selftest-trip': { type: 'boolean', default: false },
      channel: { type: 'string' },
      'serve-fake': { type: 'boolean', default: false },
      port: { type: 'string' },
      'dump-prompts': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  return values
}

/** 尽快读出离线通道的报告（`--no-offline` 或不给就看它存不存在；绝不重跑它）。 */
async function readOfflineReport({ disabled }) {
  if (disabled) return { report: null, failure: '（--no-offline：按要求不引用离线报告）' }
  try {
    const text = await readFile(OFFLINE_REPORT, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed?.mode !== 'offline-replay') return { report: null, failure: '离线报告不是离线回放格式' }
    return { report: parsed, failure: '' }
  } catch {
    return {
      report: null,
      failure: `离线报告读不到（${path.relative(process.cwd(), OFFLINE_REPORT)}）：先跑 npm run eval:group`,
    }
  }
}

/** 把 JS 值写成 JSONL（一条一行；绝不把整份数组 prettify 进一行）。 */
function toJsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

/** 汇总硬失败：绊线 / 真实发送 / 运行器自身的绊线自测没过。 */
function hardFailsOf({ trips, records, tripwireOk }) {
  const fails = []
  if (!tripwireOk) fails.push('绊线自测没通过：平台端口没有拦住发送调用')
  for (const trip of trips) fails.push(`${trip.caseId}：绊线被触发——${trip.method}（影子运行里出现了真实发送调用）`)
  for (const record of records) {
    if (record.execution === 'spoke') fails.push(`${record.sceneId}：平台真的返回了回执（execution=spoke）`)
  }
  return fails
}

/**
 * 选通道：默认按探测结果自动选；`--channel` 可以强制（诊断用）。
 *
 * 强制成 `presence-cycle` 而闸门不在，运行器会**拒绝**：那等于让 41 条用例各踩一次绊线。
 */
function resolveChannel(requested, gateProbe) {
  const auto = gateProbe.supported
    ? { mode: 'presence-cycle', detail: gateProbe.detail }
    : { mode: 'composed', detail: gateProbe.detail }
  if (requested === undefined) return auto
  if (requested !== 'presence-cycle' && requested !== 'composed') {
    throw new UsageError('--channel 只能是 presence-cycle 或 composed')
  }
  if (requested === 'presence-cycle' && !gateProbe.supported) {
    throw new UsageError('--channel presence-cycle 不可用：' + gateProbe.detail)
  }
  return { mode: requested, detail: requested === auto.mode ? gateProbe.detail : `--channel 强制为 ${requested}` }
}

/** 报告里的"已知边界"（照 `eval/group/README.md` 的口径，不自创证据级别）。 */
const NOTES = Object.freeze([
  '这是 real-api 证据：提示词、解析、校验、限频都是线上那一份；但它**不是** real-send（平台端口是绊线，一次都没放行）。',
  '没有真人盲评：报告只给可复核的计数与原始输出，不给"插话准确率"——那需要人看 41 段对话后标"该不该发"。',
  '语料仍是离线那 41 条（人工构造、虚构群号），不是真实群导出；扩到真实多人对话要另立语料并取得授权。',
  '同一条只跑 1 次时看不出采样波动（EVAL_GROUP_LLM_REPEAT>1 才有比较，且那也只是**报告**，不消除非确定性）。',
  '影子闸门与线上同一条路径（deps.sendGate 每次现取）；通道降级为 composed 时见报告里的 channel 说明。',
])


async function main() {
  let values
  try {
    values = parseCli()
  } catch (error) {
    console.error('group-llm-eval: ' + String(error instanceof Error ? error.message : error))
    console.error(USAGE)
    return 2
  }
  if (values.help === true) {
    console.log(USAGE)
    return 0
  }

  // --serve-fake：起一个本地假 OpenAI 服务并挂住，供"用环境变量指向假服务"的手工演练。
  // 用法：一个终端跑 `node eval/group/llm/run.mjs --serve-fake`，另一个终端把
  // EVAL_GROUP_LLM_BASE_URL 指到它打印的地址，再跑 `node eval/group/llm/run.mjs`。
  if (values['serve-fake'] === true) {
    const port = Number(values.port ?? '0')
    await serveForever({ port: Number.isFinite(port) ? port : 0, mode: 'mixed' })
    return 0
  }

  // 隐藏开关：绊线端到端自测（由 --selftest 在子进程里调用，不面向人）。
  // 期望**退出码 1**：它故意走到发送路径上，好证明绊线真的拦得住。
  if (values['selftest-trip'] === true) {
    process.exitCode = await runTripSelfTest()
    return process.exitCode
  }

  // 绊线自测先跑：平台端口拦不住发送时，后面所有"零发送"的说法都不成立。
  const tripwire = tripwireSelfTest()
  if (!tripwire.ok) {
    console.error('group-llm-eval: 绊线自测没通过，拒绝运行（平台端口没有拦住发送调用）。')
    console.error(JSON.stringify(tripwire, null, 2))
    return 1
  }

  // 配置：--selftest 用本地假服务；否则只认环境变量，没配就退出码 2 + 说明。
  let config
  let fakeServer = null
  let selftestHead = null
  if (values.selftest === true) {
    fakeServer = await startFakeServer({ port: 0, mode: 'mixed' })
    const base = readConfig({
      [ENV.baseUrl]: fakeServer.url,
      [ENV.model]: 'selftest-fake',
      [ENV.repeat]: values.repeat ?? '1',
      [ENV.timeoutMs]: '5000',
    })
    config = base.config
    selftestHead = {
      mode: 'selftest',
      fakeEndpoint: fakeServer.origin,
      note: '本地假 OpenAI 服务（127.0.0.1 随机端口）；不是真实模型，输出是按序号轮换的固定形态。',
    }
  } else {
    const read = readConfig(process.env)
    if (!read.ok) {
      console.log(NOT_CONFIGURED_LINES.join('\n'))
      console.log('')
      console.log('配置问题：' + read.problems.join('；'))
      return 2
    }
    config = read.config
    if (values.repeat !== undefined) {
      const parsed = Number(values.repeat)
      if (!Number.isFinite(parsed) || parsed < 1) throw new UsageError('--repeat 必须是 ≥1 的整数')
      config = { ...config, repeat: Math.min(20, Math.trunc(parsed)) }
    }
  }
  if (values.out !== undefined) config = { ...config, outDir: values.out }

  try {
    const wanted = values.case === undefined || values.case.length === 0
      ? CASES
      : CASES.filter((c) => values.case.includes(c.id))
    if (wanted.length === 0) throw new UsageError('--case 没匹配到任何用例：' + values.case.join(','))

    const persona = await loadPersona({ personaFile: values['persona-file'] ?? '', personaId: '' })
    const gateProbe = await probeShadowGate()
    const channel = resolveChannel(values.channel, gateProbe)

    const run = await runCorpus({ cases: wanted, config, persona, channel })
    const records = run.records
    /** 每条示例的重复结果（Map 保持语料顺序）。 */
    const stabilityByCase = new Map(run.stability.map((item) => [item.sceneId, item.stability]))
    const agg = aggregate(records, { tripwireTrips: run.trips.length, config, prices: config.prices })
    const offline = await readOfflineReport({ disabled: values['no-offline'] === true })
    if (offline.report !== null && wanted.length !== CASES.length) {
      offline.note = `离线报告是整批（${String(CASES.length)} 条）的成绩，本次只跑了 ${String(wanted.length)} 条；两段的分母不同，不要横向比。`
    }
    const hardFails = hardFailsOf({ trips: run.trips, records, tripwireOk: tripwire.ok })

    const outDir = path.isAbsolute(config.outDir) ? config.outDir : path.join(HERE, config.outDir)
    await mkdir(outDir, { recursive: true })
    const reportJsonPath = path.join(outDir, path.basename(REPORT_JSON))
    const reportMdPath = path.join(outDir, path.basename(REPORT_MD))
    const jsonlPath = path.join(outDir, path.basename(REPORT_JSONL))

    const report = {
      version: 1,
      mode: 'llm-shadow',
      generatedAt: new Date().toISOString(),
      impl: { source: IMPL.source, promptModule: 'app/inbound/group-social-prompt', decisionModule: IMPL.decisionModule, flowModule: IMPL.flowModule },
      channel,
      config: describeConfig(config),
      persona: personaSummary(persona),
      defaults: settingsOf(),
      selftest: selftestHead,
      safety: {
        fakeGroupId: FAKE_GROUP_ID,
        tripwireTrips: run.trips.length,
        blockedCalls: run.trips.length,
        liveSends: records.filter((record) => record.execution === 'spoke').length,
        tripwireSelfTest: tripwire,
      },
      real: {
        aggregate: agg,
        cases: [...stabilityByCase.entries()].map(([sceneId, item]) => {
          const first = records.find((record) => record.sceneId === sceneId)
          return {
            sceneId,
            scene: first.scene,
            inputHash: first.inputHash,
            tier: first.tier,
            action: first.action,
            execution: first.execution,
            executionKind: first.executionKind,
            veto: first.veto,
            target: first.target,
            latencyMs: first.latencyMs,
            tokens: first.tokens,
            cost: first.cost,
            rawOutput: first.rawOutput,
            tripwire: records.some((record) => record.sceneId === sceneId && record.tripwire === true),
            stability: item,
          }
        }),
        stability: [...stabilityByCase.entries()].map(([sceneId, item]) => ({ sceneId, scene: records.find((record) => record.sceneId === sceneId).scene, ...item })),
      },
      offline,
      hardFails,
      totals: { runs: records.length, hardFails: hardFails.length, cases: wanted.length },
      notes: NOTES,
    }
    report.files = {
      reportJson: path.relative(process.cwd(), reportJsonPath) || reportJsonPath,
      reportMd: path.relative(process.cwd(), reportMdPath) || reportMdPath,
      casesJsonl: path.relative(process.cwd(), jsonlPath) || jsonlPath,
    }
    const selftestChecks = selftestHead === null ? [] : selftestChecksOf({ records, wanted, trips: run.trips, files: report.files })
    if (selftestHead !== null) report.selftest = { ...selftestHead, checks: selftestChecks }

    if (values['dump-prompts'] === true) {
      // 原始样本（生产提示词全文）写本地受控目录：**只在显式要求时**写，且不进 JSONL。
      await mkdir(path.join(outDir, 'prompts'), { recursive: true })
      const promptFile = path.join(outDir, 'prompts', 'prompts.jsonl')
      await writeFile(promptFile, run.prompts.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8')
      report.files.prompts = path.relative(process.cwd(), promptFile) || promptFile
    }

    const human = renderHuman(report)
    await writeFile(jsonlPath, toJsonl(records), 'utf8')
    await writeFile(reportJsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    await writeFile(reportMdPath, human + '\n', 'utf8')

    if (values.json === true) console.log(JSON.stringify(report, null, 2))
    else {
      if (selftestHead !== null) {
        console.log('自测模式：模型端点是本地假 OpenAI 服务（' + fakeServer.origin + '），不是真实模型。')
        console.log('本次自测证明的是"通道能跑通、绊线拦得住、报告生成得出来"，**不是**模型表现。')
      }
      console.log(human)
      if (selftestHead !== null) {
        console.log('')
        console.log('自测断言：')
        for (const check of selftestChecks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`)
        const trip = await selftestTripSafety()
        console.log('')
        console.log('绊线端到端自测（子进程里故意让模型输出一个"要发"的决策，并去掉影子闸门）：')
        console.log(`  退出码 ${String(trip.code)}（期望 1）· ${trip.summary}`)
        const errorChecks = await selftestErrorPaths({ config })
        console.log('')
        console.log('异常路径自测：')
        for (const check of errorChecks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`)
        const failedChecks = [...selftestChecks, ...errorChecks].filter((check) => !check.ok)
        if (trip.code !== 1 || failedChecks.length > 0) {
          console.error('group-llm-eval: 自测没通过（绊线端到端退出码 ' + String(trip.code) + '，期望 1；失败的断言 ' + String(failedChecks.length) + ' 条）')
          return 1
        }
      }
    }
    if (fakeServer !== null) await fakeServer.close()

    if (hardFails.length > 0) {
      console.error('\n硬失败 ' + String(hardFails.length) + ' 条：')
      for (const fail of hardFails) console.error('  - ' + fail)
      return 1
    }
    // 一次有效输出都没有 = 这次没拿到任何成绩（端点不可达 / key 错 / 全超时）。
    // 那不是"跑完了"，所以不给退出码 0——否则 CI 会把"端点写错"当成绿灯。
    if (agg.validOutputRate === 0) {
      console.error('\n这次一条有效输出都没有拿到（有效输出率 0%）：端点/鉴权/超时有问题，先看报告里的异常码。')
      return 1
    }
    return 0
  } catch (error) {
    if (fakeServer !== null) await fakeServer.close()
    if (error instanceof UsageError) {
      console.error('group-llm-eval: ' + error.message)
      console.error(USAGE)
      return 2
    }
    console.error('group-llm-eval: ' + String(error instanceof Error ? error.stack ?? error.message : error))
    return 2
  }
}

process.exitCode = await main()