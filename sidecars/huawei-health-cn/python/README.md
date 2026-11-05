# python/ —— 这里放你自己的上游实现（本仓库不提供）

这个目录**默认是空的**。原因写在 [`../PROTOCOL-FREEZE.md`](../PROTOCOL-FREEZE.md) §1.1：
上游集成（`and7ey/huawei_health`）的许可证在冻结环境里无法确认，所以本仓库**不分发**它的代码。

## 你要做的

1. 自备一份上游检出（git clone），指向集成包目录：

   ```bash
   export HUAWEI_UPSTREAM_PKG=/path/to/huawei_health/custom_components/huawei_health
   ```

   这个目录里应当有 `client.py` 与 `const.py`。
   （`capture_snapshot.py`、`sleep-first-night-probe.py`、`test_protocol_contract.py`、
   `verify_frozen_copy.py` 都从这里找上游；找不到时它们会明确说「未配置」并停下。）

2. 提供一个 serve 入口，实现本 sidecar 的唯一端点：

   ```
   GET /api/data?days=<3|7|30>[&force=1]   -> 冻结的 payload（幂等、15 s 缓存）
   ```

   两种放法，任选其一：
   - 直接写在这个目录：`python/serve.py`（启动器默认查找它）；
   - 或者放在别处，用 `export HUAWEI_SERVE_SCRIPT=/path/to/your_serve.py` 指定。

   启动器只要求它接受 `--port <n> --host 127.0.0.1`，且只监听回环。

3. 令牌对放在 `<dataRoot>/credentials/huawei_account.json`
   （`$HUAWEI_ACCOUNT_JSON` 可改；`<dataRoot>` 见 `sidecar_paths.py`）。它不进仓库、不会被打日志。

## 没有上游时会发生什么（都是明确失败，不是栈崩）

| 动作 | 行为 |
| --- | --- |
| `start-sidecar.sh` / `start-sidecar.ps1` | 打印「本仓库不包含上游实现」+ 两条自备途径，**exit 3** |
| `capture_snapshot.py` | 需要**已在运行**的 sidecar；连不上时退出码 3，并说明"sidecar 没在跑" |
| `sleep-first-night-probe.py` | 非 `--dry-run` 时 **exit 5** + 中文提示；`--dry-run` 不需要上游、照常工作 |
| `test_protocol_contract.py` | 依赖上游的 6 条用例 **skip**（打印原因），其余照常 |
| `test_redact.py` | 完全不受影响（纯标准库） |
| `verify_frozen_copy.py` | **exit 3**：没有可对照的原件，不是说复制件坏了 |
| `plugins/companion-health` | 华为通道显示 **未配置 → 不可用**（sidecar 不在），不会显示"正常" |
| **BLE 心率通道** | **完全不受影响**，`sidecars/ble-heart-rate` 自带实现，可独立离线验收 |

## 为什么这样更诚实

"我们替你分发了别人的代码，但不确定能不能" 比 "请你自己准备上游" 危险得多：
前者在发布物里埋了一个许可证问题，后者只要求使用者做一次显式选择。
