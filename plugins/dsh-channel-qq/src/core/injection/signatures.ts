/** 注入特征规则表（P6c）：**已解析对象**的校验与编译，纯函数、零 IO。
 *
 * 为什么读 JSON 文件不在这里：`src/core/` 是可重放层（R8）——不许 `node:*`、
 * 不许读文件、不许时钟与随机。读盘落在 `features/inbound` 的
 * `loadSignatureBundle`，这里只回答"给定一个 unknown，它是不是一张合法的规则表"。
 *
 * 规则只存**匹配所需的最小特征**（正则 + 标志），不放任何样本原文（02 §58：
 * 样本原文不进代码/注释/日志）。`version` 不认识或任何一条不合法 → **整表拒绝**：
 * 调用方据此降级为"没有规则"，绝不半接受。
 *
 * 标志位只允许 `i/m/s/u`：带状态的 `g/y` 会让"同一输入两次扫描出不同结果"，
 * 把可重放性直接破坏掉。
 */

/** 一条入站规则：命中即打标（只标记，不拦截——02 §2.3 的架构口径）。 */
export interface InjectionRule {
  readonly name: string
  readonly pattern: RegExp
}

/** 一条出站广告前缀规则：命中即拦下这次发送。 */
export interface AdPrefixRule {
  readonly name: string
  readonly pattern: RegExp
}

/** 出站复读判据的参数：开头串窗口（字）与"连续几条算复读"。 */
export interface RepeatOpeningRule {
  readonly minChars: number
  readonly minRun: number
}

/** 出站规则集。 */
export interface OutputSignatureRules {
  readonly adPrefix: readonly AdPrefixRule[]
  readonly repeatOpening: RepeatOpeningRule
}

/** 整张规则表。 */
export interface CompiledSignatures {
  readonly version: number
  readonly input: readonly InjectionRule[]
  readonly output: OutputSignatureRules
}

/** 本代码认识的规则表版本；不认识就整表拒绝（不猜、不降级部分规则）。 */
export const SUPPORTED_SIGNATURES_VERSION = 1

export type SignaturesCompileResult =
  | { readonly ok: true; readonly value: CompiledSignatures }
  | { readonly ok: false; readonly reason: string }

/** 只允许无状态标志。 */
const ALLOWED_FLAGS = /^[imsu]*$/

/** 校验内部的失败信号；在最外层收成 `{ ok:false, reason }`。 */
class RuleError extends Error {}

function compileRule(raw: unknown, where: string): InjectionRule {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new RuleError(`${where} 必须是对象`)
  const record = raw as Record<string, unknown>
  const name = record.name
  const pattern = record.pattern
  const flags = record.flags === undefined ? '' : record.flags
  if (typeof name !== 'string' || name.trim() === '') throw new RuleError(`${where}.name 必须是非空字符串`)
  if (typeof pattern !== 'string' || pattern.trim() === '') throw new RuleError(`${where}.pattern 必须是非空字符串`)
  if (typeof flags !== 'string' || !ALLOWED_FLAGS.test(flags)) throw new RuleError(`${where}.flags 只允许 i/m/s/u`)
  try {
    return { name, pattern: new RegExp(pattern, flags) }
  } catch (error) {
    throw new RuleError(`${where}.pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}`)
  }
}

function compileRuleList(raw: unknown, where: string): InjectionRule[] {
  if (!Array.isArray(raw)) throw new RuleError(`${where} 必须是数组`)
  return raw.map((item, index) => compileRule(item, `${where}[${index}]`))
}

function requireInteger(raw: unknown, where: string, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new RuleError(`${where} 应为 ${min}–${max} 的整数（读到 ${JSON.stringify(raw)}）`)
  }
  return raw
}

/** 校验并编译一张规则表；任何一处不合法都返回 `{ ok:false, reason }`，从不抛。 */
export function compileSignatures(raw: unknown): SignaturesCompileResult {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new RuleError('规则表应当是一个 JSON 对象')
    const record = raw as Record<string, unknown>
    if (record.version !== SUPPORTED_SIGNATURES_VERSION) {
      throw new RuleError(`version 应为 ${SUPPORTED_SIGNATURES_VERSION}（读到 ${JSON.stringify(record.version)}）`)
    }
    const output = record.output
    if (output === null || typeof output !== 'object' || Array.isArray(output)) throw new RuleError('output 必须是对象')
    const repeat = (output as Record<string, unknown>).repeatOpening
    if (repeat === null || typeof repeat !== 'object' || Array.isArray(repeat)) {
      throw new RuleError('output.repeatOpening 必须是对象')
    }
    const repeatRecord = repeat as Record<string, unknown>
    return {
      ok: true,
      value: {
        version: SUPPORTED_SIGNATURES_VERSION,
        input: compileRuleList(record.input, 'input'),
        output: {
          adPrefix: compileRuleList((output as Record<string, unknown>).adPrefix, 'output.adPrefix'),
          repeatOpening: {
            minChars: requireInteger(repeatRecord.minChars, 'output.repeatOpening.minChars', 2, 64),
            minRun: requireInteger(repeatRecord.minRun, 'output.repeatOpening.minRun', 2, 20),
          },
        },
      },
    }
  } catch (error) {
    return { ok: false, reason: error instanceof RuleError ? error.message : `规则表校验异常：${String(error)}` }
  }
}
