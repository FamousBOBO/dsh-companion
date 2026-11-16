# G0-3 · 陪伴空间（companion-memory-studio）逐页现状盘点

- 日期：2026-11-16
- 工作树：`D:\DSH\dsh-production\.agents\worktrees\dsh-355649bf-c144`（git worktree，HEAD `c0bc04e80507166b90cd3c9881bd433099b9d010`，工作区干净）
- 计划书：`ui-observability-unification-plan-20261116.md`（G0 第 3 条 / W1 / W2 / W3）
- 范围：只盘点**现状**，不设计、不改代码。唯一写入的文件是本报告。
- 未读 `data/` 下任何私密内容（记忆正文、聊天历史、健康快照、媒体产物）；未打印任何口令/token/cookie 值。

结论摘要（数字口径见各节）：

| 项 | 值 | 口径 |
|---|---|---|
| 已注册页面 | **20**（12 个一级入口 + 8 个二级 tab 页） | `P.registerPage` 调用 20 处（src/client/pages-*.js） |
| 服务端路由 | **43** 条 `METHOD path` 记录 / **33** 条唯一 path | `ROUTES`(33) + `HEALTH_ROUTES`(10) = `ALL_ROUTES`(43) |
| QQ 配置字段（schema 全量） | **288** | `src/config/sections/*.ts` + `sections/root.ts` 顶层字段 |
| 其中投影进 Studio chat-settings | **111** | `lib/chat-settings.mjs:61` 的 `fieldRefs().filter(allowed)` |
| 未投影 | **177** | 288 − 111；分因见 §4.3 |
| 现有全局设置搜索 | **0** | `pages-settings.js` 内 `ui.Search` 命中数 = 0 |
| 结构化 trace 事件 | **0** | 全插件无 `traceId`/`eventId`/`trace` schema 落点 |

---

## 1. 工作台身份与壳

### 1.1 插件 id 与装配方式

| 项 | 值 | 源码位置 |
|---|---|---|
| 包名 | `@dsh-companion/memory-studio` | `plugins/companion-memory-studio/package.json:2` |
| 版本 | `0.1.0`（`localVersion: 1.1.0`） | `package.json:3-4` |
| Host 入口 | `./index.js` | `package.json:2,11` |
| Client 产物导出 | `"./client": "./client.js"` | `package.json:15` |
| Bundle 补丁 | `"dsh.bundle.patch": "./cordis.patch.yml"` | `package.json:42-45` |
| Client 平台与早期注入 | `platform: web`、`immediately: true`、`inject: [ui-sidebar, ui-layout]` | `package.json:46-52` |
| Cordis 行 | 只 `insert` 一行 `id: companion-memory-studio`，**不带 config**（避免两份真相） | `cordis.patch.yml:8-10`（注释 `:6-7`） |
| 插件名常量 | `export const name = 'companion-memory-studio'` | `index.js:21` |
| 激活入口 | `export async function apply(ctx)` | `index.js:114` |
| 单例引擎复用 | 已注册则只重挂 API，不再开第二个 SQLite 写者 | `index.js:119-137` |
| 服务暴露 | `ctx.provide('companionMemory', service)` | `index.js:125-126,146-148` |
| 引擎生命周期 | 仅创建者关闭（`ctx.effect` 清理） | `index.js:149-153` |
| API 挂载 | `mountApi()` → `registerStudioApi()`；先 `direct`，失败且 `no-connection` 时 `ctx.inject(['connection'])` 重试 | `index.js:85-112`（`104-110` 为 inject） |
| 注册诊断 | 写 `logs/memory-studio.jsonl`（`api-registered` / `api-failed` / `mounted`） | `index.js:29-36,89,99,129-137,156-164` |

服务端根：`STUDIO_ROOT = resolveSuitePaths({moduleUrl}).dataRoot`（`server.mjs:26`，即 companion **数据**根，不是源码根），两个 API 前缀 `API_PREFIX=/api/companion-memory`（`server.mjs:28`）、`HEALTH_API_PREFIX=/api/companion-health`（`server.mjs:30`，值来自 `lib/health.mjs:20`）。

### 1.2 侧栏注册点 / 槽位

| 槽位 | 注册内容 | 源码位置 |
|---|---|---|
| `sidebar.panellist` | `id: 'companion-memory'`（= `PANEL_ID`）、`order: 20`、`label()` 走 locale、图标 `PanelIcon` | `core.js:2370-2376`；`PANEL_ID` 在 `core.js:30` |
| `main` | `key: PANEL_ID`，组件 `Shell` | `core.js:2378-2383` |
| `conversation.input.dock` | `id: 'companion-strip'`、`order: 40`、组件 `ChatCompanionStrip`（只读摘要，不发消息） | `core.js:2388-2393`；组件 `core.js:2216-2251` |
| 宿主服务（可选） | `theme / layout / uiWorkspace / sessions / workspaces`；缺则 250ms×24 次轮询补齐后停止 | `core.js:2314-2339`（`SERVICE_KEYS` 在 `2314`） |
| locale | `ctx.locale.register(NS, DICTIONARIES)` + `ctx.locale.bind(NS)` | `core.js:2257-2273,2309-2310` |
| 面板显示名 | `locale/zh.json` → `meta.title: 陪伴小屋` | `locale/zh.json:1-6` |

侧栏「聊天」不是本插件页面：点击走 `P.nav.openPanel('conversation')` 回宿主原生会话（`core.js:1923-1932`；README 同口径 `README.md:21`）。

### 1.3 client.js 拼装：产物与源文件映射、顺序

`client.js` 是**提交物**，由 `scripts/build-client.mjs` 拼装，禁手改（`build-client.mjs:1-6,111-114`）。

- 外壳：`window.__ModuleLoader__.load({ id: '@dsh-companion/memory-studio', factory(require){ const React = require('react'); ... return { inject: ['slots','locale'], apply }; } })`（`build-client.mjs:111-124`）。运行时**只依赖模块表里的 react**，不引入 CDN/UMD。
- 片段顺序固定（18 个，`core.js` 必填）：core → operator → keyword-map → chat-settings → home → life → health → vault → wiki → timeline → review → microscope → connections → media → expression → workspace → settings → overview（`build-client.mjs:32-51`）。
- 每个片段是纯脚本 IIFE `(function(P){...})(P)`；拼装器只做提示性检查（import/export、`require`、疑似 JSX），语法判定交给 `node --check`（`build-client.mjs:93-105,127-142`）。
- 写盘原子化（临时文件 + rename），写完再对 `client.js` 跑一次 `node --check`（`build-client.mjs:144-152,237-245`）。
- 产物内的片段标记实到 18 段：`client.js:10`(core) `2427`(operator) `2526`(keyword-map) `2580`(chat-settings) `2645`(home) `3415`(life) `4104`(health) `5891`(vault) `6844`(wiki) `7228`(timeline) `7670`(review) `8620`(microscope) `8927`(connections) `9424`(media) `10764`(expression) `12132`(workspace) `12947`(settings) `14255`(overview)。

**构建产物核对（本节证据）**：用当前 `src/client/*.js` 按同一顺序重新拼装，得到的正文与仓库里 `client.js` 完全一致（`contains_body = true`；产物 664,772 字符 vs 拼装正文 664,396 字符，差额是外壳头尾；`client.js` 文件本身 720.7 KiB）。即：**工作树里的 client.js 与当前源文件同步**，不是陈旧产物。

### 1.4 主题 token 与导航壳位置

- 主题层：14 个 alias token 覆盖（`--dsw-alias-bg-base / bg-layer-1 / bg-layer-2 / bg-overlay / border-l1 / border-l2 / brand-primary / label-primary / label-secondary / state-error-primary / state-idle-primary / state-success-primary / state-warn-primary / dsw-specific-sidebar-fill`），亮/暗各一值（`core.js:2279-2294`）。
- 生效方式：`P.services.theme.overrideTokens(NS, THEME_TOKENS)` 走 `ctx.effect`，卸载即恢复原生配色（`core.js:2350-2352`）；`theme/change` 事件订阅同步快照（`core.js:2354-2359`）。
- 样式：所有片段用 `P.css()` 收集到 `P._styles`（`core.js:38-40`），`apply` 时插入一个 `<style data-plugin="companion-memory-studio">` 并在清理时移除（`core.js:2361-2368`）。
- 导航壳：`NAV` 常量 **12 个一级入口**（`core.js:59-72`：陪伴首页 / 聊天 / 人格 / QQ 连接 / 生活与日程 / 运动健康 / 记忆与档案(tabs) / 连接与工具 / 媒体能力 / 表情包(tabs) / 工作区 / 设置(tabs)）；`Rail` 组件把 12 项分成 4 组展示（陪伴 / 记录 / 工具 / 系统，`core.js:1916-1921`，渲染 `1906-1988`）；`Shell` 负责页状态、tab 记忆、抽屉、Toast（`core.js:2000-2156`）。
- **运行期级联副作用**：`pages-health.js` 在加载时直接改写 `P.NAV`——给 `life` 补 `tabs: ['life','health']`（`pages-health.js:1772-1782`）。也就是说「运动健康」在导航里既是独立一级入口（`core.js:65`），又同时是「生活与日程」的第二个 tab。**没有任何 hash/URL 路由**：当前页持久化在 `localStorage.cpx.page`（`core.js:169,2002`），分组内 tab 持久化在 `cpx.tab.<group>`（`core.js:1933-1937,2099-2102,2101`）。

---

## 2. 页面清单

> 说明：`hash/URL` 一列全部为「无（localStorage）」——全仓 `location.hash/hashchange/pushState/history` 命中数 = 0（对 `client.js` 与 `src/client/*.js` 的 grep 结果）。页面切换只走 `P.nav.go(id)`（`core.js:165-178`）。
> 权限一列：`owner` = 处理器内 `kernel.viewer()`（无绑定身份即 `denied`）；`host` = 该处理器**没有** viewer 校验，只依赖宿主 `/api` 前缀的连接层认证；`client` = 不发请求。

