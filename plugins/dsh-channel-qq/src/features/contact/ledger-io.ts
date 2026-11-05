/** 账本的**文件层**：怎么把它读成内部形状、怎么原子写回去、读不动时怎么留证据。
 *
 * 从 `store.ts` 拆出来的判据：这些事只关心"磁盘上的字节"，不关心"谁能改、什么时候
 * 能改"（那是 `store.ts` 的事务与锁）。分开之后，"坏文件 → `.corrupt` + 空表"这条
 * 容错只有一处、只被一次测试覆盖，而修改状态机的代码完全不必读这段 IO。
 *
 * 两条不可省的细节：
 *   - **读**：JSON 解析失败 / 根不是对象 / 版本不认识，都按"读不动"处理——把原文件
 *     改名成 `<file>.corrupt`（保留证据，不静默丢账），然后以空表起步。日志里必须带
 *     文件名与**版本号**，否则运维会以为数据丢了，而不是"被保留成 .corrupt 了"。
 *   - **写**：走 `atomicWriteFile`（tmp + fsync + rename）。进程死在写一半也不会留下
 *     半截 JSON——而这个文件里装着"有没有发过"的事实，读到半截等于把已发当成未发。
 *
 * 本文件不判断跨日（`ledger.rollCounters` 在洗数据里做）、不判断 `running` 要不要
 * 降级（那是"接管"的语义，在 `store.ts`）。
 */

import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import * as path from 'node:path'
import { readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import type { Clock } from '../../ports/clock.js'
import {
  MAX_REASONS,
  CONTACT_LEDGER_VERSION,
  describe,
  emptyLedger,
  isRecord,
  normalizeCandidate,
  normalizeCounters,
  normalizeDelivery,
  normalizeLease,
  rollCounters,
  sweepInterrupted,
  type ContactLedger,
} from './ledger.js'

export interface LedgerIoOptions {
  readonly file: string
  readonly clock: Clock
  readonly log: (line: string) => void
  /** 本地日键（时区由配置层决定）。 */
  readonly dayKey: (now: number) => string
  /**
   * 测试缝：替换**单次** rename（默认 `fs.rename`）。只用来钉住 Windows 的
   * `EPERM` 重试——让第一次抛错、第二次成功，断言最终写入成功且日志里有 retry。
   */
  readonly renameOnce?: (from: string, to: string) => Promise<void>
  /**
   * 测试缝：替换**一次**退避等待（默认是"注入时钟 + 真实定时器赛跑"，见 `backoff`）。
   *
   * 为什么需要它：默认退避在假时钟不推进时靠一枚 50ms 的真实定时器兜底，**并发跑全量
   * 测试**时这个 50ms 会随机器负载漂移，于是"6 次重试"的用例偶发变成不稳定用例。
   * 需要精确控制重试次数的测试传 `async () => {}` 即可，生产不传。
   */
  readonly retryDelay?: (ms: number) => Promise<void>
}

/** 一次读盘的结果：`swept` = 被降级的 `running` 条数（只有接管时为非零）。 */
export interface LedgerReadResult {
  readonly ledger: ContactLedger
  readonly swept: number
}

/**
 * 读盘并逐条洗数据。
 *
 * `sweep` 只有"启动"与"接管租约"两处为 true：把 `running` 降级成 `unknown`。
 * 普通写入前的重读不降级——否则一条**正在本进程发送中**的记录会被自己改成 unknown。
 */
export async function readLedgerFile(opts: LedgerIoOptions, sweep: boolean): Promise<LedgerReadResult> {
  const now = opts.clock.now()
  const day = opts.dayKey(now)
  const empty = (): ContactLedger => emptyLedger(day)
  const text = await readTextFileOrNull(opts.file)
  if (text === null) return { ledger: empty(), swept: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    await quarantine(opts.file, 'JSON 解析失败', opts.log)
    return { ledger: empty(), swept: 0 }
  }
  if (!isRecord(parsed)) {
    await quarantine(opts.file, '根不是对象', opts.log)
    return { ledger: empty(), swept: 0 }
  }
  const version = typeof parsed.version === 'number' ? parsed.version : -1
  if (version !== CONTACT_LEDGER_VERSION) {
    await quarantine(opts.file, `版本 ${String(version)} 不认识（期望 ${String(CONTACT_LEDGER_VERSION)}）`, opts.log)
    return { ledger: empty(), swept: 0 }
  }
  const ledger = empty()
  ledger.lease = normalizeLease(parsed.lease)
  if (isRecord(parsed.candidates)) {
    for (const raw of Object.values(parsed.candidates)) {
      const row = normalizeCandidate(raw)
      if (row !== null) ledger.candidates[row.id] = row
    }
  }
  if (isRecord(parsed.outbox)) {
    for (const raw of Object.values(parsed.outbox)) {
      const row = normalizeDelivery(raw)
      if (row !== null) ledger.outbox[row.id] = row
    }
  }
  // 跨日归零在这里（V-S1）：读盘即真值，跨日重启的第一次读盘就该是今天的额度。
  ledger.counters = rollCounters(normalizeCounters(parsed.counters, day), day)
  ledger.recentReasons = Array.isArray(parsed.recentReasons)
    ? parsed.recentReasons.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_REASONS)
    : []
  const swept = sweep ? sweepInterrupted(ledger, now) : 0
  return { ledger, swept }
}

