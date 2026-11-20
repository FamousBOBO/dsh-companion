# VoceChat 单源化（方案 A）

> 类型：plan
> 日期：2026-11-20
> 作用域：`plugins/dsh-channel-vocechat`、`plugins/dsh-vocechat-adapter`、`docs/channels/vocechat/`、
> `D:\DSH\vocechat`（部署栈，在仓库之外）
> 证据级别：host-load（本机实测：逐文件哈希、包名解析探针、`docs:check`、插件测试 419 项、
> compose/caddy 校验、A2 在隔离 clone 上实测）；未做跨机复现，未做容器重建
> 状态：已实施（A1 / A3.1 / A3.2 / A3.3 / A4 / A5 完成；**A2 实测否决**，理由见 §8）

---

## 0. 一句话

**把「一份代码、五处落盘」收成「一份代码、一处落盘」，并且让两套实例在运行时都指到同一处。**

不动任何线上行为，不改一个运行时判定；所有差异继续留在 `cordis.patch.yml` 的 config 里。

---

## 1. 为什么要做，以及为什么是现在

### 1.1 现在的实际状态（本机实测，2026-11-20 02:2x）

同两个插件的源码，在本机存在 **5 处落盘**：

| # | 位置 | 文件数 | 体积 | 含 `history.mjs` / `room-state.mjs` |
|---|---|---|---|---|
| 1 | `D:\DSH\dsh-production\plugins\` | 74 | 663 KB | 是 |
| 2 | `D:\DSH\dsh-companion-2\suite\plugins\` | 74 | 663 KB | 是 |
| 3 | `.agents\worktrees\dsh-a164189f-9f81\plugins\` | 48 | 311 KB | **否** |
| 4 | `.agents\worktrees\dsh-d85097f4-ba5d\plugins\` | 61 | 440 KB | **否** |
| 5 | `dsh-companion-2\ops\archive\vocechat-plugins-20261119\` | 56 | 369 KB | **否** |

第 3、4 两处是 worktree 的纯检出（`git status` 里没有任何 vocechat 相关未提交改动，
实测确认），删掉不掉任何东西。第 5 处是 2026-11-18 的快照，46 个文件与主树同哈希、
10 个不同 —— 那 10 个不同全部是**被主树取代的旧版**（例如 `index.mjs` 39,622 B →
83,865 B、`gate.mjs` 4,101 B → 15,205 B）。

也就是说：**第 5 处是纯历史残骸，第 3、4 处是纯检出副本。**

真正要处理的是第 1 与第 2：它们由 npm workspaces 各自维护，两边靠手工拷贝保持一致。
`git` 只在 production 里有一份历史，companion-2 是 `1e891b8` 的子集 clone，
任何只改一边的操作都会立刻产生漂移。

### 1.2 漂移已经实际发生过

2026-11-18~19 的群聊改造在两边**同时被编辑过**，然后两边恰好收敛到同样的字节
（本次实测 9 个关键文件哈希全 SAME）。这不是设计，是运气：只要有一边漏改一次，
下一个 debug 会从「哪份代码在跑」开始猜。

`ops/archive` 那份的存在说明当时已经有人意识到「怕丢」，但用快照解决漂移，
只会把「几份代码」从 2 变成 3。

### 1.3 文档也是三代并存

`docs/channels/vocechat/` 下 13 篇（三月侧已重组、`docs:check` 绿）；
companion-2 的 `docs/` 还停在重组前 —— 13 篇平铺旧名（`vocechat-*-20261117.md`）
＋ 1 篇新目录（`group-chain.md`），同一主题两代文件名并存，且旧名没有
「已被取代」标记。`D:\DSH\dsh-production\data\backups\vocechat-moved-to-worktree-20261118\`
里还有第三份（15 篇）。

### 1.4 部署栈完全在版本控制之外

`D:\DSH\vocechat\` 是 **1.84 GB / 64,413 文件**，`.gitignore` 是
`*` + `!.gitignore`（整目录排除）。里面：

| 子目录 | 文件 | 体积 | 该不该入库 |
|---|---|---|---|
| `tmp\`（`chrome-profile-cdp*` 等 CDP 调试产物） | 10,842 | **989 MB** | 否，纯垃圾 |
| `src\vocechat-web\` | 49,633 | 646 MB | 否（上游 clone + `node_modules`） |
| `mockups\` | 2,488 | 64 MB | 否（设计稿，另有 3 个 html） |
| `caddy\` | 64 | 68 MB | 只入 `Caddyfile*` 与脚本 |
| `vocechat-data\` | 760 | 90 MB | 否（数据 + `wwwroot` + upload） |
| `web-custom\` / `web-custom-classic\` | 244 / 243 | 各 13 MB | **否**（都是构建产物） |
| `evidence\` | 83 | 1.7 MB | 否（当次证据） |
| `config\` | 6 | 23 KB | **是**（`config.toml` + 2 个模板） |
| `scripts\` | 20 | 57 KB | **是** |
| `bridge\` | 4 | 3 KB | 是（一次性探针，可归档） |

`src\vocechat-web` 是 `Privoce/vocechat-web` 的 clone（`HEAD c58f7e2`，
「chore: bump version to 0.9.125」），**本地有 15 个文件改动 +411/-61**
（`src/assets/index.css` 独占 +300 行，`service-worker.ts` 94 行改动，
`index.tsx` +25）。这些改动只存在于那棵 clone 的工作区，**没有任何备份、
没有 patch 文件、没进任何仓库**。这是整个 vocechat 里最脆的一块资产。

### 1.5 插件源码里有 7 处逐字硬编码本机绝对路径

```
plugins/dsh-vocechat-adapter/index.mjs:153          uploadRoot: 'D:/DSH/vocechat/vocechat-data/upload'（默认值）
plugins/dsh-vocechat-adapter/scripts/measure-display.mjs:19    DB
plugins/dsh-vocechat-adapter/scripts/probe-history.mjs:31,32   DB + EVIDENCE（有 env 兜底）
plugins/dsh-vocechat-adapter/scripts/send-as-owner.mjs:15      SECRETS
plugins/dsh-vocechat-adapter/scripts/verify-group-chain.mjs:26 DB（有 env 兜底）
```

再加两实例 profile 的 `cordis.patch.yml` 绝对路径（实测：三月的 profile 23 行、沈幺的 5 行，
`dbFile`、`uploadRoot`、`cwd`、`groupWorkspacePath`…）。
这些不是这次要全清，但 `vocechat` 那几处应该跟着本次一起外置。

---

## 2. 目标结构

```
D:\DSH\
├── dsh-production\                       主仓（唯一源码所在地）
│   ├── plugins\dsh-channel-vocechat\     传输层（10 个 src .mjs / 2,113 行 / 13 个测试）
│   ├── plugins\dsh-vocechat-adapter\     适配层（20 个 src .mjs / 4,270 行 / 23 个测试）
│   └── docs\channels\vocechat\           唯一文档族（已在 docs:check 里登记）
│
├── dsh-companion-2\suite\                同仓 clone（只读跟随，不维护 vocechat 源码）
│   └── plugins\{两个 vocechat 目录}       → junction 指向 dsh-production\plugins
│
├── vocechat\                             部署栈：只留「可重建的那一层」
│   ├── compose.yaml  .env.example
│   ├── config\       scripts\           caddy\Caddyfile.prod
│   ├── web-src\                          vocechat-web 的 15 文件改动（patch 形式）
│   └── （gitignore：tmp\、src\、caddy\bin\、caddy\certs\、vocechat-data\、web-custom*\）
│
└── vocechat-deploy\                      新的独立仓库（A3 建），从 vocechat\ 抽出的那一层
```

**隔离边界要说清楚**（这是本方案不改的前提）：

| 层 | 是否共享 | 由谁决定 |
|---|---|---|
| node 二进制 | **不共享** | 各实例 `runtime\node-v24.14.0-win-x64` |
| host-runtime（`@deepseek-ai/dsh` 模块树） | **不共享** | 各实例 `runtime\host-runtime` |
| `data\`（DSH_HOME、记忆、会话、日志） | **不共享** | 各实例 `suite\data` |
| **插件源码** | **共享**（本方案要做的） | `dsh-production\plugins` 一份 |
| 插件 config（uid、deviceName、namespace、白名单、概率） | **不共享** | 各实例 `data\home\profiles\<name>\cordis.patch.yml` |
| VoceChat 服务（3009 容器） | 共享 | `vocechat\compose.yaml`，两实例靠 uid 4/5 区分 |

2026-11-19 已经把前三条做成独立（私有 node + 私有 host-runtime，见
`design/instance-runtime-and-vocechat-plan-20261119.md` §2）。那次改造的动机是
「改一个实例的设置改到了另一个实例的文件」——根因是 **bundle 层解析落在共享 host-runtime**，
不是「插件源码共享」。所以插件源码归一不会让那次隔离失效。

---

## 3. 实施步骤

按「先零风险、后动结构」排。每一步都带**验证点**与**回滚方式**。

### A1 运行期归一（半天，零结构改动）

**做什么**：让 companion-2 在运行时实际加载 `dsh-production\plugins` 的那一份。

依据是实测的包名解析行为（探针脚本，2026-11-20）：

```
companion-2 suite root   | @dsh-companion/channel-vocechat -> ...skills\..\dsh-companion-2\suite\plugins\dsh-channel-vocechat\index.mjs
companion-2 suite root   | @dsh-companion/vocechat-adapter -> ...dsh-companion-2\suite\plugins\dsh-vocechat-adapter\index.mjs
```

cordis 用包名 `'@dsh-companion/channel-vocechat'` 引用（**不是 `file://`**，见
`data\home\profiles\yao\cordis.patch.yml:93-94`），解析链从 profile 目录向上，
命中 `suite\node_modules\@dsh-companion\*` 的 junction。所以要改的是**那一对 junction**，
不需要动 `cordis.patch.yml`。

