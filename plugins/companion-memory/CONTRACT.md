# companion-memory 模块契约（v0.4.1）

本文件是并行开发的唯一接口依据。任何模块都不得修改别人的文件；接口要改先在任务里提出，由 Lead 更新本文件。

版本记录：v0.4.1（2026-10-29，P1 C3）新增 §16 `engine.ingestDomainEvent` —— `companion-runtime`
跨库写入记忆的唯一公共入口。本文件的其它条目全部不变；`index.mjs` 的引擎实现版本（`VERSION`）
仍为 `0.4.0`，包版本未动，避免与已冻结的 `status().version` 断言冲突。

修订：v0.4.1 复审修补（2026-10-29，Codex 审阅 B1/N1）——§16.1 明确证据键必须是 scoped tuple
并新增复用前校验与 `evidence-conflict`，§16.5 补该理由码，§16.6 记录收据通道的版本兼容检查与
「主 `schemaVersion` 保持 2」这一有意保留的妥协。接口签名不变，`VERSION` 不变。

## 1. 目标与边界

- 目标：把「DSH bot陪伴基座」的记忆从 `state.json` + 只读快照升级为
  **SQLite 结构化事实 + FTS5 字面检索 + 向量通道（可配置，失败降级）+ Wiki 主题页 + 陪伴连续性**。
- 不重写已稳定的宿主层：人格注入、身份绑定、预设挂载、工具名与参数保持兼容。
- 零外部依赖：只用 Node 内置模块（`node:sqlite`、`node:crypto`、`node:fs`、`node:path`）。
  `node:sqlite` 必须动态 `await import('node:sqlite')`，缺失时允许降级，不允许抛到聊天路径。
- 代码注释用英文，面向用户/模型的文本用中文。

## 2. 目录与所有权

| 文件 | 所有者 | 说明 |
| --- | --- | --- |
| `lib/text.mjs`、`lib/policy.mjs`、`lib/schema.sql`、`CONTRACT.md` | Lead | 已冻结的公共契约；只允许 Lead 修改 |
| `lib/db.mjs`、`test/db.test.mjs` | store-engine | SQLite 打开、迁移、事务、查询、FTS、作业、备份 |
| `lib/import.mjs`、`scripts/migrate-memory.mjs`、`test/import.test.mjs` | migrator | 旧 JSON → 新库的只读幂等迁移与对账 |
| `lib/validate.mjs`、`lib/extract.mjs`、`test/extract.test.mjs` | extractor | 候选事实结构与闸门、提示词、模型输出解析 |
| `lib/wiki.mjs`、`test/wiki.test.mjs` | wiki | 三个主题页 + 索引的编译、生成区/人工区、原子写 |
| `lib/embed.mjs`、`lib/fusion.mjs`、`test/fusion.test.mjs` | embedder | 向量 provider、RRF 融合、MMR 去重、预算装填 |
| `lib/retrieve.mjs`、`lib/render.mjs`、`test/retrieve.test.mjs` | retriever | 混合召回编排、过滤、注入文本渲染 |
| `lib/capture.mjs`、`lib/jobs.mjs`、`test/capture.test.mjs` | capture | 事件捕获、防回声、任务游标与重试 |
| `index.mjs`、`config.mjs` | Lead | 引擎装配、宿主钩子、工具注册 |
| `test/integration.test.mjs`、`README` 相关章节 | verifier | 端到端与回归 |

测试统一放 `plugins/companion-memory/test/<name>.test.mjs`，`node --test` 直接跑。
每个测试文件用 `fs.mkdtempSync` 建临时目录（建议 `os.tmpdir()` 或仓库 `logs/test-runs`），并在 `t.after` 清理。

## 3. 规范记录 MemoryRecord

所有对外返回的记忆行必须是这个形状（db.mjs 负责从表列名映射到这里）：

```js
{
  id: string,                    // 'mem_<20hex>'
  scope: 'user_global'|'user_persona'|'persona_self'|'roleplay_world'|'session_recent',
  kind: 'fact'|'preference'|'profile'|'event'|'commitment'|'relationship'|'summary'|'bot_action'|'artifact'|'note',
  subject: string,               // 'user' | 'persona' | 'world' | 具体对象名
  predicate: string,             // snake_case，可为空串
  value: string,                 // 模型可见的一句话事实
  content: string,               // 可选补充正文，默认 ''
  confidence: number,            // 0..1
  importance: number,            // 0..1
  mentionPolicy: 'direct'|'soft_echo'|'tone_only'|'avoid_unless_asked',
  status: 'confirmed'|'pending'|'superseded'|'retracted'|'archived',
  realityLevel: 'explicit_user_statement'|'user_utterance_not_verified_fact'|'imported_fact'|'imported_summary'|'bot_action'|'roleplay_fiction'|'inferred',
  userId: string,
  personaId: string,
  worldId: string,               // 现实为 ''
  sourceKind: 'desktop_conversation'|'desktop_fact'|'astrbot_import'|'extracted'|'manual'|'system',
  sourceId: string,              // 对应 source_events.source_id，可为 ''
  dedupeKey: string,
  validFrom: string|null,
  validTo: string|null,
  occurredAt: string|null,
  createdAt: string,
  updatedAt: string,
  revision: number,
  supersedesId: string,
  tags: string[],
  searchText: string,
}
```

