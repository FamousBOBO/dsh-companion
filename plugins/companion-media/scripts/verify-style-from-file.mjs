import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '../config.mjs';
import { buildImageParams, buildBridgeRequest } from '../lib/imagegen.mjs';
import { runProcess } from '../lib/exec.mjs';

// Same as verify-style.mjs but reads the prompt from a UTF-8 file, so a Chinese
// prompt travels the exact path the plugin uses (stdin JSON) instead of argv,
// which the Windows console would mangle.

const file = process.argv[2];
if (!file) {
  console.log('usage: node scripts/verify-style-from-file.mjs <prompt.txt>');
  process.exit(2);
}
const prompt = fs.readFileSync(file, 'utf8').trim();
const companionRoot = 'C:/Users/bobo/Documents/Bot/dsh-companion';
const { config } = loadConfig(companionRoot);
const params = buildImageParams({ prompt }, config);

const request = buildBridgeRequest({ mode: 'dry-run', params, config });
request.dumpCaption = true;
const result = await runProcess(config.image.pythonPath, [path.join(process.cwd(), 'bridge/nai_generate.py')], {
  input: Buffer.from(JSON.stringify(request), 'utf8'),
  timeoutMs: 60_000,
});
const line = String(result.stdout ?? '').trim().split('\n').filter(Boolean).pop();
if (!line) {
  console.log('BRIDGE FAILED code=', result.code);
  console.log(String(result.stderr ?? '').split('\n').slice(-5).join('\n'));
  process.exit(1);
}
const out = JSON.parse(line);
console.log('promptChars:', prompt.length);
console.log('caption:', String(out.caption ?? '').slice(-120));
console.log('negativeChars:', out.negativeChars, '| model:', out.summary?.model);

if (process.argv.includes('--real')) {
  const { createImageService } = await import('../lib/imagegen.mjs');
  const { createLedger } = await import('../lib/store.mjs');
  const evidenceRoot = path.join(companionRoot, 'logs/media-migration/evidence', `style-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const service = createImageService({
    config: { ...config, image: { ...config.image, enabled: true, allowRealGeneration: true } },
    ledger: createLedger({ root: evidenceRoot }),
    root: evidenceRoot,
    run: (command, args, options) => runProcess(command, args, options),
  });
  const started = Date.now();
  const drawn = await service.generate({ prompt, source: 'user_request', sessionId: 'style-check' });
  const evidence = {
    at: new Date().toISOString(),
    evidenceLevel: '③ real model/backend generation with migrated style',
    prompt,
    elapsedMs: Date.now() - started,
    style: config.image.style.source,
    result: drawn.ok
      ? { ok: true, path: drawn.artifact.path, bytes: drawn.artifact.bytes, width: drawn.artifact.width, height: drawn.artifact.height, absolutePath: path.join(evidenceRoot, drawn.artifact.path), seed: drawn.artifact.meta?.seed }
      : { ok: false, error: drawn.error, refunded: drawn.refunded ?? null },
  };
  fs.writeFileSync(path.join(evidenceRoot, 'style-generation.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log(JSON.stringify(evidence, null, 2));
}
