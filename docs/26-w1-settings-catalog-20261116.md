# W1 实施记录：单一字段目录 + 跨设置项搜索（2026-11-16）

- 计划：[docs/ui-observability-unification-plan-20261116.md](ui-observability-unification-plan-20261116.md) §3 W1
- 前置基线：[docs/25-g0-ui-observability-baseline-20261116.md](25-g0-ui-observability-baseline-20261116.md)
- 本轮范围：**只做 W1-1 到 W1-5**（目录 + 搜索 + 深链 + 状态呈现）。W1-6（旧 URL/hash 兼容映射）与 W4 的 8790 关停不在本轮。
- 未执行：真实宿主装载、浏览器实机验收、8790 关停、任何外发。

---

## 1. 做了什么

| 计划条目 | 交付 | 位置 |
|---|---|---|
| W1-2 唯一字段注册目录 | 字段目录**不存清单**，而是两个既有权威来源的投影 | `lib/settings-catalog.mjs` |
| W1-3 全局设置搜索入口 | `GET /api/companion-memory/settings-catalog`（只读）+ `Ctrl/⌘+K` 面板 | `lib/settings-catalog-route.mjs`、`src/client/settings-search.js` |
| W1-4 结果深链 + 聚焦 | 结果带 `path` / `deepLink`；设置页控件带 `data-field-path` 锚点 | `pages-settings.js`、`settings-search.js` |
| W1-5 状态呈现 | `已配置 / 默认值 / 已设置 / 未设置 / 未知 / 未装载` + `立即生效 / 重连生效 / 需重启` | 同上 |
| 去重验收 | 三份手工目录变成一条可执行断言 | `scripts/check-settings-catalog.mjs` |

**没有新增第四份字段清单。** 目录 = `QQ fieldRefs()` + `Studio SETTINGS_SPEC/SECRET_SPEC` + 客户端 `FIELDS`（渲染元数据）的投影；`settings-catalog.mjs` 里唯一的常量表是搜索别名词，且只影响命中率、不影响任何写入或校验。

## 2. 目录的元信息（计划 W1-2 要求逐项对齐）

`CATALOG_META_KEYS` = `id / label / keywords / description / category / source / owner / permission / hotLevel / available / status`，顺序固定，单测逐键断言。

| 键 | 取值口径 |
|---|---|
| `source` | `qq-schema` \| `studio-spec`（来源，不是页面） |
| `owner` | `dsh-channel-qq` \| `companion-memory-studio`（**写入口归属**，不复制校验规则） |
| `permission` | `owner` \| `host` \| `client`。QQ 字段一律 `owner`；Studio 设置字段一律 `host`，因为 `/settings`、`/settings/test`、`/api/companion-health/*` 实测没有 `kernel.viewer()`（G0 §3.5.1），**按实测标，不按习惯标** |
| `hotLevel` | `live` / `reload` / `restart`，与 QQ schema 同一套词汇，不自创 |
| `available` | 模块是否装载（QQ 插件未装 → 整片 `false`） |
| `status` | `default` / `configured` / `secret-set` / `secret-unset` / `unknown` / `unavailable`。拿不到层信息就 `unknown`，**不写 `default`**（那等于谎报"没被改过"） |

## 3. 状态是怎么算出来的（不猜）

- **QQ 侧**：读两层 dot-path——`home/channel-qq/admin-config.json`（override）与 `config/profile/companion.patch.yml` + `home/profiles/<profile>/cordis.patch.yml` 的 `channel-qq` 行（patch）。命中即 `configured`。
  - patch 层需要 `yaml`。套件根 `node_modules` 里没有它，生产是经 `DSH_COMPANION_MODULE_ROOT` 指向宿主 module root 才解析到的（`dsh-ops/serve.mjs:15`）。**解析器拿不到就返回 `null`，目录退回"只看 override"**——绝不把 patch 层当成空集合（那会把已配置字段全报成 `default`）。
  - 实测：override 3 条、patch 129 条。
- **Studio 侧**：读 `home/companion/memory.config.json` 的 dot-path 集合；密钥"有没有"用 `loadConfig()` + `readRemoteModels()`（与 `read.mjs` 的 `secretsFlag()` 同一套权威），**目录不自己拼密钥文件路径**。

## 4. 搜索行为（可解释、可断言）

