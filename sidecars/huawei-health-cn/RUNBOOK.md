# RUNBOOK · huawei-health-cn sidecar

> 面向：值班的人（或明天的我）。目标是一眼判断「现在能不能读数据、该做什么、别做什么」。
> 协议细节看 [PROTOCOL-FREEZE.md](PROTOCOL-FREEZE.md)；目录与边界看 [README.md](README.md)。
>
> **三条铁律**：① 只连 `127.0.0.1:8765`；② 永远不打印/复制/提交令牌文件
> （`<dataRoot>/credentials/huawei_account.json`）；③ 不扫云端接口、不扫 type 1–32、不重跑 OAuth
> （会吃 `1101` / `20020001`）。
>
> 命令同时给两个平台。`<套件根>` 是仓库根目录，`<dataRoot>` = 套件配置 `dataDir` →
> `$DSH_COMPANION_DATA_DIR` → `<套件根>/data`。`$PY` 指你自己的 Python 3.11+（本 sidecar 零依赖）。

---

## 0. 30 秒体检

```bash
# 端口在听吗（只看 TCP，不花云调用）
#   Linux/macOS:
python3 -c "import socket;s=socket.socket();s.settimeout(0.5);print('listening' if s.connect_ex(('127.0.0.1',8765))==0 else 'free')"
#   Windows:
Get-NetTCPConnection -LocalPort 8765 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess

# 进程是谁、命令行对不对
#   Linux/macOS:      ps aux | grep huawei_dashboard
#   Windows:          Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
#                       Where-Object { $_.CommandLine -match 'huawei_dashboard' } |
#                       Select-Object ProcessId,ParentProcessId,CommandLine

# 日志里有没有不该有的东西（必须无输出）
grep -E 'DgE|accessToken|refreshToken|x-huid' <dataRoot>/logs/huawei-health-cn/*.log

# 离线自检（不花云调用）——最快的「一切正常」证明
$PY sidecars/huawei-health-cn/test_redact.py            # 15 条，不需要快照
$PY sidecars/huawei-health-cn/test_protocol_contract.py # 有快照才跑快照用例，没有就 skip
```

真要看数据：`curl -s "http://127.0.0.1:8765/api/data?days=7"`（**一次就够**，15 s 内有缓存）。

## 1. 起

```bash
# Linux / macOS（无 PowerShell、无 WMI）
sidecars/huawei-health-cn/start-sidecar.sh
sidecars/huawei-health-cn/start-sidecar.sh --port 8766          # 临时换端口（排查用）
PYTHON=/usr/bin/python3.12 sidecars/huawei-health-cn/start-sidecar.sh

# Windows
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1 -Port 8766 -OpenDashboard
```

正常输出（`exit 0`）：

```
  python      : /usr/bin/python3.12 (3.12)
  bind        : 127.0.0.1:8765 (loopback only)
  credential  : <dataRoot>/credentials/huawei_account.json — read by the sidecar process, never by this script
  logs        : <dataRoot>/logs/huawei-health-cn
  launched    : pid NNNN (detached)
  pid file    : <dataRoot>/logs/huawei-health-cn/sidecar.pid (pid NNNN)
  log hygiene : clean (no token material in stdout/stderr)
sidecar is up: http://127.0.0.1:8765/
```

**没有登录过账号**时，脚本会先说「账号未配置」：进程照起，但接口拿不到数据。这不是错误状态，
是「未配置」——先走 §5 登录一次。

脚本会**先**检查端口：占用者不是 PID 文件里记的那个 → 直接报错退出（`exit 2`），不动别人的进程。
起完会立刻扫日志，命中 token 就**停掉自己**并报错——这是设计，不是 bug。

## 2. 停

```bash
# Linux / macOS
sidecars/huawei-health-cn/stop-sidecar.sh --dry-run   # 先看要杀谁
sidecars/huawei-health-cn/stop-sidecar.sh

# Windows
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1 -DryRun
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1
```

- 有 PID 文件：校验「端口上的监听者命令行含 `huawei_dashboard.py`」才动手（Windows 用
  `taskkill /T /F` 杀树；POSIX 先 `TERM` 再 `KILL`）。
- 没有 PID 文件：**只报告**谁占着端口，不杀（`exit 2`）。
- PID 被系统回收给别的进程：命令行对不上 → 拒绝杀，提示人工处理。
- **一个 sidecar 可能是两个进程**（某些 Python 发行版会 re-exec 自己）：PID 文件两个 PID 都记。

## 3. 故障处置表

