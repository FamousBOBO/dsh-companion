# E-life-facts 接口草案（生活事实聚合 / 渲染）

- 任务包：计划 §5 **E：真实生活状态与日程事实**
- 状态：**接口草案 + 离线实现（证据等级 E2）**。没有任何真实宿主、真实模型或真实数据库参与。
- 文件：`plugins/companion-foundation/life-facts.mjs`（聚合 + 渲染）、`life-facts.test.mjs`（合成用例）。
- 不修改既有文件。旧 `autonomy.mjs` 的 `lifeSection()` 原样保留，切换由集成负责人决定（见 §9）。
- 本文中的“生活事实”一律指**可从 runtime 只读接口读到的行**，不是记忆、不是计划推断、不是模型叙述。

---

## 1. 设计目标（对应计划 §5 E 的七条）

| 计划条目 | 本模块的做法 |
|---|---|
| E-1 聚合当前/暂停/最近完成/当日日程/下一段计划 | `facts.activities.current / paused / recentCompleted`、`facts.schedule.today / current`、`facts.schedule.next`、`facts.plan.slots / next`，逐条带来源与观察时间 |
| E-2 来源优先级与冲突如实显示 | 每条记录带 `source` + `sourceRank`；`facts.conflicts[]` 保留双方原文，不择一掩盖 |
| E-3 有界快照 + 强制刷新 | `bound / sessionId / scopeKey` 解析后按 `(scope,timeZone)` 缓存；`cacheTtlMs` 到期自动重读；`force:true` 跳过缓存；条数/字符上限 |
| E-4 显式状态词表 | `facts.state` 只用 `disabled / idle / scheduled / running / paused / completed / unknown / read-failed`；记录上另带合同原生 `status` |
| E-5 “过期计划 ≠ 已完成” | 结束时间经过 ⇒ `window-ended`（唯一新增的**记录级**词，不是顶层状态）；`completed` 必须有执行证据 |
| E-6 作用域不可解析 ⇒ unknown | 全部读取返回 `unbound` ⇒ `state:'unknown'`、`reasons:['scope-unresolved']`，绝不回落到默认人物/默认世界 |
| E-7 时区统一 | 所有窗口/时间串按 `timeZone`（IANA，默认 `Asia/Shanghai`）解释；跨午夜、跨天、改期由“窗口包含 now”的判定处理，不靠日期字符串相等 |

---

## 2. 入口

```js
import { collectLifeFacts, renderLifeFacts } from './life-facts.mjs';

const facts = collectLifeFacts({ runtime, bound, sessionId, timeZone, now, cacheTtlMs, force });
const text  = renderLifeFacts(facts);   // 可能为 ''（facts 无效）
```

### 2.1 输入（`collectLifeFacts`）

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `runtime` | object \| null | `null` | 认知运行时。只调用 4 个既存只读入口：`p2Status`、`listActivities`、`listPlan`、`todaySchedule` |
| `bound` | object | `null` | 宿主解析出的身份绑定（`userId` / `personaId` / `worldId`）。**优先级最高**，与 runtime `resolveBinding()` 一致 |
| `sessionId` | string | `''` | 会话 id。仅当没有 `bound` 时才可能被 runtime 解析成身份 |
| `scopeKey` | string | `''` | 已持久化的 scope key（`u:…|p:…|w:…`）。给了就直接透传，跳过 session 解析 |
| `timeZone` | string | `'Asia/Shanghai'` | IANA 名。非法名 → 回落默认并记 `timezone-invalid`，**不静默** |
| `now` | number | `Date.now()` | 观测时刻（epoch ms）。测试必须显式注入 |
| `cacheTtlMs` | number | `60000` | 快照 TTL。`0` 表示不缓存 |
| `force` | boolean | `false` | 用户追问进度/缓存到期 → 强制重读，忽略缓存 |
| `receiptLookup` | function \| null | `null` | 可选注入：`activityId => receiptId`。默认 null ⇒ 回执只能由**活动行证据**推导（见 §3.4） |
| `maxActivities` | number | `20` | 读回的活动行上限（runtime 本身最多返回 20） |

