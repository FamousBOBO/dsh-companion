/** 回合发起人：现在只记录，将来是信任分级的判据。
 *
 * 因此这里测两件事：四类发起人都能记下来（数据得先有），以及**记录它不改变行为**
 * ——`lastOrigin` 只是记录栏，任何一条路径都不该因为读它而分叉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { describeOrigin, ADMIN, PROACTIVE } = await import('../src/app/conversation/origins.js')
const { ConversationRegistry } = await import('../src/app/conversation/registry.js')
const { TurnLauncher } = await import('../src/app/conversation/turns.js')
const { GatewayHealth } = await import('../src/app/conversation/gateway-health.js')
const { PromptComposer } = await import('../src/app/conversation/prompt-composer.js')
const { createPersonaPack } = await import('../src/adapters/persona/fs-pack.js')
const { systemClock, systemRandom } = await import('../src/ports/clock.js')
const { resolveConfig } = await import('../src/config.js')
const { FakeHost } = await import('./fakes/host.js')

const composer = new PromptComposer(createPersonaPack())

/** 一套只有登记表 + 回合发起器的极小装备（不需要流水线）。 */
function harness(): {
  registry: InstanceType<typeof ConversationRegistry>
  turns: InstanceType<typeof TurnLauncher>
  host: InstanceType<typeof FakeHost>
} {
  const config = resolveConfig({ selfId: 1, admins: [280], primaryGroup: 107, workspacePath: '/tmp/ws' })
  const host = new FakeHost({ workspacePath: '/tmp/ws' })
  const { createAgentGateway } = require0()
  const gateway = createAgentGateway(host.context(), () => {})
  const health = new GatewayHealth()
  const registry = new ConversationRegistry({
    gateway, health, clock: systemClock, random: systemRandom, log: () => {},
    config: () => config, nudge: () => composer.gatewayNudge(),
  })
  const turns = new TurnLauncher({
    registry, prompts: composer, clock: systemClock, log: () => {}, config: () => config,
    openSentLog: async () => ({ render: () => '' }),
  })
  return { registry, turns, host }
}

// 动态 import 在这里是同步取用的，包一层免得每处都写 await import。
function require0(): { createAgentGateway: typeof import('../src/adapters/dsh-host/agents.js').createAgentGateway } {
  return { createAgentGateway }
}
const { createAgentGateway } = await import('../src/adapters/dsh-host/agents.js')

const GROUP_EVENT = {
  time: 1, self_id: 1, post_type: 'message', message_type: 'group',
  group_id: 107, user_id: 999, message_id: 1,
} as never

test('describeOrigin：四类发起人各有一行', () => {
  assert.equal(describeOrigin({ kind: 'user', userId: 999 }), 'user:999')
  assert.equal(describeOrigin({ kind: 'notice', userId: 999 }), 'notice:999')
  assert.equal(describeOrigin(PROACTIVE), 'proactive')
  assert.equal(describeOrigin(ADMIN), 'admin')
})

test('新记录一开始没有发起人（还没跑过回合）', () => {
  const { registry } = harness()
  const record = registry.getOrCreate('group-107', GROUP_EVENT)
  assert.equal(record.lastOrigin, null)
})

test('submit 记下发起人，且不改变投递行为', async () => {
  const { registry, turns, host } = harness()
  const record = await registry.ensure('group-107', GROUP_EVENT)
  turns.submit(record, '一包', [], { kind: 'user', userId: 999 })
  assert.deepEqual(record.lastOrigin, { kind: 'user', userId: 999 })
  assert.equal(host.lastTextFor('group-107'), '一包', '投递内容与发起人无关')

  turns.submit(record, '又一包', [], ADMIN)
  assert.deepEqual(record.lastOrigin, ADMIN, '后一轮覆盖前一轮')
})

test('后台指令走 admin 这一类', async () => {
  const { registry, turns } = harness()
  await turns.adminPrompt('去看看工作区')
  const record = registry.get('dm-280')
  assert.deepEqual(record?.lastOrigin, ADMIN)
})
