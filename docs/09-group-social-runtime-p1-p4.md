# P1–P4 交付记录：群聊社交运行时（2026-11-08）

本文承接 `docs/08-group-social-runtime-p0.md`（P0 已交付并验证），记录 P1–P4 与
QA 离线评测的实际落地内容。**证据级别只有 offline-test**：本文件里所有"通过"都指
离线测试与静态检查，不构成 QQ 真实发送、真实模型行为或线上得体性的任何证据。

---

## 0. 一句话总结

| 阶段 | 做了什么 | 提交 | 状态 |
|---|---|---|---|
| P1 | 群体记忆 / 成员记忆 / 话题状态（独立 SQLite 库，按群结构隔离）+ 召回与写入 | `dbbe983` | 完成 |
| P2 | 五动作社交决策器、严格解析、目标与执行边界 | `24e7494` | 完成 |
| P3 | 统一群事件时间线、话题识别、调度参数拆分与饥饿告警 | `ed1e928` | 完成 |
| QA | 41 条离线评测集 + 六个指标 + 硬门槛 | `2f758ad` | 完成 |
| P4 | 群聊表达约定（系统提示词段）、表情包策略与投递、弱反馈账本 | `2f758ad` + 本次 | 表达与表情/反馈层完成；自动学习未做 |

---

## 1. P1：群体记忆、成员记忆与话题状态（§5.1–§5.5）

### 1.1 为什么另开一个库

`plugins/companion-memory` 的 `memories` 表只有 `user_id` / `persona_id` / `world_id`
三个维度，**没有群**；而 `lib/policy.mjs` 的 `scopeMatches()` 对 `worldId === ''` 直接
`return true`。用 `world_id` 冒充群号，等于把私聊记忆判成"谁都能看"——这正是计划 §7.1
点名的串群事故。

所以群社交的数据落在**独立的库**：`<dataRoot>/home/group-memory/group-memory.db`。

### 1.2 结构隔离（而不是约定隔离）

| 表 | 关键约束 |
|---|---|
| `group_facts` | `group_id TEXT NOT NULL`；唯一键 `(group_id, dedupe_key)` |
| `member_facts` | `group_id TEXT NOT NULL` + `member_id TEXT NOT NULL`；唯一键 `(group_id, member_id, dedupe_key)` |
| `topic_state` | `group_id TEXT NOT NULL PRIMARY KEY`（SQLite 里裸 `TEXT PRIMARY KEY` 允许 NULL，所以必须显式写 NOT NULL） |

读路径只有一条 `WHERE group_id = ?`；**代码里不存在"不带群号就全查"的分支**。
删侧同样 fail-closed：`forgetGroup('')` 零删除。

> 成员维另有一条：只在调用方**点名的** `memberIds` 上查（`IN (...)` 有界 ≤20）。
> 不点名就返回空 + `dropped:['no-members']`，绝不扩大成"这个群的所有画像"。

### 1.3 写入与召回的口径

- **写入必须留来源**：`sourceMessageIds` 空/全垃圾 → 拒写（`reason:'no-source'`）。
  没有来源的记忆不可追溯，被人问"你从哪知道的"时只剩删库一条路。
- **去重合并只在同群同行内**：`dedupe_key = sha256(正文去空白标点 + 小写)`；
  命中时合并来源、`confidence` 取 max、`kind` 取更强（explicit > observed > guess）。
- **推测不是事实**：`guess` 带 `speculative:true`，排序永远在最后，limit 剪枝先剪它。
- **预算裁剪顺序**：先丢推测 → 再丢成员记忆 → 最后才动群体记忆。
  顺序反了会退化成"只记得陌生人"。
- **正文 ≤200 码点**，超了按码点截断并回 `reason:'truncated'`（不静默截断）。
- **话题 TTL** 默认 30 分钟，夹在 [60s, 6h]；过期返回 `null` 但**不删行**（诊断还能看）。

### 1.4 写入策略：宁可少记

`src/core/group-memory-extract.ts` 只抽**成员主动表达的第一人称属性/偏好**：

