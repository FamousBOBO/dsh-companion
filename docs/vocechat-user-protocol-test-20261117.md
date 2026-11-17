# 用户身份协议测试报告（2026-11-17）

> 时间：2026-11-17 16:48 – 16:56
> 被测身份：`uid=4 companion`（**普通用户**，`is_bot=false`，`is_admin=false`）
> 结论：**五项全过。用户身份 + SSE 可以独立承担 V2 架构的入站与出站。**

---

## 总分

| 项 | 结果 | 关键数字 |
|---|---|---|
| T1 出站 | ✅ | 频道 200 / mid 222，私聊 200 / mid 223 |
| T2 入站 | ✅ | 管理员发的 mid 224 被 companion 的 SSE 收到 |
| T3 续期 | ✅ | 旧 access token 写 `'x'` 也能换出一对新 token |
| T4 补播 | ✅ | 断连期间 225/226 两条，重连后全部补回 |
| T5 长稳 372 秒 | ✅ | 续期 1 次、重连 4 次、50 帧、6 条 chat、**0 错误** |

---

## T1 出站

```
POST /api/group/1/send        body: 纯文本   → 200, mid=222
POST /api/user/1/send         body: 纯文本   → 200, mid=223
```

与 Bot 端点的形状一致（`Content-Type` 就是消息类型，body 就是原文），只是路径不同。
返回体仍是裸 mid。

---

## T2 入站

管理员（uid=1）在频道 gid=1 发一条，companion 的 SSE 收到：

```json
{"created_at":…,"detail":{"content":"…","content_type":"text/plain","expires_in":null,"properties":null,"type":"normal"},
 "from_uid":1,"mid":224,"target":{"gid":1},"type":"chat"}
```

**`from_uid` 是别人（1），不是自己。** 这是关键：SSE 不是"自己发的消息回显"，
它是真的把这个身份能看到的全部聊天事件都推下来。

---

## T3 续期

```js
POST /api/token/renew
body: { "token": "x", "refresh_token": <db 里的真实值> }
→ 200 { token, refresh_token, expired_in: 300 }
```

**旧 access token 写什么都可以** —— `renew` 只校验 `refresh_token`。
新 token 立刻可用（`GET /api/user/me` → 200）。

### 一个重要的架构事实

`/api/token/renew` 会把新 refresh_token **写回数据库的 `refresh_token` 表**。
所以插件不需要自己保存轮换后的值 —— **数据库永远是权威**。

这条事实解决了「两个续期器互踢」的问题：如果插件自己存一份 refresh_token，
一旦和数据库不一致，两边都会失效。从数据库读就不会。

---

## T4 补播

```
起点 mid = 224
断线期间管理员发出 mid 225 / 226
带 after_mid=224 重连 → 立刻收到 225, 226
```

**这是 Bot webhook 完全没有的能力。** Bot 侧实测：进程不在时事件永久丢，平台不重试。
SSE 侧断线重连 + `after_mid` = 真正补得回来。

---

## T5 长稳 372 秒（跨过 5 分钟 token 边界）

```
时长 372s | 续期 1 | 重连 4 | 帧 50 | chat 6 | 末 mid 232
错误 0 条
✅ 长稳通过
```

时间线（UTC）：

| 时刻 | 事件 |
|---|---|
| 08:48:53 | 登录，`expired_in=300` |
| 08:49:04 | SSE 连上，`after_mid=226` |
| 08:50:04 | produce mid 227 |
| 08:50:37 | 主动断连 #1 |
| 08:50:38 | 重连，`after_mid=227` —— **接上了** |
| 08:51:04 | produce mid 228 |
| 08:52:12 | 断连 #2 → 重连 `after_mid=229` |
| **08:53:04** | **续期 #1（token 到期边界）** —— 断流没发生 |
| 08:53:46 | 断连 #3 → 重连 `after_mid=230` |
| 08:54:04 | produce 231 |
| 08:55:04 | produce 232 |
| 08:55:15 | 断连 #4 → 重连 `after_mid=232` |

**08:53:04 那次续期是整场测试的重点**：token 在那之前 5 分钟签发，
到点必须换新的，而 SSE 连接没有因此中断，后续 produce 全部收到。

四次主动断连全部靠 `after_mid` 接上，中间没有丢一条。

---

## 这些结果对 V2 架构意味着什么

| 设计点 | 现在有实测支撑了 |
|---|---|
| 入站走 SSE，不走 webhook | ✅ T2 + T5 |
| 不需要开 3011 端口 | ✅ 整场测试没有任何入站监听 |
| 不需要管理员配 `webhook_url` | ✅ 从未调用该配置 |
| 断线补播可达 | ✅ T4 + T5 四次重连 |
| token 自动续期不断流 | ✅ T5 跨过 5 分钟边界 |
| 出站用用户端点 | ✅ T1 |
| refresh_token 从数据库读，不自存 | ✅ T3 暴露了这个事实 |

---

## 仍需在 V2 里处理的

| 项 | 说明 |
|---|---|
| 401 必须先续期再重连 | 测试里续期是定时器驱动；真实实现要在 401 时同步续期后重连 |
| 续期单例 | 不能有两个续期器；数据库权威，但读取要串行 |
| `refresh_token` 唯一键 `(uid, device)` | 同一身份只能一个活跃会话；多实例必须不同 device |
| SSE 帧的 `heartbeat` | 可用于活性判定，但测试中 15 秒窗口未见，需要更长观察 |
| 读他人资料 403 | 发送者只能显示 `from_uid`；昵称要靠频道成员的本地缓存 |
| 频道必须被加入 | 一次性管理员动作，已在本次完成（uid=4 ∈ gid=1） |

---

## 产物

| 文件 | 内容 |
|---|---|
| `evidence/test-user-protocol.mjs` | 五项测试脚本 |
| `evidence/user-protocol-test.json` | 结构化结果 |
| `evidence/user-stability.log` | 逐事件时间线 |
| `secrets/user-companion.json` | uid=4 的 refresh_token（ACL 仅 bobo + SYSTEM） |

---

## 补充测试：SSE 的 401 与 after_mid 增量语义

T5 没覆盖两件事，单独补测。

### S1 篡改 token 连 SSE

```
篡改一位的 token → 401，content-type 为 null（不是 event-stream）
用 refresh 换新的 → 200 text/event-stream
```

**结论**：401 是干净的失败，不会给你一个半开的流。插件在 401 时必须**先续期再重连**，
原地重试只会无限 401。

### S2 after_mid 的补播窗口

| after_mid | 结果 |
|---|---|
| `0` | **23 条 chat，mid 209..232**（全量补播） |
| `228` | **4 条 chat，mid 229..232**（精确增量） |

**结论**：`after_mid` 越小补得越多，**它是严格增量的下界**。
插件必须持久化真实的 `lastMid`，否则每次重连都会全量重放历史消息 ——
那会让 DSH 把旧消息当新问题，重复驱动回合。

这条直接决定了 `store.mjs` 的 `last-processed.json` 在 V2 里的地位：
**它不再只是"重放游标"，而是 `after_mid` 的参数来源，丢它等于丢增量能力。**

