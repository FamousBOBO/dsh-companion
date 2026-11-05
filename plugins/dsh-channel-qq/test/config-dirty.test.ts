/** P2.7 配置解析：**有意改掉**的那些脏输入行为。
 *
 * `config-layers.test.ts` 守的是"真实配置的解析结果与旧实现逐字节相等"。这里
 * 相反：记录三处旧实现在脏输入下会产出垃圾、而新实现改为"当作没给"的地方。
 * 写下来是因为**改动本身需要理由**，而理由不该只留在提交说明里。
 *
 * 三处的共同点：它们都不是任何人在意的行为，只是 `Object.assign` 的副作用。
 * 把它们留着，等于让"配置文件里有个 `undefined`"从"这一项没配"变成"这一项被
 * 抹掉了"——而配置项被抹掉的表现是功能静默失效，最难查的那类故障。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js'

test('段被写成非对象：当作没给，而不是按字符索引铺开', () => {
  // 旧行为：Object.assign({}, DEFAULT.admin, 'nope') → {"0":"n","1":"o","2":"p","3":"e",…}
  const resolved = resolveConfig(undefined, { admin: 'nope' } as never)
  assert.deepEqual(resolved.admin, DEFAULT_CONFIG.admin)
  assert.equal(resolved.admin.port, 8790)
})

test('段被写成 null：当作没给', () => {
  const resolved = resolveConfig(undefined, { stt: null, emoji: null } as never)
  assert.deepEqual(resolved.stt, DEFAULT_CONFIG.stt)
  assert.deepEqual(resolved.emoji, DEFAULT_CONFIG.emoji)
})

test('字段被显式写成 undefined：当作没给，而不是把这一项抹掉', () => {
  // 旧行为：Object.assign({}, DEFAULT, {talkValue: undefined}) → talkValue: undefined，
  // 于是"配置里有这一项"变成"这一项是空的"。
  const resolved = resolveConfig(undefined, { talkValue: undefined } as never)
  assert.equal(resolved.talkValue, DEFAULT_CONFIG.talkValue)
})

test('段里的字段被写成 undefined：同上', () => {
  const resolved = resolveConfig(undefined, { batching: { windowMs: undefined } } as never)
  assert.equal(resolved.batching.windowMs, DEFAULT_CONFIG.batching.windowMs)
})

test('可选项被显式写成 undefined：键不该留在结果里', () => {
  const resolved = resolveConfig(undefined, { accessToken: undefined } as never)
  assert.equal('accessToken' in resolved, false)
})

test('数组字段给了非数组：当作没给（旧实现只对 cruises 做了这个保护）', () => {
  const resolved = resolveConfig(undefined, { admins: 'not-an-array' } as never)
  assert.deepEqual(resolved.admins, [])
})

test('正常输入一个字都没变（与旧实现同一套语义）', () => {
  const resolved = resolveConfig({ talkValue: 0.3 }, { talkValue: 0.9, batching: { windowMs: 5000 } } as never)
  assert.equal(resolved.talkValue, 0.9, 'override 赢 patch')
  assert.equal(resolved.batching.windowMs, 5000)
  assert.equal(resolved.batching.maxMessages, DEFAULT_CONFIG.batching.maxMessages, '同段其它字段来自默认值')
})
