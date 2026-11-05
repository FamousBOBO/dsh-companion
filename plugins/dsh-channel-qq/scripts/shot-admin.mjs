/**
 * 后台页面截图（CDP 版）：本地一次性实例 + 真实 UI，headless Chrome 自动登录后截图。
 * 用 CDP 的 Emulation.setDeviceMetricsOverride 拿到**真正的**移动视口——新版无头
 * Chrome 的 --window-size 最小 512px，--force-device-scale-factor 也不改 CSS 宽度，
 * 所以小屏必须走 CDP。
 *
 * Usage:
 *   node scripts/shot-admin.mjs --page providers --width 1440 --out .cache/shot.png
 *   node scripts/shot-admin.mjs --page providers --width 390 --mobile --out .cache/m.png
 *   node scripts/shot-admin.mjs --page providers --width 390 --measure
 */

import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAdminUi } from './build-admin-html.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback }
const page = flag('--page', 'overview')
const width = Number(flag('--width', '1440'))
const height = Number(flag('--height', '1000'))
const mobile = argv.includes('--mobile')
const measure = argv.includes('--measure')
const out = path.resolve(flag('--out', path.join(here, '..', '.cache', `shot-${page}-${width}.png`)))
const PASSWORD = 'shot-admin-password'

const SYSTEM_PAGES = ['logs', 'metrics', 'audit', 'backup', 'security', 'runtime', 'debug', 'providers']
const hash = page === 'overview' ? '#/overview' : `#/${SYSTEM_PAGES.includes(page) ? 'system' : 'module'}/${page}`

const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].filter(Boolean)
const chrome = candidates.find((c) => existsSync(c))
if (chrome === undefined) { console.error('找不到 Chrome'); process.exit(2) }

const { startLocalAdmin } = await import(new URL('../deploy/admin-local.mjs', import.meta.url).href)
const backendPort = 8793
const backend = await startLocalAdmin({ port: backendPort, password: PASSWORD })

const files = new Map()
for (const file of loadAdminUi()) if (file.content !== null) files.set(file.path, file.content)

const inject = `<script>
if (!sessionStorage.getItem('dsh_admin_token') && !sessionStorage.getItem('__shot_tried')) {
  sessionStorage.setItem('__shot_tried', '1');
  fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dsh-admin' }, body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)} }) })
    .then(function (r) { return r.json() })
    .then(function (j) { if (j && j.token) { sessionStorage.setItem('dsh_admin_token', j.token); location.reload() } });
}
window.EventSource = function () { this.addEventListener = function () {}; this.removeEventListener = function () {}; this.close = function () {}; };
</script>`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/api/')) {
    const proxy = httpRequest({ host: '127.0.0.1', port: backendPort, path: url.pathname + url.search, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    proxy.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(proxy)
    return
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = String(files.get('index.html') ?? '')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html.replace('</head>', `${inject}</head>`).replace('<body>', `<body><script>location.hash=${JSON.stringify(hash)}</script>`))
    return
  }
  const key = url.pathname.replace(/^\/ui\//, '').replace(/^\//, '')
  const content = files.get(key)
  if (content === undefined) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', 'cache-control': 'no-store' })
  res.end(String(content))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const tmp = mkdtempSync(path.join(os.tmpdir(), 'admin-shot-'))

const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
  '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'profile')}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const timer = setTimeout(() => reject(new Error('Chrome 没给出 DevTools 地址')), 20_000)
  child.stderr.on('data', (chunk) => {
    buf += chunk
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf)
    if (m !== null) { clearTimeout(timer); resolve(m[1]) }
  })
})

const httpPort = /:(\d+)\//.exec(wsUrl)?.[1] ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${httpPort}/json/list`)).json()
const pageTarget = targets.find((t) => t.type === 'page') ?? targets[0]
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data))
  const p = pending.get(msg.id)
  if (p !== undefined) { pending.delete(msg.id); p(msg) }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
await send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
await new Promise((r) => setTimeout(r, 4000))

if (measure) {
  const result = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(function(){
      var W=document.documentElement.clientWidth, out=[];
      document.querySelectorAll('body *').forEach(function(n){
        var r=n.getBoundingClientRect();
        if(r.right>W+1||r.left<-1) out.push({tag:n.tagName.toLowerCase(),cls:String(n.className).slice(0,60),left:Math.round(r.left),right:Math.round(r.right)});
      });
      return JSON.stringify({scrollWidth:document.documentElement.scrollWidth,clientWidth:W,offenders:out.slice(0,12)});
    })()`,
  })
  console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 500))
} else {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log(`截图：${out}`)
}

ws.close()
try { child.kill() } catch { /* ignore */ }
server.close()
try { backend.stop() } catch { /* ignore */ }
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Chrome 可能还占着 profile */ }
