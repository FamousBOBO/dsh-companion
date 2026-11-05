# 主动消息（proactive contact）

主动消息是「她想起一件事，于是找你说话」这条链路。它**不是**提醒，也**不是**日程：

| 通道 | 谁发起 | 走不走门控 | 送达保证 | 典型例子 |
|---|---|---|---|---|
| **提醒**（`features/reminders/`） | 用户明确要求 | 不走（承诺就是承诺） | runner 直发，有平台消息 id | 「明早九点叫我」 |
| **事件书**（`features/proactive/`） | 时刻表/窗口（数据驱动） | 安静时段 + requires | 回合或脚本 | 早报、巡逻、自省 |
| **主动消息**（`features/contact/`） | 候选（规则或模型提） | **完整门控**（本文） | 门控放行后由 worker 发送 | 「上次那个部署怎么样了」 |

三条共同遵守的是同一条边界：**模型只提建议，发不发由代码说**。

## 1. 一句话合同

1. **默认一切关闭**：`enabled=false`、`dryRun=true`、`allowExternalSend=false`、
   `sendMode='turn'`、`draftModel=false`。安装或启动**不会**隐式启用任何真实自主外发。
2. **每个 tick 零模型调用是常态**：门控（`gate.ts`）先判，全部通过之后才可能起草。
   "候选全被免打扰挡住"的那些 tick 一次模型都不调。
3. **只有代码能授权**：候选里的 `authorization` 由代码写；模型的技术会话 id 不是身份，
   `source` 只说明"为什么想到这件事"，不构成发送许可。
4. **状态是账本不是日志**：每条候选、每条投递都有终态，迟到结果不得让终态复活。

## 2. 与提醒直发通道的边界

**contact 不投递任何到期提醒，也不接管提醒通道。** 到期提醒有且只有一个投递方：
`features/reminders/runner.ts`。contact 对 `source === 'explicit-reminder'` 的候选
**一律 `drop`**（reason `reminders-owns`），不看授权、不看额度、不看任何开关状态。

| 通道 | 谁发起 | 走不走门控 | 谁投递 |
|---|---|---|---|
| **提醒**（`features/reminders/`） | 用户明确要求（"明早九点叫我"） | 不走 | `runner.ts` 直发，`markFired` 推进 `at` |
| **主动消息**（本文） | `contact.propose()` 提出的候选 | **完整门控** | 门控放行后由 worker 发送 |

### 2.1 为什么不做接管（第三轮审阅判 FAIL 的收口）

第二轮曾想按配置布尔"接管提醒"（`sourceReminders`），第三轮 Codex 审阅判 **FAIL**。
三条路都走不通，这是结论的依据：

1. **`reminders.enabled` 不是 runner 的停止事实**：`features/reminders/index.ts` 在装配时
   **无条件** `runner.start()`，那个布尔只在**提醒工具**（`reminders/tools.ts`）里被读。
   于是"开关关着"时 runner 照旧从同一份存储读 `due()` 并直发——按它去提候选就是**双发**。
2. **"摘掉 reminders 段"也不成立**：候选来源原本是 `host.get('reminders')` 的
   `ReminderStore`，**它由 reminders 子插件提供**。把那段摘掉，来源与服务一起消失，
   接管就没有数据可读——"停掉 runner 但仍能读它的存储"这件事在当前架构里表达不出来。
3. **生命周期没人推进**：contact 只读 `due()`，从不写 `fired`、不推进 `daily`/`weekly` 的
   `at`。接管期间一次性提醒永远是"未触发"（之后装回 runner 会补发一次），重复提醒只能
   处理首个 occurrence（`dedupeKey = reminder:<id>:<at>`），后续周期**漏发**。

所以本轮的结论是**不做**，而不是"再加一个开关"。真要做接管，前置条件是三件缺一不可：

- runner 侧提供**可验证的所有权/停止接口**（不是读配置布尔去猜），contact 能确认"此刻没有
  第二个投递方"；
- 两条通道共享**同一条 occurrence 消费记录**（谁发过、发到第几个周期），而不是各自一套账本；
- contact 负责**推进 `fired` / `at`**（或由提醒侧提供"消费即推进"的原子接口）。

这三件都属于提醒子系统自己的合同变更，不是 contact 单方面能补的。

### 2.2 现状

- contact **没有任何内置的自动候选来源**：`propose()` 只能由外部（后台诊断、其它子插件、
  测试）调用。开箱状态下即使 `enabled=true` 也不会凭空产生候选，见 §9。
- 提醒侧照旧按自己的节奏直发；contact 完全不读、不写提醒存储。

> 历史注记：第一轮"一律 drop"→ 第二轮"按 `reminders.enabled` 接管"（Codex 判仍可双发，
> F1）→ 第三轮"双条件接管 + `sourceReminders`"（仍判 FAIL，理由见 §2.1）→
> **本轮撤销接管**，回到"一律 drop"，并把做不到的部分写成前置条件，而不是一个开关。

## 3. 候选生命周期

