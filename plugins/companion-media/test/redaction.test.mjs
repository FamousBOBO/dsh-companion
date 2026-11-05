import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSecret, maskSecret, redactText, redactUrl, sanitize } from '../src/secrets.mjs';
import { maskConfig } from '../src/config-store.mjs';
import { mapRemoteStatus } from '../src/errors.mjs';

const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

test('redactText 抹掉 bearer / sk- / 长串令牌', () => {
  const text = `Authorization: Bearer ${KEY} and token=${KEY}`;
  const redacted = redactText(text);
  assert.equal(redacted.includes(KEY), false);
  assert.match(redacted, /\[redacted\]/);
});

test('maskSecret 只保留首二末四', () => {
  assert.equal(maskSecret('sk-1234567890abcd'), 'sk…abcd');
  assert.equal(maskSecret('short'), '*****');
  assert.equal(maskSecret(''), '');
  assert.equal(describeSecret('').configured, false);
  const described = describeSecret(KEY);
  assert.equal(described.configured, true);
  assert.equal(JSON.stringify(described).includes(KEY), false);
});

test('describeSecret 对缺失的 key 给出环境变量名而不是空话', () => {
  const described = describeSecret('', { envVar: 'DSH_MEDIA_OPENAI_API_KEY' });
  assert.equal(described.configured, false);
  assert.equal(described.envVar, 'DSH_MEDIA_OPENAI_API_KEY');
});

test('sanitize 按键名抹掉嵌套密钥', () => {
  const value = sanitize({
    image: { 'openai-compatible': { apiKey: KEY, baseUrl: 'https://example.test/v1' } },
    tts: { providers: { 'fish-audio': { apiKey: 'fish_abcdefghijklmn' } } },
    headers: { Authorization: `Bearer ${KEY}` },
    note: 'ok',
  });
  const text = JSON.stringify(value);
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes('fish_abcdefghijklmn'), false);
  assert.equal(value.image['openai-compatible'].baseUrl, 'https://example.test/v1');
});

test('redactUrl 抹掉 query 里的令牌与 userinfo', () => {
  const url = redactUrl('https://user:pass@example.test/path?api_key=SECRETVALUE&x=1');
  assert.equal(url.includes('SECRETVALUE'), false);
  assert.equal(url.includes('pass'), false);
});

test('maskConfig：GET 只看到掩码，看不到明文', () => {
  const masked = maskConfig({
    vision: { apiKey: '' },
    image: { 'openai-compatible': { apiKey: KEY }, nai: { apiKey: 'pst-ABCDEFGHIJKLMNOPQRSTUV' } },
    tts: { providers: { 'breeze-tts2': { apiKey: '' }, 'fish-audio': { apiKey: 'fish_zzzzzzzzzzzzzzzz' } } },
  });
  const text = JSON.stringify(masked);
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes('pst-ABCDEFGHIJKLMNOPQRSTUV'), false);
  assert.equal(text.includes('fish_zzzzzzzzzzzzzzzz'), false);
  assert.equal(masked.image['openai-compatible'].apiKey.configured, true);
  assert.match(masked.image['openai-compatible'].apiKey.mask, /^sk…/);
  assert.equal(masked.tts.providers['breeze-tts2'].apiKey.configured, false);
});

test('错误消息不因为上游 body 带 key 而泄漏', () => {
  const failure = mapRemoteStatus(401, { provider: 'OpenAI', body: `invalid key ${KEY}` });
  assert.equal(failure.message.includes(KEY), false);
  assert.equal(failure.code, 'MEDIA_AUTH_FAILED');
  assert.match(failure.message, /\[redacted\]/);
});

test('429 明确说明不会自动重试（避免重复扣费）', () => {
  const failure = mapRemoteStatus(429, { provider: 'NovelAI', retryAfter: '30' });
  assert.equal(failure.code, 'MEDIA_RATE_LIMITED');
  assert.match(failure.message, /does not auto-retry/);
  assert.match(failure.message, /Retry-After: 30/);
});
