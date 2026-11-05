## [Unreleased]

### 新增

- **SnowLuma 能力面接入（审计 20261025_snowluma-capability-audit.md 落地）**：
  - **合并转发/卡片看得见了**：`forward` 段经 `get_forward_msg` 展开成文本注入
    （每容器 ≤20 条），`json`/`ark` 卡片提取标题摘要；纯转发消息不再整条丢失
  - **好友申请/群邀请收得到了**（`access.friendRequests`，默认关，**线上已开**）：
    request 事件存凭据 + 陌生人资料（昵称/等级/签名）私聊通知主人；
    批准走管理员私聊指令「同意好友 <QQ>」，不经模型
  - **新工具 7 个**：`qq_set_status`（在线状态，标准档+自定义文案）、`qq_react`
    （群消息表情回应）、`qq_custom_face`（自定义表情列表/发送——stolen 表情
    可直接发）、`qq_group_pulse`（群荣誉+@全体剩余）、`qq_check_url`（链接安检）、
    `qq_friend_requests`、`qq_unidirectional_friends`（单向好友检测）
  - **出站 URL 安检**：工具闸门挂 `check_url_safely` 渐进式缓存（发送后预热、
    危险链接第二次起拦截；同步钩子拿不到网络结果的局限写在代码注释里）
  - **文件下载修复**：群/私文件改走 `get_group_file_url`/`get_private_file_url`
    （SnowLuma 新版 `get_file` 只认图片/语音缓存，此前 10 次下载全挂）

- **记忆系统 P0–P3 升级（调研 20261024_memory-system-research.md 落地）**：
  - **P0 写入侧事实抽取**：抽取 prompt 改为"一句话事实"（≤60 字、去口语壳）；
    夜间抽取产物入库前经 `distillFact` 蒸馏（≤80 字）；新增**回合结束即时抽取**
    （默认关，`memory.captureEnabled`）：规则判据（被纠正/要求记住/自述/情绪上头）
    触发带外沉淀，每日上限 `memory.captureDailyCap`（默认 12）、单房间 90 秒冷却
  - **P1 巩固闭环**：新夜间 job `memory.consolidate`（04:55）——同一件事的两种说法
    自动合并（重叠 ≥ 0.75，supersede 可回查）；命中强化（召回一次 confidence +0.05）；
    矛盾对**冻结进队列**（`knowledge/conflicts.jsonl`）等主人裁决；全部决策留凭证
    （`knowledge/consolidation-log.jsonl`，append-only）
  - **P2 三层注入**：常驻层（`core` 标记 + importance≥8 + confidence≥0.8 才进，
    最多 2 条）+ 话题触发层（原管线）+ 走神层（`memory.wanderPercent` 默认 8%，
    从"被记得够深 + 七天没想起"里随机带一条回来）；实体词典一跳扩展；
    `qq_memory_search` 新增 `asOf` 时间旅行参数
  - **P3 陪伴维度**：`qq_person_note` 支持记录印象的**具体瞬间**（`moment`）；
    生日/纪念日（tags 含 `birthday`/`anniversary`）到期自动注入提示
    （`memory.occasionsEnabled`）；高好感（affection ≥ 80）用户的重要偏好
    可进常驻层
- **原话簿（默认关）**：`chatlog` —— 按群按日保存原始消息流水到 `<工作区>/chatlog`，
  `chatlog.keepDays` 默认 14 天清理；`qq_group_digest` 按日期翻群聊记录
- **人物档（默认关）**：`people` —— `qq_person_note` 手动记「谁爱用什么说法、忌讳什么」，
  按群分开存、与自动侧写互补
- **渠道健康告警（默认关）**：`channelHealth` —— 消息链路失联超过阈值私聊管理员，
  恢复后再报；探针每次真发 `get_status`，不被 WS readyState 骗
- **供应商页**：保存时 `models` 数组完整透传（原来只留第一个模型）；从网关拉取改为
  先显示「获取成功 N 个」再勾选要添加的模型；新增模型不再被静默丢弃
- **失败告知限频**：主动/定时回合失败不再发「刚才那条没处理完」；用户回合同一房间
  10 分钟最多一条
