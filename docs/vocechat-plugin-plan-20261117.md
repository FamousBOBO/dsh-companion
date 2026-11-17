# VoceChat 接入实施计划（v2）：插件只做接口与服务器，适配交给陪伴插件

> 修订时间：2026-11-17 14:30，Asia/Shanghai
> 本版**取代** `vocechat-plugin-plan-20261117.md` v1 的分工设计。
> 前置已完成：G1–G3（公网 HTTPS 上线），见 `vocechat-g3-online-20261117.md`。
> 选型依据：见 `vocechat-bridge-route-decision-20261117.md`（已否决 OneBot v11 中转）。

---

## 1. 分工（本版的核心变更）

v1 把「传输 + 会话 + 回合 + 门控 + 记录」全塞进一个新插件，等于把 QQ 插件那套 76 353 行的
适配逻辑重写一遍。本版把它切开：

| | **vocechat 插件**（新建） | **陪伴插件**（现有，新增适配模块） |
|---|---|---|
| 职责 | 只做**平台接口**与**服务器** | 只做**适配**：怎么用这个平台 |
| 做什么 | Bot API 客户端、webhook HTTP server、事件归一化、事件落盘、幂等、发布端口 | 房间键、门控、会话创建/恢复、回合驱动、取回复、发送、记录、人格、工具面 |
| 不做什么 | 不建会话、不驱动回合、不认识 `agents`、不认识房间、不认识人格 | 不写 HTTP、不认识 `x-api-key`、不认识 webhook 路径 |
| 类比 | 相当于 `adapters/onebot/` 那一层（传输） | 相当于 `app/inbound` + `features/*`（业务） |
| 平面 | **host 平面**（独立 cordis 行） | host 平面 Service + preset 平面模块各一处 |
| 语言 | 纯 `.mjs`（与 companion 侧一致，无需构建） | 纯 `.mjs` |

**判据一句话：插件只回答「VoceChat 能做什么」；陪伴插件回答「我们用它做什么」。**

这样做的直接后果是插件小得多（约 1 000 行，而非 v1 的 2 100 行），而且
**QQ 插件与本插件在概念上同构**：一个是 OneBot 传输，一个是 VoceChat 传输，
上层适配各自独立。

---

## 2. 实测契约（全部为 2026-11-17 本机休克测试结果，不是推测）

### 2.1 入站 webhook

| 项 | 实测结果 | 由谁处理 |
|---|---|---|
| 保存时探测 | 平台先发一次 **GET**（无 UA），非 2xx → `406 Invalid Webhook URL`，URL 存不进去 | 插件：GET → 200 |
| 尾斜杠 | `.../hooks/companion-a` 失败，`.../hooks/companion-a/` 成功 | 插件：路径匹配带尾斜杠 |
| 投递 | `POST`，`content-type: application/json` | 插件 |
| 鉴权头 | **无**。没有 `Authorization`，没有签名，没有 HMAC | 插件：路径令牌 + 回环绑定 |
| 事件类型 | 实测只有 `type: "chat"` | 插件：归一化时保留 `type` 原值 |
| 编辑 / 删除 | **不投递**（`DELETE /api/message/{mid}` 成功但 webhook 计数不变） | 无需处理；「编辑删除不误当新问题」自动成立 |
| Bot 自发消息 | **不触发自己的 webhook**（平台内部已屏蔽） | 无需处理；适配侧仍保留 `fromUid == botUid` 丢弃作双保险 |
| 失败重试 | **不重试**。探针返回 500 后 60 秒观察，只有 1 次 POST | 插件：ACK 前必须落盘 |
| 平台等应答 | 发送动作本身 `0.016s` 返回（webhook 是异步投递） | 插件：ACK 仍应快，重活入队 |

### 2.2 事件体（逐字）

频道：

```json
{"created_at":1794892571813,
 "detail":{"content":"event probe A","content_type":"text/plain","expires_in":null,"properties":null,"type":"normal"},
 "domain":null,"from_uid":1,"mid":133,"target":{"gid":1},"widget_id":null,"type":"chat"}
```

私聊：`"target":{"uid":2}`，其余相同。

### 2.3 出站 Bot API

| 能力 | 端点 | 实测 |
|---|---|---|
| 发频道 | `POST /api/bot/send_to_group/{gid}` | 200，body 是 `mid` |
| 发私聊 | `POST /api/bot/send_to_user/{uid}` | 200，body 是 `mid` |
| `text/plain` | — | 200 |
| `text/markdown` | — | 200 |
| `text/html` / `application/json` / `image/*` / `audio/*` | — | **415** |
| 长文本 | 8 000 / 64 000 字节 | 均 200 |
| 读频道清单 | `GET /api/bot` | 200，只返回该 Bot 所在频道 |
| 读频道详情 | `GET /api/group/{gid}` | **401** |
| 读历史 | 任意 `/api/bot/*/history` | **404** |
| 读成员资料 | `GET /api/user/{uid}` | **401** |
| 删消息 | `DELETE /api/message/{mid}` | **401** |
| 上传资源 | `/api/resource/file/{prepare,upload}` | 需 `chunk_data` 分片，Bot Key 未走通 |

**出站只有一件事：发文本，进频道或私聊。**

### 2.4 容器 ↔ 宿主机回环（已洁净复核）

