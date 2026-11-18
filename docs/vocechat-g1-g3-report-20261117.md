# VoceChat G1–G3 实施与证据报告

> 生成时间：2026-11-17 01:06，Asia/Shanghai
> 对应主计划：[本机 VoceChat + 多 DSH Bot 部署计划](vocechat-local-deployment-plan-20261116.md)
> 本轮范围：**G1（Docker + 本机服务 + 持久化）→ G2（IPv6 地址策略 + DDNS 准备）→ G3（Caddy + TLS 反代 + 本机验收）**
> 未做：G4 桥接开发、G5 多 Bot 隔离、G6 长驻与恢复演练。未修改任何既有 DSH / QQ / AstrBot 配置。

---

## 1. 结论速览

| 阶段 | 状态 | 出口条件 |
|---|---|---|
| G1 本机服务 | **完成（8/8 项）** | Client/Server 正常、Linux 引擎、本机可登录、重建后数据保留、3009 仅回环 —— 全部实测通过 |
| G2 域名 / DDNS | **部分完成（脚本就位，写入未执行）** | 地址策略与 DDNS 更新器已落地并演练；**AAAA 记录未建、路由器放行未做**，卡在两处外部授权 |
| G3 Caddy / HTTPS | **部分完成（反代链路实测通过，公网未开）** | Caddy 固定版本、配置校验、TLS 反代、SSE 透传、经 TLS 写入全部通过；**公网 HTTPS 未上线**，卡在 G2 |

**未通过的两项，都是缺外部凭据而非技术未做**：`V05` AAAA 记录不存在、`V06` DDNS 未配置。

---

## 2. 环境变化（相对主计划 2026-11-16 快照）

| 项目 | 快照（11-16） | 本轮实测（11-17 01:00） | 影响 |
|---|---|---|---|
| Docker 引擎 | 无 Server 返回，管道不存在 | **已就绪**：Server 29.4.3，`linux/amd64`，driver `overlayfs` | G1 前提满足 |
| Docker context | 仅 default | **desktop-linux 为当前 contextual，指向 `dockerDesktopLinuxEngine`** | 未另起 dockerd |
| 旧容器资产 | 未盘点 | 已盘点：`searxng` 运行中；镜像 `soulter/astrbot`、`mlikiowa/napcat-docker`、`searxng`；2 个匿名卷 | 未触碰、未删除 |
| 宿主空闲内存 | 约 1.4 GiB | **0.2 GiB**（vmmemWSL 约 1.9 GB） | **告急**，见 §6 |
| C / D 盘空闲 | 64.3 / 139.9 GiB | 59.9 / 139.8 GiB | C 盘 `docker_data.vhdx` 6.77 GB |
| 80 / 443 | 未监听 | 本轮结束时仍未监听（仅 Caddy 本机 8090/8443 测试实例） | 公网未开 |
| 全局 IPv6 | 两组前缀 | `240e:338:a21:b2e0/64` 与 `fd98:adf9:169e:0/64`(ULA) | ULA 不可作公网目标 |
| chat.tinydock.cc | 权威明确返回无 AAAA | **公共 DoH 实测 rcode=3（NXDOMAIN）** | AAAA 未建 |

---

## 3. G1：Docker 与本机 VoceChat

### 3.1 实际执行

1. 启动既有 Docker Desktop（未重装），等待 Linux 引擎就绪，确认 `docker context` 指向 Desktop 引擎。
2. 拉取官方镜像并**按 digest 固定**：
   ```
   privoce/vocechat-server@sha256:7ea02d9c77bd06917b069723bbecb8dfc21c7f46f1a50dbe81f7d9f27914fa1a
   arch=amd64  os=linux  created=2026-11-09T08:44:17Z  size≈25.7 MB
   ```
