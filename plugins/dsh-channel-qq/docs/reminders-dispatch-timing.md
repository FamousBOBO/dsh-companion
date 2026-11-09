# 提醒投递时延复盘：`r_mw9euj3gdwqo`（2026-11-09 23:40 → 2026-11-10 00:22）

> 事故：`2026-11-09 23:40:00`（Asia/Shanghai）的提醒，实际在 `2026-11-10 00:22:10`
> 才送达私聊 `dm-1429709395`。用户报告"晚了四十来分钟"。
>
> 本文是从**日志与落盘数据**独立重建的时间线，不采信任何口头总结。结论：
> **42 分 10.430 秒里，41 分 43.995 秒（98.96%）是共享闸门的 `cooldown:room`
> 在连续 84 个 tick 上拦下这条提醒**；剩下 26.4 秒（1.04%）是 30 秒轮询粒度与
> 记账开销。没有重启、没有事件循环卡死、没有 QQ 发送失败、没有到期查询失配。
>
> 数据快照时刻：`2026-11-10T02:12` 前后。`data/home/channel-qq.log` 是**活的**日志，
> 本文引用的行号以该时刻的文件内容为准（当时共 17,041 行）。

---

## 0. 一句话根因

`2026-11-09 23:21:52.646`，contact 自己的 `turn` 投递把
`counters.lastSentAtByRoom["dm-1429709395"]` 写成了这个时刻（`contact/service.ts:290`），
于是 `perRoomCooldownMs = 3_600_000`（`companion.patch.yml:243`）的会话冷却一直有效到
`2026-11-10 00:21:52.646`。提醒在到点后的每一个 tick 都去问同一个共享闸门
（`reminders/index.ts:132` → `contact/service.ts:215` → `gate.ts:324` `checkCooldown`），
拿到 `defer / cooldown:room` 后就**本拍不投递、也不消耗**（`reminders/index.ts:172`），
下一拍再问。**84 个 tick、41 分 44 秒**全部这样空转；冷却一过，下一个 30 秒 tick
才把它发出去。

这条链上没有任何一步"坏"了 —— 每一步都按设计工作。坏的是**设计**：一个面向
"主动搭话"的节流器被套在了"主人自己约好的时刻承诺"上。

---

## 1. 证据来源与读法

| 证据 | 路径 | 用法 |
|---|---|---|
| 插件日志 | `data/home/channel-qq.log`（17,041 行，UTF-8，`+08:00` 时间戳） | 唯一的逐拍时间线 |
| 提醒库 | `data/workspace/reminders.json`（845 B，mtime `00:22:10.432`） | `created` / `at` / `fired` / `firedAt` |
| 账本 | `data/home/channel-qq/contact.json`（198,985 B） | `counters`、`outbox`、`recentReasons`、`lease` |
| 会话事件 | `<套件根>/data/home/sessions/--<工作区路径转义>--/qq-dm-1429709395/session.v4.jsonl.zstd`（多帧 zstd，6,182 帧 / 13,026 事件） | 建提醒的 tool/call 与 tool/result |
| 发送标记 | `data/home/channel-qq/sent-dm-1429709395.json`（50 条） | 交叉核对 23:21 那次真发 |
| 生效配置 | `config/profile/companion.patch.yml`（本机配置，不入库） | 阈值与路径 |

### 1.1 时区换算（Asia/Shanghai，全文统一）

宿主机时区是 `China Standard Time`（UTC+08:00），但**不依赖**这一点，全部换算显式指定时区：

```bash
# 采集时实际执行的换算
node -e "const f=ms=>new Date(ms).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}); \
console.log(f(1794237779500), f(1794238800000), f(1794241330430))"
# 2026-11-09 23:22:59   2026-11-09 23:40:00   2026-11-10 00:22:10
```

`sv-SE` 回显 `YYYY-MM-DD HH:mm:ss`，毫秒由 `ms % 1000` 补齐（本文写作 `.mmm`）。
日志时间戳本身带 `+08:00` 偏移，`[datetimeoffset]::Parse()` 直接得到绝对时刻，不需要再猜时区。

### 1.2 提醒库到底是哪个文件（这一步会看错人）

`store.ts:73` 是 `const base = opts.workspacePath ?? path.join(opts.dshHome, 'channel-qq')`。
生产 profile 显式设了 `workspacePath: <套件根>/data/workspace`
（`companion.patch.yml:109`），所以真实库是 **`data/workspace/reminders.json`**。

`data/home/channel-qq/reminders.json` 是**空的**（35 B，`{"version":1,"reminders":[]}`，
mtime `2026-10-31 21:11:35`），谁按 `store.ts:71-72` 的注释去那里找，就会得到
"提醒根本不存在"的错结论 —— 那条注释描述的是 `cordis.patch.yml:29` 的
`workspacePath: null` 默认档，与本机实际生效的 profile 不一致。

日志侧佐证：`L16957`（`01:10:20.409`）`reminders: loaded 2 item(s)` 正好等于
`data/workspace/reminders.json` 的 2 行；若是那个空文件会打 `loaded 0 item(s)`。
`L16247`（`2026-11-08 14:56:35.580`）`loaded 1 item(s)` 也对上当时只有 1 行。

---

## 2. 逐阶段时间线

`r_mw9euj3gdwqo`，text = `凡博，十一点四十了，这把打完就收，去洗澡躺下`，`room: "dm"`，
`target: 1429709395`，`repeat: "none"`。

| # | 阶段 | 该字段来自哪儿 | epoch ms | Asia/Shanghai | Δ 上一阶段 | 记录等级 |
|---|---|---|---|---|---|---|
| 1 | `createdAt` | `data/workspace/reminders.json` → `created`；同值见会话 `seq 12812` tool/result | `1794237779500` | `2026-11-09 23:22:59.500` | — | 落盘事实 |
| 2 | `scheduledAt` | 同文件 → `at`；同值见 tool/result（请求参数 `"at":"2026-11-09 23:40"`） | `1794238800000` | `2026-11-09 23:40:00.000` | +1,020,500 ms | 落盘事实 |
| 3 | `dueDetectedAt` | `channel-qq.log` **L16754** `reminders: r_mw9euj3gdwqo 被共享闸门拦下（cooldown:room），不投递` | `1794238808654` | `2026-11-09 23:40:08.654` | **+8,654 ms** | 日志事实 |
| 4 | `gateEvaluatedAt` | `channel-qq.log` **L16753** `contact: 共享闸门拦下 reminders → dm-1429709395（cooldown:room）` | `1794238808651` | `2026-11-09 23:40:08.651` | −3 ms（先于 L16754） | 日志事实 |
| 5 | `claimedAt` | **不存在**：提醒侧没有 claim/租约阶段（`src/features/reminders/` 无 claim 概念；`applyClaim` 只服务 contact 的 delivery 行，`contact/store.ts:317`） | — | — | — | **无此阶段** |
| 6 | `dispatchStartedAt` | 无记录。与第 4 步同一个 tick、同一次 `admit()` 调用（`reminders/index.ts:200`），可等价视为 `≈1794238808651` | `≈1794238808651` | `≈23:40:08.651` | ≈0 | 推断（代码路径） |
| 7 | `sendStartedAt` | 无记录。被夹在"最后一次被拦 `00:21:39.292`"与"送达日志 `00:22:10.369`"之间 | `∈ (1794241299292, 1794241330369)` | `∈ (00:21:39.292, 00:22:10.369)` | — | 推断（区间） |
| 8 | `sendCompletedAt` | `channel-qq.log` **L16927** `reminder delivered to dm-1429709395: …`。这行写在 `out.push(...)` 拿到回执**之后**（`reminders/index.ts:254-259`），所以它是完成证据 | `1794241330369` | `2026-11-10 00:22:10.369` | — | 日志事实 |
| 9 | `firedAt` | `data/workspace/reminders.json` → `firedAt`（由 `store.markFired(id, now=Date.now())` 写入，`store.ts:237-243`；文件 mtime `00:22:10.432`） | `1794241330430` | `2026-11-10 00:22:10.430` | **+61 ms**（相对第 8 步） | 落盘事实 |

紧接着的账本动作（不属于时间线字段，但能证明这条走完了完整出口）：
`L16928`（`00:22:10.407`）`contact: 共享账本记一次 reminders → dm-1429709395（reminder-delivered）`
—— 全日志**仅此一次**该文案，说明这条提醒只真发了一次，没有重复投递。

