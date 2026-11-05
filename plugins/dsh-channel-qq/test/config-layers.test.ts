/** P2.7 特征测试：配置解析（schema 驱动之后必须与旧实现深度相等）。
 *
 * 做法是"先取快照、再重构"：这些输入与输出是在**改代码之前**用当时的
 * `resolveConfig` 生成的，重构之后必须逐字节一致。这正是 P2.7 的完成判据
 * ——"现有 `admin-config.json` 加载结果与旧 `resolveConfig` 深度相等"。
 *
 * 输入刻意覆盖了那些**容易在重写里走样**的地方：
 *   - 只给一段里的一个字段（其余字段必须来自默认值，不能被整段替换掉）；
 *   - 优先级（override 覆盖 patch 覆盖默认值）；
 *   - 数组字段（`cruises` / `feeds` / `keywordTriggers`：整体替换而不是合并）；
 *   - `groupEnabled` 的三元写法（它历史上不是纯 merge，是 `override ?? patch ?? true`）。
 *
 * 脏输入（`undefined` / 字符串塞进对象段）**不在这里**：旧实现对它们的处理是
 * "`Object.assign` 遇到非对象就当索引铺开"，`admin: "nope"` 会变成
 * `{"0":"n","1":"o",…}`——那是 bug 不是行为。这类输入的结果记在
 * `config-dirty.test.ts` 里，写明"改了什么、为什么"，而不是当成兼容目标。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { golden } from './golden.js'

/** 一组"层"：patch 是 cordis 行的用户层，override 是后台持久化层。 */
const CASES: Array<{ name: string; patch?: Record<string, unknown>; override?: Record<string, unknown> }> = [
  { name: '00-纯默认' },
  {
    name: '01-黄金用例（主群 + 学弟 + 关视觉）',
    patch: {
      selfId: 1000000001, admins: [1000000002], primaryGroup: 1000000003,
      workspacePath: '/tmp/ws', requireMention: true,
      imageRecognition: { enabled: false, serverOcr: false, maxPerMessage: 2 },
    },
  },
  { name: '02-后台只改一个字段', override: { batching: { windowMs: 20000 } } },
  { name: '03-后台只改一个字段（另一段）', override: { admin: { port: 8790 } } },
  { name: '04-imageGen 只给 model', override: { imageGen: { model: 'flux' } } },
  { name: '05-两层同时给同一段，override 获胜', patch: { tts: { voice: 'a' } }, override: { tts: { voice: 'b' } } },
  { name: '06-override 只给一半，另一半来自 patch', patch: { flood: { windowSec: 60, maxMessages: 20 } }, override: { flood: { windowSec: 30 } } },
  { name: '07-数组整体替换', patch: { cruises: [{ id: 'a', script: 'scripts/a.mjs', intervalMin: 30, enabled: true }] } },
  { name: '08-空数组覆盖默认', override: { keywordTriggers: [] } },
  { name: '09-rss feeds 两层', patch: { rss: { feeds: [{ id: 'f1', url: 'https://x/feed', room: 'group', target: 1 }] } }, override: { rss: { pollIntervalMin: 5 } } },
  { name: '10-groupEnabled 三元：override 优先', patch: { groupEnabled: true }, override: { groupEnabled: false } },
  { name: '11-groupEnabled 只有 patch', patch: { groupEnabled: false } },
  { name: '12-groupEnabled override 显式为 true', patch: { groupEnabled: false }, override: { groupEnabled: true } },
  { name: '13-admin.host 只改一处', override: { admin: { host: '127.0.0.1' } } },
  { name: '14-空对象的两层', patch: {}, override: {} },
  {
    name: '15-线上真实那份 admin-config.json',
    override: { imageGen: { model: 'flux' }, batching: { windowMs: 20000 }, admin: { port: 8790 }, groupEnabled: false },
  },
]

test('P2.7 配置解析：schema 驱动之后与旧实现逐字节相等', () => {
  const rendered = CASES.map((c) => [
    `════ ${c.name}`,
    `patch    = ${JSON.stringify(c.patch ?? {})}`,
    `override = ${JSON.stringify(c.override ?? {})}`,
    JSON.stringify(
      resolveConfig(c.patch as never, c.override as never),
      null,
      1,
    ),
  ].join('\n')).join('\n\n')
  golden('config/layers', `${rendered}\n`)
})

test('P2.7 配置解析：默认值本身就是一份可用配置', () => {
  const resolved = resolveConfig()
  assert.equal(resolved.connection.mode, 'forward')
  assert.equal(resolved.admin.host, '127.0.0.1', 'P0 起后台默认只听本机')
  assert.equal(resolved.groupAdmin.dangerous, false, '危险动作默认关闭')
  assert.equal(resolved.batching.windowMs, 20_000)
})

test('配置归一：字符串数字按 schema 变成数字（主群号/群号列表/概率）', () => {
  // 2026-10-19 线上实证：admin-config.json 里 primaryGroup 是字符串 "1000000004"，
  // 而消费方全是 `chatId === primaryGroup` 的严格比较 ⇒ 偷表情包、主群专用回复、
  // 按群覆盖全部恒假且完全静默。
  const config = resolveConfig({}, {
    primaryGroup: '1000000004' as never,
    talkValue: '0.5' as never,
    linkResolve: { autoGroups: ['123', '456'] as never },
  } as never)
  assert.equal(config.primaryGroup, 1000000004)
  assert.equal(typeof config.primaryGroup, 'number')
  assert.equal(config.talkValue, 0.5)
  assert.deepEqual(config.linkResolve.autoGroups, [123, 456])
  assert.equal(typeof config.linkResolve.autoGroups[0], 'number')
})

test('配置归一：转换不了的值原样保留，不把错值改造成另一种错值', () => {
  const config = resolveConfig({}, { primaryGroup: '不是数字' as never, talkValue: 'abc' as never } as never)
  assert.equal(config.primaryGroup, '不是数字')
  assert.equal(config.talkValue, 'abc')
})
