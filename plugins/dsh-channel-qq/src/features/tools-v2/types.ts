/** tools.v2（P6d）的形状声明。
 *
 * 新工具面 = 17 张"脸"，每张脸由若干分支组成，每个分支委派给一个旧 spec。
 * schema、工具描述、旧名对照与运行时校验**全部从这份声明生成**——它是新面的
 * 唯一来源，防止"清单说一套、代码跑一套"。
 *
 * "合并前后行为一致"可证的落点：分支只带 `legacy`（旧 spec 名）与字段表；
 * 字段名逐字沿用旧 spec 的 required/properties（对照测试逐条钉住），运行时
 * 校验通过后把参数（默认原样）交给旧 spec 的 `run`——没有任何实现被重写。
 */

import type { FieldName } from './fields.js'

/** 一个分支：新面的一个 action（必要时带平台变体）委派给旧 spec `legacy`。 */
export interface Branch {
  readonly action: string
  /** 旧 spec 名（收编表的键；对照清单与实现委派都用它）。 */
  readonly legacy: string
  /** 除 action/provider 之外必须给的字段（逐字沿用旧 spec 的 required）。 */
  readonly required: readonly FieldName[]
  /** 可选字段（逐字沿用旧 spec 的 properties 减去 required）。 */
  readonly optional?: readonly FieldName[]
  /** 平台变体（只有 qq_music）；`any` = 不分平台。 */
  readonly provider?: 'netease' | 'kugou' | 'any'
  /** 参数翻译（缺省 = 去掉 action/provider 原样透传——字段名与旧工具逐字一致）。 */
  readonly translate?: (args: Readonly<Record<string, unknown>>) => Record<string, unknown>
}

/** 一张"脸"：合并后的一个工具。 */
export interface Face {
  readonly name: string
  /** 描述开头（什么时候用）；动作与必填字段清单由 mapping.ts 统一追加。 */
  readonly description: string
  readonly branches: readonly Branch[]
  /** 需要 provider 参数（只有 qq_music）。 */
  readonly providerSelect?: boolean
  /** 追加在描述末尾的补充说明。 */
  readonly note?: string
}
