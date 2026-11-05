# BLE 心率广播接收端（Pulse Bond · P1 sidecar）

手表/胸带的 **心率广播**（Bluetooth HRS：service `0x180D`，characteristic `0x2A37`，可选
`0x2A38` 传感器位置）→ 本进程 → 回环 HTTP JSON → `companion-health` 的 pulse 适配层。

```
手表 --BLE HRS--> heart_rate.py (127.0.0.1:8151) --GET /api/state--> plugins/companion-health
```

- 契约（唯一来源）：`design/pulse-bond-20261103.md` §3。
- 本目录只做"把心跳读出来"这件事。档位 / 基线 / 趋势 / RMSSD / 会话，全部在 Node 侧算。
- 端口 **8151**。`8765` 是华为健康 sidecar，`8139` 是 GPU 网关，别串。

### 起停（跨平台）

| 平台 | 起 | 停 |
| --- | --- | --- |
| Windows | `pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1` | `pwsh -File sidecars\ble-heart-rate\stop-sidecar.ps1` |
| Linux / macOS | `sidecars/ble-heart-rate/start-sidecar.sh` | `sidecars/ble-heart-rate/stop-sidecar.sh` |

POSIX 脚本**不含任何 PowerShell / WMI 分支**（只用 POSIX sh + Python）。两个平台的脚本承诺一致：
只绑 `127.0.0.1`；端口被别人占用就退出（`exit 2`）绝不抢占；日志与 PID 文件写在
`<dataRoot>/logs/ble-heart-rate/`（`--log-dir` / `$BLE_HEART_RATE_LOG_DIR` 可改，**不写仓库**）；
起完扫一遍日志确认没有蓝牙地址明文。
`<dataRoot>` = 套件配置 `dataDir` → `$DSH_COMPANION_DATA_DIR` → `<套件根>/data`。

### 启动参数（`heart_rate.py` / `start-sidecar.ps1` / `start-sidecar.sh`）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` / `-Port` / `--port` | 8151 | 契约端口；被占用则**退出码 2**，绝不抢占 |
| `--fixture` / `-Fixture` / `--fixture [名称]` | 无 | 回放合成序列（不需要蓝牙硬件） |
| `--auto` / `-Auto` | **关** | 旧行为：启动就扫、自动连接、断线后台退避重连。默认是懒模式 |
| `--connect-timeout` | **12** | `POST /api/connect` 的总预算（扫描 + 连接 + 首帧） |
| `--scan-timeout` | 8 | 单次扫描窗口上限；按需连接命中即提前结束 |
| `--address` / `-Address` / `--address` | 无 | 设备地址或 `addressHash` 前缀（日志/响应里从不出现明文） |
| `--name-hint` / `-NameHint` / `--name-hint` | 无 | 设备名子串，如 `HR` / `Band` |
| `--allow-address-display` | 关 | 只在 `/api/devices` 里带 `address`，仅本地排障 |
| `--verbose` / `-Verbose2` | 关 | 把 HTTP 访问日志也写出来（默认关，1 Hz 轮询不刷屏） |
| `--selftest` | — | 只跑 `0x2A37` 解析 + 脱敏自检后退出 |

两个启动脚本另有：解释器参数（`-PythonPath` / `--python`）、监听等待（`-WaitSeconds` / `$WAIT_SECONDS`）、日志目录（`-LogDir` / `--log-dir`）；Windows 还有 `-OpenApi` 起完直接开浏览器。

### 默认是「懒」的（2026-11-04 起，主人要求）

进程起来**只监听 HTTP**：不扫描、不自动连接、不做后台重连循环。

| 行为 | 默认（lazy） | `--auto`（旧行为，保留给 fixture/自测） |
|---|---|---|
| 启动时扫描 | **不扫** | 立刻扫并连接 |
| 什么时候连 | 只有 `POST /api/connect` 才连（扫一轮 → 连 → 订阅 `0x2A37`） | 启动就自动连 |
| 断线（广播关/走远/没电） | `connected=false`、保留最后读数、`lastErrorCode=disconnected`、`quality` 降级，然后**停手等人再调 connect** | 后台 1→30 s 退避自动重连 |
| `/api/devices` | 只有 `?scan=1` 才真扫；不带就返回上次结果 | 同左（旧版本是无条件扫） |
| 扫描次数 | `/api/health` 的 `scanCount` 应一直是 0，直到有人请求 | 会随重连增长 |

一句话：**要用的时候才连，用完 `POST /api/disconnect` 放掉**（上层会话结束时会调），
这样手环可以停广播、省电，也不会在没人用的时候一直占着蓝牙。

---

## 1. 环境（跨平台；**只有真机模式需要装东西**）

| 模式 | 需要什么 |
| --- | --- |
| `--selftest`（解析器自检） | 任意 Python 3.11+，**零第三方依赖** |
| `--fixture`（回放合成序列） | 同上，零依赖（`bleak` 是惰性导入的，回放根本不触发） |
| 真机（读真手环） | Python 3.11+ **+ `bleak`**（`requirements.txt` 里只有这一行） |

安装依赖（推荐单独 venv，别污染系统 python）：

```bash
cd sidecars/ble-heart-rate
python -m venv .venv
. .venv/bin/activate                 # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
python heart_rate.py --selftest      # 13 项断言，全 PASS 才算环境没问题
```

启动脚本找解释器的顺序（两个平台一致；所以 **venv 放哪都行，别写死路径**）：

1. `--python` / `-PythonPath`
2. `$PYTHON` / `$env:BLE_HEART_RATE_PYTHON`
3. `<sidecar>/.venv`（上面那套）
4. `<dataRoot>/venv`
5. PATH 上的 `python3` / `python`

