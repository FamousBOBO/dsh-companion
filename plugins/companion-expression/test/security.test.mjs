/**
 * security.mjs 的离线测试：全部用假 fetch，绝不真发请求。
 *
 * 覆盖完成判据里的四项：SSRF 拒私网、体积超限拒、文件名穿越拒，外加字节判型/像素上限、
 * 重定向每跳重判、真实路径边界与暂存目录 TTL 清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MAX_BYTES, SecurityError, assertFetchableUrl, assertSafeFilename, assertInsideReal,
  blockedHostReason, cleanStage, createGuardedHttp, realpathInside, safeJoin,
  sniffImageFormat, validateImage,
} from '../src/security.mjs';

/* ---------- 合成图片：只造头部，够判型与读尺寸 ---------- */

function makePng({ width = 64, height = 64, extra = 0 } = {}) {
  const buffer = Buffer.alloc(33 + extra, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function makeJpeg({ width = 32, height = 32 } = {}) {
  const buffer = Buffer.alloc(48, 0x22);
  buffer[0] = 0xff; buffer[1] = 0xd8; buffer[2] = 0xff; buffer[3] = 0xe0;
  buffer.writeUInt16BE(16, 4);          // APP0 段长 16 → 下一段从 20 开始
  buffer[20] = 0xff; buffer[21] = 0xc0; // SOF0
  buffer.writeUInt16BE(17, 22);
  buffer[24] = 8;                        // 精度
  buffer.writeUInt16BE(height, 25);
  buffer.writeUInt16BE(width, 27);
  return buffer;
}

function makeGif({ width = 64, height = 48, animated = false } = {}) {
  const buffer = Buffer.alloc(64, 0x33);
  buffer.write('GIF89a', 0, 'latin1');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  if (animated) buffer.write('NETSCAPE2.0', 30, 'latin1');
  return buffer;
}

function makeWebp({ width = 100, height = 80 } = {}) {
  const buffer = Buffer.alloc(64, 0x44);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(56, 4);
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8X', 12, 'latin1');
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function makeBmp({ width = 32, height = 32 } = {}) {
  const buffer = Buffer.alloc(64, 0x55);
  buffer.write('BM', 0, 'latin1');
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  return buffer;
}

/** 形状够用的 Response 替身（带 headers.get、arrayBuffer，可选流式 body）。 */
function fakeResponse({ status = 200, bytes = Buffer.alloc(0), headers = {}, stream = null } = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: key => map.get(String(key).toLowerCase()) ?? null },
    body: stream,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/* ---------- 判型 ---------- */

test('字节魔数判型：PNG/JPEG/GIF/WebP/BMP 认得出，非图片返回 null', () => {
  assert.equal(sniffImageFormat(makePng()).kind, 'png');
  assert.equal(sniffImageFormat(makeJpeg()).kind, 'jpeg');
  assert.equal(sniffImageFormat(makeGif()).kind, 'gif');
  assert.equal(sniffImageFormat(makeWebp()).kind, 'webp');
  assert.equal(sniffImageFormat(makeBmp()).kind, 'bmp');
  // 内容与后缀无关：这段字节被命名为 .png 也不会改变判定结果
  assert.equal(sniffImageFormat(makeGif({ animated: true })).ext, '.gif');
  assert.equal(sniffImageFormat(Buffer.from('not an image at all')), null);
  assert.equal(sniffImageFormat(Buffer.alloc(4)), null);
});

test('尺寸读取：PNG/JPEG/GIF/WebP/BMP 都能读出宽高', () => {
  assert.deepEqual([sniffImageFormat(makePng({ width: 800, height: 600 })).width,
    sniffImageFormat(makePng({ width: 800, height: 600 })).height], [800, 600]);
  const jpeg = sniffImageFormat(makeJpeg({ width: 120, height: 90 }));
  assert.deepEqual([jpeg.width, jpeg.height], [120, 90]);
  const gif = sniffImageFormat(makeGif({ width: 320, height: 240 }));
  assert.deepEqual([gif.width, gif.height], [320, 240]);
  const webp = sniffImageFormat(makeWebp({ width: 256, height: 256 }));
  assert.deepEqual([webp.width, webp.height], [256, 256]);
});

test('validateImage：体积超限拒、空体拒、非图片 Content-Type 拒', () => {
  const bytes = makePng({ extra: 512 });
  const tooLarge = validateImage({ bytes, maxBytes: bytes.length - 1 });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.reasonCode, 'too-large');

  assert.equal(validateImage({ bytes: Buffer.alloc(0) }).reasonCode, 'empty-body');
  const text = Buffer.alloc(64, 0x61);
  assert.equal(validateImage({ bytes: text, declaredMime: 'text/html' }).reasonCode, 'not-an-image');
  assert.equal(validateImage({ bytes: text }).reasonCode, 'unknown-format');
});

test('validateImage：像素/单边上限，声明 MIME 与字节不符时按字节为准', () => {
  assert.equal(validateImage({ bytes: makePng({ width: 20000, height: 10 }) }).reasonCode, 'too-large-dimension');
  assert.equal(validateImage({ bytes: makePng({ width: 7000, height: 7000 }) }).reasonCode, 'too-many-pixels');
  const mismatched = validateImage({ bytes: makePng(), declaredMime: 'image/jpeg' });
  assert.equal(mismatched.ok, true);
  assert.equal(mismatched.mimeMismatch, true);
  assert.equal(mismatched.format.mime, 'image/png');
  const unknownMime = validateImage({ bytes: makePng(), declaredMime: 'application/octet-stream' });
  assert.equal(unknownMime.ok, true);
  assert.equal(unknownMime.mimeMismatch, false);
});

/* ---------- SSRF ---------- */

test('SSRF：拒 file:/本机/私网/链路本地/元数据/带凭据地址', () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/a.png',
    'http://127.0.0.1/a.png',
    'http://localhost/a.png',
    'http://10.1.2.3/a.png',
    'http://172.16.0.9/a.png',
    'http://192.168.1.1/a.png',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/a.png',
    'http://[fe80::1]/a.png',
    'http://metadata.google.internal/x',
    'http://user:pass@example.com/a.png',
    'http://0/a.png',
    'http://2130706433/a.png',
  ]) {
    assert.throws(() => assertFetchableUrl(url), error => error instanceof SecurityError, `应拒绝 ${url}`);
  }
  assert.equal(assertFetchableUrl('https://cdn.example.com/a.png').hostname, 'cdn.example.com');
  assert.equal(blockedHostReason('192.168.2.9'), 'private-address');
  assert.equal(blockedHostReason('cdn.example.com'), '');
});

