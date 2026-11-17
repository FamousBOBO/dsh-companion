# 20 · G0 基线审计（2026-11-14）

> 只读审计产物。**本文不是完成报告**，它记录"这一版代码、配置与运行实例到底长什么样"。
> 所有结论都带可复现命令；没有执行的项明确写"未执行"。不含任何聊天正文、记忆正文、
> 候选正文、凭据值或 reasoning 原文。

## 0. 执行摘要（先说最要紧的四条）

1. **被测树 ≠ 运行树。** 运行中的陪伴宿主加载的插件源码来自
   `C:[…]/Documents/Bot/dsh-production`（HEAD `e1a3932`），而本轮 worktree 基于
   `D:\DSH\dsh-production` 的 HEAD `ecde3ed`。运行期数据根是 `D:\DSH\dsh-production\data`。
   三棵树的分叉必须分开记录，任何"本机 HEAD 是什么"的单值回答都是错的。
2. **"大量未提交修改"大部分已在上游。** `D:\DSH\dsh-production` 的 83 条工作树条目里，
   47 条内容已等于 `origin/main` 的版本，只有 17 条是真正本地独有（且集中在伴奏/song 与
   `dsh-ops`），19 条是未跟踪文件。覆盖式同步会丢东西，但"全是待发布代码"也不成立。
3. **分享链 0 候选不是开关问题。** 生产 `p2.share.enabled=true`、`maxPending=5`，
   `p2_share_candidates` 仍是 **0 行**；7 条已完成的 B 站活动都有 watch 证据。
   断点在"没人产候选"（`share-producer.mjs` 只有模型显式调用一个出口），不在开关。
4. **doctor 在干净检出上必然红一项。** 未生成 `config/suite.json` 时，宿主 CLI 入口靠
   `deriveModuleRoot()` 猜 `resources/app/dsh/node_modules`，而桌面版真实路径是
   `resources/app.asar.unpacked/dsh/node_modules`，于是报"找不到 CLI 入口"。
   配了 `dsh.moduleRoot` 之后 CLI 立刻成立（已实测，见 §4）。

## 1. 三棵树的身份（这是本轮最容易搞错的地方）

| 树 | 角色 | HEAD | 与 `origin/main` | 工作树 |
|---|---|---|---|---|
| `D:\DSH\dsh-production` | 生产数据根 + 生产源码目录 | `ecde3edf303e08ba11751851e316aa71edfe39d2`（2026-11-13 14:37） | behind 6 / ahead 0（可快进） | 83 条（详见 §2） |
| `C:[…]/Documents/Bot/dsh-production` | **运行宿主实际加载的插件源码** | `e1a393250c8ad8c5ff34e9f0ad426948637a8661` | 其本地 `origin/main` 引用停在 `e1a3932`（未 fetch）；相对真正远端 behind 1 | 43 条 |
| 本 worktree `D:\DSH\dsh-production\.agents\worktrees\dsh-55f1cc85-7db6` | 本轮开发区 | `ecde3ed` | behind 6 / ahead 0 | 干净（仅本轮新增未跟踪文件） |

远端 `origin/main` 当前 HEAD：`87b10b8da2fa6307158ce48b4f4b46f62dab80fd`（2026-11-14 02:40，
`feat(qq): 语音条接入 DeepSeek 官方 ASR…`）。计划 §2.1 记录的远端 SHA 与本轮复核一致。

`D:\DSH\dsh-production` 落后 `origin/main` 的 6 个提交：

```
87b10b8 feat(qq): 语音条接入 DeepSeek 官方 ASR，并修掉三个吞掉语音的 bug
e1a3932 feat(media): make docs/image-prompt-guide.md the single prompt authority
9e1316e feat(media): let LLM select aspect for automatic resolution
0a29873 fix(group): inject public persona and prefer approved stickers
f52a089 fix(group): focus current requests, recognize owner and deliver voice
cf8c7d3 fix(autonomy): continue draft versions and bound failed slot starts
```

`ecde3ed` 是 `e1a3932` 的祖先 ⇒ 运行树（C:）比被测树（D:）**多 5 个提交**，且只比远端少 1 个。

复现：

```powershell
git -C D:\DSH\dsh-production rev-list --left-right --count HEAD...origin/main
git -C C:[…]/Documents/Bot/dsh-production log --format='%h %s' -5
git merge-base --is-ancestor ecde3ed e1a3932   # 退出 0
```

