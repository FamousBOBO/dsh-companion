// Service-level pulse behaviour: consent gate, session lifecycle, persistence and reload recovery.
//
// **Every database here lives under os.tmpdir().** Nothing may touch `<repo>/home/health/health.db`
// — that file is the running companion's real health history.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHealthService, WORKSPACE_ROOT } from '../lib/service.mjs';
import { openHealthDb } from '../lib/db.mjs';

const T0 = 1793731200000;

/**
 * A temp home with a pre-created database.
 *
 * The cleanup is registered by the caller *after* it closes the service: on Windows, removing a
 * directory whose SQLite handle is still open fails with EPERM, and `t.after` hooks run in
 * registration order.
 */
function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-service-test-'));
  fs.mkdirSync(path.join(dir, 'health'), { recursive: true });
  // Pre-create the database so `initialize()` is happy with the collector disabled: the pulse
  // layer must not depend on the Huawei cloud switch.
  const db = openHealthDb({ file: path.join(dir, 'health', 'health.db') });
  db.close();
  return dir;
}

function cleanup(t, { service = null, home = null }) {
  t.after(async () => {
    if (service) { try { await service.close(); } catch { /* already closed */ } }
    if (home) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(home, { recursive: true, force: true }); return; } catch { /* WAL handle */ }
      }
    }
  });
}

