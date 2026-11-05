// 主动关怀（`health.care.proactive`）：纯函数规则 + 服务层授权/去重。
//
// 这里钉的是"关怀不许变坏"的几条底线：只讲来源说过的事实、一夜只说一次、
// 授权关着时一个字都不给、超时就闭嘴、不把午睡当主睡眠、不把聚合会话编成起止。
//
// **所有数据库都在 os.tmpdir() 下**，绝不碰 `<repo>/home/health/health.db`。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARE_MAX_AGE_HOURS, buildCareItems, careLine, clockOf, localDateOf, shortDuration,
} from '../lib/care.mjs';
import { createHealthService } from '../lib/service.mjs';
import { openHealthDb } from '../lib/db.mjs';

const TZ = 'Asia/Shanghai';
// 2026-11-04 09:30 +08:00
const NOW = Date.parse('2026-11-04T09:30:00+08:00');
const START = Date.parse('2026-11-04T03:36:00+08:00');
const END = Date.parse('2026-11-04T08:42:00+08:00');

function night(overrides = {}) {
  return {
    sleepDate: '2026-11-04',
    startAt: START,
    endAt: END,
    asleepMinutes: 299,
    awakeMinutes: 7,
    inBedMinutes: 306,
    stageFidelity: 'partial',
    sessionQuality: 'origin-confirmed',
    status: 'confirmed',
    isNap: false,
    sourceScore: 70,
    stages: [],
    ...overrides,
  };
}

const sleepView = sessions => ({ ok: true, availability: sessions.length ? 'present' : 'awaiting_first_night', sessions });

test('QQ 摘要只含起止和时长，保留来源与到期时间供投递端校验', () => {
  const options = { nowMs: NOW, tz: TZ, qqSummary: true };
  const sample = night({ sourceId: 'huawei-cn' });
  assert.deepEqual(buildCareItems({ ...options, sleep: sleepView([sample]) }), [{
    sourceId: 'huawei-cn',
    sleepDate: '2026-11-04',
    expiresAt: END + 18 * 3_600_000,
    text: '睡眠记录显示，03:36 入睡，08:42 醒来，共睡了 4h59m。',
  }]);
  for (const invalid of [
    { endAt: NOW + 1 },
    { startAt: END },
    { sourceId: undefined },
    { status: 'aggregate_only' },
  ]) {
    assert.deepEqual(buildCareItems({ ...options, sleep: sleepView([{ ...sample, ...invalid }]) }), []);
  }
  assert.deepEqual(buildCareItems({
    ...options, nowMs: END + 18 * 3_600_000 + 1, sleep: sleepView([sample]),
  }), []);
});

// --- 纯函数规则 --------------------------------------------------------------

test('一夜真数据 → 一条关怀，讲清入睡/醒来/时长/原厂评分', () => {
  const items = buildCareItems({ sleep: sleepView([night()]), nowMs: NOW, tz: TZ });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'sleep.summary');
  assert.equal(items[0].sleepDate, '2026-11-04');
  assert.equal(items[0].dedupeKey, 'sleep.summary:2026-11-04');
  assert.match(items[0].text, /03:36 入睡/);
  assert.match(items[0].text, /08:42 醒/);
  assert.match(items[0].text, /睡了 4h59m/);
  assert.match(items[0].text, /原厂评分 70/);
  // 只讲事实：不出现建议、不出现阈值判断。
  assert.doesNotMatch(items[0].text, /建议|应该|注意|偏低|偏高|不足|风险/);
});

test('没有评分时不编一个', () => {
  const items = buildCareItems({ sleep: sleepView([night({ sourceScore: null })]), nowMs: NOW, tz: TZ });
  assert.equal(items.length, 1);
  assert.doesNotMatch(items[0].text, /评分/);
});

test(`醒来超过 ${CARE_MAX_AGE_HOURS} 小时就不再提（不补念历史）`, () => {
  const late = NOW + CARE_MAX_AGE_HOURS * 3600 * 1000 + 60 * 1000;
  assert.deepEqual(buildCareItems({ sleep: sleepView([night()]), nowMs: late, tz: TZ }), []);
});

test('未来的时间戳说明数据有问题：跳过，不猜', () => {
  const future = night({ startAt: NOW + 3 * 3600 * 1000, endAt: NOW + 5 * 3600 * 1000 });
  assert.deepEqual(buildCareItems({ sleep: sleepView([future]), nowMs: NOW, tz: TZ }), []);
});

