# TOOL_GUIDE —— 给模型看的媒体工具用法

本文件写给**调用工具的一方**（模型 / 编排代码）。合同细节看 `CONTRACT.md`，实现看 `src/`。

五个工具，没有别的入图/识图/预热工具。别去找 `companion_media_inspect` 或 `companion_media_warm`：它们已按规格移除（见 `CONTRACT.md` §3.0）。

---

## 0. 三条铁律

1. **生成 ≠ 投递。** `companion_media_draw` / `companion_media_speak` 只会在本机产出一个文件，返回 `handoff.delivered=false`。要对方真的收到，必须再调用对应通道的发送工具（QQ 场景：`qq_sticker action=send_image` 发图、`qq_voice action=send_file` 发语音）。**不要**对用户说"已经发给你了"，除非通道工具返回了确认。产物默认在 `<dataRoot>/workspace/media/` 下（通道可读边界内）；如果返回的路径不在 `<dataRoot>/workspace` 或 `<dshHome>/channel-qq` 里，通道会拒绝发送——这时要告诉用户改配置 `paths.artifactsDir`，不要自己搬文件。
2. **失败不要自作主张重试。** 生图是计费能力，本层**不会**自动重试；工具返回 `on:false` + 错误码时，把原因告诉用户，由用户决定是否再来一次。`MEDIA_RATE_LIMITED` 时尤其不要连发。
3. **默认关闭不是故障。** `MEDIA_DISABLED` 表示用户还没在「媒体能力」里打开这个能力（或用的是"已保存未测试"的配置）。正确回应是告诉用户去哪里开，而不是换个参数硬试。

---

## 1. `companion_media_status`

读状态。**先调它再生成**，可以避免把"未配置"当"服务坏了"。

返回里最有用的字段：

| 字段 | 怎么用 |
|---|---|
| `states.image.enabled` / `states.tts.enabled` | 能力开关是否打开 |
| `states.image.providers[].state` | 六个状态词之一：`disabled` / `unconfigured` / `not-connected` / `saved-untested` / `test-ok` / `test-failed` |
| `states.image.providers[].missing` | 缺哪些必填项（数组） |
| `states.image.retryPolicy` | 恒为 `never-auto` |
| `states.vision` | `reserved-disabled`：识图只是合同，别尝试调用 |
| `limits` | 超时、字节上限、最大文本长度 |
| `facts[]` | 可以直接引用给用户的一句话结论 |

**不要**把 `saved-untested` 说成"连接成功"。

---

## 2. `companion_media_draw`

参数：`prompt`（必填）、`negative`、`subject`、`outfit`、`dryRun`（可选）。

