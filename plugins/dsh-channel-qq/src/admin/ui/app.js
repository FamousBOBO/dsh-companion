/** 外壳：登录、hash 路由、侧栏/抽屉、主题、⌘K 面板、SSE 接线、页面徽章。
 *
 * 页面渲染是「取 state → 建 DOM」的纯流程；这个文件负责把"什么时候渲染、
 * 来了什么事件"讲清楚——所有页面模块只认识自己的 `render/refresh/onEvent/dispose`。
 */

import { el, icon } from './dom.js'
import { api, errText, getToken, setToken } from './api.js'
import { state, setSse, loadSchema, loadSnapshot } from './state.js'
import { startSse } from './sse.js'
import { parseRoute, resolvePage } from './router.js'
import { pageFor } from './pages/index.js'
import { toast } from './components/toast.js'
import { button } from './components/card.js'
import { openDialog } from './components/dialog.js'

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel))

let current = null
let sse = null
let pollTimer = null

// ── 全局兜底：绝不白屏 ─────────────────────────────────────────────────────

function showError(text, detail) {
  const bar = $('#errbar')
  const t = $('#errtext')
  const d = $('#errdetail')
  if (t !== null) t.textContent = text ?? '页面出错'
  if (d !== null) d.textContent = detail === undefined || detail === null ? '' : String(detail).slice(0, 300)
  if (bar !== null) bar.classList.add('show')
  try { console.error('[admin-ui]', text, detail) } catch { /* ignore */ }
}

window.addEventListener('error', (e) => { showError(`页面脚本出错：${e.message ?? ''}`, `@${e.lineno ?? 0}:${e.colno ?? 0}`) })
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  showError(`异步任务出错：${r?.message ?? String(r)}`, r?.stack ? String(r.stack).split('\n')[1] : '')
})
$('#errbar-close')?.addEventListener('click', () => $('#errbar')?.classList.remove('show'))

// ── 主题（跟随系统 + 手动：system → light → dark）─────────────────────────

const THEME_KEY = 'dsh_admin_theme'
const THEME_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' }

function themePref() {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* ignore */ }
  return 'system'
}

function applyTheme(pref) {
  const resolved = pref === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : pref
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.setAttribute('data-theme-pref', pref)
  try { localStorage.setItem(THEME_KEY, pref) } catch { /* ignore */ }
  const btn = $('#themebtn')
  if (btn !== null) {
    const next = pref === 'system' ? '浅色' : pref === 'light' ? '深色' : '跟随系统'
    btn.setAttribute('title', `主题：${THEME_LABELS[pref]}（点击切到${next}）`)
    btn.setAttribute('aria-label', `切换主题（当前${THEME_LABELS[pref]}，点击切到${next}）`)
  }
}

function cycleTheme() {
  const order = ['system', 'light', 'dark']
  const next = order[(order.indexOf(themePref()) + 1) % order.length]
  applyTheme(next)
  toast(`主题：${THEME_LABELS[next]}`, 'ok', 1600)
}

window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if (themePref() === 'system') applyTheme('system')
})

// ── 登录 ───────────────────────────────────────────────────────────────────

function showLogin(message) {
  $('#login')?.classList.remove('off')
  $('#app')?.classList.add('off')
  if (message) setLoginMsg(message, 'bad')
  setTimeout(() => { try { $('#pw')?.focus() } catch { /* ignore */ } }, 60)
}

function showApp() {
  $('#login')?.classList.add('off')
  $('#app')?.classList.remove('off')
}

function setLoginMsg(text, kind) {
  const m = $('#loginmsg')
  if (m === null) return
  m.textContent = text ?? ''
  m.className = `loginmsg${kind ? ` ${kind}` : ''}`
}

async function doLogin(ev) {
  ev?.preventDefault?.()
  const pwEl = $('#pw')
  const btn = $('#loginbtn')
  const pw = pwEl?.value ?? ''
  if (pw === '') { setLoginMsg('请输入访问密码', 'bad'); return }
  setLoginMsg('登录中…', '')
  if (btn !== null) btn.disabled = true
  const res = await api('/api/login', { method: 'POST', body: { password: pw } })
  if (btn !== null) btn.disabled = false
  if (res.status === 200 && typeof res.body?.token === 'string') {
    setToken(res.body.token)
    if (pwEl !== null) pwEl.value = ''
    setLoginMsg('', '')
    showApp()
    await enterApp()
    return
  }
  setLoginMsg(errText(res, res.status === 429 ? '尝试次数过多，请 5 分钟后再试' : '登录失败'), 'bad')
}

