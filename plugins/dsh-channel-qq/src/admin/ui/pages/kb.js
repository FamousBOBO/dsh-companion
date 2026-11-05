/** 知识库页：资料清单、集合可见范围、扫描进度、块预览、全局设置。
 *
 * 为什么不是通用模块页：知识库的主体不是"配置里的一个数组"，而是磁盘上的文件 +
 * 摄取进度 + 可分页预览的块。通用表格表达不了"扫描到第几个文件"和"这块原文长什么样"。
 *
 * 数据面：`/api/resource/kb`（`features/kb/resource.ts`）。
 */

import { el, fmtBytes, fmtTime } from '../dom.js'
import { api, errText } from '../api.js'
import { button, emptyBox, section, setNote, note, pill } from '../components/card.js'
import { openDialog } from '../components/dialog.js'
import { toast } from '../components/toast.js'
import { createConfigForm } from '../components/form.js'

const STATUS_LABEL = { active: '已索引', deleted: '已删除', error: '解析失败' }

/** 资源动作（统一走 `/api/action/<name>`）。 */
async function act(name, body = {}) {
  const res = await api(`/api/action/${name}`, { method: 'POST', body: { resource: 'kb', ...body } })
  if (res.status !== 200) throw new Error(errText(res, '操作失败'))
  return res.body?.result ?? res.body?.data ?? res.body
}

/** 摄取进度的一句话。 */
function progressText(ingest) {
  if (!ingest || ingest.total === 0) return ingest?.finishedAt ? '还没有需要扫描的文件' : '尚未扫描'
  if (ingest.running) return `正在扫描 ${ingest.done}/${ingest.total}：${ingest.current || '…'}`
  return `上轮：新增 ${ingest.added}、更新 ${ingest.updated}、跳过 ${ingest.skipped}、失败 ${ingest.failed}、移除 ${ingest.removed}`
}

/** 块预览对话框。 */
async function previewDoc(doc) {
  const data = await act('preview', { id: doc.id })
  const box = el('div', { class: 'stack' })
  box.appendChild(el('div', { class: 'inline-note', text: `${data.document.path} · ${data.chunks.length} 块` }))
  for (const chunk of data.chunks.slice(0, 30)) {
    const card = el('div', { class: 'objrow' })
    const head = el('div', { class: 'rowflex' })
    head.appendChild(el('b', { text: `第 ${chunk.seq} 段` }))
    if (chunk.heading) head.appendChild(pill(chunk.heading, 'info'))
    if (chunk.page > 0) head.appendChild(pill(`第 ${chunk.page} 页`, 'info'))
    card.appendChild(head)
    card.appendChild(el('pre', { class: 'mono', style: 'white-space:pre-wrap;max-height:30vh;overflow:auto', text: chunk.text }))
    box.appendChild(card)
  }
  if (data.chunks.length > 30) box.appendChild(note(`只显示前 30 块（共 ${data.chunks.length} 块）`))
  openDialog({ title: `${doc.title} · 块预览`, body: box })
}

