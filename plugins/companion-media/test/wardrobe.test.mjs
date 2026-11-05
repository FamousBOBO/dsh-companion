import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveOutfit, wardrobePath } from '../lib/wardrobe.mjs';

// Image generation used to ignore the wardrobe entirely: the model invented an
// outfit that was not the character's (observed 2026-11-04). The wardrobe is a
// deterministic variable in companion-foundation — pictures must use it too.

function sandbox(wardrobe) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-wardrobe-'));
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  fs.writeFileSync(wardrobePath(root), JSON.stringify(wardrobe), 'utf8');
  return root;
}

const ITEMS = [
  { id: 'w-upper-hoodie', name: '白色连帽卫衣', slot: 'upper', description: '', tags: [] },
  { id: 'w-lower-shorts', name: '深蓝牛仔短裤', slot: 'lower', description: '', tags: [] },
  { id: 'w-feet-sneakers', name: '白色运动鞋', slot: 'feet', description: '', tags: [] },
];

test('today\'s wardrobe outfit becomes an english clause', async () => {
  const root = sandbox({ version: 1, tendency: '', items: ITEMS, current: null });
  const result = await resolveOutfit({ root, now: Date.parse('2026-11-04T10:00:00+08:00') });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'daily');
  assert.equal(result.injected, true);
  assert.match(result.clause, /a soft white hoodie/);
  assert.match(result.clause, /navy denim shorts/);
  assert.match(result.clause, /white low-top sneakers/);
  assert.equal(result.date, '2026-11-04');
});

test('an explicit outfit set for today wins over the daily pick', async () => {
  const root = sandbox({
    version: 1, tendency: '', items: ITEMS,
    current: { date: '2026-11-04', itemIds: ['w-upper-hoodie'], instruction: '换上卫衣', updatedAt: 1 },
  });
  const result = await resolveOutfit({ root, now: Date.parse('2026-11-04T20:00:00+08:00') });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'explicit');
  assert.equal(result.clause, 'a soft white hoodie');
  assert.deepEqual(result.items, ['w-upper-hoodie']);
});

test('a prompt that already names a wardrobe item is not double-dressed', async () => {
  const root = sandbox({ version: 1, tendency: '', items: ITEMS, current: null });
  const result = await resolveOutfit({
    root,
    now: Date.parse('2026-11-04T10:00:00+08:00'),
    prompt: 'March 7th wearing a soft white hoodie, sitting by the window',
  });
  assert.equal(result.ok, true);
  assert.equal(result.injected, false);
  assert.equal(result.source, 'prompt');
});

test('a wardrobe file the foundation cannot read degrades to a reason, not a crash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-wardrobe-empty-'));
  const result = await resolveOutfit({ root, now: Date.now() });
  // No wardrobe.json: the foundation falls back to its defaults, so this still
  // resolves — the point is that it never throws.
  assert.equal(typeof result.ok, 'boolean');
  if (result.ok === false) assert.equal(typeof result.reason, 'string');
});

test('the outfit lands in the encoded tag, after the prompt', async () => {
  const { buildImageParams } = await import('../lib/imagegen.mjs');
  const { normalizeConfig } = await import('../config.mjs');
  const config = normalizeConfig({ image: { style: { applyDefaults: false } } });
  const params = buildImageParams({ prompt: 'March 7th by the window', outfit: 'a soft white hoodie' }, config);
  assert.equal(params.tag, 'March 7th by the window, wearing a soft white hoodie');
});

test('end to end: a dry-run draw reports the clothes in the caption it would send', async () => {
  // Regression for 2026-11-05: draw() resolved the wardrobe and set request.outfit,
  // but imagegen.generate() rebuilt the params without that field, so the caption
  // reached NovelAI with no clothes at all while `outfit.injected` still said true.
  const { mountMedia, apply } = await import('../index.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-outfit-e2e-'));
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  fs.writeFileSync(wardrobePath(root), JSON.stringify({ version: 1, tendency: '', items: ITEMS, current: null }), 'utf8');

  const ctx = {
    tools: { register() {} },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  mountMedia(ctx, { companionRoot: root });
  const service = apply(ctx);
  const result = await service.draw({
    prompt: 'March 7th from Honkai: Star Rail, pink hair, sitting by the train window at dusk',
    sessionId: 'test-outfit-e2e',
    dryRun: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.outfit.injected, true);
  assert.equal(typeof result.caption, 'string');
  assert.ok(result.outfit.clause.length > 0, 'the resolved clause must be reported back');
  assert.ok(
    result.caption.includes(result.outfit.clause),
    `the caption must carry the wardrobe clause; got ${result.caption}`,
  );
});
