/** P9-A1/A2：**旧配置兼容**与**热切换**的端到端测试。
 *
 * 为什么需要这一组（而不是继续用 `resolveMode()` 的裸对象单测）：P9 计划 §A1 指出，
 * 裸对象测试证明不了整条 **load → resolve → wire** 链路——而真出的事正是链路里的一环：
 * `DEFAULT_CONFIG` 由 schema 生成，若 `mode` 的默认值是 `'off'`，合成器就会把它补进
 * **每一份旧配置**，于是 `enabled:true` 的老部署升级后被静默停用。
 *
 * 这一组因此只用**真实入口**：`resolveConfig()` + `presenceAppliesTo()` + `resolveMode()`，
 * 输入是"用户真正会写的那几行配置"，不是构造出来的裸对象。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js'
import { resolveMode, modeRuns, modeSends, GROUP_PRESENCE_MODES } from '../src/core/presence-mode.js'
import { presenceAppliesTo, presenceRuns } from '../src/app/inbound/ambient-store.js'
import type { PresenceConfig } from '../src/config/sections/presence.js'

const GROUP = 145_326_153

/** 用户真正会写的那一层（patch = 手改的 suite.json）。 */
function load(patch: Partial<{ presence: Partial<PresenceConfig> }>) {
  return resolveConfig(patch as never, {})
}

/** 一条链路的最终效果：会不会跑、会不会发。 */
function effectOf(patch: Partial<{ presence: Partial<PresenceConfig> }>) {
  const config = load(patch)
  const mode = resolveMode(config.presence)
  return {
    mode,
    runs: modeRuns(mode),
    sends: modeSends(mode),
    applies: presenceAppliesTo(config.presence, GROUP),
    presenceRuns: presenceRuns(config.presence),
  }
}

// ── A1：旧配置升级（最危险的一条） ──────────────────────────────────────────

test('A1：schema 的 mode 默认值必须是空串（写成 off 会静默停用所有旧部署）', () => {
  // 这一条是整个 A1 的根因，单独钉死：默认值一旦变回 'off'，
  // 下面那些用例会一起红，但红的原因只有这一句。
  assert.equal(DEFAULT_CONFIG.presence.mode, '', 'mode 默认必须为空串（未指定），不是 off')
})

test('A1：旧配置（只有 enabled:true + 白名单）升级后仍然是 live', () => {
  const effect = effectOf({ presence: { enabled: true, groups: [GROUP] } })
  assert.equal(effect.mode, 'live', '旧用户配了 enabled:true，升级后不该被停用')
  assert.equal(effect.runs, true)
  assert.equal(effect.sends, true)
  assert.equal(effect.applies, true, '旁听照记')
})

test('A1：旧配置（enabled:false）升级后仍然是 off', () => {
  const effect = effectOf({ presence: { enabled: false, groups: [GROUP] } })
  assert.equal(effect.mode, 'off')
  assert.equal(effect.runs, false)
  assert.equal(effect.sends, false)
})

test('A1：合成后的旧配置**不带**显式 mode（否则 resolveMode 会照办）', () => {
  const config = load({ presence: { enabled: true, groups: [GROUP] } })
  assert.equal(config.presence.mode, '', '合成器补出来的必须是空串')
})

// ── A1：新配置的显式值优先 ──────────────────────────────────────────────────

test('A1：显式 mode 优先于 enabled（写了 shadow 就不发）', () => {
  const effect = effectOf({ presence: { mode: 'shadow', enabled: true, groups: [GROUP] } })
  assert.equal(effect.mode, 'shadow')
  assert.equal(effect.runs, true, 'shadow 要真判断')
  assert.equal(effect.sends, false, 'shadow 一条都不发')
})

test('A1：显式 live 不必再打开 enabled（mode 是新的唯一权威）', () => {
  const effect = effectOf({ presence: { mode: 'live', enabled: false, groups: [GROUP] } })
  assert.equal(effect.mode, 'live')
  assert.equal(effect.runs, true, 'mode=live 时不该因为 enabled:false 就不跑')
  assert.equal(effect.sends, true)
})

test('A1：显式 off 即使 enabled:true 也不跑（这是"立刻停发"的首选手段）', () => {
  const effect = effectOf({ presence: { mode: 'off', enabled: true, groups: [GROUP] } })
  assert.equal(effect.mode, 'off')
  assert.equal(effect.runs, false)
  assert.equal(effect.sends, false)
})

test('A1：写错的 mode 不猜，退回 enabled 口径并留诊断', () => {
  const config = load({ presence: { mode: 'dry-run' as never, enabled: true, groups: [GROUP] } })
  assert.equal(resolveMode(config.presence), 'live', '不认识就按 enabled 推断，不静默停用')
})

// ── A2：热切换（不重启） ────────────────────────────────────────────────────

test('A2：off → shadow 不需要重建执行器（跑不跑是每次现取的）', () => {
  // 装配一次（config 是活对象），之后只改配置——模拟后台保存。
  const config = load({ presence: { mode: 'off', groups: [GROUP] } })
  const deps = { config: () => config }
  assert.equal(presenceAppliesTo(deps.config().presence, GROUP), false, 'off 时一条都不记')
  assert.equal(resolveMode(deps.config().presence), 'off')

  // 后台把它改成 shadow（这里直接改对象，等价于面板写入活配置）。
  config.presence.mode = 'shadow'
  assert.equal(presenceAppliesTo(deps.config().presence, GROUP), true, '改成 shadow 之后立刻开始旁听')
  assert.equal(modeSends(resolveMode(deps.config().presence)), false, '但一条都不发')
})

test('A2：live → off 立刻停（不需要重启，也不影响在途结果）', () => {
  const config = load({ presence: { mode: 'live', groups: [GROUP] } })
  assert.equal(presenceAppliesTo(config.presence, GROUP), true)
  config.presence.mode = 'off'
  assert.equal(presenceAppliesTo(config.presence, GROUP), false, '下一条消息起就不再记旁听')
  assert.equal(modeSends(resolveMode(config.presence)), false)
})

test('A2：live → off → live 之后判据仍然一致（不残留旧值）', () => {
  const config = load({ presence: { mode: 'live', groups: [GROUP] } })
  for (const mode of ['off', 'live', 'shadow', 'live', 'off', 'live'] as const) {
    config.presence.mode = mode
    assert.equal(resolveMode(config.presence), mode)
    assert.equal(presenceAppliesTo(config.presence, GROUP), modeRuns(mode))
    assert.equal(modeSends(resolveMode(config.presence)), mode === 'live')
  }
})

test('A2：白名单管"哪些群"，模式管"跑不跑"——两件事正交', () => {
  const config = load({ presence: { mode: 'shadow', groups: [GROUP] } })
  assert.equal(presenceAppliesTo(config.presence, GROUP), true)
  assert.equal(presenceAppliesTo(config.presence, 999_999), false, '白名单外不跑')
  config.presence.mode = 'off'
  assert.equal(presenceAppliesTo(config.presence, GROUP), false, '模式关了就都不跑')
})

// ── 契约守卫 ────────────────────────────────────────────────────────────────

test('三个模式的能力矩阵仍然只有 live 能发（改动这里的后果是真实的群消息）', () => {
  const senders = GROUP_PRESENCE_MODES.filter((mode) => modeSends(mode))
  assert.deepEqual(senders, ['live'])
  // 空串不是合法模式值（它只存在于配置层，表示"未指定"）。
  assert.equal(GROUP_PRESENCE_MODES.includes('' as never), false)
})
