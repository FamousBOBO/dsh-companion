# P8 真实 QQ 灰度验收与运维手册

对应《P5–P8 下一阶段计划》§5。**这份文档区分「已经做到」与「必须由操作者授权的动作」**：
本仓库能自动完成的是 A 阶段（离线）与 B 阶段的通道部分，C/D/E 一律需要操作者明确授权，
因为它们的后果是**真的往群里发东西**。

---

## 1. 五个阶段（§5.1）

| 阶段 | 环境 | 真实发送 | 状态（2026-11-08） |
|---|---|---|---|
| A | 离线代码回放 | 否 | ✅ 已完成（npm run eval:group 49 通过 / 0 失败 / 3 WARN，52 条） |
| B | 真实模型 shadow | 否 | ⚠️ **通道就绪、未跑**：npm run eval:group:llm 需要 EVAL_GROUP_LLM_BASE_URL 等环境变量；未配置时退出码 2（不是失败） |
| C | 经授权的单测试群 live | **是** | ⛔ 未开始：需要操作者授权 + 一个专用测试群 |
| D | 单测试群启用表情 | **是** | ⛔ 未开始：需要 companion-expression 的图库授权与审核过的素材 |
| E | 第二个授权群加入 | **是** | ⛔ 未开始：需要第二个群的授权 |

**阶段切换必须由操作者明确授权。** 部署、跑评测、改配置模板都不会自动授权对真实群发送。

---

## 2. A 阶段：离线回放（已完成，可复现）

    cd plugins/dsh-channel-qq
    npm run build:lib          # 评测读的是线上同一份 ts 产物
    npm run eval:group         # 52 条，退出码 0

口径（不要读成「线上能发得得体」）：

- 每条用例喂的是**固定模型输出**，不调模型、不发 QQ、不读真库；
- 语料是人工构造（虚构群号），不是真实群导出；
- 它证明的是**代码侧边界**（解析、目标、限频、隔离、复核），不是语义质量。

若要观察 P6 复核在「如果线上切成 enforce」时的效果：eval/group/run.mjs 里有
guardMode: () => 'enforce' 那一行，报告里的「被代码拦下」条数就是答案。
**线上默认是 warn（只记不拦）**，别把评测结论当成「线上已经拦了」。

---

## 3. B 阶段：真实模型的影子运行（通道就绪，未执行）

### 3.1 评测通道（零 QQ 发送）

    $env:EVAL_GROUP_LLM_BASE_URL = 'http://127.0.0.1:8000/v1'
    $env:EVAL_GROUP_LLM_MODEL    = '<模型名>'
    $env:EVAL_GROUP_LLM_API_KEY  = '<需要时填>'
    cd plugins/dsh-channel-qq
    npm run eval:group:llm

三重零发送证据（详见 eval/group/llm/README.md）：

1. 平台端口是**绊线**：任一 send* 调用先记账再 throw，该条 HARD FAIL、退出码 1；
2. 影子闸门 sendGate 每次现取，走的是生产同一条路径；
3. --selftest 在**子进程**里故意把闸门设成 live，验证绊线真的会响（退出码 1）。

未配置端点：退出码 **2** + 可复现命令说明（不是失败）。端点写错导致零有效输出：退出码 1。

### 3.2 线上影子（presence.mode = shadow）

    "presence": {
      "mode": "shadow",       // off / shadow / live
      "enabled": true,        // mode 缺席时才看这个（旧口径）
      "groups": [<测试群号>]
    }

shadow 下会发生：收消息 → 记旁听 → **真调模型** → 走完解析与全部校验 → **一条都不发**。
落到 <dataRoot>/logs/presence-shadow.jsonl 的每一行是：

    {"at":"2026-11-08T14:03:11.000Z","group":145326153,"mode":"shadow",
     "action":"reply","target":711,"text":"…","chars":24}

**不带 message_id**：它没发出去，带上会被下游当成「说过话」。

跑一段时间后要看的数字（后台「群社交」页 或 GroupPresence.diagnostics()）：

| 数字 | 期望 | 说明 |
|---|---|---|
| running | **true** | P9-A2 起这一页单独给「实际跑不跑」，与收消息共用同一判据；`mounted` 只说明执行器在（关着也在，为了热切换） |
| shadowWouldSend | > 0 | 说明模型确实在正常产出决策 |
| spoken | **必须为 0** | 出现非零 = 闸门漏了，立刻停下查 |
| eventContextInjected / Denied | 两个都非零 | 全是 denied 说明群号或时间线有问题 |
| starvationWarnings | 偶发 | 频繁说明限频/失败退避把判断卡住了 |
| sendAttempts / sendFailures | 两个都 0 | shadow **不该**有任何平台发送尝试；非 0 = 闸门漏了 |
| modelMsAvg / sendMsAvg | sendMsAvg 为 null | 分段耗时（P9-A3）：shadow 没有发送，所以发送均值必须是 null 而不是 0 |