平台细节：`bleak` 在 Linux 走 BlueZ（需要 D-Bus + BlueZ ≥ 5.43）、macOS 走 CoreBluetooth、
Windows 走 WinRT —— Python 侧不用额外装系统包。

---

## 2. 没硬件也能验收（先看这个）

```bash
# 1) 解析器自检：不开端口、不联网、不需要蓝牙
python sidecars/ble-heart-rate/heart_rate.py --selftest

# 2) 用回放序列手工跑一遍（懒模式：起来后要 POST /api/connect 才开始出数）
sidecars/ble-heart-rate/start-sidecar.sh --fixture          # Windows: pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1 -Fixture
curl -s http://127.0.0.1:8151/api/state                      # connected=false，还没连（正常）
curl -s -X POST http://127.0.0.1:8151/api/connect
curl -s http://127.0.0.1:8151/api/state                      # 现在有 bpm 了
sidecars/ble-heart-rate/stop-sidecar.sh                      # Windows: stop-sidecar.ps1
```

`--fixture` 下 `/api/state` 的 `sampleAt` 跟着**真实时钟**前进，所以 `sampleAgeMs` 一直很小
（几十到几百毫秒）——上层"这是实时读数"的判断可以按真机一样验。回放默认是**待命**的
（`fixture replay armed but paused`）：不调 `/api/connect` 就不会有读数，这正是懒模式的形状。

> 发布树里**不带** `scripts/check-pulse.mjs`（那是开发期的压测脚手架）。离线验收用上面两条
> 命令就够：`--selftest` 覆盖帧解析与脱敏，`--fixture` 覆盖 HTTP + 懒模式协议。

`--fixture` 下 `/api/state` 的 `sampleAt` 跟着**真实时钟**前进，所以 `sampleAgeMs` 一直很小
（几十到几百毫秒）——上层"这是实时读数"的判断可以按真机一样验。回放默认是**待命**的
（`fixture replay armed but paused`）：不调 `/api/connect` 就不会有读数，这正是懒模式的形状。

可用合成序列（`fixtures/`）：

| 文件 | 内容 | 用途 |
|---|---|---|
| `synthetic-ramp.json` | 39 条，88→176→88 bpm，覆盖 calm/warming/racing/peak 四档 | 默认；档位、峰值、回落 |
| `calm-steady.json` | 10 条，86–90 bpm，500ms 一帧 | 冒烟、`--once`、单测 |
| `no-contact.json` | `contact:"no"` 全程 | 验 `quality:"no-contact"` 那一支 |

---

## 3. 开手表的心率广播

### 3.0 第 0 步：**先在设备上打开「心率广播」，再去扫**

这是整条链路上唯一真正的"教训"（2026-11-03 我们踩过一次）：

> **扫不到 ≠ 不支持。** 广播没打开时，扫描当然看不到它 —— 我们曾据此误判"华为手环 8 不广播
> 标准 HRS"，而主人一打开开关，`--scan` 立刻就扫到 `HUAWEI Band HR-002`（rssi −68、
> 带 `0x180D`），`/api/state` 直接 `connected=true bpm=96`。

所以顺序永远是：

1. **在手表/手环上打开「心率广播」**（各品牌路径见 §3.1/§3.2/§3.3；找不到就在 App 里翻"广播"二字）。
2. **再扫**：`node scripts/check-pulse.mjs  # 开发期脚手架，未随包发布  # 开发期脚手架，未随包发布 --scan`（sidecar 只认广播里的 service UUID `0x180D`；
   厂商 App 里"能看心率"**不等于**它在广播）。
3. 只在扫到 `hasHrs:true` 之后再谈配对、`-NameHint`、`-Address`。

> 📌 **2026-11-04 起不用再"先手动连一下"了**：sidecar 默认是懒的，**上层调用工具时会自己
> `POST /api/connect`**（扫一轮 → 连 → 订阅），不需要人先去点扫描、也不需要重启它。
> 但 **sidecar 进程本身还是得有人跑**（`start-sidecar.ps1` 或随桌面启动），它只是不再自己扫了。
> 主人关掉手环广播后，注入行会自动消失；下次要用时再调工具就会重新连上。

看 `--scan` 的三行输出：

- `真机模式 sidecar 在线`：`connected` 是当前是否已连着设备。
- `扫到有心率广播（0x180D）的设备`：只列 `hasHrs:true` 的那些；**这一行是空的就说明此刻没有
  可用的心率广播源**（`WARN`，不是脚本报错）。
- `BLE 设备清单（脱敏）`：**所有**扫到的 BLE 设备（不只华为），`HRS` 前缀的是广播了
  `0x180D` 的，`—` 是没广播的。耳机、智能锁、音箱都会出现在这里，这是正常的。

> ⚠️ **第二个"扫不到"的正当原因：设备已经连着别人了。**
> BLE 外设**一旦被某个中央设备连上，通常会停止广播**，此时扫描看不到它自己。包括
> **本机 sidecar 自己连着的那个**（这时 `/api/state` 是 `connected=true`，但 `--scan` 列表里
> 没有它 —— 这是正常的，不是 bug；要看名字就先 `POST /api/disconnect` 再扫）。
> 同理，手机「华为运动健康」App 正连着时，PC 也可能扫不到/连不上。

### 3.1 华为手环 8（HUAWEI Band 8）—— **实测可用**（2026-11-03 23:03–23:06 Asia/Shanghai）

**结论：Band 8 能广播标准 HRS（0x180D），本 sidecar 可以直接连、直接出读数。**
前提只有一个：**在 App 里把「心率广播」打开**（之前那轮"9–10 台设备 0 个 hasHrs"就是因为开关没开）。

