# 02 · 配置

> 本文只讲「配置在哪、每个字段什么意思、密钥怎么处理、状态怎么表述」。
> 部署流程见 `docs/01-deployment.md`；某个模块当前能不能用见 `docs/03-modules-support-matrix.md`。

## 1. 配置分三层

| 层 | 位置 | 谁写 | 入 Git? |
|---|---|---|---|
| 套件级 | `config/suite.json`（模板 `config/suite.example.json`） | 用户 / `npm run setup` 生成 | ❌ gitignore |
| 人格 | `config/persona.md`（模板 `config/persona.example.md`） | 用户 | ❌ gitignore |
| 模块级 | `<dataDir>/home/…` 下各模块的 `*.config.json` | 模块首次加载时原子写默认值，或用户在 UI 改 | ❌ 整个 `data/` 都 gitignore |

**唯一权威**：每项配置只有一个权威文件。`cordis.patch.yml` 里的插件行**不再写第二份**同名配置
（历史上两份真相导致过「界面改了不生效」）。例外是通道类插件（QQ / B站）——它们的开关本来就在
profile 的 patch 里，见 §3.5。

### 1.1 优先级（从高到低）

1. 环境变量（见 §2.9）
2. `config/suite.json`
3. `config/suite.example.json` 模板值
4. 代码内 `SAFE_DEFAULTS`（与模板一致；模板缺失时兜底）

缺字段永远不报错：每个字段都有文档化的默认值，**可选模块默认关闭**。

---

## 2. 套件级配置：`config/suite.json` 逐字段

模板在 `config/suite.example.json`。`$comment` / `$xxxComment` 是给人看的注释键，程序忽略。

### 2.1 `version`

| 类型 | 默认 | 说明 |
|---|---|---|
| number | `1` | 配置格式版本。升级套件时可用来触发迁移提示；当前只接受 `1`。 |

### 2.2 `dsh`（宿主位置）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dsh.executable` | string | `""` | 宿主可执行文件绝对路径。留空 = 自动探测（`docs/01` §5.1）。探测失败时 `doctor` 会打印它试过的路径。 |
| `dsh.moduleRoot` | string | `""` | 宿主内置插件目录（`…/resources/app/dsh/node_modules`）。`--expose-internals` 启动要用它。 |
| `dsh.profile` | string | `"companion"` | 本套件的独立 profile 名。不要与用户已有 profile 重名。 |
| `dsh.permissionMode` | string | `"workspace-write"` | 桌面会话默认权限。可选 `read-only` / `workspace-write` / `danger-full-access`。**无人值守通道（QQ）不等于桌面会话**，其权限在通道自己的配置里。 |
| `dsh.tempDir` | string | `""` | 临时目录。留空 = `<dataDir>/tmp`。Windows 上**不要**指到系统盘的用户目录（历史事故：临时文件写满用户目录）。 |
| `dsh.startTimeoutMs` | number | `120000` | 启动就绪等待上限。慢机器可加大。 |

### 2.3 `dataDir`

| 类型 | 默认 | 说明 |
|---|---|---|
| string | `""` | 运行期数据根。留空 = `<套件根>/data`。可写绝对路径或相对套件根的路径。子布局固定（见 `docs/01` §4.2）。 |

### 2.4 `modules`（启用哪些模块）

| 键 | 默认 | 对应模块 | 打开前提 |
|---|---|---|---|
| `core` | **`true`** | `companion-foundation` + `companion-memory` + `companion-runtime` + `companion-group` | 恒为真（强制），关不掉；没有它套件没有意义 |
| `memoryStudio` | **`true`** | `companion-memory-studio`（陪伴空间 Web UI） | 依赖 core 成套安装 |
| `qq` | `false` | `dsh-channel-qq` | 需要外部 NapCat/OneBot 服务地址+token |
| `qqIdleCompaction` | `false` | `qq-idle-compaction`（QQ 会话空闲压缩，**会调用模型**） | 独立于 `modules.qq`；建议同时有 `safety.backgroundModelTasks` 的明确授权 |
| `bilibili` | `false` | **外部模块** `dsh-bili-scroll`，不在本仓库（见 §3.7） | 需要自行安装第三方 tarball + Python 环境 |
| `health` | `false` | `companion-health` + `sidecars/huawei-health-cn` + `sidecars/ble-heart-rate` | 需要华为健康 sidecar 与/或 BLE 设备；**云端通道还要自备上游检出**（§3.6） |
| `media` | `false` | `companion-media` | 通常还需要外部 TTS / 生图服务 |
| `pasteSearch` | `false` | `dsh-paste-search`（贴图搜索入口） | 无外部依赖，但属可选 UI |

