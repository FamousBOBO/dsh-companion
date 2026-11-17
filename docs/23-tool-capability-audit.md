# 22 · 工具能力、权限与可见性审计（任务包 C）

- 生成日期：2026-11-14（北京时间）
- 执行人：teammate `tool-audit`（C 包 + D 包的离线诊断部分）
- 审计脚本：[tools/tool-audit.mjs](../tools/tool-audit.mjs)（`node tools/tool-audit.mjs`，`--json` 输出机器可读版）
- 正文诊断模块：[plugins/companion-foundation/output-diagnosis.mjs](../plugins/companion-foundation/output-diagnosis.mjs) + [output-diagnosis.test.mjs](../plugins/companion-foundation/output-diagnosis.test.mjs)
- **证据等级：E2**（合成挂载 + 纯函数/模块测试）。E3/E4/E5 未执行，原因见 §7。

> 本文的每个数字都是**这次跑出来的**，不是引用的旧基线。旧抓包的 5,881 字符 / 46 工具 / 26,621 字符在
> `docs/09-prompt-baseline.md`，本轮口径不同（当前是 42 个工具 / 17,835 字符），不要混用。

---

## 0. 口径与不可用指标

| 项 | 值 | 说明 |
|---|---|---|
| 工具数量 | **42**（read 22 / write 20） | 真实挂载 `mountCompanion` 收集 `ctx.tools.register` |
| Schema 字符 | **4,955** | `JSON.stringify(parameters).length` |
| 描述字符 | **12,880** | `tool.description.length` |
| 合计字符 | **17,835** | schema + description |
| **Token 数** | **unavailable** | 宿主没有给本次审计可用的 token 计数器。**字符数不是 Token 数**，两者不能互相换算成结论 |
| QQ 侧 schema 字符 | **unavailable** | 需构建 channel-qq 的运行实例；本次只按源码数名字 |
| provider usage / TTFT | unavailable | 本次审计零模型调用 |
| 合成数据根 | `os.tmpdir()` | 不读 `data/`，不读真实 DB / 记忆 / 聊天 |

`moduleRoot` 来源：`fixtures`（仓库内 `plugins/companion-foundation/test-fixtures/module-root/`）。
它只有两个最小替身（`defineTool` 与 `dsh-llm`），所以"宿主支不支持按轮过滤"这件事**不能**用它回答 ——
脚本会另外找一个真实安装在只读调查（本次找到的是本机 npx 缓存里的 `@deepseek-ai/dsh-tools`）。

---

## 1. 工具矩阵（每行：名字 / owner / 副作用 / 作用域 / Schema 字符）

副作用档位来自 `register(name, description, parameters, execute, kind)` 的 `kind`（默认 `'read'`，写操作显式传 `'write'`），
`kind` 又通过 `presentCall()` 的 `card.kind` 暴露出来 —— 脚本就是读它，不靠猜。

owner = 哪个文件里的 `register`/`define` 调用；行号是脚本**现算**的（`index.mjs` 由集成负责人改动，写死的行号会变成假证据）。
作用域对所有工具都一样：`register()` 包装器固定调用 `identity.resolve(exec.agent?.session?.id)`，
解析不到就抛错，所以 scope 只有"当前会话绑定的本地主人"一种。