实测证据（同一台机器、同一个 sidecar）：

| 环节 | 实测结果 |
|---|---|
| 开启广播的入口 | 华为运动健康 App → 设备 → 手环 → 健康监测 → **心率广播**（打开后手环会常亮提示） |
| `--scan` | **PASS**，设备名 `HUAWEI Band HR-002`，`rssi=-68`，`hasHrs=true` |
| 连上后 `/api/state` | `connected=true`，`bpm=96`，`lastErrorCode=null` |
| `--watch 30` | 30/30 次轮询全 200，`min=96 max=102`，`max sampleAgeMs=614ms`（实时） |
| RR 间期 | **`rrMs: []` —— 手环不广播 RR**（见下方"已知限制"） |
| 端到端（Lead 侧） | 真设备 → pulse 引擎 → 注入行 → 落库 全通；基线 104、峰值 105，`stop` 后注入行立刻消失 |

**已知限制：Band 8 不广播 RR 间期（`rrMs` 永远是 `[]`）**

- 后果：`rmssdMs` 永远是 `null`，**HRV 这条线在手环上是空的**（这不是 bug，是设备不给）。
- 注入行 / Studio 卡片按"没有 RR"正常显示即可（上层已按 `null` 处理）：心率、档位、基线、
  峰值、趋势全部照常；只有"心率变异性"这一类指标没有数。
- 想要 HRV/RR 精度，只有胸带那条路（见下方备选 a）。

**如果要更好的数据，加一条 BLE 心率带（推荐）**

Coospo H808S / 迈金 H64 / Polar H10 之类，几十到几百块：免配对、标准 HRS、戴上就广播，
**RR/HRV 精度远好过腕带光学**。代码一行都不用改 —— 开了就是第二个 `hasHrs:true`，
用 `-NameHint` / `-Address` 指定即可（§4）。

> Band 8 上如果哪天扫不到，按 §3.0 的三条顺序查：① 广播开关还开着吗（息屏/断开后可能自动关）；
> ② 是不是已经被手机 App 或本机 sidecar 连着（连上就不广播）；
> ③ 手环是否在范围内/有电。**不要**先去反复配对或怀疑 sidecar。

### 3.2 华为手表（WATCH GT / Watch 系列）

固件版本不同路径略有差异，但开关名字里一定有"广播"二字：

1. 手表和手机先用「华为运动健康」App 配对过一次（没配过的手表有些型号不暴露这个开关）。
2. 手表上：**设置 → 健康监测 → 心率广播**，打开。
   部分型号在：**设置 → 运动健康 → 心率广播**；更老的型号只在 App 里：
   运动健康 App → 设备 → 手表 → 健康监测 → **心率广播**。
3. 打开后手表会常亮提示"心率广播已开启"，此时它会持续广播 HRS。回到 §3.0 扫一遍确认。

### 3.3 其它品牌

| 品牌 | 路径 |
|---|---|
| Garmin | 设置 → 传感器与配件 → 腕式心率 → **广播心率**（Broadcast Heart Rate） |
| 小米 / 华米 Zepp | Zepp App → 设备 → 健康监测 → **心率广播**（部分型号支持；手环代次先扫再判断） |
| Polar / 其它胸带（H10、H9 等） | 默认就广播 HRS，不用设置，戴上即可（**带 RR**） |
| Apple Watch | watchOS **不原生**广播 HRS，需要装第三方 App（如 Heartcast）才能用 |
| 荣耀/OPPO/vivo | 设置 → 健康/运动 → 心率广播（机型差异大，认准"广播"二字） |
| 华为手环（Band 系列） | **Band 8 实测可用**（§3.1，无 RR）；其它代次照 §3.0 先开广播再扫 |

⚠️ **常见坑**：不少手表**只在运动模式下才广播**（例如部分型号要开一个"户外跑步"再返回），
或者息屏几分钟后自动关闭广播。扫不到时先确认广播开关开着、没在息屏省电，再按 §3.0 查"是不是已被连着"。


---

## 4. Windows 侧配对与连接

1. 确认电脑有 **蓝牙 4.0+** 适配器，系统蓝牙是开的（设置 → 蓝牙和其他设备）。
2. **通常不需要在系统里配对**：心率广播是免配对的 GATT 读，只要手表在广播就能连。
   如果系统里配了更方便（设备名会显示出来），也可以配。
   - 设置 → 蓝牙和其他设备 → 添加设备 → 蓝牙 → 选中手表。
   - 配对码/确认框出现就点确认；华为手表有时需要在手表上点"允许"。
3. 启动 sidecar（**它默认不起作用，只是待命**；真正连接发生在 `/api/connect`）：

```powershell
# 默认懒模式：只监听 127.0.0.1:8151，不扫不连
pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1

# 只认名字里带 WATCH/HR 的（多设备环境；对按需连接同样生效）
pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1 -NameHint HR

# 按 addressHash 前缀指定（推荐：hash 来自 /api/devices，不涉及地址明文）
pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1 -Address 3f9a1c2d

# 只有调试时才用旧行为（启动就扫、自动连、断线自动重连）
pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1 -Auto
```

4. 看设备清单 / 盯读数：

```powershell
node scripts/check-pulse.mjs  # 开发期脚手架，未随包发布  # 开发期脚手架，未随包发布 --scan        # 触发一次扫描并列设备（hasHrs 是关键）
node scripts/check-pulse.mjs  # 开发期脚手架，未随包发布  # 开发期脚手架，未随包发布 --watch 30    # 先按需连一次，再盯 30 秒看读数在不在动
node scripts/check-pulse.mjs  # 开发期脚手架，未随包发布  # 开发期脚手架，未随包发布 --once        # 只读一次现有状态（不扫描、不改状态）
node scripts/check-pulse.mjs  # 开发期脚手架，未随包发布  # 开发期脚手架，未随包发布 --drop-probe  # 真机：量"关广播→断线""重开→再调 connect 恢复"
```

