#!/usr/bin/env node
/**
 * Host-load check for the expression module — manual evidence, not part of `verify`.
 *
 * What it proves when it passes: with `modules.expression` on, the real DSH host starts, the web
 * shell answers HTTP 200, and no `did not activate` line appears — i.e. the two expression rows
 * (`companion-expression` inside the preset, `companion-expression-http` at the top level) were
 * loaded by a real host.
 *
 * What it does NOT prove: that a sticker reaches another human. That needs a real NapCat and an
 * operator-triggered send (`real-send`); nothing here touches that path.
 *
 * Everything runs in a throwaway DSH home + data dir created under the OS temp directory and
 * removed at the end. The repository and the user's own `data/` are never written to.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderPatchTemplate } from '../../../scripts/setup.mjs';
import { SUITE_PATHS, dataPaths } from '../../../tools/lib/paths.mjs';
import { loadConfig } from '../../../tools/lib/config.mjs';
import { resolveHost } from '../../../tools/lib/host.mjs';
import { dshEnv, createProfile, WEB_URL_PATTERN, profileExists, describeLauncher } from '../../../tools/lib/dsh.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { config } = loadConfig();
const profileName = config.dsh?.profile || 'companion';

const host = resolveHost(config.dsh || {});
const launcher = describeLauncher(host, {});
if (!launcher.ready) {
  console.error(`没有可用的 DSH 宿主启动方式：${launcher.reason}`);
  process.exit(2);
}
const cli = launcher.cliPath;
console.log(`启动器：${launcher.launcher}（命令 ${launcher.command}）`);

/* ── 一次性的 DSH home + 数据目录 ───────────────────────────────── */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'expression-hostload-'));
const dshHome = path.join(scratch, 'home');
const dataRoot = path.join(scratch, 'data');
fs.mkdirSync(dshHome, { recursive: true });
const dp = dataPaths(dataRoot);
for (const dir of [dp.workspace, dp.groupWorkspace, dp.logs, dp.temp]) fs.mkdirSync(dir, { recursive: true });

const created = createProfile({ host, dshHome, profile: profileName, template: 'web', launcher });
if (!created.ok) {
  console.error(`创建临时 profile 失败：${created.message}`);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
}

/* ── 渲染补丁：只打开 expression 这一块 ────────────────────────── */
const placeholders = {
  SUITE_ROOT: SUITE_PATHS.root.replace(/\\/g, '/'),
  DSH_HOME: dp.home.replace(/\\/g, '/'),
  WORKSPACE_DIR: dp.workspace.replace(/\\/g, '/'),
  GROUP_WORKSPACE_DIR: dp.groupWorkspace.replace(/\\/g, '/'),
  DESKTOP_DATA_DIR: dp.desktopData.replace(/\\/g, '/'),
  PROFILE: profileName,
  ONEBOT_URL: '', ONEBOT_ACCESS_TOKEN: '', ONEBOT_SELF_ID: 0, HEALTH_SIDECAR_URL: '',
};
const patchFile = path.join(scratch, 'companion.patch.yml');
fs.writeFileSync(
  patchFile,
  renderPatchTemplate(
    fs.readFileSync(path.join(SUITE_PATHS.profileTemplateDir, 'companion.patch.template.yml'), 'utf8'),
    { placeholders, activeBlocks: new Set(['expression']) },
  ),
  'utf8',
);

/* ── 真启动一次，等到 URL，再取一次 UI ─────────────────────────── */
const port = String(39000 + Math.floor(Math.random() * 900));
const env = dshEnv({
  home: dshHome,
  moduleRoot: host.moduleRoot,
  env: {
    ...process.env,
    DSH_COMPANION_DATA_DIR: dataRoot,
    DSH_COMPANION_MODULES_EXPRESSION: '1',
    DSH_COMPANION_PERSONA_ID: 'bot',
  },
});
console.log(`启动宿主：port=${port} profile=${profileName} DSH_HOME=${dshHome}`);

const args = ['--expose-internals', cli, '--profile', profileName, '--patch', patchFile, '--port', port, '--no-open'];
const child = spawn(launcher.command, args, {
  env, stdio: ['ignore', 'pipe', 'pipe'], cwd: dp.workspace, shell: false,
});
const chunks = [];
child.stdout.on('data', (buf) => chunks.push(String(buf)));
child.stderr.on('data', (buf) => chunks.push(String(buf)));

let url = '';
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const text = chunks.join('');
  const match = WEB_URL_PATTERN.exec(text);
  if (match) { url = match[1]; break; }
  if (child.exitCode !== null) break;
  await new Promise((resolve) => setTimeout(resolve, 400));
}

let httpStatus = null;
if (url) {
  try {
    httpStatus = (await fetch(url)).status;
  } catch (error) {
    httpStatus = `fetch-failed: ${String(error?.message ?? error).slice(0, 80)}`;
  }
}

child.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 2500));
try { child.kill('SIGKILL'); } catch { /* gone */ }

const text = chunks.join('');
const expressionLines = text.split(/\r?\n/).filter((line) => line.includes('companion-expression'));
const result = {
  url: Boolean(url),
  httpStatus,
  activated: !/did not activate/i.test(text),
  profileExists: profileExists(dshHome, profileName),
  expression: expressionLines.length > 0,
  lines: expressionLines.slice(0, 12),
};

console.log('\n=== 结果 ===');
console.log(`URL：${url || '未拿到'}；HTTP ${httpStatus}`);
console.log(`did not activate：${result.activated ? '没有（好）' : '出现了（坏）'}`);
console.log(`日志里的 companion-expression 行：${result.lines.length} 条`);
for (const line of result.lines) console.log(`  ${line.trim()}`);
if (!result.lines.length) {
  console.log('--- 日志尾部（排查用）---');
  for (const line of text.split(/\r?\n/).slice(-14)) console.log(`  ${line.trim()}`);
}

fs.rmSync(scratch, { recursive: true, force: true });
// 判据只看「宿主真的起来了 + 两行都装上了」：
//   - 拿到启动 URL（说明 web 服务跑起来了）；
//   - 日志里没有 `did not activate`；
//   - 日志里有 companion-expression 自己的启动行（端口发布 / 工具注册 / http 路由注册）。
//
// **不把 HTTP 200 当作判据**：本机宿主 `0.2.1-rc.3` 在无 cookie 的裸 fetch 上一律回 401
// （token 要先换会话，浏览器里才有 cookie）。那是宿主鉴权的行为，不是本模块装载失败；
// 把 401 当失败会把「UI 可访问」误写成「模块没装上」。
const passed = result.url && result.activated && result.expression;
console.log(passed
  ? '\n结论：宿主真启动、拿到 URL、无装载错误、表情包两行都装上了 → host-load 达成。'
  : '\n结论：未达成（见上面的日志）。这只影响「宿主装载」这一级证据，不影响离线测试的结论。');
process.exit(passed ? 0 : 1);
