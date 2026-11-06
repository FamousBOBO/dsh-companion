# DSH Node 生产运行与同步

在已配置好的陪伴套件中，用 Node 24+ 运行已安装的 DSH Host CLI，不依赖打开 Electron 桌面窗口。仍需保留 DSH 安装目录：宿主位置取自本机 `config/suite.json` 的 `dsh.moduleRoot`。

本目录可直接随仓库使用。也支持原来的仓库外目录布局，或通过 `DSH_COMPANION_PRODUCTION_ROOT` 指向已有生产仓库。以下生产管理脚本用于 Windows，默认 profile 为 companion、数据在 data/、端口为回环地址 3100；不自动迁移用户历史，也不覆盖已有配置。

先按部署文档完成依赖安装、构建、初始化和诊断，再使用：

```powershell
powershell -NoProfile -File dsh-ops/production.ps1 start
powershell -NoProfile -File dsh-ops/production.ps1 status
powershell -NoProfile -File dsh-ops/production.ps1 sync
powershell -NoProfile -File dsh-ops/production.ps1 stop
```

同步仅允许 Git fast-forward，并拒绝覆盖已修改的受跟踪文件。有更新时停止当前受管理实例，安装依赖、构建、验证，再启动；失败则保持停止以供排查。停止前核验 PID、可执行文件与启动时间，避免处理其他实例。

单元测试在独立临时套件根、数据根及固定测试人格下运行，防止生产人格或默认开启的功能污染离线测试。生产 profile 合成随后使用原配置单独验证；相关环境变量在结束后恢复。

`host-rpc.mjs` 从本次启动段提取认证入口，通过宿主的 /connect 获取 cookie，再发起标准 RPC 信封。不会把令牌输出到控制台。`check-production.mjs` 检查认证、首页和记忆接口及插件激活情况，只输出状态报告。

```powershell
node dsh-ops/check-production.mjs
node dsh-ops/probe-opencode.mjs
```

OpenCode 探测默认仅读取模型目录。显式添加 `--smoke` 才创建验收会话并调用一次模型，可能计费；完成后恢复验收会话的原默认模型，不向 QQ 等外部平台发消息。默认探测 provider 为 opencode-go、模型为 deepseek-v4.1-flash，需先在宿主中配置好对应路由。

进程记录和探测报告仅写入 data/tmp 与 data/logs。日志含本机认证入口，不得提交、上传；配置、人格、历史、记忆、健康授权及其他用户数据也不属于此目录的源码。
