# bot长期记忆（companion-memory）运维手册

> 适用版本：companion-memory **v0.4.0**，数据库 schema **v1**，配置 schema **v1**
> 本文面向"要动手操作的人"：迁移、核对、调配置、备份、恢复、回滚、排障。
> 代码契约以 `plugins/companion-memory/CONTRACT.md` 为准（含 §15 已冻结实现语义），本文只解释怎么用、怎么修、怎么退。

---

## 0. 一分钟速查

| 我想… | 做什么 | 位置 / 命令 |
| --- | --- | --- |
| 看当前用的是新库还是旧路径 | 让bot调用 `companion_status`：有 `memory.database`/`memory.stats` 就是新库；`memory.mode = "independent-snapshot"` 就是旧路径 | 工具，或 `logs/foundation-runtime.json` |
| 把旧 AstrBot 记忆导进新库 | 先 dry-run，再正式跑 | `node scripts/migrate-memory.mjs --dry-run --json` |
| 核对导入条数 | 看报告里的 `totals` / `origins` / `reconciliation` | `logs/memory-migration-<stamp>.json` |
| 改记忆行为（预算、向量、Wiki） | 改配置文件后**重启桌面** | `home/companion/memory.config.json` |
| 备份数据库 | 关桌面后复制 `.db`，或用引擎 `backup()` | `home/memory/companion-memory.db*` |
| 恢复数据库 | 停桌面 → 换回 `.db` 单文件 → 重建索引 | 见 §6.2 |
| 重建检索索引 / Wiki | 调用 `companion_memory_rebuild` | 工具 |
| **回滚到旧记忆（legacy）** | 改 `backend` → 重启桌面 → 验 `companion_status` | 见 §7（三步） |
| 查某轮为什么没注入记忆 | 看召回日志的 `explain`（只有计数与原因，无正文） | `logs/memory-recall.jsonl` |
| 用图形界面查/改记忆 | 侧栏「记忆档案」图标 → 7 页工作台（总览 / 记忆库 / 显微镜 / Wiki / 时间线 / 审核 / 设置） | 插件 `@local/dsh-companion-memory-studio`（已装进 desktop profile） |

---

## 1. 架构分层与数据流

### 1.1 分层

| 层 | 文件 | 职责 | 失败时的行为 |
| --- | --- | --- | --- |
| 宿主适配 | `plugins/companion-foundation/index.mjs`、`host-llm.mjs` | 挂载人格与边界提示、注册工具、在 `agent/pre-step` 注入记忆、在 `session/event` 捕获消息；把 DSH 的 `llm` 服务包成 `{complete()}` | 捕获/注入异常全部 try/catch，聊天回合照常进行 |
| 引擎门面 | `plugins/companion-memory/index.mjs` | 装配配置、打开数据库、提供 `contextFor / recall / remember / capture / drainJobs / pending / forget / wiki* / rebuildIndex / status` | 任何失败回退 `''` 或 `{ok:false}`，并写 `logs/memory-engine.jsonl` |
| 捕获 capture | `lib/capture.mjs` | 判定一条 `session/event` 是否算真实对话、转成不可变证据行、按游标把消息并成一批 | 返回 `null`/`{capture:false}`，永不抛 |
| 抽取 extract | `lib/extract.mjs`、`lib/validate.mjs` | 生成中文抽取提示词、解析模型 JSON、闸门（证据/作用域/剧情/玩笑/计划/敏感）、冲突合并决策 | 模型失败 → 作业失败并退避；不写半条事实 |
| 存储 store | `lib/db.mjs`、`lib/schema.sql`、`lib/text.mjs` | SQLite(WAL) + FTS5、幂等写入、修订链、证据关联、作业队列、向量 BLOB、Wiki 登记 | `node:sqlite` 不可用或库损坏 → 抛给引擎，引擎降级 legacy |
| 检索 retrieve | `lib/retrieve.mjs`、`lib/render.mjs`、`lib/fusion.mjs`、`lib/embed.mjs` | 字面(FTS 二元组)+向量双通道 → 作用域/时效过滤 → 覆盖率闸门 → RRF 融合 → MMR 去重 → 预算装填 → 渲染 | 任一通道异常只记原因并走另一通道；全挂则空注入 |
| Wiki | `lib/wiki.mjs` | 四个主题页 + `index.md`，生成区/人工区分离，原子写，登记 `wiki_pages` | db 不可用时只写文件并给 warnings |
| 生命周期/策略 | `lib/policy.mjs`、`lib/jobs.mjs`、`config.mjs` | 作用域可见性、时效 TTL、表达策略、状态机、作业重试与退避、配置默认值与校验 | 非法配置回退默认值并记 notes，不阻塞启动 |

### 1.2 数据流

```
真实对话 ──session/event──► capture.shouldCapture ─► source_events（不可变证据，幂等）
                                   │
                                   ├─ noteBatch（游标满 minMessages）─► memory_jobs(type=extract)
                                   │      ※ 后台建批已接：capture 命中后先 noteBatch 再 drain，受 extraction.enabled 控制
                                   ▼
                          extract.buildExtractionPrompt ─► llm.complete ─► parseExtractionOutput
                                             （后台：extraction.enabled=true；显式：不受开关限制）
                                                                     │
                                            parseCandidate（结构校验）─► gateCandidate（闸门）
                                                                     │
                                                     mergeDecision ─► memories + memory_evidence
                                                                     │
                                                          memory_revisions（修订审计）

每轮注入 ─ agent/pre-step ─► engine.contextFor(query=用户最后一条文本)
                              └─► retrieve.recall（FTS + 向量 → 过滤 → 融合 → MMR）
                                    └─► render.renderContext（≤ budgetChars，资料非指令抬头）
                                          └─► 作为 source.kind='companion-memory' 的 user 消息追加

显式工具 ─ companion_recall ─► 同一 recall 管线 ─► render.renderRecallResult（带 id/来源/现实级别）
         ─ companion_wiki_get ─► wiki.readPage（越界路径拒绝）
```

三条写入路径，语义不同，不要混：

1. **用户显式记住**：`companion_remember` → `db.rememberFact`。`realityLevel='explicit_user_statement'`、`confidence=1`、`mentionPolicy='direct'`，同 `predicate` 的新值会把旧值置 `superseded`。
2. **自动抽取**：capture → noteBatch → jobs → extract。后台通道默认**关闭**（`extraction.enabled=false`），显式 `companion_memory_extract` 不受该开关限制；两条通道都只写"证据通过闸门"的事实，证据不足进 `pending`，不进普通召回。后台建批目前仍缺宿主的周期性 `noteBatch` 调用（见 §10.1）。
3. **迁移导入**：`scripts/migrate-memory.mjs`（只读旧数据，幂等）。旧库摘要不会成为"用户确认事实"。

---

## 2. 存储：表、作用域、表达策略、修订链

### 2.1 数据库文件与打开语义

- 默认路径：`home/memory/companion-memory.db`（可用 `database` 改为绝对路径）。
- 同目录会出现 `-wal` / `-shm`：**WAL 模式下复制数据库必须连 `.db-wal`、`.db-shm` 一起复制，或先关桌面**；`db.backup()` 用 `VACUUM INTO` 产出单文件副本，已合并 WAL，推荐用它。
- 打开时强制：`journal_mode=WAL`、`busy_timeout`（默认 5000ms）、`foreign_keys=ON`、`synchronous=NORMAL`。
- 文件头校验 `application_id = 1297303373`：**不是本应用的库会拒绝打开**（另见 §8 症状表）。`schema_meta.schemaVersion` 必须是 `1`。
- 建立表用 `CREATE TABLE IF NOT EXISTS`，重复打开不会重建或丢数据；`integrity_check` 失败会抛错。