| # | 工具 | kind | owner（注册点） | 作用域 | schema | desc | 参数 |
|---|---|---|---|---|---|---|---|
| 1 | companion_belief_assert | write | index.mjs | owner session | 131 | 231 | proposition, evidenceQuote, validUntil |
| 2 | companion_belief_correct | write | index.mjs | owner session | 198 | 228 | beliefId, replacement, evidenceQuote, expectedRevision |
| 3 | companion_belief_list | read | index.mjs | owner session | 2 | 197 | —（13 个无参工具之一） |
| 4 | companion_commitment_add | write | index.mjs | owner session | 69 | 201 | text, dueAt |
| 5 | companion_goal_list | read | index.mjs | owner session | 63 | 177 | includeClosed, limit |
| 6 | companion_goal_propose | write | index.mjs | owner session | 310 | 279 | title, source, authorization, deadlineAt, nextStep, waitingOn, rootEvidenceIds |
| 7 | companion_goal_resume | write | index.mjs | owner session | 82 | 169 | goalId, expectedRevision |
| 8 | companion_goal_switch | write | index.mjs | owner session | 98 | 231 | goalId, expectedRevision |
| 9 | companion_goal_transition | write | index.mjs | owner session | 305 | 233 | goalId, to, expectedRevision, step, nextStep, waitingOn, reason |
| 10 | companion_health_sleep | read | health-tools.mjs | owner session | 355 | 592 | date, days, includeStages |
| 11 | companion_health_sources | read | health-tools.mjs | owner session | 2 | 454 | — |
| 12 | companion_health_status | read | health-tools.mjs | owner session | 2 | 598 | — |
| 13 | companion_health_today | read | health-tools.mjs | owner session | 100 | 610 | date |
| 14 | companion_health_trend | read | health-tools.mjs | owner session | 334 | 447 | metric, days |
| 15 | companion_heartbeat_pause | write | index.mjs | owner session | 28 | 232 | reason |
| 16 | companion_heartbeat_resume | write | index.mjs | owner session | 2 | 139 | — |
| 17 | companion_heartbeat_status | read | index.mjs | owner session | 2 | 283 | — |
| 18 | companion_identity | read | index.mjs | owner session | 2 | 190 | — |
| 19 | companion_life_status | read | index.mjs | owner session | 2 | 597 | — |
| 20 | companion_memory_extract | write | index.mjs | owner session | 2 | 145 | — |
| 21 | companion_memory_forget | write | index.mjs | owner session | 67 | 121 | id, reason |
| 22 | companion_memory_pending | read | index.mjs | owner session | 28 | 112 | limit |
| 23 | companion_memory_rebuild | write | index.mjs | owner session | 2 | 114 | — |
| 24 | companion_outfit_set | write | index.mjs | owner session | 230 | 531 | itemIds, instruction, context, until, clearOverride |
| 25 | companion_plan_today | write | index.mjs | owner session | 55 | 317 | force, reason |
| 26 | companion_pulse | read | pulse-tools.mjs | owner session | 306 | **1,215** | action, minutes, label |
| 27 | companion_recall | read | index.mjs | owner session | 54 | 261 | query, limit |
| 28 | companion_recent_events | read | index.mjs | owner session | 28 | 51 | limit |
| 29 | companion_record_event | write | index.mjs | owner session | 129 | 107 | source, text |
| 30 | companion_remember | write | index.mjs | owner session | 114 | 306 | key, value, occurredAt |
| 31 | companion_runtime_status | read | index.mjs | owner session | 2 | 405 | — |
| 32 | companion_schedule_cancel | write | index.mjs | owner session | 125 | 200 | itemId, expectedRevision, reason |
| 33 | companion_schedule_create | write | index.mjs | owner session | **577** | 343 | title, rule, timeZone, date, time, weekdays, validFrom, validUntil, category, authorization, goalRef, commitmentRef, requestKey |
| 34 | companion_schedule_list | read | index.mjs | owner session | 105 | 230 | from, to, status, limit |
| 35 | companion_schedule_today | read | index.mjs | owner session | 26 | 282 | date |
| 36 | companion_schedule_update | write | index.mjs | owner session | **628** | 383 | itemId, expectedRevision, previewToken, title, rule, timeZone, date, time, weekdays, validFrom, validUntil, category, authorization, goalRef, commitmentRef |
| 37 | companion_share_activity | write | index.mjs（`register(SHARE_TOOL_NAME)`） | owner session | 115 | 351 | activityId, title, body |
| 38 | companion_status | read | index.mjs | owner session | 2 | 105 | — |
| 39 | companion_visual_state | read | index.mjs | owner session | 2 | 327 | — |
| 40 | companion_wardrobe_detail | read | index.mjs | owner session | 224 | 600 | scope, slot, context |
| 41 | companion_wiki_get | read | index.mjs | owner session | 45 | 122 | topicId |
| 42 | companion_wiki_index | read | index.mjs | owner session | 2 | 164 | — |

**最重的五个**（schema + desc）：`companion_pulse` 1,521（其中描述 1,215）、`companion_schedule_update` 1,011、
`companion_health_sleep` 947、`companion_schedule_create` 920、`companion_wardrobe_detail` 824。

**13 个零参数工具**（schema 只有 `{}` 的 2 个字符）：belief_list、health_sources、health_status、
heartbeat_resume、heartbeat_status、identity、life_status、memory_extract、memory_rebuild、runtime_status、
status、visual_state、wiki_index。它们不是"没写 schema"，是**真的没有参数**；体积几乎全在描述里。

**返回形状**：所有工具 `output.schema` 是 `string`，`render` 产出单个 `text` block，`execute` 把结果
`JSON.stringify()` 后返回。所以模型读到的是**字符串化的 JSON**，不是结构化对象 —— 这对"上一步结果能不能拿来当下一步参数"有直接影响（§3）。

### 1.1 不在 foundation 里注册、但模型看得见的工具族（只读源码事实，未构建运行实例）

