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
  const records = [];
  let skippedLines = 0;
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
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
    filters,
    events,
    observedAt: new Date().toISOString(),
  });
}