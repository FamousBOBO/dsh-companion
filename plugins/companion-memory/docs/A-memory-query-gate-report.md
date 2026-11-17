# A 包实施报告：短句查询构造 + 两道独立的门

对应计划 §5 A（1–6）。本文件只写**已做到什么、证据到哪一级、缺口在哪**，
不写「语义质量已验收」这类结论。

- 证据等级：**E2**（离线单测 + 合成夹具 + 临时 SQLite）。E3（真实库回归）、
  E4（宿主端到端对话）、E5（长期在线观察）**未执行**。
- 数据：全部合成中文夹具，中性身份 `user_gate` / `user_synth`，临时目录；
  未读取、未复制 `data/` 下任何内容；无新表、无迁移、无新增模型调用。

---

## 1. 偏离点定位（有证据，不靠直觉）

用临时库探针（合成数据）复现了三条真实失败，结论都落在**查询构造**与**缺失的门 2**，
不在 RRF / MMR / rerank / 预算：

| 探针 | 现象 | 定位 |
|---|---|---|
| `他太顽固` | `backend=none`，0 条；`coverage.best=0.1189 < floor 0.15`；`low-coverage×12` | `recall()` 把**整句**直接切二元组丢给两条通道（`retrieve.mjs` 旧 `const queryTerms = new Set(terms(text))`），没有承接上下文；「顽固」只能命中噪声行，随后死在覆盖率闸门（`buildCoverageStats` / `recordCoverage` / `coveragePasses`） |
| `早` | `terms('早')` 为空，两通道空；`semantic-no-overlap×14` | 问候语没有任何主题分支；空查询专用的 recent 分支只在 `text === ''` 时进入，问候够不着（旧 `retrieve.mjs` 的 `if (!text) { … recent … }`） |
| `上次我说过什么` | 0 条，静默全空 | 元记忆问句同样没有分支；`terms()` 抠不出可检索主题 |
| `tone_only` 行 + 问候 | 该行**以正文形态**进了注入文本 | 旧渲染层只特判 `avoid_unless_asked`（`render.mjs` 旧 `isHidden()`）；`retrieve.mjs` 全程没调用过任何 mentionPolicy 门 |

---

## 2. 改动清单

| 文件 | 类型 | 作用 |
|---|---|---|
| `lib/query-plan.mjs` | 新增 | `buildQueryPlan()`：原句 → 短句主题 + 承接上下文 + 溯源；`summarizeQueryPlan()` 给对外溯源的**去正文**版本 |
| `lib/injection-gate.mjs` | 新增 | 门 1 `eligibleForRetrieval()`；门 2 `presentationFor()` / `injectionDecision()` / `allowAutoInjection()` / `carriesBody()` / `countInjectionRenders()` |
| `lib/render.mjs` | 改 | 按门 2 的 `render` 值真正降级：`full`/`soft`/`hint`/`placeholder`/`skip`；新增可选 `purpose` / `viewer` / `now` |
| `lib/retrieve.mjs` | 改 | 接入 `buildQueryPlan`；两轮词法（原句 + 承接上下文）；弱意图身份配额；身份保留槽位；门 1 改为委托 `eligibleForRetrieval`；返回值追加 `queryPlan` / `gates` |
| `lib/policy.mjs` | 改 | 追加 `RETRIEVAL_PURPOSES` / `INJECTION_RENDERS` 两个枚举（不改任何既有导出签名） |
| `config.mjs` | 改 | `DEFAULT_CONFIG.retrieval` 追加 7 个**标量**开关 + 夹取（`sanitizeShape` 会删嵌套对象，故必须标量） |
| `index.mjs` | 改 | `contextFor` 传 `purpose:'auto'` + `sessionId`；`recall` 传 `purpose:'explicit'`，并把 `queryPlan`/`gates` 透出 |
| `docs/A-memory-query-gate-draft.md` | 新增 | 接口草案（输入/输出/开关/理由码/兼容性/证据等级） |
| `test/query-plan.test.mjs` | 新增 | 10 条纯函数用例（含必测 1、2、5） |
| `test/injection-gate.test.mjs` | 新增 | 9 条两门用例（四类策略负例） |
| `test/render-gate.test.mjs` | 新增 | 7 条**门 2 生效性**用例（降级真的改变注入文本） |
| `test/query-gate-integration.test.mjs` | 新增 | 7 条端到端用例（必测 1–5 + 无关查询 + 空查询回归） |

未触碰：`plugins/companion-foundation/**`（含 `memory-mount.test.mjs`）、
`plugins/companion-runtime/**`、`plugins/dsh-channel-qq/**`、`scripts/**`、根 `docs/**`、`config/**`。