/**
 * 原子写回（版本号由这里统一盖上，调用方不必记得）。
 *
 * 为什么不用共享的 `atomicWriteFile`：它在 Windows 上偶发 `EPERM`——`rename` 覆盖一个
 * 正被另一个句柄打开的目标时，Windows 会直接拒绝（POSIX 语义里这是原子的，不需要
 * `FILE_SHARE_DELETE`）。而这个账本里装着"有没有发过"的事实，写失败意味着"这次领没领到"
 * 没落盘。所以这里自带一份有界重试；共享件不动（别的模块也在用，改它风险更大）。
 */
export async function writeLedgerFile(opts: LedgerIoOptions, ledger: ContactLedger): Promise<void> {
  const file = opts.file
  const payload = `${JSON.stringify({ ...ledger, version: CONTACT_LEDGER_VERSION }, null, 2)}\n`
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.dsh-tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(tmp, 'w')
    // `handle.write` 而不是 `writeFile`：整仓禁止在 adapters 之外直接 writeFile（R4）。
    await handle.write(Buffer.from(payload, 'utf-8'), 0, undefined, 0)
    await handle.sync()
    await handle.close()
    handle = null
    await renameWithRetry(opts, tmp, file)
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** 重试次数、可重试的错误码（Windows 上真正会遇到的就是这三个）与退避基数。 */
const RENAME_ATTEMPTS = 6
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRY_BASE_MS = 10

/**
 * 退避一小会儿（10/20/30/40ms…）。
 *
 * 用**注入的时钟**（测试推进假时钟即可复现重试；生产就是 `systemClock`），并且和一枚
 * 真实定时器赛跑：假时钟整段测试都不推进时，重试不会把调用方挂死（否则一次偶发
 * `EPERM` 会让整个测试超时，而不是"重试后成功"）。用完清定时器。
 */
async function backoff(clock: Clock, ms: number): Promise<void> {
  const holder: { timer: { cancel(): void } | null } = { timer: null }
  const viaClock = new Promise<void>((resolve) => { holder.timer = clock.setTimeout(resolve, ms) })
  // 真实定时器**不 unref**：重试期间就该让事件循环等着（有界 ≤500ms）。
  // unref 过的定时器在"其它活都干完了"时不会被调度，于是退避永远不结束——
  // 现场表现就是一句 `Detected unsettled top-level await`。
  const viaReal = new Promise<void>((resolve) => { void setTimeout(resolve, Math.max(50, Math.min(ms, 500))) })
  try {
    await Promise.race([viaClock, viaReal])
  } finally {
    holder.timer?.cancel()
  }
}

/** `rename` 有界重试；重试耗尽就**明确失败**（调用方记日志，绝不静默丢账）。 */
async function renameWithRetry(opts: LedgerIoOptions, from: string, to: string): Promise<void> {
  const rename = opts.renameOnce ?? fs.rename
  const wait = opts.retryDelay ?? (async (ms: number) => { await backoff(opts.clock, ms) })
  let last: unknown = null
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!RETRYABLE_RENAME_CODES.has(code)) throw error
      last = error
      opts.log(`contact: 账本改名被占用（${code}，第 ${String(attempt)}/${String(RENAME_ATTEMPTS)} 次），稍后重试`)
      if (attempt < RENAME_ATTEMPTS) await wait(RETRY_BASE_MS * attempt)
    }
  }
  throw new Error(`账本改名失败（已重试 ${String(RENAME_ATTEMPTS)} 次）：${describe(last)}`)
}

/** 把读不动的账本改名成 `.corrupt`（保留证据），目录里不留下一个会被反复读的坏文件。 */
async function quarantine(file: string, why: string, log: (line: string) => void): Promise<void> {
  const target = `${file}.corrupt`
  const source = path.basename(file)
  try {
    await fs.rm(target, { force: true })
    await fs.rename(file, target)
    log(`contact: 账本 ${source} 读不动（${why}），已保留为 ${path.basename(target)}，本轮以空表起步`)
  } catch (error) {
    log(`contact: 账本 ${source} 读不动（${why}），且备份失败：${describe(error)}`)
  }
}
