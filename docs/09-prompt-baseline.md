# P0 基线报告 — System Prompt 来源与层级

> 只读审计产物。基线分支 `origin/feat/prompt-engine` = `2e933fe`。
> 抓包样本取自本地测试环境（3199）与桌面 App 两个真实会话，**不含**真实聊天内容以外的隐私外泄：本文只记录长度、来源与层级，不复述记忆正文。

## 1. 工作区与分支

| 项 | 值 |
|---|---|
| 工作区 | `D:\Bot\DSH-dev\.agents\worktrees\feat\prompt-engine` |
| 分支 | `feat/prompt-engine` |
| `git status --porcelain=v1` | 干净（P0 开始时） |
| `origin/feat/prompt-engine` | `2e933fe3562954c28e7ad41363b11e53e3ad867e` |
| `origin/main` | `0a545ff`（feat 分支**未**包含它；main 未包含 feat 的提交） |
| 分叉 | feat 独有 1 个提交（`2e933fe`）；main 独有 1 个提交（`0a545ff`） |
| `git diff --stat main...origin/feat/prompt-engine` | 22 files, +5172 / −5 |

结论：**本次改造只在 `feat/prompt-engine` 上进行，绝不静默改用 main，也不做覆盖式合并。**

## 2. 抓包基线（改动前）

被测会话：`session-1e2d3b27`（测试环境 3199，3 轮真实对话）。

| 统计项 | 实测 | 说明 |
|---|---:|---|
| System Prompt 总字符 | **10,361** | `system/message` 单块 |
| ├ `companion:persona` | **4,797** | `config/persona.md` 全文，逐字节相同 |
| ├ Foundation 静态 Section | **1,375** | `continuity` 634 + `agenda` 299 + `life` 74 + `wardrobe` 273 + `pulse` 95 |
| ├ `companion:prompt-contract` | **183** | 动态写法说明 |
| └ DSH 原生 Section | **4,004** | 见 §3 逐段归属 |
| 每轮 `companion-memory` | 1,496 / 1,897 / 1,524 | 身份 240 + 记忆 + 写法 512 |
| `runtime-context` | 839 | 宿主 |
| `time-context` | 262 | 宿主 |
| 工具总数 | **56** | 其中 `companion_*` 41 |
| 工具定义总字符 | **35,274** | `companion_*` 20,283 / 宿主 14,991 |

工具里最重的 6 个：`pwsh` 3,295、`schedule_create` 3,143、`schedule_update` 2,403、`companion_pulse` 1,615、`companion_schedule_update` 1,118、`edit` 1,111。

## 3. 原生 Section → 插件 ID → 配置层级

层级含义：
- **profile** = 宿主 bundle 层（`dsh-base` / `dsh-web-app`）装载，`--patch` 只能用 `- id: <id>` + `disabled: true` 在**条目层**关掉整个插件（宿主无「只关 Section」的开关）。
- **preset** = 由 `config/profile/companion.patch.template.yml` 的 `preset-companion.config.plugins` 决定。

| # | 抓包字符 | Section 名 | 注册插件 | 条目 id | 层级 | 能否按 Profile 关 |
|---|---:|---|---|---|---|---|
| 1 | 407 | —（`FILE_REFERENCE`，order 900） | `@deepseek-ai/dsh-file-reference-local` | `file-reference-local` | profile | 可（`disabled: true`），但会连带失去 `@` 路径补全与文件发现服务（9 个包 inject `fileReference`） |
| 2 | 259 | `TOOL_PWSH`（1010） | `@deepseek-ai/dsh-tool-pwsh` | `tool-pwsh` | profile | 可；本 profile 顶层已 `disabled: true` |
| 3 | 126 | `TOOL_READ`（1100） | `@deepseek-ai/dsh-tool-fs` | `tool-fs` | profile | 可；顶层已 `disabled: true` |
| 4 | 140 | `TOOL_WRITE`（1200） | `@deepseek-ai/dsh-tool-fs` | `tool-fs` | profile | 同上 |
| 5 | 132 | `TOOL_EDIT`（1300） | `@deepseek-ai/dsh-tool-fs` | `tool-fs` | profile | 同上 |
| 6 | 71 | `TOOL_GLOB`（1400） | `@deepseek-ai/dsh-tool-fs-search` | `tool-fs-search` | profile | 可；顶层已 `disabled: true` |
| 7 | 129 | `TOOL_GREP`（1500） | `@deepseek-ai/dsh-tool-fs-search` | `tool-fs-search` | profile | 同上 |
| 8 | 382 | `TOOL_JOBS`（1600） | `@deepseek-ai/dsh-tool-jobs` | `tool-jobs` | profile | 可；顶层已 `disabled: true` |
| 9 | 1,192 | `DELIVERABLE_FILE_REFERENCES`（9000） | `@deepseek-ai/dsh-client-ui-deliverables` | `ui-deliverables` | profile | **可**（实测 `disabled: true` 生效），但会连带失去 `present` 工具的宿主半（`deliverables/presented` 事件、原生打开） |
| 10 | 325 | `HARNESS_SOURCE`（10000） | `@deepseek-ai/dsh-harness-dev-context` | `harness-dev-context` | profile | **可**（实测生效） |
| 11 | 821 | `WEB_SURFACE`（10100） | `@deepseek-ai/dsh-harness-dev-context` | `harness-dev-context` | profile | 与 #10 同一个插件，一起关 |

### 3.1 关键发现：这两段其实「已经该消失却没消失」