| 页面 id | 中文名 | 源文件 | hash/URL | 主数据来源(API 路径) | 读/写 | 权限(viewer 判定) | 依赖的宿主服务或兄弟插件 |
|---|---|---|---|---|---|---|---|
| `home` | 陪伴首页 | `pages-home.js:767`（order 0） | 无 | `GET companion`、`GET summary`、`GET reviews`、`GET timeline?limit=6`、`GET companion-health/today`、`GET companion-health/sleep?days=7`（`pages-home.js:673-678`） | 只读；副作用=跳页/开宿主动作（`nav.go`/`openPanel`，`pages-home.js:400-667,639`） | owner（6 条 handler 全有 viewer，见 §3） | companion-runtime（`companion` 读 runtime.config + 只读 SQLite）、companion-health 服务、记忆引擎 |
| `chat` | 聊天（聊天设置） | `pages-chat-settings.js:62`（order 11） | 无 | `GET/POST chat-settings`、`GET restart-status`（`pages-chat-settings.js:12,19,29`） | 读+写（POST 单入口） | owner（`chat-settings.mjs:57`） | **dsh-channel-qq 的 build 产物**（`chat-settings.mjs:58-60` 动态 import `build/lib/config.js|config/meta.js|admin.js`）+ 可选 qq-settings 热桥（`chat-settings.mjs:63`） |
| `persona` | 人格 | `pages-operator.js:93`（order 12） | 无 | `GET/POST persona`（`pages-operator.js:67,71`） | 读+写（写前备份、revision CAS） | owner（`persona-settings.mjs:10`） | suite 根 `config/persona.md`（`persona-settings.mjs:12-13`） |
| `qq-web` | QQ 连接（网页面板） | `pages-operator.js:96`（order 15） | 无 | `GET/POST web-panel`、`POST web-panel-control`（`pages-operator.js:77,80-81`） | 读+写+**进程副作用**（start/restart spawn 子进程） | owner（`operator.mjs:42,58`） | `web-panel-process.mjs`（本机可执行文件 + 端口探测）、`studio.webpanels.json`、iframe 嵌 NapCat/SnowLuma 面板 |
| `life` | 生活与日程 | `pages-life.js:686`（order 20） | 无 | `GET companion`、`POST plan-slot`（`pages-life.js:567,593`）；另读 `P.readPrivateHealthStatus`（`pages-life.js:555,648`） | 读+写（lock/unlock/skip，等运行库回执） | owner（`write.mjs:312`、`companion-dashboard.mjs:8`） | companion-runtime（`runtime.lockPlanSlot`/`skipPlanSlot`，`write.mjs:323-333`）、companion-health |
| `health` | 运动健康 / 健康与睡眠 | `pages-health.js:1784`（order 21，且被挂成 `life` 的 tab） | 无 | `GET health status/sources/today/trends/sleep/care`（`pages-health.js:188-193`）、`GET/POST health pulse`（`:918,974`）、`POST health sync`（`:1642`）、`GET/POST collector-terminals`（`:1548,1562`） | 读+写（consent/会话/同步/采集器启停） | **host**（`lib/health.mjs` 全部 handler 无 viewer 调用） | companion-health 服务（经 `resolveHealthService` 三层回落，`server.mjs:161`）、DSH 采集器持久终端控制器（`collector-terminals.mjs:15`） |
| `vault` | 记忆库 | `pages-vault.js:950`（order 20） | 无 | `GET memories`、`GET memory?reveal=1`、`POST memory`（`pages-vault.js:256,262,393`） | 读+写（revise/policy/archive/restore/delete） | owner（`read.mjs:304`、`write.mjs:154`） | 记忆引擎（`companionMemory` service，`index.js:146-148`） |
| `wiki` | Wiki 档案 | `pages-wiki.js:381`（order 40） | 无 | `GET wiki`、`GET wiki-page`、`POST wiki-page`、`POST maintenance{compile-wiki}`（`pages-wiki.js:76,86,131,158`） | 读+写（只写人工注释区） | owner（`read.mjs:514,537`、`write.mjs:218`） | 记忆引擎 + 磁盘 `wikiDir`（`write.mjs:233-254`） |
| `timeline` | 时间线 | `pages-timeline.js:439`（order 50） | 无 | `GET timeline?limit&kind`、`GET companion`（`pages-timeline.js:204,208`） | 只读 | owner（`read.mjs:804`） | 记忆引擎（events 表）、companion-runtime（domain_events） |
| `review` | 审核 | `pages-review.js:947`（order 60） | 无 | `GET reviews`、`GET memory`、`POST memory`、`POST review{requeue}`、`GET/POST corrections`（`pages-review.js:159-163,283,314,342,771,799`） | 读+写（判决/批改/重排/纠正裁决） | owner（`read.mjs:653,854`、`write.mjs:285,735`） | 记忆引擎 + companion-runtime（`resolveAmbiguousCorrection` / `correctionReview`） |
| `microscope` | 召回显微镜 | `pages-microscope.js:304`（order 30） | 无 | `GET preview?q&limit`（`pages-microscope.js:110-111`） | 只读（不写库） | owner（`read.mjs:579`） | 记忆引擎（`recall` + `render.renderContext`，`read.mjs:587-590,627`） |
| `connections` | 连接与工具 | `pages-connections.js:494`（order 62） | 无 | `GET companion`（`pages-connections.js:359`）、`GET health status/sources`、`POST health maintenance{pause|resume}`（`:171-172,189`） | 读 + 一个受限写（采集 pause/resume） | owner（companion-dashboard）+ **host**（health 段） | companion-runtime、companion-health |
| `media` | 媒体能力 | `pages-media.js:1313`（order 63） | 无 | `GET api/companion-media/page`、`GET/POST api/companion-media/config`、`POST test|preview|reference-audio`（`pages-media.js:651-654,699,1177,1218`） | 读+写（按 descriptor，密钥只写） | 兄弟插件自带（Studio 只代理，`pages-media.js:5-14`） | **companion-media 插件**（`/api/companion-media/*`） |
| `exp-library` | 表情包·图库 | `pages-expression.js:1336`（order 80） | 无 | descriptor 驱动：`GET page|config|assets|sources|metrics|deliveries`、`POST config|asset|grants|simulate`（`pages-expression.js:396-402,496,663,804,822,1029,1171`） | 读+写（审核/规则/实验室） | 兄弟插件自带 | **companion-expression 插件**（`/api/companion-expression/*`） |
| `exp-rules` | 表情包·收集规则 | `pages-expression.js:1337`（order 81） | 无 | 同上（规则段） | 读+写 | 同上 | companion-expression |
| `exp-lab` | 表情包·自然度实验室 | `pages-expression.js:1338`（order 82） | 无 | `POST simulate`（只评估，无投递） | 读+受控写 | 同上 | companion-expression |
| `exp-habits` | 表情包·表达习惯 | `pages-expression.js:1339`（order 83） | 无 | 同上（习惯段） | 读+写 | 同上 | companion-expression |
| `workspace` | 工作区 | `pages-workspace.js:812`（order 64） | 无 | **无 HTTP**：宿主服务 `uiWorkspace.listDirectory/pickDirectory/startSession/openSession`、`sessions`/`workspaces` 快照（`pages-workspace.js:324-329,343,379-388`） | 读 + 宿主侧副作用（浏览/选目录/开会话） | client（本地能力判定） | 宿主 `uiWorkspace`/`sessions`/`workspaces` 服务（`core.js:2314`） |
| `settings` | 设置 | `pages-settings.js:1305`（order 70） | 无 | `GET settings`、`GET companion`、`GET health status/care`（`pages-settings.js:364-365,379-380`）、`POST settings`、`POST settings/test`、`POST maintenance`、`POST health maintenance|pulse`（`:541,598,653,671,1012-1026`） | 读+写（白名单 21 键 + 2 个只写密钥） | **host**（`read.mjs:782-784` 与 `write.mjs:385-388,651-653` 都不调 viewer） | 记忆引擎、companion-runtime、companion-health、theme 服务 |
| `overview` | 运行状态（诊断） | `pages-overview.js:461`（order 71） | 无 | `GET summary`、`GET companion`、`POST maintenance`（`pages-overview.js:59-60,98`）；内嵌 `P.ui.RuntimeLog`（SSE，`:442`） | 读 + 维护写（二次确认） | owner（`read.mjs:154`、`write.mjs:676`） | 记忆引擎 + `GET runtime-logs/stream` |

补充：`keyword-map.js` 不是页面（无 `P.registerPage`），只是 chat-settings 的关键词连线编辑器；`P.ui.RuntimeSettings` / `P.ui.RuntimeLog` 由 `pages-operator.js:94-95` 导出，分别被 settings（`:1296`）与 overview（`:442`）复用——**组件复用已有，但两者并不共用同一个「设置/日志」入口**。

---

## 3. 服务端路由表

**合计 43 条路由记录、33 条唯一 path**（同 path 的 GET+POST 由 `groupRoutesByPath` 合成一条 group，否则宿主的 Exact Fetch 会因重复 path 报错并让后续路由整批失联，`server.mjs:123-138`）。注册时 `requestBody: 'buffered'`、未登记方法回 **405 信封**（`server.mjs:167-171,176-192`）。缺 `connection` 服务时静默跳过（`server.mjs:146-148`）。

### 3.1 `ROUTES`（`/api/companion-memory`，`server.mjs:33-69`）

