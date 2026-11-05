# M5 报告：交付与 Clone 验收

- 阶段：M5
- 日期：2026-11-05
- 证据分级：**源码/配置 ✔ · mock 测试 ✔ · 真实 API ✘ · 真实媒体生成 ✘ · 投递 ✘**

---

## 1. 一条命令跑完整条验收链

```bash
cd plugins/companion-media
node scripts/verify-m5.mjs          # 全部通过时自动清理临时目录
node scripts/verify-m5.mjs --keep   # 排查时保留临时目录（会打印路径）
```

脚本做的事：复制源码到临时目录 → `npm install` → `npm run build` → `node --test` → 从 `config.example.json` 初始化本机配置 → 配置一个 provider → 保存并确认掩码 → 连接测试 → 一次合成内容生图 → 重新挂载确认配置仍在 → 扫描仓库卫生。

**本轮实跑结果（2026-11-05，Node v24.14.0，Windows）：17/17 通过**

```
PASS  复制源码到干净目录
PASS  npm install（无依赖包，离线可完成）
PASS  npm run build
PASS  node --test（99 个断言）
PASS  从 config.example.json 初始化本机配置
PASS  插件在无配置/无 Connection 的宿主里加载 — tools=[companion_media_status,companion_media_draw,companion_media_speak,companion_media_job]
PASS  只注册 4 个工具且无识图/预热入口
PASS  保存 provider 配置
PASS  GET 视图不含密钥明文
PASS  密钥标记为已配置（掩码）
PASS  连接测试（mock /models） — level=metadata
PASS  一次合成内容生图（mock，不产生费用） — image/png
PASS  产物落在工作区 <dataRoot>/workspace/media（通道边界内）、且 handoff.delivered=false
PASS  重启后配置仍在
PASS  重启后密钥仍是掩码
PASS  重启后产物仍在账本里
PASS  源码树无真实密钥/无作者路径/无媒体产物
结果：17/17 通过
```

### 1.1 与「标准 M5 流程」的差异（如实记录）

| 标准流程 | 本轮实际 | 原因 |
|---|---|---|
| `clone → npm ci` | **`npm install`** | 根锁文件尚未生成（Lead 决定 B：所有模块 package.json 稳定后统一生成）。**锁文件就绪后需要用 `npm ci` 复验一次** |
| 真实 API provider 配置与掩码确认 | ✔ 已做（mock 端点，密钥是明显占位串） | 不产生费用；真实密钥由操作者填 |
| 「手动测试连接」 | ✔ 已做（mock `/models`，`level=metadata`） | 同上 |
| 「完成一次明确授权的合成内容生图」 | ✔ **mock**（合成 PNG 由代码生成，不发起真实请求） | 真实生成会产生费用，只能由操作者触发（§4） |
| 重启插件确认配置仍在 | ✔ 同一数据目录上重建服务实例，配置/掩码/账本都在 | — |
| 仓库无 secret / 无作者路径 / 无媒体产物 | ✔ 扫描通过（源码、文档、脚本全扫；测试夹具允许合成占位串与 `C:/fixtures/…` 路径） | — |

另外单独验证过**含空格与中文的克隆路径**（`…\m5 路径 测试 with space\plugins\companion-media`、`…\data dir`）：保存配置、生成产物、路径拼装全部正常（见 `M1-report.md` §3）。

---

## 2. 交付内容

| 类别 | 位置 |
|---|---|
| 插件源码 | `plugins/companion-media/{index.mjs, src/**, presets/**, scripts/verify-m5.mjs}` |
| 配置模板 | `plugins/companion-media/config.example.json`、`presets/nai-presets.example.json` |
| 合同与文档 | `plugins/companion-media/{README.md, CONTRACT.md, TOOL_GUIDE.md}` |
| 测试 | `plugins/companion-media/test/*.test.mjs`（11 文件 99 断言） |
| 阶段报告 | `docs/media/M0-report.md` … `M5-report.md` |

**仓库里没有**：模型权重、媒体产物、生成记录、真实密钥、作者机器路径、二进制测试素材。

---

## 3. 运行期数据在哪（不入库）

```
<dataDir>/workspace/media/        ← 交付给通道的产物（默认；可在 config.paths.artifactsDir 改）
  image/<sha256 前 32 位>.<ext>
  speech/<sha256 前 32 位>.<ext>

<dataDir>/media/                  ← 内部数据，不需要交给通道
  config.json           本机配置（含密钥，0600）
  config.json.bak       上一版
  state/ledger.json     作业与产物元数据（无提示词正文）
  state/tests.json      最近一次连接测试结果（用于 saved-untested / test-ok / test-failed）
  logs/media-events.jsonl  挂载/保存/生成的诊断事件（不含密钥与媒体内容）
```

`dataDir` 默认 `<套件根>/data`，可用 `DSH_COMPANION_DATA_DIR` 或挂载选项覆盖。

**产物默认路径 / 如何改 / 已知约束（交叉集成补充）**：

