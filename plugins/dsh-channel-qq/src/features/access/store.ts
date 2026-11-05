/** 访问门控状态（安全）：已批准的用户/群 + 待批准请求。
 *
 * 落盘 `<dshHome>/channel-qq/access.json`。请求带 `lastNoticeAt`，用来做
 * 「同一请求者 30 分钟只回一次待批准」；批准/拒绝后请求从列表里移除。
 */

import { JsonStore } from '../../adapters/fs-store/json-store.js'

export type AccessKind = 'user' | 'group'

export interface PendingRequest {
  readonly kind: AccessKind
  readonly id: number
  readonly name: string
  readonly requestedAt: number
  lastNoticeAt: number
}

export interface AccessState {
  readonly version: 1
  users: number[]
  groups: number[]
  pending: PendingRequest[]
}

const EMPTY: AccessState = { version: 1, users: [], groups: [], pending: [] }

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : []
}

function isState(value: unknown): value is AccessState {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.version === 1 && Array.isArray(record.users) && Array.isArray(record.groups) && Array.isArray(record.pending)
}

export class AccessStore {
  private state: AccessState = { ...EMPTY, users: [], groups: [], pending: [] }
  private readonly store: JsonStore<AccessState>

  constructor(file: string, log: (line: string) => void) {
    this.store = new JsonStore<AccessState>(file, { log, validate: isState })
  }

  async load(): Promise<void> {
    const loaded = await this.store.load(EMPTY)
    this.state = {
      version: 1,
      users: numbers(loaded.users),
      groups: numbers(loaded.groups),
      pending: loaded.pending.filter((item): item is PendingRequest => item !== null && typeof item === 'object'
        && (item.kind === 'user' || item.kind === 'group') && typeof item.id === 'number'),
    }
  }

  userApproved(id: number): boolean { return this.state.users.includes(id) }
  groupApproved(id: number): boolean { return this.state.groups.includes(id) }
  pending(): readonly PendingRequest[] { return this.state.pending }
  users(): readonly number[] { return this.state.users }
  groups(): readonly number[] { return this.state.groups }

  /** 记一次请求；已存在则只更新名称与时间。返回是否新请求。 */
  async request(kind: AccessKind, id: number, name: string, now: number): Promise<{ isNew: boolean; lastNoticeAt: number }> {
    const existing = this.state.pending.find((item) => item.kind === kind && item.id === id)
    if (existing !== undefined) {
      existing.lastNoticeAt = now
      await this.save()
      return { isNew: false, lastNoticeAt: existing.lastNoticeAt }
    }
    const item: PendingRequest = { kind, id, name, requestedAt: now, lastNoticeAt: now }
    this.state.pending = [...this.state.pending, item].slice(-200)
    await this.save()
    return { isNew: true, lastNoticeAt: now }
  }

  /** 只更新"最近回复时间"（节流用），不新增请求。 */
  async touchNotice(kind: AccessKind, id: number, now: number): Promise<void> {
    const existing = this.state.pending.find((item) => item.kind === kind && item.id === id)
    if (existing === undefined) return
    existing.lastNoticeAt = now
    await this.save()
  }

  async approve(kind: AccessKind, id: number): Promise<void> {
    const list = kind === 'user' ? this.state.users : this.state.groups
    if (!list.includes(id)) list.push(id)
    this.state.pending = this.state.pending.filter((item) => !(item.kind === kind && item.id === id))
    await this.save()
  }

  /**
   * 拒绝：**同时撤销**已持久化的批准（P1-04）。
   *
   * 以前只删 pending，于是"拒绝访问 123"之后 `users` 里那条批准还在——下次
   * `userAllowed()` 照样放行，拒绝等于没发生。陌生人被自动绑定后再拒绝也是一样：
   * 批准留在盘上，模式一换回来就又通了。
   */
  async reject(kind: AccessKind, id: number): Promise<void> {
    if (kind === 'user') this.state.users = this.state.users.filter((item) => item !== id)
    else this.state.groups = this.state.groups.filter((item) => item !== id)
    this.state.pending = this.state.pending.filter((item) => !(item.kind === kind && item.id === id))
    await this.save()
  }

  /** 显式撤销一条批准（与 `reject` 的区别：只动批准，不动 pending）。 */
  async revoke(kind: AccessKind, id: number): Promise<boolean> {
    const list = kind === 'user' ? this.state.users : this.state.groups
    const index = list.indexOf(id)
    if (index < 0) return false
    list.splice(index, 1)
    await this.save()
    return true
  }

  private async save(): Promise<void> {
    await this.store.save({
      version: 1,
      users: [...this.state.users],
      groups: [...this.state.groups],
      pending: this.state.pending.map((item) => ({ ...item })),
    })
  }
}