> **本版没有 `modules.superInjector`**：`dsh-super-injector` 因许可证文本缺失与无法验证，已整体
> 移出发布范围（原因见 `docs/03` §1.2）。它的能力需要用户自行从上游获取。

> **核心模块成套安装**：foundation / memory / memory-studio / runtime / group 之间是**兄弟相对
> import**，必须成套安装（本仓库的 npm workspaces 已保证）。不要单独取用某一个包。

### 2.5 `services`（外部服务连接）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `services.onebot.url` | string | `""` | OneBot v11 正向 WebSocket 地址，例 `ws://127.0.0.1:3001`（NapCat）。**不填就不连、不重试** |
| `services.onebot.accessToken` | string | `""` | NapCat 的 WS token。**这是密钥**：只写本地文件，见 §5 |
| `services.onebot.selfId` | number | `0` | 机器人自己的 QQ 号 |
| `services.health.sidecarUrl` | string | `""` | 华为健康 sidecar 地址，例 `http://127.0.0.1:8765`。必须是回环地址（模块级校验会强制） |
| `services.media.baseUrl` | string | `""` | 媒体服务地址（TTS / 生图网关） |
| `services.media.apiKeyEnv` | string | `""` | **只填环境变量名**（例 `DSH_MEDIA_API_KEY`），密钥值放 `.env.local` 或系统环境 |

### 2.6 `safety`（安全总闸）

这五项是套件级「允许花钱 / 允许对外发」的总闸，**默认全 false**。

| 字段 | 默认 | 打开后会发生什么 | 打开前的硬前提 |
|---|---|---|---|
| `safety.autoSend` | `false` | 通道可以把消息真正发到平台（QQ / B站） | 通道自身开关、目标白名单、外部服务连通都已就绪 |
| `safety.autoComment` | `false` | B站自动评论 / 回复评论 | 外部模块已安装并登录 |
| `safety.backgroundModelTasks` | `false` | 后台提炼、日程规划、自主活动会调用模型 | 模型 provider 已配置 |
| `safety.healthCollection` | `false` | 健康数据采集 | 账号授权 + sidecar 在线 |
| `safety.billingApis` | `false` | 生图 / TTS / 向量等计费 API | 对应服务已配置且用户同意付费 |

> 打开任何一项都是**用户的决定**。DSH 不得为了「让它看起来能工作」而代开。

### 2.7 `persona`（人格 id，可选）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `persona.id` | string | `"bot"` | 人格标识。解析顺序：环境变量 `DSH_COMPANION_PERSONA_ID` → `persona.id` → `bot`。改了它，历史数据需要迁移（`docs/04` §7 的人格 id 映射）。 |

### 2.8 数据目录与人格文件解析顺序

见 `docs/01` §4（同一份规则，不在这里重复实现）。

### 2.9 环境变量覆盖

环境变量优先于任何配置文件，用于 CI 与一次性运行：

| 变量 | 覆盖的字段 |
|---|---|
| `DSH_COMPANION_DATA_DIR` | `dataDir` |
| `DSH_COMPANION_PROFILE` | `dsh.profile` |
| `DSH_COMPANION_HOST_EXE` | `dsh.executable` |
| `DSH_COMPANION_MODULE_ROOT` | `dsh.moduleRoot` |
| `DSH_COMPANION_PERSONA_ID` | `persona.id` |
| `DSH_COMPANION_MODULE` | `modules.core`（`0` = 关，其它 = 开） |

---

## 3. 模块配置索引

每个模块的配置**文件、权威字段、默认状态**。字段细节以模块自己的 `CONTRACT.md` / `README.md` 为准。

### 3.1 `companion-memory`（长期记忆）

- 文件：`<dataDir>/home/companion/memory.config.json`（可选；缺失即用默认值）
- 密钥文件（**唯一**）：`<dataDir>/home/companion/remote-models.json` → `embedding.apiKey` / `rerank.apiKey`
- 默认值来自 `plugins/companion-memory/config.mjs` 的 `DEFAULT_CONFIG`

