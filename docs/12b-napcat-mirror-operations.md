# 12b · NapCat 事件镜像的运行与运维（P9-G1 / G2）

> 承接 [12a-mirror-baseline.md](12a-mirror-baseline.md)。12a 记录"复制了什么、生产只读的证据"；
> 本文记录**新增的那条连接、镜像进程、假 OneBot WS，以及怎么停、怎么回滚**。

**G3 及之后没有做**：测试 DSH 还没有以 mirror-only 身份挂到这条链路上，见 §7。

---

## 1. 生产侧的唯一一处变更：新增一条 SSE 连接

| 项 | 值 |
|---|---|
| 连接类型 | NapCat `httpSseServers`（**单向，只收事件**） |
| 名称 | `group-mirror` |
| 监听 | `127.0.0.1:3002`（仅本机） |
| 路径 | `/_events` |
| 消息格式 | `array`（与生产 WS 一致） |
| `reportSelfMessage` | `false`（她自己发的消息不从这条重复上报） |
| `enableCors` / `enableWebsocket` | `false` / `false` |
| Token | 独立新生成的 16 字符，只存在 NapCat 配置与本机环境变量里，**本文不记录** |

改法：经 NapCat WebUI 的 `/api/OB11Config/SetConfig` 写入（**只 push 一条数组项**），
而不是手改 JSON 再重启——NapCat 收到配置变更后会自己热重载该适配器：

```text
11-09 15:56:24 [Notice] [OneBot11] 配置变更后:
HTTP-SSE服务: 127.0.0.1:3002, : 已启动
WebSocket服务: 127.0.0.1:3001, : 已启动          ← 生产那条，原样
WebSocket反向服务: ws://127.0.0.1:6199/ws, : 已启动
```

### 1.1 变更前后逐字段核对

| 字段 | 变更前 | 变更后 |
|---|---|---|
| `httpSseServers` | `[]` | 1 条（上表） |
| `httpServers` / `httpClients` | `[]` / `[]` | 不变 |
| 生产 WS `name/host/port/token` | `dsh` / `127.0.0.1` / `3001` / 已设置 | **逐字不变** |
| 生产 WS 客户端（`ws://127.0.0.1:6199/ws`） | 已启用 | **逐字不变** |

脚本级 diff 结论：字段级差异只有 `network.httpSseServers` 的数组长度 0 → 1。
`websocketServers` 那条有一个非语义差异（`reconnectInterval` 被 schema 默认值化为
`enableForcePushEvent: true`）——两者都是 schema 的默认值，NapCat 的 `SetConfig` 会
按 schema 重排；实际连接参数（host/port/token/format/reportSelfMessage）一字未动。
**回滚时用的是变更前的原始文件副本**，所以那一点 schema 重排也会一并还原。

### 1.2 生产连接仍然在线（变更之后实测）

```text
Established  127.0.0.1:3001 → 127.0.0.1:63378   （生产 DSH 的 OneBot 连接）
Listen       127.0.0.1:3001
Listen       127.0.0.1:3002                      （新增的那条）
生产宿主进程 PID 67284，启动时间与变更前一致
```

---

## 2. 镜像进程：`tools/group-mirror`

```text
tools/group-mirror/
  src/config.mjs      # 配置校验（可疑配置拒绝启动）
  src/event.mjs       # 形状校验 + 类型过滤 + 群白名单（顺序即策略）
  src/queue.mjs       # 去重表（TTL + 上限）+ 有界队列（丢最旧）
  src/sse-client.mjs  # SSE 增量解析 + 指数退避重连
  src/local-ws.mjs    # 假 OneBot WS：任何 action 一律拒绝
  src/mirror.mjs      # 装配：SSE → 校验 → 白名单 → 去重 → 队列 → 假 WS
  src/index.mjs       # CLI（--check 只校验，不开网络）
  test/               # 28 项离线测试
```

### 2.1 五条硬约束（违反任一条就拒绝启动）

| # | 约束 | 为什么 |
|---|---|---|
| 1 | `allowedGroups` 为空 = **不转发任何群** | "空"最容易被读成"全部"；这里让它等于"一个都不" |
| 2 | 假 WS 只能监听回环地址 | 镜像端口暴露到局域网就等于给了别人一个事件源 |
| 3 | 两个 Token 必须有值且**不同** | 测试侧持有真实连接令牌是最不该发生的配置错误 |
| 4 | `sourceUrl` 必须是 `http(s)://` | `ws://` 是双向端口，接上去就能发 API |
| 5 | 群号必须是正整数、不可重复 | 白名单是数据，不是模式串 |

### 2.2 过滤顺序（为什么不能颠倒）

```text
坏 JSON → 形状/超长 → post_type=message → message_type=group → 群白名单 → 去重 → 队列 → 假 WS
```

