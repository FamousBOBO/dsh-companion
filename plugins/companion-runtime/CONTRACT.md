# companion-runtime 契约（C0 · v1 冻结）

状态：C0 冻结于 2026-10-29（Asia/Shanghai）。本文件定义 P1 认知连续性的实现合同；字段与方法在此冻结，实现内容以本仓库代码和测试为准。

## 1. 目标与边界

`companion-runtime` 只拥有**类型化认知状态**：领域事件、消费者收据、版本快照、目标与承诺、工作记忆检查点、信念与证据依赖、短期状态投影、影子提案、memory 出站队列。

不拥有：长期事实、偏好、关系、证据链与记忆 Wiki（归 `companion-memory`）；会话身份（归 `companion-foundation` 的 `identity.resolve`）；主动消息候选、门控、投递账本与发送器（归 `plugins/dsh-channel-qq/src/features/contact/`）。runtime 不创建第二个 sender、队列或投递账本，也不把承诺存储当作自动提醒许可。

默认 `mode: "off"`：插件可挂载、可诊断，但不写认知状态、不注入、不外发。影子模式 `mode: "shadow"` 只写 `shadow_proposals`。`mode: "active"` 才写正式状态并注入工作记忆。

## 2. 存储

- 数据库：`<root>/home/companion/companion-runtime.db`（`DSH_COMPANION_RUNTIME_DB` 可覆盖），独立迁移版本 `schema_migrations`，当前 `SCHEMA_VERSION = 3`（v2 为 `memory_outbox` 增加 `claimed_until`/`claim_owner`，旧库用加列迁移，不重写行；v3 只新增 `agenda_items`、`agenda_occurrences`、`heartbeat_cursor` 三张表及其索引，不改既有表、不重写既有行，见 §12.2）。`version > SCHEMA_VERSION` 的未来库明确拒绝（`schema-newer`），不再“直接返回”。
- 表：`schema_migrations`、`scope_snapshots`、`domain_events`、`consumer_receipts`、`goals`、`commitments`、`working_memory`、`wm_checkpoints`、`beliefs`、`belief_evidence`、`belief_dependents`、`role_state`、`shadow_proposals`、`runtime_lease`、`runtime_meta`、`memory_outbox`，以及 v3 新增的 `agenda_items`、`agenda_occurrences`、`heartbeat_cursor`。字段见 `lib/schema.sql`。
- 作用域 `scope = {userId, personaId, worldId}`，规范化键 `u:<userId>|p:<personaId>|w:<worldId>`；`worldId` 空值统一为 `world:default`。`sessionId` 只作来源痕迹，不构成身份，不参与授权。
- 长期事实与用户画像不复制到本库；只保存 memory 引用（`memory_outbox.receipt_id`、`root_evidence`）。

## 3. 事件信封

`lib/events.mjs` 冻结以下字段：`schemaVersion`、`eventId`、`kind`、`scope`、`scopeKey`、`sessionId`、`occurredAt`、`recordedAt`、`correlationId`、`causationId`、`rootEvidenceIds`、`realityStatus`、`evidenceStatus`、`configVersion`、`modelVersion`、`payload`。

- `occurredAt` / `recordedAt` 均为 epoch 毫秒（UTC 瞬时值）；迟到事件按 `occurredAt` 计入时间线，不修改已执行动作。
- 日志顺序由 `domain_events.seq` 保证（见下文补充语义），恢复以 `seq` 为准。
- `realityStatus ∈ {actual_tool_activity, simulated_world, hypothetical}`；`evidenceStatus ∈ {observed, inferred, confirmed}`。`observed` 只表示收到了输入，`confirmed` 必须附确认依据（调用方责任）。
- `eventId` 由 `(kind, scopeKey, occurredAt, sessionId, payloadDigest)` 内容寻址；同一现实事件重复投递得到同一 ID。已有同 ID 但 `kind`/`occurredAt` 不同 → `conflicting-event`，不静默覆盖。
- `schemaVersion` 必须**严格等于数字 `1`**：字符串、`NaN`、`Infinity`、0、未来版本一律拒绝（`normalizeEvent`、`appendEvent`、`dispatchEvent` 快捷入口同一规则），不按当前语义落库。
- 事件执行去重键 `(consumer, eventId)`；根证据去重按 `rootEvidenceIds`。两者分开，不能互相替代。

### 消费者

| consumer | 消费事件 |
| --- | --- |
| `state` | `state/impulse`、`state/recovered` |
| `goals` | `goal/proposed`、`goal/accepted`、`goal/started`、`goal/paused`、`goal/resumed`、`goal/completed`、`goal/cancelled`、`goal/step`、`goal/updated`、`goal/overdue`、`commitment/made`、`commitment/closed` |
| `working-memory` | 上述 goal/commitment 事件 + `topic/switch`、`topic/interjection`、`topic/resume` |
| `beliefs` | `belief/asserted`、`belief/evidence`、`belief/corrected`、`belief/expired` |
| `bridge` | `memory/ingest-request`、`memory/correction-request` |

`appendEvent` 幂等；`applyEvent` 在一个 `BEGIN IMMEDIATE` 事务里同时提交投影、作用域版本和收据，抛错整笔回滚。消费者之间互不阻塞：一个消费者失败不影响其他消费者。

补充冻结语义（实现后按实现固定）：

- `domain_events.seq` 是**日志顺序**（在追加事务内分配），`occurred_at` 是**时间线顺序**。恢复重放按 `seq`，短期状态推进按 `occurred_at`；迟到事件不会让重放倒流。
- 每个消费者在自己的 SAVEPOINT 中执行，失败只回滚该消费者已写的行（收据、投影、关系表一起），其他消费者照常提交。
- 若该事件的**所有**合法消费者都以确定性拒绝失败（`RuntimeError`，如 `invalid-transition`、`stale-revision`、`silence-not-evidence`、`already-superseded`），追加本身回滚，事件不进入日志（`dispatchEvent` 返回 `{inserted:false, rejected:true, results}`）；普通 `Error` 视为暂时失败，事件保留供恢复重试。这样被拒的旧提案不会污染重放。
- **权威消费者否决**：`goal/*`、`commitment/*` 的权威是 `goals`，`belief/*` 的权威是 `beliefs`。权威消费者确定性拒绝时，同一事件的其他消费者（如 `working-memory`）不执行、不留收据，事件整笔回滚——被拒的目标变更不能移动工作记忆焦点。

### 消费者 reducer 合同

每个认知模块导出 `apply<X>Event({ db, event, slice, now })`，返回 `{ slice?, result?, extra? }`：

- `slice` 覆盖该消费者在 `scope_snapshots.payload[consumer]` 的命名空间片段（可选）。
- `result` 写入收据，仅含 ID、版本、计数与理由码，不含私人正文或思维链。
- `extra(db, event)` 用于同事务的关系表写入（目标、信念、检查点）。

`index.mjs` 只做装配，不重复实现 reducer。

## 4. 模块与冻结签名

### `lib/state.mjs`（C4，纯函数，不碰数据库）

```js
export const STATE_DEFS;            // [{id, baseline, tauMs, min, max, weights:{kind:number}}]
export const DISABLED_BY_DEFAULT;   // 消融后无行为收益的变量默认关闭
export const BUDGET_WEIGHTS;        // 注入预算的变量系数（工程参数）
export const BUDGET_DEFAULTS;       // { base: 320, min: 160, max: 480 }
export function createStateSlice(now, { disabled = DISABLED_BY_DEFAULT } = {});
export function applyImpulse(slice, { id, amount, at, kind });     // 先衰减到 at，再加冲击并 clip
export function advance(slice, to, events);                        // events: [{id, amount, at, kind}]，按发生点分段
export function normalize(slice, to);                              // { id: number ∈ [0,1] }
export function injectionBudget(slice, to, { base, min, max });    // 确定整数，仅依赖归一化状态
export function ablate(slice, ids, now);                           // 指定变量固定在基线
export function describe(slice, to);                               // { values, normalized, budgetChars, evaluatedAt }
export function applyStateEvent({ event, slice, now });            // 消费者 reducer，读 payload.amount
```

实现已按本节落地（`lib/state.mjs`，18 项测试）。补充冻结语义：`weights[kind]` 表示该事件类型对变量的单位冲击系数，冲击强度取 `payload.amount`；`state/impulse` 会同时影响三个变量（系数见 `STATE_DEFS`），未知 kind 不写状态并在收据里返回 `kind-not-weighted`；`applied` 标记按 `(id, at)` 有界去重（上限 512），持久去重仍由 `consumer_receipts` 负责；迟到事件在当前评估时刻结算，时间轴不倒流。

语义固定：单步 `s(t+Δ) = clip(b + (s(t)-b)·e^{-Δ/τ} + Σ w·a)`；一个区间内多个事件按 `occurredAt` 分段推进；`clip` 只在事件施加后执行，采样本身不改变轨迹；因此 10/60/300 秒采样在同一结束时刻的归一化值绝对误差 ≤ 1e-6。

初始变量（工程参数，非测量值）：`tension` b=0.2 τ=1800s，`energy` b=0.65 τ=3600s，`focus` b=0.5 τ=900s；范围 [0,1]。`injectionBudget` 必须对至少一个固定夹具产生可观察差异，否则该变量进 `DISABLED_BY_DEFAULT`。

### `lib/goals.mjs`（C2）

```js
export const GOAL_STATUS;           // proposed | accepted | running | paused | completed | cancelled
export const AUTHORIZATION;         // none | reminder | tool | proactive-contact
export function applyGoalEvent({ db, event, slice, now });
export function proposeGoal(db, { scope, title, source, authorization, deadlineAt, nextStep, now, expectedRevision });
export function transitionGoal(db, { scope, scopeKey, goalId, to, expectedRevision, reason, now });
export function recordStep(db, { scope, scopeKey, goalId, step, expectedRevision, now });
export function updateGoal(db, { scope, scopeKey, goalId, patch, expectedRevision, now });
export function markOverdue(db, { scopeKey, now });
export function getGoal(db, scopeKey, goalId);
export function listGoals(db, { scopeKey, status, includeClosed, limit });
export function createCommitment(db, { scope, scopeKey, text, dueAt, goalId, now });
export function closeCommitment(db, { scope, scopeKey, commitmentId, reason, now });
export function listCommitments(db, { scopeKey, status });
```

规则：生命周期只允许 `proposed→accepted→running→paused→running`、`→completed`、`→cancelled`；`completed`/`cancelled` 终态，不复活（需要新目标并带因果引用）。所有变更校验 `expectedRevision`，不匹配抛 `StaleRevisionError`，绝不覆盖。`deadlineAt` 过期只设置 `overdue=1`，不自动完成、不删除。`authorization` 与目标内容分开保存，`none` 不因出现“提醒”字样自动升级。每个变更追加 `history` 摘要（动作、时间、理由码、版本），不存正文。

事件入口的拒绝码在此冻结：`goal/accepted|started|paused|resumed|completed|cancelled|step|updated` 缺少 `payload.expectedRevision` → `RuntimeError('revision-required')`；与存储版本不符 → `StaleRevisionError('stale-revision')`；`goal/proposed`、`goal/overdue` 豁免。**版本栅栏先于任何“无变化/同状态/同步骤”的短路**：新事件不能靠“反正结果一样”绕过栅栏；真正的重复投递由 `(consumer,eventId)` 收据在 reducer 之前拦下，不靠 reducer 的空操作。

### `lib/working-memory.mjs`（C2/C4）

```js
export function applyWorkingMemoryEvent({ db, event, slice, now });
export function focusGoal(db, { scope, scopeKey, goalId, expectedRevision, now });
export function checkpointGoal(db, { scope, scopeKey, goalId, reason, now });
export function switchGoal(db, { scope, scopeKey, goalId, expectedRevision, now });   // 先存旧目标检查点
export function resumeGoal(db, { scope, scopeKey, goalId, expectedRevision, now });   // 无 goalId 且多候选 → 消歧
export function currentFocus(db, scopeKey);
export function workingMemoryState(db, { scopeKey, now });
export function renderWorkingMemory(db, { scopeKey, budgetChars, now });
```

`workingMemoryState` 返回 `{ focusGoalId, goal:{goalId,title,status,overdue,nextStep,waitingOn,doneSteps}, commitments:[{text,dueAt,status}], lastEventAt }`。`renderWorkingMemory` 输出 ≤ `budgetChars` 字符，顺序固定：承诺 → 当前目标与下一步 → 等待条件 → 已完成步骤 → 当前 supported 且未过期的判断（【判断】）；预算裁剪不得丢承诺，判断只按整行追加且可省略。`resumeGoal` 在候选 >1 且未指定 `goalId` 时返回 `{ ok:false, code:'ambiguous-resume', candidates:[...] }`，不擅自选一个。`topic/interjection` 只做局部更新（不换焦点），`topic/switch` 先存检查点。

对外 API（`index.mjs`）：`switchFocus({sessionId|binding, goalId, expectedRevision?})` 发 `topic/switch`，`resumeFocus({sessionId|binding, goalId?})` 发 `topic/resume`，`workingMemory({sessionId|binding})` 返回上面的结构化视图；歧义时事件照常应用、收据里记录候选 id，焦点不动。

### `lib/beliefs.mjs`（C3）

```js
export const BELIEF_STATUS;         // supported | refuted | unknown | superseded
export function confidenceForRoots(roots);         // 只由独立根证据数量决定
export function applyBeliefEvent({ db, event, slice, now });
export function assertBelief(db, { scope, scopeKey, proposition, rootEvidenceIds, confidence, validUntil, now, source });
export function addEvidence(db, { scope, scopeKey, beliefId, evidenceId, rootId, relation, now });
export function correctBelief(db, { scope, scopeKey, beliefId, byEvidenceId, reason, replacement, now });
export function expireBeliefs(db, { scope, scopeKey, now });
export function addDependent(db, { scope, scopeKey, dependentId, beliefIds, kind, now });
export function currentBeliefs(db, { scopeKey, now });        // 注入用：不含 superseded/refuted
export function beliefHistory(db, { scopeKey, beliefId });
```

规则：置信度只由 `|distinct root evidence|` 决定（再次召回、转述、多模块引用都不提高）；同一根证据重复引用 `independence` 不变。**证据 → 根（及 relation）是不可变映射**：同一 `evidenceId` 换根或换关系 → 确定性拒绝 `evidence-root-conflict`；`roots`/`independence`/`confidence` 一律从 `belief_evidence` 实际行重算，创建、断言、补证据三条路径同一规则，入参不参与计数。`validUntil` 过期 → `status='unknown'`，保留证据与历史，不变成 `refuted`，也不推断“有空/拒绝”。明确纠正 → 原信念 `superseded`（保留 `superseded_by` 与新证据），依赖该信念的 `belief_dependents` 标 `invalid`；无关信念不受影响。`currentBeliefs` 只返回当前事实（`supported`/`unknown`），历史走 `beliefHistory`。

### `lib/bridge.mjs`（C3，跨库）

```js
export function enqueueIngest(db, { scope, scopeKey, event, namespace, payload, now });
export function applyBridgeEvent({ db, event, slice, now });
export function drainOutbox({ db, memory, scopeKey, now, limit, generation });   // memory 缺失 → 保留队列，不伪报成功
export function outboxStats(db, scopeKey);
```

- 投递的写入资格（停止、租约代次）在**每次外部调用之前**检查，调用返回后再次检查：一旦失去资格，本轮 drain 立即结束（`skipped='writer-fenced'`），未处理的记录保持 `queued`，不得把记忆已接收误记成失败或成功；新代次重投时依赖 memory 的幂等收据去重。
- 一次 drain 先在一个写事务里**认领**这批记录（`claimed_until = now + 60s`、`claim_owner = 每次 drain 唯一的 token`）；同进程内对同一数据库句柄的 drain 串行执行，并发 drain 看到空批次；每次外部调用前重新确认自己仍持有该行（`refreshClaim`），调用后所有回写都以 `claim_owner = token` 为条件。失去认领的旧 drain **不得**清掉新认领、不得修改行、也不得计入投递统计（`lostClaim`），本轮直接结束。崩溃或过期的认领在 TTL 后可由新 drain 重新领取，跨库重投依赖 memory 持久幂等收据。投递计数只按 `UPDATE` 实际影响行数累计，不按读到的快照累计。