- 收：`我特别喜欢拍月亮`、`我在做后端`、`我养了只橘猫`
- 不收：提问/假设（`你会做饭吗`）、计划（`我明天要去爬山`）、当下判断（`我觉得这个镜头一般`）、
  带链接/@/CQ/长数字串、没有真实消息号、没有有效 QQ 号

当前实现**不产出 `guess`**：推断需要跨多轮总结，而误判代价是"一次玩笑被写成确定画像"
（§5.5 末条）。

### 1.5 适配层：存储是 TEXT，消费端是 number

存储侧 `group_id` / `member_id` / `source_message_ids` 都是 TEXT（19 位 QQ 号用整数有
溢出风险，用文本是对的）。跨插件边界时形状不可信 —— 实测过一次：消费端按 number 判，
会把每一条都当"没有群号"丢掉，表现为"记忆一直是空的"。

所以转换只在 `adapters/dsh-host/group-memory.ts` 一处发生，且`idOf()` 既认 number 也认
纯数字串，认不出来一律 0（= 不可用）。

### 1.6 P1 验收对照（§5.5）

| 验收项 | 证据 | 结论 |
|---|---|---|
| 群聊记忆按群隔离 | `group-memory.test.mjs` 跨群隔离用例（含前缀相似群号）+ 三张表 group_id NOT NULL（PRAGMA 检查） | 满足 |
| 成员可区分 | `member_facts` 的 `member_id` + 只查点名成员 + 归一化丢弃 `other-member` | 满足 |
| 关系可回溯 | 每条记录强制带 `sourceMessageIds`；无来源拒写 | 满足 |
| 不泄露私聊内容 | 独立库，与 `memories` 无任何关联；`companionGroupMemory` 只暴露群库 | 满足（结构性） |
| 简短且可解释 | 正文 ≤200 码点；提示词段有 800 字预算；`kind` 决定口吻 | 满足 |
| 不重复注入 | 同群同内容去重合并；同一批背景只判一次 | 满足 |
| 记忆服务不可用不影响群聊 | 端口缺失/库打不开 → `EMPTY_RECALL`，判断照常 | 满足 |

---

## 2. P2：社交决策器（§6.1–§6.6）

### 2.1 五动作与三档解析

```
silent   不发        observe  不发（保留关注）   reply  发（必须给目标消息号）
join     发（给话题）  react   发（可带目标号）
```

`parseSocialDecision` 返回**三档**判别联合，这个划分是整个 P2 的地基：

| 档 | 含义 | 记账 |
|---|---|---|
| `decision` | 解析出一个可执行动作 | 继续走校验 |
| `silent` | 模型正常回答"不说" | **成功**：只推进判断时刻 |
| `invalid` | 坏 JSON / 数组 / 未知动作 / 空正文 / 超长 / 带 @ 或 CQ | **失败**：累积，连坏几次暂停 |

把 `silent` 记成失败，会让"模型判断该沉默"变成"模型出错了"，连续几次就把群静音十分钟。

### 2.2 执行边界（§6.5 逐条）

1. `reply`/`react` 的目标必须在本轮**真实出现过**的消息号里 → 否则 `target-not-present:N`
2. 目标必须在 `replyWindowMs`（默认 10 分钟）内 → 否则 `target-too-old:N`
3. 正文非空、≤ `replyMaxChars`、不含 `@` 与 `[CQ:`（超长**不截断**，整条不发）
4. `join` 必须有话题名
5. 发之前再过一遍 `speakVerdict`（冷却 / 每小时额度）
6. **只有拿到 `message_id` 回执才算说过话**：失败只推进 `failures`，不重试、不连发
7. `reply` 用 `{type:'reply'}` 引用段；段里的 id 只填**已通过校验**的那个号

### 2.3 兼容旧输出

旧格式 `{"speak":true,"reply":"…","why":"…"}` 仍被接受并映射成 `reply`（无目标号时降级
`react`）。理由很实在：热重载期间新旧提示词可能同时在跑，解析器不认识旧格式就会把一次
正常判断记成失败。

