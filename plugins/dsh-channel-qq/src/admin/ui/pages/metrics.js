/** 指标页（C1/C2）：回合耗时、token 用量、发送/工具失败。
 *
 * 数据来自 `metrics` 资源（metrics 子插件）；采集开关关着时页面显示"未采集"，
 * 不显示任何编造的数字。
 */

import { el } from '../dom.js'
import { state } from '../state.js'
import { kvList, section } from '../components/card.js'
import { button } from '../components/card.js'
import { navigate } from '../router.js'
import { api, errText } from '../api.js'
import { createConfigForm } from '../components/form.js'

let host = null
let form = null

const NUM = new Intl.NumberFormat('zh-CN')

function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function fmtNum(value) {
  return typeof value === 'number' && Number.isFinite(value) ? NUM.format(value) : '—'
}

function render(h) {
  host = h
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)

  const overview = section({
    title: '采集',
    icon: 'chart',
    blurb: '每个回合结束记一条：房间、耗时、token 四个桶。数据只在本机（metrics.json）。',
  })
  const box = el('div', { class: 'stack' })
  overview.body.appendChild(box)
  box.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '读取…' })]))
  view.appendChild(overview.node)

  void api('/api/resource/metrics').then((res) => {
    box.textContent = ''
    if (res.status !== 200) {
      box.appendChild(el('div', { class: 'inline-note bad', text: errText(res, '读取失败') }))
      return
    }
    const data = res.body?.data ?? res.body ?? {}
    const counters = data.counters ?? {}
    if (data.enabled !== true) {
      box.appendChild(el('div', { class: 'inline-note', text: '采集开关关着（后台「指标采集」打开后从下一回合开始记）。' }))
    }
    box.appendChild(kvList([
      ['采集', data.enabled === true ? '开' : '关'],
      ['样本', `${fmtNum(data.samples)} 条（最近 7 天窗口：${fmtNum(data.turns)} 回合）`],
      ['发送', `${fmtNum(counters.sends)} 成功 / ${fmtNum(counters.sendFailures)} 失败（本次进程）`],
      ['工具', `${fmtNum(counters.toolCalls)} 调用 / ${fmtNum(counters.toolFailures)} 失败（本次进程）`],
    ]))
    const row = el('div', { class: 'rowflex', style: 'margin-top:10px' }, [
      button('去日志页看错误聚合', 'small', 'filetext'),
    ])
    row.children[0].addEventListener('click', () => navigate('system', 'logs'))
    box.appendChild(row)
    box.appendChild(totals(data))
    box.appendChild(roomsTable(data.rooms))
    box.appendChild(daysTable(data.days))
  })

  view.appendChild(sessionsCard())
  view.appendChild(scaleCard())
  // 本页的配置项（metrics.enabled）由 schema 生成，不手写。
  form = createConfigForm({ pageKey: 'metrics' })
  view.appendChild(form.node)
}

function dispose() {
  host = null
  if (form !== null) { form.destroy(); form = null }
}

/** 近 7 天总计。 */
function totals(data) {
  const wrap = el('div', { class: 'stack', style: 'margin-top:14px' })
  wrap.appendChild(el('div', { class: 'rowflex' }, [
    el('b', { text: '近 7 天' }),
    el('span', { class: 'pill ' + (Number(data.failed) > 0 ? 'warn' : 'ok'), text: `失败 ${fmtNum(data.failed)}` }),
    el('span', { class: 'tiny mute', text: `p50 ${fmtMs(data.p50)} · p90 ${fmtMs(data.p90)}` }),
  ]))
  wrap.appendChild(kvList([
    ['输入（未缓存）', fmtNum(data.input)],
    ['输出', fmtNum(data.output)],
    ['缓存读 / 写', `${fmtNum(data.cacheRead)} / ${fmtNum(data.cacheWrite)}`],
  ]))
  return wrap
}

function roomsTable(rooms) {
  const list = Array.isArray(rooms) ? rooms : []
  const wrap = el('div', { style: 'margin-top:14px' })
  if (list.length === 0) {
    wrap.appendChild(el('div', { class: 'empty' }, [el('b', { text: '还没有回合样本' }), el('span', { text: '打开采集后聊几句就会出现。' })]))
    return wrap
  }
  const table = el('table', { class: 'table' })
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '房间' }), el('th', { text: '回合' }), el('th', { text: 'p50' }),
    el('th', { text: 'p90' }), el('th', { text: '输入/输出' }),
  ])]))
  const tbody = el('tbody')
  for (const room of list) {
    tbody.appendChild(el('tr', {}, [
      el('td', { class: 'mono tiny', text: String(room.room ?? '') }),
      el('td', { text: fmtNum(room.turns) }),
      el('td', { class: 'mono tiny', text: fmtMs(room.p50) }),
      el('td', { class: 'mono tiny', text: fmtMs(room.p90) }),
      el('td', { class: 'mono tiny', text: `${fmtNum(room.input)} / ${fmtNum(room.output)}` }),
    ]))
  }
  table.appendChild(tbody)
  wrap.appendChild(table)
  return wrap
}

