/** 资源表：一个通用组件渲染某张 `/api/resource/<name>` 表。
 *
 * 数据形状来自 `AdminResource`（服务端）：list 返回任意 JSON，前端的约定是
 * "最外层对象里第一个数组就是行集"（旧面板同款约定，10 张表都吃它）。
 * 行卡片优先（手机上表格没法看），删除/新增走二次确认，动作走后端 `/api/action`。
 */

import { el, cellText, icon, str } from '../dom.js'
import { api, authLost, errText, download } from '../api.js'
import { button, emptyBox, kvRow } from './card.js'
import { confirmDialog } from './dialog.js'
import { toast } from './toast.js'

const PAGE = 40

/** 从任意返回体里取出行集（第一个数组；没有数组则整体当一行）。 */
export function rowsOf(data) {
  if (Array.isArray(data)) return data
  if (data !== null && typeof data === 'object') {
    for (const value of Object.values(data)) if (Array.isArray(value)) return value
    return [data]
  }
  return []
}

export function rowId(row) {
  if (row === null || typeof row !== 'object') return String(row ?? '')
  for (const key of ['id', 'md5', 'file', 'url', 'text', 'name', 'room', 'key']) {
    const value = row[key]
    if (value !== undefined && value !== null && typeof value !== 'object') return String(value)
  }
  try { return JSON.stringify(row).slice(0, 80) } catch { return '' }
}

/**
 * 构建资源表卡片。
 * @param {{
 *   name: string, label: string, hint?: string,
 *   creatable?: boolean, createTemplate?: string|object,
 *   actions?: Array<{ name: string, label: string, icon?: string, confirm?: string, danger?: boolean }>,
 * }} spec
 */
