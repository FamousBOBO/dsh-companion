/** 运行信息页：版本、宿主信息、资源清单、重启级配置项一览（只读）。 */

import { el, fmtDuration } from '../dom.js'
import { api, errText } from '../api.js'
import { emptyBox, kvList, pill, section } from '../components/card.js'
import { notice } from '../components/card.js'

let host = null

function render(h) {
  host = h
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)
  const loading = el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '读取运行信息…' })])
  view.appendChild(loading)
  void api('/api/runtime').then((res) => {
    view.textContent = ''
    if (res.status !== 200) {
      view.appendChild(emptyBox('读取失败', errText(res), 'alert'))
      return
    }
    const info = res.body ?? {}

    const card = section({ title: '运行信息', icon: 'gear' })
    card.body.appendChild(kvList([
      ['插件版本', info.version ?? '—'],
      ['Node', info.node ?? '—'],
      ['平台', info.platform ?? '—'],
      ['运行时长', info.uptimeSec === undefined ? '—' : fmtDuration(info.uptimeSec)],
      ['DSH_HOME', info.dshHome ?? '—', true],
      ['覆盖层文件', info.overrideFile ?? '（未使用）', true],
      ['配置版本', info.configVersion === undefined ? '—' : `v${info.configVersion}`],
    ]))
    view.appendChild(card.node)

    const resources = section({ title: '已注册的资源表', icon: 'db', blurb: '每个功能插件向后台注册的只读/可写资源；模块页的数据段按它渲染。' })
    const row = el('div', { class: 'rowflex' })
    for (const name of Array.isArray(info.resources) ? info.resources : []) row.appendChild(el('span', { class: 'tag', text: name }))
    resources.body.appendChild(row.length === 0 ? el('div', { class: 'inline-note', text: '（无）' }) : row)
    view.appendChild(resources.node)

    const restart = section({
      title: '重启级配置项',
      icon: 'alert',
      blurb: '这些字段改完保存，需要重启插件才彻底生效（保存时会明确提示）。这里只是清单。',
    })
    const paths = Array.isArray(info.restartPaths) ? info.restartPaths : []
    if (paths.length === 0) {
      restart.body.appendChild(el('div', { class: 'inline-note ok', text: '当前没有任何重启级字段。' }))
    } else {
      const row2 = el('div', { class: 'rowflex' })
      for (const path of paths) row2.appendChild(el('span', { class: 'tag', text: path }))
      restart.body.appendChild(row2)
    }
    restart.body.appendChild(notice('重启命令：在服务器上执行 `systemctl restart dsh`（后台刻意不提供"一键重启"——那等于给网页一个执行 shell 的入口）。'))
    view.appendChild(restart.node)
  })
}

function refresh() {
  if (host !== null) render(host)
}

export default { render, refresh, extra: pill }
