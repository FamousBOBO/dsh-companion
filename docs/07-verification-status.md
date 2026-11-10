# 07 · 验证状态

> 这份文件的唯一职责是**防止把「没验证」说成「验证过」**。
> 读它的方式：每个能力先看「到哪一级」，再看「证据在哪、什么时候」。**没到就是没到。**

## 1. 五级证据（固定词汇，不自创）

### 2026-11-11 集成测试补充

本次为独立测试分支，未替换生产部署。详细证据见 [集成与迁移报告](17-integration-test-20261111.md) 和 [镜像旁听报告](18-mirror-observe-integration.md)。

| 范围 | 证据级别与结果 | 限制 |
|---|---|---|
| 提醒第二轮、群聊运行时、Prompt Engine、衣柜与视觉身份集成 | `offline-test`：最终 verify 的 unit 9 / static 38 / compose 1 通过；1 个包无测试；镜像专项 38 项通过 | 不代表真实模型质量或平台发送通过 |
| 独立 DSH 0.2.2-rc.1 宿主 | `host-load`：实际启动、陪伴 API 与会话创建成功；浏览器已渲染首页、人格、设置及迁入资料统计 | 桌面工作区注册仍受原生文件夹窗口激活失败阻挡 |
| 昼夜衣柜与 Prompt Engine 组合 | `host-load`：四组实际宿主请求捕获；同一时段在引擎关闭/启用时衣柜文本一致，昼夜结果不同 | 使用本机模拟模型，无真实计费调用 |
| 镜像旁听 | `offline-test` + `host-load`：模拟群事件经实际宿主形成 shadow 记录，禁止动作尝试为 0 | 未证明真实流量、重启和真实模型决策质量；集成配置 QQ 关闭 |
| 标准生产资料迁移 | 六个文件导入，身份沿用；三个数据库 quick_check 与源表记录数核对通过；人格另行备份后复制 | 不含凭据、桌面会话、聊天原文和媒体；提醒不重放，健康授权重置 |

本轮未新增 `real-api`、`real-send` 或 `hardware` 证据。

| 级别 | 定义 | 什么样的证据才算 |
|---|---|---|
| `offline-test` | 离线单元 / 集成测试通过 | 有可复现命令 + 通过计数 + 日期 |
| `host-load` | **宿主实际加载**成功（插件被 DSH 装载、服务注册完成、无加载错误） | 宿主启动日志里的装载记录，或 `--dump-config` 合成结果 |
| `real-api` | 真实外部 API 调通（模型 / TTS / 生图 / 向量 / 聚合数据） | 一次真实请求的成功响应 + 时间 |
| `real-send` | 真实平台**发送成功** | 平台返回的消息 id，或可复核的页面上线 |
| `hardware` | 真机硬件实测 | 设备名 + 读数 + 时间窗口 |

### 1.1 三条不许跨的等号

1. **CI 绿 ≠ 桌面实机验证**。CI 跑的是 `npm ci → npm run build → npm run verify` 的**离线**部分，
   没有 DSH 桌面、没有模型、没有 QQ、没有手环。
2. **CI 绿 ≠ `compose` 通过**。`compose`（`--dump-config` 合成）必须有真实宿主；CI 里它**永远 SKIPPED**
   且不判失败。CI 只能证明安装/构建/离线测试/静态卫生（细节见 §2.1.1）。
3. `offline-test` 通过 ≠ `host-load` 通过。测试跑在 Node 里，宿主装载是另一条路径
   （isolate realm、服务注册、profile 合成都可能失败）。
4. `配置已保存` ≠ `连接成功` ≠ `真的发出去了`。三者是不同状态（`docs/02` §6）。

## 2. 当前状态（发布树，2026-11-05）

### 2.1 套件骨架 / 部署链路 / 宿主装载

**证据锚点**：提交 `cebcb84`（随后打 `v0.1.0`）· 环境 Windows · `node v24.14.0` · `npm 11.9.0` · 宿主 `0.2.1-rc.3` · 日期 2026-11-05。

三组独立验收（A 干净克隆 / B 工作区 / C 全新数据目录）：

| 能力 | 级别 | 证据 | 说明 |
|---|---|---|---|
| 文档体系（`docs/01`–`07`） | — | 本仓库 | 文档不是证据。引用到的行为以脚本实现为准 |
| CI 工作流（`.github/workflows/ci.yml`） | **未运行** | 文件存在，YAML 结构已校验 | 尚未在 GitHub 上跑过。见 §2.1.1 关于 `compose` 在 CI 里必为 SKIPPED |
| `git clone` → `npm ci` | **`offline-test`** | **A 段**：干净克隆（克隆内 `git ls-files` = 1296 文件）→ `npm ci` **exit 0 / 2.7 s** | 路径为 `<临时目录>/含 空格 and CJK/dsh-companion`（**同时含空格与非 ASCII**） |
| `npm run build` | **`offline-test`** | **A 段**：**exit 0 / 8.5 s**（channel-qq、memory-studio、media 三个模块构建） | 同上路径；仓库只存源码，此步必然存在 |
| `npm run verify`（离线部分） | **`offline-test`** | **A 段**：**exit 0 / 44.0 s**；`unit` 8 模块通过 / 0 失败 / 1 无测试；`static` **25 项通过 / 0 失败**（扫描 1296 个文件）；`compose` **SKIPPED**（原因：未检测到 DSH 宿主——干净克隆里没有 `config/suite.json`，这一项天然跳过） | 同一路径形态 |
| **发布前静态卫生：克隆地址不再误报** | **`offline-test`** | 2026-11-08（`feat/group-social-p0`）：为**本仓库自己的公开克隆地址**在 `author-name` 规则里加了唯一一条内建例外（§6.4b），并加 3 条自检项防放宽。本机实跑：`node scripts/verify.mjs --only=static` → **32 项通过 / 0 失败**；`npm run verify` → `unit` **9 通过 / 0 失败 / 1 无测试**、`static` **32 通过 / 0 失败**、`compose` **通过（194 个 loader 行）** | 修复前 README 的克隆命令会被 `author-name` 命中，`main` 的 CI 三平台因此全红；README 里的命令未改动 |
| **路径形态：含空格 + 含中文（非 ASCII）** | **已实跑通过** | A 段整体 | 这条曾经是**红的**：验收脚本抓出过两个真 bug（`npm_config_workspaces` 泄漏与 `--workspace` 冲突；测试里用 `new URL(...).pathname` 取路径，在含空格/中文目录下拿到 `%E5%90%AB%20…` 编码串导致 ENOENT）。修复后转绿 |
| **路径形态：跨盘符 + 含空格 + 含中文（同一次）** | **已实跑通过** | **D 段**：在**另一个盘**（`E:`，套件在 `D:`）建 `…\含 空格 and CJK\dsh-companion`，`git clone` exit 0 → `npm ci` **exit 0 / 2 s / 27 个包** → `npm run build` **exit 0** → `npm run verify` **exit 0**（`unit` 8 通过 / 1 无测试、`static` 25 通过、`compose` SKIPPED 同前）；测完目录已删除 | 三种形态在**同一次**验收里同时命中 |
| 路径形态：深层嵌套（8 层 / 122 字符） | **部分验证**：克隆 + **套件根解析**已实跑通过（`tools/lib/paths.mjs#SUITE_ROOT` 解析出的正是那 122 字符路径，未被截断/跳层）；**完整 `npm ci`/`build`/`verify` 未在该形态下跑** | E 段 | 不要读成「深层路径整条通过」——只验证了克隆与路径解析 |
| 路径形态：网络盘 / UNC | **未验证** | — | A/D/E 段都没覆盖 |
| `npm run setup` | **`host-load` 前置**（脚本成功执行） | **C 段**：`exit 0`（从默认 `web` profile 创建 `companion`；安装 `@dsh-companion/memory-studio` bundle）。数据目录为**全新空目录** | setup 成功不等于装载成功，真正的装载证据在下面两行 |
| `npm run doctor` | **`host-load`** | **C 段**：`exit 0`，`结论：核心检查通过（注意 0、未就绪 0、共 37 项）`；`profile 合成 — 311 个条目，135 ms`；`补丁引用的插件文件 — 2 个 file:// 入口全部存在`；`companion 预设是否挂上 — preset-companion 与 workspace-context 均在合成结果里` | — |
| `compose`（`--dump-config` 合成） | **`host-load` 的一部分** | **B 段**：`compose` **通过**，合成 **194 个 loader 行**；与 C 段 doctor 的「311 个条目」互相印证 | ⚠️ 这一项**在 CI 里必定 SKIPPED**，见 §2.1.1 |
| `npm run start` 端到端（起得来 → UI 可访问 → 能干净停止） | **`host-load`** | **C 段**：就绪后本地地址 `http://127.0.0.1:3080/?token=…`，对该 URL **GET 返回 HTTP 200 / 38252 字节**；`npm run stop` **exit 0**（`已停止 PID 53444`），**3080 端口 2 秒内释放** | 启动日志 484 字节，**没有任何 `did not activate`** —— 见下一行 |
| 核心五模块 + 陪伴空间 Web UI 的**真实装载** | **`host-load`** | **C 段**启动日志（脱敏后全文三行）：<br>① `[workspace-context] disabled: no home/companion/workspace-context.json …`（可选插件，默认关，预期行为）<br>② `[companion-foundation] no identity.json … created the default local owner (owner=local-owner, persona=bot)`<br>③ `dsh web: http://127.0.0.1:3080/?token=…` | 关键是**没有一条 `did not activate`**：这直接证明「空 `data/` 下 studio 挂不上」那个缺陷在真实宿主上已解决 |
| **预设可用性 + 首次配置路径**（不是"能打开 URL"） | **`host-load`** | **F 段**（2026-11-05，提交 `87cbfdc`，从远端重新克隆到含空格+中文的目录，**未预设任何 `DSH_COMPANION_*` 变量**）：启动日志 `[companion-foundation] mounted; memory backend=sqlite`；行为探针 7/7 通过——`agentPresets/list` 里 `companion` **无 `broken`**、`session/create` 返回 `ok:true` 并给出 `session-…`；`summary`/`memories`/`settings`/`companion` 四个接口均 **HTTP 200 且 `body.ok=true`**；`npm run setup` 第二次运行后三处配置**逐字节未变** | 这一行专门守两个曾被误判为通过的陷阱：**HTTP 200 ≠ 业务成功**（要看 `body.ok`），**启动 URL ≠ 预设可用**（要问 `agentPresets/list` 并真建一个空会话）。探针不发提示词，故不涉及模型调用 |

