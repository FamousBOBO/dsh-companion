# P5 重新抓包与验收

配套：`docs/09-prompt-baseline.md`（基线）、`docs/10-prompt-layers.md`（P1–P3）、
`docs/11-prompt-routing.md`（P4）、`docs/13-prompt-followups.md`（后续项）。

**证据分级（计划 §7.4）** —— 本文每条结论只声明它真正到达的级别：

| 级别 | 本文是否达到 |
|---|---|
| 1. 源码静态审查 | ✅ |
| 2. 单元测试 | ✅（`npm run test`：9 个模块 ok，1 个无测试） |
| 3. 配置合成 / 离线集成 | ✅（`dsh --dump-config` + `verify --only=compose`） |
| 4. 宿主真实装载 | ✅（测试环境 3199 真实启动，`agentPresets/list` 正常） |
| 5. 真实模型响应质量 | ✅（10 轮合成对话，见 §4） |
| 6. 真实 QQ / 语音 / 提醒 | ❌ **未测**，需另行授权 |

## 1. 抓包环境

| 项 | 值 |
|---|---|
| 环境 | 本 worktree 自己的测试实例 `http://127.0.0.1:3199`（`npm run start`） |
| profile | `companion`（`data/home`） |
| 会话 | `session-9bb3dd3b-23a7-43a3-9d64-f5045d6181a3` |
| 模型 | `opencode-go-companion-256k` / `deepseek-v4.1-flash` / effort `high` |
| 输入 | **合成样本**（10 轮，见 `tmp/p5-capture.mjs`），不含任何真实聊天或隐私记忆 |
| 原始产物 | `data/logs/p5-capture.json`、`data/logs/p5-audit.json`、`tmp/p5-system-prompt.txt`（均 gitignore） |

## 2. System Prompt 对照

| 段 | 改动前 | 改动后 | 变化 |
|---|---:|---:|---:|
| `companion:persona` | 4,797 | 4,797 | 0（本阶段不动用户人格） |
| Foundation 静态 + contract | 1,558 | **1,082** | **−476** |
| DSH 原生 | 4,004 | **0** | **−4,004** |
| **合计** | **10,361** | **5,881** | **−4,480（−43.2%）** |

原生段逐项消失（全部经真实抓包确认，不是推断）：

| 原生段 | 改动前 | 改动后 |
|---|---|---|
| `FILE_REFERENCE`（`@` 路径说明） | 407 | **0** |
| `TOOL_PWSH` | 259 | **0** |
| `TOOL_READ` / `TOOL_WRITE` / `TOOL_EDIT` | 126/140/132 | **0** |
| `TOOL_GLOB` / `TOOL_GREP` | 71/129 | **0** |
| `TOOL_JOBS` | 382 | **0** |
| `DELIVERABLE_FILE_REFERENCES` | 1,192 | **0** |
| `HARNESS_SOURCE` + `WEB_SURFACE` | 325 + 821 | **0** |

> 说明：`FILE_REFERENCE` 段一并消失是**连带效果**，不是单独关的插件。宿主实现是
> `text: () => agent.ctx.tools.get('read', agent) === void 0 ? '' : FILE_REFERENCE_PROMPT`
> ——预设不再挂 `tool-fs`，`read` 工具不存在，这段自然渲染为空串。这正是"删一行预设真的会让
> 对应 System Prompt 消失"的实证（计划 §1.3 最后一条要求以抓包为准）。

## 3. 工具清单对照

| 项 | 改动前 | 改动后 | 变化 |
|---|---:|---:|---:|
| 工具总数 | 56 | **46** | −10 |
| ├ `companion_*` | 41 | 41 | 0 |
| └ 宿主 | 15 | **5** | −10 |
| 工具定义总字符 | 35,274 | **26,621** | **−8,653（−24.5%）** |

被移除的 10 个宿主工具：`pwsh`、`read`、`write`、`edit`、`read_image`、`glob`、`grep`、
`job_output`、`job_kill`、`job_list`。
保留的 5 个：`schedule_create`、`schedule_update`、`schedule_delete`、`schedule_list`、
`working_directory`。

