/**
 * 优化前后对照：**同一份合成素材、同一个固定时间、同一组查询**，跑两套实现。
 *
 * 为什么这样做：任务书要求「优化前后相同测试集的候选排名、分数与误匹配对照」。真实生产库
 * 不能读、不能复制，所以对照建立在合成素材上（fixture 里 45 张可用 + 5 张不可返回，与生产
 * 私聊 45 张可用素材同规模）。
 *
 * 两套实现怎么跑：旧实现从 git 对象里取出（`git show <base>:plugins/companion-expression/src/*`），
 * 解到临时目录再 import —— 旧模块之间是相对 import，所以必须**一整套**取出来。这样旧实现的
 * 字节就是事故当时的字节，不是「凭记忆重写的近似版」。
 *
 * 用法：
 *   node scripts/compare.mjs                  # 打印对照表
 *   node scripts/compare.mjs --json           # 机器可读
 *   node scripts/compare.mjs --base=d20cf1a   # 指定旧实现提交
 *
 * 只读：`:memory:` 数据库 + 临时目录；不联网、不碰 data/、不发图。证据等级 offline-test。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { asOptions, FIXTURE } from './probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const BASE_COMMIT = 'd20cf1a';
/**
 * 旧实现要取的模块：**整个 `src/` 目录**。
 * 只取用到的那几个文件会导致相对 import 断链（例如 `db.mjs` 需要 `schema.mjs`）；
 * 旧实现是自洽的一整套，必须整套取出来才跑得起来。
 */
function oldModuleList(commit = BASE_COMMIT) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, 'plugins/companion-expression/src'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean).filter(rel => rel.endsWith('.mjs'));
  return out.map(rel => rel.replace('plugins/companion-expression/', ''));
}
const PROD_QUERY = '笑着答应、乖巧点头、轻松愉快';
const SALT = 'compare-salt-0123456789';
const OWNER_CHAT = 10001;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 7)]);

function gitShow(commit, relPath) {
  return execFileSync('git', ['show', `${commit}:plugins/companion-expression/${relPath}`], {
    cwd: REPO_ROOT, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  });
}

/** 取仓库内任意路径（用于 `companion-foundation/suite-paths.mjs` 这种跨模块依赖）。 */
function gitShowPath(commit, repoPath) {
  return execFileSync('git', ['show', `${commit}:${repoPath}`], {
    cwd: REPO_ROOT, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  });
}

