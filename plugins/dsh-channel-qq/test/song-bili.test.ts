/** B站适配器：搜索归一化、视频信息、playurl 选流、可读错误、下载转码。
 *
 * 这组用例全部离线：`HttpClient` 是注入的假件，`ProcessPort` 只记录参数并写出目标
 * 文件，一次网络请求都不发。守的是**归一化合同**——上游字段名与形状是会变的
 * （`<em>` 高亮、`"4:30"` 文本时长、协议相对 URL、空的 `durl`），而队列只认
 * `features/song/types.ts` 里的形状。中间少做一步，坏的是整条点歌链路，
 * 而且报错的地方离原因很远。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, promises as fs, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { HttpOptions, HttpResponse } from '../src/ports/http.js'
import type { ProcessPort, ProcessResult } from '../src/features/song/types.js'

const { createBiliPort, cleanBiliText, parseBiliDuration } = await import('../src/adapters/song/bili.js')
const { createProcessPort } = await import('../src/adapters/song/process.js')

/** 一次假响应的内容。 */
interface Reply {
  status?: number
  body: string
}

/** 记录调用、按 URL 前缀回放固定响应的假 `HttpClient`。 */
function fakeHttp(routes: Array<{ match: string; reply: Reply }>): {
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
        if (hit === undefined) throw new Error(`假件没有配这个 URL：${url}`)
        const status = hit.reply.status ?? 200
        const bytes = new Uint8Array(Buffer.from(hit.reply.body, 'utf-8'))
        return {
          status,
          ok: status >= 200 && status < 300,
          url,
          bytes,
          truncated: false,
          header: () => null,
          headerValues: () => [],
          text: () => hit.reply.body,
          json: <T,>() => JSON.parse(hit.reply.body) as T,
        }
      },
    },
  }
}

/** 记录参数、把最后一参数（目标文件）真的写出来的假 `ProcessPort`。 */
function fakeProcess(outBytes = 'fake-wav'): { port: ProcessPort; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  return {
    calls,
    port: {
      async run(command: string, args: readonly string[]): Promise<ProcessResult> {
        calls.push({ command, args: [...args] })
        const dest = args[args.length - 1]
        if (dest !== undefined) writeFileSync(dest, outBytes)
        return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
      },
    },
  }
}

/** 一次测试用的工作目录（凭据与临时 m4s 都落这里，绝不写仓库）。 */
function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'song-bili-'))
}

/** 写一份凭据文件；`null` 表示"不写"（模拟读不到）。 */
async function credential(dir: string, value: object | null): Promise<string> {
  const file = path.join(dir, 'bili_credential.json')
  if (value !== null) await fs.writeFile(file, JSON.stringify(value), 'utf-8')
  return file
}

const SEARCH_REPLY = JSON.stringify({
  code: 0,
  message: 'OK',
  data: {
    result: [
      {
        bvid: 'BV1BZbSzZEGT',
        title: '【Hi-Res】《<em class="keyword">晴天</em>》- <em class="keyword">周杰伦</em>',
        author: 'VV<em class="keyword">音乐</em>局',
        duration: '4:30',
        play: 3439152,
        description: '仅用于音乐分享 &amp; 交流',
      },
      { bvid: 'not-a-bv', title: '坏条目', author: '', duration: '0:00', play: 0, description: '' },
      { bvid: '', title: '没有 bvid', author: '', duration: '1:00', play: 0, description: '' },
    ],
  },
})

const VIEW_REPLY = JSON.stringify({
  code: 0,
  data: {
    bvid: 'BV1d4411N7zD',
    title: '【4K修复】周杰伦 - 晴天MV',
    duration: 317,
    owner: { name: 'zyl2012_音乐无限' },
    pages: [
      { cid: 317843818, part: '【4K修复】周杰伦 - 晴天', duration: 317 },
      { cid: 0, part: '坏分P', duration: 10 },
      { cid: 317843819, part: '  ', duration: 0 },
    ],
  },
})

const PLAYURL_REPLY = JSON.stringify({
  code: 0,
  data: {
    durl: [],
    dash: {
      audio: [
        { id: 30216, bandwidth: 38231, baseUrl: 'https://cdn.example/a.m4s' },
        // 最高带宽这条用协议相对 URL：上游偶尔就这样（见 bili.ts 文件头第 4 条）。
        { id: 30280, bandwidth: 169316, baseUrl: '//cdn.example/best.m4s' },
        { id: 30232, bandwidth: 84710, baseUrl: 'https://cdn.example/mid.m4s' },
        { id: 999, bandwidth: 0, base_url: 'ftp://cdn.example/nope' },
      ],
    },
  },
})

