# 生产测试线合入收尾审阅（2026-11-12）

Codex 在 DSH 交接之后独立执行只读核验与专项测试。本文区分本轮实测与交接证据，不替代真实生图或发送验收。

## 本轮实测

- 目标 `C:/Users/bobo/Documents/Bot/dsh-production`，分支 main，审阅基线 d20cf1a。`git merge-base --is-ancestor 854ff28 HEAD` 退出 0：完整集成历史已进入目标，没有退回仅 cherry-pick 最后验收提交的状态。后续表情线提交仍在。
- `git diff --check` 退出 0；docs/07 无行首 Git 冲突标记。
- supervisor 69520 与宿主 39944 均存活，启动时间为北京时间 14:31；foundation 挂载记录 pid 与宿主一致。此证据证明实例存活和模块挂载，不能单独证明所有源码已按预期执行。
- 北京时间 15:25 复跑 `node dsh-ops/check-production.mjs`：三个端点 HTTP 200，authenticated/ok/pluginActivationClean 均为 true。此健康判定只覆盖指定核心挂载与三个端点，不能解释成所有插件、模型和外部服务正常。
- `node --test plugins/companion-media/test/data-root.test.mjs plugins/companion-media/test/visual-identity-gate.test.mjs plugins/companion-media/test/image-nai.test.mjs`：36 passed、0 failed、0 skipped。覆盖数据根、视觉身份前置拒绝、身份与衣物注入、具体 seed、NAI 请求与错误处理；使用测试临时目录与模拟网络，不是真实付费 API。
- 两个运维 JS 文件 `node --check` 通过；production.ps1 的 PowerShell AST 解析错误数为 0。审阅现存三文件差异后原样保留，未将既有本地改动混入此次报告提交。
- 新恢复点目录存在，包含 source-tree/config/data-consistent/data-files 与未提交补丁；旧备份未操作。本轮未重新检验全部备份内容或恢复可用性。

## 生图原始报错

本轮仅提取媒体账本的状态、时间与错误码/错误信息，不输出 prompt、会话、凭据或媒体。共 22 个 image 作业：16 succeeded、6 failed。最近一笔为北京时间 2026-11-12 01:26 成功；最新失败为 2026-11-07 的 MEDIA_NETWORK（fetch failed），还有 2026-11-06 的 MEDIA_UPSTREAM/HTTP 500。账本没有与本次反馈相匹配的新失败，因此本次报错根因仍未确定；请求前拒绝和后续发送错误也未必进入媒体生成账本。不能将“修复已合入”表述为“本次报错已修复”。

## 交接证据与边界

DSH 交接报告给出：93a9037 正常合并、4f091cf doctor 查询串修复、完整构建和根 verify、模块 mock 生图、重启与预设 RPC 核验。本轮通过历史、进程、健康检查与媒体测试交叉核实部分结果，没有重复执行安装、构建、重启和全量测试。

真实宿主会话加回环模型尚未验证；真实生图、TTS、QQ/B站发送未验证。本轮不改变生产开关、profile、私人身份与衣柜，不发起模型请求或付费调用。

## DSH 工具链故障单独保留

历史截图包含两类基础故障：拼接 JSON 参数导致 MALFORMED_RESPONSE，以及自动审查 HTTP 500/503/workspace_billing_scope_unavailable。另有明确的策略拒绝，不能混为同一故障。本地宿主 dsh-llm-pi-ai 的 toStreamChunks 在 argumentsError 时抛 MALFORMED_RESPONSE，确认错误分类，但不足以判断拼接产生于模型、provider 还是组装层。没有原始脱敏流式分片复现，宿主故障尚未修复。

后续最小诊断须在隔离会话中串行运行单工具，以调用 ID 区分参数流；使用合成输入，禁止自动拆开非法 JSON 后执行，禁止通过换工具绕过审查。审查服务异常应保留脱敏请求 ID/时间用于服务排查，不能无限重试或当成业务失败。本轮未修改 node_modules、审查模式或权限。

