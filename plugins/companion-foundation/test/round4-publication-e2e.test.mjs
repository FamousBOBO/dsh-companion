import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// C4-3 装配级测试：从 `mountCompanion` 装起来，再读 runtime 自己的 status。
//
// 审查要求"经既有装配路径真的传进去 + 装配级测试（不是直接注入参数）"。之前证明的是"FD 会调用
// setAgendaPublication、runtime 会显示它" —— 两段各自成立，不等于装配起来之后成立。

const T0 = Date.UTC(2026, 10, 21, 3, 0, 0);

function hostModuleRoot() {
  const explicit = process.env.DSH_COMPANION_MODULE_ROOT;
  if (explicit) {
    return fs.existsSync(path.join(explicit, '@deepseek-ai/dsh-tools/lib/index.js'))
      && fs.existsSync(path.join(explicit, '@deepseek-ai/dsh-llm/lib/index.js')) ? explicit : '';
  }
  const builtin = String(process.env.DSH_COMPANION_MODULE_ROOT ?? '').trim();
  return fs.existsSync(path.join(builtin, '@deepseek-ai/dsh-tools/lib/index.js')) ? builtin : '';
}

const FOUND_ROOT = hostModuleRoot();
if (FOUND_ROOT) process.env.DSH_COMPANION_MODULE_ROOT = FOUND_ROOT;
const SKIP = FOUND_ROOT === '' ? 'host module root not found (set DSH_COMPANION_MODULE_ROOT) — the assembly cannot be built' : false;

function buildRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-e2e-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'companion', 'runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    agenda: { enabled: true },
    p2: { activities: { enabled: false }, planning: { enabled: false }, share: { enabled: false } },
  }, null, 2), 'utf8');
  for (const dir of ['workspace', 'memory', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace', 'PERSONA.md'), 'bot', 'utf8');
  // A complete identity: `createIdentity` validates every field and refuses a partial one.
  fs.writeFileSync(path.join(root, 'home', 'companion', 'identity.json'), JSON.stringify({
    schemaVersion: 1,
    owner: { id: 'owner-1', displayName: '主人' },
    persona: 'bot',
    desktop: { mode: 'local-owner', userId: 'owner-1' },
    sessions: {},
  }, null, 2), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } });
  return root;
}

/** The host context shape the assembly actually needs (same as the existing end-to-end test). */
function hostContext({ refuseProvide = false } = {}) {
  const bag = {};
  const logs = [];
  return {
    bag,
    logs,
    ctx: {
      tools: { register: () => {} },
      systemPrompt: { section: () => {} },
      get: name => bag[name],
      provide(name, value) {
        if (refuseProvide) throw new Error('service already published');
        bag[name] = value;
      },
      set(name, value) { bag[name] = value; },
      on: () => {}, once: () => {}, off: () => {}, emit: () => {},
      effect: fn => (typeof fn === 'function' ? fn() : undefined),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    },
  };
}

test('C4-3：装配后 runtime 的 diagnostics 能读到 publication（命中 → 1/measured）', { skip: SKIP }, async t => {
  const root = buildRoot(t);
  const { mountCompanion } = await import('../../companion-foundation/index.mjs');
  const { ctx, bag } = hostContext();
  const mounted = await mountCompanion(ctx, root);
  t.after(() => { try { mounted?.cognitive?.dispose?.(); } catch { /* disposed */ } });

  assert.ok(bag.companionAgenda, 'the agenda service was published through the host context');
  const status = mounted.cognitive.status({ sessionId: 'session-a' });
  const publication = status?.diagnostics?.observability?.groups?.reminders?.metrics?.publication
    ?? status?.observability?.groups?.reminders?.metrics?.publication;
  assert.ok(publication, `the diagnostics must expose agenda.publication (got ${JSON.stringify(Object.keys(status ?? {}))})`);
  assert.equal(publication.value, 1, `a verified publish reads as 1 (got ${JSON.stringify(publication)})`);
  assert.equal(publication.honest, 'measured');
  assert.equal(String(publication.source).includes('tier='), true, 'and it says which tier won');
});

test('C4-3：装配但发布被拒（名字被占）→ 0/measured，不是 not-wired', { skip: SKIP }, async t => {
  const root = buildRoot(t);
  const { mountCompanion } = await import('../../companion-foundation/index.mjs');
  const theirs = { owner: 'someone-else' };
  const { ctx, bag } = hostContext({ refuseProvide: true });
  bag.companionAgenda = theirs;
  const mounted = await mountCompanion(ctx, root);
  t.after(() => { try { mounted?.cognitive?.dispose?.(); } catch { /* disposed */ } });

  assert.equal(bag.companionAgenda, theirs, 'the other service is untouched');
  const status = mounted.cognitive.status({ sessionId: 'session-a' });
  const publication = status?.diagnostics?.observability?.groups?.reminders?.metrics?.publication
    ?? status?.observability?.groups?.reminders?.metrics?.publication;
  assert.ok(publication, 'publication is still reported');
  assert.equal(publication.value, 0, `a refused publish is a visible 0 (got ${JSON.stringify(publication)})`);
  assert.equal(publication.honest, 'measured');
});
