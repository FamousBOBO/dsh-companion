import path from 'node:path';
import { groupIdOf, groupIsReady, groupToolDenial } from './core.mjs?v=group-media-20261102-restrict3';
import { resolveDataRoot } from '../companion-foundation/suite-paths.mjs';

export const name = 'companion-group-boundary';
export const inject = ['tools'];

const COMPANION_ROOT = resolveDataRoot({ moduleUrl: import.meta.url }).dataRoot;
const MEDIA_ROOT = path.join(COMPANION_ROOT, 'home', 'media');
const MEDIA_ARTIFACT_ROOT = path.join(COMPANION_ROOT, 'workspace', 'media');

export function apply(ctx) {
  // Monotonic host guard runs after extensible pre-execute middleware; a later
  // plugin cannot override a denial. Refuse loading on unsupported hosts.
  if (typeof ctx.tools?.guard !== 'function') throw Error('Group isolation requires tools.guard().');
  ctx.tools.guard(exec => groupToolDenial(exec, { mediaRoot: MEDIA_ROOT, mediaRoots: [MEDIA_ARTIFACT_ROOT] }));
  console.log('[companion-group] monotonic tool boundary mounted');
  ctx.on('agent/pre-step', async (event, next) => {
    if (groupIdOf(event.agent) === null) return next();
    const decision = await next();
    if (!groupIsReady(event.agent)) return { kind: 'reject' };
    return decision;
  }, { prepend: true });
}
