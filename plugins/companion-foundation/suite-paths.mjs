/**
 * Suite path resolution for the companion plugins.
 *
 * Nothing here may be derived from where the source tree happens to sit on the
 * author's machine: every runtime path comes out of this module, and every input
 * has a documented default so a missing config never crashes a mount.
 *
 * Resolution order (decision D2 in the release team brief):
 *
 * 1. `suiteRoot`  — nearest ancestor of this module that has a `package.json`
 *                   with `"name": "dsh-companion-suite"`.
 *                   `DSH_COMPANION_SUITE_ROOT` overrides the walk (tests / CI).
 * 2. `dataRoot`   — `DSH_COMPANION_DATA_DIR` (absolute, or relative to suiteRoot)
 *                   → `config/suite.json` `dataDir` (relative to suiteRoot)
 *                   → root `package.json` `dsh.suite.dataDir`
 *                   → `<suiteRoot>/data`
 *                   → no suiteRoot at all: `$DSH_HOME/companion`
 *                   → last resort: the module's own `../..` (old source layout).
 * 3. persona file — `<suiteRoot>/config/persona.md`
 *                   → `<suiteRoot>/config/persona.example.md` (template, reported as such)
 *                   → `<dataRoot>/workspace/PERSONA.md` (legacy layout, stillread for upgrades).
 * 4. `personaId`  — `DSH_COMPANION_PERSONA_ID` → `config/suite.json` `persona.id`
 *                   → `'bot'`.
 *
 * The runtime data keeps the historical internal layout (`home/`, `workspace/`,
 * `logs/`, …) under `dataRoot`; only the root itself moved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The generic default persona id. Users override it; nothing is character specific. */
export const DEFAULT_PERSONA_ID = 'bot';
/** Directory name created under the suite root when the config does not name one. */
export const DEFAULT_DATA_DIR = 'data';
/** Suite package name that marks the repository root. */
export const SUITE_PACKAGE_NAME = 'dsh-companion-suite';

const MAX_WALK = 24;