### 2.2 表清单

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `schema_meta` | 键值元数据（`schemaVersion`、`createdAt`、`capture:<user>:<persona>:<world>` 游标） | key 主键 |
| `identities` / `personas` | 用户与角色身份（只记录，不参与可见性判定） | 主键 upsert，保留未传字段 |
| `session_bindings` | 会话→用户/角色/世界绑定（宿主层另用 `home/companion/identity.json`） | session_id 主键 |
| `source_events` | **不可变证据**：一条真实消息一行 | `event_key` 唯一（`${sessionId}:${seq}`）；冲突不覆盖 |
| `memories` | 长期事实/事件/承诺/关系/摘要/角色行为 | `dedupe_key` 唯一（幂等最后防线） |
| `memory_evidence` | 记忆↔证据多对多 | `(memory_id, source_id)` 主键，重复写只更新置信度 |
| `memory_revisions` | 修订审计：`insert/update/status/supersede/…` | 每次 `updateMemory`/`setStatus`/`supersede` 都写一行 |
| `memory_embeddings` | 向量（Float32 BLOB） | `(memory_id, provider, model)` 主键；换模型需重建 |
| `memory_relations` | 关系三元组（预留） | 目前只有库层 API，无工具写入 |
| `memory_jobs` | 抽取作业队列 | `(type, stream_key)` 未完成时复用；`attempts` 指数退避，第 5 次置 `failed` |
| `wiki_pages` | Wiki 页登记（修订号、内容哈希） | `page_id` 主键；`index` 以 `scope='system'` 登记 |
| `memory_fts` | FTS5 虚拟表（`memory_id UNINDEXED`, `search_text`, `unicode61`） | **无触发器**，由 db 层手工同步；重建=重插 |

### 2.3 作用域（scope）与可见性

| scope | 含义 | 谁的记忆 | 现实 viewer 可见 | 同世界 viewer 可见 |
| --- | --- | --- | --- | --- |
| `user_global` | 用户现实中的稳定信息（称呼、城市、习惯、偏好） | 用户 | ✅ | ✅ |
| `user_persona` | 用户与bot的关系、共同经历、旧对话摘要、约定 | 用户+角色对 | ✅ | ✅ |
| `persona_self` | bot自己的行为/产物（主动消息、生图） | 角色 | ✅（但是 `tone_only`） | ✅ |
| `roleplay_world` | 剧情世界设定/台词 | 该世界 | ❌ | ✅（仅 `world_id` 相同） |
| `session_recent` | 近期临时状态（位置、疲劳、吃饭） | 用户 | ✅，但 6 小时 TTL 后失效 | ✅ |

硬规则（读路径必须双重过滤）：

- 先按 `user_id` + `persona_id` 精确匹配（SQL 层已做，`policy.scopeMatches` 再做一次）。
- `world_id` 非空的行**只在同 world 可见**；`world_id=''`（现实）的行在任何 world 里都可见；现实 viewer（`worldId=''`）**看不到任何剧情行**。
- `status != 'confirmed'` 一律不进召回；`valid_to` 已过期的行默认被排除（查历史要 `includeExpired:true`）。

### 2.4 表达策略（mention_policy，四档）

| 值 | 含义 | 典型来源 | 注入文本行为 | Wiki 行为 |
| --- | --- | --- | --- | --- |
| `direct` | 可以直说 | 用户显式记住的 profile/preference/fact | 正常输出 `value` | 正常展开 |
| `soft_echo` | 适合自然呼应，不宜逐条复述 | 关系、承诺/计划、旧对话摘要、`inferred` | 正常输出，但模型提示里标为软性 | 正常展开 |
| `tone_only` | 只影响语气，不主动披露 | `bot_action`/`artifact`（主动消息、生图）；含敏感情绪的 note/event | 正常输出但带标签 | `bot_action`/`artifact` 没有主题页所以不出现；其它 `tone_only` 行照常展开 |
| `avoid_unless_asked` | 用户不愿主动提起 | 含隐私措辞（"别告诉""秘密""不想提"…） | **只输出占位**（`type:"hidden"`），不带正文 | 只写"存在一条不愿主动提及的记录，已隐藏正文" |

补充：`renderRecallResult`（`companion_recall`）对 `avoid_unless_asked` 也只给 `value:''` 与 `hidden:true`——工具调用不等于用户明确要求。

### 2.5 状态机与修订链

```
              ┌──────────── 用户纠正（同 subject+predicate 新值） ───────────┐
              ▼                                                              │
 confirmed ──► superseded（旧值，valid_to=now）        confirmed（新值，supersedes_id=旧 id）
    │  ▲
    │  └─ updateMemory（补证据/确认 pending→confirmed，revision+1）
    ├──► retracted（用户 forget，保留历史与证据）
    ├──► archived（过期导入：valid_to 早于导入时刻）
    └──► pending（证据不足/置信度低/引用他人/玩笑/含推测；不进普通召回）
```

- 单值属性（`kind ∈ {fact, profile, preference, relationship}` 且 `predicate` 不是多值）：冲突走 `supersede`，**只有一条 `confirmed`**。
- 多值属性（`predicate` 以 `multi:` 开头，或 `hobby/interest/promise/travel_plan…` 等白名单，或 `kind ∈ {commitment, event, note, summary, artifact, bot_action}`）：并存去重，不互相取代。
- 每次写入/状态变更都进 `memory_revisions`（`old_id/new_id/operation/reason/actor`）；`source_events` 永不被覆盖，所以"当时原话"永远可查。
- 想让模型在回答里"知道这是旧说法"，查 `includeExpired:true` 的历史行即可；日常召回不会看到它们。

### 2.6 时效

- `valid_from` / `valid_to` 为 ISO 字符串；`valid_to <= now` 视为过期。
- `session_recent` 额外按 `occurred_at + 6h` 失效（`SESSION_STATE_TTL_MS`），用于"今天在哪、刚吃了什么"这类临时状态。
- 导入时 `validTo` 已过的行直接 `archived`：不参与召回，但仍可查、仍有证据。

---

## 3. 迁移与对账

### 3.1 输入（只读，绝不修改）

| 文件 | 用途 | 现状 |
| --- | --- | --- |
| `home/memory/astrbot-import.json` | AstrBot 快照，manifest 声明 767 条 | 1,261,492 字节，owner `10001` |
| `home/memory/conversation.jsonl` | 新桌面会话落下的对话记录 | 3,673 字节（10 条） |
| `home/companion/state.json`（可回退 `.previous`） | 旧 JSON 键值记忆 | 当前**不存在**，导入时会记 `state_missing` 警告 |
| `home/companion/identity.json` | 身份（用于默认 `--user/--persona`） | 存在，owner=`10001`，persona=`bot` |

### 3.2 命令

```powershell
cd C:\Users\bobo\Documents\Bot\dsh-companion\plugins\companion-memory

# 1) 演练：只读、只映射、不写库不写报告（会打印摘要；--json 可拿完整报告）
node scripts/migrate-memory.mjs --dry-run --json

# 2) 正式：默认会先备份、再写库、再写报告
node scripts/migrate-memory.mjs

# 常用参数
#   --root <dir>     仓库根（默认仓库根）
#   --db <file>      目标库（默认 <root>/home/memory/companion-memory.db）
#   --user <id>      归属用户（默认读 identity.json 的 owner.id）
#   --persona <id>   角色（默认读 identity.json 的 persona）
#   --report         正式模式默认写报告；dry-run 下写报告需显式加
#   --backup         dry-run 下也强制备份
```

### 3.3 映射规则（旧 `memoryType` → 新记录）

| 旧类型 | 条数 | scope | kind | realityLevel | mentionPolicy | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `core_memory` | 5 | `user_global` | `profile` | `imported_fact` | `direct` | |
| `user_profile` | 4 | `user_global` | `profile` | `imported_fact` | `direct` | |
| `user_preference` | 7 | `user_global` | `preference` | `imported_fact` | `direct` | |
| `explicit_memory` | 10 | `user_global` | `fact` | `imported_fact` | `direct` | |
| `tool_memory` | 2 | `user_global` | `preference` | `inferred` | `soft_echo` | 置信度上限 0.6 |
| `relationship_claim` | 3 | `user_persona` | `relationship` | `imported_fact` | `soft_echo` | |
| `conversation_summary` | 262 | `user_persona` | `summary` | `imported_summary` | `soft_echo` | **不是用户确认事实** |
| `proactive_message` | 354 | `persona_self` | `bot_action` | `bot_action` | `tone_only` | importance ≤ 0.35 |
| `photo_generation` | 120 | `persona_self` | `artifact` | `bot_action` | `tone_only` | importance ≤ 0.35 |