### 2.1 总时延

```
firedAt − scheduledAt = 1794241330430 − 1794238800000 = 2,530,430 ms
                       = 42 min 10.430 s
```

用户说的"四十来分钟"= 42 分 10 秒，对得上。

---

## 3. 42 分钟归因（算术）

### 3.1 五个桶

| 桶 | 内容 | ms | 占比 | 依据 |
|---|---|---|---|---|
| A | `scheduledAt` → 本拍被拦 | **8,651** | 0.34% | `at` = `23:40:00.000`；`23:40:08.651` − `23:40:00.000` = 8,651 |
| B | 共享闸门 `cooldown:room` 阻塞 | **2,503,995** | **98.9553%** | `3,600,000 − 1,096,005`（见 3.2） |
| C | 冷却到期 → 下一个 tick 的闸门判定 | **~16,652**（界 `[12,935, 17,723]`） | 0.66% | 见 3.3 |
| D | 闸门放行 → 送达日志（WS 往返 + 记账） | **~1,071** | 0.042% | 见 3.3 |
| E | 送达日志 → `firedAt` | **61** | 0.0024% | `1794241330430 − 1794241330369` |
| | **合计** | **2,530,430** | 100% | 8,651 + 2,503,995 + 16,652 + 1,071 + 61 = 2,530,430 ✓ |

### 3.2 桶 B 的精确算术（这是全部问题的所在）

闸门判据（`gate.ts:324-330`）：

```ts
const roomLast = input.counters.lastSentAtByRoom[room]
if (input.config.perRoomCooldownMs > 0 && roomLast !== undefined
  && input.now - roomLast < input.config.perRoomCooldownMs) {
  return { verdict: 'defer', reason: 'cooldown:room' }
}
```

三个输入全部有据可查：

1. `perRoomCooldownMs = 3600000` —— `companion.patch.yml:243`。
2. `counters.lastSentAtByRoom["dm-1429709395"] = 1794237712646`
   （`2026-11-09 23:21:52.646`）。
   **注意：这个值现在已经被事故之后的活动覆盖了**，`contact.json` 里当前是
   `1794244940684`（01:22:20 那次 turn 投递）。事故当时的值必须从两处重建，二者一致：
   - `contact.json` → `outbox["d-c-mw9ert9n-dho"]` 的 `createdAt`/`submittedAt` = `1794237712646`；
   - `contact.json` → `recentReasons` 里的 `2026-11-09T15:21:52.646Z c-mw9ert9n-dho sent:submitted (turn-submitted)`
     （`15:21:52.646Z` UTC = `23:21:52.646 +08:00`）。
   写入点：`contact/transitions.ts:167-168`（`markSent()` 的 `patchCounters`）—— contact
   自己 sendMode=`turn` 的成功路径，**与提醒无关**。
   日志侧：`L16742 23:20:52.742 候选 c-mw9ert9n-dho 入库` → `L16744 23:21:52.720 turn 路径提交`
   → `L16747 23:21:52.927 投递完成 submitted（turn-submitted）`；`sent-dm-1429709395.json`
   在 `23:22:06.716`–`23:22:09.761` 有三条真发消息，与该候选对应。
3. `now` 在每次闸门判定时取 `deps.clock.now()`（`contact/service.ts:217`），
   账本每次从磁盘重读（`store.ts:286-288` `snapshot()` → `readLedger`，无内存缓存），
   所以 `roomLast` 的读值是可信的。

于是：

```
冷却到期 = 1794237712646 + 3600000 = 1794241312646 = 2026-11-10 00:21:52.646
```

第一次被拦时（`23:40:08.651`）：

```
now − roomLast = 1794238808651 − 1794237712646 = 1,096,005 ms
还差          = 3,600,000 − 1,096,005 = 2,503,995 ms  ← 桶 B
```

最后一次被拦时（`00:21:39.292`）：

```
now − roomLast = 1794241299292 − 1794237712646 = 3,586,646 ms  < 3,600,000  ⇒ 仍然 defer ✓
```

真正放行那次（送达到达 `00:22:10.369`）：

```
now − roomLast ≥ 1794241330369 − 1794237712646 = 3,617,723 ms  ≥ 3,600,000  ⇒ 放行 ✓
```

三个采样点全部与"`cooldown:room` 在 `00:21:52.646` 结束"这一条模型自洽 —— 不是拟合，是判据。

### 3.3 桶 C / D 的界是怎么来的

轮询是 `setInterval(..., 30_000)`（`runner.ts:157`），相位由 `runner started`
（`L16249`，`2026-11-08 14:56:35.581` = `1794120995581`）定死。网格时刻
= `1794120995581 + k·30000`：

- 到点后第一个网格：`1794238805581` = `23:40:05.581`，日志落在 `23:40:08.651` ⇒
  **本拍处理延迟 3,070 ms**（`setInterval` 回调 → 走到闸门判定）。
- 冷却到期后的第一个网格：`1794241325581` = `00:22:05.581`，距到期 `+12,935 ms`。
- 84 次被拦时间戳的间隔统计：最小 29,955 ms、最大 30,058 ms、均值 30,007.687 ms
  （中位 30,008），**每拍平均漂移 +7.687 ms**。所以到 00:22 那一拍，本拍处理延迟已经
  累积到 `3,070 + 7.687×84 ≈ 3,716 ms`。

⇒ 桶 C ≈ `12,935 + 3,716 = 16,651 ms`（取 16,652 使总和精确闭合）；
下界 `12,935`（本拍无延迟，不可能），上界 `17,723`（= 送达日志 − 到期）。
桶 D 由总数倒推：`1,071 ms`，即闸门放行后到 WS 回执日志的实际耗时。

> 这一桶的**不确定性是真实的**：`sendStartedAt` / `sendCompletedAt` 没有独立落盘，
> 只能靠"到期时刻 + 网格相位 + 送达日志"夹出来。区间宽度 ~4.8 s，相对 42 分钟是 0.19%，
> 不影响结论；但换个场景（比如要评"5 秒精度"）它就是主要误差源，见 §8。

### 3.4 这些数字互相印证

- 84 条 `被共享闸门拦下` 日志 × 30 s = 2,520,000 ms，与实际跨度
  `1794241299292 − 1794238808654 = 2,490,638 ms` 同量级（差 29,362 ms = 最后一拍到送达）。
- 84 条 `contact: 共享闸门拦下 reminders → dm-1429709395（cooldown:room）`（L16753…L16925）
  与 84 条 `reminders: … 不投递` 一一配对，**没有一次**别的原因。
- 该时间窗内（`23:00`–`00:30`）除这 168 行外只有 34 行日志，其中 contact 相关只有
  `L16742/16744/16747`（那次 turn 投递）和 `L16750`（未回复计数归零）—— **不存在**
  任何其它"消耗额度 / 刷新冷却"的写入。
- 配额度数：`contact/service.ts:283-290` 与 `transitions.ts:165-171` 是唯一两处刷新
  `lastSentAtByRoom` 的代码；两条路径本窗口内各触发一次（`23:21:52.646`、`00:22:10.407`）。

---

## 4. 替代解释的证伪

