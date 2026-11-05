# M1 报告：可 Clone 的插件骨架与配置 API

- 阶段：M1
- 日期：2026-11-05
- 证据分级：**源码/配置 ✔ · mock 测试 ✔ · 真实 API ✘ · 真实媒体生成 ✘ · 投递 ✘**

---

## 1. 交付物

```
plugins/companion-media/
  package.json                 @dsh-companion/media · 0.1.0 · type=module · engines.node >=24.0.0
                               exports: "." ./config ./service · files 白名单 · private:true · license MIT
  config.example.json          可提交模板，全部空值占位（无任何真实值/路径/密钥）
  presets/nai-presets.example.json  NAI 预设模板（V5 / 4.5 分仓，全空占位）
  index.mjs                    插件入口：apply(ctx) → 服务 + 4 个工具 + HTTP 路由（失败不抛）
  src/schema.mjs               唯一事实来源：默认值、provider 能力表（含证据等级/来源）、校验、旧配置迁移
  src/config-store.mjs         读写 + 原子保存 + 掩码 + 密钥保留 + 环境变量兜底
  src/secrets.mjs              脱敏（键名 + 值形双规则）、掩码、URL 脱敏
  src/service.mjs              业务门面：status / readConfig / saveConfig / testProvider / generateImage / synthesize
  src/net.mjs                  唯一网络出口：deadline/跳数/三档字节上限/地址白名单
  src/ledger.mjs               作业与产物账本（落 dataDir，不存提示词正文）
  src/media-format.mjs         容器嗅探（图片/音频）、PCM→WAV、ZIP 解包、SSE 解析
  src/errors.mjs               稳定错误码 + 远端错误映射（先脱敏再截断）
  src/resolution.mjs           自动分辨率与校验（越界报错，不静默改值）
  src/presets.mjs              NAI V5 / 4.5 预设分仓
  src/persona.mjs              personaId 解析（env → suite.json → bot）+ dataDir 解析
  src/vision.mjs               识图合同（恒关闭）
  src/ui-page.mjs              页面描述符 + 纯 HTML 预览
  src/http-api.mjs             /api/companion-media/**（Connection 已认证通道）
  src/adapters/*.mjs           7 个 adapter（见 M3）
  scripts/verify-m5.mjs        clone 式验收脚本（可重复执行）
  test/*.test.mjs              11 个测试文件 / 99 个断言
  README.md CONTRACT.md TOOL_GUIDE.md
```

零运行时依赖，无构建步骤（`npm run build` 只 import 一次做静态自检）。

---

## 2. 配置 API（实现 + 证据）

| 要求 | 实现 | 证据 |
|---|---|---|
| 本机配置读取/写入 | `createConfigStore().load()/save()/secret()`；路径 `<dataDir>/media/config.json`，`dataDir` 默认 `<套件根>/data`，可被 `DSH_COMPANION_DATA_DIR` / 挂载选项覆盖 | 源码 + `config-store.test.mjs` |
| **原子保存** | 同目录临时文件（`.config.json.<pid>.<rand>.tmp`）→ `fsync` → `rename`；上一版留 `config.json.bak` | `写入同目录临时文件后 rename，不残留 tmp`（读目录断言无 `.tmp` 残留；POSIX 上还断言 0600） |
| 密钥脱敏（GET 不返回明文） | `maskConfig()` 把每个 `apiKey` 换成 `{configured, mask, source, envVar?}`；值形令牌还会被 `redactText` 抹掉 | `掩码回传不清空已保存的密钥`、`maskConfig：GET 只看到掩码`、`页面预览 HTML 里没有密钥` |
| 保存不覆盖未填密钥 | 传 `""` / `"****"` / 掩码对象 / 省略字段 → 保留原值 | 同上（三种写法各一条断言） |
| 环境变量兜底 | `DSH_MEDIA_<SCOPE>_API_KEY`；掩码视图里标注 `envVar` | `环境变量兜底` 测试 |
| 校验失败不写盘 | `save()` 先合并校验，再落盘；失败返回逐字段 `errors[]` | `校验失败不写盘，返回逐字段错误` |
| 配置损坏降级 | 解析失败 → 默认值 + `validation.ok=false` + `error`，加载不抛 | `配置文件损坏时降级为默认值 + 诊断` |
| 旧配置迁移 | `migrateLegacyConfig()`：保留可确认 API 选项，丢弃项进 `dropped[]`，旧密钥不读取 | `旧 schemaVersion 的文件在读取时自动迁移，且不读旧密钥`、`迁移：旧生产配置…` |
| 能力状态 | 六态：`disabled / unconfigured / not-connected / saved-untested / test-ok / test-failed`；`test-ok` 带 `level`（reachability/metadata/health） | `连接测试：/models 成功 = metadata 级证据`、页面测试 |
| 连接测试 API | `testProvider({kind,id})`：OpenAI → `GET /models`（免费）；Breeze → `GET /health`（免费）；Fish/Drama3 → `GET /model`（免费）；GPT-SoVITS / NAI 官方无免费元数据端点 → 只做可达性探测并**明确说明** | 各 adapter 的 `test()` + 单测 |
| 无远端仍可加载 | 空配置下 `apply()` 成功、工具全注册、`status()` 正常；生成调用返回 `MEDIA_DISABLED` 且**零网络请求** | `零配置：生图/语音都返回 DISABLED，且一次网络都不发` |
| 计费能力默认关闭 | `image.enabled=false`、`tts.enabled=false`、`vision.enabled=false`（恒） | `默认值：所有计费能力关闭…` |

---

## 3. 干净目录（含空格 / 非 C 盘 / 中文路径）验证

按 M1 要求「检查克隆到含空格/非 C 盘路径的干净目录时，模块加载与文件路径均正常」，实测：

```
目标目录：<临时根>\plugins\companion-media        （父目录含空格与中文："m5 路径 测试 with space"）
dataDir： <临时根>\data dir                       （同样含空格）
结果：
  saved=true  drawn=true  artifactInDataDir=true
  configFile=<临时根>\data dir\media\config.json
```

即：`file://` 动态导入、`<dataDir>/media/...` 路径拼装、产物落盘在含空格与中文的路径下均正常。
（E5 的完整 clone 流程见 `M5-report.md`，17/17 通过。）

---

## 4. 未做的部分（诚实清单）

- **没有真实 API 调用**：本轮没有配置任何真实密钥，也没有发起任何计费请求。所有"连接测试"都是 mock 或在无服务时的可达性探测。
- **没有真实宿主加载**：`apply(ctx)` 只在假宿主（`tools.register`/`get`/`provide`/`effect` 桩）里跑过；真实 DSH 宿主的加载证据由 Lead 的 `npm run verify` 与桌面实机验收提供。
- **页面渲染不在本模块**：M1 交付的是配置 API 与页面描述符，实际 DOM 由陪伴空间客户端负责（见 `M2-report.md` §1）。
