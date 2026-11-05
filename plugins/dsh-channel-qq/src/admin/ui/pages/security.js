/** 安全页：密码与会话（改密 + 撤销全部会话）、危险能力一览、监听地址。
 *
 * 改密的语义（spec §8）：改密码即撤销**全部**会话——包括当前这个，所以成功后
 * 回到登录页重登。口令由环境变量管理时（scrypt 哈希 / 明文 env），后台不接管
 * 修改，只做说明。
 */

import { el } from '../dom.js'
import { api, authLost, errText, setToken } from '../api.js'
import { state } from '../state.js'
import { button, kvList, pill, section, setNote } from '../components/card.js'
import { createConfigForm } from '../components/form.js'
import { toast } from '../components/toast.js'

let host = null
let info = null
let form = null

function render(h) {
  host = h
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)
  const loading = el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '读取安全信息…' })])
  view.appendChild(loading)
  void api('/api/security').then((res) => {
    view.textContent = ''
    if (res.status !== 200) {
      view.appendChild(el('div', { class: 'notice' }, [el('span', { text: `读取安全信息失败：${errText(res)}` })]))
      return
    }
    info = res.body
    paint(view)
  })
}

/** 访问门控：待批请求 + 已批准名单（pairing / allowlist / open）。 */
function accessCard() {
  const card = section({
    title: '访问请求',
    icon: 'shield',
    blurb: 'pairing 模式下陌生人/未批准的群先申请；批准后消息才会进 agent。',
  })
  const box = el('div', { class: 'stack' })
  card.body.appendChild(box)
  const note = el('div', { class: 'inline-note' })
  box.appendChild(note)

  const act = async (name, kind, id) => {
    const res = await api(`/api/action/${name}`, { method: 'POST', body: { resource: 'access', kind, id } })
    if (res.status !== 200) { setNote(note, 'bad', errText(res, '操作失败')); return }
    setNote(note, 'ok', name === 'approve' ? '已批准，并已通知对方。' : '已拒绝。')
    await draw()
  }

  const draw = async () => {
    const res = await api('/api/resource/access')
    box.querySelectorAll('.access-row').forEach((node) => node.remove())
    if (res.status !== 200) { setNote(note, 'bad', errText(res, '读取失败')); return }
    const data = res.body?.data ?? {}
    const pending = Array.isArray(data.pending) ? data.pending : []
    const mode = String(data.mode ?? 'pairing')
    const groupPolicy = String(data.groupPolicy ?? 'pairing')
    const groupLabel = groupPolicy === 'member' ? '在群里就允许' : groupPolicy === 'allowlist' ? '只认群名单' : '逐群审批'
    const header = el('div', { class: 'rowflex access-row' }, [
      el('b', { text: '模式' }),
      pill(mode === 'pairing' ? '配对审批' : mode === 'allowlist' ? '仅白名单' : '全部放行', mode === 'open' ? 'bad' : 'ok'),
      el('span', { class: 'tiny mute', text: `群：${groupLabel} · 已批准 ${Array.isArray(data.users) ? data.users.length : 0} 人 / ${Array.isArray(data.groups) ? data.groups.length : 0} 群` }),
    ])
    box.appendChild(header)
    if (pending.length === 0) {
      box.appendChild(el('div', { class: 'empty access-row' }, [el('b', { text: '没有待批请求' }), el('span', { text: '陌生人私聊或未批准的群 @ 她会出现在这里。' })]))
    }
    for (const item of pending) {
      const kind = item.kind === 'group' ? 'group' : 'user'
      const ok = button('批准', 'small primary', 'check')
      const no = button('拒绝', 'small ghost', 'close')
      ok.addEventListener('click', () => { void act('approve', kind, Number(item.id)) })
      no.addEventListener('click', () => { void act('reject', kind, Number(item.id)) })
      box.appendChild(el('div', { class: 'objrow access-row' }, [
        el('div', { class: 'rowflex' }, [
          pill(kind === 'group' ? '群' : '私聊', 'info'),
          el('b', { class: 'mono', text: String(item.id ?? '') }),
          el('span', { class: 'tiny mute', text: String(item.name ?? '') }),
          ok,
          no,
        ]),
      ]))
    }
    if (Array.isArray(data.users) && data.users.length > 0) {
      box.appendChild(el('div', { class: 'tiny mute access-row', text: `已批准的人：${data.users.join('、')}` }))
    }
    if (Array.isArray(data.groups) && data.groups.length > 0) {
      box.appendChild(el('div', { class: 'tiny mute access-row', text: `已批准的群：${data.groups.join('、')}` }))
    }
  }

  void draw()
  return card.node
}

