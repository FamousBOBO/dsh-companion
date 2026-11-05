# 华为 CN 读取协议 · 冻结（v1，2026-11-03）

> 本文件是 `sidecars/huawei-health-cn` 的**协议真相**。上层（`plugins/companion-health` 的
> `cn-adapter.mjs` / `normalize.mjs`）按这里的名字、形状、单位、时间口径来写，不允许自行猜测。
> 要改，先改本文件、再改 `redact.py` 与 `test_protocol_contract.py`，然后重新采快照。
>
> 证据：`snapshots/cn-snapshot-20261103-2100.json`（真实账号、已脱敏）+
> `test_protocol_contract.py`（43 条离线断言）。

---

## 1. 版本点

| 项 | 值 |
| --- | --- |
| 冻结日期 | 2026-11-03 |
| 上游仓库 | `https://github.com/and7ey/huawei_health` |
| 上游分支 | `cn-hosts-default` |
| 上游提交 | `1ec3e4120a6b9c4e8327ba08c3d12fe9994d63f7`（`Read the account nickname on the CN contour`） |
| 集成版本 | `custom_components/huawei_health/manifest.json` → `1.1.0` |
| 运行时 | `tmp/hwvenv`，Python **3.13.11**（`client.py`/`const.py` 只用标准库） |
| 复制件校验 | `python/client.py` `44398d75e6c6b227…`、`python/const.py` `0ee70e3cb95a793b…`、<br>`python/huawei_dashboard.py` `ca44f47d411f8597…`（= 原件 on-disk sha256，见 §9） |
| 采样时刻 | 2026-11-03 21:15:38 +08:00（同夜 21:04:27 的第二次采集数值完全一致），窗口 7 天，7 次云调用 |

## 2. 端点：只有一个

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/data?days=3\|7\|30` | 全量快照。`days` 只接受 3/7/30（其它值被服务端夹回默认） |
| `GET` | `/api/data?days=7&force=1` | 绕过 15 s 缓存，真的打云端 |
| `GET` | `/` | HTML 面板（人看的，机器不要依赖） |

口径与限制（实测，见 `tmp/huawei_health_test_report.md`）：

- **只监听 `127.0.0.1`**。任何非 loopback 调用一律不该存在；`cn-adapter.mjs` 里非 loopback
  必须直接返回 `non-loopback-refused` 而**不发请求**。
- **服务端 15 s 缓存 + 单飞**（同一时刻只有一次真拉取）。重复拉取不算罪，但**不要超过每 15 s 一次**。
- 成本：7 天窗口 = **7 次**云调用、约 **1.4–1.5 s**；30 天窗口 = 9 次（训练按 10 天切片）。
  云端限流实测在 ~40 次突发调用后给 `1101 Too Many Requests`。
- 单次云调用 180–250 ms；`*ByTime` 窗口 **>10 天** 必给 `1001 parameter invalid`（面板已切片）。

## 3. 顶层字段（实测 21 个 + 我们的 `_capture`）

```
cache_age_s  cache_ttl_s  calls  daily  devices  errors  health  history
newest_cloud newest_cloud_text  oauth_base  realtime  scope  server_time_text
sessions  sleep_rows  sources  synced_at  synced_at_text  token  total_ms
```

契约测试要求这 13 个**必须存在**（其余是可选的辅助字段）：
`synced_at, synced_at_text, daily, health, sleep_rows, sessions, devices, realtime, token,
sources, errors, newest_cloud, scope`。

| 字段 | 类型 | 口径 |
| --- | --- | --- |
| `synced_at` | float | 本次拉取时刻，**epoch 秒**（本地时区解释） |
| `synced_at_text` | str | `YYYY-MM-DD HH:MM:SS`（本地，无偏移） |
| `server_time_text` | str | 同上，服务端时刻 |
| `total_ms` | float | 整次拉取耗时 |
| `calls[]` | list | `{url, ms, code, ok}`，**每次云调用一条**；`url` 里没有凭证 |
| `sources[]` | list | 数据源表的行：`{name, ms, text, rel, rt_text}` |
| `history[]` | list | 最近 20 次刷新：`{at, at_text, total_ms, calls, days, ok}` |
| `daily[]` | list | 每日活动（见 §4.1） |
| `health[]` | list | 每日健康（见 §4.2） |
| `sleep_rows[]` | list | **本账号恒为 `[]`**（见 §5.1）；实现上 = `health[]` 里带 `sleep_*` 键的行 |
| `sessions[]` | list | 训练会话（见 §4.3） |
| `devices[]` | list | 绑定设备（见 §4.4，标识已假名化） |
| `realtime{}` | dict | 云端最新一条已上传样本（见 §4.5，**键是中文**） |
| `token{}` | dict | 只允许白名单键（见 §4.6） |
| `errors[]` | list[str] | 各分区失败原因；某分区失败不会让整体 500 |
| `newest_cloud` | float/秒 | 云端记录里最新的时间戳（各 family 的 `version`/`generateTime`/`modifyTime` 取最大） |
| `newest_cloud_text` | str | 同上，格式化 |
| `scope` | dict | `{days: 7, allowed_days: [3,7,30]}` |
| `oauth_base` | str | `https://oauth-login.cloud.huawei.com.cn/oauth2` |
| `cache_age_s` / `cache_ttl_s` | float | 缓存年龄 / TTL（15.0） |
| `_capture` | dict | **我们加的**，不是 sidecar 的字段（见 §6） |

