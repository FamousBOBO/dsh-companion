// DSH 搜图 · Client 半
//
// 面板只是**入口**：它不实现任何搜图接口，只负责
//   1. 左上：目标图预览；
//   2. 左下：像 IM 一样的输入区（粘贴/拖入/点选，图片和任意文件都能一起扔进来）；
//   3. 右侧：显示这次搜索会话写出来的结果，点图跳到原始出处。
// 每次发送 = 由 Host 起一个**独立会话 + 独立工作区**，面板轮询它的状态与结果文件。

window.__ModuleLoader__.load({
  id: '@local/dsh-paste-search',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const PANEL_ID = 'paste-search';
    const NS = 'pasteSearch';
    const API = '/api/dsh-paste-search';

    const DICTIONARIES = {
      zh: {
        panel: '搜图',
        title: '以图搜图',
        subtitle: '每次搜索一个新会话，实现交给它',
        target: '目标图',
        emptyTarget: '把图拖进来，或 Ctrl+V 粘贴',
        pick: '选择图片或文件',
        retake: '换一张',
        again: '重新搜',
        clear: '清空',
        notes: '补充说明',
        notePlaceholder: '写点线索（作品名、只查 P 站…），Ctrl+Enter 发送',
        send: '发送',
        sending: '发送中…',
        drop: '松手添加图片 / 文件',
        attach: '图片 / 文件',
        results: '搜索结果',
        waiting: '还没有结果',
        running: '搜索中',
        queued: '已排队',
        done: '完成',
        partial: '部分命中',
        failed: '失败',
        idle: '未开始',
        openSession: '打开会话',
        sources: '图源',
        summary: '结论',
        notesBlock: '会话备注',
        journal: '过程日志',
        noResultHint: '贴图之后会自动开一个会话去搜 SauceNAO / IQDB / Ascii2D / P 站原图。',
        error: '出错了',
        bytes: 'KB',
        elapsed: '用时',
        session: '会话',
        attachments: '附件',
        remove: '移除',
      },
      en: {
        panel: 'Image Search',
        title: 'Reverse image search',
        subtitle: 'One session per search; it does the actual work',
        target: 'Target image',
        emptyTarget: 'Drop an image here, or press Ctrl+V',
        pick: 'Pick image or file',
        retake: 'Replace',
        again: 'Search again',
        clear: 'Clear',
        notes: 'Notes',
        notePlaceholder: 'Extra hints (title, pixiv-only…), Ctrl+Enter to send',
        send: 'Send',
        sending: 'Sending…',
        drop: 'Drop to add images / files',
        attach: 'Images / files',
        results: 'Results',
        waiting: 'No results yet',
        running: 'Searching',
        queued: 'Queued',
        done: 'Done',
        partial: 'Partial',
        failed: 'Failed',
        idle: 'Idle',
        openSession: 'Open session',
        sources: 'Sources',
        summary: 'Summary',
        notesBlock: 'Session notes',
        journal: 'Journal',
        noResultHint: 'Drop an image and a session is spawned to search SauceNAO / IQDB / Ascii2D / pixiv.',
        error: 'Error',
        bytes: 'KB',
        elapsed: 'Took',
        session: 'Session',
        attachments: 'Attachments',
        remove: 'Remove',
      },
    };

    // ---------------------------------------------------------------------
    // 面板状态放在模块级：切走再切回来不丢图不丢结果。
    // ---------------------------------------------------------------------
    const panel = {
      attachments: [], // [{ id, kind: 'image'|'file', name, dataUrl, bytes, width, height }]
      searchId: null,
      sessionId: null,
      status: 'idle',
      startedAt: 0,
      elapsedMs: 0,
      result: null,
      journal: null,
      error: null,
      log: [], // [{ role: 'user'|'system'|'error', text, at }]
      notes: '',
      busy: false,
    };
    const host = { openSession: null, selectPanel: null };
    const listeners = new Set();

    function emit() {
      for (const listener of listeners) listener();
    }

    function patch(next) {
      Object.assign(panel, next);
      emit();
    }

    let translate = (key) => key;
    function T(key) {
      return translate(key);
    }

    function pushLog(role, text) {
      panel.log = [...panel.log, { role, text, at: Date.now() }].slice(-40);
    }

    function usePanel() {
      const [, force] = useState(0);
      useEffect(() => {
        const listener = () => force((value) => value + 1);
        listeners.add(listener);
        return () => listeners.delete(listener);
      }, []);
      return panel;
    }

    const targetImage = () => panel.attachments.find((entry) => entry.kind === 'image') ?? null;

    // ---------------------------------------------------------------------
    // 网络
    // ---------------------------------------------------------------------
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`接口没有返回 JSON（HTTP ${response.status}）`);
      }
      if (!body?.ok) throw new Error(body?.error?.message ?? `请求失败（HTTP ${response.status}）`);
      return body;
    }

    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
    }

    async function addFiles(fileList) {
      const files = [...(fileList ?? [])].filter((file) => file && (file.size > 0 || /^image\//.test(file.type)));
      if (files.length === 0) return;
      const room = Math.max(0, 8 - panel.attachments.length);
      if (room === 0) {
        pushLog('system', '一次最多 8 个附件，先删掉一些再贴。');
        emit();
        return;
      }
      const added = [];
      for (const file of files.slice(0, room)) {
        const dataUrl = await readAsDataUrl(file);
        const isImage = /^image\//.test(file.type);
        let size = {};
        if (isImage) {
          size = await new Promise((resolve) => {
            const image = new Image();
            image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
            image.onerror = () => resolve({ width: 0, height: 0 });
            image.src = dataUrl;
          });
        }
        added.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: isImage ? 'image' : 'file',
          name: file.name || (isImage ? `粘贴的图片-${panel.attachments.length + added.length + 1}` : '未命名文件'),
          dataUrl,
          bytes: file.size,
          ...size,
        });
      }
      panel.attachments = [...panel.attachments, ...added];
      pushLog('system', `已加入 ${added.length} 个附件（${added.filter((entry) => entry.kind === 'image').length} 张图）`);
      emit();
    }

    function removeAttachment(id) {
      panel.attachments = panel.attachments.filter((entry) => entry.id !== id);
      emit();
    }

    async function startSearch() {
      const images = panel.attachments.filter((entry) => entry.kind === 'image');
      if (images.length === 0 || panel.busy) return;
      patch({ busy: true, status: 'queued', error: null, startedAt: Date.now(), result: null, journal: null });
      try {
        const body = await api('/search', {
          method: 'POST',
          body: JSON.stringify({
            notes: panel.notes,
            attachments: panel.attachments.map((entry) => ({ name: entry.name, dataUrl: entry.dataUrl })),
          }),
        });
        patch({ searchId: body.search.searchId, sessionId: body.search.sessionId, status: 'running' });
        pushLog('system', `已开新会话 ${String(body.search.sessionId).slice(0, 8)}…`);
        emit();
      } catch (error) {
        patch({ status: 'failed', error: String(error.message ?? error) });
        pushLog('error', String(error.message ?? error));
      } finally {
        patch({ busy: false });
      }
    }

    async function submit() {
      const text = panel.notes.trim();
      const hasImage = panel.attachments.some((entry) => entry.kind === 'image');
      if (!hasImage && !text) return;
      if (text) pushLog('user', text);
      if (!text) pushLog('user', '（发送附件去搜）');
      emit();
      if (hasImage) {
        await startSearch();
        return;
      }
      // 没有图：只当补充说明送进正在跑的会话
      if (!panel.searchId) {
        pushLog('system', '还没有目标图，先加一张图再搜。');
        emit();
        return;
      }
      try {
        await api('/note', { method: 'POST', body: JSON.stringify({ searchId: panel.searchId, text }) });
        panel.notes = '';
        pushLog('system', '已把补充说明发给那个会话');
      } catch (error) {
        pushLog('error', String(error.message ?? error));
      }
      emit();
    }

    const POLL_MS = 2000;

    function usePolling() {
      useEffect(() => {
        let stopped = false;
        let timer = 0;
        const tick = async () => {
          if (stopped) return;
          const id = panel.searchId;
          if (id && panel.status !== 'idle') {
            try {
              const body = await api(`/search?id=${encodeURIComponent(id)}`);
              const search = body.search;
              panel.result = search.result ?? null;
              panel.journal = search.journal ?? null;
              panel.error = search.error ?? null;
              const resultStatus = search.result?.status;
              const items = search.result?.items?.length ?? 0;
              // 会话跑完但忘了把 status 改成终态时，别让面板一直转圈。
              panel.status = search.error
                ? 'failed'
                : (resultStatus === 'done' || resultStatus === 'failed' || resultStatus === 'partial')
                  ? resultStatus
                  : (search.status === 'idle' && items > 0)
                    ? 'done'
                    : (search.status === 'idle' && items === 0)
                      ? 'failed'
                      : 'running';
              if (panel.status === 'failed' && !panel.error && items === 0) {
                panel.error = '那个会话结束了，但没写出结果文件（.paste-search/result.json）。';
              }
              if (panel.startedAt) panel.elapsedMs = Date.now() - panel.startedAt;
              emit();
            } catch (error) {
              panel.error = String(error.message ?? error);
              emit();
            }
          }
          timer = window.setTimeout(tick, POLL_MS);
        };
        timer = window.setTimeout(tick, POLL_MS);
        return () => {
          stopped = true;
          window.clearTimeout(timer);
        };
      }, []);
    }

    // ---------------------------------------------------------------------
    // 小部件
    // ---------------------------------------------------------------------
    function Badge({ children, tone }) {
      return h('span', { className: `ps-badge ps-badge-${tone ?? 'muted'}` }, children);
    }

    function StatusChip({ status }) {
      const map = {
        idle: ['idle', 'muted'],
        queued: ['queued', 'warn'],
        running: ['running', 'brand'],
        done: ['done', 'success'],
        partial: ['partial', 'warn'],
        failed: ['failed', 'error'],
      };
      const [key, tone] = map[status] ?? map.idle;
      return h(Badge, { tone }, h('span', { className: 'ps-dot' }), T(key));
    }

    function TargetCard() {
      const state = usePanel();
      const target = targetImage();
      const pickRef = useRef(null);
      return h('section', { className: 'ps-card ps-target' },
        h('header', { className: 'ps-card-head' },
          h('span', { className: 'ps-card-title' }, T('target')),
          target
            ? h('span', { className: 'ps-card-sub' }, `${target.width || '?'}×${target.height || '?'} · ${Math.max(1, Math.round(target.bytes / 1024))}${T('bytes')}`)
            : null,
        ),
        h('div', {
          className: `ps-stage${target ? ' has-image' : ''}`,
          onClick: target ? undefined : () => pickRef.current?.click(),
          onDragOver: (event) => {
            event.preventDefault();
          },
          onDrop: (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer?.files?.length) void addFiles(event.dataTransfer.files);
          },
        },
          target
            ? h('img', { className: 'ps-stage-image', src: target.dataUrl, alt: T('target') })
            : h('div', { className: 'ps-stage-empty' },
              h('svg', { viewBox: '0 0 24 24', width: 26, height: 26, 'aria-hidden': true },
                h('path', { d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.4' }),
                h('circle', { cx: '9', cy: '9.5', r: '1.6', fill: 'currentColor' }),
                h('path', { d: 'M4.6 16.4l4.3-4.1 3.2 3 2.5-2.2 4.8 4.2', fill: 'none', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' })),
              h('span', null, T('emptyTarget')),
            ),
        ),
        h('div', { className: 'ps-target-actions' },
          h('button', { type: 'button', className: 'ps-btn ps-btn-ghost', onClick: () => pickRef.current?.click() }, T('pick')),
          h('button', {
            type: 'button',
            className: 'ps-btn ps-btn-ghost',
            disabled: !target || state.busy,
            onClick: () => void startSearch(),
          }, T('again')),
        ),
        h('input', {
          ref: pickRef,
          type: 'file',
          multiple: true,
          accept: 'image/*,.pdf,.txt,.md,.json,.zip,.epub',
          hidden: true,
          onChange: (event) => {
            const files = event.target.files;
            event.target.value = '';
            void addFiles(files);
          },
        }),
      );
    }

    function AttachmentRail() {
      const state = usePanel();
      if (state.attachments.length === 0) return null;
      return h('div', { className: 'ps-attach-rail' },
        ...state.attachments.map((entry) => h('div', {
          className: `ps-attach ps-attach-${entry.kind}`,
          key: entry.id,
          title: `${entry.name} · ${Math.max(1, Math.round((entry.bytes ?? 0) / 1024))}KB`,
        },
        entry.kind === 'image'
          ? h('img', { className: 'ps-attach-thumb', src: entry.dataUrl, alt: entry.name })
          : h('span', { className: 'ps-attach-icon', 'aria-hidden': true }, '📄'),
        h('span', { className: 'ps-attach-name' }, entry.name),
        h('button', {
          type: 'button',
          className: 'ps-attach-remove',
          title: T('remove'),
          'aria-label': `${T('remove')} ${entry.name}`,
          onMouseDown: (event) => event.preventDefault(),
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            removeAttachment(entry.id);
          },
        }, '×'),
        )),
      );
    }

    function ComposeCard() {
      const state = usePanel();
      const scroller = useRef(null);
      const textRef = useRef(null);
      const [dragging, setDragging] = useState(false);

      useEffect(() => {
        const node = scroller.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [state.log.length]);

      // 输入框自己长高，但封顶，长文本只在框内滚动（不允许把附件栏挤出去）。
      useEffect(() => {
        const node = textRef.current;
        if (!node) return;
        node.style.height = 'auto';
        node.style.height = `${Math.min(Math.max(node.scrollHeight, 64), 132)}px`;
      }, [state.notes]);

      const imageCount = state.attachments.filter((entry) => entry.kind === 'image').length;
      const canSend = (imageCount > 0 || state.notes.trim().length > 0) && !state.busy;

      return h('section', {
        className: `ps-card ps-compose${dragging ? ' is-dragging' : ''}`,
        'data-drop-hint': T('drop'),
        onDragOver: (event) => {
          event.preventDefault();
          setDragging(true);
        },
        onDragLeave: (event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setDragging(false);
        },
        onDrop: (event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer?.files?.length) void addFiles(event.dataTransfer.files);
        },
      },
      h('header', { className: 'ps-card-head' },
        h('span', { className: 'ps-card-title' }, T('notes')),
        h('div', { className: 'ps-head-right' },
          state.attachments.length > 0
            ? h('span', { className: 'ps-card-sub' }, `${T('attachments')} ${state.attachments.length}`)
            : null,
          state.sessionId ? h('span', { className: 'ps-card-sub' }, String(state.sessionId).slice(0, 8)) : null,
        ),
      ),
      h('div', { className: 'ps-log', ref: scroller },
        state.log.length === 0
          ? h('p', { className: 'ps-log-empty' }, '图片、文件和文字都能塞进这里：图片当目标图，其它文件当线索，Ctrl+Enter 发送。')
          : state.log.map((entry, index) => h('div', { className: `ps-log-row ps-log-${entry.role}`, key: index },
            h('span', { className: 'ps-log-role' }, entry.role === 'user' ? '你' : entry.role === 'error' ? '错误' : '系统'),
            h('span', { className: 'ps-log-text' }, entry.text),
          )),
      ),
      h('div', { className: 'ps-compose-bottom' },
        h(AttachmentRail),
        h('div', { className: 'ps-composer' },
          h('textarea', {
            ref: textRef,
            className: 'ps-textarea',
            rows: 2,
            placeholder: T('notePlaceholder'),
            value: state.notes,
            onChange: (event) => {
              panel.notes = event.target.value;
              emit();
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void submit();
              }
            },
          }),
          h('div', { className: 'ps-composer-foot' },
            h('span', { className: 'ps-hint' }, T('drop')),
            h('span', { className: 'ps-spacer' }),
            h('button', {
              type: 'button',
              className: 'ps-btn ps-btn-primary',
              disabled: !canSend,
              onClick: () => void submit(),
            }, state.busy ? T('sending') : T('send')),
          ),
        ),
      ),
      );
    }

    function ResultCard({ item, index }) {
      const [revealed, setRevealed] = useState(false);
      const thumb = item.thumb ? `${API}/img?u=${encodeURIComponent(item.thumb)}` : null;
      const open = () => {
        if (item.target) window.open(item.target, '_blank', 'noopener,noreferrer');
      };
      const similarity = typeof item.similarity === 'number' ? `${item.similarity.toFixed(1)}%` : null;
      const tone = typeof item.similarity === 'number' ? (item.similarity >= 85 ? 'success' : item.similarity >= 60 ? 'brand' : 'muted') : 'muted';
      const blurred = item.nsfw && !revealed;

      return h('article', { className: `ps-result${blurred ? ' is-blurred' : ''}`, key: item.target ?? index },
        h('button', {
          type: 'button',
          className: 'ps-thumb',
          onClick: blurred ? () => setRevealed(true) : open,
          title: blurred ? '点击显示（NSFW）' : item.target,
          'aria-label': item.title || item.target,
        },
        thumb
          ? h('img', { className: 'ps-thumb-image', src: thumb, alt: item.title ?? '', loading: 'lazy' })
          : h('span', { className: 'ps-thumb-fallback' }, (item.source ?? '?').slice(0, 2).toUpperCase()),
        similarity ? h('span', { className: `ps-sim ps-sim-${tone}` }, similarity) : null,
        ),
        h('div', { className: 'ps-result-body' },
          h('div', { className: 'ps-result-head' },
            h('span', { className: 'ps-result-source' }, item.source ?? '?'),
            item.nsfw ? h(Badge, { tone: 'warn' }, 'NSFW') : null,
          ),
          item.title ? h('p', { className: 'ps-result-title' }, item.title) : null,
          item.author ? h('p', { className: 'ps-result-author' }, item.author) : null,
          h('div', { className: 'ps-result-links' },
            item.target ? h('a', { className: 'ps-link', href: item.target, target: '_blank', rel: 'noreferrer noopener' }, '原始出处 ↗') : null,
            ...(Array.isArray(item.links) ? item.links.slice(0, 3).map((link, linkIndex) => (
              link?.url ? h('a', { className: 'ps-link ps-link-weak', key: linkIndex, href: link.url, target: '_blank', rel: 'noreferrer noopener' }, link.label ?? link.url) : null
            )) : []),
          ),
        ),
      );
    }

    function ResultsPane() {
      const state = usePanel();
      const result = state.result;
      const items = Array.isArray(result?.items) ? result.items : [];
      const elapsed = state.elapsedMs ? `${(state.elapsedMs / 1000).toFixed(1)}s` : null;

      return h('section', { className: 'ps-card ps-results' },
        h('header', { className: 'ps-card-head ps-results-head' },
          h('span', { className: 'ps-card-title' }, `${T('results')}${items.length ? ` · ${items.length}` : ''}`),
          h('div', { className: 'ps-head-right' },
            elapsed ? h('span', { className: 'ps-card-sub' }, `${T('elapsed')} ${elapsed}`) : null,
            h(StatusChip, { status: state.status }),
            state.sessionId
              ? h('button', {
                type: 'button',
                className: 'ps-btn ps-btn-ghost ps-btn-sm',
                onClick: () => {
                  try {
                    host.selectPanel?.('conversation');
                    host.openSession?.(state.sessionId);
                  } catch { /* 宿主没接就算了 */ }
                },
              }, T('openSession'))
              : null,
          ),
        ),
        result?.summary ? h('p', { className: 'ps-summary' }, result.summary) : null,
        Array.isArray(result?.sources) && result.sources.length > 0
          ? h('div', { className: 'ps-sources' },
            ...result.sources.map((source, index) => h(Badge, { key: index, tone: source.ok ? 'success' : 'warn' },
              `${source.name ?? '?'}${source.detail ? ` · ${source.detail}` : ''}`)))
          : null,
        state.error ? h('p', { className: 'ps-error' }, `${T('error')}：${state.error}`) : null,
        items.length === 0
          ? h('div', { className: 'ps-empty' },
            state.status === 'running' || state.status === 'queued'
              ? h('div', { className: 'ps-skeleton' }, ...Array.from({ length: 6 }, (_, index) => h('span', { className: 'ps-skeleton-tile', key: index })))
              : h('div', { className: 'ps-empty-copy' },
                h('p', null, T('waiting')),
                h('p', { className: 'ps-muted' }, T('noResultHint')),
              ))
          : h('div', { className: 'ps-grid' }, ...items.map((item, index) => h(ResultCard, { item, index, key: index }))),
        result?.notes ? h('p', { className: 'ps-note-text' }, `${T('notesBlock')}：${result.notes}`) : null,
        state.journal
          ? h('details', { className: 'ps-journal' }, h('summary', null, T('journal')), h('pre', null, state.journal))
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // 外壳
    // ---------------------------------------------------------------------
    function Panel() {
      const state = usePanel();
      usePolling();

      useEffect(() => {
        const onPaste = (event) => {
          const data = event.clipboardData;
          if (!data) return;
          const files = [...(data.files ?? [])];
          const text = (data.getData('text/plain') ?? '').trim();
          // 纯文字粘贴：交给输入框自己处理
          if (files.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          void addFiles(files);
          if (text) {
            panel.notes = panel.notes ? `${panel.notes}\n${text}` : text;
            emit();
          }
        };
        document.addEventListener('paste', onPaste, true);
        return () => document.removeEventListener('paste', onPaste, true);
      }, []);

      return h('div', { className: 'ps-root' },
        h('style', null, CSS),
        h('header', { className: 'ps-topbar' },
          h('div', { className: 'ps-brand' },
            h('span', { className: 'ps-brand-mark', 'aria-hidden': true },
              h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none' },
                h('circle', { cx: '10.5', cy: '10.5', r: '6', stroke: 'currentColor', strokeWidth: '1.6' }),
                h('path', { d: 'M15 15l4.5 4.5', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }),
                h('circle', { cx: '10.5', cy: '10.5', r: '2.4', fill: 'currentColor', opacity: '.55' }))),
            h('div', { className: 'ps-brand-text' },
              h('h1', null, T('title')),
              h('p', null, T('subtitle')),
            ),
          ),
          h('div', { className: 'ps-topbar-right' },
            h(StatusChip, { status: state.status }),
          ),
        ),
        h('div', { className: 'ps-body' },
          h('div', { className: 'ps-column ps-column-left' },
            h(TargetCard),
            h(ComposeCard),
          ),
          h(ResultsPane),
        ),
      );
    }

    const CSS = `
.ps-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
.ps-topbar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.ps-brand { display:flex; align-items:center; gap:10px; min-width:0; }
.ps-brand-mark { display:grid; place-items:center; width:30px; height:30px; border-radius:9px; color:var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.ps-brand-text h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:.01em; }
.ps-brand-text p { margin:2px 0 0; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.ps-topbar-right { display:flex; align-items:center; gap:8px; }
.ps-body { display:grid; grid-template-columns:minmax(300px, 360px) minmax(0, 1fr); gap:12px; padding:12px; min-height:0; flex:1; }
.ps-column { display:flex; flex-direction:column; gap:12px; min-height:0; }
.ps-card { display:flex; flex-direction:column; min-height:0; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; overflow:hidden; }
.ps-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.ps-card-title { font-size:12px; font-weight:600; }
.ps-card-sub { font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.ps-target { flex:0 0 auto; }
.ps-stage { position:relative; display:grid; place-items:center; height:176px; margin:10px; border:1px dashed var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
.ps-stage.has-image { border-style:solid; background:var(--dsw-alias-bg-base); }
.ps-stage-image { width:100%; height:100%; object-fit:contain; display:block; }
.ps-stage-empty { display:flex; flex-direction:column; align-items:center; gap:8px; padding:16px; text-align:center; color:var(--dsw-alias-label-secondary); font-size:12px; cursor:pointer; }
.ps-target-actions { display:flex; align-items:center; gap:6px; padding:0 10px 10px; }
.ps-spacer { flex:1; }
.ps-compose { flex:1 1 auto; min-height:0; overflow:hidden; position:relative; transition:border-color .12s ease, box-shadow .12s ease; }
.ps-compose-bottom { display:flex; flex-direction:column; flex:0 0 auto; border-top:1px solid var(--dsw-alias-border-l1); }
.ps-compose.is-dragging { border-color:var(--dsw-alias-brand-primary); box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary), 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.ps-compose.is-dragging::after { content:attr(data-drop-hint); position:absolute; inset:0; display:grid; place-items:center; background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent); color:var(--dsw-alias-brand-primary); font-size:13px; }
.ps-log { flex:1 1 auto; min-height:0; overflow-y:auto; padding:8px 12px; display:flex; flex-direction:column; gap:6px; }
.ps-log-empty { margin:0; font-size:11.5px; color:var(--dsw-alias-label-secondary); line-height:1.65; }
.ps-log-row { display:flex; gap:6px; font-size:11.5px; line-height:1.55; }
.ps-log-role { flex:0 0 auto; color:var(--dsw-alias-label-secondary); }
.ps-log-user .ps-log-role { color:var(--dsw-alias-brand-primary); }
.ps-log-error .ps-log-role { color:var(--dsw-alias-state-error-primary); }
.ps-log-text { white-space:pre-wrap; word-break:break-word; }
.ps-attach-rail { display:flex; flex:0 0 auto; gap:6px; padding:8px 10px 0; overflow-x:auto; overflow-y:hidden; }
.ps-attach { position:relative; display:flex; align-items:center; gap:6px; flex:0 0 auto; max-width:190px; padding:4px 6px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); }
.ps-attach-thumb { width:28px; height:28px; border-radius:5px; object-fit:cover; display:block; }
.ps-attach-icon { display:grid; place-items:center; width:28px; height:28px; border-radius:5px; background:var(--dsw-alias-bg-layer-2); font-size:14px; }
.ps-attach-name { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ps-attach-remove { display:grid; place-items:center; flex:0 0 auto; width:18px; height:18px; padding:0; border:0; border-radius:50%; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:13px; line-height:1; cursor:pointer; }
.ps-attach-remove:hover { background:var(--dsw-alias-state-error-primary); color:#fff; }
.ps-composer { display:flex; flex-direction:column; flex:0 0 auto; gap:8px; padding:8px 10px 10px; }
.ps-textarea { width:100%; box-sizing:border-box; resize:none; overflow-y:auto; min-height:64px; max-height:132px; padding:9px 11px; font:inherit; font-size:12.5px; line-height:1.6; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); border-radius:10px; outline:none; }
.ps-textarea:focus { border-color:var(--dsw-alias-brand-primary); box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); }
.ps-textarea::placeholder { color:var(--dsw-alias-label-secondary); }
.ps-composer-foot { display:flex; align-items:center; gap:8px; }
.ps-hint { font-size:11px; color:var(--dsw-alias-state-idle-primary); }
.ps-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:28px; padding:0 12px; font:inherit; font-size:12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); cursor:pointer; transition:background .12s ease, border-color .12s ease, filter .12s ease; }
.ps-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-overlay); }
.ps-btn:disabled { cursor:not-allowed; }
.ps-btn-ghost { background:transparent; }
.ps-btn-sm { height:24px; padding:0 9px; font-size:11.5px; }
.ps-btn-primary { min-width:72px; color:#fff; border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, #000); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 88%, #000); font-weight:600; }
.ps-btn-primary:hover:not(:disabled) { filter:brightness(1.12); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 92%, #000); }
.ps-btn-primary:disabled { color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); opacity:1; }
.ps-badge { display:inline-flex; align-items:center; gap:5px; height:20px; padding:0 8px; border-radius:999px; font-size:11px; line-height:1; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); white-space:nowrap; max-width:240px; overflow:hidden; text-overflow:ellipsis; }
.ps-badge-brand { color:var(--dsw-alias-brand-primary); border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); }
.ps-badge-success { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 38%, transparent); }
.ps-badge-warn { color:var(--dsw-alias-state-warn-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent); }
.ps-badge-error { color:var(--dsw-alias-state-error-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 38%, transparent); }
.ps-dot { width:6px; height:6px; border-radius:50%; background:currentColor; display:inline-block; }
.ps-results { min-height:0; }
.ps-results-head { position:sticky; top:0; z-index:2; background:var(--dsw-alias-bg-layer-1); }
.ps-head-right { display:flex; align-items:center; gap:8px; }
.ps-summary { margin:10px 12px 0; padding:8px 10px; border-radius:9px; background:var(--dsw-alias-bg-layer-2); font-size:12px; line-height:1.6; }
.ps-sources { display:flex; flex-wrap:wrap; gap:6px; padding:10px 12px 0; }
.ps-error { margin:10px 12px 0; color:var(--dsw-alias-state-error-primary); font-size:12px; }
.ps-empty { flex:1; display:grid; place-items:center; padding:24px; min-height:200px; }
.ps-empty-copy { text-align:center; color:var(--dsw-alias-label-secondary); font-size:12.5px; line-height:1.7; }
.ps-empty-copy p { margin:0; }
.ps-muted { color:var(--dsw-alias-state-idle-primary); font-size:11.5px; }
.ps-skeleton { display:grid; grid-template-columns:repeat(auto-fill, minmax(168px, 1fr)); gap:10px; width:100%; }
.ps-skeleton-tile { display:block; aspect-ratio:1 / 1; border-radius:10px; background:linear-gradient(100deg, var(--dsw-alias-bg-layer-2) 30%, var(--dsw-alias-bg-overlay) 50%, var(--dsw-alias-bg-layer-2) 70%); background-size:200% 100%; animation:ps-shimmer 1.4s ease-in-out infinite; }
@keyframes ps-shimmer { from { background-position:120% 0; } to { background-position:-20% 0; } }
.ps-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(168px, 1fr)); gap:10px; padding:12px; overflow-y:auto; align-content:start; }
.ps-result { display:flex; flex-direction:column; min-width:0; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; overflow:hidden; background:var(--dsw-alias-bg-base); transition:border-color .12s ease, transform .12s ease; }
.ps-result:hover { border-color:var(--dsw-alias-border-l2); transform:translateY(-1px); }
.ps-thumb { position:relative; display:block; padding:0; border:0; margin:0; aspect-ratio:1 / 1; background:var(--dsw-alias-bg-layer-2); cursor:pointer; overflow:hidden; }
.ps-thumb-image { width:100%; height:100%; object-fit:cover; display:block; transition:filter .16s ease; }
.ps-result.is-blurred .ps-thumb-image { filter:blur(14px) saturate(.8); }
.ps-thumb-fallback { display:grid; place-items:center; width:100%; height:100%; font-size:16px; letter-spacing:.08em; color:var(--dsw-alias-label-secondary); }
.ps-sim { position:absolute; left:6px; top:6px; padding:2px 6px; border-radius:6px; font-size:10.5px; font-variant-numeric:tabular-nums; color:#fff; background:rgba(0,0,0,.62); }
.ps-sim-success { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 82%, black); }
.ps-sim-brand { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 82%, black); }
.ps-result-body { display:flex; flex-direction:column; gap:4px; padding:8px 9px 9px; min-width:0; }
.ps-result-head { display:flex; align-items:center; gap:6px; }
.ps-result-source { font-size:10.5px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ps-result-title { margin:0; font-size:12px; line-height:1.45; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ps-result-author { margin:0; font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ps-result-links { display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; }
.ps-link { font-size:11px; color:var(--dsw-alias-brand-primary); text-decoration:none; }
.ps-link:hover { text-decoration:underline; }
.ps-link-weak { color:var(--dsw-alias-label-secondary); }
.ps-note-text { margin:0; padding:10px 12px; font-size:11.5px; line-height:1.6; color:var(--dsw-alias-label-secondary); border-top:1px solid var(--dsw-alias-border-l1); }
.ps-journal { border-top:1px solid var(--dsw-alias-border-l1); padding:8px 12px 12px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.ps-journal summary { cursor:pointer; }
.ps-journal pre { margin:8px 0 0; max-height:200px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-size:11px; line-height:1.55; }
`;

    // ---------------------------------------------------------------------
    // 侧栏图标 + 注册
    // ---------------------------------------------------------------------
    function PanelIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18;
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false',
      },
        h('circle', { cx: '10.5', cy: '10.5', r: '6', stroke: 'currentColor', strokeWidth: '1.7' }),
        h('path', { d: 'M15 15l4.6 4.6', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round' }),
        h('circle', { cx: '10.5', cy: '10.5', r: '2.3', fill: 'currentColor', fillOpacity: '.55' }));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          if (typeof ctx.uiWorkspace?.openSession === 'function') host.openSession = (id) => ctx.uiWorkspace.openSession(id);
          if (typeof ctx.layout?.selectPanel === 'function') host.selectPanel = (id) => ctx.layout.selectPanel(id);
        } catch { /* 服务缺失时按钮退化为无操作 */ }
        try {
          const bound = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : undefined;
          if (typeof bound === 'function') translate = bound;
        } catch { /* 用 key 兜底 */ }
        if (typeof ctx.locale?.register === 'function') {
          ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-paste-search: dictionaries');
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => T('panel'),
        }, PanelIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Panel));
      },
    };
  },
});
