# 08 — Prompt Engine（模块化认知与写作引擎）

模块化认知与写作引擎的第一期（P0）与结构化执行（P1）。它不是一个更长的 System Prompt，而是一层
**可配置、可组合、可验证**的提示词编排：由场景决定注入哪些算子与写作规范，日常聊天不会被小说规则污染。

实现依据见 [`plugins/companion-foundation/PROMPT-ENGINE-CONTRACT.md`](../plugins/companion-foundation/PROMPT-ENGINE-CONTRACT.md)。

## 1. 默认关闭，装上就等于没装

配置文件：`<dataDir>/home/companion/prompt-engine.config.json`。

- **文件不存在** ⇒ 引擎处于 `off`，不往消息里追加任何内容，不读记忆、不调模型。
  契约 Section（`companion:prompt-contract`）**仍然注册一次**，但渲染为空串——
  宿主在拼接前会丢掉空串 Section，所以 System Prompt 与不带引擎的版本逐字节一致。
  这样做的原因是生命周期一致：挂载时 `off`、之后配置改成 `active`，也能立刻拿到契约；
  详见 `docs/10-prompt-layers.md` §5。
- **配置坏了**（非法 JSON、非法枚举、越界数字）⇒ 逐字段回落默认值，`status().configError` 记录原因；
  聊天不受影响。
- **`enabled: false` 拥有最高关闭优先级**：写了 `mode: "active"` 也不会生效。
- 引擎**从不创建、从不覆盖**这个文件。要不要开，是操作者的决定。

## 2. 配置示例

