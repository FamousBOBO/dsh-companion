# 真实模型影子评测（`eval/group/llm/`）

**这是什么**：把**线上的那一份提示词**发给**真实模型**，让它给出那一行决策 JSON，然后交给
**线上的那一份解析器、校验器、限频器**判能不能执行；平台端口是**绊线**——任何一次发送调用
都会直接抛错并记 HARD FAIL。全流程**零 QQ 发送**。

**这不是什么**：

> 它**不**证明"线上她说话得体"。语料（当前 52 条）是人工构造的，没有真人盲评，也没有真实群聊导出。
> 它证明的是三件事：① 真实模型在这些场景下会给出哪一档输出（decision / silent / invalid）；
> ② 同一套代码把这些输出收敛成了什么（发 / 不发 / 被 veto）；③ 这次判断花了多少 token 与时间，
> 而且**一次都没有真的发出去**。

证据级别（照 `docs/07-verification-status.md` 的五级口径）：

| 级别 | 本通道是否构成证据 |
|---|---|
| `offline-test` | **部分**：解析/校验/限频是离线就能复跑的代码路径，但输入来自真实模型 |
| `real-api` | **是**。模型调用是真的（除非跑 `--selftest`，那时端点是本地假服务） |
| `real-send` | **否**。平台端口是绊线，零 QQ 消息 |
| `host-load` | **否**。不装载插件、不起宿主 |
| `hardware` | **否** |

## 目录

```
eval/group/llm/
├─ run.mjs           # 运行器（CLI；退出码 0/1/2）
├─ env.mjs           # EVAL_GROUP_LLM_* 的读取、校验与"没配就说没配"
├─ impl.mjs          # 生产模块加载（build/lib → src）+ 影子闸门探测
├─ pipeline.mjs      # 每条示例：提示词 → 真实模型 → 解析 → 校验 → 限频 → 绊线平台
├─ port.mjs          # 真实模型 CompletePort + **绊线平台** + token/成本
├─ record.mjs        # 逐条记录（JSONL）与聚合（**不算准确率**）
├─ render.mjs        # 人读报告：离线一段 + 真实模型一段，绝不合并
├─ persona.mjs       # 人格快照（foundation 抽取器 + 生产归一化器）
├─ fake-server.mjs   # 本地假 OpenAI 服务（只给自测与演练用）
├─ selftest.mjs      # 自测断言：绊线端到端、异常路径、报告三件套
├─ out/              # 运行产物（每次覆盖写；.gitignore 已挡）
└─ README.md         # 本文件
```

**这个目录里没有一行判定**。提示词、解析、校验、限频、人格归一化全部 `import` 生产模块：

| 生产模块 | 真实导出 | 在评测里干什么 |
|---|---|---|
| `app/inbound/group-social-prompt` | `buildSocialPrompt` | 组这一轮的提示词（与线上同一份） |
| `app/inbound/group-social-decision` | `parseSocialDecision` / `validateSocialDecision` / `sendsMessage` | 解析档、目标校验、动作是否发消息 |
| `app/inbound/presence-flow` | `runPresenceCycle` / `DEFAULTS` | 整条流程 + 全部默认值（70 字、10 分钟窗、5 分钟冷却、每小时 3 条） |
| `core/presence` | `speakVerdict` / `emptyPresenceState` | 限频记账（组合通道直接调它） |
| `app/inbound/group-persona` | `normalizePersonaSnapshot` | 人格快照的结构归一化（线上消费端那一份） |
| `companion-foundation/group-persona.mjs` | `buildGroupPersonaSnapshot` | 人格文件 → 群聊可见快照（标题白名单、私聊小节否决） |

## 怎么跑

### 0. 没配端点时（这是**预期**行为，不是失败）

```bash
cd plugins/dsh-channel-qq
node eval/group/llm/run.mjs
# → 打印怎么配，退出码 2
```

退出码 2 = "没打算跑"（缺 `EVAL_GROUP_LLM_BASE_URL`，或端点不是 http/https）；
退出码 1 = "跑了但没拿到成绩"——要么有硬失败（绊线被触发 / 出现真实发送），要么**一条有效输出都没有**
（端点不可达、key 错、全部超时：有效输出率 0%）；
退出码 0 = "跑完且零发送"。
三者分开，是为了让 CI 能把"没配置""配置坏了""跑通了"区分开——把端点写错却返回 0 是最坏的一种绿。

