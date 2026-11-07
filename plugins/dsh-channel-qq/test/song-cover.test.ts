/** 翻唱适配器：三阶段命令的形状（`-ss` / `-t` / `--key`）、失败原因、时长校验与 summary 白名单。
 *
 * 全程离线：`ProcessPort` 是假的（记录每次 command/args/cwd 并返回预设结果），
 * 文件系统只用 `fs.mkdtemp` 的临时目录。不跑真 ffmpeg、不跑真 python、不碰仓库目录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ProcessPort, ProcessResult } from '../src/features/song/types.js'

const { createCoverPort, excerptRange } = await import('../src/adapters/song/cover.js')

/** 一次被记录的调用（测试断言的主入口：形状比返回值更容易出错）。 */
interface RecordedCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly timeoutMs: number
  readonly env: Readonly<Record<string, string>> | undefined
}

/** 假 `ProcessPort`：按调用顺序取预设结果；`respond` 还能顺便产出文件（模拟 python 写产物）。 */
function fakeProcess(
  respond: (call: RecordedCall, index: number) => Partial<ProcessResult> = () => ({}),
  /** 未显式给出 stdout 的 `ffprobe` 调用读到的时长（默认用例请求的都是 25 s）。 */
  probeSeconds = 25,
): { port: ProcessPort; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const port: ProcessPort = {
    async run(command, args, options): Promise<ProcessResult> {
      const call: RecordedCall = {
        command,
        args,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
      }
      calls.push(call)
      const isProbe = command.endsWith('ffprobe')
      const preset = respond(call, calls.length - 1)
      return {
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 7,
        ...preset,
        // ffprobe 的真实 stdout 只有那段 JSON；不给它，`probeDuration` 会以为产物坏了。
        // 放在 `...preset` **之后**：`preset` 里显式给了 `stdout` 时以它为准，
        // 没给时这里补上（spread 会把 undefined 也拷进去，所以要显式兜底）。
        stdout: preset.stdout ?? (isProbe ? probeJson(probeSeconds) : ''),
      }
    },
  }
  return { port, calls }
}

/** 取某个参数后面的值（`args[i]` 是选项名）。 */
function argAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'song-cover-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** ffprobe 的 stdout 形状（`format.duration` 是字符串）。 */
function probeJson(seconds: number): string {
  return JSON.stringify({ format: { duration: seconds.toFixed(6) } })
}

/**
 * 造一个会写产物的"python"：解析 `--out`，写入 `cover.mp3`（假字节）与 `summary.json`。
 * 这样第 3–5 步拿到的是真实存在的文件，测试不必自己摆这些中间产物。
 */
function pythonWritesCover(summary: Record<string, unknown>, coverBytes = Buffer.alloc(4096, 7)) {
  return (call: RecordedCall, _index?: number): Partial<ProcessResult> => {
    if (call.command !== 'python.exe') return {}
    const outDir = argAfter(call.args, '--out')
    assert.ok(outDir !== undefined, '--out 必须存在')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'cover.mp3'), coverBytes)
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary))
    return { stdout: 'DONE' }
  }
}

const WHITELIST_SUMMARY = {
  input: 'D:\\Bot\\rvc\\test-results\\_song-smoke\\excerpt.wav',
  output: 'D:\\Bot\\rvc\\test-results\\_song-smoke\\cover',
  model: 'March7_RVC.pth',
  separator: 'mel-karaoke-gabox',
  vocals_stem: 'D:\\Bot\\rvc\\...\\excerpt_vocals.wav',
  instrumental_stem: 'D:\\Bot\\rvc\\...\\excerpt_instrumental.wav',
  f0_up_key: 0,
  filter_radius: 0,
  protect: 0.33,
  rms_mix_rate: 0.25,
  index_rate: 0.0,
  f0_method: 'rmvpe',
  sample_rate: 44100,
  vocal_gain_db: 3.0,
  files: { cover: 'D:\\Bot\\rvc\\...\\cover.mp3' },
  // 上游将来多写的字段：白名单必须挡住它，而不是靠逐条删除。
  experimental_note: '不该出现在日志里',
}

