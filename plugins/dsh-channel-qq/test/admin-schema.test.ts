/** schema 完整性：后台"新增配置项 = 改一处"这条铁律的可执行形式。
 *
 * 断言的就是 内部文档 §10 的验收：**每个配置项都落在某个页面里、都带
 * 显式热生效标注**，且 schema 与 DEFAULT_CONFIG 互相覆盖、彼此不漏。
 * 任何一条崩了，都意味着有人加/删字段时忘了同步元数据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, SCHEMA, sectionIds } from '../src/config.js'
import { fieldRefs, hotOf, restartPaths, schemaView, secretPaths, validateValue } from '../src/config/meta.js'
import { ADMIN_PAGES, pageKeys } from '../src/config/pages.js'
import { NO_DEFAULT, b, e, list, n, s } from '../src/config/dsl.js'

const HOT = new Set(['live', 'reload', 'restart'])

/** 叶子路径（数组与标量都是叶子）。 */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix === '' ? [] : [prefix]
  }
  const out: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...leafPaths(child, prefix === '' ? key : `${prefix}.${key}`))
  }
  return out
}

test('每个字段都有页面、都有显式热生效标注', () => {
  const keys = new Set(pageKeys())
  for (const ref of fieldRefs()) {
    assert.ok(ref.spec.hot !== undefined, `${ref.path} 没有显式 hot 标注（新字段必须想清楚）`)
    assert.ok(HOT.has(hotOf(ref.spec)), `${ref.path} 的 hot 非法：${String(ref.spec.hot)}`)
    assert.ok(ref.page !== null, `${ref.path} 没有 page——它永远不会出现在任何表单里`)
    assert.ok(keys.has(ref.page as string), `${ref.path} 的 page「${ref.page}」不在页面清单里`)
  }
})

test('字段数量 ≥ 93（验收清单里的全部配置项）', () => {
  const count = fieldRefs().length
  assert.ok(count >= 93, `只有 ${count} 个字段，少于验收要求的 93`)
})

test('DEFAULT_CONFIG 的每个叶子都被 schema 覆盖；反之只能是 NO_DEFAULT', () => {
  const paths = fieldRefs().map((ref) => ref.path)
  // json 对象字段的内部键（如 turn.maxSteps.dm）不在 schema 里，但由那个字段覆盖。
  const covered = (leaf: string): boolean => paths.some((p) => leaf === p || leaf.startsWith(`${p}.`))
  const defaults = leafPaths(DEFAULT_CONFIG)
  for (const leaf of defaults) {
    assert.ok(covered(leaf), `默认配置里的 ${leaf} 不在 schema 里`)
  }
  const defaultSet = new Set(defaults)
  const coversDefaults = (refPath: string): boolean =>
    defaultSet.has(refPath) || defaults.some((leaf) => leaf.startsWith(`${refPath}.`))
  for (const ref of fieldRefs()) {
    if (coversDefaults(ref.path)) continue
    assert.equal(ref.spec.default, NO_DEFAULT, `${ref.path} 既不在 DEFAULT_CONFIG 里，也不是 NO_DEFAULT`)
  }
})

test('页面清单自洽：28 页、key 唯一、kind 计数固定', () => {
  assert.equal(ADMIN_PAGES.length, 28)
  const seen = new Set<string>()
  for (const page of ADMIN_PAGES) {
    assert.ok(!seen.has(page.key), `页面 key 重复：${page.key}`)
    seen.add(page.key)
    assert.ok(['overview', 'module', 'system'].includes(page.kind), `${page.key} 的 kind 非法`)
    assert.ok(page.title !== '' && page.blurb !== '' && page.icon !== '', `${page.key} 缺少标题/说明/图标`)
  }
  assert.equal(ADMIN_PAGES.filter((p) => p.kind === 'overview').length, 1)
  assert.equal(ADMIN_PAGES.filter((p) => p.kind === 'module').length, 19)
  assert.equal(ADMIN_PAGES.filter((p) => p.kind === 'system').length, 8)
})

test('敏感字段：都是 string，且关键项在列', () => {
  const secrets = secretPaths()
  for (const path of secrets) {
    const ref = fieldRefs().find((r) => r.path === path)
    assert.ok(ref !== undefined, `secretPaths 里的 ${path} 不存在`)
    assert.equal(ref.spec.kind, 'string', `${path} 是敏感字段但不是 string`)
  }
  for (const wanted of ['accessToken', 'admin.password', 'stt.apiKey']) {
    assert.ok(secrets.includes(wanted), `敏感字段缺少 ${wanted}`)
  }
})

test('重启级字段包含 admin.host / cruises / workspacePath', () => {
  const paths = restartPaths()
  for (const wanted of ['admin.host', 'cruises', 'workspacePath']) {
    assert.ok(paths.includes(wanted), `restartPaths 缺少 ${wanted}`)
  }
})

