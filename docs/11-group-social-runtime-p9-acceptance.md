# P9 验收与校准：A 阶段交付记录（2026-11-08）

对应《DSH 群聊社交运行时 · 下一阶段计划（P9）》§2 与 §8。**起点**：`feat/group-social-p0`
分支 HEAD `201299e`（P9 计划检查时记录的那个提交）。

**这份文档只报告做到的部分。** P9-B 之后的每一项都需要真实模型端点或真实群授权，
本次都没有：见 §3 与 §6 的逐项说明。

---

## 1. 结论先说

| 阶段 | 状态 | 证据级别 |
|---|---|---|
| P9-A 兼容性与可靠性审计 | **完成**（含 4 个真实缺陷的修复） | `offline-test` |
| P9-B 真实模型影子评测 | **未执行**：通道就绪、自测通过，但本机没有可用的模型端点凭据 | — |
| P9-C 真实群 shadow 观察 | **未执行**：需要操作者授权的测试群 | — |
| P9-D 四类错误校准 | **未执行**：前置是 B/C 的真实样本 | — |
| P9-E 授权单群 live | **未执行**：需要操作者明确授权 | — |
| P9-F 表情与双群 | **未执行**：需要两次独立授权 + 素材审核 | — |

**没有任何一条真实 QQ 发送记录，也没有任何真实模型输出。** P9 计划 §0.4 的验收项一条都没勾。

---

## 2. P9-A：兼容性与可靠性审计（已完成）

### A1 旧配置升级：**计划指出的冲突是真的，而且更严重**

计划 §A1 怀疑「配置 DSL 给 `mode` 默认 `off`，旧用户 `enabled:true` 可能被静默停用」。
核实结果：**属实**。

根因在 `DEFAULT_CONFIG` 的生成方式上（`src/config/resolve.ts`）：它**由 schema 生成**，
所以 `presence.mode` 的 schema 默认值会被写进每一份默认配置；`resolveConfig` 逐层合并之后，
**每一份旧配置都带上了一个显式的 `mode:'off'`**，而 `resolveMode` 看到显式值就照办——
`enabled:true` 的老部署升级后一条消息都不会发。

修复前实测（`resolveConfig` 的真实产物）：

    resolved.presence.mode = "off"      <- 合成器补的
    resolved.presence.enabled = true
    resolveMode(resolved.presence) = off  <- 静默停用
    裸对象 resolveMode({enabled:true}) = live  <- 旧单测只证明了这个

这就解释了为什么 P5 的单测是绿的：它们测的是**裸对象**，而真出事的是**合成链路**。

修复：`mode` 的 schema 默认值从 `'off'` 改成 **空串**（= 未指定），枚举里加一项
`'按总开关推断'`。`resolveMode` 本来就懂「缺席 → 退回 `enabled`」，所以修复只需改默认值。

修复后（同一组用例，全部通过）：

| 用户写的配置 | 合成后 mode | 最终模式 | 会不会跑 |
|---|---|---|---|
| 旧配置：只有 `enabled:true` | `""` | `live` | 会（**升级后行为不变**） |
| 旧配置：`enabled:false` | `""` | `off` | 不会 |
| `mode:'shadow'` + `enabled:true` | `shadow` | `shadow` | 跑但**不发** |
| `mode:'off'` + `enabled:true` | `off` | `off` | 不会（立刻停发） |
| `mode:'live'` + `enabled:false` | `live` | `live` | 会（mode 是新权威） |
| `mode:'dry-run'`（写错） | `dry-run` | `live` | 会（不猜、退回旧口径） |

测试：`test/presence-legacy-config.test.ts` **13 例**，全部走真实入口
（`resolveConfig` → `resolveMode` → `presenceAppliesTo`），不是裸对象。

### A2 热切换：`off` 原先**不会**热起来

计划 §A2 指出「`wirePresence()` 在初始 `off` 时直接返回，不创建 `GroupPresence`」。核实：**属实**。
后果是 `off → shadow` 必须重启才生效，与 P5-B 承诺的热切换矛盾。

两处修复：

1. **装配层不再早退**：`wirePresence` 无论如何都建执行器（只是几个 Map，不起定时器、不读盘），
   `off` 只影响是否真的跑。
