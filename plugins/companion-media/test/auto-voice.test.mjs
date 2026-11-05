import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../config.mjs';
import {
  AUTO_VOICE_STATE_RELATIVE,
  buildAutoPlan,
  clampAutoProbability,
  createAutoVoiceService,
  decideAutoVoice,
  readAutoVoiceState,
  resolveAutoDeliveryMode,
} from '../lib/speech.mjs';
import { tempRoot } from './helpers.mjs';

// Auto voice: the decision, the persisted clock, the fail-closed failure path and
// the `voice_only` no-duplication rule. Nothing here touches the network, the wall
// clock or a real TTS backend: the clock, the coin and the speech service are all
// injected.

const T0 = Date.parse('2026-11-03T12:00:00.000Z');

function autoConfig({ auto = {}, speech = {} } = {}) {
  return normalizeConfig({
    speech: {
      enabled: true,
      // The director would call a model; the tests never need it.
      director: { enabled: false },
      auto: { enabled: true, probability: 100, minIntervalSeconds: 180, deliveryMode: 'voice_only', maxChars: 0, ...auto },
      ...speech,
    },
  });
}

function fakeSpeech({ delayMs = 0, failure = null, artifactId = 'art_auto' } = {}) {
  const calls = [];
  return {
    calls,
    async synthesize(options) {
      calls.push(options);
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (failure) return { ok: false, error: failure };
      return {
        ok: true,
        jobId: 'job_auto',
        director: 'disabled',
        tempoApplied: true,
        artifact: {
          artifactId,
          kind: 'audio',
          path: 'home/media/artifacts/speech/fake.wav',
          mime: 'audio/wav',
          bytes: 4096,
          sha256: 'aa'.repeat(32),
          durationSeconds: 1.5,
          origin: 'tts',
        },
      };
    },
  };
}

function clock(start = T0) {
  let current = start;
  return {
    now: () => current,
    advance(seconds) { current += seconds * 1000; return current; },
    at() { return current; },
  };
}

function build({ root = tempRoot('auto-voice-'), config = autoConfig(), speech = fakeSpeech(), time = clock(), random = () => 0 } = {}) {
  const service = createAutoVoiceService({
    config,
    speech,
    root,
    now: time.now,
    random,
    log: () => {},
  });
  return { root, service, speech, time, config };
}

// ---------------------------------------------------------------- decision ---

test('probability 0 never speaks and probability 100 always speaks', () => {
  for (const roll of [0, 0.001, 0.5, 0.999]) {
    assert.equal(decideAutoVoice({ enabled: true, probability: 0, minIntervalSeconds: 0, random: () => roll }).speak, false);
    assert.equal(decideAutoVoice({ enabled: true, probability: 100, minIntervalSeconds: 0, random: () => roll }).speak, true);
  }
  // The boundary is `roll < probability`, so 1% never fires on a 1% roll.
  assert.equal(decideAutoVoice({ enabled: true, probability: 1, minIntervalSeconds: 0, random: () => 0.01 }).speak, false);
  assert.equal(decideAutoVoice({ enabled: true, probability: 1, minIntervalSeconds: 0, random: () => 0.0099 }).speak, true);
});

test('an unreadable probability or rng fails closed instead of speaking', () => {
  for (const probability of [undefined, null, NaN, 'abc', -5]) {
    const decision = decideAutoVoice({ enabled: true, probability, minIntervalSeconds: 0, random: () => 0 });
    assert.equal(decision.speak, false, `probability=${String(probability)} must not speak`);
  }
  assert.equal(decideAutoVoice({ enabled: true, probability: 100, minIntervalSeconds: 0, random: () => NaN }).speak, false);
  assert.equal(decideAutoVoice({ enabled: true, probability: 100, minIntervalSeconds: 0, random: () => { throw new Error('rng broke'); } }).speak, false);
  // Only a literal `true` turns it on.
  assert.equal(decideAutoVoice({ enabled: 'true', probability: 100, minIntervalSeconds: 0, random: () => 0 }).speak, false);
  assert.equal(clampAutoProbability(150), 100);
  assert.equal(clampAutoProbability('35'), 35);
  assert.equal(clampAutoProbability(undefined), 0);
});