```
宿主机监听   TCP 127.0.0.1:3011  LISTENING（仅此一条，无 0.0.0.0）
容器侧访问   docker exec ... wget http://host.docker.internal:3011/
返回         loop-only-OK
```

**结论：webhook 只绑 `127.0.0.1`。** Docker Desktop 把 `host.docker.internal` 转发到宿主机回环；
局域网其他机器访问不到该端口，这消除了「新增局域网暴露面」这一风险。

### 2.5 本机取值

```
VoceChat 版本        0.5.40
Bot uid              2       名称 companion-a
频道 gid             1       companion-private，members=[1,2]，owner=1
宿主机回环 Bot API   http://127.0.0.1:3009
容器名               vocechat-personal-vocechat-1
容器内到宿主机       host.docker.internal → 192.168.65.254
公开入口             https://chat.tinydock.cc:8443（Caddy → 127.0.0.1:3009）
```

---

## 3. 分工边界：逐项归属

| 能力 | 归属 | 理由 |
|---|---|---|
| Bot API HTTP 客户端（`x-api-key`、超时、415/401 分类） | **插件** | 属于传输细节 |
| webhook HTTP server（GET 200、POST、路径令牌、body 上限） | **插件** | 属于服务器 |
| 事件归一化（VoceChat JSON → 内部事件形状） | **插件** | 属于协议翻译 |
| 事件落盘 + 幂等（`mid` LRU）+ ACK 顺序 | **插件** | 属于「不丢」的传输保证 |
| 重启追平（`last-processed`） | **插件** | 属于传输层状态 |
| 发布端口（`send` / `subscribe` / `status` / `channels`） | **插件** | 这是它唯一的对外形状 |
| 健康探针（`GET /api/admin/system/version` 往返） | **插件** | 传输可达性 |
| 房间键（`vc-chan-*` / `vc-dm-*`） | **陪伴** | 会话命名是业务概念 |
| 门控（`allowUsers` / `allowGroups` / 主人判定） | **陪伴** | 属于「谁能触发 agent」 |
| 会话创建 / 恢复 / 自愈 | **陪伴** | 属于 `agents` 服务 |
| 回合驱动（`deliver` / `onIdle` / `onError`） | **陪伴** | 属于 agent 生命周期 |
| 取最终回复文本 | **陪伴** | 属于 agent 事件 |
| 发送（调 port 的 `send`） | **陪伴** | 属于「说什么」 |
| 队列 / 串行 / 并发 1 / 超时 | **陪伴** | 属于回合调度 |
| sent-log、日志字段白名单 | **陪伴** | 属于记账 |
| 人格、记忆作用域、工作目录、工具最小授权 | **陪伴** | 属于伴侣语义 |
| `vc_message` 等模型工具 | **陪伴** | 属于工具面 |

---

## 4. 插件设计（`plugins/dsh-channel-vocechat`）

### 4.1 标识

| 项 | 值 |
|---|---|
| 目录 | `plugins/dsh-channel-vocechat` |
| 包名 | `@dsh-companion/channel-vocechat` |
| cordis 行 id | `channel-vocechat` |
| 语言 | 纯 `.mjs`（无 TS 构建，与 `companion-health` / `companion-group` 一致的形态） |
| 入口 | `index.mjs`，导出 `name` / `inject` / `apply(ctx)` |
| `inject` | `[]`（不依赖任何宿主服务；webhook 是纯 HTTP） |
| 发布端口名 | `companionVoceChat` |
| 数据目录 | `<dataRoot>/home/channel-vocechat/` |

### 4.2 文件结构（约 1 000 行）

```text
plugins/dsh-channel-vocechat/
  package.json               # name / version / license / main / exports / engines
  cordis.patch.yml           # bundle 默认行（enabled: false，全部安全默认）
  index.mjs                  # apply(ctx)：读配置、起 webhook、发布端口、卸载器
  config.mjs                 # 配置解析（含默认值与环境变量覆盖）
  http-api.mjs               # Bot API 客户端（x-api-key / 超时 / 错误分类）
  webhook.mjs                # HTTP server（GET 200 + POST + 四道校验）
  normalize.mjs              # VoceChat 事件 → 内部事件
  store.mjs                  # events.jsonl 追加 + seen-mids LRU + last-processed
  port.mjs                   # 端口对象的装配（send / subscribe / status / channels）
  health.mjs                 # 健康探针
  publish.mjs                # 自带发布实现（process registry + service bridge）
  README.md
  CONTRACT.md                # 端口契约（给陪伴侧的对接依据）
  test/
    http-api.test.mjs
    webhook.test.mjs
    normalize.test.mjs
    store.test.mjs
```

**没有** `room`、`pipeline`、`agents`、`access`、`sent-log`、`admin`、`persona`。

### 4.3 端口契约（插件唯一对外形状）

