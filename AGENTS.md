# AGENTS.md — 给「接手这个仓库的 DSH」的部署指令

你正在看的是 **DSH Companion** 的仓库。这是一套跑在 **DeepSeek Harness** 上的陪伴套件：
人格与身份、长期记忆、认知运行时、日程、陪伴空间 Web UI，另有可选扩展（QQ 私聊/群聊、
主动联系、B站、健康与 BLE 心率、媒体生图与 TTS）。

**这个仓库不包含 DSH 宿主、不包含模型、不包含安装器。** 用户的机器上必须已经装有
DeepSeek Harness 桌面版。你的任务是：按文档检查环境 → 安装依赖 → 构建 → 初始化 →
诊断 → 启动 → 验证。

---

## 你的执行顺序（不要跳步、不要改顺序）

侧栏的 QQ 连接支持 NapCat / SnowLuma。配置这一项时，先询问用户要使用哪个页面及其地址，
得到回答后再写入本地 `data/home/companion/studio.webpanels.json`。
不要根据探测到的端口自动替用户选择；此文件属于本地配置，不得提交到 Git。

```bash
# 0. 先读文档，再动手
#    docs/01-deployment.md      部署流程与每个平台/路径形态的注意事项
#    docs/03-modules-support-matrix.md  哪些模块当前真的可用、哪些只是合同
#    docs/07-verification-status.md     证据分级（别把没验证的当验证过）

# 1. 装依赖（只装开发与构建依赖，按锁文件）
npm ci

# 2. 构建（仓库只存源码；不跑这一步，插件的入口文件不存在）
npm run build

# 3. 只读诊断（先诊断，再改动任何东西）
npm run doctor

# 4. 初始化本地目录、配置模板与独立 profile
#    已存在的配置一律不会被覆盖
npm run setup

# 5. 启动本套件自己的 DSH 环境
npm run start

# 6. 发布要求的离线检查与测试
npm run verify
```

`npm run doctor` 的输出是**后续决策的依据**：它报告宿主位置与版本、配置是否合法、
profile 能否合成、每个模块的入口是否存在、外部服务是否已配置。

---

## 硬性规则

1. **不得覆盖用户已有配置。** `config/suite.json`、`config/persona.md`、`data/` 下任何已有
   文件都视为用户资产。`npm run setup` 遇到已存在的文件只会跳过并说明。
2. **不得自动打开「花钱」或「对外发送」的能力。** 自动外发、自动评论、后台模型任务、
   健康采集、任何计费 API 调用默认全部关闭。只有用户在 `config/suite.json` 里显式打开，
   或明确要求你打开，才可以启用。
3. **不得把「配置已保存」说成「连接成功」。** 状态必须区分：未配置 / 已保存未测试 /
   测试成功 / 测试失败 / 功能关闭。
4. **不得把离线测试通过说成端到端可用。** QQ 真实发送、B站真实发送、计费 API、华为账号
   登录、BLE 连接都只能由操作者显式触发；`docs/07-verification-status.md` 里写明每一项
   证据到了哪一级。
5. **不得读取或上传用户的私密数据。** 记忆库、聊天历史、健康快照、媒体产物都在
   `data/`（已 gitignore），不属于仓库内容，也不要为了「诊断」把它们发到别处。
6. **外部服务由用户自己部署。** NapCat/OneBot、健康 sidecar、TTS 服务、生图服务都是外部
   依赖；本套件默认只连接已配置好的地址，不自动安装或启动。用户明确要求管理本机 NapCat / SnowLuma 时，可以写入忽略目录中的启动配置，并由「启动 / 重启」按钮显式操作。

---

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **>= 24.0.0**（记忆与运行时使用 `node:sqlite`，Node 20 没有、Node 22 需实验开关） |
| npm | >= 10 |
| DSH 宿主 | DeepSeek Harness 桌面版，已验证基线 `0.2.1-rc.3` |
| 平台 | Windows 为实机验收平台；Linux/macOS 由 CI 验证构建与离线测试 |

宿主位置默认自动探测。探测不到或装在非标准位置时，在 `config/suite.json` 里写
`dsh.executable` 与 `dsh.moduleRoot`。

---

## 数据在哪里

- 仓库目录只放**源码与模板**。
- 运行期数据全部落在 `<套件根>/data/`（`home/`、`workspace/`、`group-workspace/`、
  `desktop-data/`、`logs/`、`tmp/`、`backups/`），可以改 `config/suite.json` 的 `dataDir`
  指到别处。
- 本机配置：`config/suite.json`（套件级）、`config/persona.md`（人格）、各模块自己的配置
  在 `<dataDir>/` 下。**这些都不入库。**

---

## 出问题了怎么办

按顺序看：

1. `npm run doctor` —— 它通常会直接指出坏在哪一层。
2. `docs/06-troubleshooting.md` —— 按症状查。
3. `<dataDir>/logs/` —— 启动日志（`npm run start` 会把本次输出写到那里，失败时路径会打印出来）。

---

## 可选：个人数据迁移

从另一台机器或本机的旧部署搬运行记忆与日程，是**显式、独立**的流程，不属于部署：

```bash
npm run migrate -- export --out <目录>
npm run migrate -- check  --from <目录>
npm run migrate -- import --from <目录> --dry-run
npm run migrate -- import --from <目录> --identity adopt
```

详见 `docs/04-migration.md`。迁移默认排除凭据、登录缓存与媒体产物；导入后必须重新绑定
路径、授权与设备，且**不会重放**旧提醒或补发历史消息。
