# 衣柜状态合同（Wardrobe State Contract）

本文件是 `feat/companion-visual-identity-wardrobe` 分支的**接口权威**。实现与测试都以这里为准；
实现与本文不一致时，先改本文再改代码，不允许「代码悄悄变成另一种语义」。

范围：衣柜数据结构 v2、场景解析、覆盖有效期、日期确定性轮换、只读视觉状态解析。
不包含：主动行为、定时器、外发消息、模型调用。

---

## 0. 现状（审计结论摘要）

| 事实 | 证据 |
|---|---|
| 衣柜是**单文件** `home/companion/wardrobe.json`，schemaVersion 1 | `wardrobe.mjs:11,33-35` |
| 五个槽位 `upper/lower/whole/feet/extra` | `wardrobe.mjs:12` |
| 轮换种子 = `当地日期 + 槽位 + tendency` | `wardrobe.mjs:114` |
| 显式覆盖只存**当天**一套（`current.date`），跨日自动失效 | `wardrobe.mjs:106,162-165` |
| 衣柜不感知时间、场景、日程、活动 | 全文件无 `hour`/`activity`/`context` |
| 注入点：System Prompt 静态 section `companion:wardrobe`（order 63），文本在渲染时计算 | `index.mjs:195-202` |
| 媒体层读衣柜：`wardrobeDetail(dataDir, {scope:'today'})`，**要求模型自己在 `outfit` 里写英文衣物** | `companion-media/src/service.mjs:324-333` |
| 仓库内**没有** Visual Identity 实现（`visual-identity`/`resolveCompanionVisualState` 全分支 0 命中） | `git grep` 五分支均为空 |
| 历史验收 `logs/wardrobe-schedule-20261031/` 只证明「日轮换 + 两个工具 + prompt 注入」存在过，源码 sha256 与当前树**完全一致**（wardrobe.mjs `1dfd5fc5…`），planner/foundation 因后续提交已不同 | `evidence.json:10-13` + 本机 `Get-FileHash` |

结论：需要**增量扩展**，不是重写。日期确定性机制、五槽位、`scope=today|slot|all`、`setOutfit` 语义全部保留。

---

## 1. 数据结构 v2

文件：`<root>/home/companion/wardrobe.json`（配置人格）或 `wardrobe.<personaId>.json`（其他人格，见 §2）。

```json
{
  "schemaVersion": 2,
  "ownerPersona": "bot",
  "tendency": "……",
  "items": [
    {
      "id": "sleep-top-001",
      "slot": "upper",
      "contexts": ["sleep"],
      "name": { "zh": "浅蓝棉质睡衣上衣", "en": "pale blue cotton pajama top" },
      "description": {
        "zh": "浅蓝色柔软棉质长袖睡衣上衣，白色滚边，少量浅粉色装饰",
        "en": "A relaxed pale blue cotton pajama top with white piping and a little pale pink trim"
      },
      "season": ["all"],
      "enabled": true,
      "provenance": { "source": "seeded-default", "initializedAt": "2026-11-10T00:00:00.000Z" }
    }
  ],
  "outfits": [
    {
      "id": "sleepwear-default",
      "context": "sleep",
      "pieces": { "upper": "sleep-top-001", "lower": "sleep-bottom-001", "whole": null, "feet": null, "extra": null },
      "enabled": true,
      "provenance": { "source": "seeded-default", "initializedAt": "2026-11-10T00:00:00.000Z" }
    }
  ],
  "overrides": [
    {
      "id": "ovr_1",
      "personaId": "bot",
      "context": "home",
      "pieces": { "upper": "...", "lower": "...", "whole": null, "feet": null, "extra": null },
      "instruction": "今天想轻便一点",
      "createdAt": 1794000000000,
      "until": 1794086400000,
      "source": "companion_outfit_set"
    }
  ],
  "current": null
}
```

硬性要求：

