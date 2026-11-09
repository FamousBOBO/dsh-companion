# 12a · 生产环境配置复制与本机测试基线（P9-G0）

> 对应《NapCat 群消息镜像与隔离测试实施计划》§G0「环境审计、基线与生产变更最小化」。
> 本轮只做 **G0 + 一次独立的代码修复**；G1（SSE 镜像）、G2（假 OneBot WS）、G3（mirror-only 运行时）
> **尚未开始**，见 §6。

**生产环境全程只读。** 本文不记录任何 Token、密钥、完整 QQ 号、群号与聊天正文。

---

## 1. 这一轮做了什么

| # | 事项 | 结果 |
|---|---|---|
| 1 | 生产侧只读基线（进程、连接、文件哈希） | 完成，见 §2 |
| 2 | 用仓库自带的迁移工具从生产**只读导出**记忆与身份 | 完成：1037 条记忆、6 页 wiki、身份绑定 |
| 3 | 导入本机测试套件，人格列按迁移工具规则改写 | 完成：1037 条全部归到本机人格作用域 |
| 4 | 复制人格正文与记忆检索配置 | 完成，见 §3.2 |
| 5 | 复制模型供应商（provider / model / 推理档位） | 完成；**密钥只以内联引用名出现**，值在本机 gitignore 的凭据文件里 |
| 6 | 修掉计划 §1 指出的第二处缺陷（说完后读话题的旧降级路径） | 完成，3 例新测试，见 §5 |
| 7 | 生产侧零写入核对 | **7 个文件哈希未变**；1 个变化查清是生产自己写的，见 §2.3 |

---

## 2. 生产侧只读基线

### 2.1 拓扑（脱敏）

| 项 | 值 |
|---|---|
| 宿主版本 | 0.2.1-rc.3 |
| 宿主形态 | 桌面版 CLI 直接跑 `--profile` + `--patch`，端口 3100，仅本机 |
| NapCat 版本 | 9.9.32 |
| NapCat 与生产的连接 | 一条**正向 WebSocket 服务端**（本机回环端口），`messagePostFormat: array`，**未**开启 `reportSelfMessage` |
| 同机其它 OneBot 连接 | 另有一条反向 WS 客户端连到 bot 侧（与本套件无关，未触碰） |
| 事件型连接（SSE / Webhook） | **当前一条都没有**（`httpSseServers` / `httpClients` 均为空数组） |
| 生产 Token | 已设置（值不记录） |

这一条对 G1 很重要：**新增 SSE 连接不需要改动任何现有连接**，属于纯增量。

### 2.2 生产侧关键文件（复制前基线）

| 文件 | 字节 | 前 16 位 SHA-256 |
|---|---|---|
| `config/suite.json` | 2195 | `FA6BAA42F1D3E788` |
| `config/persona.md` | 12417 | `CB0598ED42602113` |
| `config/profile/companion.patch.yml` | 8984 | `B65FA03D48827ACE` |
| `data/home/.credentials.yaml` | 622 | `2FCBBE21C66D7B54` |
| `data/home/companion/memory.config.json` | 1252 | `E20289322C3F1493` |
| `data/home/companion/remote-models.json` | 202 | `093BD3094D98497B` |
| `data/home/companion/identity.json` | 8425 | `15AE76BD36259965` |
| `data/home/memory/conversation.jsonl` | 871433 | `0C94EB5014640FC2` |

（记忆库 `companion-memory.db` 被宿主持有，无法取哈希；导出时用 `VACUUM INTO` 做一致性快照，
`PRAGMA quick_check` 返回 `ok`。）

### 2.3 零写入核对：7 个未变，1 个变化且不属于本次操作

复制完成后重新取哈希：**前 7 个文件全部与基线逐字节一致**。
`data/home/memory/conversation.jsonl` 变了。查清过程：

1. **不是我的路径写的。** 我全程只经迁移 CLI 读生产：它以只读方式打开源库，`VACUUM INTO` 写到
   迁移包目录，没有对生产数据目录执行过任何写操作。
2. **时间线对不上我的操作。** 我被要求做复制是在 01:11；该文件在 01:57–01:59 被追加了 3 条记录；
   我的导出在 01:36、导入在 01:46 与 02:10。