## 4. 字段级契约

### 4.1 `daily[]`（每日活动，实测 10 键）

```json
{"date":"2026-11-03","sport_type":0,"steps":1112,"distance_m":864,"kcal":53.1,
 "duration_min":32,"walk_min":30,"active_hours":3,"exercise_min":1,"step_goal":10000}
```

- 必含 `date`（`YYYY-MM-DD`）、`steps`（int ≥ 0）、`distance_m`（米）、`kcal`（千卡，**上游已 ÷1000**）。
- `sport_type = 0` 是**当天合计行**（与 App 首页圆环一致）；其它值是按运动拆分的行。
- `active_hours` / `exercise_min` 可能是 `null`（云端没给），**不是 0**。
- `daily[]` 按 `date` 升序、去重。

### 4.2 `health[]`（每日健康，实测键）

`date`（必有）+ `heart_rate` / `max_heart_rate` / `min_heart_rate` / `resting_heart_rate` /
`stress_average` / `stress_last` / `stress_max` / `stress_min` / `stress_measurements` /
`moderate_high_intensity_minutes` / `spo2_avg` / `spo2_min` / `spo2_max` / `spo2_last`
（睡眠族出现时还会有 `sleep_duration` / `sleep_deep` / `sleep_light` / `sleep_rem` /
`sleep_awake` / `sleep_score` / `sleep_efficiency` / `sleep_latency` / `sleep_wake_ups` /
`sleep_average_heart_rate` / `sleep_hrv` / `sleep_spo2` / `fall_asleep` / `wakeup`）。

- **`0` 与 `-1` 是「没测到」，不是读数**：`client.health_series()` 直接丢掉。因此
  payload 里出现的数值**永远 > 0**；契约测试对这一点有断言，也有对 `health_series()` 的
  正反用例（喂 0/-1 必须消失）。上层再看到 `null` 才是"缺"，**不要**把 0 当 0 分压力。
- 实测 2026-11-03：心率 last 95 / max 112 / min 58 / resting 79；压力 avg 65 / max 69 /
  min 61 / last 65 / 测了 6 次；血氧 avg 97.11 / min 95 / max 99 / last 99；中高强度 1 分钟。
- 2026-10-30 只有 `moderate_high_intensity_minutes: 1.0` 一项（其它 family 那天没有）。

### 4.3 `sessions[]`（训练，实测 12 键）

```json
{"sport_type":2,"duration_min":2,"steps":174,"distance_m":132,"kcal":15.5,"segments":2,
 "device_code":2323025196,"start":"2026-11-03T17:13:00","end":"2026-11-03T17:15:00",
 "sport":"hill","start_text":"11-03 17:13","end_text":"17:15"}
```

