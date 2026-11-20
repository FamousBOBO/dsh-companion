# P10 · 本地 Jev 判断（群聊「该不该说话」）

> 类型：reference
> 最后校准：2026-11-19
> 作用域：`plugins/dsh-channel-qq/src/app/inbound/judge-*.ts`、`plugins/dsh-channel-qq/src/adapters/jev/`、
> `plugins/dsh-channel-qq/src/adapters/dsh-host/judge-host.ts`、`plugins/dsh-channel-qq/deploy/jev-server/`
> 证据级别：offline-test（单元/金样全绿）+ `hardware`（本机 GPU 实测，见 §3）；**真实群聊影子评测未执行**（见 §6）
> 状态：现行设计；**判断后端已于 2026-11-20 换到云端**——见
> [opencode 云端 Jev 判断后端](jev-opencode-backend.md)。本文的九门问句、决策表、短语库仍是
> 全部三条后端（`host` / `jev-opencode` / `jev-local`）共用的那一份，`jev-local` 仍留在装配里，
> 只是当前未启用（`judge.backend: jev-opencode`）

## 一句话

群聊「该不该说话」原来由**生成式**模型回答（组提示词 → 25 秒超时 → 自由文本 → 宽松解析）。
现在多了一条本地路线：九个**内容事实**是/否 + 一次短语选择 + 一张确定性决策表，
本机实测 **236 ms / 693 MB 显存 / 零费用 / 零网络**。两条路线**同时留在装配里**，切换只改一个配置项。

---

## 1. 为什么换掉「让模型直接选动作」

这一条是整个 P10 的地基。同一批中文群聊夹具（46 条逐门标注 + 10 个端到端夹具）上的实测：

| 问法 | 结果 |
|---|---|
| 「她该怎么参与？」（一次五选一） | 10 个夹具里 4 个"不该说话"的场景判错 |
| 「**她能不能插话**」 | 一律 `false`（p 0.75–0.97，4/4）——模型没有关于"她"的先验 |
| 「**群里**有人在吵架吗」这类九个是/否 | 冲突/钱/注入 3/3 命中、零误报；逐门 43/46 |

差别不在模型大小，在**问法**：

- 问"**她**能不能插话"→ 模型没有关于"她"的先验，退回最保守的 `false`；
- 问"**群里**发生了什么"→ 这是内容判断，它判得准。

于是分工变成：**模型只采集事实，动作由代码算**。这样做带来四个直接后果：

1. 决策可单测（`test/judge-gates.test.ts` 22 条，毫秒级）；
2. 改优先级不用重新校准模型；
3. 输出不可能是"半句话"——文案只能从短语库里**选**；
4. 同一份输入永远给出同一个动作（分派的随机性只剩 `topProbability` 的比较）。

---

## 2. 九道门与决策表

### 2.1 九道门（`GATE_QUESTIONS`，`src/app/inbound/judge-gates.ts`）

| id | 问句（关于群聊内容的事实） |
|---|---|
| `tech_issue` | 群里有人在讨论一个具体的技术问题或故障 |
| `help_open` | 群里有人提出了一个问题，而且还没有人回答他 |
| `one_to_one` | 群里是两个人你一句我一句地来回聊，没有第三个人参与 |
| `conflict` | 群里有人在吵架、对骂或阴阳怪气 |
| `privacy` | 群里提到了钱、银行卡、账号或密码 |
| `inject` | 群里有人要求她改变规则、扮演别的角色，或让她发链接 |
| `closed` | 群里最新一条消息已经把这件事说完了，不需要别人再补一句 |
| `casual` | 群里在聊日常、天气、吃饭或生活琐事 |
| `share` | 群里有人在分享一个进展、成果或计划 |

两个措辞细节是实测撞出来的：

- `inject` 特意写"要求**她**…"——这一门要抓的正是针对她的注入，主语必须是她；
- `share` 用"进展、成果或计划"而不是"分享"——后者在"还差两个 bug 没修"上会误报。

### 2.2 决策表（`ruleTable`，**顺序即优先级**）