| 族 | 名字数 | 注册点 | 证据 |
|---|---|---|---|
| channel-qq / qq-tools（`tools.v2` 关） | **59**（其中 57 个 `qq_*`，另有 `retrieve_knowledge` / `extract_knowledge` 两个知识库工具） | 宿主 `ctx.tools.register`（**全局层**） | `plugins/dsh-channel-qq/src/features/qq-tools/register.ts`（`REGISTRATION_ORDER` + `registerQQTools`） |
| channel-qq / `tools.v2` 开 | **17** 合并工具（qq_message / qq_lookup / qq_group_admin / qq_group_file / qq_file / qq_sticker / qq_voice / qq_music / qq_link / qq_image / qq_quote / qq_remind / qq_rss / qq_memory / qq_learn / qq_flood / qq_affection） | `features/tools-v2/surface.ts`（`registerMergedSurface`） | 旧 spec 全部被收编、不上宿主 |
| companion-media（随 `modules.media`） | 5 | `plugins/companion-media/index.mjs` | status / visual / draw / speak / job |
| companion-expression（随 `modules.expression`） | 5 | `plugins/companion-expression/src/tools.mjs`（`TOOL_NAMES`） | candidates / reply / feedback / library_stats / sticker_note |

`59` 与 `17` 是**互斥的两套面**：`tools.v2` 关着时是 59 个旧 spec，开了就是 17 个合并工具，不会同时上宿主。
这两个数字（以及群聊白名单的 11 个名字）都是脚本从源码**现数**的，不是抄注释。

---

## 2. 四上下文对比：注册 / 可见 / 可执行 / 可消费

| 上下文 | 注册 | 模型可见 | 允许执行 | 返回可消费 |
|---|---|---|---|---|
| **桌面**（companion 预设挂 foundation） | 是：42 个 | 是（含 20 个写工具） | 是：全部 42 个（scope 解析成功时） | 是：JSON 字符串 → 单个 text block |
| **QQ 私聊**（`qq-dm-<ownerId>`，preset=companion） | 是：foundation 42 + channel-qq 全局面（59 或 17） | 是（未被 restrict 掉的部分） | 是：`identity.resolve` 只对 owner 私聊放行 | 是（qq_* 也做了 lossless 化） |
| **QQ 群聊**（`qq-group-<群号>`，preset=companion-group） | 部分：全局层在册，但被 `tools.restrict({allow})` 裁到 **11 个名字** | **仅白名单**（foundation 的状态/日程/分享/记忆工具全部消失） | 仅白名单 + `groupToolDenial` 二次裁决 | 是（白名单内） |
| **后台活动**（P2 activity executor） | 不适用（不是 agent step） | **否**：请求里没有 `tools` 字段 | 否：没有 tool-call 通道 | 否：返回值只给 runtime 校验器 |

逐条带证据：

**桌面**
- 注册：预设只挂 foundation 一行（`config/profile/companion.patch.template.yml` 第 2 节的 `preset-companion`），
  因此"人格 → 记忆 → 运行时"的工具面只进模型一次。
- 可执行 / 可消费：`register()` 包装器（脚本现算在 `index.mjs:626` 附近）固定 `identity.resolve(...)`，
  `execute` 行（现算 `index.mjs:629`）把结果 `JSON.stringify`。

**QQ 私聊**
- 注册：`channel-qq` 用宿主 `ctx.tools.register(...)`，是**全局层**注册（`adapters/dsh-host/tools.ts` 的 `registerSpecs`），
  所以任何 agent 作用域默认都看得见，除非被 restrict。
- 可见：模板把私聊 `agentPreset` 设成 `companion`，与桌面同一份工具面。
- 可执行：`identity.mjs` 里那句 `if (sessionId.startsWith('qq-') && sessionId !== 'qq-dm-<ownerId>') throw`
  就是私聊与非私聊的分界；`qq-dm-<ownerId>` 放行。
- 阻断点：如果部署把 `agentPreset` 换成别的预设（模板默认值可被用户层覆盖），foundation 工具面在这个会话里就不存在了。
  另外 `policy.v2` / 出站边界会在执行层再拒一次**发送类**动作，只读工具不受影响。

**QQ 群聊**
- 注册：全局层仍在册（`qq_*` 与 foundation 都是全局注册），但群 preset 在 `agent/pre-step` 里执行
  `ctx.tools.restrict({ allow: GROUP_ALLOWED_TOOLS.filter(名字确实可限制的) })`。
