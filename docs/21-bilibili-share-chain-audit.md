# B站观看 → 分享 全链路断点审计（任务包 F）

- 计划：`next-stage-autonomy-grounding-plan-20261114.md` §5 **F**
- 证据等级：**E0（审计，只读）+ E1（模块实现）+ E2（合成离线测试）**。真实数据库行数、真实
  journal 内容、真实发送**均未读取/触发**；`E5` 只能由操作者显式触发。
- 审计基线：worktree `dsh-55f1cc85-7db6`（基于 `ecde3ed`）。行号以本 worktree 为准。
- 数据不写入本报告：不出现真实视频标题、真实字幕、真实用户数据；BV 号只在需要说明格式时用
  合成样例（`BV1xx411c7mD` 之类），不作为事实。

链路（计划 §5 F 原文）：

```
provider ready → round → watch evidence → settle activity → share decision → candidate → contact gate → draft → outbox → receipt
```

---

## 1. 逐段核对表

| # | 段 | 现状 | 证据（文件:行号） | 断？ |
|---|---|---|---|---|
| 1 | **provider ready** | runtime 通过进程级 Symbol 注册表取“就绪的 provider”。**本仓库内没有任何生产代码 publish 这个注册表**；publish 在外部模块 `dsh-bili-scroll`，而当前装在本机 profile 的那份 2.4.0 副本里**不含**该 publish 代码（另一份备份副本含）。取不到 ⇒ `null` ⇒ `available()===false` ⇒ 能力目录报 `provider-not-ready`，活动照旧可以被规划、然后必然执行失败。 | 消费方 `plugins/companion-runtime/lib/bilibili-provider.mjs:5`（`Symbol.for('dsh.companion.bilibili.providers.v1')`）、`:10`（`realpathSync(stateDirectory)` 作为键）、`:11`（`entry?.ready() === true ? entry : null`）、`:24`（`run.available`）；发布方：全仓 `grep` 只有 `plugins/companion-runtime/test/bilibili-provider.test.mjs:11` 一处（测试）；外部模块 `data/home/profiles/companion/node_modules/dsh-bili-scroll/index.js`（2.4.0，211655 字节）**零命中** `dsh.companion.bilibili.providers`；带 publish 的副本在 `data/backups/pnpm-store-repair-20261113/node_modules/dsh-bili-scroll/index.js`（213810 字节）`:1996`（`??= new Map()`）、`:1997-2019`（provider 对象）、`:2020`（`providers.set(providerKey, provider)`）、`:2021-2023`（卸载时 delete）。失败可见性：`lib/capabilities.mjs:37`、`lib/activity-adapters.mjs:967-971`、`index.mjs:2271-2272`。 | **断（P0）** |
| 2 | **round** | runtime 侧纯函数 `createBilibiliRounds` 完整：claim 目录 = `p2-rounds/<sha256(roundId)>`，单飞（已存在即回读）、deadline、abort、终态行。执行体由 provider 提供。 | `lib/bilibili-rounds.mjs:54-92`（`:60` 目录键、`:63` 已存在即 `readRound`、`:74-75` 超时/取消、`:80` 逐条证据 append、`:89` 终态 append）；`lib/p2.mjs:689-706`（`kind==='bilibili'` 分支：`roundId = row.activity_id`，`:693` 只有 `reality==='actual_tool_activity'` 且有窗口才调用 provider）。 | 不完整（依赖第 1 段） |
| 3 | **watch evidence** | 证据三型：`watch` / `report` / `interaction`。`watch` 硬要求 BV 正则 + `consumedSeconds>0`；`method` **只在等于 `'transcript'` 时被保留**。`report` 只是“写了报告”，**不能当观看证据**。 | `lib/bilibili-rounds.mjs:8-21`（`:9` report、`:10-14` watch、`:13` method 条件保留）、`:23-30`（`summarizeBilibiliRound` 只统计 watch 的**去重视频数**）。 | 通（数据在） |
| 4 | **settle activity** | `settleBilibili` 把 round 摘要写进 checkpoint（`bilibiliRound`），`completed → finished`，其它 → `failed` 并带 `bilibili-<status>` 原因。**注意：B站的 `consumed_prefix`/`total_units` 不随之更新**（只有 `progress` 分支才写），所以 B站活动行的 `consumedPrefix` 通常为 0，真正的事实只在 `checkpoint.bilibiliRound.watched`。 | `lib/activities.mjs:2798-2809`、`:2665`（`checkpoint.bilibiliRound = round`）、`:791-796`（公开投影只给 status/watched）；`consumed_prefix` 写入点只有 `:857-859`（start，bilibili 传 0）与 `:972`（progress，bilibili 不会走）；消费方另按 watched 计数：`index.mjs:2362`、`lib/p2.mjs:1286-1287`、`:1260-1261`。 | 通，但**字段语义陷阱** |
| 5 | **share decision** | **不存在**。全仓没有“要不要分享”的判据模块；`companion_share_activity` 由模型自己决定标题与正文，`p2_share_candidates` 只有 `status` 与 `decision_reason`。 | `plugins/companion-foundation/share-producer.mjs:63-127`（只有工具入口）；`lib/p2.mjs:1470-1487`（`createShareCandidate` 只校验开关/scope/标题，不判断相关性）。 | **断（P0）** |
| 6 | **candidate（生产者）** | 唯一生产调用链是模型显式调用工具：`register(SHARE_TOOL_NAME …)` → `shareCandidateForActivity` → `cognitive.createShareCandidate`。活动完成钩子只写记忆，不产候选。 | `plugins/companion-foundation/index.mjs:672-685`（注册）、`:19`（import）；`share-producer.mjs:106`（唯一生产调用点）；`activities.mjs:2721-2745`（`onFinished` 调用点）→ `index.mjs:2578`（注入 `p2ActivityFinished`）；`index.mjs:2476-2505`（该钩子只 `requestMemoryIngest`，**没有** `createShareCandidate`）。 | **断（P0）** |
| 7 | **contact gate** | 闸门存在且分类表完整（retryable / terminal）。候选投递由 runtime 泵驱动，`queued` 只代表“进了 contact 的候选池”。 | `lib/p2.mjs:1644-1857`（`deliverShareCandidates`）、`:1525-1550`（retryable）、`:1551-1558`（terminal）、`:1794-1805`（accepted ⇒ `queued` + `contact-queued`）、`:1860-1884`（`pumpShareDelivery`，timer `:1454`）；contact 侧闸门 `plugins/dsh-channel-qq/src/features/contact/gate.ts`、`share-port.ts:143-159`。 | 通（但 `queued` 语义见 §5） |
| 8 | **draft（起草上下文）** | QQ 侧 `propose()` **只传标题**（`reason: title`）与候选 id（`evidenceIds:[candidateId]`），没有 body/sourceRef 字段可传；起草端**没有任何解析器**能按 id 回读正文。因此“候选正文 → 起草提示词”这一段**断开**，草稿只能看到一句被截到 300 字的标题。 | `plugins/dsh-channel-qq/src/features/contact/share-port.ts:127-141`（propose 入参）、`:30-33`（`ShareCandidate.body/sourceRef` 形状存在但**未使用**）；`types.ts:249-262`（`ProposeContactInput` **没有** body/sourceRef 字段）；`service.ts:83-105`（`candidateOf` 只落 reason/evidenceIds，`reason` 截 300 字）；`draft-readers.ts:176-195`（`evidenceOf`：`evidenceIds` **无解析器**，恒给 `evidence:unresolved`，退化到“最近一条对话”）；`draft-context.ts:18`（同一结论的表格行）。 | **断（P1）** |
| 9 | **outbox** | QQ 侧 outbox 有完整状态机（`pending→running→submitted→confirmed`，旁支 `deferred/failed/unknown`），无新发送路径。 | `types.ts:118-129`（状态机注释）、`sender.ts:279-280`（`submitted` + `receipt:{kind:'none'}`）、`attempt.ts:83-105`（投递行）、`attempt.ts:202`（`confirmedAt` 只在 confirmed 时写）、`transitions.ts:45-62`（过期不补发）。 | 通（未在本轮触发） |
| 10 | **receipt（真实送达）** | runtime 库里**没有**“对方收到了”这个事实：`share-diagnostics.mjs` 明确给 `sent:null / not-wired`，`queued` 之后 contact 侧 6h TTL 到期会标 expired，而 runtime 仍停在 `queued`。QQ 侧的真实送达只在 contact 自己的投递账本里。 | `plugins/companion-foundation/share-diagnostics.mjs:94-98`、`:184-190`、`:192`（summary 里明确写“真实送达 unknown”）；`dsh-channel-qq/src/features/contact/sender.ts:279-280`（`receipt.kind:'none'` = 发送器只证明“提交过”）；`share-port.ts:146-151`（`accepted` 只表示“已入库”）。 | 通（**语义必须保持 unknown**） |

