# 本机 VoceChat + 多 DSH Bot 部署计划

> 首次制定：2026-11-16，Asia/Shanghai；域名状态更新：2026-11-17。硬件与运行环境仍为 11 月 16 日快照。
> 本轮交付现状与实施计划：未安装或启动 VoceChat，未修改 DNS、路由器、防火墙及已有 DSH 配置。
> 文中不保存完整公网地址。实施时重新读取，不把地址片段直接用于解析。
> 后续补充：用户确认软路由为 192.168.100.1，并授权创建本地开发凭证；已生成专用 SSH 密钥，尚未登记到路由器或验证登录。
> 域名补充：用户确认已购买 tinydock.cc；权威 DNS 为 dns11.hichina.com / dns12.hichina.com；推荐入口为 chat.tinydock.cc，尚未写入解析。

## 1. 目标与已确认选择

用户已明确：在自己的 Windows 电脑搭建 VoceChat，公网 IPv6 已打通，域名 tinydock.cc 已购买，主要自己使用，计划接入多个 DSH Bot。

预期体验：推荐通过 https://chat.tinydock.cc 进入私人空间，与各 Bot 私聊，或在私人频道 @ 指定 Bot；每个 Bot 有独立身份、Key、人格与会话映射。子域名为本计划推荐值，当前尚未配置或上线。

分三个层次交付：

1. 基础服务：本机 VoceChat、持久化、域名、HTTPS、动态解析和备份。
2. 单 Bot：打通一个 DSH 角色，验证消息、身份、权限与错误处理。
3. 多 Bot：证明会话、记忆、工具及工作目录隔离，再增加附件与协作。

模型计费、主动发言、Bot 间自动协作分别控制，初始关闭。VoceChat 负责聊天，DSH 负责智能体运行，需要额外桥接。

## 2. 当前条件盘点

### 2.1 主机与软件

| 项目 | 本次实测 | 部署含义 |
|---|---|---|
| 系统 | Windows 11 专业版，64 位，Build 26200 | 复用 Docker Desktop + WSL2，入口可用 Windows Caddy |
| CPU | Ryzen 5 5600X，6 核 / 12 线程 | 适合聊天及远端模型 Bot；未评估本地模型推理 |
| 内存 | 约 15.9 GiB；后续采样空闲约 1.4 GiB | **当前余量偏小**，先释放内存，Bot 数量与并发分开规划 |
| 虚拟化 | 固件虚拟化开启，检测到 Hypervisor | 基础条件具备 |
| C 盘 | 总计 930.6 GiB，空闲约 64.3 GiB | 核对 Docker 虚拟磁盘位置，避免挤占系统盘 |
| D 盘 | 总计 447.1 GiB，空闲约 139.9 GiB | 建议运行目录 D:\DSH\vocechat |
| E / F 盘 | 空闲约 359.5 / 420.4 GiB | 可选择备份卷，尚未确认独立物理磁盘 |
| Docker Desktop | 已安装，程序 4.74.0.227015 | 优先复用，无需先重装 |
| Docker CLI / Compose | 29.4.3 / v5.1.3 | 命令存在不等于引擎可用 |
| Docker 引擎 | 无 Server 返回，默认管道不存在，context 为 default | **未就绪**；先启动 Desktop，核实 context 与 Linux 引擎 |
| Docker 服务 | com.docker.service 停止，手动启动 | WSL2 后端不能只据此判断可用性 |
| WSL | 2.6.3.0，内核 6.6.87.2-1 | 已有 WSL2，不默认重装发行版 |
| 发行版 | Ubuntu-24.04、docker-desktop，WSL2，当时均 Stopped | 本轮未启动或读取发行版业务数据 |
| Node.js | v24.14.0 | 支撑 DSH 与后续 Node 桥接 |
| DSH | 桌面程序 0.2.2.0，本地 runtime 0.2.2-rc.1 | 可复用基础，VoceChat 兼容性未实测 |
| DSH 配置 | 已有 companion profile 与独立 runtime 路径 | 不覆盖生产人格、记忆和配置 |
| Caddy / Nginx | PATH 未发现命令 | 其他路径与任务未全面盘点，安装前复核 |
| 电源 | 卓越性能；交流电闲置睡眠 0 秒，直流电 600 秒 | 插电不按此计时睡眠；重启、休眠、退出仍会断服 |

均为时点快照。未读取聊天原文、长期记忆、健康快照及媒体产物，未输出平台或模型密钥。

### 2.2 网络、域名与端口

