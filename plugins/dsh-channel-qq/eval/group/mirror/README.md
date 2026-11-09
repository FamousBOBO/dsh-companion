# 混合机器人生态评测层（`eval/group/mirror/`）

**这是什么**：把一批**逐条评测记录**（JSON 对象）折叠成 §6 的十项指标，并渲染成人读报告。
它是 `13-G4` 补充修订（混合型机器人生态评测）的**度量层**，不含采集、不含模型调用、不含发送。

**这不是什么**：

> 它**不**产生数据，也**不**证明她说话得体。记录从哪来（NapCat 镜像 / 真实模型通道 /
> 人工回放）是上游的事；这一层只回答"给定这些记录，按 §6 的口径算出来的数是几"。
> 没有人工盲评，自然度 / 讨论质量 / 人格独立性就**永远是 null**——这是设计，不是缺口。

## 目录

```text
eval/group/mirror/
├─ metrics.mjs   # 聚合：总体 + 四个场景分层（纯函数）
├─ report.mjs    # 人读报告（markdown；纯函数，不读时钟）
└─ README.md     # 本文件
```

测试在 `test/mirror-metrics.test.mjs`（`node --test "test/mirror-metrics.test.mjs"`）。

## 为什么必须分层

§6 的最后一句话是本模块存在的理由：

> 总体指标必须同时报告分层结果，避免 Bot 数量较多导致总体分数掩盖人类互动能力问题。

一个群里 20 个 Bot、2 个人类，如果只报总体，"她对人类自然不自然"这件事会被 20 条
Bot → Bot 的记录稀释成一条平滑的曲线，看不出任何东西。所以 `aggregate()` 返回的结构里
`overall` 与 `byScene` **并列**，且两层用**同一套判据**算（不是"总体口径"和"分层口径"）：

```js
import { aggregate } from './metrics.mjs'
const result = aggregate(records)
result.overall.samples            // 8
result.byScene.bot_to_bot.samples // 2
result.byScene.mixed_group.metrics.botRepeatResponseRate // { value, numerator, denominator, status, ... }
```

四个标签固定为 `bot_to_bot` / `bot_to_human` / `mixed_group` / `unknown_participant`，
**没样本的层也在结果里**（`samples: 0`、指标全 `null`）——用缺键表示会让人分不清
"这层没测"和"代码忘了输出"。

## 十条指标与它们的分子分母

| 指标 | 键 | 分子 / 分母 |
|---|---|---|
| 参与者识别准确率 | `participantIdentificationAccuracy` | 标签正确的成员数 / 已核对成员数（来自记录的 `identity` 块） |
| Unknown 保留率 | `unknownRetentionRate` | 正确保留为 unknown 的 / 全部未确认成员 |
| Bot 重复响应率 | `botRepeatResponseRate` | `semanticDuplicate` 的候选发言 / 场景里有别的 Bot 的候选发言 |
| Bot 循环风险识别率 | `botLoopRiskDetectionRate` | `botLoopRisk === 'high'` / 至少两个已登记 Bot 且给出了风险档的记录 |
| 跨 Bot 回复对象准确率 | `crossBotTargetAccuracy` | 目标合法且未被 veto / 候选发言且目标指向已登记 Bot |
| 混合话题切换准确率 | `mixedTopicSwitchAccuracy` | `topicShiftRecognized` / `topicShifted` |
| Bot-to-Human 自然度 | `botToHumanNaturalness` | **人工**（§7 盲评），只在含人类的分层里计入 |
| Bot-to-Bot 讨论质量 | `botToBotDiscussionQuality` | **人工**（§7 盲评），只在含别的 Bot 的分层里计入 |
| 人格独立性 | `personaIndependence` | **人工**（§7 盲评），四层都收 |
| 无价值参与率 | `wastedParticipationRate` | `newInformation === false` / 有 `newInformation` 判定的候选发言 |

分母不是"记录条数"而是**该项指标真正有定义的样本数**——比如"跨 Bot 回复对象"不该把
"她对着人类回的那句"算进分母，那会让指标变成"她有多少次要回 Bot"。

**方向不能靠字面猜**。`botRepeatResponseRate = 0.0` 是满分，`crossBotTargetAccuracy = 0.0`
是零分，两个数在报告里字面完全相同。所以 `METRIC_DEFS` 每项都带 `direction`
（`higher-better` / `higher-worse` / `neutral`），报告表里有一列把它写出来；
`directionOf(key)` 供程序取用。`botLoopRiskDetectionRate` 是**覆盖率**不是好坏——
它高只说明这批里被判成 high 的场景多，必须和 `loopRisk` 分布一起读。

## 三条不能破的规则

### 1. 人工评分类指标：没有标注就是 null

自然度 / 讨论质量 / 人格独立性是 §7 的**盲评项**。没有人工标注时：

```js
result.overall.metrics.botToHumanNaturalness
// → { value: null, status: 'needs-human-label', samples: 0, ... }
result.overall.needsHumanLabel
// → ['botToHumanNaturalness', 'botToBotDiscussionQuality', 'personaIndependence']
```

