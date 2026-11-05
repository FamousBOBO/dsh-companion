import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { ValidationError } from './errors.mjs';

// Identity is never inferred from message text or tool arguments: callers pass the
// host-resolved binding. Scope is the only address used for reads and writes.
export const DEFAULT_WORLD = 'world:default';
export const DEFAULT_PERSONA = 'march7';

export function normalizeWorldId(worldId) {
  const value = typeof worldId === 'string' ? worldId.trim() : '';
  return value === '' ? DEFAULT_WORLD : value;
}

export function normalizeScope(input = {}) {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : String(input.userId ?? '').trim();
  const personaId = typeof input.personaId === 'string' && input.personaId.trim()
    ? input.personaId.trim()
    : DEFAULT_PERSONA;
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
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}