### 1.1 运行实例"加载谁"的证据

宿主 profile 补丁 `D:\DSH\dsh-production\data\home\profiles\companion\cordis.patch.yml` 里，
插件入口全是**绝对 `file://` 路径且指向 C 盘树**：

| 行 | 指向 |
|---|---|
| 24 | `file:///C:…/Documents/Bot/dsh-production/plugins/companion-foundation/index.mjs?reading=20261101-v2&pulse=20261104b&bridge=20261104` |
| 26 / 278 / 284 | `…/plugins/companion-media/index.mjs`（两处重复注册） |
| 32 / 284 | `…/plugins/companion-expression/index.mjs` |
| 267 | `…/plugins/qq-idle-compaction.mjs` |
| 269 / 286 | `…/plugins/companion-group/boundary.mjs` / `…/companion-group/index.mjs` |
| 308 / 335 | `…/plugins/companion-health/index.mjs` / `collector-terminals.mjs` |
| 347 | `file:///D:/DSH/dsh-production/data/local-services.mjs`（唯一 D 盘项） |

`package.json` 的四个 `link:` 依赖同样指向 C 盘树（`channel-qq` / `media` /
`memory-studio` / `paste-search`）。

宿主日志确认数据根是 D 盘：

```
[companion-foundation] dataRoot=D:\DSH\dsh-production\data (env:DSH_COMPANION_DATA_DIR); personaId=<配置的人格 id> …
```

⇒ **代码从 C: 加载，数据落在 D:。** 结论：对本轮任何"生产行为"的判断，都必须说明它来自
哪棵树；改 worktree 不会改变当前运行实例的行为。

`pending-source`：`plugins/companion-runtime` 与 `plugins/companion-memory` 没有出现在
profile 补丁的 `file://` 清单里（它们是 `companion-foundation` 的静态 import 依赖，
随 foundation 一起从 C 盘树解析）。

## 2. 工作树差异归属（`D:\DSH\dsh-production`）

方法：对每条 `git status` 条目取工作树内容哈希，与该路径在 `origin/main` 的 blob 哈希比较，
只比哈希不比正文。

| 归属 | 条数 | 含义 |
|---|---:|---|
| 内容已等于 `origin/main` | 47 | **改动已经在上游**；这部分的"未提交"只是本地 HEAD 落后 |
| 内容与 `origin/main` 不同 | 17 | **真正的本地独有改动** |
| 未跟踪 | 19 | 远端没有这些文件，需逐个判用途 |

17 条本地独有改动（成组出现，不是散的）：

```
docs/karaoke-cover.md
dsh-ops/check-production.mjs
dsh-ops/production.ps1
plugins/dsh-channel-qq/src/adapters/song/cover.ts
plugins/dsh-channel-qq/src/config/sections/song.ts
plugins/dsh-channel-qq/src/features/song/{cache-flow,cache-key,pipeline,prepare,types}.ts
plugins/dsh-channel-qq/test/golden/config/{layers,resolved}.txt
plugins/dsh-channel-qq/test/song-{auto,cache,group-quota,pipeline,start-mode}.test.ts
```

⇒ 结论：本地独有工作集中在**伴奏/翻唱（karaoke cover）**与**生产巡检脚本**两组，与计划里
要动的记忆/路由/生活状态/分享链路**没有交集**。第二棵（C:）树的 43 条同理集中在
`stt.ts` / `song*` / `golden` 与 ASR 相关新增文件。

19 条未跟踪（D: 树）：`design/`、三份 docs（含本计划原文）、`persona-prompt.mjs`(+test)、
`prompt-guidance.test.mjs`、`start-retry.mjs`(+test)、`credentials.ts`×2、
`stt-deepseek.ts`、`song/probe.ts`、`group-segments.ts`、`song/separation.ts`、
`song/types-cache.ts`、三个 song/stt 测试。

**注意**：`stt-deepseek.ts` 在 D: 树是未跟踪文件，而 `origin/main`(=C: 树 HEAD) 里也没有
这个路径——ASR provider 是**两棵树都没入库**的本地文件（`87b10b8` 只改了 `stt.ts` 等已跟踪
文件）。这与计划 §2.1 提到的"song/voice 源码本地未跟踪"一致。

