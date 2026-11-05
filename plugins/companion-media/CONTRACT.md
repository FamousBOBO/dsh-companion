# companion-media 合同（v0.1）

[返回架构首页](../../architecture-wiki/README.md) · 2026-10-28 · 状态：M0 合同，M1–M5 逐步实现

本文件是本插件对外的**接口合同**，不是 DSH 官方 API。宿主真实可用的接口在「宿主依赖」一节逐条列出，并注明核对方式。
字段名以本文件为准；`architecture-wiki/13` 中的建议字段若与这里不一致，以这里为准（差异记录在 `logs/media-migration/M0-report.md`）。

## 1. 职责边界

`companion-media` 是媒体能力的**唯一业务入口**：识图、语音合成、生图、屏幕帧判定、分段与投递计划。
它不是通道，也不是记忆：QQ 插件只负责把 OneBot 片段翻译成 `MediaInput` 并发送 `MediaArtifact`；桌面附件由宿主附件服务提供。
记忆仍由 `companionMemory` 服务拥有，媒体层**不写** SQLite 记忆库。

## 2. 宿主依赖（全部经源码/运行核对，非文档推测）

| 依赖 | 真实接口 | 核对方式 |
| --- | --- | --- |
| 插件挂载 | Cordis 插件 `apply(ctx)`，profile 里以 `file:///…/index.mjs` 挂载 | `home/profiles/desktop/cordis.patch.yml` 中 `companion-foundation` 的挂载方式 |
| 工具注册 | `ctx.tools.register(defineTool({ name, description, parameters, output, execute, presentCall }))` | `@deepseek-ai/dsh-tools`；`companion-foundation/index.mjs:120-126` 用法 |
| 模型调用 | `ctx.llm.prepareCall({provider, model, maxTokens}, signal, ctrl => …)` + `call.stream(options)` + `BlockAssembler` | `@deepseek-ai/dsh-llm`；`companion-foundation/host-llm.mjs` |
| 模型路由 | `ctx.get('llm')`、`ctx.get('agentDefaultModel').currentSelection()` | 同上，`resolveLlmService` / `resolveRoute` |
| 多模态输入 | 内容块 `{ type:'image', attachment }`；`ImageAttachmentRef` 来自 `ctx.attachments.saveImages([{data, mediaType}])` | `@deepseek-ai/dsh-llm/lib/types/content.js`（`visitImageBlocks`）、`@deepseek-ai/dsh-attachment/lib/index.js`（`saveImages` / `admitPromptContent`） |
| 图片能力判定 | 路由模型须在 pi-ai 目录里声明 `input: ['text','image']`；`opencode-go/deepseek-v4.1-flash` 声明了 `text,image`（含 `inputLimits.images.resize`） | `@earendil-works/pi-ai/dist/providers/data/opencode-go.json` |
| Session 标识 | `exec.agent?.session?.id`；请求缺 session header 会失败（`MissingSessionID`） | `companion-foundation/index.mjs:128`、`host-llm.mjs:104-106` |
| 身份 | `identity.resolve(sessionId)`（foundation 持有）；媒体层只接受**已解析**的 owner/persona，不解析图片内容里的身份 | `companion-foundation/identity.mjs` |

宿主**没有**提供以下能力，因此由本插件自己实现，不得声称宿主已有：媒体任务队列、投递回执账本、识图路由、语音合成、生图适配、屏幕帧新鲜度判定。

## 3. 数据类型

```ts
type MediaKind = 'image' | 'sticker' | 'screen' | 'audio' | 'unknown';
type MediaSource = 'desktop' | 'qq' | 'screen-fixture' | 'generated' | 'test';

interface MediaInput {
  mediaId: string;            // 内容 hash 派生的稳定 id
  sourceEventId?: string;     // 触发它的通道事件；用于幂等
  sessionId: string;          // 宿主会话，缺省时任务被拒绝
  owner: { userId: string; persona: string };   // 由通道/身份合同解析，绝不来自图片文字
  kind: MediaKind;
  source: MediaSource;
  mime: string;
  bytes: number;
  width?: number; height?: number;
  sha256: string;
  capturedAt: string;         // ISO-8601（含时区语义，统一 UTC 表示）
  ref?: string;               // 受管文件相对路径（在 home/media 之下）
  quotedFrom?: string;        // 引用关系（被引用的 mediaId / messageId）
}

type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
interface MediaJob {
  jobId: string; requestId: string; idempotencyKey: string;
  capability: 'vision' | 'speech' | 'image' | 'screen';
  state: JobState;
  createdAt: string; deadlineAt?: string;
  cancelRequested: boolean;
  attempts: number;
  error?: { code: string; message: string };
  paramsDigest: string;       // 参数摘要 hash，日志里只出现它
}

interface VisionResult {
  ok: boolean;
  route: { backend: 'local-ollama' | 'host-llm'; provider: string; model: string; reason: string };
  description: string;         // ok=false 时为空，绝不补编
  frames: number;
  truncated: boolean;
  cached: boolean;
  elapsedMs: number;
  error?: { code: string; message: string };
}

interface MediaArtifact {
  artifactId: string; kind: 'image' | 'audio';
  path: string;                // 相对 home/media 的受管路径
  mime: string; bytes: number; sha256: string;
  width?: number; height?: number; durationSeconds?: number; sampleRate?: number; channels?: number;
  origin: 'tts' | 'novelai' | 'sticker' | 'fixture';
  jobId?: string;
  createdAt: string;
}

type DeliveryState = 'planned' | 'submitted' | 'confirmed' | 'unknown' | 'failed' | 'cancelled';
interface DeliveryReceipt {
  receiptId: string; jobId?: string; sessionId: string;
  target: { channel: string; id: string };
  state: DeliveryState;
  platformMessageId?: string;
  at: string;
  detail?: string;             // 仅诊断用，不含正文
}
```

