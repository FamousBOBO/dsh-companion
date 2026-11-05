import path from 'node:path';

// One managed root for every media product.
//
// Review round 1 found the code writing to `<root>/media/...` while the contract
// and the docs promised `home/media/...`. Keeping the mapping in one place means
// the inbox, the artifacts and the contract cannot drift apart again.

export const MANAGED_DIR = 'home/media';

export function managedRoot(companionRoot) {
  return path.join(companionRoot, MANAGED_DIR);
}

/** Absolute directory for one managed sub-path (for example `artifacts/speech`). */
export function managedPath(companionRoot, relative) {
  return path.join(managedRoot(companionRoot), relative);
}

/** Path as stored in artifacts: relative to the companion root, always with `/`. */
export function managedRelative(companionRoot, absolute) {
  return path.relative(companionRoot, absolute).split(path.sep).join('/');
}
