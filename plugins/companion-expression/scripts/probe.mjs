/**
 * 检索链路的集成探针：用 fixture（合成素材，50 张 / 45 张可用）在内存库里跑真实
 * `createLibrary` + `fromLibrary` + `retrieve` + `decide`，打印每个阶段的数字与排名。
 *
 * 它不是测试（测试见 `test/retrieval-fit.test.mjs`），是**同一份素材上的可复现证据**：
 * `node scripts/probe.mjs`，可选 `--json` / `--limit=N` / `--threshold=X`。
 *
 * 只读：`:memory:` 数据库、临时 assets 目录、固定时钟。不碰 `data/`、不联网、不发图。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openExpressionDb } from '../src/db.mjs';
import { createLibrary } from '../src/library.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { privateScope } from '../src/scopes.mjs';
import { contextFromDraft, fromLibrary, retrieve, scoreCandidate, SENDABLE_KINDS } from '../src/retrieval.mjs';
import { decide } from '../src/decision.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.resolve(HERE, '..', 'test', 'fixtures', 'sticker-corpus.json');
const SALT = 'probe-salt-0123456789';
const OWNER_CHAT = 10001;
const PEER_CHAT = 20002;
const OTHER_CHAT = 30003;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 7)]);

export function asOptions(argv = []) {
  const out = { json: false, limit: 5, threshold: 0.5 };
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg.startsWith('--limit=')) out.limit = Math.max(1, Math.min(10, Number(arg.slice(8)) || 5));
    else if (arg.startsWith('--threshold=')) out.threshold = Number(arg.slice(12));
  }
  return out;
}

/** fixture → 内存图库（与测试同一份构造逻辑，避免「探针跑的和测试跑的不是一件事」）。 */
export function seedFixture(fixture, db, assetsDir, now) {
  const library = createLibrary({ db, assetsDir, now: () => now });
  const owner = privateScope({ kind: 'owner_private', chatId: OWNER_CHAT, salt: SALT });
  const peer = privateScope({ kind: 'peer_private', chatId: PEER_CHAT, salt: SALT });
  const other = privateScope({ kind: 'owner_private', chatId: OTHER_CHAT, salt: SALT });
  const scopeFor = visibility => (
    visibility === 'other-scope' ? peer
      : (visibility === 'review' || visibility === 'quarantined' ? other : owner)
  );
  const approvalFor = visibility => (
    visibility === 'review' ? 'review' : (visibility === 'quarantined' ? 'quarantined' : 'approved')
  );
  const keyById = new Map();
  for (const asset of fixture.assets) {
    const bytes = Buffer.concat([PNG, Buffer.from(`${asset.key}|${asset.createdAtOffsetMs ?? 0}`)]);
    const received = library.receive({
      bytes,
      format: { ext: `.${asset.kind ?? 'png'}`, kind: asset.kind ?? 'png', mime: 'image/png' },
      moderationState: asset.moderationState ?? 'approved',
    });
    library.register({
      assetId: received.assetId,
      sources: [{ originScope: scopeFor(asset.visibility) }],
      visibility: [{ scope: scopeFor(asset.visibility), approval: approvalFor(asset.visibility) }],
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

function productionConfig(minFitScore) {
  return {
    ...DEFAULT_CONFIG,
    delivery: { ...DEFAULT_CONFIG.delivery, enabled: true },
    retrieval: { ...DEFAULT_CONFIG.retrieval, minFitScore },
  };
}

function main() {
  const options = asOptions(process.argv.slice(2));
  if (!fs.existsSync(FIXTURE)) {
    console.error(`missing fixture: ${FIXTURE}`);
    process.exitCode = 1;
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const now = Number(fixture.now);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-probe-'));
  const db = openExpressionDb({ file: ':memory:' });
  try {
    const seeded = seedFixture(fixture, db, path.join(dir, 'assets'), now);
    const { library, owner, keyById } = seeded;
    const adapter = fromLibrary(library);
    const report = {
      fixture: FIXTURE, now, sendableKinds: [...SENDABLE_KINDS],
      queries: [], filterBuckets: {}, neverReturned: [],
    };

    // 阶段数字：14:38 那次真实调用的原话。
    const context = contextFromDraft(PROD_QUERY);
    const found = retrieve({
      library: adapter, usable: [owner], scope: owner, context, limit: 3, minFitScore: 0, now,
    });
    report.action = {
      query: PROD_QUERY,
      normalized: found.diagnostics.normalized,
      recall: found.diagnostics.recall,
      filtered: found.filtered,
      candidates: found.candidates.map(row => ({ key: keyById.get(row.assetId), ...row })),
      reasonCodeAt05: decide({
        db, config: productionConfig(options.threshold), target: { kind: 'dm', id: OWNER_CHAT }, scope: owner,
        candidates: found.candidates, now,
      }).reasonCode,
      reasonCodeAt072: decide({
        db, config: productionConfig(DEFAULT_CONFIG.retrieval.minFitScore), target: { kind: 'dm', id: OWNER_CHAT }, scope: owner,
        candidates: found.candidates, now,
      }).reasonCode,
    };
    for (const query of fixture.queries) {
      const draft = contextFromDraft(query.query);
      const result = retrieve({
        library: adapter, usable: [owner], scope: owner, context: draft, limit: options.limit, minFitScore: 0, now,
      });
      const decision = decide({
        db, config: productionConfig(options.threshold), target: { kind: 'dm', id: OWNER_CHAT }, scope: owner,
        candidates: result.candidates, draft: query.query, now,
      });
      const ranked = result.candidates.map(row => ({ key: keyById.get(row.assetId), fitScore: row.fitScore, summary: row.summary }));
      const positionOf = key => {
        const index = ranked.findIndex(row => row.key === key);
        return index < 0 ? null : index + 1;
      };
      const preferredPositions = (query.expectPreferred ?? []).map(key => ({ key, position: positionOf(key) }));
      const avoidPositions = (query.expectAvoid ?? []).map(key => ({ key, position: positionOf(key) }));
      const bestPreferred = preferredPositions.filter(row => row.position !== null).map(row => row.position);
      const bestAvoid = avoidPositions.filter(row => row.position !== null).map(row => row.position);
      // 禁忌用例（`expectAvoidAll` 或 expectAvoid 列满全部素材）表达的是「一张都不许发」：
      // 由 decision 的硬门 abstain 证明，不是要求检索阶段返回空列表（检索只给候选，决策才发不发）。
      const avoidAll = query.expectAvoidAll === true
        || (query.expectPreferred ?? []).length === 0 && (query.expectAvoid ?? []).length >= fixture.assets.length;
      const contractOk = avoidAll
        ? (decision.send === false)
        : bestPreferred.length === 0
          ? bestAvoid.length === 0
          : (bestAvoid.length === 0 || Math.min(...bestPreferred) < Math.min(...bestAvoid));
      report.queries.push({
        query: query.query,
        taskLabeled: query.taskLabeled === true,
        decision: {
          send: decision.send,
          reasonCode: decision.reasonCode,
          assetId: decision.assetId ? keyById.get(decision.assetId) : null,
          fitScore: decision.fitScore,
        },
        preferred: preferredPositions,
        avoid: avoidPositions,
        contractOk,
        top: ranked,
      });
      for (const [bucket, count] of Object.entries(result.filtered)) {
        report.filterBuckets[bucket] = Number(report.filterBuckets[bucket] ?? 0) + count;
      }
    }

    // 「一张都不许返回」的素材：走任何查询都不该出现。
    const allReturned = new Set();
    for (const query of fixture.queries) {
      const result = retrieve({
        library: adapter, usable: [owner], scope: owner, context: contextFromDraft(query.query), limit: 5, minFitScore: 0, now,
      });
      for (const row of result.candidates) allReturned.add(keyById.get(row.assetId));
    }
    report.neverReturned = (fixture.expectations?.neverReturned ?? []).map(key => ({ key, returned: allReturned.has(key) }));

    // 反事实：把 45 张可用素材全部直接打分——用来区分「素材没有」与「素材有但没被召回/被压分」。
    const fullPool = [];
    for (const [assetId, key] of keyById.entries()) {
      const asset = fixture.assets.find(row => row.key === key);
      if (!(asset.moderationState === 'approved' && asset.visibility === 'current')) continue;
      if (!SENDABLE_KINDS.includes(String(asset.kind ?? 'png'))) continue;
      const record = library.getAsset(assetId);
      if (!record) continue;
      const scored = scoreCandidate({ candidate: record, context, now });
      fullPool.push({ key, fitScore: Number(scored.fitScore.toFixed(4)), incompatible: scored.incompatible });
    }
    fullPool.sort((a, b) => b.fitScore - a.fitScore || a.key.localeCompare(b.key));
    report.fullPoolTop = fullPool.slice(0, 10);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      const leaked = report.neverReturned.filter(row => row.returned).length;
      const failed = report.queries.filter(row => !row.contractOk).length + leaked;
      if (failed > 0) process.exitCode = 1;
      return;
    }
    console.log(`fixture=${path.basename(FIXTURE)} now=${now} (fixed)`);
    console.log(`\n[14:38 query] ${report.action.query}`);
    console.log(`  normalized: ${JSON.stringify(report.action.normalized)}`);
    console.log(`  recall paths: ${JSON.stringify(report.action.recall.paths)} pool=${report.action.recall.merged}`);
    console.log(`  filtered: ${JSON.stringify(report.action.filtered)}`);
    for (const row of report.action.candidates) console.log(`  ${row.fitScore}  ${row.key}  ${row.summary}`);
    console.log(`  decision: 0.5 -> ${report.action.reasonCodeAt05}   0.72 -> ${report.action.reasonCodeAt072}`);
    console.log(`  counterfactual (full-pool top10): ${report.fullPoolTop.map(row => `${row.key}:${row.fitScore}${row.incompatible ? '✗' : ''}`).join(' ')}`);
    console.log('\n[labeled queries]');
    for (const row of report.queries) {
      console.log(`  ${row.contractOk ? 'OK  ' : 'FAIL'} ${row.query} -> ${row.decision.reasonCode}${row.decision.assetId ? ` (${row.decision.assetId})` : ''}`);
      console.log(`       top: ${row.top.map(item => `${item.key}:${item.fitScore}`).join(' ')}`);
      console.log(`       prefer: ${row.preferred.map(item => `${item.key}@${item.position ?? '-'}`).join(' ')} | avoid: ${row.avoid.slice(0, 6).map(item => `${item.key}@${item.position ?? '-'}`).join(' ')}${row.avoid.length > 6 ? ' ...' : ''}`);
    }
    console.log('\n[never-return]');
    for (const row of report.neverReturned) console.log(`  ${row.key}: ${row.returned ? 'LEAKED!' : 'not returned'}`);
    console.log(`\ncumulative filtered: ${JSON.stringify(report.filterBuckets)}`);
    const failed = report.queries.filter(row => !row.contractOk).length + report.neverReturned.filter(row => row.returned).length;
    console.log(failed === 0 ? '\nall good.' : `\n${failed} failing item(s).`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PROD_QUERY = '笑着答应、乖巧点头、轻松愉快';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
