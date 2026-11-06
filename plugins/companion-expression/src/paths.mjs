/**
 * Every path this module touches, derived from the suite data root.
 *
 * The root is resolved by `companion-foundation/suite-paths.mjs` (decision D2), exactly like
 * every other module in this suite: nothing here may depend on where the source tree sits.
 *
 * Layout (all under `<dataDir>/`):
 *   home/expression/expression.sqlite   the library, delivery log, feedback, quotas
 *   home/expression/assets/<aa>/<sha>   physically de-duplicated image bytes
 *   home/expression/quarantine/         rejected or unreviewable downloads (never sendable)
 *   home/expression/queue/              temporary staging for in-flight analysis
 *   home/media/expression-out/          the only directory group chat may send images from
 *
 * The staging root lives under `home/media` on purpose: `companion-group/core.mjs` lets a group
 * turn send only files inside `home/media`, so staging there keeps the guard meaningful instead
 * of widening it to every sticker directory on disk.
 */
import path from 'node:path';
import { resolveDataRoot } from '../../companion-foundation/suite-paths.mjs';

/** The one directory group chat is allowed to send images from. */
export const MEDIA_SUBDIR = 'expression-out';
/** Default staging directory, relative to the data root. */
export const DEFAULT_STAGE_ROOT = `home/media/${MEDIA_SUBDIR}`;
/** Default library directory, relative to the data root. */
export const DEFAULT_LIBRARY_ROOT = 'home/expression';

/**
 * @param {{moduleUrl?: string|URL, env?: Record<string, string|undefined>}} [options]
 * @returns {{
 *   dataRoot: string, home: string, mediaRoot: string, root: string,
 *   dbFile: string, assets: string, quarantine: string, queue: string,
 *   configFile: string, defaultStageRoot: string, stageRoot: string,
 *   source: string
 * }}
 */
export function expressionPaths({ moduleUrl = import.meta.url, env = process.env } = {}) {
  const { dataRoot, source } = resolveDataRoot({ moduleUrl, env });
  const home = path.join(dataRoot, 'home');
  const root = path.join(home, 'expression');
  const mediaRoot = path.join(home, 'media');
  return {
    dataRoot,
    home,
    mediaRoot,
    root,
    dbFile: path.join(root, 'expression.sqlite'),
    assets: path.join(root, 'assets'),
    quarantine: path.join(root, 'quarantine'),
    queue: path.join(root, 'queue'),
    configFile: path.join(root, 'config.json'),
    defaultStageRoot: DEFAULT_STAGE_ROOT,
    stageRoot: path.join(mediaRoot, MEDIA_SUBDIR),
    source,
  };
}

/**
 * Resolve a configured staging root against the data root.
 *
 * Accepted forms: a relative path (resolved against `dataRoot`) or an absolute one. Anything is
 * then re-checked: it must stay inside `<dataDir>/home/media`, because that is the only root the
 * group guard trusts. A configuration that points elsewhere is not honoured — the caller gets the
 * default and a warning, never a silently widened boundary.
 *
 * @param {string} dataRoot
 * @param {string} configured value from `config.delivery.stageRoot`
 * @returns {{path: string, ok: boolean, reason: string}}
 */
export function resolveStageRoot(dataRoot, configured) {
  const mediaRoot = path.join(path.resolve(dataRoot), 'home', 'media');
  const fallback = path.join(mediaRoot, MEDIA_SUBDIR);
  const text = String(configured ?? '').trim();
  if (!text) return { path: fallback, ok: true, reason: 'default' };
  const absolute = path.isAbsolute(text) ? path.normalize(text) : path.resolve(dataRoot, text);
  const relative = path.relative(mediaRoot, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { path: fallback, ok: false, reason: 'outside-home-media' };
  }
  return { path: absolute, ok: true, reason: 'configured' };
}

/** True when `child` resolves inside `parent` (both absolute). */
export function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export default { expressionPaths, resolveStageRoot, inside, DEFAULT_STAGE_ROOT, DEFAULT_LIBRARY_ROOT };