> **A / B / C / D / E 分别是什么**：A = 干净克隆（只含已提交内容，路径含空格+中文）；B = 配好宿主的工作区；
> C = `DSH_COMPANION_DATA_DIR` 指向**全新空目录**后走 npm scripts 的真实启动；
> D = **另一个盘**上的干净克隆（跨盘符 + 空格 + 中文，同一次）；E = 深层嵌套路径下的克隆 + 套件根解析；
> F = 从远端重新克隆到含空格+中文的目录、**不预设任何 `DSH_COMPANION_*` 环境变量**、按文档顺序跑完整流程并做行为探针（2026-11-05，提交 `87cbfdc`；复跑脚本见 `release-tools/validate-fresh.mjs`）。
>
> 本节仍然只能说明「**在 Windows + 宿主 0.2.1-rc.3 上跑通了这些**」。它**不是** Linux/macOS 的证据，
> 也**不是** `real-api` / `real-send` / `hardware` 的证据。

#### 2.1.1 `compose` 与 CI 的关系（必读，别把它当通过）

- `compose` = 用真实宿主做 `--dump-config` 合成检查，**必须有 DSH 宿主**。
- **CI 里没有宿主**，所以 CI 上的 `compose` 永远输出 `SKIPPED`，且按设计**不判失败**。
- 因此：**「CI 绿」≠「compose 通过」**。CI 只能证明安装、构建、离线测试、静态卫生；
  「配置能被真实宿主合成」这件事只在有宿主的机器上（如本节的 B/C 段）才算证据。
  这与 §1.1 的「CI 绿 ≠ 桌面实机验证」是同一条纪律的两个侧面。


### 2.2 迁移工具（`tools/migrate`）

| 能力 | 级别 | 证据 | 日期 |
|---|---|---|---|
| 迁移 CLI 参数解析 / 禁止域 / 脱敏 / 校验和 / 事务备份 / 身份裁决 / 提醒不重放 / 宿主占用拒绝 | **`offline-test`** | `node --test tools/migrate/test/migrate.test.mjs` → **10 项全过**（含：禁止 `credentials` 域 exit 2、会话绑定与消息正文不出包、篡改包 exit 2、`--dry-run` 不写盘、导入先备份、人格 id 映射（旧 id → `bot`）改写、提醒置 `fired+paused`、pid 活跃时拒绝导入、WAL 新鲜判活） | 2026-11-05 |
| 在**真实数据副本**上的行为 | **`offline-test`（真实形态）** | `export`（976 条记忆，`VACUUM INTO` 快照 + `quick_check=ok`）→ `check`（`verdict=same`，给出 `persona-id-mapping` 警告）→ `import --dry-run`（列出 5 个 willWrite / 5 个 willBackup / rebind 六项）。**未做真实 import**：目标数据目录未被改动 | 2026-11-05 |
| 真实导入端到端 | **未验证** | — | 需要一台干净的目标机器 + 真数据；本次只在合成夹具上做过完整 import |
| Linux / macOS 上跑迁移 | **未验证** | — | 纯 Node 逻辑，未在非 Windows 平台实跑 |

### 2.3 各模块

逐模块的详细证据由各模块负责人提交（`release-tools/` 下的交接报告）。本表只记录**已经汇总到本文**的部分：

| 模块 | `offline-test` | `host-load` | `real-api` | `real-send` | `hardware` |
|---|---|---|---|---|---|
| `companion-foundation` | **360 项 / 351 通过 / 0 失败 / 9 跳过**（2026-11-08；其中 Prompt Engine 新增 **146 项**，其余 214 项为原有测试，见 §2.8） | **✅ 已装载**（C 段：无 `did not activate`；日志出现它的 identity 初始化行） | 未验证 | — | — |
| `companion-memory` | **268 通过 / 0 失败** | **✅ 已装载**（C 段） | 未验证 | — | — |
| `companion-memory-studio` | **115 通过 / 0 失败** | **✅ 已装载**（C 段：UI 返回 HTTP 200 / 38252 字节） | 未验证 | — | — |
| `companion-runtime` | **697 通过 / 0 失败** | **✅ 已装载**（C 段） | 未验证 | — | — |
| `companion-group` | **10 通过 / 0 失败** | **✅ 已装载**（C 段） | — | 未验证 | — |
| `dsh-channel-qq` | **1355 项 / 1353 通过 / 1 失败 / 1 跳过**（2026-11-07 实测，`npm test`；唯一失败项是 `qq-idle-compaction` 的「默认关」用例，它读的是**本机** `config/suite.json`——本机确实把它打开了，`QQ_IDLE_COMPACTION=0` 时可复现通过，属环境相关而非缺陷） | **✅ 2026-11-07**（生产宿主上真实装载并连上 OneBot/NapCat：`data/home/channel-qq/connection-status.json` → `connected:true`；私聊与群会话都在跑） | 未验证 | **✅ 2026-11-07（含点歌语音条，见 §2.7）** | — |
| `companion-expression` | **206 通过 / 0 失败**（`test/*.test.mjs`，含 zip 21 / pack 22 / pack-import 9 / calibration 9 / ingest 15） | **✅ 已装载**（§2.6；主人私聊与群预设都装了它） | — | **✅ 2026-11-07（2 条，经 `qq_sticker` 实发；第 2 条回读 `sub_type=1` 才是真正的表情）** | — |
| `companion-media` | 通过（计数未单独汇总，B 段 `unit` 全绿） | 未验证（验收未启用该模块） | **✅ 2026-11-06**（生图真实出图，见 §2.5） | 未验证（投递仍由通道负责） | — |
| `companion-health` | 通过（计数未单独汇总，B 段 `unit` 全绿） | 未验证（验收未启用该模块） | 未验证 | — | 未验证 |
| `sidecars/huawei-health-cn` | 待汇总（含 `test_protocol_contract.py` / `test_redact.py`） | — | **未验证**（需要真实华为账号；代码路径与 MIT 许可已就位） | — | — |
| `sidecars/ble-heart-rate` | 待汇总 | — | — | — | 未验证 |
| `dsh-paste-search` | **无测试**（`unit` 记为「1 无测试」） | 未验证（验收未启用该模块） | — | — | — |
| ~~`dsh-super-injector`~~ | **未收录**（原因见 `docs/03` §1.2） | — | — | — | — |

> 「已装载」的依据是 **C 段真实宿主启动日志里没有一条 `did not activate`**，且 doctor 的 profile 合成
> 与 `compose` 都通过——不是「配置文件写对了」。**仍不等于能对话**：会话需要模型调用，那是 `real-api`。
>
> 「待汇总」= 负责人报告里的数字还没并进本文；**不要当成「已通过」**。

### 2.4 生产系统历史记录（**不是**本仓库的验收）

原作者那台机器在 2026-10/11 留下的记录（详见 `docs/03` §4.2）。它们证明「这条路径在某个版本上跑通过」，
**不能**作为本仓库的验收。列表里出现的 `real-api` / `real-send` / `hardware` 均属这一栏：

| 能力 | 历史级别 |
|---|---|
| 桌面陪伴对话（人格 + 记忆注入） | `real-api` |
| 记忆写入 → 检索 → 注入闭环 | `real-api` |
| QQ 私聊 / 群聊收发 | `real-send` |
| 提醒真发 | `real-send` |
| 主动联系（contact） | 仅到 `host-load` / 模拟 |
| B站自动评论（外部模块） | `real-send` |
| BLE 心率 | `hardware` |
| 华为健康聚合数据 | `real-api`（**原作者环境**） | 上游为 MIT、实现随包分发；但本发布树**还没有一次真实账号授权**的 `real-api` 证据 |
| 媒体生图 / TTS | `real-api`（投递通道是 mock） | 生图已在本发布树重新验证，见 §2.5 |

| 实时语音 sidecar | 隔离环境，延迟未达标 |

### 2.5 媒体生图：本发布树的 `real-api` 证据（2026-11-06）

**这不是 §2.4 的历史记录**：下面这次请求由本发布树的 `companion-media` 代码在 node 部署里发出。

| 项 | 值 |
|---|---|
| 环境 | Windows · `node v24.14.0` · node 宿主（`npm run start` 路径）· 2026-11-06 21:5x |
| 链路 | `companion-media` 适配器 → `http://127.0.0.1:8158/nai/ai/generate-image`（本机 media-compat 桥）→ `https://image.novelai.net/ai/generate-image` |
| 请求 | `nai-diffusion-5-full` · 832×1216 · 28 步 · `k_euler_ancestral` / `karras` · `params_version: 3` · 具体整数 seed |
| 响应 | **HTTP 200** · `application/zip` · 1,602,201 字节 · 13.6 s |
| 产物 | `data/workspace/media/image/e512de3b…png` · PNG 832×1216 · sha256 `e512de3b7734917238e0e5a60bf1a57e0d5fe88eb97846cf70e2504137bc4357` |

同一次排查里发现并修掉了一个真实协议缺陷：把配置默认的 `seed: -1` 原样发出去时，服务端返回
`HTTP 500 {"statusCode":500,"message":"Internal Server Error"}`（同一体换具体种子即 200/ZIP）。
现在发送前由 `resolveSeed()` 解析成 `0…2^32-1`，实际使用的种子写进产物 `seed` 字段。

