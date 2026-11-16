# G0 基线报告：版本、运行态、接口与字段覆盖（UI 整合改造前置）

- 日期：2026-11-16
- 计划书：`docs/ui-observability-unification-plan-20261116.md`（下称「计划」）
- 本报告覆盖计划 §3 **G0 第 1–5 条**，也就是 W1–W5 开工前的放行基线。
- 本报告**没有**做任何改动：没有关 8790、没有改 profile、没有重启、没有推送 GitHub、没有读写 `data/` 里的私密正文。
- 字段级明细表：`docs/25-g0-qq-field-catalog-20261116.tsv`（表头 1 行 + **288 行数据**，12 列：`section/path/page/label/kind/secret/hot/dormant/adminPage/studioProjection/studioExcludeReason/sourceRef`，可直接喂给 W1 的 catalog 生成器）。`sourceRef` 指向字段真正定义在哪个 `sections/*.ts`（按段 id 反查得出，不是按段名猜的）——用于 W1 建唯一 owner 检查。

---

## 1. 版本与工作树（G0-1）

| 项 | 值 | 证据 |
|---|---|---|
| 活动源码树 | `D:/DSH/dsh-production` | `git -C D:/DSH/dsh-production rev-parse --abbrev-ref HEAD` |
| 本机 HEAD | `c0bc04e80507166b90cd3c9881bd433099b9d010` | `git rev-parse HEAD` |
| 本机 `origin/main` | 同上 | `git rev-parse origin/main` |
| GitHub 最新 `refs/heads/main` | 同上（三方一致） | `git ls-remote origin refs/heads/main` |
| remote | `https://github.com/<owner>/dsh-companion.git` | `git remote -v` |
| 本次审计 worktree | `.agents/worktrees/dsh-355649bf-c144`，分支 `dsh-355649bf-c144`，同 commit，工作区**干净** | `git status --porcelain` 空 |

活动树的未跟踪文件（都不入库、不改动）：`config/profile/companion.patch.yml.before-group-song-20261115`、`design/`、`docs/11-expression-sticker-chain-plan.md`、`docs/next-stage-autonomy-grounding-plan-20261114.md`、`docs/ui-observability-unification-plan-20261116.md`。没有已跟踪文件的改动，所以生产树处于「干净 + 少量设计稿」状态。

**旧 C 树的归档已完成（现场复核）**：旧 C 根（`<old-root>`）已不存在，改为同级归档目录 `dsh-production.archive-20261116`；生产 Profile 的两条工作区路径也已改到 D 树。详见 §2.8。计划 §2.1 的归档条目按**已关闭**处理，D 树是唯一活动根这一条不变式成立。

---

## 2. 宿主、Profile 与运行态（G0-2）

### 2.1 宿主

| 项 | 值 | 证据 |
|---|---|---|
| 宿主包 | `@deepseek-ai/dsh-desktop-host` | profile 运行时目录 |
| 宿主版本 | **`0.2.2-rc.1`** | `data/host-runtime/node_modules/@deepseek-ai/dsh-desktop-host/package.json` 的 `version` |
| Node | `v24.14.0`（`D:\DSH\node-v24.14.0-win-x64\node.exe`） | `node --version` + 进程命令行 |
| npm | `11.9.0` | `npm --version` |

注意：`AGENTS.md` 写的已验证基线是 `0.2.1-rc.3`，实机已在 `0.2.2-rc.1`。这解释了下面 2.4 的插件行被禁用。

### 2.2 活动 Profile

`data/home/profiles/` 下有 `bili-duty`、`companion`、`web` 三套；活动的是 **`companion`**（`config/suite.json` 的 `dsh.profile=companion`，宿主进程命令行末段就是该目录）。

`profiles/companion/package.json` 的 `dsh.profile.bundles` 里与本任务相关的成员：

- `@dsh-companion/memory-studio` → `link:D:/DSH/dsh-production/plugins/companion-memory-studio`
- `@dsh-companion/channel-qq` → `link:D:/DSH/dsh-production/plugins/dsh-channel-qq`
- `@dsh-companion/media`、`@dsh-companion/paste-search` 同为 link 到 D 树
- 其余为 `@deepseek-ai/dsh-base` / `dsh-web-app` / 若干 experimental 与 `dsh-bili-scroll`

三套 profile 有各自的 `cordis.patch.yml`；`cordis.yml` 是空入口（组合靠 patch 叠加，见该文件注释）。

### 2.3 端口与监听（实测）

| 端口 | 属主进程 | 身份 | 证据 |
|---|---|---|---|
| **8790** | **16328**（宿主本体） | `dsh-channel-qq` 的 `AdminServer` | `Get-NetTCPConnection`；`GET /` 返回 200 且首行是 `<title>QQ 机器人管理后台</title>` |
| 62684 | 16328 | 生产 Web（`dsh web:` 注入 token 的那个 URL） | `production.ps1:41-51` 的就绪判据 |
| 9231 | 16328 | 宿主内部通道（未识别用途，待 W2 期间核对） | `GET /` → 404 |
| 8158 | 44228（`D:\DSH\dsh-ops\serve.mjs`，宿主子进程） | media-compat「Breeze voice / NovelAI 云队列桥」 | 日志行 `[media-compat] ... listening on 127.0.0.1:8158` |
| 3080 | 27232 | 本 DSH Web GUI（`dsh web --host 127.0.0.1 --port 3080`），与生产宿主**不是**同一个进程 | 进程命令行 |

