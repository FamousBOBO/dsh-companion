/** 打分器的**进程外壳**：启动、就绪、坏了的原因、退出。
 *
 * 与 `scorer-protocol.ts` 的分工：那个文件全是纯函数（argv、请求 JSON、回复解析），
 * 这个文件只碰进程。拆开的理由很实际——纯函数能在没有显卡/权重/子进程的环境里逐条断言，
 * 而进程外壳必须靠假 `spawn` 才能测。
 *
 * 四条口径：
 *   1. **只在第一次需要时启动**：没配置就不起进程，起了之后跨轮复用（启动一次约 0.9 秒）；
 *   2. **崩溃最多重建一次**：第二次还失败就记 `crash`，不再重试——否则会变成
 *      "每 50 秒 spawn 一次显卡模型"；
 *   3. **stdout 只当 JSON 行**：llama.cpp 的加载日志走 stderr（几百个点），不能混进来；
 *   4. **收尾的 kill 不吊住进程**：一个已经写坏掉的进程不该让这一轮判断多等。
 *
 * 状态全部收在一个 {@link ProcState} 里，函数都在模块级（不在闭包里）——
 * 于是每段都能单独读，也都能被 `check:size` 的函数行数上限看见。
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Clock, TimerHandle } from '../../ports/clock.js'
import { describeError, infoOf, parseLine, type ScorerInfo } from './scorer-protocol.js'

/** 启动失败的重试上限：超过就不再尝试。 */
export const MAX_SPAWN_FAILURES = 1

/** 优雅退出等多久之后强杀（毫秒）。 */
const SHUTDOWN_GRACE_MS = 3_000
/** `kill()` 里等多久强杀（毫秒）。 */
const KILL_GRACE_MS = 2_000

/** stdout 行队列：一行一次回复，等待者按 FIFO 拿。 */
export interface LineQueue {
  /** 等下一行（已经排队的直接拿；否则等）。超时返回 `null`。 */
  next(timeoutMs: number, clock: Clock): Promise<string | null>
  /** 进程退出时把所有等待者放空。 */
  drain(): void
  /** 有行到达。 */
  push(line: string): void
}

/** 造一个行队列。 */
export function createLineQueue(): LineQueue {
  const pending: string[] = []
  let waiters: Array<(line: string | null) => void> = []
  return {
    push(line: string): void {
      const waiter = waiters.shift()
      if (waiter === undefined) {
        pending.push(line)
        return
      }
      waiter(line)
    },
    drain(): void {
      const drained = waiters
      waiters = []
      pending.length = 0
      for (const waiter of drained) waiter(null)
    },
    next(timeoutMs: number, clock: Clock): Promise<string | null> {
      const buffered = pending.shift()
      if (buffered !== undefined) return Promise.resolve(buffered)
      return new Promise<string | null>((resolve) => {
        let settled = false
        let timer: TimerHandle | null = null
        const finish = (value: string | null): void => {
          if (settled) return
          settled = true
          timer?.cancel()
          resolve(value)
        }
        waiters.push(finish)
        timer = clock.setTimeout(() => finish(null), Math.max(1, Math.trunc(timeoutMs)))
      })
    },
  }
}

/** 进程外壳的共享状态。 */
interface ProcState {
  child: ChildProcessWithoutNullStreams | null
  ready: ScorerInfo | null
  spawnFailures: number
  /** 下一次调用必然失败的诊断（用完即清）。 */
  broken: string | null
}

/** 进程外壳。 */
export interface ScorerProcess {
  /** 确保进程起来了（必要时 spawn 并等 ready）。 */
  ensure(timeoutMs: number, clock: Clock): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>
  /** 当前进程（没起来 = `null`）。 */
  current(): ChildProcessWithoutNullStreams | null
  /** 就绪信息。 */
  info(): ScorerInfo | null
  /** 杀掉并清空状态。 */
  kill(): void
  /** 记一条"下一次调用必然失败"的诊断（用完即清）。 */
  takeBroken(): string | null
  /** 优雅退出。 */
  shutdown(): Promise<void>
}

/** 造进程外壳要的依赖。 */
export interface ScorerProcessDeps {
  readonly args: readonly string[]
  readonly queue: LineQueue
  readonly spawnFn: (args: readonly string[]) => ChildProcessWithoutNullStreams
}

/** stdout 分包 → 整行（`\r\n` 与 `\n` 都认）。 */
function feed(proc: ChildProcessWithoutNullStreams, onLine: (line: string) => void): void {
  let buffer = ''
  proc.stdout.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString()
    let cut = buffer.indexOf('\n')
    while (cut >= 0) {
      onLine(buffer.slice(0, cut))
      buffer = buffer.slice(cut + 1)
      cut = buffer.indexOf('\n')
    }
  })
}

