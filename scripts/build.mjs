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

function runNpm(script, cwd) {
  return spawnSync(isWindows ? 'npm.cmd' : 'npm', ['run', script], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, npm_config_workspaces: 'false' },
    shell: isWindows, // .cmd shims need the shell; arguments are literals, never user input
  });
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

for (const m of modules) {
  if (m.parseError) {
    broken.push(`${m.name}: package.json 不是合法 JSON — ${m.parseError}`);
    continue;
  }
  if (!m.pkg) {
    skipped.push(`${m.name}: 没有 package.json（不是发布包）`);
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
  process.stdout.write(`▶ ${m.name} → npm run build\n`);
  const started = Date.now();
  const res = runNpm('build', m.dir);
  const ms = Date.now() - started;
  if (res.status === 0) {
    results.push({ module: m.name, status: 'ok', ms });
  } else {
    failed += 1;
    results.push({ module: m.name, status: 'failed', ms, code: res.status, signal: res.signal });
    console.error(`✗ ${m.name} 构建失败 (code ${res.status ?? res.signal})`);
  }
}

console.log('\n——— 构建结果 ———');
for (const r of results) {
  console.log(`${r.status === 'ok' ? '✓' : '✗'} ${r.module.padEnd(28)} ${r.status}${r.ms ? ` (${r.ms} ms)` : ''}`);
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
