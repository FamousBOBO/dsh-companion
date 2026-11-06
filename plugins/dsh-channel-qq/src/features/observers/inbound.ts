/** 入站旁路观察：对**每一条**群消息都要做的事，与 agent 说不说话无关。
 *
 * 三件事，外加一条主群专属的：
 *
 *   1. **刷屏风控** —— 窗口内条数超限就提醒 / 禁言（规则在 `core/flood` 与
 *      `features/flood`）；
 *   2. **口癖学习** —— 被动收集群友的说话方式，攒够了推荐给模型；
 *   3. **链接卡片** —— 白名单群里的链接自动出卡；
 *   4. **偷表情包** —— 只在主群，且要真的收到图片。
 *
 * 它们原来写在 `index.ts` 的 `onEvent` 与 `observeInbound` 里——也就是说，
 * **组合根**里长着一段业务逻辑，而它恰恰是最容易被漏掉的一段：这些事没有工具、
 * 没有返回值，出问题只能靠"群里怎么没反应"发现。搬到这里之后，它们有一个明确的
 * 归属，`index.ts` 只剩"事件进来了 → 交给谁"。
 *
 * 纪律：**同步 + 发射后不管**。四件事一件都不许拖慢消息路径，也不许因为一次坏链接
 * 丢掉一条消息（所以每个分支都自己 catch，绝不向上抛）。
 */

import type { OneBotEvent } from '../../types.js'
import { parseInbound } from '../../core/message/parse.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { HttpClient } from '../../ports/http.js'
import type { QQChannelConfig } from '../../config.js'
import type { OutboundQueue } from '../../outbound.js'
import { FloodGuard, enforceFlood } from '../flood/guard.js'
import { autoResolveLinks } from '../../adapters/providers/links/index.js'
import type { LearnStore } from '../learn/store.js'
import type { EmojiStore } from '../../emoji.js'
import type { EmojiLibrary } from '../../emoji-library.js'
import { forwardInbound, type ExpressionBridgePort } from '../expression-bridge.js'

/** 主群偷表情包时的图片体积上限（原实现里的常量，语义未变）。 */
const MAX_STEAL_BYTES = 8 * 1024 * 1024

/**
 * 观察者要用的东西。
 *
 * 全部写成**取值函数**：这些对象在 `Service.init` 的不同阶段才被造出来
 * （表情库 → 表情 → 各功能 store → 风控），观察者却要在事件到来时就能用。
 * 取值函数让"还没造好"变成一个可判定的 `null`，而不是一个初始化顺序的坑。
 */
export interface InboundObserverDeps {
  readonly config: () => QQChannelConfig
  readonly log: (line: string) => void
  readonly platform: () => ChatPlatform | null
  readonly out: () => OutboundQueue | null
  readonly flood: () => FloodGuard | null
  readonly learn: () => LearnStore | null
  readonly emoji: () => EmojiStore | null
  readonly library: () => EmojiLibrary | null
  /**
   * 表情包入站旁路（端口来自 `companion-expression` 的进程级注册表）。
   *
   * 可选：装配里没接就是 `undefined`；接了但端口还没发布时给 `null`。每次现取，
   * 不缓存空结果——那个模块常常比本段晚挂载。
   */
  readonly expression?: () => ExpressionBridgePort | null
  /** 取回图片用的取回器（带 SSRF 闸门与体积上限）。 */
  readonly http: HttpClient
  /**
   * 给表情打视觉标用的宿主上下文。
   *
   * 类型直接取 `tagEntry` 的第一个参数：既不用在这里 import 宿主类型，也不用转型
   * （R7 会拦住 `as never`——那样等于把"宿主长什么样"的知识又散出来一份）。
   */
  readonly tagContext: () => Parameters<EmojiLibrary['tagEntry']>[0]
}

export class InboundObservers {
  constructor(private readonly deps: InboundObserverDeps) {}

  /**
   * 跑完这一条群消息的全部旁路工作。
   *
   * **同步返回**，异步的部分自己发射自己收尾——见文件头的纪律。
   */
  observe(event: OneBotEvent): void {
    this.track(event)
    this.stealSticker(event)
    this.forward(event)
  }

