# VoceChat 桥接路线评估：OneBot v11 中转 vs 直接接入

> 评估时间：2026-11-17 13:20，Asia/Shanghai
> 评估对象：G4「一个 DSH Bot 闭环」的接入方式选型
> 结论先行：**直接接入**。OneBot v11 只在「要复用 QC 独有的 QQ 群管理/文件/表情包/语音能力」时才值得，而 G4 不需要那些。

---

## 1. 两条路线是什么

### 路线 A：OneBot v11 中转

```
VoceChat Bot webhook
        ↓ (HTTP)
自建 OneBot v11 协议端（伪 NapCat）
        ↓ (WebSocket, echo 关联)
channel-qq 插件（现成，76353 行 / 120 个工具）
        ↓
DSH 模型
```

也就是：把 VoceChat 伪装成一个 OneBot 客户端，让现成的 `channel-qq` 插件原样跑起来。

### 路线 B：直接接入

```
VoceChat Bot webhook（POST，无签名）
        ↓ (HTTP)
自建轻量桥接（约 800–1200 行）
        ↓ (HTTP RPC)
DSH host（127.0.0.1:62684 或 3080）
```

---

## 2. 实测契约（两条路线都要遵守的事实）

### 2.1 入站：webhook

实测 VoceChat 0.5.40 的行为：

| 项 | 实测结果 |
|---|---|
| URL 要求 | 必须**先 GET 探测成功**才保存；GET 返回非 2xx → `406 Invalid Webhook URL` |
| GET 探测 | 保存时发一次 GET（无 UA），要求 200 |
| 事件投递 | `POST`，`content-type: application/json`，无签名头、无 `Authorization` |
| 事件体（频道） | `{"created_at":…,"detail":{"content":"…","content_type":"text/plain","type":"normal"},"from_uid":1,"mid":131,"target":{"gid":1},"type":"chat"}` |
| 事件体（私聊） | 同上，`target:{"uid":2}` |
| 事件类型 | 实测只有 `type:"chat"` |
| 编辑 / 删除 | **不投递事件**（`/api/message/{mid}` DELETE 成功但 webhook 计数不变） |
| Bot 自发消息 | **不触发自己的 webhook**（回环已被平台内部屏蔽） |
| 附件 | `detail.content_type` 字段存在，但图片消息未实测投递形态 |

**关键限制：没有签名、没有重试保证、没有离线补投。** 断线期间的事件直接丢失。这一点计划里已经写明「不承诺桥接停机零丢失」，实测确认。

### 2.2 出站：Bot API

Bot Key（`x-api-key`）实测能力边界：

| 能力 | 端点 | 结果 |
|---|---|---|
| 发频道 | `POST /api/bot/send_to_group/{gid}` | 200，返回 mid |
| 发私聊 | `POST /api/bot/send_to_user/{uid}` | 200，返回 mid |
| `text/plain` | — | 200 |
| `text/markdown` | — | 200 |
| `image/png` / `application/json` / `text/html` / `audio/mpeg` | — | **415** |
| 长文本 | 8000 / 64000 字节 | 均 200（无硬上限） |
| 读频道列表 | `GET /api/bot` | 200，返回该 Bot 所在频道 |
| 读频道详情 | `GET /api/group/{gid}` | **401** |
| 读历史 | 任意 `/api/bot/*/history` | **404** |
| 读成员 | `GET /api/user/{uid}` | **401** |
| 删消息 | `DELETE /api/message/{mid}` | 401/404（Bot Key 无此权） |
| 上传资源 | `POST /api/resource/file/upload` | 需要 `prepare` + `chunk_data` 分片，Bot Key 未验证通过 |

**出站只有两个动作：发文本（plain / markdown）到频道或私聊。** 没有读、没有删、没有改、没有富媒体、没有群管理。

---

## 3. 逐条比对：现成 channel-qq 插件需要什么，VoceChat 能给什么

`ports/platform.ts` 的 `QQApi` 接口有 **59 个方法**。分类对照：