作用域传递顺序（**与 runtime 相同**，不发明第二套）：`scopeKey` 显式给出 → 直接用；否则 `{ bound, sessionId }` 合并后交给 runtime，runtime 内部 `bound ?? binding ?? scope` 先命中 `bound`，`sessionId` 只在没有 `bound` 时参与解析。

### 2.2 输出（`collectLifeFacts` 返回值）

```
{
  ok: boolean,                    // state 不属于 {unknown, read-failed} 且至少有来源可用
  state: 'disabled'|'idle'|'scheduled'|'running'|'paused'|'completed'|'unknown'|'read-failed',
  partial: boolean,               // 至少一个来源成功、至少一个失败
  scope: {
    resolved: boolean,            // 作用域是否能解析（依据是 runtime 自己是否返回 unbound）
    via: 'scopeKey'|'bound'|'sessionId'|'none',
    signature: string,            // 缓存/记录用的作用域指纹；bound 用 u:/p:/w:，否则 sessionId，否则 ''
    boundProvided, sessionIdProvided, scopeKeyProvided: boolean,
    conflict: boolean,            // bound 与 sessionId 指向不同世界/人物
    otherSignature: string,       // 另一个输入解析到的指纹（未能解析则为 ''）
    reasons: string[]             // 'scope-unresolved' / 'scope-conflict' / 'session-unresolved' …
  },
  timeZone: string,
  localDate: 'YYYY-MM-DD',        // now 在 timeZone 里的本地日期
  dayWindow: { startAt, endAt },  // 本地日窗口（跨午夜按本地日历，不是 UTC 日）
  observedAt: number,
  cached: { hit: boolean, forced: boolean, ageMs: number, ttlMs: number, refreshedAfterExpiry: boolean, reason: string },
  capabilities: { activitiesEnabled, planningEnabled, activitiesState, planningState, mounted, agendaEnabled, agendaState },
  activities: {
    current: record|null,         // 只等于 running[0]；paused 不冒充 current
    paused:  record|null,         // paused[0]
    recentCompleted: record[],    // 有完成证据的活动，按 observedAt 倒序（时间未知的排最后）
    others: record[],             // 不在 current/paused/recentCompleted 里的行（failed/abandoned/done-无证据…）
    counts: { read, running, paused, completedEvidenced, completedUnevidenced }
  },
  plan:  { available, planId, day, version, status, summary, slots: record[], current, next, endedToday: record[], changedToday: record[] },
  schedule: { available, state, today: record[], current, next },
  conflicts: [ { code, sources: string[], detail, a, b } ],
  reasons: string[],             // 机器可读原因码，去重、有界
  failures: [ { source, code, message } ],
  counters: { records, windowEnded, completedEvidenced, completedUnevidenced },
}
```

`freshness` 的算法（每条记录 `freshness: 'live'|'aging'|'stale'|'unknown'` + `freshnessAgeMs`）：

| band | 条件 | 渲染含义 |
|---|---|---|
| `live` | `0 ≤ now - observedAt ≤ cacheTtlMs` | 可以说“现在/刚刚” |
| `aging` | `≤ 15 × cacheTtlMs` | 必须带时刻说 |
| `stale` | `> 15 × cacheTtlMs` | 只能说“上一次记录”，不得说“现在” |
| `unknown` | `observedAt` 不是有限正数 | 无法判断新旧，不做时效断言 |

`observedAt` 来源：活动行 `updatedAt`、计划槽 `startAt`、日程 occurrence `scheduledAt`。`0` 一律当 `unknown`。

### 2.3 记录（record）逐字段

