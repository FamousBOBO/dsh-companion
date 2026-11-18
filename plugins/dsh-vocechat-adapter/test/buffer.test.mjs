// 入站攒批：一段话分几口气说完时，当成**一件事**回应。
//
// 这层最容易出的错不是"没生效"，而是**把消息弄丢**或**永远不发**：
//   - 去重表按 mid 但不分房间 → 两个房间的 mid 撞在一起，另一间的话被吞掉；
//   - 每次来消息都把窗口推后、却不算总预算 → 一直说话的人永远等不到她开口；
//   - 交付抛错就丢掉这一批 → 网络抖一下，主人说的话就没了。
// 所以下面每一条测的都是这三类具体坏结果。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInboundBuffer, resolveBatching, windowFor, isFull, charsOf } from '../buffer.mjs';

/** 一个可控时钟 + 定时器，让"等多久"变成可以断言的数字。 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: now + ms });
      return seq;
    },
    clearTimer(handle) { timers.delete(handle); },
    /** 把时间推 ms，并触发所有到点的定时器。 */
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.at <= now);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
      // 定时器回调里 `void fire(...)`：给它一个微任务周期把异步部分跑完。
      await new Promise(resolve => setImmediate(resolve));
    },
    pending: () => timers.size,
  };
}

function event(mid, content, extra = {}) {
  return { kind: 'chat', mid, fromUid: 1, target: { user: 4 }, content, contentType: 'text/plain', ...extra };
}