| METHOD path | 处理器 | 读/写 | 作用域 | 关键校验(路径/大小/秘密/权限) | 是否 SSE/long-lived |
|---|---|---|---|---|---|
| `GET /collector-terminals` | `collectorTerminals`（`collector-terminals.mjs:12`） | 读 | 采集器状态 | viewer；`DSH_HOME`/`kernel.root/home` 键取全局控制器（`:14-15`）；无控制器回 `available:false` | 否 |
| `POST /collector-terminals` | 同上（`:20-31`） | 写（启停采集器） | 采集器 | viewer + **CSRF 式双校验**：`content-type=application/json` 且 `sec-fetch-site ∈ {same-origin,none}`，否则 403 `denied`（`:21-25`）；`key ∈ {cloud,ble}`、`action ∈ {start,restart,stop,set-enabled}`、`set-enabled` 必须布尔（`:27-28`） | 否 |
| `GET /chat-settings` | `chatSettings`（`chat-settings.mjs:56`） | 读 | QQ 投影字段 | viewer（`:57`）；`refs = fieldRefs().filter(allowed)`（`:61`）；**投影里剔除 secret/dormant/removed/受限段**（`:12,20-21`）；响应不含任何密钥值（测试断言见 `test/chat-settings.test.mjs:22`） | 否 |
| `POST /chat-settings` | 同上（`:71-92`） | 写 | QQ 配置 | viewer + **revision CAS**（`:73`，hash 由 `values+live.version+override` 计算，`:70`）；`patch` 非空对象（`:74`）；key 必须在投影白名单内（`:78`）；`validateValue(ref.spec,value)`（`:79`）；`keywordReactions` 结构归一（`:23-37`，≤100 组/关键词≤100 字/反应≤2000 字/关键词不可重复）；`contact.quietHours` 必须 `HH:MM`（`:80`）；无热桥时先备份再原子写文件（`:88-91`） | 否 |
| `GET /restart-status` | `operator.pendingRestart`（`operator.mjs:11`） | 读 | 进程级 | viewer；读 `tmp/pending-restart.json`，`bootId` 不匹配即视为已重启（`restart-state.mjs:5-12`） | 否 |
| `GET /persona` | `personaSettings`（`persona-settings.mjs:9`） | 读 | suite 根 persona 文件 | viewer（`:10`）；文件 ≤128KB 读；路径回落 `suiteRoot/config/persona.md` → `kernel.root/workspace/PERSONA.md`（`:12-13`） | 否 |
| `POST /persona` | 同上（`:16-26`） | 写 | 同上 | viewer + 非空 + `Buffer.byteLength ≤ 131072`（`:18`）+ **revision CAS**（`:19`）+ 写前备份到 `backups/persona-*.md`（`:20-23`）+ 原子写（`:24`） | 否 |
| `GET /runtime-logs/stream` | `operator.runtimeLogsStream`（`operator.mjs:80`） | 读 | `kernel.root/logs/start-*.log` | viewer（`:81`）；**只认本套件自己的 `start-*.log`**，无浏览器传入路径（`runtime-log-stream.mjs:5,20`）；`signal` 中止即关流 | **是（SSE，长连接）** |
| `POST /web-panel-control` | `operator.webPanelControl`（`operator.mjs:57`） | 写（进程启停） | 本机面板进程 | viewer（`:58`）；action 仅 `start|restart`（`web-panel-process.mjs:95`）；同 root 单飞（`:96`）；必须是**已核实的本机进程**才允许重启（PID+可执行文件+启动时间比对，`web-panel-process.mjs:76-93,104-112`）；仅本地 URL 才可启动（`:36-37`） | 否 |
| `GET /runtime-settings` | `operator.runtimeSettings`（`operator.mjs:18`） | 读 | `home/companion/runtime.config.json` | viewer（`:19`）；只回 4 个布尔开关 + mode（`:13,38`） | 否 |
| `POST /runtime-settings` | 同上（`:22-37`） | 写 | 同上 | viewer + 仅 `enabled/planning/heartbeat/share` 且必须布尔（`:13,27`）；**只写磁盘 + 关掉 runtime**，明确回 `restartRequired:true`（`:31-36`） | 否 |
| `GET /runtime-logs` | `operator.runtimeLogs`（`operator.mjs:68`） | 读 | 同上日志目录 | viewer；尾读 65536 字节、去半个首行、取末 160 行（`:70-77`） | 否 |
| `GET /web-panel` | `operator.webPanel`（`operator.mjs:41`） | 读 | `home/companion/studio.webpanels.json` | viewer（`:42`）；`panelStatus` 只在**本地 URL**时才探测（`web-panel-process.mjs:41`），`embedUrl` 可能带本地 token（`:22-33`，只从显式配置的 tokenFile 读） | 否（内部 1.2s 探测） |
| `POST /web-panel` | 同上（`:45-54`） | 写 | 同上 | viewer + URL 必须 `http/https` 且**不允许内嵌账号密码**（`:47-48`）；`provider ∈ {napcat,snowluma,luna}`（`:49`）；同源同 provider 才保留旧 launch 字段（`:50-51`） | 否 |
| `GET /companion` | `companionDashboard`（`companion-dashboard.mjs:7`） | 读 | runtime SQLite（**只读连接**）+ 3 个兄弟插件 JSON | viewer（`:8`）+ `scopeKey(viewer)`（`:9`）；SQL 全部参数化 `scope=?`（`:36-58`）；`DatabaseSync(readOnly:true)` + `busy_timeout=1000`（`:63-64`）；单表失败记 `unavailable` 不整页失败（`:66-71`）；读 `runtime.config.json`/`media/config.json`/`channel-qq/contact.json`/`connection-status.json`（`:14-17`） | 否 |
| `GET /summary` | `read.summary`（`read.mjs:151`） | 读 | 记忆库 | viewer（`:154`）+ `requireDb`（`:153`）；计数按 viewer 作用域（`:160-191`） | 否 |
| `GET /memories` | `read.memories`（`read.mjs:301`） | 读 | 记忆库 | viewer（`:304`）；`limit 1..100`（默认 25）、`offset 0..1e6`、`scope/kind/status` 枚举、`query ≤200`、`sort ∈ {recent,importance,confidence}`（`:307-314`）；`SCAN_LIMIT=5000`（`:28`）；FTS 后再按 owner 精筛（`:327-358`） | 否 |
| `GET /memory` | `read.memoryDetail`（`read.mjs:400`） | 读 | 记忆库 | viewer（`:403`）+ `requireDb`；`id ≤80`；`reveal` 仍收但不再改变可见性（README `:147-150`） | 否 |
| `POST /memory` | `write.memoryWrite`（`write.mjs:151`） | 写 | 记忆库 | viewer（`:154`）+ `readDbRecord` **owner 三重比对**（user/persona，别人的 id 当不存在，`:137-145`）；`action ∈ {revise,policy,archive,restore,delete}`（`:24`）；revise 非空且 ≤`limits.factValueChars`（100..4000，默认 2000）；**疑似密钥/密码内容拒收**（`redactSecrets(value)!==value` → 400，`:171-173`）；reason 只收白名单码（`:31-35,123-126`） | 否 |
| `GET /wiki` | `read.wikiIndex`（`read.mjs:511`） | 读 | 记忆库 + wikiDir | viewer（`:514`）+ `requireDb` | 否 |
| `GET /wiki-page` | `read.wikiPage`（`read.mjs:534`） | 读 | wikiDir | viewer（`:537`）+ `page ≤120` + 主题白名单（未知主题 404） | 否 |
| `POST /wiki-page` | `write.wikiPageWrite`（`write.mjs:215`） | 写 | wikiDir（人工区） | viewer（`:218`）；`pageId ≤120` 且必须在 `topicById` 主题表（`:222-225`）；`notes ≤4000`（`:228-230`）；**剥离 `<!-- generated|manual|compiled -->` 防伪造结构**（`:196-202`）；必须有生成区否则拒绝整页覆盖（`:242-246`）；文件路径由主题 `page.path` 拼出（`:253-254`）；原子写（`:204-213`） | 否 |
| `GET /preview` | `read.preview`（`read.mjs:576`） | 读 | 记忆库（检索诊断） | viewer（`:579`）+ `requireDb`；`q ≤300`、`limit 1..20`（默认 8，`:582-583`）；预算 `injection.budgetChars 400..8000`（`:585`）；**不写库**，`embedder:null` 只跑词法（`:596-598`）；返回 `rendered` 全文（诊断用） | 否 |
| `GET /reviews` | `read.reviews`（`read.mjs:650`） | 读 | 记忆库 | viewer（`:653`）+ `requireDb`；pending ≤100、failedJobs ≤50（`:661-673`）；候选正文**照实返回**（审核就是用来看原话，`:691-693`）；`lastError` 经 `safePreview` 脱敏（`:678`） | 否 |
| `POST /review` | `write.reviewAction`（`write.mjs:282`） | 写 | 记忆库（作业队列） | viewer（`:285`）+ `action` 仅 `requeue`（`:288-289`）+ `jobId ≤80`；`job-not-found` → 404、不可重排 → 400（`:293-297`） | 否 |
| `GET /settings` | `read.settings`（`read.mjs:782`） | 读 | `home/companion/memory.config.json` + 密钥文件 | **无 viewer**，只 `requireDb`（`:783-784`）；返回 `editable`(21 键投影, `:736-760`)、`configPath`、运行 `backend`、`embeddingKeySet/rerankKeySet`（只布尔，`:766-780`）、`restartRequiredHint:true`（`:793`） | 否 |
| `POST /settings` | `write.settingsWrite`（`write.mjs:385`） | 写 | 同上（+ 密钥文件） | **无 viewer**（`:386-388`）；`patch` 非空对象（`:391`）；key 必须命中 `SETTINGS_SPEC`(21) 或 `SECRET_SPEC`(2)（`:45-76,413-419`）；逐字段 `check`；跨字段一致性（remote 向量/启用 rerank 必须填地址+模型，`:97-116`）；`apiKey`：null=清除、空串=不改、8..512 且不含空白（`:84-94`）；先在副本上全量校验再落盘，失败不写（`:401-426`）；密钥文件先写、配置后写（`:446-454`）；**从 memory.config.json 里清除历史遗留 apiKey**（`:428-432`） | 否 |
| `POST /settings/test` | `write.settingsProbe`（`write.mjs:651`） | 写（外部网络探测） | 远端 embedding/rerank | **无 viewer**（`:652-655`）；`target ∈ {embedding,rerank}`；草稿只覆盖白名单字段（`:494-523`）；key 直填优先、其次 `apiKeyEnv` 环境变量（`:463-470`）；错误只回固定 code（`http-401/403/404/4xx/5xx`、`bad-shape`、`empty-vectors`、`dimension-mismatch`、`timeout`、`network`，`:525-538`）；**不返回 key 本身** | 否（内部 timeout 500..30000ms） |
| `GET /timeline` | `read.timeline`（`read.mjs:801`） | 读 | 记忆库 events | viewer（`:804`）；`limit 1..200`（默认 50）、`kind ≤60`（`:807-808`）；多取 `min(500, limit*4)` 再过滤（`:814`）；正文只给 160 字脱敏预览（`:831`） | 否 |
| `POST /maintenance` | `write.maintenance`（`write.mjs:673`） | 写（库/索引/Wiki） | 记忆库 | viewer（`:676`）+ `requireDb`；`action ∈ {rebuild,compile-wiki,extract,integrity}`（`:671`）；`extract` 一律 400（Studio 无会话上下文，`:682-685`）；integrity 走 `db.integrityCheck({quick:true})`；rebuild 写索引+向量+重编译 Wiki（`:703-713`），每步失败都收敛成 0 不吞整次 | 否 |
| `POST /plan-slot` | `write.planSlotAction`（`write.mjs:311`） | 写（经运行库事件路径） | companion-runtime | viewer（`:312`）；`action ∈ {lock,unlock,skip}`、`slotId ≤80`、`reason ≤200`（`:315-319`）；运行库缺失 → `db-unavailable`（`:324-326`）；运行库拒绝码映射（`unknown-slot`→404、`scope-mismatch/denied`→200 denied、其余 400，`:334-345`） | 否 |
| `GET /corrections` | `read.corrections`（`read.mjs:852`） | 读 | runtime + 记忆库 | viewer（`:854`）；runtime 缺失如实回 `available:false + reason`（`:857-866`）；`limit 1..20`（默认 5，`:867`）；候选正文截断 160 字并标 `truncated`（`:850`） | 否 |
| `POST /corrections` | `write.correctionResolve`（`write.mjs:732`） | 写（经 runtime 裁决） | companion-runtime | viewer（`:735`，operator 由 `u:<userId>` 生成，**绝不读请求体里的名字**）；`recordId ≤120`、`supersedeIds` 必须数组（`:738-742`）；evidence **服务端生成**（`:749`）；不直写表，只调 `resolveAmbiguousCorrection`（`:752-758`）；runtime code 原样透出（`:763-775`） | 否 |

