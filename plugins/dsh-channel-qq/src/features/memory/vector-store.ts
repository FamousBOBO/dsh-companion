/** 分片向量存储（P6e·e2）：`knowledge/vec.bin` + `knowledge/vec-index.json`
 * （09 §4.3；"JSONL + 二进制向量 + 暴力余弦、
 * 不引原生依赖"见 D11 与 §10）。
 *
 * 文件格式（全部小端；支持的平台 x86/arm 均为小端）：
 *
 *     文件头 64B：magic "DSHMVEC1" · 版本 u32 · 维度 u32 · 分片容量 u32 ·
 *                 总条数 u32 · 分片数 u32 · 代际 u32 · 补零
 *     分片 ×N ：子头 16B（"SHRD" · 版本 u32 · 条数 u32 · 补零）+ 条数×维度×4B float32
 *
 * 除最后一片外每片都是满容量——于是每个分片的起点由"容量"定长算出，
 * **坏分片可以被跳过、其余照用**。
 *
 * 读侧三条规矩：
 *   1. **文件头校验**：magic/版本不符、或维度与配置不符 → **整份拒绝**（退回关键词），
 *      绝不错位读下去；
 *   2. **坏分片容忍**：子头坏、条数越界、被截断 → 跳过该片、其余照用，只记一行日志；
 *   3. **零拷贝**：向量是 `Buffer → Float32Array` 的原生视图（不是逐元素拷贝；
 *      只在底层偏移不对齐这个不常见的情况下退化）。
 *
 * 清单（vec-index.json）记 id → [分片, 槽位] 与"代际"：清单与 vec.bin 的代际/维度
 * 不符（"写完文件、换清单之前进程死掉"的窗口）同样整份拒绝——旧清单 + 新文件
 * 绝不能按老坐标读，那才是真正的错位。
 */

import { promises as fs } from 'node:fs'
import { readJsonFileOrNull } from '../../adapters/fs-store/atomic.js'
import { cosineSimilarity } from '../../core/memory/score.js'
import type { EmbedPort } from '../../ports/memory.js'

export const VEC_FILE_NAME = 'vec.bin'
export const VEC_MANIFEST_NAME = 'vec-index.json'

/** 格式版本；文件头/子头/清单三处都要一致。 */
const VEC_FORMAT_VERSION = 1
/** 每片容量（09 §4.3：按 4096 条分片）。 */
const SHARD_CAPACITY = 4096

const FILE_MAGIC = 'DSHMVEC1'
const SHARD_MAGIC = 'SHRD'
const FILE_HEADER_BYTES = 64
const SHARD_HEADER_BYTES = 16

/** 清单（`vec-index.json`）的形状。 */
export interface VectorManifest {
  readonly version: number
  readonly dim: number
  readonly generation: number
  readonly count: number
  readonly entries: Record<string, readonly [number, number]>
}

/** 读出来的一份快照：检索用（`VectorIndex`）与重建（增量复用）都吃它。 */
export interface VectorSnapshot {
  /** 0 = 没有可用文件、或整份被拒绝。 */
  readonly generation: number
  readonly shardCapacity: number
  /** 有效分片；坏分片是 null 空洞（下标与文件里的分片号一一对应）。 */
  readonly shards: ReadonlyArray<ReadonlyArray<Float32Array> | null>
  /** 清单校验过的 id → [分片, 槽位]。 */
  readonly entries: ReadonlyMap<string, readonly [number, number]>
  readonly badShards: number
}

export interface EncodeOptions {
  /** 每片容量（默认 4096；测试用小容量造多分片）。 */
  readonly capacity?: number
  readonly generation?: number
}

export interface LoadVectorIndexOptions {
  /** `vec.bin` 的完整路径。 */
  readonly file: string
  /** `vec-index.json` 的完整路径。 */
  readonly manifestFile: string
  /** 配置的维度；与文件/清单不符即整份拒绝。 */
  readonly dim: number
  readonly log: (line: string) => void
}

function emptySnapshot(): VectorSnapshot {
  return { generation: 0, shardCapacity: SHARD_CAPACITY, shards: [], entries: new Map(), badShards: 0 }
}

/** 读二进制；不存在/读不了返回 null（第一次运行是常态，不抛）。 */
async function readBinaryOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file)
  } catch {
    return null
  }
}

/**
 * 取一段 float32 视图（零拷贝）。
 *
 * 正常路径下 `Buffer` 的底层 `ArrayBuffer` 偏移是对齐的，直接开视图；万一不是
 * （小文件可能来自 Node 的池化分配，没有对齐保证），退化成逐元素读——宁可慢，
 * 不能读出错位的数。
 */
function floatView(buf: Buffer, at: number, count: number): Float32Array {
  const byteOffset = buf.byteOffset + at
  if (byteOffset % 4 === 0) return new Float32Array(buf.buffer, byteOffset, count)
  const copy = new Float32Array(count)
  for (let i = 0; i < count; i++) copy[i] = buf.readFloatLE(at + i * 4)
  return copy
}

