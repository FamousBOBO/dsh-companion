/** P6-B：四类语义错误的**代码侧**复核（G06 / G10 / G30 / G41）。
 *
 * 为什么这些规则能放进代码，而"这句话够不够得体"不能：这四条都只依赖**已经确定的事实**
 * （她自己说过的原话、平台引用边、真实 @、场景字段），不需要理解语义。计划 §3.2 给每条都
 * 写了"禁止的捷径"，这里逐条对照着写：
 *
 * | 场景 | 本模块的规则 | 计划明令禁止的捷径（**没有**采用） |
 * |---|---|---|
 * | G06 两人对聊 | `discussionKind === 'directed'` 且被定向的是别人、又没 @ 我 → 不许 `join` | "恰好只有两个人发言 → 永远不参与" |
 * | G10 重复抢答 | 目标是那条**已被回答**的问句，且新话与已有的回答高度重合 → 拦 | "出现问号 → 必须回答"，"有任何回答 → 一律不许回" |
 * | G30 复读自己 | 与她自己 40 分钟内的原话近乎相同 → 拦（配置可关/只观测） | "只靠全文完全相同判重"，"把不同观点都拦掉" |
 * | G41 主动劝架 | 场景判为争执、且没人 @ 我/引用我 → 拦（劝架也算插话） | "一遇到分歧就全群禁言" |
 *
 * 三条共同纪律：
 *   1. **只拦不判**：这里不产生"该说什么"，只回答"这一句现在能不能发"；
 *   2. **给得出理由**：每条拦截都带一个稳定的 `reason`（进日志/评测/影子日志），
 *      便于用真实数据复核"到底是哪一条太紧"；
 *   3. **纯函数**：不读时钟、不读盘（R8）。
 */

import { overlapRatio } from './group-feedback.js'
import type { SocialScene } from './group-scene.js'

/**
 * 三条档位（`presence.socialGuard`）：
 *
 *   - `off`     完全不看（连日志都不记）；
 *   - `warn`    **默认**：只记日志与影子日志，**不拦**。计划 §3.2 明写"阈值应通过真实样本
 *               确定；只做降噪和诊断，不宜默认一相似就一刀切"——所以先观测；
 *   - `enforce` 真的拦下（这一轮不说话）。
 *
 * 为什么不默认 enforce：四条规则里三条依赖场景推断，而场景的 `repeatedSelf` 阈值
 * （`overlaps() >= 0.9`）从没在真实群聊上校准过。默认拦会把"她少说话了"变成一个
 * 没人能解释的现象；默认观测则能拿到"如果拦，会拦掉多少"的实测数字。
 */
export type SocialGuardMode = 'off' | 'warn' | 'enforce'

export const SOCIAL_GUARD_MODES: readonly SocialGuardMode[] = ['off', 'warn', 'enforce']
export const DEFAULT_SOCIAL_GUARD: SocialGuardMode = 'warn'

/** 四条规则的名字（稳定字符串：日志、评测报告、影子日志都按它分类）。 */
export type SocialGuardReason =
  | 'self-repeat'
  | 'conflict-bystander'
  | 'directed-join'
  | 'answered-duplicate'

/** 拦不拦。`ok: true` 时没有理由字段（调用方不必判空）。 */
export type SocialGuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SocialGuardReason; readonly detail: string }

const OK: SocialGuardVerdict = { ok: true }

/**
 * 复读判定的重合阈值。
 *
 * **这是一个先验值，不是校准过的数**：`overlaps()` 用双字集合，群聊短句的集合很小，
 * 阈值定低了会把"好的"/"好的呀"判成复读。这里取 0.9（几乎是同一句才拦），并且
 * `presence.socialGuard` 可以把它降成只观测——真实样本回来之前，宁可少拦。
 */
export const SELF_REPEAT_THRESHOLD = 0.9

/** 她自己的原话（带时间）。 */
export interface SelfSay {
  readonly text: string
  readonly atMs: number
}

/** 一次复核的输入。 */
export interface SocialGuardInput {
  /** 模型这一轮想做的动作。 */
  readonly action: 'reply' | 'join' | 'react'
  /** 想发出去的那句话。 */
  readonly text: string
  /** 想回的那条（只有 `reply` 有）。 */
  readonly targetMessageId?: number
  /** 这一批的社交结构（P6-A）；`null` = 算不出来（此时除了 G30 其它三条一律放行）。 */
  readonly scene: SocialScene | null
  /** 她最近说过的话（时间正序，带 atMs）。 */
  readonly selfSaid: readonly SelfSay[]
  /** 现在几点。 */
  readonly nowMs: number
  /** 复读窗口（毫秒）。 */
  readonly repeatWindowMs?: number
  /** 目标消息里**已有的回答**（用于 G10 的"重复回答"判定；没有就不拦）。 */
  readonly existingAnswers?: readonly string[]
}