- 白名单 11 个名字（`GROUP_ALLOWED_TOOLS`）：`qq_message` / `qq_sticker` / `qq_voice` +
  4 个 `companion_media_*`（status / draw / speak / job）+ 4 个 `expression_*`（candidates / reply / feedback / sticker_note）。
  注意 `companion_media_visual` **不在**白名单里（群聊不该读私聊衣柜），`companion_media_warm` 也刻意不放。
- 可见：非白名单工具从模型描述里消失 —— 包括**全部** `companion_life_status`、`companion_schedule_*`、
  `companion_share_activity`、全部记忆与日程工具。所以"群里问你现在在干什么"在这条路径上**没有工具可调**。
- 可执行：白名单内还要过 `groupToolDenial`（单调 guard）：只认当前群号、`isGroup=true`、
  `action` 必须是 `send` / `send_image` / `send_file`；参数键必须在白名单里；表情包工具里任何 `file`/`path`/`url`/`dir`/`root` 键一律拒。
  未知工具默认拒绝（fail-closed）。
- **关键的复合阻断**：foundation 的 `register()` 包装器固定调 `identity.resolve`，而它对 `qq-group-*` 直接抛错。
  所以**就算**把某个 foundation 工具塞进群白名单，执行也会失败 —— 群聊要用状态/日程，必须另开一个不经过
  `identity.resolve` 的通道（这是接线层的改动，属于集成负责人）。
- 另两条：`@` 之外的回合在 `step > 1` 且本回合未投递时被 pre-step 拒绝（群聊不续步）；
  群 preset 断言宿主必须有 `tools.restrict` / `tools.guard`，缺一个就挂不上。

**后台活动（P2）**
- 不是 agent 步骤：`callModel({ purpose, system, input, maxTokens })` 转发到 `createHostLlmAdapter`，
  请求 options 只有 `messages / system / purpose / signal / sessionId` —— **没有 `tools` 字段**。
- 因此"后台模型不调工具"不是模型选择问题，是**没有工具面**。P2 每一步的完成判据是正文/收据
  （`applyModelProgress` 的 `modelReceipt`），write 任务还要模型自己吐 `{"text":…,"done":true}`。
- `finish_reason=stop` 不算"写完"（`p2.mjs` 的注释明写），这是设计而不是缺陷。

---

## 3. 关键场景能力链（含"参数能不能从上一步结果取到"）

| 场景 | 完整链 | 结论 |
|---|---|---|
| 问"你现在在干什么" | 系统段 `companion:life` → `companion_life_status`（只读）→ `cognitive.p2Status({sessionId})` → planning/activities/budget/reading | 桌面与私聊可走通（前提 runtime 挂上且 scope 解析成功）；**群聊断在可见层** |
| 看今天/明天的安排 | `companion_schedule_today`（只读）→ `cognitive.todaySchedule` → agenda 端口（`reminderDelivery` 恒为 `not-wired`） | 桌面/私聊可读；群聊不可见；"已设置提醒"这句在代码上永远不成立 —— 本模块从不投递提醒 |
| 建/改日程 | `companion_schedule_create`（写）→ 必须自带 `title` + `rule` + `timeZone`（`once` 还要 `date`+`time`）→ 返回 revision；改/删需要 `itemId` + `expectedRevision` | **参数能取到的**：`timeZone`、`itemId`、`expectedRevision`（都来自 `schedule_list`/`schedule_today` 的回执）。**取不到的**：`title`、`date`、`time` —— 必须来自用户原话。这是"连续步骤"的真实断点，不是模型不努力 |
| B站看完后分享 | provider ready → round → 证据（`evidenceOf`：watch 需合法 BV 号 + `consumedSeconds > 0`）→ settle 活动 → `companion_share_activity`（写）→ `createShareCandidate` → contact 闸门 | 模型侧只有**一个**入口，且默认 `share-disabled`；证据读取路径在 runtime 的 `bilibili-rounds` 里，**模型拿不到**（群聊/后台也都不可见）。要么打开开关，要么补事件驱动生产 |
| "刚才做了什么"是计划还是执行 | `companion_life_status` 的 activities（`status` / `reality` / `consumed`） | 可读，但 `reality=simulated_world / hypothetical` 的活动和真活动在同一个列表里，模型必须自己区分；分享工具会把 simulated 拒掉（`simulated-not-shared`） |

**描述是否明确**（C-3 的逐项核对）：

