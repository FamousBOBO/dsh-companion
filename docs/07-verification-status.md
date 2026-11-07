# 07 · 验证状态

> 这份文件的唯一职责是**防止把「没验证」说成「验证过」**。
> 读它的方式：每个能力先看「到哪一级」，再看「证据在哪、什么时候」。**没到就是没到。**

## 1. 五级证据（固定词汇，不自创）

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
| `companion-foundation` | **213 项 / 204 通过 / 0 失败 / 9 跳过** | **✅ 已装载**（C 段：无 `did not activate`；日志出现它的 identity 初始化行） | 未验证 | — | — |
| `companion-memory` | **268 通过 / 0 失败** | **✅ 已装载**（C 段） | 未验证 | — | — |
| `companion-memory-studio` | **115 通过 / 0 失败** | **✅ 已装载**（C 段：UI 返回 HTTP 200 / 38252 字节） | 未验证 | — | — |
| `companion-runtime` | **697 通过 / 0 失败** | **✅ 已装载**（C 段） | 未验证 | — | — |
| `companion-group` | **10 通过 / 0 失败** | **✅ 已装载**（C 段） | — | 未验证 | — |
| `dsh-channel-qq` | **1208 项 / 1207 通过 / 0 失败 / 1 跳过** | 未验证（验收未启用通道：没有 OneBot 服务） | 未验证 | **未验证** | — |
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

### 2.6 表情包系统（`companion-expression`）：`offline-test` + 一条 `host-load`（2026-11-07）

按 §1 的五级词汇，**真实平台发图仍未验证**。下面这张表是它现在的真实状态，不要读成「可用」：

| 项 | 级别 | 说明 |
|---|---|---|
| 采集授权判定、作用域隔离、sha256 物理去重 | `offline-test` | `node --test plugins/companion-expression/test/*.test.mjs` → **144 项通过 / 0 失败**（2026-11-07）；未授权来源 0 下载、0 入库（用例钉住） |
| 下载安全（魔数判型 / 体积与像素上限 / SSRF / 重定向 / 文件名穿越） | `offline-test` | 全部用注入的假 `http`，**没有一次真实网络请求** |
| 检索、决策、冷却与配额、回复计划、幂等投递 | `offline-test` | 假 `qqSender`；`unknown` 不重投的用例在其中 |
| 反馈学习（`reject` 立刻抑制重发） | `offline-test` | — |
| **宿主接线**（从 `ctx` 取发送器 / 采集 `http` / 入库适配 / 主人判定） | `offline-test` | `test/host-wiring.test.mjs` **21 项** + `test/apply-wiring.test.mjs` **4 项**。证明：① `apply` 能从 `ctx.tools` 把 `qq_message`/`qq_sticker` 接成 `qqSender`（发送走 `tools.execute()`，不绕过通道闸门）；② 接上后 `expression_reply` 不再回 `sender-unavailable`（此时拦住它的才是 `delivery.enabled`）；③ 接上后入站端口 `observe()` 不再回 `ingest-not-injected`，`offers()` 与入库用同一个 `scopesFor().capture`；④ 拿不到工具表时仍注册四个工具、照常发端口，并**如实**报 `sender-unavailable`；⑤ 工具名在**发送那一刻**按会话作用域解析（QQ 工具挂在 preset 作用域里，不带 scope 的 `get()` 只看全局层），看不到就回 `tool-not-visible` 且 0 次调用。全程假工具表 + 假 `fetch`，**零网络、零 QQ** |
| 生产宿主上的接线诊断行 | `host-load` 的观测（不是端到端验收） | 2026-11-07 重启段日志：`[companion-expression] 宿主接线：发送器=有、采集http=有、入库=有、主人判定=有。` 这一行只说明**四路依赖都取到了**，不代表发过图；`isOwner` 读的是 `data/home/companion/identity.json` |
| Studio 管理入口（图库 / 收集规则 / 实验室 / 习惯） | `offline-test` | 页面片段在最小 `P` 桩与 `smoke-client.mjs` 下渲染通过（**表情包相关失败 0 项**），`test/expression-page.test.mjs` **16 项通过**；**没有在真实浏览器里点过** |
| Studio 管理 API（12 条路由 / 10 个 path） | `offline-test` | `test/http-api.test.mjs` **12 项通过**：路由表、Origin 守卫、只认 `assetId`、`/thumb` realpath 越界 403、未启用态 200+启用片段、`/simulate` 恒 `sending:false` |
| 宿主装载 | **`host-load` 已达成（2026-11-07）** | 两次独立达成：① `npm run check:hostload --workspace=@dsh-companion/expression`：临时 `DSH_HOME` + 临时数据目录、`modules.expression=1`、只开 `expression` 补丁块；② 生产切换（`dsh-ops`，`expressions` 分支 `0278264`）真宿主启动后日志三行齐全（`已发布入站端口 dsh.companion.expression.v1` / `已注册 4 个工具（defineTool=host）` / `[companion-expression-http] 已注册 10 条管理路由`），且无 `did not activate`。裸 `fetch` 回 **401**（宿主 token 换会话的行为，浏览器里才有 cookie），因此判据不拿 200 作数 |
| 补丁渲染与合成 | **`host-load` 的一部分（仅渲染+合成，未装载）** | `npm run check:patch --workspace=@dsh-companion/expression`：把模板按「四个可选块全开」渲染后送宿主 `--dump-config`，**217 个 loader 行**、`expression` 与 `expression-http` 两行都在（2026-11-07） |
| 真实平台发图 | **未验证** | `delivery.enabled=true` 已在生产打开，且发送器**已经接到** `qq_message`/`qq_sticker`（2026-11-07 接线落地后），但**没有任何一条真实 QQ 回执证据**。要达成 `real-send` 必须由操作者显式触发一次发送并留存回执（`deliveries` 表一行 `status='sent'`）。`assets`/`deliveries`/`expression_feedback` 当前均为 0 行 |
| GIF 关键帧理解 / OCR / embedding 向量召回 | **未实现** | 代码里是 `NOT_IMPLEMENTED` 常量，不是「待验证」 |
| QQ 内置 `face` 表情投递 | **未实现** | 现有通道没有可复核的 face 发送入口，不凭空构造 |

> 结论措辞只能用：「表情包系统的采集、检索、决策、**宿主接线**、投递与反馈在**离线测试**层面通过，
> 两行插件在真宿主上**装载成功**；**真实发图未验证**」。不得省略后半句。
>
> 「接线已落地」不等于「能发出去」：它只说明**出口存在、且走的是同一道闸门**（预执行策略、
> 群边界、出站边界都照常跑），不说明某一条消息真的到了 QQ 上。


## 3. 明确「未验证」清单（当前）

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

- 群聊里发图 / 发语音出站、群内自主接话的真实触发。
- 表情包系统（`companion-expression`）的宿主装载与真实发图：见 §2.6。图库、决策、管理入口只到
  `offline-test`；GIF 关键帧 / OCR / 向量召回 / QQ 内置 `face` 投递**未实现**。
- 主动联系（contact）的真实平台发送与回执。
- 提醒的四条停止线（停机可观测 / 不重复外发 / 空转可见 / 阈值合理）在真机上的验证。
- 真实 24 小时长稳（只做过模拟时钟）。

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
| 正文/身份 | `author-name` | 作者的个人标识（昵称变体、`<名>-<旧人格id>` 形式的用户号） | **不豁免** |
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
