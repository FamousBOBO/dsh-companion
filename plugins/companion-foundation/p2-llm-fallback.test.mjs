import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Budget accounting for physical generations (external acceptance point).
//
// `complete()` retries behind the caller's back when the route rejects an explicit effort, when
// a reasoning model burns the budget with no visible text, or on a context overflow. Those are
// real provider requests. The memory engine is charged per extraction task, so it keeps them;
// P2 reserves one budget slot per generation, so the adapter must not retry for it.
//
// The behaviour itself is exercised through the real host LLM module (not available to a unit
// test in this checkout), so this file pins the *mechanism*: the `allowFallback` seam exists, all
// three retry branches are behind it, and P2 constructs its adapter with `allowFallback: false`
// while nothing else does.

// fileURLToPath, not `new URL(...).pathname`: the pathname form stays percent-encoded, so an
// install directory containing a space or CJK characters resolves to a path that does not exist.
const here = path.dirname(fileURLToPath(import.meta.url));
const hostLlm = fs.readFileSync(path.join(here, 'host-llm.mjs'), 'utf8');
const autonomy = fs.readFileSync(path.join(here, 'autonomy.mjs'), 'utf8');

test('host-llm: the adapter exposes an allowFallback seam defaulting to the memory behaviour', () => {
  assert.match(hostLlm, /allowFallback = true/, 'the factory default keeps the memory engine behaviour');
  assert.match(hostLlm, /if \(!isUnsupportedOption\(error\) \|\| !allowFallback\) throw error;/, 'an unsupported option is rethrown unchanged when fallback is off');
  const guarded = hostLlm.match(/&& allowFallback/g) ?? [];
  assert.equal(guarded.length, 2, 'the empty-answer and context-overflow retries are both behind the switch');
});

test('P2 builds its adapter with the fallback disabled, and only P2 does', () => {
  assert.match(autonomy, /allowFallback: false/, 'the P2 model port disables the hidden retries');
  const callers = fs.readdirSync(here).filter(name => name.endsWith('.mjs') && name !== 'host-llm.mjs' && !name.endsWith('.test.mjs'));
  const withFlag = callers.filter(name => fs.readFileSync(path.join(here, name), 'utf8').includes('allowFallback: false'));
  assert.deepEqual(withFlag.sort(), ['autonomy.mjs'], 'no other module silently disables the retries');
});

test('the completion path still returns a plain string (no return-type change)', () => {
  assert.match(hostLlm, /return result\.text;/, 'callers keep receiving the text, not a wrapper object');
  assert.doesNotMatch(hostLlm, /return \{ text: result\.text/, 'no object return was introduced');
});