`dsh-base` / `dsh-web-app` 的 bundle 补丁里，顶层 `tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-jobs` / `agent-instructions` / `skill-filesystem` / `tool-skill` 都已经 `disabled: true`（23 个顶层条目被 bundle 自己关掉，说明这些能力改成**按 preset 装载**）。但：

- `harness-dev-context` 与 `ui-deliverables` **仍在 profile 层启用**（`disabled=undefined`）；
- 因此它们注册的两个 Section 对**所有** agent 生效，包括 `preset-companion`。

### 3.2 关掉它们的代价（实测依赖）

| 目标 | 关掉的后果 | 证据 |
|---|---|---|
| `harness-dev-context` | 失去「当前 checkout / Web GUI URL」两行 runtime context。对陪伴会话无功能损失；对开发会话（要改 DSH 本体）有信息损失。 | 插件只注册 2 个 section + 2 个 runtime context，无服务导出 |
| `ui-deliverables` | 失去 `present` 工具的宿主半（`deliverables/presented` 事件、原生打开文件）。**但**：`present` 工具本身由 `@deepseek-ai/dsh-tool-present` 注册，而它在本 profile 里**根本没装载**（对照：桌面 App 的工具清单里有 `present`，测试环境 56 个工具里没有）。所以关掉 `ui-deliverables` 对当前环境**没有实际功能损失**。 | 见 §3.3 |

### 3.3 `present` 在两边的存在性差异（重要）

| 环境 | 工具数 | 有 `present` |
|---|---:|---|
| 测试环境（3199，companion preset） | 56 | **否** |
| 桌面 App（desktop preset） | 51 | **是** |

说明 `present` 的装载跟着 preset 走，而 `companion` preset 的插件清单里没有它。因此 `DELIVERABLE_FILE_REFERENCES`（1,192 字）在当前陪伴环境里讲的是一个模型**根本调不到**的工具 —— 纯噪声。

## 4. 当前 `preset-companion` 的真实插件清单

实测（`dsh --dump-config` 合成后）：

```
companion-foundation     file://…/plugins/companion-foundation/index.mjs
time-context             @deepseek-ai/dsh-time-context
agent-instructions       @deepseek-ai/dsh-agent-instructions
tool-pwsh                @deepseek-ai/dsh-tool-pwsh
tool-fs                  @deepseek-ai/dsh-tool-fs
tool-fs-search           @deepseek-ai/dsh-tool-fs-search
tool-jobs                @deepseek-ai/dsh-tool-jobs
tool-schedule            @deepseek-ai/dsh-tool-schedule
```

与本 worktree 生成物对照：`skill` / `skill-filesystem` / `tool-skill` 三条在测试环境的生成物里被手工删掉了（因为 `dsh-base` 已注册 `skills` 服务，重复注册会让 preset 标 broken），本地 `config/profile/companion.patch.yml` 与模板**不一致**。这是本地临时修补，未提交，也需要在 P1 里正式处理。

## 5. 工具 Schema 开销

| 分组 | 字符 |
|---|---:|
| `companion_*`（41 个） | 20,283 |
| 宿主（15 个） | 14,991 |
| 合计（56 个） | 35,274 |

宿主 15 个：`pwsh`(3295)、`schedule_create`(3143)、`schedule_update`(2403)、`edit`(1111)、`write`(814)、`glob`(750)、`grep`(702)、`job_output`(615)、`read`(439)、`read_image`(389)、`job_kill`(370)、`working_directory`(360)、`schedule_delete`(295)、`job_list`(168)、`schedule_list`(137)。

注意：`pwsh` / `edit` / `write` / `glob` / `grep` / `read` / `read_image` / `job_*` 这 8 个能进到请求里，是因为 `preset-companion` **自己**装了 `tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-jobs`（顶层同名条目虽被 bundle 关掉，preset 内部是独立条目）。所以 P1 的裁剪点就在 preset 里。

## 6. 与旧抓包的一致性

本文所有数字与用户提供的 `dsh-request-trace.md` 完全一致（10,361 / 4,797 / 4,004 / 1,496–1,897 / 56 工具）。旧抓包来自同一环境的另一次会话，可作为可靠基线。

## 7. P0 验收结论

| 问题 | 答案 |
|---|---|
| 每段来自哪个插件？ | §3 表格逐段给出，11 段全部有主 |
| 哪个层级？ | `harness-dev-context`、`ui-deliverables` 在 **profile 层**；`tool-pwsh/fs/fs-search/jobs` 在 **preset 层**（可见但顶层同名条目已被 bundle 关闭） |
| 能否按 Profile 关闭？ | 能，用 `- id: <id>` + `disabled: true`（已用 `--patch` 实测生效）。代价见 §3.2 |
| 有无「只关 Section 不关插件」的宿主能力？ | **没有**。`dsh-system-prompt` 只提供 `section()` / `context()` 注册，没有 remove/hide API；`dsh-persona` 的 `complete: true` 是整段替换（会丢掉宿主全部 section），不是选择性关闭 |

**P1 可安全移除的目标（待实施）**：
1. `harness-dev-context`（1,146 字）—— 陪伴会话无用；
2. `ui-deliverables`（1,192 字）—— 本环境 `present` 工具根本没装；
3. `preset-companion` 里的 `tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-jobs`（对应 ~1,470 字 section + ~9,372 字工具定义）。

合计可减少约 **2,300 字 Section** + 最多 **9,372 字工具定义**，且不触碰开发 preset（`preset-standard` / `preset-cordis` 保持原样）。
