# 衣柜昼夜状态化升级 —— 实施与验收报告

分支：`feat/companion-visual-identity-wardrobe`
开发环境：`<dev-clone>`（独立克隆，**不触碰** `<production-clone>`）
基线：`origin/main` @ `0a545ffb70109eb874d585626bfd1afd99b37f7d`
报告日期：2026-11-10

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 开发基线 | `origin/main`（0a545ff），理由见 §1 |
| 分支 | `feat/companion-visual-identity-wardrobe`（从 origin/main 新建，未合并任何其他分支） |
| 环境隔离 | 独立 clone + `dataDir: data-dev` + profile `companion-dev`；QQ/B站/健康/表情全部关闭；生图只跑 dryRun |
| 衣柜数据结构 | v2（items/outfits/overrides + `contexts` 场景条件），可逆迁移 |
| 睡衣库存 | 完整一套（上衣+睡裤+室内拖鞋），另含 home / outdoor / special 组合 |
| 场景解析 | `everyday/home/sleep/outdoor/special`，纯代码判定，跨午夜正确 |
| 工具 | `companion_wardrobe_detail`（含 `scope=contexts`）、`companion_outfit_set`（`context`/`until`/`clearOverride`）、新增只读 `companion_visual_state` |
| Prompt | 静态 section 只放真实性规则；当前穿着由 `agent/pre-step` 每轮注入一次（≤480 字符） |
| 生图 | 身份 + 当前服装由 `resolveCompanionVisualState()` 自动注入；模型不再自己写衣服 |
| 离线测试 | foundation 206 项、media 162 项、全仓 `npm run verify --only=unit` 9/9 模块通过；`compose` 195 loader 行 |
| 未完成 | 真实计费生图（需操作者授权）。真实宿主注入验收见 `docs/15`（第②阶段）；它发现的三处问题已在第③阶段修复并在真实宿主复验，见 `docs/16-p0-fixes.md` |

---

## 1. 开发基线选择

远端实际分支（`gh api repos/<owner>/dsh-companion/branches`）：

| 分支 | HEAD | 与 main 的关系 |
|---|---|---|
| `main` | `0a545ff` | — |
| `dev` | `2bf2fc3` | 落后 main 32 个提交，无独有提交 |
| `expressions` | `1c5007e` | 落后 29，独有 1 个（`git cherry` 显示为 `-`，即已被 main 以不同 SHA 吸收） |
| `feat/group-social-p0` | `9e3f319` | 落后 1，独有 23 |
| `feat/prompt-engine` | `2e933fe` | 落后 1，独有 1 |

选择 **`origin/main`** 作为基线，理由：

1. **`dev` 不是更新的开发线**：它落后 main 32 个提交且没有独有内容，等于旧的快照。
2. **`feat/prompt-engine` 与本次改造有直接接口重叠**：它改的正是
   `plugins/companion-foundation/index.mjs` 的 `agent/pre-step` 注入链（新增 `promptEngine.snapshot()`
   与 `companion-prompt-profile` 段落）。本分支同样改这个 hook，但改动点在「care 段落之后、
   拼装 `sections` 之前」，与该分支互不覆盖；两者都需要，但不能同时盲合（会出现一次
   rebase 冲突，冲突点已定位在 `injectedWithCare`/`finalInjected` 附近）。
   → **本次不合并该分支**，只在报告里登记为「已知并行改动」。
3. **`feat/group-social-p0` 与本次无功能重叠**：它给 foundation 加的是群聊记忆/人格/镜像
   （`group-memory.mjs`、`group-persona.mjs`、`companion-group/*`），不改衣柜、媒体、
   也不改 `agent/pre-step` 的衣柜段落。它的 23 个提交与本次不构成依赖。
4. **`expressions` 的内容已在 main 里**（cherry 标记为已吸收），无需再基于它。

因此本次基于 main 建单分支；`feat/prompt-engine` 的 rebase 顺序建议在其后（见 §9 风险）。

---

## 2. 环境隔离检查

| 检查项 | 做法 | 结果 |
|---|---|---|
| 生产目录不受影响 | 全部改动只在 `<dev-clone>`；从未写入 `<production-clone>` | ✓（`git -C <production-parent>` 未产生新提交或文件） |
| 独立数据目录 | `config/suite.json` → `"dataDir": "data-dev"` | ✓ data-dev 被 `.gitignore` 的 `home/`、`logs/` 等规则覆盖（`git check-ignore` 逐条验证） |
| 独立 DSH profile | `dsh.profile = "companion-dev"`，`npm run setup` 新建 `data-dev/home/profiles/companion-dev` | ✓ doctor「profile 合成 316 个条目」 |
| 不复用生产数据库/会话/记忆 | `data-dev` 下全新目录；无任何 生产 数据被读取 | ✓ |
| 不连生产 QQ | `modules.qq=false`、`services.onebot.url=""` | ✓ doctor：「QQ 通道 — 未启用」 |
| 生图不触发计费 | `safety.billingApis=false`、`media` 模块已挂载但 `image.enabled=false`、所有生图验证走 `dryRun` | ✓ 见 §6 |
| 不自动外发 | `safety.autoSend/autoComment/backgroundModelTasks/healthCollection` 全 false | ✓ |
| 端口 | 未启动常驻 host，`verify`/`doctor`/`dump-config` 均不监听端口 | ✓ |

