/** 人物档：按房间记录"一个人怎么说话"的线索。
 *
 * 与原话簿/记忆的分工：
 *   - 原话簿存料（某人某天原样说了什么，不加工）；
 *   - 人物档存**判断**（谁爱用反问、谁忌讳被叫全名），一句一条、带日期；
 *   - 自动侧写（`memory.profiles`）是从结构化记忆里算出来的；这里是手动笔记，
 *     可以写侧写里没有的、只可意会的东西。
 *
 * 一条规矩：人物档只用来认人和接话，不许当证据引用。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'

export interface PersonNote {
  /** 一句话一条，越具体越好。 */
  readonly note: string
  /** 形成日期 YYYY-MM-DD。 */
  readonly day: string
  /**
   * 产生这条印象的**具体瞬间**（P3，feiyu 的规矩："印象必须带瞬间"——只写抽象
   * 判断像给人建档，写上当场那句话才像一本日记）。行内用 ` ‖ ` 分隔存取。
   */
  readonly moment?: string
}

export interface PersonFile {
  qq: number
  nick: string
  notes: PersonNote[]
}

/** 房间键只认 `group-<号>` / `dm-<号>`；它直接进文件路径，必须挡掉 `..`。 */
export function isRoom(room: string): boolean {
  return /^(group|dm)-\d{1,12}$/.test(room)
}

function assertRoom(room: string): void {
  if (room !== '' && !isRoom(room)) throw new Error(`room 只认 group-<号> / dm-<号>，收到：${room}`)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function today(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 同一个人在不同群说话不一样，所以档案按群分开存；不给 room 时退回根目录那一份。 */
export function personFile(dir: string, qq: number, room?: string): string {
  assertRoom(room ?? '')
  return room === undefined || room === ''
    ? path.join(dir, `${qq}.md`)
    : path.join(dir, room, `${qq}.md`)
}

/** 解析人物档 markdown：首行是昵称，其余每行 `- YYYY-MM-DD 内容`。 */
export function parsePersonFile(qq: number, text: string): PersonFile {
  const lines = text.split('\n')
  let nick = `QQ${qq}`
  const notes: PersonNote[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('# ')) {
      const m = /^#\s*(.+?)\s*(\(\d+\))?$/.exec(line)
      if (m !== null && m[1] !== undefined) nick = m[1]
      continue
    }
    if (!line.startsWith('- ')) continue
    const m = /^-\s*(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line)
    if (m === null) {
      notes.push({ note: line.slice(2).trim(), day: '' })
      continue
    }
    // ` ‖ ` 后面是产生这条印象的瞬间（P3）；老格式没有它，原样保留。
    const body = (m[2] ?? '').trim()
    const sep = body.indexOf(' ‖ ')
    if (sep === -1) {
      notes.push({ day: m[1] ?? '', note: body })
    } else {
      notes.push({ day: m[1] ?? '', note: body.slice(0, sep).trim(), moment: body.slice(sep + 3).trim() })
    }
  }
  return { qq, nick, notes }
}

export function renderPersonFile(file: PersonFile): string {
  const head = `# ${file.nick}(${file.qq})\n\n`
  const body = file.notes.map((n) => `- ${n.day} ${n.note}${n.moment === undefined ? '' : ` ‖ ${n.moment}`}`).join('\n')
  return `${head}${body}\n`
}

/** 读一个人。没有档案返回 null。 */
export async function readPerson(dir: string, qq: number, room?: string): Promise<PersonFile | null> {
  const tries = room === undefined || room === ''
    ? [personFile(dir, qq)]
    : [personFile(dir, qq, room), personFile(dir, qq)]
  for (const file of tries) {
    try {
      return parsePersonFile(qq, await fs.readFile(file, 'utf-8'))
    } catch { /* 试下一处 */ }
  }
  return null
}

/** 追加一条线索（同文去重）。返回是否真写入。 */
export async function appendPersonNote(
  dir: string,
  qq: number,
  nick: string,
  note: string,
  day = today(),
  room?: string,
  moment?: string,
): Promise<boolean> {
  const clean = note.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (clean === '') return false
  const cleanMoment = moment === undefined ? undefined : moment.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined
  const existing = await readPerson(dir, qq, room)
  const file: PersonFile = existing ?? { qq, nick: `QQ${qq}`, notes: [] }
  const cleanNick = nick.replace(/\s+/g, ' ').trim().slice(0, 40)
  if (cleanNick !== '') file.nick = cleanNick
  if (file.notes.some((n) => n.note === clean)) return false
  file.notes.push({ note: clean, day, ...(cleanMoment === undefined ? {} : { moment: cleanMoment }) })
  try {
    await atomicWriteFile(personFile(dir, qq, room), renderPersonFile(file))
    return true
  } catch {
    return false
  }
}

/** 列出所有人的档案（只读，不建目录）。 */
export async function listPeople(dir: string, room?: string): Promise<PersonFile[]> {
  assertRoom(room ?? '')
  const base = room === undefined || room === '' ? dir : path.join(dir, room)
  const files = await fs.readdir(base).catch(() => [] as string[])
  const out: PersonFile[] = []
  for (const f of files) {
    const m = /^(\d+)\.md$/.exec(f)
    if (m === null) continue
    const qq = Number(m[1])
    if (!Number.isFinite(qq)) continue
    const p = await readPerson(dir, qq, room)
    if (p !== null) out.push(p)
  }
  return out.sort((a, b) => b.notes.length - a.notes.length)
}
