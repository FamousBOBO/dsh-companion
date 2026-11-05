/** 配置表单渲染器（A2 的核心）：`/api/schema` 元数据 + 当前配置 → 可视化表单。
 *
 * 一条铁律（refactor-plan/10 §10"新增配置项的成本 = 改一处 schema"）：
 * **这个文件里没有任何字段名**。控件类型、标签、说明、范围、校验、隐显、热生效
 * 徽章、专用编辑器全部来自字段元数据；这里只实现"每种 kind 怎么渲染"与
 * 保存管线（脏跟踪 → 变更清单 → 提交 → 效果回执）。
 */

import { el, icon } from '../dom.js'
import { api, authLost, errText } from '../api.js'
import { state, loadSnapshot } from '../state.js'
import { button, setNote } from './card.js'
import { openDialog, typedConfirm } from './dialog.js'
import { toast } from './toast.js'
import * as model from '../model/form-model.js'

const AUTOSAVE_KEY = 'dsh_admin_autosave'

/** 标量数组的浅拷贝（值都是字符串/数字）。 */
function cloneList(list) {
  return Array.isArray(list) ? list.slice() : []
}

/** 需要逐字确认才允许保存的高危字段（值 → 确认字样）。 */
function dangerWordFor(path, value) {
  if (path === 'groupAdmin.dangerous' && value === true) return { word: '高危群管', message: '开启后，模型（其输入包含群友说的话）可以直接踢人 / 全体禁言 / 设管理员。确定要开吗？' }
  return null
}

/**
 * 构建某个页面的配置表单。
 * @param {{ pageKey: string }} opts
 * @returns `{ node, refresh, collectPatch, hasEdits, isDirty, destroy }`
 */
