# companion-expression 合同（v0.1）

> 本文件是对外合同：凡是要读表情包库、读写配置、或渲染「工具 → 表情包」页面的代码，以本文为准；
> 实现细节见 `src/`。骨架（`src/paths.mjs` / `src/config.mjs` / `src/schema.mjs` / `src/db.mjs` /
> `src/scopes.mjs`）是冻结点，任何地方都不得绕开它们另写一套路径或权限判断。

- 版本：`0.1.0`
- 范围：被动收集（按来源授权）、语义卡、检索与决策、统一回复计划、真实投递与反馈，附带 Studio 管理入口。
- 不做：GIF 关键帧理解、OCR、embedding 向量召回、QQ 内置 `face` 表情投递、真实平台发送验收。

---

## 1. 边界（先看这个）

1. **默认不收集、不发图。** 套件级 `modules.expression` 默认 `false`；
   `<dataDir>/home/expression/config.json` 的 `delivery.enabled` 默认 `false`。
   关着时决策、检索、模拟、审核、图库管理全部可用，**一张图也不会出门**。
2. **可见性是硬门，不可计分绕过。** `scopes.mjs` 的 `visibilityGate()` 在任何打分之前执行；
   `review` / `quarantined` / `disabled` / `revoked` 一律不可发送（`SENDABLE_APPROVALS = ['approved']`）。
3. **物理去重不合并权限。** 同字节图片只存一份文件（`assets.sha256` 唯一），
   但 `asset_sources` / `asset_visibility` 按来源各记一行。撤权一个来源不影响另一个来源。
4. **管理入口只认 `assetId`。** 客户端不构造、也不会收到文件路径；`GET /thumb` 是唯一的字节出口，
   且由服务端用库里的 `file_path` + `realpath` 校验后才返回。
5. **模拟 ≠ 投递。** `POST /simulate` 只读：返回决策、候选与「本来会发的那条」，没有投递路径。
6. **未启用要说人话。** 模块没挂上时所有接口返回可读的「未启用」+ 启用片段，不是 500、不是 404。

---

## 2. 服务对象合同（`http.mjs` 的实现 `ctx.get('companionExpression')` 等价物）

`createService()` 返回下面这套方法，`src/studio.mjs` 只依赖它。所有方法都**不抛**异常：
失败返回 `{ ok:false, error:{code,message} }`。

| 方法 | 输入 | 返回 |
|---|---|---|
| `status()` | — | 版本、数据目录、库统计与完整性、`paths`（assets / quarantine / stageRoot） |
| `getConfig()` | — | `{ ok, config, exists, configFile, warnings, stageRoot, status }` |
| `saveConfig(patch)` | 稀疏 patch（深合并） | `{ ok, saved, config, warnings, status }` 或 `{ ok:false, error }` |
| `listAssets(query)` | `query/scope/moderation/sort/limit/offset` | `{ ok, items, total }`（**不含 file_path**） |
| `getAsset(assetId)` | — | `{ ok, asset, card, sources, deliveries, feedback }` |
| `assetAction(action)` | `action` ∈ approve / resend-review / quarantine / disable / delete / edit-card，`assetId`，可选 `card` | `{ ok, ... }` |
| `thumbBytes(assetId)` | 可选 `allowQuarantine` | `{ ok, bytes, mime, filePath }`（`filePath` 只回给 handler 校验用） |
| `listSources()` | — | `{ ok, items }`（群 / 对端 / 公共精选；私聊 scope 是加盐哈希，不回推 QQ 号） |
| `grantScope(input)` | `kind:'group'\|'peer'`、`chatId`、`granted`、`flags` | `{ ok, granted, kind, chatId }` |
| `listDeliveries(query)` | `limit/scope/status` | `{ ok, items, total }` |
| `metrics(query)` | `windowHours/scope` | `{ ok, delivery, feedback, precision, repeat7d, leak, p95 }` |
| `simulate(input)` | `text/isGroup/target/limit` | `{ ok, sending:false, decision, candidates, plan }` |

