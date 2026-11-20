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
| `index.mjs` | cordis 入口、装配、`vc_message` 注册、通道策略、回合驱动、兜底纠正、上下文注入 |
| `segment.mjs` | 分段发送的规则层（纯函数）：按换行/标点拆成"像人连着说的几条" |
| `room.mjs` | 房间键 ↔ 会话 id（纯函数、零 IO） |
| `gate.mjs` | 私聊五条规则 + 频道成员/概率三态判定，**fail-closed** |
| `history.mjs` | 频道上下文：平台行 → 内部行 → 按水位筛选 → 渲染成提示词段落 |
| `room-state.mjs` | `rooms.json` **两个水位**：`lastHandledMid`（看到哪）/ `lastSentMid`（说到哪） |
| `sessions.mjs` | get → create → resume 重试链、路由解析、`model.select`、proven 缓存 |
| `route.mjs` | 读工作区守卫配置，算出"瀑布最终会用哪条路由" |
| `turns.mjs` | 回合观察与纠正判据（照 `DmDeliveryGuard`）；群里沉默合法 |
| `queue.mjs` | 同房间串行 + 全局并发 + 上限 |
| `sent-log.mjs` | 发送账本（谁在什么时候发了什么、有没有送达、有没有沉默） |
| `subscribe.mjs` | 从 process 级注册表取端口，缺席时每 8 秒重试 |
| `scripts/probe-history.mjs` | 探针：把 `GET /api/group/{gid}/history` 的真实字段形状固化下来 |
| `scripts/verify-group-chain.mjs` | 只读核对：在真实频道数据上走一遍群聊链路的每一步（不发消息） |
| `scripts/send-as-owner.mjs` | 以主人身份在频道说一句（独立 device，不抢别人的 refresh_token） |

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

**两条路，两条判定。** 私聊只有一个人，白名单是对的；频道里好几个人，同一条规则会把
其他成员全部拒掉（实测 `allowUsers:[1]` 时 uid 2/4/5 全落 `user-not-allowed`）。

### 私聊 `vc-dm-*`：五条规则，2026-11-17 定的，未改

| 规则 | 默认 | 说明 |
|---|---|---|
| `fromUid ∈ allowUsers` | **必填** | 空数组 = 谁都不触发 |
| 频道事件 `target.channel ∈ allowGroups` | 必填 | 同上 |
| `fromUid == selfUid` | 丢弃 | 自己发的回声；平台理论上不回，但不依赖平台 |
| `kind !== 'chat'` | 丢弃 | 未知类型不猜语义 |
| `mid` 已处理 | 丢弃 | 成本极低，防重复驱动 |

**空 `allowUsers` 是 deny-all，不是 allow-all。** 理由是失败模式不对称：数组写错时，
宽松的后果是"全世界都能驱动你的模型"（不可撤销），严格只是"没反应"（可查可修）。

### 频道 `vc-chan-*`：同伴闸 → 成员 → 概率

| 判据 | 事实来源 | 失败时 |
|---|---|---|
| `target.channel ∈ allowGroups` | 配置 | `channel-not-allowed:<gid>` |
| `fromUid ∉ peerBots` | `config.group.peerBots`（本地配置） | `peer-bot:<uid>` |
| 发送者是频道成员 | `GET /api/group/{gid}` 的 `members`（实测 `[1,2,4,5]`） | `not-a-member:<uid>` |
| 成员表取不到（403/断网/token） | — | **fail-closed**：只放行 `allowUsers`，原因 `members-unavailable:<uid>` |
| 掷骰子 `roll() < talkProbability` | `config.group.talkProbability`（默认 0.3） | `chance-skip:<p>` |

`null`（不知道）与 `false`（查到了，他不在）**必须分开**：把两者混成 `false`，运维会去查
"为什么这个人不在群里"，而真相是 403。

成员表缓存 60 秒（`memberCacheMs`）：不缓存等于每条消息一次 HTTP，缓存太久会让新入群的人
永远不触发。骰子抛错或返回 NaN 时按"接话"处理 —— 多说一句只是话多，不说会让整个频道看起来坏了。

### `peerBots`：同机的同伴实例不进回合

两个陪伴实例同群时（本机：实例甲 uid=4、实例乙 uid=5），成员判定会让"对方说的话"变成合法触发源：

```
实例甲发言 → 实例乙看到（成员 4）→ 掷骰子 → 实例乙发言 → 实例甲看到（成员 5）→ 掷骰子 → …
```

概率只能让链变短，**不能保证它停**。所以 `peerBots` 是硬闸：不掷骰子、不进缓冲。
但那些话**仍然算上下文**——它们在平台历史里，`history.mjs` 照常取回来。

**同伴说的话是资料，不是"有人叫我"。** 这个区分是整个设计的关键。

判定顺序刻意放在成员表**之前**：`peerBots` 不依赖成员表，而成员表可能 403；
让确定的事实先回答，运维就不会被 `members-unavailable` 引去查平台权限。

### 单例闸：同一进程只跑一份

