/** 备份与恢复页：配置变更历史（最近 20 次）+ 一键回滚 + 导出 + 清空覆盖层。
 *
 * 回滚 = 把某次变更**反着走一遍**（服务端构造逆 patch，走同一条保存管线），
 * 所以它同样会进审计、同样受版本并发保护。属于危险操作：逐字确认才放行。
 */

import { el, fmtTime } from '../dom.js'
import { api, download, errText } from '../api.js'
import { state, loadSnapshot } from '../state.js'
import { button, emptyBox, kvList, pill, section } from '../components/card.js'
import { typedConfirm, confirmDialog } from '../components/dialog.js'
import { toast } from '../components/toast.js'

let host = null

function render(h) {
  host = h
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)

  // ── 概览与导出 ──────────────────────────────────────────────────────────
  const overview = section({ title: '配置的现在', icon: 'disk' })
  const meta = state.meta ?? {}
  overview.body.appendChild(kvList([
    ['覆盖层文件', meta.overrideFile ?? '（未使用）', true],
    ['已覆盖键', Array.isArray(meta.overrideKeys) && meta.overrideKeys.length > 0 ? meta.overrideKeys.join(', ') : '（无）', true],
    ['配置版本', typeof meta.configVersion === 'number' ? `v${meta.configVersion}` : '—'],
  ]))
  const exportBtn = button('导出当前配置（掩码）', 'small', 'download')
  exportBtn.addEventListener('click', () => {
    download(`channel-qq-config-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.config ?? {}, null, 1))
    toast('已导出（敏感字段为掩码值，不能直接当备份用）', 'warn', 5200)
  })
  const resetBtn = button('清空覆盖层', 'small danger', 'trash')
  resetBtn.addEventListener('click', async () => {
    const ok = await typedConfirm({
      title: '清空配置覆盖层？',
      message: '后台保存过的所有值都会被清掉；重启后回到默认值 + cordis 配置。当前进程内的值保持不变（除非重启）。',
      word: '重置',
      confirmText: '清空覆盖层',
    })
    if (!ok) return
    const res = await api('/api/config/reset', { method: 'POST', body: {} })
    if (res.status !== 200) { toast(`清空失败：${errText(res)}`, 'bad'); return }
    toast(res.body?.note ?? '已清空覆盖层', 'ok', 6500)
    await loadSnapshot()
    render(host)
  })
  overview.body.appendChild(el('div', { class: 'rowflex', style: 'margin-top:10px' }, [exportBtn, resetBtn]))
  view.appendChild(overview.node)

  // ── 变更历史 ────────────────────────────────────────────────────────────
  const history = section({
    title: '配置变更历史（最近 20 次）',
    icon: 'clock',
    blurb: '每次保存/回滚/清空一条记录，含逐项 diff。回滚会把那次变更反向应用回去。',
  })
  const listBox = el('div', { class: 'stack' })
  history.body.appendChild(listBox)
  view.appendChild(history.node)
  listBox.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '读取历史…' })]))
  void api('/api/config/history').then((res) => {
    listBox.textContent = ''
    if (res.status !== 200) { listBox.appendChild(emptyBox('读取历史失败', errText(res), 'alert')); return }
    const entries = Array.isArray(res.body.entries) ? res.body.entries : []
    if (entries.length === 0) {
      listBox.appendChild(emptyBox('还没有变更记录', '在任意模块页保存一次配置后，这里会出现第一条记录。', 'clock'))
      return
    }
    for (const entry of entries) {
      listBox.appendChild(historyRow(entry))
    }
  })
}

function historyRow(entry) {
  const row = el('div', { class: 'objrow' })
  const head = el('div', { class: 'objhead' })
  const when = Number.isFinite(Date.parse(entry.at)) ? fmtTime(Date.parse(entry.at)) : String(entry.at ?? '')
  head.appendChild(el('span', { class: 'grow', text: `v${entry.version} · ${when} · ${sourceLabel(entry.source)} · ${Array.isArray(entry.changes) ? entry.changes.length : 0} 项` }))
  const rollback = button('回滚到这次之前', 'small danger', 'refresh')
  rollback.addEventListener('click', async () => {
    const ok = await typedConfirm({
      title: `回滚配置（撤销 v${entry.version}）`,
      message: `会把这次变更反向应用：${(entry.changes ?? []).map((c) => `${c.path}`).slice(0, 6).join('、')}${(entry.changes ?? []).length > 6 ? ' 等' : ''}。回滚本身也会记进历史与审计。`,
      word: '回滚',
      confirmText: '执行回滚',
    })
    if (!ok) return
    rollback.disabled = true
    const res = await api('/api/config/rollback', { method: 'POST', body: { version: entry.version } })
    rollback.disabled = false
    if (res.status !== 200) { toast(`回滚失败：${errText(res)}`, 'bad', 8000); return }
    toast(res.body?.note ?? '已回滚', 'ok', 7000)
    await loadSnapshot()
    render(host)
  })
  head.appendChild(el('div', { class: 'rowbtns' }, [rollback]))
  row.appendChild(head)
  const det = el('details', { class: 'raw' })
  det.appendChild(el('summary', { text: '逐项 diff' }))
  const inner = el('div', { class: 'inner' })
  const table = el('table', { class: 'difftable' })
  table.appendChild(el('tr', {}, [el('th', { text: '配置项' }), el('th', { text: '旧值' }), el('th', { text: '新值' }), el('th', { text: '生效' })]))
  for (const change of entry.changes ?? []) {
    table.appendChild(el('tr', {}, [
      el('td', {}, [el('div', { text: change.label ?? change.path }), el('code', { class: 'tiny mute', text: change.path })]),
      el('td', { class: 'diff-old', text: change.old ?? '—' }),
      el('td', { class: 'diff-new', text: change.new ?? '—' }),
      el('td', {}, [hotBadge(change.hot)]),
    ]))
  }
  inner.appendChild(table)
  det.appendChild(inner)
  row.appendChild(det)
  return row
}

function hotBadge(hot) {
  const map = { live: ['live', '立即生效'], reload: ['reload', '自动重载'], restart: ['restart', '需重启插件'] }
  const [cls, label] = map[hot] ?? map.restart
  return el('span', { class: `badge ${cls}`, text: label })
}

function sourceLabel(source) {
  if (source === 'reset') return '清空覆盖层'
  if (source === 'rollback') return '回滚'
  if (source === 'internal') return '内部（预设切换等）'
  return '保存'
}

function refresh() {
  if (host !== null) render(host)
}

export default { render, refresh }
