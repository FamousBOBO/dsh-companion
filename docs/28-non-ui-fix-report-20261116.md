# 非 UI 修复完成报告（2026-11-16）

- 计划来源：`non-ui-audit-plan-20261116.md`（P1 × 3、P2 × 2）
- 执行位置：worktree `D:\DSH\dsh-production\.agents\worktrees\dsh-39e2a7a6-a4a1`（分支 `dsh-39e2a7a6-a4a1`）
- 边界：**未**启动陪伴宿主、**未**调真实模型/平台 API、**未**改本机 `config/suite.json` 或 `data/`、
  **未**提交远端。

## 1. 基线（可复核）

```powershell
git rev-parse --abbrev-ref HEAD   # dsh-39e2a7a6-a4a1
git rev-parse HEAD                # 60fb670（merge: 把 A–F 六包与审计报告并入 origin/main）
git rev-list --left-right --count HEAD...origin/main   # 8  0
git log -1 --format='%h %s' origin/main                # c0bc04e fix(ops): 生产启动只认本次 boot 的 URL…
git status --porcelain --untracked-files=all           # 本轮改动前：空
```

- 本 worktree 基于 `60fb670`，本地 `origin/main` 引用为 `c0bc04e`（未 fetch），HEAD 领先该引用 **8 个提交**。
  **不推断这些提交是否已发布**：只有 fetch 后与真实远端比对才能回答。
- 上一级检出 `D:\DSH\dsh-production`：分支 `main`、HEAD 同为 `60fb670`、相对本地 `origin/main` 同样 `8 0`，
  工作树有 **14 条未跟踪**条目（未改动、未纳入本次任何提交）：

| 类别 | 文件 | 处置 |
|---|---|---|
| 本机 Profile 备份 | `config/profile/companion.patch.yml.before-d-path-fix-20261116-172032`、`…before-group-song-20261115` | 保留，不得入库（`config/profile/*.yml` 已在 `LOCAL_ONLY` 扫描豁免里） |
| 工作文档（他人计划/审计） | `docs/non-ui-audit-plan-20261116.md`、`docs/25-g0-*.{md,tsv}`、`docs/26/27-*`、`docs/minecraft-*`、`docs/next-stage-*`、`docs/ui-observability-*`、`docs/11-expression-sticker-chain-plan.md`、`design/bug-investigation-*` | 保留原样，本轮只读取过计划本身 |
| 本机脚本 | `tools/g0-minecraft-memory-gate.mjs` | 保留原样 |

未读取 `data/` 下聊天、记忆、健康或媒体正文。