- 调用方直接构思英文画面，用完整句子把主体和关键要求放在前半段，再描述场景、动作、镜头、光线和画风。生图服务按原文提交。[NovelAI 官方提示词指南](https://docs.novelai.net/en/image/basics/)
- 画陪伴角色前必须调用只读工具 companion_media_visual，读取当前人格的英文身份与衣柜解析的当前衣物，成功后再传 subject=companion。
- 模型将身份、镜头内可见衣物的颜色/材质/剪裁/层次，与动作、表情、视线、构图、环境和光线融合成完整英文 prompt。不要逐字粘贴身份串，不要机械加入习惯性相机等配饰，也不要写镜头外的鞋袜。
- 最终正向提示词严格为 **画师串 + 主提示词**。程序不追加身份、衣物、正向预设或质量词；已保存的正向预设保留为参考，反向预设仍按配置合并。
- 用户要求换装时先调用 companion_outfit_set 更新衣柜，再重新读取。旧 outfit 参数只作换装参考，不会自动进入提示词；衣物必须写在完整 prompt 中。
- **视觉身份是强制条件。** 身份不存在、读不出来、结构无效、与当前 persona 不匹配，或者只有中文外观时，真跑**直接拒绝**（`MEDIA_VISUAL_IDENTITY_REQUIRED`，`details.missing` 里写 `identity` 或 `identity-english`），**不会**发任何网络请求。`outfit` 只能替换衣物，**不能**绕过身份——一张只有衣服没有脸的图不是这个角色。先在 `home/companion/visual-identity.json` 里为该 persona 配好英文外观。
- 衣柜里没有可用的英文描述时，真跑同样拒绝（`MEDIA_BAD_INPUT`，`details.missing` 含 `wardrobe`），不会凭空编一套衣服。
- `dryRun` 与真跑用**同一个**判定：被拒绝时 `dryRun` 返回 `{ok:true, dryRun:true, visualRequired:true, visual, refusal}`，`refusal` 与真跑返回的 `error` 同源，所以可以先 dry-run 确认「这次会不会被拒绝」。
- `negative` 只在需要临时压制某些内容时用；固定反向提示词应放在配置里（`image.nai.negativePrompt` 或按族的预设）。
- `dryRun: true` 只做参数/分辨率/预设族校验，不发网络请求。**先 dry-run 再真跑**是省额度最有效的习惯。
- 成功返回 `artifact.absolutePath` 与 `handoff.file`（同一个绝对路径），直接把 `handoff.file` 交给发送工具。
- 常见错误码：`MEDIA_DISABLED`（没开）、`MEDIA_NOT_CONFIGURED`（缺必填项）、`MEDIA_VISUAL_IDENTITY_REQUIRED`（缺视觉身份，或身份只有中文外观）、`MEDIA_BAD_INPUT`（参数不对 / 衣柜给不出英文衣物 / `subject` 不是 `companion`）、`MEDIA_PARAM_OUT_OF_RANGE`（尺寸/步数越界，**不会**被悄悄改值）、`MEDIA_AUTH_FAILED`、`MEDIA_ENTITLEMENT`（NAI 无订阅）、`MEDIA_RATE_LIMITED`、`MEDIA_TIMEOUT`、`MEDIA_UPSTREAM`、`MEDIA_UNSUPPORTED_TYPE`（上游返回的不是图片）。

示例（须用本次读取的外观和衣物替换示范内容）：

> A single young woman with short silver-grey hair and amber eyes sits sideways at a rain-streaked cafe window, wearing a pale blue cable-knit cardigan over an ivory cotton blouse, its ribbed cuffs resting at her wrists. Her left hand cups a warm ceramic mug on the wooden table while her right hand rests beside an open book. She turns toward the viewer with a relaxed, closed-mouth smile. Frame her from the waist up at eye level, with her face in the upper third and both hands clearly visible. Cool overcast daylight enters from the left; a warm pendant lamp softly lights her cheek from the right. Outside, blurred umbrellas and reflections recede into the wet street. Delicate linework, softly shaded fabric folds, restrained blue and amber colors, a quiet intimate atmosphere.

NovelAI 相关：
- 官方连接方式可选「使用排队服务器」。打开后填写已有协调服务器的地址和用户标识，等拿到许可再调用官方生图接口。排队失败会结束本次请求。排队服务器只收到密钥摘要和排队标识，图片提示词与密钥只发给生图服务。
- 分辨率必须是 64 的倍数，短边 ≥256、长边 ≤2048、面积 ≤3,000,000px；越界是**错误**，不是自动收敛。用 `GET /api/companion-media/preview?mode=auto&aspect=portrait&targetPixels=1011712` 先算好。
- 预设按模型族分仓：`nai-diffusion-5-*` 用 V5 的预设，`nai-diffusion-4-5-*` 用 4.5 的预设；你不会、也不能把两者混用。

---

## 3. `companion_media_speak`

参数：`text`（必填）、`provider`（可选，默认用配置里的默认后端）、`instructions`（可选，仅 Breeze 支持）。

- `text` 只放**要朗读的正文**，保留原语言和自然标点。Breeze 的 `instructions` 可直接描述语气、情绪、速度、停顿和重音，例如「用轻柔、略带笑意的口吻，语速稍慢，在问候后停顿一下」。省略时沿用后端配置。
- 各后端注意：
  - **Breeze TTS 2**：服务单并发，占用中返回 `MEDIA_BACKEND_BUSY`（等一会儿再试）；参考音频与逐字稿必须同时配置，否则本地就拒绝。
  - **GPT-SoVITS**：`ref_audio_path` 是**服务端的路径**，不是本机文件；`media_type=raw` 不受支持（没有可靠采样率），用 `wav`。
  - **Fish Audio / Drama3**：计费；`format=pcm` 不受支持（同上），用 `wav`；Drama3 的多说话人在配置里用逗号分隔多个 `reference_id`，正文用 `<|speaker:0|>` 标签切人。
  - **Index-TTS**：尚未接入（没有官方 HTTP 协议），会返回 `MEDIA_PROVIDER_NOT_IMPLEMENTED`。不要反复试。
- 成功返回 `handoff.file`，交给 `qq_voice action=send_file`。

---

## 4. `companion_media_job`

读作业与产物元数据。用来回答"刚才那张图/那段语音呢"：

- `jobs[]`：`jobId`、`kind`、`provider`、`state`（`running`/`succeeded`/`failed`）、`error.code`、`bytes`；
- `artifacts[]`：`artifactId`、`kind`、`mime`、`bytes`、`durationSeconds`（语音可能为 `null`）；
- **不含提示词正文、不含媒体内容**：账本只存摘要与元数据（隐私约定，见 `CONTRACT.md` §7）。

---

## 5. 典型流程

```
1. companion_media_status           → 看 image/tts 是否 enabled、provider 是哪个、state 是什么
2. companion_media_visual → 读取身份与当前衣物，构思完整 prompt
3. companion_media_draw {prompt, subject:"companion", dryRun:true}
                                    → 校验参数（尤其 NAI 尺寸与预设族）
4. companion_media_draw {prompt, subject:"companion"}
                                    → 拿到 artifact.absolutePath / handoff.file
5. qq_sticker action=send_image {file}    → 只有这一步成功，才算"发出去了"
```

语音同理：`companion_media_speak {text}` → `qq_voice action=send_file {file}`。

---

## 6. 不要做的事

- 不要在没有 `dryRun` 的情况下反复试探参数（每次都是真实计费请求）。
- 不要把上游错误消息里的 URL/body 转述给用户（可能含账号线索）；用错误码 + 建议动作。
- 不要尝试打开识图（没有工具，也不接受 `enabled:true`）。
- 不要尝试让插件"安装模型 / 预热显存 / 启动服务"——它只连接用户已经配好的地址。