**仍未验证**：图片投递到 QQ（`real-send`）、`openai-relay` 中转站形态、非 Windows 平台。

### 2.6 表情包系统（`companion-expression`）：`offline-test` + `host-load` + **一条 `real-send`（2026-11-07）**

按 §1 的五级词汇，**真实平台发图已经有过一条回执**（见「真实平台发图」一行）。其余各项级别照旧，不要读成「批量可用」：

| 项 | 级别 | 说明 |
|---|---|---|
| 采集授权判定、作用域隔离、sha256 物理去重 | `offline-test` | `node --test plugins/companion-expression/test/*.test.mjs` → **206 项通过 / 0 失败**（2026-11-07 实测 206/206/0）；未授权来源 0 下载、0 入库（用例钉住） |
| 下载安全（魔数判型 / 体积与像素上限 / SSRF / 重定向 / 文件名穿越） | `offline-test` | 全部用注入的假 `http`，**没有一次真实网络请求** |
| 检索、决策、冷却与配额、回复计划、幂等投递 | `offline-test` | 假 `qqSender`；`unknown` 不重投的用例在其中 |
| 反馈学习（`reject` 立刻抑制重发） | `offline-test` | — |
| **检索阈值可达性（`minFitScore` 不再是装饰）** | `offline-test` | `test/calibration.test.mjs` **9 项**。修复前 `searchFor()` 硬写 `{intents: [], scenes: []}`，意图/语气/语境三维恒为中性 0.5，完美语义匹配的天花板只有 **0.675 < 默认 0.72** —— 任何图库都发不出去。现在上下文由 `contextFromDraft()` 从草稿推导（情绪并入意图维、`avoidWhen` 当 `riskTags`），且**只有真的有信号的维度进分母**；完美匹配上限 **0.90**。用例钉住：真实卡 + 真实草稿判 `send`、无关草稿 abstain、稀释（`我好困啊` 0.6381）如实记录并 abstain |
| **整包导入（zip + 手工语义卡清单）** | `offline-test` | `src/zip.mjs`（零依赖只读解包：坏名字/超限/zip64/加密/分卷按原因码整包拒收）、`src/pack.mjs`（清单白名单与上限）、`src/pack-import.mjs`（只走 library 公开方法；`dryRun` 不写库不落文件；重跑幂等；无可见作用域拒绝导入）。`test/zip.test.mjs` **21 项** + `test/pack.test.mjs` **22 项** + `test/pack-import.test.mjs` **9 项** |
| **宿主接线**（从 `ctx` 取发送器 / 采集 `http` / 入库适配 / 主人判定） | `offline-test` | `test/host-wiring.test.mjs` **21 项** + `test/apply-wiring.test.mjs` **4 项**。证明：① `apply` 能从 `ctx.tools` 把 `qq_message`/`qq_sticker` 接成 `qqSender`（发送走 `tools.execute()`，不绕过通道闸门）；② 接上后 `expression_reply` 不再回 `sender-unavailable`（此时拦住它的才是 `delivery.enabled`）；③ 接上后入站端口 `observe()` 不再回 `ingest-not-injected`，`offers()` 与入库用同一个 `scopesFor().capture`；④ 拿不到工具表时仍注册四个工具、照常发端口，并**如实**报 `sender-unavailable`；⑤ 工具名在**发送那一刻**按会话作用域解析（QQ 工具挂在 preset 作用域里，不带 scope 的 `get()` 只看全局层），看不到就回 `tool-not-visible` 且 0 次调用。全程假工具表 + 假 `fetch`，**零网络、零 QQ** |
| 生产宿主上的接线诊断行 | `host-load` 的观测（不是端到端验收） | 2026-11-07 重启段日志：`[companion-expression] 宿主接线：发送器=有、采集http=有、入库=有、主人判定=有。` 这一行只说明**四路依赖都取到了**；`isOwner` 读的是 `data/home/companion/identity.json` |
| Studio 管理入口（图库 / 收集规则 / 实验室 / 习惯） | `offline-test` | 页面片段在最小 `P` 桩与 `smoke-client.mjs` 下渲染通过（**表情包相关失败 0 项**），`test/expression-page.test.mjs` **16 项通过**；**没有在真实浏览器里点过** |
| Studio 管理 API（12 条路由 / 10 个 path） | `offline-test` | `test/http-api.test.mjs` **12 项通过**：路由表、Origin 守卫、只认 `assetId`、`/thumb` realpath 越界 403、未启用态 200+启用片段、`/simulate` 恒 `sending:false` |
| 宿主装载 | **`host-load` 已达成（2026-11-07）** | 两次独立达成：① `npm run check:hostload --workspace=@dsh-companion/expression`：临时 `DSH_HOME` + 临时数据目录、`modules.expression=1`、只开 `expression` 补丁块；② 生产切换（`dsh-ops`，`expressions` 分支 `0278264`）真宿主启动后日志三行齐全（`已发布入站端口 dsh.companion.expression.v1` / `已注册 4 个工具（defineTool=host）` / `[companion-expression-http] 已注册 10 条管理路由`），且无 `did not activate`。裸 `fetch` 回 **401**（宿主 token 换会话的行为，浏览器里才有 cookie），因此判据不拿 200 作数 |
| 补丁渲染与合成 | **`host-load` 的一部分（仅渲染+合成，未装载）** | `npm run check:patch --workspace=@dsh-companion/expression`：把模板按「四个可选块全开」渲染后送宿主 `--dump-config`，**217 个 loader 行**、`expression` 与 `expression-http` 两行都在（2026-11-07） |
| 整包导入（生产图库） | `offline-test` 的代码 + 真库上跑过 | 2026-11-07 实际导入 `QQ-232180.zip`（16 张 126×126 PNG）到生产库：**16/16 成功**、审核态 `approved`、可见性写「主人私聊」+「群 145326153」各一行。证据 `data/logs/expression-import-qq-232180.json`。图库现在 `assets=20`、`cards=20`、`sources=20`、`approved 可见性=32` |
| **真实平台发图（且是「表情」而非图片）** | **`real-send` 已达成（2 条，2026-11-07）** | ① 首条「开心」`status='confirmed'` + `provider_message_id=988995366`——但回读 `sub_type=0`，QQ 上显示成**一张图片**（用户当场指出）。② 修复后重发「生日快乐」`status='confirmed'` + `provider_message_id=1005706362`，回读 `sub_type=1` / `summary=[表情]`，这才是表情。差别只有 `image` 段的 `sub_type` 字段（0=图片，1=表情）。**只证明这两条走通全链路**；批量、群聊、连续发图仍未验证。失败路径同样留了真实证据（首条 `status='failed'` / `reason_code='tool-error'`） |
| GIF 关键帧理解 / OCR / embedding 向量召回 | **未实现** | 代码里是 `NOT_IMPLEMENTED` 常量，不是「待验证」 |
| QQ 内置 `face` 表情投递 | **未实现** | 现有通道没有可复核的 face 发送入口，不凭空构造 |
| 「表情 vs 图片」的显示形态 | `real-send` 侧证（回读报文） | `image` 段的 `sub_type`：0=图片、1=表情。NapCat 4.18.19 实测四种写法后确认只有 `sub_type:1` 生效（`summary` 只影响占位文字）。现在 `qq_send_emoji` / `qq_send_sticker` 统一走 `core/message/sticker.ts` 的 `stickerSegment()`；生图与配字表情包**故意不带**这个标记 |

> 结论措辞只能用：「表情包系统的采集、检索、决策、宿主接线、投递与反馈在**离线测试**层面通过（206 项），
> 两行插件在真宿主上**装载成功**，并且**已经有 2 条真实 QQ 发图回执（其中 1 条回读确认是表情）**；
> 批量、群聊与连续发图仍未验证」。
>
> 「接线已落地」不等于「能发出去」，「有一条回执」也不等于「做对了」：这次验收里踩到三个坑，
> 每一个都是「回执 200 但用户看到的不对」：① 第一次发图**真的失败**（`tool-error`）——出站文件
> 边界只放行工作区与 `channel-qq`，而待投递的图在 `home/media/expression-out/`（位置由群聊侧
> 「只许从 `home/media` 发图」定下，不能挪），补上这个根才有回执；② 回执有了，但 QQ 上显示成
> **一张图片**——`image` 段少了 `sub_type:1`，那是 QQNT 区分「图片/表情」的唯一字段；③ 顺带发现
> 采集配额与投递配额共用一个桶，群里收两张图就把每小时发图额度占满（`abstain-hourly-quota`），
> 采集侧已改 `capture:` 前缀分桶。三条都有回归测试与真实回读证据。
> 边界仍然是**目录**边界：`home/expression/assets/`（图库原文件）与系统其它路径照样拒。


### 2.9 群聊社交运行时 P5–P8（2026-11-08）：仍只有 `offline-test`，真实发送未开始

P5–P8 交付见 `docs/10a-group-baseline-audit.md`（P5 基线与停发控制）、`docs/10b-group-gray-release.md`
（灰度验收与运维手册）。**证据级别与 P0–P4 相同：只有 `offline-test`**；真实模型与真实 QQ
发送（§5.1 的 B/C/D/E）**一项都没跑**。

P9-A（上线前兼容性与可靠性审计）见 `docs/11-group-social-runtime-p9-acceptance.md`：修掉了
四个真实缺陷（旧配置被静默停用、`off` 不热切换、发送耗时混入模型时间、文档描述与实现不符），
**仍然是 `offline-test`**；P9 的 B/C/D/E/F 全部未执行。