### 1. 配真实模型端点

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `EVAL_GROUP_LLM_BASE_URL` | **是** | — | OpenAI 兼容端点，如 `http://127.0.0.1:8000/v1` |
| `EVAL_GROUP_LLM_MODEL` | 否 | `default` | 模型名（与 `eval/lib/llm-review.mjs` 同一套口径） |
| `EVAL_GROUP_LLM_API_KEY` | 否 | — | 需要鉴权时填；**不进报告**（报告只记"是否配置"） |
| `EVAL_GROUP_LLM_TEMPERATURE` | 否 | `0` | 默认 0：同一条重跑应当稳定 |
| `EVAL_GROUP_LLM_TIMEOUT_MS` | 否 | `60000` | 单次请求超时，夹在 [1000, 600000] |
| `EVAL_GROUP_LLM_REPEAT` | 否 | `1` | 同一条跑几次（夹在 [1, 20]），用来报告采样波动 |
| `EVAL_GROUP_LLM_PRICE_INPUT_PER_MTOK` | 否 | — | 每百万 input token 的单价（**不填就不报钱**） |
| `EVAL_GROUP_LLM_PRICE_OUTPUT_PER_MTOK` | 否 | — | 每百万 output token 的单价 |
| `EVAL_GROUP_LLM_OUT` | 否 | `out` | 报告落盘目录（相对本目录） |

PowerShell：

```powershell
$env:EVAL_GROUP_LLM_BASE_URL = 'http://127.0.0.1:8000/v1'
$env:EVAL_GROUP_LLM_MODEL    = 'your-model'
$env:EVAL_GROUP_LLM_REPEAT   = '3'
cd plugins/dsh-channel-qq
npm run eval:group:llm
```

bash：

```bash
EVAL_GROUP_LLM_BASE_URL=http://127.0.0.1:8000/v1 \
EVAL_GROUP_LLM_MODEL=your-model \
EVAL_GROUP_LLM_REPEAT=3 \
  npm run eval:group:llm --prefix plugins/dsh-channel-qq
```

### 2. 不接触任何模型，验证通道本身（`--selftest`）

```bash
cd plugins/dsh-channel-qq
node eval/group/llm/run.mjs --selftest
```

它做四件事，**全部在 127.0.0.1 上**：

1. 起一台本地假 OpenAI 服务（随机端口），把 `EVAL_GROUP_LLM_BASE_URL` 指过去；
2. 跑完整份语料：**真的走 http**、真的过 `runPresenceCycle` → 解析 → 校验 → 影子闸门；
3. 断言四条：**每条**都走到生产解析 · 绊线 0 次 · 三件套报告都写出来 · 覆盖全部语料；
4. 再跑两块补充自测：
   - **绊线端到端**：在子进程里故意让模型输出一个"要发"的决策，并**故意**去掉影子闸门
     （`sendGate: () => 'live'`）。期望绊线响、该条 HARD FAIL、**子进程退出码 1**；
   - **异常路径**：用 401 与"HTTP 200 但不是 JSON"两台假服务，断言异常码分别是
     `http-error` 与 `bad-json`，并且**不许**被记成"模型选择沉默"。

自测任何一条断言不通过，`--selftest` 退出码 1。

### 3. 手工演练：用环境变量打本地假服务

```bash
# 终端 A
node eval/group/llm/run.mjs --serve-fake --port 8123
# 终端 B
$env:EVAL_GROUP_LLM_BASE_URL = 'http://127.0.0.1:8123/v1'
$env:EVAL_GROUP_LLM_MODEL    = 'fake-local'
node eval/group/llm/run.mjs          # 走的是"真实端点路径"，只是端点是假的
```

这条路径验证的是：**没有 `--selftest` 那条捷径时，环境变量 → 配置 → 请求 → 解析 → 报告**全通。

### 4. 其它开关

```bash
node eval/group/llm/run.mjs --json            # stdout 纯 JSON
node eval/group/llm/run.mjs --case G06 --case G10
node eval/group/llm/run.mjs --repeat 5        # 覆盖 EVAL_GROUP_LLM_REPEAT
node eval/group/llm/run.mjs --no-offline      # 不引用离线报告（第一段显示"未运行"）
node eval/group/llm/run.mjs --out D:/tmp/ev   # 报告落别处
node eval/group/llm/run.mjs --persona-file config/persona.md
node eval/group/llm/run.mjs --channel composed  # 强制组合通道（诊断用）
node eval/group/llm/run.mjs --dump-prompts    # 把生产提示词全文写到 out/prompts/
```