### 3.2 `HEALTH_ROUTES`（`/api/companion-health`，`server.mjs:79-97`）

| METHOD path | 处理器 | 读/写 | 作用域 | 关键校验 | SSE? |
|---|---|---|---|---|---|
| `GET /status` | `health.healthStatus`（`health.mjs:229`） | 读 | companion-health 服务 | **无 viewer**；服务缺失 → `health-unavailable`（HTTP **200**）；无方法 → 同码；异常收敛成 `internal` | 否 |
| `GET /sources` | `healthSources`（`:238`） | 读 | 同上 | 同上 | 否 |
| `GET /today?date=` | `healthToday`（`:247`） | 读 | 同上 | `date` 只认 `YYYY-MM-DD`，其余忽略（`:185-188`） | 否 |
| `GET /trends?metric=&days=` | `healthTrends`（`:271`） | 读 | 同上 | `metric` 白名单 8 项，未知**回退 steps 且显式标 `metricFallback`+`requestedMetric`+中文 `note`**（`:257-292`）；`days 1..30` | 否 |
| `GET /sleep?date=&days=&includeStages=` | `healthSleep`（`:301`） | 读 | 同上 | `days 1..30`、`includeStages ∈ {1,true}`（`:190-194`）；`awaiting_first_night` 原样透传 | 否 |
| `POST /sync` | `healthSync`（`:357`） | 写（**本前缀唯一触网处**） | 上游健康云 | **5 分钟冷却**（`WeakMap` 挂在 service 实例上，`:26,340-348`）；`force` 不是免死金牌（`:353-381`）；`days 1..30`、`reason ∈ {manual,poll,retry,studio-ui}`（`:67,368-370`）；先记账再调用（`:383-384`） | 否 |
| `POST /maintenance` | `healthMaintenance`（`:479`） | 写 | 采集/备份 | `action ∈ {pause,resume,integrity,backup}`（`:35`）；pause/resume 先落 consent 再 start/stop（`:401-421`）；integrity 只读 `status().db` 不新开句柄（`:423-443`）；backup 只走 service 暴露的能力，否则 `unsupported-action`（`:454-476`）；`pickEnum` 外一律 400 | 否 |
| `GET /pulse` | `pulseStatus`（`:530`） | 读 | 心跳会话 | 无 viewer；服务缺方法 → `health-method-missing` | 否 |
| `POST /pulse` | `pulseAction`（`:580`） | 写 | 心跳会话 + 授权 | `action ∈ {start,stop,mark,consent}`（`:59,514-517`）；`minutes 1..120`、`mark.label ≤40`（`:61-63,602-609`）；`consent` 的 capability **固定为 `health.pulse.live`**，不接受调用方自带（`:57-58,595-597`） | 否 |
| `GET /care` | `healthCare`（`:323`） | 读 | 主动关怀 | **没有 POST**（开关走 `POST /pulse` 的 consent，`server.mjs:94-96`）；授权关着时服务给 `items: []`，这里不补不猜 | 否 |

### 3.3 路由层共性

- 信封：`{ok:true,data,meta}` / `{ok:false,error:{code,message},meta}`；`meta` 固定 `source`+`schemaVersion`+`observedAt`（`api-kernel.mjs:44-54`）；健康前缀换 `source: 'companion-health'`（`health.mjs:82-88`）。
- 错误码白名单只有 5 个：`bad-request / not-found / db-unavailable / denied / internal`（`api-kernel.mjs:21`）；业务失败一律 HTTP 200，状态码只表达 400/404/500（`:29`）。
- 参数一律先收敛：`clampInt / clampNumber / pickEnum / textValue / safePreview`（`api-kernel.mjs:60-90`）。
- 统一兜底 `guard()`：ApiError → 对应码；未知异常只记固定 code，不回 message/栈；**POST 成功后按 `restartRequired` 打重启标记**（`api-kernel.mjs:214-234`，标签映射在 `:220-223`）。
- 路径/大小/秘密三类校验的落点很分散，没有统一中间件：路径只出现在 wiki（主题表 + `page.path`）与日志（固定目录 + `start-*.log` glob）；大小上限逐 handler 各写一份（128KB persona、4000 字 wiki notes、2000 字记忆、512 字 key、500 字 URL）；秘密只有 `SECRET_SPEC` 两个 key + `redactSecrets/safePreview` 两条脱敏路径。
---

## 4. 现有设置与搜索能力

### 4.1 `pages-settings.js` 现在能搜哪些字段

**现状：不能搜任何字段。** `pages-settings.js` 内 `ui.Search` 命中数 = 0；输入控件全是 `ui.Input / ui.Toggle / ui.Select / ui.Segmented`（`pages-settings.js:718-856`）。全仓 `ui.Search` 只被 3 个页面用：记忆库（`pages-vault.js:885`）、召回显微镜（`pages-microscope.js:266`）、表情包（`pages-expression.js:711`）——都是**各自页内的局部筛选**，没有跨页、跨模块的全局设置搜索。

`ui.Search` 组件本体在 `core.js:578-590`（只有 Enter 回调 + 受控 value，没有快捷键绑定）。

### 4.2 字段从哪来：是否已有一份 catalog

**没有统一 catalog**，存在三份各自维护的字段描述，靠人工对齐：

| 副本 | 位置 | 内容 | 与谁对齐 |
|---|---|---|---|
| 服务端写白名单 | `lib/write.mjs:45-68` `SETTINGS_SPEC`（21 键，各带 `section/key/check`） | 权威校验规则 | 与 `read.mjs:710-716` `EDITABLE_KEYS` 同名对齐 |
| 服务端读投影 | `lib/read.mjs:710-716` `EDITABLE_KEYS` + `editableView()` `:736-760` | 21 键的归一化默认值 | 与 `SETTINGS_SPEC` 一一对应 |
| 客户端字段表 | `src/client/pages-settings.js:47-145` `FIELDS`（21 键，各带 `section/label/control/path/hint/min/max/options`） | 渲染元数据（label、控件、范围） | 注释明写「与 `lib/write.mjs` 的 `SETTINGS_SPEC` 一一对应，范围以源码为准」（`:44`） |

客户端 `FIELDS` 是**第二份手工目录**：它的 `path`（`memory.config.json` 真实路径）与服务端 `section+key` 是两套写法（如客户端 `budgetChars.path='injection.budgetChars'`，服务端 `{section:'injection',key:'budgetChars'}`）。可写键总数 21 已核验一致（客户端 `FIELDS` 键数 21 = `EDITABLE_KEYS` 21）。另有 2 个只写密钥 `SECRET_LABELS`（`pages-settings.js:148`），服务端在 `SECRET_SPEC`（`write.mjs:71-74`）——同样两处维护。

计划 W1 要求的字段元信息 `id/label/keywords/description/category/source/owner/permission/hotLevel/available/status` 中，现状**只有** `label`（客户端）、`category≈section`（两边都有）、`source`（散落在文案里）、`permission`（无）、`keywords`（无）、`description≈hint`（仅客户端）、`hotLevel`（**无**：整页都是「重启后生效」）、`status`（只有「已配置/未配置」两值）。

对照：QQ 侧**已经有** `schemaView()` 这样一份真正可导出的 catalog（`plugins/dsh-channel-qq/src/config/meta.ts:128-200`，字段带 `path/section/page/kind/label/help/min/max/unit/choices/secret/advanced/hot/dormant/hiddenIf/hasDefault`），而 Studio 记忆设置侧没有对应物。

### 4.3 `chat-settings` 投影了 QQ 的哪些键（与 `dsh-channel-qq` 交叉核对）

**交叉核对口径修正**：`plugins/dsh-channel-qq/src/config.ts`（349 行）是**类型与再导出**文件，不含字段表（例：`ConnectionConfig` 在 `config.ts:26-31`，实际字段声明在 `src/config/sections/chat.ts:126-148`）。字段的权威来源是 `src/config/sections/*.ts`（每段一个 `FieldGroup`）+ `src/config/sections/root.ts`（顶层字段与段入口）+ `src/config/meta.ts`（`fieldRefs()` 读取语义）。因此本次核对以这三处为准，`config.ts` 只用来确认类型面。

投影白名单（服务端）：`allowed(ref) = !secret && !dormant && !removed.has(path) && !['groupModel','planner','context'].includes(section) && (page ∈ {messages,groups,proactive} || section ∈ {contact,presence,turn,contextBudget,sessionReset})`（`lib/chat-settings.mjs:20-21`），`removed` 集合在 `:12`（`cruises, primaryTalkValue, rooms, agentPreset, permissionPreset, groupAgentPreset, groupPermissionPreset`）。

**全量 288 个字段 → 投影 111（38.5%）**。逐段统计（投影/全量）：

