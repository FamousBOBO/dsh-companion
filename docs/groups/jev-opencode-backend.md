# opencode 云端 Jev：把判断后端换到 `systemone`

> 类型：reference
> 最后校准：2026-11-20
> 作用域：`plugins/dsh-channel-qq/src/adapters/jev/hosted-{protocol,judge}.ts`、
> `plugins/dsh-channel-qq/src/adapters/dsh-host/judge-hosted-host.ts`、
> `plugins/dsh-channel-qq/src/config/sections/judge.ts`、
> `plugins/dsh-vocechat-adapter/{judge-link,autonomy,autonomy-config}.mjs`
> 证据级别：offline-test（单测/金样全绿）+ `external`（真端点实测，见 §2、§5）；
> **真实群聊长跑未执行**（见 §7）
> 状态：现行（`judge.backend = jev-opencode`）

## 一句话

群聊「该不该说话」的判断从**本机 `jev-score` 子进程**换到 **opencode 云端 `systemone` 端点**：
同一张九门决策表、同一份 13 条短语库、同一个折判函数，只换"谁打分"。
本机不再需要 495 MB 权重与 693 MB 显存；代价是每轮约 **932 input token / $0.000039**、
p50 **656 ms**（本机是 388 ms）。同一份判断能力还**发布给 VoceChat**，
于是它的频道门控从"掷骰子"升级成"九门判断 + 主动发言闸门"。

---

## 1. 为什么换

| 理由 | 具体 |
|---|---|
| 显存 | 本地那一路要 693 MB 显存 + 117 MB 私有工作集；主人机器内存紧张，这是原始约束 |
| 权重 | 495 MB GGUF + 12 MB `tokenizer.json` 要在本机/开发机各存一份 |
| 换机器 | 云端后端只依赖一把 key，搬机器不用搬权重 |
| 代价 | 每轮多 268 ms（p50 656 vs 388）、要联网、要一把有效 key、按量计费 |

**判断口径没换**是本设计最重要的一条：`judge-gates.ts`（九门问句 + 决策表 + 短语库）
与 `judge-verdict.ts`（折判）**一行都没改**。换后端只换"打分的人"，
所以两条后端的成绩可以直接比（见 `jev-local-vs-hosted-real.md`）。

---

## 2. 协议：`systemone` 不是聊天端点

```
POST https://opencode.ai/inference/systemone/v1/systemone
Authorization: Bearer <OPENCODE_API_KEY>
User-Agent: dsh-companion/jev-opencode      ← 必须自定义，见 §4
Content-Type: application/json

{ "model": "jev-1.13",
  "state": "[消息 240] [成员 uid 1] [时间 20:27] 今天好像要下雨了\n…\n现在是 2026-11-20 20:45。",
  "questions": {
    "tech_issue": { "type": "noul", "instructions": "群里有人在讨论一个具体的技术问题或故障" },
    "phrase:casual": { "type": "choice", "instructions": "她插一句最合适的是哪一句",
                       "criteria": { "me_too": "我也踩过这个坑", … } },
    "target": { "type": "choice", "instructions": "她最自然的做法是回应哪一条消息",
                "criteria": { "240": null, "241": null } } } }
```

响应：

```json
{ "model": "jev-1.13",
  "answers": {
    "tech_issue": { "type": "noul", "noul": 0.98 },
    "phrase:casual": { "type": "choice", "choice": "same_here",
                       "confidence": 0.51, "probabilities": { "same_here": 0.63, … } },
    "target": { "type": "choice", "choice": "240", "probabilities": { "240": 0.59, "241": 0.41 } } },
  "usage": { "input_tokens": 932, "output_tokens": 213, "cost": 3.914e-05,
             "opencode": { "billing_source": "balance", "list_cost": 3.914e-05 } } }
```

**三处照抄会静默出错的差异**：

1. **一次请求就是一组具名问句。** 本机协议是 `questions: [{ids, slots, rows}]`（调用方自己算
   token 位置），云端是 `questions: {名字: {type, instructions, criteria}}`——分词、位置、
   logits 全在对端。所以**本地渲染器 `render-v1.ts` 在这条路径上完全不参与**：
   `request.state` 原样发过去。
2. **`choice.confidence` ≠ `max(probabilities)`。** 实测 0.51 vs 0.63（5/5 都是后者更大）。
   折判的 `phraseMinProbability` 门槛按 `max(probabilities)` 标定过，所以
   `hosted-protocol.ts#choiceAnswer` 只取 `max(probabilities)`；用 `confidence` 会让门槛
   系统性收紧，表现是"该说话时总说置信度不够"。
3. **`criteria` 允许 `null`，单选项也合法。** 本地渲染器本来就是这么传的（目标选项是消息号、
   没有描述），所以两边能共用同一份候选列表。

**Jev 不是聊天模型**：塞进 `chat/completions` 或 `messages` 一律
`400 ModelProtocolUnsupported`；带 `temperature` / `top_p` 是 `400 api_usage_error`。