| 项目 | 当前事实 | 待证明部分 |
|---|---|---|
| 网卡 | WLAN 3，Private 网络 | 无线长期稳定性；有条件可改有线 |
| 软路由 | 用户指定 192.168.100.1；HTTP 首页跳转 LuCI；TCP 22 响应 Dropbear SSH | 固件分支 / 版本、管理员账户、IPv6 规则及主机密钥待登录后核实 |
| 全局 IPv6 | 240e:338:a21:… 与 240e:338:a22:… 两组前缀 | 从外部直达的服务器地址策略 |
| 地址状态 | 部分旧地址 Deprecated，仍有短租期 Preferred 地址 | 不简单取第一个 Preferred 地址 |
| IPv6 路由 | 有 ::/0，Windows 显示 Internet 连通性 | 不等于公网 TCP 80 / 443 入站成功 |
| 防火墙 | 三种网络配置均启用 | 规则未逐条审计，只增加必要规则 |
| TCP 端口 | 80、443、3000、3009、3011、2019、2375、2376 未见监听 | 启动前重查，未查所有 UDP 或 HTTP.sys 预留 |
| 现有服务 | 多个 Node / QQ / Python 回环监听 | 不按进程名猜具体实例，不按端口盲停 |
| 域名 | 用户确认已购买 tinydock.cc | 推荐子域名 chat.tinydock.cc；AAAA、DDNS 和证书仍待配置 |
| 权威 DNS | 公共递归及权威查询确认 dns11.hichina.com / dns12.hichina.com | 阿里云 / 万网 DNS；控制台与 API 账户权限尚未验证 |
| 当前解析 | 查询未取得根域名及 chat.tinydock.cc 的 A/AAAA 地址；权威服务器明确返回 chat 无 AAAA | 根域名其他类型记录未全面审计，实施前重查 |
| 公网 IPv4 | 未验证 | 纯 AAAA 下 IPv4-only 网络无法直达 |

用户确认的“IPv6 已打通”作为已有条件；本次另确认全局地址与默认路由，尚未以 VoceChat / Caddy 从外部验证入站。

**关键前置项：释放内存、恢复 Docker 引擎、确定服务器 IPv6，并为 chat.tinydock.cc 建立动态 AAAA 更新。域名购买与 DNS 委派已具备。**

### 2.3 DSH 接入现状

- 本仓库有 QQ 等通道，本次源码、模板、文档检索未发现 VoceChat 通道。
- 既有文档包含宿主创建会话、提交提示、读取结果的记录，只能作为核对线索，不能视为当前稳定公开合同。
- VoceChat 官方有 Bot 用户、独立 API Key 与收消息的 Webhook。[S3]
- 聊天服务和多个 DSH Bot 分阶段交付；后者需要开发桥接、路由及隔离。

### 2.4 软路由开发凭证补充

用户授权创建本地开发凭证后，已生成独立 Ed25519 密钥，用途标记为 vocechat-router-dev-20261116，未复用已有个人 SSH 密钥。

- 保存目录：本仓库 data/local-credentials/router-192.168.100.1/。
- id_ed25519 为私钥，id_ed25519.pub 为待登记公钥，credential.local.json 记录本地状态，README.md 说明登记、核验和撤销。
- 整个目录受 Git 忽略；访问权限关闭继承，仅允许当前 Windows 用户和 LocalSystem。
- 为本机自动化创建无交互口令密钥，以 Windows ACL 保护；不能把文件拷入同步目录或提交 Git。
- 当前状态：**本地已创建 / 路由器未授权 / SSH 登录未测试**。没有修改管理员密码，也未添加防火墙、DNS、路由或公网管理规则。
- SSH 的连接目标为 192.168.100.1:22；账户名尚未确认，不假定具备 root 或只读权限。给 root 登记普通公钥通常会授予管理员能力，专用密钥不自动等于受限权限。
- 登记前确认账户和权限范围；优先核实受限账户 / 命令授权，开发结束后撤销该公钥。核对路由器主机密钥指纹，使用项目专用 known_hosts，不关闭主机验证。
- 本次仅观察到 LuCI / Dropbear，不能据此确定 OpenWrt、ImmortalWrt 或 iStoreOS 的具体分支及版本。

凭证登记与测试独立于 VoceChat 上线。浏览器打开管理页的自动权限审批超时，未完成登录状态检查；现有只读 HTTP / SSH 识别结果不等于凭证登录成功。

## 3. 推荐架构

