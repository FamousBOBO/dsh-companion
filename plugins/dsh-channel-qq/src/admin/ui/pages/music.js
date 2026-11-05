/** 音乐页：通用模块页（歌单表 + 配置表单）+ 「曲库账号」卡。
 *
 * 曲库凭据只能从服务器侧写：网易云/酷狗都要扫码。所以这里做三件事——看登录态、
 * 显示二维码并轮询结果、清除登录。二维码在浏览器里生成（`../qr.js`），登录 key
 * 不出本机。
 *
 * 轮询由页面自己管：2 秒一次、最多 3 分钟，成功后立刻停；离开页面（dispose）也要停，
 * 否则后台会攒下一堆定时器（2026-10-19 人格页的同类事故就是这么来的）。
 */

import { el } from '../dom.js'
import { api, errText } from '../api.js'
import { button, note, pill, section, setNote } from '../components/card.js'
import { typedConfirm } from '../components/dialog.js'
import { toast } from '../components/toast.js'
import { qrSvg } from '../qr.js'
import { createModulePage } from './module.js'

const POLL_MS = 2000
const POLL_MAX = 90

const timers = new Set()
/** 账号卡的句柄（refresh / dispose）；离开页面后置空。 */
let account = null

function stopAll() {
  for (const id of timers) clearInterval(id)
  timers.clear()
}

async function act(name, body = {}) {
  const res = await api(`/api/action/${name}`, { method: 'POST', body: { resource: 'music-account', ...body } })
  if (res.status !== 200) throw new Error(errText(res, '操作失败'))
  return res.body?.result ?? res.body?.data ?? res.body
}

