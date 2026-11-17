# 改用用户身份：实测结论与架构变更（2026-11-17）

> 指令：「使用用户，不要使用 bot」
> 时间：2026-11-17 16:25，Asia/Shanghai
> 结论：**这条路成立，而且比 Bot 更好。但插件必须改架构 —— 从「webhook 推送」改成「SSE 长连接」。**

---

## 1. 先建了一个普通用户

```
uid     4
name    companion
email   companion@tinydock.cc
is_bot  0        ← 普通用户，不是 Bot
is_admin 0
频道成员 gid=1 members=[1,2,4]   ← 加入频道是前提，否则频道操作 403
```

**为什么要「加入频道」**：实测未加入时 `GET /api/group/1` → 403、`GET /api/group/1/history` → 403、
`POST /api/group/1/send` → 403。加入后全部 200。Bot 不需要这一步是因为 Bot 走的是专门的
`/api/bot/*` 端点，它天然能看到自己在的频道。

---

## 2. 能力对照（同一台服务器，逐个实测）

### 2.1 用户身份（uid=4，普通用户）vs Bot（uid=2）

| 能力 | 用户 uid=4 | Bot uid=2 |
|---|---|---|
| `GET /api/user/me` | **200** | 401 |
| `GET /api/group/1`（频道详情+成员） | **200** | 401 |
| `GET /api/group/1/history`（频道历史） | **200** | 401 |
| `GET /api/user/{uid}/history`（私聊历史） | **200** | 401 |
| `POST /api/group/1/send`（发频道） | **200** | —（走 `/api/bot/send_to_group`） |
| `POST /api/user/{uid}/send`（发私聊） | **200** | —（走 `/api/bot/send_to_user`） |
| `GET /api/user/contacts` | 200 | 401 |
| `GET /api/user/devices` | 200 | 401 |
| `GET /api/user/{他人}` 读别人资料 | 403 | 401 |
| `GET /api/admin/user` | 403 | 401 |
| `GET /api/admin/system/common` | **200** | — |
| `GET /api/admin/login/config` | **200** | — |

**净增益**：历史、频道详情、成员清单、联系人、设备——Bot 全都没有。

私聊历史是**关键能力**：DSH 侧要判断「这条消息是不是新问题」，有历史才可能。

### 2.2 用户 SSE —— 真正的分水岭

```
GET /api/user/events?api-key=<token>
HTTP 200  content-type: text/event-stream
```

实测能收到的帧类型：

```
users_snapshot, users_state, related_groups, server_config_changed, user_settings, chat, ready, heartbeat
```

`chat` 帧的形状与 Bot webhook **完全相同**：

```json
{"created_at":1794903964377,
 "detail":{"content":"…","content_type":"text/plain","expires_in":null,"properties":null,"type":"normal"},
 "from_uid":4,"mid":209,"target":{"uid":1},"type":"chat"}
```

三条决定性验证：

| 验证 | 结果 |
|---|---|
| 能收到**频道**里别人发的消息 | ✅ Bot 发的 `from_uid=2 mid=213 target={"gid":1}` |
| 能收到**私聊** | ✅ 管理员发的 `from_uid=1 mid=218 target={"uid":4}` |
| **`after_mid` 会补播历史** | ✅ 传 `after_mid=211`，立刻吐 `212,213,…,219` 八条 |

**`after_mid` 补播是 Bot webhook 完全没有的能力。** Bot 侧实测：失败不重试、进程不在时事件永久丢。
SSE 侧断线重连 + `after_mid` = 真正能补回错过的消息。

---

## 3. 必须认账的约束

| 约束 | 实测值 | 后果 |
|---|---|---|
| **access token 有效期** | **300 秒（5 分钟）** | 插件必须持 refresh_token 自动续期 |
| refresh_token 有效期 | `864000000` 秒 = **约 10000 天** | 一次登录长期可用 |
| 续期端点 | `POST /api/token/renew {token, refresh_token}` | 返回新的 token + refresh_token（都要换） |
| 频道操作前提 | 必须先被加入频道 | 加成员是**一次性管理员动作** |
| 读别人资料 | 403 | 发送者显示只能靠 `from_uid` + 缓存 |
| SSE 断线 | 需要自己重连 | 有 `heartbeat` 帧，可做活性判定 |
| SSE 连接数 | 未测上限 | 多实例共用同一 refresh_token 会互相踢下线（`refresh_token` 表按 `(uid, device)` 唯一） |

**`refresh_token` 的唯一键是 `(uid, device)`。** 同一 device 名重新登录会覆盖前一条；
意味着**同一个用户身份只能有一个活跃会话**。多 Bot 隔离（G5）必须给每个实例不同的 `device`。

