# 表情包链路修复 · 交付说明（`codex/expression-sticker-chain`）

> 依据 `docs/11-expression-sticker-chain-plan.md`（P-1 环境隔离 → P0 → P1 → P2）。
> 本文件是**交付时的事实清单**，不是验收报告：每一行都写着证据级别，没跑过的项写「未验证」。
> 证据分级口径见 `docs/07-verification-status.md` §1 与 §2.6b。

## 1. 环境与基线

| 项 | 值 |
|---|---|
| 开发 worktree | `D:\Bot\DSH-dev\.agents\worktrees\dsh-18e74720-19b6` |
| 分支 | `codex/expression-sticker-chain`（**未 push**，未合并到 `main`） |
| 基线提交 | `e2bde2c`（= `origin/main` HEAD，已 `--ff-only` 对齐远端） |
| 交付提交 | `e24745f`（共 12 个提交，见 §6） |
| Node / npm | `v24.14.0` / `11.9.0` |
| 独立 dataDir | 只用 worktree 内 `data/`（gitignored）；诊断脚本实跑用的是 `data/dev-expression/`。**未读写生产 `data/`、凭据、登录态** |
| 生产目录接触 | 主检出 `D:\Bot\DSH-dev` 全程只读；`git -C D:\Bot\DSH-dev status` 无改动 |
| 远端 | `origin https://github.com/FamousBOBO/dsh-companion.git`；比对过 `origin/main`、`origin/expressions`、`origin/dev` |

## 2. 基线（改动前）失败项

`npm run doctor`：**核心检查失败 1 项**——`[失败] 宿主 CLI 入口 — 宿主目录里找不到 CLI 入口`；
`[注意] 宿主版本 — 未检测到 DSH 宿主版本`；`[未就绪]` 11 项（未跑 `npm run setup`，属预期）。
`npm run verify` 基线：`unit` 9 通过 / 0 失败 / 1 无测试、`static` 32 通过 / 0 失败、
`compose` **SKIPPED**。

> 这条 `[失败]` 与本次改动无关：本机装的是宿主 `0.2.2-rc.1`，CLI 在 `app.asar` 内，
> 而 `tools/lib/host.mjs` 推导的是 `resources/app/dsh/...`。它同时解释了为什么 `compose`
> 一直是 SKIPPED——**这是环境差异，不是回归**。

## 3. 实际代码修改

### P0-1 统一模型侧工具名
- `plugins/dsh-channel-qq/assets/persona/default/instruction/behavior.txt`
- `plugins/dsh-channel-qq/assets/persona/default/packet/group-tail.txt`
  → 「先 `expression_candidates`，有候选用 `assetId` 调 `expression_reply`；无候选只发文字；
  一轮最多一张；不传路径/URL/CQ 码」。`qq_send_text` / `qq_reply_quote`（真实存在的文字工具）保留。
- `plugins/companion-group/index.mjs`：`GROUP_PERSONA` 补 `expression_sticker_note`
  （**明确追问才 lookup、明确告知才 record**），表情规则改成与人格包同口径。
- `plugins/dsh-channel-qq/src/features/stickers/tools.ts`：旧表情工具保留为**底层兼容面**
  （`tools.v2` 的 legacy 合并表依赖这些名字；没装 `companion-expression` 时是兜底），
  只在 `qq_send_emoji` 的 description 里补一句「能看到 `expression_*` 就优先用它们」。

### P0-2 工具可见性脱敏诊断
- 新增 `plugins/dsh-channel-qq/src/adapters/dsh-host/tool-visibility.ts`：模块是否挂载 /
  四个 `expression_*` 是否注册 / 全局与每个活会话作用域是否可见 / QQ 发送器是否可见。
  三态（`yes`/`no`/`unknown`，**读不出来不许说「没有」**）+ 一句话结论（按上游到下游报第一个缺口）。
- 新增 `plugins/dsh-channel-qq/src/features/admin/tool-visibility-probe.ts`（宿主接缝）。
- `plugins/dsh-channel-qq/src/features/admin/index.ts`：状态快照加 `expressionVisibility` 与
  `expression` 两格；启动时打一行脱敏结论（模块/四个工具/发送器三态 + 提示）。

### P0-3 服务发现时序
- `plugins/dsh-channel-qq/src/adapters/dsh-host/expression-service.ts`：
  **失败不再永久缓存**；每次调用都重新问 `ctx.get('companionExpression')` 与进程级注册表
  （裸对象与 `Map<dataRoot>` 两种形态，单分区无 env 时按其唯一键取）；成功也不无限信任
  （卸载后重挂载拿到新对象）。新增 `expressionServiceState()` / `expressionDiagnosticsOf()`。

