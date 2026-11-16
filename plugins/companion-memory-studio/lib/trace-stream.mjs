// 陪伴空间 · 诊断事件 SSE（W2）。
//
// 与 `runtime-log-stream.mjs` 的分工：
//   - 那个 tail 的是**宿主控制台文本**（start-*.log），逐行脱敏后当作"原始日志"；
//   - 这个 tail 的是**结构化事件**（`logs/trace-YYYYMMDD.jsonl`），按 schema 过滤后
//     作为 `event: trace` 推送。两路各自独立、互不阻塞：控制台日志坏了也不影响事件流。
//
// 三条必须做对的事（计划 W2 明写）：
//   1. **轮转续读**：文件从 `trace-x.jsonl` 变成 `.1`、新文件从零开始时，不重放、不丢。
//      做法是"按 eventId 去重"的环形集合，而不是按偏移量猜。
//   2. **丢事件计数**：读失败、解析失败、被过滤掉的总数都随 `event: drops` 下发，
//      于是"少了什么"永远可解释。
//   3. **过滤**：module / traceId / status / reasonCode 在服务端生效，客户端不用把全量
//      2000 条拉下来再筛。

import fs from 'node:fs';
import path from 'node:path';
import { isSafeEvent } from './trace-schema.mjs';
import { traceFilePath } from './trace-store.mjs';

const LINE_CAP = 500;
const BATCH_CAP = 200;
const READ_CHUNK = 65536;
const SEEN_RING = 4096;

/** 从 query 里取过滤条件（只认白名单键，其余忽略）。 */
export function parseTraceFilters(search) {
  const params = new URLSearchParams(search ?? '');
  const text = (key) => String(params.get(key) ?? '').trim().slice(0, 64);
  return {
    traceId: text('traceId'),
    module: text('module'),
    status: text('status'),
    reasonCode: text('reasonCode'),
  };
}

/** 一条事件是否命中过滤条件。空条件 = 不过滤。 */
export function matchesFilters(event, filters) {
  if (!filters) return true;
  if (filters.traceId && event.traceId !== filters.traceId) return false;
  if (filters.module && event.module !== filters.module) return false;
  if (filters.status && event.status !== filters.status) return false;
  if (filters.reasonCode && event.reasonCode !== filters.reasonCode) return false;
  return true;
}

/**
 * 环形去重集合：只记最近 `SEEN_RING` 个 eventId。
 *
 * 为什么不用时间戳：同一毫秒内多条事件是常态，按时间截断会误丢。
 */
function createSeenRing(capacity = SEEN_RING) {
  const order = [];
  const set = new Set();
  return {
    has: (id) => set.has(id),
    add(id) {
      if (!id || set.has(id)) return false;
      set.add(id);
      order.push(id);
      if (order.length > capacity) {
        const oldest = order.shift();
        set.delete(oldest);
      }
      return true;
    },
    size: () => set.size,
  };
}