**绝不用代理值顶替**。回复长度、和别的 Bot 的句面相似度、`latencyMs`、`semanticDuplicate`
都不是"自然"。拿它们当分数，等于把机器偏好写成人的判断，而报告读者不会知道它是编的。

要让它有数，只有两条路：

1. 按 §7 做盲评，按 `humanLabels: { naturalness, discussionQuality, personaIndependence }` 回填；
2. 盲评用的是 1–5 分制时，先过 `normalizeHumanLabels(labels, { scale: 5 })` 换算成 0–1。
   本层**不自动嗅探量纲**——自动嗅探会让"某次只给了 1 分"被当成 0 分，凭空生成一个低分。

### 2. 分母为 0 → null，不是 0

0/0 是"没有样本"，0/5 是"0%"。两者的区别在报告里必须看得见：

| 情况 | `value` | `status` | 报告里 |
|---|---|---|---|
| 没有样本 | `null` | `'no-samples'` | — |
| 有样本、错误率为 0 | `0` | `'ok'` | 0.0 |
| 需要人工标注 | `null` | `'needs-human-label'` | — |

把 0/0 写成 0% 会让"这一层我们什么都没跑"看起来像"这一层全错"。

### 3. §6 明写不算失败的，不进失败计数

修订文档 §6：

> 不要将以下情况直接计为失败：DSH 对 Bot 保持沉默；DSH 没有回应每一个人类发言；
> DSH 没有加入每个话题；DSH 没有模仿群内其他 Bot 的风格。

所以这四类只出现在 `behavior` 里：

- `silentOnBotScene`（对 Bot 场景保持沉默）
- `observed`（选择观察）
- `noCandidateRuns`（没产出候选发言）
- `imitatedOtherBot`（观察到"模仿"标记；注意这是**行为观察**，不是人格独立性分数）

`failures` 只收**确定的坏**：坏输出、回复目标未命中、代码 veto、身份标签与注册表不一致、
自己判了 `high` 风险仍产出候选发言。

## 报告怎么读

`renderReport(result, { generatedAt, realApi, realInbound })` 输出 markdown，段落顺序固定：

1. **总体**（十项指标表 + 缺人标注的清单）
2. **分层结果**（四层各一张表；**0 样本的层只写"该场景无样本"，不出表**）
3. 场景标签缺失（只在真有记录写错/漏写时出现，章节号自动顺延）
4. **行为分布**（§6 明写不算失败的那几类住在这里）
5. **失败计数**（只收确定的坏）
6. **证据级别**（五级 + 一行"real-send 恒为 0 是设计使然"）
7. 元数据（模型 / 人格版本 / 注册表版本 / 来源，全部脱敏）

百分比列的列头是"值（%）"、格子里只有数字，分母为 0 的格子是 **—**。这不是排版洁癖：
把百分号和数字焊在同一格，迟早有人把"—"读成"0"，或者反过来。

## 脱敏

`redact()` 与 `eval/group/llm/record.mjs` 同一口径：**任何 ≥5 位的数字串换成 `<长数字号>`**。
QQ 号 5–11 位、群号 6–12 位，都不能进报告——报告会被贴进工单和聊天窗口。
3–4 位的假消息号（`504`、`1322`）保留，否则报告对不上语料。

## 证据级别（照 `docs/07-verification-status.md`）

| 级别 | 本层是否构成证据 | 说明 |
|---|---|---|
| `offline-test` | **是** | `node --test "test/mirror-metrics.test.mjs"` 可复现 |
| `host-load` | 否 | 不装载插件、不起宿主 |
| `real-api` | 取决于记录 | 本层只消费记录，不发起模型调用 |
| `real-inbound` | 取决于记录 | 记录若来自 NapCat 镜像，则由采集侧保证 |
| `real-send` | **否，且恒为 0** | Mirror-only：平台上行始终为零 |

> **real-send 恒为 0 条，这是设计使然（Mirror-only），不是未测。**
> 本层从不发送任何 QQ 消息；这里的"零发送"是约束，不是成绩，也不是缺口。

口径说明：`docs/07-verification-status.md` §1 的五级是 offline-test / host-load / real-api /
real-send / hardware；`real-inbound` 是镜像通道验收表（`docs/12a`、`docs/12b`）里的一级，
本模块两项都认。

## 已知边界

1. **它不知道记录是不是真的**。上游把 `sceneLabel` 写错，本层就照着错的分层算（会点名，
   不会静默）。记录的**可信度**是采集侧的责任。
2. **它不猜身份**。身份相关指标只用记录里 `identity` 这个"采集侧已按注册表核对过"的块；
   本层绝不从正文、昵称、回复速度或"像 AI 的措辞"推断谁是 Bot（§2.1 最后一条）。
3. **它不给总体一个"分数"**。十条指标之间没有权重，本层也不打算造一个——加权总分会让
   "人类互动变差"被"Bot 重复率变低"抵消掉，而那正是 §6 要防的事。
4. **回放要带注册表版本**。同一条记录用不同版本的注册表重算，属于**新的评测版本**，
   不能覆盖旧结果（§8 最后一段）。本层把 `participantRegistryVersion` 原样带进
   `provenance`，供上游对齐。