function readJsonOrNull(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function moduleDir(moduleUrl) {
  const url = moduleUrl ?? import.meta.url;
  return path.dirname(url instanceof URL ? fileURLToPath(url) : fileURLToPath(new URL(String(url), 'file:')));
}

/**
 * Walk up from a directory looking for the suite root.
 * @param {string} startDir absolute directory to start from
 * @returns {string|null} absolute suite root, or null when this is not a suite checkout
 */
export function findSuiteRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < MAX_WALK; i += 1) {
    const pkg = readJsonOrNull(path.join(dir, 'package.json'));
    if (pkg && pkg.name === SUITE_PACKAGE_NAME) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * @param {{moduleUrl?: string|URL, env?: Record<string, string|undefined>}} [options]
 * @returns {string|null}
 */
export function resolveSuiteRoot({ moduleUrl, env = process.env } = {}) {
  const override = String(env?.DSH_COMPANION_SUITE_ROOT ?? '').trim();
  if (override) return path.resolve(override);
  return findSuiteRoot(moduleDir(moduleUrl));
}

function resolveFrom(base, value) {
  const target = String(value ?? '').trim();
  if (!target) return '';
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(base, target);
}

/**
 * Resolve the directory that holds all runtime data.
 * @param {{moduleUrl?: string|URL, env?: Record<string, string|undefined>}} [options]
 * @returns {{dataRoot: string, suiteRoot: string|null, source: string, notes: string[]}}
 */
export function resolveDataRoot({ moduleUrl, env = process.env } = {}) {
  const notes = [];
  const suiteRoot = resolveSuiteRoot({ moduleUrl, env });

  const fromEnv = String(env?.DSH_COMPANION_DATA_DIR ?? '').trim();
  if (fromEnv) {
    const dataRoot = resolveFrom(suiteRoot ?? moduleDir(moduleUrl), fromEnv);
    return { dataRoot, suiteRoot, source: 'env:DSH_COMPANION_DATA_DIR', notes };
  }

  if (suiteRoot) {
    const suiteConfig = readJsonOrNull(path.join(suiteRoot, 'config', 'suite.json')) ?? {};
    const configured = resolveFrom(suiteRoot, suiteConfig.dataDir);
    if (configured) return { dataRoot: configured, suiteRoot, source: 'config/suite.json:dataDir', notes };
    const rootPackage = readJsonOrNull(path.join(suiteRoot, 'package.json')) ?? {};
    const packaged = resolveFrom(suiteRoot, rootPackage?.dsh?.suite?.dataDir);
    if (packaged) return { dataRoot: packaged, suiteRoot, source: 'package.json:dsh.suite.dataDir', notes };
    return { dataRoot: path.join(suiteRoot, DEFAULT_DATA_DIR), suiteRoot, source: 'suite-root:data', notes };
  }

  const dshHome = String(env?.DSH_HOME ?? '').trim();
  if (dshHome) {
    return { dataRoot: path.join(path.resolve(dshHome), 'companion'), suiteRoot: null, source: 'DSH_HOME:companion', notes };
  }

  notes.push('suite root not found (no package.json named dsh-companion-suite above this module) and DSH_HOME is unset; runtime data falls back to the source layout. Set DSH_COMPANION_DATA_DIR to place it explicitly.');
  return { dataRoot: path.resolve(moduleDir(moduleUrl), '../..'), suiteRoot: null, source: 'module:../..', notes };
}

/**
 * Resolve the persona document.
 * @param {{suiteRoot?: string|null, dataRoot?: string|null}} [options]
 * @returns {{file: string|null, source: 'config'|'template'|'legacy'|'missing', notes: string[]}}
 */
export function resolvePersonaFile({ suiteRoot = null, dataRoot = null } = {}) {
  const notes = [];
  if (suiteRoot) {
    const configured = path.join(suiteRoot, 'config', 'persona.md');
    if (fs.existsSync(configured)) return { file: configured, source: 'config', notes };
    const template = path.join(suiteRoot, 'config', 'persona.example.md');
    if (fs.existsSync(template)) {
      notes.push('config/persona.md is missing; using config/persona.example.md (the built-in template). Copy it to config/persona.md and edit it.');
      return { file: template, source: 'template', notes };
    }
  }
  if (dataRoot) {
    const legacy = path.join(dataRoot, 'workspace', 'PERSONA.md');
    if (fs.existsSync(legacy)) {
      notes.push('using the legacy workspace/PERSONA.md; move it to config/persona.md so it survives data resets.');
      return { file: legacy, source: 'legacy', notes };
    }
  }
  notes.push('no persona file found (config/persona.md, config/persona.example.md, workspace/PERSONA.md); the companion mounts without a persona section.');
  return { file: null, source: 'missing', notes };
}

/**
 * Resolve the persona id used for scopes, identity and wiki topics.
 * @param {{suiteRoot?: string|null, env?: Record<string, string|undefined>}} [options]
 * @returns {{personaId: string, source: string}}
 */
export function resolvePersonaId({ suiteRoot = null, env = process.env } = {}) {
  const fromEnv = String(env?.DSH_COMPANION_PERSONA_ID ?? '').trim();
  if (fromEnv) return { personaId: fromEnv, source: 'env:DSH_COMPANION_PERSONA_ID' };
  if (suiteRoot) {
    const suiteConfig = readJsonOrNull(path.join(suiteRoot, 'config', 'suite.json')) ?? {};
    const configured = String(suiteConfig?.persona?.id ?? '').trim();
    if (configured) return { personaId: configured, source: 'config/suite.json:persona.id' };
  }
  return { personaId: DEFAULT_PERSONA_ID, source: 'default' };
}

/**
 * Data locations under `dataRoot`. Mirrors `tools/lib/paths.mjs#dataPaths` so the
 * plugins and the suite CLI always agree on where a directory lives.
 * @param {string} dataRoot
 */
export function dataDirs(dataRoot) {
  const root = path.resolve(dataRoot);
  return {
    root,
    home: path.join(root, 'home'),
    workspace: path.join(root, 'workspace'),
    groupWorkspace: path.join(root, 'group-workspace'),
    desktopData: path.join(root, 'desktop-data'),
    temp: path.join(root, 'tmp'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, 'backups'),
    profiles: path.join(root, 'home', 'profiles'),
  };
}

/**
 * Everything a plugin needs in one call.
 * @param {{moduleUrl?: string|URL, env?: Record<string, string|undefined>}} [options]
 */
export function resolveSuitePaths({ moduleUrl, env = process.env } = {}) {
  const { dataRoot, suiteRoot, source, notes } = resolveDataRoot({ moduleUrl, env });
  const persona = resolvePersonaFile({ suiteRoot, dataRoot });
  const personaId = resolvePersonaId({ suiteRoot, env });
  return {
    suiteRoot,
    dataRoot,
    dataSource: source,
    dirs: dataDirs(dataRoot),
    configDir: suiteRoot ? path.join(suiteRoot, 'config') : null,
    configFile: suiteRoot ? path.join(suiteRoot, 'config', 'suite.json') : null,
    personaFile: persona.file,
    personaSource: persona.source,
    personaId: personaId.personaId,
    personaIdSource: personaId.source,
    notes: [...notes, ...persona.notes],
  };
}

export default {
  DEFAULT_PERSONA_ID,
  DEFAULT_DATA_DIR,
  findSuiteRoot,
  resolveSuiteRoot,
  resolveDataRoot,
  resolvePersonaFile,
  resolvePersonaId,
  resolveSuitePaths,
  dataDirs,
};