/** 编码一份完整文件（文件头 + 分片）。分片里只有最后一片允许不满容量。 */
export function encodeVectorFile(
  dim: number,
  shards: ReadonlyArray<ReadonlyArray<Float32Array>>,
  opts: EncodeOptions = {},
): Buffer {
  const capacity = opts.capacity ?? SHARD_CAPACITY
  const regionFull = SHARD_HEADER_BYTES + capacity * dim * 4
  let total = 0
  for (let i = 0; i < shards.length; i++) {
    const shard = shards[i]!
    if (shard.length > capacity || (i < shards.length - 1 && shard.length !== capacity)) {
      throw new Error(`分片 ${i} 有 ${shard.length} 条，不符合"除最后一片外满容量 ${capacity}"的格式约定`)
    }
    total += shard.length
  }
  const last = shards[shards.length - 1]
  const size = FILE_HEADER_BYTES + Math.max(0, shards.length - 1) * regionFull
    + (last === undefined ? 0 : SHARD_HEADER_BYTES + last.length * dim * 4)
  // `Buffer.from(ArrayBuffer)` 的 byteOffset 是 0：写侧的 Float32Array 视图一定对齐。
  const buf = Buffer.from(new ArrayBuffer(size))
  buf.write(FILE_MAGIC, 0, 'ascii')
  buf.writeUInt32LE(VEC_FORMAT_VERSION, 8)
  buf.writeUInt32LE(dim, 12)
  buf.writeUInt32LE(capacity, 16)
  buf.writeUInt32LE(total, 20)
  buf.writeUInt32LE(shards.length, 24)
  buf.writeUInt32LE(opts.generation ?? 1, 28)
  let offset = FILE_HEADER_BYTES
  for (const shard of shards) {
    buf.write(SHARD_MAGIC, offset, 'ascii')
    buf.writeUInt32LE(VEC_FORMAT_VERSION, offset + 4)
    buf.writeUInt32LE(shard.length, offset + 8)
    buf.writeUInt32LE(0, offset + 12)
    let at = offset + SHARD_HEADER_BYTES
    for (const vec of shard) {
      new Float32Array(buf.buffer, at, dim).set(vec)
      at += dim * 4
    }
    offset = at
  }
  return buf
}

interface FileHeader {
  readonly capacity: number
  readonly count: number
  readonly shardCount: number
  readonly generation: number
}

/** 校验文件头；不合格返回给日志看的原因（整份拒绝的那一类）。 */
function parseFileHeader(raw: Buffer, dim: number): FileHeader | string {
  if (raw.length < FILE_HEADER_BYTES) return '文件短于 64 字节的头'
  if (raw.toString('ascii', 0, 8) !== FILE_MAGIC) return 'magic 不符（不是本系统写的文件）'
  const version = raw.readUInt32LE(8)
  if (version !== VEC_FORMAT_VERSION) return `格式版本 ${version} 不认识（期望 ${VEC_FORMAT_VERSION}）`
  const fileDim = raw.readUInt32LE(12)
  if (fileDim !== dim) return `维度与配置不符（文件 ${fileDim} ≠ 配置 ${dim}）`
  const capacity = raw.readUInt32LE(16)
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65_536) return `分片容量字段非法（${capacity}）`
  return {
    capacity,
    count: raw.readUInt32LE(20),
    shardCount: raw.readUInt32LE(24),
    generation: raw.readUInt32LE(28),
  }
}

/** 逐片解析；坏片记 null（起点由容量定长算出，跳过后仍能继续）。 */
function parseShards(raw: Buffer, dim: number, header: FileHeader): { shards: Array<ReadonlyArray<Float32Array> | null>; badShards: number } {
  const regionFull = SHARD_HEADER_BYTES + header.capacity * dim * 4
  const shards: Array<ReadonlyArray<Float32Array> | null> = []
  let bad = 0
  for (let k = 0; k < header.shardCount; k++) {
    const start = FILE_HEADER_BYTES + k * regionFull
    const isLast = k === header.shardCount - 1
    if (start + SHARD_HEADER_BYTES > raw.length) {
      shards.push(null)
      bad += 1
      continue
    }
    const magic = raw.toString('ascii', start, start + 4)
    const version = raw.readUInt32LE(start + 4)
    const count = raw.readUInt32LE(start + 8)
    const sane = magic === SHARD_MAGIC && version === VEC_FORMAT_VERSION && count <= header.capacity
      && (isLast || count === header.capacity)
      && start + SHARD_HEADER_BYTES + count * dim * 4 <= raw.length
    if (!sane) {
      shards.push(null)
      bad += 1
      continue
    }
    const vectors: Float32Array[] = []
    let at = start + SHARD_HEADER_BYTES
    for (let slot = 0; slot < count; slot++) {
      vectors.push(floatView(raw, at, dim))
      at += dim * 4
    }
    shards.push(vectors)
  }
  return { shards, badShards: bad }
}