宿主会把同一个插件行挂载两次（一个 boot 内 `mounted` 出现 2 次、`published` 只有 1 次），
两份订阅同一个端口 → **每条入站被驱动两次**。表面症状是"偶尔回两遍"，
实际是两个回合抢同一个 agent：第一个拿到时它还在 create/resume（找不到接缝，记
`undelivered`），第二个才真的交付。模型调用翻倍，而且「一轮一次纠正 / 一轮一次沉默 /
水位只推进一次」全部退化成"两次里取一次"。

`claimInstance(dataRoot, namespace)` 抢 `process[Symbol.for(...)]` 上的锁，拿不到的一份
立即返回：不订阅、不驱动、不写账本。身份是 `dataRoot + namespace`，所以 G5 的两个**进程**
不会互相挡。`dispose` 里释放 —— 不释放会让 cordis reload 看起来"改了配置没生效"。

---

## 群聊上下文：自上次发言以来的历史

只有频道取，私聊不取（一对一，上下文天然连续，多取一次是纯延迟与 token 成本）。

```
port.history({channel: gid}, {limit: 20})   →  [平台行]（实测升序，但代码按 mid 重排，不信顺序）
   → mapHistoryRow（字段名只出现一次）       →  {mid, fromUid, content, contentType, createdAt}
   → selectRows（剔除本批 + 水位以下，保留最近 N 条）
   → renderRow                             →  [580] uid:4（你自己）：你呢，起来了没
   → contextBlock                          →  「自你上次发言（mid 232）之后…」+ 行 + ——
```

**实测形状**（`scripts/probe-history.mjs`，证据 `vocechat/evidence/history-shape-20261118.json`）：

```
created_at | number | detail.content | string | detail.content_type | string
detail.properties | null   ← 拿不到 @ 元数据，因此不做 @ 优先
from_uid | number | mid | number | target.gid | number
```

水位存在 `<dataRoot>/home/vocechat-adapter/rooms.json`，**只增不减**，原子替换写入。

**两个水位，不是一个**（2026-11-19 实测抓到的 bug）：

| 字段 | 含义 | 用途 |
|---|---|---|
| `lastHandledMid` | 我**看到**哪了（这一批已交给模型） | 频道上下文的下界 |
| `lastSentMid` | 我**说到**哪了（成功发出的最后一条） | 只用于诊断 |

最初只有一个 `lastSentMid`。私聊近似成立；**群里不成立**：

```
实例乙说 1148-1150 → 实例甲看到并回了 1151-1153 → 水位推进到 1153
→ 主人问"实例乙刚才说她今天干嘛了"
→ 上下文按 1153 过滤 → 实例乙那三条全被挡掉
→ 实例甲答："没看着她说啊，我就知道你问了"      ← 她明明看过并回应过
```

根因：把"我说到哪"当成"我看到哪"。一旦我发言，界就越过了别人在我**发言之前**说的话——
而群里那恰恰是最需要记住的部分。现在 `noteHandled` 在**交付成功之后**推进，与说没说话无关
（群里沉默是常态，只在发送时推进等于每轮重看上一批）。

老文件只有 `lastSentMid` 时当成 `lastHandledMid` 读一次：单实例单房间时两者恰好相等，
老状态不会让上下文凭空消失。

「我们上次**成功发出**的 mid」仍然记在 `lastSentMid` 上（`mid: null` 的失败发送不推进）。
它不再决定上下文的下界 —— 那正是上面那个 bug 的来源。

取不到历史时**整段不注入**，不写"历史不可用"进提示词（那会被模型当事实复述出来），
只落 `sent-log.jsonl` 的 `history-miss`。

---

## 表达分档：私聊 6 段 / 群聊 3 段 120 字

| | 私聊 | 频道 |
|---|---|---|
| `maxSegments` | 6 | 3 |
| 单段硬上限 | 无（只有 `sendMaxChars: 4000`） | 120 字 |
| 发言人标签 | 不加（发言人恒定，加了是噪声） | 每条入站行前加 `uid:n：` |
| 提示词 | 一套 | 另一套：多人 / 短 / 可以不说话 |

优先级写清：**不丢字 > 不超过条数 > 不超过字数**。3 段是目标，120 字是硬上限；两者冲突时
允许超段（`splitText` 按 120 硬切），因为悄悄吞掉后半句比多发一条糟得多 —— 与
`capSegments`「并尾不丢字」同源。

`channelPolicy` 出**两套文案**而不是一套加两句：私聊里出现"多人"会让模型开始猜"别人"是谁。

---

## 沉默：群里合法，私聊不合法

| | 私聊 | 频道 |
|---|---|---|
| 有正文 + 没调工具 + 已提交 | 注入**一次**纠正 → 仍不调则 `undelivered` | 不纠正，记一行 `model-silence` |
| 为什么 | 一对一，对方发消息就是找你说话，答在本地 = 事故 | 多人在场，被触发只是"这一刻可以说话" |
| 每轮都必须发言的后果 | — | "每句都接"，群里最像机器人的行为 |

