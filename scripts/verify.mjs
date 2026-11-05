#!/usr/bin/env node
/**
 * Release verification.
 *
 * Three independent groups, matching what docs/01 and CI rely on:
 *   unit     per-module offline tests (`node --test` or the package's test script)
 *   static   packaging metadata, source-tree hygiene, and leak scanning
 *   compose  host composition check (`dsh --dump-config`)
 *
 * Honesty rules baked in here:
 *   - a module with no tests is reported as "no tests", never as passing;
 *   - `compose` without a DSH host prints SKIPPED and does not fail the run;
 *   - any real failure exits 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SUITE_ROOT, SUITE_PATHS } from '../tools/lib/paths.mjs';
import { loadConfig, enabledModules } from '../tools/lib/config.mjs';

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const groups = onlyArg
  ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : ['unit', 'static', 'compose'];
const want = (g) => groups.includes(g);
const isWindows = process.platform === 'win32';

/**
 * Invoke npm without a shell. When this script runs under `npm run`, npm_execpath points at
 * npm's own JS entry, so we can spawn `node <npm-cli.js> …` and avoid both the shell (and its
 * argument-concatenation warning) and any quoting questions. Falls back to the shell only when
 * the script is invoked directly outside npm.
 */
const NPM_EXECPATH = process.env.npm_execpath;
/** A leaked `npm_config_workspaces` collides with our explicit `--workspace`. Strip it. */
function cleanEnv() {
  const env = { ...process.env, CI: '1' };
  for (const key of Object.keys(env)) {
    if (/^npm_config_workspaces?$/i.test(key)) delete env[key];
  }
  return env;
}
function npmSpawn(args, options) {
  if (NPM_EXECPATH && /npm-cli\.js$/.test(NPM_EXECPATH)) {
    return spawnSync(process.execPath, [NPM_EXECPATH, ...args], { ...options, shell: false });
  }
  return spawnSync(isWindows ? 'npm.cmd' : 'npm', args, { ...options, shell: isWindows });
}

const summary = { unit: {}, static: {}, compose: {} };
let failures = 0;
let skips = 0;

function section(title) {
  console.log(`\n═══ ${title} ═══`);
}

function record(group, name, status, detail = '') {
  summary[group][name] = { status, detail };
  const icon = status === 'ok' ? '✓' : status === 'skipped' ? '○' : status === 'no-tests' ? '·' : '✗';
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (status === 'failed') failures += 1;
  if (status === 'skipped' || status === 'no-tests') skips += 1;
}

function readPkg(dir) {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function listModules() {
  if (!fs.existsSync(SUITE_PATHS.plugins)) return [];
  return fs
    .readdirSync(SUITE_PATHS.plugins, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(SUITE_PATHS.plugins, e.name);
      return { dirName: e.name, dir, pkg: readPkg(dir) };
    });
}

const modules = listModules();

