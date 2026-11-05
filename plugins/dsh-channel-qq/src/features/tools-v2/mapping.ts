/** 合并表（05 §6.1）的装配与全部派生：新面清单、旧名集合、参数 schema、工具描述、旧名对照。
 *
 * "新面长什么样"的每个问题都在这里回答——它从 faces-*.ts 的声明生成一切，
 * 是防"清单说一套、代码跑一套"的唯一来源；对照测试（test/tools-v2.test.ts）
 * 再把生成物与旧 spec 逐条比一遍。
 */

import { FIELD, type FieldInfo, type FieldName } from './fields.js'
import type { Face } from './types.js'
import { CORE_FACES } from './faces-core.js'
import { MEDIA_FACES } from './faces-media.js'
import { CONTENT_FACES } from './faces-content.js'
import { MISC_FACES } from './faces-misc.js'

/** 17 张脸；顺序 = 注册顺序 = 工具在系统提示里的出现顺序（05 §6.1 的表序）。 */
export const MAPPING: readonly Face[] = [...CORE_FACES, ...MEDIA_FACES, ...CONTENT_FACES, ...MISC_FACES]

/** 合并后的工具名集合。 */
export const MERGED_TOOL_NAMES: ReadonlySet<string> = new Set(MAPPING.map((face) => face.name))

const LEGACY = new Set<string>()
for (const face of MAPPING) {
  for (const branch of face.branches) LEGACY.add(branch.legacy)
}

/** 全部被收编的旧 spec 名（88 个；对照测试逐条钉住"每个旧名都有归宿"）。 */
export const LEGACY_TOOL_NAMES: ReadonlySet<string> = LEGACY

export function isMergedToolName(name: string): boolean {
  return MERGED_TOOL_NAMES.has(name)
}

export function isLegacyToolName(name: string): boolean {
  return LEGACY.has(name)
}

export function faceOf(name: string): Face | undefined {
  return MAPPING.find((face) => face.name === name)
}

/** 一张脸的动作名（去重、保序）。 */
export function faceActions(face: Face): string[] {
  return [...new Set(face.branches.map((branch) => branch.action))]
}

/** 工具描述 = 手写的开头 + 生成的动作/必填字段清单 + 补充（人格中立：不含称呼）。 */
export function describeFace(face: Face): string {
  const actions = face.branches.map((branch) => {
    const platform = branch.provider === undefined || branch.provider === 'any' ? '' : `[${branch.provider}]`
    const fields = branch.required.length === 0 ? '无必填' : branch.required.join('、')
    return `${branch.action}${platform}（${fields}）`
  })
  return [
    face.description,
    `动作（方括号是平台，括号里是必填字段）：${actions.join('｜')}`,
    ...(face.note === undefined ? [] : [face.note]),
  ].join('\n')
}

/**
 * 新面的 parameters。
 *
 * 判别联合：`action` 决定其余字段；`required` 只有 action，分支内的必填与越界
 * 由运行时校验（validate.ts）给出点名报错——宿主不做参数校验（工具自己负责，
 * 见 `ports/agent-gateway.ts` 与宿主 `ToolDefinition` 的约定）。
 */
export function faceParameters(face: Face): Record<string, unknown> {
  const actions = faceActions(face)
  const properties: Record<string, unknown> = {
    action: { type: 'string', enum: actions, description: `要做的动作：${actions.join(' / ')}` },
  }
  if (face.providerSelect === true) {
    properties.provider = { type: 'string', enum: ['netease', 'kugou'], description: '音乐平台（默认 netease）' }
  }
  for (const branch of face.branches) {
    for (const name of [...branch.required, ...(branch.optional ?? [])]) {
      if (properties[name] === undefined) properties[name] = fieldSchema(name)
    }
  }
  return { type: 'object', properties, required: ['action'] }
}

function fieldSchema(name: FieldName): Record<string, unknown> {
  const info: FieldInfo = FIELD[name]
  return {
    type: info.type,
    description: info.description,
    ...(info.items === undefined ? {} : { items: info.items }),
    ...(info.enum === undefined ? {} : { enum: info.enum }),
  }
}

/** 工具清单（名字：动作）——AGENTS.md 工具区用。 */
export function renderFaceList(): string {
  return MAPPING.map((face) => `${face.name}：${faceActions(face).join('、')}`).join('\n')
}

/** 旧名对照（新 ← 旧）——AGENTS.md 工具区与切换日说明共用同一份，不会两处走样。 */
export function renderMapping(): string {
  return MAPPING.map((face) => {
    const byAction = new Map<string, string[]>()
    for (const branch of face.branches) {
      const platform = branch.provider === undefined || branch.provider === 'any'
        ? ''
        : `（${branch.provider === 'netease' ? '网易云' : '酷狗'}）`
      byAction.set(branch.action, [...(byAction.get(branch.action) ?? []), `${branch.legacy}${platform}`])
    }
    const pairs = [...byAction].map(([action, names]) => `${action}=${names.join('／')}`)
    return `${face.name} ← ${pairs.join('、')}`
  }).join('\n')
}

/**
 * 把一段**提示词文案**里的旧工具名换成合并后的调用写法。
 *
 * 为什么需要：tools.v2 只换了工具面，人格包里那些写着 `qq_send_text` 的说明
 * （早报、巡逻、梦、群尾巴、戳一戳、注入尾、行为指令）不会自动跟着变。线上
 * 2026-10-18 就是这样：模型按提示找 `qq_send_text`，找不到，于是不调用工具、
 * 只回文本——用户侧表现为"没反应"。
 *
 * 只该用在给人看/给模型看的文案上；`notice/tools-renamed` 本身是旧名→新名的
 * 对照表，必须保持原样（调用方排除它）。
 */
export function rewriteLegacyToolNames(text: string): string {
  const table = new Map<string, string>()
  for (const face of MAPPING) {
    for (const branch of face.branches) {
      table.set(branch.legacy, `${face.name}（action=${branch.action}）`)
    }
  }
  // **一次扫描 + 查表**，不是"逐条 replace"。
  //
  // 循环 replace 的替换结果会被下一条规则再次匹配：`qq_remind_at` 先变成
  // `qq_remind（action=add_at）`，紧接着处理 `qq_remind` 时又把里面那个吃掉，
  // 得到 `qq_remind（action=add）（action=add_at）`（2026-10-19 实测）。
  // 「按长度倒序」只防原文里的重叠，防不住自己刚产生的重叠。
  const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = [...table.keys()].sort((a, b) => b.length - a.length).map(escaped)
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${names.join('|')})(?![A-Za-z0-9_])`, 'g')
  return text.replace(pattern, (match) => table.get(match) ?? match)
}
