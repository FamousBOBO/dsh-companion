# channel-vocechat — VoceChat 传输插件（V2：用户身份 + SSE）

这个插件**只做传输**。它把 VoceChat 变成 DSH 里一个可订阅的事件源与一个可发送的目标，
并把两者发布成一个进程内端口 `companionVoceChat`。

它**不认识**会话、agent、房间键、人格、提示词、模型工具 —— 那些在适配层侧
（`plugins/dsh-vocechat-adapter`）。

---

## 为什么是用户身份，不是 Bot

| | Bot（V1） | 普通用户（V2，现状） |
|---|---|---|
| 入站 | 平台 POST 到本机 3011 | 插件主动连 `GET /api/user/events` |
| 要开端口 | 是 | **否** |
| 要管理员配 `webhook_url` | 是 | **否** |
| 断线补回 | 不可能（失败不重试，进程不在就永久丢） | `after_mid` 补播 |
| 能读历史/成员/联系人 | 否（全 401） | 是 |

V1 留了一条"只能由管理员来做"的收尾步骤（去后台填 `webhook_url`）。换成用户身份 + SSE
之后这一步消失了：插件自己出站连过去，不需要平台回调。

---

## 文件

| 文件 | 职责 |
|---|---|
| `index.mjs` | cordis 入口；单例、装配、发布、生命周期 |
| `config.mjs` | `resolveConfig(raw, env)` → `{config, problems}`；`parseBaseUrl` |
| `auth.mjs` | refresh_token → 5 分钟 access token；**续期单例**；401 同步续期；**按 device 精确取凭据** |
| `user-api.mjs` | 用户端点客户端：`send` / `history` / `channel` / `me` / `contacts` / `status` |
| `sse.mjs` | SSE 客户端：连接、解析、心跳、断线重连、`after_mid` 游标、首连 seed |
| `normalize.mjs` | 平台帧 → 内部事件（`chat` 帧形状与 Bot webhook 完全相同，故未改） |
| `store.mjs` | `events.jsonl` 落盘、幂等集合、游标、gap 记录、诊断 |
| `port.mjs` | 端口契约（`send`/`subscribe`/读能力/`info`） |
| `health.mjs` | 三个独立半边（出站/入站/认证），从不返回裸布尔 |
| `publish.mjs` | process 级注册表发布与解析 |

---

## 端口契约

```js
port.send({channel: gid} | {user: uid}, text, 'text/plain' | 'text/markdown') // → {mid}
port.subscribe(handler)        // → unsubscribe（幂等）
port.history(target, {limit, before})
port.channel(gid)              // 频道详情 + members + owner（非成员 403）
port.contacts()
port.me()
port.status()                  // {ok, state, outbound, inbound, auth, reasons}
port.info()                    // 无凭据、无正文
```

`send` 的目标是**判别式对象**，不是 `isGroup` 布尔 —— 让"把频道号发进私聊"这类错误
在类型上不可表达。

---

## 配置

```yaml
- id: channel-vocechat
  name: file:///D:/DSH/dsh-production/plugins/dsh-channel-vocechat/index.mjs
  config:
    enabled: true
    baseUrl: 'http://127.0.0.1:3009'   # 纯 origin，不接受路径/查询/凭据
    uid: 4                             # 普通用户（is_bot=false）
    deviceName: 'dsh-companion'        # refresh_token 唯一键的一部分
    dbFile: 'D:/DSH/vocechat/vocechat-data/db/db.sqlite'
    credentialFile: ''                 # 二选一；都填则文件优先
    seedChannel: 1                     # 首连以这个频道的最新 mid 为起点
    auth: { timeoutMs: 15000 }
    sse:
      reconnectBaseMs: 1000
      reconnectMaxMs: 30000
      idleTimeoutMs: 120000
    outbound: { timeoutMs: 15000, maxChars: 4000 }
```

---

## 五条设计约束（每条都有实测或事故作依据）

1. **`after_mid` 必须是真的 lastMid。** 实测 `after_mid=0` 会补播 23 条历史 —— 首启会把
   整段聊天当新消息重放。所以库里没有游标时先用 `history(limit=1)` 取当前最大 mid 作起点
   （`seedChannel`）。`last-processed.json` 在这里是**功能依赖**，不是优化。
2. **401 先续期再重连。** token 只活 5 分钟，原地重试只会无限 401。
3. **续期是单例。** `/api/token/renew` 会轮换 refresh_token 并写回数据库；两个并发续期会
   互相作废。所有续期走同一个 promise。**不自存轮换值** —— 数据库是权威。

   **但数据库必须按 `(uid, device)` 定位。** `refresh_token` 的主键是这两列，同一个 uid
   可以有好几行（手机、浏览器、本插件、取证脚本各一行）。`where uid = ? order by updated_at
   desc limit 1` 取的是"最近更新过的那个客户端"——**也就是别人的凭据**；拿它去 renew 会把
   那个客户端轮换掉并登出。2026-11-17 实测：主机的验证脚本这样取 uid=1，把主人手机挤到
   401（能进、不能发消息、不能改头像）。现在 `createAuth` 收 `deviceName`，只认自己那一行，
   取不到就报错 —— **绝不借别人的顶上**（互踢造成间歇 401，比报错难查得多）。
4. **收尾必须 `await reader.cancel()`。** 流被掐断时它 reject 的正是同一个 `terminated`
   错误；同步 `try/catch` 抓不到 promise 的 reject → `unhandledRejection` →
   `dsh-app-boot` 当作 fatal load failure 并 `proc.exit(1)`。**实测：停容器能杀死整个 DSH 宿主。**
5. **只有 `chat` 帧进 normalize。** 其他帧是状态同步，记"跳过"而不是"错误"。

---

## 测试

```bash
node --test test/*.test.mjs     # 113 项
```

覆盖：续期单例与并发、401 一次性重试、数据库凭据源、SSE 帧解析与去重、断线存活
（含上面第 4 条的回归）、首连 seed、端口契约、健康三半边、配置校验。

---

## 排查

| 症状 | 先看 |
|---|---|
| 没有消息进来 | 日志 `[vocechat-sse] connected (after_mid=N)`；没有就是连不上 |
| 连不上 | `[vocechat-auth]` 后面的错误；`renew 失败` 说明 refresh_token 坏了 |
| 消息进了但没人回 | 这不是本插件的问题 —— 看适配层的 `sent-log.jsonl` |
| 每次重启都重放历史 | `state/last-processed.json` 丢了 |
