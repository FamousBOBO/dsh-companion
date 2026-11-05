/** 访问门控（安全）：谁能触发 agent。
 *
 * 判定发生在**入站分发最前面**：不通过的消息既不进组包、也不进 agent，
 * 只按模式回一句「待主人批准」并记一条待批请求。
 *
 * 三个模式见 `config/sections/access.ts`；管理员始终允许（否则主人会被自己锁在外面）。
 */

import type { OneBotEvent } from '../../types.js'
import { parseInbound } from '../../core/message/parse.js'
import { isCalled } from '../../core/trigger.js'
import type { QQChannelConfig } from '../../config.js'
import type { PersonaPack } from '../../ports/persona.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import type { AccessKind, AccessStore } from './store.js'

export interface AccessDeps {
  readonly api: () => QQApi | null
  readonly out: () => OutboundQueue | null
  readonly persona: () => PersonaPack | null
  readonly config: () => QQChannelConfig['access']
  /** 根配置（判断群里这条消息是否真的叫了咱）。 */
  readonly rootConfig: () => QQChannelConfig
  readonly admins: () => readonly number[]
  readonly store: AccessStore
  readonly now: () => number
  readonly log: (line: string) => void
}

export class AccessService {
  constructor(private readonly deps: AccessDeps) {}

  /** 这条事件能不能进 agent；不通过时负责回「待批准」与通知主人。 */
  allow(event: OneBotEvent): boolean {
    if (event.post_type !== 'message' && event.post_type !== 'notice') return true
    // 自己发的消息（协议端回显）永远放行，否则未批准的群里会被自己的回声触发配对。
    if (event.user_id !== undefined && event.user_id === event.self_id) return true
    const config = this.deps.config()
    if (config.mode === 'open') return true
    const isGroup = event.message_type === 'group'
      || (event.post_type === 'notice' && typeof event.group_id === 'number')
    const id = isGroup ? event.group_id : event.user_id
    if (typeof id !== 'number') return true
    if (isGroup) return this.allowGroup(id, config, event)
    if (this.userAllowed(id, config)) return true
    if (config.mode === 'pairing') {
      void this.request('user', id, this.nameOf(event, false), event)
    } else {
      this.deps.log(`access: 拒绝 user ${id}（allowlist 未命中）`)
    }
    return false
  }

  /** 批准并通知对方。 */
  async approve(kind: AccessKind, id: number): Promise<{ ok: true }> {
    await this.deps.store.approve(kind, id)
    this.deps.log(`access: approved ${kind} ${id}`)
    this.send(id, kind, 'access/approved')
    return { ok: true }
  }

  /**
   * 拒绝（只移除请求与批准，不回消息）。
   *
   * P1-04：这里**必须**同时撤销已持久化的批准，否则"拒绝访问"只是把这行从待批列表里
   * 抹掉，盘上那条 `users` 依旧让下一次 `pairing` 放行。
   */
  async reject(kind: AccessKind, id: number): Promise<{ ok: true }> {
    await this.deps.store.reject(kind, id)
    this.deps.log(`access: rejected ${kind} ${id}（已同时撤销持久批准）`)
    return { ok: true }
  }

  list(): { mode: string; groupPolicy: string; users: readonly number[]; groups: readonly number[]; pending: readonly unknown[] } {
    return {
      mode: this.deps.config().mode,
      groupPolicy: this.deps.config().groupPolicy,
      users: this.deps.store.users(),
      groups: this.deps.store.groups(),
      pending: this.deps.store.pending(),
    }
  }

  /**
   * 私聊放行判定（P1-04）。
   *
   * **批准记录不许扩展白名单**：`allowlist` 只认 `admins + allowUsers`；持久化的
   * "曾经批准过"只在 `pairing` 模式下作数——pairing 的语义就是"我批过的人可以继续
   * 说话"，而 allowlist 的语义是"只认名单"。以前的写法把两者混在一起，于是
   * 一次批准能在**另一种模式**下继续放行（陌生人自动绑定 + 后来切 allowlist = 永久后门）。
   */
  private userAllowed(id: number, config: QQChannelConfig['access']): boolean {
    // 主人永远可用：这条在最前面，任何模式、任何持久状态都不影响。
    if (this.deps.admins().includes(id)) return true
    if (config.allowUsers.includes(id)) return true
    return config.mode === 'pairing' && this.deps.store.userApproved(id)
  }

  /**
   * 群放行（P1-04 同理）：`allowlist` 只认 `allowGroups`，**不认**持久批准。
   *
   * `groupPolicy: 'member'` 的语义是"我在里面就放行"（加群是主人的操作），与模式无关；
   * 持久化的群批准只在 `pairing` 下作数。
   */
  private allowGroup(id: number, config: QQChannelConfig['access'], event: OneBotEvent): boolean {
    if (config.allowGroups.includes(id)) return true
    if (config.groupPolicy === 'member') return true
    if (config.groupPolicy === 'pairing' && this.deps.store.groupApproved(id)) return true
    // 没人叫咱的群消息直接放掉（planner 本来也会 ignore）：不建请求、不回话。
    if (!this.addressed(event)) return false
    if (config.groupPolicy === 'pairing') {
      void this.request('group', id, `群 ${id}`, event)
    } else {
      this.deps.log(`access: 拒绝 group ${id}（群策略 allowlist 未命中）`)
    }
    return false
  }