/** 一行文档。 */
function docRow(doc, reload) {
  const card = el('div', { class: 'objrow' })
  const head = el('div', { class: 'rowflex' })
  head.appendChild(el('b', { text: doc.title || doc.path }))
  head.appendChild(pill(STATUS_LABEL[doc.status] ?? doc.status, doc.status === 'active' ? 'ok' : doc.status === 'error' ? 'bad' : 'info'))
  head.appendChild(pill(doc.collection, 'info'))
  if (doc.pages > 0) head.appendChild(pill(`${doc.pages} 页`, 'info'))
  head.appendChild(pill(`${doc.chunks} 块`, 'info'))
  card.appendChild(head)
  card.appendChild(el('div', { class: 'inline-note', text: `${doc.path} · ${fmtBytes(doc.bytes)} · ${fmtTime(doc.updatedAt || doc.mtime)}` }))
  if (doc.error) card.appendChild(el('div', { class: 'inline-note', style: 'color:var(--bad)', text: `解析失败：${doc.error}` }))

  const row = el('div', { class: 'rowflex', style: 'margin-top:8px' })
  if (doc.status !== 'error') {
    const view = button('预览', 'small', 'eye')
    view.addEventListener('click', async () => {
      try { await previewDoc(doc) } catch (error) { toast(error.message, 'bad', 6000) }
    })
    row.appendChild(view)
  }
  if (doc.status === 'active') {
    const del = button('移除', 'small', 'trash')
    del.addEventListener('click', async () => {
      if (!window.confirm(`从索引里移除 ${doc.path}？（不会删除磁盘文件）`)) return
      try { await act('remove', { id: doc.id }); toast('已从索引移除', 'ok', 3000); reload() } catch (error) { toast(error.message, 'bad', 6000) }
    })
    row.appendChild(del)
  } else if (doc.status === 'deleted') {
    const back = button('恢复', 'small', 'refresh')
    back.addEventListener('click', async () => {
      try { await act('restore', { id: doc.id }); toast('已恢复', 'ok', 3000); reload() } catch (error) { toast(error.message, 'bad', 6000) }
    })
    row.appendChild(back)
  }
  if (row.childNodes.length > 0) card.appendChild(row)
  return card
}

/** 集合汇总（含可见范围）。 */
function collectionRows(data) {
  const box = el('div', { class: 'stack' })
  const scopes = data.scopes ?? {}
  for (const collection of data.collections ?? []) {
    const row = el('div', { class: 'rowflex' })
    row.appendChild(el('b', { text: collection.name }))
    row.appendChild(pill(`${collection.docCount} 份 · ${collection.chunkCount} 块`, 'info'))
    const allowed = scopes[collection.name]
    row.appendChild(pill(allowed && allowed.length > 0 ? `仅 ${allowed.join(', ')}` : '所有房间可见', allowed && allowed.length > 0 ? 'info' : 'ok'))
    box.appendChild(row)
  }
  if (data.scopeError) box.appendChild(el('div', { class: 'inline-note', style: 'color:var(--bad)', text: data.scopeError }))
  if ((data.collections ?? []).length === 0) box.appendChild(note('还没有集合：把资料放进工作区目录后点「立即扫描」。'))
  return box
}

/** 页面对象。 */
let activeForm = null
let pollTimer = null

