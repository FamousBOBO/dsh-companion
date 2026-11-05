# huawei-health-cn · 冻结的 CN 读取 sidecar

> **一句话**：这是「华为运动健康 CN 云」在本项目里**唯一**的读入口。它是一份**冻结的** Python
> 复制件 + 一个只监听 `127.0.0.1:8765` 的只读 HTTP 服务；上层（`plugins/companion-health`）
> 只认 `GET /api/data` 这一个端点，字段口径写在 [PROTOCOL-FREEZE.md](PROTOCOL-FREEZE.md)。
>
> 冻结日期 **2026-11-03**，上游 `and7ey/huawei_health` 分支 `cn-hosts-default` 提交
> `1ec3e41`（集成本身 `manifest.json` 版本 `1.1.0`）。

---

## 1. 它是什么 / 不是什么

**是**

- 一份**逐字节复制**的上游读取实现（`python/client.py`、`python/const.py`、
  `python/huawei_dashboard.py`）+ 一份**带两处文档化改动**的 `python/huawei_login.py`；
- 一个**只读**本地面板 `/api/data`，把「活动 / 心率 / 压力 / 血氧 / 中高强度 / 训练 / 设备 / 实时样本」
  一次拉成一份 JSON；
- 一份**脱敏快照**（`snapshots/`）+ 一个**离线协议契约测试**（`test_protocol_contract.py`），
  让「字段没变、凭证没漏」这两件事可以被反复机械验证。

**不是**

- 不是 Health Connect / Health Sync / Gadgetbridge 的替代或补充（本轮明令不实现）；
- 不写、不改、不上传任何云端数据；没有写接口，OAuth 只在人工重新登录时用；
- 不做「实时蓝牙读数」——`realtime` 是云端**最新一条已上传**样本（见 §4.6）；
- 不是 Home Assistant 集成：`config_flow.py` / `coordinator.py` / `sensor.py` 这些需要 HA 的文件
  **没有**被复制进来，也不需要。

## 2. 目录

```
sidecars/huawei-health-cn/
  README.md                      ← 本文件：这是什么、怎么起停、边界在哪
  PROTOCOL-FREEZE.md             ← 冻结的读取协议（端点/字段/时间单位/已知缺失/版本点）
  RUNBOOK.md                     ← 起停、故障、限流、令牌到期、回滚、11/04 探针步骤
  redact.py                      ← 脱敏规则（独立模块，可单测，不联网）
  capture_snapshot.py            ← 拉一次 /api/data 并落脱敏快照
  test_protocol_contract.py      ← 离线协议契约测试（对着 snapshots/，不联网）
  verify_frozen_copy.py          ← 证明 python/ 里的复制件确实等于 tmp/ 原件
  sleep-first-night-probe.py     ← 11/04 首夜睡眠验收探针（低频、只读、一次）
  start-sidecar.ps1 / stop-sidecar.ps1
  python/
    client.py                    ← 上游原件复制（+5 行来源注释）
    const.py                     ← 上游原件复制（+5 行来源注释）
    huawei_dashboard.py          ← 上游原件复制（+5 行来源注释）
    huawei_login.py              ← 上游复制 + 两处适配（A1 路径解析 / A2 uid 打码）
  snapshots/
    cn-snapshot-20261103-2100.json   ← 真实数据、已脱敏（16 KB）
  logs/                          ← 运行时输出（已被仓库 .gitignore 覆盖；里面不许有 token）
```

`tmp/` 下的原件**一个字节都没动**，它们是冻结证据；`verify_frozen_copy.py` 就是拿它们做对照。

## 3. 起停

```powershell
# 起（只监听 127.0.0.1:8765；先查端口占用；日志进 logs/；起完扫一遍日志查 token）
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1

# 起完顺带打开面板（可选）
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1 -OpenDashboard

# 停（只杀自己起的那个 PID 记录；先验证命令行确实是 huawei_dashboard.py）
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1

# 只看要杀谁，不动手
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1 -DryRun
```

脚本的硬约束（不是约定，是代码里写死的）：

| 约束 | 实现 |
| --- | --- |
| 只听 loopback | 地址硬编码 `127.0.0.1`，**没有**任何参数能改宽 |
| 端口被占不抢占 | 占用者不是 PID 文件里记的那个就**报错退出**，不动别人的进程 |
| 只杀自己的进程 | PID 文件 + 命令行校验（必须是 `python` 且命令行含 `huawei_dashboard.py`） |
| 日志不许有 token | 起完立刻扫 `logs/*.log`，命中就**停掉进程**并报错 |
| 不碰凭证 | `start-sidecar.ps1` 从不读 `tmp/huawei_account.json`，只打印它的路径 |

> ⚠️ `tmp/hwvenv/Scripts/python.exe` 会**再 exec 一次自己**，所以一个 sidecar 是**两个进程**
> （launcher → 真正监听的解释器）。PID 文件两个 PID 都记，停的时候按树杀。用普通
> `Start-Process` 起会让子进程继承调用者的 stdout 管道，任何管道式/自动化调用都会永久挂住——
> 所以脚本用 WMI `Win32_Process.Create` 分离启动。

## 4. 隐私与脱敏（本目录最要紧的一条）

- `tmp/huawei_account.json` 是**敏感文件**：只被 sidecar 进程（或人工重新登录脚本）在原地读取，
  **从不复制**进 `sidecars/`，**从不**打日志，**从不**进快照。
- 快照里 `token{}` 只保留白名单键（`session_host` / `data_host` / `expires_at_text` /
  `expires_in_min` / `refresh_dies_text` / `rotated` / `uid_sha256_16`）；`uid` 原值被
  `sha256(raw)[:16]` 替换。
