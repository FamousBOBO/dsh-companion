# DSH Companion

跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的**陪伴套件**：
给一个 AI 助手装上稳定的人格、会积累的长期记忆、会自己安排日程的认知运行时，以及一个能看
能查的陪伴空间 Web UI。QQ / B站 / 健康 / 媒体是可选扩展，默认关闭。

这不是「一个提示词」项目。它是一组 DSH 插件 + 一套部署与诊断命令，目标是：**你把仓库交给
自己的 DSH，它照着文档就能装起来并验证。**

> 🔒 默认安全：所有能对外发送、能花额度、能采集健康数据的能力，装好之后**全部是关的**。
> 你显式打开之前，它不会主动联系任何人、不会产生计费请求、不会读你的健康数据。

---

## 里面有什么

### 核心（装好即用）

| 模块 | 作用 |
|---|---|
| `companion-foundation` | 人格与身份、工具面、服务桥、认知挂载 |
| `companion-memory` | 长期记忆引擎（SQLite + FTS；可选向量与重排） |
| `companion-runtime` | 认知运行时：日程、活动、注意力与预算 |
| `companion-memory-studio` | 陪伴空间 Web UI（首页 / 生活与日程 / 记忆与档案 / 连接与工具 / 设置与诊断） |
| `companion-group` | 群聊作用域与边界（群内独立会话、不混入私聊记忆） |

> 这五个模块之间存在同目录兄弟引用，必须**成套安装**，无法单独取用某一个包。

### 可选扩展（默认关闭）

| 模块 | 作用 | 默认 |
|---|---|---|
| `dsh-channel-qq` | QQ 私聊 / 群聊通道、提醒、主动联系 | 关 |
| `companion-health` + `sidecars/` | 华为健康 / BLE 心率采集与只读查询 | 关 |
| `companion-media` | 生图（OpenAI-compatible / NovelAI）、五种 TTS、识图合同 | 关 |
| `dsh-paste-search` | 左侧栏搜图入口 | 关 |

### 本版**未收录**的模块（以及原因）

| 模块 | 为什么没有 | 你能做什么 |
|---|---|---|
| `dsh-super-injector`（超级注入器） | 两个硬阻塞：① 它的构建需要一份 **DSH 源码检出**（`DSH_CHECKOUT`），只装桌面版的环境永远构建不出来；② 仓库里**没有上游的 `LICENSE` 文本**，而它是 BSD-3-Clause，该许可证要求随分发保留版权声明与许可全文。缺任一条都不该发 | 从上游仓库自行获取并按其许可证使用 |
| `sidecars/huawei-health-cn` 的上游协议实现 | 该 sidecar 依赖一份来自上游项目 `and7ey/huawei_health` 的代码，**上游许可证未能核实**；许可不明不等于可以当成 MIT 分发 | sidecar 只带本项目自写的采集/脱敏/起停/测试代码，运行时用 `$HUAWEI_UPSTREAM_PKG` 指向你自己的上游检出 |

> 健康模块的 **BLE 心率**通道不受影响（全部是原创代码）；受影响的只有华为健康的云端数据通道。

各模块当前**真到什么程度**，看 [`docs/03-modules-support-matrix.md`](docs/03-modules-support-matrix.md)
与 [`docs/07-verification-status.md`](docs/07-verification-status.md)。那份表区分「离线测试通过」
「宿主加载成功」「真实 API 调通」「真实平台发送成功」「硬件实测」——请不要把它们混为一谈。

---

## 快速开始

前置：Node.js **>= 24**（`node:sqlite` 的硬性要求）、已安装的 DeepSeek Harness 桌面版。

```bash
npm ci            # 按锁文件装开发与构建依赖
npm run build     # 构建（仓库只存源码，入口文件由构建产生）
npm run doctor    # 只读诊断：宿主、配置、模块、外部服务
npm run setup     # 初始化 data/、配置模板与独立 profile（不覆盖已有配置）
npm run start     # 启动本套件的 DSH 环境
npm run verify    # 离线检查与测试
```

详细的每一步、每个平台的注意事项、失败怎么办：**[`docs/01-deployment.md`](docs/01-deployment.md)**。
如果你是把仓库交给自己的 DSH 来部署，让它先读 [`AGENTS.md`](AGENTS.md)。

---

## 配置

- `config/suite.json`：套件级配置（启用哪些模块、宿主位置、数据目录、外部服务地址）。
  从 `config/suite.example.json` 复制，**不入库**。
- `config/persona.md`：你的陪伴对象叫什么、什么性格、什么边界。从
  `config/persona.example.md` 复制，**不入库**。仓库自带的默认人格是中性模板，不含任何
  原作者的个人设定。
- 各模块自己的配置在 `<dataDir>/` 下，由各模块负责。

密钥只放环境变量或 `.env.local`（已 gitignore）。套件不会在任何 API、日志或错误信息里
回传密钥明文。

---

## 数据

运行期数据默认在 `data/`，与源码位置解耦、可迁移：

```
data/
  home/            # DSH_HOME（profile、会话、各模块状态库）
  workspace/       # 人格文件与工作区
  group-workspace/ # 群聊独立工作区
  desktop-data/    # 桌面端用户数据
  logs/  tmp/  backups/
```

`data/` 已 gitignore。个人数据迁移是独立流程，见 [`docs/04-migration.md`](docs/04-migration.md)。

---

## 许可

原创代码 [MIT](LICENSE)。仓库内包含的第三方代码保留其原始许可证，来源、版本与本地改动
记录在 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

## 关于本仓库的诚实说明

- 首版**不包含** MC 联动、实时语音通话，以及尚未打通的实验入口。
- 首版**不包含** `dsh-super-injector`（需要 DSH 源码检出 + 缺上游 LICENSE 文本）与华为健康 sidecar 的上游协议实现（上游许可证未核实）。原因与替代做法见上表。
- 媒体能力里，只有协议核实完成并可验证的 adapter 才允许从「预留」变为「可启用」；其余在 UI 上标记「尚未接入」。识图保留合同但默认关闭。
- Windows 是实机验收平台；Linux/macOS 只有 CI 的构建与离线测试证据，**不等于**桌面或硬件
  实测。
- 外部服务（NapCat、健康 sidecar、TTS/生图服务）需要你自己部署，本套件只负责连接。
- 具体每一项能力验证到了哪一级（离线测试 / 宿主加载 / 真实 API / 真实平台发送 / 真机硬件），
  见 [`docs/07-verification-status.md`](docs/07-verification-status.md)。**没到就是没到。**