/** 把旧实现整组取到临时目录（相对 import 才能在临时目录里解析）。 */
function materializeBase(commit = BASE_COMMIT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `exp-base-${commit}-`));
  // `src/paths.mjs` 会 `import '../../companion-foundation/suite-paths.mjs'`，所以临时目录里
  // 必须保持 `plugins/<模块>/<文件>` 的形状；只取 expression 自己的 src 会断链。
  for (const rel of oldModuleList(commit)) {
    const target = path.join(dir, 'plugins', 'companion-expression', rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, gitShow(commit, rel));
  }
  const suitePaths = gitShowPath(commit, 'plugins/companion-foundation/suite-paths.mjs');
  const target = path.join(dir, 'plugins', 'companion-foundation', 'suite-paths.mjs');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, suitePaths);
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ type: 'module', private: true })}\n`);
  return path.join(dir, 'plugins', 'companion-expression');
}

/** 从插件根目录 import 一套模块（旧实现与新实现用同一段代码，差别只在根目录）。 */
async function loadModules(root) {
  return {
    db: await import(pathToFileURL(path.join(root, 'src/db.mjs')).href),
    library: await import(pathToFileURL(path.join(root, 'src/library.mjs')).href),
    scopes: await import(pathToFileURL(path.join(root, 'src/scopes.mjs')).href),
    config: await import(pathToFileURL(path.join(root, 'src/config.mjs')).href),
    retrieval: await import(pathToFileURL(path.join(root, 'src/retrieval.mjs')).href),
    decision: await import(pathToFileURL(path.join(root, 'src/decision.mjs')).href),
  };
}

/** 合成素材入内存库：新旧实现共用同一段播种逻辑（差别只在各自模块的行为）。 */
function seedImpl(impl, fixture, now, assetsDir) {
  const db = impl.db.openExpressionDb({ file: ':memory:' });
  const library = impl.library.createLibrary({ db, assetsDir, now: () => now });
  const owner = impl.scopes.privateScope({ kind: 'owner_private', chatId: OWNER_CHAT, salt: SALT });
  const peer = impl.scopes.privateScope({ kind: 'peer_private', chatId: 20002, salt: SALT });
  const other = impl.scopes.privateScope({ kind: 'owner_private', chatId: 30003, salt: SALT });
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
      literal: asset.literal, ocr: '',
      intents: asset.intents ?? [], emotions: asset.emotions ?? [],
      tone: asset.tone ?? [], scenes: asset.scenes ?? [],
      avoidWhen: asset.avoidWhen ?? [], aggression: asset.aggression ?? 0,
    });
    keyById.set(received.assetId, asset.key);
  }
  // 新实现的标签列迁移是幂等的；旧实现没有这个方法（可选调用）。
  try { library.ensureLabelIndex?.(); } catch { /* 旧实现没有 */ }
  return { db, library, owner, keyById };
}

/**
 * 在给定的实现上跑一组查询。
 * @returns {{query, taskLabeled, expectPreferred, expectAvoid, derived, recall, filtered, ranked, positions, decisions}}
 */
function runSuite(impl, fixture, { now, thresholds, limit = 5, poolLimit = 60 }) {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-compare-assets-'));
  const { db, library, owner, keyById } = seedImpl(impl, fixture, now, assetsDir);
  try {
    const adapter = impl.retrieval.fromLibrary(library, { poolLimit });
    const results = [];
    for (const query of fixture.queries) {
      const context = impl.retrieval.contextFromDraft(query.query);
      const found = impl.retrieval.retrieve({
        library: adapter, usable: [owner], scope: owner, context,
        limit, minFitScore: 0, now, ...(poolLimit ? { poolLimit } : {}),
      });
      const decisions = {};
      for (const threshold of thresholds) {
        const config = {
          ...impl.config.DEFAULT_CONFIG,
          delivery: { ...impl.config.DEFAULT_CONFIG.delivery, enabled: true },
          retrieval: { ...impl.config.DEFAULT_CONFIG.retrieval, minFitScore: threshold },
        };
        const decision = impl.decision.decide({
          db, config, target: { kind: 'dm', id: OWNER_CHAT }, scope: owner,
          candidates: found.candidates, draft: query.query, now,
        });
        decisions[threshold] = {
          send: decision.send === true,
          reasonCode: String(decision.reasonCode ?? ''),
          cause: String(decision.cause ?? ''),
          fitScore: Number(decision.fitScore ?? 0),
          assetKey: decision.assetId ? keyById.get(String(decision.assetId)) ?? null : null,
          visibleCandidates: Array.isArray(decision.candidates) ? decision.candidates.length : null,
        };
      }
      const ranked = found.candidates.map(row => ({
        key: keyById.get(row.assetId), fitScore: row.fitScore, summary: row.summary,
      }));
      const lexicalHits = (() => {
        try { return library.search(query.query, { limit: 60 }).length } catch { return null }
      })();
      results.push({
        query: query.query,
        taskLabeled: query.taskLabeled === true,
        expectPreferred: query.expectPreferred ?? [],
        expectAvoid: query.expectAvoid ?? [],
        derived: {
          intents: context.intents ?? [], emotions: context.emotions ?? [],
          tone: context.tone ?? [], scenes: context.scenes ?? [], riskTags: context.riskTags ?? [],
        },
        recall: {
          lexicalHits,
          pool: found.diagnostics?.recall?.merged ?? found.matched ?? null,
          paths: found.diagnostics?.recall?.paths ?? null,
        },
        filtered: found.filtered ?? {},
        ranked,
        positions: {
          preferred: (query.expectPreferred ?? []).map(key => ({ key, position: ranked.findIndex(row => row.key === key) < 0 ? null : ranked.findIndex(row => row.key === key) + 1 })),
          avoid: (query.expectAvoid ?? []).map(key => ({ key, position: ranked.findIndex(row => row.key === key) < 0 ? null : ranked.findIndex(row => row.key === key) + 1 })),
        },
        decisions,
      });
    }
    return { results, stats: library.stats() };
  } finally {
    db.close();
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
}

function beforeAvoidInTop(ranked, expectAvoid, top = 3) {
  const avoid = new Set(expectAvoid);
  return ranked
    .map((row, index) => ({ key: row.key, rank: index + 1 }))
    .filter(row => avoid.has(row.key) && row.rank <= top);
}

function render(rows, beforeStats, afterStats, base, thresholds, fixture) {  const lines = [];
  lines.push(`base=${base} fixture=${path.basename(FIXTURE)} now=${fixture.now} (fixed) thresholds=${thresholds.join('/')}`);
  lines.push(`图库：before ${beforeStats.assets} 素材 / after ${afterStats.assets} 素材（同一份合成素材）`);
  for (const row of rows) {
    const fmt = list => list.map(item => `${item.key}:${Number(item.fitScore).toFixed(4)}`).join(' ') || '（空）';
    const fmtDecision = decision => (decision
      ? `${decision.reasonCode}${decision.cause ? `(${decision.cause})` : ''} fit=${Number(decision.fitScore).toFixed(4)} key=${decision.assetKey ?? '-'}`
      : '-');
    lines.push('');
    lines.push(`${row.query}${row.taskLabeled ? '' : '（附加查询）'}`);
    lines.push(`  before 词面命中=${String(row.before.recall.lexicalHits)} 候选池=${String(row.before.recall.pool)}`);
    lines.push(`  after  召回路=${JSON.stringify(row.after.recall.paths)} 候选池=${String(row.after.recall.pool)}`);
    lines.push(`  before top: ${fmt(row.before.ranked.slice(0, 5))}`);
    lines.push(`  after  top: ${fmt(row.after.ranked.slice(0, 5))}`);
    lines.push(`  before @0.5:  ${fmtDecision(row.before.decisions[thresholds[0]])}`);
    lines.push(`  after  @0.5:  ${fmtDecision(row.after.decisions[thresholds[0]])}`);
    lines.push(`  before @0.72: ${fmtDecision(row.before.decisions[0.72])}`);
    lines.push(`  after  @0.72: ${fmtDecision(row.after.decisions[0.72])}`);
    const bMis = beforeAvoidInTop(row.before.ranked, row.expectAvoid);
    lines.push(`  误匹配 before（反义/偏题进前 3）：${bMis.map(item => `${item.key}@${item.rank}`).join(' ') || '无'}`);
    lines.push(`  误匹配 after （反义/偏题进前 3）：${beforeAvoidInTop(row.after.ranked, row.expectAvoid).map(item => `${item.key}@${item.rank}`).join(' ') || '无'}`);
  }
  return lines.join('\n');
}

async function main() {
  const options = asOptions(process.argv.slice(2));
  const baseArg = process.argv.slice(2).find(arg => arg.startsWith('--base='));
  const base = baseArg ? baseArg.slice('--base='.length) : BASE_COMMIT;
  if (!fs.existsSync(FIXTURE)) {
    console.error(`missing fixture: ${FIXTURE}`);
    process.exitCode = 1;
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const thresholds = [options.threshold ?? 0.5, 0.72];
  const baseDir = materializeBase(base);
  let before;
  let after;
  try {
    before = runSuite(await loadModules(baseDir), fixture, { now: Number(fixture.now), thresholds, limit: options.limit });
    after = runSuite(await loadModules(PLUGIN_ROOT), fixture, { now: Number(fixture.now), thresholds, limit: options.limit });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
  const rows = before.results.map((row, index) => ({
    query: row.query, taskLabeled: row.taskLabeled, expectPreferred: row.expectPreferred,
    expectAvoid: row.expectAvoid, before: row, after: after.results[index],
  }));
  const report = {
    baseCommit: base, fixture: FIXTURE, now: fixture.now, evidenceLevel: 'offline-test',
    thresholds, before: before.results, after: after.results,
    beforeStats: before.stats, afterStats: after.stats,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  console.log(render(rows, before.stats, after.stats, base, thresholds, fixture));
  const prodRow = rows.find(row => row.query === PROD_QUERY);
  if (prodRow) {
    const b = prodRow.before.decisions[0.5];
    const a = prodRow.after.decisions[0.5];
    console.log(`\n[14:38 原查询] before=${b.reasonCode} after=${a.reasonCode}，`
      + ` before top=${prodRow.before.ranked.slice(0, 3).map(row => `${row.key}:${Number(row.fitScore).toFixed(4)}`).join(' ')}`
      + ` / after top=${prodRow.after.ranked.slice(0, 3).map(row => `${row.key}:${Number(row.fitScore).toFixed(4)}`).join(' ')}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { materializeBase, loadModules, runSuite, BASE_COMMIT, PROD_QUERY };
