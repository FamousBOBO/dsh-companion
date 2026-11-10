# 16 · 三处缺陷修复报告（P0-A / P0-B / P0-C）

分支 `feat/companion-visual-identity-wardrobe`（基线 `origin/main` @ `0a545ff`，2026-11-10）。
上一轮的宿主注入验收见 `docs/15-wardrobe-host-acceptance.md`；本轮只修它查出来的三个问题，
不合并 `feat/prompt-engine`，不 commit / push / deploy。

| 项 | 结论 | 证据级别 |
|---|---|---|
| P0-A 缺视觉身份时生图必须拒绝 | **已修** | `offline-test`（13 项）+ `host-real`（真实宿主 + 网络记录器 0 命中） |
| P0-B companion 预设重复注册 `skill` | **已修** | `offline-test`（5 项）+ `host-real`（`session/create` 成功、一轮对话跑完） |
| P0-C 媒体层数据根 | **已修** | `offline-test`（8 项）+ `host-real`（宿主读到 `data-dev/media/config.json`，`data/media/config.json` 被忽略） |
| 顺带修：`verify --only=static` 的数据根一致性检查从未执行 | **已修** | 该行现在真的出现在输出里 |

---

## 1. P0-A：缺少 Visual Identity 必须拒绝生图

### 1.1 根因

`plugins/companion-media/src/service.mjs` 的拒绝条件写的是「衣物解析不出来」：

```js
// 修改前
if (!explicitOutfit && !clothingClause) { …拒绝… }
```

身份完全不在条件里，而且第一优先级是「调用方有没有传 `outfit`」——

- 身份缺失、衣柜正常 → 直接放行，画出**只有衣服没有脸**的图；
- 身份缺失、还传了 `outfit` → 连衣柜都不用问，直接放行。

`docs/15` §6 记录的实测就是这样：`dryRun` 如实报 `missing:["identity"]`，真实调用照样发出
`POST /v1/images/generations`。

### 1.2 改法

`plugins/companion-media/src/service.mjs` 新增一个**唯一闸门** `companionPictureGate(visual, …)`，
`subject=companion` 的全部判断都在这里，dryRun 与真实调用调它同一个函数、拿同一个结果对象：

| 缺失项 | 判据 | code |
|---|---|---|
| `identity` | `visual.identity.state !== 'configured'`（含 `identity-missing` / `identity-unreadable` / `identity-invalid` / `identity-missing-for-persona` / `identity-incomplete`） | `MEDIA_VISUAL_IDENTITY_REQUIRED` |
| `identity-english` | 身份存在但英文外观为空（中文身份不能塞进英文提示词） | `MEDIA_VISUAL_IDENTITY_REQUIRED` |
| `wardrobe` | 没有显式 `outfit`，且衣柜给不出英文衣物子句 | `MEDIA_BAD_INPUT` |

配套改动：

- 新增错误码 `Code.VISUAL_IDENTITY_REQUIRED = 'MEDIA_VISUAL_IDENTITY_REQUIRED'`（`src/errors.mjs`）。
- 拒绝发生在 `ledger.createJob()` 之前、adapter 之前、`fetch` 之前——**结构上不可能发出请求**。
- 结构化错误里带 `details.missing`、`details.identity.{state,code,file}`、
  `details.wardrobe.{code,context}`、`details.personaId`、`details.outfitSource`、`details.hint`。
- `dryRun` 返回 `{ok:true, dryRun:true, visualRequired:true, visual, refusal}`，`refusal` 与真实
  调用的 `error` 逐字段同源（都由 `companionPictureGate` 产出）。
- `visual` 报告块统一由 `companionVisualReport()` 渲染，dryRun / 拒绝 / 成功三条路径共用一个构造器，
  并补上 `identityClause` 与 `identityName`，让「这张图是用哪个身份画的」可审计。
- `outfit` 仍可覆盖**衣物**（旧调用与「换一套衣服来画」），但不再能覆盖**身份**。

`subject` 语义（要求 6/7）：

| 入参 | 行为 |
|---|---|
| `companion` | 强制身份 + 衣柜（或显式 outfit）；注入身份子句与着装子句 |
| `other` | `MEDIA_BAD_INPUT` 直接拒绝；不发请求；不注入任何陪伴角色数据 |
| 空 / 省略 | 保持旧行为：不查身份、不查衣柜、不注入、正常出图 |

### 1.3 一处连带发现

