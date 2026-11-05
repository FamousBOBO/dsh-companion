import assert from 'node:assert/strict';
import test from 'node:test';
import { needsTranslation, translateImagePrompt } from '../lib/imageprompt.mjs';
import { normalizeConfig } from '../config.mjs';

// NovelAI reads English captions only. A Chinese prompt used to reach
// `v4_prompt.caption.base_caption` verbatim, where the model cannot follow it.

const config = normalizeConfig({});

function fakeHost(reply) {
  const calls = [];
  return {
    calls,
    available: () => true,
    completeText: async (options) => {
      calls.push(options);
      if (typeof reply === 'function') return reply(options);
      return { text: reply };
    },
  };
}

test('chinese and japanese prompts need translation, english ones do not', () => {
  assert.equal(needsTranslation('窗边的午后，一只猫趴在窗台上'), true);
  assert.equal(needsTranslation('a cat on a windowsill, warm afternoon light'), false);
  assert.equal(needsTranslation('1girl, solo, masterpiece'), false);
  assert.equal(needsTranslation('三月七看着镜头'), true);
});

test('an english prompt is returned untouched without calling the model', async () => {
  const host = fakeHost('should not be used');
  const result = await translateImagePrompt({ host, request: 'a cat on a windowsill', config });
  assert.equal(result.translated, false);
  assert.equal(result.prompt, 'a cat on a windowsill');
  assert.equal(host.calls.length, 0);
});

test('a chinese prompt is translated and the style hint is folded in', async () => {
  const host = fakeHost('a cat lying on a windowsill in the afternoon, soft watercolor style');
  const result = await translateImagePrompt({
    host, request: '窗边的午后，一只猫趴在窗台上', style: '柔和水彩', config,
  });
  assert.equal(result.translated, true);
  assert.match(result.prompt, /windowsill/);
  assert.equal(result.style, '', 'the style hint must not be appended twice');
  assert.equal(host.calls.length, 1);
  assert.match(host.calls[0].system, /NovelAI/);
  assert.match(host.calls[0].input, /窗边的午后/);
  assert.equal(host.calls[0].purpose, 'companion-media-image-translate');
});

test('a model that answers in chinese is treated as a failure, not shipped', async () => {
  const host = fakeHost('一只猫在窗台上');
  const result = await translateImagePrompt({ host, request: '窗边的一只猫', config });
  assert.equal(result.translated, false);
  assert.equal(result.prompt, '窗边的一只猫');
  assert.equal(result.reason, 'translation failed');
});

test('an unavailable host leaves the prompt alone but says why', async () => {
  const host = { available: () => false, completeText: async () => ({ text: 'x' }) };
  const result = await translateImagePrompt({ host, request: '窗边的一只猫', config });
  assert.equal(result.translated, false);
  assert.equal(result.reason, 'host llm unavailable');
});