| 项 | 证据 | 说明 |
|---|---|---|
| 停发控制（`presence.mode`） | `presence-mode-core.test.ts` 8 例 + `presence-mode.test.ts` 7 例 + `presence-legacy-config.test.ts` 13 例 | 显式 mode 优先于 `enabled`；闸门**每次发送前现取**，在途模型结果也会被拦下；**旧配置走真实合成链路仍为 live**（P9-A1） |
| `speakMaxPerHour=0` 的真实行为 | `docs/10a` §2.1（审计）+ 代码注释 | 旧实现把 0 当「没配」退回 3；现在额度 fail-closed，但**停发要用 `mode`** |
| 社交场景（P6-A） | `group-scene.test.ts` 39 例 + `group-scene-prompt.test.ts` 10 例 | 只认平台 reply/at 段；判不准写「看不出」；渲染不含命令句 |
| 四类语义复核（P6-B） | `group-social-guard.test.ts` 20 例 | 每类都配「必须放行」的反例；默认 `warn`（**只记不拦**） |
| 多群连续性（P7-A） | `group-multi-room.test.ts` 10 例 + `companion-group` 18 例 | 按群号查询；非法/伪群号 fail-closed；系统段只留静态约定 |
| 调度与诊断（P7-B/C） | `presence-cadence` / `presence-scheduler` 字段 + 单测 + `presence-send-timing.test.ts` 7 例 | `starvationWarnMs` **只报警不改调度**；三段耗时真正分开：模型 / 合批 / **平台发送本身**（P9-A3），失败也计入尝试 |
| 后台诊断页（P8 §5.4） | `presence-resource.test.ts` 10 例 | 只读；群号脱敏末四位；**不含正文与完整 QQ 号**；无样本时给 `null` 不给 0；`running` 与 `mounted` 分开给（P9-A2） |
| 离线评测 | `npm run eval:group` → PASS 49 / FAIL 0 / WARN 3 / 52 | WARN 从 4 降到 3：G30 已由代码闭环 |
| 真实模型通道 | `npm run eval:group:llm`（`--selftest` 通过，绊线 0 次） | 通道就绪但**未配端点**，退出码 2；没有真实模型数据 |

**明确没验证的**：真实模型的语义质量（四类 WARN 是否下降**没有结论**）、真实 QQ 发送/引用/
表情投递、真人盲评、双群实机并发、`socialGuard` 阈值校准（默认 `warn` 期间一次都不会拦）。
不要用离线绿灯抵消这些。
### 2.8 群聊社交运行时 P0–P4（2026-11-08）：只有 `offline-test`

按 `docs/09-group-social-runtime-p1-p4.md` 落地了人格快照（P0）、群体/成员记忆（P1）、
五动作决策器（P2）、统一事件时间线与调度（P3）、表达约定与表情/反馈层（P4），外加 41 条离线（P6 补到 52 条）
评测集。**证据级别只到 `offline-test`**：

| 项 | 证据 | 说明 |
|---|---|---|
| 群记忆按群隔离 | `group-memory.test.mjs` 17 例 + 三张表 `group_id NOT NULL`（PRAGMA 断言） | 结构隔离，不是约定隔离 |
| 决策解析与执行边界 | `group-social-decision.test.ts` 18 例 | 编造目标 / 超窗 / 超长 / 带 @ 全部拦下 |
| 时间线与话题 | `group-topic.test.ts` 10 例、`group-events-memory.test.ts` 18 例 | 重推去重、双上限裁剪、不猜话题 |
| 表达约定与连续性段 | `companion-group` 18 例 | 段 ≤400 字、服务缺失降级 |
| 表情策略 / 弱反馈 | `group-expression-feedback.test.ts` 16 例 | 只判"要不要问图库"，不碰投递 |
| 离线评测 | `npm run eval:group` → PASS 37 / FAIL 0 / WARN 4 / 41 | 三个硬门槛 100%（错误目标、坏输出、隐私沉默） |

**明确没验证的**：真实群里的自主接话、真实模型判断力（4 条 WARN 就是代码侧判不了语义的部分）、
表情包真实投递（图库 `delivery.enabled` 默认 false 且需授权）、弱反馈对表达的实际影响、
调度节奏（6 秒合批 / 50 秒间隔）在真实活跃群里的表现。不要用离线绿灯抵消这些。

### 2.7 点歌翻唱（`dsh-channel-qq` 的 `song` 段）：`offline-test` + **`real-api` + 两条 `real-send`（2026-11-07）**

链路：B站搜歌 → 下载音轨 → 副歌定位 → RVC 音色翻唱 → QQ 副歌语音条。
设计取舍见 `docs/karaoke-cover.md`。**下面每行都写清证据到了哪一级，不要读成「点歌功能已完成」**。

| 项 | 级别 | 证据 |
|---|---|---|
| 选源判据（跳过伴奏/教程/混剪/二次 AI、同名歌让用户选、"歌名+歌手都命中"才算确定） | `offline-test` | `test/song-pure.test.ts`（全文 **17 项**，其中选源 9 项）：跳过规则逐条命中、45 s–25 min 时长边界、书名号优先、**指定歌手后能定下来**（不因"有别的版本"多问一次） |
| 歌手性别与升调（女声优先 / 男声升八度 / 不知道就不升） | `offline-test` | `test/song-gender.test.ts` **12 项** + `test/song-female-cover.test.ts` **5 项**：字面标记优先于歌手名单、`unknown` 不升调、clamp 0–24、**找翻唱的门槛不是 80 分**（关键词里没有歌手，实机分数 55–68）、日语/英文/粤语填词版跳过 |
| 账本（去重活过重启、`unknown-send` 与 `sent` 都算「发过」、14 天保留、脏行丢弃） | `offline-test` | `test/song-pure.test.ts` 账本 **6 项** |
| 队列（串行、去重、上限、日额度、取消、终态通知） | `offline-test` | 假端口跑完真实 `runTask`/`SongQueue`，`test/song-pipeline.test.ts` **22 项** |
| 流水线四步的失败边界 | `offline-test` | 同上：下载 403/503、翻唱退出码、副歌不可靠/置信度低、闸门 `dry-run`/`denied`、**回执未知绝不重发**、网关嫌长按**同一副歌起点**缩短（25→15）、任务目录必删、限流时补一句「过几分钟再点」 |
| B站适配器（搜索归一化、playurl 选流、多地址回退、截断拒收、错误可读） | `offline-test` | `test/song-bili.test.ts` **17 项** + `test/song-bili-audio.test.ts` **10 项**（含 **503 也换地址**、**非 2xx 不换**、`AUDIO_HEADERS` 不带 Cookie） |
| 副歌定位脚本契约 | `offline-test` | `test/song-chorus.test.ts` **10 项**（四类失败都收敛成 `null`，不抛） |
| 翻唱适配器（只切副歌附近、三段超时、±0.75 s 时长校验、summary 白名单） | `offline-test` | `test/song-cover.test.ts` **12 项**（含 `--key` **永远传**） |
| 语音条发送（三态、恰好一次 `out.push`、超时转 `unknown`、真实 25 s/400 KB 体量内联） | `offline-test` | `test/song-voice.test.ts` **8 项** |
| 自主选歌（六道前置条件各有理由、按日期轮换、与私聊同一套判据） | `offline-test` | `test/song-auto.test.ts` **12 项** |
| **部署形态**（`find_chorus.py` 进不了 `build/` 的缺口） | `offline-test` + **真打包** | `test/song-deploy.test.ts` **5 项**；并且**真的 `npm pack` → `tar -xzf` 解包 → 在解包目录里跑真实 chorus 适配器**得到 `{"startSeconds":87.5,…}`。解包根**没有**源码树 `tools/`，上溯第 3 跳命中 `build/tools/song/`。`e2e-acceptance.mjs` 在包内 **0 个** |
| B站真实接口（搜索 / view / playurl / 音轨下载） | **`real-api` 已达成** | 2026-11-07 多次：搜索返回 8/20 条、`view` 给出 cid、`playurl` 30280/184052bps、音轨 **6 201 843 字节 → wav 47 540 586 字节（2 s）**。带凭据；匿名会 412 |
| 真实音轨上的副歌定位 | **`real-api` 已达成** | 三条实测（真实音轨）：`wo_bu_nan_guo` start **90.5 s**（对齐前 76.0）、`jay-chou` **155.5 s**（对齐前 143.5）、晴天（B站音轨）**87.5 s**（对齐前 84.0）；`confidence` 0.90/0.81/0.87 **未因对齐变化**；单次 4.4–7.3 s。合成用例 7/7（人造台阶/毛刺/超窗/恒定/全静音），证明参数不是为这三首歌调的 |
| 真实 RVC 翻唱（女声音色模型、伴奏保留、25 s 语音条可解码） | **`real-api` 已达成** | 2026-11-07 端到端 72–90 s：分离+推理 63.7–75.4 s，`voice.mp3` **25.000249 s / 401 075 B**，`ffprobe` 与 `ffmpeg -f null` 都通过，summary 9 字段（`model=March7_RVC.pth`、`separator=mel-karaoke-gabox`） |
| **男声升八度真的只动人声** | **`real-api` 已达成（对照实验）** | 同一条 45 s 片段跑 `--key 0` 与 `--key 12`：`inst.mp3` **MD5 完全相同**（`C91E602E…`）；`vocal.mp3` 逐帧基频 median **+12.00 半音**（p25 +11.94 / p75 +12.06，2858 个双清帧）；`voice.mp3` 时长与字节数**完全不变**。另一侧证：`make_cover.py` 直接双跑，`vocal.mp3` 中位基频 349 Hz → 630 Hz |
| **QQ 真实发送（副歌语音条）** | **`real-send` 已达成（2 条，均为私聊）** | ① 21:29 晴天 `message_id=**695766929**`（副歌 87.5 s，25 s）；② 22:47 十年（女声翻唱版）`message_id=**1408692542**`（副歌 85.5 s，25 s）。两条都是**恰好一条**语音条、平台给了回执。**没有**逐条在手机端回听确认「起点是不是副歌第一句」——那一项见下 |
| **群聊点歌 + 每人每日额度（非主人 2 首/天，主人不限）** | **只有 `offline-test`**（真实群语音条**没验成**） | 2026-11-08 04:44 实现并提交：`SongEntry += 'group'`、语音条按 `splitRoom(room)` 选 `send_group_msg`/`send_private_msg`、`notice` 同样按房间选路（原实现硬写私聊，群里失败说明会发到"用群号当 QQ 号"的私聊里，是真 bug，已修）、`groupEnabled`（默认 false）、`dailyUserCap`（默认 2，0 = 不限）、额度在 `enqueue()` 判（去重之后、队列上限之前）。`test/song-group-quota.test.ts` **15 项**覆盖房间解析/群开关/群私分路/额度四口径（含 `unknown-send` 计入、并发两条、跨日归零、主人豁免、不数 `auto`）/群里缺 `requesterId` 即拒。**真实群语音条没发出去**：04:48 起 NapCat 不在（`ws://127.0.0.1:3001` 无监听、`connection-status.json` 为 `connected:false`、宿主每 5–60 s 重连），所以此刻 DM 与群都发不了。唯一的真实路径证据是失败串里的动作名——`action send_group_msg dropped`，说明群房间确实走了 `send_group_msg` 分支 |
| 自主选歌在真机上「自己发一首」 | **`real-send` 已达成（3 条），但随后按操作员要求拆掉了定时触发** | 2026-11-08 03:11–03:16 在真宿主上真的自己挑了《后来 / 刘若英》并发出 **3 条**：`message_id=756553347 / 1186392690 / 1677066588`，每条 **55 s**（副歌 162.0 s + 句尾 55.0 s，不是硬切 59.0），`confidence 0.80`，`keyUp=0`（女声源直接命中）。三条日志连在一起也暴露了代价：**每约 2 分钟一条 55 秒语音**（唯一约束是流水线本身约 105 s），而且**三遍是同一首歌**——轮换下标原来只由日期决定。两处都已修：轮换叠加当天已发数（`poolEntryAt()`，提交 `ed1c0af`）；**`contact` 那个每拍调 `autoPickOnce()` 的 `afterTick` 装配被删掉**——操作员的要求是「从不主动发歌，除非计划里有」。03:44 重启后观察 3 分钟以上：`autoCount` 仍为 3、无新增任务，**确认不再自己开口** |
| **同歌缓存（两层：方案 + 成品）** | **`real-api` + `real-send` 都已达成（同一首歌第二次真的没跑 python）** | 2026-11-08 06:10/06:12，同一首歌（`BV1nY4w6kEQS` 晴天，副歌 116.0 s / 24.0 s）连点两次：**第一次**「缓存未命中，照常做」→ 真跑 `make_cover.py` **66.9 s**、总 79.6 s；**第二次**「方案命中缓存（跳过下载与副歌定位）」+「命中缓存（跳过下载与翻唱）」→ **总 4.4 s**，并真的发出去 `message_id=**815400604**`（24 s，用的就是缓存里那一份 384 775 B）。缓存目录实测：`plans/…plan-v1.json`（144 B）+ `clips/….mp3`（384 775 B）+ 记账 `.json`（81 B）。离线 `song-cache` 14 项 + `song-cache-adapter` 6 项覆盖键稳定性/区分度、命中不调 download/locate/render 但仍过闸门并发一次、时长差 3 s 即判未命中并删、关闭或未注入时逐字一致、上限 2 放 3 条删最久没用、孤儿清理、网关每档缩短各自入缓存。**未验证**：`PLAN_ALGO_TAG`/`COVER_ALGO_TAG` 忘了 +1 的场景（那是靠注释与纪律，没有测试能替你发现"旧参数做的音频"） |
| 拦截在真实时钟下（每日上限 / 免打扰 / 授权变化） | **部分验证** | 每日上限与 `unknown-send` 不重发是离线断言；免打扰/授权走的是主动联系既有门控（`docs` 里那一套，本表不重复声称）。**没有**用真实时钟跨过零点验证「第二天额度恢复」。`dailyAutoCap=0`（不限额）的「同一天能发第二首」**已在真机上验证**（3 条同日），序号去重键与任务 id 的 `-2/-3` 后缀在日志里可见 |
| 网关拒收默认长度 → 缩短后仍可播 | **只有离线覆盖** | `looksLikeLengthRejection` 只认长度类错误，59 起的阶梯 45/30/20/15 且副歌起点不变，有断言；**真实网关没有拒收过 55–59 s**（三条真实发送都是一次通过），所以「缩短后的那条能播」未在真机出现过 |
| 同名歌让用户选（真实搜索） | **`real-api` 已达成** | 搜「起风了」无歌手 → 返回 5 条候选（林俊杰现场 / 买辣椒也用券 / 毕业典礼 / 填词版），**不猜**，退出码 3 |
| 女声优先在真实搜索上生效 | **`real-api` 已达成** | 四条真实用例：`晴天/周杰伦` → 男声 → 再搜女声翻唱 → 命中 `BV1nY4w6kEQS`（`keyUp=0`）；`十年/陈奕迅` → 女声翻唱 `BV1ZH4y1c79D`；`后来/刘若英`、`我只在乎你/邓丽君` → 初选即女声。**没有女声翻唱时**退回原曲并升八度（该分支在另一次跑里命中：晴天初选男声、第二次搜索挑不出可用女声版 → `keyUp=12`） |
| Linux / macOS | **未验证** | 全部开发与验收在 Windows 上；`find_chorus.py` 只用 numpy/librosa，理论上可移植，但没跑过 |

