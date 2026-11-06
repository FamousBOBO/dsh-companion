/** 连接与群聊行为段（page: connection / groups / messages / media / events）。
 *
 * 注释里的"读法"是 `hot` 标注的依据：live = 消费方握着 config 引用每次现取；
 * reload = 注册时取值但保存有热重载处理；restart = 捕获一次（或决定会话组合）。
 */

import { b, e, json, n, s, type FieldGroup } from '../dsl.js'
import { INTERACTION_GROUPS } from './interaction.js'
import { POKE_GROUPS } from './poke.js'
import { FORWARD_GROUPS } from './forward.js'
import { METRICS_GROUPS } from './metrics.js'
import { HISTORY_GROUPS } from './history.js'
import { RELIABILITY_GROUPS } from './reliability.js'
import { DAILY_REPORT_GROUPS } from './daily-report.js'
import { ACCESS_GROUPS } from './access.js'
import { IMAGE_GROUPS } from './image.js'

// ── 连接 / 分段 / 攒批 / 实时注入 / 语音转写 / 群聊模型 ─────────────────────────
//
// 这六段的**类型**从 `config.ts` 搬到这里，与下面 `CHAT_GROUPS` 里各自的字段挨着：
// `config.ts` 有 400 行硬上限（`scripts/check-size.mjs`），而这些注记（"为什么是这个
// 默认值""这个字段以前骗过人""停顿按什么计时"）必须留在类型本体旁边——搬走可以，
// 删掉不行。`config.ts` 仍然 re-export 这些名字，别处 `from './config.js'` 的写法不变。

/** Channel configuration. One row, one account. Values live in the profile's user patch layer. */
export interface ConnectionConfig {
  /** forward = the plugin dials NapCat's WS server; reverse = the plugin hosts a WS server NapCat dials into. */
  mode: 'forward' | 'reverse'
  /** forward: NapCat WS URL. reverse: listen URL, e.g. ws://127.0.0.1:8082 (port is the bind port). */
  url: string
}
export interface SegmentationConfig {
  enabled: boolean
  /** natural = 跟句号走; conservative = 太短的相邻句合并; active = 每句一条. */
  style: 'natural' | 'conservative' | 'active'
  /**
   * Sentences shorter than this are "tiny" for the `conservative` style, which
   * glues tiny neighbours into one message (`natural`/`active` ignore it).
   *
   * The field used to claim it gated ender-less texts, which the code never did
   * (an ender-less body is returned as one segment regardless), while the one
   * real threshold — the merge in `outbound.segmentReply` — was a hardcoded `8`.
   */
  minLength: number
  maxSegments: number
  removeTrailingPeriod: boolean
  /**
   * 分段之间的停顿（本地补丁 COMPANION-QQ-PATCH-5）：按**刚发出去那句**的字数计时，
   * 句子越长停得越久，像人打完一句长话再接着打下一句。0 = 不额外等待
   * （只剩 `rateLimitMs` 那条全局限速）。
   */
  delayPerCharMs: number
  /** 停顿下限（毫秒）。 */
  delayMinMs: number
  /** 停顿上限（毫秒），防止超长句把回合拖住。 */
  delayMaxMs: number
  /** Group replies stay in one message and use this separate length cap. */
  groupMaxChars?: number
}
export interface GroupModelConfig {
  /** Group conversations run on this route; null = same as the default route. */
  provider: string | null
  model: string | null
}
export interface STTConfig {
  enabled: boolean
  /** 本地 Whisper 不可用时，改用协议端的语音转文字。 */
  serverFallback: boolean
  /** OpenAI-compatible /audio/transcriptions base, e.g. https://host/v1 */
  baseUrl: string | null
  /** API key (plain, or $ENV to read from environment). */
  apiKey: string | null
  model: string
}
export interface BatchingConfig {
  dmEnabled?: boolean
  dmShortMs?: number
  dmLongMs?: number
  dmLongChars?: number
  dmMaxWaitMs?: number
  /** Quiet-window: analyze the intake queue this long after the last message. */
  windowMs: number
  /** Flush early once this many lines accumulated. */
  maxMessages: number
  /** Flush early once this many characters accumulated. */
  maxChars: number
}
export interface InjectModeConfig {
  /** Bypass batching: every group message is injected into the agent context as it arrives. */
  enabled: boolean
  /**
   * 本地补丁 COMPANION-QQ-PATCH-6 的开关：回合**正在跑**时收到的新消息，直接作为
   * 「引导」注入当前回合，而不是攒到下一轮（这就是"中途插话"）。
   *
   * 与 `enabled` 分开：`enabled` 是"所有消息都改走注入"，会绕过攒批；这个只在
   * 回合进行中生效，空闲时仍按攒批走。默认 false = 上游行为。
   */
  duringTurn: boolean
  /** When the agent is idle, deliver immediately and wake it (steer) instead of parking it (inject). */
  wakeIdle: boolean
}

