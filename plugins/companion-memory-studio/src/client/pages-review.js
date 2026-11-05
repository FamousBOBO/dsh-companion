// 审核页面片段（page id: review）。纯脚本 IIFE：不使用 import / export / require / JSX。
//
// 端点（参数名以 lib/read.mjs、lib/write.mjs 为准）：
//   GET  reviews   -> { pending: [{ id, kind, scope, policy, value, confidence, updatedAt, reasons[], hidden }],
//                       failedJobs: [{ id, type, streamKey, attempts, lastError, updatedAt }] }
//   GET  memory    id + reveal=1（新宿主直接给正文并忽略 reveal；旧宿主靠 reveal=1 才给全文）
//   POST memory    { id, action:'revise', value, reason:'studio-revise' }  —— 同页批改候选正文
//   POST memory    { id, action:'restore', reason:'studio-restore' }        —— 通过（pending -> confirmed）
//   POST memory    { id, action:'delete',  reason:'studio-delete' | 'user-request' } —— 驳回（-> retracted）
//   POST review    { action:'requeue', jobId }                              —— 失败作业重新入队
//
// 管理界面不做隐藏：候选正文、证据摘录、批改框都在同一页可见可改。
// 只有「旧宿主把 value 置空」这一种情况才补一次 reveal=1（当前页前 25 条、并发 4、每条最多一次）。
(function (P) {
  'use strict';

  const { h, useState, useEffect, useRef, useApi, ui, api, fmt } = P;

  P.css(`
.cpxp-review-stack { display: flex; flex-direction: column; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-review-inline { display: inline-flex; align-items: center; gap: var(--cpx-s2, 8px); flex-wrap: wrap; min-width: 0; }
.cpxp-review-muted { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.7; overflow-wrap: anywhere; word-break: break-word; }
.cpxp-review-body { margin: 0; color: var(--dsw-alias-label-primary); font-size: var(--cpx-fs-body, 14.5px); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.cpxp-review-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.6; overflow-wrap: anywhere; word-break: break-all; }
/* 待裁决的纠正（CorrectionBand）用到的行内结构 */
.cpxp-review-correction { display: flex; flex-direction: column; gap: var(--cpx-s2, 8px); padding: var(--cpx-s3, 12px) 0; border-top: 1px solid var(--dsw-alias-border-l1); min-width: 0; }
.cpxp-review-correction:first-of-type { border-top: 0; }
.cpxp-review-row-head { display: flex; align-items: center; gap: var(--cpx-s2, 8px); flex-wrap: wrap; min-width: 0; }
.cpxp-review-row { display: flex; align-items: flex-start; gap: var(--cpx-s2, 8px); min-width: 0; padding: 4px 0; }
.cpxp-review-row-main { display: flex; align-items: center; gap: var(--cpx-s2, 8px); flex-wrap: wrap; min-width: 0; flex: 1 1 auto; }
.cpxp-review-row-side { display: flex; align-items: center; gap: var(--cpx-s2, 8px); flex: none; flex-wrap: wrap; }
.cpxp-review-pick { display: flex; align-items: flex-start; gap: var(--cpx-s2, 8px); min-width: 0; flex: 1 1 auto; cursor: pointer; }
.cpxp-review-pick input { margin-top: 3px; flex: none; }
.cpxp-review-title { color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; word-break: break-word; min-width: 0; }
.cpxp-review-actions { display: flex; align-items: center; gap: var(--cpx-s2, 8px); flex-wrap: wrap; min-width: 0; }
.cpxp-review-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.6; overflow-wrap: anywhere; word-break: break-word; }
.cpxp-review-meta { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); overflow-wrap: anywhere; }
`);

  // --- 词表 -----------------------------------------------------------------

  const SCOPES_LABEL = {
    user_global: '用户事实', user_persona: '共同关系', persona_self: '角色自我',
    roleplay_world: '剧情世界', session_recent: '近期状态',
  };
  const KINDS_LABEL = {
    fact: '事实', preference: '偏好', profile: '画像', event: '事件', commitment: '承诺',
    relationship: '关系', summary: '摘要', bot_action: '角色行为', artifact: '产物', note: '备注',
  };
  const POLICIES_LABEL = {
    direct: '可直接提及', soft_echo: '轻度呼应', tone_only: '只影响语气', avoid_unless_asked: '不主动提及',
  };
  const ROLE_LABEL = { user: '用户原话', assistant: '角色回复', system: '系统提示', tool: '工具输出' };
  const JOB_TYPE_LABEL = {
    extract: '记忆提炼', embed: '向量写入', wiki: 'Wiki 编译', summary: '摘要生成',
    capture: '对话捕获', compile: '索引编译', maintain: '维护作业',
  };
  // /reviews 返回的是 reason:<code> 标签后缀，不是句子；把已知码翻回人话。
  const REASON_LABELS = {
    low_confidence: '置信度偏低',
    no_evidence: '缺少证据',
    missing_evidence: '证据缺失',
    foreign_evidence: '越界证据',
    assistant_only: '仅角色自述',
    world_bound: '剧情世界',
    roleplay: '剧情内容',
    joke: '玩笑语气',
    guess: '推测语气',
    quoted: '引用他人',
    plan: '未来计划',
    future: '未来时间',
    sensitive: '敏感情绪',
    privacy: '隐私约定',
    uncertain: '不够确定',
    needs_review: '待人工复核',
    non_conversation_evidence: '旧库/系统材料',
    inferred: '推断内容',
    'non-actual-reality': '非现实内容',
  };
  // 只有这两个码会被 write.mjs 原样接受（其余值静默回退成 studio-ui）。
  const REJECT_REASONS = [
    { id: 'studio-delete', label: '界面里整理掉' },
    { id: 'user-request', label: '按用户要求清掉' },
  ];
  const REJECT_NOTE = {
    'studio-delete': '在审核界面里整理掉：这条候选不该进入召回，原因会以 studio-delete 入库。',
    'user-request': '用户本人要求删掉：原因会以 user-request 入库，将来排查时能看出是你主动要求的。',
  };
  const DEFAULT_REJECT_REASON = 'studio-delete';

  // --- 小工具 ---------------------------------------------------------------

  function pickValue(input) {
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

  function reasonLabel(code) {
    const key = text(code);
    return REASON_LABELS[key] || key;
  }

  function reasonSummary(reasons) {
    return asList(reasons).map(reasonLabel).filter(Boolean).join(' · ');
  }

  // --- 页面 -----------------------------------------------------------------

  function ReviewPage() {
    const toast = typeof P.useToast === 'function' ? P.useToast() : null;
    const push = toast && typeof toast.push === 'function'
      ? function (message, tone) { toast.push(message, tone || 'neutral'); }
      : function () {};

    const [loadedAt, setLoadedAt] = useState('');
    const [selectedId, setSelectedId] = useState('');
    const [reasonCode, setReasonCode] = useState(DEFAULT_REJECT_REASON);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState('');
    const [busyJob, setBusyJob] = useState('');
    const [decisionError, setDecisionError] = useState('');
    const [flash, setFlash] = useState(null);
    const [editValue, setEditValue] = useState('');
    const [editError, setEditError] = useState('');
    // 旧宿主兼容：候选 value 为空的行走一次 reveal=1 补正文（只补当前页、每条最多一次）。
    const [fills, setFills] = useState({});
    const attemptedRef = useRef({});

    const reviews = useApi(function () { return api.get('reviews'); }, []);
    // 详情一律带 reveal=1：新宿主忽略它，旧宿主靠它才给候选全文与证据摘录。
    const detail = useApi(function () {
      if (!selectedId) return null;
      return api.get('memory', { id: selectedId, reveal: 1 });
    }, [selectedId]);

    const data = reviews.data && typeof reviews.data === 'object' ? reviews.data : null;
    const pending = data ? asList(data.pending) : [];
    const failedJobs = data ? asList(data.failedJobs) : [];
    const candidate = detail.data && detail.data.id ? detail.data : null;
    const pendingTotal = pending.length;
    const failedTotal = failedJobs.length;

    useEffect(function () {
      if (reviews.loading || !reviews.data) return;
      setLoadedAt(new Date().toISOString());
    }, [reviews.data, reviews.loading]);

    // 换一条候选就清掉上一条的确认态与错误，避免把 A 的选择带到 B 上。
    useEffect(function () {
      setReasonCode(DEFAULT_REJECT_REASON);
      setConfirming(false);
      setDecisionError('');
      setEditError('');
    }, [selectedId]);

    // 详情到达后把批改框对齐到候选当前正文。
    useEffect(function () {
      if (!candidate) return;
      setEditValue(text(candidate.value));
    }, [candidate]);

    // 旧宿主兼容：GET reviews 对「不主动提及」的候选会把 value 置空。只对当前页前 25 条
    // 各补一次 GET memory?id&reveal=1（并发 4），失败的 id 记在内存里不再重试。
    // 新宿主直接返回正文、hidden 恒 false，所以这段在新宿主上不会发出额外请求。
    useEffect(function () {
      const rows = data ? asList(data.pending).slice(0, 25) : [];
      const targets = [];
      rows.forEach(function (item) {
        const id = text(item && item.id);
        if (!id || attemptedRef.current[id]) return;
        if (text(item && item.value) && !item.hidden) return;
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

    // 候选从列表里消失（已经核对完）时把抽屉一起关掉，不留一个已经不存在的详情。
    useEffect(function () {
      if (!selectedId || !data) return;
      const still = asList(data.pending).some(function (item) { return text(item && item.id) === selectedId; });
      if (!still && !detail.loading) setSelectedId('');
    }, [data, selectedId, detail.loading]);

    function refresh() {
      if (typeof reviews.reload === 'function') reviews.reload();
      if (selectedId && typeof detail.reload === 'function') detail.reload();
    }

    function goSettings() {
      if (P.nav && typeof P.nav.go === 'function') P.nav.go('settings');
    }

    /** 候选正文：优先用详情里的 value；旧宿主置空时退回补齐结果。 */
    function candidateValue(rec) {
      const direct = text(rec && rec.value);
      if (direct) return direct;
      const fill = fills[text(rec && rec.id)];
      if (fill && fill.status === 'ok') return text(fill.value);
      return '';
    }

    // 同页批改：保存正文（POST memory action=revise，reason 用白名单码 studio-revise）。
    async function saveEdit() {
      if (!candidate) return;
      const value = text(editValue).trim();
      if (!value) {
        setEditError('正文不能为空，未提交修订。');
        return;
      }
      if (value === candidateValue(candidate).trim()) {
        setEditError('正文没有变化，未提交修订。');
        return;
      }
      setBusy('revise');
      setEditError('');
      try {
        const result = await api.post('memory', {
          id: candidate.id,
          action: 'revise',
          value: value,
          reason: 'studio-revise',
        });
        const suffix = result && result.revision ? '（v' + result.revision + '）' : '';
        const message = '候选正文已修订' + suffix + '，状态仍是待核对，确认没问题再点通过。';
        push(message, 'ok');
        setFlash({ tone: 'ok', text: message });
        if (typeof detail.reload === 'function') detail.reload();
        if (typeof reviews.reload === 'function') reviews.reload();
      } catch (error) {
        const message = '修订失败：' + errorText(error);
        setEditError(message);
        setFlash({ tone: 'danger', text: message });
        push(message, 'danger');
      } finally {
        setBusy('');
      }
    }

    async function decide(kind) {
      if (!candidate) return;
      const code = kind === 'reject' ? (REJECT_NOTE[reasonCode] ? reasonCode : DEFAULT_REJECT_REASON) : 'studio-restore';
      setBusy(kind);
      setDecisionError('');
      try {
        const body = kind === 'approve'
          ? { id: candidate.id, action: 'restore', reason: 'studio-restore' }
          : { id: candidate.id, action: 'delete', reason: code };
        await api.post('memory', body);
        const message = kind === 'approve'
          ? '已通过：这条候选进入自动召回。'
          : '已驳回：' + (REJECT_REASONS.filter(function (item) { return item.id === code; })[0] || {}).label
            + '（' + code + '），这条候选不再参与召回。';
        push(message, 'ok');
        setFlash({ tone: 'ok', text: message });
        // 只有成功才离开这条候选；失败时下面的 catch 保留用户选的原因码。
        setConfirming(false);
        setReasonCode(DEFAULT_REJECT_REASON);
        setSelectedId('');
        if (typeof reviews.reload === 'function') reviews.reload();
      } catch (error) {
        const message = (kind === 'approve' ? '通过失败：' : '驳回失败：') + errorText(error);
        setConfirming(false);
        setDecisionError(message);
        setFlash({ tone: 'danger', text: message });
        push(message, 'danger');
      } finally {
        setBusy('');
      }
    }

    async function requeue(job) {
      const jobId = text(job && job.id);
      if (!jobId) return;
      setBusyJob(jobId);
      try {
        const result = await api.post('review', { action: 'requeue', jobId: jobId });
        const state = text(result && result.state) || 'pending';
        const message = '作业已重新入队（状态：' + state + '），沿用原批次与游标。';
        push(message, 'ok');
        setFlash({ tone: 'ok', text: message });
        if (typeof reviews.reload === 'function') reviews.reload();
      } catch (error) {
        const message = '重新入队失败：' + errorText(error);
        setFlash({ tone: 'danger', text: message });
        push(message, 'danger');
      } finally {
        setBusyJob('');
      }
    }

    // --- 候选列表 -----------------------------------------------------------

    function renderCandidateRow(item, index) {
      const id = text(item && item.id) || 'candidate-' + index;
      const raw = text(item && item.value);
      // 旧宿主把不主动提及的候选 value 置空：用补齐结果填列表，补不到就给可读原因。
      const needsFill = !raw || Boolean(item && item.hidden);
      const fill = needsFill ? fills[id] : null;
      let summary = raw;
      if (needsFill) {
        if (fill && fill.status === 'ok') summary = text(fill.value);
        else if (fill && fill.status === 'error') summary = '这条读不出来：' + fill.error;
        else summary = '载入中…';
      }
      const title = summary || '（这条候选没有正文）';
      const kindLabel = KINDS_LABEL[item && item.kind] || text(item && item.kind) || '未知类型';
      const scopeLabel = SCOPES_LABEL[item && item.scope] || text(item && item.scope) || '未知来源';
      const why = reasonSummary(item && item.reasons);
      return h(ui.Row, {
        key: id,
        title: title,
        meta: kindLabel + ' · ' + scopeLabel,
        status: h(ui.Badge, { tone: 'warn' }, why ? clip(why, 18) : '待核对'),
        side: h(ui.Timestamp, { at: item && item.updatedAt }),
        selected: Boolean(selectedId) && text(item && item.id) === selectedId,
        onClick: function () { setSelectedId(text(item && item.id)); },
        ariaLabel: '待核对候选：' + clip(title, 32) + '；来源 ' + scopeLabel + (why ? '；原因 ' + why : ''),
      });
    }

    function renderPendingList() {
      if (reviews.error) {
        return h(ui.ErrorBox, { key: 'error', error: reviews.error, onRetry: refresh });
      }
      if (!data) return h(ui.Skeleton, { key: 'loading', rows: 4 });
      if (!pending.length) {
        return h(ui.Empty, {
          key: 'empty',
          title: '当前没有待核对的候选',
          hint: '自动事实提炼默认关闭时这里会一直是空的。',
          action: h('span', { className: 'cpxp-review-inline' }, [
            h(ui.Button, { key: 'refresh', variant: 'ghost', size: 'sm', disabled: reviews.loading, onClick: refresh }, '再读一次'),
            h(ui.Button, { key: 'settings', variant: 'ghost', size: 'sm', onClick: goSettings }, '看提炼设置'),
          ]),
        });
      }
      return h('div', { className: 'cpxp-review-stack', key: 'list' }, [
        h('p', { key: 'hint', className: 'cpxp-review-muted' },
          '共 ' + pendingTotal + ' 条待核对。'),
        h(ui.List, { key: 'rows', label: '待核对的候选' }, pending.map(renderCandidateRow)),
      ]);    }

    // --- 失败作业 -----------------------------------------------------------

    function renderFailedJobs() {
      if (reviews.error) return null;
      if (!data) return h(ui.Skeleton, { key: 'loading', rows: 3 });
      if (!failedJobs.length) {
        return h(ui.Empty, {
          key: 'empty',
          title: '没有失败的抽取作业',
        });
      }
      return h(ui.List, { key: 'rows', label: '失败的抽取作业' }, failedJobs.map(function (job, index) {
        const jobId = text(job && job.id);
        const typeLabel = JOB_TYPE_LABEL[text(job && job.type)] || text(job && job.type) || '未知作业';
        const lastError = text(job && job.lastError);
        const attempts = Number(job && job.attempts);
        return h(ui.Row, {
          key: jobId || 'job-' + index,
          title: typeLabel,
          meta: (lastError ? '最近错误：' + clip(lastError, 80) : '没有记录错误信息')
            + (Number.isFinite(attempts) && attempts > 0 ? ' · 已尝试 ' + attempts + ' 次' : ''),
          side: h('span', { className: 'cpxp-review-inline' }, [
            h(ui.Timestamp, { key: 'at', at: job && job.updatedAt }),
            h(ui.Button, {
              key: 'retry',
              variant: 'ghost',
              size: 'sm',
              disabled: Boolean(busyJob),
              loading: busyJob === jobId,
              title: lastError || '重新入队',
              onClick: function () { requeue(job); },
            }, '重试'),
          ]),
          ariaLabel: '失败作业：' + typeLabel + (lastError ? '；最近错误 ' + clip(lastError, 40) : ''),
        });
      }));
    }

    // --- 候选详情 -----------------------------------------------------------

    function renderCandidateBody() {
      if (detail.error) {
        return h(ui.ErrorBox, {
          key: 'detail-error',
          error: detail.error,
          onRetry: function () { if (typeof detail.reload === 'function') detail.reload(); },
        });
      }
      if (!candidate) {
        return detail.loading || selectedId ? h(ui.Skeleton, { rows: 4 }) : h(ui.Empty, {
          title: '没有选中的候选',
          hint: '点一条查看详情。',
        });
      }
      const rec = candidate;
      const value = candidateValue(rec) || '（后端返回的候选正文是空的，这本身可能就是驳回的理由）';
      const evidence = asList(rec.evidence);
      // 原始 reason 码只存在于列表项（tags 里的 reason:<code>），详情接口不返回。
      const listed = pending.filter(function (item) { return text(item && item.id) === text(rec.id); })[0];
      const rawCodes = asList(listed && listed.reasons).join('、') || '—';
      const chosen = REJECT_REASONS.filter(function (item) { return item.id === reasonCode; })[0] || REJECT_REASONS[0];

      return h('div', { className: 'cpxp-review-stack' }, [
        h('div', { key: 'badges', className: 'cpxp-review-inline' }, [
          h(ui.Badge, { key: 'scope', tone: scopeTone(rec.scope) }, SCOPES_LABEL[rec.scope] || text(rec.scope) || '未知来源'),
          h(ui.Badge, { key: 'kind', tone: 'neutral' }, KINDS_LABEL[rec.kind] || text(rec.kind) || '未知类型'),
          h(ui.Badge, { key: 'policy', tone: 'neutral' }, POLICIES_LABEL[rec.policy] || text(rec.policy) || '未知策略'),
          h(ui.Badge, { key: 'status', tone: 'warn' }, '待核对'),
        ]),
        h(ui.Band, { key: 'body', flush: true, title: '候选正文' },
          h('p', { className: 'cpxp-review-body' }, value)),
        h(ui.Band, {
          key: 'evidence',
          title: '来源与证据链',
          info: '这些是提炼这条候选时引用的原话；证据越少，越该驳回。',
        }, evidence.length
          ? h(ui.List, { label: '候选的证据' }, evidence.map(function (row, index) {
            const role = text(row && row.role);
            const excerpt = text(row && row.excerpt) || '（这条证据没有摘录）';
            return h(ui.Row, {
              key: 'ev-' + index,
              title: excerpt,
              meta: ROLE_LABEL[role] || role || '未知来源',
              side: row && row.occurredAt ? h(ui.Timestamp, { at: row.occurredAt }) : null,
            });
          }))
          : h(ui.Empty, {
            title: '这条候选没有关联证据',
            hint: '可能只是模型的一次猜测。',
          })),
        h(ui.Band, {
          key: 'decision',
          title: '核对结论',
          info: '先改正文，再通过或驳回。保存修订记为一次修订（reason=studio-revise），候选仍是「待核对」；'
            + '驳回原因以固定码入库（studio-delete / user-request），自由文本不入库。',
        }, [
          h(ui.Field, {
            key: 'edit',
            label: '批改正文',
            hint: '保存后仍是待核对。',
          }, [
            h(ui.TextArea, {
              key: 'ta',
              rows: 4,
              value: editValue,
              disabled: Boolean(busy),
              placeholder: '改成真实、可追溯的说法，再保存。',
              onChange: function (input) { setEditValue(text(pickValue(input))); },
            }),
            h('div', { key: 'row', className: 'cpxp-review-inline' }, [
              h(ui.Button, {
                key: 'save',
                size: 'sm',
                loading: busy === 'revise',
                disabled: Boolean(busy),
                onClick: saveEdit,
              }, '保存修订'),
              h(ui.Button, {
                key: 'reset',
                variant: 'ghost',
                size: 'sm',
                disabled: Boolean(busy),
                onClick: function () { setEditValue(candidateValue(candidate)); setEditError(''); },
              }, '还原成候选原文'),
            ]),
            editError
              ? h(ui.Callout, { key: 'edit-err', tone: 'danger', title: '修订没有成功' }, editError)
              : null,
            flash && flash.tone !== 'danger'
              ? h(ui.Callout, { key: 'edit-flash', tone: 'ok', title: '操作回执' }, flash.text)
              : null,
          ]),
          h(ui.Field, {
            key: 'reason',
            label: '驳回原因',
          }, [
            h(ui.Segmented, {
              key: 'seg',
              label: '驳回原因',
              options: REJECT_REASONS,
              value: chosen.id,
              onChange: function (input) { setReasonCode(text(pickValue(input))); },
            }),
          ]),
          decisionError
            ? h(ui.Callout, { key: 'err', tone: 'danger', title: '这次核对没有成功' }, decisionError)
            : null,
          confirming
            ? h(ui.Callout, {
              key: 'confirm',
              tone: 'warn',
              title: '确认驳回这条候选？',
              action: h('span', { className: 'cpxp-review-inline' }, [
                h(ui.Button, {
                  key: 'yes', variant: 'danger', size: 'sm',
                  loading: busy === 'reject', disabled: Boolean(busy),
                  onClick: function () { decide('reject'); },
                }, '确认驳回'),
                h(ui.Button, {
                  key: 'no', variant: 'ghost', size: 'sm', disabled: Boolean(busy),
                  onClick: function () { setConfirming(false); },
                }, '取消'),
              ]),
            }, '驳回后不再参与召回，也不会被当成事实提起；证据与修订链保留，不是物理删除。原因：'
              + chosen.label + '（' + chosen.id + '）。')
            : null,
        ]),
        h(ui.Diagnostic, {
          key: 'diagnostic',
          title: '高级诊断',
          hint: '标识、评分、原因码',
        }, [
          h(ui.KeyValue, {
            key: 'kv',
            items: [
              { k: '候选 ID', v: text(rec.id) || '—', mono: true, breakable: true },
              { k: '类型 / 来源', v: (text(rec.kind) || '—') + ' / ' + (text(rec.scope) || '—'), mono: true },
              { k: '表达策略', v: text(rec.policy) || '—', mono: true },
              { k: '现实等级', v: text(rec.realityLevel) || '—', mono: true },
              { k: '候选原因码', v: rawCodes, mono: true, breakable: true },
              { k: '修订版本', v: 'v' + (Number.isFinite(Number(rec.revision)) ? Number(rec.revision) : '—') },
              { k: '更新时间', v: fmt.dateTime(rec.updatedAt) },
              { k: '证据条数', v: String(evidence.length) },
              { k: '本次将写入的 reason', v: confirming ? chosen.id : '（驳回时 ' + chosen.id + '；通过时 studio-restore）', mono: true },
              { k: '本页读取时间', v: fmt.dateTime(loadedAt) },
            ],
          }),
          Number.isFinite(Number(rec.confidence))
            ? h(ui.Meter, {
              key: 'conf',
              value: Number(rec.confidence),
              max: 1,
              label: '可信度 ' + fmt.percent(Number(rec.confidence)),
              tone: Number(rec.confidence) >= 0.6 ? 'ok' : 'warn',
            })
            : null,
          Number.isFinite(Number(rec.importance))
            ? h(ui.Meter, {
              key: 'imp',
              value: Number(rec.importance),
              max: 1,
              label: '重要性 ' + fmt.percent(Number(rec.importance)),
              tone: Number(rec.importance) >= 0.75 ? 'brand' : 'neutral',
            })
            : null,
          evidence.length
            ? h(ui.Pre, { key: 'ev', maxHeight: '160px' }, evidence.map(function (row) {
              return (text(row && row.sourceId) || '—')
                + ' · ' + (text(row && row.role) || '—')
                + ' · 会话 ' + (text(row && row.sessionId) || '—')
                + ' #' + text(row && row.seq ? row.seq : 0);
            }).join('\n'))
            : null,
        ]),
      ]);
    }

    function renderSheetFooter() {
      if (!candidate) return null;
      return h('div', { className: 'cpxp-review-inline' }, [
        h(ui.Button, {
          key: 'reject',
          variant: 'danger',
          size: 'sm',
          disabled: Boolean(busy) || confirming,
          loading: busy === 'reject',
          title: '先选一条驳回原因，并在这里再确认一次',
          onClick: function () { setDecisionError(''); setConfirming(true); },
        }, '驳回'),
        h(ui.Button, {
          key: 'approve',
          variant: 'primary',
          size: 'sm',
          disabled: Boolean(busy),
          loading: busy === 'approve',
          onClick: function () { decide('approve'); },
        }, '通过'),
        h(ui.Button, {
          key: 'close',
          variant: 'ghost',
          size: 'sm',
          disabled: Boolean(busy),
          onClick: function () { setSelectedId(''); },
        }, '关闭'),
      ]);
    }

    // --- 页头 ---------------------------------------------------------------

    const statusNode = h('span', { className: 'cpxp-review-inline' }, [
      h(ui.StateLine, {
        key: 'state',
        state: reviews.error ? 'danger' : (reviews.loading ? 'warn' : 'ok'),
        text: reviews.error ? '审核队列不可用' : (reviews.loading ? '正在读取' : '审核队列已连接'),
      }),
      data ? h(ui.Timestamp, { key: 'at', at: loadedAt, prefix: '读取于' }) : null,
      data ? h('span', { key: 'count', className: 'cpxp-review-muted' },
        '待核对 ' + pendingTotal + ' 条' + (failedTotal ? '，失败作业 ' + failedTotal + ' 个' : '')) : null,
    ]);

    return h(ui.Page, {
      title: '审核',
      info: '分不清真假的提炼结果会先停在这里：核对原话，再决定它要不要进入自动召回。',
      status: statusNode,
      actions: h(ui.Button, {
        variant: 'primary',
        loading: reviews.loading,
        disabled: reviews.loading,
        onClick: refresh,
      }, '刷新'),
    }, [
      h(ui.Band, {
        key: 'pending',
        flush: true,
        title: '待核对的候选',
        info: '未核对的候选不会进入自动召回，也不会被当成事实提起。',
      }, [
        flash
          ? h(ui.Callout, {
            key: 'flash',
            tone: flash.tone === 'danger' ? 'danger' : 'ok',
            title: '操作回执',
          }, flash.text)
          : null,
        renderPendingList(),
      ]),
      h(CorrectionBand, { key: 'corrections' }),
      h(ui.Band, {
        key: 'jobs',
        title: '失败的抽取作业',
        info: '重试沿用原批次与游标，不会重复写入记忆。',
      }, [renderFailedJobs()]),
      h(ui.Diagnostic, {
        key: 'diag',
        title: '高级诊断',
        hint: '队列条数、作业标识',
      }, [
        h(ui.KeyValue, {
          key: 'kv',
          items: [
            { k: '待核对 / 失败作业', v: pendingTotal + ' / ' + failedTotal },
            { k: '本页读取时间', v: fmt.dateTime(loadedAt) },
            { k: '数据来源', v: 'GET reviews（pending + failedJobs）', mono: true },
            { k: '通过', v: 'POST memory（restore + studio-restore）', mono: true },
            { k: '驳回', v: 'POST memory（delete + studio-delete | user-request）', mono: true },
            { k: '重新入队', v: 'POST review（requeue + jobId）', mono: true },
          ],
        }),
        failedJobs.length
          ? h(ui.Pre, { key: 'jobs', maxHeight: '220px' }, failedJobs.map(function (job) {
            return (text(job && job.id) || '—')
              + ' · ' + (text(job && job.type) || '—')
              + ' · 数据流 ' + (text(job && job.streamKey) || '（未绑定）')
              + ' · 尝试 ' + text(job && job.attempts ? job.attempts : 0)
              + '\n    ' + (text(job && job.lastError) || '（无错误信息）');
          }).join('\n'))
          : h('p', { key: 'none', className: 'cpxp-review-muted' }, '当前没有失败的作业，所以这里没有作业明细。'),
        pending.length
          ? h(ui.Pre, { key: 'pending', maxHeight: '160px' }, pending.map(function (item) {
            return (text(item && item.id) || '—')
              + ' · ' + (text(item && item.kind) || '—')
              + ' · reason: ' + (asList(item && item.reasons).join(',') || '—');
          }).join('\n'))
          : null,
      ]),
      h(ui.Sheet, {
        key: 'sheet',
        open: Boolean(selectedId),
        title: candidate
          ? clip(candidateValue(candidate) || '候选详情', 40)
          : '候选详情',
        subtitle: candidate
          ? [
            KINDS_LABEL[candidate.kind] || text(candidate.kind),
            SCOPES_LABEL[candidate.scope] || text(candidate.scope),
            '待核对',
          ].filter(Boolean).join(' · ') || '正在读取'
          : '正在读取…',
        onClose: function () { if (!busy) setSelectedId(''); },
        footer: renderSheetFooter(),
        width: 'min(560px, 94vw)',
      }, renderCandidateBody()),
    ]);
  }

  /**
   * 待裁决的纠正（task-40）。
   *
   * 这块是「旧记忆要不要被新说法替换」的唯一人工入口：
   *   - 只读部分：条数 + 已裁决数 + 每条候选的**正文**（截断会写出来）+ 候选 id；
   *   - 写入口：勾选要作废的旧记忆 → 提交；**一个都不勾也合法**（= 新说法是补充不是替换）；
   *   - `operator` 由服务端按宿主身份填，页面只显示"将以 <身份> 记录"；
   *   - `evidence` 用服务端给的 `evidenceHint` 原文展示，提交后把真正记下的那句回显；
   *   - 失败理由（`not-a-candidate` / `already-resolved` / …）**原样**显示，不翻译。
   */
  // 已裁决的 outcome 词表（runtime 给 resolved-superseded / resolved-none；未知的原样显示）。
  const OUTCOME_LABEL = {
    'resolved-superseded': '已作废旧记忆',
    'resolved-none': '作为补充',
  };

  function CorrectionBand() {
    const query = useApi(function () { return api.get('corrections'); }, []);
    const [picked, setPicked] = useState({});
    const [busy, setBusy] = useState('');
    const [feedback, setFeedback] = useState(null);

    const data = query.data || null;
    const recent = data && Array.isArray(data.recent) ? data.recent : [];
    const available = !data || data.available !== false;
    const evidenceHint = data && data.evidenceHint ? String(data.evidenceHint) : '';
    const operator = data && data.operator ? String(data.operator) : '';

    const toggle = function (recordId, id) {
      setPicked(function (previous) {
        const current = Array.isArray(previous[recordId]) ? previous[recordId] : [];
        const next = current.indexOf(id) >= 0
          ? current.filter(function (item) { return item !== id; })
          : current.concat([id]);
        const copy = Object.assign({}, previous);
        copy[recordId] = next;
        return copy;
      });
    };

    const submit = function (recordId) {
      if (busy) return;
      const supersedeIds = Array.isArray(picked[recordId]) ? picked[recordId] : [];
      setBusy(recordId);
      setFeedback(null);
      api.post('corrections', { recordId: recordId, supersedeIds: supersedeIds }).then(function (result) {
        const answer = result || {};
        if (answer.ok === true) {
          setFeedback({
            tone: 'ok',
            text: '已记录（' + (supersedeIds.length ? '作废旧记忆 ' + supersedeIds.length + ' 条' : '作为补充，不作废旧记忆')
              + '）。证据：' + text(answer.evidence),
          });
        } else {
          // 原样：runtime 的 code 就是给人看的理由。
          setFeedback({
            tone: 'danger',
            text: '没有生效：' + text(answer.code || 'unknown')
              + (answer.error ? '（' + text(answer.error) + '）' : '')
              + (answer.resolution ? '；此前已裁决过：' + text(JSON.stringify(answer.resolution)) : ''),
          });
        }
        setPicked(function (previous) {
          const copy = Object.assign({}, previous);
          delete copy[recordId];
          return copy;
        });
        query.reload();
      }).catch(function (error) {
        setFeedback({ tone: 'danger', text: '请求失败 — ' + errorText(error) });
      }).then(function () { setBusy(''); });
    };

    const renderRecord = function (entry, index) {
      const recordId = text(entry && entry.recordId);
      const candidates = entry && Array.isArray(entry.candidates) ? entry.candidates : [];
      const selected = Array.isArray(picked[recordId]) ? picked[recordId] : [];
      return h('div', { key: recordId || 'rec:' + index, className: 'cpxp-review-correction' }, [
        h('div', { key: 'head', className: 'cpxp-review-row-head' }, [
          h(ui.Badge, { key: 'badge', tone: 'warn' }, '待裁决'),
          h('span', { key: 'when', className: 'cpxp-review-meta' },
            entry && entry.at ? fmt.dateTime(entry.at) : '时间未知',
            ' · 记录 ', h('code', { key: 'rid' }, recordId || '（空 id）')),
        ]),
        h(ui.List, { key: 'list', label: '候选旧记忆' }, candidates.map(function (item, itemIndex) {
          const id = text(item && item.recordId);
          return h('li', { key: id || 'cand:' + itemIndex, className: 'cpxp-review-row' }, [
            h('label', { key: 'pick', className: 'cpxp-review-pick' }, [
              h('input', {
                key: 'box',
                type: 'checkbox',
                checked: selected.indexOf(id) >= 0,
                onChange: function () { toggle(recordId, id); },
              }),
              h('span', { key: 'txt' }, [
                // 正文缺失时必须**说清**"这条记忆已经不存在了"：留空行会让人以为是一条空记忆。
                item && item.missing
                  ? h('span', { key: 'gone', className: 'cpxp-review-title' }, '该记忆已不存在（只留下 id 与时间）')
                  : h('span', { key: 'body', className: 'cpxp-review-title' },
                    item && item.text ? text(item.text) : '（读不到正文）'),
                item && item.truncated ? h('span', { key: 'cut', className: 'cpxp-review-meta' }, ' …（已截断）') : null,
              ]),
            ]),
            h('span', { key: 'meta', className: 'cpxp-review-meta' },
              (item && item.kind ? text(item.kind) + ' · ' : '')
                + (item && item.missing ? '正文缺失 · ' : '')
                + h('code', { key: 'id' }, id || '（无 id）')),
          ]);
        })),
        h('p', { key: 'ev', className: 'cpxp-review-note' },
          '将以 ', h('strong', { key: 'op' }, operator || '当前宿主身份'),
          ' 记录 · 证据：', h('code', { key: 'evid' }, evidenceHint || '（读取中）')),
        h('div', { key: 'act', className: 'cpxp-review-actions' }, [
          h(ui.Button, {
            key: 'submit',
            variant: 'primary',
            size: 'sm',
            loading: busy === recordId,
            disabled: busy !== '',
            onClick: function () { submit(recordId); },
          }, selected.length ? '作废选中的 ' + selected.length + ' 条旧记忆' : '作为补充（不作废旧记忆）'),
        ]),
      ]);
    };

    // 已裁决明细：只读，只给审计字段（谁、何时、结果、作废了哪几条），**不回读正文**——
    // 那些记忆本来就被作废了，现在读到的不再是当时那条。
    const renderResolved = function (payload) {
      const rows = payload && Array.isArray(payload.resolvedRecent) ? payload.resolvedRecent : [];
      if (payload && payload.resolvedListAvailable === false) {
        return h('p', { key: 'resolved-na', className: 'cpxp-review-note' },
          '运行库没有提供 listResolved 接口。');
      }
      if (!rows.length) {
        return h(ui.Empty, {
          key: 'resolved-empty',
          title: '还没有已裁决的纠正',
        });
      }
      return h(ui.List, { key: 'resolved-list', label: '已裁决的纠正' }, rows.map(function (item, index) {
        const ids = item && Array.isArray(item.supersededIds) ? item.supersededIds : [];
        const outcome = item && item.outcome ? text(item.outcome) : '';
        return h('li', { key: (item && item.recordId) || 'done:' + index, className: 'cpxp-review-row' }, [
          h('div', { key: 'main', className: 'cpxp-review-row-main' }, [
            h(ui.Badge, { key: 'badge', tone: ids.length ? 'ok' : 'neutral' },
              outcome ? OUTCOME_LABEL[outcome] || outcome : '已裁决'),
            ids.length
              ? h('span', { key: 'ids', className: 'cpxp-review-meta' },
                '作废 ' + ids.length + ' 条：', h('code', { key: 'code' }, ids.join('、')))
              : h('span', { key: 'ids', className: 'cpxp-review-meta' }, '作为补充，未作废旧记忆'),
            item && item.operator ? h('span', { key: 'op', className: 'cpxp-review-meta' }, 'by ' + text(item.operator)) : null,
          ]),
          h('div', { key: 'side', className: 'cpxp-review-row-side' }, [
            h('span', { key: 'rid', className: 'cpxp-review-meta' }, h('code', { key: 'c' }, text(item && item.recordId))),
            h('span', { key: 'when', className: 'cpxp-review-meta' },
              item && item.at ? fmt.dateTime(item.at) : '时间未知'),
          ]),
        ]);
      }));
    };

    return h(ui.Band, {
      key: 'corrections',
      title: '待裁决的纠正',
      info: '条目来自运行库的纠正队列；正文回读自记忆库，只读。裁决会写进运行库的审计。'
        + '勾选要作废的旧记忆；一个都不勾就是「新说法是补充」。',
    }, [
      feedback
        ? h(ui.Callout, {
          key: 'fb',
          tone: feedback.tone === 'danger' ? 'danger' : 'ok',
          title: feedback.tone === 'danger' ? '这次裁决没有生效' : '裁决已记录',
        }, feedback.text)
        : null,
      !available
        ? h(ui.Empty, {
          key: 'na',
          title: '看不到纠正队列',
          hint: '运行库没有提供纠正复核接口（' + text(data && data.reason) + '）。',
        })
        : recent.length === 0
          ? h(ui.Empty, {
            key: 'empty',
            title: '没有待裁决的纠正',
          })
          : h(ui.List, { key: 'recs', label: '待裁决的纠正列表' }, recent.map(renderRecord)),
      h('p', { key: 'count', className: 'cpxp-review-note' },
        '待裁决 ' + (data && data.count !== undefined ? data.count : '—') + ' 条 · 已裁决 '
        + (data && data.resolved !== undefined ? data.resolved : '—') + ' 条'),
      renderResolved(data),
    ]);
  }

  P.registerPage({ id: 'review', label: '审核', order: 60, component: ReviewPage });
})(P);
