// status.mjs 的鉴权状态判定：谁能断言"过期"，谁只能闭嘴说"未知"。
//
// 这组用例锁的是一条真实误报（2026-11-04 00:41 本机观测）：宿主重启把 8765 sidecar 一起带走
// 了 3 小时，快照的 expiresAt 早已过去，体检于是输出「已过期，需要重新login」；而 sidecar 一
// 起来就用 refresh token 续到了下一小时——主人不需要做任何事。传输层失败时，正确的答案
// 是 unknown，不是 expired。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus } from '../lib/status.mjs';

/** 最小桩：只提供 buildStatus 读的那几条 SQL 的表面。 */
function stubDb({ sourceRow = null, runs = [], stats = null, sampleAt = null } = {}) {
  return {
    stats: () => stats ?? {
      observations: 0, workouts: 0, devices: 0, dailySummaries: 0,
      sleepSessions: 0, sleepStages: 0, rawRefs: 0, syncRuns: 0,
      careCandidates: 0, sizeBytes: 0,
    },
    get(sql, params = []) {
      if (/FROM health_sources/.test(sql)) return sourceRow;
      if (/MAX\(t\)/.test(sql)) return sampleAt === null ? { t: null } : { t: sampleAt };
      return null;
    },
    all(sql) {
      if (/FROM health_sync_runs/.test(sql)) return runs;
      return [];
    },
  };
}

const CONFIG = { source: 'huawei-cn', collector: { pollMinutes: 15, windowDays: 7, baseUrl: 'http://127.0.0.1:8765' } };
const HOUR = 3600_000;

function statusOf(overrides = {}) {
  return buildStatus({
    db: stubDb(overrides.db),
    config: CONFIG,
    auth: overrides.auth ?? null,
    nowMs: overrides.nowMs,
    ...overrides.extra,
  });
}

const NOW = Date.parse('2026-11-04T00:41:00+08:00');
const EXPIRED_SNAPSHOT = {
  status: 'expiring',
  expiresAt: Date.parse('2026-11-03T21:54:38+08:00'),
  refreshExpiresAt: Date.parse('2027-05-02T19:04:43+08:00'),
  minutesLeft: 29,
  rotated: false,
};

test('快照已过期 + 传输层失败 → unknown（不许说"需要重新登录"）', () => {
  const status = statusOf({
    db: { sourceRow: { id: 'huawei-cn', last_error_code: 'unreachable', last_success_at: NOW - 3 * HOUR, enabled: 1 } },
    auth: EXPIRED_SNAPSHOT,
    nowMs: NOW,
  });
  assert.equal(status.source.auth.status, 'unknown');
  assert.equal(status.source.auth.minutesLeft, 0, 'minutesLeft 仍按绝对值算，不给负数');
  assert.equal(status.source.auth.expiresAt, new Date(EXPIRED_SNAPSHOT.expiresAt).toISOString(), '到期时间仍然如实给出');
});

test('每一种传输层失败都落到 unknown', () => {
  for (const code of ['unreachable', 'timeout', 'http-error', 'bad-json', 'non-loopback-refused']) {
    const status = statusOf({
      db: { sourceRow: { id: 'huawei-cn', last_error_code: code, last_success_at: null, enabled: 1 } },
      auth: EXPIRED_SNAPSHOT,
      nowMs: NOW,
    });
    assert.equal(status.source.auth.status, 'unknown', `${code} 应判 unknown`);
  }
});

test('快照已过期但没有传输层错误 → expired（该说就说）', () => {
  const status = statusOf({
    db: { sourceRow: { id: 'huawei-cn', last_error_code: null, last_success_at: NOW - 3 * HOUR, enabled: 1 } },
    auth: EXPIRED_SNAPSHOT,
    nowMs: NOW,
  });
  assert.equal(status.source.auth.status, 'expired');
});

test('云端真的拒绝时，auth 错误码优先于传输层判断 → required', () => {
  for (const code of ['1002', '1005', '20020001', 'unauthorized', 'auth-required']) {
    const status = statusOf({
      db: { sourceRow: { id: 'huawei-cn', last_error_code: code, last_success_at: null, enabled: 1 } },
      auth: EXPIRED_SNAPSHOT,
      nowMs: NOW,
    });
    assert.equal(status.source.auth.status, 'required', `${code} 应判 required`);
  }
});

test('快照还有效时照实报，minutesLeft 由绝对时间重算（不是抄快照里的数）', () => {
  const expiresAt = NOW + 37 * 60_000;
  const status = statusOf({
    db: { sourceRow: { id: 'huawei-cn', last_error_code: null, last_success_at: NOW - 60_000, enabled: 1 } },
    // 快照自己说 valid（采集当时还有 59 分钟），但此刻只剩 37 分钟：以绝对时间为准，
    // status 保留快照的判断，minutesLeft 必须被重算。
    auth: { ...EXPIRED_SNAPSHOT, status: 'valid', expiresAt, minutesLeft: 59 },
    nowMs: NOW,
  });
  assert.equal(status.source.auth.status, 'valid');
  assert.equal(status.source.auth.minutesLeft, 37);
});

test('没有任何鉴权信息时是 unknown，不是 valid', () => {
  const status = statusOf({ db: { sourceRow: null }, auth: null, nowMs: NOW });
  assert.equal(status.source.auth.status, 'unknown');
});
