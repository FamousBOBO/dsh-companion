/** B站音轨：选流排序、多地址回退、以及"下载不带 Cookie"这条取舍的**断言**。
 *
 * 为什么这组用例单独成文件：`bili-audio.ts` 是从 `bili.ts` 拆出来的（`bili.ts` 曾涨到
 * 463 行撞 400 行硬上限），它守的是**两个实机事实**，而这两条都不是"接口语义"：
 *
 *   1. `baseUrl` 不一定通（实机 `ECONNREFUSED` 打在 `*.mcdn.bilivideo.cn:8082`），
 *      同一段音频的 `backupUrl` 一秒能下 6.2 MB。所以"一个音频 = 一组地址"。
 *   2. 截断的 m4s 比失败更糟（转出来的 wav 是一首没有结尾的歌，后面的分离/推理会
 *      把它当完整的歌处理）。
 *
 * 这两条一旦被"顺手简化"回"只认 baseUrl"，点歌链路会在**只有这首歌**上失败，
 * 而且报错离原因很远。所以这里全部离线：假件不让任何请求真的发出去。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { HttpOptions, HttpResponse } from '../src/ports/http.js'
import type { ProcessPort, ProcessResult } from '../src/features/song/types.js'

const {
  AUDIO_HEADERS, AUDIO_LIMIT, AUDIO_TIMEOUT_MS, pickBestAudio,
} = await import('../src/adapters/song/bili-audio.js')
const { createBiliPort } = await import('../src/adapters/song/bili.js')

/** 一次假响应；`abort: true` 表示"这条路连不上"（没有响应，只有连接错误）。 */
interface Route {
  match: string
  reply?: { status?: number; body: string }
  abort?: string
}

/** 记录调用、按 URL 子串回放响应的假 `HttpClient`；未配的 URL 一律当"连不上"。 */
function fakeHttp(routes: Route[]): {
  http: { request(url: string, options?: HttpOptions): Promise<HttpResponse> }
  calls: Array<{ url: string; options: HttpOptions }>
} {
  const calls: Array<{ url: string; options: HttpOptions }> = []
  return {
    calls,
    http: {
      async request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
        calls.push({ url, options })
        const hit = routes.find((route) => url.includes(route.match))
        // 没配这条 → 模拟 `ECONNREFUSED`：`fetch` 的错误形状就是 cause.code。
        if (hit === undefined || hit.abort !== undefined) {
          throw Object.assign(new Error('fetch failed'), { cause: { code: hit?.abort ?? 'ECONNREFUSED' } })
        }
        const body = hit.reply?.body ?? ''
        const status = hit.reply?.status ?? 200
        return {
          status,
          ok: status >= 200 && status < 300,
          url,
          bytes: new Uint8Array(Buffer.from(body, 'utf-8')),
          truncated: false,
          header: () => null,
          headerValues: () => [],
          text: () => body,
          json: <T,>() => JSON.parse(body) as T,
        }
      },
    },
  }
}

/** 记录 ffmpeg 参数、把目标文件真的写出来的假 `ProcessPort`。 */
function fakeProcess(): { port: ProcessPort; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  return {
    calls,
    port: {
      async run(command: string, args: readonly string[]): Promise<ProcessResult> {
        calls.push({ command, args: [...args] })
        const dest = args[args.length - 1]
        if (dest !== undefined) writeFileSync(dest, 'wav')
        return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
      },
    },
  }
}

/** 一次测试用的工作目录（凭据与临时 m4s 都落这里，绝不写仓库）。 */
function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'song-bili-audio-'))
}

/** playurl 响应：给三条音轨，最高带宽那条带三个地址（base + 两个 backup）。 */
function playurlWith(baseUrl: string, backups: string[], extraBandwidth = 169316): string {
  return JSON.stringify({
    code: 0,
    data: {
      durl: [],
      dash: {
        audio: [
          { id: 30216, bandwidth: 38231, baseUrl: 'https://low.example/a.m4s' },
          { id: 30280, bandwidth: extraBandwidth, baseUrl, backupUrl: backups },
        ],
      },
    },
  })
}