`plugins/companion-foundation/visual-identity.mjs` 里 `"personas": []` 因为
`typeof [] === 'object'` 被当成「这个人格没有身份」（`identity-missing-for-persona`），
而不是「文件结构无效」（`identity-invalid`）。修 P0-A 的测试时才暴露出来，已一并收紧为
显式 `Array.isArray` 判断——报错指错方向会让操作者去翻人格 id，而不是翻 JSON。

### 1.4 新增回归测试

`plugins/companion-media/test/visual-identity-gate.test.mjs`（13 项，全部用 `mockFetch` 计数）：

| 用例 | 断言 |
|---|---|
| 身份文件不存在 | `MEDIA_VISUAL_IDENTITY_REQUIRED`，`missing:["identity"]`，**POST 0** |
| 身份文件损坏 | 同上，`details.identity.code = identity-unreadable`，**POST 0** |
| `personas` 不是对象 | 同上，`identity-invalid`，**POST 0** |
| Persona 不匹配（只有别人格的身份） | `identity-missing-for-persona`，**POST 0**，不借用别人格 |
| 身份只有中文外观 | `missing:["identity-english"]`，**POST 0**，不发中文提示词 |
| 身份有效 | 通过，**POST 1**，提示词含 `Testa from Synthetic Testwork` + 外观 + 着装 |
| 身份缺失但显式传 `outfit` | 仍然拒绝（旧行为会绕过），**POST 0** |
| `subject=other` | `MEDIA_BAD_INPUT`，**POST 0**，结果里不含任何陪伴角色数据 |
| 空 `subject` | 正常出图 **POST 1**，`visual === null`，提示词不含 `Testa` / `The companion wears` |
| dryRun 与真实调用一致 | `refusal.details.missing` 与 `error.details.missing` 相等、code 相同，**POST 0** |
| 衣柜读不出来 + 身份缺失 | `missing:["identity","wardrobe"]`，`wardrobe-unreadable`，**POST 0** |
| 衣柜文件不存在（首次运行） | 只报 `["identity"]`（foundation 会播种衣柜，不算缺失），**POST 0** |
| 群聊会话 | 只报 `["wardrobe"]`，`wardrobe-unavailable-in-group`，**POST 0** |

已有测试的连带修改（没有被删掉，只是补上了身份前置条件）：`test/image-nai.test.mjs` 的两个
正例现在会先写 `writeIdentity()`；`test/helpers.mjs` 新增 `writeIdentity()` 与 `DEFAULT_IDENTITY`。

### 1.5 真实宿主验证

`data-dev/tmp/probe/verify-identity-gate.mjs`：真实 `companion-dev` Web 宿主（`--host 127.0.0.1`），
生图路由指向 `127.0.0.1:39218` 的网络记录器（记录后回 500），通过**设置页用的那条 HTTP 接口**
`POST /api/companion-media/image {confirm:true, subject:"companion"}` 触发。数据根是一个临时目录
（`os.tmpdir()`），所以真实 `visual-identity.json` 全程没被移动。

```
[draw no-identity]   http 400 ok=false code=MEDIA_VISUAL_IDENTITY_REQUIRED missing=["identity"]
[draw with-identity] http 400 ok=false code=MEDIA_UPSTREAM
refusal sent 0 network request(s); allowed draw sent 1
```

记录器实际命中 `2026-11-10T06:04:27.398Z POST /v1/images/generations`，**只有**允许的那一次。
正例的 `MEDIA_UPSTREAM` 是预期结果（记录器按设计返回 500）；能打到 provider 本身就证明闸门放行了。
证据：`data-dev/logs/identity-gate-verification/identity-gate-39316.json`。

---

## 2. P0-B：companion 预设重复注册 `skill`

### 2.1 根因

`config/profile/companion.patch.template.yml` 在 `preset-companion.plugins` 里写了：

```yaml
- id: skill
  name: '@deepseek-ai/dsh-skill'
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
```

`@deepseek-ai/dsh-skill` 是**注册表服务**，不是工具。宿主 `dsh-web-app/cordis.patch.yml` 明确保留
它、只把 `skill-filesystem` / `tool-skill` 交给预设（该文件里的注释原文：*The `skill` REGISTRY stays
in the host plane … it is host+per-scope layered*）。预设再声明一次 → 同一 realm 里重复注册
`skills` 服务 → `agent-preset/invalid`，**整个预设挂不上**，于是
`session/create {agentPreset:"companion"}` 一律失败，连一个会话都建不出来。

四个自带预设（`standard` / `ptc` / `minimal` / `cordis`）里没有任何一条裸 `skill` 行：
`standard` / `ptc` / `cordis` 声明 `skill-filesystem` + `tool-skill`，`minimal` 两条都不声明。

