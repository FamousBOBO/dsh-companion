/** 日志视图：过滤（级别 / 模块 / 关键词）+ 实时跟随 + 错误聚合。
 *
 * 聚合沿用 `deploy/log-analyze.mjs` 的"按形态分组"思路（归一化房间号/数字/时间，
 * 计数并记首次与末次时间），客户端版本——它回答的问题和那边一样：
 * **哪些错误还在发生、哪些只是历史残留**。
 */

import { el, fmtTime } from '../dom.js'
import { button } from './card.js'

/** 级别归类：与旧面板一致（按内容判，不按前缀判——文本行没有固定前缀）。 */
export function levelOf(line) {
  if (/\b(error|failed|exception|失败)\b/i.test(line)) return 'error'
  if (/\b(warn|warning|重试|timeout|超时)\b/i.test(line)) return 'warn'
  return 'info'
}

/** 模块归类（只用于过滤，尽力而为，归不进任何一类就是"其他"）。 */
const MODULES = [
  { key: 'conn', label: '连接', re: /onebot|reconnect|dial|ws |socket|QQ link/i },
  { key: 'in', label: '入站', re: /inbound|message from|batch|攒批|inject|注入/i },
  { key: 'out', label: '出站', re: /send|outbound|flush|segment|分句|分段/i },
  { key: 'tool', label: '工具', re: /tool|qq_[a-z_]+/i },
  { key: 'event', label: '事件', re: /notice|poke|event|scheduler|cruise|提醒|巡逻/i },
  { key: 'memory', label: '记忆', re: /knowledge|memory|diary|learn|quote|口癖|记忆/i },
  { key: 'admin', label: '后台', re: /admin/i },
]

export function moduleOf(line) {
  for (const mod of MODULES) if (mod.re.test(line)) return mod.key
  return 'other'
}

export { MODULES }

/** 把一行的"形态"归一化（房间、日期、时间、数字 → 占位符）。 */
export function shapeOf(line) {
  return line
    .replace(/qq-(dm|group)-[-\d]+/g, 'qq-ROOM')
    .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
    .replace(/\d{2}:\d{2}:\d{2}(?:\.\d+)?/g, 'TIME')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
}

/** 错误聚合：形态 → { count, first, last, sample }（新→旧按次数排序）。 */
export function aggregateErrors(lines) {
  const groups = new Map()
  for (const line of lines) {
    const level = levelOf(line)
    if (level === 'info') continue
    const shape = shapeOf(line)
    let group = groups.get(shape)
    if (group === undefined) {
      group = { shape, count: 0, first: '', last: '', sample: line.trim().slice(0, 160) }
      groups.set(shape, group)
    }
    group.count += 1
    const stamp = stampOf(line)
    if (stamp !== null) {
      if (group.first === '' || stamp < group.first) group.first = stamp
      if (group.last === '' || stamp > group.last) group.last = stamp
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 14)
}

function stampOf(line) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(line)
  return m === null ? null : `${m[1]} ${m[2]}`
}

/** 旧行（以 Z 结尾的时间戳）换算成本地时间显示；新行已是本地偏移，原样保留。 */
export function formatLogLine(line) {
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{2}:\d{2})(\s*)([\s\S]*)$/.exec(line)
  if (local !== null) return `${local[1]} ${local[2]} ${local[5]}`
  const utc = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(\s*)([\s\S]*)$/.exec(line)
  if (utc === null) return line
  const d = new Date(utc[1])
  if (Number.isNaN(d.getTime())) return line
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `${stamp}${utc[2] || ' '}${utc[3]}`
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function highlight(line, keyword) {
  const safe = esc(line)
  if (keyword === '') return safe
  const safeKw = esc(keyword)
  return safe.split(safeKw).join(`<span class="hl">${safeKw}</span>`)
}

/**
 * 构建日志视图。
 * @param {{ fetchLines: () => Promise<string[]> }} opts
 * @returns 视图对象：`{ node, refresh, setLines, append, setPaused, setFilter, setKeyword, setModule }`
 */
