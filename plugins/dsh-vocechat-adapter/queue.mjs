// 队列：同一房间串行，全局并发放控，上限明确。
//
// 三条规则，每条对应一个具体的坏结果：
//
//   1. **同房间串行。** 两条消息同时驱动同一个 agent 会让第二轮撞上第一轮的收尾
//      （宿主 inbox 允许排队，但"排队"与"我们以为发了一轮"是不同的事实）。
//   2. **全局并发默认 1。** 一个人同时在三个房间说话时，串行比三路并发更像人。
//      可配，但不建议开大：每个回合都是一次真实的模型调用。
//   3. **上限明确、超限即拒。** 无上限的队列在模型挂住时会把内存吃满，
//      而"拒绝并记一行"是可查的失败，比 OOM 好。
//
// 拒绝时不丢消息内容，只丢"这次要驱动模型"这件事 —— 事件本身已在插件侧落盘，
// 需要时可以人工补跑。

/**
 * @param {object} input
 * @param {number} [input.concurrency=1]
 * @param {number} [input.maxPending=200]
 * @param {(line: string) => void} [input.log]
 */
export function createQueue({ concurrency = 1, maxPending = 200, log = null } = {}) {
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  const cap = Number.isInteger(maxPending) && maxPending > 0 ? maxPending : 200;
  const say = line => {
    if (typeof log !== 'function') return;
    try { log(line); } catch { /* */ }
  };

  /** room → the promise tail of that room's chain. Keeps rooms independent. */
  const roomChains = new Map();
  /** Everything accepted and not yet settled: queued + running. */
  let pending = 0;
  const stats = { accepted: 0, rejected: 0, completed: 0, failed: 0, peakPending: 0 };

  // ── global semaphore ────────────────────────────────────────────────────
  let active = 0;
  const waiters = [];

  function acquire() {
    if (active < limit) {
      active += 1;
      return null; // acquired synchronously
    }
    return new Promise(resolve => waiters.push(resolve));
  }

  function release() {
    const next = waiters.shift();
    if (next) {
      // Hand the slot over instead of decrementing then incrementing: keeps `active` honest
      // and stops a burst of releases from momentarily exceeding the limit.
      next();
      return;
    }
    active = Math.max(0, active - 1);
  }

  /**
   * Enqueue one unit of work for `room`.
   *
   * @param {string} room
   * @param {() => Promise<unknown>} task
   * @returns {Promise<{ok: true, value: unknown}|{ok: false, reason: string, message?: string}>}
   *          Never rejects: a caller driving a turn must not have to catch.
   */
  function run(room, task) {
    if (typeof task !== 'function') return Promise.resolve({ ok: false, reason: 'not-a-task' });
    if (pending >= cap) {
      stats.rejected += 1;
      say(`queue full (${pending}/${cap}); refusing work for ${room}`);
      return Promise.resolve({ ok: false, reason: 'queue-full' });
    }

    pending += 1;
    stats.accepted += 1;
    if (pending > stats.peakPending) stats.peakPending = pending;

    const key = String(room ?? '');
    const previous = roomChains.get(key) ?? Promise.resolve();

    const settled = previous
      .catch(() => {})
      .then(async () => {
        const slot = acquire();
        if (slot) await slot;
        try {
          const value = await task();
          stats.completed += 1;
          return { ok: true, value };
        } catch (error) {
          stats.failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          say(`task failed for ${key}: ${message.slice(0, 200)}`);
          return { ok: false, reason: 'task-threw', message: message.slice(0, 200) };
        } finally {
          release();
          pending -= 1;
          // Forget an idle room so the map cannot grow with every channel ever seen.
          // Only safe when this chain is still the tail: a follower would have replaced it.
          if (roomChains.get(key) === settled) roomChains.delete(key);
        }
      });

    // The stored tail ignores the result: one failing task must not poison the room.
    roomChains.set(key, settled);
    return settled;
  }

  return {
    run,
    info() {
      return {
        pending,
        active,
        limit,
        cap,
        rooms: roomChains.size,
        stats: { ...stats },
      };
    },
  };
}
