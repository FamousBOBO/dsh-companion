#!/usr/bin/env node
/**
 * `npm run stop` — 停掉 `npm run start` 启动的那个进程。
 *
 * 只认 `<dataDir>/tmp/companion-start.json` 里记录的 PID，并且杀之前先确认
 * 「这个 PID 现在还在、而且确实是我们启动的那个可执行文件」——
 * PID 会被系统复用，宁可什么都不做也不能误杀别人的进程。
 *
 * 用法：node scripts/stop.mjs [--json] [--force]
 *   --force  跳过「记录的进程看起来对不上」的确认（仍然只动这一个 PID）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { SUITE_ROOT } from '../tools/lib/paths.mjs';
import { loadConfig } from '../tools/lib/config.mjs';

const PID_FILE = 'companion-start.json';

function parseArgs(argv) {
  const opts = { json: false, force: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数：${arg}（可用：--json --force --help）`);
  }
  return opts;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 这个 PID 当前的可执行文件名（拿不到就返回空串）。 */
function processImageName(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = /^"([^"]+)"/m.exec(out.trim());
      return match ? match[1] : '';
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return path.basename(out.trim());
  } catch {
    return '';
  }
}

function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `taskkill 失败：${err.message}` };
    }
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      return { ok: false, error: `发送 SIGTERM 失败：${err.message}` };
    }
  }
  return { ok: true };
}

async function waitForExit(pid, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !isAlive(pid);
}

export async function runStop(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const started = Date.now();
  if (opts.help) {
    process.stderr.write('用法：node scripts/stop.mjs [--json] [--force]\n');
    return 0;
  }

  const emit = (payload, humanLines) => {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ command: 'stop', ...payload, durationMs: Date.now() - started }, null, 2)}\n`);
    } else {
      process.stderr.write(`${humanLines.join('\n')}\n`);
    }
  };

  let loaded;
  try {
    loaded = loadConfig();
  } catch (err) {
    emit({ ok: false, error: `套件配置读取失败：${err.message}` }, [`stop 失败：套件配置读取失败：${err.message}`]);
    return 1;
  }
  const pidFile = path.join(loaded.dataPaths.temp, PID_FILE);
  const lines = [`DSH Companion — stop`, `  套件根：${SUITE_ROOT}`];

  if (!fs.existsSync(pidFile)) {
    lines.push('  没有找到启动记录（还没用 npm run start 启动过，或已经停掉了）。没有动任何进程。');
    emit({ ok: true, stopped: false, reason: 'no-pid-file', pidFile }, lines);
    return 0;
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  } catch (err) {
    lines.push(`  启动记录损坏（${err.message}）：${pidFile}`);
    lines.push('  没有动任何进程；可以删掉这个文件后重新 npm run start。');
    emit({ ok: false, stopped: false, reason: 'bad-pid-file', pidFile }, lines);
    return 1;
  }

  const pid = Number(record.pid);
  lines.push(`  记录：PID ${pid} · ${record.profile || '(profile?)'} · ${record.status || ''} · ${record.startedAt || ''}`);
  if (record.logFile) lines.push(`  日志：${record.logFile}`);

  if (!isAlive(pid)) {
    lines.push('  该 PID 已经不在运行了（进程自己退出了）。清掉启动记录，没有动别的进程。');
    fs.rmSync(pidFile, { force: true });
    emit({ ok: true, stopped: false, reason: 'already-exited', pid }, lines);
    return 0;
  }

  // PID 会被复用：先确认这个 PID 现在跑的是我们当初启动的那个可执行文件。
  const expected = record.executable ? path.basename(record.executable).toLowerCase() : '';
  const actual = processImageName(pid).toLowerCase();
  const matches = !expected || !actual || expected === actual;
  if (!matches && !opts.force) {
    lines.push(`  拒绝停止：PID ${pid} 现在跑的是 “${actual}”，不是记录里的 “${expected}”。`);
    lines.push('  （PID 被复用了。确认无误可以加 --force，或手动删掉启动记录文件。）');
    emit({ ok: false, stopped: false, reason: 'pid-reused', pid, expected, actual }, lines);
    return 1;
  }
  if (!matches && opts.force) {
    lines.push(`  注意：镜像名对不上（记录 ${expected} / 实际 ${actual}），按 --force 继续。`);
  }

  // 先把自己的意图写进记录：start 的前台循环靠这个字段判断「是被人正常停掉」而不是崩了。
  try {
    fs.writeFileSync(pidFile, `${JSON.stringify({ ...record, status: 'stopping' }, null, 2)}\n`, 'utf8');
  } catch {
    /* 写不进去也不影响停止，只是 start 那边会看到旧状态 */
  }

  const killed = killTree(pid);
  if (!killed.ok) {
    emit({ ok: false, stopped: false, reason: 'kill-failed', pid, error: killed.error }, [...lines, `  停止失败：${killed.error}`]);
    return 1;
  }

  const exited = await waitForExit(pid);
  if (!exited) {
    lines.push(`  已发送停止信号，但 PID ${pid} 在 8 秒内仍存活。`);
    lines.push('  可以再跑一次 npm run stop，或在任务管理器里确认。启动记录保留，方便下一次重试。');
    emit({ ok: false, stopped: false, reason: 'still-alive', pid }, lines);
    return 1;
  }

  fs.rmSync(pidFile, { force: true });
  lines.push(`  已停止 PID ${pid}。启动记录已清掉。`);
  emit({ ok: true, stopped: true, pid, logFile: record.logFile || '' }, lines);
  return 0;
}

/* ────────────────────────── 入口 ────────────────────────── */

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.exitCode = await runStop();
  } catch (err) {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ command: 'stop', ok: false, error: err.message }, null, 2)}\n`);
    }
    process.stderr.write(`stop 失败：${err.message}\n`);
    process.exitCode = 1;
  }
}

export default { runStop };