### 2.4 P2 验收对照（§6.6）

| 验收项 | 证据 | 结论 |
|---|---|---|
| 不靠关键词 | 决策来自模型输出，提示词给的是判断口径（两人来回 / 问的是谁 / 有没有人答） | 满足（提示词侧） |
| 该沉默沉默 | 三档解析 + `silent` 与 `invalid` 分开；评测里 13 条沉默用例 | 满足（代码侧） |
| 能选动作 | 五动作联合类型，18 例解析单测 | 满足 |
| 不选错目标 | `target-not-present` / `target-too-old`，评测硬门槛 100% | 满足 |
| 无工具权限也不越界 | 自主发言走通道直发，不建会话、不给工具（§0.8） | 满足（结构性） |
| 假目标被拒绝 | 编造的号、超窗的号全部拦下（评测实测 reason 见 §5.3） | 满足 |

---

## 3. P3：事件时间线与调度（§7.1–§7.5）

### 3.1 统一事件模型

五种事件：`inbound_message` / `agent_reply` / `proactive_message` / `reaction` / `topic_change`。

- **双键去重**：平台消息按 `messageId`（NapCat 会重推、窗口会回显），合成事件按 `eventId`。
  `agent_reply` 与 `proactive_message` 同号**不合并**：一次被 @ 的回复和一次自主发言
  可能是同一个号的两面，合并会丢掉"这是主动说的"这条信息。
- **双上限裁剪**：条数（200）与时间窗（30 分钟），谁先到按谁裁。
- **不落盘**：重载即清，符合"重启不补发"。

### 3.2 话题识别（纯函数）

只做两件便宜事：显式句式（`说起来…` / `顺便问一句…` / `关于…` / `你们觉得…吗`）与
最近四条的重复词。识别不出返回 `null`——**绝不拿最后一条消息冒充话题**。

两处刻意的细节：
- 指示代词（那个/这个）**剥掉**而不是整条拒掉（群聊里大多数显式话题都以它起头）；
- 提问词（什么/怎么/为什么）起头说明这句本身没有指称对象，整条不要。

### 3.3 调度参数各管一件事（§7.3）

| 参数 | 默认 | 管什么 |
|---|---|---|
| `batchQuietMs` | 6 s | 合批等待：读得懂上下文 |
| `judgeIntervalMs` | 50 s | 两次判断的最小间隔：省钱 |
| `judgeMaxWaitMs` | 25 s | 只用于**饥饿告警**，不改变调度 |
| `speakMinIntervalMs` / `speakMaxPerHour` | 300 s / 3 | 发言冷却与额度 |

### 3.4 防饥饿（§7.4）

两件事保证"持续活跃的群不会无限期得不到判断"：

1. **已武装的定时器绝不重排** —— 重排会让热闹的群把窗口无限往后推，这正是老根因；
2. **饥饿告警**：一批消息等超 `judgeMaxWaitMs` 仍未判，就写一行日志并累加
   `starvationWarnings`，让"限频/暂停/失败退避导致的安静"与"群里没人说话"能分开。

`diagnostics()` 暴露每群的 `lastMessageAtMs / lastJudgeAtMs / batchStartedAtMs / batchCount /
lastJudgeDurationMs / judgments / spoken / skippedBy{Quota,Busy,Pause} / starvationWarnings`，
**不含正文**。

### 3.5 §7.2：自主发言进时间线，后续回合能看到

- 流程**拿到回执后**才写 `proactive_message`（放在外面记会变成"发之前就记上"，
  失败时留下假事件）。
- 时间线视图发布成 `companionGroupEvents`，供 `companion-group` 的
  `companion:group-continuity` 提示词段读取。
- 视图口径 **fail-closed**：那个段拿不到群号（宿主不把会话身份传给 `section` 回调），
  所以只在"唯一活跃群"时给数据；零个或多个群都返回空，消费方渲染成"还没有记录"。
  给错群的数据等于跨群复用梗（§8.4 明确禁止）。

