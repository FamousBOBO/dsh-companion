# 主动消息（contact）最小闭环 · 验收报告

> 验收人：`verify-review`（独立验证，不写实现）
> 对象：`plugins/dsh-channel-qq` 的 `src/features/contact/*`（`gate` / `store` / `lease` / `ledger` / `ledger-io` / `send-guard` / `sender` / `attempt` / `worker` / `model` / `sources` / `service` / `index`）以及 `src/features/proactive/index.ts` 的事件书兜底改动
> 日期：2026-10-28（第 1 轮）／2026-10-29（第 2 轮复验，见第 9 节）
> 结论：**本任务范围内的验收项全部 PASS**。contact 专项 **107/107**（第 1 轮 81 + 复验轮 26），静态检查 0 错误；真实模型与真实 QQ 两类证据按任务书要求**本轮不做**。
> 全量套件 9 条红，**没有一条属于本任务**（分诊见第 4 节与第 9.7 节）。

---

## 0. 一句话结论

主动消息这条链路现在的保证是：**默认装上去什么都不发**（`enabled=false` / `dryRun=true` / `allowExternalSend=false` / `draftModel=false`），要发必须过九道门控，发之前先落盘领取、发之后按回执分三档结算（`confirmed` / `submitted` / `unknown`），任何"不知道"一律**不重发**；空转 24 小时不调用一次模型、不写一次账本；关着的时候连文件都不建。

---

## 1. 范围与方法

| 项 | 取值 |
| --- | --- |
| 被测构建 | `plugins/dsh-channel-qq/build/lib-test`（`tsc -p tsconfig.test.json` 产物） |
| 测试运行 | `node --test "build/lib-test/test/contact-*.test.js"` |
| 时间 | 全部走注入的 `FakeClock`（绝不 `sleep`，也绝不用真实时间等被测对象） |
| 平台 | `FakePlatform`（记录每一次 `sendTo` / `sendGroupMessage` / `sendPrivateMessage`，可注入失败/丢回执/挂起） |
| 模型 | 假 `DraftPort`（计数 + 可抛错）——**没有任何一次真实模型调用** |
| 磁盘 | 每个用例一个 `mkdtemp` 临时目录，`finally` 里删掉 |
| 明确不做 | 不连网络、不发真 QQ、不读真实 `workspace/reminders.json`、不碰 `home/` 与 `desktop-data/`、不重启共享 DSH 宿主、不改实现文件 |

我的文件边界（只写了这些）：`test/fakes/contact.ts`（新增，不改既有 `test/fakes/host.ts`）、`test/contact-gate.test.ts`、`test/contact-outbox.test.ts`、`test/contact-recovery.test.ts`、`test/contact-regression.test.ts`、`test/contact-guard.test.ts`（复验轮新增）、`test/contact-plugin.test.ts`（复验轮新增）、本文件。

专项测试规模：**107 条**，全绿：

| 文件 | 条数 | 一句话 |
| --- | --- | --- |
| `contact-gate.test.ts` | 23 | 九道门控、判定顺序、reason 词表 |
| `contact-outbox.test.ts` | 37 | 账本/租约/领取/结算/崩溃恢复 + sender 全分支 + Windows rename EPERM（S15/S16） |
| `contact-recovery.test.ts` | 15 | 空转 24h、暂停卸载、双 Host、退避、模型离线 |
| `contact-regression.test.ts` | 9 | 坏事件书、提醒直发、出站链、被动回复回归 |
| `contact-guard.test.ts` | 15 | **队列执行点复验**（Q00–Q05）与**异常分流矩阵**（E01–E05） |
| `contact-plugin.test.ts` | 8 | **插件级闭环**（P00–P07） |
| 合计 | **107** | |

> 复验轮（第 2 轮）新增 26 条，全部是"**修复前会失败**"的回归，见第 9 节。

---

## 2. 四类证据（分开列，不要混着读）

### 2.1 静态检查 —— 已执行

```bash
cd plugins/dsh-channel-qq
node node_modules/typescript/bin/tsc -p tsconfig.verify.local.json   # 退出码 0，无输出
node node_modules/typescript/bin/tsc -p tsconfig.test.json           # 本人 4 个测试文件 0 错误
npm run check:layers                                                 # 分层约束
```

| 检查 | 结果 | 关键输出 |
| --- | --- | --- |
| `tsconfig.verify.local.json` | PASS | 无诊断，退出码 `0` |
| `tsconfig.test.json`（我的文件） | PASS | 0 错误 |
| 插件是否真的装配进 sections | PASS | `src/sections.ts:19` `import { contactPlugin }`、`:90` `contactPlugin,`（排在 `proactivePlugin` 之后、`adminPlugin` 之前） |
| 配置段是否在 golden 里 | PASS | `test/golden/config/layers.txt:620` 等 6 处出现 `"contact"` |
| 桌面真实配置是否被本任务改动 | 未改动 | 未读取、未写入 `~/.dsh`、`workspace/`、`desktop-data/` |

> 备注：`checkedBook` 的兜底改动（坏事件书 → 空书停用）是**实现侧**改的；我在 `R01` 里用行为固化它，没有读实现文件来"证明"。

### 2.2 mock 验证 —— 已执行（本报告的全部 PASS 都属这一类）

```bash
node --test --test-reporter=tap "build/lib-test/test/contact-*.test.js"
# tests 81 / pass 81 / fail 0 / skipped 0 / todo 0
```

### 2.3 真实模型 —— **本轮不做（不是遗漏）**

任务书明确本轮只做"最小闭环"，真实模型起草属于下一轮。本轮与模型有关的一切结论都建立在"假 `DraftPort`"上，**因此以下问题本轮无法回答**：

- 真实模型起草的**质量**（会不会写出让人不适的话、会不会超 `draftMaxChars`）；
- 真实模型的**延迟分布**（`draftTimeoutMs = 20s` 是否够）；
- 真实模型在"没什么可说"时是否真的返回空（`DraftPort` 允许返回 `null`，但它会不会返回）。

### 2.4 真实 QQ 收件 —— **本轮不做（不是遗漏）**

- 没有发起一次真实 `send_private_msg` / `send_group_msg`；
- 因此**没有验证**：QQ 侧 Graia/OneBot 实现是否总会回 `message_id`（如果不回，全部直发都会落在 `submitted`，无法升到 `confirmed`）；
- 也没有验证：撤回、风控、限频对主动消息的影响。

> 相关设计已按"回执不可靠"设计：拿不到 `message_id` 只记 `submitted`，`turn` 模式**永远只能**到 `submitted`（`D12`）。所以"真实回执缺失"不会导致谎报成功，只会导致我们更保守。

---

## 3. 验收矩阵

结论取值只有三种：`PASS`（有可复现用例）/ `FAIL` / `未覆盖`。证据列写测试编号，编号与 `contact-*.test.ts` 的 `test('...')` 名字前缀一一对应。

