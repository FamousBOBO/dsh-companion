# 15 — 衣柜 / 视觉身份：真实宿主注入验收

本文件记录**第②阶段（真实宿主注入验收）**的实测结果。它只报告真实宿主上跑出来的事，
不重复 ①阶段（离线判定，见 `docs/14-wardrobe-state-upgrade.md`）的结论。

- 验收时间：2026-11-10 03:50–04:15（Asia/Shanghai）
- 克隆：`<dev-clone>`（分支 `feat/companion-visual-identity-wardrobe`，HEAD `0a545ff`，
  与 `origin/main` 0/0，未 commit、未 push）
- 宿主：DeepSeek Harness 桌面版 `0.2.1-rc.3`，profile `companion-dev`，`DSH_HOME=<dev-clone>/data-dev/home`
- 产物目录：`<dev-clone>/data-dev/logs/wardrobe-host-acceptance/`
  - `record/capture.json`、`record/capture.txt` — 脱敏后的完整记录（System Prompt 正文、动态注入正文、工具返回）
  - `14-00/model-request.json`、`22-40/model-request.json`、`no-identity-dryrun/model-request.json` — 原始抓包
  - `tool-wardrobe-1400.json` — 工具查询那一轮的原始抓包
  - `media-events-repo-data-split.jsonl` — 媒体层数据根错位的证据

---

## 0. 结论先行

| # | 验收点 | 结论 |
|---|---|---|
| 1 | Visual Identity 注册且被正确读取 | ✅ 通过（`identity.state=configured`，正文注入 `identityClause`） |
| 2 | 衣柜在正确的生命周期注入 | ✅ 通过（`agent/pre-step` 首步快照，模型请求里是独立一条 user 消息） |
| 3 | 14:00 注入日常常服 | ✅ 通过（`日常常服` / `daytime-everyday` / `everyday-default`） |
| 4 | 22:40 注入睡衣 | ✅ 通过（`睡衣` / `night-window` / `sleepwear-default`） |
| 5 | 工具查询结果与注入正文一致 | ✅ 通过（同一套衣物、同一 reason、同一 outfitId） |
| 6 | 静态衣柜内容没有被重复注入 | ✅ 通过（静态段只剩规则、不含任何衣物） |
| 7 | Prompt Engine 是否改变衣柜注入 | ⚠️ 本分支不涉及；`feat/prompt-engine` 上需要改一处拼接顺序（见 §7） |
| 8 | personaId 隔离 | ✅ 通过（诱饵衣柜文件没有被读取） |
| 9 | 缺失 Visual Identity → 陪伴生图明确拒绝 | ❌ **本阶段未达预期**：缺身份只会让 dryRun 报 `missing:["identity"]`，真实生图仍会继续（见 §6）→ **第③阶段已修并复验通过**（见 `docs/16-p0-fixes.md` §1） |

**同时发现两个与本轮改动无关、但在 `origin/main` 上就存在的阻塞性缺陷**（§8、§9）：
其一让 companion 预设根本创建不出会话，其二让媒体层读错数据根。两者都已逐字核对
`origin/main`，不是本轮引入。**两者都已在第③阶段修复并在真实宿主上复验**（`docs/16` §2、§3）。

---

## 1. 环境隔离（逐条核对）

| 项 | 设置 | 实测 |
|---|---|---|
| 监听地址 | `--host 127.0.0.1 --port 39311/39312/39313` | 只绑定回环，机器外不可达 |
| LLM 路由 | `http://127.0.0.1:39217/v1`（本地记录器，合成回复） | 请求全部落在本地，抓包即证据 |
| 生图路由 | `http://127.0.0.1:39218`（本地记录器，记录后返回 500） | 只有 1 次命中，见 §6 |
| QQ / B站 / 健康 / 表情包 / 粘贴搜索 | `config/suite.json` 里全部 `false` | 启动日志无相关入口 |
| `billingApis` | `false` | 未改 |
| 生产环境 | 未连接 | `DSH_HOME` 指 `data-dev/home`，profile 是 `companion-dev` |
| 计费生图 | 未发生 | 唯一一次真实请求打到本地记录器并返回 500 |

时钟：衣柜解析读 `Date.now()`，生产代码里没有注入点。为了把真实宿主放到指定本地时间，
本轮用 `NODE_OPTIONS=--import <clock-shim>` 给**进程**加了一个固定偏移（不是冻结），
产品代码一行未改。时钟偏移只影响本进程，其余行为保持生产真实。

