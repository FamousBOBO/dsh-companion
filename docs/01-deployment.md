# 01 · 部署

> 面向「拿到这个仓库、替用户把套件部署起来」的 DSH。按本文顺序执行，不要跳步。
> 本文与根 `AGENTS.md` 是同一套口径；两处若出现不一致，以本文为准并请提 issue。

## 0. 先看清边界

| 本仓库**有** | 本仓库**没有** |
|---|---|
| 12 个发布模块的源码、侧车（sidecar）源码、配置模板、部署与运维文档、CI | DSH 宿主本体、Node 运行时、模型、模型密钥、安装器 |
| 套件 CLI（`scripts/*.mjs` + `tools/lib/*`） | 任何真实业务数据（`data/` 全部 gitignore） |

因此部署 = **在用户已有的 DSH 桌面上，把本套件装进它自己的 home / profile / 工作区**。
套件不覆盖、不改写用户已有的 DSH 安装与已有 profile。

## 1. 前置条件

| 项 | 要求 | 检查方法 |
|---|---|---|
| Node.js | **>= 24.0.0** | `node --version` |
| npm | >= 10 | `npm --version` |
| DSH 宿主 | DeepSeek Harness 桌面版；已验证基线 `0.2.1-rc.3`，最低 `0.2.0` | 见 §5 |
| 磁盘 | 源码 + 依赖约 1 GB；`data/` 随使用增长 | — |
| 平台 | Windows 为**实机验收**平台；Linux/macOS 由 CI 验证构建与离线测试 | 见 §8 |

### 1.1 为什么必须是 Node 24（不能用 20/22）

记忆引擎与认知运行时直接使用 Node 内置的 `node:sqlite`（`DatabaseSync`）：

- Node **20 根本没有**这个内置模块，`import('node:sqlite')` 直接失败；
- Node **22 需要** `--experimental-sqlite` 启动开关，命令行一多就漏；
- Node **24** 才免开关直接用。

所以根 `package.json` 声明 `engines.node >= 24.0.0`。记忆模块遇到不支持的运行时会**降级并报错**
（不崩溃），但降级后没有长期记忆——这不是可用状态。CI 只用 24.x。

> 本套件编写时所在机器的实测运行时：`node v24.14.0` / `npm 11.9.0`。

## 2. 部署流程（七步，顺序固定）

```bash
git clone <本仓库地址> dsh-companion
cd dsh-companion

npm ci                  # 1. 按锁文件装依赖
npm run build           # 2. 构建（仓库只存源码，不构建入口文件不存在）
npm run doctor          # 3. 只读诊断（先诊断，再改动任何东西）
npm run setup           # 4. 初始化本地目录、配置模板、独立 profile
npm run start           # 5. 启动本套件自己的 DSH 环境
npm run verify          # 6. 发布要求的离线检查与测试
```

**为什么是这个顺序**（不是随便排的）：

1. `build` 在 `doctor` 之前：仓库不存构建产物，未构建时插件的 `main` 指向的文件不存在，
   `doctor` 会报「模块入口缺失」——那是假故障。
2. `doctor` 在 `setup` 之前：先只读诊断，确认宿主位置、Node 版本、配置合法性再动磁盘。
   `setup` 会创建目录与模板，出问题更难回溯。
3. `start` 在 `verify` 之前：先确认能起来，再跑全量检查；`verify` 的 `compose` 段需要宿主。

---

## 3. 每一步做什么、预期什么、失败怎么办

> 下面「预期输出」是各命令的**输出契约**（实现见 `scripts/setup.mjs`、`scripts/doctor.mjs`、
> `scripts/start.mjs`、`scripts/verify.mjs`）。它们描述的是**必须报告的信息**，具体排版可能变。

### 3.1 `npm ci`

- **做什么**：按 `package-lock.json` 装开发与构建依赖，覆盖 `plugins/*` 各 workspace。
- **预期**：Exit 0；`node_modules/` 出现。**不产生任何 `data/` 内容**，不联网访问模型。
- **失败**：

