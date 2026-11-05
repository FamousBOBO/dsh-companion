/** 群友原话簿：按群按日、一字不改的原始消息流水。
 *
 * 与记忆库的分工：
 * - 记忆库存**蒸馏后的结构化记录**；
 * - 原话簿存**干净的原话**（按群按日、按人可查），保证「三天前谁怎么说的」翻得出来。
 *
 * 不蒸馏意味着不判断真假：原话是料，不是结论。
 * 目录默认在 `<workspace>/chatlog`（**不在 memory/ 下**）——否则会被
 * `memory.chunks` 当成原文块切进向量库，把原话变成"记忆证据"。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { appendLineWithHeader } from '../../adapters/fs-store/append.js'

export interface ChatLogEntry {
  /** 群号或私聊对方 QQ */
  readonly room: number
  readonly isGroup: boolean
  readonly qq: number
  readonly nick: string
  /** 本地时刻 HH:MM */
  readonly hhmm: string
  /** 本地日期 YYYY-MM-DD */
  readonly day: string
  readonly text: string
}

export interface ChatLogOptions {
  /** 原话簿根目录，通常是 <workspace>/chatlog */
  readonly dir: string
  /** 单条最多留多少字，超了截断并标注。0 表示不截。 */
  readonly maxChars: number
  /** 保留天数；0 = 不清理。 */
  readonly keepDays: number
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function localClock(d = new Date()): { day: string; hhmm: string } {
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/** 文件名里不能有的字符一律换掉（房间号/日期是数字，正常不会触发）。 */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\n\r\t]/g, '_').slice(0, 40)
}

/** 这一天这一间的原话文件。群按群号分目录，私聊按人分目录。 */
export function chatLogFile(dir: string, room: number, isGroup: boolean, day: string): string {
  return path.join(dir, isGroup ? 'group' : 'dm', String(room), `${safeName(day)}.md`)
}

/** 只是占位、没有原话的行（纯图片、纯表情、空消息）不该占纸。 */
export function isPlaceholder(text: string): boolean {
  const t = text.trim()
  if (t === '') return true
  return /^(\[[^\]]{1,12}\])+$/.test(t)
}

/** 昵称里的分隔符会破坏 `昵称(QQ)：正文` 的解析，写之前换掉。 */
function safeNick(nick: string): string {
  return nick.replace(/[()：:\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40)
}

/** 一行原话：日期 时刻 昵称(QQ)：原话 */
export function formatEntry(e: ChatLogEntry, maxChars: number): string {
  let text = e.text.replace(/\r/g, '').replace(/\n+/g, ' ⏎ ').trim()
  if (maxChars > 0 && text.length > maxChars) {
    text = `${text.slice(0, maxChars)}（后略 ${text.length - maxChars} 字）`
  }
  const nick = safeNick(e.nick) || `QQ${e.qq}`
  return `${e.day} ${e.hhmm} ${nick}(${e.qq})：${text}`
}

/** 追加一条。写失败不抛：原话簿坏了不能拖垮回复。 */
export async function appendChatLog(opts: ChatLogOptions, entry: ChatLogEntry): Promise<boolean> {
  const file = chatLogFile(opts.dir, entry.room, entry.isGroup, entry.day)
  const kind = entry.isGroup ? `群 ${entry.room}` : `私聊 ${entry.room}`
  const header = `# ${kind} · ${entry.day}\n\n`
  return await appendLineWithHeader(file, header, `${formatEntry(entry, opts.maxChars)}\n`)
}

/** 某天某间房的一行发言（供摘要工具用）。 */
export interface DigestMessage {
  readonly time: string
  readonly nick: string
  readonly qq: string
  readonly text: string
}

/** 摘要工具解析原话簿行的正则：日期 时刻 昵称(QQ)：正文 */
const LINE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (.+?)\((\d+)\)：(.+)$/

/** 读某群某天的原话，解析成发言列表（按文件顺序）。 */
export async function readDay(dir: string, roomId: string, day: string): Promise<DigestMessage[]> {
  const file = path.join(dir, 'group', safeName(roomId), `${safeName(day)}.md`)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const messages: DigestMessage[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    const m = LINE_RE.exec(line)
    if (m === null) continue
    const body = (m[5] ?? '').trim()
    if (isPlaceholder(body)) continue
    messages.push({ time: `${m[1] ?? ''} ${m[2] ?? ''}`, nick: m[3] ?? '', qq: m[4] ?? '', text: body.slice(0, 200) })
  }
  return messages
}

/** 列出原话簿里已有的群目录 id。 */
export async function listGroupIds(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(dir, 'group'), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * 删除超过 keepDays 的日文件（0 = 不清理）。
 * 只在跨天时调用一次，失败静默——清理不是主路径。
 */
export async function pruneOld(dir: string, keepDays: number, today: string): Promise<number> {
  if (keepDays <= 0) return 0
  const cutoff = new Date(`${today}T00:00:00`)
  cutoff.setDate(cutoff.getDate() - keepDays)
  const cutoffKey = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`
  let removed = 0
  for (const kind of ['group', 'dm'] as const) {
    const base = path.join(dir, kind)
    const rooms = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
    for (const room of rooms) {
      if (!room.isDirectory()) continue
      const files = await fs.readdir(path.join(base, room.name)).catch(() => [])
      for (const file of files) {
        const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(file)
        if (m === null || (m[1] ?? '') >= cutoffKey) continue
        await fs.rm(path.join(base, room.name, file), { force: true }).catch(() => {})
        removed += 1
      }
    }
  }
  return removed
}