- **`sport_type` 保留云端原始整数**（本账号实测 `2`）。`sport` 是上游表的标签（`2 → "hill"`），
  **只用于展示，不当事实**：`const.SPORT_TYPES` 的映射对 1–3 分钟的行走段明显偏"爬坡"。
  上层请存 `sportTypeRaw`，`sportTypeLabel` 另存并标 `sportTypeMapping: 'upstream_const'`。
- `start` / `end` 是**无时区的本地 ISO**（`2026-11-03T17:13:00`）。上层必须用
  `fromNaiveLocalIso()` 按 `Asia/Shanghai` 换算，不要当 UTC。
- `segments` 是分钟段数，`duration_min` 是累计分钟（同分钟多设备上传已去重）。

### 4.4 `devices[]`（设备，**标识已假名化**）

本账号 9 台，实测出现的键：`deviceCode, source, productId, uniqueId, devId, name, prodId,
deviceTypeId, status, priority, modifyTime, manufacturer, firmwareVersion, hardwareVersion,
softwareVersion, deviceData, sn, mac, udid`。

脱敏规则（`redact.py`）：

| 字段 | 处理 |
| --- | --- |
| `uniqueId`、`devId` | → `sha256(raw)[:16]`（协议要求） |
| `udid`、`sn`、`mac` | → `sha256(raw)[:16]`（同类标识；`INTERFACES.md` §4/§13 禁止明文 MAC，本账号 4 台设备确实返回 `mac`、3 台返回 `sn`、1 台返回 `udid`） |
| `deviceData` | → `{bytes, sha256_16, dropped: true}`（不透明 blob，读路径不需要） |
| `name`、`deviceCode`、`productId`、`prodId`、`status`、`priority`、`modifyTime` | **保留**（`deviceCode` 可用于按设备过滤；`name` 是验收日志要读的） |

实测设备名（脱敏后可安全引用）：`HUAWEI Band 8-002`（productId 700 / prodId `M0CT`）、
`honor watch S1-c16`（41 / `004W`）、`OnePlus5T`（32 / `006S`）、`NOH-AN01` ×3（32 / `006S`）、
`DBY-W09`（32 / `006S`）、`手动输入`（1 / `0062`）、一台 `name` 为 `null` 的条目。

### 4.5 `realtime{}`（云端最新已上传样本）

```json
{"心率": {"value":95.0,"unit":"bpm","at":1793708340.0,"at_text":"2026-11-03 20:19:00",
          "rel":"45 分钟前","device":1260900415},
 "压力": {"value":65.0,"unit":"","at":1793708119.0,...},
 "血氧": {"value":99.0,"unit":"%","at":1793707920.0,...}}
```

- **不是蓝牙实时**：是云端最新一条**已上传**样本（心率按分钟、压力/血氧按测量）。
  `at` 是 epoch 秒，`at_text` 是那次测量时间。
- ⚠️ **键是中文常量**（`心率`/`压力`/`血氧`）。上层**不要**按这些键取值——用
  `sources[].rt_text`（同样的数值，人话）或直接从 `daily`/`health` 取。这是个坑，别踩。
- `sources[]` 的 `name` 同样是中文：`血氧 / 压力 / 心率 / 活动 / 训练 / 中高强度 / 设备`，
  `rt_text` 形如 `"95 bpm @ 20:19"`、`"今日 1112 步"`、`"9 台"`。

### 4.6 `token{}`（脱敏后）

**只允许**这 7 个键（`redact.TOKEN_KEY_WHITELIST`）：

```
session_host  data_host  expires_at_text  expires_in_min  refresh_dies_text  rotated  uid_sha256_16
```

- sidecar 自己给出的 `uid` 是 `"100860…"`（前 6 位 + 省略号）；我们**不用它**，改成
  `uid_sha256_16 = sha256(那个打码串)[:16]`——稳定假名，可用于"同一个账号"的判断，反推不出账号。
- **任何层级**（payload、数据库、日志、工具返回、Studio 路由）都不许出现
  `accessToken` / `refreshToken` / `Authorization` / `x-huid` / 明文 `uid`。