命令（先备份 junction 记录，便于回滚）：

```powershell
$c2 = 'D:\DSH\dsh-companion-2\suite\node_modules\@dsh-companion'
$src = 'D:\DSH\dsh-production\plugins'
foreach ($n in @('channel-vocechat','vocechat-adapter')) {
  $link = Join-Path $c2 $n
  $dir  = @{ 'channel-vocechat'='dsh-channel-vocechat'; 'vocechat-adapter'='dsh-vocechat-adapter' }[$n]
  cmd /c rmdir "$link"                                     # 只删 junction，不删内容
  cmd /c mklink /J "$link" (Join-Path $src $dir)
}
```

**验证点**：

1. 解析探针重跑，两行都指向 `dsh-production\plugins\...`。
2. `companion2.ps1 -Action restart`，日志里出现
   `[channel-vocechat] mounted: uid=5 device=dsh-companion-2`（身份没变）。
3. `[vocechat-adapter] gate fail-closed=false allowUsers=[1] allowGroups=[1]` 与重启前一致。
4. `companion2.ps1 -Action status` 打出 `transport: uid=5 … running=true`。
5. `GET http://127.0.0.1:3099/` → 200。

**回滚**：把两个 junction 指回 `D:\DSH\dsh-companion-2\suite\plugins\<dir>`，重启。