## 3. 配置与开关（只读，不含凭据值）

`config/suite.json`（生产，**不入库**）：

| 项 | 值 | 说明 |
|---|---|---|
| `modules.{core,memoryStudio,qq,bilibili,health,media,expression,pasteSearch}` | 全部 `true` | 八个模块全开 |
| `safety.{autoSend,autoComment,backgroundModelTasks,healthCollection,billingApis}` | 全部 `true` | 外发/计费/后台任务全部**已由操作者显式打开** |
| `qqIdleCompaction` | `true` | 会调用模型 |
| `dsh.moduleRoot` | `C:…/Documents/Bot/dsh-production/data/host-runtime/node_modules` | 已显式配置（doctor 因此能过 CLI 检查） |
| `dsh.permissionMode` | `workspace-write` | |

`data/home/companion/runtime.config.json`（生产）：

| 项 | 值 |
|---|---|
| `enabled` / `mode` | `true` / `active` |
| `timeZone` | `Asia/Shanghai` |
| `p2.planning.enabled` | `true`（maxSlots 12, wakeHour 8, targetActivities 4） |
| `p2.activities.enabled` | `true`（`dispatchEnabled: true`, `readFullSource: true`） |
| `p2.share` | **`enabled: true`, `maxPending: 5`** |
| `p2.budget` | 64 请求 / 16 万输入 / 2.4 万输出 token 每日，`chatPriority: true` |
| `p2.autonomy` | `allowedSources: ["*"]`、`searchProvider: dsh`、6 个种子站、6 个话题 |
| `agenda.enabled` / `heartbeat.enabled` | `true` / `true` |

**"源码注释说生产开关为 false"这条旧说法不成立**：当前实际配置是 `share.enabled = true`。

`prompt-engine.config.json`：**不存在**（`data/home/companion/` 下无此文件） ⇒ Prompt Engine
按合同 §2.1 默认 `enabled:false`/`mode:'off'`，`companion:prompt-contract` 段为空（实测 0 字符，
见 §5）。这与旧基线文档"prompt-contract 183 字符"不同，属于**本轮实测差异**，不是回归。

## 4. 宿主、版本与 CLI

| 项 | 实测 | 证据 |
|---|---|---|
| 桌面可执行 | `C:[…]/Programs/DeepSeek Harness/DeepSeek Harness.exe` | `resolveHost()` → `source:"probe"` |
| 宿主版本 | **`probeVersion()` 未取到** → version `''`，`checkCompatibility` 报 `level:'unknown'` | 桌面 `-e` 探测的 `process.resourcesPath` 路径下没有 `app/dsh/package.json`（实际是 `app.asar` 内的虚拟路径） |
| CLI 入口 | 配置 moduleRoot 后 `exists: true`（`…/data/host-runtime/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`，5607 B） | `hostCliPath()` 实测 |
| 启动形态 | `launcher: 'desktop-exe'`（用桌面 exe + `--expose-internals` 跑 CLI） | `describeLauncher()` |
| 运行中的宿主 | Electron 桌面实例，`foundation-runtime.json` 记录 `pid 30220`、`mountedAt 2026-11-13T18:40:47Z`；本次 `production-host.log` 里 `process 30220` 的 `dsh web: http://127.0.0.1:62684/?token=…` | `data/logs/production-host.log` 尾部 |
| 本轮会话的 Web GUI | `http://127.0.0.1:3080`（`@deepseek-ai/dsh/lib/bin.js web`），**不是**陪伴生产实例 | `Win32_Process` 命令行 |

**doctor 的失败项（已判定为工具缺口，不是环境故障）**：

```
[失败] 宿主 CLI 入口 — 宿主目录里找不到 CLI 入口：
```

原因：worktree 没有 `config/suite.json` ⇒ `configured.moduleRoot` 为空 ⇒ 回落到
`deriveModuleRoot()`，它只猜 `resources/app/dsh/node_modules`。桌面 0.2.2 的真实布局是
`resources/app.asar.unpacked/dsh/node_modules`（`Test-Path` 已确认存在）。
把配置里的 moduleRoot 传进去后，同一台机器立刻 `ready:true`：

