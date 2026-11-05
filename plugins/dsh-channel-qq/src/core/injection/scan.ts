/** 注入特征扫描（P6c）：实现 `ports/injection.ts` 的 `InjectionScanner`。
 *
 * 只做匹配，不做判断：命中就是一条信号（规则名 + 截断的原文片段），**入站只打标、
 * 不拦截**——拦截是出站与工具策略的事（02 §2.3：特征库是第二道防线，第一道是
 * 信任分级 + 工具策略）。片段截断到 40 字：它只用于日志与后台展示，不是全文。
 *
 * 纯函数式：给同样的文本永远给同样的结论，不写状态、不抛异常（规则里的正则
 * 已在编译期定死且不带 `g`——`RegExp.exec` 因此是无状态的）。
 */

import type { InjectionRule } from './signatures.js'
import type { InjectionScanner, InjectionSignal } from '../../ports/injection.js'

/** 信号里保留的原文片段长度上限。 */
export const MAX_EXCERPT_CHARS = 40

export class RuleInjectionScanner implements InjectionScanner {
  constructor(private readonly rules: readonly InjectionRule[]) {}

  /** 规则条数（启动日志与测试用）。 */
  get ruleCount(): number { return this.rules.length }

  /** 扫描一段不可信文本；没有命中就是空数组。 */
  scan(text: string): readonly InjectionSignal[] {
    if (text === '') return []
    const signals: InjectionSignal[] = []
    for (const rule of this.rules) {
      const match = rule.pattern.exec(text)
      if (match === null || match[0] === '') continue
      signals.push({ name: rule.name, excerpt: match[0].slice(0, MAX_EXCERPT_CHARS) })
    }
    return signals
  }
}