| 字段 | 说明 |
|---|---|
| `kind` | `'activity'` \| `'plan-slot'` \| `'agenda-occurrence'` |
| `id` | `activityId` / `slotId` / `occurrenceId` |
| `source` | `'p2-activity'` \| `'p2-plan'` \| `'h1-agenda'` |
| `sourceRank` | `1` 活动（执行事实）> `2` 日程（只证明计划）> `3` 长期记忆（本模块**不读取**，仅保留位次语义） |
| `scope` | 记录所属作用域指纹（`facts.scope.signature`） |
| `observedAt` | runtime 行自带时间戳（见 §2.2） |
| `status` | **合同原生**状态：活动 `running/paused/done/failed/abandoned`；槽 `planned/started/done/skipped/expired`；occurrence `scheduled/due/dispatched/skipped/cancelled/expired` |
| `state` | 本模块词表：`running/paused/scheduled/completed/window-ended/unknown/disabled`（记录级不使用 `idle` / `read-failed`） |
| `lifecycleReason` | 为什么落到这个 `state`，例如 `in-window-not-started`、`window-ended-without-activity`、`done-with-evidence`、`done-without-evidence` |
| `receiptRef` | `''` \| `'activity:<id>'` \| `'receipt:<id>'` |
| `receiptSource` | `'activity-evidence'` \| `'receipt-row'` \| `'none'` |
| `evidence` | `{ kind:'consumed'\|'artifact'\|'none', consumed, totalUnits, artifactRef, artifactVersion }` |
| `freshness` / `freshnessAgeMs` | 见 §2.2 |
| `title` / `activity` | 有界文本（≤ 60 字符，空白折叠） |
| `window` | `{ startAt, endAt, localDate, localStart, localEnd }`，`local*` 按 `timeZone` |
| `carriedOver` | 窗口跨本地午夜且当前仍在窗口内（`startAt` 属于前一天） |

---

## 3. 判定规则（关键口径）

### 3.1 顶层 `state` 的优先级（与 `assembleFacts()` 的实现顺序一致）

```
开关/挂载事实为关闭                → disabled         （在读取任何活动之前就返回，且不报 idle）
读取失败且一条记录都没拿到          → read-failed
作用域无法解析 / bound≠sessionId   → unknown          （scopeUnresolved 或 scopeConflict）
读取失败但仍有部分记录            → read-failed （partial:true，可读部分照实给出）
有 running 活动                  → running
只有 paused 活动                 → paused
窗口内/今天有未到点的计划或日程      → scheduled
有带执行证据的完成                → completed
以上都没有                       → idle
```

`disabled` 只由**开关事实**触发：`runtime` 缺失、`activities.enabled !== true` 且 `planning.enabled !== true`、
或任一读取返回 `activities-disabled` / `planning-disabled` / `agenda-disabled` / `runtime-off` /
`runtime-disabled` / `runtime-stopped` / `runtime-disposed` / `p2-not-registered`。关闭状态绝不回落成 `idle`。

### 3.2 “过期计划 ≠ 已完成”（E-5）

- 槽 `endAt <= now` 且状态仍是 `planned`/`started` ⇒ 记录 `state:'window-ended'`、
  `lifecycleReason:'window-ended-without-activity'`；`skipped` ⇒ `'slot-skipped'`；`expired` ⇒ `'slot-expired'`。
- 渲染固定措辞（逐字来自 `renderLifeFacts`）：
  `计划窗口已结束、但没有执行证据：<title>（<localStart>–<localEnd>）——只能说这个时间段过去了，不能说做过（<lifecycleReason>）`。
  整段文本**不出现**“已做/已完成/刚看完/做完了”这类断言（合成集统计用例把这条正则当断言跑）。
- 槽 `status === 'done'` **本身不是证据**：必须有同 title 的活动行且该行 `state==='completed'`（§3.4），
  否则同样落到 `window-ended`，`lifecycleReason` 为 `'slot-done-without-matching-evidence'`
  或 `'slot-done-without-activity-evidence'`。
- 活动行 `status==='done'` 但 `consumed==0` 且无 `artifactRef/artifactVersion` ⇒ 记录 `state:'unknown'`、
  `lifecycleReason:'done-without-evidence'`，**不进** `recentCompleted`，只留在 `others`。
- 旧 `lifeSection()` 把 `slot.endAt <= now || slot.status === 'done'` 一律计入“今天已结束 N 段”，
  这正是计划 §2.3 疑点 4；本模块不复用该判定。

### 3.3 来源冲突（E-2）

`facts.conflicts[]` 可能出现的码：

