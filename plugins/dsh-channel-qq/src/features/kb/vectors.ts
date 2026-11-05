/** 知识库向量：沿用记忆的 `vec.bin` 格式，落在 `kb/` 目录下（不同目录 = 天然命名空间）。
 *
 * 与记忆向量共享的是**格式与容错**（分片、代际、坏分片跳过），共享代码是
 * `features/memory/vector-store.ts` 里那几个纯函数；嵌入服务与参数也复用
 * `memory.vector*` 配置——同一个 bge 模型，没必要为知识库再配一套。
 *
 * 重建是增量的：清单里已有的块不重新嵌入；本轮删掉的文档，它们的向量在重写
 * 文件时自然掉出（清单 `entries` 只收当前活跃块）。
 */

import * as path from 'node:path'
import { atomicWriteFile, atomicWriteJson } from '../../adapters/fs-store/atomic.js'
import { cosineSimilarity } from '../../core/memory/score.js'
import type { KbChunk } from '../../core/kb/model.js'
import type { EmbedPort } from '../../ports/memory.js'
import {
  VEC_FILE_NAME, VEC_MANIFEST_NAME, VectorIndex, encodeVectorFile, loadVectorSnapshot, manifestFor,
  type VectorSnapshot,
} from '../memory/vector-store.js'

/** 一批嵌多少条（失败只丢这一批）。 */
const BATCH = 16

export interface KbVectorsOptions {
  /** `kb/` 目录。 */
  readonly dir: string
  readonly dim: number
  readonly log: (line: string) => void
}

/** 读出来的向量集：查询嵌入 + 暴力余弦。 */
export class KbVectors {
  private index: VectorIndex | null = null
  private generation = 0
  private readonly file: string
  private readonly manifestFile: string

  constructor(private readonly opts: KbVectorsOptions) {
    this.file = path.join(opts.dir, VEC_FILE_NAME)
    this.manifestFile = path.join(opts.dir, VEC_MANIFEST_NAME)
  }

  /** 装载已有索引；没有/坏了就是 0 条（调用方退回关键词）。 */
  async load(): Promise<number> {
    const snapshot = await loadVectorSnapshot({
      file: this.file,
      manifestFile: this.manifestFile,
      dim: this.opts.dim,
      log: this.opts.log,
    })
    this.generation = snapshot.generation
    this.index = new VectorIndex(snapshot)
    return this.index.size()
  }

  size(): number {
    return this.index?.size() ?? 0
  }

  vectorOf(id: string): Float32Array | null {
    return this.index?.get(id) ?? null
  }

  all(): ReadonlyArray<readonly [string, Float32Array]> {
    return this.index?.all() ?? []
  }

  /** 余弦检索（只对 ids 里出现过的块算；ids 为空 = 全库）。 */
  nearest(query: Float32Array, ids: ReadonlySet<string> | null, limit: number): Array<{ id: string; score: number }> {
    const out: Array<{ id: string; score: number }> = []
    for (const [id, vector] of this.all()) {
      if (ids !== null && !ids.has(id)) continue
      const score = cosineSimilarity(query, vector)
      if (score > 0) out.push({ id, score })
    }
    out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    return out.slice(0, limit)
  }

  /** 把查询嵌成向量；服务不可用返回 null。 */
  async embedQuery(embed: EmbedPort, text: string): Promise<Float32Array | null> {
    if (!embed.available()) return null
    try {
      const vectors = await embed.embed([text])
      return vectors?.[0] ?? null
    } catch (error) {
      this.opts.log(`kb.vector: 查询嵌入失败：${(error as Error).message}`)
      return null
    }
  }

  /**
   * 增量重建：只嵌清单里没有的块；重写时只保留当前活跃块。
   *
   * 先写 `vec.bin` 再换清单（与记忆同一条容错约定：两次改名之间挂掉 → 代际对不上
   * → 整份拒绝 → 退回关键词，绝不会拿旧清单按老坐标读新文件）。
   */
  async rebuild(chunks: readonly KbChunk[], embed: EmbedPort): Promise<{ embedded: number; failed: number; total: number }> {
    const dim = this.opts.dim
    const snapshot = await loadVectorSnapshot({
      file: this.file, manifestFile: this.manifestFile, dim, log: this.opts.log,
    })
    const existing = snapshotVectors(snapshot)
    const wanted = new Set(chunks.map((chunk) => chunk.id))
    const missing = chunks.filter((chunk) => !existing.has(chunk.id))
    const embedded = await embedBatches(missing, embed, dim)
    for (const [id, vector] of embedded.ok) existing.set(id, vector)
    const alive = [...existing.entries()].filter(([id]) => wanted.has(id))
    if (missing.length === 0 && alive.length === existing.size && snapshot.entries.size === alive.length) {
      this.index = new VectorIndex(snapshot)
      return { embedded: 0, failed: embedded.failed.length, total: alive.length }
    }
    const packed = packVectors(alive, snapshot.shardCapacity)
    const generation = snapshot.generation + 1
    await atomicWriteFile(this.file, encodeVectorFile(dim, packed.shards, { capacity: packed.capacity, generation }))
    await atomicWriteJson(this.manifestFile, manifestFor(dim, generation, packed.entries))
    this.generation = generation
    this.index = new VectorIndex({
      generation, shardCapacity: packed.capacity, shards: packed.shards, entries: packed.entries, badShards: 0,
    })
    this.opts.log(`kb.vector: ${alive.length} 条向量（新嵌 ${embedded.ok.length}，失败 ${embedded.failed.length}）`)
    return { embedded: embedded.ok.length, failed: embedded.failed.length, total: alive.length }
  }
}

/** 快照里能用的向量（坏分片跳过）。 */
function snapshotVectors(snapshot: VectorSnapshot): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  for (const [id, [shard, slot]] of snapshot.entries) {
    const vector = snapshot.shards[shard]?.[slot]
    if (vector !== undefined) out.set(id, vector)
  }
  return out
}

/** 分批嵌入；维度不符当失败。 */
async function embedBatches(
  missing: readonly KbChunk[],
  embed: EmbedPort,
  dim: number,
): Promise<{ ok: Array<readonly [string, Float32Array]>; failed: string[] }> {
  const ok: Array<readonly [string, Float32Array]> = []
  const failed: string[] = []
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    const vectors = await embed.embed(batch.map((chunk) => chunk.text))
    for (let j = 0; j < batch.length; j += 1) {
      const vector = vectors?.[j]
      if (vector === undefined || vector.length !== dim) failed.push(batch[j]!.id)
      else ok.push([batch[j]!.id, vector])
    }
  }
  return { ok, failed }
}

/** 按分片容量打包（每片装满再开新片）。 */
function packVectors(
  entries: ReadonlyArray<readonly [string, Float32Array]>,
  capacity: number,
): { shards: Float32Array[][]; entries: Map<string, readonly [number, number]>; capacity: number } {
  const cap = Math.max(1, capacity)
  const shards: Float32Array[][] = []
  const index = new Map<string, readonly [number, number]>()
  for (const [id, vector] of entries) {
    let last = shards[shards.length - 1]
    if (last === undefined || last.length >= cap) {
      last = []
      shards.push(last)
    }
    last.push(vector)
    index.set(id, [shards.length - 1, last.length - 1])
  }
  return { shards, entries: index, capacity: cap }
}
