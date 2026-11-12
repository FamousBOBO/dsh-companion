/** Visual identity + the joint `resolveCompanionVisualState()` contract.
 *
 * The audit found no visual-identity implementation anywhere in this repository, so these
 * tests define the behaviour rather than pin an existing one. The important assertions are
 * the negative ones: a missing persona, a missing file or a Chinese-only description must
 * produce "not configured" and an empty clause — never a guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  identityEnglishClause, loadVisualIdentity, resolveCompanionVisualState, visualIdentityFile, visualStateReport,
} from './visual-identity.mjs';
import { saveWardrobeFor, seedWardrobe } from './wardrobe-schema.mjs';

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-identity-'));
  fs.mkdirSync(path.join(dir, 'home/companion'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function at(hhmm, date = '2026-11-10') {
  return new Date(`${date}T${hhmm}:00+08:00`).getTime();
}

function writeIdentity(dir, personas) {
  fs.writeFileSync(visualIdentityFile(dir), JSON.stringify({ schemaVersion: 1, personas }, null, 2), 'utf8');
}

const COMPANION = {
  name: { zh: '测试角色', en: 'Testa' },
  source: { zh: '测试作品', en: 'Synthetic Testwork' },
  appearance: {
    zh: '银灰短发，蓝到粉的渐变瞳色，左耳一枚银色耳钉。',
    en: 'short silver-grey hair, blue-to-pink gradient eyes, a small silver earring on her left ear',
  },
  provenance: { source: 'user', updatedAt: '2026-11-10T00:00:00.000Z' },
};

test('身份来自视觉身份数据，服装来自衣柜，两者都以当前 persona 为键', (t) => {
  const dir = root(t);
  writeIdentity(dir, { bot: COMPANION });
  const state = resolveCompanionVisualState({ root: dir, personaId: 'bot', now: at('22:40') });
  assert.equal(state.ok, true, JSON.stringify(state.missing));
  assert.equal(state.identity.state, 'configured');
  assert.equal(state.identity.name, '测试角色');
  assert.equal(state.identity.nameEn, 'Testa');
  assert.equal(state.identity.sourceEn, 'Synthetic Testwork');
  assert.equal(state.wardrobe.context, 'sleep');
  assert.equal(state.wardrobe.outfitId, 'sleepwear-default');
  assert.equal(state.wardrobe.reason, 'night-window');
  assert.deepEqual(state.missing, []);

  assert.match(state.identityClause, /Testa from Synthetic Testwork/);
  assert.match(state.imageClause, /silver-grey hair/);
  assert.match(state.imageClause, /wearing .*pajama top/i);
  assert.doesNotMatch(state.imageClause, /[\u4e00-\u9fff]/, '注入生图的整串必须是英文');
});

test('身份缺失 → not-configured，且不编造外貌；衣柜仍然可用', (t) => {
  const dir = root(t);
  const state = resolveCompanionVisualState({ root: dir, personaId: 'bot', now: at('14:00') });
  assert.equal(state.ok, false);
  assert.equal(state.identity.state, 'not-configured');
  assert.equal(state.identity.code, 'identity-missing');
  assert.equal(state.identityClause, '');
  assert.equal(state.wardrobe.ok, true, '衣柜独立可用');
  assert.deepEqual(state.missing, ['identity']);
  assert.match(state.imageClause, /^wearing /, '只有服装部分，不编造身份');
});

test('身份文件存在但没有这个 persona → 明确报缺失，不借用别人格', (t) => {
  const dir = root(t);
  writeIdentity(dir, { alice: COMPANION });
  const state = resolveCompanionVisualState({ root: dir, personaId: 'bob', now: at('14:00') });
  assert.equal(state.ok, false);
  assert.equal(state.identity.code, 'identity-missing-for-persona');
  assert.match(JSON.stringify(state.missing), /identity/);
  const loaded = loadVisualIdentity({ root: dir, personaId: 'bob' });
  assert.deepEqual(loaded.available, ['alice']);
});

test('身份不完整（只有名字没有外貌）→ 不当成已配置', (t) => {
  const dir = root(t);
  writeIdentity(dir, { bot: { name: { zh: '测试角色', en: 'Testa' } } });
  const loaded = loadVisualIdentity({ root: dir, personaId: 'bot' });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'identity-incomplete');
});

test('衣柜缺失（别人格）时视觉状态同时报两块缺失', (t) => {
  const dir = root(t);
  writeIdentity(dir, { bot: COMPANION });
  const owned = seedWardrobe({ personaId: 'alice', now: at('10:00') });
  saveWardrobeFor({ root: dir, personaId: 'alice', wardrobe: owned, now: at('10:00') });
  const state = resolveCompanionVisualState({ root: dir, personaId: 'bot', now: at('14:00') });
  assert.equal(state.ok, false);
  assert.equal(state.wardrobe.code, 'wardrobe-missing-for-persona');
  assert.deepEqual(state.missing, ['wardrobe']);
  assert.equal(state.imageClause, 'Testa from Synthetic Testwork, short silver-grey hair, blue-to-pink gradient eyes, a small silver earring on her left ear');
});

test('群聊会话下服装不可用，身份仍然可读但不拼成完整画面串', (t) => {
  const dir = root(t);
  writeIdentity(dir, { bot: COMPANION });
  const state = resolveCompanionVisualState({ root: dir, personaId: 'bot', sessionId: 'qq-group-1', now: at('14:00') });
  assert.equal(state.ok, false);
  assert.equal(state.wardrobe.code, 'wardrobe-unavailable-in-group');
  assert.deepEqual(state.missing, ['wardrobe']);
  assert.doesNotMatch(state.imageClause, /wearing/);
});

test('生图串随昼夜变化：深夜睡衣、白天常服、夜间外出外出服', (t) => {
  const dir = root(t);
  writeIdentity(dir, { bot: COMPANION });
  const night = resolveCompanionVisualState({ root: dir, personaId: 'bot', now: at('02:00') });
  assert.match(night.imageClause, /pajama top/);
  assert.doesNotMatch(night.imageClause, /sneakers/);

  const day = resolveCompanionVisualState({ root: dir, personaId: 'bot', now: at('14:00') });
  assert.match(day.imageClause, /hoodie|shirt/i);

  const nightOut = resolveCompanionVisualState({
    root: dir, personaId: 'bot', now: at('23:10'),
    activity: { title: '出门散步', kind: 'activity', status: 'running', startAt: at('23:00'), endAt: at('23:40') },
  });
  assert.equal(nightOut.wardrobe.context, 'outdoor');
  assert.match(nightOut.imageClause, /cardigan/);
  assert.doesNotMatch(nightOut.imageClause, /pajama/);
});

test('身份与服装同源：工具返回的 wardrobe 与视觉状态一致', (t) => {
  const dir = root(t);
  writeIdentity(dir, { bot: COMPANION });
  const now = at('22:40');
  const a = resolveCompanionVisualState({ root: dir, personaId: 'bot', now });
  const b = resolveCompanionVisualState({ root: dir, personaId: 'bot', now });
  assert.equal(a.wardrobe.outfitId, b.wardrobe.outfitId);
  assert.deepEqual(Object.keys(a.wardrobe.pieces), Object.keys(b.wardrobe.pieces));
});

test('identityEnglishClause 只接受英文，中文-only 外貌不产生串', () => {
  assert.equal(identityEnglishClause(null).ok, false);
  assert.equal(identityEnglishClause({ name: { zh: '测试' }, appearance: { zh: '银灰短发' } }).ok, false);
  const ok = identityEnglishClause({ name: { zh: '测试', en: 'Testa' }, appearance: { zh: '银灰短发', en: 'short silver hair' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.clause, 'Testa, short silver hair');
});

test('visualStateReport 汇总身份与五个场景的可用性', (t) => {
  const dir = root(t);
  writeIdentity(dir, { bot: COMPANION });
  const report = visualStateReport({ root: dir, personaId: 'bot', now: at('14:00') });
  assert.equal(report.ok, true);
  assert.equal(report.identity.state, 'configured');
  assert.deepEqual(report.contexts.map(row => row.context), ['everyday', 'home', 'sleep', 'outdoor', 'special']);
  for (const row of report.contexts) assert.equal(row.ok, true, `${row.context} 应该可用`);
});