### 2.2 改法

删掉那一行，并在原位留下注释说明三层分工（注册表 / 发现 / 工具），避免以后有人再补回去：

```
config/profile/companion.patch.template.yml   -1 行（+7 行注释）
config/profile/companion.patch.yml            -1 行（生成的本地 profile，同步）
plugins/companion-foundation/preset-compose.test.mjs   新增
```

不删除任何工具或插件：`skill-filesystem`、`tool-skill`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、
`tool-jobs`、`tool-schedule`、`time-context`、`agent-instructions` 全部保留。

### 2.3 新增回归测试

`plugins/companion-foundation/preset-compose.test.mjs`（5 项，不引入 YAML 依赖，用两空格扫描器读）：

| 用例 | 断言 |
|---|---|
| 不声明宿主 plane 的注册表服务 | `preset-companion.plugins` 不含 `skill`，也不含 `@deepseek-ai/dsh-skill` |
| 技能能力仍完整 | `skill-filesystem` + `tool-skill` 都在；七个无关工具一个不少 |
| 同一预设内 id 不重复 | 逐预设检查重名（重名本身就是这类故障） |
| 生成的 profile 也干净 | `config/profile/companion.patch.yml` 不含 `skill` 行，且只要模板有 `tool-skill` 它也得有 |
| 与宿主自带预设一致 | 四个自带预设都不声明裸 `skill`；凡是声明 `tool-skill` 的也都声明 `skill-filesystem` |

模板与生成物的差异被显式允许：`npm run setup` 会把关闭模块的 `#@@begin:` 块整段替换成注释，
所以生成物比模板少 `companion-expression` 与整个 `companion-group` 预设在预期之内
（`data-dev/tmp/probe/check-profile-render.mjs` 逐预设对比，结果 `OK`）。

### 2.4 真实宿主验证

`data-dev/tmp/probe/verify-host-preset.mjs`：**不加任何预设修复补丁**（上一轮靠
`acceptance-preset-fix.patch.yml` 绕过，这次故意不加载），只挂
`config/profile/companion.patch.yml` + 本地 LLM 路由。

```
[host] session/create → ok
[host] sessionId=session-690eedf5-… preset=companion
[host] session/prompt → accepted
turnOutline: [{ turn: 1, prompt: "你现在穿着什么？", response: "我穿着日常的衣服。" }]
agentPreset: companion, sessionStats.turns: 1, steps: 1
```

抓到的真实请求里：62 个工具、`skill` 工具仍在列表里、技能目录段（`<available_skills>`）内容完整、
衣柜快照正常注入（`日常常服 / daytime-everyday`）。也就是说**注册表行删掉之后，读技能文件的能力没丢**。
证据：`data-dev/logs/preset-fix-verification/preset-check-39314.json`、
`data-dev/tmp/probe/captures-presetcheck/request-001.json`。

---

## 3. P0-C：媒体层数据根

### 3.1 根因

`plugins/companion-media/src/persona.mjs` 有自己的一套 `resolveDataDir()`：

```
options.dataDir → DSH_COMPANION_DATA_DIR → <suiteRoot>/data
```

它**从不读 `config/suite.json:dataDir`**，而 foundation 的 `suite-paths.mjs#resolveDataRoot()` 读。
`dataDir: "data-dev"` 的安装于是分裂成两个根：foundation 写 `data-dev/home/companion/`，媒体层挂
`<suiteRoot>/data/media`。操作者按文档在 `data-dev/media/config.json` 打开生图，宿主永远回
`MEDIA_DISABLED`，因为它在读一个不存在的文件。

### 3.2 改法：删掉第二套实现，不新增第二套配置

`src/persona.mjs#resolveDataDir()` 现在只是 `suite-paths.mjs#resolveDataRoot()` 的一层薄视图：

```js
const resolved = resolveDataRoot({ env, suiteRoot: suiteRoot || null });
const source = resolved.source === 'env:DSH_COMPANION_DATA_DIR' ? 'env' : resolved.source;
return { dir: resolved.dataRoot, source, notes: resolved.notes ?? [] };
```

- 唯一权威仍然是 `suite-paths.mjs`，没有引入第二个 `dataDir` 配置项。
- `suite-paths.mjs#resolveDataRoot()` 新增可选入参 `suiteRoot`（调用方已经知道根时直接传，
  其余顺序完全不变），这样兄弟插件能显式传入自己的仓库根，而不必依赖「从模块往上走」。