时间一律 ISO 8601 UTC 字符串（`new Date(...).toISOString()`）；数据库里 NULL 表示未设置。

## 4. lib/text.mjs（已冻结）

```js
normalizeText(v) -> string                 // NFKC + 小写 + 折叠空白
terms(v) -> string[]                       // 中文重叠二元组 + 拉丁词，去停用词
searchText(...parts) -> string             // 索引列写入形式：空格分隔 token
matchExpression(query, maxTerms=48) -> string|null   // FTS5 MATCH 表达式
contentHash(v) -> hex
stableId(prefix, ...parts) -> `${prefix}_${hex20}`
truncate(v, max, suffix='…')
redactSecrets(v) -> string
isoNow(clock?)
parseTime(v) -> ISO|null                   // 兼容 'YYYY-MM-DD HH:MM:SS.ffffff' 与 ISO
clamp(v, min, max)
```

**硬规则**：写入 `memories.search_text` 与查询 FTS 时必须都用本模块，否则召回失效。

## 5. lib/policy.mjs（已冻结）

导出常量 `SCOPES`、`KINDS`、`MENTION_POLICIES`、`STATUSES`、`REALITY_LEVELS`、`SOURCE_KINDS`、
`REAL_USER_SCOPES`、`BUDGET`、`RETRIEVAL_DEFAULTS`、`SESSION_STATE_TTL_MS`；
函数 `defaultMentionPolicy({kind, realityLevel, scope})`、`defaultImportance(kind)`、
`scopeMatches(row, viewer)`、`isActive(row, now)`、`isPromptEligible(row, now)`、
`realityLabel(row)`、`scopeLabel(scope)`、`isScope(v)`。

`viewer` = `{ userId, personaId, worldId }`。**任何返回记忆的读路径都必须先过 `scopeMatches`。**

## 6. lib/db.mjs（store-engine 实现）

```js
export const SCHEMA_VERSION = 1;
export const APPLICATION_ID = 1297303373;

export async function openMemoryDatabase({ file, readOnly = false, timeoutMs = 5000 })
// -> MemoryDatabase；自动建目录、打开 WAL、校验 application_id、按需执行 schema.sql、
//    写入 schema_meta.schemaVersion；遇到 foreign application_id 或 integrity 失败要抛错。
//    node:sqlite 不可用时抛错（调用方负责降级）。
```

`MemoryDatabase` 方法（全部同步，内部用 `prepare` 缓存语句）：

