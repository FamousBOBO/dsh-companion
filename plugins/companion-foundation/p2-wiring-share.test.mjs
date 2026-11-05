import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHARE_DEGRADED,
  SHARE_SCHEMA,
  SHARE_SINK_RELATIVE,
  createShareCandidatePort,
} from './autonomy-share.mjs';

// Contract v1.2 section 6. There is no cross-plugin contact seam today (see the module
// header and the implementation notes for file:line evidence), so the P2 side defines the
// minimal receiver: a durable JSONL candidate inbox. It must never send anything, write
// nothing while the share switch is off, and dedupe per activity.

const here = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);
const SCOPE_A = 'u:10001|p:bot|w:world:default';
const SCOPE_B = 'u:2000000001|p:bot|w:world:default';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-share-'));
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows lock leftover */ } });
  return root;
}

function sinkFile(root) {
  return path.join(root, SHARE_SINK_RELATIVE);
}

function lines(root) {
  try {
    return fs.readFileSync(sinkFile(root), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch { return []; }
}

const CANDIDATE = Object.freeze({
  scopeKey: SCOPE_A,
  candidateId: 'shr_0001',
  activityId: 'act_read_1',
  kind: 'activity',
  title: '读到了一座桥',
  body: '今天读到的那座桥，讲的是同一件事被不同的人记住。',
  sourceRef: 'url:https://en.wikipedia.org/wiki/Bridge',
});

// ---------------------------------------------------------------------------
// switch off
// ---------------------------------------------------------------------------

test('with the share switch off nothing is submitted and nothing is written', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: false, now: () => T0 });
  assert.equal(port.available, false);
  const result = await port.submit({ ...CANDIDATE });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'share-disabled');
  assert.equal(result.written, false);
  assert.equal(fs.existsSync(sinkFile(root)), false, 'the sink file is never created');
  assert.equal(lines(root).length, 0);
  assert.equal(port.describe().degraded, 'share-disabled');
});

test('the switch is read live, so flipping it on starts writing without a remount', async t => {
  const root = makeRoot(t);
  let on = false;
  const port = createShareCandidatePort({ root, enabled: () => on, now: () => T0 });
  assert.equal((await port.submit({ ...CANDIDATE })).code, 'share-disabled');
  assert.equal(lines(root).length, 0);
  on = true;
  const submitted = await port.submit({ ...CANDIDATE });
  assert.equal(submitted.ok, true);
  assert.equal(lines(root).length, 1);
});

// ---------------------------------------------------------------------------
// one line per candidate, deduped per activity, scope-bound
// ---------------------------------------------------------------------------

test('switching on appends exactly one scope-bound line per candidate', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  const first = await port.submit({ ...CANDIDATE });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.written, true);
  assert.equal(first.line, 1);
  assert.equal(first.sink, 'jsonl');
  const written = lines(root);
  assert.equal(written.length, 1);
  assert.equal(written[0].schema, SHARE_SCHEMA);
  assert.equal(written[0].type, 'candidate');
  assert.equal(written[0].scopeKey, SCOPE_A);
  assert.equal(written[0].activityId, 'act_read_1');
  assert.equal(written[0].candidateId, 'shr_0001');
  assert.equal(written[0].submittedAt, T0);
  assert.equal(written[0].source, 'p2');
  assert.equal('sent' in written[0], false, 'a candidate is never a delivery record');
});

test('resubmitting the same activity is a duplicate and appends nothing', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  await port.submit({ ...CANDIDATE });
  const again = await port.submit({ ...CANDIDATE, candidateId: 'shr_0002' });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.written, false);
  assert.equal(lines(root).length, 1, 'one activity, one candidate line');

  const otherActivity = await port.submit({ ...CANDIDATE, candidateId: 'shr_0003', activityId: 'act_write_9', kind: 'write' });
  assert.equal(otherActivity.duplicate, false);
  assert.equal(lines(root).length, 2, 'a different activity gets its own line');
});

test('a malformed or missing scope is refused instead of written', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  for (const candidate of [
    { ...CANDIDATE, scopeKey: '' },
    { ...CANDIDATE, scopeKey: 'u:10001|p:bot' },
    { ...CANDIDATE, candidateId: '' },
    { ...CANDIDATE, title: '   ' },
  ]) {
    const refused = await port.submit(candidate);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'invalid-candidate');
    assert.equal(refused.written, false);
  }
  assert.equal(lines(root).length, 0);
});

test('the reader is scope-bound and fold-based', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  await port.submit({ ...CANDIDATE });
  await port.submit({ ...CANDIDATE, scopeKey: SCOPE_B, candidateId: 'shr_b1', activityId: 'act_b' });
  const a = port.read({ scopeKey: SCOPE_A });
  assert.equal(a.candidates.length, 1);
  assert.equal(a.candidates[0].candidateId, 'shr_0001');
  assert.equal(a.candidates[0].status, 'pending');
  const b = port.read({ scopeKey: SCOPE_B });
  assert.equal(b.candidates.length, 1);
  assert.equal(b.candidates[0].candidateId, 'shr_b1');
  const all = port.read({ status: 'all' });
  assert.equal(all.candidates.length, 2);
});