命中分层：标签完全相等 3 / 标签包含 2 / 关键词完全相等 2 / 关键词包含 1 / 路径包含 1 / 描述包含 0.5；排序 = 分数降序 → 可用优先 → 标签更短优先 → id 字典序（确定性）。中文按字匹配，不引入分词（目录 < 400 条，分词只会带来不稳定）。

空查询不是错误：回稳定列表并过滤 `unavailable`。`limit` 只裁剪 `matches`，不改 `total`（前端要显示"还有多少没显示"）。

**已修的一个真实 bug**：空查询与命中查询过去返回不同键（空查询缺 `path`/`deepLink`/`secret`），前端在"刚打开面板"时聚焦逻辑会拿到 `undefined`。现在两者都走同一个 `publicMatch()`，单测与 API 用例都钉住这一点。

## 5. 前端（`src/client/settings-search.js`，248 行）

- 设置页头部一个 `搜索设置 / Ctrl K` 触发器；全局 `Ctrl/⌘+K` 打开（输入焦点内的组合键不抢）。
- 面板：`role=dialog` + `aria-modal`，输入框 `aria-controls` / `aria-activedescendant`，结果 `role=listbox`/`option`，↑↓ 选择、Enter 打开、Esc 关闭，选中项自动滚进可视区。
- 每条结果显示：中文名、配置键路径、热等级徽标（仅非 `live` 时）、状态徽标、`宿主权限` 徽标（`permission=host` 时）。
- 深链：`studio:settings` → 切到设置页后按 `data-field-path` 滚到控件并聚焦 + 高亮 1.6 s（`prefers-reduced-motion` 下改为静态描边）；`qq:<page>` → 明确提示"属于 QQ 原生后台，这里只索引不代改"，不假装能改。
- 空结果/加载/错误三态齐备；空结果时列出 `catalog.sources` 的加载状态与原因（`qq-build-missing` 等），不静默降级成空面板。

## 6. 去重验收：三份手工目录 → 一条断言

`scripts/check-settings-catalog.mjs`（`npm run check:catalog`）以 `SETTINGS_SPEC` 为权威，从源码里解析另外两处，做 6 类核对：

1. 三份键集合逐键相同（不是比数量）；
2. 每份内部无重复键；
3. 只写密钥不出现在任何可读目录（`SETTINGS_SPEC` / `FIELDS` / `editableView`）；
4. 客户端每条都有 `label` / `control` / `path`；
5. 服务端每条都有 `section`+`key`+`check`（`backend` 例外，root 级）；
6. **客户端点路径 == 服务端 `section.key` 拼出的路径**（这条过去完全没人验，是两套写法漂移的入口）。

实测：`21 / 21 / 21 / 2` 四组计数一致，0 处漂移。

## 7. 验证结果（本轮实际跑的）

| 项 | 命令 | 结果 |
|---|---|---|
| 字段目录核对 | `npm run check:catalog` | ✓ 三份一致（含 path 拼接），只写密钥未泄漏 |
| Studio 单测 | `node scripts/run-tests.mjs` | **193 tests / 193 pass / 0 fail**（本轮从 174 增至 193） |
| 客户端拼装 | `node scripts/build-client.mjs --check` | ✓ 19 片段 / 752,120 字节 / `node --check` 通过 |
| 客户端冒烟 | `node scripts/smoke-client.mjs` | **失败 13 项**，全部在媒体页（见 §8），搜索面板与深链 4 项新增断言全绿 |
| 静态卫生 | `node scripts/verify.mjs --only=static` | 38 ok / **1 failed**：`tools/lib/host-temp.test.mjs:5`（HEAD 上就存在的 Windows 用户目录测试夹具，非本轮引入，未改） |

### 7.1 新增测试（19 个用例，4 个文件）

| 文件 | 用例 | 钉住什么 |
|---|---|---|
| `test/settings-catalog.test.mjs` | 2 | 三份目录一致性（子进程跑核对脚本）+ 计数不缩水 |
| `test/settings-catalog-search.test.mjs` | 6 | 投影形状、状态不猜、secret 只写、排序稳定、空/垃圾输入不炸、关键词幂等 |
| `test/settings-catalog-layers.test.mjs` | 4 | dot-path 摊平（数组算叶子）、yaml 缺席时 patch 层为 `null`、config 层读取、状态翻转 |
| `test/settings-catalog-api.test.mjs` | 7 | 路由唯一且只 GET、元信息形状、不泄露密钥值、configured/default 实测、来源不可用时如实报、空查询+limit、中文别名命中+深链、无 viewer 时 `denied` |

