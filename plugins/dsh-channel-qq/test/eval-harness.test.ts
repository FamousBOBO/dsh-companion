/** 评测器自身的测试（P6a）。
 *
 * 为什么要有这一份：`eval/` 是 P6 每一次升级"关/开对比"的判分底座——如果判据
 * 本身会误伤合规回复、或者抓不住反面例子，后面所有"变好还是变坏"的结论都不成立。
 * 这里用临时转录文件驱动**真实的 `node eval/run.mjs` 进程**（spawnSync），钉住：
 *
 *   - 规则能抓出违规回复（主会话违规 → 退出码 1，报告里点名规则）
 *   - 规则不会误伤合规回复（合规主会话 + 反面替换必须被抓 → 退出码 0）
 *   - 转录格式解析正确（回合/反例计数进报告；坏 JSON 退出 2 且带文件名）
 *   - --suite 过滤生效（只跑指定套件；未知套件退出 2）
 *   - 全量离线跑绿（用例 + 转录的条数与 PASS 状态）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const RUNNER = path.join(REPO, 'eval', 'run.mjs')

interface EvalItem {
  id: string
  type: string
  status: string
  detail?: string
  failures?: { id: string; detail: string }[]
}

interface EvalSuite {
  items: EvalItem[]
  summary: { pass: number; fail: number; skip: number; total: number }
}

interface EvalReport {
  version: number
  mode: string
  suites: Record<string, EvalSuite>
  totals: { pass: number; fail: number; skip: number; total: number }
}

/** 跑一次真实 CLI，收集退出码与两路输出。 */
function runEval(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd: REPO, encoding: 'utf8' })
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

/** --json 的 stdout 应当是纯 JSON（日志都在 stderr）。 */
function reportOf(stdout: string): EvalReport {
  const parsed: EvalReport = JSON.parse(stdout)
  assert.equal(parsed.version, 1)
  return parsed
}

function suiteOf(report: EvalReport, name: string): EvalSuite {
  const suite = report.suites[name]
  assert.ok(suite !== undefined, `报告里应有 ${name} 套件（实际有：${Object.keys(report.suites).join(' / ')}）`)
  return suite
}

/** 在临时目录写一份转录并返回路径（自述 rules，不依赖仓库里的任何用例）。 */
function writeTranscript(dir: string, name: string, body: unknown): string {
  const file = path.join(dir, name)
  writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
  return file
}

