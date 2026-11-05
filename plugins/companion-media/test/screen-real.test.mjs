import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Screen frames: real service wiring, real refusals, no network.
//
// What this file proves, and what it does not:
//   * proves the media layer's own behaviour: freshness, session, kill switch,
//     frame-origin rules, media limits, source marking, audit lines;
//   * proves the host *frame port* contract end to end with a stub host
//     (`ctx.get('companionScreenFrame')`), including that a screen frame reaches
//     the cloud image route and never the local model;
//   * does NOT prove what a real cloud model answers, and does not capture the
//     screen: the tests here never ask any host for a real frame.
//
// The host LLM/attachments services are stubbed. `DSH_COMPANION_MODULE_ROOT`
// points at a throwaway module that exposes only `BlockAssembler` and
// `createUserMessage`, which is exactly what `lib/host-llm.mjs` imports.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

const REPLY = '屏幕：编辑器里正在跑测试，进度条过半。';
const STUB_HOST_MODULE = `// Stub for @deepseek-ai/dsh-llm: only the two exports host-llm.mjs imports.
export class BlockAssembler {
  constructor() { this.text = ''; }
  push(chunk) { if (typeof chunk?.text === 'string') this.text += chunk.text; }
  blocks() { return [{ type: 'text', text: this.text }]; }
  get finish() { return { kind: 'stop' }; }
}
export function createUserMessage({ content }) { return { role: 'user', content }; }
`;

const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-screen-host-'));
fs.mkdirSync(path.join(hostRoot, '@deepseek-ai/dsh-llm/lib'), { recursive: true });
fs.writeFileSync(path.join(hostRoot, '@deepseek-ai/dsh-llm/lib/index.js'), STUB_HOST_MODULE, 'utf8');
process.env.DSH_COMPANION_MODULE_ROOT = hostRoot;

// Any real network call from a screen inspection would be a routing bug (screen
// must use the host image route) or an accidental local-model call. Record it.
const networkCalls = [];
globalThis.fetch = async url => {
  networkCalls.push(String(url));
  throw new Error('network is forbidden in the screen tests');
};

const { mountMedia } = await import(pathToFileURL(path.join(pluginRoot, 'index.mjs')).href);
const { createScreenService, screenCapabilities, describeScreen, evaluateFrame, readScreenFixture, frameSourceState, FRAME_SOURCE_UNAVAILABLE } = await import(pathToFileURL(path.join(pluginRoot, 'lib/screen.mjs')).href);
const { normalizeConfig } = await import(pathToFileURL(path.join(pluginRoot, 'config.mjs')).href);
const { createVisionService, visionRouteFor } = await import(pathToFileURL(path.join(pluginRoot, 'lib/vision.mjs')).href);
const { createLedger } = await import(pathToFileURL(path.join(pluginRoot, 'lib/store.mjs')).href);

const FRAME_BYTES = fs.readFileSync(path.join(pluginRoot, 'test/fixtures/screen/synthetic-desktop.png'));
const FRESH = () => new Date().toISOString();

/** A throwaway companion root: own config, own identity, own ledger and logs. */
function sandbox({ screen = {}, limits = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-screen-'));
  fs.mkdirSync(path.join(dir, 'home/media'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home/companion'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'home/media/config.json'), JSON.stringify({
    vision: { enabled: true },
    screen: { enabled: true, mode: 'fixture', ...screen },
    ...(limits ? { limits } : {}),
    delivery: { mode: 'mock' },
  }), 'utf8');
  // A synthetic owner: never the live identity, so no personal id enters evidence.
  fs.writeFileSync(path.join(dir, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1,
    persona: 'march7',
    owner: { id: 'test-owner', platform: 'test', displayName: 'test' },
  }), 'utf8');
  return dir;
}

