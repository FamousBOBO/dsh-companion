/** 模块页工厂：模块页共用的三段式布局（状态与操作 → 配置 → 数据 + 最近日志）。
 *
 * 页面之间的差异全部收在 {@link DESCRIPTORS} 与 schema 元数据里——新增一个模块页
 * = `pages.ts` 加一条 +（可选）这里加一行描述。配置段由 `components/form.js`
 * 按 `/api/schema` 生成，这个文件里同样没有任何字段名。
 */

import { el } from '../dom.js'
import { state, loadSnapshot } from '../state.js'
import { section, statTile, kvList, pill, emptyBox } from '../components/card.js'
import { createConfigForm } from '../components/form.js'
import { createResourceTable } from '../components/table.js'
import { createLogView, moduleOf } from '../components/logview.js'
import { getPath } from '../model/form-model.js'

/** 每个模块页：状态卡怎么组、数据段挂哪些资源、本模块日志按哪个类别过滤。 */
const DESCRIPTORS = {
  connection: {
    logModule: 'conn',
    status: (s) => ({
      pills: [
        [s.qqConnected === true ? 'QQ 已连接' : (s.qqConnected === false ? 'QQ 未连接' : '状态未知'), s.qqConnected === true ? 'ok' : 'bad'],
        [s.tools === undefined ? '工具数未知' : `${s.tools} 个工具`, 'info'],
      ],
      kv: [
        ['机器人 QQ 号', s.selfId, true],
        ['连接方式', s.connection],
        ['主群号', s.primaryGroup, true],
        ['Agent 工作区', s.workspace, true],
      ],
    }),
  },
  groups: {
    logModule: 'in',
    status: (s, c) => ({
      pills: [
        [getPath(c, 'groupEnabled') === false ? '群聊已关闭' : '群聊开启', getPath(c, 'groupEnabled') === false ? 'bad' : 'ok'],
        [getPath(c, 'requireMention') === true ? '需要 @ 才理' : '不需要 @（看概率）', 'info'],
      ],
      kv: [
        ['主群号', s.primaryGroup, true],
        ['群数量', s.groups],
        ['基础接话概率', getPath(c, 'talkValue')],
      ],
      tiles: [],
    }),
  },
  messages: {
    logModule: 'out',
    status: (s, c) => ({
      kv: [
        ['发送间隔', `${getPath(c, 'rateLimitMs')} ms`],
        ['单条上限', `${getPath(c, 'maxMessageLength')} 字`],
        ['攒批安静窗口', `${getPath(c, 'batching.windowMs')} ms`],
        ['实时注入', getPath(c, 'injectMode.enabled') === true ? '开启' : '关闭'],
      ],
    }),
  },
  media: {
    logModule: 'tool',
    status: (s, c) => ({
      pills: [
        [`TTS：${s.tts ?? '未知'}`, 'info'],
        [getPath(c, 'imageRecognition.enabled') === false ? '看图关闭' : '看图开启', getPath(c, 'imageRecognition.enabled') === false ? 'bad' : 'ok'],
        [getPath(c, 'stt.enabled') === false ? '语音转文字关闭' : '语音转文字开启', getPath(c, 'stt.enabled') === false ? 'bad' : 'ok'],
      ],
    }),
  },
  stickers: {
    logModule: 'tool',
    status: (s, c) => ({
      pills: [[`索引 ${s.emojiIndexed ?? '—'} 张`, 'info'], [getPath(c, 'emoji.steal') === false ? '偷取关闭' : '偷取开启', getPath(c, 'emoji.steal') === false ? 'bad' : 'ok']],
      resources: ['emoji'],
    }),
  },
  links: {
    logModule: 'tool',
    status: (s) => ({
      pills: [[`链接解析：${s.linkResolve ?? '未知'}`, 'info'], [`生图：${s.imageGen ?? '未知'}`, 'info']],
    }),
  },
  music: {
    logModule: 'tool',
    status: () => ({ kv: [['说明', '曲库账号（扫码登录/清除）在这一页的「曲库账号」卡里；歌单在下方表格。']] }),
    resources: ['playlist'],
  },
  quotes: {
    logModule: 'memory',
    status: (s, c) => ({
      pills: [[`语录 ${s.quotes ?? '—'} 条`, 'info'], [getPath(c, 'quotes.autoCapture') === true ? '自动收录开启' : '自动收录关闭', getPath(c, 'quotes.autoCapture') === true ? 'ok' : '']],
    }),
    resources: ['quotes'],
  },
  learn: {
    logModule: 'memory',
    status: (s) => ({ pills: [[`口癖 ${s.learnedPhrases ?? '—'} 条`, 'info']] }),
    resources: ['learned'],
  },
  reminders: {
    logModule: 'event',
    // **口径**：pill/数值全部来自 `status.reminders.*`（后端 `dispatchDiagnostics()` / `catchUpDiagnostics()`
    // 的同一份数），前端不自己算。丢弃明细逐条列 时间 + 截断文本；**清单 ≠ 全部**时要明说被截断。
    status: (s) => {
      const lock = s.remindersReadLock
      const pills = []
      // **round9**：读失败时内存是空表，`0` 会被读成"没有提醒"——那是假事实，必须显式说不可读。
      if (lock) {
        pills.push(['提醒读失败：数据不可读（写入已锁定）', 'bad'])
      } else {
        pills.push([`待发提醒 ${s.pendingReminders ?? '—'} 条`, 'info'])
      }
      const pd = s.pendingDispatch
      if (pd && pd.value > 0) pills.push([`事件待补 ${pd.value}${pd.overLimit > 0 ? `（放弃 ${pd.overLimit}）` : ''}`, pd.overLimit > 0 ? 'bad' : 'warn'])
      const cu = s.catchUp
      if (cu && cu.dropped > 0) pills.push([`积压丢弃 ${cu.dropped} 条`, 'bad'])
      const kv = []
      if (lock) {
        kv.push(['读失败', `${lock.reason === 'permission' ? '权限被拒' : '读不出来/坏 JSON'}（${new Date(lock.at).toLocaleString()}）`])
        kv.push(['原文件', lock.source])
        kv.push(['写入', '已锁定 —— 修好原文件后重启，或调 clearReadLock() 才恢复'])
        kv.push(['注意', '列表与条数为空是"读不出来"，**不是"没有提醒"**'])
      }
      if (cu) {
        if (cu.droppedLast24h > 0) kv.push(['最近 24 小时丢弃', `${cu.droppedLast24h} 条`])
        if (cu.lastDroppedAt) kv.push(['最后一次丢弃', new Date(cu.lastDroppedAt).toLocaleString()])
        kv.push(['补发上限', `${cu.maxTotal} 条 / 窗口 ${Math.round((cu.windowMs ?? 0) / 3600000)} 小时`])
        for (const item of (cu.droppedItems || []).slice(0, 20)) {
          kv.push([`丢弃 · ${new Date(item.at).toLocaleString()}`, item.text])
        }
        if (cu.droppedTruncated) {
          const shown = (cu.droppedItems || []).length
          kv.push(['清单不完整', `共 ${cu.droppedTotal} 条，这里只列了 ${shown} 条（还有 ${cu.droppedTotal - shown} 条未列出）`])
        } else if (cu.droppedTotal > 0) {
          kv.push(['丢弃总数', `${cu.droppedTotal} 条（清单已全部列出）`])
        }
      }
      return { pills, kv }
    },
    resources: ['reminders'],
  },
  rss: {
    logModule: 'event',
    status: (s, c) => ({
      pills: [[`启用订阅源 ${s.rssFeeds ?? '—'} 个`, 'info']],
      kv: [['轮询间隔', `${getPath(c, 'rss.pollIntervalMin')} 分钟`]],
    }),
    resources: ['rss'],
  },
  flood: {
    logModule: 'in',
    status: (s) => ({
      tiles: [['已记录', s.floodTracked], ['已触发', s.floodTriggered]],
    }),
  },
  events: {
    logModule: 'event',
    status: (s, c) => ({
      pills: [[getPath(c, 'eventMonitor.enabled') === false ? '事件监控关闭' : '事件监控开启', getPath(c, 'eventMonitor.enabled') === false ? 'bad' : 'ok']],
      kv: [['监听类型', (getPath(c, 'eventMonitor.kinds') ?? []).join(', ') || '（无）', true]],
    }),
  },
  proactive: {
    logModule: 'event',
    status: (s, c) => ({
      pills: [[getPath(c, 'morningReport.enabled') === false ? '早报关闭' : '早报开启', getPath(c, 'morningReport.enabled') === false ? 'bad' : 'ok']],
    }),
  },
  memory: {
    logModule: 'memory',
    status: () => ({ kv: [['说明', '记忆库、知识条目与日记；写入由机器人自己完成，这里做浏览与删除。']] }),
    resources: ['memories', 'diary'],
  },
  tools: {
    logModule: 'tool',
    status: (s, c) => ({
      pills: [
        [s.tools === undefined ? '工具数未知' : `${s.tools} 个工具`, 'info'],
        [getPath(c, 'groupAdmin.dangerous') === true ? '高危群管：已开启' : '高危群管：关闭', getPath(c, 'groupAdmin.dangerous') === true ? 'bad' : 'ok'],
      ],
    }),
  },
}