- `subject='user'`（用户）/`'persona'`（角色自身）；`predicate='import:<旧类型>'`，不会和后续自动抽取的 predicate 冲突。
- 每条记录 `dedupeKey='import:astrbot:<sourceId>'`（稳定），并写一条证据 `eventKey='astrbot:<sourceId>'`、`role='imported'`、`sourceKind='astrbot_import'`。
- `proactive_message` / `photo_generation` **永远不进 `user_global`**（代码里有断言 + 对账项 `bot_action_not_in_user_scope`）。

### 3.4 备份与报告

| 产物 | 位置 | 内容 |
| --- | --- | --- |
| 迁移前备份 | `home/memory/backups/<stamp>/` | 三个输入文件 + `identity.json` 的副本 + `manifest.json`（含每个文件 `sha256`、`sourceSha256`、`verified`） |
| 迁移报告 | `logs/memory-migration-<stamp>.json` | `origins/totals/byMemoryType/byScope/byStatus/checksums/memoryIds/eventKeys/reconciliation`；**只有 id、类型、计数、校验值，没有正文** |

- 备份在**第一次写库之前**完成；`astrbot-import.json` 缺失或 sha256 校验不一致会**中止导入**。
- 报告永不覆盖：同一秒重复跑会得到 `-2`、`-3` 后缀。
- 备份目录同样不覆盖：已有同 stamp 目录会加 `-2` 后缀。

### 3.5 幂等与"怎么核对 767 条"

重复运行必须 `inserted=0`（归档部分 `deduped=767`，含 `conversation.jsonl` 时是 777）、`eventsInserted=0`、`evidenceLinked=0`、证据全部落在 `evidenceExisting`。真实仓库已经跑过两次，第二次报告（`logs/memory-migration-20261027T093022Z.json`）：

```
origins.archive   = { rows: 767, mapped: 767, skipped: 0 }
origins.conversation = { rows: 10, mapped: 10, skipped: 0 }
totals = { candidates: 777, inserted: 0, deduped: 777, skipped: 0,
           eventsInserted: 0, eventsDeduped: 777, evidenceLinked: 0, evidenceExisting: 777 }
byScope = { user_global: 28, user_persona: 270, persona_self: 479 }
reconciliation = { ok: true, mode: 'store', checks: 17 项全通过 }
warnings = [{ code: 'state_missing', detail: '…\home\companion\state.json' }]
```

核对步骤（任选，建议 1+2 都看）：

1. **看报告**：`origins.archive.mapped + skipped = 767` 且 `skipped = 0`；`byMemoryType` 的九类计数与 manifest 一致；`byScope.persona_self = 354+120 = 474`。
2. **看对账**：`reconciliation.ok === true` 且 `mode === 'store'`；17 项里重点是
   `store_total`、`store_by_memory_type`、`store_by_scope`、`store_ownership`、`store_duplicates(0)`、`store_evidence_linked`、`store_bot_action_not_in_user_scope(0)`、`archive_imported_all(767)`。
3. **看库**（只读，不会写）：
   ```powershell
   node -e "import('./lib/db.mjs').then(async ({openMemoryDatabase})=>{const db=await openMemoryDatabase({file:'../../home/memory/companion-memory.db',readOnly:true});console.log(db.stats());console.log('user_global',db.countMemories({userId:'10001',personaId:'bot',scope:'user_global',includeExpired:true}));console.log('persona_self',db.countMemories({userId:'10001',personaId:'bot',scope:'persona_self',includeExpired:true}));console.log(db.integrityCheck());db.close();})"
   ```
   期望：`memories 777`、`events 777`、`embeddings 777`、`schemaVersion 1`、`integrity ok:true`；`user_global 28`、`persona_self 474`。
4. **抽一条验证来源**：`companion_recall`（query 用旧库里确定存在的词）返回里 `source='astrbot_import'`、`reality='imported_fact'`，`id` 与报告 `memoryIds` 一致。

> 777 = 767（归档）+ 10（`conversation.jsonl` 的 5 条用户 + 5 条助手记录）。归档单独的条数永远是 767。

---

## 4. 配置项清单

### 4.1 位置与优先级

1. 代码默认值（`config.mjs` 的 `DEFAULT_CONFIG`）
2. `home/companion/memory.config.json`（唯一权威文件；缺失=全默认）
3. 环境变量覆盖（见 §4.3，仅 3 个）

任何非法值都会**回退到默认并记一条 note**（不阻塞启动）；JSON 语法错误也不阻塞，但 `companion_status.notes` 会带 `config-error`。**改完配置要重启桌面进程**（引擎在挂载时读一次）。

### 4.2 字段全表

| 字段 | 默认 | 范围/取值 | 影响 |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | 固定 | 配置结构版本，勿改 |
| `backend` | **`legacy`** | `legacy` \| `sqlite` | **总开关**：`legacy` 走旧 `state.json`+快照路径（不打开 SQLite、不注册新工具）；`sqlite` 启用本引擎。未知值回退 `legacy` |
| `database` | `home/memory/companion-memory.db` | 相对仓库根或绝对路径 | 记忆库位置；空值回退默认 |
| `injection.budgetChars` | `2400` | 400–8000 | 每轮自动注入的**硬字符上限**（含固定抬头）。太小会注入不下内容；太大挤占 prompt |
| `injection.includeIdentity` | `true` | bool | 目前由宿主层拼接身份文本，引擎不读这个开关（见 §10） |
| `injection.includeWikiSummary` | `true` | bool | 预留；当前注入不读 Wiki 摘要 |
| `retrieval.candidates` | `32` | 4–200 | 每个通道的候选上限（另加"最近+重要"池）；越大越慢越全 |
| `retrieval.topK` | `8` | 1–20 | 默认返回条数；`companion_recall` 的 `limit` 会覆盖它 |
| `retrieval.rrfK` | `60` | 1–200 | RRF 融合常数，越大越"平分"两通道 |
| `retrieval.mmrLambda` | `0.72` | 0–1 | MMR 去重强度，越大越偏向"不重复" |
| `retrieval.coverageFloor` | `0.15` | 0.1–0.9 | 字面通道的 **DF 加权覆盖率**门槛（`Σidf(命中)/Σidf(查询词元)`）。太大→长自然问句召回不到；太小→无关问题也注入旧记忆。默认值是在真实 777 条库上量的（无关问题峰值 0.0985） |
| `retrieval.semanticEnabled` | `true` | bool | 关掉=只用 FTS；向量表损坏时也可临时关 |
| `extraction.enabled` | **`false`** | bool | **是否允许后台自动提炼**（capture 触发的那条通道）。false=后台完全不花模型费用；显式工具 `companion_memory_extract` 不受此开关限制 |
| `extraction.minMessages` | `6` | 2–200 | 攒够多少条消息才建一个抽取作业 |
| `extraction.maxMessages` | `40` | ≥min，≤400 | 单个作业最多带多少条原文 |
| `extraction.maxOutputTokens` | `1200` | 200–8000 | 单次抽取的模型输出上限 |
| `extraction.maxInputChars` | `12000` | 2000–100000 | 提示词字符预算，超了先丢最旧消息 |
| `extraction.provider` / `model` | `''` | 字符串 | 抽取用哪个 provider/model；空=宿主默认（`host-llm.mjs` 透传） |
| `embedding.provider` | `local` | `local` \| `remote` \| `off` | `local`=内置 `hash-bigram`（确定性、无网络、**词法近似不是语义模型**）；`off`=关向量通道 |
| `embedding.model` | `hash-bigram-256` | 字符串 | local 时自动改成 `hash-bigram-<dimensions>`；remote 时必须显式给模型名 |
| `embedding.dimensions` | `256` | 64–1024 | 本地向量维度；改维度需清空/重建向量（`clearEmbeddings` + `rebuildIndex`） |
| `embedding.baseUrl` | `''` | URL | remote 的 OpenAI 兼容端点（自动补 `/v1/embeddings`）；缺失则回退 local |
| `embedding.apiKeyEnv` | `''` | 环境变量名 | remote 时从这个环境变量读 key |
| `embedding.timeoutMs` | `4000` | 500–30000 | 单次向量请求超时；超时降级 local |
| `wiki.enabled` | `true` | bool | 是否编译 Wiki 页 |
| `wiki.dir` | `home/memory/wiki` | 路径 | Wiki 根目录（含 `index.md`） |
| `wiki.autoCompile` | `true` | bool | 写入/作业完成后按 `minIntervalMs` 节流重编译 |
| `wiki.minIntervalMs` | `600000` | 0–86400000 | 自动编译的最小间隔（10 分钟）；0=每次都编 |
| `wiki.maxEntriesPerTopic` | `40` | 1–2000 | 单页条目上限（超出按重要度截断并在页内说明） |
| `wiki.maxPageBytes` | `32768` | 2048–262144 | 单页生成区字节上限 |
| `limits.captureMessageChars` | `16000` | 500–60000 | 单条证据正文截断长度（先脱敏再截断） |
| `limits.factValueChars` | `2000` | 100–4000 | `companion_remember` 的 value 长度上限 |