`npm run doctor`：**核心检查通过（注意 0、未就绪 0、共 37 项）**。

---

## 3. 现有系统审计（P0）

### 3.1 衣柜数据如何存储

- 单文件：`<dataRoot>/home/companion/wardrobe.json`（`wardrobe.mjs:33`）。
- v1 形状：`{version:1, tendency, items:[{id,slot,name,description,tags}], current:{date,itemIds,instruction,updatedAt}}`。
- **本机没有生产衣柜文件**：`<production-clone>/data/home/companion/wardrobe.json` 不存在，全盘 `Get-ChildItem -Filter wardrobe.json` 无命中。
  → 生产环境一直跑的是**内置默认 11 件衣物**，从未落盘。

### 3.2 五个槽位如何组合

`upper/lower/whole/feet/extra` 各挑一件（`currentOutfit` 按槽位轮换），没有「整套」概念，也没有「这套属于什么场景」。

### 3.3 日期确定性轮换算法

```js
seed = `${date}|${slot}|${tendency}`   // date = 当地日期（Intl en-CA）
index = sha256(seed).readUInt32BE(0) % candidates.length
```

同一天同一槽位恒定；**不含 persona**，所以不同人格会得到相同结果。

### 3.4 显式覆盖的有效期与优先级

- `setOutfit` 写 `current = {date, itemIds, instruction}`；
- 读取时仅当 `current.date === 今天` 才生效（`wardrobe.mjs:106`）；
- 优先级只有两档：`explicit` > `daily`。没有 `until`，没有场景，没有「白天覆盖不能挡住夜间」的概念。

### 3.5 是否已有衣柜与日程联动

**没有。** `wardrobe.mjs` 全文没有 `hour`/`activity`/`context`/`schedule` 任何字样；`companion:wardrobe` section 只调用 `renderWardrobePrompt(root, Date.now())`，
而该函数只用到日期。日程（`companion_schedule_*`）与 P2 计划完全不知道衣柜的存在。

### 3.6 衣柜快照在哪个阶段注入

**静态 System Prompt section**（`index.mjs:195-202`，`name: 'companion:wardrobe'`, `order: 63`），
文本在 section 渲染时计算 —— 不是 `agent/pre-step`。`agent/pre-step` 目前注入的是
identity / memory / working-memory / pulse / care 五段，**没有衣柜**。

### 3.7 媒体插件如何获取当前服装

`companion-media/src/service.mjs:324` 调 `wardrobeDetail(dataDir, {scope:'today'})`，然后
**要求模型自己在 `outfit` 参数里写英文衣物**（缺了就拒绝）。也就是说：
服装事实由衣柜提供，但**进图的文本由模型重写一遍** —— 这正是「生图与衣柜不一致」的机制性原因。

### 3.8 历史验收 `logs/wardrobe-schedule-20261031/` 的真实证据

读了 `README.md` + `evidence.json`：

- 证据等级：**只到「prompt 注入 + 两个工具存在 + 当日若干测试通过」**；
- `source` 里的 sha256 与当前树逐字节比对：
  - `wardrobe.mjs` → `1dfd5fc5afc123a0a2ffa3361b0831348f5267b33b8e8df9bd9d7d06396a29f5` — **完全一致**；
  - `wardrobe.test.mjs` → `917e762316019cbc932e1bc4d4aa8c04f23761b76b59d0379788beb2f3206713` — **完全一致**；
  - `planner.mjs`、`index.mjs` — 不同（后续提交改过）。
- 结论：该记录证明的是**当年那份衣柜代码确实在生产里跑过**，但**没有**证明任何昼夜/场景能力，
  因为那份代码里根本没有这些能力。本报告不把它当作已实现能力的依据。

### 3.9 保留 / 扩展 / 修改清单

| 模块 | 处置 | 说明 |
|---|---|---|
| `wardrobe.mjs` 五槽位 + 日期确定性 | **保留** | `selectOutfitForContext` 仍用 SHA-256 + 当地日期，只是种子加上 persona 与场景 |
| `wardrobe.mjs` 的 `current` 单槽覆盖 | **扩展为** `overrides[]`（带 `until`/`context`） | `current` 仍被读取（`legacyOverrides`），迁移时原样保留 |
| `companion_wardrobe_detail` / `companion_outfit_set` | **扩展签名，不新建重复工具** | 旧字段全部保留 |
| `companion:wardrobe` static section | **改成**极短规则 + 真实内容移到 `agent/pre-step` | 消除双重注入 |
| `agent/pre-step` | **扩展**（第 6 段 `companion-wardrobe`） | 复用现成快照拼装，不加模型调用 |
| Media `generateImage(subject=companion)` | **改注入来源** | 从「模型写 outfit」改为「resolver 自动注入」 |
| Visual Identity | **新建** | 全仓 0 命中，属缺失能力 |
| Service Bridge | **不新增端口** | 说明见 §7 |

