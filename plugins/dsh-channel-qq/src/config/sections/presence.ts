/** 群聊旁听与自主接话段（`presence`）：先旁听、再判断、最后才可能自己开口。
 *
 * **默认关**（`enabled=false`）：关着时入站路径与旧行为逐字节一致——不记旁听、
 * 不调用模型判断、也一条自主消息都不会发。打开是操作者的显式决定，不是发布默认。
 *
 * 口径（实现基线见 `design/group-interest-selection-20261101.md` §0.1）：
 *   - 只对 `groups` 里的**白名单群**生效，留空 = 谁都不启用；
 *   - `requireMention` / `talkValue` **不动**——群仍然是"只回 @"，自主接话走这条
 *     独立开关，不靠概率、不靠关键词（这两样都会让"她要不要开口"变得不可解释）。
 *
 * 热生效一律 `live`：旁听上限、判断节流、发言限频都在**每次用到时**从 config 现取
 * （`AmbientStore.limitsOf(config)` / `PresenceLimits` 每次判断与发言前重算），
 * 所以改完保存就生效，既不重启也不重连；这也是"每项配置都要标清楚被谁读"的落点。
 *
 * 下面每个数字都是**工程建议默认值，不是用户决定**：按"免打扰 > 额度 > 冷却 >
 * 想说话"的顺序取，逐条改写会直接改变她在群里自己开口的频率，所以每条 `help`
 * 都写了后果。
 */

import { b, e, list, n, type FieldGroup } from '../dsl.js'

/** `presence` 段的形状；字段定义与默认值见下面 `PRESENCE_GROUPS`（唯一来源）。 */
export interface PresenceConfig {
  /**
   * 运行模式（P5-B）：`off` / `shadow` / `live`。
   *
   * 缺席时按 `enabled` 推断（`enabled:true` → `live`），所以旧配置升级后行为不变。
   * 显式写了 `mode` 之后它**优先于** `enabled`：写了 `shadow` 就不会发消息。
   */
  mode: string
  /** 总开关（默认 false）：关着时整条旁听/判断/自主发言路径都不跑。`mode` 缺席时的旧口径。 */
  enabled: boolean
  /** 白名单群号；空数组 = 谁都不启用。 */
  groups: number[]
  /** 每群旁听缓冲的条数上限。 */
  ambientMaxEntries: number
  /** 旁听条目存活多久（毫秒）；超时的条目在读取前就被淘汰。 */
  ambientTtlMs: number
  /** 每群旁听缓冲的总字数上限（与条数上限**双**淘汰）。 */
  ambientMaxChars: number
  /** 合批静默窗口（毫秒）：一批消息攒这么久再判断。 */
  batchQuietMs: number
  /** 一批消息等待判断的上限（毫秒）：只用于饥饿告警。 */
  judgeMaxWaitMs: number
  /** 两次兴趣判断之间的最小间隔（毫秒）。 */
  judgeIntervalMs: number
  /** 送进一次判断的旁听条数上限。 */
  judgeMaxEntries: number
  /** 送进一次判断的旁听总字数上限。 */
  judgeMaxChars: number
  /** 单次判断调用的超时（毫秒）。 */
  judgeTimeoutMs: number
  /** 判断调用的输出 token 上限（只输出一个短 JSON）。 */
  judgeMaxTokens: number
  /** 两次自主发言之间的最小间隔（毫秒，按群计）。 */
  speakMinIntervalMs: number
  /** 每群每小时的自主发言上限。 */
  speakMaxPerHour: number
  /** 自主发言的字数上限（一至两句，不截断：超了按"这轮不说"处理）。 */
  replyMaxChars: number
  /** 允许引用的时间窗（毫秒）：比这更老的消息不许 reply。 */
  replyWindowMs: number
  /** 群记忆注入的字数预算（§5.4 建议 600–800）。 */
  memoryBudgetChars: number
  /** 自主发言之后是否允许配一张表情包（P4 §8.2）。默认关闭。 */
  stickers: boolean
  /** 两张图之间的最小间隔（毫秒）。 */
  stickerMinIntervalMs: number
  /** 每小时最多几张图。 */
  stickerMaxPerHour: number
}