3. 创建运行目录 `D:\DSH\vocechat\`（`vocechat-data` / `caddy` / `bridge` / `bridge-state` / `secrets` / `scripts` / `evidence`），整目录受 `.gitignore` 排除。
4. `compose.yaml`：仅发布 `127.0.0.1:3009:3000`，挂载 `./vocechat-data`，`restart: unless-stopped`，日志 10m×3，私有 bridge 网络。
5. `docker compose config --quiet` 校验通过后启动。
6. 首次启动时**误用未初始化实例**（详见 §5.1），已隔离该数据目录并重建干净实例。
7. 通过 `/api/admin/system/create_admin` 建立首个管理员（`is_admin:true`，uid=1），凭据写入 `secrets/owner-credential.json`（ACL 仅当前用户 + SYSTEM）。
8. 收紧访问控制：`login/config` → `guest:false`、`who_can_sign_up:"InvitationOnly"`。
9. 建私有频道 `companion-private`（`is_public:false`，成员仅 owner）。
10. 上传探针文件（39 B，`text/plain`）验证附件落盘。
11. **重建容器 3 次**，每次核验账号、频道、上传文件、隐私配置、`server_id` 是否保留。
12. 设置 `frontend_url = https://chat.tinydock.cc`（G3 用）。

### 3.2 持久化证据（三次重建均一致）

| 重建 | 账号 | 频道 | 上传文件 | 隐私配置 | frontend_url |
|---|---|---|---|---|---|
| #1 `down` + 新数据目录 | uid=1 admin=True | 保留 | 保留 | 保留 | — |
| #2 `--force-recreate` | uid=1 admin=True | 保留 | 保留 | 保留 | 保留 |
| #3 修正健康检查后重建 | uid=1 admin=True，`server_id` 不变 | `channels=1` | `files=2`（`.meta` 同步） | 保留 | 保留 |

### 3.3 端口与边界

- `3009` 监听地址实测**仅 `127.0.0.1`**，`docker port` 输出 `3000/tcp -> 127.0.0.1:3009`。
- 匿名访问：`/api/group` 401、`/api/admin/user` 401、`/api/user/1/history` 401；匿名注册 403；`/api/token/login_guest` 405。
- 仅 `/api/admin/system/common`、`/api/admin/login/config`、`/api/admin/system/version` 匿名可读（VoceChat 设计如此，无敏感内容）。

### 3.4 健康检查修正（重要）

初始 `healthcheck` 探 `/healthz`，实测该路径 **404**，容器长期 `unhealthy`。已改为探 `/api/admin/system/version`（无需鉴权、返回 `0.5.40`），重建后稳定 `healthy`。

---

## 4. G2：IPv6 地址策略与 DDNS

### 4.1 地址策略（已落地为脚本，可重复）

`scripts/address-policy.ps1` 的规则与本次输出：

- 排除：链路本地 `fe80`、ULA `fc`/`fd`、回环、组播、虚拟网卡（vEthernet / WSL / Docker / Hyper-V / Teredo / ISATAP / VPN / Tailscale / WireGuard）。
- 排除状态：`Invalid` / `Tentative` / `Duplicate`；`Deprecated` 降为后备。
- 稳定性排序：`SuffixOrigin=Link` > `Dhcp` > `Random`；同序内 `Preferred` 优先。
- 只选与默认 IPv6 路由同网卡的地址。

本次候选与选定（`evidence/ipv6-address-policy.json`）：

| 地址 | 后缀来源 | 状态 | Preferred 生命周期 | 判定 |
|---|---|---|---|---|
| `240e:338:a21:b2e0:14d0:85ba:a56a:1cd1` | Link | Preferred | 00:41:50 | **选定**：同 MAC 稳定，前缀随 RA 变化 |
| `240e:338:a21:b2e0::7b2` | Dhcp | Preferred | 00:26:22 | 后备：租期短，单独使用会导致 AAAA 频繁变化 |
| `240e:338:a21:b2e0:4df:bfdd:41d1:9624` | Random | Preferred | 00:41:50 | 后备：隐私地址可能轮换 |

**结论**：选定 Link 后缀地址作为 AAAA 目标；前缀 `240e:338:a21:b2e0` 由路由器 RA 下发，**RA 生命周期仅约 40 分钟**，说明前缀本身会周期性变化 —— DDNS 必须每 5 分钟跑，不能只建一次记录。

### 4.2 DDNS 更新器（已落地，演练模式）

`scripts/ddns-update.ps1` 的授权边界：

- 只调用 `DescribeDomainRecordInfo`（核对）与 `UpdateDomainRecord`（更新）；
- **不调用** `AddDomainRecord` / `DeleteDomainRecord` / 改 NS；
- 记录名与类型硬编码校验为 `chat` / `AAAA`，配置不符即中止；
- 无合格 IPv6 时**不写空、不随机选择**，退出码 3；
- 默认演练（不写），`-Apply` 才真正调用；
- 写入后落证据 `evidence/ddns-update-*.json` 与状态 `bridge-state/ddns-state.json`。