采用 **Windows 原生 Caddy + Docker VoceChat + 内部桥接 + 现有 Windows DSH**。

~~~mermaid
flowchart TD
    U[浏览器或手机<br/>客户端支持 IPv6] --> N[chat.tinydock.cc<br/>DDNS 维护 AAAA]
    N --> R[家庭路由器 IPv6 入站规则]
    R --> C[Windows Caddy<br/>TCP 80 / 443]
    C -->|回环 HTTP| V[Docker VoceChat<br/>主机仅发布 127.0.0.1:3009]
    V -->|内部 Webhook| B[dsh-bridge<br/>各 Bot 独立路由与队列]
    B -->|内部 Bot API 回写| V
    B --> H[受控 DSH 接口或连接器]
    H --> A[Bot A<br/>独立人格与会话]
    H --> E[Bot B<br/>独立人格与会话]
    D[Windows DDNS 任务] --> N
~~~

- Caddy 使用 Windows 公网 IPv6，负责证书和反代。
- VoceChat 使用官方 Linux/amd64 镜像，保存账号、消息和附件。[S1]
- dsh-bridge 是后续开发项，建议以 Node 容器加入同一 Compose 网络，Webhook 不经过公网。
- DSH 保留在 Windows，优先复用宿主；角色的数据及权限各自配置。
- DDNS 从 Windows 物理网卡读取地址，排除 Docker / WSL 虚拟网卡。

公网在 Windows 终止，后端经 IPv4 回环代理，可避免先处理容器公网 IPv6 / WSL 入站路由。Docker Desktop 发布端口由后端转发，仍需验证绑定范围。[S6]

### 3.1 地址与端口

| 用途 | 建议地址 | 范围 |
|---|---|---|
| 正式聊天 | https://chat.tinydock.cc:443 | 规划值；上线后公网访问，应用层需登录 |
| HTTP / ACME | TCP 80 | 公网跳转 / 证书验证 |
| VoceChat | 127.0.0.1:3009 → 容器 3000 | Windows 本机 |
| Caddy 管理 | 默认本机 2019，运行后复核 | 本机，不反代公网 |
| Webhook | http://dsh-bridge:3011/hooks/BOT_ID/SECRET，替换为真实路由 | Compose 网络 |
| 桥接健康 | 可选 127.0.0.1:3011 发布 | 本机，限制可用路由 |
| DSH 接口 / 连接器 | G4 分配并验证 | 本机及必需的 Docker 路径 |
| Docker API | 既有本机管道 | 不新增无认证 TCP 2375 |

容器内 127.0.0.1 指容器自己。Webhook 用服务名；容器访问 Windows 可评估 host.docker.internal，但不能假定能访问所有仅绑定 Windows 回环的 DSH 服务。

路径不通时增加受限本机连接器，只转发所需操作，并按实际来源和防火墙限制访问；不直接放宽生产 DSH 监听或向公网开放管理 / 任意工具接口。G4 先验证网络再调模型。

### 3.2 目录

~~~text
D:\DSH\vocechat\
  compose.yaml
  .env                         # 固定镜像摘要及参数
  .gitignore                   # 排除数据、状态、密钥、证书和日志
  vocechat-data\               # 挂载 /home/vocechat-server/data
  caddy\
    bin\caddy.exe
    Caddyfile
    state\                     # 证书 / ACME 状态
    logs\
  bridge\                      # 后续桥接源码
  bridge-state\                # 会话、幂等、发件状态
  secrets\                     # Key、Webhook 令牌、DSH 凭据
  scripts\                     # 诊断、启停、备份、恢复、DDNS
  evidence\                    # 脱敏证据，不含聊天原文
D:\DSH\vocechat-backups\        # 第一份本机一致性备份
~~~

本轮只创建本文，运行目录尚未创建。独立备份设备后选，同机分区不能替代独立设备备份。

## 4. 分阶段实施

各阶段记录时间、命令、脱敏结果，依赖的出口条件未满足，不进入后续正式运行。

### G0：补齐参数与边界

