/**
 * Host orchestration for the DSH Companion suite.
 *
 * The suite never bundles DeepSeek Harness: it drives an existing installation.
 * Every call goes through the same shape —
 *
 *   <install>/DeepSeek Harness.exe --expose-internals <moduleRoot>/@deepseek-ai/dsh-desktop-host/lib/cli.js <args>
 *
 * with `ELECTRON_RUN_AS_NODE=1` and `DSH_HOME` pointing at the suite's own
 * profile home. No shell, no `.cmd` shim, no PowerShell: `execFile`/`spawn` with
 * an argument array behaves identically on Windows, macOS and Linux, and never
 * re-parses quotes out of a path that contains spaces or non-ASCII characters.
 *
 * Nothing here writes outside the suite directory; `DSH_HOME` is decided by the
 * caller (`dataPaths(config).home`) and validated before it is used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** The package inside the host installation that carries the CLI entry point. */
export const HOST_CLI_PACKAGE = '@deepseek-ai/dsh-desktop-host';

/** Argument the desktop binary needs in order to behave like plain Node. */
const ELECTRON_ENV = 'ELECTRON_RUN_AS_NODE';

/** Output cap for `--dump-config` and other chatty subcommands (bytes). */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/** How the composed web app announces its address. */
export const WEB_URL_PATTERN = /dsh web:\s*(https?:\/\/[^\s?]+\?token=[^\s]+)/;

/**
 * Resolve the CLI entry point under a module root.
 * @param {string} moduleRoot `<install>/resources/app/dsh/node_modules`
 * @returns {{path: string, exists: boolean}}
 */
export function hostCliPath(moduleRoot) {
  if (!moduleRoot) return { path: '', exists: false };
  const cliPath = path.join(moduleRoot, HOST_CLI_PACKAGE, 'lib', 'cli.js');
  return { path: cliPath, exists: fs.existsSync(cliPath) };
}

/**
 * Decide how to launch the host CLI from what `resolveHost()` returned.
 *
 * Preferred: the desktop executable itself (it embeds Node and honours
 * `ELECTRON_RUN_AS_NODE`). Fallback: a plain `node` binary running the same
 * `cli.js` — useful on a headless machine where only the runtime tree was
 * copied. The fallback is reported as such, never silently substituted.
 *
 * @param {{executable?: string, moduleRoot?: string}} host
 * @param {{nodeExecutable?: string}} [opts]
 * @returns {{ready: boolean, command: string, cliPath: string, launcher: string, reason: string}}
 */
export function describeLauncher(host = {}, opts = {}) {
  const { path: cliPath, exists } = hostCliPath(host.moduleRoot);
  const executable = host.executable || '';
  const hasExe = Boolean(executable) && fs.existsSync(executable);

  if (!hasExe && !exists) {
    return {
      ready: false,
      command: '',
      cliPath,
      launcher: 'none',
      reason: executable
        ? `宿主可执行文件不存在：${executable}`
        : '未检测到 DeepSeek Harness 宿主可执行文件',
    };
  }
  if (hasExe && !exists) {
    return {
      ready: false,
      command: executable,
      cliPath,
      launcher: 'desktop-exe',
      reason: `宿主目录里找不到 CLI 入口：${cliPath}`,
    };
  }
  if (hasExe) {
    return { ready: true, command: executable, cliPath, launcher: 'desktop-exe', reason: '' };
  }
  const node = opts.nodeExecutable || process.execPath;
  return {
    ready: true,
    command: node,
    cliPath,
    launcher: 'node',
    reason: `未找到桌面可执行文件，改用 ${node} 直接运行宿主 CLI（可能与桌面端行为不同）。`,
  };
}

/** Environment for one host invocation. Explicit beats inherited. */
export function dshEnv({ home, moduleRoot, env = process.env } = {}) {
  const out = { ...env, [ELECTRON_ENV]: '1' };
  if (home) out.DSH_HOME = home;
  // A nested DSH_HOME/profile override in the parent shell would silently point
  // the child at the wrong profile home; the caller's value wins.
  if (!home) delete out.DSH_HOME;
  // Plugins that import the host's own packages (@deepseek-ai/dsh-tools and friends) need the
  // module root spelled out. A fresh shell has no reason to know it, so the launcher that
  // already resolved the host must pass it down; without this the companion preset fails to
  // start even though the host itself boots.
  if (moduleRoot) out.DSH_COMPANION_MODULE_ROOT = moduleRoot;
  return out;
}