export function createConfigForm({ pageKey }) {
  const schema = state.schema
  const modelOfPage = model.fieldsOfPage(schema, pageKey)
  /** path → 待保存值（只记录用户真正改过的控件）。 */
  const edits = new Map()
  /** path → 行刷新器（外部配置变化后把控件值刷回最新）。 */
  const refreshers = new Map()

  const grid = el('div', { class: 'cfggrid' })
  const savebar = el('div', { class: 'savebar' })
  const savebarText = el('span', { class: 'grow' })
  let autoSave = false
  try { autoSave = localStorage.getItem(AUTOSAVE_KEY) === '1' } catch { autoSave = false }
  const autoToggle = el('input', { type: 'checkbox', checked: autoSave, id: 'cfg-autosave' })
  const autoLabel = el('label', { class: 'switch', for: 'cfg-autosave' }, [
    autoToggle, el('span', { class: 'track' }),
    el('span', { text: '自动保存' }),
  ])

  const discardBtn = button('放弃更改', 'small', 'close')
  const saveBtn = button('保存', 'small primary', 'save')
  savebar.appendChild(savebarText)
  savebar.appendChild(el('div', { class: 'rowflex' }, [autoLabel, discardBtn, saveBtn]))

  // ── 编辑跟踪 ─────────────────────────────────────────────────────────────
  function markEdit(path, value) {
    edits.set(path, value)
    updateRowState()
    syncBar()
    if (autoSave) scheduleAutoSave()
  }

  function updateRowState() {
    for (const [path, entry] of refreshers) {
      entry.markDirty(edits.has(path))
    }
  }

  function buildPatch() {
    const patch = {}
    for (const [path, value] of edits) model.setPath(patch, path, value)
    return patch
  }

  function currentValue(path) {
    return edits.has(path) ? edits.get(path) : model.getPath(state.config, path)
  }

  function collectChanges() {
    return model.buildChanges(schema, state.config ?? {}, buildPatch(), state.meta?.secretSet ?? {})
  }

  function syncBar() {
    const changes = collectChanges()
    const stats = model.summarizeChanges(changes)
    savebar.classList.toggle('on', stats.total > 0)
    savebarText.textContent = stats.total === 0
      ? ''
      : `${stats.total} 项改动${stats.restart > 0 ? ` · 其中 ${stats.restart} 项需重启插件` : ''}${stats.reload > 0 ? ` · ${stats.reload} 项会自动重载` : ''}`
    state.dirty = stats.total > 0
  }

  let autoTimer = null
  function scheduleAutoSave() {
    if (autoTimer !== null) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => { autoTimer = null; void save({ auto: true }) }, 900)
  }

  // ── 控件 ─────────────────────────────────────────────────────────────────
  const idOf = (path) => `cfg-${path.replace(/[^A-Za-z0-9]+/g, '-')}`

  function buildControl(field, row) {
    const value = currentValue(field.path)
    const id = idOf(field.path)
    const commit = (next, localError) => {
      if (localError) { setNote(row.stat, 'bad', localError); return }
      const err = model.localValidate(field, next)
      if (err !== null) { setNote(row.stat, 'bad', err); return }
      setNote(row.stat, '', '')
      row.control.classList.remove('has-error')
      markEdit(field.path, next)
    }

    if (field.kind === 'boolean') {
      const input = el('input', { type: 'checkbox', id, checked: value === true })
      const text = el('span', { text: value === true ? '已开启' : '已关闭' })
      const wrap = el('label', { class: 'switch' }, [input, el('span', { class: 'track' }), text])
      input.addEventListener('change', () => {
        text.textContent = input.checked ? '已开启' : '已关闭'
        commit(input.checked)
      })
      refreshers.set(field.path, {
        refresh: () => {
          const v = currentValue(field.path) === true
          input.checked = v
          text.textContent = v ? '已开启' : '已关闭'
        },
        markDirty: (dirty) => { wrap.classList.toggle('edited', dirty) },
        field,
      })
      return wrap
    }

    if (field.kind === 'enum') {
      const select = el('select', { id })
      const options = (field.choices ?? []).slice()
      const cur = value === null || value === undefined ? '' : String(value)
      if (cur !== '' && !options.some((c) => c.value === cur)) options.unshift({ value: cur, label: `${cur}（当前值不在选项里）` })
      for (const choice of options) select.appendChild(el('option', { value: choice.value, text: choice.label }))
      select.value = cur
      select.addEventListener('change', () => commit(select.value))
      refreshers.set(field.path, {
        refresh: () => { const v = currentValue(field.path); select.value = v === null || v === undefined ? '' : String(v) },
        markDirty: (dirty) => select.classList.toggle('edited', dirty),
        field,
      })
      return select
    }

    if (field.kind === 'number') {
      const input = el('input', { type: 'number', id })
      if (field.min !== undefined) input.min = String(field.min)
      if (field.max !== undefined) input.max = String(field.max)
      if (field.step !== undefined) input.step = String(field.step)
      input.value = value === null || value === undefined ? '' : String(value)
      input.addEventListener('change', () => {
        const next = model.parseScalar(field, input.value)
        if (next === null && !(field.allowNull === true)) { commit(next, '不能为空'); return }
        commit(next)
      })
      refreshers.set(field.path, {
        refresh: () => { const v = currentValue(field.path); input.value = v === null || v === undefined ? '' : String(v) },
        markDirty: (dirty) => input.classList.toggle('edited', dirty),
        field,
      })
      return input
    }

    if (field.kind === 'list') {
      return buildListEditor(field, commit)
    }

    if (field.kind === 'json' && Array.isArray(field.itemFields) && field.itemFields.length > 0) {
      return buildObjectRows(field, commit)
    }

    if (field.kind === 'json') {
      const ta = el('textarea', { rows: 5, spellcheck: false, id, value: model.serializeValue(field, value) })
      ta.addEventListener('change', () => {
        const parsed = model.parseJsonText(ta.value)
        if (parsed.error !== undefined) { commit(undefined, parsed.error); return }
        commit(parsed.value)
      })
      // 手写 JSON 的两个刚需：知道"现在是合法的"、以及一键排版。校验仍然只在
      // change 时做（错误落在行内的 stat 上），格式化按钮把同一份内容重排成缩进版。
      const fmt = button('格式化', 'small ghost', 'wand')
      fmt.addEventListener('click', () => {
        const parsed = model.parseJsonText(ta.value)
        if (parsed.error !== undefined) { commit(undefined, parsed.error); return }
        ta.value = JSON.stringify(parsed.value, null, 2)
        commit(parsed.value)
      })
      const wrap = el('div', {}, [ta, el('div', { class: 'rowflex', style: 'margin-top:6px' }, [fmt])])
      refreshers.set(field.path, {
        refresh: () => { ta.value = model.serializeValue(field, currentValue(field.path)) },
        markDirty: (dirty) => wrap.classList.toggle('edited', dirty),
        field,
      })
      return wrap
    }

    // string（含 secret / 路径）
    const input = el('input', {
      type: field.secret === true ? 'password' : 'text',
      id,
      autocomplete: field.secret === true ? 'new-password' : 'off',
      placeholder: field.secret === true
        ? (state.meta?.secretSet?.[field.path] === true ? '已设置（留空不改）' : '未设置')
        : (field.placeholder ?? ''),
      value: field.secret === true ? '' : (value === null || value === undefined ? '' : String(value)),
    })
    input.addEventListener('change', () => {
      if (field.secret === true && input.value === '') { setNote(row.stat, '', ''); return }
      commit(input.value)
    })
    if (field.secret === true) {
      const clearBtn = button('清除', 'small ghost', 'trash')
      clearBtn.addEventListener('click', () => {
        input.value = ''
        commit('')
        toast('已标记为清除（保存后生效）', 'warn', 2600)
      })
      const wrap = el('div', { class: 'rowflex' }, [input, clearBtn])
      refreshers.set(field.path, {
        refresh: () => { input.value = '' },
        markDirty: (dirty) => wrap.classList.toggle('edited', dirty),
        field,
      })
      return wrap
    }
    refreshers.set(field.path, {
      refresh: () => { const v = currentValue(field.path); input.value = v === null || v === undefined ? '' : String(v) },
      markDirty: (dirty) => input.classList.toggle('edited', dirty),
      field,
    })
    return input
  }

  /** 标量列表编辑器：chip 增删（Enter 添加、× 删除）。 */
  function buildListEditor(field, commit) {
    let value = Array.isArray(currentValue(field.path)) ? cloneList(currentValue(field.path)) : []
    const editor = el('div', { class: 'listeditor' })
    const input = el('input', { type: 'text', placeholder: '输入后回车添加', attrs: { 'aria-label': `${field.label}：新增一项` } })
    function paint() {
      editor.textContent = ''
      for (let i = 0; i < value.length; i += 1) {
        const chip = el('span', { class: 'listchip' })
        chip.appendChild(el('span', { text: String(value[i]) }))
        const x = el('button', { type: 'button', text: '×', attrs: { 'aria-label': `删除 ${value[i]}` } })
        x.addEventListener('click', () => { value = value.filter((_, j) => j !== i); commit([...value]); paint() })
        chip.appendChild(x)
        editor.appendChild(chip)
      }
      editor.appendChild(input)
    }
    function add() {
      const text = input.value.trim()
      if (text === '') return
      const next = field.itemsKind === 'number' ? Number(text) : text
      if (field.itemsKind === 'number' && !Number.isFinite(next)) { commit(undefined, '应为数字'); input.value = ''; return }
      if (value.some((v) => String(v) === String(next))) { input.value = ''; return }
      value = [...value, next]
      input.value = ''
      commit([...value])
      paint()
      input.focus()
    }
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add() } })
    input.addEventListener('blur', add)
    paint()
    refreshers.set(field.path, {
      refresh: () => { const v = currentValue(field.path); value = Array.isArray(v) ? cloneList(v) : []; paint() },
      markDirty: (dirty) => editor.classList.toggle('edited', dirty),
      field,
    })
    return editor
  }

  /** 对象数组行编辑器（cruises / rss.feeds / keywordReactions）：增删行、行内校验、上下移。 */
  function buildObjectRows(field, commit) {
    let rows = Array.isArray(currentValue(field.path)) ? model.cloneJson(currentValue(field.path)) : []
    const box = el('div', { class: 'objrows' })
    function commitRows() { commit(model.cloneJson(rows)) }
    function paint() {
      box.textContent = ''
      if (rows.length === 0) box.appendChild(el('div', { class: 'inline-note', text: '（空）点下面的「新增一行」添加。' }))
      rows.forEach((rowData, index) => {
        box.appendChild(buildItemRow(field, rowData, index, {
          onChanged: (nextRow) => { rows[index] = nextRow; commitRows() },
          onMove: (dir) => {
            const target = index + dir
            if (target < 0 || target >= rows.length) return
            const [item] = rows.splice(index, 1)
            rows.splice(target, 0, item)
            commitRows()
            paint()
          },
          onRemove: () => { rows.splice(index, 1); commitRows(); paint() },
        }))
      })
      const add = button('新增一行', 'small', 'plus')
      add.addEventListener('click', () => {
        const next = {}
        if (field.idKey !== undefined) next[field.idKey] = model.newRowId(field.idKey === 'id' ? (field.path.split('.')[0] ?? 'row').slice(0, 6) : 'row')
        for (const itemField of field.itemFields) {
          if (next[itemField.key] !== undefined) continue
          const v = model.itemValue(undefined, itemField)
          if (v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) next[itemField.key] = v
        }
        rows = [...rows, next]
        commitRows()
        paint()
      })
      box.appendChild(add)
    }
    function buildItemRow(fieldSpec, rowData, index, handlers) {
      const wrap = el('div', { class: 'objrow' })
      const head = el('div', { class: 'objhead' })
      const title = rowData?.[fieldSpec.idKey ?? ''] !== undefined ? String(rowData[fieldSpec.idKey]) : `第 ${index + 1} 行`
      head.appendChild(el('span', { class: 'grow', text: title }))
      const up = el('button', { class: 'iconbtn tinybtn', type: 'button', attrs: { 'aria-label': '上移' }, on: { click: () => handlers.onMove(-1) } }, icon('chevron'))
      up.style.transform = 'rotate(-90deg)'
      const down = el('button', { class: 'iconbtn tinybtn', type: 'button', attrs: { 'aria-label': '下移' }, on: { click: () => handlers.onMove(1) } }, icon('chevron'))
      down.style.transform = 'rotate(90deg)'
      const del = el('button', { class: 'iconbtn tinybtn', type: 'button', attrs: { 'aria-label': '删除这一行' }, on: { click: () => handlers.onRemove() } }, icon('trash'))
      head.appendChild(el('div', { class: 'rowbtns' }, [up, down, del]))
      wrap.appendChild(head)
      for (const itemField of fieldSpec.itemFields) {
        const current = model.itemValue(rowData, itemField)
        let control
        if (itemField.kind === 'boolean') {
          const cb = el('input', { type: 'checkbox', checked: current === true })
          const text = el('span', { text: current === true ? '启用' : '停用' })
          cb.addEventListener('change', () => {
            text.textContent = cb.checked ? '启用' : '停用'
            handlers.onChanged(model.setItemValue(rowData, itemField.key, cb.checked))
          })
          control = el('label', { class: 'switch' }, [cb, el('span', { class: 'track' }), text])
        } else if (itemField.kind === 'enum') {
          const select = el('select')
          for (const choice of itemField.choices ?? []) select.appendChild(el('option', { value: choice.value, text: choice.label }))
          select.value = String(current ?? '')
          select.addEventListener('change', () => handlers.onChanged(model.setItemValue(rowData, itemField.key, select.value)))
          control = select
        } else if (itemField.kind === 'number') {
          const num = el('input', { type: 'number' })
          if (current !== null && current !== undefined && current !== '') num.value = String(current)
          num.addEventListener('change', () => {
            const t = num.value.trim()
            handlers.onChanged(model.setItemValue(rowData, itemField.key, t === '' ? null : (Number.isFinite(Number(t)) ? Number(t) : null)))
          })
          control = num
        } else if (itemField.kind === 'list') {
          const text = el('input', { type: 'text', value: Array.isArray(current) ? current.join(', ') : String(current ?? ''), placeholder: '逗号分隔' })
          text.addEventListener('change', () => handlers.onChanged(model.setItemValue(rowData, itemField.key, model.parseListText(text.value, 'string'))))
          control = text
        } else {
          const text = el('input', { type: 'text', value: current === null || current === undefined ? '' : String(current), placeholder: itemField.placeholder ?? '' })
          text.addEventListener('change', () => handlers.onChanged(model.setItemValue(rowData, itemField.key, text.value)))
          control = text
        }
        // 行内控件没有 <label for> 可用——补一个可访问名（a11y 探针会数）。
        control.setAttribute('aria-label', itemField.label)
        const fieldLine = el('div', { class: 'objfield' }, [
          el('span', { class: 'k', text: itemField.label }),
          control,
        ])
        if (itemField.help) fieldLine.appendChild(el('span', { class: 'tiny mute', text: itemField.help }))
        wrap.appendChild(fieldLine)
      }
      return wrap
    }
    paint()
    refreshers.set(field.path, {
      refresh: () => { const v = currentValue(field.path); rows = Array.isArray(v) ? model.cloneJson(v) : []; paint() },
      markDirty: (dirty) => box.classList.toggle('edited', dirty),
      field,
    })
    return box
  }

  // ── 行与分栏 ─────────────────────────────────────────────────────────────
  function buildRow(field) {
    const row = el('div', { class: 'cfgrow', dataset: { path: field.path } })
    const labelWrap = el('label', { class: 'cfglabel', for: idOf(field.path) })
    const t = el('span', { class: 't' })
    t.appendChild(el('span', { text: field.label }))
    const hot = el('span', { class: `badge ${model.hotClass(field.hot)}`, text: model.hotLabel(field.hot) })
    hot.dataset.hot = field.hot ?? 'restart'
    t.appendChild(hot)
    if (field.dormant === true) t.appendChild(el('span', { class: 'badge dormant', text: '暂未接线' }))
    if (field.secret === true) t.appendChild(el('span', { class: 'badge secret', text: '密钥' }))
    labelWrap.appendChild(t)
    labelWrap.appendChild(el('code', { class: 'p', text: field.path }))
    if (field.help) labelWrap.appendChild(el('span', { class: 'h', text: field.help }))
    row.appendChild(labelWrap)

    const controlWrap = el('div', { class: 'cfgctl' })
    row.stat = el('span', { class: 'cfgstat' })
    const entry = { field, row, control: controlWrap, stat: row.stat }
    controlWrap.appendChild(buildControl(field, entry))
    // applyHidden 要按行切显隐，而控件在 buildControl 里注册刷新器条目时拿不到行本体；
    // 这里是所有控件种类的唯一汇聚点，统一把行回挂到已注册的条目上。
    const refresher = refreshers.get(field.path)
    if (refresher !== undefined) refresher.row = row
    // 还原默认值（字段有默认且当前值不同才有意义）。
    if (field.hasDefault === true) {
      const restore = button('还原默认', 'small ghost', 'refresh')
      restore.addEventListener('click', () => {
        const def = model.cloneJson(field.default)
        markEdit(field.path, def === undefined ? null : def)
        refreshers.get(field.path)?.refresh()
        toast(`已把「${field.label}」标记为默认值（保存后生效）`, 'warn', 2600)
      })
      restore.style.marginTop = '6px'
      controlWrap.appendChild(restore)
    }
    controlWrap.appendChild(row.stat)
    row.appendChild(controlWrap)
    return row
  }

  function rawJsonDetails(fields, title) {
    const det = el('details', { class: 'raw' })
    det.appendChild(el('summary', { text: `查看原始 JSON（${title}）` }))
    const inner = el('div', { class: 'inner' })
    const pre = el('pre', { class: 'jsonbox' })
    inner.appendChild(pre)
    det.appendChild(inner)
    const contentOf = () => {
      const out = {}
      for (const f of fields) {
        const key = f.path.split('.').pop()
        out[key] = currentValue(f.path)
      }
      try { return JSON.stringify(out, null, 1) } catch { return '（无法序列化）' }
    }
    det.addEventListener('toggle', () => { if (det.open) pre.textContent = contentOf() })
    return { node: det, refresh: () => { if (det.open) pre.textContent = contentOf() } }
  }

  function buildGroupCard(title, help, fields) {
    const card = el('section', { class: 'card' })
    if (title) {
      const head = el('div', { class: 'cardhead' })
      head.appendChild(el('h3', {}, [el('span', { text: title }), el('span', { class: 'tag', text: `${fields.length} 项` })]))
      card.appendChild(head)
    }
    if (help) card.appendChild(el('p', { class: 'blurb', text: help }))
    const normal = fields.filter((f) => f.advanced !== true)
    const advanced = fields.filter((f) => f.advanced === true)
    for (const f of normal) card.appendChild(buildRow(f))
    if (advanced.length > 0) {
      const det = el('details', { class: 'adv' })
      det.appendChild(el('summary', { text: `进阶（${advanced.length} 项）` }))
      const inner = el('div', { class: 'inner' })
      for (const f of advanced) inner.appendChild(buildRow(f))
      det.appendChild(inner)
      card.appendChild(det)
    }
    const raw = rawJsonDetails(fields, title ?? '本段')
    card.appendChild(raw.node)
    return { node: card, raw }
  }

  // ── 组装 ─────────────────────────────────────────────────────────────────
  const raws = []
  if (modelOfPage.rootFields.length > 0) {
    const built = buildGroupCard('账号与总开关', '这一页的顶层配置（机器人身份 / 开关 / 路径）。', modelOfPage.rootFields)
    grid.appendChild(built.node)
    raws.push(built.raw)
  }
  for (const group of modelOfPage.groups) {
    const built = buildGroupCard(group.label, group.help, group.fields)
    grid.appendChild(built.node)
    raws.push(built.raw)
  }
  if (modelOfPage.rootFields.length === 0 && modelOfPage.groups.length === 0) {
    grid.appendChild(el('div', { class: 'empty' }, [
      icon('info'),
      el('b', { text: '这一页没有可配置项' }),
      el('span', { text: '状态与数据段见下方卡片。' }),
    ]))
  }

  /** hiddenIf 联动：每次改动后按"当前值（含未保存编辑）"重算显隐。 */
  function applyHidden() {
    const merged = state.config ?? {}
    for (const [path, entry] of refreshers) {
      const field = entry.field
      const hidden = model.isHidden(field, merged) || model.isHidden(field, visibleValues())
      if (entry.row !== undefined) entry.row.classList.toggle('off', hidden)
    }
  }
  function visibleValues() {
    const merged = model.cloneJson(state.config ?? {})
    for (const [path, value] of edits) model.setPath(merged, path, value)
    return merged
  }

  // ── 保存管线 ─────────────────────────────────────────────────────────────
  function saveFlowChanges() {
    const changes = collectChanges()
    return new Promise((resolve) => {
      if (changes.length === 0) { resolve(false); return }
      const table = el('table', { class: 'difftable' })
      table.appendChild(el('tr', {}, [el('th', { text: '配置项' }), el('th', { text: '旧值' }), el('th', { text: '新值' }), el('th', { text: '生效' })]))
      for (const change of changes) {
        table.appendChild(el('tr', {}, [
          el('td', {}, [el('div', { text: change.label }), el('code', { class: 'tiny mute', text: change.path })]),
          el('td', { class: 'diff-old', text: change.old }),
          el('td', { class: 'diff-new', text: change.new }),
          el('td', {}, [el('span', { class: `badge ${model.hotClass(change.hot)}`, text: model.hotLabel(change.hot) })]),
        ]))
      }
      let settled = false
      openDialog({
        title: `本次修改（${changes.length} 项）`,
        body: table,
        onClose: () => { if (!settled) { settled = true; resolve(false) } },
        actions: [
          { label: '取消', run: (d) => { settled = true; resolve(false); d.close() } },
          { label: '确认保存', kind: 'primary', run: (d) => { settled = true; resolve(true); d.close() } },
        ],
      })
    })
  }

  async function commitSave() {
    const patch = buildPatch()
    if (Object.keys(patch).length === 0) return
    // 高危字段逐字确认（危险区之外的第一道闸）。
    for (const [path, value] of edits) {
      const danger = dangerWordFor(path, value)
      if (danger !== null) {
        const ok = await typedConfirm({ title: '高危改动确认', message: danger.message, word: danger.word, confirmText: '保存' })
        if (!ok) return
      }
    }
    saveBtn.disabled = true
    const res = await api('/api/config', { method: 'POST', body: { patch, baseVersion: state.configVersion, section: pageKey } })
    saveBtn.disabled = false
    if (authLost(res)) return
    if (res.status === 409) {
      toast('配置已被其他页面修改，已为你同步最新版本，请重新检查后保存', 'warn', 7000)
      await loadSnapshot()
      state.configVersion = res.body?.version ?? state.configVersion
      refresh()
      return
    }
    if (res.status !== 200) {
      toast(`保存失败：${errText(res)}`, 'bad', 8000)
      return
    }
    const note = res.body?.note ?? '已保存'
    const restart = Array.isArray(res.body?.restartRequired) ? res.body.restartRequired : []
    toast(note, restart.length > 0 ? 'warn' : 'ok', 8000)
    edits.clear()
    await loadSnapshot()
    if (typeof res.body?.version === 'number') state.configVersion = res.body.version
    refresh()
  }

  async function save(opts = {}) {
    if (opts.auto !== true) {
      const proceed = await saveFlowChanges()
      if (!proceed) return
    }
    await commitSave()
  }

  saveBtn.addEventListener('click', () => { void save() })
  discardBtn.addEventListener('click', () => { edits.clear(); refresh(); toast('已放弃未保存的改动', 'ok', 2200) })
  autoToggle.addEventListener('change', () => {
    autoSave = autoToggle.checked
    try { localStorage.setItem(AUTOSAVE_KEY, autoSave ? '1' : '0') } catch { /* ignore */ }
    toast(autoSave ? '已开启自动保存（改动约 1 秒后自动提交）' : '已关闭自动保存', 'ok', 2600)
  })

  /** 外部配置变化后：控件值与显隐全部刷新。 */
  function refresh() {
    for (const entry of refreshers.values()) {
      try { entry.refresh() } catch (error) { console.error('[admin-ui] field refresh failed', error) }
    }
    updateRowState()
    for (const raw of raws) raw.refresh()
    applyHidden()
    syncBar()
    return { collectPatch: buildPatch, changes: collectChanges() }
  }

  const node = el('div', {}, [grid, savebar])
  refresh()
  return {
    node,
    refresh,
    collectPatch: buildPatch,
    hasEdits: () => edits.size > 0,
    isDirty: () => collectChanges().length > 0,
    destroy: () => { if (autoTimer !== null) clearTimeout(autoTimer); state.dirty = false },
  }
}
