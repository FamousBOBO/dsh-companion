/**
 * 镜像进程的装配层：把 SSE 收进来的东西，经过校验/过滤/去重/有界队列，
 * 投给本机假 OneBot WS。
 *
 * 这一层是**唯一**决定"什么能进、什么被丢"的地方，所以它是可测的纯装配：
 * SSE 客户端不知道事件是什么，假 WS 不知道过滤规则，两边都靠这里串起来。
 *
 * 三个统计必须能同时看到（计划 §G4 要求的可核账）：
 *   - `sse`：连了几次、收了几帧、断了几次；
 *   - `filter`：按原因分类的拒绝数（形状/类型/白名单）；
 *   - `dedupe` / `queue` / `ws`：去重命中、丢弃、投递。
 */

import { admitEvent } from './event.mjs'
import { BoundedQueue, DedupeTable } from './queue.mjs'
import { SseSource } from './sse-client.mjs'
import { FakeOneBotServer } from './local-ws.mjs'

/**
 * 建一条镜像链路（不启动）。
 *
 * @param {object} options
 * @param {object} options.config   `normalizeMirrorConfig()` 的返回值
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createMirror({ config, log = () => {}, now = Date.now, fetchImpl = globalThis.fetch }) {
  const queue = new BoundedQueue({ maxEntries: config.maxQueueEntries });
  const dedupe = new DedupeTable({ ttlMs: config.dedupeTtlMs, maxEntries: config.dedupeMaxEntries, now });

  const stats = {
    received: 0,
    accepted: 0,
    rejected: { shape: 0, oversize: 0, type: 0, group: 0 },
    duplicates: 0,
    selfMessages: 0,
    dropped: 0,
    delivered: 0,
  };

  const ws = new FakeOneBotServer({
    host: config.fakeOneBotHost,
    port: config.fakeOneBotPort,
    token: config.secrets.fakeToken,
    log,
  });

  /**
   * 一帧 SSE 数据的完整处理链。**顺序即策略**：校验 → 白名单 → 去重 → 入队 → 投递。
   * @param {string} payload
   */
  function onFrame(payload) {
    stats.received += 1;
    let raw = null;
    try {
      raw = JSON.parse(payload)
    } catch {
      stats.rejected.shape += 1;
      log('[mirror] 拒绝：坏 JSON（长度 ' + payload.length + '）');
      return;
    }
    const admitted = admitEvent(raw, { allowedGroups: config.allowedGroups, maxEventBytes: config.maxEventBytes });
    if (!admitted.accepted) {
      stats.rejected[admitted.reason] = (stats.rejected[admitted.reason] ?? 0) + 1;
      // 日志只写原因与类型，**不写正文、不写群号明文**。
      log('[mirror] 拒绝：' + admitted.reason + '（' + String(admitted.detail ?? '') + '）');
      return;
    }

    const event = admitted.event;
    stats.accepted += 1;
    if (event.self) stats.selfMessages += 1;

    if (!dedupe.first(event.groupId, event.messageId)) {
      stats.duplicates += 1;
      log('[mirror] 跳过重复事件（group=' + event.groupId + ' message=' + event.messageId + '）');
      return;
    }

    const droppedNow = queue.push(event.raw);
    if (droppedNow) {
      stats.dropped = queue.dropped;
      log('[mirror] 队列已满，丢弃最旧事件（累计丢弃 ' + queue.dropped + '）');
    }

    // 单客户端、同步投递：镜像的消费端是"真实模型判断"，比这里慢得多，
    // 所以队列只是缓冲，真正投递按 drain 走（见 flush）。这里直接投，保持低延迟。
    deliver(event.raw);
  }

  function deliver(raw) {
    const sent = ws.broadcast(raw);
    if (sent > 0) {
      stats.delivered += 1;
      queue.drain();
    }
    return sent;
  }

  const source = new SseSource({
    url: config.sourceUrl,
    token: config.secrets.sourceToken,
    onFrame,
    log,
    fetchImpl,
    backoff: { baseMs: config.reconnectBaseMs, maxMs: config.reconnectMaxMs },
  });

  return {
    config,
    source,
    ws,
    queue,
    dedupe,
    stats,
    onFrame,
    /** 起假 WS，再起 SSE。顺序不能反：先有假 WS 才能投递。 */
    async start() {
      await ws.listen();
      source.start();
    },
    /** 停：先停 SSE（不再收），再停假 WS。 */
    async stop() {
      source.stop();
      await ws.close();
    },
    /** 一份可以直接写进报告的统计（不含任何正文）。 */
    report() {
      return {
        stats: { ...stats, rejected: { ...stats.rejected } },
        sse: { ...source.stats },
        ws: { ...ws.stats, lastForbidden: ws.stats.lastForbidden },
        queue: { size: queue.size, dropped: queue.dropped, pushed: queue.pushed, max: queue.maxEntries },
        dedupe: { size: dedupe.size },
      };
    },
  };
}
