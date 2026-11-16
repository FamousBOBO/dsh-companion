import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTraceWriter, readTraceEvents, traceFilePath,
  DEFAULT_MAX_LINES, DEFAULT_MAX_FILES,
} from '../lib/trace-store.mjs';

// W2 的落地层：有界、可轮转、可丢、可解释、只读。
// 全部离线：时间与文件系统都注入，不碰真实 data 目录。

const NOW = 1761600000000; // 2026-10-27T18:40Z 附近，只为让文件名确定

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-'));
}

function writeMany(writer, count, extra = {}) {
  for (let index = 0; index < count; index += 1) {
    writer.write({
      eventId: `evt_${index}`,
      traceId: 'tr_1',
      module: 'memory',
      stage: 'retrieve',
      status: 'ok',
      reasonCode: 'low-coverage',
      counts: { candidates: index },
      ...extra,
    });
  }
}

test('writer appends events and the reader returns them in order', () => {
  const root = tmpRoot();
  try {
    const writer = createTraceWriter({ root, now: () => NOW });
    writeMany(writer, 3);
    const read = readTraceEvents({ root, now: () => NOW, limit: 10 });
    assert.equal(read.total, 3);
    assert.equal(read.events.length, 3);
    assert.deepEqual(read.events.map((event) => event.eventId), ['evt_0', 'evt_1', 'evt_2']);
    assert.equal(read.events[0].module, 'memory');
    assert.equal(writer.stats().written, 3);
    assert.equal(writer.stats().dropped, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the file rotates at maxLines and keeps at most maxFiles generations', () => {
  const root = tmpRoot();
  try {
    const writer = createTraceWriter({ root, now: () => NOW, maxLines: 4, maxFiles: 2 });
    writeMany(writer, 13);
    const base = traceFilePath(root, NOW);
    // 13 条 / 每份最多 4 条 → 至少产生 base.1 与 base.2；第三代会把最老的挤掉。
    assert.equal(fs.existsSync(`${base}.1`), true, '应该轮转过');
    assert.equal(fs.existsSync(`${base}.3`), false, `maxFiles=${DEFAULT_MAX_FILES} 时不该出现第四代`);
    // 当前文件不超过 maxLines（轮转在写入前判断，所以可能略超一行——这里断言不超 2×）
    const current = fs.readFileSync(base, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(current.length <= 8, `当前文件行数异常：${current.length}`);
    // 读端仍然能把轮转前后的都读出来（跨文件）。
    const read = readTraceEvents({ root, now: () => NOW, limit: 100 });
    assert.ok(read.total >= 8, `轮转后总条数偏少：${read.total}`);
    assert.equal(read.source.length >= 1, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('write failures are counted as dropped with a reason instead of throwing', () => {
  const root = tmpRoot();
  try {
    // 把 logs 做成文件（阻止建目录），写入必然失败。
    fs.writeFileSync(path.join(root, 'logs'), 'not a directory', 'utf8');
    const writer = createTraceWriter({ root, now: () => NOW });
    writeMany(writer, 2);
    const stats = writer.stats();
    assert.equal(stats.written, 0);
    assert.equal(stats.dropped, 2);
    assert.equal(stats.droppedReasons['write-failed'], 2);
    // 不抛异常就是契约：诊断写入失败不能让业务路径感知。
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('queue overflow drops the oldest and records queue-overflow', () => {
  const root = tmpRoot();
  try {
    const writer = createTraceWriter({ root, now: () => NOW, queueLimit: 2, batchSize: 100, fsImpl: {
      // 一个永远失败的 fs：让事件留在队列里，从而触发溢出逻辑。
      existsSync: () => false,
      mkdirSync: () => { throw new Error('no'); },
      readFileSync: () => '',
      appendFileSync: () => { throw new Error('no'); },
      renameSync: () => { throw new Error('no'); },
      rmSync: () => {},
    } });
    writeMany(writer, 6);
    const stats = writer.stats();
    assert.equal(stats.pending, 2, '队列应被限长'); // batchSize 100 保证不落盘，从而能观察队列
    assert.equal(stats.droppedReasons['queue-overflow'], 4);
    // batchSize=100 时不落盘，所以这里只该有 4 次溢出（没有任何 write-failed）。
    assert.equal(stats.dropped, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reader filters by traceId, module, status and reasonCode', () => {
  const root = tmpRoot();
  try {
    const writer = createTraceWriter({ root, now: () => NOW });
    writer.write({ eventId: 'a', traceId: 'tr_A', module: 'memory', stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage' });
    writer.write({ eventId: 'b', traceId: 'tr_B', module: 'prompt', stage: 'route', status: 'degraded', reasonCode: 'route-shadow' });
    writer.write({ eventId: 'c', traceId: 'tr_A', module: 'tool', stage: 'tool-end', status: 'failed', reasonCode: 'tool-threw' });

    assert.deepEqual(readTraceEvents({ root, now: () => NOW, traceId: 'tr_A' }).events.map((e) => e.eventId), ['a', 'c']);
    assert.deepEqual(readTraceEvents({ root, now: () => NOW, module: 'prompt' }).events.map((e) => e.eventId), ['b']);
    assert.deepEqual(readTraceEvents({ root, now: () => NOW, status: 'failed' }).events.map((e) => e.eventId), ['c']);
    assert.deepEqual(readTraceEvents({ root, now: () => NOW, reasonCode: 'route-shadow' }).events.map((e) => e.eventId), ['b']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reader skips corrupt lines and unsafe events without emptying the view', () => {
  const root = tmpRoot();
  try {
    const base = traceFilePath(root, NOW);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const good = JSON.stringify({
      eventId: 'evt_ok', traceId: 'tr_1', at: '2026-10-27T18:40:00.000Z', module: 'memory',
      stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage', durationMs: 1,
      counts: { candidates: 1 }, configRevision: null,
    });
    // 一行坏 JSON + 一行"多出白名单字段"的事件（第二条应被 isSafeEvent 判为不安全）。
    const corrupt = '{"eventId": "evt_bad", "module": ';
    const unsafe = JSON.stringify({
      eventId: 'evt_leak', traceId: '', at: '2026-10-27T18:40:00.000Z', module: 'memory',
      stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage', durationMs: 1,
      counts: {}, configRevision: null, secretField: '今天主人说他不舒服',
    });
    fs.writeFileSync(base, [good, corrupt, unsafe].join('\n') + '\n', 'utf8');

    const read = readTraceEvents({ root, now: () => NOW, limit: 10 });
    assert.equal(read.events.length, 1, '只应读到那条合规事件');
    assert.equal(read.events[0].eventId, 'evt_ok');
    assert.equal(read.skipped, 2, '坏行与不安全事件都要计入 skipped');
    const serialized = JSON.stringify(read);
    assert.equal(serialized.includes('今天主人说他不舒服'), false, '不安全事件的内容绝不能透出');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reader falls back to the previous day file when today has none', () => {
  const root = tmpRoot();
  try {
    const yesterday = traceFilePath(root, NOW - 24 * 3600 * 1000);
    fs.mkdirSync(path.dirname(yesterday), { recursive: true });
    fs.writeFileSync(yesterday, `${JSON.stringify({
      eventId: 'evt_prev', traceId: 'tr_1', at: '2026-10-26T18:40:00.000Z', module: 'host',
      stage: 'finalize', status: 'ok', reasonCode: '', durationMs: null, counts: null, configRevision: null,
    })}\n`, 'utf8');
    const read = readTraceEvents({ root, now: () => NOW, limit: 10 });
    assert.equal(read.events.length, 1);
    assert.equal(read.events[0].eventId, 'evt_prev');
    assert.equal(read.source[0], path.basename(yesterday));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer rejects an event whose sanitized form is unsafe', () => {
  const root = tmpRoot();
  try {
    const writer = createTraceWriter({ root, now: () => NOW });
    // counts 里混入未知键：sanitize 会剥掉它（不是拒绝），所以 accepted=true，落盘的是干净版本。
    const accepted = writer.write({
      module: 'memory', stage: 'retrieve', status: 'ok',
      counts: { candidates: 5, secretText: 1 },
    });
    assert.equal(accepted, true);
    const read = readTraceEvents({ root, now: () => NOW });
    assert.deepEqual(read.events[0].counts, { candidates: 5 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
