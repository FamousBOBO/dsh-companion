/**
 * The 「工具 → 媒体能力」 page, as data.
 *
 * This module deliberately contains **no UI framework code**: the companion
 * space renders it (its own client owns the DOM), and the plugin stays testable
 * offline. What it produces is:
 *   - a descriptor: sections → fields, each with the config path, the label, the
 *     current state and whether the field is writable;
 *   - a plain-HTML preview used by the docs and by tests that assert a secret
 *     never appears on the page.
 *
 * Field visibility follows the plan: the summary shows provider state and the
 * default backend; provider-specific options appear only when that provider is
 * selected ("展开具体 adapter 才显示其选项").
 */

const FIELD_TYPES = {
  baseUrl: 'url',
  apiKey: 'secret',
  model: 'text',
  timeoutMs: 'number',
  instruction: 'textarea',
  negativePrompt: 'textarea',
  positive: 'textarea',
  negative: 'textarea',
  refAudioPath: 'text',
  refText: 'text',
  promptText: 'text',
  promptLang: 'select',
  textLang: 'select',
  mediaType: 'select',
  format: 'select',
  latency: 'select',
  sampler: 'select',
  noiseSchedule: 'select',
  transport: 'select',
  outputFormat: 'select',
  quality: 'select',
  background: 'select',
  size: 'text',
  width: 'number',
  height: 'number',
  steps: 'number',
  scale: 'number',
  seed: 'number',
  ucPreset: 'number',
  cfgScale: 'number',
  temperature: 'number',
  topP: 'number',
  topK: 'number',
  speedFactor: 'number',
  referenceId: 'text',
  qualityToggle: 'boolean',
  sm: 'boolean',
  smDyn: 'boolean',
};

function field(path, label, { type = 'text', value = null, writable = true, hint = '' } = {}) {
  return { path, label, type, value, writable, hint };
}

function providerSection({ kind, record, state }) {
  const prefix = kind === 'image' ? 'image' : 'tts.providers';
  const fields = [];
  for (const name of record.requiredFields ?? []) {
    fields.push(field(`${prefix === 'image' ? `image.${record.id}` : `${prefix}.${record.id}`}.${name}`,
      record.fieldLabels?.[name] ?? name,
      { type: FIELD_TYPES[name] ?? 'text', hint: name === 'apiKey' ? '保存后只显示掩码；留空表示不修改已保存的密钥' : '' }));
  }
  for (const [name, label] of Object.entries(record.fieldLabels ?? {})) {
    if ((record.requiredFields ?? []).includes(name)) continue;
    fields.push(field(`${prefix === 'image' ? `image.${record.id}` : `${prefix}.${record.id}`}.${name}`,
      label, { type: FIELD_TYPES[name] ?? 'text', writable: true }));
  }
  return {
    id: record.id,
    label: record.label,
    status: record.status,
    state: state?.state ?? 'unconfigured',
    stateNote: state?.note ?? state?.reason ?? record.reason ?? '',
    evidence: record.evidence,
    endpoint: record.endpoint,
    auth: record.auth,
    responseFormat: record.responseFormat,
    voiceListing: record.voiceListing,
    rateLimit: record.rateLimit,
    license: record.license,
    version: record.version,
    fields,
  };
}

