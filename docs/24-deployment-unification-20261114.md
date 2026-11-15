# 部署统一与四项裁决落地（2026-11-14）

本文件记录第 12 轮之后实际执行的落地动作、实测证据与仍未闭合的项。**测试通过不等于端到端可用**：
下面每个结论都标注了证据等级（E1 实现+构建、E2 离线合成测试、E3 宿主加载、E5 操作者触发的真实外发）。

---

## 0. 结论速览

| 项 | 状态 | 证据 |
|---|---|---|
| 生产源码快进到 `origin/main` | **已完成**，HEAD `87b10b8`，behind 0 / ahead 0 | 实测 |
| 生产树本地改动保全 | 已完成（备份 + stash + 回填，22 个文件回到工作区） | 实测 |
| Profile 指向单一源码根 | **已完成**：15 个 `file://` 里 14 个指向 `D:`，剩余 1 个是第三方的 mc 插件（本就在 `C:\...\mc-companion`，不属于本仓库） | 实测 |
| Profile `link:` 依赖 | 4 个全部改指 `D:`，符号链接已重建并逐个验证 | 实测 |
| `config/suite.json` 的 `dsh.moduleRoot` | 已从 C 盘改指 `D:/DSH/dsh-production/data/host-runtime/node_modules` | 实测 |
| `docs/production-closeout-20261112.md:7` 的作者路径 | 已泛化，`author-path` 不再命中该文件 | 实测 |
| `dsh-bili-scroll` 指纹校验 | **新增只读校验器**，对当前安装副本判定 `hash-mismatch`（拒绝派发） | E1+E2 |
| B 站派发前置 | **已收紧**：provider 未就绪时 planner 拒绝、pump 跳过，留具名 code | E1+E2 |
| JSONL 降级 sink | **已改判**：`gated` + `local-only-jsonl`，不再记成 `contact-queued` | E1+E2 |
| 真实外发 / 重启宿主 | **未做**（按裁决不包含在本轮） | — |

---

## 1. 生产源码快进（已执行）

### 1.1 快进前状态

- 目标树 HEAD `ecde3ed`，`main` 分支，`git rev-list --left-right --count HEAD...origin/main` = `0 6`。
- 83 个脏条目（64 tracked modified + 19 untracked）。
- 阻塞集计算：49 个 tracked-modified 文件同时被上游改过，其中 **47 个与 `origin/main` 逐字节相同**
  （只是本地 mtime/换行归一造成的"看起来脏"），真正不同的只有 2 个 golden 快照：
  - `plugins/dsh-channel-qq/test/golden/config/layers.txt`
  - `plugins/dsh-channel-qq/test/golden/config/resolved.txt`
  这两个是本地 `song/separation.ts`（未跟踪）引入的 `separatorChunk/Overlap/Dtype/Device` 与
  `stt.backend/timeoutMs` 字段产生的快照，**属于本地工作，不能盲目合并**。
- 19 个 untracked 里 12 个在 `origin/main` 中已存在且逐字节相同；7 个是真正本地文件。

### 1.2 保全措施（任何覆盖前先落盘）

```
data\backups\pre-ff-20261114\
  tracked.patch              165,563 B   全部 tracked 改动的 unified diff
  staged.patch                     0 B   暂存区当时为空
  untracked-list.txt                      19 个未跟踪路径清单
  untracked\                    164,285 B  19 个未跟踪文件的实体副本
  files\                      1,374,161 B 83 个脏文件的完整快照
```

### 1.3 执行顺序

