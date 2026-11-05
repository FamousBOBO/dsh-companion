import fs from 'node:fs';
import path from 'node:path';
import { createServiceBridge } from './service-bridge.mjs';
import { createShareCandidatePort } from './autonomy-share.mjs';

export function contactSharePort(ctx, root) {
  const bridge = createServiceBridge(root);
  const enabled = () => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'home/companion/runtime.config.json'), 'utf8')).p2?.share?.enabled === true; }
    catch { return false; }
  };
  const resolve = () => {
    try {
      const value = bridge.resolve('companionContactShare') ?? (typeof ctx?.get === 'function'
        ? ctx.get('companionContactShare') ?? ctx.get('companionContact')
        : ctx?.companionContactShare ?? ctx?.companionContact);
      return typeof value?.submitShareCandidate === 'function' ? value : null;
    } catch { return null; }
  };
  const fallback = createShareCandidatePort({ root, enabled });
  let bound = Boolean(resolve());
  return {
    ...fallback,
    get available() { return Boolean(resolve()) || (!bound && enabled()); },
    get sink() { return resolve() ? 'contact-service' : bound ? 'unavailable' : 'jsonl-queue'; },
    get degraded() { return resolve() ? '' : bound ? 'share-port-unavailable' : 'contact-service-unavailable'; },
    submit(candidate) {
      if (!enabled()) return Promise.resolve({ ok: false, code: 'share-disabled', written: false });
      const service = resolve();
      if (service) { bound = true; return service.submitShareCandidate(candidate); }
      // An unloaded sender is not an authorization to resurrect its old reference or orphan a new candidate.
      if (bound) return Promise.resolve({ ok: false, code: 'share-port-unavailable', written: false });
      return fallback.submit(candidate);
    },
  };
}