/** 把登录 URL 画成二维码（本地生成，不发网络请求）。 */
function qrImage(text) {
  return el('img', {
    width: 220, height: 220,
    alt: '登录二维码',
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(text))}`,
    style: 'background:#fff;border-radius:8px;padding:6px',
  })
}

/**
 * 一个平台的小卡：状态行 + 登录/清除按钮 + 二维码位。
 * `spec.refresh` 是"登录成功后重新拉状态"的回调（由账号卡传入）。
 */
function providerCard(spec) {
  const card = section({ title: spec.title, icon: 'music', blurb: spec.blurb })
  const status = el('div', { class: 'rowflex', style: 'margin-bottom:10px' })
  const noteBox = note('')
  status.appendChild(noteBox)
  const qrBox = el('div', { class: 'stack', style: 'margin:10px 0;display:none' })
  const startBtn = button('扫码登录', 'small primary', 'play')
  const logoutBtn = button('清除登录', 'small', 'trash')
  card.body.appendChild(status)
  card.body.appendChild(el('div', { class: 'rowflex', style: 'margin-top:10px' }, [startBtn, logoutBtn]))
  card.body.appendChild(qrBox)

  const stopPoll = () => {
    for (const id of [...timers]) { clearInterval(id); timers.delete(id) }
  }

  const renderStatus = (data) => {
    status.textContent = ''
    const info = data?.[spec.id] ?? {}
    const ok = info.loggedIn === true
    status.appendChild(pill(ok ? (info.nickname ? `已登录：${info.nickname}` : '已登录') : '未登录', ok ? 'ok' : 'bad'))
    if (info.vipType !== undefined) status.appendChild(pill(String(info.vipType), 'info'))
    if (typeof info.note === 'string' && info.note !== '') status.appendChild(el('span', { class: 'inline-note', text: info.note }))
    logoutBtn.disabled = !ok
  }

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true
    setNote(noteBox, '', '正在获取二维码…')
    try {
      const started = await act(spec.start)
      const key = String(started.key ?? '')
      const url = String(started.qrUrl ?? started.url ?? '')
      if (key === '' || url === '') throw new Error('服务端没有返回登录链接')
      qrBox.textContent = ''
      qrBox.appendChild(qrImage(url))
      qrBox.appendChild(el('div', { class: 'inline-note', text: '用手机 App 扫码；二维码约 3 分钟有效。' }))
      qrBox.style.display = ''
      setNote(noteBox, '', '等待扫码…')
      let ticks = 0
      stopPoll()
      const id = setInterval(async () => {
        ticks += 1
        if (ticks > POLL_MAX) {
          stopPoll(); qrBox.style.display = 'none'; startBtn.disabled = false
          setNote(noteBox, 'bad', '二维码已过期，请重新获取')
          return
        }
        try {
          const result = await act(spec.poll, { key })
          if (spec.done(result)) {
            stopPoll()
            qrBox.style.display = 'none'
            startBtn.disabled = false
            setNote(noteBox, 'ok', spec.describe(result))
            toast(`${spec.title}：登录成功`, 'ok')
            void spec.refresh()
            return
          }
          const msg = spec.describe(result)
          if (msg !== '') setNote(noteBox, '', msg)
        } catch (error) {
          stopPoll()
          startBtn.disabled = false
          setNote(noteBox, 'bad', `轮询失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }, POLL_MS)
      timers.add(id)
    } catch (error) {
      startBtn.disabled = false
      setNote(noteBox, 'bad', `获取二维码失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  logoutBtn.addEventListener('click', async () => {
    const yes = await typedConfirm({
      title: `清除 ${spec.title} 登录`,
      message: '清除后 VIP/付费歌曲会拿不到直链，需要重新扫码。',
      word: '清除',
    })
    if (!yes) return
    logoutBtn.disabled = true
    try {
      await act(spec.logout)
      stopPoll()
      qrBox.style.display = 'none'
      toast(`${spec.title}：已清除登录`, 'ok')
      void spec.refresh()
    } catch (error) {
      logoutBtn.disabled = false
      setNote(noteBox, 'bad', `清除失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  return { node: card.node, renderStatus, stopPoll }
}

/** 搜索自检：证明"能连上、能搜到"，不用等群里点歌。 */
function searchCard() {
  const card = section({ title: '曲库自检', icon: 'search', blurb: '直接搜一首歌，确认当前登录态与网络可用。不发送任何消息。' })
  const input = el('input', { type: 'text', placeholder: '歌名或歌手，例：晴天', style: 'flex:1', attrs: { 'aria-label': '搜索关键词' } })
  const provider = el('select', { attrs: { 'aria-label': '曲库' } })
  provider.appendChild(el('option', { value: 'netease', text: '网易云' }))
  provider.appendChild(el('option', { value: 'kugou', text: '酷狗' }))
  const go = button('搜索', 'small primary', 'search')
  const out = el('div', { class: 'stack', style: 'margin-top:10px' })
  const status = note('')
  card.body.appendChild(el('div', { class: 'rowflex' }, [provider, input, go]))
  card.body.appendChild(status)
  card.body.appendChild(out)

  go.addEventListener('click', async () => {
    const keyword = input.value.trim()
    if (keyword === '') { setNote(status, 'bad', '关键词不能为空'); return }
    go.disabled = true
    setNote(status, '', '搜索中…')
    out.textContent = ''
    try {
      const result = await act('search', { keyword, provider: provider.value })
      const songs = Array.isArray(result?.songs) ? result.songs : []
      if (songs.length === 0) { setNote(status, 'bad', '没有结果（曲库不可用，或确实没搜到）'); return }
      setNote(status, 'ok', `命中 ${songs.length} 首（${provider.value === 'kugou' ? '酷狗' : '网易云'}）`)
      for (const song of songs) {
        const name = song.name ?? song.songname ?? '?'
        const artist = song.artists ?? song.singerName ?? song.singer ?? ''
        out.appendChild(el('div', { class: 'objrow' }, [el('div', { class: 'objmeta', text: `${name} — ${artist}` })]))
      }
    } catch (error) {
      setNote(status, 'bad', `搜索失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      go.disabled = false
    }
  })
  return card.node
}

function accountCard() {
  const wrap = el('div', { class: 'stack' })
  let alive = true

  const refresh = async () => {
    let data
    try {
      const res = await api('/api/resource/music-account')
      if (res.status === 401) return
      if (res.status !== 200) throw new Error(errText(res, '读取账号状态失败'))
      data = res.body?.data ?? res.body ?? {}
    } catch (error) {
      if (!alive) return
      const msg = error instanceof Error ? error.message : String(error)
      netease.renderStatus({ netease: { loggedIn: false, note: msg } })
      kugou.renderStatus({ kugou: { loggedIn: false, note: msg } })
      return
    }
    if (!alive) return
    netease.renderStatus(data)
    kugou.renderStatus(data)
  }

  const netease = providerCard({
    id: 'netease',
    title: '网易云音乐',
    blurb: '扫码登录后 VIP/付费歌曲也能拿到直链；不登录也能搜普通歌曲（部分曲目会拿不到直链）。',
    start: 'neteaseLoginStart',
    poll: 'neteaseLoginPoll',
    logout: 'neteaseLogout',
    done: (r) => r?.done === true || r?.cookieSaved === true,
    describe: (r) => (r?.message ? String(r.message) : r?.done === true ? '登录成功' : ''),
    refresh: () => { void refresh() },
  })
  const kugou = providerCard({
    id: 'kugou',
    title: '酷狗音乐',
    blurb: '需要本机运行 KuGouMusicApi（地址在下方配置里改）。匿名搜索已被酷狗禁用，登录后才搜得到。',
    start: 'kugouLoginStart',
    poll: 'kugouLoginPoll',
    logout: 'kugouLogout',
    done: (r) => r?.done === true || r?.status === 'ok',
    describe: (r) => (r?.status ? String(r.status) : ''),
    refresh: () => { void refresh() },
  })

  wrap.appendChild(netease.node)
  wrap.appendChild(kugou.node)
  wrap.appendChild(searchCard())
  void refresh()

  account = {
    refresh,
    dispose: () => { alive = false; stopAll(); netease.stopPoll(); kugou.stopPoll(); account = null },
  }
  return wrap
}

const page = createModulePage('music', { extras: () => accountCard() })

export default {
  ...page,
  render(host) {
    page.render(host)
  },
  refresh() {
    page.refresh?.()
    void account?.refresh()
  },
  dispose() {
    account?.dispose()
    page.dispose?.()
  },
}