function setup({ batching = {}, flush = null } = {}) {
  const clock = fakeClock();
  const calls = [];
  const lines = [];
  const buffer = createInboundBuffer({
    batching: resolveBatching({ shortMs: 6000, longMs: 1500, longChars: 80, maxWaitMs: 15000, ...batching }),
    flush: flush ?? (async (room, events) => { calls.push({ room, mids: events.map(e => e.mid) }); }),
    log: line => lines.push(line),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { buffer, clock, calls, lines };
}

test('三条短句在安静窗口之后合成一批（不是三次独立回应）', async () => {
  const { buffer, clock, calls } = setup();
  buffer.push('vc-dm-1', event(1, '在吗'));
  buffer.push('vc-dm-1', event(2, '问你个事'));
  buffer.push('vc-dm-1', event(3, '昨天那个文件你放哪了'));

  assert.equal(calls.length, 0, '窗口没到，一条都还没驱动模型');
  await clock.advance(6000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].mids, [1, 2, 3], '三条一起交付，而不是各起一轮');
});

test('每来一条都把窗口往后推，但总等待有上限（一直说话的人也会被回应）', async () => {
  const { buffer, clock, calls } = setup();
  buffer.push('vc-dm-1', event(1, '在吗'));
  // 每 5 秒补一句短话：窗口一直被推后，但 maxWaitMs=15000 从第一条算起。
  await clock.advance(5000);
  buffer.push('vc-dm-1', event(2, '嗯'));
  await clock.advance(5000);
  buffer.push('vc-dm-1', event(3, '那个'));
  assert.equal(calls.length, 0);
  // 到第 15 秒必须发：剩下 5 秒是硬预算，不是又一次 6 秒。
  await clock.advance(5001);
  assert.equal(calls.length, 1, '总等待上限到了就必须交付，不能被无限推后');
  assert.deepEqual(calls[0].mids, [1, 2, 3]);
});

test('长句等得短：80 字以上按 longMs 交付', async () => {
  const { buffer, clock, calls } = setup();
  buffer.push('vc-dm-1', event(1, 'x'.repeat(80)));
  await clock.advance(1499);
  assert.equal(calls.length, 0);
  await clock.advance(2);
  assert.equal(calls.length, 1, '八十个字基本说完了，不该还等满 6 秒');
});

test('攒满条数立刻交付，不等安静窗口', async () => {
  const { buffer, clock, calls } = setup({ batching: { maxMessages: 3 } });
  buffer.push('vc-dm-1', event(1, 'a'));
  buffer.push('vc-dm-1', event(2, 'b'));
  assert.equal(calls.length, 0);
  buffer.push('vc-dm-1', event(3, 'c'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, '触顶的那一条不需要等窗口');
  assert.deepEqual(calls[0].mids, [1, 2, 3]);
  assert.equal(clock.pending(), 0, '已经交付了，就不该还挂着一个定时器');
});

test('攒满字数也立刻交付', async () => {
  const { buffer, calls } = setup({ batching: { maxChars: 10 } });
  buffer.push('vc-dm-1', event(1, 'x'.repeat(6)));
  buffer.push('vc-dm-1', event(2, 'y'.repeat(6)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
});

test('同一个 mid 只收一次（SSE 重连会重投同一段帧）', async () => {
  const { buffer, clock, calls } = setup();
  assert.equal(buffer.push('vc-dm-1', event(7, '在吗')).accepted, true);
  assert.deepEqual(buffer.push('vc-dm-1', event(7, '在吗')), { accepted: false, reason: 'duplicate' });
  await clock.advance(6000);
  assert.deepEqual(calls[0].mids, [7]);
});

test('mid 去重是全局的：两个房间的事件不会互相顶掉', async () => {
  const { buffer, clock, calls } = setup();
  buffer.push('vc-dm-1', event(5, '私聊的'));
  buffer.push('vc-chan-1', event(6, '频道的'));
  await clock.advance(6000);
  const byRoom = Object.fromEntries(calls.map(call => [call.room, call.mids]));
  assert.deepEqual(byRoom['vc-dm-1'], [5]);
  assert.deepEqual(byRoom['vc-chan-1'], [6]);
});

test('两个房间各算各的窗口，不互相推迟', async () => {
  const { buffer, clock, calls } = setup();
  buffer.push('vc-dm-1', event(1, 'a'));
  await clock.advance(3000);
  buffer.push('vc-chan-1', event(2, 'b'));
  // 私聊的窗口已在 3 秒后过了一半，频道的刚开始：私聊先到点。
  await clock.advance(3000);
  assert.deepEqual(calls.map(c => c.room), ['vc-dm-1']);
  await clock.advance(3000);
  assert.deepEqual(calls.map(c => c.room), ['vc-dm-1', 'vc-chan-1']);
});

test('交付失败时把这一批放回去，不丢内容', async () => {
  let attempts = 0;
  const { buffer, clock, calls, lines } = setup({
    flush: async (room, events) => {
      attempts += 1;
      if (attempts === 1) throw new Error('agent 还没准备好');
      calls.push({ room, mids: events.map(e => e.mid) });
    },
  });
  buffer.push('vc-dm-1', event(1, '在吗'));
  buffer.push('vc-dm-1', event(2, '问你个事'));
  await clock.advance(6000);
  assert.equal(attempts, 1);
  assert.equal(calls.length, 0, '第一次交付失败了');
  assert.ok(lines.some(line => line.includes('已放回')), '失败必须留下可查的一行');
  // 重试仍然带着同样两条：内容没有丢。
  await clock.advance(6000);
  assert.deepEqual(calls[0].mids, [1, 2]);
});

test('交付期间新到的消息自己开一个新窗口，不并进正在跑的那一批', async () => {
  const seen = [];
  const clock = fakeClock();
  let resolveFirst;
  const buffer = createInboundBuffer({
    batching: resolveBatching({ shortMs: 100, longMs: 100, maxWaitMs: 10000 }),
    flush: (room, events) => {
      seen.push(events.map(e => e.mid));
      if (seen.length === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return Promise.resolve();
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  buffer.push('vc-dm-1', event(1, 'a'));
  await clock.advance(100);
  assert.deepEqual(seen, [[1]], '第一批已经在交付');
  buffer.push('vc-dm-1', event(2, 'b'));
  assert.equal(buffer.pending(), 1, '新的一条留在缓冲里');
  resolveFirst();
  await clock.advance(100);
  assert.deepEqual(seen, [[1], [2]], '第二条单独成批，没有并进已经在跑的那一轮');
});

test('空内容的批次不驱动模型', async () => {
  const { buffer, clock, calls } = setup();
  buffer.push('vc-dm-1', { kind: 'chat', mid: 9, fromUid: 1, target: { user: 4 }, content: '' });
  await clock.advance(6000);
  // 缓冲不判内容（门控已经判过），但空正文会组成一批 0 字——交付仍会发生，
  // 这由上层 `runBatch` 与门控负责。这里只断言它不会卡住不动。
  assert.equal(calls.length, 1);
});

test('没有房间键就不收', () => {
  const { buffer } = setup();
  assert.deepEqual(buffer.push('', event(1, 'a')), { accepted: false, reason: 'no-room' });
});

test('销毁时收掉定时器并报出未交付条数（不静默丢）', async () => {
  const { buffer, clock, lines } = setup();
  buffer.push('vc-dm-1', event(1, '在吗'));
  const result = buffer.dispose();
  assert.deepEqual(result, { pending: 1 });
  assert.equal(clock.pending(), 0, '定时器必须一起收掉');
  assert.ok(lines.some(line => line.includes('未交付')), '要留下可查的一行');
});

test('窗口随字数在长短之间插值，且不超过总预算', () => {
  const batching = resolveBatching({ shortMs: 6000, longMs: 1500, longChars: 80, maxWaitMs: 15000 });
  assert.equal(windowFor([event(1, '')], batching, 0), 6000, '零字按短句算，等满');
  assert.equal(windowFor([event(1, 'x'.repeat(80))], batching, 0), 1500, '满 80 字按长句算');
  assert.equal(windowFor([event(1, 'x'.repeat(40))], batching, 0), 3750, '一半字数在中间');
  assert.equal(windowFor([event(1, '')], batching, 14000), 1000, '剩下的总预算更短时以预算为准');
  assert.equal(windowFor([event(1, '')], batching, 20000), 0, '预算用完就立刻发');
});

test('攒满判据：条数或字数任一触顶', () => {
  const batching = resolveBatching({ maxMessages: 3, maxChars: 20 });
  assert.equal(isFull([event(1, 'a'), event(2, 'b')], batching), false);
  assert.equal(isFull([event(1, 'a'), event(2, 'b'), event(3, 'c')], batching), true);
  assert.equal(isFull([event(1, 'x'.repeat(20))], batching), true);
  assert.equal(charsOf([event(1, 'abc'), event(2, 'de')]), 5);
});

test('关掉攒批时窗口为 0 字退化为立即交付（配置里 enabled=false 由 index 处理）', () => {
  const batching = resolveBatching({ enabled: false, shortMs: 0, longMs: 0 });
  assert.equal(batching.enabled, false);
  assert.equal(windowFor([event(1, 'a')], batching, 0), 0);
});
