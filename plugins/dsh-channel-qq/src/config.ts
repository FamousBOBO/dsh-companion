import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import type { MemoryExtractorConfig, MemoryInjectV3Config, MemoryVectorConfig } from './config/sections/memory.js'
import type { PresenceConfig } from './config/sections/presence.js'
import type { SwitchSections } from './config/sections/switches.js'
import type {
  BatchingConfig,
  ConnectionConfig,
  GroupModelConfig,
  InjectModeConfig,
  SegmentationConfig,
  STTConfig,
} from './config/sections/chat.js'

export interface EmojiConfig {
  /** Steal sticker images seen in the primary group into `dir`. */
  steal: boolean
  /** Also steal stickers from admin DMs — the only route when groups are off. */
  stealPrivate: boolean
  // `autoSend` / `autoSendProbability` were here: "after a reply, attach a random
  // registered sticker". Nothing ever read them — the plumbing was never written
  // — yet the admin panel rendered both as working switches. Removed so the panel
  // stops promising behaviour the plugin does not have. Stickers are sent when
  // the model asks, via `qq_send_sticker` / `qq_emoji_send`.
  /** Stolen/raw sticker directory (defaults to <dshHome>/channel-qq/emoji). */
  dir: string | null
  /** Registered sticker directory (defaults to <dshHome>/channel-qq/emoji-registered). */
  registeredDir: string | null
}

export interface KeywordReaction {
  keywords: string[]
  reaction: string
}

/** The 06:00 daily briefing. Every input is optional so a fresh deployment
 * never inherits another host's city or timetable file. */
export interface MorningReportConfig {
  enabled: boolean
  /** A wttr.in location string (e.g. `Lianjiang,Guangdong`), or null to skip weather. */
  weatherLocation: string | null
  /** Workspace-relative file holding the timetable text, or null to skip it. */
  scheduleFile: string | null
}

/** A periodic workspace script the scheduler runs and reports on. */
export interface CruiseTaskConfig {
  /** Stable id used for the once-per-interval bookkeeping. */
  id: string
  enabled: boolean
  /** Script path relative to the workspace. */
  script: string
  intervalMin: number
}

/** Admin/config UI: a password-gated HTTP panel. */
export interface AdminConfig {
  enabled: boolean
  /** Listen port. */
  port: number
  /**
   * Panel password.
   *
   * **Empty by default on purpose.** A shipped literal password is a published
   * credential — this panel can run workspace scripts and rewrite `AGENTS.md`,
   * so a default that is the same on every deployment is equivalent to no auth
   * at all. Prefer the environment (`CHANNEL_QQ_ADMIN_PASSWORD`, see
   * `admin.ts`); this field stays as the operator's own fallback for hosts that
   * have no env file. An empty password cannot log in (fail-closed) and forces
   * the listener onto loopback.
   */
  password: string
  /**
   * Bind address. **Only honoured when `CHANNEL_QQ_ADMIN_ALLOW_REMOTE=1`.**
   * The panel is a remote-control surface for the bot, so the default is
   * loopback + SSH tunnel; a persisted override must not be able to re-expose
   * it silently.
   */
  host: string
}

/** 高危群管动作（踢人 / 全员禁言 / 设管理员）的总开关。 */
export interface GroupAdminConfig {
  /**
   * Whether the destructive group-management tools may act.
   *
   * Default **false**. Those three tools take a target straight from the model,
   * and the model's input includes anything a group member types — so before
   * there is a trust tier (P6c), the only safe setting is off. 主人 can still
   * kick/mute by hand in the QQ client; nothing here removes that.
   */
  dangerous: boolean
}

/** Link card resolution (B站 / 网易云 / GitHub / 通用网页). */
export interface LinkResolveConfig {
  enabled: boolean
  /** Groups that get automatic link cards; empty = tools only, never automatic. */
  autoGroups: number[]
  /** Max links resolved per inbound message. */
  maxPerMessage: number
  /** Optional bilibili SESSDATA for higher rate limits and HD covers. */
  bilibiliCookie: string | null
}

/** Sticker meme maker (ffmpeg drawtext). */
export interface MemeConfig {
  enabled: boolean
  /** TTF/OTF used by drawtext; null = auto-detect an installed CJK font. */
  fontFile: string | null
  /** Output directory; null = <workspace>/downloads/memes. */
  dir: string | null
}

/** 群语录库. */
export interface QuoteConfig {
  enabled: boolean
  /** Storage directory; null = <workspace>/quotes. */
  dir: string | null
  /** Auto-capture messages that look like keepers. */
  autoCapture: boolean
}

