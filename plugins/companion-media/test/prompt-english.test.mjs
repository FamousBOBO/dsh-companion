import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// NovelAI reads English captions only. The tool must ask for English directly
// (native), with the runtime translation kept as a fallback — not as the intended
// authoring path. These assertions pin the instruction text so a future edit
// cannot quietly go back to "write Chinese and let it be translated".

const source = fs.readFileSync(path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'index.mjs'), 'utf8');
const drawBlock = source.slice(source.indexOf("register('companion_media_draw'"), source.indexOf("register('companion_media_warm'"));

test('the draw tool demands an English prompt', () => {
  assert.match(drawBlock, /prompt 必须直接写成英文/, 'the description must say the prompt has to be written in English');
  assert.match(drawBlock, /中文进去等于噪声/, 'the description must explain why Chinese fails');
  assert.match(drawBlock, /翻译只是兜底/, 'translation must be described as a fallback, not the usage');
});

test('the prompt parameter itself says English, with an English example', () => {
  assert.match(drawBlock, /英文画面描述，必须是英文/);
  assert.match(drawBlock, /March 7th from Honkai: Star Rail, pink hair, blue-to-pink gradient eyes/);
  // No Chinese example sentence in the prompt parameter: it would invite Chinese input.
  assert.doesNotMatch(drawBlock, /例如：“《崩坏：星穹铁道》/, 'the old Chinese example must be gone');
});

test('style and composeTags guidance stay English-first', () => {
  assert.match(drawBlock, /同样用英文/);
  assert.match(drawBlock, /都用英文自然语言写 prompt/);
  // context may stay Chinese because only the tag model reads it.
  assert.match(drawBlock, /可写中文/);
});
