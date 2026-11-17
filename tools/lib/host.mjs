/**
 * DSH host discovery and compatibility probing.
 *
 * The suite never bundles the harness: it finds an existing installation, records
 * where it is, and checks the version it can actually load against. Nothing here
 * writes outside the suite directory.
 *
 * Layout reality (measured 2026-11-16 on the desktop 0.2.2-rc.1 install):
 *   resources/app.asar/dsh/package.json                        — harness version, only visible from Electron
 *   resources/app.asar/dsh/node_modules/@deepseek-ai/…/cli.js  — the CLI entry the install's own dsh.cmd runs
 *   resources/app.asar.unpacked/dsh/node_modules               — native add-ons only, no host CLI
 * A plain `node` process cannot see inside `app.asar`, so "does this layout exist" must be
 * answered by the desktop binary itself (`ELECTRON_RUN_AS_NODE=1 <exe> -e <probe>`), and the
 * answer is carried through to the launcher instead of being re-guessed with `fs.existsSync`.
 *
 * Everything below is expressed as pure functions with injected `exists`/`readJson`/`probe`
 * seams, so the whole decision matrix is unit-testable without starting a desktop host and
 * without reading this machine's installation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Highest DSH version this release was verified against, and the oldest accepted one. */
export const COMPATIBILITY = {
  verifiedAgainst: '0.2.1-rc.3',
  minimum: '0.2.0',
  note: 'Verified by loading the suite in the host listed in docs/07-verification-status.md.',
};

/** The package inside the host installation that carries the CLI entry point. */
export const HOST_CLI_PACKAGE = '@deepseek-ai/dsh-desktop-host';

/**
 * Probe script handed to the desktop binary. It runs *inside* Electron, so `fs.existsSync`
 * works on `app.asar` paths there. It reports only paths it has actually verified, and never
 * invents a version: an unreadable install comes back with an empty `version`.
 */
export const HOST_PROBE_SCRIPT = `(function () {
  var fs = require('node:fs'), p = require('node:path');
  var out = { resourcesPath: String(process.resourcesPath || ''), moduleRoots: [], cliPath: '', dshPackage: '', version: '' };
  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\\uFEFF/, '')); } catch (e) { return null; }
  }
  function exists(file) { try { return fs.existsSync(file); } catch (e) { return false; } }
  var res = out.resourcesPath;
  if (!res) { process.stdout.write(JSON.stringify(out)); return; }
  var roots = [
    p.join(res, 'app', 'dsh', 'node_modules'),
    p.join(res, 'app.asar.unpacked', 'dsh', 'node_modules'),
    p.join(res, 'app.asar', 'dsh', 'node_modules')
  ];
  for (var i = 0; i < roots.length; i += 1) {
    var cli = p.join(roots[i], '${HOST_CLI_PACKAGE}', 'lib', 'cli.js');
    if (exists(cli)) { out.moduleRoots.push(roots[i]); if (!out.cliPath) out.cliPath = cli; }
    if (!out.version) {
      var pkg = p.join(p.dirname(roots[i]), 'package.json');
      var json = readJson(pkg);
      if (json && json.version) { out.dshPackage = pkg; out.version = String(json.version); }
    }
  }
  if (!out.version) {
    var runtime = readJson(p.join(res, 'runtime', 'primary-runtime', 'runtime.json'));
    if (runtime && runtime.desktopVersion) {
      out.dshPackage = p.join(res, 'runtime', 'primary-runtime', 'runtime.json');
      out.version = String(runtime.desktopVersion);
    }
  }
  process.stdout.write(JSON.stringify(out));
})()`;

const defaultExists = (p) => {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
};

const defaultReadJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

