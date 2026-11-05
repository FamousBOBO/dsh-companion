import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);

function buildRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-belief-inject-'));
  for (const dir of ['home/companion', 'home/memory', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'bot', owner: { id: 'owner-1', displayName: 'o', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-1' }, sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite', injection: { budgetChars: 2400 }, extraction: { enabled: false },
    embedding: { provider: 'local', dimensions: 128 }, wiki: { enabled: false },
  }));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({ enabled: true, mode: 'active', injection: { budgetChars: 320 } }));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', worldId: '', sessionId }) });
const ctx = () => ({ tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } });

test('A06/C3: supported beliefs are injected as current judgments; expired beliefs are not', (t) => {
  const root = buildRoot(t);
  const runtime = mountRuntime(ctx(), root, { memory: { async ingestDomainEvent() { return { status: 'accepted' }; } }, identity: identity(), now: () => T0 });
  const supported = runtime.assertBelief({ sessionId: 's', proposition: '用户搬到上海', rootEvidenceIds: ['ev:relocation'], validUntil: T0 + 3600000 });
  assert.equal(supported.ok, true);
  const expired = runtime.assertBelief({ sessionId: 's', proposition: '用户现在很忙', rootEvidenceIds: ['ev:old'], validUntil: T0 - 1000 });
  assert.equal(expired.ok, true);
  const injected = runtime.injectionFor({ sessionId: 's', budgetChars: 320 });
  assert.match(injected.text, /【判断】用户搬到上海/);
  assert.doesNotMatch(injected.text, /用户现在很忙/, 'expired beliefs must not be injected as current facts');
  assert.ok(injected.shownBeliefs >= 1);
  runtime.dispose();
});
