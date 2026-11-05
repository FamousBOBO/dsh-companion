/**
 * 会话原件的读取与回合抽取（`--session` 模式）。
 *
 * 这是 `src/paths.ts` + `src/adapters/session-log/zstd-frames.ts` 的最小移植，
 * 外加 `deploy/dump-session.mjs` / `deploy/scan-tool-errors.mjs` 的解析口径：
 *
 *   - 会话文件是**多帧** zstd（每 append 一帧），必须逐帧解；
 *   - 记录类型：turn/start · turn/end · step/end · user/message · assistant/message
 *     · tool/result（`isError` 字段是权威的失败信号）；
 *   - 真人消息靠 `source.plugin === 'channel-qq'` 与行形状 `HH:MM 昵称(QQ)…：` 识别。
 *
 * 为什么要拷贝而不是 import：eval 必须能在没有任何构建产物的机器上直接
 * `node eval/run.mjs` 跑（服务器上也是对着 `$DSH_SESSIONS_ROOT` 用同一份代码）。
 * src 那边改了算法，这里要同步（README「为什么有一份拷贝」）。
 */

import { readdir, readFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// ── 路径解析（镜像 src/paths.ts） ───────────────────────────────────────────

/** 会话日志根：`$DSH_SESSIONS_ROOT`，否则 `<DSH_HOME 或 ~/.dsh>/sessions`。 */
export function resolveSessionsRoot(env = process.env) {
  const fromEnv = env.DSH_SESSIONS_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  const home = env.DSH_HOME
  const dshHome = typeof home === 'string' && home.trim() !== '' ? home : path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'sessions')
}

/** 把任意字符串编码成一个文件系统安全的路径段（镜像宿主 `encodeSegment`）。 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** 工作区路径 → 项目目录键（镜像宿主 `projectKey`，`/srv/dsh/workspace` → `--opt-dsh-workspace--`）。 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** 会话文件代际排名（`session.v4.jsonl.zstd` 压过 `session.jsonl`）。 */
export function rankArtifact(name) {
  const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
  if (match === null) return null
  return match[1] === undefined ? 0 : Number(match[1])
}

// ── 多帧 zstd 解码（镜像 src/adapters/session-log/zstd-frames.ts） ──────────

/** zstd 帧的魔法数。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 找出所有帧的起始偏移。 */
export function frameOffsets(raw) {
  const offsets = []
  for (let i = 0; i + ZSTD_MAGIC.length <= raw.length; i++) {
    if (raw.compare(ZSTD_MAGIC, 0, ZSTD_MAGIC.length, i, i + ZSTD_MAGIC.length) === 0) offsets.push(i)
  }
  return offsets
}

/** 逐帧解码一个（可能是多帧的）zstd 缓冲区；尾部半截帧跳过并计数。 */
export function decodeZstdFrames(raw, decompress = zstdDecompressSync) {
  if (raw.length === 0) return { text: '', frames: 0, skipped: 0 }
  const offsets = frameOffsets(raw)
  if (offsets.length === 0 || offsets[0] !== 0) {
    return { text: decompress(raw).toString('utf8'), frames: 1, skipped: 0 }
  }
  const parts = []
  let skipped = 0
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
    try {
      parts.push(decompress(raw.subarray(offsets[i], end)).toString('utf8'))
    } catch {
      skipped += 1 // 通常是尾部半截帧；中间坏帧也宁可少一行不整份放弃
    }
  }
  return { text: parts.join(''), frames: offsets.length, skipped }
}

/**
 * 读取一个会话的日志文本。
 *
 * @param {object} opts
 * @param {string} opts.sessionId 会话 id，如 `qq-dm-1000000002`
 * @param {string} [opts.cwd] 会话运行的工作区路径（不传 → `_no-cwd`）
 * @param {object} [opts.env] 环境变量（默认 process.env）
 * @returns {Promise<{text: string, file: string, frames: number, skipped: number} | null>}
 */
export async function readSessionLog({ sessionId, cwd, env = process.env }) {
  const root = resolveSessionsRoot(env)
  const project = cwd === undefined || cwd === '' ? '_no-cwd' : projectKey(cwd)
  const dir = path.join(root, project, encodeSegment(sessionId))
  let names
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const artifacts = names
    .map((n) => ({ n, rank: rankArtifact(n) }))
    .filter((e) => e.rank !== null)
    .sort((a, b) => b.rank - a.rank)
  if (artifacts.length === 0) return null
  const name = artifacts[0].n
  const file = path.join(dir, name)
  const raw = await readFile(file)
  if (!name.endsWith('.zstd')) return { text: raw.toString('utf8'), file, frames: 0, skipped: 0 }
  const res = decodeZstdFrames(raw)
  return { text: res.text, file, frames: res.frames, skipped: res.skipped }
}

// ── 记录解析与回合抽取（口径同 deploy/dump-session.mjs、analyze-turns.mjs） ─

/** 解析 JSONL；坏行计数跳过（尾部可能有写了一半的行）。 */
export function parseRecords(text) {
  const records = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { records, badLines }
}

/** 会把什么发进 QQ 房间的工具（口径同 deploy/dump-session.mjs）。 */
export const SEND_TOOLS = new Set([
  'qq_send_text', 'qq_reply_quote', 'qq_send_emoji', 'qq_send_voice',
  'qq_send_ai_voice', 'qq_send_music_card', 'qq_send_music_voice', 'qq_send_image',
])

