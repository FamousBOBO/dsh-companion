/** QQ 工具面的装配：把十组工具接起来，注册到宿主的工具表上。
 *
 * 原来这里是一个 1250 行的 `registerQQTools`——57 个工具全是同一个函数的闭包，
 * 于是"改一个工具会不会碰到别的工具"永远要读完整段。拆成 `features/<功能>/tools.ts`
 * 之后，本文件只剩两件事：**跨组共享的两条规则**，以及**把各组接起来**；
 * P6c 起再多一件：**工具闸门（`policy.v2` / `tools.v2`）的两个回调与装/卸控制器**
 * ——同一个问题（"这次调用能不能执行"）；P6d 另加：按开关选面（17 个合并工具）。
 *
 * 两条规则值得单独看：
 *
 *   1. `knownGroupIds()` —— "这个群我能发吗"。原来 `qq_send_text` 只认主群、
 *      `qq_reply_quote` 却认任何 NapCat 能报出来的群：同一个意图从一个工具走通、
 *      从另一个工具抛"目标群不在咱的配置里"。现在两者都问这里。`get_group_list`
 *      是一次 WebSocket 往返，所以答案要缓存——发送路径不该每条消息付一次。
 *      调用失败时保留上一次的好值（冷启动失败则退回主群），因为一次 NapCat 抖动
 *      不该变成"我们忘了自己在哪些群"。
 *   2. `assertDangerousAllowed()` —— 高危群管的总闸门。踢人 / 全员禁言 / 设管理员
 *      原先只靠"模型自觉"，而模型的输入里包含群成员打的每一个字；在有了信任分级
 *      （P6c）之前，唯一安全的默认值是关掉。关掉不影响主人手动操作。
 */

