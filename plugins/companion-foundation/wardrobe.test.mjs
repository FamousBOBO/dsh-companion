import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWardrobe, currentOutfit, renderWardrobePrompt, wardrobeDetail, setOutfit } from './wardrobe.mjs';

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wardrobe-'));
  fs.mkdirSync(path.join(dir, 'home/companion'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('default wardrobe has a deterministic current outfit and prompt', (t) => {
  const dir = root(t);
  const now = Date.UTC(2026, 9, 31, 4, 0, 0);
  const a = currentOutfit(loadWardrobe(dir), now);
  const b = currentOutfit(loadWardrobe(dir), now);
  assert.deepEqual(a.items.map(i => i.id), b.items.map(i => i.id));
  assert.ok(a.items.length >= 3);
  const prompt = renderWardrobePrompt(dir, now);
  assert.match(prompt, /衣柜与当前衣物/);
  assert.match(prompt, /今天穿/);
  assert.match(prompt, /companion_wardrobe_detail/);
});

test('explicit outfit overrides the daily rotation and detail reads it back', (t) => {
  const dir = root(t);
  const now = Date.UTC(2026, 9, 31, 4, 0, 0);
  const wardrobe = loadWardrobe(dir);
  const ids = [wardrobe.items.find(i => i.slot === 'upper').id, wardrobe.items.find(i => i.slot === 'lower').id];
  const saved = setOutfit(dir, { itemIds: ids, instruction: '今天想轻便一点', now });
  assert.equal(saved.ok, true);
  const today = wardrobeDetail(dir, { scope: 'today', now });
  assert.equal(today.ok, true);
  assert.equal(today.source, 'explicit');
  assert.deepEqual(today.items.map(i => i.id), ids);
  assert.match(today.instruction, /轻便/);
  assert.match(renderWardrobePrompt(dir, now), /轻便一点/);
});

test('unknown outfit item is rejected and does not mutate the current outfit', (t) => {
  const dir = root(t);
  const before = currentOutfit(loadWardrobe(dir), Date.UTC(2026, 9, 31, 4, 0, 0));
  const result = setOutfit(dir, { itemIds: ['not-a-real-item'], now: Date.UTC(2026, 9, 31, 4, 0, 0) });
  assert.equal(result.ok, false);
  const after = currentOutfit(loadWardrobe(dir), Date.UTC(2026, 9, 31, 4, 0, 0));
  assert.deepEqual(after.items.map(i => i.id), before.items.map(i => i.id));
});