**当前状态**：`未配置` —— 缺阿里云 RAM 凭据与记录 ID。脚本已实现完整签名（RPC v1 HMAC-SHA1）与核对流程，缺的只是 `secrets/aliyun-dns.json`。

### 4.3 阻塞项（两处外部授权）

| 项 | 实测结果 | 需要什么 |
|---|---|---|
| AAAA 记录 | 公共 DoH `Status=3`（NXDOMAIN），`Authority` 为 hichina SOA | 控制台先手建 `chat` / AAAA / TTL 300，保存记录 ID；或提供 RAM 凭据 |
| 路由器 SSH | `root@192.168.100.1: Permission denied (publickey,password)` | 账户名未确认（不假定 root）、公钥未登记、主机指纹未核验 |
| 路由器入站规则 | **未改动**（无登录即无权限） | 同上；只放行该主机 TCP 80/443，保留必要 ICMPv6 |

生成的 Ed25519 开发密钥仍在 `dsh-production/data/local-credentials/router-192.168.100.1/`，`status` 仍为 `generated-locally-not-enrolled`。

---

## 5. G3：Caddy 与 TLS 反代

### 5.1 固定版本与哈希

| 项 | 值 |
|---|---|
| 版本 | `v2.11.9 h1:bhZtcRKQOq0fuLvEgCdPYvUxXyGn9kzjG4lh2332DTE=` |
| 来源 | `github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_windows_amd64.zip` |
| zip SHA512 | `98753d5d…b06871`（18 384 117 B） |
| caddy.exe SHA256 | `2622e239c79df700b0eb92cbd950d1edee365e155a7859f358f0e55f002df591` |

安装在 `D:\DSH\vocechat\caddy\bin\caddy.exe`；**未使用 winget / 系统 PATH 安装**，不改全局环境。

### 5.2 两份配置

- `caddy/Caddyfile`（公网用）：`https://chat.tinydock.cc` → `reverse_proxy 127.0.0.1:3009`，`flush_interval -1` 保留流式事件，`encode zstd gzip`，全局 `storage file_system D:\DSH\vocechat\caddy\state`（证书/ACME 状态固定，避免交互与服务两套证书），`admin 127.0.0.1:2019`，日志轮转 10 MiB × 5。
- `caddy/Caddyfile.local`（本机验证用）：`auto_https disable_redirects`、`admin off`，`:8090` 明文 + `https://chat.local.test:8443` `tls internal`。**不含公网域名，不触发 ACME。**

两份均通过 `caddy validate`，`caddy fmt --overwrite` 已格式化。

### 5.3 实测结果（本机验证实例，端口 8090 / 8443）

| 检查 | 结果 |
|---|---|
| 明文反代 `/` | 200，4 383 B，与直连字节一致 |
| 经 TLS `/` | 200，4 383 B |
| 经 TLS `/api/admin/login/config` | 200，`guest:false` / `InvitationOnly` |
| 经 TLS `/api/user`（未带令牌） | 401（鉴权头透传正确） |
| 经 TLS 静态资源 `main.a49dd9cc.js` | 200，**799 872 B，与直连字节完全一致** |
| 经 TLS `/locales/zh/auth.json` | 200，2 741 B |
| SSE `/api/user/events`（4 秒） | **直连 1 364 B / 经代理 1 364 B**，流式透传正常 |
| 经 TLS 登录 + 建频道 | 登录 uid=1 admin=True；建 `gid=2` 成功（已删除，回到 `channels=1`） |
| 证书 | Caddy 内部 CA 自签，仅用于本机验证，**不作公网信任** |

### 5.4 公网 ACME 实测（有价值的失败证据）

用公网配置起过一次实例，日志记录：

```
trying to solve challenge identifier=chat.tinydock.cc challenge_type=http-01
challenge failed: DNS problem: NXDOMAIN looking up A for chat.tinydock.cc;
                  NXDOMAIN looking up AAAA for chat.tinydock.cc
```

该实例已停止（避免无意义重试）；证据归档 `evidence/acme-attempt-20261117.log`。**这证明 ACME 链路本身可达 CA，唯一缺的是 DNS 记录**。