`library.mjs` 的公开方法是 `createLibrary({db, assetsDir})` 返回的句柄
（`receive` / `register` / `getAsset` / `upsertCard` / `listAssets` / `setVisibility` /
`deleteAsset` / `revokeScope` / `search` / `stats`）；`http.mjs` 的 `createService` 把它包成上表。
`GET /thumb` 直接读库里那一行的 `file_path`，**不做任何路径拼接**，再把路径交给
`src/studio.mjs` 做 `realpath` 校验。

---

## 3. HTTP 路由表（`/api/companion-expression/*`）

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/page` | 页面 descriptor（六态、字段、端点、能力、启用片段） |
| GET | `/config` | 读配置（已归一化，带 warnings） |
| POST | `/config` | 写配置（`{patch}` 或整份对象；校验不过 400 且不写盘） |
| GET | `/assets` | 图库列表（`query/scope/moderation/sort/limit/offset`） |
| GET | `/asset` | 单条：语义卡 + 来源 + 最近投递 + 反馈（`assetId` 必填） |
| POST | `/asset` | **显式动作**：approve / resend-review / quarantine / disable / delete / edit-card |
| GET | `/thumb` | 按 `assetId` 回字节；quarantined 需 `allowQuarantine=1` |
| GET | `/sources` | 授权来源清单 + 每个来源的素材计数 |
| POST | `/grants` | 群 / 对端授权与撤销（`kind`+`chatId`+`granted`+`flags`） |
| GET | `/deliveries` | 最近投递（含 reasonCode、scope 的可读标签） |
| GET | `/metrics` | 表达习惯指标（见 §5） |
| POST | `/simulate` | 自然度实验室：只读决策 + 候选 + 模拟计划，**绝不投递** |

### 3.1 错误码与 HTTP 状态

| code | HTTP | 含义 |
|---|---|---|
| `expression-bad-input` | 400 | 参数形状不对；含 path/file/`..`/反斜杠/盘符/绝对路径 |
| `expression-config-invalid` | 400 | 配置校验没过；**不写盘** |
| `expression-not-found` | 404 | 没有这个 assetId / 缩略图文件已不在 |
| `expression-forbidden` | 403 | 跨站 Origin；或缩略图类型不是图片 |
| `expression-thumb-quarantined` | 403 | 隔离素材未显式 `allowQuarantine=1` |
| `expression-thumb-path-unverified` | 400 | 服务没给出可校验的路径/素材根目录 → 拒绝返回字节 |
| `expression-thumb-path-outside-root` | 403 | realpath 后不在 assets（或隔离目录）内 |
| `expression-disabled` | 200 | 模块未启用（可读文案 + 启用片段；**不是错误页**） |
| `expression-service-failed` | 500 | 服务自身抛了；页面按 `failText` 展示 |

### 3.2 安全约束（写进代码，不是文档承诺）

1. **入参扫描**（`assertSafeInput`）：任何层级出现 `path` / `file` / `\` 字段名 → 400；
   任何值含 `..`、反斜杠、盘符前缀、以 `/` 开头 → 400（自由文本键 `text/query/note/summary/reason` 豁免值扫描）。
   `assetId` 额外拒绝 `/` 与 `\`。
2. **`GET /thumb`**：服务返回的 `filePath` 必须 `realpath` 后落在 `home/expression/assets` 内；
   `allowQuarantine=1` 时额外允许 `home/expression/quarantine`。两条 root 都先 `realpath`，符号链接绕不过去。
3. **Origin**：只允许缺省（同源 fetch）或 `http(s)://127.0.0.1|localhost|[::1]:port`；
   其它一律 403。**不发任何 CORS 头。**
4. **GET 不触发模型调用**：`/page` `/config` `/assets` `/asset` `/thumb` `/sources` `/deliveries` `/metrics` 全是只读。
   `/simulate` 是 POST，但它在 service 层带 `simulate:true`，且返回体 `sending:false`。
5. **未启用**：`createExpressionHandlers(null)` 时每个路由都返回 `expression-disabled`（HTTP 200）与启用片段。

---

## 4. 页面描述（`src/ui-page.mjs`）

