/** 人格页：工作区文件（树 + 编辑器 + Markdown 预览）、Agent 预设、会话重建。
 *
 * 三块各自独立加载，互不阻塞。危险动作（重建会话、删文件）都要逐字确认。
 * Markdown 预览是"先转义再格式化"的精简实现——**绝不**把文件内容拼进 innerHTML。
 */

import { el, fmtBytes, fmtTime, icon } from '../dom.js'
import { api, errText } from '../api.js'
import { state, loadSnapshot } from '../state.js'
import { button, emptyBox, pill, section, setNote } from '../components/card.js'
import { createConfigForm } from '../components/form.js'
import { promptDialog, typedConfirm } from '../components/dialog.js'
import { toast } from '../components/toast.js'

const files = {
  expanded: {},
  children: {},
  selected: null,
  content: '',
  dirty: false,
  truncated: false,
  mtime: 0,
}

let host = null
let refs = {}
let form = null
/**
 * 渲染代数。异步加载回来时页面可能已经离开（dispose 把 refs 清空了）——
 * 那时再写 refs 就会抛 `Cannot set properties of undefined`（2026-10-19 线上）。
 * 每次 render/dispose 都 +1，加载器回来后对一下代数，对不上就安静退出。
 */
let generation = 0

function render(h) {
  generation += 1
  host = h
  host.textContent = ''
  refs = {}
  const view = el('div', { class: 'view' })
  host.appendChild(view)

  view.appendChild(el('div', { class: 'notice' }, [
    icon('alert'),
    el('div', { text: '指令文件改动对「新会话」生效；已有会话仍用旧内容。要立刻生效请用页面底部的「重建会话」。' }),
  ]))

  view.appendChild(buildFilesCard())
  view.appendChild(buildPresetsCard())
  view.appendChild(buildSessionsCard())
  // 人格预设 / 权限预设等配置项由 schema 生成表单（这一页同样不手写字段）。
  // **表单渲染失败不能连累上面三块**：卡片已经进 DOM 了，若这里抛异常，
  // 后面的加载器一行都不会跑，页面就永远停在「读取中…」（2026-10-20 线上复现）。
  try {
    form = createConfigForm({ pageKey: 'persona' })
    view.appendChild(form.node)
  } catch (error) {
    view.appendChild(el('div', { class: 'notice' }, [
      icon('alert'),
      el('div', { text: `配置表单渲染失败：${error?.message ?? String(error)}（其余区块不受影响）` }),
    ]))
  }

  void loadFileTree('')
  void loadPresets()
  void loadSessions()
}

// ── 工作区文件 ─────────────────────────────────────────────────────────────

function buildFilesCard() {
  const card = section({ title: '工作区文件', icon: 'folder', blurb: '左侧是 agent 工作区，可以编辑 AGENTS.md / MEMORY.md 这类指令文件（保存会自动备份）。' })
  const refreshBtn = button('刷新', 'small', 'refresh')
  refreshBtn.addEventListener('click', () => { resetTree(); void loadFileTree('') })
  const newBtn = button('新建文件', 'small', 'plus')
  newBtn.addEventListener('click', () => { void createFile() })
  card.node.querySelector('.cardhead')?.appendChild(el('div', { class: 'rowflex' }, [refreshBtn, newBtn]))

  const tree = el('div', { class: 'filetree', attrs: { role: 'tree', 'aria-label': '工作区文件树' } })
  refs.tree = tree

  const editorPath = el('div', { class: 'editorpath', text: '未选择文件' })
  refs.editorPath = editorPath
  const editorStatus = el('div', { class: 'editstat', text: '从左侧选择一个文件' })
  refs.editorStatus = editorStatus

  const mdToggle = button('Markdown 预览', 'small', 'eye')
  mdToggle.classList.add('off')
  mdToggle.addEventListener('click', toggleMarkdown)
  refs.mdToggle = mdToggle
  const fullscreen = button('全屏编辑', 'small', 'expand')
  fullscreen.addEventListener('click', toggleFullscreen)
  refs.fullscreen = fullscreen
  const saveBtn = button('保存', 'small primary', 'save')
  saveBtn.disabled = true
  saveBtn.addEventListener('click', () => { void saveFile() })
  refs.saveBtn = saveBtn
  const deleteBtn = button('删除', 'small danger', 'trash')
  deleteBtn.disabled = true
  deleteBtn.addEventListener('click', () => { void deleteFile() })
  refs.deleteBtn = deleteBtn

  const ta = el('textarea', { spellcheck: false, placeholder: '从左侧选择一个文件，或点「新建文件」创建。', attrs: { 'aria-label': '文件内容' } })
  ta.addEventListener('input', markDirty)
  refs.editor = ta
  const preview = el('div', { class: 'mdpreview off', attrs: { 'aria-live': 'polite' } })
  refs.preview = preview

  card.body.appendChild(el('div', { class: 'filepane' }, [
    tree,
    el('div', { class: 'editorpane' }, [
      el('div', { class: 'editortop' }, [
        el('div', { style: 'min-width:0' }, [editorPath, editorStatus]),
        el('div', { class: 'rowflex' }, [mdToggle, fullscreen, saveBtn, deleteBtn]),
      ]),
      ta,
      preview,
    ]),
  ]))
  return card.node
}