```powershell
node --input-type=module -e "…resolveHost({executable:'…DeepSeek Harness.exe', moduleRoot:'…/data/host-runtime/node_modules'})…"
# → {"found":true,"source":"config"} / hostCliPath exists:true / launcher desktop-exe ready:true
```

⇒ 建议列入 G0 修复：`deriveModuleRoot()` 增加 `resources/app.asar.unpacked/dsh/node_modules`
候选；`probeVersion()` 增加 asar 内 `package.json` 的读取路径。**未修改代码**，仅记录。

## 5. 合成基线统计（`tools/baseline-stats.mjs`，本轮新增）

口径：合成根（`os.tmpdir()`，`backend:sqlite`、`injection.budgetChars:0`、runtime `mode:'off'`），
挂载真实 `mountCompanion`，收集 Section 与工具注册；**只采长度，不采正文**。

| 指标 | 实测 | 说明 |
|---|---:|---|
| System Prompt Section 段数 | **8** | 见下表 |
| Section 字符合计 | **2,067** | persona 段用的是 `config/persona.example.md`（1,197 字符），不是生产人格 |
| 工具数（foundation 注册） | **42** | 旧基线记的是"含宿主共 56 个"，口径不同，不可直接比 |
| 工具定义字符合计 | **17,835** | 其中 schema 与 description 分别计量 |
| 最重工具 | `companion_pulse` 1,521（schema 306 + desc 1,215） | 其后 `companion_schedule_update` 1,011、`companion_health_sleep` 947、`companion_schedule_create` 920 |

逐段：

| order | Section | 字符 | 类型 |
|---:|---|---:|---|
| 50 | `companion:persona` | 1,197 | 字符串（合成人格） |
| 60 | `companion:continuity` | 309 | 字符串 |
| 61 | `companion:agenda` | 239 | 字符串 |
| 62 | `companion:life` | 138 | 字符串（静态真值约束：实时事实改由 pre-step 快照注入，见 §12） |
| 63 | `companion:wardrobe` | 91 | 字符串 |
| 64 | `companion:pulse` | 93 | 字符串 |
| — | `companion:prompt-contract` | **0** | 函数；`mode:'off'` ⇒ 空（宿主会丢弃空段） |
| 65 | `companion:qq-policy` | **0 / threw** | 无 QQ 上下文时抛错，被采集器记为 `threw` |

生产换算（**推算，不是实测**）：生产 `config/persona.md` 实测 4,797 字符，
替换掉合成人格后 Section 合计约 **5,667 字符**。但生产 System Prompt 还包含
`companion-memory` 的每轮快照（身份 240 + 记忆 ≤2,400 + 工作记忆 + 心跳/关怀/衣柜）与宿主原生段，
**这些本轮没有抓包**，所以不能给出生产 System Prompt 总字符。

**不可用指标**：`provider usage`、`TTFT` —— 宿主未暴露计数器，写 `unavailable`，不用估计值代替。

复现：`node tools/baseline-stats.mjs` / `node tools/baseline-stats.mjs --json`。

## 6. 运行期事实（`tools/g0-runtime-probe.mjs`，本轮新增）

只读打开生产值文件（`D:` 与 `C:` 树的该文件**内容与 mtime 完全一致**，10870784 B /
2026-11-14 01:27:57，判定同一份有效数据，非两份不同数据库）。

| 表 | 行数 |
|---|---:|
| `p2_activities` | 42 |
| `p2_activity_receipts` | 1,240 |
| `p2_plans` / `p2_plan_slots` / `p2_plan_runs` | 27 / 121 / 533 |
| **`p2_share_candidates`** | **0** |
| `p2_budget_ledger` | 402 |
| `p2_interests` / `p2_opportunities` | 6 / 33 |

活动分布（`kind/status/reality`）：

```
write/done     14     explore/done 12     bilibili/done 7
write/paused    4     explore/paused 2     bilibili/failed 3
```

B 站活动 10 条，逐条（`checkpoint.bilibiliRound`）：

