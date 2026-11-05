/** 模型供应商页：列表 · 编辑 · 删除 · 五档实测 · 一键切换默认。
 *
 * 为什么要有"实测"：2026-10-17 的真实教训——某供应商小请求 12 秒正常，600KB
 * 的大请求直接挂死；只测"能连通"会给出假阳性，换过去才发现机器人回不了话。
 * 五档按所选协议发真实请求（completions / responses / messages 形状不同）。
 *
 * 请求头：pi-ai 原生支持每供应商 `headers`；内置 CC / Codex 两个预设（值来自
 * 官方源码与开源实现，见 provider-headers.ts）。`user-agent` 由宿主保留，填了
 * 也会被覆盖——预设里因此不含它，界面上明说。
 */

import { el } from '../dom.js'
import { api, errText } from '../api.js'
import { button, emptyBox, kvList, section } from '../components/card.js'
import { toast } from '../components/toast.js'
import { openDialog } from '../components/dialog.js'

const PROTOCOLS = [
  ['openai-completions', 'OpenAI Chat Completions'],
  ['openai-responses', 'OpenAI Responses API'],
  ['anthropic-messages', 'Anthropic Messages'],
]

const fmtDur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

let host = null
let editing = null
let draftHeaders = []
/** 编辑中的模型行：{ id, contextWindow, maxTokens, vision }。 */
let draftModels = []
/** 内置模型目录（models.dev 生成，服务端随列表返回）。 */
let catalog = []

function render(h) {
  host = h
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)
  const cur = section({ title: '当前默认模型', icon: 'plug' })
  const curBox = el('div', { class: 'stack' })
  cur.body.appendChild(curBox)
  view.appendChild(cur.node)
  const list = section({ title: '供应商', icon: 'db', blurb: '读写走 dsh 原生接口（settings / agentDefaultModel / 凭据缝）——保存与切换即刻生效，不需要重启。' })
  const listBox = el('div', { class: 'stack' })
  list.body.appendChild(listBox)
  view.appendChild(list.node)
  const form = section({ title: editing === null ? '添加供应商' : `编辑「${editing.name}」`, icon: 'gear', blurb: '同名即覆盖。密钥留空表示不改；请求头整组替换。' })
  form.body.appendChild(editForm())
  view.appendChild(form.node)
  void load(curBox, listBox)
}

async function load(curBox, listBox) {
  const res = await api('/api/providers')
  curBox.textContent = ''
  listBox.textContent = ''
  if (res.status !== 200 || res.body?.ok !== true) {
    curBox.appendChild(emptyBox('供应商接口不可用', String(res.body?.note ?? res.body?.error ?? errText(res)), 'alert'))
    return
  }
  const cur = res.body.current ?? null
  curBox.appendChild(kvList([
    ['默认供应商', cur === null ? '（未设置）' : String(cur.provider)],
    ['默认模型', cur === null ? '—' : String(cur.model)],
  ]))
  catalog = Array.isArray(res.body.catalog) ? res.body.catalog : []
  const providers = Array.isArray(res.body.providers) ? res.body.providers : []
  if (providers.length === 0) {
    listBox.appendChild(emptyBox('还没有供应商', '用下面的表单添加第一个。', 'plug'))
    return
  }
  for (const provider of providers) listBox.appendChild(providerCard(provider, cur, () => void load(curBox, listBox)))
}

