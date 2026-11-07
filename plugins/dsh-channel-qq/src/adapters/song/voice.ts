/** 语音条发送适配器：把**一次**发送变成一条可记账的回执。
 *
 * 这个文件很小，但它承担的是整条点歌链路上最容易出事的那一步：
 * **"用户只收到一条语音条"**。重复语音条的来源从来不是"发送失败"，
 * 而是"发送成功但调用方以为失败、于是又发了一次"。所以这里的判据是三态，
 * 而不是布尔：
 *
 *   - 拿到 `message_id`                    → `ok: true`   （成功，可记 `sent`）
 *   - 平台明确报错 / 抛异常 / 文件读不到   → `ok: false`  （失败，可记 `failed`）
 *   - 超时 / 已 resolve 但没 `message_id`  → `unknown: true`（**回执未知**）
 *
 * 第三态的存在就是为了禁止自动重发：消息可能已经在对方手机上了，再发一条
 * 就是两条语音条。上层队列把 `unknown` 记成独立终态 `unknown-send`，不重试。
 *
 * 实现上刻意**不复用** `qq_send_voice` 工具函数：那个工具是模型面的（参数是
 * `Record<string, unknown>`、返回值是裸 `SendResult`），这里需要的是端口。
 * 两者走同一条路径——`napcatFileArg` + `out.push` + `send_private_msg` / `send_group_msg`
 * （按 `room` 选哪一个）——所以行为一致，但这里多了一层超时与回执分类。
 */

import { napcatFileArg } from '../../local-file.js'
import { splitRoom } from '../../core/room.js'
import type { OutboundQueue } from '../../outbound.js'
import type { QQApi, SendResult } from '../../ports/platform.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { VoicePort, VoiceSendResult } from '../../features/song/types.js'

export interface VoicePortOptions {
  readonly api: QQApi
  readonly out: OutboundQueue
  readonly log: (line: string) => void
  /** 等回执的上限；超时即"回执未知"。默认 30_000。 */
  readonly timeoutMs?: number
}

/** 默认等回执上限：本地 NapCat 走 WebSocket，30 s 还没回执基本就是链路断了。 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * `Promise.race` 的三岔结果。
 *
 * 为什么把**错误**也做成值（`error`）而不是直接让 promise reject：
 * 超时之后、底层发送稍晚才失败，那个拒绝就再没有别的处理者了。Node 默认把
 * "未处理的拒绝"升级成致命错误——一条"回执晚到的失败"足以把整个进程打死。
 * 把错误收成值之后，竞速的每一侧都**永不拒绝**，无论谁先到都没有悬空的拒绝。
 */
type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'timeout' }

/**
 * 等一个 promise，超时即放弃等待。
 *
 * 注意：超时**不**取消底层发送——那时消息可能已经出去了，我们能做的只是
 * 承认自己不知道结果。这也是返回值没有"取消"语义的原因。
 *
 * 还有一个必须说清楚的事实：计时从 `out.push` **返回 promise 的那一刻**开始，
 * 因此**包含出站队列的限速等待**（真实 `OutboundQueue` 每条先等 `rateLimitMs`）。
 * 那是刻意的：对"点歌回话"这件事来说，"排队排了 30 s 还没动静"与"发出去了但没回执"
 * 同样不可接受，也同样不能重试——两种都只能报 `unknown`。
 */