1. 47 个"与上游逐字节相同"的脏文件 `checkout HEAD --`（净变化为零）；
2. 2 个 golden 快照同样回到 HEAD（本地版本已在 `files\` 快照里）；
3. 12 个"上游已有且相同"的未跟踪文件删除（上游会在快进时重新落地）；
4. `git stash push -u` 收走剩余的 15 个 tracked 改动 + 7 个本地未跟踪文件；
5. `git merge --ff-only origin/main` → `ecde3ed` → `87b10b8`；
6. `git stash pop` 回填，`p2.mjs` 与上游的改动自动合并成功。

### 1.4 快进后验证

- HEAD `87b10b8`，`0 0`（与 `origin/main` 完全一致）。
- 12 个被删的未跟踪文件全部由上游重新落地并转为 tracked。
- `npm run build` 通过：expression / media / memory-studio / channel-qq 四个包全部 ok，其余声明"源码直接可加载"跳过。
- `npm run doctor`：核心检查通过（39 项，注意 3、未就绪 1）；宿主 CLI 入口解析到 `D:\DSH\...\dsh-desktop-host\lib\cli.js`。
- `dsh --dump-config`（Web CLI，`DSH_HOME=D:/DSH/dsh-production/data/home`）：14 个 distinct `file://` URL，**全部文件存在**。

> **我没有启动桌面版。** 生产宿主是 Web 版（`node .../@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3080`，
> PID 27232，2026-11-14 07:53 起动）。`--dump-config` 用的是同一个 Web CLI 包，只读、不加载插件。

### 1.5 恢复路径

`git stash list` 已为空（stash 回填后自动 drop，commit 记录在输出里）。若需回到快进前状态：
`data\backups\pre-ff-20261114\tracked.patch` 可 `git apply`，`untracked\` 与 `files\` 是逐字节实体副本。

---

## 2. 单一源码根（已执行）

### 2.1 发现：C 盘树其实已经是 D 盘树的联接

旧树 `<USERPROFILE>\Documents\Bot\dsh-production\` 下 `config`、`data`、`plugins` 三个目录是 **Junction**，
目标就是 `D:\DSH\dsh-production\` 下对应目录（创建于 2026-11-13 15:42）。实证：

```
写 C:\...\dsh-production\plugins\probe.txt  →  立刻能在 D:\DSH\dsh-production\plugins\ 看到
经 C: 与经 D: 读取 plugins/companion-runtime/lib/p2.mjs  →  SHA-256 完全相同（126,166 B）
```

也就是说"代码从 C 加载、数据在 D"这个描述在 **plugins/config/data 三层已经不成立**——两边是同一份文件。
真正还分叉的是**没有被联接的目录**（`docs`、`dsh-ops`、`scripts`、`tools`、`skills`、`sidecars`、`design`、`test`）。

### 2.2 本轮改动

| 位置 | 改前 | 改后 |
|---|---|---|
| `cordis.patch.yml` 的 13 个插件 URL | `file:///<旧树>/plugins/...` | `file:///D:/DSH/dsh-production/plugins/...` |
| `package.json` 的 4 个 `link:` 依赖 | `link:<旧树>/plugins/...` | `link:D:/DSH/dsh-production/plugins/...` |
| `node_modules/@dsh-companion/*` 4 个符号链接 | 指向 C 盘路径 | 重建为指向 D 盘路径（逐个 `New-Item -ItemType SymbolicLink` 并验证 `Target`） |
| `config/suite.json` `dsh.moduleRoot` | `<旧树>/data/host-runtime/node_modules` | `D:/DSH/dsh-production/data/host-runtime/node_modules` |

删除旧符号链接时逐个 `Remove-Item -LiteralPath`（非递归），并确认被指目标目录文件数前后一致（10 → 10），
没有连带删除任何东西。

备份：`data\home\profiles\companion\cordis.patch.yml.before-ff-20261114`、
`package.json.before-ff-20261114`、`data\backups\pre-ff-20261114\suite.json.pre-moduleRoot-edit`。

### 2.3 剩余的 1 个 C 盘 URL（不是缺陷）

```
cordis.patch.yml:83  name: file:///<第三方的 mc 项目>/dsh-plugin.mjs
```

这是**第三方的 mc-companion 插件**，本来就不住在本仓库里，与"单一源码根"无关。
若将来要统一，需要把那个项目也搬进 `D:` 或改成包依赖——属于另一个决定。

