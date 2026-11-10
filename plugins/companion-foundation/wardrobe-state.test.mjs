/** Wardrobe v2 — scene-aware state resolution.
 *
 * Every case here is one line of the brief's acceptance table (§11.1) or the state-
 * transition table (§5.1). The wall clock is always injected, so none of these tests can
 * pass or fail because of when CI happens to run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadWardrobeFor, seedWardrobe, saveWardrobeFor, outfitCandidates, selectOutfitForContext,
} from './wardrobe-schema.mjs';
import { classifyContext, inWindow, loadWardrobeConfig, zoneClock } from './wardrobe-context.mjs';
import {
  renderWardrobeSnapshot, resolveWardrobeState, wardrobeContextReport, wardrobeEnglishClause,
} from './wardrobe-state.mjs';
import { setOutfit, wardrobeDetail, currentOutfit, renderWardrobeConstraint } from './wardrobe.mjs';

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wardrobe-state-'));
  fs.mkdirSync(path.join(dir, 'home/companion'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Local Asia/Shanghai instant on 2026-11-10, e.g. at('22:40'). */
function at(hhmm, date = '2026-11-10') {
  return new Date(`${date}T${hhmm}:00+08:00`).getTime();
}

function writeConfig(rootDir, config) {
  fs.writeFileSync(path.join(rootDir, 'home/companion/wardrobe.config.json'), JSON.stringify(config), 'utf8');
}

/* ───────────────────── §11.1 wardrobe basics ───────────────────── */

test('白天普通活动 → everyday；白天居家 → home', (t) => {
  const dir = root(t);
  const plain = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('14:00') });
  assert.equal(plain.ok, true);
  assert.equal(plain.context, 'everyday');
  assert.equal(plain.reason, 'daytime-everyday');
  assert.equal(plain.outfitId, 'everyday-default');

  const reading = resolveWardrobeState({
    root: dir, personaId: 'bot', now: at('14:00'),
    activity: { kind: 'read', activity: 'read', status: 'running', title: '继续读《春晓》', startAt: at('13:50'), endAt: at('14:30') },
  });
  assert.equal(reading.ok, true);
  assert.equal(reading.context, 'home');
  assert.equal(reading.outfitId, 'home-default');
});

test('22:20 仍是居家服；22:40 自动进睡衣；02:00 与 06:50 保持睡衣；07:10 按生活状态恢复', (t) => {
  const dir = root(t);
  const cases = [
    ['22:20', 'home', 'evening-home'],
    ['22:40', 'sleep', 'night-window'],
    ['02:00', 'sleep', 'night-window'],
    ['06:50', 'sleep', 'night-window'],
    ['07:10', 'everyday', 'daytime-everyday'],
  ];
  for (const [clock, context, reason] of cases) {
    const state = resolveWardrobeState({ root: dir, personaId: 'bot', now: at(clock) });
    assert.equal(state.ok, true, `${clock} resolved`);
    assert.equal(state.context, context, `${clock} scene`);
    assert.equal(state.reason, reason, `${clock} reason`);
  }
  // 07:10 with an indoor activity running is home, not everyday: the morning restores
  // "per current life state", not "unconditionally back to outdoor clothes".
  const morning = resolveWardrobeState({
    root: dir, personaId: 'bot', now: at('07:10'),
    activity: { kind: 'write', activity: 'write', status: 'running', title: '写昨天的日记', startAt: at('07:00'), endAt: at('07:40') },
  });
  assert.equal(morning.context, 'home');
});

test('深夜有明确外出安排 → outdoor 覆盖睡衣', (t) => {
  const dir = root(t);
  const explicit = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('23:10'), explicit: { context: 'outdoor' } });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.context, 'outdoor');
  assert.equal(explicit.reason, 'explicit-turn');

  // A schedule occurrence that contains now and says "出门" is equally valid evidence.
  const scheduled = resolveWardrobeState({
    root: dir, personaId: 'bot', now: at('23:10'),
    schedule: { title: '去医院陪人', kind: 'plan', status: 'due', startAt: at('23:00'), endAt: at('23:40') },
  });
  assert.equal(scheduled.context, 'outdoor');
  assert.equal(scheduled.reason, 'schedule-outdoor');
});