test('规则能抓出违规回复：主会话违规 → 退出码 1 且报告点名规则', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-harness-bad-'))
  try {
    const file = writeTranscript(dir, 'bad.json', {
      id: 't-bad',
      title: '违规回复',
      rules: [{ id: 'no-bad-word', kind: 'forbid', pattern: '测试违规词', reason: '测试用' }],
      messages: [
        { role: 'user', speaker: '群友', text: '随便聊' },
        { role: 'assistant', speaker: '诺诺', text: '这里是测试违规词' },
      ],
    })
    const r = runEval(['--transcript', file, '--json'])
    assert.equal(r.status, 1, `stderr: ${r.stderr}`)
    const report = reportOf(r.stdout)
    assert.equal(report.totals.fail, 1)
    const item = suiteOf(report, 'transcripts').items[0]
    assert.ok(item !== undefined)
    assert.equal(item.status, 'FAIL')
    assert.ok(
      item.failures?.[0]?.detail.includes('no-bad-word') === true,
      `失败详情应点名规则，实际：${JSON.stringify(item.failures)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('规则不会误伤合规回复：合规主会话通过 + 反面回复被替换后必须被抓', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-harness-good-'))
  try {
    const file = writeTranscript(dir, 'good.json', {
      id: 't-good',
      title: '合规回复 + 反例',
      rules: [{ id: 'no-bad-word', kind: 'forbid', pattern: '测试违规词', reason: '测试用' }],
      messages: [
        { role: 'user', speaker: '群友', text: '随便聊' },
        { role: 'assistant', speaker: '诺诺', text: '今天天气不错' },
      ],
      counterExamples: [{ of: 1, text: '这里是测试违规词', note: '反例：应被抓' }],
    })
    const r = runEval(['--transcript', file, '--json'])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const report = reportOf(r.stdout)
    assert.equal(report.totals.fail, 0)
    const item = suiteOf(report, 'transcripts').items[0]
    assert.ok(item !== undefined)
    assert.equal(item.status, 'PASS')
    assert.ok(
      item.detail?.includes('反例 1/1 被抓') === true,
      `合规主会话要过、反例要被抓，实际：${String(item.detail)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('转录格式解析正确；坏文件退出 2 且报错带文件名', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-harness-shape-'))
  try {
    const file = writeTranscript(dir, 'shape.json', {
      id: 't-shape',
      title: '格式',
      rules: [{ id: 'no-bad-word', kind: 'forbid', pattern: '测试违规词', reason: '测试用' }],
      messages: [
        { role: 'user', speaker: '群友', text: '一' },
        { role: 'assistant', speaker: '诺诺', text: '好' },
        { role: 'user', speaker: '群友', text: '二' },
      ],
      counterExamples: [
        { of: 1, text: '这里是测试违规词', note: '反例 A' },
        { of: 1, text: '测试违规词又来了', note: '反例 B' },
      ],
    })
    const ok = runEval(['--transcript', file, '--json'])
    assert.equal(ok.status, 0, `stderr: ${ok.stderr}`)
    const item = suiteOf(reportOf(ok.stdout), 'transcripts').items[0]
    assert.ok(item !== undefined)
    assert.ok(item.detail?.includes('回合 3 条') === true, `实际：${String(item.detail)}`)
    assert.ok(item.detail?.includes('反例 2/2 被抓') === true, `实际：${String(item.detail)}`)

    const broken = path.join(dir, 'broken.json')
    writeFileSync(broken, '{ 这不是 JSON', 'utf8')
    const bad = runEval(['--transcript', broken, '--json'])
    assert.equal(bad.status, 2)
    assert.ok(bad.stderr.includes('broken.json'), `stderr 应带文件名，实际：${bad.stderr}`)
    assert.ok(bad.stderr.includes('JSON 解析失败'), `stderr 应说明解析失败，实际：${bad.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--suite 过滤生效：只跑指定套件；未知套件退出 2', () => {
  const persona = runEval(['--suite', 'persona', '--json'])
  assert.equal(persona.status, 0, `stderr: ${persona.stderr}`)
  const report = reportOf(persona.stdout)
  assert.deepEqual(Object.keys(report.suites), ['persona'], '只应出现被选的套件')
  assert.equal(suiteOf(report, 'persona').summary.total, 30)

  const unknown = runEval(['--suite', 'nope', '--json'])
  assert.equal(unknown.status, 2)
  assert.ok(unknown.stderr.includes('未知套件'), `实际：${unknown.stderr}`)
})

test('全量离线跑绿：用例 + 转录全部 PASS，退出码 0', () => {
  const r = runEval(['--json'])
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const report = reportOf(r.stdout)
  assert.equal(report.mode, 'offline')
  assert.equal(report.totals.fail, 0)
  assert.equal(report.totals.skip, 0)
  const redteam = suiteOf(report, 'redteam')
  const scenarios = suiteOf(report, 'scenarios')
  const personaSuite = suiteOf(report, 'persona')
  // 红队 7 条 + 3 条转录；场景 15 条 + 5 条转录；人格 30 条。新增转录时放宽下限即可。
  assert.ok(redteam.summary.total >= 10, `redteam 应有 ≥10 条，实际 ${redteam.summary.total}`)
  assert.ok(scenarios.summary.total >= 20, `scenarios 应有 ≥20 条，实际 ${scenarios.summary.total}`)
  assert.equal(personaSuite.summary.total, 30)
  assert.equal(report.totals.total, redteam.summary.total + scenarios.summary.total + personaSuite.summary.total)
})