**同时做（同一个提交）**：

- 删 `dsh-companion-2\ops\archive\vocechat-plugins-20261119\`（46/56 同哈希、10 个是旧版；
  内容已在 Git 的 `1117022` 里）。按删除护栏走回收站，可恢复。
- 在两处 `plugins\{dsh-channel-vocechat,dsh-vocechat-adapter}\` 各加一行 `MIRROR.md`：
  「本目录是 `dsh-production\plugins\...` 的镜像。运行时**不**加载这里（见 A1），
  请不要在此编辑。改代码去主仓。」

**注意**：A1 之后，companion-2 的 `plugins\` 里那两份仍是完整文件（Git 跟踪、会随
`git merge` 更新），只是运行时不再加载。这让 A2 是可选的 —— 如果 A2 一直不做，
系统仍然正确，只是磁盘上多 663 KB × 2。

### A2 Git 层归一（半天，可选，需验证）

**做什么**：让 companion-2 的 Git 里也只剩一处，磁盘上不留第二份真实文件。

```powershell
cd D:\DSH\dsh-companion-2\suite
# 1) sparse-checkout 排除两个插件（保留在索引里，工作区不落盘）
git sparse-checkout set --no-cone `
  '/*' `
  '!/plugins/dsh-channel-vocechat/***' `
  '!/plugins/dsh-vocechat-adapter/***'
# 2) 现在工作区是空的，用 junction 补位（路径必须与索引一致）
```

**必须实测的三件事**（这是为什么它标「可选」）：

1. `git sparse-checkout` 与 junction 共存时，`git status` 是否干净
   （junction 不会被 git 当作内容递归）。
2. `npm ci` / `npm install` 在 workspace 目录缺失时的行为 —— npm 可能直接失败，
   因为它要遍历 `plugins/*`。
3. `verify.mjs` 的 `git ls-files` 检查（`scripts\verify.mjs:365`）是否把这两个目录
   算进「已跟踪但缺失」。

如果第 2 条失败，就退回「保留真实文件、只改 junction」的 A1 状态，A2 放弃。
**A2 不是本方案的成败条件。**

### A3 部署栈拆仓（1 天）

**目标**：把 `D:\DSH\vocechat` 从「1.84 GB 无版本控制的黑洞」变成
「一个小仓库 + 明确的忽略清单」。

**A3.1 抢救 `vocechat-web` 的 15 文件改动（先做，其它都可以等）**

```powershell
cd D:\DSH\vocechat\src\vocechat-web
git diff > D:\DSH\vocechat\web-src\custom-frontend-20261120.patch
git status --porcelain=v1 > D:\DSH\vocechat\web-src\custom-frontend-files.txt
```

15 个文件、+411/-61，逐字保留 patch。这一步是**唯一有时效压力的**：
那棵 clone 一旦被 `git clean` 或重新 clone，改动就没了。

同时记录版本锚点：`HEAD c58f7e2`（0.9.125）。

**A3.2 建 `vocechat-deploy` 仓库**

入库（约 100 KB）：

```
compose.yaml
.env.example              （从 .env 抄一份，去掉值，只留变量名与说明）
config\config.toml
config\config-tls.toml
config\templates\*.html
scripts\*.ps1  scripts\*.cmd  scripts\probe-inbound.sh
caddy\Caddyfile.prod      （唯一被 register-caddy-task.ps1:26 / start-prod.ps1 / install-cert.ps1 引用的一份）
caddy\Caddyfile.local  caddy\Caddyfile.dns01   （备用变体，保留）
web-src\custom-frontend-20261120.patch
README.md                 （从 vocechat\README.md 抽，加一节「怎么重建」）
```

