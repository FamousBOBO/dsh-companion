import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';

export const name = 'companion-health-collector-terminals';
export const inject = ['agents', 'agentDefaultModel', 'terminals'];

const collectors = {
  cloud: { port: 8765, script: 'sidecars/huawei-health-cn/python/huawei_dashboard.py', args: ['serve', '--host', '127.0.0.1'] },
  ble: { port: 8151, script: 'sidecars/ble-heart-rate/heart_rate.py', args: [] },
};

function quote(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('Invalid shell argument');
  if (process.platform === 'win32') return "'" + value.replaceAll(/['‘’]/gu, c => c + c) + "'";
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function occupied(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Port probe timed out')); });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

export function apply(ctx) {
  const root = process.env.DSH_COMPANION_SUITE_ROOT;
  const home = process.env.DSH_HOME;
  if (!root || !home) return;
  const report = (message) => console.info(`[${name}] ${message}`);
  const abort = new AbortController();
  const launch = async () => {
    const file = path.join(home, 'companion', 'health-collector-terminals.json');
    let config;
    try {
      config = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const jobs = [];
    for (const [key, collector] of Object.entries(collectors)) {
      const settings = config[key];
      if (!settings) continue;
      const port = settings.port ?? collector.port;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid collector port');
      if (!path.isAbsolute(settings.python)) throw new Error('An absolute Python executable is required');
      const args = [settings.python, '-u', path.join(root, collector.script), ...collector.args, '--port', String(port)];
      let command = (process.platform === 'win32' ? '& ' : '') + args.map(quote).join(' ');
      if (key === 'cloud' && settings.accountFile) {
        if (!path.isAbsolute(settings.accountFile)) throw new Error('An absolute account file path is required');
        try {
          await access(settings.accountFile);
        } catch {
          report('cloud credential file is not accessible; skipped');
          continue;
        }
        const account = quote(settings.accountFile);
        command = process.platform === 'win32'
          ? '$env:HUAWEI_ACCOUNT_JSON = ' + account + '; ' + command
          : 'HUAWEI_ACCOUNT_JSON=' + account + ' ' + command;
      }
      jobs.push({ key, command, port });
    }
    if (new Set(jobs.map(job => job.port)).size !== jobs.length) throw new Error('Collector ports must differ');
    const pending = [];
    for (const job of jobs) {
      if (await occupied(job.port)) report(`${job.key} port ${job.port} is occupied; skipped`);
      else pending.push(job);
    }
    if (!pending.length) return;
    abort.signal.throwIfAborted();
    const { agent } = await ctx.agents.create({
      sessionId: 'session-' + randomUUID(),
      meta: { cwd: root },
      agentOptions: ctx.agentDefaultModel.currentSelection(),
      signal: abort.signal,
    });
    for (const job of pending) {
      let terminal;
      try {
        terminal = await ctx.terminals.spawn(agent, {
          type: 'shell', name: 'health-' + job.key, cwd: root,
        }, abort.signal);
        const operation = ctx.terminals.startSend(agent, terminal.sessionId, {
          text: job.command, submit: true, signal: abort.signal,
        });
        void operation.done.then(result => {
          if (!abort.signal.aborted && Number.isInteger(result.exitCode) && result.exitCode !== 0) {
            report(`${job.key} command exited with code ${result.exitCode}`);
          }
        }, () => {
          if (!abort.signal.aborted) report(`${job.key} command failed`);
        });
        report(`${job.key} command sent to ${terminal.sessionId} (shell PID ${terminal.pid ?? 'unknown'})`);
      } catch (error) {
        if (terminal) await ctx.terminals.kill(agent, terminal.sessionId, 'collector launch failed');
        if (!abort.signal.aborted) report(`${job.key} PTY launch failed: ${error.message}`);
      }
    }
  };
  ctx.effect(() => {
    void launch().catch(error => {
      if (!abort.signal.aborted) report(`Startup failed: ${error.message}`);
    });
    return () => abort.abort();
  });
}
