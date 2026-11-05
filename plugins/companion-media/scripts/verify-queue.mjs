import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { buildImageParams, buildBridgeRequest } from '../lib/imagegen.mjs';
import { runProcess } from '../lib/exec.mjs';

// Prove the queue block travels from the media config into the bridge and that
// the bridge reports the effective settings it will use.

const companionRoot = 'C:/Users/bobo/Documents/Bot/dsh-companion';
const { config } = loadConfig(companionRoot);
console.log('config.image.queue =', JSON.stringify(config.image.queue));

const params = buildImageParams({ prompt: 'a quiet library at dusk' }, config);
const request = buildBridgeRequest({ mode: 'dry-run', params, config });
const result = await runProcess(config.image.pythonPath, [path.join(process.cwd(), 'bridge/nai_generate.py')], {
  input: Buffer.from(JSON.stringify(request), 'utf8'),
  timeoutMs: 60_000,
});
const line = String(result.stdout ?? '').trim().split('\n').filter(Boolean).pop();
if (!line) {
  console.log('BRIDGE FAILED', result.code, String(result.stderr ?? '').slice(-400));
  process.exit(1);
}
const out = JSON.parse(line);
console.log('bridge.queue =', JSON.stringify(out.queue));
console.log('bridge.cloudQueue =', out.cloudQueue, '| ok =', out.ok);

if (process.argv.includes('--real')) {
  const fs = await import('node:fs');
  const evidenceDir = path.join(companionRoot, 'logs/media-migration/evidence', `queue-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const outFile = path.join(evidenceDir, 'queue-generation.png');
  const realRequest = buildBridgeRequest({ mode: 'generate', params: buildImageParams({ prompt: 'a quiet library at dusk, warm lamp light' }, config), config, out: outFile, timeoutSeconds: 300 });
  const startedAt = Date.now();
  const real = await runProcess(config.image.pythonPath, [path.join(process.cwd(), 'bridge/nai_generate.py')], {
    input: Buffer.from(JSON.stringify(realRequest), 'utf8'),
    timeoutMs: 320_000,
  });
  const realLine = String(real.stdout ?? '').trim().split('\n').filter(Boolean).pop();
  const result = realLine ? JSON.parse(realLine) : { ok: false, stderr: String(real.stderr ?? '').slice(-400) };
  const evidence = {
    at: new Date().toISOString(),
    evidenceLevel: '③ real generation through the NovelAI queue service',
    queue: result.queue,
    ok: result.ok,
    elapsedWallMs: Date.now() - startedAt,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
    error: result.error ?? null,
    file: result.file ?? null,
  };
  fs.writeFileSync(path.join(evidenceDir, 'queue-generation.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log('REAL:', JSON.stringify(evidence, null, 2));
}