### 4.3 环境变量覆盖

| 变量 | 等价配置 | 取值 |
| --- | --- | --- |
| `DSH_COMPANION_MEMORY_BACKEND` | `backend` | `legacy` / `sqlite` |
| `DSH_COMPANION_MEMORY_EXTRACTION` | `extraction.enabled` | `1/true` 开，`0/false` 关 |
| `DSH_COMPANION_MEMORY_EMBEDDING` | `embedding.provider` | `local` / `remote` / `off` |

### 4.4 两个必须记住的默认值

- **`backend` 默认 `legacy`**：全新环境/配置被删时，程序走旧记忆路径，新库不会被打开，新工具不会注册。**要启用新记忆必须显式写 `sqlite`**（当前仓库的 `home/companion/memory.config.json` 已经是 `sqlite`）。
- **`extraction.enabled` 默认 `false`**：陪伴基座默认**不会**自己调用模型。这个开关只管**后台**通道（`capture` 触发的 `drainJobs({background:true})`）；用户主动调 `companion_memory_extract`（显式通道）不受它限制，但同样需要可用的宿主模型。关掉不影响读：已存入的事实照常召回。

### 4.5 remote embedding 的现实约束

`embedding.provider=remote` 必须同时满足：`baseUrl` 非空 **且** `model` 显式（不能是默认的 `hash-bigram-256`）**且** `apiKeyEnv` 指向的变量存在；否则配置层直接回退 `local` 并记 note。远程连续失败 3 次熔断 5 分钟，期间全部走 local 向量；**任何向量失败都不影响召回**（只是少了语义通道）。

---

## 5. 工具清单

后端为 `sqlite` 时注册 12 个工具；`legacy` 时只有前 6 个（旧基座，行为不变）。
> 任务书里写的是"旧 6 + 新 5"，实际实现是**新 6**（多出 `companion_memory_rebuild`），下表按 `companion-foundation/index.mjs` 的真实注册顺序列出。

### 5.1 旧 6 个（两种后端都有）

| 工具 | 读写 | 一句话用途 |
| --- | --- | --- |
| `companion_status` | 读 | 看基座状态、绑定用户、记忆后端（`sqlite`/`legacy`）、库统计、作业与 Wiki 页数 |
| `companion_identity` | 读 | 看当前会话的桌面用户绑定、原 QQ 身份、角色与 sessionId（**不要**从记忆里猜身份） |
| `companion_recall` | 读 | 按关键词/语义检索记忆，返回 id、来源、现实级别、表达策略 |
| `companion_remember` | 写 | 保存用户**明确确认**的长期事实；同键纠正会生成新修订并取代旧值 |
| `companion_recent_events` | 读 | 看本环境最近的活动事件（不是长期记忆） |
| `companion_record_event` | 写 | 记录一件已完成的真实活动（不发送消息、不执行平台动作） |

### 5.2 新 6 个（仅 `sqlite`）

| 工具 | 读写 | 一句话用途 |
| --- | --- | --- |
| `companion_wiki_index` | 读 | 列出四个主题页（用户画像/偏好/关系/重要事件与承诺）的 id、路径、修订号（`index` 页不会出现在这里） |
| `companion_wiki_get` | 读 | 按 topicId（如 `user-profile`）读整页 Markdown，越界路径会被拒绝 |
| `companion_memory_pending` | 读 | 列出证据不足/待人工确认的候选（`pending` 不进普通召回） |
| `companion_memory_extract` | 写 | 立即跑一轮提炼（**会用总结模型**，不受 `extraction.enabled` 限制；模型不可用时返回 `ok:false`）；返回落库/失败计数 |
| `companion_memory_forget` | 写 | 按 id 撤回一条记忆（`retracted`，保留历史与来源，不物理删除） |
| `companion_memory_rebuild` | 写 | 重建 FTS、补齐缺失向量、重编译 Wiki（恢复备份后必跑） |

---

## 6. 备份、恢复、重建索引

### 6.1 备份（三种，按场景选）

1. **迁移前**：`migrate-memory.mjs` 自动做，产物在 `home/memory/backups/<stamp>/`（带 sha256 manifest）。**不要手改这些文件**。
2. **日常整库备份**（推荐，单文件、WAL 已合并）：
   ```powershell
   # 关闭桌面后执行（必须用可写连接：只读连接上 VACUUM INTO 会报 "attempt to write a readonly database"）
   node -e "import('./lib/db.mjs').then(async ({openMemoryDatabase})=>{const f='../../home/memory/companion-memory.db';const db=await openMemoryDatabase({file:f});const r=db.backup('../../home/memory/backups/manual-'+Date.now()+'.db');console.log(r);db.close();})"
   ```
   注意：`backup()` 不能在事务里调用；目标同名文件（含 `-wal`/`-shm`）会先被删除；备份产物是可直接重新打开的完整库。
3. **停机冷备份**：直接复制 `companion-memory.db` + `-wal` + `-shm`（三件套缺一不可），以及 `home/companion/identity.json`、`home/companion/memory.config.json`、`home/memory/wiki/`。

### 6.2 恢复

```powershell
# 0) 关闭桌面（否则文件被占用）
# 1) 保留现场
Move-Item home\memory\companion-memory.db home\memory\companion-memory.db.broken -Force
Remove-Item home\memory\companion-memory.db-wal, home\memory\companion-memory.db-shm -ErrorAction SilentlyContinue
# 2) 放回备份（必须是单文件 .db；不要只拷 .db 而留下旧 -wal）
Copy-Item home\memory\backups\<stamp>\companion-memory.db home\memory\companion-memory.db
# 3) 启动桌面，让bot调用 companion_memory_rebuild（重建 FTS/向量/Wiki）
# 4) 校验：companion_status 应重新出现 memory.database 与 memory.stats，stats.memories 与备份前一致；必要再跑一次 migrate --dry-run 看对账
```

### 6.3 重建索引

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| FTS 召回变少/报 `rebuildSearchIndex` 相关 | `companion_memory_rebuild` | 按 `memories` 重插 `memory_fts` |
| 换了 embedding provider/model/dimensions | 先清向量再重建 | `db.clearEmbeddings(provider?)`（库层 API，没有对应工具，用一次性 `node -e` 脚本）→ 再 `companion_memory_rebuild` 按新模型补 |
| Wiki 页面过期/形状不对 | `companion_memory_rebuild`（或 `engine.compileWiki({force:true})`） | 重写生成区，保留人工区 |
| 恢复备份后 | 一律 `companion_memory_rebuild` | FTS+向量+Wiki 全部与新库对齐 |

> FTS 表**没有触发器**：任何绕过 `lib/db.mjs` 的手工 SQL 改 `memories` 都会让 FTS 与事实不一致，改完必须重建索引。

---

## 7. 回滚到 legacy（三步）

回滚**不删数据**：SQLite 文件、`source_events`、Wiki 目录全部保留，随时可以再切回来。

### 第 1 步：把 `backend` 改回 `legacy`

编辑 `home/companion/memory.config.json`，把第一行的键改成：

```json
{
  "schemaVersion": 1,
  "backend": "legacy",
  ...
}
```

或用一行命令（会保留其它字段）：

```powershell
$f = 'home\companion\memory.config.json'
$j = Get-Content $f -Raw | ConvertFrom-Json
$j.backend = 'legacy'
$j | ConvertTo-Json -Depth 8 | Set-Content $f -Encoding utf8
```

