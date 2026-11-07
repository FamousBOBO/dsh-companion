// 健康与睡眠（page id: health，挂在「生活与日程」下面的二级 tab）
//
// 契约：design/health/INTERFACES.md —— §11 只读返回形状、§12 service、§13 Studio HTTP 路由、§15 禁止项。
//
// 这一页只回答四件事，页内用分段控件切成四段：
//   概览        今天的活动 / 心率 / 血氧 / 压力，每张卡都带样本时间与新鲜度；来源、设备与同步时间。
//   睡眠        最近主睡眠 + 阶段时间线 + 7/30 日趋势 + 午睡；没有就空态，绝不显示 0 小时。
//   活动与运动  日步数条形图（纯 CSS）+ 运动会话（原始 sportTypeRaw 与上游映射并列）。
//   关怀与证据  本轮只读占位：后端没有 health.care.* 代码路径，所以只写说明，不伪造候选、不做发送按钮。
//
// 数据只走 §13 的 6 条路由：GET {status,sources,today,trends,sleep} + POST {sync,maintenance}。
// 心跳共振（design/pulse-bond-20261103.md §7）另加一条：GET/POST api/companion-health/pulse
// —— 只喂「心跳 · 实时」这一张卡，秒级轮询并且只在卡片可见时进行。
// 不直连 8765 sidecar，不在浏览器里碰 token（同源 cookie 由宿主 Connection 认证）。
// 阈值只用于「新鲜度」这种产品参数，文案一律写明「产品参数，不是医学结论」。
(function (P) {
  const { h, ui } = P;

  P.css(`
    .cpxp-hl-stack { display:flex; flex-direction:column; gap:var(--cpx-s5,24px); min-width:0; }
    .cpxp-collector-row { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 18px; padding:10px 0; }
    .cpxp-collector-row + .cpxp-collector-row { border-top:1px solid var(--dsw-alias-border-l1); }
    .cpxp-collector-title { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .cpxp-hl-toolbar { display:flex; align-items:center; justify-content:space-between; gap:var(--cpx-s3,12px); flex-wrap:wrap; min-width:0; }
    .cpxp-hl-tools { display:flex; align-items:center; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; }
    .cpxp-hl-tools-label { color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); white-space:nowrap; }
    .cpxp-hl-note { margin:0; max-width:72ch; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); line-height:1.7; overflow-wrap:anywhere; }
    .cpxp-hl-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:var(--cpx-s3,12px); min-width:0; }
    .cpxp-hl-fresh { display:inline-flex; align-items:center; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; }
    .cpxp-hl-kv { display:flex; flex-direction:column; gap:2px; min-width:0; }
    .cpxp-hl-kv-row { display:flex; align-items:baseline; justify-content:space-between; gap:var(--cpx-s2,8px); min-width:0; font-variant-numeric:tabular-nums; }
    .cpxp-hl-kv-k { color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); white-space:nowrap; }
    .cpxp-hl-kv-v { font-weight:600; text-align:right; overflow-wrap:anywhere; min-width:0; }
    .cpxp-hl-kv-v[data-empty="true"] { font-weight:400; color:var(--dsw-alias-label-secondary, inherit); }
    .cpxp-hl-card-foot { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:var(--cpx-s2,8px); padding-top:6px; border-top:1px solid var(--dsw-alias-border-l1); min-width:0; }
    .cpxp-hl-stages { display:flex; align-items:stretch; gap:0; height:16px; border-radius:999px; overflow:hidden; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); min-width:0; }
    .cpxp-hl-stage { min-width:2px; }
    .cpxp-hl-stage[data-stage="deep"] { background:var(--dsw-alias-brand-primary); }
    .cpxp-hl-stage[data-stage="light"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, var(--dsw-alias-bg-layer-2)); }
    .cpxp-hl-stage[data-stage="rem"] { background:var(--dsw-alias-state-success-primary); }
    .cpxp-hl-stage[data-stage="awake"] { background:var(--dsw-alias-state-warn-primary); }
    .cpxp-hl-stage[data-stage="unknown"] { background:var(--dsw-alias-state-idle-primary); }
    .cpxp-hl-stage-gap { min-width:2px; background:repeating-linear-gradient(135deg, var(--dsw-alias-border-l1) 0 4px, transparent 4px 8px); }
    .cpxp-hl-legend { display:flex; flex-wrap:wrap; gap:2px 14px; margin:0; padding:0; list-style:none; min-width:0; }
    .cpxp-hl-legend-item { display:inline-flex; align-items:center; gap:6px; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); }
    .cpxp-hl-legend-dot { width:9px; height:9px; border-radius:2px; flex:none; border:1px solid var(--dsw-alias-border-l1); }
    .cpxp-hl-legend-dot[data-stage="deep"] { background:var(--dsw-alias-brand-primary); }
    .cpxp-hl-legend-dot[data-stage="light"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, var(--dsw-alias-bg-layer-2)); }
    .cpxp-hl-legend-dot[data-stage="rem"] { background:var(--dsw-alias-state-success-primary); }
    .cpxp-hl-legend-dot[data-stage="awake"] { background:var(--dsw-alias-state-warn-primary); }
    .cpxp-hl-legend-dot[data-stage="unknown"] { background:var(--dsw-alias-state-idle-primary); }
    .cpxp-hl-bars { display:flex; align-items:flex-end; justify-content:space-between; gap:3px; height:120px; padding-bottom:2px; border-bottom:1px solid var(--dsw-alias-border-l1); min-width:0; }
    .cpxp-hl-bar { flex:1 1 0; min-width:3px; max-width:40px; border-radius:2px 2px 0 0; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 82%, var(--dsw-alias-bg-layer-2)); }
    .cpxp-hl-bar[data-empty="true"] { background:transparent; border:1px dashed var(--dsw-alias-border-l2); border-bottom:0; border-radius:0; height:2px !important; }
    .cpxp-hl-bars-axis { display:flex; justify-content:space-between; gap:var(--cpx-s2,8px); color:var(--dsw-alias-label-secondary, inherit); font-size:11.5px; font-variant-numeric:tabular-nums; }
    .cpxp-hl-sleep-head { display:flex; align-items:baseline; gap:var(--cpx-s3,12px); flex-wrap:wrap; min-width:0; }
    .cpxp-hl-sleep-range { font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cpxp-hl-tag { display:inline-flex; align-items:center; gap:6px; padding:1px 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary, inherit); font-size:11.5px; white-space:nowrap; }
    .cpxp-hl-raw { font-family:var(--cpx-mono, monospace); font-size:11.5px; }
    /* 心跳 · 实时（契约 design/pulse-bond-20261103.md §7）：一张卡里只放现场读数与开关。 */
    .cpxp-pl-card { display:flex; flex-direction:column; gap:var(--cpx-s3,12px); min-width:0; }
    .cpxp-pl-top { display:flex; align-items:center; gap:var(--cpx-s3,12px); flex-wrap:wrap; min-width:0; }
    .cpxp-pl-bpm { display:flex; align-items:baseline; gap:6px; min-width:0; font-variant-numeric:tabular-nums; }
    .cpxp-pl-bpm-value { font-size:44px; line-height:1; font-weight:700; letter-spacing:-0.02em; }
    .cpxp-pl-bpm-value[data-empty="true"] { font-size:40px; font-weight:400; color:var(--dsw-alias-label-secondary, inherit); }
    .cpxp-pl-bpm-unit { color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); }
    .cpxp-pl-spark { flex:1 1 220px; min-width:150px; height:52px; display:flex; align-items:center; min-width:0; }
    .cpxp-pl-spark svg { display:block; width:100%; height:100%; }
    .cpxp-pl-kv { display:flex; flex-wrap:wrap; gap:2px 16px; min-width:0; font-variant-numeric:tabular-nums; }
    .cpxp-pl-kv-k { color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); margin-right:4px; }
    .cpxp-pl-zones { display:flex; flex-wrap:wrap; gap:6px; min-width:0; }
    .cpxp-pl-zone { display:inline-flex; align-items:center; gap:6px; padding:1px 9px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary, inherit); font-size:11.5px; white-space:nowrap; }
    .cpxp-pl-zone[data-active="true"] { color:inherit; border-color:currentColor; font-weight:600; }
    .cpxp-pl-zone-dot { width:9px; height:9px; border-radius:999px; flex:none; background:var(--dsw-alias-state-idle-primary); }
    .cpxp-pl-zone[data-zone="calm"] .cpxp-pl-zone-dot { background:var(--dsw-alias-state-success-primary); }
    .cpxp-pl-zone[data-zone="warming"] .cpxp-pl-zone-dot { background:var(--dsw-alias-state-warn-primary); }
    .cpxp-pl-zone[data-zone="racing"] .cpxp-pl-zone-dot { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 60%, var(--dsw-alias-state-warn-primary)); }
    .cpxp-pl-zone[data-zone="peak"] .cpxp-pl-zone-dot { background:var(--dsw-alias-state-error-primary); }
    .cpxp-pl-actions { display:flex; align-items:center; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; margin-top:var(--cpx-s2,8px); padding-top:8px; border-top:1px solid var(--dsw-alias-border-l1); }
    .cpxp-pl-consent { display:flex; flex-direction:column; gap:2px; min-width:0; margin-top:var(--cpx-s2,8px); }
    @media (max-width:760px) {
      .cpxp-hl-grid { grid-template-columns:1fr; }
      .cpxp-hl-bars { height:96px; }
      .cpxp-hl-tools { width:100%; }
      .cpxp-hl-tools .cpx-toolbar-right { width:100%; }
      .cpxp-pl-bpm-value { font-size:36px; }
      .cpxp-pl-spark { height:44px; }
    }
  `);

  // ---------------------------------------------------------------------------
  // 1. 取数：只走 §13 的六条路由，信封解包与 core.js 的 request() 完全一致
  // ---------------------------------------------------------------------------
  // core.js 的 apiBase() 写死在前缀 api/companion-memory/ 下，而健康路由挂在
  // api/companion-health/ 下；这一页片段没有 core.js 的写权限，所以在本地照抄同一套
  // fetch 语义（同源 cookie → credentials:'same-origin'、no-store、accept: json、
  // 信封 {ok,data,error} 解包、错误一律 ApiError）。不读、不传任何 token。
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
        .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
        .join('&');
      if (search) url += (url.indexOf('?') >= 0 ? '&' : '?') + search;
    }
    return url;
  }

  // §11：只读查询自己失败时也长成 {ok:false, code, message}，只是套在信封的 data 里。
  const FAIL_FALLBACK = {
    'health-unavailable': '健康服务没有挂载到这个面板上。',
    'health-db-unavailable': '健康数据库还没打开，所以读不到数据。',
    'health-read-denied': '这项读取被授权开关挡下了。',
  };

  function unwrap(body, httpStatus) {
    if (!body || body.ok !== true) {
      const error = (body && body.error) || {};
      const code = error.code || 'unknown';
      const message = error.message || FAIL_FALLBACK[code] || `健康接口请求失败（HTTP ${httpStatus}）。`;
      throw withErrorCode(new P.ApiError(message, httpStatus, code), error.errorCode);
    }
    const data = body.data;
    if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
      const code = data.code || 'unknown';
      throw withErrorCode(
        new P.ApiError(data.message || FAIL_FALLBACK[code] || '健康服务没有给出原因。', httpStatus, code),
        data.errorCode,
      );
    }
    return data;
  }

  /**
   * 信封里的 `errorCode` 是"同一类失败的原因"（例如 `pulse-unreachable` 下的
   * `device-not-found` / `connect-timeout`）：挂到 ApiError 上，页面才能说清该做什么。
   */
  function withErrorCode(apiError, errorCode) {
    const reason = errorCode == null ? '' : String(errorCode).trim();
    if (reason) apiError.errorCode = reason;
    return apiError;
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
      (response) => response.json().then(
        (body) => unwrap(body, response.status),
        () => { throw new P.ApiError(`健康接口返回不是 JSON（HTTP ${response.status}）。`, response.status, 'bad-response'); },
      ),
      () => { throw new P.ApiError('无法连接宿主（桌面可能已关闭）。', 0, 'network'); },
    );
  }

  const healthGet = (path, params) => healthRequest(path, { params });
  P.readPrivateHealthStatus = () => healthGet('status');
  const healthPost = (path, body) => healthRequest(path, { method: 'POST', body: body || {} });

  const settle = (promise) => promise.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );

  /** 一次读齐四段要用的东西；某一项失败只影响它自己那一块。 */
  function loadHealth(days) {
    return Promise.all([
      settle(healthGet('status')),
      settle(healthGet('sources')),
      settle(healthGet('today')),
      settle(healthGet('sleep', { days, includeStages: true })),
      settle(healthGet('trends', { metric: 'steps', days })),
      settle(healthGet('care')),
    ]).then(async ([status, sources, todayResult, sleep, steps, care]) => {
      let today = todayResult;
      // 跨过午夜后"今天"还没有任何上传（手环还没把新的一天交上去），四张卡会全空。
      // 这时改看**最近有数据的那一天**，并把"这是哪一天"带到界面上——绝不冒充今天。
      //
      // 那一天从哪里来：优先用服务端给的 `latestDataDate`（明确字段）；服务端若是旧版本，
      // 就退回到 `freshness.newestSampleAt` 的本地日期部分（ISO 带 +08:00，前 10 位就是本地日）。
      const value = today && today.value;
      if (value) {
        const noDayData = value.hasTodayData === false
          || (!value.activity && !Object.values(value.metrics || {}).some(item => item && typeof item === 'object'));
        const newest = value.freshness && typeof value.freshness.newestSampleAt === 'string'
          ? value.freshness.newestSampleAt.slice(0, 10)
          : null;
        const candidate = value.latestDataDate || newest;
        if (noDayData && candidate && candidate !== value.date && /^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
          const earlier = await settle(healthGet('today', { date: candidate }));
          if (earlier.value) {
            today = { value: { ...earlier.value, fallbackFrom: value.date }, error: null };
          }
        }
      }
      return { days, status, sources, today, sleep, steps, care };
    });
  }

  // ---------------------------------------------------------------------------
  // 2. 词表：英文枚举一律翻成中文；认不出来的原样显示，不猜
  // ---------------------------------------------------------------------------
  const DASH = '—';

  // §6 QUALITY：只读结果里能出现的质量词。
  const QUALITY_LABEL = {
    fresh: '新鲜',
    delayed: '有延迟',
    stale: '已过期',
    no_data: '暂无数据',
    unsupported: '来源不支持',
    auth_required: '需要重新授权',
    rate_limited: '被上游限流',
    error: '读取失败',
  };

  // §11.2 capabilities 每个能力的取值。
  const CAPABILITY_LABEL = {
    supported: '来源支持',
    no_data: '来源支持·暂无数据',
    unsupported: '来源不支持',
    auth_required: '需要重新授权',
    error: '读取失败',
  };
  const CAPABILITY_TONE = {
    supported: 'ok',
    no_data: 'idle',
    unsupported: 'idle',
    auth_required: 'warn',
    error: 'danger',
  };
  // 状态词已在右侧状态列里出现，meta 这里写"这意味着什么"，不复述一遍状态名。
  const CAPABILITY_NOTE = {
    supported: '来源声明支持这项能力',
    no_data: '来源支持这项，但这些天没有数据',
    unsupported: '来源没有这项能力，界面上不会假装有',
    auth_required: '需要重新授权才能读到',
    error: '上一次读取失败了',
  };

  // 新鲜度：分布只有四档，第四档表示"连样本时间都没有"，绝不当成新鲜。
  const FRESH_LABEL = { fresh: '新鲜', delayed: '有延迟', stale: '已过期', unknown: '时间未知' };
  const FRESH_TONE = { fresh: 'ok', delayed: 'warn', stale: 'danger', unknown: 'idle' };
  // 产品参数：不是医学阈值，只是"这条读数多久以前采的"。
  const FRESH_RULES = { freshMinutes: 120, delayedMinutes: 1440 };

  const AUTH_LABEL = { valid: '鉴权有效', expiring: '鉴权即将过期', expired: '鉴权已过期', unknown: '鉴权状态未知', required: '需要重新授权' };
  const AUTH_TONE = { valid: 'ok', expiring: 'warn', expired: 'danger', unknown: 'idle', required: 'warn' };

  const AVAILABILITY = {
    awaiting_first_night: {
      title: '等待首夜华为云记录',
      hint: '云侧还没有回传第一夜。',
    },
    no_data: {
      title: '暂无来源数据',
      hint: '可能没戴设备，或云端没有上传。',
    },
    partial: {
      title: '睡眠数据不完整',
      hint: '阶段或时长缺一部分，缺的留空。',
    },
    present: { title: '有睡眠记录', hint: '' },
  };

  const STAGE_LABEL = { deep: '深睡', light: '浅睡', rem: '快速眼动', awake: '清醒', unknown: '未知阶段' };
  const STAGE_ORDER = ['deep', 'light', 'rem', 'awake', 'unknown'];

  const STAGE_FIDELITY_LABEL = {
    exact: '阶段完整',
    partial: '阶段部分缺失',
    not_reliable: '阶段不可信',
    unknown: '阶段未知',
  };
  const SESSION_STATUS_LABEL = {
    confirmed: '会话已确认',
    lite: '轻量记录',
    provisional: '临时记录',
    aggregate_only: '只有聚合时长',
  };
  const SESSION_QUALITY_LABEL = {
    'origin-confirmed': '来源原始记录',
    'aggregate-only': '只有聚合时长',
    partial: '部分数据',
  };

  const SYNC_STATUS_LABEL = {
    ok: '同步完成',
    partial: '同步部分完成',
    error: '同步失败',
    rate_limited: '被上游限流',
    skipped: '这次没有真的同步',
  };

  const CAPABILITY_ROWS = [
    { key: 'activity', label: '活动（步数、距离、千卡）' },
    { key: 'sport', label: '运动（训练记录）' },
    { key: 'heart_rate', label: '心率' },
    { key: 'stress', label: '压力' },
    { key: 'spo2', label: '血氧' },
    { key: 'device', label: '设备' },
  ];

  // §10 CAPABILITIES：本轮只有前四项可能为 true，后四项没有任何代码路径能打开。
  const CONSENT_ROWS = [
    { key: 'health.connect', label: '连接华为云', note: '允许本地采集器向华为 CN 云拉取数据' },
    { key: 'health.read.on_demand', label: '按需读取', note: '模型工具可以现场读一次健康数据' },
    { key: 'health.dashboard', label: '界面展示', note: '这一页可以显示健康数据' },
    { key: 'health.sleep.read', label: '睡眠读取', note: '模型工具可以读睡眠会话' },
    { key: 'health.context.auto', label: '自动注入上下文', note: '本轮不可启用：没有注入代码路径' },
    { key: 'health.memory.habits', label: '写进长期记忆', note: '本轮不可启用：没有写入代码路径' },
    { key: 'health.schedule.adjust', label: '调整日程', note: '本轮不可启用：没有日程写入路径' },
    { key: 'health.care.proactive', label: '主动健康关怀', note: '本轮不可启用：等 P2.5 QQ 回执与授权确认' },
    { key: 'health.export', label: '导出', note: '默认关闭，本页不提供入口' },
    { key: 'health.delete', label: '删除', note: '默认关闭，本页不提供入口' },
  ];

  // ---------------------------------------------------------------------------
  // 3. 小工具
  // ---------------------------------------------------------------------------
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);

  function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const at = Date.parse(String(value));
    return Number.isNaN(at) ? null : at;
  }

  /** 时长：null / 非数字一律破折号；0 照实写 0 分钟（真 0 与没测到不是一回事）。 */
  function durationText(minutes) {
    if (!finite(minutes) || minutes < 0) return DASH;
    const total = Math.round(minutes);
    if (total < 60) return `${total} 分钟`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }

  function stepsText(value) {
    if (!finite(value)) return DASH;
    return `${Math.round(value)} 步`;
  }

  function distanceText(meters) {
    if (!finite(meters)) return DASH;
    if (meters >= 1000) return `${(meters / 1000).toFixed(2)} 公里`;
    return `${Math.round(meters)} 米`;
  }

  function bpmText(value) {
    return finite(value) ? `${Math.round(value)} bpm` : DASH;
  }

  function percentText(value) {
    return finite(value) ? `${Math.round(value * 10) / 10}%` : DASH;
  }

  function scoreText(value) {
    return finite(value) ? String(Math.round(value * 10) / 10) : DASH;
  }

  /** 新鲜度只根据样本时间算，算不出来就是 unknown —— 不拿"看起来还行"代替。 */
  function freshnessOf(sampleAt, nowMs) {
    const at = toMs(sampleAt);
    if (at === null) return { status: 'unknown', ageMinutes: null };
    const ageMinutes = Math.max(0, Math.round((nowMs - at) / 60000));
    if (ageMinutes <= FRESH_RULES.freshMinutes) return { status: 'fresh', ageMinutes };
    if (ageMinutes <= FRESH_RULES.delayedMinutes) return { status: 'delayed', ageMinutes };
    return { status: 'stale', ageMinutes };
  }

  function freshnessChip(sampleAt, nowMs, prefix) {
    const fresh = freshnessOf(sampleAt, nowMs);
    return h('span', { className: 'cpxp-hl-fresh', title: `freshness=${fresh.status}（产品参数，不是医学结论）` },
      h(ui.StateLine, { state: FRESH_TONE[fresh.status], text: FRESH_LABEL[fresh.status] }),
      sampleAt
        ? h(ui.Timestamp, { at: sampleAt, prefix: prefix || '样本' })
        : h('span', { className: 'cpxp-hl-note' }, `${prefix || '样本'}时间未提供`));
  }

  const isUnavailable = (error) => Boolean(error) && (
    String(error.code || '') === 'health-unavailable'
    || String(error.code || '') === 'health-db-unavailable'
    || Number(error.status) === 404
  );

  function readError(error, label) {
    return h(ui.Callout, {
      tone: 'danger',
      title: `读不到${label}`,
      action: null,
    }, h('span', null, P.failText(error, '健康服务没有返回可用数据。')));
  }

  /** 一行指标；没有读数就写「—」，并保留"缺测"的说法。 */
  function kvRow(label, value, empty) {
    return h('div', { className: 'cpxp-hl-kv-row' },
      h('span', { className: 'cpxp-hl-kv-k' }, label),
      h('span', { className: 'cpxp-hl-kv-v', 'data-empty': empty ? 'true' : undefined }, value));
  }

  // ---------------------------------------------------------------------------
  // 4. 图：阶段时间线与日条形图都是内联 SVG / 纯 CSS，不引第三方库
  // ---------------------------------------------------------------------------
  function stageMinutes(stages) {
    const totals = {};
    stages.forEach((stage) => {
      const key = STAGE_ORDER.indexOf(stage.stage) >= 0 ? stage.stage : 'unknown';
      const from = toMs(stage.startAt);
      const to = toMs(stage.endAt);
      if (from === null || to === null || to <= from) return;
      totals[key] = (totals[key] || 0) + (to - from);
    });
    return totals;
  }

  /** 阶段横向时间线：宽度按真实时长分配，未覆盖的时段画成斜纹，绝不补 unknown。 */
  function StageTimeline({ session }) {
    const start = toMs(session && session.startAt);
    const end = toMs(session && session.endAt);
    const raw = Array.isArray(session && session.stages) ? session.stages : [];
    if (start === null || end === null || end <= start) return null;
    const stages = raw.map((stage) => ({
      stage: stage && stage.stage,
      from: toMs(stage && stage.startAt),
      to: toMs(stage && stage.endAt),
    })).filter((stage) => stage.from !== null && stage.to !== null && stage.to > stage.from);
    if (!stages.length) return null;

    const total = end - start;
    let covered = 0;
    const blocks = stages.map((stage, index) => {
      const span = Math.max(0, Math.min(stage.to, end) - Math.max(stage.from, start));
      covered += span;
      return h('span', {
        key: `s${index}`,
        className: 'cpxp-hl-stage',
        'data-stage': STAGE_ORDER.indexOf(stage.stage) >= 0 ? stage.stage : 'unknown',
        style: { flexGrow: String(Math.max(span, 1)) },
        title: `${STAGE_LABEL[stage.stage] || '未知阶段'} · ${P.fmt.clock(stage.from)}–${P.fmt.clock(stage.to)}`,
      });
    });
    const uncovered = Math.max(0, total - covered);
    if (uncovered > 0) {
      blocks.push(h('span', {
        key: 'gap',
        className: 'cpxp-hl-stage-gap',
        style: { flexGrow: String(Math.max(uncovered, 1)) },
        title: `无阶段数据 · ${Math.round(uncovered / 60000)} 分钟`,
      }));
    }

    const totals = stageMinutes(stages.map((stage) => ({
      stage: stage.stage,
      startAt: stage.from,
      endAt: stage.to,
    })));
    const legend = STAGE_ORDER.filter((key) => totals[key]).map((key) => h('li', {
      key: `lg-${key}`,
      className: 'cpxp-hl-legend-item',
    },
    h('span', { className: 'cpxp-hl-legend-dot', 'data-stage': key }),
    `${STAGE_LABEL[key]} ${durationText(totals[key] / 60000)}`));

    const summary = STAGE_ORDER.filter((key) => totals[key])
      .map((key) => `${STAGE_LABEL[key]} ${Math.round(totals[key] / 60000)} 分钟`)
      .join('，');
    // 覆盖率只算来源真的画出来的部分；没覆盖的时段留成斜纹，不补 unknown。
    const coverage = total > 0 ? Math.round((Math.min(covered, total) / total) * 100) : 0;

    return h(P.Fragment, null,
      h('div', { className: 'cpxp-hl-stages', role: 'img', 'aria-label': `睡眠阶段时间线：${summary || '没有可用阶段'}` }, blocks),
      h('p', { className: 'cpxp-hl-note' },
        `${P.fmt.range(session.startAt, session.endAt)} · 阶段覆盖 ${coverage}%`,
        coverage < 100 ? '（未覆盖处画斜纹）' : ''),
      legend.length ? h('ul', { className: 'cpxp-hl-legend' }, legend) : null);
  }

  /** 日条形图：value=null 的日子画成虚线小刻度，表示"缺测"而不是 0。 */
  function TrendBars({ points, label, unit, format }) {
    const list = Array.isArray(points) ? points : [];
    if (!list.length) return null;
    const values = list.map((point) => (finite(point && point.value) ? point.value : null));
    const known = values.filter((value) => value !== null);
    const max = known.length ? Math.max(...known) : 0;
    const scale = max > 0 ? max : 1;
    const fmt = format || ((value) => String(value));

    const bars = list.map((point, index) => {
      const value = values[index];
      const height = value === null ? 2 : Math.max(2, Math.round((value / scale) * 100));
      return h('span', {
        key: point && point.date ? point.date : `b${index}`,
        className: 'cpxp-hl-bar',
        'data-empty': value === null ? 'true' : undefined,
        style: { height: `${height}%` },
        title: `${(point && point.date) || DASH} · ${value === null ? '缺测' : fmt(value)}`,
      });
    });

    const first = list[0] && list[0].date;
    const last = list[list.length - 1] && list[list.length - 1].date;

    return h(P.Fragment, null,
      h('div', {
        className: 'cpxp-hl-bars',
        role: 'img',
        'aria-label': `${label}：${known.length ? `最高 ${fmt(max)}${unit || ''}` : '这段时间没有可用的读数'}`,
      }, bars),
      h('div', { className: 'cpxp-hl-bars-axis' },
        h('span', null, first ? String(first).slice(5) : DASH),
        h('span', null, known.length ? `最高 ${fmt(max)}${unit || ''} · ${known.length}/${list.length} 天有读数` : '全部缺测'),
        h('span', null, last ? String(last).slice(5) : DASH)));
  }

  // ---------------------------------------------------------------------------
  // 5. 段一：概览
  // ---------------------------------------------------------------------------
  function sampleOf(today, kind) {
    const realtime = today && today.realtime ? today.realtime[kind] : null;
    if (realtime && realtime.at) return { at: realtime.at, kind: 'realtime' };
    const fresh = today && today.freshness ? today.freshness : null;
    if (fresh && fresh.newestSampleAt) return { at: fresh.newestSampleAt, kind: 'newest' };
    return { at: null, kind: 'none' };
  }

  function metricCard(config) {
    const sample = config.sample;
    return h(ui.Card, {
      key: config.key,
      title: config.title,
      hint: config.hint,
    },
    h('div', { className: 'cpxp-hl-kv' }, config.rows),
    h('div', { className: 'cpxp-hl-card-foot' },
      freshnessChip(sample ? sample.at : null, config.nowMs,
        sample && sample.kind === 'newest' ? '来源最新' : '样本')));
  }

  function overviewSection(ctx) {
    const { today, status, sources, nowMs, days, bundle } = ctx;
    if (!today) {
      return h('div', { className: 'cpxp-hl-stack' },
        pulseBand(pulseConsentOf(status), ctx.onStatusReload),
        readError(bundle.today.error, '今天的活动与指标'));
    }

    const activity = today.activity || null;
    const metrics = today.metrics || {};
    const realtime = today.realtime || {};
    const heart = metrics.heartRate || null;
    const stress = metrics.stress || null;
    const spo2 = metrics.spo2 || null;
    const intensity = metrics.intensity || null;

    const activityRows = [
      kvRow('步数', activity && finite(activity.steps) ? stepsText(activity.steps) : '无可用记录', !(activity && finite(activity.steps))),
      kvRow('距离', activity && finite(activity.distanceM) ? distanceText(activity.distanceM) : '无可用记录', !(activity && finite(activity.distanceM))),
      kvRow('千卡', activity && finite(activity.kcal) ? `${Math.round(activity.kcal)} 千卡` : '无可用记录', !(activity && finite(activity.kcal))),
      kvRow('中高强度', intensity && finite(intensity.moderateHighMinutes)
        ? `${Math.round(intensity.moderateHighMinutes)} 分钟`
        : '无可用记录',
      !(intensity && finite(intensity.moderateHighMinutes))),
    ];

    const heartRows = [
      kvRow('最近', realtime.heartRate && finite(realtime.heartRate.value) ? bpmText(realtime.heartRate.value) : DASH,
        !(realtime.heartRate && finite(realtime.heartRate.value))),
      kvRow('最高', heart && finite(heart.max) ? bpmText(heart.max) : DASH, !(heart && finite(heart.max))),
      kvRow('最低', heart && finite(heart.min) ? bpmText(heart.min) : DASH, !(heart && finite(heart.min))),
      kvRow('静息', heart && finite(heart.resting) ? bpmText(heart.resting) : DASH, !(heart && finite(heart.resting))),
    ];

    const spo2Rows = [
      kvRow('平均', spo2 && finite(spo2.avg) ? percentText(spo2.avg) : DASH, !(spo2 && finite(spo2.avg))),
      kvRow('最低', spo2 && finite(spo2.min) ? percentText(spo2.min) : DASH, !(spo2 && finite(spo2.min))),
      kvRow('最高', spo2 && finite(spo2.max) ? percentText(spo2.max) : DASH, !(spo2 && finite(spo2.max))),
      kvRow('最近', realtime.spo2 && finite(realtime.spo2.value) ? percentText(realtime.spo2.value) : DASH,
        !(realtime.spo2 && finite(realtime.spo2.value))),
    ];

    const stressRows = [
      kvRow('平均', stress && finite(stress.avg) ? String(Math.round(stress.avg)) : DASH, !(stress && finite(stress.avg))),
      kvRow('最高', stress && finite(stress.max) ? String(Math.round(stress.max)) : DASH, !(stress && finite(stress.max))),
      kvRow('最低', stress && finite(stress.min) ? String(Math.round(stress.min)) : DASH, !(stress && finite(stress.min))),
      kvRow('最近', stress && finite(stress.last) ? String(Math.round(stress.last)) : DASH, !(stress && finite(stress.last))),
    ];

    const source = status && status.source ? status.source : null;
    const collector = status && status.collector ? status.collector : null;
    const db = status && status.db ? status.db : null;
    const auth = source && source.auth ? source.auth : null;
    const sourceList = Array.isArray(sources) ? sources : [];
    const notes = sourceList.reduce((all, item) => all.concat(Array.isArray(item && item.notes) ? item.notes : []), []);

    const sourceRows = [
      h(ui.Row, {
        key: 'devices',
        title: '设备',
        meta: db && finite(db.devices)
          ? `已登记 ${db.devices} 台 · 云端清单没有"在线/离线"字段，所以这里只能说登记了多少台`
          : '还没有读到设备清单',
        status: h(ui.StateLine, { state: db && finite(db.devices) ? 'ok' : 'idle', text: db && finite(db.devices) ? '已读取' : '未知' }),
      }),
      h(ui.Row, {
        key: 'sync',
        title: '最后同步',
        meta: '采集器最近一次从华为 CN 云拿到数据的时间',
        side: source && source.lastSuccessAt ? h(ui.Timestamp, { at: source.lastSuccessAt }) : '还没成功过',
      }),
      h(ui.Row, {
        key: 'auth',
        title: '鉴权',
        meta: auth && finite(auth.minutesLeft) ? `剩余约 ${Math.max(0, Math.round(auth.minutesLeft))} 分钟` : '来源没有给出剩余时间',
        status: h(ui.StateLine, {
          state: auth ? (AUTH_TONE[auth.status] || 'idle') : 'idle',
          text: auth ? (AUTH_LABEL[auth.status] || String(auth.status)) : '未知',
        }),
      }),
      h(ui.Row, {
        key: 'poll',
        title: '采集节奏',
        meta: collector
          ? `本地采集器每 ${collector.pollMinutes ?? DASH} 分钟一轮，窗口 ${collector.windowDays ?? DASH} 天；单飞运行`
          : '还没读到采集器状态',
        status: collector
          ? h(ui.StateLine, {
            state: collector.rateLimitedUntil ? 'warn' : collector.running ? 'live' : 'idle',
            text: collector.rateLimitedUntil ? '被限流中' : collector.running ? '在运行' : '未运行',
          })
          : h(ui.StateLine, { state: 'idle', text: '未知' }),
      }),
    ];

    return h('div', { className: 'cpxp-hl-stack' },
      // 心跳实时卡排在最前面：这一页第一眼应该看到他"现在"在跳。
      pulseBand(pulseConsentOf(status), ctx.onStatusReload),

      // 跨午夜时"今天"是空的：说清楚现在显示的是哪一天，而不是让四张卡空着让人以为坏了。
      today.fallbackFrom
        ? h(ui.Callout, { tone: 'info', title: `今天（${today.fallbackFrom}）还没有上传数据` },
          h('span', null, `下面显示的是 ${today.date} 的数据。`,
            h(ui.Info, { text: `华为云端最后一次同步到的那一天；今天一旦有新上传，这里会自动切回今天。睡眠与趋势不受影响。` })))
        : null,

      h(ui.Callout, { tone: 'info', title: '数据来自华为运动健康（CN 云）' },
        h('span', null, '设备上报什么就显示什么。',
          h(ui.Info, { text: `这些是设备/云端上报的指标，不是医学结论；来源没给的部分留空，不补值。每张卡的「新鲜」只表示这条读数多久以前采的：${FRESH_RULES.freshMinutes} 分钟内为新鲜，1 天内为有延迟，更久为已过期（产品参数）。` }))),

      h('div', { className: 'cpxp-hl-grid' },
        metricCard({
          key: 'activity',
          title: '活动',
          hint: activity && activity.observedAt ? `观测于 ${P.fmt.dateTime(activity.observedAt)}` : '今天还没有活动读数',
          sample: { at: activity ? activity.observedAt : null, kind: 'realtime' },
          nowMs,
          rows: activityRows,
        }),
        metricCard({
          key: 'heart',
          title: '心率',
          hint: '最近值来自云端最后上传',
          sample: sampleOf(today, 'heartRate'),
          nowMs,
          rows: heartRows,
        }),
        metricCard({
          key: 'spo2',
          title: '血氧',
          hint: '日均 / 最低 / 最高',
          sample: sampleOf(today, 'spo2'),
          nowMs,
          rows: spo2Rows,
        }),
        metricCard({
          key: 'stress',
          title: '压力',
          hint: '均值 / 最高 / 最低 / 最近',
          sample: sampleOf(today, 'stress'),
          nowMs,
          rows: stressRows,
        })),

      h(ui.Band, {
        title: '来源与同步',
        info: '只读：设备清单、鉴权与采集节奏都来自 status，不在这里改。',
        flush: true,
      }, h(ui.List, { label: '来源与同步状态' }, sourceRows)),

      notes.length
        ? h(ui.Callout, { tone: 'warn', title: '来源自己说明了为什么缺数据' },
          h('ul', { className: 'cpxp-hl-note' }, notes.map((note, index) => h('li', { key: `n${index}` }, String(note)))))
        : null,

      h(ui.Diagnostic, { title: '高级诊断', hint: 'status / sources 原始字段，只用于排查。' },
        h(ui.KeyValue, {
          items: [
            { k: 'status.schemaVersion', v: status ? status.schemaVersion : DASH, mono: true },
            { k: 'collector.baseUrl', v: collector && collector.baseUrl ? collector.baseUrl : DASH, mono: true },
            { k: 'collector.lastRunAt', v: collector && collector.lastRunAt ? collector.lastRunAt : DASH, mono: true },
            { k: 'collector.nextAllowedAt', v: collector && collector.nextAllowedAt ? collector.nextAllowedAt : DASH, mono: true },
            { k: 'source.lastErrorCode', v: source && source.lastErrorCode ? source.lastErrorCode : DASH, mono: true },
            { k: 'source.freshness', v: source && source.freshness ? `${source.freshness.status}（${source.freshness.ageMinutes ?? DASH} 分钟）` : DASH, mono: true },
            { k: 'db.observations / sleepSessions', v: db ? `${db.observations ?? DASH} / ${db.sleepSessions ?? DASH}` : DASH, mono: true },
            { k: 'today.date', v: today && today.date ? today.date : DASH, mono: true },
            { k: 'today.freshness', v: today && today.freshness ? `${today.freshness.status}（${today.freshness.ageMinutes ?? DASH} 分钟）` : DASH, mono: true },
            { k: '天数窗口', v: `${days} 天`, mono: true },
          ],
        })));
  }

  // ---------------------------------------------------------------------------
  // 5b. 心跳 · 实时（契约 design/pulse-bond-20261103.md §7）
  //
  // 这一张卡是整页里唯一会自己取数、自己轮询的地方：GET api/companion-health/pulse 每秒一次，
  // 而且**只在卡片真的在视口里、页面也可见时**才轮询（切走 tab / 滚出屏幕 / 页面隐藏都停）。
  // 三条硬规矩来自契约：
  //   1. `bpm` 是 null 就写「—」，绝不写 0（0 会被读成"没有心跳"）；
  //   2. `session.active === false` 时倒计时写「未开始」，不写 0 分钟；
  //   3. 心率不进任何缓存、不进别的页面、不进日志 —— 这里只有渲染，没有 store。
  // ---------------------------------------------------------------------------
  const PULSE_INTERVAL_MS = 1000;

  // 档位（契约 §4.5 的 zone）；颜色走主题变量，四档互不混淆。
  const PULSE_ZONES = [
    { id: 'calm', label: '平静' },
    { id: 'warming', label: '升温' },
    { id: 'racing', label: '加速' },
    { id: 'peak', label: '峰值' },
  ];
  const PULSE_TREND_LABEL = { up: '↑ 在涨', down: '↓ 在落', flat: '→ 平' };
  const PULSE_QUALITY_LABEL = { ok: '读数正常', sparse: '读数稀疏', 'no-contact': '没贴在皮肤上' };
  const PULSE_QUALITY_TONE = { ok: 'ok', sparse: 'warn', 'no-contact': 'warn' };
  const PULSE_SAFETY_LABEL = {
    'too-fast': '心率持续偏高一段时间了 —— 先停下来关心他，不要再加码，也别当成继续的许可。',
    'very-low': '读数偏低，先确认设备有没有戴好。',
    lost: '会话还开着，但读数已经断流很久了 —— 现在不知道他的状态，不要假装知道。',
  };
  const PULSE_FAIL_NOTE = {
    'health-unavailable': '健康服务没有挂载到这套组合上，所以读不到心跳。',
    'health-method-missing': '这一版健康服务还没有实时心跳接口（pulse）。',
    'pulse-disabled': '实时心率功能未启用（配置 pulse.enabled=false）。',
    'pulse-denied': '还没有授权读取实时心率（health.pulse.live）。',
    'pulse-unreachable': '心率广播接收端没有在跑（sidecar 不可达）。',
    'health-pulse-unavailable': '健康服务里的心跳模块没有加载起来。',
  };

  /**
   * `pulse-unreachable` 的两种原因对应两种完全不同的动作，所以分开说（Lead 裁决 2026-11-04）：
   * 没找到广播 → 去手环上开「心率广播」；连上了但超时 → 再点一次或重连。
   * 其它原因（unreachable / http-error / 没给 errorCode）沿用原来那句。
   */
  const PULSE_START_FAIL = {
    'device-not-found': '没找到在广播的手环：先在手环上把手表「心率广播」打开，再试一次。',
    'connect-timeout': '找到了手环但没连上（超时），再点一次「开始」或在设置里把它从蓝牙列表里重连。',
  };

  /** 心跳失败文案：`pulse-unreachable` 按 `errorCode` 细分，其余走通用 failText。 */
  function pulseFailText(error, fallback) {
    const code = error && error.code ? String(error.code) : '';
    const reason = error && error.errorCode ? String(error.errorCode) : '';
    if (code === 'pulse-unreachable' && PULSE_START_FAIL[reason]) return PULSE_START_FAIL[reason];
    return P.failText(error, fallback);
  }

  /**
   * 会话模式（契约 §4.4，2026-11-04 起默认跟随设备）：
   *   `device` —— 不设窗口，主人关掉手环广播后后端 ≤30 s 自动收口，卡片没有倒计时；
   *   `timer`  —— 只有主人显式给了 minutes 才有 endsAt/remainingMs。
   * 老版本没有 `mode` 字段：有 endsAt/minutes 就当 timer，否则按跟随设备处理。
   */
  function pulseSessionMode(session) {
    if (!session) return 'device';
    const mode = String(session.mode ?? '').trim().toLowerCase();
    if (mode === 'timer' || mode === 'device') return mode;
    return toMs(session.endsAt) !== null || finite(session.minutes) ? 'timer' : 'device';
  }

  /** 倒计时只属于 timer 模式；跟随设备的会话没有"窗口"，永远不返回剩余分钟。 */
  function pulseRemainingMinutes(session, nowMs) {
    if (!session || session.active !== true) return null;
    if (pulseSessionMode(session) !== 'timer') return null;
    const endsAt = toMs(session.endsAt);
    if (endsAt !== null) return Math.max(0, Math.ceil((endsAt - nowMs) / 60000));
    // 服务端已经算好了 remainingMs（不受浏览器时钟影响），退而用它。
    if (finite(session.remainingMs)) return Math.max(0, Math.ceil(session.remainingMs / 60000));
    return finite(session.minutes) ? Math.max(0, Math.round(session.minutes)) : null;
  }

  /** 后端给的"断开"信号（`pulse()` 顶层的 lastErrorCode，退而用 sidecar.errorCode）。 */
  function pulseDisconnectCode(view) {
    if (!view) return '';
    const top = view.lastErrorCode;
    const nested = view.sidecar && typeof view.sidecar === 'object' ? view.sidecar.errorCode : null;
    return String((top === undefined || top === null ? nested : top) ?? '').trim();
  }

  /**
   * 「设备被主人关掉，会话随之结束」——**预期行为**，不是故障，所以用一种中性说法。
   *
   * 三个条件必须同时成立（Lead 裁决 2026-11-04）：
   *   `lastErrorCode==='disconnected'` + `session.active!==true` + `sampleAgeMs > session.deviceOffMs`。
   *
   * 为什么不能只看 `disconnected`：`stop` 现在也会主动断开 BLE（让手环停广播省电），
   * 那一刻同样是 `connected:false` + `disconnected`；把它说成"设备被关掉"就撒谎了。
   * 也不能只看读数变旧：真的要静满 `deviceOffMs` 才算设备那边停了。
   */
  function pulseDeviceOff(view, session) {
    if (!view || !session || session.active === true) return false;
    if (pulseDisconnectCode(view) !== 'disconnected') return false;
    const offMs = finite(session.deviceOffMs) ? Number(session.deviceOffMs) : null;
    const ageMs = finite(view.sampleAgeMs) ? Number(view.sampleAgeMs) : null;
    return offMs !== null && ageMs !== null && ageMs > offMs;
  }

  /**
   * 主动结束（`stop` 会一并断开 BLE）：断开信号在，但还没静满 `deviceOffMs`。
   * 这时该说「已结束」，不该说「设备已关闭，会话随之结束」。
   */
  function pulseJustStopped(view, session, deviceOff) {
    if (deviceOff) return false;
    if (!view || !session || session.active === true) return false;
    return view.connected === false && pulseDisconnectCode(view) === 'disconnected';
  }

  /** 设备状态：只说读得到的那几件事，不编"搜索中"；关掉广播是中性事件，不报警。 */
  function pulseDeviceText(view, state) {
    if (!view) return { text: '还没读到心跳服务', tone: 'idle' };
    if (view.enabled === false) return { text: '功能未启用', tone: 'idle' };
    const reachable = view.sidecar && typeof view.sidecar === 'object' ? view.sidecar.reachable : null;
    if (reachable === false) return { text: '心率广播接收端不可达（sidecar 未运行）', tone: 'danger' };
    if (state && state.deviceOff) return { text: '设备已关闭，会话随之结束', tone: 'idle' };
    if (view.connected === false) {
      const label = view.deviceLabel ? String(view.deviceLabel) : '';
      // 我们自己 stop 时也断 BLE：那是主动结束，中性说明，不报警。
      if (state && state.justStopped) return { text: label ? `${label} 已断开` : '设备已断开', tone: 'idle' };
      return { text: label ? `${label} 已断开` : '设备未连接', tone: 'warn' };
    }
    if (view.deviceLabel) return { text: String(view.deviceLabel), tone: 'ok' };
    return { text: '未连接', tone: 'idle' };
  }

  /** 最近 ≤60 点的 sparkline：纯内联 SVG，没有读数就画一句说明，不画零线。 */
  function PulseSparkline({ series }) {
    const list = (Array.isArray(series) ? series : []).filter((point) => point && finite(point.bpm));
    if (list.length < 2) {
      return h('div', { className: 'cpxp-pl-spark' },
        h('span', { className: 'cpxp-hl-note' },
          list.length === 1 ? '只有一个读数，等下一个点再画曲线。' : '还没有连续读数，所以没有曲线。'));
    }
    const W = 240;
    const H = 52;
    const PAD = 4;
    const values = list.map((point) => point.bpm);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const x = (index) => (index / (list.length - 1)) * W;
    const y = (bpm) => (span === 0 ? H / 2 : PAD + (1 - (bpm - min) / span) * (H - PAD * 2));
    const d = list.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(point.bpm).toFixed(1)}`).join(' ');
    return h('div', {
      className: 'cpxp-pl-spark',
      role: 'img',
      'aria-label': `最近 ${list.length} 个读数，最低 ${min} bpm，最高 ${max} bpm`,
    }, h('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      h('path', {
        d,
        fill: 'none',
        stroke: 'var(--dsw-alias-brand-primary)',
        strokeWidth: '1.6',
        strokeLinejoin: 'round',
        strokeLinecap: 'round',
        vectorEffect: 'non-scaling-stroke',
      })));
  }

  /**
   * 1 Hz 取数。`active` 由调用方决定（卡片在视口里 + 页面可见）；
   * 关掉时立刻 clearInterval —— 不在 `document.hidden` 里空转。
   */
  function usePulseLive(active) {
    const [state, setState] = P.useState({ data: null, error: null, at: 0 });
    const [cycle, setCycle] = P.useState(0);
    const aliveRef = P.useRef(true);

    P.useEffect(() => {
      aliveRef.current = true;
      if (!active) {
        return () => { aliveRef.current = false; };
      }
      let inflight = false;
      const step = () => {
        if (!aliveRef.current || inflight) return;
        // 页面被切到后台：这一拍不发请求（可见性变化会把 active 置 false，这里再兜一次）。
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        inflight = true;
        healthGet('pulse').then(
          (data) => { if (aliveRef.current) setState({ data, error: null, at: Date.now() }); },
          (error) => {
            if (!aliveRef.current) return;
            // 读失败时保留上一份读数但标出来 —— 不能把旧 bpm 当成"现在"。
            setState((previous) => ({ data: previous.data, error, at: Date.now() }));
          },
        ).then(() => { inflight = false; }, () => { inflight = false; });
      };
      step();
      const timer = setInterval(step, PULSE_INTERVAL_MS);
      return () => {
        aliveRef.current = false;
        clearInterval(timer);
      };
    }, [active, cycle]);

    return { ...state, refresh: () => setCycle((value) => value + 1) };
  }

  function PulseCard({ consent, onReload }) {
    const hostRef = P.useRef(null);
    const [inView, setInView] = P.useState(true);
    const [pageVisible, setPageVisible] = P.useState(true);
    const [busy, setBusy] = P.useState(null);
    const [notice, setNotice] = P.useState(null);

    // 滚出视口就停轮询（没有 IntersectionObserver 的环境按"一直可见"处理）。
    P.useEffect(() => {
      const node = hostRef.current;
      if (typeof IntersectionObserver !== 'function' || !node) return undefined;
      const observer = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        setInView(Boolean(last && last.isIntersecting));
      }, { threshold: 0.15 });
      observer.observe(node);
      return () => observer.disconnect();
    }, []);

    // 页面切走（换窗口/最小化）也停。
    P.useEffect(() => {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
      const sync = () => setPageVisible(document.visibilityState !== 'hidden');
      sync();
      document.addEventListener('visibilitychange', sync);
      return () => document.removeEventListener('visibilitychange', sync);
    }, []);

    const live = usePulseLive(inView && pageVisible);
    const view = live.data || null;
    const nowMs = Date.now();

    const run = (action, payload) => {
      if (busy) return;
      setBusy(action);
      setNotice(null);
      healthPost('pulse', { action, ...(payload || {}) }).then((result) => {
        if (action === 'start') {
          const started = result && result.session && typeof result.session === 'object' ? result.session : null;
          const minutes = started && finite(started.minutes) ? Math.round(started.minutes) : null;
          const mode = pulseSessionMode(started);
          setNotice({
            tone: 'ok',
            text: mode === 'timer' && minutes
              ? `心跳会话开始了（${minutes} 分钟）。`
              : '心跳会话开始了：跟随设备，关掉手环广播就自动结束。',
          });
        } else if (action === 'stop') {
          const peak = result && result.summary && finite(result.summary.peakBpm) ? result.summary.peakBpm : null;
          setNotice({ tone: 'ok', text: peak ? `会话结束了，这次峰值 ${peak} bpm。` : '会话结束了。' });
        } else if (action === 'mark') {
          const bpm = result && result.mark && finite(result.mark.bpm) ? result.mark.bpm : null;
          setNotice({ tone: 'ok', text: bpm ? `已记下此刻：${bpm} bpm。` : '已记下此刻。' });
        } else {
          setNotice({ tone: 'ok', text: payload && payload.consent === true ? '已打开实时心率读取。' : '已关闭实时心率读取。' });
        }
        live.refresh();
        if (typeof onReload === 'function') onReload();
      }, (error) => {
        setNotice({ tone: 'danger', text: pulseFailText(error, '心跳动作没有完成。') });
      }).then(() => setBusy(null), () => setBusy(null));
    };

    const errorCode = live.error ? String(live.error.code || '') : '';
    const reachable = view && view.sidecar && typeof view.sidecar === 'object' ? view.sidecar.reachable : null;
    const session = view && view.session && typeof view.session === 'object' ? view.session : null;
    const sessionActive = Boolean(session && session.active === true);
    const sessionMode = pulseSessionMode(session);
    const remaining = pulseRemainingMinutes(session, nowMs);
    // 设备被关掉、会话随之收口（三个条件都成立）：这是预期行为，此时不再显示任何数字。
    const deviceOff = pulseDeviceOff(view, session);
    // 我们自己 stop 之后也会看到断开信号：那是「已结束」，不是「设备已关闭」。
    const justStopped = pulseJustStopped(view, session, deviceOff);
    // 没有读数就是「—」：`finite()` 挡掉 null / NaN，`> 0` 再挡一次 0 ——
    // 契约 §3.2 说得很清楚：无读数时 `bpm` 是 null，而 0 会被读成"没有心跳"。
    const bpm = !deviceOff && view && finite(view.bpm) && view.bpm > 0 ? Math.round(view.bpm) : null;
    const device = pulseDeviceText(view, { deviceOff, justStopped });
    const zone = view && view.zone ? String(view.zone) : '';
    const quality = view && view.quality ? String(view.quality) : '';
    const sampleAgeSec = view && finite(view.sampleAgeMs) ? Math.round(view.sampleAgeMs / 1000) : null;

    const metaLine = view
      ? [
        h('span', { key: 'quality' }, h(ui.StateLine, {
          state: PULSE_QUALITY_TONE[quality] || 'idle',
          text: PULSE_QUALITY_LABEL[quality] || '质量未知',
        })),
        sampleAgeSec === null
          ? null
          : h('span', { key: 'age' }, `读数 ${sampleAgeSec} 秒前`),
        h('span', { key: 'baseline' }, `基线 ${finite(view.baseline) ? Math.round(view.baseline) : DASH} bpm`),
        h('span', { key: 'trend' }, `近 1 分钟 ${PULSE_TREND_LABEL[view.trend] || DASH}`),
        h('span', { key: 'peak' }, view.peak && finite(view.peak.bpm)
          ? `本次峰值 ${Math.round(view.peak.bpm)} bpm${view.peak.at ? `（${P.fmt.clock(view.peak.at)}）` : ''}`
          : '本次峰值 —'),
      ]
      : [h('span', { key: 'idle' }, '还没有读数。')];

    return h('div', { className: 'cpxp-pl-card', ref: hostRef },
      h('div', { className: 'cpxp-pl-top' },
        h('div', { className: 'cpxp-pl-bpm' },
          h('strong', { className: 'cpxp-pl-bpm-value', 'data-empty': bpm === null ? 'true' : undefined, 'aria-live': 'polite' },
            bpm === null ? DASH : String(bpm)),
          h('span', { className: 'cpxp-pl-bpm-unit' }, 'bpm')),
        // 设备被关掉之后旧曲线也不再显示：那一拍已经没有"现在"的意思了。
        deviceOff
          ? h('div', { className: 'cpxp-pl-spark' },
            h('span', { className: 'cpxp-hl-note' }, '设备关掉之后没有新的读数。'))
          : h(PulseSparkline, { series: view ? view.series : null })),

      h('div', { className: 'cpxp-pl-zones', role: 'list', 'aria-label': '节奏档位' },
        PULSE_ZONES.map((item) => h('span', {
          key: item.id,
          className: 'cpxp-pl-zone',
          role: 'listitem',
          'data-zone': item.id,
          'data-active': zone === item.id ? 'true' : undefined,
          title: zone === item.id ? `当前档位：${item.label}` : `档位：${item.label}`,
        },
        h('span', { className: 'cpxp-pl-zone-dot' }),
        item.label))),

      h('div', { className: 'cpxp-pl-kv' }, metaLine),

      h('div', { className: 'cpxp-pl-kv' },
        h('span', null, h('span', { className: 'cpxp-pl-kv-k' }, '设备'),
          h(ui.StateLine, { state: device.tone, text: device.text })),
        h('span', null, h('span', { className: 'cpxp-pl-kv-k' }, '会话'),
          !sessionActive
            // 主动结束（stop 会断 BLE）与"设备被关掉"都落在收口之后：说「已结束」，不说「未开始」。
            ? (justStopped || deviceOff ? '已结束' : '未开始')
            : sessionMode === 'timer'
              ? (remaining === null
                ? '计时会话进行中'
                : remaining <= 0
                  ? '即将结束'
                  : `剩余 ${remaining} 分钟${session.startedAt ? `（${P.fmt.clock(session.startedAt)} 开始）` : ''}`)
              // 跟随设备：没有窗口，所以只说"从什么时候开始"，不报倒计时。
              : `跟随设备${session.startedAt ? `（${P.fmt.clock(session.startedAt)} 开始）` : ''}`)),

      view && view.safety && PULSE_SAFETY_LABEL[view.safety]
        ? h(ui.Callout, { tone: 'danger', title: '注意' }, h('span', null, PULSE_SAFETY_LABEL[view.safety]))
        : null,

      live.error
        ? h(ui.Callout, { tone: 'warn', title: '这一拍没读到心跳' },
          h('span', null, PULSE_FAIL_NOTE[errorCode] || pulseFailText(live.error, '心跳接口没有返回数据。')))
        : null,
      view && view.enabled === false
        ? h(ui.Callout, { tone: 'info', title: '实时心率未启用' },
          h('span', null, '配置里 pulse.enabled=false，所以这张卡不会显示数字。'))
        : null,
      notice
        ? h(ui.Callout, { tone: notice.tone === 'ok' ? 'ok' : 'danger', title: notice.tone === 'ok' ? '已生效' : '没有生效' },
          h('span', null, notice.text))
        : null,

      h('div', { className: 'cpxp-pl-actions' },
        h(ui.Button, {
          key: 'start',
          variant: 'primary',
          size: 'sm',
          onClick: () => run('start'),
          loading: busy === 'start',
          disabled: Boolean(busy) || sessionActive || reachable === false,
          title: '开一段心跳会话：跟随设备，主人关掉手环广播后会自动结束；只有会话开着，模型才会看到【心跳读数】行',
        }, '开始'),
        h(ui.Button, {
          key: 'stop',
          variant: 'ghost',
          size: 'sm',
          onClick: () => run('stop'),
          loading: busy === 'stop',
          disabled: Boolean(busy) || !sessionActive,
          title: '结束这一段心跳会话（峰值与档位分布会记进会话摘要，不记原始曲线）',
        }, '结束'),
        h(ui.Button, {
          key: 'mark',
          variant: 'ghost',
          size: 'sm',
          onClick: () => run('mark'),
          loading: busy === 'mark',
          disabled: Boolean(busy) || !sessionActive,
          title: '把此刻标记一下（记下时间与当时读数）',
        }, '此刻标记')),

      h('div', { className: 'cpxp-pl-consent' },
        h(ui.Toggle, {
          checked: consent === true,
          disabled: Boolean(busy),
          label: '允许读取实时心率（health.pulse.live）',
          hint: consent === true
            ? '已打开：她读得到此刻的心率。'
            : consent === false
              ? '已关闭：这张卡不显示数字。'
              : '状态未知；开关仍然可以写。',
          onChange: (next) => run('consent', { consent: next === true }),
        }),
        h(ui.Info, { text: '心跳数据只在这一张卡里：不写进记忆、不进日志、不画到别的页面；打开后读得到此刻心率，读不到历史曲线。会话默认跟随设备，关掉手环广播后后端会自动收口，这里不需要倒计时。空闲时不扫描、不轮询；秒级刷新只在卡片可见时进行，切到别的 tab 就停。' })));
  }

  /** `health.pulse.live` 的当前授权：只有真的读到布尔才敢说"开/关"，读不到就是 null（未知）。 */
  function pulseConsentOf(status) {
    const consents = status && status.consents && typeof status.consents === 'object' ? status.consents : null;
    if (!consents) return null;
    const value = consents['health.pulse.live'];
    return value === true || value === false ? value : null;
  }

  /** 一张卡 = 一个 Band；概览与"整页读不到"两种状态下都挂同一份（不新建页面入口）。 */
  function pulseBand(consent, onReload) {
    return h(ui.Band, {
      title: '心跳 · 实时',
      hint: '设备在广播时才有数字，没有就写「—」。',
      info: '心跳数据不写进记忆、不进日志、不画到别的页面；会话跟随设备，关掉广播后自动收口；空闲时不扫描、不轮询。这不是医学判断。',
    }, h(PulseCard, { consent, onReload }));
  }

  // ---------------------------------------------------------------------------
  // 6. 段二：睡眠
  // ---------------------------------------------------------------------------
  function sortSessions(sessions) {
    return sessions.filter(Boolean).slice().sort((left, right) => {
      const leftAt = toMs(left.startAt) ?? toMs(`${left.sleepDate}T00:00:00+08:00`) ?? 0;
      const rightAt = toMs(right.startAt) ?? toMs(`${right.sleepDate}T00:00:00+08:00`) ?? 0;
      return rightAt - leftAt;
    });
  }

  function mainSleepCard(payload, session, nowMs) {
    if (!session) {
      const availability = (payload && payload.availability) || 'no_data';
      const view = AVAILABILITY[availability] || AVAILABILITY.no_data;
      const title = availability === 'awaiting_first_night'
        ? '睡眠会话 — 等待首夜华为云记录'
        : '睡眠会话 — 暂无来源数据';
      return h(ui.Empty, {
        title,
        hint: view.hint,
      });
    }

    const hasRange = toMs(session.startAt) !== null && toMs(session.endAt) !== null;
    const rows = [
      kvRow('入睡', durationText(session.asleepMinutes), !finite(session.asleepMinutes)),
      kvRow('清醒', durationText(session.awakeMinutes), !finite(session.awakeMinutes)),
      kvRow('在床', durationText(session.inBedMinutes), !finite(session.inBedMinutes)),
    ];

    // 分期**分钟数**：来源给的是"深睡 67 / 浅睡 188 / REM 44"这种合计，而不是逐段起止。
    // 有合计就如实显示合计，没有就留空；时间轴另在「睡眠阶段」里，缺区间时不画。
    const stageMin = session.stageMinutes || {};
    const hasStageMinutes = finite(stageMin.deep) || finite(stageMin.light) || finite(stageMin.rem);
    const stageRows = hasStageMinutes
      ? [
        kvRow('深睡', durationText(stageMin.deep), !finite(stageMin.deep)),
        kvRow('浅睡', durationText(stageMin.light), !finite(stageMin.light)),
        kvRow('REM', durationText(stageMin.rem), !finite(stageMin.rem)),
      ]
      : null;
    const stageTimelineMissing = hasStageMinutes && !(Array.isArray(session.stages) && session.stages.length);

    return h('div', { className: 'cpxp-hl-stack' },
      h('div', { className: 'cpxp-hl-sleep-head' },
        h('strong', null, session.sleepDate || DASH),
        h('span', { className: 'cpxp-hl-sleep-range' },
          hasRange ? P.fmt.range(session.startAt, session.endAt) : '来源只给了总时长，没有起止时间'),
        h('span', { className: 'cpxp-hl-tag' }, SESSION_STATUS_LABEL[session.status] || String(session.status || '状态未知')),
        h('span', { className: 'cpxp-hl-tag' }, SESSION_QUALITY_LABEL[session.sessionQuality] || String(session.sessionQuality || DASH))),
      h('div', { className: 'cpxp-hl-kv' }, rows),
      stageRows ? h('div', { className: 'cpxp-hl-kv' }, stageRows) : null,
      h('p', { className: 'cpxp-hl-note' },
        '阶段保真度：', STAGE_FIDELITY_LABEL[session.stageFidelity] || DASH,
        stageTimelineMissing ? '（来源只给了分期合计）' : ''),
      freshnessChip(session.endAt || null, nowMs, '醒来'));
  }

  function sleepSection(ctx) {
    const { sleep, nowMs, days, bundle } = ctx;
    if (!sleep) {
      return readError(bundle.sleep.error, '睡眠数据');
    }

    const availability = sleep.availability || 'no_data';
    const sessions = Array.isArray(sleep.sessions) ? sortSessions(sleep.sessions) : [];
    const naps = sessions.filter((session) => session && session.isNap);
    const mains = sessions.filter((session) => !session || !session.isNap);
    const main = mains.length ? mains[0] : null;
    const trend = Array.isArray(sleep.trend) ? sleep.trend : [];
    const notes = Array.isArray(sleep.notes) ? sleep.notes : [];

    const trendPoints = trend.map((point) => ({
      date: point && point.sleepDate,
      value: finite(point && point.asleepMinutes) ? point.asleepMinutes : null,
    }));

    // 主动关怀（health.care.proactive）：把"今晚会说什么"原样摆出来，含是否已投递。
    // 我们只转述服务给的内容 —— 授权关着时服务返回空数组，这里就什么都不显示，不补不猜。
    const careBundle = bundle.care && bundle.care.value ? bundle.care.value : null;
    const careItems = careBundle && Array.isArray(careBundle.items) ? careBundle.items : [];
    const careBand = careBundle && careBundle.enabled
      ? h(ui.Band, {
        title: '主动关怀',
        hint: '一天只说一次，只说来源报过的事实；不外发到任何平台，也不给建议。',
      },
      careItems.length
        ? careItems.map(item => h(ui.Row, {
          key: item.dedupeKey,
          title: item.sleepDate || DASH,
          meta: item.text,
          status: h(ui.StateLine, {
            state: item.delivered ? 'ok' : 'idle',
            text: item.delivered ? '已提示' : '待提示（下次对话时说）',
          }),
        }))
        : h(ui.Empty, { title: '现在没有要说的', hint: '昨晚的睡眠已经说过，或者醒来超过 18 小时、数据还没到。' }))
      : null;

    // 阶段：只有真的给了阶段明细才画；标题里说清是哪个会话。
    const stageSource = main || (sessions.length ? sessions[0] : null);
    const stageList = stageSource && Array.isArray(stageSource.stages) ? stageSource.stages : [];
    const stageHasRange = Boolean(stageSource)
      && toMs(stageSource.startAt) !== null && toMs(stageSource.endAt) !== null;
    const hasStages = stageHasRange && stageList.some((stage) => {
      const from = toMs(stage && stage.startAt);
      const to = toMs(stage && stage.endAt);
      return from !== null && to !== null && to > from;
    });

    const napList = naps.length
      ? h(ui.List, { label: '午睡记录' }, naps.map((session, index) => h(ui.Row, {
        key: session.sleepDate ? `nap-${session.sleepDate}-${index}` : `nap-${index}`,
        title: session.sleepDate || '午睡',
        meta: toMs(session.startAt) !== null && toMs(session.endAt) !== null
          ? P.fmt.range(session.startAt, session.endAt)
          : '来源只给了总时长，没有起止时间',
        side: durationText(session.asleepMinutes),
      })))
      : h(ui.Empty, { title: '午睡 — 没有记录', hint: '这段时间里来源没有把任何会话标成午睡。', compact: true });

    return h('div', { className: 'cpxp-hl-stack' },
      careBand,

      h(ui.Band, {
        title: '最近主睡眠',
        info: '只有来源真的给了时长或起止才写数字；缺的部分留空，不拿 0 或估算值占位。来源只给分期合计时，只报时长、不画时间轴（不拿时长反推顺序）。',
      }, mainSleepCard(sleep, main, nowMs)),

      h(ui.Band, {
        title: '睡眠阶段',
        info: '阶段时间线按来源给的区间画；来源没覆盖的时段画成斜纹，不补 unknown。',
      }, hasStages
        ? h('div', { className: 'cpxp-hl-stack' },
          h('p', { className: 'cpxp-hl-note' }, `会话：${stageSource.sleepDate || DASH} · 阶段保真度 ${STAGE_FIDELITY_LABEL[stageSource.stageFidelity] || DASH}`),
          h(StageTimeline, { session: stageSource }))
        : h(ui.Empty, {
          title: '睡眠阶段 — 暂无来源数据',
          hint: stageSource && stageSource.status === 'aggregate_only'
            ? '来源只给了总时长，没有阶段明细。'
            : '来源没有给阶段明细。',
        })),

      h(ui.Band, {
        title: `近 ${days} 天睡眠趋势`,
        info: '没有记录的一夜画成虚线刻度，不算 0。',
      }, trendPoints.some((point) => point.value !== null)
        ? h(TrendBars, { points: trendPoints, label: '入睡时长', unit: '', format: (value) => durationText(value) })
        : h(ui.Empty, {
          title: `睡眠趋势 — ${availability === 'awaiting_first_night' ? '等待首夜华为云记录' : '暂无来源数据'}`,
          hint: '这段时间里没有任何一夜的睡眠时长。',
        })),

      h(ui.Band, { title: '原厂评分', hint: '只显示来源自己给的评分，不自己算分。' },
        finite(main && main.sourceScore)
          ? h('div', { className: 'cpxp-hl-sleep-head' },
            h('strong', null, scoreText(main.sourceScore)),
            h('span', { className: 'cpxp-hl-tag' }, main.sourceScoreLabel ? String(main.sourceScoreLabel) : '来源未给标签'),
            h('span', { className: 'cpxp-hl-note' }, `会话 ${main.sleepDate || DASH}`))
          : h(ui.Empty, {
            title: '原厂评分 — 暂无来源数据',
            hint: '华为侧没有给评分。这里不会用自己的算法替代原厂评分。',
          })),

      h(ui.Band, { title: '午睡', hint: '结束时间落在本地 10:00–20:00 且时长不足 3 小时的会话算午睡。' }, napList),

      notes.length
        ? h(ui.Callout, { tone: 'warn', title: '来源对睡眠的说明' },
          h('ul', { className: 'cpxp-hl-note' }, notes.map((note, index) => h('li', { key: `sn${index}` }, String(note)))))
        : null,

      h(ui.Diagnostic, { title: '高级诊断', hint: 'sleep 路由的原始字段。' },
        h(ui.KeyValue, {
          items: [
            { k: 'availability', v: availability, mono: true },
            { k: 'range', v: sleep.range ? `${sleep.range.from} → ${sleep.range.to}` : DASH, mono: true },
            { k: 'sessions / naps', v: `${sessions.length} / ${naps.length}`, mono: true },
            { k: 'includeStages', v: 'true', mono: true },
            { k: 'trend 点数', v: String(trendPoints.length), mono: true },
          ],
        })));
  }

  // ---------------------------------------------------------------------------
  // 7. 段三：活动与运动
  // ---------------------------------------------------------------------------
  function sportRow(workout, index) {
    const label = workout && workout.sportTypeLabel ? String(workout.sportTypeLabel) : null;
    const raw = workout && workout.sportTypeRaw !== null && workout.sportTypeRaw !== undefined
      ? String(workout.sportTypeRaw)
      : DASH;
    const mapping = workout && workout.sportTypeMapping ? String(workout.sportTypeMapping) : DASH;
    const range = workout && toMs(workout.startAt) !== null && toMs(workout.endAt) !== null
      ? P.fmt.range(workout.startAt, workout.endAt)
      : DASH;
    const facts = [
      finite(workout && workout.durationMin) ? durationText(workout.durationMin) : null,
      finite(workout && workout.steps) ? stepsText(workout.steps) : null,
      finite(workout && workout.distanceM) ? distanceText(workout.distanceM) : null,
      finite(workout && workout.kcal) ? `${Math.round(workout.kcal)} 千卡` : null,
    ].filter(Boolean);

    return h(ui.Row, {
      key: `w-${index}`,
      title: label
        ? `${label}（原始码 ${raw}）`
        : `未映射的运动类型（原始码 ${raw}）`,
      meta: [
        range,
        `映射来源 ${mapping === 'upstream_const' ? '上游常量表' : mapping}`,
        facts.length ? facts.join(' · ') : '来源没有给时长/距离等明细',
      ].join(' · '),
      side: workout && workout.quality
        ? h(ui.Badge, { tone: 'neutral' }, QUALITY_LABEL[workout.quality] || String(workout.quality))
        : null,
    });
  }

  function activitySection(ctx) {
    const { today, steps, days, bundle } = ctx;
    const trend = steps || null;
    const workouts = today && Array.isArray(today.workouts) ? today.workouts : [];
    const activity = today ? today.activity : null;
    const points = trend && Array.isArray(trend.points) ? trend.points : [];
    const aggregate = trend && trend.aggregate ? trend.aggregate : null;

    return h('div', { className: 'cpxp-hl-stack' },
      h(ui.Band, {
        title: `近 ${days} 天步数`,
        hint: '纯 CSS 条形图：每根柱子是一天的步数，虚线刻度表示那天没有读数（不是 0 步）。',
      }, [
        !trend
          ? readError(bundle.steps.error, '步数趋势')
          : trend.supported === false
            ? h(ui.Empty, { title: '步数趋势 — 来源不支持', hint: '这个来源没有日报步数，所以没有图可画。' })
            : points.some((point) => finite(point && point.value))
              ? h('div', { className: 'cpxp-hl-stack' },
                h(TrendBars, {
                  points,
                  label: '步数',
                  unit: ' 步',
                  format: (value) => `${Math.round(value)} 步`,
                }),
                aggregate
                  ? h('p', { className: 'cpxp-hl-note' },
                    `有读数 ${aggregate.coveredDays ?? DASH} 天 · 缺测 ${aggregate.missingDays ?? DASH} 天 · `
                    + `平均 ${finite(aggregate.mean) ? Math.round(aggregate.mean) : DASH} 步 · `
                    + `最高 ${finite(aggregate.max) ? Math.round(aggregate.max) : DASH} 步 · `
                    + `最低 ${finite(aggregate.min) ? Math.round(aggregate.min) : DASH} 步`)
                  : null)
              : h(ui.Empty, { title: '步数趋势 — 暂无来源数据', hint: '这段时间里一天都没有步数读数。' }),
        activity && finite(activity.stepGoal) && finite(activity.steps)
          ? h(ui.Meter, {
            value: activity.steps,
            max: activity.stepGoal,
            label: '今日步数 / 目标（目标值来自来源）',
          })
          : null,
      ]),

      h(ui.Band, {
        title: '今天的运动会话',
        info: '运动类型同时显示原始码与上游映射标签；映射是上游常量表的文本，我们没有核实过。',
      }, [
        workouts.length
          ? h(ui.List, { label: '运动会话' }, workouts.map(sportRow))
          : h(ui.Empty, {
            title: '运动会话 — 今天没有记录',
            hint: today ? '今天云端没有回传训练记录。' : '今天的接口没有读到，先刷新看看。',
            compact: true,
          }),
      ]),

      h(ui.Diagnostic, { title: '高级诊断', hint: 'trend / workouts 原始字段。' },
        h(ui.KeyValue, {
          items: [
            { k: 'trend.metric', v: trend && trend.metric ? trend.metric : DASH, mono: true },
            { k: 'trend.unit', v: trend && trend.unit ? String(trend.unit) : DASH, mono: true },
            { k: 'trend.points', v: String(points.length), mono: true },
            { k: 'today.workouts', v: String(workouts.length), mono: true },
            { k: 'sportTypeMapping', v: workouts.length ? String(workouts[0].sportTypeMapping || DASH) : DASH, mono: true },
          ],
        })));
  }

  // ---------------------------------------------------------------------------
  // 8. 段四：关怀与证据（本轮只读占位）
  // ---------------------------------------------------------------------------
  function careSection(ctx) {
    const { status } = ctx;
    const consents = status && status.consents && typeof status.consents === 'object' ? status.consents : null;

    const consentRows = CONSENT_ROWS.map((row) => {
      const value = consents ? consents[row.key] : undefined;
      const state = value === true ? 'ok' : value === false ? 'idle' : 'warn';
      const text = value === true ? '已启用' : value === false ? '未启用' : '状态未知';
      return h(ui.Row, {
        key: `consent-${row.key}`,
        title: row.label,
        meta: row.note,
        status: h(ui.StateLine, { state, text }),
      });
    });

    return h('div', { className: 'cpxp-hl-stack' },
      h(ui.Callout, { tone: 'info', title: '本轮未启用' }),

      h(ui.Band, {
        title: '为什么考虑 / 为什么沉默',
        info: '这一段是占位：后端本轮没有 health.care.* 的任何代码路径（能力键 health.care.proactive 默认关闭且无法打开），所以既没有候选，也没有"考虑了但选择不说"的记录。这一页不会伪造候选，也不会出现发送按钮；等 P2.5 的 QQ 回执与授权确认完成后，才谈得上"要不要主动关怀"。',
      }, h(ui.List, { label: '关怀候选占位' },
        h(ui.Row, {
          key: 'care-why',
          title: '为什么考虑',
          meta: '本期没有候选生成路径。',
          status: h(ui.Badge, { tone: 'neutral' }, '未启用'),
        }),
        h(ui.Row, {
          key: 'care-silent',
          title: '为什么沉默',
          meta: '本期也没有沉默记录。',
          status: h(ui.Badge, { tone: 'neutral' }, '未启用'),
        }))),

      h(ui.Band, {
        title: '授权开关（只读）',
        info: '这些开关在健康服务自己的 consents 表里；本页只显示当前状态，不提供修改入口。',
      }, h(ui.List, { label: '健康能力授权状态' }, consentRows)),

      h(ui.Band, {
        title: '每项能力的支持状态',
        info: '来源自己声明的能力边界；「来源支持·暂无数据」和「来源不支持」是两件事。',
      }, (() => {
        const list = Array.isArray(ctx.sources) ? ctx.sources : [];
        if (!list.length) {
          return h(ui.Empty, {
            title: '能力状态 — 读不到来源清单',
            hint: ctx.bundle.sources.error
              ? P.failText(ctx.bundle.sources.error, 'sources 路由没有返回数据。')
              : '健康服务没有给出来源清单。',
            compact: true,
          });
        }
        return h('div', { className: 'cpxp-hl-stack' }, list.map((source) => {
          const capabilities = source && source.capabilities ? source.capabilities : {};
          const sleep = capabilities.sleep && typeof capabilities.sleep === 'object' ? capabilities.sleep : null;
          return h(ui.List, { key: `caps-${source.id || 'source'}`, label: `${source.name || source.id || '来源'} 能力` }, [
            ...CAPABILITY_ROWS.map((row) => {
              const value = capabilities[row.key];
              return h(ui.Row, {
                key: `cap-${row.key}`,
                title: row.label,
                meta: value ? (CAPABILITY_NOTE[value] || String(value)) : '来源没有声明这项能力',
                status: h(ui.StateLine, {
                  state: value ? (CAPABILITY_TONE[value] || 'idle') : 'idle',
                  text: value ? (CAPABILITY_LABEL[value] || String(value)) : '未声明',
                }),
              });
            }),
            h(ui.Row, {
              key: 'cap-sleep',
              title: '睡眠',
              meta: sleep
                ? `阶段保真度：${STAGE_FIDELITY_LABEL[sleep.stageFidelity] || DASH}`
                : '来源没有声明睡眠能力',
              status: h(ui.StateLine, {
                state: sleep ? (sleep.supported ? 'ok' : 'idle') : 'idle',
                text: sleep ? (CAPABILITY_LABEL[sleep.status] || String(sleep.status || '未知')) : '未声明',
              }),
            }),
          ]);
        }));
      })()));
  }

  // ---------------------------------------------------------------------------
  // 9. 页面
  // ---------------------------------------------------------------------------
  const SECTION_OPTIONS = [
    { id: 'overview', label: '概览' },
    { id: 'sleep', label: '睡眠' },
    { id: 'activity', label: '活动与运动' },
    { id: 'care', label: '关怀与证据' },
  ];

  const DAY_OPTIONS = [
    { id: '7', label: '近 7 天' },
    { id: '30', label: '近 30 天' },
  ];

  function CollectorTerminals({ onChange }) {
    const query = P.useApi(() => P.api.get('collector-terminals'), []);
    const [busy, setBusy] = P.useState(null);
    const [error, setError] = P.useState(null);
    const available = query.data?.available;
    P.useEffect(() => {
      if (!available || busy) return undefined;
      const timer = setInterval(() => { if (!document.hidden) query.reload(); }, 5000);
      return () => clearInterval(timer);
    }, [available, busy]);

    async function control(row, action, enabled) {
      setBusy(row.key);
      setError(null);
      try {
        await P.api.post('collector-terminals', { key: row.key, action, enabled });
        onChange();
      } catch (failure) {
        setError(failure);
      } finally {
        query.reload();
        setBusy(null);
      }
    }

    const states = {
      running: ['运行中', 'ok'], starting: ['启动中', 'warn'], stopped: ['已停止', 'neutral'],
      occupied: ['端口被占用', 'warn'], unresponsive: ['服务未就绪', 'warn'], failed: ['终端已退出或启动失败', 'danger'],
    };
    const content = query.error
      ? h(ui.ErrorBox, { error: query.error, onRetry: query.reload })
      : !query.data ? h(ui.Skeleton, { rows: 2 })
        : !available ? h('p', { className: 'cpx-muted' }, '当前实例未加载采集器持久终端。')
          : query.data.collectors.map(row => {
            const label = row.key === 'cloud' ? '华为健康云' : '蓝牙心率';
            const [state, tone] = states[row.state] || ['状态未知', 'neutral'];
            const startDisabled = !!busy || !row.enabled || row.state === 'occupied';
            return h('div', { key: row.key, className: 'cpxp-collector-row' },
              h('div', { className: 'cpxp-collector-title' },
                h('strong', null, label),
                h(ui.Badge, { tone }, row.configured ? state : '未配置'),
                row.terminalId && h('span', { className: 'cpx-muted' }, row.terminalId)),
              h('div', { className: 'cpxp-hl-tools', role: 'group', 'aria-label': label },
                h('button', {
                  type: 'button', className: 'cpxp-enable', role: 'switch', 'aria-checked': row.enabled,
                  'aria-label': label + '随 DSH 启动', disabled: !!busy || !row.configured,
                  onClick: () => control(row, 'set-enabled', !row.enabled),
                }, h('span', { className: 'cpxp-switch-track' }), '启用'),
                h(ui.Button, { size: 'sm', variant: 'primary', disabled: startDisabled || ['running', 'starting', 'unresponsive'].includes(row.state),
                  onClick: () => control(row, 'start') }, '启动'),
                h(ui.Button, { size: 'sm', variant: 'ghost', disabled: startDisabled || !row.managed,
                  onClick: () => control(row, 'restart') }, '重启'),
                h(ui.Button, { size: 'sm', variant: 'danger', disabled: !!busy || !row.managed,
                  onClick: () => control(row, 'stop') }, '终止')));
          });
    return h(ui.Band, {
      title: '采集器持久终端',
      hint: '启用后随 DSH 启动。终止只停止本次运行，关闭启用会同时停止采集。',
      actions: h(ui.Button, { size: 'sm', variant: 'ghost', onClick: query.reload, disabled: !!busy }, '刷新状态'),
    }, error && h(ui.Callout, { tone: 'danger', title: '采集器操作失败' }, P.failText(error)),
    busy && h('p', { role: 'status', className: 'cpx-muted' }, '正在操作终端…'), content);
  }

  function HealthPage() {
    const [section, setSection] = P.useState('overview');
    const [days, setDays] = P.useState(7);
    const [busy, setBusy] = P.useState(null);
    const [actionError, setActionError] = P.useState(null);
    const [actionNotice, setActionNotice] = P.useState(null);

    const query = P.useApi(() => loadHealth(days), [days]);
    const bundle = query.data || null;

    const notify = (message, tone) => {
      try {
        if (typeof P.notice === 'function') P.notice(message, tone);
      } catch { /* 通知只是提示 */ }
    };

    const status = bundle && bundle.status ? bundle.status.value : null;
    const sources = bundle && bundle.sources ? bundle.sources.value : null;
    const today = bundle && bundle.today ? bundle.today.value : null;
    const sleep = bundle && bundle.sleep ? bundle.sleep.value : null;
    const steps = bundle && bundle.steps ? bundle.steps.value : null;

    const source = status && status.source ? status.source : null;
    const sourceFreshness = source && source.freshness ? source.freshness : null;
    const auth = source && source.auth ? source.auth : null;
    const nowMs = Date.now();

    const runSync = () => {
      if (busy) return;
      setActionError(null);
      setActionNotice(null);
      setBusy('sync');
      healthPost('sync', { days, reason: 'studio-ui' }).then((result) => {
        const state = result && result.status ? String(result.status) : 'unknown';
        const label = SYNC_STATUS_LABEL[state] || state;
        if (state === 'error' || state === 'rate_limited') {
          setActionError({ title: `同步没有成功：${label}`, detail: result && result.errorCode ? String(result.errorCode) : '来源没有给出错误码' });
        } else {
          setActionNotice(`${label}${result && finite(result.itemsSeen) ? `（看到 ${result.itemsSeen} 条）` : ''}`);
        }
        notify(label, state === 'ok' ? 'ok' : 'warn');
        query.reload();
      }).catch((error) => {
        const message = P.failText(error, '同步请求没有完成。');
        setActionError({ title: '同步没有成功', detail: message });
        notify(`同步失败 — ${message}`, 'danger');
      }).then(() => setBusy(null), () => setBusy(null));
    };

    const statusLine = h(P.Fragment, null,
      h(ui.StateLine, {
        state: sourceFreshness
          ? (sourceFreshness.status === 'fresh' ? 'ok'
            : sourceFreshness.status === 'delayed' ? 'warn'
              : sourceFreshness.status === 'stale' ? 'danger' : 'idle')
          : 'idle',
        text: sourceFreshness
          ? `来源${FRESH_LABEL[sourceFreshness.status] || '状态未知'}`
          : '来源状态未知',
      }),
      sourceFreshness && sourceFreshness.newestSampleAt
        ? h(ui.Timestamp, { at: sourceFreshness.newestSampleAt, prefix: '最新样本' })
        : h('span', null, '最新样本 —'),
      h(ui.Badge, { tone: auth ? (AUTH_TONE[auth.status] || 'neutral') : 'neutral' },
        auth ? (AUTH_LABEL[auth.status] || String(auth.status)) : '鉴权未知'));

    const toolbar = h('div', { className: 'cpxp-hl-toolbar' },
      h(ui.Segmented, {
        options: SECTION_OPTIONS,
        value: section,
        onChange: (id) => setSection(id),
        label: '健康与睡眠的分段',
      }),
      h('div', { className: 'cpxp-hl-tools' },
        h('span', { className: 'cpxp-hl-tools-label' }, '时间窗口'),
        h(ui.Segmented, {
          options: DAY_OPTIONS,
          value: String(days),
          onChange: (id) => setDays(Number(id) === 30 ? 30 : 7),
          label: '趋势与睡眠的时间窗口',
        })));

    const allUnavailable = bundle
      && isUnavailable(bundle.status.error)
      && isUnavailable(bundle.today.error)
      && isUnavailable(bundle.sleep.error);

    let body = null;
    if (query.loading && !bundle) {
      body = h(ui.Skeleton, { rows: 6 });
    } else if (query.error) {
      body = h(ui.ErrorBox, { error: query.error, onRetry: query.reload });
    } else if (allUnavailable) {
      // 华为云那条链路整条不在场时，实时心跳仍然可能活着（BLE 不经过云端）：
      // 所以这一张卡单独留着，其余部分照旧说"没接入"。
      body = h('div', { className: 'cpxp-hl-stack' },
        pulseBand(null, query.reload),
        h(ui.Empty, {
          title: '华为运动健康还没接入这套组合',
          hint: '面板没有拿到 /api/companion-health 的服务（health-unavailable）。这里不编造任何读数，等健康服务挂上之后刷新即可。',
        }));
    } else if (!bundle) {
      body = h(ui.Empty, { title: '没有读到健康数据', hint: '接口返回了空结果，点页头的刷新再试一次。' });
    } else {
      const ctx = { bundle, status, sources, today, sleep, steps, days, nowMs, onStatusReload: query.reload };
      let panel = null;
      if (section === 'sleep') panel = sleepSection(ctx);
      else if (section === 'activity') panel = activitySection(ctx);
      else if (section === 'care') panel = careSection(ctx);
      else panel = overviewSection(ctx);

      const failed = ['status', 'sources', 'today', 'sleep', 'steps']
        .filter((key) => bundle[key] && bundle[key].error && !isUnavailable(bundle[key].error));

      body = h('div', { className: 'cpxp-hl-stack' },
        failed.length
          ? h(ui.Callout, {
            tone: 'warn',
            title: '有几项这次没读到',
            action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: query.reload }, '重试'),
          }, h('span', null, failed.map((key) => {
            const label = { status: '来源状态', sources: '来源能力', today: '今天', sleep: '睡眠', steps: '步数趋势' }[key] || key;
            return `${label}：${P.failText(bundle[key].error, '没有返回原因')}`;
          }).join('；')))
          : null,
        actionError
          ? h(ui.Callout, { tone: 'danger', title: actionError.title },
            h('span', null, actionError.detail))
          : null,
        actionNotice
          ? h(ui.Callout, { tone: 'ok', title: '同步结果' }, h('span', null, actionNotice))
          : null,
        toolbar,
        panel);
    }

    const actions = [
      h(ui.Button, {
        key: 'sync',
        variant: 'ghost',
        onClick: runSync,
        loading: busy === 'sync',
        disabled: Boolean(busy),
        title: '让本地采集器立刻向华为 CN 云拉一次（同一时间只跑一次，有冷却）',
      }, '立即同步'),
      h(ui.Button, {
        key: 'refresh',
        variant: 'primary',
        onClick: query.reload,
        loading: query.loading,
        disabled: Boolean(busy),
      }, '刷新'),
    ];

    return h(ui.Page, {
      title: '健康与睡眠',
      lead: '华为运动健康回传的身体数据。',
      status: statusLine,
      actions,
    }, h('div', { className: 'cpxp-hl-stack' }, h(CollectorTerminals, { onChange: query.reload }), body));
  }

  // 二级 tab 的容器是 core.js 的 NAV 常量（'life' 原本没有 tabs）。这里只把本页挂进
  // 「生活与日程」的 tabs 里，不动 NAV 的其它字段，也不改 core.js。
  (function attachTab() {
    const nav = P.NAV;
    if (!Array.isArray(nav)) return;
    const life = nav.find((item) => item && item.id === 'life');
    if (!life) return;
    if (!Array.isArray(life.tabs)) life.tabs = [life.id || 'life'];
    if (life.tabs.indexOf('life') < 0) life.tabs.unshift('life');
    if (life.tabs.indexOf('health') < 0) life.tabs.push('health');
  })();

  P.registerPage({ id: 'health', label: '健康与睡眠', order: 21, component: HealthPage });
})(P);
