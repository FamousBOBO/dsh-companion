/** 技能页：技能库（含待审）、新建/编辑、导入、全局设置。
 *
 * 为什么不是通用模块页：技能不是"配置里的一个数组"，而是磁盘上的目录包，
 * 每条有独立的可见范围与正文。通用表格表达不了正文编辑与范围选择，所以单写。
 *
 * 数据面（服务端 `features/skills/resource.ts`）：`/api/resource/skills`。
 */

import { el, fmtBytes, fmtTime } from '../dom.js'
import { api, errText } from '../api.js'
import { button, emptyBox, section, setNote, note, pill } from '../components/card.js'
import { openDialog } from '../components/dialog.js'
import { toast } from '../components/toast.js'
import { createConfigForm } from '../components/form.js'

const VISIBILITY_LABELS = {
  all: '所有房间',
  none: '停用',
  dm: '仅私聊',
  groups: '指定群',
  rooms: '指定房间',
}

/** 资源动作（统一走 `/api/action/<name>`）。 */
async function act(name, body = {}) {
  const res = await api(`/api/action/${name}`, { method: 'POST', body: { resource: 'skills', ...body } })
  if (res.status !== 200) throw new Error(errText(res, '操作失败'))
  return res.body?.result ?? res.body?.data ?? res.body
}

/** 一个输入行：label + 控件。 */
function field(label, control, hint) {
  const row = el('label', { class: 'cfgrow' })
  row.appendChild(el('span', { class: 'k', text: label }))
  const box = el('div', { class: 'v' })
  box.appendChild(control)
  if (hint) box.appendChild(el('div', { class: 'inline-note', text: hint }))
  row.appendChild(box)
  return row
}

function input(value, placeholder, type = 'text') {
  return el('input', { type, value: value ?? '', placeholder: placeholder ?? '', class: 'input' })
}

function textarea(value, rows = 12) {
  return el('textarea', { rows, class: 'input mono', value: value ?? '' })
}

function select(value, options) {
  const node = el('select', { class: 'input' })
  for (const [key, label] of options) {
    const option = el('option', { value: key, text: label })
    if (key === value) option.selected = true
    node.appendChild(option)
  }
  return node
}

/** 新建/编辑对话框。 */
function editDialog(entry, onDone) {
  const name = input(entry?.name ?? '', 'my-skill', 'text')
  if (entry !== undefined) name.disabled = true
  const description = input(entry?.description ?? '', '一句话说明这个技能做什么、什么时候用')
  const whenToUse = input(entry?.whenToUse ?? '', '可选：更具体的触发时机')
  const visibility = select(entry?.policy?.visibility ?? 'all', Object.entries(VISIBILITY_LABELS))
  const rooms = input((entry?.policy?.rooms ?? []).join(','), 'group-123456,dm-10001')
  const adminsOnly = el('input', { type: 'checkbox', checked: entry?.policy?.adminsOnly === true })
  const enabled = el('input', { type: 'checkbox', checked: entry?.policy?.enabled !== false })
  const allowScripts = el('input', { type: 'checkbox', checked: entry?.policy?.allowScripts === true })
  const body = textarea(entry?.body ?? '')

  const box = el('div', { class: 'stack' })
  box.appendChild(field('名字', name, '小写字母/数字/连字符；创建后不能改名。'))
  box.appendChild(field('描述', description, '会进模型目录（全局可见时），也是模型判断"该不该用"的依据。'))
  box.appendChild(field('适用时机', whenToUse))
  box.appendChild(field('可见范围', visibility))
  box.appendChild(field('房间列表', rooms, 'visibility=groups/rooms 时生效，逗号分隔：group-群号 或 dm-QQ号。'))
  box.appendChild(field('仅管理员', adminsOnly, '打开后只有管理员发起的回合能加载/触发。'))
  box.appendChild(field('启用', enabled))
  box.appendChild(field('允许脚本', allowScripts, '还需要全局设置里也允许脚本。'))
  box.appendChild(field('正文（Markdown）', body))
  const status = note('')

  const save = button('保存', 'small primary', 'save')
  save.addEventListener('click', async () => {
    save.disabled = true
    setNote(status, '', '正在保存…')
    try {
      const payload = {
        name: name.value.trim(),
        description: description.value.trim(),
        whenToUse: whenToUse.value.trim(),
        visibility: visibility.value,
        rooms: rooms.value,
        adminsOnly: adminsOnly.checked,
        enabled: enabled.checked,
        allowScripts: allowScripts.checked,
        body: body.value,
      }
      const res = await api('/api/resource/skills', { method: 'POST', body: payload })
      if (res.status !== 200) throw new Error(errText(res, '保存失败'))
      toast('已保存', 'ok', 3000)
      dialog.close()
      onDone()
    } catch (error) {
      setNote(status, 'bad', error.message)
    } finally {
      save.disabled = false
    }
  })
  box.appendChild(status)
  const dialog = openDialog({ title: entry === undefined ? '新建技能' : `编辑 ${entry.name}`, body: box, actions: [save] })
  return dialog
}

