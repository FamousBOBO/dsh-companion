// 陪伴空间 · 诊断事件的两个只读入口（W2）。
//
//   GET /trace-events?traceId=&module=&status=&reasonCode=&limit=
//       一次性快照。给它 `sinceId` 就是"只取这条之后的新事件"，便于轮询客户端补读。
//   GET /trace/stream?… 同上过滤条件
//       SSE：`ready` / `trace` / `trace-error` / 心跳。轮转续读与去重交给 trace-stream。
//
// 两者都是**只读**：没有 POST，也不接受路径参数——读哪个文件由服务端按 root 决定。

import fs from 'node:fs';
import path from 'node:path';
import { readTraceEvents } from './trace-store.mjs';
import { recallRecordsToEvents } from './trace-project.mjs';
import { createTraceStream, parseTraceFilters, matchesFilters } from './trace-stream.mjs';

/** 快照接口。 */
export async function traceEvents(request, kernel) {
  kernel.viewer(await kernel.internal());
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const filters = parseTraceFilters(url.search);
  const read = readTraceEvents({
    root: kernel.root,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.trunc(limit)) : 100,
    sinceId: url.searchParams.get('sinceId') ?? '',
    ...filters,
  });
  return kernel.ok({
    source: read.source,
    total: read.total,
    skipped: read.skipped,
    filters,
    events: read.events,
    observedAt: new Date().toISOString(),
  });
}

/** SSE 接口。 */
export async function traceStream(request, kernel) {
  kernel.viewer(await kernel.internal());
  const url = new URL(request.url);
  return new Response(createTraceStream(kernel.root, {
    signal: request.signal,
    filters: parseTraceFilters(url.search),
  }), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

/**
 * 记忆侧事件：把既有的 `logs/memory-recall.jsonl` 投影成 trace 事件（只读，不新增写入口）。
 *
 * 只在**读**的时候投影：`companion-memory` 已经在写那条记录了，Studio 不再重复落一份，
 * 于是"记忆侧事件"永远只有一个权威来源。`source` 字段告诉 UI 这批是从哪来的。
 */
export async function memoryTraceEvents(request, kernel) {
  kernel.viewer(await kernel.internal());
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const file = path.join(String(kernel.root), 'logs', 'memory-recall.jsonl');
  if (!fs.existsSync(file)) {
    return kernel.ok({ source: null, records: 0, skipped: 0, events: [], observedAt: new Date().toISOString() });
  }
  // 只读**尾部窗口**，不把整个 recall 日志读进内存。
  //
  // 这份日志由 memory 引擎长期追加，不属于本 PR 的有界 store；`limit` 最多 500 条，
  // 但旧实现每次请求都 `readFileSync` 全文再切尾 —— 成本随文件线性增长（M11）。
  // 这里按字节从末尾往前读：读到足够多的完整行就停（最多 512 KiB，避免异常情况下
  // 单行超长把请求拖住）。
  const TAIL_BYTES = 512 * 1024;
  const records = [];
  let skippedLines = 0;
  let truncated = false;
  try {
    const stat = fs.statSync(file);
    // 不是普通文件（例如被建成目录）：直接判"读不到"，而不是读出一份空日志。
    // 旧实现靠 `readFileSync` 抛错兜住；改成按字节读之后，长度 0 的目录会让读取
    // "成功"返回空内容，于是"空"和"读不到"又被糊在一起（实测踩过）。
    if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
    const from = stat.size > TAIL_BYTES ? stat.size - TAIL_BYTES : 0;
    truncated = from > 0;
    const handle = fs.openSync(file, 'r');
    let text = '';
    try {
      const bytes = Buffer.alloc(Math.max(0, stat.size - from));
      const read = fs.readSync(handle, bytes, 0, bytes.length, from);
      text = bytes.subarray(0, read).toString('utf8');
    } finally {
      try { fs.closeSync(handle); } catch { /* 已关 */ }
    }
    // 从中间切进来的第一行可能是半截：它不计数为坏行，直接丢掉。
    const lines = text.split('\n');
    if (truncated) lines.shift();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { skippedLines += 1; }
    }
  } catch {
    // 读失败不是"没有事件"：明确回 `readable:false` + 理由，UI 才分得清"空"和"读不到"。
    return kernel.ok({
      source: 'logs/memory-recall.jsonl',
      readable: false,
      reason: 'read-failed',
      records: 0,
      skipped: 0,
      truncated: false,
      events: [],
      observedAt: new Date().toISOString(),
    });
  }
  const tail = Number.isFinite(limit) && limit > 0 ? records.slice(-Math.min(500, Math.trunc(limit))) : records.slice(-100);
  const projected = recallRecordsToEvents(tail);
  const filters = parseTraceFilters(url.search);
  const events = projected.events.filter((event) => matchesFilters(event, filters));
  return kernel.ok({
    source: 'logs/memory-recall.jsonl',
    records: tail.length,
    skipped: projected.skipped + skippedLines,
    // `truncated` 明说"只读了文件尾部"，UI 才能解释"更早的记录为什么不在"。
    truncated,
    filters,
    events,
    observedAt: new Date().toISOString(),
  });
}