/**
 * **独立进程 worker**（`reminders-multiprocess.test.ts` 的子进程）。
 *
 * 这个文件**不是**测试文件（文件名不以 `.test.ts` 结尾），所以不会被
 * `node --test "build/lib-test/test/*.test.js"` 收进来；它只由父进程 `fork` 起来，
 * 跑一个具体任务，把观测结果经 IPC 报回去。
 *
 * 协议（父进程对齐并发起点就靠它）：
 *   worker 启动 → `ready`（**还什么都没干**）
 *   父进程 → `job`
 *   父进程 → `go`（barrier 放行；此刻才 load store 并动手）
 *   worker → `holding` / `claimed` / `done{report}`
 *
 * 三条纪律：
 *   1. **假发送**：只调内存里的假适配器（记次数），绝不连 QQ / OneBot；
 *   2. **假时钟**：`now` 由父进程传进来（绝对毫秒），自己不做任何真实等待判定；
 *   3. 一切结论以**盘上文件**为准（内存影子状态证明不了跨进程）。
 */

import { ReminderStore } from '../src/features/reminders/store.js'
import { DEFAULT_CLAIM_TTL_MS } from '../src/features/reminders/claim.js'
import { dispatchOne } from '../src/features/reminders/dispatch.js'
import { storeFault } from '../src/features/reminders/store-contract.js'
import { systemClock } from '../src/ports/clock.js'
import { SqliteProcessMutex } from '../src/adapters/fs-store/process-lock.js'

interface Job {
  readonly type: 'job'
  readonly dir: string
  readonly task: 'claim' | 'dispatch' | 'claim-release-other' | 'inspect' | 'hold'
  readonly now: number
  readonly id: string
  readonly owner: string
  readonly holdMs?: number
  readonly failSend?: boolean
  readonly failClaimWrite?: boolean
}

interface Report {
  readonly pid: number
  readonly claimed: boolean
  readonly rejectCode: string | null
  /** 放回认领的结果（`release:STALE_STATE` = 认出"这不是我的"）。 */
  readonly releaseCode: string | null
  readonly faultCode: string | null
  readonly sends: number
  readonly claim: { by: string; until: number } | null
  readonly fired: boolean
  readonly writeModel: string
}

const send = (message: unknown): void => { if (process.send !== undefined) process.send(message) }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** 等父进程的某一种消息（`go`）。一次就够——本 worker 只跑一个任务。 */
function goSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.on('message', (raw: unknown) => {
      const message = raw as { type?: string }
      if (message.type === 'go') resolve()
    })
  })
}

function makeStore(job: Job): ReminderStore {
  const mutex = new SqliteProcessMutex(`${job.dir}/reminders.json`)
  const store = new ReminderStore(
    { enabled: true, dryRun: false, file: null } as never,
    { workspacePath: job.dir, dshHome: job.dir, log: () => {} },
    undefined,
    mutex,
  )
  if (job.failClaimWrite === true) {
    // **只让写盘失败**：这正是"claim 写入失败 ⇒ 一次都不许发"的现场。
    const io = (store as unknown as { io: { replaceSerialized: (bytes: string) => Promise<{ kind: 'committed' }> } }).io
    io.replaceSerialized = async () => { throw storeFault('PERSIST_FAILED', 'write', '桩：写盘失败（disk full）') }
  }
  return store
}

const rowOf = (store: ReminderStore, id: string): { claim?: { by: string; until: number } | null; fired: boolean } | null => {
  const found = store.list(50).find((item) => item.id === id)
  return found === undefined ? null : { claim: found.claim ?? null, fired: found.fired }
}

function reportOf(store: ReminderStore, job: Job, over: Partial<Report>): Report {
  const item = rowOf(store, job.id)
  return {
    pid: process.pid, claimed: false, rejectCode: null, releaseCode: null, faultCode: null, sends: 0,
    claim: item?.claim ?? null, fired: item?.fired === true, writeModel: store.writeModel(), ...over,
  }
}

