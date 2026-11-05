import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../config.mjs';
import { composeImageTags, loadAdvancedPrompt, parseTagResult } from '../lib/imageprompt.mjs';

function tempPipeline(promptText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipx-prompt-'));
  fs.mkdirSync(path.join(root, 'src/prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/prompts/advanced.txt'), promptText, 'utf8');
  return root;
}

test('the tag prompt is read from the reference install, not copied', () => {
  const root = tempPipeline('REFERENCE-PROMPT-TEXT');
  assert.equal(loadAdvancedPrompt(root), 'REFERENCE-PROMPT-TEXT');
  assert.equal(loadAdvancedPrompt(root, 'src/prompts/missing.txt'), '');
});

test('tag output must be JSON with a tag', () => {
  assert.deepEqual(parseTagResult('{"tag":"1girl, solo","negative":"bad hands"}'), { tag: '1girl, solo', negative: 'bad hands' });
  assert.deepEqual(parseTagResult('```json\n{"tag":"a, b"}\n```'), { tag: 'a, b', negative: '' });
  assert.throws(() => parseTagResult('just words'), /did not return JSON/);
  assert.throws(() => parseTagResult('{"tag":""}'), /empty tag/);
});

test('a tag-model failure falls back to the raw request', async () => {
  const root = tempPipeline('SYSTEM');
  const config = normalizeConfig({ image: { imagePipelineRoot: root } });
  const fallback = await composeImageTags({
    host: { available: () => true, async completeText() { return { text: 'not json' }; } },
    request: '窗边的午后',
    config,
  });
  assert.equal(fallback.tag, '窗边的午后');
  assert.equal(fallback.composed, false);

  const noHost = await composeImageTags({ host: null, request: '窗边的午后', config });
  assert.equal(noHost.composed, false);

  const ok = await composeImageTags({
    host: { available: () => true, async completeText() { return { text: '{"tag":"1girl, window, afternoon light"}' }; } },
    request: '窗边的午后',
    config,
  });
  assert.equal(ok.composed, true);
  assert.match(ok.tag, /afternoon light/);
  await assert.rejects(() => composeImageTags({ host: null, request: '   ', config }), /empty/);
});