test('时长文本换算：分:秒 与 时:分:秒 都要认，认不出就返回 0', () => {
  assert.equal(parseBiliDuration('4:30'), 270)
  assert.equal(parseBiliDuration('163:39'), 9819, '超过一小时时 B站 仍按分钟记')
  assert.equal(parseBiliDuration('1:02:03'), 3723)
  assert.equal(parseBiliDuration(''), 0)
  assert.equal(parseBiliDuration('abc'), 0)
  assert.equal(parseBiliDuration('1:2:3:4'), 0)
})

test('文本清理：剥离 <em> 高亮并还原实体', () => {
  assert.equal(cleanBiliText('《<em class="keyword">晴天</em>》'), '《晴天》')
  assert.equal(cleanBiliText('A &amp; B &#39;c&#39;'), "A & B 'c'")
  assert.equal(cleanBiliText('  空白  '), '空白')
})

test('搜索：归一化 + 丢掉没有 bvid 的条目 + 按 limit 截断', async () => {
  const dir = scratch()
  const credFile = await credential(dir, { sessdata: 's', bili_jct: 'j', buvid3: 'b', dedeuserid: 'u' })
  const { http, calls } = fakeHttp([{ match: '/search/type', reply: { body: SEARCH_REPLY } }])
  const { port: processPort } = fakeProcess()
  const logs: string[] = []
  const bili = createBiliPort({
    http, credentialFile: credFile, ffmpegPath: 'ffmpeg', process: processPort,
    log: (line) => logs.push(line), workRoot: dir,
  })

  const hits = await bili.search('晴天 周杰伦', 5)
  assert.equal(hits.length, 1, '没有 bvid 的两条必须被丢掉')
  assert.deepEqual(hits[0], {
    bvid: 'BV1BZbSzZEGT',
    title: '【Hi-Res】《晴天》- 周杰伦',
    author: 'VV音乐局',
    duration: 270,
    play: 3439152,
    description: '仅用于音乐分享 & 交流',
  })
  // 搜索必须带 search_type=video（不带会落到另一种结构）。
  assert.match(calls[0]?.url ?? '', /search_type=video/)
  assert.equal(calls[0]?.options.headers?.Cookie, 'SESSDATA=s; bili_jct=j; buvid3=b; DedeUserID=u')
  assert.ok(logs.some((line) => line.includes('已载入凭据')))

  // limit 截断：请求 1 条就只该回 1 条（这里上游只有 1 条可用，另测多条的截断）。
  const many = JSON.stringify({
    code: 0,
    data: { result: [1, 2, 3].map((n) => ({ bvid: `BV1xxxxxxxx${String(n)}`, title: `t${String(n)}`, duration: '1:00' })) },
  })
  const second = fakeHttp([{ match: '/search/type', reply: { body: many } }])
  const bili2 = createBiliPort({
    http: second.http, credentialFile: credFile, ffmpegPath: 'ffmpeg', process: processPort,
    log: () => {}, workRoot: dir,
  })
  assert.equal((await bili2.search('x', 2)).length, 2)
})

test('搜索：空关键词不发请求', async () => {
  const dir = scratch()
  const { http, calls } = fakeHttp([])
  const bili = createBiliPort({
    http, credentialFile: await credential(dir, null), ffmpegPath: 'ffmpeg',
    process: fakeProcess().port, log: () => {}, workRoot: dir,
  })
  assert.deepEqual(await bili.search('   ', 5), [])
  assert.equal(calls.length, 0)
})

test('读不到凭据时匿名：请求不带 Cookie，但照样能取视频信息', async () => {
  const dir = scratch()
  const { http, calls } = fakeHttp([{ match: '/web-interface/view', reply: { body: VIEW_REPLY } }])
  const logs: string[] = []
  const bili = createBiliPort({
    http, credentialFile: await credential(dir, null), ffmpegPath: 'ffmpeg',
    process: fakeProcess().port, log: (line) => logs.push(line), workRoot: dir,
  })
  const info = await bili.videoInfo('BV1d4411N7zD')
  assert.equal(info.title, '【4K修复】周杰伦 - 晴天MV')
  assert.equal(calls[0]?.options.headers?.Cookie, undefined)
  assert.ok(logs.some((line) => line.includes('匿名')))
})

test('视频信息：title/owner/duration/pages 解析，cid 不合法的分P 丢掉', async () => {
  const dir = scratch()
  const bili = createBiliPort({
    http: fakeHttp([{ match: '/web-interface/view', reply: { body: VIEW_REPLY } }]).http,
    credentialFile: await credential(dir, { sessdata: 's' }),
    ffmpegPath: 'ffmpeg', process: fakeProcess().port, log: () => {}, workRoot: dir,
  })
  const info = await bili.videoInfo('BV1d4411N7zD')
  assert.equal(info.bvid, 'BV1d4411N7zD')
  assert.equal(info.author, 'zyl2012_音乐无限')
  assert.equal(info.duration, 317)
  assert.equal(info.pages.length, 2, 'cid=0 的那条必须丢')
  assert.equal(info.pages[0]?.cid, 317843818)
  assert.equal(info.pages[1]?.duration, 0, 'duration 缺失按 0，不猜')
})

