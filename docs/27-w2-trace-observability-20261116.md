# W2 实施记录：结构化 trace 与可解释日志（2026-11-16）

- 计划：[docs/ui-observability-unification-plan-20261116.md](ui-observability-unification-plan-20261116.md) §3 W2
- 前置：[G0 基线](25-g0-ui-observability-baseline-20261116.md)、[W1 字段目录](26-w1-settings-catalog-20261116.md)
- 本轮范围：事件 schema、落盘环、SSE 流、记忆侧投影、诊断事件页。
- **没有做**：在 `companion-memory` / `companion-foundation` 里加新埋点（理由见 §6）；真实宿主装载；真实模型调用。

---

## 1. 交付清单

| 模块 | 作用 | 行数 |
|---|---|---|
| `lib/trace-schema.mjs` | 10 字段白名单 + 枚举 + 理由码表 + 内容判据 + `sanitizeEvent` | 210 |
| `lib/trace-store.mjs` | 环状落盘（2000 行 / 3 代轮转）、丢弃记账、只读过滤读取 | 195 |
| `lib/trace-stream.mjs` | SSE：过滤、按 eventId 去重、轮转续读、半行等待、丢事件计数 | 241 |
| `lib/trace-project.mjs` | 既有 `memory-recall.jsonl` → 事件的**投影**（不新增写入口） | 138 |
| `lib/trace-route.mjs` | `GET /trace-events`、`GET /trace/stream`、`GET /trace-memory` | 124 |
| `src/client/pages-trace.js` | 诊断事件页：实时/快照时间线 + 记忆侧折叠 + 状态图例 | 20 片段之一 |
| `src/client/settings-search.js` 等 | （W1 已有）本轮只补 `P.api.url` 供 SSE 用 | — |

新增 **5 个测试文件、43 个用例**；陪伴空间从 193 → **236 用例全绿**。

## 2. 事件 schema（计划 W2 要求逐字对齐）

`EVENT_KEYS` = `eventId / traceId / at / module / stage / status / reasonCode / durationMs / counts / configRevision`，顺序固定，`serializeEvent()` 永远输出这 10 个键（缺的填 `null`），于是落盘与传输可以逐字节比对。

| 字段 | 约束 |
|---|---|
| `module` | `memory` / `prompt` / `router` / `tool` / `studio` / `host`，不在这 6 个里就降级并记 `unknown-module` |
| `stage` | `retrieve / filter / inject / route / compose / tool-start / tool-end / finalize`（顺序即时间线顺序） |
| `status` | `ok / empty / filtered / degraded / failed` |
| `reasonCode` | 有限表（37 个），含既有记忆侧码（`low-coverage`、`empty-candidate-pool`、`scope-mismatch`、`recall-error`、`no-database`、`no-viewer`、`semantic-*`、`rerank-*` 等**原样沿用**，不自创同义词）。表外的码**不拒绝**，收敛成 `unknown-reason` 并在 UI 上可见——新码先落地，归类后补表 |
| `durationMs` | 0 ≤ x ≤ 3,600,000（超界截断并记 `bad-duration`） |
| `counts` | 只允许 13 个计数键（`candidates/filtered/injected/characters/budgetChars/toolsVisible/toolsCalled/toolsFailed/events/dropped/records/tokens/modules`），值一律非负整数并封顶 1,000,000 |
| `configRevision` | 不透明短标识（≤48，`[A-Za-z0-9._:-]`）；不合规的清空而不是截半 |

**不合规时不静默修补**：`sanitizeEvent` 返回 `{ event, rejected }`，`rejected` 非空即把 `status` 降成 `degraded`、`reasonCode` 覆盖成 `event-rejected`，并保留仍然可用的计数。于是"写错了"在 UI 上看得见，而不是被悄悄改对。

## 3. 三条脱敏判据（不是宽泛启发式）

`looksLikeContent()` 只拦四种具体形状：

1. 凭据：`sk-/pk-/rk-` 前缀、`Bearer …`、`api_key|token|password|cookie = …`；
2. **任何 CJK 字符**——`reasonCode` 是稳定码，按契约只有 ASCII，出现中文即正文；
3. 长英文句子：至少三个空格才像自然语言（序列化后的 JSON 没有这种形态，不会自伤）；
4. 超长 `traceId`/`eventId` 同样过这一关。

### 3.1 修掉的两个真实 bug（都是"测了才发现"）

