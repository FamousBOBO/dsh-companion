/** 后台「群社交」页（P8 §5.4）的测试。
 *
 * 这一页的风险不是"算错数字"，而是**说了不该说的话**：
 *   - 展示群号 / 正文 / 私人记忆（§5.4 最后一句明令禁止）；
 *   - 关着（off）时给一份"全零但看起来正常"的表，让人以为一切健康；
 *   - 把"没有样本"写成"零延迟"。
 *
 * 所以这里的断言大多是否定式的：**不许出现**什么。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { socialResource } from '../src/features/inbound/presence-resource.js'
import type { GroupSchedulerStats } from '../src/app/inbound/presence-scheduler.js'

const GROUP = 1_453_261_531
const NOW = new Date(2026, 10, 8, 22, 0, 0).getTime()

function stats(over: Partial<GroupSchedulerStats> = {}): GroupSchedulerStats {
  return {
    lastMessageAtMs: NOW - 5_000,
    lastJudgeAtMs: NOW - 2_000,
    batchStartedAtMs: 0,
    batchCount: 0,
    lastJudgeDurationMs: 1_200,
    skippedByQuota: 3,
    skippedByBusy: 1,
    skippedByPause: 0,
    judgments: 4,
    spoken: 2,
    starvationWarnings: 0,
    shadowWouldSend: 1,
    modelLatencyMs: 4_000,
    modelCalls: 4,
    sendLatencyMs: 240,
    sendAttempts: 2,
    sendFailures: 0,
    lastBatchWaitMs: 6_000,
    eventContextInjected: 3,
    eventContextDenied: 1,
    ...over,
  }
}

function resource(over: {
  mode?: string
  presence?: unknown
  guardMode?: string
  stickers?: boolean
} = {}) {
  return socialResource({
    mode: () => over.mode ?? 'shadow',
    presence: () => (over.presence === undefined
      ? { diagnostics: () => ({ groups: [{ groupId: GROUP, ...stats() }], pending: 1 }) }
      : over.presence) as never,
    guardMode: () => over.guardMode ?? 'warn',
    stickers: () => over.stickers === true,
    now: () => NOW,
  })
}

type Row = Record<string, unknown>
const rowsOf = (value: Row): Row[] => value['groups'] as Row[]

/** 调一次 `list()`（`AdminResource` 上它可选，测试里一定在）。 */
function listOf(res: { list?: (query: URLSearchParams) => unknown }): Row {
  const list = res.list
  assert.equal(typeof list, 'function')
  return list?.(new URLSearchParams()) as Row
}

test('正常数据：模式、计数、分段耗时都在，且**不含群号原文**', () => {
  const value = listOf(resource()) as Row
  assert.equal(value['mode'], 'shadow')
  assert.equal(value['enabled'], true)
  const row = rowsOf(value)[0] ?? {}
  assert.equal(row['judgments'], 4)
  assert.equal(row['wouldSend'], 1)
  assert.equal(row['sent'], 2)
  assert.equal(row['denials'], 4, '拒绝数 = 额度 + 在途 + 暂停')
  assert.equal(row['modelMsAvg'], 1_000)
  assert.equal(row['sendMsAvg'], 120)
  // 脱敏：只留末四位，完整群号一个字符都不许出现。
  const text = JSON.stringify(value)
  assert.equal(text.includes(String(GROUP)), false, '不许出现完整群号')
  assert.ok(String(row['group']).endsWith('1531'))
})

test('off：明确说"关着"，不给一份全零的健康表', () => {
  const value = listOf(resource({ mode: 'off', presence: null })) as Row
  assert.equal(value['enabled'], false)
  assert.equal(value['mode'], 'off')
  assert.match(String(value['note']), /off/)
  assert.deepEqual(value['groups'], [])
})

test('执行器没装配但模式不是 off：说明"未装配"，不假装关着', () => {
  const value = listOf(resource({ mode: 'live', presence: null })) as Row
  assert.equal(value['enabled'], false)
  assert.match(String(value['note']), /未装配/)
})

test('诊断抛错：如实说"读取失败"，且不让整页 500', () => {
  const value = resource({
    presence: { diagnostics: () => { throw new Error('boom') } },
  }).list!(new URLSearchParams()) as Row
  assert.equal(value['enabled'], true)
  assert.match(String(value['note']), /诊断读取失败/)
  assert.deepEqual(value['groups'], [])
})

test('没有样本时 p50/p95 是 null，不是 0（0 会被读成"零延迟"）', () => {
  const value = resource({
    presence: { diagnostics: () => ({ groups: [{ groupId: GROUP, ...stats({ judgments: 0, lastJudgeDurationMs: 0 }) }], pending: 0 }) },
  }).list!(new URLSearchParams()) as Row
  const summary = value['summary'] as Row
  assert.equal(summary['judgeP50Ms'], null)
  assert.equal(summary['judgeP95Ms'], null)
  assert.equal(rowsOf(value)[0]?.['lastJudgeMs'], null)
})

test('有多个群时给 p50/p95（只在有样本的群上算）', () => {
  const value = resource({
    presence: {
      diagnostics: () => ({
        groups: [
          { groupId: GROUP, ...stats({ lastJudgeDurationMs: 1_000 }) },
          { groupId: GROUP + 1, ...stats({ lastJudgeDurationMs: 3_000 }) },
          { groupId: GROUP + 2, ...stats({ judgments: 0, lastJudgeDurationMs: 0 }) },
        ],
        pending: 0,
      }),
    },
  }).list!(new URLSearchParams()) as Row
  const summary = value['summary'] as Row
  assert.equal(summary['groups'], 3)
  assert.ok(Number(summary['judgeP95Ms']) >= 1_000)
})

test('影子记录只给理由分类，**不给正文**', () => {
  const value = resource({
    presence: {
      diagnostics: () => ({ groups: [], pending: 0 }),
      shadowLedger: () => [{ groupId: GROUP, action: 'reply', reason: '在问参数', atMs: NOW - 1_000, blockedBy: 'shadow' }],
    },
  }).list!(new URLSearchParams()) as Row
  const shadow = value['shadow'] as Row[]
  assert.equal(shadow.length, 1)
  const entry = shadow[0] ?? {}
  assert.equal(entry['action'], 'reply')
  assert.equal(entry['mode'], 'shadow')
  // 只允许这些键：多一个都可能是在泄露正文。
  assert.deepEqual(Object.keys(entry).sort(), ['action', 'ageMs', 'at', 'group', 'mode', 'reason'])
})

test('模式与复核档位都直接来自现取函数（页面显示的必须就是闸门读的那个值）', () => {
  let mode = 'live'
  let guard = 'warn'
  const res = socialResource({
    mode: () => mode,
    presence: () => ({ diagnostics: () => ({ groups: [], pending: 0 }) }),
    guardMode: () => guard,
    stickers: () => false,
    now: () => NOW,
  })
  assert.equal((res.list!(new URLSearchParams()) as Row)['mode'], 'live')
  mode = 'shadow'
  guard = 'enforce'
  const second = res.list!(new URLSearchParams()) as Row
  assert.equal(second['mode'], 'shadow', '每次调用都重新问一次，不缓存')
  assert.equal(second['guardMode'], 'enforce')
})

test('这一页是只读的：没有动作（不给"点一下就发"的入口）', () => {
  const res = resource()
  assert.equal(typeof res.list, 'function')
  assert.equal(res.actions, undefined, '诊断页不提供任何动作')
})
