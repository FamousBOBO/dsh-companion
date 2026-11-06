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

  // 切页会重建组件实例（组件状态丢失），草稿按「服务器配置指纹」缓存在模块级：
  // 重新挂载时指纹一致就恢复，避免静默丢掉用户正在编辑的内容（2026-11-06 UI 审核 P2）。
  const draftCache = { sig: '', draft: {}, secrets: {}, clears: {}, hasEdits: false };

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


  P.css(`
    .cpx-media-page > .cpx-band { padding-top:0; }
    .cpx-media-page > .cpx-band > .cpx-band-head { padding:0 0 4px; }
    .cpx-media-page > .cpx-band > .cpx-band-head .cpx-band-title { font-size:28px; letter-spacing:-.6px; }
    .cpxp-media-sec { padding:0; border-radius:16px; overflow:hidden; margin-bottom:24px; background:var(--dsw-alias-bg-layer-1); border-color:var(--dsw-alias-border-l1); }
    .cpxp-media-sec-head { padding:22px 24px; align-items:center; flex-wrap:nowrap; border-bottom:1px solid var(--dsw-alias-border-l1); }
    .cpxp-section-name { display:flex; gap:12px; align-items:center; }
    .cpxp-section-symbol { display:grid; place-items:center; width:38px; height:38px; border-radius:11px; background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent); color:var(--dsw-alias-brand-primary); flex:none; }
    .cpxp-media-sec-title { font-size:20px; font-weight:650; }
    .cpxp-section-body { padding:24px; display:flex; flex-direction:column; gap:24px; }
    .cpxp-media-head-actions { display:flex; align-items:center; gap:14px; }
    .cpxp-enable { display:inline-flex; align-items:center; gap:9px; padding:8px 0; border:0; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:14px; min-height:42px; white-space:nowrap; cursor:pointer; }
    .cpxp-enable[aria-checked=true] { color:var(--dsw-alias-label-primary); }
    .cpxp-switch-track { width:38px; height:22px; border-radius:99px; padding:3px; background:var(--dsw-alias-border-l2); transition:background .18s; display:inline-flex; flex:none; }
    .cpxp-switch-track::before { content:''; width:16px; height:16px; border-radius:50%; background:var(--dsw-alias-label-secondary); transition:transform .18s; }
    [aria-checked=true] > .cpxp-switch-track { background:var(--dsw-alias-brand-primary); }
    [aria-checked=true] > .cpxp-switch-track::before { background:var(--dsw-alias-bg-base); transform:translateX(16px); }
    .cpxp-audio-picker{display:flex;gap:10px;align-items:center;}.cpxp-audio-picker .cmx-input{flex:1;min-width:0;width:100%;}.cpxp-audio-picker .cmx-btn{flex:none;}
    .cpxp-preset-picker .cmx-select{width:100%;min-height:48px;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1));font-size:15px;font-weight:600;}
    .cpxp-media-description{margin:-8px 0 20px;font-size:13px;color:var(--dsw-alias-label-secondary);}
    .cpxp-media-card { padding:0; border:0; border-radius:0; background:transparent; }
    .cpxp-media-card-head { margin-bottom:20px; }
    .cpxp-media-card-title { font-size:15px; margin-bottom:5px; }
    .cpxp-media-fields { grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; margin:0; }
    .cpxp-media-fields > * { min-width:0; }
    .cpxp-media-secret { width:100%; flex-wrap:nowrap; }
    .cpxp-media-secret .cmx-input { flex:1; width:100%; min-width:0; }
    .cpxp-media-secret .cpx-state-line { flex:none; }
    .cpxp-media-actions { margin-top:18px; gap:12px; }
    .cpxp-media-badge-row { gap:8px; }
    .cpxp-media-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:22px; border-top:1px solid var(--dsw-alias-border-l1); }
    .cpxp-generation { padding-top:24px; border-top:1px solid var(--dsw-alias-border-l1); display:flex; flex-direction:column; gap:24px; }
    .cpxp-preset-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .cpxp-preset-head h4 { margin:0; font-size:18px; font-weight:650; }
    .cpxp-preset-head p { margin:3px 0 0; font-size:12px; }
    .cpxp-advanced { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:12px 16px; }
    .cpxp-advanced summary { cursor:pointer; color:var(--dsw-alias-label-secondary); font-size:13px; }
    .cpxp-advanced[open] > .cpxp-media-fields { margin-top:20px; }
    .cpxp-auto-resolution { display:flex;align-items:center;gap:8px;align-self:end; }
    .cpxp-resolution-button { display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:50px;min-width:224px;padding:12px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;font:inherit;font-weight:600;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer; }
    .cpxp-resolution-button[aria-checked=true] { color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-1)); }
    .cpxp-resolution-state {font-size:12px;font-weight:400;}
    .cpxp-resolution { display:flex; gap:20px; align-items:center; flex-wrap:wrap; }
    .cpxp-media-field-wide textarea { min-height:100px; resize:vertical; }
    @media(max-width:760px) { .cpxp-media-sec-head,.cpxp-section-body { padding:18px; } .cpxp-media-head-actions { gap:8px; } .cpxp-media-fields { grid-template-columns:1fr; gap:18px; } .cpxp-media-sec-title { font-size:18px; } .cpxp-section-symbol { display:none; } }
    @media(prefers-reduced-motion:reduce) { .cpxp-switch-track,.cpxp-switch-track::before { transition:none; } }
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
      value: field.type === 'json' ? JSON.stringify(current || []) : secret || plain ? '' : current,
      original: field.type === 'json' ? JSON.stringify(current || []) : secret || plain ? '' : current,
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
      generationFields: provider.generationFields || null,
      promptOptions:provider.promptOptions || null,
      description:provider.description || '',
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
    // descriptor 形状以 media 为准，三种都认（不复制业务逻辑，只做形状适配）：
    //   families[].fields[]（每族多个字段：positive/negative/applyDefaults）
    //   families[].field（每族一个字段）
    //   只有 path（兜底：按配置里的真实结构展开）
    if (Array.isArray(spec.families) && spec.families.length) {
      const families = spec.families.map((family) => {
        if (!family) return null;
        const raw = Array.isArray(family.fields)
          ? family.fields
          : (family.field ? [family.field] : []);
        const fields = raw.filter(Boolean).map(item => fieldView(item, config));
        if (!fields.length) return null;
        return {
          family: String(family.family ?? ''),
          label: family.label || String(family.family ?? '预设'),
          path: family.path || fields[0].path,
          fields,
        };
      }).filter(Boolean);
      if (families.length) {
        return {
          path: spec.path || '',
          note: spec.note || '',
          families,
          artist: spec.artistString ? fieldView(spec.artistString, config) : null,
        };
      }
    }
    // 兜底：按配置里的真实结构逐族展开。
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
    if (type === 'json') { try { return JSON.parse(value || '[]'); } catch { return null; } }
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
   * 服务器配置的指纹：只由 descriptor 给出的当前值/已配置状态组成，跟草稿无关。
   * 用途有两个：判断"重新挂载时草稿是否还属于这份配置"，以及"重载回来的数据是不是新数据"。
   */
  function signatureOf(view) {
    if (!view) return '';
    const parts = [];
    (view.sections || []).forEach((section) => {
      if (section.toggle) parts.push(`${section.toggle.path}=${section.toggle.value}`);
      if (section.selector) parts.push(`${section.selector.path}=${section.selector.value}`);
      const pushField = (field) => {
        if (!field || !field.path) return;
        parts.push(field.secret ? `${field.path}=${field.configured}` : `${field.path}=${String(field.original)}`);
      };
      (section.fields || []).forEach(pushField);
      (section.providers || []).forEach((provider) => {
        (provider.fields || []).forEach(pushField);
        if (provider.enablePath && !provider.enableField) parts.push(`${provider.enablePath}=${provider.enabled}`);
      });
      const presets = section.presets;
      (presets ? presets.families : []).forEach(family => family.fields.forEach(pushField));
      if (presets && presets.artist) pushField(presets.artist);
    });
    return parts.join('|');
  }

  /** 这个 provider 有没有未保存的改动（含它的启用开关、密钥、清除动作）。 */
  function providerDirty(provider, draft, secrets, clears) {
    if (!provider) return false;
    const within = path => String(path) === provider.prefix || String(path).startsWith(`${provider.prefix}.`);
    const hasSecrets = Object.keys(secrets || {}).some(path => within(path) && String(secrets[path] ?? '').trim() !== '');
    const hasClears = Object.keys(clears || {}).some(path => within(path) && clears[path]);
    if (hasSecrets || hasClears) return true;
    const changed = (provider.fields || []).some((field) => {
      if (field.secret || field.locked) return false;
      const value = draft ? draft[field.path] : undefined;
      if (value === undefined) return false;
      const type = field.type === 'boolean' ? 'boolean' : (field.type === 'number' ? 'number' : 'text');
      return !sameValue(coerce(type, value), field.original);
    });
    if (changed) return true;
    if (provider.enablePath && !provider.enableField) {
      const value = draft ? draft[provider.enablePath] : undefined;
      return value !== undefined && (value === true) !== (provider.enabled === true);
    }
    return false;
  }

  /**
   * 服务器数据换了指纹时，表单该怎么做（单测覆盖五种分支，见 test/media-page.test.mjs）：
   *   keep            —— 服务器数据没变：草稿原样保留（刷新不会覆盖未保存改动）；
   *   seed-server     —— 跟服务器走：首次加载、保存成功后的重读；
   *   keep-and-warn   —— 服务器变了但本地有未保存改动：保留草稿，只提示，绝不覆盖；
   *   restore-cache   —— 切页回来（组件重建）且指纹一致：从模块级草稿缓存恢复。
   */
  function seedDecision({ sig, seenSig, hasLocalEdits, reseedPending, cacheMatches }) {
    if (sig === seenSig) return 'keep';
    if (reseedPending) return 'seed-server';
    if (hasLocalEdits && seenSig !== '') return 'keep-and-warn';
    if (cacheMatches) return 'restore-cache';
    return 'seed-server';
  }

  /**
   * `POST /config` 的 patch：只带真正改动的字段；密钥只在用户输入过时出现；
   * 清除走 `{clear:true}`。prefix 用于"只保存某个 provider / 某一块"。
   * 后端是稀疏深合并：没发的 provider 段原样保留，所以这里绝不能把整份配置塞回去。
   *
   * `include` 是"强制关掉"的路径（清密钥时必须先关能力）：它们既越过 prefix 过滤，
   * 又无条件写 false——后端不允许在启用态清空必填密钥。
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
      if (meta.type === 'json' ? JSON.stringify(next) === meta.original : sameValue(next, meta.original)) return;
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
    extra.forEach((path) => setParts(patch, partsOf(path), false));
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
    const controlId = `media-${entry.path}`;
    const status = fromEnv
      ? h(ui.StateLine, { state: 'idle', text: `来自环境变量${envVar ? `（${envVar}）` : ''}` })
      : h(ui.StateLine, { state: configured ? 'ok' : 'idle', text: configured ? '已配置' : '未配置' });
    const hint = fromEnv
      ? '这个 provider 的密钥来自环境变量：在这里改不会生效，请改环境变量本身'
      : '';
    return h(ui.Field, { label: entry.label, hint, id: controlId },
      h('div', { className: 'cpxp-media-secret' },
        h(ui.Input, {
          id: controlId,
          type: 'password',
          value: value || '',
          placeholder: fromEnv ? '由环境变量提供' : (configured ? '已保存，输入以替换' : '尚未配置'),
          disabled: Boolean(disabled || fromEnv),
          ariaLabel: entry.label,
          onChange: text => onChange(text),
        }),
        status),
      error ? h('p', { className: 'cpxp-media-error' }, error) : null);
  }


  function ReferenceAudio({entry,value,disabled,error,onChange}) {
    const input=P.useRef(null);
    const [busy,setBusy]=P.useState(false);
    const [failure,setFailure]=P.useState('');
    const provider=entry.pathParts[2];
    const upload=async event=>{
      const file=event.target.files?.[0];if(!file)return;
      setFailure('');setBusy(true);
      try {
        if(file.size>16*1024*1024)throw Error('参考音频需小于16MB');
        const response=await fetch(mediaUrl(MEDIA_BASE+'reference-audio?provider='+encodeURIComponent(provider)),{method:'POST',credentials:'same-origin',headers:{'content-type':file.type||'application/octet-stream'},body:file});
        const result=await response.json();
        if(!result.ok)throw Error(result.error?.message||'上传没有完成');
        onChange(result.path);
        if(typeof P.notice==='function')P.notice('参考音频已上传，请保存设置','ok');
      } catch(e){setFailure(e.message||'上传没有完成');}finally{setBusy(false);event.target.value='';}
    };
    return h(ui.Field,{label:'参考音频',id:'media-'+entry.path},
      h('div',{className:'cpxp-audio-picker'},h(ui.Input,{id:'media-'+entry.path,value:value||'',disabled:disabled||busy,ariaLabel:'参考音频',placeholder:provider==='gpt-sovits'?'服务端路径，或选择文件上传':'选择音频文件',onChange}),h(ui.Button,{disabled:disabled||busy,loading:busy,onClick:()=>input.current?.click()},'选择文件'),h('input',{ref:input,type:'file',accept:'.wav,.mp3,.ogg,.flac,audio/*',style:{display:'none'},onChange:upload,'aria-label':'上传参考音频'})),
      provider==='gpt-sovits'?h('p',{className:'cpx-field-hint'},'文件上传需服务支持参考音频桥接；也可填写服务端已有路径。'):null,
      failure||error?h('p',{className:'cpxp-media-error'},failure||error):null);
  }
  function FieldControl({ entry, value, disabled, error, onChange }) {
    const controlId = `media-${entry.path}`;
    if(entry.type==='boolean'&&/^(image\.pipeline|tts\.director)\./.test(entry.path))return h(ui.Field,{label:entry.label,info:entry.hint},h('button',{type:'button',className:'cpxp-enable',style:{padding:'10px 16px',border:'1px solid var(--dsw-alias-border-primary)',borderRadius:'10px',width:'100%',minHeight:'46px'},role:'switch','aria-label':entry.label,'aria-checked':value===true,disabled,onClick:()=>onChange(value!==true)},h('span',{className:'cpxp-switch-track'}),'启用'));
    if(lastSegment(entry.path)==='refAudioPath')return h(ReferenceAudio,{entry,value,disabled,error,onChange});
    if (entry.type === 'boolean') {
      return h('div', null,
        h(ui.Toggle, { id: controlId, checked: value === true, disabled, label: entry.label, hint: entry.hint, onChange: next => onChange(next) }),
        error ? h('p', { className: 'cpxp-media-error' }, error) : null);
    }
    let control;
    if (entry.type === 'textarea') {
      control = h(ui.TextArea, { id: controlId, value: value ?? '', disabled, rows: 3, ariaLabel: entry.label, onChange: text => onChange(text) });
    } else if (entry.options && entry.options.length) {
      control = h(ui.Select, { id: controlId, value: value ?? '', disabled, ariaLabel: entry.label, options: entry.options, onChange: text => onChange(text) });
    } else {
      control = h(ui.Input, {
        id: controlId,
        type: entry.type === 'number' ? 'number' : 'text',
        value: value ?? '',
        disabled,
        ariaLabel: entry.label,
        onChange: text => onChange(text),
      });
    }
    return h(ui.Field, { label: entry.label, hint: entry.hint, info: entry.info, id: controlId },
      control,
      error ? h('p', { className: 'cpxp-media-error' }, error) : null);
  }

  function ProviderCard({ provider, selected, states, draft, secrets, clears, errors, testing, busy, onDraft, onSecret, onClear, onSave, onTest }) {
    const [open, setOpen] = P.useState(selected);
    // Follow protocol changes while retaining manual expand/collapse between selections.
    P.useEffect(() => setOpen(selected), [selected]);
    const status = testing[provider.id] || null;
    // 未保存的改动 = 表单和"已保存配置"不一致：这时测试按钮必须禁用，
    // 因为 /test 读的永远是已保存配置（2026-11-06 UI 审核 P1）。
    const dirty = providerDirty(provider, draft, secrets, clears);
    const badge = h('div', { className: 'cpxp-media-badge-row' },
      h(ui.Badge, { tone: stateTone(provider.state) }, stateLabel(states, provider.state)),
      provider.notConnected ? h(ui.Badge, { tone: 'neutral' }, '尚未接入') : null,
      provider.enabled === true ? h(ui.Badge, { tone: 'ok' }, '已启用') : null,
      dirty ? h(ui.Badge, { tone: 'warn' }, '有未保存的修改') : null);
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
        null,
        !dirty && status ? testResultLine(status) : null);
    }
    const fieldNodes = provider.fields.filter(field => {
      const key = lastSegment(field.path);
      if(provider.kind==='tts' && ['enabled','mediaType'].includes(key))return false;
      if (provider.generationFields && (provider.generationFields.includes(key) || ['activePresetId','generationPresets'].includes(key))) return false;
      return !(provider.generationFields && key === 'baseUrl' && draft[provider.prefix+'.transport'] === 'official');
    }).sort((a,b) => (lastSegment(a.path)==='transport'?-1:lastSegment(b.path)==='transport'?1:0)).map((field) => {
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
        variant: 'primary',
        loading: busy === `save:${provider.kind}`,
        disabled: !dirty || Boolean(busy),
        onClick: () => onSave(provider.kind),
        title: '只保存这个 provider 的改动（留空的密钥不会被写回）',
      }, '保存'),
      h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        loading: busy === `test:${provider.id}`,
        disabled: !provider.canTest || Boolean(busy) || dirty,
        onClick: () => onTest(provider.id, provider.kind, !provider.canTest || dirty),
        title: !provider.canTest
          ? '尚未接入，无法测试'
          : (dirty ? '有未保存的修改：先保存再测试（测试用的是已保存的配置）' : '由你点一下才发起一次轻量探测（不会生成图片/语音）'),
      }, '测试连接'),
      !dirty && status ? testResultLine(status) : null);
    const dirtyNote = dirty
      ? h('p', { className: 'cpxp-media-note' }, '请先保存修改，再测试连接。')
      : null;
    return h('div', { key: `provider-${provider.id}`, className: 'cpxp-media-card' },
      header,
      null,
      provider.description ? h('p',{className:'cpxp-media-description'},provider.description) : null,
      h('div', { className: 'cpxp-media-fields' }, fieldNodes),
      actions,
      dirtyNote,
      status && !dirty && status.detail ? h('p', { className: 'cpxp-media-note' }, status.detail) : null,
      null);
  }

  function testResultLine(status) {
    if (!status) return null;
    if (status.running) return h(ui.StateLine, { state: 'idle', text: '测试中…' });
    if (status.ok) return h(ui.StateLine, { state: 'ok', text: status.level === 'reachability' ? '地址可达 · 密钥未验证' : '测试通过' });
    return h(ui.StateLine, { state: 'danger', text: `测试失败${status.code ? ` · ${status.code}` : ''}` });
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


  function parseLibrary(value) { try { const items = JSON.parse(value || '[]'); return Array.isArray(items) ? items : []; } catch { return []; } }

  function GenerationEditor({ provider, presets, draft, busy, errors, onDraft }) {
    const prefix = provider.prefix;
    const libraryPath = prefix + '.generationPresets';
    const activePath = prefix + '.activePresetId';
    const library = parseLibrary(draft[libraryPath]);
    const active = library.find(item => item.id === draft[activePath]);
    const model = String(draft[prefix+'.model'] || '');
    const family = model.startsWith('nai-diffusion-5') ? '5' : model.startsWith('nai-diffusion-4') ? '4.5' : '';
    const snapshot = (path, value) => {
      const settings = {};
      provider.generationFields.forEach(key => {
        const field = provider.fields.find(f => f.path === prefix+'.'+key);
        settings[key] = coerce(field?.type, path === prefix+'.'+key ? value : draft[prefix+'.'+key]);
      });
      const families = {};
      (presets?.families || []).forEach(f => {
        families[f.family] = {};
        f.fields.forEach(field => { families[f.family][lastSegment(field.path)] = coerce(field.type,field.path===path?value:draft[field.path]); });
      });
      return {settings, presets:families};
    };
    const change = (path,value) => {
      onDraft(path,value);
      const data=snapshot(path,value);
      if(path===prefix+'.model' && provider.promptOptions?.[value]) {
        for(const [key,options]of [['qualityPreset',provider.promptOptions[value].quality],['negativePreset',provider.promptOptions[value].negative]])if(!options.some(o=>o.value===data.settings[key])){data.settings[key]=key==='qualityPreset'?'standard':'heavy';onDraft(prefix+'.'+key,data.settings[key]);}
      }
      if (active) onDraft(libraryPath,JSON.stringify(library.map(item => item.id===active.id ? {...item,...data} : item)));
    };
    const select = id => {
      const item = library.find(p => p.id===id);
      onDraft(activePath,id);
      if (!item) return;
      Object.entries(item.settings || {}).forEach(([key,value]) => { if(provider.generationFields.includes(key))onDraft(prefix+'.'+key,value); });
      (presets?.families || []).forEach(f => f.fields.forEach(field => {
        const value=item.presets?.[f.family]?.[lastSegment(field.path)];
        if(value!==undefined)onDraft(field.path,value);
      }));
    };
    const create = () => {
      const id = 'preset-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,7);
      onDraft(libraryPath,JSON.stringify([...library,{id,name:'新预设 '+(library.length+1),...snapshot()}]));
      onDraft(activePath,id);
    };
    const aspect = draft[prefix+'.aspect'] || 'portrait';
    const setAspect = value => {
      const sizes = {portrait:[832,1216],landscape:[1216,832],square:[1024,1024]};
      const [width,height]=sizes[value];
      onDraft(prefix+'.width',width); onDraft(prefix+'.height',height);
      change(prefix+'.aspect',value);
      // Include the derived fixed dimensions in the selected preset snapshot as well.
      if(active) { const data=snapshot(prefix+'.aspect',value); data.settings.width=width;data.settings.height=height; onDraft(libraryPath,JSON.stringify(library.map(item=>item.id===active.id?{...item,...data}:item))); }
    };
    const fields = [...provider.fields,...(presets?.artist?[presets.artist]:[])].filter(field => provider.generationFields.includes(lastSegment(field.path)) && !['width','height','aspect','autoResolution'].includes(lastSegment(field.path)));
    const advancedKeys=['seed','ucPreset','qualityToggle','sm','smDyn'];
    const promptOptions=provider.promptOptions?.[model];
    const presetTags=(kind,key)=>{
      const option=promptOptions?.[kind]?.find(item=>item.value===draft[prefix+'.'+key]);
      return option?.tags===null?'当前使用旧版自定义预设。':option?.tags||'当前未添加预设标签。';
    };
    const renderField=field=>h('div',{key:field.path,className:field.type==='textarea'?'cpxp-media-field-wide':''},h(FieldControl,{entry:{...field,hint:'',info:lastSegment(field.path)==='artistString'?presetTags('quality','qualityPreset'):lastSegment(field.path)==='negativePrompt'?presetTags('negative','negativePreset'):'',options:lastSegment(field.path)==='qualityPreset'?promptOptions?.quality||field.options:lastSegment(field.path)==='negativePreset'?promptOptions?.negative||field.options:field.options},value:draft[field.path],disabled:!!busy,error:errors[field.path],onChange:value=>change(field.path,value)}));
    return h('section',{className:'cpxp-generation', 'aria-label':'生成预设'},
      h('div',{className:'cpxp-preset-head'},
        h('div',null,h('h4',null,'生成预设'),h('p',{className:'cpx-muted'},active ? active.name : '默认预设')),
        h(ui.Button,{onClick:create,disabled:!!busy||library.length>=32},'新建预设')),
      h('div',{className:'cpxp-media-fields'},
        h('div',{className:'cpxp-preset-picker'},h(ui.Field,{label:'生成方案'},h(ui.Select,{ariaLabel:'生成方案',value:active?.id||'',disabled:!!busy,options:[{value:'',label:'默认预设'},...library.map(i=>({value:i.id,label:i.name}))],onChange:select}))),
        active ? h(ui.Field,{label:'预设名称'},h(ui.Input,{ariaLabel:'预设名称',value:active.name,disabled:!!busy,onChange:name=>onDraft(libraryPath,JSON.stringify(library.map(i=>i.id===active.id?{...i,name}:i)))})) : null),
      errors[libraryPath] ? h('p',{className:'cpxp-media-error'},errors[libraryPath]) : null,
      h('div',{className:'cpxp-media-fields'},fields.filter(f=>!advancedKeys.includes(lastSegment(f.path))&&!['qualityPreset','negativePreset','artistString','negativePrompt'].includes(lastSegment(f.path))).map(renderField)),
      h('details',{className:'cpxp-advanced'},h('summary',null,'更多生成参数'),h('div',{className:'cpxp-media-fields'},fields.filter(f=>advancedKeys.includes(lastSegment(f.path))&&!(lastSegment(f.path)==='qualityToggle'&&draft[prefix+'.qualityPreset']!=='legacy')&&!(lastSegment(f.path)==='ucPreset'&&draft[prefix+'.negativePreset']!=='legacy')).map(renderField))),
      h('div',{className:'cpxp-resolution'},
        h(ui.Field,{label:'画面比例'},h(ui.Segmented,{label:'画面比例',value:aspect,disabled:!!busy,options:[{id:'portrait',label:'竖图 2:3'},{id:'landscape',label:'横图 3:2'},{id:'square',label:'方图 1:1'}],onChange:setAspect})),
        h('div',{className:'cpxp-auto-resolution'},h('button',{type:'button',className:'cpxp-resolution-button',role:'switch','aria-label':'自动分辨率','aria-checked':draft[prefix+'.autoResolution']===true,disabled:!!busy,onClick:()=>change(prefix+'.autoResolution',draft[prefix+'.autoResolution']!==true)},h(ui.Icon,{name:'image',size:18}),'自动分辨率',h('span',{className:'cpxp-resolution-state'},draft[prefix+'.autoResolution']===true?'已开启':'已关闭')),h(ui.Info,{text:draft[prefix+'.autoResolution']===true?'约 100 万像素，按画面比例自动计算分辨率。':`固定分辨率：${draft[prefix+'.width']} × ${draft[prefix+'.height']}`}))),
      h('div',{className:'cpxp-media-fields'},['qualityPreset','negativePreset','artistString','negativePrompt'].map(key=>fields.find(f=>lastSegment(f.path)===key)).filter(Boolean).map(renderField)));
  }

  function SectionCard({ section, states, testing, draft, secrets, clears, errors, busy, onDraft, onSecret, onClear, onSave, onTest }) {
    const [open,setOpen] = P.useState(!section.locked);
    const dirty=sectionDirty(section,draft,secrets,clears);
    const selected=section.selector?(draft[section.selector.path]??section.selector.value):null;
    const provider=section.providers.find(p=>p.id===selected&&!p.notConnected);
    const options=section.selector?.options.filter(o=>o.value==='none'||section.providers.some(p=>p.id===o.value&&!p.notConnected))||[];
    return h('section',{className:'cpxp-media-sec','data-section':section.id},
      h('div',{className:'cpxp-media-sec-head'},
        h('div',{className:'cpxp-section-name'},h('span',{className:'cpxp-section-symbol','aria-hidden':true},h(ui.Icon,{name:section.id==='image'?'image':section.id==='tts'?'audio':'eye',size:20})),h('h3',{className:'cpxp-media-sec-title'},section.title)),
        h('div',{className:'cpxp-media-head-actions'},
          section.toggle&&!section.locked?h('button',{type:'button',className:'cpxp-enable',role:'switch','aria-label':section.toggle.label,'aria-checked':!!draft[section.toggle.path],disabled:!!busy,onClick:()=>onDraft(section.toggle.path,!draft[section.toggle.path])},h('span',{className:'cpxp-switch-track'}),section.toggle.label):h(ui.Badge,{tone:'neutral'},'未启用'),
          h(ui.Button,{size:'sm',onClick:()=>setOpen(!open),ariaLabel:(open?'收起':'展开')+section.title},open?'收起':'展开'))),
      open?h('div',{className:'cpxp-section-body'},
        section.selector?h(ui.Segmented,{label:section.id==='image'?'生图服务':'语音服务',value:selected,disabled:!!busy,options:options.map(o=>({id:o.value,label:o.value==='none'?'未选择':o.label.replace(' 生图','').replace('（官方直连 / 中转站）','')})),onChange:value=>{onDraft(section.selector.path,value);if(section.id==='tts')section.providers.filter(p=>p.canEnable).forEach(p=>onDraft(p.enablePath,p.id===value));}}):null,
        section.fields.length?h('div',{className:'cpxp-media-fields'},section.fields.map(field=>h(FieldControl,{key:field.path,entry:field,value:draft[field.path],disabled:field.locked||!!busy,error:errors[field.path],onChange:value=>onDraft(field.path,value)}))):null,
        provider?h(ProviderCard,{provider,selected:true,states,draft,secrets,clears,errors,testing,busy,onDraft,onSecret,onClear,onSave,onTest}):null,
        provider?.generationFields?h(GenerationEditor,{provider,presets:section.presets,draft,busy,errors,onDraft}):null,
        !section.locked?h('div',{className:'cpxp-media-footer'},h('span',{className:'cpx-muted'},dirty?'有未保存的修改':'已保存'),h(ui.Button,{variant:'primary',disabled:!dirty||!!busy,loading:busy===`save:${section.id}`,onClick:()=>onSave(section.id)},'保存')):null):null);
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

    const validation = configBundle && configBundle.validation ? configBundle.validation : null;
    const seenSig = P.useRef('');
    const reseedPending = P.useRef(false);

    // 有未保存改动 = patch 非空。用它决定"重载能不能覆盖草稿"。
    const unsaved = view ? Object.keys(patchFrom(view, draft, secrets, clears)).length > 0 : false;

    /**
     * 服务器数据换了指纹时怎么处理草稿（2026-11-06 UI 审核 P2）：
     *   - 本地没有未保存改动 → 跟服务器走（首次加载、保存后重读）；
     *   - 有未保存改动 → **保留草稿**，只提示「服务器上的配置变了」，绝不静默覆盖；
     *   - 重新挂载（切页回来）且指纹一致 → 从模块级草稿缓存恢复。
     */
    P.useEffect(() => {
      if (!view) return;
      const sig = signatureOf(view);
      const hasLocalEdits = Object.keys(patchFrom(view, draft, secrets, clears)).length > 0;
      const cacheMatches = draftCache.sig === sig && draftCache.hasEdits === true;
      const decision = seedDecision({
        sig,
        seenSig: seenSig.current,
        hasLocalEdits,
        reseedPending: reseedPending.current,
        cacheMatches,
      });
      if (decision === 'keep') return;
      if (decision === 'keep-and-warn') {
        setFlash({
          tone: 'warn',
          title: '服务器上的配置变了，但你的草稿还在',
          text: '没有覆盖你正在编辑的内容。要放弃改动、以服务器为准，点「放弃未保存的改动」。',
        });
        return;
      }
      seenSig.current = sig;
      if (reseedPending.current) reseedPending.current = false;
      const restored = decision === 'restore-cache' ? draftCache : null;
      const nextDraft = restored ? restored.draft : draftFrom(view);
      const nextSecrets = restored ? restored.secrets : {};
      const nextClears = restored ? restored.clears : {};
      setDraft(nextDraft);
      setSecrets(nextSecrets);
      setClears(nextClears);
      setErrors({});
      draftCache.sig = sig;
      draftCache.draft = nextDraft;
      draftCache.secrets = nextSecrets;
      draftCache.clears = nextClears;
      draftCache.hasEdits = Boolean(restored);
    }, [view]);

    // 每次改动都镜像到模块级缓存：这样"切到别的页面再回来"能原样恢复。
    P.useEffect(() => {
      if (!view) return;
      draftCache.sig = signatureOf(view);
      draftCache.draft = draft;
      draftCache.secrets = secrets;
      draftCache.clears = clears;
      draftCache.hasEdits = Object.keys(patchFrom(view, draft, secrets, clears)).length > 0;
    }, [view, draft, secrets, clears]);

    /** 某个路径属于哪些 provider（改字段要让对应的测试结果失效）。 */
    const providerIdsFor = (path) => {
      const ids = [];
      if (!view) return ids;
      for (const section of view.sections) {
        if ((section.selector && section.selector.path === path) || (section.toggle && section.toggle.path === path)) {
          section.providers.forEach(provider => ids.push(provider.id));
          continue;
        }
        for (const provider of section.providers) {
          if (path === provider.prefix || String(path).startsWith(`${provider.prefix}.`)) ids.push(provider.id);
        }
      }
      return ids;
    };

    // P1：测试针对的是"已保存配置"。任何编辑都让旧结果失效，绝不留一个过期「测试通过」。
    const forgetTests = (ids) => {
      if (!ids || !ids.length) return;
      setTesting((previous) => {
        const next = { ...previous };
        let changed = false;
        ids.forEach((id) => { if (id in next) { delete next[id]; changed = true; } });
        return changed ? next : previous;
      });
    };

    const setSecret = (path, value) => {
      forgetTests(providerIdsFor(path));
      setSecrets(previous => ({ ...previous, [path]: value }));
    };

    /** 切换默认协议时，如果新协议还没配好，先把能力关掉——否则后端会以 400 拒绝整次保存。 */
    const setField = (path, value) => {
      if(path==='tts.providers.gpt-sovits.refAudioPath')setFieldDirect('tts.providers.gpt-sovits.mediaType','wav');
      forgetTests(providerIdsFor(path));
      setDraft(previous => ({ ...previous, [path]: value }));
      if (path === 'image.nai.transport') {
        if (value === 'official') setFieldDirect('image.nai.baseUrl','https://image.novelai.net');
        else if (draft['image.nai.baseUrl'] === 'https://image.novelai.net') setFieldDirect('image.nai.baseUrl','');
      }
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
    const setFieldDirect = (path, value) => {
      forgetTests(providerIdsFor(path));
      setDraft(previous => ({ ...previous, [path]: value }));
    };

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
      forgetTests(providerIdsFor(path));
      setClears(previous => ({ ...previous, [path]: !previous[path] }));
    };

    /** 放弃未保存的改动：回到服务器当前这一份（显式动作，不静默发生）。 */
    const discardDraft = () => {
      if (!view) return;
      const sig = signatureOf(view);
      const nextDraft = draftFrom(view);
      seenSig.current = sig;
      setDraft(nextDraft);
      setSecrets({});
      setClears({});
      setErrors({});
      setFlash({ tone: 'info', title: '已放弃未保存的改动', text: '表单回到已保存的那一份配置。' });
      draftCache.sig = sig;
      draftCache.draft = nextDraft;
      draftCache.secrets = {};
      draftCache.clears = {};
      draftCache.hasEdits = false;
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
        // 保存之后旧的测试结果一律作废（它们描述的是保存前的配置）。
        setTesting({});
        if (stillConfigured.length) {
          setFlash({
            tone: 'warn',
            title: `已保存 ${savedCount} 项，但清除没有生效`,
            text: '后端仍报告这些密钥处于配置状态。页面不会把"已清除"写在结果里——这需要媒体插件支持显式清除动作。',
          });
        } else {
          setFlash(null);
          if (typeof P.notice === 'function') P.notice('已保存', 'ok');
        }
        // 这次重读以服务器为准（允许覆盖草稿），因为改动刚刚落盘。
        reseedPending.current = true;
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
        if (typeof P.notice === 'function') P.notice(payload.ok === true ? '连接检查完成' : '测试失败', payload.ok === true ? 'ok' : 'danger');
      }, () => {
        setBusy('');
        setTesting(previous => ({ ...previous, [id]: { ok: false, detail: '网络请求没有完成' } }));
      });
    };

    const header = {
      key: 'media-settings',
      title: '媒体能力',
      hint: '',
      actions: [
        unsaved
          ? h(ui.Button, {
            key: 'discard',
            variant: 'ghost',
            size: 'sm',
            onClick: discardDraft,
            title: '丢掉未保存的改动，回到已保存的那一份配置',
          }, '放弃修改')
          : null,
        state.data ? h(ui.Button, {
          key: 'reload',
          variant: 'ghost',
          size: 'sm',
          onClick: state.reload,
          title: '重新读一遍页面描述与配置（不会发起任何测试或生成；未保存的改动不会被覆盖）',
        }, '刷新') : null,
      ].filter(Boolean),
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
        null);
    }
    if (!view) {
      return h(ui.Band, header,
        h(ui.Callout, { tone: state.error ? 'danger' : 'warn', title: '读不到媒体能力页面' },
          h('span', null, P.failText(state.error, '媒体接口没有返回页面描述或配置。'))),
        null);
    }

    const sectionNodes = [...view.sections].sort((a,b)=>(a.id==='vision'?1:b.id==='vision'?-1:0)).map(section => h('div', { key: `sec-wrap-${section.id}` },
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
      })));

    return h(ui.Band, header, [
      flash && flash.tone !== 'ok' ? h(ui.Callout, { key: 'flash', tone: flash.tone === 'ok' ? 'info' : flash.tone, title: flash.title }, h('span', null, flash.text)) : null,
      validation && validation.ok === false
        ? h(ui.Callout, { key: 'validation', tone: 'warn', title: '当前配置文件本身有校验问题' },
          h('ul', { className: 'cpxp-media-note' }, (validation.errors || []).slice(0, 6).map(item => h('li', { key: String(item.path || item.message) }, `${item.path || '$'}：${item.message || item.code || ''}`))))
        : null,
      h('div', { key: 'sections' }, sectionNodes),

    ]);
  }

/**
   * Standalone sidebar page. The settings form itself lives in MediaBand so the same component can
   * be rendered from a page (this wrapper) without duplicating any rendering logic.
   */
  function MediaPage() {
    return h('div', { className: 'cpxp-page cpx-media-page' }, h(MediaBand, {media:null}));
  }

  P.registerPage({ id: 'media', label: '媒体能力', order: 63, component: MediaPage });

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
    signatureOf,
    providerDirty,
    seedDecision,
    STATE_LABELS,
    STATE_TONES,
    MEDIA_BASE,
    ENABLE_SNIPPET,
  };
})(P);
