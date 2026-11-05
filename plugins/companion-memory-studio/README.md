# 三月七记忆档案 · companion-memory-studio

DSH 三月七陪伴基座的**记忆管理工作台**：一个可安装的 bundle，安装后 Web 侧栏出现「记忆档案」图标，
点开是 7 页工作台——检索记忆、核对证据、纠正事实、诊断召回、维护 Wiki 与设置。

- 包名：`@local/dsh-companion-memory-studio`
- Host 半：`index.js` 提供共享记忆引擎服务（`companionMemory`）+ 一组**需要浏览器认证**的 HTTP API。
- Client 半：`client.js` 在侧栏注册入口，在主区注册 7 页工作台。
- 契约：`design/studio/ARCHITECTURE.md`（v1）。

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
| 连接与工具 | QQ 投递账本、媒体能力、记忆桥接、未接入项（只读，不发消息） | `GET companion` |
| 工作区 | 目录浏览、会话入口、宿主能力降级说明 | `ctx.uiWorkspace.*`、`P.nav.*` |
| 设置 | 外观三档、角色、模型连接、记忆参数、连接摘要；高级诊断折叠 | `GET settings` `POST settings|settings/test` |

设置分组里的两个诊断页：**运行状态**（`GET summary` + 重建索引）与 **召回显微镜**
（`GET preview`，检索诊断，不写库）。它们不再占用一级导航。

**外观**：暖白/墨色正文 + 低饱和樱粉品牌色；深色为墨蓝灰。同一组语义 token 走
`ctx.theme.overrideTokens` 覆盖宿主的 14 个 alias token（层可撤销，不改 base theme，
卸载即恢复）。主题三档「跟随系统 / 浅色 / 深色」写在宿主 `ui-theme` 设置里（左栏底部与设置页
双向同步），刷新后保留。

**布局**：左导航 224px（可收成 64px 图标栏，`localStorage['cpx.rail']`）、内容区最大 1160px、
首页右栏 276px；≤1180px 右栏落到正文下方；≤760px 导航变抽屉（`Esc` 关闭并把焦点还给按钮）。

**无障碍与动效**：跳转到主内容链接、`aria-current` 导航态、2px focus-visible 轮廓、
状态点 + 文字双表达、抽屉焦点归还、`prefers-reduced-motion` 下无动画。

**聊天周边**：不动原生聊天与消息持久化；仅在输入框上方（`conversation.input.dock`）
加一条可忽略的状态摘要条（"三月七 · 今天的安排都过去了 · 打开陪伴空间"），API 不可用时自动不渲染。

> 旧的 7 页工作台（总览 / 记忆库 / 显微镜 / Wiki 档案 / 时间线 / 审核中心 / 系统设置）在 v1.1
> 里被重排进上面的七个入口：能力没有减少，只是层级变了。第 3 节保留为历史说明。

## 1. 侧栏入口

安装并启用后：

- 侧栏出现「记忆档案」图标（星轨 + 档案盒，`icon.svg`）；
- 点开后在主区打开工作台，标题「记忆档案」，右上角有刷新按钮；
- 浏览器端资源地址：`/plugins/@local/dsh-companion-memory-studio/client.js`（安装后可用来确认 200）；
- 界面文案跟随宿主语言（`locale/zh.json`、`locale/en.json`）。

## 2. 安装

本包是**本地目录 bundle**，不发布到 npm；安装由插件管理器完成，不要手写 profile 的
`package.json` / `cordis.patch.yml`。

1. 目录：`C:\Users\bobo\Documents\Bot\dsh-companion\plugins\companion-memory-studio`
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
- **敏感内容**：表达策略为 `avoid_unless_asked` 的记录，在列表、预览、审核与详情里默认**隐藏正文**；
  只有显式 `reveal=1` 才返回，并在响应 `meta.revealed` 标记。
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
  src/client/pages-*.js      # 7 个页面片段                             （ui-a / ui-b）
  scripts/build-client.mjs   # 拼装器（本包维护）
  client.js                  # 生成物，勿手改（由 build-client.mjs 生成）
  locale/zh.json / en.json   # 显示名与描述（插件管理器读取，不激活也能显示）
  icon.svg                   # 原创图标（星轨 + 档案盒，≤256 KiB）
  README.md                  # 本文件
scripts/verify-studio.mjs    # 仓库根的只读体检脚本（不启动 Host）
```

## 8. 构建与体检

```powershell
# 只校验片段拼装与语法，不写文件
node plugins/companion-memory-studio/scripts/build-client.mjs --check

# 生成 client.js（提交物）并跑 node --check client.js
node plugins/companion-memory-studio/scripts/build-client.mjs

# 仓库根：清单/导出/本地化/图标/client.js 语法体检，失败退出码 1
node scripts/verify-studio.mjs
```

拼装顺序固定：`core.js` → `pages-overview.js` → `pages-vault.js` → `pages-microscope.js`
→ `pages-wiki.js` → `pages-timeline.js` → `pages-review.js` → `pages-settings.js`；
缺失片段会跳过并列出，`core.js`（定义 `apply`）缺失时不会写出 `client.js`。