test('the interval gate is absolute and a corrupt clock cannot unlock it', () => {
  const recent = new Date(T0 - 60_000).toISOString();
  const old = new Date(T0 - 200_000).toISOString();
  assert.equal(decideAutoVoice({ enabled: true, probability: 100, minIntervalSeconds: 180, lastTriggeredAt: recent, now: T0, random: () => 0 }).speak, false);
  assert.equal(decideAutoVoice({ enabled: true, probability: 100, minIntervalSeconds: 180, lastTriggeredAt: old, now: T0, random: () => 0 }).speak, true);
  const corrupt = decideAutoVoice({ enabled: true, probability: 100, minIntervalSeconds: 180, lastTriggeredAt: 'not-a-date', now: T0, random: () => 0 });
  assert.equal(corrupt.speak, false);
  assert.match(corrupt.reason, /interval/);
});

test('deliveryMode resolves to voice_only unless it is an explicit both-mode', () => {
  assert.equal(resolveAutoDeliveryMode('voice_only'), 'voice_only');
  assert.equal(resolveAutoDeliveryMode('VOICE_ONLY'), 'voice_only');
  assert.equal(resolveAutoDeliveryMode('voice_and_text'), 'voice_and_text');
  assert.equal(resolveAutoDeliveryMode('both'), 'voice_and_text');
  for (const mode of [undefined, null, '', 'voice', 42, 'typo']) {
    assert.equal(resolveAutoDeliveryMode(mode), 'voice_only', `mode=${String(mode)} must not duplicate the line`);
  }
});

// ------------------------------------------------------------- persistence ---

test('the trigger clock survives a restart and the interval holds across processes', async () => {
  const root = tempRoot('auto-voice-restart-');
  const time = clock();

  const first = build({ root, time });
  const spoken = await first.service.maybeSpeak({ text: '今天风很大，我把围巾围紧了一点。', sessionId: 's1' });
  assert.equal(spoken.spoke, true);
  assert.equal(first.speech.calls.length, 1);

  const onDisk = path.join(root, 'home', 'media', ...AUTO_VOICE_STATE_RELATIVE.split('/'));
  assert.equal(first.service.stateFile, onDisk);
  const saved = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
  assert.equal(saved.lastAttemptAt, new Date(T0).toISOString());
  assert.equal(saved.lastSpokenAt, new Date(T0).toISOString());
  assert.equal(saved.lastDecision, 'spoken');
  assert.equal(saved.counters.spoken, 1);

  // A brand-new service instance with the same state directory — a restart, and
  // also what a second process sharing the file sees.
  time.advance(30);
  const restarted = build({ root, time });
  const blocked = await restarted.service.maybeSpeak({ text: '还在吗？', sessionId: 's1' });
  assert.equal(blocked.spoke, false);
  assert.match(blocked.decision.reason, /interval/);
  assert.equal(restarted.speech.calls.length, 0, 'the restarted process must not synthesize inside the interval');

  // Once the interval has passed the same stored clock lets her speak again.
  time.advance(200);
  const again = await restarted.service.maybeSpeak({ text: '还在吗？', sessionId: 's1' });
  assert.equal(again.spoke, true);
  assert.equal(restarted.speech.calls.length, 1);
});

test('a corrupt state file is reported and cannot unlock the interval', async () => {
  const root = tempRoot('auto-voice-corrupt-');
  const time = clock();
  const { service, speech } = build({ root, time });
  fs.mkdirSync(path.dirname(service.stateFile), { recursive: true });
  fs.writeFileSync(service.stateFile, '{ this is not json', 'utf8');

  const read = readAutoVoiceState(service.stateFile);
  assert.equal(read.readable, false);
  assert.equal(read.recovered, true, 'the file mtime is used as a conservative last-attempt clock');
  const status = service.status();
  assert.equal(status.stateReadable, false);
  assert.equal(status.stateExists, true);
  assert.ok(status.lastAttemptAt, 'status still shows the anchor it fell back to');

  // The damaged clock does not turn into "speak on every turn".
  const blocked = await service.maybeSpeak({ text: '说一句。', sessionId: 's1' });
  assert.equal(blocked.spoke, false);
  assert.match(blocked.decision.reason, /interval/);
  assert.equal(speech.calls.length, 0);

  // Missing file is a fresh start, not a corruption.
  const missing = readAutoVoiceState(path.join(root, 'home/media/state/nope.json'));
  assert.equal(missing.readable, true);
  assert.equal(missing.exists, false);
  assert.equal(missing.state.lastAttemptAt, null);
});