```js
/**
 * 发布名：companionVoceChat
 * 形状：{ service, ready() }（与 health-service-ref / port-publish 同一套约定）
 */
const service = {
  // ── 出站：唯一写入口 ────────────────────────────────────────────
  /**
   * 发文本。target 由调用方决定（适配层按房间反解），插件不认识房间语义。
   * @param {{ channel: number } | { user: number }} target
   * @param {string} text
   * @param {'text/plain'|'text/markdown'} [contentType]
   * @returns {Promise<{ mid: number }>}   平台返回的消息 id
   * @throws  415（不支持的内容类型）/ 401（key 失效）/ 网络错误
   */
  send(target, text, contentType),

  // ── 入站：订阅（回调，不是插件自己跑管线）─────────────────────────
  /**
   * 订阅归一化事件。多个订阅者按注册顺序串行调用，任一抛错不影响其余。
   * 返回取消函数。
   * @param {(event: InboundEvent) => void|Promise<void>} handler
   * @returns {() => void}
   */
  subscribe(handler),

  // ── 信息 ──────────────────────────────────────────────────────
  /** 该 Bot 所在的频道清单（GET /api/bot）。 */
  channels(),
  /** 一次不产生消息的往返。 */
  status(),          // → { ok, version?, latencyMs }
  /** 插件运行时事实（不进模型、不进日志正文）。 */
  info(),            // → { botUid, baseUrlHost, webhook:{bind,port,pathSet}, queueDepth }
}

/** 归一化事件（适配层唯一的输入形状）。 */
interface InboundEvent {
  mid: number                 // 平台消息 id，幂等键
  fromUid: number
  target: { channel: number } | { user: number }
  content: string
  contentType: string          // 实测 text/plain / text/markdown
  createdAt: number            // 平台毫秒时间戳
  kind: string                 // 实测 'chat'；原样保留，防未来新增类型被误吞
}
```

**刻意的设计取舍**：

1. **`send` 吃 target 对象，不吃 `isGroup` 布尔。** QQ 那边 `sendTo(isGroup, target)` 是为了
   收掉「把群号发进私聊」的三元判断；这里用判别式对象，编译期就分得清。
2. **`subscribe` 是回调，不是事件总线。** 插件不决定「事件该由谁处理」，也不重试、不排队——
   那些属于适配层的回合调度。
3. **没有 `getMessage` / `deleteMessage` / `getHistory`。** VoceChat 给不了，写进契约只会让
   适配层误以为能用。
4. **`info()` 返回 `pathSet: true/false` 而不是路径本身。** webhook 路径令牌是凭据，
   不出现在任何返回值与日志里。

### 4.4 webhook 四道校验（全部在插件内）

| 道 | 做法 | 强度 | 失败响应 |
|---|---|---|---|
| 1. 绑定 | 只绑 `127.0.0.1`（已洁净验证容器可达、局域网不可达） | 中高 | — |
| 2. 路径令牌 | `/hooks/<32 字节 hex>/`，恒定时间比较 | 低-中 | 404 |
| 3. 来源网段 | `RemoteAddr` 属于 Docker 容器网段（可配置，留空则不校验） | 中 | 403 |
| 4. body 上限 | `maxBodyBytes`（默认 1 MB） | — | 413 |

第 5 道（`fromUid` 白名单）**在适配层**——它属于「谁能触发 agent」，不是协议层的事。

### 4.5 落盘与 ACK 顺序（插件内）

```text
POST 到达
  ↓ 1. 路径令牌 + 来源 + body 上限
  ↓ 2. 解析 JSON（失败 → 400，不落盘）
  ↓ 3. 幂等：mid 在 seen-mids 里 → 200 直接返回，不重复入队
  ↓ 4. 追加 events.jsonl（含原始 body）
  ↓ 5. 入内存队列（上限 maxPending，满则拒绝并记缺口）
  ↓ 6. 立刻 200
  ↓ 7. 逐个调用 subscribe 的 handler
```

第 4 步在 ACK 之前，因为**平台不重试**：ACK 之后进程崩了，事件就永久没了。
先落盘至少能在重启后用 `events.jsonl` 追平。

`seen-mids` 与 `last-processed` 落在 `<dataRoot>/home/channel-vocechat/state/`。

### 4.6 重启追平（插件内）

1. 读 `state/last-processed.json`
2. 从 `events.jsonl` 找该 mid 之后的全部事件
3. 逐条重放（同一套幂等，重复跳过）
4. 完成写回

只覆盖「进程内崩溃」；覆盖不了「进程不在时平台投递失败」——那部分确实丢了，日志里记缺口。
**不假装零丢失。**

### 4.7 配置

`cordis.patch.yml` bundle 默认行（不配置 = 什么都不做）：

```yaml
- insert:
    - id: channel-vocechat
      name: '@dsh-companion/channel-vocechat'
      config:
        enabled: false
        baseUrl: ''                 # 例 http://127.0.0.1:3009
        apiKeyEnv: 'VOICECHAT_BOT_API_KEY'   # 环境变量名；值由宿主环境提供
        botUid: 0
        webhook:
          bind: 127.0.0.1
          port: 3011
          pathTokenEnv: 'VOICECHAT_WEBHOOK_TOKEN'
          maxBodyBytes: 1048576
          allowedSources: []        # 例 ['192.168.65.0/24','172.19.0.0/16']
        outbound:
          timeoutMs: 15000
          maxChars: 4000            # 单条硬上限（适配层切分时用）
        queue:
          maxPending: 200
```

**`apiKeyEnv` / `pathTokenEnv` 而不是直接写值**：凭据进环境变量，配置里只有键名。
落地方式（已完成）见 §14.1；令牌生成（已完成）见 §14.2。

---

## 5. 适配设计（陪伴插件侧）

### 5.1 两处挂载点（与 QQ 的现状同构）