| 段（section） | 页（page） | 全量 | 投影 | 说明 |
|---|---|---|---|---|
| `segmentation` | messages | 9 | **9** | 全投影 |
| `batching` | messages | 8 | **8** | 全投影 |
| `injectMode` | messages | 3 | **3** | 全投影 |
| `interaction` | messages | 3 | **3** | 全投影 |
| `forward` | messages | 2 | **2** | 全投影 |
| `history` | messages | 2 | **2** | 全投影 |
| `reliability` | messages | 3 | **3** | 全投影 |
| `sessionReset` | messages | 8 | **8** | 全投影 |
| `contextBudget` | messages | 2 | **2** | 全投影 |
| `turn` | messages | 1 | **1** | json 内部键归并 |
| `presence` | groups | 22 | **22** | 全投影 |
| `participants` | groups | 3 | **3** | 全投影 |
| `contact` | proactive | 29 | **29** | 全投影（含 `quietHours` 专用校验） |
| `dailyReport` | proactive | 3 | **3** | 全投影 |
| `morningReport` | proactive | 3 | **3** | 全投影 |
| `proactive` | proactive | 3 | **3** | 全投影 |
| 顶层（root） | groups/messages | 22 | **7** | `primaryGroup, groupEnabled, requireMention, talkValue, rateLimitMs, keywordTriggers, keywordReactions` |
| `connection` | connection | 2 | 0 | page 不投影 |
| `channelHealth` | connection | 3 | 0 | page 不投影 |
| `stt` | media | 7 | 0 | page 不投影（**且含 1 个 secret**） |
| `groupModel` | groups | 2 | 0 | **整段排除** |
| `planner` | groups | 1 | 0 | **整段排除** |
| `context` | messages | 2 | 0 | **整段排除** |
| 其余 21 段 | 各自 | 108 | 0 | page/logs/persona/… 不投影 |

**未投影 = 177 个字段**，分因（互斥、可加总到 288）：

| 原因 | 数量 | 代表键 | 源码依据 |
|---|---|---|---|
| `secret: true` 被剔除 | **7** | `stt.apiKey`（`chat.ts:254-257`）、`memory.extractorApiKey`（`memory.ts:118`）、`linkResolve.bilibiliCookie`（`network.ts:21`）、`imageGen.apiKey`（`network.ts:36`）、`song.biliCredentialFile`（`song.ts:256`）、`admin.password`（`system.ts:36`）、`accessToken`（`root.ts:103-105`） | `chat-settings.mjs:20` |
| `dormant` 被剔除 | **1** | `maxMessageLength`（`root.ts:54-57`） | `chat-settings.mjs:20` |
| 在 `removed` 集合内 | **7** | `primaryTalkValue, rooms, cruises, agentPreset, permissionPreset, groupAgentPreset, groupPermissionPreset` | `chat-settings.mjs:12` |
| 整段排除 | **5** | `groupModel.provider/model`、`context.v2/agentInstructions`、`planner.enabled` | `chat-settings.mjs:20` |
| 页面不属于 `messages|groups|proactive`（且段不在 5 个例外段内） | **157** | 连接/媒体/安全/工具/知识库/音乐/技能/记忆/提醒/RSS/风控/事件/语录/口癖/表情/管理后台/生图/链接/主动巡航… 逐段计数见上表 | `chat-settings.mjs:20-21` |

> 口径复现：对 `src/config/sections/*.ts` 按 `id: '<group>' … fields: { … }` 分块、对 `root.ts` 按 `['<key>', b/n/s/e/list/json(...)]` 解析（括号配对解析，先做括号平衡再取该字段的参数串），得 288 个唯一 dot-path；再套 `allowed()` 得 111。**注意**：`plugins/dsh-channel-qq/build/` 在本树不存在（`.gitignore:36 plugins/**/build/**`、`plugins/dsh-channel-qq/.gitignore:41 /build/`），所以这是**源码级静态核对**，不是运行时读回（见 §8）。

投影后的渲染特征（供 W1 深链参考）：

- 每条字段带 `path/group/groupLabel/page/kind/label/help/hot/options/min/max/step/displayDivisor/itemsKind/value`（`chat-settings.mjs:95`），`hot` 直接来自 schema（`ref.spec.hot || 'restart'`）；**但客户端 `pages-chat-settings.js` 完全没渲染 `hot`**，只用 `state.data.live` 做通栏判断（`:57`）。
- 若热桥在线则 `restartRequired` 由 `bridge.apply()` 的结果给出（含「未能热应用」正则探测，`chat-settings.mjs:84`）；离线则干脆回 `restartRequired: Object.keys(patch)`（`:92`）——即**离线时一律声称需重启**，不区分 live/reload。

### 4.4 写入口是否唯一、保存后如何反馈、是否有「需重启」语义

| 项 | 现状 | 源码 |
|---|---|---|
| 记忆设置写入口 | 唯一：`POST /settings`（`SETTINGS_SPEC`+`SECRET_SPEC`）；页面把 dirty 键合并成**一个** patch 一次提交 | `write.mjs:385-456`；`pages-settings.js:440-503,541` |
| 聊天设置写入口 | 唯一：`POST /chat-settings`（有热桥走 `bridge.apply`，无热桥写 `admin-config.json` 前先备份） | `chat-settings.mjs:71-92` |
| 运行库写入口 | 唯一：`POST /runtime-settings`（4 布尔） | `operator.mjs:22-37` |
| 人格写入口 | 唯一：`POST /persona`（revision CAS + 写前备份） | `persona-settings.mjs:16-26` |
| 网页面板写入口 | 唯一：`POST /web-panel`（+ `POST /web-panel-control` 只做进程动作） | `operator.mjs:41-61` |
| 保存反馈 | `P.notice` toast（成功/失败）+ 页内 `ui.Callout`；settings 页成功文案固定是「已写入 …；重启桌面后生效」，失败文案「没有保存：…（改动都还留在页面上）」 | `pages-settings.js:519-556`（文案 `:548,523,543,553`） |
| 「需重启」语义 | 三处**各自为政**：① `GET /settings` 恒回 `restartRequiredHint: true`（`read.mjs:793`），页面对此只画一个 info Callout（`pages-settings.js:1293-1295`）；② `POST /settings` 恒回 `restartRequired: true`（`write.mjs:455`）；③ 聊天页**才**用逐字段级信息（`result.restartRequired?.length` → 「已保存，待重启后加载」/「已保存并应用」，`pages-chat-settings.js:30`）；④ 进程级重启横幅只由 `RestartNotice` 渲染，数据来自 `GET restart-status`，且靠 `companion:restart-required` 事件 + 5s 轮询刷新（`pages-chat-settings.js:10-15`；事件派发在 `core.js:356`） | 见左 |
| 重启状态持久化 | `tmp/pending-restart.json`，`bootId = pid:performance.timeOrigin`；重启后 bootId 不匹配即自动清除并回 `pending:false` | `restart-state.mjs:5-20` |
| 「已保存 / 运行值 / 待重启 / 未配置 / 测试成功失败 / 功能关闭」六态 | 现状只部分具备：密钥有「已配置/未配置」（`pages-settings.js:792`）、聊天有「通道运行中/未加载」（`:57`）、健康有「已启用/未启用/未知」（`:977`）、探测有「端点可用/没通过」（`:817`）；**没有**统一的「当前运行值 vs 已落盘值」对照，也没有 per-field `status` | 见左 |

---

## 5. 日志与可观测性现状

### 5.1 SSE 尾部读取实现细节（`lib/runtime-log-stream.mjs` + `lib/operator.mjs`）

| 维度 | 现状 | 源码 |
|---|---|---|
| 传输 | `text/event-stream`，`cache-control: no-store`，`x-accel-buffering: no` | `operator.mjs:82-84` |
| 认证/权限 | `kernel.viewer()` 先过 owner；无绑定即 `denied` | `operator.mjs:81` |
| 监听对象 | **只**本套件日志目录里 `start-*.log` 的最新一个（文件名排序取末尾），浏览器不能指定路径 | `runtime-log-stream.mjs:5,19-21` |
| 轮转识别 | 身份串 = `文件名:ino:birthtimeMs`；身份变化或 `size < offset` 视为重置 | `runtime-log-stream.mjs:24-25` |
| 首次回填 | 从 `max(0, size-65536)` 开始，并丢掉被截断的首行（`discard=true`） | `runtime-log-stream.mjs:26,32` |
| 单次读取上限 | `min(size-offset, 65536)` 字节/tick | `runtime-log-stream.mjs:28` |
| 轮询间隔 | 默认 `pollMs=250` | `runtime-log-stream.mjs:6,39` |
| UTF-8 边界 | `StringDecoder` 保留半个多字节字符 | `runtime-log-stream.mjs:11,30` |
| 行切分 | 按 `\n` 切，未完成的尾行留在 `pending`；`pending > 65536` 直接丢弃并置 `discard` | `runtime-log-stream.mjs:31,33` |
| 单行上限 | 每行 `slice(0, 8192)` 字符（**截断不计数**） | `runtime-log-stream.mjs:34` |
| 回填窗口 | `reset` 事件只带最后 **250** 行 | `runtime-log-stream.mjs:35` |
| 背压 | `if (closed || controller.desiredSize <= 0) return;` ——**整 tick 跳过，丢弃且无丢弃计数** | `runtime-log-stream.mjs:17` |
| keepalive | 每 10s 一条 `: keepalive`（同样受 `desiredSize>0` 约束） | `runtime-log-stream.mjs:40` |
| 错误 | 任何读取异常只发 `event: log-error` + 固定中文，不暴露 errno/路径 | `runtime-log-stream.mjs:36` |
| 清理 | `signal.abort` / `cancel` 都走 `cleanup()`，清两个 interval | `runtime-log-stream.mjs:14-15,41,43` |
| 脱敏点 | `sanitizeLog()`：① `redactText`（按值形状：`Bearer …`、`sk-…`、`pst-…`、`oc_sk_…`、`fish_…`、≥32 位随机串，`companion-media/src/secrets.mjs`）② 查询串 `token|key|password|auth =` ③ 头/键值式 `authorization|api_key|access_token|cookie|password` | `operator.mjs:63-66` |
| 过滤参数 | **服务端无任何过滤参数**：`createLogStream(root,{signal,sanitize})` 只接受这两个 | `operator.mjs:82`；`runtime-log-stream.mjs:6` |
| ANSI | 剥离 CSI 序列 `\x1b[...]` 与 `\r` | `runtime-log-stream.mjs:34` |
| 客户端缓冲 | 最多 2000 行（`.slice(-2000)`），reset 时整段替换 | `pages-operator.js:53` |
| 客户端能力 | 连接状态 5 态、暂停/继续（关闭+重连）、重连、跟随最新（滚动即关）、清屏（只清显示）、客户端 **substring** 过滤、行数计数 | `pages-operator.js:44-64`（状态标签 `:60`，清屏 `:62`，过滤 `:58`） |
| 静态回退 | `GET /runtime-logs` 尾读 65536 字节、末 160 行（供诊断用） | `operator.mjs:68-78` |