| 现象 | 原因 | 处理 |
|---|---|---|
| `EBADENGINE` / engines 报错 | Node 版本过低 | 换 Node 24（§1.1） |
| `npm ci can only install with an existing package-lock.json` | 锁文件缺失 | 说明拿到的是不完整副本；`npm install` 会生成新锁文件但**不保证可复现**，请找维护者要锁文件 |
| `EACCES` / `EPERM`（Windows） | 目录权限、杀软或 OneDrive 占用 | 换到普通本地目录重试 |
| 网络超时 | 代理 / 镜像 | 配 npm 镜像后重试；本套件无私有 registry 依赖 |

### 3.2 `npm run build`

- **做什么**：构建全部发布模块（TypeScript 模块编译、UI 客户端打包、注入器打包）。
- **预期**：Exit 0。构建产物落在各模块的 `build/` 或 `lib/` 下（**这些都不入库**）。
- **关键检查**：构建后各模块 `package.json` 的 `main` 指向的文件必须存在。`doctor` 会逐模块报。
- **失败**：

| 现象 | 处理 |
|---|---|
| `tsc` 报类型错误 | 记录完整输出提 issue；不要改 `tsconfig` 绕过 |
| 某个模块构建脚本找不到 `bash` | 该模块的构建脚本应当已改为跨平台 node 脚本；若仍看到 `bash`，见 `docs/03` 的已知问题 |
| 产物缺失但 Exit 0 | 跑 `npm run doctor` 定位是哪个模块的 `main` 不存在 |

### 3.3 `npm run doctor`

- **做什么**：**只读**检查。不创建、不修改任何文件。
- **必须报告的内容**：

| 项 | 说明 |
|---|---|
| Node / npm 版本 | 低于 24 必须判为阻断 |
| 宿主可执行文件 | 找到的路径 + 来源（`config` 显式配置 / `probe` 自动探测 / 未找到） |
| 宿主版本与兼容性 | 版本号 + 结论：`verified` / `newer`（高于已验证版本，未实测）/ `unsupported`（低于最低版本）/ `unknown`（读不到版本） |
| `moduleRoot` | 宿主内置插件目录；后续 `--expose-internals` 要用 |
| 配置文件来源 | 生效的 `config/suite.json` 与模板、以及被环境变量覆盖了哪些字段 |
| 数据目录 | 解析后的绝对路径（§4） |
| 模块入口 | 每个已启用模块的 `main` 文件是否存在 |
| 外部服务 | OneBot / 健康 sidecar / 媒体服务的地址是「未配置」还是「已配置」 |
| 阻断项 | 明确列出「不能继续」的原因 |

- **预期**：干净机器上第一次跑会报「配置未创建 / 目录未初始化」，这是正常的，继续 `setup`。
- **失败**：

| 现象 | 处理 |
|---|---|
| `未检测到 DSH 宿主` | §5 显式配置 `dsh.executable` 与 `dsh.moduleRoot` |
| `宿主 X 低于最低支持版本 0.2.0` | 升级 DSH 桌面版 |
| `宿主 X 高于已验证版本 0.2.1-rc.3，未实测` | 可以继续，但**记录**：这是未实测组合，出问题优先怀疑版本差异 |
| 模块入口缺失 | 回到 `npm run build` |

> ⚠️ `doctor` 报告「配置已保存」不等于「连接成功」。状态口径见 `docs/02` §6。

### 3.4 `npm run setup`

- **做什么**：从模板生成本地文件与目录。