/** edge-tts voice replies (free, no key, CPU-only). */
export interface TtsConfig {
  enabled: boolean
  /** edge-tts voice name, e.g. zh-CN-XiaoxiaoNeural. */
  voice: string
  /**
   * Which backend actually speaks.
   *
   * `auto` is the default because edge-tts is the best voice but its WebSocket
   * handshake is refused (HTTP 403) from most datacenter IPs, while the free
   * HTTP endpoints keep working there. `auto` tries edge first and falls back,
   * so a fresh deployment is never left with a TTS feature that silently cannot
   * produce audio.
   */
  provider: 'auto' | 'edge' | 'baidu' | 'google'
  /** edge-tts prosody knobs: rate/pitch/volume like "+10%", "-5Hz". */
  rate: string
  pitch: string
  volume: string
  /** Output directory; null = <dshHome>/channel-qq/tts. */
  dir: string | null
}

/** Natural-language reminders ("明天9点叫我"). */
export interface ReminderConfig {
  enabled: boolean
  /** Storage file; null = <workspace>/reminders.json. */
  file: string | null
  /** 允许投递的房间；空 = 不限制。投递前还会再判一次开关与按群策略（P1-02）。 */
  allowedRooms?: readonly number[] | null
  /**
   * 演练模式（P2.5-3A-3，**默认 true**）：提醒照常到点、照常过共享闸门，
   * 但**不真发**、不记账、不写 `occurrence-dispatched`。灰度起步用。
   */
  dryRun?: boolean
}

/** One RSS/Atom feed bound to a room. */
export interface RssFeedConfig {
  id: string
  url: string
  /** Where new items go. */
  room: 'group' | 'dm'
  target: number
  enabled: boolean
  /** Last seen item guid; written back by the poller. */
  lastGuid: string | null
  title: string
}

export interface RssConfig {
  enabled: boolean
  pollIntervalMin: number
  /** Max items pushed per feed per poll. */
  maxPerPoll: number
  feeds: RssFeedConfig[]
}

/** 防刷屏风控. */
export interface FloodConfig {
  enabled: boolean
  windowSec: number
  maxMessages: number
  /** warn = 只在群里提醒; mute = 禁言; both = 提醒 + 禁言. */
  action: 'warn' | 'mute' | 'both'
  muteSeconds: number
  /** QQ numbers exempt from flood control (admins are always exempt). */
  exempt: number[]
}

/** 群内 AI 生图. */
export interface ImageGenConfig {
  enabled: boolean
  /** pollinations = 免 key 公开端点; openai = 任意 OpenAI 兼容 /images/generations. */
  provider: 'pollinations' | 'openai'
  baseUrl: string | null
  apiKey: string | null
  model: string
  width: number
  height: number
}

/** 群聊学习/口癖. */
export interface LearnConfig {
  enabled: boolean
  /** 黑话词典：注册 qq_learn_word / qq_slang 两个工具。 */
  slang: boolean
  /** Learned-phrase store; null = <workspace>/learned-phrases.json. */
  file: string | null
  /** Passively collect candidate phrases from group traffic. */
  autoCapture: boolean
  /** Minimum occurrences before a phrase is offered to the model. */
  minOccurrences: number
}

/** 新记忆系统（P6e）：结构化记忆的检索、注入预算与向量检索参数（向量五项见 MemoryVectorConfig，字段说明在其本体处）。 */
export interface MemoryConfig extends MemoryVectorConfig, MemoryExtractorConfig, MemoryInjectV3Config {
  /** 关着时走旧的关键词知识库（entries.json）；打开后每回合注入结构化记忆证据。 */
  v2: boolean
  /** 检索分数阈值：低于它的证据不进注入包。 */
  threshold: number
  /** 每回合最多注入几条证据。 */
  maxRecords: number
  /** 每回合最多注入多少字。 */
  maxChars: number
  /** 每回合附带当前发言人的人物侧写（3–5 行，5 分钟缓存）。 */
  profiles: boolean
}

/** 群事件监控 → 主动性话题素材. */
export interface EventMonitorConfig {
  enabled: boolean
  /** Which notice subtypes are fed to the agent. */
  kinds: string[]
  /** Coalesce window so a burst of events yields one adjudication. */
  windowSec: number
}

/** 上下文预算 (P2-2): step budget + context compaction. */
export interface ContextBudgetConfig {
  /** Max agent steps per turn; 0 = harness default. */
  maxSteps: number
  /** Compact the injected packet when it exceeds this many characters; 0 = off. */
  compactChars: number
}

/** 上下文 v2（P6b）：不可信信封 + 待回块；打开 = "指令层 + 信封 + 当前消息"结构 + AGENTS.md 受管区，关着时每包与旧行为逐字节一致。 */
export interface ContextV2Config {
  v2: boolean
  agentInstructions?: boolean
}

