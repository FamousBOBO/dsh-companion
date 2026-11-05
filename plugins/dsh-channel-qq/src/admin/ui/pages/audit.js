/** 审计页：所有写操作（谁、何时、改了什么、结果），可过滤、可导出。 */

import { el, fmtTime } from '../dom.js'
import { api, download, errText } from '../api.js'
import { button, emptyBox, pill, section } from '../components/card.js'
import { toast } from '../components/toast.js'

let host = null
let entries = []
let filter = ''

function render(h) {
  host = h
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)

  const card = section({
    title: '审计日志',
    icon: 'shieldcheck',
    blurb: '每一次写操作一条记录（配置保存 / 重置 / 回滚、文件写删、资源增删、会话重建、登录成败……），落盘在 channel-qq/audit.jsonl。',
  })
  const kw = el('input', { type: 'search', placeholder: '过滤：动作 / 摘要 / IP', attrs: { 'aria-label': '过滤审计记录', autocomplete: 'off' } })
  let kwTimer = null
  kw.addEventListener('input', () => {
    if (kwTimer !== null) clearTimeout(kwTimer)
    kwTimer = setTimeout(() => { kwTimer = null; filter = kw.value.trim().toLowerCase(); paint(list) }, 140)
  })
  const refreshBtn = button('刷新', 'small', 'refresh')
  refreshBtn.addEventListener('click', () => { refreshBtn.disabled = true; void load().finally(() => { refreshBtn.disabled = false }) })
  const exportBtn = button('导出 JSON', 'small', 'download')
  exportBtn.addEventListener('click', () => {
    download(`audit-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(entries, null, 1))
    toast('已导出当前页的审计记录', 'ok')
  })
  card.body.appendChild(el('div', { class: 'toolbar', style: 'margin-bottom:10px' }, [
    el('div', { class: 'grow' }, kw), refreshBtn, exportBtn,
  ]))
  const list = el('div', { class: 'stack' })
  card.body.appendChild(list)
  view.appendChild(card.node)
  void load()
}

async function load() {
  const res = await api('/api/audit?lines=300')
  if (res.status !== 200) {
    paintError(errText(res))
    return
  }
  entries = Array.isArray(res.body.entries) ? res.body.entries : []
  paint()
}

function paintError(message) {
  const list = document.querySelector('.cardbody .stack')
  if (list === null) return
  list.textContent = ''
  list.appendChild(emptyBox('读取审计失败', message, 'alert'))
}

function paint() {
  const list = host?.querySelector('.cardbody .stack')
  if (list === null || list === undefined) return
  list.textContent = ''
  const filtered = filter === ''
    ? entries
    : entries.filter((e) => `${e.action} ${e.summary} ${e.ip} ${e.path}`.toLowerCase().includes(filter))
  if (filtered.length === 0) {
    list.appendChild(emptyBox(entries.length === 0 ? '还没有审计记录' : '没有匹配的记录', entries.length === 0 ? '第一次写操作（保存配置、写文件……）之后这里会出现记录。' : '换个关键词试试。', 'shieldcheck'))
    return
  }
  for (const entry of filtered) {
    const when = Number.isFinite(Date.parse(entry.ts)) ? fmtTime(Date.parse(entry.ts)) : entry.ts
    const row = el('div', { class: 'aggrrow' }, [
      el('span', { class: 'shape' }, [
        el('span', { class: 'tag', text: entry.action }),
        el('span', { text: ` ${entry.summary}` }),
      ]),
      el('span', { class: 'when', text: `${when}${entry.ip ? ` · ${entry.ip}` : ''}` }),
      el('span', { class: 'sample' }, [
        el('span', { class: 'mono tiny mute', text: `${entry.method} ${entry.path}` }),
        el('span', { text: ' ' }),
        pill(entry.result === 'error' ? '失败' : '成功', entry.result === 'error' ? 'bad' : 'ok'),
      ]),
    ])
    list.appendChild(row)
  }
}

function refresh() {
  return load()
}

export default { render, refresh }