test('明确要求换睡衣 → 立即切换（本轮显式）', (t) => {
  const dir = root(t);
  const state = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('15:00'), explicit: { context: 'sleep' } });
  assert.equal(state.context, 'sleep');
  assert.equal(state.reason, 'explicit-turn');
  assert.equal(state.outfitId, 'sleepwear-default');
});

test('显式覆盖未过期 → 保持覆盖；过期 → 恢复自动解析', (t) => {
  const dir = root(t);
  const wardrobe = loadWardrobeFor({ root: dir, personaId: 'bot', now: at('15:00') }).wardrobe;
  const hoodie = wardrobe.items.find(item => item.id === 'w-upper-hoodie');
  const shorts = wardrobe.items.find(item => item.id === 'w-lower-shorts');
  const saved = setOutfit(dir, {
    itemIds: [hoodie.id, shorts.id], instruction: '今天想轻便一点', now: at('15:00'),
    personaId: 'bot', until: at('18:00'),
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.context, 'any');
  assert.equal(saved.until, at('18:00'));

  const active = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('17:30') });
  assert.equal(active.ok, true);
  assert.equal(active.isOverride, true);
  assert.equal(active.reason, 'override-active');
  assert.equal(active.override.instruction, '今天想轻便一点');
  assert.deepEqual([active.pieces.upper.id, active.pieces.lower.id], [hoodie.id, shorts.id]);

  const expired = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('18:20') });
  assert.equal(expired.ok, true);
  assert.equal(expired.isOverride, false);
  // 18:20 is still daytime (eveningFrom defaults to 19:00), so the automatic answer is
  // everyday — the point is that the override is gone, not which automatic scene wins.
  assert.equal(expired.reason, 'daytime-everyday');
  assert.notDeepEqual([expired.pieces.upper.id, expired.pieces.lower.id], [hoodie.id, shorts.id]);
  // The expired row is kept for audit, not deleted.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'home/companion/wardrobe.json'), 'utf8'));
  assert.equal(onDisk.overrides.length, 1);
});

test('白天居家覆盖不会无条件挡住夜间睡衣', (t) => {
  const dir = root(t);
  const wardrobe = loadWardrobeFor({ root: dir, personaId: 'bot', now: at('14:00') }).wardrobe;
  const top = wardrobe.items.find(item => item.id === 'home-top-001');
  const bottom = wardrobe.items.find(item => item.id === 'home-bottom-001');
  const saved = setOutfit(dir, {
    itemIds: [top.id, bottom.id], instruction: '今天就在家', context: 'home',
    now: at('14:00'), personaId: 'bot', until: at('23:30'),
  });
  assert.equal(saved.ok, true);

  const afternoon = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('15:00') });
  assert.equal(afternoon.context, 'home');
  assert.equal(afternoon.isOverride, true);

  // 22:40: the automatic scene became sleep, the home override no longer applies.
  const night = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('22:40') });
  assert.equal(night.context, 'sleep');
  assert.equal(night.isOverride, false, 'home 覆盖不适用于 sleep 场景');
  assert.equal(night.outfitId, 'sleepwear-default');
});

test('「上一轮说要出门」不会延续到下一轮', (t) => {
  const dir = root(t);
  // Turn 1 explicitly went outdoors. Nothing is persisted for that.
  const turn1 = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('15:00'), explicit: { context: 'outdoor' } });
  assert.equal(turn1.context, 'outdoor');
  // Turn 2 has no explicit request: automatic resolution, and it never sees turn 1.
  const turn2 = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('15:01') });
  assert.equal(turn2.context, 'everyday');
  assert.equal(turn2.isOverride, false);
});

test('同一天同一场景重复请求 → 服装一致；不同场景可以不同', (t) => {
  const dir = root(t);
  const a = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('10:00') });
  const b = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('10:05') });
  const c = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('11:30') });
  assert.equal(a.outfitId, b.outfitId);
  assert.deepEqual(a.outfit, b.outfit);
  assert.equal(a.outfitId, c.outfitId, '同一天不重新随机');
  const night = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('23:00') });
  assert.notEqual(night.outfitId, a.outfitId, '不同场景有不同服装');
});

