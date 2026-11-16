# 07 · 验证状态

> 这份文件的唯一职责是**防止把「没验证」说成「验证过」**。
> 读它的方式：每个能力先看「到哪一级」，再看「证据在哪、什么时候」。**没到就是没到。**

## 1. 五级证据（固定词汇，不自创）

### 2026-11-11 集成测试补充

本次为独立测试分支，未替换生产部署。详细证据见 [集成与迁移报告](17-integration-test-20261111.md) 和 [镜像旁听报告](18-mirror-observe-integration.md)。

| 范围 | 证据级别与结果 | 限制 |
|---|---|---|
| 提醒第二轮、群聊运行时、Prompt Engine、衣柜与视觉身份集成 | `offline-test`：最终 verify 的 unit 9 / static 38 / compose 1 通过；1 个包无测试；镜像专项 38 项通过 | 不代表真实模型质量或平台发送通过 |
| 独立 DSH 0.2.2-rc.1 宿主 | `host-load`：实际启动、陪伴 API 与会话创建成功；浏览器已渲染首页、人格、设置及迁入资料统计 | 桌面工作区已由用户添加（见下条），此条本身仍是浏览器/宿主装载证据，不代表真实模型质量 |
| 昼夜衣柜与 Prompt Engine 组合 | `host-load`：四组实际宿主请求捕获；同一时段在引擎关闭/启用时衣柜文本一致，昼夜结果不同 | 使用本机模拟模型，无真实计费调用 |
| 镜像旁听 | `offline-test` + `host-load`：模拟群事件经实际宿主形成 shadow 记录，禁止动作尝试为 0 | 未证明真实流量、重启和真实模型决策质量；集成配置 QQ 关闭 |
| 标准生产资料迁移 | 六个文件导入，身份沿用；三个数据库 quick_check 与源表记录数核对通过；人格另行备份后复制；用户于 2026-11-11 明确选择仅迁移标准资料，此项完成 | 不含凭据、桌面会话、聊天原文和媒体；提醒不重放，健康授权重置 |
| 迁移资料在真实会话里被使用（第二轮交接补测） | `host-load`：真实宿主 + 迁移数据**副本** + 本机回环录制模型跑通一轮 `session/create`→`session/prompt`；人格 50/50 条语句逐字进入请求、身份绑定返回迁移主人、`companion_recall` 命中迁移记忆、日程工具列出迁移日程；关闭的能力如实报 `disabled` / `runtime-off` / `health-read-denied` / `identity-missing` | 模拟补全，**不是**真实模型质量；未做真实发送、计费生图、健康硬件 |
| 桌面工作区 | 用户已把本 worktree 加入桌面工作区（桌面侧 `storages/workspace.json` 有对应条目） | 这只说明桌面壳注册，不改变 `real-api` / `real-send` / `hardware` 的结论 |

本轮未新增 `real-api`、`real-send` 或 `hardware` 证据。第二轮交接另外修掉两个缺陷（关闭态能力被报成 `pending-load`；提醒停表用例的 `sleep(150)` 假红），详见 [集成与迁移报告](17-integration-test-20261111.md) 的接管验收一节。

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


### 2.6b 表情包链路修复（`codex/expression-sticker-chain`，2026-11-12）：**只有 `offline-test`**

按 `docs/11-expression-sticker-chain-plan.md` 做的四项修复与一次只读诊断建设。**证据级别一律
`offline-test`**：开发环境是独立 worktree（`D:\Bot\DSH-dev\.agents\worktrees\dsh-18e74720-19b6`，
分支 `codex/expression-sticker-chain`，基线 `e2bde2c`），**没有跑过真实宿主装载，也没有触发任何真实
QQ 发送**。下面每一行都写着"改了什么 + 用什么命令证明的"，没有跑过的项写「未验证」。