| 段 | 关键字段 | 默认 | 说明 |
|---|---|---|---|
| 顶层 | `backend` | `"legacy"` | `legacy`（旧 JSON/快照路径）/ `sqlite`（本引擎）。**要用长期记忆必须设 `sqlite`** |
| | `database` | `home/memory/companion-memory.db` | 相对数据根 |
| `injection` | `budgetChars` / `includeIdentity` / `includeWikiSummary` | `2400` / `true` / `true` | 每轮注入预算与内容 |
| `retrieval` | `candidates` / `topK` / `rrfK` / `mmrLambda` / `semanticEnabled` / `coverageFloor` | `32` / `8` / `60` / `0.72` / `true` / `0.15` | 混合召回参数。`coverageFloor` 是字面通道的覆盖闸门：太低会注入无关旧记忆，太高会检不到长问题 |
| `extraction` | `enabled` | **`false`** | 后台事实提炼。**关着就不发任何模型请求**。要开需同时配 `provider` / `model` |
| | `minMessages` / `maxMessages` / `maxOutputTokens` / `maxInputChars` / `reasoningEffort` / `timeoutMs` | `6` / `40` / `2000` / `12000` / `low` / `120000` | 提炼作业边界 |
| `embedding` | `provider` / `model` / `dimensions` / `baseUrl` / `apiKeyEnv` / `timeoutMs` | `local` / `hash-bigram-256` / `256` / `""` / `""` / `4000` | **默认是字面特征哈希，不是神经语义向量**。要语义检索必须自己配 `remote` + `baseUrl` + 密钥 |
| `rerank` | `enabled` / `provider` / `baseUrl` / `model` / `apiKeyEnv` / `timeoutMs` / `topN` / `blend` | `false` / `remote` / `""` / `""` / `""` / `4000` / `0` / `0.7` | 默认关；关着不产生任何网络请求 |
| `wiki` | `enabled` / `dir` / `autoCompile` / `minIntervalMs` / `maxEntriesPerTopic` / `maxPageBytes` | `true` / `home/memory/wiki` / `true` / `600000` / `40` / `32768` | 主题页编译 |
| `limits` | `captureMessageChars` / `factValueChars` | `16000` / `2000` | 单条上限 |

### 3.2 `companion-runtime`（认知运行时 / 日程 / 心跳 / 自主生活）

- 文件：`<dataDir>/home/companion/runtime.config.json`
- 数据库：`<dataDir>/home/companion/companion-runtime.db`

| 段 | 关键字段 | 默认 | 说明 |
|---|---|---|---|
| 顶层 | `enabled` / `mode` | `true` / `"active"` | 总开关；`mode` 可为 `shadow`（只记录不执行） |
| | `timeZone` | `"Asia/Shanghai"` | 日程与提醒的时间基准。**必须显式设置**，不要依赖机器时区 |
| `injection` | `budgetChars` | `320` | 每轮注入认知状态的预算（承诺整条出现或整条省略） |
| `bridge` | `enabled` / `callTimeoutMs` | `true` / `30000` | 与记忆库的桥接 |
| `agenda` | `enabled` | `true` | 日程（H1） |
| `heartbeat` | `enabled` / `pollIntervalMs` / `maxDispatchPerCycle` | `true` / `60000` / `1` | 零模型规则心跳（H2）：心跳本身不调模型 |
| `p2.planning` | `enabled` / `maxSlots` / `targetActivities` | `true` / `12` / `4` | 自主生活计划（**需 `safety.backgroundModelTasks`**） |
| `p2.activities` | `enabled` / `dispatchEnabled` / `artifactRoot` / `readRoots` / `readFullSource` | `true` / `false` / `home/companion/works` / `[…]` / `true` | 活动执行与可读根目录。`readRoots` 是**白名单**，别随意放大 |
| `p2.budget` | `maxRequestsPerDay` / `maxInputTokensPerDay` / `maxOutputTokensPerDay` / `recoveryReserveRatio` / `maxConcurrent` / `chatPriority` | `64` / `160000` / `24000` / `0.2` / `2` / `true` | 每日预算。`chatPriority` 保证对话优先 |
| `p2.autonomy` | `allowedSources` / `searchProvider` / `maxExplorePerDay` / `maxWritesPerDay` / `maxSearchesPerDay` / `seedUrls` / `topics` | `["*"]`⚠️ / `dsh` / `6` / `4` / `6` / `[]` / `[]` | 联网探索。**发布版默认 `[]`（不允许任何来源）**；`["*"]` 只在用户显式确认后才可写，且它是字面判断、不解析 DNS |
| `p2.share` | `enabled` / `maxPending` | `true` / `5` | 分享候选（仍需 `safety.autoSend` 才可能真的发出去） |

### 3.3 `companion-foundation`（人格 / 身份 / 工具面）