- 目标侧公共入口（在 `plugins/companion-memory` 新增，先改 `CONTRACT.md` 再改实现，见该文件 §16）：

```js
engine.ingestDomainEvent({ subject:{userId,personaId,worldId}, namespace, eventId, transformVersion,
  rootEvidenceIds, realityStatus, evidenceStatus, content, occurredAt, mentionPolicy })
// → { status: 'accepted'|'pending'|'rejected'|'duplicate'|'retryable_failure', receiptId, recordId?, reason? }
```

去重键 `(namespace, scopeKey, eventId, transformVersion)`；重试返回原收据；来源冲突拒绝覆盖；推断/虚构不得落成用户事实。runtime 只经该入口写记忆，不直连记忆库表；`memory` 服务缺失/重载时出站项留在 `memory_outbox`，诊断可见，不声称已持久化。

`requestMemoryIngest` 的默认值是**安全默认**：`realityStatus='hypothetical'`、`evidenceStatus='inferred'`，这类请求会被 memory 拒绝或落成待审候选；调用方必须显式声明 `actual_tool_activity` 才可能写成已确认经历。runtime 自身不生产经历，P1 不因此伪造活动回执。

## 5. 生命周期、代次与停止

- 挂载时 `owner = <pid>:<mountedAt>:<random>`，`generation = randomUUID()`；`acquireLease({owner, generation, ttlMs})` 成功才可写。已有未过期租约归他人 → 保持只读，`status().lease = 'held-elsewhere'`。
- 所有提交带 `generation`；`runtime_meta.generation` 已被新代次覆盖时旧代次提交抛 `StaleGenerationError`（A10）。
- `stop()` 置 `runtime_meta.stopped=1`：之后所有提交抛 `RuntimeStoppedError`，已开始的短事务走到安全点；`stop()` 不撤回已经发生的外部动作。
- 热重载：`dispose()` 释放租约、定时器、监听器、数据库句柄；重复挂载不产生重复监听。

## 6. 注入与预算

- 注入只在 `mode === 'active'` 且 memory 服务可用时发生；失败静默降级（`diagnostics.injection = 'skipped'`），聊天路径不受影响。
- 注入文本总字符数 ≤ `config.injection.budgetChars`（默认 320），且与记忆注入合计 ≤ memory 配置的 `injection.budgetChars`（默认 2400）。实际预算取三者最小：配置预算、C4 短期状态上限（`describe(now).budgetChars`）、调用方剩余预算；裁剪只发生在工作记忆视图，**承诺行永远整条出现或整条省略，绝不逐字截断**。
- “承诺不丢”指持久保存：预算不足时可以省略展示，但必须通过返回结构说明（`state = budget-too-small | commitments-omitted | empty | full | trimmed`，附 `shownCommitments`/`omittedCommitments`），不得把省略报告成 `empty`，也不得静默丢弃数据库里的承诺。
- 普通状态推进零模型调用；runtime 自身不发起模型请求。

## 7. 影子模式

`mode='shadow'` 时所有写入走 `shadow_proposals`（`decision ∈ {accepted-shadow, rejected-stale, rejected-disabled}`），不写 `goals`/`beliefs`/`working_memory`/`scope_snapshots`。`mode='off'` 一律拒绝（`code='runtime-disabled'` 或挂载未启用时的 `'runtime-off'`），连数据库都不打开，不写任何表、不注入、不发消息；诊断只在进程内状态上回答。

## 8. 诊断与工具

`status({ scopeKey })` 返回 `{ version, mode, lease:{owner,generation,expiresAt} | 'held-elsewhere', stopped, eventCount, receipts:{consumer:count}, goals:{active,overdue}, beliefs:{current,unknown,superseded}, outbox, injection, shadow, dbFile, schemaVersion, generation }`，只含 ID、版本、计数、理由码。

工具由 `companion-foundation` 用 runtime 暴露的方法注册（runtime 自身不依赖宿主工具 API）：`companion_runtime_status`（读）、`companion_goal_list`（读）、`companion_goal_propose`（写，需 `expectedRevision` 的变更另有 `companion_goal_transition`）。影子/关闭模式下写工具只记录提案或返回禁用码。工具不得伪造身份，身份来自 `identity.resolve(sessionId)`。

## 9. 恢复

- 快照 + 事件用于恢复：`verifyRecovery(db, scopeKey)` 在内存库重放事件并比对投影，返回 `{ ok, mismatches, replayed, projectionVersion }`。
- 重放不重新调用模型、不重新生成历史评价、不重发消息；已存在收据跳过。
- 恢复后过期承诺保留待复核；停机期间只按规则推进时间状态，不补写未发生的活动。
- 检查点、目标、承诺、信念必须经事件创建，才能被重放复现；直接调用工作记忆 API 写入的检查点不会被重放（运行时只有事件路径，`index.mjs` 不暴露直接写入）。发现“线上有、重放没有”的行时，优先当成绕过事件路径的写入来查。

## 10. 验收映射

| 编号 | 主责模块 | 测试文件 |
| --- | --- | --- |
| A01 | `lib/events.mjs` | `test/events.test.mjs` |
| A02/A05 | `lib/beliefs.mjs` | `test/beliefs.test.mjs` |
| A03 | `lib/working-memory.mjs`、`lib/goals.mjs` | `test/working-memory.test.mjs`、`test/goals.test.mjs` |
| A04/A06 | `lib/working-memory.mjs`、`lib/goals.mjs` | `test/working-memory.test.mjs`、`test/goals.test.mjs` |
| A07 | `index.mjs` 提案路径 | `test/proposals.test.mjs` |
| A08 | `lib/events.mjs` + `lib/db.mjs` + `lib/snapshot.mjs` | `test/events.test.mjs`、`test/recovery.test.mjs` |
| A09 | `lib/state.mjs` | `test/state.test.mjs` |
| A10 | `lib/db.mjs` 租约/代次 | `test/lease.test.mjs`、`test/lease-crossprocess.test.mjs` |
| A11 | `lib/bridge.mjs`、`index.mjs` | `test/bridge.test.mjs`、`test/degraded.test.mjs` |
| A12 | `index.mjs` 模式 | `test/modes.test.mjs` |
| A13 | 集成 | `test/integration.test.mjs`、`test/foundation-mount.test.mjs` |

测试使用临时目录或 `:memory:`，不读写生产私人记忆；真实模型检查另列，使用合成对话。

## 11. 与既有系统的接口

- 共享记忆服务：`ctx.get('companionMemory')?.engine` 或 `sharedEngineFor(root)`（foundation 已有逻辑）；借用者不关闭共享引擎，重载后重新取实例。
- 身份：`identity.resolve(sessionId)` → `{userId, personaId?, worldId?}`；runtime 不自行解析会话。
- 主动消息：只读 contact 的状态用于诊断，不写其账本、不启用其开关。
- QQ 外发：runtime 不注册任何发送路径；本任务 `dryRun`/`allowExternalSend` 保持不变。

## 12. H1 日程 / H2 零模型心跳增量合同（C5 冻结于 2026-10-30，Asia/Shanghai）

本节是 P1 之上的**增量合同**，冻结对象是 H1（可持续日程）与 H2（规则心跳）的表、事件、API、权限、模式、游标、暂停/恢复语义。与 §1–§11 冲突时以本节为准；本节未改动的 P1 语义全部保留。依据：`architecture-wiki/12-agenda-heartbeat-development.md`（历史提案）与 `design/h1-h2-agenda-heartbeat-plan-20261030.md`（本轮任务书）。合同冻结先于实现，实现偏差必须回写本节。

### 12.1 边界（不可越权）

- 日程是**活动机会**，不是提醒、不是外部动作许可。允许空闲、放弃、零成果娱乐；不自动填满生活模板，不自动写活动经历，不写 `memory_outbox`，不向 contact 账本写候选，不接管既有 reminders runner。
- H1/H2 都**不注册任何发送路径**；`dryRun`/`allowExternalSend`、免打扰选择、contact 门控一律不动。
- 不新增模型调用，不按 tick 轮询模型；H1/H2 新增路径的外发计数必须恒为 0。
- 新增两个独立开关 `agenda.enabled=false`、`heartbeat.enabled=false`，默认关闭；关闭时读接口明确报 `disabled`，不伪报 active。暂停心跳**不**调用 `runtime.stop`、不撤销 writer 租约、不停 bridge/认知状态/聊天。
- 后台只遍历**已持久且获授权**的作用域（`scope_snapshots` 中存在的 `scopeKey`），身份永远由宿主可信绑定产生；禁止 `resolve('heartbeat')` 虚构会话，禁止从内容猜 QQ 身份。

### 12.2 存储（schema v3，只增不改）

`SCHEMA_VERSION = 3`。迁移只执行 `CREATE TABLE/INDEX IF NOT EXISTS` 与一条 `schema_migrations` 记录；不 `ALTER`、不重写既有行，因此 v2 → v3 可**前向**打开（旧程序不认 v3，见 §12.7 回退）。`version > SCHEMA_VERSION` → 抛 `RuntimeError('schema-newer')`，不静默返回。

```sql
agenda_items(
  item_id TEXT PK, scope TEXT, revision INTEGER, title TEXT, category TEXT,
  source TEXT, rule_kind TEXT, time_zone TEXT, local_date TEXT, local_time TEXT,
  weekdays TEXT, at_utc INTEGER NULL, valid_from INTEGER, valid_until INTEGER NULL,
  status TEXT, authorization TEXT, delivery TEXT, goal_ref TEXT, commitment_ref TEXT,
  request_key TEXT, resolution TEXT, created_at INTEGER, updated_at INTEGER)
  UNIQUE (scope, request_key) WHERE request_key <> ''
agenda_occurrences(
  occurrence_id TEXT PK, scope TEXT, item_id TEXT, slot_key TEXT,
  definition_revision INTEGER, scheduled_at INTEGER, slot_end_at INTEGER NULL,
  status TEXT, reason_code TEXT, revision INTEGER, attempts INTEGER,
  last_error TEXT, causation_event_id TEXT, created_at INTEGER, updated_at INTEGER)
  UNIQUE (scope, item_id, slot_key)          -- revision 不进唯一键
  INDEX (status, scheduled_at, scope, occurrence_id)
heartbeat_cursor(
  scope TEXT, consumer TEXT, settled_until INTEGER, page_anchor TEXT,
  event_seq INTEGER, cycles INTEGER, paused_at INTEGER, updated_at INTEGER)
  PK (scope, consumer) ; INDEX (consumer, updated_at)
```

- `agenda_items.category ∈ {plan, activity, routine}`；`authorization ∈ {plan, reminder, tool, proactive-contact}`；`delivery ∈ {none, reminder-owned}`（**永不** `sent`）。
- `agenda_items.goal_ref/commitment_ref` 只存 `"<id>@<revision>"` 引用，不复制正文，不建第二套权威。
- `agenda_items.request_key` 由宿主按规范化请求内容派生（同一请求跨会话重试命中同一行）；显式传入也必须被调度器规范化。
- `agenda_items.resolution` 存原始本地意图与解析结果：`{localIntent:{date,time,zone}, rule, resolution:'exact|gap|fold', resolvedAt, note}`。
- `agenda_occurrences.status ∈ {scheduled, due, dispatched, skipped, cancelled, expired}`。可达转移：`scheduled→due|skipped|cancelled|expired`、`due→dispatched|skipped|expired`、`dispatched|skipped|cancelled|expired` 为终态（不复活；要重排必须新建 `itemId` 或新 `slotKey`）。
- `heartbeat_cursor` 按 `(scope, consumer)` 分离；`consumer` 首版只有 `'agenda'`。三个水位分开：`settled_until`（时间结算水位，诊断/上限，**不等于**到期进度）、`page_anchor`（JSON：`{scheduledAt, occurrenceId, rejections:{occurrenceId:count}, lastError}` 到期分页/隔离位置）、`event_seq`（已应用事件的最大 `seq`）。禁止合并成一个 `lastTick`。
- 暂停状态持久化在 `runtime_meta`：`heartbeat_paused`（`'0'|'1'`）与 `heartbeat_pause_reason`，重启后语义一致。

### 12.3 事件与消费者（冻结名称）

消费者新增 `agenda`，权威消费者（见 §3 权威否决规则）覆盖 `agenda/` 前缀：

| kind | payload 关键字段 | reducer 行为（确定性，拒绝码） |
| --- | --- | --- |
| `agenda/created` | `item`（规范化定义）、`requestKey` | 插入 `agenda_items`；同 `(scope,requestKey)` 已存在 → `duplicate-request`（回滚） |
| `agenda/updated` | `itemId`、`expectedRevision`、`patch`、`nextRevision` | 校验 revision → `stale-revision`；`cancelled/expired` → `terminal-item`；应用 patch 并 ≤ `nextRevision` |
| `agenda/cancelled` | `itemId`、`expectedRevision`、`reason`、`now` | item → `cancelled`；同事务把该 item 的 `scheduled` 且 `scheduled_at > now` 的实例 → `cancelled`（reason `definition-cancelled`） |
| `agenda/occurrence-generated` | `itemId`、`slotKey`、`definitionRevision`、`scheduledAt`、`slotEndAt`、`resolution` | 插入实例 `scheduled`；已存在同 slot：同 `scheduled_at` 且非终态 → `duplicate-occurrence`；终态 → `slot-terminal`；不同时间 → `reschedule-required` |
| `agenda/occurrence-rescheduled` | `occurrenceId`、`itemId`、`slotKey`、`expectedRevision`、`scheduledAt`、`slotEndAt`、`definitionRevision`、`reason` | 仅 `scheduled` 可改 → 否则 `invalid-transition`；revision 不符 → `stale-revision` |
| `agenda/occurrence-cancelled` | `occurrenceId`、`expectedRevision`、`reason` | 仅 `scheduled` → `cancelled` |
| `agenda/occurrence-due` | `occurrenceId`、`expectedRevision`、`scheduledAt` | 仅 `scheduled` → `due` |
| `agenda/occurrence-skipped` | `occurrenceId`、`expectedRevision`、`reasonCode` | `scheduled|due` → `skipped` |
| `agenda/occurrence-expired` | `occurrenceId`、`expectedRevision`、`reasonCode` | `scheduled|due` → `expired` |
| `agenda/occurrence-dispatched` | `occurrenceId`、`expectedRevision`、`consumer` | `scheduled|due` → `dispatched`；**本轮永远不产生**（无活动消费者，见 §12.5.4） |

- 所有正式写入（定义、实例、状态）只经事件路径；状态、快照版本、收据同事务提交。权威 reducer 否决时事件整笔回滚，不留旁路投影。
- reducer 只返回 ID、版本、状态、计数与理由码，不收私人正文进入收据。`applyAgendaEvent({db,event,slice,now})` 返回 `{slice, result, extra}`，`extra` 为同一事务内的关系表写入（`agenda_items` / `agenda_occurrences`）。
- `agenda` 事件**不**产生 `state/impulse` 或 `state/recovered`，避免与读取时结算造成二次衰减（§12.5.5）。
- 快照重放（§9）必须覆盖新表：`lib/snapshot.mjs` 的 `PROJECTION_TABLES` 增加 `agenda_items`、`agenda_occurrences`（按 `scope` 取行、按主键排序）；`verifyRecovery` 的投影与关系表比对同时覆盖两者。

### 12.4 H1 API（`index.mjs` 对外，`lib/agenda.mjs` 承载逻辑）

```js
// lib/agenda-time.mjs（纯函数，无 IO，可注入时钟）
export function isValidTimeZone(tz);                       // 非法 IANA → false，不回退默认
export function localParts(at, timeZone);                  // {year,month,day,hour,minute,isoWeekday(1..7)}
export function localDateString(at, timeZone);             // 'YYYY-MM-DD'
export function resolveLocalInstant({ date, time, timeZone }); // {ok, at, resolution:'exact'|'gap'|'fold', intent}
export function addLocalDays(dateString, days);            // 纯日历运算

// lib/agenda.mjs
export const AGENDA_STATUS, OCCURRENCE_STATUS, RULE_KINDS, AGENDA_AUTHORIZATION, SLOT_LIMITS;
export function normalizeDefinition(input, { now });       // → 规范化定义；非法时区/时间/星期 → ValidationError
export function slotKeyFor(definition, slot);              // 稳定槽标识
export function planWindow({ item, from, to, limit, now }); // 纯规划 → [{slotKey, scheduledAt, slotEndAt, definitionRevision, resolution, reason?}]
export function applyAgendaEvent({ db, event, slice, now }); // 权威 reducer
export function getAgendaItem(db, scopeKey, itemId);
export function listAgendaItems(db, { scopeKey, status, limit });
export function listAgendaOccurrences(db, { scopeKey, itemId, from, to, statuses, limit });
export function activeAgendaItems(db, { scopeKey, at, limit });
export function dueAgendaOccurrences(db, { scopeKey, at, limit });
export function agendaCounts(db, scopeKey);
```

