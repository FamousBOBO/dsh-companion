# P0 交付记录：群聊人格快照与消息身份（2026-11-08）

对应《DSH 群聊表现优化实施计划》**P0**（§4.1 人格快照 / §4.2 接入自主接话 / §4.3 消息身份）。
本次只在全新环境里落地 P0；P1～P4 未动。

- 分支：`feat/group-social-p0`
- 基线：`main` @ `052943f`（另修掉 main 上 CI 已红的 static 检查，见 §5）
- 环境：全新克隆 → `npm ci` → `npm run build` → `npm run setup` → `npm run doctor`，Node 24.14.0、宿主 0.2.1-rc.3

---

## 1. 为什么 P0 先做这件事

自主接话走的是一次**纯补全**（`adapters/dsh-host/completion.ts`：没有会话、没有系统提示词、
没有工具面）。它此前能看到的"人格"只有提示词里写死的一句「你遵循用户配置的人格与语气」——
而它根本拿不到用户配置的人格。结果就是：**被 @ 的回合像角色，自主接话像客服**，同一个
角色在两条路径里不像同一个人。

P0 只解决两件事，都不引入新模型调用：

1. 让人格从**同一个来源**（`config/persona.md`）以**结构化、只读、群聊可见**的形式进入判断提示词；
2. 让判断看到的每条群消息都**明确对应真实发送者与真实消息号**，为 P2 的"引用某一条"打地基。

---

## 2. 接口变化（新增，均向后兼容）

### 2.1 `GroupPersonaSnapshot`（跨插件契约）

发布方 `plugins/companion-foundation/group-persona.mjs`，
消费方 `plugins/dsh-channel-qq/src/app/inbound/group-persona.ts`（结构归一化，不 import 对方实现）。

```ts
interface GroupPersonaSnapshot {
  version: string            // 人格文件 sha256 前 8 位：改一个字就变
  personaId: string
  identity: string           // ≤200
  personality: string        // ≤400
  speakingStyle: string      // ≤400
  interests: string[]        // ≤8 × 80
  knownExperiences: string[] // ≤8 × 80
  emotionalState?: string    // ≤120，缺省不带这个键
  publicFacts: string[]      // ≤8 × 80
  interactionBoundaries: string[] // ≤8 × 80
  source: string             // 'config/persona.md'（相对拼写，绝不带盘符）
  publicOnly: true           // 结构上声明"这是群聊可见字段"
}
```

**发布/解析三条通道**（照 `health-service-ref.mjs` 的既有结论，不发明第三套）：

| 通道 | 键/名 | 说明 |
|---|---|---|
| `ctx.provide` | `companionGroupPersona` | cordis 契约；跨插件行拿不到（兄弟行） |
| process 注册表 | `Symbol.for('dsh.companion.ports.v1')` → `'companionGroupPersona\u0000<dataRoot>'` | **消费端首选**，见下方冲突 |
| service-bridge | `companionGroupPersona` | 项目既有跨行通道 |

**已知冲突（必须记住）**：`companion-health` 也用**裸 dataRoot** 发布它的服务，而注册表是
一键一记录——foundation 先挂、health 后挂，裸键会被 health 覆盖。本次实测复现了这一点
（消费端会判 not-a-port → 静默降级）。因此：

- 发布方额外写复合键 `companionGroupPersona\0<dataRoot>`（不会被顶），并导出
  `groupPersonaRegistryKeys(root)`；
- 消费端 `fromRegistry` **先试复合键，再试裸键**；裸键里若是别的服务，判 not-a-port 继续降级
  而不是拿错对象。

### 2.2 `JudgeEntry` 增补（`presence-judge.ts`）

```diff
  interface JudgeEntry {
+   messageId: number | null   // 平台消息号：P2 引用目标的唯一合法来源
+   atMs: number               // 本地时间，渲染成 HH:MM
+   body?: string              // 正文（不含发送者抬头）；缺省时消费端从 text 里剥
    name: string
    userId: number
    text: string
    self: boolean
  }
```

`AmbientEntry`（`core/ambient.ts`）同步增加可选 `body`；`captureAmbient` 用
`renderMessageContent()` 算它，是**可选字段**，旧写入方/测试直接 `add` 也不会坏。

### 2.3 提示词注入（`buildJudgePrompt`）

