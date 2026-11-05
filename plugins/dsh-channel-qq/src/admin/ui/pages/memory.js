/** 记忆页：全局浏览（沿用通用模块页）+ **待审卡片**（候选 / 疑似冲突 / 迁移）。
 *
 * 为什么需要这块：`memory.reflect` 产出的记录是 `candidate`，而检索只认 `active`；
 * 从前没有任何界面能把候选转正，等于"反思产出了但永远不生效"（2026-10-18 审计）。
 * 冲突裁定同理：只检出、没有入口。
 *
 * 数据来自资源 `memory-pending`（每次现算，不另存队列）；动作走 `/api/action/<name>`。
 */

import { el } from '../dom.js'
import { api, errText } from '../api.js'
import { button, emptyBox, section, statTile } from '../components/card.js'
import { toast } from '../components/toast.js'
import { createModulePage } from './module.js'

async function act(name, body) {
  const res = await api(`/api/action/${name}`, { method: 'POST', body: { resource: 'memory-pending', ...body } })
  if (res.status !== 200) { toast(`操作失败：${errText(res)}`, 'bad', 8000); return false }
  const payload = res.body?.result ?? res.body
  if (payload?.ok === false) { toast(String(payload.reason ?? '操作失败'), 'bad', 8000); return false }
  toast(typeof payload?.note === 'string' && payload.note !== '' ? payload.note : '已保存', 'ok', 6000)
  return true
}

function row(content, buttons) {
  const card = el('div', { class: 'objrow' })
  card.appendChild(el('div', { class: 'objmeta', text: content }))
  card.appendChild(el('div', { class: 'rowflex', style: 'margin-top:8px' }, buttons))
  return card
}

/** 索引状态：三条线（结构记录 / 原文块 / 向量）各自有多少条、多少条参与检索。
 *
 * 深召回（`qq_memory_search`）靠的是原文块 + 向量，「块索引建了没有」原本只能翻日志，
 * 现在在页面上一眼能看到。
 */
function statsCard() {
  const card = section({
    title: '索引状态',
    icon: 'db',
    blurb: '结构记录、原文块、向量各自有多少条。原文块由夜间 memory.chunks 建（03:50），向量由 memory.reindex 建（06:30）。',
  })
  const box = el('div', {})
  card.body.appendChild(box)

  const load = async () => {
    box.textContent = ''
    const res = await api('/api/resource/memory-stats')
    if (res.status !== 200) { box.appendChild(emptyBox('读取失败', errText(res), 'alert')); return }
    const d = res.body?.data ?? res.body ?? {}
    if (d.enabled !== true) { box.appendChild(emptyBox('记忆系统关着', String(d.note ?? 'memory.v2 未打开'), 'info')); return }
    const grid = el('div', { class: 'grid' })
    grid.appendChild(statTile('结构记录', d.records, `${d.active} 条参与检索`))
    grid.appendChild(statTile('原文块', d.chunks, `${d.chunkActive} 条参与检索 · 深召回用`))
    grid.appendChild(statTile('向量', d.vectors, d.vectorEnabled ? '向量检索已开' : '向量关闭（纯关键词）'))
    box.appendChild(grid)
  }
  void load()
  return { node: card.node, reload: load }
}

function pendingCard() {
  const card = section({
    title: '待审核',
    icon: 'brain',
    blurb: '反思产出的候选记忆、疑似冲突的记录对。通过后才会进入检索；冲突裁定不会删除任何记录。',
  })
  const box = el('div', { class: 'stack' })
  card.body.appendChild(box)

  const load = async () => {
    box.textContent = ''
    const res = await api('/api/resource/memory-pending')
    if (res.status !== 200) {
      box.appendChild(emptyBox('读取失败', errText(res), 'alert'))
      return
    }
    const data = res.body?.data ?? res.body ?? {}
    if (data.note !== undefined) {
      box.appendChild(emptyBox('记忆系统关着', String(data.note), 'info'))
      return
    }
    const candidates = Array.isArray(data.candidates) ? data.candidates : []
    const conflicts = Array.isArray(data.conflicts) ? data.conflicts : []

    if (candidates.length === 0 && conflicts.length === 0) {
      box.appendChild(emptyBox('没有待审条目', '反思与冲突扫描只在 memory.v2 打开后才会产出。', 'brain'))
    }

    if (candidates.length > 0) {
      box.appendChild(el('div', { class: 'flabel', text: `候选记忆（${candidates.length}）` }))
      for (const c of candidates) {
        const approve = button('通过', 'small primary', 'check')
        approve.addEventListener('click', async () => { if (await act('approve', { id: c.id })) void load() })
        const reject = button('忽略', 'small', 'trash')
        reject.addEventListener('click', async () => { if (await act('reject', { id: c.id })) void load() })
        const toSkill = button('写成技能', 'small', 'book')
        toSkill.addEventListener('click', async () => {
          if (!window.confirm('把这条候选写入技能待审区？到「技能」页确认后才会启用。')) return
          if (await act('toSkill', { id: c.id })) void load()
        })
        box.appendChild(row(`${c.content}（${c.kind} · ${c.date} · ${c.source}）`, [approve, reject, toSkill]))
      }
    }

    if (conflicts.length > 0) {
      box.appendChild(el('div', { class: 'flabel', text: `疑似冲突（${conflicts.length}）`, style: 'margin-top:14px' }))
      for (const pair of conflicts) {
        const keepLeft = button('保留左条', 'small primary', 'check')
        keepLeft.addEventListener('click', async () => { if (await act('resolve', { keep: pair.left.id, drop: pair.right.id })) void load() })
        const keepRight = button('保留右条', 'small primary', 'check')
        keepRight.addEventListener('click', async () => { if (await act('resolve', { keep: pair.right.id, drop: pair.left.id })) void load() })
        const wrap = el('div', { class: 'objrow' })
        wrap.appendChild(el('div', { class: 'tiny mute', text: `重叠 ${pair.overlap}` }))
        wrap.appendChild(el('div', { class: 'objmeta', text: `左：${pair.left.content}` }))
        wrap.appendChild(el('div', { class: 'objmeta', text: `右：${pair.right.content}` }))
        wrap.appendChild(el('div', { class: 'rowflex', style: 'margin-top:8px' }, [keepLeft, keepRight]))
        box.appendChild(wrap)
      }
    }

    const migrate = button('迁移 MEMORY.md → 候选', 'small', 'download')
    migrate.addEventListener('click', async () => {
      migrate.disabled = true
      const ok = await act('migrate', {})
      migrate.disabled = false
      if (ok) void load()
    })
    box.appendChild(el('div', { class: 'rowflex', style: 'margin-top:14px' }, [migrate]))
  }

  void load()
  globalThis.__dshMemoryPendingReload = load
  return card.node
}

let statsReload = null
const page = createModulePage('memory', {
  extras: () => {
    const wrap = el('div', { class: 'stack' })
    const stats = statsCard()
    statsReload = stats.reload
    wrap.appendChild(stats.node)
    wrap.appendChild(pendingCard())
    return wrap
  },
})

export default {
  ...page,
  render(host) {
    page.render(host)
  },
  refresh() {
    page.refresh?.()
    statsReload?.()
    globalThis.__dshMemoryPendingReload?.()
  },
}