/** Well-known desktop install locations. Pure: platform/env/home are injected. */
export function executableCandidates({ platform = process.platform, env = process.env, homedir = os.homedir } = {}) {
  const home = typeof homedir === 'function' ? homedir() : String(homedir || '');
  const out = [];
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      out.push(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
    }
    if (env.ProgramFiles) {
      out.push(path.join(env.ProgramFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'));
    }
  } else if (platform === 'darwin') {
    out.push('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness');
    out.push(path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness'));
  } else {
    out.push('/opt/DeepSeek Harness/deepseek-harness');
    out.push('/usr/lib/deepseek-harness/deepseek-harness');
    out.push(path.join(home, '.local', 'bin', 'deepseek-harness'));
  }
  return out;
}

/** Backwards-compatible alias used by diagnostics. */
export const CANDIDATE_PATHS = executableCandidates;

/** The CLI entry point a module root is expected to carry. */
export function cliEntryPath(moduleRoot) {
  return moduleRoot ? path.join(moduleRoot, HOST_CLI_PACKAGE, 'lib', 'cli.js') : '';
}

/**
 * Module-root layouts to try for an install, in the order that matches how the desktop
 * install itself launches (`app.asar` first — that is what its own `dsh.cmd` runs).
 * `dshPackage` short-circuits everything once the probe already located the package.
 */
export function moduleRootCandidates(moduleRootSources = {}) {
  const { executable = '', platform = process.platform, dshPackage = '' } = moduleRootSources;
  const out = [];
  const push = (candidate) => {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  };
  if (dshPackage) push(path.join(path.dirname(dshPackage), 'node_modules'));
  if (!executable) return out;
  const isMacBundle = platform === 'darwin' || /\.app[\\/]Contents[\\/]MacOS[\\/]/i.test(executable);
  if (isMacBundle) {
    const contents = path.dirname(path.dirname(executable));
    push(path.join(contents, 'Resources', 'app.asar', 'dsh', 'node_modules'));
    push(path.join(contents, 'Resources', 'app.asar.unpacked', 'dsh', 'node_modules'));
    push(path.join(contents, 'Resources', 'app', 'dsh', 'node_modules'));
    return out;
  }
  const resources = path.join(path.dirname(executable), 'resources');
  push(path.join(resources, 'app.asar', 'dsh', 'node_modules'));
  push(path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules'));
  push(path.join(resources, 'app', 'dsh', 'node_modules'));
  return out;
}

/** Run the in-Electron probe. Returns `null` when the binary cannot be executed at all. */
export function probeHost(executable, { execFile = execFileSync, timeoutMs = 20000 } = {}) {
  if (!executable) return null;
  try {
    const raw = execFile(executable, ['-e', HOST_PROBE_SCRIPT], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const parsed = JSON.parse(String(raw || '').trim());
    const roots = Array.isArray(parsed.moduleRoots) ? parsed.moduleRoots.filter((r) => typeof r === 'string' && r) : [];
    return {
      resourcesPath: String(parsed.resourcesPath || ''),
      moduleRoots: roots,
      cliPath: String(parsed.cliPath || ''),
      dshPackage: String(parsed.dshPackage || ''),
      version: String(parsed.version || ''),
    };
  } catch {
    /* Not fatal: an unversioned or unreachable host is reported as such by doctor. */
    return null;
  }
}

/**
 * Read the install's own version metadata with plain fs (no Electron). Only the layouts a
 * plain Node process can actually read are offered here; an `app.asar` package is deliberately
 * absent because reading it would require faking the answer.
 */
export function versionMetadataPaths(executable, { platform = process.platform } = {}) {
  if (!executable) return [];
  const isMacBundle = platform === 'darwin' || /\.app[\\/]Contents[\\/]MacOS[\\/]/i.test(executable);
  const base = isMacBundle ? path.dirname(path.dirname(executable)) : path.dirname(executable);
  const prefix = isMacBundle ? path.join(base, 'Resources') : path.join(base, 'resources');
  return [
    path.join(prefix, 'app', 'dsh', 'package.json'),
    path.join(prefix, 'app.asar.unpacked', 'dsh', 'package.json'),
    path.join(prefix, 'runtime', 'primary-runtime', 'runtime.json'),
  ];
}

/**
 * Best plain-fs version reading. `runtime.json` carries `desktopVersion`; a `dsh` package
 * carries `version`. Both are the install's own metadata, never a guess.
 */
export function readHostVersionMetadata(executable, { platform = process.platform, exists = defaultExists, readJson = defaultReadJson } = {}) {
  for (const file of versionMetadataPaths(executable, { platform })) {
    if (!exists(file)) continue;
    const json = readJson(file);
    if (!json) continue;
    const version = typeof json.version === 'string' ? json.version : (typeof json.desktopVersion === 'string' ? json.desktopVersion : '');
    if (version) return { version, source: file };
  }
  return { version: '', source: '' };
}

/** Compare dotted semver-ish strings; returns -1/0/1. */
export function compareVersions(a, b) {
  const norm = (v) => String(v || '0').split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const x = norm(a);
  const y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const l = x[i] ?? 0;
    const r = y[i] ?? 0;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : 1;
    return String(l) < String(r) ? -1 : 1;
  }
  return 0;
}

/**
 * Resolve the host. Explicit configuration wins, then the probed desktop layout, then
 * well-known install locations. A configured module root alone is still enough to load
 * plugins in a headless harness.
 *
 * @param {{executable?: string, moduleRoot?: string}} configured
 * @param {{
 *   platform?: string, env?: object, homedir?: (() => string) | string,
 *   exists?: (p: string) => boolean, readJson?: (p: string) => any,
 *   probe?: (exe: string) => object | null,
 * }} deps  injected seams; production callers pass nothing
 * @returns {{
 *   found: boolean, executable: string, moduleRoot: string, version: string,
 *   versionSource: string, source: string, candidates: string[],
 *   cliPath: string, cliExists: boolean | undefined, probed: object | null,
 * }}
 */
export function resolveHost(configured = {}, deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    homedir = os.homedir,
    exists = defaultExists,
    readJson = defaultReadJson,
    probe = probeHost,
  } = deps;

  const candidates = [];
  // A configured module root is a directory, not a program: it must never enter the executable
  // loop, or a headless "moduleRoot only" install gets reported as an executable and loses the
  // `config-module-root` verdict. (Measured defect in the pre-fix resolver.)
  const wanted = [configured.executable].filter(Boolean);
  candidates.push(...wanted);
  for (const exe of executableCandidates({ platform, env, homedir })) candidates.push(exe);

  const configuredModuleRoot = configured.moduleRoot && exists(configured.moduleRoot) ? configured.moduleRoot : '';

  for (const candidate of candidates) {
    if (!candidate) continue;
    const looksLikeExe = /\.exe$/i.test(candidate) || !path.extname(candidate) || candidate.endsWith('/Contents/MacOS/DeepSeek Harness');
    if (!looksLikeExe) continue;
    if (!exists(candidate)) continue;

    const probed = probe(candidate);
    const fromProbe = probed?.moduleRoots?.length ? probed.moduleRoots[0] : '';
    const moduleRoot = configuredModuleRoot || fromProbe || deriveModuleRoot(candidate, probed, { platform, exists });
    const version = probed?.version || readHostVersionMetadata(candidate, { platform, exists, readJson }).version;
    const versionSource = probed?.version ? 'probe' : (version ? 'metadata' : 'none');
    const cliPath = configuredModuleRoot
      ? cliEntryPath(configuredModuleRoot)
      : (probed?.cliPath && fromProbe === moduleRoot ? probed.cliPath : cliEntryPath(moduleRoot));
    return {
      found: true,
      executable: candidate,
      moduleRoot,
      version,
      versionSource,
      source: candidate === configured.executable ? 'config' : 'probe',
      candidates,
      cliPath,
      // `undefined` means "nobody verified it": the launcher must then check with plain fs.
      cliExists: configuredModuleRoot ? undefined : (probed?.cliPath && fromProbe === moduleRoot ? true : undefined),
      probed,
    };
  }

  // A moduleRoot alone is enough to load plugins in a headless harness.
  if (configuredModuleRoot) {
    return {
      found: true,
      executable: '',
      moduleRoot: configuredModuleRoot,
      version: '',
      versionSource: 'none',
      source: 'config-module-root',
      candidates,
      cliPath: cliEntryPath(configuredModuleRoot),
      cliExists: undefined,
      probed: null,
    };
  }

  return {
    found: false, executable: '', moduleRoot: '', version: '', versionSource: 'none',
    source: 'none', candidates, cliPath: '', cliExists: undefined, probed: null,
  };
}

/**
 * True for a path that points *into* the asar archive itself. A plain Node process cannot read
 * those, while `app.asar.unpacked` is a real directory and stays eligible.
 */
export function isAsarArchivePath(candidate) {
  return String(candidate || '')
    .split(/[\\/]/)
    .some((segment) => segment === 'app.asar');
}

/**
 * Offline fallback when the probe is unavailable: walk the known layout candidates and keep
 * the first one whose CLI entry really exists. A root inside `app.asar` is unreachable from
 * plain Node, so it is never selected here — the in-Electron probe is the only honest way to
 * select it, and doctor reports the difference instead of pretending.
 */
export function deriveModuleRoot(executable, probed = null, { platform = process.platform, exists = defaultExists } = {}) {
  const sources = { executable, platform, dshPackage: probed?.dshPackage || '' };
  for (const candidate of moduleRootCandidates(sources)) {
    if (isAsarArchivePath(candidate)) continue;
    if (exists(cliEntryPath(candidate))) return candidate;
  }
  return '';
}

/** Compatibility verdict for doctor; never throws. */
export function checkCompatibility(version) {
  if (!version) return { ok: false, level: 'unknown', message: '未检测到 DSH 宿主版本，无法判定兼容性。' };
  if (compareVersions(version, COMPATIBILITY.minimum) < 0) {
    return { ok: false, level: 'unsupported', message: `宿主 ${version} 低于最低支持版本 ${COMPATIBILITY.minimum}。` };
  }
  if (compareVersions(version, COMPATIBILITY.verifiedAgainst) > 0) {
    return { ok: true, level: 'newer', message: `宿主 ${version} 高于已验证版本 ${COMPATIBILITY.verifiedAgainst}，未实测。` };
  }
  return { ok: true, level: 'verified', message: `宿主 ${version} 在已验证范围内。` };
}

export default {
  resolveHost, checkCompatibility, COMPATIBILITY, compareVersions,
  executableCandidates, moduleRootCandidates, cliEntryPath, deriveModuleRoot, isAsarArchivePath,
  probeHost, readHostVersionMetadata, versionMetadataPaths, HOST_CLI_PACKAGE, HOST_PROBE_SCRIPT,
};
