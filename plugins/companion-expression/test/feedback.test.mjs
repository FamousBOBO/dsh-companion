/**
 * feedback.mjs 的离线测试（E3 §7 习惯学习）。
 *
 * 四条要证明的产品口径：
 *   1. **沉默不是负反馈**：`action:'silence'` 一行都不写、不降权、不改分。
 *   2. **reject 立刻降权并抑制重发**：写入当轮即生效（decision/retrieval 直接读 preferences），
 *      不需要等任何学习任务；控制粒度是**作用域**，群里的 reject 不会禁掉主人在私聊里的同一张图。
 *   3. **显式正反馈提升同类意图**：praise 让 feedbackScore 上升、reject 让它下降（0.5 中性）。
 *   4. **群反馈不进主人记忆**：返回结构固定 `memoryWritten:false`，且库里只有
 *      `expression_feedback` / `preferences` 两处痕迹（本模块没有任何记忆桥）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openExpressionDb } from '../src/db.mjs';
import { groupScope, privateScope } from '../src/scopes.mjs';
import {
  FEEDBACK_SIGNALS, WRITABLE_SIGNALS, createFeedback, feedbackRowOf, feedbackScoreOf,
  feedbackSummary, isSuppressed, suppressionKey,
} from '../src/feedback.mjs';
import { retrieve } from '../src/retrieval.mjs';

const SALT = 'test-salt-0123456789abcdef';
const OWNER_SCOPE = privateScope({ kind: 'owner_private', chatId: 10001, salt: SALT });
const GROUP_SCOPE = groupScope(90001);
const NOW = 1_700_000_000_000;
const ASSET = 'ast_abc123456';

function withDb(run) {
  const db = openExpressionDb({ file: ':memory:' });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

const feedbackFor = (db, scope) => createFeedback({ db, config: {}, now: () => NOW, scopeHint: scope });

test('信号集合：只认显式三种；silence 可传但明确不写', () => {
  assert.deepEqual([...FEEDBACK_SIGNALS], ['praise', 'reject', 'correction', 'silence']);
  assert.deepEqual([...WRITABLE_SIGNALS], ['praise', 'reject', 'correction']);
  assert.ok(!WRITABLE_SIGNALS.includes('silence'));
});

test('沉默不计负反馈：不写行、不抑制、分数不变', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    const before = feedbackScoreOf({ db, assetId: ASSET, scope: OWNER_SCOPE });
    const result = feedback.record({ action: 'silence', assetId: ASSET, scope: OWNER_SCOPE });
    assert.equal(result.ok, true, '沉默不是错误');
    assert.equal(result.recorded, false);
    assert.equal(result.reasonCode, 'silence-not-negative');
    assert.equal(db.all('SELECT count(*) AS n FROM expression_feedback')[0].n, 0, '一行都没写');
    assert.equal(db.all('SELECT count(*) AS n FROM preferences')[0].n, 0, '没有任何抑制键');
    assert.equal(feedbackScoreOf({ db, assetId: ASSET, scope: OWNER_SCOPE }), before, '分数不动');
    assert.equal(isSuppressed({ db, scope: OWNER_SCOPE, assetId: ASSET }), false);
  });
});

test('未知信号 / 缺作用域 → 结构化拒绝（不写库）', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    const unknown = feedback.record({ action: 'love', assetId: ASSET, scope: OWNER_SCOPE });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reasonCode, 'signal-unknown');
    const noScope = feedback.record({ action: 'reject', assetId: ASSET, scope: '' });
    assert.equal(noScope.ok, false);
    assert.equal(noScope.reasonCode, 'scope-missing');
    assert.equal(noScope.memoryWritten, false);
  });
});

test('reject 立刻降权并抑制重发（同一作用域内）', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    const result = feedback.record({ action: 'reject', assetId: ASSET, scope: OWNER_SCOPE, note: '别发这张' });
    assert.equal(result.ok, true);
    assert.equal(result.recorded, true);
    assert.equal(result.suppressed, true);
    assert.equal(db.get('SELECT value FROM preferences WHERE key = ?', [suppressionKey(OWNER_SCOPE, ASSET)]).value, '1');
    assert.equal(isSuppressed({ db, scope: OWNER_SCOPE, assetId: ASSET }), true);
    // 降权：0.5 中性 → reject 后低于中性。
    const score = feedbackScoreOf({ db, assetId: ASSET, scope: OWNER_SCOPE });
    assert.ok(score < 0.5, `reject 后分数应低于 0.5，实际 ${score}`);
    const summary = feedbackSummary({ db, assetId: ASSET, scope: OWNER_SCOPE });
    assert.equal(summary.reject, 1);
    assert.equal(summary.suppressed, true);
  });
});

test('抑制是作用域级的：群里的 reject 不影响私聊，反之亦然', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    feedback.record({ action: 'reject', assetId: ASSET, scope: GROUP_SCOPE, note: '群里别发' });
    assert.equal(isSuppressed({ db, scope: GROUP_SCOPE, assetId: ASSET }), true);
    assert.equal(isSuppressed({ db, scope: OWNER_SCOPE, assetId: ASSET }), false, '私聊的同一张图不受影响');
    // 库里只有一行反馈，作用域写在行上。
    const rows = db.all('SELECT scope, signal FROM expression_feedback');
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].scope), GROUP_SCOPE);
  });
});

test('抑制立刻反映到检索：reject 过的图不会再出现在候选里', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    feedback.record({ action: 'reject', assetId: ASSET, scope: OWNER_SCOPE });
    const library = {
      candidates: () => [
        { assetId: ASSET, moderationState: 'approved', kind: 'png', mime: 'image/png', createdAt: NOW, visibility: [{ scope: OWNER_SCOPE, approval: 'approved' }], card: { literal: '猫猫', intents: ['amusement'] } },
        { assetId: 'ast_ok0000000', moderationState: 'approved', kind: 'png', mime: 'image/png', createdAt: NOW, visibility: [{ scope: OWNER_SCOPE, approval: 'approved' }], card: { literal: '狗头', intents: ['teasing'] } },
      ],
    };
    const found = retrieve({
      library, usable: [OWNER_SCOPE], scope: OWNER_SCOPE, context: { query: '猫', intents: [], scenes: [] },
      now: NOW, isSuppressed: ({ assetId, scope }) => isSuppressed({ db, assetId, scope }),
    });
    assert.equal(found.filtered.suppressed, 1, '被 suppress 的候选在硬门后被计入');
    assert.deepEqual(found.candidates.map(row => row.assetId), ['ast_ok0000000']);
  });
});

test('praise 提升正反馈分；correction 也可以记', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    feedback.record({ action: 'praise', assetId: ASSET, scope: OWNER_SCOPE });
    let score = feedbackScoreOf({ db, assetId: ASSET, scope: OWNER_SCOPE });
    assert.ok(score > 0.5, `praise 后应高于 0.5，实际 ${score}`);
    feedback.record({ action: 'praise', assetId: ASSET, scope: OWNER_SCOPE });
    const twice = feedbackScoreOf({ db, assetId: ASSET, scope: OWNER_SCOPE });
    assert.ok(twice >= score, '多次夸奖只会更高（不反转）');
    const correction = feedback.record({ action: 'correction', assetId: ASSET, scope: OWNER_SCOPE, note: '这不是嘲讽' });
    assert.equal(correction.ok, true);
    score = feedbackScoreOf({ db, assetId: ASSET, scope: OWNER_SCOPE });
    assert.ok(score <= 1);
    assert.equal(feedbackRowOf({ db, assetId: ASSET, scope: OWNER_SCOPE, signal: 'correction' }).signal, 'correction');
  });
});

test('correction 可改语义卡（注入 library 时），未注入时只记反馈', () => {
  withDb(db => {
    const calls = [];
    const library = {
      getCard: () => ({ literal: '旧描述', intents: ['amusement'], avoidWhen: [] }),
      upsertCard: (assetId, card) => { calls.push({ assetId, card }); return { ok: true }; },
    };
    const feedback = createFeedback({ db, library, config: {}, now: () => NOW });
    const result = feedback.record({
      action: 'correction', assetId: ASSET, scope: OWNER_SCOPE,
      cardPatch: { literal: '猫猫捂脸', avoidWhen: ['serious-help'] },
    });
    assert.equal(result.cardUpdated, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].card.literal, '猫猫捂脸');
    assert.deepEqual(calls[0].card.avoidWhen, ['serious-help']);
    assert.equal(calls[0].card.assetId, ASSET);

    // 没有 library 时：反馈照记，cardUpdated=false，不抛。
    const plain = createFeedback({ db, config: {}, now: () => NOW });
    const noLib = plain.record({ action: 'correction', assetId: ASSET, scope: OWNER_SCOPE, cardPatch: { literal: 'x' } });
    assert.equal(noLib.ok, true);
    assert.equal(noLib.recorded, true);
    assert.equal(noLib.cardUpdated, false);
  });
});

test('群反馈只进 expression.sqlite：返回结构固定 memoryWritten:false', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    const rows = [
      feedback.record({ action: 'praise', assetId: ASSET, scope: GROUP_SCOPE }),
      feedback.record({ action: 'reject', assetId: ASSET, scope: GROUP_SCOPE }),
      feedback.record({ action: 'correction', assetId: ASSET, scope: GROUP_SCOPE }),
    ];
    for (const row of rows) assert.equal(row.memoryWritten, false, '本模块没有任何记忆桥');
    // 库里的痕迹只有这两张表；没有别的表被写入。
    assert.equal(db.all('SELECT count(*) AS n FROM expression_feedback')[0].n, 3);
    assert.equal(db.all('SELECT count(*) AS n FROM preferences')[0].n, 1, '只有 reject 那一行抑制键');
    assert.equal(db.all('SELECT count(*) AS n FROM expression_cards')[0].n, 0, '没改语义卡');
  });
});

test('解除抑制：clearSuppression 之后同一作用域可以再发', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    feedback.record({ action: 'reject', assetId: ASSET, scope: GROUP_SCOPE });
    assert.equal(isSuppressed({ db, scope: GROUP_SCOPE, assetId: ASSET }), true);
    const cleared = feedback.clearSuppression({ scope: GROUP_SCOPE, assetId: ASSET });
    assert.equal(cleared.ok, true);
    assert.equal(isSuppressed({ db, scope: GROUP_SCOPE, assetId: ASSET }), false);
    const bad = feedback.clearSuppression({ scope: '', assetId: ASSET });
    assert.equal(bad.ok, false);
    assert.equal(bad.reasonCode, 'scope-missing');
    // 历史反馈行仍在（撤销的是抑制，不是历史证据）。
    assert.equal(db.all('SELECT count(*) AS n FROM expression_feedback')[0].n, 1);
  });
});

test('反馈行是追加式的：同一张图两次 reject 各一行，抑制键只有一条', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    feedback.record({ action: 'reject', assetId: ASSET, scope: OWNER_SCOPE, note: '第一次' });
    feedback.record({ action: 'reject', assetId: ASSET, scope: OWNER_SCOPE, note: '第二次' });
    assert.equal(db.all('SELECT count(*) AS n FROM expression_feedback')[0].n, 2);
    assert.equal(db.all('SELECT count(*) AS n FROM preferences')[0].n, 1);
    const summary = feedbackSummary({ db, assetId: ASSET, scope: OWNER_SCOPE });
    assert.equal(summary.reject, 2);
    assert.equal(summary.total, 2);
    assert.ok(summary.lastAt > 0);
  });
});

test('note 长度被截断，不把整段对话写进库', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    const result = feedback.record({ action: 'reject', assetId: ASSET, scope: OWNER_SCOPE, note: 'x'.repeat(2000) });
    assert.equal(result.ok, true);
    const row = db.get('SELECT note FROM expression_feedback WHERE id = ?', [result.id]);
    assert.ok(String(row.note).length <= 240, `note 应被截断，实际 ${String(row.note).length}`);
  });
});

test('stats 口径：praise/reject/correction 分开计数，other 不参与打分', () => {
  withDb(db => {
    const feedback = feedbackFor(db);
    feedback.record({ action: 'praise', assetId: ASSET, scope: OWNER_SCOPE });
    feedback.record({ action: 'reject', assetId: ASSET, scope: OWNER_SCOPE });
    // 直接塞一行"其它"信号（历史数据里可能有），验证它只进 other，不改分。
    db.run(
      'INSERT INTO expression_feedback (id, asset_id, plan_id, scope, signal, confidence, note, at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)',
      ['fb_other', ASSET, OWNER_SCOPE, 'neutral', 1, '', NOW],
    );
    const summary = feedbackSummary({ db, assetId: ASSET, scope: OWNER_SCOPE });
    assert.equal(summary.praise, 1);
    assert.equal(summary.reject, 1);
    assert.equal(summary.other, 1);
    assert.equal(summary.total, 3);
    const neutral = feedbackScoreOf({ db, assetId: ASSET, scope: OWNER_SCOPE });
    assert.ok(neutral < 0.5, '一次 praise 抵不过一次 reject');
  });
});
