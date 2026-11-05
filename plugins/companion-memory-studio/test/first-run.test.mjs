import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 「全新数据目录」是用户第一次打开 Web UI 的真实场景：没有 identity.json、没有配置。
// 这里断言 bundle 的 Host 半**能挂上**并留下合法身份，而不是让宿主打
// `warning: N entries did not activate`、侧栏少一个入口。
test('fresh data directory: the Studio host half activates and provisions a local owner', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-first-run-'));
  const previous = process.env.DSH_COMPANION_DATA_DIR;
  process.env.DSH_COMPANION_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_COMPANION_DATA_DIR;
    else process.env.DSH_COMPANION_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });

  // The data root is resolved when the module is first evaluated, so the env must be
  // set before the import. The query string only keeps this module instance private.
  const moduleUrl = `../index.js?first-run=${Date.now()}`;
  const mod = await import(moduleUrl);

  const provided = new Map();
  const ctx = {
    get: name => provided.get(name),
    provide: (name, value) => { provided.set(name, value); },
    effect: () => {},
    on: () => {},
    inject: () => {},
  };

  // 1. 挂得上：不抛异常。
  await mod.apply(ctx);
  const service = provided.get('companionMemory');
  assert.ok(service?.engine, 'the shared memory engine must be provided to the host');
  assert.equal(service.root, root, 'the engine root must be the resolved data root');

  // 2. 首次访问后 identity.json 存在且合法。
  const identityFile = path.join(root, 'home/companion/identity.json');
  assert.equal(fs.existsSync(identityFile), true, 'first run must leave a valid identity file');
  const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
  assert.equal(identity.schemaVersion, 1);
  assert.equal(identity.persona, 'bot');
  assert.equal(identity.owner.id, 'local-owner');
  assert.equal(identity.desktop.mode, 'local-owner');
  assert.deepEqual(identity.sessions, {});

  // 3. 诊断与日志落在数据根里，绝不落回源码树。
  const logFile = path.join(root, 'logs/memory-studio.jsonl');
  assert.equal(fs.existsSync(logFile), true, 'the mount must log under <dataRoot>/logs');
  const { STUDIO_ROOT } = await import('../server.mjs');
  assert.equal(STUDIO_ROOT, root, 'the health bridge must be keyed by the data root, not the checkout root');

  // 4. 第二次激活幂等：复用同一个引擎，不开第二个 SQLite writer。
  const before = service.engine;
  await mod.apply(ctx);
  assert.equal(provided.get('companionMemory').engine, before, 'a second activation must reuse the engine');
  assert.equal(JSON.parse(fs.readFileSync(identityFile, 'utf8')).owner.id, 'local-owner');
});
