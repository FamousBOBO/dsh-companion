(function (P) {
  // 计划：VoceChat 通道的观察页（只读）。
  //
  // 数据只有三个来源，全是只读 GET：`vocechat`（整体状态）、`vocechat-events`（入站）、
  // `vocechat-deliveries`（出站账本）。前端**不读文件、不拼路径、不解析 jsonl**——三件事
  // 都在服务端守住了（`lib/vocechat-route.mjs`）。
  //
  // 这个页面的立场与其它页面一致：**读不到就如实说读不到**。
  // 插件行没挂载时 `available === false`，页面说的是"这一侧没有文件"，不是"一切正常"。
  // 断口（gap）永远显示，因为它是"真的丢过消息"的唯一直接证据。

  const { h, ui } = P;
  const api = P.api;
  const useState = P.useState;
  const useEffect = P.useEffect;

  P.css(`
    .cpx-vc-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    .cpx-vc-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-secondary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }
    .cpx-vc-chip[data-on="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
    .cpx-vc-row { display: grid; grid-template-columns: 78px 72px minmax(0,1fr) auto; gap: 10px; align-items: baseline; padding: 7px 10px; border-radius: 6px; font-size: 12.5px; }
    .cpx-vc-row:nth-child(odd) { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent); }
    .cpx-vc-row[data-tone="danger"] { box-shadow: inset 3px 0 0 var(--dsw-alias-danger, #d9534f); }
    .cpx-vc-row[data-tone="warn"] { box-shadow: inset 3px 0 0 var(--dsw-alias-warning, #d8a653); }
    .cpx-vc-time { color: var(--dsw-alias-label-tertiary); font: 11px/1.5 var(--cpx-mono); }
    .cpx-vc-tag { color: var(--dsw-alias-label-secondary); font: 11.5px/1.5 var(--cpx-mono); }
    .cpx-vc-main { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); }
    .cpx-vc-side { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
    .cpx-vc-empty { padding: 20px 14px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
    .cpx-vc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
    @media(max-width:760px) {
      .cpx-vc-row { grid-template-columns: 66px minmax(0,1fr); }
      .cpx-vc-side { grid-column: 1 / -1; justify-content: flex-start; }
    }
    @media(prefers-reduced-motion:reduce) { .cpx-vc-row { transition: none; } }
  `);

  const KIND_LABEL = {
    sent: '已发送',
    skipped: '已跳过',
    'turn-start': '回合开始',
    undelivered: '未送达',
  };
  const KIND_TONE = { sent: 'ok', skipped: 'neutral', 'turn-start': 'neutral', undelivered: 'danger' };

  function fmtClock(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '—';
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function fmtStamp(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '—';
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** 目标用判别式说清楚：频道还是私聊，页面不能混。 */
  function targetLabel(target) {
    if (!target) return '目标未知';
    if (target.channel !== undefined && target.channel !== null) return `频道 ${target.channel}`;
    if (target.user !== undefined && target.user !== null) return `私聊 ${target.user}`;
    return '目标未知';
  }

  function StatusBand({ data }) {
    const transport = data.transport || {};
    const events = data.events || {};
    const gaps = data.gaps || {};
    const deliveries = data.deliveries || {};
    const window = deliveries.window || {};

    // 挂载事实缺失 = 插件行没挂（或从未起过）。这是环境事实，不是故障诊断。
    if (!data.available) {
      return h(ui.Band, { key: 'absent', title: '这一侧还没有文件', hint: '两个 VoceChat 行没有写过任何东西，或还没挂载' },
        h(ui.Empty, {
          title: '没有可看的通道事实',
          hint: '传输入站会在 <数据根>/home/channel-vocechat/ 写 mount.json 与游标；适配层在 home/vocechat-adapter/ 写发送账本。这些文件都不存在，说明这一侧还没跑起来 —— 不是"没有消息"。',
        }));
    }

    const items = [
      { k: 'speaks-as', v: transport.uid === null ? '未知' : `uid ${transport.uid}${transport.deviceName ? `（${transport.deviceName}）` : ''}` },
      { k: 'endpoint', v: transport.baseHost || '未知' },
      { k: 'cursor', v: transport.cursorMid === null ? '没有游标' : `mid ${transport.cursorMid}` },
      { k: 'cursor-at', v: fmtStamp(transport.cursorAt) },
    ];

    return h(ui.Band, {
      key: 'facts',
      title: '通道事实',
      hint: '全部来自两个插件写下的文件；这一页不读数据库、不连平台',
    },
      transport.problems && transport.problems.length
        ? h(ui.Callout, { tone: 'warn', title: '插件自己报告了问题' },
          transport.problems.join('；'))
        : null,
      h(ui.KeyValue, { items }),

      // 四个数字分开摆：入站存量、断口、窗口内发送、窗口内跳过。
      // 「窗口内」必须写出来，否则会被当成累计值。
      h('div', { className: 'cpx-vc-stats', style: { marginTop: '12px' } },
        h(ui.Stat, {
          key: 'events',
          label: '已接收事件',
          value: events.readable ? String(events.stored) : '读不到',
          hint: events.readable ? 'events.jsonl 里的总条数' : (events.reason || ''),
          tone: events.readable ? '' : 'warn',
        }),
        h(ui.Stat, {
          key: 'gaps',
          label: '补播断口',
          // 0 与"读不到"必须分开：一个是"没丢过"，一个是"不知道"。
          value: gaps.readable ? String(gaps.count) : '读不到',
          hint: gaps.readable
            ? (gaps.count ? '这些 mid 区间没有补回来 —— 它们是真丢的' : '没有断口记录')
            : (gaps.reason || ''),
          tone: gaps.readable ? (gaps.count ? 'danger' : '') : 'warn',
        }),
        h(ui.Stat, {
          key: 'sent',
          label: '窗口内已发送',
          value: deliveries.readable ? String(window.sent ?? 0) : '读不到',
          hint: deliveries.readable ? '最近一段账本里的成功发送（窗口，不是累计）' : (deliveries.reason || ''),
          tone: (window.failed || window.undelivered) ? 'warn' : '',
        }),
        h(ui.Stat, {
          key: 'failed',
          label: '窗口内失败/未送达',
          value: deliveries.readable ? String((window.failed ?? 0) + (window.undelivered ?? 0)) : '读不到',
          hint: deliveries.readable ? '调用了工具但没出去' : (deliveries.reason || ''),
          tone: (window.failed || window.undelivered) ? 'danger' : '',
        }),
      ),

      gaps.readable && gaps.recent && gaps.recent.length
        ? h(ui.Diagnostic, { key: 'gaps', title: '补播断口明细', hint: 'after_mid 补播在这里断过，那些 mid 从来没到过宿主', open: true },
          h(ui.List, { label: '补播断口' },
            gaps.recent.map((gap) => h(ui.Row, {
              key: `gap-${gap.from}-${gap.to}`,
              title: `mid ${gap.from} → ${gap.to}`,
              meta: `${fmtStamp(gap.at)} · ${gap.reason || '未记录原因'}`,
              side: h(ui.Badge, { tone: 'danger' }, '丢消息'),
            }))))
        : null,
    );
  }

  function EventsBand({ query, setQuery }) {
    const list = P.useApi(() => api.get('vocechat-events'), []);
    const [full, setFull] = useState(null);
    const [fullMid, setFullMid] = useState(null);
    const [fullError, setFullError] = useState('');

    const data = list.data || null;
    useEffect(() => { setFull(null); setFullMid(null); setFullError(''); }, [list.data]);
    const events = (data && data.events) || [];
    const needle = query.trim().toLowerCase();
    const shown = needle
      ? events.filter((item) => item.preview.toLowerCase().includes(needle)
        || String(item.mid ?? '').includes(needle)
        || String(item.fromUid ?? '').includes(needle))
      : events;

    async function openFull(mid) {
      setFullMid(mid);
      setFullError('');
      try {
        const result = await api.get('vocechat-events', { mid, full: 1 });
        if (result && result.full) setFull(result.full);
        else setFullError(result && result.reason === 'mid-not-in-window'
          ? '这条不在当前窗口内（文件里更早的记录不在这里显示）。'
          : '这条读不到全文。');
      } catch (error) {
        setFullError(String(error && error.message ? error.message : error));
      }
    }

    if (list.error) {
      return h(ui.ErrorBox, { error: list.error, onRetry: list.reload });
    }
    if (!data) return h(ui.Skeleton, { rows: 6 });
    if (!data.available) {
      return h(ui.Empty, {
        title: '入站事件读不到',
        hint: data.reason === 'missing'
          ? '传输入站还没有写过 events.jsonl —— 插件行没挂载，或者从没收到过消息。'
          : `读取失败：${data.reason || '未知原因'}`,
      });
    }

    return h(ui.Band, {
      key: 'events',
      title: '已接收事件',
      hint: data.returned < data.total
        ? `文件里共 ${data.total} 条，这里只显示最近 ${data.returned} 条（正文只给前 ${data.previewChars} 字）`
        : '正文只给预览；要看全文点开单条',
      actions: [
        h(ui.Input, {
          key: 'q',
          value: query,
          placeholder: '搜正文 / mid / uid',
          width: '200px',
          ariaLabel: '搜索入站事件',
          onChange: (next) => setQuery(next),
        }),
      ],
    },
      shown.length
        ? h(ui.List, { label: `入站事件 ${shown.length} 条` },
          shown.map((item) => h('button', {
            key: item.mid,
            type: 'button',
            className: 'cpx-vc-row',
            'data-tone': item.previewTruncated ? '' : '',
            onClick: () => openFull(item.mid),
          },
            h('span', { className: 'cpx-vc-time' }, fmtClock(item.at)),
            h('span', { className: 'cpx-vc-tag' }, `mid ${item.mid ?? '—'}`),
            h('span', { className: 'cpx-vc-main' },
              item.preview,
              item.previewTruncated ? h('span', { className: 'cpx-vc-tag' }, ` （共 ${item.chars} 字）`) : null),
            h('span', { className: 'cpx-vc-side' },
              h(ui.Badge, { tone: 'neutral' }, targetLabel(item.target)),
              h(ui.Badge, { tone: 'neutral' }, `uid ${item.fromUid ?? '—'}`)),
          )))
        : h('div', { className: 'cpx-vc-empty' },
          needle ? '当前搜索没有命中。' : '还没有入站事件。'),

      data.skipped
        ? h('div', { className: 'cpx-vc-tag', style: { marginTop: '10px' } }, `有 ${data.skipped} 行读不成 JSON，已跳过`)
        : null,

      full
        ? h(ui.Diagnostic, { key: 'full', title: `mid ${full.mid} 的全文`, hint: '只对单条生效，需要显式给 mid', open: true },
          h(ui.KeyValue, {
            items: [
              { k: 'mid', v: String(full.mid) },
              { k: 'from', v: `uid ${full.fromUid ?? '—'}` },
              { k: 'target', v: targetLabel(full.target) },
              { k: 'type', v: full.contentType || '—' },
              { k: 'at', v: fmtStamp(full.at) },
            ],
          }),
          h(ui.Pre, { maxHeight: '40vh' }, full.content))
        : null,
      fullError
        ? h('div', { className: 'cpx-vc-tag', style: { marginTop: '8px' } }, fullError)
        : null,
      fullMid !== null && !full && !fullError
        ? h('div', { className: 'cpx-vc-tag' }, `正在取 mid ${fullMid} 的全文…`)
        : null,
    );
  }

  function DeliveriesBand() {
    const [kind, setKind] = useState('');
    const list = P.useApi(() => api.get('vocechat-deliveries', { kind }), [kind]);
    const data = list.data || null;
    const entries = (data && data.entries) || [];

    if (list.error) {
      return h(ui.ErrorBox, { error: list.error, onRetry: list.reload });
    }
    if (!data) return h(ui.Skeleton, { rows: 6 });
    if (!data.available) {
      return h(ui.Empty, {
        title: '发送账本读不到',
        hint: data.reason === 'missing'
          ? '适配层还没有写过 sent-log.jsonl —— 这一侧没有在驱动回合。'
          : `读取失败：${data.reason || '未知原因'}`,
      });
    }

    return h(ui.Band, {
      key: 'deliveries',
      title: '发送账本',
      hint: '「没调用工具」和「调用了但失败」在这里才分得开'
        + (data.returned < data.total ? `；账本共 ${data.total} 条，这里显示最近 ${data.returned} 条` : ''),
      actions: (data.kinds || []).map((item) => h('button', {
        key: item,
        type: 'button',
        className: 'cpx-vc-chip',
        'data-on': kind === item ? 'true' : 'false',
        onClick: () => setKind((prev) => (prev === item ? '' : item)),
      }, KIND_LABEL[item] || item)),
    },
      entries.length
        ? h(ui.List, { label: `发送账本 ${entries.length} 条` },
          entries.map((item, index) => {
            const failed = item.kind === 'undelivered' || item.ok === false;
            return h('div', {
              key: `${item.kind}-${item.mid}-${item.at}-${index}`,
              className: 'cpx-vc-row',
              'data-tone': failed ? 'danger' : '',
            },
              h('span', { className: 'cpx-vc-time' }, fmtClock(item.at)),
              h('span', { className: 'cpx-vc-tag' }, item.room || '—'),
              h('span', { className: 'cpx-vc-main' },
                item.preview || item.reason || item.error || '（无正文）',
                item.segment
                  ? h('span', { className: 'cpx-vc-tag' }, ` （第 ${item.segment}/${item.of} 段）`)
                  : null,
                item.error ? h('span', { className: 'cpx-vc-tag' }, ` · ${item.error}`) : null),
              h('span', { className: 'cpx-vc-side' },
                h(ui.Badge, { tone: KIND_TONE[item.kind] || 'neutral' }, KIND_LABEL[item.kind] || item.kind),
                item.mid !== null ? h(ui.Badge, { tone: 'neutral' }, `mid ${item.mid}`) : null),
            );
          }))
        : h('div', { className: 'cpx-vc-empty' },
          kind ? '这个类型下还没有记录。' : '账本里还没有记录。'),

      data.skipped
        ? h('div', { className: 'cpx-vc-tag', style: { marginTop: '10px' } }, `有 ${data.skipped} 行读不成 JSON，已跳过`)
        : null,
    );
  }

  function VoceChatPage() {
    const [query, setQuery] = useState('');
    const status = P.useApi(() => api.get('vocechat'), []);
    const data = status.data || null;

    if (status.error) {
      return h(ui.Page, { title: 'VoceChat 通道', lead: '入站、出站与断口，全部只读。' },
        h(ui.ErrorBox, { error: status.error, onRetry: status.reload }));
    }
    if (!data) {
      return h(ui.Page, { title: 'VoceChat 通道', lead: '入站、出站与断口，全部只读。' },
        h(ui.Skeleton, { rows: 6 }));
    }

    return h(ui.Page, {
      title: 'VoceChat 通道',
      lead: '她在这个通道里收到了什么、发出了什么、有没有丢过。这一页只读文件，不写配置、不连平台。',
      status: data.transport && data.transport.cursorMid !== null
        ? `游标 mid ${data.transport.cursorMid}`
        : '没有游标',
    },
      h(StatusBand, { data }),
      h(EventsBand, { query, setQuery }),
      h(DeliveriesBand),
    );
  }

  P.registerPage({ id: 'vocechat', label: 'VoceChat', order: 43, component: VoceChatPage });
  P.ui.VoceChatStatus = StatusBand;
})(P);
