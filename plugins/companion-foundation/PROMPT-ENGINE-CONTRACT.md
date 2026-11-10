# Prompt Engine — 模块合同（v1.1 实施）

本文件是 `DSH_模块化认知与写作引擎_实施任务书_v1.1.md` 的落地合同。**所有人（含 Lead）以本文件为唯一接口依据**，
任务书里的章节号表示来源。任何接口改动必须先改本文件。

## 0. 边界（不可违反）

- 只在 `plugins/companion-foundation/` 内新增文件；不改 `companion-memory`、`companion-runtime`、
  `companion-group`、DSH 宿主，也不新增第二套长期记忆/对话注入入口。
- 新增模块全部是**纯函数模块**：不写 `data/`，不读真实私人记忆，不发起网络或模型调用。
  唯二例外由 Lead 在 `prompt-engine.mjs` 里负责：配置读取、Planner 模型调用。
- 默认 `enabled: false` ⇒ 完全惰性：不注入、不注册 Section、不改变任何现有行为。
- 不出现真实用户数据；测试只用 `os.tmpdir()` 与合成文本。
- 代码风格与现有插件一致：ESM、`node:test`、无第三方依赖、Node >= 24。

## 1. 文件与所有权

| 文件 | 职责 | 负责人 |
| --- | --- | --- |
| `prompt-config.mjs` | 配置读取/校验/默认值/安全回退 | T1 |
| `prompt-router.mjs` | 交互场景、强度、算子激活、会话状态推进 | T1 |
| `prompt-modules.mjs` | 认知算子与 Style Profile 模块目录 | T2 |
| `prompt-compose.mjs` | 组合、排序、去重、预算裁剪 | T2 |
| `prompt-plan.mjs` | 结构化规划的 Schema 校验与降级 | T3 |
| `prompt-lint.mjs` | 文风检测（只统计+理由码） | T3 |
| `prompt-engine.mjs` | 引擎总入口、会话状态、Planner 接线 | Lead |
| `index.mjs` / `package.json` | 现有 Hook 内最小接线、发布配置 | Lead |
| `prompt-engine.test.mjs` / `prompt-engine-mount.test.mjs` | 引擎与挂载测试 | Lead |
| `<各自>.test.mjs` | 各模块单元测试 | 各自 |

依赖方向（单向，禁止反向 import）：
`prompt-config` ← `prompt-router` ← `prompt-compose` → `prompt-modules`；`prompt-plan`/`prompt-lint` 独立；
`prompt-engine` 可 import 全部，其余不得 import `prompt-engine`。

## 2. 共享数据类型

### 2.1 Config（`prompt-config.mjs` 产出）

```js
{
  schemaVersion: 1,
  enabled: false,                       // 最高关闭优先级
  mode: 'off' | 'shadow' | 'active',    // off 完全不改变对话；shadow 只算不注入
  interactionMode: 'auto',              // 'auto' | 'chat' | 'companion' | 'roleplay' | 'task'
  thinkingMode: { chat:'guided', companion:'guided', roleplay:'guided', task:'guided' },
  planner: {
    enabled: false, provider:'', model:'', reasoningEffort:'low',
    maxInputChars: 8000, maxOutputTokens: 800, timeoutMs: 20000, maxCallsPerTurn: 1,
  },
  review: { enabled: false, maxRepairCalls: 1 },
  budgets: { chat: 600, companion: 800, roleplay: 1300, task: 500 },
  modules: { disabled: [] },            // 模块 ID 黑名单（§7 要求 3）
  routing: { carryOverTurns: 6, maxHistoryTurns: 12 },
}
```

`loadPromptConfig(root, { env, override }) -> { config, file, error, warnings }`
- 文件：`path.join(root, 'home/companion/prompt-engine.config.json')`（`root` = 数据根）。
- 非法 JSON / 非法枚举 / 越界数字 ⇒ 该字段回落默认值，并 push 一条 `warnings`（纯字符串，不含正文）；
  **绝不抛错**，`error` 只记录读盘失败原因。
- 不创建、不覆盖任何文件。
- env 覆盖：`DSH_COMPANION_PROMPT_ENGINE=enabled|active|shadow|off|1|0`（`1|enabled|active` ⇒
  `enabled:true, mode:'active'`；`shadow` ⇒ `enabled:true, mode:'shadow'`；`off|0` ⇒ `enabled:false`）。
