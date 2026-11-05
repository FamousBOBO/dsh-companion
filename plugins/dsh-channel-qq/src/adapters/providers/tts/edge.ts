/** edge-tts 后端：免 key 的微软语音合成 WebSocket 接口。
 *
 * 为什么自己实现 WebSocket 协议而不是装 Python edge-tts：契约禁止新增 npm 依赖，
 * 也不该在服务器上引入 Python 运行时；这个接口免 key、免 GPU，纯 CPU + 网络就够。
 * 为什么音频从二进制帧里"跳过 header"：edge-tts 的二进制帧 = 2 字节大端 header 长度
 * + header（文本，含 Path:audio）+ 裸 mp3 数据；header 长度是变长的，不能按固定偏移切，
 * 必须先读长度再跳过。
 */

import { createHash, randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
/**
 * 端点与握手参数。
 *
 * 2026-10 本地实测（Windows + ws 8.x）：`/voices/list` REST 接口 200（322 个音色，本文件里
 * 12 个中文音色名字全部命中），但 WS 升级在这个沙箱网络上**一律 403**——包括任务书给
 * 的这个 Origin、上游 edge-tts 用的 `chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold`、
 * 有无 Sec-MS-GEC、GEC 放头还是 query、新旧 Chromium 版本共 13 种组合。
 * 所以下面这组参数是"按参考实现写死"的，如果服务器上握手也 403，先换 ORIGIN
 * （上游 edge-tts 用的是 chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold）再试。
 */
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const ORIGIN = 'https://edge.microsoft.com'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
/** Sec-MS-GEC-Version 里的 Chromium 版本号，微软要求是较新的 Edge 版本。 */
const CHROMIUM_VERSION = '130.0.2849.68'
const CONNECT_TIMEOUT_MS = 30_000

interface CollectOptions {
  text: string
  voice: string
  rate: string
  pitch: string
  volume: string
  log: (l: string) => void
}

/** SSML 里 & < > ' " 都是语法字符，不转义会把整条 SSML 弄坏（接口只回一句 400）。 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** RFC1123 时间戳（edge-tts 用 formatdate(localtime=True)，服务端只当普通 header 值）。 */
function httpDate(): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${days[now.getDay()]}, ${pad(now.getDate())} ${months[now.getMonth()]} ${now.getFullYear()} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} `
    + `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

/** 距 1601-01-01 的秒数（Windows FILETIME 纪元）。 */
const WIN_EPOCH_SECONDS = 11644473600

/**
 * Sec-MS-GEC：SHA256(以 5 分钟为界取整的 Windows 时间戳 + trusted client token)，大写 hex。
 * 上游 edge-tts 从 2023 年起必须带这个头（不带会被服务端 403 拒），任务书里没提，也照发。
 */
function secMsGec(): string {
  const ticks = Math.floor((Date.now() / 1000 + WIN_EPOCH_SECONDS) / 300) * 300 * 1e7
  return createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase()
}

function buildHeaders(): Record<string, string> {
  return {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: ORIGIN,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': USER_AGENT,
    'Sec-MS-GEC': secMsGec(),
    'Sec-MS-GEC-Version': `1-${CHROMIUM_VERSION}`,
  }
}

/** 第一条文本帧：告诉服务端输出格式（不设 metadata，省掉用不上的边界事件）。 */
function speechConfigFrame(): string {
  const body = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  })
  return `X-Timestamp:${httpDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${body}`
}

/** 第二条文本帧：真正的 SSML。 */
function ssmlFrame(requestId: string, opts: CollectOptions): string {
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
    + `<voice name='${escapeXml(opts.voice)}'>`
    + `<prosody rate='${escapeXml(opts.rate)}' pitch='${escapeXml(opts.pitch)}' volume='${escapeXml(opts.volume)}'>`
    + `${escapeXml(opts.text)}</prosody></voice></speak>`
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${httpDate()}\r\nPath:ssml\r\n\r\n${ssml}`
}

/** ws 的 message 载荷可能是 Buffer / Buffer[] / ArrayBuffer，统一成 Buffer。 */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data as ArrayBuffer)
}

/**
 * 连上 edge 接口，把一段文字合成为 mp3 字节。
 * 任何异常路径都收敛成中文 Error（工具层会把 message 直接回给模型）。
 */
export function collectAudio(opts: CollectOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const requestId = randomUUID().replace(/-/g, '')
    const connectionId = randomUUID().replace(/-/g, '')
    const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectionId}`
    const controller = new AbortController()
    let socket: WebSocket | null = null
    let settled = false
    // 30s 兜底：edge 接口偶尔连上就不说话，靠 AbortSignal 把整条链路收掉
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)

    const finish = (error: Error | null, value?: Buffer): void => {
      if (settled) return
      settled = true
      // 让可能还挂着的连接立刻收手；close 之后 socket 自己会走 close 事件，但那时 settled 已为 true
      controller.abort()
      try {
        socket?.close()
      } catch {
        /* 已经关了 */
      }
      if (error !== null) reject(error)
      else resolve(value ?? Buffer.concat(chunks))
    }

    controller.signal.addEventListener('abort', () => {
      finish(new Error('edge-tts 合成失败：连接超时，稍后再试'))
    })

    try {
      socket = new WebSocket(url, { headers: buildHeaders() })
    } catch (error) {
      finish(new Error(`edge-tts 合成失败：无法建立连接（${error instanceof Error ? error.message : String(error)}）`))
      return
    }

    wireEdgeSocket(socket, requestId, opts, chunks, finish)
  })
}

/**
 * 把 edge 的事件处理挂到已建立的连接上：open 发两帧、二进制帧拼 mp3、turn.end 收尾；
 * 每条异常路径都交给同一个 finish（settled 保证只生效一次）。
 */
function wireEdgeSocket(
  socket: WebSocket,
  requestId: string,
  opts: CollectOptions,
  chunks: Buffer[],
  finish: (error: Error | null, value?: Buffer) => void,
): void {
  let sawTurnEnd = false

  socket.on('open', () => {
    opts.log(`edge-tts 已连接，voice=${opts.voice}，${opts.text.length} 字`)
    socket.send(speechConfigFrame())
    socket.send(ssmlFrame(requestId, opts))
  })

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      // 二进制帧：2 字节大端 header 长度 → 跳过 header → 剩下的是 mp3
      const buffer = toBuffer(data)
      if (buffer.length < 2) return
      const headerLength = buffer.readUInt16BE(0)
      const start = 2 + headerLength
      if (buffer.length > start) chunks.push(buffer.subarray(start))
      return
    }
    const text = toBuffer(data).toString('utf8')
    if (text.includes('Path:turn.end')) {
      sawTurnEnd = true
      finish(null, Buffer.concat(chunks))
    }
  })

  socket.on('error', (error: Error) => {
    finish(new Error(`edge-tts 合成失败：${error.message}（网络不通或微软接口已改版，稍后再试）`))
  })

  socket.on('unexpected-response', (_request, response) => {
    finish(new Error(`edge-tts 合成失败：握手被拒（HTTP ${response.statusCode}），接口参数可能需要更新`))
  })

  socket.on('close', () => {
    // 正常结束由 Path:turn.end 收尾；走到这里说明还没念完就断了
    if (!sawTurnEnd) {
      finish(new Error(`edge-tts 合成失败：连接提前关闭（已收到 ${Buffer.concat(chunks).length} 字节音频），稍后再试`))
    }
  })
}
