/**
 * NovelAI prompt presets, kept per model family.
 *
 * Requirement (design/media-migration-dsh-task.md): "V5 与 4.5 的官方正/反向
 * 提示词预设分开，切换模型时不能套错预设."
 *
 * Implementation: the presets object is namespaced BY FAMILY
 * (`presets['5']`, `presets['4.5']`), so switching the model can never read the
 * other family's text, and editing one family never overwrites the other.
 *
 * Honesty note: the official quality-tag / undesired-content strings are shown
 * in NovelAI's own UI, and M0 could not retrieve an authoritative copy of their
 * exact text (see docs/media/M0-report.md §2.4). The built-in defaults are
 * therefore EMPTY placeholders. The plugin never invents "official" preset text;
 * the operator pastes whatever their account/model shows.
 */

export const FAMILIES = Object.freeze(['5', '4.5', 'other']);

/** Which preset family a model id belongs to. */
export function presetFamilyFor(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return 'other';
  if (id.startsWith('nai-diffusion-5')) return '5';
  if (id.startsWith('nai-diffusion-4-5')) return '4.5';
  if (id.startsWith('nai-diffusion-4')) return '4.5';
  return 'other';
}

/** An empty, schema-shaped preset bag. Never shares objects between families. */
export function emptyPresets() {
  return {
    '5': { applyDefaults: false, positive: '', negative: '' },
    '4.5': { applyDefaults: false, positive: '', negative: '' },
  };
}

export function normalizePresets(raw) {
  const base = emptyPresets();
  if (!raw || typeof raw !== 'object') return base;
  for (const family of ['5', '4.5']) {
    const entry = raw[family];
    if (entry && typeof entry === 'object') {
      base[family] = {
        applyDefaults: entry.applyDefaults === true,
        positive: typeof entry.positive === 'string' ? entry.positive : '',
        negative: typeof entry.negative === 'string' ? entry.negative : '',
      };
    }
  }
  return base;
}

/**
 * The prompt pair that will actually be sent for this model.
 *
 * `applyDefaults` (per family, stored with the preset) decides whether the
 * family preset is joined onto the request. Order is deterministic:
 *   positive: [preset.positive, request prompt]
 *   negative: [preset.negative, config negativePrompt, request negative]
 * Empty parts are skipped, so "clear everything" is a supported state.
 */
export function resolvePreset({ model = '', presets = null, negativePrompt = '', request = {} } = {}) {
  const family = presetFamilyFor(model);
  const bag = normalizePresets(presets);
  const entry = bag[family] ?? { applyDefaults: false, positive: '', negative: '' };
  const parts = value => String(value ?? '').trim();
  const positive = [entry.applyDefaults ? parts(entry.positive) : '', parts(request.prompt)]
    .filter(Boolean)
    .join(', ');
  const negative = [entry.applyDefaults ? parts(entry.negative) : '', parts(negativePrompt), parts(request.negative)]
    .filter(Boolean)
    .join(', ');
  return {
    family,
    applyDefaults: entry.applyDefaults,
    // `entry.*` is what the operator stored for THIS family only.
    stored: { positive: parts(entry.positive), negative: parts(entry.negative) },
    positive,
    negative,
    warnings: family === 'other'
      ? ['当前模型不属于 V5 / 4.5 家族，不会套用任何家族预设（避免串用）']
      : [],
  };
}