## 4. 接口

```ts
status(): MediaStatus
inspectImage(input: { media: MediaInput | {path|bytes}, prompt?, kind?, sessionId, signal? }): Promise<VisionResult>
synthesizeSpeech(input: { text, emotion?, instructions?, sessionId, idempotencyKey?, signal? }): Promise<{ok, artifact?, error?, speechDuration}>
generateImage(input: { prompt, source, scope?, sessionId, idempotencyKey?, dryRun?, signal? }): Promise<{ok, artifact?, paramsDigest, quota, error?, preview?}>
prepareDelivery(input: { sessionId, items, mode }): DeliveryPlan
deliver(input: { plan? | sessionId, channel, target, text?, voice?, images?, items?, voiceOnly? }): Promise<DeliveryRun>
getJob(jobId): MediaJob | undefined
cancelJob(jobId): MediaJob | undefined
```

### 4.0 投递通道（`deliver`，2026-11-03 补）

`deliver()` 是**唯一**能证明"发出去了"的入口。它不自己发：通道由宿主注入，
解析顺序（每次调用重新读，热重载即生效）：

1. `mountMedia(ctx, { deliveryChannel })` —— 宿主显式注入；
2. 宿主服务 `ctx.get('companionDeliveryChannel')` —— QQ 通道在拿到真实发送器后发布。

通道接口：`{ mode: 'desktop'|'onebot', name?: string, platform?: boolean, send(step, ctx) → { ok, state?, platformMessageId?, detail? } }`。

判定（每一条都有测试 `test/delivery-real.test.mjs`）：

| 情形 | 结果 |
| --- | --- |
| 配置 `mock` | 直接拒绝 `delivery-mock`，**碰都不碰通道** |
| 配置 real 但没有通道 | 拒绝 `channel-unavailable`（`channelWired:false`） |
| 通道声明的 `mode` 与配置不一致 | 拒绝 `channel-mode-mismatch`（不跨传输发） |
| 通道返回 `{ok:true, platformMessageId}` | 该步 `confirmed` |
| 通道返回 `{ok:true}` 但没有 id | 该步 `submitted`（调用返回 ≠ 到达） |
| 通道返回 `{ok:false, state:'failed'}` | 该步 `failed`，余下步骤 `cancelled` |
| 通道抛异常 / 超时 | `unknown`（可能已到达），余下 `cancelled`，**永不自动补发** |

合并规则（`mergeItems`）：相邻 `text` 合成一条（`\n` 连接）；`voiceOnly` 且有 voice 时**删掉文本**（语音就是这句话）；图片/表情/贴纸保持相对顺序，不与文本合并。

`inspectImage`/`synthesizeSpeech`/`generateImage`/`prepareDelivery` 是合同名；实现里
`synthesizeSpeech`→`speak`、`generateImage`→`draw`、`prepareDelivery`→`plan` 有短名别名，两者等价。

`generateImage.scope` 只接受五个真实额度桶（`private_owner`/`private_friend`/`group`/
`proactive`/`natural_language`）；未知 scope 直接 `MEDIA_BAD_INPUT`，不会退化成无限额度。
默认作用域由 `source` 映射决定，调用方不能用自由字符串改写。

所有方法**不抛异常**：失败返回 `{ ok:false, error:{code,message} }`，并把同一错误写进 job/诊断日志。原因：媒体失败不能让一次聊天回合崩掉。
失败结果里的 `description` 恒为字符串（空串），不会是 `undefined`。

## 4.1 路径与生命周期

- 受管根：`home/media/`（`inbox/`、`artifacts/speech/`、`artifacts/image/`、`state/ledger.json`）。
- `MediaArtifact.path` 相对 **companion 根目录**，因此形如 `home/media/artifacts/speech/xxx.wav`。
- 读取图片只允许 `home/media/inbox/**` 与插件 `test/fixtures/**`，且先 `realpath` 再判包含（防符号链接越界）。
- 配置每次调用前按文件 mtime 重载：改动 `home/media/config.json` 后**下一次调用即生效**，无需重启（kill switch）。

## 4.2 后端的唯一合法出口

