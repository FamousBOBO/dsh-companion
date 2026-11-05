# companion-media 合同（v0.2）

> 本文件是**对外合同**。凡是要调用媒体能力的代码（工具、页面、其他插件），以本文件为准；实现细节看 `src/`。
> 上一版（v0.1）是 AstrBot 时代的合同，包含屏幕帧、衣柜、投递计划、本地模型预热；本版按 `design/media-migration-dsh-task.md` 收窄，**变更逐条列在 §8**。

- 版本：`0.2.0`（套件版本 `0.1.0`，见 `package.json` 的 `localVersion`）
- 范围：生图（OpenAI-compatible / NovelAI）、语音合成（5 个 provider）、识图**合同**（不实现）
- 不做什么：不发送任何消息、不下载/安装/预热模型、不管理外部服务生命周期、不保存生成记录进仓库

---

## 1. 边界（先看这个）

1. **媒体层只产出文件。** 任何 `ok:true` 都只代表"本地有了一个文件"，不代表"对方收到了"。返回里的 `handoff.delivered` 恒为 `false`，投递由通道确认。
2. **默认关闭。** `image.enabled` / `tts.enabled` 默认 `false`；识图恒 `false`。
3. **识图不可绕过。** 没有识图工具、没有可用 HTTP 路由；`vision` 只提供合同与拒绝。
4. **计费不重试。** 生图失败**不自动重试**（配置里也没有这个开关）；重试只能由人显式再次调用。
5. **密钥不回传。** 任何 GET / 状态 / 日志 / 错误消息里都不出现密钥或 `Authorization`；配置文件里只有本机数据目录下的一份。
6. **不允许把远端任意 URL 交给宿主下载。** 所有下载走 `src/net.mjs`（协议白名单、跳数、总超时、字节上限、元数据地址拒绝）。

---

## 2. 服务对象合同（宿主内 `ctx.get('companionMedia')`）

`createMediaService()` 返回下面这套方法。所有方法**不抛异常**给宿主：失败返回 `{ ok:false, error:{code,message} }`。

| 方法 | 输入 | 返回 |
|---|---|---|
| `status()` | — | 版本、数据目录、配置路径、`persona`、`states`（vision/image/tts 每个 provider 的六态）、`limits`、`catalog`、`ledger` 摘要、`config`（**掩码**） |
| `readConfig()` | — | `{ ok, configFile, exists, config(掩码), validation, states, warnings, dropped, catalog, persona }` |
| `saveConfig(patch)` | 部分配置 | `{ ok, saved, at, warnings, config(掩码), states }`；校验失败 `{ ok:false, saved:false, errors:[{path,code,message}] }` 且**不写盘** |
| `testProvider({kind,id})` | `kind: 'image'|'tts'` | `{ ok, status, level, detail, states }`；`level ∈ reachability|metadata|health|none` |
| `generateImage({prompt,negative,dryRun})` | — | `{ ok, jobId, provider, artifact, handoff, meta }` 或 `{ ok:false, error, retried:false }` |
| `synthesize({text,provider?})` | — | `{ ok, jobId, provider, artifact, handoff }` 或 `{ ok:false, error }` |
| `preview({mode,size,aspect,targetPixels,model})` | — | 自动分辨率预览（与 adapter 同一计算函数） |
| `jobs(limit)` / `getJob(id)` | — | 作业与产物元数据（不含提示词正文、不含媒体内容） |
| `vision(config)` / `inspectImage()` | — | 合同 / 恒拒绝 |

### 2.1 状态语义（UI 必须照抄这 6 个词）

| state | 含义 | 允许说"可用"吗 |
|---|---|---|
| `disabled` | 功能关闭 | 否 |
| `unconfigured` | 未配置（缺必填项 / 未选 provider） | 否 |
| `not-connected` | 尚未接入（协议证据不足） | 否 |
| `saved-untested` | 已保存、未测试 | 否（不得显示"连接成功"） |
| `test-ok` | 测试通过（`level` 说明到哪一级） | 只对 `level` 声明的那一级 |
| `test-failed` | 测试失败 | 否 |

### 2.2 artifact 合同

图片：

```json
{ "artifactId":"sha256:…", "kind":"image", "absolutePath":"<dataDir>/media/artifacts/image/<hash>.png",
  "bytes":123456, "mime":"image/png", "width":1024, "height":1024, "provider":"openai",
  "model":"…", "sha256":"…" }
```