```
            propose()
               │
        ┌──────▼──────┐   defer（环境不允许，保留）   ┌──────────┐
        │   pending   │◄─────────────────────────────│ deferred │
        └──────┬──────┘                              └────┬─────┘
               │ effective: 门控 send                     │
               │                                          │ 门控 drop / 过期
        ┌──────▼──────┐                                   │
        │  consumed   │（已发出，额度已记）                │
        └─────────────┘                                   │
                           ┌───────────┐  ┌──────────┐    │
                 drop ────►│ cancelled │  │ expired  │◄───┘
                           └───────────┘  └──────────┘
```

| 状态 | 含义 | 谁写 |
|---|---|---|
| `pending` | 等 `earliestAt`、等门控 | `propose()` |
| `deferred` | 门控说"现在不行"，保留候选、下轮再判 | worker（`deferCandidate`） |
| `consumed` | 已经发出去（`submitted`/`confirmed`/`unknown` 都算），额度与未回复计数已记 | worker（`afterSend`） |
| `cancelled` | 候选自身的问题（`reminders-owns`、`dedupe`、`binding-invalid`、`authorization-invalid`…） | worker（`dropCandidate`） |
| `expired` | 过了 `expiresAt`，或早于补算视界（`stale:restart`），或被池子上限挤出（`capped`） | worker |

其他字段的用法：

- `dedupeKey`：同一件事只该有一个候选。`propose()` 命中已存在的键返回 `duplicate`
  （不覆盖，只强化证据）；投递侧再用 `deliveredDedupeKeys` 挡一次。
  **注意边界**：代码只能保证"同一个 key 不重复"，**保证不了"同一件事只有一个 key"**——
  同一件事换个 `dedupeKey` 就能发两次。这是调用方（提候选的那一侧）的责任：key 应当由
  **事件身份**（哪条提醒、哪段聊天、哪个活动回执）派生，而不是每次现编一个。
- `version`：乐观并发。**版本核对发生在 store 的提交口**（`claimDelivery`/`settleDelivery`
  按 `epoch` 与修订号比对），不在门控里重复一次——门控是纯函数，它看不到"谁在同时写"。
- `maxCandidates`：池子超限时先丢**低优先级**、再丢**早过期**的，记 `expired` + `capped`。
- 补算视界（`maxCatchupHours`）：`now - earliestAt > 视界` 就判过期，reason `stale:restart`。
  它是**持续判定**，不是只在重启那一刻判一次——"停机八小时攒下三件事"与"一个候选在池子里
  滞留了一整天"落在同一格里处理，两者都不该补发。名字里的 restart 只说明它主要防的是
  恢复后的补发洪峰。

## 4. 一次 tick 的顺序

```
取租约（epoch）→ 跨日归零 → 未回复计数归零 → 标过期/超视界 → 池子上限
   → 取至多 maxPerTick 条（priority ↑, earliestAt ↑）
      → ① 廉价门控 evaluateGate
           ├ defer  → 记 deferred + reason，结束（不调模型）
           ├ drop   → 记 cancelled/expired，结束（不调模型）
           └ send   → ②
      → ② 出网授权 authorizeOutbound
           ├ dry-run / denied → 记账，不投递
           └ allowed → ③
      → ③ 起草（唯一花模型钱的地方，见 §6）
      → ④ 先落盘（claimDelivery 置 running）→ 发送 → settleDelivery
      → ⑤ 结算：额度 +1、该房间未回复 +1、候选置 consumed
```

顺序里有两个"必须在前"：**租约在最前**（否则两个实例会领同一条）、**门控在起草之前**
（否则"空转不调用模型"就是一句空话）。只有 ③ 会调用模型；①②都不产生任何外部副作用。
本轮**没有"扫来源"这一步**：候选只能由外部经 `propose()` 提出（见 §2.2 与 §9）。

## 5. 门控：顺序与 reason

`evaluateGate(input)` 是纯函数：无 IO、无 `Date.now()`、无随机。输入是候选、`now`、
配置、计数与运行时事实；输出 `{ verdict, reason }`。

### 5.1 verdict 的三种含义

| verdict | 含义 | 调用方行为 |
|---|---|---|
| `send` | 可以进入起草与投递 | 继续下一步 |
| `defer` | **环境**现在不允许，候选留着，下个 tick 再判 | 记 `deferred`，不动终态 |
| `drop` | **候选自身**的问题，这条候选永远不会发 | 记 `cancelled`（`expired` 例外记 `expired`） |

分界的判据只有一条：**能等的是 defer，不能等的是 drop**。把"环境问题"记成 drop 会
永久丢掉一条本来能发的候选；把"候选问题"记成 defer 会让一条过期候选一直占着去重位置。

### 5.2 顺序（`GATE_STEPS`）

先看候选自己，再看授权，再看人，再看预算，最后看通道。顺序是契约：诊断面板与测试都
按"**第一个**不通过的原因"解释一条候选为什么停在原地。