function normalizeFailure(err, context) {
  const code = typeof err?.status === 'number' ? err.status : null;
  const timedOut = err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' && code === null;
  const base = {
    ok: false,
    code,
    signal: err?.signal ?? null,
    timedOut,
    stdout: String(err?.stdout ?? ''),
    stderr: String(err?.stderr ?? ''),
    error: err?.message || String(err),
    ...context,
  };
  if (err?.code === 'ENOENT') {
    base.error = `无法执行宿主命令（文件不存在或不可执行）：${context.command}`;
  } else if (timedOut) {
    base.error = `${context.command} 在 ${context.timeoutMs} ms 内没有结束（已终止）`;
  } else if (code !== null) {
    base.error = `${context.command} 以退出码 ${code} 结束`;
  }
  return base;
}

/**
 * Run one host CLI command synchronously and normalise the result.
 *
 * Never throws for "the host said no": a non-zero exit is a normal outcome that
 * callers report. It only throws when the caller passed nonsense.
 *
 * @param {string[]} args CLI arguments, without the `--expose-internals` prefix
 * @param {{host: object, dshHome: string, timeoutMs?: number, env?: object, launcher?: object}} opts
 * @returns {{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean,
 *            error: string, command: string, args: string[], launcher: string, durationMs: number}}
 */