小结：**真正断的是 5、6（决策与完成事件驱动的生产者）和 8（候选正文进不了起草上下文）；
1（provider ready）在本机是个“能力目录说不可用、规划却照旧派活”的 P0 事实问题。**

---

## 2. 问题 1：runtime 调度的 B站活动 与 外部模块独立值班 是否同一条路？

**答：不是同一条路。存在两条路径，且它们共用同一个“值班执行体”，但只有一条产出 round 证据。**

### 2.1 provider 由谁 publish、`ready()` 是什么语义

- 注册表：`process[Symbol.for('dsh.companion.bilibili.providers.v1')]`，一个 `Map`，**键是
  `realpathSync(stateDirectory)`**（`bilibili-provider.mjs:10`），值是 provider 对象。
- 消费（runtime）：`bilibili-provider.mjs:7-24`。每次调用都现查表，**不缓存**；`entry.ready()`
  必须严格 `=== true`，否则视为没有 provider（`:11`）。
- 发布（外部模块）：带 publish 的那份副本里 `:1996` 建表、`:1997-2019` 造 provider、
  `:2020` `providers.set(providerKey, provider)`、`:2021-2023` 在 `ctx.effect` 的 dispose 里删除。
- `ready()` 语义（外部模块实现）：`cfg.p2Takeover && !cfg.peakValley && cfg.overlayMcp`
  （备份副本 `:1998-2001`）——即“P2 接管打开 / 不在峰谷节流 / MCP overlay 可用”三者全真。
  `run(request)`（`:2002-2018`）在 `ready()` 为假或已被取消时直接返回 `{status:'failed'}`；
  真正起一轮时 spawn 子进程并把 `round.journalPath` 通过 `BILI_DUTY_EVIDENCE_FILE` 传给子进程
  （`:1885-1887`），最后把子进程终态映射成 `completed/quota-exhausted/failed`（`:2004-2006`）。