| 工具 | 描述明确吗 | 参数是否可从上一结果取得 |
|---|---|---|
| `companion_life_status` | 明确：写明"只读、不建计划、不启活动、不发东西"，并区分 plan / activity / budget | 无参数，零门槛 |
| `companion_schedule_today` | 明确：说明"按各日程自己的时区、跨午夜安全"，且关了会说 `enabled:false, state:disabled` | 无参数（可选 `date`） |
| `companion_schedule_list` | 明确：只读、无发送、无模型调用；回执里带 `reminderDelivery`（恒 not-wired） | 提供 update/cancel 需要的 `itemId` / `expectedRevision` / `timeZone` |
| `companion_schedule_create` | 明确但**要求高**：13 个参数，`title`/`rule`/`timeZone` 都必填 | `timeZone` 可从 list 取；`title`/`date`/`time` **不能** |
| `companion_schedule_update` | 明确但**最重**（628 字符 schema）：乐观并发 + `preview-required` 两段式 | `itemId`/`expectedRevision` 从 list 取；`previewToken` 只能来自上一次 update 的返回 ⇒ 必须真的两轮 |
| `companion_share_activity` | 明确：写明"从不发送、只写候选，闸门在 contact"；三种拒绝原因都说了 | `activityId` **取不到**（没有工具能列出 activityId）；`title` 要模型自拟；`body` 可选。**这是最硬的断点**：模型得先有一个 activityId 才能调，而没有任何工具给它 |
| B站证据读取路径 | **不存在模型可用的读取工具**：`bilibili-rounds` 只在 runtime 内部被 `p2.mjs` 调用，`companion_life_status` 只透出 `p2Status` 的计数，不透出 `evidenceOf` 的 BV 号与 `consumedSeconds` | — |

`companion_share_activity` 缺 `activityId` 这一条值得单独记：`companion_life_status` 返回的 `p2Status` 里
`runningActivities` 带 `activity_id`（runtime 的 SQL 里就是这个名字），但**字段名大小写与嵌套层级都没有在描述里承诺**，
而 `companion_share_activity` 要求 `activityId`。所以"上一步结果 → 下一步参数"这条链在**命名**这一层就已经不闭合。
这是可以低成本修的（描述里点名"从 companion_life_status 的 runningActivities[].activity_id 取"），但属于 C 包**审计结论**，
本次不改注册（计划 §5-C 明写"第一批不改动态工具注册"）。

---

## 4. 宿主能力只读调查（按轮过滤 / 恢复 / 增删声明 / 执行层权限）

宿主包：`@deepseek-ai/dsh-tools`（本次在 npx 缓存里找到真实安装；`moduleRoot` 的 fixtures 只有 8 行替身，不能用来回答这个问题）。
行号由脚本现算，下表是本次运行结果。

| 能力 | 结论 | 机制 | 证据（文件:行 / 函数） |
|---|---|---|---|
| **按轮（每 step）工具过滤** | **支持** | `register(definition, { when })`：条件在**每个模型步骤**准备时求值一次，收到 `{ agent, modelSelection, signal }`；`false` ⇒ 该工具既不出现在描述/PTC 绑定里，也不能执行。抛错 ⇒ `TOOL_ACTIVATION_FAILED`，**步骤准备失败**（不等于"工具不可用"） | `lib/types/contracts.d.ts:118` `ToolRegistrationOptions.when`；`README.md:69` |
| **按步准入（resolve）** | **支持** | `ctx.tools.resolve({agent, modelSelection, signal})` 返回该步骤独占的 `ResolvedToolSet`，交给 prompt assembly 与该 step 的 execute 批次；批次结算后 dispose，重试复用同一集合；没有集合时条件工具的调用返回 `UNKNOWN_TOOL` | `lib/types/index.d.ts:95` `ToolsService.resolve`；`lib/types/contracts.d.ts:121` `ResolvedToolSet`；`README.md:71` |
| **裁剪后的恢复** | **支持（靠 disposer）** | `restrict(filter)` 返回**精确的 disposer**：dispose 即撤销这一次限制。恢复粒度是**作用域**（agent/preset），不是回合 | `lib/types/index.d.ts:58` `ToolsService.restrict`；`README.md:88` |
| **工具增删声明** | **支持（宿主自动，插件不写）** | 请求头里工具集合变化时，agent-loop 自己发一条 `developer/message` 声明新增/移除，独立于模型能力；插件只要让注册面变化 | `@deepseek-ai/dsh-agent-loop/README.md:156`；`lib/types/events.d.ts:55` `tools/change` |
| **执行层权限** | **支持（三层）** | `tools/pre-execute` 瀑布（`allow`/`deny`/`cancel`/`ask`）→ 注册的单调 `guard`（返回原因即拒，后加监听器无法翻案）→ 审批服务（`allowed-once` 才放行） | `lib/types/events.d.ts:17`；`lib/types/contracts.d.ts:321` `PreToolDecision`；`lib/types/index.d.ts:136` `ToolsService.guard`；`lib/types/contracts.d.ts:374` `ToolGuard` |