/** 假时钟：`now()` 恒等于父进程给的绝对毫秒；定时器用真实实现（worker 里不需要精确定时）。 */
function fixedClock(at: number): { now(): number; date(): Date; setTimeout(fn: () => void, ms: number): { cancel(): void }; setInterval(fn: () => void, ms: number): { cancel(): void } } {
  return {
    now: () => at,
    date: () => new Date(at),
    setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); return { cancel: () => { clearTimeout(handle) } } },
    setInterval: (fn, ms) => { const handle = setInterval(fn, ms); return { cancel: () => { clearInterval(handle) } } },
  }
}

async function run(job: Job): Promise<void> {
  const store = makeStore(job)
  await store.load()
  if (job.task === 'hold') {
    // 拿到跨进程锁之后就不放：等父进程强杀（证明"崩溃自动释放"，不需要 TTL）。
    const mutex = new SqliteProcessMutex(`${job.dir}/reminders.json`)
    await mutex.acquire(5_000)
    send({ type: 'holding' })
    await sleep(30_000)
    return
  }
  if (job.task === 'inspect') {
    send({ type: 'done', report: reportOf(store, job, {}) })
    await store.close()
    return
  }
  let claimed = false
  let rejectCode: string | null = null
  let releaseCode: string | null = null
  let faultCode: string | null = null
  let sends = 0
  try {
    if (job.task === 'claim-release-other') {
      // 「认领被挡住 + 试着替别人放回」：两个动作都不许改动别人的租约。
      const attempt = await store.claim(job.id, job.owner, job.now, DEFAULT_CLAIM_TTL_MS)
      claimed = attempt.ok
      if (!attempt.ok) rejectCode = attempt.code
      // **无条件**试着放回（这才测得到"我会不会替别人解锁"）。带 owner ⇒ 应当被拒。
      const released = await store.releaseClaim(job.id, job.owner)
      releaseCode = released.ok ? null : released.code
    } else if (job.task === 'claim') {
      const attempt = await store.claim(job.id, job.owner, job.now, DEFAULT_CLAIM_TTL_MS)
      claimed = attempt.ok
      if (!attempt.ok) rejectCode = attempt.code
      else send({ type: 'claimed', claimed: true })
    } else {
      // **走真实投递入口 `dispatchOne()`**：认领 → （过期则收敛 unknown）→ 假发送 → 记账。
      // 这样 M8 验的才是"过期认领按 unknown 收敛、不重发"的实际代码路径，而不是测试里手搓的顺序。
      const target = store.list(50).find((item) => item.id === job.id)
      if (target === undefined) throw new Error(`没有 id=${job.id} 的提醒`)
      const clock = fixedClock(job.now)
      await dispatchOne({
        store,
        owner: job.owner,
        now: () => job.now,
        dryRun: () => false,
        allow: () => true,
        send: async () => {
          // 能走到发送 = 本进程确实拿到了这一轮（`dispatchOne` 不会在认领失败后调用 send）。
          claimed = true
          send({ type: 'claimed', claimed: true })
          if (job.holdMs !== undefined) await sleep(job.holdMs)
          sends += await fakeSend(job)
          return 'sent'
        },
        recordSent: async () => { await store.markFired(job.id, job.now); return true },
        markUnknown: async (id, reason) => { await store.markUnknown(id, reason, job.now) },
        haltDispatch: () => {},
        log: () => {},
        clock: clock as never,
      }, target)
    }
  } catch (error) {
    faultCode = String((error as { code?: unknown }).code ?? '')
  }
  send({ type: 'done', report: reportOf(store, job, { claimed, rejectCode, releaseCode, faultCode, sends }) })
  await store.close()
}

/** 假发送适配器：只记次数（**绝不**连 QQ / OneBot）。 */
async function fakeSend(job: Job): Promise<number> {
  if (job.failSend === true) throw new Error('桩：发送失败')
  return 1
}

process.on('message', (raw: unknown) => {
  const message = raw as Job & { type?: string }
  if (message.type !== 'job') return
  void (async () => {
    await goSignal()
    await run(message)
  })().catch((error: unknown) => {
    send({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  })
})

// 启动即报 `ready`：**这时还没做任何事**，父进程据此把所有 worker 对齐到同一起跑线。
send({ type: 'ready' })