| # | 步骤 | reason | verdict | 说明 |
|---|---|---|---|---|
| 1 | `state` | `cancelled` / `consumed` / `expired` | drop | 终态先判：这是候选自己的事实，与"这台机器开没开"无关 |
| | | `disabled` | defer | 总开关关着（默认） |
| 2 | `window` | `expired` | drop | `now >= expiresAt` |
| | | `stale:restart` | drop | 早于补算视界，不补发 |
| | | `not-due` | defer | `now < earliestAt` |
| 3 | `authorization` | `authorization-invalid` | drop | `explicit`/`standing` 缺 `by` 或 `at`（说不清谁在何时许可的，等于没有许可）；`none` 是唯一允许空授权的形态 |
| | | `reminders-owns` | drop | 到期提醒只归 runner（见 §2） |
| | | `scope:no-user` | drop | 私聊候选却没有明确收件人 |
| | | `binding-invalid` | drop | 房间键与 `chatId` 不自洽（`group-<id>`/`dm-<id>` 后缀两种前缀都放行） |
| 4 | `quiet-hours` | `timezone-invalid` | defer | 配置的 IANA 时区不认识 → fail-closed |
| | | `quiet-hours` | defer | 落在安静时段（半开区间，支持跨午夜，如 23:00→08:00） |
| 5 | `contention` | `settle:user-active` | defer | 用户最后一条消息在 `settleWindowMs` 内（人家正在说话） |
| | | `turn-running` | defer | 这个房间正有一轮在跑 |
| | | `tool-running` | defer | 有工具在跑 |
| 6 | `cooldown` | `cooldown:room` → `cooldown:global` | defer | 会话冷却更具体，先判；0 = 该级不设 |
| 7 | `quota` | `quota:global` → `quota:room` | defer | 当日额度；计数跨日自动归零（按配置时区的"今天"） |
| 8 | `dedupe` | `dedupe` | drop | `deliveryDedupeKeys` ∪ `runtime.deliveredDedupeKeys` 命中 |
| 9 | `backoff` | `backoff:unanswered` | defer | 该房间连续未回复次数到上限（0 = 不设上限） |
|10 | `channel` | `no-channel` | defer | OneBot 没连上 |
| | | `binding-invalid` | drop | 运行时判定房间键不可用 |

`roomBound` 的判据边界（由调用方算）：**房间键与 chatId 自洽 + 会话存在或可安全合成**。
"还没聊过的 master 私聊"是合法目标——`registry.get()` 返回 `undefined` 只说明这个房间没被
物化过，不说明它不该存在。把它算成绑定失效会让**第一条**主动私聊被永久丢掉（drop 捡不回来）。
真正该判 false 的只有：群号与房间键互斥、目标是机器人自己、通道不支持该类目标。

### 5.3 没有在门控里的三件事

- **`dryRun` / `allowExternalSend`**：它们是"这条路允不允许存在"，不是"这条候选该不该发"，
  由 `authorizeOutbound(config)` 单独判，三态：`allowed` / `dry-run` / `denied`。
  `denied` 与 `dry-run` 都不出网：投递记录建行 → claim 成 `running` → sender 复核后
  settle 成 `deferred`，**`attempted: false`** 就是"真的没发"的硬证据。
  诊断里的 detail **直接就是** `dry-run` / `external-send-denied`，不再套一层 `deferred:`
  前缀——前缀会让"配置禁止"和"冷却挡了一下"在面板里长得一样。
- **`draftModel` 关着 / 起草返回"没话可说"**：门控已经放行，但文案这一侧没内容，
  调用方把候选记 `deferred`，reason 统一写 **`draft:unavailable`**。
  它不是门控的抑制项——门控管的是"该不该说"，这里管的是"有没有话"。
  （历史上 worker 里有过 `draft-unavailable` 与 `no-text` 两种写法，**现以 `draft:unavailable`
  为准**；`no-text` 取消，因为它与前者是同一件事，两个名字只会让面板分不清。）
- **`toolRunning` 的事实源**：门控读它，但首版装配侧没有可靠来源，缺省 `false`
  （不做假设），于是 `tool-running` 这道门实际上不会触发。