function providerCard(p, cur, reload) {
  const isDefault = cur !== null && String(cur.provider) === String(p.name)
  const card = el('div', { class: 'objrow' })
  const head = el('div', { class: 'objhead' })
  const title = el('div', { class: 'objtitle' })
  title.appendChild(el('strong', { text: String(p.displayName ?? p.name) }))
  title.appendChild(el('code', { class: 'tiny mute', text: String(p.name) }))
  if (isDefault) title.appendChild(el('span', { class: 'pill ok', text: '当前默认' }))
  head.appendChild(el('div', { class: 'grow' }, [title]))
  const del = button('删除', 'small danger', 'trash')
  del.addEventListener('click', async () => {
    if (!window.confirm(`删除供应商「${p.name}」？`)) return
    const res = await api(`/api/providers?name=${encodeURIComponent(p.name)}`, { method: 'DELETE' })
    if (res.status !== 200) { toast(`删除失败：${errText(res)}`, 'bad', 9000); return }
    toast(String(res.body?.note ?? '已删除'), 'ok')
    reload()
  })
  const edit = button('编辑', 'small', 'wand')
  edit.addEventListener('click', () => {
    editing = p
    draftHeaders = Object.entries(p.headers ?? {}).map(([k, v]) => ({ k, v }))
    draftModels = (p.modelDetails ?? (p.models ?? []).map((id) => ({ id }))).map((m) => ({ ...m }))
    render(host)
  })
  head.appendChild(el('div', { class: 'rowbtns' }, [edit, del]))
  card.appendChild(head)
  card.appendChild(el('div', { class: 'objmeta tiny mute', text: `${p.api} · ${p.baseURL} · 密钥 ${p.apiKeyEnv || '（未引用）'} ${p.keyConfigured ? '· 已配置' : '· 未配置'}` }))
  const hdrs = Object.keys(p.headers ?? {})
  card.appendChild(el('div', { class: 'objmeta tiny' }, [
    el('span', { class: 'mute', text: `请求头 ${hdrs.length} 个：` }),
    ...hdrs.length === 0 ? [el('span', { class: 'mute', text: '（无）' })] : hdrs.map((k) => el('span', { class: 'tag', text: k })),
  ]))
  const modelRow = el('div', { class: 'rowflex', style: 'margin-top:8px' })
  for (const m of p.models ?? []) {
    const b = button(`${isDefault && cur.model === m ? '当前：' : '设为默认：'}${m}`, 'small', 'check')
    b.disabled = isDefault && cur.model === m
    b.addEventListener('click', async () => {
      b.disabled = true
      const res = await api('/api/providers/default', { method: 'POST', body: { provider: p.name, model: m } })
      if (res.status !== 200) { toast(`切换失败：${errText(res)}`, 'bad', 9000); b.disabled = false; return }
      toast(String(res.body?.note ?? '已切换'), 'ok', 7000)
      reload()
    })
    modelRow.appendChild(b)
  }
  const testBtn = button('实测（五档）', 'small', 'flask')
  modelRow.appendChild(testBtn)
  card.appendChild(modelRow)
  const resultBox = el('div', { class: 'testout' })
  card.appendChild(resultBox)
  testBtn.addEventListener('click', () => void runTest(String(p.name), testBtn, resultBox))
  return card
}

async function runTest(name, btn, box) {
  btn.disabled = true
  box.textContent = ''
  box.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '实测中：五档依次进行，最长约 3 分钟…' })]))
  const res = await api('/api/providers/test', { method: 'POST', body: { name } })
  btn.disabled = false
  box.textContent = ''
  if (res.status !== 200) { box.appendChild(emptyBox('实测失败', errText(res), 'alert')); return }
  const report = res.body?.report
  if (report === null || report === undefined) { box.appendChild(emptyBox('没有结果', '服务器没有返回报告', 'alert')); return }
  const table = el('table', { class: 'table' })
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '档位' }), el('th', { text: '结果' }), el('th', { text: '耗时' }), el('th', { text: '说明' }),
  ])]))
  const tbody = el('tbody')
  for (const s of report.steps ?? []) {
    tbody.appendChild(el('tr', {}, [
      el('td', { text: String(s.step ?? '') }),
      el('td', {}, [el('span', { class: 'pill ' + (s.ok === true ? 'ok' : 'bad'), text: s.ok === true ? '通过' : '失败' })]),
      el('td', { class: 'mono tiny', text: fmtDur(Number(s.ms ?? 0)) }),
      el('td', { class: 'tiny mute', text: String(s.note ?? (s.httpStatus === undefined ? '' : `HTTP ${s.httpStatus}`)) }),
    ]))
  }
  table.appendChild(tbody)
  box.appendChild(el('div', { class: 'tiny mute', style: 'margin-bottom:6px', text: `协议 ${report.protocol} · 模型 ${report.model}` }))
  box.appendChild(table)
  toast(report.ok === true ? `${name}：五档全过，可以切` : `${name}：有档位没过，别切它`, report.ok === true ? 'ok' : 'bad', 9000)
}