运行时方法（`mountRuntime` 返回对象新增）：

```js
listSchedule({ sessionId|bound, from, to, status, limit });   // 读；active 模式下按需生成当前窗口（有界）
todaySchedule({ sessionId|bound, date });                     // 读；按定义时区算本地日期，不按宿主 UTC 截断
createSchedule({ sessionId|bound, requestKey?, title, rule, timeZone, date?, time?, weekdays?,
                 validFrom?, validUntil?, category?, authorization?, goalRef?, commitmentRef? });
updateSchedule({ sessionId|bound, itemId, expectedRevision, patch, previewToken? });
cancelSchedule({ sessionId|bound, itemId, expectedRevision, reason? });
```

规则：

1. 首版只支持 `once | daily | weekly`。查询跨度、定义数量、生成窗口、每轮生成数都有界（`SLOT_LIMITS` + `config.agenda`）。
2. `create` 的幂等是**定义级**：同 `requestKey` 返回原 `itemId`（`idempotent:true`），不是只把实例生成做成幂等。`update/cancel` 必须带 `expectedRevision`，不符 → `stale-revision`；终态 item/instance 不被旧请求或重复生成复活。
3. 单次默认锁定 UTC 瞬时值；重复规则跟随定义时区。改时区必须先给未来变更预览（返回 `{ok:false, code:'preview-required', preview, previewToken}`），再用该 `previewToken` 提交；token 不匹配 → `preview-stale`。改时刻/规则/有效期只重算**未执行的未来 `scheduled` 实例**：同 `slotKey` 原地 `occurrence-rescheduled`（revision +1），不再适用的 `slotKey` 显式 `occurrence-cancelled`（reason `definition-updated`）；历史终态保留，不留幽灵到期项，不自动复活取消槽。取消整条定义后再安排必须新建 `itemId`。
4. DST：gap 跳过且记录 `resolution:'gap'`（不造实例）；fold 取**较早**的那个 UTC 瞬时值并记录 `resolution:'fold'`。非法 IANA 时区明确拒绝（`invalid-timezone`），不静默回退。
5. `today` 按日程时区计算跨午夜边界。返回体含版本、UTC 与本地时间、状态、授权与投递能力：`delivery:'reminder-owned'` 时**必须**同时给 `reminderDelivery:'not-wired'`（既有 reminders runner 独占发送；H1 不接管），不能回答“已设置提醒”。
6. 计划 ≠ 许可：“明天去文庙”是 `authorization:'plan'`；“明早提醒我”可存 `authorization:'reminder'` 与来源，但本轮**不新增第二个提醒执行者**，也不把既有提醒自动导入成可发送日程。
7. 首版不从自然语言自动抽取日程：只由明确工具调用/结构化安排创建。
8. `agenda.enabled=false` → 写接口 `{ok:false, code:'agenda-disabled'}`，读接口 `{ok:true, enabled:false, state:'disabled', items:[], occurrences:[]}`；`mode='shadow'` → 写走 `shadow_proposals`，不写正式 agenda 表；`mode='off'` 连库都不开（P1 既有语义）。
9. 只读写可信 scope；不暴露其他主体的内容；工具参数里的 `userId/personaId/worldId` 一律被忽略，身份只来自 `identity.resolve(sessionId)`。

### 12.5 H2 API（`lib/heartbeat.mjs`，零模型规则心跳）

```js
export function createHeartbeat({ db, config, now, owner, generation, dispatch, agenda, onError });
// 返回 → { cycle({ reason }), status(), pause(reason), resume(), start(), stop(), dispose(), paused }
```

1. **唤醒与业务分离**：`setInterval` 只负责唤醒（`pollIntervalMs=60000` + `jitterMs=2500`），业务 `cycle()` 独立可注入时钟调用，单 runtime 单飞。原 `heartbeatTimer`（续租）保持原职责，不得被当成业务进度。诊断必须能区分“续租正常”和“业务 cycle 成功”。
2. **每轮门禁**：`disposed/stopped/mode!=='active'/heartbeat.enabled!==true/paused/!writable` 任一 → 直接返回 `{ok:false,code}`，**零写入**。每笔提交在同一事务内复核 `stopped`、`owner+generation` 与租约未过期（`db.assertLeaseHeld`），失租立即停止该轮提交（`lease-lost|stale-generation|lease-expired`），不静默吞错。
3. **一轮事务**：① 按持久公平游标（`heartbeat_cursor.updated_at ASC`，未见过的 scope 排最前）选有界批次（`maxScopesPerCycle`）；② 同一事务内生成有界新实例（`maxNewOccurrencesPerCycle`）；③ 按 `(scheduled_at, occurrence_id)` 取到期批次（`maxDueItemsPerCycle`）：超过 `maxCatchupHorizonHours` 的 → `occurrence-skipped(reason='outside-catchup-window')`，否则 → `occurrence-due`；④ 更新实例、收据、游标（`settled_until/page_anchor/event_seq/cycles`）原子提交；⑤ 提交后只通知进程内观察者，无外部动作。
4. **dispatchEvent 可能返回消费者失败而不抛出**：调用方必须检查必要消费者结果与持久收据；任一必要消费者失败 → 该 scope 的水位不推进、不丢弃剩余项。`dispatched` 仅表示下游意图已持久接受：`config.heartbeat.activityConsumer` 默认为空 → **禁止**产生 `occurrence-dispatched`，也禁止记 `completed`、累加技能/阅读/游玩时长。
5. **水位**：`settled_until` 只在“本批次全部到期项处理完”时推进到 `now`；否则推进到剩余最早 `scheduled_at`，且永不倒退（时钟回拨不回退）。到期处理**始终按未终结状态 + 索引重新查询**，不用 `scheduled_at` 高水位替代，因此运行中新增/改早的实例不会漏。`event_seq` 取本轮已应用事件的最大 `seq`，单调递增。
6. **公平/隔离**：一个 scope 或一个永久失败项不得饿死其余 scope/项；`page_anchor.rejections[occurrenceId]` 计数达到 `maxAttempts` 后隔离（发 `occurrence-expired(reason='repeated-rejection')`，保留审计），计数表有界（≤ 32 项）。暂时失败（非确定性错误）有界退避并让整轮回滚（零半提交），错误码进诊断。
7. **停机/时钟**：离线 8 小时不补造活动、不集中补发；前跳按区间有界结算；回拨不倒退已提交水位、不重生历史槽；重启重扫无漏项、无重复收据（依赖 `(consumer,eventId)` 收据）。启动不重新发消息/模型请求。旧承诺不受 24 小时截断。
8. **状态衰减**：复用 P1 纯函数，按真实时间区间推进；H2 不写 `state/*` 事件，不做 tick 累加（避免二次衰减）。
9. **暂停语义**：`pauseHeartbeat` 持久化 `runtime_meta.heartbeat_paused='1'` 并记录原因，只停业务心跳：不 `stop()`、不撤租约、不停 bridge/contact/聊天；`resumeHeartbeat` 显式恢复。`runtime.stop/dispose` 仍然停止全部新写入并清 timer/订阅，旧 cycle 无法提交。
10. **诊断分区**（`status()` 增加 `agenda`、`heartbeat`）：

```js
heartbeat: { enabled, paused, pausedReason, registered:true, owner, generation,
  lease:{state, expiresAt, valid, renewFailures}, lastAttemptAt, lastSuccessAt,
  lastCycle:{at, scopes, generated, due, skipped, rejected, remaining, ms},
  backlog:{due, oldestDueAt, backlogAgeMs}, cursor:{scopes, settledUntilMin, eventSeqMax, rejections},
  failures:{count, lastCode, lastAt}, recovery:'idle'|'resumed'|'retry', pendingLoad:false }
agenda: { enabled, items, occurrences:{scheduled,due,dispatched,skipped,cancelled,expired}, nextOccurrenceAt }
```

默认不展示日程正文或私人记忆；能力未注册/未加载时给 `pendingLoad:true` / `disabled`，不伪报 active。

### 12.6 工具（`companion-foundation` 注册，恰好一次）

`companion_schedule_today`、`companion_schedule_list`、`companion_schedule_create`、`companion_schedule_update`、`companion_schedule_cancel`、`companion_heartbeat_status`、`companion_heartbeat_pause`、`companion_heartbeat_resume`。写工具 `kind='write'`。声明与实现一致：`create` 必须暴露 `rule/timeZone/date/time/weekdays` 且与 `normalizeDefinition` 同名校验；`update` 必须暴露 `expectedRevision`（与 `previewToken`）；`cancel` 必须暴露 `expectedRevision`。拒绝码原样透传（`agenda-disabled`、`stale-revision`、`preview-required`、`preview-stale`、`invalid-timezone`、`unbound`）。工具不得接受模型自证的 `userId`。

### 12.7 迁移、兼容与回退

- v2 → v3：`openRuntimeDb` 在事务里建新表 + 写迁移记录；中途崩溃 → 事务回滚，无半迁移；重复打开幂等。
- 兼容方向：新程序可读 v2 并升级；**旧程序不能打开 v3**（`version > SCHEMA_VERSION` 抛 `schema-newer`）。回退到旧版本必须用匹配版本的一致性备份恢复（`VACUUM INTO` 或停写后复制含 `-wal`/`-shm` 的整组文件），不能用旧程序直接打开新库冒充回退。
- 生产迁移前必须验证 SQLite 一致性备份/恢复（`VACUUM INTO` 优先）；隔离恢复后跑 `PRAGMA integrity_check` 并与源库投影/计数比对。
- 本轮不自动重启共享宿主、不启用生产 H1/H2；交付物是代码、证据与待加载/待启用材料。

### 12.8 验收映射（HH01–HH17）

| 编号 | 主责 | 测试文件（本轮新增） |
| --- | --- | --- |
| HH01 | 开关/模式/暂停 | `test/hh01-switches.test.mjs` |
| HH02 | 幂等与稳定槽 | `test/agenda-definition.test.mjs` |
| HH03 | revision/取消/重投 | `test/agenda-revision.test.mjs` |
| HH04 | 作用域隔离与伪造参数 | `test/agenda-scope.test.mjs` |
| HH05 | 授权分离/外发 0 | `test/agenda-authorization.test.mjs` |
| HH06 | 时区/DST/跨午夜 | `test/agenda-time.test.mjs` |
| HH07 | 有界批次/多 scope/插队 | `test/heartbeat-batch.test.mjs` |
| HH08 | 24h 空转采样 | `test/heartbeat-idle.test.mjs` |
| HH09 | 停机/补算窗口 | `test/heartbeat-downtime.test.mjs` |
| HH10 | 时钟跳变/取消交错 | `test/heartbeat-clock.test.mjs` |
| HH11 | 故障点原子性 | `test/heartbeat-faults.test.mjs`、`test/agenda-faults.test.mjs` |
| HH12 | 双真实子进程争租 | `test/heartbeat-crossprocess.test.mjs` |
| HH13 | 重挂载/热重载/dispose | `test/heartbeat-reload.test.mjs`、`test/foundation-mount-h1h2.test.mjs` |
| HH14 | 迁移/新库/中断/未来 schema/备份恢复 | `test/migration-v3.test.mjs`、`test/backup-restore.test.mjs` |
| HH15 | 重放与投影比对 | `test/agenda-recovery.test.mjs` |
| HH16 | 公开工具真实装配 | `test/foundation-tools-h1h2.test.mjs` |
| HH17 | P1 回归 | 既有全套 + `test/hh17-regression.test.mjs` |

每项证据含命令、退出码、原始输出、代码哈希与未覆盖范围（见 `logs/h1-h2-agenda-heartbeat/`）。

### 12.9 修订记录 A1（2026-10-30，独立审阅 Pass 1 后冻结；覆盖上文冲突处）

Pass 1 判 blocking 的 B1–B5 全部按本节修订。**本节优先于 §12.2–§12.5 的冲突文字。**（§12.10 又修订了其中若干条款；同一处被两者修订时以 §12.10 为准。）

**A1-B1 `due` 的终结与取消（覆盖 §12.2 转移表、§12.3 `agenda/cancelled`）**
- 转移表补两条：`due → cancelled`（定义被取消）、`due → expired`（保留期到期）。终态集合不变。
- `agenda/cancelled` 除取消 `scheduled 且 scheduled_at > now` 的实例外，**同时**取消该 item 所有 `due` 实例（reason `definition-cancelled`）。取消计划后不得留下仍占 backlog 的 due 幽灵。
- 心跳每轮**有界**清理：`due` 且 `scheduled_at < now - heartbeat.dueRetentionHours`（默认 24，范围 1–720）的实例发 `agenda/occurrence-expired`（reason `due-retention-elapsed`），每轮上限 `maxDueItemsPerCycle`。`due` 因此有界，不会无限增长。
- 冻结 `agenda_items.status ∈ {active, cancelled, expired}`；只有 `active` 可写。冻结投递映射：`delivery='none'` 恒成立（H1 不创建外部提醒），`authorization='reminder'` 时返回 `reminderDelivery:'not-wired'`，其余 `'n/a'`；**不得**出现 `delivery='sent'` 或 `reminderDelivery='wired'`。

**A1-B2 事件 `occurredAt` 必须确定性（覆盖 §12.3 全部 agenda 事件）**
- 实例级事件（`occurrence-generated|rescheduled|cancelled|due|skipped|expired|dispatched`）的 `occurredAt` **等于该实例的 `scheduledAt`**；定义级事件（`created|updated|cancelled`）的 `occurredAt` **等于 payload 里的 `createdAt|updatedAt`（定义/修订瞬时值）**。
- **禁止**用 cycle 时钟/墙钟当 `occurredAt`。理由（B2）：`eventId` 内容寻址含 `occurredAt`；非确定性消费者失败会提交事件行但不写收据，若重试换用新的 `occurredAt` 就会生成第二个事件，重放时第二条被 reducer 拒绝，`verifyRecovery` 永久 mismatch。确定性 `occurredAt` 使重试命中同一 `eventId`，重试补写收据，日志只有一条。
- 用户主动发起的重投（update/cancel）允许使用新的修订瞬时值：状态已变，第二次会被确定性拒绝并整笔回滚，不污染日志。

**A1-B3 生成幂等（覆盖 §12.3 `occurrence-generated` 行、§12.5.3②）**
- 生成前**必须**按 `(scope, item_id, slot_key)` 先 SELECT 跳过已存在的槽（任何状态）；生成器不得依赖 reducer 去重。
- reducer：同 `slotKey` 且同 `scheduledAt` 且当前非终态 ⇒ **幂等成功**（`applied:true, result:{duplicate:true}`），**不再**抛 `duplicate-occurrence`（原文字作废）；仅以下仍是确定性拒绝：终态槽 → `slot-terminal`，同槽不同时间 → `reschedule-required`，item 不存在 → `item-not-found`，item 非 active → `terminal-item`。
- 因此正常心跳不会因为“重算窗口”把整轮事务回滚掉（B3）。

**A1-B4 公平与失败退避（覆盖 §12.5.3/§12.5.6 的“整轮回滚”表述）**
- 事务粒度是**每个 scope 一个事务**，不是整轮一个事务：某 scope 暂时失败只回滚该 scope，其他 scope 照常推进。
- 失败簿记在**独立的极小事务**里完成：`heartbeat_cursor.updated_at = now`（移到队尾）、`page_anchor.nextAttemptAt = now + backoff`（指数，上限 `maxRetryBackoffMs`，默认 30 分钟）、`page_anchor.failures += 1`、诊断记 `lastCode`。`nextAttemptAt > now` 的 scope 本轮跳过。
- 这样“失败 scope 永远最旧、饿死其他 scope”的矛盾被消除；`maxScopesPerCycle` 仍按 `COALESCE(updated_at,0) ASC` 轮转。

