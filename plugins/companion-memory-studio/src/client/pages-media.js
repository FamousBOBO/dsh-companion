// 连接与工具 → 工具 → 媒体能力：**真实可编辑**的设置页。
//
// 单一权威：页面只按 `companion-media` 给的 descriptor 渲染（字段、label、类型、
// 当前值、状态文案、端点、canTest/canEnable 全部来自它），保存只走
// `POST /api/companion-media/config`。Studio 不写媒体 JSON，也不复制第二份服务商
// 逻辑（不硬编码 provider id、端点路径、必填项或校验规则）。
//
// 三条硬规则（都在代码里落实，不是文档承诺）：
//   1. 密钥只写：`type:'secret'` 的值恒为 `{configured, mask}`；输入框恒空；
//      留空保存 = 保留原密钥；清除是一次显式动作，且**先关能力再清密钥**（同一个
//      patch 里一起发，避免撞后端 400）。
//   2. 测试/预览只由按钮触发：加载页面只读 page 与 config；绝不自动调用 /test、
//      /preview、/image、/speech（descriptor 的 meta.testPolicy 是 explicit-only）。
//   3. 读不到就如实说：媒体模块没启用时给出可走通的启用路径，不假装页面坏了；
//      provider 侧失败（body.ok=false）绝不渲染成"测试通过"。
(function (P) {
  const { h, ui } = P;

  const MEDIA_BASE = 'api/companion-media/';

  // descriptor 声明的六种状态（未知值一律「未知」，不猜）。
  const STATE_LABELS = {
    disabled: '功能关闭',
    unconfigured: '未配置',
    'not-connected': '尚未接入',
    'saved-untested': '已保存、未测试',
    'test-ok': '测试通过',
    'test-failed': '测试失败',
  };
  const STATE_TONES = {
    disabled: 'idle',
    unconfigured: 'warn',
    'not-connected': 'neutral',
    'saved-untested': 'idle',
    'test-ok': 'ok',
    'test-failed': 'danger',
  };

  // 只用于识别"这个字段是密钥 + 不要泄漏进 DOM"；字段类型仍以 descriptor 为准。
  const SECRET_FIELD_NAMES = ['apiKey', 'accessToken', 'token'];
  const PRESET_LABELS = { applyDefaults: '启用这一族预设', positive: '正向提示词', negative: '反向提示词' };

  const ENABLE_SNIPPET = [
    '{',
    '  "modules": {',
    '    "media": true',
    '  }',
    '}',
  ].join('\n');

  P.css(`
    .cpxp-media-sec { border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.18)); border-radius:10px; padding:var(--cpx-s3,12px); margin:0 0 var(--cpx-s4,16px); }
    .cpxp-media-sec-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--cpx-s3,12px); flex-wrap:wrap; }
    .cpxp-media-sec-title { margin:0; font-size:var(--cpx-fs-body,14px); font-weight:600; }
    .cpxp-media-note { margin:4px 0 0; font-size:var(--cpx-fs-small,12px); line-height:1.7; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; max-width:78ch; }
    .cpxp-media-note-inline { margin:0 0 var(--cpx-s3,12px); font-size:var(--cpx-fs-small,12px); color:var(--dsw-alias-label-secondary); }
    .cpxp-media-card { border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.18)); border-radius:10px; padding:var(--cpx-s3,12px); background:var(--dsw-alias-bg-elevated,transparent); }
    .cpxp-media-card + .cpxp-media-card { margin-top:var(--cpx-s3,12px); }
    .cpxp-media-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
    .cpxp-media-card-title { margin:0; font-size:var(--cpx-fs-body,14px); font-weight:600; }
    .cpxp-media-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:var(--cpx-s3,12px); margin-top:var(--cpx-s3,12px); }
    .cpxp-media-field-wide { grid-column:1 / -1; }
    .cpxp-media-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:var(--cpx-s3,12px); }
    .cpxp-media-secret { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .cpxp-media-error { margin:4px 0 0; font-size:var(--cpx-fs-small,12px); color:var(--dsw-alias-label-danger,#c0392b); overflow-wrap:anywhere; }
    .cpxp-media-presets { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:var(--cpx-s3,12px); }
    .cpxp-media-badge-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  `);

  // -------------------------------------------------------------------------
  // 纯函数：视图模型与请求体构造（单测只测这些，不靠"字符串包含"）
  // -------------------------------------------------------------------------

  function configAt(config, dotted) {
    if (!config) return undefined;
    return configAtParts(config, Array.isArray(dotted) ? dotted : String(dotted || '').split('.'));
  }

  function configAtParts(config, parts) {
    let node = config;
    for (const key of parts || []) {
      if (node === null || node === undefined) return undefined;
      node = node[key];
    }
    return node;
  }

  /** 用 pathParts 写入：NAI 预设族叫 `4.5`，按点号切分会把路径拆坏。 */
  function setParts(target, parts, value) {
    let node = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!node[key] || typeof node[key] !== 'object') node[key] = {};
      node = node[key];
    }
    node[parts[parts.length - 1]] = value;
    return target;
  }

  function partsOf(path, pathParts) {
    if (Array.isArray(pathParts) && pathParts.length) return pathParts.slice();
    return String(path || '').split('.');
  }

  function secretInfo(value) {
    if (value && typeof value === 'object') {
      return { configured: value.configured === true, mask: String(value.mask || ''), source: value.source || '' };
    }
    return { configured: String(value || '').trim() !== '', mask: '', source: '' };
  }

  function stateLabel(states, id) {
    const found = (states || []).find(item => item && item.id === id);
    if (found && found.label) return String(found.label);
    return STATE_LABELS[id] || '未知';
  }

  function stateTone(id) {
    return STATE_TONES[id] || 'neutral';
  }

  /** `'GET /api/companion-media/config'` → `'api/companion-media/config'`（端点以 descriptor 为准）。 */
  function apiPath(spec, fallback) {
    const text = String(spec || '');
    const match = text.match(/\s(\S+)$/);
    if (match && match[1].startsWith('/')) return match[1].replace(/^\//, '');
    return `${MEDIA_BASE}${fallback || ''}`;
  }

  function lastSegment(dotted) {
    return String(dotted || '').split('.').pop();
  }

  function parentPath(dotted) {
    const parts = String(dotted || '').split('.');
    parts.pop();
    return parts.join('.');
  }

  function fieldView(field, config, { locked = false } = {}) {
    const secret = field.type === 'secret' || SECRET_FIELD_NAMES.includes(lastSegment(field.path));
    // descriptor 现在带 value（密钥只给 {configured, mask}）；没有时回落到同一份 config。
    const fromDescriptor = field.value !== undefined && field.value !== null;
    const current = fromDescriptor ? field.value : configAt(config, field.path);
    const info = secret ? secretInfo(current) : null;
    const plain = current === undefined || current === null || typeof current === 'object';
    return {
      path: field.path,
      pathParts: Array.isArray(field.pathParts) ? field.pathParts.slice() : String(field.path || '').split('.'),
      label: field.label || lastSegment(field.path),
      type: field.type || 'text',
      hint: field.hint || '',
      locked: locked || field.writable === false,
      secret,
      configured: info ? info.configured : false,
      mask: info ? info.mask : '',
      // 视图里永不携带明文：secret 的值恒为 ''，靠 configured 表达"已配置"。
      value: secret || plain ? '' : current,
      original: secret || plain ? '' : current,
      options: Array.isArray(field.options) ? field.options.map(item => ({ value: String(item.value), label: String(item.label) })) : null,
    };
  }

  function providerView(provider, config, { locked = false, kind = 'image' } = {}) {
    const notConnected = provider.status === 'not-connected' || provider.state === 'not-connected';
    const rawFields = provider.fields || [];
    // 生图的"启用"是 section 的开关 + 协议选择，不存在 `image.<provider>.enabled` 这个键：
    // 渲染一个会写坏配置的开关比不渲染更糟，所以生图 provider 不显示 enabled 字段。
    const usable = kind === 'image' ? rawFields.filter(item => lastSegment(item.path) !== 'enabled') : rawFields;
    // 密钥可能来自环境变量：改页面不会生效，必须禁用输入并说明来源。
    const keyInfo = provider.key && typeof provider.key === 'object' ? provider.key : null;
    const keyFromEnv = Boolean(keyInfo && keyInfo.source === 'env');
    const fields = usable.map((item) => {
      const view = fieldView(item, config, { locked: locked || notConnected });
      if (view.secret && keyFromEnv) {
        return { ...view, locked: true, fromEnv: true, envVar: keyInfo.envVar || '', configured: keyInfo.configured === true };
      }
      return view;
    });
    // provider 的配置前缀：由 descriptor 的 pathParts 推出来，不写死 id。
    const firstParts = usable[0] && Array.isArray(usable[0].pathParts) ? usable[0].pathParts : null;
    const prefix = firstParts && firstParts.length > 1
      ? firstParts.slice(0, -1).join('.')
      : (kind === 'tts' ? `tts.providers.${provider.id}` : `image.${provider.id}`);
    const enableField = fields.find(field => lastSegment(field.path) === 'enabled') || null;
    const syntheticEnablePath = enableField || kind === 'image' ? null : `${prefix}.enabled`;
    return {
      id: provider.id,
      kind,
      label: provider.label || provider.id,
      prefix,
      status: provider.status || '',
      state: provider.state || 'unconfigured',
      stateNote: provider.stateNote || provider.stateDetail || provider.reason || '',
      notConnected,
      keyInfo,
      keyFromEnv,
      // descriptor 明确给了"能不能测/能不能启用"，页面不再自己猜（也不硬编码 id）。
      canTest: provider.canTest !== undefined ? provider.canTest === true : !notConnected,
      canEnable: provider.canEnable !== undefined ? provider.canEnable === true : !notConnected,
      enableField,
      enablePath: enableField ? enableField.path : syntheticEnablePath,
      // 清密钥前必须先关能力：tts 关 provider 自己的开关，生图关 section 的「启用生图」。
      disablePath: (enableField ? enableField.path : syntheticEnablePath) || (kind === 'image' ? 'image.enabled' : null),
      enabled: enableField ? enableField.original === true
        : (syntheticEnablePath ? configAt(config, syntheticEnablePath) === true : configAt(config, 'image.enabled') === true && configAt(config, 'image.provider') === provider.id),
      missing: Array.isArray(provider.missing) ? provider.missing : [],
      evidence: provider.evidence || null,
      endpoint: provider.endpoint || '',
      auth: provider.auth || '',
      responseFormat: provider.responseFormat || '',
      voiceListing: provider.voiceListing || '',
      rateLimit: provider.rateLimit || '',
      license: provider.license || '',
      version: provider.version || '',
      fields,
    };
  }

  function presetView(section, config) {
    const spec = section && section.presets;
    if (!spec) return null;
    // 新形状：descriptor 直接给两族字段 + 独立的画师串字段；渲染以它为准。
    if (Array.isArray(spec.families) && spec.families.length) {
      const families = spec.families.filter(family => family && family.field).map(family => ({
        family: String(family.family ?? ''),
        label: family.label || String(family.family ?? '预设'),
        path: family.field.path,
        fields: [fieldView(family.field, config)],
      }));
      return {
        path: spec.path || '',
        note: spec.note || '',
        families,
        artist: spec.artistString ? fieldView(spec.artistString, config) : null,
      };
    }
    // 旧形状兜底：按配置里的真实结构逐族展开（不把"预设"写死成两份代码）。
    const bag = configAt(config, spec.path);
    if (!bag || typeof bag !== 'object') return null;
    const families = Object.keys(bag).map((family) => {
      const entry = bag[family];
      if (!entry || typeof entry !== 'object') return null;
      const fields = Object.keys(entry).map((key) => {
        const value = entry[key];
        return {
          path: `${spec.path}.${family}.${key}`,
          pathParts: [...spec.path.split('.'), family, key],
          key,
          label: PRESET_LABELS[key] || key,
          type: typeof value === 'boolean' ? 'boolean' : (key === 'positive' || key === 'negative' ? 'textarea' : 'text'),
          hint: '',
          locked: false,
          secret: false,
          configured: false,
          mask: '',
          options: null,
          value: typeof value === 'boolean' ? value : String(value ?? ''),
          original: typeof value === 'boolean' ? value : String(value ?? ''),
        };
      });
      return {
        family,
        label: family === '5' ? 'V5 预设' : family === '4.5' ? '4.5 预设' : `${family} 预设`,
        path: `${spec.path}.${family}`,
        fields,
      };
    }).filter(Boolean);
    return { path: spec.path, note: spec.note || '', families, artist: null };
  }

  function sectionView(section, config) {
    const locked = section.locked === true;
    const toggle = section.toggle ? {
      path: section.toggle.path,
      label: section.toggle.label || section.toggle.path,
      value: configAt(config, section.toggle.path) === true,
      original: configAt(config, section.toggle.path) === true,
      disabled: locked || section.toggle.disabled === true,
      why: section.toggle.why || '',
    } : null;
    const selector = section.selector ? {
      path: section.selector.path,
      label: section.selector.label || section.selector.path,
      value: String(configAt(config, section.selector.path) ?? 'none'),
      original: String(configAt(config, section.selector.path) ?? 'none'),
      options: (section.selector.options || []).map(item => ({ value: String(item.value), label: String(item.label) })),
      disabled: locked,
    } : null;
    const kind = section.id === 'tts' ? 'tts' : 'image';
    return {
      id: section.id,
      title: section.title || section.id,
      status: section.status || '',
      note: section.note || '',
      locked,
      toggle,
      selector,
      providers: (section.providers || []).map(provider => providerView(provider, config, { locked, kind })),
      presets: section.id === 'image' ? presetView(section, config) : null,
      preview: section.preview || null,
      fields: (section.fields || []).map(field => fieldView(field, config, { locked })),
    };
  }

  function buildView(descriptor, config) {
    return {
      id: descriptor.id || 'companion-media',
      title: descriptor.title || '媒体能力',
      subtitle: descriptor.subtitle || '',
      states: descriptor.states || [],
      api: descriptor.api || {},
      meta: descriptor.meta || {},
      sections: (descriptor.sections || []).map(section => sectionView(section, config)),
    };
  }

  /** path -> {type, secret, locked, original, parts}；保存与字段合并都只看这张表。 */
  function fieldIndex(view) {
    const index = Object.create(null);
    const add = (entry) => {
      if (!entry || !entry.path) return;
      index[entry.path] = {
        type: entry.type || (typeof entry.original === 'boolean' ? 'boolean' : 'text'),
        secret: entry.secret === true,
        locked: entry.locked === true || entry.disabled === true,
        original: entry.original,
        parts: partsOf(entry.path, entry.pathParts),
      };
    };
    (view.sections || []).forEach((section) => {
      add(section.toggle);
      if (section.selector) {
        index[section.selector.path] = {
          type: 'select',
          secret: false,
          locked: section.selector.disabled === true,
          original: section.selector.original,
          parts: partsOf(section.selector.path, section.selector.pathParts),
        };
      }
      (section.fields || []).forEach(add);
      (section.providers || []).forEach((provider) => {
        (provider.fields || []).forEach(add);
        if (provider.enablePath && !provider.enableField) {
          index[provider.enablePath] = {
            type: 'boolean',
            secret: false,
            locked: provider.canEnable !== true,
            original: provider.enabled === true,
            parts: partsOf(provider.enablePath),
          };
        }
      });
      const presets = section.presets;
      (presets ? presets.families : []).forEach(family => family.fields.forEach(add));
      if (presets && presets.artist) add(presets.artist);
    });
    return index;
  }

  /** 表单初值：密钥恒为空（只写），其余取当前配置。 */
  function draftFrom(view) {
    const draft = {};
    const index = fieldIndex(view);
    Object.keys(index).forEach((path) => {
      if (index[path].secret || index[path].locked) return;
      draft[path] = typeof index[path].original === 'boolean' ? index[path].original : String(index[path].original ?? '');
    });
    return draft;
  }

  function coerce(type, value) {
    if (type === 'boolean') return value === true || value === 'true';
    if (type === 'number') {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    return value;
  }

  /** 值相等判定：数字/字符串/布尔混用时不产生"假改动"（例如 '1' 与 1）。 */
  function sameValue(next, original) {
    const asBool = (value) => value === true || value === 'true';
    if (typeof next === 'boolean' || typeof original === 'boolean') return asBool(next) === asBool(original);
    if (next === null || next === undefined) return original === null || original === undefined || String(original) === '';
    if (original === null || original === undefined) return String(next) === '';
    return String(next) === String(original);
  }

  /**
   * `POST /config` 的 patch：只带真正改动的字段；密钥只在用户输入过时出现；
   * 清除走 `{clear:true}`。prefix 用于"只保存某个 provider / 某一块"。
   * 后端是稀疏深合并：没发的 provider 段原样保留，所以这里绝不能把整份配置塞回去。
   */
  function patchFrom(view, draft, secrets, clears, prefix, include) {
    const index = fieldIndex(view);
    const patch = {};
    const extra = Array.isArray(include) ? include : [];
    const within = path => !prefix || extra.includes(path) || String(path) === prefix || String(path).startsWith(`${prefix}.`);
    Object.keys(draft || {}).forEach((path) => {
      if (!within(path)) return;
      const meta = index[path];
      if (!meta || meta.locked || meta.secret) return;
      const next = coerce(meta.type, draft[path]);
      if (next === null) return; // 数字框留空：不发，交给用户补
      if (sameValue(next, meta.original)) return;
      setParts(patch, meta.parts, next);
    });
    Object.keys(secrets || {}).forEach((path) => {
      const text = String(secrets[path] ?? '').trim();
      if (!text || !within(path)) return;
      const meta = index[path];
      setParts(patch, partsOf(path, meta && meta.parts), text);
    });
    Object.keys(clears || {}).forEach((path) => {
      if (!clears[path] || !within(path)) return;
      const meta = index[path];
      setParts(patch, partsOf(path, meta && meta.parts), { clear: true });
    });
    return patch;
  }

  /** 400 响应里的 `errors[]` -> `{path: message}`；没有 path 的归到 `$`。 */
  function errorMap(errors) {
    const map = {};
    (Array.isArray(errors) ? errors : []).forEach((item) => {
      if (!item) return;
      const path = String(item.path || '$');
      if (!map[path]) map[path] = String(item.message || item.code || '校验没有通过');
    });
    return map;
  }

  function errorCount(patch) {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return 0;
      return Object.values(node).reduce((sum, value) => sum + (value && typeof value === 'object' ? walk(value) : 1), 0);
    };
    return walk(patch);
  }

  /** 媒体模块没启用/没接上：页面要能说清怎么启用。 */
  function isModuleDisabled(error) {
    if (!error) return false;
    const code = String(error.code || '');
    if (code === 'no-connection' || code === 'not-registered' || code === 'module-disabled') return true;
    // 路由没注册时宿主回 404；这种情况也要落到"模块没启用"的解释页。
    return Number(error.status) === 404;
  }

  /** 诊断区只展示这份：apiKey/token 一律替换成 {configured}，不落明文。 */
  function redactForDebug(value, depth = 0) {
    if (depth > 8) return '…';
    if (Array.isArray(value)) return value.map(item => redactForDebug(item, depth + 1));
    if (!value || typeof value !== 'object') {
      return typeof value === 'string' ? value.replace(/(sk|key|token)[-_A-Za-z0-9]{12,}/gi, '[redacted]') : value;
    }
    const out = {};
    Object.keys(value).forEach((key) => {
      if (SECRET_FIELD_NAMES.includes(key)) {
        out[key] = { configured: value[key] && typeof value[key] === 'object' ? value[key].configured === true : Boolean(value[key]) };
        return;
      }
      out[key] = redactForDebug(value[key], depth + 1);
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // 网络：媒体 API（`{ok, ...}` 平铺信封，端点取自 descriptor.api）
  // -------------------------------------------------------------------------

  function mediaUrl(path) {
    try {
      return new URL(path, document.baseURI).href;
    } catch {
      return `/${path}`;
    }
  }

  /** 永不抛：返回 { ok, status, payload }，调用方自己决定怎么说。 */
  function mediaFetch(path, method, body) {
    const hasBody = body !== undefined;
    return fetch(mediaUrl(path), {
      method: method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
    }).then(
      response => response.json().then(
        payload => ({ ok: Boolean(payload && payload.ok === true), status: response.status, payload: payload || null }),
        () => ({ ok: false, status: response.status, payload: null, badJson: true }),
      ),
      () => ({ ok: false, status: 0, payload: null, network: true }),
    );
  }

  function asApiError(result, fallback) {
    const error = (result && result.payload && result.payload.error) || {};
    return new P.ApiError(
      error.message || fallback || `媒体接口请求失败（HTTP ${result ? result.status : '?'}）。`,
      result ? result.status : 0,
      error.code || (result && result.badJson ? 'bad-response' : 'unknown'),
    );
  }

  /** 先读 page（端点也在它里面），再按 `api.config` 读配置。 */
  function loadMedia() {
    return mediaFetch(`${MEDIA_BASE}page`).then((page) => {
      if (!page.ok) throw asApiError(page, '读不到媒体能力的页面描述。');
      const api = (page.payload.page && page.payload.page.api) || {};
      return mediaFetch(apiPath(api.config, 'config')).then((config) => {
        if (!config.ok) throw asApiError(config, '读不到媒体配置。');
        return { page: page.payload, config: config.payload, api };
      });
    });
  }

  // -------------------------------------------------------------------------
  // 组件
  // -------------------------------------------------------------------------

  function SecretField({ entry, value, configured, mask, disabled, fromEnv, envVar, error, onChange }) {
    const status = fromEnv
      ? h(ui.StateLine, { state: 'idle', text: `来自环境变量${envVar ? `（${envVar}）` : ''}` })
      : h(ui.StateLine, { state: configured ? 'ok' : 'idle', text: configured ? (mask || '已配置') : '未配置' });
    const hint = fromEnv
      ? '这个 provider 的密钥来自环境变量：在这里改不会生效，请改环境变量本身'
      : (entry.hint || '只写：保存后只显示「已配置」；留空表示不修改');
    return h(ui.Field, { label: entry.label, hint, id: `media-${entry.path}` },
      h('div', { className: 'cpxp-media-secret' },
        h(ui.Input, {
          type: 'password',
          value: value || '',
          placeholder: fromEnv ? '由环境变量提供' : (configured ? '已配置（留空 = 不修改）' : '尚未配置'),
          disabled: Boolean(disabled || fromEnv),
          ariaLabel: entry.label,
          onChange: text => onChange(text),
        }),
        status),
      error ? h('p', { className: 'cpxp-media-error' }, error) : null);
  }

  function FieldControl({ entry, value, disabled, error, onChange }) {
    if (entry.type === 'boolean') {
      return h('div', null,
        h(ui.Toggle, { checked: value === true, disabled, label: entry.label, hint: entry.hint, onChange: next => onChange(next) }),
        error ? h('p', { className: 'cpxp-media-error' }, error) : null);
    }
    let control;
    if (entry.type === 'textarea') {
      control = h(ui.TextArea, { value: value ?? '', disabled, rows: 3, ariaLabel: entry.label, onChange: text => onChange(text) });
    } else if (entry.options && entry.options.length) {
      control = h(ui.Select, { value: value ?? '', disabled, ariaLabel: entry.label, options: entry.options, onChange: text => onChange(text) });
    } else {
      control = h(ui.Input, {
        type: entry.type === 'number' ? 'number' : 'text',
        value: value ?? '',
        disabled,
        ariaLabel: entry.label,
        onChange: text => onChange(text),
      });
    }
    return h(ui.Field, { label: entry.label, hint: entry.hint, id: `media-${entry.path}` },
      control,
      error ? h('p', { className: 'cpxp-media-error' }, error) : null);
  }

  function ProviderCard({ provider, selected, states, draft, secrets, clears, errors, testing, busy, onDraft, onSecret, onClear, onSave, onTest }) {
    const [open, setOpen] = P.useState(selected);
    // Follow protocol changes while retaining manual expand/collapse between selections.
    P.useEffect(() => setOpen(selected), [selected]);
    const status = testing[provider.id] || null;
    const dirty = provider.fields.some(field => (
      (field.secret ? Boolean(secrets[field.path]) : String(draft[field.path] ?? '') !== String(field.original ?? ''))
      || Boolean(clears[field.path])
    ));
    const badge = h('div', { className: 'cpxp-media-badge-row' },
      h(ui.Badge, { tone: stateTone(provider.state) }, stateLabel(states, provider.state)),
      provider.notConnected ? h(ui.Badge, { tone: 'neutral' }, '尚未接入') : null,
      provider.enabled === true ? h(ui.Badge, { tone: 'ok' }, '已启用') : null);
    const header = h('div', { className: 'cpxp-media-card-head' },
      h('div', null, h('h4', { className: 'cpxp-media-card-title' }, provider.label), badge),
      h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        onClick: () => setOpen(!open),
        title: open ? '收起这个 provider 的配置' : '展开这个 provider 的配置',
      }, open ? '收起' : '展开'));
    if (!open) {
      return h('div', { key: `provider-${provider.id}`, className: 'cpxp-media-card' },
        header,
        h('p', { className: 'cpxp-media-note' }, provider.stateNote || ''),
        status ? testResultLine(status) : null);
    }
    const fieldNodes = provider.fields.map((field) => {
      const error = errors[field.path];
      if (field.secret) {
        // 环境变量来的密钥：页面只能显示来源，不能改、也不能"清除"（会被覆盖回去）。
        const clearButton = field.configured && !field.locked && !field.fromEnv
          ? h('div', { className: 'cpxp-media-actions' },
            h(ui.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: Boolean(busy),
              onClick: () => onClear(field.path, provider),
              title: provider.enabled ? '清除前会先把「启用」关掉：后端不允许在启用态清空必填密钥' : '把已保存的密钥从配置里删掉（需要保存）',
            }, clears[field.path] ? '将清除（待保存）' : '清除已保存的密钥'),
            provider.enabled && clears[field.path]
              ? h('p', { className: 'cpxp-media-note' }, '第二步：保存时会把「启用」一起关掉，再把密钥清空（否则后端会拒绝）。')
              : null)
          : null;
        return h('div', { key: field.path, className: 'cpxp-media-field-wide' },
          h(SecretField, {
            entry: field,
            value: secrets[field.path] || '',
            configured: field.configured,
            mask: field.mask,
            fromEnv: field.fromEnv === true,
            envVar: field.envVar || '',
            disabled: field.locked || Boolean(busy),
            error,
            onChange: text => onSecret(field.path, text),
          }),
          clearButton);
      }
      return h('div', { key: field.path, className: field.type === 'textarea' ? 'cpxp-media-field-wide' : '' },
        h(FieldControl, {
          entry: field,
          value: draft[field.path],
          disabled: field.locked || Boolean(busy),
          error,
          onChange: text => onDraft(field.path, text),
        }));
    });
    const actions = h('div', { className: 'cpxp-media-actions' },
      h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        loading: busy === `save:${provider.prefix}`,
        disabled: !dirty || Boolean(busy),
        onClick: () => onSave(provider.prefix),
        title: '只保存这个 provider 的改动（留空的密钥不会被写回）',
      }, '保存这个 provider'),
      h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        loading: busy === `test:${provider.id}`,
        disabled: !provider.canTest || Boolean(busy),
        onClick: () => onTest(provider.id, provider.kind, !provider.canTest),
        title: provider.canTest ? '由你点一下才发起一次轻量探测（不会生成图片/语音）' : '尚未接入，无法测试',
      }, '测试连接'),
      status ? testResultLine(status) : null);
    const evidence = h(ui.Diagnostic, { title: '协议与证据（只读）', hint: provider.label },
      h(ui.KeyValue, {
        items: [
          { k: 'endpoint', v: provider.endpoint || '—', mono: true, breakable: true },
          { k: 'auth', v: provider.auth || '—' },
          { k: 'response', v: provider.responseFormat || '—' },
          { k: 'voice', v: provider.voiceListing || '—' },
          { k: 'rateLimit', v: provider.rateLimit || '—' },
          { k: 'license', v: provider.license || '—' },
          { k: 'evidence', v: provider.evidence && provider.evidence.level ? `${provider.evidence.level} 级` : '—' },
        ],
      }));
    return h('div', { key: `provider-${provider.id}`, className: 'cpxp-media-card' },
      header,
      h('p', { className: 'cpxp-media-note' }, provider.stateNote || ''),
      h('div', { className: 'cpxp-media-fields' }, fieldNodes),
      actions,
      status && status.detail ? h('p', { className: 'cpxp-media-note' }, status.detail) : null,
      evidence);
  }

  function testResultLine(status) {
    if (!status) return null;
    if (status.running) return h(ui.StateLine, { state: 'idle', text: '测试中…' });
    if (status.ok) return h(ui.StateLine, { state: 'ok', text: `测试通过（证据等级 ${status.level || 'none'}）` });
    return h(ui.StateLine, { state: 'danger', text: `测试失败${status.code ? ` · ${status.code}` : ''}` });
  }

  function PresetEditor({ presets, draft, busy, onDraft }) {
    if (!presets) return null;
    const familyCards = presets.families.map(family => h('div', { key: family.path, className: 'cpxp-media-card' },
      h('h4', { className: 'cpxp-media-card-title' }, family.label),
      h('div', { className: 'cpxp-media-fields' },
        family.fields.map(field => h('div', { key: field.path, className: 'cpxp-media-field-wide' },
          h(FieldControl, {
            entry: field,
            value: draft[field.path],
            disabled: Boolean(busy),
            onChange: text => onDraft(field.path, text),
          }))))));
    const artist = presets.artist;
    const artistCard = artist
      ? h('div', { key: 'preset-artist', className: 'cpxp-media-card' },
        h('h4', { className: 'cpxp-media-card-title' }, artist.label || '画师串'),
        h('div', { className: 'cpxp-media-fields' },
          h('div', { className: 'cpxp-media-field-wide' },
            h(FieldControl, {
              entry: artist,
              value: draft[artist.path],
              disabled: Boolean(busy),
              onChange: text => onDraft(artist.path, text),
            }))))
      : null;
    return h('div', null,
      h('p', { className: 'cpxp-media-note' }, presets.note || 'V5 与 4.5 的预设分开存储，互不串用；切换模型不会把一族的预设套到另一族。'),
      h('div', { className: 'cpxp-media-presets' }, familyCards),
      artistCard);
  }

  function PreviewTool({ spec, preview, form, busy, onForm, onRun }) {
    if (!spec) return null;
    const resolution = preview && preview.resolution ? preview.resolution : null;
    const defaults = spec.values || {};
    const aspects = [
      { value: 'portrait', label: '竖图' },
      { value: 'landscape', label: '横图' },
      { value: 'square', label: '方图' },
    ];
    return h('div', { className: 'cpxp-media-card' },
      h('h4', { className: 'cpxp-media-card-title' }, spec.label || '自动分辨率预览'),
      h('p', { className: 'cpxp-media-note' }, spec.note || '按画幅与目标像素计算并取整到 64 的倍数；同一输入同一结果，越界会明确报错。'),
      h('div', { className: 'cpxp-media-actions' },
        h(ui.Select, {
          value: form.aspect || defaults.aspect || 'portrait',
          ariaLabel: '画幅',
          options: aspects,
          onChange: value => onForm({ ...form, aspect: value }),
        }),
        h(ui.Input, {
          value: String(form.targetPixels || defaults.targetPixels || ''),
          ariaLabel: '目标像素',
          width: 150,
          onChange: value => onForm({ ...form, targetPixels: value }),
        }),
        h(ui.Button, {
          variant: 'ghost',
          size: 'sm',
          loading: busy === 'preview',
          onClick: onRun,
          title: '只在点击时计算；不生成图片、不调用模型',
        }, '预览')),
      resolution
        ? h('p', { className: 'cpxp-media-note' }, resolution.ok
          ? `结果：${resolution.size || '—'}（取整到 64 的倍数）`
          : `计算失败：${resolution.error || resolution.code || '参数不合法'}（按后端返回照实显示，页面不改写）`)
        : null);
  }

  function sectionDirty(section, draft, secrets, clears) {
    const fields = [];
    if (section.toggle && !section.toggle.disabled) fields.push({ path: section.toggle.path, original: section.toggle.original, secret: false });
    if (section.selector && !section.selector.disabled) fields.push({ path: section.selector.path, original: section.selector.original, secret: false });
    section.fields.forEach((field) => { if (!field.locked) fields.push(field); });
    section.providers.forEach((provider) => {
      provider.fields.forEach((field) => { if (!field.locked) fields.push(field); });
      if (provider.enablePath && !provider.enableField && provider.canEnable) {
        fields.push({ path: provider.enablePath, original: provider.enabled === true, secret: false });
      }
    });
    const presets = section.presets;
    (presets ? presets.families : []).forEach(family => family.fields.forEach(field => fields.push(field)));
    if (presets && presets.artist) fields.push(presets.artist);
    return fields.some((field) => {
      if (clears[field.path]) return true;
      if (field.secret) return Boolean(secrets[field.path]);
      const value = draft[field.path];
      if (typeof field.original === 'boolean') return (value === true) !== (field.original === true);
      return String(value ?? '') !== String(field.original ?? '');
    });
  }

  function SectionCard({ section, states, testing, draft, secrets, clears, errors, busy, onDraft, onSecret, onClear, onSave, onTest }) {
    const [open, setOpen] = P.useState(true);
    const dirty = sectionDirty(section, draft, secrets, clears);
    const selectedProvider = section.selector ? (draft[section.selector.path] ?? section.selector.value) : null;
    const toggleNode = section.toggle
      ? h('div', { className: 'cpxp-media-actions' },
        h(ui.Toggle, {
          checked: Boolean(draft[section.toggle.path] ?? section.toggle.value),
          disabled: section.toggle.disabled,
          label: section.toggle.label,
          hint: section.toggle.disabled ? (section.toggle.why || '这一项本轮不可操作') : '',
          onChange: next => onDraft(section.toggle.path, next),
        }))
      : null;
    const selectorNode = section.selector
      ? h('div', { className: 'cpxp-media-actions' },
        h(ui.Field, { label: section.selector.label, id: `media-${section.selector.path}` },
          h(ui.Select, {
            value: selectedProvider,
            disabled: section.selector.disabled,
            ariaLabel: section.selector.label,
            options: section.selector.options,
            onChange: value => onDraft(section.selector.path, value),
          })))
      : null;
    const fieldNodes = section.fields.length
      ? h('div', { className: 'cpxp-media-fields' }, section.fields.map(field => h('div', {
        key: field.path,
        className: field.type === 'textarea' ? 'cpxp-media-field-wide' : '',
      }, h(FieldControl, {
        entry: field,
        value: field.secret ? '' : draft[field.path],
        disabled: field.locked || Boolean(busy),
        error: errors[field.path],
        onChange: text => (field.secret ? onSecret(field.path, text) : onDraft(field.path, text)),
      }))))
      : null;
    const providerNodes = section.providers.length
      ? h('div', null, section.providers.map(provider => h(ProviderCard, {
        key: provider.id,
        provider,
        selected: provider.id === selectedProvider,
        states,
        draft,
        secrets,
        clears,
        errors,
        testing,
        busy,
        onDraft,
        onSecret,
        onClear,
        onSave,
        onTest,
      })))
      : null;
    const saveNode = h('div', { className: 'cpxp-media-actions' },
      h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        loading: busy === `save:${section.id}`,
        disabled: section.locked || !dirty || Boolean(busy),
        onClick: () => onSave(section.id),
        title: section.locked ? '这一块本轮不可编辑' : '保存这一块的改动',
      }, '保存这一块'));
    return h('section', { key: `section-${section.id}`, className: 'cpxp-media-sec' },
      h('div', { className: 'cpxp-media-sec-head' },
        h('div', null,
          h('h3', { className: 'cpxp-media-sec-title' }, section.title),
          h('p', { className: 'cpxp-media-note' }, section.note)),
        h('div', { className: 'cpxp-media-actions' },
          section.status ? h(ui.Badge, { tone: section.status === 'on' ? 'ok' : 'neutral' }, section.status === 'on' ? '已启用' : '未启用') : null,
          h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setOpen(!open) }, open ? '收起' : '展开'))),
      open
        ? h('div', null,
          toggleNode,
          selectorNode,
          fieldNodes,
          providerNodes,
          section.presets ? h(PresetEditor, { presets: section.presets, draft, busy, onDraft }) : null,
          saveNode)
        : null);
  }

  function runtimeFlagList(media) {
    const rows = [
      { key: 'enabled', label: '媒体总开关' },
      { key: 'vision', label: '识图' },
      { key: 'speech', label: '语音表达' },
      { key: 'image', label: '图片创作' },
      { key: 'screen', label: '屏幕感知' },
    ];
    return h(ui.Diagnostic, { key: 'runtime-flags', title: '运行库视角（GET companion · media）', hint: '只说明运行库读到的开关；本页的配置以媒体插件为准' },
      h(ui.List, { label: '运行库读到的媒体开关' }, rows.map(row => h(ui.Row, {
        key: `rt-${row.key}`,
        title: row.label,
        meta: '来自 GET companion',
        status: h(ui.StateLine, {
          state: media && media[row.key] === true ? 'ok' : 'idle',
          text: media && media[row.key] === true ? '已启用' : media && media[row.key] === false ? '已关闭' : '未读到',
        }),
      }))));
  }

  function MediaBand({ media }) {
    const state = P.useApi(loadMedia, []);
    const [draft, setDraft] = P.useState({});
    const [secrets, setSecrets] = P.useState({});
    const [clears, setClears] = P.useState({});
    const [errors, setErrors] = P.useState({});
    const [busy, setBusy] = P.useState('');
    const [flash, setFlash] = P.useState(null);
    const [testing, setTesting] = P.useState({});
    const [preview, setPreview] = P.useState(null);
    const [previewForm, setPreviewForm] = P.useState({});

    const bundle = state.data || null;
    const descriptor = bundle && bundle.page ? bundle.page.page : null;
    const configBundle = bundle && bundle.config ? bundle.config : null;
    const config = configBundle && configBundle.config ? configBundle.config : null;
    const api = bundle && bundle.api ? bundle.api : {};
    // 必须 memo：每次渲染新建 view 会让下面的"重置表单"effect 反复触发（无限渲染）。
    const view = P.useMemo(
      () => (descriptor && config ? buildView(descriptor, config) : null),
      [descriptor, config],
    );

    P.useEffect(() => {
      if (!view) return;
      setDraft(draftFrom(view));
      setSecrets({});
      setClears({});
      setErrors({});
    }, [view]);

    const validation = configBundle && configBundle.validation ? configBundle.validation : null;
    const setSecret = (path, value) => setSecrets(previous => ({ ...previous, [path]: value }));

    /** 切换默认协议时，如果新协议还没配好，先把能力关掉——否则后端会以 400 拒绝整次保存。 */
    const setField = (path, value) => {
      setDraft(previous => ({ ...previous, [path]: value }));
      if (!view) return;
      const section = view.sections.find(item => item.selector && item.selector.path === path);
      if (!section || !section.toggle || section.toggle.value !== true) return;
      const provider = section.providers.find(item => item.id === value);
      if (!provider || provider.missing.length === 0) return;
      setFieldDirect(section.toggle.path, false);
      setFlash({
        tone: 'warn',
        title: `已先关闭「${section.toggle.label}」`,
        text: `新选的协议还没配置完整（缺 ${provider.missing.join('、')}）。启用态下保存会被后端拒绝，所以先把开关关掉；补齐后再打开。`,
      });
    };
    const setFieldDirect = (path, value) => setDraft(previous => ({ ...previous, [path]: value }));

    const setClear = (path, provider) => {
      const needsDisable = Boolean(provider && provider.enabled && provider.disablePath);
      if (!clears[path] && typeof P.confirm === 'function') {
        const message = needsDisable
          ? `清除「${provider.label}」的密钥需要两步：\n1) 先关掉「${provider.kind === 'tts' ? '这个后端的启用' : '启用生图'}」\n2) 再清空密钥\n\n点「保存」会把这两步一起提交（后端不允许在启用态清空必填密钥）。`
          : `清除「${provider ? provider.label : path}」已保存的密钥？\n\n点「保存」之后才会真正删掉；输入框留空不会删除密钥。`;
        if (!P.confirm(message)) return;
      }
      // 两步引导：启用态下清密钥 = 同一个 patch 里先把开关关掉，避免撞后端 400。
      if (needsDisable) setFieldDirect(provider.disablePath, false);
      setClears(previous => ({ ...previous, [path]: !previous[path] }));
    };

    /** 这个密钥字段属于哪个 provider（清除时要连带关掉它的能力开关）。 */
    const providerOfField = (path) => {
      if (!view) return null;
      for (const section of view.sections) {
        for (const provider of section.providers) {
          if (provider.fields.some(field => field.path === path)) return provider;
        }
      }
      return null;
    };

    const doSave = (prefix) => {
      if (!view) return;
      // 清除密钥必须"先关能力"：把被清 provider 的开关路径强制带进这份 patch。
      const forced = Object.keys(clears)
        .filter(path => clears[path])
        .map((path) => providerOfField(path))
        .filter(provider => provider && provider.enabled && provider.disablePath)
        .map(provider => provider.disablePath);
      const patch = patchFrom(view, draft, secrets, clears, prefix, forced);
      // 兜底：即使草稿里没留下关开关这一步，也要把它写进 patch（后端不许启用态清密钥）。
      forced.forEach((path) => {
        const parts = partsOf(path);
        if (configAtParts(patch, parts) === undefined) setParts(patch, parts, false);
      });
      if (!Object.keys(patch).length) {
        setFlash({ tone: 'info', title: '没有需要保存的修改', text: '只有改过的字段才会被提交。' });
        return;
      }
      setBusy(`save:${prefix || 'all'}`);
      setErrors({});
      mediaFetch(apiPath(api.save, 'config'), 'POST', { patch }).then((result) => {
        setBusy('');
        if (!result.ok) {
          setErrors(errorMap(result.payload && result.payload.errors));
          const first = result.payload && result.payload.error ? result.payload.error.message : '';
          setFlash({ tone: 'danger', title: '保存失败', text: first || asApiError(result).message });
          return;
        }
        const savedCount = errorCount(patch);
        const nextConfig = result.payload && result.payload.config ? result.payload.config : null;
        const stillConfigured = Object.keys(clears).filter(path => clears[path]).filter((path) => {
          const value = configAt(nextConfig, path);
          return secretInfo(value).configured;
        });
        setSecrets({});
        setClears({});
        if (stillConfigured.length) {
          setFlash({
            tone: 'warn',
            title: `已保存 ${savedCount} 项，但清除没有生效`,
            text: '后端仍报告这些密钥处于配置状态。页面不会把"已清除"写在结果里——这需要媒体插件支持显式清除动作。',
          });
        } else {
          setFlash({ tone: 'ok', title: `已保存 ${savedCount} 项`, text: '已写入媒体配置文件；页面会重新读一遍同一份数据，可对照回读。' });
          if (typeof P.notice === 'function') P.notice('媒体配置已保存', 'ok');
        }
        state.reload();
      }, () => {
        setBusy('');
        setFlash({ tone: 'danger', title: '保存失败', text: '网络请求没有完成。' });
      });
    };

    const doTest = (id, kind, blocked) => {
      if (blocked) return;
      setBusy(`test:${id}`);
      setTesting(previous => ({ ...previous, [id]: { running: true } }));
      mediaFetch(apiPath(api.test, 'test'), 'POST', { kind: kind === 'tts' ? 'tts' : 'image', id }).then((result) => {
        setBusy('');
        const payload = result.payload || {};
        // 语义：provider 侧失败是 HTTP 200 + body.ok:false（只有未知 provider 才是 400）。
        setTesting(previous => ({
          ...previous,
          [id]: { ok: payload.ok === true, level: payload.level, code: payload.code, detail: payload.detail },
        }));
        if (typeof P.notice === 'function') P.notice(payload.ok === true ? '测试通过（只到这一级证据）' : '测试失败', payload.ok === true ? 'ok' : 'danger');
      }, () => {
        setBusy('');
        setTesting(previous => ({ ...previous, [id]: { ok: false, detail: '网络请求没有完成' } }));
      });
    };

    const runPreview = (spec) => {
      const values = (spec && spec.values) || {};
      const query = new URLSearchParams({
        mode: 'auto',
        aspect: previewForm.aspect || values.aspect || 'portrait',
        targetPixels: String(previewForm.targetPixels || values.targetPixels || ''),
      }).toString();
      if (values.model) query.model = String(values.model);
      setBusy('preview');
      mediaFetch(`${apiPath(api.preview, 'preview')}?${query}`).then((result) => {
        setBusy('');
        const payload = result.payload || {};
        setPreview(payload.resolution ? payload : { resolution: { ok: false, error: '读不到结果' } });
      }, () => {
        setBusy('');
        setPreview({ resolution: { ok: false, error: '网络请求没有完成' } });
      });
    };

    const header = {
      key: 'media-settings',
      title: '媒体能力',
      hint: '配置直接来自媒体插件；保存只走它自己的接口',
      actions: [state.data ? h(ui.Button, {
        key: 'reload',
        variant: 'ghost',
        size: 'sm',
        onClick: state.reload,
        title: '重新读一遍页面描述与配置（不会发起任何测试或生成）',
      }, '刷新') : null],
    };

    if (state.loading && !bundle) {
      return h(ui.Band, header, h(ui.Skeleton, { rows: 4 }));
    }
    if (isModuleDisabled(state.error)) {
      return h(ui.Band, header,
        h(ui.Callout, { tone: 'warn', title: '套件里没有启用「媒体」模块' },
          h('div', null,
            h('p', { className: 'cpxp-media-note' }, '这一页仍然能被打开，但媒体插件没有挂载时没有任何配置可读可写——这不是页面坏了。'),
            h('p', { className: 'cpxp-media-note' }, '启用路径：编辑套件里的 config/suite.json，把 modules.media 改成 true，然后重启套件（npm run start），再用 npm run doctor 复核。'),
            h(ui.Pre, { maxHeight: 160 }, ENABLE_SNIPPET),
            h('p', { className: 'cpxp-media-note' }, 'config/suite.json 是套件级本地配置（不入库），模板是 config/suite.example.json；npm run setup 不会覆盖已有文件。'))),
        runtimeFlagList(media));
    }
    if (!view) {
      return h(ui.Band, header,
        h(ui.Callout, { tone: state.error ? 'danger' : 'warn', title: '读不到媒体能力页面' },
          h('span', null, P.failText(state.error, '媒体接口没有返回页面描述或配置。'))),
        runtimeFlagList(media));
    }

    const sectionNodes = view.sections.map(section => h('div', { key: `sec-wrap-${section.id}` },
      h(SectionCard, {
        section,
        states: view.states,
        testing,
        draft,
        secrets,
        clears,
        errors,
        busy,
        onDraft: setField,
        onSecret: setSecret,
        onClear: setClear,
        onSave: doSave,
        onTest: doTest,
      }),
      section.preview
        ? h(PreviewTool, {
          key: `preview-${section.id}`,
          spec: section.preview,
          preview,
          form: previewForm,
          busy,
          onForm: setPreviewForm,
          onRun: () => runPreview(section.preview),
        })
        : null));

    return h(ui.Band, header, [
      flash ? h(ui.Callout, { key: 'flash', tone: flash.tone === 'ok' ? 'info' : flash.tone, title: flash.title }, h('span', null, flash.text)) : null,
      validation && validation.ok === false
        ? h(ui.Callout, { key: 'validation', tone: 'warn', title: '当前配置文件本身有校验问题' },
          h('ul', { className: 'cpxp-media-note' }, (validation.errors || []).slice(0, 6).map(item => h('li', { key: String(item.path || item.message) }, `${item.path || '$'}：${item.message || item.code || ''}`))))
        : null,
      h('p', { key: 'test-hint', className: 'cpxp-media-note-inline' },
        '测试与预览只在你点按钮时发起：打开这一页只读 page 与 config，不会生成图片、不会调用模型、不会向外发送消息。'),
      h('div', { key: 'sections' }, sectionNodes),
      runtimeFlagList(media),
      h(ui.Diagnostic, { key: 'raw', title: '原始页面描述与配置（只读）', hint: '排查用；密钥已脱敏' },
        h(ui.Pre, { maxHeight: 320 }, JSON.stringify({ page: redactForDebug(descriptor), config: redactForDebug(config) }, null, 2))),
    ]);
  }

  P.mediaPage = {
    MediaBand,
    buildView,
    fieldIndex,
    draftFrom,
    patchFrom,
    errorMap,
    errorCount,
    isModuleDisabled,
    redactForDebug,
    stateLabel,
    stateTone,
    secretInfo,
    configAt,
    apiPath,
    STATE_LABELS,
    STATE_TONES,
    MEDIA_BASE,
    ENABLE_SNIPPET,
  };
})(P);