- **本仓库内没有发布者**。worktree 内 `grep` 该 Symbol 只有两处：消费方 `bilibili-provider.mjs:5`
  与测试发布者 `test/bilibili-provider.test.mjs:11-26`。因此“provider ready”完全取决于外部模块
  的**实际安装副本**。

### 2.2 两条值班路径

| 路径 | 触发 | 产出 | 是否进入 runtime 活动生命周期 |
|---|---|---|---|
| **A. P2 接管（provider）** | runtime 的 `pumpActivityExecution` 发现 `status='running'` 的 bilibili 活动行 → `ports.runBilibili({roundId, deadlineAt, signal})`（`lib/p2.mjs:689-695`） | `p2-rounds/<sha256>/result.ndjson`（round 证据）+ 活动行终态 + `checkpoint.bilibiliRound` | **是**（活动行、回执、checkpoint 全在） |
| **B. 外部模块自己的窗口定时器** | `tick` 每 60s 一跳，按 `noon/night` 窗口与每日条数闸门自行 `runDuty('window:<k>')` | spawn 一个 **`--profile bili-duty` 的独立 headless 会话**，写 `out/<day>.md` 日报与 `seen.md` 判重表；**没有 claim 目录、没有 result.ndjson、没有活动行** | **否**（完全绕过） |

