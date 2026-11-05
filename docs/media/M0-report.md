# M0 报告：源码与协议盘点

- 阶段：M0（源码 / 协议盘点）
- 核实日期：2026-11-05
- 核实方式：直接抓取官方仓库源码 / 官方 API 文档 / 官方 Swagger 规范（见每条来源 URL），并在本机发出**不带凭据**的最小探测（仅确认端点存在与鉴权状态，不产生计费请求）。
- 证据分级（本报告每行都标）：
  - **A 源码/官方规范**：官方仓库源码或官方 API 规范文件里逐字确认。
  - **B 官方文档页面**：官方文档站页面文字确认（无源码交叉验证）。
  - **C 社区参考实现**：MIT 许可的第三方插件源码（交叉验证字段名，不作权威）。
  - **D 未核实**：没有拿到证据，或只有传闻。

> 结论先行：**生图两条协议（OpenAI-compatible、NAI 官方/中转）可接入**；TTS 五个 provider 中 **Breeze TTS 2 / GPT-SoVITS / Fish Audio / Drama3 可接入**，**Index-TTS 官方只提供 Python API 与 WebUI，没有官方 HTTP 协议 → 标记「尚未接入」**（详见 §4.4）。

---

## 1. 盘点范围与既有实现

### 1.1 发布树里的 `companion-media`（存量）

存量插件是给**作者本人的生产环境**写的：`config.mjs` 里既有 `<作者机器路径>/breeze-tts2/...` 之类的绝对路径，也有本地 GPU 协调器（`127.0.0.1` 上的固定端口）、`novelai-pipeline-bridge` 的 Python 桥、HF Space 队列、屏幕截图、衣柜、自动语音等能力。它与本期规格的差距：

| 存量实现 | 本期规格要求 | 处置 |
|---|---|---|
| `companion_media_warm` / `releaseWeights` 调 8139 协调器预热/卸载本地权重 | 「本期明确不做：本地模型预热/释放、显存协调器管理」 | **移除**（工具、服务方法、lib/coordinator.mjs 一并删） |
| `image.backend='novelai-pipeline-bridge'` + `bridge/nai_generate.py`（要用户本机 python + AstrBot 插件目录） | 「本期只通过 API 调用媒体服务」；插件加载不得依赖 python | **移除**，改为纯 HTTP adapter；旧配置里该字段迁移时标记 unsupported，不静默使用 |
| 单后端 `speech.backend`（本地 Breeze） | 五个可独立配置/启用的 TTS adapter | **重写**为 provider registry |
| 识图 `companion_media_inspect` 工具 + 本地/云双路由 | 「默认关闭，且工具、页面按钮、自动流程都不能绕过；只留合同」 | **移除工具**，只保留合同与配置项 |
| 绝对路径、旧人格 id 的音色前缀、旧用户号前缀、旧人格名文案 | 去作者化；personaId 可解析（`DSH_COMPANION_PERSONA_ID` → `suite.json` `persona.id` → `bot`） | 全部改为配置项 + 解析函数 |
| `lib/*.mjs` 手写源码放在 `lib/` | 团队决策 D6：`plugins/**/lib/**` 一律 gitignore（视为构建产物） | 源码迁到 `src/`，`lib/` 不再存在 |

### 1.2 依赖图（M0 交付物之一）

```
companion-media
  index.mjs                 ← 唯一入口（DSH bundle apply）
  src/service.mjs           ← 业务门面：status / config / test / generate / synthesize
  ├─ src/config-schema.mjs  ← schema、默认值、provider 能力表（唯一事实来源）
  ├─ src/config-store.mjs   ← 读写 + 原子替换 + 旧配置迁移
  ├─ src/secrets.mjs        ← 脱敏（键名 + 值形）
  ├─ src/presets.mjs        ← NAI V5 / 4.5 正负预设（模型能力绑定）
  ├─ src/resolution.mjs     ← 自动分辨率计算与预览
  ├─ src/net.mjs            ← 请求预算、响应体上限、可注入 fetch（测试用 mock）
  ├─ src/errors.mjs         ← 稳定错误码 + 远端错误映射
  ├─ src/ledger.mjs         ← 作业/产物账本（落 dataDir，不进仓库）
  ├─ src/http-api.mjs       ← /api/companion-media/**（本机已认证 Connection）
  ├─ src/ui-page.mjs        ← 「工具 → 媒体能力」页描述符 + 纯渲染（不依赖框架）
  ├─ src/vision.mjs         ← 识图合同（恒为 disabled）
  └─ src/adapters/*.mjs     ← 7 个 adapter（2 生图 + 5 TTS）
```