1. 域名 tinydock.cc 已购妥，推荐 chat 子域名，权威 DNS 已确认为 dns11.hichina.com / dns12.hichina.com；接下来确认阿里云 DNS API 凭据或手动初始解析方式。软路由为 192.168.100.1，本地开发密钥已生成，先登记公钥、核对主机指纹并做只读登录测试。
2. 实际配置前询问是否有旧 VoceChat 数据，是否复用 DSH / AstrBot 人格、记忆或聊天。按自配置技能确认迁移范围，先备份、检查格式与身份、准备预览；无需求则独立新建。
3. 列出首批 Bot 名称、职责、人格、已有模型路由及工具权限；凭据只在本机配置。
4. 区分多个 Bot 身份 / 预设与多个宿主进程。先两个身份验收，不默认每个 Bot 启一个完整宿主。
5. 盘点旧容器、数据及虚拟磁盘。引擎未运行不等于没有旧资产。
6. 实测常用流量 / 外部 Wi-Fi 的 IPv6，决定是否需 IPv4 兼容。
7. 先释放内存，建议试运行前空闲约 4 GiB；这是初始运维目标，非官方最低要求。

**出口**：域名与委派已有证据，可按顺序进入 G1；G2 前需确定目标 IPv6 和 DNS 更新权限；实际接入前明确迁移和身份边界。

### G1：复用 Docker，部署本机服务

1. 启动已有 Docker Desktop，使用 Linux 容器，不先重装 Docker / Ubuntu。
2. 核对 context，指向实际 Desktop 引擎，不另起第二套 dockerd。
3. 查看磁盘位置；若迁 D 盘，先盘点备份，用 Desktop 支持流程迁移。
4. 初始可考虑 VM 约 3 GiB 内存、2 CPU，按版本支持和监测调整；修改 .wslconfig 可能影响其他 WSL 负载，先核对。
5. 查询官方版本和发布说明，拉候选镜像，记录真实版本、架构、digest；正式固定 digest。
6. 创建独立目录与持久化挂载，仅发布 127.0.0.1:3009。
7. 本机初始化首个管理员，邀请注册、Guest 关闭、频道私有后再开公网。[S9]
8. 重建容器，确认账号、频道和附件保留，挂载问题先修复。

~~~powershell
docker context ls
docker version
docker info --format '{{.OSType}}/{{.Architecture}}'
docker compose version
wsl --list --verbose
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in @(80,443,3009,3011,2019) }
~~~

Compose 模板，尚未创建或实测；镜像摘要必须替换为真实值：

~~~yaml
name: vocechat-personal
services:
  vocechat:
    image: privoce/vocechat-server@sha256:REPLACE_WITH_VERIFIED_DIGEST
    platform: linux/amd64
    restart: unless-stopped
    ports:
      - "127.0.0.1:3009:3000"
    volumes:
      - ./vocechat-data:/home/vocechat-server/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - vocechat-internal
networks:
  vocechat-internal:
    driver: bridge
~~~

先以 docker compose config --quiet 校验再启动。网络名表示内部服务互联，未设 internal: true，以免阻断所需出站。

**出口**：Client / Server 正常，Linux 引擎，本机可登录，数据重建后保留，3009 不向所有网卡发布。

### G2：服务器 IPv6、域名与 DDNS

域名参数已经确定：主域名 tinydock.cc；权威服务器 dns11.hichina.com 与 dns12.hichina.com；推荐记录名 chat，完整入口 https://chat.tinydock.cc。无需为了本项目更换现有 NS，根域名可保留给今后其他用途。

地址选择：仅物理联网网卡的全局单播，排除链路本地、ULA、回环和虚拟网卡；排除 Invalid / Tentative / Duplicate / Deprecated，检查生命周期。

不只凭 SuffixOrigin、列表顺序、短地址或 Preferred 标签选择；结合地址类型、路由器当前前缀与多次观测。不要为服务全局关闭隐私地址，先确定可验证的服务器地址策略。

1. 为 chat.tinydock.cc 初期仅建 AAAA 直解析，有实际公网 IPv4 才加 A；TTL 建议 300 秒，按阿里云当前版本允许值调整。
2. DDNS 每 5 分钟及网络恢复时检查，仅变化时更新。
3. 阿里云 DNS API 使用独立 RAM 身份 / 受限凭据，按平台实际支持的粒度限制到 tinydock.cc 和必需操作；更新器自身再限定 chat、AAAA 和记录 ID。不可把程序的记录限制描述成平台级逐记录授权。密钥只在本机保存，不使用主账号全权限 Key。
4. 无合适地址时不写空、不随机选择；记录失败提示处理。
5. 更新后查权威与公共递归解析，留脱敏变化证据，接受 TTL 级切换窗口。
6. 路由器规则同步跟随主机地址 / 稳定接口标识；DDNS 不能修复旧前缀规则。