test('BV 号形状不对时立刻拒（不把任意字符串拼进 URL）', async () => {
  const dir = scratch()
  const { http, calls } = fakeHttp([{ match: 'view', reply: { body: VIEW_REPLY } }])
  const bili = createBiliPort({
    http, credentialFile: await credential(dir, { sessdata: 's' }),
    ffmpegPath: 'ffmpeg', process: fakeProcess().port, log: () => {}, workRoot: dir,
  })
  await assert.rejects(() => bili.videoInfo('BV../../etc/passwd'), /BV 号形状不对/)
  assert.equal(calls.length, 0, '形状不对就不该发请求')
})

test('code != 0 抛可读错误（带 code，不带整段 JSON）', async () => {
  const dir = scratch()
  const body = JSON.stringify({ code: -404, message: '啥都木有' })
  const bili = createBiliPort({
    http: fakeHttp([{ match: '/web-interface/view', reply: { body } }]).http,
    credentialFile: await credential(dir, { sessdata: 's' }),
    ffmpegPath: 'ffmpeg', process: fakeProcess().port, log: () => {}, workRoot: dir,
  })
  await assert.rejects(
    () => bili.videoInfo('BV1d4411N7zD'),
    (error: Error) => {
      assert.match(error.message, /code=-404/)
      assert.match(error.message, /视频不存在/)
      // 整段 JSON 塞进日志是最糟的失败方式：这里确认没有。
      assert.equal(error.message.includes('{"code"'), false)
      return true
    },
  )
})

test('HTTP 412（风控页）抛的是风控提示，不是 JSON 解析错误', async () => {
  const dir = scratch()
  const bili = createBiliPort({
    http: fakeHttp([{ match: '/search/type', reply: { status: 412, body: '<html>风控</html>' } }]).http,
    credentialFile: await credential(dir, { sessdata: 's' }),
    ffmpegPath: 'ffmpeg', process: fakeProcess().port, log: () => {}, workRoot: dir,
  })
  await assert.rejects(() => bili.search('晴天', 3), /HTTP 412.*风控/)
})

test('status 200 但正文不是 JSON（风控页）也要给一句可读的话', async () => {
  const dir = scratch()
  const bili = createBiliPort({
    http: fakeHttp([{ match: '/search/type', reply: { body: '<!DOCTYPE html><html>风控</html>' } }]).http,
    credentialFile: await credential(dir, { sessdata: 's' }),
    ffmpegPath: 'ffmpeg', process: fakeProcess().port, log: () => {}, workRoot: dir,
  })
  await assert.rejects(() => bili.search('晴天', 3), /返回的不是 JSON/)
})

test('playurl：取最高带宽那条，协议相对 URL 补 https，下载时不带 Cookie', async () => {
  const dir = scratch()
  const destFile = path.join(dir, 'audio.wav')
  const { http, calls } = fakeHttp([
    { match: '/x/player/playurl', reply: { body: PLAYURL_REPLY } },
    { match: 'cdn.example/best.m4s', reply: { body: 'M4S-BYTES' } },
  ])
  const { port: processPort, calls: processCalls } = fakeProcess('fake-wav-bytes')
  const logs: string[] = []
  const bili = createBiliPort({
    http, credentialFile: await credential(dir, { sessdata: 's' }), ffmpegPath: 'ffmpeg',
    process: processPort, log: (line) => logs.push(line), workRoot: dir,
  })

  const got = await bili.downloadAudio('BV1d4411N7zD', 317843818, destFile)
  assert.equal(got.file, destFile)

  const downloadCall = calls.find((call) => call.url.includes('best.m4s'))
  assert.ok(downloadCall !== undefined, '应该下载最高带宽那一条')
  assert.equal(downloadCall.url, 'https://cdn.example/best.m4s', '协议相对 URL 必须补 https:')
  assert.equal(downloadCall.options.headers?.Cookie, undefined, '下载那一跳不该带 Cookie')
  assert.equal(downloadCall.options.headers?.Referer, 'https://www.bilibili.com/')
  assert.equal(downloadCall.options.limit, 32 * 1024 * 1024)

  // playurl 本身带 Cookie。
  const playurlCall = calls.find((call) => call.url.includes('/x/player/playurl'))
  assert.match(playurlCall?.url ?? '', /fnval=16/)
  assert.match(playurlCall?.url ?? '', /fourk=1/)
  assert.equal(playurlCall?.options.headers?.Cookie, 'SESSDATA=s')

  // ffmpeg 参数：必须是数组，且是 pcm_s16le / 44.1k / 立体声。
  assert.equal(processCalls.length, 1)
  const ffmpeg = processCalls[0]
  assert.ok(ffmpeg !== undefined)
  assert.equal(ffmpeg.command, 'ffmpeg')
  assert.equal(ffmpeg.args.includes('-ac'), true)
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-ac') + 1], '2')
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-ar') + 1], '44100')
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-c:a') + 1], 'pcm_s16le')
  assert.equal(ffmpeg.args[ffmpeg.args.length - 1], destFile)
  assert.equal(ffmpeg.args.some((arg) => arg.includes(' ') && !arg.includes('\\')), false, '参数里不该出现 shell 拼接')

  // 临时 m4s 必须被清掉（否则点十首歌堆 67 MB）。
  const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.m4s'))
  assert.deepEqual(leftovers, [])
  assert.equal((await fs.readFile(destFile, 'utf-8')), 'fake-wav-bytes')
  assert.ok(logs.some((line) => line.includes('音轨已就绪')))
})