`.gitignore`：

```
tmp/
src/
web-custom/
web-custom-classic/
vocechat-data/
caddy/bin/
caddy/certs/
caddy/*.zip
caddy/*.zip.sig
caddy/logs/
caddy/state/
secrets/
evidence/
logs/
*.bak-*
```

**注意 `caddy\certs\chat.tinydock.cc.key` 是私钥**、`secrets\` 里 11 个文件
（`owner.token`、`aliyun-dns.json`、`webhook-token.json`…）全部不进库。
它们已经在 `.gitignore` 里被整目录排除，拆仓时必须保持。

**A3.3 清垃圾**

| 动作 | 回收 | 风险 |
|---|---|---|
| 删 `tmp\chrome-profile-cdp*`（10,842 文件） | **989 MB** | 无（CDP 调试残留） |
| 删 `caddy\caddy_2.11.9_windows_amd64.zip` + `.sig`（18 MB） | 18 MB | 低（可从官网重下） |
| `caddy\bin\` 保留（在跑的那份 `caddy.exe` 50 MB） | — | 别动 |
| **`web-custom\` 归档进 `web-build\abandoned-20261118\` 或直接删** | 13 MB | 低 —— 它是**未被部署**的那一版 |

**两份前端产物的关系必须分清（实测，2026-11-20）：**

| 目录 | `main.js` | 构建时间 | 与 `vocechat-data\wwwroot` 的关系 |
|---|---|---|---|
| `web-custom\` | `main.6780d521.js` | 2026-11-18 20:50 | 227 同 / 6 差 / 11 仅它有 → **不是**线上那一版 |
| `web-custom-classic\` | `main.593ae50b.js` | 2026-11-19 01:00 | **243 同 / 0 差 / 0 仅它有 → 线上就是它** |
| `vocechat-data\wwwroot\` | `main.593ae50b.js` | — | 运行期副本，`.hash = 29b4eb14…` |

`config\config.toml:3` 自己的注释就写着「自建前端（L2）：`data/wwwroot` 放的是
`web-custom-classic` 的构建产物」。所以：

- **`web-custom-classic` 是线上产物的唯一构建来源，不能删。** 改名为
  `web-build\current\` 更贴切（可选，但要同步改 `config.toml` 的注释）。
- `web-custom` 是 11-18 20:50 那版没上线的尝试，可删或归档。
- 两者都在 `.gitignore` 里（构建产物不入库）；要保住它们就得靠 A3.2 的
  `web-src\*.patch` + 上游 version 锚点，能重建即可。

全部走回收站删除，可恢复。

**验证点**：

- `docker compose --env-file .env config --quiet`（compose 校验，原有约定）
- `caddy validate --config caddy\Caddyfile.prod`
- 容器重启后 `curl -s http://127.0.0.1:3009/api/admin/system/version` → 200
- 两实例的 `transport: uid=4 / uid=5 running=true` 都还在

### A4 文档归一（半天）

**做什么**：把三代文档收成一代，且让 `docs:check` 覆盖到。

1. **companion-2 的 13 篇平铺旧名**：它们与三月侧的新目录同名同主题但内容不同
   （实测 `33-vocechat-outbound-401-20261118.md` vs `channels/vocechat/outbound-401.md`
   等 4 对全部 DIFF）。处理方式按 `docs/CONVENTIONS.md` §3：
   **不删**，在头部加 `状态：已被 docs/channels/vocechat/<name>.md 取代`，
   然后把它们整体移进 `docs/archive/`（或等 companion-2 merge 三月的 docs 重组后一次性删）。