  /**
   * 表情包收集的入站旁路（`companion-expression` 的端口）。
   *
   * 装配里没接这一格就整段跳过；接了但端口还没发布时 `expression()` 给 `null`，
   * 也是一次判空就返回——这条路径上**不许**有任何 await、IO 或异常。
   */
  private forward(event: OneBotEvent): void {
    const bridge = this.deps.expression?.() ?? null
    if (bridge === null) return
    bridge.forwardInbound(event, this.deps.config().admins)
  }

  /** 风控 + 口癖 + 链接卡片。 */
  private track(event: OneBotEvent): void {
    const config = this.deps.config()
    if (config.groupEnabled === false) return
    const groupId = event.group_id
    const userId = event.user_id
    if (typeof groupId !== 'number' || typeof userId !== 'number') return
    // `plainText`，不是 `text`：这条路径只要**词**。显示渲染里带着
    // `[图片]` / `[表情:5]` / `[文件：…]`，把它们喂进来正是"`[图片]` 混进
    // 口癖库、还被算成刷屏"的原因。没有配文的图不算内容，直接跳过。
    const text = parseInbound(event).plainText.trim()
    if (text === '') return

    if (config.learn.enabled && config.learn.autoCapture) {
      this.deps.learn()?.observe({ text, userId, groupId })
    }

    const platform = this.deps.platform()
    const out = this.deps.out()
    if (platform === null || out === null) return
    const api = platform.api

    const flood = this.deps.flood()
    if (config.flood.enabled && flood !== null) {
      const decision = flood.observe({ groupId, userId, text, selfId: platform.selfId ?? config.selfId })
      if (decision !== null) {
        void enforceFlood(decision, { api, out, config, log: this.deps.log, groupId })
          .catch((error: Error) => this.deps.log(`flood enforcement failed: ${error.message}`))
      }
    }

    if (config.linkResolve.enabled) {
      void autoResolveLinks(text, groupId, config, api, out, this.deps.log)
        .catch((error: Error) => this.deps.log(`link auto-resolve failed: ${error.message}`))
    }
  }

  /**
   * 偷主群的表情包：只在主群、只对带图的群消息、且关掉"偷"就不做。
   *
   * 存下原图之后异步打一次视觉标（给模型挑表情包用）。打标失败不影响偷本身。
   */
  private stealSticker(event: OneBotEvent): void {
    const config = this.deps.config()
    const emoji = this.deps.emoji()
    if (!config.emoji.steal) return
    if (event.message_type === 'group') {
      // 主群语义不变：群聊关着或不是主群，一律不偷。
      if (config.groupEnabled === false) return
      if (config.primaryGroup === null || event.group_id !== config.primaryGroup) return
    } else if (event.message_type === 'private') {
      // 私聊偷表情（2026-10-31 用户要求）：本机群聊全关，主群那条路走不到。
      // 只认管理员发来的私聊图片，别人的私聊不落库。
      if (config.emoji.stealPrivate !== true) return
      const sender = event.user_id
      if (typeof sender !== 'number' || !config.admins.includes(sender)) return
    } else {
      return
    }
    if (emoji === null) return
    const urls = parseInbound(event).imageUrls
    if (urls.length === 0) return

    void (async () => {
      try {
        const entry = await emoji.steal(event)
        if (entry === null) return
        const library = this.deps.library()
        const url = urls[0]
        if (library === null || url === undefined) return
        // 消息里的图片地址 = 别人给的地址，必须过闸门。
        const res = await this.deps.http.request(url, { limit: MAX_STEAL_BYTES }).catch(() => null)
        if (res === null || !res.ok) return
        const mediaType = res.header('content-type')?.split(';')[0] ?? 'image/jpeg'
        await library.tagEntry(this.deps.tagContext(), entry, Buffer.from(res.bytes), mediaType)
        await library.save()
      } catch { /* best-effort */ }
    })()
  }
}
