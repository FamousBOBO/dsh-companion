# tools/group-mirror — NapCat 群消息只读镜像（P9-G）

把 NapCat 的**群消息事件**镜像到本机的一个测试运行时，同时保证测试端**没有**任何能
到达真实 NapCat 的 OneBot API 出站通路。

> 默认关闭。`enabled: false` 时进程读完配置就退出，不监听端口、不发起连接。

## 为什么是两条连接

```text
  同一个 QQ / 同一个 NapCat
        │
        ├── 既有生产 OneBot WS（双向，能发消息）── 生产 DSH（不变）
        │
        └── 新增 HTTP SSE（单向，只能收）── group-mirror
                                              │
                                              ├─ 校验 / 白名单 / 去重 / 有界队列
                                              └── 本机假 OneBot WS ── 测试 DSH
```

SSE 那条是 NapCat 的 `httpSseServers`：服务端只往连接上写事件，客户端在这条连接上
**没有**发 API 的通道。生产用的 WS 是双向的，把它接到测试侧等于把扳机递过去。

假 WS 是给测试 DSH 的 `OneBotClient` 用的——它连上之后会通过 `call(action, params)`
发请求。那个端点对**任何** action 都回明确失败，且内部**不存在**任何指向真实 NapCat
的对象、URL 或令牌。

## 三层隔离，互相独立

| 层 | 做什么 | 代码位置 |
|---|---|---|
| 传输 | 只订阅 SSE（单向），假 WS 永不转发动作 | `src/sse-client.mjs`、`src/local-ws.mjs` |
| 数据 | 白名单之外的事件**在落盘/入队之前**就被丢弃 | `src/event.mjs` |
| 运行时 | 测试 DSH 用 `presence.mode: shadow`（应用级，第三道） | 测试 profile |

任何一层都不单独承担隔离：传输层阻断是真防线，shadow 只是不发送的**策略**。

## 用法

```bash
# 1) 只校验配置（不监听、不连接）
node tools/group-mirror/src/index.mjs --config mirror.json --check

# 2) 真正启动（会监听假 WS，并向 NapCat 的 SSE 发起订阅）
$env:NAPCAT_MIRROR_EVENT_TOKEN = "<NapCat 里那条 SSE 的 token>"
$env:DSH_MIRROR_FAKE_ONEBOT_TOKEN = "<随便一个新生成的值，不能与上面相同>"
node tools/group-mirror/src/index.mjs --config mirror.json
```

配置示例见 `mirror.example.json`。真实配置放 `<dataDir>/home/companion/mirror.json`
（被 `.gitignore` 覆盖），令牌只从环境变量读，**不写进文件**。

## 硬约束（违反任一条就拒绝启动）

1. `allowedGroups` 为空 = **不转发任何群**（不是"全部"）；
2. 假 WS 只能监听回环地址（`127.0.0.1` / `::1` / `localhost`）；
3. 两个令牌都必须有值，且**不能相同**——测试侧不许持有真实连接令牌；
4. `sourceUrl` 必须是 `http(s)://` 的 SSE 地址，`ws://` 直接拒绝（那是双向端口）；
5. 群号必须是正整数，重复也不行。

## 假 WS 的行为

- **不回假成功**：任何 action 都返回 `status: failed` + 非零 `retcode` + `data: null`。
  计划 §2.3 明确禁止伪造 `message_id` 回执——那会让测试运行时的 sent-log 记下"已发送"，
  于是"零发送"变成谎话。
- **不给查询开洞**：`get_login_info` / `get_status` 这类纯查询也不放行。任何"只放行查询"
  的白名单都会在下一次新增动作时变成一个洞。
- **记下每一次尝试**：`forbiddenActionAttempts` 在拒绝的同一处累加。只要测试客户端
  尝试发起 QQ 动作，本次运行就判"未通过出站约束"（虽然不会真的发到 QQ）。

## 测试

```bash
node --test "tools/group-mirror/test/*.test.mjs"
```

22 项，全部离线：

- `mirror.test.mjs`（16 项）：配置校验、事件过滤（类型/白名单/形状/超长）、去重、
  有界队列、SSE 断帧拼接、退避、整条装配；
- `fake-ws.test.mjs`（6 项）：频道用到的 **39 个动作** + 4 个未知动作逐一被拒、
  纯查询也不放行、越权计数准确、错 Token 与不带 Token 的握手都被拒。

## 不做什么

- 不连接生产 `ws://127.0.0.1:3001`；
- 不持有生产 OneBot Token（镜像只拿 SSE 那条连接的 Token）；
- 不写生产数据目录的任何文件；
- 不把"镜像收到真实群消息"说成"真实发送验收"。

## 证据级别

- `offline-test`：22 项通过；
- `host-load`：启动过假 WS + 订阅过真实 SSE（见 `docs/12b-napcat-mirror-operations.md`）；
- `real-api` / `real-inbound`：**有真实群消息进来时才算**；
- `real-send`：**永远不会达到**——假 WS 没有真实 QQ 通路。