---

## 2. 抓包是怎么拿到的

宿主本身没有"导出模型请求"的开关。做法是把 host 的 `llm-pi-ai` 路由指到一个本地
OpenAI 兼容端点上（`data-dev/tmp/probe/capture-llm.mjs`），它把**完整请求体**落盘、
再回一个合成的流式完成。这样拿到的是宿主真正发出去的字节，不是模拟的 Prompt。

会话是真的：`POST /api/session/create`（`agentPreset: "companion"`）→
`POST /api/session/prompt` → 轮询 `session/projections` 至稳定。走的是 Web UI 自己的
`/api` RPC 协议和 `/connect` 令牌换 cookie 的鉴权路径，preset 真正 mount，`agent/pre-step`
真正执行。

抓到的请求体（14:00 与 22:40 结构一致）：

- 模型路由 `probe-model`，`stream: true`
- 工具 **62** 个（companion 预设全量；对比空预设是 25 个）
- 消息角色序列：`system → user → user → user → user → user → user`

那条承载动态注入的 user 消息（14:00）正文：

```
【当前用户身份绑定】…（宿主身份数据）
【当前穿着】
场景：日常常服
- 上装：柔软的白色连帽卫衣，袖口有一点磨毛。
- 下装：白色直筒休闲长裤，裤脚收得干净。
- 鞋袜：白色低帮运动鞋，鞋侧有一道浅蓝线条。
- 配饰：一条深色相机挂绳，挂着随身的小相机。
状态来源：衣柜自动解析（daytime-everyday）
这是现在真实穿着的衣物；被问到穿着时按这里回答。穿着睡衣只说明换了睡衣，不代表已经睡着，也不要据此推断睡眠时长。
```

---

## 3. 字符数与 Token 估算

Token 用保守估算：CJK 约 1 token/字，ASCII 约 4 字符/token（`estimateTokens()` 在
`build-record.mjs` 里，可复核；数值即 `record/capture.json` 中的
`systemPromptTokens` / `snapshotTokens` 字段）。

| 项 | 14:00 | 22:40 |
|---|---|---|
| System Prompt 总字符 | 5677 | 5677 |
| System Prompt ≈tokens | ≈2353 | ≈2353 |
| 其中静态穿着规则段 | 91 字符 | 91 字符 |
| 动态穿着快照字符 | **195** | **181** |
| 动态穿着快照 ≈tokens | **≈172** | **≈163** |
| 整个请求体字节 | 53896 | 53881 |
| 工具数 | 62 | 62 |

对照预算：快照渲染上限 480 字符（实测远低于上限），记忆注入预算 2400 字符未动，
认知段预算 320 字符未动。**衣柜这一项每轮净增约 170 tokens**，且只在首步出现一次。
注意 System Prompt 里 5677 字符的大部分是宿主自带的工具说明（ASCII），不是人格正文，
所以按字符数直接乘 1 会高估。

---

## 4. 与 ①阶段离线上限的一致性

把宿主抓包里那段动态正文，与 ①阶段离线记录（`data-dev/logs/wardrobe-v2-20261110/acceptance.json`）
逐字段比对：

| 时刻 | 离线 | 真实宿主 | 正文逐字节相同 |
|---|---|---|---|
| 14:00 | `everyday` / `daytime-everyday` / 195 字符 | `日常常服` / `daytime-everyday` / 195 字符 | **是** |
| 22:40 | `sleep` / `night-window` / 181 字符 | `睡衣` / `night-window` / 181 字符 | **是** |

即：离线判定给出的正文，就是真实宿主发给模型的正文，一字不差。

与 ①阶段"组合结果"（`wardrobe-acceptance.mjs` 的 dryRun 注入子句）的差异同样为零：
14:00 是卫衣/长裤/运动鞋/相机挂绳，22:40 是睡衣上衣/睡裤/棉拖鞋，与离线 dryRun 报告一致。

---

## 5. 工具查询 vs 注入正文（验收点 5）

在 22:40 让模型调用 `companion_wardrobe_detail {scope:"today"}`，宿主回填的 tool 结果：

```json
{"ok":true,"scope":"today","date":"2026-11-10","context":"sleep","contextLabel":"睡衣",
 "outfitId":"sleepwear-default","reason":"night-window","reasons":["night-window","rotation"],
 "items":[…睡衣上衣/睡裤/棉拖鞋…],"missing":["whole","extra"]}
```