export function createResourceTable(spec) {
  const state = { rows: [], shown: PAGE, loaded: false, error: null }

  const countPill = el('span', { class: 'pill', text: '— 条' })
  const searchInput = el('input', { type: 'search', placeholder: `在 ${spec.label} 里搜索…`, attrs: { 'aria-label': `搜索 ${spec.label}`, autocomplete: 'off' } })
  const listBox = el('div', { class: 'reslist' })
  const note = el('div', { class: 'inline-note' })

  const refreshBtn = button('刷新', 'small', 'refresh')
  refreshBtn.addEventListener('click', () => { refreshBtn.disabled = true; void load().finally(() => { refreshBtn.disabled = false }) })
  const exportBtn = button('导出 JSON', 'small', 'download')
  exportBtn.addEventListener('click', () => {
    download(`${spec.name}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.rows, null, 1))
  })

  const head = el('div', { class: 'cardhead' }, [
    el('h3', {}, [icon('db'), el('span', { text: spec.label }), el('code', { class: 'tag', text: spec.name })]),
    el('div', { class: 'rowflex' }, [countPill, refreshBtn, exportBtn]),
  ])
  const card = el('section', { class: 'card' }, [head])
  if (spec.hint) card.appendChild(el('p', { class: 'blurb', text: spec.hint }))

  // 动作按钮（如"重建表情索引"）。
  if (Array.isArray(spec.actions) && spec.actions.length > 0) {
    const bar = el('div', { class: 'rowflex', style: 'margin-bottom:10px' })
    for (const action of spec.actions) {
      const btn = button(action.label, 'small' + (action.danger ? ' danger' : ''), action.icon ?? 'wand')
      btn.addEventListener('click', () => { void runAction(action, btn) })
      bar.appendChild(btn)
    }
    card.appendChild(bar)
  }

  // 新增表单（JSON 模板）。
  if (spec.creatable === true) {
    const det = el('details', { class: 'addform' })
    det.appendChild(el('summary', { text: '新增一条（JSON）' }))
    const inner = el('div', { class: 'inner' })
    const template = typeof spec.createTemplate === 'string'
      ? spec.createTemplate
      : JSON.stringify(spec.createTemplate ?? {}, null, 2)
    const ta = el('textarea', { rows: 5, spellcheck: false, value: template })
    const taId = `res-add-${spec.name}`
    ta.id = taId
    inner.appendChild(el('label', { class: 'flabel', for: taId, text: '请求体：必须是 JSON 对象' }))
    inner.appendChild(ta)
    const addNote = el('span', { class: 'inline-note' })
    const addBtn = button('写入', 'small primary', 'plus')
    addBtn.addEventListener('click', () => { void create(ta, addBtn, addNote) })
    inner.appendChild(el('div', { class: 'rowflex', style: 'margin-top:8px' }, [addBtn, addNote]))
    det.appendChild(inner)
    card.appendChild(det)
  }

  const searchWrap = el('div', { class: 'toolbar', style: 'margin-bottom:10px' }, [el('div', { class: 'grow' }, searchInput)])
  card.appendChild(searchWrap)
  card.appendChild(note)
  card.appendChild(listBox)

  let searchTimer = null
  searchInput.addEventListener('input', () => {
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { searchTimer = null; paint() }, 140)
  })

  function filtered() {
    const kw = searchInput.value.trim().toLowerCase()
    if (kw === '') return state.rows
    return state.rows.filter((row) => {
      try { return JSON.stringify(row).toLowerCase().includes(kw) } catch { return false }
    })
  }

  function paint() {
    listBox.textContent = ''
    if (state.error !== null) {
      listBox.appendChild(emptyBox('读取失败', state.error, 'alert'))
      return
    }
    if (!state.loaded) {
      listBox.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: `正在读取 ${spec.label}…` })]))
      return
    }
    const rows = filtered()
    countPill.textContent = `${rows.length} 条`
    if (rows.length === 0) {
      listBox.appendChild(emptyBox(
        state.rows.length === 0 ? '这张表还是空的' : '没有匹配的行',
        state.rows.length === 0 && spec.creatable === true ? '用上面的「新增一条」写入第一条记录。' : '换个关键词试试。',
        'db'))
      return
    }
    const limit = Math.min(rows.length, state.shown)
    for (let i = 0; i < limit; i += 1) listBox.appendChild(rowCard(rows[i], i))
    if (rows.length > limit) {
      const more = button(`显示更多（还有 ${rows.length - limit} 条）`, 'small', 'plus')
      more.style.marginTop = '10px'
      more.addEventListener('click', () => { state.shown = limit + PAGE * 2; paint() })
      listBox.appendChild(more)
    }
  }

  function rowCard(row, index) {
    const cardEl = el('div', { class: 'rowcard' })
    const headEl = el('div', { class: 'rowhead' })
    headEl.appendChild(el('div', { class: 'rid', text: `${index + 1}. ${rowId(row).slice(0, 90)}` }))
    const del = button('删除', 'small danger', 'trash')
    del.setAttribute('aria-label', `删除第 ${index + 1} 条记录`)
    del.addEventListener('click', () => { void remove(row, del) })
    headEl.appendChild(del)
    cardEl.appendChild(headEl)
    const kv = el('div', { class: 'kv' })
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
      const keys = Object.keys(row)
      if (keys.length === 0) kv.appendChild(kvRow('内容', '（空对象）'))
      for (const key of keys) {
        kv.appendChild(kvRow(key, cellText(key, row[key]), key === 'file' || key === 'md5' || key === 'path'))
      }
    } else {
      kv.appendChild(kvRow('值', str(row)))
    }
    cardEl.appendChild(kv)
    return cardEl
  }

  async function load() {
    const res = await api(`/api/resource/${spec.name}`)
    if (authLost(res)) return
    if (res.status !== 200) {
      state.error = errText(res, `读取 ${spec.label} 失败`)
      state.loaded = true
      paint()
      return
    }
    state.error = null
    state.loaded = true
    state.rows = rowsOf(res.body.data)
    state.shown = PAGE
    paint()
  }

  function refresh() { return load() }

  async function remove(row, btn) {
    const id = rowId(row)
    const ok = await confirmDialog({
      title: `删除这条记录？`,
      message: `${spec.label} · ${id.slice(0, 120)}`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    btn.disabled = true
    const res = await api(`/api/resource/${spec.name}?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    btn.disabled = false
    if (authLost(res)) return
    if (res.status !== 200) { toast(`删除失败：${errText(res)}`, 'bad'); return }
    toast('已删除 1 条', 'ok')
    void load()
  }

  async function create(ta, btn, addNote) {
    const raw = ta.value.trim()
    if (raw === '') { addNote.className = 'inline-note bad'; addNote.textContent = '请求体不能为空'; return }
    let payload = null
    try { payload = JSON.parse(raw) } catch (error) { addNote.className = 'inline-note bad'; addNote.textContent = `JSON 语法错误：${error.message}`; return }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      addNote.className = 'inline-note bad'
      addNote.textContent = '请求体必须是 JSON 对象'
      return
    }
    btn.disabled = true
    addNote.className = 'inline-note'
    addNote.textContent = '写入中…'
    const res = await api(`/api/resource/${spec.name}`, { method: 'POST', body: payload })
    btn.disabled = false
    if (authLost(res)) return
    if (res.status !== 200) {
      addNote.className = 'inline-note bad'
      addNote.textContent = `写入失败：${errText(res)}`
      return
    }
    addNote.className = 'inline-note ok'
    addNote.textContent = '已写入 1 条。'
    toast(`已写入 ${spec.label}`, 'ok')
    void load()
  }

  async function runAction(action, btn) {
    if (action.confirm !== undefined) {
      const ok = await confirmDialog({ title: action.label, message: action.confirm, confirmText: '执行', danger: action.danger === true })
      if (!ok) return
    }
    btn.disabled = true
    const res = await api(`/api/action/${action.name}`, { method: 'POST', body: { resource: spec.name } })
    btn.disabled = false
    if (authLost(res)) return
    if (res.status !== 200) { toast(`${action.label}失败：${errText(res)}`, 'bad'); return }
    toast(`${action.label}完成`, 'ok')
    void load()
  }

  return { node: card, load, get rows() { return state.rows } }
}
