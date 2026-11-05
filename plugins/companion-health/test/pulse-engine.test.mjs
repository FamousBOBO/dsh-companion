// Live pulse engine: derivations, honesty rules, session state machine.
//
// These tests are the only place the prompt text is verified, so they check two things at once:
// the number is right, **and** the sentence cannot be read as something the device never said.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPulseEngine, renderPulseLine, zoneOf, baselineOf, trendOf, rmssdOf, median,
  safetyOf, formatClock, DEFAULT_PULSE_POLICY, PULSE_ZONE_HINTS,
} from '../lib/pulse.mjs';

const T0 = 1793731200000; // fixed epoch; nothing here depends on wall-clock time

/** A clock the test moves by hand. */
function makeClock(start = T0) {
  let current = start;
  return {
    now: () => current,
    advance: ms => { current += ms; return current; },
    at: () => current,
  };
}

function feed(engine, clock, bpm, { stepMs = 1000, connected = true, contact = 'yes' } = {}) {
  clock.advance(stepMs);
  engine.applyState({
    ok: true, bpm, sampleAt: clock.at(), connected, contact, rrMs: [], deviceLabel: 'TEST-STRAP',
  });
}

test('median ignores junk and averages the middle', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([null, 'x', 5]), 5);
});

test('rmssd needs three intervals and is zero on a constant series', () => {
  assert.equal(rmssdOf([600]), null);
  assert.equal(rmssdOf([600, 600, 600]), 0);
  const value = rmssdOf([600, 640, 600, 640]);
  assert.ok(value > 0 && Number.isFinite(value));
});

test('zone is relative to the baseline and null without one', () => {
  assert.equal(zoneOf(95, 90), 'calm');
  assert.equal(zoneOf(100, 90), 'warming');
  assert.equal(zoneOf(115, 90), 'racing');
  assert.equal(zoneOf(135, 90), 'peak');
  // No baseline: no claim about "fast", except an absolute ceiling.
  assert.equal(zoneOf(95, null), null);
  assert.equal(zoneOf(175, null), 'peak');
  assert.equal(zoneOf(null, 90), null);
});

test('baseline needs the minimum sample count and reports readiness honestly', () => {
  const samples = [{ t: T0, bpm: 90 }, { t: T0 + 1000, bpm: 92 }];
  const notReady = baselineOf(samples, { startedAt: T0 });
  assert.equal(notReady.ready, false);
  assert.equal(notReady.value, 91);

  const many = Array.from({ length: 20 }, (_, index) => ({ t: T0 + index * 500, bpm: 90 + (index % 3) }));
  const ready = baselineOf(many, { startedAt: T0 });
  assert.equal(ready.ready, true);
  assert.ok(ready.value >= 90 && ready.value <= 92);
});

test('trend uses a slope sign so a single spike cannot flip it', () => {
  const rising = Array.from({ length: 12 }, (_, index) => ({ t: T0 + index * 5000, bpm: 90 + index }));
  assert.equal(trendOf(rising, T0 + 11 * 5000).trend, 'up');
  const flat = Array.from({ length: 12 }, (_, index) => ({ t: T0 + index * 5000, bpm: 90 }));
  assert.equal(trendOf(flat, T0 + 11 * 5000).trend, 'flat');
  const falling = [...rising].reverse().map((sample, index) => ({ ...sample, t: T0 + index * 5000 }));
  assert.equal(trendOf(falling, T0 + 11 * 5000).trend, 'down');
});

test('safety: sustained fast, very low, and a lost stream', () => {
  assert.equal(safetyOf({ bpm: 120, sampleAgeMs: 500, sessionActive: true, nowMs: T0 }), null);
  const justNow = safetyOf({ bpm: 190, sampleAgeMs: 500, sessionActive: true, fastSince: T0, nowMs: T0 + 1000 });
  assert.equal(justNow, null, 'one fast sample is not a sustained fast streak');
  const sustained = safetyOf({
    bpm: 190, sampleAgeMs: 500, sessionActive: true, fastSince: T0, nowMs: T0 + DEFAULT_PULSE_POLICY.tooFastHoldMs,
  });
  assert.equal(sustained.code, 'too-fast');
  assert.equal(safetyOf({ bpm: 40, sampleAgeMs: 500, sessionActive: true, nowMs: T0 }).code, 'very-low');
  assert.equal(safetyOf({ bpm: 90, sampleAgeMs: DEFAULT_PULSE_POLICY.lostMs + 1, sessionActive: true, nowMs: T0 }).code, 'lost');
  assert.equal(
    safetyOf({ bpm: 90, sampleAgeMs: DEFAULT_PULSE_POLICY.lostMs + 1, sessionActive: false, nowMs: T0 }),
    null,
    'a lost stream outside a session is not a safety event',
  );
});

