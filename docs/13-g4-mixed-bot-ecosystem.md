# P9-G4 补充修订实施记录：混合型机器人生态评测（2026-11-09）

对应 `13-G4-mixed-bot-ecosystem-amendment.md`（下称「补充修订」）。**起点**：`feat/group-social-p0` 分支，
承接 `docs/11`（P9-A 验收）、`docs/12a` / `docs/12b`（P9-G0–G2 镜像基线）。

**这份文档只报告做到的部分，且逐项标了证据级别。** 补充修订 §5 要求的分层真实语料
（Bot-to-Bot / Bot-to-Human / Mixed / Unknown / 话题变化五类）本次**一条都没有**：
生产群是单群、真实流量以人类为主、间隔以小时计（`docs/12b` §6 的实测）。
所以本阶段的产物是**能力与度量**，不是评测结论。

---

## 1. 结论先说

| 补充修订章节 | 状态 | 证据级别 |
|---|---|---|
| §2.1 统一身份类型（self / known_bot / known_human / unknown） | **完成** | `offline-test` |
| §2.2 Bot 注册表（按群组织、版本可追溯） | **完成** | `offline-test` |
| §2.3 身份变更（历史事件不被改写、回放用当时那一版） | **完成**（设计 + 单测） | `offline-test` |
| §3 消息上下文扩展（`senderKind` 随消息冻结） | **完成** | `offline-test` |
| §4.1 Bot 对话循环风险 | **完成**（判定 + 提示词 + 建议） | `offline-test` |
| §5 分层采样（A–E 五类） | **未执行**：需要混合 Bot 群的真实语料 | — |
| §6 十项指标 + 分层报告 | **完成**（代码与离线夹具） | `offline-test` |
| §7 人工盲评 | **未执行**：需要真实样本 + 评分人 | — |
| §8 回放与报告元数据 | **部分**：元数据结构已定，回放未跑 | `offline-test` |
| §9 验收清单 | 见 §7 逐条勾选（身份 6/6、社交判断 4/6、评测质量 5/6、安全边界 4/4） | — |

**没有任何一条真实 QQ 发送，没有任何真实模型输出用于本阶段的结论。**
补充修订 §9「安全边界」的四条全部成立（见 §7.4），那是本阶段唯一可以说「已验证」的一组。

---

## 2. 身份模型：为什么只能来自登记（§2.1 / §2.2）

### 2.1 只有两个来源，没有第三条路

`src/core/participant.ts` 的判据顺序是**有意义的**，不是随手排的：

```text
1. userId === selfId  → self           （她自己的号来自 config.selfId，属于可信平台身份）
2. 注册表命中          → known_bot / known_human
3. 其余               → unknown
```

`self` 排在注册表之前，是因为「她是谁」由配置决定，不该被一份数据文件覆盖。
`selfId` 缺省（`undefined`）时**不猜**：不会拿 `0` 或别人的号顶替，那条消息就按注册表判——
单测 `participant.test.ts` 钉了这一条（不传 `selfId` 时她自己的号也是 `unknown`）。

### 2.2 形状不对就整条丢掉，不补默认值

`normalizeMember()` 遇到缺 `kind`、`kind` 不在 `bot`/`human` 里、`userId` 不是正整数时
**返回 `null`**，而不是补一个默认 kind。理由写在文件头：注册表是「谁已确认」的唯一来源，
补默认值等于凭空确认了一个身份，而错误方向的确认（把人类标成 bot）会让她的社交判断
建立在假事实上——并且**错得看不见**（群里没人会发现她认错了人）。

`unknown` 同理：它不是缺陷，补充修订 §2.1 明写「身份未知不妨碍理解消息内容，但不得将
未知身份当成已确认事实」。所以未登记成员在提示词里被**显式点名**为「未登记」，
而不是渲染成普通群友（那样模型会默认它是人）。

### 2.3 按群隔离（§2.2 的 groupId + userId）

注册表是 `groups: [{ groupId, version, members }]`，查人必须带群号：`registryFor(file, groupId)`。
同一个号在 A 群登记为 `bot`，在 B 群查不到 → B 群是 `unknown`。这不是保守，是事实：
那个号在别的群可能不是同一个实体，或者干脆不是同一个人。

两处单测钉住它：`participant.test.ts`「跨群隔离」与 `pipeline-participants.test.ts`
「A 群登记的 bot 在 B 群是 unknown」。