### 5.2 为什么「不等于结构化 trace」——对齐计划 W2 逐条列差距

W2 要求（计划 §3 W2）：① 有限 schema（`eventId/traceId/at/module/stage/status/reasonCode/durationMs/counts/configRevision`）；② 同一流里 console 与 structured trace 并存，可按时间/级别/模块/临时 trace/状态/reasonCode 筛选；③ 点开 trace 看阶段时间线（候选数、过滤原因、注入数/字符数、路由 mode/intensity/source、工具可见/调用/结果、正文长度、总时延）；④ 记忆视图（lexical/semantic 候选 → policy/scope/privacy/topic gate → 融合 → 注入 各阶段计数与原因）；⑤ Prompt 视图（配置版本、开关、被选模块 ID、预算、字符统计、缺失/降级原因，不含 reasoning）；⑥ 连接/断线/暂停/清屏/丢失事件计数/采样保留区间可见；⑦ 默认 2000 行客户端缓冲、服务端限速/截断/轮转可恢复、隐私正文不写新增日志。

逐条现状：

| W2 要求 | 现状 | 差距性质 | 源码位置 |
|---|---|---|---|
| ① 事件 schema | 服务端只发 `ready` / `logs{reset,source,lines,at}` / `log-error{message}`；`lines` 是**自由文本字符串数组** | **无 schema 载体，需新增** | `runtime-log-stream.mjs:13,22,35,36,38`；`operator.mjs:82` |
| ① 关联 ID | 无 `eventId`/`traceId`；行内只有宿主控制台自己的文本 | 需新增（且需在 memory/prompt/tool 边界埋点，Studio 侧当前无 hook） | 全插件 grep `traceId|eventId` = 0 命中（唯一相关串是 expression 分析器的 `reasonCode`，与 trace 无关） |
| ② 同流双类 + 多维筛选 | 同一条 text 流；筛选只有客户端 substring（`row.text.toLowerCase().includes(...)`），无级别/模块/状态/reasonCode 维度，服务端零过滤参数 | 需新增（服务端过滤 + 查询参数契约） | `pages-operator.js:58`；`runtime-log-stream.mjs:6` |
| ③ 阶段时间线展开 | 无「点开一行看阶段」；行只有序号与文本 | 需新增 | `pages-operator.js:64` |
| ④ 记忆检索阶段计数 | 有一份**请求式**诊断：`GET preview` 回 `{query,characters,budgetChars,truncated,entries[reason],explain,rendered}`（含 `explain.filteredReasons`），但它是**一次性 GET**，不进日志流、不按 turn 关联、且 `embedder:null` 只跑词法 | **可复用**（`preview` 的诊断字段）+ **需新增**（流式化与关联 ID） | `read.mjs:576-644`（`entries`/`explain` `:614-643`）；`pages-microscope.js:110-111` |
| ⑤ Prompt 视图 | 无。Studio 只有 persona 文件编辑（`persona-settings.mjs:9-26`）与 prompt engine 的配置写（在 QQ 侧 schema 里），**没有任何 prompt 阶段/预算/字符统计的读接口** | 需新增（跨模块：companion-memory / dsh-channel-qq / runtime） | 路由表无对应 path（`server.mjs:33-97`） |
| ⑥ 丢失计数/采样/保留区间 | 背压丢 tick、8192 截断、`pending>65536` 丢弃**都不计数**；无采样开关；无「保留区间」声明，只有 reset 时 250 行 + 65536 字节回填 | 需新增（计数与保留区间字段） | `runtime-log-stream.mjs:17,33,34,35` |
| ⑦ 轮转可恢复 | 有轮转识别（新文件出现即 `reset:true`），**但旧文件不追**（只看最新一个），断线期间的内容靠下一次 reset 回填 250 行，可能缺失而不告知 | 部分可复用（轮转探测）/ 需新增（缺失区间标记） | `runtime-log-stream.mjs:20-27` |
| ⑦ 服务端限速/截断 | 有轮询节流与单 tick 65536 上限，但**没有速率语义**（无 tokens/秒、无每客户端配额），也**没有丢弃计数** | 部分可复用 | `runtime-log-stream.mjs:28,39` |
| ⑦ 隐私正文不写新增日志 | 现状是「不新增结构化日志」，而不是「结构化日志不含正文」；脱敏是**按值形状的正则**，对「记忆正文/聊天原话/reasoning」没有白名单约束力 | 需新增（白名单字段 schema + 泄露扫描） | `operator.mjs:63-66`；`companion-media/src/secrets.mjs` |
| 反向风险 | 现有 SSE 是**宿主控制台文本**，本身就可能含模型片段/工具参数回显；脱敏只挡凭据形状 | 需在 W2 明确「console 流不进入诊断视图正文」或加更严过滤 | `runtime-log-stream.mjs:34`；`operator.mjs:64-65` |

一句话结论：现在的实现是**一个按 250ms 尾读单个日志文件、按正则脱敏、按行推送的 console tail**；W2 需要的「按 turn 关联、带阶段/理由码/计数的结构化 trace」在 Studio 侧**没有任何载体**，`preview` 是一次性诊断响应，不能替代 trace 流。

---

## 6. 与计划 W1/W2/W3 的差距基线

标注：**复用** = 已有实现可直接用/接线即可；**新增** = 当前无对应物。

### 6.1 W1（页面信息架构与设置目录）

| # | 计划要求 | 现状 | 差距 | 性质 | 引用 |
|---|---|---|---|---|---|
| W1-1 | 以现有主导航为基础，把 QQ 模块设置并入「连接与工具/聊天/安全」等页或原生子页 | 12 个一级入口；QQ 相关只有 2 个：`chat`（聊天设置页）与 `qq-web`（NapCat/SnowLuma **iframe 嵌入**）；`connections` 只显示桥接/投递计数 | 缺 QQ 原生设置页（连接/群/媒体/主动/安全/工具…），现靠 iframe 把 8790 后台塞进来 | **新增**（iframe 现有可复用为过渡） | `core.js:59-72`；`pages-operator.js:76-92`（iframe `:91`，sandbox `allow-scripts allow-forms allow-same-origin allow-popups`）；`pages-connections.js`（只读） |
| W1-2 | 唯一字段注册目录（`id/label/keywords/description/category/source/owner/permission/hotLevel/available/status`） | 记忆侧 3 份手工副本（§4.2）；QQ 侧**已有** `schemaView()` 可导出 20+ 元信息 | 需一个跨模块 catalog 聚合层；QQ 那份可复用 | **复用**（`meta.ts:128-200`）+ **新增**（Studio 侧 catalog + 聚合） | `write.mjs:45-68`；`read.mjs:710-716`；`pages-settings.js:47-145`；`meta.ts:195-200` |
| W1-3 | 全局设置搜索（中文名/别名/帮助文本/配置键/模块名 + 快捷键 + 可发现按钮） | 无全局搜索；`ui.Search` 只在 3 个页面内部用 | 需新增搜索入口与索引；无快捷键（全仓 `ctrlKey/metaKey` 命中在 core.js 只有 Sheet/Escape 与输入 Enter） | **新增**（组件可复用 `core.js:578-590`） | `pages-settings.js`（`ui.Search`=0）；`core.js:578-590,655-677` |
| W1-4 | 结果深链到具体设置项并聚焦输入控件；过滤 secret 原值，只标「已配置/来源环境变量」 | 无深链机制（页面 id 是深链最小单位）；secret 已做到「只写不读 + 只回布尔」 | 需新增字段级 anchor/focus；secret 语义**可复用** | **复用**（secret 语义）+ **新增**（深链） | `pages-settings.js:770-821`（secretRow）；`write.mjs:71-76,84-94`；`read.mjs:766-780` |
| W1-5 | 分组/标签/状态可筛选；保存后显示「已保存/热更新成功/需重启/应用失败」并链运行证据 | 分组有（记忆 6 组 `pages-settings.js:904-919`；聊天按 section 分组 `pages-chat-settings.js:37,59`）；状态只有部分；热更新只有聊天页有逐字段结果；无「运行证据」链接 | 缺统一状态枚举与证据链接；`hotLevel` 未渲染 | 部分**复用**（分组/通知） + **新增**（状态机/证据） | `pages-chat-settings.js:30,57`；`pages-settings.js:1293-1295`；`read.mjs:793` |
| W1-6 | 清除重复导航项但保留原 URL/hash 兼容映射 | 无 hash/URL 可保留（状态在 localStorage）；当前已存在**结构性重复**：`health` 同时是一级入口与 `life` 的 tab（`pages-health.js:1772-1782` 运行时改写 NAV） | 迁移时要做「旧 localStorage id → 新页」映射；并解决 health 双入口 | **新增**（映射）+ **需决策**（health 归属） | `core.js:65,169,1933-1937`；`pages-health.js:1772-1782` |

### 6.2 W2（实时日志与结构化 trace）