| activityId | status | round | watched | 证据种类 |
|---|---|---|---|---|
| `act_842d2686…` | done | completed | 5 | `watch:transcript`, `interaction`, `report` |
| `act_4078c745…` | done | completed | 4 | `watch:transcript`, `report`, `interaction` |
| `act_107f4c6d…` | done | completed | 5 | 同上 |
| `act_580f29b9…` | done | completed | 3 | 同上 |
| `act_f4c3224d…` | done | completed | 5 | 同上 |
| `act_d4ff3c0e…` | done | completed | 5 | 同上 |
| `act_8b56c8e5…` | done | completed | 4 | 同上 |
| `act_617a2fd1…` | failed | quota-exhausted | 0 | — |
| `act_28b9f909…` | failed | unknown | 0 | — |
| `act_e82afb01…` | failed | quota-exhausted | 0 | — |

Round journal（`home/bili-duty/p2-rounds/`）：**10 本，7 本带证据**，另外 1 本 `unknown`
（0 证据）、2 本 `quota-exhausted`（0 证据）。证据里的 `watch` 一律带
`method:'transcript'` ⇒ **实际是读字幕，不是完整观看**。这一点必须体现在候选/感想措辞里。

⇒ **关键断点**：9 条"有 watch 证据且 done"的活动（7 done 中 3 条 watched≥5）
一条候选都没产；`p2_share_candidates` 0 行。断点位置 =
`plugins/companion-foundation/share-producer.mjs` 的 `shareCandidateForActivity()` 只有
模型显式调用 `companion_share_activity`（`index.mjs:672`）这一个入口，`finishActivity`
不产候选。

## 7. 外部 B 站模块

| 项 | 值 |
|---|---|
| 安装位置 | `D:\DSH\dsh-production\data\home\profiles\companion\node_modules\dsh-bili-scroll` |
| 版本 | `2.4.0`（与 `docs/03` 记载的固定版本一致） |
| `package.json` 里的 license 字段 | `MIT` |
| 本仓库态度 | `docs/03` 记载上游**无 LICENSE 文件**、不随本仓库分发、不为许可背书 |
| 本 worktree 内是否存在 | **不存在**（不要指望能 import） |
| provider 注册 | `plugins/companion-runtime/lib/bilibili-provider.mjs` 从进程级注册表 `Symbol.for('dsh.companion.bilibili.providers.v1')` 取 `entry.ready() === true`；`ready:false` ⇒ 适配器报 `provider-not-ready` |

⇒ "源码里有 bilibili 适配器"≠"provider 已 ready"。本轮**未**验证 provider 在运行实例里的
ready 状态（需要宿主内省，属 E3 范畴）。

## 8. 离线验证现状（`npm run verify`）

worktree 上实跑（Node 24.14.0 / npm 11.9.0）：

```
unit     ok 9  failed 0  skipped/no-tests 1   (dsh-paste-search 无测试)
static   ok 38 failed 1  skipped/no-tests 0
compose  ok 0  failed 0  skipped/no-tests 1   (worktree 无 suite.json ⇒ SKIPPED)
```

唯一失败项 `author-path` 命中：

```
docs/production-closeout-20261112.md:7   tools/lib/host-temp.test.mjs:5
```

**判定：既有问题，不是本轮引入。** 证据：`git show origin/main:docs/production-closeout-20261112.md`
第 7 行同样含 `C:…/Documents/Bot/dsh-production`；
`git show origin/main:tools/lib/host-temp.test.mjs` 同样含 `C:[…]/AppData/Local`。
两个文件本轮未改动。

`compose` 在 worktree 里 SKIPPED；**用真实宿主 + 生产 profile 单独跑通了一次**：

```powershell
# dumpConfig({host, dshHome:'D:/DSH/dsh-production/data/home', profile:'companion'})
ok: true            loader 行: 360
file:// URL: 15 个  → C: 盘 13 / D: 盘 2 / 其他 0
缺失文件: 0
```

⇒ 宿主合成可用，但**不代表插件装载成功**：`production-host.log` 尾部仍有
`dsh: warning: 2 entries did not activate`（`desktop-product-telemetry` 缺 `serviceVersion`、
`product-analytics` 等 `productTelemetry`）与 4 条 `@deepseek-ai/dsh-tool-subagent@0.2.1-rc.3
与 dsh 0.2.2-rc.1 不兼容 ⇒ disabled`。

## 9. 本轮已建立的可复现工具（新增，未改任何既有文件）