- 实测：`expires_in_min` 会随时间递减（21:04 采集时 50、21:15 时 39，两次都是同一个 access token
  的同一到期时刻 `2026-11-03 21:54:38`）、`refresh_dies_text: 2027-05-02 19:04:43`、
  `rotated: false`。

## 5. 时间与单位口径

| 值 | 单位 | 处理 |
| --- | --- | --- |
| `synced_at` / `newest_cloud` / `sources[].ms` / `realtime.*.at` / `history[].at` | **epoch 秒**（float） | ×1000 → ms |
| `calls[].ms` / `total_ms` / `cache_age_s` / `cache_ttl_s` | 毫秒 / 秒 | 原样 |
| 云端任何 `*Time`（`fallAsleepTime`、`wakeupTime`、`version`、`modifyTime`、`startTime`） | **毫秒** | ÷1000 若需要秒 |
| `sessions[].start` / `end` | **无时区本地** ISO | `fromNaiveLocalIso()` 按 `Asia/Shanghai` |
| `daily[].distance_m` | 米 | 原样（要 km 自己 ÷1000） |
| `daily[].kcal` | 千卡 | 上游已把云端「千分之一 kcal」÷1000 |
| `daily[].duration_min` / `walk_min` / `exercise_min` | 分钟 | 原样 |
| `health[]` 心率 | bpm | 原样 |
| `health[]` 压力 | 0–100 | 原样 |
| `health[]` 血氧 | % | 原样（`97.11111111111111` 这种浮点是对的，别取整） |
| `*_text` / `*_text` 时间 | `YYYY-MM-DD HH:MM:SS` 本地 | 原样展示 |

归属日：**一律 `Asia/Shanghai`**；睡眠按"醒来那天"归属（`design/health/INTERFACES.md` §7）。

## 6. `_capture` 元数据块（我们加的，不是 sidecar 的）

```json
{"capturedAt","source","redacted":true,"keys":[…],"counts":{…},
 "scopeDays","syncedAt","cloudCalls","errors","latencyMs","redactionRules":[…],"tool"}
```

要点：`redacted` **必须**是 `true`；`keys` = 顶层字段（不含 `_capture`）排序后的清单；
`counts` 覆盖 `daily/health/sleep_rows/sessions/devices/sources/errors` 七个数组。
序列化固定：`json.dumps(..., sort_keys=True, ensure_ascii=False, indent=2)` + 结尾换行，
因此**同一份 payload 永远产出逐字节相同的文件**（只差 `capturedAt`）。

> 刻意**不**把隐私 grep 的正则写进 `_capture`：那会让快照自己命中自己的回归检查
> （`accesstoken` / `x-huid` 变成文件里的字符串）。正则只存在于 `redact.py` 和 README §4。

## 7. 与 `tmp/HUAWEI_HEALTH_README.md` 的字段对照（给上层做映射）

冻结的是**当前 payload 的名字**（snake_case）；`design/health/INTERFACES.md` §6 的
`normalizeWindow()` 输出是 camelCase。映射表（上层照这个写即可，不要"猜"）：

| payload（本冻结） | normalize 目标 | 备注 |
| --- | --- | --- |
| `daily[].date` | `localDate` | `YYYY-MM-DD` |
| `daily[].distance_m` | `distanceM` | 米 |
| `daily[].active_hours` | `activeHours` | 可 `null` |
| `daily[].exercise_min` | `exerciseMin` | 可 `null` |
| `daily[].walk_min` | `walkMin` | 分钟 |
| `daily[].step_goal` | `stepGoal` | 步 |
| `daily[].sport_type` | `sportTypeRaw` | 0 = 当天合计行（**过滤掉再当运动**） |
| `health[].heart_rate` / `max_` / `min_` / `resting_` | `heartRate.{avg,max,min,resting}` | `heart_rate` 是"最近一次"，不是日均 |
| `health[].stress_average/last/max/min/measurements` | `stress.{avg,last,max,min,measurements}` | |
| `health[].spo2_avg/min/max/last` | `spo2.{avg,min,max,last}` | |
| `health[].moderate_high_intensity_minutes` | `intensity.moderateHighMinutes` | |
| `sessions[].sport_type` | `sportTypeRaw` | 原样整数 |
| `sessions[].sport` | `sportTypeLabel` + `sportTypeMapping:'upstream_const'` | 标签只是上游意见 |
| `sessions[].start`/`end` | `startAt`/`endAt` | 无时区本地 ISO → ms |
| `devices[].uniqueId`/`devId` | `uniqueIdHash`/`devIdHash` | **已经是 hash**，别再 hash 一次 |
| `sources[].rt_text` | 不入库 | 只用于展示 |
| `errors[]` | `faults[].message`（脱敏后） | 不要原样塞给模型 |
| `token.*` | `auth.{status,expiresAt,minutesLeft,rotated}` | 白名单之外一律没有 |