function paint(view) {
  const pw = info?.password ?? {}

  // ── 密码 ────────────────────────────────────────────────────────────────
  const pwCard = section({ title: '密码', icon: 'lock' })
  pwCard.body.appendChild(el('p', { class: 'blurb', text: `当前来源：${pw.label ?? '未知'}。` }))
  if (pw.canChange === true) {
    const mk = (label, id) => {
      const input = el('input', { type: 'password', id, autocomplete: 'new-password' })
      const wrap = el('div', { class: 'field' }, [el('label', { class: 'flabel', for: id, text: label }), input])
      return { wrap, input }
    }
    const current = mk('当前密码', 'pw-current')
    const next = mk('新密码（至少 12 位）', 'pw-next')
    const again = mk('再输一次新密码', 'pw-again')
    const note = el('div', { class: 'inline-note' })
    const btn = button('改密码（并撤销全部会话）', 'primary', 'save')
    btn.addEventListener('click', async () => {
      if (next.input.value.length < 12) { setNote(note, 'bad', '新密码至少 12 位'); return }
      if (next.input.value !== again.input.value) { setNote(note, 'bad', '两次输入的新密码不一致'); return }
      btn.disabled = true
      const res = await api('/api/password', { method: 'POST', body: { current: current.input.value, next: next.input.value } })
      btn.disabled = false
      if (res.status !== 200) { setNote(note, 'bad', `改密失败：${errText(res)}`); return }
      setNote(note, 'ok', '已修改并撤销全部会话，即将回到登录页…')
      toast('密码已修改，全部会话已撤销', 'ok', 5000)
      setTimeout(() => { setToken(''); location.reload() }, 1200)
    })
    pwCard.body.appendChild(el('div', { class: 'stack' }, [current.wrap, next.wrap, again.wrap, el('div', { class: 'rowflex' }, [btn]), note]))
  } else {
    pwCard.body.appendChild(el('div', { class: 'notice' }, [
      el('div', { text: `口令当前${pw.label ?? '由外部管理'}。要修改请改环境变量（CHANNEL_QQ_ADMIN_PASSWORD_HASH 为 scrypt 哈希，推荐）后重启 dsh——后台刻意不接管它。` }),
    ]))
  }
  view.appendChild(pwCard.node)
  view.appendChild(accessCard())

  // ── 会话与监听 ──────────────────────────────────────────────────────────
  const sessCard = section({ title: '会话与监听', icon: 'key' })
  sessCard.body.appendChild(kvList([
    ['登录会话数', info?.sessions ?? '—'],
    ['监听地址', info?.bound === null || info?.bound === undefined ? '（未监听）' : `${info.bound.host}:${info.bound.port}`, true],
  ]))
  const revokeAll = button('撤销全部会话', 'small danger', 'close')
  revokeAll.addEventListener('click', async () => {
    revokeAll.disabled = true
    const res = await api('/api/logout-all', { method: 'POST', body: {} })
    revokeAll.disabled = false
    if (authLost(res) || res.status === 200) {
      toast('全部会话已撤销，请重新登录', 'ok')
      setToken('')
      setTimeout(() => location.reload(), 900)
      return
    }
    toast(`撤销失败：${errText(res)}`, 'bad')
  })
  sessCard.body.appendChild(el('div', { class: 'rowflex', style: 'margin-top:10px' }, [revokeAll,
    el('span', { class: 'tiny mute', text: '改密码本来就会撤销全部会话；这个按钮单独用来踢掉其他设备。' })]))
  view.appendChild(sessCard.node)

  // ── 危险能力 ────────────────────────────────────────────────────────────
  const flags = info?.flags ?? {}
  const danger = section({
    title: '危险能力开关（只读一览，改动去对应页）',
    icon: 'shield',
    blurb: '这些是"会影响服务器或群成员"的开关。默认关；开启需要显式操作且在保存时二次确认。',
  })
  const rows = [
    ['高危群管动作（踢人/全体禁言/设管理员）', flags.groupAdminDangerous === true, '工具与策略页 · groupAdmin.dangerous'],
    ['巡航任务编辑（等于远程执行代码）', flags.allowCruiseEdits === true, '环境变量 CHANNEL_QQ_ADMIN_ALLOW_CRUISE_EDITS'],
    ['后台监听公网', flags.allowRemote === true, '环境变量 CHANNEL_QQ_ADMIN_ALLOW_REMOTE'],
  ]
  for (const [label, on, where] of rows) {
    const row = el('div', { class: 'dangerrow' }, [
      el('div', {}, [el('div', { text: label }), el('div', { class: 'tiny mute', text: where })]),
      pill(on ? '已开启' : '关闭', on ? 'bad' : 'ok'),
    ])
    danger.body.appendChild(row)
  }
  view.appendChild(danger.node)

  // ── 监听与口令等配置（schema 驱动；affectionPort / admin.* 都落在这一页）──
  if (form === null) form = createConfigForm({ pageKey: 'security' })
  if (form.node.parentNode === null) view.appendChild(form.node)
  else form.refresh()
}

function refresh() {
  if (host !== null) render(host)
}

function dispose() {
  if (form !== null) { form.destroy(); form = null }
  host = null
}

export default { render, refresh, dispose }
