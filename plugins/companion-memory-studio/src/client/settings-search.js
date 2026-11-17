(function (P) {
  // 计划 W1-3 / W1-4：跨设置项搜索面板。
  //
  // 只有一条数据来源：服务端 `GET /settings-catalog`。它把 QQ schema 与 Studio spec 投影成
  // 一份目录（见 lib/settings-catalog.mjs），因此这里**不再维护字段清单**——前端只负责
  // 键盘交互、结果渲染与深链聚焦。
  //
  // 深链约定：
  //   `studio:settings` → 本包设置页，按结果里的 `path` 聚焦并高亮对应行
  //   `qq:<page>`       → 该字段属于 QQ 原生后台；这里只索引，不代改
  // 聚焦用 `data-field-path` 定位，因为输入控件的 aria-label 是中文标签而不是键路径。

  const { h, ui } = P;
  const api = P.api;
  const useState = P.useState;
  const useEffect = P.useEffect;
  const useRef = P.useRef;

  P.css(`
    .cpx-cat { position: relative; }
    .cpx-cat-trigger { display: inline-flex; align-items: center; gap: 8px; padding: 0 12px; height: 32px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-secondary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; }
    .cpx-cat-trigger:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-primary); }
    .cpx-cat-trigger kbd { font: 11px/1 var(--cpx-mono); padding: 3px 5px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-secondary); color: var(--dsw-alias-label-tertiary); }
    .cpx-cat-overlay { position: fixed; inset: 0; z-index: 120; display: flex; align-items: flex-start; justify-content: center; padding: 12vh 16px 16px; }
    /* 暗色背景与"点外面关闭"都在这一层：绝对定位铺满视口，所以它真的能被点到。
       之前它是个没有 CSS 规则的零宽度 div，onClick 挂在它身上等于点不到（N9）。 */
    .cpx-cat-backdrop { position: absolute; inset: 0; background: color-mix(in srgb, var(--dsw-alias-bg-inverse, #000) 38%, transparent); }
    .cpx-cat-panel { position: relative; width: min(760px, 100%); max-height: 70vh; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-secondary); border-radius: 14px; box-shadow: 0 24px 64px color-mix(in srgb, var(--dsw-alias-bg-inverse, #000) 45%, transparent); overflow: hidden; }
    .cpx-cat-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-secondary); }
    .cpx-cat-input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 15px; border-radius: 6px; }
    .cpx-cat-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
    .cpx-cat-panel:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
    .cpx-cat-list { overflow: auto; overscroll-behavior: contain; padding: 6px; }
    .cpx-cat-group { padding: 10px 10px 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; letter-spacing: .04em; }
    .cpx-cat-item { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 4px 12px; width: 100%; text-align: left; padding: 10px 12px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
    .cpx-cat-item[data-active="true"] { background: var(--dsw-alias-bg-layer-2); }
    .cpx-cat-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
    .cpx-cat-name { color: var(--dsw-alias-label-primary); font-size: 13.5px; overflow-wrap: anywhere; }
    .cpx-cat-path { color: var(--dsw-alias-label-tertiary); font: 11.5px/1.6 var(--cpx-mono); overflow-wrap: anywhere; }
    .cpx-cat-side { display: flex; align-items: center; gap: 6px; grid-row: 1 / span 2; }
    .cpx-cat-empty { padding: 28px 18px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
    .cpx-cat-foot { display: flex; gap: 14px; padding: 8px 16px; border-top: 1px solid var(--dsw-alias-border-secondary); color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
    .cpx-cat-focus { animation: cpx-cat-pulse 1.6s ease-out 1; }
    @keyframes cpx-cat-pulse { 0%,40% { box-shadow: 0 0 0 2px var(--dsw-alias-warning, #d8a653); } 100% { box-shadow: 0 0 0 2px transparent; } }
    @media (prefers-reduced-motion: reduce) { .cpx-cat-focus { animation: none; outline: 2px solid var(--dsw-alias-warning, #d8a653); outline-offset: 2px; } }
    @media (max-width: 760px) { .cpx-cat-overlay { padding-top: 4vh; } .cpx-cat-panel { max-height: 84vh; } }
  `);

  // 状态词的中文与色调：只表达目录能证明的事，不猜运行态。
  const STATUS_LABEL = {
    default: '默认值',
    configured: '已配置',
    'secret-set': '已设置',
    'secret-unset': '未设置',
    unknown: '未知',
    unavailable: '未装载',
  };
  const STATUS_TONE = {
    configured: 'ok', 'secret-set': 'ok', default: 'neutral',
    unknown: 'warn', 'secret-unset': 'neutral', unavailable: 'danger',
  };
  const HOT_LABEL = { live: '立即生效', reload: '重连生效', restart: '需重启' };

  /** 深链：按 `path` 在设置页里聚焦对应控件。 */
  function focusSetting(path) {
    if (!path) return false;
    const escaped = String(path).replace(/["\\]/g, '\\$&');
    const node = document.querySelector(`[data-field-path="${escaped}"]`);
    if (!node) return false;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('cpx-cat-focus');
    const input = node.querySelector('input, select, textarea, button');
    if (input) input.focus({ preventScroll: true });
    setTimeout(() => node.classList.remove('cpx-cat-focus'), 2000);
    return true;
  }

  function CatalogPanel({ onClose }) {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [debounced, setDebounced] = useState('');
    const inputRef = useRef(null);
    const listRef = useRef(null);
    const panelRef = useRef(null);

    // 输入抖动：200ms 足够挡住连打，又不至于让搜索看起来卡。
    useEffect(() => {
      const timer = setTimeout(() => setDebounced(query), 200);
      return () => clearTimeout(timer);
    }, [query]);

    const state = P.useApi(
      () => api.get('settings-catalog', { q: debounced, limit: 60 }),
      [debounced],
    );

    useEffect(() => {
      if (inputRef.current) inputRef.current.focus();
      // 卸载时把焦点还给打开它的那个控件（Esc / 「关闭」/ 点外面三条路径都会走到这里）。
      // 不这么做，键盘用户关掉面板后焦点掉回文档开头 —— H4 承诺的就是这一条（N2）。
      return () => {
        const opener = openerRef.current;
        if (!opener || typeof opener.focus !== 'function') return;
        // `document.contains` 在真实 DOM 里判"控件还在"；宿主/测试环境可能没有这个 API，
        // 那就直接尝试聚焦（focus() 自己会对已脱离文档的元素安全地不生效）。
        const stillThere = typeof document === 'undefined' || typeof document.contains !== 'function'
          ? true
          : document.contains(opener);
        if (!stillThere) return;
        try { opener.focus(); } catch { /* 控件已不在 */ }
      };
    }, []);
    useEffect(() => { setActive(0); }, [debounced]);

    const matches = (state.data && state.data.matches) || [];
    const catalog = (state.data && state.data.catalog) || null;

    // 键盘上下移动时把当前项滚进可视区（长列表里否则看不见选中项）。
    useEffect(() => {
      const list = listRef.current;
      if (!list) return;
      const node = list.querySelector('[data-active="true"]');
      if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const choose = (match) => {
      if (!match) return;
      onClose();
      if (match.deepLink === 'studio:settings') {
        if (typeof P.nav === 'object' && P.nav && typeof P.nav.go === 'function') P.nav.go('settings');
        // 切页是同步的（nav.go 直接改 state），下一帧再聚焦。
        setTimeout(() => {
          if (!focusSetting(match.path) && typeof P.toastOnce === 'function') {
            P.toastOnce(`「${match.label}」在本页没有可聚焦的控件（可能尚未装载）。`);
          }
        }, 60);
        return;
      }
      if (typeof match.deepLink === 'string' && match.deepLink.indexOf('qq:') === 0) {
        if (typeof P.toastOnce === 'function') {
          P.toastOnce(`「${match.label}」属于 QQ 原生后台（${match.deepLink.slice(3)}），这里只索引不代改。`);
        }
        return;
      }
      if (typeof P.toastOnce === 'function') P.toastOnce(`「${match.label}」没有可跳转的入口。`);
    };

    // Tab 焦点陷阱：模态面板里 Tab 不能走到背景（背景那时对辅助技术仍可见，
    // 但焦点跑出去就等于"对话框只是视觉上的"）。
    const trapTab = (event) => {
      if (event.key !== 'Tab' || !panelRef.current) return false;
      const focusables = panelRef.current.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables.length) return false;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); return true; }
      if (event.shiftKey && (current === first || !panelRef.current.contains(current))) {
        event.preventDefault();
        last.focus();
        return true;
      }
      return false;
    };

    // **只挂一处**（dialog 上），并且用 `defaultPrevented` 挡住重复执行。
    //
    // 之前同一个函数同时挂在 dialog 与 overlay 上：input 里按一次键会冒泡经过两层，
    // 于是 ArrowDown 一次走两格、Enter 调两次 choose()、Tab 陷阱一次跳两个控件（N3）。
    // 现在 overlay 不再挂 onKeyDown（见下），这里再加一道 defaultPrevented 守卫，
    // 覆盖"将来有人又挂第二处"的情况。
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (trapTab(event)) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(value + 1, matches.length - 1)); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); return; }
      if (event.key === 'Enter') { event.preventDefault(); choose(matches[active]); }
    };

    const grouped = [];
    for (const match of matches) {
      const label = match.category || '其他';
      const last = grouped[grouped.length - 1];
      if (last && last.label === label) last.items.push(match);
      else grouped.push({ label, items: [match] });
    }
    let indexCursor = 0;

    // 遮罩与面板是**兄弟**，不是父子。
    //
    // 旧版把 role="dialog" 放在 aria-hidden="true" 的遮罩子树里：按 ARIA，整棵子树的语义
    // 被移出无障碍树，屏幕阅读器**看不到**这个模态面板。装饰性的"点外面关掉"只能自己
    // 带 aria-hidden，不能把面板一起盖住。
    const dialogNode = h('div', {
      className: 'cpx-cat-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '搜索设置项',
      tabIndex: -1,
      ref: panelRef,
      onKeyDown,
    },
        h('div', { className: 'cpx-cat-head' },
          h(ui.Icon, { name: 'search', size: 16 }),
          h('input', {
            ref: inputRef,
            className: 'cpx-cat-input',
            type: 'search',
            value: query,
            placeholder: '搜索设置：中文名、配置键、模块名（如 回复概率 / flood / 语音）',
            'aria-label': '搜索设置项',
            'aria-controls': 'cpx-cat-list',
            'aria-activedescendant': matches[active] ? `cpx-cat-item-${active}` : undefined,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(ui.Button, { key: 'close', variant: 'ghost', size: 'sm', onClick: onClose }, '关闭'),
        ),
        state.error
          ? h('div', { className: 'cpx-cat-empty' }, h(ui.ErrorBox, { error: state.error, onRetry: state.reload }))
          : null,
        !state.error && state.loading && !state.data
          ? h('div', { className: 'cpx-cat-empty' }, '正在读取字段目录…')
          : null,
        !state.error && state.data && !matches.length
          ? h('div', { className: 'cpx-cat-empty' },
            h('div', null, query ? `没有匹配「${query}」的设置项。` : '当前没有任何可用的设置项。'),
            catalog && catalog.sources
              ? h('div', { style: { marginTop: '10px' } },
                catalog.sources.map((source) => h('div', { key: source.source, className: 'cpx-cat-path' },
                  `${source.source}：${source.status}${source.reason ? `（${source.reason}）` : ''}`)))
              : null)
          : null,
        matches.length
          ? h('div', {
            className: 'cpx-cat-list',
            id: 'cpx-cat-list',
            ref: listRef,
            role: 'listbox',
            'aria-label': '设置项结果',
          },
            grouped.map((group) => h('div', { key: group.label },
              h('div', { className: 'cpx-cat-group' }, group.label),
              group.items.map((match) => {
                const index = indexCursor++;
                return h('button', {
                  key: match.id,
                  id: `cpx-cat-item-${index}`,
                  type: 'button',
                  role: 'option',
                  'aria-selected': index === active,
                  className: 'cpx-cat-item',
                  'data-active': index === active ? 'true' : 'false',
                  'data-field-path': match.path,
                  onClick: () => choose(match),
                  onMouseEnter: () => setActive(index),
                },
                  h('span', { className: 'cpx-cat-name' }, match.label),
                  h('span', { className: 'cpx-cat-path' }, match.path),
                  h('span', { className: 'cpx-cat-side' },
                    match.hotLevel !== 'live'
                      ? h(ui.Badge, { tone: match.hotLevel === 'restart' ? 'warn' : 'neutral' }, HOT_LABEL[match.hotLevel] || match.hotLevel)
                      : null,
                    h(ui.Badge, { tone: STATUS_TONE[match.status] || 'neutral' }, STATUS_LABEL[match.status] || match.status),
                    match.permission === 'host' ? h(ui.Badge, { tone: 'neutral' }, '宿主权限') : null),
                );
              }))))
          : null,
        h('div', { className: 'cpx-cat-foot' },
          h('span', null, '↑↓ 选择 · Enter 打开 · Esc 关闭'),
          state.data ? h('span', null, `${state.data.returned}/${state.data.total} 条`) : null,
          catalog ? h('span', null, `字段 ${catalog.totalFields}`) : null),
    );
    // 三层分工，各自只有一件事：
    //   overlay  —— 纯布局容器（fixed 全屏 + flex 居中），不挂任何处理器；
    //   backdrop —— 铺满视口的装饰层，承载暗色背景与"点外面关闭"（键盘等价是 Esc）；
    //   panel    —— 模态面板，键盘交互只在这里处理（onKeyDown 全树仅此一处）。
    //
    // 之前 onClick 挂在一个没有 CSS 规则的零宽度 div 上，于是点暗色区关不掉（N9）；
    // 而 onKeyDown 同时挂在 overlay 与 panel 上，一次按键执行两遍（N3）。
    return h('div', { className: 'cpx-cat-overlay' },
      h('div', {
        key: 'backdrop',
        className: 'cpx-cat-backdrop',
        'aria-hidden': 'true',
        onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
      }),
      dialogNode);
  }

  /**
   * 面板开关是**模块级可订阅状态**：全局挂载点与各页触发器共享同一个开关，
   * 因此从任何页面按 Ctrl/⌘+K 打开的都是同一块面板（不是每页各自一份）。
   */
  const catalogState = {
    open: false,
    listeners: new Set(),
    set(next) {
      const value = Boolean(next);
      if (catalogState.open === value) return;
      catalogState.open = value;
      catalogState.listeners.forEach((listener) => {
        try { listener(value); } catch { /* 忽略 */ }
      });
    },
    subscribe(listener) {
      catalogState.listeners.add(listener);
      return () => {
        catalogState.listeners.forEach((item) => {
          if (item === listener) catalogState.listeners.delete(item);
        });
      };
    },
  };

  /** 打开面板的那个控件：关闭时要把焦点还回去（键盘用户不该掉到文档开头）。 */
  const openerRef = { current: null };

  const closeCatalog = () => catalogState.set(false);

  /**
   * 全局快捷键。
   *
   * 只有**全局挂载点**注册监听：它随页面壳一直活着，所以"任何页面都能按"成立。
   * 页面内的触发器不再各自注册 —— 两个实例各注册一次虽然被 `set` 的幂等守卫挡住，
   * 但那是"碰巧不重复"，不是"只有一处"。
   */
  function useGlobalShortcut(enabled) {
    useEffect(() => {
      if (!enabled) return undefined;
      const listener = (event) => {
        const isAccel = (event.ctrlKey || event.metaKey) && !event.altKey
          && String(event.key).toLowerCase() === 'k';
        if (!isAccel) return;
        const target = event.target;
        const typing = target && (target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (typing) return;
        event.preventDefault();
        openerRef.current = target && typeof target.focus === 'function' ? target : null;
        catalogState.set(true);
      };
      window.addEventListener('keydown', listener);
      return () => window.removeEventListener('keydown', listener);
    }, [enabled]);
  }

  /**
   * 触发器按钮（各页可放一份）。
   *
   * **只渲染按钮，不渲染面板**：面板由页面壳上的全局挂载点渲染唯一一份。
   * 否则设置页会同时出现两块 role=dialog（N1）。
   */
  function SettingsSearchTrigger({ compact }) {
    const [open, setOpenState] = useState(catalogState.open);

    useEffect(() => catalogState.subscribe((next) => setOpenState(next)), []);

    return h('div', { className: 'cpx-cat' },
      h('button', {
        type: 'button',
        className: 'cpx-cat-trigger',
        onClick: (event) => {
          openerRef.current = event && event.currentTarget ? event.currentTarget : null;
          catalogState.set(true);
        },
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        title: '搜索所有设置项（含 QQ 字段）',
      },
        h(ui.Icon, { name: 'search', size: 14 }),
        compact ? null : h('span', null, '搜索设置'),
        compact ? null : h('kbd', null, 'Ctrl K')));
  }

  /**
   * 全局挂载点：**只渲染面板**（外加注册全局快捷键），不渲染按钮。
   *
   * 由 `core.js:2206` 的页面壳渲染一次，因此：
   *   - 任何页面按 Ctrl/⌘+K 都能打开同一块面板；
   *   - DOM 里永远最多只有一个 `role="dialog"`（N1 的回归点）。
   */
  function SettingsSearchHost() {
    const [open, setOpenState] = useState(catalogState.open);

    useEffect(() => catalogState.subscribe((next) => setOpenState(next)), []);
    useGlobalShortcut(true);

    return open ? h(CatalogPanel, { onClose: closeCatalog }) : null;
  }

  P.ui.SettingsSearch = SettingsSearchTrigger;
  P.ui.SettingsSearchHost = SettingsSearchHost;
  P.focusSetting = focusSetting;
})(P);