- 形状在类型之前：形状不对的事件连"是不是白名单群"都判断不了；
- 白名单在**写日志与入队之前**：否则其它群的正文会先落盘再被丢弃（计划 §G1 明写禁止）；
- 去重在入队之前：重放的同一条消息不能触发第二次判断。

### 2.3 假 WS 的行为

| 情形 | 行为 |
|---|---|
| 任意 action（含 39 个已知 + 未知） | `status: failed` + `retcode: 1200` + `data: null` |
| 纯查询（`get_login_info` / `get_status`） | **同样拒绝**（不开白名单口子） |
| 合成 `message_id` 回执 | **绝不提供**（会让 sent-log 记下"已发送"） |
| 错 Token / 无 Token 握手 | 直接断开，计 `rejectedHandshakes` |
| 每次越权尝试 | 计 `forbiddenActionAttempts`，并记 `{action, echo, params形状}` |

---

## 3. 本机检索已打开（语义通道实测可用）

| 项 | 之前（12a） | 现在 |
|---|---|---|
| `embedding.provider` | `off` | `remote`（SiliconFlow，2560 维） |
| `rerank.enabled/provider` | `false` / `off` | `true` / `remote` |
| `retrieval.semanticEnabled` | `true`（但无 provider） | `true` |
| `extraction.enabled` | `false` | **仍然 `false`**（写库需单独授权） |
| 密钥 | 无 | `data/home/companion/remote-models.json`（gitignore，从生产搬的两条模型密钥） |

实测（真实 API 调用）：

| 查询 | 耗时 | lexical | semantic | 返回条目 |
|---|---|---|---|---|
| 我最近睡得太晚了 | 1233 ms | 27 | **35** | 8 |
| 拍照总是糊怎么办 | 923 ms | 32 | **37** | 8 |
| 你还记得我的猫吗 | 1174 ms | 32 | **45** | 8 |

之前 semantic 全是 0（只有关键词通道），现在语义通道有命中——这是"检索真的开了"的
直接证据，不是配置文件的自我声明。

库里的向量分布（导入时带来的）：

```text
local  / hash-bigram-256          :  776 条
remote / Qwen/Qwen3-Embedding-4B  : 1018 条   ← 与现在的 provider 一致，可直接用
```

---

## 4. 离线测试：28 项

```bash
node --test "tools/group-mirror/test/*.test.mjs"
```

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `mirror.test.mjs` | 16 | 配置校验 5、事件过滤 4、去重 2、队列 1、SSE 解析 2、退避 1、装配 1 |
| `fake-ws.test.mjs` | 6 | 39 个已知动作全拒、4 个未知动作全拒、纯查询不放行、越权计数、错/无 Token 握手 |
| `e2e.test.mjs` | 6 | 假 SSE 源 → 镜像 → 假 WS → 假客户端 全链路；非白名单/私聊/坏帧零投递；重复只投一次；断线重连不补发 |

关键用例的设计意图（不是凑数）：

- **未知动作也拒**：如果只枚举黑名单，下一个新增动作就是洞；
- **纯查询也拒**：任何"只放行查询"的白名单都会在下次扩展时变成发送通道；
- **断言 `data === null`**：假成功回执会让"零发送"变成谎话，所以要正面断言它不存在；
- **断言日志里没有正文**：过滤发生在写日志之前，这一点必须被测试钉住。

---

## 5. 真实事件已穿过整条链路（real-inbound 达成）

### 5.1 第一次真正收到

三轮"零事件"之后，群里终于有人说话。**同一个探针、同一套配置、没有改任何东西**：

```text
NapCat 侧：20:25:55 接收 <- 群聊 [.. (145326153)] [Arona(2818504677)]
          [回复消息 [槑(1429709395)] @Arona 没连上😋] @槑 修完了再试试
SSE 侧：  GROUP MSG group=145326153 user=2818504677 msgId=237349890 len=51
          total=1 bytes=634 hist=[["message/group",1]]
```

两边对得上：同一个群、同一个发送者、同一条消息，SSE 帧 634 字节。

### 5.2 完整链路：事件到了假 WS 客户端

```text
真实 NapCat SSE → group-mirror（校验/白名单/去重/有界队列）→ 假 OneBot WS → 假测试客户端
```

6 分钟窗口，期间群里来了一条转发消息：

| 统计 | 值 |
|---|---|
| SSE `connects` / `frames` / `disconnects` | 1 / 1 / 0 |
| `received` → `accepted` → `delivered` | 1 → 1 → 1 |
| `rejected`（shape/oversize/type/group） | 0 / 0 / 0 / 0 |
| 假 WS `connections` / `eventsSent` / `forbiddenActionAttempts` | 1 / 1 / **0** |
| 客户端实收 | **1 条**，与 `delivered` 一致 |

事件结构完整穿过镜像（17 个字段）：

```text
font, group_id, group_name, message, message_format, message_id, message_seq,
message_type, post_type, raw_message, real_id, real_seq, self_id, sender,
sub_type, time, user_id
```

