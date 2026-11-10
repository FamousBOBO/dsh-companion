/** 点歌（B站搜歌 → RVC 音色翻唱 → QQ 副歌语音条）的**共享词汇**。
 *
 * 为什么单独一个 types 文件：这条链路有五个责任方，各自只该看见形状：
 *   - `adapters/song/bili.ts`（外部 B站：搜索、视频信息、按 BV+分P 下载音轨）；
 *   - `adapters/song/chorus.ts`（副歌定位：调 `tools/song/find_chorus.py`，只认它的 JSON）；
 *   - `adapters/song/cover.ts`（翻唱：切试听段 → make_cover.py → 按副歌起点裁语音条）；
 *   - `adapters/song/cache.ts`（同歌缓存：两层键值、`ffprobe` 时长核对、按最久没用淘汰）；
 *   - `features/song/queue.ts`（串行队列：阶段、去重、超时、清理、发送回执）；
 *   - `features/song/tools.ts`（模型面：一次点歌 / 查状态）。
 *
 * 三条贯穿全文件的约定：
 *   1. **时间一律秒**（音频用秒；队列记账用 Unix 毫秒，字段名带 `At`/`Ms`）。
 *   2. **阶段是账本不是日志**：每个任务只有一条终态（`sent` / `failed`）；
 *      发送回执未知（超时）是**独立终态 `unknown-send`**，它禁止自动重发。
 *   3. **失败要说清卡在哪一步**：`stage` 是枚举，`detail` 是给人看的短句；
 *      日志里两者都记，模型面只看到短句。
 */

/** 任务阶段。顺序即流水线顺序；`failed` / `unknown-send` 是终态。
 *
 * **没有 `searching` 这一步**：选哪条视频是同步的、要立刻回答用户的事（要么"开始做"、
 * 要么"这几首同名，你要哪个"），它不属于后台任务。下载包含"取音轨 + 转成可解码音频"，
 * 所以也没有单独的"抽音频"阶段——那是适配器内部的事，不是账本该记的粒度。
 */
export type SongStage =
  | 'queued'
  | 'downloading'
  | 'chorus'
  | 'covering'
  | 'sending'
  | 'sent'
  /** 音已做好但**没有发**（演练模式 / 外发被闸门拦住）：不是失败，也不许重发。 */
  | 'dry-run'
  | 'failed'
  /** 发送已发出但没拿到回执：**不许自动重发**（那是重复语音条的来源）。 */
  | 'unknown-send'
  | 'cancelled'

/**
 * 入口：私聊点歌 / 群聊点歌（都是模型调用）或主动联系自主选歌。
 *
 * `dm` 与 `group` 只差"语音条发到哪个房间"，**判据完全同义**：都是对用户刚说出口的
 * 请求的回应。所以发送闸门把两者当同一档（见 `index.ts::buildGate`），而"每人每天几首"
 * 的额度只认 `requesterId`，不看房间。
 */
export type SongEntry = 'dm' | 'group' | 'auto'

/** 从哪里开始唱：`chorus` = 只唱副歌（默认）；`start` = 从头开始放（跳过副歌搜索）。 */
export type SongStartMode = 'chorus' | 'start'