test('schemaView：投影形状与前端模型消费的键完全对上', () => {
  const view = schemaView()
  assert.equal(view.sections.length, sectionIds().length)
  for (const section of view.sections) {
    assert.ok(typeof section.id === 'string' && section.id !== '')
    assert.ok(typeof section.label === 'string' && section.label !== '')
  }
  for (const field of view.fields) {
    assert.equal(typeof field.path, 'string')
    assert.equal(typeof field.label, 'string')
    assert.ok(field.label !== '', `${field.path} 没有 label`)
    assert.ok(HOT.has(field.hot), `${field.path} 的 hot 非法`)
    assert.equal(typeof field.hasDefault, 'boolean')
    if (field.hasDefault) assert.ok('default' in field, `${field.path} hasDefault=true 但没有 default`)
    else assert.ok(!('default' in field), `${field.path} hasDefault=false 却带了 default`)
    if (field.kind === 'number' && !field.hasDefault) {
      assert.equal(field.allowNull, true, `${field.path} 是可选数字，必须 allowNull`)
    }
  }
  const cruises = view.fields.find((f) => f.path === 'cruises')
  assert.ok(cruises !== undefined, 'schemaView 里找不到 cruises')
  assert.ok(Array.isArray(cruises?.itemFields) && (cruises?.itemFields?.length ?? 0) >= 3, 'cruises 需要行编辑器的 itemFields')
  assert.equal(cruises?.idKey, 'id')
})

test('可选数字（NO_DEFAULT）允许 null；有默认值的数字不允许', () => {
  const optional = n('x', NO_DEFAULT, { min: 0, max: 1 })
  assert.equal(validateValue(optional, null), null)
  assert.equal(validateValue(optional, 0.5), null)
  assert.equal(validateValue(optional, 2), '不能大于 1')
  assert.equal(validateValue(n('y', 1, { min: 0 }), null), '不能为空')
})

test('校验规则：boolean / string / list / enum', () => {
  assert.equal(validateValue(b('x', false), 'yes'), '应为开关值（true/false）')
  assert.equal(validateValue(b('x', false), false), null)
  assert.equal(validateValue(s('x', null), null), null)
  assert.equal(validateValue(s('x', ''), 3), '应为字符串（可空）')
  assert.equal(validateValue(list('x', [], {}), [{}]), '数组项必须是字符串或数字（收到 object）')
  assert.equal(validateValue(list('x', [], {}), ['a', 1]), null)
  assert.equal(validateValue(e('x', 'a', [['a', 'A']]), 'b'), '只能是：a')
  assert.equal(validateValue(e('x', 'a', [['a', 'A']]), 'a'), null)
})

test('SCHEMA 由段拼装：sectionIds 与 groups 一致', () => {
  assert.deepEqual(sectionIds(), SCHEMA.groups.map((group) => group.id))
  assert.ok(sectionIds().length >= 20, `段只有 ${sectionIds().length} 个，明显不完整`)
})

test('记忆段（P6e）：字段落在 memory 页；v2 四项 live、向量与抽取器 reload', () => {
  const refs = fieldRefs().filter((ref) => ref.path.startsWith('memory.'))
  assert.deepEqual(refs.map((ref) => ref.path).sort(), [
    'memory.captureDailyCap', 'memory.captureEnabled', 'memory.extractorApiKey', 'memory.extractorModel',
    'memory.extractorUrl', 'memory.maxChars', 'memory.maxRecords', 'memory.occasionsEnabled',
    'memory.pinnedEnabled', 'memory.profiles', 'memory.threshold', 'memory.v2', 'memory.vectorDim',
    'memory.vectorEnabled', 'memory.vectorTimeoutMs', 'memory.vectorUrl', 'memory.vectorWeight',
    'memory.wanderPercent',
  ])
  for (const ref of refs) assert.equal(ref.page, 'memory', `${ref.path} 必须落在记忆页`)
  for (const path of ['memory.maxChars', 'memory.maxRecords', 'memory.threshold', 'memory.v2']) {
    const ref = refs.find((r) => r.path === path)!
    assert.equal(hotOf(ref.spec), 'live', `${path} 应为 live（记忆子插件 watches 它）`)
  }
  for (const path of [
    'memory.vectorDim', 'memory.vectorEnabled', 'memory.vectorTimeoutMs', 'memory.vectorUrl', 'memory.vectorWeight',
    'memory.extractorApiKey', 'memory.extractorModel', 'memory.extractorUrl',
  ]) {
    const ref = refs.find((r) => r.path === path)!
    assert.equal(hotOf(ref.spec), 'reload', `${path} 应为 reload（装配期取值，watches 重载）`)
  }
  assert.equal(DEFAULT_CONFIG.memory.v2, false, 'v2 默认关（旧知识库仍在用）')
  assert.equal(DEFAULT_CONFIG.memory.vectorEnabled, false, '向量默认关（关着 = e1 关键词路径逐字节一致）')
})