~~~powershell
Get-NetIPAddress -InterfaceAlias 'WLAN 3' -AddressFamily IPv6 |
  Select-Object IPAddress,AddressState,PrefixOrigin,SuffixOrigin,PreferredLifetime,ValidLifetime
Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0'
# 记录建立前可能无 AAAA 响应
Resolve-DnsName -Name 'chat.tinydock.cc' -Type AAAA
Resolve-DnsName -Name 'chat.tinydock.cc' -Type AAAA -Server 'dns11.hichina.com'
~~~

计划添加的解析：

| 参数 | 计划值 |
|---|---|
| 主域名 | tinydock.cc |
| 主机记录 | chat |
| 类型 | AAAA |
| 线路 | 默认 |
| 记录值 | 经确认可外部入站的本机全局 IPv6，不能填软路由管理地址或未经核实的 WAN6 地址 |
| TTL | 优先 300 秒，平台不支持时采用允许值 |
| A / URL 转发 | 当前不创建 |

DDNS 建议先在控制台建立这唯一一条记录，保存记录 ID，再由本机任务调用 DescribeDomainRecords / DescribeDomainRecordInfo 核对并使用 UpdateDomainRecord 更新。只有明确允许程序首次建记录时才授予 AddDomainRecord；不默认授予删除、改 NS 等操作。[S11]

路由器 SSH 密钥与阿里云 DNS API 凭据是两种独立授权。已生成的本地 SSH Key 不能代替 DNS AccessKey。实际配置时将 DNS 凭据保存到受 ACL 保护、Git 忽略的单独文件，文档及日志只保留配置状态，不保存密钥正文。

公网 IPv6 通常做路由器入站防火墙放行，不照搬 IPv4 NAT 映射。只放到该电脑 TCP 80 / 443，保留必要 ICMPv6，不关闭整套防火墙。

本机软路由管理入口为 http://192.168.100.1/cgi-bin/luci/。待验证开发凭证后，先只读核对当前 WAN6 委派、LAN 前缀、目标电脑 IPv6、现有规则及 DDNS 能力。只导出本项目所需的脱敏摘要，不整包读取带凭据的路由器备份；不能为 VoceChat 把路由器自身 LuCI / SSH 开到公网。

**出口**：外部网络证明目标地址可达，AAAA 一致；实际变化或安全解析更新演练通过，两种证据分开记录。

### G3：Caddy 与外网 HTTPS

1. 复核既有入口、Caddy 进程 / 服务 / 任务，有则评估复用。
2. 核验官方 Windows amd64 Caddy，固定版本。
3. 固定身份和证书状态目录，可明确服务的 XDG_DATA_HOME / XDG_CONFIG_HOME，避免交互与服务两套证书。
4. 代理完整站点和 /api，保留流式事件，不缓存消息 API。
5. 校验配置，VoceChat 就绪后启动 Caddy。
6. Windows 只增加限定程序、TCP 80 / 443、实际网卡和网络类别的规则，记录名称以便回滚。
7. 路由器放行目标电脑，外部 IPv6 测试并观察签证书。
8. VoceChat 设置最终 HTTPS 前端 URL，检查邀请链接。[S8]

~~~caddyfile
chat.tinydock.cc {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3009
}
~~~

~~~powershell
# 未来在 Caddy 目录执行
.\bin\caddy.exe validate --config .\Caddyfile --adapter caddyfile
# 不同网络、支持 IPv6 的另一台电脑执行
curl.exe --noproxy '*' -6 -I 'https://chat.tinydock.cc/'
~~~

Caddy 自动证书要求 DNS、监听和对应 ACME 验证链路可达。[S5] 仅 AAAA 可以验证，但 CA 必须经 IPv6 访问当前地址，不添加不可达 A。

若运营商限制 80 / 443，可评估 DNS-01 与其他服务端口。DNS-01 仅解决证书，不使封锁端口可达，还需要 DNS provider 模块和凭据。

手机关闭家庭 Wi-Fi 实测；ping、本机和同一 LAN 成功都不替代外网验收。

**出口**：外网 HTTPS 证书正常，双客户端登录收发、刷新及断线恢复通过，匿名看不到私人内容。

### G4：一个 DSH Bot 闭环

先核对 0.2.2-rc.1 实际合同：鉴权、建会话、提交提示、最终回复、取消、超时及错误。旧文档中的 /api/session/create、/api/session/prompt、session/projections 仅作起点。

优先受支持通道 / RPC；采用 Web UI API 则封装版本适配层。先模拟后端，再真实宿主；真实模型和发送在用户明确启用 Bot 后执行。容器到 Windows 网络与鉴权先验证，必要时受限连接器。