test('AUDIO_HEADERS：故意不带 Cookie（凭据不该发给只做分发的 CDN 主机）', () => {
  // 这条不是"检查常量"那么无聊：`AUDIO_HEADERS` 是新拆出来的 **export**，谁都能复用。
  // 一旦有人为了"图省事"把它改成带上 Cookie，SESSDATA 就会跟着每一个音频请求出门。
  assert.equal(AUDIO_HEADERS.Cookie, undefined)
  assert.equal(AUDIO_HEADERS.cookie, undefined)
  assert.match(AUDIO_HEADERS['User-Agent'] ?? '', /Chrome/)
  assert.equal(AUDIO_HEADERS.Referer, 'https://www.bilibili.com/')
  // 上限是给"下载字节"用的，不能悄悄被人调成无限。
  assert.equal(AUDIO_LIMIT, 32 * 1024 * 1024)
  assert.equal(AUDIO_TIMEOUT_MS >= 60_000, true, '下载超时必须比接口超时宽，它要真的搬字节')
})

test('pickBestAudio：取带宽最大的一条，并把它的地址排成"非 mcdn 优先"', () => {
  const track = pickBestAudio({
    audio: [
      { id: 30216, bandwidth: 38231, baseUrl: 'https://a.example/low.m4s' },
      {
        id: 30280,
        bandwidth: 169316,
        // 真实形状：B站 给的边缘节点是 `xxx.mcdn.bilivideo.cn:8082`。
        baseUrl: 'https://xy1x2.mcdn.bilivideo.cn:8082/edge.m4s',
        backupUrl: ['https://b.example/one.m4s', 'https://c.example/two.m4s'],
      },
    ],
  })
  assert.equal(track.id, 30280)
  assert.equal(track.bandwidth, 169316)
  assert.equal(track.urls.length, 3)
  // mcdn 那条实测会 ECONNREFUSED：排最后，但不删（万一哪天它才是唯一通的）。
  assert.equal(track.urls.includes('https://xy1x2.mcdn.bilivideo.cn:8082/edge.m4s'), true)
  assert.equal(track.urls[track.urls.length - 1], 'https://xy1x2.mcdn.bilivideo.cn:8082/edge.m4s')
  assert.deepEqual([...track.urls].sort(), [
    'https://b.example/one.m4s',
    'https://c.example/two.m4s',
    'https://xy1x2.mcdn.bilivideo.cn:8082/edge.m4s',
  ].sort())
})

test('pickBestAudio：认旧版字段名（base_url / backup_url），协议相对 URL 补 https，重复地址去重', () => {
  const track = pickBestAudio({
    audio: [{
      bandwidth: 96_000,
      base_url: '//cdn.example/best.m4s',
      backup_url: ['https://cdn.example/best.m4s', '  ', 'ftp://cdn.example/nope'],
    }],
  })
  assert.equal(track.urls.length, 1, '重复与空串、非 http(s) 都要被剔掉')
  assert.equal(track.urls[0], 'https://cdn.example/best.m4s', '协议相对 URL 必须补 https:')
})

test('pickBestAudio：dash 为空 / 只有无地址音轨时抛可读错误，不是 TypeError', () => {
  assert.throws(() => pickBestAudio(undefined), /没有可用的音轨/)
  assert.throws(() => pickBestAudio({ audio: [] }), /没有可用的音轨/)
  assert.throws(() => pickBestAudio({ audio: [{ id: 1, bandwidth: 5, baseUrl: '' }] }), /没有可用的音轨/)
})

