/**
 * The 「工具 → 媒体能力」 page, as data.
 *
 * This module deliberately contains **no UI framework code**: the companion
 * space renders it (its own client owns the DOM), and the plugin stays testable
 * offline. What it produces is a render-ready descriptor:
 *   - sections → providers → fields, each with `path` / `pathParts`, label,
 *     input type, **current value**, whether it is writable, and a hint;
 *   - secrets are rendered as `{configured, mask}` objects — never plaintext;
 *   - the six state words, the API endpoints, and per-provider `canTest` /
 *     `canEnable` so the client never has to guess (Index-TTS is untestable and
 *     unenumerable by construction).
 *
 * Field visibility follows the plan: the summary shows provider state and the
 * default backend; provider-specific options are grouped under that provider.
 */

const FIELD_TYPES = {
  baseUrl: 'url',
  apiKey: 'secret',
  model: 'text',
  timeoutMs: 'number',
  instruction: 'textarea',
  negativePrompt: 'textarea',
  artistString: 'textarea',
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
  seedNumber: 'number',
  referenceId: 'text',
  qualityToggle: 'boolean',
  sm: 'boolean',
  smDyn: 'boolean',
};

const SECRET_FIELDS = new Set(['apiKey']);

/** 下拉项的显示名。没列到的值直接用原值当显示名（不猜语义）。 */
const OPTION_LABELS = {
  transport: { official: 'official（官方直连）', 'openai-relay': 'openai-relay（中转站）' },
  quality: { auto: 'auto（由服务端决定）', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  outputFormat: { png: 'png', jpeg: 'jpeg', webp: 'webp' },
  background: { auto: 'auto', opaque: 'opaque', transparent: 'transparent' },
  mediaType: { wav: 'wav（推荐）', ogg: 'ogg', aac: 'aac' },
  format: { wav: 'wav（推荐）', pcm: 'pcm（无采样率信息，会被拒）', mp3: 'mp3', opus: 'opus' },
  latency: { normal: 'normal', balanced: 'balanced（更低延迟）' },
  promptLang: { auto: 'auto', zh: 'zh（中文）', en: 'en（英文）', ja: 'ja（日文）', ko: 'ko（韩语）', yue: 'yue（粤语）' },
  textLang: { auto: 'auto', zh: 'zh（中文）', en: 'en（英文）', ja: 'ja（日文）', ko: 'ko（韩语）', yue: 'yue（粤语）' },
};

const optionList = (name, values) => values.map(value => ({ value, label: OPTION_LABELS[name]?.[value] ?? value }));

function readPath(config, parts) {
  let current = config;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function field(pathParts, label, config, { type = 'text', writable = true, hint = '', options = null } = {}) {
  const raw = readPath(config, pathParts);
  const name = pathParts[pathParts.length - 1];
  const value = SECRET_FIELDS.has(name)
    // 密钥只给"是否已配置 + 掩码"；明文永远不出现在这里。
    ? (raw && typeof raw === 'object' ? raw : { configured: Boolean(String(raw ?? '').trim()), mask: '', source: 'config' })
    : (raw ?? null);
  // 选择框必须有 options，否则客户端只能退化成文本框——这里直接降级，保证不发"没选项的 select"。
  const base = { path: pathParts.join('.'), pathParts: [...pathParts], label, writable };
  if (type === 'select' && !(options && options.length)) return { ...base, type: 'text', value, ...(hint ? { hint } : {}) };
  return { ...base, type, value, ...(options && options.length ? { options } : {}), ...(hint ? { hint } : {}) };
}

function providerSection({ kind, record, state, config }) {
  const configKey = record.id;
  const baseParts = kind === 'image' ? ['image', configKey] : ['tts', 'providers', configKey];
  const fields = [];
  const used = new Set();
  const push = name => {
    if (used.has(name)) return;
    used.add(name);
    const label = record.fieldLabels?.[name] ?? name;
    const type = FIELD_TYPES[name] ?? 'text';
    const hint = name === 'apiKey' ? '只写：保存后只显示"已配置"；留空 = 保留原值；清除需显式动作' : '';
    const options = record.fieldOptions?.[name] ? optionList(name, record.fieldOptions[name]) : null;
    fields.push(field([...baseParts, name], label, config, { type, hint, options }));
  };
  for (const name of record.requiredFields ?? []) push(name);
  for (const name of Object.keys(record.fieldLabels ?? {})) push(name);
  // 生图没有"每 provider 开关"：启停由 `image.enabled` + `image.provider` 决定，
  // 所以这里不发 `enabled` 字段（发了也没有可写的目标键）。
  // TTS 的每个后端确实有独立开关 `tts.providers.<id>.enabled`，保留。
  if (kind === 'tts') fields.unshift(field([...baseParts, 'enabled'], `${record.label}：启用`, config, { type: 'boolean' }));

  return {
    id: record.id,
    label: record.label,
    status: record.status,
    state: state?.state ?? 'unconfigured',
    stateNote: state?.note ?? state?.reason ?? record.reason ?? '',
    stateDetail: state?.detail ?? null,
    missing: state?.missing ?? [],
    // 未接入的 provider 不允许被测试或被启用——客户端不必自己判断。
    canTest: record.status === 'connected',
    canEnable: record.status === 'connected',
    evidence: record.evidence,
    endpoint: record.endpoint,
    auth: record.auth,
    responseFormat: record.responseFormat,
    voiceListing: record.voiceListing,
    rateLimit: record.rateLimit,
    license: record.license,
    version: record.version,
    key: state?.key ?? null,
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
    // 六种状态词：UI 必须照抄，不得自造（也不得把"已保存"写成"连接成功"）。
    states: [
      { id: 'disabled', label: '功能关闭' },
      { id: 'unconfigured', label: '未配置' },
      { id: 'not-connected', label: '尚未接入' },
      { id: 'saved-untested', label: '已保存、未测试' },
      { id: 'test-ok', label: '测试通过' },
      { id: 'test-failed', label: '测试失败' },
    ],
    // 客户端只认这些端点，不自己拼路径。
    api: {
      status: 'GET /api/companion-media/status',
      config: 'GET /api/companion-media/config',
      save: 'POST /api/companion-media/config',
      test: 'POST /api/companion-media/test',
      preview: 'GET /api/companion-media/preview',
      jobs: 'GET /api/companion-media/jobs',
      generate: 'POST /api/companion-media/image',
      speech: 'POST /api/companion-media/speech',
    },
    // 页面可以照这个顺序渲染开关与默认后端。
    sections: [
      {
        id: 'vision',
        title: '识图',
        status: states.vision?.status ?? 'reserved-disabled',
        state: 'disabled',
        locked: true,
        note: '预留，当前关闭。开关不可操作，也没有任何工具或接口能发起识图调用。',
        toggle: { path: 'vision.enabled', pathParts: ['vision', 'enabled'], label: '启用识图', disabled: true, value: false, why: '本期只保留合同' },
        fields: [
          field(['vision', 'baseUrl'], 'Base URL', config, { type: 'url' }),
          field(['vision', 'apiKey'], 'API Key', config, { type: 'secret', hint: '只写：保存后只显示"已配置"' }),
          field(['vision', 'model'], '模型', config),
          field(['vision', 'timeoutMs'], '超时（毫秒）', config, { type: 'number' }),
        ],
      },
      {
        id: 'image',
        title: '生图',
        status: states.image?.enabled ? 'on' : 'off',
        note: '计费能力：默认关闭；失败不会自动重试，重试必须由人显式发起。',
        toggle: { path: 'image.enabled', pathParts: ['image', 'enabled'], label: '启用生图', value: config.image?.enabled === true },
        selector: {
          path: 'image.provider',
          pathParts: ['image', 'provider'],
          label: '协议',
          value: config.image?.provider ?? 'none',
          options: [{ value: 'none', label: '未选择' }, ...(catalog.image ?? []).map(item => ({ value: item.id, label: item.label }))],
        },
        providers: (catalog.image ?? []).map(record => providerSection({ kind: 'image', record, state: imageStates[record.id], config })),
        preview: {
          endpoint: 'GET /api/companion-media/preview',
          label: '自动分辨率预览',
          note: '按画幅与目标像素计算并取整到 64 的倍数；超出声明范围会明确报错，不静默改值。',
          // 同一输入必须给同一结果；这里给出与 adapter 相同的计算参数。
          values: {
            mode: 'auto',
            aspect: 'portrait',
            targetPixels: 1_011_712,
            model: config.image?.nai?.model ?? 'nai-diffusion-4-5-full',
          },
        },
        presets: {
          path: 'image.nai.presets',
          pathParts: ['image', 'nai', 'presets'],
          note: 'V5 与 4.5 的预设分开存储；切换模型不会把一族的预设套到另一族。applyDefaults=false 表示暂时不用预设。',
          families: [
            { family: '5', label: 'V5', field: field(['image', 'nai', 'presets', '5', 'positive'], 'V5 正向预设', config, { type: 'textarea' }) },
            { family: '4.5', label: '4.5', field: field(['image', 'nai', 'presets', '4.5', 'positive'], '4.5 正向预设', config, { type: 'textarea' }) },
          ],
          artistString: field(['image', 'nai', 'artistString'], '画师串', config, { type: 'textarea', hint: '写进正向提示词最前面；与预设独立保存' }),
        },
      },
      {
        id: 'tts',
        title: '语音合成',
        status: states.tts?.enabled ? 'on' : 'off',
        note: '只产出音频文件，不发送消息；可能计费的后端（Fish Audio / Drama3）同样默认关闭。',
        toggle: { path: 'tts.enabled', pathParts: ['tts', 'enabled'], label: '启用语音合成', value: config.tts?.enabled === true },
        selector: {
          path: 'tts.provider',
          pathParts: ['tts', 'provider'],
          label: '默认后端',
          value: config.tts?.provider ?? 'none',
          options: [{ value: 'none', label: '未选择' }, ...(catalog.tts ?? []).map(item => ({ value: item.id, label: item.label }))],
        },
        providers: (catalog.tts ?? []).map(record => providerSection({ kind: 'tts', record, state: ttsStates[record.id], config })),
      },
    ],
    meta: {
      configFile: status?.configFile ?? null,
      paths: status?.paths ?? null,
      persona: status?.persona ?? null,
      // 管理 API 的注册状态：Studio 据此区分「模块未启用（无此模块）」与
      // 「模块已启用但管理 API 没起来（connection 未就绪 / 注册失败）」。
      http: status?.http ?? null,
      // 页面加载不得触发任何 /test：这里显式说明测试是按钮动作。
      testPolicy: 'explicit-only',
    },
  };
}

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function renderValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.configured === true) return `已配置${value.mask ? `（${value.mask}）` : ''}`;
    if ('configured' in value) return '未配置';
    if ('clear' in value) return '';
    return '';
  }
  return String(value);
}

/**
 * Plain-HTML rendering of the descriptor.
 *
 * Used for docs previews and for the test that asserts no credential reaches the
 * page. It is NOT the production page (the companion space draws that); it is the
 * same data, rendered honestly.
 */
export function renderPagePreview(descriptor) {
  const sectionHtml = descriptor.sections.map(section => {
    const providerHtml = (section.providers ?? []).map(provider => `
      <details class="provider" data-id="${escapeHtml(provider.id)}" data-state="${escapeHtml(provider.state)}" data-can-test="${provider.canTest}">
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
        <table>${provider.fields.map(item => `<tr><th>${escapeHtml(item.label)}</th><td>${escapeHtml(item.path)}</td><td>${escapeHtml(renderValue(item.value))}</td></tr>`).join('')}</table>
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
