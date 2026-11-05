# 配置

## 三层覆盖

```
内置默认（src/config）
   ↓ 被覆盖
cordis.patch.yml（部署级）
   ↓ 被覆盖
后台保存的覆盖层（<dshHome>/channel-qq/admin-config.json）
```

后一层永远赢。后台改完即时生效，不需要重启（少数标注「需重启」的项除外）。

**「自动重载」是真的重载**：标着它的开关，值一变宿主就把对应子插件卸载重挂
（`watches` 声明）。2026-10-19 修过两处**声明了却没接上**的：记忆证据的注入面
（`inbound` 早于 `memory` 挂载，取值写死在 apply 里）与工具面（`qq-tools` 没监听
`tools.v2` / `memory.v2`）。加配置项时顺手确认 watch 列表，别让徽章说谎。

**手改 `admin-config.json` 不会进审计**：审计与变更历史都记在后台的保存路径上。
要留痕就从后台改；直接改文件只适合"配置坏了要救回来"这种场合。

## 生效方式

每个配置项在后台都带一个徽章：

| 徽章 | 含义 |
|---|---|
| 立即生效 | 下一次使用该值时读到新值，不重挂插件 |
| 自动重载 | 值变化时对应子插件卸载重挂 |
| 需重启 | 写入 `dsh` 进程的环境/监听地址等，重启后生效 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `CHANNEL_QQ_ADMIN_PASSWORD` / `_HASH` | 管理后台口令（哈希优先） |
| `CHANNEL_QQ_ADMIN_ALLOW_REMOTE` | 允许后台监听非本机地址（默认关） |
| `CHANNEL_QQ_NAPCAT_ROOTS` | 允许 NapCat 直接读取的宿主目录（冒号分隔） |
| `CHANNEL_QQ_EXTRACTOR_BASE_URL` / `_MODEL` / `_API_KEY` | 知识抽取的模型端点。后台「记忆」页可覆盖这三项（填了就不看环境变量） |
| `CHANNEL_QQ_APPROVAL` | 审批网关开关（`1` = 启用） |
| `CHANNEL_QQ_APPROVAL_DIR` | 审批目录（默认 `/var/lib/dsh-approval`） |
| `CHANNEL_QQ_PERSONA_DIR` | 人格包目录（默认 `assets/persona/default`） |
| `KUGOU_API_BASE` | 酷狗自建 API 的地址（默认 `http://127.0.0.1:4000`）。后台「音乐」页的
  `music.kugouApiBase` 填了就以配置为准；两项都空则用默认值 |

## 最小可用配置

```yaml
- id: channel-qq
  config:
    connection:
      mode: forward
      url: ws://127.0.0.1:3001
    accessToken: <OneBot access token>
    selfId: <机器人 QQ 号>
    admins: [<管理员 QQ 号>]
    primaryGroup: <主群号>
    workspacePath: /path/to/workspace
```

其余项都有可用默认值。完整字段见后台「配置」各页，或 `cordis.patch.yml` 的注释。

## 技能

技能是**磁盘上的目录包**，不是配置数组；后台「技能」页负责增删改与导入。

```
<dshHome>/channel-qq/skills/       ← 默认仓库（skills.dir 可改）
  <name>/SKILL.md                   ← 目录包（推荐；可带 scripts/ references/ assets/）
  <name>.md                         ← 扁平技能
  .staging/<name>/                  ← 导入待审区（不会被启用，确认后才转正）
```

**不要把仓库指到工作区里**：工作区是 `workspace-write`，模型手里的 `write`
能改那里，而技能正文是会进系统提示的指令——等于给注入留一条持久化后门。