/* ─────────────────────────── unit ─────────────────────────── */
function runUnit() {
  section('unit — 逐模块离线测试');
  for (const m of modules) {
    const label = m.pkg?.name || m.dirName;
    const testScript = m.pkg?.scripts?.test;
    const hasTestDirs =
      fs.existsSync(path.join(m.dir, 'test')) || fs.existsSync(path.join(m.dir, 'tests'));
    const hasTestFiles = fs
      .readdirSync(m.dir, { withFileTypes: true })
      .some((e) => e.isFile() && /\.test\.(mjs|cjs|js|ts)$/.test(e.name));

    if (!testScript && !hasTestDirs && !hasTestFiles) {
      record('unit', label, 'no-tests', '该模块没有测试');
      continue;
    }

    // Run through npm from the suite root: invoking npm inside a workspace directory makes
    // npm fight over --workspace/--no-workspaces. `--workspace` needs a resolvable name, so
    // a package without one falls back to running the module's tests directly.
    let res;
    if (testScript && m.pkg?.name) {
      res = npmSpawn(['run', 'test', `--workspace=${m.pkg.name}`], {
        cwd: SUITE_ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
        env: cleanEnv(),
        timeout: 20 * 60 * 1000,
      });
    } else {
      res = spawnSync(process.execPath, ['--test'], {
        cwd: m.dir,
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
        timeout: 20 * 60 * 1000,
      });
    }

    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (res.status === 0) {
      const passMatch = out.match(/# pass (\d+)/);
      record('unit', label, 'ok', passMatch ? `${passMatch[1]} 个测试通过` : '通过');
    } else {
      // Name the failing tests instead of only echoing the tail: a 1200-test suite can fail on
      // one assertion many screens above the end of its output, which makes a red run useless
      // for diagnosis. Fall back to the tail when the reporter printed no test names.
      const named = out
        .split('\n')
        .filter((l) => /^\s*(?:✖|not ok)\s/.test(l))
        .map((l) => l.trim())
        .slice(0, 8);
      const tail = out.trim().split('\n').slice(-12).join('\n      ');
      const detail = named.length
        ? `exit ${res.status}\n      失败用例：\n      ${named.join('\n      ')}`
        : `exit ${res.status}\n      ${tail}`;
      record('unit', label, 'failed', detail);
    }
  }
}

/* ────────────────────────── static ────────────────────────── */
const LEAK_RULES = [
  ['persona-三月七', /三月七|小七|sanyueqi/],
  ['author-path', /[A-Za-z]:[\\/](?:Users[\\/][A-Za-z0-9_.-]+|Bot[\\/]dsh-companion)/i],
  ['author-name', /FamousBOBO|bobo-march7/i],
  ['legacy-persona-id', /\bmarch7\b/],
];

// Secret-shaped strings legitimately appear in fixtures. These rules therefore skip
// test trees; the leak rules above never do.
const SECRET_RULES = [
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['bearer', /Bearer\s+[A-Za-z0-9._-]{24,}/],
];

/** Files whose own text is the rule table — scanning them is a guaranteed false positive. */
const SCAN_SELF_EXCLUDE = new Set(['scripts/verify.mjs']);

/**
 * Local, generated, git-ignored files. They legitimately contain this machine's absolute
 * paths (they are produced by substituting the real suite root), and they are never
 * published, so scanning them would only produce noise.
 */
const LOCAL_ONLY = new Set([
  'config/suite.json',
  'config/persona.md',
  'config/profile/companion.patch.yml',
]);

/**
 * Audited exception mechanism. A file that must contain a forbidden literal can declare it
 * on its own comment line:
 *
 *     // leak-scan-allow: persona-三月七  (regression guard: asserts the old name is gone)
 *
 * Three deliberate limits:
 *   - the marker must be a whole comment line, not prose inside a sentence;
 *   - markdown files can never grant an exemption, so documenting this mechanism cannot
 *     silently whitelist the documentation itself;
 *   - it covers exactly one rule name, in one file.
 */
function allowedIn(text, rule, ext) {
  if (ext === '.md' || ext === '.mdx') return false;
  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The trailing guard must not be `\b`: rule names can end in CJK (persona-三月七), where
  // `\b` never matches, which silently disabled the exemption. `(?![\w-])` rejects only a
  // continuation into ASCII word characters, which is what we actually want.
  return new RegExp(
    `^[ \\t]*(?://|#|/\\*|\\*)[ \\t]*leak-scan-allow:[^\\n]*${escaped}(?![\\w-])`,
    'm',
  ).test(text);
}

/** Test trees, where placeholder credentials are expected and required. */
const TEST_TREE = /(^|\/)(test|tests|fixtures)(\/|$)|\.test\.(mjs|cjs|js|ts)$/;

const SCAN_EXT = new Set([
  '.mjs', '.js', '.cjs', '.ts', '.tsx', '.json', '.jsonl', '.yml', '.yaml', '.md',
  '.css', '.html', '.svg', '.py', '.ps1', '.sh', '.txt', '.toml', '.example',
]);

function walk(dir, acc = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * The set of files that would actually be published: everything git tracks plus everything git
 * does not ignore. Using git here is what makes the artifact and leak checks meaningful — a local
 * `npm run build` output is git-ignored, so scanning the working directory would report phantom
 * failures for files that are never committed. Falls back to a directory walk outside a git
 * checkout (a tarball, for instance).
 */
function publishedFiles() {
  const res = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: SUITE_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout
    .split('\0')
    .filter(Boolean)
    .map((rel) => path.join(SUITE_ROOT, rel));
}

function runStatic() {
  section('static — 包元数据与源码树卫生');
  const tracked = publishedFiles();
  const files = tracked || walk(SUITE_ROOT);
  console.log(
    tracked
      ? `· 扫描范围：git 跟踪 + 未忽略的文件（${files.length} 个）——构建产物与本地数据不在其内`
      : `· 扫描范围：目录遍历（${files.length} 个）——不在 git 检出内，无法区分忽略文件`,
  );

  // 1. packaging metadata
  for (const m of modules) {
    const label = m.pkg?.name || m.dirName;
    if (!m.pkg) {
      record('static', `${label}`, 'failed', '缺少 package.json');
      continue;
    }
    const problems = [];
    if (!m.pkg.name) problems.push('缺 name');
    if (/^@local\//.test(m.pkg.name || '')) problems.push('包名仍是 @local/* 占位');
    if (!m.pkg.version) problems.push('缺 version');
    if (!m.pkg.license) problems.push('缺 license');
    const mainRef = String(m.pkg.main || m.pkg.exports?.['.'] || '');
    if (/build[\\/]lib-[a-z0-9-]*\d{8}/i.test(mainRef) || /\d{8}/.test(mainRef)) {
      problems.push(`入口指向带日期目录: ${mainRef}`);
    }
    if (problems.length) record('static', `${label} (metadata)`, 'failed', problems.join('; '));
    else record('static', `${label} (metadata)`, 'ok');
  }

  // 2. no build artifacts inside the tracked tree. Only real build outputs count:
  // most modules keep hand-written sources under lib/, so lib/ is NOT treated as an artifact.
  // A package that declares dsh.suite.prebuilt ships its bundle deliberately (it cannot be
  // rebuilt without a DSH source checkout), so its lib/ is allowed.
  const prebuiltDirs = new Set(
    modules.filter((m) => m.pkg?.dsh?.suite?.prebuilt === true).map((m) => `plugins/${m.dirName}/`),
  );
  const ARTIFACT = /^plugins\/(?:[^/]+\/(?:build|dist)|dsh-super-injector\/lib)\//;
  const artifacts = files
    .map((f) => path.relative(SUITE_ROOT, f).replace(/\\/g, '/'))
    .filter((rel) => ARTIFACT.test(rel))
    .filter((rel) => ![...prebuiltDirs].some((p) => rel.startsWith(p)));
  record(
    'static',
    '源码树不含构建产物',
    artifacts.length ? 'failed' : 'ok',
    artifacts.length ? `${artifacts.length} 个文件落在 build/lib/dist 下` : '',
  );

  // 3. leak scan — two passes, because fixtures may contain placeholder credentials
  //    but must never contain a real author path or the old persona name.
  const scanPass = (rules, { skipTests }) => {
    for (const [name, re] of rules) {
      const hits = [];
      for (const f of files) {
        const rel = path.relative(SUITE_ROOT, f).replace(/\\/g, '/');
        if (SCAN_SELF_EXCLUDE.has(rel) || LOCAL_ONLY.has(rel)) continue;
        if (skipTests && TEST_TREE.test(rel)) continue;
        const ext = path.extname(f).toLowerCase();
        if (ext && !SCAN_EXT.has(ext)) continue;
        let text;
        try {
          if (fs.statSync(f).size > 4 * 1024 * 1024) continue;
          text = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        if (allowedIn(text, name, ext)) continue;
        const m = re.exec(text);
        if (m) {
          const line = text.slice(0, m.index).split('\n').length;
          hits.push(`${rel}:${line}`);
        }
      }
      record('static', name, hits.length ? 'failed' : 'ok', hits.slice(0, 8).join(' '));
    }
  };
  scanPass(LEAK_RULES, { skipTests: false });
  scanPass(SECRET_RULES, { skipTests: true });

  // 4. suite config parses and core is on
  try {
    const { config, dataPaths } = loadConfig();
    const mods = enabledModules(config);
    record('static', 'config/suite.example.json 可解析', 'ok', `dataDir=${dataPaths.root}`);
    record('static', 'core 模块始终启用', mods.core ? 'ok' : 'failed');
  } catch (err) {
    record('static', 'config/suite.example.json 可解析', 'failed', err.message);
  }

  // 5. required root files
  for (const rel of ['AGENTS.md', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'config/persona.example.md']) {
    record('static', rel, fs.existsSync(path.join(SUITE_ROOT, rel)) ? 'ok' : 'failed');
  }

  // 6. Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, which corrupts CJK text and
  //    breaks quoting/parens. Every .ps1 we ship must carry a UTF-8 BOM.
  const ps1 = files.filter((f) => f.toLowerCase().endsWith('.ps1'));
  const bomless = ps1.filter((f) => {
    try {
      const buf = fs.readFileSync(f);
      return !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
    } catch {
      return false;
    }
  });
  record(
    'static',
    '.ps1 带 UTF-8 BOM（PowerShell 5.1 需要）',
    bomless.length ? 'failed' : 'ok',
    bomless.map((f) => path.relative(SUITE_ROOT, f).replace(/\\/g, '/')).slice(0, 6).join(' '),
  );

  // 7. data-root parity (TEAM-BRIEF D2): the suite CLI and the plugins must agree on where
  //    runtime data lives, otherwise the UI and the engine open two different databases.
  return checkDataRootParity();
}

async function checkDataRootParity() {
  const label = '数据目录解析一致（CLI ↔ 插件）';
  const suitePaths = path.join(SUITE_PATHS.plugins, 'companion-foundation', 'suite-paths.mjs');
  if (!fs.existsSync(suitePaths)) {
    record('static', label, 'skipped', 'companion-foundation/suite-paths.mjs 不存在');
    return;
  }
  try {
    const { dataPaths } = loadConfig();
    const mod = await import(new URL(`file://${suitePaths.replace(/\\/g, '/')}`).href);
    const resolved = mod.resolveSuitePaths ? mod.resolveSuitePaths({ env: process.env }) : null;
    const pluginRoot = resolved?.dataRoot;
    if (!pluginRoot) {
      record('static', label, 'skipped', '插件侧没有导出 resolveSuitePaths()');
      return;
    }
    const same = path.resolve(pluginRoot) === path.resolve(dataPaths.root);
    record('static', label, same ? 'ok' : 'failed', same ? path.resolve(pluginRoot) : `CLI=${dataPaths.root} 插件=${pluginRoot}`);
  } catch (err) {
    record('static', label, 'failed', err.message);
  }
}

/* ────────────────────────── compose ───────────────────────── */
function runCompose() {
  section('compose — 宿主合成检查');
  let host;
  try {
    const { config } = loadConfig();
    host = config.dsh || {};
  } catch {
    host = {};
  }
  const exe = host.executable && fs.existsSync(host.executable) ? host.executable : '';
  const cli = host.moduleRoot
    ? path.join(host.moduleRoot, '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    : '';
  const patch = path.join(SUITE_PATHS.configDir, 'profile', 'companion.patch.yml');

  if (!exe || !cli || !fs.existsSync(cli)) {
    record('compose', 'dsh --dump-config', 'skipped', '未检测到 DSH 宿主（CI 正常现象，不算失败）');
    return;
  }
  if (!fs.existsSync(patch)) {
    record('compose', 'dsh --dump-config', 'skipped', '还没有生成 profile 补丁，先跑 npm run setup');
    return;
  }
  const res = spawnSync(exe, ['--expose-internals', cli, '--profile', host.profile || 'companion', '--patch', patch, '--dump-config'], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: path.join(SUITE_ROOT, 'data', 'home'),
    },
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status === 0 && out.includes('- id:')) {
    const rows = (out.match(/^- id: /gm) || []).length;
    record('compose', 'dsh --dump-config', 'ok', `${rows} 个 loader 行`);
  } else {
    record('compose', 'dsh --dump-config', 'failed', `exit ${res.status}: ${out.trim().split('\n').slice(-6).join(' | ')}`);
  }
}

/* ─────────────────────────── drive ────────────────────────── */
if (want('unit')) runUnit();
if (want('static')) runStatic();
if (want('compose')) runCompose();

console.log('\n═══ 汇总 ═══');
for (const g of Object.keys(summary)) {
  if (!want(g)) continue;
  const rows = Object.values(summary[g]);
  const ok = rows.filter((r) => r.status === 'ok').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const skippedN = rows.filter((r) => r.status === 'skipped' || r.status === 'no-tests').length;
  console.log(`${g.padEnd(8)} ok ${String(ok).padStart(3)}  failed ${String(failed).padStart(2)}  skipped/no-tests ${String(skippedN).padStart(2)}`);
}

if (argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failures === 0, summary }, null, 2));
}

if (failures) {
  console.error(`\n验证未通过：${failures} 项失败。`);
  process.exit(1);
}
console.log(`\n验证通过（${skips} 项跳过/无测试，跳过不等于通过，见 docs/07-verification-status.md）。`);
