/** 定时任务「今天做过了」的落盘标记。
 *
 * 改造前它是三个内存 Set，于是部署期每次重启都会让早报 / 梦 / 知识抽取重跑。
 * 这组测试守的是：标记跨进程存活、坏文件不炸启动、旧标记会被清掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pruneDone, SchedulerState } from '../src/scheduler-state.js'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'sched-state-'))
}

test('pruneDone：过期与坏时间戳都丢掉，新的留下', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z')
  const kept = pruneDone(
    {
      'morning-2026-10-16': '2026-10-16T06:00:00.000Z',
      'morning-2026-10-01': '2026-10-01T06:00:00.000Z',
      'dream-broken': '不是时间',
      'morning-2026-10-10': '2026-10-10T04:00:00.000Z',
    },
    now,
  )
  assert.deepEqual(Object.keys(kept).sort(), ['morning-2026-10-10', 'morning-2026-10-16'])
})

test('标记跨进程存活（重新 new 一个实例仍然命中）', () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'scheduler-state.json')
    const first = new SchedulerState({ file })
    first.load()
    assert.equal(first.has('morning-2026-10-16'), false)
    first.mark('morning-2026-10-16')
    assert.equal(first.has('morning-2026-10-16'), true)

    // 模拟重启：新进程、新实例、同一文件。
    const second = new SchedulerState({ file })
    second.load()
    assert.equal(second.has('morning-2026-10-16'), true)
    assert.equal(second.has('dream-2026-10-16'), false)

    const onDisk: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal((onDisk as { version: number }).version, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件不存在 / 损坏 / 结构不对：都当作空，不抛错', () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'scheduler-state.json')

    const missing = new SchedulerState({ file })
    missing.load()
    assert.equal(missing.size(), 0)

    writeFileSync(file, '{ this is not json', 'utf-8')
    const corrupt = new SchedulerState({ file })
    corrupt.load()
    assert.equal(corrupt.size(), 0)
    corrupt.mark('after-corrupt')
    assert.equal(corrupt.has('after-corrupt'), true)

    writeFileSync(file, '["array", "not", "object"]', 'utf-8')
    const wrongShape = new SchedulerState({ file })
    wrongShape.load()
    assert.equal(wrongShape.size(), 0)

    writeFileSync(file, JSON.stringify({ version: 1, done: { ok: 5, bad: 'x' } }), 'utf-8')
    const mixed = new SchedulerState({ file })
    mixed.load()
    assert.equal(mixed.size(), 1, '非字符串的值被丢掉，字符串留下')
    assert.equal(mixed.has('ok'), false)
    assert.equal(mixed.has('bad'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写入是原子的：临时文件不残留', () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'nested', 'scheduler-state.json')
    const state = new SchedulerState({ file })
    state.load()
    state.mark('dream-2026-10-16')
    const payload: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    assert.deepEqual(Object.keys((payload as { done: Record<string, string> }).done), ['dream-2026-10-16'])
    // tmp 文件应已被 rename 掉。
    assert.throws(() => readFileSync(`${file}.tmp`, 'utf-8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('注入时钟可让标记立刻过期', () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'scheduler-state.json')
    let now = Date.parse('2026-10-16T06:00:00.000Z')
    const state = new SchedulerState({ file, now: () => now })
    state.load()
    state.mark('morning-2026-10-16')
    assert.equal(state.has('morning-2026-10-16'), true)

    // 8 天后（保留期 7 天）再写一次，旧键应被清掉。
    now += 8 * 24 * 60 * 60 * 1000
    state.mark('morning-2026-10-24')
    assert.equal(state.has('morning-2026-10-16'), false)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf-8')).done), ['morning-2026-10-24'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
