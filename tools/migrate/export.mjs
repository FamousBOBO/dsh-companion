/**
 * `npm run migrate -- export`
 *
 * Writes a self-describing bundle directory. The bundle is assembled under
 * `<out>.partial-<pid>` and only renamed into place once `MANIFEST.json` is
 * complete, so an interrupted export can never be mistaken for a finished one.
 */
import fs from 'node:fs';
import path from 'node:path';

import { BUNDLE_FILES, FORMAT, FORMAT_VERSION, buildManifest, defaultBundleDirname, readJson, writeJson } from './bundle.mjs';
import { buildContext, detectLiveHost, identityFingerprint, readIdentityFile } from './context.mjs';
import { DEFAULT_DOMAINS, DOMAIN_SPECS, applyTransform, parseDomainList, validateDomains } from './domains.mjs';
import { countRows, probeDatabase, snapshotDatabase } from './sqlite.mjs';

function resolveSource(dataRoot, relative) {
  return path.join(dataRoot, ...relative.split('/'));
}

function matchGlob(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  const prefix = pattern.slice(0, pattern.indexOf('*'));
  const suffix = pattern.slice(pattern.indexOf('*') + 1);
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && !name.endsWith('.bak'))
    .sort()
    .map((name) => path.join(dir, name));
}

function copyTree(from, to) {
  let files = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const dest = path.join(to, path.relative(from, full));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        files += 1;
      }
    }
  };
  walk(from);
  return files;
}

/**
 * @returns {Promise<{code:number, payload:object}>}
 */