/** 渠道健康告警：消息链路失联超过阈值时私聊管理员（默认关）。 */
export interface ChannelHealthConfig {
  enabled: boolean
  /** 失联多久开始告警（毫秒）。 */
  thresholdMs: number
  /** 同一场故障内的重复告警间隔（毫秒）。 */
  realertMs: number
}

export const CHAT_GROUPS: FieldGroup[] = [
  {
    id: 'connection',
    label: '连接',
    page: 'connection',
    help: 'NapCat 的 WebSocket 连接方式。改完会重连，不需要重启进程。'
      + '**地址留空 = 未配置**：插件照常加载，但不拨号、不监听端口、不重连。',
    fields: {
      // 读法：applyEffects 里 connection/accessToken 变化会就地 reconnect（reload）。
      mode: e('连接方向', 'forward', [
        ['forward', '插件拨号（forward）'],
        ['reverse', '插件监听（reverse）'],
      ], { hot: 'reload' }),
      // 默认空串 = 未配置。出厂就给一个 localhost 地址意味着"新装的插件立刻开始
      // 对着一个不存在的端口重连"，那不是默认值，那是故障预演。
      url: s('地址', '', {
        hot: 'reload',
        help: 'forward = NapCat 的 WS 地址（例如 ws://127.0.0.1:3001）；'
          + 'reverse = 本插件要监听的地址（端口即监听端口）。留空 = 未配置，不发起任何连接。',
      }),
    },
  },
  {
    id: 'channelHealth',
    label: '渠道健康告警',
    page: 'connection',
    fields: {
      // 读法：插件挂载时启动守望循环；改配置会重挂（watches channelHealth）。
      enabled: b('启用', false, { hot: 'live', help: '默认关。打开后消息链路失联超过阈值会私聊管理员，恢复后再报，同场故障限频。' }),
      thresholdMs: n('失联阈值（毫秒）', 90_000, { min: 10_000, max: 600_000, hot: 'live', unit: 'ms' }),
      realertMs: n('重复告警间隔（毫秒）', 30 * 60_000, { min: 60_000, max: 3_600_000, hot: 'live', unit: 'ms' }),
    },
  },
  {
    id: 'segmentation',
    label: '分段发送',
    page: 'messages',
    help: '把一条长回复拆成几条发出去，像人连着说话而不是一大段。',
    fields: {
      // 读法：P6h 起由 `qq_send_text` 消费（`core/text/segment.ts`）。
      // 私聊默认按句拆分，群聊始终保持一条回复。
      enabled: b('启用', true, { hot: 'live' }),
      style: e('风格', 'active', [
        ['natural', '跟标点走'],
        ['conservative', '太短的相邻句合并'],
        ['active', '每句一条'],
      ], { hot: 'live' }),
      minLength: n('合并阈值（字数）', 8, {
        help: '只有 conservative 风格会用它：短于这个字数的相邻句子会被粘起来。',
        min: 0, max: 200, hot: 'live',
        hiddenIf: { field: 'segmentation.style', notEquals: 'conservative' },
      }),
      maxSegments: n('最多几条', 8, { min: 1, max: 50, hot: 'live' }),
      removeTrailingPeriod: b('去掉句末的句号', true, { hot: 'live' }),
      // 本地补丁 COMPANION-QQ-PATCH-5：分段之间的停顿。默认值按"中文手打 ~60ms/字"
      // 取：一句 10 字停 600ms，长句最多停 3 秒；0 则退回只有 rateLimitMs 的旧行为。
      delayPerCharMs: n('分段间隔（毫秒/字）', 60, {
        min: 0, max: 500, hot: 'live', unit: 'ms',
        help: '两句之间按刚发出去那句的字数等一会儿：句子越长停得越久，像人接着打字。0 = 不额外等待。',
      }),
      delayMinMs: n('分段间隔下限', 200, { min: 0, max: 10_000, hot: 'live', unit: 'ms' }),
      delayMaxMs: n('分段间隔上限', 3000, { min: 0, max: 60_000, hot: 'live', unit: 'ms' }),
      groupMaxChars: n('群聊单条字数上限', 120, { min:20, max:4000, hot:'live' }),
    },
  },
  {
    id: 'batching',
    label: '攒批',
    page: 'messages',
    help: '群消息不逐条处理：安静这么久之后（或攒够条数/字数）一起交给模型。',
    fields: {
      // 读法：入站流水线每包经 config() 现取（live）。
      windowMs: n('安静窗口（毫秒）', 20_000, { min: 0, max: 300_000, step: 1000, hot: 'live' }),
      maxMessages: n('条数上限', 20, { min: 1, max: 200, hot: 'live' }),
      maxChars: n('字数上限', 4000, { min: 100, max: 20_000, hot: 'live' }),
      dmEnabled: b('私聊接话缓冲', false, { hot: 'live' }),
      dmShortMs: n('私聊短句等待（毫秒）', 6000, { min: 0, max: 30000, hot: 'live' }),
      dmLongMs: n('私聊长句等待（毫秒）', 1500, { min: 0, max: 30000, hot: 'live' }),
      dmLongChars: n('私聊长句字数', 80, { min: 1, max: 2000, hot: 'live' }),
      dmMaxWaitMs: n('私聊最长合并等待（毫秒）', 15000, { min: 1000, max: 60000, hot: 'live' }),
    },
  },
  {
    id: 'injectMode',
    label: '实时注入',
    page: 'messages',
    help: '绕过攒批：消息一到就注入 agent 上下文（像群聊里"她一直在看"）。',
    fields: {
      enabled: b('启用', false, { hot: 'live' }),
      duringTurn: b('回合中插话作为引导', false, {
        hot: 'live',
        help: '她正在回话（含分段发送的停顿）时你又发消息：这句话会作为引导塞进当前回合，而不是等这一轮结束再单开一轮。',
      }),
      wakeIdle: b('空闲时直接唤醒', true, { help: '关掉则只在正在跑的轮次里注入，不主动打断。', hot: 'live' }),
    },
  },
  ...IMAGE_GROUPS,
  ...POKE_GROUPS,
  ...INTERACTION_GROUPS,
  ...FORWARD_GROUPS,
  ...METRICS_GROUPS,
  ...HISTORY_GROUPS,
  ...RELIABILITY_GROUPS,
  ...DAILY_REPORT_GROUPS,
  ...ACCESS_GROUPS,
  {
    id: 'stt',
    label: '语音转文字',
    page: 'media',
    fields: {
      // 读法：转写时整个 `config.stt` 子对象按引用传入（live）。
      enabled: b('启用', true, { hot: 'live' }),
      serverFallback: b('本地失败时用协议端转写', false, {
        hot: 'live',
        help: '默认关。打开后本地 STT 没配或转写失败，会调用协议端的语音转文字（SnowLuma fetch_ptt_text）。',
      }),
      baseUrl: s('接口地址', null, { help: 'OpenAI 兼容的 /audio/transcriptions，例如本机 whisper。', hot: 'live' }),
      apiKey: s('接口密钥', null, { secret: true, hot: 'live' }),
      model: s('模型名', 'whisper-1', { hot: 'live', advanced: true }),
    },
  },
  {
    id: 'groupModel',
    label: '群聊模型',
    page: 'groups',
    fields: {
      // 读法：会话登记表 ensure 时经 config() 现取（live）。
      provider: s('供应商', null, { help: '留空表示与默认路由相同。', hot: 'live' }),
      model: s('模型', null, { hot: 'live', advanced: true }),
    },
  },
  {
    id: 'context',
    label: '上下文',
    page: 'messages',
    help: 'P6b：每包改成"指令层 + 不可信信封 + 当前消息"结构。',
    fields: {
      // 读法：组包器每包现取（live）；inbound 子插件 watches 它——翻开关时同步
      // 工作区 AGENTS.md 的指令受管区（组包行为本身无需重挂）。
      v2: b('上下文 v2', false, {
        hot: 'live',
        help: '打开后：包尾的行为约定移进工作区 AGENTS.md 的受管区，来自 QQ 的内容包进 <untrusted> 信封，当前消息单独成块。默认关 = 与旧行为逐字节一致。',
      }),
      agentInstructions: b('由智能体提供通道指令', false, {
        hot: 'reload', help: '智能体预设已经提供 QQ 指令和运行信息时启用；不再写入共享 AGENTS.md 或在用户消息前追加运行说明。',
      }),
    },
  },
  {
    id: 'turn',
    label: '回合',
    page: 'messages',
    fields: {
      // 读法：会话登记表的 stepBudget 取值函数每个步边界现取（live）。
      maxSteps: json('每轮步数上限（按会话类型）', { dm: 0, group: 0, system: 0 }, {
        hot: 'live',
        help: 'dm / group / system 三档；0 = 沿用「上下文预算」里的旧值。system 档预留给系统回合（事件书 P6f），当前没有会话类型映射到它。',
      }),
    },
  },
  {
    id: 'planner',
    label: '群聊准入（要不要说话）',
    page: 'groups',
    help: 'P6g：在消息进 agent 之前先判一次"这条需不需要她开口"，只有够格的才进。',
    fields: {
      // 读法：入站流水线每条群消息现取（live）。
      enabled: b('群聊准入判定', false, {
        hot: 'live',
        help: '打开后：来自别的机器人、以及只有表情/图片没正文的消息不再进 agent（她不会为这些开口）；'
          + '被叫到的、以及其余够格的消息行为不变。每一条被挡下的都会在日志里写清理由。默认关 = 与旧行为逐字节一致。',
      }),
    },
  },
]
