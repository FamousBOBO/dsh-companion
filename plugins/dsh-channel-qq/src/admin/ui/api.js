/** 请求封装：token、CSRF 头、错误规范化。返回 `{ status, body }`，**永不 reject**——
 * 调用方只判断 status，网络错误也会变成一个可展示的 `body.error`。
 */

const TOKEN_KEY = 'dsh_admin_token'

let token = ''
try { token = sessionStorage.getItem(TOKEN_KEY) ?? '' } catch { token = '' }

export function setToken(next) {
  token = next ?? ''
  try {
    if (token !== '') sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch { /* 隐私模式下 sessionStorage 可能不可用 */ }
}

export function getToken() {
  return token
}

/** 401 → 会话过期；调用方负责把用户送回登录页。 */
export function authLost(res) {
  return res !== null && typeof res === 'object' && res.status === 401
}

export async function api(path, opts = {}) {
  const method = (opts.method ?? 'GET').toUpperCase()
  const headers = { accept: 'application/json' }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  // 写请求的自定义头（服务端防 CSRF 的判据）；GET 不需要但带上也无害——
  // 这里只在写请求上带，让"谁在写"在服务端日志里一眼可辨。
  if (method !== 'GET' && method !== 'HEAD') headers['x-requested-with'] = 'dsh-admin'
  if (token !== '') headers.authorization = `Bearer ${token}`
  // 必须有超时：服务重启/网络黑洞时 fetch 可以挂很久，页面的「读取中…」就永远不结束。
  // 超时后按 status=0 走统一的错误分支，用户能看到原因并点刷新重试。
  const timeoutMs = Number(opts.timeoutMs ?? 30_000)
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...controller !== null ? { signal: controller.signal } : {},
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    const text = await res.text()
    let body = {}
    if (text !== '') {
      try { body = JSON.parse(text) } catch { body = { error: `响应不是 JSON：${text.slice(0, 120)}` } }
    }
    // 会话过期：全局广播一次，外壳统一弹回登录页（页面模块不必各自处理）。
    if (res.status === 401) {
      try { document.dispatchEvent(new CustomEvent('dsh-401')) } catch { /* ignore */ }
    }
    return { status: res.status, body }
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 20)) {
      return { status: 0, body: { error: `请求超时（${Math.round(timeoutMs / 1000)} 秒）：服务可能正在重启，稍后重试` } }
    }
    return { status: 0, body: { error: `请求失败：${error && error.message ? error.message : String(error)}` } }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 从响应里提取一句可展示的错误。 */
export function errText(res, fallback) {
  const e = res && res.body && res.body.error
  if (typeof e === 'string' && e !== '') return e
  if (res && res.status === 0) return '网络不可达（服务器可能已重启）'
  return `${fallback ?? '操作失败'}（HTTP ${res ? res.status : '?'}）`
}

/** 浏览器端下载一段文本（审计导出、配置导出用）。 */
export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}
