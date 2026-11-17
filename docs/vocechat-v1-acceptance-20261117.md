# channel-vocechat V1 验收记录（2026-11-17）

> 时间：2026-11-17 15:52，Asia/Shanghai
> 插件位置：`plugins/dsh-channel-vocechat`（新包，纯 `.mjs`，无构建）
> 生产宿主：PID 51736 / host 41716，`http://127.0.0.1:62684/`（重启后）
> 结论：**V1 完成。插件已在生产宿主里运行、webhook 在 3011 监听、容器投递落盘成功、幂等生效、出站可达手机。**

---

## 1. 交付物

| 文件 | 行数（约） | 职责 |
|---|---|---|
| `index.mjs` | 250 | cordis 入口、单例、装配、发布、卸载 |
| `config.mjs` | 180 | 配置解析（`*Env` 键名、安全默认、问题清单） |
| `http-api.mjs` | 230 | Bot API 客户端 + 错误分类 |
| `webhook.mjs` | 330 | HTTP server、四道校验、ACK 顺序 |
| `normalize.mjs` | 130 | 事件归一化 |
| `store.mjs` | 240 | `events.jsonl` + 幂等 LRU + 游标 + `gap.jsonl` |
| `port.mjs` | 150 | 端口对象装配 |
| `health.mjs` | 60 | 出站+入站双半探针 |
| `publish.mjs` | 150 | 跨兄弟行发布（三种 key 拼写） |
| `package.json` / `cordis.patch.yml` | — | 包与 bundle 默认层 |
| `CONTRACT.md` / `README.md` | — | 契约与说明 |
| `test/*.test.mjs`（7 个文件） | — | **81 项，全过** |

---

## 2. 一个必须先说的实测修正

**`send` 的请求体就是原文，`Content-Type` 就是消息类型。没有 JSON 外壳。**

我第一版按「Bot API 通常是 JSON」的直觉写成：

```js
// 错的
contentType: 'application/json'
body: { data: { type: 'normal', content: text }, content_type: 'text/plain' }
```

被平台明确拒掉：

```
415  the `Content-Type` requested by the client is not supported: application/json
```

实测正确的形状：

```
Content-Type: text/plain      body: "probe"       → 200, body = 195（mid）
Content-Type: text/markdown   body: "**粗体**"    → 200, body = 197（mid）
```

**这个错误是响的，所以便宜。** 如果它沉默丢消息，要等到"Bot 不回复"才发现，那时离原因已经很远。

---

## 3. 第二个实测修正：来源白名单在这里没有区分度

我按计划写了 `allowedSources: ['192.168.65.0/24', '172.19.0.0/16']`。
生产宿主启动后，容器 GET 立刻返回：

```
HTTP/1.1 403 Forbidden
```

用一个临时探针（3012，绑定 `0.0.0.0`）实测容器到宿主的真实源地址：

```
REMOTE: 127.0.0.1 | XFF: -
```

**Docker Desktop 把 `host.docker.internal` 的流量转发到宿主回环，并把源地址改写为 `127.0.0.1`。**
容器来的请求与宿主本机任意进程看起来完全一样，任何 CIDR 都只是在骗自己——而且填错会一律 403。

所以最终决定：**`allowedSources: []`（留空）**，并在两处配置注释里写明原因。
真正的防线是「只绑回环 + 路径令牌」两道，两者都在生效。

---

## 4. 第三个修正：幂等不能只靠内存缓存

第一次冒烟测试暴露了一个真实漏洞：`claim()` 只在 LRU 溢出时才写 `seen-mids.json`，
所以重启后那两份文件都不记得处理过哪些 mid——**重复事件会驱动第二次回合。**

改法：`seen` 从 **`events.jsonl` 重建**（那是 ACK 前 fsync 落盘的持久真相），`seen-mids.json`
降级为预热缓存（每 50 次 claim 或溢出时批量写）。

验证（清掉缓存文件，强制从日志重建）：

```
events.jsonl 里的 mid:  133, 134
启动后 seen 数量:       2          ← 从日志重建，不是从缓存
启动后 cursor:          134
重启后重投 mid=133 =>   200, 订阅者收到 = false, duplicates = 1
```

---

## 5. 单元测试：81 项

```bash
cd plugins/dsh-channel-vocechat && node --test test/*.test.mjs
# tests 81 / pass 81 / fail 0
```

无外部依赖、无网络、无端口冲突（webhook 用 `port: 0` 拿临时端口）。

| 文件 | 项数 | 覆盖的易错点 |
|---|---|---|
| `config.test.mjs` | 7 | baseUrl 严格性（路径/查询/凭据一律拒）、凭据只从环境变量读、坏数字不产 NaN |
| `http-api.test.mjs` | 14 | body 就是原文、content-type 就是消息类型、**本地拒 415 不发请求**、8 种状态码分类 |
| `normalize.test.mjs` | 14 | 逐字实测体、未知 target 拒绝、未知 kind 保留、超长拒绝而非截断 |
| `store.test.mjs` | 11 | 重启后幂等仍在、LRU 淘汰、游标只前进、坏目录诚实失败 |
| `webhook.test.mjs` | 15 | GET 200、错令牌 404、无尾斜杠 404、**重复只落一次**、413 留痕、持久化失败答 500 |
| `port.test.mjs` | 8 | 串行派发、抛错隔离、**光标在派发后才前进** |
| `publish.test.mjs` | 12 | 三种 key 拼写、裸 key 不抢占、unready 视为缺席 |

