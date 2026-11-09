/**
 * 本机假 OneBot v11 WebSocket 端点：**只发事件，永不转发动作**。
 *
 * 这是整套隔离里最硬的一道物理防线。测试 DSH 的 `OneBotClient` 是双向的——它连上
 * 之后会通过 `call(action, params)` 发请求。这个假服务器对**任何** action 都回一个
 * 明确的失败帧，并且**没有**任何指向真实 NapCat 的对象、URL 或令牌。
 *
 * 三条不能商量的规矩：
 *   1. **不回假成功**：绝不返回 `retcode: 0` + 合成 message_id。计划 §2.3 明写禁止——
 *      假成功会让测试运行时的 `sent-log` 记下"已发送"，于是"零发送"就变成了谎话。
 *   2. **不给查询开洞**：`get_login_info` / `get_status` 这类纯查询也不转发、不造假数据。
 *      任何"只放行查询"的白名单都会在下一次新增动作时变成一个洞。
 *   3. **记下每一次尝试**：`forbiddenActionAttempts` 是判"本次运行未通过出站约束"的依据，
 *      所以要在拒绝的同一处累加，不依赖日志解析。
 */

import { WebSocketServer } from 'ws'

/** 这个服务器允许的东西：**没有**。保留常量是为了让"零"这件事可被断言。 */
export const ALLOWED_ACTIONS = Object.freeze([]);

/**
 * 一次越权尝试的记录。`params` 只留**形状**（键名与标量长度），不留正文。
 */
function describe(params) {
  if (typeof params !== 'object' || params === null) return { kind: typeof params }
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') out[key] = 'string(' + value.length + ')'
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
    else if (Array.isArray(value)) out[key] = 'array(' + value.length + ')'
    else out[key] = typeof value
  }
  return out
}

/**
 * 假 OneBot WS 服务器。
 *
 * 用法：`const server = new FakeOneBotServer({port, token}); await server.listen();`
 * 然后 `server.broadcast(event)` 把事件发给已连接的测试客户端。
 */
export class FakeOneBotServer {
  /**
   * @param {object} options
   * @param {string} options.host  必须是回环地址（由 config.mjs 保证）
   * @param {number} options.port
   * @param {string} options.token 握手 Token（与 NapCat 的令牌不同源）
   * @param {(line: string) => void} [options.log]
   */
  constructor({ host, port, token, log = () => {} }) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.log = log;
    this.server = null;
    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set();
    this.stats = {
      connections: 0,
      rejectedHandshakes: 0,
      eventsSent: 0,
      forbiddenActionAttempts: 0,
      lastForbidden: null,
    };
  }

  /** 开始监听。端口被占用时抛错（不自动换端口：换端口会让配置与实物悄悄不一致）。 */
  listen() {
    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({ host: this.host, port: this.port });
      this.server.once('listening', () => {
        this.log('[mirror] 假 OneBot WS 已监听 ' + this.host + ':' + this.port);
        resolve(this);
      });
      this.server.once('error', reject);
      this.server.on('connection', (socket, request) => this.onConnection(socket, request));
    });
  }

  /** 停服并断开所有客户端。 */
  close() {
    for (const socket of this.clients) {
      try { socket.close(1001, 'mirror stopped'); } catch { /* 已经断了 */ }
    }
    this.clients.clear();
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  onConnection(socket, request) {
    // 只接受本机来源；明文提醒而不静默放行。
    const remote = String(request?.socket?.remoteAddress ?? '');
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === ''; 
    if (!local) {
      this.stats.rejectedHandshakes += 1;
      this.log('[mirror] 拒绝非本机 WS 连接：' + remote);
      socket.close(1008, 'loopback only');
      return;
    }

    // Token 校验：OneBot v11 的两种惯例都支持（头里的 Bearer 与 ?access_token=）。
    const header = String(request?.headers?.authorization ?? '');
    const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : '';
    const fromQuery = (() => {
      try {
        const url = new URL(String(request?.url ?? '/'), 'ws://placeholder');
        return url.searchParams.get('access_token') ?? '';
      } catch {
        return '';
      }
    })();
    const presented = fromHeader || fromQuery;
    if (presented !== this.token) {
      this.stats.rejectedHandshakes += 1;
      this.log('[mirror] 拒绝 WS 握手：Token 不匹配（提供=' + (presented ? '有' : '无') + '）');
      socket.close(1008, 'bad token');
      return;
    }

    this.stats.connections += 1;
    this.clients.add(socket);
    this.log('[mirror] 测试客户端已连接（共 ' + this.clients.size + ' 个）');
    socket.on('close', () => {
      this.clients.delete(socket);
      this.log('[mirror] 测试客户端断开（剩 ' + this.clients.size + ' 个）');
    });
    // 关键：**任何**消息都按"动作请求"处理并拒绝。这里没有"如果是事件就…"的分支。
    socket.on('message', (data) => this.onAction(socket, data));
  }

  onAction(socket, data) {
    let frame = null;
    try {
      frame = JSON.parse(String(data))
    } catch {
      frame = null;
    }
    const action = frame && typeof frame.action === 'string' ? frame.action : '';
    const echo = frame && frame.echo !== undefined ? frame.echo : null;
    this.stats.forbiddenActionAttempts += 1;
    this.stats.lastForbidden = {
      at: new Date().toISOString(),
      action: action || '(unparseable)',
      echo,
      params: frame ? describe(frame.params) : null,
    };

    // 明确失败：`status: failed` + 非零 retcode + 一句能定位的话。
    const reply = {
      status: 'failed',
      retcode: 1200,
      data: null,
      echo,
      wording: 'mirror-only: 本端点是只读镜像，不转发任何 OneBot 动作',
      message: 'mirror-only 端点拒绝动作：' + (action || '(unparseable)'),
    };
    try {
      socket.send(JSON.stringify(reply));
    } catch {
      // 客户端已经走了：拒绝已经记在统计里，不必再抛。
    }
    this.log('[mirror] 拒绝并记录动作请求：' + (action || '(unparseable)') + '（累计 ' + this.stats.forbiddenActionAttempts + ' 次）');
  }

  /**
   * 把一条**已经过滤通过**的原始 OneBot 事件发给所有测试客户端。
   * @param {object} event 原始事件（保持 NapCat 的结构，不改写 message 段）
   * @returns {number} 实际发给了几个客户端
   */
  broadcast(event) {
    const payload = JSON.stringify(event);
    let sent = 0;
    for (const socket of this.clients) {
      try {
        socket.send(payload);
        sent += 1;
      } catch {
        // 单个客户端写失败不影响其它客户端，也不影响镜像进程本身。
      }
    }
    if (sent > 0) this.stats.eventsSent += 1;
    return sent;
  }
}