| 项 | 级别 | 证据 |
|---|---|---|
| 模型侧表情工具名统一（P0-1） | `offline-test` | 人格包 `instruction/behavior` 与 `packet/group-tail` 里指向 `qq_list_emojis` / `qq_send_emoji` 的句子改为「先 `expression_candidates`，有候选用 assetId 调 `expression_reply`；无候选只发文字；一轮最多一张；不传路径/URL/CQ 码」。`companion-group/index.mjs` 的 `GROUP_PERSONA` 补 `expression_sticker_note`（明确追问才 lookup、明确告知才 record）。`test/persona.test.ts` 新增两条：两种 composer（tools.v2 关/开）都不含五个旧表情工具名、且含 `expression_candidates`/`expression_reply`/`assetId`；`GROUP_PERSONA` 不含旧名、含三个 `expression_*` |
| 出站表情服务发现（P0-3） | `offline-test` | `adapters/dsh-host/expression-service.ts` 不再把首次 `registry-miss` / `registry-threw` 永久缓存：每次调用都重新问 `ctx.get('companionExpression')` 与进程级注册表（裸对象与 `Map<dataRoot>` 两种形态都认，单分区无 env 时按其唯一键取）。`test/expression-service.test.ts` **12 项**：四种初始化时序（QQ 先起/图库后挂、图库先挂、首次抛错后恢复、卸载后重挂载拿到新对象）、多 ctx 不串味、形状校验，以及 `sendSticker` 的三条既有纪律（无服务 → `no-service`、无回执 → `no-receipt` 且不重试、无候选不兜底） |
| 入站表情语义（P1） | `offline-test` | `core/message/parse.ts` 的 `StickerSeg` 增加 `kind='sticker'` 与 `semanticPolicy='emotion-support'`；`core/message/render.ts` 每个表情输出 `[表情标记：kind=sticker｜stickerKey=…｜semanticPolicy=…｜knownMeaning=…]`（没记过意思时不输出 `knownMeaning=`），并把旧口径「先在记忆里找…认不出的就说不认识」改写成 docs/11 原文口径：不描画面、不揣度、未知时接住语气/卖萌/带过/沉默、**不主动追问**、只有用户明确问「这是什么意思」才解释。`knownMeaning` 由 `stickerMeanings` 取值函数注入（pipeline → runtime-deps），不做成 render 里读库。`test/sticker-semantics.test.ts` **13 项** + 既有 `sticker-parse.test.ts` 9 项 |
| 词典只读查询 | `offline-test` | `companion-expression/src/sticker-notes.mjs` 新增 `read()`（纯读，不 `markSeen`、不加 `hits`）；入站端口多发布一格 `note`；`features/expression-bridge.ts` 暴露 `lookupSticker`，优先 `read`，老版本句柄才退 `lookup`。渲染一条消息**不会**产生「这个表情又被看见一次」的计数 |
| 工具可见性三层诊断（P0-2） | `offline-test` | `adapters/dsh-host/tool-visibility.ts`：模块是否挂载 / 四个 `expression_*` 是否注册 / 全局与每个活会话作用域里是否可见 / QQ 发送器是否可见；三态（`yes`/`no`/`unknown`，读不出来不许说「没有」），一句话结论按上游到下游报第一个缺口。`test/tool-visibility.test.ts` **11 项**。后台状态快照新增 `expressionVisibility` 一格（脱敏：只有工具名与三态） |
| 素材权限与结果码诊断（P1） | `offline-test` | `companion-expression/src/diagnostics.mjs`：图库/审核态计数、按会话算可用素材数（**同一套** `scopesFor()` + 可见性硬门，不另写 SQL 语义）、最近一次候选/发图的结果码与 `message_id`、最近投递记录；读不出来给 `null` 不给 `0`。`test/diagnostics.test.mjs` **7 项**。运维入口 `plugins/companion-expression/scripts/diagnose.mjs`（只读；`--json` / `--dm` / `--group`），在独立数据目录实跑过一次：`delivery.enabled=关`、图库 0 素材、dm/group 各自给出 `peer-not-approved` / `group-capture-disabled` |
| 「无 `message_id` 不记为已发送」（P2 第 10 条） | `offline-test` | `src/delivery.mjs` 的 `statusOf()` 原先把 `{ok:true}` 但无回执记成 `sent`；现在记 `unknown`（显式 `status=failed/unknown` 照它自己的话）。`test/expression-chain-p2.test.mjs` **6 项**把 docs/11 P2 第 7–10 条钉在一起：无候选不随机挑图 / `reply` 只认候选 `assetId` / 同轮最多一张 / 无回执不算发过且不重投 |
| 出站配图与入站理解分离（P1） | `offline-test` | 入站那条（用户发表情）不再触碰出站逻辑；出站那条（Bot 自己配图）仍走 `presence-afterspeak.ts` 的 `stickerStep`，受 `presence.stickers`、每群 10 分钟冷却与每小时额度约束。`test/presence-stickers.test.ts` **10 项**钉住：`stickers=false` 时一次图库都不问；额度允许时先问候选再用候选 `assetId` 发、且 `mode=text_then_sticker`；冷却/额度按群记且不同群互不影响；**没发成功（`no-candidate` / 无回执）时账本不前进**（一次失败不锁死 10 分钟）；图库抛错与没有服务都只记一行、不冒泡。出站实现本身**未改**（`git diff e2bde2c..HEAD` 对该文件为空） |
| 整体离线验证 | `offline-test` | 开发 worktree：`npm test --workspace=@dsh-companion/channel-qq` → **1793 tests / 1792 pass / 0 fail / 1 skip**（该 skip 是既有的「真实会话文件逐帧解码」用例）；`plugins/companion-expression` `node --test "test/*.test.mjs"` → **227/227 通过**；`npm run verify` → `unit` 9 模块通过 0 失败、`static` 32 通过 0 失败、`compose` **SKIPPED**（本机 `doctor` 探测不到宿主 CLI 入口，见下一行）；channel-qq 的 `check:size` / `check:layers` / `check:syntax` / `check:admin` 全通过 |
| 宿主装载（`host-load`） | **未验证** | ~~开发 worktree 的 `doctor` 报 `[失败] 宿主 CLI 入口 — 宿主目录里找不到 CLI 入口`~~ **2026-11-16 已修**（见 §2.10）：`resources/app.asar/dsh/node_modules` 现在由桌面二进制内部探测，本机 `doctor` 该项转 `[通过]`，版本报 `0.2.2-rc.1`（来源 `probe`）。**但这一条仍然未验证**：探测通过只说明能定位 CLI，不等于插件在运行实例里装载成功。要看装载证据仍得启动日志里那两行 |
| 真实 QQ 发送（`real-send`） | **未验证，且本轮不允许** | 独立 worktree 的 `config/suite.json` 全部沿用模板：`modules.expression=false`、`delivery.enabled=false`、`safety.*` 全关。真实发送必须由操作者在**生产环境**显式触发，并按 §2.6 的口径记录 `provider_message_id` 与回读 `sub_type` |