const TIMEOUTS = { cut: 60_000, cover: 600_000, trim: 30_000 }
const PYTHON = 'python.exe'
const RVC_ROOT = 'D:\\Bot\\rvc'

test('正序三次调用：切 47 s 试听段 → 翻唱 → 从片段内 12 s 处裁 25 s', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const outDir = path.join(s.dir, 'task-1')
    const logs: string[] = []
    const { port, calls } = fakeProcess(pythonWritesCover(WHITELIST_SUMMARY))
    const cover = createCoverPort({
      process: port,
      pythonPath: PYTHON,
      rvcRoot: RVC_ROOT,
      ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS,
      log: (line) => logs.push(line),
    })

    const result = await cover.render({ audioFile, outDir, chorusStart: 90, seconds: 25, keyUp: 0 })

    assert.equal(calls.length, 5, `应该是 切/翻唱/裁/解码/读时长 五次调用，实际 ${String(calls.length)}`)
    // 1. 切试听段：起点往前留 12 s（上下文给分离器），长度 = 12 + 25 + 10。
    const cut = calls[0]!
    assert.equal(cut.command, 'ffmpeg')
    assert.equal(argAfter(cut.args, '-ss'), '78.000')
    assert.equal(argAfter(cut.args, '-t'), '47.000')
    assert.ok(cut.args.includes('-c:a'), '必须显式指定 pcm_s16le，避免重采样两次')
    assert.equal(cut.timeoutMs, TIMEOUTS.cut)
    assert.equal(cut.cwd, undefined)
    // 2. 翻唱：cwd 必须是 RVC 仓库根，env 必须带 PYTHONUTF8。
    const py = calls[1]!
    assert.equal(py.command, PYTHON)
    assert.deepEqual(py.args.slice(0, 2), ['make_cover.py', '--input'])
    assert.equal(argAfter(py.args, '--input'), path.join(outDir, 'excerpt.wav'))
    assert.equal(argAfter(py.args, '--out'), path.join(outDir, 'cover'))
    assert.equal(py.cwd, RVC_ROOT, 'make_cover.py 会 chdir 到自己目录，cwd 必须显式给对')
    assert.equal(py.env?.['PYTHONUTF8'], '1')
    assert.equal(py.timeoutMs, TIMEOUTS.cover)
    // 3. 裁语音条：偏移是副歌起点在**片段内**的位置（12 s），不是绝对 90 s。
    const trim = calls[2]!
    assert.equal(trim.command, 'ffmpeg')
    assert.equal(argAfter(trim.args, '-ss'), '12.000')
    assert.equal(argAfter(trim.args, '-t'), '25.000')
    assert.equal(argAfter(trim.args, '-i'), path.join(outDir, 'cover', 'cover.mp3'))
    assert.equal(trim.args.at(-1), path.join(outDir, 'voice.mp3'))
    assert.equal(trim.timeoutMs, TIMEOUTS.trim)
    // 4. 校验：先解码一遍，再 ffprobe 读时长。
    const decode = calls[3]!
    assert.equal(decode.command, 'ffmpeg')
    assert.ok(decode.args.some((arg) => arg === 'null'), '解码校验用 -f null -')
    const probe = calls[4]!
    assert.equal(probe.command, 'ffprobe', 'ffprobe 由 ffmpeg 路径推出（同目录同版本）')
    assert.equal(argAfter(probe.args, '-i'), undefined)
    assert.equal(probe.args.at(-1), path.join(outDir, 'voice.mp3'))

    assert.equal(result.voiceFile, path.resolve(path.join(outDir, 'voice.mp3')))
    assert.equal(result.durationSeconds, 25)
    assert.equal(result.chorusStart, 90)
    assert.equal(result.seconds, 25)
    assert.ok(logs.some((line) => line.includes('切试听段')))
    assert.ok(logs.some((line) => line.includes('模型 B')), '慢步骤要有可辨识的一行')
  } finally { s.cleanup() }
})