| # | 假设 | 结论 | 证据 |
|---|---|---|---|
| 1 | 调度器不常驻，只在有消息时才跑一拍 | **证伪** | 84 个连续 tick 一个不缺，间隔 29,955–30,058 ms；窗口内没有任何入站消息（唯一用户消息在 `23:22:45` 与 `00:23:26`，见会话 `seq 12803`/`12828`），空转照跑 |
| 2 | 定时器被 `unref()` 掉、被 `clearInterval` 掉或已死 | **证伪** | `unref()`（`runner.ts:166`）只让进程不被钉住，不影响已排的 timer；`dispose()`（`runner.ts:361-366`）只在卸载时调；日志里 0 次 `仍在停表中`、0 次 `调度已锁定`、0 次 `调度已暂停`；进程从 `11-08 14:56:35` 一直活到 `11-10 01:10:19` |
| 3 | 事件循环卡住 / 机器睡眠休眠 / 23:40–00:22 之间重启过 | **证伪** | ① 重启：`starting (mode=forward…)` 全文 190 次，**23:40 前最后一次是 L16227（`2026-11-08 14:56:35.460`）**，之后直到 **L16937（`2026-11-10 01:10:19.982`）** 才有下一次；`runner started` 在 `L16249`（14:56:35.581）与 `L16959`（01:10:20.410）之间**没有第三处**。② 卡顿：会话事件在 `23:30`–`00:30` 的最大间隔只有 **6,266 ms**；插件日志在该窗口最大间隔 42,867 ms，且每一处都能被 30 s 周期解释（无非周期的空洞）。③ 若真睡过 41 分钟，84 个 30 s tick 不可能一个不落 |
| 4 | 到期查询用了精确相等 / 窗口配错 | **证伪** | `catch-up.ts:96-99` `dueOf()` = `!fired && at <= now && at >= now-6h`，**区间**判定；`CATCH_UP_WINDOW_MS = 6h`（`catch-up.ts:21`）远大于 42 min，`at` 从未滑出窗口 |
| 5 | 到期任务被每拍上限 / 积压上限 / 排序 / 租约饿死 | **证伪** | 库里只有 2 行、本拍只有 1 条到期；`MAX_CATCH_UP_PER_TICK = 3`（`runner.ts:47`）、`CATCH_UP_MAX_TOTAL = 20`（`catch-up.ts:36`）；全文 0 次 `本拍到点 N 条…按每拍上限`、0 次 `因积压丢弃`、0 次 `超出补发窗口`、0 次 `skipped-expired`、0 次 `pendingDispatch value=`。**当时**提醒侧没有租约/claim 概念（见 §2 第 5 行），谈不上"租约被抢"；claim 是本次修复才引入的（§6.3） |
| 6 | 创建时把秒当毫秒 / 按本地时区字符串解析错位 | **证伪** | 请求 `at:"2026-11-09 23:40"` → `parseAt()`（`tools.ts:32-52`）走正则分支 → `new Date(2026,10,9,23,40,0,0)`（**本地**，本机 UTC+08:00）→ `1794238800000`，正是 `23:40:00.000`，整分无秒毫秒残留；回执 `"atText":"今天 23:40"`；落盘 `at: 1794238800000`。没有 10/13 位混用 |
| 7 | QQ 发送失败 / 超时 / 重试 / 回执丢失 | **证伪** | 窗口内 0 次 `已提交但拿不到回执`、0 次 `send failed for`、0 次 `unclassified`、0 次 `forward WS closed`、0 次 `reconnecting`、0 次 `deny`；`forward WS`/`QQ link` 事件在 `23:40`–`00:22` 之间**一条都没有**（连接自 `11-08 14:56:35.667` 起未断）。送达日志只出现一次，`共享账本记一次` 也只出现一次 ⇒ 一次成功、无重复 |
| 8 | 先把状态标成 fired 再发，或 `fired` 落盘太晚 | **证伪** | `firedAt`（`1794241330430`）在送达日志（`1794241330369`）之后 **61 ms**，`reminders.json` mtime `00:22:10.432` 又在 `firedAt` 之后 2 ms。顺序是「回执 → 记账（`L16928`，+38 ms）→ `markSent` → `markFired`」，与 `sendOnce()`/`recordSent()` 的实现一致（`reminders/index.ts:254-283`、`runner.ts:327-352`）。**被拦的 84 拍一次都没有 `markFired`** —— 这正是它下一拍还会重试的原因 |
| 9 | 多个调度器实例竞争同一条提醒 | **证伪** | 全文 0 次 `OWNER_CONFLICT`；`loaded N item(s)` 与 `runner started` 严格一一配对（189 对/190 次 `starting`）。提醒库有 owner key（`store.ts:80`）但没有第二实例在写。`01:10:19` 起确实出现了第二个进程，但它立刻 `L16987 租约在别的实例手里，本实例不推进`，且它的 `runner started` 是 `01:10:20.410` —— **在事故之后 48 分钟**，与本次时延无关 |
| 10 | 免打扰 / 额度 / 通道 / 竞争把它拦住了 | **证伪** | `quietHours: []`（`companion.patch.yml:237`）⇒ 0 次 `quiet-hours`；`dailyQuotaGlobal/PerRoom: .inf`（`:240-241`）⇒ 0 次 `quota:*`；`allowExternalSend: true`、连接未断 ⇒ 0 次 `no-channel`；`turnRunningByRoom`/`toolRunning` 在提醒路径被硬编码为空/false（`contact/service.ts:222-224`）⇒ 0 次 `tool-running`。**84 次拒绝的理由字符串全部是 `cooldown:room`**，没有第二个理由 |
| 11 | 是 `cooldown:global`（1,800,000 ms）而不是 `cooldown:room` | **证伪** | `checkCooldown` 先判房间再判全局（`gate.ts:324-336`），房间分支先返回。日志理由字符串就是 `cooldown:room`。反事实：若 `perRoomCooldownMs = 0`，全局冷却也会把投递推迟到 `23:21:52.646 + 1,800,000 = 23:51:52.646`，**仍然会晚 11 分 52 秒** |

---

## 5. 证据缺口 / 需要补的结构化日志

> 本节描述的是**事故当时（修复前）**的现场，也就是"为什么这份复盘只能靠日志时间戳反推"。
> 这些缺口在本次修复里大多已经补上，**补齐后的字段与语义见 §6.3 / §6.4**；
> 读本节时请当作"当时的取证困难"，不要当成当前实现。

### 5.1 今天拿不到的东西（必须承认）

| 缺口 | 现状 | 影响 |
|---|---|---|
| `claimedAt` / `dispatchStartedAt` | **概念不存在**。提醒没有 claim 阶段，每个 tick 从头重新判定 | 无法回答"这条被谁认领、认领了几次"；也无法防"两个 tick 同时发"（今天靠 `this.running` 布尔量，进程内有效，跨进程无效） |
| `sendStartedAt` / `sendCompletedAt` | 只有一条 `reminder delivered to …`（在回执之后），起点无记录 | 桶 C/D 只能夹区间（~4.8 s 宽） |
| 建议闸门判定当时的 `now` 与 `roomLast` | `service.ts:237` 只打 `reason`，不打数（本分支现在是 `service.ts:240`，仍然只打 reason） | 复盘必须靠"理由字符串 + 隔壁日志时间戳"反推算术；若判据改过（或有人手改账本），无法自证 |
| 被拦时的"还差多少毫秒" | 无 | 用户/运维无法一眼看出"还要等 41 分钟"还是"下一拍就好" |
| 提醒投递的送达凭证 | `sent-dm-1429709395.json` **不含**这条提醒（50 条里既无提醒正文也无 `1794241330…`），只有 contact 自己发的消息 | 无法从"发送侧"独立复核是否真送达，只能信插件日志 |
| 快照时延 | `snapshot()` 每次重读 + 加锁（`store.ts:286`），毫秒级 | 极小，但**不是 0** |

### 5.2 建议新增的日志字段（一行一条，可 grep、可聚合）

> **2026-11-10 已实现**，但实际落地的字段与上面这份建议**不完全一样**——最终以 §6.4 为准：
> `id`/`at` 改名为 `reminderId`/`scheduledAt`，`sendStartAt`/`sendEndAt` 改名为
> `sendStartedAt`/`sendCompletedAt`，新增 `outcome`；
> **`gate` / `gateNow` / `gateRoomLastSentAt` / `gateWaitMs` 四列没有做**——闸门判定仍然只打
> `被共享闸门拦下（<reason>）`，不带数字。所以"再被拦一次还是只能反推"这一点**没有闭环**，
> 已列入 §7 第 9 条。本节保留为"当时为什么需要它"的记录。

在 `reminders/index.ts` 的 `admit()` / `gateAllows()` 与 `sendOnce()` 上补齐：

```
reminders: dispatch id=<reminderId> at=<scheduledAt> occurrence=<id|none>
           observedAt=<ms> latenessMs=<ms> attempt=<n>
           gate=<send|reason> gateNow=<ms> gateRoomLastSentAt=<ms|absent>
           gateWaitMs=<ms> claim=<token|none>
           sendStartAt=<ms> sendEndAt=<ms> receipt=<kind>
           firedAt=<ms>
```

要点：
- `latenessMs` 必须由进程自己算并落盘 —— 事故里"晚 42 分钟"这个数字是**事后手工减出来的**，
  日志本身没有。
- `gateRoomLastSentAt` + `gateWaitMs` 单独两个字段，就能把本次 41 分 44 秒一眼看穿，
  不必再读账本、不必再反推。
