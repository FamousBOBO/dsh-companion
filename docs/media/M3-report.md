# M3 报告：API Adapter

- 阶段：M3
- 日期：2026-11-05
- 证据分级：**源码 ✔ · mock 测试 ✔ · 真实 API ✘ · 真实媒体生成 ✘ · 投递 ✘**

本阶段实现两条生图适配器与五个 TTS 适配器，逐条声明必填字段、请求映射、返回格式、禁用原因。
协议依据全部来自 `M0-report.md` 的字段矩阵（每行带来源 URL 与核实日期）。

---

## 1. 生图：两条适配器

### 1.1 OpenAI-compatible（`src/adapters/openai-image.mjs`）

| 项 | 内容 |
|---|---|
| 端点 | `POST {baseUrl}/images/generations`（Base URL 由用户填，adapter 只追加路径） |
| 鉴权 | `Authorization: Bearer <apiKey>` |
| 必填 | `baseUrl`、`apiKey`、`model` |
| 请求体 | `{model, prompt, n:1, size}`；`quality`/`background` 非 `auto` 才发送；`output_format` 按配置 |
| **不发送** | `response_format`（官方标 deprecated 且 GPT image 恒返回 base64）、`stream`、`style`、`user` |
| 响应解析 | `data[0].b64_json` → base64 解码；`data[0].url` → **本层有界下载**；兼容 `payload.image` 与 data-URI 前缀 |
| 返回格式 | 按字节签名判定的 `image/png|jpeg|webp|gif` + 宽高 |
| 失败语义 | 401/403→`AUTH_FAILED`、402→`ENTITLEMENT`、404→`BAD_INPUT`（Base URL 写错）、429→`RATE_LIMITED`、5xx→`UPSTREAM`；200 但非 JSON → `UNSUPPORTED_TYPE`（网关错误页） |
| 连接测试 | `GET {baseUrl}/models` → `level: 'metadata'`（免费）；无该端点时退化 `reachability` |

### 1.2 NovelAI（`src/adapters/nai-image.mjs`）

| 项 | 内容 |
|---|---|
| transport `official` | `POST {baseUrl}/ai/generate-image`，体 `{input, model, action:'generate', parameters}` |
| transport `openai-relay` | `POST {baseUrl}/v1/images/generations`，体 `{prompt, size, n, model, parameters}`（**不发** `input`/`action`） |
| 鉴权 | `Authorization: Bearer <Access Token>` |
| 必填 | `baseUrl`、`apiKey`、`model`；`transport` 二者其一 |
| `parameters` 字段 | `width,height,scale,sampler,noise_schedule,steps,n_samples:1,seed,negative_prompt,ucPreset,qualityToggle,sm,sm_dyn`；V4/V5 家族额外 `v4_prompt{v4_negative_prompt}` 结构 |
| 响应解析 | **三种形态都支持**：`application/zip` → 内置 ZIP 解析取第一张 PNG/JPEG/WebP；`text/event-stream` → 逐帧收集 base64 并拼接（流内 `error` 字段映射为 `UPSTREAM`）；JSON → `{image}` 或 `data[0].b64_json` |
| 预设 | `resolvePreset()` 按模型族（`5` / `4.5` / `other`）取，**跨族绝不复用**；`other` 不套预设并给出警告 |
| 分辨率 | 64 的倍数、短边 ≥256、长边 ≤2048、面积 ≤3,000,000px；越界 → `PARAM_OUT_OF_RANGE`（不静默收敛） |
| 失败语义 | 同 §1.1；409→`BACKEND_BUSY`（并发冲突）、402→`ENTITLEMENT`（无订阅） |
| 连接测试 | 只做可达性（NovelAI 无免费元数据端点），明确回报「凭据有效性需操作者手动生成一次才知道」 |

### 1.3 关于 Python 桥（回答 Lead 的问题）

旧实现通过 `bridge/nai_generate.py` + 用户本机 Python + AstrBot 插件目录间接生图。本期**删除桥，改为纯 JS 直连**：

- 现在的依赖：只有 `fetch`（Node 24 内置），无 Python、无子进程、无外部脚本；
- 收益：不需要用户机器上有 Python/AstrBot；失败码可枚举；协议字段可在测试里逐条断言（ZIP/SSE/JSON 三种响应都有 mock 测试）；不再有"脚本退出码 0 但没出图"的模糊状态；
- 代价：NAI 的 Director Tools（参考图上传）与 `n_samples>1` 未实现——它们需要上传参考图 base64，属"个人媒体产物"与更大的面，本期不做。

---

## 2. TTS：五个适配器

| provider | 端点 / 传输 | 鉴权 | 必填字段 | 返回解析 | 状态 |
|---|---|---|---|---|---|
| Breeze TTS 2 | `POST {base}/v1/audio/speech`，`multipart/form-data`（`text`,`instruction`,`cfg_scale`,`seed`,`ref_audio`,`ref_text`） | 无（官方服务无鉴权，须只监听本机/内网） | `baseUrl`；可选参考音频 + 逐字稿（必须成对） | `audio/pcm` → 按 `X-Sample-Rate` 封装 WAV；其他按签名嗅探 | **已接入** |
| GPT-SoVITS | `POST {base}/tts`，JSON（`text,text_lang,ref_audio_path,prompt_text,prompt_lang,media_type,speed_factor,top_k,top_p,temperature,seed`） | 无 | `baseUrl`、`refAudioPath`（**服务端路径**）、`promptText`、`promptLang`、`textLang` | 音频流按签名嗅探；`media_type=raw` 本地拒绝 | **已接入** |
| Fish Audio | `POST {base}/v1/tts`，header `model` | `Bearer` | `baseUrl`、`apiKey`、`referenceId` | 音频字节按签名嗅探；`pcm` 本地拒绝；JSON 错误信封判 `UPSTREAM` | **已接入** |
| Drama3 | 同 Fish Audio，`model: drama-3` | `Bearer` | 同上 | 同上；`referenceId` 逗号分隔 → 数组（多说话人） | **已接入** |
| Index-TTS | —（无文档化 HTTP 契约） | — | — | — | **尚未接入**（`PROVIDER_NOT_IMPLEMENTED`，已核实：bilibili 模型使用协议 + 无文档化 HTTP 接口） |

