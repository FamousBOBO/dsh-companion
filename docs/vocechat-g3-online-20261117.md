# VoceChat 公网 HTTPS 上线完成报告（G0–G3）

> 完成时间：2026-11-17 12:55，Asia/Shanghai
> 运行目录：`D:\DSH\vocechat\`
> 入口：**https://chat.tinydock.cc:8443**
> 本文不记录 AccessKey、Secret、管理员密码、令牌或聊天原文。

---

## 1. 结论

**G1 / G2 / G3 全部完成并通过实测。** 公网 HTTPS 已上线，手机移动网络可正常访问、登录、收发消息，TLS 证书受信任。

唯一没有做的是 G4 及以后（单 Bot 桥接、多 Bot 隔离、长驻与恢复演练）。

---

## 2. 卡点根因（本轮最关键的发现）

前几轮反复出现「入站不通」，实际有四层问题叠加，逐层排除如下：

| 层 | 现象 | 根因 | 证据 |
|---|---|---|---|
| 1 | ACME 报 NXDOMAIN | AAAA 记录未建 | 公共 DoH `Status=3` |
| 2 | ACME 报 Timeout during connect | **电信 BRAS 封 80/443 入站** | `pppoe-wan` 抓包零 SYN；`forward_wan` 计数恒 0 |
| 3 | 手机报「拒绝连接」 | **Windows 防火墙只放行 80/443**，8443/18443 无规则 → 立即 RST | 抓包见 `host:18443 > phone Flags [R.]`，0 毫秒 |
| 4 | 加完防火墙规则后仍「拒绝连接」 | **netflow/mihomo 的 IPv6 透明代理劫持** | WAN 有 SYN、LAN 零 SYN、fw4 计数 0、conntrack 无记录 |

**第 4 层是真正的隐形杀手**：

`table ip6 netflow` 的 `prerouting` 链里有一条 blanket 规则：

```
meta l4proto tcp redirect to :7892
```

它把**所有** IPv6 TCP 都劫持到本机 mihomo。唯一的保护是 `fib daddr type local return`——只覆盖**路由器自身**地址。目标是 LAN PD 段（需要 forward 的主机）的包全部被劫持，mihomo 对这类内网回环目标不回连接 → 表现就是 RST 或超时。

这也解释了为什么早期用 `pppoe-wan` 自身地址测 18101 能通（走 input + `fib ... local` 保护），而测 `240e:338:a21:b2e0:...`（PD 段）永远不通。

**修复**：在 `table ip6 netflow` 两个链的首位插入

```
ip6 daddr 240e:338:a21:b2e0::/60 return
```

## 3. 最终架构

```
手机/客户端（移动网络 IPv6）
        ↓
chat.tinydock.cc  AAAA → 240e:338:a21:b2e0:14d0:85ba:a56a:1cd1
        ↓
电信 PPPoE WAN（240e:338:a02:ddb5::/64）
        ↓
iStoreOS NanoPi R3S
  ├─ table ip6 netflow：PD 段 return（不劫持）
  └─ fw4 forward_wan：dport 8443 → accept_to_lan
        ↓
Windows 主机 192.168.100.50 / [240e:...:1cd1]
  ├─ Windows 防火墙：caddy.exe 的 TCP 8443 允许
  └─ Caddy v2.11.9：HTTPS 8443，文件证书（不申请不续期）
        ↓
  127.0.0.1:3009  →  Docker VoceChat 0.5.40
