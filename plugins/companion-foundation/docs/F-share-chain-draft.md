# F-share-chain 接口草案（B站观看后的分享闭环：决策 + 完成事件驱动生产者）

- 任务包：计划 §5 **F：B站观看后的分享闭环**（十步链路，见 `docs/21-bilibili-share-chain-audit.md`）。
- 证据等级：**E0（审计）+ E1（实现）+ E2（合成纯函数/模块测试）**。没有真实宿主、真实数据库、
  真实 journal、真实模型、真实通道参与；`E5` 真实私聊送达只能由操作者显式触发。
- 文件：`plugins/companion-foundation/share-decision.mjs`（本草案的接口）、
  `plugins/companion-foundation/share-decision.test.mjs`（合成用例）。
- **不修改任何既有文件**。共用入口（`companion-runtime/lib/p2.mjs`、`lib/activity-adapters.mjs`、
  `companion-runtime/index.mjs`、`companion-foundation/index.mjs`、`contact-share-port.mjs`、
  `dsh-channel-qq/src/features/contact/*`）由集成负责人接线，本包只交模块、测试与结论（接线建议见 §10）。
- 本文的“分享”只指**产出一条候选**。候选 ≠ 已发送 ≠ 已送达。

---

## 1. 为什么需要这一层（断点在哪）

| 层 | 现状（有证据的结论） | 本包做什么 |
|---|---|---|
| 生产者 | `share-producer.mjs:63` 的 `shareCandidateForActivity()` 只有模型显式调用 `companion_share_activity` 时才会跑（注册点在 `index.mjs:672-685`）。活动完成（`activities.mjs:2721-2745` 的 `onFinished` → `index.mjs:2578` 的 `p2ActivityFinished`）只写 `memory/ingest-request`，**不产候选**。生产 `p2_share_candidates` 表 0 行就是这条的直接后果。 | 新增**完成事件驱动**的决策 + 生产者：`decideShare()` 纯函数 + `produceCandidateForFinishedActivity()` 受开关控制、幂等、fail-closed。 |
| 决策 | 目前“要不要分享”完全交给模型的一句话；没有兴趣/相关性/新鲜度/重复度/预算的显式判据，也没有理由码。 | 具名 `reasonCode` + 可解释 `reasons[]` + 可复核 `facts` + `score`。 |
| 证据诚实性 | round 的 `method:'transcript'` 已经落在 journal 与 checkpoint 里（`bilibili-rounds.mjs:8-21`），但没有任何消费方必须把它说出来。 | 候选 body **强制**带“只读了字幕”的诚实标注；不允许把 transcript 秒数说成观看时长。 |

**本包不碰消费侧**：不 `submit`、不 `pumpShareDelivery`、不碰 contact、不碰 outbox。

---

## 2. 入口

```js
import {
  decideShare,
  produceCandidateForFinishedActivity,
  deriveBilibiliEvidence,
  createFinishedActivityShareHook,
  bilibiliVideoUrl,
  SHARE_REASON,
  REASON_CLASS,
  DEFAULT_DECISION_CONFIG,
} from './share-decision.mjs';

const decision = decideShare({ activity, evidence, config, now, history });

const produced = produceCandidateForFinishedActivity({
  cognitive, config, sessionId, scopeKey, activity, now, history,
});
```

---

## 3. 输入

### 3.1 `activity`（一条**活动行**的去标识投影，不是数据库行）

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `activityId` | string | `''` | 必填（幂等键的一半） |
| `kind` | string | `''` | 只接受 `'bilibili'` 之外的 kind 会被 `low-relevance`/`no-evidence` 拒；本包只对 `bilibili` 有专门证据解析 |
| `adapter` | string | `kind` | 诊断用 |
| `reality` | string | `'hypothetical'` | 只有 `actual_tool_activity` 可分享（与 `share-producer.mjs:36` 同一道闸） |
| `status` | string | `''` | 只有 `'done'` 可分享（runtime 词表见 `activities.mjs:58` 的 `ACTIVITY_STATUS`） |
| `endedAt` / `updatedAt` | number | `0` | 证据时刻（ms）。新鲜度用它，不用 `now` 兜底成“刚发生” |
| `consumedPrefix` / `totalUnits` | number | `0` | **B站语义是“确认看过的视频数与视频总数”，不是秒数**（`index.mjs:2362`、`p2.mjs:1286-1287`） |
| `artifactRef` / `artifactVersion` | string / number | `''` / `0` | 版本化产物证据（非 B站路径用） |
| `checkpoint` | object | `{}` | 可选。带 `bilibiliRound` 时是本包的主要证据来源（`activities.mjs:2665` 写入、`:791-796` 投影） |
| `bilibiliRound` | object | — | 可选。`checkpoint.bilibiliRound` 的平铺形式，两者都认 |

