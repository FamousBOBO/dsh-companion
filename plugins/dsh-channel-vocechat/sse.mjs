// SSE 入站客户端：用户身份的事件流，取代 V1 的 webhook server。
//
// 实测事实（2026-11-17，evidence/user-protocol-test.json + user-stability.log）：
//
//   GET /api/user/events?api-key=<access token>&after_mid=<n>
//     → 200 `text/event-stream`
//     → 帧格式 `data: {json}\n\n`
//     → 帧类型实测：users_snapshot, users_state, related_groups, server_config_changed,
//       user_settings, chat, ready, heartbeat
//     → `chat` 帧的形状与 Bot webhook 的 body **完全相同**，所以 normalize.mjs 不用改
//     → `after_mid` 是**严格增量的下界**：after_mid=0 补 23 条历史，after_mid=228 只补 229..232
//     → 篡改 token → 401，content-type 为 null（不是半开的流）
//
// 由这些事实推出五条设计：
//
//   1. **`after_mid` 必须是真的 lastMid。** 传 0 会全量重放历史 → DSH 把旧消息当新问题。
//      所以 `store.mjs` 的 `last-processed.json` 在这里是**功能依赖**，不是优化。
//   2. **401 先续期再重连。** 原地重试只会无限 401（token 只活 5 分钟）。
//   3. **断线重连用 after_mid 接上。** 这是 V1 的 Bot webhook 完全没有的能力：
//      Bot 侧进程不在＝永久丢，SSE 侧起来后补回来。
//   4. **重连退避。** 首次 1 秒，指数退避到 30 秒封顶；连续失败记诊断，不刷屏。
//   5. **只有 `chat` 帧进 normalize。** 其他帧是状态同步（用户清单、配置变更等），
//      对适配层没有意义；把它们记成"跳过"而不是"错误"，避免日志噪音掩盖真问题。

import { normalizeEvent, describeEvent } from './normalize.mjs';

const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 120000;

/** Is this a chat frame we should normalize? Everything else is state sync. */
function isChatFrame(frame) {
  // Strict boolean: a caller composing if (isChatFrame(f) && …) must not receive the frame.
  return Boolean(frame) && typeof frame === 'object' && frame.type === 'chat';
}

/**
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {object} input.auth        createAuth() result
 * @param {object} input.store       createStore() result — supplies/records the cursor
 * @param {(event: object, frame: object) => void} input.onEvent   called per accepted chat frame
 * @param {number} [input.reconnectBaseMs]
 * @param {number} [input.reconnectMaxMs]
 * @param {number} [input.timeoutMs]           per-connection inactivity timeout
 * @param {typeof fetch} [input.fetchImpl]
 * @param {(line: string) => void} [input.log]
 * @param {object} [input.stats]                shared counters object (optional)
 */