```

## 4. 实测证据

### 4.1 外部源访问（决定性）

Caddy 日志记录到手机移动网络地址 `240e:438:a25:31ff:88ff:bf92:461d:4724`：

```
12:53:07 ip=240e:438:a25:31ff:...:4724  /api/admin/system/organization  200
12:53:09 ip=240e:438:a25:31ff:...:4724  /api/admin/system/organization  200
```

以及更早的明文验证（同一外部源，18443 拉取完整前端资源）：

```
12:50:15 ip=240e:438:a25:31ff:...:4724  /locales/en/auth.json        200
12:50:15 ip=240e:438:a25:31ff:...:4724  /static/js/672...chunk.js    200
12:50:15 ip=240e:438:a25:31ff:...:4724  /api/admin/smtp/enabled      200
```

### 4.2 路由器计数增长

```
vocechat-in-8443    packets 8  bytes 640
vocechat-in-18443   packets 6  bytes 480
```

（修复前均为 0）

### 4.3 HTTPS 端到端

| 检查 | 结果 |
|---|---|
| `https://chat.tinydock.cc:8443/` | 200，`ssl_verify_result=0`（证书完全受信） |
| 经 HTTPS 登录 | uid=1，`is_admin=true` |
| 经 HTTPS 读频道 | 200，`companion-private` 在位 |
| 经 HTTPS SSE | 1 364 B / 4 秒，流式正常 |
| 手机浏览器访问 | 带锁 HTTPS，可登录收发 |

### 4.4 证书

```
主体      CN=chat.tinydock.cc
签发者    CN=Encryption Everywhere DV TLS CA - G2, O=DigiCert Inc
有效期    2026-11-17 08:00  →  2027-02-15 07:59（90 天）
证书链    2 块（服务器证书 + 中间 CA）
SAN       chat.tinydock.cc, www.chat.tinydock.cc
```

来源：阿里云数字证书控制台免费证书，**手动 DNS 验证**签发 —— 全程不需要 80/443 入站。

### 4.5 边界与隔离

| 端口 | 监听 | 外部可达 |
|---|---|---|
| 8443 | `0.0.0.0` + `[::]`（caddy） | **是**（经路由器放行） |
| 18443 | 同上 | 是（明文排障口） |
| 3009 | 仅 `127.0.0.1` | 否（VoceChat 本体不外露） |
| 2019 | 仅 `127.0.0.1` | 否（Caddy admin 不外露） |
| 80 / 443 | 未监听 | 否（电信封禁 + 无服务） |
| Docker API | 既有本机管道 | 未新增 TCP 2375 |

匿名侧：`/api/group` 401、`/api/admin/user` 401、注册 403、guest 登录关闭。

---

## 5. 本轮所有改动清单（可回滚）

### 5.1 Windows 主机

| 项 | 内容 | 回滚 |
|---|---|---|
| 防火墙规则 | `vocechat-caddy-tcp-{80,443,8443,18443}-in`，Allow/Inbound，Private+Public，Program 限定 `caddy.exe` | `.\scripts\firewall-caddy.ps1 -Action remove` |
| Caddy 二进制 | `caddy\bin\caddy.exe` v2.11.9，SHA256 `2622e239…02df591` | 删除目录 |
| Caddy 配置 | `Caddyfile.prod`（生产）、`Caddyfile.probe`（四端口探针）、`Caddyfile.local` / `.staging` / `.nonstd`（历史） | 保留备查 |
| 证书 | `caddy\certs\chat.tinydock.cc.crt` + `.key`，ACL 仅当前用户 + SYSTEM | 删除文件 |
| VoceChat `frontend_url` | `https://chat.tinydock.cc:8443` | 管理员 API 改回 |

### 5.2 路由器（iStoreOS 24.10.5）

| 项 | 内容 | 回滚 |
|---|---|---|
| fw4 规则 | `firewall.@rule[10]` vocechat-in-80-443、`@rule[11]` vocechat-in-18443、`vocechat-in-8443` | `uci delete firewall.<sec>; uci commit firewall; /etc/init.d/firewall reload` |
| **netflow 排除** | `table ip6 netflow` 两链首位 `ip6 daddr 240e:338:a21:b2e0::/60 return` | `nft delete rule ip6 netflow prerouting handle <h>` 或重启 netflow |
| 排除脚本 | `/usr/bin/netflow-excl.sh` | 删除 |
| 自启项 | `/etc/init.d/netflow-excl`（`S100`，在 netflow `S99` 之后） | `/etc/init.d/netflow-excl disable` |
| 配置备份 | `/etc/config/firewall.bak-20261117-0420`、`.bak-before-vocechat-20261117`、`.bak-before-18443`、`.bak-before-8443` | 恢复备份 |
| nft 快照 | `/tmp/ruleset-before-20261117.txt` | — |