function jsonResponse(payload, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

/** A sidecar stand-in: `/api/state` answers from the mutable `feed`, everything else 404s. */
function sidecarFetch(feed) {
  const calls = [];
  const impl = async (url, init) => {
    const text = String(url);
    calls.push({ url: text, init });
    // `offline` models the sidecar process being gone: every endpoint fails, not just `/api/state`.
    if (feed.offline) throw Object.assign(new Error('offline'), { name: 'TypeError' });
    if (text.endsWith('/api/state')) {
      const connected = feed.connected !== false;
      return jsonResponse({
        ok: true,
        connected,
        deviceLabel: connected ? 'TEST-STRAP' : null,
        bpm: connected ? feed.bpm : null,
        rrMs: connected ? [600, 620, 610] : [],
        contact: connected ? 'yes' : 'unsupported',
        sensorLocation: 'chest',
        sampleAt: feed.at,
        lastErrorCode: connected ? null : 'disconnected',
      });
    }
    if (text.endsWith('/api/connect')) {
      feed.connectCalls = (feed.connectCalls ?? 0) + 1;
      if (feed.connectFails) return jsonResponse({ ok: false, code: 'device-not-found' });
      // A real connect produces a first reading right away; the state endpoint above follows.
      feed.connected = true;
      return jsonResponse({ ok: true, connected: true, deviceLabel: 'TEST-STRAP' });
    }
    if (text.endsWith('/api/disconnect')) {
      feed.disconnectCalls = (feed.disconnectCalls ?? 0) + 1;
      feed.connected = false;
      return jsonResponse({ ok: true, connected: false });
    }
    if (text.endsWith('/api/devices')) {
      return jsonResponse({ ok: true, scannedAt: feed.at, devices: [{ label: 'TEST-STRAP', address: 'AA:BB:CC:DD:EE:FF', rssi: -60, hasHrs: true }] });
    }
    return jsonResponse({ ok: false, code: 'not-found' }, { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

async function makeService(t, { feed, config = {} } = {}) {
  const home = tempHome(t);
  let nowMs = T0;
  const service = createHealthService({
    root: WORKSPACE_ROOT,
    home,
    now: () => nowMs,
    fetchImpl: sidecarFetch(feed),
    config: {
      enabled: false,
      pulse: { enabled: true, pollMs: 250, inject: true, maxChars: 200, ...config },
    },
  });
  cleanup(t, { service, home });
  const init = await service.initialize();
  assert.equal(init.ok, true, `initialize failed: ${JSON.stringify(init)}`);
  return { service, advance: ms => { nowMs += ms; }, home, at: () => nowMs, feed };
}

test('pulse is inert until a session is opened, and never invents a reading', async t => {
  const feed = { bpm: 92, at: T0, offline: false };
  const { service } = await makeService(t, { feed });

  const status = await service.pulse();
  assert.equal(status.ok, true);
  assert.equal(status.enabled, true);
  assert.equal(status.session.active, false);
  assert.equal(status.bpm, null, 'no poll has happened yet, so there is no number');
  assert.equal(status.line, '', 'a line without a session would be a hallucination source');

  const prompt = await service.pulsePrompt();
  assert.equal(prompt.ok, true);
  assert.equal(prompt.text, '');
  assert.equal(prompt.reason, 'no-session');
});

test('session start → real reading → live line → stop → silence, and history keeps the peak', async t => {
  const feed = { bpm: 90, at: T0, offline: false };
  const { service, advance } = await makeService(t, { feed });

  const started = await service.pulseSession({ action: 'start', minutes: 20 });
  assert.equal(started.ok, true);
  assert.equal(started.session.minutes, 20);
  assert.equal(started.session.active, true);

  // Twelve calm polls build the baseline; then one spike and a mark.
  for (let index = 0; index < 12; index += 1) {
    advance(1000);
    feed.at += 1000;
    await service.pulsePollNow();
  }
  advance(1000);
  feed.at += 1000;
  feed.bpm = 128;
  await service.pulsePollNow();

  const view = await service.pulse();
  assert.equal(view.bpm, 128);
  assert.equal(view.baseline, 90);
  assert.ok(['racing', 'peak'].includes(view.zone), `unexpected zone ${view.zone}`);
  assert.equal(view.session.active, true);
  assert.ok(view.series.length >= 13);
  assert.match(view.line, /128 bpm/);
  assert.match(view.line, /真实设备/);

  const prompt = await service.pulsePrompt();
  assert.equal(prompt.text.length > 0, true);
  assert.match(prompt.text, /心跳读数/);
  assert.ok(prompt.text.length <= 200);

  const marked = await service.pulseSession({ action: 'mark', label: '这句他说得很过分' });
  assert.equal(marked.ok, true);
  assert.equal(marked.mark.bpm, 128);

  const stopped = await service.pulseSession({ action: 'stop' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.persisted, true);
  assert.equal(stopped.summary.peakBpm, 128);
  assert.equal(stopped.summary.stopReason, 'manual');

  const silent = await service.pulsePrompt();
  assert.equal(silent.text, '', 'a stopped session must remove the line immediately');
  assert.equal(silent.reason, 'no-session');

  const history = await service.pulseHistory();
  assert.equal(history.ok, true);
  assert.equal(history.sessions.length, 1);
  assert.equal(history.sessions[0].peakBpm, 128);
  assert.equal(history.sessions[0].baselineBpm, 90);
  assert.equal(history.sessions[0].marks.length, 1);
  assert.equal(history.sessions[0].marks[0].label, '这句他说得很过分');
  assert.ok(!('series' in history.sessions[0]), 'the raw curve is never persisted');
});

test('consent off closes every pulse path, including the prompt line', async t => {
  const feed = { bpm: 96, at: T0, offline: false };
  const { service } = await makeService(t, { feed });

  await service.pulseSession({ action: 'start', minutes: 10 });
  await service.pulsePollNow();

  const written = await service.setConsent('health.pulse.live', false);
  assert.equal(written.ok, true);
  assert.equal(written.enabled, false);
  assert.equal(written.enforced, true);

  const denied = await service.pulse();
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'pulse-denied');

  const prompt = await service.pulsePrompt();
  assert.equal(prompt.text, '');
  assert.equal(prompt.reason, 'pulse-denied');

  const refused = await service.pulseSession({ action: 'start' });
  assert.equal(refused.code, 'pulse-denied');

  // And back on, for completeness.
  await service.setConsent('health.pulse.live', true);
  const revived = await service.pulse();
  assert.equal(revived.ok, true);
});

test('a disabled feature refuses politely instead of throwing', async t => {
  const feed = { bpm: 96, at: T0, offline: false };
  const { service } = await makeService(t, { feed, config: { enabled: false } });
  const result = await service.pulse();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'pulse-disabled');
  const prompt = await service.pulsePrompt();
  assert.equal(prompt.text, '');
});

test('an offline sidecar leaves the last reading dated, and the prompt says it is not live', async t => {
  const feed = { bpm: 104, at: T0, offline: false };
  const { service, advance } = await makeService(t, { feed });
  await service.pulseSession({ action: 'start', minutes: 10 });
  await service.pulsePollNow();
  assert.equal((await service.pulse()).bpm, 104);

  feed.offline = true;
  advance(2000);
  await service.pulsePollNow();
  const view = await service.pulse();
  assert.equal(view.sidecar.reachable, false);
  assert.equal(view.bpm, 104, 'the last real number is kept …');
  assert.ok(view.sampleAgeMs >= 2000, '… and dated');

  const prompt = await service.pulsePrompt();
  assert.equal(prompt.text.length > 0, true);
  assert.doesNotMatch(prompt.text, /现在 104 bpm/, 'a stale number is never presented as live');

  const devices = await service.pulseDevices();
  assert.equal(devices.ok, false);
  assert.equal(devices.code, 'pulse-unreachable');
});

test('start refuses to open a session when no device answers, instead of opening an empty one', async t => {
  const feed = { bpm: 90, at: T0, offline: true };
  const { service } = await makeService(t, { feed });
  const started = await service.pulseSession({ action: 'start' });
  assert.equal(started.ok, false);
  assert.equal(started.code, 'pulse-unreachable');
  assert.ok(['unreachable', 'http-error', 'connect-failed', 'not-found'].includes(String(started.errorCode)),
    `unexpected errorCode ${started.errorCode}`);
  const view = await service.pulse();
  assert.equal(view.session.active, false, 'no session is opened without a heartbeat behind it');
});

test('start scans once on demand, and the session follows the device (no timer)', async t => {
  const feed = { bpm: 96, at: T0, offline: false, connected: false };
  const { service, advance } = await makeService(t, { feed });
  const started = await service.pulseSession({ action: 'start' });
  assert.equal(started.ok, true);
  assert.equal(started.session.mode, 'device');
  assert.equal(started.session.endsAt, null);
  assert.equal(started.session.minutes, null);
  assert.equal(started.session.remainingMs, null);
  assert.equal(started.session.deviceOffMs, 30000);

  // A second start while the link is up must not scan again.
  const before = service.pulseDiagnostics();
  const again = await service.pulseSession({ action: 'start' });
  assert.equal(again.already, true);
  assert.ok(before.ready);
  advance(1000);
  feed.at += 1000;
  await service.pulsePollNow();
  assert.equal((await service.pulse()).bpm, 96);
});

test('turning the band off ends the session by itself within the grace window', async t => {
  const feed = { bpm: 92, at: T0, offline: false };
  const { service, advance } = await makeService(t, { feed });
  await service.pulseSession({ action: 'start' });
  feed.at += 1000;
  advance(1000);
  await service.pulsePollNow();
  assert.equal((await service.pulse()).session.active, true);

  // The owner switches the broadcast off: no new samples, the link reports disconnected.
  feed.connected = false;
  advance(31_000);
  await service.pulsePollNow();
  const view = await service.pulse();
  assert.equal(view.session.active, false, 'the session must close without anyone calling stop');
  assert.equal(view.connected, false);
  assert.equal((await service.pulsePrompt()).text, '', 'and the injected line must disappear');

  const history = await service.pulseHistory();
  assert.equal(history.sessions[0].stopReason, 'device-off');
});

test('start reports the sidecar\'s own reason when the scan finds nothing', async t => {
  // The card uses `errorCode` to tell "no band is broadcasting" from "the sidecar is not running".
  const feed = { bpm: 90, at: T0, offline: false, connected: false, connectFails: true };
  const { service } = await makeService(t, { feed });
  const started = await service.pulseSession({ action: 'start' });
  assert.equal(started.ok, false);
  assert.equal(started.code, 'pulse-unreachable');
  assert.equal(started.errorCode, 'device-not-found');
  assert.equal(feed.connectCalls, 1, 'exactly one scan attempt per start');
});

test('stop closes the session and lets the device go so the band can stop broadcasting', async t => {
  const feed = { bpm: 90, at: T0, offline: false, connected: true };
  const { service } = await makeService(t, { feed });
  await service.pulseSession({ action: 'start' });
  const stopped = await service.pulseSession({ action: 'stop' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.summary.stopReason, 'manual');
  assert.equal(feed.disconnectCalls >= 1, true, 'a manual stop must release the BLE link');
  assert.equal((await service.pulsePrompt()).text, '');
});

test('an unclosed session left by a previous process is closed as host-reload on init', async t => {
  const home = tempHome(t);
  const dbPath = path.join(home, 'health', 'health.db');
  const db = openHealthDb({ file: dbPath });
  db.run(
    `INSERT INTO health_pulse_sessions (id, owner_scope, started_at, samples)
     VALUES ('left-open', 'owner-only', ?, 12)`,
    [T0],
  );
  db.close();

  const service = createHealthService({
    root: WORKSPACE_ROOT, home,
    now: () => T0 + 60_000,
    fetchImpl: sidecarFetch({ bpm: 90, at: T0, offline: true }),
    config: { enabled: false, pulse: { enabled: true } },
  });
  cleanup(t, { service, home });
  const init = await service.initialize();
  assert.equal(init.ok, true);

  const history = await service.pulseHistory();
  assert.equal(history.ok, true);
  assert.equal(history.sessions.length, 1);
  assert.equal(history.sessions[0].stopReason, 'host-reload');
  assert.equal(history.sessions[0].endedAt, T0 + 60_000);
});

test('an absent maxChars uses the configured budget, not the 80-character floor', async t => {
  const feed = { bpm: 90, at: T0, offline: false };
  const { service, advance } = await makeService(t, { feed });
  await service.pulseSession({ action: 'start', minutes: 10 });
  for (let index = 0; index < 12; index += 1) {
    advance(1000);
    feed.at += 1000;
    await service.pulsePollNow();
  }
  const prompt = await service.pulsePrompt();
  assert.equal(prompt.reason, 'ok');
  // The full sentence (baseline + movement + hint + honesty clause) is longer than 80 characters:
  // a null `maxChars` used to be coerced to 0 and clamped up to the floor, silently truncating it.
  assert.ok(prompt.text.length > 80, `line was only ${prompt.text.length} chars: ${prompt.text}`);
  assert.match(prompt.text, /[。）]$/);
  assert.match(prompt.text, /不是医学判断/);
});

/**
 * INCIDENT 2026-11-03 23:30 — the desktop host refused to boot after this exact scenario:
 * a poll was awaiting the sidecar when `close()` nulled the engine, and the follow-up call
 * (`drainClosed()`) escaped as an unhandled rejection, which the host turns into
 * `fatal load failure` + exit 1. This test pins the fix: the poll must resolve, never reject.
 */
test('a close() during an in-flight poll resolves instead of taking the host down', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const home = tempHome(t);
  // The first `/api/state` (the connect probe) answers immediately so `start` can open a session;
  // every later poll hangs until the test releases it — which is the incident's timing.
  let stateCalls = 0;
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.endsWith('/api/connect')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, connected: true }) };
    }
    if (text.endsWith('/api/state')) {
      stateCalls += 1;
      // #1 = the connect probe, #2 = the priming read right after `start`; everything later hangs
      // until the test releases it — that is the incident's timing exactly.
      if (stateCalls > 2) return pending;
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, connected: true, bpm: 90, sampleAt: T0, contact: 'yes', rrMs: [] }),
      };
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, code: 'not-found' }) };
  };
  const service = createHealthService({
    root: WORKSPACE_ROOT,
    home,
    now: () => T0,
    fetchImpl,
    config: { enabled: false, pulse: { enabled: true } },
  });
  cleanup(t, { service, home });
  await service.initialize();
  await service.pulseSession({ action: 'start', minutes: 10 });

  const polling = service.pulsePollNow();   // begins awaiting the sidecar
  await service.close();                    // nulls the engine while that await is in flight
  release({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, connected: true, bpm: 90, sampleAt: T0, contact: 'yes', rrMs: [] }),
  });

  const result = await polling;             // must resolve, not reject
  assert.equal(result.ok, true);
  assert.equal(service.describe().pulse.ready, false, 'a closed service reports the pulse layer as gone, not as broken');
});

test('unknown actions are refused by name, not by throwing', async t => {
  const { service } = await makeService(t, { feed: { bpm: 90, at: T0, offline: true } });
  const result = await service.pulseSession({ action: 'dance' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'pulse-bad-action');
  // The status action is a synonym for a plain read.
  const status = await service.pulseSession({ action: 'STATUS' });
  assert.equal(status.ok, true);
  assert.ok('session' in status);
});

test('describe() reports pulse diagnostics without a reading or a device identity', async t => {
  const { service } = await makeService(t, { feed: { bpm: 91, at: T0, offline: false } });
  const described = service.describe();
  assert.equal(described.pulse.enabled, true);
  assert.equal(described.pulse.ready, true);
  assert.equal(described.pulse.consented, true);
  assert.equal('bpm' in described.pulse, false);
  assert.equal('deviceLabel' in described.pulse, false);
});