### 3.6 P3 验收对照（§7.5）

| 验收项 | 证据 | 结论 |
|---|---|---|
| 自主发言进统一时间线 | `presence-flow` 拿到回执后 `recordEvent`；时间线去重用例 | 满足 |
| 后续回合能看到自己近期发言 | `eventsView().recentSelf` + 提示词段；`sentLinesOf` 优先读时间线 | 满足 |
| 不重复注入 | 双键去重 + "同一话题不重复记" | 满足 |
| 不饥饿 | 定时器不重排 + 饥饿告警 + 观测字段 | 满足（有告警，不是"不会饿"） |
| 耗时可观测 | `lastJudgeDurationMs` 等字段 | 满足 |
| 重启与热重载不补发 | `emptyPresenceState(now)` + 游标首见落在最新一条 | 满足 |

---

## 4. P4：表达习惯与群内文化（§8.1–§8.3）

### 4.1 表达约定（§8.1）——`companion:group-continuity`

一段人格中立的群聊行为约定 + 一段"这个群最近的记录"：

- 短句口语一到两句，不写小作文；不写旁白式开场（"我注意到你们在聊…"）
- 沉默是正常结果，不为了显得活跃而硬接
- 不重复自己刚说过的话
- 争执/隐私/钱/账号优先沉默
- 推测不许说成事实

整段 ≤400 字，超了从最老的一条丢；单条 80 字、话题 40 字、条数 ≤6。
段名 `companion:group-continuity`，`order 51`（紧跟人格段 50），`interpolate:false`
（段里含群友可能写出的原文，`{{…}}` 被当变量引用会严格抛错）。

### 4.2 表情包（§8.2）——只决定"要不要问图库"

`src/core/group-expression.ts` + `src/adapters/dsh-host/expression-service.ts` +
`src/features/inbound/presence-afterspeak.ts`。

**这一层不检索、不投递**：检索、授权、冷却、审核、stage 全在 `companion-expression`。
这里只回答"要不要去问"，然后按图库给的候选走它的 `reply`。

不该发的判据（每一条都对应一种翻车）：

| 判据 | 理由 |
|---|---|
| `action === 'reply'` | 在回答具体问题，配图常常答非所问 |
| 正文 >30 字且不是轻量反应 | 她在解释事情，图会把意思弄糊 |
| 带问号 / 建议 / 注意 / 报错 | 需要把话说明白 |
| 小时额度用尽 / 冷却中 | 图发多了是刷屏（额度**独立于文字**） |
| 没有话题且不是轻量反应 | 图库多半没有贴题的图，白花一次检索 |
| 图库没给候选 / 没回执 | 不做"随便挑一张"的兜底；没回执不算发过 |

配置（默认全关）：
`presence.stickers=false`、`stickerMinIntervalMs=600000`、`stickerMaxPerHour=1`。

### 4.3 弱反馈（§8.3）——只记事实

`src/core/group-feedback.ts`：她说完之后 90 秒内有没有人接、隔了多久、有没有人复读。

三条硬边界：
1. **只记事实，不记结论**：字段叫 `continued`，不叫"成功"；`summary` 里的比例叫
   `continuedRate`，不叫"满意度"（没人接可能只是话题过去了）；
2. **不改人格**：这个模块不写 `config/persona.md`、不写人格快照、不调模型；
3. **不改频率**：限频只由 `core/presence.ts` 决定，任何"没人理 → 多说点"的回路在设计上禁止。

当前实现**不把反馈接回提示词**，只作为诊断数据（内存，重启即清）。

### 4.4 P4 验收对照（§8.4）

| 验收项 | 证据 | 结论 |
|---|---|---|
| 能在合适语境下使用简短口语 | 系统提示词段（`GROUP_CHAT_CONDUCT`）+ 6 例单测 | 满足（提示词侧，无真机证据） |
| 不会为了活跃而重复刷屏 | 限频 + 复读判据（`overlaps`）+ 时间线防重复注入 | 满足（代码侧） |
| 表情包使用不突兀 | 6 条"不该发"判据 + 独立额度 | 满足（代码侧；真机未验） |
| 不会把某个群的梗带到其他群 | 记忆按群隔离 + 时间线视图 fail-closed（只给唯一活跃群） | 满足（结构性） |
| 反馈学习不改变核心人格 | `GroupFeedbackBook` 只写内存、不接回提示词 | 满足（结构性） |