/** Fake host services; every egress attempt is recorded, nothing leaves. */
function fakeHost({ reply = REPLY } = {}) {
  const calls = { prepared: [], saved: [], text: 0 };
  const ctx = {
    tools: { register() {} },
    get(name) {
      if (name === 'llm') {
        return {
          prepareCall: async route => {
            calls.prepared.push({ provider: route.provider, model: route.model, maxTokens: route.maxTokens });
            return {
              config: {},
              // host-llm.mjs calls `prepared.stream(options)`, so this is a function
              // returning an async iterable, not an iterable itself.
              stream: async function* stream() { yield { text: reply }; },
            };
          },
        };
      }
      if (name === 'attachments') {
        return {
          async saveImages(images) {
            calls.saved.push(images.map(image => ({ bytes: image.data.length, mediaType: image.mediaType })));
            return images.map((_, index) => ({ id: `att-${index}`, mediaType: 'image/png' }));
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, calls };
}

/** A frame port the host would publish; `mode` picks what it does. */
function framePort({ frame = () => ({ bytes: FRAME_BYTES, capturedAt: FRESH(), sessionId: 'session-1' }), available = true, name = 'test-screen-capture' } = {}) {
  const state = { captures: 0 };
  const port = {
    name,
    available: () => available,
    async capture(request) {
      state.captures += 1;
      state.lastRequest = request;
      return frame(request);
    },
  };
  return { port, state };
}

function mount(root, options = {}) {
  const host = fakeHost();
  const service = mountMedia(host.ctx, { companionRoot: root, dataRoot: root, ...options });
  return { service, ...host };
}

function events(root) {
  const file = path.join(root, 'logs/media-migration/media-events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function managedScreenFiles(root) {
  const dir = path.join(root, 'media/inbox/screen');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

// ── 1. Port absent ───────────────────────────────────────────────────────────

test('no host frame port: a live screen request is DISABLED with frame-source-unavailable, not fabricated', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'live' } });
  const { service, calls } = mount(root);

  const result = await service.screenInspect({ sessionId: 'session-1' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_DISABLED');
  assert.equal(result.error.reason, FRAME_SOURCE_UNAVAILABLE);
  assert.match(result.error.message, /never captures the screen/);
  assert.equal(calls.saved.length, 0, 'nothing may be uploaded when no frame source exists');
  assert.equal(calls.prepared.length, 0);

  const status = service.status();
  assert.deepEqual(status.capabilities.screen.frameSource, { present: false, available: false, name: null, reason: FRAME_SOURCE_UNAVAILABLE });
  assert.equal(status.capabilities.screen.accepts, 'none');
  assert.equal(status.capabilities.screen.capturesScreen, false);
  assert.ok(status.facts.some(line => /frame-source-unavailable/.test(line)), 'the diagnostic line must say the frame source is not wired');
});

test('a port that reports itself unavailable is refused without being asked to capture', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'live' } });
  const { port, state } = framePort({ available: false });
  const { service, calls } = mount(root, { frameSource: port });

  const result = await service.screenInspect({ sessionId: 'session-1' });

  assert.equal(result.error.code, 'MEDIA_DISABLED');
  assert.equal(result.error.reason, FRAME_SOURCE_UNAVAILABLE);
  assert.equal(state.captures, 0);
  assert.equal(calls.saved.length, 0);
});

test('fixture mode refuses live capture even when a port is wired', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'fixture' } });
  const { port, state } = framePort();
  const { service, calls } = mount(root, { frameSource: port });

  const result = await service.screenInspect({ sessionId: 'session-1' });

  assert.equal(result.error.code, 'MEDIA_DISABLED');
  assert.equal(result.error.reason, 'mode-fixture-only');
  assert.equal(state.captures, 0, 'a fixture deployment must not touch the host capture capability');
  assert.equal(calls.saved.length, 0);
});

// ── 2. Host-injected frame: accepted, marked, cloud-only ─────────────────────

test('a host frame with a fresh capture time is described through the cloud image route', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'live' } });
  const { port, state } = framePort();
  const { service, calls } = mount(root, { frameSource: port });

  const result = await service.screenInspect({ sessionId: 'session-1' });

  assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
  assert.equal(result.route.backend, 'host-llm');
  assert.equal(result.route.provider, 'opencode-go');
  assert.equal(result.route.model, 'deepseek-v4.1-flash');
  assert.equal(result.sourceKind, 'screen');
  assert.equal(result.description, REPLY);
  assert.equal(result.frameOrigin, 'host-port');
  assert.equal(typeof result.frameAgeSeconds, 'number');

  assert.equal(state.lastRequest.maxAgeSeconds, 60, 'the port is told the freshness limit it must respect');
  assert.equal(calls.saved.length, 1);
  assert.deepEqual(calls.saved[0][0], { bytes: FRAME_BYTES.length, mediaType: 'image/png' });
  assert.deepEqual(calls.prepared[0], { provider: 'opencode-go', model: 'deepseek-v4.1-flash', maxTokens: 900 });
  assert.deepEqual(networkCalls, [], 'screen frames must never be sent to the local coordinator or any other host');
  assert.ok(managedScreenFiles(root).every(name => /^[0-9a-f]{16}-frame\.png$/.test(name)), 'the managed copy is named from the digest, not from a host file name');
});

