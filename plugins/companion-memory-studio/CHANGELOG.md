# Changelog · companion-memory-studio

## 未发布 — 心跳共振 Studio 面（Pulse Bond P3，2026-11-03）

契约：`design/pulse-bond-20261103.md` §4.4 / §7。**不新增一级菜单，也不新增页面入口**：
实时心跳只是健康页概览里多一张卡，Host 半多两条路由。

### 新增
- `lib/health.mjs`：`pulseStatus` / `pulseAction` 两个 handler。
  GET `/api/companion-health/pulse` 只转发 `service.pulse()` 那一份视图；
  POST 认 `{action:'start'|'stop'|'mark'}`（走 `pulseSession()`）与 `{action:'consent', consent:true|false}`
  （固定写 `health.pulse.live`，**不接受**请求方自带其它 capability）。
  `minutes` 夹 1..120、`label` 压成一行并限 40 字、action 大小写与空白不敏感。
- `server.mjs`：`HEALTH_ROUTES` 追加 `GET/POST /api/companion-health/pulse`（既有 7 条的名字、顺序、
  行为全部不动；`ROUTES` 不碰）。同路径两条方法仍合成一条 Exact Fetch group。
- `src/client/pages-health.js`：「心跳 · 实时」卡（概览顶部，另在"整页读不到"时也保留一张）。
  大号 bpm（无读数写「—」，**绝不写 0**）、最近 60 点内联 SVG sparkline、四档色块
  （calm / warming / racing / peak）、设备状态（设备名 / 未连接 / sidecar 不可达）、
  会话倒计时（未开始就写「未开始」）、开始 / 结束 / 此刻标记三个按钮、
  `health.pulse.live` 授权开关（`ui.Toggle`，走同一条 POST 路由的 `consent` 动作）。
- 轮询：1 Hz，**只在卡片在视口里且页面可见时**（`IntersectionObserver` + `visibilitychange`），
  切 tab 就 `clearInterval`；读失败保留上一份读数但标出来，不把旧 bpm 冒充"现在"。
- `client.js` 重建（544,196 → 564,474 字节）。

### 变更（2026-11-04 · 主人「不用窗口」）
- **会话不再有倒计时窗口**：默认 `mode:'device'`（跟随设备）。卡片只显示
  「跟随设备（01:17 开始）」，**不出现**「剩余 N 分钟」/「即将结束」；只有主人显式给了
  minutes（`mode:'timer'`）才显示剩余分钟。`session.active=false` 一律「未开始」。
- **设备关掉 = 会话随之结束（预期行为，不报警）**：三个条件同时成立才算 ——
  `lastErrorCode==='disconnected'` **且** `session.active===false` **且**
  `sampleAgeMs > session.deviceOffMs`；此时设备行给中性灰「设备已关闭，会话随之结束」，
  大号 bpm 与 sparkline 都不再显示数字（陈旧读数不当"现在"），会话行写「已结束」。
- **`stop` 会顺带断开 BLE**，所以"断开"≠"设备被关掉"：只有断开信号但没过 `deviceOffMs`
  时设备行中性写「已断开」、会话行「已结束」、读数照常显示（那是主人主动操作，不是故障）。
- 会话还开着但设备正在掉线（`active:true` + `connected:false`）保持 warn 与读数：
  那是有界瞬时窗口（后端 ≤ `deviceOffMs` 后收口），"会话还在、读数在变旧"是事实。
- **「开始」失败的两种原因分开说**（`code` 仍是 `pulse-unreachable`，只看 `errorCode`）：
  `device-not-found` → 「没找到在广播的手环：先在手环上把手表「心率广播」打开，再试一次。」；
  `connect-timeout` → 「找到了手环但没连上（超时），再点一次「开始」或在设置里把它从蓝牙列表里重连。」；
  其它（`unreachable` / `http-error` / 没给 `errorCode`）沿用「心率广播接收端没有在跑（sidecar 不可达）」。
  为此失败信封的 `error` 在服务真的给了 `errorCode` 时多带一个 `errorCode` 字段（既有 7 条路由的形状不变）。
- hint 与卡尾文案补一句：空闲时不扫描、不轮询，有读数只发生在会话开着的时候。