仓库内的真实用例（作为"宿主能力真的能用"的旁证，不是宿主证据）：
`plugins/companion-group/boundary.mjs` 用 `ctx.tools.guard(exec => groupToolDenial(...))`；
`plugins/companion-group/index.mjs` 用 `ctx.tools.restrict({ allow: ... })`；
`plugins/dsh-channel-qq/src/adapters/dsh-host/tools.ts` 把 `policy.v2` 挂成 `tools/pre-execute` / `tools/post-execute`。

**结论（C-4 的一句话版）**：动态裁剪**可以做**，但要分清三种粒度：
1. **每 step**：`when`（注册期给条件，无条件数计数）；
2. **每作用域**：`restrict` + disposer（可恢复，群聊用的就是这个）；
3. **每请求声明**：宿主自己写 `developer/message`，插件不该手写。

**代价**：每轮 schema 变化会打掉**前缀缓存**（`README` 的缓存段：工具集合一变，从第一个变化的 token 起失效）。
所以"每轮按需裁工具"省 token 的同时会损失缓存命中；这条不是缺陷，是要算进预算的账。

**明确不支持的**：
- 按"轮次序号"过滤 —— `when` 只给 `agent` / `modelSelection` / `signal`，没有 `turn` / `step` 计数；
- 策略热加载 —— `when` 的闭包在注册时固定，改判定条件必须重挂插件；
- 让 `guard` "放行" —— `ToolGuard` 只有"返回原因（拒）"或 `undefined`（不表态），设计上只能收窄。

---

## 5. "模型不调用工具"的归因分类（每类都要有可验证特征）

**不能只凭调用次数归因。** 下面六类互斥且各有判据；顺序按"从最上游到最下游"，先排除上面的再说下面的。

| 类别 | 可验证特征 | 判别方法 | 证据 |
|---|---|---|---|
| **1. 不可见**（从没进过工具面） | 该会话作用域下 `tools.schemas(scope)` / 请求头 `header.tools` 里没有这个名字 | 全局 `tools.get(name)` 有值、会话内没有 ⇒ 作用域裁剪（restrict / preset 未挂）；两者都没有 ⇒ 根本没注册 | `plugins/dsh-channel-qq/src/adapters/dsh-host/tool-visibility.ts`（本仓库自己的三态探针把这三层分开答） |
| **2. 描述不清** | 工具可见、被调用过，但参数校验失败率高；错误码是**参数类**而不是**授权类**；或参数取值来自"上一步结果里根本没有的字段" | 看 `tool/result` 的 `error.code` 分布 + 参数名是否出现在相邻上一步的返回结构里 | `companion_schedule_create`：`title`/`rule`/`timeZone` 三项必填且工具结果里没有 |
| **3. 路由错误** | 同一意图反复调用只读工具而不进入写工具；或调了名字相近但语义不同的工具 | 按 intent→tool 期望表比对**调用序列**，不是数量 | `companion_life_status`（只读）vs `companion_plan_today`（写，且内部一次计费模型调用） |
| **4. 状态缺失**（工具在，但答案是"关着"） | 工具执行了，返回具名码：`runtime-not-mounted` / `share-disabled` / `activities-disabled` / `agenda-disabled` / `health-not-mounted` / `pulse-denied` 等 | 看回执里的 `code` 分布；这是**能力关闭**，不是模型没调 | `index.mjs` 的 `runtime-not-mounted`；`share-producer.mjs` 的 `share-disabled`；`health-tools.mjs` 的 `health-not-mounted` |
| **5. 模型选择**（模型就是不调） | 工具可见、可执行、状态正常（同一进程里别处已成功调用过）、描述完整，但本回合 `header.tools` 与 schema 都在而没有任何 `tool/call` | 必须**先排除** 1–4；只能以"同一工具在相邻回合成功过"为前提，**不能凭单次缺席**下结论 | `tool-visibility.ts` 的设计注释：这三层必须分别回答，否则结论不可行动 |
| **6. 无工具面**（这条路径上根本没有工具） | 请求里没有 `tools` 字段 | 看**请求构造代码**，而不是看调用次数 | `host-llm.mjs` 的 `const options = { ...call.config, messages, system, purpose, signal, sessionId }` |

本仓库已经落地的两处属于第 1 类（群聊 11 个白名单名字）与第 6 类（P2 后台无 tools 字段）；
`scheduled` 与 `share` 的"模型没调"落在第 4 类（`share-disabled` 默认关）。
**没有任何一处**可以被归到第 5 类 —— 因为没有任何真实调用记录，本次审计不下这个结论。