test('clock formatting is fixed-width and timezone-explicit', () => {
  assert.match(formatClock(T0), /^\d{2}:\d{2}:\d{2}$/);
});

test('no session means no line at all', () => {
  const clock = makeClock();
  const engine = createPulseEngine({ now: clock.now });
  feed(engine, clock, 92);
  assert.equal(engine.line(), '');
});

test('a live reading produces one line with the number, the baseline and the hint', () => {
  const clock = makeClock();
  const engine = createPulseEngine({ now: clock.now });
  engine.startSession({ minutes: 30 });

  // 12 calm samples establish a baseline of ~90, then one burst.
  for (let index = 0; index < 12; index += 1) feed(engine, clock, 90);
  feed(engine, clock, 118);

  const line = engine.line();
  assert.match(line, /^【心跳读数｜真实设备】/);
  assert.match(line, /118 bpm/);
  assert.match(line, /基线 90/);
  assert.match(line, /本次峰值 118/);
  assert.ok(line.includes(PULSE_ZONE_HINTS.racing), 'the pacing hint comes from the zone, not from the model');
  assert.ok(line.length <= DEFAULT_PULSE_POLICY.lineMaxChars + 1, 'the line stays inside its character budget');
  assert.match(line, /设备读数，不是医学判断/);
});

test('before the baseline is ready the line refuses to judge speed', () => {
  const clock = makeClock();
  const engine = createPulseEngine({ now: clock.now });
  engine.startSession();
  feed(engine, clock, 140);
  const line = engine.line();
  assert.match(line, /140 bpm/);
  assert.match(line, /建立基线/);
  assert.doesNotMatch(line, /基线 \d+/);
  assert.doesNotMatch(line, /节奏：/);
});

test('a quiet device is dated, not presented as live', () => {
  const clock = makeClock();
  const engine = createPulseEngine({ now: clock.now });
  engine.startSession();
  for (let index = 0; index < 12; index += 1) feed(engine, clock, 90);
  clock.advance(20_000); // past freshMs, inside lostMs
  const line = engine.line();
  assert.match(line, /最后读数 90（20 秒前）/);
  assert.match(line, /不要当成实时/);
});

test('an unreachable sidecar says so instead of guessing', () => {
  const clock = makeClock();
  const engine = createPulseEngine({ now: clock.now });
  engine.startSession();
  feed(engine, clock, 90);
  engine.applyState({ ok: false, code: 'unreachable' });
  const line = engine.line();
  assert.match(line, /不在线/);
  assert.match(line, /接收端没在运行/);
  assert.doesNotMatch(line, /\d{2,3} bpm/, 'no stale number is dressed up as a reading');
});

test('a sustained fast streak becomes an instruction to stop, not a number to play with', () => {
  const clock = makeClock();
  const engine = createPulseEngine({ now: clock.now });
  engine.startSession();
  for (let index = 0; index < 12; index += 1) feed(engine, clock, 90);
  for (let index = 0; index < 70; index += 1) feed(engine, clock, 190);
  const line = engine.line();
  assert.match(line, /【心跳读数｜注意】/);
  assert.match(line, /先停下来关心他/);
});