---

## 3. 装配与错误分类

```
judge.backend ─┬─ 'host'        → 没有端口（走 presence-cycle.ts 的宿主模型路径）
               ├─ 'jev-opencode' → hostedJudgeHost()  （adapters/dsh-host/judge-hosted-host.ts）
               └─ 'jev-local'    → localJudgeHost()   （adapters/dsh-host/judge-host.ts）
```

两条 typed 后端在编排上**完全等价**（`judge-dispatch.ts` 只判"是不是 typed"），
所以加第三条后端不需要改分派逻辑。

**错误分类表**（决定"这一轮记不记失败"）：

| 情况 | verdict | 累积失败 | 理由 |
|---|---|---|---|
| 200 但结构不对 / 正文不是 JSON | `invalid:shape` | 是 | 我们自己的读取逻辑坏了 |
| 400 `api_usage_error` / `ModelProtocolUnsupported` | `invalid:bad-request` | 是 | 配置错（模型 id / 端点写错），要修 |
| 401 / 403 | `no-route:auth` | 否 | key 过期或 UA 被 Cloudflare 挡，不是"判错" |
| 429 | `no-route:status` | 否 | 限频，下一轮再试 |
| 5xx / 网络 / 超时 | `no-route:transport` | 否 | 对端不稳 |
| 缺 key / 缺配置 | `no-route` | 否 | 没配置 ≠ 判错 |

判据：**只有"我们自己的请求形状或代码坏了"才算失败。** 对端不稳一律按"这一轮没判"。
这与本地那一路同一口径（`judge-local-flow.ts` 文件头第 1 条）。

**凭据**：`judge.remoteApiKeyRef` 是**引用名**（默认 `OPENCODE_API_KEY`），每次 `decide` 现取
（`host.bridge.credential` → `credentials.resolve(ref)`）。值不进配置快照、不进日志、
不进后台响应。`OPENCODE_GO_API_KEY` 调 `systemone` 是 `401`，不能用。

---

## 4. 两个实测坑

### 4.1 不带自定义 `User-Agent` → Cloudflare `403 error code 1010`

Python `urllib` 的默认 UA 直接被挡；错误体里**没有任何提示**（只有 `error code: 1010`）。
所以 `judge.remoteUserAgent` 默认非空，空串时代码里还有一层兜底 `FALLBACK_UA`。
`failureOf()` 会把 1010 单独识别成 `auth:403:cloudflare-1010`，便于一眼看出是 UA 问题。

### 4.2 免费 id 撑不住常驻

`jev-1.13-free` 与付费版是**同一模型**（`canonical_id: typesafe/jev-1.13.0`），但免费额度
约 **58K input token/天**（≈77 轮判断），UTC 00:05 重置，且**账号级**（所有免费模型共享）。
一分钟一轮的群只够跑 1.3 小时。所以默认 `remoteModel: jev-1.13`（付费），
免费 id 只适合做实验。

---

## 5. 成本与延迟

| 项 | 实测值 |
|---|---|
| 一次判断（九门 + 四库 + 目标 = 14 问） | 932–987 input token |
| 单价 | $0.042 / 1M input，output 免费 |
| 每轮 | ≈ $0.0000415 |
| 每群每月（50 秒一轮） | ≈ $1.64 |
| 每群每月（1 分钟一轮） | ≈ $1.36 |
| 每群每月（5 分钟一轮） | ≈ $0.27 |
| p50 / p90 / max 延迟 | 656 ms / 962 ms / 1384 ms |
| 6 并发（全部 14 问） | 6/6 `200`，753–1330 ms |

**两台群同时常驻的真实成本**：QQ（50 秒）+ VoceChat（60 秒）= 3168 轮/天
≈ 2.95M token/天 ≈ **$0.124/天 ≈ $3.7/月**。想省钱就调两个 `judgeIntervalMs`，
不要切免费 id（额度一用完就是整小时不说话）。

---

## 6. 跨通道：同一份判断能力给 VoceChat

```
dsh-channel-qq   presence-wiring-judge-publish.ts
                   publishServiceToPeers({ name:'companionJudge', service:{ decide, info, ready } })
                        ↓  process[Symbol.for('dsh.companion.ports.v1')]
dsh-vocechat-adapter  judge-link.mjs（每 8 秒重试，形状检查只认 decide）
                        ↓
                      autonomy.mjs（旁听环 → 定时判断 → 发言闸门 → 发送）
```

四条设计口径：

1. **发出去的是能力，不是端口**：外面拿到 `decide({lines, nowMs, nowLabel, origin, …})`，
   状态渲染在 QQ 这侧做（`renderJudgeState` 只有一份实现）。`origin:'vc'` 把抬头写成
   `uid N` 而不是 `QQ N`，其余逐字节一致——这样两个通道的分数才可比。
2. **发布与 `presence.enabled` 无关**：只要配了 typed 后端就发布。VoceChat 不该因为
   "QQ 群白名单是空的"而失明。