桥接开发：

1. 创建 Bot A，独立 API Key、Webhook 令牌，本机存储。
2. 专属路由满足 GET 200、POST 接收的官方要求。[S3]
3. 桥接加入 Compose 网络，收发走内部地址。
4. 校验令牌、结构、长度、主人 UID 和频道；已接受事件先持久化，快速返回后排队处理。
5. 单会话串行，全局模型并发先 1，超时 / 取消明确记录。
6. 初版最终文字 / Markdown；编辑、删除不误当新问题，附件先不支持。
7. 记录发送状态与平台消息 ID，日志仅留必要 ID、状态、耗时。
8. 人格、记忆作用域、工作目录和工具最小授权独立配置。

| 行为 | 官方接口 / 要求，仍需对照部署版本 |
|---|---|
| 私聊 | POST /api/bot/send_to_user/{uid} |
| 频道 | POST /api/bot/send_to_group/{gid}，Bot 先入频道 |
| 鉴权 | x-api-key，每 Bot 独立 |
| 格式 | text/plain / text/markdown |
| 事件 | mid、from_uid、target 和细节，核对实际字段 |

官方文档未为本方案证明重试、签名、离线补投。核实实际版本，不承诺桥接停机零丢失。

**出口**：主人消息只触发目标会话和 Bot A；其他 UID、重复事件和 Bot 回声不触发新模型调用，错误可定位。

### G5：多个 Bot 与隔离

| 配置 | Bot A | Bot B |
|---|---|---|
| botId | companion-a | assistant-b |
| UID / API Key / Webhook 令牌 | A 专用 | B 专用 |
| DSH 预设 / profile | A 明确路由 | B 明确路由 |
| 人格、记忆、工作目录、工具 | A 独立作用域 | B 独立作用域 |
| 私聊映射 | A + 主人 UID | B + 主人 UID |

多个预设可评估共用宿主，但 **profile、预设、会话分开不自动等于记忆、文件、全局工具隔离**。检查数据根、personaId、身份绑定、工具注册作用域；无法证明隔离则独立 home、工作目录及数据根，并重算资源。

~~~text
BotRoute:
  botId, voceBotUid, secretRef, allowedOwnerUids, allowedChannelIds,
  dshEndpointRef, dshPreset, personaScope, toolPolicy, enabled
ConversationKey:
  serverId + botId + conversationKind(dm/channel) + conversationId
  # 多用户频道如需个人上下文，明确是否加入 senderUid。
InboundEvent:
  serverId, botId, mid, eventType, senderUid, target, occurredAt
DedupeKey:
  serverId + botId + mid + eventType
~~~

- 主人 UID 触发；身份按服务器事件和本地绑定，不采信文本自报身份。
- 私聊按目标 Bot；频道明确 @ 才触发，不广播给全部 Bot 调模型。
- 已知 Bot UID 的消息默认忽略；协作单独设置轮数、预算和停止条件。
- 幂等跨重启，区分新建、编辑、删除、回复。
- 发送超时但结果未知，不无限重发；先核对送达，不能确认则留未知状态。
- 单会话有序，并发先 1，稳定后试 2；各 Bot 可独立关闭。
- 重置只清目标映射，不清其他角色记忆。
- 附件后续经鉴权资源接口，限制类型大小，不自动抓取任意文本 URL。

**出口**：至少两 Bot 私聊与频道 @ 通过；人格、历史、记忆、工作目录和权限无串用，重复及重启不循环。

### G6：长驻与恢复

1. 验证阶段用命名持久终端，确认就绪；正式运行落实固定身份、日志及故障恢复。
2. Desktop 随登录启动；容器 restart 仅引擎运行后生效。
3. 第一期按“重启后登录恢复”。需无人登录恢复时另验支持方案，必要时评估 Linux VM / 独立机，不把开机选项当已验证。
4. Caddy 用官方 Windows 服务方式或受控任务，固定状态目录。[S5]
5. 桥接恢复幂等及映射，DSH 就绪后接受模型任务。
6. 日志轮转、容量和内存检查；健康探测不调模型、不发消息。
7. 一次停服备份及隔离恢复通过后，再做周期备份。

## 5. 备份、升级与回滚

备份完整 vocechat-data，官方要求停服复制。[S4] 同时备份 Compose、Caddyfile、digest、Caddy 状态、桥接映射 / 幂等 / 发件状态。凭据单独加密，DSH 资料按授权范围独立备份。