test('a stale host frame is refused before anything is uploaded', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'live' } });
  const { port } = framePort({ frame: () => ({ bytes: FRAME_BYTES, capturedAt: new Date(Date.now() - 300_000).toISOString(), sessionId: 'session-1' }) });
  const { service, calls } = mount(root, { frameSource: port });

  const result = await service.screenInspect({ sessionId: 'session-1' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_STALE_FRAME');
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.prepared.length, 0);
  assert.ok(events(root).some(event => event.event === 'screen.rejected' && event.code === 'MEDIA_STALE_FRAME'));
});

test('a host frame without a capture time is refused instead of being described as the live screen', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'live' } });
  const { port } = framePort({ frame: () => ({ bytes: FRAME_BYTES }) });
  const { service, calls } = mount(root, { frameSource: port });

  const result = await service.screenInspect({ sessionId: 'session-1' });

  assert.equal(result.error.code, 'MEDIA_STALE_FRAME');
  assert.match(result.error.message, /capture time/);
  assert.equal(calls.saved.length, 0);
});

test('a host frame stamped with another session is refused', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'live' } });
  const { port } = framePort({ frame: () => ({ bytes: FRAME_BYTES, capturedAt: FRESH(), sessionId: 'someone-else' }) });
  const { service, calls } = mount(root, { frameSource: port });

  const result = await service.screenInspect({ sessionId: 'session-1' });

  assert.equal(result.error.code, 'MEDIA_SESSION_MISMATCH');
  assert.equal(calls.saved.length, 0);
});

test('host frame limits and type checks use the same media rules, and fail closed', async () => {
  const tooLarge = sandbox({ screen: { enabled: true, mode: 'live' }, limits: { maxImageBytes: 1024 } });
  const a = mount(tooLarge, { frameSource: framePort().port });
  const big = await a.service.screenInspect({ sessionId: 'session-1' });
  assert.equal(big.error.code, 'MEDIA_TOO_LARGE');
  assert.equal(a.calls.saved.length, 0);

  const notAnImage = sandbox({ screen: { enabled: true, mode: 'live' } });
  const b = mount(notAnImage, { frameSource: framePort({ frame: () => ({ bytes: Buffer.from('this is not an image'), capturedAt: FRESH() }) }).port });
  const bad = await b.service.screenInspect({ sessionId: 'session-1' });
  assert.equal(bad.error.code, 'MEDIA_UNSUPPORTED_TYPE');
  assert.equal(b.calls.saved.length, 0);
});

test('a frame port that throws is reported as a backend failure, not as a screen description', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'live' } });
  const { service, calls } = mount(root, {
    frameSource: { name: 'broken', available: () => true, async capture() { throw new Error('capture helper exploded'); } },
  });

  const result = await service.screenInspect({ sessionId: 'session-1' });

  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'frame-source-failed');
  assert.match(result.error.message, /capture helper exploded/);
  assert.equal(result.description ?? '', '');
  assert.equal(calls.saved.length, 0);
});

// ── 3. Fixture demo (the path that used to be dead) ─────────────────────────

test('the fixture demo actually reaches the model — source is marked screen, not screen-fixture', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'fixture' } });
  const { service, calls } = mount(root);

  const result = await service.screenInspect({ fixture: 'synthetic-desktop.png', sessionId: 'session-1', capturedAt: FRESH() });

  // Before the fix every fixture inspection ended in
  // MEDIA_BAD_INPUT 'screen input must carry source=screen'.
  assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
  assert.equal(result.frameOrigin, 'fixture');
  assert.equal(result.route.backend, 'host-llm');
  assert.equal(result.sourceKind, 'screen');
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0][0].bytes, FRAME_BYTES.length);
});