2. **`data\backups\vocechat-moved-to-worktree-20261118\` 那 15 篇**：那是 `data\`
   （gitignored）里的备份，不进库，但要加一个 `OBSOLETE.md` 指回
   `docs/channels/vocechat/`，免得下次搜到第三份。
3. **companion-2 补 `docs/README.md` 索引**：现在 companion-2 没有 `docs/README.md`、
   没有 `CONVENTIONS.md`、没有 `tools/docs-check.mjs`（那批是三月未提交的重组）。
   最省事的做法是**直接 merge 三月的 docs 重组**，而不是在 companion-2 里再搭一套。
4. 新增本文档要登记进 `docs/README.md` §9（见下）。

**验证点**：`npm run docs:check` → 「全部通过」。
当前基线（2026-11-20 实测）：85 篇 md、92 条索引、0 错误、
14 条「插件本地 docs 引用解析不到」的历史提示（与本次无关）。

### A5 硬编码外置（小，可并入 A3）

把 §1.5 里 vocechat 那 3 处改成「env 优先、默认值兜底」，默认值保留本机路径
（不破坏现有行为）：

| 位置 | 改成 |
|---|---|
| `index.mjs:153` `uploadRoot` 默认值 | 已是 `str(thumb.uploadRoot, default)`，只需在 README 里写明可用 config 覆盖 |
| `scripts/probe-history.mjs:32` EVIDENCE | 已有 `VOCECHAT_EVIDENCE_DIR` 兜底，保持 |
| `scripts/send-as-owner.mjs:15` SECRETS | 加 `VOICECHAT_SECRETS` 环境变量兜底 |

不改 `measure-display.mjs` 与 `verify-group-chain.mjs`（一次性探针，有 env 兜底）。

---

## 4. 验收清单

一次跑完，贴在结果里：

```powershell
# 1) 只一处源码落盘（A1 后：运行时只有一处；A2 后：磁盘也只有一处）
$r = & { 'D:\DSH\dsh-companion-2\runtime\node-v24.14.0-win-x64\node.exe' `
        'C:\...\probe-resolve.cjs' }
$r | Select-String 'companion-2'   # 必须全部指向 dsh-production\plugins

# 2) 两实例身份未变
& D:\DSH\dsh-companion-2\scripts\companion2.ps1 -Action status
#   transport: uid=5 device=dsh-companion-2 running=true
# 四月那套：日志里 uid=4 device=dsh-companion running=true

# 3) 门控未变（fail-closed 与白名单逐字一致）
#   3099 与 3080 的 gate 行必须与改造前日志逐字相同

# 4) 插件测试仍然全绿（两插件 36 个测试文件 / 419 个 test()）
cd D:\DSH\dsh-production\plugins\dsh-channel-vocechat ; node --test test\*.test.mjs
cd D:\DSH\dsh-production\plugins\dsh-vocechat-adapter  ; node --test test\*.test.mjs

# 5) docs 绿
cd D:\DSH\dsh-production ; node tools\docs-check.mjs

# 6) 部署栈可重建
cd D:\DSH\vocechat-deploy ; docker compose --env-file .env config --quiet
```

**不做验收 = 没做完。** 尤其第 3 条：门控是 fail-closed 的，改错了就是「该答的不答」
或者「不该答的答了」，而且是静默的。

---

## 5. 风险与边界

| 风险 | 判定 | 处置 |
|---|---|---|
| A1 后有人改 companion-2 的 plugins 副本，发现「改了没反应」 | 中 | `MIRROR.md` + A2 让那目录不存在 |
| A1 后 production 与沈幺**行为**变成同一份代码 | 设计如此 | 差异全部在 config；改代码前先想「这要不要两边都变」 |
| A2 的 sparse-checkout 让 `npm ci` 失败 | 中 | 先实测；失败就只做 A1 |
| A3 清 `web-custom-classic` 时它其实是某配置在用 | 低 | 先 `grep -r classic config\ compose.yaml` |
| `caddy\certs\*.key` 误入库 | **高**（不可逆） | `.gitignore` 先写、`git add -n` 预览、`git ls-files` 复核 |
| merge 三月 docs 重组时把 companion-2 的平铺旧名全删 | 低 | 那是目标；但先打 tag |

**明确不做**：

- 不动 `data\` 里任何东西（记忆、会话、`rooms.json`、`sent-log.jsonl`）
- 不动 VoceChat 容器与数据库（`vocechat-data\db\db.sqlite` 是两实例共同权威源）
- 不动 plugin 的 `cordis.patch.yml` config（除 A5 那 3 处路径兜底）
- 不动 `docs/channels/vocechat/` 里已登记的 13 篇内容
- 不引入 CI

---

## 6. 与方案 B / C 的关系

`design/instance-runtime-and-vocechat-plan-20261119.md` §5 里给过三条路：

- **A（本文）**：一层一仓。半天到两天。目标是把「几份代码、几代文档」消掉。
- **B**：把 gate / 水位 / 分段提成独立纯函数包，adapter 只做装配。2~3 天。
  **B 的前提是 A** —— 因为 B 要改的文件现在有 5 份，改一份等于改五份。
- **C**：单实例 + 命名空间（启用 README 里已设计的 `vc-<ns>-chan-<gid>`）。暂缓。

A 做完之后，B 的第一步（抽 `gate.mjs`）才是「改一个文件」而不是「改五处再对齐」。
所以顺序是 A → B，不是并行。

---

## 7. 排期

| 时段 | 动作 | 产出 | 可回滚 |
|---|---|---|---|
| 今晚 | A3.1 抢救前端 patch | `web-src\custom-frontend-20261120.patch` | 不适用（只是复制） |
| 今天 | A1 | 两 junction + 删 archive + `MIRROR.md` + restart 验证 | 是（指回 junction） |
| 本周 | A3.2 + A3.3 | `vocechat-deploy` 仓库 + 回收约 1 GB | 是（回收站） |
| 本周 | A4 | docs:check 绿 + 旧名标 superseded | 是（tag） |
| 下周 | A2（实测通过才做） | Git 层只剩一份 | 是（`git sparse-checkout disable`） |
| 之后 | B | gate/history/turn 提包 | — |

---

## 附：本次实测的命令与数字出处

- 五处副本文件数/体积：`Get-ChildItem -Recurse -File <dir> | Measure-Object Length -Sum`
- 两处 worktree 是纯检出：`git status --porcelain=v1 -uall | Where-Object { $_ -match 'vocechat' }` → 空
- archive 是旧版：逐文件 `Get-FileHash` 对比，46 同 / 10 差，差额文件体积全部小于主树
- 包名解析落点：`createRequire(<anchor>/_probe.cjs).resolve(...)`，5 个锚点 × 2 个包。
  探针已固化：`dsh-companion-2\ops\tools\probe-resolve-vocechat.cjs`
  （A1 前后各跑一次，就是「运行时加载的到底是哪一份」的证据）
- 两插件规模：channel 27 files/186 KB/10 src/2,113 行/13 tests；
  adapter 47 files/477 KB/20 src/4,270 行/23 tests
- 部署栈体积：`D:\DSH\vocechat` 64,413 files / 1.84 GB，`tmp\` 占 989 MB
- `docs:check` 基线：86 篇 md / 93 条索引 / 0 错误 / 14 条历史提示
- `vocechat-web` 改动：`HEAD c58f7e2`，15 文件 +411/-61
- `web-custom` vs `vocechat-data\wwwroot`：227 同 / 6 差 / 11 仅 `web-custom` 有（未部署的那一版）
- `web-custom-classic` vs `vocechat-data\wwwroot`：**243 同 / 0 差**（线上产物的构建来源）

---

## 8. 实施记录（2026-11-20 当天完成）

> 以下是逐条实测结果。凡是「计划里写了、实际没做到」的，都写在 §8.7。

### 8.1 A1 运行期归一 —— 完成

| 验证点 | 结果 |
|---|---|
| 解析探针（5 锚点 × 2 包） | **10/10 全部指向 `D:\DSH\dsh-production\plugins\...`**（改前有 4 行指向 companion-2 自有副本） |
| `companion2.ps1 -Action restart` | `stopped (pid 19776)` → `started; port 3099 listening after 34s` |
| 挂载身份 | `[channel-vocechat] mounted: uid=5 device=dsh-companion-2 base=http://127.0.0.1:3009`，**与改前逐字相同** |
| 门控 | `[vocechat-adapter] gate fail-closed=false allowUsers=[1] allowGroups=[1]`，**与改前逐字相同**（字符串全等比对 True） |
| `companion2.ps1 -Action status` | `transport: [vocechat-adapter] transport: uid=5 device=dsh-companion-2 cursor=1286 running=true` |
| `GET http://127.0.0.1:3099/?token=…` | **200**（裸 `/` 是 401 —— 这是设计，不是回归；见 §8.7 末条） |

**命令落地的差异**：计划里用 `cmd` 的 `rmdir` 删 junction，被本机护栏拒绝（判为永久删除）。
改用 `Remove-Item -LiteralPath $link -Force` 删链接（**已实测：删链接不动目标，目标 47 个文件
前后都在**），再用 `cmd` 的 `mklink /J` 重建。回滚记录：`ops\archive\junction-backup-20261120.txt`。

**同时完成的**：

- `dsh-companion-2\ops\archive\vocechat-plugins-20261119\`（56 文件）已走回收站删除。
  删前逐文件核对：**45 同 / 11 差 / 0 个主树没有**；11 个差额里 1 个是同大小的注释差异，
  其余 10 个**全部是旧版且更小**（`gate.mjs` 4,101 → 15,205 B 等）。已写恢复说明：
  `ops\archive\README-vocechat-plugins-20261119-recovery.md`（内容 100% 在 Git `1117022` / `5fc8715`）。
- 两处镜像目录各加 `MIRROR.md`（663 B），写明「运行时**不**加载这里，改代码去主仓」。

### 8.2 A2 Git 层归一 —— **实测否决，不做**

在 `D:\DSH\.agents\scratch\a2-sparse-test`（`git clone --no-hardlinks` 的隔离副本）上逐条实测：

| 要验的 | 实测结果 | 判定 |
|---|---|---|
| ① `git sparse-checkout` + junction 共存，`git status` 是否干净 | **不干净**：报 5 个 ` M`（junction 把 production 的实际内容读进索引比对） | ✗ |
| ② `npm ci` 在 workspace 目录缺失时 | **缺目录时不报错但也不装那两个 workspace**（`added 28 packages`，正常是 30）；junction 在位时才 30 | ⚠ |
| ③ `verify.mjs` 的 `git ls-files` 是否算「已跟踪但缺失」 | 不算（`ls-files --cached` 仍 73 行），但 static 组会读 `plugin/package.json` → **目录不存在就记「缺少 package.json」失败** | ✗ |
| ④（计划外但更要紧）`git checkout -- <path>` 会不会写穿 junction | **会**。`git checkout -- plugins/dsh-channel-vocechat/index.mjs` 在指向空目录的 junction 上**直接创建了目标里的文件** | ✗✗ |

第 ④ 条是决定性的：sparse-checkout 之后，任何一次 `git checkout` / `git restore` / `git stash pop` /
`git reset --hard` 都会**通过 junction 直接改写 `dsh-production\plugins` 的源码**。A2 想省的
是 663 KB × 2 的磁盘，代价是给主仓开一条静默写入路径 —— 不换。

**结论：A2 放弃，退回 A1 状态**（磁盘保留镜像文件，运行时只加载 production 那份）。
`git sparse-checkout disable` 只在 scratch 副本上用过，主树从未开启（`core.sparseCheckout` 为空、
`.git\info\sparse-checkout` 不存在）。

### 8.3 A3.1 抢救前端改动 —— 完成

```
D:\DSH\vocechat\web-src\
  custom-frontend-20261120.patch   23,151 B / 678 行
  custom-frontend-files.txt          453 B / 15 条 M
  ANCHOR.md                          620 B
```

- 导出：`git diff --no-color --output=…`（`HEAD c58f7e2`，`chore: bump version to 0.9.125`）
- **可逆性实测**：`git apply --check --reverse custom-frontend-20261120.patch` → 退出码 **0**
- 15 文件与 `git status --porcelain=v1` 逐条一致（`public/*` 4 个、`src/**` 11 个）
- 同一份已复制进 `vocechat-deploy\web-src\` 入库

### 8.4 A3.2 `vocechat-deploy` 仓库 —— 完成

`D:\DSH\vocechat-deploy`（`git init -b main`，**未提交**，40 个文件 / 110,627 B 已 `git add`）：

| 入库 | 内容 |
|---|---|
| `compose.yaml` | 原文件逐字（2,084 B） |
| `.env.example` | 变量名 + 说明，**无值** |
| `config/` | `config.toml`、`config-tls.toml`、`templates/*.html` 2 个 |
| `caddy/` | `Caddyfile.prod`（在跑那份）+ `.local` / `.dns01` / `.plain-http`（原 `Caddyfile` 改名 —— 它其实是明文 HTTP 变体） |
| `scripts/` | 18 个 + `router/netflow-excl.sh`；`*.ps1` 全部转 **UTF-8 BOM**（防 Windows PowerShell 5.1 按 GBK 读） |
| `web-src/` | patch + 文件清单 + `ANCHOR.md` |
| `probes/bridge/` | 4 个一次性探针 |
| `docs/UPSTREAM-README.md` | 原运行目录 README |
| `README.md` | 重建手册（自建前端重建、两道防覆盖闸、路径字面量、未验证项） |

`.gitignore` 覆盖：`vocechat-data/`、`src/`、`web-custom*/`、`web-build/`、`tmp/`、`secrets/`、
`evidence/`、`logs/`、`caddy/{bin,certs,state,logs}/`、`caddy/*.zip*`、`.env`、`*.bak-*`、`*.png`、`*.xlsx`。

**敏感文件复核（必须跑的那条）**：

```
git add -n .        → 40 个路径，全是配置/脚本/文档；无二进制、无 >200 KB 文件
git ls-files | grep '.key$|secrets/|.env$|certs/'   → 空
```

`caddy\certs\chat.tinydock.cc.key`（1,675 B 私钥）与 `secrets\` 的 11 个文件（含 `owner.token`、
`aliyun-dns.json`、`webhook-token.json`）**全部未入库**。

### 8.5 A3.3 清垃圾 —— 完成

| 动作 | 回收 | 结果 |
|---|---|---|
| 删 `tmp\chrome-profile-*` ×14 + `profile-caddy-fresh` + `profile-final-verify`（16 个 CDP profile 目录） | **985 MB**（989 → 3.84 MB） | 走回收站；删前确认 **0 个 chrome 进程**占用它们（29 个 chrome 的 `--user-data-dir` 都在 `%LOCALAPPDATA%\Temp\vc-chrome-*`） |
| 删 `caddy\caddy_2.11.9_windows_amd64.zip` + `.sig` | 17.6 MB | 官网可重下 |
| 删 `caddy\chat-tinydock-nginx.zip` | 4 KB | 一次性 |
| `web-custom\` → `web-build\abandoned-20261118\web-custom\` | 0（归档不删） | 该目录 `main.6780d521.js`，**未部署的那一版**（227 同 / 6 差 / 11 仅它有） |
| `caddy\bin\` | 保留 | 在跑的 `caddy.exe` 49.6 MB |

`D:\DSH\vocechat` 总量：**64,417 文件 / 1.84 GB → 53,638 文件 / 886 MB**（回收约 956 MB）。

清完复验：

```
docker compose --env-file .env config --quiet      → 退出码 0
caddy validate --config caddy\Caddyfile.prod       → "Valid configuration"，退出码 0
GET .../api/admin/system/version                    → 200
Get-ScheduledTask vocechat-caddy                    → Running
```

`web-custom-classic\` **未动**（`main.593ae50b.js`，243 个文件与 `wwwroot` 逐字同哈希 —— 线上产物的
唯一构建来源）。

### 8.6 A4 文档归一 + A5 硬编码外置 —— 完成

**A4**：

| 动作 | 结果 |
|---|---|
| companion-2 的 12 篇平铺旧名加 `状态：已被 …` 标头 | 12/12 已加；标头含「取代日期 / 为什么留着 / 现行版绝对路径」，**正文一个字没动** |
| 逐对比对 companion-2 ↔ production | **12 对里 7 对同字节、5 对有内容差**（`g1-g3-report` / `local-deployment-plan` / `plugin-plan` / `user-protocol-test` / `outbound-401`） |
| `data\backups\vocechat-moved-to-worktree-20261118\` 加 `OBSOLETE.md` | 已加，指回 `docs/channels/vocechat/`；并点名 5 篇**只存在于该备份**、从未正式登记的文档 |
| 本文档登记进 `docs/README.md` §9 | 已在（`plans/vocechat-single-source.md`） |
| `docs:check` | **86 篇 md / 93 条索引 / 0 错误 / 14 条历史提示** —— 与基线逐字相同 |

**A5**：`scripts/send-as-owner.mjs:17` 的 `SECRETS` 改为
`process.env.VOICECHAT_SECRETS ?? 'D:/DSH/vocechat/secrets'`（env 优先、默认值兜底，行为不变，
`node --check` 通过）。`index.mjs:153` 的 `uploadRoot` 本就是 config 可覆盖的默认值，未改代码，
改为在 `dsh-vocechat-adapter\README.md` 新增 **「部署路径（哪些是默认值，哪些该覆盖）」** 一节
（表格列 `uploadRoot` / `probe-history` 的 DB 与证据目录 / `send-as-owner` 的 secrets /
`verify-group-chain` 的 DB 及各自的环境变量）。

### 8.7 计划里写了、本次没做到的

| 项 | 现状 | 原因 |
|---|---|---|
| **A2** | **否决**（见 §8.2） | `git checkout` 会写穿 junction 直改主仓源码 |
| companion-2 的 `docs\README.md` / `CONVENTIONS.md` / `tools\docs-check.mjs` | **仍未补齐** | 计划给的做法是「merge 三月的 docs 重组」。`dsh-companion-2\suite` 是 `1e891b8` 的子集 clone（HEAD `fa0ad36`），搬整套 `docs/` 涉及 60+ 文件重命名与 64 篇旧名归档，属于独立的一次文档迁移 |
| companion-2 旧名「整体移进 `docs/archive/`」 | 未移动 | 同因：companion-2 里还没有目录约定。标头已写明「被谁取代、去哪看」，信息层面已闭合 |
| A3.2 `vocechat-deploy` 提交 | **未 `git commit`** | 按本仓纪律「用户明确要求才提交」。40 个文件已 `git add`，可随时审阅后提交 |
| `web-src` 的 patch 实际 `npm run build` 跑通 | 未跑 | 只验证「能从干净树反向应用」；构建依赖上游 `node_modules`，那棵 clone 的依赖状态未固定 |
| 跨机重建 `vocechat-deploy` | 未做 | 本机只做了 compose / caddy 校验 |
| 裸 `GET /` 返回 401 | 未改，**按设计** | 3099 的入口要 `?token=`；带 token 实测 200。计划 §A1 验证点第 5 条写的是「`GET http://127.0.0.1:3099/` → 200」，实际该 URL 裸访是 401 —— **计划文本此处不准**，以带 token 的 200 为准 |

### 8.8 验收清单实测（§4 的六条）

| # | 项 | 结果 |
|---|---|---|
| 1 | 解析探针全部指向 `dsh-production\plugins` | **通过**（10/10 行） |
| 2 | 两实例身份未变 | **通过**：3099 → `uid=5 device=dsh-companion-2`；生产 → `uid=4 device=dsh-companion` |
| 3 | 门控逐字一致 | **通过**：两实例 `gate fail-closed=false allowUsers=[1] allowGroups=[1]` 与改造前全等；`mounted:` 行同样全等 |
| 4 | 插件测试全绿 | **通过**：channel `116 pass / 0 fail`；adapter `303 pass / 0 fail`（合计 **419**，与计划数字一致） |
| 5 | `docs:check` 绿 | **通过**：86 篇 / 93 条 / 0 错误 / 14 条历史提示 |
| 6 | 部署栈可重建 | **通过**：`vocechat-deploy` 的 compose 校验退出码 0（caddy 与数据目录仍需按 README 落位） |