语音：

```json
{ "artifactId":"sha256:…", "kind":"speech", "absolutePath":"<dataDir>/media/artifacts/speech/<hash>.wav",
  "bytes":123456, "mime":"audio/wav", "durationSeconds":3.42, "provider":"breeze-tts-2",
  "model":"breeze-tts-2", "voice":"ref:/path/to/ref.wav", "sha256":"…" }
```

`durationSeconds` 只在能从 WAV 头算出时给，否则 `null`（不估算）。
文件名是内容摘要，**原始文件名不进账本/日志/消息**。

### 2.3 handoff 合同（QQ 通道按这个对接，字段固定）

```json
{
  "tool": "qq_sticker",
  "action": "send",
  "file": "<absolute path>",
  "mime": "image/png",
  "bytes": 123456,
  "provider": "openai",
  "model": "gpt-image-…",
  "ready": true,
  "delivered": false,
  "mustSend": "调用 qq_sticker action=send 并传 file=…"
}
```

语音的 handoff 额外带 `durationSeconds`（推不出时为 `null`）与 `voice`：

```json
{
  "tool": "qq_voice",
  "action": "send_file",
  "file": "<absolute path>",
  "mime": "audio/wav",
  "bytes": 123456,
  "durationSeconds": 3.42,
  "provider": "breeze-tts-2",
  "model": "breeze-tts-2",
  "voice": "ref:/path/to/ref.wav",
  "ready": true,
  "delivered": false,
  "mustSend": "调用 qq_voice action=send_file 并传 file=…"
}
```

字段契约：
- `file` 一定存在且可读（`ready:true` 就是由 stat 得出的，不是猜的）；
- **`file` 必须位于 `<dataRoot>/workspace` 或 `<dshHome>/channel-qq` 之内，否则通道有权拒绝（`outside-boundary`）。** 默认产物目录因此是 `<dataRoot>/workspace/media`（见 §7）；通道只为这两个根开读权限，不会为媒体开「任意路径」的口子。
- `mime` 由**字节签名**判定，不采信上游声明的类型；
- `bytes` 是磁盘上的真实字节数；
- `provider`/`model`/`voice` 是本次实际使用的后端，便于通道记录与排障；
- `delivered` **恒为 `false`**：媒体层不认识任何聊天平台，也不发送。真正确认发送的是通道，`mustSend` 只是给模型的动作提示。
- 媒体层**不做投递计划**（不做 `plan()/deliver()`）。如果将来需要，属通道侧职责（团队决策 A）。

---

## 3. 工具合同

### 3.0 本期的两处**合同变更**（显式声明，不是遗漏）

**(a) `companion_media_inspect` 已移除。**
理由：规格要求「识图默认关闭，且工具、页面按钮、自动流程都不能绕过这个开关」。一个注册在工具表里的识图入口，模型随时可以调用，因此它本身就等于一条绕过路径。移除后：
- 识图**服务合同保留**在 `src/vision.mjs`（`visionContract()` / `visionRefusal()`），字段、约束、未来输入输出形状都在；
- 配置项（`vision.baseUrl/apiKey/model/timeoutMs`）仍可保存，方便以后启用；
- 任何调用方（工具、HTTP、页面按钮）只会得到 `MEDIA_DISABLED` + 合同；
- 要真正启用，必须另立阶段审批并新增实现，**不能**通过改配置打开。

**(b) `companion_media_warm` 已移除。**
理由：本期的范围是「只通过 API 调用外部媒体服务」，明确不做本地模型权重下载、服务安装/卸载、预热/释放与显存协调。`warm/release/status` 三个动作以及 8139 协调器客户端一并移除；本地推理服务（如 Breeze FastAPI）由用户自己部署，本插件只当它是个外部 HTTP 服务。

### 3.1 保留的四个工具

| 工具 | v0.1 | v0.2 | 说明 |
|---|---|---|---|
| `companion_media_status` | 有 | **保留** | 语义相同（多返回 `states`/`catalog`） |
| `companion_media_draw` | 有 | **保留，签名收窄** | `prompt`,`negative?`,`dryRun?`；`source/style/outfit/composeTags/context` 移除（衣柜/标签转换属旧栈） |
| `companion_media_speak` | 有 | **保留，签名收窄** | `text`,`provider?`；`emotion/instructions/context` 移除（改在配置里写 `instruction`） |
| `companion_media_job` | 有 | **保留** | 语义相同 |
| `companion_media_inspect` | 有 | **移除** | 识图只留合同，工具不得绕过开关 |
| `companion_media_warm` | 有 | **移除** | 本地模型预热/释放/显存协调不在本期范围 |