`companion-media` 不 import 任何其他插件；其他插件也不 import 它（已在发布树全量 grep 确认：除自身外 0 处引用）。因此本期重构不会打断其他模块。

---

## 2. 生图协议字段矩阵

### 2.1 OpenAI-compatible（`POST {baseUrl}/images/generations`）

| 项 | 内容 | 证据 |
|---|---|---|
| 规范来源 | `openai-openapi.yaml`（OpenAI 官方 OpenAPI 仓库） | A — https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml （2026-11-05 抓取，4,327,686 字节） |
| 端点 | `POST /v1/images/generations`（`/images/generations`），另有 `/images/edits`、`/images/variations`（后者已 retired） | A — 同上，paths `/images/generations` |
| 鉴权 | `Authorization: Bearer $OPENAI_API_KEY` | A — 同上 examples |
| 请求 JSON | `model`(必填)、`prompt`(必填, ≤32000 字符)、`n`(1–10，默认 1)、`size`(`auto`\|`1024x1024`\|`1536x1024`\|`1024x1536`；GPT-image-2 系支持任意 `WxH`，宽高需整除 16、比例 1:3–3:1、上限 3840x2160)、`quality`(`low`/`medium`/`high`/`xhigh`/`max`/`auto`)、`background`(`transparent`/`opaque`/`auto`)、`output_format`(`png`/`jpeg`/`webp`/`gif`/`svg`，默认 png)、`output_compression`(0–100，默认 100)、`moderation`(`low`/`auto`)、`stream`(bool)、`partial_images`、`safety_identifier`(≤128) | A — 同上 `CreateImageRequest` |
| 已废弃/不可用字段 | `response_format`（官方标 deprecated，且 GPT image 模型**总是返回 base64**）、`style`（只能用于已退役的 DALL·E）、`user`（用 `safety_identifier` 代替） | A — 同上 |
| 响应 | `200 application/json` → `ImagesResponse{ created, data:[Image], background, output_format, size, quality, usage }`；`Image` 含 `b64_json` 和/或 `url`；`stream:true` 时变 `text/event-stream` | A — 同上 `ImagesResponse` / `Image` |
| 错误码 | 400 参数无效、403 无该模型权限、410 端点已退役、429 限流、500 生成失败、503 服务不可用 | A — 同上 responses |
| 限流 | 由 429 表达；官方未在规范里给具体 RPM/TPM | A/D — 规范只有 429，无具体额度 → **额度数值未核实** |
| 许可 | OpenAI 服务条款（闭源商业 API）；本仓库只调用，不复制代码 | — |
| 版本 | 规范随官方仓库滚动更新；本报告按 2026-11-05 抓取版本 | A |
| 结论 | **可接入**（`status: connected`） | — |

适配器实现要点：`/v1` 前缀由用户填的 Base URL 决定（允许 `https://api.openai.com/v1` 或第三方兼容站），adapter 只追加 `/images/generations`；`response_format` 不发送；`url` 分支必须走本层的有界下载（不允许把任意远端 URL 直接交给宿主）。

### 2.2 NAI 官方直连（`POST https://image.novelai.net/ai/generate-image`）

