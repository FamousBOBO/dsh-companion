/** `ProcessPort` 的实现：跑一次外部命令（`ffmpeg` / `python`），收集输出、管超时。
 *
 * 为什么值得独立成一个文件：点歌链路里有两处外部进程（`ffmpeg` 把 m4s 转 wav、
 * `find_chorus.py` 定位副歌），翻唱那半段还有第三处。三处各自写一遍 spawn 的话，
 * 各自都会漏掉某一件必须做的事——而且漏掉的方式不会立刻报错，只会在某一次卡死，
 * 或者某次把 6 MB 的 ffmpeg 进度输出写进内存里才暴露。这个端口把那些事变成默认值：
 *
 *   - **绝不用 shell 拼字符串**（`shell: false` + 参数数组）：路径里有空格、歌名里有
 *     中文引号，走 shell 就是一次命令注入，或者一次莫名其妙的引号错。
 *   - `windowsHide: true`：Windows 上否则每次转码都会闪一个黑框（用户看得到的噪音）。
 *   - stdout/stderr **只留尾部 8 KiB，而且是边收边截**：ffmpeg 失败时真正有用的是
 *     最后几行，而它前面的进度输出在一小时的音频上是几十 MB。
 *   - 超时**连子孙一起杀**：`taskkill /T` 是 Windows 上唯一可靠的整棵树杀法；
 *     只杀父进程会让子进程继续占着 CPU，下一条点歌就更慢。
 *
 * **失败不抛**。`spawn` 的 `error` 事件（最典型的是 ENOENT：配置里的 `ffmpeg` /
 * `python` 路径不存在）不是"命令跑失败了"，而是"这条命令根本没起来"——两者对调用方
 * 含义完全不同，所以这里把它单独标成 `code: -1` 且 `stderr` 写明是 spawn 失败。
 * 但**仍然返回而不抛**：这个端口的合同是"失败不抛"（见 `features/song/types.ts` 的
 * `ProcessResult`）。如果 ENOENT 抛而别的失败不抛，每个调用方都得写两层 try/catch，
 * 而总会有人只写一层。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { ProcessPort, ProcessResult } from '../../features/song/types.js'

/** 每路输出只留尾部这么多字符（够看 ffmpeg 最后几条 error，又不会吃掉内存）。 */
const TAIL_CAP = 8 * 1024

/** kill 之后等它咽气的宽限：Windows 上 `close` 不一定会来，不能永久挂住。 */
const KILL_GRACE_MS = 1500

/**
 * 有界输出缓冲：**在收的时候就截**，而不是收完再截。
 *
 * 丢掉的字节数单独记着，收尾时在开头写一句"这里少了多少"：读日志的人需要知道
 * 自己看到的不是全部，否则会以为最后那一条错误就是全部原因。
 */
class BoundedTail {
  private text = ''
  private dropped = 0

  constructor(private readonly cap: number) {}

  push(chunk: string): void {
    this.text += chunk
    const overflow = this.text.length - this.cap
    if (overflow > 0) {
      this.dropped += overflow
      this.text = this.text.slice(overflow)
    }
  }

  /** 追加一行（用于 spawn 失败这种"事后才知道"的说明）。 */
  append(note: string): void {
    this.push(`${this.text === '' ? '' : '\n'}${note}`)
  }

  value(): string {
    if (this.dropped === 0) return this.text
    return `…（已截断前 ${String(this.dropped)} 字符）\n${this.text}`
  }
}

/**
 * 连子孙一起杀。
 *
 * POSIX 上 `child.kill()` 只杀进程自己；Windows 上没有"进程组"这回事。
 * `taskkill /T` 是 Windows 唯一可靠的整棵树杀法，所以在这里分支——
 * 这是 adapters 里允许的平台知识，不该泄漏给调用方。
 */
function killTree(child: ChildProcess | null): void {
  if (child === null || child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* taskkill 自己没起来：退回普通 kill，至少杀掉直接子进程 */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已经退出了 */
  }
}

/** 逐行回调的缓冲：`onLine` 只收完整行，半行留在缓冲里等下一次。 */
function feedLines(buffer: { text: string }, chunk: string, emit: (line: string) => void): void {
  buffer.text += chunk
  let nl = buffer.text.indexOf('\n')
  while (nl !== -1) {
    const line = buffer.text.slice(0, nl).replace(/\r$/, '')
    buffer.text = buffer.text.slice(nl + 1)
    if (line !== '') emit(line)
    nl = buffer.text.indexOf('\n')
  }
}