test('午睡、聚合会话、没有时长的一律不进关怀', () => {
  assert.deepEqual(buildCareItems({ sleep: sleepView([night({ isNap: true })]), nowMs: NOW, tz: TZ }), []);
  assert.deepEqual(buildCareItems({ sleep: sleepView([night({ status: 'aggregate_only' })]), nowMs: NOW, tz: TZ }), []);
  assert.deepEqual(buildCareItems({ sleep: sleepView([night({ startAt: null, endAt: null })]), nowMs: NOW, tz: TZ }), []);
  assert.deepEqual(buildCareItems({ sleep: sleepView([night({ asleepMinutes: 0 })]), nowMs: NOW, tz: TZ }), []);
  assert.deepEqual(buildCareItems({ sleep: sleepView([]), nowMs: NOW, tz: TZ }), []);
});

test('多夜只关怀最近的一夜', () => {
  const older = night({
    sleepDate: '2026-11-03',
    startAt: Date.parse('2026-11-03T02:10:00+08:00'),
    endAt: Date.parse('2026-11-03T07:30:00+08:00'),
  });
  const items = buildCareItems({ sleep: sleepView([older, night()]), nowMs: NOW, tz: TZ });
  assert.equal(items.length, 1);
  assert.equal(items[0].sleepDate, '2026-11-04');
});

test('当晚睡眠日就是今天时用"这一觉"，否则用"昨晚"', () => {
  const sameDay = buildCareItems({ sleep: sleepView([night()]), nowMs: NOW, tz: TZ })[0];
  assert.match(sameDay.text, /^这一觉/);
  // 醒来时刻在 11-03，而"现在"是 11-04 → 说的是昨晚
  const previousNight = night({
    sleepDate: '2026-11-03',
    startAt: Date.parse('2026-11-03T23:40:00+08:00'),
    endAt: Date.parse('2026-11-04T06:10:00+08:00'),
    asleepMinutes: 390,
  });
  const yesterday = buildCareItems({ sleep: sleepView([previousNight]), nowMs: NOW, tz: TZ })[0];
  assert.match(yesterday.text, /^昨晚/);
});

test('短时长与整点写法', () => {
  assert.equal(shortDuration(299), '4h59m');
  assert.equal(shortDuration(60), '1h');
  assert.equal(shortDuration(45), '45m');
  assert.equal(shortDuration(0), '0m');
  assert.equal(shortDuration(null), null);
  assert.equal(shortDuration(-5), null);
});

test('时刻与本地日期按给定时区算', () => {
  assert.equal(clockOf(END, TZ), '08:42');
  assert.equal(localDateOf(END, TZ), '2026-11-04');
  // 同一个瞬间在 UTC 下是前一天 00:42 —— 证明没有偷偷用 UTC
  assert.equal(localDateOf(END, 'UTC'), '2026-11-04');
  assert.equal(clockOf(END, 'UTC'), '00:42');
});

test('careLine 超长截断，保留句读', () => {
  const item = { text: '昨晚03:36 入睡、08:42 醒、睡了 4h59m（原厂评分 70）。' };
  const cut = careLine(item, { maxChars: 12 });
  assert.equal(cut.length, 12);
  assert.ok(cut.endsWith('…'));
  assert.equal(careLine(item, { maxChars: 200 }), item.text);
  assert.equal(careLine({ text: '' }), '');
});

// --- 服务层：授权闸 + 一夜一次 -------------------------------------------------

const SEED_SQL = `INSERT INTO health_sleep_sessions
       (id, canonical_group_id, source_id, source_record_key, start_at, end_at, sleep_date,
        timezone_id, asleep_minutes, awake_minutes, in_bed_minutes, deep_minutes, light_minutes,
        rem_minutes, stage_coverage, stage_fidelity, session_quality, status, is_nap,
        source_score, source_score_label, raw_ref, fetched_at, revision)
     VALUES (?, 'huawei-cn:2026-11-04', 'huawei-cn', ?, ?, ?, '2026-11-04',
        'Asia/Shanghai', 299, 7, 306, 67, 188, 44, 1.0, 'partial', 'origin-confirmed', 'confirmed', 0,
        70, NULL, NULL, ?, 1)`;

/** 服务不暴露 db 句柄（契约要求），测试自己开一个同文件句柄写种子数据：WAL 下两边看得见。 */
function seedNight(home, id) {
  const db = openHealthDb({ file: path.join(home, 'health', 'health.db') });
  try {
    db.run(SEED_SQL, [id, `slp:2026-11-04:${START}`, START, END, NOW]);
  } finally {
    db.close();
  }
}

/** 只读地数一下台账行数（同样是另一个句柄）。 */
function countDelivered(home) {
  const db = openHealthDb({ file: path.join(home, 'health', 'health.db'), readOnly: true });
  try {
    return Number(db.get('SELECT COUNT(*) AS c FROM health_care_delivered').c);
  } finally {
    db.close();
  }
}

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-service-test-'));
  fs.mkdirSync(path.join(dir, 'health'), { recursive: true });
  const db = openHealthDb({ file: path.join(dir, 'health', 'health.db') });
  db.close();
  return dir;
}