| 项 | 内容 | 证据 |
|---|---|---|
| 规范来源 | NovelAI 官方 API 的 Swagger 规范（内联在 `swagger-ui-init.js`） | A — https://api.novelai.net/docs/docs/swagger-ui-init.js （2026-11-05 抓取，134,694 字节） |
| 端点 | `POST /ai/generate-image`；同族还有 `/ai/generate-image/suggest-tags`（GET，`model`+`prompt`） | A — 同上 paths |
| 主机 | 生成接口在 `image.novelai.net` | A — 无凭据探测 `https://image.novelai.net/ai/generate-image` 返回 **401**（2026-11-05 本机） |
| 鉴权 | `security: bearer` → `Authorization: Bearer <Access Token>`（持久访问令牌） | A — 同上 |
| 请求 JSON | `{ input, model, action, parameters, url? }`，必填 `input`/`model`/`parameters`；`input` 1–40000 字符；`action` ∈ `generate`/`img2img`/`infill` | A — 同上 `AiGenerateImageRequest` |
| `parameters` | 官方规范写的是「model specific」不列字段 → 具体字段只有 C 级证据 | A(结构) / C(明细) |
| `parameters` 实际字段（社区实现交叉验证） | `width`,`height`,`scale`,`sampler`,`noise_schedule`,`steps`,`n_samples`,`seed`,`negative_prompt`,`ucPreset`,`qualityToggle`,`sm`,`sm_dyn`,`cfg_rescale`,`skip_cfg_above_sigma`,`dynamic_thresholding`,`add_original_image`,`use_coords`,`deliberate_euler_ancestral_bug`,`prefer_brownian`；V4 起提示词用 `v4_prompt{caption{base_caption,char_captions[]},use_coords,use_order}` 与 `v4_negative_prompt` | C — https://github.com/woakato/astrbot_plugin_nai_image （MIT）`main.py` 中 `parameters` 组装；同项目 `_conf_schema.json` 的 HTTP 档案字段 |
| 响应 | `201`，官方描述 "SSE / ZIP attachment"；`AiGenerateImageResponse{ ptr, image(base64), final, error }` | A — 同上 `AiGenerateImageResponse` |
| 模型 ID | `nai-diffusion-5-full` / `nai-diffusion-5-curated` / `nai-diffusion-4-5-full` / `nai-diffusion-4-5-curated` | C — 同上 `_conf_schema.json`；官方文档只写模型**名称**（V5 Full / V5 Curated / V4.5 Full / V4.5 Curated）：B — https://docs.novelai.net/en/image/models/ ；官方 Swagger 的 `model` enum **停留在 nai-diffusion-3，已过期**（A 但不可用）→ 模型 ID 字符串本身标 **C 级** |
| 过期模型无 V5 枚举 | 官方 Swagger enum：`nai-diffusion`,`safe-diffusion`,`nai-diffusion-furry`,`custom`,`nai-diffusion-inpainting`,`nai-diffusion-3-inpainting`,`safe-diffusion-inpainting`,`furry-diffusion-inpainting`,`kandinsky-vanilla`,`nai-diffusion-2`,`nai-diffusion-3` | A — 同上 |
| 错误码 | 400 校验失败、401 token 错、402 无有效订阅、409 冲突、500 未知 | A — 同上 |
| 限流 | 官方规范未给数值；402/429 为额度/订阅相关 | D — **限流数值未核实** |
| 许可 | 闭源商业服务，按订阅条款；本仓库只调用 | — |
| 版本 | 官方未给 API 版本号；模型以 `nai-diffusion-*` ID 区分 | A/B |
| 结论 | **可接入**（`status: connected`，但提示「`parameters` 明细为社区级证据」） | — |

### 2.3 NAI 中转站（实现为第二种 transport）

中转站没有统一标准，实际存在两种请求形态。M0 只映射本套件需要的字段，**不**移植参考插件的账号系统、图片归档、试用密钥、代理转售等能力。

| transport | 端点 | 请求体 | 响应 | 证据 |
|---|---|---|---|---|
| `official` | `POST {baseUrl}/ai/generate-image` | `{input, model, action:'generate', parameters:{...}}` | SSE/ZIP（含 base64） | A（同 2.2） |
| `openai-relay` | `POST {baseUrl}/v1/images/generations` | `{prompt, size, n, model, parameters:{width,height,steps,scale,sampler,noise_schedule,v4_prompt,v4_negative_prompt,...}}` | `{data:[{b64_json|url}]}` | C — woakato 插件 `_openai_endpoint()` / `_openai_generate()` 的实现 |

