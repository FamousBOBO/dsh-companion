/** 副歌定位适配器：固定 JSON → `ChorusPick`，其余一切按"不可靠"（`null`）。
 *
 * 这组用例守的是一条**降级路径**：定位不可靠时上层要能继续发语音条（从 0 秒裁），
 * 所以这里任何失败都不许抛。`ok:false` / 坏 JSON / 超时 / 非零退出 四种情况都钉住，
 * 因为它们是"线上真的会发生"的那几类，而不是"理论上可能"的那几类。
 *
 * 全程离线：`ProcessPort` 是注入的假件，不跑 python、不碰真音频。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ProcessPort, ProcessResult } from '../src/features/song/types.js'

const { createChorusPort } = await import('../src/adapters/song/chorus.js')

/** 一次假运行的结果；`out` 为 `null` 表示"脚本没写出文件"。 */
interface RunPlan {
  result?: Partial<ProcessResult>
  out?: string | null
}

/**
 * 假 `ProcessPort`：记下参数，并按计划把 `--out` 指定的文件写出来。
 *
 * 写文件这一步是必要的——适配器的整个工作就是"读脚本写出的 JSON"，
 * 只回放 stdout 等于把被测逻辑换掉了。
 */
function fakeProcess(plans: RunPlan[]): { port: ProcessPort; calls: string[][] } {
  const calls: string[][] = []
  let index = 0
  return {
    calls,
    port: {
      async run(_command: string, args: readonly string[]): Promise<ProcessResult> {
        calls.push([...args])
        const plan = plans[Math.min(index, plans.length - 1)] ?? {}
        index += 1
        const outIndex = args.indexOf('--out')
        const outFile = outIndex === -1 ? null : args[outIndex + 1]
        if (plan.out !== null && outFile !== undefined && outFile !== null) {
          await fs.writeFile(outFile, plan.out ?? '', 'utf-8')
        }
        return {
          code: plan.result?.code ?? 0,
          stdout: plan.result?.stdout ?? '',
          stderr: plan.result?.stderr ?? '',
          timedOut: plan.result?.timedOut ?? false,
          durationMs: plan.result?.durationMs ?? 10,
        }
      },
    },
  }
}

function makePort(plans: RunPlan[], logs: string[] = []): { port: ReturnType<typeof createChorusPort>; calls: string[][]; logs: string[] } {
  const fake = fakeProcess(plans)
  const port = createChorusPort({
    process: fake.port,
    pythonPath: 'python',
    scriptPath: 'find_chorus.py',
    log: (line) => logs.push(line),
    timeoutMs: 30_000,
  })
  return { port, calls: fake.calls, logs }
}

const GOOD_JSON = JSON.stringify({
  ok: true, start: 62.5, end: 92.0, confidence: 0.71, method: 'repeat+energy', repeats: 2, vocalRatio: 0.83,
  phraseEnds: [78.0, 84.5, 91.0],
})

test('正常解析：固定 JSON → ChorusPick（字段名与单位都对上）', async () => {
  const logs: string[] = []
  const { port, calls } = makePort([{ out: GOOD_JSON }], logs)
  const audio = path.join(mkdtempSync(path.join(tmpdir(), 'song-chorus-')), 'original.wav')
  const pick = await port.locate(audio)
  assert.ok(pick !== null)
  assert.deepEqual(pick, {
    startSeconds: 62.5,
    endSeconds: 92.0,
    confidence: 0.71,
    method: 'repeat+energy',
    repeats: 2,
    vocalRatio: 0.83,
    phraseEnds: [78.0, 84.5, 91.0],
  })
  // 参数是数组、--input 与 --out 都传到了（不拼 shell 字符串）。
  assert.equal(calls.length, 1)
  const args = calls[0] ?? []
  assert.equal(args[0], 'find_chorus.py')
  assert.equal(args[args.indexOf('--input') + 1], audio)
  assert.deepEqual(args.slice(args.indexOf('--out'), args.indexOf('--out') + 2), ['--out', args[args.indexOf('--out') + 1]])
  assert.ok(logs.some((line) => line.includes('副歌 62.5–92.0s')))
})