| 编号 | 场景 | 结论 | 证据（测试 / 命令） | 备注 |
| --- | --- | --- | --- | --- |
| A01 | 空转 24 小时：零模型调用、零外发、账本除租约外零变化 | PASS | `H01` | 24h / 288 拍；模型调用计数 0，账本 diff 只有 `lease` |
| A02 | `enabled=false`：零模型、零外发、**零磁盘写**（不建账本、不建锁） | PASS | `H02` `H02b` `G01` | "关着"是真的不动，不是"跑了但不发" |
| A03 | 有候选但被免打扰挡住 → 不生成草稿 → 模型调用 0 | PASS | `H04` `G08` | 免打扰跨午夜 23:00→08:00，08:00 整放行 |
| A04 | 冷却（房间级先于全局级；0 = 该级不设） | PASS | `G12` | |
| A05 | 额度（全局先于房间；跨日归零） | PASS | `G13` `S14b` `S14c` | 跨日归零在验收期抓到过 bug（V-S1，见第 5 节），修复后被这三条钉住 |
| A06 | 未回复退避与恢复 | PASS | `G15` `H11` | 用户一说话计数归零并恢复发送 |
| A07 | 到点提醒 vs 普通闲聊**分道** | PASS | `G05` `R03` `R06` | `explicit-reminder` 候选一律 `drop/reminders-owns`，在**任何模型调用之前**；同一拍里提醒直发 1 条 + 主动回合 1 条，互不吞 |
| A08 | 新用户消息与发送竞争 → 正确延期 | PASS | `G10` `D08` `H10` | 含"起草期间用户说话"（复核窗口）与"时钟回拨为负差" |
| A09 | 重复事件 / 多拍 / 同一进程多次 tick → 不重复领取 | PASS | `S07` `H05` | `claimDelivery` 幂等；候选消费后不再起草 |
| A10 | 两个 Host 同时跑 → 只有一个能发 | PASS | `S05` `H06` | 第二个实例拿不到租约，日志具名，一句都不发 |
| A11 | 热重载 / 卸载 → 不残留定时器、释放租约 | PASS | `H07` `R03` | `FakeClock.liveCount() === 0`；锁文件被删；卸载后误调 `tick` 是空操作 |
| A12 | 崩溃（领取后进程死掉）→ 重启降级 `unknown`，不重发 | PASS | `S12` `H09` | 降级会落盘，`lastError` 留 `interrupted` |
| A13 | 发送成功但回执丢失 → `unknown`，不盲重试 | PASS | `D02` `D03` `S10` | 且 `unknown` 会算进 `deliveredDedupeKeys`（不能让同一件事第二天再来一遍） |
| A14 | 取消 / 过期 / 迟到草稿不得复活 | PASS | `G02` `S08` `D07` `D16` `R03b` | 终态**优先于总开关**；"取消"不会被"重新打开"救回来 |
| A15 | 跨用户 / 跨人格 / 跨世界不得越界 | PASS | `D10` `D11` `G06` | 私聊收件人必须等于候选指向的人；`scope.personaId`/`worldId` 不一致即 `cancelled` |
| A16 | 没通道 / 绑定失效 → 不假成功 | PASS | `G16` `D05` `D09` `H13` | `attempted=false` 且平台零调用；连投递记录都不建 |
| A17 | 模型离线不得阻塞规则路径 | PASS | `H12` `G20` | 起草抛错 → `draft:unavailable` 延期，节拍继续；默认组合本来就不调模型 |
| A18 | 暂停 / 卸载 → 不留后台任务 | PASS | `H08` `H07` | 停表 + 释放租约；恢复后能再发 |
| A19 | 坏配置不得回退到"会自动发的默认事件书" | PASS | `R01` `R01b` `R02` | 坏书 → 空书安全停用（0 事件 0 回合，日志具名）；空书本身是合法配置；对照组合法书恰好 1 条 |
| A20 | 既有聊天 / 记忆 / 被动回复回归 | PASS | `R04` `R05` `R06` + 全量套件 | `sendTo` 线上动作名群/私聊不混；出站失败必须 reject；提醒定时器卸载即清 |
| A21 | 默认安装静默（三道闸 + `sendMode=turn` + `draftModel=false`） | PASS | `G01` `G19` `G20` `H02` | `authorizeOutbound` 三态：`dry-run` / `denied` / `allowed` |
| A22 | 判定顺序是契约；`reason` 词表稳定 | PASS | `G17` `G18` | 前一步不通过就不再看后面；reason 全是小写短横线串且都在声明词表里 |
| A23 | 伪造授权（缺 `by`/`at`）→ 拒绝 | PASS | `G04` | `explicit` 与 `standing` 都要求凭据，只有 `none` 允许空 |
| A24 | 配置时区名不认识 → fail-closed | PASS | `G09` | 算不出"现在是不是免打扰"就不发 |
| A25 | 停机很久 → 不攒补发（补算视界） | PASS | `G03b` `H15` | `maxCatchupHours=24`，恰好 24h 放行、+1min 过期；0 = 关闭补算 |
| A26 | 房间键与目标不自洽（四种错法） | PASS | `G07` | `group-1` 与 `qq-group-1` 两种历史前缀都认 |
| A27 | 账本损坏 / 版本不认识 | PASS | `S02` `S03` | 改名 `.corrupt` 保留证据，本轮空表起步且不抛；不猜结构 |
| A28 | 租约代次：接管 `epoch+1`、旧代次提交被拒、续期不改代次 | PASS | `S05` `S06` | `StaleLeaseError` 用 `instanceof` 判（它不设 `.name`） |
| A29 | 结算时间戳单调（不会被覆盖成 `null`） | PASS | `S11` | |
| A30 | 清理不越界：`prune` 不删 `running`/`pending`/`deferred` | PASS | `S13` | 终态保留 30 天 |
| A31 | 主动消息走与提醒共用的出站链 | PASS | `D18` | 必须有 `out.push`，不自开一条旁路 |
| A32 | `sendMode` 被改 / 回合正忙 | PASS | `D13` `D14` `G11` | 投递建好之后改模式 → `deferred/mode-changed`，不按旧模式硬发 |
| A33 | 空正文/超长 → 不发半句话 | PASS | `D15` | 超长按"没话可说"处理，不截断 |
| A34 | **真实模型**起草质量/延迟/空返回 | 未覆盖 | — | 见 2.3，本轮按任务书不做 |
| A35 | **真实 QQ** 收件与回执 | 未覆盖 | — | 见 2.4，本轮按任务书不做 |
| A36 | 插件级热重载（`fiber dispose → apply` 重挂 `contactPlugin`） | 未覆盖 | — | `src/features/contact/index.ts:188` 用 `systemClock`（不可注入），插件级无法用假时钟驱动；`worker.dispose` 已被 `H07` 覆盖，但**"子插件整体重挂"这一层没有验证**。这是审查项 V-I1 |
| A37 | 真实桌面 profile 上的行为（`proactive.v2:true` + 空书） | 未覆盖 | — | 按要求不启动、不读取真实宿主；只做了静态确认：坏书不再回退默认书（`R01`），而空书是合法配置（`R01b`） |

矩阵条数：**37 条**（PASS 33 / 未覆盖 4）。

---

## 4. 全量套件分诊（红条目归谁）

命令：

```bash
cd plugins/dsh-channel-qq
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test --test-reporter=tap "build/lib-test/test/*.test.js"
```

本轮结果（我自己跑的，`--test-reporter=tap`）：`# tests 750 / # pass 741 / # fail 8 / # skipped 1 / # todo 0`。**8 条红，0 条属于 contact。**

| 红条目（TAP 编号） | 与本任务的因果关系 | 证据命令 | 说明 |
| --- | --- | --- | --- |
| `not ok 205` — `golden: v2 私聊与注入 —— 都是"信封 + 当前消息"` | **并行会话**（不是我们） | `node --test --test-reporter=tap "build/lib-test/test/*.test.js" \| Select-String '^not ok'` | 并行开发会话在 22:55 改了 `src/app/conversation/prompt-composer.ts` 的私聊抬头（`【私聊消息】/【这是私聊】` → `【QQ路由】isGroup=false；target=…`），golden `test/golden/packets/v2-dm.txt` 因此不匹配。lead 已把 golden 从 `logs/golden-before/` 原样还原。**本任务不认领。** |
| `not ok 266–270` — eval-harness ×5（规则抓违规 / 不误伤 / 转录解析 / `--suite` 过滤 / 全量离线跑绿） | **基线已有** | 同上 | 缺 `eval/` 目录；逐条同名，与本次改动无关 |
| `not ok 277` — `群文件：专用 URL 接口命中后下载落收件箱` | **基线已有** | 同上 | `inbox/demo-1.0.0.apk` vs `inbox/简助手-5.7.0.Apk`（文件名编码） |
| `not ok 50` — `build\lib-test\test\memory-retrieval.test.js` | **基线已有** | 同上 | 逐条同名 |
| `即时抽取：配额…冷却`（本轮**没有**红） | **flaky**（与 contact 无关） | `node --test --test-reporter=tap "build/lib-test/test/memory-v3*.test.js"` → 13/13 全绿 | 只在全量跑时偶发（`触发的抽一次 0 !== 1`），单独跑不复现；我这轮全量里它没红 |

> "基线 7 条"= eval-harness ×5 + file-receive + memory-retrieval。它们在**我动手之前的原始基线**里就是红的，本轮前后逐条同名，没有变化。

---

## 5. 敌对审查清单（按严重度）

### P0 —— 无

没有发现"默认安装就会外发 / 会重复发 / 会丢数据"这一类问题。三道闸（`enabled` / `dryRun` / `allowExternalSend`）默认全关，`sendMode=turn` + `draftModel=false` 意味着默认组合连文案都不会生成（`G20`）。

### P1

#### V-S1 跨日额度永不归零（**已修复并验证**）

- **位置**：原 `src/features/contact/store.ts` 的 `normalizeCounters()` 与 `rollDay()`。
- **最小复现**（临时目录 + 假时钟，无网络）：
  1. 用 `dayKey='2026-10-17'` 建 store → `acquireLease()` → `patchCounters({ sentTodayGlobal: 3 })`；
  2. 新实例，`dayKey='2026-10-18'`，`load()`；
  3. 实测（修复前）：`counters = { day: '2026-10-18', sentTodayGlobal: 3, … }`，`rollDay() -> null`。
- **根因**：`normalizeCounters(value, dayKey(now))` 把账本的 `day` **改写成今天**却保留昨天的计数；于是 `rollDay()` 的 `if (counters.day === day) return false` 恒成立（**结构上不可能**返回非 null，等于死代码），`gate.checkQuota` 也把昨天的用量当成今天的。
- **影响**：任意一次跨日（进程连续跑过午夜，或跨日重启）之后，当天额度直接是"已用满"→ 主动消息全天发不出去；`unansweredStreakByRoom`、`draftCallsToday` 同样跨日粘连。
- **修复**：拆成"洗数据"与"跨日归零"——`normalizeCounters` 保留原 `day`；新增 `ledger.rollCounters()`：按天字段清零（`sentTodayGlobal`/`sentTodayByRoom`/`draftCallsToday`），跨天有意义的字段保留（`lastSentAt*` 冷却、`draftFailureStreak` 故障状态、`unansweredStreakByRoom`）。
- **回归钉住**：`S14b`（进程常驻跨日）、`S14c`（跨日重启读盘即归零）、`G13`（门控侧额度）。
- **状态**：已修复，三条用例全绿。

### P2

#### V-S2 超时记 `unknown` 之后，底层发送仍可能真的发出去

- **位置**：`src/features/contact/sender.ts:198`（`withTimeout(... transport.out.push(...))`）+ `:239` `fromError`。
- **最小复现**：`contact-outbox.test.ts` 的 `D03`（`hanging` 传输 + `clock.advance(30_001)`）。断言到的是"结论是 `unknown` 且不重试"，这是对的；但 `out.push` 里的那次 `sendTo` **没有被取消**，它会在超时之后仍然执行。
- **影响**：极端情况下会"先记不知道、后真的发出去"。**不会重复发**（`unknown` 是终态，账本不会再领取），只是账本与实际之间有一个时间窗不一致。
- **为什么不当 P1**：进程内无法取消一次已经交给平台的发送（`OutboundQueue` 没有取消语义）。要真正解决需要出站链支持 abort，属于下一轮。