---

## 4. 数据结构与迁移（P1）

合同：`plugins/companion-foundation/WARDROBE-STATE-CONTRACT.md`（接口权威，实现按它写）。

新增文件：

| 文件 | 职责 |
|---|---|
| `wardrobe-schema.mjs` | v2 形状、种子库存、v1→v2 纯函数迁移、人格文件定位 |
| `wardrobe-context.mjs` | 时钟 + 生活场景分类（纯函数，可配置） |
| `wardrobe-state.mjs` | 优先级解析、快照渲染、英文服装串、按场景可用性报告 |
| `wardrobe-evidence.mjs` | 「现在在发生什么」——只读 runtime，计划不等于已发生 |
| `visual-identity.mjs` | 视觉身份 + `resolveCompanionVisualState()` |
| `wardrobe.mjs` | 兼容门面 + 两条写路径（setOutfit / clearOverride） |

### 4.1 v2 形状（节选）

```json
{
  "schemaVersion": 2,
  "ownerPersona": "bot",
  "items": [{ "id": "sleep-top-001", "slot": "upper", "contexts": ["sleep"],
              "name": {"zh":"…","en":"…"}, "description": {"zh":"…","en":"…"},
              "season": ["all"], "enabled": true,
              "provenance": { "source": "seeded-default", "seedRevision": "2026-11-10.1" } }],
  "outfits": [{ "id": "sleepwear-default", "context": "sleep",
                "pieces": {"upper":"sleep-top-001","lower":"sleep-bottom-001","whole":null,"feet":"sleep-feet-001","extra":null},
                "enabled": true, "provenance": {...} }],
  "overrides": [{ "id":"ovr_…","context":"home","pieces":{...},"instruction":"…",
                  "createdAt":1794000000000,"until":1794086400000,"source":"companion_outfit_set" }],
  "current": null
}
```

### 4.2 迁移（可逆）

`migrateWardrobeV1()` 是**纯函数**：只**增加** `schemaVersion/contexts/outfits/overrides`，
v1 的 `version`、`items[].name`、`items[].description`、`current` 全部原样保留。

`commitMigration()` 是唯一的落盘迁移入口，行为：

1. 先把原文件**逐字节**复制到 `wardrobe.json.v1.bak`；
2. 再写 v2；
3. 已是 v2 时返回 `already-v2` 不动文件。

回滚：`Copy-Item home/companion/wardrobe.json.v1.bak home/companion/wardrobe.json -Force`。
测试 `旧版 v1 衣柜可以迁移，并且可以回滚` 断言备份与原文逐字节相等、回滚后仍按 v1 正确读取。

**不从扁平清单臆造组合**：v1 只有一堆单品，没有「这三件是一套」的信息，
迁移后 `outfits: []`，解析器会明确报 `no-outfits-for-context`，而不是猜一套。
唯一的一条推断是 `contexts: ["everyday"]`（v1 没有任何场景概念，只支持「日常轮换」这一种用法）。

### 4.3 人格隔离

```
<dataRoot>/home/companion/wardrobe.json              ← ownerPersona 的衣柜
<dataRoot>/home/companion/wardrobe.<personaId>.json  ← 其他人格
```

- `ownerPersona` 缺失（v1 文件）→ 认作当前人格；
- 其他人格没有自己的文件 → `wardrobe-missing-for-persona`，**不回落**；
- `qq-group-*` 会话 → `wardrobe-unavailable-in-group`，工具与写入都拒绝。

### 4.4 睡衣库存

| id | 槽位 | 场景 | 中文 | English（生图权威文本） |
|---|---|---|---|---|
| `sleep-top-001` | upper | sleep | 浅蓝色柔软棉质长袖睡衣上衣，白色滚边，少量浅粉色装饰 | A relaxed pale blue cotton pajama top with white piping and a little pale pink trim |
| `sleep-bottom-001` | lower | sleep | 与上衣同色系的宽松睡裤，裤脚是白色滚边 | Loose pale blue pajama bottoms that match the top, with white piping at the ankle |
| `sleep-feet-001` | feet | sleep | 床边的一双软底棉拖鞋，躺下休息时可以不穿 | A pair of soft cotton slippers kept by the bed; not worn when she lies down |

组合 `sleepwear-default = {upper, lower, feet}`，`whole`/`extra` 为 `null`：
**没有相机挂绳、没有外出鞋、没有围巾**（测试 `种子衣物带来源标记…` 用正则断言）。
另预留（未建）：睡衣 B（夏季短袖短裤）、睡衣 C（冬季保暖）——本阶段至少一套可用，已达成。