/** 资源的展示规格（与服务端 `admin-resources.ts` 的表一一对应）。 */
export const RESOURCE_SPECS = {
  emoji: {
    label: '表情包库',
    hint: '偷到/注册的表情包与语义标签。删除只从索引里摘掉，不删磁盘文件。',
    actions: [
      { name: 'rescan', label: '扫描新图', icon: 'wand', confirm: '只把目录里新增的图片加入索引，不会重新打标。' },
      { name: 'retag', label: '全部重新打标', icon: 'refresh', confirm: '会对库里每张图重新调用视觉模型（几十张就要几分钟），进度写日志；完成后标签才准确。' },
    ],
  },
  quotes: { label: '群语录', hint: '群梗语录库。', creatable: true, createTemplate: { text: '语录正文', speaker: '谁说的', tags: ['梗'] } },
  memories: { label: '长期记忆', hint: '知识条目（技能/事实/偏好/事件/人物）。', creatable: true, createTemplate: { type: 'fact', content: '一句话知识', tags: ['标签'], source: '来源' } },
  reminders: { label: '提醒', hint: '到点推送的提醒任务。' },
  rss: { label: '订阅源', hint: 'RSS/Atom 订阅；在这里增删会直接写进 config.rss.feeds。', creatable: true, createTemplate: { url: 'https://example.com/feed.xml', isGroup: true, target: 1000000003 } },
  learned: { label: '学到的口癖', hint: '从群聊里统计出来的短语。', creatable: true, createTemplate: { text: '短语' } },
  sendl: { label: '机器人发送记录', hint: '她最近发出去的消息（跨会话持久）。' },
  playlist: { label: '歌单', hint: '跨重启持久化的点歌记录。', creatable: true, createTemplate: { songId: '123', name: '歌名', artists: '歌手' } },
  diary: { label: '日记', hint: '工作区 memory/ 下的日记文件。' },
  affection: { label: '好感度与阶段', hint: '她自己的记分板与阶段史。' },
}