### 已知
- `pulseHistory()` / `pulseDevices()` 按 Lead 裁决**不暴露 Studio 路由**：历史峰值给对话里的
  `companion_pulse action=history` 用，设备扫描/连接是安装期操作（`check-pulse.mjs --scan`）。
  所以未连接时这张卡只写「未连接」，没有扫描/连接按钮。
- 健康服务还停在旧版（没有 `pulse` / `pulseSession`）时，这两个接口回
  `health-method-missing`（HTTP 200），页面显示"这一版健康服务还没有实时心跳接口"，不假装空数据。
- 心跳数据只在这一张卡里：不写库、不进日志、不进 `meta`、不画到时间线/审核等其它页面。

### 测试
- 新增 `test/health-pulse-api.test.mjs`（19 条）：正常信封、参数收敛、consent 只改
  `health.pulse.live`、服务缺失 `health-unavailable`、缺方法 `health-method-missing`、
  facade 抛异常也不 500、未知 action 400、源码护栏（不 fetch / 不 SQLite / 不落盘 / 不定时器）；
  另加 2b/2c（`mode:'device'` 与"设备关掉"的事实原样透出）、5e（`pulse-unreachable` +
  `errorCode` 原样透出，且服务没给时信封里不凭空多出这个键）。
- `test/health-api.test.mjs` 的路由计数断言按新表更新（7 → 9 条，健康前缀 8 条路径），
  既有 7 条的名字与顺序另加了一条"没挪位"断言。
- `scripts/smoke-client.mjs` 增「打开 健康与睡眠 → 心跳卡」的无浏览器检查：
  有读数 / `bpm:null` 写「—」/ 未开始 / 未连接 / 读失败不消失 / 不出现 `0 bpm`；
  2026-11-04 追加四种情形：`mode:'device'` **不渲染**倒计时（不出现「剩余」「即将结束」）；
  设备被关掉（`disconnected` + `active:false` + 静满 `deviceOffMs`）渲染
  「设备已关闭，会话随之结束」且不出现任何 bpm 数字；`stop` 后立刻的断开信号只说「已结束」、
  **不许**说成设备被关掉；会话还开着但掉线时照常显示读数。

## 未发布 — 健康与睡眠（companion-health A0–A2 + Sleep S0–S2，2026-11-03）

Host 半新增 7 条只读/维护路由，Client 半新增「生活与日程 → 健康与睡眠」二级页。
本版**不新增任何一级菜单**（仍是 7 个），也不改变任何既有记忆路由的行为。

### 新增
- `lib/health.mjs`：`/api/companion-health/{status,sources,today,trends,sleep}`（GET）与
  `/sync`、`/maintenance`（POST）。信封沿用 `api-kernel`，`meta.source='companion-health'`；
  服务缺失时**仍注册**并返回 `health-unavailable`（HTTP 200，不 404）；所有响应过
  `stripPrivate()`（`uid/token/uniqueId/devId/rawRef/payload` 一律不外传）。
- `server.mjs`：`HEALTH_ROUTES` + `ALL_ROUTES`，Exact Fetch 仍按路径合并（22 条路由 / 22 个唯一路径）。
- `src/client/pages-health.js`：概览 / 睡眠 / 活动与运动 / 关怀与证据四段，7·30 天切换。
- 陪伴首页加「今天的活动与睡眠」小卡；连接与工具加唯一一张「华为运动健康（CN 云）」来源卡
  （含二次确认的停用/恢复，不提供 Health Connect / Health Sync / Gadgetbridge 入口）。
- `client.js` 重建：459,818 → 544,196 字节。

### 已知
- 睡眠无数据时三块固定空态（会话/阶段/原厂评分），**不显示 0 小时、不推断深睡与评分**。
- 二级 tab 由 `pages-health.js` 在运行时补到 `P.NAV` 的 `life.tabs`（未改 `core.js`）。
- 健康前缀与 `api/companion-memory/` 不同源，三处页面各自带一份 request 封装（约 25 行重复，待收敛）。

### 测试
- 新增 `test/health-api.test.mjs`（23 条）；`test/api.test.mjs` 的注册数断言改为不写死数字
  （健康路由无条件挂载后，22 条路由 / 22 个唯一路径）。
