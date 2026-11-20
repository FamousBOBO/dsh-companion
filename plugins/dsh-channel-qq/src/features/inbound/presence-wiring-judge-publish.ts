/** 把判断端口**发布给兄弟插件行**（VoceChat 适配层要它）。
 *
 * 为什么需要这一层：VoceChat 与 QQ 是两个平级的插件行（`dsh-vocechat-adapter` /
 * `dsh-channel-qq`），`ctx.get()` 在兄弟上看不见（cordis 子树作用域，2026-11-04
 * 健康服务事故的结论）。所以只能走进程级注册表
 * `process[Symbol.for('dsh.companion.ports.v1')]`。
 *
 * 三条口径：
 *   1. **发布与 `presence.enabled` 无关**：只要配了 typed 后端就发布。VoceChat 不该因为
 *      "QQ 群白名单是空的"而失明——两边的判断能力是同一个服务，不是某个群的附属品。
 *   2. **发出去的是"能判一次"的能力，不是原始端口**：外面拿到的是
 *      `decide({lines, ...})`，状态渲染仍在 QQ 这侧做（`renderJudgeState` 只有一份实现）。
 *      这样两边看到的 `state` 逐字节一致，分数才可比。
 *   3. **不含任何凭据**：发布出去的对象里只有 `decide` / `info` / `ready`，
 *      云端 key 留在 `judge-hosted-host.ts` 的闭包里。
 */

import { renderJudgeState } from '../../app/inbound/judge-state.js'
import type { JudgePort, JudgeVerdict } from '../../app/inbound/judge-port.js'
import type { JudgeLine } from '../../app/inbound/judge-port.js'
import { DEFAULTS, positiveOr, type PresenceView } from '../../app/inbound/presence-flow.js'
import { dataRootOfDshHome } from '../../adapters/dsh-host/group-persona.js'
import { publishServiceToPeers } from '../../adapters/dsh-host/service-registry.js'
import type { SubHost } from '../plugin-kit.js'

/** 发布出去的名字（VoceChat 的 `judge-link.mjs` 必须用同一个）。 */
export const JUDGE_SERVICE = 'companionJudge'

/** 一次跨通道判断的入参：**只有事实**，没有结论。 */
export interface SharedJudgeInput {
  /** 渠道：进状态文本的抬头（`QQ` / `uid` 两种写法）。 */
  readonly origin: 'qq' | 'vc'
  /** 房间标识（只进日志，不进状态：状态里出现房间号会让分数被无关数字带偏）。 */
  readonly room: string
  /** 按时间正序的一批旁听（调用方已经按条数裁好）。 */
  readonly lines: readonly JudgeLine[]
  /** 现在几点（毫秒）。 */
  readonly nowMs: number
  /** `HH:MM` 或 `YYYY-MM-DD HH:MM`（由调用方用注入时钟格式化）。 */
  readonly nowLabel: string
  /** 正文长度上限与可引用时间窗（缺省取 `presence.*`）。 */
  readonly replyMaxChars?: number
  readonly windowMs?: number
  /** 她在这个渠道上的 id（不知道就别传）。 */
  readonly selfId?: number
}

/** 发布出去的服务面。 */
export interface SharedJudgeService {
  decide(input: SharedJudgeInput): Promise<JudgeVerdict>
  info(): { readonly backend: string; readonly model: string } | null
  ready(): boolean
}

/** 把 `presence.*` 解析成这一次的限额（与 QQ 内部那条同源）。 */
function limitsFor(input: SharedJudgeInput, presence: PresenceView | null): { replyMaxChars: number; windowMs: number } {
  return {
    replyMaxChars: positiveOr(input.replyMaxChars ?? presence?.replyMaxChars ?? DEFAULTS.replyMaxChars, DEFAULTS.replyMaxChars),
    windowMs: positiveOr(input.windowMs ?? presence?.replyWindowMs ?? DEFAULTS.replyWindowMs, DEFAULTS.replyWindowMs),
  }
}

/**
 * 发布判断服务；返回幂等释放函数。
 *
 * 没有端口（`host` 后端或配置不全）时**照样发布**，但 `ready()` 返回 `false` ——
 * 让对端能区分"没接上"和"没配"，而不是永远等一个不会来的对象。
 */
export function publishJudgeToPeers(
  host: SubHost,
  parts: {
    readonly port: JudgePort | undefined
    readonly backend: () => string
    readonly model: () => string
  },
): () => void {
  const references = (): boolean => parts.port !== undefined && parts.backend() !== 'host'
  const service: SharedJudgeService = {
    async decide(input: SharedJudgeInput): Promise<JudgeVerdict> {
      const port = parts.port
      if (port === undefined || parts.backend() === 'host') {
        return { kind: 'no-route', detail: '判据后端不提供跨通道判断（backend=host 或端口未接）' }
      }
      const presence = (host.config.presence ?? null) as PresenceView | null
      const limits = limitsFor(input, presence)
      return await port.decide({
        groupId: 0,
        lines: input.lines,
        // 状态渲染只有一份实现：VoceChat 的 `uid N` 抬头由 `origin` 决定，其余逐字节一致。
        state: renderJudgeState(
          input.lines.map((line) => ({
            messageId: line.messageId,
            name: line.name,
            userId: line.userId,
            text: line.text,
            // `body` 显式给：`entryBodyOf` 的兜底是"剥掉 QQ 的发送者前缀"，
            // 而 VoceChat 的正文本来就没有前缀——让它去剥只会吃掉别人的字。
            body: line.text,
            self: line.self,
            atMs: line.atMs,
          })),
          input.nowLabel,
          input.origin,
        ),
        nowMs: input.nowMs,
        replyMaxChars: limits.replyMaxChars,
        windowMs: limits.windowMs,
        ...(input.selfId === undefined ? {} : { selfId: input.selfId }),
      })
    },
    info: () => (references() ? { backend: parts.backend(), model: parts.model() } : null),
    ready: () => references(),
  }
  return publishServiceToPeers({
    name: JUDGE_SERVICE,
    service,
    root: dataRootOfDshHome(host.dshHome) ?? '',
    ready: references,
    log: host.log,
  })
}