> **"连哪台设备"只有这一个权威入口：`start-sidecar.ps1 -NameHint / -Address`**
> （或 `POST /api/connect` 里的 `nameHint`/`address`）。
> Node 侧的 `pulse.deviceLabel` 只是"设备不上报名字时"的显示别名，不参与选设备。

5. 停：

```powershell
pwsh -File sidecars\ble-heart-rate\stop-sidecar.ps1
```

⚠️ **一个 HRS 设备一般只允许一个中央设备连接**。手机运动健康 App 正连着的时候，PC 可能连不上
（表现为 `connect-failed`）——先把手机上的 App 退掉/断开。

---

## 5. HTTP 接口（字段名就是契约，别改）

绑定地址 **127.0.0.1 硬编码**，没有 `--bind`，任何参数都放大不到局域网。

### `GET /api/health`
```json
{ "ok": true, "version": "1.0.0", "port": 8151, "connected": true, "uptimeSec": 128,
  "fixture": false, "scanCount": 0 }
```
- `scanCount`（2026-11-04 新增）：累计扫描次数。**懒模式下它应该一直是 0**，直到有人
  `POST /api/connect` 或 `GET /api/devices?scan=1` —— 验收就是靠它证明"没请求就不扫"。
  一次 connect 只会让它 **+1**（扫一轮就够，不做第二轮兜底扫描）。

### `GET /api/state`（唯一高频接口）
```json
{ "ok": true, "connected": true, "deviceLabel": "HUAWEI WATCH",
  "addressHash": "3f9a1c2d7b0e4411", "bpm": 118, "rrMs": [498, 502, 495],
  "contact": "yes", "sensorLocation": "chest", "sampleAt": 1793731234567,
  "sampleAgeMs": 900, "quality": "ok", "lastErrorCode": null, "scanning": false }
```

- `bpm`：只在**真收到** `0x2A37` 通知时非 null；**永远不写 0**。设备断了会**保留最后读数**并把
  `connected` 置 false、`sampleAgeMs` 继续变大，上层才能说"最后读数 N 秒前"。
- `addressHash`：`sha256(address)` 前 16 hex。没有设备时 null。
- `contact`：`"yes" | "no" | "unsupported"`（flags bit1 表示"支持接触检测"，bit2 是"此刻有接触"）。
- `sensorLocation`：`0x2A38` 枚举文字（`chest`/`wrist`/`finger`/…），读不到 null。
- `quality`：`"sparse"` = 距上次通知 > 5 s；`"no-contact"` = `contact === "no"`；
  两者同时成立时**返回 `no-contact`**（设备级事实优先于传输稀疏，这个取舍是我定的，
  上层若另有偏好告诉我改）。其余 `"ok"`。
- `rrMs`：最近 ≤30 个 RR 间期（ms，已从 `1/1024 s` 换算）。**有些设备根本不广播 RR**
  （实测华为手环 8 恒为 `[]`）→ 上层必须按"没有 RR"处理：`rmssdMs = null`、HRV 无数据，
  这是设备能力，**不要**当成 sidecar 丢数据或测试失败。
- `lastErrorCode`：`"scan-timeout" | "connect-failed" | "notify-failed" | "disconnected" | null`。
- `scanning`：`/api/devices` 正在扫时为 true。

### `GET /api/devices[?scan=1]`
```json
{ "ok": true, "scannedAt": 1793731200000,
  "devices": [ { "label": "HUAWEI WATCH", "addressHash": "3f9a1c2d7b0e4411", "rssi": -58, "hasHrs": true } ] }
```
- **`?scan=1` 才真扫一轮**；不带参数直接返回上一次的结果（诊断/手动排障用，不替上层偷偷扫）。
  从没扫过时是 `{"ok":true,"scannedAt":null,"devices":[]}`。
- `address` 字段**默认不出现**，只有本地排障加 `--allow-address-display` 才会带。
- `hasHrs` 严格等于"广播包里有 `0x180D`"。耳机/音箱也会出现在列表里，但 `hasHrs:false`。

### `POST /api/connect` / `POST /api/disconnect`
```json
connect 请求 {"address": "<addr|addressHash 前缀>", "nameHint": "WATCH"}   // 两个都可省
connect 成功 {"ok": true, "connected": true, "deviceLabel": "HUAWEI Band HR-002",
              "addressHash": "3f9a1c2d7b0e4411", "elapsedMs": 2140}
connect 失败 {"ok": false, "code": "device-not-found" | "connect-timeout" | "connect-failed",
              "message": "…", "elapsedMs": 7403}

disconnect 响应 {"ok": true, "connected": false}
```
- `connect` 是**按需连接的唯一入口**：收到请求才扫一轮（`0x180D` 过滤 + `nameHint`/`address`），
  选第一个匹配，连接并订阅 `0x2A37`；总预算 `--connect-timeout`（默认 **12 s**，见启动参数）。
  成功时通常会顺手等到第一帧，所以返回后上层第一次拉 `/api/state` 就有 `bpm`。
- **已经连着的时候不会重扫**（已连接的外设根本不广播，扫也扫不到它自己），直接返回当前的
  `deviceLabel/addressHash`，`elapsedMs` 很小。
