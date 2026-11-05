# 语音与生图工具说明

本说明对应 `index.mjs` 注册给 DSH 模型的 `companion_media_speak` 与 `companion_media_draw`。工具及参数说明已直接写入注册定义，模型可在工具列表中读取。

## 语音：companion_media_speak

使用 Breeze TTS 2 的 Voice Direction：保持已配置的参考说话人，用自然语言指导语气、情绪、节奏和表达方式。`text` 是实际台词，`instructions` 是表演指令，两者分开填写。

```json
{
  "text": "别着急，我会陪你一起想办法的。",
  "instructions": "保持参考说话人的音色。像在安慰对方，声音轻柔，前半句平稳，最后一句认真而坚定。"
}
```

省略 `instructions` 时，现有语音导演会结合 `context` 理解台词；导演失败则使用原台词和情绪预设合成。`emotion` 的自然、开心、委屈、生气是本地预设，不是官方固定情绪体系。指令语言与台词保持一致是本项目的写作约定。

需要实际发出声音时，可在台词中使用官方事件：中文 `[笑]`、`[咳嗽]`、`[清嗓子]`、`[叹气]`，英文 `(laugh)`、`(cough)`、`(clears throat)`、`(sigh)`。只需带着笑意说话时，在表演指令中说明即可。无需把事件加到每句话里。

工具使用现有 march7_B 音色与 CFG 3、seed 42、speed 0.9 配置；官网示例的 CFG 4 不作为此次改动配置的依据。返回 WAV 产物不等于已发送。