function headerRows() {
  const wrap = el('div', { class: 'hdreditor' })
  const list = el('div', { class: 'stack' })
  const draw = () => {
    list.textContent = ''
    draftHeaders.forEach((row, i) => {
      const name = el('input', { type: 'text', placeholder: 'X-Header-Name', value: row.k })
      const value = el('input', { type: 'text', placeholder: '值', value: row.v })
      name.addEventListener('input', () => { row.k = name.value })
      value.addEventListener('input', () => { row.v = value.value })
      const rm = button('', 'small ghost', 'trash')
      rm.setAttribute('aria-label', '删除这一行')
      rm.addEventListener('click', () => { draftHeaders.splice(i, 1); draw() })
      list.appendChild(el('div', { class: 'hdrrow' }, [name, value, rm]))
    })
    if (draftHeaders.length === 0) list.appendChild(el('div', { class: 'tiny mute', text: '（没有自定义请求头）' }))
  }
  draw()
  const add = button('添加一行', 'small', 'plus')
  add.addEventListener('click', () => { draftHeaders.push({ k: '', v: '' }); draw() })
  wrap.appendChild(list)
  wrap.appendChild(el('div', { class: 'rowflex', style: 'margin-top:8px' }, [add]))
  return wrap
}

function presetBar() {
  const wrap = el('div', { class: 'rowflex', style: 'margin-top:8px' })
  const apply = async (id) => {
    const res = await api('/api/providers')
    const presets = res.body?.presets ?? []
    const preset = presets.find((p) => p.id === id)
    if (preset === undefined) { toast('预设不可用', 'bad'); return }
    const map = new Map(draftHeaders.filter((r) => r.k !== '').map((r) => [r.k.toLowerCase(), r]))
    for (const [k, v] of Object.entries(preset.headers)) map.set(k.toLowerCase(), { k, v })
    draftHeaders = [...map.values()]
    render(host)
    toast(`已套用 ${preset.label} 的请求头。${preset.note}`, 'warn', 9000)
  }
  for (const [id, label] of [['claude-code', '套用 Claude Code 头'], ['codex', '套用 Codex 头']]) {
    const b = button(label, 'small', 'download')
    b.addEventListener('click', () => void apply(id))
    wrap.appendChild(b)
  }
  wrap.appendChild(el('span', { class: 'tiny mute', text: 'user-agent 由宿主保留，填了也会被覆盖' }))
  return wrap
}

function field(label, node, hint) {
  const box = el('div', { class: 'field' }, [el('label', { class: 'flabel', text: label }), node])
  if (hint) box.appendChild(el('div', { class: 'fhint', text: hint }))
  return box
}

/** 内置目录匹配：精确优先，其次最长前缀（`...-1017` 能对上基础 id）。 */
function catalogMatch(id) {
  const wanted = String(id ?? '').trim().toLowerCase()
  if (wanted === '') return undefined
  let best
  for (const entry of catalog) {
    if (entry.id === wanted) return entry
    if (wanted.startsWith(entry.id) && (best === undefined || entry.id.length > best.id.length)) best = entry
  }
  return best
}

/** 一行模型：id + 上下文长度 + 最大输出 + 删除。 */
function modelRow(model, rerender) {
  const row = el('div', { class: 'rowflex', style: 'margin-bottom:6px' })
  const id = el('input', { placeholder: 'deepseek-v4.1-flash-1017', value: model.id ?? '', attrs: { list: 'model-catalog' }, style: 'min-width:220px' })
  const context = el('input', { type: 'number', min: '0', placeholder: '上下文', value: model.contextWindow ?? '', style: 'width:110px' })
  const output = el('input', { type: 'number', min: '0', placeholder: '最大输出', value: model.maxTokens ?? '', style: 'width:100px' })
  const vision = el('input', { type: 'checkbox', checked: model.vision === true, attrs: { 'aria-label': '支持图片输入' } })
  vision.addEventListener('change', () => { model.vision = vision.checked })
  const fill = () => {
    const hit = catalogMatch(id.value)
    if (hit === undefined) return
    if (context.value === '') context.value = String(hit.context)
    // 官方能力表说支持图片就自动勾上（可手动取消）。
    if (model.vision === undefined && hit.image === true) {
      vision.checked = true
      model.vision = true
    }
  }
  id.addEventListener('input', () => { model.id = id.value })
  id.addEventListener('blur', fill)
  context.addEventListener('input', () => {
    const n = Number(context.value)
    model.contextWindow = Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined
  })
  output.addEventListener('input', () => {
    const n = Number(output.value)
    model.maxTokens = Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined
  })
  const del = button('删除', 'small', 'trash')
  del.addEventListener('click', () => {
    const at = draftModels.indexOf(model)
    if (at >= 0) draftModels.splice(at, 1)
    rerender()
  })
  row.append(id, context, output, el('label', { class: 'tiny', title: '支持图片输入' }, [vision, el('span', { text: ' 图' })]), del)
  return row
}

