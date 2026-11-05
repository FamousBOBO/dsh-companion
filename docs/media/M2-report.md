# M2 报告：陪伴空间「工具 → 媒体能力」

- 阶段：M2
- 日期：2026-11-05
- 证据分级：**源码/配置 ✔ · mock 测试 ✔ · 真实 API ✘ · 真实媒体生成 ✘ · 投递 ✘ · 真实 GUI 渲染 ✘（见 §1 边界）**

---

## 1. 边界先说清楚：页面数据在本模块，DOM 在陪伴空间客户端

- 本模块交付：**页面描述符**（`src/ui-page.mjs` 的 `mediaPageDescriptor(status)`）+ **后端 API**（`src/http-api.mjs`，前缀 `/api/companion-media`）+ **纯 HTML 预览**（`renderPagePreview()`，用于文档与"不泄密"断言）。
- 真实 DOM 渲染在 `companion-memory-studio` 的客户端（属 core-memory 范围）。本模块不写、不改那边。
- 因此 M2 的**验收证据**是：描述符字段、状态词、开关语义、API 行为、以及"页面不显示密钥/不把已保存说成连接成功"的断言——**不是**一张 GUI 截图。真实 GUI 需要 studio 侧挂载后由操作者验收。

「工具」分组、二级页、页面 id/title/group 已在描述符里固定：`{ id: 'companion-media', title: '媒体能力', group: '工具', order: 40 }`。

描述符的可渲染契约（字段形状、`pathParts`、`canTest`/`canEnable`、`api` 端点表、`meta.testPolicy`）见 `plugins/companion-media/CONTRACT.md` §4.1；provider id 一览见同文件 §4.2（canonical：`openai-compatible` / `nai` / `breeze-tts2` / `gpt-sovits` / `drama3` / `index-tts` / `fish-audio`）。

---

## 2. 页面结构（描述符实际内容）

三个章节，provider 专属选项**只在展开该 provider 时出现**（`providers[].fields`），通用区只显示状态、默认后端与开关。

### 2.1 识图（`sections[0]`）

- `locked: true`，`toggle: { path: 'vision.enabled', disabled: true, value: false, why: '本期只保留合同' }`
- 页面文案：**「预留，当前关闭。开关不可操作，也没有任何工具或接口能发起识图调用。」**
- 字段仍可保存（Base URL / API Key / 模型 / 超时），便于以后启用，但保存不会让它变成可用。
- **不可绕过**在三层同时成立：
  1. 工具层：没有 `companion_media_inspect`（工具注册断言：4 个工具、无 `inspect`/`warm`）；
  2. 配置层：`save({vision:{enabled:true}})` 成功但读回恒 `false`；直接改文件也会被 `normalizeConfig` 拉回；
  3. HTTP 层：`GET/POST /api/companion-media/vision` 恒返回 `MEDIA_DISABLED` + 合同（POST 400）。

### 2.2 生图（`sections[1]`）

- 总开关 `image.enabled`（默认 false），协议选择 `image.provider`（none / `openai-compatible` / `nai`）。
- 两个 provider 块各自展开：必填项 + 端点/鉴权/返回/音色查询/限流/许可/证据等级。
- `preview`：自动分辨率预览（`GET /preview`，与 adapter 同一个函数，可复现）。
- `presets`：V5 与 4.5 分仓（见 §3）。
- 显式提示：「计费能力：默认关闭；失败不会自动重试，重试必须由人显式发起」。

### 2.3 语音合成（`sections[2]`）

- 总开关 `tts.enabled`，默认后端 `tts.provider`，五个 provider 各自展开。
- Index-TTS 显示为**「尚未接入」**并带原因（缺官方 HTTP 协议），开关被配置校验拒绝。
- 提示：「只产出音频文件，不发送消息；可能计费的后端同样默认关闭」。

### 2.4 状态词（页面必须照抄，不得自造）

`disabled 功能关闭 / unconfigured 未配置 / not-connected 尚未接入 / saved-untested 已保存、未测试 / test-ok 测试通过 / test-failed 测试失败`

