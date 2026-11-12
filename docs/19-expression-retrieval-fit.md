# 表情包检索链路修复（2026-11-12 · 交付审查稿）

> 这是一份**待审查**的交付说明，不是验收报告。所有证据都标了级别：
> `offline-test` = `:memory:` 数据库 + 合成素材 + 假发送器，零网络零 QQ；
> `host-load` = 真宿主装载成功；`real-send` = 真 QQ 发出去并有回执。
> 本次只做到 `offline-test`，`host-load` 与 `real-send` **没有做**（按要求不部署、不重启生产）。

## 1. 分支与提交

| 项 | 值 |
|---|---|
| 仓库 | `dsh-production`（生产套件仓库） |
| 基线提交 | `d20cf1abf18ef489c343db1bc4d845dd207d0be4`（`main`） |
| 开发分支 | `expression-retrieval-fit` |
| 开发 worktree | `.agents\worktrees\expression-retrieval-fit`（独立工作目录，**不指向**生产的 `data/`） |
| Node / npm | `v24.14.0` / `11.9.0` |
| 生产环境 | **未改动**：没有 `npm run setup/start`、没有重启宿主、没有真实 QQ 调用、没有改任何生产配置或数据库 |

改动范围（全部在 `plugins/companion-expression/`）：

| 文件 | 性质 |
|---|---|
| `src/synonyms.mjs` | **新增**：集中维护、可测试的中文近义表达表 + 否定/转折规则 + 相反表达对 + 相似度表 |
| `src/retrieval.mjs` | 重写：多路召回、8 维打分（意图/情绪分离）、冲突约束、打分不吃单字/标点、逐阶段诊断 |
| `src/library.mjs` | FTS 标签列口径 v2（索引 intents+emotions+tone）+ 老库一次性迁移 `ensureLabelIndex()` |
| `src/analyzer.mjs` | 中文归一化改用共享表（与检索同一份），`modelVersion` → `heuristics-v2`，新增诊断字段 `mixed` |
| `src/decision.mjs` | 对外统一 `no-compatible-expression`（带 `cause`）+ `diagnostics`；发送时只回该发的候选 |
| `src/index.mjs` | 传入 `poolLimit`；候选只给「可发的」；暴露 FTS 迁移结果；诊断带 `cause` |
| `src/config.mjs` | 新增 `retrieval.poolLimit`（默认 60，10–200） |
| `src/diagnostics.mjs` | `lastCandidate.cause`、`module.poolLimit` |
| `src/ui-page.mjs` | 新配置项的字段/标签/上下限 |
| `http.mjs` | 实验室走同一个 `poolLimit`，返回检索诊断 |
| `scripts/probe.mjs` | 新增：单边探针（合成素材 → 召回/打分/决策全程打印） |
| `scripts/compare.mjs` | 新增：**优化前 vs 优化后** 同素材对照（旧实现从 git 对象整组取出） |
| `test/synonyms.test.mjs` | 新增：共享表与否定规则的区分性用例 |
| `test/retrieval-fit.test.mjs` | 新增：7 条标注查询 + 召回/阈值/冲突/纪律回归 |
| `test/fixtures/sticker-corpus.json` | 新增：50 张合成素材（45 可用 + 5 不可返回），固定 `now` |
| `test/calibration.test.mjs`、`test/decision.test.mjs`、`test/diagnostics.test.mjs`、`test/ingest.test.mjs` | 按新口径重算数字/新原因码 |

## 2. 真实查询复现与根因

**原调用**（2026-11-12 14:38 +08:00，私聊，`limit=3`，`isGroup=false`，阈值 `minFitScore=0.5`）：

```json
{ "query": "笑着答应、乖巧点头、轻松愉快", "limit": 3, "isGroup": false }
```

返回「尴尬 0.3002 / 加载中 0.292 / 头晕 0.292」，最终 `send=false`、`text-only-low-fit`。

**复现方式**：生产库不能读、不能复制，所以用 45 张可用 + 5 张不可返回的合成素材
（`test/fixtures/sticker-corpus.json`，固定 `now = 1794465480000` = 2026-11-12 14:38 +08:00）建
`:memory:` 库，跑 `createLibrary → fromLibrary → retrieve → decide` 同一条链。

合成素材上的 before 数字与事故形态一致（同一量级、同一排序结构）：top-3 =
`c04 0.5455 / c01 0.4615 / c14 0.3776`，其中「尴尬」类 `c22 0.3357` 也在前五；阈值 0.72 下
`text-only-low-fit`。**不是逐字节复刻**（生产图库内容未知），但每个阶段的成因与量级对得上。

**根因（按证据排序，全部有数字支撑）**