---

## 5. QA：离线评测集（§9.1 / §9.2）

### 5.1 目录与运行

```
plugins/dsh-channel-qq/eval/group/
  corpus.mjs      41 条脱敏用例（G01–G41），十类场景各 ≥3
  adapter.mjs     **唯一**适配层：import 真实模块 + 形状转换 + 假件
  run.mjs         运行器：零网络零模型，退出码 0/1/2
  README.md       怎么跑、指标分子/分母、硬门槛、能力边界
  last-report.json  最近一次报告（gitignore）
```

```bash
cd plugins/dsh-channel-qq
npm run build:lib     # 首次（adapter 也可以直接跑 src/**.ts）
npm run eval:group
```

### 5.2 指标（实测）

| 指标 | 实测 | 门槛 |
|---|---|---|
| 错误目标拒绝率 | **100%** | 100% ✓ |
| 坏输出拦截率 | **100%** | 100% ✓ |
| 沉默正确率（隐私/争执，代码侧 7 条） | **100%** | 100% ✓ |
| 目标选择准确率 | 100% | — |
| 插话准确率 | 73.3%（发出 15 条） | — |
| 机会参与率 | 42.3%（26 条有机会；可执行口径 84.6%） | — |

计数：发出 15 · 沉默 13 · 被代码拦下 13 · 无回执 1 · 真实模型调用 0 · 真实网络请求 0。
解析分档：`decision` 23 / `silent` 11 / `invalid` 7（沉默与坏输出分开统计）。

### 5.3 硬门槛实测理由（可直接复现）

- 编造目标：`target-not-present:999`、`target-not-present:424242`
- 超窗目标：`target-too-old:521`、`target-too-old:921`
- 坏输出：`text-too-long:105>70`、数组、缺逗号、`speak:"true"`、带 @、带 `[CQ:`
- 限频：`hour-quota` 与 `speak-cooldown` 都真的触发（语料用 `expect.veto` 钉住
  "必须被哪一条挡下"；被别的闸门挡住也算 FAIL）

### 5.4 4 条 WARN = 已知缺口（代码侧不判语义）

| 用例 | 情形 | 为什么代码拦不住 |
|---|---|---|
| G06 | 两人一来一回开黑，她插了"你们打什么 我也想玩" | 判断"这是不是私聊式来回"需要读语义 |
| G10 | 问的是具体某人、且已有人答，她抢答了 | 同上 |
| G30 | 她复读了自己半小时前说过的话 | 复读判据在提示词侧；代码只判长度/@/目标 |
| G41 | 争执里她劝了"都少说两句吧" | "连劝架都不掺"只有提示词能兜 |

这四条单列进报告的 `gaps`，**不计入硬门槛，也不当作已验证**。

### 5.5 证据级别的诚实说明

评测只提供 **offline-test** 级证据：验证的是代码侧判定与执行边界（形状、目标、长度、
时间窗、限频）。它不构成 real-api / real-send 任何证据，也不证明"线上说话得体"。
G11/G18/G36–G40 那几个隐私用例之所以绿，是因为**语料里的模型输出先说 silent**；
代码是最后一道闸，不是第一道闸。

---

## 6. 接口变化汇总（对既有使用方）

### 6.1 新增跨插件服务

| 服务名 | 提供方 | 消费方 | 形状 |
|---|---|---|---|
| `companionGroupPersona` | foundation（P0） | dsh-channel-qq | `{ get(): GroupPersonaSnapshot \| null }` |
| `companionGroupMemory` | foundation（P1） | dsh-channel-qq | `{ query, status, writeGroupFact, writeMemberFact, upsertTopic, topicState, forgetGroup }` |
| `companionGroupEvents` | dsh-channel-qq（P3） | companion-group | `{ recentSelf(limit), topic(), detail() }` |

