import { autoResolution } from './resolution.mjs';

// Named presets contain generation parameters only, never credentials or endpoints.
export const GENERATION_FIELDS = Object.freeze([
  'qualityPreset', 'negativePreset', 'model', 'autoResolution', 'aspect', 'width', 'height', 'steps', 'scale', 'sampler',
  'noiseSchedule', 'seed', 'ucPreset', 'qualityToggle', 'sm', 'smDyn', 'negativePrompt', 'artistString',
]);

export function resolveGenerationSection(section) {
  if (section.autoResolution !== true) return { ...section };
  const size = autoResolution({ aspect: section.aspect, targetPixels: 1_011_712 });
  if (!size.ok) throw new Error(size.message || '无法计算分辨率');
  return { ...section, width: size.width, height: size.height };
}

export function validateGenerationLibrary(nai) {
  const errors = [];
  const add = (path, message) => errors.push({ path: `image.nai.${path}`, code: 'MEDIA_CONFIG_INVALID', message });
  if (typeof nai.autoResolution !== 'boolean') add('autoResolution', '自动分辨率开关无效');
  if (!['portrait', 'landscape', 'square'].includes(nai.aspect)) add('aspect', '请选择竖图、横图或方图');
  const library = nai.generationPresets;
  if (!Array.isArray(library) || library.length > 32) { add('generationPresets', '最多保存32个生成预设'); return errors; }
  const ids = new Set();
  for (const item of library) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80) {
      add('generationPresets', '预设需要唯一标识和1–80字名称'); continue;
    }
    ids.add(item.id);
    if (!item.settings || typeof item.settings !== 'object' || Array.isArray(item.settings)
      || Object.keys(item.settings).some(key => !GENERATION_FIELDS.includes(key))) {
      add('generationPresets', '预设只能包含生成参数'); continue;
    }
    for (const key of Object.keys(item)) if (!['id', 'name', 'settings', 'presets'].includes(key)) add('generationPresets', '预设包含未知字段');
    if (Object.values(item.settings).some(v => !['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'string' && v.length > 12000))) add('generationPresets', '预设参数格式无效');
    const families = item.presets;
    if (families && (typeof families !== 'object' || Array.isArray(families) || Object.keys(families).some(k => !['5', '4.5'].includes(k)))) add('generationPresets', '预设模型族无效');
    for (const entry of Object.values(families || {})) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(k => !['positive', 'negative', 'applyDefaults'].includes(k))
        || typeof entry.applyDefaults !== 'boolean' || typeof entry.positive !== 'string' || typeof entry.negative !== 'string'
        || entry.positive.length > 12000 || entry.negative.length > 12000) add('generationPresets', '提示词预设格式无效');
    }
  }
  if (nai.activePresetId && !ids.has(nai.activePresetId)) add('activePresetId', '找不到选中的生成预设');
  return errors;
}
