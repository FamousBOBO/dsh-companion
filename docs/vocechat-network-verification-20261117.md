# VoceChat 公网链路验证记录（2026-11-17）

> 记录时间：2026-11-17 05:05，Asia/Shanghai
> 运行目录：`D:\DSH\vocechat\`
> 相关：`vocechat-local-deployment-plan-20261116.md`、`vocechat-g1-g3-report-20261117.md`、`vocechat-current-state-20261117.md`
> 本文不记录 AccessKey、Secret、管理员密码、令牌或聊天内容。

---

## 1. 一句话结论

**本机服务和 Caddy 全部就绪，出站与 DNS 全通；唯一未通的是「外部到 PD 段 LAN 主机的入站 TCP」。** 证据指向运营商侧对 PD 段（`240e:338:a21:b2e0::/60`）的入站限制，而不是本机、防火墙或路由器规则问题。ACME `http-01` / `tls-alpn-01` 都依赖这条入站路径，因此证书拿不到。

---

## 2. 桥接后的网络事实

| 项 | 值 | 来源 |
|---|---|---|
| WAN 协议 | PPPoE，MTU 1492，UP | 实测 |
| WAN IPv4 | `100.64.64.114`（CGNAT） | 实测 |
| WAN IPv6 | `240e:338:a02:ddb5:304c:4c6a:a221:4da5/64` | 实测 |
| PD 前缀 | `240e:338:a21:b2e0::/60`（16 个 /64） | 实测 |
| LAN 网关 | `br-lan` = `240e:338:a21:b2e0::1/60` + ULA `fd98:adf9:169e::1/60` | 实测 |
| 路由器型号 | FriendlyElec NanoPi R3S / aarch64 | 实测 |
| 固件 | iStoreOS 24.10.5 (2025123110)，kernel 6.6.119 | 实测 |
| 防火墙 | fw4 / nftables；`wan` zone `input=REJECT` `forward=REJECT` | 实测 |
| 代理 | mihomo 在 `7890/7892/7874/9091`，`openclash.config.ipv6_enable='0'`，仅 IPv4 透明代理 | 实测 |
| LAN 主机 IPv6 | `240e:338:a21:b2e0:14d0:85ba:a56a:1cd1`（SLAAC/Link）、`::7b2`（DHCPv6）、`4df:…:9624`（临时） | 实测 |
| LAN 主机 IPv4 | `192.168.100.50`（WLAN 3，Private） | 实测 |

**PD 从 /64 升到 /60** 是桥接带来的实质变化；`ip6assign=60` 与之一致。

---

## 3. 出站测试（全部通过）

本机直测，IPv6：

| 目标 | 结果 |
|---|---|
| `ping6 2400:3200::1`（阿里 DNS） | 3/3，0% 丢包，37–38 ms |
| `ping6 2606:4700:4700::1111`（Cloudflare） | 3/3，0% 丢包，63–64 ms |
| `https://www.baidu.com/` | **200**，走 `240e:ff:e020:98c:0:ff:b061:c306`（IPv6） |
| `https://acme-v02.api.letsencrypt.org/directory` | **200**，走 `2606:4700:60:0:f53d:5624:85c7:3a2c`（IPv6） |

LE API 走 IPv6 可达 → **ACME 客户端这一侧没有问题**。

---

## 4. 入站测试（关键差异点）

### 4.1 已验证通的部分（路由器自身地址）

此前实测（用户提供，本轮复核环境一致）：`pppoe-wan` 自身 `/64` 内地址可达。

| 目标 | 结果 |
|---|---|
| `http://[240e:338:a02:ddb5:…]:8089/`（IPv6 绑定） | **200** |
| `http://[240e:338:a02:ddb5:…]:8088/`（IPv4-only 绑定） | 拒绝 |
| `[240e:338:a02:ddb5:…]:22` | `SSH-2.0-dropbear` 响应 |

结论：**到 pppoe-wan 自身 `/64` 的入站是通的**，`input_wan` 链工作正常。

### 4.2 未通的部分（PD 段 LAN 主机）—— 本文核心发现

