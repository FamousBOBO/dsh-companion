import test from 'node:test';
import assert from 'node:assert/strict';
import { startRetryGate, recordStartFailure } from '../lib/start-retry.mjs';
test('start retry survives reconstruction, backs off and exhausts after three failures', () => {
  const store = new Map();
  const db = { metaGet: (k, fallback) => store.get(k) ?? fallback, metaSet: (k,v) => store.set(k,v) };
  let now = 1000;
  for (let i=0; i<3; i++) {
    const gate = startRetryGate(db, 's', 'slot', now);
    assert.equal(gate.allowed, true);
    recordStartFailure(db, gate, now, 'source-invalid');
    assert.equal(startRetryGate(db, 's', 'slot', now+1).allowed, false);
    now += 1000000;
  }
  assert.equal(startRetryGate(db, 's', 'slot', now).allowed, false);
  assert.equal(startRetryGate(db, 's', 'other-slot', now).allowed, true);
});