function sortEntries(list) {
  return list.slice().sort((a, b) => {
    if ((a.dir === true) !== (b.dir === true)) return a.dir === true ? -1 : 1
    return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')
  })
}

function resetTree() {
  files.children = {}
  files.expanded = {}
}

function treeEntry(entry) {
  const wrap = el('div')
  const isDir = entry.dir === true
  const btn = el('button', { class: 'tnode', type: 'button', attrs: { role: 'treeitem' } })
  if (isDir) {
    const open = files.expanded[entry.path] === true
    btn.setAttribute('aria-expanded', open ? 'true' : 'false')
    const chev = el('span', { style: `display:inline-flex;transform:rotate(${open ? 90 : 0}deg)` })
    chev.appendChild(icon('chevron', 13))
    btn.appendChild(chev)
    btn.appendChild(icon('folder'))
  } else {
    const pad = el('span', { style: 'display:inline-block;width:13px' })
    btn.appendChild(pad)
    btn.appendChild(icon('file'))
  }
  const name = el('span', { class: 'tname', text: entry.name })
  name.title = entry.path
  btn.appendChild(name)
  btn.appendChild(el('span', { class: 'tmeta', text: `${isDir ? '' : fmtBytes(entry.size)}${entry.mtime ? ` · ${fmtTime(entry.mtime)}` : ''}` }))
  if (!isDir && files.selected === entry.path) btn.classList.add('on')

  btn.addEventListener('click', () => {
    if (isDir) {
      const nowOpen = files.expanded[entry.path] !== true
      files.expanded[entry.path] = nowOpen
      if (nowOpen && files.children[entry.path] === undefined) {
        files.children[entry.path] = null
        renderTree()
        void loadFileTree(entry.path, true)
        return
      }
      renderTree()
      return
    }
    void openFile(entry.path)
  })
  wrap.appendChild(btn)

  if (isDir && files.expanded[entry.path] === true) {
    const kids = el('div', { class: 'tchildren' })
    const entries = files.children[entry.path]
    if (entries === undefined || entries === null) {
      kids.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' })]))
    } else if (entries.length === 0) {
      kids.appendChild(el('div', { class: 'tiny mute', text: '（空目录）' }))
    } else {
      for (const child of entries) kids.appendChild(treeEntry(child))
    }
    wrap.appendChild(kids)
  }
  return wrap
}

function renderTree() {
  const tree = refs.tree
  if (tree === undefined) return
  tree.textContent = ''
  const entries = files.children['']
  if (entries === undefined || entries === null) {
    tree.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '正在读取工作区…' })]))
    return
  }
  if (entries.length === 0) {
    tree.appendChild(emptyBox('工作区是空的', '点「新建文件」创建第一个文件，例如 AGENTS.md。', 'folder'))
    return
  }
  for (const entry of sortEntries(entries)) tree.appendChild(treeEntry(entry))
}

