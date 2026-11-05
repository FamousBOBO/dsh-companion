/** P6g 闸门的适配层测试：`plannerAllows` 把「开关 + 事件 + 配置」翻译成放行/拦下。
 *
 * 纯判定在 `test/planner.test.ts` 里测；这里测**接线**——开关关着必须一个字节都不跑，
 * 开着时四种拦下理由各自生效，且每条都留下具名日志。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { plannerAllows } = await import('../src/app/inbound/planner-gate.js')

function config(overrides: Record<string, unknown> = {}) {
  return {
    groupEnabled: true,
    requireMention: false,
    debug: false,
    injectMode: { enabled: false, wakeIdle: true },
    imageRecognition: { enabled: false, serverOcr: false, maxPerMessage: 0 },
    batching: { windowMs: 1000, maxMessages: 10, maxChars: 1000 },
    contextBudget: { compactChars: 1000 },
    primaryGroup: 1,
    talkValue: 0.5,
    keywordTriggers: [],
    keywordReactions: [],
    selfId: 100,
    ...overrides,
  } as never
}

function event(userId: number) {
  return { user_id: userId } as never
}

function parsed(text: string) {
  return { plainText: text } as never
}

function gate(cfg: unknown) {
  const logs: string[] = []
  return {
    logs,
    allows: (userId: number, text: string, called: boolean) =>
      plannerAllows(
        { config: () => cfg as never, log: (line) => logs.push(line) },
        'group-1', event(userId), parsed(text), called,
        (cfg as { requireMention: boolean }).requireMention,
      ),
  }
}

test('开关关着：一律放行，且不产生任何日志（默认关 = 行为一字不改）', () => {
  const g = gate(config({ planner: { enabled: false } }))
  assert.equal(g.allows(100, '', false), true)
  assert.equal(g.allows(200, '你好', false), true)
  assert.deepEqual(g.logs, [])
})

test('开关缺省（旧配置）：同样放行', () => {
  const g = gate(config())
  assert.equal(g.allows(100, '', false), true)
})

test('开关开着：被叫到一定放行（规则再严也不能挡 @ 她的话）', () => {
  const g = gate(config({ planner: { enabled: true }, requireMention: true }))
  assert.equal(g.allows(200, '在吗', true), true)
})

test('开关开着：自环（自己的消息回来）拦下并记理由', () => {
  const g = gate(config({ planner: { enabled: true } }))
  assert.equal(g.allows(100, '我自己的消息', false), false)
  assert.match(g.logs.at(-1) ?? '', /from-bot/)
})

test('开关开着：只有表情/图片没正文拦下并记理由', () => {
  const g = gate(config({ planner: { enabled: true } }))
  assert.equal(g.allows(200, '   ', false), false)
  assert.match(g.logs.at(-1) ?? '', /non-text/)
})

test('开关开着：要求 @ 且没被叫，拦下并记理由', () => {
  const g = gate(config({ planner: { enabled: true }, requireMention: true }))
  assert.equal(g.allows(200, '随便说一句', false), false)
  assert.match(g.logs.at(-1) ?? '', /require-mention/)
})

test('开关开着：够格的普通群消息放行（交给攒批与概率门——现状行为）', () => {
  const g = gate(config({ planner: { enabled: true } }))
  assert.equal(g.allows(200, '今天吃啥', false), true)
  assert.deepEqual(g.logs, [])
})
