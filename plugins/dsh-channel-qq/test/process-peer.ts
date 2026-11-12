/**
 * **跨进程测试的公共骨架**（`reminders-multiprocess.test.ts` 与 `reminders-claim-cas.test.ts` 共用）。
 *
 * 为什么单独一个文件：两个套件都要"fork 真子进程 + IPC barrier + 假时钟 + 假发送"这一套，
 * 复制两份之后**任何一边改了协议另一边就悄悄跑偏**（子进程协议本该只有一处定义）。
 *
 * 三条纪律（两个套件都靠它成立）：
 *   1. **真子进程**：`fork` 出来的是独立 pid / 独立模块实例 / 独立内存。同一进程里的两个
 *      `ReminderStore` 共享 `OWNERS`、串行队列与锁实例，"互斥"只能证明进程内互斥；
 *   2. **barrier 对齐起点**：所有 worker 都 `ready`（还什么都没干）之后才一起 `go`。
 *      没有 barrier，"并发"只是"两个进程都跑过"，没有任何一次真的重叠；
 *   3. **一切结论以盘上文件为准**，不用内存影子状态。
 */

import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Reminder } from '../src/features/reminders/reminder-model.js'

/** 2026-11-09 23:40:00 Asia/Shanghai（与事故那条同刻，这里只当绝对毫秒用）。 */
export const T0 = Date.UTC(2026, 10, 9, 15, 40, 0)
/** 造数收件人：生产里那个号**不许**出现在测试里。 */
export const OWNER = 10001

/** worker 与本文件同目录（`build/lib-test/test/`）；它的名字不以 `.test.` 结尾，不会被收进测试集。 */
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reminders-multiprocess.worker.js')

export const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'qq-cas-'))

/** 造一条"已经到点、还没触发"的提醒（默认一次性）。 */
export function row(over: Partial<Reminder> & { at: number }): Reminder {
  return {
    id: 'r-mp', text: '该睡了', room: 'dm', target: OWNER, createdBy: OWNER,
    created: T0, fired: false, firedAt: null, repeat: 'none', ...over,
  }
}

/** 把提醒写进 `dir/reminders.json`（模拟"停机期间就已经到期"的现场）。 */
export function seed(dir: string, items: Reminder[]): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'reminders.json')
  writeFileSync(file, `${JSON.stringify({ version: 1, reminders: items }, null, 2)}\n`, 'utf8')
  return file
}

/** 直接读盘（**不用** store 的内存状态：那证明不了跨进程）。 */
export const diskOf = (dir: string): Reminder[] =>
  (JSON.parse(readFileSync(path.join(dir, 'reminders.json'), 'utf8')) as { reminders: Reminder[] }).reminders

export interface WorkerReport {
  readonly pid: number
  readonly claimed: boolean
  readonly rejectCode: string | null
  readonly releaseCode: string | null
  readonly faultCode: string | null
  readonly sends: number
  readonly claim: { by: string; until: number } | null
  readonly fired: boolean
  readonly at: number | null
  readonly occurrence: { id: string; revision: number } | null
  readonly unknownReason: string | null
  readonly attempts: number | null
  readonly resolveCode: string | null
  readonly renewals: number
  readonly writeModel: string
}

export interface Job {
  readonly dir: string
  readonly task:
    | 'claim' | 'claim-expect' | 'claim-release-other' | 'claim-hold-renew'
    | 'dispatch' | 'dispatch-period' | 'inspect' | 'renew' | 'resolve-stale' | 'hold'
  readonly now: number
  readonly id: string
  readonly owner: string
  readonly expectAt?: number
  readonly expectOccurrence?: { id: string; revision: number } | null
  readonly expectOwner?: string
  readonly expectUntil?: number
  readonly holdMs?: number
  readonly failSend?: boolean
  readonly failClaimWrite?: boolean
}

export interface Booted {
  readonly child: ChildProcess
  readonly ready: Promise<void>
  readonly done: Promise<WorkerReport>
  /** 等到 worker 报某一种消息（`claimed` / `renewed` / `holding`）。 */
  once(type: string): Promise<Record<string, unknown>>
}

/** 起一个 worker，等它报 `ready`（**这时它还什么都没干**）。 */
export function boot(job: Job): Booted {
  const child = fork(WORKER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const ready = new Promise<void>((resolve) => {
    child.on('message', (message: { type?: string }) => { if (message.type === 'ready') resolve() })
  })
  let settled = false
  const done = new Promise<WorkerReport>((resolve, reject) => {
    child.on('message', (message: { type?: string; report?: WorkerReport }) => {
      if (message.type === 'done' && message.report !== undefined) { settled = true; resolve(message.report) }
    })
    child.on('error', (error) => { if (!settled) { settled = true; reject(error) } })
    // **被强杀**（`code === null`）不算"命令失败"——有意的杀进程用例；只有真非零退出才算失败。
    child.on('exit', (code) => {
      if (!settled && code !== 0 && code !== null) { settled = true; reject(new Error(`worker 退出码 ${String(code)}`)) }
    })
  })
  // 有的用例（持锁进程）永远不会有 `done`：别让未处理的 rejection 把整个文件带下水。
  done.catch(() => {})
  child.send({ type: 'job', ...job })
  return {
    child,
    ready,
    done,
    once: (type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`等 ${type} 超时（10s）`)) }, 10_000)
      child.on('message', (message: Record<string, unknown>) => {
        if (message.type === type) { clearTimeout(timer); resolve(message) }
      })
    }),
  }
}

/** **barrier**：所有 worker 都 `ready` 之后才一起 `go`，然后并行收结果。 */
export async function together(jobs: readonly Job[]): Promise<WorkerReport[]> {
  const boots = jobs.map(boot)
  await Promise.all(boots.map(async (item) => await item.ready))
  for (const item of boots) item.child.send({ type: 'go' })
  try {
    return await Promise.all(boots.map(async (item) => await item.done))
  } finally {
    for (const item of boots) item.child.kill()
  }
}

/** 起一个 worker 并按 barrier 放行（单进程场景也要 barrier：与多进程用例同一套时序）。 */
export async function alone(job: Job): Promise<WorkerReport> {
  const [report] = await together([job])
  if (report === undefined) throw new Error('worker 没回报结果')
  return report
}

/** 清理临时目录（连锁文件一起：`<dir>/reminders.json.lock.db`）。 */
export const cleanup = (dir: string): void => { rmSync(dir, { recursive: true, force: true }) }
