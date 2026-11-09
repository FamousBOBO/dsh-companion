# @dsh-companion/channel-qq

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)

> 本目录是 **DSH Companion** 套件里的 QQ 通道模块，实体来自独立的 MIT 项目
> `github.com/Aegink/dsh-channel-qq`（见 `BUILD.md` 的 provenance 与
> `docs/01-deployment.md`）。套件侧只做构建统一、安全默认值与去个人化，不改变
> 协议的对外行为。

把 QQ 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的渠道插件。
通过 **OneBot v11**（协议端默认用 [SnowLuma](https://github.com/SnowLuma/SnowLuma)，
NapCat 仍可作回滚方案）收发消息，
以 cordis `Service` 形式挂进 dsh，提供工具面、长期记忆、主动行为与管理后台。

> 非官方项目，与腾讯 / QQ 无隶属关系。协议端属于非官方实现，**账号风控、掉线、
> 要求重新验证都是常态**——请自行遵守 QQ 用户协议与当地法律。

## 特性

- **消息**：群聊 / 私聊、图片、语音、文件、引用回复、戳一戳，自动分句发送
- **工具面**：90 个细粒度工具；`tools.v2` 下合并为 17 个动作组（`qq_message`、`qq_lookup`…）
- **群聊准入**：进 agent 之前先判"要不要说话"；非 @ 消息不进队列，省上下文与模型调用
- **长期记忆**：日记 → 结构化记录 → 检索；夜间九个任务（分块 / 抽取 / 反思 / 遗忘 / 摘要 / 向量重建）
  - 每回合自动注入 3–8 条证据（≤600 字）；`qq_memory_search` 深召回原文块（带文件行号）
  - 可选向量检索：本机 embed 服务（`deploy/embed-server/`），不开就退回关键词
- **主动行为（可选，默认关）**：事件书驱动巡逻、早报、主动私聊——时间表是数据，不是代码。
  出厂的默认是**一个定时器都不注册**：装上插件不会自己开始找人说话，要在配置里逐项打开
- **技能**：磁盘上的 Agent Skills 目录包（`SKILL.md`），按房间定可见范围
  （全部 / 仅私聊 / 指定群 / 指定房间 / 仅管理员），模型自动发现 + `/名字` 直接触发；
  后台可增删改、从 URL 或粘贴导入（先落待审区）
- **管理后台**：27 个页面，配置热生效、审计、会话重建、模型供应商管理
- **发送侧探针**：`/api/healthz` 用一次 `get_status` 往返判断"消息发不发得出去"，
  不产生消息、只接受本机请求
- **曲库账号**：后台「音乐」页扫码登录网易云 / 酷狗（二维码在浏览器本地生成），
  可看登录态、清除登录、先搜一首歌自检，不必等群里点歌才发现没登录
- **审批网关**：高危命令 L0–L3 分级 + 一次性令牌；管理员在 QQ 私聊回一句「批准」即可执行
  （`待批 / 申请 / 批准 / 拒绝`，全程不经模型）
- **交互提示（可选，默认关）**：私聊回合显示「正在输入」，群里给触发消息贴一个表情回应
- **合并转发（可选，默认关）**：长清单/日志/总结改发一张聊天记录卡片，失败自动回退逐条
- **指标（可选，默认关）**：回合耗时 p50/p90、token 四个桶、发送/工具失败，后台按房间与天看
- **原话簿（可选，默认关）**：按群按日保存原始消息流水（`<工作区>/chatlog`，默认保留 14 天），
  `qq_group_digest` 可按日期翻某群聊了什么
- **人物档（可选，默认关）**：`qq_person_note` 手动记录「谁爱用什么说法、忌讳什么」，
  按群分开存，与自动侧写互补
- **渠道健康告警（可选，默认关）**：消息链路失联超过阈值私聊管理员，恢复后再报，同场故障限频
- **访问门控（默认开）**：陌生人私聊 / 未批准的群只回一句「待主人批准」，不进 agent；
  后台「安全」页批准后才放行（也可切白名单或全放行）

## 与其它 QQ 接入方案的分工

dsh 生态里已经有几种 QQ 接入，定位不同：

| 方案 | 接入 | 适合 |
|---|---|---|
| [官方 dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) | QQ Bot API v2 | 官方机器人身份、扫码、流式回复；不接个人号 |
| [dsh-im](https://github.com/xmanrui/dsh-im) | 13 个 IM 渠道 | 一个插件同时接多种平台，广而薄 |
| **本项目** | OneBot v11（SnowLuma） | **个人 QQ 号 + 完整群能力**：长期记忆、知识库、主动行为、审批、技能包、群运营 |

选型建议：要官方身份与流式，用官方插件；要一次接多个平台，用 dsh-im；
要一个「住在群里」的长期陪伴/群运营机器人，用本项目。

## 快速开始

需要 **Node.js 22+**、一个 dsh 宿主、一个 OneBot v11 协议端。

```bash
npm install
npm run build      # 生成后台前端 + 编译 TypeScript
npm run verify     # 类型 + 测试 + 分层 + 体积，全绿再继续
```

挂载（`<dshHome>/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: channel-qq
  config:
    connection: { mode: forward, url: ws://127.0.0.1:3001 }
    accessToken: <OneBot access token>
    selfId: <机器人 QQ 号>
    admins: [<管理员 QQ 号>]
    primaryGroup: <主群号>
    workspacePath: /path/to/agent-workspace
```

部署与运维细节见 [docs/deployment.md](docs/deployment.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 分层、消息旅程、关键决定、往哪里加东西 |
| [docs/configuration.md](docs/configuration.md) | 配置三层覆盖、生效方式、环境变量 |
| [docs/deployment.md](docs/deployment.md) | 部署、发布、回滚、故障排查 |
| [docs/memory.md](docs/memory.md) | 记忆系统：夜间任务、embed 服务、评测与限制 |
| [docs/memory-standalone.md](docs/memory-standalone.md) | 记忆库插件化：脱离 cordis 独立使用 |
| [SECURITY.md](SECURITY.md) | 威胁模型与部署清单 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 门禁、硬规则、提交信息 |

## 提醒的四种结论（`ReminderOutcome`）

提醒到点后每一次投递尝试都会落到**四种**结论之一。**代码里的权威定义**是
`src/features/reminders/outcome.ts` 的 `REMINDER_OUTCOMES`（类型由它派生，别再手写第二份；
`runner.ts` 只是 re-export，所以老的 `import ... from '.../runner.js'` 照样有效）；
这张表是它的中文对照，改词表时两处一起改。

| 结论 | 含义 | runner 会写什么 | 消耗这条提醒吗 |
|---|---|---|---|
| `sent` | 真发出去了（且拿到回执） | `markFired()` / `markFiredRebound()`：`fired=1`、推进 `at`、换绑 `occurrence` | 会 |
| `dry-run` | **演练**：**不评估共享闸门**就直接停（见 §演练锁什么、不锁什么），没发也没记 | **什么都不写**（只留一行日志） | **不会**（退出 dryRun 后它还会响） |
| `unknown` | 说不清发没发（超时/回执丢/内部错） | `markUnknown()`：终态、留证据、不自动重试 | 会（但留痕，可人工收敛） |
| `skipped` | 现在不该发（开关/房间/免打扰/配额/日程） | 什么都不写 | 不会（条件好了它还会响） |

⚠️ 三个必须记住的点：

1. **`dry-run` 不是 `sent`**。以前演练被当成"发出去了"，于是 runner 把一次性提醒永久标成
   已触发，**关掉 dryRun 之后不会补发**（终审 round3 B2）。现在演练是独立结论，零持久写入。
2. **`dry-run` 也不是 `unknown`**。演练没有出错，混进 `unknown` 会让人以为发失败了。
3. **仓外消费者按"三态"枚举时要把 `dry-run` 补上**——多一个值就多一种情况，别用
   `switch` 的 `default` 把它静默吞成"失败"。

**同一个词在主动消息那边的含义（`src/features/contact/gate.ts`）**：contact 的闸门判定是
`verdict: 'allowed' | 'dry-run' | 'denied'`（配 `reason: 'ok' | 'dry-run' | 'external-send-denied'`），
其中 `'dry-run'` 与上表的 `dry-run` **是同一含义**——"按灰度不真发"。
⚠️ **注意**：提醒侧的演练**不评估**共享闸门（免打扰/冷却/配额都不问），所以**不能**用它判断
"这会儿会不会被拦"；原因的说明见下一节。两边都**不是**"发送失败"，也都**不消耗**任何额度。
区别只在记账归属：提醒走 `ReminderOutcome`，主动消息走门控 `verdict`。

### 演练（`dryRun`）锁什么、不锁什么

**锁**（`dryRun !== false` 时，提醒这条后台链路**零持久写入**）：

- 不投递、不记账、不写 `fired`/`at`/`occurrence`；
- **不补回执**：不 `clearPendingDispatch`、不 `bumpPendingDispatch`、不转 `dispatch-abandoned`；
- **不做启动 prune**、**卸载时不保存**（保存会把整份盘归一化：`version` 拉回 1、未知顶层字段消失）；
- 启动读盘时**不重建文件**（文件不存在就空表起步，等真实变更再写）；
- **不评估共享闸门**：读账本在"损坏/版本不匹配"时会**删旧 `.corrupt` 并 rename 账本**，
  那是写动作。**代价**：演练看不出"这会儿会不会被免打扰/配额拦"——这一点**不要**指望演练给答案；
- 异常也不落 `unknown`（`unknown` 是终态，会把一次性提醒永久终结）。

**不锁**（**这不是**整个插件的全局只读锁）：

- **工具与后台的显式管理操作照常写盘**——例如 `/remind` 建提醒、后台删除/收敛一条提醒、
  改配置。这些是主人/管理员**主动要求**的动作，不是"后台自己跑起来顺手写的"；
- `contact`（主动消息）自己的账本不受提醒侧 `dryRun` 控制。

一句话：`dryRun` 管的是"**提醒这条后台链路自己会不会动持久状态**"，不管"人手动改了它"。

### 到点提醒为什么不再被主动消息的冷却/配额拦住（2026-11-10 热修）

共享闸门 `contact.outboundBudget()` 现在分**两档**（`BudgetGateInput.profile`）：

| 档 | 谁在用 | 判定项 | 被拦时的 reason |
|---|---|---|---|
| `proactive`（缺省） | contact 自己与所有老调用方 | 免打扰 / 竞争 / 冷却 / 配额 / 未回复退避 / 通道 | `quiet-hours`、`cooldown:room`、`quota:global`、`backoff:unanswered`、`no-channel`… |
| `reminder` | **到点提醒**（`features/reminders/index.ts`） | **只有通道与绑定** | `no-channel`、`binding-invalid` |

理由不是"提醒更重要"，而是**两类消息的承诺语义不同**：主动消息没人要求它现在说话，拦一下只是
"这一会儿不打扰你"；到点提醒是主人**在某个时刻明确要求**的一句话，拿主动开口的额度去推迟它，
等于把承诺改写成"看心情"。事故现场：2026-11-09 23:40 的提醒被 23:21 一次普通回复留下的会话冷却
（`perRoomCooldownMs=3600000`）挡到 00:21:52，实际 00:22:10 才发出——**迟到 42 分钟**，84 条
`被共享闸门拦下（cooldown:room）` 就是那 84 拍。

两条边界（**别读成"提醒不受管控"**）：

- **单项**：提醒不向 contact **借**额度，但发成功之后**照样** `contact.account()` 记账 ⇒ 主动消息
  那一侧仍然把这次提醒算作"刚说过话"（冷却/配额确实被消耗）。
- **物理不可行照样拦**：通道断了、绑定对不上就发不出去，那是事实，不是节奏问题。
  `dryRun` / `allowExternalSend` 仍在提醒自己的装配里判，与这档正交。

### 投递前先落盘"认领"（防重复外发）

每次真发之前，runner 会先在同一份 `reminders.json` 上**落盘领一次**（`claim = {by, at, until}`，
TTL 120 秒，`by` 是 `pid-<pid>#<seq>`，见 `features/reminders/claim.ts`）。四个后果：

- **多实例 / 多拍只发一次**：第二个扫描者拿到业务拒绝 `STALE_STATE`，本拍跳过（以前只有进程内一个
  `running` 布尔量，跨进程毫无保护）；
- **认领过期 = 结果未知** ⇒ 收敛成 `unknown`（`claim-expired:unknown`），**不重发**（盘上分不清
  "发之前崩"还是"发之后崩"，重发就是重复外发）；
- `skipped` / `dry-run` 之后**立刻放回**，否则周期提醒的下一轮会被自己的旧认领挡住。
  **只放自己的**：`releaseClaim(id, owner)` 在 `claim.by !== owner` 时回 `STALE_STATE`（替别人
  放回等于让对方的下一次扫描重发一遍，而对方可能正在发）；
- **发送期间续租**（第二轮）：按 `TTL/3 = 40 s` 续租，避免"我们还在发、认领先过期"被别的进程
  收成 `unknown`。续租失败只记日志，不改投递结论。

**认领靠什么互斥**（第二轮补的）：不是进程内队列，而是 `node:sqlite` 的 `BEGIN IMMEDIATE`
（内核级文件锁，锁文件 `<reminders.json>.lock.db`）。锁套在**事务层**，所以所有读-改-写都受
同一把锁约束，并且事务基线是**锁内重读的磁盘内容**——两个独立进程不再可能各自读到
`claim=null` 再各自发送。`node:sqlite` 不可用时 `store.writeModel()` 会如实报
`in-process-only`（不假装支持多进程）。语义是 **at-most-once 倾向**，不是 exactly-once
（没有平台幂等键）。设计与证据见
[docs/reminders-dispatch-timing.md](docs/reminders-dispatch-timing.md) §10。

**结构化日志**（`grep 'reminders: dispatch'`，**不含正文**——日志会被贴进 issue）：

```
reminders: dispatch reminderId=r_xxx scheduledAt=1794238800000 observedAt=1794241330369
  latenessMs=2530369 claimedAt=1794238808654 sendStartedAt=… sendCompletedAt=… attempt=1
  outcome=sent
```

`latenessMs` 是事后复盘唯一的硬证据：只要它 > 1000 就会**额外**先打一行
`reminders: <id> 迟到 latenessMs=…（计划 X，观察 Y）`，正常按时不刷这条噪音。

**读失败时的写入锁**：如果盘上**有** `reminders.json` 但读不出来（损坏/权限/半截 JSON），
提醒会**空表起步并锁定所有写入**（日志 `锁定所有写入` + 每次写入被拒时 `写入被拒绝`），
原文件保持原样——否则第一次 `add()` 就会拿空表把它覆盖掉。
**恢复办法**：修好/改名原文件后重启，或调 `ReminderStore.clearReadLock()`。
（文件**不存在**不算事故，那是新装，不锁。）

⚠️ **`count` 的陷阱（很容易误判）**：读失败时内存里是空表，
所以 `/api/resource/reminders` 的 `count` 会给 **`null`** 并附 `readLock`，
后台「提醒」页显示 **`提醒读失败：数据不可读（写入已锁定）`**、概览页那一格显示 `读失败`。
**`count=0` 只表示"真的没有提醒"；`count=null` 才是"读不出来"。**
**`count=0`/列表为空其实不代表"没有提醒"** —— 一旦 `readLock` 非空，就请按"读不出来"理解，
那是"用 0 冒充"的一种变体。
故障状态同时落在 sidecar **`reminders.json.readonly.json`**（含 `at`/`reason`/`source`/`detail`），
`clearReadLock()` 会删掉它；日志里 grep `锁定所有写入` 或 `readonly.json` 都能定位。

### 事件的诚实标签 `honest`（QQ 侧自有约定）

`GET /api/resource/reminders` 的 `list()` 里带 `pendingDispatch: {value, oldestAgeMs, overLimit}`
与 `honest: 'measured'`。其中 `honest` **是 QQ 侧自己的约定**：

- `'measured'` 只表示"这三个数是**数出来的**（`ReminderStore.dispatchDiagnostics()`），不是估算、
  也不是'接口没接'"；
- runtime 那边那套四档诚实标签（`measured` / `not-wired` / `degraded` / …）**同名但不同源**：
  runtime 不读这个字段，QQ 也不读它的。**请不要当成两边已经打通**——要打通得专门去对齐。

**运维怎么看这两个数**（两处，数值同源）：

1. 后台网页「提醒」页：有积压时出现 pill `事件待补 N 条（最久 X 秒）`；出现放弃时是 `已放弃补发 M 条`。
   总览「关键指标」还有 `事件待补 / 放弃补发` 两格。
2. 日志：runner 每拍收尾，只要 `value>0` 或 `overLimit>0` 就打一行
   `reminders: pendingDispatch value=1 oldestAgeMs=61000 overLimit=0`（`grep 'pendingDispatch value='`）。

⚠️ **已知限制**（需人工动作，代码不会自愈）：补发到上限（10 次）后转**终态**，此后
**不再重试、不再自愈、没有主动告警**——只有日志与上面的计数；看到 `overLimit` 涨了，
说明需要人去查 agenda/事件书。

### 补发窗口与每拍上限（防雪崩）

提醒**不是**"只要没发过就一定会补发"。两条硬约束（`src/features/reminders/catch-up.ts` + `runner.ts`）：

| 约束 | 值 | 行为 |
|---|---|---|
| 补发窗口 | **6 小时** | `at` 比现在早超过 6 小时的提醒**不再补发**，收成终态：`fired=true` + `expiredAt` + `expiredReason='skipped-expired:too-old'`（后台能看到，日志写 `N 条已超出补发窗口`） |
| **积压总量** | **20 条** | 窗口内的到期提醒超过 20 条时，**按最老优先丢弃**超出部分 → `skipped-expired:backlog-overflow`（日志写 `因积压丢弃 M 条`，后台有 `积压丢弃` 计数） |
| 每拍条数 | **3 条/拍** | 一拍最多发 3 条，其余**不丢弃**、下一拍继续（日志写 `本拍到点 X 条，按每拍上限 3 条先发`） |

**拍间隔不再是固定 30 秒**（2026-11-10 热修）：runner 按**下一条提醒的 `scheduledAt`** 定下一次唤醒
（`src/features/reminders/schedule.ts` + `wakeup.ts`），没有未来提醒时才退回心跳（默认 30 秒）。
旧实现是 `setInterval(30_000)` 固定轮询，**到点误差的下界就是 30 秒**——2026-11-09 那条提醒因此
在闸门放开后又白等了 17.5 秒（完整时间线见 [docs/reminders-dispatch-timing.md](docs/reminders-dispatch-timing.md)）。
`MAX_CATCH_UP_PER_TICK = 3` 本身**没变**。

为什么：`dryRun` 关掉（或机器停机很久再开机）的那一刻，如果没有这三条，会把积压的提醒**一次性全炸出来**；
而只有"窗口 + 每拍上限"时，"停机 6 小时"能攒出 720 条、分 2 小时慢慢发——**那是刷屏**，比"不发"糟得多。
6 小时的口径是"到点没过半天的补一下还有意义，昨天的就算了"；20 条的口径是"宁可少发，也不要把昨天的
提醒排两小时发出去"。

**运维含义**：如果关掉 dryRun 后某条提醒没响，先看它的 `at`：（a）超出 6 小时窗口 → 日志 `超出补发窗口`；
（b）窗口内但积压超 20 条且它是最老的那批 → 日志 `因积压丢弃 M 条` + `丢弃明细 <HH:MM> <文本>`（前 5 条），
后台「提醒」页有 `积压丢弃` pill 与逐条清单（时间 + 截断文本）。
**两种情况都不是丢数据**：记录仍在（`skipped-expired:*` + `expiredAt`），只是不补发。

**怎么读"现在还在丢吗"**：后台 `reminders.catchUp` 有四个数 ——
`dropped`（**累计**丢弃数，只说明历史上丢过多少）、`droppedLast24h`（**最近 24 小时**丢弃数，
> 0 才说明"现在还在丢"）、`lastDroppedAt`（最后一次丢弃时刻）、`droppedItems`（丢了哪几条：时间 + 截断文本 + 原因，最多 20 条）。

⚠️ **清单 ≠ 全部**：`droppedItems` 最多 20 条。丢了 30 条时清单只有 20 条——
这时 `droppedTotal`（真实总数）与 `droppedTruncated`（`true` = 清单被截断）会告诉你"清单不完整"，
后台「提醒」页会显示 `清单不完整 | 共 30 条，这里只列了 20 条（还有 10 条未列出）`，日志也会写
`丢弃明细只列了 5 条，还有 N 条没列出`。**看到 `droppedTruncated=true` 就别把清单当全部。**

**agenda 端口什么时候会被丢弃**：`agenda` 服务是**每次用到时重新解析**的（foundation 可能比我们晚发布）。
偶发一次解析不到会沿用上次的端口（瞬时故障不该丢）；但**连续 3 次解析不到**就会**丢弃旧引用**并记
`agenda 端口连续 3 次解析不到，已丢弃旧引用`——因为继续用一个可能已被卸载的服务，会静默失败；
明确变成"没有服务"至少会走 `agenda-absent` 这条诚实路径。

### 已知限制（需要人工动作）

1. **`backlog-overflow` 与 `too-old` 都是终态、不可逆**：被收成这两种的提醒**不会再补发**，
   想再响只能**重建提醒**。看到后台 `积压丢弃` / `超出补发窗口` 涨了，说明这段时间的提醒**已经放弃**了。
2. **补发到上限（10 次）的 dispatched 事件**同样是终态：不再重试、不自愈、无主动告警，只有日志与
   `pendingDispatch.overLimit` 计数。
3. **丢弃策略是"最老优先"**：保留的 20 条是**最新的**那批（价值衰减假设：几分钟前的还来得及，几小时前的已错过）。
   副作用：若"每天 7 点吃药"这类**重要**提醒恰逢当天攒了 20+ 条，**它会先被丢**——我们没有重要性字段，
   也不该猜；真需要"吃药不能丢"，要做的是**提醒优先级字段**（新功能），不是改排序方向。
4. **`dropped` 是累计值**：要等 `pruneFired` 把那些行清掉才会回落；判断"现在是否还在丢"请用 `droppedLast24h`。
5. **dryRun 的"零写入"只在进程内验证过**：`R5-1` 断言的是"同一进程连续多拍前后整份 `reminders.json` 逐字段不变"，
   **跨进程重启**（演练中崩溃 → 重启后是否仍零写入）没有测试覆盖。
   **2026-11-10 补充**：投递前的**认领**（`claim`）在 dryRun 下**整笔不发生**（`store.claim()` 自己就挡，
   不依赖调用方记得传探针——`T9` 断言演练多拍之后盘上逐字节不变）。代价：**演练不验并发**——
   "两个实例同时扫会不会重复发"只能在非演练下复现。
   **第二轮补充**：跨进程并发现在有**真子进程**覆盖（`test/reminders-multiprocess.test.ts`，8 个用例），
   但那些用例都跑在 `dryRun=false` 上；"演练中崩溃重启仍零写入"这一条依旧只由"整条入口零写入"的
   设计保证，没有崩溃注入测试。
6. **周期提醒与一次性提醒的优先级**：每拍 3 条的上限**只对一次性提醒计数**，周期提醒永远进本拍
   （否则一条 daily 会把一次性提醒饿死）。反向的"上百条周期提醒同时到点时一次性提醒会不会被拖"，
   已有 `R5-6`（50 daily + 5 一次性 ⇒ 3 拍内一次性全部发出）覆盖到这个量级，**更大规模未测**。
7. **"到点 5 秒内发出"的边界**（2026-11-10 新增，别读大）：`test/reminders-dispatch-timing.test.ts` 的
   `T1`/`T6` 钉的是"**从 `scheduledAt` 到进入发送流程**"的延迟 ≤ 5 秒（假时钟上实测 0ms，因为按
   `at` 精确定时）。它**不**包含：QQ 侧网络往返、`OutboundQueue` 的 `rateLimitMs` 排队、系统休眠期间
   的时间（`setTimeout` 跨休眠不保证按墙钟走，靠心跳兜）、以及进程没在跑的时间（那段时间由补发窗口管）。
   端到端"主人 23:40 收到"的保证比这个弱，别把它当 SLA。
8. **到期未消费的提醒会退避**（第二轮新增）：`dryRun`（默认开）、通道暂不可用、房间不在白名单、
   日程暂时阻断、积压超过每拍上限，这些情况**合法地不消费**提醒。以前下一拍仍会按 `MIN_WAKEUP_MS = 1`
   立刻再醒 ⇒ 空转 + 日志刷屏。现在按"有没有进展"退避：有进展 ⇒ 1 秒（积压按节奏继续）；
   没进展 ⇒ 翻倍，**上限是心跳**（所以通道恢复后最多等一个心跳就又看得见）。
   **退避状态纯内存、不落盘**（落盘就会破坏 dryRun 的零写入与旧数据字节兼容），所以重启后退避
   从零开始——那只是"启动第一拍立刻检查一次"，不影响正确性。
   诊断面读 `runner.backoff = { overduePasses, gapMs }`：`overduePasses` 在涨就是"一直没被消费"。
   设计见 [docs/reminders-dispatch-timing.md](docs/reminders-dispatch-timing.md) §11。

**已知未加压范围**：`contact-*`（203 条）没有进"12 个 CPU 忙循环 + `--test-concurrency=8`"的加压矩阵
（它与本批改动交集只有 share-port 与出站边界，上一轮压过）；本批加压覆盖的是 `round4-qq`、
`dispatched-atomicity`、`outbound-3a(_bind)`、`review3-qq`、`admin-*` 共 7 个套件。

## 开发

```bash
npm run verify        # 门禁
npm run eval          # 行为评测（红队 7 + 场景 15 + 人格 30 + 转录 8 + 记忆基准）
npm run audit         # 静态审计
npm run probe:admin   # 后台浏览器回归（headless Chrome）
```

- `test/golden/**` 是逐字节快照：改动输出必须先解释差异，不能静默更新。
- 每个改变行为的升级都必须带独立开关、默认关——关着时与旧版逐字节一致。

## 目录

```
src/
  core/       纯逻辑（可重放）
  app/        入站流水线、组包、回合
  features/   子插件（工具、记忆、主动行为、后台、审批…）
  adapters/   宿主与外部世界
  config/     配置 schema 与页面清单
assets/persona/  人格与提示词（纯文本）
deploy/          发布、备份、审批执行器
eval/            行为评测
scripts/         构建与门禁
```

## 安全

管理后台是**远程控制面**：默认只监听 `127.0.0.1`，请通过 SSH 隧道访问；口令只从
环境变量读取。详见 [SECURITY.md](SECURITY.md)。

**访问门控**：默认 `access.mode = pairing`——陌生 QQ 的私聊、以及尚未批准的群里的
消息，只会收到一句「待主人批准」，不会进入 agent；主人在后台「安全」页批准后放行。
管理员始终允许。需要预先授权时可把模式改成 `allowlist`，用 `access.allowUsers` /
`access.allowGroups` 指定名单；`open` 是旧的全放行行为，不建议在公网使用。

管理员也可以直接私聊机器人处理，不必开后台：

| 私聊命令 | 作用 |
|---|---|
| `待批访问` / `访问请求` | 列出待批的人/群，并给出可复制的放行命令 |
| `放行 999` | 批准某个 QQ 的私聊 |
| `放行群 107` | 批准某个群 |
| `拒绝访问 999` / `拒绝访问群 107` | 拒绝 |

这些命令只认管理员私聊，且在高危命令审批网关之前处理（动词刻意用「放行」，
不与网关的「批准/拒绝」冲突）。

**群策略** `access.groupPolicy`：

| 值 | 行为 |
|---|---|
| `member`（推荐） | 机器人已经在的群直接放行——加群本身就是主人操作，不用逐群批准 |
| `pairing`（默认） | 未批准的群先申请，和私聊一样待主人批准 |
| `allowlist` | 群只认 `allowGroups` 与后台已批准列表 |

私聊始终按 `mode` 走配对/白名单。群消息仍然受 `groupEnabled`、`requireMention`
与「群聊与房间」里的按群覆盖约束——那两处管的是“怎么回”，访问门控管的是“能不能触发”。

**未批准的群默认完全安静**：只有真正 @ 或命中关键词的消息才会生成一条请求并私聊通知
主人，群里不回「待主人批准」（`access.replyPendingInGroups` 可打开，且每个请求只回一次）。
没人叫机器人的闲聊不会触发配对，也不会刷屏。

## 许可

[MIT](LICENSE)