QQ 现在是两处：`companion-foundation` 的 `mountQqConversation`（preset 平面，管提示词与工具）
+ `qq-autonomy-refresh` 行（host 平面 Service，管 `agents`）。VoceChat 照同一张图：

| 位置 | 平面 | 职责 |
|---|---|---|
| `plugins/companion-foundation/vocechat-conversation.mjs`（新） | preset | 策略提示词、`vc_message` 工具作用域升级、身份判定（`vc-` 前缀） |
| `plugins/dsh-vocechat-adapter/index.mjs`（新，独立行） | **host** | 订阅端口事件、房间键、门控、会话创建/恢复、回合驱动、发送、sent-log |

为什么适配的主循环必须在 host 平面：它要 `agents`（`create` / `resume` / `get` / `list`）
和 `followup`，那是宿主服务，preset 平面看不到。

### 5.2 适配模块文件

```text
plugins/dsh-vocechat-adapter/
  package.json
  index.mjs                 # Service：inject ['agents','tools']，装配 + 事件循环
  room.mjs                  # vc- 房间键（纯函数、零 IO）
  gate.mjs                  # allowUsers / allowGroups / 主人判定
  sessions.mjs              # agents.create/resume/get + 竞态重试（精简版）
  turns.mjs                 # 回合监听、最终回复捕获、超时
  queue.mjs                 # 单房间串行 + 全局并发 1 + 上限
  sent-log.mjs              # 记账
  subscribe.mjs             # 取端口 + 订阅（含端口缺席时的诚实降级）
  README.md
  CONTRACT.md
  test/
```

约 700 行。

**不能用 `dsh-channel-qq` 的 `agents.ts`**：那是 TS 包内文件，路径与构建都不共享。
需要在 `.mjs` 里重写一份精简版（约 130 行），只保留本通道需要的：
`agents.get(sessionId)` 命中则接上 → 否则 `create` → 失败含 `already exists` 则 `resume` 重试。

### 5.3 房间键

纯函数、零 IO、测试可重放：

```
频道：vc-chan-<gid>      例 vc-chan-1
私聊：vc-dm-<uid>        例 vc-dm-1
```

G5 多 Bot 时插 namespace：`vc-<ns>-chan-<gid>`。**插入位置一旦定下不再改**——改它等于丢历史。

### 5.4 门控规则

| 规则 | 默认 | 说明 |
|---|---|---|
| `fromUid ∈ allowUsers` | 必填 | 空 = 谁都不触发（fail-closed，不是 fail-open） |
| `target.channel ∈ allowGroups` | 必填 | 同上 |
| `fromUid == botUid` | 丢弃 | 双保险（平台已屏蔽回环，但不依赖平台） |
| `kind !== 'chat'` | 丢弃并记日志 | 未知类型不猜语义 |
| 同一 `mid` 已处理 | 丢弃 | 插件已做一道；适配层再做一道（成本极低） |

**fail-closed 是硬要求**：`allowUsers` 空数组时插件照常收事件，但适配层一条都不交给模型。

### 5.5 回合驱动（已定：显式工具调用）

**决定：模型必须显式调用发送工具，适配层不代发。**（2026-11-17 确认）

理由与 QQ 侧一致：显式调用让「说了什么」有回执可查，也让「先发等待提示再继续」有可能。
代发（`onIdle` 直接取文本发送）虽然省一个工具，但那条路永远做不到「分两次说」。

```js
const agent = await ensureSession(room, spec)   // get → create → resume
agent.followup(createUserMessage({
  content: [{ type: 'text', text: inboundLine }],
  source: { kind: 'user', plugin: 'channel-vocechat' },
}))
```

`createUserMessage` 从 `DSH_COMPANION_MODULE_ROOT` 动态 import `@deepseek-ai/dsh-llm`
（`qq-autonomy-refresh` 走的就是这条路）。

#### 5.5.1 发送工具 `vc_message`

与 `qq_message` 同构但**只保留 VoceChat 能做的事**：

| action | 必填 | 说明 |
|---|---|---|
| `send` | `text` | 发到当前房间（target 由适配层按会话 id 反解，模型不可指定） |
| `progress` | `text` | 一次「稍等」提示；发送后本回合继续，不结束 |

**`target` 不在参数里。** 这是 QQ 侧 `qq_message` 的关键纪律：目标从当前会话推，
模型手里没有目标号，就没法跨房间发送。VoceChat 沿用。

#### 5.5.2 兜底（缺工具调用时的一次纠正）

照 `DmDeliveryGuard` 的判据（`delivery-guard.ts`，28 行，实测语义清楚）：

```js
// 只在 DM 房间、且满足全部条件时触发一次
if (toolVisible && committed && sawText && !calledTool && !corrected) → inject 一条纠正
```

条件来源（逐字对照 `DmDeliveryGuard.observe`）：

| 字段 | 判据 |
|---|---|
| `frame.type === 'start'` | 新一轮：重置 `text`/`called`/`corrected` |
| `chunk.type === 'text-delta'` 且 `text.trim()` 非空 | `sawText = true` |
| `chunk.type === 'block-start'` 且 `blockType === 'tool-call'` | `calledTool = true` |
| `frame.type === 'end'` 且 `outcome.kind === 'committed'` 且 `outcome.eventType === 'assistant/message'` | `committed = true` |

