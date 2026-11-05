/**
 * DSH host discovery and compatibility probing.
 *
 * The suite never bundles the harness: it finds an existing installation, records
 * where it is, and checks the version it can actually load against. Nothing here
 * writes outside the suite directory.
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

const CANDIDATE_PATHS = () => {
  const home = os.homedir();
  const out = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
    }
    if (process.env.ProgramFiles) {
      out.push(path.join(process.env.ProgramFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'));
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness');
    out.push(path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness'));
  } else {
    out.push('/opt/DeepSeek Harness/deepseek-harness');
    out.push('/usr/lib/deepseek-harness/deepseek-harness');
    out.push(path.join(home, '.local', 'bin', 'deepseek-harness'));
  }
  return out;
};

function probeVersion(exe) {
  // `<exe> -e "<js>"` works because the desktop binary embeds Node and honours ELECTRON_RUN_AS_NODE.
  const script = "process.stdout.write(require('node:path').join(process.resourcesPath||'', 'app', 'dsh', 'package.json'))";
  try {
    const out = execFileSync(exe, ['-e', script], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out && fs.existsSync(out)) {
      const pkg = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
      return { version: pkg.version || '', dshPackage: out };
    }
  } catch {
    /* not fatal: an unversioned host is reported as such by doctor */
  }
  return { version: '', dshPackage: '' };
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
 * Resolve the host. `configured` wins; otherwise probe well-known install locations.
 * @returns {{found:boolean, executable:string, moduleRoot:string, version:string, source:string, candidates:string[]}}
 */
export function resolveHost(configured = {}) {
  const candidates = [];
  const wanted = [configured.executable, configured.moduleRoot].filter(Boolean);
  candidates.push(...wanted);

  for (const exe of CANDIDATE_PATHS()) candidates.push(exe);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const looksLikeExe = /\.exe$/i.test(candidate) || !path.extname(candidate) || candidate.endsWith('/Contents/MacOS/DeepSeek Harness');
    if (!looksLikeExe) continue;
    if (!fs.existsSync(candidate)) continue;
    const probed = probeVersion(candidate);
    const moduleRoot = configured.moduleRoot && fs.existsSync(configured.moduleRoot)
      ? configured.moduleRoot
      : deriveModuleRoot(candidate, probed.dshPackage);
    return {
      found: true,
      executable: candidate,
      moduleRoot,
      version: probed.version,
      source: candidate === configured.executable ? 'config' : 'probe',
      candidates,
    };
  }

  // A moduleRoot alone is enough to load plugins in a headless harness.
  if (configured.moduleRoot && fs.existsSync(configured.moduleRoot)) {
    return {
      found: true,
      executable: '',
      moduleRoot: configured.moduleRoot,
      version: '',
      source: 'config-module-root',
      candidates,
    };
  }

  return { found: false, executable: '', moduleRoot: '', version: '', source: 'none', candidates };
}

function deriveModuleRoot(exe, dshPackage) {
  if (dshPackage) {
    const root = path.join(path.dirname(dshPackage), 'node_modules');
    if (fs.existsSync(root)) return root;
  }
  const dir = path.dirname(exe);
  const guesses = [
    path.join(dir, 'resources', 'app', 'dsh', 'node_modules'),
    path.join(path.dirname(dir), 'Resources', 'app', 'dsh', 'node_modules'),
  ];
  for (const guess of guesses) if (fs.existsSync(guess)) return guess;
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

export default { resolveHost, checkCompatibility, COMPATIBILITY, compareVersions };