- 优先级（与 CLI / foundation 完全一致）：
  显式 `options.dataDir` → `DSH_COMPANION_DATA_DIR` → `config/suite.json:dataDir` →
  `package.json:dsh.suite.dataDir` → `<suiteRoot>/data`。
- `source` 词表保持旧签名（`option` / `env` / `config/suite.json:dataDir` / `suite-root:data`），
  旧日志与报告里引用的字段不变。
- 默认 `data/` 仍然兼容：未配置 `dataDir` 时解出 `<suiteRoot>/data`，与修改前一致。

`plugins/companion-media/index.mjs` 与 `http.mjs` 无需改动——它们本来就是调 `resolveDataDir()`，
只是现在这个函数答对了。

### 3.3 新增回归测试

`plugins/companion-media/test/data-root.test.mjs`（8 项）：

| 用例 | 断言 |
|---|---|
| `config/suite.json:dataDir` 被采纳 | `dataDir:"data-dev"` → `<suiteRoot>/data-dev`，`source=config/suite.json:dataDir` |
| 绝对路径 `dataDir` | 原样采纳，不嵌套到 suiteRoot 下 |
| 未配置 | 仍是 `<suiteRoot>/data`（`source=suite-root:data`），向后兼容 |
| 优先级 | option > env > suite.json > package.json > 默认，逐级断言 |
| 与 foundation 同一权威 | `media.dir === foundation.dataRoot`，`basename === 'data-dev'` |
| 本仓库自身 | 两边都指向 `<dev-clone>\data-dev` |
| **两份 config 不互相覆盖** | `<dataDir>/media/config.json`（开）优先；`data/media/config.json`（关）不被读取；对照组证明默认根下那份确实是「关」 |
| 未配置媒体能力 | 保持默认行为：`image.enabled=false`、`provider=none`、`tts.enabled=false` |

### 3.4 真实宿主验证

`data-dev/tmp/probe/verify-media-dataroot.mjs`：写入诱饵 `data/media/config.json`（关）与
`data-dev/media/config.json`（开，provider 指向 `127.0.0.1:39218` 记录器、`billingApis:false`），
真实宿主起来后读 `GET /api/companion-media/status`：

```
[api] dataDir    : <dev-clone>\data-dev
[api] configFile : <dev-clone>\data-dev\media\config.json
[api] configExists: true          migrated: false
[api] plugin enabled: true        provider: nai
[log] data-dev media log touched during this run : true
[log] data/ decoy log touched during this run    : false
```

证据：`data-dev/logs/dataroot-verification/media-status-39315.json`。诱饵文件与探测用配置随后已删除，
`data/media/logs/media-events.jsonl` 与验收前**逐字节相同**（sha256
`2C5A39B129E7ACBE3BB5EA23103965DC539461C557807D133F3C9C66A2485450`）。

`doctor` 与 compose 一致：`doctor` 报 `dataDir` 下各目录就绪、媒体层补丁已挂；
`dsh --dump-config` 195 个 loader 行不变。

### 3.5 顺带修掉的一个「检查从未执行」

`scripts/verify.mjs` 的 `runStatic()` 以 `return checkDataRootParity();` 结尾，但调用处是
`if (want('static')) runStatic();`——没有 `await`，进程在异步行被记录之前就打印汇总并退出。
结果是**数据根一致性检查（D2 决策落地的那条）从来没有真正跑过**。这是 `origin/main` 上就有的问题，
修 P0-C 时才发现。现在改为 `await runStatic()`，并新增第二行比较媒体层：

```
✓ 数据目录解析一致（CLI ↔ 插件） — <dev-clone>\data-dev
✓ 数据目录解析一致（CLI ↔ 媒体层） — <dev-clone>\data-dev
```

---

## 4. 修改前后行为对比

| 场景 | 修改前 | 修改后 |
|---|---|---|
| 缺身份 + 衣柜正常 | 发请求，画出只有衣服的图 | `MEDIA_VISUAL_IDENTITY_REQUIRED`，0 请求 |
| 缺身份 + 传了 outfit | 发请求（连衣柜都不问） | 仍然拒绝，0 请求 |
| 身份坏了 / 结构无效 / 人格不匹配 | 当作「没有身份」继续画 | 明确拒绝，并指出是哪种坏法 |
| 身份只有中文 | 提示词里没有身份子句，照样画 | 拒绝并说明需要英文外观 |
| 身份有效 | 正常画 | 正常画（不变） |
| `subject=other` | `MEDIA_BAD_INPUT` | `MEDIA_BAD_INPUT`（不变，但现在有测试盯着） |
| 空 `subject` | 正常画，不注入 | 正常画，不注入（不变） |
| `session/create {agentPreset:"companion"}` | `agent-preset/invalid … skills has been registered` | 成功，且能跑完一轮对话 |
| `dataDir:"data-dev"` 下的媒体配置 | 忽略，永远 `MEDIA_DISABLED` | 正确读取 |
| `data/media/config.json` | 会被读（错误的根） | 不再被读 |
| `verify --only=static` 数据根检查 | 从未执行 | 执行，两行都绿 |