- 路径 B 的抑制条件（带 publish 的副本）：`tick` 第一行 `if (cfg.p2Takeover || !cfg.peakValley) return`
  （备份副本 `:2025-2028`）——**`p2Takeover` 打开时窗口定时器直接不跑**。当前生产
  `data/home/bili-duty/config.json` 的 `p2Takeover=true`、`peakValley=false`，所以这条路被压住。
- 装在 profile 里的 2.4.0 副本（无 p2 代码）`tick` 是 `if (!cfg.peakValley) return`（`:1926-1929`），
  `peakValley=false` ⇒ 同样不跑。两条副本都关掉了独立窗口路径。
- 结论：**今天的部署里只有路径 A 在跑**，但它是否可用取决于第 2.3 的安装事实。

### 2.3 本机安装事实（只读，不含内容）

- `data/home/profiles/companion/package.json`：`"dsh-bili-scroll": "2.4.0"`；
  `data/home/profiles/companion/node_modules/dsh-bili-scroll`（非软链，`index.js` 211655 字节，
  `fsutil hardlink list` 显示三处硬链接同源）。
- 该副本**递归 grep** `dsh.companion.bilibili.providers` / `p2Takeover` / `BILI_DUTY_EVIDENCE_FILE` /
  `journalPath` / `p2-round`：**全部 0 命中** ⇒ 这份安装副本**不会发布 provider，也不会写 round 证据**。
- `data/backups/pnpm-store-repair-20261113/node_modules/dsh-bili-scroll`（213810 字节，同版本号
  `2.4.0`）**含**全部上述代码（`:1885-1887`、`:1993-2023`）。
- `data/home/bili-duty/duty.log` 里存在 `刷B站开跑（p2）` 记录（2026-11-09 / 11-12 / 11-13 各一轮），
  说明**当时加载的副本带 p2 接管代码**；而 `duty.log` 记录的 cwd 是**另一条部署路径前缀**下的
  `bili-duty` 家目录（不是本 worktree 使用的那个前缀）。本报告不写入该本机绝对路径。
- 因此：**“哪一份副本被宿主实际加载”无法从仓库判定**，但可以确定两件事：
  (a) 一份 2.4.0 副本缺少 provider publish 代码，装在某 profile 里；
  (b) 存在 `provider` 由另一份副本工作的历史证据（7 个带 watch 证据的 claim 目录）。
  ⇒ 这是**部署层风险，不是本仓库代码缺陷**，但必须由运维固定模块构建并与 tarball 校验。

**建议（给 Lead / 运维，不属本包改动）**：在 runtime 挂载时打一次自检——若
`ports.runBilibili.available?.() === false`，则**不要**把 `bilibili` 写进当天可执行的 slot
（现在 `capabilities.mjs:37` 只是“报告不可用”，`planner` 仍可能派活，派了必然 `failed`）。
或者至少让 `p2DispatchWatch().blockedBy` 带上 `bilibili-provider-not-ready`。

---

## 3. 问题 2：`method:'transcript'` 与实际观看，在数据里怎么表达？候选能不能诚实区分？

**答：能区分，而且“能区分”是靠一个单向标记：只有字幕路径会留下 `method:'transcript'`。**

- 数据的唯一表达点：`lib/bilibili-rounds.mjs:8-21`。`watch` 证据合法化后，
  `:13` **只在 `value.method === 'transcript'` 时把 method 带出来**，其它任何方法（或没写）
  都产出**不含 method** 的 watch 对象：
  ```js
  return { kind: 'watch', videoId, consumedSeconds, ...(value.method === 'transcript' ? { method } : {}) };
  ```
  ⇒ 数据里只存在两种可观测状态：**“明确是字幕”** 与 **“没有标注观看方式”**。
  不存在“明确是真实观看”的字段——这是上游模块没有上报该维度的结果，不是本仓库的遗漏。
- 时长语义：`consumedSeconds` 是**本条证据的消费秒数**，字幕路径下它就是字幕秒数；它**不是**
  视频时长（`bilibili-rounds.mjs:12` 只校验 `> 0`）。活动行的 `consumed_prefix` 对 bilibili
  恒为 0（见 §1 第 4 段），**不能**拿它当秒数或观看数；唯一权威计数是
  `checkpoint.bilibiliRound.watched`（去重视频数）。