帧形状已核对宿主实现（`@deepseek-ai/dsh-agent-loop/lib/index.js` 的
`AssistantStreamAttempt` 与 `StreamChunk` 联合类型），不是推测：

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
// ContentBlockType = 'text' | 'reasoning' | 'image' | 'file' | 'tool-call' | 'tool-addition' | 'tool-removal'
```

纠正内容是**一次注入、不重放工具**：

```
这一轮你没有调用 vc_message，回答只留在本地，房间里看不到。
现在用 vc_message(action=send) 把最终答复发出去，不要重复已经发出的内容。
```

**闸门开合**：`toolVisible` = 本会话的工具作用域里 `vc_message` 是否可见
（= 适配层确实注册了它）。不可见就不纠正——否则会要求模型调用一个不存在的工具。

#### 5.5.3 工具不可用时的诚实降级

若 `vc_message` 注册失败（例如 preset 平面没加载 `vocechat-conversation.mjs`）：

- 适配层**不**改走代发；
- 每次回合结束写一行"回答未送达：vc_message 不可见"；
- `status()` 的 `info` 里暴露 `deliveryTool: false`。

这样"没送达"是可见的失败，而不是静默的丢消息。

### 5.5.4 超时

`turnTimeoutMs` 到点中止并记一行，不发半成品。中止走 `signal.abort()`，
与宿主 `agent/turn-stopping` 的语义一致。

### 5.6 跨平面取端口

插件在 host 平面，适配模块也在 host 平面 —— 但它们**是兄弟 cordis 行**，`ctx.get()` 跨不过去。
必须走 `process` 级 Symbol 注册表，与 `health-service-ref.mjs` / `port-publish.mjs` 同一套约定：

```js
// 取（适配侧）
import { resolveCompanionService } from '../companion-foundation/port-publish.mjs'
const port = resolveCompanionService({
  name: 'companionVoceChat',
  root: dataRoot,                    // 裸 dataRoot，不是 suiteRoot，不是 data/home
  context: () => ctx,                // 本行 ctx，用于先试 ctx.get
  accept: v => typeof v?.send === 'function' && typeof v?.subscribe === 'function',
})
if (!port) { /* 诚实降级：不订阅、不发送；后台留一行说明；定时重试 */ }
```

```js
// 发布（插件侧，自带一份实现，不依赖 companion-foundation）
// publish.mjs 复制 port-publish.mjs 的 registryKeysFor / keyVariants / ready 语义
```

### 5.7 唯一需要改现有文件的跨插件点

`plugins/companion-foundation/service-bridge.mjs` 的 `names` 白名单（第 5 个名字）：

```js
const names = new Set([
  'companionAgenda',
  'companionContactShare',
  'companionGroupMemory',
  'companionGroupPersona',
  'companionHealth',
  'companionVoceChat',   // ← 新增
]);
```

**这是一行改动。** `port-publish.mjs` 本身不校验名字（它走 process registry），所以
真正卡住的是 `service-bridge.mjs` 这一处——不改它，第三条通道（service bridge）会抛
`invalid-companion-port`。process registry 那两条会照常工作，但既然三条都要一致，就一起补。

### 5.8 待确认：数据根键的对齐

`port-publish.mjs` 的注释写得很明确：**root 必须是裸 `dataRoot`**
（`<suiteRoot>/data`），不是 `suiteRoot`，不是 `data/home`。而消费侧
`dsh-channel-qq` 用的是 `path.dirname(host.dshHome)`，即 `data/`（因为 `dshHome = data/home`）。

两边正好对上。本机取值：

```
DSH_HOME                    D:\DSH\dsh-production\data\home
dirname(DSH_HOME)           D:\DSH\dsh-production\data          ← 键
DSH_COMPANION_DATA_DIR      D:\DSH\dsh-production\data          ← 插件侧算出的 root
```

插件侧的 `dataRoot` 从 `DSH_COMPANION_DATA_DIR` 读，回落到 `dirname(DSH_HOME)`。
**启动后必须实测两边拼出的键字符串一致**（§10 V1 的第 1 条验收）。

---

## 6. profile 需要新增的三处

```yaml
# 1) host 平面：VoceChat 插件（传输）
- insert:
    - id: channel-vocechat
      name: file:///D:/DSH/dsh-production/plugins/dsh-channel-vocechat/index.mjs
      config:
        enabled: true
        baseUrl: 'http://127.0.0.1:3009'
        apiKeyEnv: 'VOICECHAT_BOT_API_KEY'
        botUid: 2
        webhook:
          bind: 127.0.0.1
          port: 3011
          pathTokenEnv: 'VOICECHAT_WEBHOOK_TOKEN'
          allowedSources: ['192.168.65.0/24', '172.19.0.0/16']

# 2) host 平面：适配主循环（Service）
- insert:
    - id: companion-vocechat-adapter
      name: file:///D:/DSH/dsh-production/plugins/dsh-vocechat-adapter/index.mjs
      config:
        allowUsers: [1]
        allowGroups: [1]
        agentPreset: companion
        permissionPreset: workspace-write
        workspacePath: 'D:/DSH/dsh-production/data/workspace'
        turnTimeoutMs: 120000
        concurrency: 1

# 3) preset 平面：策略与工具（在 preset-companion 的 plugins 列表里加一行）
- id: companion-vocechat
  name: file:///D:/DSH/dsh-production/plugins/companion-foundation/vocechat-conversation.mjs