#### V-S3 `OutboundQueue.sentHistory` 是死代码

- **位置**：`src/outbound.ts:68` —— `private readonly sentHistory = new Set<string>()` 声明了但**从来没有被读过**（全仓 grep 只有这一处）。
- **影响**：不会出错，但会让后来的人以为"出站有历史可查"。建议删掉或接上诊断面。

#### V-T1 `ReminderRunner` 不可注入时钟（可测性缺陷）

- **位置**：`src/features/reminders/runner.ts:23-25`（`start(intervalMs = 30_000)` 用全局 `setInterval`）+ `src/features/reminders/store.ts:136`（`due(now = Date.now())`）。
- **影响**：提醒到点的测试只能**临时替换全局 `setInterval`/`clearInterval`**（`R03` 就是这么做的，`finally` 里恢复）。这既是可测性问题，也意味着提醒的节拍与注入的 `Clock` **不一致**——主动消息全部走注入时钟，两者在同一进程里用两套时间源。
- **建议**：把 `Clock` 注进去（与本任务的 `worker.ts` 保持一致）。

#### V-I1 `contact` 子插件用 `systemClock`，插件级不可注入

- **位置**：`src/features/contact/index.ts:188`（`const clock: Clock = systemClock`），另见 `:159`/`:160`/`:220` 直接调 `systemClock.now()`。
- **影响**：`A36`（插件级热重载）因此**无法验证**——只能验证 `ContactWorker.dispose`（`H07`）。这不是 bug，但如果下一轮要测"整体重挂子插件"，得先让 `index.ts` 从 `host` 取 `Clock`（`H07` 证明 worker 侧已经准备好了）。
- **本报告的处理**：如实标 `A36 未覆盖`，不拿 `H07` 冒充。

#### V-I2 `runTick` 的早期返回路径不写诊断

- **位置**：`src/features/contact/worker.ts:179-183`（`paused || !enabled` 时直接 `return`，不留 `noteReason`）。
- **影响**：`status()` 上看不出"今天为什么一条都没动"。这不影响正确性（`H02` 要求这条路径**零磁盘写**，写诊断反而违背它），只是可观测性差一点。修的话要接受"关着也偶尔写一行"的代价，需要产品判断，不建议本轮动。

#### V-I3 `dedupeKey` 只由调用方保证

- **位置**：`index.ts` 的 `validatePropose()` 只校验非空，不校验"是不是同一件事"。
- **影响**：同一件事用两个不同的 `dedupeKey` 就能发两次。门控的去重（`G14`）挡不住这种。属于契约层面（`docs` 里要写清"`dedupeKey` 是调用方的责任"）。

### 我**没能验证**的东西（明确列出来，不要当成已验证）

1. **真实模型**的起草质量、延迟分布、是否真的会返回"没话说"（2.3）。
2. **真实 QQ** 是否总回 `message_id`；撤回/风控/限频对主动消息的影响（2.4）。
3. **插件级热重载**（`contactPlugin` 整体 `dispose → apply`）：`index.ts` 用 `systemClock`，无法注入假时钟（V-I1 / A36）。
4. **两个真实进程**（不是同一个测试进程里的两个 `ContactStore` 实例）同时跑同一个 `dshHome` 时的租约行为。我的"双 Host"（`H06`）是**同进程两个实例**，能覆盖 `wx` 独占创建与代次递增，但覆盖不到"真进程 A 被 SIGKILL 时锁文件的残留形态"。
5. **Windows 上的 `rename` EPERM**：这是 lead 定位的真 bug（实现侧已加"读也进锁 + rename 有界重试"），我只观察到"锁文件创建后紧跟着的确认读会卡住"这一现象，**没有**独立做出"首次 EPERM、第二次成功"的复现（那是实现侧新增的测试）。
6. **`maxPerTick > 1`** 时的公平性（默认 1，多候选时的先后次序我只验证了"一条一次"，没验证"轮转是否公平"）。
7. **长时间运行的内存增长**：`FakeClock` 的定时器表、`mutex.ts` 的 `tails` Map、`recentReasons` 都有上限/清理逻辑，但我没有做"跑 7×24 小时"的浸泡测试。
8. **`dryRun` 期间的账本体积**：`H14` 证明演练不会消耗额度，但没验证"演练跑一个月账本会有多大"（`prune` 只清终态投递，`recentReasons` 有 40 条上限）。

---

## 6. 测试基建的两个坑（本轮教训，值得留档）

### 坑 1：Windows 上 `rename` 会 `EPERM`

- **现象**：`atomicWriteFile` 的 `tmp → rename` 在目标文件刚被读过/还被别的句柄占着时抛 `EPERM`；在 `keeper.create()` 之后紧跟的确认读里表现为"**永久挂起**"（我在排查 `H07` 时复现到：把 store/keeper 的每个方法都包一层日志，最后停在新锁文件的第一次 `readLockState` 上）。
- **影响面**：跨进程租约文件（每 tick 续期一次）比普通存储更容易踩到。
- **实现侧修法**：读也进锁 + `rename` 有界重试（配一条"第一次 EPERM、第二次成功"的单测）。

### 坑 2：用 `setImmediate` 轮询当"等待"在 Windows 上只值十几毫秒

- **现象**：`for (let i = 0; i < 200; i++) await new Promise(r => setImmediate(r))` 在 Windows 上总共只跑十几到几十毫秒，而 `acquireLease`/`persist` 是 **真实文件 I/O**（临时目录 + Defender 扫描，单次 10–50ms）。预算用完了 I/O 还没回来 → 一条**实现正确**的用例偶发变红（`H07`/`H08` 就是这样红的）。
- **修法**：`test/fakes/contact.ts` 的 `waitUntil()` —— 用**宿主真实定时器**（`setTimeout` 5ms 步进、3 秒预算）等条件，绝不用 `FakeClock` 的 `setTimeout`（那是被测对象的时间，拿它等被测对象就是死锁）。
- **复现脚本**：`plugins/dsh-channel-qq/logs/repro-h08.mjs`（lead 写的，不进测试集；把 H08 拆步打印）。
- **纪律**：这条已经写进 `waitUntil` 的注释里，后续任何人加 contact 测试都该用它，不要自己写 `setImmediate` 轮询。

---

## 7. 复现命令（照抄即可）

```bash
cd plugins/dsh-channel-qq

# 1) 静态检查（期望：无输出，退出码 0）
node node_modules/typescript/bin/tsc -p tsconfig.verify.local.json

# 2) 编译测试（产物在 build/lib-test）
node node_modules/typescript/bin/tsc -p tsconfig.test.json

# 3) 专项 81 条（期望 81/81）
node --test --test-reporter=tap "build/lib-test/test/contact-*.test.js"

# 4) 单条复跑（例：跨日归零、空转 24 小时、坏事件书）
node --test --test-name-pattern="S14c" "build/lib-test/test/contact-outbox.test.js"
node --test --test-name-pattern="H01"  "build/lib-test/test/contact-recovery.test.js"
node --test --test-name-pattern="R01"  "build/lib-test/test/contact-regression.test.js"

# 5) 全量（期望 750/741，8 条红全部与本任务无关，见第 4 节）
node --test --test-reporter=tap "build/lib-test/test/*.test.js"
```

---

## 8. 变更边界声明

- 我只**新增/修改**了：`test/fakes/contact.ts`、`test/contact-gate.test.ts`、`test/contact-outbox.test.ts`、`test/contact-recovery.test.ts`、`test/contact-regression.test.ts`、`test/contact-guard.test.ts`、`test/contact-plugin.test.ts`、本文件。
- 没有改动任何 `src/**` 实现文件，也没有改动既有 `test/fakes/host.ts`。
- 测试只写临时目录；不读真实 `workspace/reminders.json`、`home/`、`desktop-data/`；不发起网络请求；不重启共享宿主。

---

# 第 2 轮：复验（Codex 四阻断项）

> Codex 的验收结论是"**不通过**"，其中一条直接指向证据成色：**没有能让当前代码失败的回归测试**。
> 这一轮的全部工作就是补上"会红的测试"，并把四条阻断项逐条标成已覆盖／仍有缺口。

## 9.1 新增用例（26 条）+ 改写用例（2 条）

### A. 队列执行点（`test/contact-guard.test.ts`，Q00–Q05）

关键夹具：`FakeOutboundQueue`（`hold = true` 时 `out.push(task)` **不执行** callback，等 `release()` 才执行），
用来把"真实限速队列的等待窗口"显式化——这段时间里世界会变。

| 用例 | 断言 | 修复前的行为 |
| --- | --- | --- |
| `Q00`（对照） | 世界没变 → 恰好 1 次 `sendTo`、结算 `confirmed` | 一样（防止回归把"能发"也拦住） |
| `Q01` | 窗口期内用户刚说话 → **零 `sendTo`**、结算 `deferred`（`settle:user-active`） | **照样发出去并记 `confirmed`** |
| `Q02` | 窗口期内候选被取消 → 零 `sendTo`、结算 `cancelled` | 照样发 + `confirmed` |
| `Q03` | 窗口期内实例被暂停（`isFrozen`）→ 零 `sendTo`、`deferred` | 照样发 + `confirmed` |
| `Q04` | 窗口期内租约被接管（同样折进 `isFrozen`）→ 零 `sendTo`、非 `confirmed` | 照样发 + `confirmed` |
| `Q05` | `refresh` 被调用 **≥2 次**，且第二次发生在 callback 真正执行之后 | 只调用 1 次（= 决策与执行之间没有复核） |

