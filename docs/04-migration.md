# 04 · 个人数据迁移

> 迁移是**显式、独立、默认什么都不做**的流程：不部署、不启动、不联网、不外发。
> 本文既是给用户的操作手册，也是 CLI 的行为契约——实现与本文不一致时，**以本文为准并提 issue**。

实现：

| 文件 | 作用 |
|---|---|
| `scripts/migrate.mjs` | 三行薄壳：`runMigrateCli(process.argv.slice(2))` |
| `tools/migrate/cli.mjs` | 参数解析、分发、stdout JSON、退出码 |
| `tools/migrate/export.mjs` / `check.mjs` / `import.mjs` | 三个子命令 |
| `tools/migrate/domains.mjs` | 允许/禁止迁移的域清单（规则的可执行版本） |
| `tools/migrate/sqlite.mjs` | 只读探针、`VACUUM INTO` 快照、人格列改写 |
| `tools/migrate/test/migrate.test.mjs` | 离线测试（10 项） |

## 1. 什么时候用它

| 场景 | 用它吗 |
|---|---|
| 换机器 / 换盘符，想保留记忆与日程 | ✅ |
| 同一台机器上把 `dataDir` 搬到另一个位置 | ✅（也可以直接搬目录，但迁移会给一致快照 + 校验） |
| 只是升级套件版本 | ❌ 用 `docs/05-upgrade-rollback.md` |
| 想把数据分享给别人 | ❌ 迁移包含个人数据，不应外传 |
| 想「重置一切」 | ❌ 直接备份后重建 `data/`（`docs/01` §9） |

前提：**目标机器的套件已经部署好**（`npm ci && npm run build && npm run doctor && npm run setup`）。

## 2. 命令与退出码

```bash
npm run migrate -- export [--out <目录>] [--domains memory,runtime,identity,reminders,health,qq]
npm run migrate -- check  --from <迁移包目录>
npm run migrate -- import --from <迁移包目录> [--identity adopt|quarantine] [--yes] [--dry-run]
npm run migrate -- help
```

| 退出码 | 含义 | 典型原因 |
|---|---|---|
| `0` | 成功 | — |
| `1` | 未预期错误 | IO 失败、备份写不进去、代码缺陷 |
| `2` | 校验不通过 | 校验和不符、格式/版本不支持、请求了禁止的域、没有可导入内容 |
| `3` | 需要操作者显式决定 | 目标目录非空、身份冲突未裁决、**宿主仍在运行** |

**输出约定**：

- **stdout 只有一个 JSON 文档**（便于脚本与 DSH 解析）；人类可读进度走 **stderr**。
- 每个命令都返回 `schemaVersion: 1` 与 `command` 字段。
- 失败一律 `{"ok":false,"error":{"code":…,"message":…}}`，`code` 是稳定标识，`message` 是中文说明。
- `--yes` 当前**被接受但尚未改变任何判定**（预留给「目标非空仍要继续」；宿主运行中永远不放行）。
  身份的权威判定只有 `--identity`。

## 3. 三个命令的输出结构

### 3.1 `export`

```jsonc
{
  "schemaVersion": 1,
  "command": "export",
  "ok": true,
  "outDir": "<绝对路径>",
  "bundle": "<outDir>/bundle.json",
  "manifest": "<outDir>/MANIFEST.json",
  "suiteVersion": "0.1.0",
  "personaId": "bot",
  "consistency": "stopped",            // 或 "live-snapshot"（导出时宿主仍在跑）
  "domains": {                          // 逐域逐项
    "memory": {
      "included": true,
      "label": "长期记忆库",
      "items": [{
        "kind": "sqlite",
        "from": "home/memory/companion-memory.db",
        "included": true,
        "snapshotMode": "vacuum-into",  // 或 "file-copy"（VACUUM INTO 不可用时整组复制）
        "bytes": 21147648,
        "quickCheck": "ok",
        "userVersion": 0,
        "rowCounts": { "table": "memories", "rows": 976 }
      }]
    }
    // runtime / identity / reminders / health / qq …
  },
  "redactions": [ /* 每一项都说明「删了什么、删了几条、为什么」 */ ],
  "warnings": [],
  "problems": [],
  "nextSteps": ["…"]
}
```

