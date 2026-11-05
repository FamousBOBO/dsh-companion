# companion-health · 服务层与运维入口契约（A0–A2 + 睡眠 S0–S2）

> 写者：health-service（服务层 + 运维入口）。**接口真相**是 `design/health/INTERFACES.md`；
> 本文写的是**本层实际怎么落地**、边界在哪、怎么验、怎么停、哪些事本轮没做。
> 所有数字都是本机实测（2026-11-03 21:0x–21:1x，Asia/Shanghai），不是估计。
>
> 交付文件：
> `plugins/companion-health/{index.mjs,package.json,lib/{config,service,status}.mjs}`、
> `scripts/check-health.mjs`、`scripts/health-stop.mjs`、本文。

---

## 目录

1. [数据来源与协议冻结](#1-数据来源与协议冻结)
2. [运行形态与生命周期](#2-运行形态与生命周期)
3. [配置：字段、默认值、校验](#3-配置字段默认值校验)
4. [服务门面 API](#4-服务门面-api)
5. [token / uid / 设备标识的隔离边界](#5-token--uid--设备标识的隔离边界)
6. [schema 与迁移](#6-schema-与迁移)
7. [幂等 / 限流 / 退避 / 单飞](#7-幂等--限流--退避--单飞)
8. [故障恢复](#8-故障恢复)
9. [睡眠：预留与「等待首次真实夜间」状态机](#9-睡眠预留与等待首次真实夜间状态机)
10. [本轮关闭的四个能力](#10-本轮关闭的四个能力)
11. [权限矩阵](#11-权限矩阵)
12. [验收入口 `scripts/check-health.mjs`](#12-验收入口-scriptscheck-healthmjs)
13. [停机与回滚 `scripts/health-stop.mjs`](#13-停机与回滚-scriptshealth-stophmjs)
14. [与契约的偏差（逐条）](#14-与契约的偏差逐条)
15. [自测与实测记录](#15-自测与实测记录)
16. [NOT_RUN 清单](#16-not_run-清单)
17. [实时心跳（Pulse）· v0.2.0 追加](#17-实时心跳pulse-v020-追加2026-11-03)

---

## 1. 数据来源与协议冻结

**唯一来源**：本机 sidecar（`tmp/huawei_health` 的 CN 轮廓复制件）暴露的只读 JSON 接口。

| 项 | 冻结值 | 依据 |
| --- | --- | --- |
| 方法/路径 | `GET /api/data?days=<1..30>[&force=1]` | `tmp/HUAWEI_HEALTH_README.md` §8 |
| 默认基址 | `http://127.0.0.1:8765` | 计划 §11.4；`config.collector.baseUrl` |
| 允许的主机 | **仅回环**：`127.0.0.1` / `localhost` / `::1` | 契约 §2；`lib/cn-adapter.mjs` 在开 socket 前拒绝 |
| 鉴权 | 无（sidecar 自己持有华为 token） | 同上 §4 |
| 缓存 | sidecar 内部 15 s；`force=1` 绕过 | 同上 §8 |
| 成本 | 一次窗口 ≈ 7 次云调用 ≈ 1.4 s（30 天窗口 9 次） | 实测 `tmp/health-live-probe.json` |
| 超时 | `config.collector.requestTimeoutMs`，默认 20000 ms | 计划 §11.4 |

**冻结的含义**：本层不新增、不改写、不复刻 sidecar 的协议；`payload` 的字段解释权在
`lib/normalize.mjs`（health-core）。本层只消费 `cn-adapter` 的返回对象：

```
{ ok, httpStatus, latencyMs, fetchedAt, days, payload, redactedToken, errors }
// 失败: { ok:false, errorCode:'non-loopback-refused'|'timeout'|'http-error'|'bad-json'|'unreachable', httpStatus, latencyMs }
```

`redactedToken` 现为
`{ status, minutesLeft, rotated, hostKind, expiresAtText, refreshExpiresAtText }`
（**没有** uid / accessToken / refreshToken）。

**本轮 OAuth 与云端逆向没有重做**：华为 CN 云链路已由 sidecar 真实跑通，本层只做"读本机
sidecar → 归一化入库 → 只读展示/验收"。

---

## 2. 运行形态与生命周期

- Cordis 插件：`plugins/companion-health/index.mjs`
  - `export const name = 'companion-health'`、`export const inject = []`
  - `export async function apply(ctx)`
  - 服务通过 **`ctx.provide('companionHealth', service)`** 发布（服务名固定 `companionHealth`）。
    **不走** `companion-foundation/service-bridge.mjs`（其白名单只有 `companionAgenda` /
    `companionContactShare`）。`provide` 抛错或不存在时**一定**打一行带原因的日志——那正是
    `companion_health_*` 工具永远返回 `health-not-mounted` 的根因，不能静默。
  - `ctx.effect(() => () => service.close())` 注册生命周期；`close()` 不 reject。
- **双次激活安全**（宿主 reload 会再跑一次 `apply`）：模块级单例。第二次 `apply` 复用同一
  `service`（同一个 SQLite 句柄、同一个 interval），只重新 `provide`；`initialize()`/`start()`
  都是幂等的。自测：`apply()` 连调两次 → 返回同一对象、`status().ok === true`、不起第二个轮询。
- 没有数据库 / 没有 health-core 模块 / 数据库被删 → **插件照样挂载成功**，只打一行
  `[companion-health] not ready: <reason> — <中文>`,不抛、不阻塞宿主启动。
- `stop()` 清定时器 + 等在一次在飞同步结束；`close()` = `stop()` + 关库。

状态机（`describe().phase`）：

```
idle ──initialize()──► ready ──start()──► (running, interval 已起)
  │                      │
  └──失败──► failed      └──close()──► closed（此后所有入口 ok:false）
```

`failed` 是**缓存结论**，不会每次调用都重试：重试会在库坏掉时反复锤同一个文件，甚至把运维
刚删掉的库重新建出来。要重试就重启宿主（= 新进程/新实例）。

---

## 3. 配置：字段、默认值、校验

文件：`<home>/health/config.json`（`home` 解析顺序：参数 `home` > `$DSH_COMPANION_HEALTH_HOME` > `<工作区>/home`）。

- **首次**加载时原子写默认值（临时文件 → `fsync` → `rename`），返回 `created: true`。
- 之后**永不静默重写**：运维改过的、`health-stop.mjs` 关掉的，都原样尊重。
- 非法值一律回落默认并在 `warnings[]` 里说明（中文），不抛、不阻止启动。

默认值（与计划 §11.4 逐字段一致）：

```json
{
  "enabled": true,
  "source": "huawei-cn",
  "provider": "huawei_cn_cloud",
  "displayName": "华为运动健康（CN 云）",
  "timezone": "Asia/Shanghai",
  "collector": {
    "mode": "local_http",
    "baseUrl": "http://127.0.0.1:8765",
    "pollMinutes": 15,
    "singleFlight": true,
    "windowDays": 7,
    "backfillDays": 30,
    "requestTimeoutMs": 20000
  },
  "capabilities": {
    "readOnDemand": true,
    "injectHealthContext": false,
    "rememberHabits": false,
    "adjustSchedule": false,
    "proactiveCare": false
  },
  "sleep": {
    "schemaEnabled": true,
    "displayEmptyState": true,
    "waitForFirstRealNight": true,
    "altSourcesEnabled": false,
    "trendMinVerifiedNights": 3,
    "proactiveRulesEnabled": false
  },
  "privacy": {
    "ownerOnly": true,
    "exposeToGroup": false,
    "exposeToBili": false,
    "redactTokens": true
  }
}
```

校验规则（`lib/config.mjs` `validateConfig()`，每条违规都产出一条 `warnings`）：

| 字段 | 规则 | 违规处理 |
| --- | --- | --- |
| `enabled` | 布尔 | 回落 `true` |
| `source` / `provider` / `timezone` | 本轮固定值 | 回落并告警 |
| `collector.mode` | 仅 `local_http` | 回落 |
| `collector.baseUrl` | 合法 http(s) **且主机必须是回环** | 回落 `http://127.0.0.1:8765` |
| `collector.pollMinutes` | 整数 1..1440 | 收敛到区间 |
| `collector.windowDays` | 整数 1..30 | 收敛 |
| `collector.backfillDays` | 整数 1..90 | 收敛 |
| `collector.requestTimeoutMs` | 整数 1000..120000 | 收敛 |
| `capabilities.readOnDemand` | 布尔 | 回落 `true` |
| `capabilities.{injectHealthContext,rememberHabits,adjustSchedule,proactiveCare}` | 布尔，**本轮只能是 false** | 强制 false + 告警 |
| `sleep.schemaEnabled` | 布尔；为 false 也照建表（v1 迁移无条件） | 告警说明 |
| `sleep.altSourcesEnabled` / `sleep.proactiveRulesEnabled` | **本轮只能 false** | 强制 false |
| `sleep.trendMinVerifiedNights` | 整数 1..15 | 收敛 |
| `privacy.ownerOnly` / `redactTokens` | **只能 true** | 强制 true |
| `privacy.exposeToGroup` / `exposeToBili` | **只能 false** | 强制 false |

### 3.1 两套开关的权威关系（lead 裁决，2026-11-03）

- **运行时权威 = `health_consents` 表**；`config.capabilities` 只是**首次种子**。
- 首次初始化时若 `health_meta.consents_seeded` 不存在，就把 `config.capabilities` 这五项
  映射写入授权表，然后写 `health_meta.consents_seeded = {at, configVersion, seeds[]}`。
- 之后改 config **不会**覆盖用户的选择。这条是事故防线：用户关掉授权 → 重启 → 不能被重新打开。
  自测覆盖：关掉 `health.read.on_demand` 后新建实例初始化，读回仍是 `false`。

映射表：

| config 字段 | consents 行 |
| --- | --- |
| `readOnDemand` | `health.read.on_demand` |
| `injectHealthContext` | `health.context.auto` |
| `rememberHabits` | `health.memory.habits` |
| `adjustSchedule` | `health.schedule.adjust` |
| `proactiveCare` | `health.care.proactive` |

`health.connect` / `health.dashboard` / `health.sleep.read` 无配置字段（本轮已启用，默认 on）；
`health.export` / `health.delete` 无配置字段（本轮关闭，默认 off）。

---

## 4. 服务门面 API

`lib/service.mjs` `createHealthService(options)`。`options`：`root`、`home`、`config`（覆盖）、
`fetchImpl`、`now`、`log`，外加两个**增量选项**：`readOnly`（验收/CLI 用）与 `modules`
（仅测试接缝）。

| 方法 | 同步? | 会联网? | initialize 失败时 | 说明 |
| --- | --- | --- | --- | --- |
| `initialize()` | 异步 | 否 | 返回 `{ok:false, code:'health-db-unavailable', reason, message}` | 幂等；并发调用共享同一个 promise |
| `start()` | 异步 | **是**（立刻 fire-and-forget 一次 `syncNow`） | `ok:false` | 起 `pollMinutes` 定时器并 `unref()`；重复调用返回 `already:true` |
| `stop()` | 异步 | 否 | `ok:true` | 清定时器；等在一次在飞同步结束 |
| `close()` | 异步 | 否 | `ok:true` | `stop()` + 关库；之后一切入口都是 `ok:false` |
| `isRunning()` | 是 | 否 | `false` | 有定时器才算 running |
| `status()` | 是 | 否 | typed 拒绝 | 契约 §11.1 形状，见 §4.1 |
| `sources()` | 是 | 否 | typed 拒绝 | 契约 §11.2（委托 `summaries.buildSources`） |
| `today({date})` | 是 | 否 | typed 拒绝 | 契约 §11.3 |
| `trend({metric,days})` | 是 | 否 | typed 拒绝 | 契约 §11.4；metric 白名单，days 1..30 |
| `sleep({date,days,includeStages})` | 是 | 否 | typed 拒绝 | 契约 §11.5 |
| `syncNow({days,force,reason})` | 异步 | **是** | typed 拒绝 | 采集的唯一入口；返回 ingest 结果 + `ok` |
| `probeSource({days,force})` | 异步 | **是**（增量） | **仍会探测** | 验收用单次只读探测；不写库 |
| `backup({dest})` | 异步 | 否（增量） | typed 拒绝 | `{ok,path,bytes,at}`；默认 `<home>/health/backups/health-<stamp>.db` |
| `heartbeat()` | 是 | 否 | `{ok:false, initialized:false, ...}` | `{at,running,lastRunAt,nextAllowedAt,consecutiveFailures,rateLimitedUntil}` |
| `consents()` | 是 | 否 | typed 拒绝 | **裸 map** `{'health.connect':true, …}`，与 `status().consents` 同一形状（授权闸直接取值，见 §14-13） |
| `consentsDetail()` | 是 | 否 | typed 拒绝 | 展示用：`{ok, consents, capabilities, notEnforced, seed}`（增量，studio 用它） |
| `setConsent(cap, on)` | 异步 | 否 | typed 拒绝 | 未知能力 → `code:'health-consent-unknown'` |
| `describe()` | 是 | 否 | 可用 | `{name,version,sourceId,dbPath,configPath,root,home,readOnly,phase,modules,config}` |
| `lastIntegrity()` | 是 | 否 | 可用 | 在内存里的最后一次校验结果（增量，验收用） |

**所有读方法都同步、只读 DB、绝不发网络**（自测用"适配器调用计数不变"断言过）。
**所有 `ok:false` 都是 `{ok:false, code, message}`**，`message` 是中文短句，不含异常原文、不含 payload。

### 4.1 `status()` 的形状

严格按契约 §11.1：`ok / schemaVersion / generatedAt / source{id,provider,displayName,enabled,auth{status,expiresAt,refreshExpiresAt,minutesLeft,rotated},lastSuccessAt,lastErrorCode,freshness{status,newestSampleAt,ageMinutes}} / collector{mode,baseUrl,pollMinutes,windowDays,running,singleFlight,lastRunAt,nextAllowedAt,consecutiveFailures,cooldownUntil,rateLimitedUntil} / db{path,journalMode,integrity,sizeBytes,observations,workouts,devices,dailySummaries,sleepSessions,sleepStages} / sleep{availability,sessions,lastSessionAt,stageFidelity,firstNightPending} / consents{} / faults[]`。

- `faults[]` 每条 `{code, message, at}`；来源是最近 5 条 `health_sync_runs` 里
  `status ∈ {error, partial, rate_limited}` 的、`health_sources.last_error_code`、限流状态、
  连续失败 ≥3、DB 完整性失败。`message` 是固定中文文案表，**不含 detail_json、不含 payload**。
- **`status()` 里绝不跑 `PRAGMA quick_check`**：integrity 有 60 s TTL 缓存，镜像在
  `health_meta.last_integrity`；过期只**投递一次后台刷新**（`setTimeout(...,0).unref()`），
  当次调用返回缓存值。实测 20 次连续调用**平均 0.20 ms**（自测断言 `< 100ms`）。
- `db.integrity ∈ ok|failed|unknown`；`unknown` = 还没有任何一次校验结果（新库或只读实例且从未校验）。

---

## 5. token / uid / 设备标识的隔离边界

**谁能看到什么**

| 位置 | 看得到 | 看不到 |
| --- | --- | --- |
| 本层与 DB | `redactedToken`（status/minutesLeft/rotated/hostKind/两个到期时间文本） | accessToken、refreshToken、明文 uid、设备 MAC/sn/udid |
| `status().source.auth` | 状态 + 到期时间 + 剩余分钟 | token 本体、uid |
| `check-health --json` | 同上 + `accountHint`（**若**上游给了，只保留前 4 位 + `…`） | token 本体、完整 uid、设备标识 |
| `check-health` 人类输出 | 到期时间/剩余分钟/轮廓 | token、uid、设备标识 |
| 日志（`[companion-health] ...`） | 固定 code、耗时、条数、路径 | payload、token、uid、设备标识、SQL |
| `health_raw_refs.payload_json` | 由 `cn-adapter` 脱敏后的 payload | token/uid/MAC（适配器 `assertNoSecrets` 兜底，命中就整窗拒绝） |

**永久看不到的**：QQ 群、非主人私聊、B 站侧、任何外发通道。`privacy.exposeToGroup` /
`privacy.exposeToBili` 被强制 `false`，且**本轮没有任何代码路径**读它们。

本层自己还能再说一遍：`longest` 之外的凭证来源全被切断——本层从不读 `payload.token.uid`，
`auth_snapshot` 只写
`{status, expiresAt, refreshExpiresAt, minutesLeft, rotated, hostKind, at}`（全是数字/枚举），
`health_sources` 里没有凭证列。验收脚本的自测断言了输出里不出现
`access_token / accessToken / refresh_token / refreshToken / mac / udid / sn / <明文 uid 样本>`。

---

## 6. schema 与迁移

- 库：`<home>/health/health.db`，**WAL**。由 `lib/db.mjs` 打开（health-core 拥有 schema）。
- 迁移：`PRAGMA user_version` 递进，v1 建全部表；`openHealthDb({..., migrate:true})` 在打开时
  跑一次，`migrate()` 幂等可再跑。本层**不写**任何 DDL。
- 表清单（v1，字段见契约 §4）：`health_meta`、`health_sources`、`health_sync_runs`、
  `health_observations`、`health_workout_sessions`、`health_devices`、`health_daily_summaries`、
  `health_sleep_sessions`、`health_sleep_stages`、`health_consents`、`health_care_candidates`、
  `health_raw_refs`。
- **本层写 `health_meta` 的三个键**（都是本层职责，且已在 `summaries.mjs` 侧核对过读取）：

| key | 内容 | 读者 |
| --- | --- | --- |
| `auth_snapshot` | `{status, expiresAt, refreshExpiresAt, minutesLeft, rotated, hostKind, at}` | 本层 `status()`；`summaries.buildSources` 的 auth 卡 |
| `last_integrity` | `{state, at, quickCheck, foreignKeyViolations, durationMs}` | 本层 `status()` 的 integrity 缓存 |
| `consents_seeded` | `{at, configVersion, seeds:[{capability, enabled}]}` | 本层（一次性播种标记） |

- 本层**不写** `health_observations / workouts / devices / summaries / sleep_* / raw_refs /
  sync_runs / sources / consents`——那是 `ingest` 与 `consents` 的写入路径。本层对它们只读。
- 只读实例（`readOnly:true`，即 `check-health`）打开库时传 `migrate:false`：
  **读一个库不能顺手给它建表**；没有 `health_meta` 表就如实报 `not-initialized`。
  自测断言"只读实例读完库文件字节不变"。

---

## 7. 幂等 / 限流 / 退避 / 单飞

分两层，边界清楚：

| 机制 | 归属 | 本层做了什么 |
| --- | --- | --- |
| 内容幂等（同 `source_key+kind+sample_at+revision` 不重复插入；内容变才升 revision） | `ingest` | 直接透传；实测连续两次 `syncNow()` 行数不翻倍（22 项自测里的"重复 syncNow 幂等"） |
| 单飞（并发 `syncOnce` 只有第一个真跑，其余 `skipped`/`busy`） | `ingest` | `start()` 的 interval 只有一个；`stop()` 前等在飞那次结束 |
| 限流识别（`errors[]` 1101 / HTTP 429 → `rate_limited`） | `ingest` | 把 `isRateLimited()/cooldownUntil()` 透出到 `collector.rateLimitedUntil`、`faults` |
| 指数退避 60→120→300→600 s 封顶 | `ingest` | `collector.nextAllowedAt` / `cooldownUntil` 透出 |
| 轮询节拍 | 本层 | `pollMinutes`（默认 15）→ `setInterval(...).unref()`；最小 60 s |
| 单次窗口 | 本层 | `windowDays`（默认 7），`syncNow` 参数收敛到 1..30 |
| 快速连续 `syncNow` | 本层 | 不额外禁止（studio 侧有 5 分钟冷却，属 studio-api）；`ingest` 的单飞会把它变成 `skipped` |

**为什么本层不自己实现退避**：两处退避必然打架（一份说"等 5 分钟"，另一份说"现在就试"），
最终表现为限流下反复打云。退避只有 `ingest` 一个实现，本层只读它的结论。

---

## 8. 故障恢复

失败永不抛给调用方，收敛成可读状态：

| 故障 | 收敛结果 | 恢复方式 |
| --- | --- | --- |
| sidecar 没起 / 超时 / 非 JSON | `sync_runs.status='error'` + `error_code`，进 `faults` | sidecar 起来后自动恢复（下一轮） |
| 云端限流 1101/429 | `status='rate_limited'` + `next_allowed_at`，进 `faults` | 退避到期后自动恢复 |
| 华为 token 失效（1002/1004/1005/20020001/20020003/20010004） | `health_sources.last_error_code` → `source.auth.status='required'` | 需要人工重新登录 sidecar |
| 数据库打不开 / 迁移失败 | `initialize()` → `failed` + `reason`（`open-failed`/`migrate-failed`） | 修库后重启宿主 |
| 数据库不存在 | `reason='not-initialized'`，不创建 | 首次成功同步后自动建 |
| 完整性校验失败 | `db.integrity='failed'` + `faults[db-integrity-failed]` | 用 `backup()` 留证，人工排查 |
| 某轮只有部分成功 | `status='partial'`，进 `faults` | 下一轮补齐（幂等） |
| 备份写失败 | `code:'health-backup-failed'` | 检查磁盘/权限 |

**重启不丢"最近一轮"**：`heartbeat()` 的 `lastRunAt` 在 `initialize()` 时从
`health_sync_runs` 补种一次（O(1) 条），之后由 `syncNow` 更新；不在心跳路径上做排序查询。

---

## 9. 睡眠：预留与「等待首次真实夜间」状态机

硬原则：**没有就不编**。契约 §7 规则 1（只有聚合时长绝不许编起止）在 DB 层由
`health_sleep_sessions.start_at/end_at` 可空来表达，本层只**读数并如实标注**。

`sleep.availability`（契约 §11.1 枚举，本层只透传 `sleep.classifyAvailability()` 的结论）：

```
无任何睡眠行 ──(waitForFirstRealNight:true)──► awaiting_first_night
                                            └─(false)──► no_data
有行但无可信起止 ─────────────────────────────► partial
有行且有可信起止 ─────────────────────────────► present
```

| 状态 | 何时进入 | 本层与 UI 的义务 |
| --- | --- | --- |
| `awaiting_first_night` | 0 条 session，且开启"等待首次真实夜间"（默认） | 明说"等待首次真实夜间记录"，**不生成任何睡眠数据**、不显示假图表 |
| `no_data` | 0 条 session 且不等待 | 同样明说没有数据 |
| `partial` | 有 session 但没有可信起止（聚合时长型）或阶段不全 | 只报汇总分钟与 `stageFidelity`，不补时间轴 |
| `present` | 有可信起止 | 可展示会话/阶段；阶段缺失的部分留白 |

实测（本机 2026-11-03）：sidecar `sleep_rows` 恒为 0，`health[].sleep` 不返回类型 9 →
`availability='awaiting_first_night'`，`sessions=0`，`lastSessionAt=null`，
`stageFidelity=null`，`firstNightPending=true`。等手表把某一晚同步到云、sidecar 返回 sleep 行之后，
无需改代码即可自动变成 `partial`/`present`（这条链路本轮只做"预留 + 如实标注"，**没有**任何
补数据、补 REM、补评分的代码）。

`config.sleep.trendMinVerifiedNights`（默认 3）是**产品参数**：少于 3 个可信夜晚不出趋势结论，
它不代表任何医学判断。

---

## 10. 本轮关闭的四个能力

`health.context.auto` / `health.memory.habits` / `health.schedule.adjust` / `health.care.proactive`：

- 配置层：`capabilities.{injectHealthContext,rememberHabits,adjustSchedule,proactiveCare}` 只能
  false（写入即被强制回落 + 告警）。
- 授权层：`health_consents` 里可以被人为置 true（那是 §10 允许的写 API），但**本层没有任何
  分支读它**——`status().consents` 只原样透出，`service.consents().notEnforced` 明确列出这四项，
  `setConsent` 返回 `enforced:false`。
- 授权读数只有两个入口：`consents()`（**裸 map**，给闸用）与 `consentsDetail()`（给面板看
  `notEnforced`）。两者都不读那四项来驱动行为——它们只被"显示"。`status().consents` 与
  `consents()` 是同一份形状，逐键相同（回归测试断言 `deepEqual`）。
- 代码层：本轮**不写**任何注入、记忆、改日程、主动外发的代码路径。没有"以后可能会开"的暗门。
- `health.export` / `health.delete` 同理：默认 off，本轮无实现。

---

## 11. 权限矩阵

| 通道 | 谁能用 | 能拿到什么 | 硬限制 |
| --- | --- | --- | --- |
| Studio HTTP `/api/companion-health/*` | 本机 studio 会话（owner-only） | `status/sources/today/trend/sleep`、`POST sync`、`POST maintenance` | 只读路由不联网；任何路由不返回 token/uid/MAC/raw payload |
| Foundation 工具 `companion_health_*` | **主人私聊**（由既有 `identity.resolve` 强制）+ `health.read.on_demand` | 五个只读工具 | 群/他人 QQ 会抛（不 catch 掉）；授权关闭 → `health-read-denied`；服务缺失 → `health-not-mounted` |
| `scripts/check-health.mjs` | 本机运维（本机进程、只读） | 状态/新鲜度/完整性/睡眠可用性/心跳/鉴权/故障；`--probe` 加一次真实探测 | 不启动轮询、不 sync、不建库建配置；只打码后的账号提示 |
| `scripts/health-stop.mjs` | 本机运维 | 改 `enabled`、读最近一轮 | 不杀进程、不碰宿主、不删库、不动授权表 |
| QQ 群 / 非主人私聊 / B 站 | —— | **无** | 本轮没有任何外发代码路径 |
| 日志 | 本机运维 | 固定 code / 耗时 / 条数 | 不含 payload/凭证/uid/设备标识 |

---

## 12. 验收入口 `scripts/check-health.mjs`

```powershell
node scripts/check-health.mjs                      # 人类可读（默认不联网）
node scripts/check-health.mjs --json               # 单行 JSON
node scripts/check-health.mjs --probe --json       # 加一次真实 sidecar 探测
node scripts/check-health.mjs --home <dir>         # 指定 home（默认 $DSH_COMPANION_HEALTH_HOME 或 <工作区>/home）
node scripts/check-health.mjs --days 3 --probe      # 探测窗口 1..30
node scripts/check-health.mjs --exit-zero           # 强制 0 退出
```

- 直接 `import` `plugins/companion-health/lib/service.mjs`，建**只读实例**（`readOnly:true`）：
  不 `start()`、不 `syncNow()`、不创建 `home/health/`、不迁移。允许用 `import.meta.url` 相对
  定位插件路径，没有硬编码盘符。
- 输出内容：健康源状态、最近样本时间与新鲜度、DB integrity（含校验时刻）、sleep availability、
  服务心跳、鉴权状态（`valid/expiring/expired/required` + 剩余分钟）、故障摘要；`--probe` 追加
  步数/心率/压力/血氧/实时值/训练/设备台数/睡眠行数/鉴权剩余。
- **退出码**：`0` = 健康（有样本、integrity≠failed、无 fault）；`1` = 不然；`--exit-zero` 强制 0；
  未知参数 `2`。`--json` 里也镜像 `exitCode` 与 `ok`/`reason`。
- `reason` 只出现在 check-health 自己的报告里（**不污染** service 契约）：
  `ready | awaiting_data | degraded | not-initialized | modules-missing | service-unavailable | status-failed`。
  其中"DB 不存在"=`not-initialized`（`dbExists:false`），"DB 在但 0 条样本"=`awaiting_data`
  （`dbExists:true` 且 `counts` 全 0）——两者可区分。
- 脱敏：不打印 token、不打印完整 uid、不打印任何设备标识（`uniqueId/devId/mac/sn/udid` 全部不出现）。

---

## 13. 停机与回滚 `scripts/health-stop.mjs`

```powershell
node scripts/health-stop.mjs                       # 关采集：enabled:false（原子写，先备份）
node scripts/health-stop.mjs --status              # 只读：当前 enabled + 最近一轮 sync
node scripts/health-stop.mjs --status --json
node scripts/health-stop.mjs --restore "<bak>"     # 用备份恢复（会先把当前配置另存）
node scripts/health-stop.mjs --home <dir> --json
```

行为：

1. 只改 `<home>/health/config.json` 的 `enabled`，**其它键原样保留**（不规范化、不重排）。
2. 写之前先备份成 `config.json.bak-<YYYYMMDDTHHMMSS>`；命名冲突时自动加 `-1`、`-2`
   （同一秒内"关闭→回滚"不会互相覆盖，也不会把要恢复的那份覆盖掉）。
3. 打印"还差一步"：**宿主进程里已有的定时器要等桌面宿主 reload/重启才彻底卸载**。脚本不杀进程、
   不碰 host 进程。
4. 打印一条可复制的回滚命令。
5. `--status` 用只读服务读最近一轮 sync；health-core 缺位时明确说"服务未就绪"，不猜。

停机后的实际效果：`start()`/`syncNow()` 立刻返回 `{ok:false, code:'health-disabled'}`；
已入库的数据仍然只读可查；`check-health` 仍能报告状态。

---

## 14. 与契约的偏差（逐条）

| # | 偏差 | 为什么 | 影响 |
| --- | --- | --- | --- |
| 1 | `capabilities` 只有 5 个键（`readOnDemand/injectHealthContext/rememberHabits/adjustSchedule/proactiveCare`），不是十个 | lead 裁决 2026-11-03：十项能力的权威在 `health_consents` 表 | 无；映射表见 §3.1 |
| 2 | 新增 `health_meta.consents_seeded` 一次性播种标记 | 防止"用户关了授权、重启又开" | 无；纯增量元数据 |
| 3 | health-core 模块用**动态 `import()`** 加载（契约默认静态 import） | 模块缺失不许炸宿主 composition；同时给测试一个 `modules` 接缝 | 首次 `initialize()` 多几毫秒；不影响行为 |
| 4 | `createHealthService` 增加 `readOnly` / `modules` 选项 | `check-health` 必须只读；测试必须能替换网络那一段 | 纯增量；默认值等于契约行为 |
| 5 | 服务门面增加 `probeSource()` / `backup()` / `lastIntegrity()` | `check-health --probe`、studio `maintenance backup`、验收需要 | 纯增量，不影响 `syncNow` 唯一网络入口的规则（`probeSource` 是验收专用只读探测） |
| 6 | `status().source.auth.status` 里 `required` 由本层推导 | 契约 §5 只允许 adapter 给 `valid/expiring/expired/unknown`；"被云端拒绝"只能从 `health_sources.last_error_code ∈ {1002,1004,1005,20020001,20020003,20010004,auth-required,unauthorized}` 推出 | 无；判定依据写死在 §8 |
| 7 | `collector.cooldownUntil` 与 `rateLimitedUntil` 同源 | `ingest` 只有一个冷却概念（`cooldownUntil()`） | `rateLimitedUntil` 仅在 `isRateLimited()` 为真时非空 |
| 8 | `integrity` 走 60 s 缓存 + 后台刷新，可能"滞后于此刻" | `PRAGMA quick_check` 在大库上很慢，`status()` 必须 <100 ms | 报告里带 `integrityCheckedAt`，滞后是可见的 |
| 9 | `sleep.lastSessionAt` 对"聚合时长型"（无起止）会话为 `null` | 不编造时间（契约 §7 规则 1） | `sessions` 计数仍非 0，与 `availability='partial'` 一起表达"有数据但不可信" |
| 10 | `--probe` 失败不改退出码 | 退出码语义按任务约定只由"fault / db 不 ok"决定 | `probe.ok=false` + `notes` 里明确写失败原因 |
| 11 | `summaries.buildSources` 用对象参数调用 | 实际实现是 `buildSources({db,config,nowMs})`（契约 §9 写的是位置参数） | 已按实现对齐 |
| 12 | `health_meta` 多写 `auth_snapshot` / `last_integrity` | 让 `status()`/`buildSources` 在重启后仍能报鉴权与完整性，不用重跑 | 纯增量；`summaries.mjs` 已按同名键读取（已核对）；键形状已写进 INTERFACES §12 |
| 13 | **`consents()` 回到裸 map**（曾一度返回 `{ok,consents,capabilities,notEnforced,seed}` 信封，已修）；多出来的展示数据挪到 `consentsDetail()` | 信封形状让 `service.consents()['health.read.on_demand']` 取到 `undefined`，而授权闸写的是 `=== false → deny`，`undefined !== false` → **fail-open（关了授权照样读）**。契约 §12/§11.1 本来就是裸 map，这是回到契约 | 现在裸取恒为布尔；读取失败是 typed 拒绝（**不是半张 map**），未初始化时返回 `{ok:false, code:'health-db-unavailable'}`，闸与读都会各自拒绝。回归测试：`tmp/health-svc-selftest.mjs` 的"consents() 是裸 map"与"未初始化时是 typed 拒绝"两条 |

---

## 15. 自测与实测记录

### 15.1 服务层自测（真实 health-core 模块 + 只有适配器是假的）

`node tmp/health-svc-selftest.mjs` → **22/22 passed**（临时脚手架，不在交付范围）。
覆盖：配置默认值/校验回落/首次原子写、真迁移 0→1、consents 只播种一次、`status()` 形状与
§11.1 逐键对齐、`status()` 平均 0.20 ms、真实归一化入库、重复同步不翻倍、`start()` 只一个
interval、失败收敛成 fault、`backup()` 可用、读路径零网络、非法入参 typed 拒绝、输出无凭证、
`close()` 后全 `ok:false`、重启后 `heartbeat().lastRunAt` 仍在、只读实例不建文件/不改字节、
`apply()` 连调两次同一实例、`summarizeProbePayload` 对畸形输入不抛、`maskUid` 只留 4 位。

### 15.2 真实链路（sidecar 活着，2026-11-03 21:16）

一次真实 `syncNow()`（`GET /api/data?days=7`）：

```
status   ok      inserted 23
计数     observations 9 / workouts 2 / devices 9 / dailySummaries 9 / sleep 0 / sleep_stages 0
新鲜度   delayed（最新样本 2026-11-03 20:19，约 57 分钟前）
鉴权     valid，剩余 37–38 分钟，refreshExpiresAt 2027-05-02T11:04:43Z，rotated=false
DB       wal / integrity ok / 约 164 KB
睡眠     awaiting_first_night（0 条）
faults   []
```

`--probe` 实测（同一次）：

```
HTTP 200   7 次云调用   冷 1.68 s / 命中 sidecar 缓存 32 ms
步数 1112 / 864 m / 53.1 kcal（活跃 3 h，中高强度 1 min，目标 10000）
心率 avg 95 / max 112 / min 58 / resting 79
压力 avg 65 / max 69 / min 61 / 测量 6 次
血氧 avg 97.11% / max 99 / min 95
实时 心率 95 bpm @20:19、压力 65 @20:15、血氧 99% @20:12
训练 2 条（最近 11-03 17:13 hill 2 min）  设备 9 台  睡眠 0 行 → no_data
```

以上与 `design/health/INTERFACES.md` 开头记录的基线真值**逐项一致**（步数 1112、心率 95/112/58/79、
压力 65/69/61、血氧 97.11/99/95、训练 2 条 `sport_type:2`、设备 9 台、睡眠 0 行）。

### 15.3 真实 `home/`（尚未初始化）

```
node scripts/check-health.mjs --json
→ ok:false, reason:not-initialized, dbExists:false, exit 1（清楚说明"还没有采集数据"，不崩）
→ 事后核对：home/health/ 未被创建
```

### 15.4 验收命令

```powershell
node scripts/check-health.mjs --json
node scripts/check-health.mjs --probe --json
node scripts/health-stop.mjs --status --json
node --check scripts/check-health.mjs
node --check scripts/health-stop.mjs
node --check plugins/companion-health/index.mjs
```

`package.json` 的 test 脚本用 glob（`node --test test/*.test.mjs`），不依赖
`node --test <目录>`（Node v24/Windows 上会把裸目录当模块入口而失败）。

---

## 16. NOT_RUN 清单

本轮**没有**执行、也**没有**写代码的事：

1. **真实桌面宿主挂载**（`home/profiles/desktop/cordis.patch.yml` 接线属 lead）。
   本地只验了 `apply()` 在假 ctx 下连调两次；没有在真实宿主里跑过 reload。
2. **真实 `home/health/health.db` 的首次生成与长期轮询**：只在临时 home 里跑过真实链路同步。
3. **Studio HTTP 路由 / UI 面板**（studio-api、studio-ui 的活）：本层只提供服务门面。
4. **Foundation 工具接线**（`health-tools.mjs` 属 foundation-tools）：本层只保证
   `ctx.provide('companionHealth')` 与服务名。
5. **睡眠真实数据**：云端至今 0 条睡眠记录，`present`/`partial` 分支**没有真实数据跑过**，
   只有契约级状态机与分类函数（health-core 的测试覆盖）。
6. **限流/退避的真实触发**：只在自测里用失败适配器模拟过，没有真的把华为云打到 1101。
7. **token 过期/重新登录流程**：没有让真实 token 过期过；`required` 分支只做代码级推导。
8. **`backup()` 的恢复演练**：只验证了产物存在且大小 >0，没有做"用备份替换主库并复读"的演练。
9. **多进程并发**：没有两个宿主进程同时打开的实测（SQLite WAL + `busy_timeout` 由 health-core 决定）。
10. **`health.context/memory/schedule/care`**：本轮完全未实现（见 §10）。
11. **Health Connect / Health Sync / Gadgetbridge / 其它睡眠来源**：未接入。
12. **git 操作、`npm install`**：均未执行。

---

## 17. 实时心跳（Pulse）· v0.2.0 追加（2026-11-03）

> 上游需求：主人「用蓝牙心率广播做一点有趣的事情，NSFW」。
> **接口与注入行的唯一真相是 [`design/pulse-bond-20261103.md`](../../design/pulse-bond-20261103.md) §3–§7**，
> 本节只写这一层**实际怎么落地**、边界在哪、怎么验。

### 17.1 它是什么 / 不是什么

- **是**：BLE 心率广播（HRS `0x180D` / `0x2A37`）→ 本机 sidecar（`sidecars/ble-heart-rate/`，127.0.0.1:8151）
  → 本服务的 `pulse` 子系统 → ①`companion_pulse` 工具（foundation）②每回合注入行 ③Studio 心跳卡片。
- **不是**：不是医疗监测，不做任何医学结论；不是云端能力（一帧心率都不出本机）；不是群聊能力
  （`identity.resolve` 只放行桌面主人与 `qq-dm-<owner>`，群会话在工具入口就抛错）；不保存原始心搏曲线。

### 17.2 三道闸（缺一不会有数字进提示词）

| 闸 | 位置 | 默认 | 关掉后的表现 |
|---|---|---|---|
| `pulse.enabled` | `home/health/config.json` | `true` | 所有 pulse 方法返回 `pulse-disabled`，注入行为空 |
| `health.pulse.live` | `health_consents` 表（唯一权威） | 开（`DEFAULT_ON`） | 返回 `pulse-denied`，注入行为空 |
| 会话 | `companion_pulse action=start` / Studio 按钮 | 无会话 | 返回 `pulse-no-session`，注入行为空 |

sidecar 本身还得手动起（`start-sidecar.ps1`），所以"没在测"是正常静息态：**空闲时不扫描、不轮询、不连 BLE**，
注入行为空，聊天与其它能力零影响。会话只有三种开法：`companion_pulse action=start`、Studio 的开始按钮、
或者主人自己说了算的 `minutes`（定时会话）。

### 17.2.1 会话生命周期（2026-11-04 主人定："不用窗口"）

1. **无窗口**：`start` 不带 `minutes` → `session.mode='device'`，`endsAt/minutes/remainingMs` 全 `null`；
   显式给 `minutes`（5–120 夹取）才是 `mode='timer'`。
2. **按需扫描**：`start` 是唯一触发扫描的入口（`GET /api/state` → 没连上就 `POST /api/connect`，sidecar 在那里扫一轮），
   等到第一拍读数才开会话；连不上 → `{ok:false, code:'pulse-unreachable', errorCode:'device-not-found'|'connect-timeout'}`，
   **绝不**开空会话。挂载与空闲期间不扫描、不轮询。
3. **断开即收口**：最后一拍静默 > `deviceOffMs`（默认 30 s，含 sidecar 不可达）→ `stop_reason='device-off'`，
   注入行当轮消失，轮询定时器停。`stop` 额外 `POST /api/disconnect` 释放 BLE。

### 17.3 配置（`pulse` 段，校验风格同 §3）

```json
"pulse": { "enabled": true, "baseUrl": "http://127.0.0.1:8151", "deviceLabel": null,
           "pollMs": 1000, "deviceOffMs": 30000, "connectTimeoutMs": 8000, "inject": true, "maxChars": 200 }
```
`baseUrl` 非 loopback → 回落默认 + 关键 `warnings`（`config.mjs` 与 `pulse-adapter.mjs` 双重拒绝）。
`deviceLabel` 只是**显示别名**（设备不上报名字时用它）；"连哪个设备"由 sidecar 决定
（`start-sidecar.ps1 -NameHint / -Address`），这一层不重复配置。
`pollMs` 夹在 250–10000；`deviceOffMs` 夹在 10000–300000；`connectTimeoutMs` 夹在 3000–30000；`maxChars` 夹在 80–400。
`sessionMinutes` **已删除**（会话不再有默认时长）。

### 17.4 门面 API 追加（`service.mjs`）

| 方法 | 说明 |
|---|---|
| `pulse()` | 当前读数 + 基线/档位/趋势/峰值/会话/近 60 点 `series`/`safety`/`line`；一次 `readyGuard` + 三道闸 |
| `pulseSession({action,minutes,label})` | `status`/`start`/`stop`/`mark`；未知动作 → `pulse-bad-action`；`start` 先按需连设备（§17.2.1）；`stop` 落库 + 断 BLE 并回 `persisted` |
| `pulsePrompt({maxChars})` | 给 foundation 的一行；**永不失败**：`{ok:true,text,reason}`，`text:''` 表示这回合不该有心跳 |
| `pulseHistory({limit})` | 最近会话的派生统计（无曲线） |
| `pulseDevices()` | 透传 sidecar 扫描结果（只有 `addressHash`，永不出现明文地址） |
| `pulsePollNow()` | 立刻拉一次（会话刚开时给 UI/验收一个确定的新鲜值） |
| `pulseDiagnostics()` | 进 `describe().pulse`：开关/授权/轮询/最后错误码，**不含读数与设备身份** |

### 17.5 schema v2

`PRAGMA user_version = 2`，新表 `health_pulse_sessions`（`lib/migrations.mjs` `V2_DDL`）：
只存 `baseline_bpm / peak_bpm / peak_at / samples / zone_counts_json / marks_json / stop_reason`，
**没有**任何原始序列列。`ended_at IS NULL` 的行只可能来自上一个进程崩溃/热重载，
`initialize()` 用 `closeOrphanPulseSessions()` 以 `stop_reason='host-reload'` 收口。

### 17.6 注入契约（谁会看到什么）

- foundation `agent/pre-step` 调 `pulsePrompt()`，非空时作为**最后一段**（section 名 `companion-pulse`）
  追加进注入消息；独立 200 字预算，不挤记忆的 2400。
- foundation 另有一条静态段 `companion:pulse`（order 64）：**没有【心跳读数】段落就没有数据**，
  禁止编造"听见你的心跳"。
- 四种行形态（实时 / 读数稀疏 / 不在线 / 安全提示）与档位文案见 `design/pulse-bond-20261103.md` §5；
  渲染实现只有一处：`lib/pulse.mjs` 的 `renderPulseLine()`。

### 17.7 验收

```text
node --test plugins/companion-health/test/*.test.mjs                 # 164 条全绿（含 pulse-engine/adapter/service）
node --test plugins/companion-foundation/pulse-tools.test.mjs       # 工具层
node scripts/check-pulse.mjs --fixture                              # sidecar 侧（无硬件）
```
真机：`--scan` → `--watch 30` 对表 → `companion_pulse action=start` 出现【心跳读数】→ `stop` 立刻消失 →
`stop-sidecar.ps1` 后降级为诚实句。

### 17.8 本层已知边界

1. **真机已跑通（2026-11-03 23:03–23:06，HUAWEI Band 8 + 「心率广播」）**：`--scan` 扫到
   `HUAWEI Band HR-002`（0x180D），`/api/state` `connected=true`；`--watch 30` 30/30 轮询 200、
   98–103 bpm、`sampleAgeMs ≤ 954 ms`；真设备端到端（→ 引擎 → 注入行 → 落库）通过。
   **教训**：早先一轮扫描 `hasHrs` 全 0 只能说明"当时广播没开"，不能用来判定设备不支持。
   手环 8 **不广播 RR**（`rrMs: []` → `rmssdMs` 恒 `null`，HRV 不编造）；要 RR 得用胸带。
2. **宿主热重载后的会话不延续**（有意）：会话按 `host-reload` 收口，必须显式重开。
3. **首帧前没有基线**：基线取会话开头 60 s 内读数的中位数，且至少要 10 个有效读数
   （1 Hz 下约 10 s 后可用）；在此之前注入行明说"还在建立基线"，不给"快不快"的判断。
4. **`quality` 是本层派生的**（`sampleAgeMs > freshMs` → `sparse`），不采用 sidecar 自己的判断。
5. **`safety` 只是产品护栏**：≥185 持续 60 s / ≤45 / 断流 >90 s，文案只请角色停下来关心，
   不做医学判断、不自动结束会话（除 TTL）。
6. **注入行的长度预算**：`pulsePrompt()` 不传 `maxChars` 时用配置值（200）；曾经因为
   `Number(null) === 0` 被 `clampInt` 顶到 80 字下限，把每句悄悄截断——已修，并有用例
   （`pulse-service.test.mjs`「an absent maxChars uses the configured budget」）钉住。
   超预算时的降级顺序见 §5，不会出现半句话。
7. **2026-11-03 23:30 事故：本层让桌面起不来（已修）**。`pollPulseOnce()` 在 `await adapter.state()`
   之后仍读可变的 `pulseEngine` 闭包变量；宿主卸载/重载把引擎置空后，`drainClosed()` 在 try 之外抛出，
   宿主把**任何未捕获的 Promise 拒绝**当作 `fatal load failure` → 桌面退出 1、无法启动
   （证据：`logs/desktop-20261103-233010.stderr.log`）。修法三条，缺一不可：
   ① `await` 前把引擎/适配器捕获成局部变量，`await` 之后再校验"还是不是活的同一个"；
   ② 整个函数体在 try 内；③ 所有 fire-and-forget 只能走 `kickPoll()`——插件里**禁止**裸 `void asyncFn()`。
   回归：`pulse-service.test.mjs`「a close() during an in-flight poll resolves instead of taking the host down」。
8. **2026-11-04 事故：`ctx.provide` 跨不到兄弟插件（已修，影响面比心跳更大）**。
   活体实测：桌面 chat 里 `companion_pulse` 返回 `health-not-mounted`、Studio 所有健康路由返回
   `health-unavailable`，而服务本身在跑（日志有 `pulse polling every 1000 ms`、`ready`）。
   根因是 Cordis 的语义：`ctx.provide(name, value)` 提供的服务只在本插件**子树**内可见，而
   `companion-health` / `companion-foundation` / Studio bundle 是**兄弟行**。
   修法：`companionHealth` 加进 `service-bridge.mjs` 的允许名单，由本插件在两个位置同时发布
   （`ctx.provide` 供同子树消费者、`publishHealthService()` 走进程内桥供兄弟插件），消费者统一走
   `plugins/companion-foundation/health-service-ref.mjs` 的 `resolveHealthService()`（先 `ctx.get`、
   再桥）。回归：`health-service-ref.test.mjs`。
   **第一版（只加模块级 bridge）仍然失败**：不同插件行的模块实例可能不是同一个。最终把端口存到
   **`process` 上的 symbol 注册表**（`Symbol.for('dsh.companion.ports.v1')`），并让发布/未命中各写
   一个诊断文件 `home/health/bridge-publish.json` / `bridge-miss.json`（只有 pid、时间、原因码）——
   重启后直接读文件就能判断"谁发布、谁没找到、为什么"，不用再猜。
   **2026-11-04 01:03 活体验收通过**：工具返回真读数（bpm=83 / HUAWEI Band HR-002）、Studio 路由
   `ok:true`、会话开启时注入出现 `companion-pulse`、`stop` 后下一轮注入只剩 identity+memory、
   落库 `baseline_bpm=82 / peak_bpm=83 / manual`。
   **这条也解释了上一轮 `companion_health_*` 五个工具为什么在真实宿主里一直不可用**——
   它们和本层的挂载顺序无关，是可见性问题，现已一并修好。