/** Build the descriptor from a `service.status()` payload. */
export function mediaPageDescriptor(status) {
  const states = status?.states ?? {};
  const catalog = status?.catalog ?? { image: [], tts: [] };
  const config = status?.config ?? {};
  const imageStates = Object.fromEntries((states.image?.providers ?? []).map(item => [item.id, item]));
  const ttsStates = Object.fromEntries((states.tts?.providers ?? []).map(item => [item.id, item]));

  return {
    id: 'companion-media',
    title: '媒体能力',
    group: '工具',
    subtitle: '生图与语音合成；识图只保留合同',
    order: 40,
    // Every state we can show, with the exact wording the UI must use.
    states: [
      { id: 'disabled', label: '功能关闭' },
      { id: 'unconfigured', label: '未配置' },
      { id: 'not-connected', label: '尚未接入' },
      { id: 'saved-untested', label: '已保存、未测试' },
      { id: 'test-ok', label: '测试通过' },
      { id: 'test-failed', label: '测试失败' },
    ],
    sections: [
      {
        id: 'vision',
        title: '识图',
        status: states.vision?.status ?? 'reserved-disabled',
        state: 'disabled',
        locked: true,
        note: '预留，当前关闭。开关不可操作，也没有任何工具或接口能发起识图调用。',
        fields: [
          field('vision.baseUrl', 'Base URL', { type: 'url' }),
          field('vision.apiKey', 'API Key', { type: 'secret', hint: '只保存，不返回明文' }),
          field('vision.model', '模型'),
          field('vision.timeoutMs', '超时（毫秒）', { type: 'number' }),
        ],
        toggle: { path: 'vision.enabled', label: '启用识图', disabled: true, value: false, why: '本期只保留合同' },
      },
      {
        id: 'image',
        title: '生图',
        status: states.image?.enabled ? 'on' : 'off',
        note: '计费能力：默认关闭；失败不会自动重试，重试必须由人显式发起。',
        toggle: { path: 'image.enabled', label: '启用生图', value: config.image?.enabled === true },
        selector: {
          path: 'image.provider',
          label: '协议',
          value: config.image?.provider ?? 'none',
          options: [{ value: 'none', label: '未选择' }, ...(catalog.image ?? []).map(item => ({ value: item.id, label: item.label }))],
        },
        providers: (catalog.image ?? []).map(record => providerSection({ kind: 'image', record, state: imageStates[record.id] })),
        preview: {
          path: 'image.nai',
          label: '自动分辨率预览',
          note: '按画幅与目标像素计算并取整到 64 的倍数；超出声明范围会明确报错，不静默改值。',
        },
        presets: {
          path: 'image.nai.presets',
          note: 'V5 与 4.5 的预设分开存储；切换模型不会把一族的预设套到另一族。',
        },
      },
      {
        id: 'tts',
        title: '语音合成',
        status: states.tts?.enabled ? 'on' : 'off',
        note: '只产出音频文件，不发送消息；可能计费的后端（Fish Audio / Drama3）同样默认关闭。',
        toggle: { path: 'tts.enabled', label: '启用语音合成', value: config.tts?.enabled === true },
        selector: {
          path: 'tts.provider',
          label: '默认后端',
          value: config.tts?.provider ?? 'none',
          options: [{ value: 'none', label: '未选择' }, ...(catalog.tts ?? []).map(item => ({ value: item.id, label: item.label }))],
        },
        providers: (catalog.tts ?? []).map(record => providerSection({ kind: 'tts', record, state: ttsStates[record.id] })),
      },
    ],
  };
}

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Plain-HTML rendering of the descriptor.
 *
 * Used for docs screenshots and for the test that asserts no credential reaches
 * the page. It is NOT the production page (the companion space draws that); it is
 * the same data, rendered honestly.
 */
export function renderPagePreview(descriptor) {
  const sectionHtml = descriptor.sections.map(section => {
    const providerHtml = (section.providers ?? []).map(provider => `
      <details class="provider" data-id="${escapeHtml(provider.id)}" data-state="${escapeHtml(provider.state)}">
        <summary>${escapeHtml(provider.label)} — <span class="state">${escapeHtml(stateLabel(descriptor, provider.state))}</span></summary>
        <dl>
          <dt>协议</dt><dd>${escapeHtml(provider.endpoint)}</dd>
          <dt>鉴权</dt><dd>${escapeHtml(provider.auth)}</dd>
          <dt>返回</dt><dd>${escapeHtml(provider.responseFormat)}</dd>
          <dt>音色查询</dt><dd>${escapeHtml(provider.voiceListing)}</dd>
          <dt>限流</dt><dd>${escapeHtml(provider.rateLimit)}</dd>
          <dt>许可</dt><dd>${escapeHtml(provider.license)}</dd>
          <dt>证据等级</dt><dd>${escapeHtml(provider.evidence?.level)}</dd>
        </dl>
        <table>${provider.fields.map(item => `<tr><th>${escapeHtml(item.label)}</th><td>${escapeHtml(item.path)}</td></tr>`).join('')}</table>
      </details>`).join('');
    return `
      <section id="${escapeHtml(section.id)}">
        <h2>${escapeHtml(section.title)} <small>${escapeHtml(section.status)}</small></h2>
        <p>${escapeHtml(section.note)}</p>
        ${providerHtml}
      </section>`;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>媒体能力</title></head>
<body><h1>${escapeHtml(descriptor.title)}</h1><p>${escapeHtml(descriptor.subtitle)}</p>${sectionHtml}</body></html>`;
}

function stateLabel(descriptor, id) {
  return descriptor.states.find(item => item.id === id)?.label ?? id;
}
