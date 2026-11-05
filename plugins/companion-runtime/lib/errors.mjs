// Typed failures for the cognitive runtime. Every error carries a stable `code`
// so diagnostics and tests never depend on message wording.
export class RuntimeError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export class ValidationError extends RuntimeError {
  constructor(message, detail) {
    super('invalid-input', message, detail);
    this.name = 'ValidationError';
  }
}

export class StaleRevisionError extends RuntimeError {
  constructor(kind, expected, actual) {
    super('stale-revision', `${kind}: expected revision ${expected}, current ${actual}`, { expected, actual });
    this.name = 'StaleRevisionError';
  }
}

export class StaleGenerationError extends RuntimeError {
  constructor(expected, actual) {
    super('stale-generation', `generation ${expected} is no longer the writer (current ${actual})`, { expected, actual });
    this.name = 'StaleGenerationError';
  }
}

export class ScopeError extends RuntimeError {
  constructor(message) {
    super('scope-denied', message);
    this.name = 'ScopeError';
  }
}

export class RuntimeStoppedError extends RuntimeError {
  constructor() {
    super('runtime-stopped', 'the cognitive runtime is stopped; no new commit is accepted');
    this.name = 'RuntimeStoppedError';
  }
}

export function asRuntimeError(error) {
  if (error instanceof RuntimeError) return error;
  return new RuntimeError('internal', error instanceof Error ? error.message : String(error));
}