这两件事**不是同一回事**：
- 访问 `240e:338:a02:ddb5:…` → 目标在 `pppoe-wan` 上 → 命中 **input** 链；
- 访问 `240e:338:a21:b2e0:…` → 目标在 `br-lan` 上（PD 段）→ 需要命中 **forward** 链。

实测 forward 路径不通，证据如下：

| 证据 | 内容 |
|---|---|
| **路由器规则已正确生效** | `forward_wan` 链第 5 条：`ip6 daddr 240e:338:a21:b2e0:14d0:85ba:a56a:1cd1 tcp dport { 80, 443 } counter packets 0 bytes 0 jump accept_to_lan comment "!fw4: vocechat-in-80-443"` |
| **该规则计数器始终为 0** | 多轮 ACME 重试期间反复查询，`packets 0 bytes 0` 未增长 |
| **抓包证实包未到达路由器** | `tcpdump -i pppoe-wan 'ip6'` 持续约 5 分钟，共 **141 037 个 IPv6 包**；其中目标为 `14d0:85ba` 的仅 1 个 **UDP** 包（来自 `240e:3a3:…`，端口 58468，且被路由器回 ICMPv6 unreachable port）；**目标为该地址 80/443 的 TCP SYN 数量 = 0** |
| **内网路径本身正常** | 从路由器 shell 执行 `wget http://[240e:…1cd1]/` → `connected` + `HTTP/1.1 308`；`https://[240e:…1cd1]/` → `connected` |
| **本机 TCP 层正常** | 本机 `Test-NetConnection` 对该地址：`443 = True`、`80 = True`、`3009 = False`（3009 只绑回环，符合设计） |

**推论**：外部包在到达 `pppoe-wan` 之前就被丢弃，规则和抓包都没见到它们。这是运营商侧对 PD 段的入站处理，不是本机、Windows 防火墙或 fw4 规则的问题。

### 4.3 本机侧暴露面（已确认符合设计）

| 端口 | 监听 | 外部（PD 段）可达 |
|---|---|---|
| 80 | `0.0.0.0` + `[::]`（caddy pid） | TCP 层 True |
| 443 | `0.0.0.0` + `[::]`（caddy pid） | TCP 层 True |
| 3009 | 仅 `127.0.0.1` | **False**（正确隔离） |
| 2019 | 仅 `127.0.0.1` | False（Caddy admin 不对外） |

---

## 5. 本机部分（已完成项）

| 项 | 状态 |
|---|---|
| VoceChat 容器 | `vocechat-personal-vocechat-1` **healthy**，`127.0.0.1:3009->3000/tcp` |
| 镜像 | `privoce/vocechat-server@sha256:7ea02d9c…14fa1a`，0.5.40 |
| Caddy | v2.11.9 windows/amd64，pid 在跑，监听 `::80` / `::443` / `127.0.0.1:2019` |
| Windows 防火墙 | 两条规则 Enabled/Allow/Private,Public，`Program` 精确限定 `D:\DSH\vocechat\caddy\bin\caddy.exe` |
| 管理员 / 隐私 | uid=1 `is_admin`，`guest:false`，注册 `InvitationOnly`，私有频道 `companion-private` |
| 本机 TLS 反代 | 8090/8443 已验证：静态资源 799 872 B 字节一致，SSE 1 364 B 一致 |
| 标准端口演练 | 80/443 绑定成功，TLS 终止正常（占位名 + `tls internal`） |

---

## 6. DNS 与 DDNS（全部正常）

| 项 | 结果 |
|---|---|
| 权威 `dns11.hichina.com` AAAA 直查 | `240e:338:a21:b2e0:14d0:85ba:a56a:1cd1`，TTL 600 |
| 公共递归 `223.5.5.5` | 同上，TTL 52（缓存中，说明已传播） |
| 公共递归 `119.29.29.29` | 同上，TTL 600 |
| 阿里 DoH | `rcode=0`，同值 |
| 记录 ID | `2122387448453035008`，类型 AAAA，默认线路，TTL 600，ENABLE |
| RAM 策略 | `VoceChatDDNS_tinydock_cc`，仅 `DescribeDomainRecordInfo` + `UpdateDomainRecord`，资源限 `domain/tinydock.cc` |
| DDNS 任务日志 | 每 10 分钟运行；04:44:46、04:54:56 两次均输出「地址与 TTL 未变化，不调用更新」 |