| 项 | 内容 | 证据 |
|---|---|---|
| 声明式差异 | 两种 transport 由 adapter 分开校验：`relay.style='official'` 要求 `apiKey`+`baseUrl`；`relay.style='openai-relay'` 额外允许 `size`/`n`，且**不发送** `input`/`action` | 设计决定，依据上表 |
| 中转站专属参数取舍 | 本期只实现：`steps`(默认 28)、`scale`、`sampler`、`noise_schedule`、`seed`、`negative_prompt`、`ucPreset`、V4/V5 提示词结构。**不实现**：Director Tools 的 5 组 `director_reference_*`（需要上传参考图 base64，属「个人媒体产物」范围）、`n_samples>1`、用户账号/额度体系 | 依据规格「只实现本套件确实需要的请求字段」 |
| 限流 | 中转站自行决定；本层只做客户端预算（并发 1、超时、响应体上限），**不猜**额度 | D |
| 许可 | 参考实现 MIT；本仓库不复制其代码，仅按协议字段独立实现 | C |

### 2.4 NAI 预设（V5 与 4.5 分开）

规格要求「V5 与 4.5 的官方正/反向提示词预设分开，切换模型时不能套错预设」。M0 结论：

- 预设**按模型族**命名空间化：`presets.nai['5']` 与 `presets.nai['4.5']` 是两份独立数据，各含 `positive`（质量串）与 `negative`（UC 预设）。
- 模型 ID → 预设族由 adapter 解析（`nai-diffusion-5-*` → `'5'`，`nai-diffusion-4-5-*` → `'4.5'`），**不允许**跨族取用；切换模型时只换族，不清空另一族的自定义内容。
- 官方「正/反向预设」的**逐字文本**属官方 UI 内容，本轮**没有**抓到权威文本副本（官方文档只描述质量标签/UC 预设的存在）→ 默认预设内容标 **D 级：示例占位**，由用户在页面里自行填写/覆盖，不假装是「官方原文」。

---

## 3. TTS 协议字段矩阵

### 3.1 Breeze TTS 2（`breeze_infer.api` 官方 FastAPI 服务）

| 项 | 内容 | 证据 |
|---|---|---|
| 来源 | 官方推理仓库（代码 Apache-2.0；**权重为非商业研究许可**） | A — https://github.com/breezeblue-ai/breeze-tts （README + `breeze_infer/api.py`，2026-11-05） |
| 启动方式 | `python -m breeze_infer.api <checkpoint> --host 0.0.0.0 --port 7860`（默认 host 127.0.0.1、port 7860） | A — `api.py` argparse；README §Streaming API |
| 端点 | `GET /health`、`GET /v1/model`、`POST /v1/audio/speech`、`POST /v1/audio/speech/batch` | A — `api.py` 路由 |
| 鉴权 | **无**（官方服务没有鉴权层）→ 必须只监听本机/内网，本套件默认 `baseUrl` 留空并由用户填 `http://127.0.0.1:7860` | A — 源码无 auth 依赖 |
| 请求 | `multipart/form-data`：`text`(必填)、`instruction`(可选，自然语言表演指令)、`cfg_scale`(默认 1.0)、`ref_audio`(文件，可选)、`ref_text`(可选，必须与 `ref_audio` 同时给或同时不给，否则 400)、`seed`(默认 42) | A — `speech()` 签名 |
| 音频返回 | 流式 `audio/pcm`，**mono 24 kHz s16le**；响应头 `X-Sample-Rate`、`X-Sample-Format: s16le`；另有 `Cache-Control: no-store` | A — `_InferenceStreamingResponse` + README |
| 音色查询 | **无音色列表接口**。音色 = 参考音频（Voice Clone/Direction）或纯自然语言描述（Voice Design） | A — 源码/README |
| 并发 | 单并发：已有请求在跑时返回 **409** `An inference request is already running.` | A — `_request_lock` |
| 上限 | `max_new_tokens=1500`（常量 `MAX_NEW_TOKENS`）；`/v1/audio/speech/batch` 的 `texts` ≤ 128 条 | A — 常量与 `/v1/model` |
| 限流 | 无显式限流；单并发即隐式限流 | A |
| 许可 | 代码 Apache-2.0；**权重/派生模型/自托管产物 = BreezeBlue Research and Non-Commercial License** | A — README §License |
| 版本 | 2026-08-25 发布 Breeze TTS 2；无 API 版本号（路径里写 `v1`） | A |
| 结论 | **可接入**：adapter 走 multipart，把 PCM 包成 WAV（44 字节头 + s16le），单并发错误映射为 `MEDIA_BACKEND_BUSY` | — |

### 3.2 GPT-SoVITS（`api_v2.py` 官方 HTTP API）