所有种子条目 `provenance.source = "seeded-default"` + `seedRevision`：
它们是这个版本自带的衣服，不是「她一直有的东西」，也**不写入**任何用户事实/健康/睡眠记忆。

---

## 5. 状态转换与优先级（P2/P3）

### 5.1 判定顺序（`classifyContext`，纯函数）

1. 本轮显式场景 → 该场景（`explicit-turn`）
2. 正在发生的活动/日程命中 special 关键词 → `special`
3. 命中 outdoor 关键词 → `outdoor`
4. 命中 sleep 关键词 → `sleep`
5. 夜间窗口内 → `sleep`（`night-window`）
6. 当地时刻 ≥ `eveningFrom`（默认 19:00）→ `home`（`evening-home`）
7. 正在进行的活动属于室内类（read/write/explore/bilibili）→ `home`
8. 否则 → `everyday`（`daytime-everyday`）

默认夜间窗口 `22:30–07:00`，`start > end` 时按 `[start,24:00) ∪ [00:00,end)` 处理（跨午夜）。
窗口、时区、关键词都可由 `home/companion/wardrobe.config.json` 覆盖；文件缺失时用内置默认，**只读不改写**。

### 5.2 优先级（`resolveWardrobeState`）

1. 本轮明确要求（`explicit`）
2. 未过期且适用于当前场景的覆盖
3. 正在发生的活动/日程
4. 昼夜窗口
5. 该场景的日期确定性轮换
6. 该场景默认组合

### 5.3 「白天覆盖不挡睡衣」的确切规则

`overrideAppliesTo(override, autoContext)`：

- 白天场景标签的覆盖：白天场景之间互相适用；自动场景是 `sleep` 时**不适用**；
- `sleep` 标签的覆盖：只适用于 `sleep`；
- 无标签（`any`）覆盖：处处适用，**例外**是夜间 + v1 `current` 遗留镜像（那个镜像只描述过白天轮换）。

测试：`白天居家覆盖不会无条件挡住夜间睡衣`（14:00 覆盖 → 15:00 生效 → 22:40 自动睡衣）。
`「上一轮说要出门」不会延续到下一轮`：turn1 显式 outdoor，turn2 无显式 → 回到 everyday。

### 5.4 计划 ≠ 已发生

`wardrobe-evidence.mjs#collectLifeEvidence`：

- 只接受窗口包含 `now` 且状态**非终结**的条目；终结集含 `done/completed/finished/skipped/cancelled/expired/failed/superseded/dispatched/abandoned`；
- P2 活动直接读 `p2_activities` 的**运行中/暂停**行；
- P2 计划槽位只有 `started`（或非 planned 且窗口包含 now）才算，`planned` 明确不算；
- H1 日程 occurrence 要窗口包含 now 且 `status` 不是 `dispatched/skipped/cancelled/expired`；
- runtime 缺失 / 抛异常 / 返回 Promise → 空证据 + 原因码，**永不抛进聊天轮**。

测试：`计划不等于已发生…`、`activeEntry 拒绝缺窗口与终结状态`、`没有 runtime…都不抛出去`。

**一个必须说明的既有行为**：日程证据用的是与 `companion_schedule_today` 同一个 runtime 读接口
（`todaySchedule`）。当本进程是活跃写者时，那个接口会先把尚未生成的 occurrence **物化**
（`materializeAgendaScope`，受 `agenda.maxGeneratePerCall` 限制、按 slot key 幂等）。这是 runtime
长期以来的行为，不是本次引入的；它不派发、不发送、不推进任何状态，衣柜只读 `status`。
`npm run doctor` 在此环境里把 agenda 报为未启用，所以这条路径在实际运行中通常直接返回
`enabled:false`——本次没有对它做任何改动。

### 5.5 睡衣 ≠ 睡着

快照末尾固定一句：「穿着睡衣只说明换了睡衣，不代表已经睡着，也不要据此推断睡眠时长。」
测试 `睡衣状态不代表睡着` 断言该句存在。整个改造不写任何睡眠数据。

---

## 6. 工具 / Prompt / 生图（P3/P4）

### 6.1 `companion_wardrobe_detail`

- `scope=today`（默认）：**当前有效服装**，旧字段 `ok/scope/date/source/instruction/items/text` 全部保留，
  新增 `context/contextLabel/outfitId/reason/reasons/override/isOverride/missing/pieces/rotationKey/resolver/seeded/migratedFrom`；
- `scope=slot` / `scope=all`：语义不变（all 仍列全库存）；
- `scope=contexts`（新）：五个场景各自 `ok/code/outfitId/missing`，缺睡衣时可如实回答；
- 可选 `context` 参数：仅在用户明确问别的场景时传。

失败时返回 `ok:false` + `code` + `hint`（例如 `no-outfits-for-context`「当前场景还没有配好的服装组合；不要编造这一套衣服。」），
**不静默回退**到别的场景。