async function doLogout() {
  await api('/api/logout', { method: 'POST', body: {} })
  setToken('')
  location.reload()
}

document.addEventListener('dsh-401', () => {
  if ($('#app')?.classList.contains('off') === true) return
  setToken('')
  showLogin('登录已过期，请重新登录')
})

// ── 导航 ───────────────────────────────────────────────────────────────────

function buildNav() {
  const navlist = $('#navlist')
  if (navlist === null) return
  navlist.textContent = ''
  const pages = Array.isArray(state.schema?.pages) ? state.schema.pages : []
  const groups = []
  const push = (title, items) => { if (items.length > 0) groups.push({ title, items }) }
  push(null, pages.filter((p) => p.kind === 'overview'))
  const ordered = []
  for (const page of pages) {
    if (page.kind === 'overview') continue
    const title = page.group ?? (page.kind === 'system' ? '系统' : '模块')
    let bucket = ordered.find((g) => g.title === title)
    if (bucket === undefined) { bucket = { title, items: [] }; ordered.push(bucket) }
    bucket.items.push(page)
  }
  groups.push(...ordered)
  for (const group of groups) {
    if (group.items.length === 0) continue
    if (group.title !== null) navlist.appendChild(el('div', { class: 'navgrouptitle', text: group.title }))
    for (const page of group.items) {
      const href = page.kind === 'overview' ? '#/overview' : `#/${page.kind}/${page.key}`
      const link = el('a', { class: 'navlink', href, dataset: { route: `${page.kind}/${page.key}` }, title: page.blurb ?? '' }, [
        icon(page.icon ?? 'info'),
        el('span', { text: page.title }),
      ])
      navlist.appendChild(link)
    }
  }
}

function markNavActive(route) {
  const want = route.kind === 'overview' ? 'overview/overview' : `${route.kind}/${route.key}`
  for (const link of $$('#navlist .navlink')) {
    link.classList.toggle('on', link.dataset.route === want)
  }
}

function renderNavMeta() {
  const meta = $('#navmeta')
  if (meta === null) return
  const m = state.meta ?? {}
  meta.textContent = ''
  meta.appendChild(el('div', { text: `配置版本：${typeof m.configVersion === 'number' ? `v${m.configVersion}` : '—'} · 通道：${state.sse === 'open' ? '实时（SSE）' : '轮询'}` }))
  if (m.overrideFile) meta.appendChild(el('div', {}, [el('code', { text: String(m.overrideFile) })]))
}

function renderConnPill() {
  const host = $('#connpill')
  if (host === null) return
  const s = state.status ?? {}
  const on = s.qqConnected === true
  const known = s.qqConnected === true || s.qqConnected === false
  host.className = `pill ${on ? 'ok' : (known ? 'bad' : '')}`
  host.textContent = ''
  host.appendChild(el('span', { class: 'dot' }))
  host.appendChild(el('span', { text: on ? 'QQ 已连接' : (known ? 'QQ 未连接' : 'QQ 状态未知') }))
}

/** 页头徽章：本页字段的热生效汇总（"本页 3 项需重启"）。 */
function renderBadges(route) {
  const host = $('#pagebadges')
  if (host === null) return
  host.textContent = ''
  if (route.kind === 'overview') return
  const fields = (state.schema?.fields ?? []).filter((f) => f.page === route.key)
  if (fields.length === 0) return
  const live = fields.filter((f) => f.hot === 'live').length
  const reload = fields.filter((f) => f.hot === 'reload').length
  const restart = fields.filter((f) => f.hot === 'restart').length
  const mk = (cls, text) => el('span', { class: `badge ${cls}`, text })
  host.appendChild(mk('live', `立即生效 ${live}`))
  if (reload > 0) host.appendChild(mk('reload', `自动重载 ${reload}`))
  if (restart > 0) host.appendChild(mk('restart', `需重启 ${restart}`))
}

// ── 路由 ───────────────────────────────────────────────────────────────────