test('轮换种子包含人格：不同 persona 不共享结果', (t) => {
  const wardrobe = seedWardrobe({ personaId: 'alice', now: at('10:00') });
  // Two personas must not be forced to differ on every day (the space is small), but the
  // seed must genuinely include the persona — prove it by asking for many days.
  const differ = [];
  for (let day = 1; day <= 20; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    const one = selectOutfitForContext(wardrobe, { context: 'everyday', date, personaId: 'alice' });
    const two = selectOutfitForContext(wardrobe, { context: 'everyday', date, personaId: 'bob' });
    differ.push(one.id === two.id);
  }
  assert.ok(differ.includes(false), 'persona 必须进入轮换种子');
  // …and it is still stable per (date, persona).
  const stableA = selectOutfitForContext(wardrobe, { context: 'everyday', date: '2026-11-10', personaId: 'alice' });
  const stableB = selectOutfitForContext(wardrobe, { context: 'everyday', date: '2026-11-10', personaId: 'alice' });
  assert.equal(stableA.id, stableB.id);
});

test('跨午夜：日期与场景都正确', (t) => {
  const dir = root(t);
  // 00:30 on 2026-11-11 is still inside the 22:30–07:00 window that started on 11-10.
  const afterMidnight = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('00:30', '2026-11-11') });
  assert.equal(afterMidnight.ok, true);
  assert.equal(afterMidnight.context, 'sleep');
  assert.equal(afterMidnight.date, '2026-11-11', '波过午夜后日期按当地新的一天算');
  const beforeMidnight = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('23:30', '2026-11-10') });
  assert.equal(beforeMidnight.date, '2026-11-10');
  assert.equal(inWindow(0, '22:30', '07:00'), true, '00:00 在夜间窗口内');
  assert.equal(inWindow(22 * 60 + 29, '22:30', '07:00'), false, '22:29 还不在窗口内');
  assert.equal(inWindow(7 * 60, '22:30', '07:00'), false, '07:00 是窗口右开边界');
});

test('夜间窗口可配置，并且用真实本地时区计算', (t) => {
  const dir = root(t);
  writeConfig(dir, { nightWindow: { start: '01:00', end: '05:00' } });
  assert.equal(resolveWardrobeState({ root: dir, personaId: 'bot', now: at('02:00') }).context, 'sleep');
  assert.equal(resolveWardrobeState({ root: dir, personaId: 'bot', now: at('22:40') }).context, 'home');
  const config = loadWardrobeConfig(dir);
  assert.equal(config.nightWindow.start, '01:00');
  assert.equal(config.timeZone, 'Asia/Shanghai');
  assert.equal(zoneClock(at('02:00'), 'Asia/Shanghai').minutes, 120);
  // A different zone changes the answer for the same instant.
  const tokyo = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('22:40'), timeZone: 'Asia/Tokyo' });
  assert.equal(zoneClock(at('22:40'), 'Asia/Tokyo').minutes, 23 * 60 + 40);
});

test('计划不等于已发生：planned 槽位和未来的日程都不算证据', (t) => {
  const dir = root(t);
  const future = resolveWardrobeState({
    root: dir, personaId: 'bot', now: at('09:00'),
    schedule: { title: '晚上出门吃饭', kind: 'plan', status: 'planned', startAt: at('20:00'), endAt: at('21:00') },
  });
  assert.equal(future.context, 'everyday', '未来日程不能让她现在就穿外出服');

  const terminal = resolveWardrobeState({
    root: dir, personaId: 'bot', now: at('20:30'),
    activity: { kind: 'read', status: 'done', title: 'outdoor walk', startAt: at('20:00'), endAt: at('21:00') },
  });
  assert.notEqual(terminal.context, 'outdoor', '已完成的活动不再是正在发生');
});

test('睡衣状态不代表睡着：快照里明确说不推断睡眠', (t) => {
  const dir = root(t);
  const state = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('02:00') });
  const snapshot = renderWardrobeSnapshot(state);
  assert.match(snapshot, /【当前穿着】/);
  assert.match(snapshot, /场景：睡衣/);
  assert.match(snapshot, /不代表已经睡着/);
  assert.match(snapshot, /不要据此推断睡眠时长/);
  assert.ok(snapshot.length <= 480, `快照必须受 480 字符约束，实际 ${snapshot.length}`);
});

