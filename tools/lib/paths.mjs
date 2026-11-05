/**
 * Suite path resolution.
 *
 * Every path the suite uses is derived from this module, so nothing is ever
 * hard-coded to a machine, a drive letter or a user name. The suite root is the
 * directory that contains this repository's package.json (found by walking up
 * from this file), and runtime data lives under `<suiteRoot>/data` unless the
 * suite config points somewhere else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Locate the suite root: nearest ancestor with package.json that declares name dsh-companion-suite. */
export function findSuiteRoot(startDir = HERE) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'dsh-companion-suite') return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate the DSH Companion suite root above ${startDir}`);
}

export const SUITE_ROOT = findSuiteRoot();

/** Repository-relative locations that are identical on every machine. */
export const SUITE_PATHS = {
  root: SUITE_ROOT,
  plugins: path.join(SUITE_ROOT, 'plugins'),
  sidecars: path.join(SUITE_ROOT, 'sidecars'),
  scripts: path.join(SUITE_ROOT, 'scripts'),
  tools: path.join(SUITE_ROOT, 'tools'),
  configDir: path.join(SUITE_ROOT, 'config'),
  configExample: path.join(SUITE_ROOT, 'config', 'suite.example.json'),
  configFile: path.join(SUITE_ROOT, 'config', 'suite.json'),
  personaExample: path.join(SUITE_ROOT, 'config', 'persona.example.md'),
  profileTemplateDir: path.join(SUITE_ROOT, 'config', 'profile'),
};

/** Runtime data locations are all relative to the resolved data directory. */
export function dataPaths(dataDir) {
  const root = path.resolve(dataDir);
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

/** Turn an absolute path into a file:// URL that DSH's loader accepts on every platform. */
export function toFileUrl(absPath) {
  const normalized = path.resolve(absPath).replace(/\\/g, '/');
  return 'file:///' + normalized.replace(/^\/+/, '');
}

/** True when `child` is inside `parent` (case-insensitive on Windows). */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export default { SUITE_ROOT, SUITE_PATHS, dataPaths, toFileUrl, findSuiteRoot, isInside };