**A1-B5 `previewToken` 冻结（覆盖 §12.4 规则 3、§12.6）**
- `previewToken = sha256(canonicalJson({scopeKey, itemId, expectedRevision, normalizedDefinition:{title,category,rule,timeZone,date,time,weekdays,validFrom,validUntil,authorization,goalRef,commitmentRef}}))[0:32]`，**无状态、无过期、不落库**。
- 只有 `timeZone` 变更才强制 `preview-required`；提交时 token 与按当前行重算不一致 → `preview-stale`。token **不能**替代 `expectedRevision`，两者都要校验。
- `expectedRevision` 缺失 → `revision-required`（不是接受 `String(itemId)` 之类的伪 token）。

**A1 其他冻结项（非阻断，但必须一致）**
- 暂停的权威存储只有 `runtime_meta.heartbeat_paused` / `heartbeat_pause_reason`；`heartbeat_cursor.paused_at` 仅是时间戳镜像，**不参与任何判定**。
- `settled_until` 单调不减；只有“该 scope 无 `scheduled` 且 `scheduled_at <= now`”时推进到 `now`，否则停在剩余最早 `scheduled_at` 与旧值的较大者（时钟回拨不回退）。
- `event_seq` 为诊断/恢复用的已应用事件最大 `seq`，不驱动到期扫描。
- `page_anchor.rejections` 上限 32 项，超出按最旧淘汰；条目随实例终结而删除。
- 新增拒绝码冻结：`item-not-found`、`revision-required`、`request-key-conflict`、`unbound`、`agenda-disabled`、`heartbeat-disabled`、`heartbeat-paused`、`runtime-inactive`、`lease-expired`、`lease-lost`、`single-flight`。
- 同一 `requestKey` 但规范化定义不同 → `request-key-conflict`（返回现有 `itemId`），**不得**静默返回旧定义。
- `emptyAgendaStatus/emptyHeartbeatStatus` 在开关为 true 但模块未注册时必须报 `state:'pending-load'` + `pendingLoad:true`，不得报 `idle`。
- `assertLeaseHeld` 必须与事件提交在**同一事务**内（`dispatchEvent` 增加事务内 `guard` 钩子），不得只在事务外预检。
- `openRuntimeDb` 对 `version > SCHEMA_VERSION` 必须在写入任何 pragma/journal 变更**之前**拒绝。
- `migrate()` 在当前版本提前返回时仍校验三张 v3 表存在，缺失则补建（不新增迁移行）。

### 12.10 修订记录 A2（2026-10-30，独立审阅 Pass 2 阻断项修复后冻结）

Pass 2 判 blocking 的 2 项按本节修复并加回归测试；同时冻结 4 项非阻断改动与 4 项"已知、本轮不改"的口径。

**A2-1（BLOCK-1，HH02）取消后再安排的幂等释放**
- 定义级幂等查找匹配**同一请求键族**：`request_key = base OR request_key LIKE <escaped base> || '#%' ESCAPE '\'`，只取 `status='active'`，且必须 `sameAgendaDefinition` 成立才返回。`base` 由内容派生（含 `_` 等字符，必须转义 LIKE 通配符，否则整族匹配失效）。
- 语义：取消后首次再安排得到**新 itemId**（不复活终态定义），该新定义持有 base 键的 `#<hex>` 后缀；此后**任何相同请求重试都命中它并返回 `idempotent:true`**，不再无限造定义。
- 显式传入 `requestKey` 且内容不同而该键已被 active 定义占用 ⇒ `request-key-conflict`，不静默返回旧定义、也不另造一条。

**A2-2（BLOCK-2，HH11/HH15）日程事件的"必需消费者"回滚**
- 日程事件一律以 `dispatchEvent(db, event, { ..., requireConsumers: true })` 提交：任一消费者失败（含非确定性失败）⇒ 追加、投影、收据**整笔回滚**，日志不留无收据事件。
- 理由：单权威聚合上"有事件行、无收据"会被后续重放应用而线上从未发生；调用方重试会追加近似重复事件，重放永久 mismatch。
- 因此定义级事件（`agenda/created|updated|cancelled`）保留真实墙钟 `occurredAt`（诚实排序），恢复性由本回滚保证；实例级事件继续用确定性 `occurredAt`（A1-B2），两者叠加。
- P1 既有路径（goal/belief/working-memory/bridge）**不启用**该选项，行为不变。
- **Pass 3 补充（结构性收口）**：`requireConsumers` 只覆盖经 `dispatchEventChecked` 的写入，因此通用 `recordEvent` 入口现在**直接拒绝 `agenda/*`**（返回 `agenda-direct-event-refused`）：日程状态只有一个写路径，不存在"另一条能伪造瞬时、绕过回滚"的入口。

> 编号说明：本节非阻断条目按**内容命名**，不沿用 `review-pass2-implementation.md` 的 N 编号（两份文档编号不一致，交叉引用以内容为准）。

**A2 非阻断修复（本轮一并做掉）**
- 「非法时区拒绝码」：`invalid-timezone` 现在是**拒绝码本身**（API 层把 `invalid-input` 且消息以 `invalid-timezone` 前缀的 ValidationError 重新打码），不再只是消息前缀。
- 「dispose 后拒绝码」：`dispose()` 之后日程写返回 `runtime-disposed`（不再落成 `runtime-off`）。
- 「物化计数」：只在真正插入时累加，幂等重复不再算作"生成"。
- 「pendingLoad 字段」：`heartbeat.status()` 恒有 `pendingLoad:false`（能力已挂载时），关闭时 `state:'disabled'`。

**A2 已知口径（记录，不在本轮修）**
- 「工具层 revision-required」：`expectedRevision` 在工具声明里是 required，宿主 `defineTool` 会在 handler 之前抛 `INVALID_ARGS`，因此工具层拿不到 `revision-required`；runtime 入口仍保留该码供内部/嵌入调用。
- 「读工具会物化」：声明为 `read` 的 `companion_schedule_today/list` 在 `mode='active'` 且开关打开时**会做有界物化写入**（合同允许的"读时按需生成"）；如需严格只读上下文，应关闭 `agenda.enabled` 或使用 shadow。
- 「today 的窗口口径」：`today` 是"从现在起往后的今天"；当天新建且时刻已过的定义不会凭空出现当天槽（历史槽只在其原本到期的时刻被物化）。
- 「P1 写路径租约栅栏」：P1 既有写路径（goal/belief/working-memory）**仍无租约有效期栅栏**（`assertWritable` 只看 generation/stop）；这是 P1 既有行为，本轮未改也未声称修复；日程/心跳路径已用 `assertLeaseHeld`。
- 「改期与已 due 实例」：改期时已 `due` 的实例保持原样（不随定义改期），这是有意的历史保留；`definitionRevision` 会与新定义不同，诊断可见。
- 「生产迁移不受开关控制」：生产 `enabled:true, mode:'active'`，因此**下次宿主启动就会迁移到 v3**（迁移不受 `agenda.enabled` 控制）。回退必须依赖匹配版本的 v2 一致性备份（`VACUUM INTO` 或停写后整组复制），单文件复制在活写者下不保证一致。

## 13. P2.5 增量合同（v4 后续 / 2026-11-01 冻结，Asia/Shanghai）

本节是 §1–§12（P1 认知连续性 / H1 日程与 H2 心跳）之后的**增量**合同，覆盖 P2.5 的租约栅栏、活动派发、活动终态 → P1、经历闭环、纠正语义与外发闭环。

**口径（全节适用）**：

- **【已实施】**＝有代码、有测试，可按合同验收；
- **【未实现】**＝只是合同，代码里没有，任何人不得当成已有；
- **【有意不做】**＝明确决定不做，附理由，改动需先改本节。

> ⚠️ **本文档的维护记录**：2026-11-02 01:39 本文件因一次错误的 PowerShell 重写（`Get-Content -Raw` 以 ANSI 解码 + `Set-Content` 以 UTF-8 回写）被双重编码损坏，**§1–§12 已从 `logs/h1-h2-production-acceptance/backup-2026-10-30T03-53-26-118Z/` 的 2026-10-30 备份恢复**，§13 由合同维护者按 2026-11-02 01:40 之前的版本重写。因此 §13.1–§13.3、§13.5 的**措辞**可能与损坏前不完全一致（内容按代码事实重述），**§13.4、§13.6 之后的各节为原文级重建**。发现与代码不符时以代码为准，并在此处留更正记录。

### 13.1 租约合同（P2.5-4A）【已实施】

- **唯一原语**：`db.assertLeaseValid({owner, generation, at, requireRow})`。所有"能不能写"的判断都收敛到它，不再各自实现。
  - `assertWritable(generation)` = `requireRow: false`：**没有租约行也放行**（P1 既有语义，保持兼容）。
  - `assertLeaseHeld(generation, owner)` = `requireRow: true`：**没有租约行就拒绝**（新写路径应当是这个形状）。
- **错误码二分**：`lease-expired`（行在，但已过期）与 `lease-lost`（行不在 / owner 不符 / 调用方缺方法）。两者都**不得**被吞掉降级为"放行"。
- **心跳续租**：`heartbeatLease` 的 `UPDATE` 带 `AND expires_at > ?`——续租本身也要过租约校验，**过期后不能靠续租复活**。
- **配置形状**：`db.assertLeaseHeld` 缺失时，新代码应当**抛 `lease-lost`**，而不是 `if (typeof … === 'function')` 静默跳过（§13.4 第 3 条记录了仍未改完的那一处）。
- **诊断**：`runtimeStatus()` 暴露租约持有者/到期时间；`runtime_lease` 只有一行且必须与进程一致。

### 13.2 活动派发合同（P2.5-1 / Slice A）【已实施】

- **注入式钩子**：宿主把 `activityDispatch = { dueSlots(), claim() }` 注入 heartbeat；heartbeat **不自己查 p2 表**，也不自己决定"该不该派发"。
- **两个开关，语义不同**：
  - `p2.activities.enabled`：允不允许**执行**活动（模型/读写）；
  - `p2.activities.dispatchEnabled`：允不允许**H2 心跳认领并派发**到期 slot。判定用**严格等真**（`=== true`），**默认 `false`**；键缺失 = 关。
- **诊断三态**（`heartbeatStatus().activityDispatch`）：
  - `'wired'`：钩子真的注入且 `maxDispatchPerCycle > 0`；
  - `'disabled-by-config'`：宿主刻意没给钩子（灰度关 / activities 关 / tick 上限 0）——**这是正常关闭态**；
  - `'unavailable'`：既没钩子也没给原因 = 这个构建真的没有消费者——**这时才是异常**。
- **`activityDispatchLimit`** 只在 `wired` 时给真实上限，其余为 `0`。
- **事件复用，不另开总线**：派发复用既有 `autonomy/plan-slot` 与 `autonomy/receipt`；`activityConsumer` **保持为空**（打开它会改变 `occurrence-dispatched` 的 `payload.consumer` 语义，见 §13.8.2 的 3A-5）。
- **认领语义**：claim 是 `planned → started` 的 CAS（`started → started` 不是合法转移）；认领失败按"已被别人认领"处理，不重试同一 slot。

### 13.3 活动终态 → P1 最小链路【已实施】

- **唯一链路（冻结）**：终态提交 → `options.onFinished`（`activities.mjs` 的 finish 事务内钩子）→ `memory/ingest-request`（namespace `p2/activity`、`transformVersion` `p2-activity-v1`、`rootEvidenceIds=[finish receiptId]`）→ bridge consumer → `memory_outbox` → 周期性 drain → 记忆引擎。
- **终态标记**：终态提交后写 `p2_p1_<activityId>`，证明"这条活动的 P1 事实已经发过"。
- **补偿扫描**：扫"`status='done'` 但缺 `p2_p1_<id>` 标记"的活动，用**同一个** hook 重放。重放不产生第二条事件（`eventIdFor` 内容寻址），也不产生第二个 outbox 行（`outboxIdFor`）。
- **一次性截断点 `p2_p1_scheme_since`**：首次读取时写入并永久复用。**早于它的 `done` 活动不回填**（它们已由旧 port 写过，回填才是重复写）；meta 读不出来时**不猜**，按"读取失败 = 不补"处理。
- **`paused` 不发事实**：普通时间窗暂停什么都没发生（见 §13.9.1）。
- **语义边界**：整条链路是 **at-least-once**，不是 exactly-once（§13.6.5）。

### 13.4 仍未实现的缺口（**未实现**，任何人不得当成已有）

> 2026-11-01 Codex 审查后更新：原第 2 条（`drainOutbox` 未传 owner）、第 4 条（`assertRunGate` 无租约）、第 8 条（终态→P1 无补偿）**已关闭**，已从本表移除，证据见 §13.6.7。下表只保留仍未实现的（编号已重排）。

| # | 缺口 | 现状（代码事实） | 合同要求 | 依据 |
|---|---|---|---|---|
| 1 | `activities.step()` 无预算闸门 | `assertBudget` 里 `if (!budget \|\| typeof budget.check !== 'function') return;` 是**死分支**——`createP2` 没有把 `budget` 传给 `createActivities`（`activities.mjs:839-850`、`p2.mjs:97-109`）；且 `budget` 的公开面里根本没有 `check` 方法（`budget.mjs:205` 只导出 `reserve/markIssued/settle/status/canSpend/release/sweep`） | 活动每步执行必须过预算 reserve；要么给 budget 加 `check()`，要么让 `assertBudget` 改用 `canSpend`。**单独一个 commit**，它改变既有活动测试的预算行为 | 计划 §3 P2.5-1；`design/p2.5-baseline-and-contract.md` §3.1 C-Act |
| 2 | `planner.mjs` 条件式租约回退 | `withWriterFence`：`if (owner && generation) db.assertLeaseHeld(...); ` 否则 `db.assertWritable(generation \|\| undefined)`（`planner.mjs:1574-1576`） | owner 缺失即降级到 generation 级，属于隐性放宽；应改为强制双参数或显式报错 | §13.1 |
| 3 | `p2.mjs` 还剩一处"注入面缺方法就跳过" | `p2.mjs:420` `if (typeof db.assertLeaseHeld === 'function') …`，没有 else 分支；命中 `lease-expired` 时被归成同类码返回（`p2.mjs:421-424`）。**注意**：`activities.assertRunGate` 那条已在 4A 修好（见 §13.1 / §13.6.7），不要再按旧审计把它列为缺失 | 取消条件式跳过，缺方法时与 `assertLeaseGate` 一样抛 `lease-lost`，而不是运行在无闸门状态 | A1 §4.4 #13/#14 |
| 4 | **终态 gate 与历史实例对账未做（R4 的剩余部分）** | `effectKey`/`lc-effect`/`resolveEffect` **已实现**（§13.6.6），但：①同一 jobMaterial 的第二个 slot 仍可能产生第二次外呼（`effectReceiptIdFor` 只按 (effectKey, phase) 去重，`activities.mjs:200-201`）；②`prepared` 过期只在读取时判定，没有收敛扫描；③历史实例（同 job 的旧 slot/旧活动）未分类对账 | 终态 gate（`terminalReceiptId` / job 级 once-only）+ 历史对账分类（可审计），完成后 AC-02 的"唯一终态"才成立 | `logs/p2.5/r4-effect-intent/REPORT.md` §4.1-4.3；`design/p2.5-activity-lifecycle.md` §4 |
| 5 | ~~无 `slots_due` / `dispatch_lag_ms` 观测~~ → **观测已实施，见 §15**；仍缺的是**告警阈值**与**历史对账**，不是指标 | 2026-11-03 前：`p2Status()` 无 due/dispatched 聚合；`heartbeat.status()` 的 `activityDispatch` 是状态不是度量；`claim_age_ms` 无数据源。现况：三字段已落地（`lib/dispatch-observability.mjs` + `p2Status().activities.dispatch` + `heartbeatStatus().activityDispatchLastCycle` + `runtime.p2DispatchWatch()`）。**旧版本的一处不诚实已修**：`lib/observability.mjs` 的 `claim_age_ms` 原来是 `now - MAX(occurred_at)`，而 claim 的 `occurredAt` 是**计划开始时刻**，所以它测的根本不是 claim 年龄却标着 `measured` | 指标口径与真假值见 §15.1/§15.2；告警阈值（"lag 超过 N 分钟该报警"）**仍未定**，属运维决定，不是代码缺口 | 计划 §4C；`design/p2.5-baseline-and-contract.md` §4 第 1、2 行；§15 |
| 6 | 活动状态不可推导：`retry_wait` / `cancelled` | `ACTIVITY_STATUS` 五态（`running/paused/done/failed/abandoned`）里没有这两个；`paused` 不带下次重试时间，`withdrawn/abandoned/skipped` 都不唯一等于"用户取消" | 若 UI 需要这两态，只能在读取侧推导（生命周期 receipt 已足够），**不要**新增列 | `design/p2.5-activity-lifecycle.md` §2 |
| 7 | 生产历史残留未收敛 | A3 实测：3 个 slot 停在 `started`、所属 plan 已 `superseded`，无终态 | 显式 retire/收敛并留审计；新逻辑不得继承这批悬空状态 | `logs/p2.5/baseline.json` `orphanSlots` |
| 8 | **外发闭环的剩余缺口**（3A 已落地、3B 到"走既有闸门但开关关着"，§13.8/§13.11） | 提醒：`dryRun` 默认 `true`（`config/sections/content.ts:69`）⇒ **到点但不发**；`unknown` 三态已实现（`features/reminders/runner.ts` + `store.markUnknown()`）。分享：`p2.share.enabled=false` ⇒ 零候选；**候选过期无任何诊断**（静默丢弃）；`reminderDelivery` 仍是 `not-wired`（如实标注 runtime 自己不投递） | ①提醒：一次真机受控投递（`dryRun=false`，主人在场）+ `unknown` 不重发的真机确认；②分享：补过期/丢弃诊断后再谈开 `share.enabled`；③两者都必须复用 3A-1 的同一本账 | §13.8、§13.11；`logs/p2.5/outbound-3a/REPORT.md`、`logs/p2.5/share-3b/REPORT.md` |
| 9 | **经历链路在生产从未运行过**（运维事实，不是代码缺口） | 生产 `memory_outbox` 0 行、`domain_events` 无 `memory/ingest-request`、无 `p2_p1_*` 标记；目前只有测试证据（runtime **575/575 / 78 文件**，2026-11-02 01:40 当场复跑） | 启用前必须做一次真机观察（观测点见 `design/p2.5-operational-playbook.md` §2/§3）；**不得**用"测试全绿"替代真机证据；drain 是 at-least-once（§13.6.5） | 本节 §13.6.7、§13.9；`logs/p2.5/baseline.json` |

