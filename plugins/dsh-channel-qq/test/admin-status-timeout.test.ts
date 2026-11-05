/** 快照状态读取必须有时限：QQ 往返挂住时不能让整页数据消失。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { statusWithTimeout } = await import('../src/admin/util.js')

test('状态：正常返回原样结果', async () => {
  const got = await statusWithTimeout(async () => ({ qqConnected: true }), 100)
  assert.equal(got.qqConnected, true)
})

test('状态：超时返回可读占位，不抛错', async () => {
  const started = Date.now()
  const got = await statusWithTimeout(() => new Promise(() => {}), 30)
  assert.match(String(got.unavailable), /超时/)
  assert.ok(Date.now() - started < 1000)
})

test('状态：抛错时也返回可读原因', async () => {
  const got = await statusWithTimeout(async () => { throw new Error('boom') }, 100)
  assert.match(String(got.unavailable), /boom/)
})
