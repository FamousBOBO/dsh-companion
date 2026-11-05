/** 日志页：实时跟随（SSE）+ 级别/模块/关键词过滤 + 底部错误聚合 + 本页配置项。 */

import { createLogView } from '../components/logview.js'
import { createConfigForm } from '../components/form.js'
import { api } from '../api.js'

let view = null
let form = null

function render(host) {
  host.textContent = ''
  view = createLogView({
    fetchLines: async () => {
      const res = await api('/api/logs?lines=800')
      if (res.status !== 200) return []
      return Array.isArray(res.body.lines) ? res.body.lines : []
    },
  })
  host.appendChild(view.node)
  // 日志页也有配置项（如 debug 调试日志）——表单由 schema 生成，不手写。
  form = createConfigForm({ pageKey: 'logs' })
  host.appendChild(form.node)
  void view.refresh()
}

function onEvent(name, data) {
  if (name !== 'log' || view === null) return
  const lines = Array.isArray(data?.lines) ? data.lines : []
  if (lines.length > 0) view.append(lines)
}

function refresh() {
  return view === null ? Promise.resolve() : view.refresh()
}

function dispose() {
  view = null
  if (form !== null) { form.destroy(); form = null }
}

export default { render, refresh, onEvent, dispose }
