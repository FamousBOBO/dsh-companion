/** 自主接话的限频记账（`core/presence.ts`）单测。
 *
 * 这一层决定"此刻能不能判、能不能说"，而它只管**记账**：不读时钟、不发消息。
 * 所以每个用例都能用一个假时间把分支走一遍，没有 sleep、没有等待。
 *
 * 被钉住的四条口径（对应 §0.3 与验收清单 1/5/6）：
 *   1. 判断与发言分开记：判断密、发言稀，混成一个计数器两边都不满足；
 *   2. **只有真实回执才占额度**：判断失败/模型沉默绝不记成"说过一次话"；
 *   3. 连续失败到阈值就暂停一阵（别每 50 秒去撞坏掉的模型）；
 *   4. `emptyPresenceState(now)` 之后既不会立刻回放旧批次、也不会瞬间开口（热加载不能补发）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { HOUR_MS, emptyPresenceState, judgeVerdict, recordJudge, recordSpeak, recentSends, speakVerdict } =
  await import('../src/core/presence.js')

type PresenceLimits = import('../src/core/presence.js').PresenceLimits
type PresenceState = import('../src/core/presence.js').PresenceState

/** §0.1 的部署值；单个用例只改它关心的字段。 */
function limits(over: Partial<PresenceLimits> = {}): PresenceLimits {
  return { judgeIntervalMs: 50_000, speakMinIntervalMs: 300_000, speakMaxPerHour: 3, ...over }
}

/** 一个"上次判断/发言都在很久以前"的状态：好让用例只受被测的那一条限制影响。 */
function warmState(): PresenceState {
  return { judgeAtMs: -HOUR_MS * 10, speakAtMs: -HOUR_MS * 10, sentTimes: [], failures: 0, pauseUntilMs: 0 }
}

// ── 1. 判断最小间隔 ───────────────────────────────────────────────────────

test('判断间隔：不到 judgeIntervalMs 就判不了', () => {
  const state = emptyPresenceState(0)
  assert.deepEqual(judgeVerdict(state, 0, limits(), 3), { ok: false, reason: 'judge-too-soon' }, '0ms 之后当然太早')
  assert.deepEqual(judgeVerdict(state, 49_999, limits(), 3), { ok: false, reason: 'judge-too-soon' }, '差 1ms 也不行')
  assert.deepEqual(judgeVerdict(state, 50_000, limits(), 3), { ok: true }, '够间隔就放行')
})

test('判断间隔：没有新旁听就不判（no-context 优先于"太早"）', () => {
  // pending = 0 且刚判过：此时"没有新内容"才是真正的原因，日志要能说清。
  assert.deepEqual(judgeVerdict(emptyPresenceState(0), 0, limits(), 0), { ok: false, reason: 'no-context' })
  assert.deepEqual(judgeVerdict(warmState(), 9_999_999, limits(), 0), { ok: false, reason: 'no-context' })
})

test('判断与发言分开记账：说话冷却中仍然可以判断', () => {
  const state = emptyPresenceState(0)
  const justSpoke = recordSpeak(state, 60_000)
  assert.deepEqual(speakVerdict(justSpoke, 60_001, limits()), { ok: false, reason: 'speak-cooldown' })
  assert.deepEqual(judgeVerdict(justSpoke, 120_000, limits(), 2), { ok: true }, '刚说过话不妨碍继续判断')
})

// ── 2. 发言冷却 ───────────────────────────────────────────────────────────

test('发言冷却：不到 speakMinIntervalMs 就不开口', () => {
  const state = emptyPresenceState(0)
  assert.deepEqual(speakVerdict(state, 299_999, limits()), { ok: false, reason: 'speak-cooldown' })
  assert.deepEqual(speakVerdict(state, 300_000, limits()), { ok: true })
})

test('发言冷却：两道限频同时满足才放行（冷却优先于小时额度）', () => {
  // 把所有额度用光，同时也还在冷却中：先说清的应该是冷却。
  let state = emptyPresenceState(-HOUR_MS * 10)
  for (const at of [0, 300_000, 600_000]) state = recordSpeak(state, at)
  assert.deepEqual(speakVerdict(state, 600_001, limits()), { ok: false, reason: 'speak-cooldown' })
  // 冷却过了，但一小时内已经说了 3 次：
  assert.deepEqual(speakVerdict(state, 900_000, limits()), { ok: false, reason: 'hour-quota' })
})

// ── 3. 每小时上限（滚动窗口）──────────────────────────────────────────────