### 3.2 `check`

```jsonc
{
  "schemaVersion": 1,
  "command": "check",
  "ok": true,
  "from": "<迁移包绝对路径>",
  "format": "dsh-companion-migration",
  "formatVersion": 1,
  "source": { "suiteVersion": "0.1.0", "platform": "win32", "node": "24.x",
              "personaId": "<旧人格 id>", "createdAt": "…", "consistency": "stopped" },
  "target": { "suiteVersion": "0.1.0", "personaId": "bot", "dataRoot": "<绝对路径>" },
  "verdict": "same",                    // same | older-source | newer-source | unknown
  "problems": [],                       // 非空 → exit 2
  "warnings": [],
  "conflicts": {
    "identity": [],                     // 非空且未给 --identity → exit 3
    "paths": [],
    "running": []                       // 非空 → exit 3（宿主在跑）
  },
  "plan": {
    "domains": [{ "domain": "memory", "label": "长期记忆库", "action": "import" }],
    "databases": [{ "path": "domains/memory/companion-memory.db", "quickCheck": "ok", "userVersion": 0 }],
    "willWrite": [{ "path": "domains/identity/identity.json",
                    "target": "home/companion/identity.json",
                    "absolute": "<绝对路径>", "bytes": 1234 }],
    "willBackup": ["home/companion/identity.json"],
    "personaMapping": { "from": "<旧人格 id>", "to": "bot", "appliedAt": "import" },
    "skipped": [{ "domain": "qq", "reason": "仅存档：外发状态不导入，避免重复发送。" }],
    "disk": { "bundleBytes": 27385560, "freeBytes": 147631128576, "requiredBytes": 54771120 }
  },
  "nextSteps": ["…"]
}
```

### 3.3 `import`

在 `check` 的字段之上追加：

```jsonc
{
  "ok": true,
  "dryRun": false,
  "imported": [
    { "path": "domains/memory/companion-memory.db",
      "target": "home/memory/companion-memory.db",
      "kind": "sqlite",
      "personaRowsRewritten": 976 }
  ],
  "notReplayed": [
    { "kind": "reminder", "id": "r_…", "at": 1793682600000,
      "reason": "导入的提醒一律置为已发并暂停：停机期间的提醒不补发。" },
    { "kind": "domain", "domain": "qq", "reason": "仅存档：外发状态不导入，避免重复发送。" },
    { "kind": "health-consent", "reason": "健康授权已在本机全部置为未授权（N 行）…" }
  ],
  "rebind": [
    { "kind": "path",    "what": "profile 与工作区路径", "action": "重跑 npm run setup …" },
    { "kind": "auth",    "what": "模型 provider 密钥",   "action": "…" },
    { "kind": "device",  "what": "BLE 心率设备",         "action": "…" },
    { "kind": "service", "what": "外部服务地址",         "action": "…" }
  ],
  "personaMapping": { "from": "<旧人格 id>", "to": "bot", "targets": [{ "file": "…", "table": "memories", "column": "persona", "rows": 976 }] },
  "backup": { "dir": "<dataDir>/backups/pre-import-<UTC>", "files": 5 },
  "report": "<dataDir>/logs/migration-import-<UTC>.json",
  "warnings": [],
  "nextSteps": ["…"]
}
```

`--dry-run` 返回同样的 `plan` / `rebind` / `personaMapping`，但**不写任何文件**（`dryRun: true`）。

## 4. 导出内容清单

### 4.1 默认导出的域

| 域 | 来源（相对 `<dataDir>`） | 形态 | 说明 |
|---|---|---|---|
| `memory` | `home/memory/companion-memory.db` | SQLite 快照 | 记忆、证据、修订链、向量 |
| `runtime` | `home/companion/companion-runtime.db` | SQLite 快照 | 事件、目标、信念、工作记忆、日程、活动 |
| `identity` | `home/companion/identity.json` | JSON（**去掉 `sessions`**） | 主人 / 人格绑定 |
| `reminders` | `home/channel-qq/reminders.json`、`workspace/reminders.json` | JSON（**全部标为已发+暂停**） | 只作清单 |
| `health` | `home/health/health.db` | SQLite 快照 | 只含派生统计 |
| `qq` | `home/channel-qq/sent-*.json` | JSON（**只留 messageId/time**） | 仅存档，不导入 |

