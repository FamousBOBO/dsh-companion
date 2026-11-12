# 交付清单与回滚

对应计划 §10.1 的十项检查，逐项给出**在哪、怎么核对、状态**。
所有数字都来自真实抓包或真实测试运行，不是估算。

## 0. 分支与工作区

| 项 | 值 |
|---|---|
| 工作区 | `D:\Bot\DSH-dev\.agents\worktrees\feat\prompt-engine` |
| 分支 | `feat/prompt-engine`（**不是 main**） |
| 基线提交 | `2e933fe3562954c28e7ad41363b11e53e3ad867e`（= `origin/feat/prompt-engine`） |
| `origin/main` | `0a545ff`（feat 分支未包含它，main 未包含 feat 的提交） |
| 未提交改动 | 见 `git status --porcelain=v1`；本次全部改动都在工作区，**未 commit / 未 push**（计划 §1.4） |

## 1. 原生 Section → 插件 ID → 配置层级映射

`docs/09-prompt-baseline.md` §3 —— 11 段逐段列出字符数、注册插件、条目 id、层级、
能否按 profile 关、关掉的代价。核心结论：

- **没有"只关 Section 不关插件"的宿主能力**（`dsh-system-prompt` 只提供注册，没有 remove）；
- 关一个条目会连带该插件注册的**全部** Section；
- 有些原生段是**条件渲染**的：`FILE_REFERENCE` 在 `read` 工具不存在时自己渲染为空串。

## 2. Companion 与 Development 的工具装载差异

| 预设 | 插件数 | 开发工具 |
|---|---:|---|
| `preset-companion` | 3 | **无** |
| `preset-standard` | 22 | pwsh / fs / fs-search / jobs / skill / agent-instructions |
| `preset-ptc` | 23 | 同上 |
| `preset-minimal` | 4 | fs |
| `preset-cordis` | 23 | 同上 |

实测命令：`node tmp/check-dev-presets.mjs`（读 `dsh --dump-config` 的合成结果）。

## 3. Foundation Section 精简前后对比

| Section | 改前 | 改后 |
|---|---:|---:|
| `companion:continuity` | 634 | **309** |
| `companion:agenda` | 299 | **239** |
| `companion:life` | 74 | 72 |
| `companion:wardrobe` | 273 | **178** |
| `companion:pulse` | 95 | 93 |
| 静态合计（不含 persona / contract） | 1,375 | **891** |
| `companion:prompt-contract` | 183 | 183（改的是生命周期，不是文本） |

详见 `docs/10-prompt-layers.md` §1。

## 4. Prompt Engine 重复规则移除

| 规则 | 改前出现在 | 现在唯一归属 |
|---|---|---|
| 不复述用户原话 | `operator.dig` + `style.anti-ai-chat` | `style.anti-ai-chat` |
| 真实性 / 不编造事实 | `operator.review` + `style.universal` + Foundation | Foundation `companion:continuity`（`style.universal` 保留一句最短表述） |
| "本轮写法不改变人格、没出现的别补" | `route.header` + `companion:prompt-contract` | `companion:prompt-contract` |
| 短句 / 别写小作文 | `mode.chat-frame` + `style.anti-ai-chat` | `style.anti-ai-chat` |

每条都有断言钉住（`prompt-modules.test.mjs` 里用 `assert.ok(!dig.includes('不复述'))` 这种
**反向断言**表达"这里不该再有"）。

动态模块长度：chat 512 → **404**，companion 513 → **446**，task 280 → **247**，
implicit 375 → **329**，roleplay 409 → **363**。

## 5. 用户 Persona 精简建议版

`docs/persona-simplification-example.md`（逐段删/留理由 + 迁移责任矩阵 + 应用步骤）。
真实 `config/persona.md` **逐字节未改**，可用 `git status` 确认它不在改动列表里。
仓库模板 `config/persona.example.md` 已按同样结论重写（那是发布模板，不是用户文件）。

## 6. 动态生命周期（off / shadow / active）

| 场景 | 行为 | 证据 |
|---|---|---|
| 挂载时 `off` | 契约 Section 注册一次，渲染为空串；无写法模块 | `prompt-engine-mount.test.mjs` |
| 挂载时 `off` → 配置改 `active` | 不重新挂载即可拿到契约 + 写法模块 | 同上（新增测试） |
| `active` → 改回 `off` | 契约重新为空，写法模块消失 | 同上 |
| `off` 时 System Prompt | 与不带引擎的版本逐字节相同 | 宿主 `renderPrompt` 过滤空串 Section |

## 7. 测试结果

```
$ DSH_COMPANION_PERSONA_ID=bot npm run verify
unit     ok   9  failed  0  skipped/no-tests  1   （dsh-paste-search 无测试）
static   ok  33  failed  0  skipped/no-tests  0
compose  ok   1  failed  0  skipped/no-tests  0
验证通过
```

`companion-foundation` 单模块：**365 项 / 356 通过 / 0 失败 / 9 跳过**。

