/** 翻唱适配器：**只跑副歌附近的一小段** → 本机 RVC 流水线 → QQ 语音条。
 *
 * 为什么只切一小段：`make_cover.py` 每一步都按时长线性涨。本机实测（DirectML）：
 * karaoke 分离 320 s 歌要 **89 s**，模型 B 45 s 片段要 **27 s**。整首跑两分半以上，
 * 而点歌要等回话、语音条只有 25 s。所以切出
 * `[chorusStart - 12 s, chorusStart + seconds + 10 s]` 给脚本。
 *
 * 为什么往前留 12 s：分离器（MelBand Roformer karaoke）要上下文才能把人声和伴奏
 * 分开；从副歌正起点切，第一句常被判成人声不活跃，伴奏漏进人声模型。这 12 s 也是
 * 裁剪偏移的来源。
 *
 * 五个阶段各一个模块级函数（`check-size` 量具名函数跨度，攒在一起会焊成 156 行）：
 * `renderExcerpt` → `runCover` → `trimVoice` → `verifyVoice` → `readSummary`，
 * 三段命令各用各的超时（`cut` / `cover` / `trim`）。失败一律**抛**带中文原因的 Error，
 * 上游队列记成 `failed`——半截语音条比一条明确的失败更糟。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { CoverPort, CoverResult, ProcessPort, ProcessResult } from '../../features/song/types.js'

export interface CoverPortOptions {
  readonly process: ProcessPort
  /** make_cover.py 的 python（本机：`D:\Bot\rvc\.venv\Scripts\python.exe`）。 */
  readonly pythonPath: string
  /** RVC 仓库根（本机：`D:\Bot\rvc`）——make_cover.py 的 cwd，且 --out 必须是它的相对或绝对路径。 */
  readonly rvcRoot: string
  readonly ffmpegPath: string
  /** 每个阶段各自的超时（毫秒），由调用方从配置传入。 */
  readonly timeoutMs: { readonly cut: number; readonly cover: number; readonly trim: number }
  readonly log: (line: string) => void
}

/** `render` 的入参（与 `features/song/types.ts` 的 `CoverPort.render` 同形）。 */
export interface CoverRenderInput {
  readonly audioFile: string
  readonly outDir: string
  readonly chorusStart: number
  readonly seconds: number
  /** 人声升几个半音（0 = 原调）；只作用在人声，伴奏不动、时长不动。 */
  readonly keyUp: number
  readonly signal?: AbortSignal
}

/**
 * 副歌起点之前一起送进分离器的余量（秒）。本机实测：压到 2–3 s 时第一句的伴奏会
 * 明显糊进人声；加大不会更准，只会更慢（分离时长按输入时长涨）。
 */
const PREROLL_SECONDS = 12

/** 试听段在语音条之后多留的尾巴（秒）：给裁剪留一点余量，也让分离末段不贴边。 */
const TAIL_SECONDS = 10

/** 实测时长与请求时长的允许偏差（秒）。超过就说明裁剪或产物有问题，不能当成功。 */
const DURATION_TOLERANCE_SECONDS = 0.75

/**
 * `summary.json` 只回这些字段。`make_cover.py` 写的是"本次全部参数与路径"（`input` /
 * `output` / `vocals_stem` / `files` 全是本机绝对路径）：路径对诊断没用、对日志有害
 * （带出主人的目录结构），所以做白名单而不是黑名单。`f0_up_key` 在名单里——它是
 * "升调有没有真的生效"的唯一可核查证据。`filter_radius` 不在：队列诊断不需要它。
 */
const SUMMARY_KEYS = [
  'model', 'separator', 'f0_up_key', 'protect', 'rms_mix_rate',
  'index_rate', 'f0_method', 'sample_rate', 'vocal_gain_db',
] as const

/** 是不是一个普通对象（用来收窄 `JSON.parse` 的 `any`）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 秒数格式化：固定三位小数，命令行参数与日志都因此可复现。 */
function fixed(value: number): string {
  return value.toFixed(3)
}

/** 取 stdout/stderr 末尾几行（ffmpeg/python 把真正的原因放在最后）。 */
function tail(text: string, limit = 300): string {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim() !== '')
  const last = lines.slice(-3).join(' / ')
  return last.length <= limit ? last : `…${last.slice(-limit)}`
}

/**
 * 从 `ffmpegPath` 推出 `ffprobe` 的路径：配置里只有一个 ffmpeg 路径，而 ffprobe 与它
 * 同目录、同名不同前缀。这样配置不必多一个字段，也不怕两个工具版本对不上——同一个
 * 发行版的 ffprobe 才能可靠读出一份 mp3 的时长。
 */
