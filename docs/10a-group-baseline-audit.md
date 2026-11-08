# P5 基线审计与停发控制（2026-11-08）

对应《P5–P8 下一阶段计划》§2.1（P5-A 基线核对）与 §2.2（P5-B 停发控制）。
**证据级别：只有 offline-test**。本文件不构成任何真实发送或真实模型效果的证据。

---

## 1. P5-A：基线核对（只读，未改任何生产配置）

### 1.1 工作区与分支

| 项 | 实际值 |
|---|---|
| 路径 | `D:\Bot\DSH-dev` |
| 分支 | `feat/group-social-p0` |
| HEAD | `24383dcfe39ae760c8a04456a0fee9dff8391ce5` |
| `git status --short` | 改动前**空**（工作树干净） |
| Node / npm | v24.14.0 / 11.9.0 |

### 1.2 交付提交可达性（计划 §2.1 第 2 条）

全部**在当前分支**，逐笔 `git cat-file -e <sha>^{commit}` 通过：

| 提交 | 阶段 | 主题 |
|---|---|---|
| `dbbe983` | P1 | 群体记忆、成员记忆与话题状态 |
| `24e7494` | P2 | 社交决策器 |
| `ed1e928` | P3 | 统一事件时间线与调度拆分 |
| `2f758ad` | QA + P4 前半 | 离线评测集与连续性命中段 |
| `24383dc` | P4 | 表情包策略、弱反馈与交付文档 |
| `f988ca2` | P0 | 统一人格快照与群消息身份 |

**与计划 §0.4 的差异（结论：以本地为准）**：计划编写时在公开 GitHub `main` 上看不到这些文件，
那是**尚未推送**，不是未实现。本地六个提交齐全、文件齐全、测试全绿。按计划 §0.4 的要求，
没有从公开 `main` 覆盖任何本地实现。

### 1.3 文件存在性（计划 §2.1 第 3 条）

逐个 `Test-Path` 通过（15 个文件）：`group-persona.mjs`、`group-memory.mjs`、`port-publish.mjs`、
`group-persona.ts`、`group-memory-contract.ts`、`group-social-decision.ts`、`group-social-prompt.ts`、
`presence-cycle.ts`、`presence-timeline.ts`、`presence-scheduler.ts`、`group-events.ts`、
`group-topic.ts`、`group-continuity.mjs`、`eval/group/README.md`、`eval/group/run.mjs`。

### 1.4 测试基线（改动前，可复现）

| 检查 | 命令 | 结果 |
|---|---|---|
| 通道单测 | `node --test "build/lib-test/test/*.test.js"` | **1495 tests / 1494 pass / 0 fail** |
| foundation 单测 | `node --test "*.test.mjs" "test/*.test.mjs"` | 263 / 254 pass / 0 fail / 9 skipped |
| 离线评测 | `node eval/group/run.mjs` | PASS 37 · FAIL 0 · WARN 4 / 41，exit 0 |
| 仓库级 | `npm run verify` | unit 9 / static 32 / compose 1，exit 0 |

---

## 2. P5-B：`speakMaxPerHour = 0` 的实际行为（计划 §2.2 的核心问题）

### 2.1 审计结论：**确实不能用 0 停发**

计划里的怀疑成立，而且比计划写的更严重。改动前的 `core/presence.ts`：

```ts
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
// ...
if (recentSends(state, nowMs).length >= positive(limits.speakMaxPerHour, 3)) return veto('hour-quota')
```

- `speakMaxPerHour = 0` → `positive(0, 3)` → **3**。设 0 想停发，实际是"每小时还能说三次"。
- 配置层 `min: 1` 也挡不住：JSON 手改 / 旧配置文件不受 min 约束。
- 更关键的是：**即使额度真的是 0，也停不住表情包**（P4 的 `stickerMaxPerHour` 是另一个参数），
  更没有"本来想说什么"的诊断。

上一轮交付文档 §10 把 `speakMaxPerHour=0` 写成"只停发言"是**错的**，这里更正。

### 2.2 已做的两处修复

**① 额度语义 fail-closed**（`core/presence.ts` 新增 `quota()`）：

额度类参数（`speakMaxPerHour`）与间隔类参数（`judgeIntervalMs` / `speakMinIntervalMs`）的
安全方向相反。间隔把 0 当"没配"退回默认是安全的（结果都是少做点）；额度把 0 退回默认
正好相反——配置手滑变成了更多外发。所以额度这里：**给 0 就是 0**，负数/NaN 才退默认。

> 但**停发不要依赖它**：它只能停自主发言，停不了表情包，也不留诊断。

**② 新增显式运行模式 `presence.mode`**（`core/presence-mode.ts`）：

```
off    不判断、不发；装配层连执行器都不创建（等价于旧的 enabled:false）
shadow 收消息、调模型、走完所有校验，但一条都不发；只记影子日志
live   真的会发（白名单 + 限频 + 冷却）
```

解析优先级（`resolveMode`，纯函数，有 8 例单测）：

1. `presence.mode` 是合法值 → 用它。**显式写的永远权威**：写了 `shadow` 的话，
   `enabled: true` 也不该让它发消息；
2. `mode` 缺席 / 空串 / 写错 → 退回旧口径 `enabled === true` → `live`，否则 `off`；
3. 无法判断 → `off`。

写错时（`mode: "dry-run"`）不猜，退回 enabled 口径，并由 `modeNoteOf()` 在启动日志里
说明白（"presence.mode=\"dry-run\" 不是合法模式…"）。

