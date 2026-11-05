import path from 'node:path';
import crypto from 'node:crypto';
import { ValidationError } from './errors.mjs';
import { resolveDataRoot } from '../../companion-foundation/suite-paths.mjs';

// Identity is never inferred from message text or tool arguments: callers pass the
// host-resolved binding. Scope is the only address used for reads and writes.
export const DEFAULT_WORLD = 'world:default';
/**
 * Persona id used when a caller does not pass one. It is a generic default, not a
 * character: the plugin boundary resolves `DSH_COMPANION_PERSONA_ID` → the suite
 * config → `bot` and passes the result down (D1 in the release team brief).
 */
export const DEFAULT_PERSONA = 'bot';

/** Environment override for the default persona id, else the documented default. */
export function defaultPersonaId(env = process.env) {
  const value = String(env?.DSH_COMPANION_PERSONA_ID ?? '').trim();
  return value || DEFAULT_PERSONA;
}

export function normalizeWorldId(worldId) {
  const value = typeof worldId === 'string' ? worldId.trim() : '';
  return value === '' ? DEFAULT_WORLD : value;
}

export function normalizeScope(input = {}) {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : String(input.userId ?? '').trim();
  const personaId = typeof input.personaId === 'string' && input.personaId.trim()
    ? input.personaId.trim()
    : defaultPersonaId();
  const worldId = normalizeWorldId(input.worldId);
  if (!userId) throw new ValidationError('scope requires a trusted userId');
  if (userId === '*' || personaId === '*') throw new ValidationError('wildcard scope is not writable');
  return Object.freeze({ userId, personaId, worldId });
}

export function scopeKey(scope) {
  const normalized = normalizeScope(scope);
  return `u:${normalized.userId}|p:${normalized.personaId}|w:${normalized.worldId}`;
}

export function parseScope(key) {
  const match = /^u:(.+)\|p:(.+)\|w:(.+)$/.exec(String(key ?? ''));
  if (!match) return null;
  return normalizeScope({ userId: match[1], personaId: match[2], worldId: match[3] });
}

export function sameScope(a, b) {
  return Boolean(a && b) && a.userId === b.userId && a.personaId === b.personaId && a.worldId === b.worldId;
}

// A session id may carry context but never constitutes identity; this helper only
// records provenance and refuses to widen a scope.
export function scopeFromBinding(binding, sessionId = '') {
  const scope = normalizeScope(binding ?? {});
  return { scope, sessionId: typeof sessionId === 'string' ? sessionId : '' };
}

export function digest(value, length = 16) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, length);
}

export function runtimeDir(root) {
  return path.join(root, 'home/companion');
}

export function databaseFile(root) {
  return process.env.DSH_COMPANION_RUNTIME_DB || path.join(runtimeDir(root), 'companion-runtime.db');
}

export function packageRoot() {
  // The runtime's own root is the suite data root (D2), not the directory this
  // package happens to sit in. A preset passes its root explicitly; this path is
  // only for mounting the runtime as a standalone plugin.
  return resolveDataRoot({ moduleUrl: import.meta.url }).dataRoot;
}