| code | 条件 |
|---|---|
| `scope-conflict` | `bound` 与 `sessionId` 各自解析出的 planId / 活动 id 集合不同 |
| `activity-plan-mismatch` | 有 running/paused 活动，且窗口内计划槽标题与之不匹配（两者都保留） |
| `agenda-activity-mismatch` | 窗口内有 agenda occurrence，但活动行不同（两者都保留） |
| `running-count-without-row` | `p2Status.activities.running > 0` 但 `listActivities` 没有任何 running 行 |
| `plan-slot-double-booked` | 两个槽的窗口互相重叠 |

冲突时的渲染：逐条列出“来源 A 说 …；来源 B 说 …；两者不一致”，**不合并成一句话，也不只保留一个**。

### 3.4 完成证据（`completed` 的必要条件）

runtime 自己的口径（`companion-runtime/lib/p2.mjs` 的 `recordExperience`）是：`consumed_prefix > 0` 或 `artifact_hash !== '' && artifact_version > 0`，且存在 `operation IN ('finish','step') AND ok=1` 的回执。本模块**没有**回执表的只读入口（`p2_activity_receipts` 未通过公开 API 暴露），因此：

- `evidence.kind` 用 `consumed` / `artifact`（与 runtime 同一判据的部分）；
- `receiptSource:'activity-evidence'`、`receiptRef:'activity:<id>'`，并在文档/报告里明确写“这是活动行证据的引用，不是回执表主键”；
- 注入 `receiptLookup` 后可以升级为 `receiptSource:'receipt-row'`、`receiptRef:'receipt:<id>'`；
- `status==='done'` 但无证据 ⇒ `state:'unknown'`、`lifecycleReason:'done-without-evidence'`，**不进** `recentCompleted`。

### 3.5 作用域（E-6）

- 只有 `bound`（含 `userId`）、`sessionId`（runtime 能解析）、或显式 `scopeKey` 三者之一可用时才读数据。
- 作用域的判定**只由带作用域的读接口**（`listActivities` / `listPlan`）负责。这一点是实测出来的，不是推断：
  `runtime.todaySchedule()` 在 `agenda.enabled=false` 时于 `index.mjs:1891 → listSchedule` 里**先**短路返回
  `{ok:true, enabled:false, items:[], occurrences:[]}`，**根本没走到 `scopeOf(input)`**。如果拿它的空结果当“作用域已解析”，
  没传 bound 的调用方就会把默认世界的沉默读成“她在空闲”——正是 E-6 禁止的回落。因此：
  `scopeUnresolved = !(活动读 ok || 计划读 ok) && (活动读 unbound || 计划读 unbound)`。
  回归用例：`议程关闭不能替作用域背书`。
- 全部 unbound ⇒ `state:'unknown'`、`reasons:['scope-unresolved']`，`activities` / `plan` / `schedule` 全空，渲染明确写“无法确定属于谁”。**绝不**用 `DEFAULT_WORLD` / 默认 persona 去补一个状态。
- `bound` 与 `sessionId` 同时给且解析到不同作用域 ⇒ 以 `bound` 读取（与 runtime 行为一致）但 `scope.conflict=true`、顶层 `state:'unknown'`，渲染两边并列。

### 3.6 时区（E-7）

- 全部窗口判定用“**now 是否落在 [startAt, endAt) 内**”，不用日期字符串比较，因此跨午夜天然正确。
- `facts.localDate` / `dayWindow` 用 `timeZone` 的本地日历计算：本地午夜由 `Intl` 的 offset 迭代两轮求解（纯算术，无依赖、无 IO）。
- 槽/occurrence 的 `window.localDate` 由**各自的 `startAt`** 推出；若窗口跨午夜，`carriedOver:true`，渲染写“昨天 23:30 起，现在仍在窗口内”。
- 计划改期（同一 `slotId` 的 `startAt` 变化）：`plan.changedToday[]` 收集本次读到的窗口与 `dayWindow` 相交但 `startAt` 已不在原日期的槽，渲染标注“已改期”。
- 非法 IANA 名 ⇒ 回落 `Asia/Shanghai` 并 push `timezone-invalid`。