1. `contexts` 是**组合适用条件**，不是新槽位。缺省 `["everyday"]`。
2. `context` 取值域固定为 `everyday | home | sleep | outdoor | special`；未知值丢弃。
3. 一件衣服可用于多个场景（`["everyday","home"]`）；但**不会**因为它存在于衣柜就自动可用于 `sleep`。
4. `pieces` 允许任意槽位为 `null`；`whole` 与 `upper/lower` 互斥（`whole` 非空时 `upper`/`lower` 视为无效）。
5. 英文描述 `en` 是生图的**权威文本**；`zh` 只用于对话与提示词。
6. `season` 本阶段**只存储**，不参与解析，不接天气数据。
7. `enabled: false` 的衣物/组合不参与解析，但保留在文件里。
8. `provenance.source` 至少区分：`seeded-default`（本阶段新建的种子数据）/ `user`（用户或操作者写入）/ `migrated-v1`。**新建的种子衣物不得被表述为「一直就有的历史事实」**。
9. v1 的 `current` 字段保留读取兼容，但写入一律落到 `overrides`；迁移时 `current` 转成一条 `until = 该当地日期当天结束` 的 override 并保留 `current` 原样以便回滚。

## 2. 人格隔离与文件定位

```
wardrobeFileFor(root, personaId):
  base = <root>/home/companion/wardrobe.json
  if !personaId                → base
  if base 不存在               → base                  （首次运行，由种子写出）
  if base.ownerPersona 缺失    → base                  （v1 迁移后的文件，认作当前人格）
  if personaId === base.ownerPersona → base
  else                          → <root>/home/companion/wardrobe.<personaId>.json
```

- 其他人格**没有**自己的文件时，解析返回 `{ ok:false, code:'wardrobe-missing-for-persona' }`，
  **不允许**回落到别人格的衣柜。
- `ownerPersona` 在文件首次创建/迁移时写成当时的 `personaId`。
- 会话 id 以 `qq-group-` 开头时解析直接返回 `{ ok:false, code:'wardrobe-unavailable-in-group' }`。

## 3. 场景解析（Wardrobe Resolver）

```js
resolveWardrobeState({
  root, personaId, sessionId, now = Date.now(), timeZone = 'Asia/Shanghai',
  activity = null,        // { kind, title, detail, status, startedAt, endedAt } | null
  schedule = null,        // { title, detail, startAt, endAt, kind } | null（仅「正在发生」的一条）
  explicit = null,        // 本轮明确要求：'sleep' | {...} | { itemIds: [] }
  config = null,          // 覆盖 wardrobe.config.json
})
```

返回（字段只增不改，`ok:false` 时也返回 `context`/`reason` 便于诊断）：

```js
{
  ok: true,
  code: 'ok',
  personaId, date: '2026-11-10',
  context: 'sleep',
  contextLabel: '睡衣',
  outfitId: 'sleepwear-default',
  pieces: { upper: { id, nameZh, nameEn, descZh, descEn } | null, lower, whole, feet, extra },
  reason: 'night-window',              // 见 §3.2
  reasons: ['night-window'],           // 完整链路，调试用
  source: 'wardrobe-resolver',
  override: null | { id, context, until, instruction, expired:false },
  missing: ['feet'],                   // 组合里为空的槽位
  rotationKey: '2026-11-10|bot|sleep',
  nightWindow: { enabled:true, start:'22:30', end:'07:00', timeZone:'Asia/Shanghai' },
  notes: []
}
```

`ok:false` 的 code：
`wardrobe-missing-for-persona` / `wardrobe-unavailable-in-group` / `no-outfits-for-context` /
`no-outfit-for-context` / `outfit-pieces-unresolvable`。

### 3.1 优先级（严格从高到低）

1. **本轮明确的服装要求**（`explicit`）。只在本次调用内生效，写磁盘的只有 `companion_outfit_set`。
2. **未过期且适用于当前场景的显式覆盖**（`overrides`）。
3. **可信的当前活动 / 日程**（`activity`、`schedule`，且必须是「正在发生」）。
4. **昼夜时间窗口**（`nightWindow`）。
5. **当前场景下的日期确定性轮换**。
6. **该场景的默认组合**（`outfits` 中该 context 的第一套 enabled 组合）。

关键约束：

- 白天（`everyday`/`home`/`outdoor`/`special`）的覆盖**不得**无条件阻止夜间切换到睡衣。
  实现见 `wardrobe-state.mjs#overrideAppliesTo`：
  - 场景标签为白天场景的覆盖：在白天场景之间互相适用（"今天就在家"是对这一天的陈述，
    不只对某一分钟的分类），但自动场景变成 `sleep` 后**不适用**；
  - 场景标签为 `sleep` 的覆盖：只适用于 `sleep`（这本身就是"换上睡衣"的明确要求）；
  - 无场景标签（`any`，旧调用形态写入的）：处处适用，**唯一例外**是夜间 + v1 `current`
    遗留镜像——那个镜像只描述过白天轮换，不能把白天的衣服留到 02:00；
  - 同类里新的覆盖优先；场景标签的覆盖优先于无标签的。