- 没有自己的配置 JSON：读 `config/persona.md`（解析顺序见 `docs/01` §4.3）
- 身份绑定：`<dataDir>/home/companion/identity.json`（`identity.resolve()` 原子写入；换主 fail-closed）
- 路径解析唯一实现：`plugins/companion-foundation/suite-paths.mjs`
- 相关环境变量：`DSH_COMPANION_PERSONA_ID`、`DSH_COMPANION_DATA_DIR`、`DSH_COMPANION_MODULE_ROOT`

### 3.4 `companion-memory-studio`（陪伴空间 Web UI）

- 没有独立配置文件；它是**界面**，读写的是 memory / runtime / media / health 的配置文件与数据库
- 管理 API 只在 owner 会话可用；密钥字段**只报「已保存 / 未设置」，不回传明文**
- 构建：`npm run build:client`（`--check` 只校验产物是否最新）

### 3.5 `dsh-channel-qq`（QQ 通道）

- 配置位置：**`config/profile/<profile>.patch.yml`**（由 `npm run setup` 从入库模板
  `config/profile/<profile>.patch.template.yml` 生成本地版本，已 gitignore）的 `- id: channel-qq` 段
  （不是独立 JSON，这是插件契约决定的）
- 权威字段（按用途分组，全部默认关闭或受闸）：

| 组 | 关键字段 | 安全默认 | 说明 |
|---|---|---|---|
| 连接 | `connection.mode` / `connection.url` / `accessToken` / `selfId` | 空 / `""` / `0` | **`url` 为空则完全不连、不重试** |
| 访问闸 | `access.mode=allowlist` / `allowUsers` / `groupPolicy` / `allowGroups` | 白名单 + 空 | 只有列出的私聊/群会被处理 |
| 群 | `groupEnabled` / `requireMention` / `talkValue` | `false` / `true` / `0` | 默认「只回 @」 |
| 权限 | `permissionPreset` | `workspace-write` | 无人值守通道建议保持**可审批**的预设，不要无脑 `danger-full-access` |
| 主动消息 | `contact.enabled` / `dryRun` / `allowExternalSend` / `sendMode` | `false` / `true` / `false` / `turn` | **两道闸默认都关**；`confirmed` 只表示平台接受，不代表已读 |
| 提醒 | `reminders.enabled` / `dryRun` | `false` / `true` | 真发需要两项都显式打开 |
| 插件自带记忆/知识库/People | `memory.v2` / `kb.enabled` / `people.enabled` | `false` | 人格与记忆由 `companion-*` 提供，插件只做通道 |
| 附属功能 | `tts` / `meme` / `quotes` / `rss` / `learn` / `skills` / `chatlog` / `stt` / `poke` | 全 `false` | 不用的就别开 |
| 表情包 | `emoji.steal` / `emoji.stealPrivate` | `false` | 偷图会落盘到 `<dataDir>/home/channel-qq/emoji` |
| 识图 | `imageRecognition.enabled` / `maxPerMessage` | `false` / `2` | 关着时入站图片只留 `[图片]` 占位 |
| 调试 | `debug` | `false` | — |

### 3.6 `companion-health` + sidecars

- 文件：`<dataDir>/home/health/config.json`（首次加载**原子写**默认值；之后**永不静默重写**）
- 数据库：`<dataDir>/home/health/health.db`（SQLite WAL；只存派生统计，不存原始心搏曲线）

| 段 | 关键字段 | 默认 | 说明 |
|---|---|---|---|
| 顶层 | `enabled` / `source` / `provider` / `timezone` | `false` / `huawei-cn` / `huawei_cn_cloud` / `Asia/Shanghai` | 总开关默认关 |
| `collector` | `mode=local_http` / `baseUrl` / `pollMinutes` / `singleFlight` / `windowDays` / `backfillDays` / `requestTimeoutMs` | `…` / `http://127.0.0.1:8765` / `15` / `true` / `7` / `30` / `20000` | `baseUrl` **必须是回环地址**（校验强制） |
| `capabilities` | `readOnDemand` / `injectHealthContext` / `rememberHabits` / `adjustSchedule` / `proactiveCare` | `true` / 其余全 `false` | 后四项本轮**只能 false**（代码里没有读取分支） |
| `sleep` | `schemaEnabled` / `displayEmptyState` / `waitForFirstRealNight` / `altSourcesEnabled` / `trendMinVerifiedNights` / `proactiveRulesEnabled` | `true` / `true` / `true` / `false` / `3` / `false` | 睡眠预留：等第一夜真实数据 |
| `pulse` | `enabled` / `baseUrl` / `pollMs` / `deviceOffMs` / `inject` / `maxChars` | `false` / `http://127.0.0.1:8151` / `1000` / `30000` / `true` / `200` | 实时心跳。**会话跟随设备**：关掉手环「心率广播」约 30 秒后会话自己收口 |
| `privacy` | `ownerOnly` / `exposeToGroup` / `exposeToBili` / `redactTokens` | `true` / `false` / `false` / `true` | 校验强制 |

