/**
 * **跑语料**：每条示例 → 生产提示词 → 真实模型 → 生产解析 → 生产校验 → 生产限频 → 绊线平台。
 *
 * 这里**没有一行判定**：
 *   - 提示词来自 `buildSocialPrompt`（`group-social-prompt.ts`）；
 *   - 解析/校验/发不发来自 `parseSocialDecision` / `validateSocialDecision` / `sendsMessage`
 *     （`group-social-decision.ts`）；
 *   - 限频来自 `runPresenceCycle` 里的 `speakVerdict`（`core/presence.ts`）；
 *   - 发送目标是**绊线**（`port.mjs`），一次都不许真的出去。
 *
 * 两个通道（`channel.mode`）：
 *   - `presence-cycle`：整条生产线（默认，要求 P5-B 的影子闸门就位）；
 *   - `composed`：`buildSocialPrompt` + 真实模型端口 + `parseSocialDecision` + `validateSocialDecision`
 *     + `speakVerdict`，**没有发送那一步**。当 `runPresenceCycle` 还没有闸门时（build 落后于 src）
 *     用它，保证评测在"闸门未编译"的机器上仍然零发送，并在报告里写明降级到了哪一条。
 */

import { CASES } from '../corpus.mjs'
import {
  DEFAULTS,
  buildSocialPrompt,
  decisionContext,
  fakePresenceState,
  judgeEntries,
  parseSocialDecision,
  presence,
  runPresenceCycle,
  sendsMessage,
  validateSocialDecision,
} from './impl.mjs'
import { FAKE_GROUP_ID, costOf, createModelPort, createTripwirePlatform } from './port.mjs'
import { caseRecord, executionOf, inputHashOf, stabilityOf, tierOf } from './record.mjs'

/** 固定假群号（与 `port.mjs` 一致；报告里只出现这个）。 */
const GROUP_ID = FAKE_GROUP_ID

/** 用例的"现在"：与离线通道同一条规则（最后一条背景消息之后 2 秒；不读系统时间）。 */
export function nowOf(c) {
  if (typeof c.nowMs === 'number') return c.nowMs
  return Math.max(...c.background.map((m) => m.atMs)) + 2_000
}

/** 冻结时钟（与 `eval/group/adapter.mjs` 的 `fakeClock` 同形）。 */
export function clockOf(nowMs) {
  return {
    now: () => nowMs,
    date: () => new Date(nowMs),
    setTimeout: () => ({ cancel: () => {} }),
    setInterval: () => ({ cancel: () => {} }),
  }
}

/** 判断设置（全部取线上的 `DEFAULTS`，评测不另抄一份）。 */
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

/** 组提示词（生产函数；`runPresenceCycle` 内部用的是同一份）。 */
export function promptFor(c, settings, persona) {
  return buildSocialPrompt({
    groupId: GROUP_ID,
    persona: persona.snapshot,
    background: judgeEntries(c.background),
    sentLines: c.botRecent ?? [],
    groupMemory: [],
    memberMemory: [],
    topic: null,
    replyMaxChars: settings.replyMaxChars,
    nowLabel: '21:58',
    memoryBudgetChars: settings.memoryBudgetChars,
  })
}

/**
 * 组合通道：与 `runPresenceCycle` 同样的顺序（提示词 → 模型 → 解析 → 校验 → 限频），
 * 但**没有发送那一步**，所以结构上不存在"漏发"的可能。
 */
export async function runComposed({ c, settings, persona, state, complete, ctx }) {
  const prompt = promptFor(c, settings, persona)
  const result = await complete.complete({
    prompt,
    maxTokens: settings.judgeMaxTokens,
    timeoutMs: settings.judgeTimeoutMs,
    sessionId: `presence-judge-${String(GROUP_ID)}`,
    preferredEffort: 'low',
  })
  if (result.kind !== 'text') return { kind: 'failed', detail: `判断调用不可用：${result.kind}（${result.detail ?? '无详情'}）`, state }
  const parsed = parseSocialDecision(result.text, ctx)
  if (parsed.kind === 'invalid') return { kind: 'failed', detail: `判断输出不可用（${parsed.reason}）`, state }
  if (parsed.kind === 'silent') return { kind: 'silent', reason: `判断为不说话（${parsed.reason}）`, state, action: 'silent' }
  const decision = parsed.decision
  if (!sendsMessage(decision.action)) {
    return {
      kind: 'silent',
      reason: decision.action === 'observe' ? `判断为观察（${decision.reason}）` : `判断为沉默（${decision.reason}）`,
      state,
    }
  }
  const checked = validateSocialDecision(decision, ctx)
  if (!checked.ok) return { kind: 'failed', detail: `决策被代码拦下（${checked.reason}）`, state }
  // 限频（真实 `speakVerdict`）：不放行就是"这一轮不开口"，措辞与线上完全一致。
  const verdict = presence.speakVerdict(state, ctx.nowMs, {
    judgeIntervalMs: settings.judgeIntervalMs,
    speakMinIntervalMs: settings.speakMinIntervalMs,
    speakMaxPerHour: settings.speakMaxPerHour,
  })
  if (!verdict.ok) return { kind: 'silent', reason: `判断说可以，但这一轮不开口（${String(verdict.reason)}）`, state }
  // 到这一步线上会调平台端口。组合通道**不碰平台**，直接按影子结局收尾。
  return {
    kind: 'shadow',
    action: decision.action,
    text: decision.text,
    ...(decision.action === 'reply' ? { targetMessageId: decision.targetMessageId } : {}),
    blockedBy: 'composed-shadow',
    state,
  }
}

