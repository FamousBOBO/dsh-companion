/** 社交场景与语义复核的**接线**（P6-A / P6-B）：把判断输入变成场景、再复核这一句能不能发。
 *
 * 为什么从 `presence-flow.ts` 拆出来：那个文件的职责是"一次判断的流程"（组提示词 → 调模型
 * → 解析 → 校验），而这里是"用同一批事实做两件事"——渲染给模型看（P6-A）、以及判断这一句
 * 该不该被拦（P6-B）。两件事共用 `buildSocialScene` 的结果，所以放在一起。
 *
 * 三条纪律：
 *   1. **同一批事实、两个阈值**：场景里 `repeatedSelf` 用 0.6（"看起来像"），复核里用 0.9
 *      （"确实是同一句才拦"）。混成一个数会让"她少说话了"和"诊断数字难看"互相绑架；
 *   2. **绝不抛**：场景算不出来只是少一段上下文，复核算不出来就放行（宁可不拦）；
 *   3. **默认只记不拦**：见 `core/group-social-guard.ts` 的模式注释。
 */

import { buildSocialScene, REPEAT_WINDOW_MS, type SocialScene } from '../../core/group-scene.js'
import {
  checkSocialGuard,
  DEFAULT_SOCIAL_GUARD,
  type SocialGuardVerdict,
} from '../../core/group-social-guard.js'
import { renderSocialScene } from './group-scene-prompt.js'
import type { CycleDeps, CycleInput, SpeakingDecision } from './presence-flow.js'

/** 名字表：背景里每条都有 `name`，用它渲染参与者就不会让同一串 QQ 号出现两次。 */
function namesOf(input: CycleInput): Map<number, string> {
  const names = new Map<number, string>()
  for (const entry of input.background) {
    const name = entry.name.trim()
    if (name !== '' && !names.has(entry.userId)) names.set(entry.userId, name)
  }
  return names
}

/** 她说过的话带时间（复读复核用）；缺了时间就按"刚刚"算（保守方向是**多拦**，warn 档又不拦）。 */
function selfSaidOf(input: CycleInput, deps: CycleDeps): Array<{ text: string; atMs: number }> {
  if (input.selfSaid !== undefined && input.selfSaid.length > 0) return [...input.selfSaid]
  const nowMs = deps.clock.now()
  return input.sentLines.map((text) => ({ text, atMs: nowMs }))
}

/**
 * 这条想回的消息上**已有的回答**（G10 的输入，只认平台结构）。
 *
 * 两种算"回答过"：引用了那条问句；或者直接回到提问者（真实 @ 他）。
 * 只从这一批背景里取——更早的不在上下文里，拿它判"已经答过"等于拿看不见的证据拦人。
 */
function answersOf(input: CycleInput, targetMessageId: number | undefined): string[] {
  if (targetMessageId === undefined) return []
  const target = input.background.find((entry) => entry.messageId === targetMessageId)
  if (target === undefined) return []
  const texts: string[] = []
  for (const entry of input.background) {
    if (entry.messageId === targetMessageId || entry.self) continue
    const quotedTarget = entry.replyToMessageId === targetMessageId
    const atQuestioner = (entry.atIds ?? []).includes(target.userId)
    if (!quotedTarget && !atQuestioner) continue
    const text = (entry.body ?? entry.text).trim()
    if (text !== '') texts.push(text)
  }
  return texts.slice(-4)
}

/** 算一遍场景（不含渲染）；算不出来返回 `null`（复核层会放行三条依赖场景的规则）。 */
export function sceneModelOf(input: CycleInput, deps: CycleDeps): SocialScene | null {
  try {
    return buildSocialScene({
      entries: input.background.map((entry) => ({
        messageId: entry.messageId,
        userId: entry.userId,
        text: entry.body ?? entry.text,
        atMs: entry.atMs,
        self: entry.self,
        replyToMessageId: entry.replyToMessageId ?? null,
        atUserIds: entry.atIds ?? [],
      })),
      selfId: deps.selfId?.() ?? 0,
      nowMs: deps.clock.now(),
      recentSelf: selfSaidOf(input, deps),
    })
  } catch {
    return null
  }
}

/** 渲染场景段（P6-A）；空串 = 这一批没有可说的结构（提示词与 P2 逐字节一致）。 */
export function renderScene(input: CycleInput, deps: CycleDeps): string {
  try {
    const names = namesOf(input)
    return renderSocialScene(sceneModelOf(input, deps), (userId) => names.get(userId) ?? '')
  } catch {
    return ''
  }
}

/**
 * 语义复核（P6-B）：`warn` 档只记日志，`enforce` 档才真的拦。
 *
 * 为什么默认 warn：四条规则里三条依赖场景推断，而重叠阈值与 40 分钟窗从没在真实群聊上
 * 校准过。默认拦会把"她少说话了"变成没人能解释的现象；默认观测能拿到"如果拦，会拦掉多少"。
 * 所以**先记后判**：不管哪一档，命中都会进日志（`presence: 语义复核命中 …`），
 * 运维可以直接从日志统计命中率，再回来决定要不要切 enforce。
 */
export function runSocialGuard(input: CycleInput, deps: CycleDeps, decision: SpeakingDecision): SocialGuardVerdict {
  const mode = deps.guardMode?.() ?? DEFAULT_SOCIAL_GUARD
  if (mode === 'off') return { ok: true }
  const target = decision.action === 'reply' ? decision.targetMessageId : undefined
  const verdict = checkSocialGuard({
    action: decision.action,
    text: decision.text,
    ...(target === undefined ? {} : { targetMessageId: target }),
    scene: sceneModelOf(input, deps),
    selfSaid: selfSaidOf(input, deps),
    nowMs: deps.clock.now(),
    repeatWindowMs: REPEAT_WINDOW_MS,
    existingAnswers: input.existingAnswers ?? answersOf(input, target),
  })
  if (verdict.ok) return verdict
  deps.log(
    `presence: 群 ${String(input.groupId)} 语义复核命中 ${verdict.reason}（${verdict.detail}）`
    + `——${mode === 'enforce' ? '已拦下' : '仅记录（socialGuard=warn）'}`,
  )
  return mode === 'enforce' ? verdict : { ok: true }
}
