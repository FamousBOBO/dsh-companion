// 召回显微镜片段：一次真实检索的诊断视图（设置 › 高级诊断）。
// 纯脚本 IIFE，无 import/export/require/JSX。端点只有一个（以 lib/read.mjs 为准）：
//   GET preview?q=&limit=   → {query, characters, budgetChars, truncated, entries[], explain{}, rendered}
// 默认只显示人能读懂的一层；评分、阈值、explain 原始 JSON 全部收进 ui.Diagnostic。
(function (P) {
  'use strict';

  const { h, useState, ui, api, fmt } = P;

  P.css(`
.cpxp-ms-query { display: flex; flex-direction: column; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-ms-controls { display: flex; flex-wrap: wrap; gap: var(--cpx-s4, 16px); align-items: flex-end; min-width: 0; }
.cpxp-ms-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.7; overflow-wrap: anywhere; }
.cpxp-ms-head { display: flex; flex-direction: column; gap: var(--cpx-s2, 8px); min-width: 0; }
.cpxp-ms-title { margin: 0; font-size: var(--cpx-fs-section, 17px); font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.cpxp-ms-line { display: flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); align-items: center; min-width: 0; }
.cpxp-ms-reasons { display: flex; flex-direction: column; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-ms-reason { display: flex; flex-direction: column; gap: var(--cpx-s1, 4px); min-width: 0; overflow-wrap: anywhere; }
.cpxp-ms-reason-head { display: flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); align-items: center; }
.cpxp-ms-side { display: inline-flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); align-items: center; }
@media (max-width: 900px) { .cpxp-ms-controls { gap: var(--cpx-s3, 12px); } }
`);

  const LIMIT_OPTIONS = [
    { id: '8', label: '8 条' },
    { id: '12', label: '12 条' },
    { id: '20', label: '20 条' },
  ];

  // 过滤原因词典：覆盖 lib/retrieve.mjs 的 filteredReasons 与设计文档里的示意码；
  // 未收录的码原样展示并标注「未识别」。说明只留一句，细节交给技术明细。
  const REASON_INFO = {
    coverage_below_floor: ['覆盖度不足', 'warn', '查询词命中太少'],
    'low-coverage': ['覆盖度不足', 'warn', '查询词命中太少'],
    scope_denied: ['作用域不可见', 'warn', '属于别的用户或角色'],
    'scope-mismatch': ['作用域不可见', 'warn', '属于别的用户或角色'],
    pending: ['待审核', 'brand', '候选还没确认'],
    'status-pending': ['待审核', 'brand', '候选还没确认'],
    superseded: ['已被取代', 'neutral', '有更新的纠正版本'],
    'status-superseded': ['已被取代', 'neutral', '有更新的纠正版本'],
    archived: ['已归档', 'neutral', '已归档不参与召回'],
    'status-archived': ['已归档', 'neutral', '已归档不参与召回'],
    retracted: ['已撤回', 'neutral', '用户要求遗忘'],
    'status-retracted': ['已撤回', 'neutral', '用户要求遗忘'],
    expired: ['已过期', 'warn', '超出有效期'],
    'not-yet-valid': ['尚未生效', 'warn', '生效时间还没到'],
    inactive: ['已失效', 'warn', '状态或时效不满足'],
    mention_policy: ['表达策略受限', 'danger', '只留占位，不注入正文'],
    mmr_dedup: ['近重复去重', 'neutral', '与已选条目近重复'],
    budget_exceeded: ['超出注入预算', 'warn', '超出注入预算被丢弃'],
    'semantic-degraded': ['向量降级', 'danger', '向量降级，本轮无语义通道'],
    'semantic-off': ['语义通道关闭', 'neutral', '向量提供器关闭'],
    'semantic-no-overlap': ['无共享词元', 'neutral', '向量无共享词元'],
    'semantic-below-floor': ['余弦低于阈值', 'neutral', '相似度低于阈值'],
    'semantic-empty': ['查询向量为空', 'neutral', '查询向量为空'],
    'missing-vector': ['缺少向量', 'neutral', '还没写入向量索引'],
    'missing-record': ['记录缺失', 'neutral', '记忆行已不存在'],
    'empty-candidate-pool': ['候选为空', 'neutral', '没有可打分的候选'],
    'lexical-error': ['字面通道异常', 'danger', '全文检索失败'],
    'vector-error': ['向量读取异常', 'danger', '向量读取失败'],
    'recent-error': ['候选池读取异常', 'danger', '候选池读取失败'],
    'semantic-error': ['语义通道异常', 'danger', '向量通道报错'],
    'recall-error': ['召回异常', 'danger', '召回整体失败'],
    'no-database': ['记忆库不可用', 'danger', '记忆库未就绪'],
    'no-viewer': ['身份不可用', 'danger', '身份不可用'],
  };

  const SCOPE_LABEL = {
    user_global: '现实',
    user_persona: '关系',
    persona_self: '角色自我',
    roleplay_world: '剧情世界',
    session_recent: '近期状态',
  };
  const POLICY_LABEL = {
    direct: '直接使用',
    soft_echo: '轻回响',
    tone_only: '仅语气',
    avoid_unless_asked: '需明确询问',
  };
  const KIND_LABEL = {
    fact: '事实', preference: '偏好', profile: '画像', event: '事件', commitment: '约定',
    relationship: '关系', summary: '摘要', bot_action: '角色行为', artifact: '产出物', note: '备注',
  };
  const REASON_LABEL = { lexical: '字面命中', semantic: '语义命中', recent: '最近记忆', hybrid: '双通道命中' };

  const text = (value) => (value === null || value === undefined ? '' : String(value));
  const labelOf = (map, key) => map[text(key)] || text(key) || '—';
  const countOf = (value) => (Number.isFinite(Number(value)) ? fmt.number(Number(value)) : '—');
  const percentOf = (value) => (Number.isFinite(Number(value)) ? fmt.percent(Number(value)) : '—');
  const fixed = (value, digits) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—');
  const readValue = (input, fallback) => {
    if (input && typeof input === 'object' && input.target && 'value' in input.target) return input.target.value;
    if (typeof input === 'string' || typeof input === 'number') return input;
    return fallback;
  };
  const reasonInfo = (code) => {
    const found = REASON_INFO[text(code)];
    if (found) return { label: found[0], tone: found[1], hint: found[2], known: true };
    return { label: text(code) || '未知原因', tone: 'neutral', hint: '未识别的原因码', known: false };
  };
  // Table 的 render 可能收到 (value, row) 或 (row)。
  const cellRow = (value, row) => (row && typeof row === 'object' ? row : value) || {};

  function MicroscopePage() {
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState('8');
    const [submitted, setSubmitted] = useState(null);
    // 只有提交过查询才请求后端：页面挂载时不发任何请求。
    const previewApi = P.useApi(
      () => (submitted ? api.get('preview', { q: submitted.q, limit: submitted.limit }) : null),
      [submitted],
      { enabled: Boolean(submitted) },
    );

    const data = previewApi.data && typeof previewApi.data === 'object' ? previewApi.data : null;
    const loading = Boolean(submitted) && Boolean(previewApi.loading);
    const error = previewApi.error || null;

    const entries = data && Array.isArray(data.entries) ? data.entries.filter(Boolean) : [];
    const explain = data && data.explain && typeof data.explain === 'object' ? data.explain : null;
    const rendered = data ? text(data.rendered) : '';
    const characters = data && Number.isFinite(Number(data.characters)) ? Number(data.characters) : rendered.length;
    const budgetChars = data && Number.isFinite(Number(data.budgetChars)) ? Number(data.budgetChars) : null;
    const truncated = Boolean(data && data.truncated);
    const coverage = explain && explain.coverage && typeof explain.coverage === 'object' ? explain.coverage : null;
    const channels = explain && explain.channels && typeof explain.channels === 'object' ? explain.channels : null;
    const reasonCounts = explain && explain.filteredReasons && typeof explain.filteredReasons === 'object'
      ? Object.keys(explain.filteredReasons)
        .filter((code) => Number(explain.filteredReasons[code]) > 0)
        .map((code) => [code, Number(explain.filteredReasons[code])])
        .sort((left, right) => right[1] - left[1])
      : [];

    const run = (typed) => {
      const value = text(typeof typed === 'string' ? typed : query).trim();
      if (!value) return;
      const size = Number(limit);
      setSubmitted({ q: value, limit: Number.isFinite(size) && size > 0 ? size : 8, nonce: Date.now() });
    };

    const resultBody = (() => {
      if (error) return h(ui.ErrorBox, { error, onRetry: () => previewApi.reload() });
      if (loading) return h(ui.Skeleton, { rows: 4 });
      if (!data) {
        return h(ui.Empty, {
          title: '还没有运行诊断',
          hint: '输入一句你会问的话，回车运行。',
        });
      }
      const hit = entries.length;
      const summary = h('div', { className: 'cpxp-ms-head' },
        h('h3', { className: 'cpxp-ms-title' }, `用「${text(data.query) || '（空）'}」检索，命中 ${countOf(hit)} 条记忆`),
        h('div', { className: 'cpxp-ms-line' },
          h(ui.Badge, { tone: hit ? 'ok' : 'warn' }, hit ? `命中 ${countOf(hit)} 条` : '没有命中'),
          h(ui.Badge, { tone: truncated ? 'warn' : 'neutral' }, truncated ? '注入按预算截断' : '注入未截断'),
          budgetChars === null
            ? h(ui.Badge, { tone: 'neutral' }, `注入 ${countOf(characters)} 字符`)
            : null,
          h('span', { className: 'cpxp-ms-note' }, `耗时 ${explain && Number.isFinite(Number(explain.elapsedMs)) ? `${countOf(explain.elapsedMs)} ms` : '—'}`)),
        budgetChars === null
          ? null
          : h(ui.Meter, {
            value: characters,
            max: budgetChars,
            label: `注入字符数 ${countOf(characters)} / 上限 ${countOf(budgetChars)}`,
            tone: characters > budgetChars ? 'warn' : 'ok',
          }));
      const list = hit
        ? h(ui.List, { label: '命中的记忆' }, entries.map((entry, index) => {
          const policy = text(entry.policy);
          const risky = policy === 'avoid_unless_asked';
          return h(ui.Row, {
            key: text(entry.id) || `entry-${index}`,
            title: text(entry.preview) || '（按表达策略不展示正文）',
            meta: `${labelOf(KIND_LABEL, entry.kind)} · ${labelOf(SCOPE_LABEL, entry.scope)}`,
            side: h(ui.Badge, { tone: risky ? 'danger' : 'neutral' }, labelOf(POLICY_LABEL, policy)),
            ariaLabel: `命中第 ${index + 1} 条，${labelOf(KIND_LABEL, entry.kind)}，${labelOf(POLICY_LABEL, policy)}`,
          });
        }))
        : h(ui.Empty, {
          title: '这次没有命中的条目',
          hint: reasonCounts.length
            ? `主因：${reasonInfo(reasonCounts[0][0]).label}。`
            : '问题和已有记忆没有交集。',
        });
      return h('div', { className: 'cpxp-ms-query' }, summary, list);
    })();

    const reasonBand = data && !error && !loading
      ? h(ui.Band, {
        title: '为什么没命中',
        info: '按后端返回的过滤原因翻译成人话；原始原因码与数字在下方技术明细。',
        actions: h(ui.Badge, { tone: reasonCounts.length ? 'warn' : 'ok' },
          reasonCounts.length ? `${countOf(reasonCounts.length)} 类原因` : '没有过滤原因'),
      },
        reasonCounts.length
          ? h('div', { className: 'cpxp-ms-reasons' }, reasonCounts.map(([code, count]) => {
            const info = reasonInfo(code);
            return h('div', { key: code, className: 'cpxp-ms-reason' },
              h('div', { className: 'cpxp-ms-reason-head' },
                h(ui.Badge, { tone: info.tone }, info.label),
                h('span', { className: 'cpxp-ms-note' }, `× ${countOf(count)} 条`),
                info.known ? null : h(ui.Badge, { tone: 'neutral' }, '未识别')),
              h('p', { className: 'cpxp-ms-note' }, info.hint));
          }))
          : h('p', { className: 'cpxp-ms-note' }, '没有过滤原因。'))
      : null;

    const techItems = data && !error && !loading
      ? [
        { k: '后端通道', v: text(explain && explain.backend) || '—', mono: true },
        { k: '候选数', v: countOf(explain && explain.candidates) },
        { k: '过滤后', v: countOf(explain && explain.afterFilter) },
        { k: '去重后', v: countOf(explain && explain.afterDedupe) },
        { k: '字面通道', v: channels ? countOf(channels.lexical) : '—' },
        { k: '语义通道', v: channels ? countOf(channels.semantic) : '—' },
        { k: '耗时', v: explain && Number.isFinite(Number(explain.elapsedMs)) ? `${countOf(explain.elapsedMs)} ms` : '—' },
        { k: '覆盖度门槛', v: fixed(coverage && coverage.floor, 3), mono: true },
        { k: '最佳覆盖度', v: percentOf(coverage && coverage.best), mono: true },
        {
          k: '覆盖度通过',
          v: coverage
            ? `${countOf(coverage.kept)} / ${countOf(coverage.total)}（词元 ${countOf(coverage.terms)}）`
            : '—',
        },
      ]
      : [];

    const scoreColumns = [
      {
        key: 'preview',
        label: '条目',
        render: (value, row) => {
          const item = cellRow(value, row);
          return text(item.preview) || text(item.id) || '—';
        },
      },
      { key: 'kind', label: '类型', width: 90, render: (value, row) => labelOf(KIND_LABEL, cellRow(value, row).kind) },
      { key: 'scope', label: '作用域', width: 100, render: (value, row) => labelOf(SCOPE_LABEL, cellRow(value, row).scope) },
      { key: 'policy', label: '策略', width: 110, render: (value, row) => text(cellRow(value, row).policy) || '—' },
      { key: 'score', label: '分数', width: 84, align: 'right', render: (value, row) => fixed(cellRow(value, row).score, 4) },
      { key: 'reason', label: '命中通道', width: 110, render: (value, row) => labelOf(REASON_LABEL, cellRow(value, row).reason) },
      { key: 'id', label: '记忆编号', width: 170, render: (value, row) => text(cellRow(value, row).id) || '—' },
    ];

    return h(ui.Page, {
      title: '召回显微镜',
      lead: '命中几条、为什么没命中。',
      status: h('span', { className: 'cpxp-ms-note' },
        `只读诊断 · 条数上限 ${countOf(limit)} 条`,
        submitted ? [' · 最近运行 ', h(ui.Timestamp, { key: 'at', at: new Date(submitted.nonce).toISOString() })] : ' · 还没有运行'),
      actions: h(ui.Button, {
        variant: 'primary',
        onClick: () => run(),
        loading,
        disabled: loading || !text(query).trim(),
      }, submitted ? '再运行一次' : '运行诊断'),
    },
    h(ui.Band, {
      flush: true,
      title: '查询',
      info: '诊断视图：只读，不写库，不触发模型，也不影响真实回复。q 与 limit 是真参数（limit 1..20，默认 8）。',
    },
      h('div', { className: 'cpxp-ms-query' },
        h(ui.Search, {
          value: query,
          label: '要检索的问题',
          placeholder: '例如：我们之前约定过什么？',
          onChange: (input) => setQuery(text(readValue(input, ''))),
          onEnter: (input) => run(typeof input === 'string' ? input : query),
        }),
        h('div', { className: 'cpxp-ms-controls' },
          h(ui.Segmented, {
            label: '最多看几条',
            options: LIMIT_OPTIONS,
            value: limit,
            onChange: (next) => setLimit(text(readValue(next, limit)) || '8'),
          })),
        text(query).trim() ? null : h('p', { className: 'cpxp-ms-note' }, '先输入一个问题。'))),
    h(ui.Band, { title: '这一次检索' }, resultBody),
    reasonBand,
    h(ui.Band, { title: '技术明细', hint: '评分、阈值与原始 JSON。' },
      h(ui.Diagnostic, { title: '检索诊断（explain）', hint: '通道计数、覆盖度、耗时、每条评分' },
        data && !error && !loading
          ? [
            h(ui.KeyValue, { key: 'kv', items: techItems }),
            h(ui.Table, {
              key: 'score',
              columns: scoreColumns,
              rows: entries,
              emptyText: '这一轮没有进入候选的条目。',
            }),
            h('p', { key: 'note', className: 'cpxp-ms-note' }, '原始 explain JSON'),
            h(ui.Pre, { key: 'json', maxHeight: '260px' }, explain ? JSON.stringify(explain, null, 2) : '（后端未返回 explain）'),
          ]
          : h('p', { className: 'cpxp-ms-note' }, '先运行一次诊断，这里才会出现数字。')),
      h(ui.Diagnostic, { title: '模型实际看到的注入文本', hint: '逐行 JSON；空字符串＝未注入' },
        rendered
          ? h(ui.Pre, { maxHeight: '340px' }, rendered)
          : h('p', { className: 'cpxp-ms-note' }, '本轮注入为空。'))));
  }

  P.registerPage({ id: 'microscope', label: '召回显微镜', order: 30, component: MicroscopePage });
})(P);