## 零发送是怎么保证的

三处独立的证据，缺一条就不算：

1. **端口是绊线**（`port.mjs`）。平台端口的 `sendGroupMessage` / `sendPrivateMessage` / `sendTo`，
   以及任何**名字以 `send` 开头**的方法（将来新增的发送路径不需要改代码就被挡住），
   一旦被调用：先记一条（方法名 + 参数 + 调用栈），再 `throw`。
   为什么抛错而不是返回假回执：假回执会让流程以为发成功了——记一次发言、推进冷却、写 sent-log。
   那证明的是"假回执能用"，不是"没发出去"。抛错让这条路在评测里就是一条明确的失败。
2. **影子闸门**（生产 `presence-flow.ts` 的 `deps.sendGate`）。每次真要发之前现取当前模式；
   这里恒返回 `shadow`，于是发送那一步根本不会被执行。闸门是**线上同一条路径**，
   不是评测另写的 if——运行中把 `live` 切成 `shadow` 走的也是它。
3. **端到端反证**（`--selftest` 的子进程）：故意把闸门设成 `live` 走到发送那一步，
   断言绊线响、该条失败、**退出码 1**。没有这一条，"绊线拦得住"只是我们的说法。

另外：`tripwireSelfTest()` 在**每次**运行开始时先跑一遍（直接调三个方法确认它们会抛）；
它不通过，运行器拒绝开工。

## 逐条记了什么

`out/cases.jsonl`（每次运行覆盖写）每行一次判断：

| 字段 | 含义 |
|---|---|
| `sceneId` / `scene` | 匿名场景 ID（G01–G52，与离线语料同号）与场景名 |
| `inputHash` | 提示词 + 判断设置 + 模型名的短哈希（对齐"这次和上次是不是同一份输入"） |
| `promptChars` | 提示词长度（不是全文；全文只在 `--dump-prompts` 时落本地） |
| `persona` | 人格快照的 `version` / `source` / 是否可用（**不记正文**） |
| `model` | 模型名、temperature、maxTokens、推理档位（`preferredEffort`） |
| `rawOutput` | 模型原始输出（**脱敏后**；决策 JSON 或坏文本原样保留） |
| `tier` | `decision` / `silent` / `invalid`（来自生产 `parseSocialDecision`） |
| `action` / `target` | 解析出的动作与目标号，以及目标在本轮消息里/时间窗内是否成立 |
| `veto` | 代码 veto 理由（来自生产 `validateSocialDecision`；null = 没被拦） |
| `execution` | 生产流程的结局：`spoke` / `shadow` / `silent` / `failed`（+失败细分） |
| `latencyMs` / `tokens` / `cost` | 耗时、prompt/completion token、成本（没给单价就是 null） |
| `errorCode` | `network` / `timeout` / `http-error` / `bad-json` / `empty-content` / null |

**不写真实群号与 QQ 号**：群号全程用固定假号 `1000000003`；所有落盘文本（模型输出、理由、
veto、结局原因）统一脱敏，**≥5 位的数字串**一律换成 `<长数字号>`。语料里的假消息号是 3–4 位，
保留它们才能对着语料读报告。

`out/report.json` / `out/report.md`：机读与人读两份报告；`out/prompts/prompts.jsonl` 只在
`--dump-prompts` 时生成（含生产提示词全文——群消息正文与人格，属于**本地受控存储**，不入库）。

## 报告怎么读（两段，绝不合并）

终端输出固定两段，中间一条分隔线：

**第一段 · 离线代码回放**：直接引用 `eval/group/last-report.json`（不重跑、不重算），
并明写"这是邻居的成绩"。它那 73.3% / 42.3% 的分母是**人工写死的模型输出**，
与真实模型表现无关。本次只跑了部分用例时会额外标注"两段分母不同，不要横向比"。

**第二段 · 真实模型通道**：只报这次跑出来的东西——解析档分布、有效输出率、流程结局分布、
失败细分、异常码、目标校验、延迟 p50/p95、token、成本、非确定性、零发送证据、逐条明细。

**这里没有"准确率"**。理由不是谦虚：真实模型通道里没有金标准——离线语料的人工标注是
"标注者的偏好"，把它当正确答案会把"标注偏好"说成"模型对错"。要出准确率，得走真人盲评：