断言：保存配置后页面显示**「已保存、未测试」**；HTML 预览里**不出现「连接成功」**字样。

---

## 3. 配置互不覆盖 · 预设不串用 · 参数默认

| 要求 | 实现 | 断言 |
|---|---|---|
| OpenAI 与 NAI 配置切换保留彼此值 | 两段独立存储（`image['openai-compatible'].*` / `image.nai.*`），切换只改 `image.provider` | `provider 切换…`（见 M4 覆盖表）/ schema 合并语义 |
| NAI V5 与 4.5 正负预设分开 | `image.nai.presets['5']` 与 `['4.5']` 物理隔离，各含 `applyDefaults/positive/negative`；族由模型 ID 决定 | `预设：V5 与 4.5 分开存储，互不覆盖`；`NAI：V5 预设不会出现在 4.5 请求里` |
| 预设可选官方选项 / 可自定义 / 可清空 | `applyDefaults` 决定是否拼接；`positive/negative` 为空 = 清空（合法状态） | `预设：清空是受支持的状态` |
| 步数默认 28 | `image.nai.steps = 28` | `默认值：…步数默认 28`、NAI 请求体断言 `steps === 28` |
| 分辨率/自动分辨率可预览 | `GET /preview?mode=auto` 与 `mode=fixed`；与 adapter 共用 `previewResolution()` | `分辨率：自动计算对齐 64，且可复现`、`GET /preview 复现自动分辨率` |
| 超范围明确报错，不静默改值 | `validateResolution()` 返回 `MEDIA_PARAM_OUT_OF_RANGE` | `分辨率：超出声明范围报错，绝不静默收敛` |
| 危险/计费能力显式开关 | `image.enabled` / `tts.enabled` / 每个 TTS 的 `enabled`；HTTP 生成还需 `confirm:true` | `POST /image 必须带 confirm:true` |

**画师串的落位（回答 Lead 的 §2 问题）**：旧 `presets/nai-style.json`（个人画师串 + 正负默认串）**不发布**。替代是 `image.nai.presets[<族>].positive`（画师串写在正向预设里）+ `negative`，模板见 `presets/nai-presets.example.json`。理由：该文件内容是作者个人偏好，属"不包含作者个人资料"硬要求；且旧结构没法把 V5/4.5 分开。

---

## 4. 保存/重载一致 · 错误提示不泄密

| 要求 | 实现 | 断言 |
|---|---|---|
| 保存、重载显示一致 | 保存返回 `masked` 与 `states`；重载走同一 `store.load()`；`dataDir` 上重启后配置仍在 | `保存 → 读取：GET 视图是掩码`、M5 的 `重启后配置仍在` |
| 无权限 / 校验失败 | HTTP 400 + `{errors:[{path,code,message}]}`；跨站 Origin 直接 403 | `POST /config 保存成功并校验…`、`跨站 Origin 被拒绝` |
| API 超时 / 限流 / 服务端错误 | `MEDIA_TIMEOUT` / `MEDIA_RATE_LIMITED`（带 Retry-After 与"不自动重试"）/ `MEDIA_UPSTREAM`（`AUTH_FAILED`/`ENTITLEMENT` 更具体） | 错误映射测试（M4） |
| 提示不泄密 | 上游 body 先 `redactText` 再截断 200 字符 | `错误消息不因为上游 body 带 key 而泄漏`、`页面预览 HTML 里没有密钥` |

---

## 5. 未做的部分

- **真实 GUI 渲染与交互**（折叠、表单控件、按钮禁用态）未验收：需要 studio 客户端挂载描述符后由操作者在真机点一遍。
- **浏览器里的保存→刷新往返**未做端到端：本模块只保证 API 语义与掩码契约。
- 页面上的「官方预设选项下拉」本轮为**空占位**（官方预设逐字文本无权威副本，见 `M0-report.md` §2.4），用户自行粘贴。