> **两套开关的权威关系**：运行时权威是 `health_consents` 表，`config.capabilities` 只是**首次种子**。
> 改 config **不会**覆盖用户已做出的授权选择——这是「用户关掉授权 → 重启 → 不能被重新打开」的防线。

- Sidecar 运行参数（不是 JSON，是命令行/环境）：

| sidecar | 端口 | 关键参数 | 依赖 |
|---|---|---|---|
| `sidecars/huawei-health-cn` | `127.0.0.1:8765` | 只监听回环；只读 HTTP；`--` 起停脚本分 `.ps1` 与 `.sh` 两套 | Python 3.9+（契约测试只用标准库）**+ 使用者自备上游检出**（见下） |
| `sidecars/ble-heart-rate` | `127.0.0.1:8151` | `--port` / `--fixture`（无硬件回放）/ `--auto`（启动即扫描）/ `--scan-timeout` / `--address` / `--connect-timeout` | `bleak`（`requirements.txt`）；**`--fixture` 不需要 bleak** |

> BLE sidecar 默认是**懒**的：进程起来只监听 HTTP，不扫描、不自动连接；只有
> `POST /api/connect`（或上层 `companion_pulse action=start`）才会扫。这是有意的省电与隐私设计。

#### 3.6.1 health 相关的环境变量

| 变量 | 谁读 | 作用 | 不设时 |
|---|---|---|---|
| `HUAWEI_UPSTREAM_PKG` | `sidecars/huawei-health-cn` 的自检脚本 | 指向**使用者自己的**上游 `huawei_health` 检出。上游协议实现（`client.py` 等 4 个复制件）**因许可未核实已从仓库移除**，不随本仓库分发 | 报「原件不在」并以退出码 3 结束——表示「没有可对照的原件」，**不是**坏了 |
| `DSH_COMPANION_HEALTH_HOME` | `plugins/companion-health/lib/service.mjs` | 覆盖 health 的 home 目录（优先级：显式 `home` 参数 > 该变量 > `<dataRoot>/home`） | 用套件解析出的 home |
| `DSH_COMPANION_HEALTH_SIDECAR_URL` | 同上 | 覆盖 `collector.baseUrl`（华为健康 sidecar 地址） | 用 `config.json` 里的值，默认 `http://127.0.0.1:8765` |
| `DSH_COMPANION_PULSE_SIDECAR_URL` | 同上 | 覆盖 `pulse.baseUrl`（BLE 心率 sidecar 地址） | 用 `config.json` 里的值，默认 `http://127.0.0.1:8151` |

> 两个 sidecar URL 的覆盖仍然是**回环校验**：指到非回环地址会被拒绝并回落，不会静默生效。

### 3.7 `dsh-bili-scroll`（B站）——**外部模块，不在本仓库**

| 项 | 内容 |
|---|---|
| 来源 | `https://github.com/c1overzz/dsh-bili-scroll` |
| 版本 | 固定 `2.4.0`（tarball `dsh-bili-scroll-2.4.0.tgz`），**不跟随 latest** |
| 安装 | 用户显式操作：`dsh plugin --profile <profile> add <tarball URL>` |
| 配置位置 | 该模块自己的家目录（如 `duty.md`、`config.json`、`headless-overlay.yml`），**不归本套件管** |
| Python 依赖 | 它自带的转写/ASR 环境（生产用模块家目录下的 `.venv`），**本套件不代管**该虚拟环境 |
| 默认状态 | 关闭（`modules.bilibili=false`）；「自动评论 / 自动投递」必须**单独**打开，且受 `safety.autoComment` 总闸 |
| 许可证 | 需用户自行核实；本仓库不为它的许可与行为背书 |
| 凭据 | `bili_credential.json` 属**永不导出**的凭据（迁移后重新扫码） |

### 3.8 其他可选模块

