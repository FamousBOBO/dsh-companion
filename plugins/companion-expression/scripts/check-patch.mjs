#!/usr/bin/env node
/**
 * Render-check for the profile patch template: does enabling the `expression` block produce a
 * patch the host can actually compose?
 *
 * Why this exists: `npm run setup` renders the template and `npm run verify --only=compose` runs
 * `dsh --dump-config` against the **generated** patch — but only for the blocks that happen to be
 * on in `config/suite.json`. The expression blocks are off by default (by design), so the compose
 * check never sees them. This script renders the template with every optional block on, writes it
 * to a temp file, and asks the host to compose it. It is a manual/CI-adjacent check, not part of
 * `verify`.
 *
 * Usage: node plugins/companion-expression/scripts/check-patch.mjs
 * Exits 0 when the rendered patch parses and composes; 1 otherwise. Never writes into the repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderPatchTemplate } from '../../../scripts/setup.mjs';
import { SUITE_PATHS } from '../../../tools/lib/paths.mjs';
import { loadConfig } from '../../../tools/lib/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = path.join(SUITE_PATHS.profileTemplateDir, 'companion.patch.template.yml');

const { config, dataPaths } = loadConfig();
const placeholders = {
  SUITE_ROOT: SUITE_PATHS.root.replace(/\\/g, '/'),
  DSH_HOME: dataPaths.home.replace(/\\/g, '/'),
  WORKSPACE_DIR: dataPaths.workspace.replace(/\\/g, '/'),
  GROUP_WORKSPACE_DIR: dataPaths.groupWorkspace.replace(/\\/g, '/'),
  DESKTOP_DATA_DIR: dataPaths.desktopData.replace(/\\/g, '/'),
  PROFILE: config.dsh?.profile || 'companion',
  ONEBOT_URL: config.services?.onebot?.url || '',
  ONEBOT_ACCESS_TOKEN: config.services?.onebot?.accessToken || '',
  ONEBOT_SELF_ID: config.services?.onebot?.selfId || 0,
  HEALTH_SIDECAR_URL: config.services?.health?.sidecarUrl || '',
};

// Every optional block on: this is about "can the expression rows be expressed at all", not about
// what this machine's suite.json happens to enable.
const activeBlocks = new Set(['media', 'expression', 'qq', 'health']);
let rendered;
try {
  rendered = renderPatchTemplate(fs.readFileSync(template, 'utf8'), { placeholders, activeBlocks });
} catch (error) {
  console.error(`渲染失败：${error?.message ?? error}`);
  process.exit(1);
}

const leftovers = rendered.match(/\$\{[A-Z_]+\}/g);
if (leftovers) {
  console.error(`渲染后仍有占位符：${leftovers.join(', ')}`);
  process.exit(1);
}
for (const id of ['companion-expression', 'companion-expression-http']) {
  if (!rendered.includes(`id: ${id}`)) {
    console.error(`渲染结果里缺少 ${id}（expression 块没生效？）`);
    process.exit(1);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expression-patch-'));
const file = path.join(dir, 'companion.patch.yml');
fs.writeFileSync(file, rendered, 'utf8');
console.log(`渲染完成：${rendered.length} 字节 → ${file}`);

const exe = config.dsh?.executable;
const moduleRoot = config.dsh?.moduleRoot;
const cli = moduleRoot ? path.join(moduleRoot, '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js') : '';
if (!exe || !moduleRoot || !fs.existsSync(exe) || !fs.existsSync(cli)) {
  console.log('未检测到 DSH 宿主：跳过 --dump-config（渲染本身已通过）。');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const res = spawnSync(exe, ['--expose-internals', cli, '--profile', config.dsh?.profile || 'companion', '--patch', file, '--dump-config'], {
  encoding: 'utf8',
  timeout: 180000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dataPaths.home },
});
const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
const rows = (out.match(/^- id: /gm) || []).length;
const hasExpression = out.includes('- id: companion-expression');
const hasHttp = out.includes('- id: companion-expression-http');
fs.rmSync(dir, { recursive: true, force: true });

if (res.status !== 0 || rows === 0) {
  console.error(`--dump-config 失败（exit ${res.status}）：${out.trim().split('\n').slice(-8).join(' | ')}`);
  process.exit(1);
}
console.log(`--dump-config 通过：${rows} 个 loader 行；expression=${hasExpression} expression-http=${hasHttp}`);
if (!hasExpression || !hasHttp) {
  console.error('合成结果里没有表情包的两行（补丁块没被宿主接受）。');
  process.exit(1);
}