2. **判据从 `enabled` 改成模式**：`presenceAppliesTo()` 现在用 `presenceRuns()` →
   `modeRuns(resolveMode(...))`。这是关键——原来它只认 `enabled === true`，于是
   `mode:'shadow'` + `enabled:false` 的配置连旁听都不记，影子模式就没东西可观察。
   `mode` 缺席时 `resolveMode` 退回 `enabled` 口径，旧配置行为逐字节不变。

现在四条热切换路径都有测试（`presence-legacy-config.test.ts`）：
`off→shadow`（立即开始旁听）、`live→off`（下一条消息就停）、`live→off→live` 反复切
（判据不残留）、白名单与模式正交（白名单管哪些群，模式管跑不跑）。

**仍需注意**：`live → shadow` 时**在途**的模型结果由另一道闸门负责（`sendGate` 每次发送前
现取），这条 P5-B 已有测试（`test/presence-mode.test.ts`）钉住，本次未改动。

### A3 发送耗时：计划指出的口径错误**属实**

计划 §A3：`recordOutcome()` 里 `sendLatencyMs` 用的是 `ctx.clock.now() - startedAt`，
而 `startedAt` 是**整轮开始**时间，含模型耗时。核实：**属实**，而且 `sendAttempts` 只在
`outcome.kind === 'spoke'` 时 +1，等于**只统计成功**。

修复：

- 发送耗时改为在 `presence-send.ts` 的 `platform.api.sendGroupMessage` **前后**单独计时；
- 新增 `noteSend({groupId, latencyMs, ok})`：成功与失败**都**进 `sendAttempts`；
- 新增 `sendFailures` 计数：只统计成功会让「发送成功率」永远 100%，而「尝试 5 次成功 1 次」
  才是排障时第一个要看的东西；
- `presence-cycle.ts` 里原来那段混口径的累加**删掉**（注释写明发送耗时不在这里记）。

测试：`test/presence-send-timing.test.ts` **7 例**，含一条端到端用例：模型假耗时 2 秒、
平台立即返回 → `modelLatencyMs >= 2000` 而 `sendLatencyMs === 0`。这条用例在修复前必红
（修复前两段混在一起，发送会被记成 2 秒）。

### A4 文档与实现边界：三处不实描述已更正

| 计划指出的问题 | 处理 |
|---|---|
| `socialGuard='warn'` 只记录不拦，不能把离线 enforce 成绩当线上默认 | `docs/10b` §2 与 §9 已明写；离线评测报告里那句「如果线上切成 enforce」也标了是**假设值** |
| `shadow` **不会**进入表情流程，不能按 P8 手册「在 shadow 里观察会选哪张图」测试 | `docs/10b` §5 已加醒目更正框：这条路**做不到**，原因是 `presence-afterspeak.ts` 只在 `spoke` 时调用，属于「根本没走到那一步」；想先看选图贴切度要么进 D 阶段，要么另做一个**目前不存在**的只读预览 |
| `group-continuity-block` 只注入**话题与上次说话时间**，不等于注入其他成员消息 | `docs/10b` §6 已加说明：评估连续性要看**整包**（`background` + 连续性块 + `sentBlock`） |
| 评测文档里仍有「41 条」，实际 52 条 | 全部改为**动态或正确数字**：`eval/group/README.md`、`eval/group/llm/README.md`、五个 `.mjs` 的注释；并在 `report.corpus` 里加了 `{cases, ids}`，报告自带语料条数，文档以后不必再手写 |

关于最后一条，加了一条**结构性防护**：`report.corpus.cases` 与 `report.corpus.ids` 由
`CASES.length` 现算，报告的 `notes` 里也写明「语料条数以 report.corpus.cases 为准，不要在
任何文档里写死条数」。LLM 通道的自测断言原本写死「全部 41 条」，现在改成「全部语料」。

### A 阶段验收自检（对照计划 §2 的交付标准）