| # | 阶段 | 现象 | 证据 |
|---|---|---|---|
| 1 | 查询归一化 | 草稿 `笑着答应、乖巧点头、轻松愉快` 抽不出任何意图/情绪/语气标签 | `contextFromDraft` 返回 `{intents:[],emotions:[],tone:[],scenes:[]}`；四维不计分，只剩字面重合 |
| 2 | 素材归一化 | 同类中文描述也抽不出标签（旧 `analyzer.mjs` 的线索表只有 `开心/高兴/快乐` 等少数词，且大量条目偏英文） | `analyzeWithHeuristics({literal:'好呀、点头、收到'})` → `intents:[]` |
| 3 | FTS 标签列 | 只索引 `intents`，情绪/语气标签（`joy`/`light`/`awkward`）在 FTS 里根本不存在 | 标签路召回恒为 0（修复后同一路命中 **29** 张） |
| 4 | 召回 | `fromLibrary` 只在**零命中**时才用 `listAssets` 补齐；一有命中就只用那几条 | 该查询 FTS 命中 10 条 → 候选池只有 9（修复后 49） |
| 5 | 排序 | 语义维用「单字 + 相邻二字」重合，标点二元组（`应、`/`、点`）也计分 | 「尴尬、汗颜、挠头」拿到 `semantic≈0.077`（修复后 0，含标点的 token 不再计分） |
| 6 | 阈值/决策 | 只有字面能得分 → 天花板低；低于阈值一律 `text-only-low-fit`，模型读成「再换个说法试试」 | 修复前默认 0.72 下完美字面命中只有 0.675，模块事实上发不出图 |

**一句话根因**：不是「图库里没有这种语气的素材」，也不是阈值太高，而是**查询与素材两边都没有做
中文语义归一化**，加上 FTS 只索引了意图列、召回在「有部分命中」时不再补足，于是只能靠偶然字符
重合排序；阈值只是在最后把这个错误结果如实报成了 `low-fit`。

**诊断分阶段计数（14:38 查询，修复后）**

| 阶段 | 数字 |
|---|---|
| 库里素材 / 本会话可见 / 过硬门可发 | 50 / 47 / **45** |
| 召回路：词面 / 标签 / 近义扩展 / 补齐 | 10 / **29** / 5 / 46 |
| 合并去重后的待排序池（上限 60） | **49** |
| 硬门拒绝桶：scope / kind / moderation | 2 / 1 / 1 |
| 冲突约束拒绝 | 14（如「拒绝、不要、不行」） |
| 低于阈值 | 0（门槛 0 时全进诊断） |
| 最终候选 | 3（`c04 0.7204` / `c01 0.6738` / `c40 0.6533`） |

## 3. 优化前后对照（同一份素材、同一组查询）

用 `node plugins/companion-expression/scripts/compare.mjs`（旧实现从 `git show d20cf1a:...` 整组
取出后 import，新实现是工作区源码）。证据级别 `offline-test`。

| 查询 | 优化前 top-3（分） | 优化后 top-3（分） | 决策 @0.5 前 → 后 |
|---|---|---|---|
| 笑着答应、乖巧点头、轻松愉快 | c04 .5455 / c01 .4615 / c14 .3776 | c04 **.7204** / c01 .6738 / c40 .6533 | send(c04) → send(c04) |
| 好的收到 | c01 .5844 / c04 .5844 / c34 .5065 | c34 .7005 / c01 .7005 / c02 .7005 | send(c01) → send(c34) |
| 笑不出来，心里有点难过 | c26 .5798 / c12 .3445 / c20 .2269 | c26 .5213 / c27 .5074 / c13 .4809 | send(c26) → send(c26) |
| 别笑了 | c45 .7507（唯一候选） | c45 **.8388** / c20 .3812 / c44 .3812 | send → send |
| 抱抱，辛苦了 | c12 .5467 / c10 .5467 / c36 .2400 | c12 .7005 / c10 .7005 / c13 .6014 | send → send |
| 看不懂，脑子转不过来 | c20 .6061 / c19 .4242 / c18 .4242 | c20 **.7702** / c19 .6131 / c18 .6131 | send → send |
| 我很难受，怎么办（严肃求助） | abstain-serious-help | abstain-serious-help | 停发（正确） |
| 困、疲惫、想睡觉（附加） | c32 .8824 / c23 .2521 | c32 .8897 / c33 .5662 / c20 .3426 | send → send |

**候选池变化**（最能说明「素材存在但召回漏掉」）：14:38 查询 `9 → 49`；`好的收到` `5 → 49`；
`抱抱，辛苦了` `3 → 48`；`别笑了` `1 → 46`。

**误匹配对照**（反义/偏题素材进入前 3）：优化前在 `好的收到`、`笑不出来` 等查询里，反义素材
（拒绝、大笑）虽然排位不在前 3，但**会被返回给模型**（旧实现不区分「有候选」与「可发」）；
优化后这些素材在**召回层就被冲突约束剔除**（`好的收到` 的 c24/c25、`笑不出来` 的 c07/c08
全部不出现在候选列表），且 `candidates` 在 `send=false` 时恒为空。

**阈值保持不动**：生产 `minFitScore` 仍是 **0.5**，`DEFAULT_CONFIG` 仍是 **0.72**，本次没有降低任何
门槛。0.72 下的表现单独列出（修复后 c04 = 0.7204 恰好够；`好的收到`/`抱抱，辛苦了` 0.7005 < 0.72 →
`no-compatible-expression`），是否需要重新校准留给审查决定。