- 既有 6 条 `avoid_unless_asked` 可见性用例仍为红：`read.mjs` 自 2026-10-31 起按用户要求
  全可见，测试期望未同步。**与本版无关**，未修。

## 1.1.0 — 2026-10-31「陪伴空间」UI 改版

一次性重排整个客户端外壳，Host 半与业务语义零改动（路由、写入口、reason 白名单、隐私规则全部不变）。

### 新增
- 产品外壳：左侧 7 个一级入口（陪伴首页 / 聊天 / 生活与日程 / 记忆与档案 / 连接与工具 / 工作区 / 设置），
  可折叠导航（`cpx.rail`），≤760px 抽屉 + Esc 关闭 + 焦点归还，跳转到主内容链接。
- 主题层：`ctx.theme.overrideTokens` 覆盖宿主 14 个 alias token，暖白/墨蓝双模 + 樱粉品牌色；
  三档主题开关（跟随系统/浅色/深色）在左栏底部与设置页双向同步，持久化由宿主 `ui-theme` 承担。
- 陪伴首页（`pages-home.js`）：原创 CSS 场景 + 一句现状、接下来的安排、最近一起经历的事、
  需要你确认的事；右栏显示记忆/待核对/记录计数与回到开发入口。所有数值来自真实接口，缺失显示 `—`。
- 生活与日程（`pages-life.js`）：现在/接下来/已结束/未完成/已跳过分组，目标与承诺，
  锁定·解锁·跳过走 `POST plan-slot` 并等回执。
- 连接与工具（`pages-connections.js`）：QQ 投递账本、媒体能力、记忆桥接、未接入项；只读，无发送入口。
- 工作区（`pages-workspace.js`）：目录浏览（AbortController）、文件详情抽屉、会话入口；
  宿主服务缺失时整页降级并禁用按钮。
- 设计系统：新增 `Band/Split/List/Row/Toolbar/Search/Segmented/Callout/Field/Sheet/Diagnostic/
  Timestamp/Masked/Meter/Skeleton/StateLine`，并把 `cmx-*` 原语整体重刷成新视觉语言。
- 聊天周边：`conversation.input.dock` 一条可忽略的状态摘要条，API 不可用时静默。
- 验收工具：`tools/ui-acceptance/`（隔离预览宿主 + 零依赖 CDP 驱动 + 三尺寸截图/交互断言）。

### 变更
- 记忆库/审核/Wiki/时间线/显微镜/设置/运行状态全部按新契约重写：页名 + 一句说明 + 一个主操作 + 状态行，
  分区用分隔线而不是逐条套卡；技术字段（评分、`source_hash`、revision、队列）默认收进 `ui.Diagnostic`。
- 设置页只渲染后端白名单（`EDITABLE_KEYS` 21 键 + 只写不读的两个 key），密钥只显示「已配置/未配置」。
- 审核页通过/驳回改用真实状态迁移（`restore` / `delete`），原因用后端白名单码 + 人话标签，
  失败作业重排走 `POST review {action:'requeue'}`。
- 构建片段表：`core → home → life → vault → wiki → timeline → review → microscope →
  connections → workspace → settings → overview`；移除 `pages-companion.js`（内容并入 home / life）。

### 移除
- 旧的面板内 8 项纵向导航与其深色硬编码配色；`pages-companion.js` 的字段表首页。

### 验证
- `node scripts/build-client.mjs`（12 片段，`node --check` 通过）
- `node scripts/smoke-client.mjs`（最小 React 运行时：7 个一级入口、记忆与设置分组 tab、主题三档、
  导航折叠、原生聊天入口降级提示全部断言通过）
- 隔离预览宿主 + 无头 Chrome：1440×900 / 1024×768 / 390×844 截图与交互断言（见
  `logs/ui-redesign-20261030/report.md`）

### 回滚
- 客户端：`git`/快照 `logs/ui-redesign-20261030/baseline-src/companion-memory-studio/client.js`
  覆盖回 `client.js` 后刷新页面即可。
- 主题层：禁用/卸载本 bundle 即撤销 token 覆盖层，宿主恢复原配色。