| 要求 | 状态 |
|---|---|
| 用真实旧版 `suite.json`（仅 `enabled:true` + 白名单）做 load→resolve→wire 端到端 | ✅ `presence-legacy-config.test.ts` 13 例 |
| 明确区分「用户显式写了 off」与「合成器补了默认 off」 | ✅ 默认值改为空串，两者在数据上就不同；测试逐个覆盖 |
| 增加旧配置迁移与新配置冲突测试，不只测 `resolveMode()` 裸对象 | ✅ 全部走 `resolveConfig` |
| `off → shadow` 不重启能否开始 | ✅ 能（装配不再早退 + 判据改为模式） |
| `shadow → live` | ✅ 逻辑同一条路径，测试覆盖 |
| `live → shadow/off` 在途结果不外发 | ✅ P5-B 已有测试（本次未改） |
| `live → off → live` 定时器/游标/服务恢复一致、不补发旧消息 | ✅ 判据反复切换的用例 + 既有「热加载不补发」用例 |
| 后台核对模式值与**实际运行状态** | ⚠️ 诊断页给的是**发送闸门在读的同一个函数**（不是配置字符串），但「实际是否会跑」还需在实机上看一眼 |
| `sendAttempts` 记实际尝试（含失败） | ✅ 新增 `sendFailures`，成功失败都计数 |
| 加 FakeClock 测试避免仪表盘误导 | ✅ 7 例，含「模型慢 ≠ 发送慢」 |

---

## 3. P9-B：真实模型影子评测（**未执行**）

通道本身已就绪，本次**重跑了自测**确认它没被 A 阶段的改动碰坏：

    cd plugins/dsh-channel-qq
    npm run build:lib
    node eval/group/llm/run.mjs --selftest     # 退出码 0

自测四条断言全过：52/52 走到生产解析 · 绊线 0 次 · 报告三件套写出 · 覆盖全部语料；
子进程里故意打开闸门时绊线响 1 次、退出码 1；401 与非 JSON 分别记 `http-error` / `bad-json`。

**为什么没跑真实模型**：本机没有可用的端点凭据。已探测到的客观情况：

- `127.0.0.1:8000` 有服务在听，`GET /v1/models` 返回 **401**（是 OpenAI 兼容端点，但要鉴权）；
- 环境里只有 `ANTHROPIC_BASE_URL`（指向 `opencode.ai`）与 `ANTHROPIC_MODEL`，
  **不是** OpenAI 兼容协议，`eval:group:llm` 用的是 `/v1/chat/completions` 那套；
- 没有任何 `EVAL_GROUP_LLM_*` 环境变量。

按计划 §3 的明确要求「**不要填写真实 API Key 进 Markdown 或仓库**」，我没有把任何凭据写进
仓库，也没有拿不属于本任务的凭据去跑。未配置时运行器的行为就是计划要求的：
**打印可复现命令、退出码 2**（不是失败）。

要跑起来，操作者只需在自己机器上：

    $env:EVAL_GROUP_LLM_BASE_URL = 'http://127.0.0.1:8000/v1'
    $env:EVAL_GROUP_LLM_MODEL    = '<实际部署使用的模型>'
    $env:EVAL_GROUP_LLM_API_KEY  = '<本机设置的凭据>'
    $env:EVAL_GROUP_LLM_REPEAT   = '3'
    npm run eval:group:llm

报告落在 `eval/group/llm/out/`（已 gitignore）。**这些产物本次不存在**，因为没跑。

---

## 4. P9-C / D / E / F：未执行

四项都需要真实群或真实发送，本次**一项都没做**。理由与前置条件：

| 阶段 | 缺什么 |
|---|---|
| P9-C 真实 shadow 观察 | 一个参与者知情的测试群 + 操作者授权启用 `mode:'shadow'` |
| P9-D 四类错误校准 | 前置是 C 的样本；没有样本就没有「误拦率」可谈 |
| P9-E 授权 live | 前置是 A 通过（已）+ B 完成（未）+ C 已人工检查（未）+ 操作者明确批准（未） |
| P9-F 表情与双群 | 两次独立授权 + 图库素材审核 |

`socialGuard` 保持默认 `warn`（只记不拦），**没有**被自动改成 `enforce`——计划 §9 第 7 条明确禁止。

---

## 5. 本次改动的文件与接口

### 配置（**行为变更，但旧配置不变**）

| 项 | 变更 |
|---|---|
| `presence.mode` | 默认值 `'off'` → `''`（未指定）。枚举多一项「按总开关推断」。**旧配置升级后行为不变**（这次修复的意义就在这里） |
| `presence.mode` 的 help | 补上「留空 = 按 enabled 推断」的说明 |

### 接口