- 扫描是"一发现就停"的：命中就立刻结束扫描窗口，这也是端到端能做到 1~3 s 的原因。
- `disconnect` 会把连接真正关掉（手环可以停广播、省电），并且**不会**自己重连。

### 永不 500
任何未预期异常都回 **HTTP 200** + `{"ok": false, "code": "internal", "message": "读取心率数据时出了点问题。"}`
（固定中文句，绝不把异常文本/SQL/地址吐给调用方）。未知路由回 404 + `{"ok":false,"code":"not-found"}`。
已实测：`/api/state`、`/api/devices`、`/api/health`、`/api/connect` 在内部抛异常时全是 200。

---

## 6. `0x2A37` flags 解析（**契约已同步**，2026-11-03）

实现按 **Bluetooth SIG HRS 规范**逐位解析：

| flags 位 | 含义 |
|---|---|
| bit0 | 0 = bpm 是 uint8，1 = uint16LE |
| bit1 | 传感器接触**能力**（0 不支持 / 1 支持） |
| bit2 | 传感器接触**状态**（仅 bit1=1 时有效；1 = 有接触）→ `contact:"yes"/"no"`，否则 `"unsupported"` |
| bit3 | energy expended 存在 → 跳过 2 字节 uint16LE |
| bit4 | RR 间期存在 → uint16LE × n，**单位 1/1024 s** → `ms = round(raw * 1000 / 1024)` |

**历史**：契约初稿 §3.5 把 1-based 的接触位编号（"bit1 → 接触位，2=supported, 3=yes/no"）和
0-based 的 energy/RR 下标混写在一句里，按字面实现会把真机最常见的 `flags=0x10`（uint8 bpm +
RR）当成 energy 帧、一条 RR 都读不到。**2026-11-03 Lead 裁决：按 SIG 规范实现，契约 §3.5 已改成
0-based 位表并写明了这次修正**，本文件与契约现在一致，无需再改。

- `--selftest` 里的 "energy 2 字节跳过后再读 RR" 用例就是钉住这一条的（10 个 `0x2A37`
  帧用例 + 脱敏 + `addressHash` 形状 + `bpm=0` 不写 0，共 13 项 PASS）。
- `contact` 三态映射（bit1 能力 + bit2 状态 → `yes`/`no`/`unsupported`）与
  `companion-health/lib/pulse-adapter.mjs` 的校验一致，保持不动。
- **`quality` 只是本 sidecar 的参考口径**（>5 s → `sparse`，`contact:no` → `no-contact`）。
  上层自己派生的口径（例如 >15 s 算 `sparse`）以它为准；不要指望上层用这里的 `quality` 字段。

---

## 7. 排障

先看三样：`logs/sidecar.out.log`、`logs/sidecar.err.log`、`GET /api/state` 的
`connected / bpm / quality / lastErrorCode`。

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 启动时退出码 **2** | 8151 被别的进程占着（不抢别人的监听） | `Get-NetTCPConnection -LocalPort 8151 -State Listen` 看是谁；或 `-Port 8152` 换个口用 |
| `lastErrorCode: "scan-timeout"` | 扫不到广播 0x180D 设备 | **先在设备上打开「心率广播」**（§3.0 第 0 步）；或设备已被手机 App/本机 sidecar 连着（连上就不广播）；或息屏省电 / 距离太远 / 适配器被厂商 PC 套件独占；用 `--name-hint` 缩小范围 |
| `"connect-failed"` | 连不上 | 手机 App 正连着这块表（HRS 一般只允许一个中央设备）→ 断开手机；信号弱；或系统里没配对 |
| `"notify-failed"` | 连上但订阅不到 `0x2A37` | 该设备不真支持 HRS（有些"心率广播"其实只给自家 App），或需要先在系统里配对 |
| `"disconnected"` 反复出现 | 中途断了，正在按 1s→2s→4s…→30s 退避重连 | 数据保留，等它自己回来；`sampleAgeMs` 会继续变大，上层会降级成"最后读数 N 秒前" |
| `connected:true` 但 `bpm:null` | 连上了但设备没在推帧 | 很多手表要进运动模式/戴着才推；戴好、进一个运动界面再回来看 |
| `quality:"sparse"` | 两次通知间隔 > 5 s | 省电策略 / 信号弱；上层会把它降级成"最后读数 N 秒前"，别当实时 |
| `quality:"no-contact"` | 设备说没贴着皮肤 | 戴紧一点；胸带沾水 |
| `{ok:false,code:"internal"}` | 内部异常（已兜底） | 看 `sidecar.err.log`；进程还活着，不会 500 |
| 起了十几秒还没读数 | 第一轮扫描 8 s，扫不到还要再兜一轮全量 8 s | 正常现象，等 20 s 左右 |
| 脚本报一堆"缺少 `}`""意外的标记" | **`.ps1` 丢了 UTF-8 BOM**：Windows PowerShell 5.1 会按 GBK 解析中文并乱码 | 两个脚本必须保存成 **UTF-8 with BOM**（见下） |
| 用 `-Port 8165` 起第二个实例，结果把 8151 的杀了 | 老版本两个实例共用 `logs/sidecar.pid` | 已修：PID/日志按端口隔离；`stop-sidecar.ps1 -Port <n>` |
| `--fixture` 都失败 | venv / 解释器问题 | `python --version`；`--selftest` |

日志限流：退避重连只记前 3 次和每 10 次一行，同类内部错误 30 s 最多一行 —— **不会刷屏**。
HTTP 访问日志默认关（Node 侧 1 Hz 轮询），要看得加 `--verbose`。

### 关于 PowerShell 版本（2026-11-04 补）