test('副歌很靠前：起点 clamp 到 0，偏移改为绝对副歌起点', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const outDir = path.join(s.dir, 'task-early')
    const { port, calls } = fakeProcess(pythonWritesCover(WHITELIST_SUMMARY))
    const cover = createCoverPort({
      process: port,
      pythonPath: PYTHON,
      rvcRoot: RVC_ROOT,
      ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS,
      log: () => {},
    })

    const result = await cover.render({ audioFile, outDir, chorusStart: 4, seconds: 25, keyUp: 0 })

    // 起点 4 - 12 = -8 → 0；长度 = 4 + 25 + 10 - 0。
    assert.equal(argAfter(calls[0]!.args, '-ss'), '0.000')
    assert.equal(argAfter(calls[0]!.args, '-t'), '39.000')
    // 片段内偏移 = 4 - 0 = 4。
    assert.equal(argAfter(calls[2]!.args, '-ss'), '4.000')
    assert.equal(argAfter(calls[2]!.args, '-t'), '25.000')
    assert.equal(result.chorusStart, 4)
  } finally { s.cleanup() }
})

test('excerptRange：clamp 在纯函数里，三个数一次算清（含边界）', () => {
  // 常规：副歌在 90 s，起点 78 s，长度 12 + 25 + 10 = 47，片段内偏移 12。
  assert.deepEqual(excerptRange(90, 25), { start: 78, length: 47, voiceOffset: 12 })
  // 歌头不足 12 s：起点 clamp 到 0，偏移等于副歌起点本身。
  assert.deepEqual(excerptRange(4, 25), { start: 0, length: 39, voiceOffset: 4 })
  // 正好 12 s：clamp 边界不打折（起点 0，偏移 12）。
  assert.deepEqual(excerptRange(12, 25), { start: 0, length: 47, voiceOffset: 12 })
  // 副歌 0 s：起点 0、偏移 0。
  assert.deepEqual(excerptRange(0, 25), { start: 0, length: 35, voiceOffset: 0 })
  // 长度随 seconds 线性涨：12 s 与 30 s 各一例（网关缩长度时用得到）。
  assert.deepEqual(excerptRange(90, 12), { start: 78, length: 34, voiceOffset: 12 })
  assert.deepEqual(excerptRange(90, 30), { start: 78, length: 52, voiceOffset: 12 })
})

test('升调真的传下去了：keyUp=12 → argv 有 --key 12、返回体 keyUp=12、summary 反映 12', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const outDir = path.join(s.dir, 'task-key12')
    // 假 summary 里的 f0_up_key 也跟着变 12：它才是"准则生效"的可核查证据。
    const { port, calls } = fakeProcess(pythonWritesCover({ ...WHITELIST_SUMMARY, f0_up_key: 12 }))
    const logs: string[] = []
    const cover = createCoverPort({
      process: port, pythonPath: PYTHON, rvcRoot: RVC_ROOT, ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS, log: (line) => logs.push(line),
    })

    const result = await cover.render({ audioFile, outDir, chorusStart: 90, seconds: 25, keyUp: 12 })

    // 升八度 = 12 个半音，必须原样进 argv（不是 8、不是 1200）。
    assert.equal(argAfter(calls[1]!.args, '--key'), '12', 'make_cover.py 的 --key 必须是 12')
    assert.equal(result.keyUp, 12, '返回体必须回写入参的 keyUp')
    assert.equal(result.summary['f0_up_key'], 12, 'summary.f0_up_key 是准则生效的唯一证据')
    // 升调不改时长，也不改裁剪偏移：这两个数必须和 keyUp=0 时一模一样。
    assert.equal(argAfter(calls[0]!.args, '-ss'), '78.000')
    assert.equal(argAfter(calls[0]!.args, '-t'), '47.000')
    assert.equal(argAfter(calls[2]!.args, '-ss'), '12.000')
    assert.equal(argAfter(calls[2]!.args, '-t'), '25.000')
    assert.equal(result.durationSeconds, 25)
    // 日志里带上升调数（只有既有那一行，不新增分支）。
    assert.ok(logs.some((line) => line.includes('升调 12 半音')), `日志没带升调：${logs.join(' | ')}`)
  } finally { s.cleanup() }
})