/** 回合预算（P6b）：步数上限按会话类型分档；0 = 沿用 contextBudget.maxSteps。system 档为事件书 P6f 预留（当前无会话类型映射到它）。 */
export interface TurnConfig {
  maxSteps: { dm: number; group: number; system: number }
}
// 三个开关型段（policy / tools / proactive）的形状在本体处，见 switches.ts 的注记。
export interface QQChannelConfig extends SwitchSections {
  connection: ConnectionConfig
  accessToken?: string
  /** The bot's own QQ number, from NapCat lifecycle events or configured explicitly. */
  selfId: number
  /** QQ numbers allowed to use admin-flavoured tools. */
  admins: number[]
  /** Loopback port of the master-only affection dashboard; 0 disables. */
  affectionPort: number
  /** Master switch for group-chat handling (DMs unaffected). */
  groupEnabled: boolean
  /** The core group; talkValue/emoji/steal semantics key off it. */
  primaryGroup: number | null
  requireMention: boolean
  /** Base reply probability in groups; the primary group may override via primaryTalkValue. */
  talkValue: number
  primaryTalkValue?: number
  /** Workspace the QQ agents run in (main knowledge workspace). */
  workspacePath: string | null
  agentPreset: string
  permissionPreset: string
  groupAgentPreset?: string | null
  groupPermissionPreset?: string | null
  groupWorkspacePath?: string | null
  rateLimitMs: number
  maxMessageLength: number
  segmentation: SegmentationConfig
  channelHealth: import('./config/sections/chat.js').ChannelHealthConfig
  batching: BatchingConfig
  injectMode: InjectModeConfig
  imageRecognition: import('./config/sections/image.js').ImageConfig
  poke: import('./config/sections/poke.js').PokeConfig
  interaction: import('./config/sections/interaction.js').InteractionConfig
  forward: import('./config/sections/forward.js').ForwardConfig
  metrics: import('./config/sections/metrics.js').MetricsConfig
  history: import('./config/sections/history.js').HistoryConfig
  reliability: import('./config/sections/reliability.js').ReliabilityConfig
  dailyReport: import('./config/sections/daily-report.js').DailyReportConfig
  access: import('./config/sections/access.js').AccessConfig
  stt: STTConfig
  groupModel: GroupModelConfig
  /** Additional group-level or user-level name triggers. */
  keywordTriggers: string[]
  keywordReactions: KeywordReaction[]
  morningReport: MorningReportConfig
  /** Periodic workspace scripts; empty by default so a bare deployment stays quiet. */
  cruises: CruiseTaskConfig[]
  emoji: EmojiConfig
  admin: AdminConfig
  linkResolve: LinkResolveConfig
  meme: MemeConfig
  quotes: QuoteConfig
  tts: TtsConfig
  reminders: ReminderConfig
  rss: RssConfig
  flood: FloodConfig
  imageGen: ImageGenConfig
  learn: LearnConfig
  memory: MemoryConfig
  people: import('./config/sections/memory.js').PeopleConfig
  chatlog: import('./config/sections/content.js').ChatLogConfig
  music: import('./config/sections/music.js').MusicConfig
  skills: import('./config/sections/skills.js').SkillsConfig
  sessionReset: import('./config/sections/session-reset.js').SessionResetConfig
  kb: import('./config/sections/kb.js').KbConfig
  eventMonitor: EventMonitorConfig
  contextBudget: ContextBudgetConfig
  context: ContextV2Config
  turn: TurnConfig
  /** 群聊旁听与自主接话（默认关；关着时入站路径与旧行为逐字节一致）。 */
  readonly presence: PresenceConfig
  /** 群成员身份注册表（P9-G4 §2.2，默认关；关着时所有人按"身份未确认"处理）。 */
  readonly participants: import('./config/sections/participants.js').ParticipantsConfig
  /** 点歌翻唱（B站 → RVC 音色 → 语音条）：外部程序路径、时间预算与两道外发闸（默认全关）。 */
  readonly song: import('./config/sections/song.js').SongConfig
  groupAdmin: GroupAdminConfig
  debug: boolean
}

export { DEFAULT_CONFIG, resolveConfig } from './config/resolve.js'
// schema 的入口也从这里出：别处只会 `import { ... } from './config.js'`，
// 不需要知道它在 `config/` 目录下的哪个文件里。
export { SCHEMA, groupOf, sectionIds, type FieldSpec } from './config/schema.js'
// 连接 / 分段 / 攒批 / 实时注入 / 转写 / 群聊模型的类型住在 `config/sections/chat.ts`
// （与它们的字段定义挨着，省得 `config.ts` 撞 400 行硬上限）；这里照旧 re-export，
// 别处 `from './config.js'` 的写法一个字都不用改。
export type {
  BatchingConfig, ConnectionConfig, GroupModelConfig,
  InjectModeConfig, SegmentationConfig, STTConfig,
} from './config/sections/chat.js'

/** Where the admin panel persists its overrides. */
export function adminOverridePath(dshHome: string): string {
  return path.join(dshHome, 'channel-qq', 'admin-config.json')
}

/**
 * Read the admin panel's persisted override layer.
 *
 * Synchronous on purpose: it runs once during plugin init, before the channel
 * starts, and a partial/ corrupt file must never take the boot down — an
 * unreadable override degrades to "no override", never to a crash.
 */
export function loadAdminOverride(dshHome: string): Partial<QQChannelConfig> {
  try {
    const raw = readFileSync(adminOverridePath(dshHome), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Partial<QQChannelConfig>
  } catch {
    return {}
  }
}