## 回滚约束

禁止直接照抄旧交接的 `reset --hard 18ae9c6`：它会移除当前分支后续集成及表情提交，并覆盖已跟踪本地修改。若实际需要回滚，应先记录当时 HEAD 与工作树、保存本地运维补丁，并审阅受影响的后续提交，选择针对性的 revert 或隔离恢复。旧数据库快照不能无条件覆盖已有新数据；须先备份当前数据，确认兼容性与恢复范围。本文不执行回滚。

结论：合入交付及当前实例健康复核完成；本次生图原始报错和 DSH 工具链故障保持未解决，不以文档收尾声称已修好。

## 表情功能生产验收补记（北京时间 16:29）

用户要求将表情成果全部部署到当前生产。核对 main、dsh-dev/expression-sticker-chain、expression-retrieval-fit 与 expressions：已提交的表情链路均已在 main 中；expressions 独有历史提交 1c5007e 经 `git cherry main expressions` 标为 `-`（等价补丁已包含），无需重复应用。

- 当前实例已加载表情发送器、5 个工具与管理路由，本次启动段有明确接线日志。modules.expression、表情配置 enabled 与 delivery.enabled 均为 true，本轮未改开关。
- QQ 构建产物时间 14:31:02，晚于 d20cf1a 的私聊表情工作流修复提交 14:30:52，早于当前实例启动 14:31:05。表情本体是直接加载的 MJS。未发现需要补建或重启的新代码。
- 表情模块全量测试：228 passed、0 failed、0 skipped。生产健康检查再次通过。
- 对运行实例认证后的只读请求 `/api/companion-expression/config`、`/api/companion-expression/assets?limit=1` 均 HTTP 200 且 ok=true；未输出图库内容。此证据覆盖管理接口与图库接入，不证明 QQ 实际送达。
- retrieval worktree 有尚未提交的 analyzer/ingest、synonyms 与 fixture 工作，属另一条正在修改的检索任务，未将不完整工作复制进生产，也未修改该 worktree。
- 本次“推入生产”指本机生产部署，未向 Git 远端 push，未额外真实发送消息。已提交的表情成果当前已部署生效，生产数据与备份保留。

## 检索分支最终收尾（北京时间 21:06）

DSH 后续完成了检索改动但在文档 edit 参数拼接处失败。Codex 补齐两处 poolLimit 文档，修复 compare 输出的字符串拼接及文档作者路径卫生问题，完成提交 a183795，正常合入生产为 1e6efb0。原生产新增 935b383（Light 生图预设）保留。前节“未提交检索工作”描述为此前状态，现已完成交付。

- 分支构建成功，unit 9 模块通过，表情专项 247/247 通过；static 首次因文档作者绝对路径失败，清理后复跑 39/39。隔离 worktree compose 因没有宿主配置而跳过，不算通过。合成语料前后对照命令退出 0。
- 生产 doctor 核心通过；生产构建成功。表情库通过 node:sqlite backup 一致性备份到 `data/backups/expression-retrieval-predeploy-1794488689052/`，integrity_check=ok，同时备份表情配置。
- 仅重启指定生产实例：supervisor 66624 / host 52760，启动于北京时间 21:06:24；健康检查三个端点 200，核心挂载通过。
- 新启动日志确认发送器接线；FTS 新标签索引重建 393 行，数据库只读核验 meta.fts_label_index=labels-v2。
- 运行实例配置 API 返回 HTTP 200/ok=true，poolLimit=60，原 minFitScore=0.5 保留。没有改生产投递开关、人格或阈值，没有测试发送或计费调用。
- 历史 docs/19 的“未部署”描述是开发交付时状态，由本节补充实际部署证据。生产真实素材检索质量、真实 QQ 送达仍未验证；DSH 的参数拼接及审查服务故障未在本次修复。
