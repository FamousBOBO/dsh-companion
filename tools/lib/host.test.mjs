/**
 * Host discovery matrix (docs/20 §4 → non-ui-audit-plan-20261116 P1「修复宿主布局探测」).
 *
 * Every case runs against injected `exists`/`readJson`/`probe` seams plus a fake
 * `LOCALAPPDATA`, so the whole decision matrix is asserted without starting a desktop host,
 * without spawning `DeepSeek Harness.exe`, and without reading this machine's installation.
 * The layout names are the real ones measured on desktop 0.2.2-rc.1; every path is synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import {
  resolveHost, deriveModuleRoot, moduleRootCandidates, cliEntryPath, executableCandidates,
  readHostVersionMetadata, checkCompatibility, isAsarArchivePath, HOST_CLI_PACKAGE,
} from './host.mjs';

const FAKE_LOCALAPPDATA = path.resolve(path.join('fake-localappdata'));
const EXE = path.join(FAKE_LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
const RESOURCES = path.join(path.dirname(EXE), 'resources');
const ASAR_ROOT = path.join(RESOURCES, 'app.asar', 'dsh', 'node_modules');
const UNPACKED_ROOT = path.join(RESOURCES, 'app.asar.unpacked', 'dsh', 'node_modules');
const CLASSIC_ROOT = path.join(RESOURCES, 'app', 'dsh', 'node_modules');
const CONFIGURED_ROOT = path.resolve(path.join('fake-data', 'host-runtime', 'node_modules'));
const CLI = (root) => cliEntryPath(root);
const IS_WIN = process.platform === 'win32';

/** The hidden install this fake layout is pinned to: only paths in `vfs()` exist. */
const FAKE_ROOT = { platform: 'win32', env: { LOCALAPPDATA: FAKE_LOCALAPPDATA }, homedir: () => '' };

/** A tiny virtual filesystem: a set of absolute paths that "exist", plus JSON contents. */
function vfs(paths) {
  const set = new Set(paths.map((p) => path.resolve(p)));
  const files = new Map();
  return {
    exists: (p) => set.has(path.resolve(String(p))),
    add(p) { set.add(path.resolve(p)); },
    addJson(p, value) { set.add(path.resolve(p)); files.set(path.resolve(p), value); },
    readJson: (p) => files.get(path.resolve(p)) ?? null,
  };
}

/** Resolve against the fake install; `probe` defaults to "the binary could not run". */
function resolve(configured, deps = {}) {
  return resolveHost(configured, {
    exists: deps.exists,
    readJson: deps.readJson,
    probe: deps.probe ?? (() => null),
    ...FAKE_ROOT,
  });
}

function probeResult({ root, cli, version, dshPackage }) {
  return {
    resourcesPath: RESOURCES,
    moduleRoots: root ? [root] : [],
    cliPath: cli || '',
    dshPackage: dshPackage || '',
    version: version || '',
  };
}

test('常规 resources/app/dsh 布局：没有探针时靠 plain fs 回落也能找到入口', () => {
  const fsMock = vfs([EXE, CLI(CLASSIC_ROOT)]);
  const host = resolve({}, { exists: fsMock.exists, readJson: fsMock.readJson });
  assert.equal(host.found, true);
  assert.equal(host.executable, EXE);
  assert.equal(host.moduleRoot, CLASSIC_ROOT);
  assert.equal(host.source, 'probe');
});

test('app.asar.unpacked 布局：探针报告的 unpacked root 被采用（旧代码漏掉的那一种）', () => {
  const fsMock = vfs([EXE, CLI(UNPACKED_ROOT)]);
  const host = resolve({}, {
    exists: fsMock.exists,
    readJson: fsMock.readJson,
    probe: () => probeResult({ root: UNPACKED_ROOT, cli: CLI(UNPACKED_ROOT) }),
  });
  assert.equal(host.moduleRoot, UNPACKED_ROOT);
  assert.equal(host.cliPath, CLI(UNPACKED_ROOT));
  assert.equal(host.cliExists, true);
  assert.equal(host.versionSource, 'none', 'probe 没给版本时不许编版本');
});

test('app.asar 布局：plain node 看不到 asar，探针结论必须保留而不是被 existsSync 否掉', () => {
  const fsMock = vfs([EXE]); // CLI(ASAR_ROOT) deliberately absent: plain Node cannot read asar
  const host = resolve({}, {
    exists: fsMock.exists,
    readJson: fsMock.readJson,
    probe: () => probeResult({ root: ASAR_ROOT, cli: CLI(ASAR_ROOT), version: '0.2.2-rc.1' }),
  });
  assert.equal(host.moduleRoot, ASAR_ROOT);
  assert.equal(host.cliExists, true, 'probe verdict wins over an fs check that cannot see asar');
  assert.equal(host.version, '0.2.2-rc.1');
  assert.equal(host.versionSource, 'probe');
});

test('显式 moduleRoot 优先级最高，版本仍可来自宿主机探测', () => {
  const fsMock = vfs([EXE, CONFIGURED_ROOT, CLI(CONFIGURED_ROOT), CLI(ASAR_ROOT)]);
  const host = resolve({ executable: EXE, moduleRoot: CONFIGURED_ROOT }, {
    exists: fsMock.exists,
    readJson: fsMock.readJson,
    probe: () => probeResult({ root: ASAR_ROOT, cli: CLI(ASAR_ROOT), version: '0.2.2-rc.1' }),
  });
  assert.equal(host.source, 'config');
  assert.equal(host.moduleRoot, CONFIGURED_ROOT);
  assert.equal(host.version, '0.2.2-rc.1');
  assert.equal(host.cliPath, CLI(CONFIGURED_ROOT));
  // A configured root is verified by plain fs, so the record claims no probe verdict.
  assert.equal(host.cliExists, undefined);
});

