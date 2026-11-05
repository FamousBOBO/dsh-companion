import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the host module root the foundation plugin imports from.
 *
 * Order: explicit `DSH_COMPANION_MODULE_ROOT` → the installed runtime recorded in
 * `runtime.local.json` → the bundled test fixtures. The last step keeps the
 * integration tests runnable in a sandbox or on a machine without the desktop app,
 * so a test failure means our wiring broke, not that the app is missing.
 */
export function resolveModuleRoot(repositoryRoot, env = process.env) {
  const candidates = [];
  if (env.DSH_COMPANION_MODULE_ROOT) candidates.push({ root: env.DSH_COMPANION_MODULE_ROOT, source: 'env' });
  try {
    const recorded = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'runtime.local.json'), 'utf8'));
    if (recorded?.moduleRoot) candidates.push({ root: recorded.moduleRoot, source: 'runtime.local.json' });
  } catch { /* no recorded runtime */ }
  candidates.push({ root: path.join(here, 'module-root'), source: 'fixtures' });

  for (const candidate of candidates) {
    const probe = path.join(candidate.root, '@deepseek-ai/dsh-tools/lib/index.js');
    try {
      if (fs.existsSync(probe)) return { root: candidate.root, source: candidate.source };
    } catch { /* unreadable candidate */ }
  }
  throw new Error('no usable host module root (checked env, runtime.local.json, fixtures)');
}

export function fixturesRoot() {
  return path.join(here, 'module-root');
}
