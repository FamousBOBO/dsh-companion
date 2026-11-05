/** 主动消息（contact）段：门控阈值、额度、草稿预算与两道发送授权。
 *
 * **默认一切关闭**：`enabled=false`、`dryRun=true`、`allowExternalSend=false`、
 * `sendMode='turn'`、`draftModel=false`。装上一个新插件不该让机器人立刻开始自己找人
 * 说话——所以这里每一个"会真的发出去"的开关默认都是关的，打开是操作者的显式决定。
 *
 * 下面每个数字都是**工程建议默认值，不是用户决定**：它们按同一条排序取
 * "免打扰 > 额度 > 冷却 > 想说话"，用户没有对任何一个阈值表过态。逐条改写会直接
 * 改变打扰频率，所以每条都在 `help` 里写了后果，契约见 `docs/proactive-message.md`。
 *
 * 默认值只在 `CONTACT_DEFAULTS` 里写一次（字段声明与 `defaultContactConfig()` 都读它）：
 * 两份数字迟早不一致，而"后台显示的默认值"和"测试里的默认值"不一致时，
 * 没人能说清哪一份是真的。
 *
 * 页面用现有的 `proactive`（不新开页面）：主动消息就是"主动行为"的第三种形态，
 * 与事件书放在一起才看得出"这几种主动开口"的边界。
 *
 * 热生效：`enabled` / `dryRun` / `allowExternalSend` / `sendMode` / `pollIntervalMs`
 * 决定 worker 起不起、怎么起，标 `reload`；其余阈值在每次门控里现取，标 `live`。
 */

import type { QuietRange } from '../../core/schedule/due.js'
import { b, e, json, n, s, type FieldGroup } from '../dsl.js'
import type { ContactConfig } from './switches.js'

// 类型本体在 `./switches.ts`（与另外几个开关型段同处），这里只负责字段定义；
// 从这里 re-export 是给功能代码一个"配置就在这一段旁边"的读法（gate.ts 就是这么用的）。
export type { ContactConfig } from './switches.js'

/** 默认安静时段：夜里 23:00 到早上 08:00（半开区间，支持跨午夜）。 */
const DEFAULT_QUIET_HOURS: QuietRange[] = [{ from: '23:00', to: '08:00' }]

/**
 * 默认配置（**工程建议默认值，非用户决定**）。
 *
 * 与 `DEFAULT_CONFIG.contact` 必须逐字段相等——schema 由它展开生成，所以两者同源；
 * 测试与文档都从 `defaultContactConfig()` 取，不要手抄第二份数字。
 */
export const CONTACT_DEFAULTS: ContactConfig = {
  enabled: false,
  dryRun: true,
  allowExternalSend: false,
  sendMode: 'turn',
  timezone: '',
  allowedRooms: [],
  quietHours: DEFAULT_QUIET_HOURS,
  settleWindowMs: 120_000,
  maxCandidates: 50,
  // 分享候选最多等 6 小时（理由写在字段的 help 里：分享有时效，隔夜就不是当时想说的了）。
  shareTtlMs: 6 * 3_600_000,
  globalCooldownMs: 1_800_000,
  perRoomCooldownMs: 3_600_000,
  dailyQuotaGlobal: 3,
  dailyQuotaPerRoom: 2,
  maxUnansweredStreak: 2,
  pollIntervalMs: 60_000,
  followUpIdleMs: 6 * 3_600_000,
  followUpIntervalMs: 24 * 3_600_000,
  maxCatchupHours: 24,
  maxPerTick: 1,
  // 默认关：这条复核会**复用模型预算**（一次短补全），属于后台模型任务。
  adaptiveFollowUp: false,
  sleepSummaryRecipient: '',
  draftModel: false,
  draftDailyBudget: 20,
  draftHourlyBudget: 5,
  draftTimeoutMs: 20_000,
  draftMaxChars: 120,
  draftFailureBackoffMs: 60_000,
  draftMaxFailures: 5,
}