> 等价的"紧急开关"：设置环境变量 `DSH_COMPANION_MEMORY_BACKEND=legacy` 后重启（环境变量优先级高于文件）。
> 配置文件被写坏**不会阻塞启动**：加载时回退默认值，等价于回到 legacy；错误文本在 `engine.status().reason` 里带 `config-error`（legacy 模式下宿主不展示该字段，可用只读脚本查看）。

### 第 2 步：重启桌面

关掉陪伴桌面，再运行仓库根目录的 `启动陪伴桌面.bat`（或 `Start-Desktop.ps1`）。**必须重启**：引擎只在挂载时读配置。

> 由对话里自动重启（会结束当前这一轮的进程）：**唯一入口** `scripts/restart-desktop.ps1`，用 `Start-Process -WindowStyle Hidden` 后台拉起。2026-10-28 的两次事故（桌面被关掉、没人拉起来）都出在「脚本自己在被杀的进程树里」：
> - 现在**先**注册一次性计划任务 `DSHCompanionRestart`（+60 秒左右触发 `scripts/ensure-desktop.ps1`，由 Task Scheduler 服务启动，不在那棵树里），**再** `taskkill /T`。脚本被杀也无所谓。
> - `ensure-desktop.ps1` 会先等旧实例彻底消失（最多 180s），再调用 `Start-Desktop.ps1`，所以触发早一点/晚一点都安全。
> - 没起来就把计划任务留着做最后保险；起来了才删任务并写 `logs/restart-desktop-report.json`（由 `ensure-desktop.ps1` 写，因为重启脚本通常在 taskkill 时就被杀了）。
> - `ensure-desktop.ps1` 拉起桌面时必须**分离启动**（`Start-Process` 且不捕获输出）：2026-10-28 实测 `& powershell -File Start-Desktop.ps1 2>&1` 会被 Electron 继承的 stdout 管道卡住——桌面起来了，但计划任务实例一直 `Running`、报告也写不出来。
> - 自检：`-DryRun`（打印解析出的根目录与任务触发时间）、`-Probe`（**真的**注册任务→等 12 秒→确认它执行了→删除；不碰桌面）。`logs/restart-desktop-clean.ps1` 只是转发到同一入口。
> - 真实重启是否成功，只看 `logs/restart-desktop-report.json` 的 `healthy` 与新 pid/url，以及 `logs/restart-<stamp>.log`。

### 第 3 步：验证 `companion_status`

让bot调用 `companion_status`，看返回里的 `memory` 对象。两种后端的形状不同，按这张表核对：

| 字段 | 回滚成功的旧路径（legacy） | 新库（sqlite） |
| --- | --- | --- |
| `memory.mode` | `"independent-snapshot"` | 不出现 |
| `memory.retrieval` | `"local-keyword-and-CJK-bigram"` | 不出现 |
| `memory.importedCount` | `767`（旧快照条数） | 不出现 |
| `memory.backend` | 不出现 | `"sqlite"` |
| `memory.database` / `memory.stats` / `memory.jobs` / `memory.wikiPages` | 不出现 | 全部出现 |
| `memory.config.backend` | 不出现 | 配置里的值（此时应为 `"sqlite"`；回滚后不出现） |
| 新 6 个工具 | 不再注册（调用报"工具不存在"属正常） | 已注册 |
| `companion_recall` | 仍能返回旧快照/`state.json` 记忆，行为与升级前一致 | 走新库检索 |

> 判断口诀：**能给 `memory.database` 与 `memory.stats` 就是新库；只有 `mode/importedCount/retrieval` 就是旧路径。**

回滚后如需再次启用：把第 1 步改回 `"sqlite"` → 重启 → `companion_status` 应重新出现 `database` 与 `stats`。

---

## 8. 日志与排障

### 8.1 日志文件（默认都不含记忆正文）

| 文件 | 内容 |
| --- | --- |
| `logs/foundation-runtime.json` | 最近一次挂载的版本、pid、绑定用户、`memory` 状态快照（新进程启动时覆盖） |
| `logs/memory-engine.jsonl` | 引擎事件：`sqlite-opened`、`remembered`、`jobs-drained`、`wiki-compiled`、`context-failed`、`operation-failed` 等 |
| `logs/memory-recall.jsonl` | 每轮注入一行：`characters`、`queryCharacters`、`elapsedMs`、`explain`（候选数/各通道命中数/过滤原因码） |
| `logs/memory-migration-<stamp>.json` | 迁移报告（见 §3.4） |
| `logs/desktop-*.stdout.log` / `.stderr.log` | 宿主进程输出；插件加载失败通常在这 |

### 8.2 症状 → 原因 → 处理

| 症状 | 可能原因 | 处理 |
| --- | --- | --- |
| 配置写了 `backend=sqlite`，但 `memory.backend="legacy"` 且 `memory.reason` 含 `sqlite-unavailable` | 库打不开（被其它应用占用 / `application_id` 不符 / 路径不可写 / 文件损坏） | 换正确 `database` 路径；确认库是本应用的（`application_id` 必须是 1297303373）；`companion_memory_rebuild` 或恢复备份。详见 `memory-engine.jsonl` 的 `sqlite-unavailable` 行 |
| `memory.mode="independent-snapshot"`（根本没有 `backend` 字段） | 配置还是 `legacy`（或配置被删/写坏回退默认） | 这是旧路径在正常工作；要新库就把 `backend` 改成 `sqlite` 并重启（见 §7 反向操作） |
| 某轮完全没有注入记忆 | 库里没有命中行、覆盖率闸门过滤了全部候选、预算太小、或向量/模型通道报错 | 看 `memory-recall.jsonl` 的 `explain`：`filteredReasons` 里 `low-coverage`/`status-*`/`scope-mismatch`/`expired` 分别对应不同原因；`channels` 全 0 说明两通道都没命中；`coverage.{floor,best,kept,total}` 给出闸门实测值（`best < floor` 就是问法覆盖率不足） |
| 明确记得的事却想不起来 | 该行是 `pending`/`superseded`/`archived`；或问法与事实共有的中文二元组太少（本地通道是词法近似） | 用 `companion_recall` 换更贴近原话的问法；确认真实状态要查历史（`includeExpired:true`，运维可用只读脚本） |
| 注入里出现"存在一条不愿主动提及的记录…"但没有正文 | 该行 `mention_policy='avoid_unless_asked'`（设计如此） | 需要正文时由用户明确要求；或把该行改策略（运维脚本） |
| Wiki 页不更新 / 尺寸异常 | 自动编译被 `minIntervalMs` 节流；或页面超过 `maxPageBytes` | `companion_memory_rebuild`；必要时调 `wiki.minIntervalMs=0` 后重启 |
| `companion_memory_extract` 返回 `processed:0` 但 `ok:true` | 当前没有"未入批"的消息（攒够 `extraction.minMessages` 才有批），或建批后没有未领取作业 | 正常现象：先正常聊天、再调一次；若持续 0 且 `ok:false`、error 含"总结模型"，是宿主模型不可用（见 §10.1） |
| `companion_memory_extract` 返回 `ok:false`、error 含"总结模型不可用" | 宿主 `llm` 服务不可用 / `host-llm.mjs` 构造失败 / 未配置 provider | 看 `logs/memory-engine.jsonl` 与 `host-llm` 的失败信息；显式通道不受 `extraction.enabled` 影响，但仍需模型 |
| 后台从不自动提炼（即使 `extraction.enabled=true`） | 宿主目前不会周期性调用 `engine.noteBatch()` 建批，只有 `capture`（只排空不建批）与显式工具会建批 | 已知缺口，见 §10.1；临时办法：让bot调一次 `companion_memory_extract` |
| 作业一直 `failed` | 模型 4xx/5xx、输出不是 JSON、超时；第 5 次后不再自动重试 | 看 `memory_jobs.last_error`（`companion_memory_pending` 不显示作业，用只读脚本查表）；修好模型后用 `requeueJob` 重排 |
| 剧情内容出现在现实回答里 | 该行 `world_id` 为空却写了 `roleplay_world` 之外的内容；或写入了 `user_global` | 用 `companion_memory_forget` 撤回，检查抽取闸门日志（`reason:roleplay*` 标签） |

