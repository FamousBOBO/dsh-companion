# companion-expression（表情包系统）

被动收集 + 语义卡 + 检索决策 + 统一回复计划 + 真实投递与反馈，**以及 Studio 管理入口**
（陪伴空间侧栏「工具 → 表情包」：图库 / 收集规则 / 自然度实验室 / 表达习惯）。

- 0 新依赖，只用 `node:` 内置模块；Node ≥ 24（`node:sqlite`）。
- **默认两层闸门都关**：`modules.expression`（补丁里挂不挂）与 `delivery.enabled`（能不能真发）。
- 合同见 [CONTRACT.md](./CONTRACT.md)；数据落在 `<dataDir>/home/expression/`。

---

## 1. 它做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 按来源授权被动收集图片，同字节只存一份文件 | 主动爬取、在别人的群里批量抓图、扫描磁盘上的表情包目录 |
| 整包导入：操作者给一张**手工语义卡清单** + 一个 zip，脚本按清单逐张入库（见 §4.1） | 从图片里猜语义：OCR / 视觉模型 / embedding 都不做（合同级未实现） |
| 给每张图生成语义卡（字面 / 意图 / 情绪 / 语气 / 场景 / 忌讳） | GIF 关键帧理解、OCR、embedding 向量召回（都是合同级未实现） |
| 检索 + 决策 + 生成 `ResponsePlan`（本轮要不要发图） | 保证一定发得出去：投递失败一律 fail-closed 退回纯文字 |
| 经 QQ 通道把**已授权、已审核**的图发出去，并记录回执 | 用 QQ 内置表情、发别人没授权的图、跨房间复用（默认禁止） |
| Studio 里看图库、改规则、模拟决策、看表达习惯 | 在页面上构造文件路径、把路径回传、用页面触发模型调用 |

---

## 2. 两层闸门

```jsonc
// config/suite.json —— 决定补丁里那两块在不在
{ "modules": { "expression": true } }
```

```jsonc
// <dataDir>/home/expression/config.json —— 决定「能不能真发」
// 首次挂载时原子生成一次，之后绝不覆盖；改完保存即生效
{ "enabled": true, "delivery": { "enabled": true } }
```

只打开第一层：收集、分析、检索、决策、模拟、图库全部可用，**一张图也不会出门**。
模板见 [config.example.json](./config.example.json)。

| 段 | 关键字段 | 默认 | 说明 |
|---|---|---|---|
| `capture` | `ownerPrivate` / `groupEnabled` | `true` / `false` | 群采集必须逐群授权；每个群有 `capture` / `store` / `use` 三个独立开关 |
| `capture` | `privatePeers` / `peers[]` | `opt_in` / `[]` | 非主人私聊默认一律不收集，要采集得逐个 `approved:true` |
| `capture` | `maxDownloadBytes` / `maxPerHour` | `10485760` / `60` | 单个素材体积上限与采集限流 |
| `capture` | `uncertain` / `cloudVision` | `review` / `deny` | 分类不确定进复核；`deny` = **绝不调用云端视觉模型** |
| `analysis` | `mode` / `minConfidence` | `heuristics` / `0.55` | `host-vision` 需要 `cloudVision: "allow"`，否则按启发式跑并说明 |
| `retrieval` | `candidatesToModel` / `minFitScore` / `poolLimit` | `5` / `0.72` / `60` | 只给模型 3–5 个候选；低于阈值退化为纯文字；`poolLimit` 是召回合并后的待排序池上限（10–200） |
| `delivery` | `enabled` | `false` | **真发送的总闸** |
| `delivery` | `maxPerTurn` / 冷却配额 | `1` / 私聊 300s+3 轮、群 600s、4 张/时、2 张/时 | 基线，不是固定频率 |
| `delivery` | `repeatWindowDmHours` / `repeatWindowGroupHours` | `48` / `168` | 同图重复抑制窗口 |
| `delivery` | `stageRoot` | `home/media/expression-out` | 只接受仍在 `home/media` 内的路径；越界回退默认（页面只读展示） |
| `privacy` | `crossRoomReuse` / `publicRequiresApproval` / `deleteOnRevocation` | `false` / `true` / `true` | 跨房间复用默认禁止 |

