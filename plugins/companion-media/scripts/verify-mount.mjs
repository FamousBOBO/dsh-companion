import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated mount check.
//
// The plugin is a Cordis plugin, but its entry can be exercised without the
// desktop: a fake context exposes only what `apply` touches (a tool registry and
// `ctx.get`). This proves the entry registers its surface, never throws, and
// honours its own kill switch.
//
// Review round 1 noted the first version mounted against the live companion root
// and wrote the production ledger (and later the kill-switch probe edited the
// live config). Both are gone: the mount runs against a throwaway companion root
// that only contains a copy of the config and the identity file.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveRoot = path.resolve(packageRoot, '../..');
const { mountMedia, apply } = await import('../index.mjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-mount-'));
fs.mkdirSync(path.join(sandbox, 'home/media'), { recursive: true });
fs.mkdirSync(path.join(sandbox, 'home/companion'), { recursive: true });
// A fixed, all-off config keeps this check independent of whatever the operator
// has switched on in the live file; the live file is still read for its shape.
fs.writeFileSync(path.join(sandbox, 'home/media/config.json'), JSON.stringify({
  vision: { enabled: false },
  speech: { enabled: false },
  image: { enabled: false, allowRealGeneration: false },
  screen: { enabled: false },
  delivery: { mode: 'mock' },
}, null, 2), 'utf8');
fs.copyFileSync(path.join(liveRoot, 'home/companion/identity.json'), path.join(sandbox, 'home/companion/identity.json'));

const registered = [];
const ctx = {
  tools: { register(tool) { registered.push(tool); } },
  get() { return undefined; },
};

const service = mountMedia(ctx, { companionRoot: sandbox });
const applied = apply(ctx);
assert.ok(applied && typeof applied.status === 'function', 'apply must return the media service');
assert.equal(registered.length, 6, `expected 6 tools, got ${registered.map(tool => tool.name).join(',')}`);
const names = registered.map(tool => tool.name).sort();
assert.deepEqual(names, [
  'companion_media_draw',
  'companion_media_inspect',
  'companion_media_job',
  'companion_media_speak',
  'companion_media_status',
  'companion_media_warm',
]);

// Regression: a bare property map shipped as `parameters` makes the provider
// reject the whole request ("schema must be a JSON Schema of type: object, got
// type: null"). Every registered tool must carry an object-rooted schema.
for (const tool of registered) {
  assert.equal(tool.parameters?.type, 'object', `${tool.name} parameters must be object-rooted`);
  assert.equal(typeof tool.parameters.properties, 'object', `${tool.name} parameters need a properties object`);
}
const draw = registered.find(tool => tool.name === 'companion_media_draw');
assert.deepEqual(draw.parameters.required, ['prompt'], 'required fields must survive the projection');

const status = service.status();
assert.equal(status.capabilities.vision.enabled, false);
assert.equal(status.capabilities.speech.enabled, false);
assert.equal(status.capabilities.image.enabled, false);
assert.equal(status.capabilities.screen.enabled, false);
assert.equal(status.capabilities.screen.capturesScreen, false);
assert.equal(status.capabilities.delivery.mode, 'mock');
assert.equal(status.root, sandbox, 'the isolated mount must not use the live companion root');
assert.equal(JSON.stringify(status).includes('pst-'), false, 'status must not leak a NovelAI token');

// Every tool answers with a JSON string and never throws, even with bad input.
for (const tool of registered) {
  const value = await tool.execute({}, { agent: { session: { id: 'mount-check' } } });
  assert.equal(typeof value, 'string');
  JSON.parse(value);
}

// The documented kill switch: editing the config file takes effect on the next call.
const sandboxConfig = path.join(sandbox, 'home/media/config.json');
const probe = JSON.parse(fs.readFileSync(sandboxConfig, 'utf8'));
probe.vision.enabled = true;
fs.writeFileSync(sandboxConfig, JSON.stringify(probe, null, 2), 'utf8');
assert.equal(service.status().capabilities.vision.enabled, true, 'a config edit on disk must be visible without a restart');
probe.vision.enabled = false;
fs.writeFileSync(sandboxConfig, JSON.stringify(probe, null, 2), 'utf8');
assert.equal(service.status().capabilities.vision.enabled, false, 'restoring the file must restore the capability');

const outline = {
  at: new Date().toISOString(),
  evidenceLevel: '② unit/mock (isolated mount, no desktop host, throwaway companion root)',
  tools: names,
  capabilities: status.capabilities,
  ledger: status.ledger,
  sandbox,
  configSource: path.relative(sandbox, service.status().configPath).split(path.sep).join('/'),
  configMissing: service.status().configMissing,
  killSwitch: 'config edit observed on the next call inside the sandbox; the live home/media/config.json was only read',
};
const outDir = path.join(liveRoot, 'logs/media-migration/evidence');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'mount-check.json'), JSON.stringify(outline, null, 2), 'utf8');
console.log(JSON.stringify(outline, null, 2));
