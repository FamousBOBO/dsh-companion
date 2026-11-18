// 入站攒批：一段话分几口气说完时，当成**一件事**回应，而不是逐条回应。
//
// 为什么需要（对照 QQ 的 `src/app/inbound/dm-buffer.ts` + `src/core/batching.ts`）：
//
//   人打字是一条一条发出来的：「在吗」→「问你个事」→「昨天那个文件你放哪了」。
//   逐条驱动模型的话，第一条会单独触发一轮「在的」，第三条才真的问到事情 ——
//   这就是"她一条条答得很碎"的来源。QQ 那条通道用**安静窗口**解决：收到消息后不立刻
//   处理，等一小会儿；这段时间里又来了消息就把窗口往后推，攒够条数/字数就立刻处理。
//
// 三条判据直接照抄 QQ，因为它们是"像人"的关键：
//
//   1. **短句等得久、长句等得短。** 一句话才三个字，多半还有下文（6 秒）；
//      已经说了八十个字，基本说完了（1.5 秒）。按字数在两者之间线性插值。
//   2. **总等待有上限。** 每来一条就推后窗口的话，一个持续说话的人能把它永远推下去，
//      她就永远不开口。`maxWaitMs` 从**第一条**算起，到点必发。
//   3. **攒满立即发。** 条数或字数触顶就不用再等安静了，直接处理。
//
// 与 QQ 的差别只有一处，是这里必须做的：**去重是按 mid 的全局集合**。VoceChat 的 mid 是
// 平台级自增，不是每会话独立，所以用全局集合；QQ 用每会话集合是因为 OneBot 的 message_id
// 语义不同。去重本身两边都要：SSE 断线重连会重投同一段帧。

/** 单调递增的 mid 去重上限：超过就砍掉前半，避免长跑进程把它养成泄漏。 */
const MAX_SEEN = 500;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 攒批配置。默认值取 QQ 私聊那一组（它已经用真实聊天调过）：
 * 短句 6 秒、长句 1.5 秒、80 字算长句、总等待 15 秒。
 *
 * @param {object} [raw]
 */
export function resolveBatching(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const shortMs = positive(input.shortMs, 6000);
  const longMs = positive(input.longMs, 1500);
  return {
    enabled: input.enabled !== false,
    // 短句窗口必须 >= 长句窗口，否则插值方向反了（写成 600/9000 这种也能自洽）。
    shortMs: Math.max(shortMs, longMs),
    longMs,
    longChars: Math.max(1, positive(input.longChars, 80)),
    maxWaitMs: positive(input.maxWaitMs, 15000),
    maxMessages: Math.max(1, positive(input.maxMessages, 8)),
    maxChars: Math.max(1, positive(input.maxChars, 4000)),
  };
}

/** 这一批的总字数（按字符数，与 QQ 的 `queueChars` 同义）。 */
export function charsOf(events) {
  let sum = 0;
  for (const event of events ?? []) sum += String(event?.content ?? '').length;
  return sum;
}

/** 攒够了没有：条数或字数任一触顶就不用再等安静窗口。 */
export function isFull(events, batching) {
  const list = events ?? [];
  return list.length >= batching.maxMessages || charsOf(list) >= batching.maxChars;
}

/**
 * 现在该等多久（毫秒）。
 *
 * `elapsedMs` 是从**这一批第一条**到现在的时长；它扣掉的是总等待预算，
 * 所以窗口只会越推越短，不会越来越长。
 */
export function windowFor(events, batching, elapsedMs = 0) {
  const chars = charsOf(events);
  const ratio = Math.min(1, Math.max(0, chars) / batching.longChars);
  const wanted = Math.round(batching.shortMs - ratio * (batching.shortMs - batching.longMs));
  const remaining = Math.max(0, batching.maxWaitMs - Math.max(0, elapsedMs));
  return Math.max(0, Math.min(wanted, remaining));
}

/**
 * 入站缓冲。
 *
 * @param {object} input
 * @param {ReturnType<typeof resolveBatching>} input.batching
 * @param {(room: string, events: object[]) => Promise<unknown>|unknown} input.flush
 *        真正去驱动回合。**必须自己吞掉异常**；这里只在它抛的时候把事件放回队列重试。
 * @param {(line: string) => void} [input.log]
 * @param {() => number} [input.now]          注入时钟，给测试用
 * @param {(fn: () => void, ms: number) => unknown} [input.setTimer]
 * @param {(handle: unknown) => void} [input.clearTimer]
 */