test('fixture frames keep every refusal: stale, live-mode, path escape', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'fixture' } });
  const { service, calls } = mount(root);

  const stale = await service.screenInspect({ fixture: 'synthetic-desktop.png', sessionId: 'session-1', capturedAt: new Date(Date.now() - 3_600_000).toISOString() });
  assert.equal(stale.error.code, 'MEDIA_STALE_FRAME');

  const noStamp = await service.screenInspect({ fixture: 'synthetic-desktop.png', sessionId: 'session-1' });
  assert.equal(noStamp.error.code, 'MEDIA_STALE_FRAME');

  const escape = await service.screenInspect({ fixture: '../vision/sample-a.png', sessionId: 'session-1', capturedAt: FRESH() });
  assert.equal(escape.error.code, 'MEDIA_PATH_ESCAPE');
  assert.equal(calls.saved.length, 0, 'no refused fixture may reach the cloud');

  const live = sandbox({ screen: { enabled: true, mode: 'live' } });
  const liveMount = mount(live, { frameSource: framePort().port });
  const refused = await liveMount.service.screenInspect({ fixture: 'synthetic-desktop.png', sessionId: 'session-1', capturedAt: FRESH() });
  assert.equal(refused.error.code, 'MEDIA_DISABLED');
  assert.equal(refused.error.reason, 'mode-live');
});

test('the kill switch gates the fixture path and the caller-supplied frame path alike', async () => {
  const off = sandbox({ screen: { enabled: false } });
  const { service, calls } = mount(off);

  const fixture = await service.screenInspect({ fixture: 'synthetic-desktop.png', sessionId: 'session-1', capturedAt: FRESH() });
  assert.equal(fixture.error.code, 'MEDIA_DISABLED');

  // Regression: this path used to ignore screen.enabled and upload the frame.
  const external = await service.inspectImage({ bytes: FRAME_BYTES, filename: 'frame.png', screenFrame: true, capturedAt: FRESH(), sessionId: 'session-1' });
  assert.equal(external.error.code, 'MEDIA_DISABLED');
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.prepared.length, 0);
});

// ── 4. Caller-supplied frame and impersonation ──────────────────────────────

test('a caller-supplied screen frame goes through the same screen path', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'fixture' } });
  const { service } = mount(root);

  const result = await service.inspectImage({ bytes: FRAME_BYTES, filename: 'frame.png', screenFrame: true, capturedAt: FRESH(), sessionId: 'session-1' });

  assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
  assert.equal(result.frameOrigin, 'external');
  assert.equal(result.route.backend, 'host-llm');
});