export const kbPage = {
  render(host) {
    host.textContent = ''
    const scanBtn = button('立即扫描', 'small primary', 'refresh')
    const reindexBtn = button('重建向量', 'small', 'db')
    const listCard = section({
      title: '资料库',
      icon: 'db',
      blurb: '工作区里被配置为来源的目录；改动文件后下一轮扫描自动更新，也可以手动触发。',
      actions: [reindexBtn, scanBtn],
    })
    host.appendChild(listCard.node)
    const status = note('')
    listCard.body.appendChild(status)

    // B6：从 URL 入库（抓取 → kb/raw/web/*.md → 扫描）。默认关，开关在下方设置里。
    const urlCard = section({
      title: '从 URL 入库',
      icon: 'link',
      blurb: '抓取网页正文存成 kb/raw/web/*.md（有 SSRF 守卫；重定向逐跳校验）。',
    })
    const urlInput = el('input', { class: 'input', placeholder: 'https://example.com/article' })
    const urlBtn = button('抓取入库', 'small primary', 'link')
    const urlNote = note('')
    urlCard.body.appendChild(el('div', { class: 'rowflex' }, [urlInput, urlBtn]))
    urlCard.body.appendChild(urlNote)
    host.appendChild(urlCard.node)
    urlBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim()
      if (url === '') { setNote(urlNote, 'bad', '先填 URL。'); return }
      urlBtn.disabled = true
      setNote(urlNote, '', '抓取中…')
      try {
        const result = await act('ingestUrl', { url })
        setNote(urlNote, 'ok', `已入库：${result?.title ?? url}`)
        urlInput.value = ''
        await reload()
      } catch (error) {
        setNote(urlNote, 'bad', error instanceof Error ? error.message : String(error))
      } finally {
        urlBtn.disabled = false
      }
    })

    const reload = async () => {
      const res = await api('/api/resource/kb')
      if (res.status !== 200) { setNote(status, 'bad', errText(res, '读取失败')); return }
      const data = res.body?.data ?? {}
      const urlsAllowed = data.ingestUrls === true
      urlInput.disabled = !urlsAllowed
      urlBtn.disabled = !urlsAllowed
      if (!urlsAllowed && (urlNote.textContent ?? '') === '') {
        setNote(urlNote, '', '未启用：在下方「知识库」设置里打开「允许 URL 入库」。')
      }
      const docs = Array.isArray(data.documents) ? data.documents : []
      listCard.body.textContent = ''
      listCard.body.appendChild(status)
      const stats = data.stats ?? {}
      listCard.body.appendChild(note(
        `${stats.activeDocs ?? 0} 份文档 · ${stats.activeChunks ?? 0} 块可检索 · ${fmtBytes(stats.bytes ?? 0)} · 向量 ${stats.vectors ?? 0} 条`
        + ` · ${stats.enabled === false ? '知识库已关闭' : '已启用'} · ${progressText(stats.ingest)}`,
      ))
      const filter = el('input', { class: 'input', placeholder: '按标题或路径过滤…' })
      listCard.body.appendChild(filter)
      const rows = el('div', { class: 'stack' })
      const draw = () => {
        const needle = filter.value.trim().toLowerCase()
        rows.textContent = ''
        const shown = docs.filter((doc) => needle === '' || `${doc.title} ${doc.path}`.toLowerCase().includes(needle))
        if (shown.length === 0) rows.appendChild(emptyBox('没有匹配的文档。把资料放进工作区目录后点「立即扫描」。'))
        for (const doc of shown) rows.appendChild(docRow(doc, reload))
      }
      filter.addEventListener('input', draw)
      draw()
      listCard.body.appendChild(rows)
      const collectionsCard = section({ title: '集合与可见范围', icon: 'lock' })
      collectionsCard.body.appendChild(collectionRows(data))
      collectionsCard.body.appendChild(note('在下方「设置」里用 JSON 配置：{"集合名": ["group-123"]}；不在表里的集合所有房间可见。'))
      listCard.body.appendChild(collectionsCard.node)
      // 扫描中则轮询，扫完自动停。
      if (stats.ingest?.running) {
        clearTimeout(pollTimer)
        pollTimer = setTimeout(() => { void reload() }, 2500)
      }
    }

    const scan = async (force) => {
      scanBtn.disabled = true
      setNote(status, '', '正在扫描…')
      try {
        const progress = await act('scan', { force })
        toast(progressText(progress), 'ok', 5000)
        await reload()
      } catch (error) {
        setNote(status, 'bad', error.message)
      } finally {
        scanBtn.disabled = false
      }
    }
    scanBtn.addEventListener('click', () => { void scan(false) })
    reindexBtn.addEventListener('click', async () => {
      reindexBtn.disabled = true
      try {
        const got = await act('reindex')
        toast(got.skipped ? '向量未启用或正在重建' : `向量 ${got.total} 条（新嵌 ${got.embedded}，失败 ${got.failed}）`, 'ok', 5000)
        await reload()
      } catch (error) {
        toast(error.message, 'bad', 6000)
      } finally {
        reindexBtn.disabled = false
      }
    })

    const configCard = section({ title: '设置', icon: 'gear' })
    const form = createConfigForm({ pageKey: 'kb' })
    activeForm = form
    configCard.body.appendChild(form.node)
    host.appendChild(configCard.node)
    void reload()
  },
  dispose() {
    clearTimeout(pollTimer)
    pollTimer = null
    activeForm?.destroy()
    activeForm = null
  },
}

export default kbPage
