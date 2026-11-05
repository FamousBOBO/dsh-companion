/** 原话簿（PR #3）：写入/解析、昵称转义、保留期清理、工具开关与摘要。
 *
 * 重点回归：默认目录不能在 memory/ 下（否则被 memory.chunks 切进记忆库）；
 * 并发首写只出现一个日期抬头；昵称里的括号/冒号不破坏解析。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { appendChatLog, chatLogFile, formatEntry, isPlaceholder, pruneOld, readDay } = await import('../src/features/chatlog/store.js')
const { registerChatLogTools } = await import('../src/features/chatlog/tools.js')
const { resolveConfig } = await import('../src/config.js')
const { toolRecorder } = await import('./fakes/host.js')

const entry = (over: Record<string, unknown> = {}) => ({
  room: 107, isGroup: true, qq: 555, nick: '小明', hhmm: '12:30', day: '2026-10-22', text: '下午开会', ...over,
})

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'chatlog-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('原话簿：格式/解析往返，昵称里的括号与冒号被换掉', async () => {
  const t = temp()
  try {
    const line = formatEntry(entry({ nick: '小(明)：测试' }), 800)
    assert.equal(line.includes('小(明)：测试('), false)
    await appendChatLog({ dir: t.dir, maxChars: 800, keepDays: 14 }, entry({ nick: '小(明)：测试' }))
    const rows = await readDay(t.dir, '107', '2026-10-22')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.text, '下午开会')
    assert.equal(rows[0]!.qq, '555')
  } finally { t.cleanup() }
})

test('原话簿：并发首写只出现一个日期抬头', async () => {
  const t = temp()
  try {
    await Promise.all([
      appendChatLog({ dir: t.dir, maxChars: 0, keepDays: 0 }, entry({ text: 'a' })),
      appendChatLog({ dir: t.dir, maxChars: 0, keepDays: 0 }, entry({ text: 'b' })),
    ])
    const text = readFileSync(chatLogFile(t.dir, 107, true, '2026-10-22'), 'utf8')
    assert.equal((text.match(/^# /gm) ?? []).length, 1)
  } finally { t.cleanup() }
})

test('原话簿：保留期清理只删过期日文件', async () => {
  const t = temp()
  try {
    for (const day of ['2026-10-01', '2026-10-20', '2026-10-22']) {
      await appendChatLog({ dir: t.dir, maxChars: 0, keepDays: 0 }, entry({ day, text: day }))
    }
    const removed = await pruneOld(t.dir, 2, '2026-10-22')
    assert.equal(removed, 1)
    assert.equal(existsSync(chatLogFile(t.dir, 107, true, '2026-10-01')), false)
    assert.equal(existsSync(chatLogFile(t.dir, 107, true, '2026-10-20')), true)
  } finally { t.cleanup() }
})

test('原话簿：占位行不记；工具开关关着不注册，打开后能按群摘要', async () => {
  assert.equal(isPlaceholder('[图片]'), true)
  assert.equal(isPlaceholder('真的吗'), false)
  const t = temp()
  try {
    await appendChatLog({ dir: t.dir, maxChars: 0, keepDays: 0 }, entry({ text: '今天开会' }))
    const off = toolRecorder()
    registerChatLogTools(off.ctx, resolveConfig({
      selfId: 1, admins: [280], primaryGroup: 107, workspacePath: t.dir,
      chatlog: { enabled: false, dir: t.dir, maxChars: 0, keepDays: 0 },
    }), () => {})
    assert.equal(off.definitions.length, 0)

    const on = toolRecorder()
    registerChatLogTools(on.ctx, resolveConfig({
      selfId: 1, admins: [280], primaryGroup: 107, workspacePath: t.dir,
      chatlog: { enabled: true, dir: t.dir, maxChars: 0, keepDays: 0 },
    }), () => {})
    const def = on.definitions.find((d) => d.name === 'qq_group_digest')!
    const result = await (def.execute as (a: unknown) => Promise<unknown>)({ day: '2026-10-22' }) as {
      groups: Array<{ room: string; count: number }>
    }
    assert.equal(result.groups[0]!.room, 'group-107')
    assert.equal(result.groups[0]!.count, 1)
  } finally { t.cleanup() }
})

test('原话簿：默认目录不在 memory/ 下（避免被记忆分块吞掉）', () => {
  const config = resolveConfig({ selfId: 1, admins: [280], primaryGroup: 107, workspacePath: '/ws' })
  const dir = config.chatlog.dir ?? '/ws/chatlog'
  assert.equal(dir.includes('/memory/'), false)
})
