/** P2.2 结构化日志：文本行一个字都不变，结构化记录并排可查。
 *
 * 这组用例守两件事：
 *   1. **兼容**——`channel-qq.log` 必须继续是纯文本（`deploy/log-analyze.mjs`
 *      与后台日志页按那个格式读）。把它写成 JSONL 会让两个消费者同时坏掉。
 *   2. **可查**——`{ts, level, scope, msg, fields}` 能按作用域与级别过滤，
 *      两条流用同一个时间戳。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { createLogSink, createLogger, splitScope } from '../src/adapters/log/logger.js'
import { formatLocalStamp as localStamp } from '../src/core/schedule/stamp.js'
import { JsonlLogStream, jsonCodec, plainCodec } from '../src/adapters/fs-store/log-stream.js'
import type { LogRecord } from '../src/ports/logger.js'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'log-'))
}

/** 组装一套日志出口，并把文本/结构化两条流都读回来。 */
async function withSink(run: (log: ReturnType<typeof createLogger>, files: { text: string; jsonl: string }) => Promise<void>): Promise<void> {
  const dir = scratch()
  try {
    const textFile = path.join(dir, 'channel-qq.log')
    const recordFile = path.join(dir, 'channel-qq.jsonl')
    const { sink } = createLogSink({ textFile, recordFile })
    await run(createLogger(sink, 'qq'), { text: textFile, jsonl: recordFile })
    // 追加是 fire-and-forget，等一次事件循环让写入落地。
    await new Promise((r) => setTimeout(r, 50))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const readLines = (file: string): string[] =>
  readFileSync(file, 'utf-8').split('\n').filter((l) => l !== '')

test('localStamp：本地时间带显式偏移（不是 UTC）', () => {
  const at = new Date(2026, 9, 16, 19, 6, 17, 926)   // 本地时间 2026-10-16 19:06:17.926
  const stamp = localStamp(at)
  assert.equal(stamp.startsWith('2026-10-16T19:06:17.926'), true, stamp)
  assert.equal(/[+-]\d{2}:\d{2}$/.test(stamp), true, `必须带偏移：${stamp}`)
})

test('splitScope：拆出作用域，拆不出就用兜底', () => {
  assert.deepEqual(splitScope('quotes: loaded 3 entr(ies)', 'qq'), { scope: 'quotes', msg: 'loaded 3 entr(ies)' })
  assert.deepEqual(splitScope('knowledge: diary too short, skip', 'qq'),
    { scope: 'knowledge', msg: 'diary too short, skip' })
  // 拆不出来的落到兜底作用域。**这是有意的保守**：文本行一个字都不改，
  // 所以 `scheduler started: ...` 这种"前缀里带空格"的行拿不到 scope=scheduler，
  // 只能落到兜底。宁可少认，也不能把 "QQ 未连接: xxx" 的前半截当作用域。
  assert.deepEqual(splitScope('scheduler started: patrol 9min', 'qq'),
    { scope: 'qq', msg: 'scheduler started: patrol 9min' })
  assert.deepEqual(splitScope('starting (mode=reverse)', 'qq'), { scope: 'qq', msg: 'starting (mode=reverse)' })
  assert.deepEqual(splitScope('中文开头: 内容', 'qq'), { scope: 'qq', msg: '中文开头: 内容' })
  assert.deepEqual(splitScope('QQ: 未连接', 'qq'), { scope: 'qq', msg: 'QQ: 未连接' })
})

test('文本流保持纯文本（log-analyze / 后台日志页的格式不变）', async () => {
  await withSink(async (log, files) => {
    log.line('quotes: loaded 3 entr(ies)')
    log.line('tts: registered 3/3 tools')
  })
  // 上面 withSink 已经删了目录，这里改成一个不删的写法重跑
  const dir = scratch()
  try {
    const textFile = path.join(dir, 'channel-qq.log')
    const recordFile = path.join(dir, 'channel-qq.jsonl')
    const { sink } = createLogSink({ textFile, recordFile })
    const log = createLogger(sink, 'qq')
    log.line('quotes: loaded 3 entr(ies)')
    await new Promise((r) => setTimeout(r, 50))
    const raw = readFileSync(textFile, 'utf-8')
    // 旧格式：`<ISO 时间戳> <原文>`，**没有引号、没有 JSON**
    assert.equal(/^\d{4}-\d{2}-\d{2}T[\d:.]+\+\d{2}:\d{2} quotes: loaded 3 entr\(ies\)\n$/.test(raw), true, JSON.stringify(raw))
    assert.equal(raw.includes('"'), false, '纯文本里不该出现 JSON 引号')

    const records = readLines(recordFile).map((l) => JSON.parse(l) as LogRecord)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.scope, 'quotes')
    assert.equal(records[0]?.msg, 'loaded 3 entr(ies)')
    assert.equal(records[0]?.level, 'info')
    // 两条流同一个时间戳
    assert.equal(raw.startsWith(`${records[0]?.ts ?? ''} `), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('结构化记录带 fields，级别可选', async () => {
  const dir = scratch()
  try {
    const textFile = path.join(dir, 'a.log')
    const recordFile = path.join(dir, 'a.jsonl')
    const { sink } = createLogSink({ textFile, recordFile })
    const log = createLogger(sink, 'qq')
    log.warn('imagegen: 生图失败', { tries: 3, provider: 'pollinations' })
    log.error('admin: 端口占用', { port: 8790 })
    await new Promise((r) => setTimeout(r, 50))

    const records = readLines(recordFile).map((l) => JSON.parse(l) as LogRecord)
    assert.equal(records.length, 2)
    assert.equal(records[0]?.level, 'warn')
    assert.deepEqual(records[0]?.fields, { tries: 3, provider: 'pollinations' })
    assert.equal(records[1]?.level, 'error')
    assert.equal(records[1]?.scope, 'admin')
    // 文本行里只有原文：fields 不进文本行（否则格式又变了）。
    // 结构化流里能查到 `pollinations`，文本流里查不到——这正是"字段"的意义。
    const text = readFileSync(textFile, 'utf-8')
    assert.equal(text.includes('imagegen: 生图失败'), true)
    assert.equal(text.includes('pollinations'), false)
    assert.equal(text.includes('"tries"'), false)
    assert.equal(readFileSync(recordFile, 'utf-8').includes('pollinations'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('JsonlLogStream：追加、读尾、封顶、坏行不致命', async () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'x.jsonl')
    const stream = new JsonlLogStream<{ n: number }>(file, { codec: jsonCodec<{ n: number }>() })
    for (let i = 0; i < 10; i++) await stream.append({ n: i })
    assert.deepEqual((await stream.tail(3)).map((e) => e.n), [7, 8, 9])

    await stream.trim(4)
    assert.deepEqual((await stream.tail(10)).map((e) => e.n), [6, 7, 8, 9])

    // 半截写入（崩溃之后是常态）不该让整份日志读不出来
    const raw = readFileSync(file, 'utf-8')
    writeFileSync(file, `${raw}{ 这不是 JSON\n`, 'utf-8')
    assert.deepEqual((await stream.tail(10)).map((e) => e.n), [6, 7, 8, 9])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plainCodec 与 jsonCodec 的分工', () => {
  assert.equal(plainCodec.encode('一行原文'), '一行原文')
  assert.equal(plainCodec.decode('一行原文'), '一行原文')
  const codec = jsonCodec<{ a: number }>()
  assert.equal(codec.encode({ a: 1 }), '{"a":1}')
  assert.deepEqual(codec.decode('{"a":1}'), { a: 1 })
})