/** 一次点歌请求（进队列时的快照）。 */
export interface SongRequest {
  /** 稳定任务 id：`s-<毫秒>-<随机>`；目录名、日志、回执都用它。 */
  readonly id: string
  readonly entry: SongEntry
  /**
   * 点歌人 QQ 号（群聊必填；私聊缺省时取房间键里那个号；`auto` 入口为 `null`）。
   *
   * 它的**可信度有限**：群聊里这个号是模型从渲染文本的行标 `(QQ号)` 读出来的，
   * 不是宿主侧强事实（同一条消息里引用别人的话就能把它写错）。因此它只用于"每人每天
   * 几首"这种**成本**判定，绝不参与授权/身份判定——身份只认 `core/trust.ts`。
   */
  readonly requesterId: number | null
  /** 房间键：`dm-<QQ号>` 或 `group-<群号>`（与 contact / sent-log 同一套拼法）。 */
  readonly room: string
  /** 接收方号码：私聊是 QQ 号，群聊是群号（由 `splitRoom(room)` 得出）。 */
  readonly chatId: number
  /** 去重键：私聊入口用入站 `message_id`，自主入口用 `auto:<日期>:<房间>`。 */
  readonly dedupeKey: string
  readonly song: string
  readonly artist: string
  /** 用户指定的 BV 号（选了候选或指了视频时）。 */
  readonly bvid: string | null
  /** 用户给出的副歌时间（秒）；给了就跳过定位。 */
  readonly chorusAt: number | null
  /**
   * 从哪开始：见 `SongStartMode`；`chorusAt` 有值时一律是 `chorus`（工具面已收敛）。
   *
   * 与 `keyUp` 同理在**入队时就定死**：中途改会让一次任务的两个阶段说不清自己在做什么。
   */
  readonly startMode: SongStartMode
  /**
   * 换声时人声升几个半音（0 = 原调）。
   *
   * 只对**男声源**生效（默认 12 = 一个八度）：音色模型是女声，男声原曲直接用会偏低。
   * 升八度是同音级移调，伴奏的和声关系不变，所以听感上"还是那首歌"。
   * 这个值在**入队时就定死**了：队列里再改会让"同一首歌两次点歌升不同的调"没法解释。
   */
  readonly keyUp: number
  readonly requestedAt: number
}

/** B站搜索结果里的一行（适配器归一化后的形状，不是上游字段名）。 */
export interface SongCandidate {
  readonly bvid: string
  readonly title: string
  readonly author: string
  /** 时长（秒）；上游给 `4:30` 这类文本时由适配器换算。 */
  readonly duration: number
  readonly play: number
  readonly description: string
}

/** 视频的一个分 P。 */
export interface BiliPage {
  readonly cid: number
  readonly part: string
  /** 秒。 */
  readonly duration: number
}

export interface BiliVideoInfo {
  readonly bvid: string
  readonly title: string
  readonly author: string
  /** 整条视频时长（秒）。 */
  readonly duration: number
  readonly pages: readonly BiliPage[]
}

/** 副歌定位结果。`confidence` 由 `find_chorus.py` 算，`start` 是最终选定的起点。 */
export interface ChorusPick {
  /** 副歌起点（秒，相对整条音轨）。 */
  readonly startSeconds: number
  /** 副歌结束（秒）；即"起点往后一整段"，用于判断"这段有多长"。 */
  readonly endSeconds: number
  /** 0..1；低于调用方阈值时调用方必须走"不可靠"分支。 */
  readonly confidence: number
  /** 判定方法名（日志与诊断用）。 */
  readonly method: string
  /** 这段旋律在整曲里重复了几次。 */
  readonly repeats: number
  /** 人声活跃比例（0..1），定位的第二个判据。 */
  readonly vocalRatio: number
  /**
   * 副歌起点之后**每一句唱完**的位置（换气/句间停顿；秒，相对整条音轨，升序）。
   *
   * 语音条据此收在一句歌词的结束处而不是硬切在整秒上（见 `features/song/phrase.ts`）。
   * 脚本给不出可信的句尾时是空数组，那是"这段太平"，不是出错——调用方退回按上限硬切。
   */
  readonly phraseEnds: readonly number[]
}

/** 翻唱产物。 */
export interface CoverResult {
  /** 最终语音条文件（mp3，44.1 kHz）。 */
  readonly voiceFile: string
  /** 语音条时长（秒）。 */
  readonly durationSeconds: number
  /** 实际使用的副歌起点（秒，相对整条音轨）。 */
  readonly chorusStart: number
  /** 本次用的语音条长度（网关拒绝默认长度时会缩短）。 */
  readonly seconds: number
  /** 本次人声升了几个半音（0 = 原调；男声源默认 12）。 */
  readonly keyUp: number
  /** `make_cover.py` 的 summary（诊断用；不含凭据）。 */
  readonly summary: Readonly<Record<string, unknown>>
}