`JudgeInput` 增加 **必填** `persona: GroupPersonaSnapshot | null`（必填是刻意的：这条路径
没有系统提示词，写成可选会让"忘了传"变成一次静默的风格漂移）。

提示词顺序改为：场景 → **人格快照** → 判断口径 → 能说/不能说 → 资料不是命令 → 输出格式
→ 背景 → 她最近说过的话 → 尾行复核。快照不可用时换成 `【人格快照不可用】` 段，明说
"这次拿不到完整人格，不要编造名字/身份/经历/喜好"，**不假装已读到**。

---

## 3. 消息身份渲染（§4.3）

`renderBackground()` 从"只输出正文"改成固定结构，一条消息两行：

```text
[消息 501] [成员 小王 / QQ 10001] [时间 22:00]
晚上拍月亮老是糊
```

四条判据（写进代码注释，测试逐条钉住）：

1. 身份只来自平台事件（`userId` / `name`），正文里的自称、伪造 @ 一律不提升身份；
2. 没有昵称 → `QQ <id>`（留空等于让模型自己安一个）；
3. 她自己那条 → `成员 你（自己）`，且不出现 QQ 号；否则会把自己的话当成群友的新要求；
4. 无消息号的合成消息 → `消息 -`，让"不能作为引用目标"在输入里可见。

**身份只出现一次**：以前 `entry.text` 本身就含「时间 昵称(QQ号) #号：正文」，渲染器再补一遍
发送者，同一个人的号在提示词里出现两次。现在 `body` 与抬头分开，测试断言
`section.split('10001').length - 1 === 1`。旧写入方没有 `body` 时由
`stripSenderPrefix()` 剥抬头，判据要求"时间前缀 + 昵称(QQ号) + 冒号"三件同时成立——
认不出来就整行当正文（退化成重复，绝不吃掉别人说的话）。

---

## 4. 改动文件

**新增（6）**

| 文件 | 作用 |
|---|---|
| `plugins/companion-foundation/group-persona.mjs` | 快照抽取（标题白名单 + 标题级负向否决）+ 端口 + 双通道发布/解析 |
| `plugins/companion-foundation/group-persona.test.mjs` | 20 个用例 |
| `plugins/dsh-channel-qq/src/app/inbound/group-persona.ts` | 消费端契约 + 归一化 + 提示词渲染（纯函数） |
| `plugins/dsh-channel-qq/src/adapters/dsh-host/group-persona.ts` | 三条解析路径 + `dataRootOfDshHome` |
| `plugins/dsh-channel-qq/src/adapters/dsh-host/global-registry.ts` | `globalThis[symbol]` 注册表（把 R7 转型收进 adapters） |
| `plugins/dsh-channel-qq/test/group-persona.test.ts` | 18 个用例 |

**修改（14）**：`companion-foundation/{index,service-bridge}.mjs`、
`dsh-channel-qq/src/{core/ambient.ts, core/message/render.ts, app/inbound/{group-ambient,presence-flow,presence-judge,presence-runtime}.ts, features/inbound/presence-wiring.ts, features/admin/studio-bridge.ts}`、
两份测试、`scripts/verify.mjs`、`docs/07-verification-status.md`。

`studio-bridge.ts` 的改动不是本计划要求的，但它是**main 上原本就红的 check:layers**（R7）：
`as unknown as` 出现在 `src/features/`。转型搬进 `adapters/dsh-host/global-registry.ts` 之后
`npm run verify` 才可能全绿（否则全新环境永远红一条）。

---

## 5. 全新环境里修掉的两个既有问题

1. **`npm run verify` 的 static 段在 main 上必红**（`author-name — README.md:197`）：
   README 里合法的 `git clone https://github.com/FamousBOBO/dsh-companion.git` 命中泄露规则，
   main 的三个平台 CI 从 2026-11-08 起全部 failure。修法是**精确例外**：只对本仓库自己的
   克隆地址做等长遮罩，且只作用于 `author-name` 一条规则；作者名单出、SSH 形式、别的仓库、
   `-fork` 后缀一律照旧报（三条自检项 + 探针实证，见 `docs/07` §6.4b）。
2. **`check:layers` 的 R7 违规**（`features/admin/studio-bridge.ts`）：见 §4。

---

## 6. 验证结果