- 因此候选可以、也必须区分。`share-decision.mjs` 的做法：
  - `facts.method ∈ {'transcript','unstated','mixed','none'}`；
  - `facts.methodLabel` 给出人话（“只读了字幕” / “记录里没有标注观看方式”）；
  - 候选 **标题**按方法分叉：`transcript` ⇒ `B站：读了 N 个视频的字幕`；否则 `B站：看过 N 个视频`；
  - 候选 **正文**强制带一行 `观看方式：只读了字幕（约 X 分钟字幕），没有观看画面`。
- 反向约束（重要）：**不能**把“没有标注”写成“看过视频画面”。所以 `unstated` 的正文写
  `观看方式：记录里没有写下观看方式`，并且**不给**“完整看过”这种说法。
- 策略开关：`p2.share.decision.allowTranscriptOnly`（默认 `true`，与现有 journal 现实一致）；
  置 `false` ⇒ `transcript-only-blocked`。默认不设成 `false` 的理由：生产上**全部**现有证据都是
  字幕（10 个 claim 里 7 个有 watch 证据，method 均为 transcript），一刀切会让这条链永远 0 候选，
  而“0 候选 + 无原因”正是这次要修的病。

---

## 4. 问题 3：活动完成是否真的触发候选生产？

**答：不触发。只有模型显式调用工具才会产候选。**

证据链（三段，逐段钉死）：

1. 完成钩子确实被调用：`lib/activities.mjs:2721-2745` 在 `finished|failed|abandoned` 且
   `mayRecord` 为真时调用 `onFinished({scopeKey, activityId, …})`；`mayRecord` 对 bilibili 还要求
   `round?.watched > 0 && reality === 'actual_tool_activity'`（`:2719-2720`）。
2. 钩子的实现只写记忆：`companion-runtime/index.mjs:2578` 把 `onFinished: p2ActivityFinished` 注入；
   `p2ActivityFinished` 的副作用只有 `requestMemoryIngest(...)`（`index.mjs:2476-2505`），
   返回 ingest 结果。
3. `createShareCandidate` 的生产调用点只有一个：`plugins/companion-foundation/share-producer.mjs:106`，
   而它的调用者是工具注册 `companion-foundation/index.mjs:672-685`（模型显式调用）。
   非测试代码里 `createShareCandidate(` 的全部出现：`p2.mjs:1470`（定义）、`index.mjs:3002/3007`
   （公开 API）、`share-producer.mjs:106`（工具）。**没有任何“完成事件 → 候选”的边。**

⇒ 生产 `p2_share_candidates` 为 0 行，不是因为开关关着（`p2.share.enabled=true`、`maxPending=5`），
而是因为**没有自动生产者**，且模型从未在 10 次活动里显式调用过该工具。

本包补的正是这条边（`produceCandidateForFinishedActivity`，见 §6）。

---

## 5. 问题 4：`share-port.ts` 的 `propose()` 只传标题与候选 ID，起草端能否按 ID 回读 body/sourceRef？

**答：不能。三处结构性缺失，缺一不可补。**

1. **入参没有这两个字段。** `ProposeContactInput`（`plugins/dsh-channel-qq/src/features/contact/types.ts:249-262`）
   没有 `body`，也没有 `sourceRef`。`share-port.ts:27-33` 的 `ShareCandidate` 接口**声明了**
   `body/sourceRef`，但 `submitShare` 构造 `propose` 时只用 `candidate.candidateId` 与
   `candidate.title`（`:124-141`）⇒ 两个字段在跨插件边界被**静默丢弃**。
2. **落库时也没有。** `service.ts:83-105` 的 `candidateOf` 只写 `reason / evidenceSource /
   evidenceIds / scope / target / dedupeKey`，`reason` 还 `slice(0,300)`；`share-port.ts:130`
   传的 `reason: title`，而标题已被 runtime 截到 200（`p2.mjs:1484`）。正文（≤2000 字）根本进不了账本。