- `override.until <= now` 时视为过期，**不删除**记录（保留可审计），解析时跳过。
- 上一轮用户说「要出门」不会自动延续到下一轮：外出只来自本轮 `explicit`、未过期的 `outdoor` 覆盖、
  或当前正在发生的外出活动/日程。
- 计划（`companion_schedule_*` 的 `planned` 槽位、P2 plan slot）**不是**已发生：只接受
  `startAt <= now <= endAt` 的时段作为「正在发生」证据；`status` 为 `skipped`/`cancelled`/`done`/
  `dispatched`/`expired` 的一律不算。读取入口是 `wardrobe-evidence.mjs#collectLifeEvidence`，
  它同时也读取正在运行的 P2 活动（真实行 + 真实状态）。
- 该读取使用与 `companion_schedule_today` **同一个** runtime 接口（`todaySchedule`）。
  需要说明它的一个既有行为：当本进程是活跃写者时，这个读接口会先把尚未生成的 occurrence
  **物化**（`materializeAgendaScope`，受 `agenda.maxGeneratePerCall` 限制、按 slot key 幂等）。
  那是一次由读路径触发的写，但它是 runtime 长期以来的行为，且**不派发、不发送、不推进状态**——
  衣柜只读 `status`，不会因为看了一眼日程就制造出「活动已发生」。

### 3.2 `reason` 取值

`explicit-turn` / `override-active` / `activity-outdoor` / `activity-sleep` /
`activity-home` / `activity-special` / `night-window` / `evening-home` /
`daytime-home` / `daytime-everyday` / `rotation`（作为 `reasons` 补充）/ `default-context-outfit`。

### 3.3 自动场景判定（可配置，全部为代码判定，不让 LLM 维护状态）

默认配置 `home/companion/wardrobe.config.json`（缺失时用内置默认，文件只读不改写）：

```json
{
  "timeZone": "Asia/Shanghai",
  "nightWindow": { "enabled": true, "start": "22:30", "end": "07:00" },
  "eveningFrom": "19:00",
  "outdoorKeywords": ["出门", "外出", "上班", "上学", "买菜", "散步", "约会", "医院", "旅行", "去到"],
  "sleepKeywords": ["准备睡觉", "睡前", "洗澡", "换睡衣", "洗漱"],
  "specialKeywords": ["演出", "生日", "节日", "穿正装", "拍照活动"]
}
```

判定顺序（`classifyContext`）：

1. `explicit` 命中 → 该场景（reason `explicit-turn`）。
2. 正在发生的活动/日程文本命中 `specialKeywords` → `special`。
3. 命中 `outdoorKeywords` → `outdoor`。
4. 命中 `sleepKeywords` → `sleep`。
5. `nightWindow` 内（跨午夜正确） → `sleep`。
6. 当地时刻 `>= eveningFrom` → `home`。
7. 正在发生的活动是室内类（`read`/`write`/`explore`/`bilibili`）→ `home`。
8. 否则 → `everyday`。

跨午夜：`start > end` 时窗口为 `[start,24:00) ∪ [00:00,end)`。`22:20 → home`、`22:40 → sleep`、
`02:00 → sleep`、`06:50 → sleep`、`07:10 → home|everyday`。

### 3.4 日期确定性轮换

```
rotationKey = `${localDate}|${personaId}|${context}`
index = sha256(rotationKey).readUInt32BE(0) % candidates.length
candidates = outfits.filter(o => o.enabled && o.context === context)  // 稳定顺序 = 文件顺序
```

- 同一天同一场景**恒定**；不同场景可不同；不同人格不共享（personaId 进种子）。
- 没有该场景的组合 → `ok:false, code:'no-outfits-for-context'`，**不静默回退**到别的场景。

## 4. 工具合同

### 4.1 `companion_wardrobe_detail`

参数：`scope`（`today|slot|all|contexts`，默认 `today`）、`slot`、`context`（可选，覆盖自动场景）。

`scope=today` 保留旧字段（`ok/scope/date/source/instruction/items/text`），**新增**：

