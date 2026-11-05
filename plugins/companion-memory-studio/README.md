# 陪伴空间 / 记忆档案 · companion-memory-studio

DSH Companion 套件的**记忆管理工作台**：一个可安装的 bundle，安装后 Web 侧栏出现「记忆档案」图标，
点开是 7 页工作台——检索记忆、核对证据、纠正事实、诊断召回、维护 Wiki 与设置。

- 包名：`@dsh-companion/memory-studio`（套件内安装名）
- Host 半：`index.js` 提供共享记忆引擎服务（`companionMemory`）+ 一组**需要浏览器认证**的 HTTP API。
- Client 半：`client.js` 在侧栏注册入口，在主区注册 7 页工作台。
- 契约：`companion-memory/CONTRACT.md`（套件内唯一契约文档）。

---

## 0. 界面总览（v1.1 · 2026-10-31「陪伴空间」改版）

面板现在是同一个产品外壳，而不是八个并列的数据库页面。宿主侧栏入口文字是 **陪伴空间**，
点开后是七个一级入口（可折叠导航 + 内容区 + 仅首页使用的右栏）：

| 一级入口 | 页面重点 | 主要 API |
| --- | --- | --- |
| 陪伴首页 | 主场景一句话现状、接下来的安排、最近一起经历的事、需要你确认的事（右栏：状态/记忆计数/回到开发/数据说明） | `GET companion` `GET summary` `GET reviews` `GET timeline` |
| 聊天 | 回到宿主原生对话（不在本插件内重建消息流） | `ctx.layout.selectPanel('conversation')` |
| 生活与日程 | 现在 / 接下来 / 已结束 / 未完成 / 已跳过，目标与承诺，锁定·解锁·跳过 | `GET companion` `POST plan-slot` |
| 记忆与档案 | 记忆库（搜索/筛选/详情抽屉/掩码）· Wiki · 时间线 · 审核 | `GET memories|memory|wiki|wiki-page|timeline|reviews`、`POST memory|wiki-page|review` |
| 连接与工具 | QQ 投递账本、**媒体能力（可编辑设置页）**、记忆桥接、未接入项（除媒体设置外只读，不发消息） | `GET companion`、`GET|POST /api/companion-media/{page,config,test,preview}` |
| 工作区 | 目录浏览、会话入口、宿主能力降级说明 | `ctx.uiWorkspace.*`、`P.nav.*` |
| 设置 | 外观三档、角色、模型连接、记忆参数、连接摘要；高级诊断折叠 | `GET settings` `POST settings|settings/test` |

设置分组里的两个诊断页：**运行状态**（`GET summary` + 重建索引）与 **召回显微镜**
（`GET preview`，检索诊断，不写库）。它们不再占用一级导航。

### 0.1 「连接与工具 → 媒体能力」是一个真正能操作、能回读的设置页

页面**按 companion-media 的 descriptor 渲染**（`GET /api/companion-media/page`：分区 →
provider → 字段，每个字段带 `path`/`pathParts`/`label`/`type`/`value`/`writable`，六种状态
文案、`canTest`/`canEnable`、端点清单 `api` 一并给出）。Studio 这一侧只做展示与取值：

- **不写媒体 JSON、不复制第二份服务商逻辑**：没有硬编码的 provider id、端点路径、必填项或
  校验规则；保存一律 `POST /api/companion-media/config`，错误按响应里的 `errors[].path`
  直接落回对应输入框。
- **只发改动**：patch 是稀疏深合并（没发的 provider 段原样保留），所以「切换 OpenAI / NAI」
  不会把另一个协议的配置冲掉。单 provider 保存、单分区保存、NAI 两族预设（V5 / 4.5 分开
  存储）与画师串都各自独立。
- **密钥只写**：字段值恒为 `{configured, mask}`，输入框恒空，占位显示「已配置 / 未配置」；
  留空保存 = 保留原密钥；清除是一次显式动作（发 `{clear:true}`）。**清除前会先关能力**
  （同一个 patch 里带上「启用生图」或该后端的开关），因为后端不允许在启用态清空必填密钥。
  密钥来自环境变量时（`states.*.providers[].key.source === 'env'`）输入框锁定并标「来自环境
  变量」——改页面不会生效。
- **测试与预览只由按钮触发**：打开页面只读 `page` + `config` 两个 GET，`/test`、`/preview`、
  `/image`、`/speech` 绝不自动发起（descriptor 的 `meta.testPolicy = explicit-only`）。
  测试失败是 `HTTP 200 + body.ok:false + code`，页面照实写「测试失败」，不会说成成功。
