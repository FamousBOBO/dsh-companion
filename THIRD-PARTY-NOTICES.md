# 第三方代码与外部参考

本仓库的原创代码以 [MIT](LICENSE) 分发。下面列出的第三方内容**保留其原始许可证**，
不因被本仓库合并而改为 MIT。每条尽量记全：来源、版本、许可证、本地改动性质。

如果你的项目要用到本仓库里的第三方文件，请以本表为准去遵守相应许可证。

---

## 直接随仓库分发的第三方代码

| 路径 | 包 | 版本 | 上游 | 许可证 | 本地改动 |
|---|---|---|---|---|---|
| `plugins/dsh-channel-qq/` | `@dsh-companion/channel-qq` | 套件 0.1.0（上游快照 2026-10-28） | [github.com/Aegink/dsh-channel-qq](https://github.com/Aegink/dsh-channel-qq) | **MIT**，`Copyright (c) 2026 dsh-channel-qq contributors`（该目录 `LICENSE` 随包保留） | 相对上游含 2 处 bug 补丁（`music/tools.ts` 删两处非法 `required: true`；`affection.ts` 加 `port <= 0` 守卫）＋套件侧发布化改造（构建输出统一、安全默认值、去个人化文案）。上游 tarball 快照无 commit id |
| `plugins/dsh-channel-qq/vendor/types/cordis/` | `@deepseek-ai/cordis` | 4.0.5 | DeepSeek Harness（`vendor/cordis`） | MIT（`vendor/types/cordis/LICENSE` 随包保留） | 无改动，仅作 TypeScript 类型声明；仅在 `tsconfig.json` 的 `paths` 里解析，运行时不 import |
| `plugins/dsh-channel-qq/vendor/types/dsh-llm/` | `@deepseek-ai/dsh-llm` | 0.2.1-rc.3 | DeepSeek Harness（`packages/llm/llm`） | MIT | 同上 |
| `plugins/dsh-channel-qq/vendor/types/dsh-attachment/` | `@deepseek-ai/dsh-attachment` | 0.2.1-rc.3 | DeepSeek Harness（`packages/attachment/attachment`） | MIT | 同上 |
| `sidecars/huawei-health-cn/python/client.py`、`const.py`、`huawei_login.py` | 华为健康云端读取实现 | 派生自上游快照（原冻结提交 `1ec3e412…`，该分支现已不可访问） | [github.com/and7ey/huawei_health](https://github.com/and7ey/huawei_health)（Home Assistant 自定义集成） | **MIT**，`Copyright (c) 2026 and7ey`（许可全文见 `sidecars/huawei-health-cn/UPSTREAM-LICENSE.txt`） | 本地派生版本，含已文档化适配 A1（路径解析）、A2（凭据脱敏），见 `PROTOCOL-FREEZE.md` §1.1 |

`sidecars/huawei-health-cn/python/huawei_dashboard.py` **不是第三方代码**：它由本项目自写（只读 HTTP 服务端，`GET /api/data`），按 MIT 分发；上游没有这个文件。

> 说明：`vendor/types/*` 只提供 `.d.ts` 类型信息，用于在没有 DSH 源码树的机器上编译
> QQ 通道插件。它们不参与运行时，也不重分发任何可执行代码。
>
> **华为健康那一行是怎么核实的（2026-11-05）**：GitHub API 返回该仓库
> `license.spdx_id = "MIT"`，并取回许可全文随包保留。原冻结提交 `1ec3e412…` 与分支
> `cn-hosts-default` 已 404，因此**无法再对那个提交做逐字节复核**；上游当前 `main` 只含
> `client.py` / `const.py`（且与本地快照大小不同），说明本地是**派生版本**而非逐字节副本。
> 按 MIT 条款，派生分发必须保留版权与许可全文——这正是本表与 `UPSTREAM-LICENSE.txt` 的作用。

## 未随仓库分发（以及原因）

| 内容 | 上游 | 为什么不分发 |
|---|---|---|
| `dsh-super-injector`（超级注入器，`package.json` 里声明 BSD-3-Clause） | `github.com/yjh051108/dsh-super-injector` | ① 该仓库**没有任何 LICENSE 文件**，GitHub API 也返回 `license: null`（无法识别许可）；BSD-3-Clause 要求随分发保留版权声明与许可全文，而声明出自 `package.json`、正文与版权行都缺失，**无法满足署名条款**（没有许可文本时默认保留所有权利）；② 它的构建需要 `DSH_CHECKOUT` 指向 DSH 源码检出，只有桌面版的环境无法构建，也就无法验证。两条都不满足发布门槛，故不收录 |
| Index-TTS 的模型与推理服务 | `github.com/index-tts/index-tts` | 该仓库的许可证是 **bilibili Model Use License Agreement**（自定义模型使用协议，非开源许可），且本套件**不分发模型权重**，只调用外部服务。它不是"某个开源 TTS 的 HTTP API"，因此这里登记的是「我们不做它的 adapter」的理由，见下 |

### Index-TTS 为什么标「尚未接入」（2026-11-05 核实）

- 上游许可 = **bilibili Model Use License Agreement**（`LICENSE` 首行即为此协议，GitHub API
  `license.spdx_id = "NOASSERTION"`）。它约束模型使用，**不是**可自由实现的协议规范。
- 上游**没有**文档化的 HTTP JSON 合成接口：仓库里的可交互面只有 `webui.py`（Gradio，55 KB）、
  Triton 后端 `backends/trt/serving/triton_server.py`，以及一个内部 `openvoice/api.py`。
  没有可核实的「请求字段 / 响应格式 / 鉴权」契约。
- 因此本套件不实现 Index-TTS adapter，也不猜它的 Gradio 内部协议——按项目纪律，
  证据不足的 adapter 必须停在「尚未接入」，不允许用「预留」冒充完成。

## 协议常量与外部服务

| 位置 | 内容 | 性质 |
|---|---|---|
| `plugins/dsh-channel-qq/src/adapters/providers/tts/edge.ts` | `TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'` | Microsoft Edge「大声朗读」的**公开客户端常量**（`edge-tts` 等开源项目通用），用于 `Sec-MS-GEC` 计算与 WebSocket URL 参数。**不是账号凭据，也不是本项目的密钥**；删除后 Edge TTS 无法使用，故保留并在此声明来源性质 |
| `plugins/companion-media/` | NovelAI 中转站专属参数的字段映射 | 仅参考 `woakato/astrbot_plugin_nai_image` 的**协议字段**做核实与映射；未复制其账号系统、图片归档或代理转售功能，未引入其代码 |
| `plugins/dsh-channel-qq/assets/model-context.json` | 模型能力上下文快照 | 来源于公开的 models.dev 数据，不含个人信息 |

## 外部依赖（不随仓库分发，由用户自行安装或部署）

本仓库的 `package.json` 依赖（如 `typescript`、`tsdown`、`ws`、`zod` 等）按各自的
开源许可证从 npm 安装；`sidecars/` 下的 Python 依赖见各自 `requirements.txt`。
被调用的外部服务（NapCat/OneBot、TTS 服务、生图服务、华为健康接口）由用户自行部署并
遵守其各自的服务条款。

---

## 待补充（发布前必须清零）

以下条目的来源/许可证信息还在收集中，**在补齐之前不得把对应模块描述为「第三方信息已核实」**：

- [ ] `plugins/companion-media` 五种 TTS（Breeze TTS 2 / GPT-SoVITS / Drama3 / Index-TTS /
      Fish Audio）各自的官方仓库、版本、许可证与核实日期 —— 见 `docs/media/M0-report.md`
- [ ] `plugins/companion-media` NAI 官方与中转两套协议的服务条款要点
- [ ] `sidecars/ble-heart-rate` 依赖 `bleak`（MIT）之外的资源来源
- [ ] `plugins/dsh-paste-search` 的图标与静态资源来源或授权
- [ ] 各插件 `locale/`、`icon.svg` 等展示资源是否为原创（非原创需登记许可）

已确认无需登记：`plugins/companion-media` 的测试图片/音频全部由代码合成，仓库内没有二进制媒体素材。