| # | 计划要求 | 现状 | 差距 | 性质 | 引用 |
|---|---|---|---|---|---|
| W2-1 | **保留现有 SSE console tail**，扩展成日志工作台，不另造第二条通道 | 已有 SSE tail + 客户端 2000 行缓冲 + 暂停/继续/跟随/清屏/过滤/重连 | 可作为底座直接扩展 | **复用** | `runtime-log-stream.mjs`；`pages-operator.js:43-65`；`operator.mjs:80-85` |
| W2-2 | 复用现有身份认证、脱敏、owner viewer、backpressure | viewer ✅、脱敏 ✅（正则）、backpressure ✅（跳 tick） | 丢弃计数缺失；脱敏非白名单 | **复用** + 小改 | `operator.mjs:81,63-66`；`runtime-log-stream.mjs:17` |
| W2-3 | 有限 schema 结构化事件 | 无 schema | 需定义 schema + 落点 | **新增** | 全插件无 `eventSchema` |
| W2-4 | 同流 merge console 与 trace，按维度筛选 | 单一文本流，仅 substring | 需事件分类/双通道 merge/查询参数 | **新增**（merge 点可复用现有 `send()`） | `runtime-log-stream.mjs:13` |
| W2-5 | trace 展开阶段时间线（候选/过滤/注入/路由/工具/正文长度/时延） | `preview` 提供候选+`explain.filteredReasons`+`characters`+`budgetChars`+`truncated`（一次性） | 需把 preview 的诊断字段「事件化 + 按 turn 聚合」；工具/路由阶段当前无数据源 | **复用**（preview 字段语义）+ **新增**（事件化） | `read.mjs:608-643`；`pages-microscope.js:110-176` |
| W2-6 | 记忆视图各阶段计数与理由码 | 仅 `filteredReasons`（透传 `recall().explain`），无 stage/status/counts 结构 | 需 hooks | **新增**（字段语义可复用） | `read.mjs:594-605,641` |
| W2-7 | Prompt 视图（配置版本/开关/模块/预算/字符/缺失原因，不含 reasoning） | 无任何 prompt 读接口；persona 只有原文 | 需跨模块新增 | **新增** | `server.mjs:33-97`（无路由）；`persona-settings.mjs` |
| W2-8 | 连接态/重连/暂停/清屏/丢失计数/采样保留区间 | 前四项 ✅；后两项缺 | 需新增计数与采样 | 部分**复用** | `pages-operator.js:44-62`；`runtime-log-stream.mjs:17,33` |
| W2-9 | 客户端 2000 行缓冲；服务端限速/截断/轮转可恢复 | 缓冲 ✅ 2000；截断 ✅ 65536/8192；轮转探测 ✅（只看最新文件） | 限速无速率语义；断线缺失区间不可见 | **复用** + 小改 | `pages-operator.js:53`；`runtime-log-stream.mjs:20-35` |
| W2-10 | 隐私正文不写新增日志；泄露扫描为 0 | 当前不写结构化日志（因此「新增日志泄露」风险低），但也**没有**可被扫描的 trace 样例集 | 需在 schema 落地时同步建扫描用例 | **新增**（测试资产） | `operator.mjs:63-66`；`test/` 无泄露扫描用例（见 §7） |

### 6.3 W3（写作成果中心）

| # | 计划要求 | 现状 | 差距 | 性质 | 引用 |
|---|---|---|---|---|---|
| W3-1 | 新增「作品」入口，复用 P2 activities / artifactRef / workspace | 无「作品」页；`workspace` 页只做宿主目录浏览与会话入口；`GET companion` 已返回 `p2_activities` 行（含 `target/artifact_version/source_hash/status/ended_at`）与 `p2_receipts` | 列表数据**已在** `companion` 响应里；缺专用页与详情 | **复用**（数据源）+ **新增**（页面/详情 API） | `companion-dashboard.mjs:50-54`（activities/receipts 查询）、`:73-77`；`pages-workspace.js:322-343` |
| W3-2 | 从 runtime 活动 + artifact 索引读；不扫盘、不暴露绝对路径 | 无 artifact 读接口；`workspace` 页显示的是**宿主**工作区路径 | 需新增受限读取端口 | **新增** | `pages-workspace.js:204-260,666`（显示宿主路径） |
| W3-3 | `artifactRoot` 内文本读取，校验路径/realpath/大小/类型/作用域 | 无 readFile 端口；全插件 `realpath` 只在停进程校验里出现（`web-panel-process.mjs:70,89,91`），与文件预览无关 | 需新增（计划已明确要求 realpath+allowlist） | **新增** | 全插件 `lib/*.mjs` 无 readFile 文件预览路径 |
| W3-4 | Markdown/text 安全渲染；其他格式走下载/打开，不执行 HTML/脚本 | 现有 Markdown 只解析标题/列表/粗体/代码（README `:157`），无 HTML 渲染 | 渲染器**可复用**（wiki 页已有 markdown 解析） | **复用**（`read.mjs:50-94` parseWikiLayout/summarizeWikiMarkdown） | `read.mjs:50-94`；README `:157` |
| W3-5 | 版本/修订/创建活动/证据/最近修改；无 receipt 不标「已完成」 | `companion` 已给 `artifact_version` + `p2_activity_receipts(ok,code,at)`，且 `buildExperience` 已实现「回执优先、状态兜底」 | 语义**可复用**；缺页面 | **复用**（`buildExperience`）+ **新增**（页面） | `companion-dashboard.mjs:82-95`（注释与规则）、`:95+` 实现 |
| W3-6 | 冲突提示（被修改/删除）；首版只读，不做覆盖编辑/删除/分享 | 无任何作品读/写路径 | 需新增 | **新增** | — |
| W3-7 | 元数据索引先复用 runtime/memory artifact references，不足才新增可重建索引 | `artifactRoot` 默认 `home/companion/works`（runtime config 默认值） | 需先确认 references 是否够用 | **待核对**（`companion-runtime/lib/config.mjs:87,208`；`p2.mjs:68` 另有 `workspace/companion-works` 默认，两处默认值不一致，需列入 W3 前置核对） | `companion-runtime/lib/config.mjs:87,208`；`companion-runtime/lib/p2.mjs:68` |

### 6.4 附带发现（不属于 W1/W2/W3，但影响 G0 放行）

1. **health 路由完全没有 owner 判定**：`lib/health.mjs` 全文件无 `viewer` 调用（grep 0 命中），而 `server.mjs:72` 注释写的是「Owner-only 只读」。实际保护只有宿主 `/api` 前缀的连接层认证。健康数据本身已过 `stripPrivate()`（`health.mjs:125-148`），但「谁能读」与记忆路由不一致。
2. **`GET/POST /settings` 与 `POST /settings/test` 无 viewer**：`read.mjs:782-784`、`write.mjs:385-388`、`write.mjs:651-653` 都没有 `kernel.viewer()`。这两条是**写配置 + 触发外部网络探测**的路径，权限等级低于记忆写路径。
3. **无 hash/URL 路由**：计划 W1-6 的「保留原 URL/hash 兼容映射」在本插件没有对象可保留，实际要做的是 localStorage id 映射（`cpx.page`/`cpx.tab.<group>`）。
4. **NAV 运行期被页面改写**：`pages-health.js:1772-1782` 直接 mutate `P.NAV`，与「core.js 是导航唯一来源」的注释（`core.js:57-58`）冲突；新增/删除页面时会成为隐性耦合点。计划 §4 已把 `core.js` 列为集成负责人独占文件，这条正好落在该约束里。
5. **README 与实现漂移**：README 仍写「七个一级入口」（`:15-16`）与「8 页」，实现是 12 个一级入口 / 20 个注册页。文档口径需在 W1 一并修正（本报告不改 README）。

---

## 7. 测试与验收资产

### 7.1 测试清单（`plugins/companion-memory-studio/test/`，共 17 个文件、174 个 `test()` 用例）

| 文件 | 用例数 | 覆盖什么 | 证据等级 |
|---|---|---|---|
| `api.test.mjs` | 29 | **真引擎 + 真 SQLite**（临时 root、临时 `memory.config.json` 指向临时库、owner `u1`）：`summary` 计数、`memories` 过滤/分页/FTS、`preview` 渲染与 explain、`settings` 白名单读与非法键/非法值拒绝、写路径等 | 离线集成 |
| `chat-settings.test.mjs` | 6 | QQ 投影字段集合、secret 不回传（`:22`）、revision CAS 拒绝过期写（`:30`）、`quietHours` 非法值 400（`:27`）、热桥 `apply` 与 restartRequired 区分（`:36-46`）、restart 提醒跨 handler 重建存活（`:48-55`）、无 owner 即拒绝（`:57`）、`displayDivisor`/小数步长（`:59-70`）、`keywordReactions` 归一与歧义拒绝（`:72-82`） | 离线单元（**依赖 `plugins/dsh-channel-qq/build/`**） |
| `companion-dashboard.test.mjs` | 1 | 只读连接与投影 |
| `correction-review.test.mjs` | 8 | 纠正裁决：只读列表 + 唯一写入口，断言「UI 递给 runtime 什么」而非 runtime 内部 |
| `expression-page.test.mjs` | 16 | 表情包页 descriptor 纯逻辑（状态映射/合并/patch） |
| `first-run.test.mjs` | 1 | 全新数据目录下 Host 半能挂上并留合法身份（不出现 `N entries did not activate`） |
| `health-api.test.mjs` | 23 | 健康路由注册形状（同路径 GET/POST 合成 group、方法不匹配 405）、服务缺失/报错的 `health-unavailable` 200 信封、参数收敛（days/metric/date/includeStages）、5 分钟冷却、隐私（uid/token/uniqueId/rawRef/payload 一个字节不出） |
| `health-pulse-api.test.mjs` | 19 | `GET/POST /pulse` 同一 group、既有 7 条未挪位、会话动作与参数收敛、consent 只能改 `health.pulse.live`、缺服务/缺方法/异常全 200 信封、未知 action 才 400 |
| `live-log-persona.test.mjs` | 3 | **SSE 真实追加**、被拆分 token 的脱敏（`?token=private` + `-token-value` 拼接后仍红）、**轮转跟随**（`start-2.log` 出现 → `reset:true`）、`cancel` 后 `done`；persona 写入前备份 + 过期 revision 不覆盖；无 owner 拒绝 | 离线（真流） |
| `media-page.test.mjs` | 26 | 媒体页纯逻辑：视图模型 / patch 构造 / 密钥只写 / 预设分族 |
| `operator.test.mjs` | 4 | runtime 开关只写允许键且保留无关字段（`:19-28`）、web-panel 未配置态与拒 `javascript:` URL（`:29-38`）、**日志尾读脱敏**（`token`/`Bearer` 不出现，`:39-48`）、三条 operator 路由需 owner（`:49-56`） |
| `p2-dayview.test.mjs` | 10 | 生产缺陷回归：用真实生产行 fixture 断言日视图不对未完成槽报「未完成」 |
| `p2-experience-projection.test.mjs` | 7 | 只读经历投影口径 + **零写语句**（录 `node:sqlite` prepare/exec 逐条判读）+ 数据库字节比对 |
| `p2-life-view.test.mjs` | 6 | `buildLife` 纯函数分组规则（现在/接下来/已结束/未完成/已跳过） |
| `plan-controls.test.mjs` | 6 | 锁定/跳过只出现在「未来且 planned」的槽上 |
| `plan-slot-route.test.mjs` | 6 | `POST /plan-slot` 经真路由表交给 stub runtime，不自己写计划 |
| `web-panel-process.test.mjs` | 3 | 本机进程识别与启停边界 |

