/** 副歌定位：跑 `tools/song/find_chorus.py`，把它的 JSON 变成 `ChorusPick`。
 *
 * 为什么这一层这么薄：算法在 Python 里（numpy + librosa），这里只负责三件事——
 * 把参数传对、把输出读回来、把"不可靠"翻译成 `null`。定位算法本身的取舍写在
 * `find_chorus.py` 的文件头里；这里只解释**为什么失败一律返回 null 而不是抛**。
 *
 * `null` 的合同：上层（队列）用它表示"定位不可靠"，于是走"从 0 秒开始裁一段"的
 * 兜底路径，仍然能发出语音条。如果这里抛，一次副歌定位失败就变成"整次点歌失败"，
 * 而那本来只是"这 25 秒可能不是最好听的那 25 秒"。**丢失一次点歌比定位不准更糟。**
 *
 * 四种失败都归到 `null`，但日志里各自说清楚（诊断时能分清是环境问题还是歌的问题）：
 *   1. 脚本超时（`ProcessPort` 已经 tree-kill 过）；
 *   2. 脚本非零退出（python 崩了 / 缺 librosa / 路径不对）；
 *   3. `ok !== true` 或 JSON 不可解析（这是脚本的**正常**失败协议）；
 *   4. IO 出问题（临时目录建不起来之类）。
 *
 * 中间产物全部落在系统临时目录：接口没有 `workRoot`，而"绝不写仓库里除 data 之外的
 * 位置"是硬约束，所以这里是 `os.tmpdir()` 下的一次性目录，用完即删（异常路径也删）。
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChorusPick, ChorusPort, ProcessPort, ProcessResult } from '../../features/song/types.js'

export interface ChorusPortOptions {
  readonly process: ProcessPort
  /** 跑 find_chorus.py 的 python（本机可用：`D:\Bot\rvc\.venv\Scripts\python.exe`，有 numpy+librosa）。 */
  readonly pythonPath: string
  /** `find_chorus.py` 的绝对路径（由调用方给，你别自己拼）。 */
  readonly scriptPath: string
  readonly log: (line: string) => void
  /** 超时（毫秒），由调用方从配置传入。 */
  readonly timeoutMs: number
}

/** 脚本输出的 JSON 形状（**只认这个**；多一个字段不影响，少一个就当不可靠）。 */
interface ChorusPayload {
  ok?: boolean
  reason?: string
  start?: number
  end?: number
  confidence?: number
  method?: string
  repeats?: number
  vocalRatio?: number
}

/** 有限数？`NaN` / `Infinity` / 字符串数字都不算（JSON 里出现它们只可能是上游写坏了）。 */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 0..1 之间的比例；缺省时给 `fallback`。 */
function ratio(value: unknown, fallback: number): number {
  const number = finite(value)
  return number === null ? fallback : Math.min(1, Math.max(0, number))
}

/**
 * JSON → `ChorusPick`；任何一处不合形状就返回 null（并给出原因）。
 *
 * 校验不是形式主义：`start` 是后面 ffmpeg 裁剪的参数，`NaN` 会让整条命令失败，
 * 而负的开始时间是"从结尾开始裁"——两者都会让语音条变成一段静音或空文件。
 */
function toPick(payload: ChorusPayload): { pick: ChorusPick | null; reason: string } {
  if (payload.ok !== true) {
    const reason = typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : '脚本回报 ok=false'
    return { pick: null, reason }
  }
  const start = finite(payload.start)
  const end = finite(payload.end)
  const confidence = finite(payload.confidence)
  if (start === null || end === null || confidence === null) {
    return { pick: null, reason: 'JSON 里 start/end/confidence 缺失或不是有限数' }
  }
  if (start < 0 || end <= start) return { pick: null, reason: `区间不合法：start=${String(start)} end=${String(end)}` }
  const repeats = finite(payload.repeats)
  return {
    pick: {
      startSeconds: start,
      endSeconds: end,
      confidence: ratio(confidence, 0),
      method: typeof payload.method === 'string' && payload.method !== '' ? payload.method : 'unknown',
      repeats: repeats === null ? 0 : Math.max(0, Math.round(repeats)),
      vocalRatio: ratio(payload.vocalRatio, 0),
    },
    reason: '',
  }
}

/** 日志里只放最后一条非空行：python 的 traceback 是多行的，全塞进去反而看不见结论。 */
function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.length === 0 ? '(无输出)' : (lines[lines.length - 1] ?? '')
}

/** 执行结果 → `ChorusPick | null`。这里是"失败协议"的唯一落点。 */
async function interpret(result: ProcessResult, outFile: string, log: (line: string) => void): Promise<ChorusPick | null> {
  if (result.timedOut) {
    log(`song/chorus: 定位超时（${String(result.durationMs)}ms），按"不可靠"处理`)
    return null
  }
  if (result.code !== 0) {
    // 非零退出不在脚本的失败协议里，说明它根本没跑完（缺依赖、路径错、崩溃）。
    log(`song/chorus: 脚本退出码 ${String(result.code ?? 'null')}，按"不可靠"处理：${lastLine(result.stderr)}`)
    return null
  }
  return await readPayload(outFile, log)
}

/** 读脚本写出的 JSON → pick。读不到 / 坏 JSON / `ok!==true` 都是 null。 */
async function readPayload(outFile: string, log: (line: string) => void): Promise<ChorusPick | null> {
  let text: string
  try {
    text = await fs.readFile(outFile, 'utf-8')
  } catch {
    log('song/chorus: 脚本没有写出 JSON，按"不可靠"处理')
    return null
  }
  let payload: ChorusPayload
  try {
    payload = JSON.parse(text) as ChorusPayload
  } catch {
    log(`song/chorus: JSON 不可解析（前 80 字符：${text.slice(0, 80).trim()}）`)
    return null
  }
  const verdict = toPick(payload)
  if (verdict.pick === null) {
    log(`song/chorus: 定位不可靠（${verdict.reason}）`)
    return null
  }
  const pick = verdict.pick
  log(`song/chorus: 副歌 ${pick.startSeconds.toFixed(1)}–${pick.endSeconds.toFixed(1)}s`
    + `，置信度 ${pick.confidence.toFixed(2)}（${pick.method}，重复 ${String(pick.repeats)} 次）`)
  return pick
}

export function createChorusPort(options: ChorusPortOptions): ChorusPort {
  const { process: processPort, pythonPath, scriptPath, log, timeoutMs } = options

  return {
    async locate(audioFile: string, opts?: { readonly signal?: AbortSignal }): Promise<ChorusPick | null> {
      if (String(audioFile ?? '').trim() === '') {
        log('song/chorus: 没有音频文件，跳过定位')
        return null
      }
      let workDir: string | null = null
      try {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-song-chorus-'))
        const outFile = path.join(workDir, 'chorus.json')
        const runOptions = opts?.signal === undefined
          ? { timeoutMs }
          : { timeoutMs, signal: opts.signal }
        const result = await processPort.run(pythonPath, [scriptPath, '--input', audioFile, '--out', outFile], runOptions)
        return await interpret(result, outFile, log)
      } catch (error) {
        // 走到这里说明是 IO/环境问题（临时目录建不起来、python 路径不存在被 ProcessPort
        // 报成 code=-1 之前就炸了……）。同样不抛：上层只要一个"可靠 / 不可靠"的答案。
        const reason = error instanceof Error ? error.message : String(error)
        log(`song/chorus: 定位失败：${reason}`)
        return null
      } finally {
        if (workDir !== null) {
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => { /* 删不掉不该影响结果 */ })
        }
      }
    },
  }
}
