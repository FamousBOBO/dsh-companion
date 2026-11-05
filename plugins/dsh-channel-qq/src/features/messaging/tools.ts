/** 消息发送与撤回：6 个工具。
 *
 * 发送 / 引用回复 / 撤回 / 戳一戳 / 点赞。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import { looksLikeCode } from '../../core/guards/code.js'
import { isInnerMonologueLeak } from '../../core/guards/monologue.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import { smartSplitMessage } from '../../outbound.js'
import { segmentText } from '../../core/text/segment.js'
import type { QQToolDeps } from '../tool-deps.js'
import { dmRoom, groupRoom } from '../../core/room.js'
import { assertGroupTextAllowed, assertTargetAllowed, assertWindowReachable } from './gates.js'

/**
 * 本地补丁 COMPANION-QQ-PATCH-5：两条分段消息之间的停顿。
 *
 * 停顿按**刚发出去那句**的字数计时——长句说得久、停得久；短句几乎立刻接上。
 * 这就是聊天里"一条一条冒出来"的节奏，而不是同一秒刷出三条。上限由
 * `segmentation.delayMaxMs` 兜住，避免一句超长文本把回合拖到看门狗超时。
 * `delayPerCharMs <= 0` 时完全不等待（等价于上游只有 `rateLimitMs` 的行为）。
 */
