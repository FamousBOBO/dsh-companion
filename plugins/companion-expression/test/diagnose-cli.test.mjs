import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openExpressionDb } from '../src/db.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

test('diagnose CLI does not initialize missing data or migrate an existing database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expression-cli-'));
  const script = fileURLToPath(new URL('../scripts/diagnose.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [script, '--json'], {
    env: { ...process.env, DSH_COMPANION_DATA_DIR: root }, encoding: 'utf8',
  });
  try {
    assert.equal(run().status, 1);
    assert.deepEqual(fs.readdirSync(root), []);
    const dir = path.join(root, 'home/expression');
    fs.mkdirSync(dir, { recursive: true });
    const config = path.join(dir, 'config.json');
    const file = path.join(dir, 'expression.sqlite');
    fs.writeFileSync(config, JSON.stringify(DEFAULT_CONFIG));
    const db = openExpressionDb({ file });
    db.setMeta('scope_salt', 'test-salt');
    db.close();
    const before = fs.readFileSync(file);
    const configBefore = fs.readFileSync(config);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).library.assets, 0);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readFileSync(config), configBefore);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