/** 拉取结果选择框：先告诉用户有多少个，再由用户勾选要加哪些。 */
function pickModels(ids, have, note, onConfirm) {
  const body = el('div', { class: 'stack' })
  body.appendChild(el('div', { class: 'tiny mute', text: note }))
  const controls = el('div', { class: 'rowflex' })
  const list = el('div', {
    class: 'stack',
    style: 'max-height:320px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px',
  })
  const rows = []
  for (const id of ids) {
    const box = el('input', { type: 'checkbox' })
    if (have.has(id)) { box.checked = true; box.disabled = true }
    const label = el('label', { class: 'rowflex', style: 'gap:8px;align-items:center' }, [
      box,
      el('span', { class: 'mono tiny', text: id }),
      ...have.has(id) ? [el('span', { class: 'tiny mute', text: '（已添加）' })] : [],
    ])
    rows.push({ id, box })
    list.appendChild(label)
  }
  const selectAll = button('全选', 'small ghost')
  const clearAll = button('全不选', 'small ghost')
  selectAll.addEventListener('click', () => { for (const row of rows) if (!row.box.disabled) row.box.checked = true; refresh() })
  clearAll.addEventListener('click', () => { for (const row of rows) if (!row.box.disabled) row.box.checked = false; refresh() })
  controls.append(selectAll, clearAll)
  body.append(controls, list)

  const dlg = openDialog({
    title: `获取成功：${ids.length} 个模型`,
    body,
    actions: [
      { label: '取消', run: (d) => d.close() },
      { label: '添加选中', kind: 'primary', enabled: false, run: (d) => {
        const chosen = rows.filter((row) => row.box.checked && !row.box.disabled).map((row) => row.id)
        if (chosen.length > 0) onConfirm(chosen)
        d.close()
      } },
    ],
  })
  const addBtn = dlg.buttons[1]?.btn
  const refresh = () => {
    const count = rows.filter((row) => row.box.checked && !row.box.disabled).length
    if (addBtn !== undefined) {
      addBtn.textContent = `添加选中（${count}）`
      addBtn.disabled = count === 0
    }
  }
  for (const row of rows) row.box.addEventListener('change', refresh)
  refresh()
}

/** 模型编辑器：多行 + 目录预填 + 从网关拉取。 */
function modelEditor() {
  const box = el('div', { class: 'stack' })
  const list = el('div', { class: 'stack' })
  const datalist = el('datalist', { id: 'model-catalog' })
  for (const entry of catalog) {
    datalist.appendChild(el('option', { value: entry.id, text: `${entry.name} · ${Math.round(entry.context / 1024)}k` }))
  }
  const rerender = () => {
    list.textContent = ''
    if (draftModels.length === 0) draftModels.push({ id: '' })
    for (const model of draftModels) list.appendChild(modelRow(model, rerender))
  }
  rerender()
  const add = button('+ 添加模型', 'small', 'plus')
  add.addEventListener('click', () => { draftModels.push({ id: '' }); rerender() })
  const fillAll = button('按目录补全', 'small', 'wand')
  fillAll.addEventListener('click', () => {
    let filled = 0
    for (const model of draftModels) {
      if (model.contextWindow !== undefined) continue
      const hit = catalogMatch(model.id)
      if (hit === undefined) continue
      model.contextWindow = hit.context
      filled += 1
    }
    rerender()
    toast(filled === 0 ? '没有可补全的模型' : `已补全 ${filled} 个上下文长度`, 'ok', 4000)
  })
  const pull = button('从网关拉取', 'small', 'download')
  pull.disabled = editing === null
  pull.addEventListener('click', async () => {
    if (editing === null) return
    pull.disabled = true
    const res = await api('/api/providers/discover', { method: 'POST', body: { name: editing.name } })
    pull.disabled = false
    if (res.status !== 200) { toast(`拉取失败：${errText(res)}`, 'bad', 9000); return }
    const ids = Array.isArray(res.body?.models) ? res.body.models : []
    const have = new Set(draftModels.map((m) => m.id))
    const fresh = ids.filter((id) => !have.has(id))
    if (ids.length === 0) { toast(`${String(res.body?.note ?? '拉取成功')}，但网关没有返回模型`, 'bad', 8000); return }
    if (fresh.length === 0) { toast(`获取成功：${ids.length} 个模型，全部都已在表单里`, 'ok', 6000); return }
    pickModels(ids, have, String(res.body?.note ?? `获取成功：${ids.length} 个模型`), (chosen) => {
      for (const id of chosen) {
        const hit = catalogMatch(id)
        draftModels.push({ id, ...hit ? { contextWindow: hit.context } : {} })
      }
      rerender()
      toast(`已添加 ${chosen.length} 个模型`, 'ok', 5000)
    })
  })
  box.append(datalist, list, el('div', { class: 'rowflex' }, [add, fillAll, pull]))
  return box
}

