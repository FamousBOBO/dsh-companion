/** 分离上下文（`features/song/separation.ts`）：默认兼容、非法值被拒、键标识与命令行。 */

import assert from 'node:assert/strict'
import test from 'node:test'

const {
  DEFAULT_SEPARATION, UNSET_SAMPLE_VALUE, SeparationConfigError,
  separationFromConfig, separationOr, separationKeyMark, separationFlags, describeSeparation,
} = await import('../src/features/song/separation.js')

const ALL_DEFAULT = {
  separatorChunk: UNSET_SAMPLE_VALUE,
  separatorOverlap: UNSET_SAMPLE_VALUE,
  separatorDtype: 'auto',
  separatorDevice: 'auto',
}

test('全默认（-1/auto）→ 设置里没有任何具体值：命令行与旧版一字不差', () => {
  const settings = separationFromConfig(ALL_DEFAULT)
  assert.deepEqual(settings, DEFAULT_SEPARATION)
  assert.deepEqual(separationFlags(settings), [], '默认时不能给 make_cover.py 多传一个参数')
  assert.equal(separationKeyMark(settings), 'sep-default', '默认的键段必须是常量')
  assert.equal(describeSeparation(settings), '分块 默认、重叠 默认、精度 auto、设备 auto')
})

test('字段缺省与 -1 等价：老测试/老配置不写这四项也能算', () => {
  assert.deepEqual(separationFromConfig({}), DEFAULT_SEPARATION)
  assert.deepEqual(separationOr({ separatorChunk: 123 }), {
    chunkSize: 123, overlapSize: null, dtype: 'auto', device: 'auto',
  })
})

test('显式值 → 命令行按顺序出现，键里逐项写出', () => {
  const settings = separationFromConfig({
    separatorChunk: 44100, separatorOverlap: 11025, separatorDtype: 'float32', separatorDevice: 'cpu',
  })
  assert.deepEqual(settings, {
    chunkSize: 44100, overlapSize: 11025, dtype: 'float32', device: 'cpu',
  })
  assert.deepEqual(separationFlags(settings), [
    '--separator-chunk', '44100', '--separator-overlap', '11025',
    '--separator-dtype', 'float32', '--separator-device', 'cpu',
  ])
  assert.equal(separationKeyMark(settings), 'sep-c44100-o11025-float32-cpu')
})

test('只给了重叠：分块留"默认"，键里两者可区分', () => {
  const settings = separationFromConfig({ separatorOverlap: 0 })
  assert.deepEqual(settings, { chunkSize: null, overlapSize: 0, dtype: 'auto', device: 'auto' })
  assert.equal(separationKeyMark(settings), 'sep-d-o0-d-d')
  assert.deepEqual(separationFlags(settings), ['--separator-overlap', '0'])
})

test('非法值一律抛（不静默退回默认）', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ separatorChunk: 0 }, /separatorChunk 不合法/],
    [{ separatorChunk: -5 }, /separatorChunk 不合法/],
    [{ separatorOverlap: -5 }, /separatorOverlap 不合法/],
    [{ separatorChunk: 22050, separatorOverlap: 22050 }, /必须 < separatorChunk/],
    [{ separatorChunk: 22050, separatorOverlap: 30000 }, /必须 < separatorChunk/],
    [{ separatorDtype: 'bfloat16' }, /separatorDtype 不合法/],
    [{ separatorDevice: 'cuda' }, /separatorDevice 不合法/],
  ]
  for (const [fields, pattern] of cases) {
    assert.throws(() => separationFromConfig(fields), (error: unknown) => {
      assert.ok(error instanceof SeparationConfigError, '必须是 SeparationConfigError')
      assert.match(error.message, pattern)
      return true
    }, `应当拒掉 ${JSON.stringify(fields)}`)
  }
})

test('精度别名归一（fp16/half → float16，fp32 → float32）', () => {
  assert.equal(separationFromConfig({ separatorDtype: 'FP16' }).dtype, 'float16')
  assert.equal(separationFromConfig({ separatorDtype: 'half' }).dtype, 'float16')
  assert.equal(separationFromConfig({ separatorDtype: 'fp32' }).dtype, 'float32')
  assert.equal(separationFromConfig({ separatorDtype: '' }).dtype, 'auto')
})

test('配置坏时 separationOr 退回默认（不让一条坏配置把点歌打死）', () => {
  assert.deepEqual(separationOr({ separatorChunk: 0 }), DEFAULT_SEPARATION)
  assert.deepEqual(separationOr({ separatorDtype: 'bogus' }), DEFAULT_SEPARATION)
})

test('两种不同参数不会是同一个键（缓存隔离的最小前提）', () => {
  const a = separationFromConfig({ separatorChunk: 22050, separatorOverlap: 5512 })
  const b = separationFromConfig({ separatorChunk: 44100, separatorOverlap: 11025 })
  assert.notEqual(separationKeyMark(a), separationKeyMark(b))
  const c = separationFromConfig({ separatorChunk: 44100, separatorOverlap: 11025, separatorDtype: 'float32' })
  assert.notEqual(separationKeyMark(b), separationKeyMark(c), '精度不同也是另一段音频')
})

test('成品缓存键把分离上下文写进去：默认键不被新参数命中，反之亦然', async () => {
  const { clipCacheKey, COVER_ALGO_TAG } = await import('../src/features/song/cache-key.js')
  const base = clipCacheKey('BV1nY4w6kEQS', 1, 0, 90.5, 56)
  const tuned = clipCacheKey('BV1nY4w6kEQS', 1, 0, 90.5, 56, 'sep-c44100-o11025-d-d')
  assert.equal(base, clipCacheKey('BV1nY4w6kEQS', 1, 0, 90.5, 56), '同参同键')
  assert.notEqual(base, tuned, '分组参数不同必须另算：旧缓存不能被当成新参数的产物')
  assert.ok(base.includes('sep-default'), '默认段是常量：没配新字段的部署键形状稳定')
  assert.ok(tuned.endsWith(COVER_ALGO_TAG), '算法版本标签仍在键尾')
  const other = clipCacheKey('BV1nY4w6kEQS', 1, 0, 90.5, 56, 'sep-c44100-o22050-d-d')
  assert.notEqual(tuned, other, '重叠不同也是另一段音频')
})