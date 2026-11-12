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
  "action": "send_image",
  "file": "<absolute path>",
  "mime": "image/png",
  "bytes": 123456,
  "provider": "openai",
  "model": "gpt-image-…",
  "ready": true,
  "delivered": false,
  "mustSend": "调用 qq_sticker action=send_image 并传 file=…"
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
| `companion_media_draw` | 有 | **保留** | `prompt`,`negative?`,`subject?`,`outfit?`,`dryRun?`；`source/style/composeTags/context` 移除（标签转换属旧栈）。**2026-11-10 变更**：`subject=companion` 时角色身份与当前服装由 `resolveCompanionVisualState()` 自动注入（见 §9 与 `companion-foundation/WARDROBE-STATE-CONTRACT.md` §6），模型不再需要也不应在 `outfit` 里自己写衣服；`outfit` 保留给显式换装，仍只接受英文。**视觉身份是强制条件**：身份缺失 / 不可读 / 无效 / 与当前 persona 不匹配 / 只有中文外观时，调用在任何 provider 请求之前被拒绝（`MEDIA_VISUAL_IDENTITY_REQUIRED`，`details.missing` 指明缺的是 `identity` 还是 `identity-english`），`outfit` 不能绕过；`subject=other` 一律 `MEDIA_BAD_INPUT`，空 `subject` 保持旧行为（不注入、不校验身份） |
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

**注册时机**：`connection` 由宿主**异步**提供，插件激活时可能还不存在。因此首次注册若返回 `no-connection`，插件会用 `ctx.inject(['connection'], …)` 等它到达后**再注册一次**（与 memory studio 相同的做法）；注册按 path 幂等，重复挂载会覆盖而不是堆积。共 9 条路由：`status` / `config` / `test` / `page` / `preview` / `jobs` / `image` / `speech` / `vision`。

**注册结果是可查的**：`GET /status` 的 `http` 字段（以及 `/page` 的 `meta.http`）给出 `{ registered, skipped, how: 'direct'|'inject'|null, at, paths, failed, lastError }`。这是区分「模块未启用」与「模块已启用但管理 API 没起来」的唯一可靠信号——HTTP 404 本身说明不了是哪种。

宿主日志（`<dataDir>/media/logs/media-events.jsonl`）里对应两行：
- 未就绪：`{"event":"http-api-waiting","how":"direct","registered":0,"skipped":"no-connection","note":"等待 connection 服务（首次尝试未就绪，已用 ctx.inject 挂起重试）"}`
- 注册成功：`{"event":"http-api-registered","how":"inject","registered":9,"paths":[…],"note":"已注册 9 条路由（inject）"}`

**HTTP 状态 vs 响应体 `ok` 是两件事**（客户端要分别处理）：
- HTTP 状态回答「这个请求本身是否可接受」：JSON 体、provider id 已知、`confirm:true`、schema 校验通过；
- `ok` 回答「这次操作是否成功」：provider 报 401 时，测试动作本身成功（HTTP 200），但 `ok:false` + `code:MEDIA_AUTH_FAILED`。

| 方法 路径 | 作用 | 计费 | 状态码语义 |
|---|---|---|---|
| `GET /status` | 状态（同 `status()`） | 否 | 200 |
| `GET /config` | 掩码配置 | 否 | 200 |
| `POST /config` | `{patch}` 保存 | 否 | 200 保存成功 / 400 校验失败（`errors[]` 逐字段） |
| `POST /test` | `{kind,id}` 连接测试，**只能显式触发** | 否（不生成不合成） | 200 测试已执行（结果看 `ok`）/ 400 未知 provider、kind 非法 |
| `GET /page` | 「工具 → 媒体能力」页描述符 | 否 | 200 |
| `GET /preview` | 自动分辨率预览 | 否 | 200（越界时 `resolution.ok:false` 带 `error`） |
| `GET /jobs` | 作业/产物 | 否 | 200 |
| `POST /image` | **必须带 `confirm:true`**，否则 400 | 是 | 200 成功 / 400 未开、未配置、参数越界、缺 confirm |
| `POST /speech` | **必须带 `confirm:true`** | 可能 | 同上 |
| `GET/POST /vision` | 恒拒绝 + 合同 | 否 | GET 200（`ok:false`）/ POST 400 |

**页面加载绝不触发 `/test`**：`GET /page|config|status|jobs|preview` 不发起任何外部请求（有单测断言 fetch 调用次数 = 0）。描述符里 `meta.testPolicy = 'explicit-only'` 把这个约定写进数据。

### 4.1 页面描述符（Studio 直接渲染，`src/ui-page.mjs`）

```ts
{
  id: 'companion-media', title: '媒体能力', group: '工具', order: 40,
  states: [{ id: 'disabled'|'unconfigured'|'not-connected'|'saved-untested'|'test-ok'|'test-failed', label }],
  api: { status, config, save, test, preview, jobs, generate, speech },   // 客户端不要自己拼路径
  sections: [
    {
      id: 'vision', title: '识图', state: 'disabled', locked: true,
      toggle: { path, pathParts, label, disabled: true, value: false, why },
      fields: [ { path, pathParts, label, type, value, writable, hint? } ],
    },
    {
      id: 'image', title: '生图',
      toggle: { path: 'image.enabled', ... },
      selector: { path: 'image.provider', options: [{value,label}], value },
      providers: [{
        id, label, status,                    // status: connected | not-connected
        state, stateNote, stateDetail,        // 六态 + 原因
        canTest, canEnable,                   // not-connected 的 provider 两者皆 false
        endpoint, auth, responseFormat, voiceListing, rateLimit, license, version, evidence,
        key: { configured, source },          // 不含明文
        fields: [{ path, pathParts, label, type, value, writable, hint }],
      }],
      preview: { endpoint, label, note, values: { mode, aspect, targetPixels, model } },
      presets: { path, families: [...], artistString: field },
    },
    { id: 'tts', ... providers: [五个] },
  ],
  meta: { configFile, paths, persona, testPolicy: 'explicit-only' },
}
```

