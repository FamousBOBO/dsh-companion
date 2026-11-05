import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256OfJson(value) {
  return sha256Hex(Buffer.from(stableJson(value), 'utf8'));
}

/** Deterministic JSON so a params digest never depends on key insertion order. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Resolve a path that must stay inside a managed root.
 * @returns the absolute path when it is inside `root`.
 * @throws an error with `code = 'MEDIA_PATH_ESCAPE'` otherwise.
 */
export function resolveInside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(base, candidate);
  const relative = path.relative(base, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error(`path escapes managed root: ${candidate}`);
    error.code = 'MEDIA_PATH_ESCAPE';
    throw error;
  }
  return target;
}

export function relativeTo(root, absolute) {
  return path.relative(path.resolve(root), path.resolve(absolute)).split(path.sep).join('/');
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
