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

    const res = testScript
      ? spawnSync(isWindows ? 'npm.cmd' : 'npm', ['test'], {
          cwd: m.dir,
          stdio: 'pipe',
          encoding: 'utf8',
          env: { ...process.env, npm_config_workspaces: 'false', CI: '1' },
          shell: isWindows,
          timeout: 15 * 60 * 1000,
        })
      : spawnSync(process.execPath, ['--test'], {
          cwd: m.dir,
          stdio: 'pipe',
          encoding: 'utf8',
          env: { ...process.env, CI: '1' },
          timeout: 15 * 60 * 1000,
        });

    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (res.status === 0) {
      const passMatch = out.match(/# pass (\d+)/);
      record('unit', label, 'ok', passMatch ? `${passMatch[1]} 个测试通过` : '通过');
    } else {
      const tail = out.trim().split('\n').slice(-12).join('\n      ');
      record('unit', label, 'failed', `exit ${res.status}\n      ${tail}`);
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

const SECRET_RULES = [
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['bearer', /Bearer\s+[A-Za-z0-9._-]{24,}/],
];

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

function runStatic() {
  section('static — 包元数据与源码树卫生');
  const files = walk(SUITE_ROOT);

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
  const ARTIFACT = /^plugins\/(?:[^/]+\/(?:build|dist)|dsh-super-injector\/lib)\//;
  const artifacts = files.filter((f) => ARTIFACT.test(path.relative(SUITE_ROOT, f).replace(/\\/g, '/')));
  record(
    'static',
    '源码树不含构建产物',
    artifacts.length ? 'failed' : 'ok',
    artifacts.length ? `${artifacts.length} 个文件落在 build/lib/dist 下` : '',
  );

  // 3. leak scan
  for (const [name, re] of [...LEAK_RULES, ...SECRET_RULES]) {
    const hits = [];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (ext && !SCAN_EXT.has(ext)) continue;
      let text;
      try {
        if (fs.statSync(f).size > 4 * 1024 * 1024) continue;
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const m = re.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${path.relative(SUITE_ROOT, f).replace(/\\/g, '/')}:${line}`);
      }
    }
    record('static', name, hits.length ? 'failed' : 'ok', hits.slice(0, 8).join(' '));
  }

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
