import fs from 'node:fs';
import path from 'node:path';

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
 * Data directory resolution: explicit option → `DSH_COMPANION_DATA_DIR` →
 * `<suiteRoot>/data`. Runtime output never lands inside the source tree.
 */
export function resolveDataDir({ dataDir = '', env = process.env, suiteRoot = '' } = {}) {
  const explicit = String(dataDir || '').trim();
  if (explicit) return { dir: path.resolve(explicit), source: 'option' };
  const fromEnv = String(env?.DSH_COMPANION_DATA_DIR || '').trim();
  if (fromEnv) return { dir: path.resolve(fromEnv), source: 'env' };
  if (suiteRoot) return { dir: path.resolve(suiteRoot, 'data'), source: 'suite-root' };
  return { dir: path.resolve('data'), source: 'cwd' };
}