### 13.5 回滚语义

- **没有 git**：`dsh-companion/` 在 `D:/Bot` 里是未跟踪目录，没有 tag、没有提交历史。**回滚靠快照**，见 `design/p2.5-operational-playbook.md` §4 与 `logs/p2.5/rollback/<slice>/`。
- **零 migration**：本轮所有改动都没有改 schema（runtime `SCHEMA_VERSION = 4`、`schema.sql` 指纹不变；memory `SCHEMA_VERSION = 2` 不变）。**因此代码回滚不需要回滚数据库**。
- **数据库备份**：只能用 `VACUUM INTO` 做单文件一致快照；停不掉的活库不要直接拷文件。
- **回滚后必须删遗留 `-wal` / `-shm`**，否则旧进程会读到半新状态。
- **版本方向**：v4 程序**拒绝** v5 库（`schema-newer`）。如果将来真升到 v5，回滚必须连库一起还原。
- **配置回退**：`home/companion/runtime.config.json` 与 `home/channel-qq/contact.json`、`reminders.json` 都是 JSON，回退即改回原值；账本 `CONTACT_LEDGER_VERSION` 本轮未变（仍为 1）。

### 13.6 Codex 发布前审查的 P1 修复（2026-11-01）

本节记录 `design/p2.5-codex-prerelease-review.md`（Codex 对抗性审查，裁决 NO-GO）的 P1 条目在**代码层的落地情况**。审查正文不改；本节只写"改了什么、怎么改的、还缺什么"。口径沿用 §13：**【已实施】**有代码有测试，**【未实现】**只是合同。

范围说明：R1（QQ 生产入口未切换）与 R5（C0 新鲜度闸）属 QQ 插件侧，不在 runtime 合同内，状态见审查文档开头的「处置状态」表与 `design/p2.5-operational-playbook.md` §2；本节只覆盖 R2/R3/R4/R6。

#### 13.6.1 R2：claim 与续读（continuation）的状态冲突【已实施】

- **修复前**：`resumed` 的 continuation reducer 只接受 `planned` 的下一 slot。于是同一次续读的结果取决于调度顺序——H2 先认领（`planned → started`）再 pump 续读 → `invalid-transition`（旧活动停在 `paused`、新 slot 落到 `missed`）；pump 先跑则成功。
- **现在**：状态集合放宽为 `const continuationSlotStatuses = ['planned','started']`（`lib/activities.mjs:623-624`）。**只放宽状态集合**：plan 仍须 `committed`、slot 仍须是同 kind + 同 target 的 `activity` slot、瞬时仍须落在新窗口内（同一行的其余判据未改）。
- **可观测**：`checkpoint.continueSlotStatus` 记录命中的是 `planned` 还是 `started`（`activities.mjs:629-632`），让对账能区分"计划中的续读"与"已被心跳认领的续读"。
- **配套不变量**：认领过的 slot **不得**再补发 `planned → started`（`started → started` 不是合法转移，`planner.mjs:120-126`）。

#### 13.6.2 R3：经历身份统一——只走事件，旧 `memoryPort` 路径关闭【已实施】

- **注入 `options.onFinished` 即停用旧路径**：`lib/p2.mjs:56-60` 的 `p1Hook` 非空时，`compensateMemory` 直接转去补偿事件并返回 `skipped:'superseded-by-p1-hook'`（`p2.mjs:785-792`），legacy `memoryPort` 写记忆的分支不可达（`:793-795` 起）。`p2.mjs:121` 把 `onFinished: p1Hook` 交给 activities。
- **唯一链路（冻结）**：`finished` 提交 → `onFinished`（`activities.mjs:1850-1869`）→ `memory/ingest-request`（namespace `p2/activity`、transformVersion `p2-activity-v1`、`rootEvidenceIds=[finish receiptId]`）→ bridge consumer → `memory_outbox` → 13.6.3 的 drain → 记忆引擎。
- **终态标记**：终态提交后写 `p2_p1_<activityId>`（`p2.mjs:676`）。
- **补偿扫描**：扫"`status='done'` 但缺 `p2_p1_<id>` 标记"的活动，用**同一个** hook 重放（`p2.mjs:714` 起的 `compensateFinishedEvents`）。重放不产生第二条事件，因为 `eventIdFor` 是内容寻址（§13.3）；也不会产生第二个 outbox 行（`outboxIdFor`）。
- **一次性截断点 `p2_p1_scheme_since`**：首次读取时写入并永久复用（`p2.mjs:694-710`）。**早于它的 `done` 活动不回填**——它们已由旧 port 写过，回填才是 R3 说的重复写。meta 读不出来时**不猜**：catch 后返回当前时钟（`:705-709`），即"读取失败 = 不补"。
- **禁止**：同时启用两条路径。`onFinished` 一旦注入，legacy port 写记忆就是缺陷，不是"兼容"。

#### 13.6.3 R3 的前提：`memory_outbox` 此前没有任何周期性 drainer【已实施（新增能力）】

- **修复前的事实**：`memory_outbox` 有表、有 claim、有 `drainOnce`，但**没有任何周期性调用者**——只有显式 API 会推。事件入队之后可以一直躺着，"写进记忆层"这件事在生产等于没发生（生产实测 `memory_outbox` 0 行、`domain_events` 里 0 条 `memory/ingest-request`）。
- **现在**：有界 drain 挂到 **P2 pump tick**。
  - `lib/p2.mjs` 的 `drainMemoryOnce`（`p2.mjs:770-783`）在 `setInterval` 里与 planning/execution/starts 同一拍被调用（`p2.mjs:905-908`），并有三种返回语义：`ok:true, skipped:'no-drainer'`（宿主没注入）、`{ok:false, code:'runtime-disposed'}`、`{ok:false, code:'drain-failed'}`。它只负责调度与有界，真正干活的是注入的 `drainOutboxHook`（`p2.mjs:1109` 暴露为 `drainMemory`）。
  - 宿主实现是 `index.mjs` 的 `drainOutboxTick`（`index.mjs:1871-1882`）：无 `db` / 非 active / 无记忆引擎 → 跳过；`SELECT COUNT(*) FROM memory_outbox WHERE status='queued'` 为 0 → `skipped:'idle'`（**空闲 tick 不开写事务**）；否则 `drain({limit:5})`（每 tick 至多 5 条）。
  - 单飞由 bridge 既有的 `DRAIN_LOCKS` 保证（`p2.mjs:906-907` 注释），未新增锁。
- **前提（必须记住，别当成永远成立）**：这个 timer 只在 P2 真的启用时存在。`startTimer` 的第一道闸是
  `if (config.p2?.planning?.enabled !== true && config.p2?.activities?.enabled !== true) return;`（`p2.mjs:894-897`），其后还有 `getMode() !== 'active'` 与 `if (timer || disposed) return`。
  ⇒ **`p2.planning.enabled` 与 `p2.activities.enabled` 都为 false 时，timer 不启动，`memory_outbox` 不会被周期性 drain**，此时只有显式 API 一条路（`index.mjs:2022` 的 `drainOutboxNow`，或工具侧 `drainOutbox`）。
- 推论：**"经历会自己写进记忆"这句话只在 P2 至少一个开关打开时才成立**；关掉 P2 不会停止记忆引擎的正常聊天写入，但会让本链路的 outbox 停止排空。

#### 13.6.4 R6：生产可达写路径的租约检查【已实施】

- `bridge.enqueueIngest`（`lib/bridge.mjs:117-125`）：outbox 的 `INSERT` 是事件路径之外的写，现在在**同一事务内**、用**事务自己的瞬时值** `db.now()` 做 `assertLeaseValid({ owner, generation, at, requireRow: true })`；没有 `assertLeaseValid` 的老句柄才回退 `assertWritable`（`:124`）。
- `bridge.refreshClaim`（`bridge.mjs:400-411`）：同样处理（`:403`，`requireRow: true`）。
- 旧 `memoryPort` 写记忆前的检查随 13.6.2 的"注入 hook 即停用"一起消失（路径不可达）。
- 语义变化：`requireRow:true` = **没有租约行就拒绝**，不再是 §13.1 那种"没行就放行"。任何新写的生产可达写路径都应当是这个形状。

#### 13.6.5 语义边界：**at-least-once，不是 exactly-once**

- 事件层确定（同内容 → 同 `eventId`），入队幂等（同 `eventId` + namespace + transformVersion → 同 `outboxId`）。
- 但 **drain 是至少一次**：引擎已收到、而 `memory_outbox.status='sent'` 尚未提交时（典型：租约在 `await` 期间过期），下一轮 drain 会重放同一条。正确性依赖记忆侧按 `eventId` 去重（去重键含 namespace/eventId/transformVersion）。
- 因此 **不得**在任何文档、报告、诊断里写"恰好一次 / exactly-once"。被问到时正确回答是："至少一次 + 记忆侧按 `eventId` 去重"。

#### 13.6.6 R4：执行前持久意图【已实施（部分）】与仍未实现的部分

> **2026-11-01 22:50 更正（第二轮复审点名本节与 13.6.2 自相矛盾）**：本节旧版本写"全仓不存在 `effectKey`"，那是 22:00 前的事实；R4 修复落地后该句**已失效**。以下按当前代码重写。

**已实施（`logs/p2.5/r4-effect-intent/REPORT.md`）**

- 新原语：`jobMaterial`/`jobKeyFor`（`[scopeKey, startAtUtc, endAtUtc, kind]` → `p25job_<sha>`，**不含** planId/version/slotId/target，`activities.mjs:179-187`）、`effectKeyFor`（`sha256(["p25-effect-v1", jobKey, operation, ordinal])`，`:189`）、`effectReceiptIdFor`（`:200-201`，确定性 id = 表主键）。
- 写入通道：沿用既有 `autonomy/receipt`，`operation='review'` + `code='lc-effect'`（`EFFECT_CODE`，`activities.mjs:162`）；阶段集 `EFFECT_PHASES = ['prepared','confirmed','not_applied','unknown']`（`:164`）。
- **顺序保证**：`start()` 先 `effectBlock(prior)` 判定（有未收敛 effect 即拒绝，adapter 不跑）→ 写 `prepared` 意图 → 只有**本次真的新建成功**才授予执行权（主键冲突 → `effect-in-flight`，`:1648-1652`；`intent.inserted !== true` 同样拒绝，`:1686`）→ 之后才 `adapter.prepare(...)`（`:1656`）。**准备事务失败 ⇒ 外呼次数为 0**。
- 失败分类：`effect.afterPrepare === true ? 'unknown' : 'not_applied'`（`failStart`，`:1783`）——**adapter 返回之后的失败记 `unknown`（阻断）**，此前的失败记 `not_applied`（放行）。
- 收敛：`resolveEffect({scopeKey, effectKey, outcome, evidence})`（`:1498-1523`）只允许 `confirmed` / `not_applied`，key 必须是 64 位 hex，`confirmed → not_applied` 是 `effect-conflict`；追加式，不改历史记录。
- 账本视图：`effectRecords`（**已去掉旧的 `LIMIT 200`**，`:208-217` 注释直接引第二轮复审 §二.2）、`effectIndex`、`effectVerdict`。

**边界（**必须照抄，别扩大**）**

1. **"同一 attempt 同一 effect 至多一次外呼"** —— 不是"同一 job 至多一次"。人工 `not_applied` 之后重试是**第二个** attempt、**新的 `effectKey`**、允许第二次外呼。
2. **不是 exactly-once**。进程在 `prepare` 返回后、`unknown` 写入前死掉，账本停在 `prepared`；读取时按 deadline 判 `effect-in-flight`（未过期）或 `effect-unknown`（过期），两者都阻断，但**没有任何后台扫描把过期 `prepared` 改写成 `unknown`**（`r4-effect-intent/REPORT.md` §4.4）。
3. **`confirmed` 不阻断同一 jobMaterial 的另一个 slot** —— 终态 gate（`terminalReceiptId` / job 级 once-only）**未实现**，所以"同一件作业在同一天的第二个 slot 又跑一遍"仍可能发生（`REPORT.md` §4.1）。
4. `prepared` 过期不改写、历史实例未对账（`REPORT.md` §4.2/§4.3）——启用前必须做。

**仍未实现**：终态 gate、历史实例对账、效应账本的自我收敛扫描。见 §13.4 第 4 条。

#### 13.6.7 §13.4 缺口表的现况（本节生效后）

- **已关闭**（原 §13.4 第 2、4、8 条）：
  1. `drainOutbox` 未传 `owner` → 已传（`index.mjs:1840` 一带的 `drainOutbox(...)` 调用同时传 `owner`/`generation`）；bridge 侧 `enqueueIngest`/`refreshClaim` 另加 `requireRow:true`（13.6.4）。
  2. `activities.assertRunGate` 无租约检查 → 已有（`activities.mjs:806-818` → `assertLeaseGate()` `:826-837`，缺方法抛 `lease-lost`）。
  3. 终态→P1 缺补偿扫描 → 已有（13.6.2 的 `p2_p1_` 标记 + `compensateFinishedEvents`，`p2.mjs:714` 起）。
- **仍开放**（按 §13.4 当前编号）：第 1 条（`activities.step()` 无预算闸门）、第 2 条（`planner` 条件回退）、第 3 条（`p2.mjs:420` 的 `typeof` 跳过）、第 4 条（终态 gate + 历史对账 = R4 的剩余）、第 5 条（观测缺口）、第 6 条（`retry_wait`/`cancelled` 不可推导）、第 7 条（3 条生产历史孤儿 slot）、第 8 条（外发闭环剩余缺口）、第 9 条（经历链路生产从未运行）。
- **一条运维事实**：**13.6.2 + 13.6.3 这条链路在生产从未运行过**——生产库 `memory_outbox` 至今 0 行、`domain_events` 里 0 条 `memory/ingest-request`、`p2_p1_*` 标记一条都没有。所以它"有测试覆盖"但"没有生产证据"。**启用前必须做一次真机观察**（步骤与观测点见 `design/p2.5-operational-playbook.md` §2/§3），不要用"测试全绿"替代真机观察。

### 13.7 P2.5-2 经历闭环（E1 / E2 / E3 / E5，2026-11-01）

