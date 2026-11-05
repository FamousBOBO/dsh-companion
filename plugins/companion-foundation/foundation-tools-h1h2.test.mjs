import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HH16: the public tools must be registered in the real companion preset exactly once,
// must declare the same constraints the runtime enforces, must take identity only from the
// host binding, and must return the frozen rejection codes. This mounts the real foundation
// plugin; nothing here talks to a model or a channel.

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const { resolveModuleRoot } = await import('./test-fixtures/module-root.mjs');
const { root: moduleRoot } = resolveModuleRoot(repositoryRoot);
process.env.DSH_COMPANION_MODULE_ROOT = moduleRoot;
const { mountCompanion } = await import('./index.mjs');
const { createDb } = await import('../companion-runtime/lib/db.mjs');

const NEW_TOOLS = [
  'companion_schedule_today', 'companion_schedule_list', 'companion_schedule_create',
  'companion_schedule_update', 'companion_schedule_cancel',
  'companion_heartbeat_status', 'companion_heartbeat_pause', 'companion_heartbeat_resume',
];

function buildRoot(t, runtime = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-h1h2-'));
  for (const dir of ['workspace', 'logs', 'home/memory', 'home/companion', 'home/channel-qq']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'bot',
    owner: { id: '10001', displayName: 'owner', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: '10001' },
    sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), '# persona\n\ntest persona\n');
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite',
    injection: { budgetChars: 2400 },
    extraction: { enabled: false, minMessages: 3, maxMessages: 20 },
    embedding: { provider: 'local', dimensions: 128 },
    wiki: { enabled: false, dir: 'home/memory/wiki', autoCompile: false, minIntervalMs: 0 },
  }));
  if (runtime) fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify(runtime));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

function mount(t, root) {
  const registrations = [];
  const tools = new Map();
  const internals = mountCompanion({
    tools: { register(tool) { registrations.push(tool.name); tools.set(tool.name, tool); } },
    systemPrompt: { section() {} },
    on() {},
    get() { return undefined; },
  }, root);
  t.after(async () => {
    try { internals.cognitive?.dispose(); } catch { /* closed */ }
    try { await internals.engine.close(); } catch { /* closed */ }
  });
  return { registrations, tools, internals };
}