| 项 | 内容 | 证据 |
|---|---|---|
| 来源 | 官方仓库（MIT） | A — https://github.com/RVC-Boss/GPT-SoVITS `api_v2.py` / `LICENSE`，2026-11-05 |
| 启动 | `python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml`（端口默认 **9880**） | A — `api_v2.py` 顶部用法 |
| 端点 | `POST /tts`（JSON）、`GET /tts`（query）、`GET/POST /control`（`restart`/`exit`）、`GET/POST /set_refer_audio`、`GET /set_gpt_weights`、`GET /set_sovits_weights` | A — `@APP.*` 路由 |
| 鉴权 | **无**；同一 `-a` 参数控制监听地址 | A |
| 请求（`TTS_Request`） | `text`(必填)、`text_lang`(必填)、`ref_audio_path`(必填，**服务器本机路径**)、`aux_ref_audio_paths`、`prompt_text`、`prompt_lang`、`top_k=15`、`top_p=1`、`temperature=1`、`text_split_method='cut5'`、`batch_size=1`、`batch_threshold=0.75`、`split_bucket=True`、`speed_factor=1.0`、`fragment_interval=0.3`、`seed=-1`、`media_type='wav'`（`wav`/`raw`/`ogg`/`aac`）、`streaming_mode`(0–3 或 bool)、`parallel_infer`、`repetition_penalty=1.35`、`sample_steps`、`cfg_rate`、`super_sampling`、`overlap_length`、`min_chunk_length`、`gpt_streaming` 等流式参数 | A — `TTS_Request` BaseModel |
| 音频返回 | `200` 直接返回音频流（`audio/<media_type>`）；失败 `400` + JSON `{message}` | A — README 响应说明 + `check_params()` |
| 音色查询 | 无列表接口；音色 = **服务器上的参考音频路径** + 对应 `prompt_text`/`prompt_lang`，可用 `/set_refer_audio` 预设默认 | A |
| 限流 | 无；服务端为单进程推理 | A |
| 许可 | MIT | A — `LICENSE`（"MIT License, Copyright (c) 2024 RVC-Boss"） |
| 版本 | 仓库 main 分支（含 V3/V5 模型分支 `module.models_v5`），无 API 版本号 | A |
| 结论 | **可接入**。注意：`ref_audio_path` 是**服务端路径**，不是本机文件 → UI/文档必须写清「填服务端上的参考音频路径」，本层不做上传 | — |

### 3.3 Drama3（Fish Audio `drama-3` 模型）

| 项 | 内容 | 证据 |
|---|---|---|
| 来源 | Fish Audio 官方 API 文档的 TTS 页面（`model` 枚举里含 `drama-3`） | B — https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech （2026-11-05） |
| 协议 | **与 Fish Audio 完全同一协议**：`POST https://api.fish.audio/v1/tts`，`model: drama-3` | B — 同上（model enum: `s1`,`s2-pro`,`s2.1-pro`,`s2.1-pro-free`,`drama-3`） |
| 多说话人 | `reference_id` 传数组 + 正文用 `<\|speaker:0\|>` / `<\|speaker:1\|>` 标签切人；S2 家族与 `drama-3` 支持，`s1` 不支持 | B — 同上「Multiple Speakers (Dialogue — S2 family and drama-3)」 |
| 其他字段 | 见 §3.4（同一协议） | B |
| 许可 | Fish Audio 商业服务条款；`drama-3` 是托管模型，**权重不开源** | B |
| 结论 | **可接入**，作为 Fish Audio 协议的**预置 profile**（模型固定 `drama-3`、允许 `reference_id` 数组 + speaker 标签），与 §3.4 共用一套实现 | — |

### 3.4 Fish Audio（`POST /v1/tts`）

