// 工作区：当前工作区的真实路径、宿主目录能力的真实判定，以及可用时的原生入口。
//
// 宿主的目录能力是互斥的两档（宿主包 @deepseek-ai/dsh-host-directory-picker）：
//   native —— 只提供系统「选择文件夹」对话框（pick），没有 list / createDirectory；
//   browse —— 只提供面板内浏览（list / createDirectory），不弹系统对话框。
// 哪一档由宿主启动时决定，客户端拿不到；而 uiWorkspace 上两个方法都在，所以
// 「能不能浏览」不能靠 typeof 判断，只能靠一次真实的 listDirectory 探测：
//   * 成功 → 面板内浏览可用；
//   * 失败且是 directory-picker/unavailable（needs the browse capability）→ 判定
//     native-only，结论缓存进 state：之后不再调用、不再重试，也不再显示宿主的英文原始串；
//   * 其它失败 → 人话原因 + 重试。
// 本页不切换宿主的 directory-picker provider，也不拿系统对话框做探测。
(function (P) {
  const { h, ui, fmt } = P;
  const { useState, useEffect, useCallback } = P;

  const TITLE = '工作区';
  const LEAD = '工作区在哪、这一页能不能浏览目录。';
  const NO_SERVICE = '宿主没有把工作区服务交给这个插件';

  // 解释性文案只进 ⓘ（悬停或键盘聚焦才显示）：不看不会误解的地方不挂。
  const info = (text) => (ui.Info ? h(ui.Info, { key: 'info', text }) : null);

  // 宿主 DirectoryPickerController 的固定拒绝码：组装的 picker 只提供另一种能力。
  const BROWSE_UNAVAILABLE = 'directory-picker/unavailable';

  P.css(`
    .cpxp-ws-path { overflow-wrap:anywhere; word-break:break-word; min-width:0; font-family:var(--cpx-mono); font-size:var(--cpx-fs-small); }
    .cpxp-ws-sep { color:var(--dsw-alias-label-secondary); opacity:.6; }
    .cpxp-ws-crumbs { display:flex; flex-wrap:wrap; align-items:center; gap:var(--cpx-s1); min-width:0; }
    .cpxp-ws-crumb { border:0; background:transparent; color:var(--dsw-alias-brand-primary); font:inherit; font-size:var(--cpx-fs-small); padding:2px 6px; border-radius:var(--cpx-r-sm); cursor:pointer; max-width:38ch; text-align:left; overflow-wrap:anywhere; }
    .cpxp-ws-crumb:hover { background:var(--dsw-alias-bg-layer-2); }
    .cpxp-ws-crumb[aria-current="true"] { color:var(--dsw-alias-label-primary); cursor:default; }
    .cpxp-ws-crumb[aria-current="true"]:hover { background:transparent; }
    .cpxp-ws-crumb-sep { color:var(--dsw-alias-label-secondary); font-size:var(--cpx-fs-small); }
    .cpxp-ws-note { margin:0; font-size:var(--cpx-fs-small); line-height:1.7; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; max-width:72ch; }
    .cpxp-ws-sheet { display:flex; flex-direction:column; gap:var(--cpx-s3); min-width:0; }
  `);

  // -------------------------------------------------------------------------
  // 路径与目录条目。宿主只承诺「目录列表」，这里对字段做保守归一：
  // 认不出的条目按「其他类型」显示，绝不凭空补内容。
  // -------------------------------------------------------------------------

  function trimPath(value) {
    const text = typeof value === 'string' ? value : '';
    if (!text) return '';
    // 根路径不能把分隔符剪掉：'/' 与 Windows 盘符根 'D:\' 都还是根。
    if (/^[\\/]+$/.test(text)) return text.charCodeAt(0) === 92 ? '\\' : '/';
    if (/^[A-Za-z]:[\\/]$/.test(text)) return `${text.slice(0, 2)}\\`;
    const trimmed = text.replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
    return trimmed;
  }

  function separatorOf(text) {
    return text.indexOf('\\') >= 0 || /^[A-Za-z]:$/.test(text) ? '\\' : '/';
  }

  function joinPath(base, name) {
    const parent = trimPath(base);
    if (!parent) return name;
    return `${parent}${separatorOf(parent)}${name}`;
  }

  function nameOf(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (typeof entry.name === 'string' && entry.name) return entry.name;
    const raw = typeof entry.path === 'string' ? entry.path : '';
    const parts = raw.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : raw;
  }

  function kindOf(entry) {
    if (!entry || typeof entry !== 'object') return 'other';
    const type = String(entry.type || entry.kind || '').toLowerCase();
    if (type === 'directory' || type === 'dir' || type === 'folder') return 'directory';
    if (type === 'file' || type === 'regular') return 'file';
    if (entry.isDirectory === true || entry.directory === true) return 'directory';
    return 'other';
  }

  function kindLabel(kind) {
    if (kind === 'directory') return '目录';
    if (kind === 'file') return '文件';
    return '其他类型';
  }

  // 宿主 browse 能力的 list 只返回「可以进入的子目录」，行里没有 type 字段；
  // 整份结果带 crumbs/home 时按目录行处理（这不是猜内容，是该接口的定义）。
  function normalizeListing(value, base) {
    const rows = Array.isArray(value) ? value : value && Array.isArray(value.entries) ? value.entries : [];
    const object = !Array.isArray(value) && value && typeof value === 'object' ? value : null;
    const reported = object && typeof object.path === 'string' ? object.path : trimPath(base);
    const current = trimPath(reported);
    const browseShaped = Boolean(object && Array.isArray(object.crumbs));
    const entries = [];
    rows.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const name = nameOf(entry);
      if (!name) return;
      const explicit = kindOf(entry);
      const kind = explicit === 'other' && browseShaped ? 'directory' : explicit;
      const own = typeof entry.path === 'string' && entry.path ? entry.path : joinPath(current, name);
      entries.push({
        key: `${kind}-${index}-${own || name}`,
        name,
        kind,
        path: own,
        size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : null,
        modifiedAt: entry.modifiedAt || entry.mtimeMs || entry.mtime || null,
      });
    });
    entries.sort((left, right) => {
      if (left.kind !== right.kind) {
        if (left.kind === 'directory') return -1;
        if (right.kind === 'directory') return 1;
        if (left.kind === 'other') return -1;
        if (right.kind === 'other') return 1;
        return 0;
      }
      return left.name.localeCompare(right.name);
    });
    const hostCrumbs = [];
    if (object && Array.isArray(object.crumbs)) {
      object.crumbs.forEach((crumb, index) => {
        if (!crumb || typeof crumb !== 'object' || typeof crumb.path !== 'string') return;
        const label = typeof crumb.name === 'string' && crumb.name ? crumb.name : crumb.path;
        hostCrumbs.push({ key: `host-${index}`, label, path: crumb.path });
      });
    }
    return {
      path: current,
      entries,
      hostCrumbs,
      truncated: Boolean(object && object.truncated),
    };
  }

  function crumbsFromListing(listing) {
    if (listing && Array.isArray(listing.hostCrumbs) && listing.hostCrumbs.length) return listing.hostCrumbs;
    // 回退：宿主没给祖先链时按路径字符串切分。空路径在宿主那边就是主目录。
    const text = trimPath(listing && listing.path ? listing.path : '');
    const crumbs = [{ key: 'root', label: '主目录', path: '' }];
    if (text) {
      let start = 0;
      for (let index = 0; index < text.length; index += 1) {
        const char = text.charAt(index);
        if (char !== '/' && char !== '\\') continue;
        const label = text.slice(start, index);
        if (label) crumbs.push({ key: `crumb-${index}`, label, path: text.slice(0, index) });
        start = index + 1;
      }
      const tail = text.slice(start);
      if (tail) crumbs.push({ key: 'tail', label: tail, path: text });
    }
    return crumbs;
  }

  // -------------------------------------------------------------------------
  // 宿主报错分类。DirectoryBrowseError 带 rpcError = {code, message, details}；
  // native-only 的原始 message 是英文串，只能进诊断，不能当页面文案。
  // -------------------------------------------------------------------------

  function classifyBrowseError(error) {
    if (!error) return null;
    const rpc = error && typeof error === 'object' && error.rpcError && typeof error.rpcError === 'object'
      ? error.rpcError
      : null;
    const code = (rpc && typeof rpc.code === 'string' && rpc.code)
      || (typeof error.code === 'string' ? error.code : '');
    const details = rpc && rpc.details && typeof rpc.details === 'object' ? rpc.details : null;
    const capability = details && typeof details.capability === 'string' ? details.capability : '';
    const rpcMessage = rpc && typeof rpc.message === 'string' ? rpc.message : '';
    const message = rpcMessage || (typeof error.message === 'string' ? error.message : String(error));
    const nativeOnly = code === BROWSE_UNAVAILABLE
      || /needs the browse capability/i.test(message)
      || /serves "native"/i.test(message);
    return {
      nativeOnly,
      capability: capability || (nativeOnly ? 'native' : ''),
      code,
      message,
    };
  }

  // 只有「读不到」这类失败会走到这里；文案不出现英文码与原始串。
  function humanReason(diagnosis, target) {
    const code = diagnosis ? diagnosis.code : '';
    const where = target ? `「${target}」` : '宿主主目录';
    if (code === 'directory-picker/unreadable') {
      return `宿主读不了 ${where}：目录可能已经被删除、没有读取权限，或者不在它允许读取的范围里。换一个目录再试。`;
    }
    if (code === 'gateway/cancelled') {
      return '这次读取被取消了（通常是页面切换或请求中止），再试一次就好。';
    }
    if (code === 'gateway/internal') {
      return `宿主在读取 ${where} 时内部出错，没有把目录列出来。可以重试；一直失败就换个目录。`;
    }
    return `宿主没有把 ${where} 的目录内容交出来；具体原因只放在下面的「高级诊断」里。`;
  }

  // -------------------------------------------------------------------------
  // 真实路径：优先宿主 workspaces 快照（包含当前会话的那一个），其次当前会话的
  // cwd，都没有就显示 ——— 不写「工作区根目录」这种含糊说法，也不猜磁盘位置。
  // -------------------------------------------------------------------------

  function snapshotOf(store) {
    try {
      if (!store || typeof store.getSnapshot !== 'function') return null;
      const value = store.getSnapshot();
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  function sessionsIndex(services) {
    const snapshot = snapshotOf(services && services.sessions && services.sessions.list);
    const byId = snapshot && snapshot.byId && typeof snapshot.byId === 'object' ? snapshot.byId : {};
    const ids = snapshot && Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(byId);
    return { ids, byId };
  }

  // 当前会话：宿主主视图里持有的那一个（retainedBy.mainView > 0），
  // 再补上宿主自己保存的当前会话指针（读不到就当没有）。
  function currentSessionIds(services, uiWorkspace) {
    const { ids, byId } = sessionsIndex(services);
    const out = [];
    ids.forEach((id) => {
      const row = byId[id];
      const retained = row && row.retainedBy && typeof row.retainedBy === 'object'
        ? Number(row.retainedBy.mainView || 0)
        : 0;
      if (retained > 0) out.push(id);
    });
    const saved = snapshotOf(uiWorkspace && uiWorkspace.selection);
    const savedId = saved && typeof saved.sessionId === 'string' ? saved.sessionId : '';
    if (savedId && !out.includes(savedId)) out.push(savedId);
    return out;
  }

  function cwdOf(byId, id) {
    const row = byId ? byId[id] : null;
    return row && typeof row.cwd === 'string' ? trimPath(row.cwd) : '';
  }

  function resolveLocation(services, uiWorkspace) {
    const workspaceSnapshot = snapshotOf(services && services.workspaces && services.workspaces.list);
    const items = workspaceSnapshot && Array.isArray(workspaceSnapshot.items)
      ? workspaceSnapshot.items.filter((item) => item && typeof item.path === 'string' && trimPath(item.path))
      : [];
    const { ids, byId } = sessionsIndex(services);
    const sessionIds = currentSessionIds(services, uiWorkspace);
    const matched = items.find((item) => Array.isArray(item.sessionIds)
      && item.sessionIds.some((id) => sessionIds.includes(id)));
    if (matched) {
      return {
        path: trimPath(matched.path),
        title: typeof matched.title === 'string' ? matched.title : '',
        label: '当前工作区',
        source: 'workspace-session',
      };
    }
    if (items.length) {
      const first = items[0];
      return {
        path: trimPath(first.path),
        title: typeof first.title === 'string' ? first.title : '',
        label: items.length > 1 ? '工作区' : '当前工作区',
        source: items.length > 1 ? 'workspace-first-of-many' : 'workspace-only',
      };
    }
    let cwd = '';
    for (const id of sessionIds) {
      cwd = cwdOf(byId, id);
      if (cwd) break;
    }
    if (!cwd && ids.length === 1) cwd = cwdOf(byId, ids[0]);
    if (cwd) return { path: cwd, title: '', label: '当前会话目录', source: 'session-cwd' };
    return { path: '', title: '', label: '当前工作区', source: 'none' };
  }

  // -------------------------------------------------------------------------
  // 目录读取 = 能力探测。AbortController 取消上一次请求，页面卸载时 abort。
  // -------------------------------------------------------------------------

  function useDirectoryProbe(service, path, tick, enabled) {
    // 只看「有没有接口」这个布尔值，不把服务对象本身放进依赖：
    // 宿主服务实例在个别组合里会换壳，拿对象当依赖会让探测反复重发。
    const ready = Boolean(service && typeof service.listDirectory === 'function');
    const [state, setState] = useState({ data: null, error: null, loading: false, probedAt: 0 });
    useEffect(() => {
      if (!enabled || !ready) return undefined;
      const controller = new AbortController();
      let cancelled = false;
      // 换目录时先清空：宁可先给加载态，也不让上一个目录的条目冒充新目录。
      setState({ data: null, error: null, loading: true, probedAt: 0 });
      Promise.resolve()
        .then(() => service.listDirectory(path, controller.signal))
        .then(
          (listing) => {
            if (cancelled) return;
            setState({ data: normalizeListing(listing, path), error: null, loading: false, probedAt: Date.now() });
          },
          (error) => {
            if (cancelled || controller.signal.aborted) return;
            setState({ data: null, error, loading: false, probedAt: Date.now() });
          },
        )
        .catch(() => { /* 上面的 rejection 分支已经处理 */ });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }, [ready, path, tick, enabled]);
    return state;
  }

  // 宿主没有承诺把会话清单交给插件界面，这一页只列「接口在不在」，不去猜形状。

  function WorkspacePage() {
    const services = P.services && typeof P.services === 'object' ? P.services : {};
    const uiWorkspace = services.uiWorkspace && typeof services.uiWorkspace === 'object' ? services.uiWorkspace : null;
    const canList = Boolean(uiWorkspace && typeof uiWorkspace.listDirectory === 'function');
    const canPick = Boolean(uiWorkspace && typeof uiWorkspace.pickDirectory === 'function');
    const canStart = Boolean(uiWorkspace && typeof uiWorkspace.startSession === 'function');
    const canOpen = Boolean(uiWorkspace && typeof uiWorkspace.openSession === 'function');
    const canChat = Boolean(P.nav && typeof P.nav.canOpenPanel === 'function' && P.nav.canOpenPanel());

    const location = resolveLocation(services, uiWorkspace);
    // browsePath = null 时跟着宿主的真实工作区；用户点面包屑/目录后才独立。
    const [browsePath, setBrowsePath] = useState(null);
    const [tick, setTick] = useState(0);
    const [selected, setSelected] = useState(null);
    const [busy, setBusy] = useState('');
    const [note, setNote] = useState(null);
    const [unsupported, setUnsupported] = useState(null);
    const [pickError, setPickError] = useState(null);
    const [pickedPath, setPickedPath] = useState('');

    const activePath = browsePath === null ? trimPath(location.path) : browsePath;
    const listing = useDirectoryProbe(uiWorkspace, activePath, tick, canList && !unsupported);
    const diagnosis = classifyBrowseError(listing.error);
    // native-only 一旦判定就以内存的结论为准：即使后续 state 被重置，
    // 诊断里照样能看到当初那条原始报错。
    const activeDiagnosis = unsupported || diagnosis;
    const nativeOnly = Boolean(activeDiagnosis && activeDiagnosis.nativeOnly);

    // 判定一次就够：native-only 是宿主这版组合的稳定事实，之后再问也是同一个拒绝。
    useEffect(() => {
      if (unsupported || !nativeOnly) return;
      setUnsupported(activeDiagnosis);
    }, [unsupported, nativeOnly]);

    const mode = unsupported ? 'native'
      : !canList ? 'absent'
        : listing.error ? 'error'
          : listing.data ? 'browse'
            : 'probing';

    const crumbs = listing.data ? crumbsFromListing(listing.data) : [];
    const parentPath = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;

    const goTo = useCallback((next) => {
      setSelected(null);
      setBrowsePath(trimPath(next));
    }, []);
    const closeSheet = useCallback(() => setSelected(null), []);
    const backToWorkspace = useCallback(() => {
      setSelected(null);
      setBrowsePath(null);
      setTick((value) => value + 1);
    }, []);

    const reload = () => setTick((value) => value + 1);
    const openChat = () => { if (canChat) P.nav.openPanel('conversation'); };

    const startSession = () => {
      if (!canStart || busy) return;
      setBusy('start');
      setNote(null);
      Promise.resolve()
        .then(() => uiWorkspace.startSession())
        .then(() => {
          setBusy('');
          setTick((value) => value + 1);
          if (canChat) P.nav.openPanel('conversation');
          else setNote({ tone: 'warn', text: '会话已建好，但没能切到聊天面板。' });
        }, (error) => {
          setBusy('');
          setNote({ tone: 'danger', text: P.failText(error, '新建会话没有完成。') });
        });
    };

    // 宿主的目录选择器只负责「选一个目录并返回路径」，不替调用方切换工作区，
    // 所以这里先问一句，选完把真实路径摆出来，不声称宿主已经换了工作区。
    const pickDirectory = () => {
      if (!canPick || busy) return;
      if (typeof P.confirm === 'function'
        && !P.confirm('打开系统文件夹对话框？宿主的目录选择器只返回路径，不会自动切换或新建工作区。')) {
        return;
      }
      setBusy('pick');
      setNote(null);
      setPickError(null);
      Promise.resolve()
        .then(() => uiWorkspace.pickDirectory())
        .then((picked) => {
          setBusy('');
          const next = typeof picked === 'string' ? trimPath(picked) : '';
          if (!next) {
            setNote({ tone: 'info', text: '没有选择新的目录，工作区保持不变。' });
            return;
          }
          setPickedPath(next);
          setSelected(null);
          setBrowsePath(null);
          setTick((value) => value + 1);
          setNote({ tone: 'info', text: `已选择 ${next}；没改宿主工作区。` });
        }, (error) => {
          setBusy('');
          setPickError(error);
          setNote({ tone: 'warn', text: '没有选择目录，工作区保持不变。' });
        });
    };

    const canUsePick = canPick && mode !== 'absent';
    const pickTitle = !canPick
      ? `${NO_SERVICE}：宿主没有提供目录选择接口`
      : mode === 'browse'
        ? '这版宿主用面板内浏览能力，不弹系统对话框；换工作区请回宿主的会话侧栏'
        : mode === 'absent'
          ? `${NO_SERVICE}：按钮不可用`
          : '打开宿主自己的系统文件夹对话框（选完不会自动切换工作区）';

    const primaryAction = mode === 'native'
      ? h(ui.Button, {
        key: 'primary',
        variant: 'primary',
        onClick: pickDirectory,
        loading: busy === 'pick',
        disabled: !canPick || Boolean(busy),
        title: pickTitle,
      }, h(ui.Icon, { name: 'folder', size: 15 }), '选择目录…')
      : h(ui.Button, {
        key: 'primary',
        variant: 'primary',
        onClick: reload,
        loading: mode === 'probing',
        disabled: !canList,
        title: !canList ? `${NO_SERVICE}：读不到目录内容` : mode === 'error' ? '再读一次这个目录' : '重新读取当前目录',
      }, h(ui.Icon, { name: 'refresh', size: 15 }), mode === 'error' ? '重试' : '刷新');

    const probeState = mode === 'native'
      ? { state: 'warn', text: '目录浏览不可用（系统选择器）' }
      : mode === 'absent'
        ? { state: 'danger', text: '没有目录服务' }
        : mode === 'error'
          ? { state: 'danger', text: '目录浏览失败' }
          : mode === 'probing'
            ? { state: 'idle', text: '正在探测目录能力' }
            : { state: 'ok', text: '目录浏览可用' };

    const pathTitle = location.path || '宿主没有把真实路径交出来';

    const status = [
      h('span', { key: 'label', className: 'cpx-muted' }, `${location.label}：`),
      h('span', { key: 'path', className: 'cpxp-ws-path', title: pathTitle }, location.path || '—'),
      h('span', { key: 'sep', className: 'cpxp-ws-sep' }, '·'),
      h(ui.StateLine, { key: 'state', state: probeState.state, text: probeState.text }),
      listing.probedAt
        ? h(P.Fragment, { key: 'time' }, h('span', { className: 'cpxp-ws-sep' }, '·'), h(ui.Timestamp, { at: listing.probedAt, prefix: '探测于' }))
        : null,
    ];

    const upButton = h(ui.Button, {
      key: 'up',
      variant: 'ghost',
      size: 'sm',
      onClick: () => { if (parentPath !== null) goTo(parentPath); },
      disabled: parentPath === null,
      title: parentPath === null ? '已经在最上面一层' : `返回 ${parentPath || '宿主主目录'}`,
    }, '返回上级');

    const homeButton = mode === 'browse' && browsePath !== null
      ? h(ui.Button, {
        key: 'home',
        variant: 'ghost',
        size: 'sm',
        onClick: backToWorkspace,
        title: '回到宿主当前工作区路径',
      }, '回到工作区')
      : null;

    // native-only 的说明块：主文案一句，其余解释收进 ⓘ；不出现任何英文原始串。
    function renderNativeCallout() {
      return h(ui.Callout, {
        key: 'native',
        tone: 'warn',
        title: '当前桌面只能弹系统选择目录对话框',
        children: h('p', { key: 'where', className: 'cpxp-ws-note' },
          '要看文件请用宿主左侧栏的文件面板（Ctrl+P）。',
          info('这次宿主的目录能力组装成 native：它只会弹系统的「选择文件夹」对话框，没有把读取目录内容的接口交给插件。'
            + '所以这不是权限问题，也不是路径写错——同样的调用重试多少次都是同一个回答。')),
        action: h(ui.Button, {
          size: 'sm',
          onClick: openChat,
          disabled: !canChat,
          title: canChat ? '切到宿主原生聊天面板' : '宿主没有提供布局服务，无法切换面板',
        }, h(ui.Icon, { name: 'chat', size: 14 }), '回到聊天'),
      });
    }

    function renderDirectory() {
      if (mode === 'absent') {
        return h(ui.List, { label: '目录内容' }, h(ui.Row, {
          title: '目录内容',
          meta: `${NO_SERVICE}：没有 listDirectory 接口，这里不显示任何路径内容`,
          status: h(ui.StateLine, { state: 'danger', text: '不可用' }),
        }));
      }
      if (mode === 'native') return renderNativeCallout();
      if (mode === 'error') {
        return [
          h(ui.Callout, {
            key: 'dir-error',
            tone: 'warn',
            title: '目录没有读出来',
            children: humanReason(activeDiagnosis, activePath),
            action: h(ui.Button, { size: 'sm', onClick: reload }, '重试'),
          }),
          h(ui.Toolbar, { key: 'dir-error-actions', label: '其它入口' },
            h(ui.Button, {
              size: 'sm',
              onClick: () => goTo(''),
              title: '改从宿主的用户主目录读取（空路径在宿主那边就是主目录）',
            }, '从主目录读'),
            browsePath === null
              ? null
              : h(ui.Button, { size: 'sm', onClick: backToWorkspace, title: '回到宿主当前工作区路径' }, '回到工作区')),
        ];
      }
      if (mode === 'probing') {
        return [
          h(ui.Skeleton, { key: 'dir-skeleton', rows: 4 }),
          h('p', { key: 'dir-probing', className: 'cpxp-ws-note' }, '正在确认目录能力…'),
        ];
      }
      const entries = listing.data ? listing.data.entries : [];
      if (!entries.length) {
        return h(ui.Empty, { title: '这个目录里没有可进入的子目录' });
      }
      return [
        h(ui.List, { key: 'dir-list', label: '目录内容' }, entries.map((entry) => h(ui.Row, {
          key: entry.key,
          title: entry.name,
          meta: entry.kind === 'file'
            ? (entry.size === null ? '文件' : `文件 · ${fmt.bytes(entry.size)}`)
            : kindLabel(entry.kind),
          ariaLabel: `${entry.name}，${kindLabel(entry.kind)}`,
          onClick: () => { if (entry.kind === 'directory') goTo(entry.path); else setSelected(entry); },
        }))),
        listing.data && listing.data.truncated
          ? h(ui.Callout, {
            key: 'dir-truncated',
            tone: 'info',
            title: '列表被截断',
            children: '只返回了一部分条目，没有翻页。',
          })
          : null,
        h('p', { key: 'dir-note', className: 'cpxp-ws-note' }, '只读；不能删除或重命名。'),
      ];
    }

    const sessionList = h(ui.Callout, {
      tone: 'info',
      title: '本页不列会话清单',
      children: h('p', { key: 'where', className: 'cpxp-ws-note' },
        '会话列表在宿主的会话侧栏。',
        info('这一页不复制一份会话清单，也不读消息内容；打开或新建会话会直接切到宿主自己的聊天面板。')),
    });

    const newSession = h(ui.Button, {
      key: 'new-session',
      size: 'sm',
      onClick: startSession,
      loading: busy === 'start',
      disabled: !canStart || Boolean(busy),
      title: canStart ? '在宿主里新建一个空白会话，然后跳到聊天面板' : `${NO_SERVICE}：宿主没有提供新建会话的接口`,
    }, '新建会话');

    const backToChat = h(ui.Button, {
      key: 'back-to-chat',
      size: 'sm',
      onClick: openChat,
      disabled: !canChat,
      title: canChat ? '切到宿主原生聊天面板' : '宿主没有提供布局服务，无法切换面板',
    }, h(ui.Icon, { name: 'chat', size: 14 }), '回到聊天');

    const listCapability = mode === 'native'
      ? {
        state: 'warn',
        text: '不可用',
        meta: '宿主只交出系统选择器，没有读取接口',
      }
      : mode === 'absent'
        ? { state: 'idle', text: '未提供', meta: `${NO_SERVICE}：没有 listDirectory 接口` }
        : mode === 'error'
          ? { state: 'danger', text: '读取失败', meta: '探测报错了，可以重试' }
          : mode === 'probing'
            ? { state: 'idle', text: '检测中', meta: '正在确认' }
            : { state: 'ok', text: '可用', meta: '已经真实列过一次目录' };

    const pickCapability = !canPick
      ? { state: 'idle', text: '未提供', meta: `${NO_SERVICE}：宿主没有提供目录选择接口` }
      : mode === 'native'
        ? { state: 'ok', text: '可用（系统对话框）', meta: '弹系统文件夹对话框；选完只返回路径' }
        : mode === 'browse'
          ? { state: 'idle', text: '不可用', meta: '面板内浏览；换工作区在宿主侧栏' }
          : { state: 'idle', text: '未确认', meta: '是否弹对话框以实际结果为准' };

    const capabilityRows = [
      { key: 'list', title: '目录列表', meta: listCapability.meta, state: listCapability.state, text: listCapability.text },
      { key: 'pick', title: '目录选择器', meta: pickCapability.meta, state: pickCapability.state, text: pickCapability.text },
      {
        key: 'start',
        title: '新建会话',
        meta: '接口存在；点了会建空白会话',
        state: canStart ? 'ok' : 'idle',
        text: canStart ? '已提供' : '未提供',
      },
      {
        key: 'open',
        title: '打开会话',
        meta: '在宿主的会话侧栏打开',
        state: canOpen ? 'ok' : 'idle',
        text: canOpen ? '已提供' : '未提供',
      },
      {
        key: 'chat',
        title: '聊天面板',
        meta: '切回宿主原生对话',
        state: canChat ? 'ok' : 'idle',
        text: canChat ? '可用' : '不可用',
      },
    ];

    const probeVerdict = mode === 'native'
      ? '只提供系统选择器（native）'
      : mode === 'browse'
        ? '可浏览（listDirectory 成功）'
        : mode === 'error'
          ? `失败（${activeDiagnosis && activeDiagnosis.code ? activeDiagnosis.code : '未知码'}）`
          : mode === 'probing' ? '进行中' : '未探测（没有 listDirectory）';

    const page = h(ui.Page, { title: TITLE, lead: LEAD, status, actions: [primaryAction] },
      location.path
        ? null
        : h(ui.Callout, {
          key: 'no-path',
          tone: 'info',
          title: '拿不到当前工作区路径',
          children: h('p', { key: 'why', className: 'cpxp-ws-note' },
            '宿主没有交出真实路径。',
            info('这一页只读宿主 workspaces / sessions 的快照；两边都没有交出路径时显示 —，不猜磁盘位置，也不编一个笼统的标题。')),
        }),

      note
        ? h(ui.Callout, {
          key: 'note',
          tone: note.tone,
          title: note.tone === 'danger' ? '操作没有完成' : note.tone === 'ok' ? '已切换' : '提示',
          children: note.text,
          action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setNote(null) }, '知道了'),
        })
        : null,

      h(ui.Band, {
        key: 'directory',
        flush: true,
        title: '目录浏览',
        hint: mode === 'browse' ? '目录在前；只读' : '',
        actions: mode === 'browse' ? [upButton, homeButton].filter(Boolean) : undefined,
      },
      mode === 'browse'
        ? h(ui.Toolbar, { label: '目录路径' }, h('div', { className: 'cpxp-ws-crumbs' },
          crumbs.map((crumb, index) => {
            const current = index === crumbs.length - 1;
            return h(P.Fragment, { key: crumb.key },
              index > 0 ? h('span', { className: 'cpxp-ws-crumb-sep', 'aria-hidden': 'true' }, '/') : null,
              current
                ? h('span', {
                  className: 'cpxp-ws-crumb',
                  title: crumb.path || '宿主主目录',
                  'aria-current': 'true',
                }, crumb.label)
                : h('button', {
                  type: 'button',
                  className: 'cpxp-ws-crumb',
                  title: crumb.path,
                  onClick: () => goTo(crumb.path),
                }, crumb.label));
          })))
        : null,
      renderDirectory()),

      h(ui.Band, {
        key: 'sessions',
        title: '会话',
        actions: [newSession, backToChat],
      }, sessionList),

      h(ui.Band, {
        key: 'capabilities',
        title: '宿主能力',
        actions: [
          info('只有「目录列表」是本页真实探测出来的，其余只说明接口在不在；「已提供」不等于一定成功。'),
          // native-only 时页头主操作就是「选择目录…」，这里不重复放同一颗按钮。
          mode === 'native' ? null : h(ui.Button, {
            key: 'pick',
            size: 'sm',
            onClick: pickDirectory,
            loading: busy === 'pick',
            disabled: !canUsePick || Boolean(busy),
            title: pickTitle,
          }, '选择目录…'),
        ].filter(Boolean),
      }, h(ui.List, { label: '宿主能力探测' }, capabilityRows.map((capability) => h(ui.Row, {
        key: capability.key,
        title: capability.title,
        meta: capability.meta,
        status: h(ui.StateLine, { state: capability.state, text: capability.text }),
      })))),

      h(ui.Diagnostic, {
        key: 'diag',
        title: '高级诊断',
        hint: '宿主接口、探测结果与原始报错，只用于排查',
      },
      h(ui.KeyValue, {
        items: [
          { k: 'services.uiWorkspace', v: uiWorkspace ? '已注入' : '未注入', mono: true },
          { k: 'services.workspaces', v: services.workspaces ? '已注入' : '未注入', mono: true },
          { k: 'services.sessions', v: services.sessions ? '已注入' : '未注入', mono: true },
          { k: 'listDirectory', v: canList ? '函数' : '—', mono: true },
          { k: 'pickDirectory', v: canPick ? '函数' : '—', mono: true },
          { k: 'startSession', v: canStart ? '函数' : '—', mono: true },
          { k: 'openSession', v: canOpen ? '函数' : '—', mono: true },
          { k: '目录探测', v: probeVerdict, mono: true, breakable: true },
          { k: '探测目标', v: activePath || '（宿主主目录）', mono: true, breakable: true },
          { k: 'rpc 码', v: activeDiagnosis && activeDiagnosis.code ? activeDiagnosis.code : '—', mono: true },
          { k: 'rpc 能力', v: activeDiagnosis && activeDiagnosis.capability ? activeDiagnosis.capability : '—', mono: true },
          { k: '原始报错', v: activeDiagnosis && activeDiagnosis.message ? activeDiagnosis.message : '—', mono: true, breakable: true },
          { k: '选择器报错', v: pickError ? P.failText(pickError, '—') : '—', mono: true, breakable: true },
          { k: '路径来源', v: `${location.label}（${location.source}）`, mono: true, breakable: true },
          { k: '工作区标题', v: location.title || '—', mono: true, breakable: true },
          { k: '刚选择的目录', v: pickedPath || '—', mono: true, breakable: true },
          { k: 'nav.selectPanel', v: canChat ? '可用' : '不可用', mono: true },
        ],
      }),
      h(ui.Pre, { maxHeight: 200 }, JSON.stringify({
        mode,
        browsing: activePath || '',
        entries: listing.data ? listing.data.entries.length : 0,
        truncated: Boolean(listing.data && listing.data.truncated),
        nativeOnly,
        capability: activeDiagnosis && activeDiagnosis.capability ? activeDiagnosis.capability : '',
        code: activeDiagnosis && activeDiagnosis.code ? activeDiagnosis.code : '',
        probedAt: listing.probedAt || null,
      }, null, 2))));

    const sheet = selected ? h(ui.Sheet, {
      open: true,
      title: selected.name,
      subtitle: `${kindLabel(selected.kind)}${selected.size === null ? '' : ` · ${fmt.bytes(selected.size)}`}`,
      onClose: closeSheet,
      footer: h(ui.Button, { size: 'sm', onClick: closeSheet }, '关闭'),
    }, h('div', { className: 'cpxp-ws-sheet' },
      h(ui.KeyValue, {
        items: [
          {
            k: '路径',
            v: h('span', { className: 'cpxp-ws-path', title: selected.path }, selected.path || '—'),
          },
          { k: '类型', v: kindLabel(selected.kind) },
          { k: '大小', v: selected.size === null ? '—' : fmt.bytes(selected.size) },
          {
            k: '修改时间',
            v: selected.modifiedAt ? h(ui.Timestamp, { at: selected.modifiedAt }) : '—',
          },
        ],
      }),
      selected.modifiedAt
        ? null
        : h(ui.Callout, {
          tone: 'info',
          title: '没有修改时间',
          children: '宿主列表没有带修改时间。',
        }),
      h(ui.Callout, {
        tone: 'info',
        title: '只读信息',
        children: h('p', { key: 'why', className: 'cpxp-ws-note' },
          '只有元数据。',
          info('这里不读取文件内容，也不打开文件。')),
      }))) : null;

    return h(P.Fragment, null, page, sheet);
  }

  P.registerPage({ id: 'workspace', label: TITLE, order: 64, component: WorkspacePage });
})(P);