### 2.4 一处必须写明的现实

Profile 现在指向 D 盘，但**正在运行的宿主进程是 2026-11-14 07:53 启动的**，它加载的是旧配置里
C 盘路径的模块。因为 `plugins` 是 Junction，磁盘上是同一份文件，所以源码内容没有分叉；
但**加载时序**上，新配置要等宿主重启才生效。**本轮按裁决不重启**，因此：

- 结论 A（可断言）：磁盘上的源码与 profile 配置已收敛到单一根。
- 结论 B（不可断言）：运行中的进程已按新 profile 加载。这一条需要重启后才能验证，属于 E3/E5。

---

## 3. `dsh-bili-scroll` 指纹校验（新增）

### 3.1 实测事实

| 副本 | 字节 | SHA-256（前 16） | 含 provider publish |
|---|---|---|---|
| 当前安装（profile 内） | 211,655 | `784DFA675553D632` | **否** |
| 备份副本（`pnpm-store-repair-20261113`） | 213,810 | `127D04BE2FC842CB` | 是 |

两者 `package.json` 的 `version` **都是 `2.4.0`**。所以"版本号对了就算装对"是错的判据。

### 3.2 新增 `tools/verify-external-modules.mjs`

只读、不联网、不改文件。判据三条，按顺序：

1. 文件存在（否则 `file-missing`）；
2. `index.js` 的 SHA-256 与 `PINS` 里固定值一致（否则 `hash-mismatch`）；
3. 源码里存在 provider 注册表 publish 代码（`dsh.companion.bilibili.providers.v1` + `providers.set(`），
   否则 `provider-publish-absent`。

`PINS` 里钉的是**含 publish 的那一份**（`127d04be…`，213,810 B）。换版本或换 tarball 必须同时更新这里。

实测输出：

```
=== 外部模块校验（只读）===
模块根：D:/DSH/dsh-production/data/home/profiles/companion/node_modules
不通过  dsh-bili-scroll  code=hash-mismatch
        bytes=211655 sha256=784dfa675553d632… pinned=127d04be2fc842cb…
        安装副本与验收过的 tarball 不是同一份字节：同版本号不等于同一份代码
不通过：安装或更新时应拒绝，并明确报告该能力不可用（不要让 planner 照常派活）
```

配套测试 `tools/verify-external-modules.test.mjs`（5 条）覆盖 `file-missing` / `hash-mismatch` /
`provider-publish-absent` / `no-pin` / pin 自身的格式约束。

> 注：`provider-publish-absent` 这条分支在合成夹具里无法"伪造"出与 pin 相同的 SHA-256，
> 因此该测试用"字节不匹配 → 至少要被拒"的弱化断言覆盖，真正的 marker 判据由
> `requiresProviderPublish` + `PUBLISH_MARKERS` 的代码路径保证。这一点在测试注释里写明了。

---

## 4. B 站派发前置（已收紧）

### 4.1 缺陷

`capabilities.mjs` 一直会如实报 `bilibili.reason='provider-not-ready'`，`autonomy-materials.mjs`
的 `capabilityList()` 也把它传给 planner。但**派发闸门不查这个**：planner 排了 B 站 slot，
`pumpActivityStarts` 照常 `start()`，执行阶段必然失败——产出一条注定失败的活动行。

### 4.2 修法（两处，都只用既有判据）

1. **planner 侧**：`planner.mjs:560` 的 `biliAvailable` 判据本来就只看 `capabilities.bilibili.available === true`。
   runtime 把真实的 `false` 传进去之后，planner 会以 `invalid-plan: slot-target-not-in-materials:
   Bilibili duty is unavailable` 拒绝整份计划——而不是写一条执行不了的 slot。