/**
 * 跑一批示例。
 *
 * @param {object} options
 * @param {object[]} [options.cases] 语料（默认全部 41 条）
 * @param {object} options.config `readConfig()` 的 config
 * @param {object} options.persona `loadPersona()` 的结果
 * @param {{mode: string, detail: string}} options.channel
 * @param {typeof fetch} [options.fetchImpl] 自测用它打本地假服务（默认全局 fetch）
 */
export async function runCorpus({ cases = CASES, config, persona, channel, fetchImpl = globalThis.fetch }) {
  const repeatCount = config.repeat
  const settings = settingsOf()
  const records = []
  const trips = []
  const stability = []
  /**
   * 原始样本（生产提示词全文 + 输入 hash）。**默认只留在内存里**；
   * `--dump-prompts` 才写盘，而且写到本地受控目录（不进 JSONL、不进人读报告）：
   * 提示词里有人格与群消息正文，那是"本地受控存储"，不是能贴出去的东西。
   */
  const prompts = []
  for (const c of cases) {
    const nowMs = nowOf(c)
    const ctx = decisionContext({
      background: c.background,
      nowMs,
      replyMaxChars: settings.replyMaxChars,
      windowMs: settings.replyWindowMs,
    })
    const state = fakePresenceState({ nowMs, ...(c.limit ?? {}) })
    const prompt = promptFor(c, settings, persona)
    const inputHash = inputHashOf({ prompt, settings, model: config.model })
    prompts.push({ sceneId: c.id, scene: c.scene, inputHash, promptChars: [...prompt].length, prompt })
    const caseRecords = []
    for (let index = 0; index < repeatCount; index += 1) {
      const modelPort = createModelPort({ config, fetchImpl })
      const tripwire = createTripwirePlatform({ label: channel.mode })
      let outcome
      if (channel.mode === 'presence-cycle') {
        outcome = await runPresenceCycle(
          {
            groupId: GROUP_ID,
            settings,
            state,
            background: judgeEntries(c.background),
            sentLines: c.botRecent ?? [],
            nowLabel: '21:58',
            persona: persona.snapshot,
          },
          {
            clock: clockOf(nowMs),
            log: () => {},
            platform: () => tripwire.platform,
            complete: modelPort,
            recordSent: async () => {},
            // 影子闸门：**每次现取**，与线上"运行中把 live 改成 shadow"是同一条路径。
            sendGate: () => 'shadow',
            recordShadow: () => {},
          },
        )
      } else {
        outcome = await runComposed({ c, settings, persona, state, complete: modelPort, ctx })
      }
      const modelRequest = modelPort.requests[0] ?? null
      const tier = tierOf({
        raw: modelRequest?.text ?? '',
        ctx,
        decisionModule: { parseSocialDecision, validateSocialDecision, sendsMessage },
      })
      const record = caseRecord({
        caseId: c.id,
        scene: c.scene,
        scope: c.scope,
        repeatIndex: index + 1,
        repeatCount,
        inputHash,
        persona,
        config,
        promptChars: [...prompt].length,
        tier,
        execution: executionOf(outcome),
        outcome,
        modelRequest,
        cost: costOf(modelRequest?.usage, config.prices),
        annotated: c.expect,
        nowMs,
      })
      record.tripwire = tripwire.trips.length > 0
      trips.push(...tripwire.trips.map((trip) => ({ caseId: c.id, method: trip.method, label: trip.label })))
      caseRecords.push(record)
      records.push(record)
    }
    stability.push({ sceneId: c.id, scene: c.scene, stability: stabilityOf(caseRecords) })
  }
  return { records, trips, stability, settings, prompts }
}