本节冻结"活动 → 事实 → 记忆 → 次日计划"这条链路中 runtime 侧承诺了什么。经验证据：`logs/p2.5/experience-loop/REPORT.md`（task-15，实施时记 542/542，2026-11-02 01:40 复跑为 **575/575（78 文件）**）。记忆侧的**写入策略**在 `design/p2.5-experience-memory-policy.md` 单独成文，本节只写**接口与判定归属**。E4/E6/E7 见 §13.9。

#### 13.7.1 E1：失败/放弃/错过/复核停摆也产出 P1 事实【已实施】

- **相位白名单**：`P2_FACT_PHASES = Object.freeze(['finished','failed','abandoned','missed'])`（`index.mjs:29`）。`paused` **故意不在内**——普通时间窗暂停什么都没发生，把它写成"发生"就是 P2.5 禁止的"模型没执行却说已经做了"。
- **钩子触发**：`activities` 的 `onFinished` 从只认 `finished` 放宽到 `finished|failed|abandoned`（`activities.mjs:2239` 一带），并传 `phase / reason / slotId / sourceRef / receiptId`。
- **生产真失败路径**：`parkForReview`（源码中途被改、`source-changed` 之类）也发事实（`activities.mjs:2336`），相位记 `failed`。不改这条，AC-06 的失败案例仍然击穿——因为生产的失败**大多数是 `paused + needsReview`，不是 `failed`**。
- **从未开始的槽位**：无 activity 行，走单独的 `p2ActivityMissed`（`index.mjs:1530` 起），`phase:'missed'`、`result:'skipped'`。
- **表述红线**：正文按相位生成，**永不把失败写成完成**（`index.mjs:1469-1476`）：`自主探索《X》失败，未完成，原因：source-invalid，覆盖 N 字（共 M），已标记待复核。` / `…被放弃，原因：…` / `计划中的阅读《X》没有开始（窗口已过）。`
- **结构化事实**：payload 附加 `facts:{activityId, slotId, kind, phase, result, code, target, sourceRef, consumedFrom/To, totalUnits, artifactVersion, reality, subjectKey}`（`index.mjs:1505-1520`）。memory 忽略未知键，事件日志/UI/次日计划读它。
- **reality 红线**：不在 `['actual_tool_activity','simulated_world','hypothetical']` 内的一律 fail-closed 成 `hypothetical`（`index.mjs:1479-1481`）。

#### 13.7.2 E2：`significance` 判据在 runtime，memory 只按字段分流【已实施】

- **判定归属（冻结）**：`activitySignificance()`（`activities.mjs:304-320`）是**纯函数**，只看记录能证明的东西（相位、kind、覆盖/总量、产物版本），不调模型、不解析文本。取值只有 `notable | routine`。
- **判据**：`failed|missed → notable`；`abandoned → routine`；`write` 有产物版本 → notable，无 → routine；`explore → notable`；有产物版本或"没读完"→ notable；其余（读完、无产物）→ routine。
- **记忆侧只分流、不重算**（`companion-memory/index.mjs` `decideIngest`）：`routine` → `reject / routine-activity-not-remembered`（策略性拒绝，不是错误）；`evidenceStatus='inferred'` → `pending`（0.35）；`confirmed` → `accepted`（0.9）；其余 observed → `accepted event`（0.6）。reality 不是 `actual_tool_activity` → `reject / non-actual-reality`（先于一切）。
- **同源去重**：`ingestSubjectKey`（`activities.mjs:329-332`）= `sha256(["p25-subject-v1", namespace, kind, target])`，**不含时间**；配合 `isRepeatOfRememberedOutcome`（`index.mjs:515-532`，7 天 / 10 行 / 只读）→ 第二次起判 `routine`：**事实仍记录，但不产生第二条长期记忆**。
- **禁止**：memory 侧自行推导 significance；要改判据只改 `activitySignificance` 一处。

#### 13.7.3 E3：planner 的"最近做完的事"【已实施】

- 材料分区 `## 最近做完的事（这些是已经发生的事，不是计划；不要假装又做一次）`（`planner.mjs:747-754`），最多 8 条，按 `outcomeText(row)` 区分 `[完成]` / `[未完成·失败]` / `[未完成·待复核]`。
- **必须包含非成功结果**：`done / failed / abandoned` 都渲染，标签不许把失败写成完成。
- "复核停摆"用 `checkpoint LIKE '%"needsReview":true%'` 判（不依赖 JSON1），当前写法有测试覆盖。

#### 13.7.4 E5：失败目标的降权【已实施（软）】

- 材料分区 `## 最近失败过的事（同一条不必反复试）`（`planner.mjs:757-758`），最多 5 条。
- `## 只能用这些目标` 里，**同一目标失败 ≥2 次**才加后缀"（近期失败 N 次，优先换一条）"（`planner.mjs:725-733`）；失败 1 次**不降权**。
- `[已实施（软）]`：只是**提示**，模型仍可能选它。**硬排除属于 foundation 侧（E4-c），本轮未做**。

#### 13.7.5 E3-d：memory → planner 的回流【有意不做】

- 本轮**不**把长期记忆回灌给 planner。理由：记忆是**审核后的用户事实**（含 `pending` 未确认项），把它当规划材料会让"计划"引用未经确认的推断；且会形成自激（自己写记忆 → 自己读记忆 → 再写）。
- 若将来要做，必须先定"哪些记忆可回流 + 如何标注 pending"，不得顺手打开。

#### 13.7.6 边界与未实现（不许当成已有）

1. **显著性判据是启发式**：写完但内容空洞的 `write` 仍算 notable；读了 99% 的 `read` 按"没读完"算 notable。
2. **memory 侧 `routine` 是终态拒绝**：outbox 行落 `failed`，不重试；判据将来改了，历史 routine 事件**不会**自动补写记忆。
3. **去重窗口 7 天**：超过 7 天再读同一来源会产生第二条记忆（有意），阈值未经真实数据校准。
4. **失败事实的 `evidenceStatus` 是 `inferred`** ⇒ 进 `pending` 审核队列；人工不确认就不算记忆。"明天知道没完成"主要靠 E3 的 runtime 侧历史。
5. **E5 无硬排除**、**E3-d 不做**。
6. **整条链路在生产从未运行过**（§13.6.7 同一条事实）。575/575 全绿不是真机证据。

### 13.8 外发闭环：三层口径与 3A 最小改法（2026-11-01 裁决）

依据：`design/p2.5-decisions-outbound.md`（Lead 裁决）+ `design/audit/p2.5-a5-outbound-loop.md`（A5 审计）。本节把"计划说共用统一外发池"与"本合同说提醒不得改走 contact"这两句话**解成三层**，两者从此同时成立。

#### 13.8.1 三层，别混着说

| 层 | 现状 | 裁决 | 证据 |
|---|---|---|---|
| **L1 物理出网队列** | **已统一**：contact 与提醒/语录共用同一条 `out.push(() => api.sendTo(...))` 出站链与串行限速链 | **不动** | `contact/sender.ts:12`（"与提醒/语录共用一条出站链"）、`:56`、`:318`；`features/reminders/index.ts:26` |
| **L2 发送方** | 两条：reminders runner 与 contact sender | **必须保持两条** | `contact/gate.ts:257`：`source==='explicit-reminder'` → `drop`，reason `reminders-owns`（理由见 `gate.ts:21`）。这是**第三轮评审 FAIL 后**的结论 |
| **L3 决策 + 记账** | contact 有 23 条 reason 的门控 + 账本；reminders 原来只有"发/不发"两态 | **3A 已补齐** | §13.8.2、§13.11 |

所以：计划 §3A 的"共用统一外发池"= **L3**；本合同旧措辞"提醒不得改走 contact"= **L2（仅指发送方）**，**不含**决策与记账。从本节起，凡是写"提醒不得改走 contact"的地方都必须带"发送方"三字，否则视为笔误。

#### 13.8.2 3A 最小改法（**3A-1…3A-5 已落地**，2026-11-02）

1. **3A-1 公共闸门 + 共用一本账【已实施】**：`contact/gate.ts` 抽出 `evaluateOutboundBudget()`（与候选身份无关的检查，reason 与顺序不变）；`ContactService` 增 `outboundBudget()`/`account()`；reminders 的 `deliver()` 发送前调 budget、发送后调 account。通道用既有的 `ServiceBag.contact`（`features/plugin-kit.ts:108、:168`），**不新增跨插件接口**；**零 migration**（都是 JSON）。
2. **3A-2 提醒 `unknown`【已实施】**：三态 `sent/unknown/skipped`；`store.markUnknown(id, reason)` —— 一次性提醒 `fired=true`（`due()` 不再返回），周期提醒把 `at` 推到下一轮；`unknown` **不自动重试**、参与去重、只记一次账。修前是"失败不 `markFired` → 每 30 秒无限重试"。
3. **3A-3 `dryRun`【已实施】**：`reminders.dryRun`，**默认 `true`**（`config/sections/content.ts:69`）；打开时走完选条 → 闸门 → 记账但不真发，诊断报 `state=disabled`，**不得伪报正常**。
4. **3A-4 `occurrenceId + revision` + 发送前 CAS 回写【已实施】**：提醒条目存 `occurrenceId + revision`，**发送前**用 revision 做 CAS 回写；回写失败 = 该提醒已失效（取消/改期/时区变更/DST gap&fold），**不得发送**。
5. **3A-5 投递成功后由 QQ 侧写 `occurrence-dispatched`【已实施】**：**不打开** `heartbeat.activityConsumer`（它会把 `payload.consumer` 语义与 H1 定义层混在一起）。失败/未确认**不得**写。

#### 13.8.3 分享（3B）：已接到既有闸门，但开关关着

- 现状：contact 通过 `publishServiceSafely()` 把 `companionContactShare` 发布到宿主 ctx（见 §13.11.1）；`p2.share.enabled` = **`false`** ⇒ 零候选、零外发。
- **候选过期现在是静默丢弃**（无诊断），见 §13.11.4 —— 这是开放 `share.enabled` 之前必须补的。
- 3B **没有新的发送路径**：复用 contact 的既有 `propose` + `worker.tick`，并复用 3A-1 的同一本账。

#### 13.8.4 顺序、验收与回滚

- **顺序**：3A-1 → 3A-2 → 3A-3 → 3A-4 → 3A-5 → 3B（已按此顺序落地）。
- **验收前提**：①每一片先证明"对现有测试零行为变化"（除该片新增语义）；②提醒上线前必须有一次**真机受控投递**（主人在场）；③`dryRun` 必须**从 `true` 起步**，确认"该发时发、该跳过时跳过、`unknown` 不重发"之后再关。
- **回滚**：3A 各片只改 QQ 插件代码与 `reminders.json`/`contact.json`（JSON，无 schema）→ 回滚 = 代码快照 + 配置回退，**不涉及数据库**。快照见 `logs/p2.5/rollback/`（3A: `outbound-3a`，3B: `3b`，发布档: `agenda-provide`）。
- **不许**用"关 `reminders.enabled`"假装回滚了 3A：它只停轮询器，不清 `unknown`，也不回退 `reminders.json` 里已写下的 `occurrence` 绑定。

#### 13.8.5 与 runtime 侧的分界（避免越界）

- runtime **不产生**提醒、**不发送**、**不写** `occurrence-dispatched`（§12.1 "H1/H2 都不注册任何发送路径" 仍然有效）。
- runtime 对提醒的唯一输出是只读视图与 `delivery:'reminder-owned'` + `reminderDelivery:'not-wired'` 的诚实标注。
- **2026-11-02 补充（3A 已落地）**：3A-5 落地的是**QQ 侧**在投递成功后写 `agenda/occurrence-dispatched`。runtime 的 `reminderDelivery` **仍然是 `not-wired`**，因为它描述的是"runtime 自己有没有投递能力"（没有，也永远不该有），不是"QQ 有没有发出去"。这两个字段不许混为一谈，见 §13.11.5。

### 13.9 P2.5-2 经历闭环（E1–E7）与纠正语义

本节是 §13.7 的**续篇**：§13.7 冻结了 E1/E2/E3/E5（活动 → 事实 → 记忆 → 次日计划），本节冻结 E4（目标与承诺真的接上）、E6（信念进入规划 + 纠正通道有生产者）、E7（UI 只读投影与写路径定性），并给出 E4/E6 的**装配级**证据。经验证据：`logs/p2.5/experience-e4e6/REPORT.md`、`logs/p2.5/ui-e7/REPORT.md`、`logs/p2.5/correction/REPORT.md`。

#### 13.9.1 E1 / E2 / E3 / E5【已实施，见 §13.7】

不再重复。只有一条**必须带上**：`parkForReview`（源码中途被改 → `paused + needsReview`）也发事实（`activities.mjs:2336` 一带，`phase:'failed'`）——生产里的失败大多是这条路径，不是 `failed` 状态。

#### 13.9.2 E4：`goals / commitments` 真的接上了（**四处断点全部已修**）【已实施】

**修前的四处断点**（缺一处，生产里"有目标"就与"看不到目标"同形）：

| # | 断点 | 修法 |
|---|---|---|
| 1 | `foundation/index.mjs` 的 `createAutonomyPorts({options})` **从来没传** `continuity` → `autonomy-materials.mjs:134-139` 的 goals/commitments 段恒空 | runtime 新增 `continuitySnapshot({limit, commitmentLimit, maxChars})`（读未关闭 goals + `commitments.status='open'`，条数与字数封顶，`source:'runtime:goals'`）；foundation 新增 `continuityValue()` 闭包，**三档有界**（6/6 条、每项 120 字、**25 ms 墙钟预算**），未挂载/抛错 → `state:'not-wired'` |
| 2 | `autonomy-materials.mjs` 把 goals/commitments 的 source 标成 `'missing'` | 改成 `state==='ok' ? 'runtime' : 'not-wired'`，并在 material 里新增 `continuity:{state, reason}` |
| 3 | materials 端口返回**自己的白名单**，runtime 的 `p2Materials` 合并后不贴回 ⇒ `continuityState`/`goals`/`commitments` 静默丢失（"测试绿、生产空"的老坑） | `p2Materials` 合并后**重新贴回**这些字段 |
| 4 | planner 拿不到"看不到 ≠ 没有"的信号 | `planner.mjs`：goals/commitments 为空**且** `continuityState !== 'ok'` 时，prompt 写一行"这一轮看不到用户的目标与承诺（原因）。不要据此推断『用户没有目标』，也不要编造目标" |

**装配级证据**（`companion-runtime/test/experience-e4e6.test.mjs`，真挂载、不注入 materials）：真挂载后 `continuitySnapshot()` 给出 2 目标 + 1 承诺且标题/正文对得上；`limit:3, maxChars:30` 时恰好 3 条、每条 ≤30 字；provider 缺失时 prompt 含"这一轮看不到…"与"不要据此推断"，**不会**变成"用户没有目标"。

#### 13.9.3 E6：planner 读 beliefs，`correctBelief` 是**唯一**触发点【已实施】

- **修前**：belief supersede 链在 P1 内部是真的，但 planner **完全不读 beliefs**；`memory/correction-request` **零生产调用点**（`events.mjs` 白名单里有、`bridge.mjs` 留了 namespace，没人发）——一条死通道。
- **现在**：`beliefsForPlanning(scopeKey, now, 6)` 只取 `status==='supported'`（`unknown` 是猜测，不能拿来规划）、只取 supersede 链的当前版本、6 条 / 每条 160 字封顶、带 `corrected` 标记；`planner.mjs` 新增 `## 用户已经相信 / 已纠正过的事（已知事实，不要当成新发现）`。
- **唯一触发点**：`correctBelief`（`index.mjs:448` 附近 `correction: true`）。任何人再造第二个 correction 生产者之前，必须先改本节。
- **best effort**：`memoryCorrection` 排不进队列**不会回滚**已经提交的 belief 纠正（理由见 §13.10.3）。

#### 13.9.4 E7：UI 只读投影 + 5 处写路径定性（**无 C 档**）【已实施】

- **只读投影**：`companion-memory-studio` 的 `lib/companion-dashboard.mjs` 新增 `buildExperience()`，`life.experience` 带 `authority:'projection'` 与 `note`（"只读投影…不是权威状态"），数据源是已经读出来的 `p2_activities` + `p2_activity_receipts` 两段，**不新增查询**；`reality='simulated_world'` 的条目带 `simulated:true`（页面标「模拟/假设」）。
- **结果四档判据**（回执优先、status 兜底）：完成 = `finish` 回执 `ok=1` 或 `status='done'`；失败 = `status='failed'`；跳过 = `status='abandoned'`；待复核 = `status='paused'` 或 `review` 回执 `ok=0`；`running` **不算经历**（在"正在做"里）。
- **5 处写路径，全部 B 档（受控写入），无一处 C 档**（绕过事件/审核链直写 SQLite）：