- `claim=<token>` 若实现，天然给跨进程互斥留下证据；不实现就别写这个字段（不要造假）。
- 另外建议把**成功的投递**也写进 `sent-dm-*.json`（或 `outbox` 里加一条 `sender: 'reminders'`
  的 delivery 行），让发送侧与插件侧可以互证。

---

## 6. 修复后的语义（2026-11-10）

本节描述**本分支代码现在的行为**（不是事故当时）。四张表分别对应四处改动；
每条都写了"改之前在哪儿、改成什么、凭什么"，方便 review 对着代码逐条核。

### 6.1 判据两档：`proactive` vs `reminder`

| | `profile: 'proactive'`（**缺省**） | `profile: 'reminder'` |
|---|---|---|
| 谁用 | contact 自己的主动消息（不传 profile 的全部既有调用点） | 到点提醒（`reminders/index.ts:141`） |
| 判据表 | `BUDGET_CHECKS` = `checkQuietHours` → `checkContention` → `checkCooldown` → `checkQuota` → `checkBackoff` → `checkChannel`（`gate.ts:217-224`） | `REMINDER_BUDGET_CHECKS` = **只有** `checkChannel`（`gate.ts:234`） |
| 可能返回的理由 | `quiet-hours` / `settle:user-active` / `tool-running` / `cooldown:room` / `cooldown:global` / `quota:global` / `quota:room` / `backoff:unanswered` / `no-channel` / `binding-invalid` | 只剩 `no-channel`（`connected=false`，`verdict: defer`）与 `binding-invalid`（`roomBound=false`，`verdict: drop`）（`gate.ts:394-398`） |
| 与修复前是否等价 | **逐条完全相同**（`budgetChecksFor()` 缺省值就是 `'proactive'`，`gate.ts:237-239`；`evaluateOutboundBudget()` 只是把 `step` 迭代器换成 `budgetChecksFor(input.profile)`，`gate.ts:242`） | — |
| 事故里会怎样 | 命中 `cooldown:room`，84 拍全拦（本次事故） | 直接 `send`，23:40:00 那一拍就发（回归用例 T14 钉住：同一个 `counters` 下 `proactive` 回 `cooldown:room`、`reminder` 回 `ok`） |

**为什么不是"给提醒开后门"**：`reminder` 档去掉的四类判据回答的都是"现在适合主动找人说话吗"
（免打扰、冷却、配额、未回复退避），而提醒回答的是"主人自己约好的那一刻到了"。
物理可行性（通道断了、房间绑定不对）**照样拦**。

**单向记账，不是双标**：提醒投递成功后**仍然**调
`contact.account({ room, sender: 'reminders', reason: 'reminder-delivered' })`
（`reminders/index.ts:272`），把 `lastSentAt` / `lastSentAtByRoom` / `sentToday*` 写进同一本账。
所以：**提醒不借主动消息的额度，但照样消耗额度**——发过提醒之后，主动消息那一侧
的冷却与配额会被这条提醒推后。这一条必须保留，否则"今天已经说过几句"就失真了。

### 6.2 调度：固定轮询 → 按 `scheduledAt` 定时 + 心跳兜底

| | 修复前 | 修复后 |
|---|---|---|
| 机制 | `setInterval(tick, 30_000)`（旧 `runner.ts:157`） | `WakeupTimer`（`features/reminders/wakeup.ts`）用 `Clock.setTimeout` 单次定时，**每拍跑完重算下一次** |
| 何时醒 | 相位固定，跟 `at` 无关 | `planWakeup({ats, now, heartbeatMs, overdueGapMs})`（`schedule.ts`）= 未来项 `min(at − now, 心跳)` 与到期项 `min(overdueGap, 心跳)` **取更早的那个**；都没有 ⇒ 心跳。`MIN_WAKEUP_MS = 1` 只是"立刻"这一档的下界（不许排成 0 ms 死循环）。**第二轮**：到期项不再一律 1 ms，见 §11 |
| 到点误差 | **下界 = 轮询间隔**（实测 29,955–30,058 ms） | 只剩"排程 → 取 `now()`"的毫秒级延迟 + 一拍投递耗时（见 §7 第 3 条） |
| 心跳 | 就是轮询本身 | `start(heartbeatMs = 30_000)`（`runner.ts:164`）保留，兜三件事：**时钟漂移、系统休眠/唤醒、被外部手改过的提醒文件** |
| 哪些 `at` 参与排程 | — | `wakeupAtsOf()`（`schedule.ts`）：`fired` 的不算；早于补发窗口的一次性提醒不算（它们归 `catch-up.ts` 收终态）。**过去的时刻照样参与**（⇒ 立刻醒，停机期间到期的下一拍就被看见） |
| 看多少行 | 全表 `due()` | `store.list(MAX_ROWS_FOR_WAKEUP = 50)`（`runner.ts:52`，表按 `at` 升序，够用） |
| 启动横幅 | `runner started (every 30000ms)` | `runner started (heartbeat 30000ms，按到期时刻唤醒)`（`runner.ts:184`）——**文案变了，日志检索要跟着改** |
| 诊断 | — | `status().scheduled` / `WakeupTimer.state()` 给出 `armed / delayMs / arms / ticks`；**第二轮**多一个 `status().backoff = { overduePasses, gapMs }`（见 §11.6） |
| 建/删提醒后立刻重排 | — | `nudge.ts` 提供钩子：`setReminderNudge()` 在 `runner.start()` 装（`runner.ts:182`）、`dispose()` 里卸（`runner.ts:372`）。**写入侧已接**：`store.add()` / `remove()` / `resolve(…, 'failed')` 成功后各调一次 `nudgeReminders()`（`store.ts`，**事务提交之后、返回值之前**），所以运行中新建的"15 秒后"提醒也会立刻重排，不必等心跳 |
| 假时钟可测 | 不能 | 定时器与 `now()` 全走 `ports/clock.ts` 的 `Clock`，`FakeClock` 能逐毫秒推进（`test/reminders-dispatch-timing.test.ts` 的 T1/T3/T6） |

### 6.3 原子领取（claim）

| | 修复前 | 修复后 |
|---|---|---|
| 互斥手段 | 只有进程内一个 `private running = false` 布尔量 | 落盘的 `claim = { by, at, until }`，一次事务完成"读-判-写" |
| TTL | — | `DEFAULT_CLAIM_TTL_MS = 120_000`（`claim.ts:25`） |
| 认领者标识 | — | `claimOwnerOf()` = `pid-<pid>#<seq>`（`dispatch.ts:31-33`）：**进程内唯一**，不只是"进程唯一" |
| 状态机 | — | `claimStateOf()` 四态：`free`（没人领）/ `held`（别人且未过期，本拍跳过）/ `mine`（自己且未过期，幂等）/ `stale`（**过期**） |
| 存储方法 | — | `store.claim(id, owner, now, ttl)`、`store.releaseClaim(id, owner?)`、`store.renewClaim(id, owner, now, ttl)`（第二轮加的续租，见 §10.6）、`store.resolveStaleClaim(id, now)` |
| 过期认领 | — | **不重发**：盘上分不清"发之前崩"还是"发之后崩"，`resolveStaleClaim()` 走 `reduceMarkUnknown(..., 'claim-expired:unknown')` ⇒ 终态 `unknown`，等人工收敛 |
| 什么时候放回 | — | `sent` / `unknown` 由 `markFired` / `markUnknown` 里 `clearClaim()` 顺手清；`skipped` / `dry-run` 走 `releaseAfterSkip()`（`dispatch.ts`）立刻放回，下一拍还能试。**第二轮加 owner**：只放自己的（`claim.by !== owner` ⇒ `STALE_STATE`，盘上不动） |
| 抢不到怎么办 | 会重复外发 | 业务拒绝 `STALE_STATE`，本拍跳过，**不是失败**；日志 `<id> 本拍不发：… （别的实例/另一拍正在处理）` |
| 存储替身没有 `claim()` | — | 退化成"进程内串行"并**明确写一行日志**说多实例防护不生效（不静默） |
| `reason` 串 | — | `claim-expired:unknown`；`unknown` 的其它来源仍是 `unclassified` 或原始异常文本 |

### 6.4 结构化日志（`reminders: dispatch …`）

一次**投递尝试**一行，`key=value` 空格分隔（不是 JSON —— 要被 `grep latenessMs=` 抓，
也要和既有中文日志混在同一个文件里给人读）：

