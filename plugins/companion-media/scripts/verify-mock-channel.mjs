import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, loadConfig } from '../config.mjs';
import { createLedger } from '../lib/store.mjs';
import { createVisionService } from '../lib/vision.mjs';
import { createSpeechService } from '../lib/speech.mjs';
import { createImageService } from '../lib/imagegen.mjs';
import { createScreenService } from '../lib/screen.mjs';
import { createTurnAggregator, composeTurnText } from '../lib/batching.mjs';
import { createDeliveryService, planDelivery } from '../lib/delivery.mjs';
import { runProcess } from '../lib/exec.mjs';

// One full mock turn across every media capability.
//
// This is the M5 integration check: an inbound text+image batch, a sticker and a
// screen frame, a synthesized reply, an ordered delivery plan and receipts from a
// mock channel. It proves wiring and failure semantics offline; it is explicitly
// NOT evidence of real QQ delivery or of what a person hears.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companionRoot = path.resolve(packageRoot, '../..');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(companionRoot, 'logs/media-migration/evidence', `mock-${runId}`);
const workRoot = path.join(evidenceDir, 'work');
fs.mkdirSync(workRoot, { recursive: true });

const { config: stored } = loadConfig(companionRoot);
const config = normalizeConfig({
  ...stored,
  vision: { ...stored.vision, enabled: true },
  speech: { ...stored.speech, enabled: true },
  screen: { ...stored.screen, enabled: true },
  image: { ...stored.image, enabled: true },
});

const events = [];
const log = entry => events.push({ at: new Date().toISOString(), ...entry });
const ledger = createLedger({ root: workRoot, file: 'state/ledger.json', maxCacheItems: 50 });

const imageBytes = fs.readFileSync(path.join(packageRoot, 'test/fixtures/vision/sample-b.png'));
const stickerBytes = fs.readFileSync(path.join(packageRoot, 'test/fixtures/vision/sticker_sample.png'));
const screenBytes = fs.readFileSync(path.join(packageRoot, 'test/fixtures/screen/synthetic-desktop.png'));

// A deterministic WAV so speech is exercised without occupying the GPU.
const pcm = Buffer.alloc(24000 * 2);
for (let i = 0; i < 24000; i += 1) pcm.writeInt16LE(Math.round(Math.sin((i / 24) * Math.PI) * 6000), i * 2);
const header = Buffer.alloc(44);
header.write('RIFF', 0, 'latin1');
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8, 'latin1');
header.write('fmt ', 12, 'latin1');
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(24000, 24);
header.writeUInt32LE(48000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36, 'latin1');
header.writeUInt32LE(pcm.length, 40);
const wavFixture = Buffer.concat([header, pcm]);

const host = {
  available: () => true,
  async inspectImages({ prompt }) {
    if (/表情包|贴纸/.test(prompt)) return { text: '黄色圆形笑脸贴纸，适合回应开心或认可。', model: 'fake-v4.1' };
    return { text: '看起来是一个打开的编辑窗口，左边是侧栏，右边有三行内容。', model: 'fake-v4.1' };
  },
  async completeText() {
    return { text: JSON.stringify({ input: '今天风好舒服呀，我们出去走走吧？', instructions: '轻快自然地说，句末放松收住。' }) };
  },
};

const vision = createVisionService({
  config, ledger, log, host, root: workRoot,
  fetchImpl: async () => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    async json() { return { model: 'nsfwvision-v3:q5', choices: [{ message: { content: '白色背景上是蓝色圆形和数字 3。' } }] }; },
    async text() { return ''; },
  }),
});
const speech = createSpeechService({
  config, ledger, log, host, root: workRoot,
  fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'audio/wav' }, async text() { return ''; }, async arrayBuffer() { return wavFixture.buffer.slice(wavFixture.byteOffset, wavFixture.byteOffset + wavFixture.byteLength); } }),
  run: async () => ({ code: 0, stdout: pcm, stderr: Buffer.alloc(0) }),
});
const image = createImageService({ config, ledger, log, run: runProcess, root: workRoot });
const screen = createScreenService({ config, vision, log });

const results = {};