export function createSseClient({
  baseUrl,
  auth,
  store,
  api = null,
  seedChannel = 1,
  onEvent,
  reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
  reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
  timeoutMs = 15000,
  idleTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  fetchImpl = null,
  log = null,
  stats = null,
} = {}) {
  const origin = String(baseUrl ?? '').replace(/\/+$/, '');
  const doFetch = fetchImpl ?? globalThis.fetch;
  const say = message => {
    if (typeof log !== 'function') return;
    try { log(message); } catch { /* logging must never break delivery */ }
  };

  const counters = stats ?? {
    connects: 0,
    disconnects: 0,
    renewals: 0,
    chat: 0,
    skipped: 0,
    rejected: 0,
    duplicates: 0,
    errors: 0,
    lastError: null,
    lastFrameAt: null,
  };

  let running = false;
  let stopped = false;
  let controller = null;
  let loopPromise = null;
  let backoff = reconnectBaseMs;

  /** Where the next connection should resume from. */
  function cursor() {
    try {
      const value = store.getCursor();
      return Number.isInteger(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  /** Handle one parsed SSE frame. */
  function handleFrame(frame) {
    counters.lastFrameAt = Date.now();
    if (!isChatFrame(frame)) {
      // State sync, not a message. Counted separately so a silent stream is diagnosable.
      counters.skipped += 1;
      return;
    }

    const normalized = normalizeEvent(frame);
    if (!normalized.ok) {
      // A chat frame we cannot understand. Record it: the platform changed, or we did.
      counters.rejected += 1;
      try { store.recordGap('sse-normalize-rejected', { reason: normalized.reason, mid: frame.mid }); } catch { /* */ }
      return;
    }

    const event = normalized.event;

    // Idempotency stays here as a second belt over `after_mid`. Reconnect + backlog means a
    // frame can legitimately arrive twice (the platform sends the boundary frame again).
    if (!store.claim(event.mid)) {
      counters.duplicates += 1;
      return;
    }

    // Persist before consuming, the same contract the V1 webhook had before it ACKed a POST.
    // Two things depend on it: the `seen` set is rebuilt from this log on a cold start (so
    // idempotency survives losing the warm cache), and it is the audit trail of what actually
    // arrived — the only place a rejected-but-delivered message can still be inspected.
    const appended = store.appendEvent(event, frame);
    if (!appended.ok) {
      // Not fatal: the cursor still advances and the platform still has the message. Recorded
      // so a full disk does not silently degrade idempotency into "best effort".
      try { store.recordGap('sse-append-failed', { mid: event.mid, reason: appended.reason }); } catch { /* */ }
    }

    counters.chat += 1;
    try {
      onEvent(event, frame);
    } catch (error) {
      counters.errors += 1;
      counters.lastError = String(error?.message ?? error).slice(0, 200);
      try {
        store.recordGap('sse-consumer-threw', { mid: event.mid, message: counters.lastError });
      } catch { /* */ }
      say(`[vocechat-sse] consumer threw on ${describeEvent(event)}: ${counters.lastError}`);
    }

    // Advance the cursor only after the consumer has had its turn. A crash before this replays
    // the event on the next connect — that is what "at least once" means here.
    try { store.setCursor(event.mid); } catch { /* */ }
  }

  // ── 首次连接的起点 ────────────────────────────────────────────────────────
  // `after_mid=0` 会**全量补播历史**（实测：23 条）。真实部署里那意味着第一次启动就把
  // 整段聊天记录当新消息喂给适配层 → 重复驱动回合、重复回复。
  //
  // 所以：库里没有游标（cursor === 0）时，先用 `history(limit=1)` 取当前最大 mid 作为起点，
  // 只接收"从现在开始"的消息。游标一旦存在，就严格用它 —— 那是真的增量。
  //
  // 这一步的失败是**安全的**：拿不到最大 mid 就保持 0（会补播历史），并在日志里明说；
  // 补播历史比丢掉真实新消息好，但两者都不该沉默。
  let seeded = false;
  async function seedCursorIfNeeded() {
    if (seeded) return;
    seeded = true;
    if (cursor() > 0) return;
    if (!api || typeof api.history !== 'function') {
      say('[vocechat-sse] 游标为 0 且没有 history 能力：首次连接将补播历史');
        return;
      }
      try {
        // Probing the main channel is enough: mids are global, one row gives the current top.
        const rows = await api.history({ channel: seedChannel }, { limit: 1 });
        const top = Number(Array.isArray(rows) ? rows[0]?.mid : null);
        if (Number.isInteger(top) && top > 0) {
          store.setCursor(top);
          say(`[vocechat-sse] 首次连接以当前最大 mid=${top} 为起点（不补播历史）`);
        } else {
          say('[vocechat-sse] 无法确定当前最大 mid：首次连接将补播历史');
        }
      } catch (error) {
        say(`[vocechat-sse] seed 失败（首次连接将补播历史）：${String(error?.message ?? error).slice(0, 160)}`);
      }
    }

  /** One connection attempt. Resolves when the stream ends; never rejects for a normal failure. */
  async function connectOnce() {
    await seedCursorIfNeeded();
    const token = await auth.token();
    const from = cursor();
    const url = `${origin}/api/user/events?after_mid=${from}&api-key=${encodeURIComponent(token)}`;
    say(`[vocechat-sse] connecting after_mid=${from}`);

    controller = new AbortController();
    let response;
    try {
      response = await doFetch(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    } catch (error) {
      counters.errors += 1;
      counters.lastError = String(error?.message ?? error).slice(0, 200);
      return { connected: false, reason: 'network' };
    }

    if (!response.ok) {
      counters.errors += 1;
      counters.lastError = `HTTP ${response.status}`;
      // 401 means the access token died: renew synchronously, then this attempt fails and the
      // loop's next iteration reconnects with a fresh token. Never retry the same URL.
      if (response.status === 401) {
        try {
          await auth.refreshNow();
          counters.renewals += 1;
          say('[vocechat-sse] 401 → 已续期，下一轮重连');
        } catch (error) {
          counters.lastError = `401 + renew failed: ${String(error?.message ?? error).slice(0, 120)}`;
        }
        return { connected: false, reason: 'unauthorized' };
      }
      // Drain the body so the socket is released.
      try { await response.text(); } catch { /* */ }
      return { connected: false, reason: `http-${response.status}` };
    }

    counters.connects += 1;
    backoff = reconnectBaseMs;
    say(`[vocechat-sse] connected (after_mid=${from})`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastReadAt = Date.now();

    try {
      while (!stopped) {
        if (Date.now() - lastReadAt > idleTimeoutMs) {
          say(`[vocechat-sse] idle ${Math.round(idleTimeoutMs / 1000)}s with no bytes — reconnecting`);
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        lastReadAt = Date.now();

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; only the `data:` lines carry JSON.
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split('\n');
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            // `event:` / `id:` / `retry:` are ignored: the payload carries its own type.
          }
          if (dataLines.length === 0) continue;
          let frame;
          try {
            frame = JSON.parse(dataLines.join('\n'));
          } catch {
            counters.rejected += 1;
            continue;
          }
          handleFrame(frame);
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        counters.errors += 1;
        counters.lastError = String(error?.message ?? error).slice(0, 200);
        say(`[vocechat-sse] stream error: ${counters.lastError}`);
      }
      return { connected: false, reason: 'stream-error' };
    } finally {
      // **`await` matters here, not just `try`.** After the socket dies mid-stream, `reader.cancel()`
      // returns a promise that REJECTS with the same `terminated` error. A synchronous `try/catch`
      // around it cannot catch a rejection, so it becomes an `unhandledRejection` — and
      // `dsh-app-boot` installs a process-wide handler that treats any unhandled rejection as a
      // **fatal load failure and calls `proc.exit(1)`**. Measured 2026-11-17: stopping the VoceChat
      // container killed the entire DSH host. Both cleanups are awaited and swallowed for that reason.
      try { controller.abort(); } catch { /* abort never rejects synchronously */ }
      try { await reader.cancel(); } catch { /* the stream is already dead: this is the expected path */ }
    }

    counters.disconnects += 1;
    return { connected: true, reason: 'closed' };
  }

  /** The reconnect loop. Runs until stop() is called. */
  async function loop() {
    while (!stopped) {
      let outcome;
      try {
        outcome = await connectOnce();
      } catch (error) {
        counters.errors += 1;
        counters.lastError = String(error?.message ?? error).slice(0, 200);
        // 把原因写出来：`threw` 单独一行时，401/网络/续期失败在日志里长得一模一样，
        // 2026-11-18 那次"能收不能发"就是被这四个字母盖住的。
        say(`[vocechat-sse] 连接抛错：${counters.lastError}`);
        outcome = { connected: false, reason: 'threw' };
      }
      if (stopped) break;
      if (outcome.connected) {
        // A normally closed stream: reconnect immediately, the cursor makes it incremental.
        continue;
      }
      // Failure: back off, capped, and never tighter than the base.
      const wait = Math.min(backoff, reconnectMaxMs);
      say(`[vocechat-sse] ${outcome.reason} → retry in ${Math.round(wait / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, wait));
      backoff = Math.min(backoff * 2, reconnectMaxMs);
    }
  }

  return {
    /** Start the loop. Idempotent: a second call returns the same promise. */
    start() {
      if (loopPromise) return loopPromise;
      stopped = false;
      running = true;
      loopPromise = loop().finally(() => {
        running = false;
        loopPromise = null;
      });
      return loopPromise;
    },

    /**
     * Stop the loop and close the stream. Idempotent.
     *
     * The wait is bounded on purpose: a wedged `reader.read()` (a half-open socket, a runtime
     * that ignores the abort signal) must not hang the host's dispose path. After `stopTimeoutMs`
     * we report that the loop is still winding down and return anyway — the process is going
     * away, and a dangling reader inside a dead process costs nothing.
     */
    async stop({ stopTimeoutMs = 3000 } = {}) {
      stopped = true;
      running = false;
      try { controller?.abort(); } catch { /* */ }
      const pending = loopPromise;
      loopPromise = null;
      if (!pending) return { stopped: true, timedOut: false };
      let timer = null;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve('timeout'), stopTimeoutMs);
        // A ref'd timer would keep the host alive for stopTimeoutMs after an otherwise clean
        // shutdown; unref where the runtime supports it.
        try { timer.unref?.(); } catch { /* not supported */ }
      });
      const outcome = await Promise.race([
        pending.then(() => 'done').catch(() => 'done'),
        timeout,
      ]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        say('[vocechat-sse] stop timed out waiting for the stream to close');
        return { stopped: false, timedOut: true };
      }
      return { stopped: true, timedOut: false };
    },

    /** Runtime facts. No token, no payload. */
    info() {
      return {
        running,
        cursor: cursor(),
        counters: { ...counters },
      };
    },

    /** For tests: inject one frame as if it came off the wire. */
    handleFrame,
  };
}

export { isChatFrame };