### 2.4 版本可追溯（§2.2 / §2.3）

`adapters/fs-store/participant-registry.ts` 的三条口径：

- 注册表自己写了 `version` → 用它；
- 没写 → 按**文件内容**算 `sha256` 前 16 位；
- **不用语义哈希**：那要先定义「什么算同一份注册表」，等于再引入一套判断。内容哈希不会撒谎。

缓存按 `(路径, mtimeMs, size)`。`size` 也看，是因为某些文件系统 `mtime` 只到秒，
同秒内改等长内容只看 `mtime` 会漏。文件被删 → 缓存立刻作废。
这条路径在**每条群消息**上都会被调用，每次 `readFile + JSON.parse + sha256` 是把 CPU 花在不变的东西上。

**历史事件不被改写**：身份在**采集现场**冻结进旁听条目（`AmbientEntry.senderKind`），
不是判断时再查。判断时再查等于用今天的注册表去解释昨天的对话，回放也就没法复现。
代码里两处共用同一个 `resolveParticipant`，就是为了不让「采集时是 bot、判断时是人」这种分叉出现。

### 2.5 注册表坏了不等于插件坏了

`load()` 返回可判别联合 `loaded / missing / invalid`，**绝不抛**：

| 情况 | 结果 | 后果 |
|---|---|---|
| 文件不存在 | `missing` | 全员 `unknown`（**不是错误**：等于没登记任何人） |
| 坏 JSON / `schemaVersion` 不对 / 0 字节 | `invalid` + `problems` | 全员 `unknown` + 一行日志 |
| `stat` / `readText` 抛错 | 收敛成 `missing`，错误码进 `problems` | 同上 |
| 单条成员形状不对 | 丢弃该条 + 一行 `dropped` | 其余成员照常可用 |

最外层还有一道 `.catch`。管线级单测 `pipeline-participants.test.ts` 钉住「身份查询永远不许
炸掉消息链路」：注册表取值函数**抛错**时旁听照记、`senderKind` 缺省。

### 2.6 allowUnknownAsBot 是恒 false 的文档字段，不是开关

配置段 `participants.allowUnknownAsBot` 默认 `false`，**代码里没有任何一个分支读它**。
留这个字段是为了让「能不能把没登记的人当机器人」这件事在后台可见、并有明确答案——
否则下一个人会去加一个 `assumeUnknownIsBot` 开关，而那样一来补充修订 §9
「未登记成员不会被自动推断为 Bot」就只剩提示词在兜了。
`participant-registry.test.ts` 有一条专门钉死这个字段不生效。

---

## 3. 消息上下文扩展（§3）

`senderKind` 沿这条链一路带下去，逐层都是「缺省 = 没查过」，**不是**「缺省 = unknown」：

```text
InboundPipeline.handle
  └─ captureAmbient({ ..., registry })        ← 端口递进来，采集层自己查
       └─ frozenKindOf()                       ← 查不到 → 返回 {}，不带字段
            └─ AmbientEntry.senderKind          ← 冻结进缓冲
                 ├─ JudgeEntry.senderKind       ← 判断输入
                 └─ RiskEntry.senderKind        ← 互动风险判定
```

为什么「缺省 = 没查过」而不是「缺省 = unknown」：两者在提示词里都渲染成「未登记」，
但在**诊断**上是两件事——前者是能力缺失（没装注册表 / 开关关着），后者是事实（查了，没登记）。
混成一个值之后，报告里的「Unknown 保留率」就无法区分「她把人当未知」和「我们根本没装注册表」。

管线级测试钉住三件事：已登记 bot 在采集现场就是 `known_bot`；没装注册表时**不带**
`senderKind`；注册表返回 `null` 或抛错时同样不带。

---

## 4. 社交判断里的 Bot 生态因素（§4.1）

### 4.1 只判风险，不判该不该说

`src/core/bot-ecology.ts` 产出 `botLoopRisk: low | medium | high` 与三个布尔事实
（`semanticDuplicate` / `alreadyAnswered` / `newInformation`）。五个动作仍由模型选，
补充修订 §4 明写「保留原有五动作」。

判据顺序（`reason` 取第一条命中的，也是报告里最可信的那条）：

