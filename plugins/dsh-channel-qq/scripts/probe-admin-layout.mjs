/**
 * 管理后台布局探针（A1 外壳 + A2 配置表单的回归网）。
 *
 * 与旧版的本质差异：不在 `file://` 上用 mock 假数据，而是"**工作树 UI + 真后端**"——
 *
 *   1. `import('../deploy/admin-local.mjs')` 起一个一次性实例（真实 AdminServer、
 *      真生成 UI、假插件世界；`lib/` 缺了会自动 `npm run build`）；
 *   2. 本地页面服务器把 `src/admin/ui/**` 逐个文件吐出来（和生成器同一份源），
 *      并把 `/api/*` 原样反代给实例——页面看到的永远是真实响应；
 *   3. headless Chrome 以 4 个宽度打开，注入探针脚本：先走真实登录表单，然后
 *      逐个 hash 路由扫全部 25 页，再跑交互（主题/抽屉/⌘K/开关→diff→保存并回读）。
 *
 * 断言的都是"会真的坏"的东西：横向溢出、JS 报错、页面空白、配置行没落在页面上、
 * 保存链路断掉、控件点不到（遮挡审计）、`:focus-visible` 缺失。
 *
 * Usage: node scripts/probe-admin-layout.mjs [--chrome <path>] [--port 8792] [--keep] [--verbose]
 */

import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadAdminUi } from './build-admin-html.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const keep = argv.includes('--keep')
const verbose = argv.includes('--verbose')

// 导航项数从 ADMIN_PAGES 现算，不写死：加一页就改这里的老做法已经漏过一次
// （28 页 vs 硬编码 27），探针的职责是发现页面坏了，不是维护一份副本。
const { ADMIN_PAGES } = await import(pathToFileURL(path.join(root, 'build', 'lib', 'config', 'pages.js')).href)
const EXPECTED_NAV = ADMIN_PAGES.length