// ------------------------------------------------------------ the decisions ---

test('maybeSpeak writes nothing at all when she stays quiet', async () => {
  const root = tempRoot('auto-voice-quiet-');
  const time = clock();
  const quiet = build({ root, time, config: autoConfig({ auto: { enabled: false } }) });
  const off = await quiet.service.maybeSpeak({ text: '一句普通的话', sessionId: 's1' });
  assert.equal(off.spoke, false);
  assert.equal(quiet.speech.calls.length, 0);
  assert.equal(fs.existsSync(quiet.service.stateFile), false, 'a disabled layer must not touch disk');

  // Probability 0 is a hard zero, not a small chance.
  const zero = build({ root, time, random: () => 0, config: autoConfig({ auto: { probability: 0 } }) });
  const never = await zero.service.maybeSpeak({ text: '一句普通的话', sessionId: 's1' });
  assert.equal(never.spoke, false);
  assert.equal(zero.speech.calls.length, 0);
  assert.equal(fs.existsSync(zero.service.stateFile), false);

  // The length limit and an empty line both stop before the backend.
  const limited = build({ root, time, config: autoConfig({ auto: { maxChars: 8 } }) });
  assert.equal((await limited.service.maybeSpeak({ text: '这是一句明显超过八个字的回复', sessionId: 's1' })).spoke, false);
  const empty = build({ root, time });
  assert.equal((await empty.service.maybeSpeak({ text: '   ', sessionId: 's1' })).spoke, false);
  assert.equal(limited.speech.calls.length + empty.speech.calls.length, 0);
});

test('concurrent turns cannot both start talking', async () => {
  const root = tempRoot('auto-voice-race-');
  const time = clock();
  const { service, speech } = build({ root, time, speech: fakeSpeech({ delayMs: 20 }) });
  const results = await Promise.all([
    service.maybeSpeak({ text: '同一句话', sessionId: 's1' }),
    service.maybeSpeak({ text: '同一句话', sessionId: 's2' }),
    service.maybeSpeak({ text: '同一句话', sessionId: 's3' }),
  ]);
  assert.equal(results.filter(result => result.spoke).length, 1);
  assert.equal(speech.calls.length, 1, 'the reservation must be taken before synthesis, not after');
});

// ------------------------------------------------------- fail-closed path ---

test('a failed synthesis reports the failure and never sends text in the voice\u2019s place', async () => {
  const root = tempRoot('auto-voice-fail-');
  const time = clock();
  const { service, speech } = build({
    root,
    time,
    speech: fakeSpeech({ failure: { code: 'MEDIA_BACKEND_UNAVAILABLE', message: 'breeze is not loaded' } }),
  });

  const failed = await service.maybeSpeak({ text: '我想把这句话念给你听。', sessionId: 's1' });
  assert.equal(failed.ok, false);
  assert.equal(failed.spoke, false);
  assert.equal(failed.failure.code, 'MEDIA_BACKEND_UNAVAILABLE');
  assert.equal(failed.delivery.degraded, true);
  assert.equal(failed.delivery.spoken, false);
  assert.equal(failed.plan.steps.length, 0, 'no step may stand in for the silent line');
  assert.equal(failed.plan.textSuppressed, true);
  assert.match(failed.instruct, /没有被念出来/);
  assert.equal(speech.calls.length, 1);

  // The attempt itself is recorded, so the failure cannot be retried every turn.
  const saved = JSON.parse(fs.readFileSync(service.stateFile, 'utf8'));
  assert.equal(saved.lastDecision, 'failed');
  assert.equal(saved.consecutiveFailures, 1);
  assert.equal(saved.lastError.code, 'MEDIA_BACKEND_UNAVAILABLE');
  assert.equal(saved.lastSpokenAt, null);

  time.advance(10);
  const inside = await service.maybeSpeak({ text: '我想把这句话念给你听。', sessionId: 's1' });
  assert.equal(inside.spoke, false);
  assert.match(inside.decision.reason, /interval/);
  assert.equal(speech.calls.length, 1, 'a dead backend must not be hammered once per turn');

  // And a thrown synthesis (not a structured failure) is contained too.
  const throwing = createAutoVoiceService({
    config: autoConfig(),
    root: tempRoot('auto-voice-throw-'),
    now: clock().now,
    random: () => 0,
    speech: { async synthesize() { throw new Error('socket hang up'); } },
  });
  const thrown = await throwing.maybeSpeak({ text: '嗯。', sessionId: 's1' });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.spoke, false);
  assert.equal(thrown.plan.steps.length, 0);
});