工具参数一律编译成 `{type:'object', properties, required}` 的 JSON Schema（缺省时会用宿主 `defineTool`，否则用内置 `parametersToJsonSchema`），否则 provider 会整批拒绝请求。

### 3.2 错误码（稳定，不随文案变）

`MEDIA_DISABLED`、`MEDIA_BAD_INPUT`、`MEDIA_NOT_CONFIGURED`、`MEDIA_PROVIDER_UNKNOWN`、`MEDIA_PROVIDER_NOT_IMPLEMENTED`、`MEDIA_VISION_LOCKED`、`MEDIA_CONFIG_INVALID`、`MEDIA_PARAM_OUT_OF_RANGE`、`MEDIA_AUTH_FAILED`、`MEDIA_ENTITLEMENT`、`MEDIA_RATE_LIMITED`、`MEDIA_TIMEOUT`、`MEDIA_NETWORK`、`MEDIA_UPSTREAM`、`MEDIA_BACKEND_BUSY`、`MEDIA_TOO_LARGE`、`MEDIA_UNSUPPORTED_TYPE`、`MEDIA_DOWNLOAD_BLOCKED`、`MEDIA_NO_TEXT`、`MEDIA_ARTIFACT_FAILED`、`MEDIA_CANCELLED`、`MEDIA_UNKNOWN`

映射规则（`src/errors.mjs`）：400/422→`BAD_INPUT`，401/403→`AUTH_FAILED`，402→`ENTITLEMENT`，404→`BAD_INPUT`（Base URL 写错），409→`BACKEND_BUSY`，410→`PROVIDER_NOT_IMPLEMENTED`，429→`RATE_LIMITED`（附 `Retry-After`，并明说不会自动重试），5xx→`UPSTREAM`。

**响应体永不原样回显**：上游 body 在进入任何错误消息前，先经过 `redactText`（按 key 名与**值形**双规则抹掉 `Bearer …`、`sk-…`、`pst-…`、超长令牌），并截断到 200 字符。单测覆盖：上游 401 body 里带密钥时，最终 message 不含该密钥。

---

## 4. 页面 / HTTP API 合同

前缀 `/api/companion-media`，只注册在宿主**已认证的本机 Connection** 上；跨站 `Origin` 直接 403。

| 方法 路径 | 作用 | 计费 |
|---|---|---|
| `GET /status` | 状态（同 `status()`） | 否 |
| `GET /config` | 掩码配置 | 否 |
| `POST /config` | `{patch}` 保存（校验失败 400 + 字段错误） | 否 |
| `POST /test` | `{kind,id}` 连接测试 | 否（不会生成/合成） |
| `GET /page` | 「工具 → 媒体能力」页描述符 | 否 |
| `GET /preview` | 自动分辨率预览 | 否 |
| `GET /jobs` | 作业/产物 | 否 |
| `POST /image` | **必须带 `confirm:true`**，否则 400 | 是 |
| `POST /speech` | **必须带 `confirm:true`** | 可能 |
| `GET/POST /vision` | 恒拒绝（400）+ 合同 | 否 |

页面描述符（`src/ui-page.mjs`）是数据不是框架代码：章节 = 识图 / 生图 / 语音合成；每个 provider 展开才显示其选项；`states` 给出六态的中文标签，UI 不得自造。

---

## 5. 配置合同

- 位置：`<dataDir>/media/config.json`（`dataDir` 默认 `<套件根>/data`，可用 `DSH_COMPANION_DATA_DIR` 或 `mountMedia` 的 `dataDir` 覆盖）。**不在源码树里**。
- 模板：`config.example.json`（可提交，无任何真实值）；预设模板：`presets/nai-presets.example.json`。
- 保存：schema 校验 → 临时文件（同目录）→ `fsync` → `rename`；上一版留 `config.json.bak`。
- 密钥：`apiKey` 只存在于本地文件或 `DSH_MEDIA_<SCOPE>_API_KEY` 环境变量；GET 返回 `{configured, mask, source, envVar?}`。
- **掩码回传 = 不修改**：POST 里 `apiKey` 传 `""`、`"****"`、`"sk…abcd"` 或 `{configured:true}` 都表示"保留原值"。
- `vision.enabled` 不可写：无论提交什么、无论直接改文件，读回恒为 `false`。

