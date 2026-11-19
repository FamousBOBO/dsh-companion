// 以主人身份在频道里说一句话（用于实测群聊链路）。
//
// 为什么用独立 device：`refresh_token` 的唯一键是 (uid, device)，而 `/api/token/renew`
// 会**轮换**并把新值写回数据库。用手机或浏览器那个 device 会让对方立刻 401
// （2026-11-17 真的踩过：手机之后每条请求都 401）。所以这里只用自己的 device 文件。
//
// 用法：
//   node send-as-owner.mjs "要说的内容"            # 频道 1
//   node send-as-owner.mjs "内容" 3                # 指定 gid

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.VOCECHAT_BASE ?? 'http://127.0.0.1:3009';
const SECRETS = 'D:/DSH/vocechat/secrets';
const CRED = path.join(SECRETS, 'owner-refresh.json');

const text = String(process.argv[2] ?? '').trim();
const gid = Number(process.argv[3] ?? 1) || 1;
if (text === '') {
  console.error('用法: node send-as-owner.mjs "内容" [gid]');
  process.exit(2);
}

const cred = JSON.parse(fs.readFileSync(CRED, 'utf8'));
if (!cred.refreshToken) {
  console.error('owner-refresh.json 里没有 refreshToken');
  process.exit(2);
}

// renew 只校验 refresh_token；access token 传占位符即可（实测）。
const renew = await fetch(`${BASE}/api/token/renew`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'x', refresh_token: cred.refreshToken }),
});
if (!renew.ok) {
  console.error(`renew failed: ${renew.status} ${(await renew.text()).slice(0, 200)}`);
  process.exit(1);
}
const parsed = await renew.json();
// 把轮换后的新值写回自己的文件：这条链归本脚本所有，不回写下次就用不了。
if (typeof parsed.refresh_token === 'string' && parsed.refresh_token) {
  fs.writeFileSync(CRED, `${JSON.stringify({ ...cred, refreshToken: parsed.refresh_token, rotatedAt: new Date().toISOString() }, null, 2)}\n`);
}

const send = await fetch(`${BASE}/api/group/${gid}/send`, {
  method: 'POST',
  headers: { 'x-api-key': parsed.token, 'content-type': 'text/plain' },
  body: text,
});
const body = await send.text();
console.log(`send ${send.status} mid=${body.trim()}`);
if (!send.ok) process.exit(1);