## 2. 修改文件与行为变化

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `tools/lib/host.mjs` | 重写为可注入纯函数集：`executableCandidates` / `moduleRootCandidates` / `cliEntryPath` / `probeHost` / `readHostVersionMetadata` / `resolveHost` / `deriveModuleRoot` / `isAsarArchivePath` | 旧实现只猜 `resources/app/dsh/node_modules`，且 `probeVersion()` 指向一个不存在的 `app/dsh/package.json`，于是本机 `0.2.2-rc.1` 必然报「找不到 CLI 入口」+ 版本 `unknown` |
| `tools/lib/host.mjs` | 新增 `HOST_PROBE_SCRIPT`：在**桌面二进制内部**（`ELECTRON_RUN_AS_NODE=1 <exe> -e …`）检查三种布局并读版本 | `app.asar` 对 plain Node 不可读，只有二进制自己能看到；探针只报它真正验证过的路径 |
| `tools/lib/host.mjs` | `resolveHost()` 不再把配置里的 `moduleRoot`（目录）当作可执行文件候选 | 实测缺陷：headless「只配 moduleRoot」会被误判成「找到可执行文件」，`source` 变成 `probe`、`config-module-root` 分支永远走不到 |
| `tools/lib/host.mjs` | `resolveHost()` 返回值新增 `cliPath` / `cliExists` / `probed` / `versionSource` | 让探针在 asar 内的结论能传到 launcher；不让 `fs.existsSync` 用一个"看不见 asar"的检查去否掉正确答案 |
| `tools/lib/dsh.mjs` | `hostCliPath(moduleRoot, knownExists)`、`describeLauncher` 透传 `host.cliExists` | 同上：asar 布局下 launcher 必须认可探针结论 |
| `scripts/verify.mjs` | `unit` 段新增 `tools（宿主探测 / 外部模块指纹 / 迁移）` 一行：`node --test tools/**/*.test.mjs` | 这些测试以前**只能手动跑**，`verify` 全绿并不覆盖它们（本次两个缺陷正是这样漏出去的） |
| `scripts/verify.mjs` | `compose` 段改用 `resolveHost()` + `describeLauncher()`；没有 `config/suite.json` 时明说「没有 profile 可合成」 | 旧实现用 plain `fs.existsSync(cli)` 判断宿主，asar 布局下必然 SKIPPED，且把所有跳过原因都写成「未检测到 DSH 宿主」——那是错误诊断 |
| `tools/lib/host-temp.test.mjs` | 夹具路径改为运行时拼装（`String.fromCharCode` 片段），断言扩到 5 条 | 旧文件里 `C:/Users/<name>/…` 字面量命中 `author-path`。**没有**给该文件加豁免，也没有放松规则 |
| `tools/lib/host.test.mjs`（新增） | 15 条纯逻辑用例，`exists`/`readJson`/`probe` 全部注入，假 `LOCALAPPDATA` | 覆盖计划里要求的 6 种布局/配置情形，且不触碰本机安装 |
| `tools/verify-external-modules.mjs` | `verifyModule()` 增加可选 `pins` 注入（默认仍用 `PINS`） | 让「字节判据」和「publish 判据」各自能被测，而不必伪造 sha256 |
| `tools/verify-external-modules.test.mjs` | 把原先"两种 code 都算过"的宽松断言改成两条独立用例（缺 publish 必拒 / 补上 publish 必过 / hash 优先） | 旧断言 `['hash-mismatch','provider-publish-absent'].includes(...)` 让第二条判据实际上没被证明过 |
| `tools/bilibili-provider-integration.test.mjs`（新增） | 5 条集成用例：合成外部模块真的注册进注册表 → 端口可用 → `ready()` 转身 → 卸载 → 重挂 → 未就绪不 run | 计划 P2 要求「离线测试覆盖 provider 未就绪与已就绪路径」，而两边各自的测试之间那条缝没人验 |
| `scripts/doctor.mjs` | 宿主段新增「宿主版本来源」一行；B 站模块改读指纹 | 「已安装」曾被当成「可用」；版本 `unknown` 没说明原因 |
| `docs/07-verification-status.md` | 新增 §2.10 证据表；修正 §2.8 里「宿主 CLI 入口找不到」的旧结论 | 旧结论已不再是事实，必须标明修了什么、以及**装载仍然未验证** |
| `docs/06-troubleshooting.md` | 新增两条症状处置：CLI 入口找不到 / 版本读不到 | 按症状能直接查到该看哪一行 |
| `docs/03-modules-support-matrix.md` | `dsh-bili-scroll` 增加「装上了不等于能用」+ 指纹命令 | 版本号无法区分两份 `2.4.0` |

## 3. 命令与结果（本轮实跑）

```powershell
# 依赖与构建（仓库不存构建产物，干净检出必须走这两步）
npm ci                                          # exit 0，28 packages / 16s
npm run build                                   # exit 0：expression / media / memory-studio / channel-qq 全通过

# 定向单测
node --test tools/lib/host.test.mjs             # 15/15 通过
node --test tools/lib/host-temp.test.mjs        # 5/5 通过
node --test tools/verify-external-modules.test.mjs  # 7/7 通过
node --test tools/bilibili-provider-integration.test.mjs  # 5/5 通过
node --test plugins/companion-runtime/test/bilibili-provider.test.mjs plugins/companion-runtime/test/p2-bilibili-provider-gate.test.mjs  # 4/4 通过

# 发布闸门
node scripts/verify.mjs                         # unit 10 通过 / 0 失败 / 1 无测试
                                                # static 39 通过 / 0 失败
                                                # compose SKIPPED（干净检出没有 config/suite.json；原因已写明）
node scripts/verify.mjs --only=static           # 39/0（基线是 38/1）
node scripts/doctor.mjs                         # 结论：核心检查通过（注意 2、未就绪 12、共 35 项）

# 外部模块指纹（只读）
node tools/verify-external-modules.mjs          # 生产 profile → code=hash-mismatch，exit 1
                                                # bytes=211655 sha256=784dfa67…
                                                # 备份副本      → code=ok，bytes=213810 sha256=127d04be…
```