---

## 6. D 包：输出正文可靠性（离线诊断，`output-diagnosis.mjs`）

### 6.1 导出签名

```js
diagnoseOutput({ events, limits }) -> {
  visibleChars, reasoningChars, reasoningPresent,
  finishReason, stopReason, streamCompleted,
  emptyBody, budget: { maxOutputTokens, source, exhausted, visibleChars, reasoningChars },
  codes[], layers: { template[], budget[], provider[], stream[], host[] },
  sideEffects: { attempted, succeeded, failed, unknownOutcome, unknownKind, names[] },
  toolCalls: { total, readOnly, withResult, failed },
  messageCount, attemptCount, interrupted, unavailable[]
}

needsRecovery(diagnosis) -> boolean
// 附带：scanStream(stream), describeOutputCode(code), OUTPUT_CODES, OUTPUT_CODE_LAYERS
```

**硬口径**：只算长度与状态码，**不保留 reasoning 原文**。返回对象里没有任何 `text` 字段；
测试里有一条专门用 `JSON.stringify(diagnosis)` 断言它不含 reasoning 片段。
`reasoningPresent` 只说明"有思考"，绝不等于"可以拿思考当正文"。

### 6.2 codes 全表（18 个）

| code | 层 | 含义 |
|---|---|---|
| `no-assistant-message` | provider | 这一轮没有 assistant/message |
| `provider-attempt-without-message` | provider | 有 assistant/attempt 但没落成消息 |
| `output-empty` | template | 可见正文 trim 后为 0 |
| `reasoning-present-without-body` | template | 有 reasoning、正文为空（reasoning 不得充当正文） |
| `host-message-empty-though-stream-saw-text` | host | 流里有文本增量，合成后的消息没有文本块（宿主消息合成丢文本） |
| `stream-not-completed` | stream | 流里没有 finish chunk |
| `stream-error` | provider | finish = error |
| `stream-aborted` | provider | finish = aborted |
| `budget-truncated` | budget | finish 或 turn/end 是 max-tokens |
| `turn-not-closed` | stream | 没有 turn/end |
| `turn-error` | provider | turn/end = error |
| `turn-aborted` | stream | turn/end = aborted |
| `turn-interrupted` | stream | turn/end = interrupted（崩溃后补闭合，不代表行为完成） |
| `turn-blocked` | provider | turn/end = blocked |
| `limits-unavailable` | provider | 没有可靠的输出预算计数器 |
| `side-effect-attempted` | （不进层表） | 有副作用（或副作用未知）的工具被调用过 |
| `side-effect-outcome-unknown` | （不进层表） | 有副作用工具的调用没有对应结果 |
| `recovery-blocked-by-side-effect` | （不进层表） | 正文为空但有副作用工具执行过 ⇒ 禁止自动重跑 |

> 计数的硬口径：`Object.keys(OUTPUT_CODES).length === 18`（脚本实测），测试里逐条校验每个出现的码都在表内。
> 其中 **15 个**归属 `layers` 的五个候选层（template / budget / provider / stream / host）；
> 剩下 **3 个**（`side-effect-attempted` / `side-effect-outcome-unknown` / `recovery-blocked-by-side-effect`）
> 不归属"故障层"——它们说的是"能不能重试"，不是"哪一层坏了"。这个区分是刻意的，不要把 18 全塞进五层。

### 6.3 故障分类的"不预设根因"设计

同一个空正文可能同时命中 `output-empty`（template）+ `host-message-empty-though-stream-saw-text`（host）；
同一个长 reasoning 空正文同时命中 `output-empty` + `reasoning-present-without-body`（都在 template）。
`layers` 只是**把码按候选层分组**，不做"根因就是 X"的断言。要归因必须再看证据（流、finish、工具回执）。

### 6.4 `needsRecovery` 的安全边界

返回 `true` 的**唯一**条件：`emptyBody === true` **且**没有任何副作用档位的工具被调用过。
- 有副作用、副作用未知（工具没声明 `kind`/`sideEffect`）、或"调用了但没有结果" ⇒ **一律 false**（fail-closed）；
- 字段缺失（拿不到 `attempted` 的证据）⇒ false；
- 有正文 ⇒ false。

覆盖的用例（`output-diagnosis.test.mjs`，**12 条，全绿**）：

