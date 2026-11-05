# tools/migrate — 迁移 CLI 实现

契约正文在 [`docs/04-migration.md`](../../docs/04-migration.md)。本文件只讲代码结构与维护须知。

## 入口

```bash
npm run migrate -- export [--out <目录>] [--domains …]
npm run migrate -- check  --from <目录>
npm run migrate -- import --from <目录> [--identity adopt|quarantine] [--dry-run]
node tools/migrate/cli.mjs <同上>          # 直接跑，绕过 npm 的参数转发
```

`scripts/migrate.mjs` 是三行薄壳：

```js
#!/usr/bin/env node
import { runMigrateCli } from '../tools/migrate/cli.mjs';
process.exitCode = await runMigrateCli(process.argv.slice(2));
```

`runMigrateCli(argv, io?) → Promise<number>`；`io` 可注入 `stdout` / `stderr` / `env`（测试用）。

## 文件职责

| 文件 | 职责 | 不该做的事 |
|---|---|---|
| `cli.mjs` | 参数解析、分发、stdout JSON、退出码、`help` | 不读业务数据 |
| `context.mjs` | 解析套件根 / 数据目录 / persona id / 去重检测「宿主是否在写」 | 不写文件 |
| `domains.mjs` | 域清单、禁止域、脱敏 transform、包内路径 → 目标路径 | 不做 IO |
| `bundle.mjs` | 布局常量、sha256、原子写 JSON、路径工具 | 不知道业务语义 |
| `sqlite.mjs` | 只读探针、`VACUUM INTO` 快照、persona 列改写、WAL 新鲜度 | 不碰迁移包内的库（只读） |
| `export.mjs` | 装配迁移包（先 `.partial-<pid>` 再 rename） | 不解析目标机器状态 |
| `check.mjs` | 七项校验 + 计划（`plan`） | **绝不写任何文件** |
| `import.mjs` | 备份 → 替换 → 重写 persona → 报告 | 不联网、不启动宿主、不发消息 |
| `test/migrate.test.mjs` | 10 项离线测试（自建临时数据目录） | 不写真实数据目录 |

## 三条不变式

1. **token 不进包**：`domains.mjs` 的 `FORBIDDEN_DOMAINS` 是唯一真相；`validateDomains` 在参数阶段就拒绝，
   不给实现层「顺手支持一下」的机会。
2. **先备份再动数据**：`import.mjs` 里备份失败直接 `exit 1`，一个字节都不写。
3. **只改副本**：`rewritePersonaId()` / `softenHealthConsents()` 只作用于**目标**文件，
   迁移包永远只读。

## 测试

```bash
node --test tools/migrate/test/migrate.test.mjs
```

测试用 `DSH_COMPANION_DATA_DIR` 指向 `os.tmpdir()` 下的临时目录（`before` 建、`after` 删），
不碰真实数据。若 `node:sqlite` 不可用，涉及数据库的断言会自动跳过（`sqliteAvailable`）。

覆盖：参数解析、禁止域拒绝、脱敏（会话绑定 / 消息正文）、完整性校验、篡改检测、
`--dry-run` 不写盘、导入先备份、persona id 映射、提醒置 `fired+paused`、宿主占用拒绝、
WAL 新鲜判活、`help` 输出。

## 加一个新域时

1. 在 `DOMAIN_SPECS` 加条目（`from` 相对数据目录、`to` 相对包根、`kind`、是否 `required`）；
2. 若要脱敏，在 `applyTransform` 加一个分支，并**说明删了什么**（会进 `redactions[]`）；
3. 若要能导入，在 `IMPORT_TARGETS` / `IMPORT_TARGET_PREFIXES` 加落点，并加入 `IMPORTABLE_DOMAINS`；
4. 只归档不导入的，放进 `ARCHIVE_ONLY_DOMAINS`；
5. 在 `test/migrate.test.mjs` 补一条断言；
6. 同步更新 `docs/04-migration.md` §4 / §7 —— **文档与实现不一致时以文档为准并改代码**。
