import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';
import { createMemory } from './memory.mjs';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../logs/test-runs');
fs.mkdirSync(testRoot, { recursive: true });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(testRoot, 'memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'home/memory'), { recursive: true });
  const manifest = { schemaVersion: 1, persona: 'bot', owner: 'owner', bot: 'bot', exportedAt: '2026-10-25T00:00:00Z' };
  const row = { id: 'astrbot:1', key: 'user_preference', value: '用户喜欢海边散步，也喜欢蓝色', memoryType: 'user_preference', realityLevel: 'real_user_fact',
    persona: 'bot', owner: 'owner', bot: 'bot', source: 'astrbot_snapshot', updatedAt: '2026-10-24T00:00:00Z' };
  fs.writeFileSync(path.join(root, 'home/memory/astrbot-import.json'), JSON.stringify({ manifest, memories: [row,
    { ...row, id: 'astrbot:2', value: '过期的海边活动', validTo: '2000-01-01T00:00:00Z' },
    { ...row, id: 'astrbot:3', memoryType: 'core_memory', value: '不要编造承诺' }] }));
  return { root, store: createStore(path.join(root, 'home/companion')) };
}

test('Chinese query retrieves noncontiguous terms, keeps source labels, and excludes expired rows', t => {
  const { root, store } = fixture(t);
  const memory = createMemory(root, store);
  assert.equal(memory.search('喜欢去海边吗')[0].id, 'astrbot:1');
  assert.equal(memory.search('海边').some(row => row.id === 'astrbot:2'), false);
  assert.equal(memory.search('完全无关的机器人维修').length, 0);
  assert.match(memory.context('海边'), /real_user_fact/);
  assert.match(memory.context('海边'), /不要编造承诺/);
  assert.ok(memory.context('海边').length < 2550);
});

test('new confirmed facts and conversation capture survive restart without treating system context as user history', t => {
  const { root, store } = fixture(t);
  store.remember('饮品', '只喝茶');
  let memory = createMemory(root, store);
  const event = { type: 'user/message', seq: 7, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天去公园了，api_key=secret123' }] } };
  memory.capture('test-session', event);
  memory.capture('test-session', event);
  memory.capture('test-session', { ...event, seq: 8, data: { source: { kind: 'runtime-context', sections: [{ name: 'companion-memory' }] }, content: [{ type: 'text', text: '不要把注入资料再次保存' }] } });
  memory = createMemory(root, createStore(path.join(root, 'home/companion')));
  assert.equal(memory.status().recentConversationCount, 1);
  assert.equal(memory.search('饮品')[0].value, '只喝茶');
  assert.equal(memory.search('公园')[0].realityLevel, 'user_utterance_not_verified_fact');
  assert.ok(!fs.readFileSync(path.join(root, 'home/memory/conversation.jsonl'), 'utf8').includes('secret123'));
});

test('archive identity mismatch fails closed', t => {
  const { root, store } = fixture(t);
  const file = path.join(root, 'home/memory/astrbot-import.json');
  const archive = JSON.parse(fs.readFileSync(file, 'utf8'));
  archive.memories[0].owner = 'another-user';
  fs.writeFileSync(file, JSON.stringify(archive));
  assert.throws(() => createMemory(root, store).search('海边'), /identity mismatch/);
});

test('archive cannot be used by a different bound owner', t => {
  const { root, store } = fixture(t);
  assert.throws(() => createMemory(root, store, 'another-user').search('海边'), /bound desktop user/);
  store.remember('私有事实', '只属于其他用户', 'another-user');
  assert.equal(createMemory(root, store, 'owner').search('私有事实').length, 0);
});