async function loadFileTree(path, silent) {
  const gen = generation
  const target = path ?? ''
  const url = `/api/files${target ? `?path=${encodeURIComponent(target)}` : ''}`
  const res = await api(url)
  if (gen !== generation) return
  if (res.status !== 200) {
    files.children[target] = []
    if (silent !== true) {
      if (refs.tree !== undefined) { refs.tree.textContent = ''; refs.tree.appendChild(emptyBox('读取工作区失败', errText(res), 'alert')) }
      toast(`读取工作区失败：${errText(res)}`, 'bad')
    } else {
      renderTree()
    }
    return
  }
  files.children[target] = Array.isArray(res.body.entries) ? res.body.entries : []
  renderTree()
}

async function openFile(path) {
  if (files.dirty && !(await typedConfirm({ title: '放弃未保存的改动？', message: `「${files.selected ?? '当前文件'}」还有未保存的改动，打开其它文件会丢弃它们。`, word: '放弃', confirmText: '放弃并打开', danger: true }))) return
  setEditorStat('读取中…', '')
  const res = await api(`/api/files/read?path=${encodeURIComponent(path)}`)
  if (res.status !== 200) {
    setEditorStat(`读取失败：${errText(res)}`, 'bad')
    toast(`读取文件失败：${errText(res)}`, 'bad')
    return
  }
  const realPath = res.body.path ?? path
  files.selected = realPath
  files.content = res.body.content ?? ''
  files.mtime = res.body.mtime
  files.truncated = res.body.truncated === true
  files.dirty = false
  state.dirty = false
  refs.editor.value = files.content
  refs.editor.classList.remove('off')
  refs.preview.classList.add('off')
  const isMd = /\.(md|markdown)$/i.test(realPath)
  refs.mdToggle.classList.toggle('off', !isMd)
  refs.saveBtn.disabled = false
  refs.deleteBtn.disabled = false
  refs.editorPath.textContent = realPath
  const bytes = res.body.bytes ?? files.content.length
  setEditorStat(`已加载 ${fmtBytes(bytes)} · 修改于 ${fmtTime(res.body.mtime)}${files.truncated ? ' · 内容过大已截断（保存会覆盖全文，谨慎）' : ''}`, files.truncated ? 'dirty' : 'ok')
  renderTree()
}

function setEditorStat(text, kind) {
  const s = refs.editorStatus
  if (s === undefined) return
  s.className = 'editstat' + (kind ? ' ' + kind : '')
  s.textContent = text ?? ''
}

function markDirty() {
  if (files.selected === null) return
  files.dirty = true
  state.dirty = true
  setEditorStat(`有未保存的改动（${fmtBytes(refs.editor.value.length)}），记得点保存`, 'dirty')
}

async function saveFile() {
  if (files.selected === null) { toast('先在左边选一个文件', 'warn'); return }
  const content = refs.editor.value
  refs.saveBtn.disabled = true
  setEditorStat('保存中…', '')
  const res = await api('/api/files/write', { method: 'POST', body: { path: files.selected, content } })
  refs.saveBtn.disabled = false
  if (res.status !== 200) {
    setEditorStat(`保存失败：${errText(res)}`, 'bad')
    toast(`保存失败：${errText(res)}`, 'bad')
    return
  }
  files.dirty = false
  state.dirty = false
  files.content = content
  setEditorStat(`已写入 ${fmtBytes(res.body.bytes)}${res.body.backup ? ` · 备份：${String(res.body.backup).split(/[\\/]/).pop()}` : ''}`, 'ok')
  toast(`已保存 ${res.body.path ?? files.selected}`, 'ok')
  void loadFileTree('')
  if (!refs.preview.classList.contains('off')) renderMarkdown()
}

async function createFile() {
  const path = await promptDialog({ title: '新建文件', label: '相对工作区的路径，例如 AGENTS.md、notes/todo.md', placeholder: 'notes/todo.md', confirmText: '创建' })
  if (path === null) return
  const clean = path.trim()
  if (clean === '') return
  const res = await api('/api/files/create', { method: 'POST', body: { path: clean, content: '' } })
  if (res.status !== 200) { toast(`新建失败：${errText(res)}`, 'bad'); return }
  const made = res.body.path ?? clean
  toast(`已创建 ${made}`, 'ok')
  resetTree()
  await loadFileTree('')
  await openFile(made)
}

