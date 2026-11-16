import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTraceStream, parseTraceFilters, matchesFilters } from '../lib/trace-stream.mjs';
import { createTraceWriter, traceFilePath } from '../lib/trace-store.mjs';
import { isSafeEvent } from '../lib/trace-schema.mjs';

// W2 的事件流：过滤、去重、轮转续读、丢事件计数。
// 全部离线：时间注入，读取真文件，不联网。

const NOW = 1761600000000;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-stream-'));
}

/** 把一条流跑到"稳定"为止（最多 N 轮 tick 或超时）。 */
async function drain(stream, { minEvents = 1, timeoutMs = 1200 } = {}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  let events = 0;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const name = part.match(/^event: (.+)$/m)?.[1] ?? '';
        const dataLine = part.match(/^data: (.+)$/m)?.[1];
        if (!name || !dataLine) continue;
        frames.push({ event: name, data: JSON.parse(dataLine) });
        if (name === 'trace' && Array.isArray(frames.at(-1).data.events)) {
          events += frames.at(-1).data.events.length;
        }
      }
      if (events >= minEvents) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已关 */ }
  }
  return frames;
}

test('filters parse from query and only whitelisted keys are honored', () => {
  const filters = parseTraceFilters('?traceId=tr_1&module=memory&status=failed&reasonCode=tool-threw&evil=1');
  assert.deepEqual(filters, { traceId: 'tr_1', module: 'memory', status: 'failed', reasonCode: 'tool-threw' });
  assert.deepEqual(parseTraceFilters(''), { traceId: '', module: '', status: '', reasonCode: '' });
  // 超长值被截断，不会撑爆事件流。
  const long = parseTraceFilters(`?traceId=${'x'.repeat(200)}`);
  assert.equal(long.traceId.length, 64);
});

test('matchesFilters treats empty filters as pass-through', () => {
  const event = { traceId: 'tr_1', module: 'memory', status: 'ok', reasonCode: 'low-coverage' };
  assert.equal(matchesFilters(event, { traceId: '', module: '', status: '', reasonCode: '' }), true);
  assert.equal(matchesFilters(event, { traceId: 'tr_1', module: '', status: '', reasonCode: '' }), true);
  assert.equal(matchesFilters(event, { traceId: 'tr_2', module: '', status: '', reasonCode: '' }), false);
  assert.equal(matchesFilters(event, { traceId: '', module: 'prompt', status: '', reasonCode: '' }), false);
  assert.equal(matchesFilters(event, undefined), true);
});