- 两个 `.ps1` 都是 `#Requires -Version 5.1`，**Windows PowerShell 5.1 和 PowerShell 7 都能跑**
  （这台机器上 `pwsh` 7 目前不在 PATH / 也没装，5.1 是唯一可用运行时）。
- **必须保存为 UTF-8 with BOM**：5.1 遇到没有 BOM 的 `.ps1` 会按系统代码页（GBK）解析，
  中文注释/字符串全乱，报一堆"缺少 `}`"。如果你用某个编辑器重存过这两个文件、脚本突然解析失败，
  先检查 BOM。校验方法（5.1 就能跑）：

```powershell
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path sidecars\ble-heart-rate\start-sidecar.ps1).Path, [ref]$null, [ref]$errors)
$errors.Count   # 必须是 0
```

---

## 8. 隐私声明（硬规矩，别绕过）

- **只走回环**：监听 `127.0.0.1:8151`，`heart_rate.py` 没有 `--bind` 之类的口子，
  `start-sidecar.ps1` 也没有。局域网上的任何东西都连不到它。
- **日志不含地址明文**：所有日志先过 `scrub()`，蓝牙地址只会以 `addressHash` 前 8 位出现
  （形如 `ble:c1582e87`）。连 WinRT 异常文本里带出来的地址也会被抹掉。
  `start-sidecar.ps1` 启动后还会**扫一遍日志**，发现 `AA:BB:CC:DD:EE:FF` 这种形态就
  **立刻停进程并报错**——宁可失败，也不留一条明文。
- **`/api/devices` 默认不给 `address`**：只给 `addressHash`。真地址要显式
  `--allow-address-display`（仅本地排障，别写进脚本自动化）。
- **不落盘**：进程内存里只保留最近 30 个 RR 间期（`rrMs`）；不写数据库、不写曲线文件。
  历史统计是 Node 侧的事（`health_pulse_sessions` 只存派生统计）。
- **不上云、不进群聊、不进 B 站、不做医学判断**。这条路只负责"她读得到你的生理反应"。

---

## 9. 文件清单

| 文件 | 作用 |
|---|---|
| `heart_rate.py` | 全部逻辑：BLE 中央设备 + HRS 解析 + `ThreadingHTTPServer`（`--selftest` 做离线自检） |
| `requirements.txt` | `bleak==0.22.*` |
| `fixtures/*.json` | 合成序列（不需要硬件） |
| `start-sidecar.ps1` | 端口预检 → detached 启动 → PID 文件 → `/api/health` 自检 → 日志隐私闸 |
| `stop-sidecar.ps1` | 只按 PID 文件停；命令行对不上就拒绝动手 |
| `logs/sidecar.pid` | `{port, wrapperPid, listenerPid, startedAt, …}`（唯一句柄）。**按端口隔离**：8151 用 `sidecar.pid`，其它端口用 `sidecar-<port>.pid` |
| `logs/sidecar.out.log` / `sidecar.err.log` | 日志（UTF-8）。同样按端口隔离：`sidecar-<port>.out.log` |
| `../../scripts/check-pulse.mjs`（**开发期脚手架，未随包发布**） | 验收脚本：`--fixture`（懒/按需模式，默认）/ `--scan` / `--watch <秒>` / `--drop-probe` / `--once`，另有 `--auto`（旧行为回归）、`--idle-window <秒>`；PASS/FAIL 表，有 FAIL 就 exit 1 |

`check-pulse.mjs` 默认模式是 `--fixture`，**没有硬件、没有任何真机设备也能全绿**
（32 项，含懒模式专项：启动静默 / 60 s 0 扫描 / `?scan=1` 才扫 / 端到端 < 15 s /
一次 connect 只扫一次 / 断线不自动重连；以及字段名与类型、sampleAt 随时间推进、
`rrMs` 与 bpm 自洽、`no-contact` 分支、端口预检退出码 2、日志无地址明文、坏请求不 500 …）。

---

## 10. 实测到哪一步了（2026-11-03，Asia/Shanghai）

> 一句话：**无硬件（fixture）全绿；真机（华为手环 8 · `HUAWEI Band HR-002`）已跑通实时读数**；
> 只剩「关广播 / 重开广播」的两个秒数待有人点两下开关（§10.4，命令已备好）。

### 10.1 环境是隔离的

**独立 venv，只给这个 sidecar 用**（发布树里不带 venv；任何人自己建一份即可）：

```bash
cd sidecars/ble-heart-rate && python -m venv .venv && . .venv/bin/activate
python -m pip install -r requirements.txt
```

- 当时实测的解释器是 CPython 3.12 + bleak 0.22.3；`requirements.txt` 现在写成 `bleak>=0.22,<0.23`。
- **不要动系统默认 python**：这个 venv 存在的唯一理由就是别把 bleak 装进全局。
- 删掉 venv 不影响任何其它模块：`--fixture` 和 `--selftest` 连 bleak 都不需要（惰性导入）。

### 10.2 无硬件（fixture）—— 已全绿

```
node scripts/check-pulse.mjs  # 开发期脚手架，未随包发布  # 开发期脚手架，未随包发布 --fixture              → 总结: PASS 32 / WARN 0 / FAIL 0（exit 0）
node scripts/check-pulse.mjs  # 开发期脚手架，未随包发布  # 开发期脚手架，未随包发布 --fixture --auto       → 总结: PASS 26 / WARN 1 / FAIL 0（旧行为回归）
node scripts/check-pulse.mjs  # 开发期脚手架，未随包发布  # 开发期脚手架，未随包发布 --watch 5 --fixture    → PASS 7 / FAIL 0
python sidecars/ble-heart-rate/heart_rate.py --selftest → 13 项全 PASS（10 个帧用例+脱敏+hash 形状+bpm=0）
```

