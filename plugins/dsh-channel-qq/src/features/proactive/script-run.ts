/** 事件书 `kind: script` 的执行（P6f）。
 *
 * §9.2 的限制逐条落地：`argv` 数组、`shell: false`、脚本必须落在
 * `<workspace>/scripts/` 内、超时**强杀**（SIGKILL）、stdout/stderr 截断记日志。
 * 路径限定与参数白名单直接复用 `cruise-run.ts` 的 `planCruise`（巡航脚本的同一
 * 套判据）——两处脚本入口共用一份"什么算合规"的答案。
 */

import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { planCruise, type CruisePlan } from '../../cruise-run.js'

export interface BookScriptSpec {
  readonly argv: readonly string[]
  readonly timeoutSec: number
}

/** 单次输出的截断上限（字符）；超出只保留前段并注明。 */
const OUTPUT_CAP = 2000

/** kill 之后等它咽气的宽限（毫秒），避免 Promise 永不落定。 */
const KILL_GRACE_MS = 2000

/**
 * 计划一次脚本执行（不做 IO）：校验 argv 并解析出（被限定在 scripts/ 内的）命令。
 *
 * @throws Error 中文文案：`planCruise` 的拒绝文案原样穿透
 */
export function planBookScript(spec: BookScriptSpec, workspaceDir: string): CruisePlan {
  for (const part of spec.argv) {
    // 事件书校验已保证没有空白，这里再兜一次：join(' ') 再切分必须是无损的。
    if (part === '' || /\s/.test(part)) throw new Error(`脚本参数不能含空白：${JSON.stringify(part)}`)
  }
  const plan = planCruise(spec.argv.join(' '), workspaceDir)
  // §9.2：脚本必须落在 workspace/scripts/ 内。命令本身是受限路径（shebang 脚本
  // 直接执行）或第一个路径参数被限定过，二者居其一才算"有脚本文件"。
  if (!path.isAbsolute(plan.command) && plan.scriptPath === null) {
    throw new Error('脚本事件必须落到 workspace/scripts/ 里的文件（argv 给出 scripts/xxx 或直接写脚本路径）')
  }
  return plan
}

export interface ScriptResult {
  readonly ran: boolean
  /** 状态里的失败原因（`timeout` / `exit 3` / `spawn 失败：…`）。 */
  readonly detail: string
  /** 截断后的 stdout / stderr 拼合（空串 = 没输出）。 */
  readonly output: string
}

/** 截断：只留前 OUTPUT_CAP 字符，并注明被截。 */
function capText(text: string): string {
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}…（已截断）` : text
}

/**
 * 跑一次脚本；进程级失败不抛，返回具名结果交给执行器落状态。
 *
 * @throws Error 只在"计划阶段"抛（argv 不合规 / 越界）——那是配置问题，不是进程问题
 */
export async function runBookScript(
  spec: BookScriptSpec,
  opts: { workspaceDir: string; log: (line: string) => void },
): Promise<ScriptResult> {
  const plan = planBookScript(spec, opts.workspaceDir)
  opts.log(`events: script started ${plan.command} ${plan.args.join(' ')} (timeout ${spec.timeoutSec}s, no shell)`)
  return await new Promise<ScriptResult>((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (result: ScriptResult): void => {
      if (settled) return
      settled = true
      if (killTimer !== null) clearTimeout(killTimer)
      if (graceTimer !== null) clearTimeout(graceTimer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(plan.command, plan.args, {
        cwd: opts.workspaceDir,
        // 关键：argv 数组会被原样交给 execve，没有解释环节（与巡航脚本同一条判据）。
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ran: false, detail: `spawn 失败：${error instanceof Error ? error.message : String(error)}`, output: '' })
      return
    }
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    // 超时强杀：先 SIGKILL（§9.2），再留一段宽限防 Promise 永不落定。
    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      graceTimer = setTimeout(() => {
        finish({ ran: false, detail: 'timeout', output: capText(`${stdout}${stderr ? `\n${stderr}` : ''}`) })
      }, KILL_GRACE_MS)
    }, spec.timeoutSec * 1000)
    child.on('error', (error) => {
      finish({ ran: false, detail: `spawn 失败：${error.message}`, output: capText(stdout) })
    })
    child.on('close', (code, signal) => {
      const output = capText(`${stdout}${stderr !== '' ? `\n${stderr}` : ''}`.trim())
      if (timedOut) {
        finish({ ran: false, detail: 'timeout', output })
        return
      }
      if (code === 0) {
        finish({ ran: true, detail: 'ran', output })
        return
      }
      finish({ ran: false, detail: code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`, output })
    })
  })
}
