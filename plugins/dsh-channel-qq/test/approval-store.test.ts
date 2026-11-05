/** 审批存储与 IM 命令的测试：全部在临时目录里跑，不碰系统路径。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const store = await import('../src/features/approval/store.js')
const { handleAdminCommand } = await import('../src/features/approval/commands.js')

function withDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qq-approval-'))
    try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

test('申请 → 批准 → 核验：队列文件出现，命令一致才放行', withDir(async (dir) => {
  const req = await store.requestCommand('systemctl restart dsh', dir)
  assert.equal(req.level, 'L2')
  assert.ok(existsSync(path.join(dir, 'requests', `${req.id}.json`)))

  const approved = await store.approveById(req.id, dir)
  assert.equal(approved.status, 'approved')
  assert.ok(existsSync(path.join(dir, 'queue', `${req.id}.req`)), '批准即落队列标记')

  // 命令被改：哈希不匹配，拒绝。
  const changed = await store.consumeById(req.id, 'systemctl restart napcat', dir)
  assert.equal(changed.ok, false)
  if (!changed.ok) assert.equal(changed.reason, 'hash-mismatch')

  // 原命令：通过，并标记 consumed。
  const good = await store.consumeById(req.id, 'systemctl restart dsh', dir)
  assert.equal(good.ok, true)

  // 一次性：再来一次必须是 consumed。
  const again = await store.consumeById(req.id, 'systemctl restart dsh', dir)
  assert.equal(again.ok, false)
  if (!again.ok) assert.equal(again.reason, 'consumed')
}))

test('L3 申请直接拒绝（连请求都建不出来）', withDir(async (dir) => {
  await assert.rejects(() => store.requestCommand('rm -rf /', dir), /L3 永不执行/)
}))

test('回执：先列出、发送成功后才删（失败不会丢）', withDir(async (dir) => {
  await store.writeResult({ id: 'appr-1', command: 'ls', ok: true, exitCode: 0, output: 'ok', finishedAt: 1 }, dir)
  const first = await store.listResults(dir)
  assert.equal(first.length, 1)
  // 没删之前重复读仍在（旧实现"读即删"，发送失败就永久丢失）
  assert.equal((await store.listResults(dir)).length, 1)
  await store.removeResult('appr-1', dir)
  assert.equal((await store.listResults(dir)).length, 0)
}))

test('IM 命令：群里完全静默（不回、不执行）；私聊里动作正确', withDir(async (dir) => {
  const admins = [42]
  const group = await handleAdminCommand('待批', 42, { isGroup: true, admins, dir })
  // 回复一句「只认私聊」等于告诉任何群友这里有审批后门，还能被拿来刷屏。
  assert.equal(group.handled, false)

  const stranger = await handleAdminCommand('待批', 7, { isGroup: false, admins, dir })
  if (stranger.handled) assert.match(stranger.reply, /无权操作/)

  const empty = await handleAdminCommand('待批', 42, { isGroup: false, admins, dir })
  if (empty.handled) assert.match(empty.reply, /没有待批/)

  const applied = await handleAdminCommand('申请 systemctl restart dsh', 42, { isGroup: false, admins, dir })
  assert.equal(applied.handled, true)
  const id = /appr-[A-Za-z0-9-]+/.exec(applied.handled ? applied.reply : '')?.[0]
  assert.ok(id !== undefined, '回执里要带请求号')

  const listed = await handleAdminCommand('待批', 42, { isGroup: false, admins, dir })
  if (listed.handled) assert.match(listed.reply, new RegExp(id!))

  const approved = await handleAdminCommand(`批准 ${id}`, 42, { isGroup: false, admins, dir })
  if (approved.handled) assert.match(approved.reply, /已批准/)

  const denied = await handleAdminCommand(`拒绝 ${id}`, 42, { isGroup: false, admins, dir })
  if (denied.handled) assert.match(denied.reply, /操作失败/, '已批准的不能再拒绝')

  const notMine = await handleAdminCommand('今天吃啥', 42, { isGroup: false, admins, dir })
  assert.equal(notMine.handled, false)
}))

test('并发批准：同一个请求只能成功一次（不会产生幽灵令牌）', withDir(async (dir) => {
  const req = await store.requestCommand('systemctl restart dsh', dir)
  const results = await Promise.allSettled([
    store.approveById(req.id, dir, Date.now(), 'dm-1'),
    store.approveById(req.id, dir, Date.now(), 'dm-2'),
  ])
  const ok = results.filter((r) => r.status === 'fulfilled')
  assert.equal(ok.length, 1, '两次并发批准只能有一次成功')
}))