- **记忆库独立入口**：`src/standalone-memory.ts`，脱离 cordis 直接使用记忆核心
  （见 [docs/memory-standalone.md](docs/memory-standalone.md)）
- **记忆卫生**：库文件被外部改写后按 mtime 惰性重载；超长内容先归一化再判重
- **访问门控（默认开）**：`access.mode` = `pairing`（默认）/ `allowlist` / `open`；
  `access.groupPolicy` = `member`（在群里就允许，推荐）/ `pairing`（逐群审批，默认）/ `allowlist`；
  未批准的群默认只通知主人、不在群里回「待批准」；只有 @/关键词才生成请求。
  陌生私聊与未批准的群只回「待主人批准」，不进 agent；主人后台「安全」页批准后放行，
  管理员始终允许。修掉「任何私聊都能触发 agent」的暴露面（awesome-dsh-plugin 审核意见）
- **交互提示（A1，默认关）**：`chat.interaction` —— 私聊回合设置「正在输入」、
  群聊给触发消息贴表情回应，回合结束撤销（私聊不支持表情回应，已在实测后限定群聊）
- **合并转发（A3，默认关）**：`chat.forward.longReplyThreshold` —— 分段条数达到阈值
  时改发一张聊天记录卡片；超限/失败回退逐条，内容不丢
- **指标（C1/C2，默认关）**：`metrics.enabled` —— 每回合耗时、token 四桶、
  发送/工具失败；后台「指标」页看近 7 天 p50/p90、按房间与按天
- **回合告知（A2，默认关）**：`reliability` —— 慢回合说一句「还在处理」，
  永久失败说一句「没处理完」（重试中不说）
- **服务端历史（A4，默认关）**：`history.serverBackfill` —— 本地会话日志没有命中时
  回源 `get_group_msg_history`，按房间去重落盘并供检索
- **群日报（B1，默认关）**：`dailyReport` —— 每天定时发当天条数/活跃人/金句，
  空数据不发
- **人物侧写（B2，默认关）**：`memory.profiles` —— 每回合在证据前加当前发言人的
  3–5 行侧写（5 分钟缓存）
- **黑话词典（B4，默认关）**：`learn.slang` —— `qq_learn_word` / `qq_slang`
- **兜底链（B5，默认关）**：`stt.serverFallback` 走协议端语音转文字；
  `imageRecognition.serverOcr` 注册 `qq_read_image_text`
- **知识库增强（B6，默认关）**：`kb.rerankWeight` 二阶重排、`kb.ingestUrls`
  网页抓取入库（SSRF 守卫）
- **知识库（P0–P2）**：工作区 `inbox/`、`downloads/`、`kb/raw/` 的文档被增量摄取
  （sha256 判变、串行队列、单文件失败不影响整轮）；原生解析 md/txt/html，
  PDF/Office/图片走可选的 Docling sidecar（`kb.doclingUrl`，没配时图片直接跳过）
- **标题感知分块**：按 Markdown 标题分段，块带标题路径、行号与页码；超长段按上限
  拆分并保留重叠，单行超长时按字符硬切。旧块归档（软删除）而不是直接删
- **`qq_kb_search` 工具**：只读检索用户资料，返回带
  `[知识库·标题·标题路径·第 N 段]` 出处的原文；不传 query 时列出当前房间可见的目录
- **混合检索**：中文二元组 + IDF（标题命中加权）+ 向量余弦（复用记忆的 embed 服务
  与 `vec.bin` 格式），`kb.vectorWeight` 调权重
- **集合可见范围**：`kb.scopes` JSON 把集合绑定到房间；别的房间连候选都进不来
- **每回合知识库证据**：`kb.injectTop` / `kb.injectChars`；与记忆证据分两段，
  都没命中时组包与从前逐字节一致
- **后台「知识库」页**：文档清单（状态/块数/大小/失败原因）、扫描进度、块预览、
  移除/恢复、重建向量、集合可见范围一览；设置表单直接改 `kb` 段
- **记忆候选 → 技能草稿**：后台「记忆审核」页对候选点「写成技能」，写入技能待审区
  （带来源 metadata），确认后才启用
