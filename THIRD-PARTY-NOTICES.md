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

> 说明：`vendor/types/*` 只提供 `.d.ts` 类型信息，用于在没有 DSH 源码树的机器上编译
> QQ 通道插件。它们不参与运行时，也不重分发任何可执行代码。

## 未随仓库分发（以及原因）

发布前审查发现两处**许可证无法满足**的第三方内容，因此**整份移除**而不是含糊带过：

| 内容 | 上游 | 为什么不分发 |
|---|---|---|
| `dsh-super-injector`（超级注入器，BSD-3-Clause 声明） | `github.com/yjh051108/dsh-super-injector` | ① 仓库内**没有上游 `LICENSE` 文本**，BSD-3-Clause 要求随分发保留版权声明与许可全文；② 它的构建需要一份 **DSH 源码检出**（`DSH_CHECKOUT`），只有桌面版的环境无法构建，也就无法验证。缺任一条都不满足发布门槛，故不收录 |
| `sidecars/huawei-health-cn/python/{client,const,huawei_dashboard,huawei_login}.py` | `github.com/and7ey/huawei_health`（分支 `cn-hosts-default`，提交 `1ec3e412…`） | **上游许可证未核实**。许可不明不能默认当成 MIT 分发。sidecar 只保留本项目自写的采集/脱敏/起停/测试代码，运行时由 `$HUAWEI_UPSTREAM_PKG` 指向使用者自己的上游检出 |

如果将来取得上游许可并补齐 `LICENSE`，这两处都可以按本文件的表格补回。

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
