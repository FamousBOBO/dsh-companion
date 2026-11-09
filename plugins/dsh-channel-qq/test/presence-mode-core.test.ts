/** 运行模式解析（P5-B）的单元测试。
 *
 * 这一层的全部风险都在**向后兼容**：升级不能把已经在 `enabled:true` 跑的部署静默关掉，
 * 也不能让它突然开始发消息。所以用例一半在测"旧配置行为不变"，一半在测"新模式确实更严"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MODE,
  GROUP_PRESENCE_MODES,
  modeJudges,
  modeNoteOf,
  modeRuns,
  modeSends,
  resolveMode,
} from '../src/core/presence-mode.js'

test('默认模式是 off（默认关着是本项目一贯的做法）', () => {
  assert.equal(DEFAULT_MODE, 'off')
  assert.equal(resolveMode(null), 'off')
  assert.equal(resolveMode(undefined), 'off')
  assert.equal(resolveMode({}), 'off')
})

test('旧配置向后兼容：enabled:true → live，enabled:false → off', () => {
  assert.equal(resolveMode({ enabled: true }), 'live')
  assert.equal(resolveMode({ enabled: false }), 'off')
  assert.equal(resolveMode({ enabled: true, mode: '' }), 'live', '空串视为没写')
  assert.equal(resolveMode({ enabled: true, mode: '   ' }), 'live', '空白也视为没写')
})

test('显式的 mode 优先于 enabled（写了 shadow 就不该发）', () => {
  assert.equal(resolveMode({ enabled: true, mode: 'shadow' }), 'shadow')
  assert.equal(resolveMode({ enabled: true, mode: 'off' }), 'off')
  assert.equal(resolveMode({ enabled: false, mode: 'live' }), 'live', '显式写 live 就是 live')
})

test('大小写与空格归一', () => {
  assert.equal(resolveMode({ mode: ' SHADOW ' }), 'shadow')
  assert.equal(resolveMode({ mode: 'Live' }), 'live')
})

test('写了不认识的 mode：不猜，退回 enabled 口径，并给出诊断串', () => {
  assert.equal(resolveMode({ enabled: true, mode: 'dry-run' }), 'live')
  assert.equal(resolveMode({ enabled: false, mode: 'dry-run' }), 'off')
  assert.match(modeNoteOf({ mode: 'dry-run' }), /不是合法模式/)
  assert.equal(modeNoteOf({ mode: 'shadow' }), '', '合法值不该有诊断串')
  assert.equal(modeNoteOf({}), '')
  assert.equal(modeNoteOf(null), '')
})

test('三个模式的能力矩阵', () => {
  for (const mode of GROUP_PRESENCE_MODES) {
    // off：什么都不做。
    if (mode === 'off') {
      assert.equal(modeRuns(mode), false)
      assert.equal(modeJudges(mode), false)
      assert.equal(modeSends(mode), false)
      continue
    }
    // shadow：跑判断，但不发。
    if (mode === 'shadow') {
      assert.equal(modeRuns(mode), true)
      assert.equal(modeJudges(mode), true, 'shadow 必须真判断，否则影子日志没有意义')
      assert.equal(modeSends(mode), false)
      continue
    }
    // live：三个都行。
    assert.equal(modeRuns(mode), true)
    assert.equal(modeJudges(mode), true)
    assert.equal(modeSends(mode), true)
  }
})

test('只有 live 允许发送（这条是全模块唯一的判据，改动前想清楚）', () => {
  const senders = GROUP_PRESENCE_MODES.filter((mode) => modeSends(mode))
  assert.deepEqual(senders, ['live'])
})