> 结论措辞只能用：「表情包链路的工具名、服务发现、入站语义、可见性诊断与发送纪律在**离线测试**层面
> 通过（channel-qq 1792 项 + expression 227 项，0 失败）；**宿主装载与真实发送本轮未验证**」。
>
> 三个容易读错的点：
> 1. **`offline-test` 全绿 ≠ 宿主装载通过**：本轮之前 `tools/lib/host.mjs` 推导的 CLI 路径与本机
>    `0.2.2-rc.1` 的 `app.asar` 布局对不上，`compose` 一直是 SKIPPED；2026-11-16 已修（§2.10），
>    现在探测与合成都能跑通，但**装载**仍未验证。要升级这条证据，得看启动日志里有没有
>    `已注册 5 个工具` 与 `宿主接线：发送器=有/采集http=有/入库=有/主人判定=有` 那两行。
> 2. **「表情包不发了」现在可以一句话查清**：后台状态快照的 `expressionVisibility` 与
>    `expression` 两格，加上 `node plugins/companion-expression/scripts/diagnose.mjs --dm … --group …`，
>    分别回答「工具面通不通」与「图库能不能发」。它们是**诊断**，不是发送证据。
> 3. **golden 快照这次更新了 5 份**：`packets/group-called` / `group-keyword` / `group-rich-called` /
>    `group-batched`（只差 `group-tail` 那一行，人格包文案改动），加 `tools/qq-tools`（只差
>    `qq_send_emoji` 的 description 一句「能看到 expression_* 就优先用它们」）。评审时应当逐字节
>    看这五份 diff——它们分别是模型看到的**入站包**与**工具清单**，正是这次要改的东西。
> 4. **一次 `unit` 红是环境抖动，不是回归**：某次 `npm run verify` 里 `@dsh-companion/runtime`
>    报 exit 1；随后单跑该模块 **697/697 通过（连跑 3 次均通过）**，再跑整条 `verify` 也全绿。
>    该模块本次**一行未改**（`git diff e2bde2c..HEAD` 对 `plugins/companion-runtime/` 为空），
>    它里面有跨进程/`Atomics.wait` 的用例，并行跑时对机器负载敏感。按 §4.1 的口径，这类红
>    要先用「单模块复跑」证明不是代码坏了，再往下走。


### 2.10 非 UI 修复轮（2026-11-16）：宿主布局探测 / 静态扫描 / 外部模块指纹

> 这一轮**没有**启动陪伴宿主、没有调真实模型或平台 API、没有改本机 `config/suite.json` 或 `data/`。
> 下面每一行的证据都停在 `offline-test`，只有 `compose` 那一条标了它用的是哪个宿主。