---

## 4. 架构变更：从「webhook 推送」改成「SSE 拉取」

### 4.1 变更对照

| | V1（Bot webhook） | V2（用户 SSE） |
|---|---|---|
| 入站 | 平台 POST 到本机 3011 | 插件主动连 `GET /api/user/events` |
| 需要开端口 | 是（3011） | **否** |
| 需要管理员配 webhook_url | **是**（我做不了，没有管理员凭据） | **否** |
| 需要 webhook 路径令牌 | 是 | **否** |
| 平台重试 | **无** | 不适用（自己重连） |
| 错过补回 | **不可能** | `after_mid` 补播 |
| 出站 | `/api/bot/send_to_*` | `/api/group/{gid}/send`、`/api/user/{uid}/send` |
| 显示身份 | Bot「companion-a」带 Bot 标记 | 普通用户「companion」 |
| 历史可读 | 否 | **是** |
| 凭证 | 静态 API Key | refresh_token（10000 天）+ 5 分钟 access token |

### 4.2 这解决了 V1 唯一的阻塞

V1 结束时留了一个「只能你来做」的步骤：**管理员去 VoceChat 后台填 webhook_url**。
改成 SSE 之后这一步**消失** —— 插件自己出站连过去，不需要平台回调。

### 4.3 需要重写/新增的东西

**删除**（不再需要）：

| 文件 | 原因 |
|---|---|
| `webhook.mjs` | 不再有入站 HTTP server |
| `health.mjs` | 探针语义变了（见下） |

**新增**：

| 文件 | 职责 |
|---|---|
| `sse.mjs` | SSE 客户端：连接、解析帧、心跳、断线重连、`after_mid` 补播 |
| `auth.mjs` | 用户登录 + 5 分钟 token 自动续期 + refresh_token 持久化 |
| `user-api.mjs` | 用户端点客户端（替换 `http-api.mjs` 的 Bot 端点） |

**保留改造**：

| 文件 | 怎么改 |
|---|---|
| `config.mjs` | 字段从 `apiKeyEnv` 改成 `credentialFile` + `deviceName` |
| `normalize.mjs` | **完全不用改** —— `chat` 帧形状和 webhook body 一模一样 |
| `store.mjs` | 保留全部；`last-processed` 现在直接喂给 `after_mid` |
| `port.mjs` | `send` 目标仍是 `{channel}\|{user}`，实现换成用户端点 |
| `publish.mjs` | 不动 |
| `index.mjs` | 装配改成 SSE 客户端 + 续期定时器 |

---

## 5. 新架构的两个技术点

### 5.1 token 续期（必须做得对）

```
登录一次 → refresh_token（10000 天，存 secrets）
        ↓
每 5 分钟：POST /api/token/renew { token, refresh_token }
        → 新的 { token, refresh_token, expired_in }
        → 两个都要换，旧的 refresh 立刻失效
```

**关键**：`previous_token` 列有 `previous_token_valid_until`，说明旧 refresh 在短时间内仍可用
（防并发续期互踢）。但**必须只用一个续期器**，否则并发续期会把两边都踢掉。

### 5.2 SSE 重连 + 补播

```
连接 GET /api/user/events?after_mid=<lastMid>&api-key=<token>
  ↓ 正常收 chat 帧 → 更新 lastMid
  ↓ 断线（网络/401/服务重启）
  ↓ 用 lastMid 重连 → 平台补播错过的全部
```

**这比 Bot webhook 强一个量级**：Bot 侧进程不在 = 永久丢；SSE 侧进程不在 = 起来后补回来。

`401` 是特殊情况：token 过期。必须先续期再重连，不能原地重试（会无限 401）。

---

## 6. 对「还差一步」的处置

V1 文档里那条「VoceChat 后台填 webhook_url」**作废**。

Bot `companion-a`（uid=2）保留不动 —— 它仍在频道里，仍能发消息，只是不再是主通道。
是否删掉，等你决定（删了 `members` 会变成 `[1,4]`，历史消息保留）。

---

## 7. 决策记录

| 项 | 决定 | 依据 |
|---|---|---|
| 主通道身份 | 普通用户 uid=4 `companion` | 你的指令 |
| 入站协议 | SSE + `after_mid` 补播 | 实测补播成立，且不需要管理员配回调 |
| 出站协议 | 用户端点 `group/{gid}/send` `user/{uid}/send` | 实测 200 |
| Webhook 端口 3011 | **关掉** | 不再需要入站 HTTP |
| 凭证存储 | refresh_token 落 `secrets/`（ACL 收紧） | access token 只活 5 分钟，存它没意义 |
| Bot 账号 | 保留，降级为备用 | 不删数据 |
