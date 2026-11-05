import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { resolveModuleRoot } = await import('./test-fixtures/module-root.mjs');
process.env.DSH_COMPANION_MODULE_ROOT = resolveModuleRoot(root).root;
const { mountCompanion } = await import('./index.mjs');

test('real DSH tool definitions, first-step recall hook, conversation capture and reload work locally', async t => {
  // Temporary fixture outside the repository: a test run must leave the tree clean.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-companion-integration-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'home/memory'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'home/companion'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'home/companion/identity.json'), JSON.stringify({ schemaVersion: 1, persona: 'bot',
    owner: { id: 'owner', displayName: 'Test user', platform: 'qq' }, desktop: { mode: 'local-owner', userId: 'owner' }, sessions: {} }));
  fs.writeFileSync(path.join(fixture, 'workspace/PERSONA.md'), 'Synthetic test persona');
  fs.writeFileSync(path.join(fixture, 'home/memory/astrbot-import.json'), JSON.stringify({
    manifest: { schemaVersion: 1, persona: 'bot', owner: 'owner', bot: 'bot' },
    memories: [{ id: 'test:1', owner: 'owner', bot: 'bot', persona: 'bot', key: 'preference', value: '喜欢星空摄影', memoryType: 'user_preference', realityLevel: 'real_user_fact' }],
  }));
  const mount = () => {
    const tools = new Map();
    const hooks = new Map();
    mountCompanion({ tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} },
      on(name, handler) { hooks.set(name, handler); } }, fixture);
    return { tools, hooks };
  };
  const first = mount();
  const exec = { agent: { session: { id: 'test-session' } } };
  await assert.rejects(first.tools.get('companion_recall').execute({ query: '星空' }, {}), /runtime session/);
  const recalled = JSON.parse(await first.tools.get('companion_recall').execute({ query: '星空', limit: 3 }, exec));
  assert.equal(recalled[0].id, 'test:1');
  const decision = { kind: 'enter', startsRequestSeries: true, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '你记得星空摄影吗' }] }] };
  const event = { agent: { session: { id: 'test-session' } }, step: 1, signal: new AbortController().signal };
  const entered = await first.hooks.get('agent/pre-step')(event, async () => decision);
  assert.equal(entered.startsRequestSeries, true);
  assert.equal(entered.messages.length, 2);
  assert.equal(entered.messages[1].source.kind, 'companion-memory');
  assert.match(entered.messages[1].content[0].text, /喜欢星空摄影/);
  assert.match(entered.messages[1].content[0].text, /Test user/);
  assert.equal(JSON.parse(await first.tools.get('companion_identity').execute({}, exec)).userId, 'owner');
  const later = await first.hooks.get('agent/pre-step')({ ...event, step: 2 }, async () => decision);
  assert.equal(later.messages.length, 1);
  await first.tools.get('companion_remember').execute({ key: '测试事实', value: '确认的本地测试事实' }, exec);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'home/companion/state.json'), 'utf8')).memories['测试事实'].userId, 'owner');
  first.hooks.get('session/event')({ id: 'test-session' }, { type: 'user/message', seq: 1, time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '合成测试对话' }] } });
  const second = mount();
  assert.equal(JSON.parse(await second.tools.get('companion_recall').execute({ query: '测试事实' }, exec))[0].value, '确认的本地测试事实');
  const status = JSON.parse(await second.tools.get('companion_status').execute({}, exec));
  assert.equal(status.memory.recentConversationCount, 1);
  assert.equal(status.identity.userId, 'owner');
  const identityFile = path.join(fixture, 'home/companion/identity.json');
  const binding = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
  binding.sessions['test-session'].userId = 'another-user';
  fs.writeFileSync(identityFile, JSON.stringify(binding));
  await assert.rejects(second.tools.get('companion_recall').execute({ query: '星空' }, exec), /binding conflicts/);
  binding.owner.id = 'another-user';
  binding.desktop.userId = 'another-user';
  binding.sessions = {};
  fs.writeFileSync(identityFile, JSON.stringify(binding));
  await assert.rejects(second.tools.get('companion_recall').execute({ query: '星空' }, exec), /owner changed/);
});