建议每日一次短停备份，保留 7 份日备份和 4 份周备份，升级前额外备份。时间与独立设备后定，本轮不创建定时任务。

流程：暂停桥接新任务 → 等待在途结束或明确待处理 → 停桥接写入 → 停 VoceChat → 复制到新时间戳目录并校验 → 启 VoceChat → 就绪后启桥接。投递结果未知单独记录。

升级前查发布说明、固定新旧 digest，用数据副本隔离测试，不让两个实例写生产挂载。涉及数据库迁移后回滚，恢复旧镜像与匹配旧数据，不只切旧镜像强读新格式。

桥接回滚保留兼容去重及发件状态；停公网只撤本项目规则、DNS 和服务，不影响既有 DSH / QQ。不以删除数据卷、清空目录或覆盖人格作为默认修复。

## 6. 验收矩阵

环境快照以外，下列目前均为“未实施 / 未验证”。

| 编号 | 检查 | 通过标准 | 阶段 |
|---|---|---|---|
| V01 | Docker | Client / Server 正常，Linux/amd64，旧资产已盘点 | G1 |
| V02 | 本机 | 可登录，3009 仅回环 | G1 |
| V03 | 持久化 | 重建后账号、频道、附件保留 | G1 |
| V04 | 隐私 | 邀请注册、Guest 关闭、匿名不能读私人内容 | G1 / G3 |
| V05 | 域名 | AAAA 对应核实的当前服务器地址 | G2 |
| V06 | DDNS | 更新演练通过，真实换前缀证据另记 | G2 |
| V07 | 外网 | 不同网络 IPv6 HTTPS，无证书错误 | G3 |
| V08 | 长连接 | 双端收发、刷新、断线重连正常 | G3 |
| V09 | 边界 | DSH、Webhook、管理口、Docker API 不被公网转发 | G3 / G4 |
| V10 | 单 Bot | 主人 → 目标会话 → 对应 Bot，有消息 ID | G4 |
| V11 | 幂等 | 不重复调用、不循环互答 | G4 / G5 |
| V12 | 隔离 | 人格、会话、记忆、工具、目录无串用 | G5 |
| V13 | 故障 | 各服务单独重启可恢复，结果未知不盲重发 | G5 / G6 |
| V14 | 重启 | 登录后恢复；无人登录恢复另记 | G6 |
| V15 | 恢复 | 隔离恢复后账号、附件、映射正常 | G6 |
| V16 | 稳定性 | 至少 24 小时，无持续内存增长、低空间、模型循环 | G6 |
| V17 | 手机 | 常用移动网络可用，推送与聊天分开记录 | G3 / G6 |

状态用“未配置 / 已保存未测试 / 测试成功 / 测试失败 / 功能关闭”。本机 HTTP、公网 HTTPS、真实宿主、真实模型和真实发送各自记证据，不能替代。

## 7. 限制与应对

| 条件 | 影响及处理 |
|---|---|
| 域名已购，业务解析未建 | 保留现有 NS，确认本机服务和 IPv6 后添加 chat AAAA，再验证 HTTPS |
| 空闲 1.4 GiB | 释放内存、限制 VM 及并发，实测决定宿主数 |
| 前缀变化 | DDNS、地址筛选、规则跟随、外部验证同时做 |
| IPv4-only 网络 | 无法纯 AAAA 直连；必要时评估隧道、双栈 VPS、私有组网 |
| 隧道 / CDN | 增加第三方数据路径；不默认开启，验证流式与附件限制，API 不缓存 |
| 无现成通道 | G4 开发桥接及适配层，服务上线不等于 Bot 可用 |
| 停机 / 未知投递 | 持久队列与状态追踪，核实重试合同，不承诺零丢失 |
| Windows 重启 | 明确登录依赖并实测 |
| 手机推送 | FAQ 提及 Firebase 依赖，聊天与后台推送分别验收 [S8] |
| 免费档 | 官方不超过 20 成员，Bot 是否计数按版本核对，不自动购买许可 [S8] |

## 8. 工作量和执行顺序

估计不含 DNS 缓存生效、网络故障和观察时间，不是完成承诺；域名购买等待已结束。

| 阶段 | 预计投入 | 交付 |
|---|---|---|
| G0 / G1 | 1—3 小时 | Docker、本机服务、持久化 |
| G2 / G3 | 1—4 小时 | AAAA / DDNS、Caddy、HTTPS |
| G4 | 1—3 工作日 | 宿主合同、单 Bot、幂等错误处理 |
| G5 | 1—2 工作日 | 至少两 Bot、路由及隔离 |
| G6 | 2—4 小时 + 至少 24 小时观察 | 重启恢复、备份演练、运维 |