/** 子进程一次运行的结果。 */
export interface ProcessResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** 超时被杀：调用方一律当失败，并记 `timedOut`。 */
  readonly timedOut: boolean
  readonly durationMs: number
}

/** 跑一次外部命令（`ffmpeg` / `python`）。实现见 `adapters/song/process.ts`。 */
export interface ProcessPort {
  run(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string
      readonly timeoutMs: number
      readonly env?: Readonly<Record<string, string>>
      readonly signal?: AbortSignal
      /** 逐行回调（只给诊断，不影响结果）。 */
      readonly onLine?: (line: string) => void
    },
  ): Promise<ProcessResult>
}

/** B站能力（搜索 / 视频信息 / 下载音轨）。实现见 `adapters/song/bili.ts`。 */
export interface BiliPort {
  search(keyword: string, limit: number, signal?: AbortSignal): Promise<readonly SongCandidate[]>
  videoInfo(bvid: string, signal?: AbortSignal): Promise<BiliVideoInfo>
  /** 按 BV + 分P 下载**纯音频**到 `destFile`（已经是可解码的音轨）。 */
  downloadAudio(
    bvid: string,
    cid: number,
    destFile: string,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<{ readonly file: string; readonly bytes: number }>
}

/** 副歌定位能力。实现见 `adapters/song/chorus.ts`。 */
export interface ChorusPort {
  locate(
    audioFile: string,
    options?: { readonly needSeconds?: number; readonly signal?: AbortSignal },
  ): Promise<ChorusPick | null>
  /**
   * 手动起点（`startMode='start'`）：**跳过副歌搜索**，只算这个点之后的人声句尾。
   *
   * 为什么与 `locate` 分成两个方法：从头开始时那次搜索的结论一定会被起点 0 覆盖掉，
   * 而它要花 5–9 秒。分成两个方法之后，"从头开始"这条路径上不可能顺手白跑一次搜索。
   * `seconds` 是这次想要的长度上限，它决定句尾看多远（脚本按 `min(max(90, seconds+30), 240)` 伸缩）。
   * 失败同样收敛成 `null`，由上层退回"按上限硬切"。
   */
  locateFrom(
    audioFile: string,
    startSeconds: number,
    options: { readonly seconds: number; readonly signal?: AbortSignal },
  ): Promise<ChorusPick | null>
}

/** 翻唱能力。实现见 `adapters/song/cover.ts`。 */
export interface CoverPort {
  render(input: {
    readonly audioFile: string
    readonly outDir: string
    readonly chorusStart: number
    readonly seconds: number
    /** 人声升几个半音（0 = 原调）；见 `SongRequest.keyUp`。 */
    readonly keyUp: number
    readonly signal?: AbortSignal
  }): Promise<CoverResult>
}

/** 第一层（方案缓存）的记录：这首歌在这个音高与长度上限下，上次切的是哪一段。 */
export interface SongPlanRecord {
  /** 副歌起点（秒，相对整条音轨）。 */
  readonly chorusStart: number
  /** 上次裁出来的语音条长度（秒）。 */
  readonly seconds: number
  /** 上次定位的置信度（0..1）：门槛调高之后，旧记录必须能被判成"不再可靠"。 */
  readonly confidence: number
}

/** 第二层（音频缓存）的命中结果：文件已在盘上，时长已由适配器核过。 */
export interface CachedClip {
  /** 缓存文件（绝对路径，可直接交给 `VoicePort.sendVoice`）。 */
  readonly file: string
  /** `ffprobe` 实测时长（秒）；与期望值差超过容差时**不会**被返回（见适配器）。 */
  readonly durationSeconds: number
}

/**
 * 同歌缓存（两层，都落在 `<dshHome>/channel-qq/song-cache/`）。实现见 `adapters/song/cache.ts`。
 *
 * 两层分开的理由：**它们能省的东西不同**。方案缓存只省"副歌定位"（几秒），
 * 成品缓存省的是"下载 + 定位 + 分离 + RVC"（本机约 100 秒）。而方案又比成品小得多
 * （一条 JSON），能记住更多首歌；所以成品被淘汰时，下一次仍然不必重新定位。
 *
 * 三个必须写下的约定：
 *   1. **校验与淘汰都在适配器里**（`features/` 只做决策）：时长核对要用 `ffprobe`、
 *      淘汰要读目录——那都是 IO。
 *   2. **时长不对就当未命中并删掉这条**。缓存文件可能被手工删过一半、被安全软件
 *      截断、磁盘写坏；**发出半条语音条比慢 90 秒糟得多**。
 *   3. 键由 `planKey` / `clipKey` 生成，**必须带算法版本标签**（见 `cache-key.ts`）：
 *      改了分离器/模型/裁剪逻辑之后，旧缓存要被判成过期，而不是被当成有效结果复用。
 */
export interface SongCachePort {
  /** 方案键：`bvid | cid | keyUp | maxSeconds | PLAN_ALGO_TAG`。 */
  planKey(bvid: string, cid: number, keyUp: number, maxSeconds: number): string
  /** 成品键：`bvid | cid | keyUp | chorusStart | seconds | COVER_ALGO_TAG`。 */
  clipKey(bvid: string, cid: number, keyUp: number, chorusStart: number, seconds: number): string
  /** 读方案；没有/损坏返回 `null`（不抛），命中时刷新"最久没用"的记账。 */
  getPlan(key: string): Promise<SongPlanRecord | null>
  /** 写方案（命中时用不到，只在真的定位成功之后写）。 */
  putPlan(key: string, value: SongPlanRecord): Promise<void>
  /**
   * 读成品。**内部用 `ffprobe` 核对时长**：与 `expectedSeconds` 差超过容差就删掉这条
   * 并返回 `null`（当作未命中）。
   */
  getClip(key: string, expectedSeconds: number): Promise<CachedClip | null>
  /** 把做好的语音条收进缓存（复制一份；源文件属于任务目录，任务结束就删）。 */
  putClip(key: string, sourceFile: string): Promise<void>
  /** 按"最久没用"淘汰到 `cacheMaxEntries`，并清掉孤儿文件；**只记一行日志，不抛**。 */
  prune(): Promise<void>
}

/** 发语音条能力。实现来自 QQ 通道既有 `record` 发送（`adapters` 里接上 `qq_send_voice`）。 */
export interface VoiceSendResult {
  readonly ok: boolean
  /** 平台回执的消息 id；`null` = 没拿到回执。 */
  readonly messageId: number | null
  /**
   * 回执未知（发送已发出但超时/连接断）。**调用方必须停止自动重发**——
   * 这是"只收到一条语音条"的唯一保证。
   */
  readonly unknown: boolean
  /** 失败原因短句（给人看）。 */
  readonly detail: string
}

export interface VoicePort {
  sendVoice(room: string, chatId: number, file: string): Promise<VoiceSendResult>
}

/**
 * 发一条**文字**（受理回执 / 失败说明）。与 `VoicePort` 分开是因为两件事的失败语义不同：
 * 语音条发失败要记账（`unknown-send` 禁止重发），文字说明发失败只是"没解释清楚"，
 * 不能因为它没出去就把整条任务记成失败。
 */
export interface NoticePort {
  sendText(room: string, chatId: number, text: string): Promise<{ readonly ok: boolean; readonly detail: string }>
}

/** 调查（点歌入口）需要回答的第一件事：这个歌名够不够确定。 */
export interface SongLookup {
  /** 最匹配的那一条（无法区分时为 `null`，并给出 `candidates`）。 */
  readonly chosen: SongCandidate | null
  /** 同名/近名候选（给用户选）。 */
  readonly candidates: readonly SongCandidate[]
  /** 被跳过的理由（伴奏、教程、混剪、二次 AI 翻唱…）。 */
  readonly skipped: readonly { readonly bvid: string; readonly reason: string }[]
}

/** 队列对外状态（后台诊断与模型面都读它；不含凭据、不含完整 URL）。 */
export interface SongTaskStatus {
  readonly id: string
  readonly entry: SongEntry
  readonly room: string
  /** 点歌人 QQ 号（诊断用：这是谁点的）；`auto` 与拿不到时是 `null`。 */
  readonly requesterId: number | null
  readonly song: string
  readonly artist: string
  readonly stage: SongStage
  readonly bvid: string | null
  readonly chorusStart: number | null
  readonly seconds: number | null
  /** 本次人声升了几个半音（0 = 原调；`null` = 还没定，比如排队中）。 */
  readonly keyUp: number | null
  /** 失败原因短句（只在 `failed` / `unknown-send` 上有值）。 */
  readonly detail: string | null
  readonly createdAt: number
  readonly updatedAt: number
  /** 发送回执的消息 id。 */
  readonly messageId: number | null
}

/** 一次入队的结论。 */
export interface SongEnqueueResult {
  readonly accepted: boolean
  readonly taskId: string | null
  /** 给人看的一句话（受理 / 去重 / 队列已满 / 未启用）。 */
  readonly note: string
  /** 无法区分同名歌曲时给候选；`accepted` 为 false 时才有值。 */
  readonly candidates?: readonly SongCandidate[]
}

/**
 * 发语音前的**最后一道闸**的结论（由装配方接上主动消息的共享门控）。
 *
 * 三态与 `contact/gate.ts` 的 `authorizeOutbound` 同义，理由也相同：
 * `dry-run` 是"在观察"、`denied` 是"被禁止"，两者对账本的意义不同。
 */
export interface SendVerdict {
  readonly verdict: 'allowed' | 'dry-run' | 'denied'
  /** 稳定原因串（`dry-run` / `external-send-denied` / `quiet-hours` / `quota:room` …）。 */
  readonly reason: string
}

/** 一道闸的接口；装配方实现它（`features/song/index.ts` 接 contact 的共享门控）。 */
export interface SendGatePort {
  /**
   * 现在能不能往这个房间发一条语音条。
   *
   * `entry` 决定问哪一套判据——这是**故意分开**的：
   *   - `dm` / `group`：用户刚刚点了这首歌，所以免打扰/额度不该拦它（回话不是插话）。
   *     但仍要过「演练模式 / 允许真实外发」这两道配置闸与房间绑定校验。
   *     群聊与私聊在这一道闸上**同义**：差别只在语音条发到哪个房间（`voice.ts` 按 `room` 选）。
   *   - `auto`：机器人自己想发，必须**再问一次**主动消息那套门控（免打扰、额度、
   *     冷却、授权、会话绑定）。一句话：用户点的要发，自己想发的要问。
   */
  authorize(room: string, entry: SongEntry): Promise<SendVerdict>
}

/**
 * 一次任务里"用户可读的失败"。`stage` 是卡在流水线的哪一步，`detail` 是给人看的一句话。
 *
 * 用抛出而不是返回 `{ok:false}`：流水线里每一步都可能失败，而"任何一步失败都必须
 * 停止后面的步骤"用异常表达才不会漏（写返回值就得每一处都记得 `if (!result.ok) return`，
 * 而那正是最容易漏的那一行）。
 */
export class SongStepError extends Error {
  constructor(
    readonly stage: SongStage,
    /** 给人看的一句话（会进私聊回复与运行日志；不含凭据、不含本机路径）。 */
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'SongStepError'
  }
}