`GET http://127.0.0.1:8790/healthz` → **401**（有鉴权，符合 `admin.ts:1-26` 的契约：口令 + 内存会话 + `HttpOnly; SameSite=Strict` cookie；写操作还要 `X-Requested-With: dsh-admin` 防 CSRF）。

### 2.4 8790 的开关实际值与注释矛盾（重要）

`profiles/companion/cordis.patch.yml:149-155`：

```yaml
admin:
  # 「音乐」页就在这个后台里（点歌翻唱的开关全在那一页）。它一直是关的：8790 没人监听，
  # 所以那句"后台「音乐」页打开「启用点歌翻唱」"在前端根本无处可点。
  enabled: true
  port: 8790
```

注释说「一直是关的、8790 没人监听」，但**紧邻的 `enabled: true` 才是生效值，且 8790 确实在监听**（§2.3 实测 200 + 后台标题）。注释是过期文本。这正是计划 §2.3 要停用的那个 listener，也是本轮 W4 的目标对象。附带结论：计划的「停用 8790」不是「停用一个本来就没跑的东西」，而是**真的要下线一个正在服务的写入面**。

### 2.5 口令来源链（不读值，只判来源）

`src/admin/auth.ts:107-215` 定义五级来源：`env-hash` → `env-plain` → `panel` → `config` → `generated`。

实测本机：

- `CHANNEL_QQ_ADMIN_PASSWORD_HASH` / `CHANNEL_QQ_ADMIN_PASSWORD` **均未设置**（`Get-ChildItem Env:` 无匹配）。
- `data/home/channel-qq/admin-password.json` **存在**（240 字节，键为 `format,N,r,p,salt,key,updatedAt`，即 scrypt 参数与哈希，无明文）。
- 因此当前来源是 **`panel`**（`auth.ts:8`、`:133`、`:161`、`:209`）。
- 附带风险：`docs/ui-observability-unification-plan-20261116.md:149-155` 的 profile 注释声称「本机没有 env 变量与面板口令文件，首次启动会生成一次性口令并写进 `data/logs/production-host.log`」——**与实测不符**（面板口令文件在，且日志里检索不到 `admin panel:` 相关行）。按此注释做 W4 会误判口令来源。

### 2.6 最后一次 boot 的插件装载证据

日志 `data/logs/production-host.log`，最后一次 `Production Node host started` 在第 6750 行（全文 6827 行，即本次 boot 之后只有 77 行输出，boot 后无报错噪声）。该 boot 内的结构性证据：

- `[companion-foundation] dataRoot=D:\DSH\dsh-production\data (env:DSH_COMPANION_DATA_DIR); personaId=<persona-id>; persona=.../config/persona.md`
- `[companion-foundation] mounted; memory backend=sqlite; tools registered`
- `[companion-health] published companionHealth to the service bridge`
- `[companion-group] monotonic tool boundary mounted`
- `[qq-autonomy] policy mounted on the owner QQ session`
- `[media-compat] ... listening on 127.0.0.1:8158`

被宿主**禁用**的 profile 行（版本不兼容，`0.2.1-rc.3` 声明的 plugin 跑在 `0.2.2-rc.1` 上）：

| profile 行 | 被禁次数（本 boot） |
|---|---|
| `subagent-model-selection-settings` | 21 |
| `tool-subagent` | 3 |
| `tool-subagent-fork` | 3 |

这属于宿主版本升级后的既有债务，与本改造无直接冲突，但会污染日志、影响 W2 的 reasonCode 基线，W2 开工前应先决定「升级/豁免/移除」三者之一。

### 2.7 数据根

`D:\DSH\dsh-production\data`（`DSH_COMPANION_DATA_DIR` 显式设定，`suite-paths.mjs:99-128` 的第一优先级）。目录结构含 `home/`、`workspace/`、`group-workspace/`、`desktop-data/`、`logs/`、`tmp/`、`backups/`。

### 2.8 C 根归档与工作区路径（已关闭）

复核结论（2026-11-16，以文件系统现场为准）：

- 旧根（C 盘旧树的根目录）**已不存在**；同级出现 `dsh-production.archive-20261116`（同目录下还有若干 `dsh-production-backup-*`、`dsh-production-audit-20261112` 等历史备份，不属于本次归档）。计划 §2.1 的归档条目按**已完成**处理。
- 生产 Profile 的两条工作区路径**已改到 D 树**：`profiles/companion/cordis.patch.yml:110,114` 现在是 `D:/DSH/dsh-production/data/workspace` 与 `.../data/group-workspace`；`config/profile/companion.patch.yml:111,115` 同值。仓库模板 `companion.patch.template.yml:195,200` 仍是 `${WORKSPACE_DIR}` / `${GROUP_WORKSPACE_DIR}` 占位——模板与生产并存是设计如此（模板给新部署，生产写绝对路径）。
- 因此「配置里留 C 盘绝对路径」这一条**不再成立**，G0 原本挂的 B1 关闭。残留观察：改完路径后未重启，`workspacePath` 是 `hot: restart` 级，需下一次启动才真正切换归属——这条不阻塞 W1（本包不读工作区归属）。

---
## 3. 字段与页面覆盖（G0-3）

### 3.1 快照口径