| 现象 | 先做什么 | 别做什么 |
| --- | --- | --- |
| `start` 报「port 8765 is held by … and it is NOT recorded」 | 查清那个进程是谁（`ps aux` / `Get-CimInstance Win32_Process`）；确认是上次遗留的 sidecar 再手工停 | 别直接删 PID 文件当没事 |
| `start` 报「did not start listening within 30s」 | 看 `<dataRoot>/logs/huawei-health-cn/sidecar.err.log` 尾部（脚本已带回 20 行）；最常见是令牌文件不存在（未配置） | 别反复重试；先读错误 |
| `start` 报「token material found in the logs」 | **停手**：删 `<dataRoot>/logs/huawei-health-cn/*.log`，查是谁把 payload 打进了 stdout/stderr | 别把日志贴进聊天/工单 |
| HTTP 无响应 / 连接被拒 | 端口在听吗？进程活着吗？→ 按 §0 | 别为了"试试"连打十次 `/api/data` |
| `/api/data` 返回 `errors[]` 非空 | 读 `errors[]` 文本 + `calls[].code`：某分区失败不影响其它分区 | 别把 errors 原样塞给模型/前端 |
| 返回里 `sleep_rows: []` | **正常**（本账号云端没有睡眠族）。看 §6 | 别改代码"修"它，别伪造睡眠 |
| `token.expires_in_min` 变成负数或很小 | 正常轮转窗口；下一次真实调用会自动 refresh | 别手动连打 `/refresh` |
| 云端 `1101 Too Many Requests` | 立刻停手，等 ≥ 10 分钟；只允许 15 s 缓存后的单次拉取 | **禁止**重试风暴、禁止扫 type 1–32 |
| `1002` / `1004` | 手机 App 抢了轮转；sidecar 会自动刷新重试一次，通常自愈 | 别重复并发调用 |
| `20020003` / `2002xxxx`（refresh 失效 / code 无效） | 需要人工重新登录，见 §5 | 别拿旧 code 反复 exchange |
| `30005 Invalid device` | 该 `deviceCode` 不属于此账号；置 0 或重新 `bind_devices()` | 别乱传 device_code |
| 契约测试红了 | 字段真变了：先看哪条断言、再看最新快照；按 PROTOCOL-FREEZE §9 重新冻结 | 别改断言让它变绿 |

## 4. 限流纪律（本账号实测，别越线）

| 操作 | 云调用 | 耗时 |
| --- | --- | --- |
| `/api/data?days=7`（冷） | 7 | ~1.4–1.5 s |
| `/api/data?days=7`（15 s 内） | 0 | 1–12 ms |
| `/api/data?days=30` | 9 | 1.2–2.8 s |
| 突发 ~40 次调用 | — | → `1101` |

规则：**≥15 s 一次**；同一时刻不要并发两份；调试先看快照/`--dry-run`，不要反复打真接口。
一次快照采集（`capture_snapshot.py`）就是一次完整拉取，采集完不要再连着再来一次。

## 5. 令牌到期 / 重新登录（唯一需要人手动的一步）

- 现状：access token ~50 分钟一轮、refresh token 180 天（从**登录那天**算）。
- sidecar 自己在进程内读取令牌文件并在轮转时原地写回；**脚本不读它**，只打印它的路径。
- access 到期：自动 refresh，无需干预（`token.rotated` 会短暂变 `true`）。
- `refresh_dies_text` 到期 / 收到 `20020003`：

```bash
# 1) 生成同意链接（会尝试开浏览器）
$PY sidecars/huawei-health-cn/python/huawei_login.py url
# 2) 浏览器里登录（切移动模式 Ctrl+Shift+J / Ctrl+Shift+M），复制 hms://redirect_url?code=… 整段
$PY sidecars/huawei-health-cn/python/huawei_login.py exchange "hms://redirect_url?code=…"
# 3) 读一次验证（这一步会花掉 7 次云调用，别重复）
$PY sidecars/huawei-health-cn/python/huawei_login.py probe
```

- 令牌文件默认在 `<dataRoot>/credentials/huawei_account.json`（`$HUAWEI_ACCOUNT_JSON` 可改）。
  它**不在仓库里**，也不需要进仓库：把它当密码。
- 控制台只显示打码后的 uid（适配 A2）——**不会**把 token 打到屏幕上。
- 登录成功后**重启 sidecar**，让它拿新的对（`stop` → `start`）。

## 6. 首夜睡眠验收（S0–S2 的第一步）

