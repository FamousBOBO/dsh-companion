/**
 * 群聊点歌的第二本账：`requesterId` 必填 + 每人每天每群上限。
 *
 * 这些用例固定的是**判据**，不是实现：
 *   1. 缺 `requesterId` → 拒绝（不静默退化成"不限额"）；
 *   2. 同一人第二次 → 拒绝，且拒绝文案带上已用次数与上限；
 *   3. 同一群的另一个人、另一个群的同一个人 → 都不受影响（键是"群 + 人"）；
 *   4. 跨日自动归零（日键按 `Asia/Shanghai`，不跟随宿主 TZ）；
 *   5. 非群会话、非点歌工具 → 这条闸门一个字都不说（交回给 `core.mjs` 的边界闸门）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGroupSongQuota, groupSongQuotaDenial, groupSongDayKey,
  capFromEnv, DEFAULT_GROUP_SONG_DAILY_CAP, GROUP_SONG_GUARDED_TOOLS,
} from './song-quota.mjs';

const agent = (id = 'qq-group-123') => ({ id, session: { id } });
const groupOf = a => {
  const match = /^qq-group-([1-9]\d*)$/.exec(String(a?.session?.id ?? a?.id ?? ''));
  if (!match) return String(a?.session?.id ?? a?.id ?? '').startsWith('qq-group-') ? false : null;
  return Number(match[1]);
};

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-song-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'home', 'group-song-quota.json');
}

const cover = (over = {}, a = agent()) => ({ agent: a, name: 'qq_song_cover', arguments: { song: '分手快乐', requesterId: 456, ...over } });

test('requesterId is mandatory in a group: no silent "unlimited" fallback', t => {
  const quota = createGroupSongQuota({ file: tempFile(t), cap: 2 });
  const deny = exec => groupSongQuotaDenial(exec, { quota, groupOf });
  for (const args of [
    { song: '分手快乐' },
    { song: '分手快乐', requesterId: undefined },
    { song: '分手快乐', requesterId: null },
    { song: '分手快乐', requesterId: '' },
    { song: '分手快乐', requesterId: '456' },
    { song: '分手快乐', requesterId: 0 },
    { song: '分手快乐', requesterId: -1 },
    { song: '分手快乐', requesterId: 1.5 },
  ]) {
    const reason = deny({ agent: agent(), name: 'qq_song_cover', arguments: args });
    assert.equal(typeof reason, 'string', JSON.stringify(args));
    assert.match(reason, /requesterId/);
  }
  // 一次都没记账：被拒的调用不该消耗额度。
  assert.deepEqual(quota.snapshot().counts, {});
});

test('per person, per group, per day: the second one from the same person is refused', t => {
  const quota = createGroupSongQuota({ file: tempFile(t), cap: 1 });
  const deny = exec => groupSongQuotaDenial(exec, { quota, groupOf });
  assert.equal(deny(cover()), undefined, 'first is allowed');
  const second = deny(cover());
  assert.equal(typeof second, 'string');
  assert.match(second, /今天已经点过 1 首/);
  assert.match(second, /每人每天 1 首/);
  assert.match(second, /Asia\/Shanghai/);

  // 同一群的另一个人：不受影响。
  assert.equal(deny(cover({ requesterId: 789 })), undefined);
  // 另一个群里的同一个 456：是另一格。
  assert.equal(deny(cover({}, agent('qq-group-999'))), undefined);
  // 回到第一个群，456 仍然满。
  assert.equal(typeof deny(cover()), 'string');
});

test('cap=0 means unlimited, but requesterId is still required', t => {
  const quota = createGroupSongQuota({ file: tempFile(t), cap: 0 });
  const deny = exec => groupSongQuotaDenial(exec, { quota, groupOf });
  for (let i = 0; i < 5; i += 1) assert.equal(deny(cover()), undefined, `call ${i}`);
  assert.match(deny({ agent: agent(), name: 'qq_song_cover', arguments: { song: 'x' } }), /requesterId/);
  assert.equal(quota.check({ group: 123, requesterId: 456 }).used, 5);
});

test('a new natural day resets the counter, and the day key is Asia/Shanghai', t => {
  const file = tempFile(t);
  // 2026-11-15T15:59:00Z 是上海 23:59，T16:01:00Z 是上海次日 00:01。
  let clock = Date.parse('2026-11-15T15:59:00Z');
  const quota = createGroupSongQuota({ file, cap: 1, now: () => clock });
  const deny = exec => groupSongQuotaDenial(exec, { quota, groupOf });
  assert.equal(groupSongDayKey(clock), '2026-11-15');
  assert.equal(deny(cover()), undefined);
  assert.equal(typeof deny(cover()), 'string', 'same day is capped');

  clock = Date.parse('2026-11-15T16:01:00Z');
  assert.equal(groupSongDayKey(clock), '2026-11-16');
  assert.equal(deny(cover()), undefined, 'a new day resets');
});

test('the ledger survives a restart and a corrupt file fails open (cost control, not authorization)', t => {
  const file = tempFile(t);
  const first = createGroupSongQuota({ file, cap: 1, now: () => Date.parse('2026-11-15T04:00:00Z') });
  assert.equal(groupSongQuotaDenial(cover(), { quota: first, groupOf }), undefined);

  const reopened = createGroupSongQuota({ file, cap: 1, now: () => Date.parse('2026-11-15T05:00:00Z') });
  assert.equal(typeof groupSongQuotaDenial(cover(), { quota: reopened, groupOf }), 'string', 'persisted across restart');

  fs.writeFileSync(file, '{ this is not json');
  const recovered = createGroupSongQuota({ file, cap: 1, now: () => Date.parse('2026-11-15T06:00:00Z') });
  assert.equal(groupSongQuotaDenial(cover(), { quota: recovered, groupOf }), undefined, 'corrupt ledger does not deny service');
});

test('this gate stays silent for DMs, other tools and malformed group ids', t => {
  const quota = createGroupSongQuota({ file: tempFile(t), cap: 1 });
  const deny = exec => groupSongQuotaDenial(exec, { quota, groupOf });
  // 私聊：额度由 channel-qq 的 `song.dailyUserCap` 管，这里不管。
  assert.equal(deny(cover({}, agent('qq-dm-456'))), undefined);
  assert.equal(deny({ agent: agent('qq-dm-456'), name: 'qq_song_cover', arguments: {} }), undefined);
  // 不是点歌工具：一个字都不说。
  assert.equal(deny({ agent: agent(), name: 'qq_message', arguments: {} }), undefined);
  assert.deepEqual([...GROUP_SONG_GUARDED_TOOLS], ['qq_song_cover']);
  // 看着像群但群号非法 / 会话未就绪：交回给边界闸门（那边文案是"预设未就绪"）。
  assert.equal(deny(cover({}, agent('qq-group-0'))), undefined);
  assert.equal(deny(cover({}, {})), undefined);
});

test('capFromEnv reads the override and rejects nonsense', () => {
  assert.equal(capFromEnv({}), DEFAULT_GROUP_SONG_DAILY_CAP);
  assert.equal(capFromEnv({ COMPANION_GROUP_SONG_DAILY_CAP: '' }), DEFAULT_GROUP_SONG_DAILY_CAP);
  assert.equal(capFromEnv({ COMPANION_GROUP_SONG_DAILY_CAP: '0' }), 0);
  assert.equal(capFromEnv({ COMPANION_GROUP_SONG_DAILY_CAP: '3' }), 3);
  assert.equal(capFromEnv({ COMPANION_GROUP_SONG_DAILY_CAP: '-2' }), DEFAULT_GROUP_SONG_DAILY_CAP);
  assert.equal(capFromEnv({ COMPANION_GROUP_SONG_DAILY_CAP: 'abc' }), DEFAULT_GROUP_SONG_DAILY_CAP);
});
