/** 子插件的装载表（P5.1）：顺序 = 装配顺序 = 工具注册顺序 = start 顺序。
 *
 * 这张表的顺序同时被三件事钉住，别随手调：
 *   - **工具面顺序**：qq-tools 之后按 links → meme → voice → quotes →
 *     reminders → rss → imagegen → flood → learn 注册——那是模型看到的工具
 *     清单顺序（提示词内容），golden 快照钉着它；
 *   - **start 顺序**：platform（连 QQ）→ inbound（重挂历史会话）→ proactive
 *     （调度器）→ admin（开面板），与原 `Service.init` 的后半段一一对应；
 *   - **服务依赖**：前面的插件 `provide`，后面的 `requires` 取（persona 最先；
 *     qq-tools 要 platform / emoji / affection / sentLog / knowledge 五件套，
 *     分别在 platform / stickers / affection / inbound / memory 里提供）。
 *
 * 热重载声明（watches）与旧 `applyEffects` 的副作用清单一一对应，见
 * `test/subplugins.test.ts` 的表锁。
 */

import { adminPlugin } from './features/admin/index.js'
import { affectionPlugin } from './features/affection/index.js'
import { contactPlugin } from './features/contact/index.js'
import { floodPlugin } from './features/flood/index.js'
import { imagegenPlugin } from './features/imagegen/index.js'
import { inboundPlugin } from './features/inbound/index.js'
import { interactionPlugin } from './features/interaction/index.js'
import { metricsPlugin } from './features/metrics/index.js'
import { historyPlugin } from './features/history/index.js'
import { reliabilityPlugin } from './features/reliability/index.js'
import { dailyReportPlugin } from './features/daily-report/index.js'
import { accessPlugin } from './features/access/index.js'
import { channelHealthPlugin } from './features/channel-health/index.js'
import { peoplePlugin } from './features/people/index.js'
import { chatlogPlugin } from './features/chatlog/index.js'
import { socialPlugin } from './features/social/index.js'
import { capabilitiesPlugin } from './features/capabilities/index.js'
import { learnPlugin } from './features/learn/index.js'
import { linksPlugin } from './features/links/index.js'
import { memePlugin } from './features/meme/index.js'
import { memoryPlugin } from './features/memory/index.js'
import { musicPlugin } from './features/music/index.js'
import { observersPlugin } from './features/observers/index.js'
import { personaPlugin } from './features/persona/index.js'
import { platformPlugin } from './features/platform/index.js'
import { proactivePlugin } from './features/proactive/index.js'
import { qqToolsPlugin } from './features/qq-tools/index.js'
import { quotesPlugin } from './features/quotes/index.js'
import { remindersPlugin } from './features/reminders/index.js'
import { rssPlugin } from './features/rss/index.js'
import { skillsPlugin } from './features/skills/index.js'
import { kbPlugin } from './features/kb/index.js'
import { sessionResetPlugin } from './features/session-reset/index.js'
import { stickersPlugin } from './features/stickers/index.js'
import { voicePlugin } from './features/voice/index.js'
import { songPlugin } from './features/song/index.js'
import type { SubPlugin } from './features/plugin-kit.js'

export const SECTION_PLUGINS: readonly SubPlugin[] = [
  personaPlugin,
  observersPlugin,
  platformPlugin,
  channelHealthPlugin,
  accessPlugin,
  interactionPlugin,
  metricsPlugin,
  historyPlugin,
  reliabilityPlugin,
  dailyReportPlugin,
  inboundPlugin,
  sessionResetPlugin,
  stickersPlugin,
  memoryPlugin,
  affectionPlugin,
  qqToolsPlugin,
  peoplePlugin,
  socialPlugin,
  capabilitiesPlugin,
  chatlogPlugin,
  linksPlugin,
  memePlugin,
  voicePlugin,
  quotesPlugin,
  remindersPlugin,
  rssPlugin,
  imagegenPlugin,
  floodPlugin,
  learnPlugin,
  musicPlugin,
  // 点歌翻唱：工具面紧挨着「音乐」那一段（同一件事的两种形态：报歌名点歌 / 做成语音条），
  // 但它要 `platform`（出站队列）才能发语音条，所以排在 platform 之后。
  // 它**不起定时器**：`autoPickOnce()` 只由计划/后台显式调用（见 `features/song/auto.ts`）。
  songPlugin,
  skillsPlugin,
  kbPlugin,
  proactivePlugin,
  // 主动消息（contact）排在事件书之后：它要 dshHome、inbound（回合发起）与 platform
  // （出站队列），三样都在它之前；它的 scheduler 由 start 钩子起，在 inbound 重挂之后。
  contactPlugin,
  adminPlugin,
]
