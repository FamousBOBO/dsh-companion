# 第三方代码与外部参考

本仓库的原创代码以 [MIT](LICENSE) 分发。下面列出的第三方内容**保留其原始许可证**，
不因被本仓库合并而改为 MIT。每条尽量记全：来源、版本、许可证、本地改动性质。

如果你的项目要用到本仓库里的第三方文件，请以本表为准去遵守相应许可证。

---

## 直接随仓库分发的第三方代码

| 路径 | 包 | 版本 | 上游 | 许可证 | 本地改动 |
|---|---|---|---|---|---|
| `plugins/dsh-channel-qq/vendor/types/cordis/` | `@deepseek-ai/cordis` | 4.0.5 | DeepSeek Harness（`vendor/cordis`） | MIT（`vendor/types/cordis/LICENSE` 随包保留） | 无改动，仅作 TypeScript 类型声明；仅在 `tsconfig.json` 的 `paths` 里解析，运行时不打包 |
| `plugins/dsh-channel-qq/vendor/types/dsh-llm/` | `@deepseek-ai/dsh-llm` | 0.2.1-rc.3 | DeepSeek Harness（`packages/llm/llm`） | MIT | 同上 |
| `plugins/dsh-channel-qq/vendor/types/dsh-attachment/` | `@deepseek-ai/dsh-attachment` | 0.2.1-rc.3 | DeepSeek Harness（`packages/attachment/attachment`） | MIT | 同上 |
| `plugins/dsh-super-injector/` | `@dsh-external/dsh-super-injector` | 0.3.6（本地版本） | 见该目录 `LICENSE` / `CHANGELOG.md` | **BSD-3-Clause**（随包保留） | 本地适配改动记录在该目录 `CHANGELOG.md`；本仓库不把它的许可证改为 MIT |

> 说明：`vendor/types/*` 只提供 `.d.ts` 类型信息，用于在没有 DSH 源码树的机器上编译
> QQ 通道插件。它们不参与运行时，也不重分发任何可执行代码。

## 协议常量与外部服务

| 位置 | 内容 | 性质 |
|---|---|---|
| `plugins/dsh-channel-qq/src/adapters/providers/tts/edge.ts` | Edge TTS 的 WebSocket 常量（业界公开的固定值，非账号凭据） | 调用微软公开 TTS 服务所需的协议常量，不是本项目的密钥；不随仓库分发任何账号凭据 |
| `plugins/companion-media/` | NovelAI 中转站专属参数的字段映射 | 仅参考 `woakato/astrbot_plugin_nai_image` 的**协议字段**做核实与映射；未复制其账号系统、图片归档或代理转售功能，未引入其代码 |

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
- [ ] `plugins/companion-health` 与 `sidecars/huawei-health-cn` 是否引入了上游协议实现
- [ ] `plugins/dsh-paste-search` 的图标与静态资源来源或授权
- [ ] 各插件 `locale/`、`icon.svg` 等展示资源是否为原创（非原创需登记许可）