`SKILL.md` 用 [Agent Skills](https://agentskills.io/specification) 格式：`---`
包住的 frontmatter（必填 `name`、`description`；可选 `whenToUse`）+ Markdown 正文。
本插件额外识别 `metadata` 下这几个键：

| 键 | 取值 | 含义 |
|---|---|---|
| `channel-qq.visibility` | `all` / `none` / `dm` / `groups` / `rooms` | 可见范围；默认 `all` |
| `channel-qq.rooms` | `group-123,dm-456` | `groups` / `rooms` 模式下的房间清单 |
| `channel-qq.admins-only` | `true` / `false` | 只有管理员发起的回合能加载/触发 |
| `channel-qq.enabled` | `true` / `false` | 停用（不出现在目录里，也不能触发） |
| `channel-qq.scripts` | `true` / `false` | 这个技能带可执行脚本（还要全局 `skills.allowScripts`） |
| `channel-qq.source` | 任意字符串 | 导入来源（审计用） |

**可见范围在每次加载/触发时现算**，不缓存：改后台、改 frontmatter、改组，下一
回合立即生效。三条入口都走同一个判据（`core/skills/model.ts` 的
`skillVisibleTo`）：

| 入口 | 行为 |
|---|---|
| 模型目录（宿主 `skill` 工具） | **只收 `visibility: all` 且非管理员专属**的技能，避免受限技能的描述出现在每个房间 |
| `qq_skill` 工具（list / load） | 按当前会话的房间与发起人身份过滤 |
| 用户消息第一行 `/名字` | 同上过滤；命中后把正文注入这一回合 |

系统回合（巡逻、早报）没有"谁在看"的概念，只看得见 `all`。

后台列表会显示每个技能被加载 / 被触发过几次，计数写在
`<dshHome>/channel-qq/skills-stats.json`（不写回 `SKILL.md`，否则每用一次都会
改正文、让目录签名抖动）。

导入支持三种：粘贴全文、单文件 URL（GitHub blob 链接自动换成 raw）、GitHub
目录（`…/tree/<ref>/<path>`，递归下载，最多 200 个文件）。三种都先落 `.staging`。

## 会话换血（自动）

宿主的上下文压缩是**第一道防线**，但它有一个死结：历史一旦**已经超过**模型窗口，
压缩自己的摘要请求也会超窗（2026-10-20 的 400 就是这个）。换血是第二道防线：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `sessionReset.enabled` | `true` | 关掉后只能手动跑 `deploy/session-reset.mjs` |
| `sessionReset.thresholdRatio` | `0.85` | `tokens ≥ 窗口 × ratio` 时换血；刻意排在压缩（约 0.8）之后 |
| `sessionReset.checkIntervalMin` | `5` | 每轮检查活跃会话；只在回合空闲时动手 |
| `sessionReset.maxAgeDays` | `7` | 距上次换血超过 N 天强制换一次（`0` = 关闭） |
| `sessionReset.maxTurnMinutes` | `10` | 单回合跑这么久还没结束就强制换血（`0` = 关闭），兜住"等待审批"这类永久挂起 |
| `sessionReset.strictRooms` | 空 | 图片/工具特别多的房间（逗号分隔），用更低的阈值 |
| `sessionReset.strictThresholdRatio` | `0.6` | 上面这些房间使用的比例 |
| `sessionReset.seed` | 空 | 换血后注入下一轮的一句话（空 = 内置文案，会提示先补记 MEMORY.md） |

换血做的事：释放会话 → 历史移到 `<dshHome>/channel-qq/backups/session-auto-<时间>-<会话>/`
→ 写 `session-seed-<会话>.json` → 下一条消息自动开新会话并注入种子。**长期记忆、
人格、知识库都不动**。

前提：模型必须**声明 `contextWindow`**（供应商页可填）。窗口未知时不换血——
宁可不换，也不要在错误的尺寸上误杀历史。

阈值顺序建议：宿主压缩约 `0.8 × 窗口`，换血 `0.85`；两者都失败时还有模型本身的
剩余窗口兜底。窗口越大（例如 1M），换血越少；128k 的模型会更频繁。

**连续 400 也会触发换血**：网关把上游的上下文错误包成 `bad_response_status_code`，
宿主的溢出恢复认不出来。看门狗订阅 `agent/error`：同一房间 10 分钟内出现 2 次同类
错误（`bad_response_status_code` / `context_length_exceeded` 等）就主动换血，
30 分钟内不重复触发。这条比「等 5 分钟一次的体积检查」更快。

**回合卡死**：无人值守部署里，宿主的「升级沙箱」审批没有真人应答会**永久挂住回合**，
该房间之后的所有消息都进不来（2026-10-21 群会话卡死 5 小时）。

正确修法是**改 permission 预设**，不是改 approval 的全局 `policy`：
`permission-presets` 会用「沙箱默认 + 审批默认」反查预设，全局 policy 改成 never
会匹配不到任何预设，整个 `permission` 服务起不来、channel-qq 永远 pending。
线上配置：

```yaml
- id: permission
  config:
    defaultPreset: workspace-write
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: never }
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

再用 `maxTurnMinutes` 兜底：超时仍未结束的回合强制换血。

**手动换血**：管理员在私聊里发 `/换血`（或 `重置会话` / `/reset`）——
**确定性处理、不经模型**（模型能看到群友的文字，不能把"清空历史"交给它决定）。
历史移到备份目录，下一句开始是新会话。

**运行环境事实（防历史污染）**：每个包开头都会带一行
「模型 / 图片能力 / 上下文窗口」，并明确「历史里相反的说法作废」。模型很容易把
自己的旧结论当事实（2026-10-20 的「看不到图」就自我强化了半天），这条每回合刷新，
比事后解释便宜。事实取自当前路由的 `resolveModelInfo`，一分钟刷新一次。

**体积曲线**：每轮检查把 `{at, room, tokens, window, provider, model}` 追加到
`<dshHome>/channel-qq/session-size.jsonl`（超过 5MB 轮转）。后台「指标」页读
`session-size` 资源画 sparkline，一眼能看到增长斜率与当前占比。