/**
 * 创建一个模块页。
 * @param {string} pageKey pages.ts 的 key
 * @param {{ extras?: () => (Node|Node[]) | null }} [opts]
 */
export function createModulePage(pageKey, opts = {}) {
  let host = null
  let view = null
  let statusBody = null
  let form = null
  let logView = null
  let disposers = []

  function paintStatus() {
    if (statusBody === null) return
    statusBody.textContent = ''
    const descriptor = DESCRIPTORS[pageKey]
    const s = state.status ?? {}
    const c = state.config ?? {}
    if (s === null || Object.keys(s).length === 0) {
      statusBody.appendChild(el('div', { class: 'inline-note', text: '状态还没读回来（等待快照）。' }))
      return
    }
    if (descriptor === undefined || descriptor.status === undefined) {
      statusBody.appendChild(el('div', { class: 'inline-note', text: '这一页没有专门的状态字段。' }))
      return
    }
    const built = descriptor.status(s, c) ?? {}
    if (Array.isArray(built.pills) && built.pills.length > 0) {
      const row = el('div', { class: 'rowflex', style: 'margin-bottom:10px' })
      for (const [text, kind] of built.pills) row.appendChild(pill(text === null || text === undefined ? '—' : String(text), kind))
      statusBody.appendChild(row)
    }
    if (Array.isArray(built.kv) && built.kv.length > 0) statusBody.appendChild(kvList(built.kv))
    if (Array.isArray(built.tiles) && built.tiles.length > 0) {
      const grid = el('div', { class: 'grid' })
      for (const [label, value] of built.tiles) grid.appendChild(statTile(label, value === undefined || value === null ? '—' : value))
      statusBody.appendChild(grid)
    }
  }

  function render(h) {
    host = h
    host.textContent = ''
    view = el('div', { class: 'view' })
    host.appendChild(view)

    // ── 状态 ────────────────────────────────────────────────────────────────
    const status = section({ title: '状态', icon: 'pulse' })
    statusBody = el('div')
    status.body.appendChild(statusBody)
    paintStatus()
    view.appendChild(status.node)

    // ── 额外卡片（个别页专属，如工具页的指令注入）─────────────────────────
    if (typeof opts.extras === 'function') {
      const extra = opts.extras()
      const list = Array.isArray(extra) ? extra : (extra === null || extra === undefined ? [] : [extra])
      for (const node of list) view.appendChild(node)
    }

    // ── 配置（schema 驱动）──────────────────────────────────────────────────
    form = createConfigForm({ pageKey })
    view.appendChild(form.node)

    // ── 数据段 ──────────────────────────────────────────────────────────────
    const descriptor = DESCRIPTORS[pageKey]
    const resourceNames = descriptor?.resources ?? []
    // meta 来自 `/api/snapshot`。它还没到/读取失败时**先照常渲染资源表**：
    // 每张表自己会去 `/api/resource/<name>` 取数并显示真实错误。以前这里
    // 把"meta 缺失"当成"资源未注册"，snapshot 一慢所有页面就只剩"该资源未启用"。
    const metaKnown = Array.isArray(state.meta?.resources)
    const available = new Set(metaKnown ? state.meta.resources : [])
    for (const name of resourceNames) {
      const spec = RESOURCE_SPECS[name]
      if (spec === undefined) continue
      if (metaKnown && !available.has(name)) {
        const gone = section({ title: spec.label, icon: 'db' })
        gone.body.appendChild(emptyBox('该资源未启用', `后端没有注册 ${name}（可能对应功能被配置关掉了）。`, 'alert'))
        view.appendChild(gone.node)
        continue
      }
      const table = createResourceTable({ name, ...spec })
      disposers.push(() => table.node.remove())
      view.appendChild(table.node)
      void table.load()
    }

    // ── 最近日志（本模块）───────────────────────────────────────────────────
    const logModule = descriptor?.logModule
    if (logModule !== undefined) {
      const logCard = section({ title: '最近日志（本模块）', icon: 'filetext', blurb: '按模块归类过滤后的日志尾部；完整过滤与错误聚合在「日志」页。' })
      logView = createLogView({
        fetchLines: async () => {
          const res = await (await import('../api.js')).api('/api/logs?lines=400')
          if (res.status !== 200) return []
          const lines = Array.isArray(res.body.lines) ? res.body.lines : []
          return lines.filter((line) => moduleOf(line) === logModule)
        },
      })
      logCard.body.appendChild(logView.node)
      view.appendChild(logCard.node)
      void logView.refresh()
    }
  }

  async function refresh() {
    await loadSnapshot()
    paintStatus()
    if (form !== null) form.refresh()
  }

  function onEvent(name) {
    if (name === 'status') paintStatus()
  }

  function dispose() {
    if (form !== null) form.destroy()
    form = null
    logView = null
    statusBody = null
    view = null
    host = null
    for (const fn of disposers) fn()
    disposers = []
  }

  return { render, refresh, onEvent, dispose }
}