> 注：`Get-ScheduledTask` / `schtasks` 在当前非提权会话读不到任务定义（返回 not found），但 `logs\ddns-task.log` 时间戳持续更新，**证明任务在跑**。此区别按证据分级记录：日志为实测，任务定义未能读取。

---

## 7. ACME 失败分析

Caddy 公网实例连续多轮尝试，两种挑战都失败：

```
04:59:37  trying to solve challenge  (http-01)
04:59:48  challenge failed: 240e:338:a21:b2e0:14d0:85ba:a56a:1cd1:
          Fetching http://chat.tinydock.cc/.well-known/acme-challenge/… :
          Timeout during connect (likely firewall problem)

04:59:50  trying to solve challenge  (tls-alpn-01)
05:00:01  challenge failed: Unable to contact "chat.tinydock.cc" at
          "240e:338:a21:b2e0:14d0:85ba:a56a:1cd1",
          no IPv4 addresses to try as fallback
```

解读：
- LE **确实解析到了 AAAA** 并尝试连接（报文中直接写出了该 IPv6 地址），排除了「DNS 没生效」；
- `no IPv4 addresses to try as fallback` 说明 LE 发现只有 AAAA，无 A 可回退；
- 连接超时 + 抓包零 SYN → **LE 的探测包没有抵达本机 `pppoe-wan`**。

---

## 8. 卡点定位与三条出路

### 卡点

**PD 段（`240e:338:a21:b2e0::/60`）的入站 TCP 在运营商侧被丢弃。** 本机、Windows 防火墙、fw4 forward 规则、Caddy 监听全部就绪且已逐项验证，但外部包根本没到路由器。`tcpdump` 141 037 个包零命中，规则计数器零命中，是决定性证据。

### 出路

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. DNS-01 挑战（首选）** | Caddy 改用 ACME DNS-01，用阿里云 DNS 插件带 `alidns` 模块；`Caddyfile` 加 `tls { dns alidns { env.ALIYUN_… } }`。**完全不需要任何入站端口** | 需要 xcaddy 重新构建带模块的二进制；复用现有 RAM 凭据（需加 `AddDomainTxt`/`DeleteDomainTxt` 权限） |
| B. VPS 反代 | 海外/国内 VPS 做 TLS 终止 + 反代回源 | 多一跳、多一份数据路径、需要 VPS |
| C. 隧道 | Cloudflare Tunnel / frp 等 | 引入第三方数据路径，评估流式与附件限制 |

**A 最优**：证书问题与入站可达性彻底解耦，且现有 DDNS 的 RAM 身份已就位，只需扩权到 TXT 记录操作。

需要注意的是，方案 A 仍不能解决"用户从外面访问聊天站"的问题 —— 那是入站可达性问题，DNS-01 只管证书。要真正让外部访问 VoceChat，仍需 B 或 C，或等待运营商开通 PD 段入站。

### 因此建议分两步

1. **先解决证书**：DNS-01（可用，不依赖入站）；
2. **再解决访问**：按需选 VPS 反代或 Cloudflare Tunnel。

---

## 9. 路由器侧当前改动（可回滚）

| 项 | 内容 |
|---|---|
| 新增 UCI rule | `firewall.@rule[10]`，name `vocechat-in-80-443`，`src=wan` `dest=lan` `proto=tcp` `dest_port=80 443` `dest_ip=240e:338:a21:b2e0:14d0:85ba:a56a:1cd1` `family=ipv6` `target=ACCEPT` |
| 生效位置 | `forward_wan` 链（正确） |
| 备份 1 | `/etc/config/firewall.bak-20261117-0420` |
| 备份 2 | `/etc/config/firewall.bak-before-vocechat-20261117` |
| nft 快照 | `/tmp/ruleset-before-20261117.txt` |
| 回滚 | `uci delete firewall.@rule[10]; uci commit firewall; /etc/init.d/firewall reload` |

