/** 同歌缓存适配器：**落盘、时长核对、淘汰、孤儿清理**（临时目录 + 假 `ffprobe`）。
 *
 * 为什么这一层要单独测：缓存是唯一"可能是半截文件"的输入。它被手工删过一半、
 * 被安全软件截断、被磁盘写坏时，**发出去的就是半条语音条**——比慢 90 秒糟得多。
 * 所以 `getClip` 的每一条失败路径都必须钉住：返回 `null` **并且**把坏条目删掉
 * （不删就每次命中都白量一次，坏条目会一直占着位置）。
 *
 * 假 `ffprobe` 而不是真的：这些用例要验的是"时长不对怎么办"，真 `ffprobe` 只能
 * 给出真实时长，没法精确构造 3 s 的偏差；而真实音轨不该成为单测的必要条件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ProcessPort, ProcessResult } from '../src/features/song/types.js'

const { createSongCachePort } = await import('../src/adapters/song/cache.js')
const { planCacheKey, clipCacheKey } = await import('../src/features/song/cache-key.js')

const BVID = 'BV1d4411N7zD'
const CID = 317843818

/** 假 `ffprobe`：任何文件都回答同一个时长（用例要的是"期望值与实测值不一致"）。 */
function fakeProbe(seconds: number): ProcessPort & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async run(_command: string, args: readonly string[]): Promise<ProcessResult> {
      calls.push(args[args.length - 1] ?? '')
      return {
        code: 0,
        stdout: JSON.stringify({ format: { duration: String(seconds) } }),
        stderr: '',
        timedOut: false,
        durationMs: 1,
      }
    },
  }
}

/** 一套临时目录里的缓存（每个用例自己一份，跑完删）。 */
function makeCache(options: { readonly maxEntries?: number; readonly duration?: number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'song-cache-adapter-'))
  const log: string[] = []
  let clock = 1_700_000_000_000
  const proc = fakeProbe(options.duration ?? 59)
  const port = createSongCachePort({
    root,
    process: proc,
    ffmpegPath: 'ffmpeg',
    log: (line) => log.push(line),
    maxEntries: () => options.maxEntries ?? 50,
    now: () => clock,
    probeTimeoutMs: 5_000,
  })
  return {
    root, port, log, proc,
    advance: (ms: number) => { clock += ms },
    write: (rel: string, text: string): string => {
      const file = path.join(root, rel)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, text)
      return file
    },
    plans: () => readdirSync(path.join(root, 'plans')).sort(),
    clips: () => readdirSync(path.join(root, 'clips')).sort(),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/** 造一个"任务目录里的成品"（内容不必是真 mp3：时长由假 ffprobe 回答）。 */
function makeSource(dir: string, bytes = 1024): string {
  const file = path.join(dir, 'voice.mp3')
  writeFileSync(file, Buffer.alloc(bytes, 7))
  return file
}

// ── 1. 方案层：写→读、坏记录当没有 ─────────────────────────────────────────

test('方案：写进去再读出来是同一段（起点/长度/置信度）', async () => {
  const cache = makeCache()
  try {
    const key = planCacheKey(BVID, CID, 12, 59)
    await cache.port.putPlan(key, { chorusStart: 162, seconds: 55, confidence: 0.81 })
    assert.deepEqual(await cache.port.getPlan(key), { chorusStart: 162, seconds: 55, confidence: 0.81 })
    assert.deepEqual(cache.plans(), [`${key}.json`])
  } finally { await cache.cleanup() }
})

test('方案：没这条 → null；半截 JSON → null 并删掉（坏记录不该每次都被读一遍）', async () => {
  const cache = makeCache()
  try {
    const key = planCacheKey(BVID, CID, 0, 59)
    assert.equal(await cache.port.getPlan(key), null)
    const file = cache.write(`plans/${key}.json`, '{"chorusStart": 84, "sec')
    assert.equal(await cache.port.getPlan(key), null)
    assert.equal(existsSync(file), false, '坏掉的方案记录要被删掉')
  } finally { await cache.cleanup() }
})

// ── 2. 成品层：命中、时长核对 ──────────────────────────────────────────────

test('成品：写进去再读出来（时长与期望一致才算命中）', async () => {
  const cache = makeCache({ duration: 59 })
  const src = mkdtempSync(path.join(tmpdir(), 'song-src-'))
  try {
    const key = clipCacheKey(BVID, CID, 0, 84, 59)
    await cache.port.putClip(key, makeSource(src))
    const hit = await cache.port.getClip(key, 59)
    assert.ok(hit !== null, '时长对得上就应当命中')
    assert.equal(hit.durationSeconds, 59)
    assert.equal(path.basename(hit.file), `${key}.mp3`)
    assert.ok(existsSync(hit.file))
    assert.ok(cache.proc.calls.length >= 1, '命中前必须真的量一次时长（不能只信记账）')
  } finally {
    await cache.cleanup()
    await fs.rm(src, { recursive: true, force: true })
  }
})

