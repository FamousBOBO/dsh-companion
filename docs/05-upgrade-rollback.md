# 05 · 升级与回滚

> 核心原则：**代码可以随时回退，数据不行。**
> 回滚代码前，必须先确认数据与旧代码的 schema 对得上；否则「回滚」会把库变成旧代码读不懂的样子。

## 1. 版本号怎么读

| 位置 | 含义 |
|---|---|
| 根 `package.json` 的 `version` | 套件版本（当前 `0.1.0`），所有发布模块统一它 |
| 模块 `package.json` 的 `version` | 同名 `0.1.0` |
| 模块的 `localVersion` | 该模块**原始**版本，仅留档；不参与依赖解析 |

看当前装的是哪一版：`npm run doctor`（会报套件版本与宿主版本），或直接看根 `package.json`。

## 2. 升级前（三件事，缺一不可）

1. **备份数据目录**（一致性备份，不是随便复制）

   优先用套件的迁移导出（它做 `VACUUM INTO` 一致快照并带校验和）：

   ```bash
   npm run stop
   npm run migrate -- export --out "<数据目录外的位置>/pre-upgrade-<版本>"
   ```

   或者手工整组复制：**SQLite 必须连 `-wal` / `-shm` 一起复制**，只复制 `.db` 会丢最近的写入。

2. **记录当前版本与宿主版本**：`npm run doctor > upgrade-before.txt`（本机留档，不入库）。

3. **读变更**：仓库的 CHANGELOG / release notes。特别关注「数据 schema 变更」「配置字段改名/删除」
   「默认值变化（尤其是从关到开）」三类。

## 3. 升级步骤

```bash
npm run stop                     # 1. 停写
# 2. 备份（见上）
git fetch --tags && git checkout <新版本 tag>
npm ci                           # 3. 依赖按新锁文件重装
npm run build                    # 4. 重建产物（仓库不存构建产物）
npm run doctor                   # 5. 只读诊断
npm run start                    # 6. 启动
npm run verify                   # 7. 离线检查（compose 段无宿主时 SKIPPED）
```

升级时的常见注意点：

| 情况 | 处理 |
|---|---|
| 新版本要求更高 Node | 先升 Node（`engines` 会拦），再 `npm ci` |
| 宿主版本也一起升了 | `doctor` 会给出 `newer`（未实测）结论；记录它、优先怀疑宿主差异 |
| 配置字段被删除/改名 | 旧字段会被忽略并沿用默认值；`doctor` 的告警里会点名 |
| 数据 schema 需要迁移 | 模块在**加载时**做向后兼容升级；先按 §2 备份，再升级 |
| `dataDir` 换位置 | 改 `config/suite.json` 后重跑 `npm run setup`，再 `npm run start` |

## 4. 数据兼容规则（为什么不能随便回滚）

- 存储 schema **只增不改**：新版本可以加表/加列，旧版本读新库时会因为「不认识的表/列」而报错或
  静默丢数据。
- 记忆库另有 `memory_revisions` 这类修订链；跨版本回退可能让修订链指向不存在的记录。
- 因此：**回滚代码必须配「与旧代码匹配的数据备份」**，而不是把新库留给旧代码去读。

## 5. 回滚

### 5.1 只回滚代码（数据 schema 没变时）

```bash
npm run stop
git checkout <旧版本 tag>
npm ci
npm run build
npm run doctor
npm run start
```

适用条件：你**确认**这次升级没有引入存储 schema 变更（看 changelog / 模块 CONTRACT）。
不确认就走 §5.2。

### 5.2 代码 + 数据一起回滚（安全路线）

```bash
npm run stop
# 1. 把当前（新版本）数据目录整体挪走保命，别删
mv <dataDir> <dataDir>.failed-<时间戳>
# 2. 用升级前的一致备份恢复（迁移包或整组复制的旧库）
npm run migrate -- check  --from "<升级前备份>"
npm run migrate -- import --from "<升级前备份>" --identity adopt
# 3. 回到旧版本代码
git checkout <旧版本 tag> && npm ci && npm run build
npm run doctor && npm run start
```

> 用 `npm run migrate -- import` 恢复的好处：它会先再备一份、逐文件校验和、拒绝覆盖运行中数据。

### 5.3 功能级回滚（不想动版本）

按模块关掉即可，改动都是**配置级**：

| 想关掉 | 怎么做 |
|---|---|
| 某个可选模块 | `config/suite.json` 的 `modules.<模块> = false`，重跑 `setup`，重启 |
| 记忆新引擎 | `memory.config.json` 的 `backend` 改回 `legacy`（注意：检索能力会退化） |
| 后台提炼 | `memory.config.json` 的 `extraction.enabled = false`（默认就是 false） |
| 认知运行时 / 日程 / 心跳 | `runtime.config.json` 关 `agenda` / `heartbeat` / `p2.*`，或整体 `enabled: false` |
| 媒体能力 | `media/config.json` 对应 `enabled = false`（**保存即生效**，按 mtime 热重载） |
| 健康采集 | `home/health/config.json` 的 `enabled = false`，或到 Studio 撤销授权（授权表才是权威） |
| QQ 通道 | profile patch 删掉 `- id: channel-qq` 整段并重启；顺手把 `modules.qq = false` |
| 群聊接话 | 通道配置 `presence.enabled = false`（回到「只回 @」） |
| 提醒 | 通道配置 `reminders.enabled = false`，或 `dryRun = true` |
| B站（外部模块） | 该模块的 `enabled = false`，或从 profile 移除 |
| 注入器 | 从 profile 移除 `dsh-super-injector`（它本来就不在陪伴桌面） |

### 5.4 回滚**不能**做到的事

- 不能撤回**已经发生的外部动作**：已经发出去的 QQ 消息、B站评论、已经产生的模型/生图费用。
- 不能把「升级期间被新版本改写过的数据」自动还原成旧格式——只能靠备份。
- 不能让旧代码读懂新 schema。

## 6. 升级后的验收清单

按顺序，每步都要看到具体输出，不要只看「没报错」：

1. `npm run doctor` —— 无新的阻断项；兼容性结论记录在案。
2. `npm run verify` —— `unit` / `static` 全绿；`compose` 是 `SKIPPED` 的话要明确知道它没被验证。
3. `npm run start` —— 打印本次日志路径与本地地址。
4. 会话里做一次记忆闭环（`docs/01` §6）。
5. 确认安全默认值仍然关闭：`safety.*` 全 `false`，通道 `dryRun` / `allowExternalSend` 未被打开。
6. 看一次 `<dataDir>/logs/` 里本次启动日志有没有装载失败 / 重复注册 / 服务缺 isolate realm 之类告警。