function cleanup(t, { service = null, home = null }) {
  t.after(async () => {
    if (service) { try { await service.close(); } catch { /* already closed */ } }
    if (home) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try { fs.rmSync(home, { recursive: true, force: true }); return; } catch { /* WAL handle */ }
      }
    }
  });
}

async function serviceWithNight(t, { consent }) {
  const home = tempHome(t);
  const previous = process.env.DSH_COMPANION_HEALTH_HOME;
  process.env.DSH_COMPANION_HEALTH_HOME = home;
  const service = createHealthService({ log: () => {}, now: () => NOW });
  cleanup(t, { service, home });
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_COMPANION_HEALTH_HOME;
    else process.env.DSH_COMPANION_HEALTH_HOME = previous;
  });
  const init = await service.initialize();
  assert.equal(init.ok, true, JSON.stringify(init));
  // 直接写一行睡眠（不走网络）：这就是采集器会写出的形状。
  seedNight(home, 'slp_care_test');
  if (consent) await service.setConsent('health.care.proactive', true);
  return { service, home };
}

test('授权关着：care 不给候选文本，carePrompt 一个字都不说', async t => {
  const { service } = await serviceWithNight(t, { consent: false });
  const view = service.care();
  assert.equal(view.ok, true);
  assert.equal(view.enabled, false);
  assert.deepEqual(view.items, [], '未授权时连候选都不给');
  const prompt = await service.carePrompt({});
  assert.equal(prompt.ok, true);
  assert.equal(prompt.text, '');
  assert.equal(prompt.reason, 'consent-off');
});

test('授权打开：说一次，第二次不再说（同一夜只念一遍）', async t => {
  const { service, home } = await serviceWithNight(t, { consent: true });
  const first = await service.carePrompt({ maxChars: 200 });
  assert.equal(first.ok, true);
  assert.equal(first.reason, 'ok');
  assert.match(first.text, /03:36 入睡/);
  assert.equal(first.sleepDate, '2026-11-04');

  const second = await service.carePrompt({ maxChars: 200 });
  assert.equal(second.text, '', '同一夜不许说第二次');
  assert.equal(second.reason, 'already-delivered');

  // 台账里正好一行，读视图也把它标成已投递。
  const counted = { c: countDelivered(home) };
  assert.equal(Number(counted.c), 1);
  const view = service.care();
  assert.equal(view.enabled, true);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].delivered, true);
  assert.equal(view.delivered.length, 1);
  assert.equal(view.delivered[0].channel, 'conversation-inject');
});

test('投递台账跟着库走：重开服务不会把同一夜再说一次', async t => {
  const home = tempHome(t);
  const previous = process.env.DSH_COMPANION_HEALTH_HOME;
  process.env.DSH_COMPANION_HEALTH_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_COMPANION_HEALTH_HOME;
    else process.env.DSH_COMPANION_HEALTH_HOME = previous;
  });

  // 时钟必须钉死：种子那一夜是 2026-11-04，而 `buildCareItems` 会在「醒来超过 18 小时」后闭嘴。
  // 曾经这两个实例用的是真实 `Date.now()`，于是这条用例在 2026-11-05 之后必然变红 —— 那不是回归，
  // 是测试自己在读墙上时钟。`now` 是服务本来就有的接缝，用它。
  const first = createHealthService({ log: () => {}, now: () => NOW });
  await first.initialize();
  seedNight(home, 'slp_care_reload');
  await first.setConsent('health.care.proactive', true);
  const said = await first.carePrompt({});
  assert.equal(said.reason, 'ok');
  await first.close();

  const second = createHealthService({ log: () => {}, now: () => NOW });
  cleanup(t, { service: second, home });
  await second.initialize();
  const again = await second.carePrompt({});
  assert.equal(again.text, '');
  assert.equal(again.reason, 'already-delivered');
});

test('care 是只读的：调用两次不缺德、不写库、不改授权', async t => {
  const { service, home } = await serviceWithNight(t, { consent: true });
  const before = countDelivered(home);
  service.care();
  service.care();
  const after = countDelivered(home);
  assert.equal(Number(before), Number(after), 'care() 只读，不许抢投递');
  assert.equal(service.consents()['health.care.proactive'], true);
});

test('QQ 候选复核本地同意且不占用本地投递记录', async t => {
  const { service, home } = await serviceWithNight(t, { consent: false });
  assert.equal(service.qqCareCandidate(), null);
  await service.setConsent('health.care.proactive', true);
  const candidate = service.qqCareCandidate();
  assert.equal(candidate?.sourceId, 'huawei-cn');
  assert.deepEqual(service.qqCareCandidate(), candidate);
  assert.equal(countDelivered(home), 0);
  assert.equal((await service.carePrompt()).reason, 'ok');
  assert.deepEqual(service.qqCareCandidate(), candidate);
  await service.setConsent('health.care.proactive', false);
  assert.equal(service.qqCareCandidate(), null);
});