```js
db.file, db.handle            // handle 为 DatabaseSync
db.close()
db.transaction(fn)            // BEGIN IMMEDIATE / COMMIT / ROLLBACK，返回 fn 结果，可嵌套复用外层事务
db.integrityCheck() -> { ok, messages }
db.backup(file) -> { path, bytes }        // 使用 VACUUM INTO 或 SQLite backup，产出可用副本
db.meta(key) / db.setMeta(key, value)
db.schemaVersion()

// 身份与会话
db.upsertIdentity({ userId, displayName, platform?, platformId? })
db.upsertPersona({ personaId, displayName, revision?, personaRef? })
db.bindSession({ sessionId, userId, personaId, worldId = '', channel = 'desktop' })
db.sessionBinding(sessionId) -> row|null

// 证据（不可变、幂等）
db.appendEvent(row) -> { inserted: boolean, sourceId }
//   row = { sourceId?, eventKey, sessionId?, seq?, role, sourceKind, occurredAt,
//           content, userId?, personaId?, worldId?, meta? }
//   eventKey 冲突时不覆盖原始内容，返回 { inserted:false, sourceId: 既有 id }
db.getEvent(sourceId) -> row|null
db.eventsForSession(sessionId, { limit = 50, afterSeq = 0 } = {}) -> row[]
db.eventsSince({ userId, personaId, afterOccurredAt, limit }) -> row[]

// 记忆
db.insertMemory(record) -> { record, inserted: boolean }
//   record 至少含 scope/kind/subject/predicate/value/userId/personaId；
//   缺省值用 policy.defaultMentionPolicy / defaultImportance 补齐；
//   id/dedupeKey/createdAt/updatedAt/searchText 缺省时由 db 计算；
//   dedupeKey 已存在时不插入，返回既有记录（inserted:false）。
db.updateMemory(id, patch, { reason = '', actor = 'system' } = {}) -> record
//   允许改 value/content/confidence/importance/mentionPolicy/status/validTo/tags/predicate；
//   revision+1、updatedAt 刷新、FTS 同步、写 memory_revisions。
db.getMemory(id) -> MemoryRecord|null
db.findDuplicates({ userId, personaId, worldId = '', scope, subject, predicate, value }) -> MemoryRecord[]
db.listMemories(filter) -> MemoryRecord[]
//   filter = { userId, personaId, worldId?, scope?, kind?, status?, subject?, predicate?,
//              includeExpired?, limit?, offset? }
db.countMemories(filter) -> number
db.setStatus(id, status, { reason, actor }) -> record    // superseded/retracted/archived
db.rememberFact({ userId, personaId, key, value, ... }) -> MemoryRecord
//   companion_remember 的落库入口：同 subject/predicate 的新值走修订链
//   （旧记录 status='superseded' + 新记录 supersedes_id=旧 id + memory_revisions），
//   多值属性（predicate 前缀 multi:）允许并存去重。

// 证据关联
db.addEvidence(memoryId, sourceId, { evidenceKind = 'supports', confidence = 0.5 })
db.evidenceFor(memoryId) -> [{ sourceId, role, occurredAt, content, confidence }]
db.recordRevision({ oldId, newId, operation, reason, actor }) -> revisionId
db.revisionsFor(id) -> row[]

// 检索
db.fullTextSearch({ userId, personaId, worldId = '', query, limit = 32, scopes?, statuses = ['confirmed'] })
//   -> [{ id, rank }]，rank 为 bm25（越小越相关，已转成越大越好的分数：score = -bm25）
db.rebuildSearchIndex() -> { memories: number }

// 向量
db.putEmbedding(memoryId, { provider, model, dimensions, vector })   // vector 为 Float32Array
db.getEmbeddings({ provider, model, limit }) -> [{ memoryId, vector: Float32Array, dimensions }]
db.pendingEmbeddings({ provider, model, limit = 200 }) -> MemoryRecord[]
db.clearEmbeddings(provider?) -> number

// 关系
db.addRelation({ sourceRef, relation, targetRef, scope?, evidenceSourceId?, confidence? })
db.relationsFor(sourceRef, relation?) -> row[]

// 作业队列
db.enqueueJob({ type, streamKey = '', cursor = 0, payload = {} }) -> job        // 同 type+streamKey 未完成时复用
db.claimJob(type, { now = Date.now() } = {}) -> job|null                       // 取 pending 且 next_retry_at 到期，置 running
db.completeJob(jobId, { cursor } = {})
db.failJob(jobId, error, { retryDelayMs } = {})   // attempts+1、指数退避、超过 5 次置 failed
db.jobs({ state, type, limit }) -> job[]
db.jobStats() -> { pending, running, failed, done }

// Wiki 页登记
db.upsertWikiPage({ pageId, scope, topic, path, sourceRevision, contentHash, status, notes })
db.wikiPage(pageId) -> row|null
db.listWikiPages(scope?) -> row[]

db.stats() -> { memories, confirmedMemories, pendingMemories, events, embeddings, jobs, wikiPages, schemaVersion, file,
                integrityMode, integrityCheckedAt }
```

约定：
- 所有写操作在事务里；`dedupe_key` 与 `event_key` 唯一约束是幂等性的最后一道防线，捕获唯一约束错误要转成 `inserted:false` 的语义，不要冒泡。
- 布尔/JSON 列（`tags`、`meta`）在 db 层完成序列化与解析。
- 不允许在 db.mjs 里做业务过滤（作用域可见性由调用方用 policy 判定），但 `fullTextSearch` 必须接受并应用 `statuses` 过滤。

## 7. lib/import.mjs（migrator）

```js
export const IMPORT_MANIFEST_VERSION = 2;
export function mapArchiveRow(row, { userId, personaId }) -> MemoryRecordDraft | null
//   astrbot-import.json 的 767 条 → 新记录草稿；无法安全映射的返回 null 并计入 skipped 原因。
//   映射规则见 README/任务说明：旧 memoryType → (scope, kind, realityLevel, mentionPolicy, importance)。
export function mapStateFact(fact, { userId, personaId }) -> MemoryRecordDraft
export function mapConversationRecord(record, { userId, personaId }) -> { event, memory } | null
export async function runImport({ root, db, userId, personaId, dryRun = false, clock = Date.now() })
//   -> { report: {...}, inserted, deduped, skipped }
export function reconciliation({ archive, db, report }) -> { ok, checks: [{ name, ok, expected, actual }] }
```

