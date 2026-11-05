/** 群聊与房间页：全局默认（schema 表单）+ **按群覆盖（搜索添加，只管理已加入列表）**。
 *
 * 为什么不默认列出全部群：一个号可能进了几十个群，全部铺开既看不过来也容易误改。
 * 这里改成"搜索群号/群名 → 加入管理列表 → 只对列表里的群生效"。以后有新群，
 * 搜一下加进来即可（还没进群也可以先加，等机器人进群后自动对上）。
 *
 * 存储形态是**数组**（`config.rooms = [{ id, enabled?, requireMention?, talkValue? }]`）：
 * 配置层对 json 字段是整体替换，数组能真正删除；对象形态会被静默丢掉。
 */

import { el } from '../dom.js'
import { api, errText } from '../api.js'
import { state, loadSnapshot } from '../state.js'
import { button, emptyBox, section } from '../components/card.js'
import { toast } from '../components/toast.js'
import { createModulePage } from './module.js'

const INHERIT = ''
const inherits = (v) => v === undefined || v === null

function nameOf(id) {
  const groups = Array.isArray(state.status?.groupsDetail) ? state.status.groupsDetail : []
  return groups.find((g) => g.id === id)?.name ?? ''
}

function roomRow(entry, draft, onChange) {
  const id = entry.id
  const row = el('div', { class: 'objrow' })
  const head = el('div', { class: 'objhead' })
  const name = nameOf(id)
  head.appendChild(el('div', { class: 'grow' }, [
    el('div', { class: 'objtitle' }, [
      el('strong', { text: name || `群 ${id}` }),
      el('code', { class: 'tiny mute', text: String(id) }),
      name === '' ? el('span', { class: 'pill warn', text: '不在群列表' }) : null,
    ]),
  ]))
  const remove = button('移除', 'small danger', 'trash')
  remove.addEventListener('click', () => {
    const index = draft.findIndex((r) => r.id === id)
    if (index >= 0) draft.splice(index, 1)
    onChange()
  })
  head.appendChild(el('div', { class: 'rowbtns' }, [remove]))
  row.appendChild(head)

  const controls = el('div', { class: 'formgrid', style: 'margin-top:10px' })
  const field = (label, node) => el('div', { class: 'field' }, [el('label', { class: 'flabel', text: label }), node])

  const enabled = el('select')
  for (const [value, label] of [[INHERIT, '继承全局'], ['true', '处理这个群'], ['false', '忽略这个群']]) {
    enabled.appendChild(el('option', { value, text: label, selected: inherits(entry.enabled) ? value === INHERIT : String(entry.enabled) === value }))
  }
  enabled.addEventListener('change', () => {
    entry.enabled = enabled.value === INHERIT ? null : enabled.value === 'true'
    onChange()
  })

  const mention = el('select')
  for (const [value, label] of [[INHERIT, '继承全局'], ['true', '必须 @ 才理'], ['false', '不用 @ 也说']]) {
    mention.appendChild(el('option', { value, text: label, selected: inherits(entry.requireMention) ? value === INHERIT : String(entry.requireMention) === value }))
  }
  mention.addEventListener('change', () => {
    entry.requireMention = mention.value === INHERIT ? null : mention.value === 'true'
    onChange()
  })

  const talk = el('input', {
    type: 'number', min: '0', max: '1', step: '0.05', placeholder: '继承全局',
    value: inherits(entry.talkValue) ? '' : String(entry.talkValue),
  })
  talk.addEventListener('input', () => {
    const value = talk.value.trim()
    entry.talkValue = value === '' ? null : Number(value)
    onChange()
  })

  controls.appendChild(field('是否处理', enabled))
  controls.appendChild(field('是否必须 @', mention))
  controls.appendChild(field('接话概率（0–1）', talk))
  row.appendChild(controls)
  return row
}