test('成品：缓存文件时长差 3 s → 当作未命中，并把那条删掉', async () => {
  // 记账写着 59 s，磁盘上那条实际 56 s（被截断/写坏）：这正是"半条语音条"的来源。
  const cache = makeCache({ duration: 56 })
  const src = mkdtempSync(path.join(tmpdir(), 'song-src-'))
  try {
    const key = clipCacheKey(BVID, CID, 0, 84, 59)
    await cache.port.putClip(key, makeSource(src))
    const body = path.join(cache.root, 'clips', `${key}.mp3`)
    assert.ok(existsSync(body))
    assert.equal(await cache.port.getClip(key, 59), null, '56 s 与 59 s 差 3 s（超过 0.75 s）')
    assert.equal(existsSync(body), false, '坏条目要被删掉')
    assert.equal(existsSync(path.join(cache.root, 'clips', `${key}.json`)), false, '记账也要一起删')
    assert.ok(cache.log.some((line) => line.includes('相差超过')),
      `要在日志里说清为什么删：\n${cache.log.join('\n')}`)
  } finally {
    await cache.cleanup()
    await fs.rm(src, { recursive: true, force: true })
  }
})

test('成品：有文件没记账 / 有记账没文件 → 都当未命中并清掉剩下的一半', async () => {
  const cache = makeCache()
  const src = mkdtempSync(path.join(tmpdir(), 'song-src-'))
  try {
    const key = clipCacheKey(BVID, CID, 0, 84, 59)
    await cache.port.putClip(key, makeSource(src))
    const body = path.join(cache.root, 'clips', `${key}.mp3`)
    await fs.rm(path.join(cache.root, 'clips', `${key}.json`))
    assert.equal(await cache.port.getClip(key, 59), null, '没有记账就没有"这条是几秒"的结论')
    assert.equal(existsSync(body), false, '没有记账的音频要被清掉')

    const other = clipCacheKey(BVID, CID, 0, 90, 59)
    await cache.port.putClip(other, makeSource(src))
    await fs.rm(path.join(cache.root, 'clips', `${other}.mp3`))
    assert.equal(await cache.port.getClip(other, 59), null)
    assert.equal(existsSync(path.join(cache.root, 'clips', `${other}.json`)), false, '孤儿记账要被清掉')
  } finally {
    await cache.cleanup()
    await fs.rm(src, { recursive: true, force: true })
  }
})

test('成品：期望秒数不合法 → 直接当未命中（没有可比的东西）', async () => {
  const cache = makeCache()
  const src = mkdtempSync(path.join(tmpdir(), 'song-src-'))
  try {
    const key = clipCacheKey(BVID, CID, 0, 84, 59)
    await cache.port.putClip(key, makeSource(src))
    assert.equal(await cache.port.getClip(key, Number.NaN), null)
  } finally {
    await cache.cleanup()
    await fs.rm(src, { recursive: true, force: true })
  }
})

// ── 3. 淘汰与孤儿 ──────────────────────────────────────────────────────────

test('淘汰：上限 2 条、放 3 条 → 最久没用（lastUsedAt 最旧）的那条被删', async () => {
  const cache = makeCache({ maxEntries: 2 })
  const src = mkdtempSync(path.join(tmpdir(), 'song-src-'))
  const keys = [0, 4, 8].map((keyUp) => clipCacheKey(BVID, CID, keyUp, 84, 59))
  const [first, second, third] = [keys[0]!, keys[1]!, keys[2]!]
  try {
    await cache.port.putClip(first, makeSource(src))
    cache.advance(1_000)
    await cache.port.putClip(second, makeSource(src))
    cache.advance(1_000)
    // 中间那条被"用过"一次：lastUsedAt 刷新，于是最旧的变成第一条。
    assert.ok((await cache.port.getClip(second, 59)) !== null)
    cache.advance(1_000)
    await cache.port.putClip(third, makeSource(src))
    assert.equal(existsSync(path.join(cache.root, 'clips', `${first}.mp3`)), false, '最久没用的第一条应当被淘汰')
    assert.ok(existsSync(path.join(cache.root, 'clips', `${second}.mp3`)), '刚刚用过的那条要留着')
    assert.ok(existsSync(path.join(cache.root, 'clips', `${third}.mp3`)))
    assert.equal(cache.clips().filter((name) => name.endsWith('.mp3')).length, 2)
  } finally {
    await cache.cleanup()
    await fs.rm(src, { recursive: true, force: true })
  }
})

test('淘汰：孤儿文件（有文件没记账 / 有记账没文件）在 prune 时被清掉，只记一行日志', async () => {
  const cache = makeCache()
  try {
    cache.write('clips/ghost-body.mp3', 'not a real mp3')
    cache.write('clips/ghost-meta.json', '{"bytes": 10, "lastUsedAt": 1}')
    await cache.port.prune()
    assert.deepEqual(cache.clips(), [])
    const lines = cache.log.filter((line) => line.includes('孤儿'))
    assert.equal(lines.length, 1, `清理只该记一行日志，实际：\n${cache.log.join('\n')}`)
    assert.ok(lines[0]?.includes('淘汰 0 条'), `要分开说淘汰与孤儿：${String(lines[0])}`)
  } finally { await cache.cleanup() }
})

test('淘汰：prune 绝不抛（目录不存在、记录是乱码都只记日志）', async () => {
  const cache = makeCache()
  try {
    await fs.rm(path.join(cache.root, 'plans'), { recursive: true, force: true })
    await cache.port.prune()
    assert.equal(cache.log.length, 0, '没东西可清时不必说话')
    // 乱码记录要被当成孤儿清掉，而不是让 prune 抛出去。
    cache.write('plans/broken.json', '\u0000\u0000')
    await cache.port.prune()
    assert.deepEqual(cache.plans(), [])
  } finally { await cache.cleanup() }
})