```
reminders: dispatch reminderId=r_xxx scheduledAt=1794238800000 observedAt=1794238800012 \
latenessMs=12 claimedAt=1794238800013 sendStartedAt=1794238800031 sendCompletedAt=1794238800418 \
attempt=1 outcome=sent
[reason="…"]        ← 只有 outcome=unknown 时才追加，双引号内的 " 被替换成 '
```

| 字段 | 含义 | 来源 |
|---|---|---|
| `reminderId` | 提醒 id | 行上的 `id` |
| `scheduledAt` | 计划时刻（绝对 ms） | 行上的 `at` |
| `observedAt` | **本拍判定"到点了"的时刻**（`clock.now()`） | `dispatchOne()` 开头 |
| `latenessMs` | `observedAt − scheduledAt`（负数 = 提前，正常情况下不应出现） | 同处 |
| `claimedAt` | 认领落盘时刻；`null` = 认领被跳过（dryRun / 存储替身 / 抢不到） | `claimForDispatch()` 返回 |
| `sendStartedAt` | 调 `send()` 之前 | `dispatchOne()` |
| `sendCompletedAt` | `send()` 返回之后（含 QQ 往返） | 同处 |
| `attempt` | 这一轮的尝试次数（1 起；落盘的 `attempts` +1） | 行上的 `attempts` |
| `outcome` | `sent` / `dry-run` / `unknown` / `skipped`（**唯一权威定义在 `outcome.ts`**） | `outcomeOf()` |
| `reason` | 仅 `unknown` 时出现：`unclassified` 或异常文本 | — |

**不含正文**：提醒内容可能是私事，而日志会被整段贴进 issue。
另外 `latenessMs > 1000` 时**额外**单独刷一行 `<id> 迟到 latenessMs=… （计划 …，观察 …）`
（`dispatch.ts:195-198`）——迟到必须自己说出来，按时不刷噪音。

---

## 7. 未覆盖项与边界（诚实清单）

1. **dryRun 下不认领**（`claimForDispatch()` 里 `if (dryRun) return {claimed: true, claimedAt: null}`；
   `store.claim/releaseClaim/resolveStaleClaim` 也都先过 `dryRunSkip`）。理由：演练承诺"整条入口零写入"，
   而认领会落盘。**代价：演练验不了并发**——`latenessMs`/`outcome` 仍然照打，但"两个 runner 抢一条"
   这件事在 dryRun 下永远不会被触发。这是设计取舍，不是遗漏（T9 钉住"盘上逐字节不变"）。
2. **`setTimeout` 不保证跨系统休眠按墙钟走**。机器睡 40 分钟再醒来，定时器可能"迟到"或提前触发。
   兜底是心跳（每次醒来重算 `min(at − now, heartbeat)`）——所以最坏情况是"睡醒后**一个心跳内**补发"，
   不是"永远不响"。这一点无法用单测定死（那要真睡机器），只能写在这里。
3. **"≤5 秒"指的是什么**。准确说是：**排程到取 `now()` 的毫秒级延迟 + 一拍投递耗时**（T1 用假时钟
   量到 `latenessMs = 0`）。**不含 QQ 端到端**：`api.sendTo()` 的往返在
   `sendStartedAt`/`sendCompletedAt` 之间被**记录**，但**不被这条承诺约束**——OneBot/NapCat 侧
   排队、限速、断线重连都可能让"用户看到消息"比 `sendCompletedAt` 更晚。
   换句话说：5 秒是**调度精度**指标，不是**用户感知精度**指标。事故复盘里的桶 D（1,071 ms）
   就是这一段在本机的实测值，可作参考基线。
4. **单进程内多个 runner 靠 `#seq` 区分，跨进程靠 `pid`**。所以：
   - 同进程装两次插件 ⇒ `pid-1234#1` / `pid-1234#2`，互不相认，只会有一个领到；
   - 两个进程 ⇒ pid 不同，正常；
   - **边界（第二轮更新）**：若两个进程落在同一个 pid（不同 namespace 的容器共享 pid 号、
     或 pid 被复用），认领者标识会撞。第二轮之后**这一条的后果变小但没消失**：写互斥已经
     由跨进程锁保证（不会两个进程同时改同一行），但"我看到的 claim 是不是我自己写的"
     仍然靠 `by` 里那个 pid——撞了就会把对方的认领判成 `mine`（幂等），于是**两边都发**。
     所以：**同一数据目录不要跑两个 pid 相同的写进程**（容器共享 pid namespace 是唯一现实
     场景）。要彻底消除，得给认领者一个随机 token（而不是 pid），本轮没做——它属于"平台
     身份"问题，不是提醒子系统能独立解决的。
5. **`quietHours` 在生产是 `[]`**（`companion.patch.yml:237`）。本事故**与免打扰无关**：
   全文 0 次 `quiet-hours`。反过来说，`CONTACT_DEFAULTS` 里默认是 `23:00–08:00`
   （`config/sections/contact.ts:31`）——**若用的是默认值，23:40 这条提醒本来会被免打扰拦住**，
   破坏力比冷却更大（要等到 08:00）。这是"提醒不该继承主动消息判据"的第二个理由。
6. **新建提醒会立刻重排（已接）**。`nudge.ts` 的钩子在 `runner.start()` 里装好
   （`runner.ts:182`）、`dispose()` 里卸掉（`runner.ts:372`）；调用点在 **`store` 的写入口**：
   `add()` / `remove()` / `resolve(…, 'failed')` 事务提交成功后各拍一次 `nudgeReminders()`。
   为什么放在 store 而不是工具面：工具的写路径以外还有后台删除与人工收敛，放在 store 才**一处覆盖全部**。
   为什么在事务**之后**：写盘失败就不该改排程（改了排程但状态没落地，下一拍会重新读到旧值并再算一次，
   白醒一次；虽然无害，但没有理由）。
   **边界**：`nudgeReminders()` 的语义是"尽力而为"——它永不抛（写入结论不受排程通知失败影响），
   且没有 runner 在跑时是空操作。所以它只能把"最坏等一个心跳"缩到"立刻"，
   **不能**保证 5 秒承诺在"插件没启动"时也成立（那时本来就没人发）。
7. **`wakeupAtsOf` 只看前 50 行**（`MAX_ROWS_FOR_WAKEUP`）。表按 `at` 升序、`list()` 的排序是
   `fired` 优先再按 `at`，所以正常情况下前 50 行就是最近的那些。**边界**：若表里同时躺着
   远超 50 条的未触发提醒，排在 50 名之后的那些这一拍看不到它们——但 `due()` 与
   `MAX_CATCH_UP_PER_TICK` 仍然会按拍消化，只是"精确唤醒"退化成"心跳粒度"。不丢提醒，只丢精度。
8. **告警/可观测性仍依赖 grep**。结构化日志解决了"事后能算"，但**没有**做"迟到自动告警"。
   本事故若发生在修复后，会在 `00:22:10` 打一行 `latenessMs=2530430` 并额外刷一行"迟到"，
   但**没人会因此收到通知**。要闭环得在宿主侧对 `latenessMs > 阈值` 做计数上报。
9. **闸门判定仍然不打数字**（§5.2 建议的四列里只做了一半）。`reminders: <id> 被共享闸门拦下（<reason>）`
   还是只有理由字符串，没有 `gateNow` / `gateRoomLastSentAt` / `gateWaitMs`。
   好消息是：`reminder` 档只剩 `no-channel` / `binding-invalid` 两种理由，而这两种都不是"等一下就会好"
   （通道断开、房间没绑定），所以"看不出还要等多久"的代价在这次场景里基本消失了。
   坏消息是：**若将来又给 `reminder` 档加回任何"等一等"的判据，这条取证困难会立刻回来**。
   加回判据时请顺手把这三列打上。

---

## 8. "5 秒问题"：**修复前**能做到的最好精度是多少

**答案：做不到 5 秒。修复前的下界是 30 秒的轮询周期，实际抖动约 3–5 秒叠加，最坏 35 秒量级。**

> ⚠️ 本节的**行号全部指向修复前的生产代码**（`dsh-production` 检出，即 HEAD 版本），
> 不是本 worktree 现在的文件——本 worktree 里 `runner.start()` 已经移到 `runner:164` 并改成心跳。
> 这一节保留的是"当时为什么达不到"的证据，不是当前行为（当前行为见 §6.2）。

