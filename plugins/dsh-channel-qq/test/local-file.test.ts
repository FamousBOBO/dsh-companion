/** 交给 NapCat 的文件参数：小文件内联、大文件走配置的可读根。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { napcatFileArg } = await import('../src/local-file.js')

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'napcat-file-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function withRoots<T>(roots: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CHANNEL_QQ_NAPCAT_ROOTS
  process.env.CHANNEL_QQ_NAPCAT_ROOTS = roots
  return fn().finally(() => {
    if (previous === undefined) delete process.env.CHANNEL_QQ_NAPCAT_ROOTS
    else process.env.CHANNEL_QQ_NAPCAT_ROOTS = previous
  })
}

test('小文件：即使在可读根里也内联（容器权限可能实际读不到）', async () => {
  const s = scratch()
  try {
    const file = path.join(s.dir, 'sticker.png')
    writeFileSync(file, Buffer.alloc(16 * 1024, 1))
    const arg = await withRoots(s.dir, () => napcatFileArg(file))
    assert.match(arg, /^base64:\/\//)
  } finally { s.cleanup() }
})

test('大文件：在可读根里走 file://，否则内联', async () => {
  const s = scratch()
  try {
    const file = path.join(s.dir, 'voice.mp3')
    writeFileSync(file, Buffer.alloc(300 * 1024, 2))
    const inside = await withRoots(s.dir, () => napcatFileArg(file))
    assert.match(inside, /^file:\/\//)
    const outside = await withRoots(path.join(s.dir, 'other'), () => napcatFileArg(file))
    assert.match(outside, /^base64:\/\//)
  } finally { s.cleanup() }
})

test('大文件：既读不到又超过内联上限 → 明确报错', async () => {
  const s = scratch()
  try {
    const file = path.join(s.dir, 'big.mp3')
    writeFileSync(file, Buffer.alloc(9 * 1024 * 1024, 3))
    await withRoots('', async () => {
      await assert.rejects(() => napcatFileArg(file), /超过内联上限/)
    })
  } finally { s.cleanup() }
})