`Q05` 是这组里最"元"的一条：它不测某个结论，测的是**"有没有在正确的位置复核"**本身。

### B. 异常分流矩阵（`test/contact-guard.test.ts`，E01–E05）

| 用例 | 断言 | 修复前的行为 |
| --- | --- | --- |
| `E01` ×5（`ECONNRESET` / `EPIPE` / `ETIMEDOUT` / `ECONNREFUSED` / `EAI_AGAIN`） | 结算 `unknown`、`attempted=true`、平台零"成功" | 全部判 `failed`（→ `afterSend` 重试 → **重复外发**） |
| `E02` | 无 `code`/`retcode` 的未知异常 → `unknown` | `failed` |
| `E03` | OneBot 明确拒绝（`retcode!==0` / `status:'failed'`）→ `failed`（可重试） | `failed`（这条是对的，用来守"别把可重试的也判成未知"） |
| `E04` | 自建超时 → `unknown`，**且放行队列后仍然零 `sendTo`**（令牌作废） | 账本说"不知道"、用户照样收到一条 |
| `E05` | `classifySendError` 是纯函数（同输入同输出），且按 `error.code`/`retcode` 判 | 没有这个函数（判定散在 `fromError` 的 if/else 里） |

### C. 插件级闭环（`test/contact-plugin.test.ts`，P00–P07）

真跑 `contactPlugin.apply()` + `start()`，用 `host.registerResource('contact', { actions: { tick } })`
**显式驱动**每一拍（`pollIntervalMs = 3_600_000`，真实 `setInterval` 在测试期间不触发）。

| 用例 | 断言 | 说明 |
| --- | --- | --- |
| `P00` | 全新 `dshHome`（**不预建** `channel-qq/`）：首拍必须拿到租约并跑完一轮 | **修复前是红的**（见 V-P1），现在绿 |
| `P01` | 到期提醒 → 候选入库（`source='explicit-reminder'`、`dedupeKey='reminder:r-1:<at>'`）→ 门控放行 → 回合被提交一次（文案含提醒内容）→ 账本 `submitted` + 候选 `consumed` | 插件级闭环主路 |
| `P02` | 重复 tick 不重复入库（同一 `dedupeKey` 只一条候选） | |
| `P03` | `reminders.enabled=true`（runner 在投递）→ 零候选零提交 | "同源判据"：`sources` 不提、门控也 `drop(reminders-owns)` |
| `P04` | `enabled=false` → 零候选零发送，**连账本与锁文件都不建** | |
| `P05` | `dryRun=true` → 候选照提、零外发、候选不被消费 | |
| `P06` | `contact` 服务在袋子里、资源可 tick、**刻意没有 `sendNow`**、诊断输出不含 `secret`/`token`/URL | |
| `P07` | 同一 `dedupeKey` **并发**两次 `propose` → 池子里只一条、第二次 `duplicate`、`candidateId` 指回既有那条；再提一次带新证据 → 只合并 `evidenceIds` | **修复前会失败**（见 V-P2） |

### D. Windows `rename` EPERM（`test/contact-outbox.test.ts`，S15/S16）

| 用例 | 断言 | 说明 |
| --- | --- | --- |
| `S15` | 注入 `renameOnce`：第一次 `EPERM`、第二次成功 → 租约拿到、账本落盘、`version` 正确、日志里有"EPERM，第 1/6 次" | "有界重试"必须留痕，否则"偶尔很慢"永远查不出来 |
| `S16` | 一直 `EPERM` → **写操作明确失败**（`账本改名失败`），`renameOnce` **恰好调用 6 次**（`RENAME_ATTEMPTS`），6 条"被占用"日志，账本文件不存在 | fail-closed：写不进去 → `claimDelivery` 领不到 → 一条都发不出去 |

> 这两条都用注入缝 `retryDelay: async () => {}`（lead 新增）把"重试之间的等待"变成瞬时，
> 于是重试次数是**常量 6**、与机器负载无关。默认实现（"注入时钟 + 50ms 真实定时器赛跑"）
> 在全量并发下会漂移，本轮实测过：单跑 639ms 绿、全量并发 349ms 红——生产行为没变，
> 但**测试不能靠真实定时器赛跑**。这是本轮第 5 个坑（见 9.5 坑 5）。

### E. 改写的旧用例（2 条）

| 用例 | 改动 | 原因 |
| --- | --- | --- |
| `D04` | 从"普通字符串错误 → `failed`"改成"**OneBot 明确拒绝** → `failed`"，并断言 `detail` 含 `rejected` | 旧断言**编码了这个 bug 本身**：随便一个 `Error('boom')` 被判 `failed` 正是重复外发的根因。这条是本轮最直接的"证据成色"证据：**旧测试锁住了错误行为** |
| `D04b` | 新增：普通异常（无 `code`/`retcode`）→ `unknown` | 与 D04 成对，把两类异常钉在一起看 |

---

## 9.2 Codex 四阻断项台账

| # | 阻断项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 没有插件级闭环（只测了函数/类，没测真装配） | **已覆盖** | `P00`–`P07`：真 `apply()`/`start()`/`registerResource` + 真实来源（`sources.ts` 的到期提醒）+ 门控 + 回合提交 + 账本落盘 |
| 2 | 队列等待期绕过发送前复核（新消息/取消/暂停/租约易主） | **已覆盖** | `Q01`–`Q04` + `Q05`（复核位置）；实现侧 `guard()` 在 callback 内、`isFrozen` 为第一判据 |
| 3 | `ECONNRESET` 等被分类成 `failed` → 重复外发风险 | **已覆盖** | `E01`×5 / `E02` / `E03` / `E05`；`classifySendError` 只按 `code`/`retcode` 判 |
| 4 | 超时之后队列里那次发送仍会真的发出（账本说"不知道"、用户照样收到） | **已覆盖** | `E04`：`SendTicket` 作废后放行队列 → 零 `sendTo` |

**仍有缺口**（不属于上述四条，但一条诚实清单必须列）：

1. **真实模型**起草质量/延迟/空返回（`direct` 模式的唯一文案来源），以及**插件级 `direct` 闭环**——`draft-host.ts` 走宿主 `bridge.tagContext()`，本地 mock 拿不到真实模型接缝。插件级闭环因此只用 `turn` 模式跑通（`P01` 因此只能断言到 `submitted`，不能断言平台 `confirmed`）。
2. **真实 QQ** 收件与回执（`message_id` 是否总会回来）。
3. **插件级时间语义**（免打扰/冷却/跨日）：`index.ts` 用 `systemClock`（V-I1），插件级不注入时钟；这些语义已在 gate/worker 层用假时钟覆盖（`G08`–`G13`、`H01`、`H10`）。
4. **两个真实进程**同时跑同一个 `dshHome`（我的"双 Host"与"租约易主"都是同进程多实例）。
5. `maxPerTick > 1` 的调度公平性、7×24 浸泡与账本体积增长。

---

## 9.3 复验轮新发现的缺陷（都已修，都有回归）

### V-P1（P1，已修）全新 `dshHome` 上 contact 引擎**永远不启动**

- **位置**：`src/features/contact/lease.ts` 的 `LeaseKeeper.create()`——`fs.open(lockFile, 'wx')` 之前没有 `mkdir -p` 父目录。
- **链路**：`store.load()` 在"账本不存在且无变更"时不写盘 → `<dshHome>/channel-qq/` 不存在 → `open('wx')` 抛 `ENOENT` → `create()` 的 `catch` 返回 `false` → `take()` 返回 `null` → `acquireLease()` 返回 `null` → 日志说 **`租约在别的实例手里，本实例不推进（多开时的正常状态）`**，之后每拍如此。
- **实测（同一 rig，只差"父目录存不存在"）**：
  - 不预建：`booked=0`、`channel-qq/` 里一个文件都没有、日志只有"租约在别的实例手里"
  - 预建：`booked=1`，日志 `取得租约 epoch=1 → 候选入库(explicit-reminder) → 回合已提交 → 投递完成 submitted`
- **影响**：新装 / 换 `dshHome` / 清过目录的 profile 上，`enabled=true` + 门控全开也**一条都不会发**，而诊断把人往"多开"带。老 profile 因为别的 store 早建过目录而"碰巧正常"——单元测试全绿、真实场景全灭。
- **修复**（实现侧）：① `create()` 里先 `mkdir(path.dirname(lockFile), { recursive: true })`；② 新增 `LeaseCreateError`：只有 `EEXIST` 才算"别人持有"，其它错误码抛出来，`worker` 打 `contact: 锁文件创建失败：…`（同因只记一次），不再伪装成"多开"。
- **回归**：`P00`（修复前红、现在绿）。

### V-P2（P2，已修）`propose` 的查重与入池不是原子操作

- **位置**：`service.ts` 的 `propose`——原来是"先 `findByDedupeKey`，再 `putCandidate`"，两步之间没有互斥。
- **复现**：`Promise.all([propose(input), propose(input)])`（或"`start()` 首拍"与"显式 `tick()`"并发，两个来源同时提同一件事）→ 各自查到"没有" → 同一件事进池两次。生产里 `worker.busy` 会串行化 tick，但两个来源/两个入口并发时仍会撞。
- **修复**：查重与入池在**同一个 `store.write` 事务**里完成（`write` 是读-改-写一次的原子操作），重复时只合并 `evidenceIds`。
- **回归**：`P07`（修复前红、现在绿）。

---

## 9.4 夹具导出清单（`test/fakes/contact.ts`）

给交付材料用——"插件级闭环是怎么装起来的"看这一份就够。

**时间**
- `FakeTimer`（接口）、`FakeClock`（`implements Clock`）：`now/date/setTimeout/setInterval/advance/shift/flush/live/liveCount/cancel 计数`