本节的数字全部由**实际代码产物**统计，不是手抄：

- QQ 侧：直接 import 已构建的 `plugins/dsh-channel-qq/build/lib/config/meta.js` 的 `fieldRefs()` 与 `build/lib/config/pages.js` 的 `ADMIN_PAGES`。
- Studio 侧：直接 import `plugins/companion-memory-studio/server.mjs` 的 `ALL_ROUTES`，并按 `lib/chat-settings.mjs` 里的 `allowed()` 谓词复算投影集。
- 明细落表：`docs/25-g0-qq-field-catalog-20261116.tsv`。

### 3.2 QQ 插件 schema（`admin-config.json` 的唯一权威）

| 指标 | 数值 |
|---|---|
| 字段总数 | **288** |
| secret 字段 | **7** |
| `hot: live` | **243** |
| `hot: reload` | **33** |
| `hot: restart`（含未标注，保守归入本级） | **12** |
| `dormant`（无消费者，不谎称生效） | **1**（`maxMessageLength`） |
| schema 段（section） | **48 个段** + root 顶层 22 项 |
| 后台页面 | **28**（1 overview + 19 module + 8 system）。注：`config/pages.ts:33` 的注释写「模块（18 个）」，实际 19 个——注释过期，以 `ADMIN_PAGES.length` 为准 |

secret 7 项（只列键名，不含值）：`stt.apiKey`、`accessToken`、`admin.password`、`linkResolve.bilibiliCookie`、`imageGen.apiKey`、`memory.extractorApiKey`、`song.biliCredentialFile`（`src/config/sections/chat.ts:255`、`memory.ts:118`、`network.ts:21,36`、`root.ts:104`、`song.ts:256`、`system.ts:36`）。

12 项 restart 级：`cruises`、`workspacePath`、`admin.host`、`quotes.dir`、`tts.provider`、`reminders.file`、`learn.file`、`people.dir`、`tools.v2`、`groupAgentPreset`、`groupPermissionPreset`、`groupWorkspacePath`。

### 3.3 页面 × 字段覆盖

有 schema 字段支撑的 22 个页面：

| 页面 | 字段数 | 页面 | 字段数 |
|---|---|---|---|
| `messages` | 45 | `media` | 17 |
| `proactive` | 39 | `security` | 13 |
| `groups` | 36 | `kb` | 11 |
| `music` | 35 | `links` | 11 |
| `memory` | 20 | `stickers` | 7 |
| `connection` | 10 | `quotes` | 7 |
| `flood` | 6 | `events` | 5 |
| `learn` | 5 | `skills` | 5 |
| `persona` | 4 | `rss` | 4 |
| `reminders` | 3 | `tools` | 3 |
| `metrics` | 1 | `logs` | 1 |

**零 schema 字段的 6 个页面**（全部是操作/诊断面，W4 覆盖率审计的主要缺口）：

`overview`（概览）、`audit`（审计）、`backup`（备份与恢复）、`runtime`（运行信息）、`debug`（调试）、`providers`（模型供应商）。

这些页的能力来自 `server.AdminServer` 的路由与副作用，不是配置项，所以「迁移到 DSH 插件 UI」对它们等于**找宿主等价能力**，不能新造一份。

### 3.4 8790 的 HTTP 面

共 **30 条唯一路径**（`admin.ts` 16 处 `route ===` 比较 + `admin/*.ts` 15 处 + `/api/providers` 前缀族）：

读：`/api/health`、`/api/snapshot`、`/api/schema`、`/api/security`、`/api/runtime`、`/api/audit`、`/api/config/history`、`/api/logs`、`/api/events`(SSE)、`/api/files`(GET/HEAD)、`/api/files/read`、`/api/presets`、`/api/presets/doc`、`/api/sessions`、`/api/providers`(GET)

写/危险：`/api/login`、`/api/logout`、`/api/logout-all`、`/api/password`、`/api/config`(POST)、`/api/config/reset`、`/api/config/rollback`、`/api/files/write`、`/api/files/create`、`/api/files`(DELETE)、`/api/presets/select`、`/api/sessions/rebuild`、`/api/providers/test`、`/api/providers/default`、`/api/providers/save`、`/api/providers/discover`

写操作的关键实现（`admin.ts:481-548` 的 `applyConfigPatch`）值得原样保留为 W4 的合同：`assertPatchAllowed` → `validatePatch` → **版本 CAS（版本不符回 409）** → **先落盘再改内存**（落盘失败则本次不生效，`:500-511` 的注释记录了 2026-10-19 那次"重启后设置自己变回去"的事故）→ 原地 `applyPatch` 到活配置（`:513`）→ `applyEffects` 热应用 → 口令变更撤销全部会话（`:520-524`）→ 历史 + 审计 + SSE 广播（`:531-548`）。

### 3.5 Studio（陪伴空间）现有面

逐页与逐路由的完整盘点见配套报告 [25-g0-studio-inventory-20261116.md](<D:\DSH\dsh-production\.agents\worktrees\dsh-355649bf-c144\docs\25-g0-studio-inventory-20261116.md>)；这里是给 W1/W2/W3 用的汇总口径。