14:00 的同一条工具调用：

```json
{"context":"everyday","contextLabel":"日常常服","outfitId":"everyday-default",
 "reason":"daytime-everyday","reasons":["daytime-everyday","rotation"], …}
```

与注入正文比对（`compare-tool-vs-snapshot.mjs`）：

- 场景：`日常常服` == `日常常服`
- reason：`daytime-everyday` == `daytime-everyday`
- 衣物集合：4 件 == 4 件，逐件相同（唯一差别是工具侧的 description 带句末句号，
  快照渲染时去掉，属排版差异）
- **结论：两条路径由同一个 resolver 供数，不可能给出两套衣服。**

---

## 6. 缺失 Visual Identity 时的生图行为（验收点 9 — 未达预期）

做法：把 `data-dev/home/companion/visual-identity.json` 临时移走，并把生图路由指到
本地记录器（记录后返回 500），然后分别跑 dryRun 与真实调用。

**dryRun（诚实的部分）**

```json
{"ok":true,"dryRun":true,"provider":"nai","wouldSend":"不发起任何网络请求",
 "visual":{"personaId":"bot","identity":"not-configured","name":"","context":"sleep",
 "missing":["identity"], …},
 "preset":{"positive":"She sits on the bed with a book.\nThe companion wears A relaxed pale blue
 cotton pajama top …, Loose pale blue pajama bottoms …, A pair of soft cotton slippers …"}}
```

- `missing: ["identity"]` 如实报出来了
- 注入的 prompt 里**没有**身份子句（只写着装）

**真实调用（问题所在）**

- 没有被拒绝：直接发出 `POST /v1/images/generations` 打到本地记录器，拿到 500 后返回
  `MEDIA_UPSTREAM`
- 记录器命中（`data-dev/tmp/probe/network-hits.log`）：
  `2026-11-09T20:09:26.411Z POST /v1/images/generations`

原因在 `plugins/companion-media/src/service.mjs:358-374`：拒绝条件是**衣物**解析不出来
（`!clothingClause`），身份缺失不在拒绝条件里。于是"缺身份但衣柜正常"会画出一张
只有衣服、没有脸和发色的图——比直接拒绝更糟，因为用户会以为那就是角色本体。

**这条要修**（建议：`visual.missing` 含 `identity` 且没有显式 `outfit`
时，与缺衣物同等拒绝；`dryRun` 的 `visualRequired` 也一并置 `true`）。本轮**未改代码**，
按要求先报告。

> **后续（第③阶段已修）**：`plugins/companion-media/src/service.mjs` 新增唯一闸门
> `companionPictureGate()`，身份缺失 / 损坏 / 结构无效 / 与人格不匹配 / 只有中文外观一律
> 在任何网络请求之前拒绝（`MEDIA_VISUAL_IDENTITY_REQUIRED`），dryRun 与真实调用同源；
> 显式 `outfit` 不再能绕过身份。真实宿主复验：拒绝 0 次网络命中、补上身份后 1 次。
> 回归测试 13 项见 `plugins/companion-media/test/visual-identity-gate.test.mjs`，
> 详细报告见 `docs/16-p0-fixes.md` §1。

---

## 7. Prompt Engine 的影响面（验收点 7）与集成方案

本分支**没有** import `prompt-engine.mjs`，所以本轮抓包里根本没有它的段落 —— 衣柜注入
完全由本分支的 `agent/pre-step` 产生。

`origin/feat/prompt-engine`（HEAD `2e933fe`）在同一个 hook 里做了两件事：

1. 新增 `promptEngine.snapshot()`，产出一段独立的 `companion-prompt-profile` 段落；
2. 把原来的 `injectedWithCare` 改名为 `finalInjected`，并把它拼在 `injectedWithCare` 之后。

**冲突面**恰好就是这一处拼接。三方对照：

| 版本 | 该行 |
|---|---|
| `origin/main` | `injectedWithCare` |
| 本分支 | `injectedWithCare + wardrobeText` → `finalInjected` |
| `feat/prompt-engine` | `injectedWithCare + promptText` → `finalInjected` |

**集成方案（本轮不合并、不覆盖）**

1. 保留双方各自的产物变量：`wardrobeText`（本分支）与 `promptText`（对方）。
2. 拼接顺序按"事实先于风格"：`injectedWithCare → wardrobeText → promptText`。
   衣柜是当前现实，Prompt Engine 是说话风格，风格层不能覆盖事实层。
