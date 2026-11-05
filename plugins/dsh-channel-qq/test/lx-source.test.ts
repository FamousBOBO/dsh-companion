/** 落雪音源运行时：协议、沙箱边界、超时。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { runLxScript } = await import('../src/adapters/lx-source/runtime.js')

const SCRIPT = `
const { EVENT_NAMES, request, on, send } = globalThis.lx;
const get = (url) => new Promise((resolve, reject) => {
  request(url, { method: 'GET' }, (err, res) => err ? reject(err) : resolve(res));
});
on(EVENT_NAMES.request, async ({ action, source, info }) => {
  if (action !== 'musicUrl') throw new Error('unsupported');
  const res = await get('https://api.example.test/url?song=' + info.musicInfo.songmid + '&q=' + info.type);
  // LX 的宿主会先把 JSON 响应解析成对象；这里两种都认（真实音源有的两种都写）。
  return typeof res.body === 'string' ? JSON.parse(res.body).url : res.body.url;
});
send(EVENT_NAMES.inited, { status: true, sources: { wy: { name: 'wy', actions: ['musicUrl'] } } });
`

function fakeHttp(payload: unknown) {
  const calls: string[] = []
  return {
    calls,
    http: {
      request: async (url: string) => {
        calls.push(url)
        return {
          ok: true,
          status: 200,
          url,
          bytes: new Uint8Array(),
          truncated: false,
          header: () => null,
          headerValues: () => [],
          text: () => JSON.stringify(payload),
          json: () => payload,
        }
      },
    } as never,
  }
}

test('音源：声明音源、按 action 取播放地址', async () => {
  const { calls, http } = fakeHttp({ url: 'https://cdn.example.test/a.mp3' })
  const loaded = runLxScript(SCRIPT, { http })
  assert.deepEqual(Object.keys(loaded.sources), ['wy'])
  const url = await loaded.resolveUrl({
    source: 'wy',
    musicInfo: { songmid: '29713754' },
    quality: '320k',
  })
  assert.equal(url, 'https://cdn.example.test/a.mp3')
  assert.equal(calls.length, 1)
  assert.match(calls[0] ?? '', /song=29713754/)
  assert.match(calls[0] ?? '', /q=320k/)
})

test('音源：脚本拿不到 process/require（干净上下文）', () => {
  assert.throws(() => runLxScript(`
    globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, { sources: {} });
    process.exit(1);
  `), /process is not defined/)
  assert.throws(() => runLxScript(`
    globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, { sources: {} });
    require('node:fs');
  `), /require is not defined/)
})

test('音源：没有 inited / 没有处理器都拒绝', () => {
  assert.throws(() => runLxScript('const x = 1'), /inited/)
  assert.throws(() => runLxScript(`
    globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, { sources: {} });
  `), /request/)
})

test('音源：同步死循环被超时打断', () => {
  assert.throws(() => runLxScript(`
    globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, { sources: {} });
    while (true) {}
  `, { runTimeoutMs: 50 }), /timed out|Script execution/i)
})

test('音源：解析结果不是 http(s) 时拒绝', async () => {
  const { http } = fakeHttp({ url: 'ftp://bad' })
  const loaded = runLxScript(SCRIPT, { http })
  await assert.rejects(() => loaded.resolveUrl({ source: 'wy', musicInfo: { songmid: '1' }, quality: '320k' }), /播放地址/)
})