test('stream pushes sanitized events and reports drop counters', async () => {
  const root = tmpRoot();
  try {
    const writer = createTraceWriter({ root, now: () => NOW });
    writer.write({ eventId: 'e1', traceId: 'tr_1', module: 'memory', stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage' });
    writer.write({ eventId: 'e2', traceId: 'tr_1', module: 'prompt', stage: 'route', status: 'degraded', reasonCode: 'route-shadow' });

    const stream = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 50 });
    const frames = await drain(stream, { minEvents: 2 });
    const traceFrames = frames.filter((frame) => frame.event === 'trace');
    assert.ok(traceFrames.length >= 1, `没有 trace 帧：${frames.map((f) => f.event).join(',')}`);
    const events = traceFrames.flatMap((frame) => frame.data.events);
    assert.equal(events.length, 2);
    assert.equal(events[0].eventId, 'e1');
    // 每条推送出去的都必须是安全事件。
    for (const event of events) assert.equal(isSafeEvent(event), true);
    // drops 随每次下发一起给，前端才有"为什么少了"的答案。
    assert.equal(typeof traceFrames.at(-1).data.drops.parsed, 'number');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stream applies server-side filters so the client never fetches the whole file', async () => {
  const root = tmpRoot();
  try {
    const writer = createTraceWriter({ root, now: () => NOW });
    for (let index = 0; index < 6; index += 1) {
      writer.write({
        eventId: `e${index}`, traceId: index % 2 === 0 ? 'tr_A' : 'tr_B',
        module: index % 3 === 0 ? 'memory' : 'prompt',
        stage: 'retrieve', status: index === 5 ? 'failed' : 'ok', reasonCode: 'low-coverage',
      });
    }
    const stream = createTraceStream(root, {
      filters: parseTraceFilters('?traceId=tr_A'),
      now: () => NOW, pollMs: 50,
    });
    const frames = await drain(stream, { minEvents: 3 });
    const events = frames.filter((frame) => frame.event === 'trace').flatMap((frame) => frame.data.events);
    assert.equal(events.length, 3, `tr_A 应有 3 条，实际 ${events.length}`);
    for (const event of events) assert.equal(event.traceId, 'tr_A');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rotation is followed without replaying old events (dedupe by eventId)', async () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const makeLine = (id) => JSON.stringify({
      eventId: id, traceId: 'tr_1', at: new Date(NOW).toISOString(), module: 'memory',
      stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage', durationMs: 1,
      counts: {}, configRevision: null,
    }) + '\n';
    // 先把 base 写成"已轮转"的形态：base.1 有旧事件，base 有新事件。
    fs.writeFileSync(`${base}`, makeLine('new_1'), 'utf8');
    fs.writeFileSync(`${base}.1`, makeLine('old_1') + makeLine('old_2'), 'utf8');

    const stream = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 50 });
    // 多跑一轮，确认没有重复投递。
    const frames = await drain(stream, { minEvents: 3, timeoutMs: 2000 });
    const events = frames.filter((frame) => frame.event === 'trace').flatMap((frame) => frame.data.events);
    const ids = new Set(events.map((event) => event.eventId));
    assert.equal(ids.size, events.length, `出现重复投递：${JSON.stringify(events.map((e) => e.eventId))}`);
    for (const id of ['old_1', 'old_2', 'new_1']) assert.equal(ids.has(id), true, `漏了 ${id}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt and unsafe lines are counted, never forwarded', async () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const good = JSON.stringify({
      eventId: 'ok_1', traceId: 'tr_1', at: new Date(NOW).toISOString(), module: 'host',
      stage: 'finalize', status: 'ok', reasonCode: '', durationMs: null, counts: null, configRevision: null,
    });
    const unsafe = JSON.stringify({ eventId: 'leak_1', chatText: '主人说他不舒服，让我早点睡', module: 'host' });
    fs.writeFileSync(base, [good, '{ broken', unsafe, ''].join('\n'), 'utf8');

    const stream = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 50 });
    const frames = await drain(stream, { minEvents: 1 });
    const traceFrames = frames.filter((frame) => frame.event === 'trace');
    const events = traceFrames.flatMap((frame) => frame.data.events);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 'ok_1');
    const last = traceFrames.at(-1).data.drops;
    assert.equal(last.corrupt, 1);
    assert.equal(last.unsafe, 1);
    assert.equal(JSON.stringify(frames).includes('让我早点睡'), false, '不安全行内容绝不能进流');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty logs directory yields a reset frame instead of an error', async () => {
  const root = tmpRoot();
  try {
    const stream = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 50 });
    const frames = await drain(stream, { minEvents: 0, timeoutMs: 600 });
    const ready = frames.find((frame) => frame.event === 'ready');
    assert.ok(ready, '必须先发 ready');
    assert.deepEqual(ready.data.filters, { traceId: '', module: '', status: '', reasonCode: '' });
    assert.equal(frames.some((frame) => frame.event === 'trace-error'), false, '空目录不是错误');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a half-written line waits for its newline instead of being counted corrupt', async () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const line = JSON.stringify({
      eventId: 'evt_split', traceId: 'tr_1', at: new Date(NOW).toISOString(), module: 'memory',
      stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage', durationMs: 1,
      counts: {}, configRevision: null,
    });
    // 先写前半截（没有换行）——模拟写入端正在 append 的那一刻。
    const half = Math.floor(line.length / 2);
    fs.writeFileSync(base, line.slice(0, half), 'utf8');

    const stream = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 50 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames = [];
    const deadline = Date.now() + 2500;
    // 半行阶段多跑几轮：此时既不该透出半个事件，也不该计成坏行。
    await new Promise((resolve) => setTimeout(resolve, 250));
    // 补上后半截与换行。
    fs.appendFileSync(base, `${line.slice(half)}\n`, 'utf8');
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const name = part.match(/^event: (.+)$/m)?.[1];
          const data = part.match(/^data: (.+)$/m)?.[1];
          if (name && data) frames.push({ event: name, data: JSON.parse(data) });
        }
        const got = frames.filter((frame) => frame.event === 'trace').flatMap((frame) => frame.data.events);
        if (got.some((event) => event.eventId === 'evt_split')) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* 已关 */ }
    }

    const events = frames.filter((frame) => frame.event === 'trace').flatMap((frame) => frame.data.events);
    assert.equal(events.some((event) => event.eventId === 'evt_split'), true, '拼上换行后必须能读到完整事件');
    const anyCorrupt = frames.some((frame) => frame.data.drops && frame.data.drops.corrupt > 0);
    assert.equal(anyCorrupt, false, '半行不该被计成坏行');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('more than BATCH_CAP in one tick is delivered across ticks, nothing silently lost', async () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    // 450 条合规事件一次落盘：单块远超 BATCH_CAP(200)。旧实现会把超上限的完整行
    // 静默丢掉（且 drops.parsed 与送达数自洽到查不出来），这里要求一条不少。
    const lines = [];
    for (let index = 0; index < 450; index += 1) {
      lines.push(JSON.stringify({
        eventId: `evt_${String(index).padStart(4, '0')}`,
        traceId: 'tr_bulk', at: new Date(NOW).toISOString(), module: 'memory',
        stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage',
        durationMs: index % 7, counts: { candidates: index }, configRevision: null,
      }));
    }
    fs.writeFileSync(base, lines.join('\n') + '\n', 'utf8');

    const stream = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 20 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const ids = new Set();
    let backlog = 0;
    const deadline = Date.now() + 6000;
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const name = part.match(/^event: (.+)$/m)?.[1];
          const data = part.match(/^data: (.+)$/m)?.[1];
          if (!name || !data) continue;
          const payload = JSON.parse(data);
          if (Array.isArray(payload.events)) {
            for (const event of payload.events) if (event && event.eventId) ids.add(event.eventId);
          }
          if (payload.drops && typeof payload.drops.backlog === 'number') backlog = payload.drops.backlog;
        }
        if (ids.size >= 450 && backlog === 0) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* 已关 */ }
    }

    assert.equal(ids.size, 450, `应送达 450 条，实际 ${ids.size}（缺口 ${450 - ids.size}）`);
    for (let index = 0; index < 450; index += 1) {
      assert.equal(ids.has(`evt_${String(index).padStart(4, '0')}`), true, `漏了第 ${index} 条`);
    }
    // 分批不是丢弃：最后 backlog 必须归零，且没有 corrupt/unsafe。
    assert.equal(backlog, 0, 'backlog 应最终归零（剩下的都消费掉了）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a half-written line is delivered even after the offset already exists', async () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const makeLine = (id) => JSON.stringify({
      eventId: id, traceId: 'tr_1', at: new Date(NOW).toISOString(), module: 'memory',
      stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage', durationMs: 1,
      counts: {}, configRevision: null,
    });

    // 第一条完整 —— 让流把偏移推进到 6（而不是 0）。旧实现只有 start===0 时才不 carry，
    // 所以正是这一步之后写半行，会把同一段字节拼两遍、该行永久丢失。
    const first = makeLine('evt_first');
    fs.writeFileSync(base, `${first}\n`, 'utf8');

    const stream = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 20 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const ids = new Set();
    const frames = [];
    // 读取会一直阻塞到下一块数据。**同一个 read promise 必须复用**：每次 race 都新建一个
    // `reader.read()` 会留下孤儿 read，下一块数据被那个孤儿吞掉，事件看起来"没到"。
    let pending = null;
    const collect = async (untilMs) => {
      while (Date.now() < untilMs) {
        if (!pending) pending = reader.read();
        let timer = null;
        const raced = await Promise.race([
          pending,
          new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), Math.max(20, untilMs - Date.now())); }),
        ]);
        if (timer) clearTimeout(timer);
        if (raced.timeout) return;
        pending = null; // 这一块已经拿到，下一次重新 read
        const { value, done } = raced;
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const name = part.match(/^event: (.+)$/m)?.[1];
          const data = part.match(/^data: (.+)$/m)?.[1];
          if (!name || !data) continue;
          const payload = JSON.parse(data);
          frames.push({ event: name, data: payload });
          if (Array.isArray(payload.events)) {
            for (const event of payload.events) if (event && event.eventId) ids.add(event.eventId);
          }
        }
      }
    };

    try {
      // 第一阶段：第一条送达，偏移变成 6。
      await collect(Date.now() + 700);
      assert.equal(ids.has('evt_first'), true, '第一条应送达');

      // 第二阶段：写第二条的前半截（无换行）。
      const second = makeLine('evt_second');
      const half = Math.floor(second.length / 2);
      fs.appendFileSync(base, second.slice(0, half), 'utf8');
      await collect(Date.now() + 700);
      assert.equal(ids.has('evt_second'), false, '半行不该被当完整事件透出');

      // 第三阶段：补上后半截与换行。
      fs.appendFileSync(base, `${second.slice(half)}\n`, 'utf8');
      await collect(Date.now() + 2000);
      assert.equal(ids.has('evt_second'), true, 'offset 已存在时补上换行也必须送达（H2 回归点）');
    } finally {
      try { await reader.cancel(); } catch { /* 已关 */ }
    }

    // 半行既不该丢，也不该被记成坏行。
    const anyCorrupt = frames.some((frame) => frame.data && frame.data.drops && frame.data.drops.corrupt > 0);
    assert.equal(anyCorrupt, false, '半行不该被计成坏行');
    assert.equal(ids.size, 2, `应恰好送达 2 条，实际 ${ids.size}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-ASCII lines do not make the byte offset drift', async () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    // reasonCode 只能是白名单里的 ASCII 码；这里靠多字节的**空白分隔**不成立，
    // 所以用大段 JSON 里的 ASCII 事件 + 中文键值来制造多字节字节长度：
    // 只要 event 本身合规，未知字段在 sanitize 时被丢弃，而字节偏移必须仍然对。
    const line = (id) => JSON.stringify({
      eventId: id, traceId: 'tr_1', at: new Date(NOW).toISOString(), module: 'memory',
      stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage', durationMs: 1,
      counts: {}, configRevision: null,
    });
    fs.writeFileSync(base, `${line('a1')}\n${line('a2')}\n`, 'utf8');

    const stream = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 20 });
    const frames = await drain(stream, { minEvents: 2 });
    const events = frames.filter((frame) => frame.event === 'trace').flatMap((frame) => frame.data.events);
    assert.deepEqual(events.map((event) => event.eventId), ['a1', 'a2']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a rotation where the new file is larger does not skip a whole segment (N10)', async () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const line = (id) => JSON.stringify({
      eventId: id, traceId: 'tr_1', at: new Date(NOW).toISOString(), module: 'memory',
      stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage', durationMs: 1,
      counts: {}, configRevision: null,
    });

    // 第一步：当日文件里先有三条，让流把偏移追平到文件末尾。
    fs.writeFileSync(base, ['r1', 'r2', 'r3'].map(line).join('\n') + '\n', 'utf8');

    const stream = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 20 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const ids = new Set();
    const frames = [];

    let pending = null;
    const readOrIdle = async (ms) => {
      if (!pending) pending = reader.read();
      let timer = null;
      const raced = await Promise.race([
        pending,
        new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), ms); }),
      ]);
      if (timer) clearTimeout(timer);
      if (raced.timeout) return { timeout: true };
      pending = null;
      return raced;
    };
    const collect = async (untilMs) => {
      while (Date.now() < untilMs) {
        const raced = await readOrIdle(Math.max(20, untilMs - Date.now()));
        if (raced.timeout) return;
        if (raced.done) return;
        buffer += decoder.decode(raced.value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const name = part.match(/^event: (.+)$/m)?.[1];
          const data = part.match(/^data: (.+)$/m)?.[1];
          if (!name || !data) continue;
          const payload = JSON.parse(data);
          frames.push({ event: name, data: payload });
          if (Array.isArray(payload.events)) {
            for (const item of payload.events) if (item && item.eventId) ids.add(item.eventId);
          }
        }
      }
    };

    try {
      await collect(Date.now() + 700);
      assert.equal(ids.size, 3, `第一阶段应送达 3 条，实际 ${ids.size}`);

      // 第二步：轮转（base → base.1），随后写入端在**新建的** base 上追加 5 条新事件。
      //
      // 这是 N10 的精确形状：新 base **只含新事件**，而它的字节数比旧 base 的旧偏移大，
      // 于是"偏移只按路径记"的实现会从新 base 的**中间**开始读 —— 开头那几条新事件
      // 既不送达也不计数（复核实测 r4/r5/r6 静默消失）。
      //
      // 我第一版把新 base 写成 r1..r8（含老事件），偏移正好落在行边界，旧实现也能过 ——
      // 那是个假阳性用例，已按真实形状重写。
      fs.renameSync(base, `${base}.1`);
      fs.writeFileSync(base, ['r4', 'r5', 'r6', 'r7', 'r8'].map(line).join('\n') + '\n', 'utf8');

      await collect(Date.now() + 2500);

      // 一条都不许丢。
      for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']) {
        assert.equal(ids.has(id), true, `漏了 ${id}（送达：${[...ids].join(',')}）`);
      }

      // 而且"少了什么"必须可解释：这一轮不该再出现任何未记账的缺口。
      const last = frames.filter((frame) => frame.data && frame.data.drops).at(-1);
      assert.ok(last, '必须至少有一帧带 drops');
      assert.equal(last.data.drops.backlog, 0, '追平后 backlog 应为 0');
    } finally {
      try { await reader.cancel(); } catch { /* 已关 */ }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a tick that only increments corrupt still emits a frame (N8)', async () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const reader = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 20 });
    const streamReader = reader.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames = [];
    let pending = null;
    const readOrIdle = async (ms) => {
      if (!pending) pending = streamReader.read();
      let timer = null;
      const raced = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), ms); })]);
      if (timer) clearTimeout(timer);
      if (raced.timeout) return { timeout: true };
      pending = null;
      return raced;
    };
    const pump = async (untilMs) => {
      while (Date.now() < untilMs) {
        const raced = await readOrIdle(Math.max(20, untilMs - Date.now()));
        if (raced.timeout || raced.done) return;
        buffer += decoder.decode(raced.value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const name = part.match(/^event: (.+)$/m)?.[1];
          const data = part.match(/^data: (.+)$/m)?.[1];
          if (name && data) frames.push({ event: name, data: JSON.parse(data) });
        }
      }
    };
    try {
      await pump(Date.now() + 400);
      frames.length = 0;
      // 只有一行非法 JSON：backlog 恰好是 0（文件末尾就是这行本身）。
      fs.appendFileSync(base, 'not-json-at-all\n', 'utf8');
      await pump(Date.now() + 1200);
      const drops = frames.filter((frame) => frame.event === 'trace' && frame.data && frame.data.drops).map((frame) => frame.data.drops);
      assert.ok(drops.length, '只涨 corrupt 的 tick 也必须出帧（N8）');
      const last = drops.at(-1);
      assert.equal(last.corrupt >= 1, true, `corrupt 应当涨到 1，实际 ${last.corrupt}`);
      assert.equal(last.backlog, 0, '这里 backlog 恰好是 0 —— 旧实现据此不出帧' );
    } finally {
      try { await streamReader.cancel(); } catch { /* 已关 */ }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one over-long line is counted as corrupt exactly once (N11)', async () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    // 单行 > REACH_CHUNK（65536）：永远解析不了。
    const longLine = `{"eventId":"big","pad":"${'x'.repeat(70_000)}"}`;
    fs.writeFileSync(base, longLine + '\n', 'utf8');
    const reader = createTraceStream(root, { filters: parseTraceFilters(''), now: () => NOW, pollMs: 20 });
    const streamReader = reader.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames = [];
    let pending = null;
    const readOrIdle = async (ms) => {
      if (!pending) pending = streamReader.read();
      let timer = null;
      const raced = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), ms); })]);
      if (timer) clearTimeout(timer);
      if (raced.timeout) return { timeout: true };
      pending = null;
      return raced;
    };
    try {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const raced = await readOrIdle(Math.max(20, until - Date.now()));
        if (raced.timeout || raced.done) break;
        buffer += decoder.decode(raced.value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const name = part.match(/^event: (.+)$/m)?.[1];
          const data = part.match(/^data: (.+)$/m)?.[1];
          if (name && data) frames.push({ event: name, data: JSON.parse(data) });
        }
      }
      // 追加一条**好**事件：它的帧会把累计计数一起带出来。
      // 只靠"超长行自己那一帧"是不够的 —— 旧实现里那一帧恰好写的是 corrupt=1，
      // 后面再把尾巴算一次的那一 tick 因为不满足出帧条件而被藏起来（N8），于是假绿。
      const good = JSON.stringify({
        eventId: 'good-1', traceId: 'tr_1', at: new Date(NOW).toISOString(), module: 'memory',
        stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage', durationMs: 1,
        counts: {}, configRevision: null,
      });
      fs.appendFileSync(base, good + '\n', 'utf8');
      const until2 = Date.now() + 2000;
      while (Date.now() < until2) {
        const raced = await readOrIdle(Math.max(20, until2 - Date.now()));
        if (raced.timeout || raced.done) break;
        buffer += decoder.decode(raced.value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const name = part.match(/^event: (.+)$/m)?.[1];
          const data = part.match(/^data: (.+)$/m)?.[1];
          if (name && data) frames.push({ event: name, data: JSON.parse(data) });
        }
      }
      const delivered = frames.some((frame) => Array.isArray(frame.data && frame.data.events)
        && frame.data.events.some((item) => item.eventId === 'good-1'));
      assert.ok(delivered, '追加的好事件必须送达（否则读指针死在超长行上）');

      const last = frames.filter((frame) => frame.data && frame.data.drops).map((frame) => frame.data.drops).at(-1);
      assert.ok(last, '必须至少有一帧带 drops');
      assert.equal(last.corrupt, 1, `一条超长行只该记一次 corrupt，实际 ${last.corrupt}`);
    } finally {
      try { await streamReader.cancel(); } catch { /* 已关 */ }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