最小可用（普通聊天档、单次模型调用、不规划、不审查）：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "mode": "active",
  "interactionMode": "auto"
}
```

完整字段与默认值：

```json
{
  "schemaVersion": 1,
  "enabled": false,
  "mode": "off",
  "interactionMode": "auto",
  "thinkingMode": { "chat": "guided", "companion": "guided", "roleplay": "guided", "task": "guided" },
  "planner": {
    "enabled": false,
    "provider": "",
    "model": "",
    "reasoningEffort": "low",
    "maxInputChars": 8000,
    "maxOutputTokens": 800,
    "timeoutMs": 20000,
    "maxCallsPerTurn": 1
  },
  "review": { "enabled": false, "maxRepairCalls": 1 },
  "budgets": { "chat": 600, "companion": 800, "roleplay": 1300, "task": 500 },
  "modules": { "disabled": [] },
  "routing": { "carryOverTurns": 6, "maxHistoryTurns": 12 }
}
```

| 字段 | 含义 |
| --- | --- |
| `mode` | `off` 完全不改变对话；`shadow` 照常路由与组合但**不注入**（只为看诊断）；`active` 正式注入 |
| `interactionMode` | `auto` 让引擎自主判断；`chat` / `companion` / `roleplay` / `task` 是用户的显式控制 |
| `thinkingMode` | 每个场景的执行等级：`guided`（单次调用，默认）/ `structured`（先规划再写）/ `strict`（规划 + 审查 + 一次修正） |
| `planner` | 仅在 `structured` / `strict` 且 `planner.enabled` 为 `true` 时才调用模型；`provider`/`model` 留空则用桌面当前路由 |
| `budgets` | 每个场景**注入的提示词字符上限**；与记忆 2400、运行时 320 的预算互不侵占 |
| `modules.disabled` | 模块 ID 黑名单（ID 见合同 §2.4） |
| `routing` | 取多少轮历史辅助判断、场景跨轮保留多少轮 |

环境变量覆盖（只控制开关，不表达策略）：

```bash
DSH_COMPANION_PROMPT_ENGINE=active   # 启用并注入（= 1 / enabled / on）
DSH_COMPANION_PROMPT_ENGINE=shadow   # 启用但只看诊断
DSH_COMPANION_PROMPT_ENGINE=off      # 强制关闭（覆盖文件里的 true）
```

改完不需要重启：引擎每轮重读配置。

## 3. 场景路由

三层判断（**不是**关键词表）：

1. **显式控制**：`interactionMode` 或运行期命令指定了模式，一律优先。
2. **上下文连续性**：看最近几轮用户自己说过什么、当前是否已经在一个场景里、是否在承接动作或对白。
3. **模型自主**：注入的模块本身是**条件式**规则，模型在其中按当前氛围判断怎么写。

| 场景 | 强度 | 注入的写作档 |
| --- | --- | --- |
| 普通聊天 | normal | `chat` — 只聊，不含任何叙事要求 |
| 情感陪伴 | normal | `companion` — 接情绪，不写成分析报告 |
| 隐性情景互动 | subtle | `implicit-roleplay` — 自然对白为主，少量贴合语境的动作 |
| 完整情景扮演 | immersive | `roleplay-narrative` — 白描、有限视角、知识边界 |
| 知识与任务 | normal | `task` — 直接回答，不加扮演描写 |
| 创意写作 | immersive / structured | `roleplay-narrative`（可配 `structured` 规划） |

两条硬规则：

- **单条消息永远不会得到 immersive。** immersive 只来自显式控制，或"已经在沉浸中"的承接。
- **抽象情绪表达不等于 RP。** "如果那天我没有离开，你会不会挽留我"默认是情感陪伴；只有前文已经形成场景，
  才会作为场景内的延续处理。

算子按场景激活（`on` / `light` / `optional` / `off`）：

| 场景 | DIG | LORE | ARC | REVIEW |
| --- | --- | --- | --- | --- |
| chat | on | off | off | optional |
| companion | on | optional | off | optional |
| roleplay（subtle） | on | optional | light | optional |
| roleplay（immersive） | on | on | on | on |
| task | on | optional | off | optional |

LORE 与 ARC 都可以整轮跳过；没有"最少算子数量"，也不为了填模板而生成长思考。

## 4. 执行等级与模型成本

| 等级 | 模型调用 | 适用 |
| --- | --- | --- |
| `guided`（默认） | 1 次（就是聊天本身） | 普通聊天、情感陪伴、隐性情景互动 |
| `structured` | +1 次 Planner | 复杂情景扮演、创意写作 |
| `strict` | Planner + Writer + Reviewer + 最多 1 次修正 | 显式开启，普通聊天永不自动进入 |

约束（全部可在 `status()` 里核对）：

- Planner 复用的是 DSH 宿主 LLM（`host-llm.mjs`），不新增 Provider、不复制 API Key 管理。
- Planner **不注册、不执行任何工具**，不产生对外动作，输出不展示给用户。
- 每轮规划调用有上限（`maxCallsPerTurn`，含一次格式修复），且该适配器**关掉了隐藏重试**
  （`allowFallback: false`）：一次预算 = 一次物理生成。
- Planner 超时、不可用或 JSON 校验失败 ⇒ 降级 `guided`，正文照常生成；用户消息不会因为规划失败而失败。
- Strict 不改变工具调用与 Agent Loop。

## 5. 文风检测（只检测，不改写）

`prompt-lint.mjs` 在 `session/event` 的助手消息上跑一次正则统计，结果**只进诊断**：

- 输出只有计数与理由码（`contrastive-template`、`filler-motif`、`summary-ending` 等），
  **不含任何原文片段**，也不写盘。
- 不修改、不重写、不拦截任何回复。
- `不是`、`没有`、`其实` 这类正常中文词**不是禁词**；只有模板化组合的高频使用才会被统计。
- 普通聊天档不检测白描——该档本来就不启用叙事规则，检测它只会制造误报。

## 6. 查看当前状态

```js
// 在宿主里（例如通过 Studio 或调试脚本）：
mountResult.promptEngine.status()
// → { mode, enabled, configFile, configError, plannerError, sessions, counters, lint, routes: [...] }
```

`routes` 只含档位、来源、置信度与**信号码**（`scene-signal:dialogue` 之类），不含对话正文。

## 7. 测试

```bash
# 六个纯函数模块 + 引擎 + 宿主挂载
cd plugins/companion-foundation
node --test prompt-config.test.mjs prompt-router.test.mjs prompt-modules.test.mjs \
             prompt-compose.test.mjs prompt-plan.test.mjs prompt-lint.test.mjs \
             prompt-engine.test.mjs prompt-engine-mount.test.mjs

# 整仓
npm run verify
```

所有测试用临时目录与合成文本，不读取真实私人聊天记录，也不调用真实模型。

## 8. 证据分级（照实说）

| 级别 | 状态 |
| --- | --- |
| 离线单元测试 | **通过**（本机 Node 24） |
| 宿主装载（真实 foundation 挂载 + 真实 `agent/pre-step`） | **通过**（含用已安装桌面模组跑的那一轮） |
| 真实模型调用 | **未验证**（本仓库不做，需操作者显式开启 planner 后自行对照） |
| 真实场景质量验收（固定测试集对照） | **未验证**（需要真实模型输出与人工评分） |

不要把这四条混成一条。