---

## 4. 失败码

| 码 | 来源 | 顶层影响 |
|---|---|---|
| `runtime-not-mounted` | `runtime` 缺失/非对象 | `disabled` |
| `not-mounted` | 某个入口不是函数 | `read-failed`（该 source 记为 failure） |
| `call-threw` / 具体 `error.code` | 入口抛异常 | `read-failed` |
| `invalid-response` | 入口返回非对象 | `read-failed` |
| `async-unexpected` | 入口返回 thenable（本模块是同步的） | `read-failed` |
| `unbound` / `scope-invalid` | 作用域没解析 | `unknown` |
| `activities-disabled` / `agenda-disabled` / `runtime-off` / `runtime-disabled` / `runtime-stopped` / `runtime-disposed` / `p2-not-registered` / `planning-disabled` | 开关/挂载 | `disabled` |
| `timezone-invalid` | 非法 IANA 名 | 不改状态，记 reason |
| `cache-refresh-failed` | 缓存到期后重读失败 | `read-failed` + `cached.reason` |

模块承诺：**不抛异常给调用方**（所有入口 try/catch），**不写任何文件**，**不发消息**，**不调模型**。

---

## 5. 默认行为

- 无 runtime：`state:'disabled'`，`render` 为“未启用”短句，不描述任何活动。
- 有 runtime 但无 bound/sessionId：`state:'unknown'`，`render` 说明无法确定作用域。
- 有作用域且安静：`state:'idle'`，`render` 说明“没有正在执行的活动、没有到点计划、今天没有带证据的完成”。
- 缓存：TTL 内直接复用（零 runtime 读取）；到期自动重读；`force:true` 无条件重读；`cacheTtlMs:0` 关闭缓存。
- 渲染上限：12 行正文、900 字符、单条标题 60 字符；超限截断并以 `…` 结尾。

## 6. 开关

本模块自身**没有**独立开关（纯只读，无副作用）；实际生效范围由 runtime 的 `p2.planning.enabled` / `p2.activities.enabled` / `agenda.enabled` 决定，模块只如实转述。集成时的切换开关建议由负责人在 `index.mjs` 侧加（`life facts on/off`，默认 off 直到灰度）：见 §9。

## 7. 兼容与切换建议

- 旧 `lifeSection()` 保持原样，本模块不改它、不引用它的内部判定。
- 行为差异（切换时会改变的可见文本）：

| 场景 | 旧 `lifeSection()` | 新 `lifeFacts` |
|---|---|---|
| 无 bound（当前 `companion:life` 的实际调用） | 以 `scopeKey:null` 读库 ⇒ 恒定“今天还没有正式安排”“当前没有进行中的活动”，且打印别的 scope 的预算 0/N | `state:'unknown'`，明确写“无法确定属于谁” |
| 计划窗口已过 | 计入“今天已结束 N 段” | `window-ended`，“只能说时间过去了” |
| `activities.enabled=false` | 落入 catalog 的兜底句“自主规划与活动当前未启用” | `disabled`，且不再混同 idle |
| 读取失败 | 静默返回 `''`，落到同一句兜底 | `read-failed`，带码 |
| 跨世界 `bound`≠`sessionId` | 无感（runtime 只按 bound 读） | `scope-conflict` 并列显示 |

切换建议（三步）：① shadow：同时计算新旧文本，只记录差异（不注入）；② 灰度：`companion:life` 换成 `renderLifeFacts(collectLifeFacts(...))`，保留旧文本作为 fallback 一个版本；③ 收口：删旧路径并更新 `docs/prompt-layers` 说明。回滚只需把 Section 的 `text` 函数换回 `lifeSection(cognitive)`。

## 8. 证据等级

- 本文与模块：**E1（实现 + 静态检查）**。
- `life-facts.test.mjs`：**E2（合成纯函数/故障测试）**，全部 fixture 在 `os.tmpdir()` 内合成，不读任何真实数据库、真实活动或真实记忆。
- 未执行：真实宿主装载、Hook 接线、真实模型、真实通道（E3–E5 全部**未执行**）。离线通过**不等于**端到端可用。

