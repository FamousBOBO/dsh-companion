/**
 * `npm run migrate -- import --from <dir> [--identity adopt|quarantine] [--yes] [--dry-run]`
 *
 * Order matters and is deliberate:
 *   1. re-run the full `check` — a rejected bundle never touches the data directory;
 *   2. refuse outright while a host holds the data directory open;
 *   3. take a complete pre-import backup, and abort if it cannot be written;
 *   4. only then replace files, each through `.partial-<pid>` + rename;
 *   5. rewrite the legacy persona id, pause imported reminders, drop outbox state;
 *   6. write a report describing what was imported, what was suppressed, and what
 *      the operator must rebind by hand.
 *
 * Nothing here sends a message, schedules a reminder, opens a network connection
 * or starts the host.
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson } from './bundle.mjs';
import { inspectBundle } from './check.mjs';
import { buildContext, readIdentityFile } from './context.mjs';
import { resolveImportTarget } from './domains.mjs';
import { loadSqlite, rewritePersonaId } from './sqlite.mjs';

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15).replace(/(\d{8})-(\d{6})/, '$1-$2');
}

function relativeFromDataRoot(ctx, absolute) {
  return path.relative(ctx.dataPaths.root, absolute).split(path.sep).join('/');
}

/** Copy the files that are about to be replaced into `backups/pre-import-<stamp>/`. */
function backupTargets(ctx, targets, backupDir) {
  const copied = [];
  const missing = [];
  for (const absolute of targets) {
    if (!fs.existsSync(absolute)) {
      missing.push(absolute);
      continue;
    }
    const relative = path.relative(ctx.dataPaths.root, absolute);
    const dest = path.join(backupDir, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(absolute, dest);
    // A SQLite database is only consistent together with its WAL siblings.
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(absolute + suffix)) fs.copyFileSync(absolute + suffix, dest + suffix);
    }
    copied.push(relative.split(path.sep).join('/'));
  }
  return { copied, missing };
}