`bilibiliRound` 形状（`activities.mjs:2798-2809` 的 `settleBilibili` → `summarizeBilibiliRound`）：

```
{ roundId, status: 'completed'|'failed'|'unknown'|'quota-exhausted',
  watched: number,
  evidence: [ {kind:'watch', videoId:'BV…', consumedSeconds, method?:'transcript'},
              {kind:'report', written:true},
              {kind:'interaction', action, targetId, status} ] }
```

### 3.2 `evidence`（可选的**显式证据**，优先级高于 `activity.checkpoint`）

```
{ roundId, roundStatus, items: [ {kind, videoId, consumedSeconds, method} ], summary?, title? }
```

- `summary` / `title` **只能由调用方从真实来源传进来**（例如 provider 的轮次产物）。本模块**从不生成**视频标题、作者或内容摘要。
- 拿不到 `summary` 时，候选没有“观点”一行，并在 body 里写明“没有内容摘要，不编感想”。

### 3.3 `config`（只读；不缓存、不写）

| 路径 | 默认 | 作用 |
|---|---|---|
| `p2.share.enabled` | `false` | **总开关**。`!== true` ⇒ `share-disabled`，一行都不写（与 `share-producer.mjs:72`、`p2.mjs:1471` 同一判据） |
| `p2.share.shadow` | `false` | shadow：只决策、不建候选（灰度用，计划 §9.3） |
| `p2.share.maxPending` | `5` | 只用于诊断（真实队列上限由 runtime 在 `p2.mjs:1481` 强制） |
| `p2.share.decision.allowTranscriptOnly` | `true` | `false` ⇒ `transcript-only-blocked` |
| `p2.share.decision.minScore` | `0.5` | 分数门槛 |
| `p2.share.decision.minRelevantSeconds` | `180` | 字幕秒数低于它 ⇒ 相关性项为 0，通常落 `low-relevance` |
| `p2.share.decision.maxSharesPerDay` | `3` | 预算（只在 `history` 可用时判定） |
| `p2.share.decision.budgetWindowMs` | `86400000` | 预算窗口 |
| `p2.share.decision.freshnessTtlMs` | `7200000` | 证据 TTL |
| `p2.share.decision.requireContentSummary` | `false` | `true` ⇒ 无 summary 即 `low-relevance` |

### 3.4 `history`（幂等/预算/去重的**只读**来源）

接受三种形态，缺省 = `null`（“不知道历史”，**不是**“没有历史”）：

- 数组：`[{ activityId, candidateId, kind, status, createdAt, decidedAt }]`
- 对象：`{ list(): 同上数组 }`
- 对象：`{ candidates: 同上数组 }`

**`history === null` 时**：预算项标记 `unverified`（不判定为耗尽），去重只能靠 runtime 自己的
`(scope, activity_id, kind, status='pending')` 唯一性（`p2.mjs:1476`）。返回值里 `facts.history='unavailable'`，
不把“读不到”说成“没有”。

---

## 4. 输出

### 4.1 `decideShare()`（纯函数：无 IO、无时钟默认值、不改入参）

```js
{
  share: boolean,
  reasonCode: string,          // 具名码，见 §6
  reasons: [{ code, detail }], // 为什么是这个结论（多条，按重要性排序）
  score: number,               // 0..1，保留 3 位小数
  facts: {
    activityId, roundId, kind,
    videoIds: string[],        // BV 号（去重、保序、上限 5）
    links: string[],           // https://www.bilibili.com/video/<BV>，由 BV 拼，不猜
    method: 'transcript'|'unstated'|'mixed'|'none',
    methodLabel: string,       // 人话：'只读了字幕' / '记录里没有标注观看方式' / '字幕与其它方式都有'
    evidenceRef: string,       // 'round:<sha256(roundId)[0..16]>#<BV>' ；无 BV 时为 ''
    journalKey: string,        // sha256(roundId) 全串；调用方可据此核对 journal 目录名
    watched: number,           // round 里**去重后的视频数**
    consumedSeconds: number,   // 主要视频的字幕秒数
    roundStatus: string,
    interestMatch: number,     // 0..1
    freshness: { ageMs, ttlMs, band: 'live'|'aging'|'stale'|'unknown' },
    budget: { used, limit, windowMs, state: 'ok'|'exhausted'|'unavailable' },
    history: 'available'|'unavailable',
    reality, status,
  }
}
```

