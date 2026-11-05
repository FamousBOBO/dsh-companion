/**
 * `npm run migrate -- check --from <dir>`
 *
 * A bundle is accepted only when all seven checks in docs/04-migration.md pass.
 * `check` never writes anything — not into the bundle, not into the data
 * directory — so it is safe to run as often as the operator likes.
 */
import fs from 'node:fs';
import path from 'node:path';

import { compareVersions } from '../lib/host.mjs';
import { BUNDLE_FILES, FORMAT, FORMAT_VERSION, readJson, sha256File } from './bundle.mjs';
import { buildContext, detectLiveHost, identityFingerprint, readIdentityFile } from './context.mjs';
import { ARCHIVE_ONLY_DOMAINS, IMPORTABLE_DOMAINS, resolveImportTarget } from './domains.mjs';
import { probeDatabase, sqliteStatus } from './sqlite.mjs';

/** Compare a bundle version against the suite version. */
export function versionVerdict(bundleVersion, suiteVersion) {
  if (!bundleVersion) {
    return { level: 'unknown', ok: false, message: '迁移包没有记录套件版本，无法判定兼容性。' };
  }
  if (compareVersions(bundleVersion, suiteVersion) > 0) {
    return {
      level: 'newer-source',
      ok: false,
      message: `迁移包版本 ${bundleVersion} 高于本机套件 ${suiteVersion}：请先升级本机套件，再导入旧数据。降级导入不被支持。`,
    };
  }
  if (compareVersions(bundleVersion, suiteVersion) < 0) {
    return {
      level: 'older-source',
      ok: true,
      message: `迁移包版本 ${bundleVersion} 低于本机套件 ${suiteVersion}：将按新版本 schema 逐级升级，导入后请复核数据。`,
    };
  }
  return { level: 'same', ok: true, message: `迁移包版本与本机套件一致（${suiteVersion}）。` };
}

function nearestExistingDir(target) {
  let dir = path.resolve(target);
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
  return dir;
}