---

## 4. C 阶段：单测试群 live（**需要操作者授权**）

### 4.1 授权前的检查单

- [ ] 有一个**专用测试群**（不是用户的主力群），群友知情；
- [ ] presence.mode = 'shadow' 已跑够一段时间，shadowWouldSend > 0 且 spoken === 0；
- [ ] presence.groups 里**只有**这个测试群；
- [ ] speakMinIntervalMs / speakMaxPerHour 从**保守值**起步（例如 600000 / 2）；
- [ ] presence.socialGuard 先保持 warn，看过日志里「语义复核命中」的条数与理由；
- [ ] presence.stickers = false（表情另走 D 阶段）；
- [ ] 操作者明确说「可以把 mode 改成 live 了」。

### 4.2 切换

    "presence": { "mode": "live", "groups": [<测试群号>], "speakMaxPerHour": 2 }

热生效（hot: live），不需要重启。**先在 shadow 里看过的那些话，现在会真的发出去。**

### 4.3 单群实测检查项（§5.2）

| 检查项 | 怎么看 |
|---|---|
| 未 @ 的自然插话是否恰当 | presence-shadow.jsonl 与真实发送逐条对照 |
| 被 @ 后与自主接话是否像同一个人 | 同一段对话里两种出口的语气对比 |
| reply 是否引用正确的消息号 | 群里看引用条；sent-log 里有 messageId |
| 引用窗口过期时不乱发 | 隔很久的话题不该被重新捡起（replyWindowMs 默认 10 分钟） |
| join/react 不会答非所问 | 事件到达晚时是否接了一句过时的话 |
| 自己发出的回显不触发下一次判断 | 日志里不该出现「因为自己那条而判断」 |
| 超时 / 供应商失败 / 断连 / 缺回执不补发 | 日志里应有「不重试」，且没有连续两条相同内容 |
| 运行中 live → shadow/off 立刻生效 | 包括**在途**模型结果与表情包（有单测钉住，见 test/presence-mode.test.ts） |
| 人工标注至少覆盖五类 | 合适的发言 / 不该发但发了 / 该发却没发 / 回复错对象 / 人格不一致 |

样本量以实际可观测为准，**不为凑统计而多说话**。

---

## 5. D 阶段：表情包（**需要操作者授权 + 素材审核**）

presence.stickers 默认关；companion-expression 的 delivery.enabled 也要单独打开。
**文字 live 不等于允许发图。**

流程（§5.3）：

1. 检查群图库授权与已审核素材；
2. 单测试群分批启用，继续用独立冷却（默认 10 分钟）与小时额度（默认 1 张）；
3. 验证没有合适素材时**正常退化为仅文字**，失败时不重复发图；
4. 验证**撤销素材授权后无法再次选择/发送**。

> **`shadow` 下不会走表情这条链路（P9-A4 更正）**：`presence-afterspeak.ts` 只在
> `outcome.kind === 'spoke'` 时才被调用，而 `shadow` 永远不会有 `spoke` —— 所以
> 「在 shadow 里看会选哪张图」**做不到**，这是靠「根本没走到那一步」而不是图库自己检查模式。
> 想先看选图贴切度，只有两条路：① 在**经授权的测试群**直接开 D 阶段（真发图）；
> ② 另外实现一个**只读的选图预览**（调 `checkSticker` 但绝不调投递服务）——目前**没有实现**。

---

## 6. E 阶段：第二个授权群（**需要第二份授权**）

只看五件事，全部在 test/group-multi-room.test.ts 里有对应的单测，但**实机必须再验一次**：

1. 两个群各自读自己的事件与话题（不串群）；
2. 限频按群独立（A 群冷却中，B 群照样能说）；
3. 连续性上下文注入计数按群分（eventContextInjected / Denied）；

> **连续性块到底给了什么（P9-A4 说明）**：`group-continuity-block.ts` 注入的是**当前话题**
> 与**她上一次在这个群说话的时间**，并明确写「内容已在上面的自述里，不要重复」。它
> **不**注入其他成员的逐条消息——那些在原有的 `background / pending / current` 组包路径里。
> 所以评估「她是否记得刚才聊了什么」时，要看的是**整包**（`background` + 连续性块 + sentBlock），
> 不能只看连续性块就说「连续性没生效」。
4. 并发负载下的判断延迟（modelMsAvg / lastBatchWaitMs）；
5. 热重载后两个群都不丢上下文。

