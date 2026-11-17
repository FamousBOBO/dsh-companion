# dsh-vocechat-adapter — VoceChat 事件 → DSH 回合

这个插件行是**适配层**。它订阅传输插件（`companionVoceChat` 端口）的事件，把它们变成
DSH 的对话回合，并把模型的答复送回 VoceChat。

它与 `dsh-channel-vocechat` 是**兄弟 cordis 行**，中间靠 process 级注册表相连
（`ctx.get()` 跨不过兄弟作用域）。

---

## 一条事件的完整路径

```
SSE 帧
 → 传输插件 normalize → store 落盘 + claim → port.dispatch
 → 本层 gate.decide（fail-closed）
 → roomKeyOf（vc-chan-<gid> / vc-dm-<对方 uid>）
 → queue.run（同房间串行、全局并发 1、上限明确）
 → sessions.ensure（缓存 → get → create → resume）
 → agent.model.select（与工作区守卫对齐路由）
 → agent.followup（用户消息）
 → 模型调用 vc_message(action=send) → port.send → 平台
 → 若模型答在本地：注入一次纠正（不代发）
```

---

## 文件

| 文件 | 职责 |
|---|---|
| `index.mjs` | cordis 入口、装配、`vc_message` 注册、通道策略、回合驱动、兜底纠正 |
| `segment.mjs` | 分段发送的规则层（纯函数）：按换行/标点拆成"像人连着说的几条" |
| `room.mjs` | 房间键 ↔ 会话 id（纯函数、零 IO） |
| `gate.mjs` | 五条门控规则，**fail-closed** |
| `sessions.mjs` | get → create → resume 重试链、路由解析、`model.select`、proven 缓存 |
| `route.mjs` | 读工作区守卫配置，算出"瀑布最终会用哪条路由" |
| `turns.mjs` | 回合观察与纠正判据（照 `DmDeliveryGuard`） |
| `queue.mjs` | 同房间串行 + 全局并发 + 上限 |
| `sent-log.mjs` | 发送账本（谁在什么时候发了什么、有没有送达） |
| `subscribe.mjs` | 从 process 级注册表取端口，缺席时每 8 秒重试 |

---

## 房间键（一旦定下不再改 —— 改它等于丢历史）

```
频道：vc-chan-<gid>     例 vc-chan-1
私聊：vc-dm-<对方 uid>   例 vc-dm-1
```

**私聊用发送者 uid，不是 `target.user`。** 进来的私聊 `target` 是 `{uid: 自己}`，
`fromUid` 才是对方。用 target 会让所有私聊挤进同一个房间。

G5 多实例：`vc-<ns>-chan-<gid>` / `vc-<ns>-dm-<uid>`，插入位置固定在 `vc-` 之后。

---

## 门控（fail-closed 是硬要求）

| 规则 | 默认 | 说明 |
|---|---|---|
| `fromUid ∈ allowUsers` | **必填** | 空数组 = 谁都不触发 |
| 频道事件 `target.channel ∈ allowGroups` | 必填 | 同上 |
| `fromUid == selfUid` | 丢弃 | 自己发的回声；平台理论上不回，但不依赖平台 |
| `kind !== 'chat'` | 丢弃 | 未知类型不猜语义 |
| `mid` 已处理 | 丢弃 | 成本极低，防重复驱动 |

**空 `allowUsers` 是 deny-all，不是 allow-all。** 理由是失败模式不对称：数组写错时，
宽松的后果是"全世界都能驱动你的模型"（不可撤销），严格只是"没反应"（可查可修）。

---

## 分段发送

一条长回复会被拆成几条连着发出去，看起来像人在那头连着说话，而不是一大段。

调用方式不变：模型**一次调用写完整答复**，用换行分开不同的意思（人设本来就是一行的
句话），插件按换行把它拆开逐条发送。`sent-log.jsonl` 每条带 `segment: n, of: m`。

规则层在 `segment.mjs`（纯函数）。它是照 QQ 频道那份 `core/text/segment.ts` 重写的，但
**有两处刻意不同**：

| | QQ | 这里 | 为什么 |
|---|---|---|---|
| 半角标点 | `,` → `，`、`?` → `？` | **不转** | VoceChat 是纯文本渲染；转换会毁掉英文和 URL（`Hello, world` 变 `Hello， world`） |
| 超出 `maxSegments` | `slice` 丢弃 | **并进最后一段** | QQ 群里"别刷屏"成立；私聊里把答复最后一截悄悄吞掉不成立 |

保留的判据：句末标点切段，但代码块、`---`、成对引号/括号/书名号、URL 内部**不切**
（"《活着。很好哭》"不能被劈开）；连着的情绪标点跟着同一段；`active` 风格认换行。