官方依据：[Breeze TTS 2 模型说明的 Voice Direction 与 Vocal Events](https://huggingface.co/BreezeBlue/Breeze-TTS-2#-voice-direction)。

## 生图：companion_media_draw

`prompt` 用自然语言完整句子描述一张图。按官网指南把主体和重要要求放在前面，再按画面需要补充外貌、服装、动作、场景、构图、视角、光线和画风，避免冗长重复。多人画面用句子明确每个人的特征、位置与互动。该工具当前只提供单个 prompt，不能把官网的独立角色提示词面板当成工具已有参数。

```json
{
  "prompt": "一位粉色短发、蓝色眼睛的女孩穿着白色外套，坐在列车窗边，微笑着看向镜头。画面为平视半身像，窗外是暮色中的雪山，暖色车厢灯光照亮她的脸，采用细腻的日系动画插画风格。",
  "source": "user_request",
  "composeTags": false
}
```

自然语言是本工具的调用约定；官网同时支持自然语言与标签，并未规定只能使用自然语言。

生图工具描述还包含本项目的角色一致性约束：自拍、“你”、三月七换装或表情图须明确写出《崩坏：星穹铁道》的三月七、粉色头发、蓝到粉渐变的眼睛，不能退化成泛指女孩或纯蓝眼睛。外貌遵循当前 PERSONA.md，衣着与场景承接本轮已确认状态；日常默认休闲可爱、脖挂拍立得，仙舟剑术造型才使用汉服和双剑。换装保留未指定改变的身份与外貌，连续图片保留未改变的细节。风景、物品或其他角色请求不强行加入三月七。此为模型调用约束，未添加程序自动注入或校验。

- `composeTags` 默认省略或 false：自然语言直接传入后端；true 才启用现有的独立标签转换模型。调用方始终用自然语言写 `prompt`。
- `context` 仅用于可选的标签转换。默认直传时，要把必要的角色外貌、服装和场景全部写进 `prompt`。
- `style` 是可选的补充画风描述，通常直接写进 `prompt` 即可。
- `source` 决定额度归类；`natural_language` 这个枚举值不控制提示词格式。
- **`prompt` 原生写英文**（2026-11-04）：NovelAI 只读英文 caption，所以工具描述直接要求用英文自然语言写画面，并给了英文示例（`March 7th from Honkai: Star Rail, pink hair, blue-to-pink gradient eyes ...`）。`style` 同样英文；只有 `context`（喂给标签转换模型）可以是中文。
- **衣着由衣柜负责，prompt 不写衣服**（2026-11-04）：`draw` 会读 `home/companion/wardrobe.json`（companion-foundation 的确定性衣柜变量），把今天真实穿的那套翻成英文追加成 `wearing …`。所以 prompt 只写场景/动作/表情/镜头/光线/画风；模型自己编衣服会与衣柜打架。用户明确换装时才用 `outfit` 参数，并先调 `companion_outfit_set` 落库。返回里的 `outfit: {source, injected, items, date}` 说明这次用了哪套、是 `daily`（按衣柜轮换）、`explicit`（当天指定）、`parameter`（调用方显式给）还是 `prompt`（prompt 已含衣柜单品，未重复追加）。
- `image.translatePrompt.enabled`（默认开）是**兜底**：万一调用方仍写了中文，这一跳会在编码前译成英文，`draw` 返回 `promptTranslation.translated` 说明是否触发、失败时 `reason` 写明原因。正常用法不该依赖它。
- 后端沿用现有管线，内部 JSON 字段名 `tag` 及配置名 `generationFlow: tag` 不要求调用方使用标签；当前编码器会把 `prompt` 原文装入该字段。
- `dryRun=true` 只校验参数。真实生成开关以 `home/media/config.json` 的 `image.allowRealGeneration` 为准（2026-10-30 起为 `true`，配置热重载生效）；该值为 `false` 时即使未指定 dryRun 也不会真实生成，不能把预览结果当成图片。判别方法：看 `result.dryRun`，不要凭文档推断。

真实生成返回 `artifact.path`（相对陪伴工程根目录）、`artifact.absolutePath`（绝对路径，已校验存在性）与 `handoff`（`tool`/`action`/`file`/`ready`/`delivered:false`/`mustSend`）。**合成或生成都不等于送达**：语音必须再用 `qq_voice action=send_file` 发（图片用 `qq_sticker action=send`），并把 `handoff.file` 原样作为 `file` 参数；只有通道返回 message_id 才算发出。发送时 `isGroup`/`target` 按当前会话填写。

官方依据：[NovelAI 提示词基础](https://docs.novelai.net/en/image/basics/)，其中 Natural Language vs Tagging、主体优先、构图和媒介描述适用于本工具。

## 运行时工具：`companion_media_warm`

语音和识图共用一台显卡，协调器（8139）同一时刻只允许一个后端。这个工具把"什么时候加载、什么时候卸载"变成可操作的动作：

| action | 作用 | 关键返回 |
| --- | --- | --- |
| `warm`（默认） | 向协调器发一个**最小真实请求**，把权重真正读进显存 | `elapsedMs`、`switchedFrom`、`active`、`idleReleaseSeconds` |
| `release` | 立即释放，包括内存中的模型 | `active: null` |
| `status` | 只读查看，不触碰模型 | `active`、`busy`、`idleRemainingSeconds`、`lastWarm` |

- `target` 在 `warm` 时必填：`voice`（本地 Breeze）或 `vision`（本地识图，屏幕帧也走这条）。
- **先后都可以，同时不行**：先 warm vision 再 warm voice 会自动切走前一个（返回 `switchedFrom: vision`）；已有加载在进行中时再次调用直接返回 `MEDIA_BACKEND_BUSY`，不会排队等。
- **空闲 300 秒自动卸载**：任何识图/语音调用都会重置倒计时；倒计时到点由本层主动调 `/unload`，协调器自己也有同样的 300 秒兜底。
- 冷启动会撞上协调器的 502/503/504（Ollama 尚未就绪），本工具默认重试 3 次、间隔 1.5 秒；实测首次识图预热约 17 秒。
- 配置在 `home/media/config.json` 的 `runtime`：`baseUrl`、`idleReleaseSeconds`、`loadTimeoutMs`、`pollIntervalMs`、`warmRetry.{attempts,delayMs}`。
- **协调器死了会自动拉起**：`runtime.autoStart.{enabled,pythonPath,scriptPath,cwd,waitMs}` 打开时，`warm` 先探 `/health`，不通就 `spawn` 分离进程并等到就绪；关掉则返回 `MEDIA_BACKEND_UNAVAILABLE` 并提示手动启动。

## 加载与验证

工具说明随插件注册加载，修改源码后需要重新加载插件或重启 DSH 宿主。修改媒体配置的热重载不会刷新已注册的工具说明。此次只更新说明，未改动后端、参数结构或真实生成开关。
