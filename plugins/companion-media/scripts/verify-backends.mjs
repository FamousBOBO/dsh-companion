import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeConfig } from '../config.mjs';
import { createLedger } from '../lib/store.mjs';
import { createVisionService } from '../lib/vision.mjs';
import { createSpeechService } from '../lib/speech.mjs';
import { runProcess } from '../lib/exec.mjs';

// Real-backend verification for the media layer.
//
// This script is deliberately separate from the plugin mount: it uses the same
// code paths with a throwaway ledger and artifact directory, so it can call the
// live 8139 coordinator and Breeze without touching production state or memory.
//
//   node scripts/verify-backends.mjs vision
//   node scripts/verify-backends.mjs tts
//   node scripts/verify-backends.mjs tts --text "自定义台词"
//
// Evidence (JSON + artifacts) is written under logs/media-migration/evidence/.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companionRoot = path.resolve(packageRoot, '../..');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(companionRoot, 'logs/media-migration/evidence', `run-${runId}`);
const workRoot = path.join(evidenceDir, 'work');
const mode = process.argv[2] ?? 'vision';
const textArgIndex = process.argv.indexOf('--text');
const text = textArgIndex > 0 ? process.argv[textArgIndex + 1] : '今天的风好舒服呀，我们出去走走吧？';

fs.mkdirSync(workRoot, { recursive: true });

const { config: stored } = loadConfig(companionRoot);
// The verification run turns capabilities on explicitly, and only for itself.
const config = normalizeConfig({
  ...stored,
  vision: { ...stored.vision, enabled: true },
  speech: { ...stored.speech, enabled: true },
  screen: { ...stored.screen, enabled: true },
  delivery: { ...stored.delivery, mode: 'mock' },
});

const ledger = createLedger({ root: workRoot, file: 'state/ledger.json', maxCacheItems: 20 });
const log = entry => {
  fs.appendFileSync(path.join(evidenceDir, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};

function writeResult(name, value) {
  const file = path.join(evidenceDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  console.log(JSON.stringify(value, null, 2));
  return file;
}

async function probeGateway() {
  try {
    const response = await fetch('http://127.0.0.1:8139/health', { signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => null);
    return { reachable: response.ok, status: response.status, body };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

async function runVision() {
  const gateway = await probeGateway();
  const service = createVisionService({ config, ledger, log, root: workRoot });
  const fixture = path.join(packageRoot, 'test/fixtures/vision/sample-a.png');
  const bytes = fs.readFileSync(fixture);
  const startedAt = Date.now();
  const result = await service.inspect({
    media: {
      mediaId: 'fixture:sample-a', sessionId: 'verify-session', owner: { userId: 'verification', persona: 'march7' },
      kind: 'image', source: 'test', mime: 'image/png', format: 'png',
      sha256: 'fixture-sample-a', capturedAt: new Date().toISOString(),
    },
    bytes,
  });
  const artifactDir = path.join(workRoot, 'media/inbox');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.copyFileSync(fixture, path.join(artifactDir, 'sample-a.png'));
  const evidence = {
    runId,
    at: new Date().toISOString(),
    evidenceLevel: '③ real model/backend generation',
    gateway,
    fixture: { file: path.relative(companionRoot, fixture).split(path.sep).join('/'), sha256prefix: 'sample-a', bytes: bytes.length },
    request: { route: result.route, elapsedMs: Date.now() - startedAt },
    result: {
      ok: result.ok,
      description: result.description ?? null,
      truncated: result.truncated ?? null,
      frames: result.frames ?? null,
      error: result.error ?? null,
    },
    expectation: { shape: 'one red circle on a white field plus the digit 7', verified: null },
  };
  if (result.ok) {
    evidence.expectation.verified = /红|red/i.test(result.description) && /7|七/.test(result.description);
  }
  return writeResult('vision-local', evidence);
}

async function runTts() {
  const gateway = await probeGateway();
  const service = createSpeechService({ config, ledger, log, root: workRoot, run: runProcess });
  const startedAt = Date.now();
  // The director needs the host LLM, which this standalone script does not have;
  // the emotion preset is therefore used, exactly as a director failure would.
  const result = await service.synthesize({
    text,
    emotion: '自然',
    sessionId: 'verify-session',
    useDirector: false,
  });
  const evidence = {
    runId,
    at: new Date().toISOString(),
    evidenceLevel: '③ real model/backend generation',
    gateway,
    textLength: text.length,
    elapsedMs: Date.now() - startedAt,
    result: result.ok
      ? {
        ok: true,
        artifact: {
          path: result.artifact.path,
          bytes: result.artifact.bytes,
          durationSeconds: result.artifact.durationSeconds,
          sampleRate: result.artifact.sampleRate,
          channels: result.artifact.channels,
          meta: result.artifact.meta,
        },
        tempoApplied: result.tempoApplied,
        absolutePath: path.join(workRoot, result.artifact.path),
        fileExists: fs.existsSync(path.join(workRoot, result.artifact.path)),
      }
      : { ok: false, error: result.error },
    listening: '待用户试听：脚本只能证明 WAV 生成成功并满足时长/采样率，不能代替主观听感。',
  };
  return writeResult('tts-breeze', evidence);
}

async function main() {
  const results = {};
  if (mode === 'vision' || mode === 'all') results.vision = await runVision();
  if (mode === 'tts' || mode === 'all') results.tts = await runTts();
  writeResult('index', { runId, at: new Date().toISOString(), mode, files: results, workRoot });
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
