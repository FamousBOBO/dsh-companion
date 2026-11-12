import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPresets, normalizePresets, presetFamilyFor, resolvePreset } from '../src/presets.mjs';
import { ASPECTS, NAI_SIZE_RULES, autoResolution, parseSize, previewResolution, validateResolution } from '../src/resolution.mjs';

test('预设：V5 与 4.5 分开存储，互不覆盖', () => {
  const stored = normalizePresets({
    '5': { applyDefaults: true, positive: 'v5-positive', negative: 'v5-negative' },
    '4.5': { applyDefaults: true, positive: 'v45-positive', negative: 'v45-negative' },
  });
  const v5 = resolvePreset({ model: 'nai-diffusion-5-full', presets: stored, request: { prompt: 'a cat' } });
  const v45 = resolvePreset({ model: 'nai-diffusion-4-5-full', presets: stored, request: { prompt: 'a cat' } });
  assert.equal(v5.family, '5');
  assert.equal(v45.family, '4.5');
  assert.equal(v5.positive, 'a cat');
  assert.equal(v5.positive.includes('v45-'), false);
  assert.equal(v45.positive, 'a cat');
  assert.equal(v45.positive.includes('v5-'), false);
});

test('预设：切换模型不会套错族；applyDefaults=false 时只用请求本身', () => {
  const stored = normalizePresets({ '5': { applyDefaults: true, positive: 'P5', negative: 'N5' } });
  const off = resolvePreset({ model: 'nai-diffusion-5-full', presets: normalizePresets({ '5': { positive: 'P5' } }), request: { prompt: 'x' } });
  assert.equal(off.positive, 'x');
  const unknown = resolvePreset({ model: 'some-other-model', presets: stored, request: { prompt: 'x' } });
  assert.equal(unknown.family, 'other');
  assert.equal(unknown.positive, 'x');
  assert.equal(unknown.warnings.length, 1);
});

test('预设：清空是受支持的状态（不报错，也不悄悄套默认）', () => {
  const empty = emptyPresets();
  const resolved = resolvePreset({ model: 'nai-diffusion-4-5-full', presets: empty, request: { prompt: 'only this' } });
  assert.equal(resolved.positive, 'only this');
  assert.equal(resolved.negative, '');
});

test('预设：反向提示词按 预设 → 配置基础 → 请求 顺序拼接', () => {
  const stored = normalizePresets({ '4.5': { applyDefaults: true, negative: 'preset' } });
  const resolved = resolvePreset({ model: 'nai-diffusion-4-5-full', presets: stored, negativePrompt: 'base', request: { prompt: 'p', negative: 'extra' } });
  assert.equal(resolved.negative, 'preset, base, extra');
});

test('分辨率：固定尺寸校验通过/失败都明确', () => {
  assert.deepEqual(parseSize('832x1216'), { width: 832, height: 1216, pixels: 1011712 });
  assert.equal(parseSize('832*1216'), null);
  const ok = previewResolution({ mode: 'fixed', size: '832x1216' });
  assert.equal(ok.ok, true);
  assert.equal(ok.width, 832);
  const bad = previewResolution({ mode: 'fixed', size: '800x800' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'MEDIA_PARAM_OUT_OF_RANGE');
  assert.match(bad.error.message, /multiple of 64/);
});

test('分辨率：自动计算对齐 64，且可复现（同一输入同一结果）', () => {
  const first = autoResolution({ aspect: 'portrait', targetPixels: 1_011_712 });
  const second = autoResolution({ aspect: 'portrait', targetPixels: 1_011_712 });
  assert.equal(first.ok, true);
  assert.equal(first.width % NAI_SIZE_RULES.multipleOf, 0);
  assert.equal(first.height % NAI_SIZE_RULES.multipleOf, 0);
  assert.deepEqual(first, second);
  assert.equal(previewResolution({ mode: 'auto', aspect: 'portrait', targetPixels: 1_011_712 }).size, `${first.width}x${first.height}`);
});

test('分辨率：超出声明范围报错，绝不静默收敛', () => {
  const tooMany = autoResolution({ aspect: 'square', targetPixels: 12_000_000 });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'MEDIA_PARAM_OUT_OF_RANGE');
  const tooLong = validateResolution({ width: 4096, height: 4096 });
  assert.equal(tooLong.ok, undefined);
  assert.equal(tooLong.code, 'MEDIA_PARAM_OUT_OF_RANGE');
  const tiny = validateResolution({ width: 128, height: 128 });
  assert.equal(tiny.code, 'MEDIA_PARAM_OUT_OF_RANGE');
});

test('分辨率：所有画幅都在声明范围内可用', () => {
  for (const aspect of Object.keys(ASPECTS)) {
    const resolved = autoResolution({ aspect, targetPixels: 1_011_712 });
    assert.equal(resolved.ok, true, `${aspect}: ${resolved.message ?? ''}`);
  }
});

test('参数边界：非法目标像素与未知画幅被拒', () => {
  assert.equal(autoResolution({ aspect: 'panorama' }).ok, false);
  assert.equal(autoResolution({ aspect: 'portrait', targetPixels: -5 }).ok, false);
});