三个都是**可选端口**：拿不到就降级（人格 → 降级提示；记忆 → 空召回；事件 → "还没有记录"）。

### 6.2 配置新增（全部有默认值 + 中文 help，向后兼容）

| 字段 | 默认 | 热生效 | 影响 |
|---|---|---|---|
| `presence.batchQuietMs` | 6000 | live | 合批等待；改小更贴上下文、更贵 |
| `presence.judgeMaxWaitMs` | 25000 | live | 饥饿告警阈值（不影响调度） |
| `presence.replyWindowMs` | 600000 | live | reply 允许引用的时间窗 |
| `presence.memoryBudgetChars` | 800 | live | 记忆注入预算 |
| `presence.stickers` | false | live | 是否允许配表情包 |
| `presence.stickerMinIntervalMs` | 600000 | live | 两张图最小间隔 |
| `presence.stickerMaxPerHour` | 1 | live | 每小时最多几张图 |

### 6.3 代码结构调整（`presence-runtime.ts` 拆分）

原 656 行（超 `check:size` 硬上限 400）按**生命周期**拆开，而不是按行数切：

| 文件 | 职责 | 行数 |
|---|---|---|
| `presence-runtime.ts` | 常驻状态：游标 / 定时器 / 限频 / 卸载 | 288 |
| `presence-cycle.ts` | 一次判断的编排 | 235 |
| `presence-timeline.ts` | 时间线簿记 | 157 |
| `presence-scheduler.ts` | 调度观测簿记 | 102 |

`presence-wiring.ts` 的 `wirePresence`（106 行函数）同样拆成 `personaReader` /
`memoryRecall` / `publishEvents` / `afterSpeakHandler`。

---

## 7. 改动文件清单（按阶段）

### P1
- 新增：`companion-foundation/group-memory.mjs`（890）、`group-memory.test.mjs`、
  `companion-foundation/port-publish.mjs`、
  `dsh-channel-qq/src/app/inbound/group-memory-contract.ts`、
  `src/adapters/dsh-host/group-memory.ts`、`src/core/group-memory-extract.ts`、
  `test/group-memory-extract.test.ts`
- 修改：`companion-foundation/index.mjs`、`companion-foundation/service-bridge.mjs`

### P2
- 新增：`src/app/inbound/group-social-decision.ts`、`group-social-prompt.ts`、
  `test/group-social-decision.test.ts`
- 修改：`presence-flow.ts`、`presence-judge.ts`、`config/sections/presence.ts`、
  `test/presence-config.test.ts`、两份 config 黄金快照

### P3
- 新增：`src/core/group-events.ts`、`src/core/group-topic.ts`、
  `src/app/inbound/presence-timeline.ts`、`presence-scheduler.ts`、`presence-cycle.ts`、
  `src/adapters/dsh-host/group-events.ts`、`service-registry.ts`、
  `test/group-events-memory.test.ts`、`test/group-topic.test.ts`
- 修改：`presence-runtime.ts`、`presence-wiring.ts`

### QA + P4
- 新增：`companion-group/group-continuity.mjs`、`group-continuity.test.mjs`、
  `dsh-channel-qq/eval/group/*`（6 个文件）、
  `src/core/group-expression.ts`、`src/core/group-feedback.ts`、
  `src/adapters/dsh-host/expression-service.ts`、
  `src/features/inbound/presence-afterspeak.ts`、
  `test/group-expression-feedback.test.ts`
- 修改：`companion-group/index.mjs`、`companion-group/package.json`、
  `dsh-channel-qq/package.json`（`eval:group` 脚本）

---

