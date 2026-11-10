import fs from 'node:fs';
import path from 'node:path';
// The suite has exactly one authority for "where does runtime data live". This plugin used
// to answer that question itself (`options.dataDir` → `DSH_COMPANION_DATA_DIR` →
// `<suiteRoot>/data`) and never read `config/suite.json`, so an installation that pointed
// `dataDir` anywhere but the default had its media config, logs and ledger land in
// `<suiteRoot>/data/media` while the foundation read `<custom>/home/companion/...`.
// The operator then enabled image generation in `<custom>/media/config.json` and the host
// kept answering `MEDIA_DISABLED`, because it was reading a file that did not exist.
// Importing the foundation's resolver removes the second implementation rather than
// teaching it the same rules twice.
import { resolveDataRoot } from '../../companion-foundation/suite-paths.mjs';

/**
 * personaId resolution.
 *
 * The plugin never hardcodes a persona name. Order:
 *   1. `DSH_COMPANION_PERSONA_ID`
 *   2. suite config (`config/suite.json`) → `persona.id`
 *   3. the generic default `bot`
 *
 * A missing or unreadable suite config is not an error: the media layer does not
 * depend on the persona to work, it only reports which persona it is serving.
 */
export const DEFAULT_PERSONA_ID = 'bot';

export function resolvePersonaId({ env = process.env, suiteConfig = null, fallback = DEFAULT_PERSONA_ID } = {}) {
  const fromEnv = typeof env?.DSH_COMPANION_PERSONA_ID === 'string' ? env.DSH_COMPANION_PERSONA_ID.trim() : '';
  if (fromEnv) return { id: fromEnv, source: 'env' };
  const fromSuite = typeof suiteConfig?.persona?.id === 'string' ? suiteConfig.persona.id.trim() : '';
  if (fromSuite) return { id: fromSuite, source: 'suite' };
  return { id: fallback, source: 'default' };
}

/** Read `<suiteRoot>/config/suite.json` when it exists; never throws. */
export function readSuiteConfig(suiteRoot) {
  if (!suiteRoot) return null;
  try {
    const file = path.join(suiteRoot, 'config', 'suite.json');
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Data directory resolution — a thin, documented view over
 * `companion-foundation/suite-paths.mjs#resolveDataRoot()`.
 *
 * Order (unchanged, and now identical to what the foundation and the suite CLI use):
 *   1. explicit `dataDir` option (tests and embedded callers)
 *   2. `DSH_COMPANION_DATA_DIR`
 *   3. `config/suite.json` → `dataDir`
 *   4. root `package.json` → `dsh.suite.dataDir`
 *   5. `<suiteRoot>/data` (the historical default, still what an unconfigured suite gets)
 *
 * The `source` vocabulary is kept from the old signature (`option` / `env` /
 * `config/suite.json:dataDir` / …) so a log line or a report that quoted it stays readable.
 *
 * @param {{dataDir?: string, env?: Record<string, string|undefined>, suiteRoot?: string|null}} [options]
 * @returns {{dir: string, source: string, notes: string[]}}
 */
export function resolveDataDir({ dataDir = '', env = process.env, suiteRoot = '' } = {}) {
  const explicit = String(dataDir || '').trim();
  if (explicit) return { dir: path.resolve(explicit), source: 'option', notes: [] };
  const resolved = resolveDataRoot({ env, suiteRoot: suiteRoot || null });
  const source = resolved.source === 'env:DSH_COMPANION_DATA_DIR' ? 'env' : resolved.source;
  return { dir: resolved.dataRoot, source, notes: resolved.notes ?? [] };
}
