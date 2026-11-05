/** 调试页：原始快照（掩码）、强制重连、重新读取 schema、当前 SSE 状态。 */

import { el } from '../dom.js'
import { api, errText } from '../api.js'
import { state, loadSchema } from '../state.js'
import { button, kvList, section, setNote } from '../components/card.js'
import { toast } from '../components/toast.js'

let host = null

function render(h) {
  host = h
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)

  // ── 通道与动作 ──────────────────────────────────────────────────────────
  const tools = section({ title: '调试动作', icon: 'flask' })
  const note = el('div', { class: 'inline-note' })
  const reconnect = button('强制重连 OneBot', 'small', 'plug')
  reconnect.addEventListener('click', async () => {
    reconnect.disabled = true
    const res = await api('/api/action/reconnect', { method: 'POST', body: { resource: 'admin' } })
    reconnect.disabled = false
    if (res.status !== 200) { setNote(note, 'bad', `重连失败：${errText(res)}`); return }
    setNote(note, 'ok', `已触发重连：${Array.isArray(res.body?.data) ? res.body.data.join('；') : 'ok'}`)
  })
  const schemaBtn = button('重新读取 schema', 'small', 'refresh')
  schemaBtn.addEventListener('click', async () => {
    schemaBtn.disabled = true
    const res = await loadSchema()
    schemaBtn.disabled = false
    if (res.status !== 200) { setNote(note, 'bad', `schema 读取失败：${errText(res)}`); return }
    toast('已重新读取 schema（页面结构在下次进入页面时生效）', 'ok')
  })
  tools.body.appendChild(el('div', { class: 'rowflex' }, [reconnect, schemaBtn]))
  tools.body.appendChild(note)
  tools.body.appendChild(kvList([
    ['SSE 通道', state.sse === 'open' ? '已连接（实时推送）' : '重连中（已降级为轮询）'],
    ['配置版本', typeof state.meta?.configVersion === 'number' ? `v${state.meta.configVersion}` : '—'],
    ['当前路由', `#/${state.route.kind === 'overview' ? 'overview' : `${state.route.kind}/${state.route.key}`}`],
  ]))
  view.appendChild(tools.node)

  // ── 原始快照 ────────────────────────────────────────────────────────────
  const raw = section({
    title: '原始快照（掩码后）',
    icon: 'logs',
    blurb: '服务端 /api/snapshot 的原始响应；密钥类字段已掩码（只保留"是否已设置"）。',
  })
  const det = el('details', { class: 'raw' })
  det.appendChild(el('summary', { text: '展开 JSON' }))
  const inner = el('div', { class: 'inner' })
  const pre = el('pre', { class: 'jsonbox' })
  try { pre.textContent = JSON.stringify({ config: state.config, status: state.status, meta: state.meta }, null, 1) } catch { pre.textContent = '（无法序列化）' }
  inner.appendChild(pre)
  det.appendChild(inner)
  raw.body.appendChild(det)
  view.appendChild(raw.node)
}

export default { render }
