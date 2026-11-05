/** 配置引擎（`src/admin/config-engine.ts`）：纯逻辑单测。
 *
 * 保存管线里"哪次写入合法、diff 怎么算、历史怎么记、回滚怎么反着走、敏感值
 * 什么时候出网"全在这里被钉死——admin.ts 只做 HTTP 装配。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  ConfigHistory, cloneJson, computeChanges, deepEqual, getPath, inversePatch,
  maskConfigForView, maskSecretText, restartPathsIn, secretValuesOf, setPath,
  validatePatch, walkLeaves,
} from '../src/admin/config-engine.js'
import { resolveConfig } from '../src/config.js'

test('walkLeaves：数组是叶子、undefined 跳过、路径拼接正确', () => {
  const seen: Array<[string, unknown]> = []
  walkLeaves({ a: { b: 1, c: [1, 2] }, d: undefined, e: true }, (p, v) => seen.push([p, v]))
  assert.deepEqual(seen, [['a.b', 1], ['a.c', [1, 2]], ['e', true]])
})

test('getPath / setPath 往返；cloneJson 是深拷贝', () => {
  const obj = cloneJson({ tts: { voice: 'x' } })
  assert.equal(getPath(obj, 'tts.voice'), 'x')
  setPath(obj, 'tts.rate', 1.2)
  assert.equal(getPath(obj, 'tts.rate'), 1.2)
  assert.equal(getPath(obj, 'nope.deep'), undefined)
  const source = { a: { b: [1] } }
  const copy = cloneJson(source) as typeof source
  copy.a.b.push(2)
  assert.deepEqual(source.a.b, [1], 'cloneJson 必须深拷贝')
})

test('deepEqual：数组/对象按内容', () => {
  assert.ok(deepEqual([1, 2], [1, 2]))
  assert.ok(!deepEqual([1, 2], [2, 1]))
  assert.ok(deepEqual({ a: 1 }, { a: 1 }))
  assert.ok(!deepEqual(null, {}))
  assert.ok(!deepEqual('a', 1))
})

test('validatePatch：未知路径 / 类型错 / 越界 / 合法补丁', () => {
  assert.deepEqual(validatePatch({}), [])
  const unknown = validatePatch({ nope: 1 })
  assert.equal(unknown.length, 1)
  assert.match(unknown[0]!.error, /未知配置项/)
  const bad = validatePatch({ talkValue: 'high' })
  assert.equal(bad.length, 1)
  assert.equal(bad[0]!.path, 'talkValue')
  const outOfRange = validatePatch({ talkValue: 9 })
  assert.match(outOfRange[0]!.error, /不能大于/)
  assert.deepEqual(validatePatch({ tts: { voice: 'zh' } }), [])
})

test('掩码：secret 值置空 + secretSet 标记；文本掩码替换全部出现', () => {
  const config = resolveConfig()
  config.accessToken = 'sekrit-value-123'
  config.admin.password = ''
  const { config: masked, secretSet } = maskConfigForView(config)
  assert.equal(getPath(masked, 'accessToken'), '', 'accessToken 必须被掩码')
  assert.equal(secretSet.accessToken, true)
  assert.equal(secretSet['admin.password'], false, '空口令应当标为未设置')
  const values = secretValuesOf(config)
  assert.ok(values.includes('sekrit-value-123'))
  assert.equal(maskSecretText('a sekrit-value-123 b sekrit-value-123', values), 'a •••• b ••••')
})

test('computeChanges：无变化为空；有变化带标签/热等级；敏感字段不带明文', () => {
  const config = resolveConfig()
  config.accessToken = 'old-secret'
  assert.deepEqual(computeChanges(config, { talkValue: config.talkValue }), [])
  const changes = computeChanges(config, { talkValue: 0.9, accessToken: 'new-secret' }, undefined, { accessToken: true })
  assert.equal(changes.length, 2)
  const talk = changes.find((c) => c.path === 'talkValue')
  assert.ok(talk !== undefined)
  assert.equal(talk.hot, 'live')
  assert.equal(typeof talk.label, 'string')
  assert.equal(talk.old, String(config.talkValue))
  const secret = changes.find((c) => c.path === 'accessToken')
  assert.ok(secret !== undefined && secret.secret === true)
  assert.equal(secret.old, '（已设置）')
  assert.equal(secret.new, '（新值）')
  assert.ok(!JSON.stringify([secret.old, secret.new]).includes('new-secret'), '敏感字段的展示值不能含明文')
})

test('restartPathsIn 只挑 restart 级；inversePatch 反着写回旧值', () => {
  const config = resolveConfig()
  const changes = computeChanges(config, { workspacePath: '/tmp/x', talkValue: 0.5 })
  assert.deepEqual(restartPathsIn(changes), ['workspacePath'])
  const back = inversePatch(changes)
  assert.equal(getPath(back, 'workspacePath'), config.workspacePath)
  assert.equal(getPath(back, 'talkValue'), config.talkValue)
})

test('ConfigHistory：落盘、版本单调、读回一致、上限 20、损坏文件不抛错', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'admin-history-'))
  const file = path.join(dir, 'admin-config-history.json')
  try {
    const history = new ConfigHistory(file, () => {})
    await history.load()
    assert.equal(history.current, 1)
    const entry = await history.record('save', [])
    assert.equal(entry.version, 2)
    assert.equal(history.current, 2)

    const reloaded = new ConfigHistory(file, () => {})
    await reloaded.load()
    assert.equal(reloaded.current, 2)
    assert.equal(reloaded.list().length, 1)
    assert.equal(reloaded.find(2)?.source, 'save')

    for (let i = 0; i < 25; i += 1) await reloaded.record('save', [])
    assert.equal(reloaded.list().length, 20, '历史必须封顶 20 条')
    assert.equal(reloaded.find(2), undefined, '被挤出上限的条目应当查不到')
    assert.equal(reloaded.current, 27, '版本号不受上限影响，仍然单调')

    writeFileSync(file, '{ not json', 'utf8')
    const broken = new ConfigHistory(file, () => {})
    await broken.load()
    assert.equal(broken.current, 1, '损坏的历史文件不能让进程起不来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