### 6.2 `companion_outfit_set`

旧调用（只给 `itemIds`/`instruction`）语义不变：当日有效的覆盖。
新增 `context`（场景标签）、`until`（`YYYY-MM-DD` / ISO / Unix ms，缺省当地当天 23:59:59.999）、`clearOverride`。
- `until` 无法解析或已过期 → `ok:false, code:'bad-until'`，**不写盘**；
- `itemIds` 一件都不命中 → `item-not-found`，不写盘；
- 群聊 → 拒绝。

### 6.3 Prompt 注入

- `companion:wardrobe` 静态 section 现在只有一条规则（`renderWardrobeConstraint()`），
  不含任何衣物、不含「今天穿」；
- `agent/pre-step`（step 1，复用现成快照拼装）追加第 6 段 `companion-wardrobe`，
  内容形如：

```
【当前穿着】
场景：睡衣
- 上装：浅蓝色柔软棉质长袖睡衣上衣，白色滚边，少量浅粉色装饰。
- 下装：与上衣同色系的宽松睡裤，裤脚是白色滚边。
- 鞋袜：床边的一双软底棉拖鞋，躺下休息时可以不穿。
状态来源：衣柜自动解析（night-window）
这是现在真实穿着的衣物；被问到穿着时按这里回答。穿着睡衣只说明换了睡衣，不代表已经睡着，也不要据此推断睡眠时长。
```

约束：≤480 字符；每轮最多一次；无可靠快照时输出「当前穿着无法确定（<code>）；……不要编造」；
与工具返回同源（同一个 `resolveWardrobeState`）。
测试 `静态 wardrobe section 只是一条规则…`、`当前穿着快照每轮注入一次，并且与工具返回一致`、
`三轮对话里服装稳定，不会每轮随机`、`夜间窗口开启时…`。

### 6.4 生图（Visual Identity + Media Layer）

- `visual-identity.mjs`：`<dataRoot>/home/companion/visual-identity.json`，
  按 `personas.<personaId>` 存 `name/source/appearance`（zh+en）+ `provenance`；缺失/不完整 → `not-configured`，**不编造**；
- `resolveCompanionVisualState()`：一次只读调用同时返回身份与当前服装，均以当前 persona 为键；
- `companion_media_draw(subject=companion)`：自动拼 `identityClause` + `The companion wears <英文服装串>.`，
  模型只写场景/动作/表情/镜头/光线/画风；`outfit` 仍接受（英文）并标记 `outfitSource:'explicit-arg'`；
- 衣柜里没有英文描述、或身份未配置 → 真跑**拒绝**并说明缺什么；`dryRun` 报告 `visualRequired`；
- `subject=other` / 空 subject：行为不变。

`dryRun` 现在返回 `visual` 块（`personaId/identity/context/outfitId/reason/isOverride/pieces/missing/outfitSource/injectedClause`），
可以零计费核对「这一次会注入什么」。

### 6.5 跨插件边界

媒体层 import 一个**纯函数**（不写文件、不发请求、不返回句柄、不暴露目录）。
没有新增 Service Bridge 名字：`companion-media` 本来就持有 `dataDir`，这次只是把「自己按 v1 逻辑读 wardrobe.json」
换成「调用权威解析器」，读的范围反而更窄（按 persona 选文件、自己拒绝群聊）。
若将来 Studio 页面等第二个消费者需要同一快照，再按 `service-bridge.mjs` 白名单加只读端口。
详见合同 §6.1。

---

## 7. 测试与验收

### 7.1 衣柜基础（§11.1 全部覆盖）

| 测试 | 结果 |
|---|---|
| 白天普通活动 → everyday | ✓ `白天普通活动 → everyday；白天居家 → home` |
| 白天居家 → home | ✓ 同上 |
| 22:40 自动 sleep | ✓ `22:20…22:40…02:00…06:50…07:10` 表驱动 |
| 02:00 保持 sleep | ✓ 同上 |
| 06:50 保持 sleep | ✓ 同上 |
| 07:10 按生活状态恢复 | ✓（无活动→everyday；室内活动→home） |
| 深夜外出 → outdoor | ✓ `深夜有明确外出安排 → outdoor 覆盖睡衣`（显式 + 日程两种来源） |
| 明确要求换睡衣 → 立即切换 | ✓ `明确要求换睡衣 → 立即切换` |
| 显式覆盖未过期 → 保持 | ✓ `显式覆盖未过期 → 保持覆盖；过期 → 恢复自动解析` |
| 显式覆盖过期 → 自动 | ✓ 同上（并断言过期行保留可审计） |
| 同一天重复 → 一致 | ✓ `同一天同一场景重复请求 → 服装一致` |
| 跨午夜日期与场景正确 | ✓ `跨午夜：日期与场景都正确`（含 22:29/07:00 边界） |

### 7.2 数据隔离（§11.2）