Index-TTS 的禁用原因（原文写进能力表 `TTS_PROVIDERS['index-tts'].reason`，UI 直接显示）：

> **已核实（2026-11-05）**：上游 `index-tts/index-tts` 的许可为 **bilibili Model Use License Agreement**（自定义模型使用协议，非开源许可，GitHub API `license.spdx_id = "NOASSERTION"`），且仓库里**没有文档化的 HTTP JSON 合成接口**——可交互面只有 Gradio WebUI（`webui.py`，55,404 B）、Triton 后端（`backends/trt/serving/triton_server.py`，16,151 B）与内部 openvoice 模块（`api.py` 7,116 B / `openvoice_app.py` 11,624 B），没有请求字段/响应/鉴权契约可核实。按规格「不能因项目都叫 TTS 就共用一套请求体」与项目纪律，**不猜** Gradio 的内部 `/api/predict` 一类未文档化协议，因此不实现 adapter。

因此 `MEDIA_PROVIDER_NOT_IMPLEMENTED` + UI「尚未接入」是**已核实**的结论，而不是证据不足。口径与 `THIRD-PARTY-NOTICES.md` 的「Index-TTS 为什么标尚未接入」一节一致（不另立一套说法）。

启用条件（写给将来）：① 官方发布带字段/鉴权说明的 HTTP 契约；或 ② 对 bilibili 模型使用协议做单独评估并确认允许这种对接方式。

### 2.1 共用语音结果合同

统一返回：`{bytes, mime, extension, format, durationSeconds|null, meta{model, voice/referenceId, …}}`，再由服务层落盘成 artifact + handoff（见 `CONTRACT.md` §2.2/§2.3）。`durationSeconds` 只在 WAV 头可算时给出，否则 `null`（不估算）。

---

## 3. 预算、上限与"不自动重试"

| 机制 | 值 / 行为 | 测试 |
|---|---|---|
| 连接/响应预算 | 每个 provider 的 `timeoutMs` 与 `limits.requestBudgetMs`（默认 240000）取小；`src/net.mjs` 用**整条请求一个 deadline**（含跳转），不是每跳一次 | `总 deadline 有默认值，且可配置` |
| 跳转 | ≤ `limits.maxRedirects`（默认 2），逐跳重查 | `跳转上限：2 次跳转可通过，第 3 次被拦` |
| 响应体上限 | `limits.maxResponseBytes`（默认 16 MiB），`Content-Length` 超限即拒 | `字节上限：恰好等于上限通过，超一字节报 TOO_LARGE`、`声明的 Content-Length 超限时在读取前就拒绝` |
| 图片 / 音频上限 | `maxImageBytes` / `maxAudioBytes`（各 16/32 MiB） | `三档字节上限都在 net 层生效` |
| 地址白名单 | 仅 http/https；`169.254.*` 拒绝；本机/内网允许（TTS 就在 127.0.0.1） | `协议与地址白名单` |
| **生图不自动重试** | 生成路径里没有任何 retry 循环；失败即返回，`retried:false`；429 的提示里明说"不自动重试" | `401 → AUTH_FAILED，且绝不自动重试`（断言 fetch 调用次数 = 1）、`429 …单次请求` |
| 本地预检（不做无谓计费请求） | 以下情况**在本地就拒绝**、零网络请求：功能未开、缺必填项、`prompt`/`text` 为空或超长、NAI 尺寸越界、Breeze 参考音频与逐字稿不成对、GPT-SoVITS `raw`、Fish `pcm`、Index-TTS 未接入 | `配置非法（缺 model）时不会调用远端`、`Breeze：参考音频与逐字稿只给一个 → 本地就拒绝`、`Index-TTS … 不得发请求`、`Fish Audio：pcm 格式被本地拒绝` |

---

## 4. 识图

只实现 `src/vision.mjs` 的合同与拒绝（`visionContract()` / `visionRefusal()`），**没有**网络代码、**没有**工具、**没有**可用路由。启用实现另立阶段审批（`M2-report.md` §2.1 列了不可绕过的三层）。

---

## 5. 未做的部分

- **没有真实 API 调用**：所有 adapter 只在 mock fetch 下验证请求体与响应解析。真实语义（尤其 NAI 的 ZIP/SSE 细节、Fish 的错误信封、Breeze 的 PCM 采样率）需要操作者按 `M5-report.md` §4 手动触发。
- NAI `parameters` 的逐字段明细为 C 级证据（社区实现交叉验证），官方规范只写"model specific"。
- Director Tools / 多图 `n_samples` / 参考图上传未实现（见 §1.3）。
- GPT-SoVITS 的 `aux_ref_audio_paths`（多音色融合）、`gpt_streaming` 等高级字段未暴露（本期只映射必要字段）。