### 5.5 标准端口绑定演练（新增，排除风险）

在等 AAAA 与防火墙之前，先用占位主机名 `staging.local.test` + `tls internal` 演练标准端口：**不碰真实域名、不触发 ACME**。配置 `caddy/Caddyfile.staging`，校验通过。

| 检查 | 结果 |
|---|---|
| TCP 80 绑定 | 成功（`::80`，caddy 单一进程） |
| TCP 443 绑定 | 成功（`::443`，同一进程） |
| HTTP 80 反代 `/` | 200，4 383 B |
| HTTPS 443 反代 `/` | 200，4 383 B |
| HTTPS 443 API | `/api/admin/login/config` 200 |
| HTTPS 443 静态资源 | **799 872 B，与直连一致** |
| HTTPS 443 SSE | **1 364 B / 4 秒，与直连一致** |
| HTTPS 443 匿名边界 | `/api/group` 401 |

结论：**80/443 无占用冲突，Caddy 能正常绑定并终止 TLS**。演练实例已停止，端口回到未监听；证据 `evidence/g3-standard-port-drill-20261117.json`。

仍未完成的两步（都需提权或凭据）：

| 项 | 现状 | 原因 |
|---|---|---|
| Windows 防火墙放行 | 脚本 `scripts/firewall-caddy.ps1` 就位（`vocechat-caddy-tcp-{80,443}-in`，限定 `caddy.exe` 路径 + Private/Public，`-Action remove` 精确回滚） | 当前会话**非提权**，`New-NetFirewallRule` 返回"拒绝访问"（已实测 `-Action add` 提前退出、未改 firewall） |
| Caddy 长驻 | 计划任务命令写入脚本输出 | `Register-ScheduledTask` 同样被拒（提权） |
| G2 就绪检查 | `scripts/g2-readiness.ps1` 逐项报告，当前 **1/10 满足** | 缺 AAAA、缺凭据、缺路由器登录 |

已确认 `80` / `443` 当前**无任何进程监听**，不存在与既有服务的端口冲突；353 条 80/443 相关端口过滤器中无本项目规则，也无 IIS/Caddy 类既有入口需要复用。

---

## 6. 资源与风险

| 项 | 实测 | 处理 |
|---|---|---|
| 宿主空闲内存 | **0.2 GiB / 15.93 GiB** | 远低于计划的 4 GiB 目标。容器实测仅占 13 MiB，但 Docker Desktop VM 与 WSL 已占约 1.9 GB。**G4/G5 之前必须释放内存**，否则桥接 + 多 Bot 无法并行 |
| C 盘 | 59.9 GiB 空闲；`docker_data.vhdx` 6.77 GB 在 C 盘 | 未迁移（迁移属独立流程，需先备份），记录待办 |
| 前缀生命周期 | RA 40 分钟 / DHCP 30 分钟 | DDNS 必须高频；路由器规则若写死旧前缀，DDNS 无法修复 |
| 网络 | WLAN 3，Private | 长期稳定性未验证；有线更优 |
| 公网 IPv4 | 未验证 | 纯 AAAA：IPv4-only 网络不可直达，需另评估 |
| 免费档成员数 | 官方 ≤20 | Bot 是否计入按版本核对，未购买许可 |

---

## 7. 验收矩阵（本轮实测状态）

| 编号 | 检查 | 本轮结果 | 证据等级 |
|---|---|---|---|
| V01 | Docker | **通过** Server 29.4.3 / linux / amd64，旧资产已盘点 | 实测 |
| V02 | 本机 | **通过** 可登录，3009 仅 `127.0.0.1` | 实测 |
| V03 | 持久化 | **通过** 三次重建，账号/频道/附件/frontend_url 保留 | 实测 |
| V04 | 隐私 | **通过** 游客关闭、仅邀请注册、匿名注册 403 | 实测 |
| V05 | 域名 | **未通过** `chat.tinydock.cc` rcode=3，无 AAAA | 实测（缺凭据） |
| V06 | DDNS | **未通过** 脚本就位，未演练真实更新 | 未配置 |
| V07 | 外网 HTTPS | **未通过** 公网未开；本机自签 TLS 反代与 80/443 标准端口绑定演练均通过 | 本机实测 |
| V08 | 长连接 | **部分** SSE 经代理字节一致；双端客户端收发未做 | 本机实测 |
| V09 | 边界 | **通过（本机侧）** 管理口/Docker API/3009 未公网转发；80/443 未监听 | 实测 |
| V10–V17 | G4 及以后 | 未开始 | — |

