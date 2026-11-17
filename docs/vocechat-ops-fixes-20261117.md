# VoceChat 运维修复记录（2026-11-17）

> 记录时间：2026-11-17 15:20，Asia/Shanghai
> 涉及两件事：①Defender 误报拦截 DSH 命令；②手机上传头像失败的真实根因与修复。

---

## 一、Windows Defender 误报（Trojan:Win32/ClickFix.DBD!MTB）

### 事实

| 项 | 值 |
|---|---|
| 检测时间 | 2026-11-17 15:12:56 |
| 威胁名 | `Trojan:Win32/ClickFix.DBD!MTB` |
| `DidThreatExecute` | **False** —— 没有真正执行任何恶意代码 |
| `IsActive` | **False** —— 已不活跃 |
| `ActionSuccess` | **True** —— 已阻断并清理 |
| `DetectionSourceTypeID` | 2 |
| `Resources` | **`CmdLine:`**，不是 `file:` |

唯一被判定为「威胁」的资源，是我发出的一条 `pwsh` 命令的**命令行文本本身**：

```
CmdLine:D:\DSH\node-v24.14.0-win-x64\node.exe ...\dsh-subprocess-local\lib\runner.js
  -- ...\pwsh.exe -NoLogo -NoProfile -NonInteractive -Command
     [Console]::OutputEncoding = ...;
     # dsh-plugin-pwsh7 basic rule: deletions go to the Recycle Bin
     function Remove-Item { ... Invoke-RestMethod -Method Post -Uri ... -Headers @{ 'x-dsh-recycle-token' = ... } ... }
     cd 'D:\DSH\vocechat\evidence'
     foreach ($kb in @(1024, 1500, ...)) { ... }
```

### 为什么命中

DSH 的 `pwsh` 工具在执行每条命令前，会把一个 `Remove-Item` 回收站包装函数**内联拼进命令行**。
那个包装里含：

- `Invoke-RestMethod -Method Post -Uri $env:DSH_PWSH7_RECYCLE_URL`
- `-Headers @{ 'x-dsh-recycle-token' = $env:DSH_PWSH7_RECYCLE_TOKEN }`
- 动态拼 JSON：`'{"paths":["' + $item.FullName... + '"]}'`

「脚本里运行时拼一个 HTTP POST + 令牌头出去」正是 ClickFix 类恶意活动（伪造验证步骤诱导
用户粘贴命令执行）的标志形态。Defender 的 `!MTB`（Microsoft Threat Blocker，云端启发式）
据此判定，与我的实际行为无关。**这是误报。**

### 影响面

| 检查项 | 结果 |
|---|---|
| 有无磁盘文件被隔离 | **无**。该事件 `Resources` 只有 `CmdLine`，没有 `file:` |
| 关键文件完整性 | `vocechat-env.mjs` 2629 B / `bot-companion-a.json` 449 B / `webhook-token.json` 413 B / `serve.mjs` 2749 B —— 全部完好 |
| 被拦的那条命令 | 只拦截了那一条；后续命令正常执行 |
| 是否有残留阻止规则 | 无。Defender 没有对该命令行建立持久规则 |

历史检测记录里另有三条 `file:` 资源，均为本次事件之外：

| 时间 | 威胁 | 资源 |
|---|---|---|
| 2026-11-13 15:07–15:08 | `2147891541` | pnpm store 里的一个文件（3 次） |
| 2026-05-13 / 05-16 | `311972` | `<用户目录>\Downloads\STM32CubeProgrammer_104_274655.exe` |

均与本项目无关。

### 规避办法（需用户决定）

把 DSH 工作区与插件目录加进 Defender 排除项，可避免后续同类误报：

```
Add-MpPreference -ExclusionPath 'D:\DSH'
Add-MpPreference -ExclusionPath '<用户目录>\AppData\Local\npm-cache\_npx'
```

（上面的 `<用户目录>` 是占位符：实际执行时换成自己的家目录。这份文档进仓库，所以不写死
具体用户名 —— 那是这台机器的路径，不是这个项目的事实。）

副作用：这些目录不再被实时扫描。是否加由操作者决定，本文档只记录选项。

---

## 二、手机上传头像失败

### 症状链

```
手机点上传 → 界面报失败（无具体错误）
Caddy 日志  status=502  duration=0.103s  bytes_read=573439
容器日志    status=413 Payload Too Large  duration=0.093s
```

手机那次请求的实际参数（Caddy 日志逐字）：

```
POST /api/user/avatar
Content-Length: 7061836      ← 6.73 MB
Content-Type:   image/png
X-Api-Key:      <uid=1 admin token，有效>
User-Agent:     Dart/3.12 (dart:io)   ← Flutter 客户端
```