| 生成 | 内容 | 已存在时 |
|---|---|---|
| `config/suite.json` | 套件级配置（从 `config/suite.example.json` 复制） | **跳过，不覆盖**（会提示） |
| `config/persona.md` | 人格（从 `config/persona.example.md` 复制） | **跳过，不覆盖** |
| `<dataDir>/home/profiles/<profile>/` | 本套件独立 profile 的运行目录（由宿主使用） | 缺失则生成；已有则复用 |
| `config/profile/<profile>.patch.yml` | 从 `config/profile/<profile>.patch.template.yml` 生成的 **profile patch**：插件用**本机绝对路径**的 `file://` URL 挂载 | 缺失则生成；已有则**只补缺失键**，不改用户值 |
| `<dataDir>/home/`、`workspace/`、`logs/`、`tmp/`、`backups/` | 运行期目录 | 存在则复用 |

- **预期**：Exit 0，打印「新建了什么」与「跳过了什么」两份清单。
- **失败**：

| 现象 | 处理 |
|---|---|
| 路径含空格/中文导致 profile 生成失败 | 见 §7 |
| 提示 `config/suite.json` 已存在 | 正常，是保护行为。要改配置请自己编辑该文件 |
| 宿主模块目录读写失败 | `setup` 不写宿主目录；若报错说明 `moduleRoot` 指错了 |

### 3.5 `npm run start`

- **做什么**：启动**本套件自己的** DSH 环境（独立 `DSH_HOME`、独立 Electron user-data、独立 profile）。
  宿主调用形态（已实测）：

  ```
  ELECTRON_RUN_AS_NODE=1 <宿主可执行文件> --expose-internals \
    <moduleRoot>/@deepseek-ai/dsh-desktop-host/lib/cli.js \
    --profile <profile> --patch config/profile/<profile>.patch.yml
  ```

  `setup` 生成的那份 patch 就是 `--patch` 的取值来源。**profile 本身由 `setup` 创建**
  （用 `--profile <name> --from-default-profile web` 从宿主自带的 `web` 默认配置离线起步，
  所以首次部署不需要联网）；`start` 只负责用已有 profile 启动，profile 不存在会直接报错让你回头跑 `setup`。

  不要用 `dsh.cmd`，也不要依赖 PowerShell 脚本。
- **预期**：Exit 0；打印本次启动日志路径与本地访问地址（带 token 的 `http://127.0.0.1:<port>/?token=…`）。
  启动日志与退出码落在 `<dataDir>/logs/`。
- **失败**：按顺序看

1. `<dataDir>/logs/` 里**本次**的日志（`start` 会打印路径；不要拿「目录里最新的文件」当本次日志）。
2. `npm run doctor` 重跑。
3. `docs/06-troubleshooting.md` 按症状查。

> 首次启动后模型是**未登录**状态：本套件不复制任何旧环境的凭据。要在桌面里登录或配置模型
> （见 `docs/02` §6）。

### 3.6 `npm run verify`

三个组，可单独跑：`--only=unit` / `--only=static` / `--only=compose`。

| 组 | 内容 | 需要宿主? |
|---|---|---|
| `unit` | 逐模块 `node --test` | 否 |
| `static` | 包元数据自洽、`.gitignore` 覆盖、密钥 / 作者绝对路径 / 旧角色名残留、源码树里不存在构建产物 | 否 |
| `compose` | 宿主 `--dump-config` 合成检查 | **是**；没有宿主时输出 `SKIPPED` 且**不判失败** |

- **预期**：全部为 PASS 时 Exit 0；任一步失败 Exit 1。
- **`SKIPPED` 不是 PASS**：`compose` 被跳过时，说明「配置能合成」这件事**没有被验证**。
- **失败**：`unit` 失败看具体模块；`static` 失败通常是有人在源码树里留了构建产物或路径泄漏。

---

## 4. 三个位置：套件根、数据目录、人格文件

这三者是全部路径问题的根源，先记牢。

### 4.1 套件根（`suiteRoot`）

从模块目录向上找到第一个 `package.json` 且 `name === "dsh-companion-suite"` 的目录。**整个仓库可移动**。

### 4.2 数据目录（`dataRoot`）解析顺序