硬规则：
- **只读旧数据**：不修改 `home/memory/astrbot-import.json`、`home/companion/state.json`、`home/memory/conversation.jsonl`。
- 每条导入记录的 `eventKey`/`dedupeKey` 必须稳定（用 `row.sourceId` 或 `row.id`），重复运行不产生副本。
- 导入前必须把上述三个文件复制到 `home/memory/backups/<stamp>/`（含 sha256），并把报告写到
  `logs/memory-migration-<stamp>.json`（不含敏感正文，只含 id、类型、计数、校验值）。
- 旧库 `conversation_summary` 不能当作用户确认事实：`realityLevel='imported_summary'`、`status='confirmed'` 但
  `mentionPolicy='soft_echo'`；`bot_action`/`artifact`（主动消息、生图）只能是 `persona_self` 或 `note`，
  绝不能进 `user_global`。

## 8. lib/validate.mjs + lib/extract.mjs（extractor）

```js
export const CANDIDATE_SCHEMA_VERSION = 1;
export function parseCandidate(raw) -> { ok: true, candidate } | { ok: false, errors: string[] }
//   手写校验（不引入 zod）：字段、枚举、长度、confidence/importance 范围、evidence_source_ids 非空。
export function gateCandidate(candidate, context) -> { decision: 'accept'|'pending'|'reject', reasons: string[], normalized? }
//   context = { evidence: [{ sourceId, role, content, occurredAt }], viewer, now }
//   规则：证据必须存在且属于当前 user/persona/world；台词/玩笑/未来计划/情绪的处理见计划 §5.3；
//   现实作用域与剧情作用域的晋升限制；同一 predicate 冲突交由 mergeDecision。
export function mergeDecision({ incoming, existing }) -> { operation: 'insert'|'update'|'supersede'|'duplicate'|'conflict', targetId?, reasons }
export function buildExtractionPrompt({ persona, viewer, messages }) -> { system, input, batchMeta }
//   输入为一批已捕获消息，输出要求严格 JSON（数组），中文提示词，强调不得编造、不得提升剧情为现实。
export function parseExtractionOutput(text) -> { candidates, errors }
export async function extractBatch({ llm, config, batch, viewer, persona }) -> { candidates, errors, usage }
//   llm 由 Lead 注入，接口 { complete({ system, input, maxTokens, signal }) -> Promise<string> }
```

## 9. lib/embed.mjs + lib/fusion.mjs（embedder）

```js
// embed.mjs
export function hashEmbedding(text, { dimensions = 256 } = {}) -> Float32Array   // 确定性、L2 归一化、无网络
export function cosineSimilarity(a, b) -> number
export async function createEmbeddingProvider(config, { fetchImpl = fetch } = {}) -> provider
//   provider = { provider, model, dimensions, version, embed(texts, { signal }), enabled(), health() }
//   config.provider: 'local' | 'remote' | 'off'；remote 走 OpenAI 兼容 /v1/embeddings，
//   连续失败 3 次熔断并在 cooldown 后重试；任何失败都降级到 local，绝不抛。
//   embed() 返回 EmbeddingBatch = Array<Float32Array>（等长、可下标、可 Array.isArray），
//   另带非枚举属性 vectors（自身）与冻结的 source = { provider, model, dimensions, version, degraded }。
//   一个 batch 绝不混源；降级时 source.provider='local' 且 degraded=true，**不得冒用配置的远端身份**。
//   调用方必须用 batch.source 作为索引键与闸门判断，绝不能使用 provider.provider/model 或配置值。
//   降级批次的向量不得写入远端索引键（宁可不写，等恢复）。
//   health() -> { provider, model, dimensions, version, failures, circuitOpenUntil, lastError, createdAt,
//                 degradedCount, lastDegradedAt, lastSource }（provider/model 是配置目标，真实来源看 lastSource）
// fusion.mjs
export function fuse({ lexical, semantic, rrfK = 60 }) -> [{ id, score, channels }]   // RRF
export function mmrSelect({ candidates, vectors, limit, lambda = 0.72 }) -> [{ id, score }]
export function packBudget({ entries, budget, weights }) -> { lines, used, dropped }
//   entries = [{ id, section: 'identity'|'stable'|'related'|'current', text, score, ... }]
```

## 10. lib/wiki.mjs（wiki）

```js
export const WIKI_TOPICS = [
  { id: 'user-profile', scope: 'user_global', topic: '用户画像与稳定偏好', path: 'user/profile.md' },
  { id: 'user-preferences', scope: 'user_global', topic: '用户偏好', path: 'user/preferences.md' },
  { id: 'relationship-bot', scope: 'user_persona', topic: 'bot与用户的关系', path: 'relationships/bot-user.md' },
  { id: 'important-events', scope: 'user_persona', topic: '重要共同事件与未完成承诺', path: 'events/important-events.md' },
];
export function renderPage({ topic, records, evidenceById, viewer, now }) -> { markdown, sourceRevision, entryCount }
export function renderIndex({ pages }) -> string
export async function compileWiki({ dir, db, viewer, now })
//   -> { pages: [{ pageId, path, sourceRevision, entryCount }], index, warnings }
//   原子写：临时文件 + rename；保留 `<!-- manual:begin -->` 与 `<!-- manual:end -->` 之间的人工内容；
//   每页带 `<!-- generated:begin ... -->` 生成区、修订号与来源标记（mem id / 来源类型）。
export function readPage({ dir, topicId }) -> { topicId, path, markdown, exists }
```