`decideShare` **只说要不要**。它不写任何东西，也不产生 `candidateId`。

### 4.2 `produceCandidateForFinishedActivity()`

```js
{
  ok: boolean,             // 目标是否成立：新建(true+created) 或幂等命中(true+duplicate)；拒绝(false)
  created: boolean,        // 本次**新写**了一行
  duplicate: boolean,      // 幂等命中：已经有一行，本次没有新增
  reasonCode: string,
  reasons,
  candidateId: string,     // created 或 duplicate 时有值
  activityId, roundId,
  facts,
  decision,                // decideShare() 的完整返回值（便于 shadow/审计落盘）
  note: string             // 固定声明：候选入库 ≠ 已进 contact ≠ 已送达
}
```

**`ok`/`created`/`duplicate` 的三态语义（不许混用）**：

| 情形 | ok | created | duplicate | 含义 |
|---|---|---|---|---|
| 新建成功 | `true` | `true` | `false` | 候选表里多了一行 |
| 幂等命中（历史已有） | `true` | `false` | `true` | 没新增，也没重发 |
| 任何拒绝 | `false` | `false` | `false` | 一条都没写 |

`ok === true` **永远不等于**“新发了什么”：调用方必须读 `created`/`duplicate`。
`note` 在三个分支里都带着“候选入库 ≠ 已进 contact ≠ 已送达”这句话。

---

## 5. 默认行为（fail-closed 的完整顺序）

先便宜的判断，每道都不抛：

1. `config.p2.share.enabled !== true` ⇒ `share-disabled`（terminal）。**此时连候选列表都不读**。
2. `cognitive` 没有 `createShareCandidate` ⇒ `runtime-not-mounted`（terminal）
3. `scopeKey` 为空 ⇒ `scope-required`（terminal）。**不从 `sessionId` 猜作用域**（那是 runtime 的职责，
   本包不发明第二套 scope 解析）
4. `activity.reality !== 'actual_tool_activity'` ⇒ `simulated-not-shared`（terminal）
5. **round 终态先于活动行 status 判**：round 不是 `completed` ⇒ `round-failed` / `round-quota-exhausted` /
   `round-unknown`。理由：`settleBilibili` 在 round 失败时会把活动行也标成 `failed`
   （`lib/activities.mjs:2802-2808`），先报 `not-done` 会把“这一轮为什么没成”的信息吞掉。
   `unknown` **不重试**：`bilibili-rounds.mjs:86-87` 的注释就是“子进程可能已经到了 B站但回话丢了”。
6. `activity.status !== 'done'` ⇒ `not-done`（等**新事件**，不轮询）
7. 无 `kind==='watch'` 证据：
   * round 说看过 `N>0` 个视频、但没有逐条 BV ⇒ `no-video-id`（**不猜 BV、不拼链接**）；
   * round 一个都没看过 ⇒ `no-evidence`（**report 不算观看证据**：`bilibili-rounds.mjs:9`）
8. BV 号不合法 ⇒ `no-video-id`
9. `method==='transcript'` 且 `allowTranscriptOnly===false` ⇒ `transcript-only-blocked`
10. 证据过期（`now - endedAt > freshnessTtlMs`）⇒ `stale`（terminal，对齐闸门 `expired`）；
    **没有注入 `now`** ⇒ 新鲜度 `unknown`，不判 stale（也不假装“刚发生”）
11. 历史里同 `(scopeKey, activityId, kind)` 已有候选 ⇒ `duplicate`（terminal，幂等）
12. 预算耗尽 ⇒ `budget-exhausted`（retryable：窗口过后可以）
13. 分数 < `minScore` ⇒ `low-relevance`（不编感想，terminal 对本证据快照）
14. 全过 ⇒ `share-ok`，`produce` 再写一行

**分数公式（可复核，测试钉住）**：

```
基础分 = 证据强度×0.50 + 内容强度×0.35 + 新鲜度×0.15
分数   = clamp01(基础分 + 0.20×兴趣命中)      // 兴趣只做**加分**
```

为什么兴趣是加分而不是重新分配权重：重新分配会让“兴趣命中”反而压低分数（原来满分的候选掉到 0.8），
得出“越相关越不该分享”的荒谬结论。

`shadow === true` 时：跑到第 14 步给出结论就返回（`created:false`, `shadow:true`），**永不**调
`createShareCandidate`；同时**也不读**候选列表（要看重复度就显式传 `history`）。

---

## 6. 失败码（具名，全部同步返回）

