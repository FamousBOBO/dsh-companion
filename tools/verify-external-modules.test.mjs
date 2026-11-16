import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyModule, PINS } from './verify-external-modules.mjs';

// 外部模块指纹校验（首席裁决 2026-11-14）。
//
// 判据不是"版本号对不对"，而是"字节是不是同一份"。实测背景：本机 profile 里的
// `dsh-bili-scroll@2.4.0` 是 211655 字节且**不含** provider publish 代码，另一份同版本号的
// 备份是 213810 字节且含 —— 靠 version 字段无法区分。
//
// 这一组用合成目录造四种安装形态，钉住四个具名 code。

function fixture(t, { bytes = 'console.log("x");\n', version = '2.4.0' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-mod-'));
  const dir = path.join(root, 'dsh-bili-scroll');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), bytes);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-bili-scroll', version }));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  return root;
}

const pin = PINS['dsh-bili-scroll'];
const goodSource = `const providers = process[Symbol.for('dsh.companion.bilibili.providers.v1')] ??= new Map();\nproviders.set('k', {});\n`;

test('file-missing：没装就是没装，不能当成"零候选"', async t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'dsh-bili-scroll'), { recursive: true, force: true });
  const result = verifyModule({ moduleRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'file-missing');
  assert.match(result.note, /拒绝派发/);
});

test('hash-mismatch：字节不同就拒绝（版本号相同不算证据）', async t => {
  // Same version string as the pin, different bytes; contains the publish markers on purpose, so
  // the only thing that can reject it is the hash.
  const root = fixture(t, { bytes: goodSource, version: pin.version });
  const result = verifyModule({ moduleRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'hash-mismatch');
  assert.equal(result.version, pin.version, 'the version field really does match — that is the trap');
  assert.equal(result.bytesMatch, false);
});

test('provider-publish-absent：字节匹配但源码里没有 publish（判据二独立成立）', async t => {
  // Gate 2 has to be provable on its own: a copy whose hash matches a pin we control, but whose
  // source lacks the registry publish markers, must be reported — not accepted.
  const bytes = 'noop\n';
  const controlled = { 'dsh-bili-scroll': { version: '2.4.0', indexSha256: crypto.createHash('sha256').update(bytes).digest('hex'), expectedBytes: bytes.length, requiresProviderPublish: true } };
  const root = fixture(t, { bytes, version: '2.4.0' });
  const result = verifyModule({ moduleRoot: root, pins: controlled });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'provider-publish-absent');
  assert.deepEqual(result.missingMarkers, ['dsh.companion.bilibili.providers.v1', 'providers.set(']);
  assert.match(result.note, /provider 永远不会 ready/);
});

test('判据二的对照：同一份字节补上 publish 代码后必须通过（否则这个门是死的）', async t => {
  const bytes = goodSource;
  const controlled = { 'dsh-bili-scroll': { version: '2.4.0', indexSha256: crypto.createHash('sha256').update(bytes).digest('hex'), expectedBytes: Buffer.byteLength(bytes), requiresProviderPublish: true } };
  const root = fixture(t, { bytes, version: '2.4.0' });
  const result = verifyModule({ moduleRoot: root, pins: controlled });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ok');
  assert.deepEqual(result.missingMarkers, []);
});

test('hash-mismatch 优先于 provider-publish-absent：先问字节，再问内容', async t => {
  const root = fixture(t, { bytes: goodSource, version: pin.version });
  const result = verifyModule({ moduleRoot: root });
  assert.equal(result.code, 'hash-mismatch');
  assert.deepEqual(result.missingMarkers, [], 'the source does contain the markers — only the bytes differ');
});

test('no-pin：没有固定指纹的模块直接判不可校验，不默认通过', async t => {
  const root = fixture(t);
  const result = verifyModule({ moduleRoot: root, name: 'some-other-module' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-pin');
});

test('固定指纹本身是 64 位小写 hex（防止写错的 pin 静默放行）', async () => {
  assert.match(pin.indexSha256, /^[0-9a-f]{64}$/);
  assert.equal(pin.requiresProviderPublish, true);
  assert.equal(crypto.createHash('sha256').update('').digest('hex').length, 64);
});