/** 一份可直接用的默认配置（浅拷贝；`quietHours` 也复制，免得调用方改到默认值）。 */
export function defaultContactConfig(): ContactConfig {
  return { ...CONTACT_DEFAULTS, quietHours: [...CONTACT_DEFAULTS.quietHours] }
}

export const CONTACT_GROUPS: FieldGroup[] = [
  {
    id: 'contact',
    label: '主动消息（门控）',
    page: 'proactive',
    help: '候选 → 廉价门控 → 草稿 → outbox 的完整链路。这里只管门控阈值与授权；'
      + '明确提醒仍走「提醒」页那条直发通道，同一提醒不会被两条路径各发一次。',
    fields: {
      enabled: b('启用主动消息', CONTACT_DEFAULTS.enabled, {
        hot: 'reload',
        help: '总开关，默认关。关着时候选照常入库（诊断看得到），但一条都不会发，也不会调用模型。',
      }),
      dryRun: b('演练模式', CONTACT_DEFAULTS.dryRun, {
        hot: 'reload',
        help: '默认开。打开时全部流程照常走（含门控判定），只是**不真正投递**，'
          + '诊断里能看到"本来要发什么、为什么没发"。要真发必须同时关掉它并打开下面的外发授权。',
      }),
      allowExternalSend: b('允许真实外发', CONTACT_DEFAULTS.allowExternalSend, {
        hot: 'reload',
        help: '第二道闸，默认关。它与「演练模式」是**与**关系：两者都放开才可能真的发出去。'
          + '分两道是因为"我想先看它打算说什么"和"我允许它对外说话"是两次决定。',
      }),
      sendMode: e('发送方式', CONTACT_DEFAULTS.sendMode, [
        ['turn', '经会话回合（人格包渲染，拿不到回执）'],
        ['direct', '直发（有平台消息 id，可到 confirmed；需要允许模型起草）'],
      ], {
        hot: 'reload',
        help: '默认 turn：由既有会话回合开口，人格一致、失败也不会变成裸推送；'
          + '代价是 outbox 只能停在 submitted（没有平台回执）。direct 更可控，但绕开了人格包，'
          + '**文案必须由模型起草**——所以 direct + 不允许起草 = 一条也发不出去（启动时会明确记一行日志）。',
      }),
      timezone: s('时区', CONTACT_DEFAULTS.timezone, {
        hot: 'live',
        placeholder: 'Asia/Shanghai（留空 = 跟随宿主 TZ）',
        help: '免打扰与「今天」都按这个 IANA 时区算。留空跟随宿主——'
          + '但宿主换机器/换 TZ 时免打扰会跟着漂，跨时区部署务必写死。名字不认识时一律不发（fail-closed）。',
      }),
      allowedRooms: json('出站房间白名单', CONTACT_DEFAULTS.allowedRooms ?? [], {
        hot: 'live',
        help: '可选数组。非空时只有这些房间能出站；生产只放主人私聊，群聊和其他私聊一律拒绝。',
      }),
      quietHours: json('免打扰时段', CONTACT_DEFAULTS.quietHours, {
        hot: 'live',
        help: '数组 [{ from: "HH:MM", to: "HH:MM" }]，半开区间、支持跨午夜（23:00→08:00 即跨午夜）。'
          + '默认 23:00–08:00 是**工程建议**，不是用户说的作息；空数组 = 不设免打扰。',
      }),
      settleWindowMs: n('用户在场窗口', CONTACT_DEFAULTS.settleWindowMs, {
        hot: 'live', min: 0, max: 1_800_000, step: 10_000, unit: 'ms',
        help: '用户最后一条消息之后的这段时间内不主动开口（人家正在说话，别插嘴）。'
          + '默认 2 分钟是工程建议；0 = 关闭该门。',
      }),
      maxCandidates: n('候选上限', CONTACT_DEFAULTS.maxCandidates, {
        hot: 'live', min: 1, max: 500,
        help: '候选池上限，超了丢最旧的（先按优先级、再按过期时间）。防止一次导入把池子撑爆。',
      }),
      shareTtlMs: n('分享候选有效期', CONTACT_DEFAULTS.shareTtlMs, {
        hot: 'live', min: 60_000, max: 86_400_000, step: 60_000, unit: 'ms',
        help: '**分享候选**（runtime 的 P2 分享链递过来的 `share-intent`）进了候选池之后最多等多久。'
          + '默认 6 小时的理由：分享的时效性是"这一会儿想给你看的东西"——超过半天，'
          + '再漂亮的句子也已经不是她当时想说的了；而给得太短（比如 30 分钟）会让'
          + '免打扰一整夜、冷却两小时这类正常等待把候选直接等死。'
          + '最小 1 分钟、最大 24 小时；它只影响分享候选，不影响其它来源的候选。',
      }),
      globalCooldownMs: n('全局冷却', CONTACT_DEFAULTS.globalCooldownMs, {
        hot: 'live', min: 0, max: 86_400_000, step: 60_000, unit: 'ms',
        help: '两条主动消息之间至少隔这么久（不分房间）。默认 30 分钟是工程建议；0 = 不设全局冷却。',
      }),
      perRoomCooldownMs: n('会话冷却', CONTACT_DEFAULTS.perRoomCooldownMs, {
        hot: 'live', min: 0, max: 86_400_000, step: 60_000, unit: 'ms',
        help: '同一个房间两条主动消息之间的最小间隔。默认 1 小时是工程建议；0 = 不设会话冷却。'
          + '它比全局冷却长，是因为连续两次找同一个人比隔一会儿找两个人更像骚扰。',
      }),
      dailyQuotaGlobal: n('每日总额度', CONTACT_DEFAULTS.dailyQuotaGlobal, {
        hot: 'live', min: 1, max: 50,
        help: '一天最多主动开口几次（所有房间合计）。默认 3 是工程建议，'
          + '按"一天三次已经算主动"取的；跨日自动归零。',
      }),
      dailyQuotaPerRoom: n('每会话日额度', CONTACT_DEFAULTS.dailyQuotaPerRoom, {
        hot: 'live', min: 1, max: 50,
        help: '同一个房间一天最多几次。默认 2 是工程建议——同一件事一天提两遍已经够多了。',
      }),
      maxUnansweredStreak: n('未回复上限', CONTACT_DEFAULTS.maxUnansweredStreak, {
        hot: 'live', min: 0, max: 10,
        help: '连续这么多条主动消息都没等到回复就先停下来（等用户再说话）。'
          + '默认 2 是工程建议；0 = 不设上限（不建议：那等于允许它对着空气一直说）。',
      }),
      pollIntervalMs: n('调度间隔', CONTACT_DEFAULTS.pollIntervalMs, {
        hot: 'reload', min: 5_000, max: 1_800_000, step: 5_000, unit: 'ms',
        help: 'worker 多久看一次候选池。默认 1 分钟是工程建议——所有门控都是分钟粒度，更密没有意义。'
          + '空转时不调用模型，所以这个间隔只影响延迟，不影响开销。',
      }),
      followUpIdleMs: n('空闲跟进阈值', CONTACT_DEFAULTS.followUpIdleMs!, {
        hot: 'live', min: 60_000, max: 86_400_000, step: 60_000, unit: 'ms',
        help: '主人私聊静默多久后可把主动联系交给该 QQ 会话判断。不是必发频率。',
      }),
      followUpIntervalMs: n('空闲候选周期', CONTACT_DEFAULTS.followUpIntervalMs!, {
        hot: 'live', min: 60_000, max: 86_400_000, step: 60_000, unit: 'ms',
        help: '同一时间段只提一个候选；仍受每日额度、冷却和未回复限制。',
      }),
      maxCatchupHours: n('补算视界', CONTACT_DEFAULTS.maxCatchupHours, {
        hot: 'live', min: 1, max: 720, unit: '小时',
        help: '停机之后**不补发**的视界：最早可发时刻比这个视界还老的候选一律判过期（诊断记 stale:restart）。'
          + '默认 24 小时是工程建议——停机八小时之后一口气补八条，等于把"想你"变成"洪水"。',
      }),
      maxPerTick: n('每轮领取条数', CONTACT_DEFAULTS.maxPerTick, {
        hot: 'live', min: 1, max: 20,
        help: '每次 tick 最多领取几条候选。默认 1 是工程建议：一条一条来，'
          + '某一条草稿失败也不会把同一轮的其它候选一起拖住。',
      }),
      adaptiveFollowUp: b('自主跟进复核', CONTACT_DEFAULTS.adaptiveFollowUp === true, {
        hot: 'live',
        help: '默认关。打开后会为 qq_followup 创建的意图**复用模型预算**做一次复核'
          + '（属于后台模型任务，所以默认不开）；目的已完成或无需再问时静默结束。'
          + '它不会开启主动发送总开关。',
      }),
      sleepSummaryRecipient: s('授权接收睡眠摘要的主人 QQ 号', CONTACT_DEFAULTS.sleepSummaryRecipient ?? '', {
        hot: 'live',
        help: '留空关闭。仅当号码与当前主人一致时，才允许向该私聊披露睡眠起止与时长。仍需健康关怀同意和主动联系门控放行。',
      }),
      draftModel: b('允许模型起草', CONTACT_DEFAULTS.draftModel, {
        hot: 'live',
        help: '默认关。关着时只产候选与诊断，**direct 模式一条消息也发不出去**（turn 模式不需要它：'
          + '文案来自人格包）。打开后只有通过全部廉价门控的候选才会调用模型——一次单条短补全'
          + '（无工具、无会话、有超时），且共享下面的预算。',
      }),
      draftDailyBudget: n('草稿日预算', CONTACT_DEFAULTS.draftDailyBudget, {
        hot: 'live', min: 1, max: 500,
        help: '一天最多调用模型起草几次（成功与失败都算，空转不算）。默认 20 是工程建议。',
      }),
      draftHourlyBudget: n('草稿时预算', CONTACT_DEFAULTS.draftHourlyBudget, {
        hot: 'live', min: 1, max: 100,
        help: '每小时突发上限，防止某个事件一次冒出十条候选把当天额度一口气烧完。'
          + '默认 5 是工程建议；这项只在内存里记，重启后从零开始。',
      }),
      draftTimeoutMs: n('草稿超时', CONTACT_DEFAULTS.draftTimeoutMs, {
        hot: 'live', min: 0, max: 300_000, step: 1_000, unit: 'ms',
        help: '单次起草等这么久还没结果就按失败处理（记一次退避，不阻塞 worker 节拍）。'
          + '默认 20 秒是工程建议；0 = 不设超时。',
      }),
      draftMaxChars: n('草稿字数上限', CONTACT_DEFAULTS.draftMaxChars, {
        hot: 'live', min: 10, max: 1_000,
        help: '短消息的硬上限。超了不截断，直接按"这一轮没话可说"处理——'
          + '截断会发出半句话，比不发更难看。默认 120 字是工程建议。',
      }),
      draftFailureBackoffMs: n('失败退避基数', CONTACT_DEFAULTS.draftFailureBackoffMs, {
        hot: 'live', min: 1_000, max: 3_600_000, step: 1_000, unit: 'ms',
        help: '草稿失败后的等待基数，按连续失败次数翻倍（1×、2×、4×、8× 封顶，有界）。'
          + '默认 1 分钟起、最长 8 分钟是工程建议。',
      }),
      draftMaxFailures: n('连续失败上限', CONTACT_DEFAULTS.draftMaxFailures, {
        hot: 'live', min: 1, max: 100,
        help: '连续失败到这个次数就停止起草，直到跨日（计数归零）或人工介入。'
          + '默认 5 是工程建议——模型连续五次不可用，通常不是重试能解决的问题。',
      }),
    },
  },
]