| # | 入口 | 落到哪 | 定性 |
|---|---|---|---|
| 1 | `POST plan-slot` | `lockPlanSlot/skipPlanSlot` → `autonomy/plan-slot` 事件 + reducer + 租约 | B 合法 |
| 2 | `POST memory` | `db.setStatus/updateMemory`（带 `reason`、`actor:'user'`）→ 记忆审核链 | B 合法 |
| 3 | `POST settings` | 原子写 `home/companion/runtime.config.json`，回执 `restartRequired`，**不写 SQLite** | B 合法（改的是配置） |
| 4 | `POST maintenance` | `rebuild`（派生数据、幂等）/ `integrity`（只读）/ `compile-wiki`（只写文件） | B 合法（不动记忆内容） |
| 5 | `POST wiki-page` | wiki 原子写文件（人工注释区），不进 SQLite、不进事件书 | B 合法（需标注） |

- **护栏**：`E7-6`（运行时零写语句 + 数据库字节不变）、`E7-7`（源码级：只读连接 + 查询串只允许 SELECT）。
- **边界（不许夸大）**：零写只覆盖 dashboard 这一条读路径；5 处定性是**代码审读**结论，不是逐条真机点验；未知 status 会被**静默跳过**（宁少一行，也不把未知说成完成）；`E7-6` 的"字节不变"仅在 journal 模式下成立。

### 13.10 纠正的 superse 语义（fail-closed）【已实施】

#### 13.10.1 为什么零 migration

memory 早就有 `status='superseded'` 取值、`valid_to` 列与 `recordRevision` 修订日志，而且**所有召回层本来就只取 `status='confirmed'`**（`fullTextSearch` 默认 `statuses=['confirmed']`，`retrieve.mjs` 三道闸同样是 `confirmed`）。所以把旧行标成 `superseded` 之后，关键词 / FTS / 向量三条召回**同时**不再返回它——**一行查询都不用改，也不需要任何 schema 变更**（memory `SCHEMA_VERSION = 2` 改前改后相同）。

#### 13.10.2 fail-closed 的判定（**不要"尽力而为地压"**）

`applySupersedeHint`（`companion-memory/index.mjs:412-460`）在 ingest 收尾执行：

| hint 形态 | 命中 | 结果 |
|---|---|---|
| `mem_…`（记忆 id） | 精确命中 | 压该条 |
| 文本 | **恰好 1 条**同 subject 的 `confirmed` 行 | 压该条 |
| 文本 | **≥2 条**（`LIMIT 5` 内） | **不压**，`correction-hint-ambiguous` + 候选 id 记进待办（`:452-454`、`:601-602`） |
| 任意 | 0 条 | `correction-hint-miss`，**不报错**，按普通事实入库（`:443-444`） |
| 任意 | >200 字或带控制字符 | `rejected / invalid-supersedes-hint`（**拒绝而不是截断**） |

**为什么不"挑一条压"**：压错等于把一条**用户没否认过**的事实永久移出召回，且不可自动恢复；不压只是"这次没生效"，可人工补。**歧义时选择不动，才叫 fail-closed。**

#### 13.10.3 投递失败：记待办 + 既有 drain 补发，**不回滚**

- 失败写 `runtime_meta` 的 `p2_correction_pending:<beliefId>`（JSON：namespace/content/supersedesHint/sessionId/reason/at），`INSERT … ON CONFLICT` 更新（同一 belief 反复纠正只覆盖、不增长）。
- `retryPendingCorrections({limit})` 有界补发（≤20/次），**只有真的排进队列才删待办**。
- 挂在**既有** drain 上：`drainOutbox` 钩子先 `retryPendingCorrections({limit:3})` 再 `drainOutboxTick()` —— 坏掉的纠正不会饿死正常 outbox。
- **不回滚 belief 纠正**：回滚会把"用户刚说的纠正"退回成"没纠正"，且要跨两个存储做分布式回滚；补偿（至少一次）与 §13.6.5 的重试语义一致。

#### 13.10.4 证据与边界

- 证据：`companion-memory/test/correction-supersede.test.mjs`（真引擎 + 真 `recall()`：纠正后**不含旧记录 id**、旧行 `superseded`、FTS 路径同样不带旧事实、重复投递只 superse 一次）；`companion-runtime/test/correction-request.test.mjs`（正文带"旧：…"与"现在是「…」"、`supersedesHint` 进 payload、待办被补发后清零、队列不可写时待办保留）。
- **未验证**：真实向量召回（本套件不启用 embedding provider，"状态过滤是共享的"是代码事实而非实测）；`ambiguous` 待办目前只有查询视图（`:861-869`），没有自动重试与 UI 一键收敛。

### 13.11 分享链与回执语义

#### 13.11.1 端口名：两个都发布

`companion-foundation/index.mjs:45-55` 实际探测的是 `service.submitShareCandidate`（`typeof … === 'function'`），而任务书/早期文档写的是 `submitShare`。**QQ 侧两个都发布**，谁都不用改；runtime 的调用面是 `submitShareCandidate`（`lib/p2.mjs:1062`、`index.mjs:2215`）。

#### 13.11.2 回执**只保证已入库**

`submitShare()` 的内部顺序是：开关（`p2.share.enabled`，读失败一律当关闭）→ 目标（绑定主人私聊，无 owner 即 `no-target`）→ **既有** `contact.propose({source:'share-intent', evidenceSource:'p2-share', dedupeKey:'share:<candidateId>'})` → **既有** `worker.tick(now)`（闸门 → 起草 → outbox）。全程 try/catch，**永不对调用方抛**。

由此得到两条硬约束：

1. **`ok:true` 只代表"候选进了 contact 账本"，不代表闸门已评估，更不代表已发出。** 闸门可能稍后才判 `defer/drop`（免打扰、配额、冷却、退避）。
2. 因此 runtime 侧**只许**把候选标成 `queued`；**`sent` 永远不是 runtime 能写的状态**。任何"分享已发出"的展示都必须回到 contact 的 delivery 事实。

**授权档位**：分享用 `standing`（她决定分享），**不是** `explicit`（用户原话）——把推断写成用户原话是错的。

#### 13.11.3 候选 TTL：`contact.shareTtlMs` 默认 6 小时

- 配置字段 `contact.shareTtlMs`（`hot: live`，每拍现取，单位毫秒），默认 **21_600_000（6 小时）**。
- 理由（工程判断，**不是实测**）：**6 小时刚好跨过"一夜免打扰 + 一次冷却"还活着**，又不至于让昨天的心情今天才冒出来。
- 它**只影响候选过期**，不影响闸门；若配额/冷却长期把候选挡住，"过期"就是**静默丢弃**（见下）。

#### 13.11.4 过期 = 可见的丢弃（2026-11-03 补上诊断）

**修前**：候选过期没有任何告警或计数——既没有"过期了几条"，也没有"为什么没发"。补诊断之前不得把"分享链通了"当成"分享会发出去"的证据。

**现在（零 migration，全部从既有行算）**：

- runtime 侧 `p2Status().share` 增加 `counts`（按状态计数）、`expired:{count,lastAt,reasons[]}`、`dropped.reasons[]`（`gated/rejected/withdrawn/expired` 的 status×reason 分布）、`pendingOldestAgeMs`，并把 `contactAckAfterQueued:'unknown'`、`sent:'not-wired'` 显式写出来——runtime 永远不知道"对方看到"。
- `pumpShareDelivery()` 不再把 `expired`/`reasons` 丢在返回值里（唯一调用方曾连返回值都不接），并写入 `p.lastTick.share`。
- foundation 侧另有只读诊断 `describeShareChain()`（`plugins/companion-foundation/share-diagnostics.mjs`），挂在 `companion_runtime_status().shareChain`，可只读打开 `companion-runtime.db` 独立核对。
- **同时修掉一个真 bug**：contact 闸门真实透传的 `cooldown:room/global`、`quota:global/room`、`settle:user-active`、`turn-running`、`tool-running`、`backoff:unanswered`、`no-channel`、`timezone-invalid`、`disabled`、`not-due` 原先不在 `SHARE_GATE_RETRYABLE` 里 ⇒ 被判成终态永久丢弃（"过一会儿还能发"变成"永远不发"）。补全后 `SHARE_MAX_ATTEMPTS`/TTL 那条"重试用尽 → expired"的路径才真的可达。
- **候选生产者**：2026-11-03 之前 `createShareCandidate` 在生产代码里**零调用点**（`finishActivity` 不产候选）；现在 foundation 提供 fail-closed 生产者工具 `companion_share_activity`（`plugins/companion-foundation/share-producer.mjs`），开关关着时行为零变化。
- **两个 TTL 别混**：runtime `SHARE_CANDIDATE_TTL_MS` 是 **7 天**，contact `shareTtlMs` 是 **6 小时**；`pending` 行**没有** TTL 扫描（未实现）。
- **仍未验证**：真实送达、平台 `messageId` 回填（`sent` 永远是 `not-wired`）、配额/退避真机行为、`queued` 之后 contact 6h 过期的跨存储证据。

#### 13.11.5 三个字段别混（发布状态 vs 投递能力 vs 开关）

| 字段 | 位置 | 现在的值 | 含义 |
|---|---|---|---|
| `p2.share.enabled` | `home/companion/runtime.config.json` | **`false`** | 分享候选**根本不会被创建** |
| `reminderDelivery` | runtime `agenda` 端口 `describe()` / 条目字段 | **`not-wired`** | runtime **自己不投递**（现在不，将来也不该）——3A-5 落地的是 **QQ 侧**发事件，不等于这个字段变绿 |
| `reminders.dryRun` | QQ `config/sections/content.ts:69` | **`true`（默认）** | 提醒**到点但不发**：走完选条 → 闸门 → 记账，跳过真发 |

⇒ 现在给一个没参与这几轮的人的最短判断：**提醒不会真的发出去（dryRun，但闸门真的跑过了），分享连候选都不建（开关 false），runtime 侧永远不投递（not-wired）。**

#### 13.11.6 3B 的边界（不许当成"分享已上线"）

- 分享**没有新的发送路径**：它复用 contact 的既有 `propose` + `worker.tick`（L2 不新增发送方），并复用同一本账（§13.8.1 的 L3）。
- 生产配置下 `submitShare` 返回 `share-disabled`，**零候选、零 delivery**（`share-3b.test.ts` S1）。
- **未验证**：分享真的发出后的文案/时机/频率没有任何真机证据；候选过期无诊断（§13.11.4）。

## 14. P2.5-A/B 最小范围：单个 `read` operation 的落地记录（2026-11-03）

本节记录 P2.5-A/B 最小范围（任务书 §9：只做 claim / 去重执行 / 完成回执 / 失效恢复，不接 QQ、不开 share、不扩 `allowedSources`）在实现层的偏差回写。口径沿用 §13：**【已实施】**＝有代码有测试；**【未实现】**＝只是计划；**【未验证】**＝有代码但无真机证据。

### 14.1 【已实施】失效恢复：`park()` + 执行器的 `source-changed` 收敛

- **缺口（修前事实）**：`pumpActivityExecution` 在 `segment()` 失败时只把失败码放进返回的 `steps`，不改变活动状态。`segment()` 每步都会重读并重算源哈希（`activity-adapters.mjs:583-599`），因此**读写进行中源文件被改**会让 `source-changed` 每拍重复出现，而活动行永久停在 `running`。这正是计划 §6 禁止的"永久卡在 running"；`reconcile()` 对此只写 `review` 回执、不改变状态（`activities.mjs` reconcile 的哈希不符分支）。
- **修法**：`activities.mjs` 新增公开 `park({activityId, scopeKey?, code, detail})`，内部复用既有 `parkForReview`（`paused` + `needsReview:true` + 一条 `review` 回执 + 注入 `onFinished` 时一条 `failed` 事实）；`p2.mjs` 的 `PARKABLE_SOURCE_CODES = {'source-changed'}` 命中时调用它。
- **边界（有意收窄）**：`source-invalid` **不** park——它同时覆盖暂时性 I/O（文件被另一写者锁住、瞬时不可读），park 会把瞬时故障变成人工任务；永久性场景仍由"窗口关闭 → `window-closed` 暂停"这条既有有界路径兜住。
- **非目标**：`park()` 不动进度、不 finish、不改 `consumed_prefix`；非 `running` 行返回 `{ok:true,duplicate:true}` 而不是报错。
- **证据**：`test/p2.5-read-operation.test.mjs`（`invalidation:` 用例）、`logs/p2.5-next/activity-dispatch-read/`（44/44 检查含 `invalidation:` 场景）。

### 14.2 【已实施】`dispatchEnabled=false` 的默认不派发（本轮复验，非新功能）

- 断言链：`DEFAULT_CONFIG` 严格等真（`config.mjs:201`）→ `index.mjs:1958` 只在两个开关都为真时注入钩子 → `p2.mjs:206/300` 二次复核 → 心跳钩子缺席时 `activityDispatch:'disabled-by-config'` 且 `activityDispatchLimit:0`（`heartbeat.mjs:1064-1067`）。
- 本轮把它做成**可复现的集成测试**（此前只有分散的单元级断言）：`test/p2.5-read-operation.test.mjs` 的 `gate:` 用例 + `scripts/p2.5-read-operation-evidence.mjs` 的 `gate:` 场景。

### 14.3 【已实施】单 operation 的 retire/接续语义（复验）

- 一个逻辑操作的 id 是内容寻址：`activityIdFor({scopeKey, slotId, kind})`（`activities.mjs:682-684`）。因此"claim 后进程死掉"由 pump 用**同一个** id 接续，不会变成第二个 operation；窗口已过则落 `missed` 回执（`reason:'window-closed'`）而不是无限 `running`。
- 同进程再 mount 会按 `db.mjs:209-211`（同 pid 热重载分支）接管租约，旧实例随即被 `assertLeaseHeld` 栅栏挡下；**跨进程**互斥由 `test/lease-crossprocess.test.mjs` 覆盖（本轮未复跑单列证据）。

### 14.4 【未实现】本轮**没有**动的东西（任何人不得当成已有）

- 终态 gate（job 级 once-only）、`prepared` 过期的自我收敛扫描、历史实例对账：仍是 §13.4 第 4 条。【已实施】的只是"同一 attempt 的意图不重复"（`effectReceiptIdFor` 主键 + `intent.inserted !== true`，`activities.mjs:1849-1855`）；`confirmed` **不**阻塞同一 job 的**下一次尝试**（`activities.mjs:388-393`），"多发生一次"的风险面是合法的第二次尝试，不是同一次被写两遍。
- `activities.step()` 预算闸门（§13.4-1）、`planner` 条件式租约回退（§13.4-2）、`p2.mjs:420` 的 `typeof` 跳过（§13.4-3）。**2026-11-03 更新**：本条原先还包含"`slots_due`/`dispatch_lag_ms` 观测"，该项已在 §15 落地（`lib/dispatch-observability.mjs`、`p2Status().activities.dispatch`、`heartbeatStatus().activityDispatchLastCycle`、`runtime.p2DispatchWatch()`），不再属于未实现；§15.5 列出它**没有**解决的部分（告警阈值、历史对账、真机节奏）。
- `memory_outbox` 的真实 drain（本轮只验证到 `queued`）、真实模型调用、真实宿主进程、24h/72h 长稳：全部 **【未验证】**，清单见 `logs/p2.5-next/RELEASE-CHECKLIST.md` §5。

### 14.5 【已实施 2026-11-03】经历链路（活动终态 → 记忆）的端到端证据

- 之前的状态：runtime 侧（回执 / ingest 事件 / outbox）与 memory 侧（`ingestDomainEvent`）各有测试，**中间没有一条测试把两端接起来**，所以"整链生产未真跑"只能靠自觉。
- 现在：`test/p2.5-experience-chain.test.mjs`（3 条）用**真实 `companion-memory` 引擎**（非桩）+ 真实 runtime + 临时 SQLite 跑出三种结局：
  1. routine（普通读完）→ memory 按策略拒绝 `routine-activity-not-remembered`，outbox 落 `failed`，长期记忆 0 条；
  2. notable（探索完成）→ 落 `persona_self` + `kind=event` + `reality_level=bot_action` + `tags:namespace:p2/activity`；
  3. 同一条经历重放 → 7 天重复规则判 `routine` → 记忆侧拒绝：1 条记忆、2 条 outbox 行、原因可查。