test('每小时上限：满 3 次之后拒绝，窗口按 now 滚动而不是整点清零', () => {
  let state = emptyPresenceState(-HOUR_MS * 10)
  const spokenAt = [300_000, 600_000, 900_000]
  for (const at of spokenAt) {
    assert.deepEqual(speakVerdict(state, at, limits()), { ok: true }, `${String(at)} 时应该还有额度`)
    state = recordSpeak(state, at)
  }
  assert.deepEqual(speakVerdict(state, 1_200_000, limits()), { ok: false, reason: 'hour-quota' }, '一小时 3 次用完了')

  // 最早那次（300_000）滑出窗口之后，额度回来一个 —— 不是等整点，也不是永久封禁。
  assert.deepEqual(recentSends(state, 300_000 + HOUR_MS - 1), [300_000, 600_000, 900_000], '差 1ms 时还在窗口里')
  assert.deepEqual(recentSends(state, 300_000 + HOUR_MS), [600_000, 900_000], '满一小时就滑出窗口')
  assert.deepEqual(speakVerdict(state, 300_000 + HOUR_MS, limits()), { ok: true }, '满一小时后额度恢复')
})

test('每小时上限：上限值来自配置（speakMaxPerHour=1 就只能说一次）', () => {
  const tight = limits({ speakMaxPerHour: 1 })
  const state = recordSpeak(emptyPresenceState(-HOUR_MS * 10), 300_000)
  assert.deepEqual(speakVerdict(state, 600_000, tight), { ok: false, reason: 'hour-quota' })
})

// ── 4. 只有 recordSpeak 才占额度 ──────────────────────────────────────────

test('只有真实回执才占发言额度：判断（spoke/silent/failed）都不推进发言计数', () => {
  const start = emptyPresenceState(-HOUR_MS * 10)
  const afterSpoke = recordJudge(start, 10_000, 'spoke', limits())
  const afterSilent = recordJudge(afterSpoke, 20_000, 'silent', limits())
  const afterFailed = recordJudge(afterSilent, 30_000, 'failed', limits())

  for (const [label, state] of [['spoke', afterSpoke], ['silent', afterSilent], ['failed', afterFailed]] as const) {
    assert.deepEqual(state.sentTimes, [], `judge(${label}) 不能记成一次发言`)
    assert.equal(state.speakAtMs, start.speakAtMs, `judge(${label}) 不能推进发言冷却`)
    assert.deepEqual(speakVerdict(state, 30_000, limits()), { ok: true }, `judge(${label}) 之后额度必须还在`)
  }

  const spoken = recordSpeak(afterFailed, 40_000)
  assert.deepEqual(spoken.sentTimes, [40_000], '只有 recordSpeak 写入 sentTimes')
  assert.equal(spoken.speakAtMs, 40_000)
})

test('判断成功会清掉连续失败计数（模型恢复之后暂停不再延续）', () => {
  const tight = limits({ maxConsecutiveFailures: 3, speakMinIntervalMs: 1 })
  let state = emptyPresenceState(0)
  state = recordJudge(state, 60_000, 'failed', tight)
  state = recordJudge(state, 120_000, 'failed', tight)
  assert.equal(state.failures, 2)

  state = recordJudge(state, 180_000, 'silent', tight)
  assert.equal(state.failures, 0, '"模型说沉默"是成功判断，不是失败')
  assert.equal(state.pauseUntilMs, 0, '还没到阈值，从来没暂停过')
})

// ── 5. 连续失败到阈值 → paused ────────────────────────────────────────────

test('连续判断失败到阈值进入 paused：判断与发言都被挡住，到点自动解除', () => {
  const tight = limits({ maxConsecutiveFailures: 3, failurePauseMs: 600_000, speakMinIntervalMs: 1 })
  let state = emptyPresenceState(0)

  state = recordJudge(state, 60_000, 'failed', tight)
  state = recordJudge(state, 120_000, 'failed', tight)
  assert.equal(state.failures, 2)
  assert.equal(state.pauseUntilMs, 0, '还没到阈值，不该暂停')
  assert.deepEqual(judgeVerdict(state, 200_000, tight, 5), { ok: true }, '两次失败之后仍可再试')

  state = recordJudge(state, 180_000, 'failed', tight)
  assert.equal(state.failures, 3)
  assert.equal(state.pauseUntilMs, 780_000, '第三次失败 → 暂停到 now + failurePauseMs')

  assert.deepEqual(judgeVerdict(state, 180_000, tight, 5), { ok: false, reason: 'paused' })
  assert.deepEqual(speakVerdict(state, 180_000, tight), { ok: false, reason: 'paused' }, '暂停期间哪怕判断放行也不许开口')
  assert.deepEqual(judgeVerdict(state, 779_999, tight, 5), { ok: false, reason: 'paused' }, '差 1ms 仍在暂停')
  assert.deepEqual(judgeVerdict(state, 780_000, tight, 5), { ok: true }, '到点自动解除（不是永久拉黑）')
})