依据（全部可指到具体行）：

- `runner.ts:147` `start(intervalMs = 30_000)` —— 默认每拍 30 秒（**修复前**）；
- `runner.ts:157` `this.timer = setInterval(..., intervalMs)` —— 固定周期，不是"按 `at` 精确定时"；
- `runner.ts:167` 启动横幅 `reminders: runner started (every ${intervalMs}ms)`，日志实测
  `L16249`/`L16959` 都是 `runner started (every 30000ms)`；
- 实测 84 个相邻 tick 间隔：**29,955 – 30,058 ms，中位 30,008 ms，均值 30,007.687 ms**，
  每拍平均漂移 **+7.687 ms**（累计 42 分钟漂 ~640 ms）。

因此：
- 期望时延 ≈ 15,000 ms（均匀相位）**+ 本拍处理延迟 3.0–4.8 s** ≈ **18–20 s**；
- 最好情况 ≈ 3–5 s（`at` 刚好落在网格上）；
- 最坏情况 ≈ 30,000 + 4.8 s ≈ **35 s**；
- 本次实测（若闸门放行）：桶 A + 桶 D = `8,651 + 1,071 = 9,722 ms` ≈ **9.7 秒** ——
  落在上述区间内，说明除了闸门，这条链路本身是"能用"的。

**要真正做到 5 秒以内，必须换机制**：按 `at` 排序的单次定时器（`setTimeout(at − now)`，
并在 `at` 变更时重排），而不是 30 秒扫描。这也是"最小间隔 30 s 就是承诺精度"这件事
必须在文档里写死的原因 —— 今天的 30 s 是**扫描周期**，不是**承诺精度**，二者被混为一谈
才是"5 秒问题"的根源。

---

## 9. 与本次修复的关系（给 review 的三句话）

1. 时延的根本原因是**把主动搭话的节流器套在提醒上**。所以修的方向不是"调大/调小冷却"，
   而是**让提醒走自己的判据集**（`gate.ts:234` 的 `REMINDER_BUDGET_CHECKS = [checkChannel]`
   + `gate.ts:237-239` 的 `budgetChecksFor()`，`reminders/index.ts:141` 传
   `profile: 'reminder'`）。**`proactive` 档逐条未变**（缺省值即 `'proactive'`），
   主动消息的行为与修复前完全一致。
2. **只改判据还不够**：桶 A + C + D 合计 26.4 秒仍然存在，18 秒级的期望时延依旧是"提醒不准"。
   所以同时换了调度机制（`wakeup.ts` + `schedule.ts`，见 §6.2）。
   但注意 §7 第 6 条：`nudgeReminders()` **还没有调用方**，"运行中新建的提醒"暂时仍退回心跳粒度。
3. **同样的坑已经踩过一次，而且那次更糟**：`2026-11-03 13:10:13.786`–`13:23:57.797`
   （`L8312`–`L8425`）`r_mw0608ijsjvf` 被 `quota:global`（27 次）+ `quota:room`（1 次）
   拦了 **28 个 tick / 824 秒**，最后靠 `13:24:28` 重启才结束，而重启后 CAS 判定
   `revision-changed`（`L8486`），这条提醒**被记为 `unknown`、从未送达**（`L8487`）。

   > 推论：现在的配置把 `dailyQuotaGlobal/PerRoom` 设成 `.inf`，**只是把这两个闸门关掉了**，
   > 并不是问题消失了。若按 `CONTACT_DEFAULTS` 的默认值（`contact.ts:53-54`，3 条/2 条）运行，
   > 2026-11-09 这一天光 `recentReasons` 里就能数出 ≥7 次成功投递（07:56、06:56、05:56、
   > 04:47、03:25、02:25、23:21）——`quota:global` 会先于冷却把这条提醒拦下。
   > `recentReasons` 只是 50 条环形缓冲，真实计数只会更多，不会更少。

---

## 10. 第二轮 P1-A：存储所有权模型（跨进程事务锁）

第一轮把"只发一次"寄托在落盘的 `claim` 上，但**认领本身没有跨进程互斥**：两个独立进程
各自读到 `claim=null`、各自写 claim、各自 rename，最后盘上只剩一个 claim，而**两条消息都
已经发出去了**。磁盘的最终状态证明不了"只发了一次"。

### 10.1 选的模型：真正的跨进程事务锁（不是严格单写者）

| 选项 | 结论 | 理由 |
|---|---|---|
| 严格单写者（数据目录级进程锁，第二个进程启动即失败） | 不选 | 生产里"主控 + 独立 worker"是有意义的部署；把它禁掉等于拿功能换实现简单。而且"第二个进程必须启动失败"在 DSH 宿主里代价很大（整个插件行起不来） |
| 手写 lock 文件 + TTL | 不选 | 任务是明确禁止的。TTL 短 ⇒ 误删仍被活跃进程持有的锁（直接导致重复外发）；TTL 长 ⇒ 崩溃后永久死锁。"崩溃恢复"和"不误删"在只有 TTL 一个旋钮时是**互相冲突**的 |
| 现成文件锁库（`proper-lockfile` 等） | 不选 | 插件依赖只有 `silk-wasm` / `ws`，加一个运行时依赖要连带改发布与审计面 |
| **SQLite 事务锁（`node:sqlite` 的 `BEGIN IMMEDIATE`）** | **选** | Node 24 内置（`engines.node >= 24`，`companion-foundation/group-memory.mjs` 已在用同一套取法），**零新依赖**；互斥由内核（POSIX `fcntl` / Win32 `LockFileEx`）提供；**进程崩溃即自动释放**，不需要 TTL，也不会误删活锁 |

实现：`src/adapters/fs-store/process-lock.ts`（`SqliteProcessMutex`）。锁文件是
`<reminders.json>.lock.db`——同目录 ⇒ 同一个 `dataDir` 一定是同一把锁，不需要额外配置。

### 10.2 八条要求逐条对照

| 任务书要求 | 落点 |
|---|---|
| ① 同一个存储文件对应同一把锁 | 锁文件名由提醒文件路径直接派生（`process-lock.ts` 构造函数），不可能配错 |
| ② **所有**读-改-写事务都遵守同一把锁，不能只给 `claim()` 加锁 | 锁在 `store-transaction.ts::transact()` 里，是**事务层**而不是某个方法。`add/remove/markFired/markSent/setPendingDispatch/expireStale/capBacklog/resolve/pruneFired/claim/releaseClaim/renewClaim` 全部经过它——**没有一个写方法能绕开** |
| ③ 拿到锁后**重新读磁盘**，不许用内存快照当基线 | `readBaseline()`（`store-transaction.ts`）在锁内 `readOnce()` + `decodeReminderFile()`；读失败/解码失败 ⇒ `REFRESH_FAILED`，**绝不用旧快照硬写** |
| ④ 锁内完成"读 → 校验 → reducer → 原子写 → 发布" | `transact()` 的六步：取基线 → `structuredClone` 草稿 → `edit(draft)` → `validateCandidateOrThrow` → `replaceSerialized`（rename = 提交点）→ `publish` |
| ⑤ 写成功后才释放锁 | `finally { lease?.release() }`，`release()` 走 `ROLLBACK`（见 §10.4） |
| ⑥ 抢锁超时/暂时失败 ⇒ **不许继续发送**，返回可诊断的暂时失败 | 超时抛 `LockTimeoutError` ⇒ 事务抛 `LOCK_TIMEOUT`（**不在 `HALT_WORTHY` 里**：暂时性故障不该停表）。投递路径上 `dispatchOne()` 把"认领失败"当**本拍不发**并留一行日志——认领没成功就**绝不**调用 `send()` |
| ⑦ 进程崩溃后有明确恢复策略；不许凭 TTL 删活锁 | 崩溃 = 内核释放文件锁。实测：`SIGKILL` 掉持锁进程后，另一个进程**1 ms** 就拿到了（`test/reminders-multiprocess.test.ts` M5 把它固化成用例）。这里**没有 TTL 可以误删** |
| ⑧ 释放时校验 owner/token，禁止释放别人的锁 | 见 §10.4：跨进程那一半由"只有持有该打开事务的进程能对它 `ROLLBACK`"保证；进程内那一半由 lease 的 `token` 只能 release 一次保证——结构性不可能替别人解锁 |
| ⑨ Windows 与 Linux 都验证 | Windows 为本机实机（`npm test` 全绿）；Linux 由 CI 跑同一套测试。锁用的是 SQLite 的跨平台文件锁，不是平台特化的 `flock`/`LockFileEx` 直调 |