export function createTraceStream(root, { signal, filters, pollMs = 400, now = () => Date.now() } = {}) {
  let cleanup = () => {};
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let timer = null;
      let keepalive = null;
      // 每个文件各自的读取偏移：轮转会把 base 挪成 base.1，如果只记"当前文件 + 偏移"，
      // 越过一代之后就再也追不到新文件里的事件（实测踩过：永远只读最老那一份）。
      const offsets = new Map();
      // 偏移本身就是半行起点：不需要额外的 partials 缓冲（旧实现有，正是 H2 的来源）。
      const seen = createSeenRing();
      // `backlog` = 已落盘但这一 tick 还没消费的字节数（批次上限或末尾半行），
      // 不是丢弃：下一 tick 会继续读。前端据此可以显示还有多少在路上。
      const counters = { parsed: 0, unsafe: 0, corrupt: 0, duplicate: 0, readError: 0, filtered: 0, backlog: 0 };

      const send = (event, data) => {
        if (closed || controller.desiredSize <= 0) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const drops = (extra = {}) => ({ ...counters, ...extra, at: new Date(now()).toISOString() });

      cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (keepalive) clearInterval(keepalive);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => { cleanup(); try { controller.close(); } catch { /* 已关 */ } };

      /** 当前存在的候选文件：轮转后的 `.N` 更老，先读老的后读新的（推送顺序即时间顺序）。 */
      function candidateFiles() {
        const dir = path.join(String(root), 'logs');
        const base = path.basename(traceFilePath(root, now()));
        // 按前缀扫目录而不是硬编码代数：写入端的 maxFiles 是可配的，读端不该假设它是 3。
        let names = [];
        try { names = fs.readdirSync(dir); } catch { return []; }
        const prefix = base.replace(/\.jsonl$/, '');
        const generations = names
          .filter((name) => name.startsWith(`${prefix}.jsonl.`))
          .map((name) => ({ name, index: Number(name.slice(`${prefix}.jsonl.`.length)) }))
          .filter((item) => Number.isInteger(item.index) && item.index >= 1)
          .sort((left, right) => right.index - left.index) // 最老的代数先读
          .map((item) => path.join(dir, item.name));
        const list = [...generations];
        const current = path.join(dir, base);
        if (fs.existsSync(current)) list.push(current);
        if (!list.length) {
          // 跨零点会话：当日没有任何文件时退回前一天。
          const previous = path.join(dir, path.basename(traceFilePath(root, now() - 24 * 3600 * 1000)));
          if (fs.existsSync(previous)) list.push(previous);
        }
        return list;
      }

      /**
       * 读一个文件的新增部分。
       *
       * 偏移只有一种含义：**尚未消费的第一行的起点**，并且按**字节**算。
       *
       * 两个实测踩出来的坑，都由这一条语义解决：
       *   1. 写入端 append-only，我们可能读到半行。旧实现既把半行 carry 到块前、又把偏移
       *      停在半行起点，于是同一段字节被拼两遍、那条事件永久丢失，corrupt 还是 0。
       *      现在偏移本身就指向半行起点，重读时不需要任何 carry。
       *   2. 一批超过 BATCH_CAP 时不能先把偏移推到底再逐行推送——那样超上限的完整行既没
       *      推送也不计数，下一轮从块末尾读，它们静默消失，而 drops.parsed 与送达数还自洽
       *      到查不出来。现在偏移只推进到第 BATCH_CAP 条的行尾，剩下的留给下一 tick，
       *      记为 backlog 字节（不是丢弃）。
       * 唯一例外：单行本身超过 64 KiB 读窗口时永远解析不了，按坏行计一次并跳过，
       * 否则读指针会原地打转。
       */
      function readNew(file, events) {
        let stat = null;
        try { stat = fs.statSync(file); } catch { return false; }
        const recorded = offsets.get(file);
        // 首次见到 → 从头读；文件变短（轮转/截断）→ 从头读。两种都由 eventId 去重兜住。
        const cursor = recorded === undefined || stat.size < recorded ? 0 : recorded;
        if (stat.size <= cursor) return false;

        const want = Math.min(stat.size - cursor, READ_CHUNK);
        const bytes = Buffer.alloc(want);
        let read = 0;
        let fd = null;
        try {
          fd = fs.openSync(file, 'r');
          read = fs.readSync(fd, bytes, 0, want, cursor);
        } catch {
          counters.readError += 1;
          return false;
        } finally {
          try { if (fd !== null) fs.closeSync(fd); } catch { /* 已关 */ }
        }
        if (read <= 0) return false;

        const chunk = bytes.subarray(0, read);
        const lastBreak = chunk.lastIndexOf(0x0a);
        if (lastBreak < 0) {
          if (read >= READ_CHUNK) {
            // 一整行就超过读窗口：永远解析不了。计一次坏行并跳过，别让读指针原地打转。
            counters.corrupt += 1;
            offsets.set(file, cursor + read);
            counters.backlog = Math.max(0, stat.size - offsets.get(file));
            return false;
          }
          // 还没凑够一行：偏移原地不动，留给下一次 tick 重读。
          offsets.set(file, cursor);
          counters.backlog = Math.max(0, stat.size - cursor);
          return false;
        }

        const lines = chunk.subarray(0, lastBreak).toString('utf8').split('\n');
        let consumedBytes = 0;
        let stopped = false;
        for (const line of lines) {
          consumedBytes += Buffer.byteLength(line, 'utf8') + 1; // 行 + 换行
          if (!line.trim()) continue;
          let parsed = null;
          try { parsed = JSON.parse(line); } catch { counters.corrupt += 1; continue; }
          if (!isSafeEvent(parsed)) { counters.unsafe += 1; continue; }
          counters.parsed += 1;
          if (!matchesFilters(parsed, filters)) { counters.filtered += 1; continue; }
          const id = String(parsed.eventId ?? '');
          if (id && seen.has(id)) { counters.duplicate += 1; continue; }
          if (id) seen.add(id);
          events.push(parsed);
          if (events.length >= BATCH_CAP) { stopped = true; break; }
        }

        offsets.set(file, Math.min(cursor + consumedBytes, stat.size));
        // 还没消费的字节：批次上限挡住的完整行，或末尾那半行。都不是丢弃。
        counters.backlog = Math.max(0, stat.size - offsets.get(file));
        return stopped;
      }

      function tick() {
        if (closed || controller.desiredSize <= 0) return;
        try {
          const files = candidateFiles();
          if (!files.length) {
            if (offsets.size) {
              offsets.clear();
              counters.backlog = 0;
              send('trace', { reset: true, source: null, events: [], drops: drops() });
            }
            return;
          }
          const events = [];
          let full = false;
          for (const file of files) {
            if (full) break;
            full = readNew(file, events);
          }
          if (events.length) {
            send('trace', {
              reset: false,
              source: path.basename(files.at(-1)),
              events: events.slice(-LINE_CAP),
              drops: drops(),
            });
          } else if (counters.backlog > 0 && (counters.corrupt || counters.unsafe || counters.duplicate || counters.filtered)) {
            // 本 tick 一条都没送出去，但计数器涨了（或被 backlog 挡住）：必须让客户端看见，
            // 否则"某 tick 只涨 corrupt/unsafe/filtered"这件事永远不显示。
            send('trace', { reset: false, source: path.basename(files.at(-1)), events: [], drops: drops() });
          }
        } catch {
          counters.readError += 1;
          send('trace-error', { message: '诊断事件暂时无法读取，正在重试', drops: drops() });
        }
      }
      send('ready', { at: new Date(now()).toISOString(), filters: filters ?? null, drops: drops() });
      tick();
      timer = setInterval(tick, pollMs);
      timer.unref?.();
      keepalive = setInterval(() => {
        if (!closed && controller.desiredSize > 0) controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, 10000);
      keepalive.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    },
    cancel() { cleanup(); },
  });
}