test('paused 优先于 no-context：日志里要说"暂停中"，而不是"没有上下文"', () => {
  const tight = limits({ maxConsecutiveFailures: 1, failurePauseMs: 600_000 })
  const state = recordJudge(emptyPresenceState(0), 60_000, 'failed', tight)
  assert.deepEqual(judgeVerdict(state, 61_000, tight, 0), { ok: false, reason: 'paused' })
})

test('失败阈值与暂停时长可以配置（缺省 3 次 / 10 分钟）', () => {
  const defaults = limits()
  let state = emptyPresenceState(0)
  state = recordJudge(state, 60_000, 'failed', defaults)
  state = recordJudge(state, 120_000, 'failed', defaults)
  assert.equal(state.pauseUntilMs, 0, '默认阈值是 3，两次还不够')
  state = recordJudge(state, 180_000, 'failed', defaults)
  assert.equal(state.pauseUntilMs, 180_000 + 600_000, '默认暂停 10 分钟')
})

// ── 6. 重置不能补发 ───────────────────────────────────────────────────────

test('emptyPresenceState(now) 之后立刻判断被 judge-too-soon 挡住（热加载/重启不回放旧批次）', () => {
  const at = 1_700_000_000_000
  assert.deepEqual(
    judgeVerdict(emptyPresenceState(at), at, limits(), 12),
    { ok: false, reason: 'judge-too-soon' },
    '刚加载完就有一堆旧旁听，也必须先等一个间隔：不能"重启即回放"',
  )
})

test('emptyPresenceState(now) 之后也不会瞬间开口（speak-at 也置成 now）', () => {
  const at = 1_700_000_000_000
  const state = emptyPresenceState(at)
  assert.equal(state.judgeAtMs, at, 'judgeAtMs = now 是故意的')
  assert.equal(state.speakAtMs, at, 'speakAtMs = now 是故意的')
  assert.deepEqual(speakVerdict(state, at, limits()), { ok: false, reason: 'speak-cooldown' })
  assert.deepEqual(speakVerdict(state, at, limits()), { ok: false, reason: 'speak-cooldown' })
  assert.deepEqual(speakVerdict(state, at + 300_000, limits()), { ok: true }, '等满冷却才允许')
})

test('emptyPresenceState：计数与暂停都是从零开始的新状态', () => {
  const state = emptyPresenceState(0)
  assert.deepEqual(state, { judgeAtMs: 0, speakAtMs: 0, sentTimes: [], failures: 0, pauseUntilMs: 0 })
})

// ── 7. recentSends 的窗口边界 ─────────────────────────────────────────────

test('recentSends：一小时前的记录被丢掉，边界是开区间（正好一小时不算）', () => {
  const state: PresenceState = { judgeAtMs: 0, speakAtMs: 0, sentTimes: [1_000_000, 4_000_000, 4_600_000], failures: 0, pauseUntilMs: 0 }
  const now = 4_600_000

  assert.deepEqual(recentSends(state, now), [4_000_000, 4_600_000], '1_000_000 那条已经滑出窗口')
  // now - HOUR_MS = 1_000_000：正好等于边界的那条不算"一小时内"。
  assert.deepEqual(recentSends({ ...state, sentTimes: [1_000_000] }, now), [], '正好一小时前的记录要丢掉')
  assert.deepEqual(recentSends({ ...state, sentTimes: [1_000_001] }, now), [1_000_001], '多 1ms 就算还在窗口里')
})

test('recordSpeak 顺带裁剪窗口：长跑时 sentTimes 不会无限增长', () => {
  let state: PresenceState = { judgeAtMs: 0, speakAtMs: 0, sentTimes: [0, 1_000], failures: 0, pauseUntilMs: 0 }
  state = recordSpeak(state, HOUR_MS + 2_000)
  assert.deepEqual(state.sentTimes, [HOUR_MS + 2_000], '一小时多前的两条被裁掉了，只留本次')
})