async function deleteFile() {
  if (files.selected === null) return
  const ok = await typedConfirm({
    title: '删除文件？',
    message: `工作区文件「${files.selected}」会被删除（删除前自动留一份备份在 backups/）。`,
    word: '删除',
    confirmText: '删除文件',
  })
  if (!ok) return
  const res = await api(`/api/files?path=${encodeURIComponent(files.selected)}`, { method: 'DELETE' })
  if (res.status !== 200) { toast(`删除失败：${errText(res)}`, 'bad'); return }
  toast(`已删除 ${files.selected}`, 'ok')
  files.selected = null
  files.dirty = false
  state.dirty = false
  refs.editor.value = ''
  refs.editorPath.textContent = '未选择文件'
  refs.saveBtn.disabled = true
  refs.deleteBtn.disabled = true
  setEditorStat('从左侧选择一个文件', '')
  void loadFileTree('')
}

function toggleFullscreen() {
  const on = document.body.classList.toggle('editing-full')
  refs.fullscreen.textContent = ''
  refs.fullscreen.appendChild(el('span', { text: on ? '退出全屏' : '全屏编辑' }))
  if (on) { try { refs.editor.focus() } catch { /* ignore */ } }
}

function toggleMarkdown() {
  const hiding = !refs.preview.classList.contains('off')
  refs.preview.classList.toggle('off', hiding)
  refs.editor.classList.toggle('off', !hiding)
  refs.mdToggle.textContent = ''
  refs.mdToggle.appendChild(el('span', { text: hiding ? 'Markdown 预览' : '编辑源码' }))
  if (!hiding) renderMarkdown()
}