---

## 3. 目录与数据

```
<dataDir>/home/expression/
  expression.sqlite      素材、来源、可见性、语义卡、投递、反馈、配额
  assets/<aa>/<sha256>   去重后的图片字节
  quarantine/            隔离素材（永不发送；页面需 allowQuarantine=1 才能看）
  queue/                 分析中的临时暂存
  config.json            本模块配置
  logs/expression-events.jsonl
<dataDir>/home/media/expression-out/   唯一允许群聊发送的临时目录
```

群出站守卫（`plugins/companion-group/core.mjs`）没有被放宽：只有 `home/media` 里的文件进得了群聊，
所以暂存区放在那里，而不是把守卫扩到「任何表情包目录」。

---

## 4. 管理入口（Studio）

侧栏「工具 → 表情包」，四个页签：**图库 / 收集规则 / 自然度实验室 / 表达习惯**。
它们只经 `/api/companion-expression/*` 读写，**只认 `assetId`**，客户端从不构造也不会收到文件路径。

| 页签 | 你能做的事 | 语义务实 |
|---|---|---|
| 图库 | 搜索、过滤、单图抽屉、通过 / 退回复核 / 隔离 / 禁用 / 删除 / 改写语义卡 | 空图库说「还没有素材」，不是「加载中」 |
| 收集规则 | 全局开关、逐群三开关、私聊授权、限流数值、撤销并清理 | 开关保存即生效；撤销时说清素材怎么办 |
| 自然度实验室 | 输入聊天片段 → send/abstain + reasonCode + top5 候选 + 模拟消息 | **常驻标明「模拟不会向 QQ 发送任何内容」** |
| 表达习惯 | precision / context_fit / awkward / repeat_7d / abstain / delivery_confirmed / unknown / leak=0 / p95 + 最近投递 + 负反馈 | 读不到的指标写「—」，不估算、不画 0 |

页面**没有**「测试连接」按钮：这个模块没有轻量探测，唯一的证据是一次真实投递回执。

---

## 4.1 整包导入（把一个表情包变成能用的图库）

图库唯一的写入口是 `library.receive()`，它只认字节、格式和审核态；而**语义卡是人写的判断**，
不是能从 PNG 字节里算出来的（本模块不做 OCR、不做视觉理解）。所以导入的形状是
「操作者手写的清单 + 压缩包」两样东西对上号：

```bash
# 1. 先预演：只验字节、只报计划，绝不写库、绝不落文件
node plugins/companion-expression/scripts/import-pack.mjs \
  --pack plugins/companion-expression/packs/qq-232180.json \
  --zip  <你的表情包.zip> --dry-run

# 2. 确认无误再真导（默认给主人私聊 + config 里 use:true 的群各写一行 approved）
node plugins/companion-expression/scripts/import-pack.mjs \
  --pack plugins/companion-expression/packs/qq-232180.json \
  --zip  <你的表情包.zip> --group 145326153
```

- 清单格式见 `packs/qq-232180.json`；字段白名单与上限在 `src/pack.mjs`（`file` / `literal` /
  `intents` / `emotions` / `tone` / `scenes` / `avoidWhen` / `aggression` / `description`）。
- 审核态写成 `approved`：`retrieval.mjs` 的硬门只放行 `approved`，导入给 `review` 等于
  「导进去了但永远发不出来」。
- 导入必须至少有一个可见作用域；一张谁都看不见的图入库等于没导入。
- 重跑幂等：同字节只落一份文件、一行来源，卡是 upsert 不是插第二条。
- 证据写到 `<dataDir>/logs/expression-import-<packId>.json`。

---

## 5. 挂载方式

两个补丁块，和 `companion-media` 同一个原因：

- **预设内**：`index.mjs` 注册五个工具（`expression_candidates` / `expression_reply` /
  `expression_feedback` / `expression_library_stats` / `expression_sticker_note`），模型才看得见它们。
  `expression_sticker_note` 是**表情词典**：对方发来的表情是「一句话」而不是一幅画，
  它负责先把意思问清楚、记下来，下次同一个表情直接认出来（见 §7）。
