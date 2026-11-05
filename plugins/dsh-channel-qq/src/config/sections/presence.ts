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

import { b, list, n, type FieldGroup } from '../dsl.js'

/** `presence` 段的形状；字段定义与默认值见下面 `PRESENCE_GROUPS`（唯一来源）。 */
export interface PresenceConfig {
  /** 总开关（默认 false）：关着时整条旁听/判断/自主发言路径都不跑。 */
  enabled: boolean
  /** 白名单群号；空数组 = 谁都不启用。 */
  groups: number[]
  /** 每群旁听缓冲的条数上限。 */
  ambientMaxEntries: number
  /** 旁听条目存活多久（毫秒）；超时的条目在读取前就被淘汰。 */
  ambientTtlMs: number
  /** 每群旁听缓冲的总字数上限（与条数上限**双**淘汰）。 */
  ambientMaxChars: number
  /** 两次兴趣判断之间的最小间隔（毫秒）：短时间内的消息合成一批再判。 */
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
}

export const PRESENCE_GROUPS: FieldGroup[] = [
  {
    id: 'presence',
    label: '群聊旁听与接话',
    page: 'groups',
    help: '在群里先旁听、觉得够相关才自己说一句。**默认关**：关着时与旧行为逐字节一致，'
      + '不记旁听、不调用模型、不发任何一条自主消息。只对白名单群生效。',
    fields: {
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
      judgeIntervalMs: n('两次判断的最小间隔', 50_000, {
        hot: 'live',
        page: 'groups',
        min: 10_000,
        max: 600_000,
        step: 5_000,
        unit: 'ms',
        help: '两次兴趣判断之间至少隔这么久（毫秒），这段时间里来的消息合进下一批。'
          + '它是**省钱的闸**：默认 50 秒 ≈ 每个活跃群每小时最多一次判断，'
          + '再密只会让模型调用变成按消息计费。',
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