```

---

## 7. 与 v1 的差异（清楚的账）

| 项 | v1 | v2 |
|---|---|---|
| 插件行数 | 约 2 100 行新写 + 2 500 行复制 | **约 1 000 行新写，零复制** |
| 适配行数 | 含在插件里 | 约 700 行（新）+ 约 130 行会话精简版 |
| 复制 QQ 的 `agents.ts` / `pipeline.ts` / `features/*` | 是（2 500 行） | **否**（不复制，重写精简版） |
| 对现有文件改动 | 0 | **1 行**（`service-bridge.mjs` 的 names） |
| 认识 `agents` 的模块 | 插件 | 适配（插件不认识） |
| 语言 | TS（要构建） | 纯 `.mjs`（无构建） |
| 单元测试 | 需要 TS 编译链 | `node --test` 直接跑 |

**代价（要认账）**：v2 不复制 QQ 那 2 500 行，意味着下面这些能力**没有现成实现可抄**：

| 能力 | v1 可抄 | v2 现状 |
|---|---|---|
| 会话创建/恢复的竞态重试链 | 抄 368 行 | 自己写约 130 行（只保留本通道需要的部分） |
| 出站队列限速与智能切分 | 抄 `outbound.ts` 99 行 | 自己写约 80 行（只需 `maxChars` 硬切 + `rateLimitMs`） |
| 入站占位符渲染（`[图片]` 等） | 抄 `parse.ts` 323 行 | 只写约 40 行（VoceChat 目前只有文本，占位符只留扩展位） |
| 崩溃后会话自愈（`reattachAll`） | 抄 | 不做；G6 再议 |

---

## 8. 不确定项（实现前必须验，不许假设）

### 8.1 `text/markdown` 是否真渲染（人工，30 秒）

实测 `send_to_group` 接受 `text/markdown` 返回 200，但没验证客户端是否渲染。
发一条 `**粗体**` + `- 列表`，看手机端。若不渲染 → `contentType` 退回 `text/plain`。

### 8.2 单条长文本的实际显示上限（人工，30 秒）

64 000 字节被接受，客户端可能截断。据此定 `outbound.maxChars`（默认 4 000 是保守值）。

### 8.3 `agent/assistant-stream` 帧的文本提取路径（**已查清，不再是卡点**）

原始怀疑"要等日志里看到真实帧才知道形状"已经不成立：宿主实现里有明确的类型联合。
来源 `@deepseek-ai/dsh-agent-loop/lib/index.js` 的 `AssistantStreamAttempt`：

```js
// start 帧
emit({ type: 'start', attemptId, revision, turn, step })
// chunk 帧
emit({ type: 'chunk', attemptId, revision, index, time, chunk })
// end 帧（提交）
emit({ type: 'end', attemptId, revision, index,
       outcome: { kind: 'committed', eventType, seq } })
// end 帧（放弃）
emit({ type: 'end', attemptId, revision, index, outcome: { kind: 'abandoned', ... } })
```

`chunk` 的形状见 `StreamChunk`（`dsh-api-session-controller/lib/typert.host.js`）：

```
block-start   { index, blockType }        blockType ∈ text|reasoning|image|file|tool-call|tool-addition|tool-removal
text-delta    { index, text }            ← 最终答复文本在这里
reasoning-delta { index, text }          ← 思维链，不要当答复
tool-call-delta { index, id, name?, argumentsDelta }
block-end     { index, block: ContentBlock }   // TextBlock = { type:'text', text }
usage         { usage }
finish        { reason, replayState? }
```

**取文本两条路，优先级不同**：

| 路 | 做法 | 何时用 |
|---|---|---|
| A（首选） | 累积 `text-delta` 的 `text`，遇 `block-end` 且 `block.type==='text'` 时取 `block.text` 作为该块完整文本 | 流式可用 |
| B（兜底） | 只在 `frame.type==='end'` + `outcome.kind==='committed'` + `eventType==='assistant/message'` 时，从会话事件里读该 `seq` 的消息体 | 流式帧缺失 |

**注意 `reasoning-delta` 不能混进答复**：它和 `text-delta` 都是 `text` 字段，混收会把思维链发出去。
判据只认 `text-delta`。

### 8.4 preset 平面能否读到 `vc-` 会话的工具作用域

`mountQqConversation` 的做法是 `agent.ctx?.get?.('tools')` 再 `localTools.register(...)`，
`upgradeLiveQqSender` 里还有一层兜底 `agent.ctx?.get?.('tools') ?? agent.ctx?.tools`。
`vc-` 会话的 `agent.ctx` 是同一平面，落点一致；V1 里实测一次确认（不假设）。

---

## 9. 分期（四步，每步可独立验收）

### V1：插件骨架（不接模型）

1. 建包：`package.json` / `cordis.patch.yml` / `index.mjs`
2. `config.mjs` + `http-api.mjs` + `health.mjs`
3. `webhook.mjs`：GET 200、POST 落盘、幂等、ACK 顺序、四道校验
4. `normalize.mjs` + `store.mjs` + `publish.mjs`
5. `port.mjs`：`send` / `subscribe` / `status` / `channels` / `info`
6. 手工验证：`port.send({channel:1}, 'hi')` 能到手机

**验收**：
- VoceChat 后台能存 webhook（GET 200 生效）
- 频道发一条 → `events.jsonl` 有该事件，`mid` 正确
- 同一 mid 手工重投 3 次 → `send` 的订阅只被调 1 次
- 伪造路径令牌 → 404；1.1 MB body → 413
- 端口键字符串与适配侧算出的完全一致（§5.8）

### V2：适配最小闭环（接模型，一个频道）

1. `dsh-vocechat-adapter` 包：`room.mjs` / `gate.mjs` / `sessions.mjs` / `turns.mjs` / `queue.mjs`
2. `subscribe.mjs`：取端口、订阅、端口缺席时诚实降级
3. `service-bridge.mjs` 加一行名字
4. `turns.mjs` 按 §8.3 的帧形状取文本（`text-delta` 累积 + `block-end` 兜底），**不混 reasoning**
5. `vc_message` 工具 + `DmDeliveryGuard` 同构的兜底纠正（§5.5.2）

**验收**：手机在频道 gid=1 发一句 → 回合跑完 → 频道出现回复 → `sent-log` 有 mid 与耗时；
且「模型不调 `vc_message` 就结束」时能观测到一次纠正。

### V3：可靠性与边界

1. 重启追平（插件侧）实测
2. 队列上限 + 缺口记录
3. 回合超时 + 中止
4. `allowUsers` 空 → 一条都不触发（fail-closed 验证）
5. `fromUid=99` 伪造 → 不触发
6. 停掉容器 → `status()` 报不可用；恢复后自动回正常

### V4：preset 侧与工具面收尾

1. `vocechat-conversation.mjs`：策略提示词、身份判定（`vc-` 前缀）
2. `vc_message` 的 `progress` 分支（先发等待提示再继续）
3. 日志字段白名单核对

（`vc_message` 本体在 V2 就要就位——显式调用是本方案的既定形态，不能推迟。）

---

## 10. 验收矩阵（对应计划 §G4 的 8 条）

| # | 计划原文 | v2 落点 | 验收方法 |
|---|---|---|---|
| 1 | 创建 Bot A，独立 API Key、Webhook 令牌，本机存储 | 已完成（uid=2，`secrets/bot-companion-a.json`） | 读文件 + `GET /api/bot` 200 |
| 2 | 专属路由满足 GET 200、POST 接收 | 插件 `webhook.mjs` | 后台保存成功；`events.jsonl` 有记录 |
| 3 | 桥接加入 Compose 网络，收发走内部地址 | 出站 `127.0.0.1:3009`；入站回环 3011 | §2.4 洁净验证**已通过** |
| 4 | 校验令牌、结构、长度、主人 UID 和频道；先持久化再快返 | 插件四道（令牌/来源/长度/结构）+ 适配一道（UID/频道）+ §4.5 顺序 | 伪造令牌 404；1.1 MB 413；`fromUid=99` 不触发 |
| 5 | 单会话串行，全局并发 1，超时/取消明确记录 | 适配 `queue.mjs` + `turns.mjs` | 连发 5 条日志显示串行；超时记一行 |
| 6 | 初版最终文字/Markdown；编辑删除不误当新问题 | `outbound.contentType`；平台不投递编辑删除 | 发 `**粗体**` 确认渲染；发一条后编辑，确认不产生新回合 |
| 7 | 记录发送状态与平台消息 ID，日志仅留必要 | `sent-log.mjs` + 插件日志白名单 | 抽查 10 行日志无正文 |
| 8 | 人格、记忆作用域、工作目录、工具最小授权独立 | `agentPreset` / `permissionPreset` / `workspacePath` / `vc_message` 作用域 | 会话 meta 里 cwd 与 preset 正确 |

**出口**：手机在频道发一句 → Bot 回一句 → `sent-log` 有记录 → 日志无正文。

---

## 11. 风险与限制

| 风险 | 事实 | 归属与缓解 |
|---|---|---|
| **无签名** | webhook 无任何鉴权头 | 插件：路径令牌 + 回环 + 来源网段；适配：`fromUid` 白名单（第五道，最强） |
| **无重试** | 实测 500 后 60 秒不再投递 | 插件：ACK 前落盘 |
| **无补投** | 插件不在时事件永久丢失 | 插件：重启追平只覆盖进程内崩溃；不承诺零丢失；日志记缺口 |
| **无历史/无成员** | Bot Key 读历史、读成员全 401 | 适配：上下文只来自插件 `events.jsonl` + DSH 会话历史；发送者显示 `uid:<n>` |
| **无富媒体** | 图片/文件/JSON 均 415 | 插件：`send` 只接受 plain/markdown；适配：不做附件 |
| **无编辑删除事件** | 实测不投递 | 副作用：**回复一旦发出无法更正** |
| **新增本机端口** | 3011 | 只绑回环（已洁净验证）；再叠加令牌 + 来源 + 白名单 |
| **平台升级风险** | 事件体与 415 边界是实测得来，非文档承诺 | 插件 `normalize.mjs` 对未知字段容忍；`events.jsonl` 留原始 body 便于回溯 |
| **两处平面的键必须对齐** | process registry 按 root 字符串匹配 | §5.8；V1 第一条验收就是比对键字符串 |

---

## 12. 回滚

| 层级 | 操作 |
|---|---|
| 插件 | profile 里 `enabled: false`；3011 不再监听 |
| 适配 | profile 里删掉 `companion-vocechat-adapter` 行 |
| preset | 删掉 `companion-vocechat` 行 |
| 数据 | 删 `data/home/channel-vocechat/`（状态与事件） |
| 会话 | DSH 会话目录里删 `vc-*` 开头的目录 |
| VoceChat | `PUT /api/admin/user/2` 把 `webhook_url` 置空；或删 Bot |

回滚**不影响** channel-qq、不影响 G1–G3 的任何产物。

---

## 13. 与 G5 / G6 的关系

| 阶段 | v2 留下的接口 |
|---|---|
| G5 多 Bot 隔离 | 插件：多实例 = 多个 cordis 行，各自 `baseUrl/apiKey/botUid/port/pathToken`；适配：`namespace` 插进房间键 |
| G5 不串话 | 房间键带 namespace，会话目录天然分开；`allowUsers` 每 Bot 独立 |
| G6 长驻 | 插件与适配都随宿主机启停（宿主本身已由计划任务保活，Caddy 侧已做） |
| G6 备份 | `data/home/channel-vocechat/`（events / seen-mids / last-processed）+ DSH 的 `vc-*` 会话目录 |

---

## 14. 已定的两项（2026-11-17 确认）

1. **显式工具调用。** 模型必须调 `vc_message(action=send)` 才算发出；`onIdle` **不代发**。
   判据与兜底见 §5.5.1–§5.5.3。工具不可见时不改走代发，而是把「未送达」写成可见失败。

2. **`apiKeyEnv` + 启动脚本注入环境变量。** 配置里只写键名，值从 ACL 收紧的 secrets 读到
   `process.env`。落地方式见 §14.1。

### 14.1 环境注入的落地（已完成）
宿主由一个普通 node 进程 spawn（`D:\DSH\dsh-ops\serve.mjs`，不在任何 git 仓库里）。
子进程无法"补读"父进程已定型的环境，所以注入点必须在 spawn 的参数里：

```js
// serve.mjs 第 24 行（真实改动：2 行注释 + 1 处 spawn 参数）
const child = spawn(process.execPath, [
  '--import', pathToFileURL(path.join(ops,'fixed-web-port.mjs')).href,
  '--import', pathToFileURL(path.join(ops,'vocechat-env.mjs')).href,   // ← 新增
  '--expose-internals', cli, ...
], { cwd: ..., env, ... })
```

`D:\DSH\dsh-ops\vocechat-env.mjs`（新增，约 60 行）在宿主进程最早执行：

| 行为 | 说明 |
|---|---|
| 读 `D:\DSH\vocechat\secrets\bot-companion-a.json` 的 `apiKey` | → `process.env.VOICECHAT_BOT_API_KEY` |
| 读 `D:\DSH\vocechat\secrets\webhook-token.json` 的 `webhookPathToken` | → `process.env.VOICECHAT_WEBHOOK_TOKEN` |
| **永不抛** | 密钥缺失只写诊断，不阻止陪伴套件启动 |
| 诊断落点 | `data/logs/vocechat-env.json`，只留长度与前 6 位，不写全值 |

**实测（2026-11-17 14:39）**：

```
node --import file:///D:/DSH/dsh-ops/vocechat-env.mjs -e "..."
API_KEY len 168
HOOK    len 64

diagnostics: applied=[VOICECHAT_BOT_API_KEY, VOICECHAT_WEBHOOK_TOKEN], missing=[]
```

**为什么不用 `.env.local`**：本仓 `.env.example` 存在，但 `scripts/start.mjs`、
`serve.mjs`、`tools/lib/dsh.mjs` 三处都不加载 `.env.local`——它只是给 `setup` 的参考模板。
真正生效的是 `serve.mjs` 里那份显式 `env` 对象。往里加键比引入 dotenv 改动更小。

**回滚**：删掉 `serve.mjs` 里那一行 `--import`（备份在 `serve.mjs.bak-before-vocechat-20261117`），
或直接删 `vocechat-env.mjs`。

### 14.2 生成 webhook 路径令牌（已完成）

```
D:\DSH\vocechat\secrets\webhook-token.json
  webhookPathToken  64 hex（32 字节）
  path              /hooks/<token>/
  bind              127.0.0.1
  port              3011
ACL：仅 DESKTOP-LTOVDT9\bobo:(F) + SYSTEM:(F)
```

VoceChat Bot 的 `webhook_url` 填 `http://host.docker.internal:3011/hooks/<token>/`
（**带尾斜杠**，实测不带会被 406 拒）。

---

## 附录 A：已完成的前置验证

| 项 | 结果 |
|---|---|
| Bot A 创建（uid=2，`companion-a`） | ✅ |
| 独立 API Key（`secrets/bot-companion-a.json`，ACL 仅当前用户 + SYSTEM） | ✅ |
| Bot A 加入频道 gid=1（`members=[1,2]`） | ✅ |
| webhook GET 探测通过 | ✅ |
| webhook POST 收到真实事件（3 条，`type:"chat"`） | ✅ |
| 出站文本到频道 / 私聊（mid 130/132/141/144） | ✅ |
| Bot 自发消息不回环 | ✅ |
| 500 响应后不重试（60 秒观察，仅 1 次 POST） | ✅ |
| 编辑/删除不投递事件 | ✅ |
| 容器 → 宿主机回环监听可达（洁净复核 `loop-only-OK`） | ✅ |
| `vc-` 前缀无冲突 | ✅ |
| 陪伴侧尚无 vocechat 代码（可干净新增） | ✅ |