| 判据 | 档位 | 为什么是它 |
|---|---|---|
| **两个不同的人**说了几乎同一句（双字重合 ≥ 0.9） | `high` | 同一个人说两句是补充说明，不是循环 |
| 3 个人在 5 分钟内对**同一条消息**各回一次 | `high` | 用引用关系判，**不是**用文本相似度（§4.1 明确要求） |
| 尾部连续 ≥ 3 条纯客套 | `high` | 礼貌性互动循环 |
| 已有实质回答，但还有新信息 | `medium` | 要参与就得给点别处没有的 |
| ≥ 2 个已确认 bot 在说话，且都不算实质 | `medium` | 互相打招呼 |
| 其余 | `low` | —— |

### 4.2 两条最容易写错的约束

**（1）不得仅因「上一条来自 Bot」就判高风险。** 单测成对钉住：只有一条 bot 的实质发言 → `low`；
两个 bot 各说各的实质内容 → 不是 `high`。身份不是风险，内容才是。

**（2）不得仅凭文本相似度判循环。** 「重复重启同一话题」的判据是**引用结构**：
同一 `replyToMessageId` 被多少个不同的人回过。没有引用结构时返回 0（判不出就说判不出）。

### 4.3 误判的不对称

`low` 是**兜底档**，不是「不确定档」：没有任何判据命中就给 `low`。理由是代价不对称——
误判高风险的代价是「她该说话时闭嘴」，而这个错误**没人能看见**（没人会抱怨她没说话）。
同样的理由让 `riskAdvice()` 只给建议不替模型选动作：单测断言它不出现「必须沉默」「禁止发言」
这类措辞。

### 4.4 一处刻意的口径修正

`alreadyAnswered` 要求「**至少两个不同的人**说过实质内容」，而不是「有实质内容」。
第一版写成后者，被单测当场抓住：只有一条消息时那一条是**话题本身**，不是对它的回答。
按后者判，她会对每个第一次出现的问题都倾向沉默——那正好是「她变呆了」的典型表现。
这条修正留在 `group-ecology.test.ts` 里，配着它的反例一起。

---

## 5. 提示词里的落点：位置也是设计（§3 / §4.1）

两段新内容各有一个位置，位置错了不会报错，只会让效果慢慢变差，所以用断言钉住：

```text
【你在旁观】（场景）
（你在这个群：…；现在是 …）
人格快照
【这一批的参与者身份】        ← P9-G4 §3，排在判断口径**之前**
【先判断：现在有没有你说话的位置】  ← 既有判断口径
【五种动作，选一个】
【这些情况一律不接】
【这一批的社交结构】           ← P6-A
【互动风险】                 ← P9-G4 §4.1，紧跟场景段之后
【群聊背景】【记忆】【你最近说过的话】
```

身份段排在判断口径**之前**：先知道谁在说话，再读「该不该接」。反过来会让模型先按「普通群友」
形成预期、再被身份段纠正，而纠正一条已成形的预期比一开始就摆对事实难。

风险段紧跟场景段：两段都是「这一刻的形势」，连着读才连贯。

**向后兼容**：两段都为空时输出与不传这两段**逐字节一致**（`group-ecology-prompt.test.ts` 钉住）。
否则每次灰度都会因为「提示词变了一个字节」而需要重跑全部回归。

两段各有一条字数上限（`ECOLOGY_MAX_CHARS = 400`）：它们是上下文，不是资料库。

---

## 6. 评测度量层（§6 / §8）

`eval/group/mirror/` 三层（`metrics.mjs` / `report.mjs` / `README.md`）是**纯函数**，
不产生数据、不调模型、不发送。输入是一批逐条评测记录，输出是总体 + **四层**的聚合与一份 markdown。

### 6.1 为什么必须分层

补充修订 §6 最后一句是这个模块存在的理由：

> 总体指标必须同时报告分层结果，避免 Bot 数量较多导致总体分数掩盖人类互动能力问题。

一个群 20 个 Bot、2 个人类，只报总体的话「她对人类自然不自然」会被 20 条 Bot→Bot 记录
稀释成一条平滑的曲线。所以 `aggregate()` 返回的 `overall` 与 `byScene` **并列**，
且两层用**同一套判据**（单测断言「总体分子 = 四层分子之和」，不是两套口径）。
没样本的层也在结果里（`samples: 0`、指标全 `null`）——用缺键表示会让人分不清
「这层没测」和「代码忘了输出」。

