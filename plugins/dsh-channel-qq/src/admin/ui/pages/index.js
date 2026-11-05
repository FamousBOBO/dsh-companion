/** 页面注册表：路由 key → 页面对象。
 *
 * 页面对象接口（外壳统一调用）：
 *   `render(host)`   把页面构建到 host（每次进入路由都重新 render）；
 *   `refresh()`      外部请求刷新（工具条的刷新按钮 / SSE config 事件）；
 *   `onEvent(name)`  SSE 事件转发（status / log / config / task）；
 *   `dispose()`      离开路由时的清理（定时器、表单脏状态）。
 */

import overview from './overview.js'
import logs from './logs.js'
import metrics from './metrics.js'
import audit from './audit.js'
import backup from './backup.js'
import security from './security.js'
import runtime from './runtime.js'
import debug from './debug.js'
import persona from './persona.js'
import tools from './tools.js'
import groups from './groups.js'
import memory from './memory.js'
import music from './music.js'
import providers from './providers.js'
import skills from './skills.js'
import kb from './kb.js'
import { createModulePage } from './module.js'

/** 通用模块页（描述表在 module.js；persona / tools 有各自的自定义实现）。 */
const GENERIC_MODULES = [
  'connection', 'messages', 'media', 'stickers', 'links',
  'quotes', 'learn', 'reminders', 'rss', 'flood', 'events', 'proactive',
]

const pages = {
  overview,
  logs,
  metrics,
  audit,
  backup,
  security,
  runtime,
  debug,
  persona,
  tools,
  groups,
  memory,
  music,
  providers,
  skills,
  kb,
}

for (const key of GENERIC_MODULES) pages[key] = createModulePage(key)

export const PAGES = pages

/** 路由 → 页面对象；未知 key 回落到概览。 */
export function pageFor(route) {
  if (route.kind === 'overview') return pages.overview
  return pages[route.key] ?? pages.overview
}