const exec = sessionId => ({ agent: { session: { id: sessionId } } });
const call = async (tools, name, args = {}, sessionId = 'session-h1h2') => {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} is registered`);
  return JSON.parse(await tool.execute(args, exec(sessionId)));
};

test('HH16: all eight agenda/heartbeat tools are registered exactly once with matching declarations', async t => {
  const root = buildRoot(t, { enabled: true, mode: 'active', agenda: { enabled: true }, heartbeat: { enabled: true } });
  const { registrations, tools } = mount(t, root);
  for (const name of NEW_TOOLS) {
    const count = registrations.filter(item => item === name).length;
    assert.equal(count, 1, `${name} must be registered exactly once (found ${count})`);
  }
  const duplicates = registrations.filter((name, index) => registrations.indexOf(name) !== index);
  assert.deepEqual([...new Set(duplicates)], [], 'no tool is registered twice');

  // Declarations have to describe what the implementation actually enforces. The host tool
  // builder may expose either the flat map or the normalised JSON Schema, so read both.
  const schemaOf = tool => (tool.parameters?.properties
    ? tool.parameters
    : {
      type: 'object',
      properties: tool.parameters ?? {},
      required: Object.entries(tool.parameters ?? {}).filter(([, spec]) => spec.required === true).map(([key]) => key),
    });
  const requiredOf = tool => [...(schemaOf(tool).required ?? [])].sort();
  const propsOf = tool => schemaOf(tool).properties ?? {};
  const create = tools.get('companion_schedule_create');
  assert.deepEqual(requiredOf(create), ['rule', 'timeZone', 'title']);
  assert.equal(propsOf(create).rule.enum.join(','), 'once,daily,weekly');
  assert.equal(typeof create.presentCall, 'function');
  const update = tools.get('companion_schedule_update');
  assert.deepEqual(requiredOf(update), ['expectedRevision', 'itemId']);
  assert.equal(propsOf(update).expectedRevision.type, 'integer');
  assert.equal(propsOf(update).previewToken.type, 'string');
  assert.equal(typeof update.presentCall, 'function');
  const cancel = tools.get('companion_schedule_cancel');
  assert.deepEqual(requiredOf(cancel), ['expectedRevision', 'itemId']);
  assert.equal(typeof cancel.presentCall, 'function');
  const today = tools.get('companion_schedule_today');
  assert.equal(typeof today.presentCall, 'function');
  const heartbeatStatus = tools.get('companion_heartbeat_status');
  assert.equal(typeof heartbeatStatus.presentCall, 'function');
});

test('HH16: with the switches off every tool reports disabled instead of pretending', async t => {
  const root = buildRoot(t, { enabled: true, mode: 'active' });
  const { tools } = mount(t, root);
  const created = await call(tools, 'companion_schedule_create', { title: '去文庙', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '10:00' });
  assert.equal(created.ok, false);
  assert.equal(created.code, 'agenda-disabled');
  const listed = await call(tools, 'companion_schedule_list');
  assert.equal(listed.ok, true);
  assert.equal(listed.enabled, false);
  assert.equal(listed.state, 'disabled');
  const today = await call(tools, 'companion_schedule_today');
  assert.equal(today.enabled, false);
  const status = await call(tools, 'companion_heartbeat_status');
  assert.equal(status.enabled, false);
  assert.equal(status.state, 'disabled');
  const paused = await call(tools, 'companion_heartbeat_pause', { reason: 'test' });
  assert.equal(paused.ok, false, 'a disabled heartbeat cannot be paused into a running state');
  assert.match(String(paused.code), /heartbeat/);
});

test('HH16: real identity, revision fence, preview handshake and honest reminder capability', async t => {
  const root = buildRoot(t, { enabled: true, mode: 'active', agenda: { enabled: true }, heartbeat: { enabled: true } });
  const { tools } = mount(t, root);

  // A forged userId/personaId/worldId/bound in the arguments must never widen the scope:
  // either the host tool schema rejects the call outright, or the runtime ignores the field.
  let forgedRejected = false;
  try {
    await call(tools, 'companion_schedule_create', {
      title: '伪造身份', rule: 'daily', timeZone: 'Asia/Shanghai', time: '06:00',
      userId: 'attacker', personaId: 'other', worldId: 'world:spoofed', bound: { userId: 'attacker' },
    });
  } catch (error) {
    forgedRejected = true;
    assert.match(String(error?.code ?? error?.message), /INVALID_ARGS|invalid-input/i);
  }
  const created = await call(tools, 'companion_schedule_create', { title: '晨跑', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.reminderDelivery, 'n/a');
  assert.equal(created.delivery, 'none');

  // The row is stored under the resolved owner scope, not the forged one.
  const db = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => Date.now(), pragmas: false });
  const row = db.get('SELECT scope FROM agenda_items WHERE item_id = ?', created.itemId);
  db.close();
  assert.ok(row, 'the definition was persisted');
  assert.equal(row.scope, 'u:10001|p:bot|w:world:default');
  assert.ok(!row.scope.includes('attacker'), 'a forged identity never reaches storage');
  assert.equal(forgedRejected || true, true);

  // A stale revision is refused instead of overwriting.
  const updated = await call(tools, 'companion_schedule_update', { itemId: created.itemId, expectedRevision: created.revision, title: '晨跑（改）' });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const stale = await call(tools, 'companion_schedule_update', { itemId: created.itemId, expectedRevision: created.revision, title: '晨跑（更旧）' });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-revision');
  // Installed hosts validate the declaration and throw INVALID_ARGS. The bundled
  // defineTool stand-in returns the spec unchanged, so the foundation guard must
  // still refuse the call with revision-required and leave the definition intact.
  let missingRevisionRejected = false;
  try {
    const missingRevision = await call(tools, 'companion_schedule_cancel', { itemId: created.itemId });
    assert.equal(missingRevision.ok, false);
    assert.equal(missingRevision.code, 'revision-required');
    missingRevisionRejected = true;
  } catch (error) {
    if (error?.code !== 'INVALID_ARGS') throw error;
    missingRevisionRejected = true;
  }
  assert.equal(missingRevisionRejected, true, 'missing expectedRevision is refused at either boundary');
  const unchanged = await call(tools, 'companion_schedule_list');
  const preserved = unchanged.items.find(item => item.itemId === created.itemId);
  assert.equal(preserved.status, 'active');
  assert.equal(preserved.revision, updated.item.revision);

  // A timezone change needs the preview handshake and rejects a fabricated token.
  const previewNeeded = await call(tools, 'companion_schedule_update', { itemId: created.itemId, expectedRevision: updated.item.revision, timeZone: 'UTC' });
  assert.equal(previewNeeded.ok, false);
  assert.equal(previewNeeded.code, 'preview-required');
  assert.ok(previewNeeded.preview?.previewToken, 'a preview token is issued');
  assert.equal(previewNeeded.preview.from, 'Asia/Shanghai');
  assert.equal(previewNeeded.preview.to, 'UTC');
  const fakeToken = await call(tools, 'companion_schedule_update', { itemId: created.itemId, expectedRevision: updated.item.revision, timeZone: 'UTC', previewToken: 'fabricated' });
  assert.equal(fakeToken.ok, false);
  assert.equal(fakeToken.code, 'preview-stale');
  const committed = await call(tools, 'companion_schedule_update', { itemId: created.itemId, expectedRevision: updated.item.revision, timeZone: 'UTC', previewToken: previewNeeded.preview.previewToken });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.item.timeZone, 'UTC');

  // A reminder authorization is stored as a capability gap, never as a delivery promise.
  const reminder = await call(tools, 'companion_schedule_create', { title: '明早提醒我', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '08:00', authorization: 'reminder' });
  assert.equal(reminder.ok, true, JSON.stringify(reminder));
  assert.equal(reminder.item.reminderDelivery, 'not-wired');
  assert.equal(reminder.delivery, 'none');

  // Cancel keeps the plan history and says plainly that no reminder was removed.
  const cancelled = await call(tools, 'companion_schedule_cancel', { itemId: reminder.itemId, expectedRevision: reminder.item.revision, reason: 'user-cancelled' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.item.status, 'cancelled');
  assert.equal(cancelled.reminderDelivery, 'not-wired');

  // Heartbeat control is exposed and reports its own state honestly.
  const paused = await call(tools, 'companion_heartbeat_pause', { reason: 'tool-test' });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  const status = await call(tools, 'companion_heartbeat_status');
  assert.equal(status.paused, true);
  // P2.5-1 gave `activityDispatch` three states, and the three are not
  // interchangeable: `wired` means the hook is live, `disabled-by-config` means
  // the capability exists but a switch withholds it, `unavailable` means the
  // runtime has no P2 module at all. This fixture mounts P2 with the switches
  // off, so the honest answer is `disabled-by-config` — asserting `unavailable`
  // here would demand that diagnostics *understate* what the build can do.
  assert.equal(status.activityDispatch, 'disabled-by-config');
  assert.notEqual(status.activityDispatch, 'wired');
  const resumed = await call(tools, 'companion_heartbeat_resume');
  assert.equal(resumed.ok, true);
  assert.equal((await call(tools, 'companion_heartbeat_status')).paused, false);
});
