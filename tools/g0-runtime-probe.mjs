#!/usr/bin/env node
/**
 * G0 运行期事实探针（只读）。
 *
 * 三件事，全部只读、脱敏：
 *   1. runtime 值文件里与 P2 生活/活动/分享相关的表行数；
 *   2. `p2_activities` 的状态/种类分布与最近完成的活动（正文类字段截断，不带内容）；
 *   3. `home/bili-duty/p2-rounds/*` 的 round journal 终态与证据种类计数。
 *
 * 硬口径：
 *   * 只开 `readOnly` 连接，一个写语句都没有；
 *   * 不打印活动正文、不打印候选正文；`target`/`source_ref` 只截断到 60 字符；
 *   * 库不存在 / 表不存在 / 目录不存在 → 具名 code，不写 0 冒充"没有"。
 *
 * 用法：node tools/g0-runtime-probe.mjs [--db <path>] [--rounds <dir>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const argOf = name => {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] ?? '') : '';
};

const defaultDb = 'D:/DSH/dsh-production/data/home/companion/companion-runtime.db';
const defaultRounds = 'D:/DSH/dsh-production/data/home/bili-duty/p2-rounds';
const DB_FILE = argOf('--db') || process.env.DSH_COMPANION_RUNTIME_DB || defaultDb;
const ROUNDS_DIR = argOf('--rounds') || defaultRounds;

const INTEREST_TABLES = ['p2_activities', 'p2_activity_receipts', 'p2_plans', 'p2_plan_slots', 'p2_plan_runs',
  'p2_share_candidates', 'p2_budget_ledger', 'p2_interests', 'p2_opportunities'];

const clip = (value, max = 60) => {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function openReadOnly(file) {
  if (!fs.existsSync(file)) return { ok: false, code: 'db-missing', note: '库不存在（这台机器没跑过 runtime），不是"零候选"' };
  try {
    return { ok: true, handle: new DatabaseSync(file, { readOnly: true }) };
  } catch (error) {
    return { ok: false, code: 'db-unopenable', reason: clip(error instanceof Error ? error.message : String(error), 200) };
  }
}

function probeDatabase() {
  const opened = openReadOnly(DB_FILE);
  if (!opened.ok) return { ok: false, path: DB_FILE, ...opened };
  try {
    const handle = opened.handle;
    const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => String(row.name));
    const rowCounts = {};
    for (const table of INTEREST_TABLES) {
      if (!tables.includes(table)) { rowCounts[table] = 'absent'; continue; }
      try { rowCounts[table] = Number(handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0); }
      catch (error) { rowCounts[table] = `error: ${clip(error.message, 80)}`; }
    }

    const activityMix = tables.includes('p2_activities')
      ? handle.prepare('SELECT kind, status, reality, COUNT(*) AS n FROM p2_activities GROUP BY kind, status, reality ORDER BY n DESC').all()
        .map(row => ({ kind: String(row.kind), status: String(row.status), reality: String(row.reality), count: Number(row.n) }))
      : [];

    const receiptMix = tables.includes('p2_activity_receipts')
      ? handle.prepare('SELECT operation, COUNT(*) AS n FROM p2_activity_receipts GROUP BY operation ORDER BY n DESC').all()
        .map(row => ({ operation: String(row.operation), count: Number(row.n) }))
      : [];

    const bilibili = tables.includes('p2_activities')
      ? handle.prepare("SELECT activity_id, status, ended_at, checkpoint, consumed_prefix, total_units, artifact_ref, artifact_version FROM p2_activities WHERE kind = 'bilibili' ORDER BY ended_at DESC").all()
        .map(row => {
          let round = null;
          try { round = JSON.parse(String(row.checkpoint ?? '{}'))?.bilibiliRound ?? null; } catch { round = null; }
          return {
            activityId: clip(row.activity_id, 40),
            status: String(row.status),
            endedAt: Number(row.ended_at) || 0,
            roundStatus: round ? String(round.status ?? '') : '',
            watched: round ? Number(round.watched) || 0 : 0,
            evidenceKinds: round && Array.isArray(round.evidence)
              ? [...new Set(round.evidence.map(item => `${String(item.kind)}${item.method ? `:${item.method}` : ''}`))]
              : [],
            consumedPrefix: Number(row.consumed_prefix) || 0,
            artifactVersion: Number(row.artifact_version) || 0,
          };
        })
      : [];

    const shareCandidates = tables.includes('p2_share_candidates')
      ? { count: Number(handle.prepare('SELECT COUNT(*) AS n FROM p2_share_candidates').get()?.n ?? 0) }
      : { count: 'absent' };

    return { ok: true, path: DB_FILE, readOnly: true, rowCounts, activityMix, receiptMix, bilibili, shareCandidates };
  } catch (error) {
    return { ok: false, path: DB_FILE, code: 'query-failed', reason: clip(error.message, 200) };
  } finally {
    try { opened.handle.close(); } catch { /* already closed */ }
  }
}