顺序：**释放内存 → 既有 Docker → 本机 VoceChat → 管理员和隐私 → 域名 / DDNS → Caddy HTTPS → 单 Bot → 多 Bot → 恢复和长期观察。**

域名已就绪，可以按 G1 → G2 → G3 推进；Docker、持久化、桥接设计和模拟合同不依赖 DNS API 凭据。

## 9. 实施前待补参数

| 信息 | 当前处理 |
|---|---|
| 域名、chat 子域名 | 已购买 tinydock.cc；推荐 chat.tinydock.cc，未写入解析 |
| DNS 托管商、DDNS | dns11.hichina.com / dns12.hichina.com 已核实；阿里云 API / RAM 凭据与记录 ID 待配置 |
| 路由器及 IPv6 规则入口 | 已确认 192.168.100.1，LuCI / Dropbear 可识别；固件版本和具体规则入口待鉴权核实 |
| 路由器开发凭证 | 本地 Ed25519 已创建且 Git 忽略，公钥未登记、主机指纹未核验、登录未测试 |
| 首批 Bot 数量 / 名称 / 职责 | 建议先两个身份，用户指定 |
| 复用 / 迁移 DSH 资料 | 配置前确认，不直接读私密数据 |
| 模型路由、成本上限 | 复用授权服务，真实调用前明确 |
| 无人登录恢复要求 | 第一期按登录后恢复 |
| 常用网络 IPv6 | 手机 / 外部 Wi-Fi 实测 |
| 独立备份设备 / 时间 | 待选 |

## 10. 依据与边界

本机只读核查用 CIM、程序版本、Docker / WSL 状态、网络地址路由、防火墙配置、监听端口和 powercfg；仅从 suite 提取 DSH 路径与 profile，并核对 runtime 软件版本。受限环境无法查 CIM / 网络后，以只读系统查询取得证据，未把权限不足当“未安装”。

仓库约束：[AGENTS.md](../AGENTS.md)、[DSH 自配置技能](../skills/companion-setup/SKILL.md)、[部署](01-deployment.md)、[模块矩阵](03-modules-support-matrix.md)、[验证状态](07-verification-status.md)。

本轮是 VoceChat 计划，不是重新部署 Companion，未运行会安装、构建、初始化或重启生产的 npm 部署链。后续调整 Companion 仍按仓库顺序和备份规则。

官方资料，2026-11-16 查阅：

- **[S1]** [VoceChat Docker](https://doc.voce.chat/install/docker)：镜像、架构、数据目录。
- **[S2]** [VoceChat + Caddy](https://doc.voce.chat/install/docker-caddy)：反代路径；页面以 Linux 为主，本计划改用 Windows 入口。
- **[S3]** [Bot and Webhook](https://doc.voce.chat/bot/bot-and-webhook)：身份、Key、发送、事件。
- **[S4]** [备份迁移](https://doc.voce.chat/setting/backup-migration)：停服复制完整数据。
- **[S5]** [Caddy HTTPS](https://caddyserver.com/docs/automatic-https)、[反向代理](https://caddyserver.com/docs/quick-starts/reverse-proxy)、[长期运行 / Windows 服务](https://caddyserver.com/docs/running)。
- **[S6]** [Docker Desktop 网络](https://docs.docker.com/desktop/features/networking/)。
- **[S7]** [Windows Docker 要求](https://docs.docker.com/desktop/setup/install/windows-install/)：核对环境，不据此默认重装。
- **[S8]** [VoceChat FAQ](https://doc.voce.chat/faq)：免费档、前端 URL、推送及 API 缓存。
- **[S9]** [注册 / 游客控制](https://doc.voce.chat/setting/server-access-control)。
- **[S10]** [OpenWrt Dropbear 公钥认证](https://openwrt.org/docs/guide-user/security/dropbear.public-key.auth)：LuCI 登记公钥入口的参考；实际固件与账户权限仍需核对。
- **[S11]** [阿里云 DNS 记录查询](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-describedomainrecords)、[更新解析记录](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-updatedomainrecord)：DDNS 操作与实际授权粒度的依据；本轮未调用写入 API。

镜像版本、宿主 API、DNS 模块及许可细节在实施当天复核。本文不把官方示例等同于本机验证成功。
