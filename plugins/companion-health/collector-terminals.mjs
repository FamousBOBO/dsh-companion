import { randomUUID } from 'node:crypto';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
  // Studio lives outside the Cordis realm that owns these PTYs. Share only the
  // constrained controller, including when this plugin is loaded via a local copy.
  const registryKey = Symbol.for('dsh-companion.health-collector-controllers');
  const registry = globalThis[registryKey] ??= new Map();
  const homeKey = path.resolve(home);
  if (registry.has(homeKey)) throw new Error('Collector controller already mounted');
  const file = path.join(home, 'companion', 'health-collector-terminals.json');
  const abort = new AbortController();
  const entries = new Map();
  let agent;
  let queue = Promise.resolve();

  async function config() {
    let value;
    try {
      value = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid collector configuration');
    return value;
  }

  function portFor(key, settings) {
    const port = settings?.port ?? collectors[key].port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid collector port');
    return port;
  }

  function terminalOf(entry) {
    return agent && entry && ctx.terminals.list(agent).find(item => item.sessionId === entry.id);
  }

  async function status() {
    const settings = await config();
    const rows = await Promise.all(Object.keys(collectors).map(async key => {
      const item = settings[key];
      const entry = entries.get(key);
      const port = entry?.port ?? portFor(key, item);
      const terminal = terminalOf(entry);
      const listening = await occupied(port).catch(() => null);
      const alive = Boolean(terminal && terminal.status?.kind !== 'exited' && !entry.failed);
      const state = alive
        ? listening ? 'running' : Date.now() - entry.startedAt < 60000 ? 'starting' : 'unresponsive'
        : listening ? 'occupied' : entry ? 'failed' : 'stopped';
      return { key, port, configured: Boolean(item), enabled: Boolean(item && item.enabled !== false),
        managed: Boolean(terminal), terminalId: terminal?.sessionId ?? null, state };
    }));
    return { available: true, collectors: rows };
  }

  async function start(key, settings) {
    const item = settings[key];
    if (!item || item.enabled === false) throw new Error('collector-disabled');
    const existing = entries.get(key);
    const terminal = terminalOf(existing);
    if (terminal && terminal.status?.kind !== 'exited' && !existing.failed) return;
    const collector = collectors[key];
    const port = portFor(key, item);
    if (Object.keys(collectors).some(other => other !== key && settings[other] && portFor(other, settings[other]) === port)) {
      throw new Error('collector-port-conflict');
    }
    if (terminal) await stop(key);
    if (await occupied(port)) throw new Error('collector-port-occupied');
    if (typeof item.python !== 'string' || !path.isAbsolute(item.python)) throw new Error('collector-config');
    const script = path.join(root, collector.script);
    await Promise.all([access(item.python), access(script)]).catch(() => { throw new Error('collector-config'); });
    const args = [item.python, '-u', script, ...collector.args, '--port', String(port)];
    let command = (process.platform === 'win32' ? '& ' : '') + args.map(quote).join(' ');
    if (key === 'cloud' && item.accountFile) {
      if (typeof item.accountFile !== 'string' || !path.isAbsolute(item.accountFile)) throw new Error('collector-config');
      await access(item.accountFile).catch(() => { throw new Error('collector-account'); });
      const account = quote(item.accountFile);
      command = process.platform === 'win32'
        ? '$env:HUAWEI_ACCOUNT_JSON = ' + account + '; ' + command
        : 'HUAWEI_ACCOUNT_JSON=' + account + ' ' + command;
    }

    abort.signal.throwIfAborted();
    if (!agent) ({ agent } = await ctx.agents.create({
      sessionId: 'session-' + randomUUID(),
      meta: { cwd: root },
      agentOptions: ctx.agentDefaultModel.currentSelection(),
      signal: abort.signal,
    }));
    const session = await ctx.terminals.spawn(agent, {
      type: 'shell', name: 'health-' + key, cwd: root,
    }, abort.signal);
    const entry = { id: session.sessionId, port, startedAt: Date.now(), failed: false };
    entries.set(key, entry);
    try {
      const operation = ctx.terminals.startSend(agent, entry.id, {
        text: command, submit: true, signal: abort.signal,
      });
      void operation.done.then(() => {}, () => { entry.failed = true; });
    } catch (error) {
      entry.failed = true;
      await stop(key);
      throw error;
    }
    console.info(`[${name}] ${key} command sent to ${entry.id}`);
  }

  async function stop(key) {
    const entry = entries.get(key);
    if (!entry) return;
    if (terminalOf(entry)) await ctx.terminals.kill(agent, entry.id, 'collector stopped by operator');
    entries.delete(key);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!await occupied(entry.port)) return;
      await delay(150, undefined, { signal: abort.signal });
    }
    throw new Error('collector-port-occupied');
  }

  async function setEnabled(key, settings, enabled) {
    if (!settings[key]) throw new Error('collector-config');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      settings[key].enabled = enabled;
      await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    if (!enabled) await stop(key);
  }

  function enqueue(work) {
    const result = queue.then(() => {
      abort.signal.throwIfAborted();
      return work();
    });
    queue = result.catch(() => {});
    return result;
  }

  const controller = {
    status,
    control(key, action, enabled) {
      if (!Object.hasOwn(collectors, key)) throw new Error('collector-config');
      return enqueue(async () => {
        const settings = await config();
        if (action === 'set-enabled' && typeof enabled === 'boolean') await setEnabled(key, settings, enabled);
        else if (action === 'stop') await stop(key);
        else if (action === 'start' || action === 'restart') {
          if (!settings[key] || settings[key].enabled === false) throw new Error('collector-disabled');
          if (action === 'restart') await stop(key);
          await start(key, settings);
        } else throw new Error('collector-config');
        return status();
      });
    },
  };

  ctx.effect(() => {
    registry.set(homeKey, controller);
    void enqueue(async () => {
      const settings = await config();
      for (const key of Object.keys(collectors)) {
        if (abort.signal.aborted) break;
        if (!settings[key] || settings[key].enabled === false) continue;
        try { await start(key, settings); }
        catch { console.warn(`[${name}] ${key} startup failed`); }
      }
    }).catch(() => {
      if (!abort.signal.aborted) console.warn(`[${name}] Unable to read collector settings`);
    });
    return () => {
      registry.delete(homeKey);
      abort.abort();
    };
  });
}