---

## 6. 网络合同（`src/net.mjs`）

| 限制 | 值（可配置项） |
|---|---|
| 协议 | 仅 `http:` / `https:` |
| 跳转 | ≤ `limits.maxRedirects`（默认 2），**逐跳重查** |
| 超时 | **整条请求一个 deadline**（不是每跳），由 provider 的 `timeoutMs` 与 `limits.requestBudgetMs` 取小 |
| 响应体 | ≤ `limits.maxResponseBytes`（默认 16 MiB），`Content-Length` 超限即拒 |
| 图片 / 音频 | ≤ `limits.maxImageBytes` / `maxAudioBytes` |
| 地址 | 拒绝 `169.254.*`（云元数据）；本机/内网**允许**（TTS 服务就在 127.0.0.1） |
| 回显 | 错误消息统一 `redactText`，长度截断 |

---

## 7. 数据与隐私

**产物（要交给通道的文件）**：
- 默认目录：`<dataRoot>/workspace/media/{image,speech}/`（`dataRoot` 即 `dataDir`，默认 `<套件根>/data`）；
- 可用配置 `paths.artifactsDir` 改到别处（绝对路径，或相对 `dataRoot` 的路径）；留空 = 默认；
- 文件名是内容摘要（`<sha256 前 32 位>.<ext>`），原始文件名不进账本/日志/消息；
- **已知约束**：通道只读 `<dataRoot>/workspace` 与 `<dshHome>/channel-qq` 两个根；把 `paths.artifactsDir` 指到这两处之外，产物会被通道以 `outside-boundary` 拒绝发送。`status().paths` 会回显当前目录、来源（`default`/`config`）与这条边界说明。

**账本与日志（不需要交给通道）**：
- `<dataRoot>/media/state/ledger.json`、`tests.json`、`<dataRoot>/media/logs/media-events.jsonl`；
- 仓库里 0 个媒体文件、0 条生成记录；
- 账本只存：job id、kind、provider、model、请求摘要（sha256）、体积、错误码。**不存提示词正文**；
- 测试所需的图片/音频/ZIP 全部在 `test/helpers.mjs` 里用代码合成，不入库二进制。

---

## 8. 从 v0.1 迁移（旧调用方看这里）

| v0.1 行为 | v0.2 |
|---|---|
| `inspectImage({source, path, bytes, …})` 识图 | **不存在**。调用会得到 `MEDIA_DISABLED`（合同见 `visionContract()`）。要启用必须另立阶段审批 |
| `speak({emotion, instructions, context})` | `synthesize({text, provider?})`；表演指令写在配置 `tts.providers['breeze-tts-2'].instruction` |
| `autoSpeak()` 自动语音 | **不存在**（主动外发不属媒体模块） |
| `draw({source, style, outfit, composeTags, context})` | `generateImage({prompt, negative, dryRun})`；衣柜/标签转换/翻译属旧栈，已移除 |
| `warm()/releaseWeights()/runtimeStatus()` | **不存在**（不管理本地模型） |
| `deliver()/plan()/recordDelivery()` | **不存在**：媒体层只产出 `handoff`，投递归通道 |
| `screenInspect()` / 屏幕帧 | **不存在**（屏幕输入不在本期范围） |
| 配置 `home/media/config.json` | `<dataDir>/media/config.json`，`schemaVersion:2`；旧文件首次读取时**自动迁移**（旧密钥不读取，丢弃项写进 `dropped[]`） |
| `lib/*.mjs` 手工源码 | `src/**`（团队决策 D6：`plugins/**/lib/**` 视为构建产物，gitignore） |

---

## 9. 版本与兼容

- Node `>=24.0.0`；纯 ESM；无运行时依赖；无构建步骤（`npm run build` 只做一次静态加载自检）。
- `package.json` 的 `exports` 暴露 `.`（插件入口）、`./config`（schema）、`./service`（服务工厂）。
- 新增 provider = 在 `src/schema.mjs` 注册 + 在 `src/adapters/` 写 adapter + 在 `src/adapters/registry.mjs` 挂一行；未核实的 provider 必须 `status: 'not-connected'` 并写 `reason`。