// ── Markdown（先转义再格式化，绝不注入）────────────────────────────────────

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function mdInline(s) {
  const tokens = []
  let out = esc(s)
  out = out.replace(/`([^`]+)`/g, (m, code) => { tokens.push(`<code>${code}</code>`); return `\u0001${tokens.length - 1}\u0001` })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => (/^(https?:\/\/|\/|#|\.\/|\.\.\/|mailto:)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : text))
  out = out.replace(/\u0001(\d+)\u0001/g, (m, idx) => tokens[Number(idx)] ?? '')
  return out
}

function mdToHtml(src) {
  const lines = String(src ?? '').split(/\r?\n/)
  const html = []
  let inFence = false
  let fence = []
  let listType = null
  let para = []
  let quote = []
  const flushPara = () => { if (para.length > 0) { html.push(`<p>${mdInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`); para = [] } }
  const flushList = () => { if (listType !== null) { html.push(`</${listType}>`); listType = null } }
  const flushQuote = () => { if (quote.length > 0) { html.push(`<blockquote>${mdInline(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`); quote = [] } }
  const flushAll = () => { flushPara(); flushList(); flushQuote() }
  for (const line of lines) {
    let m
    if (/^\s*```/.test(line)) {
      if (inFence) { html.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = []; inFence = false }
      else { flushAll(); inFence = true; fence = [] }
      continue
    }
    if (inFence) { fence.push(line); continue }
    if (/^\s*$/.test(line)) { flushAll(); continue }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line)) !== null) {
      flushAll()
      const lvl = Math.min(m[1].length, 4)
      html.push(`<h${lvl}>${mdInline(m[2])}</h${lvl}>`)
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); html.push('<hr>'); continue }
    if ((m = /^\s*>\s?(.*)$/.exec(line)) !== null) { flushPara(); flushList(); quote.push(m[1]); continue }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line)) !== null) {
      flushPara(); flushQuote()
      if (listType !== 'ul') { flushList(); html.push('<ul>'); listType = 'ul' }
      html.push(`<li>${mdInline(m[1])}</li>`)
      continue
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line)) !== null) {
      flushPara(); flushQuote()
      if (listType !== 'ol') { flushList(); html.push('<ol>'); listType = 'ol' }
      html.push(`<li>${mdInline(m[1])}</li>`)
      continue
    }
    flushList(); flushQuote()
    para.push(line)
  }
  if (inFence && fence.length > 0) html.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`)
  flushAll()
  return html.join('\n')
}

function renderMarkdown() {
  if (refs.preview === undefined) return
  refs.preview.innerHTML = mdToHtml(refs.editor.value)
}

// ── Agent 预设 ─────────────────────────────────────────────────────────────

function buildPresetsCard() {
  const card = section({ title: 'Agent 预设', icon: 'mask', blurb: '预设决定她的人格与可用工具集合。切换后写回插件配置，对新会话生效。' })
  const select = el('select', { attrs: { 'aria-label': '当前预设' } })
  select.disabled = true
  refs.presetSelect = select
  select.addEventListener('change', () => { void selectPreset() })
  const docBtn = button('查看预设组成', 'small', 'eye')
  docBtn.addEventListener('click', () => { void togglePresetDoc() })
  const noteBox = el('div', { class: 'inline-note' })
  refs.presetNote = noteBox
  const docBox = el('div', { class: 'off', style: 'margin-top:10px' })
  const pre = el('pre', { class: 'jsonbox' })
  refs.presetDocBody = pre
  const det = el('details', { class: 'raw', open: true })
  det.appendChild(el('summary', { text: '预设组成（YAML，只读）' }))
  const inner = el('div', { class: 'inner' })
  inner.appendChild(pre)
  det.appendChild(inner)
  docBox.appendChild(det)
  refs.presetDocBox = docBox
  card.body.appendChild(el('div', { class: 'presetrow' }, [
    el('div', {}, [el('label', { class: 'flabel', for: 'preset-select', text: '当前预设' }), select]),
    docBtn,
  ]))
  card.body.appendChild(noteBox)
  card.body.appendChild(docBox)
  return card.node
}

async function loadPresets() {
  const gen = generation
  const select = refs.presetSelect
  if (select === undefined) return
  select.disabled = true
  select.textContent = ''
  select.appendChild(el('option', { text: '读取中…' }))
  const res = await api('/api/presets')
  if (gen !== generation) return
  select.textContent = ''
  if (res.status !== 200) {
    select.appendChild(el('option', { text: '（不可用）' }))
    setNote(refs.presetNote, 'bad', `读取预设列表失败：${errText(res)}`)
    return
  }
  select.disabled = false
  const list = Array.isArray(res.body.presets) ? res.body.presets : []
  if (list.length === 0) {
    select.appendChild(el('option', { text: '（后端没有注册预设）' }))
    return
  }
  for (const preset of list) {
    const label = `${preset.id}${preset.name ? ` — ${preset.name}` : ''}${preset.broken ? '（已损坏）' : ''}`
    const option = el('option', { value: String(preset.id), text: label })
    if (preset.description) option.title = preset.description
    select.appendChild(option)
  }
  const current = String(res.body.current ?? '')
  if (current !== '') select.value = current
  setNote(refs.presetNote, '', `当前：${current || '未设置'} · 配置默认：${res.body.default ?? '—'} · 共 ${list.length} 个预设`)
}

async function selectPreset() {
  const select = refs.presetSelect
  if (select === undefined || select.value === '') return
  const id = select.value
  select.disabled = true
  setNote(refs.presetNote, '', `正在切换到 ${id}…`)
  const res = await api('/api/presets/select', { method: 'POST', body: { id } })
  select.disabled = false
  if (res.status !== 200) {
    setNote(refs.presetNote, 'bad', `切换失败：${errText(res)}`)
    toast(`切换预设失败：${errText(res)}`, 'bad')
    return
  }
  setNote(refs.presetNote, 'ok', res.body?.note ?? `已切换到 ${id}（对新会话生效）`)
  toast(`已切换到预设 ${id}，新会话生效`, 'ok')
  void loadSnapshot()
}

async function togglePresetDoc() {
  const box = refs.presetDocBox
  if (box === undefined) return
  const hiding = !box.classList.contains('off')
  box.classList.toggle('off', hiding)
  if (hiding) return
  const id = refs.presetSelect?.value ?? ''
  refs.presetDocBody.textContent = '读取中…'
  const res = await api(`/api/presets/doc${id ? `?id=${encodeURIComponent(id)}` : ''}`)
  if (res.status !== 200) { refs.presetDocBody.textContent = `读取失败：${errText(res)}`; return }
  const head = []
  if (res.body.name) head.push(`# ${res.body.name}`)
  if (res.body.description) head.push(`# ${res.body.description}`)
  if (res.body.id) head.push(`# id: ${res.body.id}`)
  refs.presetDocBody.textContent = `${head.length > 0 ? `${head.join('\n')}\n\n` : ''}${res.body.content ?? '（该预设没有可展示的内容）'}`
}

