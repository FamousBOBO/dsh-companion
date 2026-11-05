/** 极简二维码编码器（byte 模式、纠错 L、版本 1–6、掩码 0）。
 *
 * 为什么自己写：后台的「扫码登录」要显示二维码，但项目**不允许新增运行时依赖**
 * （D8），也不该把登录 key 发给第三方二维码图片服务。这里只实现登录链接需要的
 * 那一档：≤106 字节（v1–v6-L），足够放网易云/酷狗的登录 URL（约 70 字）。
 * 超出就抛错，由调用方退回「显示链接、用手机浏览器打开」。
 *
 * 规格：ISO/IEC 18004。模块位置与格式信息按标准计算；没有查表之外的魔法数。
 */

/** 版本 → [数据码字数, 纠错码字数, 块数]（纠错等级 L）。 */
const BLOCKS_L = {
  1: [19, 7, 1], 2: [34, 10, 1], 3: [55, 15, 1],
  4: [80, 20, 1], 5: [108, 26, 1], 6: [68, 18, 2],
}

/** 版本 → 对齐图形中心坐标。 */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
}

const MAX_BYTES = 106

/** GF(256) 的指数/对数表（本原多项式 0x11D）。 */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
let seed = 1
for (let i = 0; i < 255; i += 1) {
  EXP[i] = seed
  LOG[seed] = i
  seed <<= 1
  if (seed & 0x100) seed ^= 0x11d
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]

function mul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** 生成多项式（n 个纠错码字）。 */
function generator(n) {
  let poly = [1]
  for (let i = 0; i < n; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= mul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** 一段数据 → n 个纠错码字。 */
function eccFor(data, n) {
  const gen = generator(n)
  const out = new Array(n).fill(0)
  for (const byte of data) {
    const factor = byte ^ out[0]
    out.shift()
    out.push(0)
    if (factor !== 0) for (let i = 0; i < n; i += 1) out[i] ^= mul(gen[i + 1], factor)
  }
  return out
}

/** 字节串 → 数据码字（模式 + 长度 + 内容 + 终止符 + 填充）。 */
function dataCodewords(bytes, version) {
  const dataLen = BLOCKS_L[version][0]
  const bits = []
  const push = (value, len) => { for (let i = len - 1; i >= 0; i -= 1) bits.push((value >> i) & 1) }
  push(4, 4)
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  const capacity = dataLen * 8
  for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const out = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]
    out.push(byte)
  }
  const pads = [0xec, 0x11]
  let k = 0
  while (out.length < dataLen) { out.push(pads[k % 2]); k += 1 }
  return out
}

/** 分块 + 纠错 + 交错，得到最终码字序列。 */
function codewords(bytes, version) {
  const dataLen = BLOCKS_L[version][0]
  const eccLen = BLOCKS_L[version][1]
  const blocks = BLOCKS_L[version][2]
  const data = dataCodewords(bytes, version)
  const per = dataLen / blocks
  const datas = []
  const eccs = []
  for (let i = 0; i < blocks; i += 1) {
    const chunk = data.slice(i * per, (i + 1) * per)
    datas.push(chunk)
    eccs.push(eccFor(chunk, eccLen))
  }
  const out = []
  for (let i = 0; i < per; i += 1) for (const d of datas) out.push(d[i])
  for (let i = 0; i < eccLen; i += 1) for (const e of eccs) out.push(e[i])
  return out
}