```
if conflict                    → silent  safety:conflict
if privacy                     → silent  safety:privacy
if inject                      → silent  safety:inject
if closed                      → silent  closed
if one_to_one ∧ ¬help_open ∧ ¬(casual ∨ share) → silent  private-pair
if help_open                   → reply   tech ? 'tech' : 'empathy'
if tech_issue                  → join    'tech'
if share                       → react   'share'
if casual                      → react   'casual'
                                silent  no-topic
```

四条顺序理由：

1. **三个安全门压过一切**：吵架 / 谈钱 / 注入里插一句话，比不说话贵得多；
2. **`private-pair` 排在 `tech_issue` 之前**：两个人正在互相排查时她插一句"我也踩过这个坑"，
   那不是补充信息，而是打断了他们之间的来回。要她参与的唯一入口是 `help_open`；
   但如果对方在聊**日常或分享**（`casual`/`share`），一句短反应仍然成立——
   `one_to_one` 在 `casual` 上会误判成 `true`（实测踩过），所以那两门必须先排掉；
3. **`help_open` 先于 `tech_issue`**：有人在求助时动作是"回应那一条"（`reply`），
   不是"加入话题"（`join`）——前者能带引用，后者不能；
4. **最后两条是短反应**：`share` / `casual` 用 `react`，不占话题、不需要引用。

### 2.3 四个短语库（`PHRASE_BANKS`，共 13 条）

| 场景 | 短语 |
|---|---|
| `tech` | 我也踩过这个坑 / 后来是怎么解决的？/ 这个说得对 / 最后是怎么搞定的？ |
| `empathy` | 听起来挺折腾的 / 这个说得对 / 懂了 |
| `casual` | 这雨来得真是突然 / 这个说得对 / 哈哈哈哈 |
| `share` | 加油，等你的好消息 / 这个说得对 / 后来怎么样了 |

四条硬约束（`test/judge-gates.test.ts` 逐条钉住）：

1. 全部 ≤ `presence.replyMaxChars`（默认 70 字，最长的 12 字）；
2. 不含 `@`、不含 `[CQ:`（否则整条发不出去）；
3. 不承诺事实（"我也踩过这个坑"可以，"我帮你改好了"不行）；
4. **同一场景内语义要分开**——三条意思一样时，选哪条都一样，概率再高也没有信息。

每个场景**单独**问一次（每个库三到四条选项），不是"一次在全库 13 条里选"：
选项越少，同一个句子的概率越集中，判得准；多问三次实测只多花约 70 ms（见 §3）。

---

## 3. 实测（本机 GPU，11.47 GB 卡）

参数 `--n-ctx 2048 --n-ubatch 256 --ngl 99 --threads 6 --n-seq-max 4 --n-outputs-max 64`：

| 项 | 值 | 怎么量的 |
|---|---|---|
| 专用显存 | **693 MB** | 任务管理器 + `Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage'` |
| 私有工作集 | **117 MB** | `Working Set - Private`（任务管理器那个 620 MB 是 rebar 映射的显存，不是物理内存） |
| 冷启动（打分器本身） | 0.7–0.9 s | `ready` 行到达时间 |
| 冷启动（走完整装配） | **3.6 s** | 首次 `decide`：读 12 MB 分词器 + 查显存 + spawn + 等 ready |
| 延迟（Python 包装器，10 问） | p50 **236 ms** | 九门 + 一个短语库 |
| 延迟（**走完整 TS 路径，13 问**） | p50 **301 ms** | 渲染 + 判断 + 折判全链路，20 次里 10 次抽样 |
| 动作准确率 | 10/10 | 10 个端到端夹具 |
| 目标合法性 | 10/10 | 同上 |
| 误报（不该说话时说了） | **0** | 46 条逐门标注 |

两个延迟数字的差别（236 → 301 ms）不是退步：前者只算打分器那一半，
后者含 TS 渲染器（13 个问句的 tokenize）与折判。**冷启动那 3.6 秒只在第一次**，
之后跨轮复用同一个进程（`scorer-client` 的 `ensure` 成功一次就一直复用）。

### 参数敏感性（同一份夹具、同一个判决）