3. **“按 ID 回读”在当前架构下不可能。** 起草端的证据分区 `draft-readers.ts:176-195`
   是一段显式注释：“**不解析 `evidenceIds`**：全仓没有解析器”，于是 `evidence` 恒退化成
   `history:last` 并记 `evidence:unresolved`（`draft-context.ts:18` 同一结论）。而 QQ 侧也**读不到**
   runtime 的库：`grep` 显示 QQ 插件对 runtime 的全部接触就是 `share-port.ts:176-188` 的
   `readShareEnabled()`（读 `runtime.config.json`）；没有任何 `companion-runtime.db` / `p2_share_candidates`
   的读取代码（`DatabaseSync` 只出现在 `process-lock.ts:95-110,247-251`，用途是进程锁）。
   ⇒ 要从候选 ID 回读 body，必须**新增一条跨插件只读缝**，当前不存在。
4. 附带事实：`evidenceIds` 里放的是 `candidateId`（`share-port.ts:133`），而 contact 账本对
   `evidenceIds` 的语义是“聊天消息指针”（`types.ts:93-95`、`followup.ts:70`），两套语义不一致，
   解析器即使将来写出来也会认错格式。

**最小修法（Lead 改 QQ 侧，本包只读）**：
- `ProposeContactInput` 增加可选 `evidenceText`（一段**已由 runtime 落库的正文副本**，不是模型新写的）；
- `share-port.ts` 把 `candidate.body`（截断 ≤1200 字）与 `candidate.sourceRef` 一并带上；
- `draft-sections.ts`/`draft-context.ts` 增加一个 `evidence:inline` 分区渲染它，`draft-readers.ts:176-195`
  的 `evidence:unresolved` 只在本字段缺失时出现；
- 过期/缺失的处置：正文副本随候选行失效（`p2.mjs` 已是 `rejected/gated/expired` 状态），起草前必须
  依 `expiresAt`（`share-port.ts:137` 现在是 `now + ttl`）判一次，缺失就走现有 `draft:no-context`
  路径而不是编造。

---

## 6. 问题 5：JSONL 降级落盘是否已被标成“本地留存”而不是“已进 contact / 已送达”？

**答：字段级做到了，状态级没做到。**

**做到了（可复核）：**

| 位置 | 事实 |
|---|---|
| `plugins/companion-foundation/autonomy-share.mjs:34-37` | `SHARE_SCHEMA='p2-share-candidate/v1'`、`SHARE_SINK_KIND='jsonl'`、`SHARE_DEGRADED='contact-service-absent'` |
| `:250-264` `describe()` | `sink:'jsonl'`、`degraded: on_ ? 'contact-service-absent' : 'share-disabled'`、`contactSeam:'absent'`、`counts` 只有 candidates/live/withdrawals/corrupt |
| `:1-29` 文件头 | 明确写“never sends anything / never touches the contact ledger”，并给出读者合同 |
| `:186`、`:204` | 提交返回 `sink:'jsonl'`、`path`、`written`，**没有** `sent` 字段 |
| `plugins/companion-foundation/contact-share-port.mjs:25-26` | `sink` 三态 `contact-service / unavailable / jsonl-queue`；`degraded` 三态 `'' / share-port-unavailable / contact-service-unavailable` |
| `plugins/companion-foundation/share-diagnostics.mjs:94-98`、`:184-192` | `sent:{value:null, honest:'not-wired'}`；`queued.contactAckAfterQueued='unknown'`；summary 里明写“真实送达 unknown” |

**没做到（这是真缺陷，需要 Lead 在共用入口修）：**

- `lib/p2.mjs:1789-1805`：只要 `port.submit` 返回 `ok===true`，runtime 就把候选记成
  `status='queued'`、`decision_reason='contact-queued'`。而 JSONL 降级 sink 在
  `autonomy-share.mjs:204` 正是返回 `ok:true, written:true` 的。
  ⇒ 在没有 contact 服务的机器上，**一条只落到本地 JSONL 的候选会被 runtime 记成“已进 contact 队列”**。
  `contact-share-port.mjs:33` 会把 `answer` 原样透传（`sink:'jsonl'` 就在里面），
  runtime 有信息、但**没有用它**。
