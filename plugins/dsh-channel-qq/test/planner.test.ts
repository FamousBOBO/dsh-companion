/** P6g 群聊准入（`group.planner`）的测试。
 *
 * 四条不能少的性质：
 *   1. **被叫到与私聊永远说话**（规则再严也不能把 @ 她的话挡掉）；
 *   2. **三档语义分开**：`ignore` 是"确定不要"，`consider` 是"看情况"——
 *      `consider` 必须保留现状行为（进队列、交给概率门），不能悄悄变成放行；
 *   3. **每条判定都有具名理由**（日志/后台要能回答"为什么没理它"）；
 *   4. **关着开关时判定根本不参与**（由 golden 与既有入站测试钉住整条流水线，
 *      这里只测纯函数本身）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { planInbound } = await import('../src/core/planner.js')

const base = {
  isGroup: true,
  called: false,
  requireMention: false,
  fromBot: false,
  hasText: true,
}

test('私聊永远说话（那条通道上没有人替她把话挡下来）', () => {
  const plan = planInbound({ ...base, isGroup: false })
  assert.equal(plan.decision, 'speak')
  assert.equal(plan.reason, 'private')
})

test('被叫到就说话，且优先级高于其他一切规则', () => {
  // 即便"要求 @ 才回"开着、发送者是机器人、只有表情——被叫到就是要回。
  const plan = planInbound({ ...base, called: true, requireMention: true, fromBot: true, hasText: false })
  assert.equal(plan.decision, 'speak')
  assert.equal(plan.reason, 'called')
})

test('要求 @ 才回且没被叫：确定不要（与现状的 requireMention 门同一条判据）', () => {
  const plan = planInbound({ ...base, requireMention: true })
  assert.equal(plan.decision, 'ignore')
  assert.equal(plan.reason, 'require-mention')
})

test('另一个机器人发的：不要（回它只会变成两个 bot 互相刷屏）', () => {
  const plan = planInbound({ ...base, fromBot: true })
  assert.equal(plan.decision, 'ignore')
  assert.equal(plan.reason, 'from-bot')
})

test('只有表情/图片、没正文：不要（没有可接的话头）', () => {
  const plan = planInbound({ ...base, hasText: false })
  assert.equal(plan.decision, 'ignore')
  assert.equal(plan.reason, 'non-text')
})

test('其余够格的群消息：看情况（进队列、交给攒批与概率门——现状行为）', () => {
  const plan = planInbound(base)
  assert.equal(plan.decision, 'consider')
  assert.equal(plan.reason, 'candidate')
})

test('每一档都带具名理由（日志与后台靠它回答"为什么没理它"）', () => {
  const cases = [
    { ...base, isGroup: false },
    { ...base, called: true },
    { ...base, requireMention: true },
    { ...base, fromBot: true },
    { ...base, hasText: false },
    base,
  ]
  for (const input of cases) {
    const plan = planInbound(input)
    assert.ok(plan.reason.length > 0, '理由不能为空')
    assert.ok(['speak', 'consider', 'ignore'].includes(plan.decision))
  }
})

test('判定是纯函数：同样的输入永远同样的结论', () => {
  const input = { ...base }
  assert.deepEqual(planInbound(input), planInbound({ ...input }))
})
