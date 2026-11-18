// 媒体投递：把本机文件发到 VoceChat，把收到的媒体落成本机文件。
//
// 这里每一条断言都对应一次真实的事故或实测契约，不是"函数返回值对不对"：
//   - 认不出 MIME 就硬发 → 一张图在客户端变成一个要下载的附件，看起来像失败又不是失败；
//   - 目录边界只做字符串前缀 → `workspace/../secrets` 通得过，凭据被发进聊天；
//   - 入站不落盘 → 模型自己翻文件系统，一轮烧掉 6 次 pwsh 才找到一个 70 字节的图。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mimeOf, withinRoots, readForSend, inboxTarget, writeInbox } from '../media.mjs';

function tmp(prefix = 'vc-media-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('MIME 按扩展名判定，认不出的返回 null（调用方必须拒绝而不是硬发）', () => {
  assert.deepEqual(mimeOf('a.png'), { mime: 'image/png', kind: 'image' });
  assert.deepEqual(mimeOf('a.JPG'), { mime: 'image/jpeg', kind: 'image' });
  assert.deepEqual(mimeOf('voice.wav'), { mime: 'audio/wav', kind: 'audio' });
  assert.deepEqual(mimeOf('voice.ogg'), { mime: 'audio/ogg', kind: 'audio' });
  assert.deepEqual(mimeOf('clip.mp4'), { mime: 'video/mp4', kind: 'video' });
  assert.deepEqual(mimeOf('doc.pdf'), { mime: 'application/pdf', kind: 'file' });
  assert.equal(mimeOf('a.unknownext'), null);
  assert.equal(mimeOf('noext'), null);
  assert.equal(mimeOf(''), null);
});

test('目录边界用 realpath 判定：`..` 逃逸被拒绝', () => {
  const root = tmp();
  const work = path.join(root, 'workspace');
  const secrets = path.join(root, 'secrets');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(secrets, { recursive: true });
  const inside = path.join(work, 'ok.png');
  const outside = path.join(secrets, 'key.png');
  fs.writeFileSync(inside, 'x');
  fs.writeFileSync(outside, 'x');

  assert.equal(withinRoots(inside, [work]).ok, true);
  // 字符串前缀会放过这一条，realpath 不会。
  assert.deepEqual(withinRoots(path.join(work, '..', 'secrets', 'key.png'), [work]), { ok: false, reason: 'outside-boundary' });
  assert.deepEqual(withinRoots(outside, [work]), { ok: false, reason: 'outside-boundary' });
});

test('相对路径、不存在的文件、空路径都明确拒绝（不退回"放行"）', () => {
  const root = tmp();
  assert.deepEqual(withinRoots('a.png', [root]), { ok: false, reason: 'not-absolute' });
  assert.deepEqual(withinRoots(path.join(root, 'missing.png'), [root]), { ok: false, reason: 'not-found' });
  assert.deepEqual(withinRoots('', [root]), { ok: false, reason: 'empty-path' });
});

test('没有可用的根目录时一律拒绝（不是"没有限制"）', () => {
  const root = tmp();
  const file = path.join(root, 'a.png');
  fs.writeFileSync(file, 'x');
  assert.deepEqual(withinRoots(file, []), { ok: false, reason: 'outside-boundary' });
  assert.deepEqual(withinRoots(file, ['', null, undefined]), { ok: false, reason: 'outside-boundary' });
});

test('读取发送文件：空文件与超限都拒绝，正常文件返回字节', () => {
  const root = tmp();
  const file = path.join(root, 'a.png');
  fs.writeFileSync(file, Buffer.alloc(10, 1));
  const ok = readForSend(file, 1024);
  assert.equal(ok.ok, true);
  assert.equal(ok.size, 10);

  fs.writeFileSync(path.join(root, 'empty.png'), '');
  assert.deepEqual(readForSend(path.join(root, 'empty.png'), 1024), { ok: false, reason: 'empty-file' });

  fs.writeFileSync(path.join(root, 'big.png'), Buffer.alloc(2048, 1));
  const big = readForSend(path.join(root, 'big.png'), 1024);
  assert.equal(big.ok, false);
  assert.match(big.reason, /^too-large:/);

  assert.deepEqual(readForSend(path.join(root, 'nope.png'), 1024), { ok: false, reason: 'not-found' });
});

test('目录不是文件时也拒绝（否则会把一个目录当成 0 字节文件发出去）', () => {
  const root = tmp();
  const dir = path.join(root, 'sub');
  fs.mkdirSync(dir);
  assert.deepEqual(readForSend(dir, 1024), { ok: false, reason: 'not-a-file' });
});

test('入站落盘按 mid 命名：同一条消息重投命中同一个文件', () => {
  const dataRoot = tmp();
  const first = inboxTarget({ dataRoot, mid: 690, mime: 'image/png' });
  const again = inboxTarget({ dataRoot, mid: 690, mime: 'image/png' });
  assert.equal(first.absolute, again.absolute);
  assert.equal(first.relative, 'mid-690.png');
  // SSE 重连会重投同一段帧 —— 名字必须稳定，否则 inbox 里会堆一串同样内容的副本。
  assert.match(first.absolute, /home[\\/]vocechat-adapter[\\/]inbox/);
});

test('入站落盘按 MIME 选扩展名，未知类型用 .bin 而不是猜', () => {
  const dataRoot = tmp();
  assert.equal(inboxTarget({ dataRoot, mid: 1, mime: 'image/jpeg' }).relative, 'mid-1.jpg');
  assert.equal(inboxTarget({ dataRoot, mid: 2, mime: 'audio/opus' }).relative, 'mid-2.opus');
  assert.equal(inboxTarget({ dataRoot, mid: 3, mime: 'application/weird' }).relative, 'mid-3.bin');
});

test('写入入站文件会建目录，并把字节原样写进去', () => {
  const dataRoot = tmp();
  const target = inboxTarget({ dataRoot, mid: 5, mime: 'image/png' });
  const bytes = Buffer.from([1, 2, 3, 4]);
  const written = writeInbox(target, bytes);
  assert.equal(written.ok, true);
  assert.equal(written.size, 4);
  assert.deepEqual(fs.readFileSync(target.absolute), bytes);
});

test('写入失败返回原因而不是抛（一张图取不到不该让整批文字发不出去）', () => {
  const dataRoot = tmp();
  // 用一个已存在的“文件”占住目录位，mkdir 会失败。
  const blocked = path.join(dataRoot, 'home', 'vocechat-adapter', 'inbox');
  fs.mkdirSync(path.dirname(blocked), { recursive: true });
  fs.writeFileSync(blocked, 'not a directory');
  const result = writeInbox(inboxTarget({ dataRoot, mid: 6, mime: 'image/png' }), Buffer.from([1]));
  assert.equal(result.ok, false);
  assert.match(result.reason, /^write-failed:/);
});