| 项 | 内容 | 证据 |
|---|---|---|
| 来源 | 官方 API 文档 | B — 同 §3.3 页面（2026-11-05 抓取，387,865 字节 HTML） |
| 端点 | `POST https://api.fish.audio/v1/tts`（另有 WebSocket 流式 TTS、ASR、Voice Design 页面，本期不用） | B |
| 鉴权 | `Authorization: Bearer <token>` | B — cURL 示例 |
| 头部 | `Content-Type: application/json`（或 `application/msgpack`，用于内联上传参考音频）；`model: <enum>`，默认 `s2.1-pro`，未知值回退 `s2.1-pro` | B |
| 请求 JSON | `text`、`reference_id`（字符串 = 语音模型 ID；或数组 = 多说话人）、`references`（零样本克隆数组 / 二维数组多说话人）、`temperature`(0.7 示例)、`top_p`(0.7)、`prosody{speed,volume,normalize_loudness}`、`chunk_length`(300)、`normalize`(true)、`format`(`wav`/`pcm`/`mp3`/`opus`，默认 mp3)、`sample_rate`（null=格式默认；opus 默认 48000）、`mp3_bitrate`(64/128/192，默认 128)、`latency`(`normal` 示例)、`max_new_tokens`、`repetition_penalty`、`min_chunk_length`、`condition_on_previous_chunks`、`early_stop_threshold` | B — 请求体文档 |
| 音频返回 | 直接返回音频字节（格式由 `format` 决定）；错误 JSON `{status,message,reason}`，状态码 401/402/503 | B |
| 音色查询 | 音色 = `reference_id`（Fish Audio 上的语音模型 ID，从 fish.audio 站点或 Models API 获取）。**本轮没抓到 Models API 页面**（连读两次被中途关闭）→ 列表接口的存在性与字段标 **D 级未核实**；adapter 只把 `reference_id` 当不透明字符串 | B/D |
| 限流 | 页面未给具体数值；错误码里只有 401/402/503 → **限流数值未核实** | D |
| 许可 | 商业 API 条款；开源自托管版 `fishaudio/fish-speech` 是另一套东西（GitHub 许可证显示 NOASSERTION，需另核），本期**不接入**自托管 | B/D |
| 版本 | 模型 `s1` / `s2-pro` / `s2.1-pro` / `s2.1-pro-free` / `drama-3`；免费档用 `s2.1-pro-free` | B |
| 结论 | **可接入** | — |

### 3.5 Index-TTS（结论：**尚未接入**）

| 项 | 内容 | 证据 |
|---|---|---|
| 来源 | 官方仓库 | A — https://github.com/index-tts/index-tts （2026-11-05） |
| 提供的接口 | ① Python API：`from indextts.infer_v2 import IndexTTS2`（README §Python API）；② Gradio WebUI：仓库根 `webui.py`；③ 部署 recipe：vLLM（`recipes.vllm.ai/IndexTeam/IndexTTS-2.5`）与 `backends/trt/serving/triton_server.py`（Triton） | A — 仓库根文件列表 + README |
| 官方 HTTP JSON 协议 | **没有**。仓库里不存在面向用户的 `api.py` / FastAPI 服务（`indextts/s2mel/modules/openvoice/api.py` 是内部模块，不是对外服务） | A — 全仓 tree 检索 |
| 音色查询 | 无（参考音频路径 + Python 调用） | A |
| 许可 | **bilibili Model Use License Agreement**（非 OSI 标准许可，`LICENSE`/`LICENSE_ZH.txt`） | A — README §License |
| 版本 | IndexTTS-2.5 / IndexTTS-2（README） | A |
| 结论 | **尚未接入**。原因：没有可核实的官方 HTTP 协议，套件「只通过 API 调用远端服务」的前提不成立；Triton/vLLM recipe 需要用户自建服务且字段随后端变化，本轮拿不到权威字段表。**不写猜的 adapter**；UI 显示「尚未接入（缺官方 HTTP 协议）」，adapter 只返回带原因的 `MEDIA_PROVIDER_NOT_IMPLEMENTED`。启用条件：官方发布 HTTP API，或有可核实的 vLLM/Triton OpenAPI 规范 | — |

---

## 4. 共用语音结果合同（M0 交付物）

无论哪个 TTS provider，本层只产出统一结构（不含发送）：

```json
{
  "ok": true,
  "provider": "breeze-tts-2",
  "model": "breeze-tts-2",
  "voice": "ref:/path/to/ref.wav",
  "artifact": {
    "artifactId": "…", "kind": "speech", "path": "data/media/artifacts/speech/…wav",
    "absolutePath": "…", "bytes": 123456, "mime": "audio/wav",
    "durationSeconds": 3.42, "sha256": "…"
  },
  "handoff": { "tool": "qq_voice", "action": "send_file", "file": "…", "ready": true, "delivered": false }
}
```