> 结论措辞只能用：「点歌链路的四步（B站真实下载、真实副歌定位、真实 RVC 翻唱、真实 QQ 发送）
> 在 2026-11-07 的**两条**真实发送上走通，并且有逐字节/逐帧的对照证据说明男声升八度只动人声；
> **`node --test build/lib-test/test/song-*.test.js` 130 项全通过**（失败边界覆盖）；
> 自主选歌的真机触发、跨零点的日额度、网关拒收后的缩短仍未验证」。
>
> 三条不许混淆的边界：
> ① **`real-send` 只证明「一条语音条发到了那个私聊」**。用户嘴上确认「是副歌」这一次是人工听感，
> 不是可复跑的判据；下一次换歌不保证。
> ② **「副歌」是脚本判的，不是人标的**。`wo_bu_nan_guo` 的人工「90 秒」本身也是
> `compare_models.py` 里的硬编码常量、`jay-chou` 的「165」是 CLI 默认值——所以**不要**写成
> 「算法已验证对齐人工标注」。`jay-chou` 差 9.5 s 的如实解释：那段 145–175 人声不间断，
> **没有可对齐的台阶**，两个判据给的点都在同一片平台里。
> ③ **女声优先依赖一份手写歌手名单 + 标题字面标记**，不是查询接口。没命中就是 `unknown`，
> 此时**不升调**（升错比不升更糟）。这份名单注定不全。

### 2.8 衣柜昼夜状态化 + 视觉身份（`companion-foundation` / `companion-media`）：`offline-test` + `compose` + `host-real`

分支 `feat/companion-visual-identity-wardrobe`（基线 `origin/main` @ `0a545ff`，2026-11-10）。
实现与验收细则见 `docs/14-wardrobe-state-upgrade.md`；接口权威见
`plugins/companion-foundation/WARDROBE-STATE-CONTRACT.md`。