function probeRounds() {
  if (!fs.existsSync(ROUNDS_DIR)) return { ok: false, code: 'rounds-missing', path: ROUNDS_DIR };
  const dirs = fs.readdirSync(ROUNDS_DIR);
  const rounds = [];
  let withEvidence = 0;
  for (const dir of dirs) {
    const journal = path.join(ROUNDS_DIR, dir, 'result.ndjson');
    if (!fs.existsSync(journal)) continue;
    // 写到一半被杀的进程会留下不完整的最后一行：只认完整记录。
    const complete = fs.readFileSync(journal, 'utf8').split('\n').slice(0, -1);
    const facts = complete.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const terminal = facts.find(fact => fact.terminal)?.terminal ?? 'unknown';
    const evidence = facts.filter(fact => !fact.terminal);
    if (evidence.length) withEvidence += 1;
    rounds.push({
      claim: clip(dir, 12),
      terminal: String(terminal),
      evidenceCount: evidence.length,
      kinds: [...new Set(evidence.map(item => `${String(item.kind)}${item.method ? `:${item.method}` : ''}`))],
      videoIds: [...new Set(evidence.filter(item => item.videoId).map(item => String(item.videoId)))].slice(0, 8),
    });
  }
  return { ok: true, path: ROUNDS_DIR, journals: rounds.length, withEvidence, rounds };
}

const report = {
  generatedAt: new Date().toISOString(),
  honesty: '只读探针。不采集活动/候选正文；不做任何写操作；缺失的库或表用具名 code 报告。',
  database: probeDatabase(),
  rounds: probeRounds(),
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [];
  const db = report.database;
  lines.push('=== runtime 值文件 ===');
  if (db.ok) {
    lines.push(`  路径：${db.path}（只读）`);
    for (const [table, count] of Object.entries(db.rowCounts)) lines.push(`  ${table.padEnd(24)} ${count}`);
    lines.push('  活动 kind/status/reality：');
    for (const row of db.activityMix) lines.push(`    ${row.kind}/${row.status}/${row.reality} = ${row.count}`);
    lines.push('  回执 operation：');
    for (const row of db.receiptMix) lines.push(`    ${row.operation} = ${row.count}`);
    lines.push(`  B站活动 ${db.bilibili.length} 条：`);
    for (const row of db.bilibili) lines.push(`    ${row.activityId} ${row.status} round=${row.roundStatus} watched=${row.watched} 证据=${row.evidenceKinds.join(',') || '—'}`);
    lines.push(`  分享候选：${JSON.stringify(db.shareCandidates)}`);
  } else {
    lines.push(`  未读到：${db.code}${db.reason ? ` — ${db.reason}` : ''}${db.note ? ` — ${db.note}` : ''}`);
  }
  lines.push('');
  lines.push('=== B站 round journal ===');
  const rounds = report.rounds;
  if (rounds.ok) {
    lines.push(`  ${rounds.path}：${rounds.journals} 本，带证据 ${rounds.withEvidence} 本`);
    for (const row of rounds.rounds) lines.push(`    ${row.claim} terminal=${row.terminal} 证据 ${row.evidenceCount} 条 ${row.kinds.join(',')}`);
  } else {
    lines.push(`  未读到：${rounds.code} — ${rounds.path}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