function ffprobeOf(ffmpegPath: string): string {
  const dir = path.dirname(ffmpegPath)
  const base = path.basename(ffmpegPath)
  const ext = path.extname(base)
  const stem = ext === '' ? base : base.slice(0, base.length - ext.length)
  const probeStem = stem.startsWith('ffmpeg') ? stem.replace(/^ffmpeg/, 'ffprobe') : 'ffprobe'
  return dir === '.' ? probeStem + ext : path.join(dir, probeStem + ext)
}

/**
 * 跑 `make_cover.py` 时的环境变量。`PYTHONUTF8=1` 是必须的：脚本
 * `print(json.dumps(..., ensure_ascii=False))` 里是中文，Windows 默认代码页的 stdout
 * 会 `UnicodeEncodeError` 把整次调用打死。另外把 ffmpeg 所在目录塞进 `PATH` 最前面：
 * 脚本自己还要起裸 `ffmpeg`（`to_wav` 与两次 loudnorm 导出），只有 PATH 可依；
 * `process.ts` 的 env 是**合并**语义，所以这是"插一个目录"而不是替换。
 * `ffmpegPath` 若是裸命令名（本机就是），`dirname` 为 `.`，不做改动。
 */
function pythonEnv(ffmpegPath: string): Record<string, string> {
  const env: Record<string, string> = { PYTHONUTF8: '1' }
  const dir = path.dirname(ffmpegPath)
  if (dir !== '.') {
    const inherited = process.env.PATH ?? ''
    env['PATH'] = inherited === '' ? dir : `${dir}${path.delimiter}${inherited}`
  }
  return env
}

