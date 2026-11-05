/** Toast：浮动提示，不打断操作。挂在 index.html 的 `#toasts` 上。 */

import { el } from '../dom.js'

/**
 * @param {string} text 提示正文
 * @param {'ok'|'bad'|'warn'|undefined} kind 左侧色条
 * @param {number|undefined} ms 停留毫秒（0 = 不自动消失）
 */
export function toast(text, kind, ms) {
  const host = document.getElementById('toasts')
  if (host === null) return
  const node = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), attrs: { role: 'status' } })
  node.appendChild(el('div', { class: 'tmsg', text: String(text ?? '') }))
  const close = el('button', {
    class: 'tclose',
    type: 'button',
    text: '×',
    attrs: { 'aria-label': '关闭提示' },
    on: { click: () => node.remove() },
  })
  node.appendChild(close)
  host.appendChild(node)
  const life = ms === undefined ? (kind === 'bad' ? 9000 : 4200) : ms
  if (life > 0) setTimeout(() => node.remove(), life)
}