---

## 6. 验收矩阵更新

| 编号 | 检查 | 状态 | 证据等级 |
|---|---|---|---|
| V01 | Docker | **通过** 29.4.3 / linux / amd64 | 实测 |
| V02 | 本机 | **通过** 可登录，3009 仅回环 | 实测 |
| V03 | 持久化 | **通过** 三次重建数据保留 | 实测 |
| V04 | 隐私 | **通过** 游客关闭、仅邀请注册 | 实测 |
| V05 | 域名 | **通过** AAAA 解析一致（权威 + 三个公共递归） | 实测 |
| V06 | DDNS | **通过** 任务每 10 分钟运行，日志持续更新 | 实测（任务定义因非提权未能读取） |
| V07 | 外网 HTTPS | **通过** 手机移动网络访问，证书受信 | 实测（外部源地址有日志记录） |
| V08 | 长连接 | **部分** SSE 经 HTTPS 字节一致；双端同时在线收发未做 | 本机实测 |
| V09 | 边界 | **通过** 3009/admin/80/443 均未公网暴露 | 实测 |
| V14–V17 | G6 及以后 | 未开始 | — |

---

## 7. 交付物

运行目录 `D:\DSH\vocechat\`（整目录 Git 忽略）：

| 文件 | 用途 |
|---|---|
| `compose.yaml` / `.env` | VoceChat 容器，digest 固定，仅回环发布 |
| `caddy/Caddyfile.prod` | **生产配置**：HTTPS 8443，文件证书，SSE 流式保留 |
| `caddy/Caddyfile.probe` | 四端口探针（排障用） |
| `caddy/certs/` | 证书与私钥，ACL 收紧 |
| `README.md` | 目录说明、命令、回滚 |
| `scripts/install-cert.ps1` | 证书校验 + 落位 + validate |
| `scripts/start-prod.ps1` | 切生产实例 |
| `scripts/firewall-caddy.ps1` | 防火墙规则加/查/撤 |
| `scripts/firewall-apply-ports.ps1` | 提权放行四端口 |
| `scripts/address-policy.ps1` | IPv6 地址策略 |
| `scripts/ddns-update.ps1` | 阿里云 AAAA DDNS |
| `scripts/aliyun-dns-probe.ps1` | RAM 权限探针 |
| `scripts/verify-local.ps1` | 本机验收 |
| `scripts/router/netflow-excl.sh` | 路由器 netflow 排除（源） |
| `secrets/` | 管理员凭据、阿里云凭据、known_hosts，ACL 收紧 |
| `evidence/` | 全部实测证据 |

---

## 8. 后续建议

1. **证书续期**：90 天，2027-02-15 到期。到期前用同样流程重新申请（手动 DNS 验证），下载 Nginx 格式后跑 `install-cert.ps1 -ZipPath <zip> -Verify`，再 `start-prod.ps1`。
2. **探针端口清理**：18443 是明文排障口，长期开着等于多一条明文入口。稳定后建议撤掉，只留 HTTPS 8443。
3. **80/443 规则清理**：Caddy 已不监听，电信也封着，规则空转。可撤以减少暴露面。
4. **Caddy 长驻**：目前是 `Start-Process` 起的前台进程，登录后需手动启动。G6 阶段应改成计划任务或 Windows 服务（`start-prod.ps1` 里已有命令模板）。
5. **内存**：G4 前需把空闲内存恢复到 ≥4 GiB（本轮采样最低 0.2 GiB）。
6. **G4 单 Bot 桥接**：下一步工作是 VoceChat Bot + Webhook → DSH 的桥接开发。