### 2.3 最后一道闸门：**每次发送前现取**

计划 §7.1 点的最高风险是"shadow 只在入口禁止发送"。这里的做法：

- `CycleDeps.sendGate()` 是一个**函数**，`presence-send.ts` 在**限频通过之后、调用
  `sendGroupMessage` 之前**才调它；
- 装配侧传 `() => resolveMode(host.config.presence)`，所以后台一改就立即生效；
- 有专门用例：模型还在飞的时候把 `live` 改成 `shadow`，那次结果**不许**发出去
  （`test/presence-mode.test.ts` 的"在途判断"用例，用 `FakeClock` + 手动闸门）。
- `sendGate` 缺省（旧装配 / 单测）按 `live`：把它默认成 shadow 会让既有 1501 个测试与旧部署
  突然"不发消息"，那是静默的功能回退，不是加固。

### 2.4 被闸门拦下时的记账（`shadowed`）

三件事，缺一不可：

1. **写影子日志**（`shadow` 模式存在的全部意义）——一行 JSON 落
   `<dataRoot>/logs/presence-shadow.jsonl`，含 at / group / mode / action / target / text / chars，
   **不带 message_id**（它没发出去，带上会被下游当成"说过话"）；
2. **按 `silent` 记账，不是 `failed`** —— 模型与代码都正常，记成失败会让 shadow 跑一会儿
   就把失败计数攒满、自己暂停；
3. **不推进发言冷却、不占额度** —— 没发就是没发，不能消耗 live 时的额度。

统计上 `spoken` 与 `shadowWouldSend` **分开计数**：shadow 跑一轮应该看到
`shadowWouldSend > 0` 且 `spoken === 0`；出现 `spoken > 0` 就说明闸门漏了。

---

## 3. 为了做到这些，代码结构做了哪些拆分

`presence-flow.ts` 在加了影子路径之后到了 436 行（`check:size` 硬上限 400）。按**"想 / 做"**
切开，而不是按行数切：

| 文件 | 职责 | 行数 |
|---|---|---|
| `app/inbound/presence-flow.ts` | 想：组提示词 → 调模型 → 解析 → 校验 | 286 |
| `app/inbound/presence-send.ts` | 做：限频 → 模式闸门 → 发送 → 记账 | 253 |
| `core/presence-mode.ts` | 模式解析与能力矩阵（纯函数） | 148 |

`presence-wiring.ts` 的 `wirePresence`（70 行 > 60）同样拆出 `memoryWriter` 与 `shadowLogger`。

拆分的收益不只是过检查：想的时候会花一次模型调用，做的时候会往群里发东西。混在一个函数里，
"我以为只改了判断"就会变成"实际改了发送"——这正是 P5 要防的事。

---

## 4. 测试

| 文件 | 例数 | 钉住什么 |
|---|---|---|
| `test/presence-mode-core.test.ts` | 8 | 旧配置兼容（enabled 口径）、显式 mode 优先、大小写归一、写错不猜、能力矩阵、**只有 live 能发** |
| `test/presence-mode.test.ts` | 7 | shadow 真判断但不发、影子日志内容、spoken=0 / shadowWouldSend=1、不累积失败、**在途结果被新模式拦下**、off 兜底、live 对照组、无闸门按 live |

每条"不发"都配了对照组：同一套输入只把模式换成 `live` 就必须真的发出去——否则"没发"
可能只是用例自己写坏了。

全量：channel-qq **1502 tests / 1501 pass / 0 fail**；`check:layers` 459 文件通过；
`check:size` 通过；`npm run verify` 三段全绿。

---

## 5. 配置变更（向后兼容）

| 字段 | 默认 | 热生效 | 影响 |
|---|---|---|---|
| `presence.mode` | `''`（未指定） | live | `''` / `off` / `shadow` / `live`。缺席时按 `enabled` 推断，旧配置行为不变 |

> **默认值是空串，不是 `off`（P9-A1 修正）**：P5 那版默认写 `off`，但 `DEFAULT_CONFIG` 由
> schema 生成，于是合成器会给**每一份旧配置**补上 `mode:'off'`，而 `resolveMode` 看到显式值
> 就照办——`enabled:true` 的老部署升级后被静默停用。改成空串之后「没指定」与「显式 off」
> 在数据上就能区分，旧配置才会真的走 `enabled` 那条兼容路径。详见 `docs/11` §A1。

黄金快照 `test/golden/config/resolved.txt` 与 `layers.txt` 已同步（diff 只有 `"mode"` 这一行的值：`resolved.txt` 1 处、`layers.txt` 16 处，原文都是 `"off"`）。

---

## 6. 已知限制（不要读成"停发已经万无一失"）

1. **表情包走的是另一个服务**（`companion-expression` 的 `reply`）。它现在**不经**这条闸门，
   因为 `presence-afterspeak.ts` 只在 `outcome.kind === 'spoke'` 时才被调用，而 shadow 下
   永远不会有 `spoke`。也就是说：**shadow 下不会发图，是靠"根本没走到那一步"**，
   而不是靠图库那条路自己检查模式。将来若要开放"shadow 下也评估表情"，必须在那条路径
   上再加一次同样的闸门。
2. `mode` 只覆盖自主接话这条链路；被 @ 的正常回合（Agent 会话）不受它控制（那是另一条链路，
   由 `requireMention` 与工具授权管）。
3. 影子日志是**追加写**、无内容脱敏后的二次加工，也没有封顶之外的轮转策略；量大了要单独治理。
