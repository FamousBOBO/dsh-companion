/**
 * 检索链路在 fixture 语料（50 张合成素材 / 45 张可用 / 8 条标注查询）上的集成测试。
 *
 * 与 `scripts/probe.mjs` 使用**同一份构造逻辑与同一份素材**（`:memory:` 库、mkdtemp 素材目录、
 * 固定 `now = fixture.now`），因此测试里看到的排名与探针打印的排名可逐行对照。
 *
 * 守的是这几条产品级不变量（不是实现细节）：
 *   1. 可用池是 45 张（approved + current + SENDABLE_KINDS），raw approved+current 是 46；
 *   2. 召回必须多路（词面 / 标签 / 近义扩展 / 本会话补齐），池子 > 40，不整库扫描；
 *   3. 排序契约：标注查询里 `expectPreferred` 的每一张都要高于 `expectAvoid` 的每一张；
 *      反义素材（拒绝 vs 认同、大笑 vs 笑不出来）根本不许进候选；
 *   4. 硬门与纪律：c46–c50 永不返回；重复窗口/冷却/小时额度各自 abstain；
 *      池子为空时对外只有 `no-compatible-expression` 一个码；
 *   5. legacy 空卡（c04/c22）靠 literal 现算标签也能被召回；
 *   6. 门槛 0.5 与默认 0.72 的差异用**实测数字**记录在注释里。
 *
 * 数据库一律 `:memory:`，素材落 mkdtemp 临时目录，跑完删掉；绝不碰 data/ 下的真库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openExpressionDb } from '../src/db.mjs';
import { createLibrary } from '../src/library.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { privateScope } from '../src/scopes.mjs';
import {
  contextFromDraft, fromLibrary, retrieve, scoreCandidate, cardLabelsOf, SENDABLE_KINDS,
} from '../src/retrieval.mjs';
import { decide, DECISION_REASONS } from '../src/decision.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, 'fixtures', 'sticker-corpus.json');

/** 与 probe.mjs 相同的固定作用域盐；不同盐只改变哈希，不改变可见性关系。 */
const SALT = 'probe-salt-0123456789';
const OWNER_CHAT = 10001;
const PEER_CHAT = 20002;
const OTHER_CHAT = 30003;
const OWNER_TARGET = { kind: 'dm', id: OWNER_CHAT };
const PNG_HEADER = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 7)]);

/** 14:38 那次真实调用的原话（设计文档 §6.2 的事故复现用例）。 */
const PROD_QUERY = '笑着答应、乖巧点头、轻松愉快';
const TABOO_QUERY = '我很难受，怎么办';

/** 生产门槛 0.5（事故当时的配置）与默认门槛 0.72（config.mjs 的基线）。 */
const THRESHOLD_LOW = 0.5;
const THRESHOLD_DEFAULT = DEFAULT_CONFIG.retrieval.minFitScore;

const configAt = minFitScore => ({
  ...DEFAULT_CONFIG,
  delivery: { ...DEFAULT_CONFIG.delivery, enabled: true },
  retrieval: { ...DEFAULT_CONFIG.retrieval, minFitScore },
});

/** 按 fixture 的 visibility 约定造素材，与 probe.mjs / 任务书同一口径。 */
function scopeFor(visibility, { owner, peer, other }) {
  if (visibility === 'other-scope') return peer;
  if (visibility === 'review' || visibility === 'quarantined') return other;
  return owner;
}

function approvalFor(visibility) {
  if (visibility === 'review') return 'review';
  if (visibility === 'quarantined') return 'quarantined';
  return 'approved';
}