export const PRESENCE_GROUPS: FieldGroup[] = [
  {
    id: 'presence',
    label: '群聊旁听与接话',
    page: 'groups',
    help: '在群里先旁听、觉得够相关才自己说一句。**默认关**：关着时与旧行为逐字节一致，'
      + '不记旁听、不调用模型、不发任何一条自主消息。只对白名单群生效。',
    fields: {
      // 读法：装配侧每次现取（live）；最后一道发送闸门**每次发送前**再读一次。
      mode: e('运行模式', 'off', [
        ['off', '关闭：不判断、不发'],
        ['shadow', '影子：真判断、真校验、只记不发'],
        ['live', '线上：真的会发（白名单 + 限频）'],
      ], {
        hot: 'live',
        page: 'groups',
        help: '三档语义见 README 与 docs/10c：off 什么都不做；shadow 收消息、调模型、走完所有校验，'
          + '但**一条都不发**，只把"本来想发什么、为什么"记进本地影子日志；live 才会真的发到群里。'
          + '留空 / 不写这一项时按下面的总开关推断（enabled:true 视为 live），旧配置行为不变。'
          + '**停发请改这一项，不要用 speakMaxPerHour=0**：那个只停自主发言，停不了表情包。',
      }),
      // 读法：入站流水线与判断执行器每包/每次判断前经 config() 现取（live）。
      enabled: b('启用旁听与自主接话', false, {
        hot: 'live',
        page: 'groups',
        help: '默认关。打开后只对下面白名单里的群生效：旁听消息先记进每群的短期缓冲，'
          + '攒够一批再判断一次"要不要接话"，决定开口才真的发（而且仍受发言限频约束）。'
          + '群里的「@ 才回」「回复概率」照旧，不受这个开关影响。',
      }),
      groups: list('白名单群号', [], {
        hot: 'live',
        page: 'groups',
        itemsKind: 'number',
        help: '只对白名单群生效；留空 = 谁都不启用（即使总开关是开的）。'
          + '写群号（数字），逗号分隔；填成字符串也能识别，认不出来的那一项会被原样保留并跳过。',
      }),
      ambientMaxEntries: n('旁听缓冲条数上限', 40, {
        hot: 'live',
        page: 'groups',
        min: 5,
        max: 500,
        step: 5,
        unit: '条',
        help: '每群最多留多少条旁听。超了先按条数、再按字数淘汰最老的——'
          + '旁听只是短期背景，不是证据库。默认 40 条是工程建议。',
      }),
      ambientTtlMs: n('旁听条目存活', 600_000, {
        hot: 'live',
        page: 'groups',
        min: 60_000,
        max: 3_600_000,
        step: 60_000,
        unit: 'ms',
        help: '一条旁听留多久（毫秒）。默认 10 分钟：再老的上下文接上去只会像答非所问。',
      }),
      ambientMaxChars: n('旁听缓冲字数上限', 6_000, {
        hot: 'live',
        page: 'groups',
        min: 500,
        max: 60_000,
        step: 500,
        unit: '字',
        help: '每群旁听的总字数上限，与条数上限**双**淘汰（谁先到就按谁淘汰最老的）。'
          + '它防的是"40 条全是长文"，那时按条数限制根本不够。默认 6000 字是工程建议。',
      }),
      batchQuietMs: n('合批静默窗口', 6_000, {
        hot: 'live',
        page: 'groups',
        min: 1_000,
        max: 60_000,
        step: 1_000,
        unit: 'ms',
        help: '往上数消息安静这么久才把这一批送去判断（毫秒）。它管的是"读得懂上下文"：'
          + '太短会把一句话拆成两批，太长会让她对着过时的话题接话。默认 6 秒。'
          + '**与判断间隔分开**：那个管省钱，这个管读得懂。',
      }),
      judgeMaxWaitMs: n('一批消息等待判断的上限', 25_000, {
        hot: 'live',
        page: 'groups',
        min: 5_000,
        max: 300_000,
        step: 5_000,
        unit: 'ms',
        help: '持续活跃的群里，一批消息已经等了这么久还没被判，就写一条**饥饿告警**日志'
          + '（通常是限频、失败退避或同群在途造成的）。它不改变调度，只保证问题看得见。默认 25 秒。',
      }),
      judgeIntervalMs: n('两次判断的最小间隔', 50_000, {
        hot: 'live',
        page: 'groups',
        min: 10_000,
        max: 600_000,
        step: 5_000,
        unit: 'ms',
        help: '两次判断之间至少隔这么久（毫秒）。它是**省钱的闸**：默认 50 秒 ≈ 每个活跃群'
          + '每小时最多一次判断，再密只会让模型调用变成按消息计费。',
      }),
      judgeMaxEntries: n('送进判断的条数上限', 15, {
        hot: 'live',
        page: 'groups',
        min: 1,
        max: 100,
        step: 1,
        unit: '条',
        help: '一次判断最多读多少条旁听（取最近的那些）。默认 15 条是工程建议。',
      }),
      judgeMaxChars: n('送进判断的字数上限', 1_200, {
        hot: 'live',
        page: 'groups',
        min: 100,
        max: 20_000,
        step: 100,
        unit: '字',
        help: '一次判断最多读多少字（同样取最近的）。默认 1200 字：判断"要不要接话"'
          + '不需要完整上下文，读到主题就够。',
      }),
      judgeTimeoutMs: n('单次判断超时', 25_000, {
        hot: 'live',
        page: 'groups',
        min: 1_000,
        max: 180_000,
        step: 1_000,
        unit: 'ms',
        help: '判断调用超过这么久就按失败处理（只记一次失败，不重试、不补发）。'
          + '默认 25 秒是工程建议。',
      }),
      judgeMaxTokens: n('判断输出 token 上限', 320, {
        hot: 'live',
        page: 'groups',
        min: 32,
        max: 2_048,
        step: 32,
        unit: 'token',
        help: '判断只输出一个短 JSON（说 / 不说 + 一句话），320 个 token 已经很宽裕；'
          + '调大会让"她开始写小作文"，而输出越啰嗦越容易解析失败。',
      }),
      speakMinIntervalMs: n('两次自主发言的最小间隔', 300_000, {
        hot: 'live',
        page: 'groups',
        min: 30_000,
        max: 3_600_000,
        step: 30_000,
        unit: 'ms',
        help: '同一个群两条自主发言之间至少隔这么久（毫秒）。默认 5 分钟是工程建议——'
          + '接话接得比这更勤就不是"偶尔搭一句"，是插嘴。',
      }),
      speakMaxPerHour: n('每群每小时自主发言上限', 3, {
        hot: 'live',
        page: 'groups',
        min: 1,
        max: 30,
        step: 1,
        unit: '次/小时',
        help: '硬额度：一个群一小时内最多自己开口几次（成功的才计数，判断失败不算）。'
          + '默认 3 次是工程建议；想让她更安静就调小它，而不是关掉接话。',
      }),
      replyWindowMs: n('允许引用的时间窗', 600_000, {
        hot: 'live',
        page: 'groups',
        min: 30_000,
        max: 3_600_000,
        step: 30_000,
        unit: 'ms',
        help: 'reply 只能引用时间窗以内的消息（毫秒）：引一条十分钟前的消息等于答非所问。'
          + '默认 10 分钟。超出窗口的引用会被代码拦下，这一轮就不说话。',
      }),
      memoryBudgetChars: n('群记忆注入预算', 800, {
        hot: 'live',
        page: 'groups',
        min: 100,
        max: 4_000,
        step: 100,
        unit: '字',
        help: '一次判断里"群体记忆 + 成员记忆"总共允许多少字（中文按字符算）。'
          + '默认 800 字（计划建议 600～800）：再多会把这一轮真正要说的话挤掉；'
          + '超预算时先丢推测、再丢成员记忆，最后才动群体记忆。',
      }),
      stickers: b('允许自主发言配表情包', false, {
        // `live`：消费方（presence-afterspeak 的 settingsOf）每次现取，改完立即生效。
        hot: 'live',
        page: 'groups',
        help: '打开后，自主发言可能再配一张表情包（发不发、发哪张由 companion-expression 决定）。'
          + '默认**关闭**：它依赖图库已授权并自带冷却与审核，未配置时会一直"没有合适的图"。'
          + '打开前先确认图库那边真的可用，否则日志里只会多出一串 declined。',
      }),
      stickerMinIntervalMs: n('两张图的最小间隔', 600_000, {
        hot: 'live',
        page: 'groups',
        min: 60_000,
        max: 7_200_000,
        step: 60_000,
        unit: 'ms',
        help: '两次配图之间至少隔这么久（毫秒），默认 10 分钟。与文字限频**分开**：'
          + '文字说多了是啰嗦，图发多了是刷屏。',
      }),
      stickerMaxPerHour: n('每小时最多几张图', 1, {
        hot: 'live',
        page: 'groups',
        min: 1,
        max: 6,
        step: 1,
        unit: '张',
        help: '每群每小时最多配几张图，默认 1。连续两张图在任何群里都像机器人。',
      }),
      replyMaxChars: n('自主发言字数上限', 70, {
        hot: 'live',
        page: 'groups',
        min: 10,
        max: 500,
        step: 10,
        unit: '字',
        help: '一句自主发言的字数上限（一至两句）。超了**不截断**，直接按"这轮不说"处理——'
          + '截断会发出半句话，比不说更难看。默认 70 字是工程建议。',
      }),
    },
  },
]
