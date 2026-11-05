#!/usr/bin/env node
/**
 * `npm run start` — 启动本套件自己的 DSH 环境。
 *
 * 做的事：`dsh --profile <name> --patch <生成的补丁>`（web app），输出全部写进
 * `<dataDir>/logs/start-<时间戳>.log`，等宿主打印出
 *
 *     dsh web: http://127.0.0.1:<port>/?token=…
 *
 * 之后把 URL、日志路径、PID 一起打印出来，并把 PID 记到
 * `<dataDir>/tmp/companion-start.json`，`npm run stop` 靠它停掉**本次启动的**进程。
 *
 * 只有真拿到 URL 才算启动成功：超时或提前退出都按失败处理，并给出日志尾部与路径。
 *
 * 两种运行方式：
 *   默认（前台）—— 打印 URL 后继续留在前台，把宿主输出转给终端，直到宿主退出；
 *                   Ctrl+C 或另一个终端里的 `npm run stop` 都能停掉它。这是最可靠的默认值：
 *                   宿主能否存活不再取决于启动它的终端是否被父进程回收。
 *   --detach    —— 拿到 URL 后立即返回，宿主留在后台；此时能否存活取决于父进程/作业对象，
 *                   停它仍然用 `npm run stop`（按 PID 记录，且会先确认 PID 没被复用）。
 *
 * 用法：node scripts/start.mjs [--desktop] [--detach] [--json] [--timeout <ms>] [--port <port>]
 *   --desktop  交给宿主按默认行为打开浏览器/桌面 UI（默认加 --no-open，只打印 URL）
 *   --detach   拿到 URL 后立刻返回，宿主留在后台（配合 npm run stop）
 *   --timeout  等待 URL 的超时毫秒数（默认取 config/suite.json 的 dsh.startTimeoutMs）
 *   --port     传给 web app 的监听端口（默认由宿主决定）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { SUITE_ROOT, SUITE_PATHS } from '../tools/lib/paths.mjs';
import { loadConfig } from '../tools/lib/config.mjs';
import { resolveHost } from '../tools/lib/host.mjs';
import {
  describeLauncher,
  spawnDsh,
  parseWebUrl,
  profileExists,
  profileDir,
} from '../tools/lib/dsh.mjs';

const PATCH_GENERATED = path.join(SUITE_PATHS.profileTemplateDir, 'companion.patch.yml');
/** PID 记录文件：stop 只认它，不猜别人的进程。 */
const PID_FILE = 'companion-start.json';

