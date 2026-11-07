# 用 DSH 持久终端运行健康采集器

先启用宿主的「持久终端」套件。Windows 使用 PowerShell，Linux/macOS 使用 Bash。
两个后端默认都叫 `shell`，同一个平台只启用一个。

在本机 profile 的 `cordis.patch.yml` 增加以下片段。将文件 URL 换成当前套件中
`plugins/companion-health/collector-terminals.mjs` 的绝对文件 URL。

```yaml
- id: optional-persistent-terminals
  insert:
    - id: companion-health-collector-terminals
      name: 'file:///path/to/plugins/companion-health/collector-terminals.mjs'
```

在 `$DSH_HOME/companion/health-collector-terminals.json` 配置采集器。每个
`python` 填 Python 可执行文件的绝对路径。蓝牙环境需先安装
`sidecars/ble-heart-rate/requirements.txt`。云端可以通过 `accountFile`
引用现有凭据文件，也可省略它，沿用云采集器的默认凭据位置。

```json
{
  "cloud": { "python": "/path/to/python", "accountFile": "/path/to/huawei_account.json" },
  "ble": { "python": "/path/to/venv/bin/python" }
}
```

只配置要启动的采集器。本地配置和凭据不入库。默认端口分别为 8765 和 8151，
可用各自的 `port` 字段覆盖。端口已占用时跳过，先确认旧服务身份并准备好回退方式，
再停止旧实例、重启 DSH。BLE 使用按需连接，启动时不会扫描设备。

DSH 启动后分别检查云端的 `/api/data?days=1` 和蓝牙的 `/api/state`。
日志中的 `command sent` 只代表命令已送进终端。云采集仍需有效的华为授权，
BLE 服务能响应也不代表手环已连接。两路终端随所属的 DSH 实例关闭，下次启动时重新建立。