### 6.2 没有标注就返回 null，不给代理值

三项**人工评分类**指标（Bot-to-Human 自然度 / Bot-to-Bot 讨论质量 / 人格独立性）在没有人
标注时返回 `null` + `status: needs-human-label`，**不提供任何代理值**。
有一条专设用例守着它：即使有候选发言、有重复标记、有延迟数据，这三项仍然是 `null`。

分母为 0 时同样返回 `null` + `no-samples`，报告里显示 `—` 而不是 `0.0`；
与「有样本但全错」的 `0.0` 物理上不可能混淆。

### 6.3 这些不算失败（§6 明写）

对 Bot 沉默、没回应每个发言、没加入每个话题、没模仿别的 Bot —— 这四类只进
`behavior`（行为分布），**不进 `failures`**。`failures` 只收五类确定的坏：坏输出、
目标未命中、被 veto、身份不一致、高风险场景下仍给出候选。

### 6.4 一个已知的口径局限

`botLoopRiskDetectionRate` 的口径是「`high` 占比」，它把「这批场景本来就容易起循环」
和「她判得准」混成了一个数：语料偏 Bot-to-Bot 时这个值会虚高，读的人会当成识别率高。
已按 note 标成 neutral（覆盖率非好坏）。要真正回答「她识别得准不准」，需要采集侧再给
一个「**实际**发生了循环」的标注——那需要人工或后续 Live 阶段的真实闭环数据，**当前阶段拿不到**。

### 6.5 证据级别段落

报告固定包含一段证据分级（`docs/07-verification-status.md` 的五级），并**必须**有一行
说明 `real-send` 恒为 0 条、且这是设计使然（Mirror-only）而非未测。

---

## 7. 验收清单（补充修订 §9 逐条）

### 7.1 参与者身份 6/6

- [x] 支持 self / known_bot / known_human / unknown — `core/participant.ts` 的 `SenderKind`
- [x] 已登记 Bot 可以稳定识别 — `pipeline-participants.test.ts`「同一个号连续三条都是 known_bot」
- [x] 未登记成员不会被自动推断为 Bot — 形状不对整条丢掉；`allowUnknownAsBot` 恒 false 且无分支
- [x] 身份元数据由代码层注入 — 采集现场 `frozenKindOf()`，模型只看查完的结果
- [x] 注册表版本可以追溯 — 自写 `version` 或内容 `sha256` 前 16 位
- [x] 不同群成员信息不会串群 — `registryFor(file, groupId)`；两处单测钉住

### 7.2 社交判断 4/6

- [x] 不会一律忽略其他 Bot — 身份只影响理解，不构成行为偏见（写进 `BOUNDARY_LINES` 并单测）
- [x] 能识别其他 Bot 已经给出的实质回答 — `alreadyAnswered`（要求两个不同的人）
- [x] 能判断是否存在新的讨论价值 — `newInformation`
- [x] 能识别无意义的 Bot-to-Bot 互动风险 — `assessInteractionRisk` 的三条 high 判据
- [ ] **人类加入话题后能够重新判断** — 代码侧有判据（`newInformation` 在有人类开口时为真），
      但「重新判断」是模型行为，**没有真实样本，不敢勾**
- [ ] **身份未知时不作未经证实的身份假设** — 提示词里写死了「不许从措辞/昵称/回复速度推断」，
      但这是**只有模型能违反**的约束，`offline-test` 证明不了，只能靠 §7 的盲评

这两条不勾的理由与 `docs/11` §3 一致：代码侧判据齐了不等于行为对了。

### 7.3 评测质量 5/6

- [x] 数据按四类场景分层 — `byScene` 四个标签固定存在，0 样本也在
- [x] 盲评覆盖发言、沉默、观察和拦截 — 结构支持（`action` / `decisionTier` / `veto` 都在记录里）
- [x] 机器人循环风险单独统计 — `botLoopRiskDetectionRate`（口径局限见 §6.4）
- [x] 人格独立性单独统计 — `personaIndependence`（等人标注）
- [x] 总体指标与分层指标同时输出 — 同一套判据，单测断言分子可加
- [ ] **回放保留原始注册表版本** — 记录的 `participantRegistryVersion` 字段已定、`version` 能算出来，
      但**回放本身没跑过**（§5 没有真实语料），所以不勾