运行器：`scripts/run-tests.mjs` 先把 `DSH_COMPANION_DATA_DIR` 指到 `mkdtemp` 再跑 `node --test 'test/*.test.mjs'`，跑完删临时根（`:9,21-22,47`），因此 `npm test` **不写仓库、不写用户数据**。

### 7.2 `smoke-client.mjs` 的浏览器冒烟能力

- 定位：**无浏览器**，用最小 React 运行时把 `client.js` 真跑一遍；不替代浏览器验证，只拦「一打开就白屏」（`scripts/smoke-client.mjs:1-4`）。
- 假后端是**真实形状**：媒体 descriptor 由 `companion-media` 自己的 `mediaPageDescriptor + createMediaService` 现造（`:342-378`），不是手抄；`api/companion-memory/*`、`companion-health/*`、`companion-expression/*`、`companion-media/*` 全部按协议转发（`:533-551`）。
- 断言覆盖面：12 个一级导航 label 逐字比对（`:688,699-701`）、5 个一级页可打开且页名进 DOM（`:748-756`）、媒体页 保存/回读/密钥清除/草稿跨页保留（`:805-1110`）、表情包 4 个 tab + 图库/规则/实验室/习惯（`:1125-1300`）、生活与日程 + 健康 tab + **心跳卡 6 组场景**（有读数/device 模式/设备收口/无读数 `—`/未开始/未连接/读失败仍留卡片，`:1404-1595`）、审核页、设置页 tab、聊天页缺 layout 提示（`:1598-1607`）。
- 输出：注册面、实际请求清单（按 endpoint 去重）、媒体/表情包请求清单、失败列表（`:1609-1630`）。

### 7.3 缺哪些计划要求的用例

| 计划要求 | 现有 | 缺口 |
|---|---|---|
| W2「密钥、聊天正文、记忆正文和 reasoning 泄露扫描为 0」 | 只有 3 处**针对性**脱敏断言（`operator.test.mjs:39-48` 的 token/Bearer、`live-log-persona.test.mjs` 的拼接触 token、`health-api.test.mjs` 的隐私键剔除） | **无独立的 trace 脱敏扫描用例**（没有样例集、没有黑名单字段遍历、没有 reasoning/正文 关键词扫描） |
| W3「越界路径、链接外跳、超大文件、缺失文件、作用域错配都 fail-closed」 | 无 | **完全没有**：当前不存在 artifact 读端口，也没有相关失败路径测试 |
| W1「同一字段只出现一个主要写表单 / catalog 字段唯一 owner」 | 无 | **无 catalog 唯一性测试**（现在连 catalog 都没有，只有 3 份手工副本） |
| W1「搜索支持键盘与屏幕阅读器；空结果/未装载/只读/待重启均有状态」 | 无 | **无搜索相关测试** |
| W2「事件流中断和轮转恢复通过测试」 | 轮转**有**（`live-log-persona.test.mjs:19-29`，`start-2.log`）；`cancel` 有 | **无「中断期间丢了多少事件」用例**，也无背压/丢弃计数断言 |
| W2「合成成功/空召回/隐私拒绝/向量降级/路由 shadow/模块关闭/工具失败/空正文都能找到 reasonCode」 | `api.test.mjs` 有 preview 的命中/未命中（`:272-285`），`health-api` 有 unavailable 分支 | **无 reasonCode 全覆盖矩阵**（且当前没有 trace 载体可断言） |
| W4 跨插件设置读回一致性 | `chat-settings.test.mjs` 覆盖读回（`:32,68,80`） | 但**本树跑不起来**（见 7.4）；且无「Studio → QQ 原生 schema → 再读回」的一致性用例 |

### 7.4 本次实际执行结果（可复现命令见 §8）

- `node plugins/companion-memory-studio/scripts/run-tests.mjs`：**174 tests / 170 pass / 4 fail**。4 个失败全部在 `test/chat-settings.test.mjs`，根因是 `plugins/dsh-channel-qq/build/lib/config.js` 等产物不存在（`Cannot find module ...\build\lib\config.js`），即**未构建兄弟插件**，不是断言逻辑错误。前 3 个用例连带失败（`fields` / `revision` 取不到）。
- `node plugins/companion-memory-studio/scripts/smoke-client.mjs`：**15 项失败**，全部集中在「媒体页 fixture 与页面期望漂移」（12 项：provider 列表/识图开关/API Key 输入/协议选择器/预览按钮/草稿放弃按钮/select 的 id 等）、「设置页 tab 数量」（1 项：实际 2 个 tab，断言要求 ≥3）与「聊天页缺 layout 提示」（1 项：断言找 `宿主导航`，页面实际只在 `P.toastOnce` 里用这个词，`core.js:1927`）。导航 12 项逐字匹配、生活/健康/心跳卡/表情包/记忆与档案分组 tab **全部通过**。
- 结论口径：这两次执行都是**离线**行为，不构成运行态证据；它们说明「客户端产物可执行」「SSE 与脱敏逻辑可验证」，同时暴露了**测试与实现已经漂移**（`smoke-client` 断言未跟上媒体页改版）。

---

## 8. 证据等级

| 级别 | 本次是否执行 | 具体做到什么 | 说明 |
|---|---|---|---|
| **静态审阅** | ✅ 已执行 | 通读 `server.mjs`(193 行) / `index.js`(165) / `lib/*.mjs`(12 个文件) / `src/client/*.js`(19 个片段) / `scripts/build-client.mjs` / `scripts/run-tests.mjs` / `scripts/smoke-client.mjs`(1630 行，抽查) / `test/*.test.mjs`(17 个文件头与关键断言) / `package.json` / `cordis.patch.yml` / `locale/*.json` / `README.md`；交叉核对 `plugins/dsh-channel-qq/src/config/{schema,meta,dsl,pages}.ts` 与 `src/config/sections/*.ts`(30 个文件)、`plugins/companion-runtime/lib/config.mjs` | 所有结论都带 `文件:行号`；未凭记忆补全 |
| **构建产物核对** | ✅ 已执行 | ① 用当前源文件按 `build-client.mjs` 的 18 段顺序重拼，与仓库 `client.js` 逐字节比对：正文一致（`contains_body=true`，差额仅为外壳头尾）；② 核对产物内 18 个片段标记行号；③ 用 `node` 直接 import `server.mjs` 读出路由表（`ROUTES=33`、`HEALTH=10`、`ALL=43`、唯一 path `33`、group `33`）；④ 用 Node 脚本解析 QQ schema 得 288 字段并复算 `allowed()` → 111 | 这是**产物与源码一致性**的核对，不是运行宿主 |
| **离线执行** | ✅ 已执行（有限范围） | `node plugins/companion-memory-studio/scripts/run-tests.mjs`（174 用例，170 通过）与 `node plugins/companion-memory-studio/scripts/smoke-client.mjs`（15 项失败，明细见 §7.4） | 全部在 `mkdtemp` 临时数据根上运行，不触碰仓库数据与用户数据 |
| **运行态观测** | **未执行** | 未启动或重启任何服务；未打开生产 GUI `http://127.0.0.1:3080`；未在隔离宿主里加载插件；未观察真实 SSE 推送、真实 `pending-restart.json` 变化、真实热桥 `bridge.apply()` 行为 | 按任务约束「不启动/重启服务」 |
| **浏览器验收（视觉/键盘/屏幕阅读器）** | **未执行** | 无截图、无焦点顺序检查、无窄窗口/移动宽度检查 | — |
| **构建兄弟插件后复核 chat-settings** | **未执行** | `plugins/dsh-channel-qq/build/` 不存在（`.gitignore:36`、`dsh-channel-qq/.gitignore:41`），因此 §4.3 的投影是静态核对，投影后的**实际读回值**未验证；4 个测试失败即由此产生 | 需 `npm run build`（channel-qq）后才能补 |
| **8790 独立 admin 侧盘点** | **未执行（超出本报告范围）** | 本报告只覆盖 Studio 侧；`src/admin/**`、`src/admin-html.ts` 未逐页盘点 | 属并行包（计划 §4 包 C） |
| **`data/` 私密内容审阅** | **未执行（按约束跳过）** | 只确认 `data/` 目录是否存在（存在），未读取任何内容 | 遵守 AGENTS.md 硬性规则 5 |
| **secret / token 输出** | **未执行** | 报告内不出现任何口令、token、cookie 值；涉及密钥处只写「key 名 + 是否已配置」 | — |

**报告可复现命令**（只读，均不写仓库数据）：

```powershell
# 路由表实读（需 node ≥ 24）
node -e "import('file:///D:/DSH/dsh-production/.agents/worktrees/dsh-355649bf-c144/plugins/companion-memory-studio/server.mjs').then(m=>console.log(m.ROUTES.length,m.HEALTH_ROUTES.length,m.ALL_ROUTES.length,new Set(m.ALL_ROUTES.map(r=>r.path)).size))"

# 离线测试（临时数据根，跑完自动删）
node plugins/companion-memory-studio/scripts/run-tests.mjs

# 客户端冒烟（不启浏览器）
node plugins/companion-memory-studio/scripts/smoke-client.mjs
```

---

### 附：本报告的口径与边界声明

1. 「页面数 20」= `P.registerPage` 调用数（含 4 个表情包子页、`health` 这个既是 tab 也在一级导航的页）。若按**一级导航**计是 12；若按**用户可见的独立内容页**计是 20。
2. 「路由数 43」= `ALL_ROUTES` 记录数；同 path 的 GET+POST 在宿主侧合成 1 条 group（33 条 group）。两者数字不同不是笔误。
3. 「未投影的 QQ 键数 177」= 288 − 111，分因互斥可加总（7 secret + 1 dormant + 7 removed + 5 整段排除 + 157 页面不投影 = 177）。
4. 本报告列出的所有「缺口」都是**基线描述**，不含实现方案；W1/W2/W3 的设计留给对应包。
5. 未覆盖：QQ 8790 后台逐页盘点、宿主插件页扩展 API 能力边界、生产 Profile 实际装载的 bundle 列表——这些属于 G0 其他条目或并行包。