### 7.2 顺手修掉的两条过期断言（不是为了让测试变绿而改）

- `smoke-client.mjs` 的 `tabs.length < 3`：设置组只有 2 个 tab（设置/运行状态），一条通判套两组必然假红。改成逐组下限 `{记忆与档案: 5, 设置: 2}`。
- `smoke-client.mjs` 的「聊天缺少 layout 服务时要提示宿主导航」：NAV 里已经没有 `native` 项（`chat` 由 `pages-chat-settings.js` 注册），那条 `P.toastOnce` 路径**不可达**。改成验当前真实契约：页面片段能构建、能渲染「聊天设置」、有页名。

## 8. 每个失败都注明性质

- 冒烟剩余的 13 项**全部集中在媒体页**（provider 列表、识图开关、Index-TTS/NAI 卡、协议选择器、预览按钮、草稿放弃按钮、清除后保存按钮）。G0 已记录这是「媒体页 fixture 与页面期望漂移」，属于 W5 的既有基线噪声。
- 其中「P3 协议 select 没有 `id`（label 关联不到）」是**真实无障碍缺陷**（不是 fixture 问题），已留在失败列表里，不掩盖。
- 静态卫生唯一失败是 HEAD 上就存在的 `tools/lib/host-temp.test.mjs` 测试夹具，本轮没碰该文件。

## 9. 与 W1 验收条件的对照

| W1 验收条件（计划 §3） | 状态 | 依据 |
|---|---|---|
| 关键 QQ 配置字段在 UI 可找到并能读回 | **部分** | 288 个 QQ 字段**全部进目录且可搜到**（含 7 个 secret 的"是否已设置"）；但只有 111 个已投影到 Studio 的可写表单，其余 177 个目前只索引不代改（W4 覆盖率矩阵的待办） |
| 同一字段只出现一个主要写表单 | ✓ | `npm run check:catalog` 三份一致 + 客户端 path == 服务端拼接 path |
| 搜索结果深链到具体设置项并聚焦输入控件 | ✓（Studio 侧） | `data-field-path` 锚点 + `focusSetting()`；冒烟断言锚点存在 |
| 过滤 secret 原值，只标识"已配置" | ✓ | 目录只出 `secret-set`/`secret-unset`；API 用例断言整包不含测试密钥字样；密钥"有没有"走既有 `secretsFlag` 权威 |
| 按权限与能力状态隐藏不可操作项或展示原因 | ✓ | `permission`/`available`/`status` 三键逐条渲染；`permission=host` 显式标「宿主权限」 |
| 分组、标签、状态可筛选；保存后显示四种状态 | **部分** | 结果按 `category` 分组；保存后的四态由既有 `restart-status` + `RestartNotice` 提供（G0 §5.4 记录「应用失败」态仍缺） |
| 搜索支持键盘与屏幕阅读器 | ✓ | ↑↓/Enter/Esc、`aria-activedescendant`、`role=listbox/option`、焦点环、减少动画偏好 |
| 空结果、模块未装载、配置只读、待重启均有明确状态 | ✓ | 空结果列 `catalog.sources` 原因；`unavailable` 逐条标注；待重启由既有全局横幅 |
| 清除重复导航项但保留原 URL/hash 短兼容映射（W1-6） | **未做** | 本包本来没有 hash 路由（G0 §3.5 实测 `location.hash/pushState` 命中数 0），W1-6 的"保留原 URL"没有对象；实际要做的是 localStorage id 映射，留给下一轮导航去重时一起做 |

## 10. 证据等级

| 结论 | 级别 | 说明 |
|---|---|---|
| 目录投影、搜索排序、状态推导 | `offline-test` | 193 用例全绿，含真 SQLite 引擎的 API 用例 |
| 三份目录一致 | `offline-test` | `check:catalog` 独立进程核对源码文本 |
| 客户端面板可渲染、键盘可用、深链聚焦 | `offline-test`（沙箱内 React 渲染） | `smoke-client.mjs` 4 条新增断言 |
| 真实宿主装载 / 浏览器实机 / 屏幕阅读器实测 | **未执行** | 属 W5 与隔离宿主验收 |
| 8790 关停、W4 覆盖率矩阵 | **未执行** | 属 W4 |

**未执行项清单（不得当成已做）：真实宿主加载、浏览器实机与屏幕阅读器、QQ 原生后台字段的实际可写入验证、8790 listener 关闭、任何真实模型调用或外发。**
