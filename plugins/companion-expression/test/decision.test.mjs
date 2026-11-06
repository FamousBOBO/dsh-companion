/**
 * decision.mjs 的离线测试（E2 §6.1）。
 *
 * 覆盖任务要求的全部验收点：
 *   - 严肃求助 / 现实冲突 / 隐私风险 / 用户明确拒绝 → abstain（禁忌硬门优先于偏好分）；
 *   - 单轮最多 1 张（maxPerTurn）；
 *   - 私聊 300s 冷却 + 4 张/小时；群 600s + 2 张/小时；
 *   - 同图 48h（私聊）/168h（群）不重复；
 *   - 没有高分素材 → text_only（abstain 是正常结果，不是错误）；
 *   - 事实来源是数据库：重启后同一会话的冷却与配额仍然有效（这里用「同一份库再建一个
 *     decision 调用」来模拟）。
 *
 * 数据库一律 `:memory:`，绝不碰 data/ 下的真库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openExpressionDb } from '../src/db.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { groupScope, privateScope } from '../src/scopes.mjs';
import { createLibrary } from '../src/library.mjs';
import { fromLibrary, retrieve, hardGate, scoreCandidate, WEIGHTS, SENDABLE_KINDS } from '../src/retrieval.mjs';
import {
  decide, limitsFrom, quotaBucketFor, quotaState, repeatedAsset, tabooOf, TABOO_REASONS,
} from '../src/decision.mjs';
import { createFeedback } from '../src/feedback.mjs';

const SALT = 'test-salt-0123456789abcdef';
const OWNER_SCOPE = privateScope({ kind: 'owner_private', chatId: 10001, salt: SALT });
const PEER_SCOPE = privateScope({ kind: 'peer_private', chatId: 20002, salt: SALT });
const GROUP_SCOPE = groupScope(90001);
const NOW = 1_700_000_000_000;

/** 开一张内存库；测试结束时自动关。 */
function withDb(run) {
  const db = openExpressionDb({ file: ':memory:' });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function configWith(delivery = {}) {
  return { ...DEFAULT_CONFIG, delivery: { ...DEFAULT_CONFIG.delivery, enabled: true, ...delivery } };
}

/** 造一行「已经真发过」的投递记录（决策的事实来源就是这张表）。 */
function seedDelivery(db, { planId = 'plan_a', index = 0, assetId = 'ast_abc123456', scope = OWNER_SCOPE, status = 'confirmed', at = NOW } = {}) {
  db.run(
    `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, provider_message_id, reason_code, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [planId, index, assetId, scope, status, `${planId}:${index}`, 111, '', at],
  );
}

const candidates = (fitScore = 0.9, assetId = 'ast_abc123456') => [{ assetId, fitScore, summary: 'x', intents: [], avoidWhen: [] }];

test('limitsFrom 只读 config.delivery，基准值与 config.mjs 的默认一致', () => {
  const limits = limitsFrom(DEFAULT_CONFIG);
  assert.equal(limits.maxPerTurn, 1);
  assert.equal(limits.dmCooldownSeconds, 300);
  assert.equal(limits.groupCooldownSeconds, 600);
  assert.equal(limits.maxDmPerHour, 4);
  assert.equal(limits.maxGroupPerHour, 2);
  assert.equal(limits.repeatWindowDmHours, 48);
  assert.equal(limits.repeatWindowGroupHours, 168);
  assert.equal(limits.enabled, false, '默认 delivery.enabled=false');
});

test('禁忌硬门：严肃求助 / 现实冲突 / 隐私风险 / 用户明确拒绝 → abstain', () => {
  withDb(db => {
    const config = configWith();
    const base = { db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.99), now: NOW };
    const cases = [
      [{ seriousHelp: true }, 'abstain-serious-help'],
      [{ realConflict: true }, 'abstain-real-conflict'],
      [{ privacyRisk: true }, 'abstain-privacy-risk'],
      [{ userRefused: true }, 'abstain-user-refusal'],
      [{ declinedStickers: true }, 'abstain-user-refusal'],
      [{ riskTags: ['serious-help'] }, 'abstain-serious-help'],
    ];
    for (const [context, expected] of cases) {
      const result = decide({ ...base, context });
      assert.equal(result.send, false, `${expected} 时不该发`);
      assert.equal(result.reasonCode, expected);
      assert.equal(result.mode, 'text_only', 'abstain 在投递层就是纯文字');
    }
    // 硬门与偏好分无关：即使候选 0.99 也不发。
    const strong = decide({ ...base, context: { seriousHelp: true } });
    assert.equal(strong.fitScore, 0, '硬门命中时不给适配分（避免下层误读成「差一点就发」）');
  });
});

test('禁忌硬门也看草稿措辞（宁可少发一张，也不在严肃语境里玩梗）', () => {
  const serious = tabooOf({ draft: '我今天很难受，想找人说说话' });
  assert.equal(serious.taboo, true);
  assert.equal(serious.reasonCode, TABOO_REASONS['serious-help']);
  const conflict = tabooOf({ draft: '对不起，是我搞砸了' });
  assert.equal(conflict.reasonCode, TABOO_REASONS['real-conflict']);
  const joke = tabooOf({ draft: '哈哈哈哈这也太搞笑了' });
  assert.equal(joke.taboo, false, '普通玩笑话不是禁忌');
});

test('delivery.enabled=false 或模块关闭 → abstain（默认不对外发送）', () => {
  withDb(db => {
    const off = decide({ db, config: DEFAULT_CONFIG, target: { kind: 'dm', id: 1 }, scope: OWNER_SCOPE, candidates: candidates(), now: NOW });
    assert.equal(off.send, false);
    assert.equal(off.reasonCode, 'abstain-delivery-disabled');
    assert.equal(off.ok, true, '关闭是正常结果，不是错误');

    const moduleOff = decide({ db, config: configWith(), target: { kind: 'dm', id: 1 }, scope: OWNER_SCOPE, candidates: candidates(), now: NOW, moduleEnabled: false });
    assert.equal(moduleOff.reasonCode, 'abstain-module-off');

    const turnLimit = decide({ db, config: configWith({ maxPerTurn: 0 }), target: { kind: 'dm', id: 1 }, scope: OWNER_SCOPE, candidates: candidates(), now: NOW });
    assert.equal(turnLimit.reasonCode, 'abstain-turn-limit');
  });
});

test('单轮最多 1 张：即使给 5 个高分候选，也只挑 1 张', () => {
  withDb(db => {
    const config = configWith({ maxPerTurn: 1 });
    const many = Array.from({ length: 5 }, (_, i) => ({ assetId: `ast_${i}00000000`, fitScore: 0.95 }));
    const result = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: many, now: NOW });
    assert.equal(result.send, true);
    assert.equal(result.assetId, 'ast_000000000', '取最高分那张（稳定排序）');
    assert.equal(result.mode, 'text_then_sticker');
    assert.equal(limitsFrom(config).maxPerTurn, 1);
  });
});

test('私聊冷却 300s：刚发过就是 abstain-cooldown，300s 之后才可能再发', () => {
  withDb(db => {
    const config = configWith({ dmCooldownSeconds: 300, dmCooldownTurns: 3 });
    seedDelivery(db, { scope: OWNER_SCOPE, at: NOW - 10_000, assetId: 'ast_000000000' });
    const soon = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.95, 'ast_ffffffffff'), now: NOW });
    assert.equal(soon.send, false);
    assert.equal(soon.reasonCode, 'abstain-cooldown');
    assert.ok(soon.quota.cooldownRemainingMs >= 280_000, `剩余冷却约 290s，实际 ${soon.quota.cooldownRemainingMs}`);

    const later = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.95, 'ast_ffffffffff'), now: NOW - 10_000 + 300_000 });
    assert.equal(later.send, true, '过了 300s 冷却，另一张图可以发');
  });
});

test('群聊冷却 600s（比私聊长），独立于私聊状态', () => {
  withDb(db => {
    const config = configWith();
    seedDelivery(db, { planId: 'plan_g', scope: GROUP_SCOPE, at: NOW - 100_000, assetId: 'ast_000000000' });
    seedDelivery(db, { planId: 'plan_dm', scope: OWNER_SCOPE, at: NOW - 400_000, assetId: 'ast_000000000' });
    const group = decide({ db, config, target: { kind: 'group', id: 90001 }, scope: GROUP_SCOPE, candidates: candidates(0.95, 'ast_ffffffffff'), now: NOW });
    assert.equal(group.reasonCode, 'abstain-cooldown', '群聊 600s 还没到');
    assert.equal(group.quota.cooldownSeconds, 600);
    // 私聊在 300s 已经过了，因此同一时刻私聊可以发。
    const dm = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.95, 'ast_ffffffffff'), now: NOW });
    assert.equal(dm.send, true, '私聊的 300s 冷却已过');
  });
});

test('私聊 4 张/小时：第 5 张 abstain-hourly-quota', () => {
  withDb(db => {
    const config = configWith({ maxDmPerHour: 4 });
    for (let i = 0; i < 4; i += 1) {
      seedDelivery(db, { planId: `plan_${i}`, index: 0, scope: OWNER_SCOPE, at: NOW - 60_000 * (i + 1) + 60_000 * (i * 0) , assetId: `ast_${i}00000000` });
    }
    // 四条都在同一小时内（NOW 往前 1–4 分钟）。
    const result = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.95, 'ast_new00000'), now: NOW });
    assert.equal(result.send, false);
    assert.equal(result.reasonCode, 'abstain-hourly-quota');
    assert.equal(result.quota.used, 4);
    assert.equal(result.quota.limit, 4);
  });
});

test('群 2 张/小时（比私聊严）：第 3 张 abstain-hourly-quota', () => {
  withDb(db => {
    const config = configWith();
    seedDelivery(db, { planId: 'plan_g0', scope: GROUP_SCOPE, at: NOW - 120_000, assetId: 'ast_a00000000' });
    seedDelivery(db, { planId: 'plan_g1', scope: GROUP_SCOPE, at: NOW - 700_000, assetId: 'ast_b00000000' });
    const result = decide({ db, config, target: { kind: 'group', id: 90001 }, scope: GROUP_SCOPE, candidates: candidates(0.95, 'ast_new00000'), now: NOW });
    assert.equal(result.reasonCode, 'abstain-hourly-quota');
    assert.equal(result.quota.used, 2);
    assert.equal(result.quota.limit, 2);
  });
});

test('quotas 表里的在途预留也算已用：两套计数取较大者，宁可不发', () => {
  withDb(db => {
    const config = configWith();
    const bucket = quotaBucketFor({ kind: 'dm', id: 10001, scope: OWNER_SCOPE });
    assert.equal(bucket, OWNER_SCOPE, '配额桶就是会话作用域（一个私聊一个桶）');
    db.run('INSERT INTO quotas (bucket, slot, used) VALUES (?, ?, ?)', [bucket, 'h472222', 4]);
    const now = 472222 * 3_600_000 + 1000;
    const result = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.95, 'ast_new00000'), now });
    assert.equal(result.reasonCode, 'abstain-hourly-quota');
    assert.equal(result.quota.reserved, 4);
    const state = quotaState({ db, bucketKey: bucket, kind: 'dm', limits: limitsFrom(config), now });
    assert.equal(state.hourlyFull, true);
  });
});

test('同图 48h（私聊）不重复，168h（群）不重复', () => {
  withDb(db => {
    const config = configWith();
    const same = 'ast_abc123456';
    seedDelivery(db, { planId: 'plan_x', scope: OWNER_SCOPE, at: NOW - 10 * 3_600_000, assetId: same });
    const dmResult = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.95, same), now: NOW - 10 * 3_600_000 + 600_000 });
    assert.equal(dmResult.reasonCode, 'text-only-no-candidate', '10 小时前发过的同一张图仍被 48h 窗口挡掉');

    const repeatDm = repeatedAsset({ db, bucketKey: OWNER_SCOPE, assetId: same, kind: 'dm', limits: limitsFrom(config), now: NOW });
    assert.equal(repeatDm.repeated, true);
    assert.equal(repeatDm.hours, 48);
    const repeatDmAfter = repeatedAsset({ db, bucketKey: OWNER_SCOPE, assetId: same, kind: 'dm', limits: limitsFrom(config), now: NOW + 49 * 3_600_000 });
    assert.equal(repeatDmAfter.repeated, false, '48 小时之后可以再发');

    // 群聊：同样是 24 小时前发过，群窗口 168h 内不允许；私聊的 48h 窗口则已过期。
    seedDelivery(db, { planId: 'plan_y', scope: GROUP_SCOPE, at: NOW - 24 * 3_600_000, assetId: same });
    const repeatGroup = repeatedAsset({ db, bucketKey: GROUP_SCOPE, assetId: same, kind: 'group', limits: limitsFrom(config), now: NOW });
    assert.equal(repeatGroup.repeated, true);
    assert.equal(repeatGroup.hours, 168);
    const groupResult = decide({ db, config: configWith({ groupCooldownSeconds: 0 }), target: { kind: 'group', id: 90001 }, scope: GROUP_SCOPE, candidates: candidates(0.95, same), now: NOW });
    assert.equal(groupResult.reasonCode, 'text-only-no-candidate');
  });
});

test('没有高分素材 → text_only；abstain 是正常结果（ok:true）', () => {
  withDb(db => {
    const config = configWith();
    const low = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.5), now: NOW });
    assert.equal(low.send, false);
    assert.equal(low.mode, 'text_only');
    assert.equal(low.reasonCode, 'text-only-low-fit');
    assert.equal(low.ok, true);

    const none = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: [], now: NOW });
    assert.equal(none.reasonCode, 'text-only-no-candidate');
    assert.equal(none.ok, true);
  });
});

test('minFitScore 来自 config.retrieval：0.85 的候选在 0.9 门槛下不够贴切', () => {
  withDb(db => {
    const config = { ...configWith(), retrieval: { ...DEFAULT_CONFIG.retrieval, minFitScore: 0.9 } };
    const result = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.85), now: NOW });
    assert.equal(result.reasonCode, 'text-only-low-fit');
    assert.ok(Math.abs(result.fitScore - 0.85) < 1e-9);
  });
});

test('reject 过的图在决策层就被过滤（feedback 抑制与决策联动）', () => {
  withDb(db => {
    const config = configWith();
    const feedback = createFeedback({ db, config, now: () => NOW });
    feedback.record({ action: 'reject', assetId: 'ast_bad00000', scope: OWNER_SCOPE, note: '别发这张' });
    const result = decide({ db, config, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: candidates(0.95, 'ast_bad00000'), now: NOW });
    assert.equal(result.send, false);
    assert.equal(result.reasonCode, 'text-only-no-candidate', '被 reject 的图不再出现在候选里');
  });
});

test('参数不全也不抛：db 缺失时返回结构化 abstain', () => {
  const result = decide({ db: null, config: configWith(), target: { kind: 'dm', id: 1 }, scope: OWNER_SCOPE, candidates: candidates(), now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.send, false);
  assert.equal(result.reasonCode, 'abstain-module-off');
});

/* ───────── 检索（§6.2）：硬门 → 召回 → 加权重排，同一个文件里连着决策测 ───────── */

test('检索硬门：作用域 / 审核态 / 格式 / 用户禁用词四道都在打分之前', () => {
  const base = { moderationState: 'approved', kind: 'png', createdAt: NOW, card: { literal: '', intents: [], scenes: [], avoidWhen: [] } };
  const cases = [
    [{ ...base, visibility: [] }, 'scope-not-visible'],
    [{ ...base, visibility: [{ scope: PEER_SCOPE, approval: 'approved' }] }, 'scope-not-visible'],
    [{ ...base, visibility: [{ scope: OWNER_SCOPE, approval: 'review' }] }, 'asset-not-approved'],
    [{ ...base, visibility: [{ scope: OWNER_SCOPE, approval: 'quarantined' }] }, 'asset-quarantined'],
    [{ ...base, visibility: [{ scope: OWNER_SCOPE, approval: 'revoked' }] }, 'asset-not-approved'],
    [{ ...base, visibility: [{ scope: OWNER_SCOPE, approval: 'approved' }], kind: 'bmp' }, 'kind-not-sendable'],
    [{ ...base, visibility: [{ scope: OWNER_SCOPE, approval: 'approved' }], moderationState: 'disabled' }, 'asset-disabled'],
  ];
  for (const [candidate, expected] of cases) {
    const gate = hardGate({ candidate, usable: [OWNER_SCOPE] });
    assert.equal(gate.ok, false, expected);
    assert.equal(gate.reasonCode, expected);
  }
  const words = hardGate({
    candidate: { ...base, visibility: [{ scope: OWNER_SCOPE, approval: 'approved' }], card: { literal: '阴阳怪气猫' } },
    usable: [OWNER_SCOPE], disabledTerms: ['阴阳怪气'],
  });
  assert.equal(words.reasonCode, 'user-disabled-term', '用户禁用词是硬门，不是扣分');
  assert.deepEqual([...SENDABLE_KINDS], ['png', 'jpeg', 'gif', 'webp']);
});

test('加权重排：权重表与文档一致；贴切的高、风险与重复被罚', () => {
  assert.deepEqual({ ...WEIGHTS }, { semantic: 0.3, intent: 0.2, tone: 0.15, context: 0.1, feedback: 0.1, persona: 0.1, freshness: 0.05 });
  const candidate = {
    assetId: 'ast_abc123456', moderationState: 'approved', kind: 'png', createdAt: NOW,
    card: { literal: '猫猫大笑', ocr: '', intents: ['amusement'], tone: ['轻松'], scenes: ['玩笑'], avoidWhen: [], aggression: 0 },
  };
  const fit = scoreCandidate({ candidate, context: { query: '猫猫大笑', intents: ['amusement'], tone: ['轻松'], scenes: ['玩笑'] }, now: NOW });
  const far = scoreCandidate({ candidate, context: { query: '严肃的技术问题', intents: ['serious'], scenes: ['求助'] }, now: NOW });
  assert.ok(fit.fitScore > far.fitScore, `贴切应更高：${fit.fitScore} vs ${far.fitScore}`);
  assert.ok(scoreCandidate({ candidate: { ...candidate, card: { ...candidate.card, avoidWhen: ['serious-help'] } }, context: { riskTags: ['serious-help'] }, now: NOW }).penalties.scene > 0);
  assert.ok(scoreCandidate({ candidate, context: {}, now: NOW, repeated: true }).fitScore < fit.fitScore, '重复要扣分');
});

test('retrieve 只回 3–5 个窄结构：没有路径、没有字节、没有 URL', () => {
  const visibility = [{ scope: OWNER_SCOPE, approval: 'approved' }];
  const library = {
    candidates: () => Array.from({ length: 9 }, (_, i) => ({
      assetId: `ast_${i}0000000`, moderationState: 'approved', kind: 'png', createdAt: NOW - i * 1000,
      visibility, card: { literal: `猫猫场景${i}`, intents: ['amusement'], avoidWhen: ['serious-help'] },
    })),
  };
  const found = retrieve({ library, usable: [OWNER_SCOPE], scope: OWNER_SCOPE, context: { query: '猫猫场景3' }, now: NOW, limit: 5 });
  assert.equal(found.ok, true);
  assert.ok(found.candidates.length >= 3 && found.candidates.length <= 5, `候选数 3–5，实际 ${found.candidates.length}`);
  for (const row of found.candidates) {
    assert.deepEqual(Object.keys(row).sort(), ['assetId', 'avoidWhen', 'fitScore', 'intents', 'summary']);
    assert.ok(!JSON.stringify(row).includes('/'), '候选里不该有路径');
  }
  assert.equal(retrieve({ library: { candidates: () => [] }, usable: [OWNER_SCOPE], scope: OWNER_SCOPE, context: { query: 'x' }, now: NOW }).reasonCode, 'no-candidates');
  assert.equal(retrieve({ library: null, usable: [OWNER_SCOPE], scope: OWNER_SCOPE, context: {} }).reasonCode, 'library-unavailable');
});

test('retrieval 与 task-1 的 library.mjs 对齐：fromLibrary 适配器 + 检索到决策整条链', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ret-'));
  const db = openExpressionDb({ file: ':memory:' });
  try {
    const library = createLibrary({ db, assetsDir: path.join(dir, 'assets'), now: () => NOW });
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(48, 3)]);
    const received = library.receive({ bytes, format: { kind: 'png', mime: 'image/png', ext: '.png' }, moderationState: 'approved' });
    library.register({ assetId: received.assetId, sources: [{ originScope: OWNER_SCOPE }], visibility: [{ scope: OWNER_SCOPE, approval: 'approved' }] });
    library.upsertCard(received.assetId, { literal: '猫猫大笑', intents: ['amusement'], scenes: ['玩笑'] });
    const found = {
      ...retrieve({
        library: fromLibrary(library), usable: [OWNER_SCOPE], scope: OWNER_SCOPE,
        context: { query: '猫猫', intents: ['amusement'], scenes: ['玩笑'] }, now: NOW,
        feedbackScore: () => 0.5, isSuppressed: () => false,
      }),
    };
    assert.equal(found.ok, true);
    assert.equal(found.candidates[0].assetId, received.assetId, '真实图库能召回刚入库的那张');
    assert.ok(!JSON.stringify(found.candidates).includes(dir), '适配器不把图库路径带进候选');
    const decision = decide({ db, config: configWith(), target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE, candidates: found.candidates, now: NOW });
    // 贴切命中：检索 → 决策整条链给出「可以发这一张」，assetId 与刚入库的一致。
    assert.equal(decision.send, true, `命中应变 send，实际 ${decision.reasonCode}`);
    assert.equal(decision.assetId, received.assetId);
    assert.equal(decision.mode, 'text_then_sticker');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('跨作用域：别人私聊的图进不了本会话候选（可见性是硬门）', () => {
  const library = {
    candidates: () => [{
      assetId: 'ast_peer000000', moderationState: 'approved', kind: 'png', createdAt: NOW,
      visibility: [{ scope: PEER_SCOPE, approval: 'approved' }], card: { literal: '别人的图' },
    }],
  };
  const found = retrieve({ library, usable: [OWNER_SCOPE], scope: OWNER_SCOPE, context: { query: '别人' }, now: NOW });
  assert.equal(found.candidates.length, 0);
  assert.equal(found.filtered.scope, 1);
});