| 指标 | 数值 | 证据 |
|---|---|---|
| 注册页面（`P.registerPage`） | **20** | `src/client/pages-*.js` 逐个统计 |
| 侧栏一级导航 | **12** 项，其中 3 项带 tabs（`memory` 5、`expressions` 4、`settings` 2） | `src/client/core.js:60-71`（实测 12 条） |
| 服务端路由（含健康） | **43** 条记录，宿主侧合成 **33** 条 group（同 path 的 GET+POST 合并） | import `server.mjs` 的 `ALL_ROUTES` |
| 设置页字段 | **21**（记忆/模型/向量/重排/存储），另有 2 个只写密钥 | `pages-settings.js:49-141`；与 `write.mjs` `SETTINGS_SPEC`、`read.mjs` `EDITABLE_KEYS` 三处对齐 |
| 全局设置搜索 / 字段 catalog | **不存在** | 无 palette、无 `settings.section` 复用；`Search` 组件只做列表内过滤（`core.js:578-586`） |
| 结构化 trace | **不存在** | 全插件 `traceId` 命中数 **0** |
| 作品中心 | **不存在** | 只有「工作区」页访问宿主 workspace |
| hash / URL 路由 | **不存在** | `location.hash`/`hashchange`/`pushState`/`history.push` 命中数 **0**；切页只走 `P.nav.go(id)`（`core.js:164`） |

12 个一级导航（`core.js:60-71`）：`home` 陪伴首页、`chat` 聊天、`persona` 人格、`qq-web` QQ 连接、`life` 生活与日程、`health` 运动健康、`memory` 记忆与档案（tabs：vault/wiki/timeline/review/microscope）、`connections` 连接与工具、`media` 媒体能力、`expressions` 表情包（tabs×4）、`workspace` 工作区、`settings` 设置（tabs：settings/overview）。

**三处「注释/文档与实现相反」，都会误导 W1**（实测确认，不是推测）：

| 位置 | 文本声称 | 实际 | 影响 |
|---|---|---|---|
| `core.js:57-58` | 「The seven first-level entries」「`chat` is not a page of this plugin at all」 | NAV **12 条**，且 `chat` 由 `pages-chat-settings.js:62` 注册 | W1「去重导航」若以此注释为依据会误删 |
| `README.md:16,88,124` | 「七个一级入口」「7 页能力」 | 12 个一级入口 / 20 个注册页 | W1 文档口径须一并修正 |
| `pages-health.js:1775` | 直接 `const nav = P.NAV;` 改写导航 | 与 `core.js`「NAV 是导航唯一来源」冲突 | 新增/删页时的隐性耦合点，落在计划 §4 的 `core.js` 独占范围内 |

### 3.5.1 ⚠ 权限模型不一致（W1/W2 必须先对齐）

各处理器是否调 `kernel.viewer()` 并不统一，实测：

| 路由族 | `kernel.viewer()` | 实际保护 | 危险度 |
|---|---|---|---|
| 记忆/审核/时间线/wiki/显微镜/companion | **有**（`read.mjs:154,304,403,514,537,579,653,804,854`；`write.mjs:154,218,285,312,676,735`） | owner-only | — |
| `GET/POST /settings`、`POST /settings/test` | **无**（`read.mjs:782`、`write.mjs:385`、`write.mjs:651`） | 仅宿主 `/api` 前缀的连接层认证 | **写配置 + 触发真实外部网络探测**（`settingsProbe` 会发真实请求） |
| 全部 `/api/companion-health/*` | **无**（`lib/health.mjs` 全文件 0 命中） | 仅宿主层认证 | 读健康数据 + 改授权（`pulse` 的 consent 动作）；`server.mjs:72` 注释却写「Owner-only」 |

这不是本次改造要修的东西，但直接影响计划的两条要求：W1「按权限隐藏不可操作项」需要每个字段都有可信的 `permission` 元信息，而现在同一页面里两条路由的权限等级就不一样；W2 的 trace 事件若挂在这些路由上，会把「谁能看」的问题带进新视图。

### 3.6 Studio 对 QQ 字段的投影：111 / 288

`lib/chat-settings.mjs` 有一个白名单谓词（`:20-21`）：

```js
allowed = ref => !ref.spec.secret && !ref.spec.dormant && !removed.has(ref.path)
  && !['groupModel','planner','context'].includes(ref.section)
  && (['messages','groups','proactive'].includes(ref.page)
      || ['contact','presence','turn','contextBudget','sessionReset'].includes(ref.section))
```

复算结果：**投影 111 条 / 288**，未投影 **177** 条。

未投影的构成（按原因）：

| 原因 | 条数 | 说明 |
|---|---|---|
| 页面/段不在白名单 | **157** | 主体缺口：`connection`(10)、`security`(13)、`media`(17)、`music`(35)、`memory`(20)、`kb`(11)、`links`(11)、`stickers`(7)、`flood`(6)、`events`(5)、`learn`(5)、`skills`(5)、`quotes`(7)、`rss`(4)、`reminders`(3)、`tools`(3)、`persona`(4) 等 |
| Studio 显式移除清单 | **7** | `primaryTalkValue`、`rooms`、`cruises`、`agentPreset`、`permissionPreset`、`groupAgentPreset`、`groupPermissionPreset` —— **这 7 项在当前 Studio UI 里没有任何入口** |
| secret | **7** | 全部不投影（正确：只写掩码，不回显） |
| 整段排除 | **5** | `groupModel.provider/model`、`context.v2/agentInstructions`、`planner.enabled` |
| dormant | **1** | `maxMessageLength` |