/** 把整个 fixture 灌进内存库；返回句柄、作用域与 assetId ↔ key 映射。 */
function seedFixture(fixture, db, assetsDir, now) {
  const library = createLibrary({ db, assetsDir, now: () => now });
  const owner = privateScope({ kind: 'owner_private', chatId: OWNER_CHAT, salt: SALT });
  const peer = privateScope({ kind: 'peer_private', chatId: PEER_CHAT, salt: SALT });
  const other = privateScope({ kind: 'owner_private', chatId: OTHER_CHAT, salt: SALT });
  const scopes = { owner, peer, other };
  const keyById = new Map();
  for (const asset of fixture.assets) {
    const bytes = Buffer.concat([PNG_HEADER, Buffer.from(`${asset.key}|${asset.createdAtOffsetMs ?? 0}`)]);
    const received = library.receive({
      bytes,
      format: { ext: `.${asset.kind ?? 'png'}`, kind: asset.kind ?? 'png', mime: 'image/png' },
      moderationState: asset.moderationState ?? 'approved',
    });
    const scope = scopeFor(asset.visibility, scopes);
    library.register({
      assetId: received.assetId,
      sources: [{ originScope: scope }],
      visibility: [{ scope, approval: approvalFor(asset.visibility) }],
    });
    library.upsertCard(received.assetId, {
      literal: asset.literal,
      ocr: '',
      intents: asset.intents ?? [],
      emotions: asset.emotions ?? [],
      tone: asset.tone ?? [],
      scenes: asset.scenes ?? [],
      avoidWhen: asset.avoidWhen ?? [],
      aggression: asset.aggression ?? 0,
    });
    keyById.set(received.assetId, asset.key);
  }
  return { library, owner, peer, other, keyById };
}

/**
 * 一套 fixture 库 + 临时目录。回调必须同步：`finally` 在回调返回后立刻关库。
 */