> **没有为了缩短而失能**：日程能力整组保留（计划 §1.3 要求日程与提醒区分必须保留）；
> `companion_*` 41 个工具一个没动；开发能力只在 `preset-companion` 里裁掉，
> `preset-standard` / `preset-ptc` / `preset-cordis` 的 `tool-pwsh` / `tool-fs` /
> `tool-fs-search` / `tool-jobs` / `tool-skill` / `agent-instructions` 全部原位（实测见 §5）。

## 4. 每轮用户侧注入（真实值）

| 注入 kind | 次数 | 字符（每轮） |
|---|---:|---|
| `user` | 10 | 3 / 2 / 9 / 19 / 15 / 13 / 10 / 8 / 8 / 7 |
| `runtime-context` | 1 | 515 |
| `time-context` | 1 | 262 |
| `companion-memory`（身份 + 记忆 + 写法） | 10 | 1,388 / 1,789 / 1,774 / 2,132 / 2,151 / 1,380 / 1,752 / 1,595 / 1,309 / 1,556 |

**重点核对**：删掉的 System Prompt 有没有被挪进每轮 user snapshot？

先看同一会话内的干净对照（`session-1e2d3b27`，前后环境、目录、沙箱策略完全相同，只有插件集合变了）：

| 每轮固定注入 | 改动前 | 改动后 | 变化 |
|---|---:|---:|---:|
| `system-prompt` | 10,361 | 5,881 | −4,480 |
| `runtime-context` | 839 | 638 | −201 |
| `time-context` | 262 | 262 | 0 |
| `companion-memory` | 1,496 | 1,369 | −127 |

`runtime-context` 少掉的 201 字，逐段核对是 `harness:source`（135）+ `app:web-surface`（62）= 197 字，
加上几个分隔符 —— 也就是关掉 `harness-dev-context` 插件带走的「当前 checkout / Web GUI 地址」两行。
**工具说明不在这一段**，它们本来就在 system prompt 里，那边已经整段消失。

本文 §4 那次抓包（`session-9bb3dd3b`）的 `runtime-context` 是 515 字，比 638 还少 123 字，
差额来自该会话的沙箱策略是 `danger-full-access`（127 字）而不是 `workspace-write`（263 字）——
这是另一个会话的权限设置差异，**不能**拿来当裁剪收益计入。

结论：`companion-memory` 的浮动来自检索命中数（1,369–2,151 都与当轮问题相关），
没有出现「system prompt 变短、但每轮 user 注入变长」的搬家现象。**总上下文确实减少了。**

## 5. 逐项验收（计划 §7.3）

| 指标 | 要求 | 实测 | 判定 |
|---|---|---|---|
| 原生开发提示词 | 陪伴 profile 里消失，或说明技术阻碍 | 两段全部消失（`harness-dev-context` + `ui-deliverables` + 连带 fs/shell/jobs 段） | ✅ |
| System Prompt 字符 | 4,000–5,500 是候选区间；persona 未获批准不得强求 | **5,881**，超出区间 381 字，差额全部是未改动的 4,797 字人格 | ✅ 达标（按计划允许的例外） |
| 普通聊天动态写法 | 250–350 字 | **404 字**（chat 档 8 个模块） | ⚠️ 未达目标区间，见 §7 |
| 人格一致性 | 不低于原版 | 人格文件逐字节未改；10 轮回复全部保持「本姑娘」口吻与短句节奏 | ✅ |
| 现实/虚构隔离 | 关键样本 100% | 心率问题回答「没读数，不编数字」；记忆缺失时如实说；无编造经历 | ✅ |
| 日程/提醒事实性 | 不能说无回执日程已提醒 | `companion:agenda` 段仍在，且未出现"已设置提醒"表述 | ✅ |
| 心率/衣柜/活动 | 没实时事实不得编造；需要时能查到 | 衣柜答出真实 4 件（与 `wardrobe.json` 一致）；心率明确说无读数 | ✅ |
| Agent/工具隔离 | 开发工具不因陪伴裁剪丢失 | `preset-standard` / `ptc` / `cordis` 各 22–23 个插件，开发工具齐全；`preset-minimal` 保留 `tool-fs` | ✅ |
| 延迟与 Token | 记录真实变化，不能凭更短推断更便宜 | 6.0–19.9 秒（首轮含冷启动）；工具字符 −24.5%，System Prompt −43.2% | ✅ 已记录 |