// ── 会话 ───────────────────────────────────────────────────────────────────

function buildSessionsCard() {
  const card = section({
    title: 'Agent 会话',
    icon: 'robot',
    blurb: '每个 QQ 房间（群/私聊）对应一个常驻会话。「重建会话」会丢掉上下文、按新指令文件重开——危险操作，要逐字确认。',
  })
  const refreshBtn = button('刷新', 'small', 'refresh')
  refreshBtn.addEventListener('click', () => { void loadSessions() })
  card.node.querySelector('.cardhead')?.appendChild(refreshBtn)
  const list = el('div', { class: 'sessionlist' })
  refs.sessionList = list
  card.body.appendChild(list)
  return card.node
}

async function loadSessions() {
  const gen = generation
  const list = refs.sessionList
  if (list === undefined) return
  list.textContent = ''
  list.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '正在读取会话…' })]))
  const res = await api('/api/sessions')
  if (gen !== generation) return
  list.textContent = ''
  if (res.status !== 200) { list.appendChild(emptyBox('读取会话失败', errText(res), 'alert')); return }
  const sessions = Array.isArray(res.body.sessions) ? res.body.sessions : []
  if (sessions.length === 0) {
    list.appendChild(emptyBox('还没有活动会话', '有人跟机器人说过话以后，这里会出现对应房间的会话；之后就能重建它让新指令立刻生效。', 'robot'))
    return
  }
  for (const s of sessions) {
    const card = el('div', { class: 'rowcard' })
    const head = el('div', { class: 'rowhead' })
    head.appendChild(el('div', { class: 'rid', text: `房间 ${s.room ?? '?'}` }))
    head.appendChild(pill(`${s.files ?? '?'} 个文件`, 'info'))
    card.appendChild(head)
    card.appendChild(el('div', { class: 'kv' }, [
      el('div', { class: 'kvpair' }, [el('span', { class: 'k', text: '会话 ID' }), el('span', { class: 'v mono', text: String(s.sessionId ?? '—') })]),
      el('div', { class: 'kvpair' }, [el('span', { class: 'k', text: '总大小' }), el('span', { class: 'v', text: fmtBytes(s.bytes) })]),
      el('div', { class: 'kvpair' }, [el('span', { class: 'k', text: '最后修改' }), el('span', { class: 'v', text: fmtTime(s.mtime) })]),
    ]))
    const rebuild = button('重建会话', 'small danger', 'refresh')
    rebuild.addEventListener('click', () => { void rebuildSession(s.room, rebuild) })
    card.appendChild(el('div', { class: 'rowflex', style: 'margin-top:10px' }, [rebuild]))
    list.appendChild(card)
  }
}

async function rebuildSession(room, btn) {
  const ok = await typedConfirm({
    title: `重建房间 ${room} 的会话？`,
    message: '当前上下文会丢失，并用最新的指令文件重新开会话。这个操作不可撤销（历史会移到备份目录）。',
    word: '重建',
    confirmText: '重建会话',
  })
  if (!ok) return
  btn.disabled = true
  const res = await api('/api/sessions/rebuild', { method: 'POST', body: { room: String(room) } })
  btn.disabled = false
  if (res.status !== 200) { toast(`重建失败：${errText(res)}`, 'bad'); return }
  const note = res.body?.note ?? `已重建 ${room} 的会话`
  const removed = res.body?.files !== undefined ? `（移动 ${res.body.files} 个会话文件到备份）` : ''
  toast(note + removed, 'ok', 7000)
  void loadSessions()
  void loadSnapshot()
}

function dispose() {
  generation += 1
  refs = {}
  host = null
  if (form !== null) { form.destroy(); form = null }
}

export default { render, dispose }