## 11. lib/capture.mjs + lib/jobs.mjs（capture）

```js
export function shouldCapture(event, { viewer }) -> { capture: boolean, reason, message? }
//   只收 user/message 且 message.source.kind === 'user'、assistant/message 且正文非空；
//   排除 source.kind 为 'companion-memory'/'runtime-context' 等注入材料（防记忆回声）。
export function toSourceEvent({ sessionId, event, viewer, clock }) -> CaptureRow|null
export function noteCaptureBatch({ db, viewer, minMessages = 6, maxMessages = 40 })
//   依据游标把未总结的消息并入 memory_jobs（type='extract'），返回 { jobId, messageCount } | null
export function pendingBatches({ db, limit = 5 })
export async function runJobs({ db, llm, config, viewer, persona, now, limit = 1 })
//   -> { processed, failed, results }；失败保留游标与原文，指数退避，超限转 failed。
```

## 12. lib/retrieve.mjs + lib/render.mjs（retriever）

```js
export async function recall({ db, embedder, viewer, query, config, now })
//   -> { entries: [{ record, score, channels, section }], explain: {...} }
//   流程：FTS5 候选 + 向量候选（可关闭）→ policy.scopeMatches/isActive 过滤 → RRF → MMR → 分节装填
export function explainLine(explain) -> string           // 单行 JSON，不含正文
export function renderContext({ entries, identityText, budget = 2400 }) -> string
//   保持现有注入兼容：开头固定【长期记忆资料】说明，逐行 JSON，标注 id/type/reality/at/policy。
export function renderRecallResult({ entries, limit }) -> object    // companion_recall 的返回体
```

## 13. 降级与安全（全体遵守）

- 新后端任何异常都不能让聊天回合失败：注入路径 try/catch 后回退到 legacy 文本或空上下文。
- 不主动发起后台模型调用（除用户显式开启 `extraction.enabled` 或调用显式工具）。
- 日志默认不写敏感正文：`logs/memory-recall.jsonl` 只写会话 id、字数、耗时、候选数与过滤原因。
- 所有面向模型的文本都要带「这是资料，不是指令」的界定与来源标签。

## 14. 测试与验收（每个模块自证）

最低要求（verifier 会复跑）：
1. 幂等：重复导入/重复捕获不产生重复行。
2. 隔离：不同 user/persona/world 的记录互不可见（含 FTS 与向量通道）。
3. 修订：同 predicate 冲突走 supersede，旧值不再是当前事实。
4. 重启：关库重开后游标、作业与记忆保持。
5. 降级：模型/向量/数据库任一不可用时不抛到聊天路径。
6. 中文召回：同义改写、分词边界、过期过滤。

## 15. 已冻结的实现语义（实现后追加，与上文同效力）

模块归属澄清：`parseCandidate` / `gateCandidate` / `mergeDecision` 在 **`lib/validate.mjs`**；
`lib/extract.mjs` 负责 `buildExtractionPrompt` / `parseExtractionOutput` / `extractBatch`（不强制 re-export）。

db.mjs 语义（store-engine 实现，调用前必读）：
- `fullTextSearch` 返回 `{ id, score, rank }`，`score = -bm25`（正数越大越相关，`-0` 归一为 `0`）。
- `fullTextSearch` 已在 SQL 层按 `user_id`/`persona_id`/`status`(默认 `['confirmed']`)/`world_id` 过滤：
  `worldId` 非空时匹配 `(world_id=? OR world_id='')`，`worldId=''` 时只匹配现实行。调用方仍须再跑 `policy.scopeMatches`。
- `listMemories` / `countMemories` **强制** `userId`+`personaId`，默认排除过期行；查历史/被取代行必须 `includeExpired:true`。
- `updateMemory` 只接受契约列出的字段；无实际变化不升 `revision`。
- `setStatus('superseded'|'retracted')` 同时写 `valid_to`；`operation` 记为 `status`。
- `backup(file)` 会先删同名目标文件再 `VACUUM INTO`，事务内调用会抛错。
- `upsertIdentity` / `upsertPersona` 保留未传的可选字段。
- `failJob` 用真实 `Date.now()` 计算退避（不吃调用方注入的 `now`），第 5 次失败置 `failed`。
- `claimJob(type, { now, streamKey })` 支持按 `stream_key` 认领；`enqueueJob({ ..., force })` 为 `true` 时总是新建；
  `requeueJob(jobId, { resetAttempts })` 把失败作业改回 `pending`。