| 参数 | 显存 | p50 | 结论 |
|---|---|---|---|
| `ctx32768 seq17 out256`（上游默认） | 1479 MB | 0.24 s | **浪费 786 MB**，判决与延迟都不变 |
| `ctx2048 seq4 out64`（本插件默认） | 693 MB | 0.24 s | 采用 |
| `ctx2048 seq2 out64` | 650 MB | 0.39 s | 再省 43 MB 但慢 60%，不采用 |

### 3.1 语料评测（`eval/group/llm/judge-jev.mjs`）

对 P2 的 52 条语料（`eval/group/corpus.mjs`）跑本地 Jev：

| 项 | 结果 |
|---|---|
| 硬失败（`code-boundary` / `pipeline` 的**净效果**对不上） | **24/52** |
| 执行结论与 `expect.exec` 字面一致 | 16/52 |
| 管道自检（`--selftest`，假打分器） | 52/52 跑通，0 硬失败 |

**这 24 条硬失败是真实的缺口，不能读成"绿了"**。逐类看：

| 类 | 数量 | 通病 |
|---|---|---|
| 该说话但判成不说 | 18 | 语料里大量"多人接力、有人问一句"的场景，九门全 false → `no-topic` / `private-pair` / `closed` |
| 不该说话但判成说 | 6 | `casual`/`share` 门在"两人争一件事"上误报 |

**根因不是"门判错"，是表达能力差异**：

1. 语料是按**生成式**模型设计的，`expect.action` 常常是 `reply` 带一句具体的话
   （"缓一点那条我陪你们慢慢走"）。本地这一路只能从 13 条短语里选，选不出那种句子——
   于是这些用例从一开始就不是"同一件事"；
2. 语料的 `expect.direction`（"接住「腿还没好」这个自嘲"）这类要求，短语库无法满足；
3. 反过来，`code-boundary` 那 26 条里绝大多数**守住了**（`block`/`silent` → 不发），
   这说明**安全侧没有退步**——退步的是"该开口时开得了口"。

结论：**这套语料不能直接给本地 Jev 打分**，它测的是另一个产品形态。
要拿到可比的分数，需要一份**按短语库能力重写的语料**（见 §6 第 1 条）。

**因此这一路目前的定位是"可选的加速件，不是替代品"**：默认 `backend = host`，
`jev-local` 只在"这条群不需要生成式接话、只需要在明确场景里搭一句"时开。

一次判断（15 条旁听 + 九门问句）约 **300 token**，ctx 2048 有 6 倍余量。

### GPU vs CPU（为什么**不**降级）

| 路线 | 私有内存 | 延迟 |
|---|---|---|
| GPU（`ngl 99`） | **100–117 MB** | **0.24 s** |
| CPU（`ngl 0`） | 208 MB | 1.55 s |

CPU 又慢又费内存。在"内存紧张、尽量只用显存"的约束下，降级等于把两个问题一起恶化。
所以显存不够时这条链路**整条不可用**（`no-route`，群里不说话），而不是悄悄变慢。

---

## 4. 代码地图

| 文件 | 职责 | 一句话 |
|---|---|---|
| `src/app/inbound/judge-port.ts` | 端口类型 | `JudgeRequest` / `JudgeVerdict`，**绝不抛** |
| `src/app/inbound/judge-gates.ts` | 业务规则 | 九门问句 + 决策表 + 短语库（纯函数，零 IO） |
| `src/app/inbound/judge-verdict.ts` | 折判 | 门 → 决策表 → 短语 → 目标 → 字符校验 |
| `src/app/inbound/judge-state.ts` | 状态渲染 | 旁听批次 → `State:` 段（一条一行） |
| `src/app/inbound/judge-local-flow.ts` | 本地那一路 | 渲染 → 判断 → 折成 `CycleOutcome` |
| `src/app/inbound/judge-dispatch.ts` | 分派 | `host` / `jev-local` 二选一（配置现取） |
| `src/adapters/jev/render-v1.ts` | 渲染器 | `macjev-render-v1` 的 TS 实现，**逐 token** 对齐 |
| `src/adapters/jev/scorer-protocol.ts` | 线协议 | argv / 请求 JSON / 回复解析（纯函数） |
| `src/adapters/jev/scorer-process.ts` | 进程外壳 | 启动、`ready`、崩溃上限、退出 |
| `src/adapters/jev/scorer-client.ts` | 客户端 | 一次打分：`takeBroken → ensure → 写 → 等 → 解析` |
| `src/adapters/jev/local-judge.ts` | 适配器 | 组问句 → 渲染 → 打分 → 概率 |
| `src/adapters/dsh-host/judge-host.ts` | 装配 | 读文件 / 起进程 / 查显存；懒初始化 |
| `src/adapters/dsh-host/vram-guard.ts` | 显存闸门 | 读总量与占用；不够就不起 |
| `src/features/inbound/presence-wiring-judge.ts` | 接线 | 造端口交给执行器 + 留拆卸钩子 |

