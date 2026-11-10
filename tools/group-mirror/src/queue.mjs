/**
 * 有界队列 + 去重表（两件都按群分，互不影响）。
 *
 * 为什么必须有界：镜像的消费端是"真实模型判断"，它比事件到达慢得多。没有上限时，
 * 一次刷屏就把内存吃满，进程被系统杀掉——那反而会连累生产（同一台机器）。所以
 * 超限时**丢最旧的未处理事件**并计数，而不是让队列长大。
 *
 * 为什么去重键是 `group_id + message_id`：NapCat 断线重连可能重放最近的事件，
 * 而重放会让同一条群消息触发第二次主动发言判断——那是"她对着同一句话说了两遍"。
 * 去重表带 TTL，既有界又不会因为一个旧消息号永久占位。
 */

/**
 * 去重表。键是 `${groupId}:${messageId}`，值是该键第一次出现的时间。
 * 没有 message_id 的事件**不进这张表**（没有可靠的键，去重会变成猜）。
 */
export class DedupeTable {
  /**
   * @param {object} options
   * @param {number} options.ttlMs        一条记录最多记多久
   * @param {number} options.maxEntries   表的上限（超出按最旧淘汰）
   * @param {() => number} [options.now]  时钟（测试用）
   */
  constructor({ ttlMs, maxEntries, now = Date.now } = {}) {
    this.ttlMs = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : 10 * 60 * 1000
    this.maxEntries = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 2000
    this.now = now
    /** @type {Map<string, number>} 插入顺序即时间顺序（Map 保证），淘汰从头开始。 */
    this.seen = new Map()
  }

  /** 这个键是不是第一次出现（第一次返回 true 并登记，之后返回 false）。 */
  first(groupId, messageId) {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return true
    const key = String(groupId) + ':' + String(messageId)
    const at = this.now()
    this.sweep(at)
    if (this.seen.has(key)) return false
    this.seen.set(key, at)
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next()
      if (oldest.done) break
      this.seen.delete(oldest.value)
    }
    return true
  }

  /** 丢掉超过 TTL 的记录（从头扫，遇到第一条新鲜的即停：插入顺序就是时间顺序）。 */
  sweep(at = this.now()) {
    while (this.seen.size > 0) {
      const first = this.seen.entries().next()
      if (first.done) break
      const [key, stamp] = first.value
      if (at - stamp < this.ttlMs) break
      this.seen.delete(key)
    }
  }

  get size() {
    return this.seen.size
  }
}

/**
 * 有界事件队列。
 *
 * 丢弃策略是**丢最旧的未处理**而不是拒绝最新：镜像的目的是看"最近的群在聊什么"，
 * 保留最新的才有意义。丢了多少必须能数出来（`dropped`），否则"漏了几条"永远说不清。
 */
export class BoundedQueue {
  constructor({ maxEntries } = {}) {
    this.maxEntries = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 200
    /** @type {unknown[]} */
    this.items = []
    this.dropped = 0
    this.pushed = 0
  }

  /** 入队；返回本次是否丢掉了旧条目。 */
  push(item) {
    this.items.push(item)
    this.pushed += 1
    let droppedNow = false
    while (this.items.length > this.maxEntries) {
      this.items.shift()
      this.dropped += 1
      droppedNow = true
    }
    return droppedNow
  }

  /** 取走全部（消费端一次处理一批；取走后队列为空）。 */
  drain() {
    const all = this.items
    this.items = []
    return all
  }

  get size() {
    return this.items.length
  }
}
