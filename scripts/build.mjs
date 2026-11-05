#!/usr/bin/env node
/**
 * Build every released module that has a build step.
 *
 * The repository stores source only (`plugins/**\/build` and `plugins/**\/lib` are
 * git-ignored), so a fresh clone has no runnable entry points until this runs.
 * Modules without a `build` script are reported as "no build step" rather than
 * silently treated as built.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SUITE_PATHS } from '../tools/lib/paths.mjs';

const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith('--only='))?.slice('--only='.length);
const isWindows = process.platform === 'win32';

/** npm without a shell: npm_execpath lets us spawn `node <npm-cli.js> …` when run under npm. */
const NPM_EXECPATH = process.env.npm_execpath;

/**
 * A leaked `npm_config_workspaces` (npm sets it for some script contexts, and wrappers may set it)
 * becomes `--no-workspaces` and then collides with our explicit `--workspace`. Strip it.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_workspaces?$/i.test(key)) delete env[key];
  }
  return env;
}

function runNpmBuild(pkgName) {
  // From the suite root with --workspace: running npm inside a workspace directory makes
  // npm reject the combination of workspace flags it infers.
  const args = ['run', 'build', `--workspace=${pkgName}`];
  const options = { cwd: SUITE_PATHS.root, stdio: 'inherit', env: cleanEnv() };
  if (NPM_EXECPATH && /npm-cli\.js$/.test(NPM_EXECPATH)) {
    return spawnSync(process.execPath, [NPM_EXECPATH, ...args], { ...options, shell: false });
  }
  return spawnSync(isWindows ? 'npm.cmd' : 'npm', args, { ...options, shell: isWindows });
}

function listModules() {
  const root = SUITE_PATHS.plugins;
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(root, e.name);
      const pkgPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgPath)) return { name: e.name, dir, pkg: null };
      let pkg = null;
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
      } catch (err) {
        return { name: e.name, dir, pkg: null, parseError: err.message };
      }
      return { name: e.name, dir, pkg };
    });
}

const modules = listModules().filter((m) => !only || m.name.includes(only));
const buildable = [];
const skipped = [];
const broken = [];
const prebuilt = [];

for (const m of modules) {
  if (m.parseError) {
    broken.push(`${m.name}: package.json 不是合法 JSON — ${m.parseError}`);
    continue;
  }
  if (!m.pkg) {
    skipped.push(`${m.name}: 没有 package.json（不是发布包）`);
    continue;
  }
  // A prebuilt package ships its bundle because it cannot be rebuilt without a DSH source
  // checkout. Verify the shipped entry still loads instead of pretending to build it.
  if (m.pkg.dsh?.suite?.prebuilt === true) {
    prebuilt.push(m);
    continue;
  }
  const script = m.pkg.scripts?.build;
  if (!script) {
    skipped.push(`${m.name}: 没有 build 脚本（源码直接可加载）`);
    continue;
  }
  buildable.push({ ...m, script });
}

console.log(`模块总数 ${modules.length}，需要构建 ${buildable.length}\n`);

let failed = 0;
const results = [];
for (const m of buildable) {
  const label = m.pkg.name || m.name;
  process.stdout.write(`▶ ${label} → npm run build\n`);
  const started = Date.now();
  const res = runNpmBuild(label);
  const ms = Date.now() - started;
  if (res.status === 0) {
    results.push({ module: label, status: 'ok', ms });
  } else {
    failed += 1;
    results.push({ module: label, status: 'failed', ms, code: res.status, signal: res.signal });
    console.error(`✗ ${label} 构建失败 (code ${res.status ?? res.signal})`);
  }
}

console.log('\n——— 构建结果 ———');
for (const r of results) {
  console.log(`${r.status === 'ok' ? '✓' : '✗'} ${r.module.padEnd(28)} ${r.status}${r.ms ? ` (${r.ms} ms)` : ''}`);
}
for (const m of prebuilt) {
  const label = m.pkg.name || m.name;
  const entry = path.resolve(m.dir, m.pkg.main || './lib/index.js');
  const ok = fs.existsSync(entry);
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(28)} 预构建（未重建）${ok ? '' : ' — 缺少 ' + path.relative(m.dir, entry)}`);
  if (!ok) {
    failed += 1;
    broken.push(`${label}: 预构建入口缺失 ${path.relative(m.dir, entry)}`);
  }
}
if (skipped.length) {
  console.log('\n——— 跳过 ———');
  for (const s of skipped) console.log(`· ${s}`);
}
if (broken.length) {
  console.log('\n——— 元数据错误 ———');
  for (const b of broken) console.log(`✗ ${b}`);
}

if (args.has('--json')) {
  console.log(JSON.stringify({ ok: failed === 0 && broken.length === 0, results, skipped, broken }, null, 2));
}

if (failed || broken.length) {
  console.error(`\n构建未全部通过：${failed} 个失败，${broken.length} 个元数据错误。`);
  process.exit(1);
}
console.log('\n构建完成。');