function editForm() {
  const src = editing ?? {}
  const inputs = {}
  const mk = (key, value, placeholder, type) => {
    const input = el('input', { type: type ?? 'text', placeholder: placeholder ?? '', value: value ?? '' })
    inputs[key] = input
    return input
  }
  const name = mk('name', src.name, 'windhub')
  if (editing !== null) name.disabled = true
  const protocol = el('select')
  for (const [value, label] of PROTOCOLS) {
    const opt = el('option', { value, text: label })
    if ((src.api ?? 'openai-completions') === value) opt.selected = true
    protocol.appendChild(opt)
  }
  inputs.api = protocol
  const grid = el('div', { class: 'formgrid' })
  grid.appendChild(field('路由名', name, '小写字母 / 数字 / 连字符；保存后不可改名'))
  grid.appendChild(field('显示名', mk('displayName', src.displayName, 'windhub 网关')))
  grid.appendChild(field('协议', protocol, '按供应商实际提供的接口选'))
  grid.appendChild(field('Base URL', mk('baseURL', src.baseURL, 'https://example.com/v1'), 'Anthropic Messages 要带 /v1'))
  grid.appendChild(field('模型', modelEditor(), '上下文长度留空时按内置目录（models.dev）自动匹配；仍匹配不到就用宿主默认值。'))
  grid.appendChild(field('密钥环境变量名', mk('apiKeyEnv', src.apiKeyEnv, '留空 = NAME_API_KEY')))
  grid.appendChild(field('密钥', mk('apiKey', '', editing === null ? 'sk-…' : '留空 = 不修改', 'password'), '填了写进凭据缝'))
  const vision = el('input', { type: 'checkbox', checked: src.vision === true })
  inputs.vision = vision
  grid.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'flabel' }, [vision, el('span', { text: ' 模型支持图片输入' })]),
  ]))
  const saveBtn = button(editing === null ? '保存供应商' : '保存修改', 'primary', 'check')
  saveBtn.addEventListener('click', () => void save(inputs, saveBtn))
  const cancel = button('取消编辑', 'small ghost')
  cancel.addEventListener('click', () => { editing = null; draftHeaders = []; render(host) })
  return el('div', {}, [
    grid,
    el('div', { class: 'sep' }),
    el('div', { class: 'flabel', text: '自定义请求头' }),
    headerRows(),
    presetBar(),
    el('div', { class: 'rowflex', style: 'margin-top:14px' }, [saveBtn, editing === null ? null : cancel]),
  ])
}

async function save(inputs, btn) {
  const headers = {}
  for (const row of draftHeaders) {
    const k = row.k.trim()
    if (k !== '') headers[k] = row.v
  }
  const models = draftModels
    .map((m) => ({ ...m, id: String(m.id ?? '').trim() }))
    .filter((m) => m.id !== '')
  const body = {
    name: inputs.name.value.trim(),
    baseURL: inputs.baseURL.value.trim(),
    model: models[0]?.id ?? '',
    models,
    api: inputs.api.value,
    vision: inputs.vision.checked,
    headers,
  }
  for (const key of ['displayName', 'apiKeyEnv', 'apiKey']) {
    const value = inputs[key].value.trim()
    if (value !== '') body[key] = value
  }
  btn.disabled = true
  const res = await api('/api/providers/save', { method: 'POST', body })
  btn.disabled = false
  if (res.status !== 200) { toast(`保存失败：${errText(res)}`, 'bad', 9000); return }
  toast(String(res.body?.note ?? '已保存'), 'ok', 9000)
  editing = null
  draftHeaders = []
  render(host)
}

export default {
  render,
  refresh: () => { if (host !== null) render(host) },
  onEvent() { /* 供应商页不订阅 SSE */ },
  dispose() { host = null },
}
