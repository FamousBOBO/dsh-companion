/** 审批请求的磁盘存储：`<dir>/requests/<id>.json` + 队列目录 + 结果目录。
 *
 * 目录结构与《IM Bot 特权命令远程批准方案》§3.2 一致：
 *   requests/  agent 写（申请），root 侧读
 *   queue/     bot 写一个空文件即"请求执行"，systemd path 监听它
 *   results/   root 侧执行器写回执，bot 轮询后转发给管理员
 *
 * 目录权限由部署脚本设为 0700（root）。**这里不做权限判断**——那是部署侧的事，
 * 应用层只负责读写与状态机。
 */

import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { withLock } from '../../adapters/fs-store/mutex.js'
import {
  approveRequest, consumeRequest, createRequest, denyRequest, normalizeCommand,
  type ApprovalRequest,
} from '../../core/approval/gateway.js'

/** 默认目录；可用 `CHANNEL_QQ_APPROVAL_DIR` 覆盖。 */
export const DEFAULT_DIR = '/var/lib/dsh-approval'

export function approvalDir(): string {
  const fromEnv = process.env.CHANNEL_QQ_APPROVAL_DIR
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : DEFAULT_DIR
}

/** 开关：默认关（部署侧显式打开才生效）。 */
export function approvalEnabled(): boolean {
  return process.env.CHANNEL_QQ_APPROVAL === '1'
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

function paths(dir: string) {
  return {
    requests: path.join(dir, 'requests'),
    queue: path.join(dir, 'queue'),
    results: path.join(dir, 'results'),
  }
}

async function ensureDirs(dir: string): Promise<ReturnType<typeof paths>> {
  const p = paths(dir)
  for (const sub of [p.requests, p.queue, p.results]) await fs.mkdir(sub, { recursive: true, mode: 0o700 })
  return p
}

function isRequest(value: unknown): value is ApprovalRequest {
  return typeof value === 'object' && value !== null
    && typeof (value as ApprovalRequest).id === 'string'
    && typeof (value as ApprovalRequest).hash === 'string'
}

async function readRequestFile(file: string): Promise<ApprovalRequest | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'))
    return isRequest(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeRequest(dir: string, req: ApprovalRequest): Promise<void> {
  const p = await ensureDirs(dir)
  await atomicWriteFile(path.join(p.requests, `${req.id}.json`), JSON.stringify(req, null, 2))
}

/** 列出全部请求（最新在前）。 */
export async function listRequests(dir = approvalDir()): Promise<ApprovalRequest[]> {
  const p = await ensureDirs(dir)
  const names = await fs.readdir(p.requests).catch(() => [] as string[])
  const out: ApprovalRequest[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const req = await readRequestFile(path.join(p.requests, name))
    if (req !== null) out.push(req)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** 新建申请：L3 直接拒绝（抛出）；其余按级别决定是否需要令牌。 */
export async function requestCommand(raw: string, dir = approvalDir(), now = Date.now(), requestedBy?: string): Promise<ApprovalRequest> {
  const id = `appr-${now.toString(36)}-${randomBytes(3).toString('hex')}`
  const req = createRequest(raw, { id, now, digest, ...(requestedBy === undefined ? {} : { requestedBy }) })
  await writeRequest(dir, req)
  return req
}

/** 批准：生成一次性令牌并写请求文件；同时落一个队列标记触发 root 执行器。 */
export async function approveById(id: string, dir = approvalDir(), now = Date.now(), by?: string): Promise<ApprovalRequest> {
  const p = await ensureDirs(dir)
  const file = path.join(p.requests, `${id}.json`)
  // **读改写必须串行**：两次并发「批准」各自读到 pending、各自生成令牌，
  // 后写的覆盖先写的，前一个令牌就变成幽灵（2026-10-19 排查）。
  return await withLock(file, async () => {
    const req = await readRequestFile(file)
    if (req === null) throw new Error(`没有请求 ${id}`)
    const token = randomBytes(16).toString('hex')
    const approved = approveRequest(req, token, now, undefined, by)
    await writeRequest(dir, approved)
    // 空文件 = 队列标记（systemd path 监听目录变化）。
    await atomicWriteFile(path.join(p.queue, `${id}.req`), id)
    return approved
  })
}

export async function denyById(id: string, dir = approvalDir(), by?: string): Promise<ApprovalRequest> {
  const p = await ensureDirs(dir)
  const file = path.join(p.requests, `${id}.json`)
  return await withLock(file, async () => {
    const req = await readRequestFile(file)
    if (req === null) throw new Error(`没有请求 ${id}`)
    const denied = denyRequest(req, by)
    await writeRequest(dir, denied)
    return denied
  })
}

/** 执行器侧：核验令牌与命令，成功后把请求标记为 consumed。 */
export async function consumeById(id: string, raw: string, dir = approvalDir(), now = Date.now()): Promise<{ ok: true; request: ApprovalRequest } | { ok: false; reason: string }> {
  const p = await ensureDirs(dir)
  const file = path.join(p.requests, `${id}.json`)
  return await withLock(file, async () => {
    const req = await readRequestFile(file)
    if (req === null) return { ok: false, reason: 'not-found' as const }
    const result = consumeRequest(req, req.token ?? '', raw, now, digest)
    if (!result.ok) return { ok: false, reason: result.reason }
    await writeRequest(dir, result.request)
    return { ok: true, request: result.request }
  })
}

export interface ExecResult {
  id: string
  command: string
  ok: boolean
  exitCode: number | null
  output: string
  finishedAt: number
}

/** 执行器写回执。 */
export async function writeResult(result: ExecResult, dir = approvalDir()): Promise<void> {
  const p = await ensureDirs(dir)
  await atomicWriteFile(path.join(p.results, `${result.id}.json`), JSON.stringify(result, null, 2))
}

/**
 * bot 侧：**只读**列出尚未转发的回执。
 *
 * 删除由调用方在"真的发出去之后"做（{@link removeResult}）。旧实现先删后发，
 * 发送失败即永久丢失——而它恰好在最需要的时候（协议端刚重启）最容易失败。
 */
export async function listResults(dir = approvalDir()): Promise<ExecResult[]> {
  const p = await ensureDirs(dir)
  const names = await fs.readdir(p.results).catch(() => [] as string[])
  const out: ExecResult[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(p.results, name), 'utf-8')) as ExecResult
      out.push(parsed)
    } catch {
      // 半截文件留到下一轮；不要因为一条坏回执挡住其它。
    }
  }
  return out
}

/** 回执已经转发成功，删掉它。 */
export async function removeResult(id: string, dir = approvalDir()): Promise<void> {
  const p = await ensureDirs(dir)
  await fs.unlink(path.join(p.results, `${id}.json`)).catch(() => {})
}

/** 请求的简短展示（列表与回执共用）：`appr-xxx [L2] systemctl restart dsh`。 */
export function describeRequest(req: ApprovalRequest): string {
  const cmd = normalizeCommand(req.command)
  const short = cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd
  return `${req.id} [${req.level}] ${short}`
}