- 预算钳制范围：`[120, 4000]`，非法取默认值。
- `enabled !== true` ⇒ `mode` 强制 `'off'`（与 runtime 同一条铁律）。
- 导出：`DEFAULT_PROMPT_CONFIG`、`PROMPT_CONFIG_VERSION`、`promptConfigFile(root)`、
  `loadPromptConfig(...)`、`sanitizePromptConfig(raw)`、`effectivePromptMode(config) -> 'off'|'shadow'|'active'`、
  `PROMPT_INTERACTION_MODES`、`PROMPT_THINKING_MODES`。

### 2.2 Route（`prompt-router.mjs` 产出）

```js
{
  schemaVersion: 1,
  mode: 'chat' | 'companion' | 'roleplay' | 'task',
  intensity: 'normal' | 'subtle' | 'immersive',
  profile: 'chat' | 'companion' | 'implicit-roleplay' | 'roleplay-narrative' | 'task',
  thinkingMode: 'guided' | 'structured' | 'strict',
  source: 'explicit' | 'override' | 'carry-over' | 'continuity' | 'default',
  confidence: 0..1,
  operators: { DIG:'on'|'optional'|'off', LORE:…, ARC:'on'|'light'|'optional'|'off', REVIEW:… },
  evidence: ['carry-over-scene', 'scene-signal:dialogue', …],   // 只有码，不含原文
  resume: { mode, intensity } | null,   // 临时切 task 时保留的 RP 状态（§6.2）
}
```

映射（`profile` 由 mode+intensity 决定，唯一）：
`chat/normal → chat`，`companion/* → companion`，`roleplay/normal|subtle → implicit-roleplay`，
`roleplay/immersive → roleplay-narrative`，`task/* → task`。

算子激活表（§4.2）：

| mode / intensity | DIG | LORE | ARC | REVIEW |
| --- | --- | --- | --- | --- |
| chat / normal | on | off | off | optional |
| companion | on | optional | off | optional |
| roleplay / normal-subtle | on | optional | light | optional |
| roleplay / immersive | on | on | on | on |
| task | on | optional | off | optional |

`routeTurn({ config, sessionId, previousState, history, message, explicit }) -> { route, state, diagnostics }`
- `history`：`[{ role:'user'|'assistant', text }]`，最旧→最新，已由调用方裁剪（≤ `routing.maxHistoryTurns`）。
- `explicit`：`{ mode?, intensity? }`，来自配置（`interactionMode !== 'auto'`）或显式指令。
- `state` 形状：
  ```js
  { sessionId, mode, intensity, profile, source, turns, sceneTurns, calmTurns,
    thinkingMode, resume, updatedAt, explicitMode, explicitIntensity }
  ```
- 三层判断（§6.2）：显式控制 > 上下文连续性 > 模型自主（由 `prompt-modules` 的条件规则文本承担）。
  **单条消息永远不能得出 immersive**：immersive 需要显式控制，或 `previousState` 已是 roleplay 且本轮有场景承接。
- 不得使用"全局静态关键词表决定 RP"。允许**结构信号**（引号对白、`*动作*`、第二人称+前文场景、
  代码围栏、明确任务动词），但它们只能给出 `subtle` 或置信度，不能单独给出 `immersive`。
- 纯函数 + 显式 `now`（`routeTurn({... now})`，默认 `Date.now()`）。
- 另外导出 `routeOperators(mode, intensity)`、`profileFor(mode, intensity)`、`initialState(sessionId)`。
- `diagnostics`：`{ reason: string, signals: string[], bounded: string[] }`，供 `status()` 与路由诊断使用。

### 2.3 Composition（`prompt-compose.mjs` 产出）

```js
{
  profile, text, chars, budgetChars,
  selectedModules: [{ id, priority, chars }],
  skippedModules: [{ id, reason }],      // reason: 'scene'|'operator'|'disabled'|'budget'|'duplicate'|'empty'
  state: { mode, intensity, thinkingMode, trimmed: [id…], deduped: [id…], budgetChars },
}
```