### 4.2 需显式请求的域

| 域 | 来源 | 说明 |
|---|---|---|
| `memory-wiki` | `home/memory/wiki/` | 编译后的主题页。可重建，默认不导出 |

### 4.3 **永不导出**（无开关，请求即 `exit 2`）

| 域 | 为什么 |
|---|---|
| `credentials` / `secrets` / `auth` | 凭据、密钥、登录态：迁移后重新填写 / 重新扫码 |
| `bili-credentials` | B站 `bili_credential.json`：重新扫码 |
| `sessions` | 宿主会话缓存是本机的，且含聊天正文 |
| `desktop-data` | Electron user-data：登录态与缓存 |
| `logs` | 日志可能含正文与个人标识 |
| `media` / `media-artifacts` / `media-output` | 图片 / 语音 / 视频产物：只迁账本索引 |
| `cache` / `node-modules` / `venv` | 可重建 |

具体排除的物理文件还包括：`.credentials.yaml`、`config/suite.json` 里的 `accessToken`、
`home/companion/remote-models.json` 里的 apiKey、`.env*`、`storages/`、`tmp/`。

### 4.4 迁移包布局

```
<out>/
  MANIFEST.json          # 每文件 {path, domain, bytes, sha256, required}
  bundle.json            # 元数据：格式/版本/来源/域清单/排除项/脱敏项/警告
  domains/memory/companion-memory.db
  domains/runtime/companion-runtime.db
  domains/identity/identity.json
  domains/reminders/reminders.json
  domains/health/health.db
  domains/qq/suppression.json
```

`bundle.json` 的 `source` **不含绝对路径**，只含：

```jsonc
{ "platform": "win32", "node": "24.x", "hostVersion": "0.2.1-rc.3",
  "dataDirBasename": "data", "personaId": "<旧人格 id>", "targetPersonaId": "bot",
  "identityFingerprint": "sha256:…" }   // 身份指纹是哈希，不是明文
```

> `domains/identity/identity.json` 里仍然是**明文身份**（那是你自己的数据文件）。
> 所以迁移包属于**个人数据**：不要上传、不要入 Git、跨机传输自行加密。

## 5. 停写与备份要求

1. **导出前先停写**：`npm run stop`，确认宿主已退出。
   - 没停也能导出（`VACUUM INTO` 是事务一致的），但 `bundle.json` 会记 `consistency: "live-snapshot"`
     并给出警告。**严格备份请停写后再导。** 导出时会检测并警告。
2. **导出不在原地写**：先写 `<out>.partial-<pid>`，`MANIFEST.json` 写完后才 rename 成正式目录。
   中断的导出不会留下「看起来完整」的包。
3. **导入前必须备份**：`import` 会先把所有将被替换的文件复制到
   `<dataDir>/backups/pre-import-<UTC>/`（SQLite 连同 `-wal` / `-shm` 一起）。
   **备份失败即中止，一个字节都不写。**
4. **导入拒绝覆盖运行中数据**：检测到宿主仍占用数据目录 → `exit 3`。

> 停写检测是**启发式**（三者任一命中即判「可能仍在运行」）：启动锁被独占、`desktop-launch.json`
> 里的 pid 仍存活、数据库 WAL 在最近 15 秒内被写过。
> 它只能减少误判，**不能替代 `npm run stop`**。

## 6. `check` 的七项校验（全过才 `ok:true`）

| # | 校验 | 不通过 → |
|---|---|---|
| 1 | 格式可识别：`format == "dsh-companion-migration"` 且 `formatVersion <= 1` | `exit 2` |
| 2 | 完整性：`MANIFEST.json` 里每个文件存在，`bytes` 与 `sha256` 逐字节一致 | `exit 2` |
| 3 | 包内数据库健康：只读打开 + `PRAGMA quick_check` 为 `ok`，并读出 `user_version` | `exit 2` |
| 4 | 版本：`suiteVersion` 不高于本机；高于 → 先升级本机套件（**不支持降级导入**）；低 → 允许并逐条警告 | 高 → `exit 2` |
| 5 | 身份：`source.identityFingerprint` 与本机一致；不一致 → 需 `--identity` | `exit 3` |
| 6 | 目标状态：宿主是否仍占用数据目录 | `exit 3` |
| 7 | 磁盘余量 ≥ 包体积 × 2（因为要先写备份） | `exit 2` |