| 项目 | 等级 | 结果与边界 |
|---|---|---|
| 宿主布局探测（`tools/lib/host.mjs`） | **`offline-test`** | `node --test tools/lib/host.test.mjs` → **15/15 通过**（`exists`/`readJson`/`probe` 全部注入，不读本机安装）。矩阵覆盖：`resources/app/dsh`、`resources/app.asar.unpacked/dsh`、`app.asar` 内部、显式 `moduleRoot` 优先、headless 只配 `moduleRoot`、可执行文件在但入口缺失、元数据损坏/缺失、版本低于最低要求 |
| 宿主版本读取 | **`offline-test` + 本机只读实测** | 本机 `resolveHost({})` → `version=0.2.2-rc.1`、`versionSource=probe`、`moduleRoot=…\resources\app.asar\dsh\node_modules`、`cliExists=true`。版本来自桌面二进制**内部**（`app.asar/dsh/package.json` 或 `runtime/primary-runtime/runtime.json`）。plain `node` 读不到 `app.asar`，所以这条路径只能由二进制自己回答；读不到时仍报 `unknown`，不猜 |
| `compose`（隔离实例） | **`host-load`（隔离合成）** | 在本机临时 `DSH_HOME` 里用真实桌面宿主合成：**198 个 loader 行 / exit 0 / 234 ms**，`preset-companion`、`companion-workspace-context`、`companion-foundation` 都在结果里，补丁的 2 个 `file://` 入口全部存在。**这是 `--dump-config` 合成，不是装载**——不代表插件在运行实例里被挂上 |
| `compose`（干净检出） | **`SKIPPED`** | 没有 `config/suite.json` 就没有 profile 可合成。`verify` 现在把这条原因写清楚；旧文案一律说"未检测到宿主"，会把"缺配置"误诊成"缺宿主" |
| 静态发布扫描 | **`offline-test`** | `node scripts/verify.mjs --only=static` → **39 通过 / 0 失败**（基线 38/1：`tools/lib/host-temp.test.mjs:5` 命中 `author-path`）。修法是把测试夹具路径改成运行时拼装，**没有**给该文件加扫描豁免，也没有放松 `author-path` 规则 |
| `tools/` 纳入发布闸门 | **`offline-test`** | `verify` 的 `unit` 段新增一行 `tools（宿主探测 / 外部模块指纹 / 迁移）`：`node --test tools/**/*.test.mjs` 一并跑。之前这些测试只能手动跑，`verify` 全绿并不覆盖它们——上面两条缺陷就是这么漏出来的 |
| 外部 B 站模块指纹 | **`offline-test` + 本机只读指纹** | `node tools/verify-external-modules.mjs`：生产 profile → `code=hash-mismatch`（`bytes=211655`，pin `127D04BE…`）；`data/backups/pnpm-store-repair-20261113` 的副本 → `code=ok`（`bytes=213810`）。两者 `package.json` 的 `version` 都是 `2.4.0` ⇒ 版本号不能当判据 |
| B 站 provider 注册生命周期 | **`offline-test`** | `tools/bilibili-provider-integration.test.mjs` → **5/5 通过**：指纹通过的合成副本 import 后真的把 provider 写进 `Symbol.for('dsh.companion.bilibili.providers.v1')` 注册表；`ready()` 转身 → 端口立刻 `available()===false`；删条目（卸载）→ 不可用；重新挂载 → 恢复；未就绪时 `run` 返回 `failed` 且 0 条证据 |
| B 站派发闸门 | **`offline-test`** | `plugins/companion-runtime/test/{bilibili-provider,bilibili-rounds,p2-bilibili-provider-gate,p2-bilibili-dispatch-order,p2-bilibili-claim-gate,p2-bilibili-watch-gate}.test.mjs` → **14/14 通过**（三轮后：未就绪只丢那一个槽、残留 slot 不 start、**心跳 due/claim 两条路径也被同一闸门挡住**、窗口关闭按 `capability-unavailable` 退役而不写 `missed`、dry watch 报 `blocked-capability` 而非 `claimable`、就绪时 claim 与 start 都照常）。⚠️ 注意别和上一行的 `tools/bilibili-provider-integration.test.mjs 5/5` 混为一谈：那是**两个不同的文件集合**，5/5 是 `tools/` 下的注册生命周期，**14/14** 是 `plugins/companion-runtime/test/` 下的派发闸门（二轮时是 9/9，三轮新增两个文件 5 个用例） |
| 真实 B 站观看/评论/发送 | **未验证** | 本轮**没有**登录、没有触发真实观看或发送。`provider-not-ready` 与派发 fail-closed 保持原样，没有用文案把它写成可用 |
| 模块离线测试 | **`offline-test`** | `npm ci` → `npm run build` → `node scripts/verify.mjs` → `unit` **10 模块通过 / 0 失败 / 1 无测试**（`paste-search` 如实记 `no-tests`）；`static` 39/0；`compose` SKIPPED（干净检出）。`tools/` 那一段如实报 **72 个测试通过**；匹配到 0 个测试文件时它**判失败**而不是记 ok（详见 §2.11） |

**这几条明确不算证据**：Windows 上 `memory-studio` 与 `channel-qq` 在**未构建**状态会红（构建产物缺失），`npm run build` 后转绿——既不是缺陷，也不能说成"模块本来就好"；「合成 198 行」不等于「运行实例里 198 个都活着」；指纹通过只说明字节对，不说明 B 站账号能用。

### 2.11 PR #4 二轮审查的修复（2026-11-17）：两个 P1 + 五个 P2 + 三个 P3

> 本轮是**只读审查**的后续修复。仍然**没有**启动陪伴宿主、没有调真实模型 / B 站 / QQ、
> 没有改本机 `config/suite.json` 或 `data/`。下面每条都只到 `offline-test`。

审查结论是「不建议按现状合并」：P0 = 0，P1 = 2（+1 表述性），P2 = 5，P3 = 3。
`648e1d8` 那一轮的 CI 确定性修复本身是干净的，但它没有碰任何一个 P1。