/** 挂上 stdout / stderr / 退出钩子（stderr 只留尾巴，不当错误）。 */
function attach(state: ProcState, queue: LineQueue, proc: ChildProcessWithoutNullStreams): void {
  state.child = proc
  feed(proc, (line) => queue.push(line))
  let tail = ''
  proc.stderr.on('data', (chunk: Buffer | string) => {
    // llama.cpp 的加载日志是几百个点，留着只为诊断"为什么没就绪"。
    tail = (tail + chunk.toString()).slice(-400)
  })
  const forget = (reason: string): void => {
    state.child = null
    state.ready = null
    // 已经记过原因（启动超时 / 未就绪 / 解析失败）就不要被"进程退出"盖掉：
    // 那句 `退出（code …）` 是**结果**，真正的原因在它之前就已经确定了。
    state.broken ??= reason.slice(0, 300)
    queue.drain()
  }
  proc.once('exit', (code) => forget(`jev-score 退出（code ${String(code)}）${tail}`))
  proc.once('error', (error: Error) => forget(`jev-score 启动失败：${describeError(error)}`))
}

/**
 * 立刻杀掉（**不等优雅退出**）。
 *
 * 与 {@link stopGracefully} 分开是本文件的一条口径：`kill()` 只用于"这个进程已经坏了"
 * （回复解析失败、超时、启动没就绪）——那种情况下它连协议都不守，等它自己退出只是
 * 让这一轮判断多等两秒。优雅退出只属于 `close()`（那时进程是健康的）。
 */
function killNow(proc: ChildProcessWithoutNullStreams, emitExit: boolean): void {
  try {
    proc.stdin.destroy()
  } catch {
    /* 已经没了就算了 */
  }
  try {
    proc.kill()
  } catch {
    /* 已经没了就算了 */
  }
  // 假进程（测试里的）不会自己发 exit：这里补一次，让等待者与状态一起收尾。
  if (emitExit) setImmediate(() => proc.emit('exit', null))
}

/** 造一个进程外壳。 */
export function createScorerProcess(deps: ScorerProcessDeps): ScorerProcess {
  const state: ProcState = { child: null, ready: null, spawnFailures: 0, broken: null }

  function kill(): void {
    const proc = state.child
    state.child = null
    state.ready = null
    if (proc === null) return
    killNow(proc, true)
  }

  return {
    current: () => state.child,
    info: () => state.ready,
    kill,
    takeBroken(): string | null {
      const value = state.broken
      state.broken = null
      return value
    },
    async ensure(timeoutMs, clock) {
      return ensureStarted(state, deps, kill, timeoutMs, clock)
    },
    async shutdown(): Promise<void> {
      const proc = state.child
      if (proc === null) return
      state.child = null
      state.ready = null
      state.broken = null
      // 健康进程优雅退出：发 `quit` 让打分器自己释放显存，等一会儿，然后强杀。
      await new Promise<void>((resolve) => {
        let finished = false
        const finish = (): void => {
          if (finished) return
          finished = true
          resolve()
        }
        const timer = setTimeout(() => {
          try {
            proc.kill()
          } catch {
            /* 已经没了就算了 */
          }
          finish()
        }, SHUTDOWN_GRACE_MS)
        proc.once('exit', () => {
          clearTimeout(timer)
          finish()
        })
        try {
          proc.stdin.write('{"cmd":"quit"}\n')
          proc.stdin.end()
        } catch {
          clearTimeout(timer)
          finish()
        }
      })
    },
  }
}

/** 启动并等 `ready`：失败就留一句诊断，成功就记下就绪信息。 */
async function ensureStarted(
  state: ProcState,
  deps: ScorerProcessDeps,
  kill: () => void,
  timeoutMs: number,
  clock: Clock,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  if (state.child !== null && state.ready !== null) return { ok: true }
  if (state.broken !== null) return { ok: false, detail: state.broken }
  if (state.spawnFailures > MAX_SPAWN_FAILURES) {
    state.broken = `jev-score 连续 ${String(state.spawnFailures)} 次启动失败，不再重试`
    return { ok: false, detail: state.broken }
  }
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = deps.spawnFn(deps.args)
  } catch (error) {
    state.spawnFailures += 1
    state.broken = `jev-score spawn 抛错：${describeError(error)}`
    return { ok: false, detail: state.broken }
  }
  attach(state, deps.queue, proc)
  const line = await deps.queue.next(timeoutMs, clock)
  if (line === null) {
    state.spawnFailures += 1
    state.broken = 'jev-score 启动超时（没等到 ready 行）'
    kill()
    return { ok: false, detail: state.broken }
  }
  const parsed = parseLine(line)
  if (parsed === null || parsed['ready'] !== true) {
    state.spawnFailures += 1
    const why = parsed !== null && typeof parsed['error'] === 'string' ? parsed['error'] : 'ready 行不含 ready:true'
    state.broken = `jev-score 未就绪：${why}`
    kill()
    return { ok: false, detail: state.broken }
  }
  state.ready = infoOf(parsed)
  state.spawnFailures = 0
  return { ok: true }
}