| 模块 | 配置位置 | 说明 |
|---|---|---|
| `dsh-paste-search` | profile patch 里的插件行 + 自己家目录 | 贴图搜索入口；无外部依赖 |
| `qq-idle-compaction` | profile patch + `modules.qqIdleCompaction` | 会话空闲压缩；**会调用模型**，默认关 |
| ~~`dsh-super-injector`~~ | — | **本版未收录**（许可证文本缺失 + 无法验证）。需要的人自行从上游获取，见 `docs/03` §1.2 |
| ~~`_selftest-hello`~~ | — | 注入器的冒烟夹具，随注入器一起移出 |

---

## 4. 配置的生命周期与热重载

| 模块 | 生效方式 |
|---|---|
| `companion-media` | **按文件 mtime 热重载**：保存后下一次调用即生效（真正的 kill switch） |
| `companion-health` | 首次加载写默认值；此后尊重文件；运行期通过门面 API 读 |
| `companion-memory` / `companion-runtime` | 启动时读；改完**重启**才生效 |
| `dsh-channel-qq` / 群聊 / 健康插件的**代码** | 改 `cordis.patch.yml` 只重挂载，**不换代码**；改代码需重启宿主 |
| 套件级 `config/suite.json` | `setup` / `doctor` / `start` 每次读；`start` 之后改需要重启 |

---

## 5. 密钥处理规则（硬性）

1. **模板留空**：`config/*.example.*` 里的密钥字段一律 `""` 或 `"<your-key>"`，并注明「不要把真值写在这里」。
2. **真值只落三类位置**：`.env.local`（已 gitignore）、系统环境变量、模块自己的本地密钥文件
   （如 `home/companion/remote-models.json`、通道的 `accessToken`）。
3. **永不入库**：`.env*`（除 `.env.example`）、`config/suite.json`、`config/persona.md`、`data/**`、
   `*.pem` / `*.key`、`.credentials.yaml` 全部在 `.gitignore` 里。
4. **不回传明文**：任何 API / UI / 日志 / 诊断输出只报「已保存 / 未设置」，
   **不得**返回、打印、截断展示密钥内容；错误信息也必须脱敏。
5. **不进迁移包**：`npm run migrate` 硬拒绝 `credentials` / `auth` / `sessions` / `bili-credentials`
   等域（`docs/04` §4）。
6. **不写进文档**：本文与 `docs/**` 里不出现任何真实密钥、QQ 号、账号、绝对路径。

> 自查：`npm run verify --only=static` 会扫描源码与配置模板里的密钥形态与作者绝对路径。

---

## 6. 状态口径（不许含糊）

任何界面、报告、文档在描述一个外部能力时，只能使用这五档，且**不得升级表述**：

| 档 | 含义 | 允许的说法 | 禁止的说法 |
|---|---|---|---|
| 未配置 | 缺地址 / 缺密钥 / 模块未启用 | 「未配置」 | 「连接失败」 |
| 已保存未测试 | 配置已写入，未发起任何请求 | 「已保存，未测试」 | 「已连接」「已生效」 |
| 测试成功 | 发起了**一次**用户可感知的真实请求并成功 | 「测试成功（<时间>）」 | 「一直可用」 |
| 测试失败 | 请求发出但失败 | 「测试失败：<错误摘要>」 | 「网络问题」这种模糊归因 |
| 功能关闭 | 开关是 false | 「功能关闭」 | 「已完成」「已就绪」 |

「配置已保存」和「连接成功」是**两件事**。凭据存在也不等于登录成功。

---

## 7. 常见配置陷阱

1. **两份真相**：同一项配置既写 `cordis.patch.yml` 又写模块 `*.config.json` → 以模块文件为准，
   patch 里那份会被忽略，容易误判。
2. **`backend: legacy`**：记忆配置留默认值时长期记忆走旧路径（无 SQLite 检索）。要新引擎必须设 `sqlite`。
3. **`semanticEnabled: true` 但没有远端 embedding**：字面通道仍然工作，但**没有语义召回**；
   别把「开了开关」当成「有向量」。
4. **`allowedSources: ["*"]`**：等于允许访问任意公网地址，且守卫是字面判断、不解析 DNS。
   发布默认是 `[]`；放开属于用户显式决定。
5. **时区**：`runtime.config.json` 的 `timeZone` 与系统时区不一致时，提醒与日程按配置走。
6. **权限预设**：`danger-full-access` 的 `approval` 是 `never`，无人值守通道用它等于放弃审批环节。
7. **健康授权**：改 `config.json` 里的 `capabilities` 不会覆盖 `health_consents`；要去界面重新授权。