- **KB 评测**：`npm run eval:kb`（合成 16 题，hit@1 / hit@5 / MRR / p95；`--enforce`
  当回归门槛）。文档见 [docs/knowledge-base.md](docs/knowledge-base.md)
- **落雪（LX Music）音源**：`music.lxSources`（JSON 数组）配置远程音源脚本，点歌时
  先进音源解析播放直链，再退回网易云。脚本跑在受限 `vm` 上下文里（无 `process`/
  `require`/`fetch`，只有走 HTTP 闸门的 `lx.request`，禁 eval、带执行超时）；
  默认空 = 不启用
- **点歌默认发语音条，文件由开关控制**：`qq_send_music_card` 不再发官方音乐卡片
  ——SnowLuma 的签名服务已下线，回退卡片在现行 QQ 上只显示「发送者版本过低，
  无法展示内容」（SnowLuma #365）。现在解析 → 下载 → **默认发语音条**；
  后台「点歌发文件」（`music.sendFile`，默认关）打开后改发音频文件
  （文件名带歌名/歌手）。`qq_send_music_voice` 始终发语音条

- **技能系统（P0–P2）**：磁盘上的 Agent Skills 目录包（`<dshHome>/channel-qq/skills`），
  接进宿主的 `skill` 目录与 `/名字` 触发；新增 `qq_skill` 工具按房间列出/加载
- 技能可见范围：`all` / `dm` / `groups` / `rooms` / `none`，可叠加「仅管理员」与停用；
  **每次加载/触发现算**，改完下一回合生效。宿主目录只收全局可见的技能，受限技能
  走 `qq_skill`，避免描述泄露到每个房间
- 后台「技能」页：列表（含待审与坏文件原因）、新建/编辑、启停、删除、URL/粘贴导入；
  导入一律先进 `.staging` 待审区，确认后才转正
- 技能脚本：`skills.allowScripts`（全局）+ `channel-qq.scripts`（单个技能）双开关
- 技能使用计数：加载 / `/名字` 触发分别记，后台列表直接看；计数在
  `<dshHome>/channel-qq/skills-stats.json`，不写回 SKILL.md
- 导入支持 GitHub 目录链接（`…/tree/<ref>/<path>`，递归下载，上限 200 个文件）
- **本机 embed 服务可离线安装**：`install.sh` 从 ModelScope 的 Qdrant ONNX 包预置模型，
  新增 `--model-path` / `DSH_EMBED_MODEL_PATH`（HF 不可达时不再卡在下载）
- **发送侧健康探测**：后台只读路由 `/api/healthz`（仅 loopback），内部一次
  `get_status` 往返、不产生消息；返回 socket 状态、online/good、延迟与最近收帧时间

- **自动换血（会话体积看门狗）**：按模型声明的上下文窗口，`tokens ≥ 窗口 × 0.85`
  时自动备份历史、释放会话、写续接种子；排在宿主压缩之后兜底
- **连续 400 主动换血**：订阅 `agent/error`，10 分钟内同类上下文错误 2 次即换血
  （30 分钟冷却），比体积看门狗更快
- **会话体积曲线**：看门狗每轮写 `session-size.jsonl`，后台「指标」页画 sparkline
- **供应商保存自动补上下文长度**：没填时按内置目录（models.dev）补
：从网关 `/v1/models` 拉模型列表、每个模型可填上下文长度/最大输出、
  内置 models.dev 模型目录（`assets/model-context.json`，`node scripts/update-model-catalog.mjs` 更新）
- **默认供应商切到本机 8317（workbuddy）**，模型 `deepseek-v4.1-flash-1017`（窗口 1M）

- **每包注入运行环境事实**：模型/图片能力/上下文窗口 + 「历史里相反的说法作废」，
  防止模型把旧环境结论（例如「看不到图」）当事实自我强化
- **无人值守防挂起**：安装 `bubblewrap` 修好 bash 沙箱后端；persona 增加
  「不要请求 sandbox_permissions / 用 write 工具写文件」的规则
