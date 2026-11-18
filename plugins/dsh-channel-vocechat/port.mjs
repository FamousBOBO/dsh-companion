// 插件唯一的对外形状：`companionVoceChat`。
//
// 契约与 V1 保持**完全一致** —— 这是刻意的：适配层已经在 V1 的契约上写，
// 换传输实现不该让适配层跟着改。变的只有内部（Bot webhook → 用户 SSE）。
//
// 五条设计约束，每条都有实测或事故作为依据：
//
//   1. **`send` 吃判别式目标**，不是 isGroup 布尔。`{channel:n}` / `{user:n}`，
//      让「把频道号发进私聊」这类错误在类型上不可表达。
//   2. **`subscribe` 是回调，不是事件总线。** 插件不决定谁处理、不重试、不排队；
//      那些是回合调度的事，属于适配层。SSE 已经是"至少一次"，重试在上面做才有意义。
//   3. **没有 getMessage / deleteMessage。** 用户身份确实能读历史（`history()` 有了），
//      但删消息实测 401/403；写进契约会让适配层建在平台给不了的承诺上。
//   4. **`info()` 只报事实，不含凭据。** 没有 token、没有 refresh_token、没有 api-key。
//   5. **`subscribe` 串行派发并隔离失败。** 一个 handler 抛错不能吞掉别人的事件 ——
//      V1 的 port 测试就是这么定的，V2 沿用。

import { describeEvent } from './normalize.mjs';

/**
 * @param {object} input
 * @param {object} input.api      createUserApi() result
 * @param {object} input.store    createStore() result
 * @param {object} input.sse      createSseClient() result
 * @param {object} input.auth     createAuth() result
 * @param {object} input.config   resolved config
 * @param {object} [input.health] probe function
 * @param {(line: string) => void} [input.log]
 */
export function createPort({ api, store, sse, auth, config, health = null, log = null } = {}) {
  const say = message => {
    if (typeof log !== 'function') return;
    try { log(message); } catch { /* logging must never break delivery */ }
  };

  /** Subscribers in registration order. Dispatch is serial across them, never parallel. */
  const subscribers = [];

  /**
   * Hand one event to every subscriber, in order.
   * A throwing subscriber is recorded as a gap and does not stop the others.
   */
  async function dispatch(event) {
    for (const handler of subscribers.slice()) {
      try {
        await handler(event);
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 200);
        try { store.recordGap('subscriber-failed', { mid: event.mid, message }); } catch { /* */ }
        say(`[vocechat] subscriber failed on ${describeEvent(event)}: ${message}`);
      }
    }
  }

  const service = {
    // ── outbound：唯一写入口 ────────────────────────────────────────────
    /**
     * @param {{channel:number}|{user:number}} target
     * @param {string} text
     * @param {'text/plain'|'text/markdown'} [contentType]
     * @returns {Promise<{mid: number|null}>}
     */
    send(target, text, contentType = 'text/plain') {
      return api.send(target, text, contentType);
    },

    // ── inbound：订阅，不是总线 ─────────────────────────────────────────
    /**
     * @param {(event: object) => void|Promise<void>} handler
     * @returns {() => void} idempotent unsubscribe
     */
    subscribe(handler) {
      if (typeof handler !== 'function') return () => {};
      subscribers.push(handler);
      let off = false;
      return () => {
        if (off) return;
        off = true;
        const index = subscribers.indexOf(handler);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },

    // ── 读：用户身份带来的新能力（Bot 时代没有）────────────────────────
    /** Channel history. `before` = cursor mid for paging. */
    history(target, options) {
      return api.history(target, options);
    },

    /** Channel detail: name, members, owner. 403 when not a member. */
    channel(gid) {
      return api.channel(gid);
    },

    /** Contacts. */
    contacts() {
      return api.contacts();
    },

    // ── 信息 ────────────────────────────────────────────────────────────
    /** The user this channel speaks as. */
    me() {
      return api.me();
    },

    /** One harmless authenticated round trip. Never throws. */
    status() {
      return health ? health() : api.status();
    },

    /** Runtime facts. No credentials, no payload. */
    info() {
      const sseInfo = sse.info();
      return {
        uid: config?.uid ?? 0,
        deviceName: config?.deviceName ?? '',
        baseHost: api.describe?.().origin ?? null,
        auth: auth.describe?.() ?? null,
        sse: {
          running: sseInfo.running,
          cursor: sseInfo.cursor,
          counters: sseInfo.counters,
        },
        subscribers: subscribers.length,
        // SSE has no inbound queue; the adapter's turn queue owns that number.
        queueDepth: 0,
        seen: store.seenSize(),
        paths: { events: store.eventsFile, gaps: store.gapFile },
      };
    },
  };

  return { service, dispatch, subscriberCount: () => subscribers.length };
}