`compose` 的独立验证（**隔离实例，不动本机 profile**）：

```text
临时 DSH_HOME → 渲染本 worktree 的补丁模板（只启用 core）→ 创建 probe-companion → --dump-config
结果：exit 0 / 198 个 loader 行 / 234 ms
preset-companion ✓  companion-workspace-context ✓  companion-foundation ✓
补丁引用 2 个 file:// 入口，全部存在；死链 0
宿主：launcher=desktop-exe，cliPath 来自 app.asar 内探测
```

## 4. B 站 provider 的归属与证据等级

| 问题 | 结论 | 等级 |
|---|---|---|
| 谁负责注册 provider | **外部模块 `dsh-bili-scroll`**（不在本仓库）；注册键是 `process[Symbol.for('dsh.companion.bilibili.providers.v1')]` 这个 `Map`，键为 `realpathSync(stateDir)` | 源码只读核对 |
| 消费端在哪 | `plugins/companion-runtime/lib/bilibili-provider.mjs`：`available()` 读同一注册表、`run()` 未就绪直接 `{status:'failed'}` | 源码 + 4 条离线用例 |
| 本机装的那一份能用吗 | **不能**：`211655` 字节、不含 `providers.set`；指纹 `hash-mismatch`。只有 `data/backups/pnpm-store-repair-20261113` 里那份 `213810` 字节的副本通过指纹 | 只读指纹实测 |
| 未就绪时会怎样 | capability 目录报 `provider-not-ready`，planner 不排 B 站，残留 slot 也不 start（`bilibili-provider-not-ready` 具名 code） | 4/4 离线用例 |
| 就绪路径 | 合成模块 import 后真的注册 → 端口可用 → `run` 产证据；`ready()` 转身立刻回到不可用；删条目后重挂能恢复 | 5/5 集成用例 |
| 真实观看 / 评论 / 发送 | **未执行** | 未验证 |

## 5. 未执行 / 不算证据

- **真实**宿主装载（`host-load`）：本轮只到 `--dump-config` 合成，没有启动陪伴实例看装载日志。
- 真实模型、B 站登录与观看评论、QQ/NapCat 发送、健康硬件、计费 API：全部未触发。
- 「合成 198 行」≠「运行实例里这些插件都活着」；`compose` 通过只说明配置能被宿主合成。
- 指纹通过只说明**字节对**，不说明账号可用、额度够、Python venv 正常。
- Windows 上 `memory-studio` / `channel-qq` 在**未构建**状态会红（缺构建产物），`npm run build` 后转绿；
  这不是缺陷，也不能反过来当成「模块本来就好」。
- 本机 `config/suite.json` 与 `data/` 一个字节都没改：所有需要数据根的命令都通过
  `DSH_COMPANION_DATA_DIR` 只读指向生产数据，或指向 `os.tmpdir()` 下的临时根。

## 6. 复现建议（下次接手先跑这三条）

```powershell
node scripts/doctor.mjs                    # 宿主段应显示「宿主版本来源：桌面二进制内探测」
node scripts/verify.mjs                    # 干净检出：unit/static 全绿，compose 因无配置 SKIPPED
node tools/verify-external-modules.mjs     # 部署 B 站模块前后各跑一次，判据是 code 而不是版本号
```

## 7. 最终核对（本轮结束时的实际输出）

```text
$ node scripts/verify.mjs
unit     ok  10  failed  0  skipped/no-tests  1
static   ok  39  failed  0  skipped/no-tests  0
compose  ok   0  failed  0  skipped/no-tests  1
验证通过（2 项跳过/无测试，跳过不等于通过，见 docs/07-verification-status.md）。   exit 0

$ node scripts/doctor.mjs
[通过] 宿主 CLI 入口 — …\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js
[注意] 宿主版本 — 宿主 0.2.2-rc.1 高于已验证版本 0.2.1-rc.3，未实测。
[信息] 宿主版本来源 — 桌面二进制内探测（Electron 内读 app.asar / runtime.json）
结论：核心检查通过（注意 2、未就绪 12、共 35 项）                          exit 0
```

改动清单（相对基线 `60fb670`）：10 个文件修改、3 个新增（`tools/lib/host.test.mjs`、
`tools/bilibili-provider-integration.test.mjs`、本文）。没有提交、没有推送——是否发布由操作者决定。