- **回合卡死看门狗**：`maxTurnMinutes`（默认 10）——回合超过该时长仍未结束就强制换血。
  无人值守时宿主的沙箱升级审批没人应答，会永久挂住该房间（2026-10-21 群会话卡死 5 小时）。
  修法是把 `permission` 预设的 `workspace-write.approval` 设为 `never`——**不要**改
  approval 的全局 policy，否则 permission-presets 匹配不到预设、channel-qq 无法启动
- **定期换血**：`maxAgeDays`（默认 7 天，0 关闭），按 `session-reset-state.json`
  里每房间的上次换血时间判断
- **激进房间**：`strictRooms` + `strictThresholdRatio`（默认 0.6），图片/工具多的
  房间更早换血
- **换血种子提示补记**：默认种子要求先检查重要结论是否落到 `MEMORY.md`/`memory/`
- **管理员 `/换血` 指令**：私聊发送即换血（确定性处理、不经模型），历史先备份

### 修复

- **表情包打标看不到图**：视觉消息用了 OpenAI 的 `image_url` 形状，而宿主
  `llm.stream` 只认 `{type:'image', attachment}`（附件先经 `attachments.saveImage`
  落盘）。模型收到的消息里没有图，回一句「未收到图片」，于是整库 67 张的标签
  退化成「疑问/无语/尴尬」，`qq_send_sticker` 按情绪搜不到任何合适的。现在改走
  附件，并按**文件头**判断媒体类型（`.png` 里装 GIF/WebP 的情况很常见，声明错
  会被宿主拒绝）；推理模型不输出 JSON 时从散文里抠描述（两轮尝试），占位标签
  （`情绪1`）在读取时清掉
- **后台「全部重新打标」**：表情页新增按钮，对全库逐张重跑视觉打标（后台执行、
  进度写日志），用来修复历史脏标签；「扫描新图」不再谎称会刷新标签
- **表情包发送失败**：`CHANNEL_QQ_NAPCAT_ROOTS` 里声明了 `~/.dsh/...`，但
  容器用户读不到 `/root`（700），路径直传 `EACCES`。现在 **≤256KB 的文件一律
  base64 内联**（表情包/短语音都走这条），不再依赖"配置说能读"；顺带修了
  Windows 盘符被冒号分隔符拆开的解析 bug

- **向量索引批量重建被回合超时误伤**：`memory.vectorTimeoutMs` 的 800ms 是"别拖住
  一回合"的上限，却也被夜间重建与知识库首次索引复用——每批 16 条长文本经常超过
  1s，于是每批都判超时、一条也写不进去（线上 97 条记忆块长期补不上、KB 向量为空）。
  重建改用独立的宽超时适配器（15s），查询路径仍是 800ms
- **知识库向量重建把"全部失败"当成"没有变化"**：一条都没嵌成功时提前返回、既不
  写文件也不记日志，看起来像向量检索没开。现在只在**确实没有缺失块**时提前返回，
  失败会如实报告并留下"下次重试"的状态

- **多模态模型被声明成纯文本**：`workbuddy/deepseek-v4.1-flash-1017` 的
  `input` 只写了 `text`，入站图片在预检里被替换成「图片」占位。已补 `image`；
  供应商页的模型行新增「图」勾选，保存时还会按 models.dev 的能力表自动补
- 日志页在 360/414px 下横向溢出：错误聚合标题行不换行、聚合行的长片段没有
  `min-width:0` / `overflow-wrap`。两处 CSS 已修，线上只读巡检 0px 溢出。

- 技能仓库默认放在 `dshHome` 而不是工作区：工作区对模型可写，而技能正文会进系统
  提示——放在那里等于给注入留一条持久化后门
- `qq_memory_search`：深召回工具——在工作区 md 的 600 字原文块里搜，一次 3–8 条，
  带文件与行号出处、跨房间（`memory.v2` 关着时返回「未启用」而不是报错）
- 夜间 `memory.chunks`（03:50）：工作区 `memory/`、`knowledge/`、`learning/` 的 md
  切块入索引，幂等、旧块归档不删