/** 导入对话框：URL 或粘贴 SKILL.md。 */
function importDialog(onDone) {
  const url = input('', 'https://raw.githubusercontent.com/…/SKILL.md')
  const pasted = textarea('', 14)
  const status = note('')
  const run = button('导入到待审区', 'small primary', 'download')
  run.addEventListener('click', async () => {
    run.disabled = true
    setNote(status, '', '正在导入…')
    try {
      if (url.value.trim() !== '') {
        await act('importUrl', { url: url.value.trim() })
      } else if (pasted.value.trim() !== '') {
        const res = await api('/api/resource/skills', {
          method: 'POST',
          body: { files: [{ path: 'SKILL.md', content: pasted.value }] },
        })
        if (res.status !== 200) throw new Error(errText(res, '导入失败'))
      } else {
        throw new Error('填一个链接，或粘贴 SKILL.md 全文')
      }
      toast('已导入到待审区；确认后点「启用」', 'ok', 4000)
      dialog.close()
      onDone()
    } catch (error) {
      setNote(status, 'bad', error.message)
    } finally {
      run.disabled = false
    }
  })
  const box = el('div', { class: 'stack' })
  box.appendChild(field('从链接导入', url, 'SKILL.md 直链，或 GitHub 目录（…/tree/<ref>/<path>）；blob 链接会自动换成 raw。'))
  box.appendChild(field('或粘贴内容', pasted, '必须是带 frontmatter 的完整 SKILL.md。'))
  box.appendChild(status)
  const dialog = openDialog({ title: '导入技能', body: box, actions: [run] })
  return dialog
}

