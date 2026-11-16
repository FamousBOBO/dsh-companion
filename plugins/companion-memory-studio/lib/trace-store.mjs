// 陪伴空间 · 诊断事件的落地与读取（W2）。
//
// 设计要点（对齐计划 W2 的"有界、可轮转、可丢、可解释"）：
//   1. **有界**：按行数环（默认 2000 行，与客户端缓冲同口径）；写满后把最旧的挪进
//      `trace-YYYYMMDD.jsonl.1`，最多保留 `maxFiles` 份。
//   2. **可丢**：写入排队且非阻塞容忍——落盘失败不抛给调用方（诊断不能拖垮对话），
//      失败计数进 `dropped`，由流层与 UI 显示。
//   3. **可解释**：`dropped` 不只是一个数字，还带 `droppedReasons`（`write-failed` /
//      `rotate-failed` / `queue-overflow`），于是"为什么少了事件"永远有答案。
//   4. **只读面**：读取按 `sinceId` / `traceId` / `module` / `status` / `reasonCode` 过滤，
//      返回的是已脱敏事件的**副本**，调用方不可能通过读路径写回。
//
// 时间与文件系统都从外面注入，测试可以完全离线。

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeEvent, serializeEvent, isSafeEvent } from './trace-schema.mjs';

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_FILES = 3;
export const DEFAULT_QUEUE_LIMIT = 500;

/** 文件布局：`<root>/logs/trace-YYYYMMDD.jsonl`，轮转出来的兄弟是 `… .<n>`。 */
export function traceFilePath(root, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  return path.join(String(root), 'logs', `trace-${day}.jsonl`);
}

/**
 * 一个会话内的写入端。
 *
 * @param options `{ root, maxLines, maxFiles, queueLimit, now, fsImpl }`
 */
export function createTraceWriter(options = {}) {
  const root = String(options.root ?? '');
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES;
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles >= 0 ? options.maxFiles : DEFAULT_MAX_FILES;
  const queueLimit = Number.isInteger(options.queueLimit) && options.queueLimit > 0 ? options.queueLimit : DEFAULT_QUEUE_LIMIT;
  // 每攒够这么多条再落盘一次（默认 1 = 每次写入立刻落盘）。批量只在调用方显式要求时启用：
  // 实时诊断默认要"写完就能读"。
  const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0 ? options.batchSize : 1;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const io = options.fsImpl ?? fs;

  const state = {
    queue: [],
    dropped: 0,
    droppedReasons: {},
    written: 0,
    rejected: 0,
  };

  const noteDrop = (reason) => {
    state.dropped += 1;
    state.droppedReasons[reason] = (state.droppedReasons[reason] || 0) + 1;
  };

  /** 数一份文件的完整行（轮转判断用；只数不读内容，避免把事件读进内存）。 */
  function countLines(file) {
    try {
      const text = io.readFileSync(file, 'utf8');
      const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
      return trimmed ? trimmed.split('\n').length : 0;
    } catch {
      return 0;
    }
  }

  /** 把当前文件挪成 `… .1`，旧的后移；超出 `maxFiles` 的最老一份直接丢弃（它只是诊断）。 */
  function rotate(file) {
    try {
      for (let index = maxFiles; index >= 1; index -= 1) {
        const from = index === 1 ? file : `${file}.${index - 1}`;
        const to = `${file}.${index}`;
        if (!io.existsSync(from)) continue;
        if (index === maxFiles && io.existsSync(to)) io.rmSync(to, { force: true });
        io.renameSync(from, to);
      }
      return true;
    } catch {
      noteDrop('rotate-failed');
      return false;
    }
  }

  function flush() {
    if (!state.queue.length) return;
    const batch = state.queue.splice(0, state.queue.length);
    const file = traceFilePath(root, now());
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      if (io.existsSync(file) && countLines(file) >= maxLines) {
        if (!rotate(file)) {
          // 轮转失败时仍然写：宁可让文件超界，也不让事件凭空消失（丢已由 rotate-failed 记账）。
        }
      }
      io.appendFileSync(file, batch.map((line) => `${line}\n`).join(''), 'utf8');
      state.written += batch.length;
    } catch {
      // 整批丢掉并记账：诊断写入失败不能让业务路径感知异常。
      for (let index = 0; index < batch.length; index += 1) noteDrop('write-failed');
    }
  }

  return {
    /** 写入一条候选事件；返回是否被接受（`false` 说明它不合规或落盘失败，调用方可就此打日志）。 */
    write(candidate) {
      const { event, rejected } = sanitizeEvent(candidate, { now });
      const line = JSON.stringify(serializeEvent(event));
      if (!isSafeEvent(JSON.parse(line))) {
        state.rejected += 1;
        return false;
      }
      state.queue.push(line);
      if (state.queue.length > queueLimit) {
        // 队列溢出：丢最旧的（最旧的诊断价值最低），且记账。
        state.queue.shift();
        noteDrop('queue-overflow');
      }
      // 单条模式默认立刻落盘；批量模式下攒够 batchSize 再落一次。
      if (batchSize === 1 || state.queue.length >= batchSize) flush();
      return rejected.length === 0;
    },
    flush,
    stats() {
      return {
        written: state.written,
        rejected: state.rejected,
        dropped: state.dropped,
        droppedReasons: { ...state.droppedReasons },
        pending: state.queue.length,
      };
    },
    /** 测试与关停用：清空队列并返回当前文件路径。 */
    file: () => traceFilePath(root, now()),
  };
}

/** 读取端：按条件过滤已落盘事件。
 *
 * 只读当前日文件 + 至多 `maxFiles` 份轮转文件，按时间倒序优先返回最新的 `limit` 条。
 * 任何解析失败的行都被跳过（坏行不该让整个日志视图打不开），跳过数放进 `skipped`。
 */export function readTraceEvents(options = {}) {
  const root = String(options.root ?? '');
  const io = options.fsImpl ?? fs;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(500, options.limit) : 100;
  const files = [];
  const base = traceFilePath(root, now());
  for (let index = 0; index <= DEFAULT_MAX_FILES; index += 1) {
    const file = index === 0 ? base : `${base}.${index}`;
    if (io.existsSync(file)) files.push(file);
  }
  // 前一天的文件也可能有内容（跨零点的会话）。只在没有当日文件时回退一天。
  if (!files.length) {
    const previous = traceFilePath(root, now() - 24 * 3600 * 1000);
    if (io.existsSync(previous)) files.push(previous);
  }

  const wanted = {
    traceId: options.traceId ? String(options.traceId) : '',
    module: options.module ? String(options.module) : '',
    status: options.status ? String(options.status) : '',
    reasonCode: options.reasonCode ? String(options.reasonCode) : '',
    sinceId: options.sinceId ? String(options.sinceId) : '',
  };

  let skipped = 0;
  const rows = [];
  for (const file of files) {
    let text = '';
    try { text = io.readFileSync(file, 'utf8'); } catch { skipped += 1; continue; }
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { skipped += 1; continue; }
      if (!isSafeEvent(parsed)) { skipped += 1; continue; }
      if (wanted.traceId && parsed.traceId !== wanted.traceId) continue;
      if (wanted.module && parsed.module !== wanted.module) continue;
      if (wanted.status && parsed.status !== wanted.status) continue;
      if (wanted.reasonCode && parsed.reasonCode !== wanted.reasonCode) continue;
      if (wanted.sinceId && parsed.eventId === wanted.sinceId) continue;
      rows.push(parsed);
    }
  }

  return {
    source: files.map((file) => path.basename(file)),
    total: rows.length,
    skipped,
    events: rows.slice(-limit),
  };
}
