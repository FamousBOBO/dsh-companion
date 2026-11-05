// 陪伴空间 · 运行状态（page id: overview，归入「设置 › 高级诊断」）
//
// 只读诊断页：数字来自 GET summary（counts / jobs / backend / observedAt），
// 运行库可用性来自 GET companion 的 runtime.available。
// 唯一会写入数据库的是「维护」里的动作（POST maintenance），全部二次确认、等回执。
(function (P) {
  const h = P.h;
  const ui = P.ui;
  const api = P.api;
  const fmt = P.fmt;
  const useState = P.useState;

  // 外壳只渲染 P.notice / P.toastOnce 推来的提示，页面自己不留 toast 状态。
  const notify = (message, tone) => {
    if (typeof P.notice === 'function') P.notice(message, tone || 'neutral');
  };
  // 失败原因统一带上后端错误码。
  const failText = (error, fallback) => (typeof P.failText === 'function'
    ? P.failText(error, fallback || '未知错误')
    : (error && error.message ? error.message : (fallback || '未知错误')));

  P.css(`
.cpxp-ov-block { display: flex; flex-direction: column; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-ov-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.7; overflow-wrap: anywhere; }
.cpxp-ov-json { margin: 0; }
.cpxp-ov-health-stamp { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--cpx-s2, 8px); color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); }
.cpxp-ov-health-line { margin: 0; color: var(--dsw-alias-label-primary); font-size: var(--cpx-fs-body, 14.5px); overflow-wrap: anywhere; }
`);

  const text = value => (value === null || value === undefined ? '' : String(value));

  // 未知一律显示 —，不把「读不到」画成 0。
  const num = value => (typeof value === 'number' && Number.isFinite(value) ? fmt.number(value) : '—');
  const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  const BACKEND_LABELS = { sqlite: 'SQLite 记忆库', legacy: 'legacy 旧快照' };
  const MAINT_LABELS = { rebuild: '重建索引', integrity: '完整性检查' };

  function rebuildSummary(receipt) {
    const search = receipt && receipt.search && typeof receipt.search === 'object' ? receipt.search : null;
    const embeddings = receipt && receipt.embeddings && typeof receipt.embeddings === 'object' ? receipt.embeddings : null;
    const wiki = receipt && receipt.wiki && typeof receipt.wiki === 'object' ? receipt.wiki : null;
    const parts = [];
    if (search && typeof search.memories === 'number') parts.push(`检索索引 ${fmt.number(search.memories)} 条`);
    if (embeddings && typeof embeddings.embedded === 'number') parts.push(`向量 ${fmt.number(embeddings.embedded)} 条`);
    if (wiki) parts.push(wiki.compiled ? 'Wiki 已重编译' : 'Wiki 没有重编译');
    return parts.length ? `重建完成：${parts.join(' · ')}。` : '重建完成，后端没有返回明细。';
  }

  function integritySummary(receipt) {
    if (!receipt || typeof receipt !== 'object') return '检查完成，后端没有返回明细。';
    if (receipt.ok === true) return '完整性检查通过：数据库结构没有报错。';
    const messages = Array.isArray(receipt.messages) ? receipt.messages.filter(item => typeof item === 'string') : [];
    if (!messages.length) return '完整性检查没有通过，但没有返回具体信息。';
    return `完整性检查发现问题：${messages.slice(0, 2).join('；')}`;
  }

  function OverviewPage() {
    const summary = P.useApi(() => api.get('summary'), []);
    const companion = P.useApi(() => api.get('companion'), []);
    const [busy, setBusy] = useState('');
    const [maint, setMaint] = useState(null);
    // 实时健康：进场先探一次，之后每 20 秒一轮。必须在任何 early return 之前调用。
    const health = P.useLiveHealth();

    const data = summary.data && typeof summary.data === 'object' ? summary.data : null;
    const counts = data && data.counts && typeof data.counts === 'object' ? data.counts : {};
    const jobs = data && data.jobs && typeof data.jobs === 'object' ? data.jobs : {};
    const channels = data && data.channels && typeof data.channels === 'object' ? data.channels : {};
    const embedding = channels.embedding && typeof channels.embedding === 'object' ? channels.embedding : {};
    const integrity = data && data.integrity && typeof data.integrity === 'object' ? data.integrity : null;
    const companionData = companion.data && typeof companion.data === 'object' ? companion.data : null;
    const runtime = companionData && companionData.runtime && typeof companionData.runtime === 'object'
      ? companionData.runtime
      : null;
    const locked = Boolean(busy);

    const backendText = data ? (BACKEND_LABELS[text(data.backend)] || text(data.backend) || '—') : '—';
    const failed = count(jobs.failed);
    const pending = count(jobs.pending);
    const running = count(jobs.running);

    const refresh = () => {
      summary.reload();
      companion.reload();
    };

    const runMaintenance = (action, needsConfirm) => {
      if (locked) return;
      if (needsConfirm) {
        const proceed = typeof P.confirm === 'function'
          ? P.confirm('重建检索索引、补齐向量并重编译 Wiki？\n\n这会写入记忆库，期间检索结果可能短暂不完整；耗时随库大小增长。')
          : false;
        if (!proceed) return;
      }
      setBusy(action);
      setMaint(null);
      api.post('maintenance', { action }).then(result => {
        if (result && result.ok === false) {
          setMaint({ action, ok: false, message: text(result.error || result.message) || '后端拒绝了这次维护' });
          return;
        }
        setMaint({ action, ok: true, receipt: result && result.result ? result.result : result });
        if (action === 'rebuild') summary.reload();
        notify(`${MAINT_LABELS[action] || action}完成。`, 'ok');
      }, error => {
        setMaint({ action, ok: false, message: failText(error) });
      }).then(() => setBusy(''));
    };

    // 诊断原文里不带最近记忆预览：那是正文，不在诊断页露出。
    const diagnosticJson = () => {
      if (!data) return '—';
      const copy = { ...data };
      delete copy.recent;
      try {
        return JSON.stringify(copy, null, 2);
      } catch {
        return '（无法序列化）';
      }
    };

    const row = (key, title, meta, side) => h(ui.Row, { key, title, meta, side });

    // -- 状态栏（实时健康，只读探测）-------------------------------------------

    const renderHealth = () => {
      const summary = P.health.summarize(health.items);
      const attention = summary.warn + summary.down;
      // 数字全部现算，不写死：正常 / 要留意 / 未接入 / 未知各自计数，绝不用 0 冒充未知。
      const parts = [];
      if (summary.total) {
        parts.push(`${summary.ok} 项正常`);
        if (attention) parts.push(`${attention} 项要留意`);
        if (summary.off) parts.push(`${summary.off} 项未接入`);
        if (summary.unknown) parts.push(`${summary.unknown} 项未知`);
      }
      const headline = `${summary.total} 项：${parts.join(' · ')}`;
      const seconds = Math.round((health.cadence || P.health.cadence || 20000) / 1000);
      const paceText = health.paused
        ? '已暂停'
        : `节奏 ${seconds} 秒`;
      const openPage = item => {
        if (!item || !item.page) return;
        try { P.nav.go(item.page); } catch { notify('外壳没有这个页面，跳不过去。', 'warn'); }
      };
      return h(ui.Band, {
        key: 'health',
        title: '状态栏',
        hint: '',
        info: '每 20 秒自动探测一次，只发 GET，不写库；页面隐藏时暂停探测。「未接入 / 未知」表示这项能力没有配置或本轮读不到，不是 0。',
        actions: [
          h(ui.Button, {
            key: 'health-refresh',
            variant: 'ghost',
            size: 'sm',
            onClick: health.refresh,
            loading: health.loading,
            ariaLabel: '立刻重新探测一次',
          }, '刷新'),
          h(ui.Button, {
            key: 'health-pause',
            variant: 'ghost',
            size: 'sm',
            onClick: health.togglePaused,
            ariaLabel: health.paused ? '继续自动探测' : '暂停自动探测',
          }, health.paused ? '继续' : '暂停'),
        ],
        children: [
          h('div', { key: 'health-stamp', className: 'cpxp-ov-health-stamp' },
            health.at
              ? h(ui.Timestamp, { key: 'at', at: health.at, prefix: '探测于' })
              : h('span', { key: 'at' }, '还没探测过'),
            h('span', { key: 'pace' }, paceText)),
          health.items.length === 0 && health.loading
            ? h(ui.Skeleton, { key: 'health-loading', rows: 4 })
            : null,
          health.items.length === 0 && !health.loading
            ? h(ui.Callout, {
              key: 'health-empty',
              tone: 'warn',
              title: '这一轮没有拿到任何探测结果',
              action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: health.refresh }, '重新探测'),
            }, health.paused
              ? '自动探测已暂停，点「重新探测」立刻跑一轮。'
              : '接口可能暂时不通，再试一次。')
            : null,
          health.items.length
            ? h('p', { key: 'health-line', className: 'cpxp-ov-health-line' }, headline)
            : null,
          health.items.length
            ? h(ui.HealthBoard, {
              key: 'health-board',
              items: health.items,
              now: health.now,
              onOpen: openPage,
            })
            : null,
        ],
      });
    };

    const renderStorage = () => h(ui.Band, {
      key: 'storage',
      title: '存储',
      hint: '',
      info: '记忆是审核过的结构化条目，事件是对话里的原文记录，Wiki 是自动编译的主题页。数字直接来自记忆库，读不到显示 —，不是 0。',
      actions: [
        h(ui.StateLine, {
          key: 'backend-state',
          state: data ? (text(data.backend) === 'sqlite' ? 'ok' : 'warn') : 'idle',
          text: data ? `后端 ${backendText}` : '还没读到后端',
        }),
      ],
      children: [
        h(ui.List, { key: 'counts', label: '存储计数' }, [
          row('memories', '结构化记忆', `已确认 ${num(counts.confirmed)} · 待确认 ${num(counts.pending)}`, num(counts.memories)),
          row('events', '会话事件', '证据原文', num(counts.events)),
          row('wiki', 'Wiki 页', channels.wiki && channels.wiki.enabled ? '自动编译已开启' : '自动编译已关闭', num(counts.wikiPages)),
          row('embeddings', '向量记录', text(embedding.model) ? `用于语义检索 · ${text(embedding.model)}` : '用于语义检索', num(counts.embeddings)),
          row('relations', '关系', '事实之间的连线', num(counts.relations)),
          row(
            'runtime',
            '陪伴运行库',
            runtime
              ? (runtime.available === true ? '日程、心跳与桥接的数据源可读' : '运行库还没初始化，日程与桥接数据读不到')
              : '还没读到运行库状态',
            runtime
              ? h(ui.Badge, { tone: runtime.available === true ? 'ok' : 'warn' }, runtime.available === true ? '可用' : '不可用')
              : h(ui.Badge, { tone: 'neutral' }, '未知'),
          ),
        ]),
        data && text(data.reason)
          ? h(ui.Callout, { key: 'reason', tone: 'warn', title: '记忆引擎回落到 legacy 后端' }, text(data.reason))
          : null,
      ],
    });

    const renderJobs = () => h(ui.Band, {
      key: 'jobs',
      title: '作业',
      hint: '',
      info: '后台把对话整理成记忆、算向量、编译 Wiki 的任务队列；失败会停在那里，等下一次重建或提炼。后台没有单独「重试某个作业」的接口，所以这里的重试就是重建索引。',
      actions: [
        h(ui.StateLine, {
          key: 'jobs-state',
          state: failed === null ? 'idle' : failed > 0 ? 'danger' : pending ? 'warn' : 'ok',
          text: failed === null ? '队列状态未知' : failed > 0 ? `有 ${fmt.number(failed)} 个失败作业` : pending ? `待处理 ${fmt.number(pending)} 个` : '队列正常',
        }),
      ],
      children: [
        h(ui.List, { key: 'job-counts', label: '作业计数' }, [
          row('failed', '失败', '停在这里，需要一次重建或重新提炼', num(jobs.failed)),
          row('pending', '待处理', '已排队，还没开始', num(jobs.pending)),
          row('running', '运行中', '正在跑的批次', num(jobs.running)),
          row('done', '已完成', '累计成功处理的批次', num(jobs.done)),
        ]),
        jobs.lastError
          ? h(ui.Callout, {
            key: 'last-error',
            tone: 'danger',
            title: '最近一次失败原因',
            action: failed
              ? h(ui.Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: locked,
                loading: busy === 'rebuild',
                onClick: () => runMaintenance('rebuild', true),
              }, '重建索引试试')
              : null,
          }, text(jobs.lastError))
          : null,
        failed && !jobs.lastError
          ? h(ui.Callout, {
            key: 'failed-no-reason',
            tone: 'warn',
            title: `有 ${fmt.number(failed)} 个失败作业，但没有留下错误原因`,
            action: h(ui.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: locked,
              loading: busy === 'rebuild',
              onClick: () => runMaintenance('rebuild', true),
            }, '重建索引试试'),
          })
          : null,
      ],
    });

    const renderMaintenance = () => {
      const receipt = maint && maint.receipt ? maint.receipt : null;
      const rawLabel = maint && maint.action === 'integrity' ? '完整性检查回执' : '重建索引回执';
      const humanText = maint
        ? (maint.action === 'integrity' ? integritySummary(receipt) : rebuildSummary(receipt))
        : '';
      return h(ui.Band, {
        key: 'maintenance',
        title: '维护',
        hint: '会动数据库，需要确认。',
        info: '重建索引会重算 FTS 与向量、重编译 Wiki，按库大小可能要等一会儿，期间检索结果可能不完整；完整性检查只读，不改数据。',
        children: [
          h(ui.Toolbar, { key: 'maint-actions', label: '维护动作' }, [
            h(ui.Button, {
              key: 'rebuild',
              variant: 'danger',
              disabled: locked,
              loading: busy === 'rebuild',
              title: '重算 FTS 与向量，并把 Wiki 重编译一次（会二次确认）',
              onClick: () => runMaintenance('rebuild', true),
            }, '重建索引'),
            h(ui.Button, {
              key: 'integrity',
              variant: 'ghost',
              disabled: locked,
              loading: busy === 'integrity',
              title: '只读检查，不改数据',
              onClick: () => runMaintenance('integrity', false),
            }, '完整性检查'),
          ]),
          integrity && integrity.checkedAt
            ? h('p', { key: 'integrity-when', className: 'cpxp-ov-note' },
              '上次完整性检查 ',
              h(ui.Timestamp, { at: integrity.checkedAt }),
              integrity.ok === false ? '（当时发现了问题）' : '')
            : h('p', { key: 'integrity-when', className: 'cpxp-ov-note' },
              '这次启动还没跑过完整性检查。'),
          maint && !maint.ok
            ? h(ui.Callout, {
              key: 'maint-error',
              tone: 'danger',
              title: `${MAINT_LABELS[maint.action] || maint.action}失败`,
              action: h(ui.Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: locked,
                onClick: () => runMaintenance(maint.action, maint.action === 'rebuild'),
              }, '重试'),
            }, maint.message)
            : null,
          maint && maint.ok
            ? h(ui.Callout, {
              key: 'maint-ok',
              tone: 'ok',
              title: `${MAINT_LABELS[maint.action] || maint.action}完成`,
            }, humanText)
            : null,
          maint && maint.ok
            ? h(ui.Diagnostic, { key: 'receipt', title: rawLabel },
              h(ui.Pre, { maxHeight: '220px' },
                typeof receipt === 'string' ? receipt : JSON.stringify(receipt, null, 2)))
            : null,
        ],
      });
    };

    const renderDiagnostics = () => {
      const config = data && data.config && typeof data.config === 'object' ? data.config : {};
      const extraction = channels.extraction && typeof channels.extraction === 'object' ? channels.extraction : {};
      const wiki = channels.wiki && typeof channels.wiki === 'object' ? channels.wiki : {};
      return h(ui.Band, {
        key: 'diagnostics',
        title: '诊断',
        hint: '',
        info: '给排障用：这些是接口原样返回的字段，页面本身只读。',
        children: [
          h(ui.Diagnostic, { key: 'channels', title: '通道与检索配置' },
            h(ui.KeyValue, {
              items: [
                { k: '关键词（FTS）', v: text(channels.fts) || '—', mono: true },
                { k: '语义通道', v: config.semanticEnabled === true ? '开启' : config.semanticEnabled === false ? '关闭' : '—' },
                { k: '向量提供器', v: text(embedding.provider) || '—', mono: true },
                { k: '向量模型', v: text(embedding.model) || '（未配置）', mono: true, breakable: true },
                { k: '向量说明', v: text(embedding.note) || '—' },
                { k: '自动提炼', v: extraction.enabled === true ? '开启' : extraction.enabled === false ? '关闭' : '—' },
                { k: '提炼模型', v: text(extraction.model) || '—', mono: true },
                { k: '提炼阈值', v: typeof extraction.minMessages === 'number' ? `${extraction.minMessages} 条` : '—' },
                { k: 'Wiki 编译', v: wiki.enabled === true ? '开启' : wiki.enabled === false ? '关闭' : '—' },
                { k: '召回条数 topK', v: typeof config.topK === 'number' ? String(config.topK) : '—' },
                { k: '覆盖度门槛', v: typeof config.coverageFloor === 'number' ? String(config.coverageFloor) : '—' },
                { k: '注入预算', v: typeof config.budgetChars === 'number' ? `${config.budgetChars} 字符` : '—' },
              ],
            })),
          h(ui.Diagnostic, { key: 'raw', title: '原始数据（summary）', hint: '已省略最近记忆预览，避免在诊断页露出正文。' },
            h(ui.Pre, { maxHeight: '320px', className: 'cpxp-ov-json' }, diagnosticJson())),
          h(ui.Diagnostic, { key: 'runtime-raw', title: '原始数据（companion.runtime）' },
            h(ui.Pre, { maxHeight: '220px' },
              runtime ? JSON.stringify(runtime, null, 2) : '（还没读到运行库状态）')),
          h(ui.Diagnostic, { key: 'paths', title: '文件与版本' },
            h(ui.KeyValue, {
              items: [
                { k: '后端', v: data ? text(data.backend) || '—' : '—', mono: true },
                { k: '版本', v: data ? text(data.version) || '—' : '—', mono: true },
                { k: '数据库文件', v: data ? text(data.database) || '（未返回）' : '—', mono: true, breakable: true },
                { k: '观测时间', v: data ? text(data.observedAt) || '—' : '—', mono: true },
              ],
            })),
        ],
      });
    };

    const pageStatus = data
      ? [
        h(ui.Timestamp, { key: 'at', at: data.observedAt, prefix: '数据时间 ' }),
        ` · 后端 ${text(data.backend) || '—'}`,
      ]
      : summary.error
        ? '读不到运行状态'
        : '正在读取运行状态…';

    const headProps = {
      title: '运行状态',
      lead: '只读；只有「维护」会写库。',
      actions: [
        h(ui.Button, {
          key: 'refresh',
          variant: 'ghost',
          onClick: refresh,
          disabled: locked && busy === 'rebuild',
          loading: Boolean(summary.loading && data) || Boolean(companion.loading && companionData),
        }, '刷新'),
      ],
      status: pageStatus,
    };

    // 状态栏独立于 summary：summary 挂了也要能看到是哪一项读不到。
    if (summary.error && !data) {
      return h(ui.Page, headProps, renderHealth(), h(ui.ErrorBox, { error: summary.error, onRetry: refresh }));
    }
    if (summary.loading && !data) {
      return h(ui.Page, headProps, renderHealth(), h(ui.Skeleton, { rows: 6 }));
    }
    if (!data) {
      return h(ui.Page, headProps, renderHealth(), h(ui.Empty, {
        title: '还没有可读的运行状态',
        hint: '接口没有返回 counts / jobs。',
        action: h(ui.Button, { variant: 'ghost', onClick: refresh }, '重新读取'),
      }));
    }

    return h(ui.Page, headProps,
      renderHealth(),
      summary.error
        ? h(ui.Callout, {
          key: 'stale',
          tone: 'warn',
          title: '这次刷新失败，下面是上一次读到的数字',
          action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: refresh }, '重试'),
        }, summary.error instanceof Error ? summary.error.message : String(summary.error))
        : null,
      Object.keys(jobs).length === 0
        ? h(ui.Callout, { key: 'jobs-missing', tone: 'warn', title: '没有读到作业表' })
        : null,
      renderStorage(),
      renderJobs(),
      renderMaintenance(),
      renderDiagnostics());
  }

  P.registerPage({ id: 'overview', label: '运行状态', order: 71, component: OverviewPage });
})(P);