/** Replace one file atomically; stale WAL siblings of the old file are removed first. */
function replaceFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial-${process.pid}`;
  fs.copyFileSync(src, partial);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dest + suffix)) fs.rmSync(dest + suffix, { force: true });
  }
  fs.renameSync(partial, dest);
  return dest;
}

/** Health authorization is per machine: never inherit it silently from a bundle. */
async function softenHealthConsents(dbFile) {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync || !fs.existsSync(dbFile)) {
    return { touched: false, reason: '健康数据库不存在或 node:sqlite 不可用' };
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(dbFile);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    if (!tables.includes('health_consents')) {
      return { touched: false, reason: '没有 health_consents 表（本版本尚未初始化授权），无需处理' };
    }
    const columns = db.prepare('PRAGMA table_info("health_consents")').all().map((row) => String(row.name));
    const grantedColumn = columns.find((name) => /^(granted|allowed|enabled|value)$/i.test(name));
    if (!grantedColumn) {
      return { touched: false, reason: `health_consents 表结构未识别（列：${columns.join(', ')}），请到 Studio 复核授权` };
    }
    const result = db.prepare(`UPDATE "health_consents" SET "${grantedColumn}" = 0`).run();
    return { touched: true, rows: Number(result?.changes ?? 0), column: grantedColumn };
  } catch (error) {
    return { touched: false, reason: `处理健康授权失败：${error?.message ?? error}` };
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
}

function mergeReminders(existing, imported, now) {
  const base = existing && typeof existing === 'object' ? existing : { version: 1, reminders: [] };
  const current = Array.isArray(base.reminders) ? base.reminders : [];
  const ids = new Set(current.map((item) => item?.id).filter(Boolean));
  const added = (Array.isArray(imported?.reminders) ? imported.reminders : [])
    .filter((item) => item && !ids.has(item.id))
    .map((item) => ({ ...item, fired: true, paused: true, pausedAt: now, pausedReason: 'imported: 旧提醒不重放，仅存档' }));
  return { value: { ...base, version: base.version ?? 1, reminders: [...current, ...added] }, added };
}

/**
 * What the operator must rebind by hand after a migration. Kept in one place so
 * `--dry-run` and a real import describe exactly the same obligations.
 */
function rebindSteps() {
  return [
    {
      kind: 'path',
      what: 'profile 与工作区路径',
      action: '重跑 `npm run setup`，让它按本机解析值重新生成 profile 的 cordis.patch.yml（含 file:// 插件路径）与工作区目录。',
    },
    {
      kind: 'auth',
      what: '模型 provider 密钥',
      action: '在 `config/suite.json` / `.env.local` / 系统环境里重新填写；迁移包不含任何密钥。',
    },
    {
      kind: 'auth',
      what: 'QQ / B站 登录',
      action: '重新扫码登录（NapCat WebUI、B站账号）。凭据与登录缓存永不迁移，`bili_credential.json` 属于永不导出的凭据。',
    },
    {
      kind: 'auth',
      what: '健康授权',
      action: '在「陪伴空间 → 健康」重新确认授权，再用 `companion_pulse action=start` 建立会话。',
    },
    {
      kind: 'device',
      what: 'BLE 心率设备',
      action: '在设备上重新打开「心率广播」，然后 `companion_pulse action=start`（start 是唯一的扫描入口）。',
    },
    {
      kind: 'service',
      what: '外部服务地址',
      action: 'OneBot / 健康 sidecar / 媒体服务由用户在 `config/suite.json` 填地址；套件只连接，不安装。',
    },
  ];
}

/** @returns {Promise<{code:number, payload:object}>} */
export async function runImport(args, io) {
  const ctx = buildContext(io?.env ?? process.env);
  const now = new Date().toISOString();
  const inspected = await inspectBundle(args.from, ctx);
  const { problems, warnings, conflicts, plan, bundle } = inspected;

  const base = {
    schemaVersion: 1,
    command: 'import',
    from: inspected.bundleDir,
    target: { suiteVersion: ctx.suiteVersion, personaId: ctx.personaId, dataRoot: ctx.dataRoot },
    dryRun: Boolean(args.dryRun),
  };

  if (problems.length > 0) {
    return {
      code: 2,
      payload: { ...base, ok: false, error: { code: 'check-failed', message: '预检未通过，未写入任何数据。' }, problems, warnings, plan },
    };
  }

  if (conflicts.running.length > 0) {
    return {
      code: 3,
      payload: {
        ...base,
        ok: false,
        error: { code: 'host-running', message: '数据目录仍被宿主占用，拒绝覆盖运行中数据。先 npm run stop。' },
        conflicts,
        warnings,
      },
    };
  }

  if (conflicts.identity.length > 0 && !args.identity) {
    return {
      code: 3,
      payload: {
        ...base,
        ok: false,
        error: {
          code: 'identity-undecided',
          message: '身份冲突未裁决：加 --identity adopt（采用包内身份）或 --identity quarantine（隔离保留，不注入对话）。',
        },
        conflicts,
        warnings,
      },
    };
  }

  const willWrite = plan.willWrite ?? [];
  if (!willWrite.length) {
    return {
      code: 2,
      payload: { ...base, ok: false, error: { code: 'nothing-to-import', message: '迁移包里没有可导入的文件。' }, problems, warnings, plan },
    };
  }

  if (args.dryRun) {
    return {
      code: 0,
      payload: {
        ...base,
        ok: true,
        message: '--dry-run：未写入任何内容。去掉 --dry-run 才会真正导入。',
        warnings,
        conflicts,
        plan,
        rebind: rebindSteps(),
        personaMapping: plan.personaMapping ?? null,
        notReplayed: (plan.skipped ?? []).map((item) => ({ kind: 'domain', ...item })),
        nextSteps: [
          '1. 确认 plan.willWrite 与 willBackup 符合预期。',
          '2. 先 npm run stop，确保没有宿主占用数据目录。',
          '3. 去掉 --dry-run 重跑同一命令；导入前会自动备份到 <dataDir>/backups/pre-import-<UTC>/。',
        ],
      },
    };
  }

  const backupStamp = stamp();
  const backupDir = path.join(ctx.dataPaths.backups, `pre-import-${backupStamp}`);
  const targets = willWrite.map((item) => item.absolute);
  let backup;
  try {
    backup = backupTargets(ctx, targets, backupDir);
  } catch (error) {
    return {
      code: 1,
      payload: {
        ...base,
        ok: false,
        error: { code: 'backup-failed', message: `导入前备份失败，未写入任何数据：${error?.message ?? error}` },
      },
    };
  }

  const imported = [];
  const notReplayed = [];
  const importWarnings = [...warnings];
  const personaMapping = plan.personaMapping
    ? { from: plan.personaMapping.from, to: plan.personaMapping.to, targets: [] }
    : null;

  for (const item of willWrite) {
    const bundleFile = path.join(inspected.bundleDir, ...item.path.split('/'));
    const target = item.absolute;
    const domain = String(item.path).split('/')[1] ?? '';

    if (item.path === 'domains/identity/identity.json') {
      const importedIdentity = readJson(bundleFile);
      if (args.identity === 'quarantine') {
        notReplayed.push({
          kind: 'identity',
          reason: '--identity quarantine：身份文件未写入，包内数据只作隔离保留。',
        });
        continue;
      }
      const local = readIdentityFile(ctx) ?? {};
      const merged = {
        ...importedIdentity,
        persona: ctx.personaId,
        sessions: local.sessions && typeof local.sessions === 'object' ? local.sessions : {},
        boundAt: importedIdentity?.boundAt ?? now,
        importedAt: now,
        importedFrom: {
          suiteVersion: bundle?.suiteVersion ?? '',
          personaId: bundle?.source?.personaId ?? '',
        },
      };
      writeJson(target, merged);
      imported.push({ path: item.path, target: relativeFromDataRoot(ctx, target), kind: 'identity', identityMode: args.identity ?? 'adopt-by-default' });
      continue;
    }

    if (item.path.startsWith('domains/reminders/')) {
      const importedReminders = readJson(bundleFile);
      const existing = readJson(target);
      const { value, added } = mergeReminders(existing, importedReminders, now);
      writeJson(target, value);
      imported.push({ path: item.path, target: relativeFromDataRoot(ctx, target), kind: 'reminders', added: added.length });
      for (const reminder of added) {
        notReplayed.push({
          kind: 'reminder',
          id: reminder.id ?? null,
          at: reminder.at ?? null,
          reason: '导入的提醒一律置为已发并暂停：停机期间的提醒不补发。',
        });
      }
      continue;
    }

    // SQLite and wiki files: replace atomically, then rewrite the legacy persona id.
    const destination = item.path.startsWith('domains/memory-wiki/')
      ? remapPersonaPath(target, bundle?.source?.personaId, ctx.personaId)
      : target;
    replaceFile(bundleFile, destination);
    let mapping = [];
    if (destination.endsWith('.db') && bundle?.source?.personaId && bundle.source.personaId !== ctx.personaId) {
      try {
        mapping = await rewritePersonaId(destination, bundle.source.personaId, ctx.personaId);
      } catch (error) {
        importWarnings.push({
          code: 'persona-rewrite-failed',
          path: item.path,
          message: `人格 id 改写失败（${error?.message ?? error}）：数据已导入，请手工核对 persona 列。`,
        });
      }
      if (personaMapping) personaMapping.targets.push(...mapping.map((entry) => ({ file: item.path, ...entry })));
    }
    imported.push({
      path: item.path,
      target: relativeFromDataRoot(ctx, destination),
      kind: destination.endsWith('.db') ? 'sqlite' : 'file',
      personaRowsRewritten: mapping.reduce((sum, entry) => sum + entry.rows, 0),
    });

    if (destination.endsWith('health.db')) {
      const softened = await softenHealthConsents(destination);
      if (softened.touched) {
        notReplayed.push({
          kind: 'health-consent',
          reason: `健康授权已在本机全部置为未授权（${softened.rows} 行）：采集能力不会被迁移包打开。`,
        });
      } else {
        importWarnings.push({ code: 'health-consent-unresolved', message: softened.reason });
      }
    }
  }

  if (personaMapping && personaMapping.targets.length === 0) {
    personaMapping.note = '未在可用列里找到旧人格 id；如需核对，请查 <dataDir>/logs/migration-import-*.json。';
  }

  const rebind = rebindSteps();

  const reportFile = path.join(ctx.dataPaths.logs, `migration-import-${backupStamp}.json`);
  const report = {
    schemaVersion: 1,
    importedAt: now,
    from: inspected.bundleDir,
    bundle: {
      suiteVersion: bundle?.suiteVersion ?? '',
      createdAt: bundle?.createdAt ?? '',
      personaId: bundle?.source?.personaId ?? '',
      consistency: bundle?.consistency ?? '',
    },
    dryRun: false,
    identityMode: args.identity ?? 'none',
    imported,
    notReplayed,
    rebind,
    personaMapping,
    backup: { dir: backupDir, files: backup.copied, absent: backup.missing.length },
    warnings: importWarnings,
  };
  try {
    writeJson(reportFile, report);
  } catch (error) {
    importWarnings.push({ code: 'report-write-failed', message: `导入已完成，但报告写入失败：${error?.message ?? error}` });
  }

  return {
    code: 0,
    payload: {
      ...base,
      ok: true,
      imported,
      notReplayed,
      rebind,
      personaMapping,
      backup: { dir: backupDir, files: backup.copied.length },
      report: reportFile,
      warnings: importWarnings,
      nextSteps: [
        '1. 重跑 `npm run setup`，让 profile/工作区路径按本机重建。',
        '2. 重新填写密钥并重新登录 QQ / B站（迁移包不含凭据）。',
        '3. `npm run doctor` 确认没有遗留的陈旧路径或未配置项。',
        '4. `npm run start` 启动后先看记忆与日程是否可读，再确认外发能力仍是关的。',
        '5. 旧提醒不会补发；需要的话用 `qq_remind` 重新添加。',
      ],
    },
  };
}

/** Rewrite a legacy persona id inside a file path (wiki pages such as `relationships/<id>-user.md`). */
function remapPersonaPath(target, from, to) {
  if (!from || !to || from === to) return target;
  if (!target.includes(from)) return target;
  return target.split(from).join(to);
}

export default { runImport };
