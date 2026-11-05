# dsh-companion-memory（记忆引擎）

bot陪伴基座的**长期记忆引擎**：本地 SQLite（`home/memory/companion-memory.db`）+ FTS5 中文检索 + 向量/重排通道 + 自动提炼 + Wiki 编译。它是一个**库模块**，不单独注册成 Cordis 插件行；由 `companion-foundation`（对话侧：注入、`companion_*` 工具）和 `companion-memory-studio`（侧栏「记忆档案」的管理 API）共同 `import`，进程内共享同一个引擎实例。

- 版本：`0.4.0`；数据库 schema：**v2**；Node ≥ 22.5（用内置 `node:sqlite`，无第三方依赖）
- 完整手册：[docs/MEMORY.md](docs/MEMORY.md)　设计契约：[CONTRACT.md](CONTRACT.md)

## 目录

| 路径 | 作用 |
| --- | --- |
| `index.mjs` | 引擎门面：`createMemoryEngine()`、共享实例 `shareEngine/sharedEngineFor/releaseSharedEngine`、对外方法与 `internal()` 句柄 |
| `config.mjs` | 配置加载/归一化、密钥文件合并、`DEFAULT_CONFIG` |
| `lib/db.mjs` | SQLite 访问、`MIGRATIONS`/`migrateSchema`、记忆与事件写入、向量表 |
| `lib/retrieve.mjs` | 召回：FTS5(bigram) + 向量 → RRF → 重排 → MMR → 字符预算 |
| `lib/render.mjs` | 注入文本与 `companion_recall` 结构化结果（时间统一 `YYYY-MM-DD HH:mm`） |
| `lib/capture.mjs` | 会话消息捕获（作为证据，不等于事实） |
| `lib/extract.mjs`、`lib/jobs.mjs` | 自动提炼：批处理、prompt、候选落库 |
| `lib/embed.mjs`、`lib/rerank.mjs` | 向量（本地 hash / 远端 OpenAI 兼容）与重排（远端） |
| `lib/import.mjs` | 旧 AstrBot 快照导入（含对账、备份清单） |
| `lib/wiki.mjs` | Wiki 页编译（`home/memory/wiki/`） |
| `lib/text.mjs` | 文本归一、密钥脱敏、时间解析/格式化（固定 Asia/Shanghai） |
| `lib/schema.sql` | 冻结 DDL（全部 `IF NOT EXISTS`） |
| `test/` | 单元/集成测试（临时目录，不碰生产库） |
| `scripts/migrate-memory.mjs` | 旧快照导入 CLI |

## 最小用法

```js
import { createMemoryEngine, sharedEngineFor, shareEngine } from './index.mjs';

// 一个进程只建一个引擎；其它模块用共享实例，避免两条写连接。
const engine = sharedEngineFor(root) ?? shareEngine(root, createMemoryEngine({ root, identity, env: process.env }));
await engine.initialize();

const text = await engine.contextFor({ sessionId, query });       // 每轮自动注入的记忆文本
const hits = await engine.recall({ sessionId, query, limit: 8 }); // companion_recall
const receipt = await engine.remember({ sessionId, key, value, occurredAt: '2026-10-28 14:38' });
await engine.close();
```

> `root` 是仓库根（含 `home/`）。`identity` 提供 owner；`viewer` 一律由 owner 解析，不接受调用方传入的 userId。
>
> 多个消费方（`companion-foundation`、`companion-memory-studio`）必须 **import 同一个模块说明符**（包括 `?v=0.4.0` 这类查询串）；说明符不一致会各自建出引擎，两条写连接同时写同一个库。

## 配置与文件

| 文件 | 内容 |
| --- | --- |
| `home/companion/memory.config.json` | 全部可调配置：`backend`、`injection`、`retrieval`、`extraction`、`embedding`、`rerank`、`wiki`、`limits` |
| `home/companion/remote-models.json` | **仅有 API Key**（`{schemaVersion, embedding:{apiKey}, rerank:{apiKey}}`，原子写、尽量 0600）；`memory.config.json` 里永远没有 key |
| `home/memory/companion-memory.db` | SQLite 主库（`-wal`/`-shm` 同目录） |
| `home/memory/wiki/` | 编译产物（Markdown） |
| `home/memory/backups/` | 导入/回填前的整库备份（`home/companion/backups/` 放配置与密钥文件的迁移备份） |