// ---------------------------------------------------------------------------
// withdrawal appends a record
// ---------------------------------------------------------------------------

test('withdraw appends a withdrawal record and the folded state becomes withdrawn', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  await port.submit({ ...CANDIDATE });
  const withdrawn = await port.withdraw({ scopeKey: SCOPE_A, candidateId: 'shr_0001', reason: 'changed-mind' });
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.written, true);
  const written = lines(root);
  assert.equal(written.length, 2, 'history is appended, never rewritten');
  assert.equal(written[1].type, 'withdrawal');
  assert.equal(written[1].candidateId, 'shr_0001');
  assert.equal(written[1].reason, 'changed-mind');
  const pending = port.read({ scopeKey: SCOPE_A });
  assert.equal(pending.candidates.length, 0, 'a withdrawn candidate is no longer pending');
  const all = port.read({ scopeKey: SCOPE_A, status: 'all' });
  assert.equal(all.candidates[0].status, 'withdrawn');
  assert.equal(all.candidates[0].withdrawReason, 'changed-mind');
});

test('withdraw refuses an unknown, foreign-scope or already-withdrawn candidate', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  await port.submit({ ...CANDIDATE });
  assert.equal((await port.withdraw({ scopeKey: SCOPE_A, candidateId: 'shr_missing' })).code, 'candidate-not-found');
  assert.equal((await port.withdraw({ scopeKey: SCOPE_B, candidateId: 'shr_0001' })).code, 'scope-mismatch');
  await port.withdraw({ scopeKey: SCOPE_A, candidateId: 'shr_0001' });
  assert.equal((await port.withdraw({ scopeKey: SCOPE_A, candidateId: 'shr_0001' })).code, 'candidate-not-pending');
  assert.equal(lines(root).length, 2, 'refusals write nothing');
});

test('a withdrawn activity may be proposed again; the old line stays withdrawn', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  await port.submit({ ...CANDIDATE });
  await port.withdraw({ scopeKey: SCOPE_A, candidateId: 'shr_0001', reason: 'changed-mind' });
  const again = await port.submit({ ...CANDIDATE, candidateId: 'shr_0005', title: '另一个说法' });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, false, 'withdrawal frees the activity identity');
  assert.equal(lines(root).length, 3);
  const pending = port.read({ scopeKey: SCOPE_A });
  assert.deepEqual(pending.candidates.map(item => item.candidateId), ['shr_0005']);
  const all = port.read({ scopeKey: SCOPE_A, status: 'all' });
  assert.equal(all.candidates.find(item => item.candidateId === 'shr_0001').status, 'withdrawn');
});

test('with the switch off neither submit nor withdraw touches the sink', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  await port.submit({ ...CANDIDATE });
  const off = createShareCandidatePort({ root, enabled: false, now: () => T0 });
  assert.equal((await off.withdraw({ scopeKey: SCOPE_A, candidateId: 'shr_0001' })).code, 'share-disabled');
  assert.equal(lines(root).length, 1);
});

// ---------------------------------------------------------------------------
// durability, corruption, containment
// ---------------------------------------------------------------------------

test('a corrupt line is counted and skipped, never trusted', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  await port.submit({ ...CANDIDATE });
  fs.appendFileSync(sinkFile(root), 'not json at all\n', 'utf8');
  const read = port.read({ scopeKey: SCOPE_A });
  assert.equal(read.candidates.length, 1);
  assert.equal(read.corrupt, 1);
  const next = await port.submit({ ...CANDIDATE, candidateId: 'shr_0004', activityId: 'act_4' });
  assert.equal(next.ok, true, 'a corrupt line does not break the writer');
});

test('the sink path cannot escape the companion root', () => {
  const rootPath = path.join(os.tmpdir(), 'p2-share-guard');
  assert.throws(() => createShareCandidatePort({ root: rootPath, sinkRelative: '../outside.jsonl' }), /escapes the companion root/);
});

test('the port reports itself as a degraded jsonl sink, not as a contact service', async t => {
  const root = makeRoot(t);
  const port = createShareCandidatePort({ root, enabled: true, now: () => T0 });
  const described = port.describe();
  assert.equal(described.available, true);
  assert.equal(described.sink, 'jsonl');
  assert.equal(described.degraded, SHARE_DEGRADED);
  assert.equal(described.contactSeam, 'absent');
  assert.equal(described.counts.candidates, 0);
  await port.submit({ ...CANDIDATE });
  assert.equal(port.describe().counts.live, 1);
});

test('the module contains no sending code path', async () => {
  const source = fs.readFileSync(path.join(here, 'autonomy-share.mjs'), 'utf8');
  for (const needle of ['fetch(', 'node:http', 'node:https', 'node:net', 'sendMessage', 'deliver(']) {
    assert.equal(source.includes(needle), false, `autonomy-share.mjs must not contain ${needle}`);
  }
});
