/**
 * Shared context for every migration subcommand: where the suite is, where its
 * data lives, which persona id is the target, and whether a host currently holds
 * the data directory open.
 *
 * Everything is derived from `tools/lib/paths.mjs` + `tools/lib/config.mjs`, so
 * the CLI resolves exactly the same `dataRoot` as the plugins do (D2).
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { SUITE_PATHS, dataPaths as makeDataPaths } from '../lib/paths.mjs';
import { fingerprint, readJson } from './bundle.mjs';

/** Legacy persona id present in data exported before the 0.1.0 rename (D1). */
export const LEGACY_PERSONA_IDS = ['march7'];

export function resolveSuiteVersion() {
  const pkg = readJson(path.join(SUITE_PATHS.root, 'package.json')) ?? {};
  return String(pkg.version ?? '0.0.0');
}

/** `DSH_COMPANION_PERSONA_ID` → `config.persona.id` → `bot` (D1). */
export function resolvePersonaId(config, env = process.env) {
  const fromEnv = env.DSH_COMPANION_PERSONA_ID;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const fromConfig = config?.persona?.id;
  if (fromConfig && String(fromConfig).trim()) return String(fromConfig).trim();
  return 'bot';
}

/** Cheap host version read: `<moduleRoot>/../package.json`. Never spawns the host. */
export function hostVersionFromModuleRoot(moduleRoot) {
  if (!moduleRoot) return '';
  const dshPackage = path.join(path.dirname(moduleRoot), 'package.json');
  const pkg = readJson(dshPackage);
  return String(pkg?.version ?? '');
}

export function buildContext(env = process.env) {
  const loaded = loadConfig({ env });
  const personaId = resolvePersonaId(loaded.config, env);
  const dataRoot = loaded.dataPaths.root;
  return {
    env,
    config: loaded.config,
    configFile: loaded.configFile,
    configSources: loaded.sources,
    dataRoot,
    dataPaths: loaded.dataPaths,
    suiteRoot: SUITE_PATHS.root,
    suiteVersion: resolveSuiteVersion(),
    personaId,
    host: {
      executable: loaded.config?.dsh?.executable ?? '',
      moduleRoot: loaded.config?.dsh?.moduleRoot ?? '',
      version: hostVersionFromModuleRoot(loaded.config?.dsh?.moduleRoot ?? ''),
    },
  };
}

/** Read the identity file without going through the identity domain. */
export function readIdentityFile(ctx) {
  return readJson(path.join(ctx.dataPaths.home, 'companion', 'identity.json'));
}

/**
 * Fingerprint of the owner binding. Only the hash is written into `bundle.json`;
 * `domains/identity/identity.json` is the operator's own data file.
 */
export function identityFingerprint(identity, personaId) {
  const owner = identity?.owner ?? {};
  return fingerprint({
    platform: owner.platform ?? '',
    ownerId: owner.id === undefined ? '' : String(owner.id),
    persona: identity?.persona ?? personaId ?? '',
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Heuristic "is the host holding this data directory" probe.
 *
 * Three independent signals, because none of them is authoritative on its own:
 *   1. the launcher lock file cannot be opened read-write while the host holds it;
 *   2. `logs/desktop-launch.json` names a pid that is still alive;
 *   3. a database's `-wal` file was modified within the freshness window.
 *
 * The docs say the same thing: the only reliable stop is `npm run stop`.
 */
export function detectLiveHost(ctx, { walWindowMs = 15_000 } = {}) {
  const signals = [];
  const logger = ctx.dataPaths.logs;

  const lock = path.join(logger, 'desktop-launch.lock');
  if (fs.existsSync(lock)) {
    try {
      const fd = fs.openSync(lock, 'r+');
      fs.closeSync(fd);
    } catch (error) {
      signals.push({ kind: 'lock', file: lock, detail: `启动锁被占用（${error?.code ?? error?.message}）` });
    }
  }

  const launchRecord = readJson(path.join(logger, 'desktop-launch.json'));
  if (launchRecord?.pid && processAlive(Number(launchRecord.pid))) {
    signals.push({ kind: 'pid', pid: Number(launchRecord.pid), detail: `launch 记录里的进程仍在运行（pid ${launchRecord.pid}）` });
  }

  const databases = [
    path.join(ctx.dataPaths.home, 'memory', 'companion-memory.db'),
    path.join(ctx.dataPaths.home, 'companion', 'companion-runtime.db'),
    path.join(ctx.dataPaths.home, 'health', 'health.db'),
  ];
  for (const db of databases) {
    const wal = `${db}-wal`;
    try {
      const stat = fs.statSync(wal);
      if (stat.size > 0 && Date.now() - stat.mtimeMs < walWindowMs) {
        signals.push({ kind: 'wal', file: wal, detail: 'WAL 刚被写入，数据库看起来正被打开' });
      }
    } catch { /* no wal: nothing to say */ }
  }

  return { live: signals.length > 0, signals };
}

export default {
  LEGACY_PERSONA_IDS,
  resolveSuiteVersion,
  resolvePersonaId,
  hostVersionFromModuleRoot,
  buildContext,
  readIdentityFile,
  identityFingerprint,
  detectLiveHost,
};
