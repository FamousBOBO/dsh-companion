(function (P) {
  // 计划 W3：作品中心（只读浏览 + 预览）。
  //
  // 数据只有两个来源：`GET /works`（现场派生的列表）与 `GET /work-detail`（受限预览）。
  // 前端**不做**路径拼接、不读绝对路径、不做 HTML 渲染——这三件事都在服务端守住了。
  // 首版只读：没有覆盖编辑、删除、分享入口（计划 W3 第 5 条）。

  const { h, ui } = P;
  const api = P.api;
  const useState = P.useState;
  const useEffect = P.useEffect;

  P.css(`
    .cpx-wk-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    .cpx-wk-item { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 3px 12px; width: 100%; text-align: left; padding: 9px 12px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
    .cpx-wk-item[data-active="true"] { background: var(--dsw-alias-bg-layer-2); }
    .cpx-wk-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
    .cpx-wk-title { color: var(--dsw-alias-label-primary); font-size: 13.5px; overflow-wrap: anywhere; }
    .cpx-wk-meta { color: var(--dsw-alias-label-tertiary); font: 11.5px/1.6 var(--cpx-mono); overflow-wrap: anywhere; }
    .cpx-wk-side { display: flex; align-items: center; gap: 6px; grid-row: 1 / span 2; }
    .cpx-wk-preview { max-height: 46vh; overflow: auto; padding: 12px 14px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: 12.5px/1.75 var(--cpx-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
    .cpx-wk-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-secondary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }
    .cpx-wk-chip[data-on="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
    .cpx-wk-empty { padding: 22px 14px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
    /* 窄窗口：列表项从"标题+侧栏"并排改成上下堆叠，预览区不占满整屏。 */
    @media(max-width:760px) {
      .cpx-wk-item { grid-template-columns: minmax(0,1fr); }
      .cpx-wk-side { grid-row: auto; justify-content: flex-start; }
      .cpx-wk-preview { max-height: 38vh; }
    }
    @media(prefers-reduced-motion:reduce) { .cpx-wk-item { transition: none; } }
  `);

  const STATUS_TONE = { done: 'ok', review: 'warn', running: 'neutral', failed: 'danger', draft: 'neutral' };
  const STATUS_LABEL = { done: '已完成', review: '待核对', running: '进行中', failed: '失败', draft: '草稿' };
  const TYPE_FILTERS = ['md', 'txt', 'json', 'csv'];
  const STATUS_FILTERS = ['done', 'review', 'running', 'failed', 'draft'];

  function fmtTime(at) {
    try {
      const date = new Date(at);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    } catch { return String(at ?? '—'); }
  }

  function fmtSize(bytes) {
    const value = Number(bytes ?? 0);
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function WorksPage() {
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    const [type, setType] = useState('');
    const [status, setStatus] = useState('');
    const [openPath, setOpenPath] = useState('');

    useEffect(() => {
      const timer = setTimeout(() => setDebounced(query), 220);
      return () => clearTimeout(timer);
    }, [query]);

    const list = P.useApi(
      () => api.get('works', { q: debounced, type, status }),
      [debounced, type, status],
    );
    const detail = P.useApi(
      () => (openPath ? api.get('work-detail', { path: openPath }) : Promise.resolve(null)),
      [openPath],
    );

    const data = list.data || null;
    const items = (data && data.items) || [];
    const selected = (detail.data && detail.data.ok) ? detail.data : null;
    const selectedProblem = (detail.data && !detail.data.ok) ? detail.data : null;

    // 目录不存在与"没有作品"必须分开说：前者是环境问题，后者是空结果。
    if (list.error) {
      return h(ui.Page, { title: '作品', lead: '只读浏览工作区里的产出。' },
        h(ui.ErrorBox, { error: list.error, onRetry: list.reload }));
    }
    if (!data) {
      return h(ui.Page, { title: '作品', lead: '只读浏览工作区里的产出。' },
        h(ui.Skeleton, { rows: 6 }));
    }
    if (!data.available) {
      return h(ui.Page, { title: '作品', lead: '只读浏览工作区里的产出。' },
        h(ui.Empty, {
          title: '作品目录还没建起来',
          hint: `配置的作品根是「${data.root && data.root.configured ? data.root.configured : '未设置'}」，但这个目录当前不存在。这不是"没有作品"，是环境还没就绪。`,
        }));
    }

    return h(ui.Page, {
      title: '作品',
      lead: '工作区里的产出：按标题/类型/日期过滤，只读预览；没有编辑、删除或分享入口。',
      status: data.total ? `${data.items.length}/${data.total} 份` : '空',
    },
      h(ui.Band, {
        key: 'list',
        title: '作品列表',
        hint: data.evidence && !data.evidence.available
          ? `运行时证据不可用（${data.evidence.reason}），所以状态一律按"未完成"处理`
          : '状态来自 activity 与 receipt；没有 finish 收据的不会标「已完成」',
        actions: [
          h(ui.Input, {
            key: 'q',
            value: query,
            placeholder: '搜标题或路径',
            width: '200px',
            ariaLabel: '搜索作品',
            onChange: (next) => setQuery(next),
          }),
        ],
      },
        h('div', { className: 'cpx-wk-bar', key: 'filters' },
          TYPE_FILTERS.map((item) => h('button', {
            key: `t-${item}`,
            type: 'button',
            className: 'cpx-wk-chip',
            'data-on': type === item ? 'true' : 'false',
            onClick: () => setType((previous) => (previous === item ? '' : item)),
          }, item)),
          STATUS_FILTERS.map((item) => h('button', {
            key: `s-${item}`,
            type: 'button',
            className: 'cpx-wk-chip',
            'data-on': status === item ? 'true' : 'false',
            onClick: () => setStatus((previous) => (previous === item ? '' : item)),
          }, STATUS_LABEL[item] || item)),
          (type || status || query)
            ? h(ui.Button, { key: 'clear', variant: 'ghost', size: 'sm', onClick: () => { setType(''); setStatus(''); setQuery(''); } }, '清除')
            : null,
        ),
        items.length
          ? h(ui.List, { label: `作品 ${data.total} 份` },
            items.map((item) => h('button', {
              key: item.relative,
              type: 'button',
              className: 'cpx-wk-item',
              'data-active': openPath === item.relative ? 'true' : 'false',
              'data-work-path': item.relative,
              onClick: () => setOpenPath(item.relative),
            },
              h('span', { className: 'cpx-wk-title' }, item.title),
              h('span', { className: 'cpx-wk-meta' },
                `${item.type} · ${fmtSize(item.size)} · v${item.version} · ${fmtTime(item.modifiedAt)}`,
                item.otherVersions ? ` · 另有 ${item.otherVersions} 个旧版本` : ''),
              h('span', { className: 'cpx-wk-side' },
                h(ui.Badge, { tone: STATUS_TONE[item.status] || 'neutral' }, item.statusLabel || item.status),
                item.preview && item.preview.ok === false
                  ? h(ui.Badge, { tone: 'neutral' }, '不可预览')
                  : null),
            )))
          : h('div', { className: 'cpx-wk-empty' },
            data.total
              ? `搜索/过滤条件下没有结果（这一页展示 ${data.items.length} 条，total ${data.total} 是过滤后的命中数）。`
              : (data.evidence && !data.evidence.available
                ? '运行时还没有写作品的记录（证据库不可用）。'
                : '作品目录里还没有被活动引用过的文件。')),
        data.skipped
          ? h('div', { className: 'cpx-wk-meta', style: { marginTop: '10px' } },
            `有 ${data.skipped} 条引用走不到文件：${Object.keys(data.skippedReasons || {}).join('/')}（越界引用由服务端 fail-closed 拒绝）`)
          : null,
      ),
      h(ui.Band, {
        key: 'preview',
        title: selected ? selected.title : '预览',
        hint: selected
          ? `${selected.relative} · ${fmtSize(selected.size)} · 修改于 ${fmtTime(selected.modifiedAt)}`
          : '选一份作品来看内容；文本以外一律不在浏览器里渲染',
      },
        selectedProblem
          ? h(ui.Callout, { tone: 'warn', title: `这份作品读不了（${selectedProblem.reason}）` },
            selectedProblem.meta
              ? `类型 ${selectedProblem.meta.type} · ${fmtSize(selectedProblem.meta.size)}。这里不执行 HTML、脚本或未知附件；需要看原文件请用宿主的打开能力。`
              : '路径被拒绝或文件已不存在。')
          : null,
        selected
          ? h('div', null,
            h('div', { className: 'cpx-wk-bar' },
              h(ui.Badge, { tone: STATUS_TONE[selected.status] || 'neutral' }, STATUS_LABEL[selected.status] || selected.status),
              h(ui.Badge, { tone: 'neutral' }, `v${selected.version}`),
              selected.hashPrefix ? h(ui.Badge, { tone: 'neutral' }, `sha256 ${selected.hashPrefix}…`) : null,
              selected.evidence && selected.evidence.finishReceipted
                ? h(ui.Badge, { tone: 'ok' }, 'finish 收据')
                : h(ui.Badge, { tone: 'neutral' }, '无 finish 收据')),
            h('pre', { className: 'cpx-wk-preview' }, selected.text),
            selected.evidence && selected.evidence.receiptCodes && selected.evidence.receiptCodes.length
              ? h('div', { className: 'cpx-wk-meta', style: { marginTop: '8px' } },
                `最近收据：${selected.evidence.receiptCodes.join(' · ')}`)
              : null)
          : h('div', { className: 'cpx-wk-empty' }, '还没选作品。'),
      ),
    );
  }

  P.registerPage({ id: 'works', label: '作品', order: 42, component: WorksPage });
})(P);