---

## 3. 门 2 降级规则表

门 1 决定「能不能读」，门 2 决定「以什么形态出现」。**默认 `purpose='auto'`**，
显式查询（`companion_recall`）传 `purpose='explicit'`。

| mentionPolicy | realityLevel | auto（自动注入） | explicit（用户开口问） | 理由码 |
|---|---|---|---|---|
| `direct` | 除 `inferred` 外 | `full`（正文，**与旧输出逐字节相同**） | `full` | `direct` |
| `direct` | `inferred` | `hint`（固定提示，无正文） | `full` | `inferred-hint-only` |
| `soft_echo` | 任意 | `soft`（正文 + `（仅可自然呼应，不可当作已确认事实）` 前缀，正文 ≤160 字） | `soft` → 原始正文，无前缀 | `soft-echo` |
| `tone_only` | 任意（含 `bot_action`） | `hint`（`（有一件相关的事，只提示存在，细节未展开）`，不引用正文） | `full` | `tone-only-auto` / `tone-only-explicit` |
| `avoid_unless_asked` | 任意 | `placeholder`（既有 `type:"hidden"` 行：id/type/reality/policy） | **仍 `placeholder`**（召回工具不是索取私密的授权） | `avoid-unless-asked` |
| 未知 / 缺字段（旧数据） | 任意 | `full`（不能静默丢内容） | `full` | `direct` |
| 门 1 不通过（pending/archived/过期/跨作用域/别人的） | — | `skip`（完全不渲染，不靠预算兜） | `skip` | 复用 `retrieve.mjs` 的理由码 |

补充约定：

- `renderContext` / `renderRecallResult` 的 `purpose`、`viewer`、`now` 全部**可选**，
  缺省即旧行为；只有被政策判定为受限的行才降级，`direct` 行逐字节不变（有专门回归用例）。
- 预算：降级后仍受 `budgetChars`（默认 2400）约束；`hint`/`placeholder` 行不把正文交给
  打包器（连去重指纹都不给）。
- `soft` 行在 auto 下带前缀但**保留正文**：承诺/约定必须能被自然呼应，压成提示会
  让「还没出发」这类约束丢掉（`integration.test.mjs` 第 4 条依赖它）。

---

## 4. 查询构造规则（`buildQueryPlan`）

输入：`{ query, anchors, enabled, continuationEnabled, historyFallbackEnabled, anchorWindowMs, anchorLimit, now }`
输出：`{ version, source, topicText, matchText, entities, events, dropped, weakIntent, anaphora, explicitHistory, anchorCount, historyFallback }`

| 分支 | 触发 | 主题 | 说明 |
|---|---|---|---|
| `weak-intent` | 整句去掉问候/附和闭类词后什么都不剩 | **空** | 绝不推断「刚睡醒/刚起床」；`dropped['weak-intent-empty-topic']=1`；召回只走 `identityTopK` 身份配额 |
| `explicit-history` | 整句去掉元记忆标记 + 填充语后什么都不剩 | **空** + `historyFallback:true` | 门槛提高后仍不静默全空 |
| `continuation` | 含代词（剥掉「其实/其他/尤其/其中…」假朋友后）且有**用户确认过**的锚点 | 原句 + `matchText`（锚点词元） | 第二轮词法用 `matchText`，权重 `CONTINUATION_WEIGHT=0.85` |
| `raw` | 其余（含开关关闭、无可用锚点、空查询） | 原句 | 与旧版逐字一致 |

锚点准入（`anchorRejection`）：只收 `role='user'`（或 `role='memory'` 且
`realityLevel ∈ {explicit_user_statement, imported_fact}`）、`scope ∈ {user_global, user_persona, session_recent}`、
在 `anchorWindowMs`（默认 6h）内。丢弃并按固定 code 计数：`assistant-utterance`、`inferred-reality`、
`imported-summary`、`bot-action`、`roleplay-fiction`、`unverified-utterance`、`scope-not-real`、
`stale-anchor`、`no-confirmed-anchor`。**助手自己的猜测永不进入承接**。

对外溯源：`recall()` 返回的 `queryPlan` 是 `summarizeQueryPlan()` 的结果，
**不含 `topicText` / `matchText`**（那两段是用户原句回声；塞进返回值会让每个调用方
都拿到一句聊天副本，也会让「某段旧正文是否还在召回结果里」永远为真）。

---

## 5. 测试结果（实际执行）

```
node --test plugins/companion-memory/test/*.test.mjs
  tests 301   pass 294   fail 0   skipped 7        （基线为 268 / 261 / 0 / 7）
node --test plugins/companion-foundation/memory-mount.test.mjs
  tests 11    pass 11    fail 0
```