**平台与外发**
- `SentMessage`（接口）、`segmentText()`、`FakePlatformOptions`、`FakePlatform`（`implements ChatPlatform`；`sent`/`attempts`/`connected`/`failWith`/`failWithError`/`loseReceipt`/`api`/`count()`/`textsTo()`）
- `FakeOutboundQueue`：`hold`/`pushCount`/`push()`/`pending()`/`release()`——**模拟限速队列的等待窗口**（本轮 Q01–Q05、E04 的基础）
- `nodeError(code)`、`oneBotReject(retcode, status)`：造"可判别的网络错误"与"明确拒绝"

**回合 / 注册表**
- `BookedPrompt`、`FakeTurns`（`booked`/`patrols`/`dreams`/`evolves`/`sendsToDm`/`submitOk`/`throwWith`）
- `FakeRegistry`（`get/set/setLastEvent/reads`）

**目录与数据**
- `TempHome`、`tempHome(prefix)`、`contactCandidate(over)`、`contactDelivery(over)`、`contactRuntime(over)`

**配置与宿主**
- `fieldDefaults(CONTACT_GROUPS)`（默认值的唯一来源）、`baseConfig(overrides)`
- `fakeBridge()`、`FakeSubHost`、`fakeSubHost(name, config, dshHome)`（`host`/`bag`/`logs`/`resources`/`with()`）

**等待**
- `settle(rounds)`（只用于让已在队列里的微任务落地）
- `waitUntil(predicate, budgetMs=3000, stepMs=5)`：**真实定时器**驱动，见 9.5 坑 3

---

## 9.5 测试基建又两个坑（第 3、第 4 个）

### 坑 3：`async` 函数返回 promise 会被**扁平化**——测试自己把自己锁死

```ts
// ✗ 会死锁：async 函数 `return pending` 等价于 `await pending`
async function holdInQueue(rig): Promise<Promise<Result>> { return pending }
const pending = await holdInQueue(rig)   // ← 一路等到投递结算；而队列正被握着

// ✓ 用对象包一层
async function holdInQueue(rig): Promise<{ pending: Promise<Result> }> { return { pending } }
```
现象：用例挂到 `--test-timeout` 才报错，**没有任何断言失败信息**（这次我被它骗了 20 分钟，以为实现挂了）。

### 坑 4：串行队列测试里"等什么"必须选对

`boot()` 一开始等的是**锁文件出现**，结果读到"锁在、账本不在"的中间态（锁文件在 `open('wx')` 那一刻就存在，账本要等 `acquireLease` 落盘）。正确做法是等**账本出现**；要等结果就等结果（`waitUntil(() => turns.booked.length >= 1)`），不要假设"调完就有了"——`start()` 的首拍是 fire-and-forget，显式 `tick()` 可能被判"上一轮还在跑"而排到本轮收尾之后。

### 坑 5：别让测试去"赛跑"真实定时器

`ledger-io` 的重试等待默认是"注入时钟 + 一枚 50ms **真实**定时器兜底赛跑"。冻结的假时钟不会自己推进，于是这条路径的**时长**由真实定时器决定 → 全量并发跑（776 条同时抢 CPU）时会漂移，同一份代码单跑绿、全量红。

修法不是放宽断言，而是**加缝让等待可注入**：`retryDelay?: (ms: number) => Promise<void>`，测试传 `async () => {}` → 瞬时重试 → 重试次数变成常量 6，断言可以收紧到 `calls === 6`。

**通用教训**：凡是"测试断言某个次数/某个顺序"，就必须保证这条路径上**没有任何真实定时器参与**。假时钟只解决"被测对象的时间"，解决不了"测试自己的等待"——后者要用 `waitUntil`（真实时间 + 预算），前者要用注入缝。

---

## 9.6 全量数字（复验轮实测）

```bash
cd plugins/dsh-channel-qq
node node_modules/typescript/bin/tsc -p tsconfig.test.json          # 0 错误
node --test --test-reporter=tap "build/lib-test/test/contact-*.test.js"   # 107/107
node --test --test-reporter=tap "build/lib-test/test/*.test.js"           # 全量
```

| 指标 | 第 1 轮 | 复验轮（最终） | 变化 |
| --- | --- | --- | --- |
| contact 专项 | 81 / 81 | **107 / 107** | +26（全部是"修复前会失败"的回归） |
| 全量 tests | 750 | **776** | +26 |
| 全量 pass | 741 | **767** | +26 |
| 全量 fail | 8 | **8** | 同一批条目，逐条同名（分诊见下） |
| contact 相关红 | 0 | **0** | — |
| 三道闸 | — | `tsc` 0 行 / `check-layers` 通过（352 文件）/ `check-size` 通过 | — |

复验轮跑了两次全量，用来区分"真红"与"flaky"：

| 次 | 结果 | 说明 |
| --- | --- | --- |
| 第 1 次（S15/S16 还未注入 `retryDelay`） | 776 / **766** pass / **9** fail | 多出来的第 9 条是 `即时抽取：触发才抽…`（memory-v3，flaky）+ S16 自身受真实定时器漂移影响 |
| 第 2 次（`retryDelay` 定死之后） | 776 / **767** pass / **8** fail | flaky 那条没复现；S15/S16 稳定绿 |

8 条红的分诊（TAP 编号取自第 2 次）：

| TAP | 条目 | 归属 | 备注 |
| --- | --- | --- | --- |
| `not ok 231` | `golden: v2 私聊与注入` | **并行会话** | `src/app/conversation/prompt-composer.ts` 的私聊抬头被另一会话改动；golden 已还原，但该会话的改动还在跑。**不认领** |
| `not ok 292–296` | eval-harness ×5 | **基线已有** | 缺 `eval/` 目录 |
| `not ok 303` | 群文件下载落收件箱 | **基线已有** | 文件名编码 |
| `not ok 52` | `memory-retrieval` | **基线已有** | |
| （本轮未红） | `即时抽取：触发才抽…` | **flaky** | 第 1 次全量复现；`node --test "build/lib-test/test/memory-v3*.test.js"` 单独跑 **13/13 全绿**。与 contact 无关 |

> 第 1 轮那 8 条红（`205`/`266–270`/`277`/`50`）与这一轮是同一批条目，只是 TAP 编号因为新增 26 条用例整体后移（205→231、266→292…），逐条同名。

---

# 第 3 轮：F1–F6 整改回归

> Codex 第二轮结论是**暂不通过**（`design/proactive-message-codex-round2-review.md`），点名三条"测试没测到关键路径"：
> `Q04` 只是重复测冻结、`P01/P03` 证明不了提醒互斥、`E03/E05` 只喂了分类器期望的输入。本轮把 F1–F6 全部补成"会红的回归"。
> contact 专项从 **107 → 118**，全绿。

## 10.1 新增 / 重写的用例

| 用例 | 覆盖 | 断言要点 |
| --- | --- | --- |
| `Q04`（**重写**） | F2 真实租约接管 | 真 `ContactStore` + 真锁文件：`acquireLease` → 领投递（`running` 落盘）→ 入队挂住 → 假时钟推进 181s（租约过期）→ **另一个 store（host-b/2002）接管，epoch 1→2** → 释放队列 → **零 `sendTo`**、结算 `deferred`、`detail` 含 `lease`。并断言"内存里的 epoch 仍是 1"——这正是 F2 说的"只看内存看不出来" |
| `Q04b`（对照） | 同上 | 同样推进时间但**不让任何人接管**（自己续期）→ 照常 `confirmed`。证明拦住它的是"接管"，不是别的 |
| `Q06` | F3 免打扰边界 | 22:59:55（Asia/Shanghai）通过粗筛并入队 → 推进 10s 到 **23:00:05** → 释放队列 → **零 `sendTo`**、`deferred`、`detail` 含 `quiet-hours`。修复前会 `confirmed`（Codex 探针实测过） |
| `Q07` | F3 配置现取 | 入队后把总开关关掉（`config()` 返回活对象）→ 释放 → 零 `sendTo`、`detail` 指向开关 |
| `E06` | F4 真实 OneBot 拒绝结构 | 不手搓异常：**真 `OneBotClient.handleFrame`** 喂 `{status:'failed', retcode:1200, echo}` → 断言 reject 的错误**保留 `retcode`/`status`** → 再把同一个错误喂给发送器 → 判 `failed`（不是 `unknown`） |
| `F5a` | F5 真实端口失败预算 | 真 `createHostDraftPort` + **抛错的假 `llm.stream`** → `reason='draft:failed'`、`called=true`、`draftCallsToday=1`、**`draftFailureStreak=1`**、`lastDraftFailureAt≠null` |
| `F5b` | F5 SKIP 不算失败 | 模型回 `SKIP` → `draft:skip`、`called=true`、预算 +1、**`draftFailureStreak=0`** |
| `F5c` | F5 小时环（**行为级**） | `draftHourlyBudget=1` + 端口回 `skip` → 三拍之后端口**只被调 1 次**。修复前 SKIP 不进小时环 → 会被调 3 次 |
| `F6` | F6 慢草稿 | 真端口 + "起草期间把假时钟推进 40s"的流（> 发送 timeout 30s）→ 仍然**发出去 1 条**、`confirmed`。修复前 deadline 用起草前那一拍 → 判过期 |
| `F5d` | 词表 | `DRAFT_REASONS` 含 `draft:skip` / `draft:no-route`，且全部是稳定短串 |
| `P08` | F1 默认不接管 | `sourceReminders=false`（默认）**即使** `reminders.enabled=false` 也零候选、零提交 |
| `P09` | F1 两把开关都在位 | `sourceReminders=true` + runner 停 → 恰好一条候选（`source='explicit-reminder'`、`dedupeKey='reminder:r-1:<at>'`） |
| `P03`（**重写**） | F1 第二把开关 | `sourceReminders=true` 但 `reminders.enabled=true` → 零候选零提交 |
| `P01`/`P02`/`P05`（**改配置**） | F1 前提 | 显式 `sourceReminders:true`（默认 false 之后它们才有候选可测） |
| `P00`（**收紧**） | V-P1 | 只断言"拿到租约 + 账本落盘 + 无'租约在别的实例手里'话术 + 零提交（默认不接管）"；发送能力交给 P01 |