test('session lifecycle: single session, marks, stop summary, ttl close', () => {
  const clock = makeClock();
  const engine = createPulseEngine({ now: clock.now });

  const first = engine.startSession({ minutes: 10 });
  assert.equal(first.ok, true);
  assert.equal(first.already, false);
  assert.equal(first.session.minutes, 10);

  const again = engine.startSession({ minutes: 60 });
  assert.equal(again.already, true);
  assert.equal(again.session.minutes, 10, 'a second start does not silently re-time the session');

  for (let index = 0; index < 12; index += 1) feed(engine, clock, 90);
  feed(engine, clock, 130);
  const marked = engine.mark('她说了一句很过分的话');
  assert.equal(marked.ok, true);
  assert.equal(marked.mark.bpm, 130);

  const stopped = engine.stopSession('manual');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.summary.stopReason, 'manual');
  assert.equal(stopped.summary.peakBpm, 130);
  assert.equal(stopped.summary.baselineBpm, 90);
  assert.equal(stopped.summary.marks.length, 1);
  assert.ok(stopped.summary.zoneCounts.racing >= 1);
  assert.equal(engine.active().active, false);

  // A second stop has nothing to stop, and says so.
  assert.equal(engine.stopSession('manual').code, 'pulse-no-session');
  assert.equal(engine.mark('x').code, 'pulse-no-session');
});

test('ttl closes the session on the polling path and queues it for persistence', () => {
  const clock = makeClock();
  const engine = createPulseEngine({ now: clock.now });
  engine.startSession({ minutes: 5 });
  feed(engine, clock, 90);
  clock.advance(5 * 60_000 + 1000);
  engine.applyState({ ok: true, bpm: 90, sampleAt: clock.at(), connected: true, contact: 'yes', rrMs: [] });
  assert.equal(engine.active().active, false);
  const closed = engine.drainClosed();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].stopReason, 'ttl');
  assert.equal(engine.drainClosed().length, 0, 'draining twice must not duplicate a row');
});

test('view carries no fabricated fields when nothing was ever received', () => {
  const engine = createPulseEngine({ now: () => T0 });
  const view = engine.view();
  assert.equal(view.bpm, null);
  assert.equal(view.sampleAgeMs, null);
  assert.equal(view.baseline, null);
  assert.equal(view.zone, null);
  assert.equal(view.peak, null);
  assert.deepEqual(view.series, []);
  assert.equal(view.session.active, false);
  assert.equal(view.note, '设备读数，不是医学判断。');
});

test('a slope that rounds to zero bpm is described as steady, never "降了 0"', () => {
  const view = {
    enabled: true,
    bpm: 101,
    sampleAgeMs: 300,
    baseline: 104,
    trend: 'down',
    trendDelta: 0,
    peak: { bpm: 105, at: T0 },
    zone: 'calm',
    sidecar: { reachable: true, errorCode: null },
    session: { active: true },
  };
  const line = renderPulseLine(view);
  assert.match(line, /读数平稳/);
  assert.doesNotMatch(line, /降了 0|升了 0/);
});

test('a tight budget degrades in a fixed order instead of cutting mid-word', () => {
  const view = {
    enabled: true,
    bpm: 120,
    sampleAgeMs: 100,
    baseline: 90,
    trend: 'up',
    trendDelta: 30,
    peak: { bpm: 150, at: T0 },
    zone: 'racing',
    sidecar: { reachable: true, errorCode: null },
    session: { active: true },
  };
  // Roomy: everything is there, including the full honesty suffix.
  const full = renderPulseLine(view, { maxChars: 200 });
  assert.ok(full.length <= 200);
  assert.match(full, /本次峰值 150（\d{2}:\d{2}:\d{2}）/);
  assert.match(full, /节奏：/);
  assert.match(full, /不仅|不是医学判断/);

  // Tight: the sentence stays complete and honest — never a half-written "（设备读数，不是医学…".
  for (const limit of [200, 160, 120, 90, 60, 40]) {
    const line = renderPulseLine(view, { maxChars: limit });
    assert.ok(line.length <= limit, `limit ${limit}: line was ${line.length} chars`);
    assert.ok(/[。…）]$/.test(line), `limit ${limit}: line must end a sentence, got "${line}"`);
    assert.match(line, /120 bpm/, `limit ${limit}: the reading itself is never dropped`);
  }

  // A view with no session can never produce text, even when everything else is populated.
  assert.equal(renderPulseLine({ ...view, session: { active: false } }), '');
  // A disabled feature is silent too.
  assert.equal(renderPulseLine({ ...view, enabled: false }), '');
});