7 条 skip 是既有环境/真实库用例（真实库不存在时跳过），非本次新增。

新增文件与用例数：`query-plan.test.mjs` 10、`injection-gate.test.mjs` 9、
`render-gate.test.mjs` 7、`query-gate-integration.test.mjs` 7 = **33 条**。

必测五条与测试名对照：

| 必测 | 用例 |
|---|---|
| 问候「早」不推「刚睡醒/刚起床」 | `query-gate-integration.test.mjs` §1；纯函数侧 `query-plan.test.mjs`「问候「早」给出空主题…」 |
| 「陪父亲复诊」→「他太顽固」承接 | `query-gate-integration.test.mjs` §2；纯函数侧「承接链…」 |
| 无关亲密旧事不自动注入 | `query-gate-integration.test.mjs` §3；`injection-gate.test.mjs`「不相关但可见的旧亲密记录…」；`render-gate.test.mjs`「tone_only 的 bot_action…」 |
| 用户明确纠正覆盖旧摘要 | `query-gate-integration.test.mjs` §4 |
| 显式历史查询仍召回 | `query-gate-integration.test.mjs` §5；纯函数侧「显式历史查询…」 |

四类隐私策略负例：`injection-gate.test.mjs` 四 + 两条（`tone_only` / `avoid_unless_asked` /
`soft_echo` / `direct` 基线 / 门 1 不代偿门 2 / 计数），生效性由 `render-gate.test.mjs` 覆盖。

三个正例不回归：`direct` 逐字节相同、`soft_echo` 正文保留、空查询回落 recent ——
分别在 `render-gate.test.mjs`「direct 行…逐字节相同」「soft_echo…」与
`query-gate-integration.test.mjs` §7 断言。

---

## 6. 仍未解决 / 需要 Lead 接线的点

1. **`index.mjs` 已改，Foundation 侧只读不改**：`contextFor`/`recall` 现在传
   `purpose` 与 `sessionId`；`companion-foundation/index.mjs` 的 `agent/pre-step`
   与 `companion_recall` 若想拿到 `gates`/`queryPlan` 需要 Lead 在自己的文件里读新字段
   （不改也工作，只是少了这两块观测）。
2. **`queryPlan` 不含 `topicText`/`matchText`**（安全取舍，见 §4）。若 Lead 需要
   「为什么这次看起来像问候却没召回」，只能读 `source` + `dropped` + `weakIntent`。
3. **承接的锚点来自 `db.eventsForSession`，最多 12 条**：只覆盖**本会话**最近用户消息。
   跨会话承接（用户隔天说「他太顽固」）不成立——这是有意的窗口限制，但也是已知缺口。
4. **`identityReserve` 默认 0**（关闭），仅 `identityTopK=3` 在弱意图路径生效。
   话题路径上的身份保留槽位是**可选**的，默认不开，因为打开会改变 `topK` 排序的
   既有观感；要不要默认打开需要 Lead 决策。
5. **`soft_echo` 前缀只加在 auto 注入**，Wiki 页面仍按原样写正文（`wiki.mjs` 只特判
   `avoid_unless_asked`）。若要求 Wiki 也降级，属于另一个模块的改动。
6. **真实库（E3）未跑**：现有真库验收用例在无库时跳过。真实 777 条语料上的
   「问候不推演」「承接命中率」都没有实测数字，本报告不主张任何精度指标。
7. **已知仍会误召回的情况**（合成夹具实测，未修）：
   - 只命中一个高频二元组的长问句仍可能被覆盖率闸门放过（`coverageFloor` 不变，沿用冻结值 0.15）；
   - 承接依赖代词闭类词，「老王太顽固」这种不含代词的句子不会承接；
   - `historyFallback` 只是「允许回落最近重要记忆」，**没有**回答「上次说过什么」的
     语义排序，靠的是 importance + 时间。
8. **`explain` 键集合未变**（`retrieve.test.mjs` 逐键断言仍绿）；新观测放在
   顶层 `queryPlan` / `gates` 两个字段。

---

## 7. 兼容性声明

- `retrieve.recall()` 新增全部可选参数（`sessionId` / `purpose` / `mode`），返回值只**追加**
  `queryPlan` 与 `gates`；旧调用（不传）行为逐字不变（`retrieve.test.mjs` 30 条全绿）。
- `renderContext` / `renderRecallResult` 新增全部可选参数；`direct` 行走旧代码路径。
- 未新增数据库表/列/迁移，未新增模型调用（默认路径零计费）。
- `memory-mount.test.mjs`（Foundation 宿主面）11 条全绿，未修改该文件。