test('句尾视界：`needSeconds` 会变成 `--need`，不传就没有这个参数', async () => {
  const withNeed = makePort([{ out: JSON.stringify({ ok: true, start: 10, end: 35, confidence: 0.6 }) }])
  await withNeed.port.locate('/tmp/a.wav', { needSeconds: 180 })
  const args = withNeed.calls[0] ?? []
  assert.equal(args[args.indexOf('--need') + 1], '180', '上限 180 s 要告诉脚本"句尾要看多远"')
  // 段长仍然不能传：`--seconds` 会改掉"找哪一段"的判据。
  assert.equal(args.includes('--seconds'), false, '副歌模式不许传 --seconds')

  const without = makePort([{ out: JSON.stringify({ ok: true, start: 10, end: 35, confidence: 0.6 }) }])
  await without.port.locate('/tmp/a.wav')
  assert.equal((without.calls[0] ?? []).includes('--need'), false, '没给上限时保持旧参数')
})

test('句尾：乱序会排好、非有限数与负数被丢掉；没这个字段就给空数组', async () => {
  const messy = makePort([{
    out: JSON.stringify({
      ok: true, start: 10, end: 35, confidence: 0.6,
      phraseEnds: [22.5, 'x', 14.0, null, -3, 18.5],
    }),
  }])
  const pick = await messy.port.locate('/tmp/a.wav')
  assert.ok(pick !== null)
  assert.deepEqual(pick.phraseEnds, [14.0, 18.5, 22.5], '下游按"最后一个不超上限的"挑，顺序不能靠上游')

  const missing = makePort([{ out: JSON.stringify({ ok: true, start: 10, end: 35, confidence: 0.6 }) }])
  const plain = await missing.port.locate('/tmp/a.wav')
  assert.ok(plain !== null)
  assert.deepEqual(plain.phraseEnds, [], '取不到句尾就是空数组（不是定位失败）')

  const notArray = makePort([{ out: JSON.stringify({ ok: true, start: 10, end: 35, confidence: 0.6, phraseEnds: 42 }) }])
  const weird = await notArray.port.locate('/tmp/a.wav')
  assert.ok(weird !== null)
  assert.deepEqual(weird.phraseEnds, [], '形状不对也只当没有句尾')
})

test('脚本回报 ok:false → null（正常失败协议，不抛）', async () => {
  const logs: string[] = []
  const { port } = makePort([{ out: JSON.stringify({ ok: false, reason: '音轨太短' }) }], logs)
  const pick = await port.locate('/tmp/a.wav')
  assert.equal(pick, null)
  assert.ok(logs.some((line) => line.includes('音轨太短')))
})

test('坏 JSON → null', async () => {
  const logs: string[] = []
  const { port } = makePort([{ out: '{oops' }], logs)
  assert.equal(await port.locate('/tmp/a.wav'), null)
  assert.ok(logs.some((line) => line.includes('不可解析')))
})

test('脚本没写出文件 → null', async () => {
  const logs: string[] = []
  const { port } = makePort([{ out: null }], logs)
  assert.equal(await port.locate('/tmp/a.wav'), null)
  assert.ok(logs.some((line) => line.includes('没有写出 JSON')))
})

test('超时 → null（timedOut 是独立信号，不看成"退出码异常"）', async () => {
  const logs: string[] = []
  const { port } = makePort([{ result: { timedOut: true, code: null, durationMs: 30_000 } }], logs)
  assert.equal(await port.locate('/tmp/a.wav'), null)
  assert.ok(logs.some((line) => line.includes('超时')))
})

test('非零退出 → null，日志带 stderr 末行', async () => {
  const logs: string[] = []
  const { port } = makePort([{ result: { code: 1, stderr: 'Traceback…\nModuleNotFoundError: No module named \'librosa\'' } }], logs)
  assert.equal(await port.locate('/tmp/a.wav'), null)
  assert.ok(logs.some((line) => line.includes("No module named 'librosa'")))
})

test('字段缺失或不是有限数 → null（不给 ffmpeg 喂 NaN）', async () => {
  const cases = [
    JSON.stringify({ ok: true, start: 10, end: 35 }),
    JSON.stringify({ ok: true, start: null, end: 35, confidence: 0.5 }),
    JSON.stringify({ ok: true, start: 40, end: 10, confidence: 0.5 }),
    JSON.stringify({ ok: true, start: -1, end: 10, confidence: 0.5 }),
  ]
  for (const text of cases) {
    const { port } = makePort([{ out: text }])
    assert.equal(await port.locate('/tmp/a.wav'), null, text)
  }
})

