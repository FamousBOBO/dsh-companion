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
  RUNBOOK.md                     ← 起停、故障、限流、令牌到期、回滚、首夜探针步骤
  requirements.txt               ← 明确写「没有第三方依赖」（标准库 only）
  sidecar_paths.py               ← 运行时路径解析（data/logs/snapshots/credentials，全部可覆盖）
  redact.py                      ← 脱敏规则（独立模块，可单测，不联网）
  capture_snapshot.py            ← 拉一次 /api/data 并落脱敏快照
  test_protocol_contract.py      ← 离线协议契约测试（对着 <data>/snapshots/，不联网）
  test_redact.py                 ← 脱敏规则的离线单测（15 条，不需要快照）
  verify_frozen_copy.py          ← 证明 python/ 里的复制件与上游一致（需自备上游 checkout）
  sleep-first-night-probe.py     ← 首夜睡眠验收探针（低频、只读、一次）
  start-sidecar.ps1 / stop-sidecar.ps1     ← Windows
  start-sidecar.sh  / stop-sidecar.sh      ← Linux / macOS（无 PowerShell、无 WMI）
  python/
    README.md                    ← 这里放**你自己的**上游实现（本仓库不提供，见 PROTOCOL-FREEZE §1.1）
```

**运行时文件都不在仓库里**（`.gitignore` 覆盖）：`snapshots/`、`logs/`、PID 文件、令牌文件
一律落在套件数据目录：

| 内容 | 默认位置 | 覆盖 |
| --- | --- | --- |
| 日志 + PID 文件 | `<dataRoot>/logs/huawei-health-cn/` | `$HUAWEI_LOG_DIR` / `--log-dir` / `-LogDir` |
| 脱敏快照 | `<dataRoot>/snapshots/huawei-health-cn/` | `$HUAWEI_SNAPSHOT_DIR` |
| 令牌对（密码级） | `<dataRoot>/credentials/huawei_account.json` | `$HUAWEI_ACCOUNT_JSON` |

`<dataRoot>` = 套件配置的 `dataDir` → `$DSH_COMPANION_DATA_DIR` → `<套件根>/data`。

上游集成的研究性 checkout **不属于本仓库**：`verify_frozen_copy.py` 在没有
`HUAWEI_UPSTREAM_PKG` 时会明确说「原件不在」并以 **3** 退出 —— 那表示"没有可对照的原件"，
不是复制件坏了。

## 2.5 先决条件：自备上游实现（本仓库不包含）

上游集成（华为健康读取客户端）的许可证无法确认，所以**本仓库不分发它**，也不分发任何服务端实现
（理由与上游仓库/提交见 [PROTOCOL-FREEZE.md](PROTOCOL-FREEZE.md) §1.1）。启用华为通道前，你需要：

```bash
export HUAWEI_UPSTREAM_PKG=/path/to/huawei_health/custom_components/huawei_health   # 含 client.py / const.py
export HUAWEI_SERVE_SCRIPT=/path/to/your_serve.py    # 实现 GET /api/data?days=N；或放到 python/serve.py
```

没有这两样时：启动器 **exit 3** 并说明两条自备途径；`plugins/companion-health` 的华为通道显示
**未配置 → 不可用**（不会显示"正常"）。**BLE 心率通道不受影响**，它自带实现、可独立离线验收。

## 3. 起停（跨平台）

**Windows**（PowerShell；WMI 分离启动 + `taskkill` 收尾，这是唯一用 WMI 的路径）：

```powershell
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1 -OpenDashboard
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1 -PythonPath C:\Python312\python.exe
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1 -DryRun
```

**Linux / macOS**（POSIX sh；不含任何 PowerShell / WMI 分支）：

```bash
./sidecars/huawei-health-cn/start-sidecar.sh              # PYTHON=python3.12 可指定解释器
./sidecars/huawei-health-cn/start-sidecar.sh --port 8766 --log-dir /tmp/hw-logs
./sidecars/huawei-health-cn/stop-sidecar.sh
./sidecars/huawei-health-cn/stop-sidecar.sh --dry-run
```

解释器查找顺序（两个脚本一致）：`--python`/`-PythonPath` → `$PYTHON` / `$HUAWEI_PYTHON` →
`<sidecar>/.venv` → `<dataRoot>/venv` → PATH。**本 sidecar 是标准库 only，不需要 pip install**。

**没有登录过账号时**：脚本会先说「账号未配置」（令牌文件不存在），sidecar 仍会启动但读不到数据
接口回落成空结果 —— 这不是崩溃，也不是"连上了"。先跑一次登录：

```bash
python sidecars/huawei-health-cn/python/huawei_login.py url        # 打开同意页
python sidecars/huawei-health-cn/python/huawei_login.py exchange "<粘贴 hms://…>"
```

脚本的硬约束（不是约定，是代码里写死的）：

| 约束 | 实现 |
| --- | --- |
| 只听 loopback | 地址硬编码 `127.0.0.1`，**没有**任何参数能改宽 |
| 端口被占不抢占 | 占用者不是 PID 文件里记的那个就**报错退出**，不动别人的进程 |
| 只杀自己的进程 | PID 文件 + 命令行校验（必须是 `python` 且命令行含 `huawei_dashboard.py`） |
| 日志不许有 token | 起完立刻扫 `logs/*.log`，命中就**停掉进程**并报错 |
| 不碰凭证 | 两个启动脚本都**从不读**令牌文件（`<dataRoot>/credentials/huawei_account.json`），只打印它的路径 |

> ⚠️ 某些 Python 发行版（嵌入式 / uv 管理的）会**再 exec 一次自己**，所以一个 sidecar 可能是**两个进程**
> （launcher → 真正监听的解释器）。PID 文件两个 PID 都记，停的时候按树杀。用普通
> `Start-Process` 起会让子进程继承调用者的 stdout 管道，任何管道式/自动化调用都会永久挂住——
> 所以脚本用 WMI `Win32_Process.Create` 分离启动。

## 4. 隐私与脱敏（本目录最要紧的一条）

- 令牌文件（`<dataRoot>/credentials/huawei_account.json`，`$HUAWEI_ACCOUNT_JSON` 可改）是**敏感文件**：只被 sidecar 进程（或人工重新登录脚本）在原地读取，
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

```bash
# 1) 采一份新快照（一次 HTTP GET；默认落到 <dataRoot>/snapshots/huawei-health-cn/，也可 --out 指定）
python sidecars/huawei-health-cn/capture_snapshot.py
python sidecars/huawei-health-cn/capture_snapshot.py --out <dataRoot>/snapshots/huawei-health-cn/cn-snapshot-20261103-2100.json

# 2) 脱敏规则的离线单测（15 条，不需要快照）
python sidecars/huawei-health-cn/test_redact.py -v

# 3) 协议契约测试（离线；对着 <dataRoot>/snapshots/… 里最新那份，也可 HUAWEI_SNAPSHOT=… 指定）
python sidecars/huawei-health-cn/test_protocol_contract.py -v

# 4) 复制件与上游是否仍然一致（需要 HUAWEI_UPSTREAM_PKG 指向一个上游 checkout）
python sidecars/huawei-health-cn/verify_frozen_copy.py
```

- 契约测试与脱敏单测都只用标准库 `unittest`，任何 Python 3.11+ 都能跑。
  这也是刻意只依赖 `unittest` 的原因：上游那套 pytest 环境会拉进
  `pytest-homeassistant-custom-component`（它在非 POSIX 平台上 import `fcntl` 直接失败），
  而发布树里**没有**任何第三方依赖 —— `requirements.txt` 就写着「没有依赖」。
- 测试**不联网、不读凭证、不需要 sidecar 在跑**：它断言的是已落盘的快照 + 复制件的纯函数
  （`health_series()` 的 0/-1 语义就是这么验的）。
- 当前规模：`test_redact.py` **15 条**（不需要快照，始终运行）+ `test_protocol_contract.py` **13 条**（其中 9 条依赖快照，没有快照时 skip）。覆盖：顶层字段集合、`token` 白名单、`daily` 必备字段、
  `sessions` 保留原始 `sport_type` 整数、`sleep_rows` 允许空数组、`health` 0/-1 语义、
  设备标识假名化、`_capture` 元数据块、序列化可复现、脱敏规则的正反用例（含"注入 token 必须被拒"）。

## 6. 快照长什么样（2026-11-03 21:15 实测）

当时那份快照（`cn-snapshot-20261103-2100.json`，16 257 字节，**个人数据，不随包发布**，位置在 `<dataRoot>/snapshots/huawei-health-cn/`），
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
