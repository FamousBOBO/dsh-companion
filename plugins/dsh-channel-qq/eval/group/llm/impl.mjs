/**
 * **实现加载**：评测要跑的每一个函数都来自生产代码，这里只负责"从哪加载"。
 *
 * 加载顺序与 `eval/group/adapter.mjs` 完全一致（build/lib 优先，产物缺失退到 src/*.ts），
 * 共用同一个 `adapter.mjs`（它已经导出了 `runPresenceCycle` / `parseSocialDecision` /
 * `validateSocialDecision` / `sendsMessage` / `speakVerdict` 这些真实导出）。
 * 唯一在本文件补上的是**提示词组装** `buildSocialPrompt`：离线通道用不到它（模型输出是写死的），
 * 真实模型通道必须用它——提示词一变，"模型说了什么"就不可比。
 *
 * 所以本文件里没有一行判定：导出的东西全是生产函数的转发。
 */

import { register } from 'node:module'

import * as adapter from '../adapter.mjs'

export const IMPL = adapter.IMPL
export const DEFAULTS = adapter.DEFAULTS
export const presence = adapter.presence
export const parseSocialDecision = adapter.parseSocialDecision
export const validateSocialDecision = adapter.validateSocialDecision
export const sendsMessage = adapter.sendsMessage
export const runPresenceCycle = adapter.runPresenceCycle
export const judgeEntries = adapter.judgeEntries
export const fakePresenceState = adapter.fakePresenceState

/** 决策/校验共用的上下文（与线上 `runPresenceCycle` 里构造的那一个同形）。 */
export function decisionContext({ background, nowMs, replyMaxChars, windowMs }) {
  return {
    messages: background.map((entry) => ({ messageId: entry.messageId ?? null, atMs: entry.atMs })),
    replyMaxChars,
    nowMs,
    windowMs,
  }
}

/** 加载提示词模块：build/lib → lib → src（.ts）。 */
async function loadPromptModule() {
  for (const specifier of [
    '../../../build/lib/app/inbound/group-social-prompt.js',
    '../../../lib/app/inbound/group-social-prompt.js',
  ]) {
    try {
      return await import(specifier)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
  }
  register('../ts-resolve-hook.mjs', import.meta.url)
  return await import(new URL('../../../src/app/inbound/group-social-prompt.ts', import.meta.url).href)
}

const promptModule = await loadPromptModule()

/** 生产提示词组装（`group-social-prompt.ts`）。 */
export const buildSocialPrompt = promptModule.buildSocialPrompt

/** 判断设置（全部取线上的 `DEFAULTS`，评测不另抄一份；`pipeline.mjs` 与探测共用）。 */
export function settingsOf() {
  return {
    judgeIntervalMs: DEFAULTS.judgeIntervalMs,
    judgeMaxEntries: DEFAULTS.judgeMaxEntries,
    judgeMaxChars: DEFAULTS.judgeMaxChars,
    judgeTimeoutMs: DEFAULTS.judgeTimeoutMs,
    judgeMaxTokens: DEFAULTS.judgeMaxTokens,
    speakMinIntervalMs: DEFAULTS.speakMinIntervalMs,
    speakMaxPerHour: DEFAULTS.speakMaxPerHour,
    replyMaxChars: DEFAULTS.replyMaxChars,
    replyWindowMs: DEFAULTS.replyWindowMs,
    memoryBudgetChars: DEFAULTS.memoryBudgetChars,
  }
}

/**
 * 探测当前实现是否支持**影子闸门**（P5-B 的 `deps.sendGate`）。
 *
 * 为什么要探测而不是直接假设：闸门是 P5-B 的产物。在它还没编译进 `build/lib` 的机器上，
 * `runPresenceCycle` 会一路走到平台端口——也就是会踩到绊线。与其在每条用例里各炸一次，
 * 不如开跑前用一条**不花钱**的合成用例问一次："走完整流程时，发送会不会被拦？"
 *
 * 探测本身用假补全（零网络、零模型），平台是绊线：如果闸门不存在，绊线会响，
 * 我们据此把通道降级为"组合通道"（组包 + 解析 + 校验 + 限频，没有发送那一步），
 * 并在报告里写明这次走的是哪一条。
 *
 * @returns {Promise<{supported: boolean, detail: string}>}
 */
export async function probeShadowGate() {
  const { createTripwirePlatform } = await import('./port.mjs')
  const nowMs = Date.UTC(2026, 10, 8, 14, 0)
  const background = [{ messageId: 1, userId: 1, name: 'probe', text: '探测', atMs: nowMs - 1_000, self: false }]
  const { platform, trips } = createTripwirePlatform({ label: 'gate-probe' })
  const outcome = await runPresenceCycle(
    {
      groupId: 1000000003,
      settings: settingsOf(),
      state: fakePresenceState({ nowMs }),
      background: judgeEntries(background),
      sentLines: [],
      nowLabel: '22:00',
      persona: null,
    },
    {
      clock: { now: () => nowMs, date: () => new Date(nowMs), setTimeout: () => ({ cancel: () => {} }), setInterval: () => ({ cancel: () => {} }) },
      log: () => {},
      platform: () => platform,
      complete: {
        async complete() {
          return { kind: 'text', text: '{"action":"reply","targetMessageId":1,"text":"探测一句","reason":"probe"}' }
        },
      },
      recordSent: async () => {},
      sendGate: () => 'shadow',
      recordShadow: () => {},
    },
  )
  if (outcome.kind === 'shadow') return { supported: true, detail: 'runPresenceCycle 支持 sendGate（P5-B 的影子闸门已就位）' }
  if (trips.length > 0) {
    return {
      supported: false,
      detail: 'runPresenceCycle 没有影子闸门：整条流程会走到平台端口（本次被绊线拦下）。先跑 npm run build 让 build/lib 与 src 对齐。',
    }
  }
  return { supported: false, detail: `runPresenceCycle 没有影子闸门（探测结局 ${outcome.kind}：${String(outcome.detail ?? outcome.reason ?? '')}）` }
}