### P1 入站表情语义
- `plugins/dsh-channel-qq/src/core/message/parse.ts`：`StickerSeg` 增加
  `kind='sticker'`、`semanticPolicy='emotion-support'`；表情仍**不进** `imageUrls`/`imageSummaries`。
- `plugins/dsh-channel-qq/src/core/message/render.ts`：每个表情输出
  `[表情标记：kind=sticker｜stickerKey=…｜semanticPolicy=emotion-support｜knownMeaning=…]`
  （没记过意思**不输出** `knownMeaning=`），并把旧口径「先在记忆里找…认不出的就说不认识」
  改写成 docs/11 原文口径：不描画面、不揣度、未知时接住语气/卖萌/带过/沉默、
  **不因认不出主动追问**、只有用户明确问「这是什么意思」才解释。
- `pipeline.ts` + `features/inbound/{index,runtime-deps}.ts`：注入可选 `stickerMeanings`
  （缺省不注入 = 只多两条标注）。
- `plugins/companion-expression/src/sticker-notes.mjs`：新增 `read()`（**纯读**，不
  `markSeen`、不加 `hits`）；`src/index.mjs` 的入站端口多发布一格 `note`；
  `features/expression-bridge.ts` 暴露 `lookupSticker`（优先 `read`，老句柄才退 `lookup`）。

### P1 只读诊断（素材权限 / 结果码）
- 新增 `plugins/companion-expression/src/diagnostics.mjs`：图库/审核态计数、按会话算可用
  素材数（**同一套** `scopesFor()` + 可见性硬门）、最近一次候选/发图的结果码与 `message_id`、
  最近投递记录；读不出来给 `null` 不给 `0`；不含路径/URL/QQ 号/消息正文。
- `src/index.mjs`：候选与发图各记一份「最近结局」；service 增加 `diagnose()`；端口转发。
- 新增 `plugins/companion-expression/scripts/diagnose.mjs`（只读；`--json` / `--dm` / `--group`）。

### P2 发送纪律
- `plugins/companion-expression/src/delivery.mjs`：`statusOf()` 原先把 `{ok:true}` 但**无回执**
  记成 `sent`；现在记 `unknown`（文档 P2 第 10 条）。`unknown`/`failed` 仍是终态、不重投。

### 文档与快照
- `docs/07-verification-status.md` 新增 §2.6b（逐项证据 + 三个易读错的点 + 一次环境抖动说明）。
- golden 更新 **5 份**：`packets/group-called|group-keyword|group-rich-called|group-batched`
  （只差 `group-tail` 一行）、`tools/qq-tools`（只差 `qq_send_emoji` 的 description 一行）。

## 4. 测试命令与结果（本 worktree 实跑）

| 命令 | 结果 |
|---|---|
| `npm test --workspace=@dsh-companion/channel-qq` | **1793 tests / 1792 pass / 0 fail / 1 skip**（skip 是既有的「真实会话文件逐帧解码」） |
| `node --test "test/*.test.mjs"`（`plugins/companion-expression`） | **227 / 227 通过** |
| `npm run verify`（仓库根） | `unit` **9 通过 / 0 失败 / 1 无测试**；`static` **32 通过 / 0 失败**；`compose` **SKIPPED**；结论「验证通过」 |
| `npm run verify --workspace=@dsh-companion/channel-qq` | 通过（`check:admin` / `check:syntax` / `typecheck` / `test` / `check:layers` / `check:size`） |
| `npm run typecheck --workspace=@dsh-companion/channel-qq` | 通过（无输出） |
| `npm run check:size --workspace=…` | 通过（**没有任何文件或函数比基线更大**；`renderMessageLine` 与 `pipeline.ts` 经重构回到硬上限内） |
| `npm run check:layers --workspace=…` | 通过（481 个源文件，宿主包 import 均在基线内） |
| `node plugins/companion-expression/scripts/diagnose.mjs --dm … --group …` | exit 0；输出 `delivery.enabled=关`、图库 0 素材、dm→`peer-not-approved`、group→`group-capture-disabled` |

本次新增/相关的测试文件（都在上面计数里）：

