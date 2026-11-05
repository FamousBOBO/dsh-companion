/** 表情包配字制作（P0-2）：给一张本地图片加"上句/下句"白字黑边，输出 PNG。
 *
 * 为什么用 ffmpeg drawtext 而不是自己画字：服务器上已经装了带 drawtext 的 ffmpeg，
 * 而 Node 侧没有可用的图像合成能力（契约禁止新增 npm 依赖，也没有 canvas 之类的原生模块）。
 * 为什么文字走 `textfile=` 而不是 `text=`：drawtext 的 text= 需要同时满足"滤镜参数层"和
 * "滤镜描述层"两层转义（命令行再叠一层 shell），中文、引号、冒号、逗号轮流踩坑；把正文写进
 * 临时文件后，只剩"路径"这一个字符串需要转义，出错面小得多。
 *
 * 工具面（`registerMemeTools` 与三个 spec）在 `./tools.js`：这里只管"怎么配字"，
 * 那里只管"模型怎么调用它"。
 */

import { spawn } from 'node:child_process'
import { constants as fsConstants, promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'

/** 一次配字的结果。`lines` 是原始两行文字（未折行前），`template` 是原图文件名。 */
export interface MemeResult {
  file: string
  bytes: number
  template: string
  lines: string[]
}

export interface MakeMemeOptions {
  image: string
  top?: string
  bottom?: string
  fontFile?: string | null
  outDir: string
  log?: (l: string) => void
}

/**
 * 字体探测顺序：显式配置优先，其后是服务器上最常见的几套中文字体。
 * DejaVu 没有中文字形，只作为"至少能出字"的最后兜底（会显示方块）。
 */
const FONT_CANDIDATES: string[] = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'])

interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

async function canRead(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析一个真实可用的字体文件绝对路径。
 *
 * @param fontFile - 配置里显式指定的字体；null/空 = 自动探测。
 * @throws 中文 Error，提示安装 fonts-noto-cjk 或配置 fontFile。
 */
export async function resolveFont(fontFile: string | null, log?: (l: string) => void): Promise<string> {
  const configured = fontFile?.trim()
  if (configured !== undefined && configured !== '') {
    if (await canRead(configured)) return configured
    // 配置写了但文件不在：不能直接失败，退回自动探测，否则一个手滑的路径就把整个功能拖死
    log?.(`配置的字体不存在或不可读（${configured}），改为自动探测系统字体`)
  }
  for (const candidate of FONT_CANDIDATES) {
    // 必须实际 stat/access 探测，不能假设某发行版一定装了哪个字体
    if (await canRead(candidate)) {
      log?.(`使用字体 ${candidate}`)
      return candidate
    }
  }
  throw new Error('没有可用字体，请安装 fonts-noto-cjk 或在配置里指定 fontFile')
}

/** 取 stderr 末尾若干字（ffmpeg 把真正的报错放在最后几行）。 */
function tail(text: string, limit = 300): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}

/** 跑一个外部命令，收 stdout/stderr。参数用数组传（不拼字符串、不走 shell），天然免疫注入。 */
function runProcess(bin: string, args: string[], label: string): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT'
        ? new Error(`${label} 未安装或不在 PATH 里：找不到可执行文件 ${bin}，请先安装 ffmpeg`)
        : new Error(`${label} 启动失败：${error.message}`))
    })
    child.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** 用 ffprobe 读图片宽高：字号/折行都要按真实尺寸算，比让 ffmpeg 自己算表达式可靠。 */
