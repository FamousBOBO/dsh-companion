// 量一下网页端到底把图显示成多大 —— "不放大看就是糊的"要能被数字确认。
//
// 输出三个数就够：图片的真实像素、它被显示的 CSS 像素、`clientWidth > naturalWidth` 是否成立。
// 后者为真就说明**浏览器把一张小图放大了**，那就是糊的成因（不是图本身的问题）。
//
// 三个坑（都踩过，别改回去）：
//   1. 服务端没有 SPA 回退：`/chat/dm/4` 是 404，真实路径是 hash 路由 `/#/chat/dm/4`。
//   2. localStorage 必须在应用脚本之前写好，否则客户端读到空 authData 并静默跳 `/#/login`。
//      用 `Page.addScriptToEvaluateOnNewDocument`。
//   3. 消息懒加载：只探首屏会得到"0 张图"。要往上滚，但必须有界（滚到底就停）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ORIGIN = 'http://127.0.0.1:3009';
const DB = 'D:/DSH/vocechat/vocechat-data/db/db.sqlite';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9412;
const DM = 4;
const MAX_SCROLLS = 10;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function credentials() {
  const db = new DatabaseSync(DB, { readOnly: true });
  for (const row of db.prepare('select device,token from refresh_token where uid=1').all()) {
    const res = await fetch(`${ORIGIN}/api/token/renew`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x', refresh_token: row.token }),
    });
    if (!res.ok) continue;
    const body = await res.json();
    const me = await fetch(`${ORIGIN}/api/user/me`, { headers: { 'x-api-key': body.token } });
    if (!me.ok) continue;
    return { token: body.token, refresh: body.refresh_token ?? row.token, device: row.device, user: await me.json() };
  }
  throw new Error('没有可用的 uid=1 refresh token');
}

async function main() {
  const cred = await credentials();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-measure-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--force-device-scale-factor=2', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let version = null;
    for (let i = 0; i < 80; i += 1) {
      try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
      catch { await sleep(250); }
    }
    if (!version) throw new Error('Chrome 调试端口没起来');

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id === undefined) return;
      const slot = pending.get(msg.id);
      if (slot) { pending.delete(msg.id); slot(msg); }
    });
    const send = (method, params = {}, sessionId) => new Promise(resolve => {
      id += 1;
      const myId = id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

    const created = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
    const sid = attached.result.sessionId;
    await send('Page.enable', {}, sid);
    await send('Runtime.enable', {}, sid);

    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        localStorage.setItem('VOCECHAT_TOKEN', ${JSON.stringify(cred.token)});
        localStorage.setItem('VOCECHAT_REFRESH_TOKEN', ${JSON.stringify(cred.refresh)});
        localStorage.setItem('VOCECHAT_CURR_UID', '1');
        localStorage.setItem('VOCECHAT_TOKEN_EXPIRE', String(Date.now() + 3600000));
        localStorage.setItem('VOCECHAT_DEVICE_KEY', ${JSON.stringify(cred.device ?? 'dsh-measure')});
        localStorage.setItem('VOCECHAT_LOGIN_USER', ${JSON.stringify(JSON.stringify(cred.user))});
      })()`,
    }, sid);

    await send('Page.navigate', { url: `${ORIGIN}/#/chat/dm/${DM}` }, sid);
    await sleep(9000);

    // 停在**最近的消息**处。图片就在最近几条里；往上滚到顶反而会把它们卸载掉
    // （列表是虚拟化的，滚出去的消息连同 img 一起被回收，探到的就是空数组）。
    for (let i = 0; i < 4; i += 1) {
      await send('Runtime.evaluate', {
        expression: `(() => {
          const s = [...document.querySelectorAll('div')]
            .filter(d => d.scrollHeight > d.clientHeight + 80)
            .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
          if (s) { s.scrollTop = s.scrollHeight; return s.scrollHeight; }
          window.scrollTo(0, document.body.scrollHeight); return -1;
        })()`,
        returnByValue: true,
      }, sid);
      await sleep(1500);
    }
    await sleep(3000);

    const probe = await send('Runtime.evaluate', {
      expression: `(() => {
        const rows = [];
        for (const img of document.querySelectorAll('img')) {
          const src = img.currentSrc || img.src;
          if (!src.includes('/api/resource/file')) continue;
          rows.push({
            thumb: /thumbnail=true/.test(src),
            natural: img.naturalWidth + 'x' + img.naturalHeight,
            client: Math.round(img.clientWidth) + 'x' + Math.round(img.clientHeight),
            upscale: img.clientWidth > img.naturalWidth + 1,
            loaded: img.complete && img.naturalWidth > 0,
          });
        }
        return JSON.stringify({
          dpr: window.devicePixelRatio,
          viewport: window.innerWidth + 'x' + window.innerHeight,
          url: location.href,
          fileImgs: rows,
        });
      })()`,
      returnByValue: true,
    }, sid);
    console.log(probe.result?.result?.value);

    const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
    if (shot.result?.data) {
      const out = 'D:/DSH/dsh-production/data/workspace/media/vc-web-measure.png';
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      console.log('截图:', out);
    }
  } finally {
    chrome.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
  }
}

main().catch(error => { console.error('FAIL', String(error?.message ?? error)); process.exitCode = 1; });