export function runDsh(args, { host, dshHome, timeoutMs = 120000, env, launcher } = {}) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('runDsh() needs a non-empty argument list');
  const resolved = launcher || describeLauncher(host);
  const started = Date.now();
  const context = {
    command: resolved.command,
    args: ['--expose-internals', resolved.cliPath, ...args],
    launcher: resolved.launcher,
    timeoutMs,
  };

  if (!resolved.ready) {
    return { ...normalizeFailure(new Error(resolved.reason), context), durationMs: 0 };
  }

  try {
    const stdout = spawnSync(resolved.command, context.args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER,
      windowsHide: true,
      env: dshEnv({ home: dshHome, moduleRoot: host?.moduleRoot, env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (stdout.error) throw stdout.error;
    return {
      ok: stdout.status === 0,
      code: stdout.status,
      signal: stdout.signal ?? null,
      timedOut: false,
      stdout: stdout.stdout ?? '',
      stderr: stdout.stderr ?? '',
      error: stdout.status === 0 ? '' : `${resolved.command} 以退出码 ${stdout.status} 结束`,
      ...context,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const failed = normalizeFailure(err, context);
    return { ...failed, durationMs: Date.now() - started };
  }
}

/** Boot a profile through the web app, streaming its output into a log file. */
export function spawnDsh(args, { host, dshHome, logFile, env, launcher, cwd } = {}) {
  const resolved = launcher || describeLauncher(host);
  if (!resolved.ready) throw new Error(resolved.reason);
  if (!logFile) throw new Error('spawnDsh() needs a log file so the child never blocks on a full pipe');

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  try {
    const child = spawn(resolved.command, ['--expose-internals', resolved.cliPath, ...args], {
      env: dshEnv({ home: dshHome, moduleRoot: host?.moduleRoot, env }),
      cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      // Own process group on POSIX so `stop` can signal the whole tree, and so
      // the child survives the terminal that launched it.
      detached: process.platform !== 'win32',
    });
    return { child, logPath: logFile, launcher: resolved.launcher, command: resolved.command };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Compose a profile's tree without mounting it.
 * @returns {{ok: boolean, code: number|null, text: string, stderr: string, error: string, durationMs: number}}
 */
export function dumpConfig({ host, dshHome, profile, patchFiles = [], timeoutMs = 120000, env, launcher }) {
  const args = ['--profile', profile];
  for (const file of patchFiles) args.push('--patch', file);
  args.push('--dump-config');
  const result = runDsh(args, { host, dshHome, timeoutMs, env, launcher });
  return {
    ok: result.ok,
    code: result.code,
    text: result.stdout,
    stderr: result.stderr,
    error: result.error,
    durationMs: result.durationMs,
    command: result.command,
    args: result.args,
  };
}

/**
 * Create a profile from a shipped default profile, if it does not exist yet.
 *
 * `--from-default-profile` replaces an existing profile, so this must only run
 * when the target is absent: an operator's hand-edited profile is never touched.
 */
export function createProfile({ host, dshHome, profile, template = 'web', timeoutMs = 180000, env, launcher }) {
  const exists = profileExists(dshHome, profile);
  if (exists) {
    return {
      ok: true, created: false, code: 0,
      message: `profile 已存在，保持原样：${profileDir(dshHome, profile)}`,
      profileDir: profileDir(dshHome, profile),
    };
  }
  const result = runDsh(['--profile', profile, '--from-default-profile', template, '--dump-config'], {
    host, dshHome, timeoutMs, env, launcher,
  });
  return {
    ok: result.ok,
    created: result.ok,
    code: result.code,
    message: result.ok
      ? `已从默认 profile “${template}” 创建 profile “${profile}”`
      : `创建 profile 失败：${result.error}${result.stderr ? `\n${result.stderr.trim().slice(-1500)}` : ''}`,
    stderr: result.stderr,
    profileDir: profileDir(dshHome, profile),
  };
}

/** Install one local package directory into a profile (bundled pnpm, offline-capable for directories). */
export function addPlugin({ host, dshHome, profile, directory, timeoutMs = 300000, env, launcher }) {
  const result = runDsh(['plugin', '--profile', profile, 'add', directory], {
    host, dshHome, timeoutMs, env, launcher,
  });
  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    durationMs: result.durationMs,
    directory,
  };
}

/** Absolute directory of one profile inside a DSH home. */
export function profileDir(dshHome, profile) {
  return path.join(dshHome, 'profiles', profile);
}

/** True when the profile already has a package.json (i.e. is usable). */
export function profileExists(dshHome, profile) {
  return fs.existsSync(path.join(profileDir(dshHome, profile), 'package.json'));
}

/** Read a profile's package.json, or null. */
export function readProfilePackage(dshHome, profile) {
  const file = path.join(profileDir(dshHome, profile), 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** Package names a profile composes as bundle layers. */
export function profileBundles(dshHome, profile) {
  const pkg = readProfilePackage(dshHome, profile);
  const bundles = pkg?.dsh?.profile?.bundles;
  return Array.isArray(bundles) ? bundles.slice() : [];
}

/** Output text of a `--dump-config` run, split into the entry ids the loader composed. */
export function dumpEntryIds(text) {
  const ids = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/**
 * Every `file://` URL a composed tree points at (used to catch dead plugin paths).
 *
 * Line-based on purpose: a URL is the rest of its YAML line, and an install directory may
 * legitimately contain spaces (`…/DSH clean 20261105/plugins/…`). Matching `[^\s]+` silently
 * truncated such URLs at the first space, which made doctor report a path that does not exist
 * while the host loaded it fine.
 */
/**
 * `file://` values out of a patch file this suite generated.
 *
 * Preferred over `dumpFileUrls` for existence checks: the generator quotes every value
 * (`name: 'file://…'`), which makes the boundary unambiguous whatever the path contains. The
 * host's own YAML rendering may fold a long scalar across lines, so scraping the dump cannot be
 * made reliable for paths containing spaces — which is exactly how doctor came to report a
 * truncated path for an install directory with a space in its name.
 */
export function patchFileUrls(text) {
  const urls = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const quoted = /'(file:\/\/[^']*)'/.exec(raw) || /"(file:\/\/[^"]*)"/.exec(raw);
    if (quoted) {
      urls.add(quoted[1]);
      continue;
    }
    const at = raw.indexOf('file://');
    if (at === -1) continue;
    const plain = raw.slice(at).trim().replace(/\s+#.*$/, '');
    if (plain.length > 'file://'.length) urls.add(plain);
  }
  return [...urls];
}

export function dumpFileUrls(text) {
  const urls = new Set();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const at = rawLine.indexOf('file://');
    if (at === -1) continue;
    let candidate = rawLine.slice(at).trim();
    candidate = candidate.replace(/^['"]/, '').replace(/['"]$/, ''); // quoted scalar
    candidate = candidate.replace(/\s+#.*$/, ''); // trailing YAML comment
    candidate = candidate.replace(/[),;]+$/, ''); // list/flow punctuation
    if (candidate.length > 'file://'.length) urls.add(candidate);
  }
  return [...urls];
}

/** The first web URL the host printed, or ''. */
export function parseWebUrl(text) {
  const match = WEB_URL_PATTERN.exec(String(text || ''));
  return match ? match[1] : '';
}

/**
 * Turn a `file:///C:/x` style URL back into a filesystem path (for existence checks).
 *
 * A `?query` / `#fragment` suffix is not part of the path. Operators add cache-busting
 * queries to hand-edited patch entries (`index.mjs?reading=2`), and the host's own
 * loader ignores them; an existence check that kept them reported the plugin as missing
 * while the same file loaded fine at runtime. Strip them before decoding.
 */
export function fileUrlToPath(url) {
  try {
    const raw = String(url).replace(/^file:\/\//, '');
    const withoutQuery = raw.replace(/[?#][^]*$/, '');
    // `file:///C:/a/b` → `/C:/a/b`; strip the leading slash on Windows.
    const withoutScheme = decodeURIComponent(withoutQuery);
    const stripped = withoutScheme.replace(/^\/([A-Za-z]:)/, '$1');
    return path.normalize(stripped);
  } catch {
    return '';
  }
}

export default {
  HOST_CLI_PACKAGE,
  WEB_URL_PATTERN,
  hostCliPath,
  describeLauncher,
  dshEnv,
  runDsh,
  spawnDsh,
  dumpConfig,
  createProfile,
  addPlugin,
  profileDir,
  profileExists,
  readProfilePackage,
  profileBundles,
  dumpEntryIds,
  patchFileUrls,
  dumpFileUrls,
  parseWebUrl,
  fileUrlToPath,
};