- `message` 保持 **array** 格式（与生产 `messagePostFormat: array` 一致），段类型 `forward`；
- `sender` 四个字段齐全（`user_id / nickname / card / role`）；
- 镜像**没有改写任何字段**——它只在旁边判断"放不放行"。

### 5.3 为什么之前是零

不是链路问题，是那三个时间窗里**群里确实没人说话**：

| 时段 | 群里有消息吗 |
|---|---|
| 16:00–16:20（上一轮三轮订阅） | 没有；生产侧最后一条记录 15:56:55 |
| 20:00–20:25 | 一条都没有 |
| 20:25:55 | **有**，被捕获 |
| 20:30:24 | **有**（转发消息），穿过整条链路 |

NapCat 日志里全部 25 条「接收」记录，群号**都是** `145326153`（生产授权的那一个），
私聊 0 条——白名单配置与实际行为一致。

### 5.4 仍然没验证到的两件事

1. **reply 引用**：两次真实事件分别是 `[回复消息 …]`（文本）和 `[转发消息]`，但捕获到的
   SSE 帧里 `message` 段只显示 `forward`。20:25 那条的 reply 结构没被完整记录到
   （探针当时只统计了长度）。这一项留在长窗口观察里继续看。
2. **双群隔离**：只有一个授权群有流量，另一个群的隔离没法在真实数据上验（离线测试覆盖了）。

### 5.5 一条旁证：生产侧的真实故障

NapCat 日志里 19:17:29 有一条群消息正文是
`LLM 响应错误: All chat models failed: AuthenticationError: Error code: 401 - Invalid API key`
——那是群友在转贴报错，**不是**这套件的错误（本机 `modules.qq: false`，没有任何 QQ 出站能力）。
但它说明生产那边的模型密钥当时确实有问题，与本轮无关。

---

## 6. 怎么停、怎么回滚

### 6.1 停镜像（不动生产）

```powershell
# 找到镜像进程并停掉（它只监听 127.0.0.1:3101，没有生产连接）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match "group-mirror" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

### 6.2 回滚 NapCat 那条新连接

配置副本（变更前原样，2570 字节），就在 NapCat 自己的 `config/` 目录下、原文件旁边：

```text
<napcat>/config/onebot11_<QQ号>.json.bak-mirror-20261109-075450   ← 变更前
<napcat>/config/webui.json.bak-mirror-20261109-075450             ← 同时留档（未改动）
```

回滚顺序（按计划 §6）：

1. 停 `group-mirror`；
2. 停测试 DSH（本轮还没起，跳过）；
3. 用副本覆盖 `onebot11_2668517323.json`，或在 WebUI 里删掉 `group-mirror` 那条 ——
   两条路等效，覆盖更彻底（连 schema 重排一起还原）；
4. 核对生产 WS 仍在线：`Get-NetTCPConnection -LocalPort 3001` 应有 `Established`。

**不需要动生产 WS、不需要重启 NapCat、不需要碰生产数据。**

---

## 7. 没做的事

| 阶段 | 状态 | 缺什么 |
|---|---|---|
| G3 测试 DSH 以 mirror-only 身份接入 | **未开始** | 需要在 `dsh-channel-qq` 里加 `mirror-observe` 分支 + 启动前路径断言 |
| G4 观测与盲评 | **未开始** | 依赖 G3 的真实决策数据 |
| G5 性能与防干扰 | **部分** | 有镜像侧统计，没有生产侧对照基线 |
| G6 交付验收 | **部分** | 本文即 G1/G2 部分；G3–G5 的文档还没写 |

测试 DSH 现在连的还是它自己的配置（`modules.qq: false`、`onebot.url: ""`），
**没有**把 `connection.url` 指向 `ws://127.0.0.1:3101/`。这一步属于 G3，
需要同时加上"路径不许与生产重合"的启动前断言，不能只改一个 URL 就接。

---

## 8. 证据级别

| 级别 | 本轮 | 依据 |
|---|---|---|
| `offline-test` | ✅ | 28 项镜像测试 + 仓库原有全套（1635 例 channel、`npm run verify` 三段） |
| `host-load` | ✅ | 真的起了镜像进程、连了真实 SSE、开了假 WS |
| `real-api` | ✅ 仅检索 | 3 次真实 embedding 调用（见 §3）；**不是**群社交决策的评测 |
| `real-inbound` | ✅ **已达成** | 2 条真实群消息穿过整条链路（§5），其中 1 条到达假 WS 客户端并被完整保留 |
| `real-send` | ❌ | 结构性不可能：假 WS 没有真实 QQ 通路；`forbiddenActionAttempts: 0` 说明连尝试都没有 |

**这轮可以读成"镜像链路可用"了**：真实群消息进来了、穿过了过滤层、到了假 WS 客户端、
结构完整、零越权尝试。但**还不能读成"评测有结论"**——只有 2 条样本，而且没有接测试 DSH
（G3 未做），所以没有任何"她会怎么反应"的数据。