test('没升调也要传 --key 0（两条路径不许分叉）', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const outDir = path.join(s.dir, 'task-key0')
    const { port, calls } = fakeProcess(pythonWritesCover(WHITELIST_SUMMARY))
    const cover = createCoverPort({
      process: port, pythonPath: PYTHON, rvcRoot: RVC_ROOT, ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS, log: () => {},
    })

    const result = await cover.render({ audioFile, outDir, chorusStart: 90, seconds: 25, keyUp: 0 })

    assert.equal(argAfter(calls[1]!.args, '--key'), '0', 'keyUp=0 时也必须显式传 --key 0')
    assert.equal(result.keyUp, 0)
    assert.equal(result.summary['f0_up_key'], 0)
  } finally { s.cleanup() }
})

test('make_cover.py 退出码非 0：抛错并带上 stderr 尾行', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const outDir = path.join(s.dir, 'task-fail')
    const { port, calls } = fakeProcess((call, index) => {
      if (index !== 1) return {}
      return { code: 1, stderr: 'some warmup noise\nRuntimeError: [enforce fail] CUDA out of memory\n' }
    })
    const cover = createCoverPort({
      process: port, pythonPath: PYTHON, rvcRoot: RVC_ROOT, ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS, log: () => {},
    })

    await assert.rejects(
      () => cover.render({ audioFile, outDir, chorusStart: 90, seconds: 25, keyUp: 0 }),
      /翻唱失败（退出码 1）[\s\S]*CUDA out of memory/,
    )
    // 失败就停：不该再出现"裁语音条"的调用。
    assert.equal(calls.length, 2)
  } finally { s.cleanup() }
})

test('make_cover.py 超时：抛错且不带"成功"假象', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const { port, calls } = fakeProcess(
      (_call, index) => (index === 1 ? { timedOut: true, code: null, durationMs: 600_000 } : {}),
    )
    const cover = createCoverPort({
      process: port, pythonPath: PYTHON, rvcRoot: RVC_ROOT, ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS, log: () => {},
    })

    await assert.rejects(
      () => cover.render({ audioFile, outDir: path.join(s.dir, 't'), chorusStart: 90, seconds: 25, keyUp: 0 }),
      /翻唱超时（超过 600000ms/,
    )
    assert.equal(calls.length, 2)
  } finally { s.cleanup() }
})

test('没产出 cover.mp3：抛错（不能把"正常退出"当成功）', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const { port, calls } = fakeProcess()
    const cover = createCoverPort({
      process: port, pythonPath: PYTHON, rvcRoot: RVC_ROOT, ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS, log: () => {},
    })

    await assert.rejects(
      () => cover.render({ audioFile, outDir: path.join(s.dir, 't'), chorusStart: 90, seconds: 25, keyUp: 0 }),
      /没有产出 cover\/cover\.mp3/,
    )
    assert.equal(calls.length, 2)
  } finally { s.cleanup() }
})