- 同类问题在 `lib/p2.mjs:1504-1509`（`submitShareCandidate`）：`accepted===true` ⇒
  `status='submitted'` + `decision_reason='accepted'`，同样不区分 sink。
- 而 `queued` 的**下游**语义又确实是“进过某处”：`SHARE_STATES`（`share-diagnostics.mjs:30`）里没有
  `local-only`，`queued` 被 summary 说成“进 contact 账本”（`:192`）——对 JSONL 路径是错的。

**建议（不改 `SHARE_STATES` 的最小修法）**：`accepted && answer.sink === 'jsonl'`
⇒ `status='queued'` + `decision_reason='local-only-jsonl'`（词表不变，但原因可 grep、`share-diagnostics.mjs:192`
的 summary 文案随 reason 分叉）。**完整修法**：新增 `local-only` 状态进 `SHARE_STATES`/`DROP_STATES`
（属于集成负责人的决定，会影响 `p2-share-consume.test.mjs` 等既有断言）。

结论一句话：**“候选已入库”可以报，“已进 contact”只能由 `sink==='contact-service'` 支撑，
“已送达”只有 contact 的投递账本才配说。**

---

## 7. 本包交付（新文件，零改动）

| 文件 | 职责 |
|---|---|
| `plugins/companion-foundation/share-decision.mjs` | `decideShare()`（纯函数决策）＋ `produceCandidateForFinishedActivity()`（受开关控制、幂等、fail-closed 的完成事件驱动生产者）＋ `createFinishedActivityShareHook()`（给 `onFinished` 用的薄适配）＋ `deriveBilibiliEvidence()`（round → 证据投影）＋ `bilibiliVideoUrl()` |
| `plugins/companion-foundation/share-decision.test.mjs` | 合成用例（假活动 / 假 checkpoint / 假 evidence / 假 cognitive），零网络、零模型、零发送 |
| `plugins/companion-foundation/docs/F-share-chain-draft.md` | 接口草案（输入/输出/默认行为/开关/失败码/作用域/幂等键/兼容/接线建议） |
| `docs/21-bilibili-share-chain-audit.md` | 本文（十段链路 + 五问 + 缺陷定性） |

**没有**修改任何已存在文件。**没有**读真实数据库、真实 journal 内容。**没有**提交/推送/切换分支。

---

## 8. 剩余风险（按严重度）

| 级别 | 风险 | 谁能收敛 |
|---|---|---|
| P0 | 装在某 profile 的 `dsh-bili-scroll@2.4.0` 副本不含 provider publish ⇒ `provider-not-ready`，而 planner 仍可派 bilibili 活动 ⇒ 必然 `failed`。**版本号相同、字节不同**，靠版本号无法区分。 | 运维：固定 tarball 并校验（或升级到带 p2 接管代码的构建）；Lead：把 `provider-not-ready` 进 `dispatchWatch.blockedBy` |
| P1 | 候选正文进不了起草上下文（§5），草稿只看到标题 ⇒ “分享”退化成一句无内容的引子。 | Lead + QQ 侧（`evidenceText` 内联） |
| P1 | JSONL 降级被记成 `contact-queued`（§6）。 | Lead（`p2.mjs` 的 accepted 分支） |
| P2 | bilibili 活动行的 `consumed_prefix` 恒 0，任何“按 consumed_prefix 判证据”的新代码都会误判“没看过”。 | 已在 `share-decision.mjs` 里规避（只用 round 证据） |
| P2 | `share-queue-full`（`p2.mjs:1481` 抛出）不在 `SHARE_GATE_*` 表里；它发生在**生产**侧，不在投递侧，因此不会被闸门分类吞掉，但如果调用方不接异常就会变成静默失败。 | 已在 `share-decision.mjs` 映射成 retryable `share-queue-full` |
| P3 | `unknown` round 结果可能真的已经看过（`bilibili-rounds.mjs:86-87` 的注释就是这件事）。 | 已按“不盲目重试”实现：`round-unknown` 为 terminal，留给人/操作者 |