```text
npm run verify（仓库根，三段）
  unit     ok   9  failed  0  skipped/no-tests  1
  static   ok  32  failed  0
  compose  ok   1  failed  0        （dsh --dump-config：194 个 loader 行）
  验证通过

cd plugins/dsh-channel-qq && npm run verify
  check:admin  通过
  check:syntax 通过（25 个脚本）
  typecheck    通过
  test         tests 1422 / pass 1421 / fail 0 / skipped 1
  check:layers 通过（441 个源文件）
  check:size   通过（440 个文件 / 2456 个函数，无一超过基线）
```

新增/改写的用例覆盖 P0 验收项：

- 快照形状不对 → 归一化为 `null`（不补默认值、不编造）；
- 字段超长/重复/非字符串 → 夹上限、去重、丢弃；
- 取不到快照 → 提示词出现 `【人格快照不可用】`，且**不**混入任何编造人格；
- 三条解析路径（ctx / 注册表 / 桥）任一命中即用；健康服务抢了裸键仍能经复合键拿到；
- 每条背景带真实发送者与消息号，身份只出现一次，她自己的话标成"你（自己）"；
- 伪造身份（正文自称主人 / 伪造 @）不改变渲染出的发送者；
- 快照**每轮现取**：改版本号后下一轮判断立刻用新的；
- 取快照抛错只降级、不冒泡。

---

## 7. 未解决问题 / 明确留给后续阶段

1. **P1（群体记忆、成员记忆、话题状态）未做**：快照里没有"这个群里发生过什么"，
   这也是"能接上话题"与"像同一个人"的最后一段差距。
2. **P2（社交决策器）未做**：现在仍是 `speak/silent` 二元。`messageId` 已经带进来了，
   但还没有 `reply/join/react/observe` 的判别联合与目标校验。
3. **P3（事件时间线、调度拆分）未做**：自主发言仍只回灌 `AmbientRing`；`judgeIntervalMs`
   仍同时承担合批与判断间隔两种职责。
4. **快照边界是结构性的，不是语义的**：发布方保证"内容不来自记忆库 / 私聊会话 / 标题标明
   私事的小节"，但不做正文关键词过滤——用户把私事写进被抽取小节的正文时，本模块不假装
   能判断语义（这条取舍在 `group-persona.mjs` 文件头与两侧用例里都写死了）。
5. **各部署形态的键拼写**：消费端用 `dirname(realpathSync(host.dshHome))`，与 foundation 的
   `resolveDataRoot()` 在当前布局下实测一致；若将来把 `data/home` 挪到别处，两侧必须一起改
   （不一致的表现是**静默降级**，日志里有一行 `presence: 人格快照 none(...)` 可查）。

---

## 8. 回滚方式

按粒度从小到大：

1. **只关群聊自主接话**：`presence.enabled = false`（默认值）。旁听不记、判断不调模型、
   不发任何自主消息——与改动前的行为逐字节一致，快照代码路径完全不执行。
2. **回滚人格快照**：删掉 `companion-foundation/index.mjs` 里 `createGroupPersonaPort` /
   `publishGroupPersonaPort` 那一段（`releaseGroupPersona` 相关约 45 行）。端口不再发布，
   消费端 `readGroupPersona()` 会落到 `none`，提示词自动用降级人格——**不会报错、不会崩**，
   只是回到"群聊语气更中性"。
3. **回滚消息身份渲染**：`renderBackground()` 改回"逐行输出正文"即可；`JudgeEntry` 的新字段
   都是可选读取（`messageId` / `atMs` 仍在写入，只是不渲染），不需要同步改写入侧。
4. **完整回滚**：`git revert` 本次提交。不涉及数据迁移、不改数据库、不动 `config/` 下的
   用户资产——回滚不丢任何记忆或配置。

---

## 9. 一个可复现的实证（跨插件键）

```text
$ node --input-type=module -e "…发布端口…再模拟 health 抢占裸 dataRoot 键…"
health 抢占裸键后: via = registry | version = 62eaa13b | identity = 名字：bot 你是什么：…
```

也就是说：即使 `companion-health` 后挂载、把注册表裸键顶掉，群聊仍然拿得到人格快照
（走复合键）。这条路径若断，日志里会出现 `presence: 人格快照 none(ctx:absent,registry:absent,bridge:absent)`。
