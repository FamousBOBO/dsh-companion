/** 巡航任务（后台里配的周期性工作区脚本）的启动器。
 *
 * 旧实现是 `spawn(command, parts, { shell: true })`，其中 `parts` 来自
 * `script.split(' ')`，而 `script` 是后台可以随手改的字符串。三者叠加等于
 * **一条从"改后台配置"通到"在服务器上以 root 执行任意命令"的路**：
 * 只要 `admin.host` 是 0.0.0.0（旧默认值就是），这条路的入口在公网上。
 *
 * 现在：不经 shell、按 argv 数组直接 exec、脚本文件限定在 `<workspace>/scripts/`
 * 之下、单次 60 秒超时。`shell: true` 一去，`;` `&&` `|` `$()` 这些就没有解释器
 * 可以落脚；路径限定则挡住了 `../../` 往上跑。
 *
 * `planCruise()` 是纯函数（不做 IO），所以规则本身可以在本地被测试逐条钉住。
 */

import * as path from 'node:path'
import { spawn } from 'node:child_process'

/** 单次巡航的硬超时。 */
export const CRUISE_TIMEOUT_MS = 60_000

/** 允许直接写名字的命令（不带路径的解释器）。其余必须给 `scripts/` 下的相对路径。 */
const BARE_COMMAND = /^[A-Za-z0-9._-]+$/

/**
 * 参数里允许的字符：够表达路径、选项、数字，但**没有任何 shell 元字符**。
 *
 * 这一段是白名单而不是黑名单——写漏一个字符只会让某个写法被多拒一次，
 * 不会放进来一个能落脚的解释器。
 */
const SAFE_ARG = /^[A-Za-z0-9._:@+,=/\\-]+$/

export interface CruisePlan {
  /** 可执行文件名或绝对路径。 */
  command: string
  args: string[]
  /** 解析后的脚本绝对路径（解释器的第一个脚本参数）；没有脚本参数时为 null。 */
  scriptPath: string | null
}

/**
 * 把一个巡航配置里的 `script` 字符串变成 argv 数组。
 *
 * 语法：`<命令> [参数…]`，空格分隔。命令可以是 `node` 这样的裸名字，
 * 也可以是 `scripts/foo.sh` 这样的**工作区相对路径**（`script` 字段一直是
 * 相对工作区解释的，`cwd` 也是工作区根）。
 *
 * 路径类参数一律要求落在 `<workspace>/scripts/` 之下：这样"脚本"这个概念的
 * 边界就是文件系统里真实存在的一个目录，`../../` 和绝对路径都跑不出去。
 *
 * @param script 配置里的原始字符串，如 `node scripts/heartbeat.mjs --once`
 * @param workspaceDir 工作区根目录（绝对路径）
 * @throws Error 中文文案：不合规的写法直接拒绝，并把原因说清楚
 */
export function planCruise(script: string, workspaceDir: string): CruisePlan {
  const raw = script.trim()
  if (raw === '') throw new Error('巡航任务为空：script 没写')
  // 只按空格/制表符切分；换行、引号这类字符留在段内，稍后被 SAFE_ARG 挡掉。
  const parts = raw.split(/[ \t]+/).filter((p) => p !== '')
  const head = parts.shift()
  if (head === undefined) throw new Error('巡航任务为空：script 没写')

  const workspace = path.resolve(workspaceDir)
  const scriptsRoot = path.join(workspace, 'scripts')

  /** 把一段路径收敛到 workspace/scripts/ 之内，越界即拒绝。 */
  const confine = (candidate: string): string => {
    const abs = path.resolve(workspace, candidate)
    const rel = path.relative(scriptsRoot, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`巡航脚本必须放在 workspace/scripts/ 里（写 scripts/xxx）：${candidate}`)
    }
    return abs
  }

  let command: string
  if (BARE_COMMAND.test(head)) {
    command = head
  } else if (head.includes('/') || head.includes('\\')) {
    command = confine(head)
  } else {
    throw new Error(`巡航命令不合法：${head}`)
  }

  const args: string[] = []
  let scriptPath: string | null = null
  for (const part of parts) {
    if (!SAFE_ARG.test(part)) {
      throw new Error(`巡航参数含不允许的字符：${part}`)
    }
    // 像文件名的参数一律收敛到 scripts/ 之内；纯选项（-x、--flag）原样保留。
    // 「像文件名」= 带路径分隔符，或带一个**以字母开头**的扩展名。
    // 后者排除掉 `1.5` 这类数字，避免把 `--timeout=1.5` 误判成路径。
    const looksLikePath = part.includes('/') || part.includes('\\') || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(part)
    if (looksLikePath) {
      const abs = confine(part)
      if (scriptPath === null) scriptPath = abs
      args.push(abs)
      continue
    }
    args.push(part)
  }
  return { command, args, scriptPath }
}

export interface RunCruiseOptions {
  /** 工作区根目录（进程 cwd，也是 `script` 里相对路径的基准）。 */
  cwd: string
  timeoutMs?: number
  log?: (line: string) => void
}

/**
 * 跑一次巡航任务；失败只记日志，不抛给调用方（定时器里抛出来没人接）。
 *
 * @returns 是否真的启动了进程。
 */
export async function runCruiseScript(script: string, opts: RunCruiseOptions): Promise<boolean> {
  const log = opts.log ?? ((): void => {})
  let plan: CruisePlan
  try {
    plan = planCruise(script, opts.cwd)
  } catch (error) {
    log(`cruise rejected: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  const timeout = opts.timeoutMs ?? CRUISE_TIMEOUT_MS
  try {
    const child = spawn(plan.command, plan.args, {
      cwd: opts.cwd,
      stdio: 'ignore',
      // 关键：不经过 shell。argv 数组会被原样交给 execve，没有任何解释环节。
      shell: false,
      timeout,
    })
    child.on('error', (error: Error) => log(`cruise spawn failed: ${error.message}`))
    child.on('exit', (code, signal) => {
      if (signal !== null) log(`cruise killed by ${signal} (timeout ${timeout}ms?)`)
      else if (code !== 0) log(`cruise exit ${code}: ${script}`)
    })
    log(`cruise started: ${plan.command} ${plan.args.join(' ')} (timeout ${timeout}ms, no shell)`)
    return true
  } catch (error) {
    log(`cruise spawn threw: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