| 文件 | 作用 | 只读保证 |
|---|---|---|
| `tools/baseline-stats.mjs` | Section 与工具的**长度**统计 | 合成根；不采正文 |
| `tools/g0-runtime-probe.mjs` | 运行期表行数、活动分布、B 站 round journal | `readOnly` 连接；正文/目标截断 60 字符 |
| `baseline-stats-20261114.json` | §5 的机器可读快照 | 同 |

两个脚本都可以指向任意库/目录（`--db` / `--rounds`），因此本报告在 C 树与 D 树上做过对照，
结论一致。

## 10. 证据等级与未执行项

| 项 | 等级 | 依据 |
|---|---|---|
| 三棵树身份、差异归属、配置读取 | **E0** | 只读命令 + 哈希比对 |
| 合成基线体积统计 | **E1** | 真实挂载 + 真实工具注册 |
| 运行期表行数与活动/证据分布 | **E1** | 只读 SQLite |
| `npm run verify` 离线结果 | **E2** | 实跑通过计数 |
| 宿主 profile 合成 | **E1**（合成成功） ≠ **E3**（装载成功） | `--dump-config` 不挂载 |
| provider ready、真实模型质量、真实私聊送达 | **未执行** | 需宿主内省 / 真实模型 / 操作者显式触发 |

**未执行**：E3（隔离 profile 真实启动 + Hook 验证）、E4（真实模型固定集）、
E5（操作者显式触发的真实通道验收）。

## 11. G0 遗留问题（按优先级）

1. **运行树与被测树分叉未收敛。** 现在改 worktree 不会影响运行实例；要让改动生效必须
   决定"以哪棵树为准"。建议：先把 `D:\DSH\dsh-production` 快进到 `origin/main`（behind 6
   / ahead 0，可快进，无冲突），再把 profile 的 `file://` 路径改为指向单一源码根。
   **未执行**，需要操作者确认。
2. **driver 的 `deriveModuleRoot()` / `probeVersion()` 缺口**（§4），导致干净检出上
   doctor 有一条假红、宿主版本恒为 `unknown`。
3. **`p2_share_candidates` 0 行的真实成因是缺生产者**（§6），由任务包 F 处理。
4. ~~**`companion:life` 不传 bound**~~ —— **已修，见 §12**：Section 不再渲染状态，实时事实改由
   pre-step 快照注入（`life-facts.mjs`）。
5. **watch 证据全是 `method:'transcript'`**，候选措辞必须诚实区分"读了字幕"与"看了视频"。
6. `author-path` 静态规则误报（§8）——规则本身或两个被扫文件的写法要选一个改。
7. **`dsh-bili-scroll@2.4.0` 同版本号不同字节**：装在本机 profile 的副本不含 provider publish
   代码，备份副本含 ⇒ `provider-not-ready` 而 planner 仍能派活（任务包 F 的审计结论）。

---

## 12. 第一批任务包接线结果（Lead 收口，2026-11-14）

只列**已经接线并跑过离线测试**的部分；每个模块的详细结论在其自己的交付物里。

| 包 | 交付物 | 接线点 | 离线结果 |
|---|---|---|---|
| **E 真实生活状态** | `plugins/companion-foundation/life-facts.mjs`（1016 行）、`life-facts.test.mjs`、`docs/E-life-facts-draft.md` | `index.mjs`：import；pre-step 在衣柜之前注入 `companion-life-facts` 快照；`companion:life` Section 降级为静态真值约束；`companion_life_status` 增加 `lifeFacts`（`force:true`） | `life-facts.test.mjs` **22/22**；foundation 全目录 **476/476** |
| **F B站分享闭环** | `share-decision.mjs`（804 行）、`share-decision.test.mjs`、`docs/F-share-chain-draft.md`、`docs/21-bilibili-share-chain-audit.md` | `index.mjs` 给 `mountRuntime` 传 `onActivityFinished`（惰性闭包，走公开 `createShareCandidate`）；`companion-runtime/index.mjs` 的 `p2ActivityFinished` 在 memory ingest **之后**调用它，并把 live checkpoint 与 receiptId 一起传下去 | `share-decision.test.mjs` **35/35**；runtime 全目录 **698/698** |
| **A 记忆门控** | `plugins/companion-memory/lib/query-plan.mjs`、`injection-gate.mjs`、`retrieve.mjs`/`render.mjs`/`config.mjs`/`index.mjs` 的增量改动、4 个测试、`docs/A-memory-query-gate-draft.md`、`docs/A-memory-query-gate-report.md` | 已在 memory 包内自接线：`contextFor` 走 `purpose:'auto'`，`companion_recall` 走 `purpose:'explicit'`；门 1（检索资格）在过滤链、门 2（自动注入）在渲染层**都真正生效**（不是只统计） | memory 全目录 **301 / 294 pass / 0 fail / 7 skipped**；`render-gate` 7 条、`injection-gate` 9 条、`query-plan` 10 条、`query-gate-integration` 7 条全绿；`memory-mount.test.mjs` **11/11** |
| **D 正文诊断** | `output-diagnosis.mjs`、`output-diagnosis.test.mjs`、`docs/23-tool-capability-audit.md`（C+D 合并报告） | **未接线**（只交模块，Hook 由第二批接） | **12/12** |