function isManifestShape(value: unknown): value is VectorManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Partial<VectorManifest>
  return v.version === VEC_FORMAT_VERSION && typeof v.dim === 'number' && typeof v.generation === 'number'
    && v.entries !== null && typeof v.entries === 'object' && !Array.isArray(v.entries)
}

/** 读 `vec.bin` + `vec-index.json`，按文件头的规矩校验/容忍。 */
export async function loadVectorSnapshot(opts: LoadVectorIndexOptions): Promise<VectorSnapshot> {
  const raw = await readBinaryOrNull(opts.file)
  if (raw === null) return emptySnapshot()
  const header = parseFileHeader(raw, opts.dim)
  if (typeof header === 'string') {
    opts.log(`memory.vector: vec.bin 不可用（${header}），整份拒绝、退回关键词`)
    return emptySnapshot()
  }
  const { shards, badShards } = parseShards(raw, opts.dim, header)
  if (badShards > 0) {
    opts.log(`memory.vector: 部分向量不可用（跳过 ${badShards} 个坏分片，共 ${header.shardCount}）`)
  }
  const manifest = await readJsonFileOrNull(opts.manifestFile, isManifestShape)
  if (manifest === null) {
    opts.log('memory.vector: 向量清单缺失或读不懂（vec-index.json），向量暂不可用（跑一次重建会生成）')
    return { ...emptySnapshot(), shards, badShards }
  }
  if (manifest.dim !== opts.dim || manifest.generation !== header.generation) {
    opts.log(`memory.vector: 清单与 vec.bin 不一致（代际 ${manifest.generation}≠${header.generation} 或维度不符），整份拒绝、退回关键词`)
    return emptySnapshot()
  }
  const entries = new Map<string, readonly [number, number]>()
  for (const [id, pos] of Object.entries(manifest.entries)) {
    if (!Array.isArray(pos) || pos.length !== 2) continue
    const shard = shards[pos[0]]
    const slot = pos[1]
    if (shard === undefined || shard === null || !Number.isInteger(slot) || slot < 0 || slot >= shard.length) continue
    entries.set(id, [pos[0], slot])
  }
  return { generation: header.generation, shardCapacity: header.capacity, shards, entries, badShards }
}

/** 组装清单（重建写盘用）。 */
export function manifestFor(
  dim: number,
  generation: number,
  entries: ReadonlyMap<string, readonly [number, number]>,
): VectorManifest {
  return { version: VEC_FORMAT_VERSION, dim, generation, count: entries.size, entries: Object.fromEntries(entries) }
}

/** 检索侧的向量索引：id → 向量视图；暴力余弦的全部输入。 */
export class VectorIndex {
  private readonly byId = new Map<string, Float32Array>()
  private readonly pairs: Array<readonly [string, Float32Array]> = []

  constructor(snapshot: VectorSnapshot) {
    for (const [id, [s, slot]] of snapshot.entries) {
      const vec = snapshot.shards[s]?.[slot]
      if (vec === undefined) continue
      this.byId.set(id, vec)
      this.pairs.push([id, vec])
    }
  }

  get(id: string): Float32Array | null {
    return this.byId.get(id) ?? null
  }

  size(): number {
    return this.byId.size
  }

  all(): ReadonlyArray<readonly [string, Float32Array]> {
    return this.pairs
  }
}

export interface LoadedVectorIndex {
  readonly index: VectorIndex
  readonly badShards: number
}

/** 便捷入口：读快照并建索引（运行时只用这一个）。 */
export async function loadVectorIndex(opts: LoadVectorIndexOptions): Promise<LoadedVectorIndex> {
  const snapshot = await loadVectorSnapshot(opts)
  return { index: new VectorIndex(snapshot), badShards: snapshot.badShards }
}

/** 检索器要的向量查询面（只在向量开启且索引非空时挂上）。 */
export interface VectorRecall {
  /** 余弦相对关键词的权重（配置 `memory.vectorWeight`；1 = 纯余弦）。 */
  readonly weight: number
  /** 把查询文本嵌成向量；服务不可用/失败返回 null（不抛）。 */
  embedQuery(text: string): Promise<Float32Array | null>
  /** 这条记录有没有向量。 */
  vectorOf(id: string): Float32Array | null
  /** 全部 (id, 向量) 对——暴力余弦的输入。 */
  all(): ReadonlyArray<readonly [string, Float32Array]>
}

/** 把 EmbedPort + VectorIndex 组装成检索器认识的样子。 */
export function createVectorRecall(embed: EmbedPort, index: VectorIndex, weight: number): VectorRecall {
  return {
    weight,
    embedQuery: async (text) => {
      if (!embed.available()) return null
      const vectors = await embed.embed([text])
      return vectors?.[0] ?? null
    },
    vectorOf: (id) => index.get(id),
    all: () => index.all(),
  }
}