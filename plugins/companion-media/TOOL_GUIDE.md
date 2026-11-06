# TOOL_GUIDE —— 给模型看的媒体工具用法

本文件写给**调用工具的一方**（模型 / 编排代码）。合同细节看 `CONTRACT.md`，实现看 `src/`。

四个工具，没有别的入图/识图/预热工具。别去找 `companion_media_inspect` 或 `companion_media_warm`：它们已按规格移除（见 `CONTRACT.md` §3.0）。

---

## 0. 三条铁律

1. **生成 ≠ 投递。** `companion_media_draw` / `companion_media_speak` 只会在本机产出一个文件，返回 `handoff.delivered=false`。要对方真的收到，必须再调用对应通道的发送工具（QQ 场景：`qq_sticker action=send` 发图、`qq_voice action=send_file` 发语音）。**不要**对用户说"已经发给你了"，除非通道工具返回了确认。产物默认在 `<dataRoot>/workspace/media/` 下（通道可读边界内）；如果返回的路径不在 `<dataRoot>/workspace` 或 `<dshHome>/channel-qq` 里，通道会拒绝发送——这时要告诉用户改配置 `paths.artifactsDir`，不要自己搬文件。
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

参数：`prompt`（必填）、`negative`（可选）、`dryRun`（可选）。

- `prompt` 用**英文完整句子**，主体与关键要求在前，然后场景、动作、表情、镜头、光线、画风。不要用逗号堆标签（NovelAI 的 V5/4.5 也能读自然语言，但结构化标签更容易出现互相矛盾的描述）。
- `negative` 只在需要临时压制某些内容时用；固定反向提示词应放在配置里（`image.nai.negativePrompt` 或按族的预设）。
- `dryRun: true` 只做参数/分辨率/预设族校验，不发网络请求。**先 dry-run 再真跑**是省额度最有效的习惯。
- 成功返回 `artifact.absolutePath` 与 `handoff.file`（同一个绝对路径），直接把 `handoff.file` 交给发送工具。
- 常见错误码：`MEDIA_DISABLED`（没开）、`MEDIA_NOT_CONFIGURED`（缺必填项）、`MEDIA_PARAM_OUT_OF_RANGE`（尺寸/步数越界，**不会**被悄悄改值）、`MEDIA_AUTH_FAILED`、`MEDIA_ENTITLEMENT`（NAI 无订阅）、`MEDIA_RATE_LIMITED`、`MEDIA_TIMEOUT`、`MEDIA_UPSTREAM`、`MEDIA_UNSUPPORTED_TYPE`（上游返回的不是图片）。

NovelAI 相关：
- 分辨率必须是 64 的倍数，短边 ≥256、长边 ≤2048、面积 ≤3,000,000px；越界是**错误**，不是自动收敛。用 `GET /api/companion-media/preview?mode=auto&aspect=portrait&targetPixels=1011712` 先算好。
- 预设按模型族分仓：`nai-diffusion-5-*` 用 V5 的预设，`nai-diffusion-4-5-*` 用 4.5 的预设；你不会、也不能把两者混用。

---

## 3. `companion_media_speak`

参数：`text`（必填）、`provider`（可选，默认用配置里的默认后端）。

- `text` 只放**要朗读的正文**，保留标点，不要放 Markdown、JSON、舞台说明。Breeze 的表演指令写在配置里（`instruction`），不通过本工具传。
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
2. companion_media_draw {prompt, dryRun:true}
                                    → 校验参数（尤其 NAI 尺寸与预设族）
3. companion_media_draw {prompt}
                                    → 拿到 artifact.absolutePath / handoff.file
4. qq_sticker action=send {file}    → 只有这一步成功，才算"发出去了"
```

语音同理：`companion_media_speak {text}` → `qq_voice action=send_file {file}`。

---

## 6. 不要做的事

- 不要在没有 `dryRun` 的情况下反复试探参数（每次都是真实计费请求）。
- 不要把上游错误消息里的 URL/body 转述给用户（可能含账号线索）；用错误码 + 建议动作。
- 不要尝试打开识图（没有工具，也不接受 `enabled:true`）。
- 不要尝试让插件"安装模型 / 预热显存 / 启动服务"——它只连接用户已经配好的地址。


## 提示词生成管线与语音导演（2026-11-07）

`image.pipeline` 支持 `compose`（将本轮描述编排为 NovelAI 英文标签）和 `translate`（仅翻译正向描述为英文）。它只对 NovelAI 生效，随后仍应用用户选定的生成预设、画师串和反向提示词。提示词模板已内置，不依赖 AstrBot 安装目录；可以在媒体页编辑本机模板。

`tts.director` 为 Breeze 生成自然语言表演指令，只可插入受支持的声音事件，不得改写原台词。失败时使用原台词与调用方/配置已有指令；取消或总预算耗尽后不会继续调用媒体后端。其他语音后端不调用该导演。

两者均使用**每次调用时的 DSH 默认模型**，复用宿主凭据，没有单独的模型或密钥。公共默认关闭；配置保存在被忽略的数据目录。打开页面、读取配置、连接测试和生图 dry-run 均不调用模型。每阶段最多一次模型调用，不自动重试，处理结果在返回的 `processing` / `director` 中说明；日志不记录提示词、台词或导演正文。

本节取代早期 M0/M4 报告中“丢弃 tagProvider / translatePrompt / speech.director”的范围说明。识图、衣柜与自动语音发送不因此启用，生成产物仍由通道单独投递。