- 后台「记忆」页的**索引状态卡**：结构记录 / 原文块 / 向量各多少条、多少条参与检索
- 知识抽取器（地址 / 模型 / API Key）可在后台配置，留空回退环境变量
- 手写 JSON 的配置项（事件书等）多了「格式化」按钮
- 后台「音乐」页：曲库账号（网易云 / 酷狗）扫码登录、登录态、清除登录、搜索自检；
  二维码在浏览器本地生成，登录 key 不出本机。酷狗 API 地址进配置（`music.kugouApiBase`）

### 变更

- **默认协议端从 NapCat 换成 SnowLuma**（Docker 镜像内置 Linux QQ + Xvfb + noVNC）：
  固定 `NapCat v4.15.0 + QQ 3.2.21` 后仍被腾讯按客户端指纹静默风控（`1006514 网络连接异常`，
  能收不能发）。模板见 `deploy/snowluma/compose.yaml`；NapCat 保留为回滚方案。

### 修复（2026-10-19 第二轮排查，按模块）

**配置 / 数据安全**
- **主群号存成字符串导致一串比较恒假**：schema 把 `primaryGroup` 声明成字符串，而消费方全是
  `chatId === primaryGroup` 的严格比较 ⇒ 偷表情包、主群专用回复、按群覆盖全部静默失效。
  改为 `number`，并在 `resolveConfig` 里按 schema 做**无损类型归一**（数字串→数字、
  `"true"/"false"`→布尔、数字数组逐项归一）。
- 好感度 `book(NaN)` 会把分数写成 NaN → JSON 变 `null` → 重启后**整份状态（分数+全部事件史）被丢弃**：入口直接拒绝非有限数。
- 歌单读失败被当成空歌单、紧接着写回 `[]`（主动破坏数据）：读失败直接报错中止，`list` 不再重写文件。
- 口癖库读盘失败后仍会写盘（把文件抹成空数组）：读失败后本次运行拒绝写盘；`groupId: null` 不再被洗成 `0`。
- 语录写入失败被吞、工具仍回 `ok:true`：工具路径改为失败即抛错（自动收录仍尽力而为）。

**隐私 / 安全**
- 私聊生图省略 `target` 时会发进主群：只有 `isGroup=true` 才回落到主群，否则报错要求补 target。
- 审批分级可被 `
m`、`rm --recursive --force` 绕过（判成 L0 直接执行）：归一化补上长选项与命令前转义。
- 审批并发批准两次会产生幽灵令牌：读改写加文件锁；回执改为**发送成功才删**（失败保留重试）；
  回执发给全部管理员（旧实现只发 `admins[0]`）；管理员名单改为**实时读取**（撤权立即生效）；
  群里发「待批/批准」不再回复（旧行为等于告诉任何群友这里有审批后门）；补申请/批准/拒绝的审计日志。
- `applyPatch` 跳过 `__proto__`/`constructor`/`prototype`（原型污染，HTTP 面有校验，公共函数仍需自保）。

**功能全废 / 静默失效**
- `qq_search_history` 的正则锚在整段开头，而真实入站包是多行的 ⇒ **永远返回空**。改为逐行找聊天行，并剥离昵称前的不可见控制符。
- 旧名改写会二次替换自己产生的文本（`qq_remind_at` → `（action=add）（action=add_at）`）：改为一次扫描 + 查表。
- RSS 水位线假设 feed 一定新→旧：升序 feed 会永久丢新条目、反复重推历史。按发布日期判方向。
- 后台「重建会话」把 UUID 会话（Web/自动化）当 QQ 房间列出 ⇒ 41/45 条无效：只列 `qq-*`；重建返回真实文件数（旧字段是 0/1 标志）。
- 风控回执把"加权条数"说成"条数"（复读按双倍计），照着调阈值只会越调越偏：回执同时给原始条数与加权数。
- 表情包「随机兜底」只在最新 200 张里挑：新增全库随机。