- `listMemories` 默认 limit=100、上限 1000（`getEmbeddings`/`jobs` 同类上限 1000）。
- `updateMemory` 逐列比较规范值，**无实际变化时不写库、不升 revision、不写修订记录**（§15 的硬要求）；
  `value/content/predicate` 真的变化时在同一事务里删除该记忆的向量行，等待重新嵌入。
  `staleEmbeddings({ provider, model, limit, statuses = ['confirmed'] })` 返回向量比记忆旧的 id。
- `integrityCheck({ quick })`：`quick` 走 `PRAGMA quick_check`；`openMemoryDatabase({ integrity: 'full'|'quick'|'skip' })`
  默认 `'full'`；引擎开库用 `'quick'`，迁移/体检 CLI 用 `'full'`。
- `setStatus` 重复设置同一状态是 no-op（不重写 `valid_to`、不升 revision）。

capture / jobs 语义：
- 证据 `eventKey` 统一为 `${sessionId}:${seq}`；旧会话记录迁移时也用同一格式（`record.id` 即 `${sessionId}:${seq}`），
  两条路径写入同一消息只留一行证据。
- 游标是「已入批」高水位；作业连续失败到 `failed` 后原文不再自动重提，需 `requeueJob` 人工重排。
- `extract.parseExtractionOutput('[]')` 会返回一条 `errors`，但 jobs 把它当正常空完成。

渲染与注入：
- 注入文本总长 ≤ `config.injection.budgetChars`（默认 2400）；`avoid_unless_asked` 的行只出现占位，不出现正文。
- 字面通道匹配闸门（2026-10-27 真实库调参后冻结）：`idf(t)=ln(1+N/(1+df(t)))`，
  `coverage = Σidf(命中词元)/Σidf(查询词元)`，`retrieval.coverageFloor` 默认 **0.15**（clamp 0.1–0.9）；
  `terms.length===1` 只要命中即可。实测 777 条中文库：0.30/0.35/0.40 让「我们上次聊到的那个北京的烤鸭」
  「我最近是不是经常熬夜到很晚」「你还记得我平时喜欢喝什么吗」全部召回 0；0.15 保留长问句召回，
  且无关查询（「完全无关的量子力学问题」最佳垃圾覆盖率 0.0985）仍为 0 条。
  已知限制：只命中一个稀有词的记录（「熬夜至 3:30」那条，coverage 0.0869）会输给命中两个常见词的摘要，等真实 embedding 再补。
- 全部候选被字面闸门拦下时返回空 entries、`backend='none'`，**不退回 recent 池**，注入为空串。
- 本地哈希向量通道（`provider='local'`）额外要求「与查询共享至少一个索引词元」且「余弦 > 0.3（`LOCAL_SEMANTIC_FLOOR`）」，
  否则 256 维词面哈希的碰撞噪声会把无关记忆注入提示词；`provider!='local'` 只受 `minScore`/`semanticMinScore` 约束。
- `recall` 返回的 `entries[].score`：hybrid 路径为 RRF 融合分，recent 路径为 importance；**数组顺序才是最终排序**。
- `getEmbeddings({ provider, model, memoryIds, limit })` 支持按候选 id 批量取向量（500/批）；调用方应传候选 id，不要全表扫。

wiki：
- `wiki_pages` 里 index 页以 `scope='system'` 登记，`companion_wiki_index` 返回主题页时要过滤掉它。

## 16. engine.ingestDomainEvent（C3 跨库入口，v0.4.1 新增）

`companion-runtime` 的桥接只经这个入口写长期记忆：runtime 不打开记忆库、不触碰任何记忆表，
也不参与可见性判定。入口本身永不向聊天路径抛错，所有失败都折叠成状态码。

```js
engine.ingestDomainEvent({
  subject: { userId, personaId, worldId },   // 必须已绑定；worldId 空串 = 现实
  namespace,                                 // 事件命名空间，如 'companion.event'
  eventId,                                   // runtime 侧内容寻址事件 id
  transformVersion,                          // 变换/提取语义版本（字符串或数字）
  rootEvidenceIds,                           // 根证据 id 数组，可为空
  realityStatus,                             // actual_tool_activity | simulated_world | hypothetical
  evidenceStatus,                            // observed | inferred | confirmed
  content,                                   // 一句话事实/事件正文
  occurredAt,                                // epoch 毫秒或 ISO 8601
  mentionPolicy,                             // 可选：direct | soft_echo | tone_only | avoid_unless_asked
}) -> {
  status: 'accepted' | 'pending' | 'rejected' | 'duplicate' | 'retryable_failure',
  receiptId: string,       // 持久收据 id；校验拒绝/降级时为空串
  recordId?: string,       // 落库记录 id（rejected 时没有）
  reason?: string,         // 稳定理由码，见 16.5
}
```

