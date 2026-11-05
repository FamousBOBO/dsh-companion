/** 重建（增量）向量索引（P6e·e2）：e3 的夜间任务与测试都调这里，本文件不做调度。
 *
 * 四条约定：
 *   1. **增量**：清单里已有向量的记录**不重新嵌入**，只嵌缺的（新记录、坏分片丢掉的、
 *      上次失败的）——"越跑越贵"是不允许的；
 *   2. **先写新分片、全部成功再切清单**：`vec.bin` 原子替换成功之后才写
 *      `vec-index.json`；中途失败（进程死、磁盘错、嵌入服务挂）时旧索引原样可用，
 *      下次调用从断点继续；
 *   3. **坏分片不挡路**：读的时候被判坏的分片被丢下，它们原先引用的记录当作
 *      "缺向量"重新嵌（09 §5.2 的容错要求）；
 *   4. **嵌入失败是正常输出**：失败的 id 进 `failed` 清单，其余照常写入——
 *      一次失败不该把整轮工作丢掉。
 */

import * as path from 'node:path'
import { atomicWriteFile, atomicWriteJson } from '../../adapters/fs-store/atomic.js'
import type { MemoryRecord } from '../../core/memory/model.js'
import type { EmbedPort } from '../../ports/memory.js'
import {
  VEC_FILE_NAME, VEC_MANIFEST_NAME, encodeVectorFile, loadVectorSnapshot, manifestFor,
  type VectorSnapshot,
} from './vector-store.js'

/** 一批嵌多少条（单批失败只丢这一批）。 */
const DEFAULT_BATCH = 16

export interface RebuildVectorsOptions {
  /** 要覆盖的记录集合（调用方决定收哪些；被遗忘的旧记录随重写自然掉出索引）。 */
  readonly records: readonly MemoryRecord[]
  readonly embed: EmbedPort
  /** 落点目录（`knowledge/`；`vec.bin` 与 `vec-index.json` 都写在这）。 */
  readonly dir: string
  readonly log: (line: string) => void
  /** 一次嵌入多少条（测试可调）。 */
  readonly batchSize?: number
  /** 分片容量（默认沿用已有文件的；测试用小容量造多分片）。 */
  readonly shardCapacity?: number
}

export interface RebuildVectorsResult {
  /** 索引里现在有多少个分片。 */
  readonly shards: number
  /** 索引里一共有多少条向量。 */
  readonly records: number
  /** 这次新嵌了多少条。 */
  readonly embedded: number
  /** 嵌入失败、这次没能进索引的记录 id。 */
  readonly failed: readonly string[]
}

/** 复用清单里已有向量的记录；坏分片被丢下（它们对应的记录会在下一步重嵌）。 */
function reuse(snapshot: VectorSnapshot): { shards: Float32Array[][]; entries: Map<string, readonly [number, number]> } {
  const remap = new Map<number, number>()
  const shards: Float32Array[][] = []
  for (let s = 0; s < snapshot.shards.length; s++) {
    const shard = snapshot.shards[s]
    if (shard === null || shard === undefined) continue
    remap.set(s, shards.length)
    shards.push([...shard])
  }
  const entries = new Map<string, readonly [number, number]>()
  for (const [id, [s, slot]] of snapshot.entries) {
    const target = remap.get(s)
    if (target !== undefined) entries.set(id, [target, slot])
  }
  return { shards, entries }
}

/** 还缺向量的记录（按 id 去重，后写胜出；已索引的不进）。 */
function missingOf(records: readonly MemoryRecord[], entries: ReadonlyMap<string, unknown>): MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>()
  for (const record of records) if (!entries.has(record.id)) byId.set(record.id, record)
  return [...byId.values()]
}

/** 分批嵌入；失败与维度不符的进 failed。 */
async function embedMissing(
  missing: readonly MemoryRecord[],
  embed: EmbedPort,
  batchSize: number,
): Promise<{ embedded: Array<readonly [string, Float32Array]>; failed: string[] }> {
  const embedded: Array<readonly [string, Float32Array]> = []
  const failed: string[] = []
  for (let i = 0; i < missing.length; i += batchSize) {
    const chunk = missing.slice(i, i + batchSize)
    const vectors = await embed.embed(chunk.map((r) => r.content))
    for (let j = 0; j < chunk.length; j++) {
      const vec = vectors?.[j]
      if (vec === undefined || vec.length !== embed.dim) {
        failed.push(chunk[j]!.id)
        continue
      }
      embedded.push([chunk[j]!.id, vec])
    }
  }
  return { embedded, failed }
}

/** 把新向量装进分片：先填满最后一片，再开新片；entries 就地更新槽位。 */
function packEmbedded(
  shards: Float32Array[][],
  entries: Map<string, readonly [number, number]>,
  embedded: ReadonlyArray<readonly [string, Float32Array]>,
  capacity: number,
): void {
  if (shards.length === 0) shards.push([])
  let cursor = 0
  while (cursor < embedded.length) {
    let last = shards[shards.length - 1]!
    if (last.length >= capacity) {
      shards.push([])
      last = shards[shards.length - 1]!
    }
    while (cursor < embedded.length && last.length < capacity) {
      const [id, vec] = embedded[cursor]!
      last.push(vec)
      entries.set(id, [shards.length - 1, last.length - 1])
      cursor += 1
    }
  }
}

export async function rebuildMemoryVectors(opts: RebuildVectorsOptions): Promise<RebuildVectorsResult> {
  const { embed, log } = opts
  const dim = embed.dim
  const file = path.join(opts.dir, VEC_FILE_NAME)
  const manifestFile = path.join(opts.dir, VEC_MANIFEST_NAME)
  const snapshot = await loadVectorSnapshot({ file, manifestFile, dim, log })
  const { shards, entries } = reuse(snapshot)
  const missing = missingOf(opts.records, entries)
  const { embedded, failed } = await embedMissing(missing, embed, opts.batchSize ?? DEFAULT_BATCH)
  if (embedded.length === 0) {
    log(`memory.vector: 重建无新增（可复用 ${entries.size} 条，失败 ${failed.length} 条）`)
    return { shards: shards.length, records: entries.size, embedded: 0, failed }
  }
  const capacity = opts.shardCapacity ?? snapshot.shardCapacity
  packEmbedded(shards, entries, embedded, capacity)
  const generation = snapshot.generation + 1
  // 先原子写文件、再原子换清单：两次改名之间挂掉只会让代际对不上 → 整份拒绝
  // （退回关键词），绝不会拿旧清单按老坐标去读新文件。
  await atomicWriteFile(file, encodeVectorFile(dim, shards, { capacity, generation }))
  await atomicWriteJson(manifestFile, manifestFor(dim, generation, entries))
  log(`memory.vector: 重建完成——${shards.length} 个分片、${entries.size} 条（新嵌 ${embedded.length}，失败 ${failed.length}）`)
  return { shards: shards.length, records: entries.size, embedded: embedded.length, failed }
}