## 8. 验证结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 通道单测 | `cd plugins/dsh-channel-qq && npm test` | 1495 tests / 1494 pass / **0 fail** |
| 分层 | `npm run check:layers` | 通过（457 个源文件） |
| 体积棘轮 | `npm run check:size` | 通过（无文件或函数超基线） |
| 离线评测 | `npm run eval:group` | PASS 37 / FAIL 0 / WARN 4 / 41，exit 0 |
| foundation 单测 | `npm test -w @dsh-companion/foundation` | 251 / 242 pass / 0 fail |
| 群插件单测 | `cd plugins/companion-group && npm test` | 18 / 18 pass |
| 仓库级 | `npm run verify` | unit 9 / static 32 / compose 1 全绿，exit 0 |

> 连跑三次单测与两次 `verify` 均稳定；期间观察到**一次** `unit 7/9` 的瞬时失败，
> 重跑即恢复（当时有队友在并发改同一批文件）。这里如实记录，不掩盖。

---

## 9. 未解决问题 / 明确留给后续

1. **代码侧不判语义**（4 条 WARN 背后的同一件事）：两人私聊式来回、抢答、复读自己、
   争执中劝架——这四类只有提示词在管。要真正解决需要模型侧或更强的信号（例如"上一条
   消息是否在回应某人"的结构判定），属于新设计。
2. **不产出 `guess` 记忆**：跨多轮总结的推断尚未实现，误判代价太高。
3. **记忆写入是同步 sqlite 调用**（判断结束后同 tick），量大时需改到后台队列。
4. **话题识别是词面的**，不做语义理解；识别不出是常态（返回 `null`）。
5. **表情包真机未验**：`companion-expression` 的 `delivery.enabled` 默认 false，
   且需要图库已授权。测试只覆盖"要不要问"这一层；真实投递没有 real-send 证据。
6. **弱反馈未接回提示词**：目前只作为诊断数据，是否、以及如何回灌需要单独评审
   （任何"提高发言率"的回路都在 §8.4 禁止）。
7. **观测未接后台页面**：`diagnostics()` 已就绪，Web UI 展示属于后续工作。
8. **调度与真机节奏未验**：评测不覆盖 `presence-runtime` 的定时器（判断频率），
   真实群的 6 秒合批 / 50 秒间隔需要在灰度里观察。

---

## 10. 回滚方式（分层，任一层都能单独退）

| 层级 | 操作 | 效果 |
|---|---|---|
| 1. 关开关 | `presence.enabled=false` | 不记旁听、不判断、不写记忆、不发消息，回到 P0 之前的群聊行为 |
| 2. 只停发言 | `speakMaxPerHour=0` | 仍然判断、仍然记记忆，但一句都不发 |
| 3. 关表情 | `presence.stickers=false`（默认就是关） | 只发文字 |
| 4. 关记忆 | 注释掉 foundation 的 `companionGroupMemory` 发布 | 消费端降级成空召回，群聊照常 |
| 5. 关事件服务 | 注释掉 `presence-wiring` 的 `publishEvents` | 提示词段降级成"还没有记录" |
| 6. 退代码 | 按阶段 `git revert` | 每个提交都独立可退；新增配置字段退化成未知键（不报错、不进默认值） |
| 7. 删数据 | 删 `<dataRoot>/home/group-memory/group-memory.db` | 独立的库，主记忆库不受影响 |

---

## 11. 一个可复现的实证（跨插件服务三路解析）

在仓库根跑（Node 24，ESM）：

```js
const { publishCompanionService, resolveCompanionService } = await import('./plugins/companion-foundation/port-publish.mjs')
const root = 'D:\\Bot\\DSH-dev\\data'
const port = { query: () => 'group-memory', status: () => 'ok' }
const release = publishCompanionService({ root, name: 'companionGroupMemory', service: port })
// 模拟 companion-health 后挂载、覆盖裸键：
const registry = process[Symbol.for('dsh.companion.ports.v1')]
registry.set(root, { service: { health: true }, ready: () => true })
console.log(resolveCompanionService({ name: 'companionGroupMemory', root }) === port) // true
release()
```

结论：即使裸 `dataRoot` 键被别的服务占用，复合键 `companionGroupMemory\u0000<root>` 仍然
解析到正确的服务——这就是 P1 里"复合键优先"的实证。