async function probeSize(file: string): Promise<{ width: number; height: number }> {
  const result = await runProcess(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
    'ffprobe',
  )
  if (result.code !== 0) {
    throw new Error(`图片无法解析（ffprobe 退出码 ${result.code}）：${file} —— ${tail(result.stderr, 200)}`)
  }
  let parsed: { streams?: Array<{ width?: number; height?: number }> }
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed
  } catch {
    throw new Error(`图片无法解析：ffprobe 输出不是 JSON（${tail(result.stdout, 120)}）`)
  }
  const stream = parsed.streams?.[0]
  if (stream?.width === undefined || stream?.height === undefined || stream.width <= 0 || stream.height <= 0) {
    throw new Error(`不是图片：ffprobe 读不到宽高（支持 png/jpg/gif/webp/bmp）：${file}`)
  }
  return { width: stream.width, height: stream.height }
}

/** 靠文件头判断是不是图片（扩展名可以骗人，魔数不会）。 */
function looksLikeImage(head: Buffer): boolean {
  if (head.length < 4) return false
  const hex = head.toString('hex')
  if (hex.startsWith('89504e47')) return true // PNG
  if (hex.startsWith('ffd8ff')) return true // JPEG
  if (head.subarray(0, 4).toString('ascii') === 'GIF8') return true
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return true
  if (head.subarray(0, 2).toString('ascii') === 'BM') return true
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return true // TIFF
  return false
}

/** 中日韩/全角区段按 1 个字符宽，其余按 0.5（ASCII 半角）。 */
const FULLWIDTH = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F]/

/** 全角宽度的粗略排序：不引入字体度量依赖，够用来折行即可。 */
function charWidth(ch: string): number {
  return FULLWIDTH.test(ch) ? 1 : 0.5
}

/**
 * 按"全角字符数"粗估折行：每行最多 maxWidth 个全角宽。
 * drawtext 自己不会折中文，必须我们插 \n。
 */
function wrapText(text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ''
    let width = 0
    for (const ch of paragraph) {
      const w = charWidth(ch)
      if (line !== '' && width + w > maxWidth) {
        lines.push(line)
        line = ''
        width = 0
      }
      line += ch
      width += w
    }
    if (line !== '') lines.push(line)
  }
  if (lines.length <= maxLines) return lines
  // 行数太多会溢出画面，截断并在末行加省略号——比让字被裁掉好看
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = `${kept[maxLines - 1]}…`
  return kept
}

/**
 * 滤镜参数值转义。
 *
 * ffmpeg 的滤镜串要被解析两层：先整条描述（`\ ' [ ] , ;` 是语法字符），再每个参数值
 * （`\ ' : ,` 和**空白**是语法字符，av_get_token 会把未转义的空白直接吞掉）。
 * 所以先按参数层转义，再把结果按描述层转义一次，得到双层转义的值。
 * 不用单引号包裹：引号内的反斜杠不再被解释，Windows 路径（C:\…）会直接坏掉。
 */
