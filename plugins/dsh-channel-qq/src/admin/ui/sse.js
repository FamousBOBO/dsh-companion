/** SSE 客户端：连 `/api/events`，指数退避重连；断线状态如实上报。
 *
 * 兜底在 `app.js`：`onState('reconnecting')` 时外壳把状态条切到"已断开"并按
 * 5 秒轮询 `/api/snapshot`，恢复后停掉轮询——「断线期间不静默假装在线」是
 * spec §7 的硬要求，所以这里只做连接管理，不做任何"看起来还活着"的粉饰。
 */

import { getToken } from './api.js'

const EVENTS = ['hello', 'status', 'log', 'config', 'task']

export function startSse({ onEvent, onState }) {
  let source = null
  let retryMs = 1500
  let stopped = false

  function connect() {
    if (stopped) return
    const token = getToken()
    const url = token !== '' ? `/api/events?key=${encodeURIComponent(token)}` : '/api/events'
    try {
      source = new EventSource(url, { withCredentials: true })
    } catch (error) {
      onState('reconnecting')
      schedule()
      return
    }
    source.onopen = () => {
      retryMs = 1500
      onState('open')
    }
    for (const name of EVENTS) {
      source.addEventListener(name, (ev) => {
        let data = null
        try { data = JSON.parse(ev.data) } catch { data = null }
        onEvent(name, data)
      })
    }
    source.onerror = () => {
      onState('reconnecting')
      try { source.close() } catch { /* ignore */ }
      source = null
      schedule()
    }
  }

  function schedule() {
    if (stopped) return
    const wait = retryMs
    retryMs = Math.min(retryMs * 2, 30_000)
    setTimeout(connect, wait)
  }

  connect()
  return {
    stop() {
      stopped = true
      try { source?.close() } catch { /* ignore */ }
      source = null
    },
  }
}