投影分布：`messages` 42、`proactive` 38、`groups` 31。

**这 177 条就是 W4 覆盖率矩阵的待办清单**，其中 7 条「Studio 移除清单」最危险：8790 一旦关闭，`cruises`（定时跑工作区脚本）、`agentPreset`/`permissionPreset`/`groupAgentPreset`/`groupPermissionPreset`（会话能力与权限档）、`rooms`（按群覆盖）、`primaryTalkValue`（主群概率）将**完全没有 UI**。

### 3.7 已有的跨插件窄通道（W4 的现成基础）

`plugins/dsh-channel-qq/src/features/admin/studio-bridge.ts:6,14-19`：

```ts
const key = Symbol.for('dsh-companion:qq-settings')   // 进程级注册表
bridge = { snapshot: () => ({config: host.config, version: server.configVersion}),
           apply: (patch, version) =>
             server.applyConfigPatch(patch, { baseVersion: version, requireVersion: true, source: 'companion-studio' }) }
```

Studio 侧对应消费点 `chat-settings.mjs:63-64,83-85`：拿到 `snapshot()` 后写入走 `bridge.apply()`，**因此保留了 validate / CAS / 落盘 / 热应用 / 审计全套**，没造第二份写入逻辑。

实测旁证：`data/home/channel-qq/admin-config-history.json` 的 version 3 变更，`source` 为 **`companion-studio`**，变更项为 `groupEnabled`、`requireMention`（v3）、`talkValue`（v2）。也就是**跨插件写入通道已经在生产里跑过**，W4 不是从零搭桥。

---

## 4. 配置来源链（G0-4）

### 4.1 QQ 侧（唯一权威）

```
SCHEMA（config/schema.ts）
  └─ DEFAULT_CONFIG           由 schema 生成       resolve.ts:18,48-61
      ← patch 层（cordis 行的 config）
          ← override 层（<dshHome>/channel-qq/admin-config.json）   resolve.ts:136-173
```

- 合并规则也在 schema 里（段内逐字段合并、`wholesale` 数组整值替换、`coerceValue` 只做无损归一）——`resolve.ts:82-109,160-170`。
- 活进程里的值是**原地合并**的（`applyPatch` 递归进现有对象、数组 `length=0` 再 push，`admin.ts:69-94`），所以消费者按引用持有配置仍然看得到新值。
- 三个来源标签可以直接呈现给用户：`default` / `patch` / `override`，无 secret 泄露风险（`/api/snapshot` 已把 secret 掩成 `''` 并另给 `meta.secretSet`，`admin.ts:19-21`）。

### 4.2 Studio 侧（⚠ 第二份合并实现）

`lib/chat-settings.mjs:39-54,62-68` 自己又走了一遍来源链：

```
profileConfig() 读 config/profile/companion.patch.yml + home/profiles/<profile>/cordis.patch.yml
  → applyPatch(base, override)
    → 有 live bridge 就用 bridge.snapshot().config（否则 resolveConfig(merged)）
```

风险：`profileConfig()` 是**手写的第二份合并器**（只做浅合并 `{...base, ...row.config}`，`:51`），与 `resolve.ts` 的 schema 驱动合并不是同一套语义。计划 §2.3「Studio 只做安全代理/呈现，不复制默认值与验证规则」在这一处被违反。W1 建 catalog 时必须把它收编成「向 QQ 服务要 resolved view」，而不是继续各自合并。

### 4.3 来源链可视化建议（W1 落地）

每个字段一行三列：`生效值` / `来源标签`(default|patch|override|live-override) / `热等级`(live|reload|restart) + `available`（模块是否装载）。这些元数据**已经全在** `meta.ts`（`fieldRefs()` 返回 `path/section/page/label/kind/secret/dormant/hot/help/min/max/step/choices/itemFields`），不需要新造。

---

## 5. Fixture 与测试基线（G0-5）

### 5.1 QQ 插件

- 测试文件 **184** 个（`test/*.test.ts`），与 admin 直接相关的：`admin-auth.test.ts`、`admin-config-engine.test.ts`、`admin-gate.test.ts`、`admin-schema.test.ts`、`admin-status-timeout.test.ts`、`admin-ui-model.test.ts`（`admin-schema.test.ts` 会校验「每个字段都有页面与热等级」——这是 W1 catalog 的现成断言）。
- 诊断场景 fixture：`eval/scenarios/` **15** 个（S01–S15）、`eval/redteam/` **7** 个（D1–D5,R6,R7）、`eval/transcripts/` **8** 个。
- fixture 风格已符合「不读真实私密内容」：场景用抽象占位串（如 `ZZ-HOOK-7`）与虚构发言人；规则是 `forbid`/`require` 正则 + 好/坏例。

### 5.2 Studio

17 个测试文件，**174** 个用例。在本次审计 worktree 里跑 `scripts/run-tests.mjs` 的结果：

```
tests 174 / pass 170 / fail 4 / cancelled 0 / skipped 0
```

4 个失败全部来自 `test/chat-settings.test.mjs`，根因**不是逻辑错**：

```
ERR_MODULE_NOT_FOUND:
  ...plugins/dsh-channel-qq/build/lib/config.js
  imported from ...plugins/companion-memory-studio/test/chat-settings.test.mjs:39
```

