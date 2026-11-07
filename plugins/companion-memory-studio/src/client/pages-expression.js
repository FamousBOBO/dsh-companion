// 工具 → 表情包：图库 / 收集规则 / 自然度实验室 / 表达习惯。
//
// 单一权威：字段、状态文案、端点全部来自 `GET /api/companion-expression/page` 的 descriptor；
// 对齐 companion-media 的做法——页面不写死路径、不复制服务端校验、不硬编码枚举值。
//
// 三条硬规则（都在代码里落实，不是文档承诺）：
//   1. 只认 assetId：页面从不构造文件路径，缩略图只走 `GET /thumb?assetId=…`，
//      抽屉里的"来源"也只显示服务端给的可读标签（私聊 scope 是加盐哈希，不回推 QQ 号）。
//   2. 实验室只读：`POST /simulate` 是唯一会"评估决策"的调用，且它没有任何投递路径；
//      页面常驻标明「模拟不会向 QQ 发送任何内容」，不是提示条、不会消失。
//   3. 读不到就说读不到：模块没启用时给可走通的启用片段；指标缺失显示「—」，绝不画 0。
(function (P) {
  'use strict';

  const { h, ui } = P;

  const BASE = 'api/companion-expression/';

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
    disabled: 'neutral',
    unconfigured: 'warn',
    'not-connected': 'neutral',
    'saved-untested': 'idle',
    'test-ok': 'ok',
    'test-failed': 'danger',
  };

  // 六种素材动作：文案只说"会改什么"，不承诺"会不会发出去"。
  const ACTIONS = [
    { id: 'approve', label: '通过', hint: '标为已审核：之后才可能被检索到。', tone: 'primary' },
    { id: 'resend-review', label: '退回复核', hint: '回到待复核：不会发送。', tone: 'ghost' },
    { id: 'quarantine', label: '隔离', hint: '移出可检索范围；页面里要显式查看。', tone: 'ghost' },
    { id: 'disable', label: '禁用', hint: '保留素材但永不发送。', tone: 'ghost' },
    { id: 'delete', label: '删除', hint: '删条目并写审计；不可撤销。', tone: 'danger' },
  ];

  // 收集规则里每个群的三个独立开关（服务端就是三个独立列，不是同一个）。
  const GROUP_FLAGS = [
    { id: 'capture', label: '收集', hint: '收到图片时下载' },
    { id: 'store', label: '入库', hint: '写进图库' },
    { id: 'use', label: '可用', hint: '允许从这个群的素材里挑图' },
  ];

  const ENABLE_SNIPPET = [
    '{',
    '  "modules": {',
    '    "expression": true',
    '  }',
    '}',
  ].join('\n');

  // 指标口径：与 CONTRACT.md §5 一字不差地写在页面里，避免"这个数字是什么意思"的追问。
  const METRIC_ROWS = [
    { id: 'precision', label: 'precision', kind: 'percent', hint: '显式反馈里的好评占比；沉默不计入。' },
    { id: 'context_fit', label: 'context_fit', kind: 'percent', hint: '候选贴合当前语境的平均分。' },
    { id: 'awkward', label: 'awkward', kind: 'count', hint: '被判"不对味"的次数。' },
    { id: 'repeat_7d', label: 'repeat_7d', kind: 'count', hint: '近 7 天真的发出去的条数。' },
    { id: 'abstain', label: 'abstain', kind: 'count', hint: '决定"只说话、不发图"的次数。' },
    { id: 'delivery_confirmed', label: 'delivery_confirmed', kind: 'count', hint: '有回执的投递。' },
    { id: 'unknown', label: 'unknown', kind: 'count', hint: '没有回执：不重试，也不算成功。' },
    { id: 'leak', label: 'leak', kind: 'count', hint: '必须恒为 0：不该发却发出去了。' },
    { id: 'p95', label: 'p95', kind: 'ms', hint: '投递耗时 p95；没有记录就是「—」，不估算。' },
  ];

  const MODERATION_LABEL = {
    approved: '已通过',
    review: '待复核',
    quarantined: '已隔离',
    disabled: '已禁用',
    revoked: '已撤销',
  };

  P.css(`
    .cpxp-exp-banner { display:flex; gap:10px; align-items:flex-start; padding:12px 16px; border-radius:12px; border:1px solid var(--dsw-alias-border-l1); background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1)); }
    .cpxp-exp-banner-mark { flex:none; font-weight:700; color:var(--dsw-alias-brand-primary); }
    .cpxp-exp-banner-text { margin:0; font-size:13px; line-height:1.7; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
    .cpxp-exp-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:12px; }
    .cpxp-exp-tile { display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); text-align:left; font:inherit; color:inherit; cursor:pointer; min-width:0; }
    .cpxp-exp-tile:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
    .cpxp-exp-thumb { width:100%; aspect-ratio:1/1; border-radius:8px; object-fit:contain; background:var(--dsw-alias-bg-layer-2); }
    .cpxp-exp-thumb-fallback { width:100%; aspect-ratio:1/1; border-radius:8px; display:grid; place-items:center; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:12px; }
    .cpxp-exp-tile-meta { display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:12px; color:var(--dsw-alias-label-secondary); min-width:0; }
    .cpxp-exp-tile-meta > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
    .cpxp-exp-muted { margin:0; font-size:12.5px; line-height:1.7; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
    .cpxp-exp-row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .cpxp-exp-sheet-block { display:flex; flex-direction:column; gap:10px; margin-bottom:18px; }
    .cpxp-exp-sheet-title { margin:0; font-size:14px; font-weight:650; }
    .cpxp-exp-actions { display:flex; flex-wrap:wrap; gap:8px; }
    .cpxp-exp-metric { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--dsw-alias-border-l1); flex-wrap:wrap; }
    .cpxp-exp-metric-label { font-size:13px; color:var(--dsw-alias-label-secondary); font-family:var(--cpx-mono); }
    .cpxp-exp-metric-value { font-size:15px; font-weight:650; font-variant-numeric:tabular-nums; }
    .cpxp-exp-metric[data-state=danger] .cpxp-exp-metric-value { color:var(--dsw-alias-label-danger,#c0392b); }
    .cpxp-exp-metric-hint { flex:1 1 100%; margin:2px 0 0; font-size:12px; color:var(--dsw-alias-label-secondary); }
    .cpxp-exp-decision { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:14px 16px; border-radius:12px; background:var(--dsw-alias-bg-layer-2); }
    .cpxp-exp-cand { display:flex; flex-direction:column; gap:4px; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-border-l1); min-width:0; }
    .cpxp-exp-cand-rank { font-size:12px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
    .cpxp-exp-mono { font-family:var(--cpx-mono); font-size:12.5px; overflow-wrap:anywhere; }
    .cpxp-exp-group { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:12px 0; border-bottom:1px solid var(--dsw-alias-border-l1); }
    .cpxp-exp-group-id { min-width:120px; font-family:var(--cpx-mono); font-size:13px; }
    .cpxp-exp-group-flags { display:flex; flex-wrap:wrap; gap:14px; }
    @media(max-width:760px) { .cpxp-exp-grid { grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); } }
  `);

  // -------------------------------------------------------------------------
  // 纯函数（单测只测这些，不靠"字符串包含"）
  // -------------------------------------------------------------------------

  function stateLabel(states, id) {
    const found = (states || []).find((item) => item && item.id === id);
    if (found && found.label) return String(found.label);
    return STATE_LABELS[id] || '未知';
  }

  function stateTone(id) {
    return STATE_TONES[id] || 'neutral';
  }

  /** `'GET /api/companion-expression/assets'` → `'api/companion-expression/assets'`。 */
  function apiPath(spec, fallback) {
    const source = String(spec || '');
    const match = source.match(/\s(\S+)$/);
    if (match && String(match[1]).startsWith('/')) return String(match[1]).replace(/^\//, '');
    return `${BASE}${fallback || ''}`;
  }

  /** 指标格式化：缺失一律「—」，绝不用 0 冒充。 */
  function formatMetric(value, kind) {
    if (value === null || value === undefined || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    if (kind === 'percent') return `${Math.round(number * 100)}%`;
    if (kind === 'ms') return number >= 1000 ? `${(number / 1000).toFixed(2)} s` : `${Math.round(number)} ms`;
    if (kind === 'count') return String(number);
    return String(number);
  }

  /**
   * 指标视图：把服务端的 `metrics` 摊成一行一行（顺序固定，缺的写「—」）。
   * 服务端给 null 时页面说"无法计算"，而不是画成 0。
   */
  function metricsView(metrics) {
    const payload = metrics && typeof metrics === 'object' ? metrics : {};
    const delivery = payload.delivery || {};
    const feedback = payload.feedback || {};
    const valueOf = (id) => {
      if (id === 'precision') return payload.precision === undefined ? null : payload.precision;
      if (id === 'context_fit') return payload.context_fit === undefined ? (payload.contextFit ?? null) : payload.context_fit;
      if (id === 'awkward') return payload.awkward === undefined ? (feedback.reject ?? null) : payload.awkward;
      if (id === 'repeat_7d') return payload.repeat7d === undefined ? (payload.repeat_7d ?? null) : payload.repeat7d;
      if (id === 'abstain') return payload.abstain === undefined ? null : payload.abstain;
      if (id === 'delivery_confirmed') return delivery.confirmed === undefined ? null : delivery.confirmed;
      if (id === 'unknown') return delivery.unknown === undefined ? null : delivery.unknown;
      if (id === 'leak') return payload.leak === undefined ? null : payload.leak;
      if (id === 'p95') return payload.p95Ms === undefined ? (payload.p95_ms ?? null) : payload.p95Ms;
      return null;
    };
    const rows = METRIC_ROWS.map((row) => {
      const raw = valueOf(row.id);
      const leakAlarm = row.id === 'leak' && Number(raw) > 0;
      return {
        id: row.id,
        label: row.label,
        hint: row.hint,
        kind: row.kind,
        raw,
        value: formatMetric(raw, row.kind),
        tone: leakAlarm ? 'danger' : '',
      };
    });
    return {
      rows,
      note: String(payload.precisionNote || payload.p95Note || ''),
      windowHours: payload.windowHours === undefined ? null : payload.windowHours,
      unavailable: Array.isArray(payload.unavailable) ? payload.unavailable.map(String) : [],
    };
  }

  /** 决策文案：send / abstain 都说清理由，reasonCode 原样展示（不翻译成猜测）。 */
  function decisionView(decision) {
    const payload = decision && typeof decision === 'object' ? decision : null;
    if (!payload) {
      return { known: false, send: null, title: '还没有模拟结果', reasonCode: '', fitScore: null, why: '' };
    }
    const send = payload.send === true;
    const reasonCode = String(payload.reasonCode === undefined ? (payload.reason_code ?? '') : payload.reasonCode);
    return {
      known: true,
      send,
      title: send ? '会发一张图' : '不发图（只说话）',
      reasonCode,
      fitScore: payload.fitScore === undefined ? (payload.fit_score ?? null) : payload.fitScore,
      why: reasonCode ? `reasonCode：${reasonCode}` : '服务端没有给 reasonCode。',
    };
  }

  /**
   * 模拟结果的完整视图：候选（最多 5）+ 模拟消息 + 常驻声明。
   *
   * 服务端会同时给两份决策：
   *   - `decision`：按**当前**配置（投递总闸多半是关的，所以常常是 abstain-delivery-disabled）；
   *   - `decisionIfEnabled`：假设总闸打开时的决策，这才是"这段话配不配一张图"的答案。
   * 页面把后者当主结论，但必须把"这是假设"写出来，并同时展示真实闸门的结果。
   */
  function simulateView(result) {
    const payload = result && typeof result === 'object' ? result : null;
    if (!payload || payload.ok === false) {
      return {
        ok: false,
        banner: '模拟不会向 QQ 发送任何内容',
        error: payload && payload.error ? String(payload.error.message || '') : '',
        decision: decisionView(null),
        liveDecision: null,
        hypothetical: false,
        candidates: [],
        mode: '',
        message: '',
        planText: '',
        partsCount: 0,
      };
    }
    const hypothetical = payload.decisionIfEnabled && typeof payload.decisionIfEnabled === 'object' ? payload.decisionIfEnabled : null;
    const live = payload.decision && typeof payload.decision === 'object' ? payload.decision : null;
    const primary = hypothetical || live;
    const candidates = (Array.isArray(payload.candidates) ? payload.candidates : []).slice(0, 5).map((item, index) => ({
      rank: index + 1,
      assetId: String((item && (item.assetId || item.id)) || ''),
      summary: String((item && (item.summary || item.literal)) || '（无语义摘要）'),
      intents: Array.isArray(item && item.intents) ? item.intents.map(String).slice(0, 4) : [],
      avoidWhen: Array.isArray(item && (item.avoidWhen || item.avoid_when)) ? (item.avoidWhen || item.avoid_when).map(String).slice(0, 3) : [],
      score: item && Number.isFinite(Number(item.score)) ? Number(item.score) : null,
    }));
    const plan = payload.plan && typeof payload.plan === 'object' ? payload.plan : null;
    const parts = plan && Array.isArray(plan.parts) ? plan.parts : [];
    const sticker = parts.find((part) => part && part.kind === 'sticker');
    const textPart = parts.find((part) => part && part.kind === 'text');
    return {
      ok: true,
      banner: '模拟不会向 QQ 发送任何内容',
      error: '',
      sending: false,
      hypothetical: Boolean(hypothetical),
      decision: decisionView(primary),
      liveDecision: live ? decisionView(live) : null,
      hypotheticalNote: String(payload.hypotheticalNote || (hypothetical ? '这一条是「假设投递总闸打开」的结论，不是真的发送。' : '')),
      scopeNote: String(payload.scopeNote || ''),
      candidates,
      mode: plan ? String(plan.mode || '') : '',
      // parts 里文本段的字段是 `content`（planner.mjs），不是 `text`。
      message: textPart ? String(textPart.content || textPart.text || '') : '',
      planText: sticker
        ? `会用的素材：${String(sticker.assetId || '（未指定）')}`
        : (plan ? `本轮计划：${String(plan.mode || '未说明')}` : '没有生成计划（决策是「只说话」或没有候选）'),
      partsCount: parts.length,
    };
  }

  /** 图库网格的视图：只保留可渲染字段；行里不会有 file_path（服务端已经剥掉）。 */
  function assetGrid(data) {
    const payload = data && typeof data === 'object' ? data : {};
    const items = (Array.isArray(payload.items) ? payload.items : []).map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      const createdAt = row.createdAt === undefined ? (row.created_at ?? null) : row.createdAt;
      return {
        assetId: String(row.assetId || row.id || ''),
        literal: String(row.literal || row.summary || '').slice(0, 120),
        moderation: String(row.moderationState || row.moderation_state || row.moderation || ''),
        kind: String(row.kind || ''),
        scope: String(row.scope || row.sourceScope || ''),
        scopeLabel: String(row.scopeLabel || row.label || ''),
        createdAt,
        deliveries: Number.isFinite(Number(row.deliveries)) ? Number(row.deliveries) : null,
      };
    }).filter((item) => item.assetId);
    return {
      items,
      total: Number(payload.total === undefined ? items.length : payload.total),
      empty: items.length === 0 ? String(payload.note || '图库还没有素材：授权来源之后才会开始被动收集。') : '',
    };
  }

  /** 服务端"未启用"的几种形状（200 + expression-disabled、404、503）都认。 */
  function isDisabledAnswer(status, payload) {
    const error = payload && payload.error ? payload.error : null;
    const code = String((error && error.code) || '');
    if (code === 'expression-disabled' || code === 'module-disabled' || code === 'no-connection' || code === 'not-registered') return true;
    return Number(status) === 404 || Number(status) === 503;
  }

  /** 收集规则的分组视图：群（三开关）与对端（单开关）分开。 */
  function grantsView(sources) {
    const payload = sources && typeof sources === 'object' ? sources : {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    const groups = items.filter((item) => String(item && item.kind) === 'group').map((item) => ({
      chatId: Number(item.chatId === undefined ? String(item.scope || '').replace('group:', '') : item.chatId),
      scope: String(item.scope || ''),
      capture: item.capture === true,
      store: item.store === true,
      use: item.use === true,
      assets: Number(item.assets === undefined ? 0 : item.assets),
    })).filter((item) => Number.isFinite(item.chatId) && item.chatId > 0);
    const peers = items.filter((item) => String(item && item.kind) === 'peer').map((item) => ({
      chatId: Number(item.chatId === undefined ? 0 : item.chatId),
      scope: String(item.scope || ''),
      granted: item.granted === true,
      label: String(item.label || item.describe || ''),
      assets: Number(item.assets === undefined ? 0 : item.assets),
    })).filter((item) => Number.isFinite(item.chatId) && item.chatId > 0);
    return {
      groups,
      peers,
      empty: groups.length === 0 && peers.length === 0 ? '还没有任何授权来源。' : '',
    };
  }

  /** P.ui 的 onChange 有的给值、有的给事件。 */
  function readValue(input, fallback) {
    if (input && typeof input === 'object' && input.target && 'value' in input.target) return input.target.value;
    if (typeof input === 'string' || typeof input === 'number') return input;
    return fallback;
  }

  /** 记录时间：ISO 或 epoch 毫秒（deliveries.at 是毫秒）。 */
  function toMillis(value) {
    if (value === null || value === undefined || value === '') return NaN;
    if (typeof value === 'number' && Number.isFinite(value)) return value > 1e11 ? value : NaN;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 1e11) return numeric;
    const parsed = new Date(String(value)).getTime();
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  /** 计数：缺值给「—」，真的 0 给 0。注意 `Number(null)` 是 0，所以先挡掉空值。 */
  function countOrDash(value) {
    if (value === null || value === undefined || value === '') return '—';
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : '—';
  }

  function moderationText(value) {
    return MODERATION_LABEL[String(value)] || String(value) || '未知';
  }

  // -------------------------------------------------------------------------
  // 网络：`{ok, ...}` 平铺信封，端点取自 descriptor
  // -------------------------------------------------------------------------

  function urlOf(path) {
    try {
      return new URL(path, document.baseURI).href;
    } catch {
      return `/${path}`;
    }
  }

  /** 永不抛：返回 { ok, status, payload }，调用方自己决定怎么说（与 pages-media.js 同一套）。 */
  function request(path, method, body) {
    const hasBody = body !== undefined;
    return fetch(urlOf(path), {
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

  function asError(result, fallback) {
    const error = (result && result.payload && result.payload.error) || {};
    return new P.ApiError(
      error.message || fallback || `表情包接口没有完成（HTTP ${result ? result.status : '?'}）。`,
      result ? result.status : 0,
      error.code || (result && result.badJson ? 'bad-response' : 'unknown'),
    );
  }

  /** 先读 page（端点也在它里面），再按 `api.config` / `api.sources` 读配置与来源。 */
  function loadPage() {
    return request(`${BASE}page`).then((page) => {
      if (!page.payload || page.payload.ok !== true) throw asError(page, '读不到表情包的页面描述。');
      const descriptor = page.payload.page || {};
      const api = descriptor.api || {};
      return Promise.all([
        request(apiPath(api.config, 'config')),
        request(apiPath(api.sources, 'sources')),
      ]).then(([config, sources]) => ({
        descriptor,
        config: config.payload && config.payload.ok === true ? config.payload : null,
        sources: sources.payload && sources.payload.ok === true ? sources.payload : null,
        api,
      }));
    });
  }

  function thumbUrl(assetId, allowQuarantine) {
    const suffix = allowQuarantine ? '&allowQuarantine=1' : '';
    return `${BASE}thumb?assetId=${encodeURIComponent(String(assetId))}${suffix}`;
  }

  // -------------------------------------------------------------------------
  // 小组件
  // -------------------------------------------------------------------------

  function Banner({ text: label }) {
    return h('div', { className: 'cpxp-exp-banner', role: 'note' },
      h('span', { className: 'cpxp-exp-banner-mark', 'aria-hidden': 'true' }, 'ⓘ'),
      h('p', { className: 'cpxp-exp-banner-text' }, label));
  }

  /** 缩略图：加载失败就说失败，不留一个"永远正在加载"的空框。 */
  function Thumb({ assetId, allowQuarantine }) {
    const [broken, setBroken] = P.useState(false);
    if (broken) return h('div', { className: 'cpxp-exp-thumb-fallback' }, '缩略图读不到');
    return h('img', {
      className: 'cpxp-exp-thumb',
      src: thumbUrl(assetId, allowQuarantine),
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      onError: () => setBroken(true),
    });
  }

  function AssetTile({ item, onOpen }) {
    const tileMeta = [];
    tileMeta.push(h('span', { key: 'scope' }, item.scopeLabel || item.scope || '来源未知'));
    if (item.moderation) {
      const tone = item.moderation === 'approved' ? 'ok' : (item.moderation === 'quarantined' ? 'danger' : 'warn');
      tileMeta.push(h(ui.Badge, { key: 'mod', tone }, moderationText(item.moderation)));
    }
    return h('button', {
      type: 'button',
      className: 'cpxp-exp-tile',
      'aria-label': `打开素材 ${item.assetId}`,
      onClick: () => onOpen(item.assetId),
    },
    h(Thumb, { assetId: item.assetId, allowQuarantine: item.moderation === 'quarantined' }),
    h('div', { className: 'cpxp-exp-tile-meta' }, tileMeta),
    // assetId 是页面上唯一的素材身份：显示前 12 个字符，方便和日志/投递记录对上。
    h('div', { className: 'cpxp-exp-tile-meta' },
      h('span', { className: 'cpxp-exp-mono' }, shortId(item.assetId))),
    item.literal ? h('div', { className: 'cpxp-exp-tile-meta' }, h('span', null, item.literal)) : null);
  }

  /** assetId 在页面上的短形式：前 12 个字符 + 省略号。 */
  function shortId(value) {
    const text = String(value || '');
    if (!text) return '';
    return text.length <= 14 ? text : `${text.slice(0, 12)}…`;
  }

  // -------------------------------------------------------------------------
  // 单图抽屉
  // -------------------------------------------------------------------------

  function AssetSheet({ assetId, open, api, onClose, onChanged }) {
    const detail = P.useApi(() => request(`${apiPath(api.asset, 'asset')}?assetId=${encodeURIComponent(String(assetId))}`)
      .then((response) => {
        if (!response.payload || response.payload.ok !== true) throw asError(response, '读不到这个素材。');
        return response.payload;
      }), [assetId], { enabled: Boolean(open && assetId) });
    const [busy, setBusy] = P.useState('');
    const [error, setError] = P.useState(null);
    const [cardDraft, setCardDraft] = P.useState(null);

    const payload = detail.data || null;
    const asset = payload && payload.asset ? payload.asset : null;
    const card = payload && payload.card ? payload.card : null;
    const sources = payload && Array.isArray(payload.sources) ? payload.sources : [];
    const deliveries = payload && Array.isArray(payload.deliveries) ? payload.deliveries : [];
    const feedback = payload && Array.isArray(payload.feedback) ? payload.feedback : [];

    const run = (action, extra) => {
      if (action === 'delete' && typeof P.confirm === 'function') {
        if (!P.confirm('删除这条素材？会删掉条目并写审计，不可撤销。')) return;
      }
      setBusy(action);
      setError(null);
      request(apiPath(api.action, 'asset'), 'POST', { assetId, action, ...(extra || {}) }).then((response) => {
        setBusy('');
        if (!response.payload || response.payload.ok !== true) {
          setError(asError(response, '动作没有完成。'));
          return;
        }
        if (typeof P.notice === 'function') P.notice('已提交', 'ok');
        onChanged();
        if (action === 'delete') { onClose(); return; }
        detail.reload();
      }, () => {
        setBusy('');
        setError(new P.ApiError('网络请求没有完成。', 0, 'network'));
      });
    };

    const cardBlock = card
      ? h(ui.KeyValue, {
        items: [
          { k: '字面', v: String(card.literal || '（空）') },
          { k: '意图', v: (card.intents || []).join('、') || '—' },
          { k: '情绪', v: (card.emotions || []).join('、') || '—' },
          { k: '语气', v: (card.tone || []).join('、') || '—' },
          { k: '场景', v: (card.scenes || []).join('、') || '—' },
          { k: '忌讳场景', v: (card.avoidWhen || card.avoid_when || []).join('、') || '—' },
          { k: '置信度', v: formatMetric(card.confidence, 'percent') },
        ],
      })
      : h('p', { className: 'cpxp-exp-muted' }, '还没有语义卡：分析管线还没处理这条素材。');

    const editBlock = cardDraft
      ? [
        h(ui.Field, { key: 'literal', label: '字面（这张图「说了什么」）' },
          h(ui.Input, {
            value: cardDraft.literal,
            ariaLabel: '字面',
            onChange: (input) => setCardDraft({ ...cardDraft, literal: readValue(input, cardDraft.literal) }),
          })),
        h(ui.Field, { key: 'intents', label: '意图（用「、」分隔）' },
          h(ui.Input, {
            value: cardDraft.intents,
            ariaLabel: '意图',
            onChange: (input) => setCardDraft({ ...cardDraft, intents: readValue(input, cardDraft.intents) }),
          })),
      ]
      : [];

    const body = (() => {
      if (!open || !assetId) return null;
      if (detail.loading && !payload) return h(ui.Skeleton, { rows: 4 });
      if (detail.error) {
        return h(ui.Callout, { tone: 'danger', title: '读不到这个素材' },
          h('span', null, P.failText(detail.error, '素材详情没有返回。')));
      }
      return [
        h('div', { key: 'head', className: 'cpxp-exp-sheet-block' },
          h(Thumb, { assetId, allowQuarantine: true }),
          h('div', { className: 'cpxp-exp-row' },
            asset && asset.moderationState ? h(ui.Badge, { tone: asset.moderationState === 'approved' ? 'ok' : 'warn' }, moderationText(asset.moderationState)) : null,
            asset && asset.kind ? h(ui.Badge, { tone: 'neutral' }, String(asset.kind)) : null,
            asset && asset.mime ? h(ui.Badge, { tone: 'neutral' }, String(asset.mime)) : null,
            asset && Number.isFinite(Number(asset.byteSize || asset.byte_size))
              ? h(ui.Badge, { tone: 'neutral' }, P.fmt.bytes(Number(asset.byteSize || asset.byte_size)))
              : null),
          h('p', { className: 'cpxp-exp-muted cpxp-exp-mono' }, String(assetId))),
        h('div', { key: 'card', className: 'cpxp-exp-sheet-block' },
          h('h4', { className: 'cpxp-exp-sheet-title' }, '语义卡'),
          cardBlock,
          h('div', { className: 'cpxp-exp-actions' },
            h(ui.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: Boolean(busy),
              onClick: () => setCardDraft(cardDraft ? null : {
                literal: String((card && card.literal) || ''),
                intents: (card && Array.isArray(card.intents) ? card.intents : []).join('、'),
              }),
            }, cardDraft ? '取消改写' : '改写语义卡'),
            cardDraft
              ? h(ui.Button, {
                variant: 'primary',
                size: 'sm',
                loading: busy === 'edit-card',
                disabled: Boolean(busy),
                onClick: () => run('edit-card', {
                  card: {
                    literal: String(cardDraft.literal || ''),
                    intents: String(cardDraft.intents || '').split(/[、,，\s]+/).filter(Boolean),
                  },
                }),
              }, '保存语义卡')
              : null),
          editBlock),
        h('div', { key: 'sources', className: 'cpxp-exp-sheet-block' },
          h('h4', { className: 'cpxp-exp-sheet-title' }, '来源'),
          sources.length
            ? h(ui.List, { label: '素材来源' }, sources.map((item, index) => h(ui.Row, {
              key: `${item.scope}-${index}`,
              title: String(item.label || item.describe || item.scope || '未知来源'),
              meta: item.firstSeen || item.first_seen
                ? h(ui.Timestamp, { at: item.firstSeen || item.first_seen, prefix: '首次' })
                : null,
            })))
            : h('p', { className: 'cpxp-exp-muted' }, '没有来源记录。')),
        h('div', { key: 'deliveries', className: 'cpxp-exp-sheet-block' },
          h('h4', { className: 'cpxp-exp-sheet-title' }, '最近投递'),
          deliveries.length
            ? h(ui.List, { label: '最近投递' }, deliveries.map((item, index) => h(ui.Row, {
              key: `${item.planId || 'plan'}-${index}`,
              title: String(item.status || '未知状态'),
              meta: [String(item.scopeLabel || item.scope || ''), String(item.reasonCode || '')].filter(Boolean).join(' · '),
              side: h(ui.Timestamp, { at: item.at }),
            })))
            : h('p', { className: 'cpxp-exp-muted' }, '还没有投递记录：这条素材一次都没发出去过。')),
        h('div', { key: 'feedback', className: 'cpxp-exp-sheet-block' },
          h('h4', { className: 'cpxp-exp-sheet-title' }, '反馈'),
          feedback.length
            ? h(ui.List, { label: '反馈' }, feedback.map((item, index) => h(ui.Row, {
              key: `${item.id || 'fb'}-${index}`,
              title: String(item.signal || '未知信号'),
              meta: String(item.note || ''),
              side: h(ui.Timestamp, { at: item.at }),
            })))
            : h('p', { className: 'cpxp-exp-muted' }, '还没有显式反馈。')),
        error
          ? h('div', { key: 'error' }, h(ui.Callout, { tone: 'danger', title: '动作没有完成' }, h('span', null, P.failText(error))))
          : null,
      ];
    })();

    return h(ui.Sheet, {
      open: Boolean(open && assetId),
      title: '素材详情',
      subtitle: asset && asset.moderationState ? moderationText(asset.moderationState) : '正在读取…',
      onClose,
      width: 'min(640px, 94vw)',
      footer: h('div', { className: 'cpxp-exp-actions' }, ACTIONS.map((action) => h(ui.Button, {
        key: action.id,
        variant: action.tone === 'primary' ? 'primary' : 'ghost',
        size: 'sm',
        loading: busy === action.id,
        disabled: Boolean(busy),
        title: action.hint,
        onClick: () => run(action.id),
      }, action.label))),
    }, body);
  }

  // -------------------------------------------------------------------------
  // 页签一：图库
  // -------------------------------------------------------------------------

  function LibraryPage({ shared }) {
    const api = shared.api || {};
    const states = shared.descriptor.states || [];
    const [draft, setDraft] = P.useState('');
    const [query, setQuery] = P.useState('');
    const [moderation, setModeration] = P.useState('');
    const [sort, setSort] = P.useState('newest');
    const [selected, setSelected] = P.useState('');

    const listApi = P.useApi(() => {
      const params = new URLSearchParams();
      if (query) params.set('query', query);
      if (moderation) params.set('moderation', moderation);
      params.set('sort', sort);
      params.set('limit', '60');
      return request(`${apiPath(api.assets, 'assets')}?${params.toString()}`).then((response) => {
        if (!response.payload || response.payload.ok !== true) throw asError(response, '读不到图库。');
        return response.payload;
      });
    }, [query, moderation, sort], { enabled: !shared.disabled });

    const grid = assetGrid(listApi.data);

    const moderationOptions = [
      { id: '', label: '全部状态' },
      { id: 'approved', label: '已通过' },
      { id: 'review', label: '待复核' },
      { id: 'quarantined', label: '已隔离' },
      { id: 'disabled', label: '已禁用' },
    ];
    const sortOptions = [
      { id: 'newest', label: '最近' },
      { id: 'oldest', label: '最早' },
      { id: 'used', label: '用得最多' },
    ];

    const body = (() => {
      if (shared.disabled) return h(ui.Empty, { title: '模块未启用', hint: '打开 modules.expression 后这里才有图库。' });
      if (listApi.error) return h(ui.ErrorBox, { error: listApi.error, onRetry: listApi.reload });
      if (listApi.loading && !listApi.data) return h(ui.Skeleton, { rows: 4 });
      if (!grid.items.length) {
        return h(ui.Empty, {
          title: '还没有素材',
          hint: grid.empty || '图库是空的：被动收集只在授权来源之后开始，而且不会自动去抓任何东西。',
          action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: listApi.reload }, '重新读取'),
        });
      }
      return h('div', { className: 'cpxp-exp-grid' }, grid.items.map((item) => h(AssetTile, {
        key: item.assetId,
        item,
        onOpen: (assetId) => setSelected(assetId),
      })));
    })();

    const filterRow = h(ui.Toolbar, {
      label: '图库筛选',
      right: h(ui.Segmented, {
        label: '排序',
        options: sortOptions,
        value: sort,
        onChange: (next) => setSort(readValue(next, sort) || 'newest'),
      }),
    }, [
      h(ui.Search, {
        key: 'q',
        value: draft,
        label: '搜索图库',
        placeholder: '搜索语义卡关键词…',
        onChange: (input) => setDraft(readValue(input, draft)),
        onEnter: () => setQuery(draft),
      }),
      h(ui.Segmented, {
        key: 'mod',
        label: '审核状态',
        options: moderationOptions,
        value: moderation,
        onChange: (next) => setModeration(readValue(next, moderation)),
      }),
    ]);

    return h(ui.Page, {
      title: '图库',
      lead: '被动收集到的素材与它们的语义卡。这里只按 assetId 操作，看不到也不需要文件路径。',
      status: h('span', { className: 'cpxp-exp-muted' },
        `共 ${countOrDash(grid.total)} 条`,
        shared.descriptor.state ? ` · ${stateLabel(states, shared.descriptor.state)}` : ''),
      actions: h(ui.Button, { variant: 'primary', loading: Boolean(listApi.loading), onClick: listApi.reload }, '刷新'),
    }, [
      h(ui.Band, {
        key: 'filters',
        flush: true,
        title: '筛选',
        info: '搜索与筛选改动后立即查询，没有「查询」按钮。缩略图按需加载，点一张才读它的字节。',
      }, [filterRow]),
      h(ui.Band, {
        key: 'assets',
        title: '素材',
        hint: shared.descriptor.meta && shared.descriptor.meta.assetIdOnly ? String(shared.descriptor.meta.assetIdOnly) : '',
      }, [body]),
      h(AssetSheet, {
        key: 'sheet',
        assetId: selected,
        open: Boolean(selected),
        api,
        onClose: () => setSelected(''),
        onChanged: listApi.reload,
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // 页签二：收集规则
  // -------------------------------------------------------------------------

  function RulesPage({ shared }) {
    const api = shared.api || {};
    const config = shared.config && shared.config.config ? shared.config.config : null;
    const [draft, setDraft] = P.useState({});
    const [groupId, setGroupId] = P.useState('');
    const [peerId, setPeerId] = P.useState('');
    const [busy, setBusy] = P.useState('');
    const [error, setError] = P.useState(null);

    P.useEffect(() => { setDraft({}); }, [config]);

    const valueOf = (path, fallback) => {
      if (path in draft) return draft[path];
      const parts = String(path).split('.');
      let node = config;
      for (const part of parts) {
        if (node === null || node === undefined) return fallback;
        node = node[part];
      }
      return node === undefined || node === null ? fallback : node;
    };
    const setValue = (path, next) => setDraft((previous) => ({ ...previous, [path]: next }));
    const dirty = Object.keys(draft).length > 0;

    const patchOf = () => {
      const patch = {};
      for (const [path, value] of Object.entries(draft)) {
        const parts = String(path).split('.');
        let node = patch;
        for (let index = 0; index < parts.length - 1; index += 1) {
          if (!node[parts[index]] || typeof node[parts[index]] !== 'object') node[parts[index]] = {};
          node = node[parts[index]];
        }
        node[parts[parts.length - 1]] = value;
      }
      return patch;
    };

    const save = () => {
      if (!dirty) return;
      setBusy('save');
      setError(null);
      request(apiPath(api.save, 'config'), 'POST', { patch: patchOf() }).then((response) => {
        setBusy('');
        if (!response.payload || response.payload.ok !== true) {
          setError(asError(response, '保存没有完成。'));
          return;
        }
        setDraft({});
        if (typeof P.notice === 'function') P.notice('规则已保存', 'ok');
        shared.reload();
      }, () => {
        setBusy('');
        setError(new P.ApiError('网络请求没有完成。', 0, 'network'));
      });
    };

    const grant = (input) => {
      setBusy('grant');
      setError(null);
      request(apiPath(api.grants, 'grants'), 'POST', input).then((response) => {
        setBusy('');
        if (!response.payload || response.payload.ok !== true) {
          setError(asError(response, '授权没有保存。'));
          return;
        }
        if (typeof P.notice === 'function') P.notice(response.payload.note || '已保存', 'ok');
        shared.reload();
      }, () => {
        setBusy('');
        setError(new P.ApiError('网络请求没有完成。', 0, 'network'));
      });
    };

    const sources = grantsView(shared.sources);

    const switchRow = (label, path, hint) => h('div', { key: path, className: 'cpxp-exp-row' },
      h(ui.Toggle, {
        checked: valueOf(path, false) === true,
        label,
        hint,
        disabled: Boolean(busy) || shared.disabled,
        onChange: (next) => setValue(path, next === true),
      }));

    const numberField = (label, path) => h(ui.Field, { key: path, label, id: `exp-${path}` },
      h(ui.Input, {
        id: `exp-${path}`,
        type: 'number',
        ariaLabel: label,
        value: String(valueOf(path, '') ?? ''),
        disabled: Boolean(busy) || shared.disabled,
        onChange: (input) => {
          const raw = readValue(input, '');
          setValue(path, raw === '' ? '' : Number(raw));
        },
      }));

    const groupRows = sources.groups.map((group) => h('div', { key: group.scope, className: 'cpxp-exp-group' }, [
      h('span', { key: 'id', className: 'cpxp-exp-group-id' }, `群 ${group.chatId}`),
      h('div', { key: 'flags', className: 'cpxp-exp-group-flags' }, GROUP_FLAGS.map((flag) => h(ui.Toggle, {
        key: flag.id,
        checked: group[flag.id] === true,
        label: flag.label,
        hint: flag.hint,
        disabled: Boolean(busy),
        onChange: (next) => grant({
          kind: 'group',
          chatId: group.chatId,
          granted: true,
          capture: flag.id === 'capture' ? next === true : group.capture,
          store: flag.id === 'store' ? next === true : group.store,
          use: flag.id === 'use' ? next === true : group.use,
        }),
      }))),
      h('span', { key: 'count', className: 'cpxp-exp-muted' }, `素材 ${countOrDash(group.assets)} 条`),
      h(ui.Button, {
        key: 'revoke',
        variant: 'ghost',
        size: 'sm',
        disabled: Boolean(busy),
        onClick: () => grant({ kind: 'group', chatId: group.chatId, granted: false, keepAssets: false }),
      }, '撤销并清理'),
    ]));

    const peerRows = sources.peers.map((peer) => h(ui.Row, {
      key: peer.scope,
      title: peer.label || `对端 ${peer.chatId}`,
      meta: `素材 ${countOrDash(peer.assets)} 条`,
      side: h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        disabled: Boolean(busy),
        onClick: () => grant({ kind: 'peer', chatId: peer.chatId, granted: false }),
      }, '撤销'),
    }));

    const body = (() => {
      if (!config) return h(ui.Skeleton, { rows: 4 });
      return [
        h(ui.Band, {
          key: 'masters',
          title: '总闸',
          info: '私聊收集默认只对主人开启；群收集必须逐群授权；投递总闸默认关。',
        }, [
          switchRow('采集总开关', 'enabled', '关掉后整条被动收集链都停'),
          switchRow('主人私聊里的图片可以收集', 'capture.ownerPrivate'),
          switchRow('群聊收集总开关（逐群仍需单独授权）', 'capture.groupEnabled'),
          switchRow('允许把图真发出去', 'delivery.enabled', '这是唯一能让人收到图的开关；关着时决策与模拟照常可用'),
        ]),
        h(ui.Band, {
          key: 'groups',
          title: '群聊授权',
          hint: sources.empty,
          info: '每个群有三个独立开关：收集（收图时下载）、入库（写进图库）、可用（允许从它的素材里挑图）。撤销时素材怎么办由 privacy.deleteOnRevocation 决定。',
        }, [
          h('div', { key: 'add', className: 'cpxp-exp-row' }, [
            h(ui.Input, {
              key: 'id',
              value: groupId,
              ariaLabel: '群号',
              placeholder: '群号（正整数）',
              onChange: (input) => setGroupId(String(readValue(input, groupId) ?? '')),
            }),
            h(ui.Button, {
              key: 'go',
              variant: 'primary',
              size: 'sm',
              disabled: Boolean(busy) || !String(groupId).trim(),
              onClick: () => grant({ kind: 'group', chatId: Number(groupId), granted: true, capture: true, store: true, use: true }),
            }, '授权这个群'),
            h('span', { key: 'hint', className: 'cpxp-exp-muted' }, '新增的群默认三项全开；可以逐项关掉。'),
          ]),
          groupRows.length ? groupRows : null,
        ]),
        h(ui.Band, {
          key: 'peers',
          title: '私聊对端授权',
          hint: sources.peers.length ? '' : '还没有授权任何非主人私聊：默认一律不收集。',
          info: '对端私聊的 scope 是加盐哈希，这里不会显示、也不会回推 QQ 号。',
        }, [
          h('div', { key: 'add', className: 'cpxp-exp-row' }, [
            h(ui.Input, {
              key: 'id',
              value: peerId,
              ariaLabel: '对端账号',
              placeholder: '对端账号（正整数）',
              onChange: (input) => setPeerId(String(readValue(input, peerId) ?? '')),
            }),
            h(ui.Button, {
              key: 'go',
              variant: 'primary',
              size: 'sm',
              disabled: Boolean(busy) || !String(peerId).trim(),
              onClick: () => grant({ kind: 'peer', chatId: Number(peerId), granted: true }),
            }, '授权这个对端'),
          ]),
          peerRows.length ? h(ui.List, { key: 'list', label: '已授权的私聊对端' }, peerRows) : null,
        ]),
        h(ui.Band, {
          key: 'limits',
          title: '限流与阈值',
          info: '这些数字是基线，不是固定频率；按人工评估迭代。超出范围的值会被服务端拒绝，页面不会悄悄改成别的数。',
        }, [
          h('div', { key: 'fields', className: 'cpxp-exp-grid' }, [
            numberField('每小时最多收集几个', 'capture.maxPerHour'),
            numberField('分析置信度下限（0–1）', 'analysis.minConfidence'),
            numberField('给模型的候选数量（3–5）', 'retrieval.candidatesToModel'),
            numberField('契合度阈值（0–1）', 'retrieval.minFitScore'),
            numberField('每轮最多发几张（0–3）', 'delivery.maxPerTurn'),
            numberField('私聊冷却（秒）', 'delivery.dmCooldownSeconds'),
            numberField('群聊冷却（秒）', 'delivery.groupCooldownSeconds'),
            numberField('私聊每小时上限', 'delivery.maxDmPerHour'),
            numberField('群聊每小时上限', 'delivery.maxGroupPerHour'),
            numberField('私聊同图抑制（小时）', 'delivery.repeatWindowDmHours'),
            numberField('群聊同图抑制（小时）', 'delivery.repeatWindowGroupHours'),
          ]),
        ]),
        h(ui.Band, {
          key: 'stage',
          title: '临时目录',
          info: '只读：路径由模块自己校验，必须是 home/media 内的相对路径。页面不提交它。',
        }, [h('p', { key: 'path', className: 'cpxp-exp-muted cpxp-exp-mono' }, String(config.delivery && config.delivery.stageRoot ? config.delivery.stageRoot : '—'))]),
      ];
    })();

    return h(ui.Page, {
      title: '收集规则',
      lead: '这里决定谁能送来素材、素材能不能进库、以及限流与冷却的基线。改动保存即生效。',
      status: h('span', { className: 'cpxp-exp-muted' }, dirty ? '有未保存的修改' : '已保存'),
      actions: h(ui.Button, {
        variant: 'primary',
        loading: busy === 'save',
        disabled: !dirty || Boolean(busy),
        onClick: save,
      }, '保存规则'),
    }, [
      shared.disabled
        ? h(ui.Callout, { key: 'disabled', tone: 'warn', title: '模块未启用' }, h('span', null, '打开 modules.expression 后这里才能读写。'))
        : null,
      error
        ? h(ui.Callout, { key: 'error', tone: 'danger', title: '保存没有完成' }, h('span', null, P.failText(error)))
        : null,
      body,
    ]);
  }

  // -------------------------------------------------------------------------
  // 页签三：自然度实验室
  // -------------------------------------------------------------------------

  function LabPage({ shared }) {
    const api = shared.api || {};
    const [draft, setDraft] = P.useState('');
    const [isGroup, setIsGroup] = P.useState(false);
    const [target, setTarget] = P.useState('');
    const [result, setResult] = P.useState(null);
    const [busy, setBusy] = P.useState(false);
    const [error, setError] = P.useState(null);

    const run = () => {
      if (!String(draft).trim()) {
        setError(new P.ApiError('先写一段聊天片段再模拟。', 0, 'bad-input'));
        return;
      }
      setBusy(true);
      setError(null);
      request(apiPath(api.simulate, 'simulate'), 'POST', {
        text: String(draft).slice(0, 2000),
        isGroup,
        target: String(target).trim(),
      }).then((response) => {
        setBusy(false);
        if (!response.payload || response.payload.ok !== true) {
          setResult(null);
          setError(asError(response, '模拟没有完成。'));
          return;
        }
        setResult(response.payload);
      }, () => {
        setBusy(false);
        setError(new P.ApiError('网络请求没有完成。', 0, 'network'));
      });
    };

    const view = simulateView(result);

    const resultBody = (() => {
      if (!result) {
        return h(ui.Empty, { title: '还没有结果', hint: '模拟是显式动作，不会在加载页面时自动跑。' });
      }
      const decisionRow = h('div', { key: 'decision', className: 'cpxp-exp-decision' }, [
        h(ui.Badge, { key: 'badge', tone: view.decision.send ? 'ok' : 'neutral' }, view.decision.title),
        h('span', { key: 'why', className: 'cpxp-exp-muted' }, view.decision.why),
        view.decision.fitScore !== null
          ? h('span', { key: 'fit', className: 'cpxp-exp-muted' }, `契合度 ${formatMetric(view.decision.fitScore, 'percent')}`)
          : null,
      ]);
      // 真实闸门的结论单独一行：两边都摆出来，避免把"假设打开总闸"读成"已经发了"。
      const liveRow = view.hypothetical && view.liveDecision
        ? h('p', { key: 'live', className: 'cpxp-exp-muted' },
          `按当前配置（投递总闸${view.liveDecision.send ? '开着' : '关着'}）：${view.liveDecision.title}${view.liveDecision.reasonCode ? ` · ${view.liveDecision.reasonCode}` : ''}`)
        : null;
      const candidateCards = view.candidates.map((candidate) => h('div', { key: `${candidate.rank}-${candidate.assetId}`, className: 'cpxp-exp-cand' }, [
        h('span', { key: 'rank', className: 'cpxp-exp-cand-rank' }, `#${candidate.rank}${candidate.score === null ? '' : ` · ${formatMetric(candidate.score, 'percent')}`}`),
        candidate.assetId ? h(ui.Badge, { key: 'id', tone: 'neutral' }, candidate.assetId) : null,
        h('span', { key: 'summary', className: 'cpxp-exp-muted' }, candidate.summary),
        candidate.intents.length ? h('span', { key: 'intents', className: 'cpxp-exp-muted' }, `意图：${candidate.intents.join('、')}`) : null,
        candidate.avoidWhen.length ? h('span', { key: 'avoid', className: 'cpxp-exp-muted' }, `忌讳：${candidate.avoidWhen.join('、')}`) : null,
      ]));
      return [
        decisionRow,
        liveRow,
        view.hypotheticalNote ? h('p', { key: 'hypo', className: 'cpxp-exp-muted' }, view.hypotheticalNote) : null,
        h('p', { key: 'banner', className: 'cpxp-exp-muted' }, view.banner),
        view.scopeNote ? h('p', { key: 'scope', className: 'cpxp-exp-muted' }, view.scopeNote) : null,
        view.planText ? h('p', { key: 'plan', className: 'cpxp-exp-muted' }, view.planText) : null,
        view.message ? h('p', { key: 'message', className: 'cpxp-exp-muted' }, `会发的那句话：${view.message}`) : null,
        candidateCards.length
          ? h('div', { key: 'cands', className: 'cpxp-exp-grid' }, candidateCards)
          : h('p', { key: 'nocand', className: 'cpxp-exp-muted' }, '没有候选：服务端在硬门之后没有剩下可用的素材。'),
      ];
    })();

    return h(ui.Page, {
      title: '自然度实验室',
      lead: '给一段聊天片段，看系统会不会发图、发哪张、以及理由。这里没有任何投递路径。',
      status: h('span', { className: 'cpxp-exp-muted' }, '只读模拟'),
      actions: h(ui.Button, {
        variant: 'primary',
        loading: busy,
        disabled: busy || shared.disabled || !String(draft).trim(),
        onClick: run,
      }, '模拟一次'),
    }, [
      // 常驻声明：不在任何条件下隐藏，也不是可以关掉的提示条。
      h(Banner, { key: 'banner', text: '模拟不会向 QQ 发送任何内容：这里只算决策与候选，投递接口在另一条链上，且默认关着。' }),
      shared.disabled
        ? h(ui.Callout, { key: 'disabled', tone: 'warn', title: '模块未启用' }, h('span', null, '打开 modules.expression 后模拟才有检索与决策可算。'))
        : null,
      h(ui.Band, {
        key: 'input',
        title: '输入',
        info: '语义务实：真实聊天里的一句就够。开「群聊」时决策会按群规则（冷却 600s、2 张/时）走。',
      }, [
        h(ui.Field, { key: 'text', label: '聊天片段', hint: '最多 2000 字；不会写进任何库，也不会发给模型。' },
          h(ui.TextArea, {
            value: draft,
            rows: 4,
            ariaLabel: '聊天片段',
            disabled: Boolean(busy),
            placeholder: '例如：今天好累啊，但是晚上还得加班…',
            onChange: (input) => setDraft(readValue(input, draft)),
          })),
        h('div', { key: 'row', className: 'cpxp-exp-row' }, [
          h(ui.Toggle, {
            key: 'group',
            checked: isGroup,
            label: '按群聊场景模拟',
            disabled: Boolean(busy),
            onChange: (next) => setIsGroup(next === true),
          }),
          h(ui.Input, {
            key: 'target',
            value: target,
            ariaLabel: '目标会话',
            placeholder: '目标会话（可留空）',
            disabled: Boolean(busy),
            onChange: (input) => setTarget(readValue(input, target)),
          }),
        ]),
      ]),
      error
        ? h(ui.Callout, { key: 'error', tone: 'danger', title: '模拟没有完成' }, h('span', null, P.failText(error)))
        : null,
      h(ui.Band, {
        key: 'result',
        title: '结果',
        hint: result ? '' : '还没有模拟过：点上面的「模拟一次」。',
      }, [resultBody]),
    ]);
  }

  // -------------------------------------------------------------------------
  // 页签四：表达习惯
  // -------------------------------------------------------------------------

  function HabitsPage({ shared }) {
    const api = shared.api || {};
    const deliveriesApi = P.useApi(() => request(`${apiPath(api.deliveries, 'deliveries')}?limit=50`).then((response) => {
      if (!response.payload || response.payload.ok !== true) throw asError(response, '读不到投递记录。');
      return response.payload;
    }), [], { enabled: !shared.disabled });
    const metricsApi = P.useApi(() => request(`${apiPath(api.metrics, 'metrics')}?windowHours=168`).then((response) => {
      if (!response.payload || response.payload.ok !== true) throw asError(response, '读不到表达习惯指标。');
      return response.payload;
    }), [], { enabled: !shared.disabled });
    const [busy, setBusy] = P.useState('');
    const [error, setError] = P.useState(null);

    const metrics = metricsView(metricsApi.data);
    const rows = deliveriesApi.data && Array.isArray(deliveriesApi.data.items) ? deliveriesApi.data.items : [];
    const negative = rows.filter((row) => String(row.status || '') === 'failed'
      || /reject|negative|awkward/i.test(String(row.reasonCode || row.status || '')));

    const reenable = (assetId) => {
      if (!assetId) return;
      setBusy(assetId);
      setError(null);
      request(apiPath(api.action, 'asset'), 'POST', { assetId, action: 'approve' }).then((response) => {
        setBusy('');
        if (!response.payload || response.payload.ok !== true) {
          setError(asError(response, '解除禁用没有完成。'));
          return;
        }
        if (typeof P.notice === 'function') P.notice('已解除禁用', 'ok');
        deliveriesApi.reload();
        metricsApi.reload();
      }, () => {
        setBusy('');
        setError(new P.ApiError('网络请求没有完成。', 0, 'network'));
      });
    };

    const metricsBody = (() => {
      if (metricsApi.error) return h(ui.ErrorBox, { error: metricsApi.error, onRetry: metricsApi.reload });
      if (!metricsApi.data) return h(ui.Skeleton, { rows: 4 });
      return [
        metrics.rows.map((row) => h('div', { key: row.id, className: 'cpxp-exp-metric', 'data-state': row.tone || undefined }, [
          h('span', { key: 'label', className: 'cpxp-exp-metric-label' }, row.label),
          h('span', { key: 'value', className: 'cpxp-exp-metric-value' }, row.value),
          h('p', { key: 'hint', className: 'cpxp-exp-metric-hint' }, row.hint),
        ])),
        metrics.unavailable.length
          ? h('p', { key: 'unavail', className: 'cpxp-exp-muted' }, `读不到：${metrics.unavailable.join('；')}`)
          : null,
      ];
    })();

    const deliveriesBody = (() => {
      if (deliveriesApi.error) return h(ui.ErrorBox, { error: deliveriesApi.error, onRetry: deliveriesApi.reload });
      if (!deliveriesApi.data) return h(ui.Skeleton, { rows: 3 });
      if (!rows.length) {
        return h(ui.Empty, {
          title: '还没有投递记录',
          hint: '一张图都还没有真的发出去过；开启投递总闸并满足授权与冷却之后才会有记录。',
        });
      }
      return h(ui.List, { label: '最近投递' }, rows.map((row, index) => h(ui.Row, {
        key: `${row.planId || 'plan'}-${row.partIndex === undefined ? index : row.partIndex}`,
        title: `${String(row.status || '未知状态')} · ${String(row.scopeLabel || row.scope || '')}`,
        meta: [String(row.assetId || ''), String(row.reasonCode || '')].filter(Boolean).join(' · '),
        side: h(ui.Timestamp, { at: row.at }),
      })));
    })();

    const negativeBody = negative.length
      ? h(ui.List, { label: '负反馈' }, negative.map((row, index) => h(ui.Row, {
        key: `neg-${row.assetId || index}`,
        title: String(row.assetId || '（没有 assetId）'),
        meta: [String(row.status || ''), String(row.reasonCode || '')].filter(Boolean).join(' · '),
        side: row.assetId
          ? h(ui.Button, {
            variant: 'ghost',
            size: 'sm',
            loading: busy === row.assetId,
            disabled: Boolean(busy),
            onClick: () => reenable(String(row.assetId)),
          }, '解除禁用')
          : null,
      })))
      : h('p', { className: 'cpxp-exp-muted' }, '这次窗口里没有负反馈。');

    return h(ui.Page, {
      title: '表达习惯',
      lead: '这张表回答一个问题：它发得对不对。指标读不到就写「—」，不估算，也不画 0。',
      status: h('span', { className: 'cpxp-exp-muted' },
        metricsApi.data ? `窗口 ${countOrDash(metrics.windowHours)} 小时` : '正在读取…'),
      actions: h(ui.Button, {
        variant: 'primary',
        loading: Boolean(metricsApi.loading || deliveriesApi.loading),
        disabled: Boolean(metricsApi.loading || deliveriesApi.loading),
        onClick: () => { metricsApi.reload(); deliveriesApi.reload(); },
      }, '刷新'),
    }, [
      shared.disabled
        ? h(ui.Callout, { key: 'disabled', tone: 'warn', title: '模块未启用' }, h('span', null, '打开 modules.expression 后这里才有指标可读。'))
        : null,
      error
        ? h(ui.Callout, { key: 'error', tone: 'danger', title: '解除禁用没有完成' }, h('span', null, P.failText(error)))
        : null,
      h(ui.Band, {
        key: 'metrics',
        title: '指标',
        hint: metrics.note,
        info: '口径写在每一行下面：沉默不计入 precision；unknown 不重试也不算成功；p95 没有记录就是「—」。',
      }, [metricsBody]),
      h(ui.Band, {
        key: 'deliveries',
        title: '最近投递',
        hint: rows.length ? `最近 ${countOrDash(rows.length)} 条` : '',
        info: '只有「有回执」的投递才算确认（confirmed）。unknown 表示没有回执，它不会被重试，也不会被当成成功。',
      }, [deliveriesBody]),
      h(ui.Band, {
        key: 'negative',
        title: '负反馈与解除禁用',
        hint: negative.length ? `${countOrDash(negative.length)} 条` : '没有负反馈记录。',
        info: 'reject 会立即降权并抑制重发；这里可以显式把某条素材收回「已通过」，让它重新参与检索。',
      }, [negativeBody]),
    ]);
  }

  // -------------------------------------------------------------------------
  // 页外壳：先读 page，再按页签渲染；未启用时给启用片段而不是空壳。
  // -------------------------------------------------------------------------

  function useShared() {
    const [reloaded, setReloaded] = P.useState(0);
    const state = P.useApi(loadPage, [reloaded]);
    const descriptor = state.data && state.data.descriptor ? state.data.descriptor : null;
    const disabled = Boolean(state.error && isDisabledAnswer(state.error.status, { error: { code: state.error.code } }));
    return {
      loading: state.loading,
      error: state.error,
      disabled,
      descriptor: descriptor || { states: [], api: {}, meta: {} },
      config: state.data ? state.data.config : null,
      sources: state.data ? state.data.sources : null,
      api: (descriptor && descriptor.api) || {},
      // 保存规则后要重读 page + config + sources：三者一起变，页面不能只更新一半。
      reload: () => { state.reload(); setReloaded((value) => value + 1); },
    };
  }

  function DisabledState({ title }) {
    return h(ui.Page, {
      title,
      lead: '表情包模块没有挂载：这一页仍然能被打开，但没有后端可读可写。',
    }, [
      h(ui.Callout, { key: 'callout', tone: 'warn', title: '套件里没有启用「表情包」模块' }, h('div', null, [
        h('p', { key: 'how', className: 'cpxp-exp-muted' }, '启用路径：编辑 config/suite.json，把 modules.expression 改成 true，然后重启套件（npm run start），再用 npm run doctor 复核。'),
        h(ui.Pre, { key: 'snippet', maxHeight: 140 }, ENABLE_SNIPPET),
        h('p', { key: 'note', className: 'cpxp-exp-muted' }, 'config/suite.json 是套件级本地配置（不入库），模板是 config/suite.example.json；npm run setup 不会覆盖已有文件。'),
      ])),
    ]);
  }

  function ExpressionPage({ title, tab, shared }) {
    if (shared.loading && !shared.error) {
      return h(ui.Page, { title, lead: '正在读取表情包的页面描述…' }, [h(ui.Skeleton, { key: 'skel', rows: 4 })]);
    }
    if (shared.error && shared.disabled) return h(DisabledState, { title });
    if (shared.error) {
      return h(ui.Page, { title, lead: '读不到表情包的页面描述。' }, [
        h(ui.Callout, { key: 'fail', tone: 'danger', title: '接口失败' }, h('div', null, [
          h('p', { key: 'msg', className: 'cpxp-exp-muted' }, P.failText(shared.error, '表情包接口没有返回页面描述。')),
          h('div', { key: 'actions', className: 'cpxp-exp-actions' },
            h(ui.Button, { variant: 'ghost', size: 'sm', onClick: shared.reload }, '重新读取')),
        ])),
      ]);
    }
    if (tab === 'library') return h(LibraryPage, { shared });
    if (tab === 'rules') return h(RulesPage, { shared });
    if (tab === 'lab') return h(LabPage, { shared });
    return h(HabitsPage, { shared });
  }

  function makePage(title, tab) {
    return function ExpressionTabPage() {
      const shared = useShared();
      return h('div', { className: 'cpxp-page cpx-exp-page' }, h(ExpressionPage, { title, tab, shared }));
    };
  }

  P.registerPage({ id: 'exp-library', label: '图库', order: 80, component: makePage('图库', 'library') });
  P.registerPage({ id: 'exp-rules', label: '收集规则', order: 81, component: makePage('收集规则', 'rules') });
  P.registerPage({ id: 'exp-lab', label: '自然度实验室', order: 82, component: makePage('自然度实验室', 'lab') });
  P.registerPage({ id: 'exp-habits', label: '表达习惯', order: 83, component: makePage('表达习惯', 'habits') });

  // 片段导出纯函数给单测用（不导出组件，测试只测逻辑）。
  P.expressionPage = {
    BASE,
    ENABLE_SNIPPET,
    STATE_LABELS,
    STATE_TONES,
    METRIC_ROWS,
    ACTIONS,
    GROUP_FLAGS,
    MODERATION_LABEL,
    stateLabel,
    stateTone,
    apiPath,
    formatMetric,
    metricsView,
    decisionView,
    simulateView,
    assetGrid,
    isDisabledAnswer,
    grantsView,
    moderationText,
    toMillis,
    countOrDash,
    shortId,
  };
})(P);