3. `source.sections` 按同一顺序追加 `companion-wardrobe` 与 `companion-prompt-profile`，
   保持"模型可见 ⟺ 已记录"。
4. `promptEngine.snapshot()` 的入参里**不含** wardrobe（它现在也不含），所以两者没有
   数据依赖，只在这一行有文本顺序依赖。
5. 集成后必须**重新跑一遍本验收**（14:00 / 22:40 各一轮），确认注入正文的字符数与
   内容不变，再补一条"引擎开/关时衣柜正文逐字节相同"的断言。

已确认 `grep wardrobe|衣柜` 在 `feat/prompt-engine` 的 `prompt-modules.mjs` /
`prompt-router.mjs` / `prompt-engine.mjs` 里 0 命中 —— 它不读衣柜，不会与 resolver 抢事实。

---

## 8. 缺陷 A（`origin/main` 已有）：companion 预设重复声明 `skill`，导致会话创建失败

**现象**：`POST /api/session/create {agentPreset:"companion"}` 直接失败：

```
agent-preset/invalid
skill (@deepseek-ai/dsh-skill): service "skills" has been registered at <SkillRegistry>
```

**根因**：`config/profile/companion.patch.template.yml`（`origin/main` L75）在预设的插件
列表里写了 `- id: skill`（即 `skills` 这个 Service）。而 Web 表面把这个 Service 放在
**宿主平面**（`dsh-web-app/cordis.patch.yml` 保留了宿主 `skill` 行，只禁用
`skill-filesystem` / `tool-skill`）。预设再声明一次就是重复注册。

四个自带预设（`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis`）
都只声明 `skill-filesystem` + `tool-skill`，**只有 companion 多了 `skill`**。

**影响**：在真实 Web 宿主上，**companion 预设一个会话都创建不出来**，衣柜、记忆、人格
全都到不了模型。这与本轮改动无关，但会让整个陪伴套件不可用。

**本轮处理**：没有改产品代码。用一个本地验收补丁
（`data-dev/tmp/probe/acceptance-preset-fix.patch.yml`）重新声明 `preset-companion`
并去掉那一行，其余完全一致，才得以继续验收。

**建议修复**：从模板预设里删掉 `- id: skill`。改一行，并在 `verify --only=compose` 里加
一条"预设内不出现 `skill` 注册行"的断言。

> **后续（第③阶段已修）**：模板与生成的 profile 都已删掉该行，原位留下三层分工的注释；
> 真实宿主**不加载任何修复补丁**复验 `session/create` 成功并跑完一轮对话，
> 62 个工具含 `skill`、技能目录完整（读技能文件的能力没丢）。回归测试 5 项见
> `plugins/companion-foundation/preset-compose.test.mjs`，详细报告见 `docs/16-p0-fixes.md` §2。

---

## 9. 缺陷 B（`origin/main` 已有）：媒体层数据根与 foundation 不一致

**现象**：`config/suite.json` 里 `dataDir: "data-dev"`，foundation 正确读到
`<dev-clone>/data-dev`，媒体层却落在 `<dev-clone>/data`：

```json
{"event":"mounted","dataDir":"<dev-clone>\\data","dataDirSource":"suite-root",
 "capabilities":{"image":{"enabled":false,"provider":"none"}}}
```

**根因**：两条独立实现的路径解析。

- `companion-foundation/suite-paths.mjs#resolveDataRoot` 读 `config/suite.json:dataDir`；
- `companion-media/src/persona.mjs#resolveDataDir` 只认 `options.dataDir` →
  `DSH_COMPANION_DATA_DIR` → `<suiteRoot>/data`，**不读 `suite.json`**。

**影响**：只要用户把 `dataDir` 指到 `data/` 之外（本套件文档明确允许，`setup` 也支持），
媒体层的配置、日志、台账就会分叉到另一个目录。用户在自己的
`<dataDir>/media/config.json` 里打开生图，宿主读到的仍是 `<suiteRoot>/data/media/config.json`
（不存在 → 默认关），于是每次都报 `MEDIA_DISABLED`。

**本轮处理**：验收时给 host 显式设 `DSH_COMPANION_DATA_DIR=<dev-clone>/data-dev`，
两个插件才指向同一处。分叉证据留在 `media-events-repo-data-split.jsonl`。