- `devices[]` 的 `uniqueId` / `devId` / `udid` / `sn` / `mac` 全部换成 `sha256(raw)[:16]`；
  `deviceData` 这类不透明 blob 换成 `{bytes, sha256_16, dropped:true}`。
- **健康数据本体一律保留**：`sources[].rt_text`、`realtime` 数值、`daily`、`health`、`sessions`、
  `sleep_rows` 都是这份快照存在的理由，脱敏不许吃掉它们。

隐私回归检查（**必须无输出**；这条也写进了契约测试与 RUNBOOK）：

```powershell
Select-String -Path sidecars\huawei-health-cn\snapshots\*.json `
              -Pattern '(?i)(accesstoken|refreshtoken|x-huid|"uid"\s*:\s*"\d{6,})'
```

退一步的全量 grep（只应命中**键名**，命中不到值）：

```powershell
Select-String -Path sidecars\huawei-health-cn\snapshots\*.json -Pattern '(?i)token|uid|uniqueid|devid'
```

## 5. 快照与测试

```powershell
# 1) 采一份新快照（一次 HTTP GET；文件名带时间戳，也可 --out 指定）
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\capture_snapshot.py
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\capture_snapshot.py `
    --out sidecars\huawei-health-cn\snapshots\cn-snapshot-20261103-2100.json

# 2) 协议契约测试（离线，对着 snapshots/ 里最新那份；也可 HUAWEI_SNAPSHOT=… 指定）
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\test_protocol_contract.py -v

# 3) 复制件与 tmp/ 原件是否仍然一致
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\verify_frozen_copy.py
```

- 契约测试只用标准库 `unittest`，任何 Python 3.9+ 都能跑。
  实测：**不要**在这个 venv 里用 `pytest` 跑它 —— `tmp/hwvenv` 装了
  `pytest-homeassistant-custom-component`，Windows 上它一 import 就 `ModuleNotFoundError: fcntl`
  （上游报告里那个 `-p tests.posix_shims` 就是为这个准备的，而 shim 在 `tmp/huawei_health/tests/`，
  不属于本冻结件）。所以这里刻意只依赖 `unittest`。
- 测试**不联网、不读凭证、不需要 sidecar 在跑**：它断言的是已落盘的快照 + 复制件的纯函数
  （`health_series()` 的 0/-1 语义就是这么验的）。
- 当前规模：**43 个测试**，全绿。覆盖：顶层字段集合、`token` 白名单、`daily` 必备字段、
  `sessions` 保留原始 `sport_type` 整数、`sleep_rows` 允许空数组、`health` 0/-1 语义、
  设备标识假名化、`_capture` 元数据块、序列化可复现、脱敏规则的正反用例（含"注入 token 必须被拒"）。

## 6. 快照长什么样（2026-11-03 21:15 实测）

`sidecars/huawei-health-cn/snapshots/cn-snapshot-20261103-2100.json`，16 257 字节，
`_capture.counts = {daily:7, health:2, sessions:2, devices:9, sleep_rows:0, sources:7, errors:0}`，
7 次云调用；本次 3 558.7 ms（21:04 那次 1 515.2 ms，网络抖动属正常范围）。
两次采集的 `daily` / `health` / `sessions` / `devices` 数值完全一致 —— 这就是"可复现"的证据。

`_capture` 元数据块（冻结要求）：

```json
"_capture": {
  "capturedAt": "2026-11-03T21:15:38+08:00",
  "source": "http://127.0.0.1:8765/api/data?days=7",
  "redacted": true,
  "keys": ["…顶层字段清单…"],
  "counts": {"daily": 7, "health": 2, "sleep_rows": 0, "sessions": 2,
             "devices": 9, "sources": 7, "errors": 0},
  "scopeDays": 7, "syncedAt": "…", "cloudCalls": 7, "errors": 0,
  "latencyMs": 3558.7, "redactionRules": ["…token 白名单…"],
  "tool": "…/capture_snapshot.py"
}
```

> 文件名里的 `2100` 是验收命令指定的固定名；**权威时间是文件内的 `_capture.capturedAt`**。

> 注入过的坑：早期版本把**隐私 grep 的正则本身**写进了 `_capture`，于是快照自己命中自己的
> 回归检查（`accesstoken` / `x-huid` 作为字符串出现在文件里）。现在那个字段**不再落盘**，
> 正则只存在于 `redact.py` 与本文档；契约测试里有一条专门守着这件事。

## 7. 与上层的边界

| 谁 | 拿什么 | 约定 |
| --- | --- | --- |
| `plugins/companion-health/lib/cn-adapter.mjs` | `GET /api/data?days=7` | 只认 loopback；20 s 超时；**不打印 payload**；只往下送脱敏后的 token 状态 |
| `plugins/companion-health/lib/normalize.mjs` | 上面那份 payload | 字段名要映射（`distance_m`→`distanceM` 等），映射表见 PROTOCOL-FREEZE §7 |
| Studio / foundation 工具 | 数据库，不碰 sidecar | 任何 GET 路由与工具都**不许**自己发起网络请求 |
| 本目录 | 只被上面第一行调用 | 不 import 上层任何代码 |

## 8. 已知缺口（都在 PROTOCOL-FREEZE §5 展开）

1. **睡眠族整个缺失**：本账号云端没有 `professionalSleepTotal`，`sleep_rows` 恒为 `[]`。
   这不是 bug，是账号现状；11/04 用 `sleep-first-night-probe.py` 验首夜。
2. **`sport_type: 2` 上游映射成 `hill`**：保留原始整数，标签只是展示，不当事实。
3. **`realtime` / `sources` 的键是中文**（`心率`/`压力`/`血氧`），上层适配器不要按这些键取值。
4. `active_hours` / `exercise_min` 可能为 `null`（云端没给），不是 0。