const candidates = [
  flag('--chrome'),
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const chrome = candidates.find((c) => existsSync(c))
if (chrome === undefined) {
  console.error('找不到 Chrome/Edge；用 --chrome <path> 或设 CHROME_PATH 指定。')
  process.exit(2)
}

const BACKEND_PORT = Number(flag('--port') ?? process.env.PROBE_ADMIN_PORT ?? 8792)
const PASSWORD = process.env.PROBE_PASSWORD ?? 'probe-admin-password'
const WIDTHS = [360, 414, 768, 1280]
const INTERACT_WIDTHS = new Set([360, 1280])

// ── 1) 一次性后端（真实 AdminServer + 真实 UI 包 + 假插件世界）──────────────
// PROBE_BACKEND：指到一台**已有**的 AdminServer（只读巡检用）。
// 注意：交互档会改配置，远端巡检必须同时设 PROBE_READONLY=1。
const REMOTE_BACKEND = process.env.PROBE_BACKEND ?? ''
const READONLY = process.env.PROBE_READONLY === '1'
const backend = REMOTE_BACKEND !== ''
  ? { base: REMOTE_BACKEND, stop: async () => {} }
  : await (await import(new URL('../deploy/admin-local.mjs', import.meta.url).href))
      .startLocalAdmin({ port: BACKEND_PORT, password: PASSWORD, verbose: argv.includes('--verbose') })

// ── 2) 页面服务器：src/admin/ui/** 原样送出 + /api/* 反代 ────────────────────
const files = new Map()
for (const file of loadAdminUi()) if (file.content !== null) files.set(file.path, file.content)

const HEAD_SCRIPT = `<script>
window.__probeErrors = [];
window.addEventListener('error', function (e) { window.__probeErrors.push('error: ' + (e.message || '') + ' @' + (e.lineno || 0)); });
window.addEventListener('unhandledrejection', function (e) { var r = e.reason; window.__probeErrors.push('rejection: ' + (r && r.message ? r.message : String(r))); });
var _ce = console.error;
console.error = function () { window.__probeErrors.push('console.error: ' + Array.prototype.slice.call(arguments).map(String).join(' ')); return _ce.apply(console, arguments); };
window.__PROBE_PASSWORD__ = ${JSON.stringify(PASSWORD)};
/* SSE 桩：探针不建立长连接（虚拟时间预算 + 永不结束的 fetch = 挂起） */
window.EventSource = function () { this.addEventListener = function () {}; this.removeEventListener = function () {}; this.close = function () {}; };
window.confirm = function () { return true; };
window.prompt = function () { return null; };
</script>`

const BODY_SCRIPT = String.raw`<pre id="__probe" style="display:none"></pre>
<script>
(function () {
  function b64(s) {
    var bytes = new TextEncoder().encode(s), bin = '', i;
    for (i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
    return btoa(bin);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function shown(n) {
    if (!n) return false;
    var s = getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    var r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function describe(n) {
    if (!n) return '(null)';
    var id = n.id ? '#' + n.id : '';
    var cls = (typeof n.className === 'string' && n.className.trim()) ? '.' + n.className.trim().split(/\s+/).join('.') : '';
    return n.tagName.toLowerCase() + id + cls;
  }
  function reachable(node, top) {
    if (top === node || node.contains(top) || top.contains(node)) return true;
    var label = node.closest ? node.closest('label') : null;
    if (label && label.contains(top)) return true;
    var sw = node.closest ? node.closest('.switch') : null;
    if (sw && sw.contains(top)) return true;
    return false;
  }
  function realClick(node, point) {
    var r = node.getBoundingClientRect();
    var x = point ? point.x : r.left + r.width / 2, y = point ? point.y : r.top + r.height / 2;
    var top = document.elementFromPoint(x, y) || node;
    var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0 };
    try { top.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
    top.dispatchEvent(new MouseEvent('mousedown', opts));
    try { top.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
    top.dispatchEvent(new MouseEvent('mouseup', opts));
    top.dispatchEvent(new MouseEvent('click', opts));
    return top;
  }
  function coveredAudit() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('#main button, #main a[href], #main input, #main select, #main textarea'));
    var CAP = 30;
    if (nodes.length > CAP) { var stride = Math.ceil(nodes.length / CAP); nodes = nodes.filter(function (_, i) { return i % stride === 0; }); }
    var bad = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!shown(n) || n.disabled) continue;
      var det = n.closest ? n.closest('details') : null;
      if (det && det.open !== true) continue;
      var r = n.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (r.width === 0 || r.height === 0) continue;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      var top = document.elementFromPoint(x, y);
      if (!top || reachable(n, top)) continue;
      bad.push({ el: describe(n), coveredBy: describe(top) });
    }
    return { checked: nodes.length, bad: bad.slice(0, 6) };
  }
  async function waitFor(fn, ms) {
    var deadline = Date.now() + ms;
    for (;;) {
      try { if (fn()) return true; } catch (e) {}
      if (Date.now() > deadline) return false;
      await sleep(100);
    }
  }
  function finish(out) { document.getElementById('__probe').textContent = b64(JSON.stringify(out)); }

  async function main() {
    var out = { width: innerWidth, login: {}, routes: [], interactions: {}, errors: [], fatal: null };
    await sleep(300);

    var loginEl = document.querySelector('#login');
    var appEl = document.querySelector('#app');
    out.login.loginShown = !!loginEl && !loginEl.classList.contains('off');
    out.login.appHidden = !!appEl && appEl.classList.contains('off');

    // ── 真实登录表单 ────────────────────────────────────────────────────────
    var pw = document.querySelector('#pw');
    if (!pw) { out.fatal = '登录表单没渲染'; return finish(out); }
    pw.value = window.__PROBE_PASSWORD__;
    document.querySelector('#loginform').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    var loggedIn = await waitFor(function () {
      return !appEl.classList.contains('off') && document.querySelectorAll('#navlist .navlink').length > 0;
    }, 12000);
    out.login.loggedIn = loggedIn;
    if (!loggedIn) { out.fatal = '登录后应用没有出现'; out.errors = (window.__probeErrors || []).slice(0, 20); return finish(out); }
    await sleep(250);

    // ── 每个页面的期望配置行数（来自 /api/schema）──────────────────────────
    var expected = {};
    try {
      var tok = sessionStorage.getItem('dsh_admin_token') || '';
      var schema = await (await fetch('/api/schema', { headers: { authorization: 'Bearer ' + tok } })).json();
      for (var fi = 0; fi < schema.fields.length; fi++) {
        var pg = schema.fields[fi].page;
        expected[pg] = (expected[pg] || 0) + 1;
      }
    } catch (e) { out.schemaError = String(e && e.message); }

    // ── 全部路由扫一遍 ──────────────────────────────────────────────────────
    var links = Array.prototype.slice.call(document.querySelectorAll('#navlist .navlink'));
    out.navCount = links.length;
    for (var li = 0; li < links.length; li++) {
      var link = links[li];
      location.hash = link.getAttribute('href');
      await sleep(380);
      var main = document.querySelector('#main');
      var mainText = (main.innerText || '').replace(/\s+/g, ' ').trim();
      var de = document.documentElement;
      out.routes.push({
        route: link.dataset.route,
        key: String(link.dataset.route || '').split('/')[1],
        title: (document.querySelector('#pagetitle') || {}).textContent || '',
        overflow: de.scrollWidth - de.clientWidth,
        textLen: mainText.length,
        cards: main.querySelectorAll('.card').length,
        rows: main.querySelectorAll('.cfgrow').length,
        errbar: document.querySelector('#errbar').classList.contains('show'),
        renderFail: mainText.indexOf('渲染失败') >= 0,
      });
    }
    out.totalRows = out.routes.reduce(function (n, r) { return n + r.rows; }, 0);
    out.expectedTotal = Object.keys(expected).reduce(function (n, k) { return n + expected[k]; }, 0);
    out.rowCheck = [];
    for (var ri = 0; ri < out.routes.length; ri++) {
      var rt = out.routes[ri];
      var want = expected[rt.key] || 0;
      if (rt.rows !== want) out.rowCheck.push({ route: rt.route, expected: want, rendered: rt.rows });
    }

    var probeWidth = typeof window.__PROBE_WIDTH__ === 'number' ? window.__PROBE_WIDTH__ : innerWidth;
    out.interactions.interact = !window.__PROBE_READONLY__ && (probeWidth === 360 || probeWidth === 1280);

    if (out.interactions.interact) {
      // ── 主题（切一次看变化，再点两下回到跟随系统）───────────────────────
      var bgBefore = getComputedStyle(document.body).backgroundColor;
      document.querySelector('#themebtn').click();
      await sleep(160);
      var bgAfter = getComputedStyle(document.body).backgroundColor;
      out.interactions.theme = { before: bgBefore, after: bgAfter, changed: bgBefore !== bgAfter, attr: de.getAttribute('data-theme') };
      document.querySelector('#themebtn').click();
      await sleep(80);
      document.querySelector('#themebtn').click();
      await sleep(80);

      // ── 抽屉（窄屏）───────────────────────────────────────────────────────
      if (innerWidth < 900) {
        var nav = document.querySelector('#sidenav');
        var scrim = document.querySelector('#scrim');
        var toggle = document.querySelector('#navtoggle');
        out.interactions.drawer = { toggleVisible: shown(toggle) };
        realClick(toggle);
        await sleep(250);
        out.interactions.drawer.opened = nav.classList.contains('open') && scrim.classList.contains('show');
        var navStyle = getComputedStyle(nav);
        out.interactions.drawer.openStyle = navStyle.display + '/' + navStyle.visibility + '/' + navStyle.transform;
        // 遮罩的几何中心在抽屉（左移层）底下：要点"露出来的"右边缘——那才是用户真能点到的地方。
        var clickPoint = { x: innerWidth - 14, y: innerHeight / 2 };
        var clickHit = document.elementFromPoint(clickPoint.x, clickPoint.y);
        out.interactions.drawer.hitAtEdge = clickHit ? describe(clickHit) : null;
        var scrimStyle = getComputedStyle(scrim);
        out.interactions.drawer.scrimStyle = scrimStyle.display + '/' + scrimStyle.visibility + '/' + scrimStyle.pointerEvents + '/z' + scrimStyle.zIndex;
        var sr = scrim.getBoundingClientRect();
        out.interactions.drawer.scrimRect = Math.round(sr.left) + ',' + Math.round(sr.top) + ' ' + Math.round(sr.width) + 'x' + Math.round(sr.height) + ' vp=' + innerWidth + 'x' + innerHeight;
        realClick(scrim, clickPoint);
        await sleep(250);
        out.interactions.drawer.closed = !nav.classList.contains('open');
        if (!out.interactions.drawer.closed) {
          // 直接派发（绕开命中测试）：用来分辨"没点到遮罩"还是"点了没反应"。
          scrim.click();
          await sleep(120);
          out.interactions.drawer.closedDirect = !nav.classList.contains('open');
        }
      }

      // ── 键盘可达 ──────────────────────────────────────────────────────────
      var kb = { navlink: null, palette: null, focusVisibleRule: false };
      try {
        for (var si = 0; si < document.styleSheets.length; si++) {
          var rules = document.styleSheets[si].cssRules || [];
          for (var rj = 0; rj < rules.length; rj++) {
            if (String(rules[rj].selectorText || '').indexOf(':focus-visible') >= 0) kb.focusVisibleRule = true;
          }
        }
      } catch (e) {}
      if (innerWidth < 900) { realClick(document.querySelector('#navtoggle')); await sleep(200); }
      kb.drawerOpenBeforeFocus = document.querySelector('#sidenav').classList.contains('open');
      var firstLink = document.querySelector('#navlist .navlink');
      firstLink.focus();
      kb.activeIsLink = document.activeElement === firstLink;
      kb.linkShown = shown(firstLink);
      kb.navlink = kb.activeIsLink && kb.linkShown;
      if (innerWidth < 900) { realClick(document.querySelector('#scrim'), { x: innerWidth - 14, y: innerHeight / 2 }); await sleep(180); }
      var pal = document.querySelector('#palettebtn');
      if (pal && pal.offsetParent !== null) { pal.focus(); kb.palette = document.activeElement === pal; }
      else kb.palette = 'hidden';
      out.interactions.keyboard = kb;

      // ── ⌘K 定位到具体配置项 ───────────────────────────────────────────────
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await sleep(220);
      var pinput = document.querySelector('#dialog-root .palette-input');
      out.interactions.palette = { opened: !!pinput, items: 0, hash: '', rowExists: false, flashed: false };
      if (pinput) {
        pinput.value = 'tts.provider';
        pinput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(160);
        var items = document.querySelectorAll('#dialog-root .palette-item');
        out.interactions.palette.items = items.length;
        if (items.length > 0) {
          items[0].click();
          await sleep(480);
          out.interactions.palette.hash = location.hash;
          out.interactions.palette.rowExists = document.querySelector('.cfgrow[data-path="tts.provider"]') !== null;
          out.interactions.palette.flashed = document.querySelector('.cfgrow.flash') !== null;
        }
      }

      // ── 开关 → 保存条 → diff 对话框 → 确认保存 → 后端回读 ────────────────
      location.hash = '#/module/groups';
      await sleep(450);
      var row = document.querySelector('.cfgrow[data-path="groupEnabled"]');
      var cb = row ? row.querySelector('input[type=checkbox]') : null;
      var sv = { rowFound: !!cb };
      out.interactions.save = sv;
      if (cb) {
        var was = cb.checked;
        realClick(row.querySelector('.switch .track') || cb);
        await sleep(260);
        sv.toggled = cb.checked !== was;
        var bar = document.querySelector('.savebar');
        sv.barOn = !!bar && bar.classList.contains('on');
        var saveBtn = bar ? Array.prototype.slice.call(bar.querySelectorAll('button')).find(function (b) { return (b.textContent || '').indexOf('保存') >= 0; }) : null;
        if (saveBtn) {
          realClick(saveBtn);
          await sleep(320);
          var dialog = document.querySelector('#dialog-root .dialog');
          sv.diffShown = !!dialog && dialog.querySelectorAll('.difftable tr').length >= 2;
          var confirm = dialog ? Array.prototype.slice.call(dialog.querySelectorAll('.dialog-foot button')).find(function (b) { return (b.textContent || '').indexOf('确认保存') >= 0; }) : null;
          if (confirm) { realClick(confirm); await sleep(1000); }
          sv.toast = document.querySelector('#toasts .toast') !== null;
          sv.cleared = !document.querySelector('.savebar').classList.contains('on');
          try {
            var tok2 = sessionStorage.getItem('dsh_admin_token') || '';
            var snap = await (await fetch('/api/snapshot', { headers: { authorization: 'Bearer ' + tok2 } })).json();
            sv.persisted = snap.config.groupEnabled === cb.checked;
          } catch (e) { sv.persisted = 'err ' + (e && e.message); }
        }
      }

      // ── 遮挡审计（当前停在群聊页）─────────────────────────────────────────
      out.interactions.covered = coveredAudit();
    }

    out.errbarFinal = document.querySelector('#errbar').classList.contains('show');
    out.errors = (window.__probeErrors || []).slice(0, 30);
    finish(out);
  }

  window.addEventListener('load', function () {
    setTimeout(function () {
      main().catch(function (e) {
        finish({ crash: String(e && e.stack ? e.stack : e) });
      });
    }, 400);
  });
})();
</script>`

function proxy(req, res) {
  let u
  try { u = new URL(backend.base) } catch { res.writeHead(502); res.end('bad backend'); return }
  const upstream = httpRequest({
    host: u.hostname,
    port: u.port,
    path: req.url,
    method: req.method,
    headers: req.headers, // Host/Origin 原样转发——后端的同源校验要对得上
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers)
    up.pipe(res)
  })
  upstream.on('error', () => { try { if (!res.headersSent) res.writeHead(502); res.end('proxy error') } catch (e) {} })
  req.pipe(upstream)
}