export function createLogView({ fetchLines }) {
  const state = {
    lines: [],
    paused: false,
    level: 'all',
    module: 'all',
    keyword: '',
    showAggr: true,
  }

  // ── 工具条 ───────────────────────────────────────────────────────────────
  const levelSel = el('select', { attrs: { 'aria-label': '级别过滤' } }, [
    el('option', { value: 'all', text: '全部级别' }),
    el('option', { value: 'error', text: '仅错误' }),
    el('option', { value: 'warn', text: '错误 + 警告' }),
  ])
  const moduleSel = el('select', { attrs: { 'aria-label': '模块过滤' } }, [
    el('option', { value: 'all', text: '全部模块' }),
    ...MODULES.map((m) => el('option', { value: m.key, text: m.label })),
    el('option', { value: 'other', text: '其他' }),
  ])
  const kwInput = el('input', { type: 'search', placeholder: '关键词过滤，如 error / 群 / tts', attrs: { 'aria-label': '关键词过滤', autocomplete: 'off' } })
  const pauseBtn = button('暂停', 'small', 'pause')
  const refreshBtn = button('刷新', 'small', 'refresh')
  pauseBtn.addEventListener('click', () => { setPaused(!state.paused) })
  refreshBtn.addEventListener('click', () => { void refresh() })
  levelSel.addEventListener('change', () => { state.level = levelSel.value; paint() })
  moduleSel.addEventListener('change', () => { state.module = moduleSel.value; paint() })
  let kwTimer = null
  kwInput.addEventListener('input', () => {
    if (kwTimer !== null) clearTimeout(kwTimer)
    kwTimer = setTimeout(() => { kwTimer = null; state.keyword = kwInput.value.trim(); paint() }, 140)
  })

  const bar = el('div', { class: 'toolbar' }, [levelSel, moduleSel, el('div', { class: 'grow' }, kwInput), pauseBtn, refreshBtn])
  const body = el('pre', { class: 'logbody', attrs: { tabindex: '0', 'aria-label': '日志内容' } })
  const meta = el('div', { class: 'inline-note' })
  const aggrBox = el('div', { class: 'aggr' })
  const aggrSection = el('div', {}, [
    el('div', { class: 'between', style: 'margin:10px 0 8px' }, [
      el('h4', { text: '错误聚合（按形态分组）' }),
      el('span', { class: 'tiny mute', text: '计数 + 首次/末次出现，用来区分历史残留与仍在发生' }),
    ]),
    aggrBox,
  ])
  const node = el('div', {}, [bar, body, meta, aggrSection])

  function visibleLines() {
    let out = state.lines
    if (state.level === 'error') out = out.filter((l) => levelOf(l) === 'error')
    else if (state.level === 'warn') out = out.filter((l) => levelOf(l) !== 'info')
    if (state.module !== 'all') out = out.filter((l) => moduleOf(l) === state.module)
    if (state.keyword !== '') {
      const kw = state.keyword.toLowerCase()
      out = out.filter((l) => l.toLowerCase().includes(kw))
    }
    return out
  }

  function paint() {
    const nearBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30
    const shown = visibleLines()
    if (shown.length === 0) {
      body.textContent = state.lines.length > 0 ? '（没有匹配当前过滤条件的日志行）' : '（日志为空，或还没读到内容）'
    } else {
      const html = shown.map((line) => `<span class="logline ${levelOf(line)}">${highlight(formatLogLine(line), state.keyword)}</span>`).join('\n')
      body.innerHTML = html
    }
    meta.textContent = `共 ${state.lines.length} 行${shown.length !== state.lines.length ? `，匹配 ${shown.length} 行` : ''} · 读取于 ${fmtTime(Date.now())}${state.paused ? ' · 已暂停' : ''}`
    // 聚合只用"错误 + 警告"，且不受关键词影响（它是全局观感）。
    const errors = state.lines.filter((l) => levelOf(l) !== 'info')
    aggrBox.textContent = ''
    if (errors.length === 0) {
      aggrBox.appendChild(el('div', { class: 'inline-note ok', text: '最近这段日志里没有错误/警告行。' }))
    } else {
      for (const group of aggregateErrors(state.lines)) {
        aggrBox.appendChild(el('div', { class: 'aggrrow' }, [
          el('span', { class: 'shape', text: group.shape }),
          el('span', { class: 'when', text: `${group.count} 次 · ${group.first || '—'} → ${group.last || '—'}` }),
          el('span', { class: 'sample', text: group.sample }),
        ]))
      }
    }
    if (nearBottom || state.paused) body.scrollTop = body.scrollHeight
  }

  function setLines(lines) {
    state.lines = Array.isArray(lines) ? lines : []
    paint()
  }

  function append(lines) {
    if (state.paused || !Array.isArray(lines) || lines.length === 0) return
    state.lines = state.lines.concat(lines)
    if (state.lines.length > 4000) state.lines = state.lines.slice(-3000)
    paint()
  }

  async function refresh() {
    const lines = await fetchLines()
    if (Array.isArray(lines)) setLines(lines)
  }

  function setPaused(paused) {
    state.paused = paused === true
    pauseBtn.textContent = ''
    pauseBtn.appendChild(el('span', { text: state.paused ? '继续' : '暂停' }))
    pauseBtn.classList.toggle('primary', state.paused)
    paint()
  }

  return { node, refresh, setLines, append, setPaused, get paused() { return state.paused } }
}