1. 环境变量 `DSH_COMPANION_DATA_DIR`（绝对路径，或相对套件根的路径）
2. `config/suite.json` 的 `dataDir`
3. `<suiteRoot>/data`（默认）
4. 找不到套件根时退回 `$DSH_HOME/companion`

内部布局固定：

```
<dataRoot>/
  home/            # DSH_HOME（配置、记忆库、运行时库、profile、日志）
  workspace/       # 角色工作区（PERSONA.md / AGENTS.md / 提醒文件）
  group-workspace/ # 群聊独立工作区
  desktop-data/    # Electron user-data（登录态、缓存）
  logs/            # 启动与运行日志
  tmp/             # 临时目录（TEMP/TMP 指向这里）
  backups/         # 备份（含迁移前备份）
```

`plugins/companion-foundation/suite-paths.mjs` 与套件 CLI 的 `tools/lib/paths.mjs` **必须解析出同一个
`dataRoot`**；`npm run verify` 里有一条比对断言。

### 4.3 人格文件解析顺序

1. `<suiteRoot>/config/persona.md`
2. `<suiteRoot>/config/persona.example.md`（命中模板时会**明确提示「用的是模板」**）
3. `<dataRoot>/workspace/PERSONA.md`（旧路径兼容）

`config/persona.md` 与 `config/suite.json` 都是**本地配置**（已 gitignore），`data/` 只放运行期数据。

---

## 5. 宿主定位

### 5.1 自动探测的候选路径

| 平台 | 候选 |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`、`%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe` |
| macOS | `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`、`~/Applications/…` |
| Linux | `/opt/DeepSeek Harness/deepseek-harness`、`/usr/lib/deepseek-harness/deepseek-harness`、`~/.local/bin/deepseek-harness` |

`moduleRoot` 由宿主自身推导（通常是 `<安装目录>/resources/app/dsh/node_modules`）。

### 5.2 探测失败时显式配置

```jsonc
// config/suite.json
{
  "dsh": {
    "executable": "<宿主可执行文件绝对路径>",
    "moduleRoot": "<安装目录>/resources/app/dsh/node_modules"
  }
}
```

`doctor` 会打印它**尝试过的所有候选路径**，照着填即可。只配 `moduleRoot` 也能加载插件
（headless 场景），但桌面启动需要 `executable`。

---

## 6. 部署后的第一件事：证明它真的在工作

不要只看「启动成功」。按下面三步做一次真实闭环：

1. 在套件工作区新建会话，问：`检查陪伴基座状态。`
2. 说：`记住：我更喜欢喝茶`
3. 另开一个会话，问：`我更喜欢喝什么`

第 3 步答得出来，才说明记忆写入 → 检索 → 注入这条链是通的。答不出来按 `docs/06` 查。

> 这一步会调用真实模型，**产生费用**。它是唯一需要模型才能验证的环节，其余检查都离线。

---

## 7. 路径形态：Windows 常规 / 含空格 / 含中文 / 跨盘符

套件内部所有路径都由 `path` 与 `fileURLToPath` / `pathToFileURL` 处理，插件在 profile 里以
`file:///…` URL 挂载。以下是**逐条结论**，以及必须注意的地方。