### 16.1 幂等与收据

- 去重键 `(namespace, 规范化 scopeKey, eventId, transformVersion)`，`scopeKey` 形如
  `u:<userId>|p:<personaId>|w:<worldId>`。同一去重键在库里只允许一条收据。
  该派生式自 v0.4.1 起固定不变（`stableId('dkev', namespace, scopeKey, eventId,
  transformVersion)`），使修复前后写下的收据都还能被命中；进入键的每个分量都不得含控制字符
  （`\u0000`–`\u001f`、`\u007f`），否则 NUL 分隔拼接不单射，一律按 `invalid-*` 拒绝。
- **证据键同样是 scoped tuple**：`source_events.event_key` =
  `runtime-scoped:<stableId('evk', 长度前缀元组)>`，元组为 `(namespace, 规范化 scopeKey,
  eventId, transformVersion)`。每个分量带自己的长度前缀，任何分量都无法挪动别人的边界，
  因此该键是单射的。两个不同主体使用相同 `namespace/eventId/transformVersion` 时**各写一行
  证据**；第二人的记忆只链接自己的证据，绝不引用第一人的证据原文。旧版无作用域的
  `runtime:<namespace>:<eventId>:<transformVersion>` 行前缀不同，永不会被 scoped 行复用。
- 复用前校验：命中既有证据行时，`event_key`、`userId`、`personaId`、`worldId`、`content`
  （含其 sha256）必须全部一致；任一项不符 →
  `{ status:'rejected', receiptId:'', reason:'evidence-conflict' }`，**不写记录、不写链接、
  不改写证据**。这是完整性兜底：正常重试在收据层已返回 `duplicate`，不会走到证据行。
- 收据持久化在 `domain_event_receipts`（表由 `lib/db.mjs` 以幂等 DDL 维护，配套
  `putDomainEventReceipt` / `getDomainEventReceipt` / `countDomainEventReceipts` /
  `domainEventReceiptsStatus`）。
- 版本：收据表在本工作包以独立通道补建，主 `SCHEMA_VERSION` **故意保持 `2`**（冻结的
  `test/db.test.mjs` 断言精确值，本包不得改）。因此「收据表存在且可写」只能由
  `schema_meta.domainEventReceiptsVersion` / `db.domainEventReceiptsStatus()` 判定，不能由主
  `schemaVersion` 推断；收据通道自己的版本与兼容性规则见 §16.6。
- 重试：原收据状态为 `accepted`/`pending` 时返回
  `{ status:'duplicate', receiptId: 原值, recordId: 原值, reason:'dedupe-hit' }`；原收据为
  `rejected` 时原样返回 `{ status:'rejected', receiptId: 原值, reason: 原理由码 }`。
  两种情况都**不改写原收据、不重复插入记录与证据**。
- 同键但 `content` 的 sha256 与收据不同 → `{ status:'rejected', receiptId: 原收据,
  reason:'content-conflict' }`：拒绝覆盖，原记录原样保留。
- 证据（`source_events`）、记录（`memories`）、证据链接（`memory_evidence`）与收据在
  **同一个 SQLite 事务**里提交；中途任何异常整笔回滚，返回 `retryable_failure`。

### 16.2 现实 / 证据门（推断绝不写成用户事实）

| realityStatus | evidenceStatus | 返回 | 记录 |
| --- | --- | --- | --- |
| `actual_tool_activity` | `confirmed` | `accepted` | `status=confirmed`、`kind=fact`、`realityLevel=explicit_user_statement` |
| `actual_tool_activity` | `observed` | `accepted` | `status=confirmed`、`kind=event`、`realityLevel=user_utterance_not_verified_fact` |
| `actual_tool_activity` | `inferred` | `pending` | `status=pending`、`realityLevel=inferred`、`mentionPolicy` 强制 `soft_echo`（最多算候选） |
| `simulated_world` / `hypothetical` | 任意 | `rejected` | 只写拒收收据，不写记录 |

- 选择说明：`simulated_world` 与 `hypothetical` 采用**直接拒收**而不是 pending。本入口面向
  现实事实；剧情内容应由既有 `roleplay_world` 作用域的抽取 / 导入路径写入，不能借桥接混入现实。
- `subject.worldId` 非空且 `realityStatus='actual_tool_activity'` → `rejected`
  （`reason='world-scope-mismatch'`）：现实活动不能记到虚构世界，避免静默放宽作用域。
- `mentionPolicy` 缺省值：confirmed → `direct`；observed → `soft_echo`；inferred → `soft_echo`
  （显式传入 `direct` 也会被降级，因为 pending 行不可能被自动注入）。
