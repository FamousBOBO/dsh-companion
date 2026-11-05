/** 日志端口：文本行给人看，结构化记录给程序看，**两条一起写**。
 *
 * 现有的日志只有一个出口：`(line: string) => void`，落到 `channel-qq.log`。
 * 它对人是够的（`deploy/log-analyze.mjs` 靠正则把它归类），但程序读不了——
 * 后台想回答"最近一小时生图失败几次""哪个群的重试最多"就只能再写一遍正则。
 *
 * 所以这里不替换文本行，而是**并排**加一条结构化记录（JSONL）：
 *   - `line(text)`   —— 旧格式，人看的，`log-analyze.mjs` 与后台日志页照常工作；
 *   - `record(entry)` —— `{ ts, level, scope, msg, fields }`，可被过滤、计数、画图。
 *
 * 兼容性做法见 `adapters/log/logger.ts`：`line('quotes: loaded 3')` 会被拆成
 * `scope='quotes'` + `msg='loaded 3'`。这个仓里每一行日志本来就写成
 * `作用域: 内容`，所以拆出来的是真作用域，不是为了结构化而新编的字段。
 *
 * **只有类型**（06 §P2.2）。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 一条结构化日志。`fields` 里放可查询的细节，别把数字拼进 `msg`。 */
export interface LogRecord {
  /** ISO 8601 带本地时区偏移（与文本行同一个时间戳）。 */
  ts: string
  level: LogLevel
  /** 作用域：模块名（`quotes`）或子系统（`scheduler`）。 */
  scope: string
  msg: string
  fields?: Record<string, unknown>
}

/** 日志出口：往哪写。实现见 `adapters/log/logger.ts`。 */
export interface LogSink {
  /** 追加一条文本行（旧格式）。实现不得抛错——日志写不进去不能带崩业务。 */
  line(text: string): void
  /** 追加一条结构化记录。同样不得抛错。 */
  record(entry: LogRecord): void
}

/**
 * 一个作用域化的日志器。
 *
 * `line` 留着是为了**不强迫 200 个调用点改签名**：现在的写法本来就是
 * `log('quotes: loaded 3')`，它同时产出文本行和一条 `scope='quotes'` 的记录。
 * 新代码要带字段时用 `info/warn/error`。
 */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  /** 兼容旧调用点的整行日志：`'作用域: 内容'` 会被拆开。 */
  line(text: string): void
}