/* ---------- 重定向 ---------- */

function sequenceFetch(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push(String(url));
      const next = typeof responses === 'function' ? responses(index, url) : responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next;
    },
  };
}

test('重定向：≤2 跳通过，第 3 跳被拦，且每一跳都重新判地址', async () => {
  const png = makePng();
  const two = sequenceFetch([
    fakeResponse({ status: 302, headers: { location: 'https://cdn.example.com/b.png' } }),
    fakeResponse({ status: 302, headers: { location: 'https://cdn.example.com/c.png' } }),
    fakeResponse({ bytes: png, headers: { 'content-type': 'image/png' } }),
  ]);
  const http = createGuardedHttp({ fetchImpl: two.fetchImpl });
  const result = await http.get('https://cdn.example.com/a.png');
  assert.equal(result.status, 200);
  assert.equal(result.hops.length, 3);
  assert.equal(result.bytes.length, png.length);

  const three = sequenceFetch([
    fakeResponse({ status: 302, headers: { location: 'https://cdn.example.com/b.png' } }),
    fakeResponse({ status: 302, headers: { location: 'https://cdn.example.com/c.png' } }),
    fakeResponse({ status: 302, headers: { location: 'https://cdn.example.com/d.png' } }),
    fakeResponse({ bytes: png }),
  ]);
  await assert.rejects(() => createGuardedHttp({ fetchImpl: three.fetchImpl }).get('https://cdn.example.com/a.png'),
    error => error.code === 'redirect-limit');

  // 第一跳是公网、第二跳指向本机：每跳重判，所以第二跳被拒
  const bounce = sequenceFetch([
    fakeResponse({ status: 302, headers: { location: 'http://127.0.0.1:8080/evil.png' } }),
    fakeResponse({ bytes: png }),
  ]);
  await assert.rejects(() => createGuardedHttp({ fetchImpl: bounce.fetchImpl }).get('https://cdn.example.com/a.png'),
    error => error.code === 'host-blocked');
  assert.equal(bounce.calls.length, 1, '第二跳被拒时不该再去请求它');
});