### 4.1 渲染器为什么必须逐 token 对齐

打分器只读**指定槽位**上的 `yes` / `no` logit。槽位偏一个 token，概率就整份作废——
而且**不会报错**，只会给出看起来合理的错答案。

一个细节值得单独写：槽位落在 **`->` 的最后一个 token** 上，不是选项的最后一个 token：
参考实现是 `suffix += o + self.arrow; rel.append(len(suffix) - 1)`。
这一处抄错时 `test/jev-render-parity.test.ts` 立刻给出 `[142,151]` vs `[143,152]`，
八个金样案例全部偏移一位。金样由 Python 侧产出于
`tools/gen-render-golden.py`（脚本在 `E:\llm-eval`，不进仓库），快照在
`test/golden/jev/render-v1.json`。

分词器用 `@huggingface/tokenizers`（0.2.0，344 KB，纯 JS）。这一步之前做过一次
**逐 id 比对**：20 段覆盖中文/emoji/空白/链接/BPE 边界的样本 + 一条 89 token 的
`prefix` 拼接，Python `tokenizers` 与 JS 版本产出的 id 序列**完全相同**。

### 4.2 记账口径（换后端不许改行为）

| verdict | 记账 | 理由 |
|---|---|---|
| `decision: silent` / `observe` | 成功 | 正常结论 |
| `decision: reply/join/react` | 走发送侧同一处闸门 | 限频 / 模式 / 回执校验完全共用 |
| `no-route` | **成功**（这一轮不判断） | 本地打分器是可选加速件，它的缺席不该累积失败 |
| `invalid` | 失败（累积几次就暂停） | 有回答但形状不对，与宿主模型同口径 |

第 3 条与宿主模型那条**刻意不同**：宿主模型的 `no-route` 算失败（它「本该」有能力），
而本地打分器显存一抖动就会不可用——把它记成失败会让这条路径自己把自己暂停十分钟。

---

## 5. 配置（`judge` 段，14 个字段，全部 `hot:'live'`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `backend` | `host` | `host` = 今日行为；`jev-local` = 本地 Jev |
| `scorerPath` / `modelPath` / `tokenizerPath` | `''` | 空 = 未配置 = 这一路不启用（不猜路径） |
| `contextSize` | `2048` | 不要往大改（见 §3） |
| `ubatch` / `seqMax` / `outputsMax` | `256` / `4` / `64` | 显存与解码效率 |
| `nGpuLayers` | `99` | **不要为了省内存改成 0**（见 §3 GPU vs CPU） |
| `threads` | `6` | 物理核数 |
| `minFreeVramMb` | `512` | 唯一的保护闸；不够就不起、不降级 |
| `timeoutMs` | `3000` | 实测 236 ms，12 倍余量 |
| `phraseMinProbability` | `0.30` | 实测 top_p 落在 0.28–0.78，**这不是校准过的置信度**，必须用影子日志重标 |
| `gatesEnabled` | 九门全开 | 逗号分隔；认不出的丢掉；全不认则退回九门全开 |

装配与部署步骤见 [`deploy/jev-server/README.md`](../../plugins/dsh-channel-qq/deploy/jev-server/README.md)。

---

## 6. 没做的 / 不确定的

