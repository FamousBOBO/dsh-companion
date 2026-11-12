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
Windows 启动器的 TEMP/TMP/TMPDIR 必须位于工作区外；使用
`tools/lib/host-temp.mjs` 解析本机 LocalAppData 下的临时目录。使用本机 Node
运行宿主可避免 Electron 可执行文件被作为沙箱 runner 启动、但子进程环境
清理 Electron 标记后退出的问题。
如果 Windows 终端继承了 Bash 参数，需在本机 profile 显式覆盖
`optional-terminal-pwsh` 的 `shellDialect: pwsh`、
`shellArgs: [-NoLogo, -NoProfile]` 与已安装的 PowerShell `shellPath`。
本机 profile 与账号路径不入库。
日志中的 `command sent` 只代表命令已送进终端。云采集仍需有效的华为授权，
BLE 服务能响应也不代表手环已连接。两路终端随所属的 DSH 实例关闭，下次启动时重新建立。

在「运动健康 → 采集器持久终端」可查看两路状态，并单独启动、重启或终止。
「启用」决定是否允许启动并随 DSH 自动启动。关闭会停止当前终端，
单次「终止」保留启用设置。重新启用后可手动启动，或等下次 DSH 启动。
控件仅管理由本插件打开的终端。检测到外部进程占用端口时，界面会显示占用状态。