function daysTable(days) {
  const list = Array.isArray(days) ? days : []
  if (list.length === 0) return el('div')
  const wrap = el('div', { style: 'margin-top:14px' })
  const table = el('table', { class: 'table' })
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '日期' }), el('th', { text: '回合' }), el('th', { text: '输入' }), el('th', { text: '输出' }),
  ])]))
  const tbody = el('tbody')
  for (const day of list) {
    tbody.appendChild(el('tr', {}, [
      el('td', { class: 'mono tiny', text: String(day.day ?? '') }),
      el('td', { text: fmtNum(day.turns) }),
      el('td', { class: 'mono tiny', text: fmtNum(day.input) }),
      el('td', { class: 'mono tiny', text: fmtNum(day.output) }),
    ]))
  }
  table.appendChild(tbody)
  wrap.appendChild(table)
  return wrap
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 一条折线（不引图表库：一个 sparkline 不值得）。 */
function sparkline(points, width = 240, height = 42) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', '会话体积曲线')
  const values = points.map((p) => p.tokens)
  const max = Math.max(...values, 1)
  if (values.length >= 2) {
    const coords = values.map((value, index) => {
      const x = (index / (values.length - 1)) * (width - 2) + 1
      const y = height - 2 - (value / max) * (height - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
    const line = document.createElementNS(SVG_NS, 'polyline')
    line.setAttribute('points', coords)
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', 'currentColor')
    line.setAttribute('stroke-width', '1.5')
    svg.appendChild(line)
  }
  return svg
}

/** 会话体积卡：当前值与曲线（数据来自 `session-size` 资源）。 */
function sessionsCard() {
  const card = section({
    title: '会话体积曲线',
    icon: 'chart',
    blurb: '看门狗每轮记一次 token；达到模型窗口 85% 会自动换血。曲线只保留最近 500 条采样。',
  })
  const box = el('div', { class: 'stack' })
  card.body.appendChild(box)
  box.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '读取…' })]))
  void api('/api/resource/session-size').then((res) => {
    box.textContent = ''
    if (res.status !== 200) { box.appendChild(el('div', { class: 'inline-note bad', text: errText(res, '读取失败') })); return }
    const rooms = Array.isArray(res.body?.data?.rooms) ? res.body.data.rooms : []
    if (rooms.length === 0) {
      box.appendChild(el('div', { class: 'empty' }, [el('b', { text: '还没有采样' }), el('span', { text: '看门狗启动后每个活跃会话每 5 分钟记一次。' })]))
      return
    }
    for (const room of rooms) {
      const pct = room.window ? Math.round((room.tokens / room.window) * 100) : null
      const row = el('div', { class: 'objrow' })
      row.appendChild(el('div', { class: 'rowflex' }, [
        el('b', { text: String(room.room) }),
        el('span', { class: 'pill ' + (pct !== null && pct >= 85 ? 'bad' : pct !== null && pct >= 60 ? 'warn' : 'ok'), text: pct === null ? '窗口未知' : `${pct}%` }),
        el('span', { class: 'tiny mute', text: `${room.tokens} / ${room.window ?? '?'} tokens · ${room.provider}/${room.model}` }),
      ]))
      row.appendChild(sparkline(Array.isArray(room.points) ? room.points : []))
      box.appendChild(row)
    }
  })
  return card.node
}

/** 当前规模（快照口径）。 */
function scaleCard() {
  const card = section({ title: '当前规模（快照口径）', icon: 'pulse' })
  const s = state.status ?? {}
  card.body.appendChild(kvList([
    ['工具数', s.tools ?? '—'],
    ['表情索引', s.emojiIndexed ?? '—'],
    ['语录', s.quotes ?? '—'],
    ['口癖', s.learnedPhrases ?? '—'],
    ['风控记录/触发', `${s.floodTracked ?? '—'} / ${s.floodTriggered ?? '—'}`],
  ]))
  return card.node
}

export default { render, dispose }