按当前证据，这条规则**保留也无害**（计数器为 0，未放行任何实际流量）；若运营商后续开通 PD 段入站，它即刻生效。

---

## 10. 证据文件索引

| 文件 | 内容 |
|---|---|
| `D:\DSH\vocechat\evidence\ipv6-address-policy.json` | 地址策略与候选清单 |
| `D:\DSH\vocechat\evidence\firewall-rules.json` | Windows 防火墙两条规则 |
| `D:\DSH\vocechat\evidence\firewall-apply-result.txt` | UAC 提权执行结果 |
| `D:\DSH\vocechat\evidence\acme-attempt-20261117.log` | 首次 ACME 失败（NXDOMAIN 阶段） |
| `D:\DSH\vocechat\evidence\g2-readiness-20261117-011003.json` | G2 就绪检查 |
| `D:\DSH\vocechat\evidence\g3-standard-port-drill-20261117.json` | 标准端口绑定演练 |
| `D:\DSH\vocechat\evidence\verify-local-*.json` | 本机验收三轮 |
| `D:\DSH\vocechat\evidence\sse-*.txt` | SSE 直连/代理/443 字节对比 |
| `D:\DSH\vocechat\logs\ddns-task.log` | DDNS 每 10 分钟运行记录 |
| `D:\DSH\vocechat\caddy\logs\access.log` | Caddy 全量日志（含 ACME 时间线） |

---

## 11. 尚未做的验证

- 双客户端（手机 + 桌面）经公网 HTTPS 收发、刷新、断线重连 —— 依赖公网可达，未做
- 无人登录恢复、重启恢复 —— G6，未做
- 24 小时稳定性 —— G6，未做
- G4 单 Bot 桥接 —— 未开始

内存仍是前置约束：采样到空闲 0.2–0.4 GiB / 15.93 GiB，G4 前需恢复到 ≥4 GiB。

## 12. 手机 4G/5G 外部 IPv6 验证

手机测试时必须先关闭 Wi-Fi，只保留 4G/5G。不要访问 `192.168.100.1`，这是内网软路由地址；公网测试目标是 `chat.tinydock.cc`。

### 12.1 手机侧操作

1. 打开 `https://test-ipv6.com/`，确认移动网络确实获得 IPv6。
2. 访问 `http://chat.tinydock.cc/`，记录是否超时、被拒绝或发生跳转。
3. 再访问 `https://chat.tinydock.cc/`，记录浏览器显示的具体错误。
4. 若手机装有 Termux，可执行：

   ```sh
   curl -6 -vk --connect-timeout 10 https://chat.tinydock.cc/
   ```

### 12.2 结果判定

| 手机现象 | 结论 |
|---|---|
| `test-ipv6.com` 无 IPv6 | 当前手机运营商网络不能作为本次测试网络 |
| 有 IPv6，但 `chat.tinydock.cc` DNS 失败 | 检查 AAAA 记录或手机 DNS 缓存 |
| DNS 正常但 80/443 超时 | 继续在路由器 WAN 侧抓包；若无 SYN，问题在到达路由器之前 |
| 80/443 建连但出现 Caddy/证书错误 | 入站路径已通，转入 Caddy/ACME 配置排查 |
| 页面加载并出现登录界面 | 公网链路已打通，可开始登录、私有频道、SSE 和附件验收 |

### 12.3 路由器同步抓包（可选）

在软路由终端执行以下命令后，再用手机访问一次：

```sh
tcpdump -ni pppoe-wan 'ip6 and (tcp port 80 or tcp port 443)'
```

看到发往 `240e:338:a21:b2e0:14d0:85ba:a56a:1cd1` 的 TCP SYN，说明公网包已经到达路由器；完全没有 SYN，则仍是上游路径或运营商对 PD 前缀的入站处理问题。
