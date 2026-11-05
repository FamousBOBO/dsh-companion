import test from 'node:test';
import assert from 'node:assert/strict';
import { materialTargets, targetKey } from '../lib/planner.mjs';

// Real-host failure (external acceptance): the model picked a verified seed URL and the plan was
// refused `invalid-plan / slot-target-not-in-materials` with "6 targets". Root cause was a field
// name collision: the materials port ships `sources` as a **provenance map**
// (`{persona:'workspace/PERSONA.md', fixedAgenda:'runtime', interests:'missing', …}`), and the
// collector treated every value as an executable target while never reading the verified URLs out
// of `publicEntry`.
//
// These tests use the shape the real port returns. The allowlist check itself is untouched: a URL
// that is not in the material is still refused.

const SEED = 'https://zh.wikisource.org/wiki/%E6%98%A5%E6%9B%89';
const SEED2 = 'https://zh.wikisource.org/wiki/%E9%9D%9C%E5%A4%9C%E6%80%9D';

const realPortShape = {
  persona: { excerpt: '…', personaId: 'march7', version: 'abcd1234' },
  sources: {
    persona: 'workspace/PERSONA.md',
    fixedAgenda: 'runtime',
    plan: 'runtime',
    lockedSlots: 'runtime',
    runningActivities: 'runtime',
    interests: 'missing',
    goals: 'missing',
    preferences: 'missing',
    budget: 'config.p2.budget',
  },
  missing: ['interests', 'goals', 'preferences'],
  publicEntry: {
    allowedSources: ['zh.wikisource.org'],
    seedUrls: [SEED, SEED2],
    state: 'ok',
    topic: 'poetry',
    seeds: [
      { url: SEED, title: '春曉', snippet: '春眠不覺曉', verified: true, source: 'seed' },
      { url: SEED2, title: '靜夜思', snippet: '床前明月光', verified: true, source: 'search' },
    ],
  },
  entryPoints: ['home/companion/works/sources/notes.md'],
};

test('materials: verified seed URLs are real targets, provenance labels are not', () => {
  const targets = materialTargets(realPortShape);
  assert.equal(targets.includes(SEED), true, 'the verified seed URL is allowed');
  assert.equal(targets.includes(SEED2), true, 'the second verified URL is allowed as well');
  assert.equal(targets.includes('home/companion/works/sources/notes.md'), true, 'a workspace path stays a target');
  for (const label of ['runtime', 'missing', 'config.p2.budget', 'workspace/PERSONA.md']) {
    assert.equal(targets.includes(label), false, `the provenance label ${label} must never become a target`);
  }
  assert.equal(targets.length <= 32, true, 'the target list stays bounded');
});

test('materials: a URL that is not in the material is still refused (allowlist untouched)', () => {
  const targets = materialTargets(realPortShape);
  assert.equal(targets.includes('https://example.org/not-allowed'), false);
});

test('materials: legacy flat arrays keep working', () => {
  const targets = materialTargets({ entryPoints: [SEED], seeds: [{ url: SEED2 }], targets: ['sources/a.md'] });
  assert.deepEqual(targets.sort(), [SEED, SEED2, 'sources/a.md'].sort());
});

// Production natural-host run (2026-10-30 22:5x): the material offered the percent-encoded
// Wikisource URL, the real model named the decoded spelling, and the validator compared raw
// strings -> `slot-target-not-in-materials` for a plan that really did use the offered source.
// Identity is now canonical; nothing is added to the offered set.
test('materials: a URL matches the offered target in its other spelling (decode/trailing slash/case)', () => {
  const encoded = 'https://zh.wikisource.org/wiki/%E6%98%A5%E6%9B%89';
  const decoded = 'https://zh.wikisource.org/wiki/春曉';
  assert.equal(targetKey(encoded), targetKey(decoded), 'percent-encoding is the same target');
  assert.equal(targetKey('https://ZH.wikisource.org/wiki/bridge'), targetKey('https://zh.wikisource.org/wiki/bridge'), 'host case is the same target');
  // /a and /a/ may be different resources: never merged (the offered set must not widen).
  assert.notEqual(targetKey('https://zh.wikisource.org/wiki/bridge/'), targetKey('https://zh.wikisource.org/wiki/bridge'));
  assert.notEqual(targetKey('sources/a.md'), targetKey('sources/a.md/'));
  assert.equal(targetKey('notes.md'), targetKey('./notes.md'), 'a relative path form is the same target');
  const targets = materialTargets({ publicEntry: { seedUrls: [encoded] } }).map(targetKey);
  assert.equal(new Set(targets).has(targetKey(decoded)), true, 'the decoded spelling is accepted');
  assert.equal(new Set(targets).has(targetKey('https://zh.wikisource.org/wiki/%E9%9D%9C%E5%A4%9C%E6%80%9D')), false, 'a URL that was never offered is still refused');
});
test('materials: a blocked target stays excluded across entry points and URL spellings', () => {
  const targets = materialTargets({
    ...realPortShape,
    entryPoints: [SEED, ...realPortShape.entryPoints],
    blockedActivityTargets: [{ kind: 'explore', target: 'https://zh.wikisource.org/wiki/春曉' }],
  });
  assert.deepEqual(targets, [...realPortShape.entryPoints, SEED2]);
});