- **顶层**：`http.mjs` 注册管理 API。预设拿到的是 isolate realm，它的 `connection` 是私有实例，
  从预设里注册路由会「报告成功但仍 404」。顶层是唯一被 `connection.fetch.register` 接受的地方。

`cordis.patch.yml` 只挂顶层那一块；预设那行由 `config/profile/companion.patch.template.yml` 的
`expression` 块负责（`npm run setup` 会按 `modules.expression` 渲染它）。

---

## 6. 验收

```bash
cd plugins/companion-expression
node --test "test/*.test.mjs"          # 214 项，全离线、不联网、不碰 data/
```

两条**真宿主**证据（都用一个临时 `DSH_HOME` + 临时数据目录，跑完删掉，不写仓库）：

```bash
npm run check:patch    --workspace=@dsh-companion/expression   # 渲染+合成：217 个 loader 行
npm run check:hostload --workspace=@dsh-companion/expression   # 真启动宿主、两行都装上
```

`check:hostload` 2026-11-07 的实测输出（脱敏）：

```
[companion-expression] 已发布入站端口 dsh.companion.expression.v1（只入队，不回复、不唤醒 Agent）。
[companion-expression] 已注册 5 个工具（defineTool=host）
[companion-expression-http] 已注册 10 条管理路由。
```

裸 `fetch` 那个启动 URL 会回 **401**（宿主 token 要先换会话，浏览器里才有 cookie）——
脚本因此**不拿 200 当判据**，只认「拿到 URL + 没有 `did not activate` + 三行自有日志」。

管理入口在 Studio 侧另有测：

```bash
cd plugins/companion-memory-studio
node scripts/build-client.mjs && node scripts/smoke-client.mjs   # 表情包相关失败 0 项
node --test test/expression-page.test.mjs                        # 16 项
```

---

## 7. 表情是「话」，不是「画」

群里/私聊收到一个表情，QQ 那边给的是 `image` 段 + `summary='[困]'`。原来的处理把它当图片，
渲染成 `[图片][图片含义：[困]]` —— 模型读到的是「我看到一张图，图里有个字」，于是它去描述画面。
用户 2026-11-08 指出：**这是错的**，表情本身就是它要表达的那句话。

现在：

| 环节 | 行为 |
|---|---|
| 入站解析 | `parse.ts` 的 `stickerOf()` 认三种来源（`sub_type=1` / `summary` 带方括号 / mface 字段），把它放进 `stickers`，**不进 `imageSummaries`** |
| 渲染 | `[表情：困｜key=f:0AB4…]`；认不出字面写 `[表情：不认识｜key=…]`——诚实，不猜画面 |
| 指纹 | `f:` 文件名 stem（最稳）→ `k:` mface key → `s:` 字面 → `u:` url 末段。**不含 QQ 号**，跨会话同一个表情认得出 |
| 已在词典里 | 采集时直接用记下的意思当 `literal`，卡片就是那句意思，不是画面描述 |
| 没在词典里 | 只按字面入，卡片留空；一轮里可以**在私聊问一句**「这个表情是什么意思」，问清楚后用 `expression_sticker_note` 记下来 |
| 动图 | 同一个办法：记的是意思，不是帧（`animated` 只用来判断「要不要逐帧看」） |

`sticker_notes` / `sticker_seen` 两张表（schema v2）：前者是「这个表情是什么意思」，
后者只数「在本会话见过几次」——见过 ≥2 次还没记过的，正是最值得问一句的那一批（`stats().askable`）。

---

## 8. 未实现（说清楚）

GIF 关键帧理解、OCR、embedding 向量召回、QQ 内置 `face` 表情投递。
证据分级见仓库的 `docs/07-verification-status.md` §2.6：装载已达成，真实发图有 2 条回执
（其中 1 条回读确认 `sub_type=1` 是表情）；批量、群聊、连续发图仍未验证。
页面能看、规则能改、实验室能模拟，**不等于** QQ 上真能发。
「表情不会被描述成图片」这一条只有**离线测试**（`sticker-parse.test.ts` 9 项）与一次真实入站回读，
还没有「连续几天收到表情都理解正确」的长期证据。