### 10.3 为什么锁里**不写任何数据**、释放用 `ROLLBACK`

提醒数据不在 SQLite 里（它是独立的原子 rename），所以这个事务只当**互斥量**用。这不是
审美，是实测出来的必要选择：

- **rollback journal 模式下，持锁者 `COMMIT` 时若有竞争者在敲门，会随机抛
  `database is locked`**（本机实测 10 次里 4 次）。持锁者"释放失败"会把锁泄漏到进程退出，
  正是最不该出现的那类故障；
- 同一压力下 `ROLLBACK` **10/10 成功**（含"写了行再回滚"）；
- 附带两个好处：锁文件**0 字节**（没有任何需要在 schema 上迁移的状态），以及 dryRun
  全程连锁文件都不会被创建。

### 10.4 归属校验与"不许替别人解锁"

三层，逐层收紧：

1. **内核**：`BEGIN IMMEDIATE` 拿到的是排他写锁。别的进程连 `BEGIN` 都进不来，**没有
   任何 API 能对别人的事务执行 `ROLLBACK`**；
2. **进程内 lease**：`acquire()` 返回的 lease 带 `token`，`release()` 只能成功一次；
   第二次返回 `false` 并留痕。`held !== token` 时不放锁、交给句柄关闭；
3. **认领层的 owner**：`store.releaseClaim(id, owner)` 带 owner 之后，`reduceReleaseClaim`
   在 `claim.by !== owner` 时回业务拒绝 `STALE_STATE`（盘上一个字都不改）。这条与锁无关，
   但同样属于"不许替别人放开这一轮"——**替别人放回等于让对方的下一次扫描重发一遍，而
   对方可能正在发**。

### 10.5 认领硬性不变量（逐条）

| 不变量 | 落点 / 证据 |
|---|---|
| 发送前 claim 已成功持久化 | `dispatchOne()` 的顺序：`claimForDispatch()` → `send()`。M2 里两个进程的发送次数之和 = 1 |
| 认领失败绝不调用 QQ 发送 | `dispatchOne()` 的 `catch` 直接 `return true`（本拍不发）；M4：认领写盘失败 ⇒ 发送次数 **0** |
| 同一提醒/同一 occurrence 只有一个有效发送者 | 锁 + 锁内重读基线 ⇒ 后到者的 reducer 看到 `claim=<前者>` ⇒ `STALE_STATE`。M1：只有一个进程认领成功 |
| claim 过期**不自动重发**，按 `unknown` 收敛 | `claimStateOf()` 的 `stale` 分支 → `resolveStaleClaim()` → `reduceMarkUnknown(..., 'claim-expired:unknown')`。M8：发送 0 次、盘上 `unknownReason=claim-expired:unknown` |
| `unknown` 不得被普通 tick 自动恢复 | `dueOf()` 只看 `!fired`；`reduceMarkUnknown` 对一次性提醒置 `fired=true`、对周期提醒推进 `at`。普通 tick 走不到它 |
| 只有人工确认"确实没发送"才重新排队 | `store.resolve(id, 'failed')`（后台 `resolve` action）→ 清 `unknownAt` + `fired=false` + 删 `claim` |
| 网络发送不在全局文件锁内等待 | 锁的持有范围只有"读 → reducer → 写盘"这一小段（毫秒级）；`send()` 在 `transact()` **返回之后**才调用（M7：发送期间第二进程认领被拒，但第一进程的发送不受锁影响） |
| claim TTL 与发送超时协调（续租） | `claim-renewal.ts`：发送期间按 `TTL/3` 续租。见 §10.6 |
| 没有平台幂等键 ⇒ **不宣称 exactly-once** | 本模型是 **at-most-once 倾向**（宁可等人工确认，也不自动重复外发）。文档与日志都不用 "exactly-once" |

### 10.6 续租（TTL 与发送超时协调）

TTL 的用途是"崩了之后别人能判定这一轮作废"，**不是**给发送掐表。一次真实发送可能比
`DEFAULT_CLAIM_TTL_MS = 120_000` 还慢（出站队列限速 + 多段 + 平台慢）。不续租的话：
我们还在发 → 认领先过期 → 别的进程判 `stale` → 收敛成 `unknown` → **一条真发出去的消息
被记成"不确定"**。

`startClaimRenewal()` 在 `send()` 期间按 `TTL/3 = 40 s` 续租，`finally` 里停掉。
续租失败**只记日志**，不改投递结论（消息可能已经发出去了，把"续租失败"写成"没发出去"
会直接导致重复外发）。

### 10.7 退化路径（必须说出来，不许假装支持）

`node:sqlite` 取不到时（只可能是被裁剪的运行时），`store.writeModel()` 返回
**`in-process-only`**，并且写事务退回内存基线（只有进程内 `SerialQueue` 互斥）。
这条**不静默**：诊断面 `writeModel()` 可读、日志会说明。
`test/reminders-multiprocess.test.ts` 里每条用例都断言 `writeModel === 'cross-process-lock'`，
所以"悄悄退化成单进程"会让测试立刻红——这是防止退化被忘记的唯一可靠办法。

### 10.8 独立进程测试（`test/reminders-multiprocess.test.ts`）

八个用例都 `fork` **真子进程**（独立 pid / 独立模块实例），用 IPC barrier 对齐并发起点，
用假发送适配器计数，用假时钟固定"现在"，并在结束时清理临时目录与锁文件：

| 用例 | 断言 |
|---|---|
| M1 两个进程同时认领同一提醒 | 只有一个 `claimed`；输的一方 `STALE_STATE`；盘上 claim 归赢家；`writeModel=cross-process-lock` |
| M2 两个进程同时认领并尝试发送 | 发送次数之和 **严格 = 1**；发完 `fired=true`、`claim` 已清 |
| M3 两个进程改不同提醒 | 两条更新**都在**（不丢更新） |
| M4 认领写盘失败 | 投递路径发送 **0** 次；底层认领抛 `PERSIST_FAILED`；盘上未消耗、无残留 claim |
| M5 持锁进程被 `SIGKILL` | 另一进程**立刻**能拿到锁并正常投递（不靠 TTL） |
| M6 owner 不匹配 | 认领被挡（`STALE_STATE`）、放回也认出"不是我的"（`STALE_STATE`）、盘上租约与到期时刻都没变 |
| M7 活跃发送超过一拍 | 第二进程认领被拒、发送 0 次；第一进程照常发完 |
| M8 claim 过期 + 重启 | 发送 0 次、盘上 `claim-expired:unknown`、重启后 `fired=true` 且无 claim |

> 第一轮的 T4（同一进程两个 runner）**保留为同进程回归**，但**不再**作为跨进程证明——
> 同一进程里的两个 Store 共享 `OWNERS`、串行队列与锁实例，它们"互斥"只能证明进程内互斥。



---

## 11. 第二轮 P1-B：到期未消费不再 1 ms 空转

### 11.1 问题

第一轮对**任何**已经过去的时刻都排 `MIN_WAKEUP_MS = 1`（`schedule.ts`）。那只在
"这一拍一定会消费掉它"时成立。现实里有大量**合法地不消费**的路径：

| 现场 | 为什么不消费 |
|---|---|
| `dryRun`（默认就是 `true`） | 设计上整条入口零持久化写入 ⇒ 提醒永远保持 `fired=false` |
| `skipped`：通道暂不可用 | 现在不该发，等它自己变好（不消耗） |
| `skipped`：房间不在白名单 / 按群策略关掉 | 同上 |
| `skipped`：日程 CAS 暂时阻断 | 同上 |
| 积压 > `MAX_CATCH_UP_PER_TICK` | 这一拍只发了 3 条，剩下的仍然 due |

于是下一拍 `wakeupAtsOf()` 仍看到那条 due ⇒ 1 ms ⇒ 又一拍 ⇒ **CPU 空转 + 日志刷屏**
（`dryRun` 下还有一行"演练模式不落盘"每拍一条）。这不是"精度高"，是"没有调度状态"。

### 11.2 模型：首次立即检查 + 未消费后退避（进程内状态，不落盘）

`schedule.ts` 现在把到期项与未来项**分开算**：

