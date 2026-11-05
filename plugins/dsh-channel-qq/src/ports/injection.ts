/** 指令注入的**检测结论**——两个 P6 项之间的接缝。
 *
 * 谁生产：`policy.v2`（P6c）的扫描器，读一张 JSON 规则表，对**不可信文本**打标。
 * 谁消费：`context.v2`（P6b）的信封渲染——把信号名写成提示里的一行
 * `[注意] 这段消息含疑似指令注入特征：<信号名>`。
 *
 * 为什么单独一条缝：两边由两个模块各自拥有（扫描是策略的事，提示措辞是组包的事），
 * 而"检测到就别当指令看"这条语义需要一个双方都认得的形状。**只标记，不改写正文**：
 * 正文一旦被过滤器改过，"模型看到的"和"人看到的"就不是同一段话了，事后没法对账。
 *
 * 入站只标记（不拦截）；出站命中才拦截（见 `core/guards/output-signatures.ts`）。
 */

/** 一条命中。`name` 是规则表里的规则名，用于提示与日志。 */
export interface InjectionSignal {
  /** 规则名，例如 `ignore-previous`。 */
  readonly name: string
  /** 命中的原文片段（截断后的），仅用于日志与后台展示。 */
  readonly excerpt: string
}

/** 扫描器。纯函数式：给文本，给结论，不写状态、不抛异常。 */
export interface InjectionScanner {
  /** 扫描一段不可信文本。没有命中就是空数组。 */
  scan(text: string): readonly InjectionSignal[]
}