| reasonCode | 触发条件 | 本层分类 | `p2.mjs` 闸门表对齐 |
|---|---|---|---|
| `share-ok` | 全过 | 成功 | —（随后由 runtime/contact 判） |
| `share-disabled` | `p2.share.enabled !== true` | **terminal** | 同名在 `SHARE_GATE_TERMINAL`（`p2.mjs:1552`） |
| `runtime-not-mounted` | 无 `createShareCandidate` | terminal | `share-port-unavailable`（`p2.mjs:1556`，语义同） |
| `scope-required` / `invalid-input` / `activity-not-found` | 入参不全 | terminal | `scope-mismatch`（`p2.mjs:1557`，编程错误那类） |
| `simulated-not-shared` | `reality` 非真活动 | terminal | 无对应（生产者侧闸） |
| `not-done` | `status !== 'done'` | **retry-on-new-event** | 无对应 |
| `no-evidence` / `no-video-id` | 无 watch 证据 / BV 非法 | retry-on-new-event | 无对应 |
| `transcript-only-blocked` | 策略关掉纯字幕 | terminal（策略） | 无对应 |
| `low-relevance` | 分数不足 / 缺摘要（策略） | terminal（本证据快照） | 无对应 |
| `duplicate` | 历史已有同活动候选 | terminal | `dedupe`（`p2.mjs:1553`，语义同） |
| `stale` | 证据过期 | terminal | `expired`（`p2.mjs:1555`，语义同） |
| `budget-exhausted` | 窗口内已用满 | **retryable** | `quota` / `quota:global`（`p2.mjs:1527,1540`，retryable） |
| `round-unknown` | round 终态 unknown | terminal（不盲目重试） | 无对应（需人工/操作者） |
| `round-failed` / `round-quota-exhausted` | round 终态 failed / quota | terminal | 无对应 |
| `share-queue-full` | runtime 队列满（`p2.mjs:1481` 抛出） | **retryable** | 无对应（`p2.mjs` 未纳入闸门表，见审计) |
| `share-create-failed` / `share-create-threw` / `activity-read-failed` | 落库失败 | retryable（不是终态，但也不自动重试） | `share-sink-failed`（`p2.mjs:1533`，retryable） |

`REASON_CLASS` 是这张表的机器可读版本（`{ terminal, retry, gateCode }`）。

---

## 7. 作用域（scope）与时区

- 作用域**只从 `scopeKey` 取**（`u:<userId>|p:<personaId>|w:<worldId>`，`autonomy-share.mjs:43` 的正则）。
  本模块不做 session → scope 解析：分不清就 `scope-required`，**不读默认人物/默认世界**。
- 时区：本模块只做时间算术（`ageMs`、预算窗口），不渲染本地时间串；`now` 必须是注入的 epoch ms。
  渲染留给调用方（与 `life-facts.mjs` 的 `timeZone` 口径一致，不另造时钟）。

---

## 8. 幂等键（跨重启 / 事件重复 / 超时）

| 键 | 构成 | 用途 | 说明 |
|---|---|---|---|
| **主键** | `(scopeKey, activityId, kind)` | 一条活动最多一条候选 | 与 runtime 的 `p2.mjs:1476` 查重、JSONL sink 的 `dedupeKey`（`autonomy-share.mjs:94-97`）**同一个身份**。重复事件因此不可能长出第二条 |
| **决策键** | `dec-<sha256(scopeKey|activityId|evidenceRef)[0..12]>` | shadow / 审计落盘去重 | 只用于调用方写决策日志；本模块不写盘 |
| **证据键** | `round:<sha256(roundId)[0..16]>#<BV>` | 候选 `sourceRef` 与 `facts.evidenceRef` | `journalKey`（全串）与 `home/bili-duty/p2-rounds/<journalKey>/` 目录名一致，可核对但**不写绝对路径** |
| **预算键** | `(scopeKey, 窗口, count)` | 每日条数 | 由 `history.createdAt` 现算，不在本模块持久化 |
| **超时键** | 不做 | `status==='unknown'` | **不重试**：可能已经到了 B站、只是回话丢了（`bilibili-rounds.mjs:86-87`） |

跨重启：主键由**持久化的活动行 + history 回读**共同保证；事件重复：同一 `(scope,activityId)` 第二次进入
必然落在 `duplicate`；会话被杀：`history` 可由 runtime 的 `shareCandidates({sessionId})` 重建（接线建议 §10）。

---

## 9. 兼容方式（旧调用零变化）

- 旧调用 `companion_share_activity`（`share-producer.mjs`）**原样保留**，本模块不替换它；
  两者共享“真活动 + done + 有证据”三道闸，因此**同一活动不会有两套判据**。
