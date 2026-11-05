/** 对话框：通用面板 / 确认 / 需逐字输入字样的二次确认 / 文本输入。
 *
 * 三条硬约束（refactor-plan/10 §3.7：危险操作必须二次确认）：
 *   - Esc 关闭、背景点击取消、Tab 焦点圈在对话框内、关闭后焦点回到打开者；
 *   - `typedConfirm` 必须逐字输入约定字样才点亮确认按钮——危险操作不留
 *     "手快点一下"的路径；
 *   - 所有节点走 `el()` 构造（textContent），对话内容可以安全地含任意字符。
 */

import { el, icon } from '../dom.js'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** 通用对话框。`actions: [{ label, kind?, enabled?, run(api) }]`。 */
export function openDialog({ title, body, actions = [], onClose }) {
  const opener = document.activeElement
  const root = document.getElementById('dialog-root')
  const backdrop = el('div', { class: 'dialog-backdrop' })
  const box = el('div', {
    class: 'dialog',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title ?? '' },
  })

  const head = el('div', { class: 'dialog-head' }, el('h3', { text: title ?? '' }))
  const closeBtn = el('button', {
    class: 'iconbtn',
    type: 'button',
    attrs: { 'aria-label': '关闭' },
    on: { click: () => api.close() },
  }, icon('close'))
  head.appendChild(closeBtn)
  box.appendChild(head)

  const bodyBox = el('div', { class: 'dialog-body' })
  if (body instanceof Node) bodyBox.appendChild(body)
  else if (body !== undefined && body !== null && String(body) !== '') bodyBox.appendChild(el('p', { text: String(body) }))
  box.appendChild(bodyBox)

  const foot = el('div', { class: 'dialog-foot' })
  box.appendChild(foot)
  backdrop.appendChild(box)
  root.appendChild(backdrop)

  let closed = false
  const buttons = []
  for (const action of actions) {
    const btn = el('button', {
      class: 'btn' + (action.kind ? ' ' + action.kind : ''),
      type: 'button',
      text: action.label,
      disabled: action.enabled === false,
      on: { click: () => action.run(api) },
    })
    buttons.push({ action, btn })
    foot.appendChild(btn)
  }

  function dismiss(value) {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey, true)
    backdrop.remove()
    try { if (opener !== null && opener.focus) opener.focus() } catch { /* ignore */ }
    if (onClose) onClose(value)
  }

  function onKey(ev) {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      api.close()
      return
    }
    if (ev.key !== 'Tab') return
    const nodes = [...box.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && n.offsetParent !== null)
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus() }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus() }
  }
  document.addEventListener('keydown', onKey, true)

  const api = {
    box,
    foot,
    buttons,
    close: () => dismiss(null),
    dismiss,
  }
  const focusTarget = box.querySelector('input, textarea, select') ?? buttons[0]?.btn ?? closeBtn
  setTimeout(() => { try { focusTarget.focus() } catch { /* ignore */ } }, 0)
  return api
}

/** 确认框 → Promise<boolean>。 */
export function confirmDialog({ title, message, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false
    openDialog({
      title,
      body: message,
      onClose: () => { if (!settled) { settled = true; resolve(false) } },
      actions: [
        { label: cancelText, run: (d) => { settled = true; resolve(false); d.close() } },
        { label: confirmText, kind: danger ? 'danger' : 'primary', run: (d) => { settled = true; resolve(true); d.close() } },
      ],
    })
  })
}

/** 危险操作的二次确认：必须逐字输入 `word` 才能提交 → Promise<boolean>。 */
export function typedConfirm({ title, message, word, confirmText = '确定', danger = true }) {
  return new Promise((resolve) => {
    let settled = false
    const input = el('input', {
      type: 'text',
      autocomplete: 'off',
      placeholder: word,
      attrs: { 'aria-label': '输入确认字样' },
    })
    const label = el('label', { class: 'flabel' })
    label.appendChild(document.createTextNode('输入 '))
    label.appendChild(el('code', { text: word }))
    label.appendChild(document.createTextNode(' 以确认'))
    const body = el('div', { class: 'stack' })
    if (message) body.appendChild(el('p', { class: 'blurb', text: message }))
    body.appendChild(label)
    body.appendChild(input)
    const api = openDialog({
      title,
      body,
      onClose: () => { if (!settled) { settled = true; resolve(false) } },
      actions: [
        { label: '取消', run: (d) => { settled = true; resolve(false); d.close() } },
        {
          label: confirmText,
          kind: danger ? 'danger' : 'primary',
          enabled: false,
          run: (d) => {
            if (input.value.trim() !== word) return
            settled = true
            resolve(true)
            d.close()
          },
        },
      ],
    })
    input.addEventListener('input', () => {
      api.buttons[1].btn.disabled = input.value.trim() !== word
    })
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && input.value.trim() === word) {
        settled = true
        resolve(true)
        api.close()
      }
    })
  })
}

/** 文本输入框 → Promise<string|null>（取消 = null）。 */
export function promptDialog({ title, label: labelText, placeholder = '', value = '', confirmText = '确定' }) {
  return new Promise((resolve) => {
    let settled = false
    const input = el('input', { type: 'text', value, placeholder, autocomplete: 'off' })
    const body = el('div', { class: 'stack' },
      labelText ? el('label', { class: 'flabel', text: labelText }) : null,
      input)
    const api = openDialog({
      title,
      body,
      onClose: () => { if (!settled) { settled = true; resolve(null) } },
      actions: [
        { label: '取消', run: (d) => { settled = true; resolve(null); d.close() } },
        { label: confirmText, kind: 'primary', run: (d) => { settled = true; resolve(input.value); d.close() } },
      ],
    })
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { settled = true; resolve(input.value); api.close() }
    })
  })
}
