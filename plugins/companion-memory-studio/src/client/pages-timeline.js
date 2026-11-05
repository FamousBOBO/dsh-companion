// 时间线页片段：按天分组的事件流 + 真实筛选（kind / limit）+ 页内时间收窄。
// 纯脚本 IIFE，无 import/export/require/JSX。端点（以 lib/read.mjs 为准）：
//   GET timeline?limit=&kind=   对话事件摘要（limit 1..200 默认 50；kind 匹配 sourceKind 或 role）
//   GET companion               事实事件流（sections.events：kind / occurred_at / reality_status / evidence_status）
(function (P) {
  'use strict';

  const { h, useState, useMemo, ui, api, fmt } = P;

  P.css(`
.cpxp-tl-controls { display: flex; flex-wrap: wrap; gap: var(--cpx-s4, 16px); align-items: flex-end; min-width: 0; }
.cpxp-tl-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.7; overflow-wrap: anywhere; }
.cpxp-tl-groups { display: flex; flex-direction: column; gap: var(--cpx-s5, 24px); min-width: 0; }
.cpxp-tl-day { display: flex; flex-direction: column; gap: var(--cpx-s2, 8px); min-width: 0; }
.cpxp-tl-day-head { display: flex; align-items: center; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-tl-day-label { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); letter-spacing: .04em; white-space: nowrap; }
.cpxp-tl-rule { flex: 1 1 auto; height: 1px; background: var(--dsw-alias-border-l1); }
.cpxp-tl-side { display: inline-flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); align-items: center; }
.cpxp-tl-clock { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cpxp-tl-foot { display: flex; flex-wrap: wrap; gap: var(--cpx-s3, 12px); align-items: center; }
`);

  const PAGE_STEP = 50;
  // GET timeline 把 limit 夹在 1..200，页面不能承诺更多。
  const MAX_LIMIT = 200;
  const MAX_TECH_ROWS = 80;

  const KIND_OPTIONS = [
    { id: 'all', label: '全部' },
    { id: 'user', label: '用户消息' },
    { id: 'assistant', label: '助手回复' },
    { id: 'imported', label: '导入材料' },
  ];
  const LIMIT_OPTIONS = [
    { id: '50', label: '50 条' },
    { id: '100', label: '100 条' },
    { id: '200', label: '200 条' },
  ];
  const RANGE_OPTIONS = [
    { id: 'all', label: '全部' },
    { id: 'today', label: '今天' },
    { id: '7d', label: '近 7 天' },
    { id: '30d', label: '近 30 天' },
  ];
  const STREAM_OPTIONS = [
    { id: 'messages', label: '对话事件' },
    { id: 'facts', label: '事实事件' },
  ];

  const TYPE_LABEL = {
    desktop_conversation: '桌面对话',
    desktop_fact: '桌面事实',
    astrbot_import: '旧库导入',
    manual: '手工写入',
    system: '系统',
    extracted: '抽取',
  };
  const ROLE_LABEL = { user: '用户', assistant: '助手', imported: '导入', system: '系统', tool: '工具' };
  const ROLE_TONE = { user: 'brand', assistant: 'ok', imported: 'warn', system: 'neutral', tool: 'neutral' };

  // companion-runtime/lib/events.mjs 的 REALITY_STATUS / EVIDENCE_STATUS。
  const REALITY_INFO = {
    actual_tool_activity: { label: '真实活动', tone: 'ok' },
    simulated_world: { label: '模拟世界', tone: 'warn' },
    hypothetical: { label: '假设', tone: 'warn' },
  };
  const EVIDENCE_INFO = {
    observed: { label: '已观察', tone: 'brand' },
    inferred: { label: '推断', tone: 'warn' },
    confirmed: { label: '已确认', tone: 'ok' },
  };
  const KIND_SUBJECT = {
    goal: '目标', commitment: '承诺', belief: '判断', agenda: '日程', memory: '记忆',
    topic: '话题', autonomy: '自主', perception: '感知', contact: '联系', plan: '计划',
    activity: '活动', share: '分享', receipt: '回执', state: '状态', bridge: '桥接',
  };
  const KIND_ACTION = {
    proposed: '提出', accepted: '接受', started: '开始', paused: '暂停', resumed: '恢复',
    completed: '完成', cancelled: '取消', step: '推进', updated: '更新', overdue: '逾期',
    made: '作出', closed: '结束', asserted: '写入', evidence: '补充证据', corrected: '纠正',
    expired: '过期', 'ingest-request': '请求入库', 'correction-request': '请求纠正',
    created: '创建', 'occurrence-generated': '生成触发', 'occurrence-rescheduled': '改期',
    'occurrence-cancelled': '取消触发', 'occurrence-due': '到点', 'occurrence-skipped': '跳过',
    'occurrence-expired': '过期未触发', 'occurrence-dispatched': '已派发',
    'plan-committed': '计划提交', 'plan-slot': '计划时段', opportunity: '机会',
    interest: '兴趣', 'switch': '切换', interjection: '插话', resume: '接续',
  };

  const text = (value) => (value === null || value === undefined ? '' : String(value));
  const countOf = (value) => (Number.isFinite(Number(value)) ? fmt.number(Number(value)) : '—');
  // P.ui.* 的 onChange 有的给值、有的给事件。
  const readValue = (input, fallback) => {
    if (input && typeof input === 'object' && input.target && 'value' in input.target) return input.target.value;
    if (typeof input === 'string' || typeof input === 'number') return input;
    return fallback;
  };

  // 事件时间可能是 ISO 字符串，也可能是 epoch 毫秒（domain_events 存毫秒）。
  function toMillis(value) {
    if (value === null || value === undefined || value === '') return NaN;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 1e11) return numeric;
    const parsed = new Date(String(value)).getTime();
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  function isoOf(value) {
    if (value === null || value === undefined || value === '') return '';
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 1e11) return new Date(numeric).toISOString();
    return String(value);
  }
  // 分天一律按 Asia/Shanghai，和 ui.Timestamp 的时区保持一致。
  function dayKeyOf(value) {
    const ms = typeof value === 'number' ? value : toMillis(value);
    if (!Number.isFinite(ms)) return 'unknown';
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(ms));
    } catch {
      return String(new Date(ms).toISOString()).slice(0, 10);
    }
  }
  function dayLabel(day) {
    if (!day || day === 'unknown') return '时间未知';
    // 只借 UTC 解析取出这一天是星期几，不参与任何时间换算。
    const parsed = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime())) return day;
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][parsed.getUTCDay()];
    return `${day} · ${weekday}`;
  }
  function rangeStart(range) {
    if (range === 'today') {
      const today = dayKeyOf(Date.now());
      const parsed = new Date(`${today}T00:00:00+08:00`);
      return Number.isFinite(parsed.getTime()) ? parsed.getTime() : NaN;
    }
    if (range === '7d') return Date.now() - 7 * 86400000;
    if (range === '30d') return Date.now() - 30 * 86400000;
    return null;
  }
  function kindLabel(kind) {
    const raw = text(kind);
    if (!raw) return '未标注类型';
    const [subject, action] = raw.split('/');
    const subjectLabel = KIND_SUBJECT[subject];
    const actionLabel = KIND_ACTION[action];
    if (subjectLabel && actionLabel) return `${subjectLabel} · ${actionLabel}`;
    if (subjectLabel) return `${subjectLabel} · ${action || '事件'}`;
    return raw;
  }
  function realityOf(value) {
    const found = REALITY_INFO[text(value)];
    if (found) return found;
    return { label: text(value) || '未标注', tone: 'neutral' };
  }
  function evidenceOf(value) {
    const found = EVIDENCE_INFO[text(value)];
    if (found) return found;
    return { label: text(value) || '未标注', tone: 'neutral' };
  }
  function sessionShort(sessionId) {
    const value = text(sessionId);
    if (!value) return '';
    return value.length <= 10 ? value : `${value.slice(0, 10)}…`;
  }
  // Table 的 render 可能收到 (value, row) 或 (row)。
  const cellRow = (value, row) => (row && typeof row === 'object' ? row : value) || {};

  function groupByDay(rows, timeOf) {
    const buckets = new Map();
    for (const row of rows) {
      const day = dayKeyOf(timeOf(row));
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day).push(row);
    }
    return [...buckets.entries()]
      .map(([day, list]) => ({
        day,
        rows: list.sort((left, right) => {
          const a = timeOf(left);
          const b = timeOf(right);
          if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
          if (!Number.isFinite(a)) return 1;
          if (!Number.isFinite(b)) return -1;
          return b - a;
        }),
      }))
      .sort((left, right) => {
        if (left.day === 'unknown') return 1;
        if (right.day === 'unknown') return -1;
        return right.day.localeCompare(left.day);
      });
  }

  function TimelinePage() {
    const [stream, setStream] = useState('messages');
    const [kind, setKind] = useState('all');
    const [limit, setLimit] = useState(50);
    const [range, setRange] = useState('all');

    // 只有真参数：kind 与 limit 直接进 query，其余不猜。
    const messagesApi = P.useApi(
      () => api.get('timeline', kind === 'all' ? { limit } : { limit, kind }),
      [limit, kind],
      { enabled: stream === 'messages' },
    );
    const factsApi = P.useApi(() => api.get('companion'), [], { enabled: stream === 'facts' });

    const messagesData = messagesApi.data && typeof messagesApi.data === 'object' ? messagesApi.data : null;
    const allMessages = messagesData && Array.isArray(messagesData.items) ? messagesData.items.filter(Boolean) : [];
    const factsData = factsApi.data && typeof factsApi.data === 'object' ? factsApi.data : null;
    const factRows = factsData && factsData.sections && Array.isArray(factsData.sections.events)
      ? factsData.sections.events.filter(Boolean)
      : [];
    const factsUnavailable = Boolean(factsData && Array.isArray(factsData.unavailable)
      && factsData.unavailable.includes('events'));

    const cutoff = rangeStart(range);
    const messages = useMemo(() => {
      if (cutoff === null) return allMessages;
      return allMessages.filter((item) => {
        const ms = toMillis(item && item.at);
        return !Number.isFinite(ms) || ms >= cutoff;
      });
    }, [allMessages, cutoff]);
    const facts = useMemo(() => {
      if (cutoff === null) return factRows;
      return factRows.filter((row) => {
        const ms = toMillis(row && row.occurred_at);
        return !Number.isFinite(ms) || ms >= cutoff;
      });
    }, [factRows, cutoff]);

    const loaded = stream === 'messages' ? allMessages : factRows;
    const shown = stream === 'messages' ? messages : facts;
    const timeOf = stream === 'messages'
      ? (item) => toMillis(item && item.at)
      : (row) => toMillis(row && row.occurred_at);
    const groups = useMemo(() => groupByDay(shown, timeOf), [shown, stream]);
    const unknownTime = shown.filter((row) => !Number.isFinite(timeOf(row))).length;

    const activeLoading = stream === 'messages' ? messagesApi.loading : factsApi.loading;
    const activeError = stream === 'messages' ? messagesApi.error : factsApi.error;
    const reloadActive = () => (stream === 'messages' ? messagesApi.reload() : factsApi.reload());

    const fetchedAt = useMemo(() => new Date().toISOString(), [messagesData]);
    const observedAt = text(factsData && factsData.observedAt);
    const maxReached = limit >= MAX_LIMIT;
    // 带 kind 时后端会多取 4 倍再过滤，短页不能当成到底。
    const noMore = maxReached || (kind === 'all' && messagesData ? allMessages.length < limit : false);

    const statusNode = stream === 'messages'
      ? h('span', { className: 'cpxp-tl-note' },
        '读取于 ', h(ui.Timestamp, { at: fetchedAt }),
        ` · 已载入 ${countOf(allMessages.length)} 条`)
      : h('span', { className: 'cpxp-tl-note' },
        observedAt ? ['事件表读取于 ', h(ui.Timestamp, { key: 'at', at: observedAt })] : '事件表读取时间未知',
        ` · 事实事件 ${countOf(factRows.length)} 条`);

    const renderMessageRow = (item, index) => {
      const role = text(item && item.role) || 'unknown';
      const type = text(item && item.type);
      const hidden = Boolean(item && item.hidden);
      const preview = text(item && item.preview);
      const session = text(item && item.sessionId);
      const roleLabel = ROLE_LABEL[role] || role;
      const typeLabel = TYPE_LABEL[type] || type || '类型未知';
      return h(ui.Row, {
        key: `${session || 'session'}-${text(item && item.seq)}-${index}`,
        title: hidden ? '（按表达策略隐藏，不展示内容）' : (preview || '（空消息）'),
        meta: [typeLabel, session ? `会话 ${sessionShort(session)}` : ''].filter(Boolean).join(' · '),
        side: h('span', { className: 'cpxp-tl-side' },
          h(ui.Timestamp, { at: isoOf(item && item.at), className: 'cpxp-tl-clock' }),
          h(ui.Badge, { tone: ROLE_TONE[role] || 'neutral' }, roleLabel)),
        ariaLabel: `${roleLabel}，${typeLabel}`,
      });
    };

    const renderFactRow = (row, index) => {
      const reality = realityOf(row && row.reality_status);
      const evidence = evidenceOf(row && row.evidence_status);
      const label = kindLabel(row && row.kind);
      return h(ui.Row, {
        key: text(row && row.event_id) || `fact-${index}`,
        title: label,
        // 属性放进 meta：那里会换行；side 是 nowrap，长内容会把窄屏撑横。
        meta: h('span', { className: 'cpxp-tl-side' },
          h('span', { className: 'cpxp-tl-note' }, '现实属性'),
          h(ui.Badge, { tone: reality.tone }, reality.label),
          h('span', { className: 'cpxp-tl-note' }, '证据属性'),
          h(ui.Badge, { tone: evidence.tone }, evidence.label)),
        side: h(ui.Timestamp, { at: isoOf(row && row.occurred_at), className: 'cpxp-tl-clock' }),
        ariaLabel: `${label}，现实 ${reality.label}，证据 ${evidence.label}`,
      });
    };

    const eventsBody = (() => {
      if (activeError) {
        return h(ui.ErrorBox, { error: activeError, onRetry: reloadActive });
      }
      if (activeLoading && !shown.length) return h(ui.Skeleton, { rows: 5 });
      if (stream === 'facts' && factsUnavailable) {
        return h(ui.Callout, {
          tone: 'warn',
          title: '事件表读不到',
          children: '后端没有提供事件表数据，不是页面故障。',
        });
      }
      if (!shown.length) {
        if (stream === 'facts') {
          return h(ui.Empty, {
            title: '还没有事实事件',
            hint: '还没有发生过这类动作。',
          });
        }
        return h(ui.Empty, {
          title: allMessages.length ? '这个时间范围里没有事件' : '还没有对话事件',
          hint: allMessages.length
            ? '都不在选中的范围里，点「看全部时间」。'
            : (kind === 'all'
              ? '真实对话被捕获后出现在这里。'
              : '当前类型下没有事件，切回「全部」再看看。'),
          action: range !== 'all'
            ? h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setRange('all') }, '看全部时间')
            : (kind === 'all'
              ? null
              : h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setKind('all') }, '看全部类型')),
        });
      }
      return h('div', { className: 'cpxp-tl-groups' }, groups.map((group) => h('section', {
        key: group.day,
        className: 'cpxp-tl-day',
        'aria-label': `${dayLabel(group.day)}，${group.rows.length} 条`,
      },
      h('div', { className: 'cpxp-tl-day-head' },
        h('span', { className: 'cpxp-tl-day-label' }, dayLabel(group.day)),
        h('span', { className: 'cpxp-tl-rule' }),
        h('span', { className: 'cpxp-tl-day-label' }, `${countOf(group.rows.length)} 条`)),
      h(ui.List, { label: dayLabel(group.day) },
        group.rows.map(stream === 'messages' ? renderMessageRow : renderFactRow)))));
    })();

    const techColumns = stream === 'messages'
      ? [
        { key: 'at', label: '时间（ISO）', width: 200, render: (value, row) => text(cellRow(value, row).at) || '—' },
        { key: 'role', label: '角色', width: 80, render: (value, row) => text(cellRow(value, row).role) || '—' },
        { key: 'type', label: '类型', width: 150, render: (value, row) => text(cellRow(value, row).type) || '—' },
        { key: 'session', label: '会话', width: 220, render: (value, row) => text(cellRow(value, row).sessionId) || '—' },
        { key: 'seq', label: '序号', width: 70, align: 'right', render: (value, row) => text(cellRow(value, row).seq) || '—' },
      ]
      : [
        { key: 'occurred', label: '发生时间（原始）', width: 190, render: (value, row) => text(cellRow(value, row).occurred_at) || '—' },
        { key: 'kind', label: 'kind', width: 190, render: (value, row) => text(cellRow(value, row).kind) || '—' },
        { key: 'reality', label: 'reality_status', width: 170, render: (value, row) => text(cellRow(value, row).reality_status) || '—' },
        { key: 'evidence', label: 'evidence_status', width: 150, render: (value, row) => text(cellRow(value, row).evidence_status) || '—' },
        { key: 'id', label: 'event_id', width: 200, render: (value, row) => text(cellRow(value, row).event_id) || '—' },
      ];

    return h(ui.Page, {
      title: '时间线',
      lead: '按天回看发生过的事。',
      status: statusNode,
      actions: h(ui.Button, {
        variant: 'primary',
        onClick: reloadActive,
        loading: Boolean(activeLoading),
        disabled: Boolean(activeLoading),
      }, '刷新'),
    },
    h(ui.Band, {
      flush: true,
      title: '筛选',
      info: [
        stream === 'messages'
          ? `时间范围只收窄已载入的 ${countOf(allMessages.length)} 条，不会去后端补更早的记录；类型与载入窗口是真参数。`
          : `时间范围只收窄已载入的 ${countOf(factRows.length)} 条（事件表固定给最近 100 条）。`,
        unknownTime ? `其中 ${countOf(unknownTime)} 条时间未知，按范围无法判断，仍留在列表里。` : '',
      ].filter(Boolean).join(' '),
    },
      h('div', { className: 'cpxp-tl-controls' },
        h(ui.Segmented, {
          label: '看哪条流',
          options: STREAM_OPTIONS,
          value: stream,
          onChange: (next) => setStream(text(readValue(next, stream)) || 'messages'),
        }),
        stream === 'messages'
          ? h(ui.Segmented, {
            label: '类型',
            options: KIND_OPTIONS,
            value: kind,
            onChange: (next) => { setKind(text(readValue(next, kind)) || 'all'); },
          })
          : null,
        stream === 'messages'
          ? h(ui.Segmented, {
            label: '载入窗口',
            options: LIMIT_OPTIONS,
            value: String(limit),
            onChange: (next) => setLimit(Number(readValue(next, limit)) || 50),
          })
          : null,
        h(ui.Segmented, {
          label: '时间范围',
          options: RANGE_OPTIONS,
          value: range,
          onChange: (next) => setRange(text(readValue(next, range)) || 'all'),
        }))),
    h(ui.Band, {
      title: '事件流',
      info: '只展示摘要（每条 ≤160 字符）与会话定位；完整正文不出接口。',
      actions: h(ui.Badge, { tone: 'neutral' }, `显示 ${countOf(shown.length)} / ${countOf(loaded.length)} 条`),
    },
      eventsBody,
      stream === 'messages'
        ? h('div', { className: 'cpxp-tl-foot' },
          h(ui.Button, {
            variant: 'ghost',
            size: 'sm',
            disabled: Boolean(activeLoading) || noMore,
            onClick: () => setLimit(Math.min(MAX_LIMIT, limit + PAGE_STEP)),
          }, noMore ? '已经到底了' : `加载更早的 ${PAGE_STEP} 条`),
          h('span', { className: 'cpxp-tl-note' },
            `当前窗口 ${countOf(limit)} 条${maxReached ? '（接口上限 200 条）' : ''}`))
        : null),
    h(ui.Band, { title: '技术明细', hint: '原始字段。' },
      h(ui.Diagnostic, { title: '当前已载入事件的原始字段', hint: `最多列前 ${MAX_TECH_ROWS} 条` },
        h(ui.Table, {
          columns: techColumns,
          rows: shown.slice(0, MAX_TECH_ROWS),
          emptyText: '这一条流里还没有可列出的事件。',
        }),
        shown.length > MAX_TECH_ROWS
          ? h('p', { className: 'cpxp-tl-note' }, `还有 ${countOf(shown.length - MAX_TECH_ROWS)} 条没列出。`)
          : null)));
  }

  P.registerPage({ id: 'timeline', label: '时间线', order: 50, component: TimelinePage });
})(P);