/* ───────────────────── §11.2 data isolation ───────────────────── */

test('不同 Persona 不共享服装；缺文件时明确报缺失', (t) => {
  const dir = root(t);
  // The owner persona gets a real file.
  const owned = seedWardrobe({ personaId: 'alice', now: at('10:00') });
  saveWardrobeFor({ root: dir, personaId: 'alice', wardrobe: owned, now: at('10:00') });
  const alice = resolveWardrobeState({ root: dir, personaId: 'alice', now: at('10:00') });
  assert.equal(alice.ok, true);

  const bob = resolveWardrobeState({ root: dir, personaId: 'bob', now: at('10:00') });
  assert.equal(bob.ok, false);
  assert.equal(bob.code, 'wardrobe-missing-for-persona');
  assert.match(bob.hint, /不要借用别人格的衣物/);
});

test('群聊不读取私聊衣柜', (t) => {
  const dir = root(t);
  const group = resolveWardrobeState({ root: dir, personaId: 'bot', sessionId: 'qq-group-123456', now: at('22:40') });
  assert.equal(group.ok, false);
  assert.equal(group.code, 'wardrobe-unavailable-in-group');
  // The snapshot degrades honestly rather than going silent or inventing clothes.
  const snapshot = renderWardrobeSnapshot(group);
  assert.match(snapshot, /群聊/);
});

test('缺睡衣时明确报告，不伪造已有衣物', (t) => {
  const dir = root(t);
  const wardrobe = seedWardrobe({ personaId: 'bot', now: at('10:00') });
  // Remove every sleep outfit and every sleep item.
  const stripped = {
    ...wardrobe,
    outfits: wardrobe.outfits.filter(outfit => outfit.context !== 'sleep'),
    items: wardrobe.items.filter(item => !item.contexts.includes('sleep')),
  };
  saveWardrobeFor({ root: dir, personaId: 'bot', wardrobe: stripped, now: at('10:00') });
  const night = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('23:00') });
  assert.equal(night.ok, false);
  assert.equal(night.code, 'no-outfits-for-context');
  assert.equal(night.context, 'sleep');
  assert.match(night.hint, /不要编造/);
  // No silent fallback to everyday clothes.
  assert.equal(night.pieces, undefined);
  assert.ok(!night.availableContexts.includes('sleep'), '报告里明确说 sleep 不可用');
  const report = wardrobeContextReport({ root: dir, personaId: 'bot', now: at('23:00') });
  const sleepRow = report.contexts.find(row => row.context === 'sleep');
  assert.equal(sleepRow.ok, false);
  assert.equal(report.ok, true, '其他场景仍然可用');
});

test('旧版 v1 衣柜可以迁移，并且可以回滚', async (t) => {
  const dir = root(t);
  const legacy = {
    version: 1,
    tendency: '偏爱清爽的蓝白粉配色',
    items: [
      { id: 'w-upper-hoodie', name: '白色连帽卫衣', slot: 'upper', description: '柔软的白色连帽卫衣。', tags: ['日常'] },
      { id: 'w-lower-pants', name: '白色休闲长裤', slot: 'lower', description: '白色直筒休闲长裤。' },
    ],
    current: { date: '2026-11-10', itemIds: ['w-upper-hoodie'], instruction: '今天想轻便一点', updatedAt: at('09:00') },
  };
  const file = path.join(dir, 'home/companion/wardrobe.json');
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');
  const before = fs.readFileSync(file, 'utf8');

  const { commitMigration } = await import('./wardrobe-schema.mjs');
  const result = commitMigration({ root: dir, personaId: 'bot', now: at('10:00') });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'migrated');
  assert.ok(fs.existsSync(result.backup));
  assert.equal(fs.readFileSync(result.backup, 'utf8'), before, '备份必须与原文逐字节一致');

  const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.items.map(item => item.contexts), [['everyday'], ['everyday']]);
  assert.equal(migrated.items[0].provenance.source, 'migrated-v1');
  assert.deepEqual(migrated.outfits, [], '不从扁平清单臆造组合');
  // v1's `current` is preserved verbatim so a rollback loses nothing.
  assert.deepEqual(migrated.current, legacy.current);

  // The legacy `current` still resolves as a same-day override.
  const state = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('11:00') });
  assert.equal(state.isOverride, true);
  assert.equal(state.override.source, 'legacy-current');
  assert.equal(state.pieces.upper.id, 'w-upper-hoodie');
  assert.match(state.override.instruction, /轻便/);

  // Rolling back is copying the backup back.
  fs.copyFileSync(result.backup, file);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const reread = loadWardrobeFor({ root: dir, personaId: 'bot', now: at('11:00') });
  assert.equal(reread.code, 'migrated', '回滚后仍按 v1 读取并即时迁移');
});

