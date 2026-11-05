import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBilibiliRounds } from '../lib/bilibili-rounds.mjs';

test('an exhausted quota is preserved as a terminal result without execution evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bili-quota-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = createBilibiliRounds({ directory, now: () => 1000, execute: () => ({ status: 'quota-exhausted' }) });
  const request = { roundId: 'quota', deadlineAt: 2000 };
  assert.deepEqual(await run(request), { roundId: 'quota', status: 'quota-exhausted', evidence: [] });
  assert.deepEqual(await run(request), { roundId: 'quota', status: 'quota-exhausted', evidence: [] });
});

test('Bilibili preserves partial evidence and never repeats a claimed round', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bili-round-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const request = { roundId: 'activity:one', deadlineAt: 2000 };
  const report = { kind: 'report', written: true };
  const watch = { kind: 'watch', videoId: 'BV1ab2cd3ef4', consumedSeconds: 19 };
  const interaction = { kind: 'interaction', action: 'comment', targetId: watch.videoId, status: 'unknown' };
  const run = createBilibiliRounds({
    directory, now: () => 1000,
    async execute({ record }) {
      record(report);
      assert.deepEqual(await run(request), { roundId: request.roundId, status: 'unknown', evidence: [report] });
      record(watch);
      record(interaction);
      throw new Error('response lost');
    },
  });
  const result = await run(request);
  assert.deepEqual(result, { roundId: request.roundId, status: 'unknown', evidence: [report, watch, interaction] });
  const restarted = createBilibiliRounds({
    directory, now: () => 3000,
    execute() { assert.fail('claimed round was executed again'); },
  });
  assert.deepEqual(await restarted(request), result);
});