## 7. 导入行为（逐条）

### 7.1 身份冲突：`--identity adopt` / `--identity quarantine`

| 情况 | 行为 |
|---|---|
| 指纹一致 | 直接导入。身份文件只补 `persona` 与导入元信息，**保留本机 `sessions`** |
| 指纹不一致、未给 `--identity` | `exit 3`，并要求操作者裁决 |
| `--identity adopt` | 采用包内身份（主人 / 人格）。**本机已有的会话绑定保留**，旧的按人格 id 映射改写 |
| `--identity quarantine` | **不写身份文件**：包内数据只作隔离保留，`contextFor` / `recall` 不会把它注入对话 |

### 7.2 人格 id 映射（旧 id → 目标 id）

老数据里的人格 id 是历史值（旧库里那个标识，**不写进代码**：它随 `bundle.json` 的
`source.personaId` 一起搬），新套件默认是 `bot`（`config/suite.json` 的 `persona.id`，
可被 `DSH_COMPANION_PERSONA_ID` 覆盖）。导入时：

1. `identity.json` 的 `persona` 改成目标 id；
2. 导入的**数据库副本**里，所有**名字像 persona 的文本列**（`persona` / `persona_id` / `personaId`）
   中等于旧 id 的值整列改写，事务提交；
3. `memory-wiki` 域里的文件名若含旧 id（如 `relationships/<旧人格 id>-user.md`）一并改名；
4. 全过程写进输出 JSON 的 `personaMapping.targets[]`（文件 / 表 / 列 / 行数），
   `check` 阶段就会先给出 `persona-id-mapping` 警告。

**只改副本，不改迁移包**。改写的目标 id 来自本机解析结果；旧 id 来自迁移包自己的记录，
两者都不是硬编码——所以代码里搜不到任何历史人格名（`npm run verify --only=static` 会拦）。

### 7.3 提醒：一律不重放

- 导入的提醒**全部**写成 `fired: true` + `paused: true` + `pausedReason: "imported: 旧提醒不重放，仅存档"`。
  `fired` 是运行器真正认的「已发送」标记，所以**不会**被当成待发而补发。
- 本机原有提醒**不受影响**（按 `id` 去重合并）。
- 每一条被抑制的提醒都列进 `notReplayed[]`。

### 7.4 外发状态：不导入、不重试

- `qq` 域**只导出不导入**（`domains.qq.suppression.json` 仅是 messageId/time 的存档）。
- contact / outbox 的候选与草稿**不迁移**，因此不存在「导入后翻出旧草稿发出去」的路径。
- 导入后不触发任何网络请求：迁移过程本身零外发。

### 7.5 健康授权：不继承

- `health.db` 会迁移，但**授权不迁移**：导入后本机的 `health_consents` 全部置为未授权
  （行数写进 `notReplayed[]`）。
- 若表结构无法识别，不猜测、不改动，改为在 `warnings[]` 里要求到 Studio 复核。
- 结果：迁移**不会**让健康采集在新机器上自动开始。

### 7.6 写出与报告

- 每个文件都通过 `<目标>.partial-<pid>` + rename 写入；替换 SQLite 前先删掉旧的 `-wal` / `-shm`。
- 全过程写一份报告：`<dataDir>/logs/migration-import-<UTC>.json`（内容与 stdout JSON 同构）。
- 报告写失败不影响已完成的导入，但会在 `warnings[]` 里明确说明。

## 8. 导入后必须重新绑定（`rebind[]`）

**迁移只搬数据，不搬身份凭证与环境绑定。** 导入成功后必须做：