const server = createServer((req, res) => {
  const url = req.url ?? '/'
  if (verbose) console.log(`[page] ${req.method} ${url}`)
  if (url.startsWith('/api/events')) {
    // SSE 就地掐断：即便某个客户端绕过 EventSource 桩改用 fetch 流式读，
    // 也只会看到一条立刻结束的流——pending fetch 会把虚拟时间钉住，
    // dump-dom 永不返回（上一轮 4 个宽度全部 ETIMEDOUT 的头号嫌疑）。
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.end('retry: 2000\n\n')
    return
  }
  if (url.startsWith('/api/')) { proxy(req, res); return }
  const pathname = url.split('?')[0]
  let body = null
  let type = 'text/plain; charset=utf-8'
  if (pathname === '/' || pathname === '/index.html') {
    // 每个宽度把自己的目标宽度塞进查询串：设备缩放会让 innerWidth ≠ --window-size，
    // 交互档位（360/1280）不能再靠 innerWidth 猜。
    const probeWidth = Number(new URL(url, 'http://127.0.0.1').searchParams.get('w') ?? '0')
    const widthTag = (probeWidth > 0 ? `<script>window.__PROBE_WIDTH__=${probeWidth};</script>` : '') + `<script>window.__PROBE_READONLY__=${READONLY};</script>`
    body = files.get('index.html').replace('</head>', widthTag + HEAD_SCRIPT + '\n</head>').replace('</body>', BODY_SCRIPT + '\n</body>')
    type = 'text/html; charset=utf-8'
  } else if (url.startsWith('/ui/')) {
    const rel = url.slice(4).split('?')[0]
    const content = files.get(rel)
    if (content !== undefined) {
      body = content
      type = rel.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
    }
  }
  if (body === null) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const pagePort = server.address().port
const PAGE = `http://127.0.0.1:${pagePort}`

// ── 3) 逐宽度驱动 Chrome ────────────────────────────────────────────────────
/**
 * 跑一次 headless Chrome，收集它的 stdout（`--dump-dom` 的 DOM）。
 *
 * **必须 spawn（异步），不能用 execFileSync**：探针的后端与页面服务器跑在同一个
 * 事件循环里，同步调用会把整条循环钉住——Chrome 的导航请求永远等不到响应，
 * 虚拟时间不开始，dump-dom 不返回（前两轮 4×ETIMEDOUT 的根因就在这里）。
 * 超时用 taskkill /T 杀整棵进程树，避免 chrome 的子进程留下占住管道。
 */
function runChrome(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    child.stdout.setEncoding('utf8')
    let out = ''
    let settled = false
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value) } }
    const timer = setTimeout(() => {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch (e) {}
      settle(reject, new Error(`Chrome ${timeoutMs}ms 未退出（进程树已杀）`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', (error) => settle(reject, error))
    child.on('close', () => settle(resolve, out))
  })
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'admin-probe-'))
const results = {}
const problems = []