| 形态 | 结论 | 注意点 |
|---|---|---|
| Windows 常规（`C:\dev\dsh-companion`） | ✅ 支持 | — |
| 路径含空格（`C:\My Projects\dsh companion`） | ✅ 支持 | 引用路径时**始终加引号**：`npm run migrate -- export --out "C:\My Exports\b"`；profile 里的 `file://` URL 由 `setup` 生成，不要手写 |
| 路径含中文（`D:\陪伴\dsh-companion`） | ✅ 支持 | 文件系统必须为 UTF-8 路径（Windows 10+ 默认）。**不要**把数据目录放到非 UTF-8 编码的压缩包/网络盘挂载点 |
| 不同盘符（仓库在 `C:`，`dataDir` 在 `D:`） | ✅ 支持 | `dataDir` 可以写绝对路径；`D:` 盘必须存在且可写。跨盘符时 `file://` URL 会带盘符，属正常 |
| 仓库与数据目录同一盘、深层嵌套（>200 字符） | ⚠️ | Windows 默认 260 字符上限；SQLite 的 `-wal`/`-shm` 会再加后缀。**建议源码根不超过 3 层** |
| 网络盘 / OneDrive 同步目录 | ❌ 不建议 | SQLite WAL 在同步盘上易损坏；`npm ci` 也常被占用失败 |
| UNC 路径（`\\server\share\…`） | ⚠️ 未验证 | 它不在 CI 覆盖范围，也没做过实机验收；如同实验，请只读文档并自备份 |

### 7.1 环境变量里带空格/中文

`DSH_COMPANION_DATA_DIR` 等环境变量按**原样绝对路径**解析，不需要额外转义：

```powershell
# PowerShell
$env:DSH_COMPANION_DATA_DIR = "D:\陪伴 数据\data"
node tools/migrate/cli.mjs export --out "D:\陪伴 数据\exports\b1"
```

```bash
# bash / zsh
DSH_COMPANION_DATA_DIR="/home/user/陪伴 data" node tools/migrate/cli.mjs export --out "/tmp/导出 b1"
```

---

## 8. Linux / macOS

Windows 是实机验收平台；Linux/macOS 目前由 CI 覆盖到「构建 + 离线测试」。

| 项 | Windows | Linux / macOS |
|---|---|---|
| `npm ci` / `npm run build` / `npm run verify --only=unit` / `--only=static` | ✅ 实测 | ✅ CI 覆盖（ubuntu-latest / macos-latest） |
| `npm run doctor` 的宿主探测 | ✅ 实机 | ⚠️ 未实测（候选路径已实现，见 §5.1） |
| `npm run start`（桌面宿主） | ✅ 实机 | ⚠️ 未实测；且 `compose` 段在无宿主时输出 `SKIPPED` |
| 侧车（BLE / 华为健康） | ✅ 实机（BLE 真机跑通过） | ⚠️ 未实测：蓝牙栈与账号授权流程只在 Windows 走过 |
| `npm run migrate` | ✅ 已在本机真实数据副本上跑通 export / check / import --dry-run | ✅ 逻辑跨平台（纯 Node）；未在 Linux/macOS 实机跑过 |

**已知限制（必须如实告知用户）**：

1. 没有宿主时 `verify` 的 `compose` 段是 `SKIPPED`，**不等于通过**。
2. Linux 上没有 `Start-Desktop.ps1` 那套启动锁；`migrate` 的「宿主是否在运行」判定因此更弱，
   迁移前请务必手工确认进程已退出（`docs/04` §6）。
3. macOS 未做签名/沙箱相关验证；宿主 `.app` 内部的 `moduleRoot` 推导在小写卷轴上未验证。

---

## 9. 关停与重来

```bash
npm run stop     # 停本套件的宿主进程
```

想彻底重来（**会删数据**，先备份）：

1. 停进程：`npm run stop`
2. 备份数据目录：把 `<dataRoot>` 整个复制走（含 SQLite 的 `-wal` / `-shm`）
3. 删除 `data/` 与 `config/suite.json`（`config/persona.md` 也删的话人格回到模板）
4. 从 §2 第 4 步（`setup`）重来

不要删 `config/` 下你自己写的配置去「碰运气」——先跑 `npm run doctor`。

---

## 10. 下一步

- 配置每一项是什么意思：`docs/02-configuration.md`
- 哪个模块现在真的能用、验证到哪一级：`docs/03-modules-support-matrix.md`、`docs/07-verification-status.md`
- 从旧机器搬数据：`docs/04-migration.md`
- 升级或回滚：`docs/05-upgrade-rollback.md`
- 出问题：`docs/06-troubleshooting.md`