- 正文含疑似密钥（`lib/text.mjs` 的 `redactSecrets` 会改写）→ `rejected`
  （`reason='sensitive-content'`），不落库。

### 16.3 作用域与主体

- `subject` 必须已绑定：`userId` / `personaId` 非空、不得为 `*`，`personaId` 必须等于引擎人格；
  `userId` 必须是引擎 owner 或 `identities` 表中登记过的用户。其余一律 `rejected`
  （`reason='unbound-subject'`），**绝不静默补默认值或放宽 writer**。
- `worldId` 在记忆侧把空串与 runtime 的规范化默认值 `world:default` 视为同一个「现实」，
  这是两条契约之间唯一的形状差异；其它任何非空 `worldId` 都按虚构世界拒绝（见 16.2）。
- 记录按 subject 原样写 `user_id` / `persona_id` / `world_id`；读路径继续用
  `policy.scopeMatches` 判定可见性，因此非现实世界的行不会出现在现实召回里。

### 16.4 降级

- 后端不可用（`backend!=='sqlite'`、`node:sqlite` 缺失、初始化失败）→
  `{ status:'retryable_failure', receiptId:'', reason:'memory-unavailable' }`，
  **不声称已持久化**。
- 事务内异常 → `{ status:'retryable_failure', receiptId:'', reason:'memory-write-failed' }`；
  此时事务已回滚，不会留下半条记录。调用方（runtime 出站队列）应保留队列稍后重试。

### 16.5 理由码（稳定）

输入/主体：`invalid-subject`、`unbound-subject`、`invalid-namespace`、`invalid-event-id`、
`invalid-transform-version`、`invalid-occurred-at`、`invalid-reality-status`、
`invalid-evidence-status`、`invalid-mention-policy`、`content-empty`、`content-too-long`、
`sensitive-content`。

策略/幂等：`non-actual-reality`、`world-scope-mismatch`、`content-conflict`、`dedupe-hit`、
`inferred-candidate`、`confirmed-observation`、`observed-activity`、
`evidence-conflict`（既有证据行与本次请求的主体/正文不符，属完整性兜底，不写收据）。

降级：`memory-unavailable`、`memory-write-failed`。

### 16.6 收据表（`domain_event_receipts`）

`receipt_id`(PK)、`dedupe_key`(UNIQUE)、`namespace`、`scope`、`event_id`、`transform_version`、
`status`、`record_id`、`source_id`、`content_hash`、`reality_status`、`evidence_status`、
`root_evidence`、`reason`、`created_at`、`updated_at`。

表由 `lib/db.mjs` 在可写打开时以 `CREATE TABLE IF NOT EXISTS` 幂等创建，并用独立
`schema_meta.domainEventReceiptsVersion` 记录版本；主 `schemaVersion` 链（`schema.sql` +
`MIGRATIONS`）保持不动，因此已有 v2 库下次可写打开即获得收据表，无需重放主迁移。

**有意保留的妥协**：补建收据表之后主 `schemaVersion` 仍是 `2`，不升到 3 —— 冻结的
`test/db.test.mjs` 对版本号有精确断言，本工作包不得改动它。为了让这条独立通道仍然「有版本
可查、可拒绝降级」，收据通道使用自己的 `domainEventReceiptsVersion`（当前 `1`）并做兼容性
检查：

- 打开时**先读既有标记**。标记缺失或 `≤` 当前支持版本 → 执行幂等 DDL，把标记写成 `1`
  （`ensureDomainEventReceipts()` 返回 `{ version:1, tableExists:true, created:是否新建,
  compatible:true, wrote:true }`）。
- 标记 `>` 当前支持版本（更新构建写下的未知收据形状）→ **不执行 DDL、不改写标记**，
  `ensureDomainEventReceipts()` 返回 `{ compatible:false, newer:true, version:<既有值>,
  wrote:false }`；`inspectDomainEventReceipts()` 与 `db.domainEventReceiptsStatus()` 报告同一
  结果，两者都是只读、无副作用。此后 `putDomainEventReceipt` 直接抛「收据表版本不兼容」，
  `getDomainEventReceipt` 返回 `null`，`ingestDomainEvent` 折叠成
  `{ status:'retryable_failure', receiptId:'', reason:'memory-write-failed' }`，
  **绝不静默覆盖标记、绝不按旧形状写新行**。
- 只读打开不建表、不改标记；`db.domainEventReceiptsStatus()` 可用作排障观测入口。
- 测试覆盖：已有 v2 库（缺收据表）可写打开后补建收据表、主 `schemaVersion` 仍为 `2`、收据
  通道报告 `1`；以及「标记更新 → 打开成功但不覆盖标记、通道不可写」。