test('下载：baseUrl 连不上时自动换 backupUrl（这是实机修掉的 bug，不许回退）', async () => {
  const dir = scratch()
  const destFile = path.join(dir, 'audio.wav')
  const { http, calls } = fakeHttp([
    { match: '/x/player/playurl', reply: { body: playurlWith('//mcdn.example:8082/edge.m4s', ['https://ok.example/backup.m4s']) } },
    { match: 'mcdn.example', abort: 'ECONNREFUSED' },
    { match: 'ok.example', reply: { body: 'M4S' } },
  ])
  const logs: string[] = []
  const bili = createBiliPort({
    http,
    credentialFile: path.join(dir, 'bili_credential.json'),
    ffmpegPath: 'ffmpeg',
    process: fakeProcess().port,
    log: (line) => logs.push(line),
    workRoot: dir,
  })

  const got = await bili.downloadAudio('BV1d4411N7zD', 317843818, destFile)
  assert.equal(got.file, destFile)

  const attempted = calls.filter((call) => call.url.includes('.m4s'))
  assert.equal(attempted.length, 2, '第一条连不上之后必须再试下一条')
  assert.equal(attempted[0]?.url, 'https://mcdn.example:8082/edge.m4s')
  assert.equal(attempted[1]?.url, 'https://ok.example/backup.m4s')
  assert.ok(logs.some((line) => line.includes('连不上')), '换地址这件事必须留痕，否则查不出"为什么慢了"')
  // 日志里不打印完整签名 URL（会被截图外传）。
  assert.equal(logs.some((line) => line.includes('backup.m4s')), false)
})

test('下载：非 2xx 不换地址（那是上游说"没权限/文件没了"，换一条只会把 403 藏起来）', async () => {
  const dir = scratch()
  const { http, calls } = fakeHttp([
    { match: '/x/player/playurl', reply: { body: playurlWith('https://a.example/one.m4s', ['https://b.example/two.m4s']) } },
    { match: 'a.example', reply: { status: 403, body: 'denied' } },
  ])
  const bili = createBiliPort({
    http, credentialFile: path.join(dir, 'c.json'), ffmpegPath: 'ffmpeg',
    process: fakeProcess().port, log: () => {}, workRoot: dir,
  })

  await assert.rejects(
    () => bili.downloadAudio('BV1d4411N7zD', 317843818, path.join(dir, 'a.wav')),
    /HTTP 403/,
  )
  assert.equal(calls.filter((call) => call.url.includes('.m4s')).length, 1, '403 之后不该再试备份地址')
})

test('下载：所有地址都连不上时，错误里写明"几条都失败"并附原因', async () => {
  const dir = scratch()
  const { http } = fakeHttp([
    {
      match: '/x/player/playurl',
      reply: { body: playurlWith('https://a.example/one.m4s', ['https://b.example/two.m4s', 'https://c.example/three.m4s']) },
    },
    { match: 'a.example', abort: 'ECONNREFUSED' },
    { match: 'b.example', abort: 'ECONNRESET' },
    { match: 'c.example', abort: 'ETIMEDOUT' },
  ])
  const logs: string[] = []
  const bili = createBiliPort({
    http, credentialFile: path.join(dir, 'c.json'), ffmpegPath: 'ffmpeg',
    process: fakeProcess().port, log: (line) => logs.push(line), workRoot: dir,
  })

  await assert.rejects(
    () => bili.downloadAudio('BV1d4411N7zD', 317843818, path.join(dir, 'a.wav')),
    (error: Error) => {
      assert.match(error.message, /3 条地址都连不上/)
      assert.match(error.message, /ECONNREFUSED/)
      assert.match(error.message, /ETIMEDOUT/)
      return true
    },
  )
  assert.equal(logs.filter((line) => line.includes('连不上')).length, 3)
})