## 10.2 F1–F6 台账

| # | 缺陷 | 状态 | 我的证据 | 仍有的缺口 |
| --- | --- | --- | --- | --- |
| F1 | 提醒接管把配置开关当 runner 停止事实 | **判据层已覆盖** | `P08`/`P09`/`P03` 三态矩阵（默认不接管 / 两把都到位 / runner 在跑则不接管）；`gate.ts` 的 `reminders-owns` 有 G05 | **runner 侧未联合装配**：我的 `reminders` 是假 `due` 存储，真实 `ReminderRunner` 没有装进来（Codex 指出的正是这点）。所以"contact 与 runner 不会同时投递"只在 gate/source 判据层成立，**端到端互斥未验证**；`contact` 也仍不推进提醒的 `fired`/周期 |
| F2 | 发送前只读内存租约 | **已覆盖** | `Q04`（真锁文件接管，红→绿见 10.3）+ `Q04b` 对照 | 未做两个**真实进程**的接管实验（同进程两实例） |
| F3 | 执行点不是完整门控 | **已覆盖** | `Q06`（跨免打扰）+ `Q07`（中途关开关）+ `Q05`（复核位置） | 冷却/额度/去重/授权的"执行点重跑"只由 `evaluateGate` 同一条实现保证，我没有为每一条各写一个边界用例 |
| F4 | 真实拒绝在适配层丢结构 | **已覆盖** | `E06`（真 `handleFrame` 失败帧，红→绿见 10.3） | 真实 NapCat 的失败帧措辞/嵌套形状未验证 |
| F5 | 草稿失败被当"没话说"、小时环漏记 | **已覆盖** | `F5a`/`F5b`/`F5c`/`F5d` | 真实模型的失败模式（限流、内容拒绝）未验证 |
| F6 | deadline 用了起草之前的时刻 | **已覆盖** | `F6`（慢草稿正面证据，红→绿见 10.3） | 未验证"整条尝试超时"是否该由配置统一表达（设计取舍） |

## 10.3 "修复前红 / 修复后绿"的实测对照（变异实验）

这一轮的用例是**在修复之后**写的，所以我没有"旧代码上的红"这种天然证据。为了不靠嘴说，我做了**变异实验**：
只在 `build/lib-test`（**不动 `src/`**）里把对应修复退化成旧行为，跑同一批用例，再重新编译恢复。

| 变异（只改 build 产物） | 结果 |
| --- | --- |
| `sender.js`：跳过 `verifyOwnership` + 跳过 `liveFacts` + `deadline = req.now + timeoutMs` | **Q04 / Q06 / Q07 三条全红**（其余 16 条仍绿）→ 恢复后 19/19 绿 |
| `sender.js`：仅 `deadline = req.now + timeoutMs`（F6） | **`F6` 红**：`起草慢但合法，实际发了 0 条` → 恢复后绿 |
| `onebot.js`：删掉 `error.status` / `error.retcode` 两行赋值（F4） | **`E06` 红**：`适配层把 retcode 丢了（实际 message=QQ API failed: mock refusal）——分类器只能判 unknown` → 恢复后绿 |
| `sources.ts` 的 `takeoverEnabled` 缺省为 true（F1） | **`P08` 会红**（"默认不接管"那条），见 10.4 说明 |

> 变异实验的做法与边界：只替换 `build/lib-test/` 下的编译产物，跑完立即用 `tsc -p tsconfig.test.json` 重新生成；`src/` 与 git 工作区没有改动。
> F1 那条我没有做变异（会牵动 `sources.ts` + `gate.ts` 两处同源判据），红/绿证据来自 Codex 的独立探针（`design/proactive-message-codex-round2-review.md` 的"实测"段）与 contract-policy 的四格矩阵；我的三条用例覆盖同一张矩阵的三格。

## 10.4 F1 的四格矩阵（与 contract-policy 的 probe 一致）

| `contact.sourceReminders` | `reminders.enabled` | 候选数 | 我的用例 |
| --- | --- | --- | --- |
| false（默认） | true | 0 | （同 `P08` 的邻居格） |
| false（默认） | false | 0 | **`P08`** |
| true | true（runner 在跑） | 0 | **`P03`** |
| true | false（runner 真停） | **1** | **`P09`** / `P01` |

## 10.5 全量数字（第 3 轮）

| 指标 | 第 2 轮 | 第 3 轮 | 变化 |
| --- | --- | --- | --- |
| contact 专项 | 107 / 107 | **118 / 118** | +11（含 3 条重写、4 条改配置） |
| 全量 tests | 776 | **787** | +11 |
| 全量 pass | 767 | **778** | +11 |
| 全量 fail | 8 | **8** | 同一批条目（`242` golden v2 私聊 / `303–307` eval×5 / `314` file-receive / `53` memory-retrieval），逐条同名，只是编号继续后移 |
| contact 相关红 | 0 | **0** | — |
| 三道闸 | 通过 | `tsc` 0 行 / `check-layers` 通过 / `check-size` 通过 | — |

**仍未覆盖（诚实清单，累积）**：真实模型与插件级 `direct` 闭环；真实 QQ 收件与回执；插件级时间语义（`index.ts` 用 `systemClock`）；两个**真实进程**的租约接管；`runner` 与 `contact` 的**联合装配**互斥（F1 只在判据层验证）；提醒生命周期推进（`fired`/周期）未由 contact 接管；`maxPerTick>1` 公平性；7×24 浸泡。

---

# 第 4 轮：撤销提醒接管 + R2–R7 回归

> 第三轮 Codex 判决：**F6 PASS；F1 FAIL；F2–F5 PARTIAL**，新增 4 P1（R1–R4）+ 3 P2（R5–R7）。
> 用户决定：**取消提醒接管**，R2–R7 全修。本轮 contact 侧的改动是"删掉一条走不通的路 + 把剩下六条钉死"。

## 11.1 撤销"接管到期提醒"（含撤回一条上轮的结论）

**撤销理由**（Codex R1，我认同）：`reminders` 插件会**无条件** `runner.start()`，它的 `due()` 读的是同一份存储；
`reminders.enabled` 只是提醒工具的开关，**不是 runner 的停止事实**。所以"把 `sourceReminders` 打开、`reminders.enabled=false`
交给 contact 投递"这件事在标准装配里做不到互斥：runner 仍会从同一存储取同一条 due 直发，而 contact 既不回查源提醒的
`fired`/删除状态、也不推进 `fired`/周期 → 轻则双发，重则 daily/weekly 从第二次起直接漏发。**这条路要通，得先让 runner 服从
可验证的所有权协议**，那是提醒插件自己的改造，不在本轮范围。

因此本轮把 `src/features/contact/sources.ts` 整块删除、`gate.ts` 回到**一律** `drop(reminders-owns)`、
`contact.sourceReminders` 配置项删除。**本轮没有内置的自动候选来源**（见 11.4 缺口）。

### 撤回上轮的一条结论

上一轮我写过 `P03`「`sourceReminders=true` 但 runner 在投递 → 零候选零提交」并标注"修复前会失败"。**这个标注不成立**：
第二轮的 scanner 在 `remindersEnabled=true` 时**本来就**返回 0，所以 `P03` 根本区分不出"新增 `sourceReminders`"有没有生效。
真正能证明"默认隔离"的是 `P08`（`sourceReminders` 缺省 + runner 停 → 仍然零候选）。Codex 这条指正我接受，`P03` 已随撤销一起删除。

### 插件级用例的改写（`test/contact-plugin.test.ts`）

提醒来源没了，闭环改用**直接注入候选**（`service.propose`），仍然覆盖"候选 → 门控 → 提交/发送 → 账本"：

| 用例 | 现在怎么造候选 | 断言 |
| --- | --- | --- |
| `P01` | `service.propose`（`source='follow-up'`，`authorization.kind='standing'` 带 by/at） | 候选入库 → 门控放行 → `turns.bookPrompt` 恰 1 次（文案含 reason）→ 账本 `submitted` + 候选 `consumed` |
| `P02` | 同上，连续三拍 | 同一 `dedupeKey` 只一条候选、只提交一次 |
| `P05` | 同上 + `dryRun=true` | 候选照提、零提交、候选不被消费 |
| `P08` | 装配后**什么都不做** | 默认零候选（本轮无内置来源）、零提交 |
| `P00` | 同上 | 全新 dshHome 上仍能拿租约 + 落账本 + 不抛（V-P1 回归） |
| `P10`（新） | `service.propose` 一条 `source='explicit-reminder'` | 候选**入库但永不出门**：`turns.bookPrompt` 0 次、候选被 `drop(reminders-owns)`（不管配置怎样） |
| `P11`（新，判据级） | 直接调 `evaluateGate` | `explicit-reminder` 在 `enabled/dryRun/allowExternalSend` 全开时仍 `drop/reminders-owns` |

## 11.2 R1–R7 台账