function roomsCard() {
  const card = section({
    title: '按群覆盖',
    icon: 'people',
    blurb: '这里只是「按群覆盖」：列表里的群用单独设置，没列的群跟上面的全局默认——它不是白名单。哪些群能触发由「安全 → 访问门控」的群策略决定（在群里就允许 / 逐群审批 / 只认名单）。',
  })
  const box = el('div', { class: 'stack' })
  card.body.appendChild(box)

  // managed 作为卡片作用域的草稿状态，避免每次 paint() 被 reset
  let managed = JSON.parse(JSON.stringify(Array.isArray(state.config?.rooms) ? state.config.rooms : []))
  let isDirty = false

  const paint = () => {
    box.textContent = ''
    const groups = Array.isArray(state.status?.groupsDetail) ? state.status.groupsDetail : []
    const note = el('div', { class: isDirty ? 'inline-note warn' : 'inline-note', text: isDirty ? '有未保存的改动' : '' })
    const saveBtn = button('保存', 'primary', 'check')
    saveBtn.disabled = !isDirty

    const onChange = () => {
      isDirty = true
      paint()
    }

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true
      const res = await api('/api/config', { method: 'POST', body: { patch: { rooms: managed }, baseVersion: state.configVersion, section: 'groups' } })
      if (res.status !== 200) { toast(`保存失败：${errText(res)}`, 'bad', 9000); saveBtn.disabled = false; return }
      toast('群覆盖已保存（下一次消息生效）', 'ok', 6000)
      isDirty = false
      await loadSnapshot()
      managed = JSON.parse(JSON.stringify(Array.isArray(state.config?.rooms) ? state.config.rooms : []))
      paint()
    })

    // ── 搜索添加 ────────────────────────────────────────────────────────────
    const searchRow = el('div', { class: 'rowflex' })
    const input = el('input', { type: 'search', placeholder: '输入群号或群名搜索…', style: 'max-width:280px' })
    const results = el('div', { class: 'stack', style: 'margin-top:8px' })
    searchRow.appendChild(input)
    box.appendChild(searchRow)
    box.appendChild(results)

    const add = (id) => {
      if (managed.some((r) => r.id === id)) { toast(`群 ${id} 已在列表里`, 'warn', 3000); return }
      managed.push({ id, enabled: null, requireMention: null, talkValue: null })
      isDirty = true
      paint()
    }

    const renderResults = () => {
      results.textContent = ''
      const q = input.value.trim().toLowerCase()
      if (q === '') return
      const hits = groups.filter((g) => String(g.id).includes(q) || String(g.name).toLowerCase().includes(q)).slice(0, 8)
      for (const g of hits) {
        const row = el('div', { class: 'rowflex' })
        row.appendChild(el('span', { class: 'grow', text: `${g.name || '（无名称）'}  ${g.id}` }))
        const btn = button('添加', 'small', 'plus')
        btn.disabled = managed.some((r) => r.id === g.id)
        btn.addEventListener('click', () => add(g.id))
        row.appendChild(btn)
        results.appendChild(row)
      }
      // 还没进群、但想先管的群：允许直接按群号添加。
      if (/^\d{5,}$/.test(q) && !groups.some((g) => String(g.id) === q)) {
        const row = el('div', { class: 'rowflex' })
        row.appendChild(el('span', { class: 'grow', text: `群 ${q}（机器人还没加入，先加也行）` }))
        const btn = button('直接添加', 'small', 'plus')
        btn.disabled = managed.some((r) => r.id === Number(q))
        btn.addEventListener('click', () => add(Number(q)))
        row.appendChild(btn)
        results.appendChild(row)
      }
      if (results.childElementCount === 0) results.appendChild(el('div', { class: 'tiny mute', text: '没有匹配的群。' }))
    }
    input.addEventListener('input', renderResults)

    // ── 管理列表 ────────────────────────────────────────────────────────────
    if (managed.length === 0) {
      box.appendChild(emptyBox('还没有管理的群', '在上面搜索群号或群名，点「添加」。', 'people'))
    } else {
      const list = el('div', { class: 'stack', style: 'margin-top:14px' })
      for (const entry of managed) list.appendChild(roomRow(entry, managed, onChange))
      box.appendChild(list)
      box.appendChild(el('div', { class: 'rowflex', style: 'margin-top:12px' }, [saveBtn, note]))
    }
  }

  paint()
  globalThis.__dshGroupsRepaint = () => {
    if (!isDirty) {
      managed = JSON.parse(JSON.stringify(Array.isArray(state.config?.rooms) ? state.config.rooms : []))
      paint()
    }
  }
  return card.node
}

const page = createModulePage('groups', { extras: () => roomsCard() })

export default {
  ...page,
  render(host) {
    page.render(host)
  },
  refresh() {
    page.refresh?.()
    globalThis.__dshGroupsRepaint?.()
  },
}