| 编号 | 缺陷（一句话） | 修法 | 证据 |
|---|---|---|---|
| **P1-1** | 分享决策永远读不到历史：钩子工厂不传 `scopeKey` → runtime 答 `unbound` → 就算作用域对了，`status:'all'` 也被当成一个状态值塞进 `WHERE status = ?`，匹配零行。于是 `duplicate` 永不触发、`maxSharesPerDay` 永远数到 0 | ① `resolveHistory()` 把 `scopeKey` 拆回 bound 一起传下去；② `listShareCandidates()` 认得 `'all'` 是"不筛状态"；③ 钩子链上每一段都真的把 scope 送到 | `plugins/companion-foundation/share-history-scope.test.mjs` **4/4**：`'all'` 读到已离开 `pending` 的行；**同一活动第二次完成命中 `duplicate` 且行数不变**；窗口内第 3 条按 `budget-exhausted` 拒绝；scope 真缺失时 `scope-required` + 零写入 |
| **P1-2** | B 站闸门放错位置：`ORDER BY start_at ASC LIMIT 2` 先取两行、再在循环里跳过，两行都是 duty 时**这一拍一条都不 start**，read/explore/write 被饿死；`bilibiliSkipped` 计数器是死变量 | 判据前移，duty 未就绪就在**同一句 SQL** 里排除（`AND (s.activity <> 'bilibili' OR ? = 1)`）；`LIMIT` 数的是真能派的槽位；跳过另查一次并**每拍一条** `noteError`（不再每槽一条）；删掉死变量 | `plugins/companion-runtime/test/p2-bilibili-dispatch-order.test.mjs` **2/2**（真 P2 + 真 reducer + 临时 SQLite）：2 个到点 duty + 1 个 read ⇒ **read 照常 start**，duty 仍是 `planned`（跳过不是认领），且跳过理由只记一条；同一组槽位在 provider 就绪时 duty 重新拿到先手 |
| **P1-3** | planner 把"一个能力不可用"升级成"整份计划作废"：模型只要顺手排了一次刷 B 站，read/explore/write 一起失效，重试两次仍一样，这一天没有计划；与派发侧"只跳过自己"的语义矛盾。`bilibiliProviderReady` 字段写进 `dispatchWatch` 后无人读 | 改为**只丢那一个槽**：`normalizeSlot()` 返回 `{dropped}`，`parseDayPlan()` 汇总进 `plan.dropped`，planner 逐个 `report()`；`dispatchWatch` 的 `bilibiliProviderReady` 由 `p2DispatchWatch()` 投影到 `result.p2.bilibiliProviderReady`（活的消费者） | `p2-bilibili-provider-gate.test.mjs` **4/4**（新增"同一份计划里的 read 槽照常入册，丢的不是整天"）：reason 码 `slot-dropped:bilibili-provider-unavailable`，`plan.dropped` 恰一条，read 照常 `committed` |
| **P2-1** | `verify` 的 `tools` 段匹配到 **0 个**测试文件时 `# tests 0` / exit 0 ⇒ 记为 ok（假绿） | 先数 `tests`，为 0 直接判失败并写明"这一段什么都没检查"；计数同时认 `ℹ tests N`（spec）与 `# tests N`（TAP）两种尾巴 | `node scripts/verify.mjs` → `tools（宿主探测 / 外部模块指纹 / 迁移） — 72 个测试通过`；临时改名目录后该行变 ✗ |
| **P2-2** | group-mirror e2e 占死端口 31492/31493：同机任何进程占着它都会把整组打红，而它已经被并进发布闸门 | 假 SSE 源 `listen(0)` 由系统分配并回读端口；`fakeOneBotPort` 允许 `0` 表示"系统分配"，`FakeOneBotServer.listen()` 把真实端口写回并新增 `address()`；重连用例改成"只断已建立的连接、源仍在原端口监听" | `tools/group-mirror/test/e2e.test.mjs` **6/6** |
| **P2-3** | `purpose:'explicit'` 只影响渲染，`minScore`/`coverageFloor`/语义门限一处都没读它 —— 参数看着像旋钮，实际没有消费者 | 显式查询把**词法覆盖率**门槛下调一次（固定 0.5 倍、硬下限 0.06），自动注入不变；每次下调在 `explain.filteredReasons` 留 `explicit-floor-relief` | `plugins/companion-memory/test/explicit-floor-relief.test.mjs` **4/4**：显式 floor = 0.075 vs 自动 0.15；无关查询在两条路径下都仍被拒（下调有界）；`coverageFloor:0.1` 时被硬下限抬回 0.06 |
| **P2-4** | `historyFallbackEnabled` 从 `config.mjs` 一路传到 `buildQueryPlan()` 写进 `plan.historyFallback`，然后**没有任何消费者**：关掉开关行为不变 | 无话题时的兜底分支先读它：关掉 ⇒ 空结果 + `history-fallback-disabled`；打开（默认）⇒ 与改动前逐字相同 | `plugins/companion-memory/test/history-fallback-switch.test.mjs` **3/3** |
| **P2-5** | 指纹比较一边 `digest('hex')` 小写、一边 pin 原样比：pin 写成大写（文档里就是 `127D04BE…`）会把**正确**的字节判成 mismatch，运维"修"的时候就会把模块换成磁盘上那份，把闸门反过来 | `sameSha256()` 两侧先 `trim().toLowerCase()` 再比 | `tools/verify-external-modules.test.mjs` **9/9**：新增大写 pin 通过、以及"大小写不敏感不放宽字节判据"（换字节仍 `hash-mismatch`） |
| **P3-1** | 文档里两个 "N/N" 指的不是同一批文件，容易被混读 | `docs/07` 的 B 站派发闸门一行改成 **9/9**（`plugins/companion-runtime/test/` 四个文件），并显式标注"别和上一行 `tools/` 的 5/5 混为一谈" | 见本表前一节 |
| **P3-2** | `settleCount` 没有墙钟上限，"恰好 2 条"实际是"前 300ms 内恰好 2 条" | 加 `maxMs=3000`：到顶仍没有静默窗口就**抛错**，而不是返回一个从没稳定过的计数 | `plugins/dsh-channel-qq` 全量 **1907/1906 pass / 0 fail** |
| **P3-3** | `reminders-dispatch-timing.test.ts` 一处 `} finally {` 与上一条断言挤在同一行 | 换行 | 同上 |