| # | 缺陷（一句话） | 状态 | 我的证据 |
| --- | --- | --- | --- |
| R1 | 显式接管不互斥；文档声明代替不了停止事实 | **已撤销**（不再提供接管） | `P10`/`P11` 钉住"一律 drop"；`P08` 钉住"默认零候选"。**互斥结论不再宣称** |
| R2 | 默认 `turn` 模式完全绕过所有权与门控复核 | 已覆盖 | `R2`：注入"必定 lease-lost"的 `verifyOwnership` + `sendMode='turn'` → `verifyOwnership` 调用 1 次、`bookPrompt` **0 次**、结算 `deferred/lease-*` |
| R3 | 锁校验与发送之间的异步空窗；快照缺失回退内存放行 | **①② 已覆盖；③ 未覆盖** | `R3①` 快照期间跨过截止 → 零 `sendTo`；`R3②` 快照里候选 `undefined`（内存里还有）→ `cancelled`，**不回退内存**。③（outbox 行的 id/epoch/owner/state 不一致）**没有独立用例**：判据在 `index.ts` 的闭包里，不可单独导入——见 11.3 与缺口清单 |
| R4 | 去重排除按 key 整批删，连带排掉别的同键证据 | 已覆盖 | `R4`：`liveFacts.deliveredDedupeKeys` 里放**另一条**同 `dedupeKey` 的 `confirmed` → `sendTo` **0**（修复前 1） |
| R5 | 任意嵌套 `retcode` 能把连接错误提升成可重试拒绝 | 已覆盖 | `R5`：`ECONNRESET + data.retcode=1200 + retcode=1200` → `unknown`；带 `ONEBOT_REJECTION` 标记 → `failed`；`E06` 用**真 `handleFrame`** 失败帧走完整链路 |
| R6 | 调用前异常也扣模型预算；`too-long` 未被完整消费 | 已覆盖 | `R6a`：`currentSelection` 抛错 → `called=false`、`draftCallsToday`/`draftFailureStreak` **都不变**、`draft:no-route`；`R6b`：`{kind:'too-long'}` → `draft:too-long`、`called=true` |
| R7 | 执行点自然过期的候选终态写成 `cancelled`（应为 `expired`） | 已覆盖 | `R7`（`contact-draft`）：direct 模式 + 挂住出站队列，候选在等待窗口里越过 `expiresAt` → 零 `sendTo` 且账本候选 `state === 'expired'` |

## 11.3 三条 gag 说明（不是放宽断言，是把证据边界说清）

1. **`R3③`（outbox 行不一致 → 拒绝）本轮没有用例**：判据在 `index.ts` 的 `verifyOwnership` 闭包里，
   **不可单独导入**。我原本打算在 rig 里复刻同一份判据——后来否掉了：那样测的是"我抄得对不对"，不是实现。
   要真正覆盖它，得让 `index.ts` 把 ownership 判据抽成一个可导入的纯函数（连同 `store.snapshot()` 一起注入），
   那是实现侧的结构改动，不在我的写权限里。**这是缺口，不是通过。**
2. **`Q04`（真实租约接管）曾有一个 rig 缺口**：`holdInStoreQueue` 领的投递 id 是 `d-c-exec`，而 `rig.deliver()` 用的是
   工厂默认 id `d-1`，于是所有权查的是"一条不存在的行"。它仍能验证 `lease-lost`（那一步在查行之前就返回了），但会让
   **"没有 running 行也放行"** 这个洞漏过去——正是 R3③ 说的情况。本轮已把 id 对齐（`CLAIMED_DELIVERY_ID`）。
   **订正（第五轮独立复审 P2-B）**：这里原来写"并补了 R3③ 的两条反例（行缺失 / 行已被结算）"——**那句话不成立，
   对应的用例并不存在**，与 12.5-4 的"仍无独立用例"自相矛盾。R3③ 依旧是缺口，见第 1 条。
3. **变异实验只改 `build/lib-test`**：跑完立即 `tsc` 重新生成，`src/` 不动。第四轮的变异结果见 11.5。

## 11.4 缺口清单（累积，本轮追加两条）

1. **本轮没有内置的自动候选来源**：`sources.ts` 已删除，`contact` 只能由别的子插件/工具经 `service.propose` 送候选。
   也就是说"装上去就会主动关心你"这件事**现在还不成立**——这是本轮撤销接管后的**已知空白**，下一轮要么让 runner 服从
   所有权协议、要么新建一个不依赖提醒存储的来源（聊天空闲、日程、记忆）。
2. **R3③ 的证据边界**：如上，判据形状由 rig 复刻，`index.ts` 那一份没有独立单测。
3. 真实模型与插件级 `direct` 闭环；真实 QQ 收件与回执；插件级时间语义（`index.ts` 用 `systemClock`）；
   两个**真实进程**的租约接管；`runner` 与 `contact` 的联合装配互斥（本轮已改为"不接管"，不再宣称互斥）；
   `maxPerTick>1` 公平性；7×24 浸泡。

## 11.5 "修复前红 / 修复后绿"的实测对照（第四轮变异实验）

做法同第 3 轮：只替换 `build/lib-test/` 下的编译产物，跑完立即 `tsc -p tsconfig.test.json` 重新生成；`src/` 不动。

| 变异（只改 build 产物） | 结果 |
| --- | --- |
| `sender.js`：`sendTurn` 里的 `recheckAtSend` 短路成 `null`（回到 R2 之前：turn 只做粗筛） | **`R2` 红**：`turn 模式必须调用一次执行点所有权校验（修复前 0 次）actual: 0` → 恢复后 24/24 绿 |
| `sender.js`：快照里候选 `undefined` 时 `return null`（回到 R3② 之前：回退放行） | **`R3②` 红**（同批还带红 `R3①`、`Q01`、`Q02`、`Q04`、`Q05`、`Q06`、`Q07`——它们都依赖"复核真的读了盘"） |
| `send-guard.js`：分类器改回"先看任意 `retcode`、忽略标记"（R5 之前） | **`R5` 红**：`ECONNRESET + data.retcode` 被提升成 `failed`；另外 `E03`/`E05`/`D04` 也一起红（它们用的是**带标记**的拒绝，说明标记这条路是唯一的正路） |

一次变异里 `contact-guard` 从 **24/24 绿** 变成 **14 通过 / 10 失败**，失败集合与预期完全一致；恢复后回到 24/24。

> **R4 的变异我没做**：要"退回按 key 整批排除"就必须改 `liveFacts` 的契约（那是 index 侧），改 build 里的过滤等价于自己造假。
> 这一条的红/绿证据来自 Codex 第三轮报告里对修复前的实测（`sendTo=1`）与我这里的反向断言（`sendTo=0` → 通过）。

## 11.6 全量数字（第 4 轮）

| 指标 | 第 3 轮 | 第 4 轮 | 变化 |
| --- | --- | --- | --- |
| contact 专项 | 118 / 118 | **124 / 124** | +6（新增 R2/R3①②/R4/R5/R6a/R6b/R7/P10，删掉 P03/P08/P09 三条随撤销失效的） |
| contact 相关红 | 0 | **0** | — |
| 全量 tests / pass / fail | 787 / 778 / 8 | **793 / 784 / 8** | +6 用例；8 条红与第 3 轮逐条同名，只是编号后移 |
| 三道闸 | 通过 | `tsc` 0 行 / `check-layers` 通过（352 文件）/ `check-size` 通过 | — |

分文件：gate 23 / guard 24 / outbox 37 / draft 7 / recovery 15 / regression 9 / plugin 8 = **124**。

## 11.7 本轮删掉/改写掉的用例（说明为什么不算是"少测了"）

| 用例 | 处置 | 原因 |
| --- | --- | --- |
| `P03`（sourceReminders=true + runner 在跑） | **删除** | 接管功能本身被撤销；且它原本"修复前会失败"的标注不成立（见 11.1 的撤回） |
| `P08`（sourceReminders 缺省 → 零候选） | **删除** | 配置项没了；等价语义由 `P04`（`enabled=false` 零候选）+ 新的 P00 承接 |
| `P09`（两把开关都在位 → 1 条候选） | **删除** | 同上，接管不存在了 |
| `P01`/`P02`/`P05` | **改写** | 候选改为经 `service.propose` 注入；闭环断言（门控 → 提交 → 账本）一条没减 |
| `P10`（新） | **新增** | 判据级：`explicit-reminder` 一律 `drop(reminders-owns)`，装配全开也不出门 |

第 4 轮全量的 8 条红（TAP 编号）：`248` golden v2 私聊（**并行会话**）、`309–313` eval-harness ×5（**基线**）、
`320` file-receive（**基线**）、`53` memory-retrieval（**基线**）。**0 条属于 contact。**

---

# 第 5 轮：Q04 加固 + F41/F42 + P2（最后一轮 I/O 的窗口）

> 触发：Codex 第四轮判 Q04 不合格（复制了一份旧的宽松守卫、投递 id 与领取 id 不一致、R3① 只触发了普通超时），
> 并要求补 F41（最后一轮所有权 I/O 期间租约到期/被接管）、F42（同一窗口里跨免打扰 / 开关被关 / 候选过期）。

## 12.1 Q04 加固（逐条对应 Codex 点名的三处）