> 全部 23 条门控 reason、11 条起草 reason 与 23 个配置字段的对照见 [§12](#12-附录词汇表--配置项--默认值终检用)。

## 6. 起草：唯一的模型调用点

`DraftPort.draft(request) => Promise<ContactDraft | null>` 由装配方注入。真实现是
`draft-host.ts` 的 `createHostDraftPort()`，返回 `null` 是**合法结果**（"想了想，没什么
要说的"），不是错误。

### 6.1 走哪条模型路径

走 `llmSeam(ctx).llm.stream(...)`（`ctx.llm`），**不是** `AgentGateway.open()`：

| 维度 | 本实现（`llm.stream`） | 为什么不用会话 |
|---|---|---|
| 调用次数 | **1 次**，不重试 | 重试属于 `model.ts` 的预算与退避，这里再叠一层就是两套账 |
| 会话 | 不建 | 建一个 agent 会带上人格、历史与**工具面**；一句二十字的话不值得 |
| 工具 | **没有**（纯补全，工具面根本不存在） | 比"步数预算 1"更窄：连给的入口都没有 |
| 步数 | 无步进 | 同上 |
| 提示词 | 一段短提示（起因 + 格式要求 + `SKIP` 约定） | 不喂历史、不喂记忆，避免把隐私带进后台调用 |
| 输出 | 只要文本；`maxTokens ≈ 字数×3`（封顶 512） | 防小作文烧钱 |
| 超时 | `contact.draftTimeoutMs`，定时器在 `finally` 取消 | 超时按"这一轮没话说"处理，绝不拖住 tick |
| 失败 | 宿主没装模型服务/路由缺失/抛错/超时/空回复/模型回 `SKIP` → 全部 `null` | **绝不抛给 worker** |

清洗（`sanitizeDraft`）：去代码围栏、去"正文："这类前缀、去成对引号、折叠空白；
模型回 `SKIP`（或"算了/没什么可说的"）视为没话可说。**不截断**超长文本——截断会发出
半句话，长度由 `draftWithBudget` 判 `draft:too-long`。

### 6.2 预算、退避与失败语义

预算按**"到底发生了什么"**分档记账（F5 之后的口径；之前 `null` 把三件事压成一件，
导致失败清零退避、且小时环漏记调用）。端口的返回是**可判别结果** `DraftAttempt`
（`kind: draft | skip | empty | too-long | timeout | failed | not-called | no-route`，
`model.ts` 里用**穷尽 switch** 消费，漏一个分支就编译不过）：

| 端口返回 | outcome.reason | `draftCallsToday` | 小时环（`called`） | 失败退避 | 语义 |
|---|---|---|---|---|---|
| `draft`（未超长） | —（成功） | +1 | 记 | **清零** | 拿到一句可发的话 |
| `draft`（超 `draftMaxChars`） | `draft:too-long` | +1 | 记 | 不动 | 不截断，这一轮算了 |
| `too-long`（端口自己判定） | `draft:too-long` | +1 | 记 | 不动 | **单独消费**，不再猜成 empty/成功（R6） |
| `skip` | `draft:skip` | +1 | 记 | 不动 | 模型说"没什么可说"（合法） |
| `empty` | `draft:empty` | +1 | 记 | 不动 | 回了空白 |
| `failed` | `draft:failed` | +1 | 记 | **+1** | 流中断/宿主拒绝 |
| `timeout` | `draft:timeout` | +1 | 记 | **+1** | 超 `draftTimeoutMs` |
| `not-called` | `draft:not-called` | **不变** | 不记 | 不动 | **调用前**就坏了（取接缝/选型抛错）：一次模型调用都没发生（R6） |
| `no-route` | `draft:no-route` | **不变** | 不记 | 不动 | 宿主没配模型：**没发起调用** |
| （端口为 null） | `no-port` | 不变 | 不记 | 不动 | 装配缺件 |

其余规矩：

| 规矩 | 做法 |
|---|---|
| 共享预算 | 每日（`draftDailyBudget`，落 `counters.draftCallsToday`）+ 每小时突发（`draftHourlyBudget`，内存环） |
| 先问再调 | `canDraft()` 不过就**绝不调用端口**；空转与被门控抑制的候选不消耗预算 |
| 小时环 | 由调用方按 `outcome.called` 追加时刻——**每一次真的发起了模型请求**都算（含失败），这正是 F5 漏掉的那一半 |
| 失败退避 | `backoffMs = base × 2^(streak-1)`，**封顶 8 倍**（有界）；只有 `draft` 成功才清零 |
| 停手阈值 | 连续失败 `draftMaxFailures` 次就停止起草，等跨日（计数归零）或人工介入 |
| 兜底超时 | 端口自己也有一层 `draftTimeoutMs`；端口违约（抛错）由预算层兜成 `failed` |
| 不阻塞 | 模型离线、超时、抛错都收敛成"这一轮没话说"，绝不拖动日程/回合/记忆路径 |

`turn` 模式下的文案是**指令**而不是成品句子（人格包再包一层，由模型在回合里自己决定怎么
开口），**不经过** `DraftPort`；`direct` 模式才需要成品短文本，因此
`sendMode='direct'` 且 `draftModel=false` 时 `direct` 发不出任何东西——装配时会明确记一行
日志，配置项 help 里也写着。`draftModel` 默认 `false`，所以**装上端口不等于用上**：
一个 tick 都不会调用它，除非显式打开。

## 7. outbox 状态机

```
pending ──claim──► running ──调用平台──► submitted ──有回执──► confirmed
   │                  │                     │
   │                  │                     └──超时/无回执──► unknown
   │                  └──明确 reject──► failed
   └──任何非终态都可被 deferred / cancelled
```

| 状态 | 确切含义 |
|---|---|
| `pending` | 已落盘、还没领取（同一 `dedupeKey` 只有一行） |
| `running` | 本实例持有租约正在发。**进程死在 `running`** → 读盘时降级为 `unknown`（不是重发） |
| `submitted` | 已经交给平台/已发起回合，但**没拿到可核对的回执** |
| `confirmed` | **平台接受了这条消息**（拿到 `message_id`）。**不等于送达，更不等于已读** |
| `unknown` | 回执未知（超时/异常/崩溃）。**不自动重发**：回执可能只是丢了；先按 `dedupeKey` 核对再决定 |
| `failed` | 明确的 reject。按 `maxSendAttempts` 有限重试，超过就放弃这条候选（`give-up:`） |
| `cancelled` | 复核发现"永远不会变好"（候选已终态、作用域不符、绑定失效） |
| `deferred` | 复核认为"下轮还有机会"（冷却、免打扰、通断、模式变更） |

两条硬规矩：

1. **`turn` 模式到不了 `confirmed`**：它只是把指令交给会话回合，没有平台回执。所以
   `turn` 模式最多停在 `submitted`——这正是默认选它的代价，也是它比直发更安全的地方。
2. **`unknown` 不是失败**：失败重试是"我知道它没发出去"，`unknown` 是"我不知道"。
   后者盲目重发会造出一个"发了两遍"的真实事故，所以宁可在账本里留一条不确定。

## 8. 配置：默认值表

**下面每一个数字都是「工程建议默认值，非用户决定」。** 用户没有对任何一个阈值表过态；
它们按同一条排序取 *免打扰 > 额度 > 冷却 > 想说话*。改动任何一项都会直接改变打扰频率。

配置落在后台现有的「主动行为」页（`proactive`，段 id `contact`）。**23 个字段，来源一栏
全都是「工程建议」**——逐条核过，没有一条来自用户（`CONTACT_DEFAULTS` 与代码同一份）。

| 字段 | 默认 | 单位 | 来源 | 后果 |
|---|---|---|---|---|
| `enabled` | `false` | — | 工程建议 | 关着：候选照常入库，一条不发、不调模型 |
| `dryRun` | `true` | — | 工程建议 | 开：走完全部门控与草稿，只记账不投递 |
| `allowExternalSend` | `false` | — | 工程建议 | 第二道闸，与 `dryRun` 是**与**关系 |
| `sendMode` | `'turn'` | — | 工程建议 | `turn` 经会话回合（无回执）；`direct` 直发（可到 `confirmed`）**但需要 `draftModel`**：direct 没有模板文案路径 |
| `timezone` | `''` | IANA | 工程建议 | 空 = 跟随宿主 `TZ`；**跨时区部署必须写死**（否则换机器/换 `TZ` 时免打扰会静默漂移）；写错 = 一律不发（fail-closed） |
| `quietHours` | `[{from:'23:00',to:'08:00'}]` | — | 工程建议 | 半开区间、支持跨午夜；空数组 = 不设免打扰 |
| `settleWindowMs` | `120000` | ms | 工程建议 | 用户说话后这么久内不开口；0 = 关闭该门 |
| `maxCandidates` | `50` | 条 | 工程建议 | 候选池上限，超了丢低优先级/早过期的 |
| `globalCooldownMs` | `1800000` | ms | 工程建议 | 两条主动消息的全局最小间隔；0 = 不设 |
| `perRoomCooldownMs` | `3600000` | ms | 工程建议 | 同房间最小间隔；0 = 不设 |
| `dailyQuotaGlobal` | `3` | 条 | 工程建议 | 一天最多主动开口几次（跨日归零） |
| `dailyQuotaPerRoom` | `2` | 条 | 工程建议 | 同一房间一天最多几次 |
| `maxUnansweredStreak` | `2` | 条 | 工程建议 | 连续未回复这么多条就先停手；0 = 不设上限 |
| `pollIntervalMs` | `60000` | ms | 工程建议 | worker 节拍；空转零模型调用，只影响延迟 |
| `maxCatchupHours` | `24` | 小时 | 工程建议 | 早于视界的候选判过期（`stale:restart`），不补发；0 = 关闭该判定 |
| `maxPerTick` | `1` | 条 | 工程建议 | 每轮最多领取几条 |
| `draftModel` | `false` | — | 工程建议 | 关着：只产候选与诊断，**`direct` 模式发不出去**（`turn` 不需要它：文案来自人格包） |
| `draftDailyBudget` | `20` | 次 | 工程建议 | 一天最多调用模型几次（成功与失败都算） |
| `draftHourlyBudget` | `5` | 次 | 工程建议 | 每小时突发上限（只在内存里记，重启归零） |
| `draftTimeoutMs` | `20000` | ms | 工程建议 | 单次起草超时；0 = 不设超时 |
| `draftMaxChars` | `120` | 字 | 工程建议 | 短消息硬上限，超了按"没话可说"处理（不截断） |
| `draftFailureBackoffMs` | `60000` | ms | 工程建议 | 退避基数，按失败次数翻倍、封顶 8 倍 |
| `draftMaxFailures` | `5` | 次 | 工程建议 | 连续失败到阈值就停止起草（等跨日或人工） |

### 8.1 已有明确偏好时谁优先

优先级从高到低：

1. **用户在配置里写下的值**（后台保存的 `admin-config.json` 覆盖层）；
2. **cordis patch 层**（`cordis.patch.yml` 里那段 `contact`）；
3. **本文件 §8 的工程建议默认值**。

从记忆、原话、聊天记录里读到的偏好（"别在半夜发消息给学弟"）**不直接生效**：它是
**证据**，要经操作者写进配置才变成阈值。理由与 `authorization` 同一条——模型不能自证授权，
也不能自己给自己放宽打扰额度。真要接"从记忆读偏好"，必须走一次显式的操作者确认。

## 9. 未启用项 / 已知缺口（诚实清单）

- **本轮没有内置的自动候选来源**：`sources.ts` 已删除（撤销提醒接管，见 §2.1）。候选只能由
  外部经服务袋的 `contact.propose()` 提出（后台诊断、其它子插件、测试）。所以
  `enabled=true` 本身**不会**产生任何候选——想看到消息，必须先有生产者。`follow-up` /
  `activity-receipt` / `share-intent` 三种 `source` 类型目前**没有生产者**。
- **不读不写提醒存储**：contact 与 `features/reminders` 完全解耦，既不会替它发，也不会替它
  推进 `fired`/`at`。想做接管的前置条件见 §2.1（所有权接口 + 共享 occurrence + 推进周期）。
- **`turn` 模式只能到 `submitted`，永远到不了 `confirmed`**：它把指令交给会话回合，
  没有平台回执。要 `confirmed` 只能用 `direct`（且平台真的回了 `message_id`）。
- **`toolRunning` 没有可靠事实源**：首版缺省 false（不做假设），`tool-running` 门实际不生效。
- **每小时草稿预算只在内存**：重启归零；每日预算才是持久化的。
- **超时只是丢弃结果，不 abort 宿主流**：`llm.stream` 没有我们验过的取消接口，超时后那次
  请求可能仍在宿主那边跑完（额度已花，结果被丢弃）。
- **`draftModel` 默认关** → 开箱状态下 contact 只产候选与诊断；`direct` 模式需要它。
- **"默认静默" ≠ "不花钱"**（Codex 第四轮点名的口径，容易看错，单列）：
  - `dryRun` / `allowExternalSend` **只阻止投递**，不阻止 `direct` 模式**起草时调用模型**——
    只要 `draftModel=true`，门控放行后的候选照样会花一次模型调用，钱照扣、预算照计；
  - `draftModel=false` 也**不阻止** `turn` 模式让宿主在会话回合里调用模型——那条路的模型
    调用发生在回合内部（人格包渲染 + agent 跑一轮），既不受本模块的草稿预算管，也不在
    `draftCallsToday` 里；
  - 真正"不花钱"的组合只有：`enabled=false`（worker 不起表），或没有任何候选/回合在跑。
    仅把 `dryRun` 打开**不构成**成本控制手段，成本控制请用 `draftModel` + 三个草稿预算。
- **没有独立后台页面**：配置复用「主动行为」页（段 id `contact`，字段路径 `contact.*`，
  与同页 `dailyReport.enabled` / `morningReport.enabled` 各自独立）；诊断走服务袋
  `contact` 服务的 `status()`。
- **不读生产记忆库、不发真实外发**：本轮的验证全部用假时钟、假端口与临时目录。

## 10. 与验收清单的对应

| 12 页编号 | 场景 | 本模块的证据 |
|---|---|---|
| T01 | 空转 24 小时 | 门控不过就不调模型；`draftCallsToday` 停在原处 |
| T15 | 模型离线/额度耗尽 | `draftWithBudget` 收敛成 `none` + 有界退避，日程与回合照常 |
| T16 | 无通道/候选过期 | `no-channel` defer、`expired` drop；真实外发 0 条 |
| T17 | 暂停/卸载 | worker `pause()` 停表并释放租约；`dispose()` 有界等待后释放 |

## 11. 代码位置

| 关注点 | 文件 |
|---|---|
| 共享词汇（候选/投递/租约/计数/运行时事实/服务面） | `src/features/contact/types.ts` |
| 门控（纯函数、reason 表、顺序、`authorizeOutbound` 三态） | `src/features/contact/gate.ts` |
| 时区 / 免打扰 / 跨日额度 | `src/features/contact/local-time.ts` |
| 起草端口、预算、退避、超时 | `src/features/contact/model.ts` |
| **起草的真实现**（宿主模型接缝、单次短补全、超时、输出清洗） | `src/features/contact/draft-host.ts` |
| 账本形状与"洗数据"（版本不认识按读不动处理） | `src/features/contact/ledger.ts` |
| 账本文件原子读写（tmp+rename、坏文件 `.corrupt`、rename 有界重试） | `src/features/contact/ledger-io.ts` |
| 跨进程租约与代次 | `src/features/contact/lease.ts` |
| 账本读写入口（候选/投递/计数，写都过租约） | `src/features/contact/store.ts` |
| 账本状态迁移（丢弃/延期/结算后处理/过期清扫/候选上限/退避归零） | `src/features/contact/transitions.ts` |
| "门控放行之后"那一段（备文案 → 领投递 → 发送 → 结算 → 记账） | `src/features/contact/attempt.ts` |
| 发送与复核（真发前再判一次） | `src/features/contact/sender.ts` |
| 节拍（什么时候看、看几条、单飞、租约、补拍） | `src/features/contact/worker.ts` |
| 对外服务面（`propose/cancel/setPaused/status`，**没有 `sendNow`**） | `src/features/contact/service.ts` |
| 子插件装配、资源注册、卸载顺序 | `src/features/contact/index.ts` |
| 配置段（23 字段、`CONTACT_DEFAULTS`） | `src/config/sections/contact.ts` |

> 目录被拆成多个文件是**硬约束**（`scripts/check-size.mjs`：新文件 ≤400 行、新函数 ≤60 行），
> 不是为了好看。每个文件的头注释都写了"为什么这一段单独存在"。

## 12. 附录：词汇表 ↔ 配置项 ↔ 默认值（终检用）

三张表放在一处，供逐行对着代码核。三份来源：`gate.ts` 的 `GATE_REASONS`、
`model.ts` 的 `DRAFT_REASONS`、`config/sections/contact.ts` 的 `CONTACT_DEFAULTS`。
**改任何一个字符串或数字，都要同步改这一节**——它是终检的唯一索引。

### 12.1 门控 reason（23 条：22 条抑制 + 1 条通过）

| # | reason | verdict | 产生的步骤（`GATE_STEPS`） | 对应配置项 | 默认值（工程建议） |
|---|---|---|---|---|---|
| 1 | `ok` | send | —（全部通过） | — | — |
| 2 | `disabled` | defer | `state` | `contact.enabled` | `false` |
| 3 | `cancelled` | drop | `state` | —（候选自身状态） | — |
| 4 | `expired` | drop | `state` / `window` | —（`expiresAt` 由候选给） | — |
| 5 | `consumed` | drop | `state` | —（候选自身状态） | — |
| 6 | `not-due` | defer | `window` | —（`earliestAt` 由候选给） | — |
| 7 | `stale:restart` | drop | `window` | `contact.maxCatchupHours`（0 = 关闭） | `24` 小时 |
| 8 | `authorization-invalid` | drop | `authorization` | —（`by`/`at` 必须齐全） | — |
| 9 | `scope:no-user` | drop | `authorization` | — | — |
| 10 | `reminders-owns` | drop | `authorization` | —（硬规则：到期提醒只归 reminders runner，见 §2） | — |
| 11 | `quiet-hours` | defer | `quiet-hours` | `contact.quietHours` | `[{23:00 → 08:00}]` |
| 12 | `timezone-invalid` | defer | `quiet-hours` | `contact.timezone`（空 = 跟随宿主 TZ；跨时区部署必须写死） | `''` |
| 13 | `settle:user-active` | defer | `contention` | `contact.settleWindowMs`（0 = 关闭） | `120000` ms |
| 14 | `turn-running` | defer | `contention` | —（运行时事实） | — |
| 15 | `tool-running` | defer | `contention` | —（运行时事实；首版无可靠源） | — |
| 16 | `cooldown:room` | defer | `cooldown` | `contact.perRoomCooldownMs`（0 = 关闭） | `3600000` ms |
| 17 | `cooldown:global` | defer | `cooldown` | `contact.globalCooldownMs`（0 = 关闭） | `1800000` ms |
| 18 | `quota:global` | defer | `quota` | `contact.dailyQuotaGlobal` | `3` 条/日 |
| 19 | `quota:room` | defer | `quota` | `contact.dailyQuotaPerRoom` | `2` 条/日 |
| 20 | `dedupe` | drop | `dedupe` | —（投递账本的 `dedupeKey` ∪ 运行时事实） | — |
| 21 | `backoff:unanswered` | defer | `backoff` | `contact.maxUnansweredStreak`（0 = 不设上限） | `2` 条 |
| 22 | `no-channel` | defer | `channel` | —（运行时事实：OneBot 连接） | — |
| 23 | `binding-invalid` | drop | `authorization` / `channel` | —（房间键与 `chatId` 自洽） | — |

两处最容易看错的，单列一遍：

- **`stale:restart` 是持续判定**，不是"只在重启那一刻"：条件始终是
  `now - candidate.earliestAt > maxCatchupHours × 3600000`，正常跑着也会触发
  （一条候选在池子里滞留超过视界同样该丢）。名字里的 restart 只说明它主要防的是
  恢复后的补发洪峰；worker 启动时给滞留候选打的标记也用同一个串，所以诊断里只有一种说法。
  `maxCatchupHours = 0` 在 gate 与 worker 两边都表示**关闭该判定**。
- **`reminders-owns` 是硬边界**：到期提醒的唯一投递方是 `features/reminders/runner.ts`。
  `source='explicit-reminder'` 的候选在 contact 里**一律 drop**（不看授权、不看额度、不看任何
  开关），因为"按配置布尔接管"根本保证不了互斥（runner 无条件启动、不读 `reminders.enabled`；
  摘掉 reminders 段又会连存储一起摘掉）。完整论证见 §2.1。

### 12.2 起草 reason（14 条，`model.ts` 的 `DRAFT_REASONS`）

调用方把这里的非 `ok` 结果统一映射成候选的 `deferred` + gate 词表里的 `draft:unavailable`；
详细原因进日志与诊断。**记账口径见 §6.2 的那张表**（哪些计入调用次数/小时环、哪些推进退避）。

| # | reason | 含义 | 对应配置项 | 默认值（工程建议） |
|---|---|---|---|---|
| 1 | `ok` | 允许起草 | — | — |
| 2 | `disabled` | `draftModel` 关着 | `contact.draftModel` | `false` |
| 3 | `no-port` | 装配缺件（没注入 `DraftPort`） | — | — |
| 4 | `budget:daily` | 当日预算用尽 | `contact.draftDailyBudget` | `20` 次/日 |
| 5 | `budget:hourly` | 每小时突发用尽 | `contact.draftHourlyBudget` | `5` 次/时 |
| 6 | `backoff:draft` | 失败退避未到 | `contact.draftFailureBackoffMs` | `60000` ms（×2 递增，封顶 8×） |
| 7 | `backoff:streak` | 连续失败到阈值，停手 | `contact.draftMaxFailures` | `5` 次 |
| 8 | `draft:skip` | 模型说"没什么可说"（`SKIP`，调过模型、**不算失败**） | — | — |
| 9 | `draft:empty` | 回了空白（调过模型、**不算失败**） | — | — |
| 10 | `draft:too-long` | 超过字数上限，不截断（调过模型、**不算失败**） | `contact.draftMaxChars` | `120` 字 |
| 11 | `draft:failed` | 流中断/宿主拒绝（**算失败**，推进退避） | — | — |
| 12 | `draft:timeout` | 超时（**算失败**，推进退避） | `contact.draftTimeoutMs`（0 = 不设） | `20000` ms |
| 13 | `draft:not-called` | **调用前**就坏了（取接缝/选型抛错；一次模型调用都没发生，什么都不记） | — | — |
| 14 | `draft:no-route` | 宿主没配模型（**没发起调用**，什么都不记） | — | — |

### 12.3 配置字段（23 个，`CONTACT_DEFAULTS`）

**全部是「工程建议默认值，非用户决定」**。字段路径一律 `contact.<名字>`（后台「主动行为」页）。

| # | 字段 | 默认值 | 热生效 | 门控/起草里的用途 |
|---|---|---|---|---|
| 1 | `enabled` | `false` | reload | `disabled` |
| 2 | `dryRun` | `true` | reload | `authorizeOutbound` → `dry-run` |
| 3 | `allowExternalSend` | `false` | reload | `authorizeOutbound` → `denied` |
| 4 | `sendMode` | `'turn'` | reload | 决定 outbox 上限（`turn` 只能到 `submitted`） |
| 5 | `timezone` | `''` | live | `timezone-invalid` / `quiet-hours` / 跨日额度 |
| 6 | `quietHours` | `[{23:00 → 08:00}]` | live | `quiet-hours` |
| 7 | `settleWindowMs` | `120000` | live | `settle:user-active` |
| 8 | `maxCandidates` | `50` | live | 候选池上限（worker 淘汰） |
| 9 | `globalCooldownMs` | `1800000` | live | `cooldown:global` |
| 10 | `perRoomCooldownMs` | `3600000` | live | `cooldown:room` |
| 11 | `dailyQuotaGlobal` | `3` | live | `quota:global` |
| 12 | `dailyQuotaPerRoom` | `2` | live | `quota:room` |
| 13 | `maxUnansweredStreak` | `2` | live | `backoff:unanswered` |
| 14 | `pollIntervalMs` | `60000` | reload | worker 节拍 |
| 15 | `maxCatchupHours` | `24` | live | `stale:restart`（0 = 关闭） |
| 16 | `maxPerTick` | `1` | live | 每轮领取条数 |
| 17 | `draftModel` | `false` | live | 起草 `disabled` |
| 18 | `draftDailyBudget` | `20` | live | 起草 `budget:daily` |
| 19 | `draftHourlyBudget` | `5` | live | 起草 `budget:hourly`（仅内存） |
| 20 | `draftTimeoutMs` | `20000` | live | 起草 `draft:timeout` |
| 21 | `draftMaxChars` | `120` | live | 起草 `draft:too-long` |
| 22 | `draftFailureBackoffMs` | `60000` | live | 起草 `backoff:draft` |
| 23 | `draftMaxFailures` | `5` | live | 起草 `backoff:streak` |