  /** 群里这条消息是否真的叫了咱（@ 或关键词）；不要求 @ 的部署视为叫了。 */
  private addressed(event: OneBotEvent): boolean {
    if (event.message_type !== 'group') return true
    const root = this.deps.rootConfig()
    if (root.requireMention !== true) return true
    return isCalled(event, parseInbound(event), root)
  }

  private nameOf(event: OneBotEvent, isGroup: boolean): string {
    if (isGroup) return `群 ${String(event.group_id ?? '')}`
    return event.sender?.card ?? event.sender?.nickname ?? ''
  }

  /**
   * 陌生人资料一行（A4）：昵称/性别/等级/长签名——好友申请事件与陌生私聊配对
   * 通知都用它。查不到就空串（与 groupName 的兜底同款纪律）。
   */
  private async strangerLine(id: number): Promise<string> {
    const api = this.deps.api()
    if (api === null) return ''
    try {
      const info = await api.getStrangerInfo(id)
      const bits: string[] = []
      if (typeof info?.nickname === 'string' && info.nickname !== '') bits.push(info.nickname)
      if (typeof info?.sex === 'string' && info.sex !== '') bits.push(info.sex)
      const level = info?.qq_level ?? info?.level
      if (typeof level === 'number' && level > 0) bits.push(`Lv.${level}`)
      if (typeof info?.long_nick === 'string' && info.long_nick.trim() !== '') bits.push(`签名：${info.long_nick.trim().slice(0, 40)}`)
      return bits.join('，')
    } catch {
      return ''
    }
  }

  /** 群名：首次请求时查一次，查不到就用「群 <号>」。 */
  private async groupName(id: number): Promise<string> {
    const api = this.deps.api()
    if (api === null) return `群 ${id}`
    try {
      const info = await api.getGroupInfo(id)
      const name = typeof info?.group_name === 'string' ? info.group_name.trim() : ''
      return name === '' ? `群 ${id}` : name
    } catch {
      return `群 ${id}`
    }
  }

  /** 记请求、按冷却回一句、只在首次通知主人。 */
  private async request(kind: AccessKind, id: number, name: string, event: OneBotEvent | undefined): Promise<void> {
    const now = this.deps.now()
    const cooldown = Math.max(1, this.deps.config().replyCooldownMin) * 60_000
    const existing = this.deps.store.pending().find((item) => item.kind === kind && item.id === id)
    const shouldReply = existing === undefined || now - existing.lastNoticeAt >= cooldown
    const display = existing === undefined && kind === 'group'
      ? await this.groupName(id)
      : kind === 'user' && existing === undefined && name === ''
        ? await this.strangerLine(id)
        : name
    const { isNew } = await this.deps.store.request(kind, id, display, now)
    if (isNew) this.deps.log(`access: pending ${kind} ${id}${display === '' ? '' : ` (${display})`}`)
    // 私聊：首次 + 冷却后的提醒；群：默认完全不回，打开开关也只回一次。
    if (kind === 'user' && (isNew || shouldReply)) {
      if (event !== undefined) this.replyPending(kind, id, event)
      else this.send(id, kind, 'access/pending')
    } else if (kind === 'group' && isNew && this.deps.config().replyPendingInGroups) {
      if (event !== undefined) this.replyPending(kind, id, event)
      else this.send(id, kind, 'access/pending')
    }
    if (isNew && this.deps.config().notifyOwner) this.notifyOwner(kind, id, display)
  }

  private replyPending(kind: AccessKind, id: number, event: OneBotEvent): void {
    const isGroup = kind === 'group' || event.message_type === 'group'
    this.send(id, isGroup ? 'group' : 'user', 'access/pending')
  }

  private notifyOwner(kind: AccessKind, id: number, name: string): void {
    const owner = this.deps.admins()[0]
    const api = this.deps.api()
    const out = this.deps.out()
    if (owner === undefined || api === null || out === null) return
    if (kind === 'user' && owner === id) return
    const cmd = kind === 'group' ? `放行群 ${id}` : `放行 ${id}`
    const label = name === '' || name === `群 ${id}` ? '' : `（${name}）`
    const text = `新的访问请求：${kind === 'user' ? 'QQ' : '群'} ${id}${label}。`
      + `回复「${cmd}」或在后台「安全」页批准。`
    void out.push(() => api.sendPrivateMessage(owner, [{ type: 'text', data: { text } }]))
      .catch((error: unknown) => this.deps.log(`access: 通知主人失败：${error instanceof Error ? error.message : String(error)}`))
  }

  private send(id: number, kind: 'user' | 'group', key: string): void {
    const api = this.deps.api()
    const out = this.deps.out()
    const persona = this.deps.persona()
    if (api === null || out === null || persona === null) return
    let text = ''
    try {
      text = persona.render(key).trim()
    } catch (error) {
      this.deps.log(`access: 人格包缺 ${key}：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (text === '') return
    const message = [{ type: 'text' as const, data: { text } }]
    void out.push(() => kind === 'user' ? api.sendPrivateMessage(id, message) : api.sendGroupMessage(id, message))
      .catch((error: unknown) => this.deps.log(`access: 回复 ${kind} ${id} 失败：${error instanceof Error ? error.message : String(error)}`))
  }
}