test('a picture that claims to be a screen frame but is not marked as one is refused by the vision layer', async () => {
  const config = normalizeConfig({ vision: { enabled: true } });
  const host = fakeHost();
  const vision = createVisionService({ config, ledger: createLedger({ root: sandbox({}) }), host: { available: () => true, inspectImages: async () => { throw new Error('must not be called'); } }, log: () => {} });

  const result = await vision.inspect({
    media: { mediaId: 'x', sessionId: 'session-1', owner: { userId: 'test-owner' }, kind: 'screen', source: 'desktop', mime: 'image/png', format: 'png', sha256: 'x', capturedAt: FRESH() },
    bytes: FRAME_BYTES,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_BAD_INPUT');
  assert.match(result.error.message, /source=screen/);
  assert.equal(result.frames, 0);
  assert.equal(result.route.reason, 'refused');
  assert.equal(host.calls.saved.length, 0);
});

test('an ordinary picture cannot borrow the screen route by naming the kind', async () => {
  const root = sandbox({ screen: { enabled: true } });
  const { service, calls } = mount(root);

  const result = await service.inspectImage({ bytes: FRAME_BYTES, filename: 'frame.png', kind: 'screen', sessionId: 'session-1' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_BAD_INPUT');
  assert.equal(calls.saved.length, 0);
});

// ── 5. Freshness rules and capability/privacy description ───────────────────

test('freshness rules stay explicit about the boundaries', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  assert.equal(evaluateFrame({ capturedAt: '2026-11-03T11:59:30Z', maxAgeSeconds: 60, now }).usable, true);
  assert.equal(evaluateFrame({ capturedAt: '2026-11-03T11:58:59Z', maxAgeSeconds: 60, now }).code, 'MEDIA_STALE_FRAME');
  assert.equal(evaluateFrame({ capturedAt: '2026-11-03T12:00:04Z', maxAgeSeconds: 60, now }).usable, true, 'a small clock skew is tolerated');
  assert.equal(evaluateFrame({ capturedAt: '2026-11-03T12:00:10Z', maxAgeSeconds: 60, now }).code, 'MEDIA_STALE_FRAME', 'a future-stamped frame is not evidence of now');
  assert.equal(evaluateFrame({ capturedAt: 'not-a-date', maxAgeSeconds: 60, now }).code, 'MEDIA_STALE_FRAME');
  assert.equal(evaluateFrame({ frameSessionId: 'a', expectedSessionId: 'b', capturedAt: '2026-11-03T11:59:30Z', maxAgeSeconds: 60, now }).code, 'MEDIA_SESSION_MISMATCH');
  const loose = frameSourceState({ name: 'no-capture-method' });
  assert.equal(loose.present, false, 'an object without capture() is not a frame source');
  assert.equal(frameSourceState(() => { throw new Error('getter failed'); }).reason, FRAME_SOURCE_UNAVAILABLE);
});

test('the capability report says what leaves the machine and how to stop it', () => {
  const config = normalizeConfig({ screen: { enabled: true, mode: 'fixture' } });
  const caps = screenCapabilities(config, { frameSource: framePort().port });

  assert.equal(caps.capturesScreen, false);
  assert.equal(caps.backgroundCapture, false);
  assert.equal(caps.accepts, 'fixture');
  assert.equal(caps.mode, 'fixture');
  assert.equal(caps.egress.to, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(caps.egress.leavesMachine, true);
  assert.match(caps.egress.off, /screen\.enabled=false/);
  assert.equal(caps.frameSource.present, true);

  const off = describeScreen(normalizeConfig({}), null);
  assert.equal(off.enabled, false);
  assert.equal(off.accepts, 'none');
  assert.equal(off.frameSource.reason, FRAME_SOURCE_UNAVAILABLE);
  assert.equal(visionRouteFor('screen', normalizeConfig({})).backend, 'host-llm', 'screen routing is cloud-only by construction');
});

test('the audit line for an accepted frame carries no path, no token and no bytes', async () => {
  const root = sandbox({ screen: { enabled: true, mode: 'live' } });
  const { port } = framePort();
  const { service } = mount(root, { frameSource: port });

  const result = await service.screenInspect({ sessionId: 'session-1' });
  assert.equal(result.ok, true);

  const raw = fs.readFileSync(path.join(root, 'logs/media-migration/media-events.jsonl'), 'utf8');
  const line = events(root).find(event => event.event === 'screen.frame' && event.accepted === true);
  assert.ok(line, 'an accepted frame must be auditable');
  assert.equal(line.origin, 'host-port');
  assert.equal(line.bytes, FRAME_BYTES.length);
  assert.match(line.sha256, /^[0-9a-f]{16}$/);
  assert.equal(typeof line.ageSeconds, 'number');
  assert.doesNotMatch(raw, /[A-Za-z]:[\\/]/, 'no absolute path may be logged');
  assert.doesNotMatch(raw, /\b(pst-|oc_sk_|sk-[A-Za-z0-9]{20,}|Bearer\s)/, 'no credential-shaped text may be logged');
  assert.ok(!raw.includes(FRAME_BYTES.toString('base64').slice(0, 24)), 'frame bytes must never be logged');
});

test('the status report names the route the frame really takes, not the descriptive key', () => {
  // screen.cloud is descriptive; lib/vision.mjs routes screen frames with
  // config.vision.cloud. A mislabelled egress target is a privacy defect.
  const root = sandbox({ screen: { enabled: true, mode: 'live', cloud: { provider: 'somewhere-else', model: 'not-the-real-one' } } });
  const { service } = mount(root, { frameSource: framePort().port });

  const caps = service.status().capabilities.screen;
  assert.equal(caps.route.from, 'vision.cloud');
  assert.equal(caps.route.provider, 'opencode-go');
  assert.equal(caps.egress.to, 'opencode-go/deepseek-v4.1-flash');
  assert.match(caps.routeNote, /screen\.cloud .* is descriptive only/);
  assert.equal(caps.accepts, 'host-frame');
});

test('the fixture reader stays inside its own fixture directory', () => {
  const inside = readScreenFixture(pluginRoot, 'synthetic-desktop.png');
  assert.equal(inside.mime, 'image/png');
  assert.ok(inside.bytes.length > 0);

  assert.throws(() => readScreenFixture(pluginRoot, '../vision/sample-a.png'), error => error.code === 'MEDIA_PATH_ESCAPE');
  assert.throws(() => readScreenFixture(pluginRoot, '../../index.mjs'), error => error.code === 'MEDIA_PATH_ESCAPE');
  assert.throws(() => readScreenFixture(pluginRoot, 'synthetic-desktop.png', { maxBytes: 16 }), error => error.code === 'MEDIA_TOO_LARGE');
});
