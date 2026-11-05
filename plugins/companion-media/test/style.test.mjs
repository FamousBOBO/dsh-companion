import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, loadStyleDefaults, normalizeConfig, withStyle } from '../config.mjs';
import { buildImageParams } from '../lib/imagegen.mjs';
import { tempRoot } from './helpers.mjs';

// The old pipeline prepended a fixed style to every request:
//   tag      = default_prompt + caller prompt
//   negative = default_negative_prompt + caller negative
//   artist   = encoder-rendered caption prefix
// These tests pin the migrated behaviour so a refactor cannot silently drop it.

const PLUGIN_ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

test('the migrated style file carries the old strings verbatim', () => {
  const style = loadStyleDefaults(PLUGIN_ROOT);
  assert.ok(style, 'presets/nai-style.json must exist');
  assert.equal(style.applyDefaults, true);
  assert.match(style.defaultPrompt, /masterpiece, best quality/);
  assert.match(style.defaultPrompt, /artist:mashiro_shiki/);
  assert.match(style.defaultPrompt, /official style/);
  assert.match(style.defaultNegative, /lowres/);
  assert.match(style.defaultNegative, /negative space, blank page/);
  assert.ok(style.defaultPrompt.length > 120);
  assert.ok(style.defaultNegative.length > 150);
  assert.equal(style.artist, '', 'the artist tags live inside defaultPrompt in the live config');
});

test('loading the config fills the style defaults when the file omits them', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'home/media'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/media/config.json'), JSON.stringify({ image: { enabled: true } }), 'utf8');
  const { config } = loadConfig(root);
  assert.match(config.image.style.defaultPrompt, /artist:mashiro_shiki/);
  assert.match(config.image.style.defaultNegative, /lowres/);
});

test('an explicit operator value wins over the migrated default', () => {
  const config = withStyle(normalizeConfig({
    image: { style: { applyDefaults: true, defaultPrompt: 'my own style', defaultNegative: '' } },
  }), PLUGIN_ROOT);
  assert.equal(config.image.style.defaultPrompt, 'my own style');
  assert.match(config.image.style.defaultNegative, /lowres/, 'a blank field is still filled from the file');
});

test('applyDefaults:false disables every preset part', () => {
  const config = withStyle(normalizeConfig({
    image: { style: { applyDefaults: false } },
  }), PLUGIN_ROOT);
  const params = buildImageParams({ prompt: '1girl, solo' }, config);
  assert.equal(params.tag, '1girl, solo');
  assert.equal(params.negative, undefined);
  assert.equal(params.artist, undefined);
});

test('the request tag is preset + caller prompt, and the negative is preset + caller negative', () => {
  const config = withStyle(normalizeConfig({ image: { style: {} } }), PLUGIN_ROOT);
  const params = buildImageParams({ prompt: '窗前的一只猫', style: '二次元', negative: 'extra bad' }, config);
  assert.ok(params.tag.startsWith('4::masterpiece, best quality'), params.tag);
  assert.ok(params.tag.endsWith('窗前的一只猫, (二次元)'), params.tag);
  assert.ok(params.negative.startsWith('lowres'), params.negative);
  assert.ok(params.negative.endsWith('extra bad'), params.negative);
});

test('a caller artist is passed through for the encoder', () => {
  const config = withStyle(normalizeConfig({ image: { style: { artist: '0.8::artist:someone::' } } }), PLUGIN_ROOT);
  const params = buildImageParams({ prompt: '1girl' }, config);
  assert.equal(params.artist, '0.8::artist:someone::');
});
