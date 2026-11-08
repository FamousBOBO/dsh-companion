/** `presence` 段（群聊旁听与自主接话）的配置契约。
 *
 * 这条测试钉的是 `design/group-interest-selection-20261101.md` §0.1 那张表：
 * 13 个字段的**默认值**、段/字段的元数据（label / help / hot / page / 数值范围），
 * 以及 `resolveConfig` 的合并与归一（白名单群号混进字符串时的处理）。
 *
 * 为什么默认值要在测试里**手抄一遍**：`DEFAULT_CONFIG` 是从 schema 生成的，
 * 拿它跟 schema 比只能证明"生成器没坏"，证明不了"数值还是合同上那组"。§0.1 是
 * 多人并行实现的接口合同，改了就必须在这里显式改一次、并在评审里看见。
 *
 * 另外守住一条硬口径：`presence.enabled` 默认 `false` —— 关着时入站路径与旧行为
 * 逐字节一致（`packets/*.txt` 快照不许动）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, SCHEMA, resolveConfig, sectionIds } from '../src/config.js'
import { PRESENCE_GROUPS, type PresenceConfig } from '../src/config/sections/presence.js'
import { hotOf } from '../src/config/meta.js'

/** §0.1 的权威默认值表（顺序即段内字段顺序，与 schema 一致）。 */
const CONTRACT: PresenceConfig = {
  // P5-B：运行模式。`off` 默认 + `enabled:false` 升级后行为完全不变。
  mode: 'off',
  enabled: false,
  groups: [],
  ambientMaxEntries: 40,
  ambientTtlMs: 600_000,
  ambientMaxChars: 6_000,
  // P3 §7.3 拆出来的两个调度参数（合批等待 / 饥饿告警阈值）。
  batchQuietMs: 6_000,
  judgeMaxWaitMs: 25_000,
  judgeIntervalMs: 50_000,
  judgeMaxEntries: 15,
  judgeMaxChars: 1_200,
  judgeTimeoutMs: 25_000,
  judgeMaxTokens: 320,
  speakMinIntervalMs: 300_000,
  speakMaxPerHour: 3,
  // P2 §6.5 的引用时间窗与 P1 §5.4 的记忆预算。
  replyWindowMs: 600_000,
  memoryBudgetChars: 800,
  // P4 §8.2 的表情包（默认关闭：它依赖图库已授权）。
  stickers: false,
  stickerMinIntervalMs: 600_000,
  stickerMaxPerHour: 1,
  replyMaxChars: 70,
}

const FIELDS = Object.keys(CONTRACT)

function presenceGroup() {
  const group = SCHEMA.groups.find((g) => g.id === 'presence')
  assert.ok(group !== undefined, 'SCHEMA.groups 里没有 presence 段')
  return group
}

test('presence：段已接线（schema / 段清单 / 默认配置三处都在）', () => {
  assert.ok(sectionIds().includes('presence'), 'sectionIds() 里没有 presence')
  assert.equal(sectionIds().at(-1), 'presence', 'presence 必须是**最后一个**段（键顺序 = 线上配置顺序）')
  assert.equal(SCHEMA.root.presence !== undefined, true, 'ROOT_ENTRIES 里没有 presence 入口')
  assert.equal((SCHEMA.root.presence as { group?: string }).group, 'presence', 'presence 入口没指向 presence 段')
  assert.equal(Object.keys(DEFAULT_CONFIG.presence).length, FIELDS.length)
})

test('presence：13 个默认值与 §0.1 的表逐字段相等', () => {
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.presence), FIELDS, '字段顺序/条数与 §0.1 不一致')
  assert.deepEqual(DEFAULT_CONFIG.presence, CONTRACT)
  // 总开关必须默认关：关着时入站路径与旧行为逐字节一致。
  assert.equal(DEFAULT_CONFIG.presence.enabled, false)
  assert.deepEqual(DEFAULT_CONFIG.presence.groups, [], '白名单默认空 = 谁都不启用')
})

test('presence：schema 的默认值与 DEFAULT_CONFIG / 合同三处一致', () => {
  const group = presenceGroup()
  assert.deepEqual(Object.keys(group.fields), FIELDS)
  for (const key of FIELDS) {
    const spec = group.fields[key]
    assert.ok(spec !== undefined, `schema 里缺字段 presence.${key}`)
    assert.deepEqual(spec.default, CONTRACT[key as keyof PresenceConfig], `presence.${key} 的 schema 默认值与 §0.1 不一致`)
  }
})

test('presence：每个字段都有中文 label / help，且 hot 全为 live、page 全为 groups', () => {
  const group = presenceGroup()
  for (const key of FIELDS) {
    const spec = group.fields[key]
    assert.ok(spec !== undefined)
    assert.ok(spec.label !== '' && typeof spec.label === 'string', `presence.${key} 没有中文 label`)
    assert.match(spec.label, /[\u4e00-\u9fa5]/, `presence.${key} 的 label 不是中文：${spec.label}`)
    assert.ok(spec.help !== undefined && spec.help !== '', `presence.${key} 没有 help`)
    assert.match(spec.help ?? '', /[\u4e00-\u9fa5]/, `presence.${key} 的 help 不是中文`)
    assert.equal(hotOf(spec), 'live', `presence.${key} 应为 live（消费方每次现取）`)
    assert.equal(spec.page, 'groups', `presence.${key} 应落在「群聊与房间」页`)
  }
  assert.equal(group.page, 'groups')
})

