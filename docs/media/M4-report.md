# M4 报告：测试与迁移

- 阶段：M4
- 日期：2026-11-05
- 证据分级：**源码/配置 ✔ · mock 测试 ✔ · 真实 API ✘ · 真实媒体生成 ✘ · 投递 ✘**

---

## 1. 怎么跑

```bash
cd plugins/companion-media
node --test "test/*.test.mjs"        # 99 个断言 / 11 个文件 / 全离线 / 无需密钥或服务
```

最近一次结果（本机，Node v24.14.0，Windows）：

```
tests 99 / suites 0 / pass 99 / fail 0 / duration ~1.0s
```

`package.json` 里 `npm test` 与 `npm run test:unit` 都指向同一条命令。

---

## 2. 覆盖矩阵（要求 → 测试）

| 要求（规格/Lead） | 测试文件 · 用例 |
|---|---|
| **API Schema 校验** | `schema.test.mjs`：默认值、vision 锁定、必填项、步骤/scale/分辨率/sampler 边界、Index-TTS 禁用、Breeze 参考音频成对、DEFAULTS 无机器路径 |
| **密钥脱敏** | `redaction.test.mjs` 全部 8 条：值形抹除、掩码、环境变量名、嵌套 sanitize、URL 脱敏、GET 掩码、**上游 body 带 key 时错误消息不泄漏**、429 说明不自动重试 |
| **provider 切换互不覆盖** | `config-store.test.mjs`（掩码回传保留密钥）+ `image-nai.test.mjs`（同一 service 在 4.5 / V5 之间切换，两族预设互不出现）+ `schema.test.mjs`（两段独立存储） |
| **NAI V5/4.5 预设不串用** | `presets-resolution.test.mjs` 前 4 条 + `image-nai.test.mjs` 的 `V5 预设不会出现在 4.5 请求里`（断言实际请求体） |
| **默认关闭** | `defaults-off.test.mjs`：零配置下生图/语音均 `MEDIA_DISABLED` 且**零网络请求**；工具表只有 4 个、无 inspect/warm；识图恒拒绝 |
| **参数边界** | `resolution.test.mjs` 全部 5 条（对齐 64、可复现、越界报错、全画幅可用、非法输入）+ `schema.test.mjs` 参数边界 + `image-openai.test.mjs` 超长/超字节 |
| **原子保存** | `config-store.test.mjs`：无 `.tmp` 残留、POSIX 0600、`.bak` 备份、校验失败不写盘、损坏文件降级 |
| **错误映射** | `redaction.test.mjs`（401/429）+ 各 adapter 测试（409→BACKEND_BUSY、402→ENTITLEMENT、流内 error→UPSTREAM、HTML 200→UNSUPPORTED_TYPE） |
| **网络预算边界**（Lead 追加） | `net.test.mjs` 全部 8 条：**总 deadline 可配置**、跳转 2 次通过/第 3 次拦截、**恰好等于上限 vs 超一字节**、三档上限（响应体/图片/音频）、Content-Length 预检、协议与 metadata 地址白名单、连接失败映射、默认上限是明确数字 |
| **HTTP API 安全闸**（Lead 追加） | `http-api-page.test.mjs`：掩码 GET、保存+校验、**跨站 Origin 403**、`confirm:true` 闸、识图 GET/POST 恒拒绝、页面不泄密、405 语义 |
| **配置迁移** | `schema.test.mjs` 的迁移用例（旧生产配置 → 新结构；丢弃项进 `dropped[]`；旧密钥不读取；作者标识与个人画师串不迁移）+ `config-store.test.mjs` 的自动迁移用例 |
| **干净目录安装构建** | `scripts/verify-m5.mjs`（见 `M5-report.md`，17/17 通过） |
| **通道边界（交叉集成追加）** | `artifacts-path.test.mjs`：默认落在 `<dataDir>/workspace/media`、语音同理、可配置改目录（绝对/相对）、非法值被校验拒绝、目录重建、账本仍留 `<dataDir>/media` |

---

## 3. 测试数据来源（无二进制、无私人素材）

- 图片/音频/ZIP **全部在 `test/helpers.mjs` 里用代码合成**：`makePng`（合法 PNG 头 + IHDR）、`makeWav`（44 字节头 + 静音）、`makePcm`、`makeZip`（单条 deflate，带 CRC32，用于 NAI 的 ZIP 响应分支）。
- 仓库里 **0 个二进制媒体文件**；旧的 `test/fixtures/**.png` 已随旧测试一起删除。
- 旧的 `test/screen-real.test.mjs`、`delivery-real.test.mjs` 等“真实链路”测试被移除：它们依赖生产的 8139 协调器、投递通道与屏幕帧端口，属已废弃能力（对照表见交接报告）。

---

## 4. 从旧配置迁移（可执行路径）

```
旧 <生产>/home/media/config.json（schemaVersion:1）
        │  第一次 store.load()
        ▼
migrateLegacyConfig()
  ├─ 保留：image.model/steps/scale/size、image.style 的默认正负串 → presets['5']
  ├─ 保留：speech.backend → tts.providers['breeze-tts2']（去掉旧 /breeze 路径后缀）
  ├─ 丢弃：pythonPath / imagePipelineRoot / configPath / runtime(8139) / queue(HF) /
  │         presetsFile / emotionPresets / director / auto / screen / delivery /
  │         quotas / tagProvider / translatePrompt / generationFlow / allowRealGeneration
  └─ 输出：dropped[]（逐项原因）+ warnings[]（"音色需重填"、"旧密钥不读取"）
        │
        ▼
<dataDir>/media/config.json（schemaVersion:2）+ 同目录 .bak
```

要点：
1. **旧密钥不读取**（`apiKey` 一律清空，需用户重填）——避免把生产密钥随迁移写入新路径；
2. **`image.backend='novelai-pipeline-bridge'` 被明确标记 unsupported**，不会静默继续用 Python 桥；
3. **迁移前备份**：`save()` 覆盖前会把现有文件复制成 `config.json.bak`；`reset({keepSecrets:true})` 可回到默认值；
4. 回滚：删掉新配置即可（插件会以默认值加载），或把 `.bak` 复制回去。

---

## 5. 未验证的部分

- **未跑真实 API / 真实生成 / 真实投递**（`M5-report.md` §4 给出操作者手动步骤）。
- **未在真实 DSH 宿主里跑**（本模块只在假宿主里验证挂载与工具注册；宿主加载证据由 Lead 的 `npm run verify` 与桌面验收提供）。
- 未做压力/并发测试：Breeze 的单并发（409）只测了错误映射，没有测排队。
