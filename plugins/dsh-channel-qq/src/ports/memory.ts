/** 记忆检索的端口：入站组包在拼提示词之前问一句"这回合想起点什么"。
 *
 * 为什么是端口而不是直接 import `features/memory`：`app/` 只依赖 `core/` 与 `ports/`
 * （R1/R8），而记忆的实现在功能层——它可以被换掉（e2 会把关键词换成向量 + 关键词混
 * 合），而"哪一回合要注入"这件事不该跟着一起改。
 *
 * 契约只有一条：**返回空的字符串就等于"什么都没想起来"**，组包会退回旧的关键词
 * 提示（或什么都不加）。这样"记忆服务没装/出错了"退化成"少一段注入"，而不会让
 * 这一回合组不出包。
 */

/** 一次记忆查询的输入。 */
export interface MemoryEvidenceInput {
  /** 本回合要处理的文本（队列里的若干行）。 */
  readonly text: string
  /** 房间键（`qq-group-1000000003` 这种），用于房间级记忆的过滤。 */
  readonly room: string
  readonly isGroup: boolean
  /** 当前发言人的 QQ 号（`memory.profiles` 打开时用于侧写注入）。 */
  readonly speakerId?: number
  /** 当前发言人的显示名（没有就用 QQ 号）。 */
  readonly speakerName?: string
}

/** 返回可注入的证据块（含抬头），或空串。 */
export type MemoryEvidence = (input: MemoryEvidenceInput) => Promise<string>

/**
 * 记忆服务（v2）：召回与写入。
 *
 * 为什么工具也走这个端口而不是直接拿 `MemoryStore`：工具能看到的应该只是"想起来
 * 什么、记住什么"，而不是"记录在哪个文件里、索引怎么建"。e2 把关键词换成向量时，
 * 工具面一行都不用改。
 */
export interface MemoryService {
  /** 主动召回（`qq_recall_memory`）：条数与分数都由实现决定，工具不懂打分。 */
  recall(input: { readonly query: string; readonly kind?: string | undefined; readonly limit: number }): Promise<ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly content: string
    readonly tags: readonly string[]
    readonly source: string
    readonly date: string
    readonly hits: number
  }>>
  /** 写一条（`qq_memorize_fact`）：实现负责双写与合并。 */
  memorize(input: {
    readonly content: string
    readonly kind?: string | undefined
    readonly tags?: readonly string[]
    readonly source?: string | undefined
  }): Promise<{ readonly id: string; readonly total: number; readonly created: boolean }>
}

/**
 * 本机 embed 服务（P6e·e2）：向量检索的唯一对外接口（实现见
 * `adapters/providers/embed.ts`）。
 *
 * 契约三条，全是为了"服务不在时不能拖住、更不能写坏数据"：
 *   1. **不许抛**：任何失败（连不上、超时、维度不符）都返回 `null`，调用方把
 *      `null` 当"现在不可用"处理，自动退回关键词路径（D5/R6）；
 *   2. **维度**：`dim` 是配置值；实现必须逐条校验响应向量，不符就整批拒绝——
 *      **绝不把维度错位的向量写进索引**（错位读出来的是"别人的记忆"，KB Lite
 *      出过真事故）；
 *   3. **可用性**：`available()` 报告最近一次调用的结果；"未知"按可用处理
 *      （第一次总得试一试），失败后由实现决定冷却多久再允许重试。
 */
export interface EmbedPort {
  /** 向量维度（配置值）。写入与读取 `vec.bin` 时都用它校验。 */
  readonly dim: number
  /** 现在可用/不可用。`false` 时调用方直接退回关键词，不必调用 `embed`。 */
  available(): boolean
  /**
   * 一次嵌一批文本；返回顺序与入参一致。失败/不可用时返回 `null`（**不抛**）。
   */
  embed(texts: readonly string[]): Promise<readonly Float32Array[] | null>
}

/** 深召回的一条命中（`qq_memory_search`）：原文块或结构化记忆 + 出处。 */
export interface MemorySearchHit {
  readonly content: string
  readonly kind: string
  /** 出处（文件/房间 + 行号）；没有时为空串。 */
  readonly source: string
  readonly date: string
  readonly chunk: boolean
}

/**
 * 深召回：一次给 5–8 条长文本（主要是原文块）。
 *
 * 与 `MemoryService.recall` 的区别：recall 是"短事实、进注入预算"，深召回是
 * **agent 主动搜**、愿意多花上下文换命中率（实测块检索 recall 明显高于句子）。
 */
export type MemorySearch = (query: string, limit?: number, asOf?: string) => Promise<readonly MemorySearchHit[]>
