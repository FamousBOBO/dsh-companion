import path from 'node:path';
import os from 'node:os';

// Windows ACL sandboxes reject a temp root inside the agent workspace.
// Do not inherit a suite-local TEMP from an outer harness.
export function hostTempRoot({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return os.tmpdir();
  if (!env.LOCALAPPDATA || !path.win32.isAbsolute(env.LOCALAPPDATA)) {
    throw new Error('LOCALAPPDATA must name an absolute Windows directory for host temporary files');
  }
  return path.win32.join(env.LOCALAPPDATA, 'Temp', 'dsh-companion-host');
}