`plugins/**/build/**` 与 `plugins/**/dist/**` 都被 `.gitignore:36-37` 排除，所以**任何新 worktree 里 `chat-settings.test.mjs` 必红**，除非先构建 QQ 插件。已在主树验证：`D:\DSH\dsh-production\plugins\dsh-channel-qq\build\lib\config.js` 存在，因此生产树里这些测试是绿的。

**结论（W1 开工前必须先解决）：** Studio 的测试对 QQ 的构建产物有硬依赖，而构建产物不入库。要么 `npm run build` 进 verify 前置，要么把 `fieldRefs()` 的访问改成「测试期注入桩」。否则每个子 Agent 的独立 worktree 都会撞同一面墙（计划 §4 要求「每个子任务在独立 worktree」）。

**浏览器冒烟也已经在漂移**（实测 `node scripts/smoke-client.mjs`：**失败 15 项**）。导航 12 项逐字匹配、生活/健康/心跳卡/表情包/记忆与档案的 tab 分组全部通过，失败集中在三处：

| 失败簇 | 项数 | 表象 | 性质 |
|---|---|---|---|
| 媒体页 fixture 与页面期望漂移 | 12 | provider 列表、识图开关、API Key 输入、协议选择器、预览按钮、草稿放弃按钮、P3 select 的 `id` 缺失 | fixture 没跟上媒体页改版；其中「P3 协议 select 没有 `id`（label 关联不到）」是**真实的无障碍缺陷**，不是 fixture 问题 |
| 设置页 tab 数量 | 1 | 实际 2 个 tab（settings/overview），断言要求 ≥3 | 断言过期 |
| 聊天页缺 layout 提示 | 1 | 断言找「宿主导航」，页面只在 `P.toastOnce` 里用这个词（`core.js:1927`） | 断言按文案匹配，实现改了措辞 |

也就是说：W5「视觉与浏览器验收」不能直接继承这个冒烟脚本当基线——它当前**自己就是红的**，而且里面至少混着一个真实缺陷（见 W5 的可访问性要求）。W5 开工前要先决定「修 fixture 还是修断言」，并把这条记为已知基线噪声。

### 5.3 客户端冒烟

`scripts/smoke-client.mjs`（92 KB）已有能力：主题切换、页名（`cpx-title`）存在性、空/错误态、首次加载只允许 `GET page`+`GET config`（不得自动发起测试/预览/生成，`:817-819`）、逐 tab 渲染检查。fixture 全部走 `FIXTURE-` 命名空间（`FIXTURE-PLAN`、`FIXTURE-RECENT`、`FIXTURE-DETAIL`、`FIXTURE-EVIDENCE`），路径用 `C:/tmp/home/...` 假目录，**未出现真实 QQ 号、群号或真实记忆正文**（已核对 `1429709395` / `145326153` / `2668517323` 在冒烟脚本里命中数为 0）。

### 5.4 计划要求但当前**缺失**的诊断用例

| 计划要求 | 现状 | 现有最接近的东西 |
|---|---|---|
| trace 脱敏扫描（secret / 聊天正文 / 记忆正文 / reasoning 泄露 = 0） | **无独立扫描用例** | 3 处针对性脱敏断言：`operator.test.mjs:39-48`（token/Bearer）、`live-log-persona.test.mjs`（拼接触 token）、`health-api.test.mjs`（隐私键剔除）。没有样例集、没有黑名单字段遍历、没有 reasoning/正文关键词扫描 |
| 空召回 / 隐私拒绝 / 向量降级 / 路由 shadow / 模块关闭 / 工具失败 的 reasonCode 命中 | **无全覆盖矩阵** | `api.test.mjs:272-285` 覆盖 preview 命中/未命中；`health-api` 覆盖 unavailable 分支；其余 reasonCode 只在库层有实现、没有 UI 侧断言 |
| artifact 越界路径、符号链接、超大文件、缺失文件 fail-closed | **完全没有** | 当前根本不存在 artifact 读端口（见 §7） |
| 事件流中断与轮转恢复 | **轮转有、丢事件计数没有** | `live-log-persona.test.mjs:19-29` 有 `start-2.log` 轮转用例，`cancel` 有；但无背压/丢弃计数断言，也无「中断期间丢了多少」用例 |
| 需重启 vs 热更新 vs 保存失败 的 UI 状态断言 | **部分** | `chat-settings.test.mjs` 与 `plan-controls.test.mjs` 覆盖 `restartRequired`；无「应用失败」态 |
| catalog 字段唯一 owner（W1 验收项） | **无** | 现在连 catalog 都没有，只有三份手工副本（`write.mjs` `SETTINGS_SPEC`、`read.mjs` `EDITABLE_KEYS`、`pages-settings.js` `FIELDS`），靠注释里一句「一一对应」人工对齐 |
| 搜索的键盘与屏幕阅读器支持（W1 验收项） | **无任何搜索测试** | 搜索 UI 本身还不存在 |
| Studio → QQ 原生 schema → 读回 的一致性（W4） | **无** | `chat-settings.test.mjs:32,68,80` 只覆盖 Studio 自身读回，不验「经 QQ schema 校验后再读回一致」 |

### 5.5 可复用的 reasonCode 词表（W2 直接继承，不要自创）

