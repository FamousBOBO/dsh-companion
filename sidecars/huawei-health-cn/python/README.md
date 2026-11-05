# python/ —— 华为健康读取实现（随包分发）

这个目录**不是空的**，也不需要使用者自备任何东西：华为通道开箱即可用，只差一次账号授权
（没有授权时，通道会如实显示「未配置 / AWAIT_LOGIN」，而不是崩溃或假装在线）。

## 里面有什么、从哪来、什么许可

| 文件 | 是什么 | 来源 | 许可 |
| --- | --- | --- | --- |
| `client.py` | 云端读取客户端（`HuaweiHealthClient`、`Tokens`、`health_series` 等） | **派生副本**：上游 [`and7ey/huawei_health`](https://github.com/and7ey/huawei_health) | MIT，`Copyright (c) 2026 and7ey` |
| `const.py` | 端点、主机、运动类型等常量表 | 同上（派生副本） | MIT（同上） |
| `huawei_login.py` | 三步登录探针：`url` → `exchange` → `probe` | 由上游登录探针派生 + 两处适配（A1/A2） | MIT（同上）+ 本项目适配 |
| `huawei_dashboard.py` | 只读 HTTP 服务端，提供 `GET /api/data?days=N` | **本项目自写**（上游没有这个文件） | MIT（本项目） |

许可全文在 [`../UPSTREAM-LICENSE.txt`](../UPSTREAM-LICENSE.txt)，来源、提交与本地适配的完整说明在
[`../PROTOCOL-FREEZE.md`](../PROTOCOL-FREEZE.md) §1.1。请连那条一起读：**这是派生分发，不是逐字节副本**
（冻结时的上游提交已 404，上游当前 main 的大小与本地的不同）。

## 本地改了什么（逐条）

| 编号 | 文件 | 内容 |
| --- | --- | --- |
| A1 | `client.py` / `const.py` / `huawei_login.py` | 路径解析：同级目录优先，其次 `$HUAWEI_UPSTREAM_PKG`；**不再**读任何 `tmp/` 路径 |
| A2 | `huawei_login.py` | 控制台 uid 打码；令牌文件落 `<dataRoot>/credentials/huawei_account.json`（`$HUAWEI_ACCOUNT_JSON` 可改），不进仓库、不入日志 |
| A3 | `huawei_dashboard.py` | 本项目自写：`127.0.0.1:8765`、15 s 缓存、`days` 只认 3/7/30、错误码原样透出 |
| — | 协议 | **未改动**：端点、字段名、单位、时间口径与 `PROTOCOL-FREEZE.md` §2–§8 一致 |

## 怎么用

```bash
# 1) 登录一次（令牌对 180 天有效，文件当密码看待）
python sidecars/huawei-health-cn/python/huawei_login.py url          # 打开授权页
python sidecars/huawei-health-cn/python/huawei_login.py exchange "<粘贴回调里的 code>"
python sidecars/huawei-health-cn/python/huawei_login.py probe        # 只读验证

# 2) 起 sidecar（Windows / Linux·macOS 各一套脚本）
pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1
sidecars/huawei-health-cn/start-sidecar.sh
```

没有令牌文件时启动器会**直接停下**并打印下一步（`exit 2`，中文说明），不会让你等 30 秒超时；
想先起进程（自定义入口能容忍无凭证）加 `-AllowUnconfigured` / `--allow-unconfigured`。

## 想用更新的上游？

```bash
export HUAWEI_UPSTREAM_PKG=/path/to/custom_components/huawei_health   # 含 client.py / const.py
```

`huawei_login.py` 会优先用它（`PACKAGE_DIR` 指向你的检出），`test_protocol_contract.py` 与
`verify_frozen_copy.py` 也随之改用它做对照。你的检出**不必**改动任何东西，也不必拷进本目录。

## 自检（都不联网）

| 命令 | 检查什么 |
| --- | --- |
| `python verify_frozen_copy.py` | 4 个文件在、能解析、provenance 块完好、协议面（类/函数/常量）齐全 |
| `HUAWEI_UPSTREAM_PKG=… python verify_frozen_copy.py` | 另外与上游逐文件 diff，把差异**如实打印**（派生副本有差异是预期） |
| `python test_protocol_contract.py` | 快照契约 + 上游实现的纯函数行为（0/‑1 = 未测量等） |
| `python ../test_redact.py` | 脱敏：token 不外流、uid 假名稳定、设备标识 sha16 |
