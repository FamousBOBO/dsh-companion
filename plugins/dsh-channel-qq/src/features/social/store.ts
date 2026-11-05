/** 好友/群邀请请求的状态存储（社交面）。
 *
 * 落盘 `<dshHome>/channel-qq/social-requests.jsonl`（追加式、后写胜出——与记忆
 * 存储同一套约定）。每个请求保存 QQ 的 `flag`（批准/拒绝必须原样回传），所以
 * 主人回复「同意好友 <QQ>」时才能对上一次具体的申请，而不是靠猜。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { withLock } from '../../adapters/fs-store/mutex.js'

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/** 一条好友申请或群邀请。 */
export interface SocialRequest {
  readonly kind: 'friend' | 'group-invite'
  /** 好友申请=申请人；群邀请=要进的群号（给主人看的键）。 */
  readonly id: number
  /** 申请者的 QQ（群邀请时=邀请人）。 */
  readonly fromId: number
  /** 展示名（好友备注/昵称；群名）。 */
  readonly name: string
  /** 验证消息。 */
  readonly comment: string
  /** 原样回传给 set_*_add_request 的 flag。 */
  readonly flag: string
  readonly at: number
  status: RequestStatus
}

export class SocialStore {
  private readonly byKey = new Map<string, SocialRequest>()
  private readonly file: string

  constructor(dir: string, private readonly log: (line: string) => void) {
    this.file = path.join(dir, 'social-requests.jsonl')
  }

  async load(): Promise<number> {
    this.byKey.clear()
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf-8')
    } catch {
      return 0
    }
    let bad = 0
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        const row = JSON.parse(text) as SocialRequest
        if (typeof row?.flag !== 'string' || typeof row?.id !== 'number') throw new Error('bad row')
        this.byKey.set(keyOf(row.kind, row.id), row)
      } catch {
        bad += 1
        if (bad <= 3) this.log(`social: 跳过一条坏记录：${text.slice(0, 60)}`)
      }
    }
    return this.byKey.size
  }

  /** 已有的未决请求（同一 key 去重——同一个人重复申请只留一条）。 */
  pending(kind: 'friend' | 'group-invite', id: number): SocialRequest | undefined {
    const row = this.byKey.get(keyOf(kind, id))
    return row !== undefined && row.status === 'pending' ? row : undefined
  }

  listPending(): SocialRequest[] {
    return [...this.byKey.values()]
      .filter((row) => row.status === 'pending')
      .sort((a, b) => b.at - a.at)
  }

  /** 记录/更新一条请求；返回它（isNew 表示第一次出现）。 */
  async put(row: SocialRequest): Promise<{ row: SocialRequest; isNew: boolean }> {
    const key = keyOf(row.kind, row.id)
    const isNew = this.byKey.get(key) === undefined
    await withLock(this.file, async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.appendFile(this.file, JSON.stringify(row) + '\n', 'utf-8')
    })
    this.byKey.set(key, row)
    return { row, isNew }
  }

  /** 取一条未决请求（批准/拒绝时用）。 */
  take(kind: 'friend' | 'group-invite', id: number): SocialRequest | undefined {
    return this.pending(kind, id)
  }

  async settle(row: SocialRequest, status: 'approved' | 'rejected'): Promise<void> {
    const next = { ...row, status }
    await withLock(this.file, async () => {
      await fs.appendFile(this.file, JSON.stringify(next) + '\n', 'utf-8')
    })
    this.byKey.set(keyOf(next.kind, next.id), next)
  }
}

function keyOf(kind: 'friend' | 'group-invite', id: number): string {
  return `${kind}:${id}`
}

/** 后台/工具面的视图（flag 不外泄给模型——那是只有主人指令链该用的凭据）。 */
export function describeRequest(row: SocialRequest): string {
  const stamp = new Date(row.at).toISOString().slice(5, 16).replace('T', ' ')
  const head = row.kind === 'friend' ? `好友 ${row.id}（${row.name}）` : `群邀请 → ${row.id}（${row.name}）`
  const comment = row.comment === '' ? '' : `：${row.comment.slice(0, 40)}`
  return `${head}${comment} [${stamp}]`
}

/** 保持与文件写入同层的原子写可用（导出便于测试）。 */
export { atomicWriteFile }