- **先截断后判内容**：60 字的聊天句被 `slice(0, 40)` 压成 40 字，正好躲过"40+ 连续 CJK"的判据。改成**先判原文、后截断**。
- **先归类后判内容**：正文形状的码先被归成 `unknown-reason`，再判内容时就认不出来。改成**先判内容、后判白名单**。

这两条现在各有一个用例钉住（`trace-schema.test.mjs`），并且并用例本身充当脱敏扫描的探针集。

## 4. 落盘：有界、可丢、可解释

- 环：默认每份 2000 行；写满把当前文件挪成 `… .1`，最多保留 3 代（`maxFiles` 可配）。
- 丢：写入失败 → `write-failed`；轮转失败 → `rotate-failed`；队列溢出 → `queue-overflow`。**`dropped` 从不只是一个数字**，永远带 `droppedReasons`。
- 读：`readTraceEvents` 只读当日 + 各代轮转；坏行与不安全行计入 `skipped` 并**跳过而不是让整页打不开**；没有当日文件时回退前一天（跨零点会话）。
- 写入端**从不抛给调用方**：诊断写入失败不能让对话路径感知异常（有一个用 `logs/` 是文件、写入必失败）的用例专门验这条。

## 5. SSE：轮转续读、去重、半行

对齐计划 W2 的四条硬要求，逐条都有用例：

| 要求 | 做法 | 用例 |
|---|---|---|
| 模块/等级过滤 | `module/status/reasonCode/traceId` 在**服务端**生效，客户端不用先拉全量再筛 | `stream applies server-side filters…` |
| 轮转续读不丢不重 | **每个文件各自的偏移**（不是"当前文件+偏移"），跨代继续读；`eventId` 环形去重（4096）兜住重读 | `rotation is followed without replaying…` |
| 丢事件计数 | `parsed/unsafe/corrupt/duplicate/filtered/readError` 随每次 `trace` 帧下发 | `corrupt and unsafe lines are counted…` |
| 客户端缓冲 2000 行 | `mergeEvents` 里 `.slice(-2000)`，与服务端环同口径 | 见 §7 冒烟 |

### 5.1 这里也修掉了一个真实 bug

第一版按"当前文件 + 一个偏移"实现，越过一代之后就**再也追不到新文件**（永远只读最老那一份），表现为用例 10 秒超时。改成 per-file 偏移才过。

### 5.2 半行不丢

写入端是 append-only，读端可能在它写一半时读到。第一版把半行算成 `corrupt` 并推进偏移，**那一条事件就永久消失**。改成：偏移只推到最后一个 `\n` 之后，残余半行留在 `partials` 里等下次拼上。用例 `a half-written line waits for its newline…` 先写半截、等两轮 tick、再补后半截，验证最终能读到且不计坏行。

## 6. 记忆侧：投影，而不是加埋点

**为什么不给 `companion-memory` 加埋点**：那会让记忆引擎反过来依赖 Studio 的 schema，依赖方向是错的（Studio 是 UI 层，引擎是下层）。

`companion-memory` **已经在写** `logs/memory-recall.jsonl`（447 条实测记录，键集 `at,sessionId,userId,backend,characters,queryCharacters,explain,elapsedMs`，`explain` 只有计数与理由码、无正文）。所以 W2 的"记忆侧事件"只是一个**只读投影**：`GET /trace-memory` 读那条日志 → 每条记录投影成 `retrieve` + `inject` 两条事件。

拆两条是有意的：合并成一条会让"检索失败但注入了旧内容"这种真实情况看不出来。

- `traceId` 不用 `sessionId` 本身（那是可逆身份），用 `FNV-1a(sessionId|at)` 折叠成 `tr_<base36>`：同一轮的事件归到一起，同时不泄漏身份。用例断言输出里 `sess_1`/`sess_2` 不出现。
- 空注入报 `empty` + `empty-candidate-pool`，**不报 ok**。
- 读不到时报 `readable:false` + `reason:'read-failed'`，**不假装"没有召回"**。

## 7. 前端诊断事件页

`src/client/pages-trace.js`（挂在设置组的第三个 tab，`P.registerPage({id:'diagnostics-trace'})`）。