**懒 / 按需模式的关键实测（2026-11-04，默认配置，60 s 静默窗口）**：

```
 5   PASS  懒模式：启动即静默              scanCount=0、connected=false（不扫、不自动连）
 6   PASS  没请求时 60s 内 0 次扫描        60.1s 里查了 12 次 /api/health，scanCount 始终为 0
                                          （期间没有 connect、没有 ?scan=1）
 7   PASS  /api/devices 不带 scan=1 → 不扫描   scannedAt=null、devices=[]、scanCount 仍是 0
 9   PASS  静默→有读数 端到端 < 15 s       75ms（connect 请求本身 74ms，bpm=88；多次运行 75~124ms）
 10  PASS  一次 connect 只触发一次扫描     scanCount 0 → 1（没有多余的后台扫描）
 26  PASS  断线后不自动重连（懒模式）      再等 5 s：connected 仍 false、scanCount 仍 3、sampleAt 未变
```

> **端到端秒数**：fixture 下 **75~124 ms**（这是真实协议路径：HTTP → 扫一轮 → 选设备 → 连接 →
> 订阅 → 首帧）；真机的手环**待实测**（写进 §10.4 的 TODO，因为必须等手环空出来）。

覆盖到的契约面（逐项断言，都有具体输出）：`/api/health` **7 字段**（新增 `scanCount`）、
`/api/state` **13 字段不多不少**、`/api/devices?scan=1` 结构与"默认不带 address"、
`/api/connect` 新响应（`deviceLabel`/`addressHash`/`elapsedMs`）、`/api/disconnect`、
`sampleAt` 随真实时钟推进、`rrMs ≤30` 且与 bpm 自洽、断线后**读数冻结** + `quality:"sparse"`
+ **不自动重连**、按需重连恢复、`contact:no → quality:"no-contact"`、端口被占**退出码 2**、
未知路由 404 而非 500、坏 JSON 不 500、日志无地址明文。

另外用注入探针单独证过：`/api/state`、`/api/devices`、`/api/health`、`/api/connect`
在内部**抛异常**时全部回 `HTTP 200 + {ok:false,code:"internal",message:"读取心率数据时出了点问题。"}`，
异常文本里塞进去的 MAC 在日志里也被 `scrub()` 抹成了 `ble:xxxxxxxx`。

### 10.3 真机（华为手环 8 · HUAWEI Band HR-002）—— 已跑通实时读数

**实测时间 2026-11-03 23:03–23:06（Asia/Shanghai）**，本机 Intel 蓝牙适配器，
设备名 `HUAWEI Band HR-002`，**前提是在 App 里把「心率广播」打开**（§3.0 第 0 步）。

`--scan` 实测输出（留一行原文，真机，**未连接状态**下扫的）：

```
 4   PASS  扫到有心率广播（0x180D）的设备   HUAWEI Band HR-002 rssi=-68
 6   PASS  GET /api/state 结构             connected=true bpm=96 lastErrorCode=null
```

`--watch 30` 实测输出（留一行原文，真机）：

```
 4   PASS  轮询全部成功                     30/30
 5   PASS  读数在生理可能范围               30 个读数 min=96 max=102
 6   PASS  读数新鲜（sampleAgeMs ≤ 5s）     max sampleAgeMs=614
 8   WARN  rrMs 有数据                      没收到 RR（设备可能不广播 RR 间期）
```

顺带记一条**同一天踩到的坑**（脚本已改成这个口径）：设备**已经连着**时再 `--scan`，是扫不到它
自己的（连上即停止广播）。此时的输出是：

```
 3   PASS  GET /api/devices 结构   9 条
 4   WARN  扫到有心率广播（0x180D）的设备   此刻 sidecar 已连着设备（bpm=99），而连上的外设会停止广播，
                                          所以扫不到它自己是正常的；要列名字请先 POST /api/disconnect 再扫
```

结论：**真机链路的每一段都验过了** —— 扫描过滤（0x180D）→ 连接 → `0x2A37` 通知 →
`/api/state` 全字段 → 1 Hz 轮询稳定（无 500、`sampleAgeMs` 一直 ≤1 s）。
Lead 侧端到端也通了：真设备 → pulse 引擎 → 注入行 → 落库；`stop` 后注入行立刻消失。

**RR 这条线在 Band 8 上是空的**：`rrMs` 恒为 `[]` → `rmssdMs` 恒为 `null` → HRV 无数据。
这是设备能力（它不广播 RR 间期），不是链路问题；上层按 `null` 正常显示即可。
要 HRV 只能上胸带（§3.1 备选）。

### 10.4 懒模式的**真机**实测与两个待补数字

真机（`HUAWEI Band HR-002`）在懒模式下的**失败路径**已实测（2026-11-04 01:35，手环当时正被
另一个进程连着，因此不广播）：

```
启动后 3 s：health: connected=false   scanCount=0        ← 静默，一次没扫
POST /api/connect → 7403ms → {"ok":false,"code":"device-not-found","elapsedMs":7390,
                              "message":"没有找到心率广播设备（…）"}
之后：scanCount=1   state.lastErrorCode=scan-timeout    ← 只扫了一次
再等 3 s：scanCount=1（失败不重试、不后台重连）
```

即：**连接失败也只扫一轮、7.4 s 内给结论、之后彻底停手**（不刷日志、不空转）。

仍缺的两个数字（需要手环空出来才能量，**不是漏做**）：

1. **真机「静默→有读数」端到端秒数**（fixture 是 124 ms；真机预期 1~3 s，因为扫描一命中就停，
   上限由 `--connect-timeout=12 s` 兜住，所以必然 < 15 s）。
