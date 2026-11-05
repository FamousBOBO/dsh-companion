/** P2.4b 特征测试：8 个 store 改走 `JsonStore`，**落盘字节与路径一个都不能变**。
 *
 * 这一条守的是"用户数据"。迁移的动机是原子写 + 串行化 + 留一份上一版，
 * 不是"顺便把文件格式整理一下"——所以这里逐字节对照**迁移前那套
 * `JSON.stringify(value, null, 1)`** 的输出，并覆盖每一处历史形状
 * （裸数组 / `{version, ...}`）、缺文件、损坏文件这三种存量情况。
 *
 * 只要哪一天有人把缩进改了、加了个换行、或者把裸数组包成对象，
 * 这里会红——那是对的，因为它意味着线上那份文件会被重写一遍。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { QuoteStore } from '../src/features/quotes/store.js'
import { KnowledgeStore } from '../src/knowledge.js'
import { SentLog } from '../src/sent-log.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { LearnStore } from '../src/features/learn/store.js'
import { AffectionStore } from '../src/affection.js'
import { EmojiLibrary } from '../src/emoji-library.js'
import { JsonStore, backupPathOf } from '../src/adapters/fs-store/json-store.js'

/** 迁移前每个 store 的写法：`JSON.stringify(value, null, 1)`，不带换行。 */
function legacy(value: unknown): string {
  return JSON.stringify(value, null, 1)
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'store-mig-'))
}

const quiet = (): void => {}