**静默失败 / 资源**
- 音乐发送绕过限流队列（且卡片发送没 await）：统一走 `out.push`；临时音频在 `finally` 里清理（发送失败也不留垃圾）。
- 音乐两个实现（面板/工具）在没配工作区时写到不同目录：统一兜底目录。
- TTS 超过 800 字只写日志、不回告模型：结果里带 `truncatedFrom`，工具返回 `note`。
- 提醒：一次性提醒触发后永不清理（文件无界增长）→ 保留 7 天后清理；`tick` 加互斥（send 超过 30s 会重复推送）。
- 配置保存先改内存后写盘（写盘失败时进程/磁盘/热重载三方差且无日志）：改为**先落盘、成功后才改内存**，失败回滚并记日志。
- 工具区同步 / 切换日说明：投递有失败时不再记账（失败者永久收不到），最多重试 3 次。

**已核实但未改**（报告标注弱/复现不了）：表情包多行绘制实测正常（3 行都画出）；
`tierOfSession` 只管 `qq-` 会话是设计边界；`learn/quotes/reminders` 的 live 字段读的是同一个
配置对象引用，不需要 `watches`；RSS `add/remove` 的持久化需要把配置存储接进工具层，留待下一轮。
### 修复

- **记忆证据从未注入**（三处叠加，2026-10-19 线上实测发现）：
  ① `inbound` 在装载表里早于 `memory`，注入面在 apply 时取到 `undefined` 就此定死 →
  改为每次组包现查；② 私聊路径直接提交 `composeDm` 的渲染结果，真正装证据的
  `compose()` 从没跑过、算好的召回被整个丢掉 → 召回改由组包器自己算；
  ③ `qq-tools` 没监听 `tools.v2` / `memory.v2`，后台标着「自动重载」却要重启
- **原文块会吃满注入预算**：一块约 400 字，挤进 600 字预算后整回合只剩一条证据
  （实测 recall 反而归零）→ 检索器加 `accept` 过滤、服务层排除 `isChunkRecord`，
  原文块只对深召回工具可见
- embed 服务默认地址从 `17861` 改为 `8801`（与 `install.sh`、systemd 单元一致）
- **网易云搜索从未搜到过歌**：`/api/search/get/web` 现在返回加密串，解析出来恒为空 →
  改用 `/api/cloudsearch/pc`，并兼容两套字段名（`ar`/`dt` 与 `artists`/`duration`）
- **酷狗自建 API 一直被 HTTP 闸门拦下**（本机地址被判为内网/保留地址）→ 显式放行；
  连不上时给出"先起 KuGouMusicApi"的说明，而不是 `fetch failed`
- 人格页异步加载回来得比导航晚时抛 `Cannot set properties of undefined` → 加渲染代数
  守卫，`setNote` 对已卸载节点静默返回

### 文档

- `docs/memory.md`：注入与深召回的分工表、首次建索引的一次性引导、状态改为"默认关、线上已开"
- `docs/deployment.md` §13 重写：改用仓库自带的 `deploy/embed-server/install.sh`，
  补 `MemoryMax=1500M` 与两个实测坑、一次性引导、会话原件验收命令
- 发布与配置：写明 `prune` 是手动的、`rollback` 只回代码（配置/记忆/会话另有备份）

### 计划中

- 记忆检索接入向量服务后复测 60 题基准（当前 recall@8 = 0.14，门槛 0.85）
- 群聊准入的模型判定（等真实流量后再定）

## [0.1.0] - 2026-10-18

首个公开版本。

### 新增

- OneBot v11 / NapCat 接入：群聊、私聊、图片、语音、文件、引用回复、戳一戳
- 工具面：83 个细粒度工具；`tools.v2` 合并为 17 个动作组
- 群聊准入（`planner`）：被叫必回、其余看情况、别的 bot 与纯表情挡下
- 长期记忆：日记 → 结构化记录 → 检索；夜间巩固、遗忘曲线、DIGEST
- 主动行为（`proactive.v2`）：事件书驱动巡逻、早报、主动私聊
- 管理后台：26 个页面，配置热生效、审计、会话重建、模型供应商管理
- 模型供应商：三种协议 + 自定义请求头 + 五档连通性实测
- 审批网关：L0–L3 分级、一次性令牌、IM 远程批准（`待批 / 申请 / 批准 / 拒绝`）

### 工程

- 门禁：类型检查、481 项测试、分层规则、体积棘轮、golden 快照
- 发布：`deploy/release.mjs`（验签 + 原子切换 + 一条命令回滚）