- 两档：`实时` 走 SSE（持续追加）、`快照` 走 `GET /trace-events`（可回看某一轮）。两档共用同一个渲染，避免"实时看到的和快照看到的不是一回事"。
- 过滤：module 与 status 做成可点的 chip，`清除过滤` 一键复位。
- 每行：时间 / stage / `module + reasonCode` / counts+durationMs / 状态徽标；`failed`、`degraded`、`empty` 有左侧色条。
- **丢事件计数永远显示在列表下方**（读到的 / 被过滤 / 去重 / 坏行 / 不安全行 / 读失败 / 丢弃原因）。
- 自动滚到底只在用户没往上翻时生效（`autoScroll` 由滚动位置判断）。
- 记忆侧按 `traceId` 折叠成"一轮"，显示"候选 N → 过滤后 M；注入 K 字"与状态徽标。
- 状态图例把 `ok / empty / filtered / degraded / failed` 五个词逐个解释，理由码说明来自既有实现。

冒烟新增 8 条断言（`smoke-client.mjs` §8）：时间线区块、实时/快照切换、快照里能读到 `retrieve` 与 `low-coverage`、失败阶段有可读状态、记忆侧按 traceId 折叠、空注入标「无结果」、**正文不出现**。

## 8. 验证结果（本轮实际跑的）

| 项 | 命令 | 结果 |
|---|---|---|
| 陪伴空间单测 | `node scripts/run-tests.mjs` | **236 / 236 pass / 0 fail**（W1 后 193 → 本轮 +43） |
| 字段目录核对 | `npm run check:catalog` | ✓ 三份一致 |
| 客户端拼装 | `node scripts/build-client.mjs` | 20 片段 / 768,132 字节 / `node --check` 通过 |
| 客户端冒烟 | `node scripts/smoke-client.mjs` | **失败 13 项**，全部在媒体页（既有基线，W5 处理）；诊断事件页与搜索面板的新增断言全绿 |
| 静态卫生 | `node scripts/verify.mjs --only=static` | 38 ok / 1 failed（`tools/lib/host-temp.test.mjs`，HEAD 就有） |

### 8.1 新增用例分布（43 个）

| 文件 | 用例 | 钉住什么 |
|---|---|---|
| `test/trace-schema.test.mjs` | 10 | 10 键形状、枚举不静默修补、未知码可见、counts 白名单与封顶、**四类内容探针必须被拒**、id 不透明、序列化键序、枚举与文档同步 |
| `test/trace-store.test.mjs` | 8 | 追加与读取顺序、轮转代数上限、写失败只记账不抛、队列溢出记 `queue-overflow`、四种过滤、坏行/不安全行跳过、跨零点回退、未知 counts 被剥 |
| `test/trace-stream.test.mjs` | 8 | 过滤解析与截断、空条件透传、推送即合规、服务端过滤、轮转去重、坏行计数、空目录非错误、**半行等待** |
| `test/trace-api.test.mjs` | 9 | 两条路由只 GET、快照 10 键、四种过滤、limit 只裁页、sinceId、SSE `ready`+`trace`、无 viewer 被拒、记忆侧投影、**读不到报 readable:false** |
| `test/trace-project.test.mjs` | 8 | retrieve+inject 配对、traceId 不透明且稳定、空注入报 empty、缺 explain 报 failed、垃圾输入不炸、主导理由确定、批量跳过计数、**正文不出现在输出** |

## 9. 与 W2 验收条件的对照

| W2 验收条件（计划 §3） | 状态 | 依据 |
|---|---|---|
| 一次对话能按 traceId 看到检索/过滤/注入/路由/组装/工具/最终输出各阶段 | **部分** | 记忆侧（检索→过滤→注入）与工具侧（`tool-start`/`tool-end`）的**承载机制**已就绪并有投影；路由/组装/最终输出的**事件源尚未接入**（需要 §6 说的方向决策，见下） |
| 日志能区分系统错误、业务空结果、降级、用户取消 | ✓ | 五个状态词是有限枚举，`empty`（业务空结果）与 `failed`（系统错误）分开；`degraded` 专指"违背契约" |
| 每个失败可解释最小 reasonCode | ✓ | 37 个码来自既有实现；表外码显示为 `unknown-reason` 而不是吞掉 |
| 前端可按模块/等级/traceId 过滤；时间线视图 | ✓（离线冒烟） | chip 过滤 + 服务端过滤生效；时间线行含时间/stage/模块/理由码/计数/耗时 |
| SSE 支持模块过滤、traceId 过滤、丢事件计数、轮转续读、2000 行客户端缓冲 | ✓ | §5 四条各有用例；客户端 `.slice(-2000)` |
| 不记录正文；敏感字段先过滤再落盘 | ✓ | 四类判据 + 落盘前 `isSafeEvent` 二审 + 读端再过滤（坏行/不安全行不入流） |
| 失败时保留最近一次成功 trace 与证据链接 | **部分** | 快照模式可读已落盘事件（即"上次成功的一轮"）；"证据链接"指向配置/日志的跳转还没接 |