| # | 用例 | 关键断言 |
|---|---|---|
| 1 | 空正文 | `emptyBody`、`streamCompleted:true`、recovery=true |
| 2 | 流中断（无 finish） | `streamCompleted:false`、`stream-not-completed`、`turn-aborted`、recovery=false |
| 3 | reasoning 很长但正文空 | `reasoningChars` 单独统计、`visibleChars===0`、`JSON.stringify` 不含 reasoning 片段 |
| 4 | 只有 reasoning 无正文 | `emptyBody:true`、template 层两码同时出现 |
| 5 | 预算截断 | `budget.exhausted:true`、`budget-truncated` |
| 6 | 正常完整输出 | 无问题码、`streamCompleted:true` |
| 7 | 有副作用工具失败后空正文 | `side-effect-attempted`、`recovery-blocked-by-side-effect`、recovery=**false** |
| 8 | 无副作用空正文 | recovery=**true**；并覆盖"副作用未知"与"有调用无结果"两种 fail-closed 分支 |
| 9 | 流有文本但消息为空 | host 层码命中 |
| 10 | 只有 attempt / 没有 turn/end | `provider-attempt-without-message`、`turn-not-closed` |
| 11 | 没有预算计数器 | `maxOutputTokens:null`、`source:'unavailable'`、不写 0 冒充 |
| 12 | 码表一致性 + `scanStream` 只累加长度 | 每个出现的码都在 `OUTPUT_CODES` 里 |

---

## 7. 证据等级与未执行项

- **E2（已达成）**：合成挂载（真实 `mountCompanion` + 假 ctx，工具矩阵与 schema 字符都是实测）、纯函数故障诊断（12 条测试全绿）。
- **E3 未执行**：真实宿主 + 隔离 profile + 本地合成模型。本轮不允许启动宿主任一进程，也不允许挂 QQ 通道（要 OneBot 连接）。
  所以"群聊到底看不看得见那 11 个工具""restrict 在这版宿主上是否真的按预期生效"仍是**源码判断**，不是装载验证。
- **E4 未执行**：经授权真实模型固定集。本轮零模型调用；计划 §5-D 也写明"未授权真实调用时只交离线证据"。
  所以"正文非空率 ≥99%"这个指标**没有数据**，不能声明。
- **E5 未执行**：操作者显式触发真实通道（私聊/群真实发送）。只能由操作者触发。

**不能宣称的**：离线测试通过 ≠ 端到端可用。本报告里所有"可走通"都是"代码路径上不闭合的环已经点出来"，
不是"已经在真实宿主上跑通"。

---

## 8. 给集成负责人的接线点（本次未改任何已存在文件）

1. **群聊要状态/日程**：`identity.resolve` 对 `qq-group-*` 抛错是硬阻断。要么给群聊开一个不经过
   `identity.resolve` 的只读通道（走 runtime 的 `p2Status({scopeKey})`，群聊本来就有 `groupIdOf`），
   要么接受"群里不回答真实状态"并写进 `docs/03`。**不要**把 foundation 工具塞进 `GROUP_ALLOWED_TOOLS` 就算完 —— 那会执行失败。
2. **`companion_share_activity` 的 `activityId` 取不到**：在描述里点名"从 `companion_life_status` 的
   `runningActivities[].activity_id` 取"，或在 producer 里提供一次 `listActivities` 的只读回执。否则这条链永远断在参数。
3. **B站证据没有模型面**：`bilibili-rounds` 的 `evidenceOf`（BV 号 + `consumedSeconds`）只在 runtime 内部。
   要让模型"依据证据说话"，需要把该证据作为一个只读工具或 `life_status` 的字段透出（并明确 `method:'transcript'` 时只算读了字幕）。
4. **D 包的接线**：`diagnoseOutput` 是纯函数，接在 `session/event`（`assistant/message` / `turn/end`）之后即可；
   `needsRecovery` 的调用点必须**先**检查"这一轮有没有副作用工具"（模块里已 fail-closed），再决定是否重答一次。
   **严禁**在有副作用的轮次自动重跑工具。
5. **P2 后台如果真要工具**：宿主支持 `register(..., { when })` 与 `resolve()`，但 P2 现在走的是
   `llm.prepareCall + call.stream` 直连，没有 agent，也没有 `tools` 字段。要接就得换执行器，不是加一行参数。

---

## 9. 复现命令

```bash
node tools/tool-audit.mjs          # 人读版（工具矩阵 / 四上下文 / 场景链 / 宿主调查 / 归因表）
node tools/tool-audit.mjs --json    # 机器可读版（stdout 只有 JSON，挂载日志走 stderr）
node --test plugins/companion-foundation/output-diagnosis.test.mjs
node tools/baseline-stats.mjs       # 交叉核对：42 个工具 / 17,835 字符与本报告一致
```

全部零网络、零模型调用、零真实数据读取。