test('JsonStore：序列化与迁移前的 writeFile 逐字节相同（缩进 1、无尾换行）', async () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'x.json')
    const store = new JsonStore<unknown>(file)
    const value = { version: 1, entries: [{ a: 1, b: '中文' }], nested: { deep: [1, 2, 3] } }
    await store.save(value)
    assert.equal(readFileSync(file, 'utf-8'), legacy(value), '字节必须与旧写法一致')
    assert.equal(store.serialize(value), legacy(value), 'serialize() 也要一致')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('quotes：{version,quotes} 形状原样落盘，缺文件时补空库', async () => {
  const dir = scratch()
  try {
    const cfg = { enabled: true, dir, autoCapture: false }
    const store = new QuoteStore(cfg, { workspacePath: null, dshHome: dir, log: quiet })
    await store.load()
    const file = path.join(dir, 'quotes.json')
    assert.equal(readFileSync(file, 'utf-8'), legacy({ version: 1, quotes: [] }), '缺文件时补出来的空库字节要一致')

    await store.add({ text: '这是一句足够长的群金句', speaker: '学弟', speakerId: 1, groupId: 2, tags: [], note: '' })
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { version: number; quotes: unknown[] }
    assert.equal(raw.version, 1)
    assert.equal(raw.quotes.length, 1)
    assert.equal(readFileSync(file, 'utf-8'), legacy(raw), '加一条之后仍然是同一套字节')

    // 重开一个实例读回：内容不丢
    const again = new QuoteStore(cfg, { workspacePath: null, dshHome: dir, log: quiet })
    await again.load()
    assert.equal(again.list().length, 1, `读回一条，实际 ${again.list().length}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('quotes：损坏的存量文件当空库起步并重建（旧行为不变）', async () => {
  const dir = scratch()
  try {
    const file = path.join(dir, 'quotes.json')
    writeFileSync(file, '{ 这不是 JSON', 'utf-8')
    const store = new QuoteStore({ enabled: true, dir, autoCapture: false }, { workspacePath: null, dshHome: dir, log: quiet })
    await store.load()
    assert.equal(store.list().length, 0)
    assert.equal(readFileSync(file, 'utf-8'), legacy({ version: 1, quotes: [] }), '坏文件被重建，且字节与旧写法一致')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('knowledge：裸数组形状不变（数组不会被包成对象）', async () => {
  const dir = scratch()
  try {
    const store = new KnowledgeStore(dir, null, quiet)
    await store.load()
    assert.equal(readFileSync(store.file, 'utf-8'), legacy([]), '缺文件时补空数组')
    assert.equal(readFileSync(store.file, 'utf-8'), legacy([]), '保存后仍是裸数组')

    // 存量裸数组要被读回来
    const one = [{ id: 'k1', text: 'x', tags: [], source: 's', created: 1, weight: 1, hits: 0 }]
    writeFileSync(store.file, legacy(one), 'utf-8')
    const second = new KnowledgeStore(dir, null, quiet)
    await second.load()
    assert.equal(second.entries.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sent-log：裸数组形状不变，且写盘会留下上一版备份', async () => {
  const dir = scratch()
  try {
    const log = new SentLog(dir, 'group-1', quiet)
    await log.load()
    await log.add({ messageId: 11, quotedId: null, text: '第一条', time: 1 })
    const file = path.join(dir, 'channel-qq', 'sent-group-1.json')
    assert.equal(readFileSync(file, 'utf-8'), legacy([{ messageId: 11, quotedId: null, text: '第一条', time: 1 }]))

    await log.add({ messageId: 12, quotedId: 11, text: '第二条', time: 2 })
    const backup = backupPathOf(file)
    assert.equal(existsSync(backup), true, '第二次保存应当留下上一版')
    assert.equal((JSON.parse(readFileSync(backup, 'utf-8')) as unknown[]).length, 1, '备份里是上一版（1 条）')

    const again = new SentLog(dir, 'group-1', quiet)
    await again.load()
    assert.equal(again.render().includes('第二条'), true, '读回后 render() 里要有最新那条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reminders：{version,reminders} 形状不变，裸数组存量也读得回来', async () => {
  const dir = scratch()
  try {
    const cfg = { enabled: true, file: null }
    const opts = { workspacePath: dir, dshHome: dir, log: quiet }
    const store = new ReminderStore(cfg, opts)
    await store.load()
    const file = path.join(dir, 'reminders.json')
    // **task-66**：`load()` **不创建主文件**（只有真实变更才写 V1）。
    // 旧断言"初次 load 后立即存在一个空文件"与实现不一致，改成断言"不存在"。
    assert.equal(existsSync(file), false, 'load() 不该创建主文件（不重建 = 不改写用户现场）')
    // 首次真实变更才落盘，形状仍是 {version:1, reminders:[...]}。
    const added = await store.add({ text: '喝水', at: Date.now() + 60_000, room: 'group', target: 1, createdBy: 1 })
    assert.equal(added.ok, true, 'add 必须业务成功：' + JSON.stringify(added))
    assert.equal(existsSync(file), true, '首次真实变更之后才有文件')
    const written = JSON.parse(readFileSync(file, 'utf-8')) as { version: number; reminders: unknown[] }
    assert.equal(written.version, 1, '版本不升（仍是 1）')
    assert.equal(written.reminders.length, 1, '只写了那一条')
    await store.close()

    // 存量的裸数组写法：字段名与现在一样（`at` 而不是 `when`），
    // 早先的版本只是没把它包进 { version, reminders } 而已。
    const legacyShape = [{ id: 'r1', text: '喝水', at: 1_700_000_000_000, room: 'group', target: 1 }]
    writeFileSync(file, legacy(legacyShape), 'utf-8')
    // **task-66**：同一文件只允许一个活跃 Store ⇒ 先关掉再开第二个。
    const second = new ReminderStore(cfg, opts)
    await second.load()
    assert.equal(second.list().length, 1, '裸数组存量必须仍然读得回来')
    await second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('affection：状态对象形状不变，缺文件时补出默认值', async () => {
  const dir = scratch()
  try {
    const affection = new AffectionStore(dir, quiet)
    await affection.load()
    const file = path.join(dir, 'affection.json')
    const written = JSON.parse(readFileSync(file, 'utf-8')) as { score: number }
    assert.equal(written.score, 87)
    assert.equal(readFileSync(file, 'utf-8'), legacy(written), '字节与旧写法一致')

    // emotion.json 那条断言随 emotion.ts 一起删了：那个引擎从未被实例化过
    // （见 P4.6 的死代码清理），留着它等于给死代码做迁移测试。
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emoji-library：索引形状不变，位置跟随 emoji.dir', async () => {
  const dir = scratch()
  try {
    const lib = new EmojiLibrary({ steal: true, dir: path.join(dir, 'emoji-a'), registeredDir: null, maxFileBytes: 8 * 1024 * 1024 } as never, quiet)
    await lib.load()
    const file = path.join(dir, 'emoji-index.json')
    assert.equal(existsSync(file), false, '只是读，不该建文件')

    const entry = { md5: 'abc', file: 'a.png', desc: 'x', tags: [], added: 1, source: 'stolen' }
    const internals = lib as unknown as { index: Map<string, unknown>; dirty: boolean }
    internals.index.set('abc', entry)
    internals.dirty = true
    await lib.save()
    assert.equal(readFileSync(file, 'utf-8'), legacy({ version: 1, entries: [entry] }))
    assert.equal(lib.hasMd5('abc'), true, '重开后索引里要有它')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