// 1. Inbound text + picture in one turn.
const aggregator = createTurnAggregator({ trailingWindowMs: 7000, maxWaitMs: 15000, imageWindowMs: 8000, now: () => clock });
let clock = Date.now();
aggregator.push('mock-session', { eventId: 'evt-1', kind: 'text', text: '你看这张图', at: clock });
clock += 1200;
aggregator.push('mock-session', { eventId: 'evt-2', kind: 'image', mediaPath: 'sample-b.png', at: clock });
clock += 9000;
const batch = aggregator.take('mock-session');
const visionResult = await vision.inspect({
  media: { mediaId: 'sha256:b', sessionId: 'mock-session', owner: { userId: 'owner', persona: 'march7' }, kind: 'image', source: 'test', mime: 'image/png', format: 'png', sha256: 'b', capturedAt: new Date().toISOString() },
  bytes: imageBytes,
});
results.turn = {
  batch: { text: batch.text, images: batch.images.length, hasImage: batch.hasImage },
  vision: { ok: visionResult.ok, route: visionResult.route.backend, descriptionChars: visionResult.description?.length ?? 0 },
  modelText: composeTurnText({ text: batch.text, visionResults: [visionResult] }),
};

// 2. The same picture a second time must not re-inspect (content cache).
const repeat = await vision.inspect({
  media: { mediaId: 'sha256:b', sessionId: 'mock-session', owner: { userId: 'owner', persona: 'march7' }, kind: 'image', source: 'test', mime: 'image/png', format: 'png', sha256: 'b', capturedAt: new Date().toISOString() },
  bytes: imageBytes,
});
results.cache = { cached: repeat.cached === true };

// 3. Sticker goes to the cloud route.
const sticker = await vision.inspect({
  media: { mediaId: 'sha256:s', sessionId: 'mock-session', owner: { userId: 'owner', persona: 'march7' }, kind: 'sticker', source: 'test', mime: 'image/png', format: 'png', sha256: 's', capturedAt: new Date().toISOString() },
  bytes: stickerBytes,
});
results.sticker = { ok: sticker.ok, route: sticker.route.backend };

// 4. A stale screen frame is refused, a fresh one is described.
const stale = await screen.inspect({
  frame: { bytes: screenBytes, mime: 'image/png', format: 'png', capturedAt: new Date(Date.now() - 300_000).toISOString(), owner: { userId: 'owner' }, sha256: 'screen' },
  sessionId: 'mock-session',
});
const fresh = await screen.inspect({
  frame: { bytes: screenBytes, mime: 'image/png', format: 'png', capturedAt: new Date().toISOString(), owner: { userId: 'owner' }, sha256: 'screen' },
  sessionId: 'mock-session',
});
results.screen = { staleCode: stale.error?.code, freshOk: fresh.ok === true, freshRoute: fresh.route?.backend };

// 5. Voice, then an ordered plan and mock receipts.
const spoken = await speech.synthesize({ text: '今天风好舒服呀，我们出去走走吧？', sessionId: 'mock-session', useDirector: true });
results.speech = spoken.ok
  ? { ok: true, durationSeconds: spoken.artifact.durationSeconds, tempoApplied: spoken.tempoApplied, director: spoken.director }
  : { ok: false, error: spoken.error };

const plan = planDelivery({
  sessionId: 'mock-session', channel: 'qq', target: '10001', text: '今天风好舒服呀，我们出去走走吧？',
  voice: spoken.ok ? spoken.artifact : null, mode: 'mock', voiceOnly: true,
});
const delivery = createDeliveryService({ ledger, log, mode: 'mock' });
const receipt = delivery.record({ planId: plan.planId, sessionId: plan.sessionId, channel: plan.channel, target: plan.target, state: 'confirmed', detail: 'mock channel' });
results.delivery = { steps: plan.steps.map(step => step.kind), voiceOnly: plan.voiceOnly, receiptState: receipt.state, reconcile: delivery.reconcile({ receipt }).action };

// 6. Image request encoding through the real pipeline (dry-run, no spend).
const draw = await image.generate({ prompt: '1girl, solo, morning bedroom, soft light', source: 'user_request', dryRun: true, sessionId: 'mock-session' });
results.image = draw.ok
  ? { ok: true, dryRun: true, paramsDigest: draw.paramsDigest, summary: draw.summary, quota: draw.quota }
  : { ok: false, error: draw.error };

const output = {
  at: new Date().toISOString(),
  evidenceLevel: '② unit/mock (mock channel + real image request encoder); no real delivery, no listening',
  runId,
  results,
  ledger: ledger.summary(),
  events: events.length,
};
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, 'mock-turn.json'), JSON.stringify({ ...output, events }, null, 2), 'utf8');
console.log(JSON.stringify(output, null, 2));