| 类型 | 要重绑什么 | 怎么做 |
|---|---|---|
| `path` | profile 与工作区路径 | 重跑 `npm run setup`：它会按本机解析值重新生成 `cordis.patch.yml`（`file://` 插件路径、工作区路径） |
| `auth` | 模型 provider 密钥 | 填 `config/suite.json` / `.env.local` / 系统环境；迁移包不含密钥 |
| `auth` | QQ / B站 登录 | 重新扫码（NapCat WebUI、B站）；`bili_credential.json` 永不迁移 |
| `auth` | 健康授权 | 到「陪伴空间 → 健康」重新确认；再 `companion_pulse action=start`。**华为云端通道还需要你自己指向上游检出**（`$HUAWEI_UPSTREAM_PKG`，见 `docs/03` §1.2）；BLE 心率不需要 |
| `device` | BLE 心率设备 | 在设备上打开「心率广播」；`start` 是唯一扫描入口 |
| `service` | 外部服务地址 | OneBot / 健康 sidecar / 媒体服务地址填进 `config/suite.json`；套件只连接、不安装 |

完成后按顺序确认：

```bash
npm run doctor     # 不应再有「陈旧路径」「未配置」之外的新问题
npm run start
# 会话里问「我更喜欢喝什么」——能召回，才算记忆真的搬过来了
```

## 9. 操作示例（含空格与中文路径）

```powershell
# 源机器：停写后导出
npm run stop
npm run migrate -- export --out "D:\陪伴 备份\mig-20261105"
```

```powershell
# 目标机器：先部署，再预检
npm ci; npm run build; npm run doctor; npm run setup
npm run migrate -- check --from "D:\陪伴 备份\mig-20261105"
npm run migrate -- import --from "D:\陪伴 备份\mig-20261105" --dry-run --identity adopt
npm run migrate -- import --from "D:\陪伴 备份\mig-20261105" --identity adopt
```

```bash
# Linux / macOS 同形
DSH_COMPANION_DATA_DIR="/srv/companion/data" \
  node tools/migrate/cli.mjs export --out "/srv/companion/exports/mig-1"
```

排查时单独跑系统命令（不经 npm 转发参数）：

```bash
node tools/migrate/cli.mjs check --from "D:\陪伴 备份\mig-20261105"
```

## 10. 失败与限制

| 现象 | 含义 | 处理 |
|---|---|---|
| `exit 2` + `checksum-mismatch` / `size-mismatch` | 包被截断或改过 | 重新导出；不要手改包内文件 |
| `exit 2` + `format-too-new` / `version-incompatible` | 包比本机新 | 先升级本机套件；**不支持降级导入** |
| `exit 2` + `disk-space` | 空间不足（需要包体积 ×2） | 清理 `<dataDir>/backups/` 或换盘 |
| `exit 3` + `host-running` | 宿主仍占用数据目录 | `npm run stop`，确认进程退出，重跑 |
| `exit 3` + `identity-undecided` | 身份冲突 | 决定 `--identity adopt` 还是 `quarantine` |
| `exit 3` + `output-not-empty`（export） | 输出目录非空 | 换 `--out`，或自己移走旧目录（工具不删你的文件） |
| `exit 1` + `backup-failed` | 备份写不进去 | 检查 `<dataDir>/backups/` 权限与空间；**此时没有任何数据被改动** |

**已知限制**（如实写在这里，不藏）：

1. 「是否仍在运行」是启发式判断，见 §5 末尾。
2. `VACUUM INTO` 在某些文件系统/权限下会失败，此时退化为「整组复制」，`snapshotMode` 会写
   `file-copy`、并附警告——两种模式都需要源库当时没有活跃写入才严格一致。
3. 人格 id 改写只覆盖**名字像 persona 的列**；如果某个模块把人格 id 藏在 JSON 字符串里，
   不会被改写，需要人工核对（`personaMapping.note` 会提示）。
4. 只验证过 SQLite 与 JSON 两种形态；迁移包**不含**任何二进制媒体。
5. 未在 Linux/macOS 实机跑过完整迁移（逻辑是纯 Node，CI 覆盖到离线测试）。

## 11. 安全提醒

- 迁移包 = 个人数据（记忆正文、身份、日程）。**不要**上传到网盘/公开仓库，跨机传输要加密。
- 报告文件 `<dataDir>/logs/migration-import-*.json` 同样含个人路径，不入库。
- 凭据永远不迁移：看到包里有 `accessToken` / `apiKey` / `bili_credential`，说明用人手改过包，
  应当重新导出。