总账（本机实测）：`node scripts/verify.mjs` → `unit` 10 通过 / 0 失败 / 1 无测试，`static` 39/0，
`compose` SKIPPED（干净检出）；`plugins/companion-runtime` **717/717**；`plugins/companion-memory`
**308 tests / 301 pass / 0 fail / 7 skip**；`plugins/companion-foundation` **480/480**；
`tools/**` **72/72**；`@dsh-companion/channel-qq` **1907 tests / 1906 pass / 0 fail / 1 skip**，
`check:layers` 与 `check:size` 均通过。

**这些仍然不算证据**：本轮没有真宿主装载、没有真模型、没有真 B 站账号、没有真 QQ 发送；
`purpose:'explicit'` 的门槛下调只在词法覆盖率上生效（向量通道的门限没动，也没测）；
「B 站只丢一个槽」证明的是**计划与派发语义**，不是"账号能用"。

### 2.12 PR #4 三轮审查的修复（2026-11-17）：一个 P1 + 一个 P2 + 一个 P3

> 二轮修复合入后仍然**只有 `offline-test`**：没有启动陪伴宿主、没有调真实模型 / B 站 / QQ、
> 没有改本机 `config/suite.json` 或 `data/`。本节把二轮**没有覆盖到的**三个洞补上。

三轮复核确认二轮的 2 个 P1 与 5 个 P2 都已真的落地（逐条用探针复跑过），并新发现三条：

| 编号 | 缺陷（一句话） | 修法 | 证据 |
|---|---|---|---|
| **P1-4** | 能力闸门只装在**泵**上，没装在**claim**上。provider 未就绪时 `dueSlotsForHeartbeat()` 仍把 B 站槽交给心跳、`claimSlotForHeartbeat()` 仍答 `ok:true` → 槽 `planned→started`、泵（正确地）不 start、窗口关闭后 missed 扫描把它记成 `{operation:'missed', code:'window-closed'}` 并调 `onMissed(reason:'window-closed')`。**一个从未被允许执行的能力被记成"计划了却没做到"**，明天的 planner 会当成失败喂进 `recentOutcomes` | 判据抽成**唯一实现** `capabilities.mjs bilibiliProviderReady()`，五条路径共用：① capability 目录 ② heartbeat due 查询（`CAPABILITY_GATE_SQL`）③ `claimSlotForHeartbeat()` 直接返回 `{ok:false, code:'capability-unavailable'}` ④ pump due 查询（同一句片段）⑤ wrong watch/metrics。missed 扫描对未就绪能力改记 `detail:'capability-unavailable'` 并**退役但不写 `missed` 收据、不调 `onMissed`**；真 miss（read/explore 等）语义不变。`capability-unavailable` **不** `bumpRejection`（provider 缺失不该消耗 `maxAttempts`） | `plugins/companion-runtime/test/p2-bilibili-claim-gate.test.mjs` **3/3**：① 同一拍里 read 照常 start、B 站槽留在 `planned`、零 `plan-slot` 事件；② 窗口关闭的 B 站槽 `expired` + `detail:'capability-unavailable'`、**0** 条 `missed` 收据、**0** 条 `onMissed`，而同一轮里的 read 槽照旧 `detail:'missed'` + 1 条收据 + 1 条事实；③ provider 就绪时 claim 成功、泵照常建 activity |
| **P2-6** | dry watch 用的是**没有**能力闸门的 due 判据副本，于是永远跑不了的 B 站槽被报成 `state:'claimable'` 并给出 `expectedBeat` 拍号 —— 一个没人能兑现的承诺；打开开关前看到的正是反的 | `DUE_SQL`/`DUE_COUNT_SQL` 接同一闸门参数，另加 `GATED_SQL` 把被排除的槽报成**新增状态** `blocked-capability`（`blockReason:'bilibili-provider-not-ready'`，`expectedBeat:null`）；`counts.capabilityBlocked`、`metrics.slots_capability_blocked`/`capabilityGate` 一并新增；新状态写进 `CONTRACT.md` §15.3/§15.6，不是悄悄扩词表 | `plugins/companion-runtime/test/p2-bilibili-watch-gate.test.mjs` **2/2**：未就绪时 `claimable` 1 / `capabilityBlocked` 1、`slots_due` 1 且 `slots_open` 2、被报 `blocked-capability` 的槽**没有** `expectedBeat`，随后的真心跳只 claim 了那个 read 槽；就绪时两个槽都回到 `claimable`、`capabilityGate:'ready'`、心跳真的 claim 两条 |
| **P3-4** | `p2-wiring-web-live.test.mjs` 只在顶层 `code === 'source-fetch-failed'` 时 `skip`，但 `search()` 会把**所有** provider host 的失败聚合成 `search-unavailable`、把真因放进 `failures[]`。于是"这台机器没网"被判成**失败**，"未验证"读成了"坏了" | `skip` 判据同时认 `failures[0]?.code === 'source-fetch-failed'`；并在离线可复现的 `p2-wiring-web.test.mjs` 里固定这个聚合形状（`fetchImpl` 抛 `TypeError('fetch failed')` → `code:'search-unavailable'` + `failures[0].code:'source-fetch-failed'`），让 live 用例的跳过条件本身有证据，而不是靠哪台机器恰好跑它 | `plugins/companion-foundation/p2-wiring-web.test.mjs` **36/36**（含新增的聚合形状用例）；`p2-wiring-web-live.test.mjs` 在有网的本机 **2/2 pass**（本轮**没有**在无网机器上复现那条 skip，属于未验证） |

