# dsh-channel-qq — 构建、来源与本地补丁

本文件是**构建说明与上游来源登记**，面向要在这个目录里跑构建/改代码的人。
部署与配置见套件根目录的 `docs/01-deployment.md`、`docs/02-configuration.md`。

---

## 1. 来源

| | |
|---|---|
| 上游项目 | `github.com/Aegink/dsh-channel-qq`（MIT） |
| 本目录 | DSH Companion 套件里的 QQ 通道模块（包名 `@dsh-companion/channel-qq`） |
| 上游快照 | 2026-10-28 的 tarball（无 `.git`，因此没有 commit id） |
| 许可 | MIT，见 `LICENSE`（"dsh-channel-qq contributors"）；上游与第三方的完整清单见套件根 `THIRD-PARTY-NOTICES.md` |

相对上游快照的改动分三类，全部记在第 4、5 节：**两处 bug 补丁**、**构建/类型解析改造**、
**套件侧的发布化改动**（构建产物路径统一、安全默认值、去个人化）。

---

## 2. 构建

```bash
npm ci            # 只在套件根跑一次（workspaces）；单独装也可：npm install
npm run build     # = build:admin（生成 src/admin-html.ts）+ build:lib（tsc -p tsconfig.json）
npm test          # = build:tests（tsc -p tsconfig.test.json）+ node --test "build/lib-test/test/*.test.js"
npm run verify    # = check:admin + check:syntax + typecheck + test + check:layers + check:size
```

产物只有一个布局，**没有带日期的目录**：

| 路径 | 来源 | 用途 |
|---|---|---|
| `build/lib/` | `tsc -p tsconfig.json` | 包入口：`main` = `build/lib/index.js`，`types` = `build/lib/types/index.d.ts`，`imports["#lib/*"]` = `build/lib/*` |
| `build/lib-test/` | `tsc -p tsconfig.test.json`（含 `test/`） | 测试产物，`node --test` 跑它 |

`build/` 全落在 `.gitignore` 里：clone 之后必须 `npm run build` 才会出现入口文件。
`cordis.patch.yml` 里的 `name` 是**包名**（`@dsh-companion/channel-qq`），不是任何绝对路径。

构建脚本都是 Node 脚本（`scripts/*.mjs`）或 npm script 里的 `tsc`，**不依赖 bash**，
Windows / Linux / macOS 同一套命令。

## 3. 依赖

| 类型 | 内容 | 说明 |
|---|---|---|
| 运行时依赖 | `ws`、`silk-wasm` | OneBot WS 客户端/服务端、silk→WAV 转码 |
| 对等依赖（peer） | `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm` | 由宿主提供；插件只用宿主的实例，**绝不**自带第二份 cordis |
| 开发依赖 | `typescript`、`@types/node`、`@types/ws`、`@deepseek-ai/dsh-attachment` | 编译与类型检查 |
| 第三方类型声明 | `vendor/types/{cordis,dsh-llm,dsh-attachment}` | 上游发布的 `.d.ts`；只经 `tsconfig.json` 的 `paths` 参与**类型解析**，运行时不 import（来源/版本/许可见套件 `THIRD-PARTY-NOTICES.md`） |

`@types/node` 目前仍钉 `^22`：`engines.node` 是 `>=24.0.0`（套件口径，见根 `package.json`），
类型声明版本只影响编译期，不影响运行时。

---

## 4. 本地 bug 补丁（2 处，均为删除/一行守卫）

两处都是上游测试覆盖不到、但在真实运行时**致命或长期污染**的问题。改法都不改变插件
想做的行为，建议同样报给上游。

### P1 — 非法 JSON Schema 让每个 QQ 回合都以 HTTP 400 失败

`src/features/music/tools.ts`（`qq_resolve_music`、`qq_music_lyrics`）把 `required: true`
写在**属性**里，而 JSON Schema 只允许 `required` 出现在对象层（字符串数组）。对象层的
`required: ['songId']` 本来就表达了意图，所以修法是删掉那个多余的键：

```diff
-            songId: { type: 'string', required: true, description: '网易云歌曲ID' },
+            songId: { type: 'string', description: '网易云歌曲ID' },
```

**为什么是阻断级**：provider 校验的是**整张工具表**，一条坏 schema 会让整个请求被拒
（`Invalid schema for function 'qq_music_lyrics': true is not of type "array"`），
于是没有工具调用、没有模型步骤——所有 QQ 回合一起死。

已审计全 `src/`：修完这两处后 `grep -rn "required:\s*\(true\|false\)" src/` 无匹配，
其余 `required` 都是对象层字符串数组。快照 `test/golden/tools/qq-tools.txt` 当时把这份
非法 schema 也钉了进去，同步改掉了那两行。

### P2 — `affectionPort: 0` 绑了一个随机端口而不是"关闭"

`src/affection.ts` 的 `serve()` 没有守卫，而配置帮助文本承诺 `0` = 关闭
（`src/config/sections/root.ts`），`relisten()` 也已经守过。补丁是 `serve()` 开头的一行：