export function createInboundBuffer({
  batching,
  flush,
  log = null,
  now = () => Date.now(),
  setTimer = null,
  clearTimer = null,
} = {}) {
  const say = line => {
    if (typeof log !== 'function') return;
    try { log(line); } catch { /* 日志不能反过来打断收消息 */ }
  };
  const arm = setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const disarm = clearTimer ?? (handle => clearTimeout(handle));

  /** room → {events, startedAt, timer, armedFor} */
  const rooms = new Map();
  const seen = new Set();
  const stats = { accepted: 0, duplicates: 0, batches: 0, flushedEvents: 0, peakPending: 0, restores: 0 };

  function trimSeen() {
    if (seen.size <= MAX_SEEN) return;
    const keep = [...seen].slice(-Math.floor(MAX_SEEN / 2));
    seen.clear();
    for (const mid of keep) seen.add(mid);
  }

  function pendingTotal() {
    let sum = 0;
    for (const state of rooms.values()) sum += state.events.length;
    return sum;
  }

  /** 重新武装安静窗口。旧定时器先取消 —— 每来一条都推后，而不是并存多个。 */
  function schedule(room) {
    const state = rooms.get(room);
    if (!state || state.events.length === 0) return;
    if (state.timer !== null) { disarm(state.timer); state.timer = null; }
    const delay = windowFor(state.events, batching, now() - state.startedAt);
    state.armedFor = delay;
    state.timer = arm(() => {
      const current = rooms.get(room);
      if (current) current.timer = null;
      void fire(room);
    }, delay);
  }

  /** 取走这一批并交付。交付期间新到的消息会自己开一个新窗口。 */
  async function fire(room) {
    const state = rooms.get(room);
    if (!state) return;
    if (state.timer !== null) { disarm(state.timer); state.timer = null; }
    rooms.delete(room); // 先摘掉：交付耗时里进来的消息不该等这一轮结束才排进同一个窗口
    const events = state.events.splice(0);
    if (events.length === 0) return;
    stats.batches += 1;
    stats.flushedEvents += events.length;
    try {
      await flush(room, events);
    } catch (error) {
      // 内容不许丢：放回队列，按最慢那一档退避重试（与 QQ 的 `unshift(...lines)` 同一取舍）。
      stats.restores += 1;
      const back = rooms.get(room) ?? { events: [], startedAt: now(), timer: null, armedFor: 0 };
      back.events.unshift(...events);
      rooms.set(room, back);
      say(`攒批交付失败（${room}）：${String(error?.message ?? error).slice(0, 160)}；${events.length} 条已放回`);
      schedule(room);
    }
  }

  /**
   * 收一条事件。
   *
   * @returns {{accepted: boolean, reason?: string, pending?: number, armedFor?: number}}
   */
  function push(room, event) {
    const key = String(room ?? '');
    if (!key) return { accepted: false, reason: 'no-room' };

    const mid = Number(event?.mid);
    if (Number.isInteger(mid) && mid > 0) {
      if (seen.has(mid)) {
        stats.duplicates += 1;
        return { accepted: false, reason: 'duplicate' };
      }
      seen.add(mid);
      trimSeen();
    }

    let state = rooms.get(key);
    if (!state) {
      state = { events: [], startedAt: now(), timer: null, armedFor: 0 };
      rooms.set(key, state);
    }
    state.events.push(event);
    stats.accepted += 1;
    const pending = pendingTotal();
    if (pending > stats.peakPending) stats.peakPending = pending;

    // 攒满就不等安静窗口了：先取消已排的定时器，再立刻交付。
    if (isFull(state.events, batching)) {
      if (state.timer !== null) { disarm(state.timer); state.timer = null; }
      // 批大小要在 `fire` 之前读：它进来就同步把 `state.events` splice 空了，
      // 之后读到的永远是 0，返回值会诬告"这条没被接受"。
      const batchSize = state.events.length;
      void fire(key);
      return { accepted: true, pending: batchSize, armedFor: 0, full: true };
    }

    schedule(key);
    return { accepted: true, pending: state.events.length, armedFor: rooms.get(key)?.armedFor ?? 0 };
  }

  /** 立刻交付某房间已攒的内容（不改窗口，不重排）。 */
  function flushNow(room) {
    return fire(String(room ?? ''));
  }

  /** 排空所有房间。挂载被销毁时调，避免把已收下的消息留在内存里。 */
  function drain() {
    const keys = [...rooms.keys()];
    for (const key of keys) void fire(key);
    return keys.length;
  }

  function dispose() {
    for (const state of rooms.values()) {
      if (state.timer !== null) { disarm(state.timer); state.timer = null; }
    }
    const pending = pendingTotal();
    // 不在这里 flush：销毁时 agent 可能已经在拆，交付只会得到一堆失败日志。
    // 事件本身由传输行落盘（events.jsonl + 游标），需要时可以人工补跑。
    rooms.clear();
    if (pending > 0) say(`销毁时仍有 ${pending} 条未交付（已在 events.jsonl 留档）`);
    return { pending };
  }

  return {
    push,
    flushNow,
    drain,
    dispose,
    pending: pendingTotal,
    info() {
      return {
        enabled: batching.enabled,
        rooms: rooms.size,
        pending: pendingTotal(),
        windows: [...rooms.entries()].map(([room, state]) => ({
          room, events: state.events.length, armedFor: state.armedFor,
        })),
        stats: { ...stats },
      };
    },
  };
}
