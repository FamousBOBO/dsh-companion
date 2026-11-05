/** 日志器的组装：把 `Logger` 与 `LogSink` 接到具体文件上。
 *
 * 两条流并排写，都不得抛错（日志写不进去不能带崩业务），也都不阻塞调用方：
 * 追加是 fire-and-forget，失败只报一次。
 *
 * 文本行与结构化记录用的是**同一个时间戳**，所以拿文本行里的时间能在 JSONL 里
 * 检索到同一条，反之亦然。这是"两套日志并排"能用的前提。
 */

import * as path from 'node:path'
import type { Logger, LogLevel, LogRecord, LogSink } from '../../ports/logger.js'
import { JsonlLogStream, plainCodec } from '../fs-store/log-stream.js'
import { formatLocalStamp } from '../../core/schedule/stamp.js'

/** 作用域分隔：`'quotes: loaded 3'` → `['quotes', 'loaded 3']`。 */
const SCOPE_RE = /^([a-z][a-z0-9_-]{0,31}):\s+([\s\S]*)$/

/** 从一整行日志里拆出作用域与内容；拆不出来就用兜底作用域。 */
export function splitScope(text: string, fallbackScope: string): { scope: string; msg: string } {
  const m = SCOPE_RE.exec(text)
  if (m === null) return { scope: fallbackScope, msg: text }
  return { scope: m[1] ?? fallbackScope, msg: m[2] ?? text }
}

export interface SinkOptions {
  /** 文本日志文件（旧格式，人看、`log-analyze.mjs` 与后台日志页读它）。 */
  textFile: string
  /** 结构化日志文件（JSONL）。 */
  recordFile: string
  /** 文本文件行数上限；启动时裁剪一次。默认 20000 行。 */
  maxTextLines?: number
  /** 结构化文件行数上限；启动时裁剪一次。默认 20000 行。 */
  maxRecordLines?: number
  /** 写盘失败时的兜底出口（通常是 stderr / ctx.logger）。 */
  onError?: (message: string) => void
}

/**
 * 组装一个日志出口。
 *
 * `start()` 做一次封顶裁剪——**在启动时裁**而不是每条都裁：每条都裁等于每次写
 * 日志都重写整个文件，而日志的正确语义本来就是追加。
 */
export function createLogSink(options: SinkOptions): { sink: LogSink; start: () => Promise<void> } {
  // 文本流用 plainCodec：那个文件必须继续是纯文本（JSON 化会同时弄坏
  // `log-analyze.mjs` 与后台日志页这两个消费者）。
  const text = new JsonlLogStream<string>(options.textFile, { codec: plainCodec })
  const records = new JsonlLogStream<LogRecord>(options.recordFile)
  const onError = options.onError ?? ((): void => {})
  const maxText = options.maxTextLines ?? 20_000
  const maxRecords = options.maxRecordLines ?? 20_000

  return {
    sink: {
      line: (value: string): void => {
        void text.appendLine(value).catch((error: Error) => { onError(error.message) })
      },
      record: (entry: LogRecord): void => {
        void records.append(entry).catch((error: Error) => { onError(error.message) })
      },
    },
    start: async (): Promise<void> => {
      // 裁剪失败不算启动失败：日志封顶是卫生，不是功能。
      await text.trim(maxText).catch(() => {})
      await records.trim(maxRecords).catch(() => {})
    },
  }
}

/**
 * 把一个出口包成 `Logger`。
 *
 * `scope` 是这个 logger 的兜底作用域：`logger.line('没有冒号的自由文本')` 会落到
 * 它名下；写成 `'quotes: ...'` 时以行内那个为准（这个仓里每行日志本来就那个写法）。
 */
export function createLogger(sink: LogSink, scope: string, now: () => Date = () => new Date()): Logger {
  const emit = (level: LogLevel, text: string, fields?: Record<string, unknown>): void => {
    const stamp = formatLocalStamp(now())
    // 文本行保持旧格式（`<stamp> <原文>`），一个字都不改。
    sink.line(`${stamp} ${text}`)
    const split = splitScope(text, scope)
    sink.record({
      ts: stamp, level, scope: split.scope, msg: split.msg,
      ...(fields === undefined ? {} : { fields }),
    })
  }
  return {
    info: (msg, fields) => { emit('info', msg, fields) },
    warn: (msg, fields) => { emit('warn', msg, fields) },
    error: (msg, fields) => { emit('error', msg, fields) },
    line: (text) => { emit('info', text) },
  }
}

/** 默认文件位置：与 `channel-qq.log` 同一个目录。 */
export function defaultLogFiles(dshHome: string): { textFile: string; recordFile: string } {
  return {
    textFile: path.join(dshHome, 'channel-qq.log'),
    recordFile: path.join(dshHome, 'channel-qq.jsonl'),
  }
}