**实测到一个真的 bug 并修掉了**：`active` 先按换行切、再遮标点，于是一个代码块被拆成四条
消息 —— ` ```js ` / `const a = 1.5;` / ` ``` ` 各自成条，围栏标记当正文发了出去。
现在先遮住受保护区域再按换行切，代码块整体保持一条。

配置（默认全开，写进 profile 即可关）：

```yaml
segmentation:
  enabled: true
  style: 'active'          # active 认换行 | natural 认标点 | conservative 粘连过短句
  minLength: 8
  maxSegments: 6           # 超出并进最后一段，不丢字
  removeTrailingPeriod: false
```

`style` 默认 `active` 而不是 QQ 的 `natural`，有实测依据：这个人设一行一句、常不带句号
（「在的在的\\n怎么了，这么晚才想起来找我」），`natural` 下整段算一句，发出去就是一条
带换行的消息 —— 那正是"分段没有"的样子。

## 显式工具调用，不代发

模型必须调用 `vc_message`，适配层**不**在回合结束时取文本自己发。

为什么：代发省一个工具，但那条路永远做不到"先说一句我查一下，再发结果"。
显式调用让"说了什么"有回执可查（`sent-log.jsonl`），也让进度提示成为可能。

代价是必然会出现"模型答在本地、没调工具"。所以装了三道：

1. `agent/assistant-stream` 记录本轮有没有正文、有没有工具调用
2. `end` 帧 `outcome.kind === 'committed' && eventType === 'assistant/message'` 判定提交
3. `turn-stopping` 与 `idle` 两个时机各试一次纠正，`corrected` 保证一轮最多一次

**`reasoning-delta` 不算正文。** 一个先思考再答在本地的模型，否则看起来像"已经交付了"。

**`toolVisible` 用注册结果，不是 `tools.get()` 查询。** scoped 注册表按
`(agent, toolSet)` 分作用域，create 期间 agent 还不存在，查不到不等于没注册。

---

## 上线时改掉的六个真故障

| # | 故障 | 修法 |
|---|---|---|
| 1 | `after_mid=0` 全量补播历史 | 首连用 `history(limit=1)` 取最大 mid 作起点 |
| 2 | `appendEvent` 没被 SSE 调用 → 冷启动幂等失效 | `claim` 后、派发前落盘 |
| 3 | 注册表用了 `globalThis`（真实是 `process`） | 改用 `process[Symbol.for(...)]` |
| 4 | `inject` 不唤醒空闲 agent | 按 agent 状态选接缝：running→inject，idle→followup |
| 5 | 空 `provider`/`model` 让回合以 `unknown` 失败 | 用 `agentDefaultModel.currentSelection()` |
| 6 | 工作区守卫提议别名，与步准备固定值冲突 | `agent.model.select()` 记成瀑布最终值 |

第 3 条的表现最隐蔽：发布成功、消费侧永远解析不到、日志里什么都没有。

---

## 配置

```yaml
- id: vocechat-adapter
  config:
    enabled: true
    name: 'companionVoceChat'
    namespace: ''
    selfUid: 4
    presetId: 'companion'
    cwd: 'D:/DSH/dsh-production/data/workspace'
    provider: ''            # 空 = 用宿主默认路由
    model: ''
    allowUsers: [1]
    allowGroups: [1]
    concurrency: 1
    maxPending: 200
    turnTimeoutMs: 180000
    sendMaxChars: 4000
```

---

## 测试

```bash
node --test test/*.test.mjs     # 122 项
```

覆盖：房间键的往返与命名空间；门控五条规则与 fail-closed；纠正判据（含 reasoning 不算正文）；
队列的串行/并发/上限/失败隔离；会话缓存与 create→resume 重试；路由解析与守卫对齐；
发送账本；端口解析（含裸键被健康服务占用的情况）；分段规则（受保护区域、封顶并尾巴、
人设的一行一句风格）。

---

## 排查

| 症状 | 先看 |
|---|---|
| 消息进了但没反应 | `sent-log.jsonl` 里有没有那个 mid 的 `turn-start` |
| `skipped` 很多 | `reason` 字段：`user-not-allowed:<uid>` 就是门控拦的 |
| 回复没送到 | `sent-log.jsonl` 的 `undelivered`，或日志里的 `回合收尾 … calledTool=false` |
| 没有分段 | `sent-log.jsonl` 里每条 `sent` 是否带 `segment`/`of`；不带就是 `segmentation.enabled=false` |
| 代码块被拆成几条 | 老版本的问题：`active` 先按换行切再遮标点。现在先遮后切 |
| 回合直接失败 | 会话日志 `turn/end` 的 `reason`；`has no provider/model` 见故障 5 |
| 每轮都慢 1.5 秒 | 会话缓存没命中（`resumed:true, created:false` 且有 `create failed`） |
