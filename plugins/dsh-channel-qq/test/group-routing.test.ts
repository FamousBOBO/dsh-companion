import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationRegistry } from '../src/app/conversation/registry.js'
import { GatewayHealth } from '../src/app/conversation/gateway-health.js'
import { systemClock } from '../src/ports/clock.js'
import { resolveConfig } from '../src/config.js'
import type { SessionSpec, AgentSession } from '../src/ports/agent-gateway.js'
import { createAgentGateway } from '../src/adapters/dsh-host/agents.js'
import { FakeHost } from './fakes/host.js'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

test('groups use their independent preset, permission and workspace; owner DM keeps original route', async () => {
  const opened: SessionSpec[] = []
  const config = resolveConfig({ agentPreset: 'companion', workspacePath: '/private', permissionPreset: 'danger-full-access', groupAgentPreset: 'companion-group', groupWorkspacePath: '/public', groupPermissionPreset: 'companion-group-readonly' })
  const registry = new ConversationRegistry({
    config: () => config, clock: systemClock, random: { next: () => 0.5, int: () => 0 }, health: new GatewayHealth(), log: () => {}, nudge: () => '',
    gateway: { defaultRoute: () => ({ provider: 'synthetic', model: 'synthetic' }), async reattachAll() { return { attached: 0, total: 0 } }, async saveImage() { return {} }, async open(spec) { opened.push(spec); return { id: spec.sessionId, isRunning: () => false, deliver: () => true, dispose: async () => true } as AgentSession } },
  })
  await registry.ensure('group-123', { time: 1, self_id: 10000, post_type: 'message', message_type: 'group', group_id: 123, user_id: 456 })
  await registry.ensure('dm-456', { time: 1, self_id: 10000, post_type: 'message', message_type: 'private', user_id: 456 })
  assert.deepEqual(opened.map(s => [s.sessionId, s.cwd, s.presetId, s.permissionPreset]), [
    ['qq-group-123', '/public', 'companion-group', 'companion-group-readonly'],
    ['qq-dm-456', '/private', 'companion', 'danger-full-access'],
  ])
})

test('startup history reattachment keeps group sessions in the public workspace', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'group-reattach-'))
  const previous = process.env.DSH_SESSIONS_ROOT
  process.env.DSH_SESSIONS_ROOT = root
  try {
    mkdirSync(path.join(root, 'proj', 'qq-group-123'), { recursive: true })
    mkdirSync(path.join(root, 'proj', 'qq-dm-456'), { recursive: true })
    const host = new FakeHost()
    const ctx = host.context()
    const destinations: Array<[string, string]> = []
    Object.assign(ctx, { workspaceRegistry: { async create(cwd: string) { return { path: cwd, async attachSession(id: string) { destinations.push([cwd, id]) } } } } })
    const gateway = createAgentGateway(ctx, () => {})
    assert.deepEqual(await gateway.reattachAll('/private', '/public'), { attached: 2, total: 2 })
    assert.deepEqual(destinations.sort(), [['/private', 'qq-dm-456'], ['/public', 'qq-group-123']])
  } finally {
    if (previous === undefined) delete process.env.DSH_SESSIONS_ROOT
    else process.env.DSH_SESSIONS_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})
