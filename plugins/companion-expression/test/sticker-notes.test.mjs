/**
 * 表情词典：见过的表情只用解释一次。
 *
 * 这条测试钉住用户 2026-11-08 提的那件事：
 *   1. 一个表情第一次出现 → `lookup` 说「没记过」，**不许编意思**；
 *   2. 问清楚之后 `record` 记下 → 同一个表情再来，`lookup` 直接回原来的意思；
 *   3. 动图也一样（记的是意思，不是帧）；
 *   4. 见过多次但没记过的，是「值得问一句」的那一批（`stats().askable`）；
 *   5. 什么算「同一张表情」：指纹相同就算，与 QQ 号无关。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openExpressionDb } from '../src/db.mjs';
import { createStickerNotes } from '../src/sticker-notes.mjs';

const CLOCK = 1_700_000_000_000;

function harness() {
  const db = openExpressionDb({ file: ':memory:', now: () => CLOCK });
  const notes = createStickerNotes({ db, now: () => CLOCK });
  return { db, notes, cleanup: () => db.close() };
}

const SCOPE = 'owner_private:abc';

test('没记过的表情：lookup 如实说没记过，不编意思', () => {
  const env = harness();
  try {
    const found = env.notes.lookup({ stickerKey: 'f:0AB4', label: '困', scope: SCOPE });
    assert.equal(found.known, false);
    assert.equal(found.reasonCode, 'not-recorded');
    assert.equal(found.meaning, undefined, '认不出就没有意思，不许有默认值');
    assert.equal(found.label, '困', '字面照原样带回来（问的时候要能说「这个困是什么意思」）');
    assert.equal(found.times, 1, '第一次见面');
  } finally {
    env.cleanup();
  }
});

test('问清楚之后记下来：同一个表情再出现，直接回原来的意思', () => {
  const env = harness();
  try {
    const saved = env.notes.record({ stickerKey: 'f:0AB4', label: '困', meaning: '我困了，想睡', scope: SCOPE });
    assert.equal(saved.ok, true);
    assert.equal(saved.note.meaning, '我困了，想睡');
    assert.equal(saved.note.source, 'owner', '默认记成「主人说的」');

    const again = env.notes.lookup({ stickerKey: 'f:0AB4', label: '困', scope: SCOPE });
    assert.equal(again.known, true);
    assert.equal(again.meaning, '我困了，想睡');
    assert.equal(again.animated, false);
  } finally {
    env.cleanup();
  }
});

test('动图表情一样记：意思与帧数无关', () => {
  const env = harness();
  try {
    env.notes.record({ stickerKey: 'f:ANI1', label: '', meaning: '无语，别说了', animated: true, scope: SCOPE });
    const found = env.notes.lookup({ stickerKey: 'f:ANI1', label: '', scope: SCOPE });
    assert.equal(found.known, true);
    assert.equal(found.meaning, '无语，别说了');
    assert.equal(found.animated, true, '动图标记要留着：它影响「要不要逐帧看」这个判断');
  } finally {
    env.cleanup();
  }
});

test('同一张表情跨会话仍认得出：指纹不含 QQ 号', () => {
  const env = harness();
  try {
    env.notes.record({ stickerKey: 'f:SAME', meaning: '谢谢', scope: 'group:1' });
    const other = env.notes.lookup({ stickerKey: 'f:SAME', scope: 'group:2' });
    assert.equal(other.known, true, '换一个群（甚至换一个人）还是同一张图，意思照用');
    assert.equal(other.meaning, '谢谢');
  } finally {
    env.cleanup();
  }
});

test('见过多次但没记过 = 值得问一句的那一批', () => {
  const env = harness();
  try {
    env.notes.lookup({ stickerKey: 'f:ASK', label: '', scope: SCOPE });
    env.notes.lookup({ stickerKey: 'f:ASK', label: '', scope: SCOPE });
    const stats = env.notes.stats();
    assert.equal(stats.noted, 0);
    assert.equal(stats.seen, 1, '按 (表情, 作用域) 记一行');
    assert.equal(stats.askable, 1, '见过两次还没记过 → 该问了');

    // 问清楚之后就不该再算「该问」。
    env.notes.record({ stickerKey: 'f:ASK', meaning: '我不开心', scope: SCOPE });
    assert.equal(env.notes.stats().askable, 0);
  } finally {
    env.cleanup();
  }
});

test('没有指纹 / 空意思：拒绝，不写一半', () => {
  const env = harness();
  try {
    assert.equal(env.notes.record({ meaning: '困' }).reasonCode, 'key-missing');
    assert.equal(env.notes.record({ stickerKey: 'f:X', meaning: '   ' }).reasonCode, 'meaning-empty');
    assert.equal(env.notes.lookup({}).reasonCode, 'key-missing');
    assert.equal(env.notes.stats().noted, 0, '拒绝时不落行');
  } finally {
    env.cleanup();
  }
});

test('重记会覆盖：认错了能改', () => {
  const env = harness();
  try {
    env.notes.record({ stickerKey: 'f:FIX', meaning: '第一次记错了', scope: SCOPE });
    env.notes.record({ stickerKey: 'f:FIX', meaning: '其实是这个意思', scope: SCOPE });
    assert.equal(env.notes.lookup({ stickerKey: 'f:FIX' }).meaning, '其实是这个意思');
    assert.equal(env.notes.stats().noted, 1, '改不是新增');
  } finally {
    env.cleanup();
  }
});

test('按字面找：问「困」是什么意思时能把记过的都列出来', () => {
  const env = harness();
  try {
    env.notes.record({ stickerKey: 'f:A', label: '困', meaning: '困了' });
    env.notes.record({ stickerKey: 'f:B', label: '困', meaning: '无聊到困' });
    env.notes.record({ stickerKey: 'f:C', label: '开心', meaning: '高兴' });
    const hits = env.notes.findByLabel('困');
    assert.equal(hits.length, 2);
    assert.ok(hits.every(note => note.label === '困'));
  } finally {
    env.cleanup();
  }
});