test('下载：503（上游临时不可用）也换地址——实机 `baseUrl` 回 503、`backupUrl` 能下', async () => {
  // 这一条守的是"换地址"的两个理由里第二个：**连不上**之外还有**暂时不可用**。
  // 实机踩过：`30280` 的 `baseUrl` 回 `HTTP 503`，同一段音频的 `backupUrl` 立刻能下 6 MB。
  // 只认连接错误的话，这类上游抖动会被当成"这首歌下不了"。
  const dir = scratch()
  const destFile = path.join(dir, 'audio.wav')
  const { http, calls } = fakeHttp([
    { match: '/x/player/playurl', reply: { body: playurlWith('https://a.example/one.m4s', ['https://b.example/two.m4s']) } },
    { match: 'a.example', reply: { status: 503, body: 'busy' } },
    { match: 'b.example', reply: { body: 'M4S' } },
  ])
  const logs: string[] = []
  const bili = createBiliPort({
    http, credentialFile: path.join(dir, 'c.json'), ffmpegPath: 'ffmpeg',
    process: fakeProcess().port, log: (line) => logs.push(line), workRoot: dir,
  })

  const got = await bili.downloadAudio('BV1d4411N7zD', 317843818, destFile)
  assert.equal(got.file, destFile)

  const attempted = calls.filter((call) => call.url.includes('.m4s'))
  assert.equal(attempted.length, 2, '503 之后必须再试下一条（它不是终态）')
  assert.equal(attempted[0]?.url, 'https://a.example/one.m4s')
  assert.equal(attempted[1]?.url, 'https://b.example/two.m4s')
  assert.ok(logs.some((line) => line.includes('暂时不可用')), '换地址的理由要留痕，否则和"连不上"混在一起没法查')
})

test('下载：所有地址都给 503 时，报的是"HTTP 503"而不是"都连不上"', async () => {
  // 这是一条**措辞**断言，但它决定人怎么查：说"连不上"会让人去查网络/防火墙，
  // 而真实原因是上游在限流/抖动。所以最后一个临时错误必须被带回调用方。
  const dir = scratch()
  const { http, calls } = fakeHttp([
    {
      match: '/x/player/playurl',
      reply: { body: playurlWith('https://a.example/one.m4s', ['https://b.example/two.m4s']) },
    },
    { match: 'a.example', reply: { status: 503, body: 'busy' } },
    { match: 'b.example', reply: { status: 429, body: 'slow down' } },
  ])
  const bili = createBiliPort({
    http, credentialFile: path.join(dir, 'c.json'), ffmpegPath: 'ffmpeg',
    process: fakeProcess().port, log: () => {}, workRoot: dir,
  })

  await assert.rejects(
    () => bili.downloadAudio('BV1d4411N7zD', 317843818, path.join(dir, 'a.wav')),
    (error: Error) => {
      assert.match(error.message, /HTTP 429/, '要报**最后**那个响应码')
      assert.equal(/连不上/.test(error.message), false, '全是临时错误时不该说"连不上"')
      return true
    },
  )
  assert.equal(calls.filter((call) => call.url.includes('.m4s')).length, 2, '两个地址都要试过')
})

test('下载：超上限的字节直接拒，不转码（截断的 wav 比失败更糟）', async () => {
  const dir = scratch()
  const { http } = fakeHttp([
    { match: '/x/player/playurl', reply: { body: playurlWith('https://a.example/one.m4s', []) } },
    { match: 'a.example', reply: { body: 'M4S' } },
  ])
  const { port: processPort, calls: processCalls } = fakeProcess()
  // `HttpClient` 报 truncated 时，说明它按 limit 截断了——这段音频没有结尾。
  const truncating = {
    async request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
      const res = await http.request(url, options)
      return { ...res, truncated: url.includes('.m4s') }
    },
  }
  const bili = createBiliPort({
    http: truncating, credentialFile: path.join(dir, 'c.json'), ffmpegPath: 'ffmpeg',
    process: processPort, log: () => {}, workRoot: dir,
  })

  await assert.rejects(
    () => bili.downloadAudio('BV1d4411N7zD', 317843818, path.join(dir, 'a.wav')),
    /超过 33554432 字节上限/,
  )
  assert.equal(processCalls.length, 0, '被截断的字节不该进 ffmpeg')
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.m4s')), [], '拒了也要清临时文件')
})
