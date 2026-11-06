// 陪伴空间 · 设置（page id: settings）
//
// 读：GET settings（白名单 21 个可写字段 + 密钥是否已配置）、GET companion（角色 / 连接只读状态）。
// 写：POST settings（只收白名单字段；密钥只写不读）、POST settings/test（模型探测）、POST maintenance。
// 边界：接口永不回传密钥明文，本页也永不回显完整值；写入的是本机 memory.config.json，重启后生效。
(function (P) {
  const h = P.h;
  const ui = P.ui;
  const api = P.api;
  const fmt = P.fmt;
  const useState = P.useState;
  const useEffect = P.useEffect;

  // 页面自有样式只用 cpxp- 前缀，颜色一律走 alias / cpx token。
  P.css(`
.cpx-settings-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px; }
.cpx-settings-group { padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;min-width:0; }
.cpx-settings-group > .cpxp-set-sub {margin:0 0 14px;font-size:15px;color:var(--dsw-alias-label-primary);}
@media(max-width:900px){.cpx-settings-grid{grid-template-columns:1fr;}}
.cpxp-set-field { display: flex; flex-direction: column; gap: var(--cpx-s1, 4px); padding: var(--cpx-s3, 12px) 0; border-top: 1px solid var(--dsw-alias-border-l1); min-width: 0; }
.cpxp-set-field:first-child { border-top: 0; padding-top: 0; }
.cpxp-set-field[data-dirty="true"] { border-left: 2px solid var(--dsw-alias-brand-primary); padding-left: var(--cpx-s3, 12px); }
.cpxp-set-field[data-dirty="false"] { border-left: 0; padding-left: 0; }
.cpxp-set-inline { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cpx-s2, 8px); min-width: 0; }
.cpxp-set-inline > * { min-width: 0; max-width: 100%; }
.cpxp-set-disabled { opacity: .5; pointer-events: none; }
.cpxp-set-sub { margin: var(--cpx-s4, 16px) 0 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); font-weight: 600; letter-spacing: .04em; }
.cpxp-set-secret { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); }
.cpxp-set-secret[data-set="true"] { color: var(--dsw-alias-state-success-primary); }
.cpxp-set-secret[data-set="false"] { color: var(--dsw-alias-label-secondary); }
.cpxp-set-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; overflow-wrap: anywhere; word-break: break-all; }
.cpxp-set-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.7; overflow-wrap: anywhere; }
`);

  const text = value => (value === null || value === undefined ? '' : String(value));
  // 布尔值可能来自 JSON 的 true 或字符串 'true'（旧配置里两种都出现过）。
  const isOn = value => value === true || text(value) === 'true';
  // 失败原因统一带上后端错误码，排障时能对上。
  const failText = (error, fallback) => (typeof P.failText === 'function'
    ? P.failText(error, fallback || '未知错误')
    : (error && error.message ? error.message : (fallback || '未知错误')));

  // ---------------------------------------------------------------------------
  // 白名单字段：与 lib/write.mjs 的 SETTINGS_SPEC 一一对应，范围以源码为准。
  // section 决定它落在哪个分区；path 是 memory.config.json 里的真实写入路径。
  // ---------------------------------------------------------------------------
  const FIELDS = {
    extractionEnabled: {
      section: 'extract', label: '自动提炼记忆', control: 'toggle', path: 'extraction.enabled',
      hint: '会产生模型调用',
    },
    minMessages: {
      section: 'extract', label: '提炼批次阈值', control: 'integer', min: 2, max: 50, path: 'extraction.minMessages',
      hint: '',
    },
    semanticEnabled: {
      section: 'retrieval', label: '语义检索通道', control: 'toggle', path: 'retrieval.semanticEnabled',
      hint: '',
    },
    topK: {
      section: 'retrieval', label: '每轮召回条数', control: 'integer', min: 1, max: 20, path: 'retrieval.topK',
      hint: '',
    },
    budgetChars: {
      section: 'retrieval', label: '注入字符预算', control: 'integer', min: 400, max: 8000, path: 'injection.budgetChars',
      hint: '不是 token',
    },
    wikiAutoCompile: {
      section: 'wiki', label: '自动编译 Wiki', control: 'toggle', path: 'wiki.autoCompile',
      hint: '',
    },
    wikiMaxEntriesPerTopic: {
      section: 'wiki', label: '每主题条目上限', control: 'integer', min: 1, max: 2000, path: 'wiki.maxEntriesPerTopic',
      hint: '',
    },
    rrfK: {
      section: 'retrieval', label: 'RRF 常数', control: 'integer', min: 1, max: 120, path: 'retrieval.rrfK',
      hint: '',
    },
    mmrLambda: {
      section: 'retrieval', label: 'MMR λ', control: 'number', min: 0, max: 1, path: 'retrieval.mmrLambda',
      hint: '',
    },
    coverageFloor: {
      section: 'retrieval', label: '覆盖度门槛', control: 'number', min: 0, max: 1, path: 'retrieval.coverageFloor',
      hint: '',
    },
    embeddingProvider: {
      section: 'embedding', label: '向量提供器', control: 'select', path: 'embedding.provider',
      options: [
        { value: 'local', label: 'local（本地哈希，不联网）' },
        { value: 'remote', label: 'remote（远端模型）' },
        { value: 'off', label: 'off（关闭向量通道）' },
      ],
      hint: '远端失败自动降级',
    },
    embeddingBaseUrl: {
      section: 'embedding', label: '向量 API 地址', control: 'url', path: 'embedding.baseUrl',
      placeholder: 'https://api.siliconflow.cn/v1',
      hint: '可留空',
    },
    embeddingModel: {
      section: 'embedding', label: '向量模型名', control: 'text', path: 'embedding.model',
      placeholder: 'BAAI/bge-m3',
      hint: 'remote 必填',
    },
    embeddingDimensions: {
      section: 'embedding', label: '向量维度', control: 'integer', min: 64, max: 4096, path: 'embedding.dimensions',
      hint: '需与模型输出一致',
    },
    rerankEnabled: {
      section: 'rerank', label: '启用重排序', control: 'toggle', path: 'rerank.enabled',
      hint: '',
    },
    rerankBaseUrl: {
      section: 'rerank', label: '重排序 API 地址', control: 'url', path: 'rerank.baseUrl',
      placeholder: 'https://api.jina.ai/v1/rerank',
      hint: '',
    },
    rerankModel: {
      section: 'rerank', label: '重排序模型名', control: 'text', path: 'rerank.model',
      placeholder: 'jina-reranker-v2-base-multilingual',
      hint: '启用时必填',
    },
    rerankTimeoutMs: {
      section: 'rerank', label: '重排序超时（毫秒）', control: 'integer', min: 500, max: 30000, path: 'rerank.timeoutMs',
      hint: '超时放弃重排',
    },
    rerankTopN: {
      section: 'rerank', label: '重排候选上限', control: 'integer', min: 0, max: 50, path: 'rerank.topN',
      hint: '0 = 全部候选',
    },
    rerankBlend: {
      section: 'rerank', label: '重排权重 blend', control: 'number', min: 0, max: 1, path: 'rerank.blend',
      hint: '',
    },
    backend: {
      section: 'storage', label: '存储后端', control: 'select', path: 'backend',
      options: [
        { value: 'sqlite', label: 'sqlite（新记忆库）' },
        { value: 'legacy', label: 'legacy（旧 JSON 快照）' },
      ],
      hint: '回滚不同步新库内容',
    },
  };

  // 只写字段：POST 接受，GET 永不返回明文，界面也无法回填。
  const SECRET_LABELS = { embeddingApiKey: '向量模型 API Key', rerankApiKey: '重排序模型 API Key' };
  const API_KEY_MIN = 8;
  const API_KEY_MAX = 512;

  const THEME_OPTIONS = [
    { id: 'system', label: '跟随系统' },
    { id: 'light', label: '浅色' },
    { id: 'dark', label: '深色' },
  ];
  const THEME_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' };
  const SCHEME_LABELS = { light: '浅色', dark: '深色' };

  // 探测接口只回固定 code，不回服务端原文；这里逐条翻成人话。
  const PROBE_ERRORS = {
    'no-key': '还没有保存 API Key',
    'not-configured': '这项还没配置（缺地址或模型）',
    network: '网络不可达（检查代理或防火墙）',
    timeout: '请求超时',
    'http-401': '鉴权失败（401，key 可能无效）',
    'http-403': '没有权限（403）',
    'http-404': '接口不存在（404，检查地址是否需要带 /v1）',
    'http-4xx': '请求被拒绝（4xx）',
    'http-5xx': '服务端错误（5xx）',
    'bad-shape': '响应不是标准的 embeddings / rerank 结构',
    'dimension-mismatch': '返回维度与配置不一致',
    'empty-vectors': '返回了空向量',
  };

  const THEME_KEYS = ['system', 'light', 'dark'];

  // ---------------------------------------------------------------------------
  // 健康与睡眠：/api/companion-health/*（契约 §13）
  //
  // core.js 的 apiBase() 只指向 api/companion-memory/，所以这里照抄 pages-health.js
  // 顶部那套 fetch 语义（同源 cookie、no-store、信封解包、错误一律 ApiError）。
  // 两个片段互相不能 require，改动时两边要一起看。
  // ---------------------------------------------------------------------------
  const HEALTH_BASE = 'api/companion-health/';

  function healthBase() {
    try {
      return new URL(HEALTH_BASE, document.baseURI).href;
    } catch {
      return `/${HEALTH_BASE}`;
    }
  }

  function healthUrl(path, params) {
    let url = healthBase() + String(path || '').replace(/^\/+/, '');
    if (params) {
      const search = Object.keys(params)
        .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
        .join('&');
      if (search) url += (url.indexOf('?') >= 0 ? '&' : '?') + search;
    }
    return url;
  }

  const HEALTH_FAIL_FALLBACK = {
    'health-unavailable': '健康服务没有挂载到这个面板上。',
    'health-db-unavailable': '健康数据库还没打开，所以读不到数据。',
    'health-read-denied': '这项读取被授权开关挡下了。',
    'unsupported-action': '健康服务没有暴露这个动作。',
  };

  function healthError(apiError, errorCode) {
    const reason = errorCode == null ? '' : String(errorCode).trim();
    if (reason) apiError.errorCode = reason;
    return apiError;
  }

  /** 信封解包：§11 的只读失败也长成 {ok:false, code, message}，套在 data 里。 */
  function unwrapHealth(body, httpStatus) {
    if (!body || body.ok !== true) {
      const error = (body && body.error) || {};
      const code = error.code || 'unknown';
      const message = error.message || HEALTH_FAIL_FALLBACK[code] || `健康接口请求失败（HTTP ${httpStatus}）。`;
      throw healthError(new P.ApiError(message, httpStatus, code), error.errorCode);
    }
    const data = body.data;
    if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
      const code = data.code || 'unknown';
      throw healthError(
        new P.ApiError(data.message || HEALTH_FAIL_FALLBACK[code] || '健康服务没有给出原因。', httpStatus, code),
        data.errorCode,
      );
    }
    return data;
  }

  function healthRequest(path, options) {
    const settings = options || {};
    const hasBody = settings.body !== undefined;
    return fetch(healthUrl(path, settings.params), {
      method: settings.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(hasBody ? { body: JSON.stringify(settings.body) } : {}),
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
    }).then(
      response => response.json().then(
        body => unwrapHealth(body, response.status),
        () => { throw new P.ApiError(`健康接口返回不是 JSON（HTTP ${response.status}）。`, response.status, 'bad-response'); },
      ),
      () => { throw new P.ApiError('无法连接宿主（桌面可能已关闭）。', 0, 'network'); },
    );
  }

  const healthGet = (path, params) => healthRequest(path, { params });
  const healthPost = (path, body) => healthRequest(path, { method: 'POST', body: body || {} });

  /** 健康服务自己的授权表：只认布尔，读不到就是 null（未知），不猜。 */
  function consentOf(status, key) {
    const consents = status && status.consents && typeof status.consents === 'object' ? status.consents : null;
    if (!consents) return null;
    const value = consents[key];
    return value === true || value === false ? value : null;
  }

  const COLLECTOR_CONSENT = 'health.connect';
  const PULSE_CONSENT = 'health.pulse.live';
  const CARE_CONSENT = 'health.care.proactive';

  /**
   * 主题状态：偏好读 P.theme.preference()（与左栏那组三档开关同源），
   * 实际生效的配色交给 P.theme.dark()；读不到就降级为 null，不抛错。
   */
  function readTheme() {
    const themeApi = P.theme;
    let preference = null;
    if (themeApi && typeof themeApi.preference === 'function') {
      try {
        const value = themeApi.preference();
        if (typeof value === 'string' && THEME_KEYS.indexOf(value) >= 0) preference = value;
      } catch {
        preference = null;
      }
    }
    let scheme = null;
    if (themeApi && typeof themeApi.dark === 'function') {
      try { scheme = themeApi.dark() ? 'dark' : 'light'; } catch { scheme = null; }
    }
    if (!scheme) {
      const service = P.services && P.services.theme;
      if (service && typeof service.getTheme === 'function') {
        try {
          const snapshot = service.getTheme();
          const active = snapshot && snapshot.active && typeof snapshot.active === 'object' ? snapshot.active : null;
          if (active && typeof active.colorScheme === 'string') scheme = active.colorScheme;
        } catch {
          scheme = null;
        }
      }
    }
    if (!scheme && preference && preference !== 'system') scheme = preference;
    if (!scheme && typeof matchMedia === 'function') {
      try { scheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { scheme = null; }
    }
    return { preference, scheme };
  }

  /** 订阅宿主主题变化：左栏开关与本页共用同一个值，不各自维护状态。 */
  function useThemeState() {
    const [state, setState] = useState(readTheme);
    useEffect(() => {
      const themeApi = P.theme;
      if (!themeApi || typeof themeApi.subscribe !== 'function') return undefined;
      let unsubscribe = null;
      try {
        unsubscribe = themeApi.subscribe(() => setState(readTheme()));
      } catch {
        unsubscribe = null;
      }
      // 订阅建立后立刻对齐一次，别错过挂载与订阅之间的变化。
      setState(readTheme());
      return () => {
        if (typeof unsubscribe === 'function') {
          try { unsubscribe(); } catch { /* 退订失败不影响页面 */ }
        }
      };
    }, []);
    return [state, () => setState(readTheme())];
  }

  function probeText(target, payload) {
    const label = target === 'rerank' ? '重排序' : '向量';
    const data = payload && typeof payload === 'object' ? payload : {};
    if (data.ok !== false) {
      const bits = [`${label}端点正常`];
      const latency = Number(data.latencyMs);
      if (Number.isFinite(latency)) bits.push(`延迟 ${Math.round(latency)} ms`);
      if (data.model) bits.push(`模型 ${text(data.model)}`);
      const dimensions = Number(data.dimensions);
      if (Number.isFinite(dimensions) && dimensions > 0) bits.push(`维度 ${dimensions}`);
      return bits.join(' · ');
    }
    const code = text(data.error);
    const detail = PROBE_ERRORS[code] || (code ? `未知错误（${code}）` : '未知原因');
    const actual = Number(data.dimensions);
    if (code === 'dimension-mismatch' && Number.isFinite(actual) && actual > 0) {
      return `${label}端点连不上：${detail}。对方实际返回 ${actual} 维，把「向量维度」改成 ${actual} 再测一次。`;
    }
    return `${label}端点连不上：${detail}。`;
  }

  const MAINTENANCE_LABELS = { rebuild: '重建索引', integrity: '完整性检查', extract: '立即提炼' };

  function SettingsPage() {
    const notify = (message, tone) => {
      // 外壳只渲染 P.notice / P.toastOnce 推来的提示（ToastHost 挂在 Shell 上）。
      if (typeof P.notice === 'function') P.notice(message, tone || 'neutral');
    };
    const remote = P.useApi(() => api.get('settings'), []);
    const companion = P.useApi(() => api.get('companion'), []);

    const [draft, setDraft] = useState(null);
    const [dirty, setDirty] = useState([]);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState('');
    const [loadedAt, setLoadedAt] = useState(null);
    const [maint, setMaint] = useState(null);
    // 密钥只在浏览器内存里待一会儿：保存成功后立刻清空，绝不写进任何草稿对象。
    const [secretDraft, setSecretDraft] = useState({ embeddingApiKey: '', rerankApiKey: '' });
    const [secretBusy, setSecretBusy] = useState('');
    const [probe, setProbe] = useState(null);
    const [theme, refreshTheme] = useThemeState();
    // 健康与睡眠：真开关，读一次状态再渲染，写成功后回读（不做乐观置位）。
    const healthStatus = P.useApi(() => healthGet('status'), []);
    const healthCare = P.useApi(() => healthGet('care'), []);
    const [healthBusy, setHealthBusy] = useState('');
    const [healthNotice, setHealthNotice] = useState(null);

    const data = remote.data && typeof remote.data === 'object' ? remote.data : null;
    const editable = data && data.editable && typeof data.editable === 'object' ? data.editable : null;
    const keys = editable ? Object.keys(editable) : [];
    const secretsKeySet = {
      embeddingApiKey: Boolean(data && data.embeddingKeySet),
      rerankApiKey: Boolean(data && data.rerankKeySet),
    };

    // 数据到达（含保存后重新读取）时重建草稿并清空未保存标记。
    useEffect(() => {
      if (!editable) return;
      const next = {};
      for (const key of Object.keys(editable)) next[key] = editable[key];
      setDraft(next);
      setDirty([]);
      setLoadedAt(new Date().toISOString());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data]);

    const hasDirty = dirty.length > 0;
    const secretPending = Boolean(text(secretDraft.embeddingApiKey).trim() || text(secretDraft.rerankApiKey).trim());
    const locked = Boolean(busy);

    // 刷新 / 关闭窗口时拦一次：草稿和刚粘贴的密钥都还没落盘。
    useEffect(() => {
      if (!hasDirty && !secretPending) return undefined;
      const onBeforeUnload = event => {
        event.preventDefault();
        event.returnValue = '有还没保存的改动。';
        return '有还没保存的改动。';
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [hasDirty, secretPending]);

    const say = (tone, message) => {
      setNotice({ tone, message });
      if (tone === 'ok') notify(message, 'ok');
    };

    const fieldValue = key => {
      if (draft && Object.prototype.hasOwnProperty.call(draft, key)) return draft[key];
      if (editable && Object.prototype.hasOwnProperty.call(editable, key)) return editable[key];
      return '';
    };

    const setField = (key, value) => {
      setDraft(previous => {
        const next = { ...(previous || {}) };
        next[key] = value;
        return next;
      });
      setDirty(previous => (previous.indexOf(key) >= 0 ? previous : previous.concat(key)));
      setNotice(null);
    };

    const buildPatch = () => {
      const patch = {};
      const errors = [];
      for (const key of dirty) {
        // 只提交白名单里的键：本页没描述的字段永远不进 patch（也永远不会被整表覆盖）。
        const spec = FIELDS[key];
        if (!spec) continue;
        const raw = fieldValue(key);
        if (spec.control === 'toggle') {
          patch[key] = Boolean(raw);
          continue;
        }
        if (spec.control === 'select') {
          const fallback = spec.options && spec.options[0] ? spec.options[0].value : '';
          patch[key] = text(raw) || fallback;
          continue;
        }
        if (spec.control === 'integer' || spec.control === 'number') {
          const trimmed = text(raw).trim();
          if (!trimmed) {
            errors.push(`${spec.label} 不能为空`);
            continue;
          }
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed)) {
            errors.push(`${spec.label} 必须是数字`);
            continue;
          }
          if (spec.control === 'integer' && !Number.isInteger(parsed)) {
            errors.push(`${spec.label} 必须是整数`);
            continue;
          }
          if (spec.min !== undefined && parsed < spec.min) {
            errors.push(`${spec.label} 不能小于 ${spec.min}`);
            continue;
          }
          if (spec.max !== undefined && parsed > spec.max) {
            errors.push(`${spec.label} 不能大于 ${spec.max}`);
            continue;
          }
          patch[key] = parsed;
          continue;
        }
        const value = text(raw).trim();
        if (spec.control === 'url') {
          if (value.length > 500) {
            errors.push(`${spec.label} 太长了（最多 500 字符）`);
            continue;
          }
          if (value && !/^https?:\/\/\S+$/i.test(value)) {
            errors.push(`${spec.label} 必须以 http:// 或 https:// 开头，并且不含空格`);
            continue;
          }
          patch[key] = value;
          continue;
        }
        if (value.length > 200) {
          errors.push(`${spec.label} 太长了（最多 200 字符）`);
          continue;
        }
        patch[key] = value;
      }
      return { patch, errors };
    };

    // 后端会做同一组跨字段校验，这里先拦一次，省得白跑一趟。
    const crossChecks = () => {
      const problems = [];
      if (text(fieldValue('embeddingProvider')) === 'remote') {
        if (!text(fieldValue('embeddingBaseUrl')).trim()) problems.push('向量提供器选了 remote，必须填 API 地址');
        if (!text(fieldValue('embeddingModel')).trim()) problems.push('向量提供器选了 remote，必须填模型名');
      }
      if (isOn(fieldValue('rerankEnabled'))) {
        if (!text(fieldValue('rerankBaseUrl')).trim()) problems.push('启用重排序必须填 API 地址');
        if (!text(fieldValue('rerankModel')).trim()) problems.push('启用重排序必须填模型名');
      }
      return problems;
    };

    const save = () => {
      if (locked || !hasDirty) return;
      const built = buildPatch();
      if (built.errors.length) {
        setNotice({ tone: 'danger', message: `没有保存：${built.errors.join('；')}。改动都还留在页面上。` });
        return;
      }
      const problems = crossChecks();
      if (problems.length) {
        setNotice({ tone: 'danger', message: `没有保存：${problems.join('；')}。` });
        return;
      }
      const patch = built.patch;
      const currentBackend = text(editable && editable.backend);
      if (patch.backend === 'legacy' && currentBackend !== 'legacy') {
        const proceed = typeof P.confirm === 'function'
          ? P.confirm('确认把存储后端切回 legacy？\n\n新的 SQLite 记忆库里的记忆、修订与向量都不会同步回旧 JSON；切换后检索和提炼的结果都会变。建议先备份配置文件与记忆库文件。')
          : false;
        if (!proceed) return;
      }
      setBusy('save');
      setNotice(null);
      api.post('settings', { patch }).then(result => {
        if (result && result.ok === false) {
          setNotice({ tone: 'danger', message: `保存失败：${text(result.error || result.message) || '后端拒绝了这次写入'}。改动都还留在页面上。` });
          return;
        }
        const changed = result && Array.isArray(result.changed) ? result.changed : Object.keys(patch);
        const labels = changed.map(key => (FIELDS[key] ? FIELDS[key].label : text(key)));
        say('ok', `已写入 ${labels.length ? labels.join('、') : '（没有实际变化）'}；重启桌面后生效。`);
        remote.reload();
      }, error => {
        setNotice({
          tone: 'danger',
          message: `保存失败：${failText(error)}。改动都还留在页面上。`,
        });
      }).then(() => setBusy(''));
    };

    const reloadSafely = () => {
      if (hasDirty) {
        const proceed = typeof P.confirm === 'function'
          ? P.confirm('还有没保存的改动，重新读取会丢掉它们。继续？')
          : false;
        if (!proceed) return;
      }
      remote.reload();
    };

    const setSecretField = (field, value) => {
      setSecretDraft(previous => ({ ...previous, [field]: value }));
      setNotice(null);
    };

    // 密钥走单独的 patch：空串 = 不改，null = 清除；后端直接写 remote-models.json。
    const saveSecrets = entries => {
      if (locked || secretBusy) return;
      const patch = {};
      for (const [key, value] of Object.entries(entries || {})) {
        if (value === null) patch[key] = null;
        else if (typeof value === 'string' && value.trim()) patch[key] = value.trim();
      }
      if (!Object.keys(patch).length) {
        say('warn', '先在输入框里粘贴 API Key（留空不会提交）。');
        return;
      }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) continue;
        if (/\s/.test(value)) {
          setNotice({ tone: 'danger', message: `${SECRET_LABELS[key]} 不能包含空白字符。` });
          return;
        }
        if (value.length < API_KEY_MIN || value.length > API_KEY_MAX) {
          setNotice({ tone: 'danger', message: `${SECRET_LABELS[key]} 长度必须在 ${API_KEY_MIN}–${API_KEY_MAX} 之间。` });
          return;
        }
      }
      setSecretBusy('save');
      setNotice(null);
      api.post('settings', { patch }).then(result => {
        if (result && result.ok === false) {
          setNotice({ tone: 'danger', message: `密钥没存下：${text(result.error || result.message) || '后端拒绝了这次写入'}。` });
          return;
        }
        setSecretDraft({ embeddingApiKey: '', rerankApiKey: '' });
        say('ok', '密钥已写入本机的 remote-models.json；重启桌面后生效。');
        remote.reload();
      }, error => {
        setNotice({ tone: 'danger', message: `密钥没存下：${failText(error)}。` });
      }).then(() => setSecretBusy(''));
    };

    const clearSecret = (target, field) => {
      const proceed = typeof P.confirm === 'function'
        ? P.confirm(`清除${SECRET_LABELS[field]}？\n\n清除后远端${target === 'rerank' ? '重排序' : '向量'}调用会失败（降级或直接跳过），重启后生效。`)
        : false;
      if (proceed) saveSecrets({ [field]: null });
    };

    const canProbe = target => {
      const baseUrlKey = target === 'rerank' ? 'rerankBaseUrl' : 'embeddingBaseUrl';
      const modelKey = target === 'rerank' ? 'rerankModel' : 'embeddingModel';
      return Boolean(text(fieldValue(baseUrlKey)).trim() && text(fieldValue(modelKey)).trim());
    };

    // 探测带上当前草稿（含刚粘贴还没保存的 key），可以先测通再保存。
    const runProbe = target => {
      if (locked || secretBusy || (probe && probe.pending)) return;
      const numeric = key => {
        const parsed = Number(text(fieldValue(key)));
        return Number.isFinite(parsed) ? parsed : null;
      };
      const payload = {
        // 探测永远按远端端点跑：本地哈希向量没有可探测的网络地址。
        provider: 'remote',
        baseUrl: text(fieldValue(target === 'rerank' ? 'rerankBaseUrl' : 'embeddingBaseUrl')).trim(),
        model: text(fieldValue(target === 'rerank' ? 'rerankModel' : 'embeddingModel')).trim(),
      };
      if (target === 'embedding') {
        const dimensions = numeric('embeddingDimensions');
        if (dimensions) payload.dimensions = dimensions;
        const typed = text(secretDraft.embeddingApiKey).trim();
        if (typed) payload.apiKey = typed;
      } else {
        const timeoutMs = numeric('rerankTimeoutMs');
        if (timeoutMs) payload.timeoutMs = timeoutMs;
        const topN = numeric('rerankTopN');
        if (topN !== null) payload.topN = topN;
        const blend = numeric('rerankBlend');
        if (blend !== null) payload.blend = blend;
        const typed = text(secretDraft.rerankApiKey).trim();
        if (typed) payload.apiKey = typed;
      }
      setProbe({ target, pending: true, ok: null, text: '' });
      api.post('settings/test', { target, draft: payload }).then(result => {
        setProbe({ target, pending: false, ok: !(result && result.ok === false), text: probeText(target, result) });
      }, error => {
        setProbe({
          target,
          pending: false,
          ok: false,
          text: `探测没能完成：${failText(error)}。`,
        });
      });
    };

    // 维护动作直接作用于当前记忆库；失败原因原样显示，不做静默成功。
    const runMaintenance = action => {
      if (locked) return;
      setBusy(action);
      setMaint(null);
      setNotice(null);
      api.post('maintenance', { action }).then(result => {
        if (result && result.ok === false) {
          setMaint({ action, ok: false, message: text(result.error || result.message) || '后端拒绝了这次维护' });
          return;
        }
        setMaint({ action, ok: true, receipt: result && result.result ? result.result : result });
        say('ok', `${MAINTENANCE_LABELS[action] || action}完成。`);
      }, error => {
        setMaint({ action, ok: false, message: failText(error) });
      }).then(() => setBusy(''));
    };

    const confirmRebuild = () => {
      const proceed = typeof P.confirm === 'function'
        ? P.confirm('重建检索索引、补齐向量并重编译 Wiki？\n\n这会写入记忆库，期间检索结果可能短暂不完整；耗时随库大小增长。')
        : false;
      if (proceed) runMaintenance('rebuild');
    };

    const applyTheme = id => {
      const service = P.services && P.services.theme;
      if (!service || typeof service.setTheme !== 'function') return;
      let ok = false;
      try {
        // 优先走 P.theme.set：它同时写 localStorage 并通知订阅者，和左栏那组开关同源。
        ok = typeof P.theme.set === 'function' ? P.theme.set(id) : false;
        if (!ok) {
          service.setTheme(id);
          ok = true;
        }
      } catch (error) {
        refreshTheme();
        setNotice({ tone: 'danger', message: `切换外观失败：${P.failText(error, '宿主拒绝了这次切换')}` });
        return;
      }
      refreshTheme();
      if (ok) notify(`外观已切换为「${THEME_LABELS[id] || id}」。`, 'ok');
    };

    const goConnections = () => {
      const nav = P.nav;
      if (!nav || typeof nav.go !== 'function') return;
      try { nav.go('connections'); } catch { setNotice({ tone: 'danger', message: '外壳没有「连接与工具」页，暂时跳不过去。' }); }
    };

    // -- 表单控件 -------------------------------------------------------------

    const controlFor = key => {
      const spec = FIELDS[key];
      const value = fieldValue(key);
      if (spec.control === 'toggle') {
        return h(ui.Toggle, {
          checked: isOn(value),
          label: isOn(value) ? '已开启' : '已关闭',
          disabled: locked,
          onChange: next => setField(key, Boolean(next)),
        });
      }
      if (spec.control === 'select') {
        return h(ui.Select, {
          value: text(value),
          options: spec.options || [],
          disabled: locked,
          ariaLabel: spec.label,
          onChange: next => setField(key, text(next)),
        });
      }
      if (spec.control === 'integer' || spec.control === 'number') {
        return h(ui.Input, {
          type: 'number',
          min: spec.min, max: spec.max, step: spec.step ?? (spec.control === 'integer' ? 1 : 'any'),
          value: text(value),
          width: '140px',
          disabled: locked,
          ariaLabel: spec.label,
          onChange: next => setField(key, text(next)),
        });
      }
      return h(ui.Input, {
        value: text(value),
        placeholder: spec.placeholder || '',
        disabled: locked,
        ariaLabel: spec.label,
        onChange: next => setField(key, text(next)),
      });
    };

    const fieldRow = key => {
      const spec = FIELDS[key];
      const changed = dirty.indexOf(key) >= 0;
      return h('div', { key, className: 'cpxp-set-field', 'data-dirty': changed ? 'true' : 'false' },
        h(ui.Field, {
          label: spec.label,
          hint: changed ? (spec.hint ? `${spec.hint} · 未保存` : '未保存') : spec.hint,
        }, controlFor(key)));
    };

    // -- 密钥行 ---------------------------------------------------------------

    const secretRow = (target, field) => {
      const label = SECRET_LABELS[field];
      const isSet = secretsKeySet[field];
      const active = probe && probe.target === target ? probe : null;
      const draftValue = secretDraft[field] || '';
      const busyHere = Boolean(locked || secretBusy);
      return h('div', { key: `secret-${target}`, className: 'cpxp-set-field', 'data-dirty': 'false' },
        h(ui.Field, {
          label: `${label}（只写不读）`,
          hint: '密钥只存本机，接口只回「是否已配置」，界面不回显、不预填。',
        },
          h('div', { className: 'cpxp-set-inline' },
            h(ui.Input, {
              type: 'password',
              value: draftValue,
              width: '220px',
              placeholder: isSet ? '已配置（不显示内容）' : '粘贴 API Key',
              disabled: busyHere,
              ariaLabel: label,
              onChange: value => setSecretField(field, value),
              onEnter: () => saveSecrets({ [field]: draftValue }),
            }),
            h('span', { className: 'cpxp-set-secret', 'data-set': isSet ? 'true' : 'false' }, isSet ? '已配置' : '未配置'),
            h(ui.Button, {
              size: 'sm',
              disabled: busyHere || !text(draftValue).trim(),
              loading: secretBusy === 'save',
              onClick: () => saveSecrets({ [field]: draftValue }),
            }, '保存密钥'),
            isSet ? h(ui.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: busyHere,
              onClick: () => clearSecret(target, field),
            }, '清除') : null,
            h(ui.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: busyHere || (!canProbe(target) && !(active && active.pending)),
              loading: Boolean(active && active.pending),
              title: canProbe(target) ? '发一个最小的真实请求验证端点' : '先填好 API 地址与模型名才能测',
              onClick: () => runProbe(target),
            }, '测试连接'))),
        active && active.pending ? h('p', { className: 'cpxp-set-note' }, '正在测试连接…') : null,
        active && !active.pending
          ? h(ui.Callout, {
            tone: active.ok ? 'ok' : 'danger',
            title: active.ok ? '端点可用' : '端点没通过',
            action: h(ui.Button, { variant: 'ghost', size: 'sm', disabled: busyHere, onClick: () => runProbe(target) }, '再测一次'),
          }, active.text)
          : null);
    };

    // -- 分区 -----------------------------------------------------------------

    const renderAppearance = () => {
      const service = P.services && P.services.theme;
      const canSet = Boolean(service && typeof service.setTheme === 'function');
      // 每次渲染都从 P.theme 现读一次偏好：即使订阅链路出问题，切换页面回来也是对的。
      let preference = theme && theme.preference ? theme.preference : null;
      try {
        if (P.theme && typeof P.theme.preference === 'function') {
          const live = P.theme.preference();
          if (typeof live === 'string' && THEME_KEYS.indexOf(live) >= 0) preference = live;
        }
      } catch { /* 读不到就沿用订阅状态 */ }
      const scheme = theme && theme.scheme ? theme.scheme : null;
      const schemeText = SCHEME_LABELS[scheme] || '—';
      const currentText = preference
        ? (preference === 'system'
          ? `当前生效：${schemeText}（跟随系统）`
          : `当前生效：${schemeText}（手动固定）`)
        : '当前生效：读不到宿主主题状态。';
      const segmented = h(ui.Segmented, {
        options: THEME_OPTIONS,
        value: preference || 'system',
        label: '主题',
        onChange: canSet ? applyTheme : undefined,
      });
      return h(ui.Band, {
        title: '外观',
        hint: '不需要重启',
        children: [
          h(ui.Field, { key: 'theme', label: '主题', hint: currentText },
            canSet
              ? h('div', { className: 'cpxp-set-inline' }, segmented)
              : h('div', { className: 'cpxp-set-disabled', 'aria-disabled': 'true' }, segmented)),
          canSet
            ? null
            : h(ui.Callout, {
              key: 'theme-state',
              tone: 'warn',
              title: '宿主主题服务不可用，这组开关已禁用',
            }),
        ],
      });
    };

    const renderRole = () => {
      const companionData = companion.data && typeof companion.data === 'object' ? companion.data : null;
      const runtime = companionData && companionData.runtime && typeof companionData.runtime === 'object'
        ? companionData.runtime
        : null;
      const persona = companionData ? text(companionData.persona) : '';
      const runtimeKnown = Boolean(runtime);
      const available = runtime && runtime.available === true;
      return h(ui.Band, {
        title: '角色',
        hint: '只读',
        children: [
          companion.error
            ? h(ui.Callout, {
              key: 'role-error',
              tone: 'warn',
              title: '读不到角色状态',
              action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: companion.reload }, '重试'),
            }, companion.error instanceof Error ? companion.error.message : String(companion.error))
            : null,
          !companion.error && companion.loading && !companionData
            ? h(ui.Skeleton, { key: 'role-loading', rows: 2 })
            : null,
          h('div', { key: 'role', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, { label: '角色标识' },
              h('code', { className: 'cpxp-set-mono' }, persona || '—'))),
          h('div', { key: 'role-runtime', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, { label: '陪伴运行库' },
              h(ui.Badge, { tone: runtimeKnown ? (available ? 'ok' : 'warn') : 'neutral' },
                runtimeKnown ? (available ? '可读' : '不可读') : '未知'))),
        ],
      });
    };

    // -- 记忆与档案：21 个白名单键按六小组归位 --------------------------------

    const MEMORY_GROUPS = [
      { id: 'storage', title: '存储', keys: ['backend'] },
      { id: 'extract', title: '提炼', keys: ['extractionEnabled', 'minMessages'] },
      {
        id: 'retrieval',
        title: '检索',
        keys: ['semanticEnabled', 'topK', 'budgetChars', 'rrfK', 'mmrLambda', 'coverageFloor'],
      },
      { id: 'embedding', title: '向量（embedding）', keys: ['embeddingProvider', 'embeddingBaseUrl', 'embeddingModel', 'embeddingDimensions'] },
      {
        id: 'rerank',
        title: '重排（rerank）',
        keys: ['rerankEnabled', 'rerankBaseUrl', 'rerankModel', 'rerankTimeoutMs', 'rerankTopN', 'rerankBlend'],
      },
      { id: 'wiki', title: 'Wiki', keys: ['wikiAutoCompile', 'wikiMaxEntriesPerTopic'] },
    ];

    const renderMemoryArchive = () => {
      const known = Object.keys(FIELDS);
      const placed = [].concat(...MEMORY_GROUPS.map(group => group.keys));
      // 防御：真出现未归组的新白名单键，也别让它在页面上消失。
      const leftovers = known.filter(key => placed.indexOf(key) < 0);
      const groups = leftovers.length
        ? MEMORY_GROUPS.concat([{ id: 'other', title: '其它', keys: leftovers }])
        : MEMORY_GROUPS;
      return h(ui.Band, {
        title: '记忆与档案',
        hint: '重启后生效',
        children: h('div',{className:'cpx-settings-grid'},groups.map(group => h('section',{className:'cpx-settings-group',key:group.id},[
          h('p', { key: `mem-sub-${group.id}`, className: 'cpxp-set-sub' }, group.title),
          ...group.keys.map(fieldRow),
          group.id === 'embedding' ? secretRow('embedding', 'embeddingApiKey') : null,
          group.id === 'rerank' ? secretRow('rerank', 'rerankApiKey') : null,
        ].filter(Boolean)))),
      });
    };

    // -- 健康与睡眠：真开关（POST api/companion-health/*）---------------------

    const AUTH_LABELS = {
      valid: '鉴权有效',
      expiring: '即将过期',
      expired: '已过期',
      unknown: '未知',
      required: '需要重新授权',
    };

    const runHealth = (label, request, done) => {
      if (healthBusy) return;
      setHealthBusy(label);
      setHealthNotice(null);
      request().then(result => {
        setHealthNotice({ tone: 'ok', text: done ? done(result) : `${label}已完成。` });
        // 回读：以服务端为准，不做乐观置位。
        healthStatus.reload();
        healthCare.reload();
      }, error => {
        setHealthNotice({ tone: 'danger', text: `${label}没有成功：${failText(error)}` });
      }).then(() => setHealthBusy(''));
    };

    const renderHealthSection = () => {
      const status = healthStatus.data && typeof healthStatus.data === 'object' ? healthStatus.data : null;
      const care = healthCare.data && typeof healthCare.data === 'object' ? healthCare.data : null;
      const collectorOn = consentOf(status, COLLECTOR_CONSENT);
      const pulseOn = consentOf(status, PULSE_CONSENT);
      const careOn = consentOf(status, CARE_CONSENT);
      const collector = status && status.collector && typeof status.collector === 'object' ? status.collector : null;
      const source = status && status.source && typeof status.source === 'object' ? status.source : null;
      const auth = source && source.auth && typeof source.auth === 'object' ? source.auth : null;
      const reason = healthStatus.error ? failText(healthStatus.error) : '';
      const busyHere = Boolean(healthBusy);
      const switchable = !reason && !busyHere;
      const stateText = value => (value === true ? '已启用' : value === false ? '未启用' : '未知');

      return h(ui.Band, {
        title: '健康与睡眠',
        hint: '',
        children: [
          reason
            ? h(ui.Callout, {
              key: 'health-error',
              tone: 'warn',
              title: '读不到健康服务，开关先禁用',
              action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => { healthStatus.reload(); healthCare.reload(); } }, '重试'),
            }, reason)
            : null,
          healthNotice
            ? h(ui.Callout, {
              key: 'health-notice',
              tone: healthNotice.tone === 'danger' ? 'danger' : 'ok',
              title: healthNotice.tone === 'danger' ? '这一步没成功' : '已生效',
            }, healthNotice.text)
            : null,
          healthStatus.loading && !status
            ? h(ui.Skeleton, { key: 'health-loading', rows: 3 })
            : null,
          h('div', { key: 'health-collector', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, {
              label: '数据采集',
              hint: collector
                ? `配置：${stateText(collectorOn)} · 采集器：${collector.running === true ? '运行中' : '已停止'}`
                : `配置：${stateText(collectorOn)}`,
            },
            h(ui.Toggle, {
              checked: collectorOn === true,
              disabled: !switchable,
              label: '启用采集',
              onChange: next => runHealth(
                next ? '恢复采集' : '暂停采集',
                () => healthPost('maintenance', { action: next ? 'resume' : 'pause' }),
                () => (next ? '已恢复采集。' : '已暂停采集。'),
              ),
            }))),
          h('div', { key: 'health-pulse', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, { label: '实时心率读取', hint: `当前：${stateText(pulseOn)}` },
              h(ui.Toggle, {
                checked: pulseOn === true,
                disabled: !switchable,
                label: '允许读取实时心率',
                onChange: next => runHealth(
                  next ? '打开实时心率' : '关闭实时心率',
                  () => healthPost('pulse', { action: 'consent', consent: next === true }),
                  () => (next ? '已打开实时心率读取。' : '已关闭实时心率读取。'),
                ),
              }))),
          h('div', { key: 'health-care', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, { label: '主动关怀', hint: '这个开关没有写入接口，只能看' },
              h(ui.StateLine, {
                state: careOn === true ? 'ok' : careOn === false ? 'idle' : 'warn',
                text: stateText(careOn) + (care && care.enabled === true ? '（本轮已开启）' : ''),
              }))),
          h(ui.List, { key: 'health-readonly', label: '健康服务只读状态' }, [
            h(ui.Row, {
              key: 'health-source',
              title: '数据来源',
              meta: '配置文件里的 adapter 开关，本页只读',
              side: source
                ? h(ui.Badge, { tone: source.enabled === true ? 'ok' : 'neutral' }, text(source.displayName) || '—')
                : h(ui.Badge, { tone: 'neutral' }, '未知'),
            }),
            h(ui.Row, {
              key: 'health-auth',
              title: '云端鉴权',
              meta: '过期后需要重新授权',
              side: auth
                ? h(ui.Badge, { tone: auth.status === 'valid' ? 'ok' : auth.status === 'expired' ? 'danger' : 'warn' },
                  AUTH_LABELS[auth.status] || text(auth.status) || '未知')
                : h(ui.Badge, { tone: 'neutral' }, '未知'),
            }),
            h(ui.Row, {
              key: 'health-sync',
              title: '最近成功同步',
              meta: source && source.lastErrorCode ? `最近错误：${text(source.lastErrorCode)}` : '',
              side: source && source.lastSuccessAt
                ? h(ui.Timestamp, { at: source.lastSuccessAt })
                : h('span', { className: 'cpxp-set-note' }, '—'),
            }),
          ]),
        ],
      });
    };

    // -- 生活与运行库：只读（没有写入接口）-----------------------------------

    const renderConnections = () => {
      const companionData = companion.data && typeof companion.data === 'object' ? companion.data : null;
      const runtime = companionData && companionData.runtime && typeof companionData.runtime === 'object' ? companionData.runtime : null;
      const media = companionData && companionData.media && typeof companionData.media === 'object' ? companionData.media : null;
      const contact = companionData && companionData.contact && typeof companionData.contact === 'object' ? companionData.contact : null;
      const mediaRow = (key, label) => h(ui.Row, {
        key: `media-${key}`,
        title: label,
        side: media ? h(ui.Badge, { tone: media[key] ? 'ok' : 'neutral' }, media[key] ? '已启用' : '未启用') : h(ui.Badge, { tone: 'neutral' }, '未配置'),
      });
      const navReady = Boolean(P.nav && typeof P.nav.go === 'function');
      return h(ui.Band, {
        title: '连接与工具',
        hint: '只读，没有写入接口',
        actions: [
          h(ui.Button, {
            key: 'go-connections',
            variant: 'ghost',
            size: 'sm',
            disabled: !navReady,
            title: navReady ? '打开「连接与工具」（只读）' : '外壳还没提供导航服务',
            onClick: goConnections,
          }, '查看连接状态'),
        ],
        children: [
          h(ui.List, { key: 'media-list', label: '媒体能力' }, [
            mediaRow('enabled', '媒体总开关'),
            mediaRow('vision', '图片理解'),
            mediaRow('speech', '语音'),
            mediaRow('image', '生图'),
            mediaRow('screen', '屏幕'),
          ]),
          h(ui.List, { key: 'channel-list', label: '通道与桥接' }, [
            h(ui.Row, {
              key: 'bridge',
              title: '记忆桥接',
              meta: '配置开关，不代表正在同步',
              side: runtime
                ? h(ui.Badge, { tone: runtime.bridge ? 'ok' : 'neutral' }, runtime.bridge ? '已启用' : '未启用')
                : h(ui.Badge, { tone: 'neutral' }, '未知'),
            }),
            h(ui.Row, {
              key: 'qq',
              title: 'QQ 投递计数',
              meta: contact
                ? `今天已发 ${text(contact.sentToday) || '0'} 条 · 连续未回 ${text(contact.unanswered) || '0'} 次`
                : '还没有投递记录（通道可能未接入）',
              side: contact && contact.lastSentAt
                ? h(ui.Timestamp, { at: contact.lastSentAt, prefix: '最近 ' })
                : h('span', { className: 'cpxp-set-note' }, '—'),
            }),
          ]),
        ],
      });
    };

    const renderAdvanced = () => {
      const otherKeys = keys.filter(key => !Object.prototype.hasOwnProperty.call(FIELDS, key)
        && !Object.prototype.hasOwnProperty.call(SECRET_LABELS, key));
      const pathMap = Object.keys(FIELDS)
        .filter(key => typeof FIELDS[key].path === 'string')
        .map(key => `${key}  →  ${FIELDS[key].path}`)
        .join('\n');
      const rawEditable = editable ? JSON.stringify(editable, null, 2) : '—';
      const receipt = maint && maint.receipt ? maint.receipt : null;
      return h(ui.Band, {
        title: '高级',
        hint: '危险操作需确认',
        children: [
          h(ui.Diagnostic, {
            key: 'storage',
            title: '维护与原始配置',
            children: [
              h(ui.Toolbar, { key: 'maint', label: '维护动作' }, [
                h(ui.Button, {
                  key: 'rebuild',
                  variant: 'danger',
                  size: 'sm',
                  disabled: locked,
                  loading: busy === 'rebuild',
                  onClick: confirmRebuild,
                }, '重建索引'),
                h(ui.Button, {
                  key: 'integrity',
                  variant: 'ghost',
                  size: 'sm',
                  disabled: locked,
                  loading: busy === 'integrity',
                  onClick: () => runMaintenance('integrity'),
                }, '完整性检查'),
                h(ui.Button, {
                  key: 'extract',
                  variant: 'ghost',
                  size: 'sm',
                  disabled: true,
                  title: '提炼需要会话上下文：studio 里没有对话，后端会直接拒绝（bad-request）',
                }, '立即提炼（不可用）'),
              ]),
              maint && !maint.ok
                ? h(ui.Callout, {
                  key: 'maint-error',
                  tone: 'danger',
                  title: `${MAINTENANCE_LABELS[maint.action] || maint.action}失败`,
                  action: h(ui.Button, {
                    variant: 'ghost',
                    size: 'sm',
                    disabled: locked,
                    onClick: () => runMaintenance(maint.action),
                  }, '重试'),
                }, maint.message)
                : null,
              maint && maint.ok
                ? h(ui.Callout, { key: 'maint-ok', tone: 'ok', title: `${MAINTENANCE_LABELS[maint.action] || maint.action}完成` },
                  h(ui.Pre, { maxHeight: '220px' },
                    typeof receipt === 'string' ? receipt : JSON.stringify(receipt, null, 2)))
                : null,
            ],
          }),
          h(ui.Diagnostic, {
            key: 'paths',
            title: '配置文件与白名单',
            hint: '仅白名单可写',
            children: [
              h(ui.KeyValue, {
                key: 'config-kv',
                items: [
                  { k: '配置文件', v: text(data && data.configPath) || '（未返回）', mono: true, breakable: true },
                  { k: '当前运行后端', v: text(data && data.backend) || '—', mono: true },
                  { k: '可写字段', v: `${fmt.number(keys.length)} 个（白名单）` },
                  { k: '待保存', v: hasDirty ? `${fmt.number(dirty.length)} 项` : '无' },
                  { k: '密钥状态', v: `${secretsKeySet.embeddingApiKey ? '向量已配置' : '向量未配置'} · ${secretsKeySet.rerankApiKey ? '重排已配置' : '重排未配置'}` },
                ],
              }),
              h(ui.Pre, { key: 'path-map', maxHeight: '220px' }, pathMap),
              otherKeys.length
                ? h('div', { key: 'other-keys' },
                  h('p', { className: 'cpxp-set-note' }, '未描述的白名单键（只读）：'),
                  h(ui.KeyValue, {
                    items: otherKeys.map(key => ({
                      k: key,
                      v: text(fieldValue(key)) || '—',
                      mono: true,
                      breakable: true,
                    })),
                  }))
                : null,
              h(ui.Pre, { key: 'editable-raw', maxHeight: '260px' }, rawEditable),
            ],
          }),
          h(ui.Diagnostic, {
            key: 'boundary',
            title: '安全边界',
            children: [
              h('p', { key: 'boundary-text', className: 'cpxp-set-note' },
                '浏览器不接受 userId / personaId / worldId 参数，所有查询都按宿主绑定的 owner 视角执行；'
                + '本页不展示记忆正文，也没有导出原始数据库或备份路径的入口。'),
            ],
          }),
        ],
      });
    };

    // -- 组装 -----------------------------------------------------------------

    const pageStatus = data
      ? [
        h(ui.Timestamp, { key: 'at', at: loadedAt, prefix: '配置读取于 ' }),
        ` · ${hasDirty ? `未保存 ${dirty.length} 项` : '没有未保存改动'} · 运行后端 ${text(data.backend) || '—'}`,
      ]
      : '正在读取配置…';

    const headProps = {
      title: '设置',
      lead: '管理陪伴、记忆与服务偏好。',
      actions: [
        h(ui.Button, {
          key: 'save',
          variant: 'primary',
          onClick: save,
          disabled: !hasDirty || locked,
          loading: busy === 'save',
          title: hasDirty ? '把所有未保存项一次性写入本机配置' : '没有未保存的改动',
        }, hasDirty ? `保存 ${dirty.length} 项改动` : '没有待保存改动'),
        h(ui.Button, {
          key: 'reload',
          variant: 'ghost',
          onClick: reloadSafely,
          disabled: locked || Boolean(remote.loading && data),
          loading: Boolean(remote.loading && !data),
        }, '重新读取'),
      ],
      status: pageStatus,
    };

    if (remote.error && !data) {
      return h(ui.Page, headProps, h(ui.ErrorBox, { error: remote.error, onRetry: remote.reload }));
    }
    if (remote.loading && !data) {
      return h(ui.Page, headProps, h(ui.Skeleton, { rows: 8 }));
    }
    if (!data || !editable) {
      return h(ui.Page, headProps, h(ui.Empty, {
        title: '没有可编辑的配置',
        hint: '可写字段是空的，引擎可能还没初始化。',
        action: h(ui.Button, { variant: 'ghost', onClick: remote.reload }, '重新读取'),
      }));
    }

    return h(ui.Page, headProps,
      remote.error
        ? h(ui.Callout, {
          key: 'stale',
          tone: 'warn',
          title: '这次刷新失败，下面是上一次读到的配置',
          action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: remote.reload }, '重试'),
        }, remote.error instanceof Error ? remote.error.message : String(remote.error))
        : null,
      notice
        ? h(ui.Callout, {
          key: 'notice',
          tone: notice.tone,
          title: notice.tone === 'danger' ? '这一步没成功' : notice.tone === 'warn' ? '还差一步' : '已生效（重启后）',
        }, notice.message)
        : null,
      !hasDirty || data.restartRequiredHint === false
        ? null
        : h(ui.Callout, { key: 'restart', tone: 'info', title: '改动要重启桌面才生效' }, '保存成功不等于已生效。'),
      h(ui.RuntimeSettings),
      renderAppearance(),
      renderRole(),
      renderMemoryArchive(),
      renderHealthSection(),
      renderConnections(),
      renderAdvanced());
  }

  P.registerPage({ id: 'settings', label: '设置', order: 70, component: SettingsPage });
})(P);