**与 README 描述不符的地方（0 处结构性差异，3 处细节）**：

1. README §8 说 `token.uid` 是"打码 uid"——实测确实是 `"100860…"`，我们进一步替换成 `uid_sha256_16`。
2. README §8 没说 `devices[]` 会含 `udid`/`sn`/`mac`——实测**有**（9 台里 1/3/4 台分别有），
   已按 §4.4 全部假名化。这是本次冻结新发现的字段。
3. README §8 没有 `_capture`、`_latency_ms`（后者只在内存里，不落盘）。

## 8. 已知缺失与坑

1. **睡眠族整族缺失**（README §10.1 已记录，本次复核仍然成立）：
   `getHealthStat type=9` 连 `professionalSleepTotal` 都不返回，`getHealthData type=9` 空，
   `sportType 6/7/8` 0 条；对照组 type 16（血氧）同日有数据 → 链路正常，是账号没有。
   因此 `sleep_rows` 恒 `[]`，`health[]` 里没有 `sleep_*`。
   上层睡眠能力本轮只能是 `awaiting_first_night`，**不许**伪造时长/阶段/评分。
2. **`sport_type: 2 → "hill"`**：上游表的问题，冻结保留，不改。
3. **type 16（血氧）不在上游 `HEALTH_TYPES` 里**，是面板 `_merge_spo2()` 补进来的；
   所以 `health[]` 里有 `spo2_*`，但 `const.HEALTH_TYPES` 只有 7/9/11/12。
4. **中文键**：`realtime` / `sources[].name` 是中文常量（§4.5）。
5. **`*ByTime` 窗口 ≤ 10 天**，超了给 `1001`；30 天视图由面板切片。
6. **限流 `1101`**：突发 ~40 次调用会触发。策略是 15 s 缓存 + 单飞 + 不扫 type 1–32。
7. **`realtime` 不是实时**：云端只存已上传样本（§4.5）。
8. `daily[].sport_type` 的 0 是合计行，不是"其他运动"。

## 9. 再冻结 / 升级流程

1. 确认 `tmp/` 原件是你要的新版本；`tmp/huawei_health` 的 git 提交写进 §1。
2. 重新复制 + 只加来源注释：

   ```powershell
   Copy-Item tmp\huawei_health\custom_components\huawei_health\client.py sidecars\huawei-health-cn\python\ -Force
   Copy-Item tmp\huawei_health\custom_components\huawei_health\const.py  sidecars\huawei-health-cn\python\ -Force
   # 然后手工把 5 行 provenance 注释块补回去，并更新里面的 upstream-sha256
   ```

3. `verify_frozen_copy.py` 必须全绿；`huawei_login.py` 的适配只允许 A1/A2 两处。
4. 重新采一份快照（**换新文件名**，别覆盖旧的），跑 `test_protocol_contract.py`。
5. 改动涉及的字段差异写进本文件 §7，并通知 Lead。
6. 旧的 `python/` 不要留在原地"备份"——冻结件只有一份，历史靠 git。

## 10. 明确不在冻结范围

登录/授权流程（OAuth、扫码、`exchange`）、任何写操作、Health Connect / Health Sync /
Gadgetbridge、Home Assistant 集成文件（`config_flow.py`/`coordinator.py`/`sensor.py`/`entity.py`）、
睡眠阶段解析（在 `design/health` 的 S0–S2 里做，不在 sidecar 里做）。