- `plugins/dsh-channel-qq/test/expression-service.test.ts`（12 项：四种初始化时序 + 多 ctx + sendSticker 纪律）
- `plugins/dsh-channel-qq/test/sticker-semantics.test.ts`（13 项：语义标记、不解释画面、不主动追问、只有明确问才解释）
- `plugins/dsh-channel-qq/test/tool-visibility.test.ts`（11 项：三层可见性 + 三态 + 脱敏）
- `plugins/dsh-channel-qq/test/presence-stickers.test.ts`（10 项：出站配图仍受 `presence.stickers`/冷却/额度约束）
- `plugins/dsh-channel-qq/test/persona.test.ts`（+2 项：两种 composer 都无旧表情工具名；`GROUP_PERSONA` 与出口一致）
- `plugins/companion-expression/test/diagnostics.test.mjs`（7 项）
- `plugins/companion-expression/test/expression-chain-p2.test.mjs`（6 项：P2 第 7–10 条）

## 5. 未验证项（**不要读成通过**）

| 项 | 状态 | 说明 |
|---|---|---|
| 宿主装载（`host-load`） | **未验证** | 本机 `doctor` 探测不到宿主 CLI 入口（`0.2.2-rc.1` 的 CLI 在 `app.asar` 内），`compose` 一直 SKIPPED（基线如此）。所以「`expression_*` 在真宿主上是否注册、会话可见、发送器可见」**没有实测证据**；代码与诊断已就位 |
| 真实 QQ 发送（`real-send`） | **未验证，且本轮不做** | 独立 worktree `modules.expression=false`、`delivery.enabled=false`、`safety.*` 全关。真实发送必须由操作者显式触发，并按 `docs/07` §2.6 的口径记 `provider_message_id` 与回读 `sub_type` |
| 真实模型是否照新提示词行动 | **未验证** | 「人格包不再出现旧工具名」是文本层证据（测试钉住），不等于模型真的会先调 `expression_candidates` |
| 后台面板里新加的两格 | **未验证** | 只做了 TS 层与单元测试；没有在浏览器里打开过页面 |
| 生产环境可用性 | 不适用 | 本次**没有碰**生产配置/数据库/登录态，也没有部署 |

## 6. 提交清单（`git log --oneline e2bde2c..HEAD`）

```
e24745f docs(expression): 记录一次 runtime unit 红是环境抖动（单跑 3 次全绿、该模块零改动）
5a60887 test(expression): 钉住出站配图与入站理解分离（presence 冷却与额度）
060793a docs(expression): golden 更新清单补上 tools/qq-tools（共 5 份）
bfeb5f3 docs(expression): 校正离线验证计数（channel-qq 1782 通过 / 1 skip）
2a0d989 fix(prompt): 兼容面表情工具只做兜底，模型可见处指向 expression_*
c822cde refactor(expression): 拆出表情语义段，守住体量棘轮；启动打一行工具面结论
c28f15b docs(expression): 记录表情包链路修复的证据分级；补「不主动追问含义」断言
4af4af0 fix(expression): 没有 message_id 就记 unknown，不当作 sent
1c7077b feat(expression): 只读诊断——工具可见性三层 + 素材权限/结果码
e1ecb18 feat(expression): 入站表情按「情绪辅助」标注，不再默认解释画面
5ed2f05 fix(expression): registry-miss 不再永久缓存，卸载后重挂载可恢复
6aac988 fix(prompt): 表情工具统一为 expression_*，移除指向不存在工具的旧文案
```

## 7. 要不要部署 / 重启

**本次不部署、不重启任何东西。**

- 代码只在开发分支；合并与上线由操作者决定（P-1 的回滚边界：未通过验证前不合并、不覆盖生产 worktree）。
- 如果将来要在生产上验证这批改动：需要 ① 在能探测到宿主 CLI 的机器上把 `npm run doctor`
  跑成「核心检查通过」；② 重启宿主看启动日志里出现 `expression 工具面：模块=有、四个工具=全在、发送器=有`
  这一行（新增的）；③ 仍保持 `delivery.enabled=false`，先确认 `expression_candidates` 能返回候选；
  ④ 真实发图再由操作者显式打开 `delivery.enabled` 并逐条核对 `provider_message_id`。
- 升级 `docs/07` §2.6b 里「宿主装载 / 真实发送」两级证据时，请直接改那张表，不要只在聊天里说「跑通了」。

## 8. 用户口径（行为约束，必须保留）

> 用户发表情主要是在辅助表达情绪。默认不解释画面、不揣度深层意思；不确定时可以选相近语气的
> 表情、卖萌、轻轻带过或不回应。**不因「不认识表情」主动追问含义**；只有用户明确要求解释时
> 才进入解释流程。

这条已经写进：`core/message/render.ts` 的表情语义段（每一条带表情的入站行都会带上）、
`test/sticker-semantics.test.ts` 的断言、以及 `store` 文档 §2.6b。