1. 从 `out/cases.jsonl` 里取出 `rawOutput`（模型原本要说的那句话）；
2. 隐去模型名与时间，随机顺序，交给**没看过本文件**的人，只问三件事：
   "这句该不该在这个群里发？" / "如果发，是对着哪条说的？" / "像不像同一个人？"；
3. 用盲评结果算"该发没发 / 不该发却发了 / 回错对象 / 人格不一致"四类计数——
   分母是盲评条目数，不是 token 数。

## 现在能拿到什么、还缺什么

**能拿到（真实模型跑完就有）**

- 每条示例的解析档 `decision / silent / invalid`，以及**坏 JSON 与"选择沉默"分开计数**
  （后者是模型的能力，前者是模型的故障，混在一起会把故障算成谦虚）；
- 代码 veto 的**理由**（`target-not-present` / `target-too-old` / `text-too-long` / `text-mention` …），
  因此"模型选错"与"代码拦住"可以分开归因；
- "若按 live 会发出去几条" —— **观察值**，不是准确率；
- 延迟分布（p50/p95/max）、token（prompt/completion）、成本（给了单价才算）；
- 重跑波动：`EVAL_GROUP_LLM_REPEAT>1` 时逐条给出"几次结果是否一致"，不一致的列出每一种输出；
- **零发送证据**：绊线 0 次 + 影子闸门 + 子进程端到端反证。

**还缺（拿不到的，别猜）**

- **真人盲评**：没有它就没有"不合时宜插话率""值得参与场景参与率"——离线那 73.3%/42.3%
  不能借来当真实模型的成绩；
- **真实群语料**：现在跑的还是离线那批人工构造场景（计划建议扩到 100–200 段
  真实多人对话、跨话题、多轮变化，且需要测试授权）；
- **记忆与话题上下文**：本通道传的是 `EMPTY_RECALL`（记忆段为空、话题为 null），
  所以"她能不能用上群体记忆"这一维没测；
- **线上路由/推理档位差异**：端点由你指定，与部署里宿主实际路由到的那一档未必相同
  （报告里记了 `preferredEffort: low` 与模型名，便于对齐）；
- **表情包投递**：本通道只跑文字决策；`presence.stickers` 的选图/投递没有影子日志可看。

## 已知边界（写在报告里，也写在这里）

1. 这是 `real-api` 证据，**不是** `real-send`：平台端口是绊线，零 QQ 消息。
2. 语料是人工构造的（虚构群号、抽象占位），覆盖的是"场景形状"，不是"她的群里的真实对话"。
3. 没有真人盲评，所以**没有准确率**；报告里的计数都不能读成"质量分"。
4. `--selftest` 用的是本地假服务，它的输出按序号轮换——那只证明通道通，不证明模型表现。
5. 影子闸门来自 P5-B；在还没编译进 `build/lib` 的机器上，运行器会探测到并降级为
   "组合通道"（组包 + 解析 + 校验 + 限频，**没有发送那一步**），报告里明写这次走的是哪一条。

## 本次自测的实测结果（2026-11-08，Windows · Node 24.14.0）

```text
node eval/group/llm/run.mjs --selftest
→ 全部示例 × 1 次，全部走到生产解析
  绊线 0 次 · 真实发送 0 条 · 报告三件套写出
  绊线端到端（子进程，故意去掉影子闸门）：退出码 1、绊线响 1 次 ✓
  异常路径：401 → errorCode=http-error ✓ · 非 JSON 响应 → errorCode=bad-json ✓
退出码 0
```

```text
node eval/group/llm/run.mjs                  # 未配置 EVAL_GROUP_LLM_BASE_URL
→ 打印配置说明（含可复现命令），退出码 2
```

```text
node eval/group/llm/run.mjs --serve-fake --port 8123   # 终端 A
$env:EVAL_GROUP_LLM_BASE_URL='http://127.0.0.1:8123/v1'; node eval/group/llm/run.mjs   # 终端 B
→ 走"真实端点路径"（环境变量 → 配置 → HTTP → 解析 → 报告），绊线 0 次，退出码 0
```

## 与邻居的关系

- `eval/group/run.mjs`（离线回放）：判"这一行写死的模型输出能不能被执行"；本目录判
  "真实模型给出的输出会被怎么处理"。两者共用 `corpus.mjs` 与 `adapter.mjs`。
- `eval/lib/llm-review.mjs`：那边的 `EVAL_LLM_BASE_URL` 是给失败条目加一段评审意见，
  默认不跑；本目录的 `EVAL_GROUP_LLM_*` 是**主判据通道**。两套前缀分开，互不串配置。