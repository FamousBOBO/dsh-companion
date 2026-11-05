#!/usr/bin/env node
/**
 * Legacy memory migration CLI (CONTRACT.md §7).
 *
 * Usage:
 *   node scripts/migrate-memory.mjs [--dry-run] [--backup] [--report]
 *                                   [--root <dir>] [--db <file>] [--user <id>] [--persona <id>]
 *
 * Defaults: back up the legacy inputs into `home/memory/backups/<stamp>/`, then
 * import into `home/memory/companion-memory.db` and write the report to
 * `logs/memory-migration-<stamp>.json`. All output is counts and ids only; the
 * CLI never prints memory text.
 *
 * The legacy files are opened read-only. The desktop application may be running:
 * this command never restarts or kills it, and it only touches the SQLite file
 * named by --db.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PATHS, IMPORT_MANIFEST_VERSION, formatStamp, runImport,
} from '../lib/import.mjs';

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../..');

const HELP = `旧记忆迁移：把 home/ 下的只读旧数据写入新的 SQLite 记忆库（契约 §7）

用法：
  node scripts/migrate-memory.mjs [选项]

选项：
  --dry-run           只读取与映射，不备份、不写库、不写报告文件（默认只打印摘要）
  --backup            先执行备份（正常模式下备份是默认行为；--dry-run 下也能强制备份）
  --report            写报告文件到 logs/memory-migration-<stamp>.json（正常模式默认写）
  --refresh           幂等刷新：已存在行的 importance/mentionPolicy/status 与当前映射
                      不一致时用 updateMemory 修正（reason=migration-refresh）；
                      不加该参数时保持“0 新增、0 改动”；重复刷新第二次为 0 条
  --root <dir>        仓库根目录，默认 ${REPO_ROOT}
  --db <file>         目标数据库，默认 <root>/${DEFAULT_PATHS.database}
  --user <id>         归属用户，默认读取 home/companion/identity.json
  --persona <id>      角色标识，默认读取 identity.json 的 persona
  --json              把报告 JSON 打印到标准输出（不含记忆正文）
  --help              显示本帮助

退出码：0 成功且对账通过；1 对账未通过；2 参数、环境或存储层错误。
`;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    backup: undefined,
    report: undefined,
    refresh: false,
    json: false,
    help: false,
    root: REPO_ROOT,
    db: '',
    user: '',
    persona: '',
  };
  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const equal = argument.indexOf('=');
    const flag = argument.startsWith('--') && equal > 0 ? argument.slice(0, equal) : argument;
    const inline = argument.startsWith('--') && equal > 0 ? argument.slice(equal + 1) : '';
    switch (flag) {
      case '--dry-run': options.dryRun = true; break;
      case '--backup': options.backup = true; break;
      case '--report': options.report = true; break;
      case '--refresh': options.refresh = true; break;
      case '--json': options.json = true; break;
      case '--help':
      case '-h': options.help = true; break;
      case '--root': options.root = path.resolve(inline || takeValue(index++, '--root')); break;
      case '--db': options.db = path.resolve(inline || takeValue(index++, '--db')); break;
      case '--user': options.user = inline || takeValue(index++, '--user'); break;
      case '--persona': options.persona = inline || takeValue(index++, '--persona'); break;
      default: throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function readIdentity(root) {
  const file = path.join(root, DEFAULT_PATHS.identity);
  if (!fs.existsSync(file)) {
    throw new Error(`找不到身份绑定文件：${file}。请先用 --user 与 --persona 指定归属。`);
  }
  let identity;
  try {
    identity = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`身份绑定文件无法解析：${file}`);
  }
  return {
    file,
    userId: String(identity?.desktop?.userId ?? identity?.owner?.id ?? ''),
    personaId: String(identity?.persona ?? ''),
    displayName: String(identity?.owner?.displayName ?? ''),
  };
}

function openArchivePersona(root) {
  try {
    const archive = JSON.parse(fs.readFileSync(path.join(root, DEFAULT_PATHS.archive), 'utf8'));
    return String(archive?.manifest?.persona ?? '');
  } catch {
    return '';
  }
}

async function loadStore() {
  let module;
  try {
    module = await import('../lib/db.mjs');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('存储层 lib/db.mjs 尚未就绪，迁移暂不可写库。可先用 --dry-run 校验映射。');
    }
    throw error;
  }
  if (typeof module.openMemoryDatabase !== 'function') {
    throw new Error('lib/db.mjs 未导出 openMemoryDatabase。');
  }
  return module;
}

function printMappingTable(report) {
  const lines = ['按旧 memoryType 的映射：'];
  lines.push('  类型                    条数  作用域          kind          mentionPolicy  状态');
  for (const [type, slot] of Object.entries(report.byMemoryType)) {
    const statuses = Object.entries(slot.statuses ?? {}).map(([status, count]) => `${status}=${count}`).join(' ');
    lines.push(`  ${type.padEnd(22)} ${String(slot.count).padStart(5)}  ${slot.scope.padEnd(13)} ${slot.kind.padEnd(13)} ${slot.mentionPolicy.padEnd(14)} ${statuses}`);
  }
  lines.push(`  合计 ${report.totals.candidates} 条；按作用域 ${Object.entries(report.byScope).map(([scope, count]) => `${scope}=${count}`).join('、')}`);
  return lines;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const root = options.root;
  const identity = readIdentity(root);
  const userId = options.user || identity.userId;
  const personaId = options.persona || identity.personaId;
  if (!userId) throw new Error('无法确定归属用户：identity.json 缺少 desktop.userId / owner.id，且未传 --user。');
  if (!personaId) throw new Error('无法确定角色：identity.json 缺少 persona，且未传 --persona。');

  const dbFile = options.db || path.join(root, DEFAULT_PATHS.database);
  // One clock for the whole run so the printed stamp, backup directory and report
  // file name always agree.
  const clock = Date.now();
  const stamp = formatStamp(clock);

  process.stdout.write([
    `旧记忆迁移 ${options.dryRun ? '（演练，不写库）' : '（先备份再写入）'}${options.refresh ? '（刷新模式）' : ''}`,
    `  仓库根目录 ${root}`,
    `  归属 ${userId} / ${personaId}`,
    `  旧档案 ${path.join(root, DEFAULT_PATHS.archive)}`,
    `  目标数据库 ${dbFile}`,
    `  时间戳 ${stamp}`,
    '',
  ].join('\n'));

  const { openMemoryDatabase } = await loadStore();
  // A dry run never creates the target file: an existing store is opened
  // read-only (only to predict dedupe), a missing one is simply "empty".
  let db = null;
  let dbNote = '';
  if (options.dryRun) {
    if (fs.existsSync(dbFile)) {
      try {
        db = await openMemoryDatabase({ file: dbFile, readOnly: true });
        dbNote = '演练：已只读打开目标库，用于预测去重';
      } catch (error) {
        dbNote = `演练：目标库无法只读打开（${error?.message ?? error}），按空库预测`;
      }
    } else {
      dbNote = '演练：目标库尚不存在，按空库预测';
    }
  } else {
    db = await openMemoryDatabase({ file: dbFile });
  }
  let result;
  try {
    if (db && !options.dryRun) {
      // Identity rows are cheap and make the imported memories resolvable.
      try {
        db.upsertIdentity({ userId, displayName: identity.displayName || userId });
        db.upsertPersona({ personaId, displayName: openArchivePersona(root) || personaId });
      } catch (error) {
        process.stdout.write(`提示：身份登记失败但继续导入（${error?.message ?? error}）。\n`);
      }
    }
    result = await runImport({
      root,
      db: db ?? undefined,
      userId,
      personaId,
      dryRun: options.dryRun,
      clock,
      refresh: options.refresh,
      backup: options.dryRun ? options.backup === true : true,
      writeReport: options.dryRun ? options.report === true : true,
    });
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  const { report } = result;
  const out = [];
  out.push(`清单版本 v${IMPORT_MANIFEST_VERSION}；模式 ${report.mode}`);
  if (dbNote) out.push(dbNote);
  if (report.backup) {
    out.push(`备份目录 ${report.backup.dir}`);
    for (const file of report.backup.files) {
      out.push(`  备份 ${file.name}：${file.exists ? `${file.bytes} 字节 sha256=${file.sha256.slice(0, 16)}… 校验${file.verified ? '通过' : '失败'}` : '不存在，已记录'}`);
    }
  } else if (report.mode === 'apply') {
    out.push('警告：本次未执行备份（明确跳过）。');
  }
  out.push(...printMappingTable(report));
  out.push(`新增 ${report.totals.inserted} 条；去重跳过 ${report.totals.deduped} 条；映射跳过 ${report.totals.skipped} 条`);
  const refreshedLine = `刷新 ${report.totals.refreshed} 条${report.totals.refreshFailed ? `（失败 ${report.totals.refreshFailed}）` : ''}`;
  out.push(report.mode === 'dry_run'
    ? `演练：预计${refreshedLine}（--refresh 时生效）`
    : `${refreshedLine}（${report.refresh ? '--refresh' : '未开启 refresh，不改动已有行'}）`);
  if (report.mode === 'dry_run') {
    out.push(`证据事件 预计新增 ${report.totals.eventsInserted} 条；演练不写入证据与关联`);
  } else {
    out.push(`证据事件 新增 ${report.totals.eventsInserted} 条 / 已存在 ${report.totals.eventsDeduped} 条；证据关联 新写入 ${report.totals.evidenceLinked} 条 / 已存在 ${report.totals.evidenceExisting} 条 / 失败 ${report.totals.evidenceFailed} 条`);
  }
  if (report.skippedByReason && Object.keys(report.skippedByReason).length) {
    out.push(`跳过原因 ${Object.entries(report.skippedByReason).map(([reason, count]) => `${reason}=${count}`).join('、')}`);
  }
  if (report.warnings?.length) {
    out.push(`提示 ${report.warnings.map(warning => `${warning.code}${warning.count > 1 ? `×${warning.count}` : ''}`).join('、')}`);
  }
  out.push('');
  out.push('对账结论：');
  for (const line of report.reconciliation?.summaryText ?? []) out.push(`  ${line}`);
  const failed = (report.reconciliation?.checks ?? []).filter(check => !check.ok);
  for (const check of failed) {
    out.push(`  ✗ ${check.name}：期望 ${JSON.stringify(check.expected)}，实际 ${JSON.stringify(check.actual)}${check.detail ? `（${check.detail}）` : ''}`);
  }
  if (result.reportPath) out.push(`报告 ${result.reportPath}`);
  else out.push('报告未写入（演练模式；加 --report 可写入）');
  process.stdout.write(`${out.join('\n')}\n`);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  return report.reconciliation?.ok === false ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`迁移失败：${error?.message ?? error}\n`);
    process.exitCode = 2;
  },
);