async function pauseBetweenSegments(
  piece: string,
  index: number,
  total: number,
  segmentation: { delayPerCharMs: number; delayMinMs: number; delayMaxMs: number },
): Promise<void> {
  if (index >= total - 1) return
  const perChar = Number(segmentation.delayPerCharMs) || 0
  if (perChar <= 0) return
  const chars = [...piece].length
  const raw = chars * perChar
  const min = Math.max(0, Number(segmentation.delayMinMs) || 0)
  const max = Math.max(min, Number(segmentation.delayMaxMs) || 0)
  const ms = Math.min(max, Math.max(min, raw))
  if (ms <= 0) return
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * 记一条"咱发过的话"。
 *
 * OneBotClient.call() 成功时给的是 data 本身（见 B13）：这里读 `.data.message_id`
 * 曾经多读了一层，于是 sent-log 的 messageId 全为 null。这条注释跟着这段代码走。
 */
/**
 * 取这个房间的 sent-log。
 *
 * 从前这里拿的是**主群那一份**单例：于是私聊的发言被记进 `sent-group-<主群>.json`，
 * 私聊的引用链也就从未存在过（2026-10-18 审计实证）。现在按房间取，缺 hub 时才退回。
 */
async function sentLogFor(deps: QQToolDeps, isGroup: boolean, target: number): Promise<QQToolDeps['sentLog']> {
  const room = isGroup ? groupRoom(target) : dmRoom(target)
  if (deps.sentLogHub !== undefined) return await deps.sentLogHub.for(room)
  return deps.sentLog
}

async function recordSent(
  sentLog: QQToolDeps['sentLog'],
  result: unknown,
  text: string,
): Promise<void> {
  if (!sentLog) return
  const mid = (result as { message_id?: number } | null)?.message_id ?? null
  await sentLog.add({ messageId: typeof mid === 'number' ? mid : null, quotedId: null, text, time: Date.now() })
}


/**
 * A3：长回复改合并转发。
 *
 * 返回 null = 不走转发（开关关着 / 条数不够 / 超过 maxNodes / 有单条超长 / 转发失败），
 * 调用方据此回退逐条发送——**不能因为一张卡片丢掉内容**。
 */
async function tryForward(
  deps: QQToolDeps,
  isGroup: boolean,
  target: number,
  pieces: readonly string[],
): Promise<Record<string, unknown> | null> {
  const config = deps.config.forward
  if (config.longReplyThreshold <= 0) return null
  if (pieces.length < 2 || pieces.length < config.longReplyThreshold) return null
  if (pieces.length > config.maxNodes) return null
  if (pieces.some((piece) => piece.length > deps.config.maxMessageLength)) return null
  // 节点上要显示发送者昵称；取不到就用「我」，不让整次发送因此失败。
  const info = await deps.api.getLoginInfo().catch(() => null)
  const nickname = info?.nickname === undefined || info.nickname === '' ? '我' : info.nickname
  const nodes = pieces.map((piece) => ({
    type: 'node' as const,
    data: {
      ...(typeof info?.user_id === 'number' ? { user_id: info.user_id } : {}),
      nickname,
      content: [{ type: 'text', data: { text: piece } }] as OneBotMessageSegment[],
    },
  }))
  try {
    const result = isGroup
      ? await deps.out.push(() => deps.api.sendGroupForward(target, nodes))
      : await deps.out.push(() => deps.api.sendPrivateForward(target, nodes))
    await recordSent(await sentLogFor(deps, isGroup, target), result, pieces.join('\n'))
    return { ...(result as Record<string, unknown> | null), forwarded: true }
  } catch (error) {
    deps.log(`forward failed, falling back to segments: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * 发一段（必要时再按 OneBot 上限硬切），返回最后一条的返回值。
 *
 * 单条仍然要过硬切分：分段之后再长过 OneBot 上限的，只能按长度切。
 */
async function sendPiece(deps: QQToolDeps, isGroup: boolean, target: number, piece: string): Promise<unknown> {
  const { api, out, config } = deps
  let result: unknown = null
  for (const chunk of smartSplitMessage(piece, config.maxMessageLength)) {
    const message: OneBotMessageSegment[] = [{ type: 'text', data: { text: chunk } }]
    result = isGroup
      ? await out.push(() => api.sendGroupMessage(target, message))
      : await out.push(() => api.sendPrivateMessage(target, message))
    await recordSent(await sentLogFor(deps, isGroup, target), result, chunk)
  }
  return result
}

/**
 * 尾段（第 2 段起）交给后台按 PATCH-5 的节奏发出去。
 *
 * 队列（`out`）是进程级的、严格串行，所以后面工具（贴图/语音）的发送自然排在
 * 这些尾段之后，顺序不会乱；尾段失败只记日志，不影响已经返回的结果。
 */
function scheduleTailSends(
  deps: QQToolDeps,
  isGroup: boolean,
  target: number,
  pieces: readonly string[],
): void {
  if (pieces.length < 2) return
  void (async () => {
    let previous = pieces[0] as string
    for (const piece of pieces.slice(1)) {
      // index 0 / total 2 ⇒ 一定等：这里要的是「上一句说完了」的停顿。
      await pauseBetweenSegments(previous, 0, 2, deps.config.segmentation)
      await sendPiece(deps, isGroup, target, piece)
      previous = piece
    }
  })().catch((error: unknown) => {
    deps.log(`tail send failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/** `qq_send_text` — 发送一条QQ文本消息。isGroup=true 时 target 为群号，否则为好友QQ号。当前会话窗口的归属见系统包里… */
function qqSendText(deps: QQToolDeps): ToolSpec {
  const { config } = deps
  return {
        name: 'qq_send_text',
        description: '发送一条QQ文本消息。isGroup=true 时 target 为群号，否则为好友QQ号。当前会话窗口的归属见系统包里的【本会话是QQ群/私聊】标注——往哪发必须与之一致，发错窗口是大事故。',
        parameters: {
          type: 'object',
          properties: {
            isGroup: { type: 'boolean', description: '是否发送到群聊' },
            target: { type: 'number', description: '群号或好友QQ号' },
            text: { type: 'string', description: '消息文本' },
            phase: { type: 'string', enum: ['progress', 'final'], description: 'progress=等待提示，发送后继续工具；final=最终答复（默认）' },
          },
          required: ['isGroup', 'target', 'text'],
        },
        run: async (args) => {
          const text = String(args.text ?? '').trim().replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim()
          if (text === '') throw new Error('消息文本为空（只有思考没有正文），先想清楚要说什么再发。')
          await assertWindowReachable(deps, args)
          assertGroupTextAllowed(deps, text, args.isGroup === true)
          await assertTargetAllowed(deps, args)
          // P6h：开关打开时按句拆成几条发（像人连着说话）。关着就是一条。
          const pieces = segmentText(text, config.segmentation)
          const isGroup = args.isGroup === true
          const target = Number(args.target)
          // A3：够长就改一张合并转发卡片；不走（关着/超限/失败）就继续逐条发。
          const forwarded = await tryForward(deps, isGroup, target, pieces)
          if (forwarded !== null) return { ...forwarded, segments: pieces.length }
          // 本地补丁 COMPANION-QQ-PATCH-8（下半）：**只同步发第一段**，其余段交给后台
          // 按 PATCH-5 的节奏发出去。上游把整轮分段停顿都算在工具调用里，于是回合要陪着
          // 等 5–9 秒才能继续（实测 turn 的工具耗时里这一段占 3.3–8.8 秒）。
          const last = await sendPiece(deps, isGroup, target, pieces[0] as string)
          scheduleTailSends(deps, isGroup, target, pieces)
          return { ...(last as Record<string, unknown> | null), segments: pieces.length, queued: Math.max(0, pieces.length - 1) }
        },
      }
}

/** `qq_reply_quote` — 引用回复某条消息：带上对方消息的#编号发一条引用回复，让对方明确知道咱回应的是哪条。文本里不要重复#编号。… */
function qqReplyQuote(deps: QQToolDeps): ToolSpec {
  const { api, out, log, sentLog } = deps
  const knownGroupIds = deps.knownGroups
  return {
        name: 'qq_reply_quote',
        description: '引用回复某条消息：带上对方消息的#编号发一条引用回复，让对方明确知道咱回应的是哪条。文本里不要重复#编号。',
        parameters: {
          type: 'object',
          properties: {
            isGroup: { type: 'boolean', description: '是否群聊' },
            target: { type: 'number', description: '群号或对方QQ号' },
            messageId: { type: 'number', description: '要引用的消息#编号（来自上下文包）' },
            text: { type: 'string', description: '回复正文' },
            phase: { type: 'string', enum: ['progress', 'final'], description: 'progress=等待提示，发送后继续工具；final=最终答复（默认）' },
          },
          required: ['isGroup', 'target', 'messageId', 'text'],
        },
        run: async (args) => {
          const text = String(args.text ?? '').trim().replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim()
          if (text === '') throw new Error('回复文本为空（只有思考没有正文）。引用哪条、说什么，想好了再发。')
          // 【发前验证窗口】群引用必须发进自己真的加入了的群。与 qq_send_text 用同
          // 一个判据（原先这里查 get_group_info 存在性、那边只认主群，两套规则）。
          if (args.isGroup === true) {
            const target = Number(args.target)
            const known = await knownGroupIds()
            if (!known.has(target)) {
              throw new Error(`窗口验证失败：群 ${target} 不是咱加入的群（已知：${[...known].join(',') || '无'}）。先核对窗口再引用回复。`)
            }
          }
          if (args.isGroup === true && looksLikeCode(text)) {
            throw new Error('群聊禁止发代码。请改用 qq_send_code_review 把代码私信给学弟审核，群里用引用只回一句"已私信学弟审核"。')
          }
          // 内心戏外泄闸门：沉默决定/舞台指示/战况盘算不是群消息
          if (args.isGroup === true && isInnerMonologueLeak(text)) {
            log(`blocked inner-monologue leak (quote): ${text.slice(0, 40)}`)
            throw new Error('这条是咱的内部盘算/舞台指示，不是要说的话，已拦下。要么把真正要对群里说的那句话引用发出来，要么不调用任何发送工具直接结束回合。')
          }
          const message: OneBotMessageSegment[] = [
            { type: 'reply', data: { id: String(args.messageId) } },
            { type: 'text', data: { text } },
          ]
          const result = args.isGroup === true
            ? await out.push(() => api.sendGroupMessage(Number(args.target), message))
            : await out.push(() => api.sendPrivateMessage(Number(args.target), message))
          const roomLog = await sentLogFor(deps, args.isGroup === true, Number(args.target))
          if (roomLog) {
            // OneBotClient.call() 成功时给的是 data 本身（见 B13）：这里读 .data.message_id
            // 曾经多读了一层，于是 sent-log 的 messageId 全为 null。
            const mid = (result as { message_id?: number } | null)?.message_id ?? null
            await roomLog.add({ messageId: typeof mid === 'number' ? mid : null, quotedId: Number(args.messageId) || null, text, time: Date.now() })
          }
          return result
        },
      }
}

/** `qq_send_code_review` — 【群聊代码专用】群聊禁止出现代码。有人在群里要求写代码时，把完整代码用这个工具私信发给学弟（管理员）审核，群里只回一句"… */
function qqSendCodeReview(deps: QQToolDeps): ToolSpec {
  const { api, out, config } = deps
  return {
        name: 'qq_send_code_review',
        description: '【群聊代码专用】群聊禁止出现代码。有人在群里要求写代码时，把完整代码用这个工具私信发给学弟（管理员）审核，群里只回一句"代码已私信发给学弟审核"。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '完整代码内容' },
            note: { type: 'string', description: '一句话说明这段代码是干什么的、谁要的' },
          },
          required: ['code'],
        },
        run: async (args) => {
          const master = config.admins[0]
          if (master === undefined) throw new Error('没有配置管理员QQ')
          const text = `【代码审核】${String(args.note ?? '')}

  ${String(args.code ?? '')}`
          const message: OneBotMessageSegment[] = [{ type: 'text', data: { text } }]
          return out.push(() => api.sendPrivateMessage(master, message))
        },
      }
}

/** `qq_send_poke` — 戳一戳群成员。… */
function qqSendPoke(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_send_poke',
        description: '戳一戳群成员。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number', description: '群号' },
            userId: { type: 'number', description: '要戳的用户QQ号' },
          },
          required: ['groupId', 'userId'],
        },
        run: async (args) => api.groupPoke(Number(args.groupId), Number(args.userId)),
      }
}

/** `qq_delete_msg` — 撤回一条消息（需要对应权限）。… */
function qqDeleteMsg(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_delete_msg',
        description: '撤回一条消息（需要对应权限）。',
        parameters: {
          type: 'object',
          properties: { messageId: { type: 'number' } },
          required: ['messageId'],
        },
        run: async (args) => api.deleteMessage(Number(args.messageId)),
      }
}

/** `qq_send_like` — 给好友点赞。… */
function qqSendLike(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_send_like',
        description: '给好友点赞。',
        parameters: {
          type: 'object',
          properties: { userId: { type: 'number' }, times: { type: 'number', description: '点赞次数（≤10）' } },
          required: ['userId'],
        },
        run: async (args) => api.sendLike(Number(args.userId), Math.min(Number(args.times ?? 1), 10)),
      }
}

/** 组装这一组工具。 */
export function messagingTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqSendText(deps),
    qqReplyQuote(deps),
    qqSendCodeReview(deps),
    qqSendPoke(deps),
    qqDeleteMsg(deps),
    qqSendLike(deps),
  ]
}