顺带一处**必须说明的形状变化**：`dueSlotsForHeartbeat()` 的返回值多了 `skipped`（被能力闸门排除的
到期槽数）。这是一次**只增不改**的字段添加，`p2-heartbeat-dispatch.test.mjs` 的整形状断言同步更新为
`{slots:[], deferred:'dispatch-disabled', skipped:0}`（整拍拒绝时闸门根本没跑，所以是实测 `0`，不是 `null`）。

总账（本轮本机实测）：`node scripts/verify.mjs` → `unit` 10 通过 / 0 失败 / 1 无测试，`static` 39/0，
`compose` SKIPPED，exit 0；`plugins/companion-runtime` **722/722**；`plugins/companion-memory`
**308 tests / 301 pass / 0 fail / 7 skip**；`plugins/companion-foundation` **543 tests / 534 pass /
0 fail / 9 skip**；`tools/**` 72/72；`@dsh-companion/channel-qq` **1907 tests / 1906 pass / 0 fail / 1 skip**。

**这些仍然不算证据**：没有真宿主装载、没有真模型、没有真 B 站账号、没有真 QQ 发送；
`blocked-capability` 只是把一个**假事实**（"claimable 但永远不 claim"）换成一个**真事实**
（"能力未就绪"），**不是**把 B 站跑通；`slots_capability_blocked` 也只在 provider 未就绪时有值
（`capabilityGate:'not-reported'` 时不做排除，也不假装排除过）。

### 2.13 PR #4 四轮审查的收口（2026-11-17）：观测层两条（N1 / N2）

> 四轮复核的结论是**可以合并**，并确认三轮三条全部落地。四轮同时指出：闸门修完之后，
> 还有两处**只读观测**仍在说反话。本节只处理这两条，不动任何写路径、不新增状态名。

| 编号 | 缺陷（一句话） | 修法 | 证据 |
|---|---|---|---|
| **N1（P2）** | `WILL_MISS_SQL` 没有接能力闸门。两个窗口都已关闭时，watch 把能力未就绪的 B 站槽报成 `will-miss`，`blockDetail` 写着"the pump files it as missed"，而泵对它是按 `capability-unavailable` 退役、**不写收据**。于是 `counts.willMiss` 大于泵真的会写的 `missed` 条数——承诺了一条不会发生的事实 | 新增 `GATED_CLOSED_SQL` + `capabilityGatedClosedSlotRows()`，把"窗口已关闭 + 能力未就绪"的槽从 `will-miss` 收进 `blocked-capability`，`blockDetail` 明写"按 capability-unavailable 退役、不记 missed"。只在 `bilibiliReady === false` 时查询，避免就绪时把行吞掉 | `plugins/companion-runtime/test/p2-bilibili-watch-capability.test.mjs` **4/4** 的前两条：未就绪时 `willMiss 1 / capabilityBlocked 1`（真 miss 仍走 `will-miss`，B 站槽 `blocked-capability` 且 detail 不含"files it as missed"）；随后泵真的只写 **1** 条 `missed` 收据，B 站槽 `detail='capability-unavailable'`；就绪时两条都回到 `will-miss` |
| **N2（P3）** | `CLAIMED_SQL` / `CLAIMED_COUNT_SQL` 也没有闸门。就绪时被 claim、随后 provider 消失的 `started` 槽，同时被 `rows[]` 标成 `blocked-capability`、又被 `metrics.claimed_awaiting_start` 数成"等泵"——**一个 payload 里两个数字互相矛盾**。可达性正是修复落地那一瞬间的生产库 | 两个查询都接同一闸门参数；这类槽不再计入 `claimed_awaiting_start`／`claim_age_ms`（它不属于"等泵"，泵永远不会开始它），但仍计入 `slots_open`。`CONTRACT.md` §15.1 那一行同步改了口径 | 同上文件后两条：provider 变未就绪后 `counts.awaitingStart=0` 与 `metrics.claimed_awaiting_start=0` **一致**、`claim_age_ms=null`／`claim_age_source:'none'`、`slots_capability_blocked=1`，而 `slots_open` 仍是 1（认领本身是真的）；就绪时 `awaitingStart=1`、`claim_age_ms=5 分钟`、`claim_age_source:'recorded_at'`——闸门没有把认领吞掉 |

总账（本轮本机实测）：`node scripts/verify.mjs` → `unit` 10 通过 / 0 失败 / 1 无测试，`static` 39/0，
`compose` SKIPPED，exit 0；`plugins/companion-runtime` **726/726**（三轮时 722，本轮 +4）；
`plugins/companion-runtime/test/*bilibili*` 全部 **18/18**（三轮时为 14/14）。

**这些仍然不算证据**：同 §2.12——没有真宿主装载、没有真模型、没有真 B 站账号、没有真 QQ 发送。
N1/N2 都只改**只读观测**：没有写路径变化，没有新状态名（`blocked-capability` 是三轮时进
CONTRACT §15.3 的那个），也没有让 watch 从"零写入"变成会写。

### 2.14 PR #4 五轮审查的收口（2026-11-17）：N4 行覆盖 + N5 口径

