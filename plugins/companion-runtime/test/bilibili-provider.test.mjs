import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBilibiliProviderPort } from '../lib/bilibili-provider.mjs';

test('Bilibili port follows provider mount, takeover and removal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bili-provider-'));
  const key = realpathSync(directory);
  const symbol = Symbol.for('dsh.companion.bilibili.providers.v1');
  const registry = process[symbol] ??= new Map();
  t.after(() => {
    registry.delete(key);
    rmSync(directory, { recursive: true, force: true });
  });
  const port = createBilibiliProviderPort(directory, { now: () => 1000 });
  assert.equal(port.available(), false);
  let takeover = false;
  registry.set(key, {
    ready: () => takeover,
    run({ record }) {
      record({ kind: 'report', written: true });
      return { status: 'completed' };
    },
  });
  assert.equal(port.available(), false);
  takeover = true;
  assert.equal(port.available(), true);
  const request = { roundId: 'test-round', deadlineAt: 5000 };
  const result = await port(request);
  assert.deepEqual(result, { roundId: 'test-round', status: 'completed', evidence: [{ kind: 'report', written: true }] });
  registry.delete(key);
  assert.equal(port.available(), false);
  assert.deepEqual(await port(request), result);
});