| 接口 | 变更 |
|---|---|
| `presenceAppliesTo(settings, groupId)` | 判据从 `enabled === true` 改为 `modeRuns(resolveMode(settings))` |
| `presenceRuns(settings)` | **新增**（纯函数）：这套能力现在要不要跑 |
| `GroupSchedulerStats.sendFailures` | **新增**：失败的发送尝试数 |
| `GroupSchedulerBook.noteSend({groupId, latencyMs, ok})` | **新增** |
| `CycleDeps.noteSend` / `CycleContext.noteSend` | **新增**（可选，缺省不记） |
| `PresenceSettings.mode?` | **新增**（可选字段，结构类型） |
| `wirePresence()` | `off` 不再早退（返回值形状不变） |
| 离线报告 `report.corpus` | **新增** `{cases, ids}` |

### 测试

| 文件 | 例数 | 钉住什么 |
|---|---|---|
| `test/presence-legacy-config.test.ts` | **13**（新增） | 旧配置兼容（走真实合成链路）、显式值优先、热切换四种路径、白名单与模式正交 |
| `test/presence-send-timing.test.ts` | **7**（新增） | 发送耗时只含平台调用、失败也计入尝试、按群分开 |
| `test/presence-config.test.ts` | 既有 | 合同默认值改为 `mode: ''` |
| `test/presence-resource.test.ts` | 既有 | 补 `sendFailures` 字段 |
| 全量 | **1631 / 1630 通过 / 0 失败** | `npm run verify` 三段全绿（unit 9 / static 32 / compose 1） |

`check:layers` 467 文件通过；`check:size` 通过；`npm run eval:group` 52 条 PASS 49 / FAIL 0 / WARN 3。

---

## 6. 证据级别（对照计划 §8 的表）

| 级别 | 本次是否达成 | 证明 |
|---|---|---|
| `offline-test` | ✅ | `test/presence-legacy-config.test.ts` 13 例、`test/presence-send-timing.test.ts` 7 例、全量 1631 例；`npm run verify` 退出码 0；适用提交见 §7 |
| `host-load` | ⚠️ 部分 | `npm run verify` 的 compose 段通过（`dsh --dump-config` 194 个 loader 行），说明配置能合成、插件能装载；但**没有**在真实宿主里跑过 `off→shadow` 的热切换 |
| `real-api` | ❌ | 没有真实模型调用：无端点凭据（见 §3） |
| `real-send` | ❌ | 没有真实 QQ 发送：未授权 |

**不要把 `offline-test` 的绿灯读成「可以上线」**：A 阶段修的是「配置与计时的正确性」，
而 P9 真正要回答的「她说得合不合适」一点都还没开始测。

---

## 7. 回滚

本次是一笔独立提交（`fix(group): P9-A 旧配置兼容、热切换与发送计时`），可整笔 `git revert`。

单点回滚：

| 想退回什么 | 怎么退 |
|---|---|
| `mode` 默认值 | 把 `''` 改回 `'off'` —— **但请先读 §A1**：那会让所有 `enabled:true` 的老部署静默停用 |
| `off` 也建执行器 | 在 `wirePresence` 恢复早退。代价：`off→shadow` 又要重启才生效 |
| 判据认 `enabled` | 把 `presenceAppliesTo` 改回 `settings.enabled !== true` 就返回 false。代价：`mode:'shadow'` + `enabled:false` 不再旁听 |
| 发送分段计时 | 删 `noteSend` 三处接线，字段回到 0。代价：仪表盘又把模型耗时算进发送 |

---

## 8. 下一步（需要你决定的事）

1. **P9-B**：在本机设好 `EVAL_GROUP_LLM_*` 三个变量（端点 8000 那个 401 的服务如果是你的，
   配上它的 key 就行），然后 `npm run eval:group:llm`。这一步不发任何 QQ 消息。
2. **P9-C**：指定一个测试群号并授权 `mode:'shadow'`。我可以在那之后跑诊断、读影子日志、
   但**不会**自己去改配置。
3. **P9-E**：只有在 B、C 都看过之后，才谈 `live`。

我不会把 `socialGuard` 从 `warn` 改成 `enforce`，也不会启用任何真实群的自主发送——
这两件事按计划 §9 第 3/7 条都要等你明确授权。