- **生产审计（只读）**：p2 经历记忆共 7 条，其中只有 1 条是正确的 `persona_self/bot_action`；**6 条在 `user_global`**，4 条**仍是 confirmed**（角色经历被写成用户事实），2 条已 retracted。即 §C1 的"角色经历误归用户事实：0"在生产上的实际值是 **4**。代码已修（新写入一律 `persona_self/bot_action`），**存量未清**；清理步骤见 `logs/p2.5-next/experience-chain/REPORT.md` §3（需主人批准，带修订链，不许直接改 SQL）。
- **【未实施】策略问题**：带回执的完成仍以 `evidenceStatus:'inferred'` 上报，所以 notable 经历落成 `pending` 候选而非 `confirmed` 事实；改成 `observed/confirmed` 属策略变更，本轮未做（测试已钉住现状）。
- **【未验证】**：真实模型回合产出的经历、真实宿主进程内 drain、`pending → confirmed` 提升路径、跨日 D1→D2 闭环。

### 14.6 文档更正（只记录，未擅自改写）

- §13.5 写的"没有 git：`dsh-companion/` 是未跟踪目录"与事实不符：仓库根是 `D:/Bot`，`plugins/companion-runtime/lib/*.mjs` 均为已跟踪文件（`git ls-files --error-unmatch` 成功）。因此代码回滚可以直接走 `git checkout --`。此处**未改写**原文，只在本节留更正记录，是否改写由文档所有者决定。
- `README.md` 第 22/211 行的"活动派发未接线"是滞后表述（同一份 README 的 §15 :400 已写"已实现但当前关闭"）。差异清单见 `logs/p2.5-next/baseline/SOURCE-VS-README.md`。

## 15. 活动派发的观测口径与 dry-watch（2026-11-03，phase 2）

本节回答一个问题：**在把 `p2.activities.dispatchEnabled` 打开之前，如何用只读手段证明"它到点真的会 claim"，以及打开之后如何知道它没有静默停摆。** 口径沿用 §13：**【已实施】**有代码有测试、**【未实现】**只是合同、**【未验证】**有代码但没有真机证据。

实现位置：`lib/dispatch-observability.mjs`（唯一的计算处）→ 三个消费者：`p2Status().activities.dispatch`（§15.1）、`heartbeatStatus().activityDispatchLastCycle`（§15.2）、`runtime.p2DispatchWatch()`（§15.3）。八个指标组投影（`lib/observability.mjs`）复用同一函数，所以两个视图**不可能**对同一个名字给出两个数（`test/p2.5-dispatch-observability.test.mjs` 的 `honesty:` 用例直接比对）。

### 15.1 【已实施】`p2Status().activities.dispatch` 的字段与真假值

**真假值四态（与 §13/`observability.mjs` 同一套词）**：`measured`＝在给定 `now` 上精确 SELECT；`estimated`＝从**有界**读（效应账本取样）推的；`not-wired`＝这份数据**根本还不存在**（值必须 `null`）；`unavailable`＝查询失败（值必须 `null`）。**`0` 永远表示"查了，是零"；"查不了"是 `null`。**

| 字段 | 口径 | 数据来源 | 真假值 |
|---|---|---|---|
| `available` | 这一组数是否成立。`false` ⇒ 下面所有数值字段都是 `null` | — | — |
| `slots_due` | **现在**会被 claim 的槽数。判据与 `dueSlotsForHeartbeat` 逐条相同：`status='planned'`＋`kind='activity'`＋`start_at<=now<end_at`＋plan `committed`＋该槽还没有 activity 行。**精确 COUNT**（不受下方 200 条取样上限影响） | `p2_plan_slots ⋈ p2_plans ⨝ p2_activities` | `measured` |
| `slots_claimable` | `slots_due` 减去**被未收敛效应挡住的**槽（`blockedJobKeys` 的同一判据） | ＋`p2_activity_receipts (code='lc-effect')` | `measured` |
| `slots_effect_blocked` | 到期但 job 有未收敛效应的槽数（`effect-in-flight` 或 `effect-unknown`，两者都阻断） | 同上 | `estimated`（`effectIndex` 有界取样） |
| `slots_open` | `status IN ('planned','started')` 的**全部**未结槽（旧 `slots_due` 的真身）。时段/plan 状态一概不看 | `p2_plan_slots` | `measured` |
| `dispatch_lag_ms` | `now - min(start_at)` over `slots_due`：**最老的一个到期槽已经晚了多久**。`slots_due=0` ⇒ `null`（空闲没有延迟，`0` 会被读成"分毫不差"） | 由上一行派生 | `measured` |
| `claim_age_ms` | `now - 最老一条 still-waiting claim 的 `recorded_at``，即"心跳认领了、泵还没把它变成 activity"已经等了多久。没有等待中的 claim ⇒ `null` | `domain_events` (`autonomy/plan-slot`, `payload.to='started'`) | `measured` |
| `claim_age_source` | `'recorded_at'`（有真实墙钟）｜`'not-recorded'`（**这批 claim 写在 §15.4 之前**，两个时间戳相同，无法算，故 `claim_age_ms=null`）｜`'none'`（没有等待中的 claim）｜`'unavailable'`（查询失败） | — | — |
| `claim_oldest_recorded_at` | 上面那个 `recorded_at` 的绝对值（epoch ms），便于对账 | 同上 | `measured` |
| `claimed_awaiting_start` | `status='started'` 且**没有** activity 行的槽数＝"认领了但还没开始"的窗口大小（精确 COUNT） | `p2_plan_slots ⨝ p2_activities` | `measured` |
| `truncated` | `true` ⇒ 某一组取样超过 200 条，此时**逐槽派生**的 `slots_claimable`/`slots_effect_blocked` 给 `null` 而不是下限；`slots_due`/`claimed_awaiting_start` 仍然是精确值 | — | — |
| `activities_pending` / `activities_running` | `p2_activities.status` 的两个计数 | `p2_activities` | `measured` |
| `effects_unknown` / `effects_prepared` / `effectIndexAvailable` | 无收敛效应的 job 数（latest-per-job 的 phase），以及**效应账本是否读得出来** | `p2_activity_receipts` | `estimated`；账本读不出 ⇒ 两个计数 `null` 且 `effectIndexAvailable:false` |
| `dispatch_enabled` / `activities_enabled` / `paused` | 三个开关的**当前真值**（严格等真，见 §13.2） | 配置 + `runtime_meta.p2_activities_paused` | `measured` |
| `lastClaim` | **本进程**最后一次 claim 尝试：`{at, slotId, ok, code}`；`ok:null` = 这份记录里没有尝试（新进程不继承上一次的成功） | 内存 | — |
| `lastStart` | 本进程最后一次 `start()` 的结果码（既有字段，未改语义） | 内存 | — |

**没有数据就不许有空话**：`p2Status()` 在**没有 scope** 时给 `available:false, code:'no-scope'`（不是 `slots_due:0`）；查询失败依次给 `due-query-failed` / `count-query-failed` / `claimed-query-failed` / `activity-count-failed`。**效应账本读不出来时 `slots_claimable`/`slots_effect_blocked` 为 `null`**（不知道哪些被挡），而 `slots_due` 仍然是实测值——把"读不出账本"报成"0 个被挡"会让运维以为可以放心打开开关。空作用域（有 scope、没有计划）才是真的 `slots_due:0`。

### 15.2 【已实施】`heartbeatStatus().activityDispatchLastCycle`：状态之外的**度量**

`activityDispatch` 仍是三态（`wired` / `disabled-by-config` / `unavailable`，§13.2 冻结语义，**未改**）。新增的是**每一拍自己的决定**：

`{at, scope, wired, skipped, deferred, due, claimed, idempotent, quarantined, truncated, refused[], code}`

- `skipped`：`(c2)` 段**没跑**的原因——`'no-hook'`（宿主没注入钩子）｜`'cap-zero'`（`maxDispatchPerCycle=0`）｜`'cycle-time-budget'`（这一拍的时间预算已用尽）。`null` 表示跑了。
- `deferred`：钩子自己给出的具名推迟（`chat-priority` / `activities-paused` / `dispatch-disabled` / …），同时持久化到 `heartbeat_cursor.page_anchor.lastError`（`dispatch-deferred:<code>`）。
- `claimed` 只数**真的插入**的 claim；`inserted:false` 的幂等重放记在 `idempotent`，不计入（这是 claim 幂等语义的观测面）。
- `refused`：本拍被拒的槽与码，最多 5 条（有界）。
- **`null` 表示"本进程还没跑过一拍"**，不是"没有到期"。
- **边界（§13.2 不破）**：心跳仍然**不查任何 P2 表**。这里记的是它自己做的决定；`slots_due`/`dispatch_lag_ms`/`claim_age_ms` 这类要读 P2 表的数**不在**这里，去 §15.1。

### 15.3 【已实施】`runtime.p2DispatchWatch()`：打开开关之前的 dry-watch

`runtime.p2DispatchWatch({ sessionId | scopeKey, now? })` → 只读。回答"下一拍会 claim 哪些槽、会在第几拍、如果不能 claim 是为什么"。

- **槽级** `rows[]`：`{slotId, planId, day, activity, reality, targetRef, status, locked, startAt, endAt, state, blockReason, blockDetail, dueSinceMs, expectedBeat, claimedAtMs, claimAgeMs, claimAgeSource}`
  - `state`：`claimable`（槽的判据允许 claim）｜`blocked-effect`（job 有未收敛效应，`blockReason`=`effect-in-flight`/`effect-unknown`）｜`awaiting-start`（已认领、泵还没建 activity）｜`will-miss`（窗口已过且没开始，泵下一拍会记 `missed`）
  - `expectedBeat`：按 `heartbeat.maxDispatchPerCycle` 推算"第几拍能轮到它"（`floor(第N个/每拍上限)+1`）。**是推算，不是承诺**：前提是这段时间没有聊天抢占、没有暂停、没有新计划。
  - `locked` **不阻断** claim（`dueSlotsForHeartbeat` 的 SQL 里没有 locked 判据）——锁是 H5 的"不要挪动时间"，不是"不要执行"。这里把它原样暴露，不自己发明规则。
- **拍级** `blockedBy[]`：按 `heartbeat.cycle()` 自己的拒绝顺序给出**具名**原因：`heartbeat-unmounted` / `heartbeat-disabled` / `agenda-disabled` / `heartbeat-paused` / `dispatch-cap-zero` / `runtime-<mode>` / `p2-unmounted`，再加上 P2 侧的 `dispatch-disabled` / `activities-paused` / `chat-priority` / `foreground-signal-unavailable` / `invalid-scope`。
- **`claimableNow`**：`blockedBy` 为空 **且** 有可 claim 的槽。**注意分工**：`rows[].state` 说的是"槽的判据"，`claimableNow` 说的是"这一拍真的会动"。开关关着时正确的结果是 **`state:'claimable'` + `blockedBy:['dispatch-disabled']` + `claimableNow:false`** —— 这正是"打开前先观察一轮"要看到的形状（否则看不到任何东西就没得观察）。
- **时刻**不许编：给 `nextBeatWithinMs = pollIntervalMs + jitterMs` 与 `nextBeatNoLaterThan = 上一拍 + 上面这个和`，**不给**"它会在 T 秒后被 claim"。
- **`lastError`**：三层拒绝里**最近**那一条 `{at, from, code}`，`from` ∈ `'heartbeat'`（`dispatch-deferred:*` / `slot-claim:*`，来自 §15.2 的决策记录）｜`'claim'`（`slot-claim:<code>`，本进程）｜`'start'`（`activity-start:<code>`，本进程）。三者都没有 ⇒ `null`（"没失败"，不是"没看"）。它**只报事实**：不推断"大概是因为…"。
- **零写入**：`test/p2.5-dispatch-observability.test.mjs` 的 `dry watch: five calls change nothing` 用例对 12 张表的行数 + `domain_events.max(seq)` + `heartbeat_cursor` 全字段 + `p2_plan_slots` 状态**逐字节**比对（`heartbeat_cursor` 是 UPDATE 型表，只比行数会漏掉 churn）。
- **与 `p2Status()` 的区别（重要）**：`p2Status()` **不是**零写入——它内部会 `budget.sweep()` 关掉遗留的 issued 预留（`p2.mjs:1907`）。要观察"什么都没发生"，用 `p2DispatchWatch()`。

### 15.4 【已实施】claim 的墙钟：`recorded_at` 与 `occurredAt` 分工（**一处语义微调，必须知道**）

- **改动前的事实**：`claimSlotForHeartbeat` 只传 `occurredAt = slot.start_at`，而 `normalizeEvent` 在调用方没给 `recordedAt` 时**默认取 `occurredAt`**（`events.mjs:163`）。所以一条 claim 的 `recorded_at` 等于它的**计划开始时刻**：`recorded_at - occurred_at` 恒为 0，`design/p2.5-baseline-and-contract.md` §4 行 2 建议的那个 lag 算法因此算不出任何东西，`claim_age_ms` 也**没有**数据源（§13.4-5 原话）。
- **现在**：claim 同时传 `recordedAt = clock()`。`occurredAt` **不变**（它参与 `eventIdFor` 的内容寻址，改了会破坏 claim 的幂等/去重），变的只是事件行里 `recorded_at` 这个**记录墙钟**字段。
- **影响面**：只影响**新写**的 claim 事件的 `domain_events.recorded_at`。不改变 eventId、不改变 reducer 的合法转移、不改变幂等/去重、不改变任何判定。旧 claim 行保持原样，并被 §15.1 的 `claim_age_source:'not-recorded'` 如实标注为"算不出来"。
  - **为什么连 `updated_at` 都不会变**：reducer 拿到的是 `now: event.occurredAt`（`lib/events.mjs:344`，注释写明 "handlers see the event's occurrence instant, never the wall clock"，A08 重放一致性要求），`recorded_at` 只被存储、不被任何 reducer 读取。所以 `p2_plan_slots.updated_at` 仍是 `slot.start_at`，**没有**被这次改动带偏。
- **可核对**：`test/p2.5-dispatch-observability.test.mjs` 断言 `recorded_at > occurred_at` 且 `occurred_at === slot.start_at`；证据 `logs/p2.5-next/activity-dispatch-read/phase2/raw-probe-output.json` 里 `claimEvent.recordedAt_minus_occurredAt_ms = 7200000`（槽开始 2 小时后才被认领）。

### 15.5 【未实现】/【未验证】本节**没有**解决的东西

- **【未实现】告警阈值**：字段有、阈值没有。"`dispatch_lag_ms` 超过多少该报警""`claim_age_ms` 卡多久算故障"是运维决定（建议起点：lag > 2×`pollIntervalMs`、claim_age > 3×`pollIntervalMs`），本节不替运维拍板，也不假装已有告警。
- **【未实现】历史对账**：`claim_age_source:'not-recorded'` 只是**如实标注**算不出来，不是把老 claim 补齐；把旧行回填成真实墙钟**做不到**（信息从未写下）。
- **【未实现】终态 gate / `prepared` 过期收敛**（§13.4-4）：未收敛效应仍只有"读取时判定"，watch 只是把它**显示**出来（`blocked-effect`），没有替它收敛。
- **【未验证】真实 60 秒 timer 节奏**：本节所有证据都用可注入时钟 + 显式 `runHeartbeatCycle()`。真实定时器下的抖动、`maxTimeBudgetMs` 截断（`skipped:'cycle-time-budget'`）、多 scope 争用**未跑过**。
- **【未验证】生产库读数**：`slots_due`/`dispatch_lag_ms` 在**生产库**上的实际数值未采集（本节的数全部来自隔离临时目录）。生产打开开关前应先跑一次 `p2DispatchWatch()` 并记录。
- **【未验证】跨进程**：`lastClaim`/`lastStart`/`activityDispatchLastCycle` 是**进程内**事实，多实例时只反映"当前进程"。跨进程互斥仍由 `test/lease-crossprocess.test.mjs` 覆盖（本节未复跑单列证据）。