function renderCurrent() {
  const route = parseRoute(location.hash)
  const pageMeta = resolvePage(state.schema, route)
  state.route = { kind: pageMeta.kind, key: pageMeta.key }
  const main = $('#main')
  const title = $('#pagetitle')
  if (title !== null) title.textContent = pageMeta.title ?? ''
  if (main === null) return
  const page = pageFor(route)
  if (current !== null && current !== page && typeof current.dispose === 'function') {
    try { current.dispose() } catch (error) { console.error('[admin-ui] dispose failed', error) }
  }
  main.textContent = ''
  current = page
  try {
    page.render(main)
    // 页头由外壳统一注入：26 个页面共享同一套标题层级，页面自己不用各写一遍。
    main.insertBefore(pageHead(pageMeta), main.firstChild)
  } catch (error) {
    showError(`页面「${pageMeta.title}」渲染失败：${error?.message ?? String(error)}`, error?.stack ? String(error.stack).split('\n')[1] : '')
    main.appendChild(el('div', { class: 'empty' }, [el('b', { text: '渲染失败' }), el('span', { text: String(error?.message ?? error) })]))
  }
  markNavActive(route)
  renderBadges(route)
  renderNavMeta()
  if (route.query.focus) focusField(route.query.focus)
  window.scrollTo(0, 0)
}

/** 页头：标题 + 说明 + 分组/生效徽章。所有页面共用，避免各写一套。 */
function pageHead(pageMeta) {
  const head = el('header', { class: 'pagehead' })
  head.appendChild(el('h1', { text: pageMeta.title ?? '' }))
  if (typeof pageMeta.blurb === 'string' && pageMeta.blurb !== '') {
    head.appendChild(el('p', { class: 'desc', text: pageMeta.blurb }))
  }
  const meta = el('div', { class: 'meta' })
  if (typeof pageMeta.group === 'string' && pageMeta.group !== '') {
    meta.appendChild(el('span', { class: 'badge dormant', text: pageMeta.group }))
  }
  head.appendChild(meta)
  return head
}

function focusField(path) {  setTimeout(() => {
    const row = document.querySelector(`[data-path="${String(path).replace(/"/g, '\\"')}"]`)
    if (row === null) return
    row.scrollIntoView({ block: 'center' })
    row.classList.add('flash')
    setTimeout(() => row.classList.remove('flash'), 2400)
  }, 120)
}

// ── SSE 与轮询兜底 ─────────────────────────────────────────────────────────

function startPolling() {
  if (pollTimer !== null) return
  pollTimer = setInterval(async () => {
    const res = await loadSnapshot()
    if (res.status === 200) {
      renderConnPill()
      renderNavMeta()
      current?.onEvent?.('status')
    }
  }, 5000)
}

function stopPolling() {
  if (pollTimer === null) return
  clearInterval(pollTimer)
  pollTimer = null
}

function wireSse() {
  sse = startSse({
    onState: (s) => {
      setSse(s)
      renderNavMeta()
      if (s === 'open') stopPolling()
      else startPolling()
      if (s === 'reconnecting') {
        const pill = $('#connpill')
        if (pill !== null) {
          pill.className = 'pill warn'
          pill.textContent = ''
          pill.appendChild(el('span', { class: 'dot' }))
          pill.appendChild(el('span', { text: '通道断开，正在重连…' }))
        }
      }
    },
    onEvent: (name, data) => {
      if (name === 'status' && data !== null) {
        state.status = data
        renderConnPill()
        renderNavMeta()
        current?.onEvent?.('status')
        return
      }
      if (name === 'log') { current?.onEvent?.('log', data); return }
      if (name === 'config') {
        if (typeof data?.version === 'number' && data.version !== state.configVersion) {
          if (state.dirty) {
            toast('另一个页面修改了配置；保存前请刷新当前页，避免互相覆盖', 'warn', 8000)
          } else {
            void loadSnapshot().then(() => { current?.refresh?.() })
          }
        }
        return
      }
      if (name === 'task' && data?.message) toast(String(data.message), 'ok', 6500)
    },
  })
}

// ── ⌘K 命令面板 ────────────────────────────────────────────────────────────

