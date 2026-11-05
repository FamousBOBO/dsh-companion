/** 把一份技能写回 SKILL.md 的规范形态（frontmatter + 正文）。
 *
 * 序列化只负责**我们自己管的键**：导入来的技能里可能有别人的 `metadata`
 * （author / version），保存时原样保留，否则一次后台编辑就把来源信息抹了。
 */

import { META_PREFIX, type SkillPolicy } from './model.js'

/** YAML 标量：需要引号就加双引号并转义。 */
export function yamlScalar(value: string): string {
  const needsQuote = value === ''
    || /^\s|\s$/.test(value)
    || /[:#\[\]{}&*!|>'"%@`]/.test(value)
    || /^(true|false|yes|no|on|off|null|~)$/i.test(value)
    || /^-?\d+(\.\d+)?$/.test(value)
  if (!needsQuote) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** 把策略合并进 metadata（保留其它键）。 */
export function policyMetadata(
  existing: Readonly<Record<string, string>>,
  policy: SkillPolicy,
): Record<string, string> {
  const out: Record<string, string> = { ...existing }
  out[`${META_PREFIX}visibility`] = policy.visibility
  out[`${META_PREFIX}rooms`] = policy.rooms.join(',')
  out[`${META_PREFIX}admins-only`] = policy.adminsOnly ? 'true' : 'false'
  out[`${META_PREFIX}enabled`] = policy.enabled ? 'true' : 'false'
  out[`${META_PREFIX}scripts`] = policy.allowScripts ? 'true' : 'false'
  if (policy.source !== '') out[`${META_PREFIX}source`] = policy.source
  else delete out[`${META_PREFIX}source`]
  return out
}

/** 一份待写入的技能内容。 */
export interface SkillFileInput {
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly body: string
  readonly metadata: Readonly<Record<string, string>>
  readonly policy: SkillPolicy
}

/** 生成规范化的 SKILL.md 文本。 */
export function serializeSkillFile(input: SkillFileInput): string {
  const metadata = policyMetadata(input.metadata, input.policy)
  const lines = [
    '---',
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(input.description)}`,
  ]
  if (input.whenToUse !== '') lines.push(`whenToUse: ${yamlScalar(input.whenToUse)}`)
  const entries = Object.entries(metadata)
  if (entries.length > 0) {
    lines.push('metadata:')
    for (const [key, value] of entries) lines.push(`  ${key}: ${yamlScalar(value)}`)
  }
  lines.push('---', '', input.body.trim(), '')
  return lines.join('\n')
}