`bytes_read = 573439` = 约 560 KB —— 读到 560 KB 时被切断。这说明限制不是整数 MB 级别的
粗略判断，而是逐块读时超限即断。

### 根因

VoceChat 服务端源码 `src/config.rs` 的默认值：

```rust
const fn default_upload_avatar_limit() -> usize {
    1024 * 512          // = 524288 字节 = 512 KB
}
const fn default_send_image_limit() -> usize {
    1024 * 1024 * 2     // = 2 MB（聊天图片，不是头像）
}
```

来源：[vocechat-server-rust/config/config.toml](https://raw.githubusercontent.com/Privoce/vocechat-server-rust/master/config/config.toml)、
[src/config.rs](https://raw.githubusercontent.com/Privoce/vocechat-server-rust/master/src/config.rs)

**6.73 MB 是 512 KB 的 13 倍。** 被 413 拒绝，Caddy 因上游提前关闭连接返回 502，
Flutter 客户端把 502 报成通用失败，界面上看不到原因。

与网络、证书、端口、防火墙**无关**——同一个 token、同一条 TLS 连接，其他 API 全部 200。

### 修复

镜像内的 `config/config.toml` 原本没有外挂，改不了。做法：

**1. 导出并外置配置目录**

```
docker cp vocechat-personal-vocechat-1:/home/vocechat-server/config/. D:\DSH\vocechat\config
```

得到 `config.toml` + `config-tls.toml` + `templates/{login,register}_by_email.html`。

**2. 改 `[system]` 段**

```toml
[system]
data_dir = "./data"
token_expiry_seconds = 300
refresh_token_expiry_seconds = 864000000
# 头像上传上限（字节）。官方默认 1024*512 = 512 KB，手机照片通常 3–8 MB
upload_avatar_limit = 10485760      # 10 MB
# 聊天图片上限：默认 2 MB
send_image_limit = 20971520         # 20 MB
upload_timeout_seconds = 300
```

**3. compose 挂载（`D:\DSH\vocechat\compose.yaml`）**

```yaml
    volumes:
      - ./vocechat-data:/home/vocechat-server/data
      # config 目录挂载出来，才能改头像/图片上传上限
      - ./config:/home/vocechat-server/config
```

**4. 重建**

```
docker compose -f compose.yaml --env-file .env up -d
```

### 验证

| 项 | 结果 |
|---|---|
| compose 配置校验 | exit 0 |
| 容器状态 | Up (healthy) |
| 容器内读到新值 | `upload_avatar_limit = 10485760` ✅ |
| 启动日志 | `load configuration file. current_dir=/home/vocechat-server path=config/config.toml` ✅ |
| 数据完好 | `GET /api/bot` 200；频道 gid=1 `members=[1,2]` owner=1 ✅ |
| Caddy 是否另有 body 限制 | 无。`Caddyfile.prod` 未配 `request_body max_size`，默认不限 |

**最终验收必须由手机重传一次头像** —— 我这边没有有效的人类用户 token（Bot Key 在
`/api/user/avatar` 上是 401，管理员密码已由操作者改掉且未提供给我），所以无法端到端复现。
这是诚实的边界。

### 一个方法学教训

中途我用 `x-api-key: bogus` 去二分探测 413 阈值，得到的全是「客户端提前断连」，因为
**鉴权在 body 读取之前就返回了 401**，服务端根本不读 body。日志里那一串 401 就是证据。
真实阈值只能由「鉴权通过 + 大 body」触发，而这需要有效用户 token。

---

## 三、当前状态快照

```
VoceChat        0.5.40，容器 vocechat-personal-vocechat-1，Up (healthy)
监听            127.0.0.1:3009 → 容器 3000
配置            外挂 D:\DSH\vocechat\config（uid/gid 由容器 root 管理）
数据            D:\DSH\vocechat\vocechat-data
用户            uid=1 owner@tinydock.cc (admin) / uid=2 companion-a (bot)
频道            gid=1 companion-private, members=[1,2], owner=1
注册策略        InvitationOnly（实名关闭，需管理员建号）
SMTP            未配置（magic_link 按钮无效，密码登录正常）
公开入口        https://chat.tinydock.cc:8443（Caddy，证书至 2027-02-15）
```

---

## 四、回滚

| 改动 | 回滚 |
|---|---|
| compose 挂载 | 恢复 `compose.yaml.bak-before-config-mount-20261117`，`up -d` |
| config.toml | 恢复 `config\config.toml.bak-20261117`（容器内也留了一份 `.bak-20261117`） |
| 上限调整 | 删掉 `upload_avatar_limit` / `send_image_limit` 两行即回默认 |