| 项 | 级别 | 证据 |
|---|---|---|
| 衣柜 v2 数据结构（`contexts` 场景条件 / 五槽位保留 / `outfits` / 带 `until` 的 `overrides`） | **`offline-test`** | `node --test "plugins/companion-foundation/*.test.mjs"` → **206 项全通过**（2026-11-10，含本轮 P0-B 新增 5 项）。新增 `wardrobe-state.test.mjs` 25 项覆盖 §11.1/§11.2 全表 |
| v1 → v2 迁移可逆 | **`offline-test`** | `旧版 v1 衣柜可以迁移，并且可以回滚`：`.v1.bak` 与原文**逐字节相等**；回滚后仍按 v1 正确读取。迁移**不从扁平清单臆造组合**（`outfits: []` + 明确报缺失） |
| 昼夜切换（22:20 居家 / 22:40 睡衣 / 02:00 / 06:50 / 07:10） | **`offline-test`** | 表驱动断言，墙上时钟全部注入；跨午夜 `[22:30,24:00)∪[00:00,07:00)` 与 22:29/07:00 边界都有断言 |
| 「白天覆盖不挡睡衣」「上一轮说要出门不延续」 | **`offline-test`** | `overrideAppliesTo()` + 两个用例；`planned` 计划槽位与未来日程明确**不**作为「正在发生」的证据 |
| 人格隔离 / 群聊隔离 / 缺睡衣明确报错 | **`offline-test`** | 别人格无文件 → `wardrobe-missing-for-persona`；`qq-group-*` → `wardrobe-unavailable-in-group`（工具与写入都拒绝）；缺场景组合 → `no-outfits-for-context` 且**不回落** |
| Prompt 注入（静态 section 无衣物 + `agent/pre-step` 每轮一次 ≤480 字符 + 与工具同源） | **`offline-test`（宿主边界）** | `wardrobe-mount.test.mjs` 7 项：真实 `mountCompanion` + 真实 hook，断言静态 section 不含任何衣物、step 1 注入一次、step 2 不注入、快照与 `companion_wardrobe_detail` 逐字段一致 |
| 生图身份 + 服装自动注入（深夜睡衣 / 白天常服 / 夜间外出 / other 不注入 / 缺英文拒绝） | **`offline-test`** | `node --test "plugins/companion-media/test/*.test.mjs"` → **162 项全通过**；NAI 用例断言进图 caption 同时含身份与当场服装，且不含中文、不注入别人格身份 |
| **缺失 Visual Identity 时的生图拒绝** | **`offline-test` + `host-real`（已修）** | 闸门 `companionPictureGate()` 一处判定，`dryRun` 与真实调用同源。13 项回归（`visual-identity-gate.test.mjs`）：缺身份 / 文件损坏 / 结构无效 / 人格不匹配 / 只有中文外观 / 传了 outfit 也绕过不了 —— 逐条断言 **POST 0**；有效身份断言 **POST 1**。真实宿主复验：缺身份 `MEDIA_VISUAL_IDENTITY_REQUIRED` 且网络记录器 **0 命中**，补上身份后同一次运行里记录器 **1 命中**。见 `docs/16-p0-fixes.md` §1 |
| **companion 预设可创建会话** | **`offline-test` + `host-real`（已修）** | 预设曾重复声明宿主 plane 的 `skill` 注册表服务，导致 `session/create` 一律失败。删掉该行后真实宿主（**不加任何修复补丁**）`session/create` 成功、一轮对话跑完，62 个工具含 `skill`、技能目录完整。5 项回归盯着「预设不得声明裸 `skill`」。见 `docs/16` §2 |
| **媒体层数据根与 foundation 一致** | **`offline-test` + `host-real`（已修）** | `resolveDataDir()` 改为复用 `suite-paths.mjs#resolveDataRoot()`，不再有第二套实现。8 项回归覆盖优先级与「`data/media/config.json` 不得覆盖 `<dataDir>/media/config.json`」；真实宿主 `GET /api/companion-media/status` 报 `dataDir=<dev-clone>/data-dev`、`configFile=<dev-clone>/data-dev/media/config.json`，诱饵 `data/media/config.json` 未被读取。见 `docs/16` §3 |
| 视觉身份数据 | **需操作者填写** | 仓库内没有任何原作/外貌数据（审计：`visual-identity` 关键词在五个远端分支上 **0 命中**）。`home/companion/visual-identity.json` 缺失或该 persona 无条目时，拒绝已成立的生图调用并报 `missing:["identity"]`（不再画一张没有脸的图） |
| 零计费验收抓包 | **`offline-test`（脚本 + 证据文件）** | `node scripts/wardrobe-acceptance.mjs --root <dataRoot>` 产出 `logs/wardrobe-v2-<date>/acceptance.{json,txt}`：时钟表、五个场景可用性、`dryRun` 的 `visual` 块、源码 sha256。脚本内的 `fetchImpl` **拒绝任何网络请求**，所以它不可能产生一次计费调用 |
| 宿主合成 | **`compose`** | `npm run verify --only=compose` → **195 个 loader 行**（2026-11-10，本机宿主 `0.2.1-rc.3`）：`preset-companion`、`companion-foundation`、`companion-media` 均在合成结果里 |
| **真实对话里的注入正文抓包** | **`host-real`（第②阶段已完成）** | 真实宿主 `0.2.1-rc.3` + `companion-dev` + `data-dev`：`session/create`（preset `companion`）→ `session/prompt`，把 `llm-pi-ai` 指到本地记录器抓下**完整请求体**。14:00 注入 `日常常服 / daytime-everyday`（195 字符 ≈172 tokens），22:40 注入 `睡衣 / night-window`（181 字符 ≈163 tokens），与离线判定**逐字节相同**；静态段 91 字符且**不含任何衣物名**；工具查询结果与注入正文同源。记录见 `docs/15-wardrobe-host-acceptance.md` 与 `<dataDir>/logs/wardrobe-host-acceptance/record/` |
| **真实计费生图** | **未验证** | 全部 `dryRun` / `mockFetch` / 本地记录器；按 `AGENTS.md` 规则 2，需操作者显式授权才可跑一张 |

> 措辞模板：「衣柜解析、工具合同、Prompt 注入与生图注入在离线与合成层面有 206 + 162 项断言和
> 一份零计费抓包；**真实会话的注入正文已在真实宿主上抓取并复核**（见 `docs/15`），
> **三个 P0 缺陷（缺身份仍生图 / 预设重复注册 `skill` / 媒体层数据根）已修并在真实宿主上复验**
> （见 `docs/16`），**真实计费生图仍未验证**。」


**宿主与链路**

- **`host-load` 已达成，但覆盖有边界**：核心五模块 + 陪伴空间 Web UI 在 Windows + 宿主 `0.2.1-rc.3` 上
  真实装载成功（§2.1 的 C 段）。**未覆盖**：`dsh-channel-qq`（验收未启用通道，无 OneBot 服务）、
  `companion-media` / `companion-health` / `dsh-paste-search`（验收未启用这些可选模块）、两个 sidecar。
- **`npm run start` 的 `--detach`（后台）模式**：默认是**前台阻塞**模式，前台起停已验证（F 段）。
  `--detach` **已确认在非交互父进程下不可用**（2026-11-05 实测）：它打印 URL 并 exit 0 之后，对同一
  URL 的请求立即得到 `ECONNREFUSED`；前台启动则正常存活。`start.mjs` 的注释本就说「能否存活取决于父
  进程/作业对象」，因此这属已知限制而非新缺陷，但**不要把它当生产用法**（`docs/01` §3.5 已写明）。
- **GitHub Actions 三平台 CI**：workflow 文件在仓库里且本地 YAML 可解析，但**从未观测到真实运行结果**
  ——读取私有仓库的 Actions 结果需要凭据，本会话没有，因此**不能声称三平台通过**。
- **路径形态**：含空格 + 含中文**已实跑通过**（§2.1 A 段）；**跨盘符、深层嵌套、网络盘、UNC 仍未验证**。
- 三平台：Linux / macOS 只到「CI 构建与离线测试」（且 CI 尚未运行过），桌面启动、侧车、宿主探测均未实测。
- 会话可用性：本轮只验证到「宿主起来了、UI 返回 200」，**没有做真实模型调用**，所以「能对话」仍未验证。

**外部能力**

- QQ 真实发送（`real-send`）：需要用户自备 NapCat 并登录。
- B站任何能力：外部模块，本仓库不背书。
- 计费 API（生图 / TTS / 向量 / 重排）：需要用户自己的密钥与付费账号。
- 华为健康：**代码路径与 MIT 许可已就位**（上游实现随包分发，见 `docs/03` §1.2.1），但**真实账号授权未验证**——
  需要在装有华为运动健康账号的机器上登录一次、`GET /api/data?days=3` 拿到真实数据，才算 `real-api`。
- BLE 心率：需要支持心率广播的设备（且必须在设备上打开广播）；这条路是原创代码，不受上游许可影响。
- 媒体投递：投递通道为 mock 形态时，`confirmed` 会被强制改写为 `unknown`——**不要**据此认为「发出去了」。

**产品行为**

- 群聊里发图 / 发语音出站、群内自主接话的真实触发。群聊社交运行时（记忆 / 决策 / 时间线 /
  表情 / 反馈 / 运行模式 / 语义复核）到 2026-11-08 只有 `offline-test`，详见 §2.8、§2.9、
  `docs/09-group-social-runtime-p1-p4.md`、`docs/10a-group-baseline-audit.md` 与
  `docs/10b-group-gray-release.md`。
- 表情包系统（`companion-expression`）的宿主装载与真实发图：见 §2.6。图库、决策、管理入口只到
  `offline-test`；GIF 关键帧 / OCR / 向量召回 / QQ 内置 `face` 投递**未实现**。
- 主动联系（contact）的真实平台发送与回执。
- 提醒的四条停止线（停机可观测 / 不重复外发 / 空转可见 / 阈值合理）在真机上的验证。
- 真实 24 小时长稳（只做过模拟时钟）。

### 2.8 Prompt Engine（模块化认知与写作引擎，2026-11-08）：`offline-test` + `host-load`

设计说明见 `docs/08-prompt-engine.md`，接口合同见 `plugins/companion-foundation/PROMPT-ENGINE-CONTRACT.md`。
**这一节只证明"代码按设计工作"，不证明"模型写得更好"**——后者需要真实模型输出与人工评分，本仓库没做。

| 项 | 级别 | 证据 |
|---|---|---|
| 配置读取/校验/安全回退（默认关闭、非法 JSON、非法枚举、越界预算、不创建不覆盖文件） | `offline-test` | `prompt-config.test.mjs` **15 项** |
| 场景路由（三层判断、显式优先、单条消息不得 immersive、抽象情绪不判 RP、逐轮降档、resume、session 隔离） | `offline-test` | `prompt-router.test.mjs` **23 项** |
| 模块目录与写作档边界（chat 不含白描、companion 不含报告腔、implicit 轻量、roleplay 才注入叙事、task 无扮演；anti-deepseek 只降频不禁词） | `offline-test` | `prompt-modules.test.mjs` **17 项** |
| 组合与预算（稳定排序、两种去重、整模块裁剪不截断、`MAX_MODULES=10`、五档字数上限） | `offline-test` | `prompt-compose.test.mjs` **17 项**；实测 chat **512/600 字**、companion **578/800**、task **473/500**、implicit **623/1300**、immersive **657/1300**，五档均未触发预算裁剪 |
| 结构化规划（schema 校验、超长截断、坏 JSON 提取、planner 提示词不超输入上限、渲染 ≤900 字） | `offline-test` | `prompt-plan.test.mjs` **19 项** |
| 文风检测（只统计+理由码、不回传原文、正常中文不误伤、chat 档不检测白描） | `offline-test` | `prompt-lint.test.mjs` **14 项** |
| 引擎编排（关闭惰性、shadow 不改消息、预算、LRU、黑名单、planner 缺失降级、配置热更新、dispose） | `offline-test` | `prompt-engine.test.mjs` **29 项**；其中 7 项用**假宿主 LLM** 跑通 Planner 路径：合法规划进 Writer 指导、purpose=`companion-prompt-plan` 且 sessionId 独立、`allowFallback:false`（一次预算=一次物理生成）、坏 JSON 一次修复、两次失败降级、字段越界截断、Guided 档零调用 |
| 与 foundation 现有 Hook 集成（默认关闭不注册 Section、开启独立 `companion-prompt-profile`、原有身份/记忆注入逐字节不变、只在 step 1、reject/aborted 不变、群聊与私聊互不串档、引擎崩溃不影响聊天、不写记忆） | `offline-test` + **`host-load`** | `prompt-engine-mount.test.mjs` **12 项**；其中一轮用**已安装桌面的真实宿主模组**（`DSH_COMPANION_MODULE_ROOT` 指向桌面 `node_modules`）跑通，与 `cognitive-mount.test.mjs` 的 8 项一起 20/20 通过 |
| `companion-foundation` 合计 | `offline-test` | **365 项 / 356 通过 / 0 失败 / 9 跳过**（Prompt Engine 146 项：15+23+17+17+19+14+29+12；P4 路由样例新增 4 项；其余 215 项为原有测试） |
| 整仓 `npm run verify` | `offline-test` | `unit` **9 模块全绿**（`dsh-paste-search` 无测试）；`static` **33 项全绿**；`compose` **194 个 loader 行**（本 worktree 已跑过 `npm run setup`） |
| **真实模型调用**（Planner / Strict 审查 / 修正） | **未验证** | Planner 代码路径只有"不可用时降级"这一半被断言；真实 provider 调用、超时、Token 计数**都没跑过** |
| **真实场景质量验收**（四组固定测试集 × 四条对照） | **未验证** | 需要真实模型输出与人工评分，且要用操作者自己的 Persona 与历史 |

