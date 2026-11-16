(function (P) {
  // 计划 W2：结构化诊断视图（trace 时间线）。
  //
  // 数据全从服务端来：`GET /trace-events`（快照）、`GET /trace/stream`（SSE）、
  // `GET /trace-memory`（记忆侧投影）。前端不解析 `memory-recall.jsonl`，也不算理由码——
  // 那两件事各只有一个权威来源。
  //
  // 这个视图存在的前提是**能解释**：每条事件都能看到 module / stage / status / reasonCode /
  // counts / durationMs，并且丢掉的事件数（drops）永远显示在页面上，而不是被悄悄扔掉。

  const { h, ui } = P;
  const api = P.api;
  const useState = P.useState;
  const useEffect = P.useEffect;
  const useMemo = P.useMemo;
  const useRef = P.useRef;

  P.css(`
    .cpx-tr-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    .cpx-tr-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-secondary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }
    .cpx-tr-chip[data-on="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
    .cpx-tr-list { display: flex; flex-direction: column; gap: 2px; max-height: 52vh; overflow: auto; overscroll-behavior: contain; }
    .cpx-tr-row { display: grid; grid-template-columns: 76px 62px 88px minmax(0,1fr) auto; gap: 10px; align-items: baseline; padding: 7px 10px; border-radius: 6px; font-size: 12.5px; }
    .cpx-tr-row:nth-child(odd) { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent); }
    .cpx-tr-row[data-status="failed"] { box-shadow: inset 3px 0 0 var(--dsw-alias-danger, #d9534f); }
    .cpx-tr-row[data-status="degraded"] { box-shadow: inset 3px 0 0 var(--dsw-alias-warning, #d8a653); }
    .cpx-tr-row[data-status="empty"] { box-shadow: inset 3px 0 0 var(--dsw-alias-label-tertiary); }
    .cpx-tr-time { color: var(--dsw-alias-label-tertiary); font: 11px/1.5 var(--cpx-mono); }
    .cpx-tr-stage { color: var(--dsw-alias-label-secondary); font: 11.5px/1.5 var(--cpx-mono); }
    .cpx-tr-main { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); }
    .cpx-tr-meta { color: var(--dsw-alias-label-tertiary); font: 11px/1.6 var(--cpx-mono); }
    .cpx-tr-side { display: flex; gap: 6px; align-items: center; }
    .cpx-tr-empty { padding: 26px 14px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
    .cpx-tr-drops { margin-top: 10px; color: var(--dsw-alias-label-tertiary); font: 11.5px/1.7 var(--cpx-mono); }
    /* 窄窗口：五列栅格（76+62+88+auto+gaps ≈ 266px）在手机宽度会把正文挤成一列字，
       这里改成两行堆叠——时间与阶段并排，正文独占一行。 */
    @media(max-width:760px) {
      .cpx-tr-row { grid-template-columns: auto minmax(0,1fr); gap: 4px 8px; }
      .cpx-tr-main { grid-column: 1 / -1; }
      .cpx-tr-side { grid-column: 1 / -1; justify-content: flex-start; }
      .cpx-tr-list { max-height: 60vh; }
    }
    @media(prefers-reduced-motion:reduce) { .cpx-tr-row { transition: none; } }
  `);

  const STATUS_TONE = { ok: 'ok', empty: 'neutral', filtered: 'neutral', degraded: 'warn', failed: 'danger' };
  const STATUS_LABEL = { ok: '成功', empty: '无结果', filtered: '被过滤', degraded: '降级', failed: '失败' };

  /** 把一条事件压成一行可读文本：不藏信息，但也不展开成段落。 */
  function describe(event) {
    const counts = event.counts && typeof event.counts === 'object' ? event.counts : null;
    const parts = [];
    if (counts) {
      for (const key of ['candidates', 'filtered', 'injected', 'characters', 'toolsCalled', 'toolsFailed', 'dropped']) {
        if (typeof counts[key] === 'number') parts.push(`${key}=${counts[key]}`);
      }
    }
    if (typeof event.durationMs === 'number') parts.push(`${event.durationMs}ms`);
    return parts.join(' · ');
  }

  function timeOf(at) {
    // 时间必须按本机时区渲染（`P.fmt.clockSeconds` 走 core.js 的 Asia/Shanghai）。
    // 旧实现直接从 UTC 的 ISO 串里截 `T` 后面那段，中国用户看到的时间早 8 小时。
    const text = String(at ?? '');
    if (!text) return '—';
    if (P.fmt && typeof P.fmt.clockSeconds === 'function') {
      const local = P.fmt.clockSeconds(text);
      if (local !== '—') return local;
    }
    // 兜底：拿不到 core 的格式化器时至少别把 UTC 当本地时间糊上去。
    return text.slice(11, 19) || '—';
  }

  /**
   * 事件列表。
   *
   * `mode` 两档：`live` 走 SSE（持续追加），`snapshot` 走一次性快照（可回看某一轮）。
   * 两档共用同一个渲染，避免"实时看到的和快照看到的不是一回事"。
   */
  function TraceTimeline() {
    const [events, setEvents] = useState([]);
    const [drops, setDrops] = useState(null);
    const [live, setLive] = useState(true);
    const [source, setSource] = useState(null);
    const [note, setNote] = useState(null);
    const [filters, setFilters] = useState({ module: '', status: '', reasonCode: '', traceId: '' });
    const [autoScroll, setAutoScroll] = useState(true);
    const listRef = useRef(null);
    const esRef = useRef(null);

    // 快照模式（也是一次"回读"：把服务端已经落盘的都取回来）。
    const snapshot = P.useApi(
      () => (live ? Promise.resolve(null) : api.get('trace-events', { limit: 300, ...filterRows(filters) })),
      [live, filters.module, filters.status, filters.reasonCode, filters.traceId],
    );

    useEffect(() => {
      if (!live) return undefined;
      const query = toQuery(filters);
      let closed = false;
      let source = null;
      try {
        source = new EventSource(api.url(`trace/stream${query ? `?${query}` : ''}`));
      } catch (error) {
        setNote('这个浏览器不支持事件流，已退回快照模式。');
        setLive(false);
        return undefined;
      }
      esRef.current = source;
      source.addEventListener('ready', (message) => {
        try {
          const data = JSON.parse(message.data);
          setDrops(data.drops ?? null);
        } catch { /* 忽略坏帧 */ }
      });
      source.addEventListener('trace', (message) => {
        try {
          const data = JSON.parse(message.data);
          if (data.source) setSource(data.source);
          if (data.drops) setDrops(data.drops);
          if (data.reset) { setEvents([]); return; }
          const incoming = Array.isArray(data.events) ? data.events : [];
          if (incoming.length) setEvents((previous) => mergeEvents(previous, incoming));
        } catch { /* 忽略坏帧 */ }
      });
      source.addEventListener('trace-error', (message) => {
        try { setNote(JSON.parse(message.data).message || '事件流出错'); } catch { setNote('事件流出错'); }
      });
      source.onerror = () => {
        if (closed) return;
        // **真的**不自动无限重连：`EventSource` 原生会无限重连，光写注释没用。
        // 每次重连都会在服务端新建一条定时器 + 一个 4096 环，所以断开就 close，
        // 由用户决定要不要重来（切页或切模式都会重新建流）。
        closed = true;
        try { source.close(); } catch { /* 已关 */ }
        setNote('事件流断开（宿主可能在重启）。切到快照模式可读已落盘的事件。');
      };
      return () => {
        closed = true;
        try { source.close(); } catch { /* 已关 */ }
      };
    }, [live, filters.module, filters.status, filters.reasonCode, filters.traceId]);

    // 自动滚到底：只在用户没往上翻的时候生效，否则会抢走阅读位置。
    useEffect(() => {
      const node = listRef.current;
      if (!node || !autoScroll) return;
      node.scrollTop = node.scrollHeight;
    }, [events, autoScroll]);

    const shown = live ? events : ((snapshot.data && snapshot.data.events) || []);
    const dropInfo = live ? drops : (snapshot.data ? { total: snapshot.data.total, skipped: snapshot.data.skipped } : null);

    const toggle = (key, value) => setFilters((previous) => ({
      ...previous,
      [key]: previous[key] === value ? '' : value,
    }));

    return h('div', null,
      h('div', { className: 'cpx-tr-bar' },
        h(ui.Button, { key: 'mode', variant: live ? 'primary' : 'ghost', size: 'sm', onClick: () => setLive((value) => !value) },
          live ? '实时（正在推送）' : '快照（已落盘）'),
        h(ui.Button, { key: 'refresh', variant: 'ghost', size: 'sm', onClick: () => (live ? null : snapshot.reload()) }, '重新读取'),
        h('span', { className: 'cpx-tr-meta' }, source ? `来源 ${source}` : ''),
      ),
      h('div', { className: 'cpx-tr-bar' },
        ['memory', 'prompt', 'tool', 'host'].map((module) => h('button', {
          key: `m-${module}`,
          type: 'button',
          className: 'cpx-tr-chip',
          'data-on': filters.module === module ? 'true' : 'false',
          onClick: () => toggle('module', module),
        }, module)),
        ['failed', 'degraded', 'empty'].map((status) => h('button', {
          key: `s-${status}`,
          type: 'button',
          className: 'cpx-tr-chip',
          'data-on': filters.status === status ? 'true' : 'false',
          onClick: () => toggle('status', status),
        }, STATUS_LABEL[status] || status)),
        filters.status || filters.module || filters.reasonCode || filters.traceId
          ? h(ui.Button, {
            key: 'clear',
            variant: 'ghost',
            size: 'sm',
            onClick: () => setFilters({ module: '', status: '', reasonCode: '', traceId: '' }),
          }, '清除过滤')
          : null,
      ),
      note ? h(ui.Callout, { tone: 'warn', title: '诊断流状态变化' }, note) : null,
      shown.length
        ? h('div', {
          className: 'cpx-tr-list',
          ref: listRef,
          onScroll: (event) => {
            const node = event.target;
            const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
            setAutoScroll(atBottom);
          },
        },
          shown.map((event) => h('div', {
            key: event.eventId,
            className: 'cpx-tr-row',
            'data-status': event.status,
          },
            h('span', { className: 'cpx-tr-time' }, timeOf(event.at)),
            h('span', { className: 'cpx-tr-stage' }, event.stage),
            h('span', { className: 'cpx-tr-main' },
              h('span', { className: 'cpx-tr-stage' }, `${event.module} `),
              event.reasonCode ? String(event.reasonCode) : '—'),
            h('span', { className: 'cpx-tr-meta' }, describe(event)),
            h('span', { className: 'cpx-tr-side' },
              h(ui.Badge, { tone: STATUS_TONE[event.status] || 'neutral' }, STATUS_LABEL[event.status] || event.status)),
          )))
        : h('div', { className: 'cpx-tr-empty' },
          live
            ? '还没有事件。做一次对话或一次检索后再看；也可以切到快照模式读已经落盘的事件。'
            : '这个过滤条件下没有事件。'),
      dropInfo
        ? h('div', { className: 'cpx-tr-drops' },
          `读到的：${dropInfo.parsed ?? dropInfo.total ?? 0}`,
          dropInfo.filtered ? ` · 被过滤：${dropInfo.filtered}` : '',
          dropInfo.duplicate ? ` · 去重：${dropInfo.duplicate}` : '',
          dropInfo.corrupt ? ` · 坏行：${dropInfo.corrupt}` : '',
          dropInfo.unsafe ? ` · 不安全行：${dropInfo.unsafe}` : '',
          dropInfo.readError ? ` · 读失败：${dropInfo.readError}` : '',
          dropInfo.skipped ? ` · 跳过：${dropInfo.skipped}` : '',
          dropInfo.droppedReasons ? ` · 丢弃原因：${Object.keys(dropInfo.droppedReasons).join('/')}` : '')
        : null,
    );
  }

  /** 事件合并：按 eventId 去重，保持到达顺序（SSE 可能因为轮转续读重发）。 */
  function mergeEvents(previous, incoming) {
    const seen = new Set(previous.map((event) => event.eventId));
    const appended = [];
    for (const event of incoming) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      appended.push(event);
    }
    if (!appended.length) return previous;
    // 客户端缓冲上限 2000 条：与落盘环一致，避免长时间开着把内存吃掉。
    return [...previous, ...appended].slice(-2000);
  }

  function filterRows(filters) {
    const out = {};
    for (const [key, value] of Object.entries(filters)) if (value) out[key] = value;
    return out;
  }

  function toQuery(filters) {
    return Object.entries(filterRows(filters))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
  }

  /** 记忆侧：把既有 recall 日志的投影拉出来，并按 traceId 折叠成"一轮"。 */
  function MemoryTraces() {
    const state = P.useApi(() => api.get('trace-memory', { limit: 200 }), []);
    const data = state.data || null;
    const rounds = useMemo(() => {
      const events = (data && data.events) || [];
      const groups = new Map();
      for (const event of events) {
        const key = event.traceId || '(no-trace)';
        if (!groups.has(key)) groups.set(key, { traceId: key, at: event.at, events: [] });
        groups.get(key).events.push(event);
      }
      return [...groups.values()].sort((left, right) => String(right.at).localeCompare(String(left.at)));
    }, [data]);

    if (state.error) return h(ui.ErrorBox, { error: state.error, onRetry: state.reload });
    if (!data) return h(ui.Skeleton, { rows: 4 });
    if (data.readable === false) {
      return h(ui.Callout, { tone: 'warn', title: '读不到记忆召回日志' },
        `原因：${data.reason || '未知'}。这条日志由 companion-memory 写，Studio 只读；它读不到时不要当成"没有召回"。`);
    }
    if (!rounds.length) {
      return h(ui.Empty, { title: '还没有召回记录', hint: '记忆引擎还没写过 logs/memory-recall.jsonl。' });
    }
    return h(ui.List, { label: `最近 ${rounds.length} 轮召回` },
      rounds.slice(0, 20).map((round) => {
        const retrieve = round.events.find((event) => event.stage === 'retrieve');
        const inject = round.events.find((event) => event.stage === 'inject');
        return h(ui.Row, {
          key: round.traceId,
          title: round.traceId,
          meta: retrieve
            ? `候选 ${retrieve.counts?.candidates ?? 0} → 过滤后 ${retrieve.counts?.filtered ?? 0}；注入 ${inject?.counts?.characters ?? 0} 字`
            : '',
          side: h('span', { className: 'cpx-tr-side' },
            inject && inject.status === 'empty' ? h(ui.Badge, { tone: 'warn' }, '无结果') : null,
            retrieve ? h(ui.Badge, { tone: STATUS_TONE[retrieve.status] || 'neutral' }, STATUS_LABEL[retrieve.status] || retrieve.status) : null,
            h(ui.Badge, { tone: 'neutral' }, retrieve?.reasonCode || '—')),
        });
      }));
  }

  /** 页面本体：三块（时间线 / 记忆侧 / 说明）。 */
  function TracePage() {
    return h(ui.Page, {
      title: '诊断事件',
      lead: '按 traceId 看一轮从检索到注入、从路由到工具到底发生了什么；只有计数与理由码，没有正文。',
    },
      h(ui.Band, { key: 'live', title: '时间线', hint: '实时推送可切到已落盘快照；被丢弃的事件数始终显示在下方' },
        h(TraceTimeline)),
      h(ui.Band, { key: 'memory', title: '记忆召回（同一份日志的投影）', hint: '数据来自 companion-memory 的 memory-recall.jsonl，Studio 只读不写' },
        h(MemoryTraces)),
      h(ui.Band, { key: 'legend', title: '怎么看这些状态', hint: '状态词与 reasonCode 都来自既有实现，不自创' },
        h(ui.List, { label: '状态图例' }, [
          h(ui.Row, { key: 'ok', title: '成功', meta: '这一阶段正常完成', side: h(ui.Badge, { tone: 'ok' }, 'ok') }),
          h(ui.Row, { key: 'empty', title: '无结果', meta: '跑通了但没有东西可注入（不是错误）', side: h(ui.Badge, { tone: 'neutral' }, 'empty') }),
          h(ui.Row, { key: 'filtered', title: '被过滤', meta: '候选进了门但没过阈值/作用域', side: h(ui.Badge, { tone: 'neutral' }, 'filtered') }),
          h(ui.Row, { key: 'degraded', title: '降级', meta: '跑通了但违背了契约（例如事件字段不合规），原因码会写清楚', side: h(ui.Badge, { tone: 'warn' }, 'degraded') }),
          h(ui.Row, { key: 'failed', title: '失败', meta: '这一阶段抛错或后端不可用', side: h(ui.Badge, { tone: 'danger' }, 'failed') }),
        ])),
    );
  }

  P.registerPage({ id: 'diagnostics-trace', label: '诊断事件', order: 41, component: TracePage });
  P.ui.TraceTimeline = TraceTimeline;
})(P);