### 7.4 安全边界 4/4

- [x] 测试环境仍然保持 Mirror-only — `tools/group-mirror` 的 `ALLOWED_ACTIONS = Object.freeze([])`，
      任何 OneBot 动作返回 `retcode:1200`；`forbiddenActionAttempts` 在每次真实运行里都是 **0**
- [x] 真实 QQ API 上行始终为零 — 同上，且伪造 WS 无路由到 QQ
- [x] 不因识别出 Bot 而自动增加发送权限 — 身份只进提示词，不进 `sendGate` / `guardMode` / 限频
- [x] 不因混合生态评测改变生产环境配置 — 生产侧唯一改动仍是 `docs/12a` 那一条 SSE 连接；
      本次全部改动在开发克隆内，未触碰生产目录

---

## 8. 这一阶段没有做到的事

写在这里是为了不让下一个人把「能力就绪」读成「结论已有」：

1. **分层真实语料一条都没有**（补充修订 §5 的 A–E 五类）。生产群是单群、人类为主、
   消息间隔以小时计，Bot-to-Bot 场景根本不存在。
2. **人工盲评没做**。§7 的三项人工指标因此恒为 `null`——这是设计，不是缺口。
3. **回放没跑**。注册表版本能算，但「用 A 版注册表回放当时的对话」这件事没有真实数据可跑。
4. **身份识别的准确率未知**。`participantIdentificationAccuracy` 需要一个「人工核对过的身份表」
   做分母，现在没有。
5. **生产侧没有启用注册表**。`participants.enabled` 默认 `false`，开发克隆里也没打开——
   打开需要有真实登记数据，而我没有资格替操作者决定「谁是机器人」。

---

## 9. 改动清单