export async function runExport(args, io) {
  const warnings = [];
  const problems = [];
  const ctx = buildContext(io?.env ?? process.env);

  const requested = parseDomainList(args.domains) ?? DEFAULT_DOMAINS;
  const validated = validateDomains(requested);
  if (!validated.ok) {
    return {
      code: 2,
      payload: {
        schemaVersion: 1,
        command: 'export',
        ok: false,
        error: { code: validated.code, message: validated.message, domain: validated.domain },
      },
    };
  }
  const domains = validated.domains;

  const live = detectLiveHost(ctx);
  if (live.live) {
    warnings.push({
      code: 'live-snapshot',
      message: '检测到宿主可能仍在运行；导出的是实时快照。需要严格一致的备份时，请先 npm run stop 再导出。',
      signals: live.signals,
    });
  }

  const outDir = args.out
    ? path.resolve(String(args.out))
    : path.join(ctx.dataPaths.root, 'exports', defaultBundleDirname(ctx.suiteVersion));
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    return {
      code: 3,
      payload: {
        schemaVersion: 1,
        command: 'export',
        ok: false,
        error: {
          code: 'output-not-empty',
          message: `输出目录已存在且非空：${outDir}。请换一个 --out，或先自行移走/删除它。`,
        },
      },
    };
  }

  const partial = `${outDir}.partial-${process.pid}`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });

  const files = [];
  const domainReport = {};
  const redactions = [];
  const now = new Date().toISOString();

  try {
    for (const domain of domains) {
      const spec = DOMAIN_SPECS[domain];
      const entry = { included: false, label: spec.label, items: [] };
      for (const item of spec.items) {
        if (item.kind === 'sqlite') {
          const src = resolveSource(ctx.dataRoot, item.from);
          if (!fs.existsSync(src)) {
            entry.items.push({ kind: item.kind, from: item.from, included: false, reason: '文件不存在' });
            continue;
          }
          const probe = await probeDatabase(src);
          if (!probe.ok) {
            problems.push({ domain, code: 'source-database-unhealthy', message: probe.reason ?? probe.quickCheck, file: item.from });
          }
          const dest = path.join(partial, item.to);
          const snapshot = await snapshotDatabase(src, dest);
          warnings.push(...(snapshot.warnings ?? []).map((message) => ({ code: 'sqlite-snapshot-fallback', domain, message })));
          const counts = item.countCandidates ? await countRows(dest, item.countCandidates) : null;
          files.push({ path: item.to, domain, required: item.required });
          entry.items.push({
            kind: item.kind,
            from: item.from,
            included: true,
            snapshotMode: snapshot.mode,
            bytes: snapshot.bytes,
            quickCheck: probe.quickCheck ?? '',
            userVersion: probe.userVersion ?? null,
            rowCounts: counts,
          });
        } else if (item.kind === 'json') {
          const src = resolveSource(ctx.dataRoot, item.from);
          if (!fs.existsSync(src)) {
            entry.items.push({ kind: item.kind, from: item.from, included: false, reason: '文件不存在' });
            continue;
          }
          const raw = readJson(src, { required: true });
          const { value, redactions: removed } = applyTransform(item.transform, raw, { now });
          writeJson(path.join(partial, item.to), value);
          redactions.push(...removed);
          files.push({ path: item.to, domain, required: item.required });
          entry.items.push({ kind: item.kind, from: item.from, included: true, transform: item.transform ?? null });
        } else if (item.kind === 'json-glob') {
          const matched = matchGlob(path.dirname(resolveSource(ctx.dataRoot, item.from)), path.basename(item.from));
          if (!matched.length) {
            entry.items.push({ kind: item.kind, from: item.from, included: false, reason: '没有匹配文件' });
            continue;
          }
          const merged = [];
          for (const file of matched) {
            const raw = readJson(file);
            if (Array.isArray(raw)) merged.push(...raw);
          }
          const { value, redactions: removed } = applyTransform(item.transform, merged, { now });
          writeJson(path.join(partial, item.to), value);
          redactions.push(...removed.map((entryItem) => ({ ...entryItem, files: matched.length })));
          files.push({ path: item.to, domain, required: item.required });
          entry.items.push({ kind: item.kind, from: item.from, included: true, files: matched.length });
        } else if (item.kind === 'tree') {
          const src = resolveSource(ctx.dataRoot, item.from);
          if (!fs.existsSync(src)) {
            entry.items.push({ kind: item.kind, from: item.from, included: false, reason: '目录不存在' });
            continue;
          }
          const copied = copyTree(src, path.join(partial, item.to));
          for (const relative of listTree(path.join(partial, item.to))) {
            files.push({ path: `${item.to}/${relative}`, domain, required: item.required });
          }
          entry.items.push({ kind: item.kind, from: item.from, included: true, files: copied });
        }
      }
      entry.included = entry.items.some((item) => item.included);
      domainReport[domain] = entry;
    }

    const identity = readIdentityFile(ctx);
    const bundle = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      suiteVersion: ctx.suiteVersion,
      createdAt: now,
      createdBy: `dsh-companion/${ctx.suiteVersion}`,
      source: {
        platform: process.platform,
        node: process.versions.node,
        hostVersion: ctx.host.version,
        dataDirBasename: path.basename(ctx.dataRoot),
        personaId: identity?.persona ?? ctx.personaId,
        targetPersonaId: ctx.personaId,
        identityFingerprint: identity ? identityFingerprint(identity, ctx.personaId) : '',
      },
      consistency: live.live ? 'live-snapshot' : 'stopped',
      domains: domainReport,
      excluded: [
        { domain: 'credentials', reason: '凭据、登录态与密钥永不导出；迁移后重新登录 / 重新授权。' },
        { domain: 'sessions', reason: '宿主会话缓存是本机的，且含聊天正文。' },
        { domain: 'desktop-data', reason: 'Electron user-data 含登录态与缓存。' },
        { domain: 'media-artifacts', reason: '媒体产物只迁移账本索引，不迁移二进制。' },
        { domain: 'logs', reason: '日志可能含正文与个人标识。' },
      ],
      redactions,
      warnings,
    };
    writeJson(path.join(partial, BUNDLE_FILES.bundle), bundle);
    writeJson(path.join(partial, BUNDLE_FILES.manifest), buildManifest(partial, [
      ...files,
      { path: BUNDLE_FILES.bundle, domain: 'meta', required: true },
    ]));

    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.renameSync(partial, outDir);
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    problems.push({ code: 'export-failed', message: error?.message ?? String(error) });
    return {
      code: 1,
      payload: { schemaVersion: 1, command: 'export', ok: false, error: { code: 'export-failed', message: error?.message ?? String(error) } },
    };
  }

  return {
    code: 0,
    payload: {
      schemaVersion: 1,
      command: 'export',
      ok: true,
      outDir,
      bundle: path.join(outDir, BUNDLE_FILES.bundle),
      manifest: path.join(outDir, BUNDLE_FILES.manifest),
      suiteVersion: ctx.suiteVersion,
      personaId: ctx.personaId,
      consistency: live.live ? 'live-snapshot' : 'stopped',
      domains: domainReport,
      redactions,
      warnings,
      problems,
      nextSteps: [
        '在目标机器上先完成部署（npm ci && npm run build && npm run doctor && npm run setup）。',
        `导入前先预检：npm run migrate -- check --from "${outDir}"`,
        `预检通过后再导入：npm run migrate -- import --from "${outDir}" --dry-run`,
        '迁移包含个人数据（记忆 / 身份），不要上传、不要入 Git、传输时自行加密。',
      ],
    },
  };
}

function listTree(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listTree(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

export default { runExport };