3. **记录来源指认了写者。** 新增的 3 条记录 `source` 都是 `desktop_conversation`，会话是 QQ 私聊、
   `persona` 是生产那套人格 id。也就是说：**生产宿主当时正在处理一次真实的 QQ 私聊对话**
   （同一秒 `memory-engine.jsonl` 也在写），三次追问的正文字数分别约 621 / 170 / 29。
4. **采样窗口验证**：之后连续采样 60 秒，文件 0 字节增长；生产宿主进程（PID 与启动命令）与我操作前一致。

结论：这 3 条是生产自己在那个时间窗内产生的对话记录，不是复制动作写进去的。
**但它说明一件事**：生产当时是活的、在接真实消息，所以后面任何需要触碰生产配置的动作
（例如 G1 的新增 SSE 连接）都必须挑时间，并按计划 §6 准备回滚。

---

## 3. 复制了什么、怎么复制的

### 3.1 记忆与身份：走仓库自带的迁移工具（不是手工拷文件）

用 `npm run migrate` 而不是 `Copy-Item`，因为它自带三条我要的保证：源库**只读**打开、
`VACUUM INTO` 一致性快照、以及一份说明「搬了什么 / 丢弃了什么」的清单。

导出（生产只读）：

    $env:DSH_COMPANION_DATA_DIR = '<生产 data 目录>'
    node tools/migrate/cli.mjs export --out <迁移包> --domains memory,memory-wiki,identity

导入（本机测试套件）：

    node tools/migrate/cli.mjs import --from <迁移包> --identity adopt --yes

| 内容 | 迁移包里的量 | 导入后本机 |
|---|---|---|
| 记忆条目 | 1037 | 1037 |
| 记忆证据 | 1177 | 1177 |
| 向量 | 1794 | 1794 |
| 源事件 | 2589 | 2589 |
| wiki 页 | 6 | 6 |
| 身份绑定 | 1 条（QQ 平台 + 10 位主人号 + 昵称） | 1 条 |
| 会话绑定 | **丢弃 44 条**（迁移规则：宿主会话属于本机） | 0 条 |

导入还自动做了一件事：**把人格列改写成本机的人格 id**（`personaRowsRewritten: 3627`），
身份文件里的 `persona` 字段同步改过来。这是迁移工具的既定行为，也是「记忆作用域」能对上的前提。

> 我第一次导入时把本机 `persona.id` 改成了生产的那个值，结果仓库里 27 个既有测试红了
> （它们以本机缺省人格 id 为前提）。正确做法是**保持本机 id、让迁移工具改写数据**，
> 已经回退并按正确方式重做。这条值得记下来：人格 id 是作用域键，不是「人格本身」。

导入后核对（只读）：

- `PRAGMA quick_check` → `ok`；
- 1037 条记忆全部落在本机人格作用域，没有残留旧作用域的行；
- 按 scope：角色自身 499 / 用户与角色关系 369 / 用户全局 120 / 近期会话 42 / 角色扮演世界 7；
- 按 kind：角色行为 357 / 摘要 268 / 产物 120 / 画像 68 / 事件 60 / 关系 55。

### 3.2 人格与记忆配置

| 项 | 处理 |
|---|---|
| `config/persona.md` | 用生产那份覆盖（12417 字节）。本机原文件是 1241 字节的模板占位，已备份到 `data/backups/persona.before-prod-copy.md` |
| `config/suite.json` 的 `persona.id` | **保持本机缺省值**（理由见 §3.1 的注） |
| `data/home/companion/memory.config.json` | 复制生产结构（backend / wiki / 检索参数 / 限额），但 **`embedding` / `rerank` / `extraction` 先关**：语义检索要额外付费，记忆提取会往库里写东西，两件都该单独授权 |

### 3.3 模型供应商

生产用的是宿主的多 provider 适配层加一个默认模型条目。这一段是**本机选择**，不属于随仓库发布的模板，
所以放在**生成物**补丁里（已 gitignore），而不是模板里。