test('dash.audio 为空时抛的是"没有可用音轨"，不是 TypeError', async () => {
  const dir = scratch()
  const bili = createBiliPort({
    http: fakeHttp([{ match: '/x/player/playurl', reply: { body: JSON.stringify({ code: 0, data: { durl: [], dash: { audio: [] } } }) } }]).http,
    credentialFile: await credential(dir, { sessdata: 's' }), ffmpegPath: 'ffmpeg',
    process: fakeProcess().port, log: () => {}, workRoot: dir,
  })
  await assert.rejects(
    () => bili.downloadAudio('BV1d4411N7zD', 317843818, path.join(dir, 'a.wav')),
    /没有可用的音轨/,
  )
})

test('ffmpeg 失败时错误里带 stderr 尾部（不然没人知道坏在哪）', async () => {
  const dir = scratch()
  const destFile = path.join(dir, 'audio.wav')
  const { http } = fakeHttp([
    { match: '/x/player/playurl', reply: { body: PLAYURL_REPLY } },
    { match: 'best.m4s', reply: { body: 'M4S' } },
  ])
  const failing: ProcessPort = {
    async run(): Promise<ProcessResult> {
      return { code: 1, stdout: '', stderr: 'Invalid data found when processing input', timedOut: false, durationMs: 5 }
    },
  }
  const bili = createBiliPort({
    http, credentialFile: await credential(dir, { sessdata: 's' }), ffmpegPath: 'ffmpeg',
    process: failing, log: () => {}, workRoot: dir,
  })
  await assert.rejects(() => bili.downloadAudio('BV1d4411N7zD', 317843818, destFile), /Invalid data found/)
  // 失败路径也要清临时文件。
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.m4s')), [])
})

// ---------------------------------------------------------------- ProcessPort
//
// 下面几条是**真的起子进程**（不联网、不跑 python），守的是 `process.ts` 的三件
// 必须做成默认值的事：ENOENT 不抛、超时真的杀掉、输出只留尾部。

test('ProcessPort：ENOENT 不抛，而是 code=-1 且 stderr 写明 spawn 失败', async () => {
  const port = createProcessPort()
  const result = await port.run('dsh-no-such-binary-xyz', ['--version'], { timeoutMs: 5000 })
  assert.equal(result.code, -1)
  assert.equal(result.timedOut, false)
  assert.match(result.stderr, /spawn 失败/)
  assert.match(result.stderr, /ENOENT/)
})

test('ProcessPort：非零退出码原样带回，stderr 收得到', async () => {
  const port = createProcessPort()
  const result = await port.run(process.execPath, ['-e', "console.error('boom');process.exit(3)"], { timeoutMs: 5000 })
  assert.equal(result.code, 3)
  assert.equal(result.stderr.trim(), 'boom')
  assert.equal(result.timedOut, false)
})

test('ProcessPort：超时置 timedOut 并真的杀掉进程（不会挂着）', async () => {
  const port = createProcessPort()
  const started = Date.now()
  const result = await port.run(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 800 })
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
  assert.equal(Date.now() - started < 20_000, true, '杀完之后必须很快返回')
})

test('ProcessPort：onLine 逐行回调；输出只留尾部 8 KiB 并标注截断', async () => {
  const port = createProcessPort()
  const lines: string[] = []
  const big = await port.run(process.execPath, ['-e', "process.stdout.write('x'.repeat(20000));process.stdout.write('\\nlast\\n')"], {
    timeoutMs: 5000, onLine: (line) => lines.push(line),
  })
  assert.equal(big.code, 0)
  assert.ok(big.stdout.length < 20_000, `应当只留尾部，实际 ${String(big.stdout.length)} 字符`)
  assert.match(big.stdout, /已截断前/)
  assert.equal(big.stdout.includes('last'), true, '最后一行必须还在（这才是诊断要看的那一行）')
  assert.deepEqual(lines.slice(-1), ['last'])
})