| 测试 | 结果 |
|---|---|
| 不同 persona 不共享 | ✓ `不同 Persona 不共享服装；缺文件时明确报缺失` + `轮换种子包含人格` |
| 群聊不读私聊衣柜 | ✓ `群聊不读取私聊衣柜` + `群聊会话里不注入私聊衣柜的具体衣物`（mount 级） |
| persona 切换后不残留 | ✓ 身份 `persona` 校验 + resolver 按 persona 选文件 |
| 旧数据能迁移 | ✓ `旧版 v1 衣柜可以迁移，并且可以回滚` |
| 缺睡衣明确报错 | ✓ `缺睡衣时明确报告，不伪造已有衣物` |

### 7.3 Prompt（§11.3）

| 测试 | 结果 |
|---|---|
| 当前穿着与工具一致 | ✓ mount 测试逐字段比对 |
| 不重复注入衣服 | ✓ 静态 section 断言无衣物；mount 断言快照只在 step 1 |
| 只注入当前场景 | ✓ 睡衣场景断言不含常服名 |
| 动态快照不重复 | ✓ step 2 `messages.length === 1` |
| Prompt 不超预算 | ✓ 断言 ≤480 字符；总注入仍受既有 2400 预算约束（未改动该预算） |
| 旧静态规则不冲突 | ✓ 旧 `今天穿` 文案已从 section 移除并断言不存在 |

### 7.4 生图（§11.4，全部 dryRun，零计费）

| 测试 | 结果 |
|---|---|
| companion 生图含身份 | ✓ `official queue injects the resolved outfit automatically…` |
| companion 生图含当前场景服装 | ✓ 同上（`blue knitted cardigan` 进 caption） |
| 不重复注入服装 | ✓ 只注入一次 `The companion wears …` |
| 深夜用睡衣 | ✓ `生图串随昼夜变化：深夜睡衣、白天常服、夜间外出外出服` |
| 白天用日常服 | ✓ 同上 |
| 夜间外出用外出服 | ✓ 同上 |
| other 不注入 | ✓ `subject` 非 companion 走原路径（未改动，既有测试覆盖） |
| 缺英文衣物 → 拒绝 | ✓ `companion 生图在衣柜里没有英文描述时明确拒绝，不编造衣服` |

### 7.5 汇总

```
foundation  : 201 passed      （第③阶段后：206 —— 新增 P0-B 预设回归 5 项）
media       : 141 passed      （第③阶段后：162 —— 新增 P0-A 门槛 13 项 + P0-C 数据根 8 项）
npm run verify --only=unit   : 9/9 模块通过（paste-search 无测试，如实报告）
npm run verify --only=compose: dsh --dump-config → 195 loader 行
npm run doctor              : 核心检查通过（注意 0、未就绪 0，共 37 项）
```

`static` 组有 **1 项失败，且不是本次引入**：`author-name — README.md:197`
（仓库 README 里的克隆地址带作者账号名，命中作者名规则）。
已用干净 worktree 验证该行在 `origin/main` 上完全一致，本分支未修改 `README.md`。
留待维护者决定（把克隆地址改成占位符，或在规则里为该行加一条 `leak-scan-allow`）。

### 7.6 顺带修复的一个真实缺陷

`scripts/verify.mjs` 的 compose 检查组把 `DSH_HOME` 硬编码为 `<suite>/data/home`，
忽略了 `config/suite.json` 的 `dataDir`。后果：任何把数据放到别处（本任务的 `data-dev`，
以及文档里建议的「数据放另一个盘」）的安装，`npm run verify` 都会以 exit 1 失败，
而失败原因是「profile 不存在」而不是被检查的代码有问题。
已改为 `dataPaths.home`（与已有的「数据目录解析一致」检查同一规则），修复后 compose 通过。

### 7.7 零计费验收抓包（本次真实产物）

```powershell
node scripts/wardrobe-acceptance.mjs --root <dataRoot> --out <dataRoot>\logs\wardrobe-v2-<date>
```

它在**同一个本地日期**上用**同一条英文 prompt**（`She sits on the bed with a book.`）跑两次
`companion_media_draw(subject=companion, dryRun=true)`，并打印解析器给出的时钟表。关键输出：

```
14:00 context      = everyday
14:00 injected     = A soft white hoodie with a slightly worn cuff, Straight white casual trousers …, White low-top sneakers …, A dark thin strap holding a small everyday camera
22:40 context      = sleep
22:40 injected     = A relaxed pale blue cotton pajama top with white piping and a little pale pink trim, Loose pale blue pajama bottoms …, A pair of soft cotton slippers kept by the bed; not worn when she lies down
other.visual       = null
networkAttempted   = (none — dryRun only)
same prompt, different clothes: YES
```

时钟表（同一份种子衣柜，Asia/Shanghai）：