## 9. 集成负责人接线点（本模块不自己改 `index.mjs`）

1. `companion:life` System Section（`index.mjs:205-215`）：把 `lifeSection(cognitive)` 换成
   `renderLifeFacts(collectLifeFacts({ runtime: cognitive, bound: <当前 bound>, sessionId: <sessionIdOf(exec)>, timeZone: configForP2(root).timeZone, now: Date.now() }))`。
   注意该 Section 的 `text` 是**无参**闭包，当前拿不到 `bound` —— 这正是疑点 3 的来源，需要先让 Section 能拿到宿主绑定（或改为在 `agent/pre-step` 里注入，保持“只有一个注入入口”）。
2. `companion_life_status` 工具（`index.mjs:655-656`）：保持传 `sessionId`，并追加 `facts` 字段（`collectLifeFacts({ runtime: cognitive, sessionId: sessionIdOf(exec), force:true })`），使工具与自动快照共用同一事实服务。
3. import 追加：`import { collectLifeFacts, renderLifeFacts } from './life-facts.mjs?v=0.1.0';`（带版本 query，与本仓库既有 import 风格一致）。

### 9.1 推荐做法：挪到既有的 `agent/pre-step`，不在 Section 里猜绑定

`companion:life` 的 `text` 闭包没有 `exec`，在它内部**永远拿不到** `bound`；而本仓库已经有一个能拿到绑定的入口：
`index.mjs:433-553` 的 `ctx.on('agent/pre-step', …, { prepend: true })`，其中 `index.mjs:438-439` 已经是
`const sessionId = agent.session.id; const bound = identity.resolve(sessionId);`，并且 `index.mjs:505` 的衣柜
`collectLifeEvidence({ runtime: cognitive, bound, sessionId, now })` 就是同一模式的先例。计划 §5 E-3 要求
“不引入第二个对话注入入口”，所以正确的位置是**复用这一段**，不是新加 hook：

```js
// index.mjs:518 之后（wardrobeText 计算完、promptEngine 之前），同一段 pre-step 内：
let lifeFactsText = '';
try {
  lifeFactsText = renderLifeFacts(collectLifeFacts({
    runtime: cognitive, bound, sessionId, now: Date.now(),
    timeZone: configForP2(root).timeZone, cacheTtlMs: 60_000,
  }));
} catch { lifeFactsText = ''; }
```

```js
// index.mjs:543：把 lifeFactsText 并进 finalInjected（放在 wardrobe 之前，因为“在做什么”比“穿什么”更硬）
const finalInjected = injectedWithCare
  + (lifeFactsText ? '\n' + lifeFactsText : '')
  + (wardrobeText ? '\n' + wardrobeText : '')
  + (promptText ? '\n' + promptText : '');
```

```js
// index.mjs:545-551：sections 里同步登记，便于统计与排查
...(lifeFactsText ? [{ name: 'companion-life-facts', text: lifeFactsText }] : []),
```

```js
// index.mjs:205-215：Section 降级为“不注入任何状态”的静态真值约束（否则会出现两份生活状态互相矛盾）
ctx.systemPrompt.section({
  name: 'companion:life', order: 62, interpolate: false,
  text: '【今天的生活】生活状态只在当轮快照（【今天的生活·事实快照】）里出现；没有那一段就说明这次没读到，说不清楚就是说不清楚。计划只是计划：没有执行证据的计划窗口结束，只能说那个时间段过去了，不能当成做过。',
});
```

```js
// index.mjs:655-656：工具与自动快照共用同一个事实服务
register('companion_life_status', '…', {}, (_args, _bound, exec) => ({
  ...(cognitive ? cognitive.p2Status({ sessionId: sessionIdOf(exec) }) : cognitiveOr({ planning: { enabled: false, state: 'off' }, activities: { enabled: false, state: 'off' } })),
  lifeFacts: collectLifeFacts({ runtime: cognitive, sessionId: sessionIdOf(exec), force: true }),
  reading: autonomyPorts?.describe() ?? null,
}));
```