| 类别 | QQApi 方法数 | VoceChat 可实现 | 说明 |
|---|---|---|---|
| 收发消息 | 3（sendGroup/sendPrivate/sendTo） | ✅ 3/3 | 但只能纯文本 / markdown |
| 读消息 / 历史 | 6（getMessage/getGroupMsgHistory/getFriendMsgHistory/getImage/getRecord/getFile） | ❌ 0/6 | Bot Key 全部 401/404 |
| 删改消息 | 1（deleteMessage） | ❌ 0/1 | 401 |
| 群管理 | 6（ban/kick/wholeBan/admin/card/poke） | ❌ 0/6 | VoceChat 无此概念 |
| 群文件 | 9 | ❌ 0/9 | VoceChat 无群文件 |
| 群精华 | 3 | ❌ 0/3 | 无 |
| 表情回应 | 2 | ❌ 0/2 | 无 |
| 语音 / TTS / AI 语音 | 4 | ❌ 0/4 | 无 |
| OCR / 语音转文字 | 2 | ❌ 0/2 | 无 |
| 合并转发 | 2 | ❌ 0/2 | 无 |
| 好友 / 群列表 / 成员资料 | 5 | ⚠️ 1/5 | 只有 `/api/bot` 给频道列表 |
| 在线状态 / 戳一戳 / 点赞 | 5 | ❌ 0/5 | 无 |
| 健康检查 | 1（getStatus） | ✅ 1/1 | 用 `/api/admin/system/version` 或 webhook GET |
| 交互提示（正在输入） | 1 | ❌ 0/1 | 无 |
| URL 安检 / 自定义表情 | 3 | ❌ 0/3 | 无 |

**合计：59 个方法里约 5 个能实现（8%）。**

### 3.2 现成插件的业务代码依赖哪些

核心收发路径（`app/inbound`、`outbound.ts`、`features/inbound`、`features/platform`、`core/message`）实际调用：

```
getFile, getGroupFileUrl, getImage, getPrivateFileUrl, getStatus,
sendGroupMessage, sendPrivateMessage
```

**7 个方法**，其中 4 个（getFile/getGroupFileUrl/getImage/getPrivateFileUrl）VoceChat 给不了。

反过来说：**如果只做「文本进 → 模型 → 文本出」，核心路径只需要 3 个方法**（`sendGroupMessage`、`sendPrivateMessage`、`getStatus`），全部可实现。

但插件不是只有核心路径。它有 **120 个模型工具**，其中 24 个是群管理/文件类：

```
group_ban, group_kick, group_whole_ban, group_admin, set_group_card,
set_essence, delete_essence, get_essence_list,
upload_group_file, download_group_file, list_group_files,
get_file_url, move_group_file, rename_group_file, delete_group_file,
create_file_folder, send_private_file, save_private_file, ...
```

这些工具在 VoceChat 上**没有对应后端**。要么删掉（等于重写插件），要么留着让模型调用必然失败的接口。

---

## 4. 两条路线的成本量化

### 路线 A：OneBot v11 中转

| 工作项 | 工作量 | 风险 |
|---|---|---|
| 实现伪 OneBot 协议端（WebSocket server + echo + 事件转换） | 600–900 行 | 中 |
| 把 VoceChat webhook 事件转成 OneBot `message` 事件（含 `sender`、`message` 段数组、`raw_message`） | 200–300 行 | 中：`sender.nickname`/`card`/`role` 在 VoceChat 里要额外查，而 Bot Key 查不到（401）→ 只能填占位 |
| 实现 59 个 QQApi 里的子集（能实现的 5 个 + 54 个返回"不支持"） | 300–500 行 | 低 |
| 注入 `ChannelQQ` 插件并关掉 54 个不可用工具 | 配置 + 15 处工具注册过滤 | **高**：工具注册分散在 `features/qq-tools/register.ts` 等多个文件，改 120 个工具的可见性 |
| 端到端联调 | 长 | 高 |