test('delivery plans never let typed text impersonate the spoken line', () => {
  const artifact = { artifactId: 'art_1', path: 'home/media/artifacts/speech/x.wav', durationSeconds: 2 };

  // voice_only: the voice replaces the text instead of doubling it.
  const only = buildAutoPlan({ sessionId: 's1', text: '晚安，做个好梦。', artifact, deliveryMode: 'voice_only' });
  assert.deepEqual(only.steps.map(step => step.kind), ['voice']);
  assert.equal(only.voiceOnly, true);
  assert.equal(only.textSuppressed, true);
  assert.equal(only.spokenText, '晚安，做个好梦。');

  // The explicit both-mode is the only way text appears next to the voice.
  const both = buildAutoPlan({ sessionId: 's1', text: '晚安，做个好梦。', artifact, deliveryMode: 'voice_and_text' });
  assert.deepEqual(both.steps.map(step => step.kind), ['voice', 'text']);
  assert.equal(both.voiceOnly, false);

  // The trap: planDelivery alone turns {text, voice:null, voiceOnly:true} into a
  // text step, because `voiceOnly && voice` is false. buildAutoPlan must not.
  const degraded = buildAutoPlan({ sessionId: 's1', text: '晚安，做个好梦。', artifact: null, deliveryMode: 'voice_only' });
  assert.deepEqual(degraded.steps, []);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.textSuppressed, true);
  assert.equal(degraded.planId, null);

  // The plan reports the transport the deployment is actually in, never a guess.
  assert.equal(only.mode, 'mock');
  assert.equal(buildAutoPlan({ sessionId: 's1', artifact, transportMode: 'desktop' }).mode, 'desktop');
});

// ------------------------------------------------------------- same words ---

test('what is spoken is exactly the reply text, not a rewrite', async () => {
  const root = tempRoot('auto-voice-words-');
  const time = clock();
  const { service, speech } = build({ root, time });
  const result = await service.maybeSpeak({ text: '[开心]今天的晚霞特别好看。', emotion: '自然', sessionId: 's1', context: '用户刚发了一张晚霞的照片' });
  assert.equal(result.spoke, true);
  assert.equal(speech.calls.length, 1);
  // The emotion tag is local metadata: it never reaches the backend as words...
  assert.equal(speech.calls[0].text, '今天的晚霞特别好看。');
  // ...and the plan carries the same line that was synthesized.
  assert.equal(result.spokenText, '今天的晚霞特别好看。');
  assert.deepEqual(result.plan.steps.map(step => step.kind), ['voice']);
  // The context reaches the director path, but the director stays disabled here.
  assert.equal(speech.calls[0].context, '用户刚发了一张晚霞的照片');
  // Producing the WAV is not delivering it.
  assert.equal(result.delivered, false);
  assert.equal(result.delivery.spoken, false);
  // The plan carries the configured transport instead of always claiming mock.
  assert.equal(result.plan.mode, 'mock');
});

// ----------------------------------------------------------------- status ---

test('status reports the clock, the next eligible moment and the failure count', async () => {
  const root = tempRoot('auto-voice-status-');
  const time = clock();
  const { service } = build({ root, time });

  const idle = service.status();
  assert.equal(idle.enabled, true);
  assert.equal(idle.probability, 100);
  assert.equal(idle.minIntervalSeconds, 180);
  assert.equal(idle.deliveryMode, 'voice_only');
  assert.equal(idle.nextEligibleAt, null);
  assert.equal(idle.deliversToChannel, false);

  await service.maybeSpeak({ text: '说一句。', sessionId: 's1' });
  const spoken = service.status();
  assert.equal(spoken.lastDecision, 'spoken');
  assert.equal(spoken.counters.attempts, 1);
  assert.equal(spoken.counters.spoken, 1);
  assert.equal(spoken.nextEligibleAt, new Date(T0 + 180_000).toISOString());
});
