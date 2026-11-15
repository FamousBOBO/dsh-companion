import * as path from 'node:path'

/** `ffprobe` 的两件小事：推路径、读时长（外加两个共用的文本小工具）。
 *
 * 为什么单独一个文件：`cover.ts` 已经贴着 400 行硬上限（`scripts/check-size.mjs`），
 * 而这几样是**纯粹的进程/字符串知识**——与"翻唱五个阶段怎么排"无关。`cache.ts` 的
 * 缓存时长核对与本适配器的语音条校验用的是同一套口径，所以它们必须住在一起、从同一处
 * 被引进；`cover.ts` 仍 **re-export**，既有 import 一行都不用改。
 */

/** 是不是一个普通对象（用来收窄 `JSON.parse` 的 `any`）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取 stdout/stderr 末尾几行（ffmpeg/python 把真正的原因放在最后）。 */
export function tail(text: string, limit = 300): string {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim() !== '')
  const last = lines.slice(-3).join(' / ')
  return last.length <= limit ? last : `…${last.slice(-limit)}`
}

/**
 * 从 `ffmpegPath` 推出 `ffprobe` 的路径：配置里只有一个 ffmpeg 路径，而 ffprobe 与它
 * 同目录、同名不同前缀。这样配置不必多一个字段，也不怕两个工具版本对不上——同一个
 * 发行版的 ffprobe 才能可靠读出一份 mp3 的时长。
 */
export function ffprobeOf(ffmpegPath: string): string {
  const dir = path.dirname(ffmpegPath)
  const base = path.basename(ffmpegPath)
  const ext = path.extname(base)
  const stem = ext === '' ? base : base.slice(0, base.length - ext.length)
  const probeStem = stem.startsWith('ffmpeg') ? stem.replace(/^ffmpeg/, 'ffprobe') : 'ffprobe'
  return dir === '.' ? probeStem + ext : path.join(dir, probeStem + ext)
}

/** 读 `ffprobe -show_entries format=duration -of json` 的 duration。 */
export function probeDuration(stdout: string): number {
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

/** 秒数格式化：固定三位小数，命令行参数与日志都因此可复现。 */
export function fixed(value: number): string {
  return value.toFixed(3)
}

/**
 * 跑 `make_cover.py` 时的环境变量。`PYTHONUTF8=1` 是必须的：脚本
 * `print(json.dumps(..., ensure_ascii=False))` 里是中文，Windows 默认代码页的 stdout
 * 会 `UnicodeEncodeError` 把整次调用打死。另外把 ffmpeg 所在目录塞进 `PATH` 最前面：
 * 脚本自己还要起裸 `ffmpeg`（`to_wav` 与两次 loudnorm 导出），只有 PATH 可依；
 * `process.ts` 的 env 是**合并**语义，所以这是"插一个目录"而不是替换。
 * `ffmpegPath` 若是裸命令名（本机就是），`dirname` 为 `.`，不做改动。
 */
export function pythonEnv(ffmpegPath: string): Record<string, string> {
  const env: Record<string, string> = { PYTHONUTF8: '1' }
  const dir = path.dirname(ffmpegPath)
  if (dir !== '.') {
    const inherited = process.env.PATH ?? ''
    env['PATH'] = inherited === '' ? dir : `${dir}${path.delimiter}${inherited}`
  }
  return env
}