- **测试结果只对「已保存配置」有效**：`/test` 读的是落盘配置，所以任何字段一被编辑，该
  provider 的旧结果（包括「测试通过」）立即消失；有未保存改动时测试按钮**禁用**并提示
  「先保存再测试」。保存成功后所有旧结果一并作废。绝不把过期结果留在界面上。
- **草稿不会静默丢失**：切到别的页面再回来，未保存的改动按「服务器配置指纹」从模块级缓存
  恢复；点「刷新」或后台重读回来的配置**不会覆盖**正在编辑的内容（只有本地没有改动、或
  刚刚保存成功时才跟服务器走）；服务器内容确实变了会提示「服务器上的配置变了，但你的草稿
  还在」，并给一个显式的「放弃未保存的改动」。
- **label 与控件真的关联**：`ui.Field` 的 id 落到实际控件（`input`/`select`/`textarea`）的
  `id` 上，点标签会聚焦到对应输入框（2026-11-06 UI 审核修复；此前 `label.for` 有值但控件
  `id` 为空）。
- **不可用的能力如实呈现**：识图整块锁定（「预留，当前关闭」，开关与字段都不可编辑）；
  Index-TTS 按 `canTest:false` / `canEnable:false` 禁用开关与测试；`saved-untested` 只显示
  「已保存、未测试」，不写成连接成功。
- **媒体模块没启用时入口仍然在**：页面说明「套件里没有启用媒体模块」，给出
  `config/suite.json` 的 `modules.media: true` 与重启/`npm run doctor` 的路径，并把运行库
  读到的五个开关（`GET companion · media`）照旧列出来。

> 页面的纯逻辑（状态映射、descriptor+config 合并、patch 构造、密钥只写、预设分族、
> 错误路径映射）在 `test/media-page.test.mjs`；真实 DOM 交互（填表 → 保存 → 断言请求体 →
> 断言 DOM）在 `scripts/smoke-client.mjs`，两者都不依赖浏览器。


**外观**：暖白/墨色正文 + 低饱和樱粉品牌色；深色为墨蓝灰。同一组语义 token 走
`ctx.theme.overrideTokens` 覆盖宿主的 14 个 alias token（层可撤销，不改 base theme，
卸载即恢复）。主题三档「跟随系统 / 浅色 / 深色」写在宿主 `ui-theme` 设置里（左栏底部与设置页
双向同步），刷新后保留。

**布局**：左导航 224px（可收成 64px 图标栏，`localStorage['cpx.rail']`）、内容区最大 1160px、
首页右栏 276px；≤1180px 右栏落到正文下方；≤760px 导航变抽屉（`Esc` 关闭并把焦点还给按钮）。

**无障碍与动效**：跳转到主内容链接、`aria-current` 导航态、2px focus-visible 轮廓、
状态点 + 文字双表达、抽屉焦点归还、`prefers-reduced-motion` 下无动画。

**聊天周边**：不动原生聊天与消息持久化；仅在输入框上方（`conversation.input.dock`）
加一条可忽略的状态摘要条（"陪伴空间 · 今天的安排都过去了 · 打开"），API 不可用时自动不渲染。

> 旧的 7 页工作台（总览 / 记忆库 / 显微镜 / Wiki 档案 / 时间线 / 审核中心 / 系统设置）在 v1.1
> 里被重排进上面的七个入口：能力没有减少，只是层级变了。第 3 节保留为历史说明。

## 1. 侧栏入口

安装并启用后：

- 侧栏出现「记忆档案」图标（星轨 + 档案盒，`icon.svg`）；
- 点开后在主区打开工作台，标题「记忆档案」，右上角有刷新按钮；
- 浏览器端资源地址：`/plugins/@dsh-companion/memory-studio/client.js`（安装后可用来确认 200）；
- 界面文案跟随宿主语言（`locale/zh.json`、`locale/en.json`）。

## 2. 安装

本包是**本地目录 bundle**，不发布到 npm；安装由插件管理器完成，不要手写 profile 的
`package.json` / `cordis.patch.yml`。

1. 目录：`<套件根>/plugins/companion-memory-studio`
2. 用 `plugin_manager` 安装：
   - `action: "list_bundles"` 看现状；
   - `action: "install_bundle"`，`target` 为该绝对目录；
   - 读回 `application` / `warnings`：`applied` 表示已生效；
     `restart-required` 表示需要重启桌面；`failed` / `overridden` 需要先诊断。