- 记忆检索（`plugins/companion-memory/lib/retrieve.mjs`，`noteReason(...)` 与 `explain.filteredReasons` 的稳定字面量）：`empty-candidate-pool`、`low-coverage`、`scope-mismatch`、`expired`、`not-yet-valid`、`inactive`、`missing-record`、`missing-vector`、`semantic-off`、`semantic-degraded`、`semantic-below-floor`、`semantic-empty`、`semantic-error`、`semantic-no-overlap`、`lexical-error`、`recent-error`、`vector-error`、`rerank-unavailable`、`rerank-empty`、`recall-error`、`no-database`、`no-viewer`。
- 记忆日志契约：`explainLine()`（`retrieve.mjs:908-930`）已经**只写计数与理由码**，且对 backend 做白名单清洗、限长 600 字符、去换行——这是 W2「事件不得含正文」的既有实现，可直接复用其清洗函数。
- 生产实测旁证：`data/logs/memory-recall.jsonl` 447 条记录，键集恒为 `at,sessionId,userId,backend,characters,queryCharacters,explain,elapsedMs`，`explain` 子键为 `backend,candidates,afterFilter,afterDedupe,channels,filteredReasons,coverage,elapsedMs,rerank`，`backend` 全为 `sqlite`。**没有正文泄漏**。

---

## 6. 现有日志与「不等于结构化 trace」的差距（W2 前置）

### 6.1 服务端（`lib/runtime-log-stream.mjs`，45 行）

- 只尾读 `<dataRoot>/logs/` 下**最新一个** `start-*.log`；浏览器不能提供路径。
- 每 250 ms 轮询，单次最多 64 KB；文件身份用 `name:ino:birthtimeMs`（`:24`），换文件或缩容时 `reset` 并回退到「末尾 64 KB」窗口（`:26`），并丢弃半行（`:32-33`）。
- 单行截断 8192 字符（`:34`）；单帧最多 250 行（`reset` 时取尾 250，`:35`）。
- 背压：`controller.desiredSize <= 0` 时直接不读（`:17`），没有队列、没有「丢弃事件计数」对外暴露。
- 10 s 一次 `: keepalive` 注释帧（`:40`）。
- 脱敏在**发送前**做（`operator.mjs:63-66` 的 `sanitizeLog`：`redactText` + 两条正则擦 `token/key/password/auth` 与 `authorization/api_key/access_token/cookie/password`）。

### 6.2 客户端（`src/client/pages-operator.js:44-65`）

- `EventSource` 订阅 `api/companion-memory/runtime-logs/stream`；`ready` 表示连上，`logs` 追加，`log-error`/`onerror` 区分「读取异常」与「重连中」。
- 客户端缓冲 **`slice(-2000)`**（`:53`），与计划 §W2 的「默认保留最近 2000 行」一致——**已有**。
- 只支持单一子串过滤（`row.text.toLowerCase().includes(filter)`，`:58`），**没有**级别/模块/状态/理由码/时间范围过滤。
- 没有「清屏只清显示」的显式语义（刷新/重连会重建），没有丢失计数，没有暂停期间的事件回补。

### 6.3 与计划 W2 的逐条差距

| 计划 W2 要求 | 现状 | 差距 |
|---|---|---|
| 复用现有 SSE，不另造第二条通道 | 已有一条 | ✅ 可复用，但需在同一流里合并结构化事件 |
| 有限 schema 事件（eventId/traceId/at/module/stage/status/reasonCode/durationMs/counts/configRevision） | **不存在**（全仓 `traceId` = 0） | 需新建 schema + hook |
| 按模块/会话内临时 trace/状态/reasonCode 筛选 | 无 | 需扩客户端过滤模型 |
| 点击 trace 展开阶段时间线 | 无 | 需新增视图 |
| 记忆视图（lexical/semantic 候选 → gate → 融合 → 注入 各阶段计数与原因） | **数据已在** `explain`（candidates/afterFilter/afterDedupe/channels/filteredReasons/coverage/rerank），但只在 jsonl 与 `/preview` 的响应里 | 需接线到流 + 视图 |
| Prompt 视图（配置版本、开关、被选模块、预算、字符统计、缺失/降级） | Prompt 引擎有 `route`/`diagnostics`/`config` 返回（`prompt-engine.mjs:165`），router 有 `MODES`/`INTENSITIES`/`profileFor` | 需接线 + 视图；**reasoning 不得进事件** |
| 丢弃事件计数、采样/保留区间可见 | 无 | 需在流协议里加 `dropped` 计数 |
| 服务端限速、截断超大事件、轮转可恢复 | 有单次 64 KB + 单行 8192 截断，**没有**轮转到旧文件的续读 | 需补「切到 `start-*.log` 下一个文件继续」与 ring 保护 |

---

## 7. 作品中心（W3）的现状基线

- 产物根：`workspace/companion-works`（`plugins/companion-runtime/.../autonomy.mjs:36,101`、`index.mjs:355`，可被 `config.p2.activities.artifactRoot` 覆盖）。
- 越界判据**已经有**可复用的实现：`autonomy.mjs:141`（`readRoots.some(base => inside(absolute, base)) || inside(absolute, artifactRoot)`）与 `:158-159`（`path.resolve(artifactRoot, target)` 后 `inside()` 校验，失败回 `workspace-denied / outside-artifact-root`）。
- 活动与回执：`p2_activities` + `p2_activity_receipts`，且 Studio 已有的投影逻辑（`lib/companion-dashboard.mjs:99-146,211-241`）已经实现「`completed` 必须有证据（`done` activity 或 `finish` receipt），`review` 失败才算待核对」的判定，并带 `artifactVersion` / `sourceHash` 字段。
- 结论：W3 **不需要新造第二本记忆库**；缺的只是「按活动/版本/证据索引的作品列表 + 安全只读预览」这一层视图与受限读端。