/** 空白矩阵 + 功能图形（定位/分隔/时序/对齐/暗模块/格式区占位）。 */
function buildMatrix(version) {
  const size = 17 + version * 4
  const m = Array.from({ length: size }, () => new Array(size).fill(0))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (r, c, v) => { m[r][c] = v; reserved[r][c] = true }

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = r0 + r
        const cc = c0 + c
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
        set(rr, cc, dark ? 1 : 0)
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0 ? 1 : 0)
    set(i, 6, i % 2 === 0 ? 1 : 0)
  }

  for (const r of ALIGN[version] ?? []) {
    for (const c of ALIGN[version] ?? []) {
      const nearFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)
      if (nearFinder) continue
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0)
        }
      }
    }
  }

  // 第一份（左上）：行 8 的左 8 格 + 列 8 的上 8 格；两份共 15+15 位。
  for (let i = 0; i < 9; i += 1) { reserved[8][i] = true; reserved[i][8] = true }
  // 第二份：行 8 右 8 格 + 列 8 下 7 格；再往下那格是恒暗的「暗模块」，不算格式位。
  for (let i = 0; i < 8; i += 1) reserved[8][size - 1 - i] = true
  for (let i = 0; i < 7; i += 1) reserved[size - 1 - i][8] = true
  set(size - 8, 8, 1)
  return { m, reserved, size }
}

/** BCH(15,5) 格式信息：等级 L（01）+ 掩码号，最后异或 0x5412。 */
function formatBits(mask) {
  const data = (0b01 << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i -= 1) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10)
  return ((data << 10) | rem) ^ 0x5412
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/** 码字按之字形铺进矩阵（跳过功能图形），同时应用掩码。 */
function placeData(m, reserved, size, words, mask) {
  const bits = []
  for (const w of words) for (let i = 7; i >= 0; i -= 1) bits.push((w >> i) & 1)
  let idx = 0
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (let n = 0; n < size; n += 1) {
      const row = upward ? size - 1 - n : n
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue
        const bit = idx < bits.length ? bits[idx] : 0
        idx += 1
        m[row][c] = bit ^ (MASKS[mask](row, c) ? 1 : 0)
      }
    }
    upward = !upward
  }
}

/**
 * 写格式信息（两份）。
 *
 * 两份的**位序相反**，这是 ISO 18004 的规定，不是笔误：
 *   副本 A（左上）：高位在前 → (8,0..5)、(8,7)、(8,8)、(7,8)、(5..0,8)；
 *   副本 B（右上/左下）：低位在前 → (8,size-1..size-8) 与 (size-1..size-7,8)；
 *   (size-8,8) 是恒暗的暗模块（值 1，不属于格式位）。
 */
function writeFormat(m, size, bits) {
  const msb = (i) => (bits >> (14 - i)) & 1
  const lsb = (i) => (bits >> i) & 1
  for (let i = 0; i <= 5; i += 1) m[8][i] = msb(i)
  m[8][7] = msb(6)
  m[8][8] = msb(7)
  m[7][8] = msb(8)
  for (let i = 9; i <= 14; i += 1) m[14 - i][8] = msb(i)
  for (let i = 0; i <= 7; i += 1) m[8][size - 1 - i] = lsb(i)
  for (let i = 0; i <= 6; i += 1) m[size - 1 - i][8] = lsb(8 + i)
  m[size - 8][8] = 1
}

/** 编码一段文本 → { version, size, modules }。超长抛错。 */
export function encodeQr(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)))
  if (bytes.length > MAX_BYTES) throw new Error(`内容太长（${bytes.length} 字节，上限 ${MAX_BYTES}）`)
  let version = 6
  for (let v = 1; v <= 6; v += 1) {
    if (dataCodewords(bytes, v).length <= BLOCKS_L[v][0]) { version = v; break }
  }
  const built = buildMatrix(version)
  placeData(built.m, built.reserved, built.size, codewords(bytes, version), 0)
  writeFormat(built.m, built.size, formatBits(0))
  return { version, size: built.size, modules: built.m }
}

/** 编码 → SVG 字符串（黑白方块；1 模块 = 1 单位，可缩放）。 */
export function qrSvg(text, { margin = 4 } = {}) {
  const { size, modules } = encodeQr(text)
  const dim = size + margin * 2
  const parts = []
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c] === 1) parts.push(`M${c + margin} ${r + margin}h1v1h-1z`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="220" height="220" shape-rendering="crispEdges" role="img" aria-label="登录二维码"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${parts.join('')}" fill="#000"/></svg>`
}
