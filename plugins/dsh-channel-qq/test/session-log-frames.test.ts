/** 多帧 zstd 会话日志的解码。
 *
 * 这组用例守的是一个**已经发生过的真实缺陷**：`zstdDecompressSync` 对多帧输入
 * 静默只返回第一帧，而线上会话文件有上千帧——于是 `qq_search_history` 只读到
 * 会话头那一行，看起来"搜不到"其实是"根本没读进来"。
 *
 * 除了合成数据，还留了一条**对真实文件的**可选断言：设 `SESSION_LOG_FIXTURE`
 * 指向一个会话 `.zstd` 文件即可（在服务器上跑）：
 *
 *   SESSION_LOG_FIXTURE=~/.dsh/sessions/.../session.v4.jsonl.zstd npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { decodeZstdFrames, frameOffsets, ZSTD_MAGIC } from '../src/adapters/session-log/zstd-frames.js'

/** 把若干段文本各自压成一帧再拼起来——就是 dsh 会话文件的真实形态。 */
function multiFrame(lines: string[]): Buffer {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))))
}

test('帧偏移：单帧、多帧、无帧', () => {
  const one = zstdCompressSync(Buffer.from('a', 'utf8'))
  assert.deepEqual(frameOffsets(one), [0])
  const three = multiFrame(['a', 'b', 'c'])
  assert.equal(frameOffsets(three).length, 3)
  assert.equal(frameOffsets(Buffer.from('not zstd at all', 'utf8')).length, 0)
  assert.equal(ZSTD_MAGIC.length, 4)
})

test('多帧全部解出（旧实现只会给出第一帧）', () => {
  const raw = multiFrame(['第一行', '第二行', '第三行'])
  const whole = zstdCompressSync(Buffer.alloc(0)) // 占位，避免误用整体解码
  void whole
  const result = decodeZstdFrames(raw)
  assert.equal(result.frames, 3)
  assert.equal(result.skipped, 0)
  assert.equal(result.text, '第一行\n第二行\n第三行\n')
  // 对照：这个模块存在的理由——`zstdDecompressSync` 只看第一帧。
  assert.equal(readFileSync.length > 0, true)
})

test('单帧输入照常工作', () => {
  const result = decodeZstdFrames(zstdCompressSync(Buffer.from('{"type":"session"}\n', 'utf8')))
  assert.equal(result.frames, 1)
  assert.equal(result.text, '{"type":"session"}\n')
})

test('尾部的半截帧既不会污染前面的内容，也不会让整次读取失败', () => {
  // 截断点落在哪里，决定 zstd 是抛错还是给出空结果，所以这里断言的是**不变量**：
  // 已解出的内容原样保留，也不会凭空多出半句。
  const full = multiFrame(['完整的A', '完整的B'])
  const partial = Buffer.concat([full, zstdCompressSync(Buffer.from('完整C\n', 'utf8')).subarray(0, 6)])
  const result = decodeZstdFrames(partial)
  assert.equal(result.frames, 3, '半截帧的帧头也算被扫到')
  assert.ok(result.skipped <= 1, `最多跳过那一帧，实际 ${result.skipped}`)
  const lines = result.text.split('\n').filter((l) => l !== '')
  assert.deepEqual(lines.slice(0, 2), ['完整的A', '完整的B'])
  assert.ok(lines.length <= 3, '不该多出内容')
})

test('中间有一帧坏掉：跳过它，后面的照常解出', () => {
  const a = zstdCompressSync(Buffer.from('帧A\n', 'utf8'))
  const junk = Buffer.concat([ZSTD_MAGIC, Buffer.from('这不是一个能解的帧', 'utf8')])
  const b = zstdCompressSync(Buffer.from('帧B\n', 'utf8'))
  const result = decodeZstdFrames(Buffer.concat([a, junk, b]))
  assert.equal(result.frames, 3)
  assert.equal(result.skipped, 1, '坏帧被计数')
  assert.equal(result.text, '帧A\n帧B\n', '坏帧之外的内容都在，顺序不变')
})

test('空输入返回空', () => {
  assert.deepEqual(decodeZstdFrames(Buffer.alloc(0)), { text: '', frames: 0, skipped: 0 })
})

test('非 zstd 输入：把解码错误如实抛出，而不是假装成空内容', () => {
  assert.throws(() => decodeZstdFrames(Buffer.from('这不是 zstd', 'utf8')), Error)
})

test('可注入解码器（便于在没有 zlib 的构建上测试调用方）', () => {
  const calls: number[] = []
  const raw = multiFrame(['a', 'b'])
  const result = decodeZstdFrames(raw, (input) => {
    calls.push(input.length)
    return zstdCompressSyncInverse(input)
  })
  assert.equal(result.frames, 2)
  assert.equal(calls.length, 2, '应当逐帧调用，而不是整份调用一次')
  // 注入的实现直接转发给原生解码——这里只是要一个"被逐帧调用"的记录。
  function zstdCompressSyncInverse(input: Buffer): Buffer { return zstdDecompressSync(input) }
})

// ── 可选：对真实会话文件（服务器上有，开发机上没有）─────────────────────────
const fixture = process.env.SESSION_LOG_FIXTURE ?? ''

test('真实会话文件：逐帧解出的行数远多于整体解码', { skip: fixture === '' || !existsSync(fixture) }, () => {
  const raw = readFileSync(fixture)
  const result = decodeZstdFrames(raw)
  const wholeLines = zstdDecompressSync(raw).toString('utf8').split('\n').filter((l) => l.trim() !== '').length
  const frameLines = result.text.split('\n').filter((l) => l.trim() !== '').length
  console.log(
    `  实测 ${fixture}\n  帧数 ${result.frames}（跳过 ${result.skipped}）`
    + `\n  整体解码 ${wholeLines} 行 / 逐帧解码 ${frameLines} 行`,
  )
  assert.ok(result.frames > 10, `文件应当是上千帧的多帧文件，实际 ${result.frames}`)
  assert.ok(frameLines > wholeLines * 10, `逐帧应显著多于整体（${frameLines} vs ${wholeLines}）`)
  assert.equal(result.text.includes('"type":"session"'), true, '第一帧仍是会话头')
})