> **后续（第③阶段已修）**：`resolveDataDir()` 不再有第二套实现，改为委托
> `suite-paths.mjs#resolveDataRoot()`，优先级与 CLI / foundation 完全一致（默认 `data/`
> 仍兼容）。真实宿主 `GET /api/companion-media/status` 报
> `dataDir=<dev-clone>/data-dev`、`configFile=<dev-clone>/data-dev/media/config.json`，
> 同时在 `data/media/config.json` 放一份「关闭」诱饵，宿主**没有**读它。
> 回归测试 8 项见 `plugins/companion-media/test/data-root.test.mjs`，
> 详细报告见 `docs/16-p0-fixes.md` §3。

**建议修复**：让 `resolveDataDir` 复用 `suite-paths.mjs#resolveDataRoot` 的解析顺序
（`options.dataDir` → `DSH_COMPANION_DATA_DIR` → `config/suite.json:dataDir` →
`package.json:dsh.suite.dataDir` → `<suiteRoot>/data`），并加一条断言两个模块对同一
`config/suite.json` 给出同一目录。

---

## 10. 其余实测（支撑结论，便于复核）

**personaId 隔离**：写一个属于别人格的诱饵衣柜
`home/companion/wardrobe.someone-else.json`（里面只有一件"诱饵外套"），然后：

| personaId | 解析到的文件 | 结果 |
|---|---|---|
| `bot` | `home/companion/wardrobe.json`（owner） | 卫衣/长裤/运动鞋/相机挂绳 |
| `someone-else` | `home/companion/wardrobe.someone-else.json`（persona-scoped） | 只有"诱饵外套" |
| `nobody` | — | `wardrobe-missing-for-persona` |

`bot` 的衣柜里 `ownerPersona === "bot"`，诱饵项 0 混入。

**退化输入不编造衣物**：

| 输入 | code | 注入正文 |
|---|---|---|
| 衣柜文件损坏 | `wardrobe-unreadable` | `衣柜文件读不出来；不要编造当前穿着。` |
| 无该人格衣柜 | `wardrobe-missing-for-persona` | `这个会话的人格还没有自己的衣柜文件；不要借用别人格的衣物…` |
| QQ 群会话 | `wardrobe-unavailable-in-group` | `群聊里不解析私人衣柜；被问到穿着时不要再具体描述衣物。` |

三种情况都不含任何衣物名。

**没有重复注入**（验收点 6）：14:00 / 22:40 / 缺身份三轮抓包中，
`【当前穿着】\n场景` 各出现 **1** 次，`【穿着规则】` 各出现 **1** 次，
且静态规则段 91 字符里 **0** 个衣物名（正则 `白色|蓝色|粉色|灰色|睡衣|卫衣|长裤|运动鞋`
不命中）。

**卫生**：验收期间宿主进程、本地记录器、抓包端点全部已停止（端口 39217/39218/
39311/39312/39313 均不再监听）；`visual-identity.json`、`wardrobe.json` 均已按原字节还原
（`wardrobe.json` 12752 字节，`schemaVersion 2 / owner bot / 18 items / 6 outfits / 0 overrides`）；
诱饵衣柜与临时抓包配置已删除，`data-dev/media/` 下的验收产物已归档到
`logs/wardrobe-host-acceptance/` 后清掉（`git status -uall -- data-dev` 为空）。
工作区现在是 10 改 + 14 新增（比 ①阶段多 `docs/15-wardrobe-host-acceptance.md` 与
`scripts/wardrobe-host-record.mjs`），未 commit、未 push。
`npm run verify` 仍只有那 1 项既有失败（`README.md:197` 的 `author-name`，`origin/main` 上逐字节相同）。

---

## 11. 证据分级

| 项 | 等级 |
|---|---|
| 真实宿主 System Prompt / 动态注入正文 | **已抓取，可复核**（原始请求体在磁盘） |
| 14:00 / 22:40 场景与衣物 | 真实宿主验证 |
| 工具结果 == 注入正文 | 真实宿主验证 |
| 静态段无重复衣物 | 真实宿主验证 |
| personaId 隔离 | 真实宿主 + 直接调用双层验证 |
| 缺身份时的身份子句注入 | 真实宿主验证（子句确实不出现） |
| **缺身份时的生图拒绝** | **不符合预期，待修**（§6） |
| Prompt Engine 共存 | **未验证**（本分支不含，需集成后重跑） |
| 计费生图 | 仍未验证，且本轮刻意未做 |