function escapeFilterValue(raw: string): string {
  const optionLevel = raw.replace(/([\\':,\s])/g, '\\$1')
  return optionLevel.replace(/([\\'\[\],;])/g, '\\$1')
}

/** 把正文写进 os.tmpdir() 的临时文件，交给 drawtext 的 textfile= 读。 */
async function writeTempText(text: string): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `meme-text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`,
  )
  await atomicWriteFile(file, text)
  return file
}

/**
 * 图片检查：存在、是文件、且文件头或扩展名表明它是图片。
 * （拆自 `makeMeme` 开头，判据、顺序与报错文案一字未动。）
 */
async function assertImageReadable(image: string): Promise<void> {
  try {
    const stat = await fs.stat(image)
    if (!stat.isFile()) throw new Error(`不是文件（不能给目录配字）：${image}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('不是文件')) throw error
    throw new Error(`图片不存在：${image}`)
  }

  const handle = await fs.open(image, 'r')
  let head = Buffer.alloc(0)
  try {
    const buffer = Buffer.alloc(12)
    const { bytesRead } = await handle.read(buffer, 0, 12, 0)
    head = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  if (!IMAGE_EXTS.has(path.extname(image).toLowerCase()) && !looksLikeImage(head)) {
    throw new Error(`不是图片：${image}（支持 png/jpg/gif/webp/bmp）`)
  }
}

/**
 * 拼上句 / 下句的 drawtext 滤镜串（`textfile=` 指向写出的临时文件）。
 * 临时文件记进 `tempFiles`，由调用方在 finally 里统一清——成败都要清。
 */
async function buildDrawFilters(
  common: string,
  topLines: string[],
  bottomLines: string[],
  tempFiles: string[],
): Promise<string[]> {
  const filters: string[] = []
  if (topLines.length > 0) {
    const textFile = await writeTempText(topLines.join('\n'))
    tempFiles.push(textFile)
    // 上句：距顶 6%，水平居中靠 text_w 自己算
    filters.push(`drawtext=${common}:textfile=${escapeFilterValue(textFile)}:x=(w-text_w)/2:y=h*0.06`)
  }
  if (bottomLines.length > 0) {
    const textFile = await writeTempText(bottomLines.join('\n'))
    tempFiles.push(textFile)
    // 下句：从底边往上顶（h-text_h-8%）。单行时约等于 h*0.82，多行时不会溢出画面底部
    filters.push(`drawtext=${common}:textfile=${escapeFilterValue(textFile)}:x=(w-text_w)/2:y=h-text_h-h*0.08`)
  }
  return filters
}

/**
 * 生成表情包：原图 + 上/下两行白字黑边。
 *
 * @throws 中文 Error（图片不存在 / 不是图片 / ffmpeg 缺失 / 滤镜报错并把 stderr 末尾带上）
 */
export async function makeMeme(opts: MakeMemeOptions): Promise<MemeResult> {
  const log = opts.log ?? (() => {})
  const image = path.resolve(opts.image)
  const top = (opts.top ?? '').trim()
  const bottom = (opts.bottom ?? '').trim()
  if (top === '' && bottom === '') throw new Error('至少要给一行文字：top（上句）和 bottom（下句）不能同时为空。')

  await assertImageReadable(image)

  const font = await resolveFont(opts.fontFile ?? null, log)
  const { width } = await probeSize(image)
  // 字号按图片宽度自适应；上下限只是防止小图字太大/大图字太小
  const fontSize = Math.max(18, Math.min(96, Math.round(width / 12)))
  const maxFullWidth = Math.max(4, Math.floor((width / fontSize) * 0.95))
  const maxLines = 3
  const topLines = top === '' ? [] : wrapText(top, maxFullWidth, maxLines)
  const bottomLines = bottom === '' ? [] : wrapText(bottom, maxFullWidth, maxLines)

  const outDir = path.resolve(opts.outDir)
  await fs.mkdir(outDir, { recursive: true })
  const outFile = path.join(outDir, `meme_${Date.now()}.png`)

  const common = [
    `fontfile=${escapeFilterValue(font)}`,
    'fontcolor=white',
    'borderw=3',
    'bordercolor=black',
    `fontsize=${fontSize}`,
    `line_spacing=${Math.round(fontSize * 0.25)}`,
  ].join(':')

  const tempFiles: string[] = []
  try {
    const filters = await buildDrawFilters(common, topLines, bottomLines, tempFiles)
    const result = await runProcess(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', image, '-vf', filters.join(','), '-frames:v', '1', outFile],
      'ffmpeg',
    )
    if (result.code !== 0) {
      throw new Error(`表情包生成失败（ffmpeg 退出码 ${result.code}）：${tail(result.stderr)}`)
    }
  } finally {
    // 临时正文文件是中间产物，成败都要清掉（放在 tmpdir，不污染工作区）
    for (const file of tempFiles) await fs.rm(file, { force: true }).catch(() => {})
  }

  const bytes = (await fs.stat(outFile)).size
  log(`meme → ${outFile} (${bytes}B, font=${font}, fontsize=${fontSize})`)
  return {
    file: outFile,
    bytes,
    template: path.basename(image),
    lines: [top, bottom].filter((line) => line !== ''),
  }
}