/** 一行技能。 */
function skillRow(entry, reload) {
  const card = el('div', { class: 'objrow' })
  const head = el('div', { class: 'rowflex' })
  head.appendChild(el('b', { text: entry.name }))
  if (entry.staged) head.appendChild(pill('待审', 'info'))
  if (entry.error !== '') head.appendChild(pill('坏文件', 'bad'))
  else head.appendChild(pill(entry.policy?.enabled === false ? '已停用' : '启用', entry.policy?.enabled === false ? 'bad' : 'ok'))
  head.appendChild(pill(VISIBILITY_LABELS[entry.policy?.visibility ?? 'all'] ?? '—', 'info'))
  if (entry.policy?.adminsOnly) head.appendChild(pill('仅管理员', 'info'))
  if (Array.isArray(entry.scripts) && entry.scripts.length > 0) head.appendChild(pill(`脚本 ${entry.scripts.length}`, 'info'))
  if (entry.uses) head.appendChild(pill(`用 ${entry.uses.loads + entry.uses.triggers} 次`, 'info'))
  card.appendChild(head)

  if (entry.error !== '') card.appendChild(el('div', { class: 'inline-note', text: `解析失败：${entry.error}` }))
  else card.appendChild(el('p', { class: 'blurb', text: entry.description }))
  card.appendChild(el('div', { class: 'inline-note', text: `${entry.path} · ${fmtBytes(entry.bytes)} · ${fmtTime(entry.mtime)}` }))

  const row = el('div', { class: 'rowflex', style: 'margin-top:8px' })
  if (entry.staged) {
    const promote = button('启用', 'small primary', 'check')
    promote.addEventListener('click', async () => {
      try { await act('promote', { name: entry.name }); toast('已启用', 'ok', 3000); reload() } catch (e) { toast(e.message, 'bad', 6000) }
    })
    const discard = button('丢弃', 'small', 'trash')
    discard.addEventListener('click', async () => {
      try { await act('discard', { name: entry.name }); toast('已丢弃', 'ok', 3000); reload() } catch (e) { toast(e.message, 'bad', 6000) }
    })
    row.appendChild(promote)
    row.appendChild(discard)
  } else {
    const view = button('查看', 'small', 'eye')
    view.addEventListener('click', async () => {
      try {
        const data = await act('read', { name: entry.name })
        const pre = el('pre', { class: 'mono', style: 'white-space:pre-wrap;max-height:50vh;overflow:auto', text: data.body })
        openDialog({ title: `${entry.name} · 正文`, body: pre })
      } catch (e) { toast(e.message, 'bad', 6000) }
    })
    const edit = button('编辑', 'small', 'save')
    edit.addEventListener('click', async () => {
      try {
        const data = await act('read', { name: entry.name })
        editDialog({ ...entry, body: data.body }, reload)
      } catch (e) { toast(e.message, 'bad', 6000) }
    })
    const toggle = button(entry.policy?.enabled === false ? '启用' : '停用', 'small', 'pause')
    toggle.addEventListener('click', async () => {
      try { await act('toggle', { name: entry.name, enabled: entry.policy?.enabled === false }); reload() } catch (e) { toast(e.message, 'bad', 6000) }
    })
    const del = button('删除', 'small', 'trash')
    del.addEventListener('click', async () => {
      if (!window.confirm(`确定删除技能 ${entry.name}？`)) return
      try {
        const res = await api(`/api/resource/skills?id=${encodeURIComponent(entry.name)}`, { method: 'DELETE' })
        if (res.status !== 200) throw new Error(errText(res, '删除失败'))
        toast('已删除', 'ok', 3000)
        reload()
      } catch (e) { toast(e.message, 'bad', 6000) }
    })
    row.append(view, edit, toggle, del)
  }
  card.appendChild(row)
  return card
}

/** 页面对象。 */
let activeForm = null

export const skillsPage = {
  render(host) {
    host.textContent = ''
    const createBtn = button('新建', 'small primary', 'plus')
    const importBtn = button('导入', 'small', 'download')
    const listCard = section({
      title: '技能库',
      icon: 'book',
      blurb: '每条技能的可见范围在加载/触发时现算，改完下一回合生效。',
      actions: [importBtn, createBtn],
    })
    host.appendChild(listCard.node)
    const status = note('')
    listCard.body.appendChild(status)

    const reload = async () => {
      setNote(status, '', '正在读取…')
      const res = await api('/api/resource/skills')
      if (res.status !== 200) { setNote(status, 'bad', errText(res, '读取失败')); return }
      const data = res.body?.data ?? {}
      listCard.body.textContent = ''
      listCard.body.appendChild(status)
      const rows = Array.isArray(data.skills) ? data.skills : []
      if (rows.length === 0) {
        listCard.body.appendChild(emptyBox('还没有技能。点「新建」写一个，或「导入」一个现成的。'))
      } else {
        for (const entry of rows) listCard.body.appendChild(skillRow(entry, reload))
      }
      setNote(status, '', `${rows.length} 条 · 仓库 ${data.root}`)
    }
    createBtn.addEventListener('click', () => editDialog(undefined, reload))
    importBtn.addEventListener('click', () => importDialog(reload))

    const configCard = section({ title: '设置', icon: 'gear' })
    const form = createConfigForm({ pageKey: 'skills' })
    activeForm = form
    configCard.body.appendChild(form.node)
    host.appendChild(configCard.node)
    void reload()
  },
  dispose() {
    activeForm?.destroy()
    activeForm = null
  },
}

export default skillsPage