test('体积上限在 http 层：Content-Length 声明超限与流式超限都拒', async () => {
  const declared = sequenceFetch([fakeResponse({ bytes: Buffer.alloc(10), headers: { 'content-length': '999999' } })]);
  await assert.rejects(() => createGuardedHttp({ fetchImpl: declared.fetchImpl }).get('https://cdn.example.com/big.png', { maxBytes: 1024 }),
    error => error.code === 'too-large');

  async function* chunks() {
    for (let index = 0; index < 20; index += 1) yield Buffer.alloc(100);
  }
  const streamed = sequenceFetch([fakeResponse({ stream: chunks() })]);
  await assert.rejects(() => createGuardedHttp({ fetchImpl: streamed.fetchImpl }).get('https://cdn.example.com/big.png', { maxBytes: 1000 }),
    error => error.code === 'too-large');
  assert.equal(DEFAULT_MAX_BYTES, 10 * 1024 * 1024);
});

/* ---------- 文件名与真实路径 ---------- */

test('文件名穿越：分隔符/`..`/绝对路径/保留字符/保留名全部拒绝', () => {
  for (const name of ['../x.png', 'a/b.png', 'a\\b.png', 'C:\\evil.png', '/etc/passwd', '..', 'x\u0001.png', 'con.png', 'a:b.png']) {
    assert.throws(() => assertSafeFilename(name), error => error instanceof SecurityError, `应拒绝文件名 ${name}`);
  }
  assert.equal(assertSafeFilename('sticker.png'), 'sticker.png');
});

test('safeJoin 与真实路径边界：`..` 逃逸与目录外文件都挡得住', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-sec-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-out-'));
  try {
    fs.writeFileSync(path.join(root, 'ok.png'), 'x');
    fs.writeFileSync(path.join(outside, 'evil.png'), 'x');
    assert.equal(safeJoin(root, 'ok.png'), path.join(root, 'ok.png'));
    assert.equal(realpathInside(root, path.join(root, 'ok.png')).ok, true);
    assert.equal(realpathInside(root, path.join(outside, 'evil.png')).reason, 'outside');
    assert.throws(() => assertInsideReal(root, path.join(outside, 'evil.png')), error => error.code === 'path-escape');
    assert.equal(realpathInside(root, path.join(root, 'missing.png')).reason, 'child-missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('暂存目录 TTL 清理：只删过期普通文件，不递归、不跟目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-stage-'));
  try {
    const old = path.join(root, 'old.png');
    const fresh = path.join(root, 'fresh.png');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    const now = Date.now();
    fs.utimesSync(old, new Date(now - 3_600_000), new Date(now - 3_600_000));
    fs.mkdirSync(path.join(root, 'subdir'));
    const report = cleanStage({ root, ttlMs: 600_000, now: () => now });
    assert.equal(report.ok, true);
    assert.deepEqual(report.removed.map(row => row.name), ['old.png']);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(path.join(root, 'subdir')), true, '不递归删除目录');
    assert.equal(cleanStage({ root: path.join(root, 'nope') }).ok, false);
    assert.equal(cleanStage({ root, ttlMs: 600_000, now: () => now, dryRun: true }).removed.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