`allowCorrection: false` 是频道的默认值（`config.group.allowCorrection`），想恢复就改成 `true`。
不纠正不等于不记账：`sent-log.jsonl` 的 `model-silence` 与 `undelivered` 是两个 kind，
"她没说话"因此能分清是设计的还是坏的。

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
    allowUsers: [1]         # 私聊白名单；频道上是"成员表读不到时的兜底"
    allowGroups: [1]
    # 频道（群聊）这一档：门控、上下文、表达、沉默四条都从这里读。
    group:
      enabled: true
      talkProbability: 0.3  # 0 = 群里永不主动开口；1 = 有成员说话就接
      historyLimit: 20      # 自上次发言以来取多少条（平台封顶 100）
      memberCacheMs: 60000  # 成员表缓存；不缓存=每条一次 HTTP
      allowCorrection: false  # 群里沉默合法（true 会恢复"必须发言"）
      segmentation:
        maxSegments: 3
        maxChars: 120
    concurrency: 1
    maxPending: 200
    turnTimeoutMs: 180000
    sendMaxChars: 4000
```

---

### 部署路径（哪些是默认值，哪些该覆盖）

本机默认值写死在代码里，换机器只改 config 或环境变量，**不改源码**：

| 项 | 默认值 | 覆盖方式 |
|---|---|---|
| `media.thumbnail.uploadRoot` | `D:/DSH/vocechat/vocechat-data/upload`（VoceChat 容器 upload 目录在宿主机上的挂载点） | config 的 `media.thumbnail.uploadRoot`；指错了只是缩略图不升级，原图仍会正常发 |
| `scripts/probe-history.mjs` 的 DB / 证据目录 | `D:/DSH/vocechat/vocechat-data/db/db.sqlite`、`D:/DSH/vocechat/evidence` | `VOICECHAT_DB`、`VOICECHAT_EVIDENCE_DIR` |
| `scripts/send-as-owner.mjs` 的 secrets | `D:/DSH/vocechat/secrets` | `VOICECHAT_SECRETS` |
| `scripts/verify-group-chain.mjs` 的 DB | 同上 | `VOICECHAT_DB` |

一次性探针（`probe-history.mjs` / `measure-display.mjs` / `send-as-owner.mjs` /
`verify-group-chain.mjs`）都只在手工排查时运行，不进运行期链路。

## 测试

```bash
node --test test/*.test.mjs        # 303 项
node scripts/verify-group-chain.mjs 1   # 只读核对：真实频道数据上走一遍每一步（不发消息）
```

离线 303 项覆盖：房间键的往返与命名空间；私聊五条门控规则与 fail-closed；**频道成员 + 概率
三态判定（含"传进 Promise"这个真实踩过的坑）**；纠正判据（含 `reasoning-delta` 不算正文）；
**群里沉默合法与私聊仍纠正**；队列的串行/并发/上限/失败隔离；会话缓存与 create→resume 重试；
路由解析与守卫对齐；发送账本（含 `history-miss` / `model-silence` 两个新 kind）；
端口解析；分段规则（受保护区域、封顶并尾巴、**群聊 3 段 120 字与私聊 6 段**）。

只读核对脚本覆盖：频道详情与成员表、history 真实字段形状、渲染顺序与发言人标签、
`rooms.json` 水位跨重启、四种门控原因码、两档分段、两套提示词、入站包结构。它**不驱动
模型、不发消息** —— 回答的是"链路能跑"，不是"她聊得好"。

---

## 排查

| 症状 | 先看 |
|---|---|
| 消息进了但没反应 | `sent-log.jsonl` 里有没有那个 mid 的 `turn-start` |
| `skipped` 很多 | `reason` 字段：`user-not-allowed`（私聊白名单）、`not-a-member`（不在群里）、`members-unavailable`（成员表读不到，403 或断网） |
| 群里只有主人说话有反应 | 成员表取不到：查 `info().group.memberCache` 与日志里的「成员表取不到（gid=…）」 |
| 回复没送到 | `sent-log.jsonl` 的 `undelivered`，或日志里的 `回合收尾 … calledTool=false` |
| 群里她不说话 | 先看 `info().group` 的 `chanceSkips`（概率挡的）与 `silences`（她自己决定不说）；再看 `corrections` 是否仍为 0（群里不该有纠正） |
| 群里答得接不上话题 | `info().group.historyMisses` + `sent-log` 的 `history-miss`；`lastHistoryReason` 给具体原因码 |
| 群里回复太长 | `config.group.segmentation.maxSegments/maxChars` 是否被 profile 整段替换掉了 |
| 没有分段 | `sent-log.jsonl` 里每条 `sent` 是否带 `segment`/`of`；不带就是 `segmentation.enabled=false` |
| 代码块被拆成几条 | 老版本的问题：`active` 先按换行切再遮标点。现在先遮后切 |
| 回合直接失败 | 会话日志 `turn/end` 的 `reason`；`has no provider/model` 见故障 5 |
| 每轮都慢 1.5 秒 | 会话缓存没命中（`resumed:true, created:false` 且有 `create failed`） |
