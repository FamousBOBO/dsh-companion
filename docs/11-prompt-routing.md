# P4 路由现状与有限修正

配套：`docs/09-prompt-baseline.md`（基线）、`docs/10-prompt-layers.md`（P1/P2/P3）、
`docs/12-prompt-verification.md`（P5 验收）。

## 1. 当前路由到底是什么（如实区分三件事）

| 概念 | 本仓库现在有没有 | 由谁决定 | 失败时会怎样 |
|---|---|---|---|
| **规则路由** | **有**。`prompt-router.mjs` 的纯函数，用结构信号与词表判定 `mode/intensity/profile` | 本地 JavaScript，每次 `agent/pre-step` 跑一次 | 抛错时引擎降级为「本轮不加写法模块」，聊照常 |
| **模型自主表达** | **有**。主模型在选中的 profile 下自己调整语气与长度 | 模型 | 与路由无关 |
| **独立语义路由**（模型分类器） | **没有**，本次也不加 | — | — |

`prompt-router.mjs` 用自己的文件头写着：不使用"全局静态关键词表决定 RP"，只用结构信号
（成对对白引号、`*动作*`、代码围栏、第二人称承接、任务请求语气），且信号只影响置信度与
`subtle`，不单独构成立即的沉浸判定。本次没有改这条设计。

## 2. 现有规则（改动前，逐条）

| 判定层 | 规则 | 代码位置 |
|---|---|---|
| 第一层 显式 | `explicit.mode` 或 `config.interactionMode ≠ auto` ⇒ 直接采用，`source=explicit/override`，置信度 1 | `routeTurn` L229 |
| 第二层 任务 | 代码围栏 / 行内代码 / 技术词表 ⇒ `task/normal`，若之前在 RP 则记 `carry-over:paused-scene` | L241 |
| 第二层 场景延续 | 已在 RP：本轮或前一轮用户发言有 strong 信号 ⇒ 维持；无信号则按 `idleTurns` 逐轮降档（immersive → 2 轮不变 → 1 轮 subtle → 淡出并写入 `resume`） | L254–291 |
| 第二层 恢复 | 有 `resume` 且出现 strong 信号 ⇒ 回到 `roleplay/subtle` | L292 |
| 第二层 新建场景 | 本轮有 strong 信号（引号对白 / `*动作*`）⇒ `roleplay/subtle`（单条消息**永不**直接 immersive） | L298 |
| 第二层 弱信号 | 前文有场景 + 本轮弱信号（第二人称场景指示 / 省略号 / 抽象表达）⇒ `roleplay/subtle` | L305 |
| 第二层 情绪 | 情绪词 ⇒ `companion/normal` | L313 |
| 第二层 抽象情绪 | 只有抽象表达（如果/会不会/是不是…）⇒ `companion/normal`，并记 `bounded:abstract-emotion-not-roleplay` | L319 |
| 兜底 | `chat/normal` | L325 |
| 后置钳制 | 非显式来源的 `immersive` 一律降 `subtle`；非 RP 的强度归一为 `normal` | L335–345 |

## 3. 本次实际改动（只有两处，都是已确认缺陷）

### 3.1 ASCII 引号被当成对白证据（真缺陷，影响 §6.3-6）

`QUOTE_PAIRS` 里含 `['"', '"']` 与 `['‘', '’']`。原实现只检查「有开引号、后面还有同名闭引号」，
于是：

| 输入 | 改动前 | 改动后 |
|---|---|---|
| `use "strict mode" in the config` | `roleplay/subtle` ❌ | `chat/normal` ✅ |
| `set "proxy" env var` | `roleplay/subtle` ❌ | `chat/normal` ✅ |
| `他说 "hello"` | `roleplay/subtle` ❌ | `chat/normal` ✅ |
| `"你终于来了"` | `roleplay/subtle` ✅ | `roleplay/subtle` ✅ |
| `「你怎么来了？」` | `roleplay/subtle` ✅ | `roleplay/subtle` ✅ |

