/** 点歌段（`song`）：B站搜歌 → RVC 音色翻唱 → QQ 副歌语音条。
 *
 * 这一段放的是**这条链路的外部事实**：外部程序在哪（python / RVC 仓库 / ffmpeg）、
 * 凭据在哪、时间预算多少、失败时怎么收场。业务判定（选哪条视频、从哪一秒开始、发不发）
 * 在 `features/song/` 与 `adapters/song/` 里，不在这里。
 *
 * 三条刻意的默认值：
 *   1. **默认全关**：`enabled=false`、`autoPick=false`、`dryRun=true`、`allowExternalSend=false`。
 *      装上插件不等于机器人开始自己唱歌并往主人私聊里塞语音条——那是操作员的显式决定。
 *      这条链路的代价还特别贵：一首歌要跑 90 秒分离 + 30 秒推理，而且发出去的东西**撤不回**。
 *      唯一的例外是 `cacheEnabled`（默认开）：它不改变"发不发、发什么"，只是让同一首歌
 *      第二次点时不必再花 100 秒——那不是外发能力，所以不需要操作员先同意。
 *   2. **外部路径默认空**：`pythonPath` / `rvcRoot` / `makeCover` / `chorusPython` 空着 =
 *      未配置，运行时给一条"未配置"的阅读件而不是猜一个 `D:\` 盘路径。仓库里写死某台机器的
 *      绝对路径，换台机器就是一句静默的 ENOENT；而空值会让后台明确显示"未配置"。
 *   3. **超时是配置不是常量**：分离与推理的耗时随机器与歌长浮动（本机 320 秒歌实测 89 秒），
 *      写死常量只会在换机器时变成"莫名超时"。每一项都单独可调，且都有上限。
 *
 * 热生效：这一整段都是 `live`——适配器每次任务开始时现取，改完不用重挂子插件。
 * 唯一标 `reload` 的是 `autoPick`（它决定是否挂"每日一首"的定时器）。
 */

import { b, list, n, s, type FieldGroup } from '../dsl.js'

