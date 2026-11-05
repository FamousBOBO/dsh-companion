/** 卡片与小件：section / pill / statTile / kvList / empty / loading / 按钮。
 *
 * 页面模块只用这些积木拼装（`pages/*.js`），保证 25 个页面长得像一套东西；
 * 布局探针断言的类名（.card / .cardhead / .pill / .stat / .empty）都在这里定义。
 */

import { el, icon, str } from '../dom.js'

/**
 * 带标题的卡片。返回 `{ node, body }`：node 挂到页面，body 里放内容。
 * `actions` 是标题右侧的按钮节点数组。
 */
export function section({ title, icon: iconName, actions = [], blurb } = {}) {
  const node = el('section', { class: 'card' })
  if (title !== undefined && title !== null) {
    const head = el('div', { class: 'cardhead' })
    const h = el('h3')
    if (iconName) h.appendChild(icon(iconName))
    h.appendChild(el('span', { text: title }))
    head.appendChild(h)
    if (actions.length > 0) {
      const right = el('div', { class: 'rowflex' })
      for (const action of actions) right.appendChild(action)
      head.appendChild(right)
    }
    node.appendChild(head)
  }
  if (blurb) node.appendChild(el('p', { class: 'blurb', text: blurb }))
  const body = el('div', { class: 'cardbody' })
  node.appendChild(body)
  return { node, body }
}

export function pill(text, kind) {
  const p = el('span', { class: 'pill' + (kind ? ' ' + kind : '') })
  p.appendChild(el('span', { class: 'dot' }))
  p.appendChild(el('span', { text }))
  return p
}

export function statTile(k, v, sub, kind) {
  const t = el('div', { class: 'stat' })
  t.appendChild(el('span', { class: 'k', text: k }))
  const text = v === null || v === undefined ? '—' : String(v)
  // 长值（模型名、音色、后端 id）用更小的字号：数字和短值才配大字号，
  // 否则一个 24 字符的 id 会把整行撑成三行，指标卡就失去了"扫一眼"的作用。
  const val = el('div', { class: 'v' + (text.length > 14 ? ' long' : '') })
  if (kind) val.appendChild(pill(text, kind))
  else val.textContent = text
  t.appendChild(val)
  if (sub) t.appendChild(el('div', { class: 's', text: sub }))
  return t
}

export function kvRow(k, v, mono) {
  const row = el('div', { class: 'kvpair' })
  row.appendChild(el('span', { class: 'k', text: k }))
  const val = el('span', { class: 'v' + (mono ? ' mono' : '') })
  if (v instanceof Node) val.appendChild(v)
  else val.textContent = str(v)
  row.appendChild(val)
  return row
}

/** `kvList([['键', 值], ['键2', 值2, true]])` → 一个 .kv 网格。 */
export function kvList(pairs) {
  const box = el('div', { class: 'kv' })
  for (const [k, v, mono] of pairs) box.appendChild(kvRow(k, v, mono))
  return box
}

export function emptyBox(title, desc, iconName) {
  const b = el('div', { class: 'empty' })
  b.appendChild(icon(iconName ?? 'info'))
  b.appendChild(el('b', { text: title }))
  if (desc) b.appendChild(el('span', { text: desc }))
  return b
}

export function loadingBox(text) {
  const b = el('div', { class: 'loading' })
  b.appendChild(el('span', { class: 'spin' }))
  b.appendChild(el('span', { text: text ?? '加载中…' }))
  return b
}

export function skeletonRows(n) {
  const wrap = el('div', { class: 'stack' })
  for (let i = 0; i < (n ?? 3); i += 1) {
    const row = el('div', { class: 'stat' })
    const s1 = el('div', { class: 'sk' })
    s1.style.width = '38%'
    s1.style.marginBottom = '8px'
    const s2 = el('div', { class: 'sk' })
    s2.style.width = '68%'
    row.appendChild(s1)
    row.appendChild(s2)
    wrap.appendChild(row)
  }
  return wrap
}

export function button(label, cls, iconName) {
  const b = el('button', { class: 'btn' + (cls ? ' ' + cls : ''), type: 'button' })
  if (iconName) b.appendChild(icon(iconName))
  if (label) b.appendChild(el('span', { text: label }))
  return b
}

/** 警示横幅（notice）。 */
export function notice(content) {
  const n = el('div', { class: 'notice' })
  n.appendChild(icon('alert'))
  const box = el('div')
  if (content instanceof Node) box.appendChild(content)
  else box.appendChild(el('span', { text: String(content) }))
  n.appendChild(box)
  return n
}

/** 行内状态文字。`setNote(node, kind, text)` 是它的更新函数。 */
export function note(initial = '') {
  const n = el('span', { class: 'inline-note', text: initial })
  return n
}

/**
 * `node` 可能已被上一个页面卸载（异步任务回来得比导航晚）。**静默忽略**比抛
 * `Cannot set properties of undefined` 好：那会把一条普通的"页面已离开"变成
 * 满屏红色错误条。真正需要报的错由调用方自己 toast。
 */
export function setNote(node, kind, text) {
  if (node === null || node === undefined) return
  node.className = 'inline-note' + (kind ? ' ' + kind : '')
  node.textContent = text ?? ''
}