import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import type { EmojiLibrary } from '../../emoji-library.js'
import type { SentLog, SentLogHub } from '../../sent-log.js'
import type { KnowledgeStore } from '../../knowledge.js'
import type { MemorySearch, MemoryService } from '../../ports/memory.js'
import { registerSpecs, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import {
  decideToolCall, policyEnabled,
  type ToolCallFacts,
} from '../../app/policy/tool-policy.js'
import { roomKeyOf, textSentBy, type SendSignatureGuard } from '../../core/guards/output-signatures.js'
import { registerMergedSurface, tierDenyFor, toolsV2Enabled } from '../tools-v2/index.js'
import { SESSION_PREFIX, splitRoom } from '../../core/room.js'
import type { Trust } from '../../core/trust.js'
import type { QQToolDeps } from '../tool-deps.js'
import { messagingTools } from '../messaging/tools.js'
import { lookupTools } from '../lookup/tools.js'
import { groupAdminTools } from '../group-admin/tools.js'
import { groupFilesTools } from '../group-files/tools.js'
import { filesTools } from '../files/tools.js'
import { stickersTools } from '../stickers/tools.js'
import { voiceTools } from '../voice/tools.js'
import { musicTools } from '../music/tools.js'
import { memoryTools } from '../memory/tools.js'
import { affectionTools } from '../affection/tools.js'
import { approvalEnabled } from '../approval/store.js'
import { selfHarmHint, selfHarmReason } from '../../core/approval/self-harm.js'
import { visionTools } from '../vision/tools.js'
import type { HistoryService } from '../history/service.js'

export type { QQToolDeps, AffectionPort } from '../tool-deps.js'

/** 群号缓存的存活时间。发送路径要么命中它，要么付一次 WebSocket 往返。 */
const GROUP_CACHE_MS = 60_000

/** `registerQQTools` 的入参（与拆分前逐字一致，调用方不用改）。 */
export interface RegisterToolsArgs {
  readonly ctx: ToolHost
  readonly config: QQChannelConfig
  readonly api: QQApi
  readonly out: OutboundQueue
  readonly log: (line: string) => void
  readonly library?: EmojiLibrary
  readonly affection?: QQToolDeps['affection']
  readonly sentLog?: SentLog
  readonly sentLogHub?: SentLogHub
  readonly knowledge?: KnowledgeStore
  readonly memory?: MemoryService
  readonly memorySearch?: MemorySearch
  readonly extract?: (source: string, text: string) => Promise<unknown>
  readonly history?: HistoryService
}

/** 建一套工具依赖（跨组共享的两条规则在这里落地）。 */
function toolDeps(args: RegisterToolsArgs): QQToolDeps {
  const { config, api, log } = args
  let groupCache: { at: number; ids: Set<number> } | null = null

  const knownGroups = async (): Promise<Set<number>> => {
    const fallback = new Set<number>(
      [config.primaryGroup].filter((x): x is number => x !== null && x !== undefined),
    )
    if (groupCache !== null && Date.now() - groupCache.at < GROUP_CACHE_MS) return groupCache.ids
    const raw = await api.getGroupList().catch(() => null)
    if (!Array.isArray(raw)) return groupCache?.ids ?? fallback
    const ids = new Set<number>()
    for (const entry of raw) {
      const id = Number((entry as { group_id?: unknown }).group_id)
      if (Number.isFinite(id)) ids.add(id)
    }
    if (ids.size === 0) return groupCache?.ids ?? fallback
    groupCache = { at: Date.now(), ids }
    return ids
  }

  const assertDangerous = (action: string): void => {
    // policy.v2 + 闸门已挂时由 tools/pre-execute 按信任表裁决，这里不重复判；
    // 否则回到 D10 总闸门（fail-closed：接缝缺失时退回旧闸门，而不是放行）。
    if (policyEnabled(config) && isToolGateArmed()) return
    if (config.groupAdmin?.dangerous === true) return
    throw new Error(
      `${action}当前是关闭状态（groupAdmin.dangerous=false）：这类动作会真的影响到群成员，`
      + `而"谁让咱做的"目前无法验证。需要时请学弟在 QQ 里手动操作；`
      + `确实要让咱自己动手，就在后台把 groupAdmin.dangerous 打开。`,
    )
  }

  return {
    api,
    out: args.out,
    config,
    log,
    library: args.library,
    affection: args.affection,
    sentLog: args.sentLog,
    sentLogHub: args.sentLogHub,
    knowledge: args.knowledge,
    memory: args.memory,
    memorySearch: args.memorySearch,
    extract: args.extract,
    history: args.history,
    knownGroups,
    assertDangerous,
  }
}

/**
 * 注册顺序。
 *
 * **为什么要显式写一张表**：工具是按注册顺序出现在模型的系统提示里的，所以顺序属于
 * 提示词内容——换一个顺序就是换一个提示词。拆成功能目录之后，各组自然是连续的，
 * 拼起来与原来的交错顺序不同（原顺序是历史堆积出来的，没有规律）。
 *
 * 所以这里保留原顺序，让 P4 的黄金快照逐字节不变。P6d 之后它仍有用：tools.v2
 * 关着时它就是注册顺序（= 提示词内容）；打开时的顺序见 features/tools-v2 的 MAPPING。
 */
const REGISTRATION_ORDER: readonly string[] = [
  'qq_send_text',
  'qq_reply_quote',
  'qq_send_code_review',
  'qq_set_affection',
  'qq_set_stage',
  'qq_write_dashboard',
  'retrieve_knowledge',
  'extract_knowledge',
  'qq_send_poke',
  'qq_set_group_card',
  'qq_group_ban',
  'qq_get_group_member_info',
  'qq_get_group_info',
  'qq_get_msg',
  'qq_delete_msg',
  'qq_send_emoji',
  'qq_group_kick',
  'qq_group_whole_ban',
  'qq_set_group_admin',
  'qq_get_group_list',
  'qq_get_friend_list',
  'qq_set_essence',
  'qq_delete_essence',
  'qq_get_essence_list',
  'qq_list_group_files',
  'qq_upload_group_file',
  'qq_download_group_file',
  'qq_create_file_folder',
  'qq_move_group_file',
  'qq_rename_group_file',
  'qq_delete_group_file',
  'qq_list_emojis',
  'qq_search_emojis',
  'qq_emoji_stats',
  'qq_search_history',
  'qq_send_voice',
  'qq_can_send_voice',
  'qq_send_ai_voice',
  'qq_get_ai_voice_url',
  'qq_get_file_url',
  'qq_send_private_file',
  'qq_save_private_file',
  'qq_search_music',
  'qq_resolve_music',
  'qq_send_music_card',
  'qq_send_music_voice',
  'qq_music_lyrics',
  'qq_music_playlist',
  'qq_netease_login',
  'qq_netease_status',
  'qq_kugou_search',
  'qq_kugou_send',
  'qq_kugou_login',
  'qq_send_like',
  'qq_recall_memory',
  'qq_memorize_fact',
  'qq_memory_search',
  'qq_send_sticker',
]

/** 全部工具组（注册顺序见 `REGISTRATION_ORDER`）。 */
function allSpecs(deps: QQToolDeps): ToolSpec[] {
  const specs: ToolSpec[] = [
    ...messagingTools(deps),
    ...lookupTools(deps),
    ...groupAdminTools(deps),
    ...groupFilesTools(deps),
    ...filesTools(deps),
    ...stickersTools(deps),
    ...voiceTools(deps),
    ...musicTools(deps),
    ...memoryTools(deps),
    ...affectionTools(deps),
    // B5：默认不注册（关着时工具面与旧版逐字节一致）。
    ...(deps.config.imageRecognition.serverOcr ? visionTools(deps) : []),
  ]
  const rank = new Map(REGISTRATION_ORDER.map((name, index) => [name, index]))
  for (const spec of specs) {
    // 新工具忘了登记顺序：排到最后并留一行日志，而不是静默改变提示词。
    if (!rank.has(spec.name)) deps.log(`qq-tools: ${spec.name} not in REGISTRATION_ORDER; appended`)
  }
  const at = (name: string): number => rank.get(name) ?? Number.MAX_SAFE_INTEGER
  return specs.slice().sort((a, b) => at(a.name) - at(b.name))
}

/**
 * 注册全部 QQ 工具。
 *
 * @returns 注销器。**永不抛错**：某一组注册失败只记一行日志，不让整个工具面消失。
 */
export function registerQQTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
  library?: EmojiLibrary,
  affection?: QQToolDeps['affection'],
  sentLog?: SentLog,
  knowledge?: KnowledgeStore,
  extract?: (source: string, text: string) => Promise<unknown>,
  memory?: MemoryService,
  memorySearch?: MemorySearch,
  sentLogHub?: SentLogHub,
  history?: HistoryService,
): () => void {
  const deps = toolDeps({ ctx, config, api, out, log, library, affection, sentLog, sentLogHub, knowledge, extract, memory, memorySearch, history })
  const specs = allSpecs(deps)
  // tools.v2 打开时换面：旧 spec 全被收编、只上宿主 17 个合并工具。
  if (toolsV2Enabled(config)) return registerMergedSurface({ ctx, specs, log })
  return registerSpecs(ctx, specs, log, 'qq-tools')
}

import { isToolGateArmed } from './gate.js'
export { createToolGateHooks, setToolGateArmed, isToolGateArmed, ToolGateController, type ToolGateCall, type ToolGateDecision, type ToolGateHooks, type ToolGateDeps } from './gate.js'