| 项 | 内容 |
|---|---|
| 默认产物目录 | `<dataRoot>/workspace/media/{image,speech}/` |
| 改成别处 | 配置 `paths.artifactsDir`：绝对路径，或相对 `dataRoot` 的路径；留空 = 默认 |
| 为什么是工作区 | `dsh-channel-qq` 的 `napcatFileArg` 只读两个根：`config.workspacePath`（默认 `<dataRoot>/workspace`）与 `<dshHome>/channel-qq`；其它路径按 `outside-boundary` 拒绝发送 |
| **已知约束** | 把 `paths.artifactsDir` 指到上述两个根之外 → 产物能生成，但**会被通道拒绝发送**。`status().paths` 会回显 `artifactRoot` / `artifactRootSource` / `channelBoundary` / `channelBoundaryNote`，UI 应据此提示 |
| 不变的边界 | 媒体只写自己的产物目录；通道只读边界内的文件——不会为媒体开「任意路径」的口子 |

`<dataDir>/tmp/` 只用于中间态（下载缓冲、ZIP 解包等），**不存放**要发出去的最终文件。

---

## 4. 需要操作者手动触发的真实调用（本插件不会自己做）

> 以下每一步都**可能产生费用**。请逐服务、逐次确认后再执行；不要批量跑。

### 4.1 OpenAI-compatible 生图

1. 「媒体能力 → 生图」选 `openai-compatible`，填 Base URL（例：`https://api.openai.com/v1`）、API Key、模型（例：`gpt-image-2.5-flare`），保存。
2. 点「测试连接」：期望 `level=metadata`（`GET /models` 成功）。若 Base URL 不支持 `/models`，会显示 `reachability`——这不代表密钥有效。
3. 用工具 `companion_media_draw` 先 `dryRun:true`（不花钱），确认参数无误。
4. 再 `dryRun:false` 生成一次；确认返回 `artifact.absolutePath` 与 `handoff.delivered=false`。
5. 记录：消耗额度、耗时、返回尺寸、`artifact.bytes`。

### 4.2 NovelAI

1. 选 `nai`，`transport=official`，Base URL `https://image.novelai.net`，填 Access Token，模型 `nai-diffusion-4-5-full`（或 `-5-full`），分辨率 832×1216、步数 28。
2. 先 `dryRun:true`，确认 `preset.family` 与 `resolution.ok`。
3. 真跑一次；重点验证 ZIP 分支（官方通常返回 ZIP 附件）与预设是否按族生效。
4. 若用中转站：`transport=openai-relay` + 中转站 Base URL，确认它接受 `{prompt,size,n,model,parameters}` 这一体。
5. 记录：是否 402（订阅）、是否 429（限流）、出图耗时。

### 4.3 Breeze TTS 2

1. 先自行部署：`python -m breeze_infer.api <checkpoint> --host 127.0.0.1 --port 7860`（**权重是非商业研究许可**，商用走官方托管）。
2. 填服务地址 → 点「测试连接」：期望 `level=health`（`GET /health` 返回 `sample_rate`）。
3. 合成一句中文短句；确认产物是 24 kHz WAV、能播放。
4. 若配了参考音频：确认逐字稿与之成对（否则本地就拒绝）。

### 4.4 GPT-SoVITS

1. 自行运行 `python api_v2.py -a 127.0.0.1 -p 9880`。
2. 填服务地址、**服务端**参考音频路径、逐字稿与语种；`media_type=wav`。
3. 点「测试连接」只会得到 `reachability`（该服务没有 `/health`，且 `/control` 会改状态，故不探测）。
4. 合成一次；确认音频能播放、时长解析正确。

### 4.5 Fish Audio / Drama3

1. 在 fish.audio 建 API Key 与语音模型（`reference_id`）；可先用免费档 `s2.1-pro-free` 验证链路。
2. 填 Key 与 `reference_id` → 「测试连接」期望 `level=metadata`（`GET /model`）。
3. 合成一次；`format=wav`。Drama3 想试多说话人：`reference_id` 填 `idA,idB`，正文用 `<|speaker:0|>…<|speaker:1|>…`。
4. 记录：额度消耗、耗时、错误信封形态。

### 4.6 每个服务都要记录的证据

- 实际调用的时间、服务与模型、是否计费；
- 成功/失败与错误码；
- 产物大小与能否播放/打开；
- **不要**把产物与密钥贴进仓库或报告。

---

## 5. 未验证清单（最终版）

| 项 | 状态 | 说明 |
|---|---|---|
| 两个生图协议的真实调用 | **未做** | 协议按官方规范核对 + mock 验证（ZIP/SSE/JSON 三分支、b64/url 两分支） |
| 五个 TTS 的真实调用 | **未做** | 同上；Index-TTS 本就未接入 |
| 真实 API 错误语义（429/402/409 的真实形态） | **未做** | 只按官方文档的状态码映射 |
| 真实 GUI 页面渲染与交互 | **未做** | 页面描述符已交付，DOM 在 studio 客户端（`M2-report.md` §1） |
| 真实 DSH 宿主加载 | **未做** | 只在假宿主验证；需 Lead 的 `npm run verify` / 桌面实机 |
| 投递（QQ 发图/发语音） | **未做** | 不属本模块；handoff 已按 `CONTRACT.md` §2.3 固定字段 |
| `npm ci`（锁文件） | **未做** | Lead 决定 B：锁文件就绪后复验 |
| 限流/并发压力 | **未做** | 只测单次请求语义 |

---

## 6. 结论

- 可 Clone、可安装、可构建、可测试、可加载（无远端时也能加载），配置/密钥/状态语义符合规格；
- **没有任何真实外部调用**，因此本报告**不声称**"端到端可用"——只声称"协议实现完整、离线验证通过、真实可用性待操作者逐服务手动触发"。