> 结论措辞只能用：「Prompt Engine 的配置、路由、模块组合、预算、schema 校验与文风检测在**离线测试**上通过，
> 并且能以关闭/开启两种状态真实挂在 foundation 的 `agent/pre-step` 上，原有的身份、记忆、运行时注入与心跳/关怀注入**逐字节不变**；
> 规划器的真实模型调用与真实场景质量验收**都没有做**」。

> 关于 `static` 段那一项 `✗ author-name — README.md:197`：它在本 worktree 的父提交（`052943f`，即 `origin/main`）
> 上**同样失败**，是既有问题，不是本次改动引入的。2026-11-09 已按"唯一一条审计豁免"修掉：
> `README.md` 里的`git clone https://github.com/<owner>/dsh-companion` 是**公开克隆地址**，
> 不是作者身份泄漏。`scripts/verify.mjs` 现在只对这一条规则、只对这一种 URL 形态做剥离，
> 干净文本里出现这个名字仍然算失败。`static` 因此从 32/1 变成 **33/0**。

### 2.9 Prompt 分层清理（2026-11-09）：`offline-test` + `host-load` + 一条 `real-model`

设计说明见 `docs/09-prompt-baseline.md` → `docs/10-prompt-layers.md` → `docs/11-prompt-routing.md`，
验收见 `docs/12-prompt-verification.md`，未修项见 `docs/13-prompt-followups.md`。

**这一节分开声明四件事**，不要合并成一句"已优化"：改了哪些层、每层的证据到哪一级、
真实模型输出看到了什么、哪些明确没测。

| 项 | 级别 | 证据 |
|---|---|---|
| 原生开发提示词归属表（11 段 Section 逐段归到插件与层级，含"宿主没有只关 Section 的开关"这一结论） | `source-review` | `docs/09-prompt-baseline.md` §3；逐段读宿主源码确认注册点 |
| `disabled: true` 只能按条目关整个插件的实证 | `offline-test` | 用 `--patch` 探测补丁跑 `--dump-config`，`harness-dev-context` / `ui-deliverables` 行从启用变为 `disabled: true` |
| 陪伴预设去开发化（模板可选块 + `config/suite.json` 的 `prompt.*` 三个开关） | `offline-test` | `scripts/setup.mjs` 的 `activePatchBlocks()` 单测；`verify --only=static` 三条新断言（默认不装开发工具 / 默认裁掉两段宿主提示 / 开关能把块加回来） |
| Foundation 静态 Section 压缩（continuity 634→309、agenda 299→239、wardrobe 273→178、pulse 95→93） | `offline-test` + **`real-capture`** | 离线挂载实测 1,072 字；真实抓包 system prompt 5,881 字（基线 10,361） |
| Prompt Contract 生命周期（恒注册一次、off 时渲染空串、off→active→off 热切换） | `offline-test` | `prompt-engine-mount.test.mjs` 13 项，含新增的热切换测试 |
| 动态模块减重（chat 512→404、companion 513→446、task 280→247、roleplay 409→363） | `offline-test` + `real-capture` | `prompt-modules.test.mjs` 上限断言；真实抓包同值 |
| 路由有限修正（ASCII 引号不再当对白证据；`sceneDeixis` 词表去重） | `offline-test` | `prompt-router.test.mjs` 27 项，含计划 §6.3 的 7 条对话样例 |
| 宿主真实装载 | **`host-load`** | 测试实例 3199 真实启动；`agentPresets/list` 返回 companion 预设未标 broken；system prompt 逐段核对 |
| 工具清单与 Schema 开销 | **`real-capture`** | 56→46 个工具；35,274→26,621 字符（−24.5%） |
| 真实模型响应质量 | **`real-model`（10 轮合成样本）** | `data/logs/p5-capture.json`；人格一致、心率/衣柜/记忆如实、日程不虚构；**发现 2 个缺陷见 §2.9.1** |
| 真实 QQ / 语音 / 提醒投递 | **未验证** | 需另行授权 |
| Persona 精简 | **未做（按计划禁止）** | 真实 `config/persona.md` 逐字节未改；建议稿见 `docs/persona-simplification-example.md` |

#### 2.9.1 这次抓包暴露的两个缺陷（已记录，未修）

| 缺陷 | 现象 | 归属 |
|---|---|---|
| task 档正文为空 | 「用一句话解释幂等」的答案全部落在 `reasoning` 块，`text` 为空 | 写法模块缺少"答案写在正文"的正面要求；不是本次改动引入 |
| 思考过程漏进正文 | implicit 档回复开头是"他在问…我不该编造…"的自我分析 | 同上；`style.universal` 没有"不要解释你的思路" |

两者都写在 `docs/13-prompt-followups.md` §1/§2，修法要点与测试口径也一并记录。

#### 2.9.2 结论措辞

> 「陪伴预设的系统提示词从 **10,361** 字降到 **5,881** 字（−43.2%），其中 4,004 字是宿主原生
> 开发智能体说明，2,338 字是给"能改 DSH 本体"的编码智能体看的编码规则段与交付卡片说明，
> 这些在陪伴会话里全部消失；工具从 **56** 个降到 **46** 个。人格、记忆检索、运行时、日程、
> 群聊隔离与写记忆闸门**一条没动**，开发预设（standard / ptc / cordis）的 `pwsh`/`fs`/
> `jobs`/`skill` 工具**全部原位**。
> 真实模型响应用 10 轮合成样本验过：人格与语气一致、心率/衣柜/记忆如实回答、日程不虚构；
> 同时发现 task 档会把答案只写进 reasoning、implicit 档会把自我分析写进正文两个既有缺陷，
> 已单独记录，本次未修。」

## 4. 怎么把某条证据从「未验证」升一级

| 想升级到 | 必须做的事 | 记录要求 |
|---|---|---|
| `offline-test` | 跑该模块的测试命令（`node --test …` 或 `npm run verify --only=unit`） | 命令 + 通过/失败计数 + 日期 |
| `host-load` | 用真实宿主加载该模块（`npm run start` 或 `--dump-config`），确认无装载错误、服务已注册 | 日志片段（脱敏）+ 宿主版本 + 日期 |
| `real-api` | 由**操作者**显式触发一次真实请求（会花钱/联网） | 服务名 + 结果摘要（不含密钥）+ 时间 |
| `real-send` | 由操作者触发一次真实平台发送 | 平台消息 id / 可复核链接 + 时间 |
| `hardware` | 真机跑一次并读回真实数值 | 设备名 + 读数区间 + 时间窗口 |

升级证据时请**改这张表**，不要只在聊天里说「跑通了」。

### 4.1 本机私有配置会让 `npm run verify` 红：那是环境差异，不是回归

`unit` 段用的是**本机** `config/suite.json`。这个文件 gitignore、因人而异，所以下面这类失败
在不同机器上可以完全不同：

| 现象 | 原因 | 判定它「不是代码坏了」的办法 |
|---|---|---|
| `@dsh-companion/foundation` 大量失败（`not configured` / 注入前后不一致） | 本机 `persona.id` 不是 `bot`，而测试夹具写的是 `persona: 'bot'` | `DSH_COMPANION_PERSONA_ID=bot node --test "plugins/companion-foundation/*.test.mjs"` → 全绿 |
| `@dsh-companion/group` 1 项失败（owner identity） | 同上（`createIdentity` 会读 `config/suite.json` 的 persona id） | 同上环境变量后 `node --test plugins/companion-group/group-isolation.test.mjs` → 全绿 |
| `@dsh-companion/memory-studio` 1 项失败（`identity.persona` 实际不是 `bot`） | 同上 | 同上 |
| `@dsh-companion/channel-qq` 1 项失败（`qq-idle-compaction` 默认关） | 本机 `config/suite.json` 里 `qqIdleCompaction: true`，夹具要的是「没配置」 | `DSH_COMPANION_SUITE_ROOT=<空目录> node --test "build/lib-test/test/safe-defaults.test.js"` → 全绿 |
| `npm run verify` 的 `compose` 里 5 个 `file://` 路径不存在 | 本机生成的 `config/profile/companion.patch.yml` 里写了带查询串的入口（`?v=…`），doctor 按字面路径查 | 删掉/重新生成补丁，或看 `--dump-config` 是否仍 217+ 行 |

> 结论：**这些红不是本发布树的回归**，但也不能因此说「验证通过」。正确措辞是
> 「在**干净环境变量**下 X 通过；本机私有配置下另有 N 项环境性失败，已定位到具体文件」。

## 5. 报告验收结论时的措辞模板

- ✅ 「`companion-memory` 的离线测试 X 项通过（2026-11-05，命令 …），**宿主装载未验证**。」
- ✅ 「迁移 CLI 在真实数据副本上跑通 export/check/dry-run（2026-11-05），**真实导入未验证**。」
- ❌ 「全部功能已验证可用。」
- ❌ 「CI 通过，所以桌面能用。」
- ❌ 「连接测试成功，所以一直可用。」