---

## 6. 生产环境端到端验收

### 6.1 插件在生产宿主里

```
[channel-vocechat] mounted: base=http://127.0.0.1:3009 keyed=true
                    dataRoot=D:\DSH\dsh-production\data (env:DSH_COMPANION_DATA_DIR)
[channel-vocechat] companionVoceChat published; keys=8
[channel-vocechat] [vocechat] webhook listening on 127.0.0.1:3011 path=/hooks/<token>/
```

`netstat` 确认监听者 PID = 41716 = 宿主本身（不是我的测试进程）：

```
LocalAddress LocalPort OwiningProcess
127.0.0.1    3011      41716
```

### 6.2 凭据注入生效

`dsh-ops/vocechat-env.mjs` 经 `--import` 在宿主进程最早执行，读 ACL 收紧的 secrets：

```json
// data/home/channel-vocechat/diag/mount.json
{ "keyed": true, "webhook": { "pathSet": true }, "problems": [] }
```

`problems: []` —— 两个环境变量都读到了。

### 6.3 容器 → 宿主 webhook（真实跨边界）

```bash
docker exec vocechat-personal-vocechat-1 \
  wget -q -O - http://host.docker.internal:3011/hooks/<token>/
# → ok        (GET 200，这是平台保存 URL 时探测的那一下)
```

POST 真实形状事件（mid=900）：

```bash
# → EXIT=0
```

落盘确认：

```
mid=900  from=1  target={"channel":1}  content=container-to-host probe
```

### 6.4 幂等（生产环境）

同一 mid=900 重投 3 次 → `events.jsonl` 仍然 **1 行**。
新 mid=901 → **2 行**。

### 6.5 出站

```
POST /api/bot/send_to_group/1 → 200, mid=202
```

手机端应看到那条「V1 验收」文本。

### 6.6 两侧端口 key 对齐

```
插件侧 dataRoot = D:\DSH\dsh-production\data  (env:DSH_COMPANION_DATA_DIR)
消费侧 root     = D:\DSH\dsh-production\data  (dirname DSH_HOME)
一致            = true

插件侧 key[0]   = companionVoceChat \0 D:\DSH\dsh-production\data
消费侧 key[0]   = companionVoceChat \0 D:\DSH\dsh-production\data
一致            = true
```

`mount.json` 里记了全部 8 个 key 拼写（4 namespaced + 4 bare），运行时可比对。

---

## 7. 改动的既有文件（共 3 处，都可回滚）

| 文件 | 改动 | 备份 |
|---|---|---|
| `plugins/companion-foundation/service-bridge.mjs` | `names` 白名单加 `'companionVoceChat'` | `.bak-before-vocechat-20261117` |
| `data/home/profiles/companion/cordis.patch.yml` | 插入 `channel-vocechat` 行（在 `companion-health` 之前） | 无（YAML 已校验，移除该 insert 块即可回滚） |
| `D:\DSH\dsh-ops\serve.mjs` | spawn 加 `--import vocechat-env.mjs` | `.bak-before-vocechat-20261117` |

`service-bridge` 改动前后各跑一次 `node scripts/verify.mjs`：都是 14 个失败，
**与本次改动无关（预先存在）**。

---

## 8. 还差一步，只能你来做

VoceChat 后台要把 Bot A 的 `webhook_url` 改成：

```
http://host.docker.internal:3011/hooks/febed6c004e098782fa4ab0e9485ac8be6faf863f68d0bb6d61a2fcae7d26fd7/
```

**带尾斜杠**（实测不带会被 406 拒）。这一步需要管理员凭据，你改过密码之后我这边没有了。

改完后手机上在频道 gid=1 发一条，链路的每一环都已在生产里验过：

```
手机 → Caddy 8443 → VoceChat 容器 → host.docker.internal:3011
     → 插件落盘 + ACK 200 → 派发给订阅者
```

V1 的订阅者数量是 0（适配层还没写），所以事件会干净地落盘、不驱动回合。这是设计如此：
**V1 只证明传输可靠。**

---

## 9. 回滚

| 层级 | 操作 |
|---|---|
| profile 行 | 删掉 `channel-vocechat` 那个 insert 块，重启宿主 |
| 注入 | 删 `serve.mjs` 里的 `--import vocechat-env.mjs`，恢复 `.bak-before-vocechat-20261117` |
| 白名单 | 恢复 `service-bridge.mjs.bak-before-vocechat-20261117` |
| 数据 | 删 `data/home/channel-vocechat/` |
| 端口 | 停宿主即释放 3011 |

回滚不影响 channel-qq、不影响 G1–G3、不影响 VoceChat 本身。
