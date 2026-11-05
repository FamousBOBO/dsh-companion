import { spawn } from 'node:child_process';

/**
 * Run one child process with a deadline and optional stdin bytes.
 * @returns `{ code, stdout, stderr, timedOut }` — never throws for a non-zero exit.
 */
export function runProcess(command, args, { input, timeoutMs = 60_000, cwd, env } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(error?.message ?? error)), timedOut: false });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout?.on('data', chunk => out.push(chunk));
    child.stderr?.on('data', chunk => err.push(chunk));
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.from(String(error?.message ?? error)), timedOut });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut });
    });
    if (input !== undefined && input !== null) {
      child.stdin?.on('error', () => { /* the child may close stdin early */ });
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}
