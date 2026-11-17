# A 包接口草案：记忆查询构造与双门控（query plan + retrieval gate + injection gate）

- 状态：**草案，已随本包实现**（E1/E2 级证据，见 §9）
- 负责人：teammate `memory-relevance`（A 包）
- 独占写入范围：`plugins/companion-memory/{lib/retrieve.mjs, lib/policy.mjs, lib/render.mjs, lib/fusion.mjs, lib/config.mjs, lib/text.mjs, index.mjs}` 与 `test/**`、`docs/*.md`
- 非本次范围：`plugins/companion-foundation/**`（接线由 Lead 完成）、数据库 schema、迁移、模型调用
- 关联计划：`next-stage-autonomy-grounding-plan-20261114.md` §5 A（6 条）、§7 文件所有权、§8 证据等级

## 1. 输入

`recall()`（`lib/retrieve.mjs`）新增**可选**入参，全部有默认值，旧调用不传也能工作：

| 入参 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `query` | string | `''` | 本轮用户原文（`agent/pre-step` 传入最近一条用户消息文本） |
| `mode` | `'auto' \| 'explicit'` | `'auto'` | 检索用途。`auto` = 自动注入（系统提示里被动塞资料）；`explicit` = 显式 `companion_recall` 工具调用 |
| `sessionId` | string | `viewer.sessionId` | 承接链取「最近用户确认语句」的会话键；缺失时退化为「最近确认记忆」 |
| `viewer` | `{userId, personaId, worldId}` | 必须 | 作用域；缺失即返回空（既有行为不变） |
| `config` | object | `{}` | 新增标量：`queryPlanEnabled`、`continuationEnabled`、`historyFallbackEnabled`、`identityTopK`、`identityReserve`、`anchorWindowMs`、`anchorLimit`（见 §4） |
| `now` | ms / ISO / Date / fn | `Date.now()` | 时钟，测试注入 |
| `db` / `embedder` / `reranker` / `log` | — | — | 既有入参，语义不变 |

`config.mjs` 的 `DEFAULT_CONFIG.retrieval` 追加同名标量（全部是标量，因为 `normalizeConfig` 的
`sanitizeShape` 会删掉 section 内的嵌套对象）。**未在 `memory.config.json` 里出现的键一律取默认值。**

## 2. 输出

`recall()` 的返回结构**只追加，不删改**：

```js
{
  entries: [{ record, score, channels, section }],   // 既有，字段与顺序语义不变
  explain: { ...既有 8 个键... },                    // 既有，键集合不变（有测试逐键断言）
  queryPlan: {                                       // 新增（本包要求暴露的构造来源）
    version: 1,
    source: 'raw' | 'weak-intent' | 'continuation' | 'explicit-history',
    topicText: string,        // 实际用于字面/向量通道的查询文本（可能是空串）
    matchText: string,        // 第二轮锚点查询文本（无则 ''）
    entities: string[],       // ≤6 个短词元，取自用户自己的原话/锚点与命中记录的公共词元
    events: [{ ref, terms }],  // ≤3 个锚点引用（会话证据 sourceId 或记忆 id）+ 公共词元
    dropped: { [code]: number },// 被丢弃的来源计数（只含计数与固定 code，不含正文）
    weakIntent: boolean,
    anaphora: boolean,
    explicitHistory: boolean,
    anchorCount: number,
  },
  gates: {                                           // 新增：两个门各自的判定结果（计数，不含正文）
    retrieval: { purpose, admitted, suppressed: { [code]: number } },
    injection: { mode, counts: { full, soft, hint, placeholder, skip } },
  },
}
```

`renderContext()` / `renderRecallResult()` 返回结构同样只追加：

- `renderContext({ entries, identityText, budget, mode='auto' })`：**返回字符串不变**（`''` 表示不注入）。
  新增 `renderInjectionPlan()` 导出，返回 `{ mode, lines, counts, used, dropped }` 给日志/接线用。
- `renderRecallResult({ entries, limit, mode='explicit' })`：既有字段全保留，追加顶层 `mode`。
  每条的 8 个键（`id,value,type,reality,at,source,policy,score`）**完全不变**（有测试逐键断言）。

## 3. 默认行为

1. **查询构造**默认开启（`retrieval.queryPlanEnabled=true`）。判定顺序：
   - 含示记/时间指示词（`上次/上回/之前/以前/我说过/说过什么/还记得/记得/回忆/聊过/提过`）→
     去掉指示词后的剩余文本做主题；无剩余时 `topicText=''` 走历史兜底。`source='explicit-history'`。
   - 查询词元 ≤2 且所有词元在库内 df=0（没有可检索锚点，如「早」「早安」「在吗」）→ `source='weak-intent'`，
     `topicText=''`，走**身份稳定资料路径**（不与话题召回抢预算）。
   - 含代词类闭类词（`他/她/它/对方/那人/这人/其`）→ 标记 `anaphora=true`；若第一轮主题召回为空，
     用最近**用户确认语句**做第二轮锚点召回，`source='continuation'`。
   - 其余 → `source='raw'`，`topicText=query`（既有行为逐字不变）。
2. **承接来源只认用户确认**：会话证据只取 `role==='user'`；记忆只取
   `realityLevel==='explicit_user_statement'`（且 scope ∈ 现实作用域）。助手自己的话、`inferred`、
   `imported_summary`、`bot_action`、`roleplay_fiction`、`user_utterance_not_verified_fact` 一律丢弃并计数。
