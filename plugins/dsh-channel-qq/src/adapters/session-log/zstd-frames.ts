/** 会话日志的 zstd 解码：会话文件是**多帧**的，必须逐帧解。
 *
 * 背景（2026-10-16 实测，见 `内部文档宿主核实记录.md` 的 V10）：
 * `zstdDecompressSync` 对多帧输入**静默只返回第一帧**——不报错、不提示。
 * 而 dsh 的会话日志是"每 append 一次压一帧"，于是线上文件动辄上千帧：
 *
 *   qq-dm-1000000002        1709 帧 → 整体解码 1 行 / 逐帧解码 3210 行
 *   qq-group-1000000003     5097 帧 → 整体解码 1 行 / 逐帧解码 9156 行
 *
 * 那"1 行"就是 `{"type":"session","version":4,…}` 这个会话头。所以旧实现下
 * `qq_search_history` 实际搜不到任何历史。
 *
 * 做法与 KB Lite 一致：扫 zstd 魔法数 `28 B5 2F FD` 定位每一帧的起点，
 * 逐帧解、拼起来。最后一帧可能是**半截**（进程正在写），解不开就跳过并计数——
 * 宁可少一行，不能因为正在写入而整个读取失败。
 *
 * 只依赖 `node:zlib`；解码函数可注入，所以本地测试不需要真文件。
 */

import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧的魔法数。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 可注入的解码函数（测试用）。 */
export type ZstdDecompress = (input: Buffer) => Buffer

export interface FrameDecodeResult {
  /** 各帧解出的文本按顺序拼接。 */
  text: string
  /** 扫描到的帧数。 */
  frames: number
  /** 解不开而被跳过的帧数（通常只有尾部半截帧）。 */
  skipped: number
}

/** 找出所有帧的起始偏移。 */
export function frameOffsets(raw: Buffer): number[] {
  const offsets: number[] = []
  for (let i = 0; i + ZSTD_MAGIC.length <= raw.length; i++) {
    if (raw.compare(ZSTD_MAGIC, 0, ZSTD_MAGIC.length, i, i + ZSTD_MAGIC.length) === 0) offsets.push(i)
  }
  return offsets
}

/**
 * 逐帧解码一个（可能是多帧的）zstd 缓冲区。
 *
 * @param raw 原始字节
 * @param decompress 解码函数，默认用 `node:zlib` 的实现
 * @returns 拼接后的文本，以及帧数与被跳过的帧数
 */
export function decodeZstdFrames(raw: Buffer, decompress: ZstdDecompress = zstdDecompressSync): FrameDecodeResult {
  if (raw.length === 0) return { text: '', frames: 0, skipped: 0 }
  const offsets = frameOffsets(raw)
  // 一个魔法数都没扫到：不是 zstd（或不是从帧头开始）。按单帧试一次，
  // 让上层拿到真正的解码错误，而不是一段看不出所以然的空字符串。
  if (offsets.length === 0 || offsets[0] !== 0) {
    return { text: decompress(raw).toString('utf8'), frames: 1, skipped: 0 }
  }
  const parts: string[] = []
  let skipped = 0
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
    try {
      parts.push(decompress(raw.subarray(offsets[i], end)).toString('utf8'))
    } catch {
      // 尾部半截帧（写了一半）会走到这里；中间帧解不开说明文件坏了，
      // 但继续往下解仍然比整个放弃多拿回一些内容。
      skipped += 1
    }
  }
  return { text: parts.join(''), frames: offsets.length, skipped }
}

/**
 * 取 `node:zlib` 的 zstd 解码实现。
 *
 * @throws Error 这个 Node 构建没有 zstd 支持时。
 */
export function resolveZstd(): ZstdDecompress {
  if (typeof zstdDecompressSync !== 'function') {
    throw new Error(
      'this Node build has no zstd support; need Node >= 22.15 or DSH_SESSIONS_ROOT pointing at an uncompressed store',
    )
  }
  return zstdDecompressSync
}
