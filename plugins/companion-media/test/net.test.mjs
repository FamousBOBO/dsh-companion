import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet, DEFAULT_MAX_BYTES } from '../src/net.mjs';
import { makeResponse, makePng } from './helpers.mjs';
import { Code } from '../src/errors.mjs';

const PNG = makePng({ extra: 64 });

function fetchSequence(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push(String(url));
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      const value = typeof next === 'function' ? next(url, init) : next;
      if (value instanceof Error) throw value;
      return makeResponse(value);
    },
  };
}

test('总 deadline 有默认值，且可配置（超时映射为 MEDIA_TIMEOUT）', async () => {
  // 用一个"永不返回、但尊重 abort"的 fetch 验证 deadline 真的会中断
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const net = createNet({ fetchImpl: hangingFetch });
  const started = Date.now();
  await assert.rejects(
    () => net.request('http://127.0.0.1:9/slow', { timeoutMs: 120 }),
    error => error.code === Code.TIMEOUT,
  );
  assert.ok(Date.now() - started < 2000, '必须在 deadline 附近返回，而不是一直挂住');

  // deadline 是单次请求的参数（默认 60s，由 provider.timeoutMs 与 limits.requestBudgetMs 取小）
  const ok = createNet({ fetchImpl: async () => makeResponse({ status: 200, json: { ok: true } }) });
  const response = await ok.request('http://127.0.0.1:9/fast');
  assert.equal(response.status, 200);
});

test('跳转上限：2 次跳转可通过，第 3 次被拦', async () => {
  const twoHops = fetchSequence([
    { status: 302, bytes: Buffer.alloc(0), headers: { location: 'http://127.0.0.1:9/b' } },
    { status: 302, bytes: Buffer.alloc(0), headers: { location: 'http://127.0.0.1:9/c' } },
    { status: 200, bytes: PNG, headers: { 'content-type': 'image/png' } },
  ]);
  const net = createNet({ fetchImpl: twoHops.fetchImpl });
  const result = await net.request('http://127.0.0.1:9/a', { maxRedirects: 2 });
  assert.equal(result.status, 200);
  assert.equal(result.hops.length, 3);

  const threeHops = fetchSequence([
    { status: 302, bytes: Buffer.alloc(0), headers: { location: 'http://127.0.0.1:9/b' } },
    { status: 302, bytes: Buffer.alloc(0), headers: { location: 'http://127.0.0.1:9/c' } },
    { status: 302, bytes: Buffer.alloc(0), headers: { location: 'http://127.0.0.1:9/d' } },
    { status: 200, bytes: PNG, headers: { 'content-type': 'image/png' } },
  ]);
  const net2 = createNet({ fetchImpl: threeHops.fetchImpl });
  await assert.rejects(
    () => net2.request('http://127.0.0.1:9/a', { maxRedirects: 2 }),
    error => error.code === Code.DOWNLOAD_BLOCKED,
  );
});

test('字节上限：恰好等于上限通过，超一字节报 TOO_LARGE', async () => {
  const exact = createNet({ fetchImpl: async () => makeResponse({ status: 200, bytes: Buffer.alloc(100), headers: { 'content-type': 'application/octet-stream' } }) });
  const ok = await exact.request('http://127.0.0.1:9/x', { maxBytes: 100 });
  assert.equal(ok.bytes.length, 100);

  const over = createNet({ fetchImpl: async () => makeResponse({ status: 200, bytes: Buffer.alloc(101), headers: { 'content-type': 'application/octet-stream' } }) });
  await assert.rejects(
    () => over.request('http://127.0.0.1:9/x', { maxBytes: 100 }),
    error => error.code === Code.TOO_LARGE,
  );
});

test('三档字节上限都在 net 层生效：响应体 / 图片 / 音频', async () => {
  // 响应体档
  const bodyFetch = async () => makeResponse({ status: 200, bytes: Buffer.alloc(2048), headers: { 'content-type': 'application/json' } });
  const netBody = createNet({ fetchImpl: bodyFetch });
  await assert.rejects(
    () => netBody.request('http://127.0.0.1:9/x', { maxBytes: 1024 }),
    error => error.code === Code.TOO_LARGE,
  );
  // 图片档 / 音频档：同一个 net，只是调用方传不同上限（服务层分别传 maxImageBytes / maxAudioBytes）
  const imageNet = createNet({ fetchImpl: async () => makeResponse({ status: 200, bytes: PNG, headers: { 'content-type': 'image/png' } }) });
  const imageOk = await imageNet.request('http://127.0.0.1:9/i.png', { maxBytes: PNG.length });
  assert.equal(imageOk.bytes.length, PNG.length);
  await assert.rejects(
    () => imageNet.request('http://127.0.0.1:9/i.png', { maxBytes: PNG.length - 1 }),
    error => error.code === Code.TOO_LARGE,
  );
  const audioNet = createNet({ fetchImpl: async () => makeResponse({ status: 200, bytes: Buffer.alloc(4096), headers: { 'content-type': 'audio/wav' } }) });
  await assert.rejects(
    () => audioNet.request('http://127.0.0.1:9/a.wav', { maxBytes: 4095 }),
    error => error.code === Code.TOO_LARGE,
  );
});

test('声明的 Content-Length 超限时在读取前就拒绝', async () => {
  const { fetchImpl, calls } = fetchSequence([
    { status: 200, bytes: Buffer.alloc(10), headers: { 'content-type': 'application/octet-stream', 'content-length': '999999' } },
  ]);
  const net = createNet({ fetchImpl });
  await assert.rejects(
    () => net.request('http://127.0.0.1:9/x', { maxBytes: 1024 }),
    error => error.code === Code.TOO_LARGE && /declares/.test(error.message),
  );
  assert.equal(calls.length, 1);
});

test('协议与地址白名单：file:/ / metadata 地址被拒', async () => {
  const net = createNet({ fetchImpl: async () => makeResponse({ status: 200, bytes: Buffer.alloc(0) }) });
  await assert.rejects(() => net.request('file:///etc/passwd'), error => error.code === Code.DOWNLOAD_BLOCKED);
  await assert.rejects(() => net.request('http://169.254.169.254/latest/meta-data'), error => error.code === Code.DOWNLOAD_BLOCKED);
  await assert.rejects(() => net.request('not a url'), error => error.code === Code.DOWNLOAD_BLOCKED);
  // 本机地址必须允许：TTS 服务就在 127.0.0.1
  const local = await net.request('http://127.0.0.1:7860/health', { maxBytes: 16 });
  assert.equal(local.status, 200);
});

test('连接失败映射为 MEDIA_NETWORK，不泄漏内部细节以外的内容', async () => {
  const net = createNet({ fetchImpl: async () => { throw new Error('fetch failed'); } });
  await assert.rejects(
    () => net.request('http://127.0.0.1:9/x', { provider: 'Breeze' }),
    error => error.code === Code.NETWORK && /Breeze is unreachable/.test(error.message),
  );
});

test('默认响应体上限是一个明确的数字（16 MiB）', () => {
  assert.equal(DEFAULT_MAX_BYTES, 16 * 1024 * 1024);
});