3. **检索资格门**（`policy.retrievalEligible(row, {now, purpose})`）：作用域/状态/有效期 + 用途差异。
   `purpose='auto'` 额外拒绝 `inferred` 与 `bot_action`；`purpose='explicit'` 允许（用户的显式查询可以拿到候选，
   但展现仍受注入门约束）。
4. **自动注入门**（`policy.injectionGate(row, {mode})`）：独立判定“这一行能不能以什么形态进提示词/工具结果”：
   - `avoid_unless_asked` → 占位（两种用途都占位，沿用既有冻结语义：模型知道存在，拿不到正文）
   - `tone_only` → `auto` 只给提示行（`type:'tone'`，无 `value`）；`explicit` 给正文（用户显式问）
   - `soft_echo` → 正文 + `policy` 标签（自然呼应，既有行为）
   - `direct` → 正文
5. **身份稳定资料单独限额**：`identityTopK`（弱意图路径的条数，0=跟随 `topK`）与
   `identityReserve`（话题路径为稳定资料保留的槽位数，默认 1）。预留槽位**只从已通过门的候选池里挑**，
   绝不“无中生有”，因此无关话题仍为空。
6. **显式历史查询兜底**：`explicit-history` 且主题召回为空时，用「最近确认的用户事实」做有界兜底
   （`realityLevel ∈ {explicit_user_statement, imported_fact}`，上限 `identityTopK || topK`），保证
   门槛提高后不会把所有显式历史查询都变空。兜底行同样过两道门。

## 4. 开关

| 键（`memory.config.json` → `retrieval`） | 默认 | 作用 |
|---|---|---|
| `queryPlanEnabled` | `true` | 关掉即回到旧行为（查询原文直接检索，无 queryPlan 判定） |
| `continuationEnabled` | `true` | 关掉后不做承接锚点第二轮 |
| `historyFallbackEnabled` | `true` | 关掉后显式历史查询不再兜底（回空） |
| `identityTopK` | `0` | 0 = 跟随 `topK`；>0 = 身份路径的独立条数上限 |
| `identityReserve` | `1` | 话题路径为稳定资料保留的槽位数（0 = 关闭） |
| `anchorWindowMs` | `21600000`（6h） | 承接锚点的最大时差 |
| `anchorLimit` | `3` | 锚点条数上限 |

注入预算（`injection.budgetChars`、`policy.BUDGET` 的四个分节比例）**不改动**：既有测试逐值断言
（`identity=466` 等），改比例会破坏基线。身份限额是用**条数**与**槽位**实现的，不动字符比例。

## 5. 失败码（稳定，全部进 `queryPlan.dropped` / `gates` / `explain.filteredReasons`，不含正文）

- 来源侧：`assistant-utterance`、`inferred-reality`、`imported-summary`、`bot-action`、
  `roleplay-fiction`、`unverified-utterance`、`no-anchor`、`stale-anchor`
- 检索资格门：`inferred-not-auto`、`bot-action-not-auto`、`inactive`
- 注入门：`avoid-unless-asked`、`tone-only-auto`、`tone-only-explicit`、`soft-echo`、`direct`
- 既有：`low-coverage`、`semantic-no-overlap`、`semantic-below-floor`、`missing-vector`、
  `lexical-error`、`vector-error`、`recall-error` 等保持不变。

## 6. 作用域

- 任何读路径仍先过 `policy.scopeMatches`（user + persona + world 三元匹配，剧情世界不外泄）。
- 承接锚点额外要求 `scope ∈ REAL_USER_SCOPES`（`user_global`/`user_persona`/`session_recent`），
  剧情世界（`roleplay_world`）与 `persona_self` 永不作为现实承接来源。
- 跨用户/跨群：本轮**不新增**群聊路径；`viewer` 缺失即返回空（既有行为）。

## 7. 时区

- 锚点时差一律按 UTC ISO 比较（`Date.parse`），窗口 `anchorWindowMs` 以毫秒计，与展示时区无关。
- 面向模型的时间文本仍是 `text.formatMoment()` 的 Asia/Shanghai `YYYY-MM-DD HH:mm`，本包不改。

## 8. 兼容方式（旧调用零字段仍可工作）

1. `recall({db, embedder, viewer, query, config, now})`：不传 `mode`/`sessionId`/新 config 键 → 默认
   `purpose='auto'`、`source='raw'`（查询文本逐字使用），行为与旧版一致。
2. `explain` 的键集合**不新增**（有 `Object.keys(explain)` 逐键断言），新信息全部放 `queryPlan`/`gates`。
3. `renderContext()` 仍返回字符串；新形态只对 `tone_only` 行生效（旧版会把它的正文塞进提示词，是本次要修的泄漏）。
4. `renderRecallResult()` 每条 8 键不变，只追加顶层 `mode`。
5. `isPromptEligible(row, now)` 签名不变；语义收紧为「通过注入门且 active」，`pending`/`archived` 仍为 `false`。
6. `plugins/companion-foundation/memory-mount.test.mjs` 用 `index.mjs?v=0.4.0` 导入：`createMemoryEngine`、
   `contextFor`、`recall`、`remember` 等导出名与签名不变，`recall` 只追加返回字段。

## 9. 证据等级与边界

- 本包可宣称：**E2**（合成用例离线通过：`node --test plugins/companion-memory/test/*.test.mjs`）。
- 不可宣称：真实语义质量、真实宿主装载（E3）、真实模型（E4）、真实送达（E5）。
- 已知失败案例与剩余风险写在 `docs/A-memory-query-gate-report.md`。