test('headless：只配 moduleRoot 也能就绪，且不编版本', () => {
  const fsMock = vfs([CONFIGURED_ROOT, CLI(CONFIGURED_ROOT)]);
  const host = resolve({ moduleRoot: CONFIGURED_ROOT }, { exists: fsMock.exists, readJson: fsMock.readJson });
  assert.equal(host.found, true);
  assert.equal(host.executable, '');
  assert.equal(host.source, 'config-module-root');
  assert.equal(host.version, '');
  assert.equal(host.versionSource, 'none');
  assert.equal(checkCompatibility(host.version).level, 'unknown');
});

test('可执行文件存在但入口缺失：探针什么也没找到，moduleRoot 为空且如实报告', () => {
  const fsMock = vfs([EXE]);
  const host = resolve({}, { exists: fsMock.exists, readJson: fsMock.readJson, probe: () => probeResult({}) });
  assert.equal(host.found, true);
  assert.equal(host.moduleRoot, '');
  assert.equal(host.cliPath, '');
  assert.equal(host.cliExists, undefined);
});

test('元数据损坏：退回 runtime.json 的 desktopVersion，不猜版本', () => {
  const runtimeJson = path.join(RESOURCES, 'runtime', 'primary-runtime', 'runtime.json');
  const brokenPkg = path.join(RESOURCES, 'app', 'dsh', 'package.json');
  const readJson = (p) => {
    if (path.resolve(p) === path.resolve(brokenPkg)) return null; // exists but unparsable
    if (path.resolve(p) === path.resolve(runtimeJson)) return { desktopVersion: '0.2.2-rc.1' };
    return null;
  };
  const meta = readHostVersionMetadata(EXE, { platform: 'win32', exists: () => true, readJson });
  assert.equal(meta.version, '0.2.2-rc.1');
  assert.match(meta.source.replaceAll(path.sep, '/'), /runtime\/primary-runtime\/runtime\.json$/);
});

test('元数据全都读不到：版本保持空，checkCompatibility 报 unknown 而不是猜', () => {
  const fsMock = vfs([EXE]);
  const host = resolve({}, {
    exists: fsMock.exists,
    readJson: () => null,
    probe: () => probeResult({ root: CLASSIC_ROOT, cli: CLI(CLASSIC_ROOT) }),
  });
  assert.equal(host.version, '');
  assert.equal(host.versionSource, 'none');
  assert.equal(checkCompatibility(host.version).level, 'unknown');
});

test('版本低于最低要求时判定 unsupported，高于已验证版本标 newer', () => {
  assert.equal(checkCompatibility('0.1.9').level, 'unsupported');
  assert.equal(checkCompatibility('0.2.0').level, 'verified');
  assert.equal(checkCompatibility('0.2.2-rc.1').level, 'newer');
});

test('deriveModuleRoot 只返回 plain node 真能读的目录：app.asar 内部一律跳过', () => {
  const fsMock = vfs([CLI(ASAR_ROOT), CLI(UNPACKED_ROOT)]);
  const root = deriveModuleRoot(EXE, null, { platform: 'win32', exists: fsMock.exists });
  assert.equal(root, UNPACKED_ROOT);
  assert.equal(isAsarArchivePath(ASAR_ROOT), true);
  assert.equal(isAsarArchivePath(UNPACKED_ROOT), false, 'app.asar.unpacked 是真实目录，必须可选');
});

test('moduleRootCandidates 覆盖三种布局，asar 排在最前（与安装自带的 dsh.cmd 一致）', () => {
  const candidates = moduleRootCandidates({ executable: EXE, platform: 'win32' });
  assert.deepEqual(candidates, [ASAR_ROOT, UNPACKED_ROOT, CLASSIC_ROOT]);
});

test('macOS bundle 的 layout 从 Contents/Resources 推出，而不是 MacOS/resources', () => {
  const exe = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
  const posix = (p) => p.replaceAll(path.sep, '/');
  const candidates = moduleRootCandidates({ executable: exe, platform: 'darwin' }).map(posix);
  assert.ok(candidates.includes('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules'));
  assert.ok(candidates.every((c) => !c.includes('Contents/MacOS/resources')));
});

test('可执行文件候选表按平台生成，Windows 只看 LOCALAPPDATA / ProgramFiles', () => {
  const win = executableCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:/fake/AppData/Local', ProgramFiles: 'C:/fake/Program Files' }, homedir: () => '' });
  assert.equal(win.length, 2);
  assert.match(win[0], /DeepSeek Harness\.exe$/);
  const none = executableCandidates({ platform: 'win32', env: {}, homedir: () => '' });
  assert.equal(none.length, 0, '没有安装目录环境变量时不许编路径');
});

test('HOST_CLI_PACKAGE 是宿主的 CLI 包名，入口路径由它派生', () => {
  assert.equal(HOST_CLI_PACKAGE, '@deepseek-ai/dsh-desktop-host');
  assert.match(cliEntryPath(ASAR_ROOT).replaceAll(path.sep, '/'), /@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js$/);
});

test('布局探测不依赖本机安装目录：默认 exists 是 fs.existsSync 时也不会被这些合成路径命中', () => {
  // Guard for the plan's acceptance line "测试不访问本机安装目录": the fake roots below do not
  // exist on any machine, so a real install can never be substituted for them.
  assert.equal(IS_WIN ? fsExists(EXE) : false, false);
});

function fsExists(p) {
  try {
    return nodeFs.existsSync(p);
  } catch {
    return false;
  }
}
