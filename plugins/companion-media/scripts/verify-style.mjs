import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '../config.mjs';
import { buildImageParams, buildBridgeRequest } from '../lib/imagegen.mjs';
import { runProcess } from '../lib/exec.mjs';

// Verify that the migrated NovelAI style actually reaches the encoder: the
// dry-run reports the exact caption and negative length that would be sent.
// The prompt is read from argv so this file stays free of non-ASCII literals
// (a PowerShell round-trip previously mangled them).

const prompt = process.argv[2] ?? 'a cat sleeping on a window sill, afternoon light';
const companionRoot = 'C:/Users/bobo/Documents/Bot/dsh-companion';
const { config } = loadConfig(companionRoot);
const params = buildImageParams({ prompt }, config);
console.log('TAG   :', params.tag);
console.log('NEG   :', params.negative?.length ?? 0, 'chars | artist:', JSON.stringify(params.artist ?? null));
console.log('STYLE :', JSON.stringify({
  applyDefaults: config.image.style.applyDefaults,
  promptChars: config.image.style.defaultPrompt.length,
  negativeChars: config.image.style.defaultNegative.length,
  source: config.image.style.source,
}));

const request = buildBridgeRequest({ mode: 'dry-run', params, config });
request.dumpCaption = true;
const result = await runProcess(config.image.pythonPath, [path.join(process.cwd(), 'bridge/nai_generate.py')], {
  input: Buffer.from(JSON.stringify(request), 'utf8'),
  timeoutMs: 60_000,
});
const line = String(result.stdout ?? '').trim().split('\n').filter(Boolean).pop();
if (!line) {
  const stderr = String(result.stderr ?? '');
  fs.writeFileSync('C:/Users/bobo/Documents/Bot/dsh-companion/logs/media-migration/style-verify.err.txt', stderr, 'utf8');
  console.log('BRIDGE FAILED code=', result.code);
  console.log(stderr.split('\n').slice(-6).join('\n'));
  process.exit(1);
}
const out = JSON.parse(line);
console.log('BRIDGE ok=', out.ok, '| model:', out.summary?.model, '| size:', `${out.summary?.size}x${out.summary?.height}`, '| steps:', out.summary?.steps);
console.log('CAPTION:', String(out.caption ?? '').slice(0, 300));
console.log('NEGCHARS:', out.negativeChars);
