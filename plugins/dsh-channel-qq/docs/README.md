# 文档

本目录只放**给使用者/维护者**读的说明。部署、升级、故障排查这些套件级内容在套件根的
`docs/` 下（`../docs/01-deployment.md`、`02-configuration.md`、`06-troubleshooting.md`…）。

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 分层、消息旅程、关键决定、往哪里加东西 |
| [configuration.md](configuration.md) | 配置三层覆盖、生效方式、环境变量、最小可用配置 |
| [memory.md](memory.md) | 记忆系统：组成、夜间任务、如何打开、评测与已知限制 |
| [memory-standalone.md](memory-standalone.md) | 不带 v2 的独立记忆（`standalone-memory`） |
| [knowledge-base.md](knowledge-base.md) | 知识库：摄取、分块、带出处检索、集合可见范围、评测 |
| [adaptive-followup.md](adaptive-followup.md) | 自主跟进复核（默认关）：判据与开关 |

根目录另有 [README](../README.md)、[BUILD](../BUILD.md)（构建与上游来源）、
[SECURITY](../SECURITY.md)、[CONTRIBUTING](../CONTRIBUTING.md)、[CHANGELOG](../CHANGELOG.md)。