async function raceOutcome<T>(work: Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<Outcome<T>>([
      work.then(
        (value): Outcome<T> => ({ kind: 'ok', value }),
        (error: unknown): Outcome<T> => ({ kind: 'error', error }),
      ),
      new Promise<Outcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 错误转成给人看的一句短话（不把整个栈写进日志）。 */
function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 一次发送需要的东西：三个端口 + 目标房间 + 已经拼好的消息 + 等待上限。 */
interface SendAttempt {
  readonly api: QQApi
  readonly out: OutboundQueue
  readonly log: (line: string) => void
  readonly room: string
  readonly chatId: number
  readonly toGroup: boolean
  readonly message: OneBotMessageSegment[]
  readonly timeoutMs: number
}

/**
 * 发一次，并把结果分成三态。**恰好一次 `out.push`**：失败也不重排——重排就是重复语音条。
 *
 * 单独成函数只因为 `createVoicePort` 要压在函数行数上限之内；判据仍与文件头一致。
 */
async function sendOnce(attempt: SendAttempt): Promise<VoiceSendResult> {
  const { api, out, log, room, chatId, toGroup, message, timeoutMs } = attempt
  try {
    const pending = out.push(() => toGroup
      ? api.sendGroupMessage(chatId, message)
      : api.sendPrivateMessage(chatId, message))
    const outcome = await raceOutcome<SendResult>(pending, timeoutMs)

    if (outcome.kind === 'timeout') {
      // 回执未知：不重试、不再 push。上层据此记 `unknown-send` 并停手。
      const detail = `回执未知：超过 ${String(timeoutMs)}ms 没收到发送结果`
      log(`song-voice: ${room} unknown（${detail}）`)
      return { ok: false, messageId: null, unknown: true, detail }
    }
    if (outcome.kind === 'error') {
      // 平台明确报错（`retcode != 0`、连接被拒、参数被拒）。这是**确定**的失败，
      // 消息没出去，也不重试：上层会按策略决定要不要给用户说一声。
      const detail = `发送失败：${reasonOf(outcome.error)}`
      log(`song-voice: ${room} failed（${detail}）`)
      return { ok: false, messageId: null, unknown: false, detail }
    }
    const messageId = outcome.value.message_id
    if (typeof messageId !== 'number') {
      // 平台说"成功"却没给 id：同样按回执未知处理。宁可少一条记录，
      // 也不能因为"没 id 就当失败"再发一次。
      const detail = '回执未知：平台没有返回 message_id'
      log(`song-voice: ${room} unknown（${detail}）`)
      return { ok: false, messageId: null, unknown: true, detail }
    }
    log(`song-voice: ${room} 已发送（message_id=${String(messageId)}）`)
    return { ok: true, messageId, unknown: false, detail: '' }
  } catch (error) {
    // 走到这里是 `out.push` 自己**同步**抛错（队列已坏）。同样是确定失败。
    const detail = `发送失败：${reasonOf(error)}`
    log(`song-voice: ${room} failed（${detail}）`)
    return { ok: false, messageId: null, unknown: false, detail }
  }
}

export function createVoicePort(options: VoicePortOptions): VoicePort {
  const { api, out, log } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async sendVoice(room: string, chatId: number, file: string): Promise<VoiceSendResult> {
      // 第一步：把本地文件变成 NapCat 能读的参数（`base64://` / `file://`）。
      // 它可能会抛（文件不存在、超出内联上限、越出文件边界）——那是**确定**的失败，
      // 消息根本没发出去，所以 `unknown` 为 false。
      let arg: string
      try {
        arg = await napcatFileArg(file)
      } catch (error) {
        const detail = `语音文件不可用：${reasonOf(error)}`
        log(`song-voice: ${room} 未发送（${detail}）`)
        return { ok: false, messageId: null, unknown: false, detail }
      }

      const message: OneBotMessageSegment[] = [{ type: 'record', data: { file: arg } }]

      // 发到哪个房间由 `room` 决定，不由调用方另开一个参数决定：房间键是这条链路上
      // 唯一"这条语音条属于谁"的事实（`dm-<号>` / `group-<群号>`）。拆不出来时按私聊发、
      // 用调用方给的 `chatId`，并且**不崩**——看不懂的房间键不该让语音条连发都发不出去。
      const split = splitRoom(room)
      return await sendOnce({
        api, out, log, room,
        chatId: split?.chatId ?? chatId,
        toGroup: split?.isGroup === true,
        message,
        timeoutMs,
      })
    },
  }
}