```diff
   async serve(port: number, opts: … = {}): Promise<void> {
+    if (!Number.isFinite(port) || port <= 0) return
     this.configure(opts)
```

---

## 5. 相对上游的其它改动（套件侧发布化）

| # | 改动 | 原因 |
|---|---|---|
| 1 | `package.json`：包名 `@dsh-companion/channel-qq`、`main`/`types`/`exports`/`files` 全部指向 `build/lib`，`engines.node >= 24`，`localVersion` 留档 | 构建产物路径统一；不再指向带日期的 `build/lib-*` 目录 |
| 2 | 删掉 `tsconfig.build.json`、`tsconfig.test.build.json`（纯 `extends` 包装） | 同一份 emit 设置有两个入口，改一处漏一处就会让某条命令突然红掉。标准命令就是 `-p tsconfig.json` / `-p tsconfig.test.json`；只保留 `tsconfig.verify.local.json`（`noEmit` 的全量类型检查，含 `test/`） |
| 3 | `cordis.patch.yml` 只留"连接/身份"几个字段，其余取 schema 默认值 | 出厂默认即安全默认（见第 6 节）；部署相关值写在 profile 的用户层 |
| 4 | 删除 `package-lock.json`、`pnpm-lock.yaml` | 锁文件由套件根统一生成；旧锁把 `@deepseek-ai/*` 钉在 alpha 版本，与 `vendor/types` 的版本不一致 |
| 5 | 删除 `continuation-entry-20261031.mjs` | 指向一次性调试产物 `build/lib-continuation-20261031/` 的残留入口 |
| 6 | `vendor/types/**` 入库 | 宿主运行时产物不带 `.d.ts`，不映射就 29 条 TS7016 |
| 7 | 人格去个人化：`assets/persona/default/**`、`src/app/inbound/presence-judge.ts`、调度提示等 | 出厂文案不再假设具体角色/称呼；身份由用户 `config/persona.md` 决定 |
| 8 | `docs/**` 与 `eval/**` 里的个人路径、真实 QQ 号换成占位/合成值 | 发布口径：不携带作者机器与个人数据 |

---

## 6. 发布默认值（安全合同）

出厂配置下**不会自己开口、不会后台调模型**。可用 `npm test` 里的
`test/safe-defaults.test.ts` 复核（它替换全局定时器函数并计数）：

| 项 | 默认 | 含义 |
|---|---|---|
| `connection.url` | `""` | 未配置 NapCat：不拨号、不监听、不重连 |
| `proactive.scheduler` | `false` | 旧定时行为（巡逻/做梦/自省/主动私聊/早报/抽知识）一个定时器都不注册 |
| `proactive.v2` | `false` | 事件书不跑 |
| `morningReport.enabled` | `false` | 每天定时外发 |
| `contact.enabled` / `dryRun` / `allowExternalSend` | `false` / `true` / `false` | 主动消息两道闸 |
| `contact.draftModel` / `adaptiveFollowUp` | `false` / `false` | 模型起草、跟进复核 |
| `presence.enabled` | `false` | 群聊旁听与自主接话 |
| `eventMonitor.enabled` | `false` | 群事件自动组回合（后台模型调用） |
| `chatlog.enabled` / `planner.enabled` | `false` / `false` | 原话簿、群聊准入 |
| `groupAdmin.dangerous` / `policy.v2` / `tools.v2` | `false` | 高危群管与 v2 闸门 |
| `reminders.dryRun` | `true` | 提醒照常到点、不真发 |
| `admin.password` | `""` | 空口令无法登录（fail-closed），且只监听本机 |

`plugins/qq-idle-compaction.mjs`（套件级可选插件，空闲压缩会走到模型）同样**默认关**：
只有 `QQ_IDLE_COMPACTION=1` 才安装 60 秒轮询。

---

## 7. 上游更新之后

1. 用新快照覆盖 `src/ assets/ test/ docs/`（会同时回退第 4 节两处补丁）。
2. 重新应用 P1、P2（`grep -rn "required: true" src/` 与
   `grep -n "async serve(port" src/affection.ts` 各查一次）。
3. `npm run build && npm test`；若有快照差异，跑
   `UPDATE_GOLDEN=1 node --test "build/lib-test/test/golden.test.js"`，
   并且**只接受**与改动相关的那几行 diff。
4. 上游修掉某个补丁时就删掉它，并同步更新本文件第 4 节与 `src/features/**` 里的注释。

## 8. 已知未验证项

- 真实 QQ 链路（NapCat/OneBot 连上、真发消息、真实回执）**无法离线验证**：
  本目录的测试使用假平台。证据等级见套件 `docs/07-verification-status.md`。
- 宿主加载（`--patch cordis.patch.yml` 把本插件挂进 profile）需要真实 DSH 宿主；
  离线 CI 只验证"构建 + 模块可 import"。