---

## 7. 回滚手册

### 7.1 立刻停发（按力度从轻到重）

| 动作 | 生效 | 影响 |
|---|---|---|
| presence.mode = 'shadow' | 立即（热生效） | 不再发消息，但继续判断并记影子日志——**这是首选**，因为它保留了诊断 |
| presence.mode = 'off' | 立即 | 连旁听都不记（P9-A2 起执行器**仍然在**，只是不跑；所以改回 shadow/live 不需要重启） |
| presence.socialGuard = 'off' | 立即 | P6 复核完全不参与（连日志都不记） |
| 卸载 channel-qq 子插件 | 需重启 | 整条 QQ 通道停止 |

**不要用 speakMaxPerHour = 0 停发**：它只影响自主发言（停不住表情包），而且不留诊断。
这是 P5 审计里修掉的旧误区（见 docs/10a-group-baseline-audit.md §2）。

### 7.2 代码回滚

每阶段一笔独立提交，都可以单独 git revert：

| 提交 | 阶段 |
|---|---|
| 6902961 | P5 运行模式（off/shadow/live）与真实模型评测通道 |
| 7ae13ea | P6 社交场景与四类语义错误复核 |
| 9f2b25f | P7 多群连续性与调度名实相符 |
| <P8> | P8 灰度验收与运维文档（本提交只加文档与后台诊断页） |

回滚某一笔之后，**新增的配置键会退化成未知键**（按层合并保留但不生效），不会报错。

### 7.3 常见故障

| 症状 | 先看哪里 |
|---|---|
| 她一句话都不说 | presence.mode 是不是还停在 shadow；diagnostics() 的 skippedByPause |
| 说了但内容重复 | socialGuard 是不是 warn（默认只记不拦）；日志里「语义复核命中 self-repeat」 |
| 接连说同一件事 | speakMinIntervalMs / speakMaxPerHour 是不是被调得太松 |
| 判断很久才开始 | lastBatchWaitMs vs lastJudgeDurationMs：前者大是调度问题，后者大是模型慢 |
| 上下文里出现别的群的话 | eventContextInjected/Denied 与 group-multi-room 的 fail-closed 断言 |

---

## 8. 结构化日志（§4.3）

P7-C 之后，GroupPresence.diagnostics() 按群给出（**不含正文**）：
judgments / shadowWouldSend / spoken / 三种 skip 计数 / starvationWarnings /
modelLatencyMs+modelCalls / sendLatencyMs+sendAttempts+**sendFailures** / lastBatchWaitMs /
eventContextInjected+eventContextDenied / 两个时间点。

发送三段耗时的口径（P9-A3 修正）：**模型**看 `modelMsAvg`，**真实平台调用**看 `sendMsAvg`
（只含 `sendGroupMessage` 本身，不含模型与合批等待），**合批等待**看 `lastBatchWaitMs`。
P5 那版把整轮耗时记成发送耗时，会让「发送很慢」其实是模型慢——已经改掉。

后台「群社交」页只读渲染这张表，群号脱敏成末四位，**不展示正文与完整 QQ 号**。
页头除了配置里的 `mode` 还有两个字段（P9-A2）：`running`（与收消息共用同一判据的
**实际运行状态**）与 `mounted`（执行器在不在；关着也在，为了热切换）。运维要看的是
`running`——`mode` 只是输入。

---

## 9. 本阶段**没有**做到的（必须写清楚）

1. **C/D/E 全都没跑**：没有任何真实 QQ 发送记录，也没有真人盲评。
2. **B 阶段没有真实模型数据**：通道就绪但本次没有可用端点，所以「语义 WARN 是否下降」
   仍然没有结论（离线那 3 条 WARN 是**固定模型输出**下的代码侧结论）。
3. **socialGuard 阈值未校准**：0.9 重叠率与 40 分钟窗是先验值；默认 warn 期间一次都不会拦。
4. **表情链路的闸门是「靠没走到那一步」**：shadow 下不发图，是因为 presence-afterspeak.ts
   只在 outcome.kind === 'spoke' 时被调用；将来若要「shadow 下也评估表情」，必须在图库
   那条路径上再加一次同样的模式检查。**P9-A4 已把这一点写进 §5 的更正框**——按原手册
   在 shadow 里看会选哪张图是做不到的。
5. **没有运行时守护「停发」**：如果将来有人在发送路径上绕过 sendGate，现有单测能发现，
   但没有告警。