function freeBytes(target) {
  try {
    const stat = fs.statfsSync(nearestExistingDir(target));
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

/**
 * Inspect a bundle against the current machine. Shared by `check` and `import`.
 * @returns {Promise<{problems:object[], warnings:object[], conflicts:object, plan:object, bundle:object, manifest:object, bundleDir:string}>}
 */
export async function inspectBundle(from, ctx) {
  const problems = [];
  const warnings = [];
  const conflicts = { identity: [], paths: [], running: [] };
  const bundleDir = path.resolve(String(from ?? ''));
  const plan = { domains: [], databases: [], willWrite: [], willBackup: [], rebind: [], skipped: [] };

  if (!from) {
    problems.push({ code: 'missing-from', message: '必须提供 --from <迁移包目录>。' });
    return { problems, warnings, conflicts, plan, bundle: null, manifest: null, bundleDir };
  }
  if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
    problems.push({ code: 'bundle-not-found', message: `迁移包目录不存在：${bundleDir}` });
    return { problems, warnings, conflicts, plan, bundle: null, manifest: null, bundleDir };
  }

  let bundle;
  let manifest;
  try {
    bundle = readJson(path.join(bundleDir, BUNDLE_FILES.bundle), { required: true });
    manifest = readJson(path.join(bundleDir, BUNDLE_FILES.manifest), { required: true });
  } catch (error) {
    problems.push({ code: 'bundle-unreadable', message: error?.message ?? String(error) });
    return { problems, warnings, conflicts, plan, bundle: null, manifest: null, bundleDir };
  }

  // 1 — format
  if (bundle.format !== FORMAT) {
    problems.push({ code: 'format-unknown', message: `不是本套件的迁移包（format=${bundle.format ?? '(空)'}）。` });
  }
  if (Number(bundle.formatVersion) > FORMAT_VERSION) {
    problems.push({
      code: 'format-too-new',
      message: `迁移包格式版本 ${bundle.formatVersion} 高于本 CLI 支持的 ${FORMAT_VERSION}：请先升级套件。`,
    });
  } else if (Number(bundle.formatVersion) < FORMAT_VERSION) {
    warnings.push({
      code: 'format-older',
      message: `迁移包格式版本 ${bundle.formatVersion} 低于 ${FORMAT_VERSION}，按向后兼容读取。`,
    });
  }

  // 2 — integrity
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  if (!files.length) problems.push({ code: 'manifest-empty', message: 'MANIFEST.json 里没有任何文件条目。' });
  for (const entry of files) {
    const file = path.join(bundleDir, ...String(entry.path).split('/'));
    if (!fs.existsSync(file)) {
      (entry.required ? problems : warnings).push({
        code: entry.required ? 'file-missing' : 'optional-file-missing',
        path: entry.path,
        message: `${entry.required ? '必需' : '可选'}文件缺失：${entry.path}`,
      });
      continue;
    }
    const bytes = fs.statSync(file).size;
    if (Number.isFinite(Number(entry.bytes)) && bytes !== Number(entry.bytes)) {
      problems.push({ code: 'size-mismatch', path: entry.path, message: `${entry.path} 大小不符：期望 ${entry.bytes}，实际 ${bytes}。` });
      continue;
    }
    if (entry.sha256 && sha256File(file) !== entry.sha256) {
      problems.push({ code: 'checksum-mismatch', path: entry.path, message: `${entry.path} 校验和不符，迁移包可能被截断或改动过。` });
    }
  }

  // 3 — sqlite health inside the bundle
  const sqlite = await sqliteStatus();
  const databaseEntries = files.filter((entry) => String(entry.path).endsWith('.db'));
  if (databaseEntries.length && !sqlite.available) {
    problems.push({ code: 'sqlite-unavailable', message: sqlite.reason });
  }
  for (const entry of databaseEntries) {
    const file = path.join(bundleDir, ...String(entry.path).split('/'));
    if (!fs.existsSync(file)) continue;
    const probe = await probeDatabase(file);
    if (!probe.ok) {
      problems.push({ code: 'database-unhealthy', path: entry.path, message: `迁移包内数据库校验失败：${probe.reason ?? probe.quickCheck}` });
    }
    plan.databases.push({ path: entry.path, quickCheck: probe.quickCheck, userVersion: probe.userVersion ?? null });
  }

  // 4 — version
  const verdict = versionVerdict(bundle.suiteVersion, ctx.suiteVersion);
  if (!verdict.ok) problems.push({ code: 'version-incompatible', level: verdict.level, message: verdict.message });
  else if (verdict.level === 'older-source') warnings.push({ code: 'version-older', message: verdict.message });

  // 5 — identity
  const localIdentity = readIdentityFile(ctx);
  const localFingerprint = localIdentity ? identityFingerprint(localIdentity, ctx.personaId) : '';
  const bundleFingerprint = String(bundle?.source?.identityFingerprint ?? '');
  if (!bundleFingerprint) {
    warnings.push({ code: 'identity-unknown', message: '迁移包没有身份指纹，无法判断是否同一主人。导入时会要求显式选择 --identity。' });
    conflicts.identity.push({ kind: 'unknown', localFingerprint: localFingerprint ? 'present' : 'absent' });
  } else if (!localFingerprint) {
    conflicts.identity.push({
      kind: 'no-local-identity',
      message: '本机还没有身份绑定，迁移包里有。继续需要 --identity adopt。',
    });
  } else if (localFingerprint !== bundleFingerprint) {
    conflicts.identity.push({
      kind: 'mismatch',
      message: '迁移包里的主人/人格绑定与本机不同。--identity adopt 采用包内身份，--identity quarantine 只作隔离数据保留、不注入对话。',
    });
  }

  // persona id mapping (D1)
  const sourcePersona = String(bundle?.source?.personaId ?? '');
  if (sourcePersona && sourcePersona !== ctx.personaId) {
    plan.personaMapping = { from: sourcePersona, to: ctx.personaId, appliedAt: 'import' };
    warnings.push({
      code: 'persona-id-mapping',
      message: `迁移包人格 id 是 ${sourcePersona}，本机是 ${ctx.personaId}：导入时会把人格列与身份文件改写成 ${ctx.personaId}。`,
    });
  }

  // 6 — target state
  const live = detectLiveHost(ctx);
  if (live.live) {
    conflicts.running.push({
      kind: 'host-running',
      message: '数据目录看起来仍被宿主占用。先 npm run stop，再导入。',
      signals: live.signals,
    });
  }

  // 7 — free space (bundle size × 2, because a pre-import backup is written first)
  const totalBytes = files.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
  const free = freeBytes(ctx.dataPaths.root);
  plan.disk = { bundleBytes: totalBytes, freeBytes: free, requiredBytes: totalBytes * 2 };
  if (free !== null && free < totalBytes * 2) {
    problems.push({
      code: 'disk-space',
      message: `磁盘余量不足：需要约 ${Math.ceil((totalBytes * 2) / 1048576)} MiB（含导入前备份），当前可用 ${Math.floor(free / 1048576)} MiB。`,
    });
  }

  // plan
  for (const domain of IMPORTABLE_DOMAINS) {
    const info = bundle?.domains?.[domain];
    if (!info?.included) continue;
    plan.domains.push({ domain, label: info.label, action: 'import' });
  }
  for (const domain of ARCHIVE_ONLY_DOMAINS) {
    const info = bundle?.domains?.[domain];
    if (info?.included) plan.skipped.push({ domain, reason: '仅存档：外发状态不导入，避免重复发送。' });
  }
  for (const entry of files) {
    const target = resolveImportTarget(String(entry.path));
    if (!target) {
      const archiveOnly = ARCHIVE_ONLY_DOMAINS.includes(String(entry.domain ?? ''));
      if (String(entry.path) !== BUNDLE_FILES.bundle && !archiveOnly) {
        plan.skipped.push({ path: entry.path, reason: '迁移包里没有对应的落点（未知路径）。' });
      }
      continue;
    }
    const absolute = path.join(ctx.dataPaths.root, ...target.split('/'));
    plan.willWrite.push({ path: entry.path, target, absolute, bytes: Number(entry.bytes) || 0 });
    if (fs.existsSync(absolute)) plan.willBackup.push(target);
  }

  return { problems, warnings, conflicts, plan, bundle, manifest, bundleDir, versionVerdict: verdict };
}

/** @returns {Promise<{code:number, payload:object}>} */
export async function runCheck(args, io) {
  const ctx = buildContext(io?.env ?? process.env);
  const inspected = await inspectBundle(args.from, ctx);
  const { problems, warnings, conflicts, plan, bundle } = inspected;

  const identityBlocked = conflicts.identity.length > 0 && !args.identity;
  const runningBlocked = conflicts.running.length > 0;
  const ok = problems.length === 0;
  let code = 0;
  if (!ok) code = 2;
  else if (identityBlocked || runningBlocked) code = 3;

  return {
    code,
    payload: {
      schemaVersion: 1,
      command: 'check',
      ok: ok && !identityBlocked && !runningBlocked,
      from: inspected.bundleDir,
      format: bundle?.format ?? '',
      formatVersion: bundle?.formatVersion ?? null,
      source: bundle
        ? {
          suiteVersion: bundle.suiteVersion,
          platform: bundle.source?.platform,
          node: bundle.source?.node,
          personaId: bundle.source?.personaId,
          createdAt: bundle.createdAt,
          consistency: bundle.consistency,
        }
        : null,
      target: { suiteVersion: ctx.suiteVersion, personaId: ctx.personaId, dataRoot: ctx.dataRoot },
      verdict: inspected.versionVerdict?.level ?? 'unknown',
      problems,
      warnings,
      conflicts,
      plan,
      nextSteps: [
        ...(identityBlocked ? ['身份冲突未裁决：加 --identity adopt（采用包内身份）或 --identity quarantine（隔离保留）。'] : []),
        ...(runningBlocked ? ['先 npm run stop，确认宿主已退出，再重新 check。'] : []),
        ...(ok ? ['预检通过。先跑 import --dry-run 看计划，再加 --identity 正式导入。'] : []),
      ],
    },
  };
}

export default { runCheck, inspectBundle, versionVerdict };