> 五轮复核确认 N1/N2 已修（并用独立探针拿到"预测值 == 泵真正写出的事实"的比对证据），
> 同时指出 N2 的修法带出一个**行覆盖**漏洞。本节只补这两条，仍不动写路径。

| 编号 | 缺陷（一句话） | 修法 | 证据 |
|---|---|---|---|
| **N4（P3）** | N2 把闸门接进 `CLAIMED_SQL` 后，`started` + **窗口尚未开启**的 B 站槽从 `rows[]` **整条消失**：它不是 `due`（`start_at > now`）、不是 `will-miss`（`end_at > now`）、也不再是 `awaiting-start`。三条窗口有界的查询各差一个时间条件，中间正好漏掉这一段 —— `slots_open` 说 3，`rows[]` 只剩 2，**"每个未结槽出现且只出现一次"这条不变量破了** | 再加一条**没有任何窗口判据**的 `GATED_ANY_SQL` / `capabilityGatedAnySlotRows()`，只按能力过滤，保证行覆盖；行级状态统一由 `gatedState(row)` 按窗口位置判定（已关 / 未开 / 开着），`blockDetail` 分三句写各自的退役方式；`GATED_SQL`/`GATED_COUNT_SQL` 保持 due-now 语义 | `plugins/companion-runtime/test/p2-bilibili-watch-capability.test.mjs` 新增两条：三个 `started` 槽（已关 / 开着 / 未开）⇒ `rows[]` 恰三条且 id 集合 `['b-closed','b-future','b-open']`、全部 `blocked-capability`、`expectedBeat:null`、detail 不含 "files it as missed"；同时 `metrics.slots_capability_blocked` 仍是 **1**（due-now 只数到期的那个），证明把行覆盖和 due-now 计数分开而不混为一谈；就绪回归：同样三条全部出现，`b-closed` 回 `will-miss`、另两条 `awaiting-start` |
| **N5（P3）** | `counts.capabilityBlocked`（按 state 数行，覆盖所有窗口位置）与 `metrics.slots_capability_blocked`（due-now）名字相近、数值可能不同（3 vs 1），容易被读成"又打架" | 不改名（观测字段已冻结），在字段旁与 `CONTRACT.md` §15.3/§15.6 各写一句口径；测试里直接用 3 vs 1 把这个差异钉成**有意的** | 同上：N4 主用例断言 `counts.capabilityBlocked === 3 && metrics.slots_capability_blocked === 1`，并在注释里写明这是两个不同的问题 |

总账（本轮本机实测）：`node scripts/verify.mjs` → `unit` 10 通过 / 0 失败 / 1 无测试，`static` 39/0，
`compose` SKIPPED，exit 0；`plugins/companion-runtime` **728/728**（四轮时 726，本轮 +2）；
`plugins/companion-runtime/test/*bilibili*` 全部 **20/20**（四轮时为 18/18）；
`plugins/companion-runtime/test/p2.5-dispatch-observability.test.mjs` **12/12**（watch 仍零写入）。

**这些仍然不算证据**：仍无真宿主装载、无真模型、无真 B 站账号、无真 QQ 发送。
N4 的**可达性不夸大**：心跳只交窗口覆盖 `now` 的槽，自己不会产生"`started` + 未来窗口"；
`claimSlotForHeartbeat()` 没有窗口校验，宿主直接调它才会造出这个状态——所以判 P3，
而不是写成"生产必然发生"。本节两条同样只改只读观测，没有新增状态名。


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


### 2026-11-12 媒体完整提示词修复

证据级别：offline-test。新增 companion_media_visual 只读工具；模型按工具约束先读取身份和当前衣物，再写完整英文画面。取消服务端身份、衣物、正向预设和质量词的拼接，NAI 最终正向仅为画师串 + 主提示词。

- npm ci、npm run build：通过。
- node --test plugins/companion-media/test/*.test.mjs：162/162 通过；含只读参考、最终请求正文不追加、排队传输、身份缺失拒绝和群聊隔离相关覆盖。
- npm run doctor：核心检查通过；宿主版本无法检测。
- npm run verify：unit 5 模块通过、4 模块失败、1 无测试；失败涉及 foundation、memory-studio、runtime、channel-qq。static 38 通过、1 失败（原有 production-closeout 文档中的 author-path）；compose 1 通过（232 loader 行）。全仓验证未通过，不将其描述为全绿。
- 未重启运行中的宿主；未验证新工具真实宿主装载、真实模型是否遵守读取顺序或最终图片质量；未调用计费生图 API。需宿主重新加载媒体插件后应用新工具定义。


### 2026-11-12 补充：保留 Light 正向质量预设并重启

按用户要求恢复所选官方正向质量预设的生效逻辑（Light），继续禁止追加身份、衣物与旧手填正向预设。最终正文为画师串 + 完整主提示词，随后应用所选质量词。媒体离线测试 162/162 通过。

已通过生产管理脚本重启现有受管理应用，认证首页和记忆接口均为 HTTP 200、核心插件激活检查通过；媒体 status/config 接口 HTTP 200，读回模型 nai-diffusion-5-full、qualityPreset=light。未触发真实计费生成，图片质量及真实模型读取行为仍未验收。启动中宿主另报告部分旧插件版本不兼容，核心健康检查通过不代表所有可选插件均已加载。
