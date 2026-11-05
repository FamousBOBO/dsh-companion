import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../logs/test-runs');
fs.mkdirSync(testRoot, { recursive: true });

test('confirmed memories and events survive a fresh store instance', t => {
  const dir = fs.mkdtempSync(path.join(testRoot, 'companion-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createStore(dir);
  first.remember('饮食偏好', '不喝咖啡');
  first.record('desktop', '用户确认了饮食偏好');
  const second = createStore(dir);
  assert.equal(second.recall('咖啡')[0].value, '不喝咖啡');
  assert.equal(second.events()[0].source, 'desktop');
  assert.equal(second.status().revision, 2);
  second.remember('饮食偏好', '喜欢茶');
  assert.equal(second.recall().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json.previous'), 'utf8')).revision, 2);
});

test('invalid or corrupted data fails without replacing the saved state', t => {
  const dir = fs.mkdtempSync(path.join(testRoot, 'companion-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  store.remember('confirmed', 'yes');
  assert.throws(() => store.remember('__proto__', 'invalid'));
  assert.throws(() => store.remember('empty', ''));
  assert.throws(() => store.record('unknown', 'invalid'));
  assert.equal(store.status().revision, 1);
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  assert.throws(() => store.recall());
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{broken');
});
