// 记忆库页面片段（page id: vault）。纯脚本 IIFE：不使用 import / export / require / JSX。
//
// 端点（参数名以 lib/read.mjs、lib/write.mjs 为准）：
//   GET  memories   query / status / kind / scope / sort / limit / offset -> { items, total, offset, limit, query }
//   GET  memory     id + reveal=1（新宿主直接给全文并忽略 reveal；旧宿主靠 reveal=1 才给全文）
//   POST memory     { id, action: revise | policy | archive | restore | delete, value?, policy?, reason }
//
// 管理界面不做隐藏：列表直接显示正文摘要，抽屉直接给正文全文与证据摘录。
// 只有「旧宿主把 preview 置空」这一种情况才补一次 reveal=1（当前页可见行、并发 4、每条最多一次）。
//
// 结构（契约 design/ui-redesign-20261030-shell-contract.md §2 / §5）：
//   页头（标题 / 一句说明 / 状态行 / 唯一主操作=刷新）
//   > 筛选 Band（Search + 状态/类型/来源 + 排序/每页，改动即查询）
//   > 记忆列表 Band（List + Row，一条一行，点击开详情抽屉）
//   > 详情 Sheet（正文全文、来源与证据链、修订注记、标签与关联、纠正与治理、高级诊断）
(function (P) {
  'use strict';

  const { h, useState, useEffect, useMemo, useRef, useApi, ui, api, fmt } = P;

  P.css(`
.cpxp-vault-stack { display: flex; flex-direction: column; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-vault-inline { display: inline-flex; align-items: center; gap: var(--cpx-s2, 8px); flex-wrap: wrap; min-width: 0; }
.cpxp-vault-between { display: flex; align-items: center; justify-content: space-between; gap: var(--cpx-s2, 8px); flex-wrap: wrap; min-width: 0; }
.cpxp-vault-fill { flex: 1 1 auto; }
.cpxp-vault-pick { flex: 0 0 120px; min-width: 0; }
.cpxp-vault-pick-wide { flex: 0 0 132px; min-width: 0; }
.cpxp-vault-tag {
  margin-left: 8px; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; letter-spacing: .02em;
  color: var(--dsw-alias-label-secondary);
}
.cpxp-vault-muted { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.7; overflow-wrap: anywhere; word-break: break-word; }
.cpxp-vault-rowtext {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
  overflow: hidden; overflow-wrap: anywhere; word-break: break-word;
  color: var(--dsw-alias-label-secondary);
}
.cpxp-vault-body { margin: 0; color: var(--dsw-alias-label-primary); font-size: var(--cpx-fs-body, 14.5px); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.cpxp-vault-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.6; overflow-wrap: anywhere; word-break: break-all; }
.cpxp-vault-pager { display: flex; align-items: center; gap: var(--cpx-s2, 8px); flex-wrap: wrap; min-width: 0; }
@media (max-width: 760px) {
  /* 窄屏允许换行，但顺序不变：搜索框先占满一行，三个筛选两两一排。 */
  .cpxp-vault-pick, .cpxp-vault-pick-wide { flex: 1 1 46%; }
}
`);

  // --- 词表 -----------------------------------------------------------------

  const SCOPES = [
    { value: 'all', label: '全部来源' },
    { value: 'user_global', label: '用户事实' },
    { value: 'user_persona', label: '共同关系' },
    { value: 'persona_self', label: '角色自我' },
    { value: 'roleplay_world', label: '剧情世界' },
    { value: 'session_recent', label: '近期状态' },
  ];
  const SCOPES_LABEL = {
    user_global: '用户事实', user_persona: '共同关系', persona_self: '角色自我',
    roleplay_world: '剧情世界', session_recent: '近期状态',
  };
  const KINDS = [
    { value: 'all', label: '全部类型' },
    { value: 'fact', label: '事实' }, { value: 'preference', label: '偏好' },
    { value: 'profile', label: '画像' }, { value: 'event', label: '事件' },
    { value: 'commitment', label: '承诺' }, { value: 'relationship', label: '关系' },
    { value: 'summary', label: '摘要' }, { value: 'bot_action', label: '角色行为' },
    { value: 'artifact', label: '产物' }, { value: 'note', label: '备注' },
  ];
  const KINDS_LABEL = {
    fact: '事实', preference: '偏好', profile: '画像', event: '事件', commitment: '承诺',
    relationship: '关系', summary: '摘要', bot_action: '角色行为', artifact: '产物', note: '备注',
  };
  const STATUSES = [
    { value: 'all', label: '全部状态' },
    { value: 'confirmed', label: '已确认' }, { value: 'pending', label: '待确认' },
    { value: 'superseded', label: '已取代' }, { value: 'archived', label: '已归档' },
    { value: 'retracted', label: '已遗忘' },
  ];
  const STATUSES_LABEL = {
    confirmed: '已确认', pending: '待确认', superseded: '已取代', archived: '已归档', retracted: '已遗忘',
  };
  const POLICIES = [
    { value: 'direct', label: '可直接提及' },
    { value: 'soft_echo', label: '轻度呼应' },
    { value: 'tone_only', label: '只影响语气' },
    { value: 'avoid_unless_asked', label: '不主动提及' },
  ];
  const POLICIES_LABEL = {
    direct: '可直接提及', soft_echo: '轻度呼应', tone_only: '只影响语气', avoid_unless_asked: '不主动提及',
  };
  const SORTS = [
    { id: 'recent', label: '最近更新' },
    { id: 'importance', label: '重要性' },
    { id: 'confidence', label: '可信度' },
  ];
  const PAGE_SIZES = [
    { value: '25', label: '每页 25 条' },
    { value: '50', label: '每页 50 条' },
    { value: '100', label: '每页 100 条' },
  ];
  // sourceKind 的枚举来自 plugins/companion-memory/lib/policy.mjs 的 SOURCE_KINDS；
  // 列表项目前不返回这个字段，所以「来源」一段是有才显示、没有就省略（不猜）。
  const SOURCE_LABEL = {
    desktop_conversation: '桌面对话',
    desktop_fact: '桌面事实',
    astrbot_import: '旧库导入',
    extracted: '对话提炼',
    manual: '手动写入',
    system: '系统写入',
  };
  const REALITY_LABEL = {
    explicit_user_statement: '用户明确说过',
    user_utterance_not_verified_fact: '聊天原话（未核实）',
    imported_fact: '旧库确认事实',
    imported_summary: '旧库摘要（可能有误）',
    bot_action: '角色自身行为',
    roleplay_fiction: '剧情设定',
    inferred: '推断',
  };
  const ROLE_LABEL = {
    user: '用户原话', assistant: '角色回复', system: '系统提示', tool: '工具输出',
  };
  const OPERATION_LABEL = {
    revise: '修订正文', policy: '调整表达策略', archive: '归档', restore: '恢复',
    delete: '标记遗忘', supersede: '新版本取代旧版本', create: '创建', insert: '创建', update: '更新',
  };
  // POST memory 的 reason 只接受白名单动作码（lib/write.mjs 的 normalizeReason），
  // 所以每个动作带它自己的码，而不是自由文本。
  const REASON_BY_ACTION = {
    revise: 'studio-revise', policy: 'studio-policy', archive: 'studio-archive',
    restore: 'studio-restore', delete: 'studio-delete',
  };
  const ACTION_TEXT = {
    revise: '正文已修订', policy: '表达策略已更新', archive: '记忆已归档',
    restore: '记忆已恢复', delete: '记忆已标记遗忘',
  };

  // --- 小工具 ---------------------------------------------------------------

  function pickValue(input) {
    // Select / Search / Segmented / TextArea 可能回传值，也可能回传 DOM 事件。
    if (input && typeof input === 'object' && input.target && input.target.value !== undefined) {
      return input.target.value;
    }
    return input;
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function asList(value) {
    return Array.isArray(value) ? value : [];
  }

  function clip(value, max) {
    const source = text(value).replace(/\s+/g, ' ').trim();
    if (source.length <= max) return source;
    return source.slice(0, Math.max(0, max - 1)) + '…';
  }

  function shortId(value) {
    const source = text(value);
    if (!source) return '';
    return source.length > 14 ? source.slice(0, 7) + '…' + source.slice(-3) : source;
  }

  /**
   * 列表行的稳定短编号：取记忆 id 末尾 4 位（短 id 整段）。
   * 它只是 id 的可见片段，不含任何正文，跨页、跨筛选都稳定，用来和抽屉标题对照。
   */
  function shortTag(value) {
    const source = text(value);
    if (!source) return '';
    return '#' + (source.length > 4 ? source.slice(-4) : source);
  }

  /** 来源标签：sourceKind 有就翻成人话，没这个字段就返回空串（绝不编一个）。 */
  function sourceText(item) {
    const raw = text(item && (item.sourceKind || item.source || item.source_kind));
    if (!raw) return '';
    return SOURCE_LABEL[raw] || raw;
  }

  function errorText(error) {
    if (!error) return '未知原因';
    if (typeof error === 'string') return error;
    if (error.message) return text(error.message);
    return '请求失败，没有拿到可读原因。';
  }

  function scopeTone(scope) {
    if (scope === 'user_global') return 'ok';
    if (scope === 'user_persona') return 'brand';
    if (scope === 'roleplay_world') return 'warn';
    return 'neutral';
  }

  function statusTone(status) {
    if (status === 'confirmed') return 'ok';
    if (status === 'pending') return 'warn';
    if (status === 'retracted') return 'danger';
    return 'neutral';
  }

  function policyTone(policy) {
    if (policy === 'avoid_unless_asked') return 'danger';
    if (policy === 'tone_only') return 'warn';
    if (policy === 'soft_echo') return 'brand';
    return 'neutral';
  }

  // --- 页面 -----------------------------------------------------------------

  function VaultPage() {
    const toast = typeof P.useToast === 'function' ? P.useToast() : null;
    const push = toast && typeof toast.push === 'function'
      ? function (message, tone) { toast.push(message, tone || 'neutral'); }
      : function () {};

    const [draft, setDraft] = useState('');
    const [query, setQuery] = useState('');
    // 默认只看「已确认」：批量遗忘会刷新 updated_at，默认「全部状态」时首屏会整屏都是已遗忘。
    const [status, setStatus] = useState('confirmed');
    const [kind, setKind] = useState('all');
    const [scope, setScope] = useState('all');
    const [sort, setSort] = useState('recent');
    const [limit, setLimit] = useState(25);
    const [offset, setOffset] = useState(0);
    const [loadedAt, setLoadedAt] = useState('');

    const [selectedId, setSelectedId] = useState('');
    const [editOpen, setEditOpen] = useState(false);
    const [editValue, setEditValue] = useState('');
    const [policyDraft, setPolicyDraft] = useState('direct');
    const [pending, setPending] = useState('');
    const [busy, setBusy] = useState('');
    const [formError, setFormError] = useState('');
    const [flash, setFlash] = useState(null);
    // 旧宿主兼容：列表里 preview 为空的行走一次 reveal=1 补摘要（每条最多补一次）。
    const [fills, setFills] = useState({});
    const attemptedRef = useRef({});

    const params = useMemo(function () {
      const next = { limit: limit, offset: offset, sort: sort };
      if (query) next.query = query;
      if (status !== 'all') next.status = status;
      if (kind !== 'all') next.kind = kind;
      if (scope !== 'all') next.scope = scope;
      return next;
    }, [query, status, kind, scope, sort, limit, offset]);

    const list = useApi(function () {
      return api.get('memories', params);
    }, [params]);

    // 详情一律带 reveal=1：新宿主忽略它（正文本来就返回），旧宿主靠它才给全文。
    const detail = useApi(function () {
      if (!selectedId) return null;
      return api.get('memory', { id: selectedId, reveal: 1 });
    }, [selectedId]);

    const data = list.data && typeof list.data === 'object' ? list.data : null;
    const items = data ? asList(data.items) : [];
    const total = data && Number.isFinite(Number(data.total)) ? Number(data.total) : 0;
    const record = detail.data && detail.data.id ? detail.data : null;
    const hasFilters = Boolean(query) || status !== 'confirmed' || kind !== 'all' || scope !== 'all';

    // 数据时间取「本次成功读取的时刻」：memories 的响应体里没有 observedAt，
    // 所以只报这一页数据是什么时候从后端读到的，不假装是库里的时间。
    useEffect(function () {
      if (list.loading || !list.data) return;
      setLoadedAt(new Date().toISOString());
    }, [list.data, list.loading]);

    // 搜索框自带 320ms 防抖：改动即查询，不需要「搜索」按钮。
    useEffect(function () {
      if (draft === query) return undefined;
      const timer = setTimeout(function () {
        setQuery(draft);
        setOffset(0);
      }, 320);
      return function () { clearTimeout(timer); };
    }, [draft, query]);

    // 换一条记忆就清空抽屉里的临时状态，避免把上一条的输入带过去。
    useEffect(function () {
      setEditOpen(false);
      setEditValue('');
      setPending('');
      setFormError('');
      setFlash(null);
      setPolicyDraft('direct');
    }, [selectedId]);

    // 旧宿主兼容：GET memories 对「不主动提及」的行会把 preview 置空。这类行（当前页可见的）
    // 用 GET memory?id&reveal=1 补一次摘要，并发上限 4；每条最多补一次，失败的 id 记在内存里不再重试。
    // 新宿主直接返回正文、hidden 恒 false，所以这段在新宿主上不会发出任何额外请求。
    useEffect(function () {
      const rows = data ? asList(data.items) : [];
      const targets = [];
      rows.forEach(function (item) {
        const id = text(item && item.id);
        if (!id || attemptedRef.current[id]) return;
        if (text(item && item.preview) && !item.hidden) return;
        attemptedRef.current[id] = true;
        targets.push(id);
      });
      if (!targets.length) return undefined;

      setFills(function (previous) {
        const next = Object.assign({}, previous);
        targets.forEach(function (id) { next[id] = { status: 'loading' }; });
        return next;
      });

      let cancelled = false;
      let cursor = 0;
      const settle = function (id, patch) {
        if (cancelled) return;
        setFills(function (previous) {
          const next = Object.assign({}, previous);
          next[id] = patch;
          return next;
        });
      };
      const worker = function () {
        if (cancelled || cursor >= targets.length) return Promise.resolve();
        const id = targets[cursor];
        cursor += 1;
        return api.get('memory', { id: id, reveal: 1 }).then(function (record) {
          settle(id, { status: 'ok', value: text(record && record.value) });
          return null;
        }, function (error) {
          settle(id, { status: 'error', error: errorText(error) });
          return null;
        }).then(worker);
      };
      const workers = [];
      for (let index = 0; index < 4; index += 1) workers.push(worker());
      return function () {
        cancelled = true;
        workers.length = 0;
      };
    }, [data]);

    // 详情到达后把编辑器与策略下拉对齐到真实值。
    useEffect(function () {
      if (!record) return;
      setEditValue(text(record.value));
      setPolicyDraft(record.policy || 'direct');
    }, [record]);

    function filterChange(setter) {
      return function (input) {
        setter(pickValue(input));
        setOffset(0);
      };
    }

    function clearFilters() {
      setDraft('');
      setQuery('');
      setStatus('confirmed');
      setKind('all');
      setScope('all');
      setSort('recent');
      setLimit(25);
      setOffset(0);
    }

    function refresh() {
      if (typeof list.reload === 'function') list.reload();
      if (selectedId && typeof detail.reload === 'function') detail.reload();
    }

    function goSettings() {
      if (P.nav && typeof P.nav.go === 'function') P.nav.go('settings');
    }

    async function runAction(action, extra) {
      if (!record) return;
      setBusy(action);
      setFormError('');
      try {
        const body = Object.assign({
          id: record.id,
          action: action,
          reason: REASON_BY_ACTION[action] || 'studio-ui',
        }, extra || {});
        const result = await api.post('memory', body);
        const suffix = result && result.revision ? '（v' + result.revision + '）' : '';
        const message = (ACTION_TEXT[action] || '操作已完成') + suffix;
        push(message, 'ok');
        setFlash({ tone: 'ok', text: message });
        setPending('');
        if (action === 'revise') setEditOpen(false);
        // 刷新列表并保持在原来那条上：selectedId 不变，列表回来后它仍是选中行。
        if (typeof detail.reload === 'function') detail.reload();
        if (typeof list.reload === 'function') list.reload();
      } catch (error) {
        const message = (ACTION_TEXT[action] || '操作') + '失败：' + errorText(error);
        setFormError(message);
        setFlash({ tone: 'danger', text: message });
        push(message, 'danger');
      } finally {
        setBusy('');
      }
    }

    function saveRevision() {
      const value = text(editValue).trim();
      if (!value) {
        setFormError('正文不能为空，未提交修订。');
        return;
      }
      if (record && value === text(record.value).trim()) {
        setFormError('正文没有变化，未提交修订。');
        return;
      }
      runAction('revise', { value: value });
    }

    // --- 列表 ---------------------------------------------------------------

    // 列表是「索引 + 正文摘要」：标题给类型 · 作用域 + 稳定短编号（#abcd，id 末 4 位），
    // 副标题直接是真实 preview（CSS 截 2 行），右侧是状态 Badge 与更新时间。
    // 管理界面不做隐藏：正文在这里本来就该看得见，才能审计和批改。
    function renderRow(item) {
      const id = text(item && item.id);
      const tag = shortTag(id);
      const kindLabel = KINDS_LABEL[item && item.kind] || text(item && item.kind) || '未知类型';
      const scopeLabel = SCOPES_LABEL[item && item.scope] || text(item && item.scope) || '未知来源';
      const statusLabel = STATUSES_LABEL[item && item.status] || text(item && item.status) || '未知状态';
      const preview = text(item && item.preview);
      // 旧宿主：preview 为空（或不主动提及）时用补来的全文摘要；补不到就给可读原因。
      const needsFill = !preview || Boolean(item && item.hidden);
      const fill = needsFill ? fills[id] : null;
      let summary = preview;
      if (needsFill) {
        if (fill && fill.status === 'ok') summary = text(fill.value);
        else if (fill && fill.status === 'error') summary = '这条读不出来：' + fill.error;
        else summary = '载入中…';
      }

      const title = h('span', { className: 'cpxp-vault-inline' }, [
        h('span', { key: 'head' }, kindLabel + ' · ' + scopeLabel),
        tag ? h('span', { key: 'tag', className: 'cpxp-vault-tag' }, tag) : null,
      ]);

      const meta = h('span', { className: 'cpxp-vault-rowtext' }, summary || '（这条记忆没有预览文本）');

      const ariaLabel = '记忆 ' + (tag || '（无编号）') + '：' + kindLabel + '；作用域 ' + scopeLabel
        + '；状态 ' + statusLabel + '；更新于 ' + fmt.relative(item && item.updatedAt)
        + '；正文 ' + clip(summary, 60);

      return h(ui.Row, {
        key: id,
        title: title,
        meta: meta,
        status: h(ui.Badge, { tone: statusTone(item && item.status) }, statusLabel),
        side: h(ui.Timestamp, { at: item && item.updatedAt }),
        selected: Boolean(id) && id === selectedId,
        onClick: function () { setSelectedId(id); },
        ariaLabel: ariaLabel,
      });
    }

    const pageStart = total === 0 ? 0 : offset + 1;
    const pageEnd = offset + items.length;
    const canPrev = offset > 0;
    const canNext = offset + limit < total;

    function renderList() {
      if (list.error) {
        return h(ui.ErrorBox, { key: 'error', error: list.error, onRetry: refresh });
      }
      if (!data) return h(ui.Skeleton, { key: 'loading', rows: 6 });
      if (!items.length) {
        if (hasFilters) {
          return h(ui.Empty, {
            key: 'no-match',
            title: '没有符合条件的记忆',
            hint: '换个关键词，或清除筛选。',
            action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: clearFilters }, '清除筛选'),
          });
        }
        return h(ui.Empty, {
          key: 'empty',
          title: '记忆库没有已确认的记忆',
          hint: '可以切到全部状态看看。',
          action: h('span', { className: 'cpxp-vault-inline' }, [
            h(ui.Button, {
              key: 'all', variant: 'ghost', size: 'sm',
              onClick: function () { setStatus('all'); setOffset(0); },
            }, '查看全部状态'),
            h(ui.Button, { key: 'settings', variant: 'ghost', size: 'sm', onClick: goSettings }, '去设置看看'),
          ]),
        });
      }
      return h('div', { className: 'cpxp-vault-stack', key: 'list' }, [
        h(ui.List, { key: 'rows', label: '记忆列表' }, items.map(renderRow)),
        h('div', { key: 'pager', className: 'cpxp-vault-pager' }, [
          h('span', { key: 'info', className: 'cpxp-vault-muted' },
            '第 ' + pageStart + '–' + pageEnd + ' 条 / 共 ' + total + ' 条'),
          h('span', { key: 'fill', className: 'cpxp-vault-fill' }),
          h(ui.Select, {
            key: 'limit',
            value: String(limit),
            options: PAGE_SIZES,
            width: 132,
            onChange: function (input) {
              const next = Number(pickValue(input));
              setLimit(Number.isFinite(next) && next > 0 ? next : 25);
              setOffset(0);
            },
          }),
          h(ui.Button, {
            key: 'prev', variant: 'ghost', size: 'sm',
            disabled: !canPrev || list.loading,
            onClick: function () { setOffset(Math.max(0, offset - limit)); },
          }, '上一页'),
          h(ui.Button, {
            key: 'next', variant: 'ghost', size: 'sm',
            disabled: !canNext || list.loading,
            onClick: function () { setOffset(offset + limit); },
          }, '下一页'),
        ]),
      ]);
    }

    // --- 详情：正文 ----------------------------------------------------------

    function renderBody(rec) {
      return h('p', { className: 'cpxp-vault-body' }, text(rec.value) || '（这条记忆的正文是空的）');
    }

    // --- 详情：证据链 --------------------------------------------------------

    function renderEvidence(rec) {
      const evidence = asList(rec.evidence);
      if (!evidence.length) {
        return h(ui.Empty, {
          compact: true,
          title: '没有关联证据',
          hint: '可能是旧库导入的条目。',
        });
      }
      return h(ui.List, { label: '证据链' }, evidence.map(function (row, index) {
        const role = text(row && row.role);
        const label = ROLE_LABEL[role] || role || '未知来源';
        const excerpt = text(row && row.excerpt) || '（这条证据没有摘录）';
        return h(ui.Row, {
          key: 'ev-' + index,
          title: excerpt,
          meta: label,
          side: row && row.occurredAt ? h(ui.Timestamp, { at: row.occurredAt }) : null,
        });
      }));
    }

    // --- 详情：修订历史（含注释） --------------------------------------------

    function renderRevisions(rec) {
      const revisions = asList(rec.revisions);
      if (!revisions.length) {
        return h(ui.Empty, {
          compact: true,
          title: '没有修订记录',
          hint: '没有改过正文或状态。',
        });
      }
      return h(ui.List, { label: '修订历史' }, revisions.map(function (row, index) {
        const rawOperation = text(row && row.operation);
        const operation = OPERATION_LABEL[rawOperation] || rawOperation || '更新';
        const reason = text(row && row.reason);
        const readableReason = reason && reason.indexOf('studio-') !== 0 ? '：' + reason : '';
        const actor = text(row && row.actor);
        const actorLabel = actor === 'user' ? '你手动改的' : (actor ? '系统写入（' + actor + '）' : '系统写入');
        const pair = text(row && row.oldId) && text(row && row.newId)
          ? shortId(row.oldId) + ' → ' + shortId(row.newId)
          : '';
        return h(ui.Row, {
          key: 'rev-' + index,
          title: operation + readableReason,
          meta: actorLabel + (rawOperation === 'supersede' ? ' · 这条取代了旧版本' : ''),
          side: h('span', { className: 'cpxp-vault-inline' }, [
            pair ? h('span', { key: 'pair', className: 'cpxp-vault-mono' }, pair) : null,
            h(ui.Timestamp, { key: 'at', at: row && row.at }),
          ]),
        });
      }));
    }

    // --- 详情：标签与关联 ----------------------------------------------------

    function renderTagsRelated(rec) {
      const tags = asList(rec.tags);
      const related = asList(rec.related);
      if (!tags.length && !related.length) {
        return h(ui.Empty, {
          compact: true,
          title: '没有标签或关联',
        });
      }
      return h('div', { className: 'cpxp-vault-stack' }, [
        tags.length
          ? h('div', { key: 'tags', className: 'cpxp-vault-inline' }, tags.map(function (tag, index) {
            return h(ui.Badge, { key: 'tag-' + index, tone: 'neutral' }, text(tag));
          }))
          : null,
        related.length
          ? h(ui.List, { key: 'rel', label: '关联关系' }, related.map(function (rel, index) {
            return h(ui.Row, {
              key: 'rel-' + index,
              title: text(rel && rel.relation) || '关联',
              meta: text(rel && rel.targetRef)
                ? '指向 ' + shortId(rel.targetRef)
                : '（没有指向其它记忆）',
            });
          }))
          : null,
      ]);
    }

    // --- 详情：纠正与治理 ----------------------------------------------------

    function renderConfirm(rec) {
      const isArchive = pending === 'archive';
      const isRestore = pending === 'restore';
      const isDelete = pending === 'delete';
      const title = isArchive ? '确认归档这条记忆？' : isRestore ? '确认恢复这条记忆？' : '确认标记遗忘？';
      const body = isArchive
        ? '归档后它不再参与自动召回，但证据与修订链原样保留，随时可以恢复。'
        : isRestore
          ? '恢复后它回到「已确认」，重新参与自动召回。'
          : '标记遗忘后它不再参与召回，状态变成「已遗忘」；证据与修订链仍然保留，这一步不是物理删除。';
      return h(ui.Callout, {
        key: 'confirm',
        tone: isDelete ? 'danger' : 'warn',
        title: title,
        action: h('span', { className: 'cpxp-vault-inline' }, [
          h(ui.Button, {
            key: 'yes',
            size: 'sm',
            variant: isDelete ? 'danger' : 'primary',
            loading: busy === pending,
            disabled: Boolean(busy),
            onClick: function () { runAction(pending); },
          }, isArchive ? '确认归档' : isRestore ? '确认恢复' : '确认遗忘'),
          h(ui.Button, {
            key: 'no', variant: 'ghost', size: 'sm', disabled: Boolean(busy),
            onClick: function () { setPending(''); },
          }, '取消'),
        ]),
      }, body);
    }

    function renderGovernance(rec) {
      const archived = rec.status === 'archived';
      const retracted = rec.status === 'retracted';
      return h(ui.Band, {
        key: 'governance',
        title: '纠正与治理',
        info: '写操作都等后端回执：请求中按钮不可点，失败会保留你已经填好的内容。',
      }, [
        h(ui.Field, {
          key: 'editor',
          label: '修订正文',
          hint: '旧正文仍留在修订链里。',
        }, [
          h(ui.TextArea, {
            key: 'ta',
            rows: 4,
            value: editValue,
            disabled: Boolean(busy),
            onChange: function (input) { setEditValue(text(pickValue(input))); },
          }),
          h('div', { key: 'actions', className: 'cpxp-vault-inline' }, [
            h(ui.Button, {
              key: 'save', variant: 'primary', size: 'sm',
              loading: busy === 'revise',
              disabled: Boolean(busy) || !editOpen,
              onClick: saveRevision,
            }, '保存修订'),
            h(ui.Button, {
              key: 'reset', variant: 'ghost', size: 'sm', disabled: Boolean(busy),
              onClick: function () { setEditValue(text(rec.value)); setFormError(''); },
            }, '还原成库里的正文'),
          ]),
        ]),
        h(ui.Field, {
          key: 'policy',
          label: '表达策略（标签）',
        }, [
          h(ui.Select, {
            key: 'sel',
            value: policyDraft,
            options: POLICIES,
            disabled: Boolean(busy),
            onChange: function (input) { setPolicyDraft(text(pickValue(input))); },
          }),
          h('div', { key: 'actions', className: 'cpxp-vault-inline' }, [
            h(ui.Button, {
              key: 'apply', size: 'sm',
              disabled: Boolean(busy) || policyDraft === (rec.policy || 'direct'),
              loading: busy === 'policy',
              onClick: function () { runAction('policy', { policy: policyDraft }); },
            }, '应用策略'),
          ]),
        ]),
        flash ? h(ui.Callout, {
          key: 'flash',
          tone: flash.tone === 'danger' ? 'danger' : 'ok',
          title: '操作回执',
        }, flash.text) : null,
        formError ? h(ui.Callout, { key: 'err', tone: 'danger', title: '这次操作没有成功' }, formError) : null,
        pending ? renderConfirm(rec) : null,
        h('div', { key: 'status-actions', className: 'cpxp-vault-inline' }, [
          h(ui.Button, {
            key: 'archive', variant: 'ghost', size: 'sm', disabled: Boolean(busy),
            onClick: function () { setPending(archived ? 'restore' : 'archive'); },
          }, archived ? '恢复这条记忆' : '归档这条记忆'),
          retracted ? null : h(ui.Button, {
            key: 'forget', variant: 'ghost', size: 'sm', disabled: Boolean(busy),
            onClick: function () { setPending('delete'); },
          }, '标记遗忘（不删证据）'),
        ]),
      ]);
    }

    // --- 详情：高级诊断 ------------------------------------------------------

    function renderDiagnostic(rec) {
      const confidence = Number(rec.confidence);
      const importance = Number(rec.importance);
      const evidence = asList(rec.evidence);
      return h(ui.Diagnostic, {
        key: 'diagnostic',
        title: '高级诊断',
        hint: '标识、评分、时间戳',
      }, [
        h(ui.KeyValue, {
          key: 'kv',
          items: [
            { k: '记忆 ID', v: text(rec.id) || '—', mono: true, breakable: true },
            { k: 'Key', v: text(rec.key) || '—', mono: true, breakable: true },
            { k: '主体 / 谓词', v: (text(rec.subject) || '—') + ' / ' + (text(rec.predicate) || '—'), mono: true, breakable: true },
            { k: '现实等级', v: REALITY_LABEL[rec.realityLevel] || text(rec.realityLevel) || '—' },
            { k: '来源类型', v: text(rec.sourceKind) || '—', mono: true },
            { k: '修订版本', v: 'v' + (Number.isFinite(Number(rec.revision)) ? Number(rec.revision) : '—') },
            { k: '取代记录', v: text(rec.supersedesId) || '—', mono: true, breakable: true },
            { k: '有效期', v: (rec.validFrom ? fmt.dateTime(rec.validFrom) : '—') + ' → ' + (rec.validTo ? fmt.dateTime(rec.validTo) : '至今') },
            { k: '发生时间', v: fmt.dateTime(rec.occurredAt) },
            { k: '创建时间', v: fmt.dateTime(rec.createdAt) },
            { k: '更新时间', v: fmt.dateTime(rec.updatedAt) },
            { k: '响应时间戳', v: fmt.dateTime(loadedAt) },
          ],
        }),
        Number.isFinite(confidence)
          ? h(ui.Meter, { key: 'conf', value: confidence, max: 1, label: '可信度 ' + fmt.percent(confidence), tone: confidence >= 0.6 ? 'ok' : 'warn' })
          : null,
        Number.isFinite(importance)
          ? h(ui.Meter, { key: 'imp', value: importance, max: 1, label: '重要性 ' + fmt.percent(importance), tone: importance >= 0.75 ? 'brand' : 'neutral' })
          : null,
        evidence.length
          ? h(ui.Pre, { key: 'ev', maxHeight: '180px' }, evidence.map(function (row) {
            return (text(row && row.sourceId) || '—')
              + ' · ' + (text(row && row.role) || '—')
              + ' · 会话 ' + (text(row && row.sessionId) || '—')
              + ' #' + text(row && row.seq ? row.seq : 0);
          }).join('\n'))
          : null,
      ]);
    }

    // --- 详情抽屉 -----------------------------------------------------------

    function renderSheetBody() {
      if (detail.error) {
        return h(ui.ErrorBox, {
          key: 'detail-error',
          error: detail.error,
          onRetry: function () { if (typeof detail.reload === 'function') detail.reload(); },
        });
      }
      if (!record) {
        return detail.loading || selectedId ? h(ui.Skeleton, { rows: 5 }) : h(ui.Empty, {
          compact: true,
          title: '没有选中的记忆',
          hint: '点一行查看详情。',
        });
      }
      const rec = record;
      return h('div', { className: 'cpxp-vault-stack' }, [
        h('div', { key: 'badges', className: 'cpxp-vault-inline' }, [
          h(ui.Badge, { key: 'scope', tone: scopeTone(rec.scope) }, SCOPES_LABEL[rec.scope] || text(rec.scope) || '未知来源'),
          h(ui.Badge, { key: 'status', tone: statusTone(rec.status) }, STATUSES_LABEL[rec.status] || text(rec.status) || '未知状态'),
          h(ui.Badge, { key: 'kind', tone: 'neutral' }, KINDS_LABEL[rec.kind] || text(rec.kind) || '未知类型'),
          h(ui.Badge, { key: 'policy', tone: policyTone(rec.policy) }, POLICIES_LABEL[rec.policy] || text(rec.policy) || '未知策略'),
          h(ui.Info, {
            key: 'policy-info',
            label: '表达策略',
            text: '表达策略只影响模型会不会主动提起这条记忆，不影响你在这里查看、修订或归档。',
          }),
        ]),
        detail.loading ? h('p', { key: 'loading', className: 'cpxp-vault-muted' }, '正在重新读取这条记忆…') : null,
        h(ui.Band, { key: 'body', flush: true, title: '正文' }, renderBody(rec)),
        h(ui.Band, {
          key: 'origin',
          title: '来源与证据链',
          hint: REALITY_LABEL[rec.realityLevel] || text(rec.realityLevel) || '来源未标注现实等级',
        }, renderEvidence(rec)),
        h(ui.Band, {
          key: 'history',
          title: '修订注记（只读）',
          info: '修订链是只读注记：改了什么（operation）、谁改的（actor）、为什么（reason）都不在这里编辑。「旧 → 新」表示这条修订链里谁取代了谁。',
        }, renderRevisions(rec)),
        h(ui.Band, { key: 'tags', title: '标签与关联' }, renderTagsRelated(rec)),
        renderGovernance(rec),
        renderDiagnostic(rec),
      ]);
    }

    function renderSheetFooter() {
      if (!record) return null;
      const archived = record.status === 'archived';
      return h('div', { className: 'cpxp-vault-inline' }, [
        h(ui.Button, {
          key: 'revise',
          variant: 'primary',
          size: 'sm',
          disabled: Boolean(busy),
          onClick: function () {
            setEditOpen(!editOpen);
            setPending('');
            setFormError('');
          },
        }, editOpen ? '收起修订' : '修订正文'),
        h(ui.Button, {
          key: 'archive',
          variant: 'ghost',
          size: 'sm',
          disabled: Boolean(busy),
          onClick: function () { setPending(archived ? 'restore' : 'archive'); },
        }, archived ? '恢复' : '归档'),
        h(ui.Button, {
          key: 'close',
          variant: 'ghost',
          size: 'sm',
          onClick: function () { setSelectedId(''); },
        }, '关闭'),
      ]);
    }

    // --- 页头 / 筛选 --------------------------------------------------------

    const statusNode = h('span', { className: 'cpxp-vault-inline' }, [
      h(ui.StateLine, {
        key: 'state',
        state: list.error ? 'danger' : (list.loading ? 'warn' : 'ok'),
        text: list.error ? '记忆库不可用' : (list.loading ? '正在读取' : '记忆库已连接'),
      }),
      data ? h(ui.Timestamp, { key: 'at', at: loadedAt, prefix: '读取于' }) : null,
      data ? h('span', { key: 'count', className: 'cpxp-vault-muted' }, '命中 ' + total + ' 条') : null,
    ]);

    const filterBand = h(ui.Band, {
      key: 'filters',
      flush: true,
      title: '筛选',
      info: '关键词与筛选条件改动后立即查询，没有「查询」按钮。默认只看已确认；已遗忘 / 已取代 / 已归档 可在状态筛选里切换。',
    }, [
      h(ui.Toolbar, {
        key: 'row1',
        label: '记忆库筛选',
        right: h(ui.Button, {
          key: 'clear', variant: 'ghost', size: 'sm',
          disabled: !hasFilters,
          onClick: clearFilters,
        }, '清空筛选'),
      }, [
        h(ui.Search, {
          key: 'q',
          value: draft,
          label: '搜索记忆',
          placeholder: '搜索正文关键词…',
          onChange: function (input) { setDraft(text(pickValue(input))); },
          onEnter: function () { setQuery(draft); setOffset(0); },
        }),
        h('div', { key: 'status', className: 'cpxp-vault-pick' }, h(ui.Select, {
          value: status, options: STATUSES, width: '100%', onChange: filterChange(setStatus),
        })),
        h('div', { key: 'kind', className: 'cpxp-vault-pick' }, h(ui.Select, {
          value: kind, options: KINDS, width: '100%', onChange: filterChange(setKind),
        })),
        h('div', { key: 'scope', className: 'cpxp-vault-pick-wide' }, h(ui.Select, {
          value: scope, options: SCOPES, width: '100%', onChange: filterChange(setScope),
        })),
      ]),
    ]);

    const resultBand = h(ui.Band, {
      key: 'results',
      title: '记忆列表',
      hint: data
        ? '共 ' + total + ' 条' + (query ? '，关键词「' + clip(query, 24) + '」' : '')
        : '正在读取…',
      info: '点一行看正文全文、证据与修订链。列表默认直接显示正文，不做隐藏。',
      actions: h(ui.Segmented, {
        key: 'sort', label: '排序', options: SORTS, value: sort, onChange: filterChange(setSort),
      }),
    }, [renderList()]);

    return h(ui.Page, {
      title: '记忆库',
      info: '逐条审计长期记忆：看清它从哪里来、被谁改过，再决定纠正、归档还是遗忘。修订、归档与策略变更都会写库。',
      status: statusNode,
      actions: h(ui.Button, {
        variant: 'primary',
        loading: list.loading,
        disabled: list.loading,
        onClick: refresh,
      }, '刷新'),
    }, [
      filterBand,
      resultBand,
      h(ui.Sheet, {
        key: 'sheet',
        open: Boolean(selectedId),
        title: record
          ? '记忆详情' + (shortTag(record.id) ? ' · ' + shortTag(record.id) : '')
          : '记忆详情',
        subtitle: record
          ? [
            KINDS_LABEL[record.kind] || text(record.kind),
            SCOPES_LABEL[record.scope] || text(record.scope),
            STATUSES_LABEL[record.status] || text(record.status),
          ].filter(Boolean).join(' · ') || '正在读取'
          : '正在读取…',
        onClose: function () { setSelectedId(''); },
        footer: renderSheetFooter(),
        width: 'min(560px, 94vw)',
      }, renderSheetBody()),
    ]);
  }

  P.registerPage({ id: 'vault', label: '记忆库', order: 20, component: VaultPage });
})(P);