/** 一次运行需要的东西。与 `ProcessPort.run` 的第三个参数同形。 */
interface RunOptions {
  readonly cwd?: string
  readonly timeoutMs: number
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly onLine?: (line: string) => void
}

/**
 * 一次运行的完整生命周期。
 *
 * 为什么装进类而不是闭包：状态有九个（两个输出缓冲、两个行缓冲、子进程、两个定时器、
 * 两个标志），散在闭包里"哪一个已经结算了"就没人说得清；写成类的私有字段之后，
 * `finish()` 是唯一能改 `settled` 的地方——重复结算不可能发生。
 */
class ProcessRun {
  private settled = false
  private timedOut = false
  private child: ChildProcess | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly startedAt = Date.now()
  private readonly stdout = new BoundedTail(TAIL_CAP)
  private readonly stderr = new BoundedTail(TAIL_CAP)
  private readonly stdoutLines = { text: '' }
  private readonly stderrLines = { text: '' }
  /** 具名的中止监听：`removeEventListener` 不认匿名函数，必须留着同一个引用。 */
  private readonly onAbort = (): void => { this.abort() }

  constructor(
    private readonly options: RunOptions,
    private readonly resolve: (result: ProcessResult) => void,
  ) {}

  /** 起进程并挂上所有监听。 */
  start(command: string, args: readonly string[]): void {
    try {
      const launched = spawn(command, [...args], {
        cwd: this.options.cwd,
        // 关键：argv 数组原样交给 execve，没有解释环节。
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.options.env },
      })
      this.child = launched
      launched.stdout?.setEncoding('utf-8')
      launched.stderr?.setEncoding('utf-8')
      launched.stdout?.on('data', (chunk: string) => {
        this.stdout.push(chunk)
        feedLines(this.stdoutLines, chunk, (line) => this.options.onLine?.(line))
      })
      launched.stderr?.on('data', (chunk: string) => {
        this.stderr.push(chunk)
        feedLines(this.stderrLines, chunk, (line) => this.options.onLine?.(line))
      })
      // ENOENT 在这里出现（见文件头：标明是 spawn 失败，但仍返回而不是抛）。
      launched.on('error', (error) => {
        this.stderr.append(`spawn 失败：${error.message}`)
        this.finish(-1)
      })
      launched.on('close', (code) => { this.finish(code) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.stderr.append(`spawn 失败：${reason}`)
      this.finish(-1)
      return
    }
    this.options.signal?.addEventListener('abort', this.onAbort, { once: true })
    this.killTimer = setTimeout(() => { this.expire() }, this.options.timeoutMs)
  }

  /** 取消不是超时：调用方要能区分"等太久了"和"用户走开了"，所以只有超时置 `timedOut`。 */
  private abort(): void {
    this.stderr.append('（已取消）')
    killTree(this.child)
    this.graceTimer = setTimeout(() => { this.finish(null) }, KILL_GRACE_MS)
  }

  private expire(): void {
    this.timedOut = true
    killTree(this.child)
    // 宽限：杀完之后 `close` 通常马上到；不来的话也不能让 Promise 悬着。
    this.graceTimer = setTimeout(() => { this.finish(null) }, KILL_GRACE_MS)
  }

  /** 唯一的结算出口。清定时器、摘监听、交付结果，都在这里。 */
  private finish(code: number | null): void {
    if (this.settled) return
    this.settled = true
    if (this.killTimer !== null) clearTimeout(this.killTimer)
    if (this.graceTimer !== null) clearTimeout(this.graceTimer)
    this.options.signal?.removeEventListener('abort', this.onAbort)
    this.resolve({
      code,
      stdout: this.stdout.value(),
      stderr: this.stderr.value(),
      timedOut: this.timedOut,
      durationMs: Date.now() - this.startedAt,
    })
  }
}

/** 真正的执行。见文件头：任何失败都变成具名结果，不抛。 */
function runOnce(command: string, args: readonly string[], options: RunOptions): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    const run = new ProcessRun(options, resolve)
    run.start(command, args)
  })
}

export function createProcessPort(): ProcessPort {
  return {
    run: (command, args, options) => runOnce(command, args, options),
  }
}

/** 默认实例：没有理由换实现的调用方直接用它。 */
export const systemProcess: ProcessPort = createProcessPort()