`composePrompt({ route, config, persona, memoryContext, workingMemory, extraDisabled = [] }) -> Composition`
- 模块来自 `modulesFor({ profile, operators, thinkingMode, disabled })`。
- 排序：`priority` 降序，同优先级按 `MODULES` 声明顺序（稳定）。
- 去重：模块 `dedupeKey` 相同只留优先级最高的；模块正文完全相同也只留一条。
- 预算：`config.budgets[mode]`；装不下时按优先级**从低到高整模块丢弃**，禁止截断模块；
  每个被丢的模块都进 `skippedModules` 且原因为 `'budget'`。
- `text` = 各模块正文用 `'\n'` 连接；`chars = text.length`；`chars <= budgetChars` 必须成立。
- 不超过 `MAX_MODULES`（10）个模块。上限取 10 而不是 8，是为了让 `style.universal`（"不编造现实事实"这一条）
  在任何档位都不会被数量上限挤掉；真正限制注入量的是字符预算，不是模块计数。

### 2.4 模块目录（`prompt-modules.mjs`）

```js
{
  id: 'style.anti-ai-chat',        // 全局唯一，稳定
  label: 'Anti-AI Chat',
  kind: 'header'|'mode'|'operator'|'thinking'|'style',
  priority: 0..100,                // 越大越重要，裁剪时先丢小的
  dedupeKey: '',                   // 可选
  scenes: ['chat', …],             // profile id 白名单
  operators: [],                   // 非空 ⇒ 只有该算子为 on/light/optional 时才加入
  charBudget: 120,                 // 该模块自身的目标上限（文档用，不强制）
  render(ctx) -> string,           // ctx = { route, config, personaPresent }
}
```

导出：`MODULES`（数组，声明顺序即稳定顺序）、`MODULE_IDS`、`modulesFor({ profile, operators, thinkingMode, disabled })`、
`styleProfileOf(profile)`（描述性元数据）、`promptContractSection()`。

`promptContractSection() -> { name: 'companion:prompt-contract', order: 65, text }`
- 静态 System Prompt Section，只解释"动态模块的解释规则"（模块可能不出现、按场景生效、不得自行宣布模式切换、
  角色认知边界优先于任何风格要求）。**不得包含白描/环境描写等具体风格内容**，不得与人格冲突。
- 文本 ≤ 420 字。

模块 ID / 优先级（不可随意改名，测试与配置黑名单依赖它）：

| id | kind | priority | scenes |
| --- | --- | --- | --- |
| `route.header` | header | 95 | 全部 |
| `mode.chat-frame` | mode | 90 | chat |
| `mode.companion-frame` | mode | 90 | companion |
| `mode.implicit-frame` | mode | 90 | implicit-roleplay |
| `mode.roleplay-frame` | mode | 90 | roleplay-narrative |
| `mode.task-frame` | mode | 90 | task |
| `thinking.guided` | thinking | 70 | 全部 |
| `thinking.structured` | thinking | 70 | 全部 |
| `thinking.strict` | thinking | 70 | 全部 |
| `operator.dig` | operator | 80 | 全部 |
| `operator.lore` | operator | 78 | 全部 |
| `operator.arc` | operator | 76 | 全部 |
| `operator.review` | operator | 74 | 全部 |
| `style.anti-ai-chat` | style | 62 | chat |
| `style.emotional-companion` | style | 62 | companion |
| `style.implicit-roleplay` | style | 62 | implicit-roleplay |
| `style.roleplay-narrative` | style | 62 | roleplay-narrative |
| `style.task-clear` | style | 62 | task |
| `style.anti-deepseek` | style | 50 | 全部（task 用精简版正文） |
| `style.universal` | style | 40 | 全部 |

模块正文目标长度（中文计 1 字）：header ≤ 60，mode ≤ 110，thinking ≤ 80，operator ≤ 130，style ≤ 200，
`style.anti-deepseek` ≤ 170。`chat` 档全部模块合计必须 ≤ 560 字（预算 600），`task` ≤ 470（预算 500）。

`thinking.guided|structured|strict` 只描述**执行等级与内部产物分离**要求（不得把规划过程写进正文、
structured 尊重已验证的规划结果、strict 按审查意见修正一次）；不描述算子内容本身。

### 2.5 结构化规划（`prompt-plan.mjs`）