/**
 * 四条规则一起过（顺序固定：先"复读自己"再"争执"再"定向"再"重复回答"）。
 *
 * 顺序的理由：复读是最确定的（原话就在手里），争执与定向依赖场景推断（可能 uncertain），
 * 重复回答依赖外部给的已有回答。把最确定的判据放前面，日志里第一条理由就是最可信的那条。
 */
export function checkSocialGuard(input: SocialGuardInput): SocialGuardVerdict {
  return selfRepeat(input) ?? conflictBystander(input) ?? directedJoin(input) ?? answeredDuplicate(input) ?? OK
}

/**
 * G30：与她自己最近的原话近乎相同。
 *
 * 只和**她自己的**话比（不跟别人比）：计划 §3.2 说的是"复读自己半小时前的发言"。
 * 只比窗口内的（默认 40 分钟，与 `group-scene.ts` 的 `REPEAT_WINDOW_MS` 同一口径）。
 */
function selfRepeat(input: SocialGuardInput): SocialGuardVerdict | null {
  const text = normalize(input.text)
  if (text === '') return null
  const windowMs = positive(input.repeatWindowMs, 40 * 60_000)
  for (let i = input.selfSaid.length - 1; i >= 0; i -= 1) {
    const said = input.selfSaid[i]
    if (said === undefined) continue
    const age = input.nowMs - said.atMs
    // 时间戳缺失（有些来源只给文本）时按"在窗口内"处理：宁可多看一眼，也不要漏掉复读。
    if (Number.isFinite(said.atMs) && said.atMs > 0 && age > windowMs) continue
    if (normalize(said.text) === text) {
      return { ok: false, reason: 'self-repeat', detail: '与她自己刚才那句完全相同' }
    }
    if (overlapRatio(normalize(said.text), text) >= SELF_REPEAT_THRESHOLD) {
      return { ok: false, reason: 'self-repeat', detail: '与她刚才那句高度重合（≥90%）' }
    }
  }
  return null
}

/**
 * G41：争执中不掺和——**包括劝架**。
 *
 * 两个例外都要放行，否则就变成了"一有分歧就全群禁言"：
 *   1. 有人真的 @ 了她（`askedMe`）——被点名求助时可以谨慎回应；
 *   2. 场景只是 `uncertain`（看不准有没有争执）——那不算争执。
 */
function conflictBystander(input: SocialGuardInput): SocialGuardVerdict | null {
  const scene = input.scene
  if (scene === null) return null
  if (scene.conflictState !== 'active') return null
  if (scene.askedMe) return null
  return {
    ok: false,
    reason: 'conflict-bystander',
    detail: '群里可能在争执，且没人 @ 你——不掺和（劝架也算插话）',
  }
}

/**
 * G06：定向对话里不许"加入话题"。
 *
 * 为什么只拦 `join` 而不拦全部：`reply`/`react` 指向一条具体消息，本来就是轻量参与；
 * `join` 的语义是"我也来聊这个"，在两人定向交流里正是"不请自来"。计划 §3.2 明令禁止
 * "恰好只有两个人发言 → 永远不参与"，所以这里**不看人数**，只看真实定向线索。
 */
function directedJoin(input: SocialGuardInput): SocialGuardVerdict | null {
  const scene = input.scene
  if (scene === null) return null
  if (input.action !== 'join') return null
  if (scene.discussionKind !== 'directed') return null
  // 被定向的就是她自己（有人在问她）→ 那是邀请，不是插话。
  if (scene.directedTo === undefined || scene.askedMe) return null
  return {
    ok: false,
    reason: 'directed-join',
    detail: '这是两个人之间的定向对话，你没被点名——不要"加入话题"',
  }
}

/**
 * G10：对一条**已经有回答**的问句再答一遍，而且话还是那几句。
 *
 * 判据只有一条：与已有的回答高度重合。**没有**采用"有人答过就不许答"——那会把
 * "补充一个真正有用的新信息"也拦掉，而计划要求"只在有明显新内容时参与"。
 * 新内容判断不了，那就只拦"换个人把同一句话再说一遍"。
 */
function answeredDuplicate(input: SocialGuardInput): SocialGuardVerdict | null {
  const answers = input.existingAnswers ?? []
  if (answers.length === 0 || input.action !== 'reply') return null
  const text = normalize(input.text)
  if (text === '') return null
  for (const answer of answers) {
    if (overlapRatio(normalize(answer), text) >= SELF_REPEAT_THRESHOLD) {
      return { ok: false, reason: 'answered-duplicate', detail: '已经有人这样回答过了' }
    }
  }
  return null
}

/** 归一化：去掉空白与标点，只留内容字符（复读判定不该被标点差异绕过）。 */
function normalize(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
