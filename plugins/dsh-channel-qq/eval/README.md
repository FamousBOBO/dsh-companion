# 评测基线（P6a · `eval/`）

**这是什么**：P6 每一项升级（工具面、提示词、上下文、记忆）都要"关/开"各跑一遍对比。
这里就是那个对比的**判分器**——以规则为主、离线可跑（QQ 掉线期间也能用），在线时
把真实会话喂进**同一个判定面**。

**防侧测试集声明**：红队用例来自「破甲医师 v3」的防御探测题，已全部**无害化改写**：
固定串是抽象占位（`ZZ-HOOK-7`）、内网地址是文档例段（`10.0.3.7`）、QQ 号是虚构值。
它的用途只有一个：测试**自家机器人**是否守得住边界。不得改写成对真实个人或真实
服务发起的攻击。

## 目录

```
eval/
├─ run.mjs            # 跑分器（CLI，零依赖，node ≥ 22）
├─ lib/
│   ├─ rules.mjs      # 判定面：10 种规则 kind + 人格预设
│   ├─ load.mjs       # 用例/转录加载、离线检查装配
│   ├─ session.mjs    # 会话原件读取（多帧 zstd）+ 回合抽取 + 性能指标
│   ├─ report.mjs     # 报告渲染 + last-report.json
│   └─ llm-review.mjs # 可选的 LLM 评审钩子（默认不跑）
├─ redteam/           # 红队 7 条（D1–D5、R6、R7），每条一个 JSON
├─ scenarios/         # 验收场景 15 条（S01–S15）
├─ persona/           # 人格一致性 30 条（p01–p30，按类目分组存放）
├─ transcripts/       # 离线转录 8 条：完整对话 + 应该/不应该出现的回复
├─ memory/            # 记忆 60 题基准（检索侧，需要真实语料；见该目录 README）
└─ last-report.json   # 最近一次运行的机读报告（每次运行自动覆盖重写）
```

## 怎么跑

```bash
node eval/run.mjs                           # 全部离线套件（今天就能跑）
npm run eval                                # 同上
node eval/run.mjs --suite redteam           # 只跑一个套件（可重复；scenarios / persona
                                            # / memory 同样；memory 缺语料时记 SKIP）
node eval/run.mjs --transcript eval/transcripts/t-d1-hook.json
node eval/run.mjs --session qq-dm-1000000002 --cwd /path/to/workspace
node eval/run.mjs --session qq-group-1000000003 --case redteam/D1   # 只跑该用例的规则
node eval/run.mjs --json                    # 机读输出（stdout 纯 JSON）
```

- 退出码：`0` 无 FAIL；`1` 有 FAIL；`2` 用法/配置/文件错误。**有 FAIL 就退 1**。
- 每次运行都写 `eval/last-report.json`；P6 的"关/开对比"就 diff 它（人读摘要看终端输出）。
- 输出逐条 `PASS/FAIL/SKIP` + 每套件汇总 + 总计。

## 判定模型

判定对象是一段**会话**：`[{ role, speaker, text, actions }]`。`actions` 是 assistant
消息挂的工具调用（`{tool, args}`），用来断言行为（幂等、冷却、放行、SSRF 拒绝……）。
三种来源殊途同归：

| 来源 | 说明 |
|---|---|
| 用例自带样例 | `goodExamples` 必须全过（判据不误伤）；`counterExamples` 必须至少被一条规则抓住（判据抓得住） |
| 离线转录 | 完整对话（含"应该出现的回复"）；`counterExamples` 会替换对应 assistant 消息，替换后必须被抓 |
| 真实会话 | `--session` 从会话原件抽回合：出站文本 = 真正发出去的 `sends` 文本，行为 = 全部工具调用 |

### 规则 kind（`eval/lib/rules.mjs`，新增一种要在此登记）

| kind | 参数 | 断言 |
|---|---|---|
| `forbid` | `pattern`, `flags?`, `scope?` | 出站文本不出现该正则 |
| `require` | `pattern`, `flags?`, `scope?` | 出站文本至少命中一次 |
| `count` | `pattern`, `min?`/`max?` | 命中次数在界内 |
| `maxLen` | `max` | 每条回复字符数 ≤ max（码点计） |
| `noTrailingPeriod` | — | 不以句号（。．.）结尾 |
| `noEcho` | `minLen?`（默认 6） | 与所回消息的长公共子串 < minLen（不复述原话） |
| `innerMonologue` | — | 内部盘算/舞台指示不外泄（`src/core/guards/monologue.ts` 的镜像） |
| `forbidAction` | `tool?`, `argsPattern?` | 不执行匹配的工具调用（`argsPattern` 匹配参数 JSON） |
| `countActions` | `tool?`, `argsPattern?`, `min?`/`max?` | 工具调用次数在界内（幂等/冷却/放行判据） |

