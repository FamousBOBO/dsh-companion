import { realpathSync } from 'node:fs';
import { createBilibiliRounds } from './bilibili-rounds.mjs';
import { join } from 'node:path';

const PROVIDERS = Symbol.for('dsh.companion.bilibili.providers.v1');

export function createBilibiliProviderPort(stateDirectory, { now = Date.now } = {}) {
  function provider() {
    try {
      const entry = process[PROVIDERS]?.get(realpathSync(stateDirectory));
      return entry?.ready() === true ? entry : null;
    } catch {
      return null;
    }
  }
  const run = createBilibiliRounds({
    directory: join(stateDirectory, 'p2-rounds'),
    now,
    execute(request) {
      const entry = provider();
      return entry ? entry.run(request) : { status: 'failed' };
    },
  });
  run.available = () => provider() !== null;
  return run;
}
