/** 小工具：建元素、内联图标、格式化。
 *
 * 为什么不用 innerHTML：这个页面的内容大半来自服务端返回（日志、文件名、
 * 语录正文……），任何一处拼字符串都是一条注入路径。`el()` 只走
 * `textContent` / 属性赋值，注入面为零；需要富文本预览的地方（Markdown）
 * 自己先转义再构造，见 `components/` 里各自的注释。
 */

/** 24×24 线性图标表。全部内联，不依赖任何字体或 CDN（部署机出网不稳）。 */
export const ICONS = {
  dot: ['M12 10.5v3.5M12 17h.01'],
  alert: ['M12 9v4M12 17h.01', 'M10.3 3.9 2.6 17.4A1.9 1.9 0 0 0 4.3 20.3h15.4a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0z'],
  info: ['M12 9h.01M11 12h1v4h1', 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18'],
  refresh: ['M20.5 12a8.5 8.5 0 1 1-2.6-6.1', 'M20.5 4.5v4.6h-4.6'],
  search: ['M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14', 'M16.2 16.2 21 21'],
  close: ['M6 6l12 12M18 6L6 18'],
  chevron: ['M9 6l6 6-6 6'],
  plus: ['M12 5v14M5 12h14'],
  trash: ['M4 7h16M9.5 7V5h5v2M6.5 7l1 12.5A2 2 0 0 0 9.5 21.5h5a2 2 0 0 0 2-2l1-12.5'],
  save: ['M5 4h11l3 3v13H5z', 'M8 4v6h7V4M8 20v-6h8v6'],
  check: ['M5 13l4 4L19 7'],
  play: ['M8 5.5v13l10-6.5z'],
  pause: ['M9 5v14M15 5v14'],
  wifi: ['M5 12.5a10 10 0 0 1 14 0M8 15.8a6 6 0 0 1 8 0', 'M12 19h.01'],
  clock: ['M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16', 'M12 8v4.5l3 2'],
  expand: ['M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6'],
  shrink: ['M9 4v5H4M15 20v-5h5M9 9 4 4M15 15l5 5'],
  eye: ['M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12', 'M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5'],
  robot: ['M7 8h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2', 'M12 4v4M9.5 12.5h.01M14.5 12.5h.01M9.5 16h5'],
  wand: ['M5 19 16 8M14 6l4 4', 'M6 6l.7 1.8L8.5 8.5 6.7 9.2 6 11l-.7-1.8L3.5 8.5l1.8-.7z'],
  db: ['M12 3a7.2 3 0 1 1 0 6 7.2 3 0 0 1 0-6', 'M4.8 6v6c0 1.7 3.2 3 7.2 3s7.2-1.3 7.2-3V6', 'M4.8 12v6c0 1.7 3.2 3 7.2 3s7.2-1.3 7.2-3v-6'],
  folder: ['M3.5 7A2.5 2.5 0 0 1 6 4.5h3.2l2 2H18A2.5 2.5 0 0 1 20.5 9v8A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  key: ['M14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M14 10h7v3h-2v2h-3v-2h-2'],
  terminal: ['M5.5 4h13a2.5 2.5 0 0 1 2.5 2.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11A2.5 2.5 0 0 1 5.5 4', 'M7.5 9.5 10.5 12l-3 2.5M13 15h3.5'],
  download: ['M12 4v10', 'M8 10l4 4 4-4', 'M4 20h16'],
  grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  plug: ['M9 3v4M15 3v4', 'M7 7h10v3a5 5 0 0 1-10 0z', 'M12 15v6'],
  chat: ['M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-2.6-.3L4 21l1.5-4.3A8.2 8.2 0 0 1 3.6 11.5a8.4 8.4 0 0 1 8.7-8.4 8.4 8.4 0 0 1 8.7 8.4z'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  image: ['M4 5h16v14H4z', 'M8.5 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3', 'M4 16l5-5 4 4 3-3 4 4'],
  smiley: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18', 'M9 10h.01M15 10h.01', 'M8.5 14a4.5 4.5 0 0 0 7 0'],
  link: ['M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1'],
  music: ['M9 18V6l10-2v12', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M16 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  quote: ['M7 7h4v6a4 4 0 0 1-4 4', 'M15 7h4v6a4 4 0 0 1-4 4'],
  book: ['M12 6c-2-1.5-4.5-2-8-2v14c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2V4c-3.5 0-6 .5-8 2z', 'M12 6v14'],
  bell: ['M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6', 'M10 19a2 2 0 0 0 4 0'],
  rss: ['M5 19h.01', 'M5 12a7 7 0 0 1 7 7', 'M5 5a14 14 0 0 1 14 14'],
  shield: ['M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z'],
  people: ['M9 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7', 'M3.5 20c0-3.5 2.8-5.5 5.5-5.5s5.5 2 5.5 5.5', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M17 14.7c2.3.5 4 2.2 4 5.3'],
  sunrise: ['M4 21h16', 'M7 17a5 5 0 0 1 10 0', 'M12 4v3M5.6 8.6l1.4 1.4M18.4 8.6 17 10'],
  brain: ['M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V15a3 3 0 0 0 3 3h1a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', 'M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V15a3 3 0 0 1-3 3h-1a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  mask: ['M4 5h16v5a8 8 0 0 1-16 0z', 'M8.5 9.5h.01M15.5 9.5h.01', 'M9 14a4 4 0 0 0 6 0'],
  toolbox: ['M4 9h16v10H4z', 'M9 9V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5V9', 'M4 13.5h16', 'M11 13.5h2v3h-2z'],
  filetext: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5M8.5 13h7M8.5 17h4'],
  chart: ['M4 20h16', 'M7 20v-6M12 20v-10M17 20v-4'],
  shieldcheck: ['M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z', 'M9 12l2 2 4-4'],
  disk: ['M4 5h16v14H4z', 'M8 5v6h8V5', 'M8 19v-4h8v4'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  gear: ['M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6', 'M19 12c0-.4 0-.8-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4L9.8 5.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5c-.1.4-.1.8-.1 1.2s0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z'],
  flask: ['M9 3h6', 'M10 3v5l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3', 'M7.5 13h9'],
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 内联 SVG 图标（`icon('save', 18)`）。未知名字回落到 info，绝不抛错。 */
export function icon(name, size) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name] ?? ICONS.info) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  // **永远给显式尺寸**：SVG 只有 viewBox 时没有内在尺寸，放进 flex 行会被当成
  // 可拉伸的替换元素——2026-10-19 人格页的文件树里，一个没给 size 的文件夹图标
  // 撑满了整块面板。CSS 里写死的尺寸（如 `.empty svg`）仍然会覆盖属性。
  const px = size ?? 16
  svg.setAttribute('width', String(px))
  svg.setAttribute('height', String(px))
  return svg
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) { append(node, child); continue }
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

/**
 * 建元素。`el('div', { class: 'x', text: '…', on: { click } }, child…)`。
 *
 * 属性规则：
 *   - `class` / `text` / `on` / `attrs` / `dataset` 有专门语义；
 *   - 其余先试 DOM 属性（`node[key] = value`），失败退回 setAttribute——
 *     这样 `value`、`checked`、`disabled` 是"活属性"，而 `aria-*` 走 attrs。
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'on') { for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn) }
    else if (key === 'attrs') { for (const [a, v] of Object.entries(value)) { if (v !== null && v !== undefined && v !== false) node.setAttribute(a, String(v)) } }
    else if (key === 'dataset') { for (const [d, v] of Object.entries(value)) { if (v !== null && v !== undefined) node.dataset[d] = String(v) } }
    else if (key in node && typeof value !== 'object') node[key] = value
    else node.setAttribute(key, String(value))
  }
  append(node, children)
  return node
}

export function frag(...children) {
  const f = document.createDocumentFragment()
  append(f, children)
  return f
}

/** 清空一个节点并返回它（`clear(host)` 链式使用）。 */
export function clear(node) {
  node.textContent = ''
  return node
}

export function fmtBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '—'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1048576).toFixed(1)} MB`
}

/** 毫秒时间戳 → 本地时间。 */
export function fmtTime(ms) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v <= 0) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 秒 → 人类可读时长（88s → 1 分 28 秒）。 */
export function fmtDuration(sec) {
  const n = Math.floor(Number(sec))
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 60) return `${n} 秒`
  const d = Math.floor(n / 86400); const h = Math.floor((n % 86400) / 3600)
  const m = Math.floor((n % 3600) / 60); const s = n % 60
  const out = []
  if (d) out.push(`${d} 天`)
  if (h) out.push(`${h} 小时`)
  if (m) out.push(`${m} 分`)
  if (!d && !h) out.push(`${s} 秒`)
  return out.join(' ')
}

/** 任意值 → 一行文字（表格与 kv 共用）。 */
export function str(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (Array.isArray(v)) return v.length ? v.join(', ') : '（空）'
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return '[对象]' } }
  return String(v) === '' ? '（空）' : String(v)
}

/** 表格单元格：时间类字段（*At / time / date / ts）按时间戳渲染。 */
export function cellText(key, v) {
  if (typeof v === 'number' && /time|at$|date|ts$/i.test(key) && v > 1_000_000_000) {
    return fmtTime(v < 1e12 ? v * 1000 : v)
  }
  return str(v)
}