test('时长校验：ffprobe 与请求时长差 > 0.75 s → 抛错（不发半截语音条）', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const outDir = path.join(s.dir, 'task-short')
    const { port } = fakeProcess((call, index) => {
      const write = pythonWritesCover(WHITELIST_SUMMARY)(call, index)
      if (index === 4) return { stdout: probeJson(18.2) } // 请求 25 s，实际 18.2 s
      return write
    })
    const cover = createCoverPort({
      process: port, pythonPath: PYTHON, rvcRoot: RVC_ROOT, ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS, log: () => {},
    })

    await assert.rejects(
      () => cover.render({ audioFile, outDir, chorusStart: 90, seconds: 25, keyUp: 0 }),
      /语音条时长 18\.20s 与请求的 25\.000s 相差超过 0\.75s/,
    )
  } finally { s.cleanup() }
})

test('时长校验：差 ≤ 0.75 s 通过（mp3 帧对齐会带来 20 ms 级偏差）', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const outDir = path.join(s.dir, 'task-tolerance')
    const { port } = fakeProcess((call, index) => {
      const write = pythonWritesCover(WHITELIST_SUMMARY)(call, index)
      if (index === 4) return { stdout: probeJson(24.99) }
      return write
    })
    const cover = createCoverPort({
      process: port, pythonPath: PYTHON, rvcRoot: RVC_ROOT, ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS, log: () => {},
    })

    const result = await cover.render({ audioFile, outDir, chorusStart: 90, seconds: 25, keyUp: 0 })
    assert.equal(result.durationSeconds, 24.99)
  } finally { s.cleanup() }
})

test('summary.json 白名单：只回 9 个字段，路径与额外字段一概不透传', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const outDir = path.join(s.dir, 'task-summary')
    const logs: string[] = []
    const { port } = fakeProcess(pythonWritesCover(WHITELIST_SUMMARY))
    const cover = createCoverPort({
      process: port, pythonPath: PYTHON, rvcRoot: RVC_ROOT, ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS, log: (line) => logs.push(line),
    })

    const result = await cover.render({ audioFile, outDir, chorusStart: 90, seconds: 25, keyUp: 0 })

    assert.deepEqual(
      Object.keys(result.summary).sort(),
      ['f0_method', 'f0_up_key', 'index_rate', 'model', 'protect', 'rms_mix_rate', 'sample_rate', 'separator', 'vocal_gain_db'],
    )
    assert.equal(result.summary['model'], 'March7_RVC.pth')
    assert.equal(result.summary['separator'], 'mel-karaoke-gabox')
    assert.equal(result.summary['sample_rate'], 44100)
    // 路径类与上游多余字段一个都不能在。
    for (const banned of ['input', 'output', 'vocals_stem', 'instrumental_stem', 'files', 'experimental_note']) {
      assert.equal(result.summary[banned], undefined, `${banned} 不该出现在白名单里`)
    }
    // 日志里也不能带本机路径。
    assert.equal(logs.some((line) => line.includes('D:\\Bot\\rvc')), false, `日志带了路径：${logs.join(' | ')}`)
  } finally { s.cleanup() }
})

test('summary.json 被写坏（不是 JSON）：抛可读错误', async () => {
  const s = scratch()
  try {
    const audioFile = path.join(s.dir, 'song.mp3')
    writeFileSync(audioFile, Buffer.alloc(1024, 1))
    const outDir = path.join(s.dir, 'task-broken')
    const { port } = fakeProcess((call) => {
      if (call.command !== PYTHON) return {}
      const dir = argAfter(call.args, '--out')!
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'cover.mp3'), Buffer.alloc(64, 1))
      writeFileSync(path.join(dir, 'summary.json'), '{oops')
      return {}
    })
    const cover = createCoverPort({
      process: port, pythonPath: PYTHON, rvcRoot: RVC_ROOT, ffmpegPath: 'ffmpeg',
      timeoutMs: TIMEOUTS, log: () => {},
    })

    await assert.rejects(
      () => cover.render({ audioFile, outDir, chorusStart: 90, seconds: 25, keyUp: 0 }),
      /summary\.json 不是合法 JSON/,
    )
  } finally { s.cleanup() }
})
