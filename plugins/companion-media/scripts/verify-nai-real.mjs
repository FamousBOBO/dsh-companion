import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeConfig } from '../config.mjs';
import { createLedger } from '../lib/store.mjs';
import { createImageService } from '../lib/imagegen.mjs';
import { runProcess } from '../lib/exec.mjs';

// Minimal real NovelAI generation.
//
// Two gates: this script never runs without `--real`, and the media config also
// needs `image.allowRealGeneration`. One picture is generated from a synthetic,
// non-private subject so the acceptance proves transport, decoding, geometry and
// the artifact ledger — not artistic quality.
//
//   node scripts/verify-nai-real.mjs            # dry-run only
//   node scripts/verify-nai-real.mjs --real     # one real generation

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companionRoot = path.resolve(packageRoot, '../..');
const real = process.argv.includes('--real');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(companionRoot, 'logs/media-migration/evidence', `nai-${runId}`);
const workRoot = path.join(evidenceDir, 'work');
fs.mkdirSync(workRoot, { recursive: true });

const { config: stored } = loadConfig(companionRoot);
const config = normalizeConfig({
  ...stored,
  image: { ...stored.image, enabled: true, allowRealGeneration: real },
});

const ledger = createLedger({ root: workRoot, file: 'state/ledger.json', maxCacheItems: 10 });
const log = entry => fs.appendFileSync(path.join(evidenceDir, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
const service = createImageService({ config, ledger, log, run: runProcess, root: workRoot });

const prompt = 'a single red apple on a white table, simple flat lighting';
const startedAt = Date.now();
const result = await service.generate({
  prompt,
  source: 'user_request',
  channel: 'private_owner',
  sessionId: 'verify-session',
  idempotencyKey: `verify-nai:${runId}`,
});

const evidence = {
  at: new Date().toISOString(),
  runId,
  evidenceLevel: real ? '③ real model/backend generation' : '② unit/mock (dry-run through the real encoder)',
  realGenerationRequested: real,
  subject: 'synthetic still life (one red apple), no person, no private material',
  elapsedMs: Date.now() - startedAt,
  result: result.ok
    ? {
      ok: true,
      dryRun: Boolean(result.dryRun),
      paramsDigest: result.paramsDigest,
      summary: result.summary ?? (result.artifact ? result.artifact.meta : undefined),
      artifact: result.artifact ? {
        path: result.artifact.path,
        bytes: result.artifact.bytes,
        width: result.artifact.width,
        height: result.artifact.height,
        sha256: result.artifact.sha256.slice(0, 16),
        absolutePath: path.join(workRoot, result.artifact.path),
      } : undefined,
      quota: result.quota,
    }
    : { ok: false, error: result.error, refunded: result.refunded ?? null },
  cost: 'Opus free mode is enabled in the pipeline config; spend cannot be confirmed from the API response — record as unknown unless the account page is checked.',
};
fs.writeFileSync(path.join(evidenceDir, 'nai-request.json'), JSON.stringify(evidence, null, 2), 'utf8');
console.log(JSON.stringify(evidence, null, 2));
