/** 工具模块要用的东西：一份显式的依赖，而不是一个 cordis `Context`。
 *
 * `registerQQTools` 原来是一个 1250 行的函数，所有工具都是它的内部闭包——于是
 * "这个工具用了什么"只能靠读完整函数才知道，而任何一处改动都可能碰到别的工具。
 * 拆成功能目录之后，每个模块只需要这份清单上的几项，**用没用别的**一眼可见。
 *
 * 每一项都是**值或函数**，不是宿主类型：`features/` 不认识 cordis，也不认识
 * `QQChannelConfig` 之外的宿主形状。可选的那几项（表情库、好感度、知识库）为
 * `undefined` 时对应工具自己给出可读的拒绝理由，而不是注册失败。
 */

import type { QQChannelConfig } from '../config.js'
import type { QQApi } from '../ports/platform.js'
import type { OutboundQueue } from '../outbound.js'
import type { EmojiLibrary } from '../emoji-library.js'
import type { SentLog, SentLogHub } from '../sent-log.js'
import type { KnowledgeStore } from '../knowledge.js'
import type { MemorySearch, MemoryService } from '../ports/memory.js'
import type { HistoryService } from './history/service.js'

/** 好感度与阶段：`AffectionStore` 里工具真正用到的那几个方法。 */
export interface AffectionPort {
  book(delta: number, reason: string): Promise<unknown>
  setStage(stage: string, event: string): Promise<{ ok: boolean; note: string }>
  writeCustomHtml(html: string): Promise<void>
}

/** 工具注册用到的全部依赖。 */
export interface QQToolDeps {
  readonly api: QQApi
  readonly out: OutboundQueue
  readonly config: QQChannelConfig
  readonly log: (line: string) => void
  readonly library: EmojiLibrary | undefined
  readonly affection: AffectionPort | undefined
  readonly sentLog: SentLog | undefined
  /** 按房间取 sent-log（写侧按房间记账；缺省时退回 `sentLog` 那一份）。 */
  readonly sentLogHub?: SentLogHub | undefined
  readonly knowledge: KnowledgeStore | undefined
  /**
   * 新记忆系统（P6e，`memory.v2` 打开时才有）。
   *
   * 有它时 `qq_recall_memory` / `qq_memorize_fact` 走结构化记忆（带出处与时间、
   * 双写老 `entries.json`）；没有时走原来的知识库。**工具名与参数 schema 不变**
   * ——那是 P6d 的事。
   */
  readonly memory: MemoryService | undefined
  /** 深召回（原文块）：agent 主动搜索用。 */
  readonly memorySearch?: MemorySearch | undefined
  /** 服务端历史（A4）：本地会话日志没命中时回源。 */
  readonly history?: HistoryService | undefined
  /** 从一段文字里抽取知识条目（知识库没配抽取器时为 undefined）。 */
  readonly extract: ((source: string, text: string) => Promise<unknown>) | undefined
  /**
   * 机器人**确实是成员**的群号集合（带缓存）。
   *
   * 为什么它是依赖而不是各工具自己查：发送类工具都要回答"这个群我能发吗"，
   * 而 `get_group_list` 是一次 WebSocket 往返——每个工具各查一次就是每发一条消息
   * 多一次往返。缓存与降级规则收在实现里（见 `features/qq-tools.ts`）。
   */
  readonly knownGroups: () => Promise<Set<number>>
  /**
   * 高危群管动作的总闸门（踢人 / 全员禁言 / 设管理员）。
   *
   * 默认关闭：这类动作会真的影响到群成员，而"谁让咱做的"目前无法验证。
   */
  readonly assertDangerous: (action: string) => void
}