```json
{ "context": "sleep", "contextLabel": "睡衣", "outfitId": "sleepwear-default",
  "reason": "night-window", "override": null, "missing": [], "pieces": { … },
  "resolver": "wardrobe-resolver", "isOverride": false, "rotationKey": "…" }
```

`source` 旧值域扩展：`daily | explicit | scene:rotation | scene:default | override | missing`。
`scope=contexts` 返回五个场景各自是否能解析出组合（`ok`/`code`），供模型在缺衣服时如实回答。

### 4.2 `companion_outfit_set`

参数沿用：`itemIds`、`instruction`；新增 `context`（默认取当前自动场景）、`until`
（ISO 或 Unix ms，缺省 = 当地当天 23:59:59.999）、`clearOverride`（`true` 时只清除覆盖）。

- 旧调用（只给 `itemIds`）**语义不变**：写入一条当日有效的覆盖。
- `until` 解析失败 → `ok:false, code:'bad-until'`，不写盘。
- `clearOverride:true` → 删除当前人格未过期的覆盖（可带 `context` 只清该场景），返回被清除的条数。
- 写入前校验：`itemIds` 至少命中一件，否则 `code:'item-not-found'` 且不写盘。

## 5. Prompt 注入

- `companion:wardrobe` section 变为**极短静态真实性约束**（不写任何具体衣物）。
- `agent/pre-step`（step 1，复用现有快照拼装）追加 `companion-wardrobe` 段落：

```
【当前穿着】
场景：睡衣
- 上装：浅蓝色柔软棉质睡衣上衣，白色滚边
- 下装：同色系宽松睡裤
- 鞋：无（在房间，赤脚）
状态来源：衣柜自动解析（night-window）
换睡衣只说明现在穿着睡衣，不代表已经睡着，也不要据此推断睡眠时长。
```

- 无可靠快照时注入 `【当前穿着】当前无法确定（<code>）；被问到穿着时如实说不知道，不要编造。`
- 每轮最多一次；不超过 480 字符；与工具返回的 `context/outfitId/pieces` 必须一致（同一解析函数）。

## 6. 视觉状态（Visual Identity + Wardrobe）

```js
resolveCompanionVisualState({ root, personaId, sessionId, now, timeZone, activity, schedule, explicit })
```

返回：

```js
{
  ok: true,
  personaId,
  identity: {
    state: 'configured' | 'not-configured',
    name: '…', nameEn: '…',
    source: '…', sourceEn: '…',
    appearanceZh: '…', appearanceEn: '…',
    provenance: { source: 'user'|'template', updatedAt }
  },
  wardrobe: { context, contextLabel, outfitId, reason, pieces, missing, ok, code },
  imageClause: 'A … wearing …' | '',
  missing: ['identity'] | ['wardrobe'] | [],
  notes: []
}
```

- 数据文件 `<root>/home/companion/visual-identity.json`，按人格键 `personas.<personaId>`；缺失 →
  `state:'not-configured'`，**不编造**外貌。
- 身份来自 Visual Identity 数据，服装来自衣柜权威数据，两者都以当前 `personaId` 为键。
- 媒体层 `subject=companion` 时：`imageClause`（身份 + 当前服装英文）自动拼进 prompt；
  模型不再需要写 `outfit`。传了 `outfit` 仍接受（旧调用兼容），记为 `outfitSource:'explicit-arg'`。
- `subject=other` 或空 subject：行为与现在完全一致。

### 6.1 跨插件边界（实际实现）

媒体层 `src/service.mjs` **import 一个纯函数** `resolveCompanionVisualState`（由
`companion-foundation/visual-identity.mjs` 导出，并已写进 foundation 的 `package.json` exports）：

- 它不写文件、不发请求、不打开数据库、不返回文件句柄，只返回一个普通对象；
- 它不需要新增 Service Bridge 名字：`companion-media` 本来就持有 `dataDir`（配置、作业台账都在那里），
  这次没有扩大它能读的范围，只是把「读衣柜」从「自己按 v1 逻辑读 `wardrobe.json`」换成
  「调用权威解析器」——后者反而更窄：它按 `personaId` 选文件、自己拒绝 `qq-group-*` 会话；
- 因此本阶段**没有**新增 `companionVisual` 端口。若将来有多消费者（例如 Studio 页面）需要
  在 host 上下文里取同一份快照，再按 `service-bridge.mjs` 的白名单加一个只读端口，而不是让
  调用方各自读文件。