`explain` 原因码速查：`status-<s>`（非 confirmed）、`scope-mismatch`（用户/角色/世界不符）、`expired`、`not-yet-valid`、`inactive`、`low-coverage`（DF 加权覆盖率低于 `coverageFloor`）、`semantic-no-overlap` / `semantic-below-floor` / `missing-vector`（向量通道）、`lexical-error` / `semantic-error` / `vector-error`（通道异常降级）、`empty-candidate-pool`、`no-viewer`、`no-database`。

---

## 9. 测试与验证

```powershell
# 记忆子系统全量（含端到端集成）
cd plugins\companion-memory
node --test test\*.test.mjs

# 只跑端到端（真实 sqlite + 真实 wiki + local embedder + 假 llm，全部临时目录）
node --test test\integration.test.mjs

# 旧基座回归（不能被破坏）
cd ..\companion-foundation
node --test
```

端到端用例覆盖（`test/integration.test.mjs`，13 个）：

1. 迁移 767 条全部有归属、二次运行 0 新增、对账 17 项通过、bot action 不进现实、导入事实可召回；
2. 跨会话（引擎 A 写 → 引擎 B 召回，带来源/现实级别）；
3. 纠正（茶→咖啡：只剩新事实、旧记录 `superseded`、`memory_revisions` 有 supersede）；
4. 未兑现计划（假模型 planned → `commitment`/`soft_echo`，注入不含"已经去过"）；
5. 剧情隔离（`w1` 在现实与 `w2` 的召回/注入/Wiki 全不可见，`w1` 内可见）；
6. 敏感事件（`avoid_unless_asked` 正文不进注入与 Wiki，只留占位）；
7. 故障重启（关库重开：游标/作业/记忆仍在，续跑不重复写，`attempts` 不虚增）；
8. 降级（向量全失败、模型抛错、空库、`application_id` 不符、非法路径：`contextFor()` 不抛、`status()` 可用）；
9. Wiki（同输入两次编译字节一致、人工区保留、`index` 不被当主题返回）；
10. `§15` 作业队列扩展（`claimJob(streamKey)` / `enqueueJob(force)` / `requeueJob` 存在即验证）；
11. 混合检索（本地向量入库后改写问法仍命中，`explain` 报告通道）；
12. 注入预算（数据再多也 ≤ `budgetChars`，抬头固定）；
13. 真实聊天→提炼→召回（开关关闭时后台不调模型；显式提炼落库并可召回；无模型时如实报错；建批后后台排空可处理）。

当前状态见 §10.4。

---

## 10. 已知限制与未做项

### 10.1 自动提炼的两条通道（2026-10-27 已打通）

**已修**：`plugins/companion-foundation/index.mjs` 现在总是把懒加载模型代理传给引擎（`createMemoryEngine({..., llm: llmProxy })`）；代理内部用 `ctx.get('llm')`（不需要 `inject`）拿服务，路由从 `agentDefaultModel.currentSelection()` 解析，`extractNow` 在模型不可用时返回 `ok:false` 而不是假装 `processed:0`。

| 通道 | 触发 | 受 `extraction.enabled` 限制 | 建批 |
| --- | --- | --- | --- |
| 后台 | 每条消息 `capture()` 命中后：先 `noteBatch()` 再 `drainJobs({background:true})` | **是**（关着直接返回 `extraction-disabled`，不花模型调用） | 攒够 `extraction.minMessages` 自动建批 |
| 显式 | 用户调 `companion_memory_extract` → `extractNow()` | **否**（本次调用内强制 `enabled:true`） | `noteBatch({minMessages:1})` |

**已解决的阻塞（2026-10-27 22:40 真实模型验证）**：此前提炼总是「0 个内容块」。根因有两层：
1. provider 要求请求头带 `x-opencode-session-id`，后台调用没传 `sessionId`，被拒为 `INVALID_REQUEST: MissingSessionID`；
2. `llm` 服务把 adapter/dispatch 失败包装成 **`finish` 块**（`reason.kind='error'`）而不是抛错，所以只看到空块列表。

修法：`host-llm.mjs` 始终发送会话 id（无真实会话时用 `companion-memory-<pid>` 合成 id），并把 `finish.failure` 的 code/message 抛出来（还会在不支持推理强度/上下文超限时降级重试一次）；`plugins/companion-memory/index.mjs` 的 `drainJobs` 把当前会话 id 透传给 `jobLlm`。
验证：一次 `companion_memory_extract` → 2 个批次全部 `done`，`candidates=2 / accepted=2 / inserted=2 / evidence=2 / failed=0`，落库为 `event(session_recent, soft_echo)` 与 `commitment(user_persona, soft_echo)`（「明天去文庙」被识别为计划，不是已完成事实）。
`extraction.enabled` 现为 **true**；改动配置后需要重启桌面才生效（配置在插件挂载时读取一次）。

排障提示：`companion_status.memory.jobs` 应能看到 `done` 递增；若 `stats.memories` 长期不增长，看 `extraction.minMessages`（默认 6）与 `logs/memory-engine.jsonl` 的 `jobs-drained` / `operation-failed`，失败批次用 `db.requeueJob(id,{resetAttempts:true})` 重排。

### 10.2 未联通

- **QQ / B 站 / 语音**：未接入。旧 AstrBot 快照是**单向独立副本**，不会与 AstrBot 双向同步。
- **多用户**：schema 与可见性按 `user_id`+`persona_id`+`world_id` 设计，但桌面只绑定本地 owner（`identity.json`），没有切换用户/多租户 UI。
- **剧情世界**：引擎门面把 `viewer.worldId` 固定为 `''`（`viewerFor()`），所以桌面运行期**无法进入剧情世界**；`roleplay_world` 隔离能力只在库层与测试中可用，等宿主提供 world 绑定时才生效。
- **远程 embedding**：只做了"配置校验 + 失败降级 + 熔断"的代码与桩测试，**没有对真实端点做过联调**（不产生费用、也不验证真实维度/鉴权）。

### 10.3 行为边界

- **本地向量不是语义模型**：`hash-bigram-256` 是中文二元组的确定性哈希，只是字面通道的近似；真正"完全换一种说法"（无共享二元组）不会召回。想提升需要接真实 embedding（remote）或调 `retrieval.semanticMinScore`。
- **召回有覆盖率闸门（DF 加权）**：字面通道要求 `Σidf(命中)/Σidf(查询词元) >= retrieval.coverageFloor`（默认 0.15），且至少命中 1 个词元；单词元查询只需命中 1 个。目的是"无关问题不注入无关旧记忆"（真实 777 条库上无关问题峰值 0.0985）。副作用：完全不含问句关键词的改写仍召回不到；把 `coverageFloor` 调到 0.4 以上会让长自然问句变成 0 条。
- **自动提取默认关闭，且后台建批仍缺一环**：`extraction.enabled` 只放开后台通道；宿主还没有周期性调用 `engine.noteBatch()`，见 §10.1。显式 `companion_memory_extract` 可用。
- **导入的旧对话摘要会进 Wiki**：`conversation_summary`（262 条）是 `imported_summary`，会出现在"重要事件"页；它们不是用户确认事实，介意的话用 `companion_memory_forget` 改成 `retracted` 或调高闸门/换 `mention_policy`。
- **Wiki 多世界同目录会互相覆盖**：`compileWiki(dir, viewer)` 按 viewer 重写同一目录的文件。桌面只有现实 viewer 所以现在无碍；一旦启用剧情世界，必须按 world 分目录（当前配置只有一个 `wiki.dir`）。
- **`index.md` 不列主题页自身**：它登记在 `wiki_pages` 但 `scope='system'`，`companion_wiki_index` 会过滤掉它。
- **忘记=撤回，不是删除**：`retracted` 保留 `source_events` 与修订历史（审计需要）。真要物理删除得手工 `DELETE` + 重建索引。
- **`memory_relations` 只有库 API**，没有工具/UI 写入。
- **`session_recent` 没有清理任务**：过期行只是读取时被过滤，文件会留着。
- **`injection.includeIdentity` / `includeWikiSummary` 目前未被引擎读取**：身份文本由宿主层拼，Wiki 摘要不进自动注入（只有 `companion_wiki_get` 按需读）。
- **`backup()` 只包含数据库**，不含 `home/memory/wiki/`；Wiki 可以重建，不必备份。
- **并发**：桌面是单进程；WAL + `busy_timeout` 能扛住"另一个只读脚本"，但不保证多写进程安全。
- **时间戳**：`valid_from` 用真实系统时钟（不是注入时钟），所以"库里的时间"和"测试里的 now"可能不同；排障时以库里 `created_at/updated_at` 为准。