非法配置**不会阻塞启动**：回退默认并记 note；`backend` 只接受 `legacy`/`sqlite`。改完配置需**重启桌面**（引擎在挂载时读一次）。

## 对外能力（引擎方法）

`initialize` / `status` / `contextFor` / `recall` / `remember` / `capture` / `extractNow` / `pending` / `forget` / `wikiIndex` / `wikiGet` / `compileWiki` / `rebuildIndex` / `internal` / `close`。

对话侧的工具名（在 `companion-foundation` 注册）：
`companion_remember`（支持 `occurredAt`）、`companion_recall`、`companion_record_event`、`companion_recent_events`、`companion_memory_pending`、`companion_memory_forget`、`companion_memory_extract`、`companion_memory_rebuild`、`companion_wiki_index`、`companion_wiki_get`。

## 检索链路

1. FTS5 词法通道（中文按 bigram 切分）+ 向量通道（本地 `hash-bigram-256` 或远端 OpenAI 兼容 `/embeddings`）；
2. RRF 融合 →（启用时）远端正排 `rerank` → MMR 去冗余 → 字符预算（默认 2400）；
3. 过滤：非 `confirmed`、作用域不符、过期/未来、`coverageFloor=0.15` 以下一律不进候选；
4. **fail-open**：向量/重排失败只记 `semantic-degraded` / `rerank-unavailable`，绝不让一轮对话失败；远端降级时**不写**任何向量。

## 时间（发生时间）

- 每条记忆都有 `occurred_at`：`remember` 缺省＝现在；自动提炼取证据消息时间；导入保留原始时间。
- 展示统一 `YYYY-MM-DD HH:mm`（Asia/Shanghai，固定 `+08:00`，不随运行环境 TZ 漂移）；无法确定显示「未知」。
- 越界时间（13 月、25 点、2 月 30 日…）判为非法，返回空而不是静默进位。
- 旧记录回填：`node scripts/backfill-memory-time.mjs`（预演）/ `--apply`（先备份），**只依据来源证据**，没有证据就不补。

## 隐私与安全（硬约束）

- `mentionPolicy='avoid_unless_asked'` 的记录在注入里只有占位符，正文只在显式查看接口出现；日志只记固定 code，不记正文。
- `remember` 拒绝疑似密钥/密码内容；配置与接口从不回显 API Key（Studio 只回 `KeySet` 布尔）。
- 测试一律用临时目录/临时库副本，**不写生产库**。

## 测试与自检

```bash
node --test "test/*.test.mjs"          # 239 项（当前）
node --test ../../plugins/companion-foundation/*.test.mjs
node scripts/migrate-memory.mjs --dry-run   # 旧快照导入预演
```

仓库根还有只读体检脚本（不碰生产库）：`scripts/check-studio-api.mjs`、`scripts/verify-studio.mjs`、`plugins/companion-memory-studio/scripts/smoke-client.mjs`。

## 运维与排障

| 文件 | 用途 |
| --- | --- |
| `logs/memory-engine.jsonl` | 开库、迁移、提炼、向量补齐（`schema-migrated`、`embeddings-backfilled`） |
| `logs/memory-recall.jsonl` | 每轮召回的 explain（通道、过滤原因、耗时；不含正文） |
| `logs/memory-studio.jsonl` | 管理 API 注册与错误 |

常见现象：
- `backend` 一直是 legacy：`backend` 没改成 `sqlite`、库文件不可写，或旧库被更新版本写过（会明确报「版本不兼容」）。
- 语义召回没生效：`retrieval.semanticEnabled=false`、`embedding.provider=local`（本地哈希仍算语义通道）、远端降级，或向量还在后台补（看 `embeddings-backfilled`）。
- 改完配置没变化：重启桌面。
- 库被只读打开时不会自动迁移，`status().schema.outdated=true`，用一次可写启动即可升级。

## 文档索引

- [docs/MEMORY.md](docs/MEMORY.md)：完整使用手册（配置表、导入与对账、Studio API、§11.5 远端模型、§11.6 时间、§11.7 迁移、§11.8 已知语义）
- [CONTRACT.md](CONTRACT.md)：与对话侧/管理侧的接口契约
- `design/memory-time.md`、`design/remaining-issues.md`、`design/astrbot-memory-time.md`：时间语义、剩余问题决策、上游 AstrBot 对照
