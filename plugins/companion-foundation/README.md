# companion-foundation（`@dsh-companion/foundation`）

陪伴套件的**基座模块**：加载人格、绑定本机主人身份、挂载记忆引擎与认知运行时、注册
`companion_*` 工具，并把日程 / 联系 / 健康等端口桥接给别的模块。

## 它不做的事

- 不发消息、不读外部网络、不产生计费调用；这些都由其它模块在用户显式开启后负责。
- 不决定数据放在哪：路径一律来自 `suite-paths.mjs`（见下）。

## 路径与人格（发布口径）

- `suite-paths.mjs` 是运行时**唯一**的路径解析实现（套件 D2 约定）：
  - `suiteRoot` = 向上找到 `package.json` 里 `name === "dsh-companion-suite"` 的目录。
  - `dataRoot` = `DSH_COMPANION_DATA_DIR` → `config/suite.json` 的 `dataDir` → 根 `package.json`
    的 `dsh.suite.dataDir` → `<suiteRoot>/data`；找不到 suiteRoot 时退 `$DSH_HOME/companion`，
    最后才退源码目录（并在日志里说明）。
  - 人格文件 = `<suiteRoot>/config/persona.md` → `config/persona.example.md`（模板，会提示）
    → 旧路径 `<dataRoot>/workspace/PERSONA.md`。
  - `personaId` = `DSH_COMPANION_PERSONA_ID` → `config/suite.json` 的 `persona.id` → `bot`。
- `companion-runtime` / `companion-memory-studio` / `companion-group` 兄弟 import 同一个
  `suite-paths.mjs`，所以**核心模块必须成套安装**（同一父目录或 workspaces），否则相对路径解析失败。

## 入口

| 文件 | 作用 |
|---|---|
| `index.mjs` | 预设入口（`apply()` 解析路径后 `mountCompanion()`） |
| `workspace-context.mjs` | 宿主侧可选插件：给陪伴工作区换一个更小的上下文窗口（默认关闭，需 `home/companion/workspace-context.json` 里 `enabled: true`） |
| `suite-paths.mjs` | 路径/人格解析（见上） |
| `qq-sender-refresh.mjs`、`qq-autonomy-refresh-20261102.mjs` | 宿主侧热重绑定 QQ 发送端口；诊断写 `<dataRoot>/logs/` |

## 测试

```bash
node --test "*.test.mjs" "test/*.test.mjs"
```

需要真实宿主的用例（`@deepseek-ai/dsh-tools` / `dsh-llm` / `cordis`）以
`DSH_COMPANION_MODULE_ROOT` 为准；没设就 **skip** 并打印原因，不会伪造通过。
`share-real.test.mjs` 还需要兄弟模块 `dsh-channel-qq` 的构建产物（`build/lib/features/contact`），
缺失时同样 skip。测试只写系统临时目录，不在仓库里留文件。