### 10.4 当前验证状态（2026-10-27，审计修复后）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 记忆子系统全量 | `cd plugins/companion-memory && node --test test/*.test.mjs` | **220 项全绿**（`integration.test.mjs` 13 项端到端） |
| 旧基座 + 宿主装配回归 | `cd plugins/companion-foundation && node --test store.test.mjs memory.test.mjs integration.test.mjs memory-mount.test.mjs` | **17 项全绿**（含 `a broken database degrades to legacy`、`explicit extraction runs end to end`、`background extraction batches captured messages`） |
| 只读体检 | `node scripts/check.mjs` | `state=openable / memories=781 / embeddings=778 / wikiPages=5 / integrity.ok=true`（脚本纯只读） |
| 真实模型验收 | `node scripts/accept-memory.mjs` | **7/7 通过**（原会话升级、收据、纠正、召回、无关不注入、跨会话）；报告 `logs/memory-acceptance.json` |

**Codex 独立审计（首轮 FAIL）的 8 个 P1 已全部修复并各自补了回归用例**：
导入证据不再被包装成新用户陈述（`non_conversation_evidence` + 建批 SQL 层过滤）· 建批改用键集分页，不再停在最早 1000 条 ·
作业流按 `user:persona:world` 隔离且认领后校验 payload 世界 · 存储读取错误改为整批失败（不再空完成作业）·
`companion_memory_pending` 复用作用域与隐私规则（`avoid_unless_asked` 只返回占位）· Wiki 转义控制标记并严格解析人工区 ·
降级向量以 `batch.source` 立项（不再冒用远端身份，降级轮不写库）· 后台自动建批接通。
P2 已修：无变化更新不再升修订号、正文变更后向量失效、错误配置形状不再抛错、`scripts/check.mjs` 改为只读、开库完整性分级（`full|quick|skip`）。

仍未做（不是测试红）：§10.1 的真实模型端到端验收、§10.2 的 QQ/B站/语音/多用户、§10.3 的行为边界。

---

## 11. 管理界面与宿主 API（companion-memory-studio）

图形化入口在**侧栏「记忆档案」图标**（插件 `@local/dsh-companion-memory-studio`，已装进 `desktop` profile，可在 设置 → 插件 里单独禁用）。

### 11.1 运行形态

| 部分 | 位置 | 职责 |
| --- | --- | --- |
| Host 半 | `plugins/companion-memory-studio/index.js` | 在 profile 层创建**进程内唯一**的记忆引擎，`ctx.provide('companionMemory', { engine, identity, root })`，并挂 `/api/companion-memory/*`（需要浏览器认证，owner-only） |
| 复用方 | `plugins/companion-foundation/index.mjs` | 先用 `ctx.get('companionMemory')`；没有（插件被禁用/未装）时退回"preset 自带引擎"，行为与 v0.4.0 一致 |
| Client 半 | `plugins/companion-memory-studio/client.js`（由 `src/client/*.js` 拼装） | 注册 `sidebar.panellist` + `main`，渲染 7 页工作台 |
| 引擎管理句柄 | `plugins/companion-memory/index.mjs` → `internal()` | 共享同一条 SQLite 连接与 owner viewer：`db / backend / version / config / configPath / databaseFile / wikiDir / viewer() / initialize / ensureEmbeddings / compileWiki / resetStaleRunning` |

**为什么必须唯一**：两个引擎会各自持有一条写连接与一个作业 drainer；共享后 `logs/memory-engine.jsonl` 在每次启动只应出现**一条** `sqlite-opened`。重启后如果看到第二条，说明 `ctx.get('companionMemory')` 没解析到（检查插件是否被禁用、或 preset 是否在别的 profile 下）。

### 11.2 接口清单（精确路径，参数走 query / JSON body）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/companion-memory/summary` | 计数、作用域/类型分布、通道状态、作业、最近记忆 |
| GET | `/api/companion-memory/memories` | `query/scope/kind/status/limit/offset/sort` 分页列表 |
| GET / POST | `/api/companion-memory/memory` | 详情（`id`、`reveal=1`）/ 写操作（`action: revise·policy·archive·restore·delete`） |
| GET | `/api/companion-memory/wiki` | 主题索引 |
| GET / POST | `/api/companion-memory/wiki-page` | 页面正文（含 `status`）/ 只写人工注释区 |
| GET | `/api/companion-memory/preview` | 真实 `retrieve`+`render` 诊断（`q`、`limit`） |
| GET | `/api/companion-memory/reviews` | 待确认候选（脱敏）+ 失败作业 |
| POST | `/api/companion-memory/review` | `{action:'requeue', jobId}` |
| GET / POST | `/api/companion-memory/settings` | 白名单配置读取 / 写回 `memory.config.json`（需重启生效） |
| GET | `/api/companion-memory/timeline` | 证据事件流（短预览，`limit ≤ 200`） |
| POST | `/api/companion-memory/maintenance` | `rebuild` / `compile-wiki` / `integrity` / `extract`（无会话时明确失败） |

统一信封 `{ ok, data, meta:{source,schemaVersion,observedAt} }` / `{ ok:false, error:{code,message} }`。隐私规则与工具层一致：`avoid_unless_asked` 的正文在列表/预览/审核/时间线里为空，只有详情 `reveal=1`（前端还有一次确认）才取回。

### 11.3 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 侧栏图标在，打开全是"无法连接宿主" | Host 路由没注册（常见于同一路径登记了 GET+POST 两条，Connection 按 path 去重会抛错） | 看 `logs/memory-studio.jsonl` 的 `api-failed`；确保 `server.mjs` 用 `groupRoutesByPath()` 合并后按方法分发；改完**重启桌面** |
| 重启后 `memory-engine.jsonl` 有两条 `sqlite-opened` | `companionMemory` 服务没被复用 | 检查插件是否 enabled（`plugin_manager list_plugins`）、profile 是否为 `desktop` |
| 设置页保存后没变化 | 配置写盘但要重启才生效 | 重启桌面，再看 `summary.config` |
| 显微镜结果为空但记忆库能搜到 | 查询不满足覆盖闸门，或表达策略把正文藏起来 | 看 `explain` 的 `filteredReasons`；`coverageFloor` 见 §10.3 |

### 11.4 列表排序
管理界面里**所有列表都是最新在前**：总览「最近记忆」、记忆库（默认 `sort=recent`）、时间线、审核队列、详情里的证据与修订链。

- 记忆排序用 `db.listMemoriesByTime`（`ORDER BY updated_at DESC`），**不是** `db.listMemories` —— 后者是「重要度优先」（`importance DESC, updated_at DESC`），召回依赖它，所以两者并存、语义各自固定。
- 时间线用 `db.recentEvents`（`ORDER BY occurred_at DESC`，支持 `beforeOccurredAt` 键集游标），**不是** `db.eventsSince`（正序游标，后台建批依赖它）。
- 记忆库的窗口从 `SCAN_LIMIT = 5000` 行里取（当前库 773 行，等于全量）；因此 `sort=importance` / `confidence` 也会在**全库**上排序。若将来库涨到几万行，需要改成 SQL 侧排序 + 键集分页。

体检与自测（都只读，不碰生产库）：`node scripts/verify-studio.mjs`、`node plugins/companion-memory-studio/scripts/build-client.mjs --check`、`node plugins/companion-memory-studio/scripts/smoke-client.mjs`、`node scripts/check-studio-api.mjs`；接口单测 `node --test plugins/companion-memory-studio/test/api.test.mjs`（29 项）。

### 11.5 远端模型（向量 / 重排序）

设置页「远端模型」两组表单可以直接填 **API 地址 / 模型 / API Key**，并带「测试连接」（`POST /api/companion-memory/settings/test`，`{target:'embedding'|'rerank', draft?}`）。

