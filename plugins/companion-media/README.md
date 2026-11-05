# companion-media

DSH Companion 的媒体层插件：**生图（两种协议）+ 语音合成（五个 provider）+ 识图合同（默认关闭、不可绕过）**。

- 纯 ESM，**零运行时依赖**，无构建步骤（`npm run build` 只做一次静态加载自检）
- Node `>=24.0.0`
- 默认**什么都不连、什么都不花**：所有计费能力初始关闭
- 只连接**你已经部署好**的外部服务；不下载模型、不安装服务、不管理显存

---

## 1. 安装

本插件是套件里的一个 workspace 包（`@dsh-companion/media`）。从仓库根目录：

```bash
npm install          # 或锁文件就绪后：npm ci
npm run build        # 全部模块
npm run setup        # 初始化 <套件根>/data 与配置模板（不覆盖已有文件）
```

在 DSH composition 里挂载：

```yaml
- insert:
    - id: companion-media
      name: 'file:///<仓库绝对路径>/plugins/companion-media/index.mjs'
```

> 插件目录本身**不需要** `npm install`：它没有依赖。

---

## 2. 配置

- 模板：`config.example.json`（可提交，只有空值占位）
- 实际配置：`<dataDir>/media/config.json`（`dataDir` 默认 `<套件根>/data`，可用 `DSH_COMPANION_DATA_DIR` 覆盖）
- 预设模板：`presets/nai-presets.example.json`
- 密钥两种放法：写进上面那份本机配置，或设环境变量 `DSH_MEDIA_<SCOPE>_API_KEY`（scope 例：`OPENAI` / `NAI` / `FISH_AUDIO` / `DRAMA3` / `BREEZE_TTS_2` / `GPT_SOVITS`）

配置**不在仓库里**，也不该进仓库。保存是原子的（同目录 temp → fsync → rename），上一版留 `.bak`。

页面：陪伴空间 →「工具」→「媒体能力」。每个 provider 展开才显示自己的选项；识图一栏显示"预留，当前关闭"且开关不可操作。

---

## 3. Provider 支持矩阵

| provider | 类型 | 状态 | 鉴权 | 返回 | 证据等级 |
|---|---|---|---|---|---|
| OpenAI-compatible | 生图 | **已接入** | `Authorization: Bearer` | JSON `data[].b64_json` 或 `data[].url`（受控下载） | A（官方 OpenAPI 规范） |
| NovelAI 官方直连 | 生图 | **已接入** | `Bearer` Access Token | SSE / ZIP 附件（内含 PNG） | A（官方 Swagger，模型 ID 为 C 级） |
| NovelAI 中转站 | 生图 | **已接入**（`transport: openai-relay`） | `Bearer` | JSON `data[].b64_json` | C（社区实现交叉验证） |
| Breeze TTS 2 | TTS | **已接入** | 无（必须只监听本机/内网） | 流式 `audio/pcm`（24 kHz s16le）→ 封装 WAV | A（官方 `breeze_infer/api.py`） |
| GPT-SoVITS | TTS | **已接入** | 无（同上） | `audio/wav`（`media_type` 由服务端/请求决定） | A（官方 `api_v2.py`） |
| Fish Audio | TTS | **已接入** | `Bearer` | 音频字节（`wav`/`mp3`/`opus`） | B（官方 API 文档） |
| Drama3 | TTS | **已接入**（Fish Audio 的 `drama-3` 模型） | `Bearer` | 同上；支持多说话人 | B（同上，model enum 含 `drama-3`） |
| Index-TTS | TTS | **尚未接入** | — | — | — 官方只有 Python API / WebUI / vLLM·Triton recipe，无 HTTP 协议可核实 |

每个 provider 的端点、字段、音色查询方式、限流、许可、核实日期都在 `docs/media/M0-report.md` 的字段矩阵里，逐行带来源 URL。

---

## 4. 安全与默认值

| 项 | 行为 |
|---|---|
| 计费能力 | `image.enabled` / `tts.enabled` 默认 `false`；生成需工具调用或页面显式 `confirm:true` |
| 生图重试 | **永不自动重试**（配置里没有这个开关），避免重复扣费 |
| 识图 | 恒关闭；无工具、无可用路由；`vision.enabled` 写不进去（读回恒 `false`） |
| 密钥 | GET/日志/错误消息一律掩码；`apiKey` 传空或掩码 = 保留原值 |
| 网络 | 只有 http/https；跳转 ≤2 次逐跳重查；整条请求一个总 deadline；响应体/图片/音频三档字节上限；`169.254.*` 拒绝；本机地址允许（TTS 在本机） |
| 下载 | 远端 URL 只在本层有界下载，**绝不**把任意 URL 交给宿主 |
| 路径 | 产物默认落 `<dataDir>/workspace/media/`（通道能读的工作区边界内，可用 `paths.artifactsDir` 改）；账本/日志落 `<dataDir>/media/`；产物文件名是内容摘要 |