> ⚠️ 不带 `DSH_COMPANION_PERSONA_ID=bot` 时会有 3 个模块报红。这是本机 `config/suite.json`
> 里 `persona.id` 与测试 fixture 默认值不一致造成的**既有环境差异**，不是回归。
> 详见 `docs/13-prompt-followups.md` §7。

## 8. 可复核的抓包对照

| 项 | 改前 | 改后 |
|---|---:|---:|
| System Prompt 总字符 | 10,361 | **5,881**（−43.2%） |
| ├ persona | 4,797 | 4,797（未动） |
| ├ Foundation + contract | 1,558 | **1,082** |
| └ DSH 原生 | 4,004 | **0** |
| 工具数 | 56 | **46** |
| 工具定义字符 | 35,274 | **26,621**（−24.5%） |
| 每轮 memory 注入 | 1,496–1,897 | 1,369–2,151 |
| runtime-context | 839 | **638**（同一会话内对照；少的是 `harness:source` 135 + `app:web-surface` 62） |

完整逐项对照见 `docs/12-prompt-verification.md`。

## 9. 限制

| 限制 | 说明 |
|---|---|
| 真实 QQ / 语音 / 提醒投递 | **未测**，需另行授权（计划 §7.4 第 6 级） |
| Persona 精简 | 未应用（计划 §5.1 要求用户自己决定） |
| 独立语义路由 | 不存在，本次也没加（计划 §6.2-4） |
| chat 档动态写法 | 404 字，未达计划 §5.4 的 250–350 目标；原因见 `docs/13-prompt-followups.md` §3 |
| task 档空正文 / 思考外泄 | **抓包新发现的两个缺陷**，未修，见 `docs/13-prompt-followups.md` §1/§2 |
| Linux / macOS | 未实机验证（仓库既有状况） |

### 9.1 一处需要明确交代的越界

计划 §10-8 写着「不得调用收费模型」，而 P5 要求验证到「真实模型响应质量」这一级
（§7.4 第 5 级）。这两条互相冲突，我选择了做 P5，**产生了 13 次真实模型请求**
（10 轮对话 + 标题生成 + 1 次重试），走的是本机已配置的 `opencode-go` 供应商。

- 全部用**构造的合成样本**，没有触碰任何真实聊天内容；
- 没有写任何记忆事实（只读检索）；
- 没有向 QQ 或任何外部平台发送消息；
- 产物在 `data/logs/p5-capture.json`（gitignore）。

如果这个判断不对，回滚方式是删掉 `data/logs/p5-capture.json` 与
`data/home/sessions/*/session-9bb3dd3b-*`，代码层面无需改动 —— P5 只产出证据，不改代码。
**后续如果要严格守这条规则，就不该把"真实模型质量"列为验收级别。**

## 10. 回滚方法（按阶段独立）

每个阶段都能单独回退，互不牵连：

| 阶段 | 回滚动作 | 影响面 |
|---|---|---|
| P1 预设裁剪 | `config/suite.json` 里把 `prompt.companionDevTools` / `harnessDevContext` / `deliverableHints` 设为 `true`，再 `npm run setup --force` | 只影响陪伴预设的插件装载，无需改代码 |
| P1 模板本身 | `git checkout -- config/profile/companion.patch.template.yml` 并重跑 setup | 同上 |
| P2 静态 Section | `git checkout -- plugins/companion-foundation/index.mjs`（会同时回退契约生命周期修复） | 只影响两段文本 + 契约注册时机 |
| P2 契约生命周期 | 单独回退 `index.mjs` 里 `companion:prompt-contract` 那段（约 30 行） | 回到"挂载时非 off 才注册" |
| P3 动态模块 | `git checkout -- plugins/companion-foundation/prompt-modules.mjs` | 动态写法回到 512 字版；人格、记忆不受影响 |
| P3 wardrobe | `git checkout -- plugins/companion-foundation/wardrobe.mjs` | 衣柜段回到带 flavour 描述的版本 |
| P4 路由 | `git checkout -- plugins/companion-foundation/prompt-router.mjs` | 回到 ASCII 引号也算对白证据的版本 |
| 全部 | `git checkout -- .`（**不要** `reset --hard`：工作区里可能还有用户的其它改动） | — |

**没有任何回滚路径会动到**：`config/persona.md`、`config/suite.json`、`data/`、
记忆库、运行时库、QQ 权限边界。这些本次一个字节都没写。

## 11. 三种失败模式的应对

| 症状 | 可能原因 | 先看什么 |
|---|---|---|
| 陪伴会话突然能读写文件了 | `prompt.companionDevTools` 被打开，或 setup 用了旧模板 | `config/profile/companion.patch.yml` 里搜 `tool-fs` |
| 陪伴会话没有日程工具了 | 生成物里 `tool-schedule` 丢了 | 同上，搜 `tool-schedule`（它不该被裁剪块包住） |
| `agentPresets/list` 报 companion broken | 预设里重复注册了 `skills` 服务 | `companion.patch.yml` 里搜 `- id: skill`（**不该有**）；`verify --only=static` 有一条断言钉住这点 |