/* ───────────────────── prompt / media contracts ───────────────────── */

test('静态 section 里没有任何衣物；快照与工具结果一致', (t) => {
  const dir = root(t);
  const constraint = renderWardrobeConstraint();
  assert.match(constraint, /穿着规则/);
  assert.doesNotMatch(constraint, /睡衣|卫衣|衬衫/, '静态 section 不得包含具体衣物');

  const now = at('22:40');
  const state = resolveWardrobeState({ root: dir, personaId: 'bot', now });
  const detail = wardrobeDetail(dir, { now, personaId: 'bot' });
  assert.equal(detail.context, state.context);
  assert.equal(detail.outfitId, state.outfitId);
  assert.equal(detail.reason, state.reason);
  assert.deepEqual(detail.items.map(item => item.id), Object.values(state.pieces).filter(Boolean).map(piece => piece.id));
  const snapshot = renderWardrobeSnapshot(state);
  assert.match(snapshot, new RegExp(state.pieces.upper.descZh.slice(0, 8)));
});

test('英文服装串只来自英文描述；中文-only 衣物会报告缺失', (t) => {
  const dir = root(t);
  const wardrobe = seedWardrobe({ personaId: 'bot', now: at('10:00') });
  const night = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('02:00') });
  const clause = wardrobeEnglishClause(night);
  assert.equal(clause.ok, true);
  assert.match(clause.clause, /pale blue cotton pajama top/);
  assert.match(clause.clause, /pajama bottoms/);
  assert.doesNotMatch(clause.clause, /[\u4e00-\u9fff]/, '注入生图的串必须是英文');

  const chineseOnly = {
    ...wardrobe,
    outfits: [{ id: 'zh-only', context: 'everyday', pieces: { upper: 'zh-item' }, enabled: true, provenance: { source: 'user' } }],
    items: [...wardrobe.items, { id: 'zh-item', slot: 'upper', contexts: ['everyday'], name: { zh: '蓝色开衫', en: '' }, description: { zh: '蓝色开衫', en: '' }, season: ['all'], enabled: true, tags: [], provenance: { source: 'user' } }],
  };
  saveWardrobeFor({ root: dir, personaId: 'bot', wardrobe: chineseOnly, now: at('10:00') });
  const zhState = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('10:00') });
  const zhClause = wardrobeEnglishClause(zhState);
  assert.equal(zhClause.ok, false);
  assert.equal(zhClause.code, 'no-english-description');
});

test('种子衣物带来源标记，不是伪装的历史事实', (t) => {
  const dir = root(t);
  const loaded = loadWardrobeFor({ root: dir, personaId: 'bot', now: at('10:00') });
  assert.equal(loaded.seeded, true, '首次读取是内存种子，尚未落盘');
  assert.equal(fs.existsSync(path.join(dir, 'home/companion/wardrobe.json')), false, '读取不得写文件');
  for (const item of loaded.wardrobe.items) {
    assert.equal(item.provenance.source, 'seeded-default');
    assert.ok(item.provenance.seedRevision);
  }
  // Every seeded outfit covers a complete scene, and sleepwear carries no outdoor gear.
  const sleep = loaded.wardrobe.outfits.find(outfit => outfit.context === 'sleep');
  const sleepIds = Object.values(sleep.pieces).filter(Boolean);
  assert.ok(sleepIds.length >= 2);
  for (const id of sleepIds) {
    const item = loaded.wardrobe.items.find(row => row.id === id);
    assert.equal(item.contexts.includes('sleep'), true, `${id} 必须可用于 sleep`);
    assert.ok(!/camera|scarf|sneaker/i.test(item.name.en), `${id} 不该出现在睡衣里：${item.name.en}`);
  }
  const contexts = new Set(loaded.wardrobe.outfits.map(outfit => outfit.context));
  for (const context of ['everyday', 'home', 'sleep', 'outdoor', 'special']) {
    assert.equal(contexts.has(context), true, `种子必须覆盖 ${context}`);
    assert.ok(outfitCandidates(loaded.wardrobe, context).length >= 1);
  }
});