---

## 5. 验证结果

| 命令 | 结果 |
|---|---|
| `node --test "plugins/companion-foundation/*.test.mjs"` | **206 项全通过**（+5） |
| `node --test "plugins/companion-media/test/*.test.mjs"` | **162 项全通过**（+21） |
| `npm run verify -- --only=unit` | 9 模块通过 / 0 失败 / 1 无测试（paste-search） |
| `npm run verify -- --only=compose` | 195 个 loader 行，通过 |
| `npm run verify -- --only=static` | 30 通过 / **1 失败**（`author-name — README.md:197`，`origin/main` 上逐字节相同，按要求未改） |
| `npm run doctor` | 核心检查通过（注意 0、未就绪 0，共 37 项） |
| 真实宿主 `session/create` | 成功，37314 / 39315 / 39316 三次独立启动均无预设错误 |
| 缺身份生图零网络请求 | 拒绝 0 命中，允许 1 命中（同一次运行内对照） |

生图相关测试全程 `dryRun` 或 `mockFetch` / 本地记录器，没有触发任何真实计费调用。

---

## 6. 剩余问题与风险

| # | 事项 | 等级 | 说明 |
|---|---|---|---|
| 1 | 真实计费生图 | 需操作者授权 | 全部验证仍是 dryRun + 本地记录器；真实一张需显式授权 |
| 2 | `feat/prompt-engine` 未合并 | 按指示 | 冲突点仍是 `injectedWithCare → finalInjected`；集成方案见 `docs/15` §7，合并后需重跑 14:00/22:40 验收并断言衣柜正文逐字节相同 |
| 3 | `README.md:197` 的 `author-name` | 低（既有） | 按要求不用改 README 绕检查的方式处理；这一行会一直让 `verify` 显示 1 项失败 |
| 4 | 宿主自带预设数量变动 | 低 | `preset-compose.test.mjs` 会对比宿主自带的四个预设；升级 DSH 后若宿主改了声明方式，该测试会提醒复核，而不是静默放行 |
| 5 | 群聊里无法生陪伴角色图 | 设计如此 | 群会话不解析私人衣柜（`wardrobe-unavailable-in-group`），所以即使身份齐全也会拒绝；这是隐私边界，不是缺陷 |
| 6 | `data-dev/tmp/probe/` 里约 40 个一次性脚本 | 说明 | 全部 gitignore，不随仓库发布；是否保留由操作者决定 |

---

## 7. 工作区状态

- 分支 `feat/companion-visual-identity-wardrobe`，HEAD 仍是 `0a545ff`，**未 commit、未 push、未合并**。
- 改动文件（相对 ①阶段）：
  - 新增：`plugins/companion-media/test/visual-identity-gate.test.mjs`、
    `plugins/companion-foundation/preset-compose.test.mjs`、
    `plugins/companion-media/test/data-root.test.mjs`、`docs/16-p0-fixes.md`
  - 修改：`plugins/companion-media/src/service.mjs`、`plugins/companion-media/src/errors.mjs`、
    `plugins/companion-media/src/persona.mjs`、`plugins/companion-media/test/image-nai.test.mjs`、
    `plugins/companion-media/test/helpers.mjs`、`plugins/companion-foundation/suite-paths.mjs`、
    `plugins/companion-foundation/visual-identity.mjs`、
    `config/profile/companion.patch.template.yml`、`config/profile/companion.patch.yml`（本地生成物）、
    `scripts/verify.mjs`
- 未改：真实 Persona（`config/persona.md`）、`config/suite.json`、`data-dev/home/companion/wardrobe.json`、
  `data-dev/home/companion/visual-identity.json`、生产环境、DSH 宿主核心、README。
- 根目录 `data/` 与 `data-dev/` 下的验收产物已归档到
  `data-dev/logs/{preset-fix-verification,dataroot-verification,identity-gate-verification}/`，
  探测用配置与临时记录器均已停止（39217 / 39218 / 39311–39316 全部不再监听）。