function withFixture(run) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const now = Number(fixture.now);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-fit-'));
  const db = openExpressionDb({ file: ':memory:' });
  try {
    const seeded = seedFixture(fixture, db, path.join(dir, 'assets'), now);
    return run({ fixture, now, dir, db, ...seeded, adapter: fromLibrary(seeded.library) });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const assetOf = (keyById, key) => [...keyById.entries()].find(([, value]) => value === key)?.[0] ?? null;
const keyOf = (keyById, assetId) => keyById.get(String(assetId)) ?? null;
const keysOf = (keyById, candidates) => candidates.map(row => keyOf(keyById, row.assetId));

/** fixture 里「可见且可发送」的定义，用于证明 45 / 46 这两个数字。 */
const isUsableAsset = asset => asset.moderationState === 'approved'
  && asset.visibility === 'current'
  && SENDABLE_KINDS.includes(String(asset.kind ?? 'png'));

function runRetrieve({ adapter, owner, now, query, options = {} }) {
  const { limit = 5, minFitScore = 0, poolLimit } = options;
  return retrieve({
    library: adapter, usable: [owner], scope: owner, context: contextFromDraft(query),
    limit, minFitScore, now, ...(poolLimit === undefined ? {} : { poolLimit }),
  });
}

test('可用池：45 张可发送（approved + current + SENDABLE_KINDS），raw approved+current 是 46', () => withFixture(({ fixture, keyById }) => {
  const usableKeys = fixture.assets.filter(isUsableAsset).map(asset => asset.key);
  const rawKeys = fixture.assets
    .filter(asset => asset.moderationState === 'approved' && asset.visibility === 'current')
    .map(asset => asset.key);
  assert.equal(usableKeys.length, 45, '可见且可发送的正好 45 张');
  assert.equal(rawKeys.length, 46, 'approved + current 的 raw 计数是 46（c50 是 bmp，不进可用池）');
  // 两者恰好差 c50 这一张 bmp。
  assert.deepEqual(rawKeys.filter(key => !usableKeys.includes(key)), ['c50']);
  assert.equal(keyById.size, 50, 'fixture 一共 50 张');
  for (const key of fixture.expectations.neverReturned) {
    assert.equal(usableKeys.includes(key), false, `${key} 不在可用池里`);
  }
}));

test('多路召回：14:38 查询的池子 > 40，四条召回路径都在，过滤桶按硬门原因分桶', () => withFixture(({ fixture, now, adapter, owner }) => {
  const found = runRetrieve({ adapter, owner, now, query: PROD_QUERY });
  const { recall, normalized } = found.diagnostics;
  assert.deepEqual(normalized.intents, ['agree'], '整句归一化出认同');
  assert.deepEqual(normalized.emotions, ['joy'], '整句归一化出开心');
  assert.deepEqual([...normalized.tone].sort(), ['cute', 'light'], '整句归一化出卖萌 + 轻松语气');

  // 池子是「四路合并」而不是「FTS 命中的那几张」：单靠词面只有 10 张。
  for (const pathName of ['lexical', 'label', 'expand', 'supplement']) {
    assert.ok(recall[pathName] > 0, `召回路径 ${pathName} 必须真的走到`);
    assert.ok(recall.paths[pathName] > 0, `召回统计里 ${pathName} 必须有计数`);
  }
  // 实测：lexical 10 / label 29 / expand 5 / supplement 46 / merged 49（池子上限 60）。
  assert.equal(recall.lexical, 10);
  assert.equal(recall.label, 29);
  assert.equal(recall.expand, 5);
  assert.equal(recall.supplement, 46);
  assert.equal(recall.merged, 49);
  assert.ok(recall.merged > 40, `池子应 > 40（实际 ${recall.merged}），才对得起「多路召回」`);
  // 合并池可以略多于 45：词面/标签路不按作用域收窄，所以 c47/c48/c49 也会被召回，
  // 再由硬门挡掉（见 filtered 的 scope/moderation 桶）。上限仍是 poolCap=60，不是整库。
  assert.ok(recall.merged <= 50, `池子不该超过 50（实际 ${recall.merged}）`);
  assert.ok(recall.merged <= recall.poolCap);

  // 14:38 这一条的过滤桶实测：scope 2 / kind 1 / moderation 1。
  assert.deepEqual(found.filtered, {
    scope: 2, kind: 1, moderation: 1, disabledTerm: 0, suppressed: 0, conflict: 14, belowMin: 0,
  });

  // 8 条标注查询累计：实测 scope 8 / kind 8 / moderation 3 / conflict 42。
  const totals = { scope: 0, kind: 0, moderation: 0, disabledTerm: 0, suppressed: 0, conflict: 0, belowMin: 0 };
  for (const query of fixture.queries) {
    const result = runRetrieve({ adapter, owner, now, query: query.query });
    for (const [bucket, count] of Object.entries(result.filtered)) totals[bucket] += Number(count ?? 0);
  }
  assert.deepEqual(totals, {
    scope: 8, kind: 8, moderation: 3, disabledTerm: 0, suppressed: 0, conflict: 42, belowMin: 0,
  });
  assert.ok(totals.scope >= 2 && totals.kind >= 1 && totals.moderation >= 2,
    '8 条查询里作用域/格式/审核态三道硬门都要有真实命中');
}));

test('排序契约：每条标注查询里 expectPreferred 都高于 expectAvoid；14:38 与禁忌查询的决策', () => withFixture(({ fixture, now, db, adapter, owner, library, keyById }) => {
  for (const query of fixture.queries) {
    const context = contextFromDraft(query.query);
    const found = runRetrieve({ adapter, owner, now, query: query.query });
    const decision05 = decide({
      db, config: configAt(THRESHOLD_LOW), target: OWNER_TARGET, scope: owner,
      candidates: found.candidates, draft: query.query, now,
    });
    const decision72 = decide({
      db, config: configAt(THRESHOLD_DEFAULT), target: OWNER_TARGET, scope: owner,
      candidates: found.candidates, draft: query.query, now,
    });
    // 决策只允许产生声明的原因码（旧对外码 text-only-* 不再出现）。
    for (const decision of [decision05, decision72]) {
      assert.ok(DECISION_REASONS.includes(decision.reasonCode), `${query.query}: 未知原因码 ${decision.reasonCode}`);
      assert.notEqual(decision.reasonCode, 'text-only-low-fit');
      assert.notEqual(decision.reasonCode, 'text-only-no-candidate');
    }

    if (query.query === TABOO_QUERY) {
      // 禁忌用例：检索阶段仍会给候选（检索只负责召回），但决策必须靠 serious-help 硬门 abstain。
      assert.deepEqual(query.expectPreferred, []);
      assert.equal(decision05.send, false, '禁忌语境不发图');
      assert.equal(decision05.reasonCode, 'abstain-serious-help');
      assert.equal(decision72.reasonCode, 'abstain-serious-help', '门槛不改变禁忌硬门');
      continue;
    }

    // 排序契约：在**整个可用池**上按同一 context 打分，每张 preferred 必须严格高于每张 avoid。
    // 用完整池而不是 top-5，避免把「没进窗口」误判成排序失败。
    const scoreByKey = new Map();
    for (const asset of fixture.assets.filter(isUsableAsset)) {
      const record = library.getAsset(assetOf(keyById, asset.key));
      const scored = scoreCandidate({ candidate: record, context, now });
      scoreByKey.set(asset.key, { fitScore: scored.fitScore, incompatible: scored.incompatible });
    }
    for (const preferredKey of query.expectPreferred) {
      for (const avoidKey of query.expectAvoid) {
        assert.ok(scoreByKey.get(preferredKey).fitScore > scoreByKey.get(avoidKey).fitScore,
          `${query.query}: ${preferredKey}(${scoreByKey.get(preferredKey).fitScore}) 必须高于 ${avoidKey}(${scoreByKey.get(avoidKey).fitScore})`);
      }
    }

    // 返回的候选列表里位置也要对：出现在列表里的 avoid 不许排在 preferred 前面。
    const returnedKeys = keysOf(keyById, found.candidates);
    const preferredIndexes = query.expectPreferred.map(key => returnedKeys.indexOf(key)).filter(index => index >= 0);
    const avoidIndexes = query.expectAvoid.map(key => returnedKeys.indexOf(key)).filter(index => index >= 0);
    if (preferredIndexes.length > 0 && avoidIndexes.length > 0) {
      assert.ok(Math.min(...preferredIndexes) < Math.min(...avoidIndexes),
        `${query.query}: preferred 至少要排在 avoid 之前`);
    }
  }

  // 14:38：生产 0.5 必须发，而且发出去的是 preferred 里的那张。
  const prod = runRetrieve({ adapter, owner, now, query: PROD_QUERY, options: { limit: 3 } });
  const prodDecision = decide({
    db, config: configAt(THRESHOLD_LOW), target: OWNER_TARGET, scope: owner,
    candidates: prod.candidates, draft: PROD_QUERY, now,
  });
  assert.equal(prodDecision.send, true);
  assert.ok(prodDecision.fitScore >= THRESHOLD_LOW, `fitScore ${prodDecision.fitScore} 应 ≥ 0.5`);
  assert.ok(['c04', 'c01'].includes(keyOf(keyById, prodDecision.assetId)),
    `发出去的应是 preferred（c04/c01），实际 ${keyOf(keyById, prodDecision.assetId)}`);
  // 实测 top-3：c04 0.7204 / c01 0.6738 / c40 0.6533。
  assert.deepEqual(keysOf(keyById, prod.candidates), ['c04', 'c01', 'c40']);
  assert.ok(Math.abs(prod.candidates[0].fitScore - 0.7204) < 1e-2);
  assert.ok(Math.abs(prod.candidates[1].fitScore - 0.6738) < 1e-2);
  assert.ok(Math.abs(prod.candidates[2].fitScore - 0.6533) < 1e-2);
}));

test('永不返回：c46–c50 不进候选；review / quarantined 连打分都不进入', () => withFixture(({ fixture, now, adapter, owner, keyById }) => {
  const seenCandidates = new Set();
  const seenScored = new Set();
  for (const query of fixture.queries) {
    const found = runRetrieve({ adapter, owner, now, query: query.query });
    for (const row of found.candidates) seenCandidates.add(keyOf(keyById, row.assetId));
    for (const row of found.diagnostics.scored) seenScored.add(keyOf(keyById, row.assetId));
  }
  for (const key of fixture.expectations.neverReturned) {
    assert.equal(seenCandidates.has(key), false, `${key} 不许出现在候选里`);
  }
  // c47（review）与 c48（quarantined）在别的作用域，连 diagnostics.scored 都不该出现。
  assert.equal(seenScored.has('c47'), false, 'review 素材不进打分');
  assert.equal(seenScored.has('c48'), false, 'quarantined 素材不进打分');
  assert.equal(seenCandidates.has('c49'), false, 'disabled 素材不进候选');

  // 直接注入一张 review 的候选：硬门拦下，桶是 moderation，候选为空。
  const reviewCandidate = {
    assetId: 'ast_review000001', moderationState: 'review', kind: 'png', mime: 'image/png', createdAt: now,
    visibility: [{ scope: owner, approval: 'approved' }],
    card: { literal: '开心、笑死', intents: ['laugh'], emotions: ['joy'], tone: [], scenes: [], avoidWhen: [] },
  };
  const injected = retrieve({
    library: { candidates: () => [reviewCandidate] }, usable: [owner], scope: owner,
    context: contextFromDraft('哈哈哈'), limit: 5, minFitScore: 0, now,
  });
  assert.equal(injected.candidates.length, 0);
  assert.equal(injected.filtered.moderation, 1, 'review 是审核态硬门，不是扣分');
  assert.equal(injected.diagnostics.scored.some(row => row.assetId === 'ast_review000001'), false,
    '被硬门挡掉的素材不进打分诊断');
}));

test('反义素材不进候选：好的收到的拒绝卡、笑不出来的大笑卡', () => withFixture(({ now, adapter, owner, keyById }) => {
  // 好的收到 = agree/light；c24/c25 是 refuse/serious。它们与草稿没有共同汉字，
  // 只有冲突约束能挡住——这正是这条用例要证明的东西。
  const good = runRetrieve({ adapter, owner, now, query: '好的收到' });
  const goodScores = good.diagnostics.scored.map(row => ({ key: keyOf(keyById, row.assetId), ...row }));
  for (const key of ['c24', 'c25']) {
    assert.equal(keysOf(keyById, good.candidates).includes(key), false, `${key} 不许进候选`);
    const scored = goodScores.find(row => row.key === key);
    assert.ok(scored, `${key} 确实被召回了（不是没召回到）`);
    assert.equal(scored.bucket, 'conflict', `${key} 应被「相反表达」过滤桶挡掉`);
    assert.equal(scored.reasonCode, 'conflict-opposite');
  }
  // 实测：好的收到 top-5 全是 0.7005（c34/c01/c02/c03/c04），c24/c25 的 fitScore 是 0（incompatible）。
  assert.deepEqual(keysOf(keyById, good.candidates), ['c34', 'c01', 'c02', 'c03', 'c04']);

  // 笑不出来 = resignation/sadness；c07/c08 是 laugh/joy。
  const sad = runRetrieve({ adapter, owner, now, query: '笑不出来，心里有点难过' });
  const sadScores = sad.diagnostics.scored.map(row => ({ key: keyOf(keyById, row.assetId), ...row }));
  for (const key of ['c07', 'c08']) {
    assert.equal(keysOf(keyById, sad.candidates).includes(key), false, `${key} 不许进候选`);
    const scored = sadScores.find(row => row.key === key);
    assert.ok(scored);
    assert.equal(scored.bucket, 'conflict');
  }
  // 实测：笑不出来的第一名是 c26（0.5213），与草稿同为低落。
  assert.equal(keyOf(keyById, sad.candidates[0].assetId), 'c26');
}));

test('legacy 空卡的标签从 literal 现算：c04 进候选，c22 有 awkward 且被压低', () => withFixture(({ fixture, now, library, adapter, owner, keyById }) => {
  const legacy = fixture.expectations.legacyEmptyCards;
  assert.deepEqual(legacy, ['c04', 'c22'], 'fixture 声明了两张结构化字段全空的 legacy 卡');
  const c04 = library.getAsset(assetOf(keyById, 'c04'));
  const c22 = library.getAsset(assetOf(keyById, 'c22'));
  for (const record of [c04, c22]) {
    assert.deepEqual(record.card.intents, [], 'legacy 卡结构字段是空的');
    assert.deepEqual(record.card.emotions, []);
    assert.deepEqual(record.card.tone, []);
    assert.deepEqual(record.card.scenes, []);
  }

  // 现算标签与结构化字段取并集：c04 的「好呀、点头、收到、开心、轻松愉快」派生 agree/joy/light。
  const derived04 = cardLabelsOf(c04.card);
  for (const label of ['agree', 'joy', 'light']) {
    assert.ok(derived04.labels.includes(label), `c04 派生标签应含 ${label}`);
  }
  // c22 的「尴尬、汗颜、挠头、社死」派生 awkward。
  const derived22 = cardLabelsOf(c22.card);
  assert.ok(derived22.emotions.includes('awkward'), 'c22 派生标签必须含 awkward');

  const found = runRetrieve({ adapter, owner, now, query: PROD_QUERY });
  const scored = found.diagnostics.scored.map(row => ({ key: keyOf(keyById, row.assetId), ...row }));
  assert.equal(keyOf(keyById, found.candidates[0].assetId), 'c04', 'c04 完全靠 literal 现算命中拿第一');
  const c22row = scored.find(row => row.key === 'c22');
  assert.ok(c22row, 'c22 必须被召回并打分（不是不可见）');
  // 实测 c22 = 0.1359，且没有冲突（它是「偏题」而不是「相反」），远低于 c04 的 0.7204。
  assert.ok(Math.abs(c22row.fitScore - 0.1359) < 1e-2, `c22 实测 0.1359，实际 ${c22row.fitScore}`);
  assert.deepEqual(c22row.conflicts, [], 'c22 是低分偏题，不是相反表达');
  assert.ok(c22row.fitScore < 0.25 && 0.7204 - c22row.fitScore > 0.5, 'c22 要显著低于真正的 preferred');
}));

test('门槛行为：c04 两端都发，c01 只在 0.5 发；好的收到在 0.72 全是 no-compatible-expression', () => withFixture(({ now, db, adapter, owner, keyById }) => {
  const found = runRetrieve({ adapter, owner, now, query: PROD_QUERY, options: { limit: 3 } });
  const only = key => found.candidates.filter(row => keyOf(keyById, row.assetId) === key);
  for (const [key, expectedAt072] of [['c04', true], ['c01', false]]) {
    const candidate = only(key);
    assert.equal(candidate.length, 1, `${key} 在 14:38 的 top-3 里`);
    // 实测：c04 = 0.7204（≥ 0.72，两端都 send）；c01 = 0.6738（< 0.72，0.72 下不发）。
    const decision05 = decide({
      db, config: configAt(THRESHOLD_LOW), target: OWNER_TARGET, scope: owner, candidates: candidate, now,
    });
    const decision72 = decide({
      db, config: configAt(THRESHOLD_DEFAULT), target: OWNER_TARGET, scope: owner, candidates: candidate, now,
    });
    assert.equal(decision05.send, true, `${key} 在 0.5 下应 send`);
    assert.ok(decision05.fitScore >= THRESHOLD_LOW);
    assert.equal(decision72.send, expectedAt072, `${key} 在 0.72 下的预期不符`);
    if (expectedAt072) {
      assert.ok(decision72.fitScore >= THRESHOLD_DEFAULT, `c04 实测 ${decision72.fitScore} ≥ 0.72`);
    } else {
      assert.equal(decision72.reasonCode, 'no-compatible-expression');
      assert.equal(decision72.cause, 'all-below-fit-threshold');
      assert.deepEqual(decision72.candidates, [], '不发的时候候选恒为空');
      assert.ok(decision72.fitScore < THRESHOLD_DEFAULT, `c01 实测 ${decision72.fitScore} < 0.72`);
    }
  }

  // 好的收到：5 张候选全是 0.7005（差一点），0.5 发、0.72 一律不发。
  const good = runRetrieve({ adapter, owner, now, query: '好的收到' });
  const good72 = decide({
    db, config: configAt(THRESHOLD_DEFAULT), target: OWNER_TARGET, scope: owner, candidates: good.candidates, now,
  });
  assert.equal(good72.send, false);
  assert.equal(good72.reasonCode, 'no-compatible-expression');
  assert.equal(good72.cause, 'all-below-fit-threshold');
  assert.deepEqual(good72.candidates, []);
  // 诊断如实记录：bestFitScore 0.7005 / threshold 0.72 / 被拒清单 5 张。
  assert.equal(good72.diagnostics.cause, 'all-below-fit-threshold');
  assert.ok(Math.abs(good72.diagnostics.bestFitScore - 0.7005) < 1e-2,
    `实测 bestFitScore 0.7005，实际 ${good72.diagnostics.bestFitScore}`);
  assert.equal(good72.diagnostics.threshold, THRESHOLD_DEFAULT);
  assert.equal(good72.diagnostics.rejected.length, 5);
  assert.equal(good72.diagnostics.shortlist, 5);
}));

test('纪律回归：重复窗口 / 冷却 / 小时额度 / 空池对外只有一个码', () => withFixture(({ now, db, adapter, owner, keyById }) => {
  const found = runRetrieve({ adapter, owner, now, query: PROD_QUERY });
  const top = found.candidates[0];
  assert.equal(keyOf(keyById, top.assetId), 'c04', '该用例的「已发过」素材必须是排名第一的那张（c04）');

  // 1) 重复窗口：48h 内发过同一张，且它是唯一候选 → repeat-window。
  db.run(
    `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, provider_message_id, reason_code, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['fit-repeat', 0, top.assetId, owner, 'confirmed', 'fit-repeat:0', 1, '', now - 3_600_000],
  );
  const repeated = decide({
    db, config: configAt(THRESHOLD_LOW), target: OWNER_TARGET, scope: owner, candidates: [top], now,
  });
  assert.equal(repeated.send, false, '刚发过的那张本轮不许再发');
  assert.equal(repeated.reasonCode, 'no-compatible-expression');
  assert.equal(repeated.cause, 'repeat-window');
  assert.deepEqual(repeated.candidates, []);
  assert.equal(repeated.diagnostics.repeatWindow, 1);
  db.run('DELETE FROM deliveries');

  // 2) 冷却：刚刚发过另一张 → abstain-cooldown（会话级事实，不是候选问题）。
  db.run(
    `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, provider_message_id, reason_code, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['fit-cool', 0, 'ast_cool00001', owner, 'confirmed', 'fit-cool:0', 2, '', now - 60_000],
  );
  const cooling = decide({
    db, config: configAt(THRESHOLD_LOW), target: OWNER_TARGET, scope: owner, candidates: found.candidates, now,
  });
  assert.equal(cooling.send, false);
  assert.equal(cooling.reasonCode, 'abstain-cooldown');
  assert.ok(cooling.quota.cooldownRemainingMs > 0);
  db.run('DELETE FROM deliveries');

  // 3) 小时额度：本小时已发 4 张（默认 maxDmPerHour=4）。
  for (let index = 0; index < 4; index += 1) {
    db.run(
      `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, provider_message_id, reason_code, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`fit-quota-${index}`, 0, `ast_quota${index}0001`, owner, 'confirmed', `fit-quota-${index}:0`, 3, '', now - 60_000 * (index + 1)],
    );
  }
  const quota = decide({
    db, config: configAt(THRESHOLD_LOW), target: OWNER_TARGET, scope: owner, candidates: found.candidates, now,
  });
  assert.equal(quota.send, false);
  assert.equal(quota.reasonCode, 'abstain-hourly-quota');
  assert.equal(quota.quota.used, 4);
  assert.equal(quota.quota.limit, DEFAULT_CONFIG.delivery.maxDmPerHour);
  db.run('DELETE FROM deliveries');

  // 4) 空池：对外只有 no-compatible-expression 一个码，且候选恒为空。
  const empty = decide({
    db, config: configAt(THRESHOLD_LOW), target: OWNER_TARGET, scope: owner, candidates: [], now,
  });
  assert.equal(empty.send, false);
  assert.equal(empty.reasonCode, 'no-compatible-expression');
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.cause, 'no-candidates-in-pool');
  assert.equal(JSON.stringify(empty).includes('text-only'), false, '空池结果里不该再出现 text-only-* 旧码');
  assert.equal(JSON.stringify(repeated).includes('text-only'), false);
  assert.equal(JSON.stringify(quota).includes('text-only'), false);
}));

test('poolLimit 有界：limit=10 时召回最多 10 行、listAssets 的 limit 也是 10，不整库扫描', () => withFixture(({ now, library, owner, adapter, keyById }) => {
  const listCalls = [];
  const spyLibrary = {
    ...library,
    listAssets: options => {
      listCalls.push(options);
      return library.listAssets(options);
    },
  };
  const bounded = fromLibrary(spyLibrary, { poolLimit: 10 });
  const context = contextFromDraft(PROD_QUERY);
  const recalled = bounded.recall({
    usable: [owner], lexical: PROD_QUERY, labels: context.labels, expansions: context.expansions, poolLimit: 10,
  });
  assert.ok(recalled.rows.length <= 10, `召回行数应 ≤ 10（实际 ${recalled.rows.length}）`);
  assert.equal(recalled.stats.merged, recalled.rows.length);
  assert.ok(recalled.rows.length < 45, '有界召回不该把可用池整库读完');
  for (const call of listCalls) {
    assert.equal(call.moderation, 'approved');
    assert.equal(call.limit, 10, `listAssets 的 limit 必须是 10，实际 ${call.limit}`);
  }

  // 完全不相关的查询：词面/标签/扩展都空，只剩补齐路，仍然只有 10 行。
  const unrelated = bounded.recall({ usable: [owner], lexical: '量子力学与表情包无关', labels: [], expansions: [], poolLimit: 10 });
  assert.equal(unrelated.rows.length, 10);
  assert.equal(unrelated.stats.merged, 10);
  assert.equal(unrelated.rows.filter(row => keyOf(keyById, row.assetId)).length, 10);

  // retrieve 自己的池子上限同样生效（内部 cap = max(limit*4, poolLimit)）。
  const found = runRetrieve({ adapter: bounded, owner, now, query: PROD_QUERY, options: { poolLimit: 10 } });
  assert.ok(found.diagnostics.recall.poolCap >= 10 && found.diagnostics.recall.poolCap <= 20);
  assert.ok(found.diagnostics.recall.merged <= found.diagnostics.recall.poolCap);
}));