- 本地识图必须 `http://127.0.0.1:8139/ollama/...`；语音必须 `http://127.0.0.1:8139/breeze/...`。
  代码里强制校验（`assertCoordinator`），不是文档约定；指向 11434 或 8137 会被拒绝且不发请求。

## 5. 能力开关与默认值

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| `vision.enabled` | false | 关闭时 `inspectImage` 返回 `MEDIA_DISABLED`，不下载、不调用任何后端 |
| `speech.enabled` | false | 关闭时 `synthesizeSpeech` 返回 `MEDIA_DISABLED` |
| `speech.auto.enabled` | false | 自动语音：概率 0/100 是硬边界、间隔闸门挂在"尝试"上、状态存 `home/media/state/auto-voice.json`（跨重启）；`voice_only` 不重复正文；TTS 失败 fail-closed，不发文字顶替。决策/合成/频控已实现并被 12 条测试钉住，**「回合结束自动触发」的调用点尚未接线**（补丁与真实样本见 `logs/p2.5-next/auto-voice/REPORT.md`） |
| `image.enabled` | false | 生图总开关 |
| `image.allowRealGeneration` | false | 真实计费生成需显式打开；否则只做 dry-run |
| `screen.enabled` | false | 屏幕输入；关闭时不读任何屏幕、不截图。2026-11-03：帧来源是**宿主注入端口** `companionScreenFrame`（本层永不抓屏）；端口无人发布时 `enabled:true` 只会从 `MEDIA_DISABLED` 变成 `frame-source-unavailable`（诊断见 `status().capabilities.screen`），不会凭空获得截屏能力 |
| `delivery.mode` | `'mock'` | `mock`/`desktop`/`onebot`；mock **只出计划**：`deliver()` 返回 `delivery-mock`，且 `record(state='confirmed')` 会被降级成 `unknown`（没有东西能证明送达） |

## 6. 硬性约束（每条都有对应测试）

1. 普通图 → 本地 `nsfwvision`；表情/贴纸 → 云 V4.1；屏幕 → 云 V4.1 且必须 `source: 'screen'`。未分类默认走本地，**不**默认送云。声明为屏幕却未标记来源的输入一律拒绝。
2. 下载：只允许 `http(s)`；私有/环回地址需显式放行，且**按 DNS 解析后的地址**判定（`::ffff:` 映射也覆盖）；最多 2 次重定向且每跳复检；大小、耗时、像素上限硬约束；整次下载共用一个 deadline。
3. 识图结果缓存键 = `sha256(内容) + provider + model + promptVersion + owner + 实际 prompt`；owner 独立进键，调用方不能用一个 bridge 的 scope 合并两个人的缓存；同一张图换一个问题必然重新识别。
4. 语音：`march7_B`、CFG 3、seed 42、speed 0.9、`maxNewTokens` 500；后端忽略 speed 时用 FFmpeg `atempo`，**不重复变速**（仅当 speed≠1 才后处理）；后端地址必须是协调器 `8139/breeze`。
5. 语音导演只产出 `instructions`；`input` 必须与原台词一致（去空白、去白名单声音事件后比较）；非法 JSON/改台词/模型失败 → 回退原台词普通合成，绝不把 JSON 念出来。
6. 生图：默认 tag 流程 + `nai-diffusion-5-full`；额度按来源/作用域，`-1` 无限、`0` 禁用、未知作用域拒绝；失败退款、成功扣费；**超时/被杀/无输出 = `unknown`，不退款、不自动重试**；同一幂等键并发只生成一次，失败重试延长同一 job。
7. 通道回执：工具返回“已排队”不等于送达。`unknown` 不得盲目补发；重启后不自动重发任何未知结果。
8. 投递真实性（2026-11-03）：`confirmed` 必须带 `platformMessageId`，否则降级 `unknown`（mock 模式）或 `submitted`（真实模式下的 `deliver()`）；`status().capabilities.delivery.channelWired` 由**注入的通道**算出来，不许写死；`mode:'mock'` 下 `deliver()` 一律 `delivery-mock`，不产生任何外发。
8. 凭据只从本地配置文件/环境引用读取，不写入 job、日志、报告或模型上下文；`status()` 输出不含任何 token，值级模式（`pst-`/`oc_sk_`/`sk-`/`Bearer`）也会被脱敏。

## 7. 与建议稿的差异

| 13 页建议 | 本实现 | 原因 |
| --- | --- | --- |
| `mediaId/hash` 分列 | `mediaId` 即 `sha256` 派生，避免两套 id 漂移 | 内容寻址即可满足引用与缓存 |
| `MediaJob.status` 单一字段 | 任务状态与投递状态分表（`jobs` / `receipts`） | 13 页第 5 条：任务状态与发送状态分开 |
| 直接给模型 URL | 云 V4.1 走宿主真实多模态内容块（`ImageAttachmentRef`） | 13 页 M2：不能把 URL 当文本拼给模型 |
| 独立 Python 服务常驻 | 生图用一次性受限 Python 桥（stdin/stdout），不常驻 | 避免为调用 `generate_visual` 启动 AstrBot |