function parseArgs(argv) {
  const opts = { desktop: false, detach: false, json: false, timeoutMs: 0, port: 0, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--desktop') opts.desktop = true;
    else if (arg === '--detach') opts.detach = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--timeout') {
      opts.timeoutMs = Number(argv[++i]);
      if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout 需要一个正整数毫秒数');
    } else if (arg === '--port') {
      opts.port = Number(argv[++i]);
      if (!Number.isInteger(opts.port) || opts.port < 0) throw new Error('--port 需要一个非负整数');
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数：${arg}（可用：--desktop --detach --json --timeout <ms> --port <port> --help）`);
  }
  return opts;
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 只增不减地读取子进程正在写的日志文件。 */
function makeLogTailer(logFile) {
  let offset = 0;
  let buffer = '';
  return {
    read() {
      let stat;
      try {
        stat = fs.statSync(logFile);
      } catch {
        return buffer;
      }
      if (stat.size <= offset) return buffer;
      const length = stat.size - offset;
      const fd = fs.openSync(logFile, 'r');
      let chunk = '';
      try {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, offset);
        offset = stat.size;
        chunk = buf.toString('utf8');
        buffer += chunk;
      } finally {
        fs.closeSync(fd);
      }
      return buffer;
    },
    /** 只返回自上次调用以来新增的部分。 */
    drain() {
      const before = buffer.length;
      this.read();
      const added = buffer.slice(before);
      return added;
    },
    get text() {
      return buffer;
    },
  };
}

function tailLines(text, count) {
  return String(text || '').split(/\r?\n/).filter(Boolean).slice(-count);
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: '没有可停止的 PID' };
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
    return { ok: true };
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `发送 SIGTERM 失败：${err.message}` };
    }
  }
}

async function waitForUrl({ child, logFile, timeoutMs }) {
  const tailer = makeLogTailer(logFile);
  const startedAt = Date.now();
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  for (;;) {
    const text = tailer.read();
    const url = parseWebUrl(text);
    if (url) return { ok: true, url, text, waitedMs: Date.now() - startedAt, tailer };
    if (exited) {
      return {
        ok: false, url: '', text: tailer.read(), waitedMs: Date.now() - startedAt, tailer,
        error: `宿主在打印 web 地址之前就退出了（退出码 ${exited.code ?? 'null'}${exited.signal ? `，信号 ${exited.signal}` : ''}）`,
      };
    }
    if (Date.now() - startedAt > timeoutMs) {
      return {
        ok: false, url: '', text: tailer.read(), waitedMs: Date.now() - startedAt, tailer,
        error: `等待 web 地址超时（${timeoutMs} ms）`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

export async function runStart(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const started = Date.now();

  if (opts.help) {
    process.stderr.write('用法：node scripts/start.mjs [--desktop] [--detach] [--json] [--timeout <ms>] [--port <port>]\n');
    return 0;
  }

  const lines = [];
  const say = (line = '') => { lines.push(line); };
  const fail = (message) => {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        command: 'start', ok: false, error: message, durationMs: Date.now() - started,
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`${lines.join('\n')}\n`);
      process.stderr.write(`\n启动失败：${message}\n`);
    }
    return 1;
  };

  let loaded;
  try {
    loaded = loadConfig();
  } catch (err) {
    return fail(`套件配置读取失败：${err.message}`);
  }
  const { config, dataPaths: paths } = loaded;
  const profileName = config.dsh?.profile || 'companion';
  const dshHome = paths.home;

  say('DSH Companion — start');
  say(`  套件根：${SUITE_ROOT}`);
  say(`  profile：${profileName}（DSH_HOME=${dshHome}）`);

  const host = resolveHost(config.dsh || {});
  const launcher = describeLauncher(host);
  if (!host.found) {
    return fail('未检测到 DSH 宿主。先跑 npm run doctor 看它试过哪些路径');
  }
  if (!launcher.ready) {
    return fail(launcher.reason);
  }

  if (!profileExists(dshHome, profileName)) {
    return fail(`profile 不存在：${profileDir(dshHome, profileName)}。先跑 npm run setup`);
  }
  if (!fs.existsSync(PATCH_GENERATED)) {
    return fail(`profile 补丁不存在：${PATCH_GENERATED}。先跑 npm run setup`);
  }

  fs.mkdirSync(paths.logs, { recursive: true });
  fs.mkdirSync(paths.temp, { recursive: true });
  const logFile = path.join(paths.logs, `start-${stamp()}.log`);

  const args = ['--profile', profileName, '--patch', PATCH_GENERATED];
  if (opts.port) args.push('--port', String(opts.port));
  if (!opts.desktop) args.push('--no-open');

  const timeoutMs = opts.timeoutMs || Number(config.dsh?.startTimeoutMs) || 120000;
  say(`  启动：${launcher.command} --expose-internals <cli.js> ${args.join(' ')}`);
  say(`  日志：${logFile}`);

  let spawned;
  try {
    spawned = spawnDsh(args, { host, dshHome, logFile, launcher, cwd: paths.workspace });
  } catch (err) {
    return fail(`无法启动宿主进程：${err.message}`);
  }

  const { child } = spawned;
  const pidFile = path.join(paths.temp, PID_FILE);
  const record = {
    pid: child.pid,
    executable: launcher.command,
    launcher: launcher.launcher,
    profile: profileName,
    dshHome,
    logFile,
    url: '',
    status: 'starting',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  };
  const writeRecord = (patch) => {
    const merged = { ...record, ...patch };
    const tmp = `${pidFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, pidFile);
  };
  writeRecord({});

  const result = await waitForUrl({ child, logFile, timeoutMs });

  if (!result.ok) {
    const killed = killTree(child.pid);
    const tailText = tailLines(result.text, 12).join('\n    ');
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        command: 'start', ok: false, error: result.error, logFile, pid: child.pid,
        timedOut: /超时/.test(result.error), killed: killed.ok, tail: tailLines(result.text, 20),
        durationMs: Date.now() - started,
      }, null, 2)}\n`);
    } else {
      if (tailText) say(`  日志最后几行：\n    ${tailText}`);
      process.stderr.write(`${lines.join('\n')}\n`);
      process.stderr.write(`\n启动失败：${result.error}\n  完整日志：${logFile}\n`);
      if (!killed.ok) process.stderr.write(`  另外：${killed.error}\n`);
    }
    return 1;
  }

  const url = result.url;
  const portMatch = /:(\d+)\//.exec(url);
  writeRecord({ url, status: 'ready', readyAtMs: Date.now() });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      command: 'start', ok: true, url, port: portMatch ? Number(portMatch[1]) : null,
      pid: child.pid, logFile, profile: profileName, dshHome, pidFile,
      waitedMs: result.waitedMs, detached: opts.detach, durationMs: Date.now() - started,
    }, null, 2)}\n`);
    if (opts.detach) {
      child.unref();
      return 0;
    }
  } else {
    say('');
    say(`  已就绪（${result.waitedMs} ms）：${url}`);
    say(`  日志：${logFile}`);
    say(`  PID：${child.pid}（记录于 ${pidFile}）`);
    if (opts.detach) {
      say('  宿主已在后台运行；停止用 npm run stop');
      process.stderr.write(`${lines.join('\n')}\n`);
      child.unref();
      return 0;
    }
    say('  前台运行中：Ctrl+C 或另开一个终端跑 npm run stop 都会停掉它。');
    process.stderr.write(`${lines.join('\n')}\n`);
  }

  /* ── 前台模式：继续把宿主输出转给终端，直到它退出 ──────────────── */

  const tailer = result.tailer;
  let stopped = false;

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    killTree(child.pid);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  const exit = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const added = tailer.drain();
      if (added && !opts.json) process.stderr.write(added);
    }, 200);
    child.on('exit', (code, signal) => {
      clearInterval(timer);
      const added = tailer.drain();
      if (added && !opts.json) process.stderr.write(added);
      resolve({ code, signal });
    });
  });

  // 前台模式结束：区分「被 npm run stop 正常停掉」和「宿主自己崩了」。
  // stop.mjs 动手前会把记录里的 status 改成 stopping，停成功后再删除记录；
  // 两种情况都算正常被停，不算失败。
  let externallyStopped = false;
  try {
    const latest = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    externallyStopped = latest.status === 'stopping' || latest.status === 'stopped';
  } catch {
    externallyStopped = !fs.existsSync(pidFile); // 记录已删除 = stop 已经收尾
  }
  fs.rmSync(pidFile, { force: true });
  const clean = stopped || externallyStopped || exit.code === 0;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      command: 'start', ok: clean, url, pid: child.pid, logFile,
      exitCode: exit.code, signal: exit.signal, stoppedByUser: stopped || externallyStopped,
    }, null, 2)}\n`);
  } else if (stopped) {
    process.stderr.write('\n已停止（本地收到退出信号）。\n');
  } else if (externallyStopped) {
    process.stderr.write('\n已被 npm run stop 停止（PID 记录已清除）。\n');
  } else {
    process.stderr.write(`\n宿主进程自己退出了（退出码 ${exit.code ?? 'null'}${exit.signal ? `，信号 ${exit.signal}` : ''}）。日志：${logFile}\n`);
  }
  return clean ? 0 : 1;
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
    process.exitCode = await runStart();
  } catch (err) {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ command: 'start', ok: false, error: err.message }, null, 2)}\n`);
    }
    process.stderr.write(`start 失败：${err.message}\n`);
    process.exitCode = 1;
  }
}

export default { runStart };