### 9.1 新增文件

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/core/participant.ts` | 188 | 身份类型、注册表归一化、按群解析（纯函数） |
| `src/core/bot-ecology.ts` | 189 | 互动风险判定（纯函数） |
| `src/app/inbound/group-ecology-prompt.ts` | 79 | 身份段 / 风险段的渲染 |
| `src/app/inbound/presence-ecology.ts` | 154 | 把身份与风险接进一次判断 + 采集现场冻结 |
| `src/adapters/fs-store/participant-registry.ts` | 256 | 注册表读字节、补版本哈希、按 mtime 缓存 |
| `src/config/sections/participants.ts` | 61 | `participants` 配置段 |
| `src/features/inbound/runtime-deps.ts` | 56 | 入站运行时依赖装配（从 `index.ts` 搬出以守住单文件上限） |
| `eval/group/mirror/metrics.mjs` | 459 | 十项指标 + 四层聚合 |
| `eval/group/mirror/report.mjs` | 229 | markdown 报告 |
| `eval/group/mirror/README.md` | 169 | 口径、分子分母表、三条不能破的规则 |
| `participants.example.json` | 42 | 注册表示例（假号，可直接当模板） |

（路径均相对 `plugins/dsh-channel-qq/`。）

测试：`participant.test.ts`（10）、`participant-registry.test.ts`（29）、`group-ecology.test.ts`（19）、
`group-ecology-prompt.test.ts`（5）、`pipeline-participants.test.ts`（8）、`mirror-metrics.test.mjs`（36）。

### 9.2 修改文件（都是加一条，没重写）

| 文件 | 改动 |
|---|---|
| `src/core/ambient.ts` | `AmbientEntry.senderKind?: SenderKind` |
| `src/app/inbound/presence-judge.ts` | `JudgeEntry.senderKind?: SenderKind` |
| `src/app/inbound/group-ambient.ts` | `CaptureInput.registry` + `frozenKindOf()` |
| `src/app/inbound/group-social-prompt.ts` | `participants` / `risk` 两个可选段 + 一条边界 |
| `src/app/inbound/presence-flow.ts` | `CycleDeps.registry` + 把两段接进 `buildSocialPrompt` |
| `src/app/inbound/presence-cycle.ts` | `CycleContext.registry` + `depsOf` 转交 |
| `src/app/inbound/presence-runtime.ts` | `PresenceDeps.registry` + `cycleContext` 转交 |
| `src/app/inbound/pipeline.ts` | `PipelineDeps.participants`，采集时递进去 |
| `src/features/inbound/presence-wiring.ts` | `participantRegistryOf()` 装配 + 预热日志 |
| `src/features/inbound/index.ts` | `RuntimeDeps.participants` + 装配搬到 `runtime-deps.ts` |
| `src/config.ts` / `src/config/schema.ts` / `src/config/sections/root.ts` | 接入 `participants` 段 |
| `test/golden/config/resolved.txt` / `layers.txt` | 多一段的 diff（5 行 / 80 行） |

**`GroupPresence` 的判断逻辑、Group Memory、普通私聊逻辑都没有重写**，
按补充修订 §10 的最后一句话：只改了身份模型、上下文元数据、社交判断的 Bot 因素、
采样分层、盲评标准、指标与报告。

### 9.3 体量棘轮

过程中四次触发 `check-size` 硬上限（`pipeline.ts` 425 行 / `handle` 64 行、
`presence-runtime.ts` 423 行 / `cycleContext` 61 行、`presence-wiring.ts` 的 `wirePresence` 64 行、
`index.ts` 415 行 / `apply` 62 行）。处理方式都是**拆开或压缩重复的注释**，没有一次用
`--update` 蒙过去——那是这个仓库明确禁止的做法。最终 `check-size` 通过，且基线没有变松。

---

## 10. 验证记录（逐条可复跑）

```text
cd plugins/dsh-channel-qq
npx tsc -p tsconfig.json --noEmit           → exit 0
npx tsc -p tsconfig.test.json               → exit 0
node --test "build/lib-test/test/*.test.js"  → 1706 tests / 1705 pass / 0 fail / 1 skipped（既有）
node --test "test/mirror-metrics.test.mjs"   → 36 tests / 36 pass / 0 fail
node scripts/check-layers.mjs               → 通过（474 个源文件）
node scripts/check-size.mjs                 → 通过
node scripts/check-syntax.mjs               → 通过（41 个脚本）
npm run eval:group                          → PASS 49 · FAIL 0 · WARN 3（共 52），exit 0
npm run eval:group:llm -- --selftest        → 自测 4 项全 PASS，绊线端到端 PASS，exit 0
cd ../..
npm run verify                              → unit 9 ok / static 32 ok / compose 1 ok，exit 0
```

三条 `eval:group` 的 WARN 都是既有缺口（G06 / G10 / G41），与本次改动无关，
且它们本来就标着「只有模型能判断」。

`eval:group:llm --selftest` 用的是**自测夹具**，不是真实模型端点：真实模型影子评测仍然
需要操作者提供凭据（`docs/11` §3 的门槛没变）。它证明的是「绊线与解析链路在」，不是「她判断得对」。

`npm run verify` 的 1 项「跳过/无测试」是既有的 compose 相关跳过，不是本次引入。

---

## 11. 下一步（按依赖顺序）

1. **操作者提供一份真实登记**（哪个号是 bot、哪个是人），打开 `participants.enabled`，
   先用 `shadow` 跑一周，看 `presence-shadow.jsonl` 里身份段的渲染是否合理——这一步不需要任何新型语料。
2. **生产侧唯一允许的改动仍然是那一条 SSE 连接**（`docs/12a`）。G3（测试环境 DSH 接入伪造 WS）
   未开始，它是「端到端 Mirror-only」的最后一块。
3. **分层语料**要等到有混合 Bot 群的测试环境。在那之前 §5 的 A–E 五类只能挂起，
   而 §7 的三项人工指标会一直显示 `null`——那正是本阶段设计的样子。
4. **`botLoopRiskDetectionRate` 的口径**（§6.4）要在有「实际发生循环」标注之后再谈准确率；
   现在把它读成「识别率」是高估。
5. **身份识别的准确率**要等一个「人工核对过的身份表」做分母。在那之前
   `participantIdentificationAccuracy` 恒为 `null`，不许拿「注册表里的条目数」当代理值。

---

## 12. 与生产环境的关系

本次全部改动都在开发克隆（`DSH-dev`）里。生产部署（套件外的 `dsh-production` 目录）
**只读**，且它当前唯一的非默认改动仍然是 `docs/12a` 记录的那一条 NapCat SSE 连接——
本次没有碰它，也没有碰 NapCat 配置。

开发克隆里 `participants.enabled` 同样是 `false`：打开它需要有真实登记，而那是操作者的决定。