3. **VoceChat 旁听**：频道事件进来先入环（`autonomy.observe`），**不驱动回合**。
   这正是"掷骰子"与"判断"的根本差别：骰子在事件到达时掷，判断等一段话说完再看。
4. **四道发言闸门**：`speakMinIntervalMs`（默认 5 分钟）、`speakMaxPerHour`（默认 3）、
   `replyMaxChars`（默认 70）、`phraseRepeatWithinMs`（默认 30 分钟，**2026-11-20 实测补的**），
   另有 `quietAfterTurnMs`（默认 60 秒，刚回完一轮就不判）。
   `silent` **不占**每小时额度——"没说"不该挤掉"该说"的机会。

   **为什么会有第四道**：短语库只有 13 条，而同一段 `state` 上的判断是**稳定**的——
   VoceChat 群里连发两轮 tech 话题，就真的连着说了三遍"后来是怎么解决的？"（间隔
   5 分钟，正好等于 `speakMinIntervalMs`，三道闸全部放行）。换说法等于临时生成，
   那会破"不经生成"的硬规矩，所以**宁可不开口**：同一句话 30 分钟内不再说。
   证据在 `data/logs/presence-shadow.jsonl` 的前两条（`reason: tech-topic` 与
   `reply-degraded:unanswered-help`，`text` 完全相同）。

影子/实发记录落 `data/logs/presence-shadow.jsonl`，一行一条，与 QQ 的格式一致
（`source: 'vocechat'` 区分来源）。

---

## 7. 回滚与未验证

**回滚只改一个配置项**（热生效，无需重启代码）：

| 想回到 | 改什么 |
|---|---|
| 宿主默认模型 | `judge.backend: host` |
| 本机 Jev | `judge.backend: jev-local` + `scorerPath` / `modelPath` / `tokenizerPath` 三个路径 |
| 关掉 VoceChat 自主链路 | `autonomy.mode: off`（连判断都不跑）或 `shadow`（判断跑但不发） |

**未验证（首日观察项）**：

1. **`phraseMinProbability: 0.3` 是本地标定值。** 云端 `max(probabilities)` 实测偏高
   （0.59–0.67 vs 本地低端 0.28）→ 云端会更愿意说话。必须对着 `presence-shadow.jsonl` 重标。
2. **云端抖动 = 那一轮不说话**（`no-route`）。断网时群里会明显安静，这是设计而非故障。
3. **VoceChat 拿不到成员昵称**（`history.mjs` 只有 `fromUid`），状态里只能写 `uid N`——
   `one_to_one` / `share` 这类对"谁在说"敏感的门会略钝。
4. **QQ 频道那一侧的真实群聊长跑未执行**：QQ 群此刻没人说话，所以只有云端判断在
   `channel-qq.jsonl` 里逐轮回报（`jev-opencode reply（962 tok / $0.00004040）`），
   但"云端判完之后群里到底说没说"还没有一天的真实数据。

### 7.1 上线时实测到的三件事（都已修）

| 现象 | 根因 | 修法 |
|---|---|---|
| `jev-opencode 但凭据未配置` 每分钟刷一次 | 生产宿主的凭据库在 `data/home/.credentials.yaml`，而 key 只写在开发会话的 `~/.dsh/.credentials.yaml` | 把 `OPENCODE_API_KEY` 加进生产那份 `refs`（先备份到 `.bak-before-opencode-*`）。**两套 DSH_HOME 就是两套凭据库**，这是最容易漏的一环 |
| 同一句"后来是怎么解决的？"连说三遍 | 短语库只有 13 条 + 判断稳定 + 三闸放行（5 分钟正好等于 `speakMinIntervalMs`） | 第四道闸 `phraseRepeatWithinMs`（30 分钟）。**换说法等于临时生成**，会破"不经生成"的硬规矩，所以宁可不开口 |
| 云端判断成功了但日志里什么都没有 | 只有失败分支打日志，成功分支沉默 | 成功也打一行：`jev-opencode reply（962 tok / $0.00004040）`。没有它，"到底有没有真在判"只能靠猜 |

实测一轮的 token 数会随旁听条数涨：2 条消息 962 tok、7 条消息 1265 tok（$0.000053）。
固定开销（模板 259 + 问句正文 426）约 685，其余全是消息正文——**这印证了
`presence.judgeMaxChars: 1200` 是成本的主控旋钮**。

---

## 8. 相关文档

- [P10 · 本地 Jev 判断](p10-jev-judge.md) —— 九门问句、决策表、短语库的原始设计
- [opencode 上的 Jev](opencode-jev-pricing.md) —— 免费 vs 付费、额度与单价
- [本地 Jev vs 托管 Jev（真实私聊）](jev-local-vs-hosted-real.md) —— 两条后端的逐门对比
- [配置字段](../02-configuration.md) —— `judge` 段 19 个字段与 `autonomy` 段
