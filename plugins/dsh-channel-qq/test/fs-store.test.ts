/** 原子写、串行化、JSON 存储的行为断言。
 *
 * 守的是一条数据安全线：这四处（记忆、语录、提醒、好感度）**丢了回不来**。
 * 原来的写法是 `writeFile(JSON.stringify(...))`——进程在中间死掉就留下半截
 * JSON，下一个进程读到的就是"整个 store 空了"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  atomicWriteFile,
  atomicWriteJson,
  readJsonFileOrNull,
  readTextFileOrNull,
  sweepTempFiles,
} from '../src/adapters/fs-store/atomic.js'
import { lockedKeys, withLock } from '../src/adapters/fs-store/mutex.js'
import { JsonStore, backupPathOf } from '../src/adapters/fs-store/json-store.js'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'fs-store-'))
}

test('原子写：内容正确、目录自动创建、不留临时文件', async () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'nested', 'deep', 'x.json')
    await atomicWriteJson(file, { a: 1 })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { a: 1 })
    assert.equal(readFileSync(file, 'utf-8').endsWith('\n'), true, '以换行结尾')
    assert.deepEqual(readdirSync(path.dirname(file)), ['x.json'], '目录里只剩目标文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('原子写：写不进去时目标文件保持原样（不产生半截文件）', async () => {
  const dir = scratch()
  try {
    // Windows 上 chmod 对管理员进程常常无效，所以这条是"能制造失败就断言，不能就跳过"。
    const roDir = path.join(dir, 'ro')
    const file = path.join(roDir, 'keep.json')
    await atomicWriteFile(file, 'keep-me')
    const { chmodSync } = await import('node:fs')
    chmodSync(roDir, 0o500)
    const failed = await atomicWriteFile(file, 'new').then(() => null, (error: Error) => error)
    chmodSync(roDir, 0o700)
    if (failed === null) {
      // 没能造出失败（多半是 Windows），那么至少断言正常路径没有半截文件。
      assert.equal(readFileSync(file, 'utf-8'), 'new')
      assert.deepEqual(readdirSync(roDir), ['keep.json'])
      return
    }
    assert.equal(readFileSync(file, 'utf-8'), 'keep-me', '失败时旧内容必须完好')
    assert.deepEqual(readdirSync(roDir), ['keep.json'], '失败时不留临时文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读：不存在 / 损坏 / 形状不对都返回 null（不抛）', async () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'x.json')
    assert.equal(await readTextFileOrNull(file), null)
    assert.equal(await readJsonFileOrNull(file), null)

    writeFileSync(file, '{ 这不是 JSON', 'utf-8')
    assert.equal(await readJsonFileOrNull(file), null)
    // 但原文能读到——"读不到"和"内容为空"必须能区分
    assert.equal(await readTextFileOrNull(file), '{ 这不是 JSON')

    writeFileSync(file, JSON.stringify({ n: '不是数字' }), 'utf-8')
    assert.equal(await readJsonFileOrNull(file, (v): v is { n: number } =>
      typeof v === 'object' && v !== null && typeof (v as { n?: unknown }).n === 'number'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清理孤儿临时文件（进程被杀时留下的）', async () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'x.json')
    await atomicWriteFile(file, 'ok')
    writeFileSync(`${file}.dsh-tmp-123-abc`, 'half', 'utf-8')
    writeFileSync(`${file}.dsh-tmp-456-def`, 'half', 'utf-8')
    assert.equal(await sweepTempFiles(dir), 2)
    assert.deepEqual(readdirSync(dir), ['x.json'])
    assert.equal(await sweepTempFiles(path.join(dir, 'not-there')), 0, '目录不存在不抛')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('串行化：同键排队且不丢更新，异键互不阻塞', async () => {
  const order: string[] = []
  const slow = async (tag: string, ms: number): Promise<void> => {
    order.push(`${tag} start`)
    await new Promise((r) => setTimeout(r, ms))
    order.push(`${tag} end`)
  }
  await Promise.all([
    withLock('a', () => slow('a1', 30)),   // 先占住 a
    withLock('a', () => slow('a2', 1)),    // 必须等 a1 结束才开始
    withLock('b', () => slow('b1', 1)),    // 与 a 无关，立刻并发
  ])
  // 同一键：首尾相接，不许交错
  assert.equal(order.indexOf('a1 end') < order.indexOf('a2 start'), true, `a 应当串行：${order.join(', ')}`)
  // 不同键：b 不必等 a
  assert.equal(order.indexOf('b1 end') < order.indexOf('a1 end'), true, `b 不该被 a 阻塞：${order.join(', ')}`)
  assert.deepEqual(order.filter((l) => l === 'a1 start' || l === 'a2 start'), ['a1 start', 'a2 start'], '先入先出')
})

test('串行化：一次失败不卡死后面的任务，且排队键会被回收', async () => {
  const ran: string[] = []
  const bad = await withLock('k', async () => { ran.push('bad'); throw new Error('boom') })
    .then(() => null, (e: Error) => e)
  assert.equal((bad as Error).message, 'boom')
  await withLock('k', async () => { ran.push('good') })
  assert.deepEqual(ran, ['bad', 'good'])
  // 队列跑空之后键要被清掉，长跑进程里不能无限增长
  assert.deepEqual(lockedKeys(), [])
})

test('JsonStore：读回、备份、回退', async () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'entries.json')
    const store = new JsonStore<{ version: number; items: string[] }>(file)

    // 首次读取：文件不存在 → fallback
    const empty = { version: 1, items: [] as string[] }
    assert.deepEqual(await store.load(empty), empty)

    await store.save({ version: 1, items: ['a'] })
    assert.deepEqual(await store.load(empty), { version: 1, items: ['a'] })
    assert.equal(existsSync(backupPathOf(file)), false, '第一次保存没有旧内容可备份')

    await store.save({ version: 1, items: ['a', 'b'] })
    assert.deepEqual(await store.loadBackup(), { version: 1, items: ['a'] }, '备份是上一版')

    // 模拟"写对了但内容是错的"：备份能把上一版捞回来
    await store.save({ version: 1, items: [] })
    assert.deepEqual(await store.load(empty), { version: 1, items: [] })
    await store.restoreBackup()
    assert.deepEqual(await store.load(empty), { version: 1, items: ['a', 'b'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('JsonStore：形状不对退回 fallback，不把坏数据当数据', async () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'x.json')
    writeFileSync(file, JSON.stringify({ wrong: true }), 'utf-8')
    const isShape = (v: unknown): v is { items: string[] } =>
      typeof v === 'object' && v !== null && Array.isArray((v as { items?: unknown }).items)
    const store = new JsonStore<{ items: string[] }>(file, { validate: isShape })
    assert.deepEqual(await store.load({ items: [] }), { items: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('JsonStore：并发保存不产生半截或交错的内容', async () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'x.json')
    const store = new JsonStore<{ n: number; payload: string }>(file)
    const big = 'x'.repeat(50_000)
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.save({ n: i, payload: big })),
    )
    const landed = await store.load({ n: -1, payload: '' })
    assert.equal(landed.payload.length, 50_000, '内容必须是完整的某一版')
    assert.ok(landed.n >= 0 && landed.n < 12)
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('dsh-tmp')), [], '不留临时文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