| Codex 指出的问题 | 处置 |
| --- | --- |
| `contact-guard` 里的 `verifyOwnership` 是**复制出来的旧宽松守卫**（只判"行存在且 running"），不是生产 `index.ts` 的 `ownershipOf` | **改成与生产逐字同形**：`assertLease` → 快照候选（`candidate:missing` / `candidate:<state>`）→ 投递行 `delivery:missing` / `delivery:id-mismatch` / `delivery:<state>` / `delivery:epoch-mismatch` / `delivery:owner-mismatch`，判据顺序与细节串一一对齐 |
| 领取的投递 id（`d-c-exec`）与被发送的 id（工厂默认 `d-1`）**不一致** → ownership 查的是一条不存在的行 | 引入常量 `CLAIMED_DELIVERY_ID`，领取与发送**共用同一个 id**；`rig.deliver()` 还带上了真实的 `epoch` 与 `leaseOwner`（`ownerOf(store)`），否则新的 `epoch-mismatch` / `owner-mismatch` 判据必然误报 |
| `R3①` 实际只触发了普通超时，没走到"第二次所有权校验" | 重写成真能让"最后一轮 I/O 期间跨过发送截止"的构造（`duringLiveFacts` 钩子里推进假时钟） |

## 12.2 新增用例

| 用例 | 场景 | 期望 |
| --- | --- | --- |
| `F41` | 最后一轮所有权 I/O 期间租约到期 | 零 `sendTo`、`attempted=false`（顺序契约由 `liveSnapshot` 保证：读盘 → 判 → **最后** `assertLease`）。**detail 以实测为准**：接管方会把遗留 `running` 行归约成 `unknown`，所以实际常见 `delivery:unknown`，不是 `lease-lost` |
| `F42①` | 最后一轮 I/O 期间跨进免打扰（22:59:55 入队 → 读盘时 23:00:05） | 零 `sendTo`、`deferred`、detail `quiet-hours` |
| `F42②` | 最后一轮 I/O 期间后台把 `enabled` 关掉 | 零 `sendTo`、detail 指向开关 |
| `F42③` | 最后一轮 I/O 期间候选越过 `expiresAt` | 零 `sendTo`、detail 含 `expired` |
| `R3①`（重写） | 读盘期间跨过发送截止 | 零 `sendTo`，且结算不是 `confirmed`/`submitted` |
| `P2-1` | OneBot 回包**缺 `status`/`retcode`** | 适配层不补字段、不打拒绝标记 → 分类器判 `unknown`（不是可重试的 `failed`） |

注入点：`makeStoreRig` 新增 `duringLiveFacts` 钩子——它在 `liveFacts`（最后一轮真 I/O）里执行一次，
所以"读盘期间世界变了"这件事是被真正触发出来的，不是靠手动 `frozen` 假装。

## 12.3 台账（本轮）

| # | 缺陷 | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| Q04 加固 | 见 12.1 | **已加固（PARTIAL）** | `Q04`/`Q04b` 仍绿：真实锁文件 + 真接管（epoch 1→2）→ 零 `sendTo`。**但归因要改（第五轮独立复审 P2-A）**：零发送实际由"接管把 `running` 行降级成 `unknown`"解释，**删掉租约断言这条仍会绿**；用例跑的是测试里那份 `liveSnapshot` 复制品，生产 `executionSnapshotOf` 没有反面用例 |
| F41 | 读盘后的二次所有权校验（顺序契约：`assertLease` 是那次调用里**最后一个 await**） | **生产代码顺序成立；证据仅到复制品** | `F41`：在 `liveSnapshot` 窗口里把假时钟推过租约有效期（180s+）→ 零 `sendTo`、`attempted=false`。**变异红证据只对复制品成立**：把 `assertLease` 挪到读盘之前 → 这条立刻红（`sendTo=1`）。生产那份判据没有反面用例，**不要**读成"生产路径已自证"（第五轮复审 P2-A） |
| F42 | 最后一轮 I/O 期间的状态变化 | **①②③ 全部已覆盖并转绿** | 三条都以"零 `sendTo`"为唯一硬判据：① 跨进免打扰 → `deferred/quiet-hours`；② `enabled` 被关 → 指回开关；③ 候选越过 `expiresAt` → detail 含 `expired`。**红证据来源见 12.4**（不是我的变异实验） |
| P2-1 | 缺字段回包被打上拒绝标记 | **已覆盖** | `P2-1`：缺 `status`/`retcode` 的回包 → 适配层**不补字段**、`isOneBotRejection(error) === false`、分类器判 `unknown`（不打标记是可重试与否的唯一凭据） |
| P2-3 | 执行点过期的抑制原因写成 `expired:at-send` | **已完成** | `transitions.ts` 的 `lastSuppressedReason` 现在是 `expired`（阶段信息只留在日志与投递 detail）；`R7` 已把断言收紧到 `lastSuppressedReason === 'expired'`，与 `verdictOf`/`dropCandidate` 同口径 |

## 12.4 F42 的红证据来源（诚实说明）

**F42 的三条用例，本仓库的单点变异不足以击穿**。我试过：

1. 把执行点的 `evaluateGate` 重跑短路；
2. 再把 `precheck.finalGuard` / `finalSyncGuard` 一起短路；
3. 三条 F42 **仍然全绿**。

原因不是用例太松，而是这条路上现在有**多层冗余守卫**（本地 `verdictOf` → 盘上 `liveSnapshot` 判定 → 门控重跑 → `precheck` 同步终判）。
一次单点变异只会掉一层，其余各层照样拦下——这是防御纵深，是好事。

因此：**F42 的"修复前红"来自 Codex 第四轮的三条独立探针（实测修复前 `confirmed` / `sendTo=1`），不是我的变异实验**，
这个仓库不再声称能自证 F42。我把这句话写在这里，而不是凑一个变异结果出来。

## 12.5 本轮仍未解决（交给下一轮）

1. **F43**：`turns.bookPrompt` 内部 await 之后无法再观测（代码注释已如实标注，不宣称"绝对无窗口"）。
2. **真实渠道**：真实宿主模型、真实 QQ 收件与回执、真实外发——本轮继续保持关闭，一条真实外发都没有；
   `direct` 模式的插件级闭环因此仍然只能到 `turn`（`P01` 只到 `submitted`）。
3. **跨进程**：`Q04` 的接管是同进程两个 `ContactStore` 实例 + 真锁文件，仍然没有"两个真实进程 + SIGKILL"的实验。
4. **`R3③`**（outbox 行 id/epoch/owner/state 不一致）仍**没有独立用例**：判据在生产 `ownershipOf` 闭包里；
   本轮 Q04 加固把它**逐字照抄进了 rig**，但那证明的是"判据形状正确"，不是"生产那一份没写错"。
   要真正覆盖，得让实现把该判据抽成可导入的纯函数（`precheck.ts` 已经在往这个方向拆）。
5. **无内置自动候选来源**：撤销接管后 `contact` 只能被别的子插件经 `service.propose` 喂候选——
    "装上去就会主动关心你"仍然**不成立**。
6. **F42 的红证据不是自证**（见 12.4）。

### 12.5.1 第五轮 Codex 复审追加（2026-10-29 08:56，见 `design/proactive-message-codex-round5-review.md`）

复审判 **暂不建议启用真实外发**，六项为：F41 **PASS（顺序）**、F42 **PARTIAL**、P2-1 **PARTIAL**、P2-2 **PASS**、P2-3 **PASS**、Q04 **PARTIAL**。它新提三条**可达的行为缺陷**（P1）与六条 P2，本仓库**尚未修**：

7. **R5-1 本进程取消可漏检**：盘快照为 pending 后 `await assertLease`；此间 `service.cancel()` 能写成 `cancelled`（不需要发送租约），assert 只看锁文件仍成功，而 `finalSyncVerdict` 调 `refresh` 却**只取 runtime、丢掉最新 candidate** → 用入口那份 pending 继续发。
8. **R5-2 `status='async'` 可被判可重试**：`{status:'async',retcode:1}` 落进"数值非零即拒绝"→ `failed` → 重试；async 无法证明请求未被接受。
9. **R5-3 崩溃漏扣额度**：`settleDelivery` → `patchCounters` → `patchCandidate` 是三次落盘；死在中间会留下"终态行 + 旧计数"，同键 dedupe 挡得住原候选但**挡不住另一个键**（日额度 1 时，重启后另一条可按计数 0 通过）。
10. P2：生产所有权编排缺负例（Q04 的零发送由"接管把 `running` 降 `unknown`"解释，删掉租约断言仍绿）、`stale:restart` 终态映射分裂、`cancelled` 行与活候选脱节会空烧草稿预算（窄分支）、`llm` getter 抛错无回归、提交期租约持续有效未建立（复审判定**不**单独升 P1）。

> 注：早先这里曾把 `P2-E` 写成"每拍都重新起草、永不自愈"，复审核实后**已收窄**——`submitted/confirmed/unknown` 的同键在起草前就被 gate 拦下，只有当行是 `cancelled` 而候选还活着时才会空烧一次草稿预算，且受日/小时预算与候选过期约束。

## 12.6 收口数字（第 5 轮最终）

| 指标 | 数值 |
| --- | --- |
| contact 专项 | **130 / 130 通过 / 0 失败 / 0 todo**（gate 23 / guard 31 / outbox 37 / draft 7 / recovery 15 / regression 9 / plugin 8） |
| 全量 | **799 tests / 790 pass / 8 fail / 1 skipped** |
| 8 条红 | `254` golden v2 私聊（并行会话）、`315–319` eval ×5、`326` file-receive、`53` memory-retrieval（均基线）——**0 条属于 contact** |
| 三道闸 | `tsc -p tsconfig.verify.local.json` 0 行；check-layers 通过（353 文件）；check-size 通过 |
| 变异红证据 | F41：**仅对 rig 复制品自证**（把 `assertLease` 挪到读盘前 → 立即红），生产判据无反面用例（P2-A）；F42 **不自证**（见 12.4），红证据来自 Codex 探针 |