test('比例字段越界时夹到 0..1（置信度不是判据的判据，别让它跑出范围）', async () => {
  const { port } = makePort([{
    out: JSON.stringify({ ok: true, start: 10, end: 35, confidence: 1.8, method: '', repeats: -3, vocalRatio: 1.4 }),
  }])
  const pick = await port.locate('/tmp/a.wav')
  assert.ok(pick !== null)
  assert.equal(pick.confidence, 1)
  assert.equal(pick.vocalRatio, 1)
  assert.equal(pick.repeats, 0)
  assert.equal(pick.method, 'unknown')
})

test('空音频路径直接 null，不白跑一次 python', async () => {
  const logs: string[] = []
  const { port, calls } = makePort([{ out: GOOD_JSON }], logs)
  assert.equal(await port.locate('  '), null)
  assert.equal(calls.length, 0)
})

test('临时目录用完即删（连失败路径也删）', async () => {
  const before = (await fs.readdir(tmpdir())).filter((name) => name.startsWith('dsh-song-chorus-')).length
  const good = makePort([{ out: GOOD_JSON }])
  await good.port.locate('/tmp/a.wav')
  const failing = makePort([{ result: { code: 1, stderr: 'boom' } }])
  await failing.port.locate('/tmp/a.wav')
  const after = (await fs.readdir(tmpdir())).filter((name) => name.startsWith('dsh-song-chorus-')).length
  assert.equal(after, before, '一次运行不该留下临时目录')
})

// ── 脚本参数契约：`locate` 不传 `--start-at`，`locateFrom` 一定传 ────────────

test('locate：参数里**没有** `--start-at`（默认行为一字不变）', async () => {
  const { port, calls } = makePort([{ out: GOOD_JSON }])
  await port.locate('/tmp/a.wav')
  const args = calls[0] ?? []
  assert.equal(args.includes('--start-at'), false, `找副歌不该传 --start-at：${args.join(' ')}`)
  assert.equal(args.includes('--seconds'), false, `也不该传 --seconds（保持脚本默认 25 s）：${args.join(' ')}`)
})

test('locateFrom：传 `--start-at <起点>` 与 `--seconds <需要的长度>`（句尾视界靠它伸缩）', async () => {
  const manual = JSON.stringify({
    ok: true, start: 0.0, end: 180.0, confidence: 1.0, method: 'manual-start', repeats: 0,
    vocalRatio: 0.72, phraseEnds: [47.5, 96.0, 172.0],
  })
  const logs: string[] = []
  const { port, calls } = makePort([{ out: manual }], logs)
  const pick = await port.locateFrom('/tmp/a.wav', 0, { seconds: 180 })

  assert.ok(pick !== null)
  assert.equal(pick.startSeconds, 0)
  assert.equal(pick.method, 'manual-start')
  assert.equal(pick.confidence, 1)
  assert.deepEqual(pick.phraseEnds, [47.5, 96.0, 172.0], '句尾照样读回来（上层还要收尾）')
  const args = calls[0] ?? []
  assert.equal(args[args.indexOf('--start-at') + 1], '0', `--start-at 后面是起点：${args.join(' ')}`)
  assert.equal(args[args.indexOf('--seconds') + 1], '180', `--seconds 后面是需要的长度：${args.join(' ')}`)
  assert.ok(logs.some((line) => line.includes('0.0–180.0s')), `日志要报区间：${logs.join('\n')}`)
})

test('locateFrom：脚本失败同样收敛成 null（四类失败都不许抛）', async () => {
  const cases: RunPlan[] = [
    { result: { timedOut: true, code: null, durationMs: 30_000 } },
    { result: { code: 1, stderr: "ModuleNotFoundError: No module named 'librosa'" } },
    { out: JSON.stringify({ ok: false, reason: '音频太短' }) },
    { out: '{oops' },
  ]
  for (const plan of cases) {
    const { port } = makePort([plan])
    assert.equal(await port.locateFrom('/tmp/a.wav', 0, { seconds: 180 }), null)
  }
  const empty = makePort([{ out: JSON.stringify({ ok: true, start: 0, end: 1, confidence: 1 }) }])
  assert.equal(await empty.port.locateFrom('  ', 0, { seconds: 180 }), null, '空路径不白跑一次 python')
})
