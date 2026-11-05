import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { withArtifactLocation } from '../index.mjs';

// The handoff exists because a session's working root is `<companion>/workspace`
// while artifact paths are relative to the companion root: a model told to
// "resolve it to an absolute path" produced a wrong path and the follow-up
// qq_voice send_file failed. The plugin must compute the absolute path itself.

const COMPANION_ROOT = 'D:/Bot/dsh-companion';
const artifactPath = 'home/media/artifacts/speech/speech-d20af7aa4deb58e4.wav';

test('a successful artifact gains an absolute path and a channel handoff', () => {
  const located = withArtifactLocation(
    { ok: true, artifact: { path: artifactPath, bytes: 161_340, durationSeconds: 3.36 } },
    { tool: 'qq_voice', action: 'send_file' },
  );
  const expected = path.resolve(COMPANION_ROOT, artifactPath);
  assert.equal(located.artifact.absolutePath, expected);
  assert.equal(path.isAbsolute(located.artifact.absolutePath), true);
  assert.equal(located.handoff.tool, 'qq_voice');
  assert.equal(located.handoff.action, 'send_file');
  assert.equal(located.handoff.file, expected);
  // The real file exists on this machine; a missing file must be reported,
  // never silently presented as ready to send.
  assert.equal(located.artifact.fileExists, true);
  assert.equal(located.handoff.ready, true);
  assert.equal(located.artifact.bytes, 161_340, 'existing fields survive');
});

test('the handoff says the file is not delivered and names the next call', () => {
  // The live failure was "synthesized but never called qq_voice": the result must
  // not read as if the voice had been sent, and it must spell out the next call.
  const located = withArtifactLocation(
    { ok: true, artifact: { path: artifactPath } },
    { tool: 'qq_voice', action: 'send_file' },
  );
  assert.equal(located.handoff.delivered, false);
  assert.match(located.handoff.mustSend, /qq_voice action=send_file/);
  assert.ok(located.handoff.mustSend.includes(located.handoff.file), 'the next call carries the exact path');
});

test('a missing file is reported as not ready', () => {
  const located = withArtifactLocation(
    { ok: true, artifact: { path: 'home/media/artifacts/speech/does-not-exist.wav' } },
    { tool: 'qq_voice', action: 'send_file' },
  );
  assert.equal(located.artifact.fileExists, false);
  assert.equal(located.handoff.ready, false);
});

test('failures and dry-runs pass through untouched', () => {
  const failure = { ok: false, error: { code: 'MEDIA_BACKEND_FAILED', message: 'x' } };
  assert.deepEqual(withArtifactLocation(failure, { tool: 'qq_voice', action: 'send_file' }), failure);
  const dryRun = { ok: true, dryRun: true, summary: { model: 'nai-diffusion-5-full' } };
  assert.deepEqual(withArtifactLocation(dryRun, { tool: 'qq_sticker', action: 'send' }), dryRun);
});