**前置**：手表在手机 App 里完成一次同步（App → 设备 → 同步），否则云端仍然没有睡眠族。

```bash
# 0) 不联网的自检（先跑这个，确认脚本与冻结复制件都在位）
$PY sidecars/huawei-health-cn/sleep-first-night-probe.py --dry-run

# 1) 真跑一次（1 次 HTTP + 1 次云调用，别跑第二遍）
$PY sidecars/huawei-health-cn/sleep-first-night-probe.py \
    --out <dataRoot>/logs/huawei-health-cn/sleep-first-night-probe.json
```

输出 `verdict` 的四种取值：

| verdict | 含义 | 下一步 |
| --- | --- | --- |
| `sleep_present` | 首夜已到云（`professionalSleepTotal` 出现，或 `sleep_rows` / `sleep_*` 出现） | 可以开始 S0–S2 的阶段与时长验收；**同时**重新采一份快照留证 |
| `awaiting_first_night` | 云端仍无睡眠（`resultCode 0`、族不存在） | 保持 `awaiting_first_night`，这不是故障；让手表再同步一次，明天再跑 |
| `blocked_auth` | 令牌要重新登录 | 走 §5 |
| `probe_incomplete` | 至少一路失败 | 先看 `steps.*.error`；不要重跑，等下一窗口 |

产物结构（已脱敏）：`steps.apiData`（sleep_rows/counts/errors）、
`steps.professionalSleep`（`resultCode` / `topKeys` / `familyPresent` / `recordCount` /
每条记录的 `recordDay`、`fieldNames`、`fields{value,unit,iso}`）、`verdict`、`notes`。
`fields` 的单位按 PROTOCOL-FREEZE §6.4：睡眠时长=分钟，`fallAsleepTime`/`wakeupTime`=毫秒时间戳（另给 `iso`）。

## 7. 回滚

| 想回滚什么 | 怎么做 |
| --- | --- |
| 只是不想让它跑 | `stop-sidecar.sh` / `stop-sidecar.ps1`；确认 8765 无监听即可。上层 `cn-adapter` 会拿 `unreachable` |
| 快照采错了 | 删掉 `<dataRoot>/snapshots/huawei-health-cn/` 里那份再采一份（**换新文件名**） |
| 怀疑复制件被动过 | `verify_frozen_copy.py`（需要 `HUAWEI_UPSTREAM_PKG` 指向上游 checkout）；退出码 3 = 没有可对照的原件，不等于坏了 |
| 协议要退回旧版 | 按 PROTOCOL-FREEZE §9 换回对应上游提交，重新采快照 + 跑契约测试；**不要**在冻结件里"就地改代码" |
| 上游 checkout 被动了 | 那是另一件事：那是 git clone，按上游提交恢复。**发布树里的 `python/` 才是 sidecar 用的那份** |

## 8. 日志与证据

- 日志：`<dataRoot>/logs/huawei-health-cn/sidecar.out.log`、`sidecar.err.log`（在 `data/` 下，
  `.gitignore` 覆盖）。**日志里不许有 token**：启动脚本起完会检查，命中就停进程。
- 快照：`<dataRoot>/snapshots/huawei-health-cn/cn-snapshot-*.json`。**个人数据，不入库**；
  需要留证就单独归档。
- 隐私回归（**必须无输出**）：

  ```bash
  grep -Ei '(accesstoken|refreshtoken|x-huid|"uid"[[:space:]]*:[[:space:]]*"[0-9]{6,})' \
       <dataRoot>/snapshots/huawei-health-cn/*.json
  ```

- 验收一轮的最小证据集：`test_redact.py` + `test_protocol_contract.py` 的输出 + 上面那条 grep 的
  无输出 + 最新快照的 `_capture.counts`。

## 9. 快速命令索引

```bash
# 起 / 停 / 体检（Linux/macOS；Windows 换 .ps1，参数名见 §1）
sidecars/huawei-health-cn/start-sidecar.sh
sidecars/huawei-health-cn/stop-sidecar.sh --dry-run
sidecars/huawei-health-cn/stop-sidecar.sh

# 采快照 / 契约测试 / 脱敏单测 / 首夜探针
$PY sidecars/huawei-health-cn/capture_snapshot.py --out <dataRoot>/snapshots/huawei-health-cn/cn-snapshot-YYYYMMDD-HHMM.json
$PY sidecars/huawei-health-cn/test_protocol_contract.py -v
$PY sidecars/huawei-health-cn/test_redact.py -v
$PY sidecars/huawei-health-cn/sleep-first-night-probe.py --dry-run
```