## 6. 仓库卫生规则的边界（`npm run verify --only=static`）

`static` 里的「泄漏扫描」是**一组具体的形状匹配**，不是「没有密钥」的证明。看到绿灯时，
应当知道它到底覆盖了什么、没覆盖什么。实现见 `scripts/verify.mjs`，本节与实现同步。

### 6.1 两组规则，两趟扫描

| 组 | 规则名 | 匹配什么 | **测试树豁免？** |
|---|---|---|---|
| 正文/身份 | `persona-<旧角色名>` | 旧角色名及其变体（含拼音） | **不豁免**——旧角色名在任何地方都不该出现 |
| 正文/身份 | `author-path` | 盘符绝对路径指向 `Users/<用户名>` 或 `Bot/dsh-companion` | **不豁免**——作者路径在测试里也不行 |
| 正文/身份 | `author-name` | 作者的个人标识（昵称变体、`<名>-<旧人格id>` 形式的用户号）；**唯一例外**是本仓库自己的公开克隆地址，见 §6.4b | **不豁免** |
| 正文/身份 | `legacy-persona-id` | 整词的旧人格 id | **不豁免** |
| 密钥形状 | `openai-key` | `sk-` 开头的长串 | 跳过测试树 |
| 密钥形状 | `github-token` | `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` + 长串 | 跳过测试树 |
| 密钥形状 | `bearer` | `Bearer ` + 24 位以上 token | 跳过测试树 |

**测试树**：路径含 `test/`、`tests/`、`fixtures/` 目录段，或文件名匹配 `*.test.{mjs,cjs,js,ts}`。
只有**密钥形状**三条规则跳过它——因为测试夹具必须包含**假凭据**才能测脱敏逻辑。身份类四条规则
**永远不跳过测试树**：真路径和旧角色名出现在测试里同样是泄漏。

两趟扫描是分开的（`scanPass(LEAK_RULES, {skipTests:false})` / `scanPass(SECRET_RULES, {skipTests:true})`），
所以不存在「因为文件在 test/ 里，作者路径也被放过」的情况。

### 6.2 扫哪些文件

- **范围 =「会被发布出去的文件」的集合**：`git ls-files -z --cached --others --exclude-standard`
  （即 **git 跟踪的 + 未被忽略的**）。
  - 这一步是关键的诚实性设计：本地 `npm run build` 产物、`node_modules/`、`data/`、以及各模块
    **手写源码的 `lib/`** 都不会被误判为「不该入库的东西」。
  - 每次运行会先打印扫描范围与文件数，例如「git 跟踪 + 未忽略的文件（N 个）」。
  - **不在 git 检出内时**（比如解压的 tarball）退回目录遍历，并明确打印
    「不在 git 检出内，无法区分忽略文件」——那种情况下结论的强度更低。
- 跳过目录：`node_modules/`、`.git/`、`data/`。
- 只扫这些扩展名：`.mjs .js .cjs .ts .tsx .json .jsonl .yml .yaml .md .css .html .svg .py .ps1 .sh .txt .toml .example`。
- 单文件 > 4 MiB 跳过（避免把大产物读进内存）。

### 6.3 排除清单（按设计允许，不是漏检）

| 排除对象 | 为什么 |
|---|---|
| `scripts/verify.mjs` | 它就是**规则表本身**，扫自己必然假阳性 |
| `config/suite.json` | 本地生成、已 gitignore，按设计含本机绝对路径 |
| `config/persona.md` | 同上（用户自己写的人格） |
| `config/profile/<profile>.patch.yml` | 同上（`setup` 按本机路径生成） |
| 声明 `dsh.suite.prebuilt: true` 的包里的 `lib/**` | 该包**无法在只有桌面版的环境里重建**，只能预置产物；「源码树不含构建产物」这一项对它放行 |

> 前三个排除项在当前实现里其实已被 §6.2 的「只扫 git 跟踪 + 未忽略」覆盖（它们本来就 gitignore），
> 代码里保留是双保险。**入库模板**（`*.example.*`、`*.template.*`）不在任何排除之列。

### 6.4 单条豁免通道：`leak-scan-allow`

确实需要保留旧字面量时（典型：一条回归守卫测试，断言「旧名字已经不在输出里」），在文件里写一整行注释：

```js
// leak-scan-allow: <规则名> （回归守卫：断言迁移后不再出现旧人格 id）
```

> 上面用 `<规则名>` 占位是**故意的**：这一段本身就出现在一个被扫描的 `.md` 文件里。
> 你实际写的时候把占位换成 §6.1 表里的规则名即可。

它的约束是**故意定得很窄**的：

| 约束 | 含义 |
|---|---|
| 只豁免**被点名的那一条**规则 | 不能一条注释豁免全部；写错规则名 = 不生效（宁红不绿） |
| 只对**该文件**生效 | 不是全局开关 |
| **必须是整行注释** | 行首（允许前导空白）必须是 `//`、`#`、`/*`、`*` 之一；写在句子中间的散文不算 |
| 规则名后不能紧跟 ASCII 字母/数字/连字符 | 用 `(?![\w-])` 做尾部守卫。历史坑：原先用 `\b`，而规则名可能以中文结尾（`\b` 在 CJK 前不成立），导致豁免**静默失效** |
| **必须写原因** | 括号里说明为什么必须保留（回归守卫 / 迁移映射表等） |
| **需要复评** | 它是一条技术债：旧字面量本身还留在仓库里，功能演进后应当删除 |

**不允许**用豁免通道处理作者路径、作者名、真实凭据——那三类只能改掉，不能豁免。

> **`.md` / `.mdx` 永远不能开豁免**：即使文档里写了标记也不生效（用探针文件验证过：把
> 带标记的 `.md` 放进 `docs/` 会被正常报出来，删掉即绿）。这样「讲解这个机制的文档」不可能顺手把
> 自己（或别的文档）白掉。本文因此也可以安全地用 `<规则名>` 举例。

### 6.4b 唯一的内建例外：本仓库自己的公开克隆地址（`author-name`）

安装文档必须给出一条**能直接复制运行**的克隆命令（`README.md` 的「克隆仓库」一节）：

```bash
git clone https://github.com/FamousBOBO/dsh-companion.git
```

这是**我们主动发布的入口地址**，不是作者的个人标识泄露。因此 `author-name` 规则在匹配前会把
**这个精确地址**遮掉（`scripts/verify.mjs` 的 `maskPublicCloneUrl()`），其余文本原样扫描。
遮罩是**等长**的（用 `x` 填满同样长度），所以报出来的行号仍是原文行号。

| 写法（`<作者名>` 处填作者标识，`<仓库>` 处填本仓库名） | 结果 | 说明 |
|---|---|---|
| 上面那条克隆命令的等价写法：带 / 不带协议、带 / 不带 `.git`、带 / 不带 `www.` | **不报** | 同一个地址的不同写法 |
| `作者 <作者名>`、`<作者名>-<旧人格id>` | **报 `author-name`** | 单独出现的作者名仍然泄露 |
| `git@github.com:<作者名>/<仓库>.git`（SSH 形式） | **报 `author-name`** | 仓库里没有这种写法；真出现了应当由人判断，不白送豁免 |
| `https://github.com/<作者名>/<别的仓库>`、`…/<仓库>-fork` | **报 `author-name`** | 别的仓库、或者以我们仓库名开头的**另一个**名字，都不是这个地址 |
| `http://<作者名>@github.com/<仓库>` | **报 `author-name`** | 把作者名当 userinfo 用，仍属个人标识 |
| `<盘符>:\Bot\<仓库>`、`<盘符>:\Users\<用户名>\…` | **报 `author-path`** | 本地绝对路径不受这条例外影响 |
| markdown 里的 `leak-scan-allow` 标记 | 不生效 | 见 §6.4，`.md` 永远不能开豁免 |

> 表格里用 `<作者名>` / `<仓库>` 占位是**故意的**，理由同 §6.4：这张表本身就在一个被扫描的 `.md`
> 里，写真实字面量会把自己报成泄露（试过：写下真实作者名与本地路径后，`author-name` 和
> `author-path` 立刻命中本节）。读这张表时按语义理解，不要照抄占位符。

这条例外**只对 `author-name` 生效**，且**写死在代码里、没有对应的配置开关**——它绑定的是
「本仓库自己的发布地址」这一件事。三条自检项会跟着 `static` 一起跑，防止例外被悄悄放宽：

- `author-name 例外仅覆盖本仓库克隆地址`：克隆地址的等价写法必须不报，且 SSH 形式、别的仓库、
  `-fork` 后缀、userinfo 写法必须照旧报；
- `author-name 仍拦截单独出现的作者名`：作者名单独出现（`作者 <作者名>` 之类）必须报；
- `author-path 不受克隆地址例外影响`：作者本地检出路径、`Users/<用户名>` 路径必须报。

### 6.5 绿灯覆盖了什么、没覆盖什么

**覆盖**：上述 7 条形状在**会被发布出去的文件**里的命中情况（含 docs、CI、模板、各模块源码）。

**不覆盖**：

- **未入库/被忽略的文件**（本地配置、`data/`、构建产物、`node_modules/`）——它们不在发布物里，
  但也意味着「本机某处有密钥」不会因此报警；
- 未列出的密钥形状（base64、自定义前缀、环境变量名里的值等）——扫描只认已知形状；
- 二进制文件与未列入扩展名的文件；
- 超过 4 MiB 的文件；
- 迁移包（个人数据，见 `docs/04` §11）；
- 语义层面的问题（比如「这段文案把已保存说成已连接」——那是 `docs/02` §6 的纪律，不是扫描能查的）。

所以正确的表述是：**「泄漏扫描通过」= 在发布物里没命中已知形状**，不是「仓库里没有秘密」。