**合计约 1100–1700 行新代码 + 对现有插件 15+ 处侵入式修改。**

而且即使做完，插件里有大量代码路径会拿到 `undefined`：

- `features/contact/gate.ts` 依赖 `getStrangerInfo` 判断陌生人 → VoceChat 无此接口，门控逻辑失效
- `app/inbound/presence-judge.ts`（20 KB）依赖群成员信息判断"是否该回复" → VoceChat 拿不到 `sender.role`
- `features/flood/guard.ts` 依赖精确的 `user_id` → 可拿到（`from_uid`）
- `core/message/parse.ts`（323 行）解析 `OneBotMessageSegment[]` → 需要把 VoceChat 的纯文本反解析成段数组，信息量反而减少

**结论：路线 A 会得到一个"能跑但一半功能静默失效"的系统，维护成本最高。**

### 路线 B：直接接入

| 工作项 | 工作量 | 风险 |
|---|---|---|
| Webhook 服务（GET 200 + POST 接收 + 幂等 + 队列） | 250–350 行 | 低 |
| DSH host RPC 客户端（`/api/session/prompt`，cookie 鉴权） | 200–300 行 | 中：需要 launch token 与 cookie 交换，已有成熟做法 |
| 出站（`send_to_group` / `send_to_user`） | 80–120 行 | 低 |
| 人格 / 记忆 / 工具最小授权 | 配置 | 低 |
| 端到端联调 | 短 | 低 |

**合计约 600–900 行，零侵入现有插件。**

---

## 5. 维护性对比（这是决策的核心）

| 维度 | 路线 A（OneBot v11） | 路线 B（直接接入） |
|---|---|---|
| 新增代码量 | 1100–1700 行 | 600–900 行 |
| 对现有仓库的侵入 | 15+ 处（120 个工具的可见性） | **0** |
| 依赖的上游变更 | 依赖 `channel-qq` 插件的内部结构（`QQApi` 59 个方法签名） | 依赖 VoceChat HTTP + DSH RPC 两个稳定契约 |
| 上游升级时会怎样 | 插件改一个方法签名 → 桥接跟着改 | VoceChat 加字段不影响；DSH RPC 变则改一处 |
| 失效模式 | 静默降级（工具调用返回 401，模型看到"操作失败"但不知道原因） | 明确失败（只有两个动作，做不了就是做不了） |
| 排障难度 | 高（三层：VoceChat → 伪 OneBot → 插件） | 低（两层：VoceChat → 桥接） |
| 复用现有 code | 120 个工具、表情包、语音、群管理 | **无**（但那 120 个在 VoceChat 上本来也用不了） |
| 与 G5「多 Bot 隔离」的契合 | 差（一个 channel-qq 实例对应一个 QQ 号） | 好（每个 Bot 一份 key + 一份路由，天然隔离） |

### 5.1 一个容易误判的点

`channel-qq` 看起来"现成"，但它的价值几乎全部押在 **QQ 平台特有的能力**上：

- 群文件、群精华、群管理（禁言/踢人/改名片）
- 自定义表情包、AI 语音、OCR、语音转文字
- 合并转发、戳一戳、点赞、在线状态

VoceChat 是一个**结构完全不同的产品**：频道模型、无群管理、无文件库、Bot 只能发文本。

把这些能力"映射"到 VoceChat 上，本质上是在做一个**功能降级的适配层**，而不是复用。

真正能复用的只有：纯文本收发、SSE 长连接、消息幂等。这些在路线 B 里用 600 行就能自己写，而且写得干净。

### 5.2 路线 A 唯一真正有价值的场景

如果你未来要**同时接入 QQ 和 VoceChat**，并且希望模型用同一套工具（`qq_send_message` 之类的名字）面对两个平台，那么路线 A 有意义 —— 它让 `channel-qq` 成为一个"平台无关工具层"，VoceChat 只是它的又一个后端。