| 时刻 | 场景 | 原因 | outfitId |
|---|---|---|---|
| 14:00 | everyday | daytime-everyday | everyday-default |
| 19:30 | home | evening-home | home-default |
| 22:20 | home | evening-home | home-default |
| 22:40 | sleep | night-window | sleepwear-default |
| 02:00（次日） | sleep | night-window | sleepwear-default |
| 06:50（次日） | sleep | night-window | sleepwear-default |
| 07:10 | everyday | daytime-everyday | everyday-default |
| 23:10 + 正在发生的外出活动 | outdoor | activity-outdoor | outdoor-default |
| 14:00 + 未来的外出计划 | everyday | daytime-everyday | everyday-default（**计划不生效**） |

五个场景在 14:00 全部可解析（`everyday/home/sleep/outdoor/special` 各 `ok=true`）。
抓包脚本内部的 `fetchImpl` 会在任何网络请求发生前抛错并把它记进证据，因此**不可能**产生一次计费调用；
产物写在数据目录的 `logs/` 下（gitignore），并带六个模块的源码 sha256，便于日后核对是哪一版代码跑出来的。

---

## 8. 文件清单

### 8.1 新增

| 文件 | 行数级别 | 作用 |
|---|---|---|
| `plugins/companion-foundation/WARDROBE-STATE-CONTRACT.md` | 合同 | 接口权威（数据结构、优先级、工具、注入、视觉状态） |
| `plugins/companion-foundation/wardrobe-schema.mjs` | ~430 | v2 形状 / 种子 / 迁移 / 人格文件 |
| `plugins/companion-foundation/wardrobe-context.mjs` | ~200 | 时钟与场景分类 |
| `plugins/companion-foundation/wardrobe-state.mjs` | ~350 | 优先级解析 / 快照 / 英文串 / 场景报告 |
| `plugins/companion-foundation/wardrobe-evidence.mjs` | ~150 | runtime 证据（计划≠发生） |
| `plugins/companion-foundation/visual-identity.mjs` | ~240 | 视觉身份 + `resolveCompanionVisualState` |
| `plugins/companion-foundation/wardrobe-state.test.mjs` | 25 项 | §11.1/§11.2 全表 |
| `plugins/companion-foundation/wardrobe-evidence.test.mjs` | 7 项 | 计划≠发生 |
| `plugins/companion-foundation/visual-identity.test.mjs` | 10 项 | 身份缺失/隔离/生图串 |
| `plugins/companion-foundation/wardrobe-mount.test.mjs` | 7 项 | 宿主边界（section / 注入 / 工具一致） |
| `scripts/wardrobe-acceptance.mjs` | ~200 | 零计费验收抓包：时钟表 + 场景可用性 + `dryRun` 的 `visual` 块 + 源码 sha256；内部 `fetchImpl` 拒绝任何网络请求 |
| `docs/14-wardrobe-state-upgrade.md` | 报告 | 本文件（实施与验收报告） |

### 8.2 修改

| 文件 | 改动 |
|---|---|
| `plugins/companion-foundation/wardrobe.mjs` | v1 → 兼容门面：`loadWardrobe`/`saveWardrobe`/`currentOutfit`/`renderWardrobePrompt` 保留；`wardrobeDetail`/`setOutfit` 扩展；新增 `renderWardrobeConstraint`/`upgradeWardrobeFile`；`currentOutfit` 种子加 persona+场景 |
| `plugins/companion-foundation/index.mjs` | 静态 section 改规则；`agent/pre-step` 新增 `companion-wardrobe` 段；两个衣柜工具扩展；新增 `companion_visual_state` |
| `plugins/companion-foundation/package.json` | 导出新增 5 个模块 + 合同 md；`files` 加 `*.md` |
| `plugins/companion-media/src/service.mjs` | `subject=companion` 改用 `resolveCompanionVisualState`；`dryRun` 增加 `visual` 块；返回体记录 `visual` |
| `plugins/companion-media/index.mjs` | `companion_media_draw` 描述与参数说明更新（模型不再写衣服） |
| `plugins/companion-media/test/image-nai.test.mjs` | 覆盖注入用例重写 + 新增「缺英文衣物拒绝」用例 |
| `plugins/companion-media/CONTRACT.md`、`TOOL_GUIDE.md` | 合同与用法同步 |
| `scripts/verify.mjs` | compose 的 `DSH_HOME` 改用配置的 `dataPaths.home`（否则 `dataDir` 不是 `data/` 的安装永远红） |
| `docs/07-verification-status.md` | 新增 §2.8 登记本次证据（**纯新增**，23 行，无删除行） |

### 8.3 未纳入版本控制（本地开发环境，已被 gitignore 覆盖）

`config/suite.json`、`config/persona.md`、`config/profile/companion.patch.yml`、`data-dev/**`。

---

## 9. 未完成事项与风险