/** 点歌（翻唱语音条）的外部配置。 */
export interface SongConfig {
  /** 总开关；关着 = 工具直接说明"未启用"，后台不挂任何定时器。 */
  readonly enabled: boolean
  /** 主动联系里"自主选一首歌发过去"；关着只走私聊点歌。 */
  readonly autoPick: boolean
  /**
   * 群聊里是否允许点歌（默认关）。
   *
   * 为什么默认关：一条语音条会进整个群，而且群里任何人都能触发——这与"私聊里点一首"
   * 是两种社交后果。打开等于操作员认下"群里可以被点歌"这件事。
   */
  readonly groupEnabled: boolean
  /** 演练：全流程照跑（含真实下载与推理），只是不真发语音条。 */
  readonly dryRun: boolean
  /** 第二道闸；与 `dryRun` 是与关系，两者都放开才可能真发。 */
  readonly allowExternalSend: boolean
  /** 语音条长度上限（秒）；默认 59。实际长度会收在不超过它的最后一个人声句尾上。 */
  readonly seconds: number
  /** 副歌定位的置信度门槛（0–1）；低于它一律按"定位不可靠"处理。 */
  readonly minConfidence: number
  /**
   * 优先找女声源：先按用户给的信息搜一次，若拿到的不是女声，再搜「歌名 女声 翻唱」。
   *
   * 为什么默认开：这个音色模型是女声，拿男声原唱直接转换出来的音高会明显偏低甚至走音，
   * 而"先找女声翻唱、找不到再升八度"是这条链路上最稳的顺序。
   */
  readonly preferFemale: boolean
  /**
   * 男声源升几个半音（默认 12 = 一个八度）。
   *
   * 为什么是 12：RVC 换声靠 f0 对齐，男声基频大约 85–180 Hz、女声 165–255 Hz，
   * 差一个八度正好落进女声区间。升多了会变成假音，升少了还是低音。
   */
  readonly maleKeyUp: number
  /** 送进分离器/推理的前置余量（秒）：从副歌起点往前多切一点，给分离器上下文。 */
  readonly prefixSeconds: number
  /** 跑 RVC 的 python（空 = 未配置）。 */
  readonly pythonPath: string
  /** RVC 仓库根（`make_cover.py` 所在目录；空 = 未配置）。 */
  readonly rvcRoot: string
  /** `make_cover.py` 的路径（空 = `<rvcRoot>/make_cover.py`）。 */
  readonly makeCover: string
  /** 跑副歌定位脚本的 python（空 = 用 `pythonPath`，两者都没有才算未配置）。 */
  readonly chorusPython: string
  /** B站凭据文件（含 SESSDATA 等；空 = `<dshHome>/../bili-duty/bili_credential.json`）。 */
  readonly biliCredentialFile: string
  /** 任务工作目录（空 = `<dshHome>/channel-qq/song`）；中间产物都在这里，任务结束即清。 */
  readonly workRoot: string
  /** ffmpeg 可执行文件（文件名或绝对路径）。 */
  readonly ffmpegPath: string
  /** 下载音轨的超时（毫秒）。 */
  readonly downloadTimeoutMs: number
  /** 副歌定位的超时（毫秒）。 */
  readonly chorusTimeoutMs: number
  /** 分离 + 推理的超时（毫秒）；这是最长的一段，默认 4 分钟。 */
  readonly coverTimeoutMs: number
  /** 等 QQ 回执的超时（毫秒）；超时即"回执未知"，之后禁止自动重发。 */
  readonly sendTimeoutMs: number
  /** 队列里最多排几个；超了直接拒（不排长队，长队的语音条已经过时了）。 */
  readonly maxQueue: number
  /**
   * 同歌缓存：同一首歌再点时直接复用上次做好的语音条（省掉约 100 秒）。
   *
   * 为什么默认开：同一条视频、同一个音高、同一个长度上限下，做出来的语音条是同一段
   * 音频——重跑一遍唯一的作用是再花 100 秒显卡。缓存只在本机
   * `<dataDir>/home/channel-qq/song-cache/`（已 gitignore），不外发、不联网。
   */
  readonly cacheEnabled: boolean
  /** 每层缓存最多留几条（方案层与成品层各自计数）；超了按最久没用删。 */
  readonly cacheMaxEntries: number
  /** 自主选歌每天最多发几首（按 `Asia/Shanghai` 的日）；**0 = 不限额**。 */
  readonly dailyAutoCap: number
  /**
   * 每人每天最多点几首（按 `Asia/Shanghai` 的日）；**0 = 不限额**，主人与管理员不受此限。
   *
   * 与 `dailyAutoCap` 是两条账：这一条管"人点的"（私聊与群聊都算），那一条管"机器人
   * 自己想发的"。混在一起会让"机器人昨天自己唱了一首"变成"主人今天少点一次"。
   */
  readonly dailyUserCap: number
  /** 自主选歌的曲目（每条 `歌名` 或 `歌名 歌手`）；空 = 自主选歌什么都不做。 */
  readonly autoSongs: readonly string[]
}

/**
 * 默认值。**每一项都是工程建议默认，不是用户决定**（出处见 `docs/karaoke-cover.md`）。
 *
 * `seconds=59`：QQ 语音上限附近留 1 秒余量。它只是一个**上限**——实际长度由定位出的
 * 句尾决定（收在一句歌词结束处），所以通常是 40–59 秒之间的某个值。副歌一段本身
 * 常常就是 20–40 秒，把上限放到 59 秒是把"能不能多听一句"交给歌本身。
 * `minConfidence=0.55`：低于这个数的定位宁可问用户，也不要从主歌中间切。
 * `prefixSeconds=12`：分离器需要上下文才能把人声与伴奏分开，太短的片段分离质量明显下降。
 * 四个超时按"本机实测 × 2.5 倍余量"给：下载 60 秒、定位 30 秒、翻唱 4 分钟、回执 30 秒。
 */
export const SONG_DEFAULTS: SongConfig = {
  enabled: false,
  autoPick: false,
  groupEnabled: false,
  dryRun: true,
  allowExternalSend: false,
  seconds: 59,
  minConfidence: 0.55,
  preferFemale: true,
  maleKeyUp: 12,
  prefixSeconds: 12,
  pythonPath: '',
  rvcRoot: '',
  makeCover: '',
  chorusPython: '',
  biliCredentialFile: '',
  workRoot: '',
  ffmpegPath: 'ffmpeg',
  downloadTimeoutMs: 60_000,
  chorusTimeoutMs: 30_000,
  coverTimeoutMs: 240_000,
  sendTimeoutMs: 30_000,
  maxQueue: 8,
  cacheEnabled: true,
  cacheMaxEntries: 50,
  dailyAutoCap: 1,
  dailyUserCap: 2,
  autoSongs: [],
}

