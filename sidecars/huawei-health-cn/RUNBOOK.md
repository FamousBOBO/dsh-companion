# RUNBOOK · huawei-health-cn sidecar

> 面向：值班的人（或明天的我）。目标是一眼判断「现在能不能读数据、该做什么、别做什么」。
> 协议细节看 [PROTOCOL-FREEZE.md](PROTOCOL-FREEZE.md)；目录与边界看 [README.md](README.md)。
>
> **三条铁律**：① 只连 `127.0.0.1:8765`；② 永远不打印/复制/提交 `tmp/huawei_account.json`；
> ③ 不扫云端接口、不扫 type 1–32、不重跑 OAuth（会吃 `1101` / `20020001`）。

---

## 0. 30 秒体检

```powershell
cd D:\Bot\dsh-companion

# 端口在听吗（只看 TCP，不花云调用）
Get-NetTCPConnection -LocalPort 8765 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess

# 进程是谁、命令行对不对
Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
  Where-Object { $_.CommandLine -match 'huawei_dashboard' } |
  Select-Object ProcessId,ParentProcessId,CommandLine

# 日志里有没有不该有的东西（必须无输出）
Select-String -Path sidecars\huawei-health-cn\logs\*.log -Pattern 'DgE|accessToken|refreshToken|x-huid'

# 协议契约测试（离线，不花云调用）——最快的「一切正常」证明
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\test_protocol_contract.py
```

真要看数据：`curl.exe -s "http://127.0.0.1:8765/api/data?days=7"`（**一次就够**，15 s 内有缓存）。

## 1. 起

```powershell
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1                 # 127.0.0.1:8765
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1 -Port 8766      # 临时换端口（排查用）
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1 -OpenDashboard  # 起完开面板
```

正常输出（`exit 0`）：

```
  python      : …\tmp\hwvenv\Scripts\python.exe (Python 3.13.11)
  bind        : 127.0.0.1:8765 (loopback only)
  launched    : wrapper pid NNNN (detached)
  pid file    : …\logs\sidecar.pid (wrapper NNNN → listener MMMM)
  log hygiene : clean (no token material in stdout/stderr)
sidecar is up: http://127.0.0.1:8765/
```

脚本会**先**检查端口：占用者不是 PID 文件里记的那个 → 直接报错退出，不动别人的进程。
起完会立刻扫日志，命中 token 就**停掉自己**并报错——这是设计，不是 bug。

## 2. 停

```powershell
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1 -DryRun   # 先看要杀谁
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1
```

- 有 PID 文件：校验「端口上的监听者命令行含 `huawei_dashboard.py`」才 `taskkill /T /F`（含子进程，
  因为 `hwvenv` 的 `python.exe` 会自己再 exec 一次）。
- 没有 PID 文件：**只报告**谁占着端口，不杀（`exit 2`）。
- PID 被系统回收给别的进程：命令行对不上 → 拒绝杀，提示人工处理。

## 3. 故障处置表

| 现象 | 先做什么 | 别做什么 |
| --- | --- | --- |
| `start` 报「port 8765 is held by PID … and it is NOT recorded」 | `Get-CimInstance Win32_Process -Filter "ProcessId=那个PID"` 看清是什么；若是上次遗留的 sidecar，按上面命令手工 `taskkill /PID … /T /F` | 别直接删 PID 文件当没事 |
| `start` 报「did not start listening within 30 s」 | 看 `logs/sidecar.err.log` 尾部（脚本已带回 20 行） | 别反复重试；先读错误 |
| `start` 报「token material found in the logs」 | **停手**：删 `logs\*.log`，查是谁把 payload 打进了 stdout/stderr（可能是有人临时加了 `print`） | 别把日志贴进聊天/工单 |
| HTTP 无响应 / 连接被拒 | 端口在听吗？进程活着吗？→ 按 §0 | 别为了"试试"连打十次 `/api/data` |
| `/api/data` 返回 `errors[]` 非空 | 读 `errors[]` 的文本 + `calls[].code`：某分区失败不影响其它分区 | 别把 errors 原样塞给模型/前端 |
| 返回里 `sleep_rows: []` | **正常**（本账号云端没有睡眠族）。看 §6 首夜探针 | 别改代码"修"它，别伪造睡眠 |
| `token.expires_in_min` 变成负数或很小 | 正常轮转窗口；下一次真实调用会自动 refresh | 别手动连打 `/refresh` |
| 云端 `1101 Too Many Requests` | 立刻停手，等 ≥ 10 分钟；只允许 15 s 缓存后的单次拉取 | **禁止**重试风暴、禁止扫 type 1–32 |
| `1002` / `1004` | 手机 App 抢了轮转；sidecar 会自动刷新重试一次，通常自愈 | 别重复并发调用 |
| `20020003` / `2002xxxx`（refresh 失效 / code 无效） | 需要人工重新登录，见 §5 | 别拿旧 code 反复 exchange |
| `30005 Invalid device` | 该 `deviceCode` 不属于此账号；置 0 或重新 `bind_devices()` | 别乱传 device_code |
| 契约测试红了 | 字段真变了：先看哪条断言、再看 `snapshots/` 里最新快照；按 PROTOCOL-FREEZE §9 重新冻结 | 别改断言让它变绿 |