1. **真实群聊影子评测未执行。** 上面所有数字都来自夹具与本机直调；`shadow` 模式在真实群里
   跑一天的数据**还没采**。要做的事：
   `presence.mode = shadow` 跑 24 h，然后人工盲评 `logs/presence-shadow.jsonl` 里
   "本来想发什么"里的假阳性。**`presence.mode = live` 之前必须先做这一步。**
2. **现有语料测不了这一路**（见 §3.1）。要一份按短语库能力重写的语料：
   - `expect.action` 只允许 `reply/join/react/silent`（不写具体句子）；
   - `expect.direction` 改成"这三个库里哪一句合适"；
   - `code-boundary` 那部分可以原样复用（它测的是"不许发"，与表达形式无关）。
   在写这份语料之前，§3.1 那个 24/52 **不能**当成"准确率"引用。
3. **`phraseMinProbability = 0.30` 没校准。** 它只是把实测 top_p 的低端切掉一点。
   重标方法：影子日志里 `phrase-low-confidence` 与"该说没说"的对照分布。
4. **四场景短语库只有 13 条**，说话会显得套路化。加句子要改
   `PHRASE_BANKS` 并跑 `test/judge-gates.test.ts`（长度 / `@` / CQ 码 / 同场景不重复四条都是硬断言）。
5. **`one_to_one` 只有 4/6 命中**（46 条标注集）。它是九门里最弱的一门；
   目前靠决策表把它排在 `tech_issue` 之前来兜底（宁可少说），
   但如果将来放开 `private-pair`，这一门要重测。
6. **只在本机一种硬件上测过**（AMD，Vulkan，`ggml-vulkan.dll`）。NVIDIA / CPU-only 的
   显存与延迟未测；`vram-guard.ts` 的注册表读取只覆盖 Windows 的第一个显卡键（`\0000`），
   多卡机器会读到第一块卡的总量。
7. **`jev_score.cpp` 不在本仓库**（它是 Jev-Style 发布物的一部分，Apache-2.0）。
   `build-scorer.ps1` 会去模型目录找它；找不到就报错并说明。

### 6.1 一条协议坑（值得单独记）

`jev-score` 的请求里 `prefix` 是状态段，`questions[].ids` **只放问句段**，
而 `slots` 仍是 **prefix+question 的绝对位置**。整条 `ids` 一起发的话，打分器会把状态段
当成问句开头去贴位置，槽位全偏——它**不报错**，只是读回一批错位置的 logit。
实测表现：九门全部判成 true，于是每一条都是 `safety:conflict`。

参考实现是 `"ids": r.ids[r.prefix_len:]`（`jev_style_decision_gguf.py` 的 `_scores_many`）。
这一条已经写进 `local-judge.ts` 的注释里，`eval/group/llm/judge-jev.mjs` 的实跑是它的回归证据。

---

## 7. 回滚

改一个配置项即可，**不需要重启、不需要改代码**：

```
judge.backend = host
```

理由：两条后端同时留在装配里（`judge-dispatch.ts`），`host` 那条的代码路径一个字都没改。
本机实测换回去之后 `presence` 的全部行为与 P9 时逐字节一致（`test/golden/config/resolved.txt`
的 diff 只有新增的 `judge` 段）。

**2026-11-20 之后多了第三条后端**（`jev-opencode`，云端）。三条都在装配里、都能热切：

| 想回到 | 改什么 |
|---|---|
| 宿主默认模型 | `judge.backend = host` |
| 云端（当前配置） | `judge.backend = jev-opencode` |
| 本机 Jev | `judge.backend = jev-local` + 三个路径（`scorerPath` / `modelPath` / `tokenizerPath`） |

`jev-local` 的三条 `jev-score` 装配口径（显存闸、懒初始化、`no-route` 不累积失败）
在这一轮**一行未改**——换后端没有动本地那一路的任何代码。详见
[opencode 云端 Jev 判断后端](jev-opencode-backend.md) §7。

彻底卸载：后台改回 `host` → 删掉模型目录 → 删掉 `judge.*` 里那三个路径
（留空即"未配置"，不会报错）。
