import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { createCoordinator } from '../lib/coordinator.mjs';

// Real-backend check for the runtime tool: warm vision, switch to voice, release.
// This drives the live 8139 coordinator, so it proves the models really load and
// unload rather than only that the settings exist.

const companionRoot = 'C:/Users/bobo/Documents/Bot/dsh-companion';
const { config } = loadConfig(companionRoot);
const coordinator = createCoordinator({ config, log: line => console.log('[log]', line) });
const steps = [];

async function step(name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    steps.push({ name, ok: true, elapsedMs: Date.now() - startedAt, result });
    console.log(`${name}: ok in ${Date.now() - startedAt}ms`, JSON.stringify(result).slice(0, 260));
    return result;
  } catch (error) {
    steps.push({ name, ok: false, elapsedMs: Date.now() - startedAt, error: String(error?.message ?? error) });
    console.log(`${name}: FAILED in ${Date.now() - startedAt}ms`, error?.message);
    return null;
  }
}

await step('status-before', () => coordinator.status());
await step('warm-vision', () => coordinator.warm({ target: 'vision' }));
await step('status-vision', () => coordinator.status());
await step('warm-voice', () => coordinator.warm({ target: 'voice' }));
await step('status-voice', () => coordinator.status());
await step('release', () => coordinator.release());
await step('status-after', () => coordinator.status());

const evidenceDir = path.join(companionRoot, 'logs/media-migration/evidence', `runtime-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const evidence = {
  at: new Date().toISOString(),
  evidenceLevel: '③ real coordinator load/switch/release',
  idleReleaseSeconds: config.runtime.idleReleaseSeconds,
  steps,
};
fs.writeFileSync(path.join(evidenceDir, 'runtime-warm-release.json'), JSON.stringify(evidence, null, 2), 'utf8');
console.log('evidence:', path.join(evidenceDir, 'runtime-warm-release.json'));