function openPalette() {
  const fields = Array.isArray(state.schema?.fields) ? state.schema.fields : []
  const pages = Array.isArray(state.schema?.pages) ? state.schema.pages : []
  const pageTitle = new Map(pages.map((p) => [p.key, p.title]))
  const items = []
  for (const page of pages) {
    if (page.kind === 'overview') continue
    items.push({ kind: page.kind, key: page.key, label: page.title, sub: '页面', icon: page.icon })
  }
  for (const field of fields) {
    items.push({ kind: 'field', key: field.page, label: field.label, sub: `${field.path} · ${pageTitle.get(field.page) ?? field.page}`, icon: 'search', path: field.path })
  }

  const body = el('div')
  const input = el('input', { class: 'palette-input', type: 'search', placeholder: '搜索页面或配置项（如：语音、talkValue、RSS）…', attrs: { 'aria-label': '命令面板搜索', autocomplete: 'off' } })
  const list = el('div', { class: 'palette-list' })
  body.appendChild(list)
  let filtered = items.slice(0, 40)
  let active = 0

  function paint() {
    list.textContent = ''
    if (filtered.length === 0) {
      list.appendChild(el('div', { class: 'palette-empty', text: '没有匹配的结果' }))
      return
    }
    filtered.forEach((item, index) => {
      const row = el('button', { class: `palette-item${index === active ? ' on' : ''}`, type: 'button' }, [
        icon(item.icon),
        el('span', { class: 'grow' }, [el('span', { text: item.label }), el('span', { class: 'sub', text: item.sub })]),
      ])
      row.addEventListener('click', () => { choose(item) })
      list.appendChild(row)
    })
  }
  function choose(item) {
    dialog.close()
    if (item.kind === 'field') location.hash = `#/module/${item.key}?focus=${encodeURIComponent(item.path)}`
    else location.hash = item.kind === 'overview' ? '#/overview' : `#/${item.kind}/${item.key}`
  }
  function update() {
    const q = input.value.trim().toLowerCase()
    filtered = q === ''
      ? items.slice(0, 40)
      : items.filter((item) => `${item.label} ${item.sub}`.toLowerCase().includes(q)).slice(0, 40)
    active = 0
    paint()
  }
  input.addEventListener('input', update)
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); active = Math.min(active + 1, filtered.length - 1); paint() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = Math.max(active - 1, 0); paint() }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (filtered[active] !== undefined) choose(filtered[active]) }
  })
  const dialog = openDialog({ title: '定位（⌘K / Ctrl+K）', body })
  body.prepend(input)
  paint()
}

// ── 其他外壳行为 ───────────────────────────────────────────────────────────

function toggleDrawer(open) {
  const nav = $('#sidenav')
  const scrim = $('#scrim')
  const btn = $('#navtoggle')
  const want = open === undefined ? !nav?.classList.contains('open') : open
  nav?.classList.toggle('open', want === true)
  scrim?.classList.toggle('show', want === true)
  btn?.setAttribute('aria-expanded', want === true ? 'true' : 'false')
}

function bindShell() {
  $('#themebtn')?.addEventListener('click', cycleTheme)
  $('#logoutbtn')?.addEventListener('click', () => { void doLogout() })
  $('#navtoggle')?.addEventListener('click', () => toggleDrawer())
  $('#scrim')?.addEventListener('click', () => toggleDrawer(false))
  $('#navlist')?.addEventListener('click', (ev) => { if (ev.target.closest?.('.navlink') !== null) toggleDrawer(false) })
  $('#palettebtn')?.addEventListener('click', openPalette)
  $('#refreshbtn')?.addEventListener('click', () => {
    const btn = $('#refreshbtn')
    btn?.classList.add('busy')
    Promise.resolve(current?.refresh?.()).finally(() => setTimeout(() => btn?.classList.remove('busy'), 400))
  })
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) { ev.preventDefault(); openPalette(); return }
    if (ev.key === 'Escape' && document.body.classList.contains('editing-full')) {
      document.body.classList.remove('editing-full')
    }
  })
  window.addEventListener('beforeunload', (ev) => {
    if (state.dirty !== true) return undefined
    ev.preventDefault()
    ev.returnValue = '有未保存的改动'
    return ev.returnValue
  })
  window.addEventListener('hashchange', renderCurrent)
}

// ── 启动 ───────────────────────────────────────────────────────────────────

async function enterApp() {
  // 从登录表单进来时（boot 的快照请求 401 了）快照还没拉过：概览页读 state.status，
  // 不补这一下它只会停在骨架屏（探针的 SSE 是桩；生产里也要干等首个 status 事件）。
  if (state.status === null || state.status === undefined) await loadSnapshot()
  const schema = await loadSchema()
  if (schema.status !== 200) toast(`schema 读取失败：${errText(schema)}`, 'bad', 8000)
  buildNav()
  renderConnPill()
  renderNavMeta()
  renderCurrent()
  wireSse()
}

async function boot() {
  applyTheme(themePref())
  $('#loginform')?.addEventListener('submit', (ev) => { void doLogin(ev) })
  bindShell()
  const res = await loadSnapshot()
  if (res.status === 200) {
    showApp()
    await enterApp()
    return
  }
  if (res.status === 401) { showLogin(''); return }
  showLogin(`无法连接后端：${errText(res, '读取快照失败')}`)
  showError(`读取快照失败：${errText(res, '读取快照失败')}`, '')
}

boot().catch((error) => {
  showLogin(`初始化失败：${error?.message ?? String(error)}`)
  showError('初始化失败', error?.stack ? String(error.stack).split('\n')[0] : '')
})