2. **关广播 / 重开广播的两个时间**（断线检测 + 重开后再调 connect 的恢复时间）。

一条命令能同时量到它们（主人手上有开关时跑，90 s 出数）：

```powershell
node scripts/check-pulse.mjs  # 开发期脚手架，未随包发布  # 开发期脚手架，未随包发布 --drop-probe
```

> 📌 **TODO（已知空白，不是漏做）**：上面两个数字还没有人跑过带开关的动作。
> 有意为之：为了两行数字去切断蓝牙适配器（会掐掉正在用的耳机音频）不值得，Lead 已明确不授权。
> 命令已备好、由主人在设备上自己跑；跑完把两行贴回来，这里就换成实测值并标日期。
> 在那之前，**代码可推的口径**是：扫描一命中即停（通常 < 2 s）+ 连接 1~2 s + 首帧 ≤ 2.5 s，
> 全程受 `--connect-timeout=12 s` 约束，所以"静默→有读数"**必然 < 15 s**；
> 断线检测 ≤ 0.5 s（会话循环每 0.5 s 看一次 `is_connected`），`quality` 按契约在断流 > 5 s 才
> 变 `sparse`；**不做自动重连**，恢复时间 = 上层下一次 `/api/connect` 的时间。

### 10.5 修过的六个真问题（留档，别再踩）

0. **改成"按需"（2026-11-04，主人提的需求）**：原来进程一起来就扫、自动连、断线还后台重连，
   等于没人用的时候也一直占着蓝牙/耗电。现在默认懒：只监听，`POST /api/connect` 才动；
   `?scan=1` 才扫；断线就停手等下一次调用。旧行为完整保留在 `--auto`（fixture/自测用），
   两条路都有回归断言。顺手把扫描改成"一命中就停"，端到端从"等满 8 s 窗口"降到 **124 ms**
   （fixture 实测）。
0b. **两个实例共用 PID/日志文件 → 会误杀**（2026-11-04 我自己踩的）：在 8151 已经跑着实例时，
   用 `-Port 8165` 起第二个，两个坑一起踩：新实例的 `cmd` 打不开被旧实例占用的
   `sidecar.out.log`（重定向失败 → 进程秒退）；而 `stop-sidecar.ps1` 读的 `sidecar.pid`
   记的是 8151，于是把**正在用的 8151 实例杀了**。现在：PID 文件与日志**按端口隔离**
   （8151→`sidecar.pid`，其它→`sidecar-<port>.pid`），`stop-sidecar.ps1 -Port <n>` 选端口，
   并且脚本会**校验 PID 文件里记的端口必须等于要停的端口**，不等就拒绝动手。
0c. **PowerShell 变量名大小写不敏感**：防护代码里写 `$port = [int]$record.port` 会直接覆盖
   参数 `$Port`，让"端口必须对应"的校验形同虚设。改成 `$recordedPort`。
0d. **`.ps1` 必须是 UTF-8 with BOM**：5.1 按系统代码页解析无 BOM 文件，中文全乱、报解析错误。
1. **`/api/connect` 别做乐观应答**（Lead 2026-11-03 复现）：fixture 分支曾经只置一个标志就回
   `connected:true`，而回放循环的"暂停分支"可能在之后仍写 `connected:false`；上层紧接着拉
   `/api/state` 就会看到 `connected:false` + 样本停在 connect 时刻。
   现在：(a) 循环在锁内复查 `_want` 之后才写 false；(b) `/api/connect` 等回放真的吐了第一帧
   （最多 3 s）才回 `connected:true`；(c) 验收脚本改成"最多等 3 s 落定"。
2. **`check-pulse` 之前会漏进程**：venv 的 `python.exe` 会 re-exec，`child.kill()` 只杀掉启动器，
   真正的解释器还占着端口 —— 下一次跑就会"复用别人的 sidecar"、甚至把 fixture 进程留在机器上。
   现在统一 `taskkill /PID <pid> /T /F` 杀整棵树，等端口不再应答才继续，退出前再兜一遍。
3. **设备"消失"后别死抱旧地址直连**（真机才暴露）：广播一关，外设就不在广播状态，此时
   `BleakClient(address)` 要等 connect 超时（默认 20 s）才失败，再叠 3 次退避才重扫 —— 重开广播
   后可能要等半分钟以上。现在 `lastErrorCode="disconnected"` 时（自动选中的地址）**立刻丢地址**、
   下一轮重扫，且重连轮次的扫描窗口收紧到 **≤6 s**。

### 10.6 已知限制

- **懒模式不自动重连是设计**：手环广播关掉后 `connected=false` 就停手，要靠上层下一次
  `/api/connect` 才恢复（上层会在会话结束时调 `/api/disconnect`、≤30 s 内收口会话）。
- **Band 8 不广播 RR 间期**（`rrMs: []`）→ `rmssdMs` 恒 `null`，HRV 无数据（§3.1）。
- 一个 HRS 设备通常**只允许一个中央设备连接**（手机 App 或本机另一个 sidecar 连着时，
  第二个连不上 → `connect-failed` / `device-not-found`）；而且**连上后它不再广播**，
  此时扫描看不到它（§3.0）。
- 部分手表**只在运动模式下广播**，或息屏几分钟自动关广播（Band 8 开着广播时手环会常亮提示）。
- 腕带光学在剧烈运动时容易丢帧 → 会看到 `quality:"sparse"`；胸带的 RR 精度明显更好。
- `--scan`/`connect` 在 Windows 上要独占蓝牙适配器几秒；同时开着厂商 PC 套件可能扫不全。

