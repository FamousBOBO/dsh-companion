# companion-health · 健康数据（华为运动健康 CN 云 + BLE 心率）

一个 DSH（DeepSeek Harness）插件：把**本机**健康 sidecar 里的数据读进本地 SQLite，只读地提供
「状态 / 今日 / 趋势 / 睡眠 / 主动关怀 / 实时心率」；数据不出本机。

- 包名 `@dsh-companion/health`，版本 `0.1.0`（模块自身历史版本留在 `localVersion`）
- 许可证 MIT；接口契约与实现细节见 [`CONTRACT.md`](./CONTRACT.md)
- 依赖 Node `>= 24`（用 `node:sqlite`，没有原生模块）

---

## 1. 它需要什么

| 数据 | 来源 | 谁启动 |
| --- | --- | --- |
| 华为运动健康（步数/心率/压力/血氧/训练/睡眠） | [`sidecars/huawei-health-cn`](../../sidecars/huawei-health-cn/README.md) 暴露 `http://127.0.0.1:8765/api/data` | 用户自己（需要自己的华为账号登录） |
| 实时心率（BLE 心率广播 HRS 0x180D） | [`sidecars/ble-heart-rate`](../../sidecars/ble-heart-rate/README.md) 暴露 `http://127.0.0.1:8151/api/state` | 用户自己（需要支持心率广播的胸带/手环） |

**这个插件不会启动 sidecar、不安装它、不管理它的生命周期**；它只会连一个已经配置好的回环地址。
两个地址都来自配置（见下），非回环地址会被拒绝（硬规则：心率不该出现在局域网上）。

## 2. 安全默认值（重要）

拿到仓库时**什么都没有在采集**：

| 开关 | 默认 | 打开后会发生什么 |
| --- | --- | --- |
| `config.enabled`（采集） | **`false`** | 每 `collector.pollMinutes` 分钟访问一次回环 sidecar，sidecar 再去访问华为云 |
| `config.pulse.enabled`（BLE 心率） | **`false`** | 允许开「心跳会话」；只有会话进行中才会轮询 BLE sidecar |
| `capabilities.*`（注入/记忆/改日程/主动关怀） | `false` | 本轮没有实现代码路径，写 `true` 也会被强制回落 |

关着的时候：不建数据库、不起定时器、**一次请求都不发**（`test/release-defaults.test.mjs` 用记账
式 fetch 断言过「零请求」）。要采集就自己写：

```json
{ "enabled": true }
```

## 3. 配置与数据在哪

- 配置文件：`<home>/health/config.json`（不存在时按默认值原子创建，之后**永不静默重写**）
- 数据库：`<home>/health/health.db`（WAL；只在采集开启且首次成功后才建）
- `<home>` 解析顺序：`--home` 参数 → `$DSH_COMPANION_HEALTH_HOME` → `$DSH_COMPANION_DATA_DIR/home`
  → `<套件根>/data/home`

可用 `DSH_COMPANION_HEALTH_SIDECAR_URL` / `DSH_COMPANION_PULSE_SIDECAR_URL` 覆盖 sidecar 地址
（只接受 `127.0.0.1` / `localhost` / `::1`）。

逐字段说明见 [`CONTRACT.md`](./CONTRACT.md) §3。

## 4. 状态怎么读（别把「没配置」当成「坏了」）

`service.readiness()` / `status().readiness` 给三个通道的诚实状态，每个都带中文 `label` 和
一句 `hint`：

| 通道 | 「未配置」 | 「不可用」 | 「未启用」 | 「正常」 |
| --- | --- | --- | --- | --- |
| 采集 | 开着但一次没跑过 | 连不上 sidecar / 云端拒绝凭证 | `enabled:false` | 最近一轮 ok/partial |
| 账号 | 没有任何登录快照 | 传输层失败（**不知道**账号状态） | — | 凭证有效 |
| 心率 | — | sidecar 没起 / 没扫到心率设备 | `pulse.enabled:false` | 会话进行中 |

详见 [`CONTRACT.md`](./CONTRACT.md) §3.0.1。

## 5. 自检（只读，默认不联网）

```bash
node plugins/companion-health/scripts/check-health.mjs          # 人类可读
node plugins/companion-health/scripts/check-health.mjs --json   # 单行 JSON
node plugins/companion-health/scripts/check-health.mjs --probe  # 额外做一次真实 sidecar 探测
```

只读实例：不轮询、不 sync、不建库、不建配置。退出码 `0` = 健康，`1` = 不然，`--exit-zero` 强制 0。

关采集 / 回滚：

```bash
node plugins/companion-health/scripts/health-stop.mjs            # enabled:false（先备份）
node plugins/companion-health/scripts/health-stop.mjs --status   # 只看不改
node plugins/companion-health/scripts/health-stop.mjs --restore <bak>
```

> 脚本只改配置，**不杀进程**：宿主里已经在跑的定时器要等宿主 reload/重启才彻底消失，
> 脚本会把这句打出来而不是假装"已经停了"。

## 6. 测试

```bash
cd plugins/companion-health
node --test test/*.test.mjs      # 211 条：210 pass / 1 skip（真实快照对账，属个人数据，不入库）
```

## 7. 没验证的部分

真机 BLE（需要胸带/手环 + 蓝牙）、真实华为账号登录、云端限流实况，都**没有**在发布环境里验证过；
详见 [`CONTRACT.md`](./CONTRACT.md) §16。