## 10. 未接入的部分（明确记账，不当作已完成）

计划 W2 还要求 `prompt router / compose / snapshot` 与"最终输出"阶段的事件。**本轮没有插入这些埋点**，原因有两条：

1. 那些阶段在 `companion-foundation` 里，让它 import Studio 的 `trace-schema` 会把 UI 层变成下层依赖；
2. 正确做法是反过来：由 Studio 的 `trace-writer` 通过一个**窄接口**（宿主已有的 `ctx` 服务或一份约定格式的 JSONL）接收它们的诊断行，与 §6 的投影同一套路。

这条和 W4 的"bridge 收窄"是同一类问题，放在 W4 之前一起处理更省事。

## 11. 证据等级

| 结论 | 级别 |
|---|---|
| schema 校验、脱敏判据、落盘环与轮转、SSE 去重/续读/半行、记忆侧投影 | `offline-test`（236 用例，含真 SQLite 引擎的 API 用例） |
| 诊断事件页可渲染、切档、过滤、按 traceId 折叠 | `offline-test`（沙箱内 React 渲染 + SSE 替身） |
| 真实宿主装载、浏览器实机、真实 SSE 经网络、屏幕阅读器 | **未执行** |
| 真实模型调用导致的真实 reasonCode 分布 | **未执行** |

**明确未做：真实宿主加载、浏览器实机与屏幕阅读器实测、`prompt/compose/snapshot/最终输出` 阶段的埋点、8790 listener 关停、任何真实模型调用或外发。**

## 11. 审查后的修正（PR #3 review）

首版提交被独立审查发现 1 个阻断与 4 个高危问题，本节记录实际改了什么、怎么验的。

| 项 | 问题 | 修法 | 现在的证据 |
|---|---|---|---|
| **H1** | SSE 单 tick 超过 `BATCH_CAP(200)` 就 `return`，超出上限的完整行**既不推送也不计数**；下一轮从块末尾读，它们静默消失，而 `drops.parsed` 与送达数还自洽到查不出来（实测 450 条只送达 369 / 286） | 偏移语义改成"**尚未消费的第一行的起点**"（按字节）；一批读到的行按 `BATCH_CAP` 停下，偏移只推进到那一行行尾，其余留给下一 tick 并计入 `backlog`（不是丢弃） | `more than BATCH_CAP in one tick is delivered across ticks, nothing silently lost`：450 条全部送达，`backlog` 最终归零 |
| **H2** | 残余半行被拼两遍（`carried` 拼在块前 + 偏移停在半行起点），该行必丢且 `corrupt` 仍为 0；原用例只覆盖 `start === 0`（`carried = ''`）所以是绿的 | 删掉 `partials` 缓冲：偏移本身就指向半行起点，重读不需要 carry。偏移一律按**字节**算（原实现用 `text.length` 减字节偏移，非 ASCII 会漂移） | `a half-written line is delivered even after the offset already exists`（先送达一条让偏移非 0，再写半行、再补齐）+ `non-ASCII lines do not make the byte offset drift` |
| **M1** | 文件序是"当日 → .1 → .2"，`rows.slice(-limit)` 取到**最老一代的尾部** | 读取顺序改成"最老代数 → … → 当日"，`rows` 按时间正序，`slice(-limit)` 自然取最新 | `a snapshot limit picks the newest generation, not the oldest` |
| **M2** | `sinceId` 只丢命中的那一条（e1..e5 传 e3 → `e1,e2,e4,e5`），而 `trace-api.test.mjs` 还把错误行为固化成断言 | 语义改成"这条及之前都不要"（`start = found + 1`）；找不到这条时不猜边界、原样给 | `sinceId drops that event and everything before it`（含"已追平 → 空"与"找不到 → 全给"两个边界）；API 用例改成断言 `['evt_3','evt_4']` |
| **M3** | `at` 是唯一不过内容判据的字符串字段（中文正文可原样落盘），且 `at: NaN` 让 `new Date(NaN).toISOString()` 抛 `RangeError`，而写入端从不该抛给调用方 | `at` 走与其它字段同一套 `looksLikeContent`；不可解析时记 `bad-at` 并回退到处理时间；`isSafeEvent()` 也补上 `at` 的内容与可解析判据 | 三条用例：正文被降级成 `event-rejected`、`NaN` 不再抛、合法 ISO 原样通过 |
| **M11** | `/trace-memory` 每次请求把整个 `memory-recall.jsonl` 读进内存再切尾 | 按字节从末尾读，最多 512 KiB；从中间切进来的首行丢弃；非普通文件（例如被建成目录）明确回 `read-failed`，不装作"空日志" | 既有 `readable:false` 用例 + `truncated` 字段 |
| 低 | `EventSource` 原生无限重连，注释却写"不自动重连" | 断开即 `close()`，由用户决定重开 | 代码路径（无 SSE 浏览器环境，未做浏览器实测） |
| 低 | 时间显示用 UTC 的截串，中国用户看到早 8 小时 | `P.fmt.clockSeconds`（走 `core.js` 的 `Asia/Shanghai`） | 代码路径（同上） |

