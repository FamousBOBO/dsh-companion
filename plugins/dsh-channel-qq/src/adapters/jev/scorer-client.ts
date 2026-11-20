/** Jev-Style 打分器的**客户端**：把"一次打分"串起来（进程 + 线协议）。
 *
 * 为什么不是 HTTP 侧车：`jev-score` 本身就是"一行一个 JSON 请求、一行一个 JSON 回复"的
 * 常驻进程。中间再套一个 Python 或 HTTP 服务，只是多一个进程、多一份内存、多一处会挂的地方。
 * 实测 Node 直接 spawn 可用（`ready` 行 0.88 s 返回），所以这里直接 spawn。
 *
 * 文件内分工：线协议（argv / 请求 JSON / 回复解析）在 `scorer-protocol.ts`，
 * 进程外壳（启停 / 就绪 / 坏了的原因）在 `scorer-process.ts`，这里只做编排：
 *
 *   takeBroken → ensure（含启动那 0.9 秒）→ 写请求 → 等一行 → 解析
 *
 * 三个口径：
 *   1. **绝不抛**：每一步的失败都折成 {@link ScoreOutcome} 的一个分支；
 *   2. **超时覆盖全程**：`timeoutMs` 从 spawn 算起，否则第一次判断会平白多花一秒；
 *   3. **失败即回收**：写坏 / 超时的进程立刻 kill，不留一个半死的打分器跨轮复用。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Clock } from '../../ports/clock.js'
import {
  argsOf,
  describeError,
  parseLine,
  requestOf,
  resultsOf,
  totalMsOf,
  type ScoreOutcome,
  type ScoreQuestion,
  type ScorerInfo,
  type ScorerOptions,
} from './scorer-protocol.js'
import { createLineQueue, createScorerProcess } from './scorer-process.js'

/** 打分器客户端。 */
export interface ScorerClient {
  /**
   * 打一次分（必要时启动进程）。
   *
   * `timeoutMs` 覆盖**从 spawn 到拿到回复**的全过程：进程启动那 0.9 秒也算在里面，
   * 否则第一次判断会莫名其妙地多花一秒还把超时算成"进程卡住"。
   */
  score(input: {
    readonly prefix: readonly number[]
    readonly questions: readonly ScoreQuestion[]
    readonly timeoutMs: number
    readonly clock: Clock
  }): Promise<ScoreOutcome>
  /** 当前进程的就绪信息（没起过 = `null`）。 */
  info(): ScorerInfo | null
  /** 回收进程（幂等）。 */
  close(): Promise<void>
}

/** 系统 spawn：`binaryPath` 为空时退回 `JEV_SCORE_BIN`（打包后的路径由装配侧给）。 */
export function defaultSpawn(binaryPath: string): (args: readonly string[]) => ChildProcessWithoutNullStreams {
  const binary = binaryPath === '' ? (process.env['JEV_SCORE_BIN'] ?? 'jev-score') : binaryPath
  return (args) => spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

/** 造一个打分器客户端。`spawnFn` 注入是为了让测试塞假进程（真 spawn 要显卡与权重）。 */
export function createScorerClient(
  options: ScorerOptions,
  spawnFn: (args: readonly string[]) => ChildProcessWithoutNullStreams = defaultSpawn(options.binaryPath),
): ScorerClient {
  const queue = createLineQueue()
  const shell = createScorerProcess({ args: argsOf(options), queue, spawnFn })

  /** 发一次请求并等一行回复；失败分支都收在这里。 */
  async function exchange(
    input: { readonly prefix: readonly number[]; readonly questions: readonly ScoreQuestion[]; readonly timeoutMs: number; readonly clock: Clock },
    startedAt: number,
  ): Promise<ScoreOutcome> {
    const budget = Math.max(100, Math.trunc(input.timeoutMs))
    const ensured = await shell.ensure(budget, input.clock)
    if (!ensured.ok) return { kind: 'no-route', detail: ensured.detail }
    const proc = shell.current()
    if (proc === null) return { kind: 'no-route', detail: 'jev-score 进程不在' }
    try {
      proc.stdin.write(requestOf(input.prefix, input.questions) + '\n')
    } catch (error) {
      shell.kill()
      return { kind: 'failed', detail: `写请求失败：${describeError(error)}` }
    }
    const remaining = Math.max(100, budget - (input.clock.now() - startedAt))
    const line = await queue.next(remaining, input.clock)
    if (line === null) {
      shell.kill()
      return { kind: 'timeout', detail: `jev-score ${String(remaining)} ms 内没有回复` }
    }
    const parsed = parseLine(line)
    if (parsed === null) {
      shell.kill()
      return { kind: 'failed', detail: '回复不是合法 JSON 行' }
    }
    if (typeof parsed['error'] === 'string') {
      return { kind: 'failed', detail: `jev-score 报错：${parsed['error']}` }
    }
    const checked = resultsOf(parsed['results'])
    if (!checked.ok) return { kind: 'failed', detail: checked.detail }
    return {
      kind: 'scores',
      results: checked.results,
      totalMs: totalMsOf(parsed, input.clock.now() - startedAt),
    }
  }

  return {
    info: () => shell.info(),
    close: () => shell.shutdown(),
    async score(input): Promise<ScoreOutcome> {
      const startedAt = input.clock.now()
      const broken = shell.takeBroken()
      if (broken !== null) return { kind: 'no-route', detail: broken }
      return exchange(input, startedAt)
    },
  }
}
