/** 人格包：面向模型的文案的唯一来源。
 *
 * 为什么它是一个端口而不是一个函数：文案将来要能在后台改、要能换包（不同群不同
 * 人格）、要在发布物里带上默认包——这三件事决定了"去哪儿找文案"是可替换的。
 * 默认实现读 `assets/persona/default/`（见 `adapters/persona/fs-pack.ts`）。
 *
 * 只有类型，没有实现。
 */

/** 模板键，例如 `packet/group`、`notice/poke`。缺包时 `render` 抛错、`text` 返回 undefined。 */
export interface PersonaPack {
  /** 取一段模板原文（未渲染）；没有这一段时返回 undefined。 */
  template(key: string): string | undefined
  /**
   * 渲染一段模板。
   *
   * @throws 这一段不存在时抛错——人格包是发布物，缺了一句话就该当场炸，
   *         而不是让模型收到一段空提示词去自由发挥。
   */
  render(key: string, vars?: Readonly<Record<string, string>>): string
  /** 包里有哪些键（后台展示、启动自检用）。 */
  keys(): string[]
}

/** 缺包时的错误：把"缺哪一段"说清楚，而不是抛一个 `undefined is not a function`。 */
export class MissingTemplateError extends Error {
  constructor(readonly key: string, readonly dir: string) {
    super(`persona pack: missing template "${key}" (looked in ${dir})`)
    this.name = 'MissingTemplateError'
  }
}