3. 安装前自检（只读）：

   ```powershell
   cd plugins/companion-memory-studio
   node scripts/build-client.mjs --check
   cd ../..
   node scripts/verify-studio.mjs
   ```

4. 卸载：`plugin_manager` `action: "remove_bundle"`。卸载**不会**删除记忆库、Wiki 或备份。

> 经验规则：**新增** bundle 通常经 HMR 生效；**替换已安装的包**（新的客户端 JS 生成）需要重启桌面，
> 才能让浏览器加载新的模块版本。不要用「侧栏 id 没变」推断客户端代码已更新。

## 3. 7 页能力（v1.0 历史小节，v1.1 已重排为七个一级入口，见第 0 节）

| 页面 | 做什么 | 主要 API |
| --- | --- | --- |
| 总览 | 记忆/证据/Wiki/任务计数、作用域与类型分布、最近记忆、健康与配置摘要 | `GET summary` |
| 记忆库 | 文本检索（FTS5）、按作用域/类型/状态筛选、详情抽屉、来源证据与修订链、修订/改表达策略/归档/恢复 | `GET memories`、`GET memory`、`POST memory` |
| 显微镜 | 用真实检索链预演一条问题：候选项、过滤原因、最终注入文本与字符预算（诊断只读） | `GET preview` |
| Wiki 档案 | 四个主题页的目录与正文；**自动编译区只读**，只允许编辑人工注释区 | `GET wiki`、`GET wiki-page`、`POST wiki-page` |
| 时间线 | 证据事件与修订的时间轴，每条预览截断（≤160 字），不展示完整正文 | `GET timeline` |
| 审核中心 | 待审事实（含准入理由与冲突）与**失败作业**两类对象分开呈现，可重新排队 | `GET reviews`、`POST review` |
| 设置 | 白名单配置写回 `home/companion/memory.config.json`；维护动作（重建索引、编译 Wiki、完整性检查） | `GET settings`、`POST settings`、`POST maintenance` |

写入语义：

- `revise`（改正正文）必带 `value`，长度受 `config.limits.factValueChars` 限制；
- `policy` 只接受 `direct | soft_echo | tone_only | avoid_unless_asked`；
- `archive` → `archived`、`restore` → `confirmed`、`delete` → **`retracted`（不物理删除）**；
- 所有写入都要求 `reason`（默认 `studio-ui`），只接受白名单 code，不把自由文本写进日志。

## 4. 权限与隐私边界

- **认证**：`/api` 前缀由宿主 Connection 认证（owner-only）；浏览器**不能**传入
  `userId / personaId / worldId`，服务端固定使用 owner viewer。
- **`mentionPolicy` 的边界（重要）**：`avoid_unless_asked` 意思是「**模型**不要主动提起这件事」，
  它**不是**管理台的视图过滤器。你在陪伴空间里始终能看到自己的记忆正文（列表、详情、审核、
  时间线、检索诊断、Wiki）——看不到就没法核对和修订被记下来的内容。旧的 `reveal=1` 参数仍然
  接受，但不再改变任何可见性（`hidden` / `revealable` 恒为 `false`，没有 `meta.revealed`）。
- **模型侧仍受限**：注入给模型的上下文文本按 `mentionPolicy` 处理（该行只留占位，不进正文），
  所以「主人能看到」不等于「模型会主动提起」。两个面各按各的规则。
- **管理台是明文**：陪伴空间按上面的规则展示记忆正文。**屏幕共享、录屏、截图、远程协助时请注意
  窗口内容**；不要在别人的屏幕上打开记忆库/审核页。真正需要「看的时候也隐藏」的模式是另一个
  独立功能，当前版本不提供。
- **错误与日志**：错误 `message` 面向用户、不含栈；日志只写计数、类型、耗时与会话 id，不写记忆正文。
- **渲染**：客户端不使用 `dangerouslySetInnerHTML`；Markdown 只解析标题、列表、粗体、代码。
- **写操作**：只有用户在界面上显式操作并确认时才写库；不提供批量静默修正。
- 服务端路由允许缺失：没有 `connection` 服务时静默跳过，不影响其它 composition。

## 5. 已知限制

1. **多世界未隔离**：本轮工作台只以 owner 视角查询，界面不提供 `world_id` 切换；剧情世界记录不单独分区。
2. **语义通道是本地 hash 向量**：确定性特征哈希 + 余弦，不是神经网络 embedding；同义改写的召回有限，
   远端 embedding 未在本轮联调。