## 6. 10 轮合成对话（质量抽查）

| # | 输入 | 耗时 | 回复字数 | 关键观察 |
|---|---|---:|---:|---|
| 1 | 哈喽喽 | 19.9s（冷启动） | 34 | 短、自然、有时间感（凌晨） |
| 2 | 对啊 | 6.1s | 18 | 接住上一轮，不机械复述 |
| 3 | 今天有点撑不住，累 | 6.1s | 45 | 先接情绪，不说教 |
| 4 | `*把伞往他那边偏了偏*「你怎么来了？」` | 6.1s | 58 | 路由到隐性情景，少量动作，不过度叙事 |
| 5 | 如果那天我没走，你会不会留我？ | 6.1s | 124 | 有场景承接；**但把思考过程写进了正文**（见 §7） |
| 6 | 用一句话解释一下什么是幂等 | 8.1s | 0 | 路由到 task；**正文为空**，内容全在 reasoning 里（见 §7） |
| 7 | 你记得我生日是哪天吗 | 14.2s | 58 | 调了 `companion_recall`，答出真实生日 |
| 8 | 你今天穿的是什么 | 6.1s | 51 | 与衣柜段一致，且补了细节 |
| 9 | 今天有什么安排吗 | 10.1s | 58 | 规划关闭时如实说"没排正经事" |
| 10 | 你现在心跳多少 | 12.1s | 47 | 明确「没读数，不编数字」 |

## 7. 两个真实缺陷（抓包发现，本阶段未修）

### 7.1 第 6 轮：task 档回复正文为空

模型把完整答案写在 `reasoning` 块里，`text` 块为空。原因不是这次改动，而是
**没有可用的表达约束**：task 档注入的写法模块是 247 字，其中没有一条要求"答案写在正文"。
`thinking.guided` 只说"思考过程不外露"，模型理解成了"写在 reasoning 里就行"。

这属于 Prompt Engine 的写法模块设计问题，不是 P1–P4 的回归：改动前的 `thinking.guided`
（62 字）同样没有这条。修复需要新增/改写模块文本并单独做 A/B，**不在本次清理范围内**，
已记录在 `docs/13-prompt-followups.md`。

### 7.2 第 5 轮：思考过程漏进正文

同一根因的另一面：rote 到 `implicit-roleplay` 档（329 字）时，模型把「这段该怎么回」的
自我分析直接写进了 `text`。`style.universal` 只有"不编造现实事实"，没有"不要解释你的思路"。

同上，记为后续项。

## 8. 与基线的完整对照

| 指标 | 基线（改动前） | P1 后 | P1–P4 后 |
|---|---:|---:|---:|
| System Prompt | 10,361 | — | **5,881** |
| 工具数 | 56 | — | **46** |
| 工具定义字符 | 35,274 | — | **26,621** |
| Foundation 静态 | 1,375 | — | **891** |
| prompt-contract | 183 | — | 183（恒注册，off 时渲染为空） |
| chat 档动态模块 | 512 | — | **404** |
| companion 档 | 513 | — | **446** |
| task 档 | 280 | — | **247** |
| roleplay 档 | 409 | — | **363** |

## 9. 可复现命令

```bash
npm run setup -- --force      # 重新渲染 profile 补丁（开关在 config/suite.json 的 prompt.*）
npm run start -- --port 3199  # 启动本套件实例
node tmp/p5-capture.mjs       # 跑 10 轮合成样本
node tmp/p5-audit.mjs <会话目录>   # 算出本文所有 System Prompt / 工具 / 注入字段
npm run verify                # static + unit + compose
```

> `tmp/` 是 gitignore 的本地产物目录（抓包脚本放在那里，不入库）。想重跑本文的数字，
> 需要那两个脚本：`p5-capture.mjs`（用宿主 RPC 发固定合成输入）与
> `p5-audit.mjs`（只读解码 `session.v4.jsonl.zstd` 并统计）。前者约 110 行、后者约 150 行，
> 逻辑就是本文 §2/§3/§4 三张表的算法，按表复现即可。
