// 连接与工具：QQ 投递账本、媒体开关、记忆桥接与未接入项的只读视图。
// 数据只来自 GET companion（runtime / media / contact / sections.bridge）；
// 配置开关不等于服务健康，本页不探测、不发送、不代发任何消息。
(function (P) {
  const { h, ui, api, fmt } = P;

  const TITLE = '连接与工具';
  const LEAD = '只读配置与本地账本，不发送任何消息。';

  // 解释性文案只进 ⓘ（悬停或键盘聚焦才显示）：不看不会误解的地方不挂。
  const info = (text) => (ui.Info ? h(ui.Info, { key: 'info', text }) : null);

  P.css(`
    .cpxp-cx-note { margin:0; font-size:var(--cpx-fs-small); line-height:1.7; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; max-width:72ch; }
    .cpxp-cx-sep { color:var(--dsw-alias-label-secondary); opacity:.6; }
    .cpxp-cx-actions { display:flex; align-items:center; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; }
    .cpxp-cx-actions .cpxp-cx-note { flex:1 1 220px; min-width:0; }
  `);

  const OUTBOX_LABELS = {
    pending: '等待投递',
    queued: '排队中',
    sending: '投递中',
    sent: '已送出',
    delivered: '已送达',
    failed: '失败',
    retry: '等待重试',
    dead: '已放弃',
  };

  // 没有数据就没有数据：这些能力本面板确实拿不到，写清原因而不是留个空壳。
  const NOT_CONNECTED = [
    {
      title: 'B 站（视频、动态、收藏）',
      badge: '未接入',
      meta: '这个面板没有 B 站 的数据端点，运行库也没有把 B 站 连接交给它。',
    },
    {
      title: '实时语音通话',
      badge: '未接入',
      meta: '媒体配置里只有「语音表达」开关，没有通话通道，也没有对应端点。',
    },
    {
      title: '从面板直接发送 QQ 消息',
      badge: '未开放',
      meta: '本页只读投递账本；发不发、什么时候发由运行库自己决定，页面不代发。',
    },
    {
      title: '文件删除、重命名、跑命令',
      badge: '未开放',
      meta: '工作区页只有只读浏览；写操作请回到宿主自己的界面。',
    },
  ];

  // 运行库的 agenda / heartbeat / bridge 都是配置开关：只写「已配置」，不写「可用」。
  function configMark(value) {
    return value === true
      ? h(ui.StateLine, { state: 'ok', text: '已配置' })
      : h(ui.StateLine, { state: 'idle', text: '未配置' });
  }

  function outboxRows(outbox) {
    const counts = {};
    outbox.forEach((row) => {
      const status = String((row && row.status) || '未知');
      counts[status] = (counts[status] || 0) + 1;
    });
    return Object.keys(counts).map((status) => h(ui.Row, {
      key: `outbox-${status}`,
      title: `队列 · ${OUTBOX_LABELS[status] || status}`,
      meta: '一条待投递或已投递的记忆',
      side: `${fmt.number(counts[status])} 条`,
    }));
  }

  // ---------------------------------------------------------------------------
  // 华为运动健康（CN 云）来源卡
  //
  // 数据只走 GET /api/companion-health/{status,sources}；停用走
  // POST /api/companion-health/maintenance {action:'pause'}（二次确认后才发）。
  // 本轮**不做** Health Connect / Health Sync / Gadgetbridge 的按钮或入口：既然后端
  // 没有这些能力，界面上也不该出现长得像开关的东西。
  // ---------------------------------------------------------------------------
  const HEALTH_CAP_LABEL = {
    supported: '来源支持',
    no_data: '来源支持·暂无数据',
    unsupported: '来源不支持',
    auth_required: '需要重新授权',
    error: '读取失败',
  };
  const HEALTH_CAP_TONE = { supported: 'ok', no_data: 'idle', unsupported: 'idle', auth_required: 'warn', error: 'danger' };
  // 状态词在右侧状态列里已经写了，meta 写"这意味着什么"。
  const HEALTH_CAP_NOTE = {
    supported: '来源声明支持这项能力',
    no_data: '来源支持这项，但这些天没有数据',
    unsupported: '来源没有这项能力，界面上不会假装有',
    auth_required: '需要重新授权才能读到',
    error: '上一次读取失败了',
  };
  const HEALTH_CAP_ROWS = [
    { key: 'activity', label: '活动（步数、距离、千卡）' },
    { key: 'sport', label: '运动（训练记录）' },
    { key: 'heart_rate', label: '心率' },
    { key: 'stress', label: '压力' },
    { key: 'spo2', label: '血氧' },
    { key: 'device', label: '设备' },
  ];
  const HEALTH_AUTH_LABEL = { valid: '有效', expiring: '即将过期', expired: '已过期', unknown: '未知', required: '需要重新授权' };
  const HEALTH_AUTH_TONE = { valid: 'ok', expiring: 'warn', expired: 'danger', unknown: 'idle', required: 'warn' };
  const HEALTH_FRESH_LABEL = { fresh: '新鲜', delayed: '有延迟', stale: '已过期', no_data: '暂无数据', error: '读取失败', unknown: '时间未知' };
  const HEALTH_FRESH_TONE = { fresh: 'ok', delayed: 'warn', stale: 'danger', no_data: 'idle', error: 'danger', unknown: 'idle' };
  const HEALTH_STAGE_FIDELITY = {
    exact: '阶段完整',
    partial: '阶段部分缺失',
    not_reliable: '阶段不可信',
    unknown: '阶段未知',
  };

  function healthUrlOf(path) {
    try {
      return new URL(`api/companion-health/${path}`, document.baseURI).href;
    } catch {
      return `/api/companion-health/${path}`;
    }
  }

  // 照抄 core.js request() 的信封解包：同源 cookie 鉴权、no-store、不读也不传 token。
  function healthRequest(path, method, body) {
    const hasBody = body !== undefined;
    return fetch(healthUrlOf(path), {
      method: method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
    }).then(
      (response) => response.json().then(
        (payload) => {
          if (!payload || payload.ok !== true) {
            const error = (payload && payload.error) || {};
            throw new P.ApiError(error.message || `健康接口请求失败（HTTP ${response.status}）。`, response.status, error.code || 'unknown');
          }
          const data = payload.data;
          if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
            throw new P.ApiError(data.message || '健康服务没有给出原因。', response.status, data.code || 'unknown');
          }
          return data;
        },
        () => { throw new P.ApiError(`健康接口返回不是 JSON（HTTP ${response.status}）。`, response.status, 'bad-response'); },
      ),
      () => { throw new P.ApiError('无法连接宿主（桌面可能已关闭）。', 0, 'network'); },
    );
  }

  const healthSettle = (promise) => promise.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );

  const healthIsUnavailable = (error) => Boolean(error) && (
    String(error.code || '') === 'health-unavailable'
    || String(error.code || '') === 'health-db-unavailable'
    || Number(error.status) === 404
  );

  function HealthSourceBand() {
    const state = P.useApi(() => Promise.all([
      healthSettle(healthRequest('status')),
      healthSettle(healthRequest('sources')),
    ]).then(([status, sources]) => ({ status, sources })), []);
    const [busy, setBusy] = P.useState(null);
    const [failure, setFailure] = P.useState(null);

    const bundle = state.data || null;
    const status = bundle && bundle.status ? bundle.status.value : null;
    const sources = bundle && bundle.sources ? bundle.sources.value : null;
    const unavailable = Boolean(bundle)
      && healthIsUnavailable(bundle.status.error)
      && healthIsUnavailable(bundle.sources.error);

    const action = (verb, label, question) => {
      if (busy) return;
      if (!P.confirm(question)) return;
      setFailure(null);
      setBusy(verb);
      healthRequest('maintenance', 'POST', { action: verb }).then(() => {
        if (typeof P.notice === 'function') P.notice(label, 'ok');
        state.reload();
      }).catch((error) => {
        const message = P.failText(error, '维护请求没有完成。');
        setFailure({ label, message });
        if (typeof P.notice === 'function') P.notice(`${label}失败 — ${message}`, 'danger');
      }).then(() => setBusy(null), () => setBusy(null));
    };

    const header = {
      key: 'health-source',
      title: '华为运动健康（CN 云）',
      actions: [info('能力状态、鉴权、新鲜度都来自健康服务；停用会让采集器真的停止向云端拉数据。'
        + '本轮不提供 Health Connect / Health Sync / Gadgetbridge 的接入入口：这些能力后端没有实现。')],
    };

    if (state.loading && !bundle) {
      return h(ui.Band, header, h(ui.Skeleton, { rows: 3 }));
    }
    if (unavailable) {
      return h(ui.Band, header, h(ui.List, { label: '华为运动健康来源' },
        h(ui.Row, {
          title: '华为运动健康（CN 云）',
          meta: '这套组合没有挂健康能力',
          status: h(ui.StateLine, { state: 'idle', text: '未接入' }),
        })));
    }
    if (!status && !sources) {
      return h(ui.Band, header, h(ui.Callout, {
        tone: state.error ? 'danger' : 'warn',
        title: '读不到华为运动健康的来源状态',
      }, h('span', null, P.failText(bundle ? bundle.status.error || bundle.sources.error : state.error, '健康服务没有返回数据。'))));
    }

    const sourceInfo = status && status.source ? status.source : null;
    const auth = sourceInfo && sourceInfo.auth ? sourceInfo.auth : null;
    const freshness = sourceInfo && sourceInfo.freshness ? sourceInfo.freshness : null;
    const collector = status && status.collector ? status.collector : null;
    const list = Array.isArray(sources) ? sources : [];
    const source = list.length ? list[0] : null;
    const capabilities = source && source.capabilities ? source.capabilities : null;
    const sleepCap = capabilities && capabilities.sleep && typeof capabilities.sleep === 'object' ? capabilities.sleep : null;
    const enabled = source ? source.enabled : (sourceInfo ? sourceInfo.enabled : null);

    const rows = [];

    if (capabilities) {
      HEALTH_CAP_ROWS.forEach((row) => {
        const value = capabilities[row.key];
        rows.push(h(ui.Row, {
          key: `hcap-${row.key}`,
          title: row.label,
          meta: value ? (HEALTH_CAP_NOTE[value] || String(value)) : '来源没有声明这项能力',
          status: h(ui.StateLine, {
            state: value ? (HEALTH_CAP_TONE[value] || 'idle') : 'idle',
            text: value ? (HEALTH_CAP_LABEL[value] || String(value)) : '未声明',
          }),
        }));
      });
      rows.push(h(ui.Row, {
        key: 'hcap-sleep',
        title: '睡眠',
        meta: sleepCap
          ? `阶段保真度：${HEALTH_STAGE_FIDELITY[sleepCap.stageFidelity] || sleepCap.stageFidelity || '—'}`
          : '来源没有声明睡眠能力',
        status: h(ui.StateLine, {
          state: sleepCap ? (sleepCap.supported ? 'ok' : 'idle') : 'idle',
          text: sleepCap ? (HEALTH_CAP_LABEL[sleepCap.status] || String(sleepCap.status || '未声明')) : '未声明',
        }),
      }));
    } else {
      rows.push(h(ui.Row, {
        key: 'hcap-missing',
        title: '能力状态',
        meta: '没有读到能力清单',
        status: h(ui.StateLine, { state: 'idle', text: '未知' }),
      }));
    }

    rows.push(h(ui.Row, {
      key: 'hauth',
      title: '鉴权状态',
      meta: auth
        ? (auth.minutesLeft === null || auth.minutesLeft === undefined
          ? '来源没有给出剩余时间'
          : `剩余约 ${Math.max(0, Math.round(auth.minutesLeft))} 分钟`)
        : '来源没有给出鉴权信息',
      status: h(ui.StateLine, {
        state: auth ? (HEALTH_AUTH_TONE[auth.status] || 'idle') : 'idle',
        text: auth ? (HEALTH_AUTH_LABEL[auth.status] || String(auth.status)) : '未知',
      }),
    }));

    rows.push(h(ui.Row, {
      key: 'hfresh',
      title: '来源新鲜度',
      meta: freshness && freshness.ageMinutes !== null && freshness.ageMinutes !== undefined
        ? `最新样本约 ${Math.max(0, Math.round(freshness.ageMinutes))} 分钟前`
        : '来源没有给出最新样本时间',
      status: h(ui.StateLine, {
        state: freshness ? (HEALTH_FRESH_TONE[freshness.status] || 'idle') : 'idle',
        text: freshness ? (HEALTH_FRESH_LABEL[freshness.status] || String(freshness.status)) : '未知',
      }),
    }));

    rows.push(h(ui.Row, {
      key: 'hsync',
      title: '最近同步',
      meta: collector && collector.lastRunAt
        ? `采集器上一轮 ${P.fmt.dateTime(collector.lastRunAt)}`
        : '采集器还没跑过',
      side: sourceInfo && sourceInfo.lastSuccessAt
        ? h(ui.Timestamp, { at: sourceInfo.lastSuccessAt })
        : '还没成功过',
    }));

    if (sourceInfo && sourceInfo.lastErrorCode) {
      rows.push(h(ui.Row, {
        key: 'herror',
        title: '最近错误',
        meta: '最近一次失败的机器码',
        status: h(ui.StateLine, { state: 'warn', text: String(sourceInfo.lastErrorCode) }),
      }));
    }

    return h(ui.Band, header, [
      state.error
        ? h(ui.Callout, {
          key: 'herrfresh',
          tone: 'warn',
          title: '这次刷新没有成功',
        }, h('span', null, `${P.failText(state.error, '健康接口没有返回新数据。')}下面仍是上一次读到的内容。`))
        : null,
      failure
        ? h(ui.Callout, {
          key: 'hfails',
          tone: 'danger',
          title: `${failure.label}没有成功`,
        }, h('span', null, failure.message))
        : null,
      h(ui.List, { key: 'hlist', label: '华为运动健康（CN 云）来源状态' }, rows),
      h('div', { key: 'hact', className: 'cpxp-cx-actions' },
        h(ui.Button, {
          variant: 'ghost',
          size: 'sm',
          onClick: () => action('pause', '已停用华为运动健康（CN 云）来源',
            '确定停用华为运动健康（CN 云）来源吗？\n\n停用后本地采集器不再向云端拉取新数据；已经入库的历史数据保留，不会删除。'),
          loading: busy === 'pause',
          disabled: Boolean(busy) || enabled === false,
          title: enabled === false ? '这个来源已经是停用状态' : '让采集器停止向云端拉取数据',
        }, '停用来源'),
        enabled === false
          ? h(ui.Button, {
            key: 'resume',
            variant: 'ghost',
            size: 'sm',
            onClick: () => action('resume', '已恢复华为运动健康（CN 云）来源',
              '确定恢复华为运动健康（CN 云）来源吗？\n\n恢复后采集器会重新按节奏向云端拉取数据。'),
            loading: busy === 'resume',
            disabled: Boolean(busy),
          }, '恢复来源')
          : null,
        enabled === null || enabled === undefined
          ? h('span', { key: 'hen', className: 'cpxp-cx-note' }, '启用状态未知')
          : null),
      h(ui.Diagnostic, { key: 'hdiag', title: '高级诊断', hint: 'status / sources 原始字段。' },
        h(ui.KeyValue, {
          items: [
            { k: 'source.id', v: source ? source.id : (sourceInfo ? sourceInfo.id : '—'), mono: true },
            { k: 'source.provider', v: source ? source.provider : '—', mono: true },
            { k: 'source.enabled', v: String(enabled), mono: true },
            { k: 'auth.expiresAt', v: auth && auth.expiresAt ? auth.expiresAt : '—', mono: true },
            { k: 'collector.baseUrl', v: collector && collector.baseUrl ? collector.baseUrl : '—', mono: true },
            { k: 'collector.cooldownUntil', v: collector && collector.cooldownUntil ? collector.cooldownUntil : '—', mono: true },
          ],
        }))]);
  }

  function ConnectionsPage() {
    const state = P.useApi(() => api.get('companion'), []);
    const data = state.data;

    const refresh = h(ui.Button, {
      key: 'refresh',
      variant: 'primary',
      onClick: state.reload,
      loading: state.loading,
      title: '重新读取运行库配置与本地投递账本',
    }, h(ui.Icon, { name: 'refresh', size: 15 }), '刷新');

    if (!data) {
      return h(ui.Page, { title: TITLE, lead: LEAD, actions: [refresh] },
        state.error
          ? h(ui.Callout, {
            tone: 'danger',
            title: '读不到运行库数据',
            children: P.failText(state.error, '接口没有返回可用数据。'),
            action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: state.reload }, '重试'),
          })
          : h(ui.Skeleton, { rows: 5 }),
        // 运行库读不到时，健康来源卡仍然照常渲染：两条链路互不依赖。
        h(HealthSourceBand, { key: 'health-early' }));
    }

    const runtime = data.runtime && typeof data.runtime === 'object' ? data.runtime : {};
    const media = data.media && typeof data.media === 'object' ? data.media : null;
    const contact = data.contact && typeof data.contact === 'object' ? data.contact : null;
    const sections = data.sections && typeof data.sections === 'object' ? data.sections : {};
    const unavailable = Array.isArray(data.unavailable) ? data.unavailable : [];
    const outbox = Array.isArray(sections.bridge) ? sections.bridge : [];
    const bridgeUnreadable = unavailable.indexOf('bridge') >= 0;
    const namespaces = [];
    outbox.forEach((row) => {
      const namespace = row && row.namespace;
      if (typeof namespace === 'string' && namespace && namespaces.indexOf(namespace) < 0) namespaces.push(namespace);
    });

    const status = [
      h(ui.Timestamp, { key: 'at', at: data.observedAt, prefix: '数据时间' }),
      h('span', { key: 'sep1', className: 'cpxp-cx-sep' }, '·'),
      h(ui.StateLine, {
        key: 'db',
        state: runtime.available === true ? 'ok' : 'warn',
        text: runtime.available === true ? '运行库数据库可读' : '运行库数据库未就绪',
      }),
    ];

    return h(ui.Page, { title: TITLE, lead: LEAD, status, actions: [refresh] },
      state.error
        ? h(ui.Callout, {
          key: 'stale',
          tone: 'warn',
          title: '这次刷新没有成功',
          children: `${P.failText(state.error, '接口没有返回新数据。')}下面仍是上一次读到的内容。`,
          action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: state.reload }, '重试'),
        })
        : null,

      h(ui.Band, {
        key: 'runtime',
        flush: true,
        title: '运行库',
        actions: [info('这几项都是配置开关：只说明运行库被要求做什么，不代表它此刻在跑或跑成功。')],
      }, h(ui.List, { label: '运行库配置开关' },
        h(ui.Row, {
          title: '数据库读取',
          meta: '读不到库时下面大多是空的',
          status: h(ui.StateLine, {
            state: runtime.available === true ? 'ok' : 'warn',
            text: runtime.available === true ? '可读' : '不可读',
          }),
        }),
        h(ui.Row, {
          title: '运行库总开关',
          meta: '不代表进程在运行',
          status: configMark(runtime.enabled),
        }),
        h(ui.Row, {
          title: '日程规则',
          meta: '关掉后不会自己排日程',
          status: configMark(runtime.agenda),
        }),
        h(ui.Row, {
          title: '心跳规则',
          meta: '关掉后不会自己醒来',
          status: configMark(runtime.heartbeat),
        }))),

      h(HealthSourceBand, { key: 'health' }),

      h(ui.Row, {
        key: 'media',
        title: '媒体能力',
        meta: '独立的侧栏页面：配置生图与语音合成（识图只保留合同）',
        status: h(ui.StateLine, { state: 'info', text: '见左侧「媒体能力」' }),
      }),

      // 媒体能力已迁到侧栏独立页（pages-media.js 的 MediaPage）。这里只留指向说明，
      // 避免同一份表单在两处渲染、两条数据流各自漂移。


      h(ui.Band, {
        key: 'bridge',
        title: '记忆桥接',
        hint: '队列计数，不是投递成绩',
        actions: [info('这是队列，不是投递成绩：条目只是排在那里，「已送出」也只表示它离开了队列；没有回执就不算送达。')],
      }, h(ui.List, { label: '记忆桥接队列' },
        h(ui.Row, {
          title: '桥接开关',
          meta: '配置开关，不等于投递成功',
          status: configMark(runtime.bridge),
        }),
        bridgeUnreadable
          ? h(ui.Row, {
            title: '桥接队列',
            meta: '这次没有读到这张表，计数未知',
            status: h(ui.StateLine, { state: 'warn', text: '读取失败' }),
          })
          : outbox.length
            ? outboxRows(outbox)
            : h(ui.Row, {
              title: '桥接队列',
              meta: '没有待投递或已投递的记录',
              status: h(ui.StateLine, { state: 'idle', text: '队列为空' }),
            }),
        namespaces.length
          ? h(ui.Row, {
            title: '已出现的命名空间',
            meta: namespaces.join('、'),
            side: `${namespaces.length} 个`,
          })
          : null)),

      h(ui.Band, {
        key: 'missing',
        title: '未接入项',
        actions: [info('这些能力面板里没有数据来源，按钮也不会假装存在；没接通就直接写没接通。')],
      }, h(ui.List, { label: '未接入与未开放的能力' }, NOT_CONNECTED.map((item) => h(ui.Row, {
        key: `missing-${item.title}`,
        title: item.title,
        meta: item.meta,
        status: h(ui.Badge, { tone: 'neutral' }, item.badge),
      })))),

      h(ui.Diagnostic, {
        key: 'diag',
        title: '高级诊断',
        hint: '运行库字段原文，只用于排查',
      },
      h(ui.KeyValue, {
        items: [
          { k: 'runtime.mode', v: runtime.mode || '—', mono: true },
          {
            k: 'runtime.pollIntervalMs',
            v: runtime.pollIntervalMs === null || runtime.pollIntervalMs === undefined ? '—' : String(runtime.pollIntervalMs),
            mono: true,
          },
          { k: 'sections.unavailable', v: unavailable.length ? unavailable.join('、') : '无', mono: true, breakable: true },
        ],
      }),
      h(ui.Pre, { maxHeight: 260 }, JSON.stringify({
        runtime, media, contact, unavailable,
      }, null, 2))));
  }

  P.registerPage({ id: 'connections', label: TITLE, order: 62, component: ConnectionsPage });
})(P);