顺序建议：先 shadow（`lifeFactsText` 只进日志不进 prompt，比较新旧文本差异），再灰度（进 `finalInjected` 并保留
`lifeSection` 作 fallback），最后收口删旧路径。

## 10. 疑点 3 判定（实测，非推断）

问题：`companion:life`（`index.mjs:211`，调用 `lifeSection(cognitive)` **不传 bound**）到底读了谁的世界？

结论：**它谁的世界都没读到 —— 在 `scopeKey:null` 上读库，得到的是一个恒定空投影 + 恒定为 0 的默认预算。**

证据（合成临时 DB，`os.tmpdir()`，不含任何生产数据；用真实 `mountRuntime`，配置 `mode:active`、
`p2.planning/activities.enabled=true`、`agenda.enabled=false`，scope 行 `u:owner|p:bot|w:world:a`
含 1 个 `running` 活动 `act-x` 与 1 个已过期 `planned` 槽 `slot-past`）：

| 调用 | 结果 |
|---|---|
| `p2Status({})` | `plan:null`、`running:0`、`counts` 全 0（`p2.mjs:1976` 的 `if (scopeKey)` 分支没进） |
| `p2Status({ bound })` | `planId:'plan-x'`、`slots:1`、`running:1` |
| `listActivities({})` | `{"ok":false,"code":"unbound"}` |
| `lifeSection(runtime)`（`index.mjs:211` 原样） | `【今天的生活】\n- 今天还没有正式安排（…）\n- 当前没有进行中的活动\n- 自主预算：请求 0/64，输出 token 0/24000\n这些是真实状态；…` |
| `lifeSection(runtime,{ bound })` | `【今天的生活】\n- 接下来：合成写作槽（write） 03:59–04:59\n- 未完成待续：1 段\n- 正在做：write · 合成写作（已处理 4/10）\n…` |
| `companion_life_status`（`p2Status({sessionId})`） | 与 `{bound}` 相同（`resolveBinding` 走 `identity.resolve(sessionId)` → 同一 scope） |

三个可以直接写进结论的事实：

1. **renders 恒定文本**。无 scope 时 `lifeSection` 的三行都由“查不到”组成：`status.planning` 为真但 `plan=null` ⇒
   “今天还没有正式安排”；`activities.running=0` ⇒ “当前没有进行中的活动”；`budget.status({scope:null})`
   （`budget.mjs:88-91` 的 `used = scope ? usage(...) : 0`）⇒ 恒为 `0/64`、`0/24000`。
2. **它连自己该读谁都不知道**：`listActivities({})` 返回 `unbound`，说明 runtime 明确拒绝了这次读取；`lifeSection`
   把这个失败吞成 `''`（`autonomy.mjs:253` 的 `catch { return ''; }`）再退回空列表，“读不到”被渲染成“没有”。
3. **同一份真实状态，工具能看到、Section 看不到**。这一条是计划疑点 3 的实质：不是“读了同一个人的另一个世界”，
   而是“Section 谁都没读，工具读了主人”。

顺带确认（不是 plan 疑点，但影响接线）：`p2Status({})` 之所以不报错，是因为 `status()` 内部对 `scopeKey` 用了
`if (scopeKey)` 保护（`p2.mjs:1976`），所以“缺作用域”在 P2 status 里**不会**变成 `unbound` 错误码——这正是
`lifeSection` 无法区分“没作用域”与“真空闲”的机制原因。新模块把这条差异显式化：`state:'unknown'` + `scope-unresolved`。

## 11. 诚实边界

- 本模块的 `receiptRef` 在默认配置下是 **`activity:<activityId>`**（活动行证据的引用），**不是**
  `p2_activity_receipts.receipt_id`：回执表没有公开只读入口。需要真回执主键时由接线方注入
  `receiptLookup: activityId => receiptId`，`receiptSource` 会变成 `'receipt-row'`。
- 时区算术与 `companion-runtime/lib/agenda-time.mjs` 做过对拍：5 个时区 × 8 个瞬时（含 DST 与会话跨日），
  `startOfLocalDay` / 本地日期 **0 处不一致**。这仍是离线对拍（E2），不是宿主实测。