修法：全角引号（「」『』“”‘’）保持原样；ASCII 引号额外要求**引号内确实有汉字**。
不改任何其它判定，不放宽 `immersive` 的钳制。

### 3.2 `sceneDeixis` 词表里的重复项

`/(...|这里|这里|...)/` 里「这里」写了两遍。正则等价、行为不变，但会让人误以为漏了一项。
去重，并在同一行的注释里说明它为什么需要「前文有场景」才成立。

## 4. 逐条对照任务书 §6.3（真实路由实测，不是推断）

| # | 对话 | 任务书期望 | 实测（改动后） | 判定 |
|---|---|---|---|---|
| 1 | 「哈喽喽」 | chat，自然简短 | `chat/normal`，`source=default` | ✅ |
| 2 | 「对啊」 | 基于上一轮接话，不机械复述 | `chat/normal`，`turns` 累加，沿用前态模式 | ✅ |
| 3 | 「还没呢」 | 不因极短句丢失「吃饭」上下文 | `chat/normal`，`source=continuity` | ✅ |
| 4 | 「如果那天我没走，你会不会留我？」（无场景） | companion 或轻度自然回应，不编造场景 | `companion/normal`，证据含 `bounded:abstract-emotion-not-roleplay` | ✅ |
| 5 | 同一句（前文连续共同场景） | 允许 subtle，自然承接 | `roleplay/subtle`，证据含 `carry-over:scene` + `context-signal:history-scene` | ✅ |
| 6 | 「分析一下 RP 路由代码」 | task，不进入 roleplay | `task/normal`（`task-signal:vocabulary`） | ✅ |
| 7 | 稳定 RP 中途问「这个函数怎么改」 | 临时 task，不丢失原场景 | `task/normal` + `resume={roleplay,subtle}`，随后「你先别走。」→ `roleplay/subtle`（`resume:scene`） | ✅ |

上表每一行都由 `prompt-router.test.mjs` 里的测试钉住（新增 4 个测试，覆盖 7 条样例）。

## 5. 明确没做的事

| 计划 §6.2 边界 | 状态 |
|---|---|
| 不强迫用户宣告「开始 RP」 | 未加任何此类要求；测试里用 `「你怎么来了？」` 这类自然信号建立场景 |
| `normal → subtle → immersive` 自然过渡 | 未改过渡逻辑；仍是「单条信号只到 subtle，immersive 需显式或承接」 |
| 有场景证据时允许抽象表达被判为场景延续 | 已是现有行为（`priorSceneStrong > 0 && abstractHit`），未改 |
| 语义路由先写 RFC，不偷偷加分类器 | **没有加**。本文 §1 明确记录「独立语义路由 = 没有」 |
| 不改 memory/tool 权限边界 | 未改 |
| 不借机重写架构 | 只改 2 处、共约 15 行；`routeTurn` 的分支结构未动 |

## 6. 一个已知的、故意不修的限制

`续写一个故事` 这类**没有引号也没有 `*动作*`** 的叙事请求不会进 roleplay，会停在 `chat`。
这是设计选择而非缺陷：任务书明确「不能把抽象表达本身当作 RP 的充分证据」，而放宽这条会
让所有「如果我当初…」式的假设题都被判成扮演。用户要进叙事档，用 `interactionMode` 或
明确要求即可，不需要在路由里猜。

## 7. 与 P3 的关系

P4 改的是 `prompt-router.mjs`（判定），P3 改的是 `prompt-modules.mjs`（文本）。两者独立：
即使路由判错，注入的也只是另一种写法模块，不会改变人格、记忆与工具权限。

导航：`docs/09-prompt-baseline.md` → `docs/10-prompt-layers.md` → 本文 → `docs/12-prompt-verification.md` → `docs/13-prompt-followups.md`。