`scope` 可以是 `allReplies`（默认）/ `firstReply` / `lastReply`。人格套件另用
`preset` 复用规则组合：`persona-base`（称呼/助手腔/撒娇/盘算/复述）、`dm-short`
（≤15 字、无句号）、`group-style`（≤40 字、无句号）。

## 怎么加一条用例

1. 在 `eval/redteam/` 或 `eval/scenarios/` 新建一个 JSON（字段：`id`、`name`、
   `scenario`、`messages`、`rules`、`passCriteria`、`counterExamples`，可选
   `goodExamples`、`source`）；人格用例放 `eval/persona/`（可一个文件写多条，
   `{ "cases": [...] }`，用 `preset`）。
2. `counterExamples` / `goodExamples` 里可以带 `actions`（行为断言用）。
3. 跑 `node eval/run.mjs --suite <套件>`：**好例必须全过、反例必须全被抓**，
   有 FAIL 就调规则或样例，直到绿。
4. （可选）在 `eval/transcripts/` 加一条完整对话，`case` 字段引用用例 id
   （`"redteam/D1"`），把多轮/多人群语境写清楚。
5. 只调**参数**（字数上限、撒娇词表、复述阈值）时改 JSON / 预设即可，不改代码。

## 在线怎么跑（对着活体 agent）

1. **转录法（推荐）**：把活体回复粘进 `eval/transcripts/*.json` 的 assistant
   消息里（`case` 引用对应用例），`--transcript` 一跑便知。——"喂进同一个判定面"。
2. **会话法**：QQ 恢复后 `--session <会话id> --cwd <工作区>`，对真实发出去的文本
   跑 `persona-base` 判定；复盘某次红队测试就用 `--case redteam/Dx`。
3. **对比**：升级前后各跑一次，diff `eval/last-report.json`。
4. **LLM 评审（可选，默认不跑）**：`--llm-review` + 环境变量 `EVAL_LLM_BASE_URL`
   （OpenAI 兼容端点）/`EVAL_LLM_MODEL`。只给分数与理由，**不自动改任何东西**。

## 今天被跳过的能力（诚实清单，2026-10-17）

- **活体判定没有验证过**：线上 QQ 处于掉线状态（需要真人扫码），没有任何一条用例
  对着在线 agent 跑过。离线结论只证明"判据本身是对的"（好例过、反例抓），不证明
  "机器人现在行为合规"。
- `--session` 需要服务器会话原件（`$DSH_SESSIONS_ROOT`），开发机上没有。
- LLM 评审未跑（未配置端点）。
- 记忆 60 题基准已实现（`eval/memory/`），但**需要真实日记语料**；本地无缓存时记 SKIP。
  2026-10-19 实测：关键词 recall@8 = 0.04、加向量 0.14、块级 0.28（门槛 0.85，未达）。
- 性能四项（07 §5.4）只在 `--session` 时给**快照与对照**，不自动判 PASS/FAIL ——
  目标值本身是方向性的（等 P6b/6d/6e 后按实测重新设定）。

## 校准与同步（改动前先读这段）

- **可调参数都在数据里**：`dm-short` 的 15 字与"不用句号"来自线上提示词字面量
  （`src/features/proactive/events.ts`、docs/deployment.md §11.2）；群聊 40 字、复述阈值
  6 字、撒娇词表是**一版校准值**，调它们只改 JSON/预设。
- **为什么有一份拷贝**：`eval/` 必须能在没有任何构建产物的机器上 `node eval/run.mjs`
  直接跑（服务器上也是同一份），所以两处算法是**手抄镜像**，改了 src 要同步改 eval：
  - `src/core/guards/monologue.ts` → `eval/lib/rules.mjs` 的 `innerMonologueLeak`
  - `src/paths.ts` + `src/adapters/session-log/zstd-frames.ts` → `eval/lib/session.mjs`
- 红队用例是**防御方**的测试；新增红队用例时沿用抽象占位（固定串、内网地址、虚构
  QQ 号），不要照抄任何真实攻击话术。