for (const width of WIDTHS) {
  const profile = path.join(tmp, `profile-${width}`)
  let dom
  try {
    dom = await runChrome([
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--no-proxy-server', // 直连本机，不走系统代理
      // 关掉 Chrome 自己的后台网络（组件更新/变体种子），少一份"页面之外"的挂起点。
      '--disable-background-networking',
      '--disable-component-update',
      `--user-data-dir=${profile}`,
      `--window-size=${width},900`,
      // 虚拟时间预算要覆盖：登录 + 27 页 × 380ms + 交互 ≈ 15s 虚拟秒。
      '--virtual-time-budget=40000',
      '--dump-dom',
      `${PAGE}/?w=${width}`,
    ], 90_000)
  } catch (error) {
    problems.push(`${width}px: Chrome 调用失败 — ${error.message}`)
    continue
  }
  const match = /<pre id="__probe"[^>]*>([A-Za-z0-9+/=]+)<\/pre>/.exec(dom)
  if (match === null) {
    problems.push(`${width}px: 没拿到探针报告（页面可能没跑起来）`)
    continue
  }
  const report = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
  results[width] = report
  if (report.crash !== undefined) {
    problems.push(`${width}px: 探针自身崩了 — ${String(report.crash).split('\n')[0]}`)
    continue
  }
  if (report.fatal) {
    problems.push(`${width}px: ${report.fatal}`)
    if (report.errors && report.errors.length > 0) problems.push(`${width}px: JS 报错 ${JSON.stringify(report.errors.slice(0, 6))}`)
    continue
  }

  const where = (msg) => problems.push(`${width}px: ${msg}`)
  if (!report.login.loginShown || !report.login.appHidden) where('初始没有显示登录页或应用没有隐藏')
  if (report.navCount !== EXPECTED_NAV) where(`导航有 ${report.navCount} 项（应为 ${EXPECTED_NAV}）`)
  if (report.schemaError) where('拉取 /api/schema 失败：' + report.schemaError)

  for (const rt of report.routes) {
    if (rt.overflow > 1) where(`${rt.route} 横向滚动 +${rt.overflow}px`)
    if (rt.textLen < 30) where(`${rt.route} 内容近乎为空（${rt.textLen} 字）`)
    if (rt.cards < 1) where(`${rt.route} 没有卡片`)
    if (rt.errbar) where(`${rt.route} 显示了错误条`)
    if (rt.renderFail) where(`${rt.route} 渲染失败`)
    if (!rt.title) where(`${rt.route} 页标题为空`)
  }
  for (const rc of report.rowCheck ?? []) {
    where(`${rc.route} 配置行数 ${rc.rendered} ≠ schema 期望 ${rc.expected}（有配置项没落在页面上）`)
  }

  const inter = report.interactions ?? {}
  if (inter.interact) {
    if (!inter.theme || inter.theme.changed !== true) where('主题切换没有改变背景色：' + JSON.stringify(inter.theme))
    if (!inter.keyboard || inter.keyboard.navlink !== true) where('导航链接无法聚焦（键盘不可达）')
    if (!inter.keyboard || inter.keyboard.palette === false) where('顶栏按钮无法聚焦')
    if (!inter.keyboard || inter.keyboard.focusVisibleRule !== true) where('样式表里没有 :focus-visible 规则')
    if (!inter.palette || !inter.palette.opened) where('Ctrl+K 没有打开命令面板')
    else {
      if (inter.palette.items < 1) where('命令面板搜索 tts.provider 没有结果')
      if (String(inter.palette.hash).indexOf('focus=tts.provider') < 0) where('命令面板选择后没有跳转（hash=' + inter.palette.hash + '）')
      if (!inter.palette.rowExists) where('跳转后目标配置行不在 DOM 里')
    }
    if (!inter.save || !inter.save.rowFound) where('群聊页找不到 groupEnabled 配置行')
    else {
      const s = inter.save
      if (!s.toggled) where('点开关圆钮没有切换')
      if (!s.barOn) where('改动后保存条没有出现')
      if (!s.diffShown) where('保存前没有出现 diff 对话框')
      if (!s.toast) where('确认保存后没有回执 toast')
      if (!s.cleared) where('保存后保存条没有消失')
      if (s.persisted !== true) where('保存后后端快照没有生效（persisted=' + String(s.persisted) + '）')
    }
    for (const b of (inter.covered?.bad ?? [])) {
      where(`控件被遮挡：${b.el} ← ${b.coveredBy}`)
    }
  }
  if (width < 900 && inter.interact) {
    const d = inter.drawer ?? {}
    if (!d.toggleVisible) where('窄屏看不到抽屉按钮')
    if (!d.opened) where('点抽屉按钮没有打开侧栏')
    if (!d.closed) where('点遮罩没有关掉侧栏')
  }
  if (report.errors.length > 0) where('JS 报错：' + JSON.stringify(report.errors.slice(0, 8)))
  if (report.errbarFinal) where('结束时有错误条')
}