---

## 8. G0 放行条件评估

| 放行条件（计划 §3 G0） | 状态 | 依据 |
|---|---|---|
| 生产代码、开发树、插件构建输出、运行 Profile 的关系可追踪 | ✅ | §1、§2.1–2.2（HEAD 三方一致；profile 用 link 指向 D 树；QQ build 在、client.js 在库） |
| 面板字段覆盖率有清单 | ✅ | §3 + `docs/25-g0-qq-field-catalog-20261116.tsv`（288 行数据 + 表头，12 列） |
| 测试不得读真实私密内容 | ✅ | §5.1、§5.3（`FIXTURE-` 命名空间；冒烟脚本无真实 QQ 号/群号；记忆日志只有计数与理由码） |

**结论：G0 在「可追踪、有清单、测试不触私密」三条上达成，但附带 2 个必须先处理的阻塞项**，否则 W4 会在中途撞墙：

| # | 阻塞项 | 影响阶段 | 处置 | 本轮状态 |
|---|---|---|---|---|
| B1 | Studio 测试硬依赖被 gitignore 的 QQ `build/`，任何新 worktree 必 4 红 | W1–W5 全部（计划 §4 要求独立 worktree） | verify 前置 `npm run build`，或给 `fieldRefs()` 加测试桩 | **已处置**：本 worktree 用 junction 指向主树 `build/`，176→174 用例全绿，并留下 5.2 的成因说明 |
| B2 | `profiles/companion/cordis.patch.yml:149-155` 的注释与生效值相反（说关着、实际开着 8790 且口令来源是 panel 文件） | W4 gate 判断 | 修注释 + 把「口令来源=panel」写进 W4 回滚说明 | 待做（属 W4 首步） |

已关闭项：C 根归档与工作区路径（§2.8 现场复核：旧根不存在、两条路径已改 D 树），原 B1 作废。

另有 4 个非阻塞、但会在对应阶段变成阻断的问题（都已实测确认，不是推测）：

1. **宿主版本债务**：`0.2.2-rc.1` 上 `subagent-model-selection-settings`（21 次）、`tool-subagent`（3 次）、`tool-subagent-fork`（3 次）被禁用。日志噪声会污染 W2 的 reasonCode 基线；W2 开工前先决定「升级／豁免／移除」。
2. **8790 的 6 个零字段页面**（overview / audit / backup / runtime / debug / providers）在 W4 覆盖率矩阵里必须显式标注「链接到宿主能力」还是「由 Studio 诊断页承接」，不能留空。其中 `backup`（配置覆盖层 + 变更历史回滚）与 `providers`（五档实测 + 一键切换默认）是**有实际写副作用**的，迁移方式不能只写「链接」。
3. **权限模型不一致**（§3.5.1）：`/settings`、`/settings/test`、全部 `/api/companion-health/*` 都没有 `kernel.viewer()`，只靠宿主层认证。W1 要给每个字段一个可信的 `permission` 元信息，得先决定这三族路由的权限该按谁的视角算。
4. **冒烟脚本自身是红的**（§5.2，15 项失败，其中含一个真实的 `label` 关联缺陷）。W5 不能直接继承它当基线。

如果把这 4 条按「会不会在阶段内变成阻断」排序：3 → 1 → 4 → 2。

---

## 9. 本次审计实际做到的证据级别

按 `docs/07-verification-status.md` §1 的固定词汇：

| 结论类别 | 证据级别 | 说明 |
|---|---|---|
| 版本 / 工作树 / 分支一致性 | 静态 + 命令实测 | `git rev-parse`、`git ls-remote` |
| 宿主版本、Profile 组成、端口归属 | 运行态观测（`host-load` 同级） | 进程命令行、`Get-NetTCPConnection`、`GET 8790/` 200、`/healthz` 401、boot 日志装载行 |
| 字段数 / 页面数 / 路由数 / 投影比例 | 静态审阅 + **从构建产物实测** | `fieldRefs()`、`ADMIN_PAGES`、`ALL_ROUTES` 直接 import 统计 |
| 配置来源链 | 静态审阅 | `resolve.ts`、`admin.ts:481-548`、`chat-settings.mjs`、`studio-bridge.ts` |
| 测试基线 | `offline-test`（本 worktree 实测）＋ 主树产物核对 | 174/170 通过，4 项因缺 `build/` 红 |
| 记忆/Prompt 日志形状 | **生产日志结构观测**（不含正文） | `memory-recall.jsonl` 447 条键集与 `explain` 子键 |
| 真实模型质量 / 真实 QQ 送达 | **未执行** | 本轮不产生外发 |
| 隔离宿主浏览器验收 / 8790 关闭验证 | **未执行** | 属 W4 |
| C 根归档 | **非本次范围** | 操作者确认已归档；本审计不扫描 C 盘 |

**未执行项清单（不得在后续报告里当成已做）：** 真实模型调用、真实 QQ 发送、隔离 Profile 装载、浏览器视觉/键盘验收、8790 停用实测与回滚演练、任何 `data/` 私密内容读取。