test('纯函数分类器：显式 > 活动关键词 > 夜间窗口 > 晚间 > 白天', () => {
  const config = loadWardrobeConfig('/nonexistent-root-directory-for-defaults');
  const base = { config, now: at('14:00') };
  assert.equal(classifyContext({ ...base, explicit: { context: 'special' } }).context, 'special');
  assert.equal(classifyContext({ ...base, activity: { title: '出门买菜', status: 'running', startAt: at('13:50'), endAt: at('14:30') } }).context, 'outdoor');
  assert.equal(classifyContext({ ...base, activity: { title: '准备睡觉', status: 'running', startAt: at('13:50'), endAt: at('14:30') } }).context, 'sleep');
  assert.equal(classifyContext({ config, now: at('23:00') }).context, 'sleep');
  assert.equal(classifyContext({ config, now: at('20:00') }).context, 'home');
  assert.equal(classifyContext({ ...base }).context, 'everyday');
  // An unknown explicit value is ignored rather than trusted.
  assert.equal(classifyContext({ ...base, explicit: { context: 'pajamas' } }).context, 'everyday');
});

test('currentOutfit 保留 v1 语义，同时带上场景信息', (t) => {
  const dir = root(t);
  const wardrobe = loadWardrobeFor({ root: dir, personaId: 'bot', now: at('10:00') }).wardrobe;
  const day = currentOutfit(wardrobe, at('10:00'));
  assert.ok(day.items.length >= 3);
  assert.equal(day.context, 'everyday');
  assert.equal(day.source, 'daily');
  const night = currentOutfit(wardrobe, at('02:00'));
  assert.equal(night.context, 'sleep');
  assert.equal(night.outfitId, 'sleepwear-default');
});

test('清除覆盖后回到自动解析', (t) => {
  const dir = root(t);
  const wardrobe = loadWardrobeFor({ root: dir, personaId: 'bot', now: at('14:00') }).wardrobe;
  const ids = [wardrobe.items.find(item => item.id === 'w-upper-shirt').id];
  setOutfit(dir, { itemIds: ids, instruction: '试试这个', now: at('14:00'), personaId: 'bot' });
  assert.equal(resolveWardrobeState({ root: dir, personaId: 'bot', now: at('14:05') }).isOverride, true);

  const cleared = setOutfit(dir, { clearOverride: true, now: at('14:06'), personaId: 'bot' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, 1);
  const after = resolveWardrobeState({ root: dir, personaId: 'bot', now: at('14:07') });
  assert.equal(after.isOverride, false);
  assert.equal(after.outfitId, 'everyday-default');
});

test('非法 until 被拒绝且不写盘', (t) => {
  const dir = root(t);
  const wardrobe = loadWardrobeFor({ root: dir, personaId: 'bot', now: at('14:00') }).wardrobe;
  const ids = [wardrobe.items[0].id];
  const result = setOutfit(dir, { itemIds: ids, until: 'not-a-date', now: at('14:00'), personaId: 'bot' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bad-until');
  assert.equal(fs.existsSync(path.join(dir, 'home/companion/wardrobe.json')), false, '失败不写文件');

  const past = setOutfit(dir, { itemIds: ids, until: at('13:00'), now: at('14:00'), personaId: 'bot' });
  assert.equal(past.ok, false);
  assert.equal(past.code, 'bad-until');
});

test('群聊里 companion_outfit_set 被拒绝', (t) => {
  const dir = root(t);
  const result = setOutfit(dir, { itemIds: ['w-upper-hoodie'], now: at('14:00'), sessionId: 'qq-group-1', personaId: 'bot' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'wardrobe-unavailable-in-group');
  assert.equal(fs.existsSync(path.join(dir, 'home/companion/wardrobe.json')), false);
});