状态用词严格区分：`已保存未测试`（frontend_url）≠ `测试成功`；`本机 TLS 反代通过` ≠ `公网 HTTPS 通过`。

---

## 8. 交付物清单

运行目录 `D:\DSH\vocechat\`（整目录 Git 忽略）：

| 文件 | 用途 |
|---|---|
| `compose.yaml` | 容器定义，digest 固定，仅回环发布，健康探针已修正 |
| `.env` | 镜像 digest、创建时间、端口、前端 URL |
| `README.md` | 目录说明、常用命令、回滚步骤 |
| `caddy/Caddyfile` | 公网 HTTPS 配置（含 storage 固定、流式保留、日志轮转） |
| `caddy/Caddyfile.local` | 本机验证配置（不触发 ACME） |
| `caddy/bin/caddy.exe` | v2.11.9 windows/amd64，哈希已记录 |
| `scripts/address-policy.ps1` | IPv6 地址策略，输出 JSON 证据 |
| `scripts/ddns-update.ps1` | 阿里云 AAAA DDNS，默认演练，边界受限 |
| `scripts/firewall-caddy.ps1` | 提权后执行：加/查/撤防火墙规则 + 长驻命令 |
| `scripts/g2-readiness.ps1` | G2 逐项就绪检查（只读），输出 JSON |
| `scripts/verify-local.ps1` | 可重复本机验收，输出 JSON |
| `caddy/Caddyfile.staging` | 标准端口 80/443 绑定演练（占位名，不触发 ACME） |
| `secrets/aliyun-dns.json.example` | DDNS 凭据模板（真实文件不入库） |
| `secrets/owner-credential.json` | 管理员凭据（ACL 仅当前用户 + SYSTEM） |
| `evidence/` | 地址策略、ACME 失败、SSE 对比、验收 JSON |

备份根 `D:\DSH\vocechat-backups\`（空目录已建；首次尝试的错误数据目录已隔离到 `discarded\boot-attempt1-20261117`）。

---

## 9. 下一步（按顺序，卡点已标注）

当前状态机：**G1 全部通过 → G2 卡在外部授权（1/10 就绪）→ G3 反代链路全部验证完毕，只差公网三步**。

1. **建 AAAA 记录**（控制台手建 `chat` / AAAA / `240e:338:a21:b2e0:14d0:85ba:a56a:1cd1` / TTL 300），保存记录 ID —— 需用户操作。
2. **写 `secrets/aliyun-dns.json`**（复制 `.example`，填 RAM 受限 AccessKey 与记录 ID），然后 `.\scripts\ddns-update.ps1`（演练）→ `-Apply`。
3. **登记路由器公钥并核验指纹**，确认账户与权限；只读核对 WAN6 委派与现有规则；只放行该主机 TCP 80/443，保留 ICMPv6 —— 需用户在 LuCI 完成（`root` 尝试登录返回 `Permission denied (publickey,password)`，账户名仍未知）。
4. **提权执行** `.\scripts\firewall-caddy.ps1 -Action add`，再以 `Caddyfile`（公网配置）启动 Caddy，观察证书签发。
5. **外部网络验证** V07/V08：手机关 Wi-Fi 用 IPv6 访问 `https://chat.tinydock.cc`，双端收发与断线重连。
6. **释放内存到 ≥4 GiB 空闲**（当前 0.2 GiB），再评估 Docker VM 限额 —— G4 前置。
7. 之后才进入 G4（单 Bot 闭环 / 桥接）。

任一步完成后可跑 `.\scripts\g2-readiness.ps1` 与 `.\scripts\verify-local.ps1` 复检，两项脚本都不写远端。

---

## 10. 边界声明

- 未修改既有 DSH、QQ、AstrBot、searxng 配置；未删除任何既有容器、镜像、卷。
- 未改动路由器、DNS、防火墙的任一实际规则。
- 未安装系统级软件（Caddy 为目录内便携二进制；Docker 复用既有 Desktop）。
- 未提交 Git；运行目录与凭据均在忽略范围。
- 未读取或输出聊天原文、记忆库、健康快照、媒体产物。
