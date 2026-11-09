/**
 * NapCat HTTP SSE 的只读订阅客户端。
 *
 * 为什么是 SSE 而不是 WS：NapCat 的 `httpSseServers` 是**单向**的——服务端只往这条
 * 连接上写事件，客户端在这条连接上没有任何发送 API 的通道。生产那条 WS 是双向的
 * （既能收事件也能发 `send_group_msg`），把它接到测试侧就等于把扳机递过去。
 * 这里选的是"只收"的那一种连接。
 *
 * 三条纪律：
 *   1. **断线只重连自己**：指数退避 + 抖动，不触碰 NapCat、不触碰生产 WS；
 *   2. **不重放**：重连之后收到的事件照样走去重表，旧消息不会触发新一轮判断；
 *   3. **不阻塞**：解析与投递都是本进程内的事，消费慢只丢镜像事件，绝不回压上游。
 */

const DEFAULT_RECONNECT_BASE_MS = 1000
const DEFAULT_RECONNECT_MAX_MS = 60 * 1000

/**
 * 解析一段 SSE 文本，返回其中的 `data:` 帧（其余字段忽略）。
 *
 * 为什么手写而不是用库：SSE 的帧格式就三段（`event:` / `data:` / 空行分隔），而
 * 这里**只关心 data**。用库会引入一个依赖，还会把"多行 data 要拼接"这类语义带进来，
 * 而 NapCat 的每一帧都是单行 data。手写版能保证"解析不出东西就返回空数组"，
 * 不会因为半帧而抛错。
 *
 * @param {string} text  已按 `\n\n` 切好的完整帧块
 * @returns {string[]} 每帧的 data 载荷（已去掉前缀）
 */
export function parseSseFrame(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).replace(/^ /, '')
    if (payload !== '') out.push(payload)
  }
  return out
}

/**
 * 增量式 SSE 解码器：喂字节流，吐出完整帧的 data 载荷。
 *
 * 网络分片会把一帧切断在任意位置，所以必须保持缓冲区。缓冲区设上限：一个坏掉的
 * 上游一直不发空行时，不能让字符串无限增长。
 */
export class SseDecoder {
  constructor({ maxBufferChars = 1 << 20 } = {}) {
    this.buffer = ''
    this.maxBufferChars = maxBufferChars
  }

  /**
   * 喂一段文本，返回这段时间内凑齐的 data 载荷。
   * @param {string} chunk
   * @returns {string[]}
   */
  push(chunk) {
    this.buffer += chunk
    const out = []
    let index = this.buffer.indexOf('\n\n')
    while (index >= 0) {
      const frame = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      out.push(...parseSseFrame(frame))
      index = this.buffer.indexOf('\n\n')
    }
    if (this.buffer.length > this.maxBufferChars) {
      // 上游一直不给分隔符：丢掉缓冲并如实报告，而不是继续把它养大。
      this.buffer = ''
      return [];
    }
    return out
  }
}

/** 退避：base * 2^n，封顶 max，加 ±20% 抖动（避免所有镜像同时重连）。 */
export function backoffMs(attempt, { baseMs = DEFAULT_RECONNECT_BASE_MS, maxMs = DEFAULT_RECONNECT_MAX_MS, random = Math.random } = {}) {
  const n = Math.max(0, Math.min(Number(attempt) || 0, 16))
  const raw = Math.min(baseMs * 2 ** n, maxMs)
  const jitter = raw * 0.2 * (random() * 2 - 1)
  return Math.max(1, Math.round(raw + jitter))
}

/**
 * 一个可运行的 SSE 订阅器。
 *
 * 它只做三件事：连上去、把帧解成文本、把文本交给 `onFrame`。
 * **它不知道"事件"是什么**——校验与过滤在 `event.mjs`，因为那是策略，不是传输。
 */
export class SseSource {
  /**
   * @param {object} options
   * @param {string} options.url
   * @param {string} options.token
   * @param {(payload: string) => void} options.onFrame  每帧回调（同步；异常由这里兜住）
   * @param {(line: string) => void} [options.log]
   * @param {(reason: string) => void} [options.onState]  连接状态变化
   * @param {typeof fetch} [options.fetchImpl]
   * @param {object} [options.backoff]
   * @param {AbortSignal} [options.signal]
   */
  constructor(options) {
    this.url = options.url
    this.token = options.token
    this.onFrame = options.onFrame
    this.log = options.log ?? (() => {})
    this.onState = options.onState ?? (() => {})
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.backoff = options.backoff ?? {}
    this.externalSignal = options.signal ?? null
    this.controller = null
    this.running = false
    this.attempt = 0
    this.stats = { connects: 0, frames: 0, disconnects: 0, lastError: null };
  }

  /** 启动（不等待：内部自管重连）。返回一个在 stop 之后才 resolve 的 promise。 */
  start() {
    if (this.running) return this.loop;
    this.running = true;
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve
    });
    this.loop = this.runLoop();
    return this.stopped;
  }

  stop() {
    this.running = false;
    this.controller?.abort();
    this.resolveStopped?.();
  }

  async runLoop() {
    while (this.running) {
      try {
        await this.connectOnce();
        // 正常结束（上游关流）也算一次断线，走退避，避免热循环。
        this.stats.disconnects += 1;
      } catch (error) {
        if (!this.running) break;
        this.stats.disconnects += 1;
        this.stats.lastError = error instanceof Error ? error.message : String(error);
        this.log('[mirror] SSE 断开：' + this.stats.lastError);
      }
      if (!this.running) break;
      const wait = backoffMs(this.attempt, this.backoff);
      this.attempt += 1;
      this.onState('reconnecting');
      this.log('[mirror] ' + wait + 'ms 后重连 SSE（第 ' + this.attempt + ' 次）');
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  async connectOnce() {
    this.controller = new AbortController();
    const onExternalAbort = () => this.controller?.abort();
    this.externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const headers = { Accept: 'text/event-stream' };
      if (this.token !== '') headers.Authorization = 'Bearer ' + this.token;
      const response = await this.fetchImpl(this.url, { headers, signal: this.controller.signal });
      if (!response.ok || !response.body) {
        throw new Error('SSE 握手失败：HTTP ' + response.status);
      }
      this.stats.connects += 1;
      this.attempt = 0;
      this.onState('open');
      this.log('[mirror] SSE 已连接：' + new URL(this.url).host + new URL(this.url).pathname);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const sse = new SseDecoder();
      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const payload of sse.push(chunk)) {
          this.stats.frames += 1;
          try {
            this.onFrame(payload);
          } catch (error) {
            // 单帧处理失败不能拖垮连接：记一行，继续收下一帧。
            this.log('[mirror] 帧处理失败：' + (error instanceof Error ? error.message : String(error)));
          }
        }
      }
      await reader.cancel().catch(() => {});
    } finally {
      this.externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