```js
pageDescriptor(config, status) -> {
  id, title, group, subtitle, order,
  states: [{id,label} × 6],     // disabled / unconfigured / not-connected / saved-untested / test-ok / test-failed
  state,                        // 当前整体状态（六态之一）
  api: { page, config, save, assets, asset, action, thumb, sources, grants, deliveries, metrics, simulate },
  capabilities: { canTest:false, canTestReason, canSimulate, canSend, canEditStageRoot, canChangeScope },
  sections: [{ id, title, state, fields[] }],
  meta: { configFile, configExists, warnings, http, channel, deliveries, enableSnippet,
          testPolicy:'explicit-only', simulationPolicy:'read-only·never-sends',
          assetIdOnly, notImplemented[] }
}
```

字段都带 `path` / `pathParts` / `label` / `type` / `value` / `writable`；`delivery.stageRoot` 是
`writable:false` 的只读路径（页面展示、不可提交）。`capabilities.canTest` **恒为 false**：
这个模块没有轻量探测，唯一的证据是一次真实投递回执。

---

## 5. 指标口径（`GET /metrics`）

| 字段 | 口径 | 没有数据时 |
|---|---|---|
| `delivery.confirmed` / `unknown` / `failed` | `deliveries.status` 计数；`unknown` **不重试**、也不算成功 | `0`（数据库里真的没有行） |
| `delivery.confirmRate` | `confirmed / (confirmed+unknown+failed)` | `null`（页面显示「—」） |
| `precision` | 显式反馈里 `praise / (praise+reject)`；沉默不计入 | `null` |
| `repeat7d` | 近 7 天 `status=confirmed` 的投递条数 | `0` |
| `leak` | 「不该发却发出去了」的独立计数 | **`null`**：这个库没有该字段，页面显示「—」，**不画 0** |
| `abstain` | 决定「只说话」的次数 | **`null`**：只存在于决策返回值，不落库 |
| `context_fit` | 候选贴合语境的平均分 | **`null`**：没有落库字段 |
| `p95` / `p95Ms` | 投递耗时 p95 | **`null`**：没有记录，不估算 |
| `feedback.{praise,reject,correction,bySignal}` | `expression_feedback.signal` 计数 | `0` |

每个 null 字段都配一句 `*Note`，页面直接展示，不需要自己解释为什么是「—」。

---

## 5.1 模拟（`POST /simulate`）返回两份决策

```jsonc
{
  "ok": true, "sending": false,
  "note": "模拟不会向 QQ 发送任何内容……",
  "decision":          { "send": false, "reasonCode": "abstain-delivery-disabled" },  // 按当前配置
  "decisionIfEnabled": { "send": false, "reasonCode": "text-only-low-fit" },          // 假设总闸打开
  "candidates": [ { "assetId": "ast_…", "summary": "…", "intents": [], "score": 0.31 } ],
  "plan": { "mode": "text_only", "parts": [ { "kind": "text", "content": "…" } ] },
  "retrieval": { "reasonCode": "", "filtered": {…}, "matched": 1, "warnings": [] },
  "scopeNote": "…", "hypotheticalNote": "…"
}
```

为什么两份：`delivery.enabled` 默认关着，只给 `decision` 的话实验室永远显示
「abstain-delivery-disabled」，看不出自然度。所以再算一份「假设总闸打开」的结论，
**明确标为假设**，并且真实闸门的结果同时摆出来。两份都不是投递：`plan` 只是计划对象，
没有任何投递句柄。

检索阶段不提前按 `minFitScore` 剪候选（`simulate` 传 `minFitScore: 0`），这样阈值的效果由
`decision` 表现为 `text-only-low-fit`，页面才说得清「为什么这次不发」。


---

## 6. 入站旁路端口（`process[Symbol.for('dsh.companion.expression.v1')]`）

`dsh-channel-qq` 的 observers 把每一条 QQ 消息的**元数据**递给这里，采集与唤醒彻底分离。
这一格的形状是**实际发布的样子**：

```js
process[Symbol.for('dsh.companion.expression.v1')] = {
  version: 1,
  service,            // 本模块的 service 句柄
  offers(route),      // 同步、永不抛：{kind:'dm'|'group', chatId, isOwner} → boolean
  observe(event),     // 同步、非阻塞、永不抛；只入队（授权判定在服务内部做）
  status(),           // 三行统计，供诊断
}
```