但这需要 **G5 之后**才考虑，而且那时应该做的是把 `ports/platform.ts` 真正抽象成平台无关端口（把 `OneBotMessage` 换成领域模型），而不是把 VoceChat 硬塞进 OneBot 协议。

---

## 6. 结论

**走路线 B（直接接入）。**

三条理由：

1. **能力匹配度**：VoceChat 的 Bot API 只给「纯文本收发 + 频道/私聊二选一」，59 个 QQApi 方法只有 5 个能实现。路线 A 的 1100+ 行代码里，超过 900 行是在实现"返回不支持"。
2. **维护成本**：路线 A 要侵入 120 个工具的可见性、依赖插件内部结构、产生静默降级；路线 B 零侵入、两层链路、失败明确。
3. **与后续阶段契合**：G5 要多 Bot 隔离，路线 B 天然一 Bot 一路由；路线 A 一个 channel-qq 实例绑一个 QQ 号，多实例会互相抢 `channel-qq.jsonl` 和 `sent-log`。

### 6.1 路线 B 的具体设计（G4 实施要点）

```
VoceChat 容器
  │  POST webhook（无签名，纯 JSON）
  ▼
桥接（Node，跑在宿主机，监听 3011）
  ├─ GET  /hooks/{bot}/     → 200（满足 VoceChat 探测要求）
  ├─ POST /hooks/{bot}/     → 先写 JSONL 落地，立即 200，再入队
  ├─ 出站：POST /api/bot/send_to_group/{gid} | send_to_user/{uid}（x-api-key）
  ├─ 幂等：以 mid 为键，重复 mid 不再触发模型
  ├─ 过滤：from_uid 必须是主人；Bot 自发已被平台屏蔽，无需额外处理
  └─ 队列：单会话串行，全局并发 1
        │
        ▼
DSH host（127.0.0.1:62684）
  └─ /api/session/prompt（cookie 鉴权，queue 模式）
```

### 6.2 需要先解决的一件事

**容器 → 宿主机 DSH 的鉴权路径。** 实测：

- 容器 → `host.docker.internal:62684` → **401**（需要 DSH cookie）
- 容器 → `192.168.65.254:62684` → **403**（Host 头校验）

所以桥接**不放在容器里**，而是跑在宿主机（监听 3011，已验证容器可达）。这样桥接→DSH 走 `127.0.0.1` 本机，无鉴权障碍；VoceChat→桥接走 `host.docker.internal:3011`，已实测通。

这与计划里「路径不通时增加受限本机连接器，只转发所需操作」的要求一致：桥接就是那个受限连接器，它只暴露 webhook 接收和 HTTP 转发，不开任何管理接口。

### 6.3 一个必须记录的限制

VoceChat webhook **无签名、无重试、无补投**。这意味着：

- 桥接必须先落盘再返回 200（已实测平台会等响应）
- 桥接重启期间的消息**永久丢失**，无法追回
- 不能承诺"零丢失"，只能在日志里记录缺口

这与计划 §G4「官方文档未为本方案证明重试、签名、离线补投。核实实际版本，不承诺桥接停机零丢失」完全一致，实测已确认。

### 6.4 已落地的前置验证

| 项 | 状态 |
|---|---|
| Bot A 创建（uid=2，`companion-a`） | ✅ |
| Bot A 独立 API Key（存 `secrets/bot-companion-a.json`，ACL 收紧） | ✅ |
| Bot A 加入私有频道 gid=1 | ✅（members=[1,2]） |
| webhook GET 探测通过（`http://host.docker.internal:3011/hooks/companion-a/`） | ✅ |
| webhook POST 收到真实事件 | ✅（3 条，`type:"chat"`） |
| Bot 出站文本到频道 / 私聊 | ✅（mid 130/132/141/144） |
| Bot 自发消息不回环 | ✅ |
| 容器 → 桥接可达 | ✅ |

**G4 的第一个闭环所需的一切契约都已实测确认，可以直接进入实现。**