```
下一次延迟 = min(
  到期项 ? min(overdueGap, heartbeat) : ∞,
  未来项 ? min(next.at − now, heartbeat) : ∞,
  都没有 ? heartbeat
)
```

- **未来项**：仍然精确到它的 `scheduledAt`（第一轮的精度一点没退）；
- **到期项**：`overdueGapMs({ passes, heartbeatMs })`——
  `passes === 0` ⇒ `BACKLOG_GAP_MS = 1_000`（有进展：积压按节奏继续）；
  `passes > 0` ⇒ `1s × 2^passes`，**上限是心跳**；
- 两者取更早的：一条 15 秒后的新提醒**不会**因为旁边有积压而等到退避间隔之后。

"`passes`"（连续几拍没进展）由 `backoff.ts::WakeupBackoff` 维护，判据只有一条：

> **到期项的数量比开拍前少了没有。** 少了（或本来就没有）⇒ 有进展 ⇒ 清零。

为什么按**数量**而不是"这一拍发了几条"：`skipped` 与 `dryRun` 都是"一条没发但不是故障"；
而认领被另一个进程抢走（本拍没发、但对方发掉了）会让数量变少 ⇒ 正确地算成"有进展"。

**状态只在内存里**（一个 `WakeupBackoff` 实例）。dryRun 的硬不变量是"整条入口零持久化
写入"，写一个 `retryAt` / 改 `attempts` 来实现退避就直接违反了它——所以这里连一个字段
都不落盘。

### 11.3 任务书 §3.4 那张表逐行对照

| 状态 | 要求的下一次调度 | 实际 |
|---|---|---|
| 存在未来提醒 | `min(最近 scheduledAt − now, heartbeat)` | `planWakeup()` 的 future 分支，逐毫秒被 S1 钉住 |
| 启动时发现已有到期提醒 | 立即执行一次检查 | `start()` 排 0 ms（`WakeupTimer.start()` → `arm(0)`）；S9 断言"只跑一拍就发出去" |
| 本轮后仍有未消费到期提醒 | 心跳或有上限的退避 | `overdueGapMs()`：1s → 2s → … → heartbeat；S4/S5/S6 断言频率上限 |
| dryRun 命中 | 不写盘，按心跳检查 | 退避稳定在心跳；S4 同时断言**盘上逐字节不变** |
| 通道暂不可用 | 按退避/心跳重试，不得 1 ms 循环 | S6（2 分钟内 tick ≤ 40） |
| 房间/绑定暂时不满足 | 不消耗提醒，按合理间隔重新检查 | S8（"跳过"日志 ≤ 20 条、`fired` 仍 false） |
| 没有待处理提醒 | 心跳兜底 | `planWakeup({ats: []})` = heartbeat |
| runner 已停表 | 不得继续创建密集定时器 | `dispose()` 撤定时器；S11 断言 dispose 之后 tick 归零 |

### 11.4 没有做的事（以及为什么）

- **没有把 `MIN_WAKEUP_MS` 改大**。改成 1000 只是把空转频率降下来，"这一拍有没有进展"
  这个语义仍然不存在：积压批次与通道故障会共用同一个固定间隔——积压太慢、故障太快，
  两头都不对。`MIN_WAKEUP_MS` 保留为"立刻"这一档的下界（`planWakeup` 的最终 `max()`）。
- **没有靠"把提醒标成 fired"来消除空转**（任务书明确禁止）。S6/S8 都断言"提醒仍保留"。
- **没有持久化退避状态**（见 §11.2）：那会直接破坏 dryRun 零写入与旧数据字节兼容。

### 11.5 积压节流（任务书 §4）

`batch.ts::takeBatch()` 保留每拍上限 `MAX_CATCH_UP_PER_TICK = 3`（一次性提醒计数，
周期提醒不占额度）。第二轮补上的是**批次之间的间隔**：发完一批之后仍有 due ⇒
`passes = 0` ⇒ 下一拍在 `BACKLOG_GAP_MS = 1_000` 之后。于是"每批 3 条、每批间隔 ≥ 1 秒"
成为可断言的约定（S12），10 条同时到期大约 3–4 秒发完，而不是瞬间喷完或每毫秒一拍。

**没有新增限速器**：真正的出口限速仍然只有 `out.push()` / `rateLimitMs` 一处
（`outbound.ts`）。这里只控制"批次节奏"，不重复实现发送限速。

### 11.6 可观测性

`runner.status()` 多了一个只读字段：

```jsonc
"backoff": { "overduePasses": 3, "gapMs": 8000 }
```

`overduePasses` 在涨 = "到期项一直没被消费"（`dryRun` / 通道断开 / 房间不许发）；
`gapMs` 是实际采用的下一拍间隔。**这两个数就是为了让"日志暴涨"能被一眼读成"passes 在涨"**
——第一轮的现场只能看到"每秒被拦一次"，看不出是闸门在拦还是调度在空转。

### 11.7 测试（`test/reminders-backoff.test.ts`，12 个用例）

全部跑在 `FakeClock` 上，断言的是**频率**（tick 次数 / 最小间隔 / 日志条数），不靠真实等待：

| 用例 | 钉住的东西 |
|---|---|
| S1 | `planWakeup()`：到期项按 `overdueGap`、未来项仍精确到 `scheduledAt`、两者取更早、都没有则心跳 |
| S2 | `overdueGapMs()`：有进展 1s、没进展翻倍到心跳、心跳比基础间隔更小时不反超 |
| S3 | `WakeupBackoff`：变少 = 有进展（清零）、没变少才累加、`reset()` 复位 |
| S4 | dryRun + 过期提醒：`overduePasses ≥ 1`、`gapMs ≥ 1s`、**盘上逐字节不变** |
| S5 | dryRun 跑 5 分钟：唤醒次数 ≤ 30（心跳封顶）、相邻唤醒最小间隔 ≥ 1s |
| S6 | 通道不可用：发送 0 次、提醒保留、2 分钟内 tick ≤ 40 |
| S7 | 通道恢复：**最多一个心跳内**补发一次（退避不饿死提醒） |
| S8 | 房间不许发：`fired` 不写、1 分钟内"跳过"日志 ≤ 20 条且 ≥ 1 条（不静默） |
| S9 | 启动时已有过期提醒：启动那一拍就补发（不先等心跳） |
| S10 | 退避期间 `nudge`（新建提醒）：立刻重排，新提醒仍被处理 |
| S11 | `dispose()` 之后：假时钟里 0 个定时器、tick 数不再增长 |
| S12 | 10 条同时到期：每批 ≤ 3 条、相邻批次首条间隔 ≥ 1s、10 条全部 `fired`、有"按每拍上限"日志 |

---

## 附录：复现本文数字的命令

```powershell
# 1) 时间线关键时间戳 → Asia/Shanghai
node -e "const f=ms=>new Date(ms).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'});\
[1794237779500,1794238800000,1794238808651,1794238808654,1794237712646,1794241312646,\
1794241299292,1794241330369,1794241330430].forEach(m=>console.log(m,f(m)))"

# 2) 84 条拦截日志的间隔分布（行号 16753–16925）
$l=[System.IO.File]::ReadAllLines('data/home/channel-qq.log')
$t=@(); 16752..16925 | ?{ $l[$_] -match 'reminders: r_mw9euj3gdwqo 被共享闸门拦下' } |
  %{ $t += ([datetimeoffset]::Parse(($l[$_] -split ' ')[0])).ToUnixTimeMilliseconds() }
$g = 1..($t.Count-1) | %{ $t[$_]-$t[$_-1] }
$g | Measure-Object -Minimum -Maximum -Average     # 29955 / 30058 / 30007.687

# 3) 事故当时 lastSentAtByRoom（现在 counters 已被覆盖，必须从这两处取）
$j = Get-Content -Raw -Encoding utf8 'data/home/channel-qq/contact.json' | ConvertFrom-Json
$j.outbox['d-c-mw9ert9n-dho'].submittedAt         # 1794237712646
$j.recentReasons -match 'mw9ert9n'                # …15:21:52.646Z… sent:submitted

# 4) 提醒库（注意是 workspace 那份，不是 home/channel-qq 那份）
Get-Content -Raw -Encoding utf8 'data/workspace/reminders.json'
```

> 提醒：`data/` 是活的数据目录。`contact.json` 的 `counters` 与 `lease` 会在采集之后继续变化，
> 本文引用的 `counters` 值请按上面第 3 步重建，不要读当前值。

---