> **已知约束（对接 QQ 通道）**：通道只接受位于 `<dataRoot>/workspace` 或 `<dshHome>/channel-qq` 之内的本地文件，越界会以 `outside-boundary` 拒绝发送。所以默认产物目录是工作区里的 `media/`；如果你把 `paths.artifactsDir` 指到别处，要么把它指回这两个根之内，要么自己承担"发不出去"的后果。

---

## 5. 各 provider 需要你自己部署/准备什么

| provider | 你需要做的 |
|---|---|
| OpenAI-compatible | 有 API Key 和 Base URL（官方或任何兼容网关）；填模型名 |
| NovelAI 官方 | 订阅账号的持久 Access Token；Base URL 默认 `https://image.novelai.net` |
| NovelAI 中转站 | 中转站给的 Base URL + Key，并把 `transport` 切到 `openai-relay`（如果它讲官方协议则用 `official`） |
| Breeze TTS 2 | 自行部署官方服务：`python -m breeze_infer.api <checkpoint> --host 127.0.0.1 --port 7860`；**模型权重是非商业研究许可**，商用请走官方托管服务 |
| GPT-SoVITS | 自行运行 `python api_v2.py -a 127.0.0.1 -p 9880`，并准备**服务端**的参考音频路径与逐字稿 |
| Fish Audio / Drama3 | 在 fish.audio 建 API Key、建/选语音模型（`reference_id`）；可先用免费档 `s2.1-pro-free` 试 |
| Index-TTS | 目前无法通过本插件使用 |

本插件**不会**帮你下载权重、启动这些服务、或回收显存。

---

## 6. 测试

```bash
node --test "test/*.test.mjs"     # 99 个断言，全部离线，不需要任何密钥或服务
```

覆盖：schema 校验、密钥脱敏、provider 切换互不覆盖、NAI V5/4.5 预设不串用、默认关闭、参数边界、原子保存、错误映射、网络预算（deadline / 跳数 / 三档字节上限的"恰好等于"与"超一字节"）、HTTP API 的 confirm 闸与跨站拒绝、页面不泄漏密钥、**产物落在通道边界内（工作区）且可配置**。

测试里的图片/音频/ZIP **全部由代码合成**（`test/helpers.mjs`），仓库里没有任何二进制媒体文件。

---

## 7. 已知限制（诚实清单）

1. 所有 provider 的**真实调用**本轮一次都没发起（会产生费用）。协议按官方源码/文档核对 + mock 测试；真实可用性需操作者逐服务手动触发（见 `docs/media/M5-report.md` 的手动步骤）。
2. NovelAI `parameters` 的逐字段明细来自 MIT 参考实现的交叉验证（C 级）；官方规范只写"model specific"。
3. NovelAI 模型 ID 字符串（`nai-diffusion-5-full` 等）不在官方 Swagger 的过期 enum 里，属社区证据。
4. NovelAI 官方"质量标签 / Undesired Content"预设的逐字文本没有权威副本，插件只提供**空占位**，不假装是官方原文。
5. Fish Audio 的 Models 列表接口本轮未取到页面证据；`reference_id` 当不透明字符串处理。
6. 限流数值（OpenAI / NAI / Fish Audio）均未核实；只做客户端预算，不猜额度。
7. 连接测试的证据等级分层（`reachability` / `metadata` / `health`）——"测试通过"只代表那一级，不代表端到端生成可用。

---

## 8. 回滚 / 卸载

- 关掉能力：`image.enabled=false`、`tts.enabled=false`（立即生效，无需重启）。
- 恢复默认：删除 `<dataDir>/media/config.json`，或调用 `store.reset()`；`.bak` 是同目录的上一版。
- 卸载插件：从 composition 移除该行并重启宿主；`<dataDir>/media/` 可整个删除（含账本与产物）。
- 从旧版 `home/media/config.json` 升级：首次读取时自动迁移（只保留能确认的 API 选项，丢弃项列在 `dropped[]`；旧密钥不读取，需重填）。