渲染约定：
- `type: 'secret'` 的输入框是**只写**的：`value` 是 `{configured, mask, source}`，输入框始终为空、占位符显示「已配置/未配置」；
- `type: 'select'` 的字段**一定带 `options: [{value,label}]`**（枚举来自 `schema.mjs`，与 adapter/校验共用同一份）；没有 options 的字段一律降级成 `text`，不会发"点了就报错"的空下拉；
- **生图 provider 没有 `enabled` 字段**：它的启停由 `sections[image].toggle`（`image.enabled`）+ `selector`（`image.provider`）表达，不存在可写的 `image.<provider>.enabled` 键；**TTS 每个后端有自己的 `tts.providers.<id>.enabled`**，所以 TTS 的 provider 里保留该字段；
- `toggle.disabled`、`canEnable`、`canTest` 由后端给出，客户端不必（也不该）自己推断；
- 状态文案直接取 `states[].label`，不得自造，也不得把 `saved-untested` 写成「连接成功」。

### 4.2 配置 id 一览（客户端与后端共用一套名字）

| kind | id | 状态 |
|---|---|---|
| image | `openai-compatible` | `connected` |
| image | `nai` | `connected`（`transport` 再分 `official` / `openai-relay`） |
| tts | `breeze-tts2` | `connected` |
| tts | `gpt-sovits` | `connected` |
| tts | `drama3` | `connected` |
| tts | `index-tts` | **`not-connected`**（bilibili 模型使用协议 + 无文档化 HTTP 契约） |
| tts | `fish-audio` | `connected` |
| vision | — | 恒 `reserved-disabled` |

旧 id `openai`、`breeze-tts-2` 仍被接受（归一成上表），但 `/status` 与 `/page` 只输出上表的名字。

---

## 5. 配置合同

- 位置：`<dataDir>/media/config.json`（`dataDir` 默认 `<套件根>/data`，可用 `DSH_COMPANION_DATA_DIR` 或 `mountMedia` 的 `dataDir` 覆盖）。**不在源码树里**。
- 模板：`config.example.json`（可提交，无任何真实值）；预设模板：`presets/nai-presets.example.json`。
- 保存：schema 校验 → 临时文件（同目录）→ `fsync` → `rename`；上一版留 `config.json.bak`。校验失败**不写盘**。
- 密钥：`apiKey` 只存在于本地文件或 `DSH_MEDIA_<SCOPE>_API_KEY` 环境变量；GET 返回 `{configured, mask, source, envVar?}`。

### 5.1 密钥的保存语义（客户端必须照此实现）

| POST 里传什么 | 结果 |
|---|---|
| `"新密钥字符串"` | 写入新值 |
| `""` / 空白 | **保留**已存值 |
| `"******"` / `"sk…abcd"`（掩码字符串） | **保留**已存值 |
| `{configured:true, mask:'sk…abcd'}`（把 GET 的返回原样回传） | **保留**已存值 |
| `null` | **清除**（显式动作） |
| `{clear:true}` | **清除**（显式动作） |

注意：如果该 provider 正处于**启用**状态且密钥是必填项，清除会被 schema 校验挡住（HTTP 400，错误指向 `…apiKey`），因为一个"已启用但没有密钥"的配置只会静默失败。正确流程是**先关能力，再清除**——页面应当把两件事分开做。

- `vision.enabled` 不可写：无论提交什么、无论直接改文件，读回恒为 `false`。
- 画师串：`image.nai.artistString`（独立字段，写进正向提示词最前面），与 `image.nai.presets[族]` 分开保存。
- 旧 id 归一：`openai` → `openai-compatible`、`breeze-tts-2` → `breeze-tts2`（见 §4.2）。

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
| `draw({source, style, outfit, composeTags, context})` | `generateImage({prompt, negative, dryRun})`；标签转换/翻译属旧栈，已移除。`subject=companion` 时身份与当前服装**自动注入**；显式 `outfit`（英文）仍可覆盖，旧调用不会失效 |
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


## 2026-11-12 生图提示词合同修订（优先于上文旧拼接约定）

陪伴角色生图前，模型必须先调用只读 companion_media_visual，读取当前 persona 的英文身份、当前衣物与场景来源，再将外观、镜头内可见衣物、动作、表情、构图、环境和光线统一写为完整英文 prompt。参考信息不是固定后缀，习惯性配饰按当前画面取舍；换装先更新衣柜并重新读取。工具说明约束读取顺序，服务端不做语义匹配或宣称模型已遵守。

所有 NAI 连接方式的画面正文为 artistString + prompt；不追加视觉身份、衣物或旧手填正向预设；用户选择的官方质量预设（如 Light）仍单独生效。旧配置仍保留供参考，反向预设合并不变。OpenAI 直接使用完整 prompt。旧 outfit 参数保留兼容校验，不写入提示词。

companion_media_visual 不发网络请求，不写衣柜；群聊遵守现有私人衣柜隔离。draw 仍校验身份与衣柜可用性，dryRun 返回 prompt 和视觉参考（clothingClause / identityClause），NAI 的 preset.positive 为最终正向文本。visual 元数据只说明参考来源，不证明模型已将其画入图片。