| # | 事项 | 等级 | 说明 |
|---|---|---|---|
| 1 | 真实计费生图验收 | 需操作者授权 | 全部验证为 dryRun；真实一张需显式授权 |
| 2 | ~~真实运行时抓包（对话里实际注入的 prompt 正文）~~ | **第②阶段已完成** | 真实宿主 + `companion-dev` + `data-dev`，`session/create`→`session/prompt` 全流程，抓下完整请求体。结论与证据见 `docs/15-wardrobe-host-acceptance.md` |
| 2.1 | ~~缺视觉身份时的生图拒绝未成立~~ | **第③阶段已修** | `companionPictureGate()` 一处判定，dryRun 与真实调用同源；真实宿主复验拒绝 0 网络命中。13 项回归。见 `docs/16-p0-fixes.md` §1 |
| 2.2 | ~~companion 预设重复声明 `skill`~~ | **第③阶段已修** | 删掉模板里的 `- id: skill`（宿主 plane 已注册该服务）；真实宿主 `session/create` 成功并跑完一轮。5 项回归。见 `docs/16` §2 |
| 2.3 | ~~媒体层数据根不读 `config/suite.json:dataDir`~~ | **第③阶段已修** | `resolveDataDir()` 改为委托 `suite-paths.mjs#resolveDataRoot()`；真实宿主读到 `<dataDir>/media/config.json`。8 项回归。见 `docs/16` §3 |
| 3 | ~~`docs/07` 未登记~~ | 已完成 | 已新增 §2.8（纯新增 23 行，`git diff -U0` 无删除行），把本次证据按五级词汇登记，并如实标注「真实会话注入正文 / 真实计费生图 未验证」 |
| 4 | `feat/prompt-engine` 并行改同一 hook | 中 | 合并顺序建议：先合 prompt-engine，再 rebase 本分支；冲突点已定位在 `injectedWithCare` → `finalInjected` 之间 |
| 5 | `feat/group-social-p0` 给 foundation 加 118 行 | 低 | 与本分支不重叠（群记忆/人格/镜像），但同文件 `index.mjs`，需常规 rebase |
| 6 | `static` 组 `author-name` 1 项失败 | 低 | 既有问题（`README.md:197`），非本次引入，已给出两种修法 |
| 7 | 生产衣柜文件从未存在 | 说明 | 生产一直用内置默认衣物；首次落盘会写种子，带 `seeded-default` 标记 |
| 8 | 季节属性未接入 | 设计如此 | 只存储不参与解析（无验证过的天气数据源） |
| 9 | 睡衣 B/C 未建 | 可接受 | 本阶段至少一套完整睡衣，已达成 |
| 10 | 视觉身份内容需操作者填写 | 说明 | 仓库内没有任何原作/外貌数据，`visual-identity.json` 必须由操作者按自有人格填写；未填时生图会明确拒绝而不是猜 |
| 11 | `data-dev/` 不被 `.gitignore` 的 `data/` 规则覆盖 | 低（已处置） | `.gitignore` 只忽略 `data/`、`home/`、`logs/` 等**名字**，所以 `data-dev/home`、`data-dev/logs` 被忽略，但 `data-dev/media/config.json` 这类路径会出现在 `git status` 里。抓包脚本第一次跑时确实留下过一份合成配置，已删除；脚本现在把媒体配置写到系统临时目录并在结束时清理，`git status -uall -- data-dev` 现为空。若长期保留这个数据目录，建议在 `.gitignore` 里加一行 `data-*/` |
| 12 | `static` 组里 `author-name` 的红与本次无关但会挡住「一条命令全绿」 | 低 | 见 §7.5；这一项不修，`npm run verify` 永远 exit 1，容易让人误以为本次改动有问题 |

### 运行时边界（本次未越界）

- 没有新增定时器、心跳动作、主动消息或模型调用；
- `reminderDelivery` 仍为 `not-wired`（`wardrobe-evidence.mjs` 显式导出该常量并有测试）；
- 衣柜状态在既有 `agent/pre-step` 快照里计算，下一次收到消息 / 查工具 / 生成图片时取当前值；
- 没有写任何用户真实生活、健康、睡眠数据。

---

## 10. 复现命令

```powershell
# 环境
cd <dev-clone>
npm ci
npm run build
npm run doctor
npm run setup

# 衣柜单元与集成
node --test "plugins/companion-foundation/*.test.mjs"
node --test "plugins/companion-media/test/*.test.mjs"

# 全仓离线验证
npm run verify --only=unit
npm run verify --only=static
npm run verify --only=compose

# 迁移某个真实衣柜（可逆，先备份）
node -e "import('./plugins/companion-foundation/wardrobe.mjs').then(m=>console.log(m.upgradeWardrobeFile({root:'<dataRoot>',personaId:'<id>'})))"
```

---

## 11. 交付前状态

- 分支 `feat/companion-visual-identity-wardrobe`，基于 `origin/main` @ `0a545ff`；
- **未 commit、未 push、未合并、未部署**（按执行约束）；
- 未修改 `<production-clone>`、未连接生产 QQ、未触发任何计费调用。