- `PLAN_SCHEMA_VERSION = 1`、`PLAN_LIMITS`（字段长度/数组数量上限）。
  Plan 形状见任务书 §4.3，字段：`schemaVersion, taskType, intent{goal,constraints[]}, scene{time,location,participants[],knownFacts[],unknowns[]},
  characters[{id,intention,attitude,knowledgeBoundary[]}], operators{DIG,LORE,ARC,REVIEW},
  styleProfile, outputContract{format}`。
- `extractJsonObject(text) -> { ok, value, error }`：容忍 ```json 围栏与前后废话，只取第一个完整对象。
- `validatePlan(value, { limits }) -> { ok, plan, errors: [{ path, code }] }`：
  `code` ∈ `not-object|wrong-version|missing|too-long|too-many|bad-enum|bad-type`；`plan` 为**归一化后的安全副本**
  （截断到上限，未知字段丢弃）。
- `buildPlannerPrompt({ route, persona, memoryContext, workingMemory, userMessage, config, limits })`：
  返回 `{ system, input }` 两个字符串；`input.length <= planner.maxInputChars`（超长按从旧到新裁剪）；
  明确要求"只输出 JSON，不写正文"。
- `buildRepairPrompt({ rawText, errors, limits })` -> `{ system, input }`：一次格式修复。
- `renderPlanForWriter(plan)` -> 紧凑中文文本（≤ 900 字），供 Writer 阶段使用；空字段不输出。
- 无模型调用、无 fs。

### 2.6 文风检测（`prompt-lint.mjs`）

`lintText(text, { profile, mode, operators }) -> { chars, profile, counts, findings, ok }`
- `counts`：`{ sentences, contrastiveTemplates, simileTemplates, fillerMotifs, abstractMetaphors,
  emotionExplanations, parallelRuns, summaryEndings, connectiveRepeats }`（数字，无原文）。
- `findings`：`[{ code, count }]`，`code` ∈
  `contrastive-template|simile-template|filler-motif|abstract-metaphor|emotion-explanation|
   parallel-clauses|summary-ending|connective-repeat|over-explained-action|echo-user|mechanical-affirm`。
- `ok`：该 profile 下"没有超标项"。阈值集中导出 `LINT_THRESHOLDS`。
- **只检测，不改写**；返回值里不得包含任何原文片段。普通聊天不检测白描/环境描写（该模式本就不启用）。
- 必须证明不误伤正常中文：`不是`/`没有`/`其实` 等单独出现不算超标；只有模板化组合才算。

## 3. 引擎（Lead）

`createPromptEngine({ root, ctx, getHistory, getLlm, env })` 返回：
`{ mode, enabled, config, configFile, route({sessionId, message, history}), snapshot({sessionId, route, persona}),
   status(), setExplicit(sessionId, {mode, intensity}), clearSession(sessionId), dispose(), lintUrl }`。
会话状态用内存 `Map`（上限 200，LRU 淘汰），**不落库、不共享**；`qq-*` 会话与其他会话互不影响。

`index.mjs` 接线（唯一允许的改动）：
1. `mountCompanion()` 内创建引擎。
2. Prompt Engine 生效时注册静态 Section `companion:prompt-contract`（order 65）。
3. 现有 `agent/pre-step` 内、`createUserMessage()` 之前，把组合结果作为**新 section** `companion-prompt-profile`
   追加到现有快照；`identityText`/`memoryText`/`cognitiveText`/pulse/care 全部保持原样。
4. `step !== 1`、`signal.aborted`、`decision.kind === 'reject'` 行为不变。
5. Prompt 文本**独立预算**，不占用 Memory 2400 / Runtime 320 的额度；`off` 时既不注册 Section 也不追加内容。
6. 引擎任何异常都必须退化为"没有 prompt 文本"，不得让该轮失败。

## 4. 测试要求

- 每个模块自带 `<file>.test.mjs`，`node --test` 直接可跑（不经 npm，不依赖宿主）。
- 覆盖任务书 §14.1/§14.2/§14.3/§14.5 的对应部分；**不得**把"所有歧义都回退 chat"当通过标准。
- 断言里不得出现真实聊天记录、真实人名、本机绝对路径。
- 每人实现完自己跑：`cd plugins/companion-foundation && node --test <自己的 test 文件>`，全绿再交付。

## 5. 交付回报格式

回复 Lead：改了哪些文件、导出签名是否有偏差、测试命令与结果（通过数）、主动放弃或需要 Lead 决策的点。