| 项 | 值 |
|---|---|
| 默认 provider | `opencode-go` |
| 默认模型 | `deepseek-v4.1-flash` |
| 推理档位 | `high` |
| 上下文窗口覆盖 | 524288 |
| 备选 provider | `open-design`（OpenAI 兼容，两个模型，含 `-eco` 变体） |
| 密钥引用名 | 两个（`OPENCODE_GO_API_KEY` / `OPEN_DESIGN_API_KEY`）——**只有名字进了文件** |
| 密钥值 | 在 `data/home/.credentials.yaml` 的 `refs:` 段（gitignore）。**只搬了这两条模型密钥**；生产的 `records:`（浏览器会话、设备、平台账号登录态）一条都没搬 |

验证（三步，全部真的跑了）：

1. **合成**：`dsh --profile companion --patch … --dump-config` 能读到这两个条目，密钥只以引用名出现；
2. **凭据解析**：用宿主的 YAML 解析器读本机凭据文件 → `refs` 两条、长度正确、`yaml errors: []`；
3. **真实补全**：起一个 headless 宿主进程问「只回答两个字：收到」，返回 **「收到」，退出码 0**。
   这一步同时证明：provider 路由通、凭据解析通、模型真的被调到。

> 一个坑：headless profile 里凭据服务默认 `disabled: true`（主要为 web 面板准备），所以只带模型 overlay 时
> 第一次报 `MISSING_CREDENTIAL`；补一行 `disabled: false` 之后就通了。`npm run start`（web profile）不受影响。

---

## 4. 隔离状态：本机测试套件现在**不具备**任何 QQ 能力

这一条必须在 G1 之前钉死，否则后面接镜像就是往一个能发消息的环境里接真实群。

| 检查点 | 状态 |
|---|---|
| `config/suite.json` → `modules.qq` | `false` |
| `services.onebot.url` | 空串 |
| `services.onebot.accessToken` | 空串 |
| `services.onebot.selfId` | `0` |
| `safety.*`（autoSend / autoComment / backgroundModelTasks / healthCollection / billingApis） | 全部 `false` |
| 用户级 / 机器级环境变量里的数据目录指针 | 全部未设置 |
| 本机 `npm run doctor` | 37 项全过，其中明确报告「QQ 通道未启用——自然不会有任何动作或外发」 |

另外：本机 `data/home` 下**没有**任何生产侧登录态（生产的 `records:` 未搬），两边的凭据文件不同源。

---

## 5. 顺带修掉的一处缺陷（计划 §1 的第二项）

计划 §1 指出：`afterSpeak` 那条链路读话题走的是旧的 `timelines.view().topic()`——
那是「唯一活跃群时给数据」的降级路径，**两个群同时有消息时返回 `null`**，
于是「说完之后贴表情 / 落地话题」那一层拿不到话题。

修复：改成 `scopedView().topic(input.groupId)`。本来就知道群号（`onSpoken` 的入参里就有），
没有理由退回到猜。

测试：`test/presence-topic-scope.test.ts` **3 例**。其中第二例是核心——它先断言
**旧路径在两个群时确实返回 `null`**（把 bug 钉在原地），再断言带群号能读到、且两个群的话题不是同一句。
这比只测「新代码能读到」更有价值：将来有人改回去，第一句就红。

> 计划 §1 的第一项（无效 `presence.mode` 在 `enabled:true` 时可能回退 `live`）在 P9-A1 处理过：
> 现在 `mode` 缺省是空串，「没指定」与「写错了」都由 `resolveMode` 退回 `enabled` 口径并留一行诊断。
> 但**镜像测试环境仍应独立否决**——那属于 G3，不在本轮。

---

## 6. 没做的事（G1 及之后全部未开始）

| 阶段 | 状态 | 前置 |
|---|---|---|
| G1 SSE 只读镜像源 | **已完成**（见 [12b](12b-napcat-mirror-operations.md)） | NapCat 已新增一条 SSE 连接（127.0.0.1:3002），只增不改 |
| G2 本机假 OneBot WS + 全动作阻断 | **已完成** | 39 个已知动作 + 未知动作全部拒绝并被测试钉住 |
| G3 mirror-only 运行时 | **未开始** | 依赖 G1、G2 |
| G4 观测与盲评 | **未开始** | 依赖 G3 的真实数据 |
| G5 接真实 SSE + 探针 | **未开始** | 需要授权 + 避开生产高峰 |
| G6 文档与验收 | **未开始** | 依赖 G1–G5 |