- 远端只允许返回**音频字节**或受控 URL；URL 一律走 `src/net.mjs` 的有界下载（协议/主机分类、跳数、总超时、字节上限），不把远端任意 URL 交给宿主。
- `delivered` 恒为 `false`：媒体层不发送，「已合成」≠「已投递」。
- 时长（若可获）只从 WAV 头推算；推不出就留 `null`，不估算。

## 5. 旧配置迁移策略（M0 交付物）

| 旧字段（生产 `home/media/config.json`） | 处置 |
|---|---|
| `image.backend='novelai-pipeline-bridge'` | 标记 **unsupported**，迁移时丢弃；新配置要求显式选 `openai` / `nai` |
| `image.pythonPath` / `imagePipelineRoot` / `configPath` / `runtime.*` / `queue.*` | 丢弃（本机路径、显存协调器、HF Space 队列；`queue.userId` / `queue.greeting` 里的旧用户号与旧人格名一并丢） |
| `image.model='nai-diffusion-5-full'`, `steps=28`, `scale=5`, `size='832x1216'`, `generationFlow='tag'` | 迁移到 `image.nai.{model,steps,scale,size}`（`steps` 默认已是 28） |
| `image.style.{artist,defaultPrompt,defaultNegative}` | 迁到 `image.nai.presets.custom.*`；`presets/nai-style.json` 不再作为默认值来源（其中的默认串是作者个人画师串，属个人偏好，不进发布树） |
| `speech.backend.{baseUrl='…/breeze',voice='<旧人格id>_B',cfgScale,seed,speed,maxNewTokens}` | 迁到 `tts.providers['breeze-tts-2']`；`voice` 里的旧人格前缀被清空，用户填自己的参考音频；`speed` → `breeze.speed`（本层不做变速，改用后端 `instruction`） |
| `speech.presetsFile`（指向作者机器上的情绪预设文件） | 丢弃（作者本机文件）；`emotionPresets` 清空 |
| `speech.director.*`（宿主 LLM 语音导演） | 丢弃：本期没有 `host-llm` 依赖，`instruction` 由调用方直接给 |
| `speech.auto.*`（自动语音） | 丢弃：主动外发不在媒体模块范围 |
| `vision.*`（含 `local.model='nsfwvision-v3:q5'`、`requireCoordinator`） | 只保留合同字段（`baseUrl`/`apiKey`/`model`/`timeoutMs`），`enabled` 恒 `false` 且只读 |
| `screen.*` / `delivery.*` / `image.quotas` / `image.tagProvider` / `image.translatePrompt` | 丢弃（屏幕、投递、宿主 LLM 相关，不属于本期媒体插件） |
| 任何作者机器绝对路径、本地协调器地址 | 一律不迁移；迁移器只保留用户能确认的 API 选项 |

迁移执行原则：**旧配置只读**，新配置写到 `data/media/config.json`；迁移前自动备份 `config.json.bak-<时间戳>`；无法识别的字段写进迁移报告的 `dropped[]`，不静默吞掉。

## 6. 未核实项（诚实清单）

1. NAI `parameters` 的**逐字段权威表**：官方规范只写「model specific」。字段名来自 MIT 参考实现（C 级），未做真实调用验证。
2. NAI **模型 ID 字符串**（`nai-diffusion-5-full` 等）：官方 Swagger enum 过期；ID 来自参考实现（C 级）+ 官方文档模型名称（B 级）。
3. NAI **限流数值**、并发上限：官方未公开数值。
4. NAI 官方「正/反向提示词预设」的**逐字文本**：没有权威副本，插件里只放示例占位。
5. Fish Audio **Models 列表 API**（音色查询）页面两次抓取中断 → 未核实；`reference_id` 按不透明字符串处理。
6. Fish Audio **限流数值**、免费档额度：未核实。
7. OpenAI **具体限流额度**（RPM/TPM）：规范只给 429。
8. Index-TTS 的 vLLM/Triton OpenAPI 字段：未核实（因此不接入）。
9. 所有 provider 的**真实调用**：本轮**一次都没发起**（会产生费用）。全部为 mock/fake 测试与协议级核对。
