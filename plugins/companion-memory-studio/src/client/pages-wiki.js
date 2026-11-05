// Wiki 页片段：左边主题目录，右边正文；正文只读，人工注释单独编辑与保存。
// 纯脚本 IIFE，无 import/export/require/JSX，只用 P 原语与真实端点：
//   GET  wiki                       目录（pages/topics/dir）
//   GET  wiki-page?page=           正文 + 人工注释区（content/manualNotes/revision/compiledAt）
//   POST wiki-page {pageId,notes}  只写人工注释区，等回执
//   POST maintenance {action:'compile-wiki'}  重编译自动生成区
(function (P) {
  'use strict';

  const { h, useState, useEffect, ui, api, fmt } = P;

  P.css(`
.cpxp-wiki-split { display: grid; grid-template-columns: 236px minmax(0, 1fr); gap: var(--cpx-s5, 24px); align-items: start; }
.cpxp-wiki-dir, .cpxp-wiki-main, .cpxp-wiki-doc { min-width: 0; }
.cpxp-wiki-main { display: flex; flex-direction: column; gap: var(--cpx-s3, 12px); }
.cpxp-wiki-head { display: flex; flex-direction: column; gap: var(--cpx-s2, 8px); min-width: 0; }
.cpxp-wiki-title { margin: 0; font-size: var(--cpx-fs-section, 17px); line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }
.cpxp-wiki-line { display: flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); align-items: center; min-width: 0; }
.cpxp-wiki-note { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.6; overflow-wrap: anywhere; }
.cpxp-wiki-prose { max-width: 72ch; line-height: 1.7; overflow-wrap: anywhere; word-break: break-word; }
.cpxp-wiki-prose pre, .cpxp-wiki-prose code { max-width: 100%; }
.cpxp-wiki-edit { display: flex; flex-direction: column; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-wiki-reason { display: flex; flex-direction: column; gap: var(--cpx-s1, 4px); overflow-wrap: anywhere; }
.cpxp-wiki-idlist { display: flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); }
@media (max-width: 900px) {
  .cpxp-wiki-split { grid-template-columns: minmax(0, 1fr); }
  .cpxp-wiki-prose { max-width: none; }
}
`);

  // 目录里的状态来自 db.wikiPage().status；未知状态原样展示，不假装成功。
  const STATUS = {
    compiled: { label: '已编译', tone: 'ok' },
    stale: { label: '待重编译', tone: 'warn' },
    pending: { label: '待编译', tone: 'warn' },
    invalid: { label: '已冻结', tone: 'danger' },
    error: { label: '编译失败', tone: 'danger' },
    missing: { label: '文件缺失', tone: 'neutral' },
  };

  const text = (value) => (value === null || value === undefined ? '' : String(value));
  const countOf = (value) => (Number.isFinite(Number(value)) ? fmt.number(Number(value)) : '—');
  const statusOf = (value) => STATUS[text(value).toLowerCase()]
    || { label: text(value) || '状态未知', tone: 'neutral' };
  // P.ui.* 的 onChange 有的直接给值、有的给事件，这里统一取值。
  const readValue = (input, fallback) => {
    if (input && typeof input === 'object' && input.target && 'value' in input.target) return input.target.value;
    if (typeof input === 'string' || typeof input === 'number') return input;
    return fallback;
  };
  const bytesOf = (value) => {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (typeof fmt.bytes === 'function') return fmt.bytes(bytes);
    return bytes < 1024 ? `${bytes} 字节` : `${(bytes / 1024).toFixed(1)} KB`;
  };
  // 正文里每条事实都带 [mem:<id>] 标记，这就是本页引用到的记忆。
  const refsOf = (markdown) => {
    const out = [];
    const seen = new Set();
    const pattern = /\[mem:([^\]\s]+)\]/g;
    const source = text(markdown);
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const id = text(match[1]);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  // 剧情分区由 wiki 编译器单独标注，不作为现实事实。
  const hasFiction = (markdown) => /^##\s*.*(剧情|虚构|角色扮演)/m.test(text(markdown));

  function WikiPage() {
    const catalog = P.useApi(() => api.get('wiki'), []);
    const pages = catalog.data && Array.isArray(catalog.data.pages)
      ? catalog.data.pages.filter(Boolean)
      : [];
    const dir = text(catalog.data && catalog.data.dir);

    const [picked, setPicked] = useState('');
    const activeId = picked || (pages[0] ? text(pages[0].pageId) : '');
    const [pageNonce, setPageNonce] = useState(0);
    const pageApi = P.useApi(
      () => (activeId ? api.get('wiki-page', { page: activeId }) : null),
      [activeId, pageNonce],
      { enabled: Boolean(activeId) },
    );
    const detail = pageApi.data && typeof pageApi.data === 'object' ? pageApi.data : null;

    const serverNotes = text(detail && (detail.manualNotes != null ? detail.manualNotes : detail.notes));
    const [draft, setDraft] = useState('');
    const [seed, setSeed] = useState('');
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState(null);

    // 换页、重编译或刷新后把草稿对齐到服务器的人工注释；编辑中不覆盖用户输入。
    useEffect(() => {
      if (!detail || editing) return;
      const key = `${text(detail.pageId)}|${text(detail.revision)}|${serverNotes.length}|${pageNonce}`;
      if (key === seed) return;
      setSeed(key);
      setDraft(serverNotes);
    }, [detail, editing, seed, serverNotes, pageNonce]);

    const activeItem = pages.find((item) => text(item.pageId) === activeId) || null;
    const itemStatus = statusOf(activeItem && activeItem.status);
    const compiledAt = text(detail && detail.compiledAt);
    const content = text(detail && detail.content);
    const refs = detail ? refsOf(content) : [];
    const fiction = detail ? hasFiction(content) : false;
    const dirty = Boolean(detail) && draft !== serverNotes;
    const canEdit = Boolean(detail) && detail.exists !== false;
    const frozen = text(activeItem && activeItem.status).toLowerCase() === 'invalid';

    const select = (id) => {
      if (!id || id === activeId) return;
      setPicked(id);
      setEditing(false);
      setNotice(null);
    };

    const save = () => {
      if (busy || !detail) return;
      const pageId = text(detail.pageId) || activeId;
      if (!pageId) return;
      setBusy('save');
      setNotice(null);
      api.post('wiki-page', { pageId, notes: draft }).then(
        (result) => {
          const normalized = text(result && result.notes);
          setBusy('');
          setEditing(false);
          setSeed('');
          setPageNonce((value) => value + 1);
          catalog.reload();
          setNotice({ tone: 'ok', message: `已保存（${countOf((normalized || draft).length)} 字符）。` });
        },
        (error) => {
          // 失败保留草稿与编辑态，用户可以改完再存。
          setBusy('');
          setNotice({
            tone: 'danger',
            message: `保存失败：${text(error && error.message) || '接口没有返回原因'}。草稿还在。`,
          });
        },
      );
    };

    const compile = () => {
      if (busy) return;
      if (typeof P.confirm === 'function'
        && !P.confirm('重新编译全部 Wiki 主题页？自动生成区会按当前事实重写，人工注释保持不动。')) return;
      setBusy('compile');
      setNotice(null);
      api.post('maintenance', { action: 'compile-wiki' }).then(
        (result) => {
          const compiled = result && result.result && result.result.wiki
            ? result.result.wiki.compiled !== false
            : true;
          setBusy('');
          setSeed('');
          setPageNonce((value) => value + 1);
          catalog.reload();
          setNotice(compiled
            ? { tone: 'ok', message: '已重编译，注释未变。' }
            : { tone: 'warn', message: '没有编译任何页面（wiki 可能未启用）。' });
        },
        (error) => {
          setBusy('');
          setNotice({
            tone: 'danger',
            message: `重编译失败：${text(error && error.message) || '接口没有返回原因'}`,
          });
        },
      );
    };

    const headerActions = editing
      ? [
        h(ui.Button, {
          key: 'save',
          variant: 'primary',
          onClick: save,
          loading: busy === 'save',
          disabled: Boolean(busy) || !canEdit || !dirty,
        }, '保存注释'),
        h(ui.Button, {
          key: 'cancel',
          variant: 'ghost',
          disabled: busy === 'save',
          onClick: () => { setEditing(false); setDraft(serverNotes); setNotice(null); },
        }, '取消'),
      ]
      : [
        h(ui.Button, {
          key: 'edit',
          variant: 'primary',
          disabled: !canEdit,
          onClick: () => { setEditing(true); setNotice(null); },
        }, canEdit ? '编辑注释' : (detail ? '页面未生成' : '先选主题')),
        h(ui.Button, {
          key: 'refresh',
          variant: 'ghost',
          loading: Boolean(catalog.loading || pageApi.loading),
          onClick: () => { catalog.reload(); pageApi.reload(); },
        }, '刷新'),
      ];

    const statusNode = h('span', { className: 'cpxp-wiki-note' },
      `共 ${countOf(pages.length)} 个主题`,
      compiledAt
        ? [' · 本页编译于 ', h(ui.Timestamp, { key: 'at', at: compiledAt })]
        : [' · 还没有编译时间']);

    const catalogNode = (() => {
      if (catalog.error) {
        return h(ui.ErrorBox, { error: catalog.error, onRetry: catalog.reload });
      }
      if (catalog.loading && !pages.length) return h(ui.Skeleton, { rows: 4 });
      if (!pages.length) {
        return h(ui.Empty, {
          title: '还没有 Wiki 页面',
          hint: '还没有主题页，先重编译一次。',
          action: h(ui.Button, {
            variant: 'ghost',
            size: 'sm',
            onClick: compile,
            loading: busy === 'compile',
          }, '重编译 Wiki'),
        });
      }
      return h(ui.List, { label: '主题目录' }, pages.map((item) => {
        const id = text(item.pageId);
        const info = statusOf(item.status);
        const notes = text(item.notes);
        return h(ui.Row, {
          key: id || text(item.topic),
          title: text(item.topic) || id || '未命名主题',
          meta: [id || '编号未返回', notes ? '有人工注释' : ''].filter(Boolean).join(' · '),
          side: h(ui.Badge, { tone: info.tone }, info.label),
          selected: id === activeId,
          onClick: () => select(id),
          ariaLabel: `${text(item.topic) || id || '未命名主题'}${id === activeId ? '（当前页）' : ''}`,
        });
      }));
    })();

    const docNode = (() => {
      if (!activeId) {
        return h(ui.Empty, { title: '先选一个主题', hint: '目录在左边。' });
      }
      if (pageApi.error) {
        return h(ui.ErrorBox, { error: pageApi.error, onRetry: pageApi.reload });
      }
      if (pageApi.loading && !detail) return h(ui.Skeleton, { rows: 6 });
      if (!detail) {
        return h(ui.Empty, { title: '没有取到这一页', hint: '点「刷新」再取一次。' });
      }
      const body = detail.exists === false
        ? h(ui.Callout, {
          tone: 'warn',
          title: '页面文件不存在',
          children: '重编译即可生成。',
        })
        : content
          ? h('div', { className: 'cpxp-wiki-prose' }, h(ui.Markdown, { text: content }))
          : h(ui.Callout, {
            tone: 'info',
            title: '页面内容为空',
            children: '还没有符合条件的已确认事实。',
          });
      return h('div', { className: 'cpxp-wiki-doc' },
        h('div', { className: 'cpxp-wiki-head' },
          h('h2', { className: 'cpxp-wiki-title' }, text(detail.topic) || text(detail.pageId) || '未命名主题'),
          h('div', { className: 'cpxp-wiki-line' },
            h(ui.Badge, { tone: itemStatus.tone }, itemStatus.label),
            fiction ? h(ui.Badge, { tone: 'warn' }, '含剧情分区') : null,
            h(ui.Badge, { tone: 'neutral' }, `引用 ${countOf(refs.length)} 条记忆`),
            compiledAt ? h(ui.Timestamp, { at: compiledAt, prefix: '编译于 ' }) : h('span', { className: 'cpxp-wiki-note' }, '编译时间未知'))),
        body);
    })();

    const NOTICE_TITLE = { ok: '操作完成', warn: '需要注意', danger: '操作没有成功' };
    const noticeNode = notice
      ? h(ui.Callout, {
        tone: notice.tone,
        title: NOTICE_TITLE[notice.tone] || '操作结果',
        children: notice.message,
      })
      : null;

    const notesBand = detail
      ? h(ui.Band, {
        title: '人工注释',
        info: '只写入人工区，不动自动生成区；保存等后端回执，失败时草稿保留。',
        actions: h(ui.Badge, { tone: dirty ? 'warn' : 'neutral' }, dirty ? '有未保存修改' : '已同步'),
      },
        h('div', { className: 'cpxp-wiki-edit' },
          frozen
            ? h(ui.Callout, {
              tone: 'danger',
              title: '这一页已冻结',
              children: '先重编译；注释仍可保存。',
            })
            : null,
          editing
            ? h(ui.TextArea, {
              value: draft,
              rows: 6,
              placeholder: '例如：称呼以最新确认为准',
              onChange: (input) => setDraft(text(readValue(input, draft))),
            })
            : serverNotes
              ? h('div', { className: 'cpxp-wiki-prose' }, h(ui.Markdown, { text: serverNotes }))
              : h('p', { className: 'cpxp-wiki-note' }, '还没有人工注释。点「编辑注释」开始写。'),
          editing
            ? h('p', { className: 'cpxp-wiki-note' }, dirty ? `${countOf(text(draft).length)} 字符` : '没有改动。')
            : null))
      : null;

    const refsBand = detail
      ? h(ui.Band, {
        title: '引用',
        info: '编号来自正文里的 [mem:…] 标记，属于技术字段。',
      },
        h('div', { className: 'cpxp-wiki-reason' },
          h('div', { className: 'cpxp-wiki-line' },
            h(ui.Badge, { tone: refs.length ? 'neutral' : 'warn' }, `引用 ${countOf(refs.length)} 条记忆`),
            fiction ? h(ui.Badge, { tone: 'warn' }, '剧情内容不作为现实事实') : null),
          h('p', { className: 'cpxp-wiki-note' },
            refs.length ? '核对原文去「记忆库」。' : '正文里没有引用标记。')),
        h(ui.Diagnostic, { title: '引用与文件技术明细' },
          h(ui.KeyValue, {
            items: [
              { k: '页面标识', v: text(detail.pageId), mono: true },
              { k: '文件路径', v: text(detail.path) || '—', mono: true, breakable: true },
              { k: '修订版本', v: Number(detail.revision) > 0 ? `v${countOf(detail.revision)}` : '—', mono: true },
              { k: '生成区大小', v: bytesOf(detail.generatedBytes) },
              { k: '文件存在', v: detail.exists === false ? '否' : '是' },
              { k: '编译时间', v: compiledAt || '—', mono: true },
              { k: '输出目录', v: dir || '—', mono: true, breakable: true },
            ],
          }),
          refs.length
            ? h(ui.Pre, null, refs.join('\n'))
            : h('p', { className: 'cpxp-wiki-note' }, '没有引用编号。')))
      : null;

    return h(ui.Page, {
      title: 'Wiki',
      lead: '事实编译成主题页；注释单独保存。',
      status: statusNode,
      actions: headerActions,
    },
    h(ui.Band, { flush: true },
      noticeNode,
      pages.length
        ? h('div', { className: 'cpxp-wiki-split' },
          h('div', { className: 'cpxp-wiki-dir' },
            h('p', { className: 'cpxp-wiki-note' }, `主题目录 · ${countOf(pages.length)} 个主题`),
            catalogNode),
          h('div', { className: 'cpxp-wiki-main' }, docNode))
        : catalogNode),
    notesBand,
    refsBand,
    h(ui.Band, {
      title: '维护',
      hint: '会重写所有主题页的生成区，注释不动。',
      actions: h(ui.Button, {
        variant: 'ghost',
        onClick: compile,
        loading: busy === 'compile',
        disabled: Boolean(busy),
      }, '重编译 Wiki'),
    }));
  }

  P.registerPage({ id: 'wiki', label: 'Wiki', order: 40, component: WikiPage });
})(P);