G0 修正的两处实测差异（相对旧文档）：

* `companion:life` 从 53 字符的空态兜底文案变成 **138 字符**的静态真值约束（Section 合计
  1,982 → **2,067** 字符）；工具定义合计 17,534 → **17,835**（`companion_life_status` 的
  描述变长）。
* 这两个数字是**本轮实测**，旧基线文档（§5 引用的 5,881 / 46 工具 / 26,621）来自另一次抓包，
  口径与代码版本都不同，不能直接对比。

## 13. 本轮唯一剩下的红项：`author-path`（判定为既有问题，未改）

`npm run verify` 现在唯一失败的是静态规则 `author-path`：

```
✗ author-path — docs/production-closeout-20261112.md:7 tools/lib/host-temp.test.mjs:5
```

判定依据（两条都是既有文件，本轮零改动）：

* `docs/production-closeout-20261112.md` 第 7 行在 `origin/main` 上就含本机绝对路径；
* `tools/lib/host-temp.test.mjs` 第 5 行的 fixture 用的是 `C:[…]/AppData/Local` 形态的**合成**
  路径，规则 `/[A-Za-z]:[\\/](?:Users[\\/][A-Za-z0-9_.-]+|Bot[\\/]dsh-companion)/` 把它当成
  泄漏。

三个可选处置（**都没有执行**，需要你选）：

1. 把 `tools/lib/host-temp.test.mjs` 的 fixture 改成不含 `Users/` 的形态（例如
   `C:/tmp/AppData/Local`），规则不动；
2. 给规则加一条只对 `test/fixtures` 与 `*.test.mjs` 生效的例外（要配自检用例，否则等于放宽）；
3. 把 `docs/production-closeout-20261112.md` 里的路径脱敏成 `C:[…]`。

本轮新增的四份文档（`docs/20`、`docs/21`、`docs/22`、`plugins/companion-*/docs/*`）在这条规则
下**零命中**。

**接线后仍未改变生产行为**：以上改动只存在于 worktree 内；运行实例加载的仍是 `C:` 树（§1.1）。

## 14. 本轮结束时的最终验证状态

```
npm run verify
unit     ok 9  failed 0  skipped/no-tests 1     (@dsh-companion/paste-search 无测试)
static   ok 38 failed 1  skipped/no-tests 0     (唯一失败 = §13 的 author-path，既有问题)
compose  ok 0  failed 0  skipped/no-tests 1     (worktree 无 suite.json ⇒ SKIPPED)
```

单独用真实宿主跑了 `dumpConfig({dshHome, profile:'companion'})`：`ok:true`、loader 行 360、
15 个 `file://` 全部存在、C 盘 13 / D 盘 2。**这是合成成功，不是装载成功**（E3 未执行）。

**唯一无法离线消除的波动**：`verify --only=unit` 偶发把某一个包判成 `exit 1`（本轮见过一次
memory、一次 runtime、一次 channel-qq），而同一时刻单独 `npm run test --workspace <包>` 永远是
全绿（memory 301/294、runtime 703/703、channel-qq 1876/1875）。三个包都在跑并发 `node --test`，
判定是**并行争用**（时长抖动跨过测试内的 `sleep` 阈值），不是代码失败。复跑 `verify --only=unit`
即回到 9 ok / 0 failed。这条现象连同证据记在这里，不当作已修。

---

**本文不含**：聊天正文、记忆正文、候选正文、凭据值、reasoning 原文、真实视频标题与感想。