// ── 4) 摘要与收尾 ───────────────────────────────────────────────────────────
console.log(`Chrome: ${chrome}`)
console.log(`后端:   ${backend.base}（一次性本地实例）`)
console.log(`页面:   ${PAGE}/（src/admin/ui/** + /api 反代）\n`)
for (const width of WIDTHS) {
  const r = results[width]
  if (r === undefined || r.routes === undefined) continue
  const maxOverflow = Math.max(...r.routes.map((x) => x.overflow))
  console.log(`${String(width).padStart(4)}px  路由 ${r.routes.length}  配置行 ${r.totalRows}/${r.expectedTotal}  最大横向溢出 ${maxOverflow}px  错误 ${r.errors.length}  窗口 ${r.width}px  交互 ${r.interactions?.interact ? '开' : '关'}`)
  if (verbose && r.interactions?.interact) console.log(`      交互原始值: ${JSON.stringify(r.interactions)}`)
}

try { server.close() } catch (e) {}
try { await backend.stop() } catch (e) {}
if (!keep) rmSync(tmp, { recursive: true, force: true })

if (problems.length > 0) {
  console.log(`\n==== ${problems.length} 个问题 ====`)
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('\n==== 全部检查通过 ====')
if (keep) console.log(`（临时目录保留在 ${tmp}）`)