- **先问后发**：`channel-qq` 侧先调 `offers(route)`，返回**不是 `true`** 就整段跳过；只有
  `true` 才继续 `observe()`。两处用的是**同一个判定**（`scopesFor().capture`），所以不会
  出现「端口说收、入库说没授权」的两套口径。
- **只转发元数据**：`{messageId, at, kind:'dm'|'group', chatId, isOwner, senderId, images:[{url,subType?,summary?,emojiId?,emojiPackageId?,key?}], text?}`。
  不含字节、不下载、不 `await`。端口抛错一律吞掉并记一行，**绝不拖慢消息路径、绝不唤醒 Agent**。
- **`observe()` 的回话是适配器自己说的**：`{ok:true, queued:N}`（这条消息有几张图入了队）或
  `{ok:false, queued:0, reasonCode}`（`no-image-url` / `ingest-not-injected` / `ingest-threw`）。
  「接了」与「收了」不是同一件事，消费端要能看出区别。
- **懒探测**：`companion-expression` 常常比 channel-qq 的 observers 段晚挂载，所以消费端
  每次现取、取不到就立刻返回（只在 `apply` 时探一次会永远接不上）。
- **两处都不在时**：没有端口 = 零开销、零副作用；`modules.expression=false` 时本模块根本不
  发布这一格，通道侧的行为与没有装本模块完全一致。

---

## 6.1 宿主接线（`src/host-wiring.mjs`）：函数型依赖只能从 `ctx` 取

补丁行只能给配置数据（`JSON_SCHEMA` 解析，唯一能带代码的节点是 `!!js`，本仓库不用），
而 cordis 调的是 `runtime.callback(this.ctx, this.config)` —— 所以 `apply(ctx, options)`
的 `options` 里**永远不会有函数**。四样东西因此必须在 `apply` 里从 `ctx` 现取：

| 依赖 | 来源 | 缺了会怎样 |
|---|---|---|
| `qqSender` | `ctx.tools` 的 `qq_message` / `qq_sticker`（旧名 `qq_send_text` / `qq_send_emoji` 亦可）执行器，经 `tools.execute()` 调用 | 不注入 ⇒ `expression_reply` 回 `sender-unavailable`，`delivery.enabled=true` 也只是「闸门开着、没有出口」 |
| `http` | `security.createGuardedHttp({fetchImpl: fetch})` | 入站图片不下载（SSRF 白名单/字节上限/每跳重判都在那里面，本模块不自建 fetch） |
| `ingest` | `ingest.createIngest({db, library, config, http})` + 元数据适配 | `observe()` 回 `ingest-not-injected` |
| `isOwner` | `home/companion/identity.json` 的 `owner.id`（只读，不写） | 主人私聊按 `peer` 处理（宁可不认，也不把陌生人算成主人） |

两条**不变**的性质：

1. **发送仍然是一次真实工具调用**，不是绕过通道自己发请求。因此预执行策略、群边界、
   出站边界、`policy.v2` 全部照常生效；这里只做参数搬运与结果解读。
2. **显式注入优先**。`apply` 的 `options` 里已经给了 `qqSender` / `http` / `ingest` /
   `isOwner` 时，宿主接线**不覆盖**（测试与运维脚本仍可自己接）。一条都没接上时，
   日志里逐条写清缺哪一路，能力本身如实报不可用。

`real-send` 仍**未验证**：接线只证明「有出口且走的是同一道闸门」，「QQ 上真的收到了」
必须由操作者显式触发一次，见 `docs/07-verification-status.md` §2.6。

---

## 7. 未实现（写清楚，不含糊）

GIF 关键帧理解、OCR、embedding 向量召回、QQ 内置 `face` 表情投递、**真实平台发送验收**。
证据分级见仓库 `docs/07-verification-status.md` §2.6：`offline-test` 与 `host-load` 已达成，
`real-send` **未验证**；「图库能看、规则能改、实验室能模拟」不等于「QQ 上真能发」。