2. **派发侧**：`startDueActivities` 在 `start()` 之前再验一次 `ports.runBilibili.available?.()`，
   未就绪就 `continue` 并记录 `lastStart.code='bilibili-provider-not-ready'` +
   `noteError('p2-activity-start-bilibili-provider-not-ready')`。

**没有**把 provider 未就绪做成整拍 defer：那会把 read/explore/write 一起停掉。
`dispatchWatch` 另外如实报一个 `bilibiliProviderReady` 字段，供诊断看。

### 4.3 证据（`test/p2-bilibili-provider-gate.test.mjs`，3 条）

- 未就绪：capability 报 `provider-not-ready`，planner 拒绝、无 slot 落库；
- 未就绪：即使强行 `startActivity({kind:'bilibili'})` 也被 `adapter-unavailable` 挡住，
  provider 一次没被调用，`p2_activities` 里 0 行；
- 就绪：capability 为 true，slot 正常进计划，`pump` 真的 start（防止修成"永远不派"）。

---

## 5. JSONL 降级 sink 改判（已执行）

### 5.1 缺陷

`contactSharePort` 在没有 contact 服务时会落本地 JSONL 队列，并按 `sink:'jsonl'` 上报
`ok:true, written:true`（`autonomy-share.mjs:204`）。runtime 只看 `ok`，于是**只写进本地日志的
候选被记成 `queued` + `contact-queued`**——状态说"已交给 contact"，实际只是本机一行 append。

### 5.2 裁决执行

状态词表**不变**，把它记成 `gated` + `local-only-jsonl`。`gated` 本来就是"没进 contact"，
而原因是具名的、可 grep 的。恢复（撤回/重新提交）由人决定，**不自动复活**。

两处同规则：

- `deliverShareCandidates`（批量泵）：`localOnly` 分支写 `gated` + `local-only-jsonl`，
  `out.gated += 1`、`out.localOnly += 1`、`out.reasons['local-only-jsonl'] += 1`，`out.queued` 不涨；
- `submitShareCandidate`（单条）：同样分叉，返回值不再声称 `accepted`，改为
  `{ accepted:false, localOnly:true, code:'local-only-jsonl', owner:'local-sink' }`。

真 contact（`sink` 缺失或 `sink:'contact'`）行为完全不变。

### 5.3 证据（`test/p2-share-local-only.test.mjs`，6 条）

`sink:'jsonl'` → `gated`+`local-only-jsonl`；无 `sink` / `sink:'contact'` → `queued`+`contact-queued`；
单条路径同规则；本地候选行不被删除；开关关闭时零行为（端口 0 调用、`localOnly` 0）。

> 生产库此时 `p2_share_candidates` 为 0 行，因此没有历史数据需要迁移或改判。

---

## 6. 作者路径清洗（已执行）

`docs/production-closeout-20261112.md:7` 的旧树绝对路径
改为 `C:[…]/Documents/Bot/dsh-production`（并补一句 2026-11-13 起 `config`/`data`/`plugins`
已成为指向 D 盘的联接），技术结论全部保留。**没有给扫描器加例外，也没有改测试夹具**。

清洗后 `npm run verify --only=static` 的结果：`author-path` 只剩
`tools/lib/host-temp.test.mjs:5` 一处，而那是 **upstream 自带的文件**（`git log` 指向
`f5590de fix(health): restore collector startup with native Node and external temp`），
本地未修改。它里面写的是 `<盘符>:/Users/<用户>/AppData/Local`——一个**通用测试夹具路径**（用户名就是字面量
`test`），不是作者身份泄漏。这属于上游需要自己处理的一项，本轮不代它改。

---

## 7. 仍然失败/未闭合的项

### 7.1 `safe-defaults.test.ts` 的前提缺陷（本轮已修）