- 探测读**磁盘**配置（不是运行中的内存配置），所以保存完立刻能测，不用等重启。
- `draft` 可以带未保存的地址 / 模型 / 维度 / 超时 / `apiKey`，先测通再保存；`draft.apiKey` 只进内存，不落盘、不回显。
- 失败码固定：`not-configured` / `no-key` / `network` / `timeout` / `http-401` / `http-403` / `http-4xx` / `http-5xx` / `bad-shape` / `dimension-mismatch`（带实际 `dimensions`）/ `empty-vectors`。
- 设置页 GET 的 `editable` 也是磁盘值（保存即回显），`backend` 才报告运行中的后端。

| 配置段 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| `embedding` | `provider` / `baseUrl` / `model` / `dimensions` / `timeoutMs` | `local` / 空 / 空 / 256 / 4000 | `remote` 调 OpenAI 兼容 `POST {baseUrl}/v1/embeddings`；维度 64–4096（Qwen3-Embedding-4B 是 2560）；维度不符 → 该轮回落本地哈希且**不写库** |
| `rerank` | `enabled` / `provider` / `baseUrl` / `model` / `timeoutMs` / `topN` / `blend` | `false` / `remote` / 空 / 空 / 4000 / 0 / 0.7 | 融合之后、MMR/预算之前执行一次重排；`topN=0` 表示全部候选；`blend` 是重排分数的占比 |

**密钥存放**：`home/companion/remote-models.json`（`{schemaVersion, embedding:{apiKey}, rerank:{apiKey}}`，原子写）。`loadConfig()` 读它并只在内存里合并成 `config.embedding.apiKey` / `config.rerank.apiKey`；`memory.config.json` 里永远没有 key。接口只回 `secrets.embeddingKeySet` / `secrets.rerankKeySet`。

**失败语义**：
- 向量远端失败/超时/熔断 → 回落本地哈希向量，`explain` 记 `semantic-degraded`（既有行为）。
- 重排失败/超时/无 key/形状不对 → **fail-open**：保持融合顺序，`explain.filteredReasons['rerank-unavailable'] += 1`，不影响这一轮对话。
- 探测接口不写库、不写向量、不记正文；无 key 直接 `no-key` 且不发请求。

**排障**：
| 现象 | 处理 |
| --- | --- |
| 设置页填了 key 但仍显示「未设置」 | key 只在提交时写入；刷新后看 `secrets.*KeySet` 是否为真，确认 `remote-models.json` 已生成 |
| 测试连接 401 | key 无效或该服务用的是别的鉴权头；确认 baseUrl 是否带 `/v1` |
| 向量仍是 `hash-bigram-*` | `provider` 不是 `remote`、缺 `model`，或维度不符被判降级；看 `logs/memory-engine.jsonl` 的 `sqlite-opened` 之后有无降级日志 |
| 重排没生效 | `rerank.enabled` 为假、候选 ≤1、查询为空，或本轮 fail-open（看 `explain.filteredReasons`） |
| 改完没变化 | 配置与密钥都在启动时读取，必须重启桌面 |

### 11.6 记忆时间（发生时间）

**规则**：每条记忆都必须有发生时间；缺省就是写入时刻，绝不留空。

| 链路 | 时间来源 | 代码 |
| --- | --- | --- |
| `companion_remember` | 新增可选参数 `occurredAt`（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`，Asia/Shanghai），不填＝现在 | `plugins/companion-foundation/index.mjs`、`index.mjs` 的 `remember()` |
| 数据库兜底 | `rememberFact` 缺省 `occurred_at = now`，`valid_from` 同值 | `lib/db.mjs` |
| 自动提炼 | 候选事实取「最新证据事件时间」 | `lib/jobs.mjs`（原已实现），prompt 另给「现在 + 本批区间 + 每条消息时间」→ `lib/extract.mjs` |
| 自动注入 | JSON 行里的 `at`＝`YYYY-MM-DD HH:mm`（+08:00），缺失写「未知」 | `lib/render.mjs` |
| `companion_recall` | 同上（字段仍是 8 个，没加新键） | `lib/render.mjs` |
| 管理界面 | 记忆库/总览/详情显示「发生时间」，与「更新时间」分开 | `plugins/companion-memory-studio/lib/read.mjs`、`src/client/pages-vault.js`、`pages-overview.js` |

**与 AstrBot 对齐**：只给绝对时间（没有「N 天前」）；时区固定 Asia/Shanghai；但**不抄** AstrBot 的时区混存 bug——`parseLocalMoment`/`formatMoment`（`lib/text.mjs`）固定 `+08:00`，与本机 TZ 无关。详见 `design/memory-time.md`。

**旧记录回填**：`node scripts/backfill-memory-time.mjs`（预演）／`--apply`（先整库备份）。只补 `occurred_at` 为空的记录，时间只能来自 `memory_evidence → source_events.occurred_at`；没有证据就记 `unresolved`，**不编造**；不动正文、不批量改 `valid_from`。2026-10-28 实测 776 条记忆全部已有时间（导入/抽取本来就带），无需写入。

### 11.7 远端模型迁移（来自 AstrBot，2026-10-28）

| 项 | 值 |
| --- | --- |
| 向量 | `https://api.siliconflow.cn/v1/embeddings`，`Qwen/Qwen3-Embedding-4B`，维度 **2560**，`timeoutMs=20000` |
| 重排 | `https://api.siliconflow.cn`（+`/v1/rerank`），`Qwen/Qwen3-Reranker-8B`，`enabled=true`，`timeoutMs=1500`，`topN=0`，`blend=0.7` |
| 密钥 | 只写 `home/companion/remote-models.json`（两段各 51 字符）；`memory.config.json` 内没有任何 key |
| 备份 | `home/companion/backups/remote-migration-<UTC 时间戳>/` |
| 脚本 | `node scripts/migrate-astrbot-remote.mjs --dry-run` / `--apply --verify`（只读 AstrBot `data/cmd_config.json`，不改它） |
| 验证 | 2026-10-28 实连：向量 200/2560 维/486ms；重排返回 2 个分数/194ms |

**生效条件与代价**：配置在引擎挂载时读取 → 重启桌面后生效。切换向量模型后，旧的 256 维本地哈希向量与 2560 维远端向量不是同一个索引，`ensureEmbeddings` 会在后台分批补（每轮最多 20 批），补齐前语义通道退化为 FTS + 部分向量；补齐需要真实 API 调用。重排开启后每次召回多一次 ~200ms 调用，超时/失败照旧 fail-open。

### 11.8 已知语义与决策（避免重复讨论）

| 主题 | 决定与依据 |
| --- | --- |
| 发生时间索引 | schema **v2**：`memories(occurred_at)` 建索引。旧库可写打开时自动迁移（`MIGRATIONS`，只 `CREATE INDEX IF NOT EXISTS`）；只读打开不迁移，`schema.outdated=true`，`logs/memory-engine.jsonl` 记 `schema-outdated-readonly`。迁移后记 `schema-migrated`。 |
| 同值不同时间 | **不拆成多次活动**：同 owner/world/scope/subject/predicate 的同值确认仍视为同一条事实，重复陈述只追加证据、不改 `occurred_at`。要统计「活动次数/时间线」需要另建 occurrences 表，属独立需求。 |
| Wiki 时间格式 | 维持 ISO（带 Z、无歧义）。若要与 Studio 统一，先加 Wiki 渲染版本再一次性重编译，不做正文正则替换。 |
| 导入时区 | 无时区的历史时间固定按 **+08:00** 解释（`parseLocalMoment`），不再依赖运行环境 TZ；已导入的历史数据不重写。 |
| 向量覆盖率 | 按「可召回的确认记忆」计算；retracted/archived/superseded 不为补向量恢复状态，`tone_only` 本身不是跳过条件，**远端降级不计为补齐成功**。 |
| 向量隔离与重建 | 向量按实际 `provider/model/dimensions` 隔离，旧的 256 维本地哈希保留以便显式回切；换维度后 `pendingEmbeddings({dimensions})` 会把旧行视为待补；重建只补目标缺失向量，**不能用全量清空代替定向修复**；精确清理用 `deleteEmbeddings({provider, model})`。 |
| 重启报告字段 | `healthy` = 「**启动之后**新出现的实例 + 启动之后写过的 stdout 里的 URL + 该 URL 真正应答（GET，HTTP 200–499；401/403 同样算在应答）」；`healthy=false` 时保留兜底任务并让任务重试。判断不能用 HEAD（Host 对 HEAD 一律 401，会误报）。 |