/** 读 `ffprobe -show_entries format=duration -of json` 的 duration。 */
function probeDuration(stdout: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`ffprobe 输出不是 JSON（${tail(stdout, 120)}）`)
  }
  if (!isRecord(parsed) || !isRecord(parsed['format'])) {
    throw new Error(`ffprobe 没有给出 format 段（${tail(stdout, 120)}）`)
  }
  const raw = parsed['format']['duration']
  const value = typeof raw === 'string'
    ? Number.parseFloat(raw)
    : typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ffprobe 读不到语音条时长（${tail(stdout, 120)}）`)
  }
  return value
}

/** 白名单过滤 `summary.json`；不是对象视为损坏。 */
function pickSummary(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('summary.json 不是对象（make_cover.py 的产物被写坏了？）')
  const picked: Record<string, unknown> = {}
  for (const key of SUMMARY_KEYS) {
    const item = value[key]
    if (item !== undefined) picked[key] = item
  }
  return picked
}

/** 副歌在试听段里的三个数（切段与裁剪都只认它，clamp 只算一次）。
 *  `start` = 原音轨里的起点（秒，≥ 0）；`length` = 段长（秒）；
 *  `voiceOffset` = 副歌起点在**片段内**的偏移（秒）——裁语音条用的就是它。 */
export interface ExcerptRange {
  readonly start: number
  readonly length: number
  readonly voiceOffset: number
}

/**
 * 算试听段范围。纯函数，单独可测。
 *
 * 歌头不足 12 s 时起点 clamp 到 0，此时"片段内偏移"不再是 12 s 而等于 `chorusStart`
 * 本身。这里一次算清 `start` / `length` / `voiceOffset`，下游不必再各写一遍那段判断。
 */
export function excerptRange(chorusStart: number, seconds: number): ExcerptRange {
  const start = Math.max(0, chorusStart - PREROLL_SECONDS)
  return {
    start,
    length: chorusStart + seconds + TAIL_SECONDS - start,
    voiceOffset: chorusStart - start,
  }
}

/** 一个阶段的运行参数（与 `ProcessPort.run` 的第三参数同形）。 */
interface StageOptions {
  readonly timeoutMs: number
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/** 跑一个阶段，把三类失败（超时 / 退出码 / 信号中止）统一成中文 Error。
 *  `signal` 一路透传：取消时正在跑的 python 要被真的杀掉，否则它占着显卡。 */
async function stage(
  proc: ProcessPort,
  log: (line: string) => void,
  label: string,
  command: string,
  args: readonly string[],
  options: StageOptions,
): Promise<ProcessResult> {
  const result = await proc.run(command, args, options)
  if (result.timedOut) throw new Error(`${label}超时（超过 ${options.timeoutMs}ms 未结束）`)
  // `code === null` = 被信号打死（`signal` 中止）；同样不是成功。
  if (result.code !== 0) {
    const why = tail(result.stderr) === '' ? tail(result.stdout) : tail(result.stderr)
    const codeText = result.code === null ? '被信号中止' : `退出码 ${String(result.code)}`
    throw new Error(`${label}失败（${codeText}）：${why === '' ? '没有输出' : why}`)
  }
  log(`song-cover: ${label}完成（${String(result.durationMs)}ms）`)
  return result
}

/** 一次翻唱里**不变**的那部分：进程端口、两把工具的路径、超时、取消信号。 */
interface Rig {
  readonly proc: ProcessPort
  readonly log: (line: string) => void
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly pythonPath: string
  readonly rvcRoot: string
  readonly timeoutMs: CoverPortOptions['timeoutMs']
  readonly signal: AbortSignal | undefined
}

/**
 * 第 0 步：入参守卫 + 建目录，并算出试听段范围。举报错比"跑完 70 秒才发现"便宜得多。
 */
async function prepareRender(
  input: CoverRenderInput,
): Promise<{ readonly range: ExcerptRange; readonly coverDir: string }> {
  if (!Number.isFinite(input.chorusStart) || input.chorusStart < 0) {
    throw new Error(`副歌起点不合法：${String(input.chorusStart)}（必须是 ≥ 0 的秒数）`)
  }
  if (!Number.isFinite(input.seconds) || input.seconds <= 0) {
    throw new Error(`语音条长度不合法：${String(input.seconds)}（必须是 > 0 的秒数）`)
  }
  const stat = await fs.stat(input.audioFile).catch(() => null)
  if (stat === null || !stat.isFile()) throw new Error(`音源文件不存在：${input.audioFile}`)
  await fs.mkdir(input.outDir, { recursive: true })
  const coverDir = path.join(input.outDir, 'cover')
  await fs.mkdir(coverDir, { recursive: true })
  return { range: excerptRange(input.chorusStart, input.seconds), coverDir }
}

/** 第 1 步：切出副歌附近的试听段（wav，44.1 kHz 立体声 16 bit）。返回产物路径。 */
async function renderExcerpt(
  rig: Rig,
  audioFile: string,
  range: ExcerptRange,
  outDir: string,
): Promise<string> {
  const excerptFile = path.join(outDir, 'excerpt.wav')
  // 日志里的"副歌起点"= 片段起点 + 片段内偏移（clamp 之后两者相加才是原值）。
  rig.log(`song-cover: 切试听段 ${fixed(range.start)}s + ${fixed(range.length)}s`
    + `（副歌起点 ${fixed(range.start + range.voiceOffset)}s）`)
  await stage(rig.proc, rig.log, '切试听段', rig.ffmpegPath, [
    '-hide_banner', '-v', 'error', '-y',
    '-ss', fixed(range.start),
    '-t', fixed(range.length),
    '-i', audioFile,
    '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le',
    excerptFile,
  ], { timeoutMs: rig.timeoutMs.cut, signal: rig.signal })
  return excerptFile
}

/**
 * 第 2 步：跑 RVC 流水线（分离 + 模型 B + 混音）。返回 `cover/cover.mp3` 的路径。
 * `--out` 给绝对路径：`make_cover.py` 写的是 `OUT = (ROOT / args.out).resolve()`，
 * 相对路径会把产物落进 `D:\Bot\rvc\`——那是别人的仓库，不能往里写点歌产物。
 * `--key` **永远传**（`0` 也传）：它进 `RVC_F0_KEY` 再落进 `summary.json` 的
 * `f0_up_key`，那是"升调准则有没有真的生效"的唯一可核查证据；只在非 0 时才传会让
 * 两条路径分叉。升调只动人声音高曲线，伴奏与时长都不变，故裁剪偏移不受影响。
 */
async function runCover(rig: Rig, excerptFile: string, coverDir: string, keyUp: number): Promise<string> {
  rig.log(`song-cover: 开始分离 + 模型 B 转换（这一步最慢；人声升调 ${String(keyUp)} 半音）`)
  await stage(rig.proc, rig.log, '翻唱', rig.pythonPath, [
    'make_cover.py',
    '--input', excerptFile,
    '--out', coverDir,
    '--key', String(keyUp),
  ], { timeoutMs: rig.timeoutMs.cover, cwd: rig.rvcRoot, env: pythonEnv(rig.ffmpegPath), signal: rig.signal })
  const coverMp3 = path.join(coverDir, 'cover.mp3')
  const stat = await fs.stat(coverMp3).catch(() => null)
  if (stat === null || !stat.isFile()) {
    throw new Error('make_cover.py 正常退出，但没有产出 cover/cover.mp3（分离或混音阶段被跳过？）')
  }
  return coverMp3
}

/** 第 3 步：按副歌起点从完整混音里裁出语音条。 */
async function trimVoice(
  rig: Rig,
  coverMp3: string,
  range: ExcerptRange,
  voiceFile: string,
  seconds: number,
): Promise<void> {
  await stage(rig.proc, rig.log, '裁语音条', rig.ffmpegPath, [
    '-hide_banner', '-v', 'error', '-y',
    '-ss', fixed(range.voiceOffset),
    '-t', fixed(seconds),
    '-i', coverMp3,
    '-ac', '2', '-ar', '44100',
    voiceFile,
  ], { timeoutMs: rig.timeoutMs.trim, signal: rig.signal })
}

/**
 * 第 4 步：校验语音条，返回实测时长（秒）。
 *
 * 两件事分开做：解码证明"NapCat 那边放得出来"，`ffprobe` 证明"长度是对的"。
 * 只 `ffprobe` 会放过一个头完好、数据截断的 mp3（QQ 上表现为播一半就断）。
 * 偏差超过 0.75 s 就抛——半截语音条比一条明确的失败更糟。
 */
async function verifyVoice(rig: Rig, voiceFile: string, seconds: number): Promise<number> {
  await stage(rig.proc, rig.log, '校验解码', rig.ffmpegPath, [
    '-hide_banner', '-v', 'error',
    '-i', voiceFile,
    '-f', 'null', '-',
  ], { timeoutMs: rig.timeoutMs.trim, signal: rig.signal })
  const probe = await stage(rig.proc, rig.log, '读时长', rig.ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', voiceFile,
  ], { timeoutMs: rig.timeoutMs.trim, signal: rig.signal })
  const measured = probeDuration(probe.stdout)
  if (Math.abs(measured - seconds) > DURATION_TOLERANCE_SECONDS) {
    throw new Error(
      `语音条时长 ${measured.toFixed(2)}s 与请求的 ${fixed(seconds)}s 相差超过 `
      + `${String(DURATION_TOLERANCE_SECONDS)}s：`
      + '副歌太靠歌尾（片段不够长）或 cut/trim 参数对不上。'
      + '这条不发出去——半截语音条比一条明确的失败更糟。',
    )
  }
  return Math.round(measured * 1000) / 1000
}

/** 第 5 步：读 `cover/summary.json`，只回白名单字段。 */
async function readSummary(coverDir: string): Promise<Record<string, unknown>> {
  const summaryFile = path.join(coverDir, 'summary.json')
  const text = await fs.readFile(summaryFile, 'utf8').catch(() => null)
  if (text === null) throw new Error('make_cover.py 没有产出 cover/summary.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`cover/summary.json 不是合法 JSON（${tail(text, 120)}）`)
  }
  return pickSummary(parsed)
}

/**
 * 一行日志：时长 + 白名单字段数 + 本次升调。只写 `model`/`separator`/`f0_up_key`
 * 三个**非路径**字段——`f0_up_key` 是"升调准则有没有真的生效"的可核查证据。
 */
function describeSummary(
  durationSeconds: number,
  keyUp: number,
  summary: Record<string, unknown>,
): string {
  const model = summary['model']
  const separator = summary['separator']
  const scope = typeof model === 'string'
    ? `（model=${model}，separator=${typeof separator === 'string' ? separator : '?'}`
      + `，f0_up_key=${String(summary['f0_up_key'] ?? '?')}）`
    : ''
  return `song-cover: 语音条 ${fixed(durationSeconds)}s，升调 ${String(keyUp)} 半音，`
    + `summary 白名单 ${String(Object.keys(summary).length)} 个字段${scope}`
}

/** 按顺序调五个阶段，组装 `CoverResult`。失败时抛出的 Error 由上层记成 `failed`。 */
async function renderCover(options: CoverPortOptions, input: CoverRenderInput): Promise<CoverResult> {
  const rig: Rig = {
    proc: options.process,
    log: options.log,
    ffmpegPath: options.ffmpegPath,
    ffprobePath: ffprobeOf(options.ffmpegPath),
    pythonPath: options.pythonPath,
    rvcRoot: options.rvcRoot,
    timeoutMs: options.timeoutMs,
    signal: input.signal,
  }
  const { range, coverDir } = await prepareRender(input)
  const voiceFile = path.join(input.outDir, 'voice.mp3')
  const excerptFile = await renderExcerpt(rig, input.audioFile, range, input.outDir)
  const coverMp3 = await runCover(rig, excerptFile, coverDir, input.keyUp)
  await trimVoice(rig, coverMp3, range, voiceFile, input.seconds)
  const durationSeconds = await verifyVoice(rig, voiceFile, input.seconds)
  const summary = await readSummary(coverDir)
  rig.log(describeSummary(durationSeconds, input.keyUp, summary))
  return {
    voiceFile: path.resolve(voiceFile),
    durationSeconds,
    chorusStart: input.chorusStart,
    seconds: input.seconds,
    keyUp: input.keyUp,
    summary,
  }
}

export function createCoverPort(options: CoverPortOptions): CoverPort {
  return { render: (input) => renderCover(options, input) }
}