**本轮没有连接任何真实 NapCat 事件流，也没有让任何进程具备 QQ 出站能力。**

---

## 7. 风险与回滚

### 7.1 本轮引入的本机状态（都可独立清除）

| 状态 | 位置 | 清除方式 |
|---|---|---|
| 生产人格正文 | `config/persona.md` | 用 `data/backups/persona.before-prod-copy.md` 覆盖回去 |
| 生产记忆与 wiki | `data/home/memory/` | 删掉 `companion-memory.db*` 与 `wiki/`；`npm run setup` 会重建空库 |
| 身份绑定 | `data/home/companion/identity.json` | 删除即可（宿主会重新绑定，或再跑一次迁移） |
| 记忆检索配置 | `data/home/companion/memory.config.json` | 改回 backend sqlite + extraction 关 + embedding/rerank 关 |
| 模型供应商两段 | `config/profile/companion.patch.yml` 第 9 节 | 删掉那一节；或 `npm run setup` 重新渲染（会先备份旧版本） |
| 模型密钥两条 | `data/home/.credentials.yaml` | 删掉那两条 `refs` 条目 |

### 7.2 生产侧回滚

**没有需要回滚的东西**——本轮对生产只做了读。若 G1 真的新增了 SSE 连接，回滚顺序按计划 §6：
停镜像进程 → 停测试宿主 → 删掉新增的那条 NapCat 连接 → 核对原生产 WS 配置与在线状态。

### 7.3 风险清单（G1 之前必须看）

| 风险 | 说明 |
|---|---|
| 生产是活的 | §2.3 已证明当时有真实对话在跑。改 NapCat 配置必须挑空窗，改完立刻核对原 WS 仍在线 |
| 模型额度共享 | 两个环境用同一套 provider 与密钥。镜像评测会增加调用量与限流竞争，**不是**资源隔离 |
| 记忆不共享 | 复制的是一份**快照**。生产之后新增的记忆不会同步过来；测试期间她「记得」的是复制那一刻的事 |
| 语义检索能力 | 已打开（见 12b §3），会产生 SiliconFlow 计费调用；与生产同 provider，但额度共享 |
| 人格 id 已改写 | 本机记忆的人格列是本机 id，生产是生产 id。跨环境比对时必须记得这层映射 |

---

## 8. 证据级别

| 级别 | 本轮 | 说明 |
|---|---|---|
| `offline-test` | ✅ | 新测试 3 例；channel 套件 1635 例、`npm run verify` 三段全绿 |
| `host-load` | ✅ | 真的起了两次宿主进程（一次 `--dump-config` 合成、一次 headless 真实补全），退出码 0 |
| `real-api` | ⚠️ 仅「通了」 | 一次真实模型补全、三次真实 embedding。**这不是评测**：没跑语料、没统计 |
| `real-send` | ❌ | 零次。本机 `modules.qq=false`、OneBot 地址为空 |
| `real-inbound` | ❌ | 零条。没接任何镜像事件 |

**不要把这轮读成「镜像链路可用」**：它只证明「测试环境里有生产的记忆、人格和模型路由」，
而计划真正要的东西（真实群消息进来、真实模型决策、零出站）一条都还没验证。

---

## 9. 下一步（需要操作者决定）

1. **G2 可以先做，不需要任何授权**：本机假 OneBot WS + 全动作阻断反证（计划 §4 的 T01–T14 里有 11 条完全离线就能跑）。
   这一步做完，「测试进程没有 QQ 出站能力」才是被证明过的，而不是被声明的。
2. **G1 需要你在 NapCat 里新增一条 SSE 连接**（现在是零条），并明确许可改动生产配置。
   改之前需要确认：端口、路径、Token（只看是否设置，不写进任何文件）、以及是否避开高峰。
3. **语义检索要不要打开**：本机现在是 `off`。打开会产生 SiliconFlow 的计费调用，需要单独授权。

我的建议顺序：**先 G2（离线、零风险、能证明隔离）→ 再 G1（动生产配置）**。计划写的顺序也是这个，
理由是把「能不能拦住」证明在前面，比把「能不能连上」证明在前面安全得多。