### 必须点明的事实：写端还没有接线

`createTraceWriter()` **全树零生产调用方**（只有测试引用）。所以本 PR 上线后，
生产里不会有任何 `trace-*.jsonl` 写入者，上图这些丢事件修正在线上是**潜伏**的。
模块头的"不丢、不重放"目前只对**读端**成立；接写端（router / compose / final）是下一步的工作。
这一点在 `docs/07-verification-status.md` 里也如实标注了。

## 12. 第二轮复核后的修正（N10 / N8 / N11 / N12）

第二轮复核确认 H1/H2/M1/M2/M3 都修到位，但指出三处新问题。逐条修完，每条都有一条
**能在旧实现上失败**的用例。

| 项 | 问题 | 修法 | 钉住它的用例 |
|---|---|---|---|
| **N10** 轮转跳段 | `offsets` 只按**路径**记：轮转把 `base` 改名 `base.1` 后，新的 `base` 沿用旧偏移。新文件通常比旧那一刻更大，于是从中间读起，开头几条既没送达也不计数（实测漏 `r4,r5,r6`，`corrupt/unsafe/backlog` 全 0） | 偏移改记 `{ offset, identity }`，identity = `ino + birthtimeMs`：rename **保留身份**（`base.1` 继续从原偏移读），新建的 `base` 身份变了就从 0 读 | `trace-stream.test.mjs`"轮转后新文件更大且只含新事件"：旧实现送达 `r1,r2,r3,r7,r8`（漏 3 条），新实现 8/8 全到 |
| **N8** 只涨 `corrupt` 的 tick 不出帧 | 出帧条件是 `backlog > 0 && (corrupt \|\| …)` —— `backlog` 恰好为 0 时（追加一行非法 JSON 就是这种情况）永远不出帧，前端 `corrupt` 停在 0 | tick 开头记计数器快照，结束只要**任何**计数器变了就发一帧空 `trace`（带 drops）；UI 补上"待读 N 字节" | "只涨 corrupt 也必须出帧"：旧实现零帧，新实现有帧且 `corrupt>=1` |
| **N11** 超长行计两次 | 单行 > 64 KiB 时第一 tick 记 `corrupt` 并前移一个读窗口，第二 tick 把残余再当坏行记一次 → 一条逻辑坏行记成两条 | 超长行起点标记：同一段只记一次；chunk 里出现换行时，若它前面还有未结束的超长行，则 chunk 首行是那条坏行的**尾巴**，整行吞掉不计数 | "一条超长行只记一次 corrupt"：70 KB 单行 + 一条好事件 → `corrupt === 1` 且好事件仍送达（旧实现 2） |
| **N12** 成功面缺 `readable` | 错误面回 `readable:false + reason`，成功面不带这个布尔 → 客户端没法用同一个字段区分"读到空"与"读失败" | 成功面补 `readable: true` | `trace-api.test.mjs` 断言成功响应 `readable === true` |

**仍然成立的事实**：`createTraceWriter()` **零生产调用方**（只有测试引用）。所以 N8/N10/N11 这三条
在线上是**潜伏**的 —— 读端契约现在是完整的（不丢、不重放、少了什么都可解释），写端还没接。
接写端（router / compose / final）是下一步工作。