`qq-idle-compaction：默认关` 这条测试的 ④ 段调用 `mod.apply(ctx)`，而 `apply()` 内部走
`decide()` 的**默认参数**——它会从包位置向上找 `dsh-companion-suite` 并读真的 `config/suite.json`。
在源码仓库里向上找不到套件根（默认关，断言成立）；在**部署形态**下本包就住在套件里，且生产
`suite.json` 的 `qqIdleCompaction=true`，于是 `apply()` 理所当然装那个 60 秒定时器 → 测试失败，
**但行为是对的**。

修法：把前提做真——用 `DSH_COMPANION_SUITE_ROOT` 指向一个只含 `package.json`（`name:
dsh-companion-suite`）、没有 `config/suite.json` 的空套件根，断言仍是"一个定时器都不许注册"。
不是放宽断言，是让测试测它自己声称的东西。修完该文件 6/6 通过。

### 7.2 `channel-qq` 套件的偶发失败

两轮 `npm run verify` 里出现过一次 `R5-2p 插件级：起草期间同一秒又来一条` 失败，紧接着的单包复跑
与下一轮全量 verify 都全绿（1906/1906）。判定为并行 `node --test` 争用下的偶发，
与 memory/runtime 之前见过的现象同类，未修。

### 7.3 `golden` 快照已按本地工作重生成（需评审）

`layers.txt` / `resolved.txt` 用 `UPDATE_GOLDEN=1` 重生成，diff 就是本轮本地 separation 工作引入的
字段。这不是"为了让测试变绿而改快照"——反过来，是快照落后于本地源码。**但这两个文件的 diff
必须由人评审**，因为它们是"这次到底改了什么行为"的唯一书面证据。

### 7.4 未做（按裁决不在本轮范围）

- **重启宿主**：新 profile 与新源码要重启后才真正生效。重启是操作者动作。
- **E3/E4/E5**：宿主加载、真实模型、真实外发一项都没做。
- **G/H 两包**（活跃工具策略、人格/提示去重）未启动。

### 7.5 本轮收尾时的验收数字

| 树 | unit | static | compose | 说明 |
|---|---|---|---|---|
| 生产 `D:\DSH\dsh-production`（`DSH_COMPANION_PERSONA_ID=bot`） | ok 9 / failed 0 / 无测试 1 | ok 38 / failed 1 | ok 1 / failed 0（231 loader 行） | 唯一失败是上游自带的 `author-path` |
| 工作区 `.agents\worktrees\dsh-55f1cc85-7db6` | ok 9 / failed 0 / 无测试 1 | ok 38 / failed 1 | 跳过（此树无 `config/suite.json`） | 同上 |

生产树若不设 `DSH_COMPANION_PERSONA_ID=bot`，foundation / memory-studio / channel-qq 会有断言失败：
生产 `config/suite.json` 的 `persona.id` 是另一个值，而测试夹具把 identity 写成 `bot`。
这是**夹具与部署配置的差异**，不是代码缺陷；跑离线验收时把 persona 显式对齐即可，不需要改生产配置。

---

## 8. 复核命令（全部只读）

```powershell
# 生产树与远端一致
git -C D:\DSH\dsh-production rev-list --left-right --count HEAD...origin/main   # 期望 0  0

# profile 单根（期望 C: 1 / D: 14，那 1 个是第三方 mc 插件）
$p = Get-Content D:\DSH\dsh-production\data\home\profiles\companion\cordis.patch.yml -Raw
"$(([regex]::Matches($p,'file:///C:/')).Count) / $(([regex]::Matches($p,'file:///D:/')).Count)"

# 外部模块指纹（期望 exit 1 + hash-mismatch，因为装的还是不含 publish 的那份）
node D:\DSH\dsh-production\.agents\worktrees\dsh-55f1cc85-7db6\tools\verify-external-modules.mjs `
  --module-root D:/DSH/dsh-production/data/home/profiles/companion/node_modules

# 生产树离线验收（persona 需与 suite.json 一致；生产 persona 是 suite.json 里那个 id，测试夹具写 bot）
$env:DSH_COMPANION_PERSONA_ID='bot'; npm --prefix D:\DSH\dsh-production run verify
```