- 新模块的默认值全部是“关/最保守”：`p2.share.enabled` 缺省 false、`shadow` 缺省 false、
  `allowTranscriptOnly` 缺省 true（与现有 journal 里的现实一致，否则生产候选永远是 0 且原因不可见）。
- `activity` 接受“只有 `checkpoint.bilibiliRound.watched`、没有逐条 evidence”的旧形状：
  此时给 `no-video-id`（**不猜 BV**），并在 `reasons` 写明“调用方需要把 round evidence 传进来”。
- 不新增表、不新增迁移、不改 `schema.sql`、不读真实数据库。

---

## 10. 接线建议（Lead 做，本包不动这些文件）

1. **`plugins/companion-runtime/lib/activity-adapters.mjs`**：`bilibiliAdapter` 已经
   `produces:['roundEvidence']`，不需要扩展；只要 `settleBilibili` 仍把 `bilibiliRound` 写进 checkpoint 即可。
2. **`plugins/companion-runtime/index.mjs` 的 `p2ActivityFinished`（`:2578` 注入处）**：在
   `memory/ingest-request` 之后追加一次本模块调用（同一 `scopeKey`、同一 `activityId`、同一 `at`）：

   ```js
   // inside p2ActivityFinished, after requestMemoryIngest(...)
   if (phase === 'finished' && kind === 'bilibili') {
     try {
       const decision = shareDecisionHook?.({
         scopeKey: scopeKeyValue, activityId, kind, reality,
         endedAt: Number(input.at) || Number(clock()),
         consumedPrefix: covered, totalUnits: total,
         evidence: {/* 由 provider 端口对同一 roundId 回读；见下 */},
       });
       diagnostics.lastShareDecision = decision?.reasonCode ?? 'none';
     } catch (error) { noteError('p2-share-decision-failed', ...); }
   }
   ```
3. **证据回读（推荐，且零副作用）**：`ports.runBilibili({ roundId, deadlineAt })` 对**已存在的 claim 目录**
   走 `readRound` 直接回读（`bilibili-rounds.mjs:63`），不会重跑一轮。用它取 `evidence[]`，
   再传给本模块。**不要**去轮询 `out/<day>.md` 的 Markdown 报告（那是独立值班路径的产物，不是观看证据）。
4. **`plugins/companion-runtime/lib/p2.mjs`**：
   - `pumpShareDelivery` 不需要扩展；
   - **需要修一处诚实性问题**（审计 §5.2）：JSONL 降级 sink 返回 `ok:true` 后，`p2.mjs:1794-1805` 把候选记成
     `queued` + `decision_reason='contact-queued'`，这在没有 contact 服务时是**假话**。
     建议：`accepted && answer.sink === 'jsonl'` ⇒ `status='queued'`,`decision_reason='local-only-jsonl'`，
     或者直接引入 `status='local-only'`（要改 `SHARE_STATES`/`share-diagnostics.mjs:30`，属于集成负责人的决定）。
5. **`plugins/companion-foundation/index.mjs`**：
   - 新增工具（可选）`companion_share_decide`（只读决策，不建候选），与 `companion_share_activity` 并列注册；
   - 生产者的 `history` 建议接 `cognitive.shareCandidates({sessionId, status:'all'})`
     （`index.mjs:2995-3000` 已存在），把 pending/withdrawn/expired 一起看，避免“抽出过的活动被复活”。
6. **`plugins/dsh-channel-qq/src/features/contact/share-port.ts`**（Lead 改，本包只读）：
   `propose()` 只传 `reason: title` + `evidenceIds:[candidateId]`（`:127-141`），起草端**没有任何解析器**
   能按 ID 回读正文（`draft-readers.ts:176-195` 的 `evidenceOf` 恒返回 `evidence:unresolved`）。
   最小修法：把 `candidate.body` / `candidate.sourceRef` 作为 `evidenceText` 内联进 `ProposeContactInput`
   （新增一个可选字段），并在 `draft-sections.ts` 渲染成“证据正文”分区。

---

## 11. 本包明确**不**做的事

- 不发送、不投递、不碰 contact/outbox/ledger、不读真实数据库、不写任何文件（除测试临时目录）。
- 不把 `queued` 说成 `sent`；`note` 字段固定声明“候选入库 ≠ 已发送 ≠ 已送达”。
- 不生成视频标题/作者/内容摘要（没有来源就不写）。
- 不补发迁移前的旧分享；`stale` / `duplicate` 保证关闭期积压不会自动复活。