test('presence：数值字段都带 min/max/step 与 unit', () => {
  const group = presenceGroup()
  const numeric = FIELDS.filter((key) => group.fields[key]?.kind === 'number')
  // 17 = 原有 11 + P3 的 batchQuietMs/judgeMaxWaitMs + P2 的 replyWindowMs/memoryBudgetChars
  //      + P4 的 stickerMinIntervalMs/stickerMaxPerHour（stickers 是开关，不是数值）
  assert.equal(numeric.length, 17, '除开关与列表外都应是数值字段')
  for (const key of numeric) {
    const spec = group.fields[key]
    assert.ok(spec !== undefined)
    assert.equal(typeof spec.min, 'number', `presence.${key} 缺 min`)
    assert.equal(typeof spec.max, 'number', `presence.${key} 缺 max`)
    assert.equal(typeof spec.step, 'number', `presence.${key} 缺 step`)
    assert.equal(typeof spec.unit, 'string', `presence.${key} 缺 unit`)
    const value = CONTRACT[key as keyof PresenceConfig] as number
    assert.ok(value >= (spec.min ?? 0) && value <= (spec.max ?? 0), `presence.${key} 的默认值 ${value} 不在 [${spec.min}, ${spec.max}] 内`)
  }
})

test('presence：groups 是数字列表（整值替换 + itemsKind=number）', () => {
  const spec = presenceGroup().fields.groups
  assert.ok(spec !== undefined)
  assert.equal(spec.kind, 'list')
  assert.equal(spec.itemsKind, 'number')
  assert.equal(spec.wholesale, true, '数组必须整值替换，不能逐项合并')
  assert.match(spec.help ?? '', /留空/, 'groups 的 help 必须写明"留空 = 谁都不启用"')
  assert.match(spec.help ?? '', /白名单/, 'groups 的 help 必须写明"只对白名单群生效"')
})

test('presence：resolveConfig 覆盖一层（其余字段回落到默认值）', () => {
  const config = resolveConfig({ presence: { enabled: true, groups: [145326153] } as never })
  assert.equal(config.presence.enabled, true)
  assert.deepEqual(config.presence.groups, [145326153])
  // 只给两个字段 → 其余 11 个必须来自默认值（不能整段被替换掉）。
  for (const key of FIELDS) {
    if (key === 'enabled' || key === 'groups') continue
    assert.deepEqual(config.presence[key as keyof PresenceConfig], CONTRACT[key as keyof PresenceConfig], `presence.${key} 应回落到默认值`)
  }
  // 段落对象必须与默认值不是同一个引用（P0 的原地合并依赖这一点）。
  assert.notEqual(config.presence, DEFAULT_CONFIG.presence)
})

test('presence：resolveConfig 两层（override 覆盖 patch，未给的一半来自 patch）', () => {
  const config = resolveConfig(
    { presence: { enabled: true, speakMaxPerHour: 2 } as never },
    { presence: { speakMaxPerHour: 5 } as never },
  )
  assert.equal(config.presence.speakMaxPerHour, 5, 'override 必须赢 patch')
  assert.equal(config.presence.enabled, true, 'override 没给的字段要留在 patch 的值上')
  assert.equal(config.presence.replyMaxChars, 70, '两层都没给的字段仍是默认值')
})

test('presence：groups 里混入字符串——数字串归一成数字，认不出的原样保留', () => {
  // 2026-10-19 那条线上实证的同类问题：群号写成字符串，消费方全是严格比较 ⇒ 静默失效。
  const config = resolveConfig({}, {
    presence: { groups: ['145326153', 'abc', 987654321, ''] as never },
  } as never)
  assert.deepEqual(config.presence.groups, [145326153, 'abc', 987654321, ''])
  assert.equal(typeof config.presence.groups[0], 'number')
  // 不把错值改造成另一种错值：'abc' 与空串都原样留着，由消费方按"不是数字就跳过"处理。
  assert.equal(typeof config.presence.groups[1], 'string')
})

test('presence：段内的表外字段不会被凭空生出来（未知键按层合并保留但不进默认值）', () => {
  const config = resolveConfig({ presence: { 不存在: 1 } as never })
  assert.equal(Object.keys(DEFAULT_CONFIG.presence).includes('不存在'), false)
  assert.equal(Object.keys(config.presence).length, FIELDS.length + 1, '未知键只出现在这一层解析结果里，不进默认值')
})

test('presence：PRESENCE_GROUPS 只有一段、id 与段入口同名', () => {
  assert.equal(PRESENCE_GROUPS.length, 1)
  assert.equal(PRESENCE_GROUPS[0]?.id, 'presence')
  assert.equal(PRESENCE_GROUPS[0]?.label, '群聊旁听与接话')
})