/** 真人消息行形状（deploy/analyze-turns.mjs 的口径）。 */
export const QQ_LINE = /\d{1,2}:\d{2}\s[^\n]*\(\d{4,}\)[^\n]*：/

/**
 * 记录流 → 回合表。
 * 每个回合带：intake（喂给模型的消息，标出是否来自 QQ）、actions（全部工具调用）、
 * sends（其中会发消息的那些，带 text）、output（模型自己输出但没发的文字）。
 */
export function extractTurns(records) {
  const turns = []
  let cur = null
  for (const r of records) {
    const t = r.type
    const time = typeof r.time === 'number' ? r.time : null
    if (t === 'turn/start') {
      cur = { n: r.data?.turn ?? turns.length + 1, start: time, end: null, steps: 0, reason: null, intake: [], actions: [], sends: [], output: [] }
      turns.push(cur)
      continue
    }
    if (cur === null) continue
    if (t === 'turn/end') {
      cur.end = time
      cur.reason = r.data?.reason?.kind ?? r.data?.reason ?? null
      continue
    }
    if (t === 'step/end') { cur.steps += 1; continue }
    if (t === 'user/message') {
      const text = (r.data?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      if (text !== '') cur.intake.push({ text, fromQQ: r.data?.source?.plugin === 'channel-qq', at: time })
      continue
    }
    if (t === 'assistant/message') {
      for (const b of r.data?.message?.content ?? []) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
          cur.output.push({ text: b.text, at: time })
        }
        if (b.type === 'tool-call') {
          let args = b.arguments
          if (typeof args === 'string') {
            try { args = JSON.parse(args) } catch { /* 保留原串 */ }
          }
          const action = { tool: String(b.name ?? '?'), args: args ?? null, at: time }
          cur.actions.push(action)
          if (SEND_TOOLS.has(action.tool)) {
            const text = args !== null && typeof args === 'object' && typeof args.text === 'string' ? args.text : ''
            cur.sends.push({ ...action, text })
          }
        }
      }
    }
  }
  return { turns, metrics: sessionMetrics(turns, records) }
}

/** tool/result 是否失败：结构化 isError 字段权威，文本启发式只作兜底（口径同 deploy/scan-tool-errors.mjs）。 */
export function isErrorResult(rec) {
  const d = rec.data ?? {}
  const msg = d.message ?? {}
  if (typeof msg.isError === 'boolean') return msg.isError
  if (typeof d.isError === 'boolean') return d.isError
  if (d.status === 'error' || d.ok === false) return true
  if (d.error !== undefined) return true
  const t = textOf(msg.content ?? d.result ?? d.content ?? d.output ?? d).trimStart()
  return /^(Error|error|ERROR|TypeError|RangeError)\b/.test(t)
}

/** 把任意结果形状压成一段文本（只给上面那个兜底启发式用）。 */
function textOf(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(textOf).join('\n')
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text
    if (typeof v.content === 'string') return v.content
    if (Array.isArray(v.content)) return textOf(v.content)
    if (typeof v.message === 'string') return v.message
    if (typeof v.error === 'string') return v.error
    if (v.error !== undefined) return JSON.stringify(v.error)
  }
  return JSON.stringify(v)
}

function pick(sorted, p) {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

/** 性能基线四项（07 §5.4）里能从会话原件直接量到的部分。 */
export function sessionMetrics(turns, records) {
  const done = turns.filter((t) => t.start !== null && t.end !== null)
  const durs = done.map((t) => Math.round((t.end - t.start) / 1000)).sort((a, b) => a - b)
  const prompts = []
  let toolResults = 0
  let toolFailed = 0
  for (const r of records) {
    if (r.type === 'assistant/message') {
      const u = r.data?.usage
      if (u !== undefined && u !== null) {
        prompts.push(Number(u.inputTokens ?? 0) + Number(u.cacheReadTokens ?? 0))
      }
    }
    if (r.type === 'tool/result') {
      toolResults += 1
      if (isErrorResult(r)) toolFailed += 1
    }
  }
  prompts.sort((a, b) => a - b)
  return {
    durationsSec: { turns: durs.length, p50: pick(durs, 0.5), p90: pick(durs, 0.9), max: durs[durs.length - 1] ?? 0 },
    promptTokens: { turns: prompts.length, p50: pick(prompts, 0.5), max: prompts[prompts.length - 1] ?? 0 },
    toolResults: { total: toolResults, failed: toolFailed },
    sends: { total: turns.reduce((n, t) => n + t.sends.length, 0), turnsWithSend: turns.filter((t) => t.sends.length > 0).length },
    qqTurns: turns.filter((t) => t.intake.some((i) => QQ_LINE.test(i.text))).length,
  }
}

/** 回合表 → 判定用会话：出站文本 = 真正发出去的那些（sends 的 text），行动 = 全部工具调用。 */
export function conversationFromTurns(turns) {
  const messages = []
  for (const t of turns) {
    for (const i of t.intake) {
      messages.push({ role: 'user', speaker: i.fromQQ ? 'QQ' : '系统', text: i.text })
    }
    messages.push({
      role: 'assistant',
      speaker: '诺诺',
      text: t.sends.map((s) => s.text).join('\n'),
      actions: t.actions.map((a) => ({ tool: a.tool, args: a.args })),
    })
  }
  return messages
}