## 4. 测试命令、通过数量与未验证项

```bash
# 插件单测（本次新增 19 项：synonyms 10 + retrieval-fit 9）
node --test "plugins/companion-expression/test/*.test.mjs"     # 247 pass / 0 fail

# 单边探针（合成素材，打印每阶段计数与排名）
node plugins/companion-expression/scripts/probe.mjs            # all good

# 优化前后对照
node plugins/companion-expression/scripts/compare.mjs          # 见第 3 节表格

# 发布要求的离线检查（unit + static + compose）
node scripts/build.mjs && node scripts/verify.mjs
#   unit 9 ok / 0 failed；static 39 ok / 0 failed；compose 跳过（本机未检测到 DSH 宿主）
```

> `compose` 一项被如实报为 **SKIPPED**（CI/无宿主时的正常现象），不计为通过。`npm run verify` 需要
> 先 `build`：`channel-qq` 的 3 个用例检查 `build/lib` 产物，未构建时会假失败（已实测并记录）。

**未验证项（必须如实列出）**
- 真实宿主装载（`host-load`）：**未做**。本次未启动 DSH、未重启生产。
- 真实 QQ 发送（`real-send`）：**未做**。没有调用任何 QQ 接口，没有回执证据。
- 生产图库上的效果：**未验证**。合成素材 45 张与生产私聊 45 张同规模，但内容不同。
- `0.72` 门槛是否应重校准：**待审查决定**，本次未改默认值。
- 提示词/人格包：**未改**（旧工具名清理是上一轮已合入的工作，本次不重复）。

## 5. 新配置项与默认值

只新增 **1 项**（其余一律沿用原值，没有为了「让它能发」而调任何门槛）：

| 配置 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `retrieval.poolLimit` | `60` | `10–200`（越界夹回） | 多路召回合并后的待排序候选池上限。作用：候选池**有明确上限、不整库无限扫描**；素材规模变大时可调高，太小则更依赖词面命中 |

`retrieval.minFitScore`（0.72 默认 / 生产 0.5）、`candidatesToModel`（5）、delivery 全部冷却/配额
参数**未改动**。

## 6. 部署与回滚

**部署（需要人工显式执行，本次未做）**
1. 审查本分支 diff（`git diff d20cf1a...expression-retrieval-fit -- plugins/companion-expression`）。
2. 合并到生产分支 → 在**生产 worktree** 执行 `npm run build`（插件源码直加载，但 `channel-qq`
   需要构建产物）。
3. 启动前先跑只读诊断：`npm run doctor`；表情模块的诊断行应能看到 `poolLimit: 60` 与
   `lastCandidate.cause`。
4. 宿主启动后确认日志三行：`已发布入站端口 dsh.companion.expression.v1` /
   `已注册 N 个工具` / `[companion-expression-http] 已注册 10 条管理路由`。
5. 首次挂载会自动跑一次 FTS 标签列迁移（日志：`FTS 标签列已按新口径重建 N 行（只做一次）`），
   幂等；失败的后果只是「标签召回少一路」，不阻断模块。
6. 仍保持 `delivery.enabled=false` 观察候选质量，由操作者**显式**打开后才可能真发。

**回滚**
- 代码：`git checkout d20cf1a -- plugins/companion-expression`（或 revert 本分支提交），重新 `npm run build`。
- 数据：本次**没有 schema 变更**（沿用 v1/v2 表结构），唯一的数据侧副作用是
  `meta.fts_label_index = 'labels-v2'` 与按新口径重建的 FTS 行。旧代码读同一张 FTS 表仍然可用
  （多索引了情绪/语气标签，只会多命中、不会漏命中）；若要彻底回退，删掉 `meta` 里
  `fts_label_index` 这一行让新代码下次重建即可，**不需要重建数据库**。
- 配置：删掉 `retrieval.poolLimit` 即回到默认 60；`minFitScore` 未改，无需回滚。

## 7. 证据分级（逐项）

| 项 | 级别 | 说明 |
|---|---|---|
| 近义归一化 / 否定规则区分（别笑了、笑不出来、好气又好笑） | `offline-test` | `test/synonyms.test.mjs` 10 项 |
| 多路召回 / 冲突约束 / 阈值 / 纪律回归 | `offline-test` | `test/retrieval-fit.test.mjs` 9 项 |
| 阈值可达性（新权重下的天花板 0.925 > 0.72） | `offline-test` | `test/calibration.test.mjs` 9 项 |
| 整个模块 | `offline-test` | 247 项全绿 |
| 全仓库 unit/static | `offline-test` | `verify`：unit 9 ok、static 39 ok |
| 宿主装载 | **未做** | 需要在独立环境启动 DSH 才能拿到 `host-load` 证据 |
| 真实 QQ 发图 | **未做** | 需要操作者显式触发；本次按要求未触发 |

**措辞约束**：只能说「离线测试层面，检索链路的相关素材召回与排序已修复（247 项通过）」；
**不能**说「真实 QQ 已可用」——那要有 `host-load` 与 `real-send` 两级证据。