## 4. 限流纪律（本账号实测，别越线）

| 操作 | 云调用 | 耗时 |
| --- | --- | --- |
| `/api/data?days=7`（冷） | 7 | ~1.4–1.5 s |
| `/api/data?days=7`（15 s 内） | 0 | 1–12 ms |
| `/api/data?days=30` | 9 | 1.2–2.8 s |
| 突发 ~40 次调用 | — | → `1101` |

规则：**≥15 s 一次**；同一时刻不要并发两份；调试先打 `-DryRun`/看快照，不要反复打真接口。
一次快照采集（`capture_snapshot.py`）就是一次完整拉取，采集完不要再连着再来一次。

## 5. 令牌到期 / 重新登录（唯一需要人手动的一步）

- 现状：access token ~50 分钟一轮、refresh token 180 天（从**登录那天**算）。
- sidecar 自己在进程内读取 `tmp/huawei_account.json` 并在轮转时原地写回；**脚本不读它**。
- access 到期：自动 refresh，无需干预（`token.rotated` 会短暂变 `true`）。
- `refresh_dies_text` 到期 / 收到 `20020003`：

```powershell
# 1) 生成同意链接（会尝试开浏览器）
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\python\huawei_login.py url
# 2) 浏览器里登录（切移动模式 Ctrl+Shift+M，点「允许」），复制 hms://redirect_url?code=… 整段
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\python\huawei_login.py exchange "hms://redirect_url?code=…"
# 3) 读一次验证（这一步会花掉 7 次云调用，别重复）
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\python\huawei_login.py probe
```

- 重新登录会**重写** `tmp/huawei_account.json`（或 `HUAWEI_ACCOUNT_JSON` 指向的位置）。
  控制台只显示打码后的 uid（适配 A2）——**不会**把 token 打到屏幕上。
- 登录成功后**重启 sidecar**，让它拿新的对（`stop` → `start`）。

## 6. 11/04 首夜睡眠验收（S0–S2 的第一步）

**前置**：手表在手机 App 里完成一次同步（App → 设备 → 同步），否则云端仍然没有睡眠族。

```powershell
cd D:\Bot\dsh-companion

# 0) 不联网的自检（先跑这个，确认脚本与冻结复制件都在位）
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\sleep-first-night-probe.py --dry-run

# 1) 真跑一次（1 次 HTTP + 1 次云调用，别跑第二遍）
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\sleep-first-night-probe.py `
    --out logs\health\sleep-first-night-20261104\probe.json
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
`fields` 的单位按 `tmp/HUAWEI_HEALTH_README.md` §6.4：睡眠时长=分钟，`fallAsleepTime`/`wakeupTime`=毫秒时间戳（另给 `iso`）。

## 7. 回滚

| 想回滚什么 | 怎么做 |
| --- | --- |
| 只是不想让它跑 | `stop-sidecar.ps1`；确认 8765 无监听即可。上层 `cn-adapter` 会拿 `unreachable` |
| 快照采错了 | `git checkout -- sidecars/huawei-health-cn/snapshots/` 或删掉再采一份（**换新文件名**） |
| 怀疑复制件被动过 | `verify_frozen_copy.py` → 非绿就从 `tmp/` 原件重新复制并按 PROTOCOL-FREEZE §9 补注释 |
| 协议要退回旧版 | 按 PROTOCOL-FREEZE §9 换回对应上游提交，重新采快照 + 跑契约测试；**不要**在冻结件里"就地改代码" |
| `tmp/` 原件被动了 | 那已经不叫回滚了：`tmp/huawei_health` 是 git clone，`git -C tmp/huawei_health status` 看差异，按上游提交恢复 |

**绝对不要**为了回滚去改 `tmp/` 下的原件——它们是冻结证据，sidecar 用的是复制件。

## 8. 日志与证据

- 日志：`sidecars/huawei-health-cn/logs/sidecar.out.log`、`sidecar.err.log`（仓库 `.gitignore` 已覆盖
  `logs/`）。**日志里不许有 token**：`start-sidecar.ps1` 起完会检查，命中就停进程。
- 快照：`sidecars/huawei-health-cn/snapshots/cn-snapshot-*.json`，**要提交**（这是验收证据）。
- 隐私回归（**必须无输出**）：

  ```powershell
  Select-String -Path sidecars\huawei-health-cn\snapshots\*.json `
                -Pattern '(?i)(accesstoken|refreshtoken|x-huid|"uid"\s*:\s*"\d{6,})'
  ```

- 验收一轮的最小证据集：`test_protocol_contract.py` 全绿输出 + `verify_frozen_copy.py` 全绿输出 +
  上面那条 grep 的无输出 + 最新快照的 `_capture.counts`。

## 9. 快速命令索引

```powershell
# 起 / 停 / 体检
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1 -DryRun
pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1

# 采快照 / 契约测试 / 复制件校验 / 首夜探针
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\capture_snapshot.py --out sidecars\huawei-health-cn\snapshots\cn-snapshot-YYYYMMDD-HHMM.json
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\test_protocol_contract.py -v
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\verify_frozen_copy.py
tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\sleep-first-night-probe.py --dry-run
```