/** 一份可直接用的默认配置（浅拷贝；全是标量，没有要深拷的数组）。 */
export function defaultSongConfig(): SongConfig {
  return { ...SONG_DEFAULTS }
}

export const SONG_GROUPS: FieldGroup[] = [
  {
    id: 'song',
    label: '点歌翻唱（B站 → RVC 音色 → 语音条）',
    page: 'music',
    help: '点一首歌的四步：B站找到原唱 → 下载音轨 → 定位副歌 → RVC 换成机器人的音色 → 发一条从副歌开始的语音条。'
      + '**默认全关**：外发能力要先在这里显式打开；外部程序路径空着就是"未配置"，后台会直接写明而不是猜。'
      + '整条链路串行执行，一首歌通常 2–3 分钟；点完先回执，做好再发。',
    fields: {
      enabled: b('启用点歌翻唱', SONG_DEFAULTS.enabled, {
        hot: 'live',
        help: '总开关。关着时 `qq_song_cover` 只回"未启用"，也不会有任何后台定时器被挂上。',
      }),
      autoPick: b('自主选歌（主动联系）', SONG_DEFAULTS.autoPick, {
        hot: 'reload',
        help: '打开后，主动联系被允许时会自己挑一首歌做成语音条发给主人（每天最多 '
          + `${String(SONG_DEFAULTS.dailyAutoCap)} 首，按配置时区的自然日算）。`
          + '它同样要过主动联系的免打扰、额度、授权三道闸，任何一道不过就跳过这一轮。',
      }),
      groupEnabled: b('群聊里允许点歌', SONG_DEFAULTS.groupEnabled, {
        hot: 'live',
        help: '群聊里是否允许点歌，默认关。打开后群友也能点，语音条与失败说明都发在**那个群**里；'
          + '每人每天的首数由下面的「每人每日上限」管（主人与管理员不受限）。'
          + '关着时群里点歌会被明确拒绝并说明是哪个开关没开。',
      }),
      dryRun: b('演练模式', SONG_DEFAULTS.dryRun, {
        hot: 'live',
        help: '默认开。打开时下载、定位、翻唱全都真跑（这样能验证链路），只是**不真发**语音条，'
          + '结果记在运行日志里。要真发必须同时关掉它并打开下面的「允许真实外发」。',
      }),
      allowExternalSend: b('允许真实外发', SONG_DEFAULTS.allowExternalSend, {
        hot: 'live',
        help: '第二道闸，默认为关。发出去的是**真实语音消息、撤不回**，所以与「演练模式」是两个独立的开关。',
      }),
      seconds: n('语音条长度上限（秒）', SONG_DEFAULTS.seconds, {
        hot: 'live', min: 10, max: 59, step: 1, unit: '秒',
        help: '默认 59 秒（QQ 语音上限附近留 1 秒余量）。它是一个**上限**：'
          + '语音条从副歌起点开始，在不超这个长度的前提下尽量收在一句歌词的结束处'
          + '（换气/句间停顿），所以实际可能明显更短（例如 47 秒）。'
          + '网关嫌长时也会**保持同一个副歌起点**继续缩短，听到的仍是副歌开头。',
      }),
      minConfidence: n('副歌定位置信度门槛', SONG_DEFAULTS.minConfidence, {
        hot: 'live', min: 0.2, max: 0.95, step: 0.01,
        help: '重复段落相似度 × 人声活跃度 × 重复次数算出的分，低于这个值就不猜：'
          + '私聊点歌会回你「没找准副歌」并问一个时间点；自主选歌则跳过这一轮。',
      }),
      prefixSeconds: n('前置余量（秒）', SONG_DEFAULTS.prefixSeconds, {
        hot: 'live', min: 4, max: 30, step: 1, unit: '秒',
        help: '从副歌起点往前多切这么多秒送进分离器。人声分离需要上下文，切太短会分不干净；'
          + '最终语音条仍然从副歌起点开始，余量只是给处理用的。',
      }),
      preferFemale: b('优先女声源（找不到就男声升八度）', SONG_DEFAULTS.preferFemale, {
        hot: 'live',
        help: '默认开。这个音色模型是女声：先按你给的歌名/歌手去找，若找到的是男声原唱，'
          + '再搜一次「歌名 女声 翻唱」；仍然没有就**把原曲升高一个八度**再换声。'
          + '关掉 = 不搜翻唱、也不升调，直接拿原曲换声（男声歌容易偏低走音）。',
      }),
      maleKeyUp: n('男声升高（半音）', SONG_DEFAULTS.maleKeyUp, {
        hot: 'live', min: 0, max: 24, step: 1, unit: '半音',
        help: '没有女声源时，男声原曲升几个半音再换声。默认 12 = 一个八度'
          + '（男声基频大约 85–180 Hz、女声 165–255 Hz，差一个八度正好落进女声区间）。'
          + '注意这**不会**改变伴奏的音高：升八度只作用在人声上，伴奏保持原样。',
      }),
      pythonPath: s('RVC 的 Python', SONG_DEFAULTS.pythonPath, {
        hot: 'live', placeholder: 'D:/Bot/rvc/.venv/Scripts/python.exe',
        help: '跑 `make_cover.py` 的解释器（需要 torch 与 rvc 依赖）。留空 = 未配置，工具会明确说"没配置 RVC 环境"。',
      }),
      rvcRoot: s('RVC 仓库目录', SONG_DEFAULTS.rvcRoot, {
        hot: 'live', placeholder: 'D:/Bot/rvc',
        help: '`make_cover.py` 与 `assets/weights` 所在的目录。脚本会在这个目录下运行。留空 = 未配置。',
      }),
      makeCover: s('make_cover.py 路径', SONG_DEFAULTS.makeCover, {
        hot: 'live', placeholder: 'D:/Bot/rvc/make_cover.py',
        help: '留空则用 `<RVC 仓库目录>/make_cover.py`。',
      }),
      chorusPython: s('副歌定位的 Python', SONG_DEFAULTS.chorusPython, {
        hot: 'live', placeholder: 'D:/Bot/rvc/.venv/Scripts/python.exe',
        help: '副歌定位只用 numpy/librosa，跑得快。留空则复用上面的「RVC 的 Python」。',
      }),
      biliCredentialFile: s('B站凭据文件', SONG_DEFAULTS.biliCredentialFile, {
        hot: 'live', secret: true, placeholder: '<dataDir>/home/bili-duty/bili_credential.json',
        help: 'B站登录凭据（SESSDATA / bili_jct 等）。**只给插件内部读取**，不会出现在日志、'
          + '工具返回值或后台回显里。留空则用 `<dshHome>/../bili-duty/bili_credential.json`；'
          + '该文件也不存在时退回匿名请求（高清音轨可能拿不到）。',
      }),
      workRoot: s('任务工作目录', SONG_DEFAULTS.workRoot, {
        hot: 'live', placeholder: '<dataDir>/home/channel-qq/song',
        help: '下载的音轨与中间产物落在这里，每个任务一个子目录，任务结束后删除。'
          + '留空则用 `<dshHome>/channel-qq/song`。**不要指向仓库目录**：这些都是可丢弃的中间文件。',
      }),
      ffmpegPath: s('ffmpeg 路径', SONG_DEFAULTS.ffmpegPath, {
        hot: 'live', placeholder: 'ffmpeg',
        help: '抽音频、切口、量时长都用它。写文件名就按 PATH 找；Windows 上建议给绝对路径。',
      }),
      downloadTimeoutMs: n('下载超时（毫秒）', SONG_DEFAULTS.downloadTimeoutMs, {
        hot: 'live', min: 10_000, max: 600_000, step: 1_000, unit: 'ms',
        help: '一条音轨通常几秒（5 分钟歌约 6–7 MB）。超时按失败处理，不会拖住后面的任务。',
      }),
      chorusTimeoutMs: n('副歌定位超时（毫秒）', SONG_DEFAULTS.chorusTimeoutMs, {
        hot: 'live', min: 5_000, max: 300_000, step: 1_000, unit: 'ms',
        help: '定位脚本本机实测几秒。超时按"定位不可靠"处理（不猜、问用户）。',
      }),
      coverTimeoutMs: n('分离与推理超时（毫秒）', SONG_DEFAULTS.coverTimeoutMs, {
        hot: 'live', min: 30_000, max: 1_800_000, step: 1_000, unit: 'ms',
        help: '人声分离 + 音色转换的最长时间。本机 320 秒歌分离约 89 秒、45 秒片段推理约 27 秒；'
          + '只跑副歌附近的片段就是为了把这段时间压住。',
      }),
      sendTimeoutMs: n('等回执超时（毫秒）', SONG_DEFAULTS.sendTimeoutMs, {
        hot: 'live', min: 5_000, max: 300_000, step: 1_000, unit: 'ms',
        help: '发出语音条后等平台回执的上限。超时记成**回执未知**，并且此后不会再自动重发——'
          + '宁可承认不知道，也不要让主人收到两条一样的语音。',
      }),
      maxQueue: n('队列上限（个）', SONG_DEFAULTS.maxQueue, {
        hot: 'live', min: 1, max: 50, step: 1,
        help: '同时排队的点歌上限，超了直接拒。一首歌两三分钟，排太长的队等于发一条过时的语音条。',
      }),
      cacheEnabled: b('同歌缓存（同一首歌再点时直接复用）', SONG_DEFAULTS.cacheEnabled, {
        hot: 'live',
        help: '默认开。同一首歌（同一条视频、同一个分P、同一个音高、同一个长度上限）再点时，'
          + '直接复用上次做好的语音条，省掉下载 + 副歌定位 + 分离 + 推理约 100 秒。'
          + '缓存**只在本机** `<dataDir>/home/channel-qq/song-cache/`，不外发、不联网；'
          + '命中之前会用 `ffprobe` 核一次时长，对不上就删掉那条重新做（半条语音条比慢一点糟得多）。'
          + '关掉 = 每次都重跑，行为与加缓存之前一致。',
      }),
      cacheMaxEntries: n('缓存条数上限（每层）', SONG_DEFAULTS.cacheMaxEntries, {
        hot: 'live', min: 1, max: 500, step: 1, unit: '条',
        help: '方案缓存（一条 JSON）与音频缓存（0.4–1 MB）**各自**最多留几条。超了按"最久没用"删到上限，'
          + '同时清掉孤儿文件（有文件没记账、有记账没文件）。默认 50：按 1 MB 一条算最多约 50 MB。',
      }),
      dailyAutoCap: n('自主选歌每日上限（首，0 = 不限）', SONG_DEFAULTS.dailyAutoCap, {
        hot: 'live', min: 0, max: 5, step: 1, unit: '首',
        help: '自主选歌每天最多发几首，按配置时区的自然日算。默认 1：一天一首已经是"会自己找话说"的上限了。'
          + '**填 0 = 不限额**：同一天可以发多首（去重键与任务 id 会按序号分开），'
          + '仍然照旧要过主动联系的免打扰/额度/冷却/授权/绑定，以及本段的演练与外发两道闸。'
          + '注意不限额意味着**成本不封顶**：一首歌要跑 1–2 分钟分离与推理。',
      }),
      autoSongs: list('自主选歌曲目', [...SONG_DEFAULTS.autoSongs], {
        hot: 'live', itemsKind: 'string',
        placeholder: '例如「晴天 周杰伦」',
        help: '自主选歌从那几首里按日期轮换（**空 = 什么都不发**）。每条写「歌名」或「歌名 歌手」。'
          + '默认空：不填写时机器人不会自己找歌——它凭什么替你决定想听什么。'
          + '填了之后按「每日上限」发（默认每天 1 首，上限填 0 则不限额），'
          + '并且照旧要过免打扰/额度/授权三道闸。',
      }),
      dailyUserCap: n('每人每日上限（首，0 = 不限）', SONG_DEFAULTS.dailyUserCap, {
        hot: 'live', min: 0, max: 20, step: 1, unit: '首',
        help: '每人每天最多点几首；主人不受此限；0 = 不限额。默认 2。'
          + '按 `Asia/Shanghai` 的自然日算，私聊与群聊的点歌算同一份额度。'
          + '已经发出去的与还在排队/在做的都占额度（否则同一个人的两条并发请求会双双通过）；'
          + '失败、取消、演练过的**不占**，用户可以重新点。'
          + '自主选歌另有一条账（「自主选歌每日上限」），两者不混。',
      }),
    },
  },
]