3. **配置改动需重启**：设置页只写回 `memory.config.json`，不热改运行中的引擎；重启后生效。
4. **依赖同仓库的兄弟包**：`index.js` 以相对路径引用 `../companion-memory` 与 `../companion-foundation`，
   本包不是可独立发布的 npm 包；单独移动本目录会加载失败。
5. **片段缺失时只有 Host 半**：`client.js` 由 `scripts/build-client.mjs` 拼装 `src/client/*.js` 生成；
   片段未就绪时不能构建，也就无法在浏览器里看到工作台。
6. **视觉表现需人工确认**：安装成功与 slot 注册成功都不等于「用户看到的样子正确」，
   需要在浏览器里检查侧栏图标、7 页布局与窄窗口换行。
7. **无浏览器自动化时**：只能验证资源 200、schema 与注册行，不能声称视觉验收通过。

## 6. 禁用 / 卸载影响

- 侧栏「记忆档案」入口、7 页工作台与所有 `/api/companion-memory/*` 路由**一起消失**。
- **记忆数据保留**：`home/memory/companion-memory.db`、`home/memory/wiki/`、`home/memory/backups/`、
  `home/companion/memory.config.json` 都不会被删除或回滚。
- 聊天侧不受影响：`companion-foundation` 在没有共享 `companionMemory` 服务时会**自己创建引擎**
  （打开同一个 SQLite 记忆库），只是失去管理与诊断入口。
- 重新启用后需刷新页面；若替换了包版本，需要重启桌面。

## 7. 目录与文件

```
plugins/companion-memory-studio/
  package.json               # bundle 清单：exports / files / dsh.bundle / dsh.client
  cordis.patch.yml           # 只插入一行：id=companion-memory-studio，无 config
  index.js                   # Host 入口：共享引擎服务 + 注册 API      （Lead 维护）
  server.mjs                 # 路由表 → handlers                      （host-api 维护）
  lib/api-kernel.mjs         # viewer/engine 访问、信封、错误、参数解析 （host-api）
  lib/read.mjs               # 只读 handlers                          （host-api）
  lib/write.mjs              # 写入 handlers                          （host-api）
  test/api.test.mjs          # API 测试（临时库）                       （host-api）
  src/client/core.js         # 外壳、P 原语、CSS、侧栏注册              （Lead）
  src/client/pages-*.js      # 页面片段（含 pages-media.js：媒体能力设置页）
  test/media-page.test.mjs   # 媒体设置页的纯逻辑测试（视图模型 / patch / 密钥）
  scripts/run-tests.mjs      # 测试运行器：临时数据根 + node --test
  scripts/smoke-client.mjs   # 无浏览器冒烟：真实形状的 descriptor/config + 点击流程
  scripts/build-client.mjs   # 拼装器（本包维护）
  client.js                  # 生成物，勿手改（由 build-client.mjs 生成）
  locale/zh.json / en.json   # 显示名与描述（插件管理器读取，不激活也能显示）
  icon.svg                   # 原创图标（星轨 + 档案盒，≤256 KiB）
  README.md                  # 本文件

```

## 8. 构建与体检

```powershell
# 只校验片段拼装与语法，不写文件
node plugins/companion-memory-studio/scripts/build-client.mjs --check

# 生成 client.js（提交物）并跑 node --check client.js
node plugins/companion-memory-studio/scripts/build-client.mjs

# 仓库根：清单/导出/本地化/图标/client.js 语法体检，失败退出码 1
node scripts/verify-studio.mjs

# 单元测试（把数据根指到临时目录，跑完删除；不写仓库、不碰用户数据）
npm test
```

`npm test` 走 `scripts/run-tests.mjs`：先 `mkdtemp` 出一个临时数据根并设 `DSH_COMPANION_DATA_DIR`，
再执行 `node --test "test/*.test.mjs"`。原因很具体：`server.mjs` 在**模块加载时**就把数据根算成
`STUDIO_ROOT`，而健康桥接解析失败时会写 `<dataRoot>/home/health/bridge-miss.json`——如果不改根，
测试会把诊断写进仓库的 `data/`。做法与 foundation、health 两个包一致。

拼装顺序固定：`core.js` → `pages-overview.js` → `pages-vault.js` → `pages-microscope.js`
→ `pages-wiki.js` → `pages-timeline.js` → `pages-review.js` → `pages-settings.js`；
缺失片段会跳过并列出，`core.js`（定义 `apply`）缺失时不会写出 `client.js`。
