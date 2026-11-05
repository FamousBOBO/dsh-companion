// 本文件由 scripts/build-client.mjs 生成，请勿手改。
// package: @dsh-companion/memory-studio
// 片段顺序与契约 design/studio/ARCHITECTURE.md §5.1 一致；改动片段后请重新运行拼装。
// 生成的运行时只依赖浏览器模块表里的 react，不引入 CDN / UMD。
window.__ModuleLoader__.load({
  id: '@dsh-companion/memory-studio',
  factory(require) {
    const React = require('react');

// ==== src/client/core.js ====
// Client half of the companion bundle. Only `scripts/build-client.mjs` composes
// this file into the browser artifact: it is a plain script, so no JSX, no
// imports and no module syntax.
//
// P is the shared surface every page uses: primitives, API access, theme
// plumbing, navigation and the UI kit. Pages must not reach for anything else.
//
// Layout of this file:
//   1. P surface + page registry
//   2. theme / navigation / host-service plumbing
//   3. formatting + API access + hooks
//   4. icons + UI kit
//   5. styles (host tokens + product shell)
//   6. shell component + chat strip
//   7. locale + apply

const P = {};
P.React = React;
P.h = React.createElement;
P.Fragment = React.Fragment;
P.useState = React.useState;
P.useEffect = React.useEffect;
P.useMemo = React.useMemo;
P.useRef = React.useRef;
P.useCallback = React.useCallback;
P.useId = React.useId || (() => Math.random().toString(36).slice(2));

const h = P.h;
const NS = 'companionMemoryStudio';
const PANEL_ID = 'companion-memory';
const PRODUCT = '陪伴空间';
const TZ = 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// 1. Registry
// ---------------------------------------------------------------------------

P._styles = [];
P.css = (text) => {
  if (typeof text === 'string' && text.trim()) P._styles.push(text);
};

P.pages = [];
P.registerPage = (definition) => {
  if (!definition || typeof definition.id !== 'string') return;
  const entry = {
    id: definition.id,
    label: definition.label || definition.id,
    order: typeof definition.order === 'number' ? definition.order : 100,
    component: definition.component,
  };
  const existing = P.pages.findIndex((page) => page.id === entry.id);
  if (existing >= 0) P.pages[existing] = entry;
  else P.pages.push(entry);
};

// The seven first-level entries of the product. A group entry owns tabs, each tab
// is a registered page; `chat` is not a page of this plugin at all.
const NAV = [
  { id: 'home', label: '陪伴首页', icon: 'home', hint: '她现在的生活与最近一起经历的事' },
  { id: 'chat', label: '聊天', icon: 'chat', hint: '回到宿主原生对话', native: 'conversation' },
  { id: 'life', label: '生活与日程', icon: 'calendar', hint: '今天、接下来，以及她的计划' },
  { id: 'memory', label: '记忆与档案', icon: 'book', hint: '记忆库、Wiki、时间线与待核对', tabs: ['vault', 'wiki', 'timeline', 'review'] },
  { id: 'connections', label: '连接与工具', icon: 'plug', hint: '通道与媒体能力的真实状态' },
  { id: 'workspace', label: '工作区', icon: 'folder', hint: '回到文件、会话与开发现场' },
  { id: 'settings', label: '设置', icon: 'sliders', hint: '外观、角色、模型与记忆', tabs: ['settings', 'overview', 'microscope'] },
];

// ---------------------------------------------------------------------------
// 2. Local storage, theme, navigation, host services
// ---------------------------------------------------------------------------

function readStore(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
}

const themeListeners = new Set();
P.theme = {
  snapshot: null,
  subscribe(listener) {
    themeListeners.add(listener);
    return () => { themeListeners.delete(listener); };
  },
  /** Adopt a snapshot pushed by the host theme service (and notify the UI). */
  accept(snapshot) {
    P.theme.snapshot = snapshot;
    themeListeners.forEach((listener) => { try { listener(snapshot); } catch { /* ignore */ } });
  },
  /** Current preference: `system` | `light` | `dark`. */
  preference() {
    const snapshot = P.theme.snapshot;
    if (!snapshot) return readStore('cpx.theme', 'system');
    return snapshot.preference || 'system';
  },
  /** Whether the resolved palette is dark right now. */
  dark() {
    const snapshot = P.theme.snapshot;
    if (snapshot && snapshot.active) return snapshot.active.colorScheme === 'dark';
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
  },
  /**
   * Switch the theme. The host theme service owns durable persistence; when it is
   * absent (reduced composition) the local choice still repaints the UI.
   */
  set(id) {
    writeStore('cpx.theme', id);
    P.theme.accept({ ...(P.theme.snapshot || {}), preference: id });
    const service = P.services.theme;
    if (!service || typeof service.setTheme !== 'function') return false;
    try { service.setTheme(id); return true; } catch { return false; }
  },
};

P.services = { theme: null, layout: null, uiWorkspace: null, sessions: null, workspaces: null };

// 宿主全局会话侧栏的"临时收起"。宿主在 DOM 上留 data-sidebar-collapsed 标记；
// 我们只借用它的 toggle，离开面板时按进来时的状态恢复，绝不替用户永久改布局。
function hostSidebarCollapsed() {
  try {
    if (typeof document === 'undefined') return false;
    if (document.querySelector('[data-sidebar-collapsed]')) return true;
    return false;
  } catch {
    return false;
  }
}

P.hostLayout = {
  canToggle() {
    return Boolean(P.services.layout && typeof P.services.layout.toggleSidebar === 'function');
  },
  collapsed() {
    return hostSidebarCollapsed();
  },
  /** 只在宿主侧栏展开时收起；返回"这次是否由我们收起"。 */
  collapse() {
    if (!P.hostLayout.canToggle()) return false;
    if (P.hostLayout.collapsed()) return false;
    try { P.services.layout.toggleSidebar(); return true; } catch { return false; }
  },
  /** 把我们收起的侧栏还原。 */
  restore() {
    if (!P.hostLayout.canToggle()) return false;
    if (!P.hostLayout.collapsed()) return false;
    try { P.services.layout.toggleSidebar(); return true; } catch { return false; }
  },
};

// Current page id, kept here so pages can read it without prop plumbing.
const navState = { page: 'home', listeners: new Set() };
P.nav = {
  go(pageId) {
    if (typeof pageId !== 'string' || !pageId) return;
    navState.page = pageId;
    writeStore('cpx.page', pageId);
    navState.listeners.forEach((listener) => { try { listener(pageId); } catch { /* ignore */ } });
  },
  current() {
    return navState.page;
  },
  subscribe(listener) {
    navState.listeners.add(listener);
    return () => { navState.listeners.delete(listener); };
  },
  /** Switch the host to one of its own panels (for example the native chat). */
  openPanel(panelId) {
    const layout = P.services.layout;
    if (!layout || typeof layout.selectPanel !== 'function') return false;
    try { layout.selectPanel(panelId); return true; } catch { return false; }
  },
  /** Whether the host navigation service is available in this composition. */
  canOpenPanel() {
    return Boolean(P.services.layout && typeof P.services.layout.selectPanel === 'function');
  },
};

// ---------------------------------------------------------------------------
// 3. Formatting
// ---------------------------------------------------------------------------

const pad = (value) => String(value).padStart(2, '0');

// Accepts an ISO string, epoch milliseconds (records store integers), or a Date.
function safeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{10,}$/.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? new Date(numeric) : null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 10000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

P.fmt = {
  number: formatNumber,
  percent: (value) => (typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : '—'),
  clock: (iso) => {
    const date = safeDate(iso);
    if (!date) return '—';
    return date.toLocaleTimeString('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  },
  /** `14:00–15:30`, with the date kept when the two ends are not the same day. */
  range: (start, end) => {
    const from = safeDate(start);
    const to = safeDate(end);
    if (!from || !to) return '—';
    const sameDay = from.getFullYear() === to.getFullYear()
      && from.getMonth() === to.getMonth() && from.getDate() === to.getDate();
    const head = P.fmt.clock(from);
    const tail = sameDay ? P.fmt.clock(to) : `${P.fmt.day(to)} ${P.fmt.clock(to)}`;
    return `${head}–${tail}`;
  },
  time: (iso) => {
    const date = safeDate(iso);
    if (!date) return iso ? String(iso) : '—';
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${date.toLocaleTimeString('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' })}`;
  },
  dateTime: (iso) => {
    const date = safeDate(iso);
    if (!date) return iso ? String(iso) : '—';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${date.toLocaleTimeString('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' })}`;
  },
  day: (iso) => {
    const date = safeDate(iso);
    if (!date) return '—';
    const today = new Date();
    const sameDay = (left, right) => left.getFullYear() === right.getFullYear()
      && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
    if (sameDay(date, today)) return '今天';
    const yesterday = new Date(today.getTime() - 86400000);
    if (sameDay(date, yesterday)) return '昨天';
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  },
  relative: (iso) => {
    const date = safeDate(iso);
    if (!date) return iso ? String(iso) : '—';
    const delta = Date.now() - date.getTime();
    if (delta < 0) {
      const ahead = -delta;
      if (ahead < 60_000) return '稍后';
      if (ahead < 3_600_000) return `${Math.floor(ahead / 60_000)} 分钟后`;
      if (ahead < 86_400_000) return `${Math.floor(ahead / 3_600_000)} 小时后`;
      return P.fmt.dateTime(iso);
    }
    if (delta < 60_000) return '刚刚';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
    if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
    return P.fmt.dateTime(iso);
  },
  bytes: (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  },
  /** `—` for anything unknown, so a page never shows a fake zero. */
  orDash: (value) => (value === null || value === undefined || value === '' || (typeof value === 'number' && !Number.isFinite(value)) ? '—' : value),
  yesNo: (value) => (value === null || value === undefined ? '未知' : value ? '是' : '否'),
};

P.classes = (...parts) => parts.filter((part) => typeof part === 'string' && part.trim()).join(' ');

// ---------------------------------------------------------------------------
// API access (the Connection carrier authenticates /api for us)
// ---------------------------------------------------------------------------

function apiBase() {
  try {
    return new URL('api/companion-memory/', document.baseURI).href;
  } catch {
    return '/api/companion-memory/';
  }
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
P.ApiError = ApiError;

function withQuery(path, params) {
  if (!params) return path;
  const search = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  if (!search) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${search}`;
}

async function request(path, init) {
  const url = apiBase() + String(path).replace(/^\/+/, '');
  let response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init && init.body ? { 'content-type': 'application/json' } : {}),
        ...(init && init.headers ? init.headers : {}),
      },
    });
  } catch (error) {
    throw new ApiError('无法连接宿主（桌面可能已关闭）。', 0, 'network');
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`接口返回不是 JSON（HTTP ${response.status}）。`, response.status, 'bad-response');
  }
  if (!body || body.ok !== true) {
    const message = (body && body.error && body.error.message) || `请求失败（HTTP ${response.status}）。`;
    throw new ApiError(message, response.status, body && body.error ? body.error.code : 'unknown');
  }
  return body.data;
}

P.api = {
  get: (path, params) => request(withQuery(path, params), { method: 'GET' }),
  post: (path, payload) => request(path, { method: 'POST', body: JSON.stringify(payload || {}) }),
  raw: request,
};

// Generic data hook: the loader runs on every dependency change and can be
// replayed through reload().
P.useApi = (loader, deps, options) => {
  const list = deps || [];
  const [state, setState] = React.useState({ data: null, error: null, loading: true });
  const [tick, setTick] = React.useState(0);
  const seq = React.useRef(0);
  const enabled = !options || options.enabled !== false;
  React.useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return undefined;
    }
    let cancelled = false;
    const id = ++seq.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    Promise.resolve()
      .then(loader)
      .then(
        (data) => { if (!cancelled && id === seq.current) setState({ data, error: null, loading: false }); },
        (error) => { if (!cancelled && id === seq.current) setState({ data: null, error, loading: false }); },
      );
    return () => { cancelled = true; };
  }, [...list, tick, enabled]);
  return {
    ...state,
    reload: () => setTick((value) => value + 1),
    setData: (data) => setState({ data, error: null, loading: false }),
  };
};

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

// One toast channel for the whole product: the shell owns the only ToastHost, so
// a page-level push has to travel to it instead of rendering its own overlay.
const noticeListeners = new Set();

P.notice = (text, tone) => {
  const notice = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text: String(text ?? ''),
    tone: tone || 'neutral',
  };
  noticeListeners.forEach((listener) => { try { listener(notice); } catch { /* ignore */ } });
};
P.toastOnce = P.notice;

/** Kept for call sites written against the old per-page host. */
P.useToast = () => ({
  toasts: [],
  dismiss: () => {},
  push: (text, tone) => P.notice(text, tone),
});

/** Readable failure text: never a bare stack, always a reason plus the code. */
P.failText = (error, fallback) => {
  if (!error) return fallback || '操作没有完成。';
  const message = error.message || String(error);
  const code = error.code && error.code !== 'unknown' ? `（${error.code}）` : '';
  return `${message}${code}`;
};

P.confirm = (message) => {
  try {
    return window.confirm(message);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// 4. Icons (original line marks, 1.5 stroke, currentColor)
// ---------------------------------------------------------------------------

const ICON_PATHS = {
  home: ['M3.4 10.6 12 3.8l8.6 6.8', 'M5.6 9.8V20h12.8V9.8', 'M10 20v-4.6h4V20'],
  chat: ['M4 5.6h16v10.2H9.4L4.8 19v-13.4z'],
  calendar: ['M4.2 6.6h15.6v13.2H4.2z', 'M4.2 10.4h15.6', 'M8.4 4.2v3.6', 'M15.6 4.2v3.6'],
  book: ['M5 4.6h6.2a2.2 2.2 0 0 1 2.2 2.2V20a2.6 2.6 0 0 0-2.6-2.4H5z', 'M19 4.6h-4.2a2.6 2.6 0 0 0-2.6 2.6V20a2.6 2.6 0 0 1 2.6-2.4H19z'],
  plug: ['M9 3.6v5', 'M15 3.6v5', 'M6.4 8.6h11.2v3.2a5.6 5.6 0 0 1-5.6 5.6 5.6 5.6 0 0 1-5.6-5.6z', 'M12 17.4V20.4'],
  folder: ['M3.8 6.6h6l1.8 2.2h8.6v10.6H3.8z'],
  sliders: ['M4.4 8.2h15.2', 'M4.4 15.8h15.2', 'M9.2 5.6v5.2', 'M15.4 13.2v5.2'],
  close: ['M6.4 6.4 17.6 17.6', 'M17.6 6.4 6.4 17.6'],
  menu: ['M4.4 7.2h15.2', 'M4.4 12h15.2', 'M4.4 16.8h15.2'],
  panel: ['M3.6 5.4h16.8v13.2H3.6z', 'M9.8 5.4v13.2', 'M12.8 9.2h5.2', 'M12.8 12.4h5.2'],
  chevron: ['M9.6 6.4 15.2 12l-5.6 5.6'],
  collapse: ['M14 6.4 8.4 12 14 17.6', 'M18.6 5.4v13.2'],
  expand: ['M10 6.4 15.6 12 10 17.6', 'M5.4 5.4v13.2'],
  refresh: ['M19 12a7 7 0 1 1-2.4-5.3', 'M19.4 4.6v4.2h-4.2'],
  system: ['M4.4 5.6h15.2v9.2H4.4z', 'M9 18.4h6', 'M12 14.8v3.6'],
  sun: ['M12 7.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8z', 'M12 3.6v1.8', 'M12 18.6v1.8', 'M3.6 12h1.8', 'M18.6 12h1.8', 'M6 6l1.3 1.3', 'M16.7 16.7 18 18', 'M18 6l-1.3 1.3', 'M7.3 16.7 6 18'],
  moon: ['M19.2 14.4A7.8 7.8 0 0 1 9.6 4.8a7.8 7.8 0 1 0 9.6 9.6z'],
  snow: ['M12 3.6v16.8', 'M4.7 7.8l14.6 8.4', 'M19.3 7.8 4.7 16.2'],
  search: ['M10.8 4.6a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4z', 'M15.4 15.4 20 20'],
  check: ['M5.2 12.8 9.6 17.2 18.8 6.8'],
  alert: ['M12 4.6 21 19.4H3z', 'M12 9.8v4.4', 'M12 16.6v.6'],
  close2: ['M7 7l10 10', 'M17 7 7 17'],
};

function Icon({ name, size }) {
  const edge = typeof size === 'number' ? size : 18;
  const paths = ICON_PATHS[name] || ICON_PATHS.home;
  return h('svg', {
    width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none',
    'aria-hidden': 'true', focusable: 'false', className: 'cpx-icon',
  }, paths.map((d, index) => h('path', {
    key: index, d, stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round',
  })));
}

// ---------------------------------------------------------------------------
// 5. UI kit
// ---------------------------------------------------------------------------

function cx(...parts) {
  return P.classes(...parts);
}

function Button({ variant, size, onClick, disabled, loading, title, ariaLabel, children }) {
  return h('button', {
    type: 'button',
    title,
    'aria-label': ariaLabel,
    disabled: Boolean(disabled || loading),
    onClick,
    className: cx('cmx-btn', variant ? `cmx-btn-${variant}` : '', size ? `cmx-btn-${size}` : ''),
  }, loading ? h('span', { className: 'cmx-spinner' }) : null, children);
}

function Badge({ tone, children }) {
  return h('span', { className: cx('cmx-badge', tone ? `cmx-badge-${tone}` : '') }, children);
}

function Card({ title, hint, right, children, tone }) {
  return h('section', { className: cx('cmx-card', tone ? `cmx-tone-${tone}` : '') },
    title || right || hint
      ? h('header', { className: 'cmx-card-head' },
        h('div', null,
          title ? h('h3', { className: 'cmx-card-title' }, title) : null,
          hint ? h('p', { className: 'cmx-hint' }, hint) : null),
        right || null)
      : null,
    h('div', { className: 'cmx-card-body' }, children));
}

function Section({ title, hint, actions, children }) {
  return h('section', { className: 'cmx-section' },
    title || actions
      ? h('header', { className: 'cmx-section-head' },
        h('div', null,
          title ? h('h2', { className: 'cmx-section-title' }, title) : null,
          hint ? h('p', { className: 'cmx-hint' }, hint) : null),
        actions ? h('div', { className: 'cmx-row' }, actions) : null)
      : null,
    children);
}

/** A divided band: the reference layout's primary structural unit. */
/**
 * 小的圈状 i：说明只在悬停或键盘聚焦时出现，不占正文。
 * 用在"不看会误解"的地方，一个 Band 最多一个。
 */
function Info({ text, label }) {
  if (!text) return null;
  return h('span', {
    className: 'cpx-info',
    role: 'img',
    tabIndex: 0,
    'data-tip': String(text),
    'aria-label': (label ? label + '：' : '说明：') + text,
  });
}

function Band({ title, hint, actions, info, children, flush }) {
  return h('section', { className: cx('cpx-band', flush ? 'cpx-band-flush' : '') },
    title || hint || actions
      ? h('header', { className: 'cpx-band-head' },
        h('div', null,
          title ? h('h2', { className: 'cpx-band-title' }, title, info ? h(Info, { text: info }) : null) : null,
          hint ? h('p', { className: 'cpx-band-hint' }, hint, info && !title ? h(Info, { text: info }) : null) : null),
        actions ? h('div', { className: 'cpx-band-actions' }, actions) : null)
      : null,
    h('div', { className: 'cpx-band-body' }, children));
}

function Stat({ label, value, hint, tone, onClick }) {
  return h(onClick ? 'button' : 'div', {
    type: onClick ? 'button' : undefined,
    className: cx('cmx-stat', onClick ? 'cmx-stat-clickable' : '', tone ? `cmx-tone-${tone}` : ''),
    onClick,
  },
  h('span', { className: 'cmx-stat-label' }, label),
  h('strong', { className: 'cmx-stat-value' }, value),
  hint ? h('span', { className: 'cmx-stat-hint' }, hint) : null);
}

function Input({ value, onChange, placeholder, onEnter, type, disabled, width, ariaLabel }) {
  return h('input', {
    type: type || 'text',
    value: value ?? '',
    placeholder,
    'aria-label': ariaLabel || placeholder,
    disabled,
    style: width ? { width } : undefined,
    className: 'cmx-input',
    onChange: (event) => onChange && onChange(event.target.value),
    onKeyDown: (event) => { if (event.key === 'Enter' && onEnter) onEnter(event.target.value); },
  });
}

function Search({ value, onChange, onEnter, placeholder, label }) {
  return h('label', { className: 'cpx-search' },
    h(Icon, { name: 'search', size: 15 }),
    h('input', {
      type: 'search',
      value: value ?? '',
      placeholder: placeholder || '搜索',
      'aria-label': label || placeholder || '搜索',
      className: 'cpx-search-input',
      onChange: (event) => onChange && onChange(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter' && onEnter) onEnter(event.target.value); },
    }));
}

function TextArea({ value, onChange, rows, placeholder, monospace, disabled, ariaLabel }) {
  return h('textarea', {
    value: value ?? '',
    rows: rows || 4,
    placeholder,
    disabled: Boolean(disabled),
    'aria-label': ariaLabel || placeholder,
    className: cx('cmx-input', 'cmx-textarea', monospace ? 'cmx-mono' : ''),
    onChange: (event) => onChange && onChange(event.target.value),
  });
}

function Select({ value, onChange, options, width, disabled, ariaLabel }) {
  return h('select', {
    value: value ?? '',
    disabled: Boolean(disabled),
    'aria-label': ariaLabel,
    className: 'cmx-select',
    style: width ? { width } : undefined,
    onChange: (event) => onChange && onChange(event.target.value),
  }, (options || []).map((option) => h('option', { key: option.value, value: option.value }, option.label)));
}

function Toggle({ checked, onChange, label, hint, disabled }) {
  return h('label', { className: 'cmx-toggle' },
    h('input', {
      type: 'checkbox',
      checked: Boolean(checked),
      disabled: Boolean(disabled),
      onChange: (event) => onChange && onChange(event.target.checked),
    }),
    h('span', null,
      h('span', { className: 'cmx-toggle-label' }, label),
      hint ? h('span', { className: 'cmx-hint' }, hint) : null));
}

function Table({ columns, rows, onRowClick, emptyText }) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return h('div', { className: 'cmx-empty-inline' }, emptyText || '没有数据。');
  return h('div', { className: 'cmx-table-wrap' },
    h('table', { className: 'cmx-table' },
      h('thead', null, h('tr', null, columns.map((column) => h('th', {
        key: column.key,
        style: { width: column.width, textAlign: column.align || 'left' },
      }, column.label)))),
      h('tbody', null, list.map((row, index) => h('tr', {
        key: row.id || row.key || index,
        className: onRowClick ? 'cmx-row-clickable' : undefined,
        onClick: onRowClick ? () => onRowClick(row) : undefined,
      }, columns.map((column) => h('td', {
        key: column.key,
        style: { textAlign: column.align || 'left' },
      }, column.render ? column.render(row) : row[column.key])))))));
}

/** Accessible sheet: Escape closes, backdrop closes, focus returns to the opener. */
function Sheet({ open, title, subtitle, onClose, footer, children, width }) {
  const panelRef = React.useRef(null);
  const openerRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    openerRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (onClose) onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const node = panelRef.current;
    if (node) {
      const focusable = node.querySelector('button:not([disabled]), [href], input, select, textarea');
      if (focusable) focusable.focus();
    }
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const opener = openerRef.current;
      if (opener && typeof opener.focus === 'function') {
        try { opener.focus(); } catch { /* detached */ }
      }
    };
  }, [open, onClose]);

  if (!open) return null;
  return h('div', { className: 'cmx-drawer-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '详情' },
    h('div', { className: 'cmx-drawer-backdrop', onClick: onClose }),
    h('aside', { className: 'cmx-drawer', ref: panelRef, style: width ? { width } : undefined },
      h('header', { className: 'cmx-drawer-head' },
        h('div', null,
          h('h3', { className: 'cmx-drawer-title' }, title),
          subtitle ? h('p', { className: 'cmx-hint' }, subtitle) : null),
        h(Button, { variant: 'ghost', size: 'sm', onClick: onClose, title: '关闭', ariaLabel: '关闭详情' }, '关闭')),
      h('div', { className: 'cmx-drawer-body' }, children),
      footer ? h('footer', { className: 'cmx-drawer-foot' }, footer) : null));
}

function Tabs({ tabs, value, onChange }) {
  return h('div', { className: 'cmx-tabs', role: 'tablist' },
    (tabs || []).map((tab) => h('button', {
      key: tab.id,
      type: 'button',
      role: 'tab',
      'aria-selected': tab.id === value,
      className: cx('cmx-tab', tab.id === value ? 'cmx-tab-active' : ''),
      onClick: () => onChange && onChange(tab.id),
    }, tab.label, tab.badge !== undefined && tab.badge !== null ? h(Badge, { tone: 'neutral' }, tab.badge) : null)));
}

/** Segmented control (tab-like, but reads as one choice inside a toolbar). */
function Segmented({ options, value, onChange, label, disabled }) {
  return h('div', { className: 'cpx-segmented', role: 'group', 'aria-label': label || '选择', 'aria-disabled': disabled ? 'true' : undefined },
    (options || []).map((option) => h('button', {
      key: option.id,
      type: 'button',
      disabled: Boolean(disabled),
      'aria-disabled': disabled ? 'true' : undefined,
      'aria-pressed': option.id === value,
      className: cx('cpx-segment', option.id === value ? 'cpx-segment-active' : ''),
      onClick: disabled ? undefined : () => onChange && onChange(option.id),
    }, option.icon ? h(Icon, { name: option.icon, size: 14 }) : null, h('span', null, option.label),
    option.badge !== undefined && option.badge !== null && option.badge !== '' ? h('span', { className: 'cpx-segment-badge' }, option.badge) : null)));
}

function KeyValue({ items }) {
  return h('dl', { className: 'cmx-kv' }, (items || []).filter(Boolean).map((item, index) => h('div', {
    key: item.k || index,
    className: 'cmx-kv-row',
  },
  h('dt', null, item.k),
  h('dd', { className: cx(item.mono ? 'cmx-mono' : '', item.breakable ? 'cmx-break' : '') }, item.v === null || item.v === undefined || item.v === '' ? '—' : item.v))));
}

function Field({ label, hint, children, id }) {
  return h('div', { className: 'cpx-field' },
    h('label', { className: 'cpx-field-label', htmlFor: id }, label),
    children,
    hint ? h('p', { className: 'cpx-field-hint' }, hint) : null);
}

function Bar({ value, tone }) {
  const ratio = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return h('div', { className: cx('cmx-bar', tone ? `cmx-bar-${tone}` : '') },
    h('div', { className: 'cmx-bar-fill', style: { width: `${ratio * 100}%` } }));
}

function Meter({ value, max, label, tone }) {
  const total = typeof max === 'number' && max > 0 ? max : null;
  const ratio = total && typeof value === 'number' ? Math.max(0, Math.min(1, value / total)) : null;
  return h('div', { className: 'cpx-meter' },
    h('div', { className: 'cpx-meter-head' },
      h('span', null, label),
      h('span', { className: 'cpx-meter-value' }, ratio === null ? P.fmt.orDash(value) : `${value}/${total}`)),
    h('div', { className: cx('cmx-bar', tone ? `cmx-bar-${tone}` : '') },
      h('div', { className: 'cmx-bar-fill', style: { width: `${(ratio ?? 0) * 100}%` } })));
}

function Empty({ title, hint, action, compact }) {
  return h('div', { className: cx('cmx-empty', compact ? 'cmx-empty-compact' : '') },
    h('strong', null, title || '暂无数据'),
    hint ? h('p', { className: 'cmx-hint' }, hint) : null,
    action || null);
}

function Loading({ text }) {
  return h('div', { className: 'cmx-loading' },
    h('span', { className: 'cmx-spinner' }),
    h('span', null, text || '读取中…'));
}

function Skeleton({ rows }) {
  const count = Math.max(1, Math.min(8, Number(rows) || 3));
  return h('div', { className: 'cpx-skel', 'aria-hidden': 'true', role: 'presentation' },
    Array.from({ length: count }).map((_, index) => h('div', { key: index, className: 'cpx-skel-row' })));
}

function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return h('div', { className: 'cmx-error', role: 'alert' },
    h('span', null, message),
    onRetry ? h(Button, { variant: 'ghost', size: 'sm', onClick: onRetry }, '重试') : null);
}

function Callout({ tone, title, children, action }) {
  return h('div', { className: cx('cpx-callout', `cpx-callout-${tone || 'info'}`), role: tone === 'danger' ? 'alert' : undefined },
    h('div', { className: 'cpx-callout-body' },
      title ? h('strong', { className: 'cpx-callout-title' }, title) : null,
      children ? h('div', { className: 'cpx-callout-text' }, children) : null),
    action || null);
}

function StateLine({ state, text }) {
  return h('span', { className: 'cpx-state' },
    h('span', { className: 'cpx-state-dot', 'data-state': state || 'idle', 'aria-hidden': 'true' }),
    h('span', null, text));
}

function Timestamp({ at, prefix, className }) {
  const full = P.fmt.dateTime(at);
  const short = P.fmt.relative(at);
  return h('span', { className: cx('cpx-timestamp', className), title: full },
    prefix ? `${prefix} ` : '', at ? short : '—');
}

function Masked({ text, label, length }) {
  const [shown, setShown] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [value, setValue] = React.useState(text || '');
  React.useEffect(() => { setValue(text || ''); setShown(false); }, [text]);
  const hidden = '•'.repeat(Math.max(6, Math.min(24, Number(length) || 12)));
  const reveal = () => {
    if (shown) { setShown(false); return; }
    if (value) { setShown(true); return; }
    if (!P.confirm('这条内容可能是敏感的私人记忆，确定在这里查看正文？')) return;
    setPending(true);
    Promise.resolve()
      .then(() => (typeof label === 'function' ? label() : null))
      .then((next) => {
        if (typeof next === 'string') { setValue(next); setShown(true); } else if (next && typeof next === 'object' && next.text) { setValue(next.text); setShown(true); }
        else setShown(true);
      })
      .catch(() => { setShown(true); })
      .finally(() => setPending(false));
  };
  return h('span', { className: 'cpx-masked' },
    h('span', { className: shown ? 'cpx-masked-text' : 'cpx-masked-dots', 'aria-live': 'polite' }, shown ? (value || '（空）') : hidden),
    h('button', {
      type: 'button',
      className: 'cpx-masked-toggle',
      onClick: reveal,
      disabled: pending,
    }, pending ? '读取中…' : shown ? '收起' : '显示'));
}

function Diagnostic({ title, hint, children, open }) {
  return h('details', { className: 'cpx-diag', open: Boolean(open) },
    h('summary', { className: 'cpx-diag-summary' },
      h('span', null, title || '高级诊断'),
      hint ? h('span', { className: 'cpx-diag-hint' }, hint) : null),
    h('div', { className: 'cpx-diag-body' }, children));
}

function List({ children, label }) {
  return h('div', { className: 'cpx-list', role: 'list', 'aria-label': label }, children);
}

/**
 * One list row. `title`/`meta`/`side` render a list entry; a row without a title
 * falls back to the legacy inline flex container so old call sites keep working.
 */
function Row({ title, meta, side, status, onClick, selected, ariaLabel, children, gap }) {
  if (!title && !meta && !side) {
    return h('div', { className: 'cmx-row', style: gap ? { gap } : undefined }, children);
  }
  const content = [
    h('span', { key: 'main', className: 'cpx-row-main' },
      h('span', { className: 'cpx-row-title' }, title),
      meta ? h('span', { className: 'cpx-row-meta' }, meta) : null),
    side ? h('span', { key: 'side', className: 'cpx-row-side' }, side) : null,
    status ? h('span', { key: 'status', className: 'cpx-row-status' }, status) : null,
  ];
  if (!onClick) {
    return h('div', {
      className: cx('cpx-row', selected ? 'cpx-row-selected' : ''),
      role: 'listitem',
      'aria-label': ariaLabel || (typeof title === 'string' ? title : undefined),
    }, content);
  }
  return h('button', {
    type: 'button',
    role: 'listitem',
    'aria-label': ariaLabel || (typeof title === 'string' ? title : undefined),
    'aria-current': selected ? 'true' : undefined,
    className: cx('cpx-row', 'cpx-row-clickable', selected ? 'cpx-row-selected' : ''),
    onClick,
  }, content);
}

function Toolbar({ children, right, label }) {
  return h('div', { className: 'cpx-toolbar', role: 'toolbar', 'aria-label': label },
    h('div', { className: 'cpx-toolbar-main' }, children),
    right ? h('div', { className: 'cpx-toolbar-right' }, right) : null);
}

function Split({ main, aside }) {
  return h('div', { className: 'cpx-split' },
    h('div', { className: 'cpx-split-main' }, main),
    aside ? h('aside', { className: 'cpx-aside', 'aria-label': '状态与快捷入口' }, aside) : null);
}

function Page({ title, subtitle, lead, info, status, actions, children }) {
  const intro = lead || subtitle;
  return h('div', { className: 'cpx-page' },
    h('header', { className: 'cpx-page-head' },
      h('div', { className: 'cpx-page-heading' },
        h('h1', { className: 'cpx-title' }, title, info && !intro ? h(Info, { text: info }) : null),
        intro ? h('p', { className: 'cpx-lead' }, intro, info ? h(Info, { text: info }) : null) : null,
        status ? h('p', { className: 'cpx-page-status' }, status) : null),
      actions ? h('div', { className: 'cpx-page-actions' }, actions) : null),
    children);
}

function ToastHost({ toasts, onDone }) {
  return h('div', { className: 'cmx-toasts', role: 'status', 'aria-live': 'polite' }, (toasts || []).map((toast) => h('div', {
    key: toast.id,
    className: cx('cmx-toast', toast.tone ? `cmx-toast-${toast.tone}` : ''),
    onAnimationEnd: () => onDone && onDone(toast.id),
  }, toast.text)));
}

// A deliberately small markdown renderer: headings, lists, fences, quotes,
// bold and inline code only. It builds elements, so page content can never
// inject markup.
function inline(text, keyPrefix) {
  const nodes = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) nodes.push(h('strong', { key: `${keyPrefix}-b${index++}` }, token.slice(2, -2)));
    else nodes.push(h('code', { key: `${keyPrefix}-c${index++}`, className: 'cmx-code-inline' }, token.slice(1, -1)));
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ text }) {
  const source = typeof text === 'string' ? text : '';
  if (!source.trim()) return h('p', { className: 'cmx-hint' }, '（空）');
  const blocks = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let list = null;
  let fence = null;
  let fenceLines = [];
  const flushList = () => {
    if (list) {
      blocks.push(h(list.ordered ? 'ol' : 'ul', { key: `l${blocks.length}` },
        list.items.map((item, index) => h('li', { key: index }, ...inline(item, `li${blocks.length}-${index}`)))));
    }
    list = null;
  };
  lines.forEach((line, lineIndex) => {
    if (fence !== null) {
      if (line.trim().startsWith('```')) {
        blocks.push(h('pre', { key: `p${lineIndex}`, className: 'cmx-pre' }, fenceLines.join('\n')));
        fence = null;
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
      return;
    }
    if (line.trim().startsWith('```')) {
      flushList();
      fence = '```';
      return;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = Math.min(6, heading[1].length + 2);
      blocks.push(h(`h${level}`, { key: `h${lineIndex}`, className: `cmx-md-h${level}` }, ...inline(heading[2], `h${lineIndex}`)));
      return;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push(line.replace(/^\s*[-*+]\s+/, ''));
      return;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push(line.replace(/^\s*\d+[.)]\s+/, ''));
      return;
    }
    if (!line.trim()) { flushList(); return; }
    if (/^>\s?/.test(line)) {
      flushList();
      blocks.push(h('blockquote', { key: `q${lineIndex}` }, ...inline(line.replace(/^>\s?/, ''), `q${lineIndex}`)));
      return;
    }
    flushList();
    blocks.push(h('p', { key: `t${lineIndex}`, className: 'cmx-md-p' }, ...inline(line, `t${lineIndex}`)));
  });
  if (fence !== null) blocks.push(h('pre', { key: 'pf', className: 'cmx-pre' }, fenceLines.join('\n')));
  flushList();
  return h('div', { className: 'cmx-md' }, blocks);
}

P.ui = {
  Page, Section, Band, Card, Stat, Badge, Button, Input, TextArea, Select, Toggle,
  Table, Drawer: Sheet, Sheet, Tabs, Segmented, KeyValue, Field, Bar, Meter, Empty,
  Loading, Skeleton, ErrorBox, Markdown, ToastHost, Callout, StateLine, Timestamp,
  Masked, Diagnostic, List, Row, Toolbar, Split, Search, Icon, Info,
  RowFlex: ({ children, gap }) => h('div', { className: 'cmx-row', style: gap ? { gap } : undefined }, children),
  Spacer: () => h('span', { className: 'cmx-spacer' }),
  Mono: ({ children }) => h('code', { className: 'cmx-mono-inline' }, children),
  Pre: ({ children, maxHeight }) => h('pre', { className: 'cmx-pre', style: maxHeight ? { maxHeight, overflow: 'auto' } : undefined }, children),
};

// ---------------------------------------------------------------------------
// 实时状态栏：一轮探测喂所有能力格子
// ---------------------------------------------------------------------------
// 数据全部来自既有 GET 端点或客户端服务存在性，不新造接口、不写库。
// 任何一项读不到就如实说"读不到"，绝不用 0 或绿色代替未知。
const HEALTH_CADENCE = 20000;
const HEALTH_TIMEOUT = 9000;
const HEALTH_BACKOFF_MAX = 60000;

const HEALTH_PROBES = {
  companion: () => P.api.get('companion'),
  summary: () => P.api.get('summary'),
  reviews: () => P.api.get('reviews'),
  wiki: () => P.api.get('wiki'),
  timeline: () => P.api.get('timeline', { limit: 1 }),
};

const HEALTH_LABELS = { ok: '正常', warn: '注意', down: '不可用', off: '未接入', unknown: '未知' };
const HEALTH_TONES = { ok: 'ok', warn: 'warn', down: 'danger', off: 'neutral', unknown: 'neutral' };

function healthTotal(counts) {
  if (!counts || typeof counts !== 'object') return null;
  const named = Number(counts.memories);
  if (Number.isFinite(named)) return named;
  const parts = ['confirmed', 'pending', 'superseded', 'archived'].map((key) => Number(counts[key]));
  if (!parts.every((value) => Number.isFinite(value))) return null;
  return parts.reduce((sum, value) => sum + value, 0);
}

const HEALTH_CAPS = [
  {
    id: 'memory', label: '记忆库', page: 'vault', probe: 'summary', source: 'GET summary',
    judge: ({ data }) => {
      const total = healthTotal(data && data.counts);
      if (total === null) return { state: 'unknown', note: '没有读到记忆计数' };
      return { state: 'ok', note: total + ' 条长期记忆' };
    },
  },
  {
    id: 'review', label: '审核队列', page: 'review', probe: 'reviews', source: 'GET reviews',
    judge: ({ data }) => {
      const pending = Array.isArray(data && data.pending) ? data.pending.length : null;
      const failed = Array.isArray(data && data.failedJobs) ? data.failedJobs.length : 0;
      if (pending === null) return { state: 'ok', note: '队列可读' };
      if (failed > 0) return { state: 'warn', note: failed + ' 个失败作业要重试' };
      if (pending >= 20) return { state: 'warn', note: pending + ' 条待核对，积压了' };
      return { state: 'ok', note: pending ? pending + ' 条待核对' : '没有待核对' };
    },
  },
  {
    id: 'life', label: '生活与日程', page: 'life', probe: 'companion', source: 'GET companion · runtime',
    judge: ({ data }) => {
      const runtime = data && data.runtime;
      if (!runtime || typeof runtime !== 'object') return { state: 'unknown', note: '没有运行库状态字段' };
      if (runtime.available === false) return { state: 'off', note: '运行库没有接入' };
      if (runtime.enabled === false) return { state: 'off', note: '配置里已关闭' };
      const mode = typeof runtime.mode === 'string' && runtime.mode ? runtime.mode : '';
      return { state: 'ok', note: mode ? '运行库在线 · ' + mode : '运行库在线' };
    },
  },
  {
    id: 'qq', label: 'QQ 投递', page: 'connections', probe: 'companion', source: 'GET companion · 投递与联系人',
    judge: ({ data }) => {
      const qq = (data && (data.contact || data.delivery || data.channel)) || null;
      if (!qq || typeof qq !== 'object') return { state: 'unknown', note: '没有投递状态字段' };
      if (qq.bound === false || qq.linked === false) return { state: 'off', note: '还没绑定投递对象' };
      const last = qq.lastSentAt || qq.lastSentAtByRoom || null;
      if (last) return { state: 'ok', note: '有投递记录' };
      const sent = Number(qq.sentToday);
      if (Number.isFinite(sent) && sent > 0) return { state: 'ok', note: '今天已投递 ' + sent + ' 条' };
      return { state: 'ok', note: '通道可读，今天还没投递' };
    },
  },
  {
    id: 'media', label: '媒体能力', page: 'connections', probe: 'companion', source: 'GET companion · media',
    judge: ({ data }) => {
      const media = data && data.media;
      if (!media || typeof media !== 'object') return { state: 'unknown', note: '没有媒体状态字段' };
      const keys = ['vision', 'speech', 'image', 'screen'];
      const ready = keys.filter((key) => media[key] === true || media[key] === 'on' || media[key] === 'ready');
      if (media.enabled === false) return { state: 'off', note: '媒体总开关是关的' };
      if (!ready.length) return { state: 'warn', note: '开着，但没有一项子能力就绪' };
      return { state: 'ok', note: ready.length + ' 项子能力就绪' };
    },
  },
  {
    id: 'wiki', label: 'Wiki', page: 'wiki', probe: 'wiki', source: 'GET wiki',
    judge: ({ data }) => {
      const pages = Array.isArray(data && data.pages) ? data.pages.length : null;
      if (pages === null) return { state: 'unknown', note: '没有页面清单' };
      if (!pages) return { state: 'warn', note: '还没有主题页' };
      return { state: 'ok', note: pages + ' 个主题页' };
    },
  },
  {
    id: 'timeline', label: '时间线', page: 'timeline', probe: 'timeline', source: 'GET timeline',
    judge: ({ data }) => {
      const items = Array.isArray(data && data.items) ? data.items.length : null;
      if (items === null) return { state: 'unknown', note: '没有事件清单' };
      if (!items) return { state: 'warn', note: '最近没有事件' };
      return { state: 'ok', note: '有最近事件' };
    },
  },
  {
    id: 'workspace', label: '工作区', page: 'workspace', probe: 'client', source: '宿主服务（本地判断，不发请求）',
    judge: () => {
      const ws = P.services.uiWorkspace;
      if (!ws) return { state: 'off', note: '宿主没把工作区服务交出来' };
      if (typeof ws.listDirectory !== 'function') return { state: 'warn', note: '只能选取目录，不能浏览' };
      return { state: 'ok', note: '工作区服务在线' };
    },
  },
];

function healthTone(state) { return HEALTH_TONES[state] || 'neutral'; }
function healthLabel(state) { return HEALTH_LABELS[state] || HEALTH_LABELS.unknown; }

function healthAgo(at, now) {
  if (!at) return '还没成功过';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟前';
  return Math.round(minutes / 60) + ' 小时前';
}

P.health = {
  cadence: HEALTH_CADENCE,
  timeout: HEALTH_TIMEOUT,
  caps: HEALTH_CAPS,
  label: healthLabel,
  tone: healthTone,
  ago: healthAgo,
  summarize(items) {
    const summary = { ok: 0, warn: 0, down: 0, off: 0, unknown: 0, total: (items || []).length };
    (items || []).forEach((item) => { summary[item.state] = (summary[item.state] || 0) + 1; });
    return summary;
  },
};

/**
 * 一轮探测：并发跑所有探针（带超时），再把结果交给每个能力自己的 judge。
 * 失败只用"这一项读不到"表达，不冒充 0。
 */
async function runHealthCycle() {
  const keys = [...new Set(HEALTH_CAPS.map((cap) => cap.probe).filter((key) => key !== 'client'))];
  const results = Object.create(null);
  const withTimeout = (key) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      results[key] = { ok: false, latency: HEALTH_TIMEOUT, error: new Error('探测超时'), data: null, at: 0 };
      resolve();
    }, HEALTH_TIMEOUT);
    const startedAt = Date.now();
    Promise.resolve()
      .then(() => HEALTH_PROBES[key]())
      .then(
        (data) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          results[key] = { ok: true, latency: Date.now() - startedAt, error: null, data, at: Date.now() };
          resolve();
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          results[key] = { ok: false, latency: Date.now() - startedAt, error, data: null, at: 0 };
          resolve();
        },
      );
  });
  await Promise.all(keys.map(withTimeout));

  const at = Date.now();
  return HEALTH_CAPS.map((cap) => {
    const base = { id: cap.id, label: cap.label, page: cap.page, source: cap.source };
    if (cap.probe === 'client') {
      let verdict = { state: 'unknown', note: '' };
      try { verdict = cap.judge({ data: null, probe: null }) || verdict; } catch { /* keep */ }
      return { ...base, state: verdict.state, note: verdict.note, latency: 0, at: 0, error: null };
    }
    const probe = results[cap.probe];
    if (!probe) return { ...base, state: 'unknown', note: '这一轮没有探测结果', latency: 0, at: 0, error: null };
    if (!probe.ok) {
      const reason = P.failText(probe.error, '请求没有完成');
      return { ...base, state: 'down', note: reason, latency: probe.latency, at: 0, error: reason };
    }
    let verdict = { state: 'ok', note: '' };
    try { verdict = cap.judge({ data: probe.data, probe }) || verdict; } catch (error) {
      verdict = { state: 'unknown', note: P.failText(error, '判定失败') };
    }
    const slow = probe.latency >= 3000 ? ' · 慢 ' + Math.round(probe.latency) + 'ms' : '';
    return {
      ...base,
      state: verdict.state || 'ok',
      note: ((verdict.note || '') + slow).trim(),
      latency: probe.latency,
      at: probe.at || at,
      error: null,
    };
  });
}

/**
 * 实时健康数据：进场先探一次，之后按 cadence 轮询；
 * 页面隐藏时暂停请求，恢复可见时补一轮；全部失败则退避（最长 60s）。
 */
P.useLiveHealth = ({ cadence = HEALTH_CADENCE, enabled = true } = {}) => {
  const [items, setItems] = React.useState([]);
  const [at, setAt] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [paused, setPaused] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  const [cycle, setCycle] = React.useState(0);
  const timerRef = React.useRef(null);
  const aliveRef = React.useRef(true);

  React.useEffect(() => {
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, []);

  React.useEffect(() => {
    aliveRef.current = true;
    if (!enabled || paused) {
      setLoading(false);
      return () => { aliveRef.current = false; if (timerRef.current) clearTimeout(timerRef.current); };
    }
    const schedule = (delay) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(step, delay);
    };
    function step() {
      if (!aliveRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) {
        schedule(4000);
        return;
      }
      runHealthCycle()
        .then((next) => {
          if (!aliveRef.current) return;
          setItems(next);
          setAt(Date.now());
          setLoading(false);
          const allDown = next.every((item) => item.state === 'down');
          schedule(allDown ? Math.min(Math.max(cadence, 20000) * 2, HEALTH_BACKOFF_MAX) : cadence);
        })
        .catch(() => schedule(Math.min(cadence * 2, HEALTH_BACKOFF_MAX)));
    }
    step();
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, paused, cadence, cycle]);

  return {
    items,
    at,
    now,
    loading,
    paused,
    cadence,
    refresh: () => setCycle((value) => value + 1),
    setPaused,
    togglePaused: () => setPaused((value) => !value),
  };
};

function HealthChip({ item, now, onOpen }) {
  const state = item.state || 'unknown';
  const detail = item.label + '：' + healthLabel(state)
    + (item.note ? '（' + item.note + '）' : '')
    + '；' + (state === 'down' ? '这一项暂时读不到' : '最近成功 ' + healthAgo(item.at, now));
  return h('button', {
    type: 'button',
    className: 'cpx-health-item',
    'data-state': state,
    onClick: onOpen,
    title: detail,
    'aria-label': detail + '。按回车打开' + item.label + '。',
  },
  h('span', { className: 'cpx-health-dot', 'data-state': state, 'aria-hidden': 'true' }),
  h('span', { className: 'cpx-health-text' },
    h('span', { className: 'cpx-health-name' }, item.label),
    h('span', { className: 'cpx-health-state' }, healthLabel(state)),
    item.note ? h('span', { className: 'cpx-health-note' }, item.note) : null));
}

function HealthStrip({ items, at, now, loading, paused, onRefresh, onTogglePause, onOpen, compact }) {
  const summary = P.health.summarize(items);
  const headline = items.length
    ? (summary.down || summary.warn
      ? summary.ok + ' 项正常 · ' + (summary.warn + summary.down) + ' 项要留意'
      : summary.ok + ' 项正常')
    : (loading ? '正在读状态…' : '还没有探测结果');
  return h('div', { className: 'cpx-health' + (compact ? ' cpx-health-compact' : '') },
    h('div', { className: 'cpx-health-head' },
      h('span', { className: 'cpx-health-live', 'data-paused': paused ? 'true' : 'false', 'aria-hidden': 'true' }),
      h('span', { className: 'cpx-health-headline' }, headline),
      h('span', { className: 'cpx-health-stamp' }, paused ? '已暂停' : '更新于 ' + healthAgo(at, now)),
      h('span', { className: 'cpx-health-actions' },
        h(Button, { variant: 'ghost', size: 'sm', onClick: onRefresh, ariaLabel: '立刻重新探测一次' }, '重探'),
        h(Button, { variant: 'ghost', size: 'sm', onClick: onTogglePause, ariaLabel: paused ? '继续自动更新' : '暂停自动更新' }, paused ? '继续' : '暂停'))),
    h('div', { className: 'cpx-health-grid', role: 'list' },
      items.length
        ? items.map((item) => h('div', { key: item.id, role: 'listitem' }, h(HealthChip, { item, now, onOpen: () => onOpen && onOpen(item) })))
        : h('p', { className: 'cpx-health-empty' }, loading ? '第一次探测还在跑…' : '这一轮没有任何结果；点「刷新」再试一次。')));
}

/** 更详细的版本（运行状态页）：每项一行，带来源、耗时、最近成功时间。 */
function HealthBoard({ items, now, onOpen }) {
  return h('div', { className: 'cpx-health-board' },
    h('div', { className: 'cpx-health-board-row cpx-health-board-head' },
      h('span', null, '能力'),
      h('span', null, '状态'),
      h('span', null, '说明'),
      h('span', null, '耗时'),
      h('span', null, '最近成功')),
    items.map((item) => h('button', {
      key: item.id,
      type: 'button',
      className: 'cpx-health-board-row',
      onClick: () => onOpen && onOpen(item),
      title: item.source,
    },
    h('span', { className: 'cpx-health-board-name' }, item.label),
    h('span', { className: 'cpx-health-board-state' },
      h('span', { className: 'cpx-health-dot', 'data-state': item.state, 'aria-hidden': 'true' }),
      healthLabel(item.state)),
    h('span', { className: 'cpx-health-board-note' }, item.note || '—'),
    h('span', { className: 'cpx-health-board-mono' }, item.latency ? Math.round(item.latency) + 'ms' : '—'),
    h('span', { className: 'cpx-health-board-mono' }, item.state === 'down' ? '失败' : healthAgo(item.at, now)))));
}

P.css(`
.cpx-info { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; margin-left: 6px; border-radius: 50%; border: 1px solid currentColor; color: var(--dsw-alias-label-secondary); font-family: Georgia, serif; font-size: 10px; font-style: italic; line-height: 1; cursor: help; vertical-align: 1px; flex: none; }
.cpx-info::before { content: 'i'; }
.cpx-info:hover, .cpx-info:focus-visible { color: var(--dsw-alias-label-primary); outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l2); }
.cpx-info::after { content: attr(data-tip); position: absolute; left: 0; top: calc(100% + 6px); z-index: 40; width: max-content; max-width: min(340px, 70vw); padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); font-family: var(--cpx-font); font-size: 12px; font-style: normal; line-height: 1.65; text-align: left; white-space: normal; box-shadow: 0 10px 28px -14px rgba(0,0,0,.5); opacity: 0; visibility: hidden; transform: translateY(-2px); transition: opacity .12s ease, transform .12s ease; pointer-events: none; }
.cpx-info:hover::after, .cpx-info:focus-visible::after { opacity: 1; visibility: visible; transform: translateY(0); }
@media (prefers-reduced-motion: reduce) { .cpx-info::after { transition: none; } }
`);

P.ui.HealthStrip = HealthStrip;
P.ui.HealthBoard = HealthBoard;

// ---------------------------------------------------------------------------
// 6. Styles
// ---------------------------------------------------------------------------

P.css(`
.cpx-health { display: flex; flex-direction: column; gap: 10px; }
.cpx-health-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cpx-health-live { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-status-ok, #3f9a6a); animation: cpx-pulse 2.4s ease-out infinite; }
.cpx-health-live[data-paused="true"] { background: var(--dsw-alias-label-secondary); animation: none; }
@keyframes cpx-pulse { 0% { box-shadow: 0 0 0 0 rgba(63,154,106,.55); } 70% { box-shadow: 0 0 0 7px rgba(63,154,106,0); } 100% { box-shadow: 0 0 0 0 rgba(63,154,106,0); } }
@media (prefers-reduced-motion: reduce) { .cpx-health-live { animation: none; } }
.cpx-health-headline { font-weight: 600; font-size: 13.5px; }
.cpx-health-stamp { color: var(--dsw-alias-label-secondary); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.cpx-health-actions { margin-left: auto; display: flex; gap: 6px; }
.cpx-health-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 8px; }
.cpx-health-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--cpx-r-sm); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; text-align: left; cursor: pointer; min-width: 0; }
.cpx-health-item:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.cpx-health-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.cpx-health-dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-secondary); }
.cpx-health-dot[data-state="ok"] { background: var(--dsw-alias-status-ok, #3f9a6a); }
.cpx-health-dot[data-state="warn"] { background: var(--dsw-alias-status-warn, #c08a2e); }
.cpx-health-dot[data-state="down"] { background: var(--dsw-alias-status-danger, #b6453a); }
.cpx-health-dot[data-state="off"] { background: var(--dsw-alias-label-secondary); }
.cpx-health-dot[data-state="unknown"] { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-secondary); }
.cpx-health-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.cpx-health-name { font-size: 13px; font-weight: 600; }
.cpx-health-state { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cpx-health-item[data-state="warn"] .cpx-health-state { color: var(--dsw-alias-status-warn, #c08a2e); }
.cpx-health-item[data-state="down"] .cpx-health-state { color: var(--dsw-alias-status-danger, #b6453a); }
.cpx-health-note { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cpx-health-empty { margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.cpx-health-board { display: flex; flex-direction: column; }
.cpx-health-board-row { display: grid; grid-template-columns: minmax(96px, 1.1fr) 96px minmax(0, 2.4fr) 72px 96px; gap: 10px; align-items: center; width: 100%; padding: 8px 4px; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); background: transparent; color: inherit; font: inherit; text-align: left; }
button.cpx-health-board-row { cursor: pointer; }
button.cpx-health-board-row:hover { background: var(--dsw-alias-bg-layer-1); }
button.cpx-health-board-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.cpx-health-board-head { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cpx-health-board-name { font-weight: 600; font-size: 13px; }
.cpx-health-board-state { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
.cpx-health-board-state .cpx-health-dot { margin-top: 0; }
.cpx-health-board-note { font-size: 12.5px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.cpx-health-board-mono { font-family: var(--cpx-mono); font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
@media (max-width: 1100px) {
  .cpx-health-board-row { grid-template-columns: minmax(88px, 1fr) 88px minmax(0, 1.8fr) 64px; }
  .cpx-health-board-head span:nth-child(5), .cpx-health-board-row > span:nth-child(5) { display: none; }
}
@media (max-width: 760px) {
  .cpx-health-grid { grid-template-columns: 1fr 1fr; }
  .cpx-health-board-row { grid-template-columns: minmax(80px, 1fr) 88px; row-gap: 2px; }
  .cpx-health-board-note, .cpx-health-board-mono, .cpx-health-board-head span:nth-child(n+3) { display: none; }
}
@media (max-width: 420px) { .cpx-health-grid { grid-template-columns: 1fr; } }

.cpx-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.cpx-app {
  --cpx-rail: 224px;
  --cpx-aside: 276px;
  --cpx-s1: 4px; --cpx-s2: 8px; --cpx-s3: 12px; --cpx-s4: 16px;
  --cpx-s5: 24px; --cpx-s6: 32px; --cpx-s7: 48px;
  --cpx-r-sm: 8px; --cpx-r-md: 12px; --cpx-r-lg: 16px;
  --cpx-fs-display: 30px; --cpx-fs-title: 26px; --cpx-fs-section: 17px;
  --cpx-fs-body: 14.5px; --cpx-fs-small: 12.5px;
  --cpx-font: -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif;
  --cpx-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --cpx-sakura-soft: var(--dsw-alias-bg-layer-2);
  --cpx-sakura-line: var(--dsw-alias-border-l1);
  display: grid;
  grid-template-columns: var(--cpx-rail) minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--cpx-font);
  font-size: var(--cpx-fs-body);
  line-height: 1.7;
  overflow: hidden;
}
.cpx-app[data-rail="collapsed"] { --cpx-rail: 64px; }
.cpx-app * { box-sizing: border-box; }
.cpx-app :focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 6px; }
.cpx-icon { flex: none; }
.cpx-muted { color: var(--dsw-alias-label-secondary); }
.cpx-skip {
  position: absolute; left: -9999px; top: 8px; z-index: 80;
  padding: 8px 14px; border-radius: var(--cpx-r-sm);
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); text-decoration: none;
}
.cpx-skip:focus { left: 12px; }

/* --- rail ------------------------------------------------------------- */
.cpx-rail {
  display: flex; flex-direction: column; gap: var(--cpx-s3);
  min-height: 0; padding: var(--cpx-s4) var(--cpx-s3);
  border-right: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-sidebar-fill);
  overflow: auto;
}
.cpx-rail-head { display: flex; align-items: center; gap: var(--cpx-s3); padding: 0 var(--cpx-s2) var(--cpx-s3); }
.cpx-brand-mark {
  display: grid; place-items: center; width: 34px; height: 34px; flex: none;
  border-radius: 10px; color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, var(--dsw-alias-border-l1));
}
.cpx-brand { display: flex; flex-direction: column; min-width: 0; }
.cpx-brand-name { font-weight: 600; letter-spacing: .3px; }
.cpx-brand-state { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cpx-nav { display: flex; flex-direction: column; gap: 2px; }
.cpx-nav-group { display: flex; flex-direction: column; gap: 2px; margin-top: var(--cpx-s3); }
.cpx-nav-label {
  padding: 0 var(--cpx-s2) var(--cpx-s1); color: var(--dsw-alias-label-secondary);
  font-size: 11.5px; letter-spacing: .12em; text-transform: none;
}
.cpx-nav-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 10px; border: 1px solid transparent; border-radius: var(--cpx-r-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13.5px; text-align: left; cursor: pointer;
}
.cpx-nav-item:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.cpx-nav-item[aria-current="page"] {
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l1); font-weight: 600;
  box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary);
}
.cpx-nav-item[aria-current="page"] .cpx-icon { color: var(--dsw-alias-brand-primary); }
.cpx-nav-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpx-nav-exit::after { content: "↗"; margin-left: auto; font-size: 11px; opacity: .7; }
.cpx-rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: var(--cpx-s2); padding-top: var(--cpx-s3); border-top: 1px solid var(--dsw-alias-border-l1); }
.cpx-theme-row { display: flex; gap: 2px; }
.cpx-theme-btn {
  display: grid; place-items: center; width: 30px; height: 28px; flex: 1;
  border: 1px solid transparent; border-radius: var(--cpx-r-sm);
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.cpx-theme-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.cpx-theme-btn[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.cpx-rail-toggle, .cpx-rail-action {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border: 1px solid transparent; border-radius: var(--cpx-r-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12.5px; cursor: pointer; text-align: left;
}
.cpx-rail-action:disabled { opacity: .5; cursor: not-allowed; }
.cpx-rail-toggle:hover, .cpx-rail-action:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.cpx-app[data-rail="collapsed"] .cpx-brand,
.cpx-app[data-rail="collapsed"] .cpx-nav-text,
.cpx-app[data-rail="collapsed"] .cpx-nav-label,
.cpx-app[data-rail="collapsed"] .cpx-rail-toggle-text,
.cpx-app[data-rail="collapsed"] .cpx-theme-btn { display: none; }
.cpx-app[data-rail="collapsed"] .cpx-nav-item { justify-content: center; padding: 9px 0; }
.cpx-app[data-rail="collapsed"] .cpx-rail-head { justify-content: center; padding: 0 0 var(--cpx-s3); }
.cpx-app[data-rail="collapsed"] .cpx-rail-toggle { justify-content: center; }
.cpx-app[data-rail="collapsed"] .cpx-theme-row { flex-direction: column; }

/* mobile: rail becomes a drawer; the toggle lives in the content header */
.cpx-nav-toggle {
  display: none; align-items: center; gap: 8px;
  margin: var(--cpx-s3) var(--cpx-s3) 0; padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--cpx-r-sm);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; cursor: pointer; align-self: start;
}
.cpx-drawer-backdrop { display: none; }

/* --- content ---------------------------------------------------------- */
.cpx-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.cpx-tabs {
  display: flex; gap: 2px; padding: var(--cpx-s4) clamp(16px, 3vw, 40px) 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1); overflow-x: auto; flex: none;
  background: var(--dsw-alias-bg-base);
}
.cpx-tab {
  padding: 10px 12px; border: 0; border-bottom: 2px solid transparent; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13.5px; cursor: pointer; white-space: nowrap;
}
.cpx-tab:hover { color: var(--dsw-alias-label-primary); }
.cpx-tab[aria-current="page"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.cpx-scroll { flex: 1; min-height: 0; overflow: auto; scroll-behavior: smooth; }
.cpx-page { max-width: 1160px; margin: 0 auto; padding: var(--cpx-s5) clamp(16px, 3vw, 40px) 72px; display: flex; flex-direction: column; gap: var(--cpx-s5); }
.cpx-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--cpx-s4); flex-wrap: wrap; }
.cpx-page-heading { min-width: 0; display: flex; flex-direction: column; gap: 6px; max-width: 72ch; }
.cpx-title { margin: 0; font-size: var(--cpx-fs-title); line-height: 1.3; letter-spacing: .2px; overflow-wrap: anywhere; }
.cpx-lead { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-body); max-width: 68ch; overflow-wrap: anywhere; }
.cpx-page-status { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.cpx-page-actions { display: flex; gap: var(--cpx-s2); align-items: center; flex-wrap: wrap; }
.cpx-band { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: var(--cpx-s5); display: flex; flex-direction: column; gap: var(--cpx-s3); }
.cpx-band-flush { border-top: 0; padding-top: 0; }
.cpx-band-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--cpx-s3); flex-wrap: wrap; }
.cpx-band-title { margin: 0; font-size: var(--cpx-fs-section); font-weight: 600; letter-spacing: .2px; }
.cpx-band-hint { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); max-width: 72ch; }
.cpx-band-actions { display: flex; gap: var(--cpx-s2); align-items: center; flex-wrap: wrap; }
.cpx-band-body { display: flex; flex-direction: column; gap: var(--cpx-s3); min-width: 0; }
.cpx-split { display: grid; grid-template-columns: minmax(0, 1fr) var(--cpx-aside); gap: var(--cpx-s6); align-items: start; }
.cpx-split-main { min-width: 0; display: flex; flex-direction: column; gap: var(--cpx-s5); }
.cpx-aside { min-width: 0; display: flex; flex-direction: column; gap: var(--cpx-s4); }
.cpx-aside-section { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: var(--cpx-s3); display: flex; flex-direction: column; gap: 6px; }
.cpx-aside-section:first-child { border-top: 0; padding-top: 0; }
.cpx-aside-title { margin: 0; font-size: var(--cpx-fs-small); letter-spacing: .08em; color: var(--dsw-alias-label-secondary); font-weight: 600; }
.cpx-aside-line { margin: 0; display: flex; align-items: baseline; gap: 8px; justify-content: space-between; }
.cpx-aside-line strong { font-variant-numeric: tabular-nums; }

/* --- hero scene (original CSS art, degrades to a plain panel) ---------- */
.cpx-hero { display: flex; flex-direction: column; gap: var(--cpx-s3); }
.cpx-scene {
  position: relative; overflow: hidden; min-height: 248px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--cpx-r-lg);
  background:
    radial-gradient(120% 90% at 16% 10%, color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent), transparent 60%),
    linear-gradient(180deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-layer-2));
  padding: var(--cpx-s6);
  display: grid; align-content: end; gap: var(--cpx-s2);
}
.cpx-scene-sky {
  position: absolute; inset: 0 0 auto; height: 64%;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent), transparent 72%),
    radial-gradient(80% 60% at 78% 8%, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent), transparent 70%);
}
.cpx-scene-floor {
  position: absolute; left: 0; right: 0; bottom: 0; height: 30%;
  background: linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent), transparent 82%);
  border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 45%, transparent);
  opacity: .55;
}
.cpx-scene-window {
  position: absolute; right: 9%; top: 13%; width: 148px; height: 112px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 34%, var(--dsw-alias-border-l2));
  border-radius: 12px;
  background:
    radial-gradient(90% 70% at 72% 22%, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 26%, transparent), transparent 64%),
    linear-gradient(165deg, color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent), color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent));
  box-shadow:
    0 0 0 7px color-mix(in srgb, var(--dsw-alias-bg-layer-2) 80%, transparent),
    0 20px 48px -28px color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent);
}
.cpx-scene-window::before, .cpx-scene-window::after {
  content: ""; position: absolute;
  background: color-mix(in srgb, var(--dsw-alias-border-l2) 80%, transparent);
}
.cpx-scene-window::before { left: 50%; top: 0; bottom: 0; width: 1px; }
.cpx-scene-window::after { top: 50%; left: 0; right: 0; height: 1px; }
.cpx-scene-desk {
  position: absolute; left: 9%; right: 9%; bottom: 31%; height: 1px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent);
  box-shadow: 0 8px 20px -12px color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent);
}
.cpx-scene-lamp {
  position: absolute; left: 13%; bottom: 33%; width: 56px; height: 56px; border-radius: 50%;
  background: radial-gradient(circle at 42% 38%, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent), transparent 72%);
}
.cpx-scene-lamp::before {
  content: ""; position: absolute; left: 50%; top: 0; width: 1px; height: 62%;
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent);
}
.cpx-scene-mark {
  position: absolute; left: 11%; top: 14%;
  color: color-mix(in srgb, var(--dsw-alias-brand-primary) 72%, transparent);
  filter: drop-shadow(0 4px 12px color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent));
}
.cpx-scene-state { position: relative; margin: 0; font-size: var(--cpx-fs-display); line-height: 1.25; letter-spacing: .2px; max-width: min(24ch, calc(100% - 184px)); overflow-wrap: anywhere; }
.cpx-scene-note { position: relative; margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13.5px; max-width: 48ch; }
.cpx-scene-meta { position: relative; margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

/* --- list rows -------------------------------------------------------- */
.cpx-list { display: flex; flex-direction: column; }
.cpx-row {
  display: flex; align-items: baseline; gap: var(--cpx-s3); width: 100%;
  padding: 10px 8px; border: 0; border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent);
  background: transparent; color: inherit; font: inherit; text-align: left;
}
.cpx-list .cpx-row:first-child { border-top: 0; }
.cpx-row-clickable { cursor: pointer; border-radius: var(--cpx-r-sm); }
.cpx-row-clickable:hover { background: var(--dsw-alias-bg-layer-2); }
.cpx-row-selected { background: var(--dsw-alias-bg-layer-1); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.cpx-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.cpx-row-title { overflow-wrap: anywhere; }
.cpx-row-meta { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); overflow-wrap: anywhere; }
.cpx-row-side, .cpx-row-status { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); white-space: nowrap; flex: none; }

/* --- controls --------------------------------------------------------- */
.cpx-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--cpx-s3); flex-wrap: wrap; }
.cpx-toolbar-main, .cpx-toolbar-right { display: flex; align-items: center; gap: var(--cpx-s2); flex-wrap: wrap; min-width: 0; }
.cpx-search {
  display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; min-width: 200px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--cpx-r-sm);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  min-width: 0; flex: 1 1 auto;
}
.cpx-search-input { border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13.5px; padding: 7px 0; min-width: 0; flex: 1; outline: none; }
.cpx-segmented { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-2); flex-wrap: wrap; }
.cpx-segment {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px;
  border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; cursor: pointer;
}
.cpx-segment:hover { color: var(--dsw-alias-label-primary); }
.cpx-segment:disabled { opacity: .55; cursor: not-allowed; }
.cpx-segment-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .06); }
.cpx-segment-badge { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.cpx-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cpx-field-label { font-size: var(--cpx-fs-small); color: var(--dsw-alias-label-secondary); }
.cpx-field-hint { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

/* --- callout / state / diagnosis ------------------------------------- */
.cpx-callout {
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--cpx-s3);
  padding: 12px 14px; border-radius: var(--cpx-r-md);
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  border-left: 3px solid var(--dsw-alias-state-idle-primary);
}
.cpx-callout-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cpx-callout-title { font-size: 13.5px; }
.cpx-callout-text { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); overflow-wrap: anywhere; }
.cpx-callout-info { border-left-color: var(--dsw-alias-brand-primary); }
.cpx-callout-ok { border-left-color: var(--dsw-alias-state-success-primary); }
.cpx-callout-warn { border-left-color: var(--dsw-alias-state-warn-primary); }
.cpx-callout-danger { border-left-color: var(--dsw-alias-state-error-primary); }
.cpx-state { display: inline-flex; align-items: center; gap: 6px; font-size: var(--cpx-fs-small); color: var(--dsw-alias-label-secondary); }
.cpx-state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.cpx-state-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary); }
.cpx-state-dot[data-state="warn"] { background: var(--dsw-alias-state-warn-primary); }
.cpx-state-dot[data-state="danger"] { background: var(--dsw-alias-state-error-primary); }
.cpx-state-dot[data-state="live"] { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent); }
.cpx-diag { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: var(--cpx-s2); }
.cpx-diag-summary { display: flex; align-items: baseline; gap: 10px; cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); list-style: none; }
.cpx-diag-summary::-webkit-details-marker { display: none; }
.cpx-diag-summary::before { content: "▸"; font-size: 10px; }
.cpx-diag[open] .cpx-diag-summary::before { content: "▾"; }
.cpx-diag-hint { color: var(--dsw-alias-label-secondary); opacity: .8; }
.cpx-diag-body { padding-top: var(--cpx-s2); display: flex; flex-direction: column; gap: var(--cpx-s2); }
.cpx-masked { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.cpx-masked-dots { letter-spacing: 2px; color: var(--dsw-alias-label-secondary); }
.cpx-masked-text { overflow-wrap: anywhere; }
.cpx-masked-toggle { border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: var(--cpx-fs-small); cursor: pointer; text-decoration: underline; padding: 0; }
.cpx-meter { display: flex; flex-direction: column; gap: 4px; }
.cpx-meter-head { display: flex; justify-content: space-between; gap: 8px; font-size: var(--cpx-fs-small); color: var(--dsw-alias-label-secondary); }
.cpx-meter-value { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.cpx-timestamp { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); white-space: nowrap; }
.cpx-skel { display: flex; flex-direction: column; gap: 8px; padding: var(--cpx-s2) 0; }
.cpx-skel-row { height: 14px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); animation: cpx-pulse 1.6s ease-in-out infinite; }
.cpx-skel-row:nth-child(2) { width: 82%; }
.cpx-skel-row:nth-child(3) { width: 64%; }
@keyframes cpx-pulse { 0%, 100% { opacity: .55; } 50% { opacity: .95; } }
.cpx-kbd { font-family: var(--cpx-mono); font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }

/* --- chat companion strip -------------------------------------------- */
.cpx-chat-strip {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 0 0 8px; padding: 7px 12px; min-height: 34px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-secondary); font-size: 12.5px;
}
.cpx-chat-strip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.cpx-chat-strip button {
  border: 0; background: transparent; color: var(--dsw-alias-brand-primary);
  font: inherit; font-size: 12.5px; cursor: pointer; text-decoration: underline; white-space: nowrap;
}

/* --- responsive ------------------------------------------------------- */
@media (max-width: 1180px) {
  .cpx-split { grid-template-columns: minmax(0, 1fr); gap: var(--cpx-s5); }
  .cpx-aside { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: var(--cpx-s4); }
}
@media (max-width: 1180px) {
  .cpx-scene-window, .cpx-scene-desk, .cpx-scene-lamp { display: none; }
  .cpx-scene-state { max-width: min(26ch, 100%); }
}
@media (max-width: 900px) {
  .cpx-page { padding-top: var(--cpx-s5); }
  .cpx-title { font-size: 23px; }
  .cpx-scene-state { font-size: 24px; }
}
@media (max-width: 760px) {
  .cpx-app { grid-template-columns: minmax(0, 1fr); }
  .cpx-nav-toggle { display: inline-flex; }
  .cpx-rail {
    position: fixed; top: 0; bottom: 0; left: 0; z-index: 60;
    width: min(286px, 86vw); --cpx-rail: 286px;
    border-right: 1px solid var(--dsw-alias-border-l2);
    box-shadow: 24px 0 60px -40px rgba(0, 0, 0, .6);
    transform: translateX(-102%); transition: transform .18s ease;
  }
  .cpx-app[data-drawer="open"] .cpx-rail { transform: none; }
  .cpx-app[data-drawer="open"] .cpx-drawer-backdrop {
    display: block; position: fixed; inset: 0; z-index: 50;
    background: rgba(12, 14, 19, .34);
  }
  .cpx-app[data-rail="collapsed"] .cpx-brand,
  .cpx-app[data-rail="collapsed"] .cpx-nav-text,
  .cpx-app[data-rail="collapsed"] .cpx-nav-label,
  .cpx-app[data-rail="collapsed"] .cpx-theme-btn,
  .cpx-app[data-rail="collapsed"] .cpx-rail-toggle-text { display: revert; }
  .cpx-app[data-rail="collapsed"] .cpx-nav-item { justify-content: flex-start; padding: 8px 10px; }
  .cpx-page { padding: var(--cpx-s4) var(--cpx-s4) 64px; }
  .cpx-tabs { padding: 0 var(--cpx-s4); }
  .cpx-scene { min-height: 200px; padding: var(--cpx-s5); background: linear-gradient(180deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-layer-2)); }
  .cpx-scene-window, .cpx-scene-desk, .cpx-scene-lamp, .cpx-scene-floor { display: none; }
  .cpx-scene-sky { height: 46%; opacity: .7; }
  .cpx-scene-state { font-size: 22px; }
  .cpx-page-head { flex-direction: column; align-items: stretch; }
}
@media (prefers-reduced-motion: reduce) {
  .cpx-app *, .cpx-app *::before, .cpx-app *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`);

// Shared primitive restyle. Class names stay `cmx-*` so every page keeps working;
// only the visual language changes (warm surfaces, thinner borders, calmer type).
P.css(`
.cmx-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.cmx-hint { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small); }
.cmx-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cmx-spacer { flex: 1; }
.cmx-section { display: flex; flex-direction: column; gap: 10px; }
.cmx-section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cmx-section-title { margin: 0; font-size: var(--cpx-fs-section); font-weight: 600; }
.cmx-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--cpx-r-md); overflow: hidden; }
.cmx-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 12px 14px; }
.cmx-card-title { margin: 0; font-size: 14px; font-weight: 600; }
.cmx-card-body { padding: 0 14px 14px; display: flex; flex-direction: column; gap: 10px; }
.cmx-grid { display: grid; gap: 10px; }
.cmx-grid-2 { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.cmx-grid-3 { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
.cmx-grid-4 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.cmx-stat { display: flex; flex-direction: column; gap: 2px; padding: 10px 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); background: transparent; text-align: left; font: inherit; color: inherit; }
.cmx-grid .cmx-stat { border-top: 0; padding: 0; }
.cmx-stat-clickable { cursor: pointer; }
.cmx-stat-clickable:hover .cmx-stat-value { color: var(--dsw-alias-brand-primary); }
.cmx-stat-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.cmx-stat-value { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; overflow-wrap: anywhere; }
.cmx-stat-hint { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.cmx-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11.5px; white-space: nowrap; }
.cmx-badge-brand { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, var(--dsw-alias-border-l1)); }
.cmx-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, var(--dsw-alias-border-l1)); }
.cmx-badge-warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, var(--dsw-alias-border-l1)); }
.cmx-badge-danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, var(--dsw-alias-border-l1)); }
.cmx-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: var(--cpx-r-sm); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; }
.cmx-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.cmx-btn:disabled { opacity: .5; cursor: not-allowed; }
.cmx-btn-sm { padding: 4px 10px; font-size: 12px; }
.cmx-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); font-weight: 600; }
.cmx-btn-primary:hover:not(:disabled) { filter: brightness(1.06); }
.cmx-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, var(--dsw-alias-border-l1)); }
.cmx-btn-ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); padding-left: 8px; padding-right: 8px; }
.cmx-btn-ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); }
.cmx-input, .cmx-select { padding: 7px 10px; border-radius: var(--cpx-r-sm); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13.5px; min-width: 0; }
.cmx-input:focus-visible, .cmx-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cmx-textarea { resize: vertical; width: 100%; box-sizing: border-box; line-height: 1.6; }
.cmx-toggle { display: flex; gap: 8px; align-items: flex-start; font-size: 13.5px; }
.cmx-toggle input { margin-top: 4px; accent-color: var(--dsw-alias-brand-primary); }
.cmx-toggle-label { display: block; }
.cmx-table-wrap { overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--cpx-r-sm); background: var(--dsw-alias-bg-layer-1); }
.cmx-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cmx-table th { position: sticky; top: 0; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-weight: 500; text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.cmx-table td { padding: 7px 10px; border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 60%, transparent); vertical-align: top; overflow-wrap: anywhere; }
.cmx-table tr:last-child td { border-bottom: 0; }
.cmx-row-clickable { cursor: pointer; }
.cmx-kv { display: grid; grid-template-columns: minmax(88px, max-content) 1fr; gap: 5px 14px; margin: 0; font-size: 13px; }
.cmx-kv-row { display: contents; }
.cmx-kv dt { color: var(--dsw-alias-label-secondary); }
.cmx-kv dd { margin: 0; overflow-wrap: anywhere; }
.cmx-mono, .cmx-mono-inline { font-family: var(--cpx-mono); font-size: 11.5px; }
.cmx-mono-inline { padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); }
.cmx-break { word-break: break-all; }
.cmx-bar { height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.cmx-bar-fill { height: 100%; background: var(--dsw-alias-brand-primary); }
.cmx-bar-ok .cmx-bar-fill { background: var(--dsw-alias-state-success-primary); }
.cmx-bar-warn .cmx-bar-fill { background: var(--dsw-alias-state-warn-primary); }
.cmx-bar-danger .cmx-bar-fill { background: var(--dsw-alias-state-error-primary); }
.cmx-empty, .cmx-loading, .cmx-error { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 26px 16px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--cpx-r-md); color: var(--dsw-alias-label-secondary); text-align: center; }
.cmx-error { border-style: solid; color: var(--dsw-alias-state-error-primary); flex-direction: row; justify-content: space-between; text-align: left; }
.cmx-empty-compact { border: 0; padding: 6px 0; align-items: flex-start; text-align: left; background: transparent; }\n.cmx-empty-inline { padding: 14px 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.cmx-tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.cmx-tab { display: inline-flex; align-items: center; gap: 6px; padding: 7px 11px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.cmx-tab-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.cmx-drawer-root { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: flex-end; }
.cmx-drawer-backdrop { position: absolute; inset: 0; background: rgba(12, 14, 19, .26); }
/* 宽屏只做很轻的压暗：左侧列表与导航仍要辨认得清，不能糊成一块黑。 */
@media (min-width: 1280px) { .cmx-drawer-backdrop { background: rgba(12, 14, 19, .14); } }
@media (prefers-reduced-transparency: reduce) { .cmx-drawer-backdrop { background: rgba(12, 14, 19, .38); } }
.cmx-drawer { position: relative; display: flex; flex-direction: column; width: min(560px, 94vw); height: 100%; background: var(--dsw-alias-bg-layer-1); border-left: 1px solid var(--dsw-alias-border-l2); box-shadow: -24px 0 60px -40px rgba(0, 0, 0, .5); }
.cmx-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.cmx-drawer-title { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.cmx-drawer-body { flex: 1; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.cmx-drawer-foot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); flex-wrap: wrap; }
.cmx-toasts { position: fixed; right: 16px; bottom: 16px; z-index: 90; display: flex; flex-direction: column; gap: 8px; }
.cmx-toast { padding: 9px 13px; border-radius: var(--cpx-r-sm); background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); font-size: 13px; max-width: 360px; animation: cmx-toast-life 4.4s ease forwards; box-shadow: 0 12px 30px -18px rgba(0, 0, 0, .45); overflow-wrap: anywhere; }
.cmx-toast-ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-border-l1)); }
.cmx-toast-danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-border-l1)); }
@keyframes cmx-toast-life { 0% { opacity: 0; transform: translateY(6px); } 8% { opacity: 1; transform: none; } 90% { opacity: 1; } 100% { opacity: 0; } }
.cmx-spinner { width: 11px; height: 11px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, transparent); border-top-color: var(--dsw-alias-brand-primary); animation: cmx-spin .8s linear infinite; display: inline-block; }
@keyframes cmx-spin { to { transform: rotate(360deg); } }
.cmx-pre { margin: 0; padding: 10px 12px; border-radius: var(--cpx-r-sm); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); font-family: var(--cpx-mono); font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 340px; }
.cmx-md { display: flex; flex-direction: column; gap: 8px; font-size: 14px; max-width: 72ch; }
.cmx-md h3, .cmx-md h4, .cmx-md h5, .cmx-md h6 { margin: 12px 0 4px; font-size: 15px; }
.cmx-md h2 { margin: 14px 0 6px; font-size: 17px; }
.cmx-md p { margin: 0; overflow-wrap: anywhere; }
.cmx-md ul, .cmx-md ol { margin: 0; padding-left: 20px; }
.cmx-md blockquote { margin: 0; padding: 6px 12px; border-left: 2px solid var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 0 var(--cpx-r-sm) var(--cpx-r-sm) 0; }
.cmx-md-p { line-height: 1.75; }
.cmx-code-inline { padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); font-family: var(--cpx-mono); font-size: 12px; }
.cmx-tone-danger .cmx-stat-value { color: var(--dsw-alias-state-error-primary); }
.cmx-tone-warn .cmx-stat-value { color: var(--dsw-alias-state-warn-primary); }
.cmx-tone-ok .cmx-stat-value { color: var(--dsw-alias-state-success-primary); }
.cmx-hidden-note { padding: 8px 10px; border-radius: var(--cpx-r-sm); border: 1px dashed color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-border-l1)); color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
@media (prefers-reduced-motion: reduce) {
  .cmx-toast, .cmx-spinner { animation: none !important; }
}
`);

// ---------------------------------------------------------------------------
// 7. Shell
// ---------------------------------------------------------------------------

function themeIcon(preference) {
  if (preference === 'light') return 'sun';
  if (preference === 'dark') return 'moon';
  return 'system';
}

const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };

function ThemeSwitch({ compact }) {
  const [preference, setPreference] = React.useState(() => P.theme.preference());
  React.useEffect(() => P.theme.subscribe((snapshot) => {
    if (snapshot && snapshot.preference) setPreference(snapshot.preference);
  }), []);
  const apply = (id) => {
    const ok = P.theme.set(id);
    setPreference(id);
    if (!ok) {
      // Host theme service missing: still honor the local choice for this session.
      try { document.documentElement.dataset.cpxTheme = id; } catch { /* ignore */ }
    }
  };
  const ids = ['system', 'light', 'dark'];
  return h('div', { className: compact ? 'cpx-theme-row' : 'cpx-theme-row', role: 'group', 'aria-label': '外观主题' },
    ids.map((id) => h('button', {
      key: id,
      type: 'button',
      className: 'cpx-theme-btn',
      'aria-pressed': preference === id,
      title: THEME_LABEL[id],
      'aria-label': `主题：${THEME_LABEL[id]}`,
      onClick: () => apply(id),
    }, h(Icon, { name: themeIcon(id), size: 15 }))));
}

function Rail({ collapsed, onToggle, compact, onCompact, compactAvailable }) {
  const [page, setPage] = React.useState(() => navState.page);
  const remember = React.useCallback((id) => setPage(id), []);

  React.useEffect(() => P.nav.subscribe(remember), [remember]);

  const activeNavId = React.useMemo(() => {
    const direct = NAV.find((item) => item.id === page);
    if (direct) return direct.id;
    const group = NAV.find((item) => Array.isArray(item.tabs) && item.tabs.includes(page));
    return group ? group.id : 'home';
  }, [page]);

  const groups = [
    { label: '陪伴', ids: ['home', 'chat', 'life'] },
    { label: '记录', ids: ['memory'] },
    { label: '工具', ids: ['connections', 'workspace'] },
    { label: '系统', ids: ['settings'] },
  ];

  const go = (item) => {
    if (item.native) {
      const ok = P.nav.openPanel(item.native);
      if (!ok) {
        P.toastOnce('宿主导航服务不可用，暂时回不到原生聊天。');
        return;
      }
      // The host panel took over; remember nothing about our own page.
      return;
    }
    if (Array.isArray(item.tabs) && item.tabs.length) {
      const remembered = readStore(`cpx.tab.${item.id}`, '');
      const target = item.tabs.includes(remembered) ? remembered : item.tabs[0];
      P.nav.go(target);
      return;
    }
    P.nav.go(item.id);
  };

  return h('nav', { className: 'cpx-rail', id: 'cpx-nav', 'aria-label': `${PRODUCT}导航` },
    h('div', { className: 'cpx-rail-head' },
      h('span', { className: 'cpx-brand-mark' }, h(Icon, { name: 'snow', size: 18 })),
      h('span', { className: 'cpx-brand' },
        h('span', { className: 'cpx-brand-name' }, PRODUCT),
        h('span', { className: 'cpx-brand-state' }, '本地陪伴'))),
    h('div', { className: 'cpx-nav' },
      groups.map((group) => h('div', { key: group.label, className: 'cpx-nav-group' },
        h('span', { className: 'cpx-nav-label' }, group.label),
        group.ids.map((id) => {
          const item = NAV.find((entry) => entry.id === id);
          if (!item) return null;
          return h('button', {
            key: item.id,
            type: 'button',
            className: cx('cpx-nav-item', item.native ? 'cpx-nav-exit' : ''),
            'aria-current': activeNavId === item.id ? 'page' : undefined,
            title: item.hint,
            onClick: () => go(item),
          },
          h(Icon, { name: item.icon, size: 17 }),
          h('span', { className: 'cpx-nav-text' }, item.label));
        })))),
    h('div', { className: 'cpx-rail-foot' },
      h(ThemeSwitch, { compact: true }),
      h('button', {
        type: 'button',
        className: 'cpx-rail-action',
        onClick: onCompact,
        'aria-pressed': compact ? 'true' : 'false',
        disabled: !compactAvailable,
        title: compactAvailable
          ? '临时收起宿主左侧的会话栏，只留这个面板；离开面板会自动恢复'
          : '宿主没有提供侧栏控制服务',
        'aria-label': compact ? '恢复宿主会话栏' : '收起宿主会话栏（紧凑布局）',
      }, h(Icon, { name: 'panel', size: 15 }),
      h('span', { className: 'cpx-rail-toggle-text' }, compact ? '会话栏已收起' : '紧凑布局')),
      h('button', {
        type: 'button',
        className: 'cpx-rail-toggle',
        onClick: onToggle,
        'aria-expanded': !collapsed,
        'aria-label': collapsed ? '展开导航' : '收起导航',
        title: collapsed ? '展开导航' : '收起导航',
      }, h(Icon, { name: collapsed ? 'expand' : 'collapse', size: 15 }),
      h('span', { className: 'cpx-rail-toggle-text' }, collapsed ? '展开' : '收起导航'))));
}

function StalePage({ id }) {
  return h('div', { className: 'cpx-page' },
    h('div', { className: 'cpx-page-head' },
      h('div', { className: 'cpx-page-heading' },
        h('h1', { className: 'cpx-title' }, PRODUCT),
        h('p', { className: 'cpx-lead' }, '这个页面片段没有随客户端一起构建，先回到首页。'))),
    h(Callout, { tone: 'warn', title: '缺少页面', action: h(Button, { size: 'sm', onClick: () => P.nav.go('home') }, '回首页') },
      h('span', { className: 'cmx-mono-inline' }, String(id))));
}

function Shell() {
  const [page, setPage] = React.useState(() => {
    const stored = readStore('cpx.page', 'home');
    return stored || 'home';
  });
  const [drawer, setDrawer] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(() => readStore('cpx.rail', 'expanded') === 'collapsed');
  const [compact, setCompact] = React.useState(false);
  const compactOwned = React.useRef(false);
  const [themePreference, setThemePreference] = React.useState(() => P.theme.preference());
  const [notices, setNotices] = React.useState([]);
  const mainRef = React.useRef(null);
  const toggleRef = React.useRef(null);

  React.useEffect(() => P.nav.subscribe((next) => setPage(next)), []);
  React.useEffect(() => P.theme.subscribe((snapshot) => {
    if (snapshot && snapshot.preference) setThemePreference(snapshot.preference);
  }), []);
  // 提示的存活只由计时器决定：prefers-reduced-motion 会关掉 CSS 动画，
  // animationend 就永远不会来，提示会一直挂在角落（真实窗口里复现过）。
  const noticeTimers = React.useRef(new Map());
  React.useEffect(() => {
    const timers = noticeTimers.current;
    const listener = (notice) => {
      setNotices((previous) => [...previous, notice].slice(-3));
      const running = timers.get(notice.id);
      if (running) clearTimeout(running);
      timers.set(notice.id, setTimeout(() => {
        timers.delete(notice.id);
        setNotices((previous) => previous.filter((item) => item.id !== notice.id));
      }, 4200));
    };
    noticeListeners.add(listener);
    return () => {
      noticeListeners.delete(listener);
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  React.useEffect(() => {
    navState.page = page;
    writeStore('cpx.page', page);
  }, [page]);

  React.useEffect(() => {
    writeStore('cpx.rail', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);

  // 紧凑布局只在面板存在期间有效：卸载（切回聊天/其它面板）时恢复宿主侧栏。
  React.useEffect(() => () => {
    if (compactOwned.current) {
      compactOwned.current = false;
      P.hostLayout.restore();
    }
  }, []);

  const toggleCompact = React.useCallback(() => {
    setCompact((previous) => {
      const next = !previous;
      if (next) compactOwned.current = P.hostLayout.collapse();
      else if (compactOwned.current) {
        compactOwned.current = false;
        P.hostLayout.restore();
      }
      return next;
    });
  }, []);

  // Escape closes the mobile drawer and returns focus to its toggle.
  React.useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setDrawer(false);
        const toggle = toggleRef.current;
        if (toggle && typeof toggle.focus === 'function') toggle.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const pages = React.useMemo(() => [...P.pages].sort((left, right) => left.order - right.order), []);
  const byId = React.useMemo(() => {
    const map = {};
    pages.forEach((entry) => { map[entry.id] = entry; });
    return map;
  }, [pages]);

  const activeNav = React.useMemo(() => {
    const direct = NAV.find((item) => item.id === page);
    if (direct) return direct;
    return NAV.find((item) => Array.isArray(item.tabs) && item.tabs.includes(page)) || NAV[0];
  }, [page]);

  const tabIds = Array.isArray(activeNav.tabs) ? activeNav.tabs : null;
  const current = byId[page] || null;

  React.useEffect(() => {
    if (!tabIds || !tabIds.includes(page)) return;
    writeStore(`cpx.tab.${activeNav.id}`, page);
  }, [page, activeNav.id, tabIds]);

  const selectTab = (id) => { P.nav.go(id); setDrawer(false); };

  const body = current
    ? h(current.component, { key: current.id })
    : h(StalePage, { id: page });

  return h('div', {
    className: 'cpx-root',
  }, h('div', {
    className: 'cpx-app',
    'data-rail': collapsed ? 'collapsed' : 'expanded',
    'data-drawer': drawer ? 'open' : 'closed',
    'data-theme': themePreference,
  },
  h('a', { className: 'cpx-skip', href: '#cpx-main' }, '跳到主要内容'),
  h(Rail, {
    collapsed,
    onToggle: () => setCollapsed((value) => !value),
    compact,
    onCompact: toggleCompact,
    compactAvailable: P.hostLayout.canToggle(),
  }),
  h('div', { className: 'cpx-drawer-backdrop', onClick: () => setDrawer(false), 'aria-hidden': 'true' }),
  h('main', { className: 'cpx-main', id: 'cpx-main', ref: mainRef, tabIndex: -1 },
    h('button', {
      type: 'button',
      className: 'cpx-nav-toggle',
      ref: toggleRef,
      'aria-expanded': drawer,
      'aria-controls': 'cpx-nav',
      onClick: () => setDrawer((value) => !value),
    }, h(Icon, { name: 'menu', size: 16 }), h('span', null, PRODUCT)),
    tabIds
      ? h('div', { className: 'cpx-tabs', role: 'tablist', 'aria-label': `${activeNav.label}分类` },
        tabIds.map((id) => {
          const def = byId[id];
          if (!def) return null;
          return h('button', {
            key: id,
            type: 'button',
            role: 'tab',
            className: 'cpx-tab',
            'aria-selected': id === page,
            'aria-current': id === page ? 'page' : undefined,
            onClick: () => selectTab(id),
          }, def.label);
        }))
      : null,
    h('div', { className: 'cpx-scroll' }, body)),
  h(ToastHost, { toasts: notices })));
}

// Life states as reported by the runtime, mapped to the shell's semantic dots.
const LIFE_TONE = {
  running: 'live',
  resting: 'ok',
  upcoming: 'idle',
  'today-done': 'ok',
  'no-plan': 'idle',
  'no-autonomy': 'warn',
};
P.lifeTone = (state) => LIFE_TONE[String(state)] || 'idle';

// ---------------------------------------------------------------------------
// 8. Chat strip: one line of companion context above the composer
// ---------------------------------------------------------------------------

const STATE_TEXT = {
  running: '正在做一件事',
  resting: '在休息',
  upcoming: '还有安排',
  'today-done': '今天的安排都过去了',
  'no-plan': '今天还没有安排',
  'no-autonomy': '自主规划未启用',
};

function ChatCompanionStrip() {
  const [summary, setSummary] = React.useState(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    P.api.get('companion').then(
      (data) => { if (!cancelled) setSummary(data); },
      () => { if (!cancelled) setFailed(true); },
    ).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const open = () => {
    const layout = P.services.layout;
    if (layout && typeof layout.selectPanel === 'function') {
      try { layout.selectPanel(PANEL_ID); return; } catch { /* fall through */ }
    }
  };

  if (failed || !summary) return null;
  const life = summary.life || null;
  if (!life) return null;
  const stateText = STATE_TEXT[life.state] || '状态未知';
  const next = Array.isArray(life.next) && life.next.length ? life.next[0] : null;
  const current = life.current && life.current.slot ? life.current.slot : null;
  const line = current
    ? `${stateText}：${current.title || current.activity || '一段安排'}`
    : next
      ? `${stateText} · 接下来 ${P.fmt.clock(next.startAt)} ${next.title || ''}`
      : stateText;
  return h('div', { className: 'cpx-chat-strip', role: 'note', 'aria-label': '陪伴状态摘要' },
    h(StateLine, { state: life.state === 'running' ? 'live' : life.state === 'resting' ? 'ok' : 'idle', text: '陪伴角色' }),
    h('span', { className: 'cpx-chat-strip-text' }, line),
    h('button', { type: 'button', onClick: open }, '打开陪伴空间'));
}

// ---------------------------------------------------------------------------
// 9. Locale + apply
// ---------------------------------------------------------------------------

const DICTIONARIES = {
  zh: { panel: PRODUCT, title: PRODUCT },
  en: { panel: 'Companion Space', title: 'Companion Space' },
};

function translate(ctx) {
  const fallback = (key) => (DICTIONARIES.zh[key] || key);
  try {
    const bound = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null;
    if (typeof bound === 'function') {
      return (key) => {
        try { return bound(key) || fallback(key); } catch { return fallback(key); }
      };
    }
  } catch { /* locale is optional */ }
  return fallback;
}

// Theme layer: the whole application palette, warm in light mode and ink-blue in
// dark mode, with a low-saturation sakura brand. Overriding alias tokens keeps
// the base themes intact and every native surface (sidebar, chat, composer,
// approval cards) follows along; removing the layer restores the defaults.
const THEME_TOKENS = {
  '--dsw-alias-bg-base': { light: '#faf8f6', dark: '#14161c' },
  '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#1b1e26' },
  '--dsw-alias-bg-layer-2': { light: '#f4f1ee', dark: '#22262f' },
  '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#262b35' },
  '--dsw-alias-border-l1': { light: '#e7e2dc', dark: '#333944' },
  '--dsw-alias-border-l2': { light: '#d3ccc4', dark: '#454d5b' },
  '--dsw-alias-brand-primary': { light: '#a33d63', dark: '#f4a8c8' },
  '--dsw-alias-label-primary': { light: '#23252c', dark: '#edf0f5' },
  '--dsw-alias-label-secondary': { light: '#5d6069', dark: '#aab2c0' },
  '--dsw-alias-state-error-primary': { light: '#b3352f', dark: '#f08a84' },
  '--dsw-alias-state-idle-primary': { light: '#7a7d86', dark: '#8b93a1' },
  '--dsw-alias-state-success-primary': { light: '#1f7a5c', dark: '#6fd0a8' },
  '--dsw-alias-state-warn-primary': { light: '#8a5a12', dark: '#e6c07a' },
  '--dsw-specific-sidebar-fill': { light: '#f4f1ee', dark: '#171a21' },
};

function optionalService(ctx, key) {
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(key);
      if (service) return service;
    }
  } catch { /* service absent */ }
  try { return ctx[key] || null; } catch { return null; }
}

function apply(ctx) {
  const t = translate(ctx);
  try {
    if (ctx.locale && typeof ctx.locale.register === 'function') {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'companion-memory-studio: dictionaries');
    }
  } catch { /* a locale failure must not hide the panel */ }

  const SERVICE_KEYS = ['theme', 'layout', 'uiWorkspace', 'sessions', 'workspaces'];
  const refreshServices = () => {
    let missing = false;
    for (const key of SERVICE_KEYS) {
      const current = P.services[key];
      if (current) continue;
      const late = optionalService(ctx, key);
      if (late) P.services[key] = late;
      else missing = true;
    }
    return !missing;
  };
  refreshServices();

  // 宿主侧服务可能晚于本插件激活（真实桌面与隔离宿主都出现过）。补齐后立刻停止轮询；
  // 最多试 24 次（≈6s），卸载时清掉，不留后台定时器。
  if (!refreshServices()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (refreshServices() || tries >= 24) clearInterval(timer);
    }, 250);
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref();
    const effect = typeof ctx.effect === 'function' ? ctx.effect : (runner) => { try { return runner(); } catch { return () => {}; } };
    effect(() => () => clearInterval(timer), 'companion-memory-studio: late service refresh');
  }

  // Seed the snapshot so the rail shows the user's real preference immediately.
  try {
    if (P.services.theme && typeof P.services.theme.getTheme === 'function') {
      P.theme.accept(P.services.theme.getTheme());
    }
  } catch { /* ignore */ }

  // Theme layers are effects: unloading the plugin restores the shipped palette.
  const effect = typeof ctx.effect === 'function' ? ctx.effect : (runner) => { try { return runner(); } catch { return () => {}; } };
  if (P.services.theme && typeof P.services.theme.overrideTokens === 'function') {
    effect(() => P.services.theme.overrideTokens(NS, THEME_TOKENS), 'companion-memory-studio: theme tokens');
  }

  try {
    if (typeof ctx.on === 'function') {
      const off = ctx.on('theme/change', (snapshot) => P.theme.accept(snapshot));
      effect(() => off, 'companion-memory-studio: theme events');
    }
  } catch { /* event bus absent */ }

  effect(() => {
    if (typeof document === 'undefined') return () => {};
    const element = document.createElement('style');
    element.setAttribute('data-plugin', 'companion-memory-studio');
    element.textContent = P._styles.join('\n');
    document.head.appendChild(element);
    return () => { element.remove(); };
  }, 'companion-memory-studio: styles');

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('panel'),
    locale: NS,
  }, PanelIcon));

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    children: {},
  }, Shell));

  // Companion context beside the native composer: additive, silent when the
  // companion API is unavailable, and it never sends anything.
  try {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'companion-strip',
      order: 40,
      locale: NS,
    }, ChatCompanionStrip));
  } catch { /* slot absent in this composition */ }
}

function PanelIcon({ size }) {
  const edge = typeof size === 'number' ? size : 18;
  return h('svg', {
    width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none',
    'aria-hidden': true, focusable: 'false',
  },
  h('path', { d: 'M4.5 8.2c2.6-3.6 6.2-4.9 9.4-3.6 2.9 1.2 4.1 4.1 3.3 6.7', stroke: 'currentColor', strokeOpacity: '.55', strokeWidth: '1.3', strokeLinecap: 'round' }),
  h('path', { d: 'M3.6 12.4h4.1l1.1 1.9h6.4l1.1-1.9h4.1v5.3a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6z', stroke: 'currentColor', strokeWidth: '1.4', strokeLinejoin: 'round' }),
  h('path', { d: 'M12 3.4l1.05 2.35 2.55.28-1.9 1.73.53 2.5L12 8.95l-2.23 1.31.53-2.5-1.9-1.73 2.55-.28z', fill: 'currentColor', fillOpacity: '.9' }));
}

// The notice channel feeds the shell's toast host.
const shellNoticeHost = { push: null };

P.apply = apply;
P.PANEL_ID = PANEL_ID;
P.NS = NS;
P.NAV = NAV;
P.THEME_LABEL = THEME_LABEL;

// ==== src/client/pages-home.js ====
(function (P) {
  const { h, ui } = P;

  P.css(`
    .cpxp-home-next { display: flex; flex-direction: column; gap: 2px; }
    .cpxp-home-next-row { display: flex; align-items: baseline; gap: 12px; padding: 10px 8px; border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent); width: 100%; border-left: 0; border-right: 0; border-bottom: 0; background: transparent; color: inherit; font: inherit; text-align: left; border-radius: var(--cpx-r-sm); }
    .cpxp-home-next-row:first-child { border-top: 0; }
    .cpxp-home-next-row[data-clickable="true"] { cursor: pointer; }
    .cpxp-home-next-row[data-clickable="true"]:hover { background: var(--dsw-alias-bg-layer-2); }
    .cpxp-home-when { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); font-size: 12.5px; white-space: nowrap; flex: none; min-width: 92px; }
    .cpxp-home-what { min-width: 0; flex: 1; overflow-wrap: anywhere; }
    .cpxp-home-sub { color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
    .cpxp-home-events { display: flex; flex-direction: column; min-width: 0; }
    .cpxp-home-event { display: flex; flex-direction: column; gap: 2px; padding: 10px 0; border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent); min-width: 0; }
    .cpxp-home-event:first-child { border-top: 0; }
    .cpxp-home-event-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; min-width: 0; }
    .cpxp-home-event-at { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
    .cpxp-home-event-source { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; white-space: nowrap; flex: none; padding: 0 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 80%, transparent); }
    .cpxp-home-event-source[data-source="user"] { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent); }
    .cpxp-home-event-source[data-source="assistant"] { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, transparent); }
    .cpxp-home-event-source[data-source="tool"] { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent); }
    .cpxp-home-event-source[data-source="system"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
    .cpxp-home-event-source[data-raw="true"] { font-size: 11px; }
    .cpxp-home-event-text { flex: 1; min-width: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .cpxp-home-event-tech { min-width: 0; }
    .cpxp-home-event-tech .cpx-diag { border-top: 0; padding-top: 2px; }
    .cpxp-home-event-raw { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; }
    .cpxp-home-event-meta { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.6; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .cpxp-home-aside-action { border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 13px; cursor: pointer; padding: 4px 0; text-align: left; text-decoration: underline; align-self: flex-start; }
    .cpxp-home-links { display: flex; flex-wrap: wrap; gap: 8px; }
    .cpxp-home-now { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
    .cpxp-home-vitals { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--cpx-s3, 12px); min-width: 0; }
    .cpxp-home-vital-fresh { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; margin-top: 6px; }
    .cpxp-home-vital-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.7; overflow-wrap: anywhere; max-width: 72ch; }
    @media (max-width: 760px) { .cpxp-home-vitals { grid-template-columns: 1fr; } }
  `);

  const ACTIVITY_LABEL = { read: '阅读', explore: '探索', write: '创作' };
  const SLOT_KIND = { activity: '活动', rest: '休息' };
  const STATE_SENTENCE = {
    running: '正在做一件事',
    resting: '在休息',
    upcoming: '还有安排',
    'today-done': '今天的安排都过去了',
    'no-plan': '今天还没有安排',
    'no-autonomy': '自主规划未启用',
  };
  // 解释类文案只留在悬停 ⓘ 里（2026-11-04 文案规则）：对象内部只写事实、数字与状态词。
  const HOME_INFO = '只读：不会替你发消息，也不会替她做决定。';
  const HERO_INFO = '读不到只说明这一页没拿到数据，不等于她没有安排；计划只是打算，没有回执的事不算已经做过；标了模拟/假设的活动不是真实发生的；闲置是允许的状态。';

  const clock = (value) => P.fmt.clock(value);

  // ---------------------------------------------------------------------------
  // 「最近一起经历的事」的来源投影
  //
  // GET timeline?limit=6 的 items[] 只给截断正文（preview ≤ 160 字）。它可能是
  // QQ 路由抬头、长链接、命令参数、JSON 片段或代码围栏。首页只需要「谁、做了
  // 什么」一句话：来源标签写死成中文（你 / 她 / 工具 / 对话 / 导入 / 系统 …），
  // 正文按规则收成人话；完整原文与 sessionId / seq / type 只进每行的
  // ui.Diagnostic（默认折叠）。工具来源的行不写「你说」「她记得」这类事实句。
  // ---------------------------------------------------------------------------

  const SUMMARY_LIMIT = 60;
  const CJK = /[\u4e00-\u9fff]/u;
  const TOOL_TYPE = /(?:tool|command|shell|exec|terminal|\bcmd\b)/iu;
  const OPERATION_TYPE = /(?:tool|command|shell|exec|terminal|\bcmd\b|system|runtime|heartbeat)/iu;
  const TYPE_LABEL = {
    transcript: '对话', conversation: '对话', dialog: '对话', dialogue: '对话', chat: '对话',
    desktop_conversation: '对话',
    import: '导入', imported: '导入', astrbot_import: '导入', migration: '导入',
    system: '系统', runtime: '系统', heartbeat: '系统',
    desktop_fact: '事实', fact: '事实', memory: '记忆', memory_event: '记忆',
    note: '笔记', manual: '手工记录', extracted: '抽取', wiki: 'Wiki', event: '事件',
  };
  const ROLE_LABEL = { user: '你', assistant: '她', imported: '导入', system: '系统', runtime: '系统', tool: '工具' };
  const ACTION_LABEL = {
    探索: '检索', 检索: '检索', 搜索: '检索', 读取: '读取', 查看: '读取',
    写入: '写入', 保存: '写入', 执行: '执行', 生成: '生成',
  };
  const ACTION_HINTS = [
    { verb: '检索', pattern: /(?:https?:\/\/|search|query|grep|fetch|browse|检索|搜索|探索)/iu },
    { verb: '读取', pattern: /(?:read\b|cat\b|open\b|读取|查看|打开)/iu },
    { verb: '写入', pattern: /(?:write|edit|patch|save|写入|保存|创建|修改)/iu },
    { verb: '生成', pattern: /(?:generate|image|draw|生图|绘图|生成)/iu },
    { verb: '执行', pattern: /(?:exec|shell|command|terminal|run\b|npm|pnpm|node\s|git\s|运行|执行|命令)/iu },
  ];
  // 摘要里会出现的固定占位：同一种连写多次时合并成一次。
  const MASK_TOKENS = ['（标识已隐去）', '（号码已隐去）', '（哈希已隐去）', '（结构化片段已略）', '（英文片段已略）'];

  /** 来源标签：对话/工具/导入/系统都写中文；认不出的 type 原样显示但更小。 */
  function sourceOf(event) {
    const role = String((event && event.role) || '');
    const type = String((event && event.type) || '');
    if (role === 'user') return { key: 'user', label: '你' };
    if (role === 'assistant') return { key: 'assistant', label: '她' };
    if (TOOL_TYPE.test(type) || role === 'tool') return { key: 'tool', label: '工具' };
    const key = OPERATION_TYPE.test(type) || OPERATION_TYPE.test(role) ? 'system' : 'other';
    const mapped = type ? (TYPE_LABEL[type] || TYPE_LABEL[type.toLowerCase()]) : '';
    if (mapped) return { key, label: mapped };
    if (type) return { key, label: type, raw: true };
    if (role) return { key, label: ROLE_LABEL[role] || role, raw: !ROLE_LABEL[role] };
    return { key: 'other', label: '记录' };
  }

  /** 链接只留「域名/…」：读得懂来源，又不把整串 URL 铺在首页。 */
  function hostOf(url) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/iu.exec(String(url ?? ''));
    if (!match) return '链接已隐去';
    return `${match[1].replace(/^www\./iu, '').toLowerCase()}/…`;
  }

  /** 长路径缩成文件名；两级以内的相对路径本来就短，保持原样。 */
  function shortenPath(match) {
    const parts = String(match).split(/[\\/]+/u).filter(Boolean);
    return parts.length > 2 ? `…/${parts[parts.length - 1]}` : match;
  }

  /**
   * 找出一对配对的 `{}` / `[]` 区间（简易计数即可，preview 只有 160 字）。
   * 外层区间先出现，切掉整段就等于把嵌套的键值对一起收掉。
   */
  function braceSpans(text) {
    const spans = [];
    const pairs = { '{': '}', '[': ']' };
    for (let start = 0; start < text.length; start += 1) {
      const open = text[start];
      const close = pairs[open];
      if (!close) continue;
      let depth = 0;
      let end = -1;
      for (let cursor = start; cursor < text.length; cursor += 1) {
        if (text[cursor] === open) depth += 1;
        else if (text[cursor] === close) {
          depth -= 1;
          if (depth === 0) { end = cursor; break; }
        }
      }
      if (end > start) spans.push({ start, end });
    }
    return spans;
  }

  const looksStructured = (chunk) => /"[^"\n]{0,40}"\s*:/u.test(chunk) || /^\s*\[[^\[\]]*\d/u.test(chunk);

  /** 整段 JSON / 数组（带 "key": 且 ≥ 40 字）收成一句占位。 */
  function stripJson(text) {
    const spans = braceSpans(text);
    if (!spans.length) return text;
    let output = '';
    let cursor = 0;
    for (const span of spans) {
      if (span.start < cursor) continue;
      const chunk = text.slice(span.start, span.end + 1);
      if (chunk.length < 40 || !looksStructured(chunk)) continue;
      output += `${text.slice(cursor, span.start)} （结构化片段已略） `;
      cursor = span.end + 1;
    }
    return `${output}${text.slice(cursor)}`;
  }

  /** 一句人话：去掉代码、JSON、链接原文、命令参数与哈希，保留中文句子。 */
  function cleanPreview(raw) {
    let text = String(raw ?? '').replace(/\r\n?/gu, '\n');
    // 代码围栏、行内反引号、Markdown 结构符号
    text = text.replace(/```[\s\S]*?(?:```|$)/gu, ' ');
    text = text.replace(/`+/gu, '');
    text = text.replace(/^\s{0,3}#{1,6}\s+/gmu, ' ');
    text = text.replace(/^\s{0,3}[-*+]\s+/gmu, ' ');
    text = text.replace(/^\s{0,3}\d+[.)]\s+/gmu, ' ');
    text = text.replace(/\*\*([^*]+)\*\*/gu, '$1');
    // HTML 标签（含宿主注入的 <untrusted …> 包裹；预览被截断时可能只有半个标签）
    text = text.replace(/<\/?[a-zA-Z][^>]{0,200}>/gu, ' ');
    text = text.replace(/<\/?[^>]{0,200}$/u, ' ');
    // 现有脱敏：会话定位标识
    text = text.replace(/(?:room|target|channel|session|thread|guild)=\S+/giu, '（标识已隐去）');
    // 结构化片段：整段 JSON / 数组略过，残留的短片段再收一次
    text = stripJson(text);
    text = text.replace(/[{[][^[\]{}\n]{0,40}[}\]]/gu, (chunk) => (looksStructured(chunk) ? ' ' : chunk));
    text = text.replace(/[{[][^[\]{}\n]*$/u, (chunk) => (looksStructured(chunk) ? ' ' : chunk));
    text = text.replace(/\[[^\[\]]{40,}\]/gu, ' （结构化片段已略） ');
    // 链接只留域名
    text = text.replace(/\bhttps?:\/\/[^\s，。；、）】」》"'<>]+/giu, (url) => hostOf(url));
    text = text.replace(
      /(^|[^\w.@/-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|cn|net|org|io|dev|ai|co|me|app|sh|xyz|wiki|top))(\/[^\s，。；、）】」》"'<>]*)?/giu,
      (match, lead, domain) => `${lead}${hostOf(`https://${domain}`)}`,
    );
    // 命令与参数：--flag=value、ENV=value、key=value 一律去掉
    text = text.replace(/(^|[^\w.\-])(?:--?[a-zA-Z][\w-]*)(?:=\S+)?/gu, (match, lead) => lead);
    text = text.replace(/(^|[^\w.\-])([A-Z][A-Z0-9_]{2,})=\S+/gu, (match, lead) => lead);
    text = text.replace(/(^|[^\w.\-])([a-zA-Z][\w.-]{0,24})=(?:"[^"]*"|\S*)/gu, (match, lead) => lead);
    // 长路径只留文件名
    text = text.replace(/(?:[A-Za-z]:[\\/]|[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]+/gu, (match) => shortenPath(match));
    // 连续十六进制（≥ 12 位，至少含一个字母）当成哈希隐去
    text = text.replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/giu, '（哈希已隐去）');
    // 聊天抬头：「2026-10-31 00:31 昵称(123456) 编号 [@咱]：正文」只留正文
    text = text.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}[^\n：:]{0,80}[：:]/gu, (match) => (
      /[#[(（]|\bQQ\b/iu.test(match) ? ' ' : match));
    // 宿主抬头与方括号标签（【QQ路由】、[当前消息 · 需要回应]）
    text = text.replace(/【[^】]{0,16}(?:路由|元数据|系统提示|指令|metadata|header)[^】]*】/giu, ' ');
    text = text.replace(/\[[^\[\]\n]{0,30}\]/gu, ' ');
    // 六位以上的数字串当号码隐去；文件名里的日期（x-20261030.json）保留可读性
    text = text.replace(/([-_/])?(\d{6,})(\.[a-z0-9]{1,8})?/giu, (match, lead, digits, ext) => (
      lead && ext ? match : `${lead || ''}（号码已隐去）`));
    // 中英混排时长英文提示词不铺在首页（生图记录常见）
    if (CJK.test(text)) {
      text = text.replace(/[A-Za-z0-9][A-Za-z0-9 ,.:;'"()_\-\\/]{39,}/gu, (run) => {
        if (CJK.test(run)) return run;
        return (run.match(/,/gu) || []).length >= 3 ? '（英文片段已略）' : run;
      });
    }
    // 占位前的孤零零标点收掉（冒号紧贴占位时保留，读起来仍是「标签：略」）
    text = text.replace(/[，、；,;]\s*(?=（(?:英文片段已略|结构化片段已略)）)/gu, ' ');
    // 哈希前的英文标签同样多余
    text = text.replace(/\b(?:hash|sha1|sha256|md5|fingerprint)\b\s*(?=（哈希已隐去）)/giu, '');
    // 同一种占位连写只留一次
    for (const token of MASK_TOKENS) {
      text = text.replace(new RegExp(`${token}(?:\\s*${token})+`, 'gu'), token);
    }
    text = text.replace(/[ \t]+/gu, ' ').replace(/\s*\n\s*/gu, ' ').trim();
    // 日志自带的截断省略号不必叠在首页上
    text = text.replace(/[.．。]{0,3}(?:…|\.\.\.)+\s*$/u, '').trim();
    // 预览被截断时可能剩下半个 JSON：从第一个残留括号处截掉，别留半截键值对
    const stray = text.search(/[{}[\]]/u);
    if (stray >= 0) text = text.slice(0, stray).trim();
    // 截断留下的单个汉字不成句，收掉
    text = text.replace(/[\s，、；：][\u4e00-\u9fff]\s*$/u, '').trim();
    text = text.replace(/^[，。；、：,;:.·\-\s]+/u, '').replace(/[，、；：,;:]+$/u, '');
    // 开头只剩占位时直接去掉，正文才是要读的部分
    return text.replace(/^(?:（[^）]{1,12}已隐去）|（[^）]{1,12}已略）)[\s，、；:：]*/u, '');
  }

  /** 动作词：工具/系统来源的行用它开头，避免被读成"用户做了这件事"。 */
  function actionOf(raw, cleaned) {
    const text = String(cleaned || '');
    const lead = /(?:^|[\s；，])(探索|检索|搜索|读取|查看|写入|保存|执行|生成)\s*[:：]\s*/u.exec(text);
    if (lead) {
      const rest = `${text.slice(0, lead.index)} ${text.slice(lead.index + lead[0].length)}`;
      return { verb: ACTION_LABEL[lead[1]] || '执行', hadLead: true, body: rest.replace(/\s+/gu, ' ').trim() };
    }
    const source = String(raw || '');
    for (const hint of ACTION_HINTS) {
      if (hint.pattern.test(source)) return { verb: hint.verb, hadLead: false, body: text };
    }
    return { verb: '', hadLead: false, body: text };
  }

  /** 按字数（不是码元）截断，优先在标点处收尾。 */
  function clip(text, limit) {
    const chars = Array.from(String(text ?? ''));
    if (chars.length <= limit) return chars.join('');
    const head = chars.slice(0, limit).join('');
    const cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('，'),
      head.lastIndexOf('、'), head.lastIndexOf('：'), head.lastIndexOf(' '),
    );
    const kept = cut >= Math.floor(limit / 2) ? head.slice(0, cut) : head;
    // 收尾只剩「来源」「其中」这类标签时也一起收掉，别留半句话
    const tidied = kept
      .replace(/[\s，、；：,;:]+$/u, '')
      .replace(/[\s，、；：,;:（(]*(?:来源|来自|文件|路径|链接|地址|详情|其中|以及|与|和|见)$/u, '');
    return `${tidied}…`;
  }

  /** 一条事件的完整投影：来源标签 + 一句摘要；原文只留在 raw 里给诊断用。 */
  function projectEvent(event) {
    const raw = String((event && event.preview) || '');
    const cleaned = cleanPreview(raw);
    const source = sourceOf(event);
    const action = actionOf(raw, cleaned);
    const conversational = source.key === 'user' || source.key === 'assistant';
    const operation = source.key === 'tool' || source.key === 'system' || (!conversational && action.hadLead);
    let summary = (conversational && action.hadLead ? cleaned : action.body).replace(/\s+/gu, ' ').trim();
    // 正文自己已经以动作词开头时不再叠一个动词（「读取 已读取 1 个文件」读着别扭）
    const alreadyVerbed = /^(?:已)?(?:检索|搜索|读取|查看|写入|保存|执行|运行|生成)/u.test(summary);
    if (!summary) {
      summary = '（这条记录没有可读正文，展开原始记录可看）';
    } else if (operation && !alreadyVerbed) {
      summary = `${action.verb || (source.key === 'tool' ? '工具执行了' : '系统记录了')} ${summary}`;
    }
    return { source, summary: clip(summary, SUMMARY_LIMIT), raw };
  }

  function activityLabel(value) {
    return ACTIVITY_LABEL[value] || SLOT_KIND[value] || (value ? String(value) : '安排');
  }

  /** One honest sentence about where she is right now. */
  function describeNow(life) {
    if (!life) {
      return {
        headline: '还没读到她的生活状态',
        note: '',
        tone: 'idle',
      };
    }
    const current = life.current && life.current.slot ? life.current.slot : null;
    const running = life.current && Array.isArray(life.current.activities) ? life.current.activities : [];
    const next = Array.isArray(life.next) && life.next.length ? life.next[0] : null;
    if (running.length) {
      const item = running[0];
      const real = item.reality === 'actual_tool_activity';
      return {
        headline: `正在${activityLabel(item.kind)}`,
        note: `${item.target || '一段正在进行的事'}${real ? '' : '（模拟/假设）'}`,
        tone: real ? 'live' : 'warn',
      };
    }
    if (life.state === 'running' && current) {
      return { headline: `正在${activityLabel(current.activity || current.kind)}`, note: current.title || '', tone: 'live' };
    }
    if (life.state === 'resting') {
      return {
        headline: '在休息',
        note: next ? `下一段在 ${clock(next.startAt)}，${next.title || activityLabel(next.activity)}` : '今天不打算再安排什么了。',
        tone: 'ok',
      };
    }
    if (next) {
      return {
        headline: `接下来 ${clock(next.startAt)}`,
        note: `${next.title || activityLabel(next.activity)} · ${next.minutes || 0} 分钟`,
        tone: 'idle',
      };
    }
    if (life.state === 'today-done') {
      return { headline: '今天的安排都过去了', note: '', tone: 'ok' };
    }
    if (life.state === 'no-autonomy') {
      return { headline: '自主规划未启用', note: '可在设置里打开', tone: 'warn' };
    }
    return { headline: '今天还没有安排', note: '', tone: 'idle' };
  }

  function SlotRow({ slot, onClick }) {
    const kindTone = slot.kind === 'rest' ? 'neutral' : 'brand';
    return h('button', {
      type: 'button',
      className: 'cpxp-home-next-row',
      'data-clickable': onClick ? 'true' : 'false',
      onClick,
      'aria-label': `${P.fmt.range(slot.startAt, slot.endAt)} ${slot.title || activityLabel(slot.activity)}`,
    },
    h('span', { className: 'cpxp-home-when' }, P.fmt.range(slot.startAt, slot.endAt)),
    h('span', { className: 'cpxp-home-what' },
      h('span', null, slot.title || activityLabel(slot.activity)),
      h('span', { className: 'cpxp-home-sub' }, ` · ${activityLabel(slot.activity)}`),
      slot.minutes ? h('span', { className: 'cpxp-home-sub' }, ` · ${slot.minutes} 分钟`) : null,
      slot.locked ? h('span', null, ' ', h(ui.Badge, { tone: 'warn' }, '已锁定')) : null),
    h('span', { className: 'cpxp-home-sub' }, h(ui.Badge, { tone: kindTone }, SLOT_KIND[slot.kind] || slot.kind || '安排')));
  }

  function EventLine({ event }) {
    const view = projectEvent(event);
    const type = String(event.type || '');
    const role = String(event.role || '');
    const seq = event.seq === null || event.seq === undefined || event.seq === '' ? '—' : String(event.seq);
    const sessionId = String(event.sessionId || '');
    return h('div', { className: 'cpxp-home-event' },
      h('div', { className: 'cpxp-home-event-head' },
        h('span', { className: 'cpxp-home-event-at' }, P.fmt.relative(event.at)),
        h('span', {
          className: 'cpxp-home-event-source',
          'data-source': view.source.key,
          'data-raw': view.source.raw ? 'true' : undefined,
          title: `来源：${view.source.label}`,
        }, view.source.label),
        h('span', { className: 'cpxp-home-event-text' }, view.summary)),
      h('div', { className: 'cpxp-home-event-tech' },
        h(ui.Diagnostic, { title: '原始记录（技术字段）' },
          h('p', { className: 'cpxp-home-event-raw' }, view.raw || '（这条记录的预览是空的）'),
          h('p', { className: 'cpxp-home-event-meta' },
            `type：${type || '—'} · role：${role || '—'} · seq：${seq} · sessionId：${sessionId || '—'}`))));
  }

  function heroNode(now, life, observedAt) {
    return h('section', { className: 'cpx-hero', 'data-cpx': 'home-scene' },
      h('div', { className: 'cpx-scene' },
        h('span', { className: 'cpx-scene-sky', 'aria-hidden': 'true' }),
        h('span', { className: 'cpx-scene-floor', 'aria-hidden': 'true' }),
        h('span', { className: 'cpx-scene-mark', 'aria-hidden': 'true' }, h(ui.Icon, { name: 'snow', size: 30 })),
        h('span', { className: 'cpx-scene-window', 'aria-hidden': 'true' }),
        h('span', { className: 'cpx-scene-desk', 'aria-hidden': 'true' }),
        h('span', { className: 'cpx-scene-lamp', 'aria-hidden': 'true' }),
        h('h2', { className: 'cpx-scene-state' }, now.headline),
        now.note ? h('p', { className: 'cpx-scene-note' }, now.note) : null,
        h('p', { className: 'cpx-scene-meta' },
          h(ui.StateLine, { state: now.tone, text: life ? (STATE_SENTENCE[life.state] || '状态未知') : '状态未读到' }),
          observedAt ? h(ui.Timestamp, { at: observedAt, prefix: '数据时间' }) : null,
          life && life.switches ? h('span', null, life.switches.planning ? '自主规划已开启' : '自主规划关闭') : null,
          h(ui.Info, { text: HERO_INFO, label: '这里怎么读' }))));
  }

  function nextBandNode(life, next) {
    const emptyTitle = life ? '今天没有更多安排了' : '暂时读不到日程';
    const emptyHint = life ? '' : '稍后刷新看看。';
    return h(ui.Band, {
      title: '接下来的安排',
      hint: '还没开始的事',
      info: '计划不等于已经发生；自主规划关闭时她不会自己生成日程（可在设置里打开）。',
      actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('life') }, '生活与日程'),
    },
    next.length
      ? h('div', { className: 'cpxp-home-next' }, next.map((slot, index) => h(SlotRow, {
        key: slot.slotId || index,
        slot,
        onClick: () => P.nav.go('life'),
      })))
      : h(ui.Empty, { title: emptyTitle, hint: emptyHint, compact: true }));
  }

  function recentBandNode(events, data) {
    const emptyHint = data && data.missing.includes('最近记录')
      ? '时间线接口这次没读到，可以到时间线页重试。'
      : '新对话会先在本机留证。';
    return h(ui.Band, {
      title: '最近一起经历的事',
      hint: '',
      info: '来自本地留存记录的短摘要；链接、命令与代码已收成一句话，原文在每行的折叠里。对话留存不等于自动确认事实。',
      actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('timeline') }, '完整时间线'),
    },
    events.length
      ? h('div', { className: 'cpxp-home-events' }, events.map((event, index) => h(EventLine, { key: `${event.at}-${index}`, event })))
      : h(ui.Empty, { title: '还没有共同记录', hint: emptyHint, compact: true }));
  }

  function pendingBandNode(pendingReview, pendingSlots, pendingShare) {
    const rows = [];
    if (pendingReview) {
      rows.push(h(ui.Row, {
        key: 'review',
        title: `${pendingReview} 条记忆候选等待核对`,
        meta: '通过后进入长期记忆',
        side: '审核',
        onClick: () => P.nav.go('review'),
      }));
    }
    if (pendingSlots) {
      rows.push(h(ui.Row, {
        key: 'slots',
        title: `${pendingSlots} 段计划还没走完`,
        meta: '到时间还没回执，可以跳过',
        side: '生活与日程',
        onClick: () => P.nav.go('life'),
      }));
    }
    if (pendingShare) {
      rows.push(h(ui.Row, {
        key: 'share',
        title: `${pendingShare} 条分享候选等她处理`,
        meta: '分享开关关闭时不会发出去',
        side: '连接与工具',
        onClick: () => P.nav.go('connections'),
      }));
    }
    return h(ui.Band, {
      title: '需要你确认的事',
      hint: '',
      info: '只来自真实的待核对队列与未完成计划，没有演示数字；驳回会撤回但保留证据。',
    },
    rows.length
      ? h(ui.List, { label: '待确认事项' }, rows)
      : h(ui.Empty, {
        title: '现在没有需要你确认的事',
        hint: pendingReview === null ? '待核对接口这次没读到，可以先当作未知。' : '有候选时这里会出现入口。',
        compact: true,
      }));
  }

  // ---------------------------------------------------------------------------
  // 「今天的活动与睡眠」（健康半）
  //
  // 数据只走 /api/companion-health/{today,sleep}。健康路由挂在另一个前缀下，外壳的
  // P.api 只认 api/companion-memory/，所以这里照抄 core.js 同一套信封解包（同源 cookie
  // 鉴权、no-store、{ok,data,error}），不读也不传任何 token。
  // 读不到就说读不到：缺测一律写「无可用记录」，绝不用 0 步 / 0 小时占位。
  // ---------------------------------------------------------------------------
  const HEALTH_FRESH_LABEL = { fresh: '新鲜', delayed: '有延迟', stale: '已过期', unknown: '时间未知' };
  const HEALTH_FRESH_TONE = { fresh: 'ok', delayed: 'warn', stale: 'danger', unknown: 'idle' };
  // 产品参数（不是医学阈值）：只用来判断"这条读数多久以前采的"。
  const HEALTH_FRESH_RULES = { freshMinutes: 120, delayedMinutes: 1440 };

  function healthGet(path, params) {
    let url;
    try {
      url = new URL(`api/companion-health/${path}`, document.baseURI).href;
    } catch {
      url = `/api/companion-health/${path}`;
    }
    const search = params
      ? Object.keys(params)
        .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
        .join('&')
      : '';
    const target = search ? `${url}${url.indexOf('?') >= 0 ? '&' : '?'}${search}` : url;
    return fetch(target, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    }).then(
      (response) => response.json().then(
        (body) => {
          if (!body || body.ok !== true) {
            const error = (body && body.error) || {};
            throw new P.ApiError(error.message || `健康接口请求失败（HTTP ${response.status}）。`, response.status, error.code || 'unknown');
          }
          const data = body.data;
          // §11：只读查询自己失败也走 {ok:false, code, message}，套在信封的 data 里。
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

  const healthUnavailable = (error) => Boolean(error) && (
    String(error.code || '') === 'health-unavailable'
    || String(error.code || '') === 'health-db-unavailable'
    || Number(error.status) === 404
  );

  const healthFinite = (value) => typeof value === 'number' && Number.isFinite(value);

  function healthDuration(minutes) {
    if (!healthFinite(minutes) || minutes < 0) return '无可用记录';
    const total = Math.round(minutes);
    if (total < 60) return `${total} 分钟`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }

  function healthFreshness(at, nowMs) {
    if (!at) return { status: 'unknown', label: HEALTH_FRESH_LABEL.unknown };
    const parsed = typeof at === 'number' ? at : Date.parse(String(at));
    if (!Number.isFinite(parsed)) return { status: 'unknown', label: HEALTH_FRESH_LABEL.unknown };
    const ageMinutes = Math.max(0, Math.round((nowMs - parsed) / 60000));
    const status = ageMinutes <= HEALTH_FRESH_RULES.freshMinutes
      ? 'fresh'
      : ageMinutes <= HEALTH_FRESH_RULES.delayedMinutes ? 'delayed' : 'stale';
    return { status, label: HEALTH_FRESH_LABEL[status] };
  }

  function healthFreshChip(at, nowMs) {
    const fresh = healthFreshness(at, nowMs);
    return h('span', { className: 'cpxp-home-vital-fresh', title: `freshness=${fresh.status}` },
      h(ui.StateLine, { state: HEALTH_FRESH_TONE[fresh.status], text: fresh.label }),
      at ? h(ui.Timestamp, { at, prefix: '样本' }) : h('span', { className: 'cpxp-home-vital-note' }, '样本时间未提供'));
  }

  /** 最近一夜主睡眠：午睡不算，按日期倒序取第一条。 */
  function latestMainSleep(sleep) {
    const sessions = sleep && Array.isArray(sleep.sessions) ? sleep.sessions.filter(Boolean) : [];
    const mains = sessions.filter((session) => !session.isNap);
    if (!mains.length) return null;
    return mains.slice().sort((left, right) => {
      const at = (session) => {
        const start = session.startAt ? Date.parse(String(session.startAt)) : NaN;
        if (Number.isFinite(start)) return start;
        const day = session.sleepDate ? Date.parse(`${session.sleepDate}T00:00:00+08:00`) : NaN;
        return Number.isFinite(day) ? day : 0;
      };
      return at(right) - at(left);
    })[0];
  }

  function healthBandNode(health) {
    const nowMs = Date.now();
    const today = health && health.today ? health.today : null;
    const sleep = health && health.sleep ? health.sleep : null;

    if (health && health.unavailable) {
      return h(ui.Band, {
        title: '今天的活动与睡眠',
        hint: '',
        info: '来自华为运动健康（CN 云）；面板没有拿到 /api/companion-health 服务（health-unavailable），现在不编造任何读数。',
        actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('health') }, '健康与睡眠'),
      }, h(ui.Empty, {
        title: '健康数据未接入',
        hint: '接入后这里会出现今日步数与最近睡眠。',
        compact: true,
      }));
    }

    const activity = today && today.activity ? today.activity : null;
    const metrics = today && today.metrics ? today.metrics : {};
    const intensity = metrics.intensity || null;
    const steps = activity && healthFinite(activity.steps) ? `${Math.round(activity.steps)} 步` : '无可用记录';
    const stepsHint = activity
      ? [
        healthFinite(activity.distanceM) ? (activity.distanceM >= 1000 ? `${(activity.distanceM / 1000).toFixed(2)} 公里` : `${Math.round(activity.distanceM)} 米`) : null,
        healthFinite(activity.kcal) ? `${Math.round(activity.kcal)} 千卡` : null,
        intensity && healthFinite(intensity.moderateHighMinutes) ? `中高强度 ${Math.round(intensity.moderateHighMinutes)} 分钟` : null,
      ].filter(Boolean).join(' · ') || '来源没有给今天的活动明细'
      : (today ? '来源今天没有回传活动读数' : '今天的接口这次没读到');

    const mainSleep = latestMainSleep(sleep);
    const availability = sleep && sleep.availability ? sleep.availability : (today && today.sleep ? today.sleep.availability : null);
    const sleepValue = mainSleep
      ? healthDuration(mainSleep.asleepMinutes)
      : availability === 'awaiting_first_night' ? '等待首夜' : '无可用记录';
    const sleepHint = mainSleep
      ? [
        mainSleep.sleepDate || null,
        mainSleep.startAt && mainSleep.endAt ? P.fmt.range(mainSleep.startAt, mainSleep.endAt) : '来源只给了总时长',
        mainSleep.status === 'aggregate_only' ? '只有聚合时长' : null,
      ].filter(Boolean).join(' · ')
      : availability === 'awaiting_first_night'
        ? '睡眠会话 — 等待首夜华为云记录'
        : (sleep ? '来源这段时间没有睡眠记录' : '睡眠接口这次没读到');

    const sleepSample = mainSleep && mainSleep.endAt ? mainSleep.endAt : null;

    return h(ui.Band, {
      title: '今天的活动与睡眠',
      hint: '',
      info: '来自华为运动健康（CN 云），设备上报的指标；缺测写「无可用记录」，不补 0；新鲜度是产品参数，不是医学结论；只来自云端最后一次上传，来源没给的部分保持空白。',
      actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('health') }, '健康与睡眠'),
    }, [
      h('div', { key: 'vitals', className: 'cpxp-home-vitals' },
        h('div', null,
          h(ui.Stat, { label: '今日步数', value: steps, hint: stepsHint }),
          h('div', { className: 'cpxp-home-vital-fresh' },
            healthFreshChip(activity ? activity.observedAt || null : null, nowMs))),
        h('div', null,
          h(ui.Stat, { label: '最近睡眠', value: sleepValue, hint: sleepHint }),
          h('div', { className: 'cpxp-home-vital-fresh' },
            healthFreshChip(sleepSample, nowMs)))),
      health && health.error
        ? h('p', { key: 'err', className: 'cpxp-home-vital-note' },
          `有一项没读到：${P.failText(health.error, '健康服务没有返回数据。')}`)
        : null,
    ]);
  }

  function asideNode({ now, life, counts, pendingReview, pendingShare, observedAt, data }) {
    const backToChat = () => {
      if (!P.nav.openPanel('conversation')) P.notice('宿主导航暂时不可用。', 'warn');
    };
    return h(P.Fragment, null,
      h('section', { className: 'cpx-aside-section' },
        h('h3', { className: 'cpx-aside-title' }, '现在'),
        h('p', { className: 'cpxp-home-now' }, now.headline),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '记忆'),
          h('strong', null, counts ? P.fmt.number(counts.memories) : '—')),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '待核对'),
          h('strong', null, counts ? P.fmt.number(counts.pending) : (pendingReview === null ? '—' : pendingReview))),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '记录'),
          h('strong', null, counts ? P.fmt.number(counts.events) : '—')),
        h('button', { type: 'button', className: 'cpxp-home-aside-action', onClick: () => P.nav.go('vault') }, '打开记忆库')),

      h('section', { className: 'cpx-aside-section' },
        h('h3', { className: 'cpx-aside-title' }, '她的生活'),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '自主规划'),
          h('strong', null, life && life.switches ? (life.switches.planning ? '已开启' : '关闭') : '—')),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '真实活动'),
          h('strong', null, life && life.switches ? (life.switches.activities ? '已开启' : '关闭') : '—')),
        h('p', { className: 'cpx-aside-line' },
          h('span', { className: 'cpx-muted' }, '分享候选'),
          h('strong', null, pendingShare === null ? '—' : pendingShare)),
        h('button', { type: 'button', className: 'cpxp-home-aside-action', onClick: () => P.nav.go('life') }, '今天的时间线')),

      h('section', { className: 'cpx-aside-section' },
        h('h3', { className: 'cpx-aside-title' }, '回到开发'),
        h('div', { className: 'cpxp-home-links' },
          h(ui.Button, { size: 'sm', onClick: backToChat }, '回到聊天'),
          h(ui.Button, { size: 'sm', onClick: () => P.nav.go('workspace') }, '工作区'),
          h(ui.Button, { size: 'sm', onClick: () => P.nav.go('connections') }, '连接与工具'),
          h(ui.Button, { size: 'sm', onClick: () => P.nav.go('settings') }, '设置'))),

      h('section', { className: 'cpx-aside-section' },
        h('h3', { className: 'cpx-aside-title' }, '数据说明'),
        h('p', { className: 'cpx-muted' }, observedAt ? h(ui.Timestamp, { at: observedAt, prefix: '观测于' }) : '还没有观测时间'),
        data && data.missing.length
          ? h(ui.Callout, { tone: 'warn', title: '这一页有没读到的部分' },
            h('span', null, `未读到：${data.missing.join('、')}。`))
          : h('p', { className: 'cpx-muted' }, '数字口径',
            h(ui.Info, { text: '数字来自本机记忆库；未知一律显示「—」，不用 0 占位。', label: '数字口径' }))));
  }

  function Home() {
    const health = P.useLiveHealth();
    const query = P.useApi(() => Promise.allSettled([
      P.api.get('companion'),
      P.api.get('summary'),
      P.api.get('reviews'),
      P.api.get('timeline', { limit: 6 }),
      healthGet('today'),
      healthGet('sleep', { days: 7 }),
    ]).then((results) => {
      const [companion, summary, reviews, timeline, healthToday, healthSleep] = results;
      if (companion.status === 'rejected') throw companion.reason;
      // 健康半没挂上 ≠ 读错了：服务缺失是正常状态，不该混进「这一页有没读到的部分」。
      const healthErrors = [healthToday, healthSleep]
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      const healthUnavailableAll = healthErrors.length > 0 && healthErrors.every(healthUnavailable);
      return {
        companion: companion.value,
        summary: summary.status === 'fulfilled' ? summary.value : null,
        reviews: reviews.status === 'fulfilled' ? reviews.value : null,
        timeline: timeline.status === 'fulfilled' ? timeline.value : null,
        health: {
          today: healthToday.status === 'fulfilled' ? healthToday.value : null,
          sleep: healthSleep.status === 'fulfilled' ? healthSleep.value : null,
          unavailable: healthUnavailableAll,
          error: healthErrors.length && !healthUnavailableAll ? healthErrors[0] : null,
        },
        missing: [
          summary.status === 'rejected' ? '记忆计数' : null,
          reviews.status === 'rejected' ? '待核对列表' : null,
          timeline.status === 'rejected' ? '最近记录' : null,
          healthErrors.length && !healthUnavailableAll ? '身体数据' : null,
        ].filter(Boolean),
      };
    }), []);

    const data = query.data || null;
    const companion = data ? data.companion : null;
    const life = companion ? companion.life : null;
    const pendingReview = data && data.reviews && Array.isArray(data.reviews.pending) ? data.reviews.pending.length : null;
    const pendingSlots = life && Array.isArray(life.pending) ? life.pending.length : null;
    const pendingShare = life && life.share && typeof life.share.pending === 'number' ? life.share.pending : null;
    const now = describeNow(life);
    const next = life && Array.isArray(life.next) ? life.next.slice(0, 4) : [];
    const events = data && data.timeline && Array.isArray(data.timeline.items) ? data.timeline.items.slice(0, 4) : [];
    const counts = data && data.summary ? data.summary.counts : null;
    const runtime = companion ? companion.runtime : null;
    const observedAt = companion ? companion.observedAt : null;

    const page = {
      title: '陪伴首页',
      lead: '她现在在做什么，和还没说完的事',
      info: HOME_INFO,
      status: h(P.Fragment, null,
        h(ui.StateLine, { state: P.lifeTone(life && life.state), text: life ? (STATE_SENTENCE[life.state] || '状态未知') : '尚未读到状态' }),
        observedAt ? h(ui.Timestamp, { at: observedAt, prefix: '观测于' }) : null,
        runtime && runtime.available === false ? h(ui.Badge, { tone: 'warn' }, '运行库未连接') : null),
      actions: h(ui.Button, { variant: 'primary', onClick: query.reload, loading: query.loading }, '刷新状态'),
    };

    if (query.loading && !data) {
      return h(ui.Page, page, h(ui.Skeleton, { rows: 4 }));
    }
    if (query.error) {
      return h(ui.Page, page,
        h(ui.ErrorBox, { error: query.error, onRetry: query.reload }),
        h(ui.Callout, { tone: 'info', title: '这一页读到什么就展示什么' },
          h('span', null, '记忆与生活数据来自本机认知运行库',
            h(ui.Info, { text: '接口失败时只显示这里的错误，不会编造状态。', label: '失败时怎么显示' }))));
    }

    const main = h(P.Fragment, null,
      heroNode(now, life, observedAt),
      h(ui.Band, {
        title: '状态',
        info: '每 20 秒自动探测一次；点任意一项跳到对应页面。失败只写「读不到」，不用 0 或绿色代替未知。',
        actions: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => P.nav.go('overview') }, '运行状态'),
      }, h(ui.HealthStrip, {
        items: health.items,
        at: health.at,
        now: health.now,
        loading: health.loading,
        paused: health.paused,
        onRefresh: health.refresh,
        onTogglePause: health.togglePaused,
        onOpen: (item) => { if (item && item.page) P.nav.go(item.page); },
        compact: true,
      })),
      healthBandNode(data ? data.health : null),
      nextBandNode(life, next),
      recentBandNode(events, data),
      pendingBandNode(pendingReview, pendingSlots, pendingShare));

    const aside = asideNode({ now, life, counts, pendingReview, pendingShare, observedAt, data });

    return h(ui.Page, page, h(ui.Split, { main, aside }));
  }

  P.registerPage({ id: 'home', label: '陪伴首页', order: 0, component: Home });
})(P);

// ==== src/client/pages-life.js ====
// 生活与日程（page id: life）
//
// 契约：design/ui-redesign-20261030-shell-contract.md。
// 这一页只回答三件事：她现在在做什么、接下来还有什么、今天已经过去的段落是什么样。
// 数据全部来自 GET companion 的 life / sections.goals / sections.commitments；
// 锁定 / 解锁 / 跳过 走 POST plan-slot，只有运行库回了回执才刷新界面，绝不乐观更新。
// 技术字段（plan 版本、switches、receipts、slotId、状态说明）只出现在页尾的 ui.Diagnostic 里。
//
// 表达约定（2026-10-31 视觉返工）：
//   * 「现在」只有一行状态 + 有活动时才列活动行，解释性长句进分区 hint 或诊断；
//   * 状态词跟着分组走：接下来 = 计划中 / 已锁定；已结束 = 已结束 / 未完成；已跳过 = 已跳过；
//   * 过去的三组各自是一个 ui.Band，不再套三层标题。
(function (P) {
  const { h, ui } = P;

  P.css(`
    .cpxp-life-stack { display:flex; flex-direction:column; min-width:0; }
    .cpxp-life-status { display:inline; }
    .cpxp-life-state { display:flex; align-items:baseline; gap:var(--cpx-s2,8px); flex-wrap:wrap; margin:0; min-width:0; }
    .cpxp-life-note,
    .cpxp-life-empty { margin:0; max-width:72ch; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); line-height:1.7; overflow-wrap:anywhere; min-width:0; }
    .cpxp-life-title { font-weight:600; overflow-wrap:anywhere; min-width:0; }
    .cpxp-life-meta { display:inline-flex; align-items:baseline; flex-wrap:wrap; gap:0 var(--cpx-s1,4px); max-width:100%; min-width:0; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); line-height:1.6; overflow-wrap:anywhere; }
    .cpxp-life-wrap { overflow-wrap:anywhere; word-break:normal; white-space:normal; }
    .cpxp-life-range { display:inline-flex; align-items:baseline; gap:var(--cpx-s1,4px); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cpxp-life-side { display:inline-flex; align-items:center; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; }
    .cpxp-life-actions { display:inline-flex; align-items:center; gap:var(--cpx-s1,4px); flex-wrap:wrap; min-width:0; }
    .cpxp-life-acts { display:flex; flex-direction:column; gap:var(--cpx-s3,12px); margin:var(--cpx-s1,4px) 0 0; min-width:0; }
    .cpxp-life-act { display:flex; flex-direction:column; gap:var(--cpx-s1,4px); min-width:0; }
    .cpxp-life-act-head { display:flex; align-items:baseline; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; }
    .cpxp-life-meter { max-width:360px; min-width:140px; margin-top:var(--cpx-s1,4px); }
    .cpxp-life-subhead { margin:var(--cpx-s3,12px) 0 0; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); font-weight:600; letter-spacing:.3px; }
    .cpxp-life-diag-block { display:flex; flex-direction:column; gap:var(--cpx-s2,8px); min-width:0; }
    @media (max-width:720px) {
      .cpxp-life-meter { max-width:none; }
      .cpxp-life-actions { justify-content:flex-end; }
    }
  `);

  // ---------------------------------------------------------------------------
  // 词表：数据库里的英文枚举在页面上一律翻成中文，认不出来的原样显示，不猜。
  // ---------------------------------------------------------------------------

  const DASH = '—';

  const STATE_LABEL = {
    running: '正在做',
    resting: '休息中',
    upcoming: '还有安排',
    'today-done': '今天已结束',
    // 计划排完了、今天还没结束：这既不是「今天已结束」，也不是「还有安排」。
    'plan-exhausted': '计划已排完',
    'no-plan': '今天还没有安排',
    'no-autonomy': '自主规划未启用',
  };

  // 长解释只进诊断；正文和分区 hint 保持一句话。
  const STATE_EXPLAIN = {
    running: '运行库报告了进行中的活动，只有 actual_tool_activity 才算真实活动。',
    resting: '这一段排的是休息，不需要产出。',
    upcoming: '后面的时间段还没有发生，可以锁定或跳过其中一段。',
    'today-done': '今天不再有接下来的时间段，已经过去的都在下面。',
    'plan-exhausted': '这一版计划排的时段都已经过去，但今天还没结束；规划侧没有补充新的时段。',
    'no-plan': '自主规划开关是开的，但今天还没有生成计划；下一次规划之后才会有安排。',
    'no-autonomy': '自主规划开关是关的，所以今天不会有时间段（开关在运行库配置里，不在这一页改）。',
  };

  const KIND_LABEL = { activity: '活动', open: '自由安排', rest: '休息' };
  const ACTIVITY_LABEL = { read: '阅读', explore: '探索', write: '创作', bilibili: '刷 B 站' };
  // 经历投影里的 kind（活动的种类，不是时段的种类）。
  const EXPERIENCE_KIND = ACTIVITY_LABEL;
  const STATUS_LABEL = { planned: '待开始', started: '进行中', running: '进行中', paused: '暂停', done: '已完成', skipped: '已跳过' };
  const GOAL_STATUS_LABEL = { proposed: '刚提出', accepted: '已接受', running: '进行中', paused: '暂停', completed: '已完成', cancelled: '已取消' };
  const COMMITMENT_STATUS_LABEL = { open: '还没做', closed: '已完成' };

  const ACTION_LABEL = { lock: '锁定', unlock: '解锁', skip: '跳过' };
  const ACTION_HINT = {
    lock: '锁住这一段：之后的重新规划不会改动它',
    unlock: '解锁这一段：重新规划时可以再调整',
    skip: '跳过这一段：今天不再安排它',
  };
  const ACTION_REASON = {
    lock: '用户在「生活与日程」页锁定这一段',
    unlock: '用户在「生活与日程」页解锁这一段',
    skip: '用户在「生活与日程」页跳过这一段',
  };

  // 未知值显示破折号，不显示 0。
  const text = (value) => (value === null || value === undefined || value === '' ? DASH : String(value));
  const onOff = (value) => (value === true ? '已启用' : value === false ? '未启用' : DASH);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  // 槽没有标题时给一句人话，不要把空字符串渲染成空白条目。
  const slotTitle = (slot) => (slot && slot.title ? String(slot.title) : '（这一段没有标题）');

  function minutesOf(slot) {
    const value = slot && slot.minutes;
    if (!finite(value)) return DASH;
    if (value <= 0) return '不足 1 分钟';
    return `${value} 分钟`;
  }

  function kindOf(slot) {
    if (!slot) return DASH;
    if (slot.kind === 'activity') return ACTIVITY_LABEL[slot.activity] || (slot.activity ? String(slot.activity) : KIND_LABEL.activity);
    return KIND_LABEL[slot.kind] || text(slot.kind);
  }

  // 时间区间统一走 P.fmt.range（同日省略日期、跨日带日期）；认不出就显示破折号。
  function rangeLabel(slot) {
    const start = slot ? Number(slot.startAt) : NaN;
    const end = slot ? Number(slot.endAt) : NaN;
    if (!finite(start) || !finite(end)) return DASH;
    return P.fmt.range(start, end);
  }

  // 状态词跟着**结果**走，不跟数据库的行状态走：运行库把一段做完之后行状态仍可能是
  // `started`，只看 status 就会把有 finish 回执的一段显示成「未完成」（生产事故）。
  // 结果词表来自 life payload 的 `outcome`，这里只做兜底翻译。
  const OUTCOME_BADGE = {
    completed: { text: '已完成', tone: 'ok' },
    'rest-ended': { text: '已结束（休息）', tone: 'neutral' },
    review: { text: '待复核', tone: 'warn' },
    missed: { text: '未完成', tone: 'warn' },
    skipped: { text: '已跳过', tone: 'warn' },
    upcoming: { text: '计划中', tone: 'neutral' },
  };

  function groupBadge(group, slot) {
    const outcome = slot && typeof slot.outcome === 'string' ? slot.outcome : '';
    if (group === 'next') {
      return outcome === 'skipped'
        ? OUTCOME_BADGE.skipped
        : { text: '计划中', tone: 'neutral' };
    }
    // 窗口内还没结束、而且活动正在跑：这说明的是「进行中」，不是「未完成」。
    if (outcome === 'upcoming' && slot && (slot.live === 'running' || slot.live === 'paused')) {
      return { text: '进行中', tone: 'brand' };
    }
    if (OUTCOME_BADGE[outcome]) return OUTCOME_BADGE[outcome];
    // 旧 payload 没有 outcome 时的兜底：只有 done 才算结束，其余也不谎称未完成。
    const status = slot && slot.status;
    if (status === 'done') return { text: '已结束', tone: 'ok' };
    if (status === 'skipped') return { text: '已跳过', tone: 'warn' };
    return { text: '未完成', tone: 'warn' };
  }

  // ---------------------------------------------------------------------------
  // 小部件
  // ---------------------------------------------------------------------------

  function TimeRange({ slot }) {
    const start = slot ? Number(slot.startAt) : NaN;
    const end = slot ? Number(slot.endAt) : NaN;
    if (!finite(start) || !finite(end)) return h('span', { className: 'cpxp-life-range' }, DASH);
    return h('span', {
      className: 'cpxp-life-range',
      title: `${P.fmt.dateTime(start)} – ${P.fmt.dateTime(end)}`,
    }, P.fmt.range(start, end));
  }

  // 时间区间 · 类型 · 时长；状态交给徽标，不在这里重复。
  function SlotMeta({ slot }) {
    const round = slot.bilibiliRound;
    const result = round && ({ completed: '轮次已结束', failed: '轮次失败', unknown: '轮次结果未知', 'quota-exhausted': '今日额度已用完' })[round.status];
    return h('span', { className: 'cpxp-life-meta' },
      h(TimeRange, { slot }),
      ' · ',
      kindOf(slot),
      ' · ',
      minutesOf(slot),
      result ? ` · ${result} · 确认消费 ${round.watched} 条` : null);
  }

  // 自主排的时段是她自己的安排，不是用户约定的日程；「已约好」只属于 H1 那几项。
  const isSelf = (slot) => !slot || slot.origin === 'self' || slot.origin === undefined;

  function SlotRow({ slot, badge, note }) {
    const locked = Boolean(slot && slot.locked);
    const self = isSelf(slot);
    const hasSide = Boolean(badge) || locked || self || Boolean(note);
    return h(ui.Row, {
      title: slotTitle(slot),
      meta: h(SlotMeta, { slot }),
      side: hasSide
        ? h('span', { className: 'cpxp-life-side' },
          badge ? h(ui.Badge, { tone: badge.tone }, badge.text) : null,
          self ? h(ui.Badge, { tone: 'neutral' }, '自主') : null,
          locked ? h(ui.Badge, { tone: 'warn' }, '已锁定') : null,
          note ? h('span', { className: 'cpxp-life-meta' }, note) : null)
        : undefined,
      ariaLabel: `${badge ? badge.text : '安排'}：${slotTitle(slot)}，${self ? '她自己的安排，' : ''}${kindOf(slot)}，${minutesOf(slot)}，${rangeLabel(slot)}${locked ? '，已锁定' : ''}`,
    });
  }

  function NextRow({ slot, busy, planEnabled, disabledReason, onAction }) {
    const controls = Array.isArray(slot && slot.controls) ? slot.controls : [];
    const actions = controls.map((action) => h(ui.Button, {
      key: action,
      size: 'sm',
      variant: 'ghost',
      loading: Boolean(busy) && busy.slotId === slot.slotId && busy.action === action,
      disabled: Boolean(busy) || !planEnabled,
      title: planEnabled ? ACTION_HINT[action] : disabledReason,
      onClick: () => { if (typeof onAction === 'function') onAction(slot, action); },
    }, ACTION_LABEL[action] || action));
    return h(ui.Row, {
      title: slotTitle(slot),
      meta: h(SlotMeta, { slot }),
      side: h('span', { className: 'cpxp-life-side' },
        h(ui.Badge, { tone: 'neutral' }, '计划中'),
        h(ui.Badge, { tone: 'neutral' }, '自主'),
        slot.locked ? h(ui.Badge, { tone: 'warn' }, '已锁定') : null,
        actions.length
          ? h('span', { className: 'cpxp-life-actions', role: 'group', 'aria-label': `调整「${slotTitle(slot)}」` }, actions)
          : null),
      ariaLabel: `接下来的安排：${slotTitle(slot)}，${kindOf(slot)}，${minutesOf(slot)}，${rangeLabel(slot)}${slot.locked ? '，已锁定' : ''}`,
    });
  }

  function ActivityItem({ activity }) {
    // 只有 actual_tool_activity 才叫真实活动；其余一律按模拟/假设标注。
    const real = activity.reality === 'actual_tool_activity';
    const consumed = finite(activity.consumed) ? activity.consumed : null;
    const total = finite(activity.total) && activity.total > 0 ? activity.total : null;
    const updatedAt = activity.updatedAt;
    return h('div', { className: 'cpxp-life-act', role: 'listitem' },
      h('div', { className: 'cpxp-life-act-head' },
        h(ui.Badge, { tone: real ? 'ok' : 'warn' }, real ? '真实活动' : '模拟/假设'),
        h('span', { className: 'cpxp-life-title' }, ACTIVITY_LABEL[activity.kind] || text(activity.kind)),
        activity.target ? h('span', { className: 'cpxp-life-meta cpxp-life-wrap' }, activity.target) : null,
        h('span', { className: 'cpxp-life-meta' },
          text(STATUS_LABEL[activity.status] || activity.status),
          ' · 更新 ',
          finite(updatedAt) ? h(ui.Timestamp, { at: updatedAt }) : DASH)),
      consumed !== null && total !== null
        ? h('div', { className: 'cpxp-life-meter' },
          h(ui.Meter, {
            value: consumed,
            max: total,
            label: `进度 ${P.fmt.number(consumed)} / ${P.fmt.number(total)}`,
            tone: real ? 'ok' : 'warn',
          }))
        : h('p', { className: 'cpxp-life-note' }, `进度：${DASH}`));
  }

  function GoalRow({ goal }) {
    const status = String(goal.status || '');
    const hasDeadline = goal.deadline_at !== null && goal.deadline_at !== undefined && finite(Number(goal.deadline_at));
    const deadline = hasDeadline ? Number(goal.deadline_at) : null;
    const closed = status === 'completed' || status === 'cancelled';
    const overdue = hasDeadline && !closed && deadline <= Date.now();
    const tone = status === 'completed' ? 'ok' : overdue ? 'danger' : status === 'paused' ? 'warn' : status === 'cancelled' ? 'neutral' : 'brand';
    return h(ui.Row, {
      title: text(goal.title) === DASH ? '（这个目标没有标题）' : goal.title,
      meta: h('span', { className: 'cpxp-life-meta cpxp-life-wrap' },
        h(ui.Badge, { tone }, GOAL_STATUS_LABEL[status] || text(status)),
        overdue ? h(ui.Badge, { tone: 'danger' }, '已过期') : null,
        h('span', { className: 'cpxp-life-wrap' }, ' 下一步：', goal.next_step ? goal.next_step : `还没有写下${DASH}`),
        h('span', { className: 'cpxp-life-wrap' }, ' · 等待：', goal.waiting_on ? goal.waiting_on : '没有在等什么')),
      side: h('span', { className: 'cpxp-life-side' },
        h('span', { className: 'cpxp-life-meta' }, '截止 '),
        hasDeadline ? h(ui.Timestamp, { at: deadline }) : '没有截止时间'),
      ariaLabel: `目标：${text(goal.title)}，${GOAL_STATUS_LABEL[status] || '状态未知'}${overdue ? '，已过期' : ''}`,
    });
  }

  function CommitmentRow({ commitment }) {
    const status = String(commitment.status || '');
    const hasDue = commitment.due_at !== null && commitment.due_at !== undefined && finite(Number(commitment.due_at));
    const due = hasDue ? Number(commitment.due_at) : null;
    const overdue = hasDue && status === 'open' && due <= Date.now();
    return h(ui.Row, {
      title: text(commitment.body) === DASH ? '（这条承诺没有写内容）' : commitment.body,
      meta: h('span', { className: 'cpxp-life-meta' },
        h(ui.Badge, { tone: status === 'closed' ? 'ok' : overdue ? 'danger' : 'neutral' }, COMMITMENT_STATUS_LABEL[status] || text(status)),
        overdue ? h(ui.Badge, { tone: 'danger' }, '已到期') : null),
      side: h('span', { className: 'cpxp-life-side' },
        h('span', { className: 'cpxp-life-meta' }, '到期 '),
        hasDue ? h(ui.Timestamp, { at: due }) : '没有到期时间'),
      ariaLabel: `承诺：${text(commitment.body)}，${COMMITMENT_STATUS_LABEL[status] || '状态未知'}${overdue ? '，已到期' : ''}`,
    });
  }

  // ---------------------------------------------------------------------------
  // 分区
  // ---------------------------------------------------------------------------

  function BandNow({ life }) {
    const current = life.current || {};
    const slot = current.slot || null;
    const activities = Array.isArray(current.activities) ? current.activities : [];
    const interests = Array.isArray(life.interests) ? life.interests : [];
    const next = Array.isArray(life.next) ? life.next : [];
    const state = typeof life.state === 'string' ? life.state : '';
    const upcoming = next[0] || null;
    // 没有当前段落时只留一行：要么说下一段在什么时候，要么说今天没有更多安排。
    const quiet = upcoming
      ? `现在没有进行中的段落；下一段 ${P.fmt.range(upcoming.startAt, upcoming.endAt)}。`
      : state === 'today-done'
        ? '今天没有更多安排了。'
        : '现在没有进行中的段落。';
    return h(ui.Band, {
      title: '现在',
      info: '进行中的活动来自运行库回执；计划只是打算，没有回执的事不会被当成已经发生。',
      flush: true,
    },
    h('div', { className: 'cpxp-life-state' },
      h(ui.StateLine, { state: P.lifeTone(state), text: STATE_LABEL[state] || '状态未知' })),
    slot ? h(SlotRow, { key: 'current', slot }) : h('p', { className: 'cpxp-life-empty' }, quiet),
    activities.length
      ? h('div', { className: 'cpxp-life-acts', role: 'list', 'aria-label': '进行中的活动' },
        activities.map((activity, index) => h(ActivityItem, {
          key: activity.activityId || `act:${index}`,
          activity,
        })))
      : null,
    interests.length
      ? h('p', { className: 'cpxp-life-note' },
        '她最近想做的事：',
        interests.map((item) => text(item.title)).join('、'))
      : null);
  }

  function BandNext({ life, busy, onAction, notice }) {
    const plan = life.plan || null;
    const next = Array.isArray(life.next) ? life.next : [];
    const state = typeof life.state === 'string' ? life.state : '';
    const planEnabled = !(life.planControls && life.planControls.enabled === false);
    const hint = plan && plan.summary ? plan.summary : '';
    // 计划排完但今天还没结束，与「今天已结束」是两件事；空状态必须说真话。
    const reason = typeof life.reason === 'string' && life.reason ? life.reason : '';
    return h(ui.Band, {
      title: '接下来',
      hint,
      info: '锁定后重新规划不会改动这一段，跳过会把它标记为已跳过；两者都要运行库回了回执才算生效，历史段落不能改。',
    },
      notice || null,
      planEnabled ? null : h('p', { className: 'cpxp-life-note' }, '自主规划关着，按钮暂不生效。'),
      next.length
        ? h(ui.List, { label: '接下来的安排列表' }, next.map((slot, index) => h(NextRow, {
          key: slot.slotId || `${slot.startAt}:${index}`,
          slot,
          busy,
          planEnabled,
          disabledReason: '自主规划关着，暂时不能调整',
          onAction,
        })))
        : (state === 'no-autonomy'
          ? h(ui.Empty, { title: '她今天没有自己排日程', hint: reason || '自主规划关着。' })
          : state === 'plan-exhausted'
            ? h(ui.Empty, { title: '计划已经排完，今天还没结束', hint: reason || '剩下的时间没有新安排。' })
            : state === 'today-done'
              ? h(ui.Empty, { title: '今天的安排都结束了', hint: reason || '已经过去的都在下面。' })
              : plan
                ? h(ui.Empty, { title: '今天没有更多安排了', hint: reason || '剩下的时间可以留白。' })
                : h(ui.Empty, { title: '今天还没有日程', hint: reason || '规划开着，还没生成计划。' })));
  }

  // 全天时段：整份计划的时段表。`next` 为空时它仍然在——计划不会因为「没有下一段」而从
  // 页面上消失，用户可以自己看到今天到底排了什么、每一段是什么结果。
  const PLAN_STATUS_LABEL = { committed: '已提交', empty: '空计划', superseded: '已被取代' };

  function BandToday({ life }) {
    const today = Array.isArray(life.today) ? life.today : [];
    const plan = life.plan || null;
    const planStatus = typeof life.planStatus === 'string' && life.planStatus
      ? life.planStatus
      : (plan && plan.status ? String(plan.status) : '');
    if (!plan && !today.length) return null;
    const statusText = PLAN_STATUS_LABEL[planStatus] || (planStatus || DASH);
    return h(ui.Band, {
      title: '全天时段',
      hint: plan ? `第 ${text(plan.version)} 版计划（${statusText}）：${today.length} 段` : '',
      info: '这些时段是她自己排的，不是用户约定的日程；「已约好」只属于约定项。',
      flush: true,
    },
    today.length
      ? h(ui.List, { label: '全天时段列表' }, today.map((slot, index) => h(SlotRow, {
        key: slot.slotId || `${slot.startAt}:${index}`,
        slot,
        badge: groupBadge('today', slot),
      })))
      : h('p', { className: 'cpxp-life-empty' }, '这一版计划没有时段。'));
  }
  // 过去的三组各自成段：不再套「今天已经过去的」再套三个小标题。
  function pastRows(list, group) {
    return list.map((slot, index) => h(SlotRow, {
      key: slot.slotId || `${slot.startAt}:${index}`,
      slot,
      badge: groupBadge(group, slot),
    }));
  }

  function BandEnded({ life }) {
    // 已经在「已跳过」里出现过的段落不再重复列一次；只在这一组里出现的跳过段仍然列出，
    // 徽标写「已跳过」，不会被悄悄吞掉。
    const skipped = Array.isArray(life.skipped) ? life.skipped : [];
    const listedElsewhere = new Set(skipped.map((slot) => slot && slot.slotId));
    const ended = (Array.isArray(life.ended) ? life.ended : [])
      .filter((slot) => !(slot && slot.status === 'skipped' && listedElsewhere.has(slot.slotId)));
    return h(ui.Band, { title: '今天已结束' },
      ended.length
        ? h(ui.List, { label: '今天已结束的安排列表' }, pastRows(ended, 'ended'))
        : h('p', { className: 'cpxp-life-empty' }, '今天还没有结束任何一段。'));
  }

  function BandPending({ life }) {
    const pending = Array.isArray(life.pending) ? life.pending : [];
    return h(ui.Band, { title: '未完成待续' },
      pending.length
        ? h(ui.List, { label: '未完成待续的安排列表' }, pastRows(pending, 'pending'))
        : h('p', { className: 'cpxp-life-empty' }, '没有漏掉的段落。'));
  }

  function BandSkipped({ life }) {
    const skipped = Array.isArray(life.skipped) ? life.skipped : [];
    return h(ui.Band, { title: '已跳过' },
      skipped.length
        ? h(ui.List, { label: '已跳过的安排列表' }, pastRows(skipped, 'skipped'))
        : h('p', { className: 'cpxp-life-empty' }, '今天没有跳过任何安排。'));
  }

  /**
   * 最近经历（P2.5-2 E7）：**只读投影**，不是权威状态。
   *
   * 三件事仍然要在，但不占正文：① 标题里写"只读投影"；② "不是权威状态"的解释收进 ⓘ；
   * ③ 空的时候说"暂无经历"，而不是留一块空白（空白读不出"确实没发生"还是"页面坏了"）。
   */
  function BandExperience({ experience }) {
    const view = experience && typeof experience === 'object' ? experience : null;
    const items = view && Array.isArray(view.items) ? view.items : [];
    const info = view && view.note
      ? String(view.note)
      : '只读投影：由活动与回执派生，不是权威状态（权威是事件书与 runner）。';
    const bandProps = { title: '最近经历（只读投影）', info };
    if (!items.length) {
      return h(ui.Band, bandProps,
        h(ui.Empty, { title: '暂无经历', hint: '还没有已经结束的活动。' }));
    }
    return h(ui.Band, bandProps,
      h(ui.List, { label: '最近经历列表' }, items.map((item, index) => h('li', {
        key: item.activityId || `experience:${index}`,
        className: 'cpxp-life-row',
      },
      h('div', { className: 'cpxp-life-row-main' },
        h(ui.Badge, { tone: item.tone || 'neutral' }, item.resultLabel || text(item.result)),
        h('span', { className: 'cpxp-life-title' }, EXPERIENCE_KIND[item.kind] || text(item.kind)),
        item.target ? h('span', { className: 'cpxp-life-meta' }, item.target) : null,
        item.simulated ? h(ui.Badge, { tone: 'warn' }, '模拟/假设') : null),
      h('div', { className: 'cpxp-life-row-side' },
        h('span', { className: 'cpxp-life-meta' }, item.source ? `来源 ${item.source}` : '来源未知'),
        finite(item.at) ? h(ui.Timestamp, { at: item.at }) : h('span', { className: 'cpxp-life-meta' }, DASH))))));
  }

  function BandGoals({ goals, unavailable }) {
    const list = Array.isArray(goals) ? goals : [];
    if (unavailable.indexOf('goals') >= 0) {
      return h(ui.Band, { title: '目标' },
        h(ui.Empty, { title: '这个运行库还没有目标表' }));
    }
    return h(ui.Band, { title: '目标' },
      list.length
        ? h(ui.List, { label: '目标列表' }, list.map((goal, index) => h(GoalRow, {
          key: goal.goal_id || `goal:${index}`,
          goal,
        })))
        : h(ui.Empty, { title: '还没有目标记录', hint: '她接受目标后才会出现在这里。' }));
  }

  function BandCommitments({ commitments, unavailable }) {
    const list = Array.isArray(commitments) ? commitments : [];
    if (unavailable.indexOf('commitments') >= 0) {
      return h(ui.Band, { title: '承诺' },
        h(ui.Empty, { title: '这个运行库还没有承诺表' }));
    }
    return h(ui.Band, { title: '承诺', info: '这一页只读：关闭承诺走运行库事件，不在这里改。' },
      list.length
        ? h(ui.List, { label: '承诺列表' }, list.map((commitment, index) => h(CommitmentRow, {
          key: commitment.commitment_id || `commitment:${index}`,
          commitment,
        })))
        : h(ui.Empty, { title: '还没有承诺记录', hint: '有明确约定后才会出现在这里。' }));
  }

  function LifeDiagnostic({ life, unavailable }) {
    const plan = life.plan || null;
    const switches = life.switches || {};
    const planControls = life.planControls || {};
    const receipts = Array.isArray(life.receipts) ? life.receipts : [];
    const state = typeof life.state === 'string' ? life.state : '';
    const groups = [
      ['current', life.current && life.current.slot ? [life.current.slot] : []],
      ['next', Array.isArray(life.next) ? life.next : []],
      ['pending', Array.isArray(life.pending) ? life.pending : []],
      ['ended', Array.isArray(life.ended) ? life.ended : []],
      ['skipped', Array.isArray(life.skipped) ? life.skipped : []],
    ];
    const slots = [];
    groups.forEach(([group, list]) => {
      list.forEach((slot) => {
        slots.push({
          group,
          slotId: slot.slotId,
          planId: plan ? plan.planId : undefined,
          startAt: slot.startAt,
          endAt: slot.endAt,
          kind: slot.kind,
          activity: slot.activity,
          status: slot.status,
          outcome: slot.outcome,
          locked: slot.locked,
          flexibility: slot.flexibility,
          controls: slot.controls,
          minutes: slot.minutes,
        });
      });
    });
    return h(ui.Diagnostic, {
      title: '高级诊断',
      hint: '计划版本、开关、回执与槽 ID 原样保留。',
    },
    h(ui.KeyValue, {
      items: [
        { k: '状态说明', v: STATE_EXPLAIN[state] || DASH, breakable: true },
        { k: '计划编号', v: plan ? plan.planId : DASH, mono: true, breakable: true },
        { k: '计划版本', v: plan ? `第 ${text(plan.version)} 版` : DASH },
        { k: '计划状态', v: plan ? (plan.status || life.planStatus || DASH) : DASH },
        { k: '今天时段', v: `${P.fmt.number(Array.isArray(life.today) ? life.today.length : 0)} 段` },
        { k: '状态原因', v: life.reason ? String(life.reason).slice(0, 200) : DASH, breakable: true },
        { k: '计划日期', v: plan ? text(plan.day) : DASH },
        { k: '自主规划', v: onOff(switches.planning) },
        { k: '活动开关', v: onOff(switches.activities) },
        { k: '分享开关', v: onOff(switches.share) },
        { k: '分享候选', v: life.share ? `${P.fmt.number(life.share.pending)} 条待处理` : DASH },
        { k: '计划控制', v: planControls.enabled === true ? `可用（${(planControls.actions || []).join(' / ')}）` : '不可用' },
        { k: '不可用分类', v: unavailable.length ? unavailable.join('、') : '无' },
      ],
    }),
    h('div', { className: 'cpxp-life-diag-block' },
      h('p', { className: 'cpxp-life-subhead' }, '计划原样'),
      h(ui.Pre, null, plan ? JSON.stringify(plan, null, 2) : '（没有计划）'),
      h('p', { className: 'cpxp-life-subhead' }, '回执原样'),
      h(ui.Pre, null, JSON.stringify(receipts, null, 2)),
      h('p', { className: 'cpxp-life-subhead' }, '槽（技术字段）'),
      h(ui.Pre, null, JSON.stringify(slots, null, 2)),
      h('p', { className: 'cpxp-life-subhead' }, '进行中活动（技术字段）'),
      h(ui.Pre, null, JSON.stringify((life.current && life.current.activities) || [], null, 2))));
  }

  // ---------------------------------------------------------------------------
  // 页面
  // ---------------------------------------------------------------------------

  function OwnerHealthStatus() {
    const query = P.useApi(P.readPrivateHealthStatus, []);
    const source = query.data?.source;
    const freshness = source?.freshness;
    const label = ({ fresh: '数据较新', delayed: '同步延迟', stale: '数据已过期', no_data: '暂无样本', error: '读取异常' })[freshness?.status];
    return h(ui.Callout, { title: '主人健康 · 私有状态', tone: query.error ? 'warn' : 'neutral' },
      query.loading && !source ? '正在读取'
        : query.error || !source ? '健康来源暂不可用'
          : h('span', null, source.displayName || '健康来源', ' · ', label || '新鲜度未知',
            freshness?.newestSampleAt ? h('span', null, ' · 最新样本 ', h(ui.Timestamp, { at: freshness.newestSampleAt })) : null));
  }

  function LifePage() {
    const query = P.useApi(() => P.api.get('companion'), []);
    const [busy, setBusy] = P.useState(null);
    const [failure, setFailure] = P.useState(null);

    const data = query.data || null;
    const life = data && data.life ? data.life : null;
    const sections = (data && data.sections) || {};
    const runtime = (data && data.runtime) || {};
    const unavailable = Array.isArray(data && data.unavailable) ? data.unavailable : [];
    const loadingFirst = query.loading && !data;

    // 提示走外壳的全局通知（P.notice）；提示失败不影响写入结果本身。
    const notify = (message, tone) => {
      try {
        if (typeof P.notice === 'function') P.notice(message, tone);
        else if (typeof P.toastOnce === 'function') P.toastOnce(message, tone);
      } catch { /* 通知只是提示，失败不影响写入结果 */ }
    };

    // 写入：只有运行库真的回了回执才刷新界面；请求在飞的时候所有槽操作按钮都禁用。
    const runAction = (slot, action) => {
      if (!slot || !slot.slotId || busy) return;
      const actionLabel = ACTION_LABEL[action] || action;
      if (action === 'skip' && !P.confirm(`确定跳过「${slot.title || '这一段'}」吗？跳过之后今天不会再安排它。`)) return;
      setFailure(null);
      setBusy({ slotId: slot.slotId, action });
      P.api.post('plan-slot', {
        slotId: slot.slotId,
        action,
        reason: ACTION_REASON[action] || '',
      }).then((receipt) => {
        const confirmed = receipt && receipt.slotId === slot.slotId;
        notify(`${actionLabel}${confirmed ? '成功，运行库已确认' : '已提交'}`, 'ok');
        query.reload();
      }).catch((error) => {
        const message = typeof P.failText === 'function'
          ? P.failText(error, '运行库拒绝了这次操作。')
          : (error && error.message ? String(error.message) : '请求失败，运行库没有给出原因。');
        notify(`${actionLabel}失败 — ${message}`, 'danger');
        setFailure({ slot, action, message });
      }).then(() => setBusy(null), () => setBusy(null));
    };

    const failureNotice = failure
      ? h(ui.Callout, {
        tone: 'danger',
        title: `${ACTION_LABEL[failure.action] || failure.action}没有成功`,
        action: h(ui.Button, {
          variant: 'ghost',
          size: 'sm',
          onClick: () => runAction(failure.slot, failure.action),
        }, '重试'),
      },
      h('p', { className: 'cpxp-life-note' }, `运行库拒绝了这次操作：${failure.message}`),
      h('p', { className: 'cpxp-life-note' }, '这一段没有改变。'))
      : null;

    const runtimeNote = runtime.available === false
      ? h(ui.Callout, { tone: 'warn', title: '本地运行库不可用' },
        h('p', { className: 'cpxp-life-note' }, '日程、目标与承诺都可能是空的。'))
      : null;

    const statusLine = h('span', { className: 'cpxp-life-status' },
      '数据观测 ',
      data && data.observedAt ? h(ui.Timestamp, { at: data.observedAt }) : DASH,
      ' · ',
      runtime.available === true ? '运行库可用' : runtime.available === false ? '运行库不可用' : '运行库状态未知',
      h(ui.Info, { text: '时间统一按 Asia/Shanghai 显示；「数据观测」是这一次读取的时刻。' }));

    const body = loadingFirst
      ? h(ui.Skeleton, { rows: 6 })
      : query.error
        ? h(ui.ErrorBox, { error: query.error, onRetry: query.reload })
        : !data
          ? h(ui.Empty, { title: '没有读到陪伴数据', hint: '点页头的刷新再试一次。' })
          : life
            ? h('div', { className: 'cpxp-life-stack' },
              runtimeNote,
              h(BandNow, { life }),
              h(BandNext, { life, busy, onAction: runAction, notice: failureNotice }),
              h(BandToday, { life }),
              typeof P.readPrivateHealthStatus === 'function' ? h(OwnerHealthStatus) : null,
              h(BandExperience, { experience: life.experience }),
              h(BandEnded, { life }),
              h(BandPending, { life }),
              h(BandSkipped, { life }),
              h(BandGoals, { goals: sections.goals, unavailable }),
              h(BandCommitments, { commitments: sections.commitments, unavailable }),
              h(LifeDiagnostic, { life, unavailable }))
            : h('div', { className: 'cpxp-life-stack' },
              runtimeNote,
              h(ui.Callout, { tone: 'warn', title: '这一版运行库还没有「生活」视图' }),
              h(BandExperience, { experience: null }),
              h(BandGoals, { goals: sections.goals, unavailable }),
              h(BandCommitments, { commitments: sections.commitments, unavailable }),
              h(ui.Diagnostic, { title: '高级诊断', hint: '技术字段放这里。' },
                h(ui.KeyValue, {
                  items: [
                    { k: 'life 字段', v: '缺失', mono: true },
                    { k: '不可用分类', v: unavailable.length ? unavailable.join('、') : '无' },
                  ],
                })));

    return h(ui.Page, {
      title: '生活与日程',
      lead: '她今天的安排与已经过去的段落。',
      actions: [
        h(ui.Button, {
          key: 'refresh',
          variant: 'primary',
          onClick: query.reload,
          loading: query.loading,
          disabled: loadingFirst,
        }, '刷新'),
      ],
      status: statusLine,
    }, body);
  }

  P.registerPage({ id: 'life', label: '生活与日程', order: 20, component: LifePage });
})(P);

// ==== src/client/pages-health.js ====
// 健康与睡眠（page id: health，挂在「生活与日程」下面的二级 tab）
//
// 契约：design/health/INTERFACES.md —— §11 只读返回形状、§12 service、§13 Studio HTTP 路由、§15 禁止项。
//
// 这一页只回答四件事，页内用分段控件切成四段：
//   概览        今天的活动 / 心率 / 血氧 / 压力，每张卡都带样本时间与新鲜度；来源、设备与同步时间。
//   睡眠        最近主睡眠 + 阶段时间线 + 7/30 日趋势 + 午睡；没有就空态，绝不显示 0 小时。
//   活动与运动  日步数条形图（纯 CSS）+ 运动会话（原始 sportTypeRaw 与上游映射并列）。
//   关怀与证据  本轮只读占位：后端没有 health.care.* 代码路径，所以只写说明，不伪造候选、不做发送按钮。
//
// 数据只走 §13 的 6 条路由：GET {status,sources,today,trends,sleep} + POST {sync,maintenance}。
// 心跳共振（design/pulse-bond-20261103.md §7）另加一条：GET/POST api/companion-health/pulse
// —— 只喂「心跳 · 实时」这一张卡，秒级轮询并且只在卡片可见时进行。
// 不直连 8765 sidecar，不在浏览器里碰 token（同源 cookie 由宿主 Connection 认证）。
// 阈值只用于「新鲜度」这种产品参数，文案一律写明「产品参数，不是医学结论」。
(function (P) {
  const { h, ui } = P;

  P.css(`
    .cpxp-hl-stack { display:flex; flex-direction:column; gap:var(--cpx-s5,24px); min-width:0; }
    .cpxp-hl-toolbar { display:flex; align-items:center; justify-content:space-between; gap:var(--cpx-s3,12px); flex-wrap:wrap; min-width:0; }
    .cpxp-hl-tools { display:flex; align-items:center; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; }
    .cpxp-hl-tools-label { color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); white-space:nowrap; }
    .cpxp-hl-note { margin:0; max-width:72ch; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); line-height:1.7; overflow-wrap:anywhere; }
    .cpxp-hl-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:var(--cpx-s3,12px); min-width:0; }
    .cpxp-hl-fresh { display:inline-flex; align-items:center; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; }
    .cpxp-hl-kv { display:flex; flex-direction:column; gap:2px; min-width:0; }
    .cpxp-hl-kv-row { display:flex; align-items:baseline; justify-content:space-between; gap:var(--cpx-s2,8px); min-width:0; font-variant-numeric:tabular-nums; }
    .cpxp-hl-kv-k { color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); white-space:nowrap; }
    .cpxp-hl-kv-v { font-weight:600; text-align:right; overflow-wrap:anywhere; min-width:0; }
    .cpxp-hl-kv-v[data-empty="true"] { font-weight:400; color:var(--dsw-alias-label-secondary, inherit); }
    .cpxp-hl-card-foot { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:var(--cpx-s2,8px); padding-top:6px; border-top:1px solid var(--dsw-alias-border-l1); min-width:0; }
    .cpxp-hl-stages { display:flex; align-items:stretch; gap:0; height:16px; border-radius:999px; overflow:hidden; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); min-width:0; }
    .cpxp-hl-stage { min-width:2px; }
    .cpxp-hl-stage[data-stage="deep"] { background:var(--dsw-alias-brand-primary); }
    .cpxp-hl-stage[data-stage="light"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, var(--dsw-alias-bg-layer-2)); }
    .cpxp-hl-stage[data-stage="rem"] { background:var(--dsw-alias-state-success-primary); }
    .cpxp-hl-stage[data-stage="awake"] { background:var(--dsw-alias-state-warn-primary); }
    .cpxp-hl-stage[data-stage="unknown"] { background:var(--dsw-alias-state-idle-primary); }
    .cpxp-hl-stage-gap { min-width:2px; background:repeating-linear-gradient(135deg, var(--dsw-alias-border-l1) 0 4px, transparent 4px 8px); }
    .cpxp-hl-legend { display:flex; flex-wrap:wrap; gap:2px 14px; margin:0; padding:0; list-style:none; min-width:0; }
    .cpxp-hl-legend-item { display:inline-flex; align-items:center; gap:6px; color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); }
    .cpxp-hl-legend-dot { width:9px; height:9px; border-radius:2px; flex:none; border:1px solid var(--dsw-alias-border-l1); }
    .cpxp-hl-legend-dot[data-stage="deep"] { background:var(--dsw-alias-brand-primary); }
    .cpxp-hl-legend-dot[data-stage="light"] { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, var(--dsw-alias-bg-layer-2)); }
    .cpxp-hl-legend-dot[data-stage="rem"] { background:var(--dsw-alias-state-success-primary); }
    .cpxp-hl-legend-dot[data-stage="awake"] { background:var(--dsw-alias-state-warn-primary); }
    .cpxp-hl-legend-dot[data-stage="unknown"] { background:var(--dsw-alias-state-idle-primary); }
    .cpxp-hl-bars { display:flex; align-items:flex-end; justify-content:space-between; gap:3px; height:120px; padding-bottom:2px; border-bottom:1px solid var(--dsw-alias-border-l1); min-width:0; }
    .cpxp-hl-bar { flex:1 1 0; min-width:3px; max-width:40px; border-radius:2px 2px 0 0; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 82%, var(--dsw-alias-bg-layer-2)); }
    .cpxp-hl-bar[data-empty="true"] { background:transparent; border:1px dashed var(--dsw-alias-border-l2); border-bottom:0; border-radius:0; height:2px !important; }
    .cpxp-hl-bars-axis { display:flex; justify-content:space-between; gap:var(--cpx-s2,8px); color:var(--dsw-alias-label-secondary, inherit); font-size:11.5px; font-variant-numeric:tabular-nums; }
    .cpxp-hl-sleep-head { display:flex; align-items:baseline; gap:var(--cpx-s3,12px); flex-wrap:wrap; min-width:0; }
    .cpxp-hl-sleep-range { font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cpxp-hl-tag { display:inline-flex; align-items:center; gap:6px; padding:1px 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary, inherit); font-size:11.5px; white-space:nowrap; }
    .cpxp-hl-raw { font-family:var(--cpx-mono, monospace); font-size:11.5px; }
    /* 心跳 · 实时（契约 design/pulse-bond-20261103.md §7）：一张卡里只放现场读数与开关。 */
    .cpxp-pl-card { display:flex; flex-direction:column; gap:var(--cpx-s3,12px); min-width:0; }
    .cpxp-pl-top { display:flex; align-items:center; gap:var(--cpx-s3,12px); flex-wrap:wrap; min-width:0; }
    .cpxp-pl-bpm { display:flex; align-items:baseline; gap:6px; min-width:0; font-variant-numeric:tabular-nums; }
    .cpxp-pl-bpm-value { font-size:44px; line-height:1; font-weight:700; letter-spacing:-0.02em; }
    .cpxp-pl-bpm-value[data-empty="true"] { font-size:40px; font-weight:400; color:var(--dsw-alias-label-secondary, inherit); }
    .cpxp-pl-bpm-unit { color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); }
    .cpxp-pl-spark { flex:1 1 220px; min-width:150px; height:52px; display:flex; align-items:center; min-width:0; }
    .cpxp-pl-spark svg { display:block; width:100%; height:100%; }
    .cpxp-pl-kv { display:flex; flex-wrap:wrap; gap:2px 16px; min-width:0; font-variant-numeric:tabular-nums; }
    .cpxp-pl-kv-k { color:var(--dsw-alias-label-secondary, inherit); font-size:var(--cpx-fs-small, 12.5px); margin-right:4px; }
    .cpxp-pl-zones { display:flex; flex-wrap:wrap; gap:6px; min-width:0; }
    .cpxp-pl-zone { display:inline-flex; align-items:center; gap:6px; padding:1px 9px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary, inherit); font-size:11.5px; white-space:nowrap; }
    .cpxp-pl-zone[data-active="true"] { color:inherit; border-color:currentColor; font-weight:600; }
    .cpxp-pl-zone-dot { width:9px; height:9px; border-radius:999px; flex:none; background:var(--dsw-alias-state-idle-primary); }
    .cpxp-pl-zone[data-zone="calm"] .cpxp-pl-zone-dot { background:var(--dsw-alias-state-success-primary); }
    .cpxp-pl-zone[data-zone="warming"] .cpxp-pl-zone-dot { background:var(--dsw-alias-state-warn-primary); }
    .cpxp-pl-zone[data-zone="racing"] .cpxp-pl-zone-dot { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 60%, var(--dsw-alias-state-warn-primary)); }
    .cpxp-pl-zone[data-zone="peak"] .cpxp-pl-zone-dot { background:var(--dsw-alias-state-error-primary); }
    .cpxp-pl-actions { display:flex; align-items:center; gap:var(--cpx-s2,8px); flex-wrap:wrap; min-width:0; margin-top:var(--cpx-s2,8px); padding-top:8px; border-top:1px solid var(--dsw-alias-border-l1); }
    .cpxp-pl-consent { display:flex; flex-direction:column; gap:2px; min-width:0; margin-top:var(--cpx-s2,8px); }
    @media (max-width:760px) {
      .cpxp-hl-grid { grid-template-columns:1fr; }
      .cpxp-hl-bars { height:96px; }
      .cpxp-hl-tools { width:100%; }
      .cpxp-hl-tools .cpx-toolbar-right { width:100%; }
      .cpxp-pl-bpm-value { font-size:36px; }
      .cpxp-pl-spark { height:44px; }
    }
  `);

  // ---------------------------------------------------------------------------
  // 1. 取数：只走 §13 的六条路由，信封解包与 core.js 的 request() 完全一致
  // ---------------------------------------------------------------------------
  // core.js 的 apiBase() 写死在前缀 api/companion-memory/ 下，而健康路由挂在
  // api/companion-health/ 下；这一页片段没有 core.js 的写权限，所以在本地照抄同一套
  // fetch 语义（同源 cookie → credentials:'same-origin'、no-store、accept: json、
  // 信封 {ok,data,error} 解包、错误一律 ApiError）。不读、不传任何 token。
  const HEALTH_BASE = 'api/companion-health/';

  function healthBase() {
    try {
      return new URL(HEALTH_BASE, document.baseURI).href;
    } catch {
      return `/${HEALTH_BASE}`;
    }
  }

  function healthUrl(path, params) {
    let url = healthBase() + String(path || '').replace(/^\/+/, '');
    if (params) {
      const search = Object.keys(params)
        .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
        .join('&');
      if (search) url += (url.indexOf('?') >= 0 ? '&' : '?') + search;
    }
    return url;
  }

  // §11：只读查询自己失败时也长成 {ok:false, code, message}，只是套在信封的 data 里。
  const FAIL_FALLBACK = {
    'health-unavailable': '健康服务没有挂载到这个面板上。',
    'health-db-unavailable': '健康数据库还没打开，所以读不到数据。',
    'health-read-denied': '这项读取被授权开关挡下了。',
  };

  function unwrap(body, httpStatus) {
    if (!body || body.ok !== true) {
      const error = (body && body.error) || {};
      const code = error.code || 'unknown';
      const message = error.message || FAIL_FALLBACK[code] || `健康接口请求失败（HTTP ${httpStatus}）。`;
      throw withErrorCode(new P.ApiError(message, httpStatus, code), error.errorCode);
    }
    const data = body.data;
    if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
      const code = data.code || 'unknown';
      throw withErrorCode(
        new P.ApiError(data.message || FAIL_FALLBACK[code] || '健康服务没有给出原因。', httpStatus, code),
        data.errorCode,
      );
    }
    return data;
  }

  /**
   * 信封里的 `errorCode` 是"同一类失败的原因"（例如 `pulse-unreachable` 下的
   * `device-not-found` / `connect-timeout`）：挂到 ApiError 上，页面才能说清该做什么。
   */
  function withErrorCode(apiError, errorCode) {
    const reason = errorCode == null ? '' : String(errorCode).trim();
    if (reason) apiError.errorCode = reason;
    return apiError;
  }

  function healthRequest(path, options) {
    const settings = options || {};
    const hasBody = settings.body !== undefined;
    return fetch(healthUrl(path, settings.params), {
      method: settings.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(hasBody ? { body: JSON.stringify(settings.body) } : {}),
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
    }).then(
      (response) => response.json().then(
        (body) => unwrap(body, response.status),
        () => { throw new P.ApiError(`健康接口返回不是 JSON（HTTP ${response.status}）。`, response.status, 'bad-response'); },
      ),
      () => { throw new P.ApiError('无法连接宿主（桌面可能已关闭）。', 0, 'network'); },
    );
  }

  const healthGet = (path, params) => healthRequest(path, { params });
  P.readPrivateHealthStatus = () => healthGet('status');
  const healthPost = (path, body) => healthRequest(path, { method: 'POST', body: body || {} });

  const settle = (promise) => promise.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );

  /** 一次读齐四段要用的东西；某一项失败只影响它自己那一块。 */
  function loadHealth(days) {
    return Promise.all([
      settle(healthGet('status')),
      settle(healthGet('sources')),
      settle(healthGet('today')),
      settle(healthGet('sleep', { days, includeStages: true })),
      settle(healthGet('trends', { metric: 'steps', days })),
      settle(healthGet('care')),
    ]).then(async ([status, sources, todayResult, sleep, steps, care]) => {
      let today = todayResult;
      // 跨过午夜后"今天"还没有任何上传（手环还没把新的一天交上去），四张卡会全空。
      // 这时改看**最近有数据的那一天**，并把"这是哪一天"带到界面上——绝不冒充今天。
      //
      // 那一天从哪里来：优先用服务端给的 `latestDataDate`（明确字段）；服务端若是旧版本，
      // 就退回到 `freshness.newestSampleAt` 的本地日期部分（ISO 带 +08:00，前 10 位就是本地日）。
      const value = today && today.value;
      if (value) {
        const noDayData = value.hasTodayData === false
          || (!value.activity && !Object.values(value.metrics || {}).some(item => item && typeof item === 'object'));
        const newest = value.freshness && typeof value.freshness.newestSampleAt === 'string'
          ? value.freshness.newestSampleAt.slice(0, 10)
          : null;
        const candidate = value.latestDataDate || newest;
        if (noDayData && candidate && candidate !== value.date && /^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
          const earlier = await settle(healthGet('today', { date: candidate }));
          if (earlier.value) {
            today = { value: { ...earlier.value, fallbackFrom: value.date }, error: null };
          }
        }
      }
      return { days, status, sources, today, sleep, steps, care };
    });
  }

  // ---------------------------------------------------------------------------
  // 2. 词表：英文枚举一律翻成中文；认不出来的原样显示，不猜
  // ---------------------------------------------------------------------------
  const DASH = '—';

  // §6 QUALITY：只读结果里能出现的质量词。
  const QUALITY_LABEL = {
    fresh: '新鲜',
    delayed: '有延迟',
    stale: '已过期',
    no_data: '暂无数据',
    unsupported: '来源不支持',
    auth_required: '需要重新授权',
    rate_limited: '被上游限流',
    error: '读取失败',
  };

  // §11.2 capabilities 每个能力的取值。
  const CAPABILITY_LABEL = {
    supported: '来源支持',
    no_data: '来源支持·暂无数据',
    unsupported: '来源不支持',
    auth_required: '需要重新授权',
    error: '读取失败',
  };
  const CAPABILITY_TONE = {
    supported: 'ok',
    no_data: 'idle',
    unsupported: 'idle',
    auth_required: 'warn',
    error: 'danger',
  };
  // 状态词已在右侧状态列里出现，meta 这里写"这意味着什么"，不复述一遍状态名。
  const CAPABILITY_NOTE = {
    supported: '来源声明支持这项能力',
    no_data: '来源支持这项，但这些天没有数据',
    unsupported: '来源没有这项能力，界面上不会假装有',
    auth_required: '需要重新授权才能读到',
    error: '上一次读取失败了',
  };

  // 新鲜度：分布只有四档，第四档表示"连样本时间都没有"，绝不当成新鲜。
  const FRESH_LABEL = { fresh: '新鲜', delayed: '有延迟', stale: '已过期', unknown: '时间未知' };
  const FRESH_TONE = { fresh: 'ok', delayed: 'warn', stale: 'danger', unknown: 'idle' };
  // 产品参数：不是医学阈值，只是"这条读数多久以前采的"。
  const FRESH_RULES = { freshMinutes: 120, delayedMinutes: 1440 };

  const AUTH_LABEL = { valid: '鉴权有效', expiring: '鉴权即将过期', expired: '鉴权已过期', unknown: '鉴权状态未知', required: '需要重新授权' };
  const AUTH_TONE = { valid: 'ok', expiring: 'warn', expired: 'danger', unknown: 'idle', required: 'warn' };

  const AVAILABILITY = {
    awaiting_first_night: {
      title: '等待首夜华为云记录',
      hint: '云侧还没有回传第一夜。',
    },
    no_data: {
      title: '暂无来源数据',
      hint: '可能没戴设备，或云端没有上传。',
    },
    partial: {
      title: '睡眠数据不完整',
      hint: '阶段或时长缺一部分，缺的留空。',
    },
    present: { title: '有睡眠记录', hint: '' },
  };

  const STAGE_LABEL = { deep: '深睡', light: '浅睡', rem: '快速眼动', awake: '清醒', unknown: '未知阶段' };
  const STAGE_ORDER = ['deep', 'light', 'rem', 'awake', 'unknown'];

  const STAGE_FIDELITY_LABEL = {
    exact: '阶段完整',
    partial: '阶段部分缺失',
    not_reliable: '阶段不可信',
    unknown: '阶段未知',
  };
  const SESSION_STATUS_LABEL = {
    confirmed: '会话已确认',
    lite: '轻量记录',
    provisional: '临时记录',
    aggregate_only: '只有聚合时长',
  };
  const SESSION_QUALITY_LABEL = {
    'origin-confirmed': '来源原始记录',
    'aggregate-only': '只有聚合时长',
    partial: '部分数据',
  };

  const SYNC_STATUS_LABEL = {
    ok: '同步完成',
    partial: '同步部分完成',
    error: '同步失败',
    rate_limited: '被上游限流',
    skipped: '这次没有真的同步',
  };

  const CAPABILITY_ROWS = [
    { key: 'activity', label: '活动（步数、距离、千卡）' },
    { key: 'sport', label: '运动（训练记录）' },
    { key: 'heart_rate', label: '心率' },
    { key: 'stress', label: '压力' },
    { key: 'spo2', label: '血氧' },
    { key: 'device', label: '设备' },
  ];

  // §10 CAPABILITIES：本轮只有前四项可能为 true，后四项没有任何代码路径能打开。
  const CONSENT_ROWS = [
    { key: 'health.connect', label: '连接华为云', note: '允许本地采集器向华为 CN 云拉取数据' },
    { key: 'health.read.on_demand', label: '按需读取', note: '模型工具可以现场读一次健康数据' },
    { key: 'health.dashboard', label: '界面展示', note: '这一页可以显示健康数据' },
    { key: 'health.sleep.read', label: '睡眠读取', note: '模型工具可以读睡眠会话' },
    { key: 'health.context.auto', label: '自动注入上下文', note: '本轮不可启用：没有注入代码路径' },
    { key: 'health.memory.habits', label: '写进长期记忆', note: '本轮不可启用：没有写入代码路径' },
    { key: 'health.schedule.adjust', label: '调整日程', note: '本轮不可启用：没有日程写入路径' },
    { key: 'health.care.proactive', label: '主动健康关怀', note: '本轮不可启用：等 P2.5 QQ 回执与授权确认' },
    { key: 'health.export', label: '导出', note: '默认关闭，本页不提供入口' },
    { key: 'health.delete', label: '删除', note: '默认关闭，本页不提供入口' },
  ];

  // ---------------------------------------------------------------------------
  // 3. 小工具
  // ---------------------------------------------------------------------------
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);

  function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const at = Date.parse(String(value));
    return Number.isNaN(at) ? null : at;
  }

  /** 时长：null / 非数字一律破折号；0 照实写 0 分钟（真 0 与没测到不是一回事）。 */
  function durationText(minutes) {
    if (!finite(minutes) || minutes < 0) return DASH;
    const total = Math.round(minutes);
    if (total < 60) return `${total} 分钟`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }

  function stepsText(value) {
    if (!finite(value)) return DASH;
    return `${Math.round(value)} 步`;
  }

  function distanceText(meters) {
    if (!finite(meters)) return DASH;
    if (meters >= 1000) return `${(meters / 1000).toFixed(2)} 公里`;
    return `${Math.round(meters)} 米`;
  }

  function bpmText(value) {
    return finite(value) ? `${Math.round(value)} bpm` : DASH;
  }

  function percentText(value) {
    return finite(value) ? `${Math.round(value * 10) / 10}%` : DASH;
  }

  function scoreText(value) {
    return finite(value) ? String(Math.round(value * 10) / 10) : DASH;
  }

  /** 新鲜度只根据样本时间算，算不出来就是 unknown —— 不拿"看起来还行"代替。 */
  function freshnessOf(sampleAt, nowMs) {
    const at = toMs(sampleAt);
    if (at === null) return { status: 'unknown', ageMinutes: null };
    const ageMinutes = Math.max(0, Math.round((nowMs - at) / 60000));
    if (ageMinutes <= FRESH_RULES.freshMinutes) return { status: 'fresh', ageMinutes };
    if (ageMinutes <= FRESH_RULES.delayedMinutes) return { status: 'delayed', ageMinutes };
    return { status: 'stale', ageMinutes };
  }

  function freshnessChip(sampleAt, nowMs, prefix) {
    const fresh = freshnessOf(sampleAt, nowMs);
    return h('span', { className: 'cpxp-hl-fresh', title: `freshness=${fresh.status}（产品参数，不是医学结论）` },
      h(ui.StateLine, { state: FRESH_TONE[fresh.status], text: FRESH_LABEL[fresh.status] }),
      sampleAt
        ? h(ui.Timestamp, { at: sampleAt, prefix: prefix || '样本' })
        : h('span', { className: 'cpxp-hl-note' }, `${prefix || '样本'}时间未提供`));
  }

  const isUnavailable = (error) => Boolean(error) && (
    String(error.code || '') === 'health-unavailable'
    || String(error.code || '') === 'health-db-unavailable'
    || Number(error.status) === 404
  );

  function readError(error, label) {
    return h(ui.Callout, {
      tone: 'danger',
      title: `读不到${label}`,
      action: null,
    }, h('span', null, P.failText(error, '健康服务没有返回可用数据。')));
  }

  /** 一行指标；没有读数就写「—」，并保留"缺测"的说法。 */
  function kvRow(label, value, empty) {
    return h('div', { className: 'cpxp-hl-kv-row' },
      h('span', { className: 'cpxp-hl-kv-k' }, label),
      h('span', { className: 'cpxp-hl-kv-v', 'data-empty': empty ? 'true' : undefined }, value));
  }

  // ---------------------------------------------------------------------------
  // 4. 图：阶段时间线与日条形图都是内联 SVG / 纯 CSS，不引第三方库
  // ---------------------------------------------------------------------------
  function stageMinutes(stages) {
    const totals = {};
    stages.forEach((stage) => {
      const key = STAGE_ORDER.indexOf(stage.stage) >= 0 ? stage.stage : 'unknown';
      const from = toMs(stage.startAt);
      const to = toMs(stage.endAt);
      if (from === null || to === null || to <= from) return;
      totals[key] = (totals[key] || 0) + (to - from);
    });
    return totals;
  }

  /** 阶段横向时间线：宽度按真实时长分配，未覆盖的时段画成斜纹，绝不补 unknown。 */
  function StageTimeline({ session }) {
    const start = toMs(session && session.startAt);
    const end = toMs(session && session.endAt);
    const raw = Array.isArray(session && session.stages) ? session.stages : [];
    if (start === null || end === null || end <= start) return null;
    const stages = raw.map((stage) => ({
      stage: stage && stage.stage,
      from: toMs(stage && stage.startAt),
      to: toMs(stage && stage.endAt),
    })).filter((stage) => stage.from !== null && stage.to !== null && stage.to > stage.from);
    if (!stages.length) return null;

    const total = end - start;
    let covered = 0;
    const blocks = stages.map((stage, index) => {
      const span = Math.max(0, Math.min(stage.to, end) - Math.max(stage.from, start));
      covered += span;
      return h('span', {
        key: `s${index}`,
        className: 'cpxp-hl-stage',
        'data-stage': STAGE_ORDER.indexOf(stage.stage) >= 0 ? stage.stage : 'unknown',
        style: { flexGrow: String(Math.max(span, 1)) },
        title: `${STAGE_LABEL[stage.stage] || '未知阶段'} · ${P.fmt.clock(stage.from)}–${P.fmt.clock(stage.to)}`,
      });
    });
    const uncovered = Math.max(0, total - covered);
    if (uncovered > 0) {
      blocks.push(h('span', {
        key: 'gap',
        className: 'cpxp-hl-stage-gap',
        style: { flexGrow: String(Math.max(uncovered, 1)) },
        title: `无阶段数据 · ${Math.round(uncovered / 60000)} 分钟`,
      }));
    }

    const totals = stageMinutes(stages.map((stage) => ({
      stage: stage.stage,
      startAt: stage.from,
      endAt: stage.to,
    })));
    const legend = STAGE_ORDER.filter((key) => totals[key]).map((key) => h('li', {
      key: `lg-${key}`,
      className: 'cpxp-hl-legend-item',
    },
    h('span', { className: 'cpxp-hl-legend-dot', 'data-stage': key }),
    `${STAGE_LABEL[key]} ${durationText(totals[key] / 60000)}`));

    const summary = STAGE_ORDER.filter((key) => totals[key])
      .map((key) => `${STAGE_LABEL[key]} ${Math.round(totals[key] / 60000)} 分钟`)
      .join('，');
    // 覆盖率只算来源真的画出来的部分；没覆盖的时段留成斜纹，不补 unknown。
    const coverage = total > 0 ? Math.round((Math.min(covered, total) / total) * 100) : 0;

    return h(P.Fragment, null,
      h('div', { className: 'cpxp-hl-stages', role: 'img', 'aria-label': `睡眠阶段时间线：${summary || '没有可用阶段'}` }, blocks),
      h('p', { className: 'cpxp-hl-note' },
        `${P.fmt.range(session.startAt, session.endAt)} · 阶段覆盖 ${coverage}%`,
        coverage < 100 ? '（未覆盖处画斜纹）' : ''),
      legend.length ? h('ul', { className: 'cpxp-hl-legend' }, legend) : null);
  }

  /** 日条形图：value=null 的日子画成虚线小刻度，表示"缺测"而不是 0。 */
  function TrendBars({ points, label, unit, format }) {
    const list = Array.isArray(points) ? points : [];
    if (!list.length) return null;
    const values = list.map((point) => (finite(point && point.value) ? point.value : null));
    const known = values.filter((value) => value !== null);
    const max = known.length ? Math.max(...known) : 0;
    const scale = max > 0 ? max : 1;
    const fmt = format || ((value) => String(value));

    const bars = list.map((point, index) => {
      const value = values[index];
      const height = value === null ? 2 : Math.max(2, Math.round((value / scale) * 100));
      return h('span', {
        key: point && point.date ? point.date : `b${index}`,
        className: 'cpxp-hl-bar',
        'data-empty': value === null ? 'true' : undefined,
        style: { height: `${height}%` },
        title: `${(point && point.date) || DASH} · ${value === null ? '缺测' : fmt(value)}`,
      });
    });

    const first = list[0] && list[0].date;
    const last = list[list.length - 1] && list[list.length - 1].date;

    return h(P.Fragment, null,
      h('div', {
        className: 'cpxp-hl-bars',
        role: 'img',
        'aria-label': `${label}：${known.length ? `最高 ${fmt(max)}${unit || ''}` : '这段时间没有可用的读数'}`,
      }, bars),
      h('div', { className: 'cpxp-hl-bars-axis' },
        h('span', null, first ? String(first).slice(5) : DASH),
        h('span', null, known.length ? `最高 ${fmt(max)}${unit || ''} · ${known.length}/${list.length} 天有读数` : '全部缺测'),
        h('span', null, last ? String(last).slice(5) : DASH)));
  }

  // ---------------------------------------------------------------------------
  // 5. 段一：概览
  // ---------------------------------------------------------------------------
  function sampleOf(today, kind) {
    const realtime = today && today.realtime ? today.realtime[kind] : null;
    if (realtime && realtime.at) return { at: realtime.at, kind: 'realtime' };
    const fresh = today && today.freshness ? today.freshness : null;
    if (fresh && fresh.newestSampleAt) return { at: fresh.newestSampleAt, kind: 'newest' };
    return { at: null, kind: 'none' };
  }

  function metricCard(config) {
    const sample = config.sample;
    return h(ui.Card, {
      key: config.key,
      title: config.title,
      hint: config.hint,
    },
    h('div', { className: 'cpxp-hl-kv' }, config.rows),
    h('div', { className: 'cpxp-hl-card-foot' },
      freshnessChip(sample ? sample.at : null, config.nowMs,
        sample && sample.kind === 'newest' ? '来源最新' : '样本')));
  }

  function overviewSection(ctx) {
    const { today, status, sources, nowMs, days, bundle } = ctx;
    if (!today) {
      return h('div', { className: 'cpxp-hl-stack' },
        pulseBand(pulseConsentOf(status), ctx.onStatusReload),
        readError(bundle.today.error, '今天的活动与指标'));
    }

    const activity = today.activity || null;
    const metrics = today.metrics || {};
    const realtime = today.realtime || {};
    const heart = metrics.heartRate || null;
    const stress = metrics.stress || null;
    const spo2 = metrics.spo2 || null;
    const intensity = metrics.intensity || null;

    const activityRows = [
      kvRow('步数', activity && finite(activity.steps) ? stepsText(activity.steps) : '无可用记录', !(activity && finite(activity.steps))),
      kvRow('距离', activity && finite(activity.distanceM) ? distanceText(activity.distanceM) : '无可用记录', !(activity && finite(activity.distanceM))),
      kvRow('千卡', activity && finite(activity.kcal) ? `${Math.round(activity.kcal)} 千卡` : '无可用记录', !(activity && finite(activity.kcal))),
      kvRow('中高强度', intensity && finite(intensity.moderateHighMinutes)
        ? `${Math.round(intensity.moderateHighMinutes)} 分钟`
        : '无可用记录',
      !(intensity && finite(intensity.moderateHighMinutes))),
    ];

    const heartRows = [
      kvRow('最近', realtime.heartRate && finite(realtime.heartRate.value) ? bpmText(realtime.heartRate.value) : DASH,
        !(realtime.heartRate && finite(realtime.heartRate.value))),
      kvRow('最高', heart && finite(heart.max) ? bpmText(heart.max) : DASH, !(heart && finite(heart.max))),
      kvRow('最低', heart && finite(heart.min) ? bpmText(heart.min) : DASH, !(heart && finite(heart.min))),
      kvRow('静息', heart && finite(heart.resting) ? bpmText(heart.resting) : DASH, !(heart && finite(heart.resting))),
    ];

    const spo2Rows = [
      kvRow('平均', spo2 && finite(spo2.avg) ? percentText(spo2.avg) : DASH, !(spo2 && finite(spo2.avg))),
      kvRow('最低', spo2 && finite(spo2.min) ? percentText(spo2.min) : DASH, !(spo2 && finite(spo2.min))),
      kvRow('最高', spo2 && finite(spo2.max) ? percentText(spo2.max) : DASH, !(spo2 && finite(spo2.max))),
      kvRow('最近', realtime.spo2 && finite(realtime.spo2.value) ? percentText(realtime.spo2.value) : DASH,
        !(realtime.spo2 && finite(realtime.spo2.value))),
    ];

    const stressRows = [
      kvRow('平均', stress && finite(stress.avg) ? String(Math.round(stress.avg)) : DASH, !(stress && finite(stress.avg))),
      kvRow('最高', stress && finite(stress.max) ? String(Math.round(stress.max)) : DASH, !(stress && finite(stress.max))),
      kvRow('最低', stress && finite(stress.min) ? String(Math.round(stress.min)) : DASH, !(stress && finite(stress.min))),
      kvRow('最近', stress && finite(stress.last) ? String(Math.round(stress.last)) : DASH, !(stress && finite(stress.last))),
    ];

    const source = status && status.source ? status.source : null;
    const collector = status && status.collector ? status.collector : null;
    const db = status && status.db ? status.db : null;
    const auth = source && source.auth ? source.auth : null;
    const sourceList = Array.isArray(sources) ? sources : [];
    const notes = sourceList.reduce((all, item) => all.concat(Array.isArray(item && item.notes) ? item.notes : []), []);

    const sourceRows = [
      h(ui.Row, {
        key: 'devices',
        title: '设备',
        meta: db && finite(db.devices)
          ? `已登记 ${db.devices} 台 · 云端清单没有"在线/离线"字段，所以这里只能说登记了多少台`
          : '还没有读到设备清单',
        status: h(ui.StateLine, { state: db && finite(db.devices) ? 'ok' : 'idle', text: db && finite(db.devices) ? '已读取' : '未知' }),
      }),
      h(ui.Row, {
        key: 'sync',
        title: '最后同步',
        meta: '采集器最近一次从华为 CN 云拿到数据的时间',
        side: source && source.lastSuccessAt ? h(ui.Timestamp, { at: source.lastSuccessAt }) : '还没成功过',
      }),
      h(ui.Row, {
        key: 'auth',
        title: '鉴权',
        meta: auth && finite(auth.minutesLeft) ? `剩余约 ${Math.max(0, Math.round(auth.minutesLeft))} 分钟` : '来源没有给出剩余时间',
        status: h(ui.StateLine, {
          state: auth ? (AUTH_TONE[auth.status] || 'idle') : 'idle',
          text: auth ? (AUTH_LABEL[auth.status] || String(auth.status)) : '未知',
        }),
      }),
      h(ui.Row, {
        key: 'poll',
        title: '采集节奏',
        meta: collector
          ? `本地采集器每 ${collector.pollMinutes ?? DASH} 分钟一轮，窗口 ${collector.windowDays ?? DASH} 天；单飞运行`
          : '还没读到采集器状态',
        status: collector
          ? h(ui.StateLine, {
            state: collector.rateLimitedUntil ? 'warn' : collector.running ? 'live' : 'idle',
            text: collector.rateLimitedUntil ? '被限流中' : collector.running ? '在运行' : '未运行',
          })
          : h(ui.StateLine, { state: 'idle', text: '未知' }),
      }),
    ];

    return h('div', { className: 'cpxp-hl-stack' },
      // 心跳实时卡排在最前面：这一页第一眼应该看到他"现在"在跳。
      pulseBand(pulseConsentOf(status), ctx.onStatusReload),

      // 跨午夜时"今天"是空的：说清楚现在显示的是哪一天，而不是让四张卡空着让人以为坏了。
      today.fallbackFrom
        ? h(ui.Callout, { tone: 'info', title: `今天（${today.fallbackFrom}）还没有上传数据` },
          h('span', null, `下面显示的是 ${today.date} 的数据。`,
            h(ui.Info, { text: `华为云端最后一次同步到的那一天；今天一旦有新上传，这里会自动切回今天。睡眠与趋势不受影响。` })))
        : null,

      h(ui.Callout, { tone: 'info', title: '数据来自华为运动健康（CN 云）' },
        h('span', null, '设备上报什么就显示什么。',
          h(ui.Info, { text: `这些是设备/云端上报的指标，不是医学结论；来源没给的部分留空，不补值。每张卡的「新鲜」只表示这条读数多久以前采的：${FRESH_RULES.freshMinutes} 分钟内为新鲜，1 天内为有延迟，更久为已过期（产品参数）。` }))),

      h('div', { className: 'cpxp-hl-grid' },
        metricCard({
          key: 'activity',
          title: '活动',
          hint: activity && activity.observedAt ? `观测于 ${P.fmt.dateTime(activity.observedAt)}` : '今天还没有活动读数',
          sample: { at: activity ? activity.observedAt : null, kind: 'realtime' },
          nowMs,
          rows: activityRows,
        }),
        metricCard({
          key: 'heart',
          title: '心率',
          hint: '最近值来自云端最后上传',
          sample: sampleOf(today, 'heartRate'),
          nowMs,
          rows: heartRows,
        }),
        metricCard({
          key: 'spo2',
          title: '血氧',
          hint: '日均 / 最低 / 最高',
          sample: sampleOf(today, 'spo2'),
          nowMs,
          rows: spo2Rows,
        }),
        metricCard({
          key: 'stress',
          title: '压力',
          hint: '均值 / 最高 / 最低 / 最近',
          sample: sampleOf(today, 'stress'),
          nowMs,
          rows: stressRows,
        })),

      h(ui.Band, {
        title: '来源与同步',
        info: '只读：设备清单、鉴权与采集节奏都来自 status，不在这里改。',
        flush: true,
      }, h(ui.List, { label: '来源与同步状态' }, sourceRows)),

      notes.length
        ? h(ui.Callout, { tone: 'warn', title: '来源自己说明了为什么缺数据' },
          h('ul', { className: 'cpxp-hl-note' }, notes.map((note, index) => h('li', { key: `n${index}` }, String(note)))))
        : null,

      h(ui.Diagnostic, { title: '高级诊断', hint: 'status / sources 原始字段，只用于排查。' },
        h(ui.KeyValue, {
          items: [
            { k: 'status.schemaVersion', v: status ? status.schemaVersion : DASH, mono: true },
            { k: 'collector.baseUrl', v: collector && collector.baseUrl ? collector.baseUrl : DASH, mono: true },
            { k: 'collector.lastRunAt', v: collector && collector.lastRunAt ? collector.lastRunAt : DASH, mono: true },
            { k: 'collector.nextAllowedAt', v: collector && collector.nextAllowedAt ? collector.nextAllowedAt : DASH, mono: true },
            { k: 'source.lastErrorCode', v: source && source.lastErrorCode ? source.lastErrorCode : DASH, mono: true },
            { k: 'source.freshness', v: source && source.freshness ? `${source.freshness.status}（${source.freshness.ageMinutes ?? DASH} 分钟）` : DASH, mono: true },
            { k: 'db.observations / sleepSessions', v: db ? `${db.observations ?? DASH} / ${db.sleepSessions ?? DASH}` : DASH, mono: true },
            { k: 'today.date', v: today && today.date ? today.date : DASH, mono: true },
            { k: 'today.freshness', v: today && today.freshness ? `${today.freshness.status}（${today.freshness.ageMinutes ?? DASH} 分钟）` : DASH, mono: true },
            { k: '天数窗口', v: `${days} 天`, mono: true },
          ],
        })));
  }

  // ---------------------------------------------------------------------------
  // 5b. 心跳 · 实时（契约 design/pulse-bond-20261103.md §7）
  //
  // 这一张卡是整页里唯一会自己取数、自己轮询的地方：GET api/companion-health/pulse 每秒一次，
  // 而且**只在卡片真的在视口里、页面也可见时**才轮询（切走 tab / 滚出屏幕 / 页面隐藏都停）。
  // 三条硬规矩来自契约：
  //   1. `bpm` 是 null 就写「—」，绝不写 0（0 会被读成"没有心跳"）；
  //   2. `session.active === false` 时倒计时写「未开始」，不写 0 分钟；
  //   3. 心率不进任何缓存、不进别的页面、不进日志 —— 这里只有渲染，没有 store。
  // ---------------------------------------------------------------------------
  const PULSE_INTERVAL_MS = 1000;

  // 档位（契约 §4.5 的 zone）；颜色走主题变量，四档互不混淆。
  const PULSE_ZONES = [
    { id: 'calm', label: '平静' },
    { id: 'warming', label: '升温' },
    { id: 'racing', label: '加速' },
    { id: 'peak', label: '峰值' },
  ];
  const PULSE_TREND_LABEL = { up: '↑ 在涨', down: '↓ 在落', flat: '→ 平' };
  const PULSE_QUALITY_LABEL = { ok: '读数正常', sparse: '读数稀疏', 'no-contact': '没贴在皮肤上' };
  const PULSE_QUALITY_TONE = { ok: 'ok', sparse: 'warn', 'no-contact': 'warn' };
  const PULSE_SAFETY_LABEL = {
    'too-fast': '心率持续偏高一段时间了 —— 先停下来关心他，不要再加码，也别当成继续的许可。',
    'very-low': '读数偏低，先确认设备有没有戴好。',
    lost: '会话还开着，但读数已经断流很久了 —— 现在不知道他的状态，不要假装知道。',
  };
  const PULSE_FAIL_NOTE = {
    'health-unavailable': '健康服务没有挂载到这套组合上，所以读不到心跳。',
    'health-method-missing': '这一版健康服务还没有实时心跳接口（pulse）。',
    'pulse-disabled': '实时心率功能未启用（配置 pulse.enabled=false）。',
    'pulse-denied': '还没有授权读取实时心率（health.pulse.live）。',
    'pulse-unreachable': '心率广播接收端没有在跑（sidecar 不可达）。',
    'health-pulse-unavailable': '健康服务里的心跳模块没有加载起来。',
  };

  /**
   * `pulse-unreachable` 的两种原因对应两种完全不同的动作，所以分开说（Lead 裁决 2026-11-04）：
   * 没找到广播 → 去手环上开「心率广播」；连上了但超时 → 再点一次或重连。
   * 其它原因（unreachable / http-error / 没给 errorCode）沿用原来那句。
   */
  const PULSE_START_FAIL = {
    'device-not-found': '没找到在广播的手环：先在手环上把手表「心率广播」打开，再试一次。',
    'connect-timeout': '找到了手环但没连上（超时），再点一次「开始」或在设置里把它从蓝牙列表里重连。',
  };

  /** 心跳失败文案：`pulse-unreachable` 按 `errorCode` 细分，其余走通用 failText。 */
  function pulseFailText(error, fallback) {
    const code = error && error.code ? String(error.code) : '';
    const reason = error && error.errorCode ? String(error.errorCode) : '';
    if (code === 'pulse-unreachable' && PULSE_START_FAIL[reason]) return PULSE_START_FAIL[reason];
    return P.failText(error, fallback);
  }

  /**
   * 会话模式（契约 §4.4，2026-11-04 起默认跟随设备）：
   *   `device` —— 不设窗口，主人关掉手环广播后后端 ≤30 s 自动收口，卡片没有倒计时；
   *   `timer`  —— 只有主人显式给了 minutes 才有 endsAt/remainingMs。
   * 老版本没有 `mode` 字段：有 endsAt/minutes 就当 timer，否则按跟随设备处理。
   */
  function pulseSessionMode(session) {
    if (!session) return 'device';
    const mode = String(session.mode ?? '').trim().toLowerCase();
    if (mode === 'timer' || mode === 'device') return mode;
    return toMs(session.endsAt) !== null || finite(session.minutes) ? 'timer' : 'device';
  }

  /** 倒计时只属于 timer 模式；跟随设备的会话没有"窗口"，永远不返回剩余分钟。 */
  function pulseRemainingMinutes(session, nowMs) {
    if (!session || session.active !== true) return null;
    if (pulseSessionMode(session) !== 'timer') return null;
    const endsAt = toMs(session.endsAt);
    if (endsAt !== null) return Math.max(0, Math.ceil((endsAt - nowMs) / 60000));
    // 服务端已经算好了 remainingMs（不受浏览器时钟影响），退而用它。
    if (finite(session.remainingMs)) return Math.max(0, Math.ceil(session.remainingMs / 60000));
    return finite(session.minutes) ? Math.max(0, Math.round(session.minutes)) : null;
  }

  /** 后端给的"断开"信号（`pulse()` 顶层的 lastErrorCode，退而用 sidecar.errorCode）。 */
  function pulseDisconnectCode(view) {
    if (!view) return '';
    const top = view.lastErrorCode;
    const nested = view.sidecar && typeof view.sidecar === 'object' ? view.sidecar.errorCode : null;
    return String((top === undefined || top === null ? nested : top) ?? '').trim();
  }

  /**
   * 「设备被主人关掉，会话随之结束」——**预期行为**，不是故障，所以用一种中性说法。
   *
   * 三个条件必须同时成立（Lead 裁决 2026-11-04）：
   *   `lastErrorCode==='disconnected'` + `session.active!==true` + `sampleAgeMs > session.deviceOffMs`。
   *
   * 为什么不能只看 `disconnected`：`stop` 现在也会主动断开 BLE（让手环停广播省电），
   * 那一刻同样是 `connected:false` + `disconnected`；把它说成"设备被关掉"就撒谎了。
   * 也不能只看读数变旧：真的要静满 `deviceOffMs` 才算设备那边停了。
   */
  function pulseDeviceOff(view, session) {
    if (!view || !session || session.active === true) return false;
    if (pulseDisconnectCode(view) !== 'disconnected') return false;
    const offMs = finite(session.deviceOffMs) ? Number(session.deviceOffMs) : null;
    const ageMs = finite(view.sampleAgeMs) ? Number(view.sampleAgeMs) : null;
    return offMs !== null && ageMs !== null && ageMs > offMs;
  }

  /**
   * 主动结束（`stop` 会一并断开 BLE）：断开信号在，但还没静满 `deviceOffMs`。
   * 这时该说「已结束」，不该说「设备已关闭，会话随之结束」。
   */
  function pulseJustStopped(view, session, deviceOff) {
    if (deviceOff) return false;
    if (!view || !session || session.active === true) return false;
    return view.connected === false && pulseDisconnectCode(view) === 'disconnected';
  }

  /** 设备状态：只说读得到的那几件事，不编"搜索中"；关掉广播是中性事件，不报警。 */
  function pulseDeviceText(view, state) {
    if (!view) return { text: '还没读到心跳服务', tone: 'idle' };
    if (view.enabled === false) return { text: '功能未启用', tone: 'idle' };
    const reachable = view.sidecar && typeof view.sidecar === 'object' ? view.sidecar.reachable : null;
    if (reachable === false) return { text: '心率广播接收端不可达（sidecar 未运行）', tone: 'danger' };
    if (state && state.deviceOff) return { text: '设备已关闭，会话随之结束', tone: 'idle' };
    if (view.connected === false) {
      const label = view.deviceLabel ? String(view.deviceLabel) : '';
      // 我们自己 stop 时也断 BLE：那是主动结束，中性说明，不报警。
      if (state && state.justStopped) return { text: label ? `${label} 已断开` : '设备已断开', tone: 'idle' };
      return { text: label ? `${label} 已断开` : '设备未连接', tone: 'warn' };
    }
    if (view.deviceLabel) return { text: String(view.deviceLabel), tone: 'ok' };
    return { text: '未连接', tone: 'idle' };
  }

  /** 最近 ≤60 点的 sparkline：纯内联 SVG，没有读数就画一句说明，不画零线。 */
  function PulseSparkline({ series }) {
    const list = (Array.isArray(series) ? series : []).filter((point) => point && finite(point.bpm));
    if (list.length < 2) {
      return h('div', { className: 'cpxp-pl-spark' },
        h('span', { className: 'cpxp-hl-note' },
          list.length === 1 ? '只有一个读数，等下一个点再画曲线。' : '还没有连续读数，所以没有曲线。'));
    }
    const W = 240;
    const H = 52;
    const PAD = 4;
    const values = list.map((point) => point.bpm);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const x = (index) => (index / (list.length - 1)) * W;
    const y = (bpm) => (span === 0 ? H / 2 : PAD + (1 - (bpm - min) / span) * (H - PAD * 2));
    const d = list.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(point.bpm).toFixed(1)}`).join(' ');
    return h('div', {
      className: 'cpxp-pl-spark',
      role: 'img',
      'aria-label': `最近 ${list.length} 个读数，最低 ${min} bpm，最高 ${max} bpm`,
    }, h('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      h('path', {
        d,
        fill: 'none',
        stroke: 'var(--dsw-alias-brand-primary)',
        strokeWidth: '1.6',
        strokeLinejoin: 'round',
        strokeLinecap: 'round',
        vectorEffect: 'non-scaling-stroke',
      })));
  }

  /**
   * 1 Hz 取数。`active` 由调用方决定（卡片在视口里 + 页面可见）；
   * 关掉时立刻 clearInterval —— 不在 `document.hidden` 里空转。
   */
  function usePulseLive(active) {
    const [state, setState] = P.useState({ data: null, error: null, at: 0 });
    const [cycle, setCycle] = P.useState(0);
    const aliveRef = P.useRef(true);

    P.useEffect(() => {
      aliveRef.current = true;
      if (!active) {
        return () => { aliveRef.current = false; };
      }
      let inflight = false;
      const step = () => {
        if (!aliveRef.current || inflight) return;
        // 页面被切到后台：这一拍不发请求（可见性变化会把 active 置 false，这里再兜一次）。
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        inflight = true;
        healthGet('pulse').then(
          (data) => { if (aliveRef.current) setState({ data, error: null, at: Date.now() }); },
          (error) => {
            if (!aliveRef.current) return;
            // 读失败时保留上一份读数但标出来 —— 不能把旧 bpm 当成"现在"。
            setState((previous) => ({ data: previous.data, error, at: Date.now() }));
          },
        ).then(() => { inflight = false; }, () => { inflight = false; });
      };
      step();
      const timer = setInterval(step, PULSE_INTERVAL_MS);
      return () => {
        aliveRef.current = false;
        clearInterval(timer);
      };
    }, [active, cycle]);

    return { ...state, refresh: () => setCycle((value) => value + 1) };
  }

  function PulseCard({ consent, onReload }) {
    const hostRef = P.useRef(null);
    const [inView, setInView] = P.useState(true);
    const [pageVisible, setPageVisible] = P.useState(true);
    const [busy, setBusy] = P.useState(null);
    const [notice, setNotice] = P.useState(null);

    // 滚出视口就停轮询（没有 IntersectionObserver 的环境按"一直可见"处理）。
    P.useEffect(() => {
      const node = hostRef.current;
      if (typeof IntersectionObserver !== 'function' || !node) return undefined;
      const observer = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        setInView(Boolean(last && last.isIntersecting));
      }, { threshold: 0.15 });
      observer.observe(node);
      return () => observer.disconnect();
    }, []);

    // 页面切走（换窗口/最小化）也停。
    P.useEffect(() => {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
      const sync = () => setPageVisible(document.visibilityState !== 'hidden');
      sync();
      document.addEventListener('visibilitychange', sync);
      return () => document.removeEventListener('visibilitychange', sync);
    }, []);

    const live = usePulseLive(inView && pageVisible);
    const view = live.data || null;
    const nowMs = Date.now();

    const run = (action, payload) => {
      if (busy) return;
      setBusy(action);
      setNotice(null);
      healthPost('pulse', { action, ...(payload || {}) }).then((result) => {
        if (action === 'start') {
          const started = result && result.session && typeof result.session === 'object' ? result.session : null;
          const minutes = started && finite(started.minutes) ? Math.round(started.minutes) : null;
          const mode = pulseSessionMode(started);
          setNotice({
            tone: 'ok',
            text: mode === 'timer' && minutes
              ? `心跳会话开始了（${minutes} 分钟）。`
              : '心跳会话开始了：跟随设备，关掉手环广播就自动结束。',
          });
        } else if (action === 'stop') {
          const peak = result && result.summary && finite(result.summary.peakBpm) ? result.summary.peakBpm : null;
          setNotice({ tone: 'ok', text: peak ? `会话结束了，这次峰值 ${peak} bpm。` : '会话结束了。' });
        } else if (action === 'mark') {
          const bpm = result && result.mark && finite(result.mark.bpm) ? result.mark.bpm : null;
          setNotice({ tone: 'ok', text: bpm ? `已记下此刻：${bpm} bpm。` : '已记下此刻。' });
        } else {
          setNotice({ tone: 'ok', text: payload && payload.consent === true ? '已打开实时心率读取。' : '已关闭实时心率读取。' });
        }
        live.refresh();
        if (typeof onReload === 'function') onReload();
      }, (error) => {
        setNotice({ tone: 'danger', text: pulseFailText(error, '心跳动作没有完成。') });
      }).then(() => setBusy(null), () => setBusy(null));
    };

    const errorCode = live.error ? String(live.error.code || '') : '';
    const reachable = view && view.sidecar && typeof view.sidecar === 'object' ? view.sidecar.reachable : null;
    const session = view && view.session && typeof view.session === 'object' ? view.session : null;
    const sessionActive = Boolean(session && session.active === true);
    const sessionMode = pulseSessionMode(session);
    const remaining = pulseRemainingMinutes(session, nowMs);
    // 设备被关掉、会话随之收口（三个条件都成立）：这是预期行为，此时不再显示任何数字。
    const deviceOff = pulseDeviceOff(view, session);
    // 我们自己 stop 之后也会看到断开信号：那是「已结束」，不是「设备已关闭」。
    const justStopped = pulseJustStopped(view, session, deviceOff);
    // 没有读数就是「—」：`finite()` 挡掉 null / NaN，`> 0` 再挡一次 0 ——
    // 契约 §3.2 说得很清楚：无读数时 `bpm` 是 null，而 0 会被读成"没有心跳"。
    const bpm = !deviceOff && view && finite(view.bpm) && view.bpm > 0 ? Math.round(view.bpm) : null;
    const device = pulseDeviceText(view, { deviceOff, justStopped });
    const zone = view && view.zone ? String(view.zone) : '';
    const quality = view && view.quality ? String(view.quality) : '';
    const sampleAgeSec = view && finite(view.sampleAgeMs) ? Math.round(view.sampleAgeMs / 1000) : null;

    const metaLine = view
      ? [
        h('span', { key: 'quality' }, h(ui.StateLine, {
          state: PULSE_QUALITY_TONE[quality] || 'idle',
          text: PULSE_QUALITY_LABEL[quality] || '质量未知',
        })),
        sampleAgeSec === null
          ? null
          : h('span', { key: 'age' }, `读数 ${sampleAgeSec} 秒前`),
        h('span', { key: 'baseline' }, `基线 ${finite(view.baseline) ? Math.round(view.baseline) : DASH} bpm`),
        h('span', { key: 'trend' }, `近 1 分钟 ${PULSE_TREND_LABEL[view.trend] || DASH}`),
        h('span', { key: 'peak' }, view.peak && finite(view.peak.bpm)
          ? `本次峰值 ${Math.round(view.peak.bpm)} bpm${view.peak.at ? `（${P.fmt.clock(view.peak.at)}）` : ''}`
          : '本次峰值 —'),
      ]
      : [h('span', { key: 'idle' }, '还没有读数。')];

    return h('div', { className: 'cpxp-pl-card', ref: hostRef },
      h('div', { className: 'cpxp-pl-top' },
        h('div', { className: 'cpxp-pl-bpm' },
          h('strong', { className: 'cpxp-pl-bpm-value', 'data-empty': bpm === null ? 'true' : undefined, 'aria-live': 'polite' },
            bpm === null ? DASH : String(bpm)),
          h('span', { className: 'cpxp-pl-bpm-unit' }, 'bpm')),
        // 设备被关掉之后旧曲线也不再显示：那一拍已经没有"现在"的意思了。
        deviceOff
          ? h('div', { className: 'cpxp-pl-spark' },
            h('span', { className: 'cpxp-hl-note' }, '设备关掉之后没有新的读数。'))
          : h(PulseSparkline, { series: view ? view.series : null })),

      h('div', { className: 'cpxp-pl-zones', role: 'list', 'aria-label': '节奏档位' },
        PULSE_ZONES.map((item) => h('span', {
          key: item.id,
          className: 'cpxp-pl-zone',
          role: 'listitem',
          'data-zone': item.id,
          'data-active': zone === item.id ? 'true' : undefined,
          title: zone === item.id ? `当前档位：${item.label}` : `档位：${item.label}`,
        },
        h('span', { className: 'cpxp-pl-zone-dot' }),
        item.label))),

      h('div', { className: 'cpxp-pl-kv' }, metaLine),

      h('div', { className: 'cpxp-pl-kv' },
        h('span', null, h('span', { className: 'cpxp-pl-kv-k' }, '设备'),
          h(ui.StateLine, { state: device.tone, text: device.text })),
        h('span', null, h('span', { className: 'cpxp-pl-kv-k' }, '会话'),
          !sessionActive
            // 主动结束（stop 会断 BLE）与"设备被关掉"都落在收口之后：说「已结束」，不说「未开始」。
            ? (justStopped || deviceOff ? '已结束' : '未开始')
            : sessionMode === 'timer'
              ? (remaining === null
                ? '计时会话进行中'
                : remaining <= 0
                  ? '即将结束'
                  : `剩余 ${remaining} 分钟${session.startedAt ? `（${P.fmt.clock(session.startedAt)} 开始）` : ''}`)
              // 跟随设备：没有窗口，所以只说"从什么时候开始"，不报倒计时。
              : `跟随设备${session.startedAt ? `（${P.fmt.clock(session.startedAt)} 开始）` : ''}`)),

      view && view.safety && PULSE_SAFETY_LABEL[view.safety]
        ? h(ui.Callout, { tone: 'danger', title: '注意' }, h('span', null, PULSE_SAFETY_LABEL[view.safety]))
        : null,

      live.error
        ? h(ui.Callout, { tone: 'warn', title: '这一拍没读到心跳' },
          h('span', null, PULSE_FAIL_NOTE[errorCode] || pulseFailText(live.error, '心跳接口没有返回数据。')))
        : null,
      view && view.enabled === false
        ? h(ui.Callout, { tone: 'info', title: '实时心率未启用' },
          h('span', null, '配置里 pulse.enabled=false，所以这张卡不会显示数字。'))
        : null,
      notice
        ? h(ui.Callout, { tone: notice.tone === 'ok' ? 'ok' : 'danger', title: notice.tone === 'ok' ? '已生效' : '没有生效' },
          h('span', null, notice.text))
        : null,

      h('div', { className: 'cpxp-pl-actions' },
        h(ui.Button, {
          key: 'start',
          variant: 'primary',
          size: 'sm',
          onClick: () => run('start'),
          loading: busy === 'start',
          disabled: Boolean(busy) || sessionActive || reachable === false,
          title: '开一段心跳会话：跟随设备，主人关掉手环广播后会自动结束；只有会话开着，模型才会看到【心跳读数】行',
        }, '开始'),
        h(ui.Button, {
          key: 'stop',
          variant: 'ghost',
          size: 'sm',
          onClick: () => run('stop'),
          loading: busy === 'stop',
          disabled: Boolean(busy) || !sessionActive,
          title: '结束这一段心跳会话（峰值与档位分布会记进会话摘要，不记原始曲线）',
        }, '结束'),
        h(ui.Button, {
          key: 'mark',
          variant: 'ghost',
          size: 'sm',
          onClick: () => run('mark'),
          loading: busy === 'mark',
          disabled: Boolean(busy) || !sessionActive,
          title: '把此刻标记一下（记下时间与当时读数）',
        }, '此刻标记')),

      h('div', { className: 'cpxp-pl-consent' },
        h(ui.Toggle, {
          checked: consent === true,
          disabled: Boolean(busy),
          label: '允许读取实时心率（health.pulse.live）',
          hint: consent === true
            ? '已打开：她读得到此刻的心率。'
            : consent === false
              ? '已关闭：这张卡不显示数字。'
              : '状态未知；开关仍然可以写。',
          onChange: (next) => run('consent', { consent: next === true }),
        }),
        h(ui.Info, { text: '心跳数据只在这一张卡里：不写进记忆、不进日志、不画到别的页面；打开后读得到此刻心率，读不到历史曲线。会话默认跟随设备，关掉手环广播后后端会自动收口，这里不需要倒计时。空闲时不扫描、不轮询；秒级刷新只在卡片可见时进行，切到别的 tab 就停。' })));
  }

  /** `health.pulse.live` 的当前授权：只有真的读到布尔才敢说"开/关"，读不到就是 null（未知）。 */
  function pulseConsentOf(status) {
    const consents = status && status.consents && typeof status.consents === 'object' ? status.consents : null;
    if (!consents) return null;
    const value = consents['health.pulse.live'];
    return value === true || value === false ? value : null;
  }

  /** 一张卡 = 一个 Band；概览与"整页读不到"两种状态下都挂同一份（不新建页面入口）。 */
  function pulseBand(consent, onReload) {
    return h(ui.Band, {
      title: '心跳 · 实时',
      hint: '设备在广播时才有数字，没有就写「—」。',
      info: '心跳数据不写进记忆、不进日志、不画到别的页面；会话跟随设备，关掉广播后自动收口；空闲时不扫描、不轮询。这不是医学判断。',
    }, h(PulseCard, { consent, onReload }));
  }

  // ---------------------------------------------------------------------------
  // 6. 段二：睡眠
  // ---------------------------------------------------------------------------
  function sortSessions(sessions) {
    return sessions.filter(Boolean).slice().sort((left, right) => {
      const leftAt = toMs(left.startAt) ?? toMs(`${left.sleepDate}T00:00:00+08:00`) ?? 0;
      const rightAt = toMs(right.startAt) ?? toMs(`${right.sleepDate}T00:00:00+08:00`) ?? 0;
      return rightAt - leftAt;
    });
  }

  function mainSleepCard(payload, session, nowMs) {
    if (!session) {
      const availability = (payload && payload.availability) || 'no_data';
      const view = AVAILABILITY[availability] || AVAILABILITY.no_data;
      const title = availability === 'awaiting_first_night'
        ? '睡眠会话 — 等待首夜华为云记录'
        : '睡眠会话 — 暂无来源数据';
      return h(ui.Empty, {
        title,
        hint: view.hint,
      });
    }

    const hasRange = toMs(session.startAt) !== null && toMs(session.endAt) !== null;
    const rows = [
      kvRow('入睡', durationText(session.asleepMinutes), !finite(session.asleepMinutes)),
      kvRow('清醒', durationText(session.awakeMinutes), !finite(session.awakeMinutes)),
      kvRow('在床', durationText(session.inBedMinutes), !finite(session.inBedMinutes)),
    ];

    // 分期**分钟数**：来源给的是"深睡 67 / 浅睡 188 / REM 44"这种合计，而不是逐段起止。
    // 有合计就如实显示合计，没有就留空；时间轴另在「睡眠阶段」里，缺区间时不画。
    const stageMin = session.stageMinutes || {};
    const hasStageMinutes = finite(stageMin.deep) || finite(stageMin.light) || finite(stageMin.rem);
    const stageRows = hasStageMinutes
      ? [
        kvRow('深睡', durationText(stageMin.deep), !finite(stageMin.deep)),
        kvRow('浅睡', durationText(stageMin.light), !finite(stageMin.light)),
        kvRow('REM', durationText(stageMin.rem), !finite(stageMin.rem)),
      ]
      : null;
    const stageTimelineMissing = hasStageMinutes && !(Array.isArray(session.stages) && session.stages.length);

    return h('div', { className: 'cpxp-hl-stack' },
      h('div', { className: 'cpxp-hl-sleep-head' },
        h('strong', null, session.sleepDate || DASH),
        h('span', { className: 'cpxp-hl-sleep-range' },
          hasRange ? P.fmt.range(session.startAt, session.endAt) : '来源只给了总时长，没有起止时间'),
        h('span', { className: 'cpxp-hl-tag' }, SESSION_STATUS_LABEL[session.status] || String(session.status || '状态未知')),
        h('span', { className: 'cpxp-hl-tag' }, SESSION_QUALITY_LABEL[session.sessionQuality] || String(session.sessionQuality || DASH))),
      h('div', { className: 'cpxp-hl-kv' }, rows),
      stageRows ? h('div', { className: 'cpxp-hl-kv' }, stageRows) : null,
      h('p', { className: 'cpxp-hl-note' },
        '阶段保真度：', STAGE_FIDELITY_LABEL[session.stageFidelity] || DASH,
        stageTimelineMissing ? '（来源只给了分期合计）' : ''),
      freshnessChip(session.endAt || null, nowMs, '醒来'));
  }

  function sleepSection(ctx) {
    const { sleep, nowMs, days, bundle } = ctx;
    if (!sleep) {
      return readError(bundle.sleep.error, '睡眠数据');
    }

    const availability = sleep.availability || 'no_data';
    const sessions = Array.isArray(sleep.sessions) ? sortSessions(sleep.sessions) : [];
    const naps = sessions.filter((session) => session && session.isNap);
    const mains = sessions.filter((session) => !session || !session.isNap);
    const main = mains.length ? mains[0] : null;
    const trend = Array.isArray(sleep.trend) ? sleep.trend : [];
    const notes = Array.isArray(sleep.notes) ? sleep.notes : [];

    const trendPoints = trend.map((point) => ({
      date: point && point.sleepDate,
      value: finite(point && point.asleepMinutes) ? point.asleepMinutes : null,
    }));

    // 主动关怀（health.care.proactive）：把"今晚会说什么"原样摆出来，含是否已投递。
    // 我们只转述服务给的内容 —— 授权关着时服务返回空数组，这里就什么都不显示，不补不猜。
    const careBundle = bundle.care && bundle.care.value ? bundle.care.value : null;
    const careItems = careBundle && Array.isArray(careBundle.items) ? careBundle.items : [];
    const careBand = careBundle && careBundle.enabled
      ? h(ui.Band, {
        title: '主动关怀',
        hint: '一天只说一次，只说来源报过的事实；不外发到任何平台，也不给建议。',
      },
      careItems.length
        ? careItems.map(item => h(ui.Row, {
          key: item.dedupeKey,
          title: item.sleepDate || DASH,
          meta: item.text,
          status: h(ui.StateLine, {
            state: item.delivered ? 'ok' : 'idle',
            text: item.delivered ? '已提示' : '待提示（下次对话时说）',
          }),
        }))
        : h(ui.Empty, { title: '现在没有要说的', hint: '昨晚的睡眠已经说过，或者醒来超过 18 小时、数据还没到。' }))
      : null;

    // 阶段：只有真的给了阶段明细才画；标题里说清是哪个会话。
    const stageSource = main || (sessions.length ? sessions[0] : null);
    const stageList = stageSource && Array.isArray(stageSource.stages) ? stageSource.stages : [];
    const stageHasRange = Boolean(stageSource)
      && toMs(stageSource.startAt) !== null && toMs(stageSource.endAt) !== null;
    const hasStages = stageHasRange && stageList.some((stage) => {
      const from = toMs(stage && stage.startAt);
      const to = toMs(stage && stage.endAt);
      return from !== null && to !== null && to > from;
    });

    const napList = naps.length
      ? h(ui.List, { label: '午睡记录' }, naps.map((session, index) => h(ui.Row, {
        key: session.sleepDate ? `nap-${session.sleepDate}-${index}` : `nap-${index}`,
        title: session.sleepDate || '午睡',
        meta: toMs(session.startAt) !== null && toMs(session.endAt) !== null
          ? P.fmt.range(session.startAt, session.endAt)
          : '来源只给了总时长，没有起止时间',
        side: durationText(session.asleepMinutes),
      })))
      : h(ui.Empty, { title: '午睡 — 没有记录', hint: '这段时间里来源没有把任何会话标成午睡。', compact: true });

    return h('div', { className: 'cpxp-hl-stack' },
      careBand,

      h(ui.Band, {
        title: '最近主睡眠',
        info: '只有来源真的给了时长或起止才写数字；缺的部分留空，不拿 0 或估算值占位。来源只给分期合计时，只报时长、不画时间轴（不拿时长反推顺序）。',
      }, mainSleepCard(sleep, main, nowMs)),

      h(ui.Band, {
        title: '睡眠阶段',
        info: '阶段时间线按来源给的区间画；来源没覆盖的时段画成斜纹，不补 unknown。',
      }, hasStages
        ? h('div', { className: 'cpxp-hl-stack' },
          h('p', { className: 'cpxp-hl-note' }, `会话：${stageSource.sleepDate || DASH} · 阶段保真度 ${STAGE_FIDELITY_LABEL[stageSource.stageFidelity] || DASH}`),
          h(StageTimeline, { session: stageSource }))
        : h(ui.Empty, {
          title: '睡眠阶段 — 暂无来源数据',
          hint: stageSource && stageSource.status === 'aggregate_only'
            ? '来源只给了总时长，没有阶段明细。'
            : '来源没有给阶段明细。',
        })),

      h(ui.Band, {
        title: `近 ${days} 天睡眠趋势`,
        info: '没有记录的一夜画成虚线刻度，不算 0。',
      }, trendPoints.some((point) => point.value !== null)
        ? h(TrendBars, { points: trendPoints, label: '入睡时长', unit: '', format: (value) => durationText(value) })
        : h(ui.Empty, {
          title: `睡眠趋势 — ${availability === 'awaiting_first_night' ? '等待首夜华为云记录' : '暂无来源数据'}`,
          hint: '这段时间里没有任何一夜的睡眠时长。',
        })),

      h(ui.Band, { title: '原厂评分', hint: '只显示来源自己给的评分，不自己算分。' },
        finite(main && main.sourceScore)
          ? h('div', { className: 'cpxp-hl-sleep-head' },
            h('strong', null, scoreText(main.sourceScore)),
            h('span', { className: 'cpxp-hl-tag' }, main.sourceScoreLabel ? String(main.sourceScoreLabel) : '来源未给标签'),
            h('span', { className: 'cpxp-hl-note' }, `会话 ${main.sleepDate || DASH}`))
          : h(ui.Empty, {
            title: '原厂评分 — 暂无来源数据',
            hint: '华为侧没有给评分。这里不会用自己的算法替代原厂评分。',
          })),

      h(ui.Band, { title: '午睡', hint: '结束时间落在本地 10:00–20:00 且时长不足 3 小时的会话算午睡。' }, napList),

      notes.length
        ? h(ui.Callout, { tone: 'warn', title: '来源对睡眠的说明' },
          h('ul', { className: 'cpxp-hl-note' }, notes.map((note, index) => h('li', { key: `sn${index}` }, String(note)))))
        : null,

      h(ui.Diagnostic, { title: '高级诊断', hint: 'sleep 路由的原始字段。' },
        h(ui.KeyValue, {
          items: [
            { k: 'availability', v: availability, mono: true },
            { k: 'range', v: sleep.range ? `${sleep.range.from} → ${sleep.range.to}` : DASH, mono: true },
            { k: 'sessions / naps', v: `${sessions.length} / ${naps.length}`, mono: true },
            { k: 'includeStages', v: 'true', mono: true },
            { k: 'trend 点数', v: String(trendPoints.length), mono: true },
          ],
        })));
  }

  // ---------------------------------------------------------------------------
  // 7. 段三：活动与运动
  // ---------------------------------------------------------------------------
  function sportRow(workout, index) {
    const label = workout && workout.sportTypeLabel ? String(workout.sportTypeLabel) : null;
    const raw = workout && workout.sportTypeRaw !== null && workout.sportTypeRaw !== undefined
      ? String(workout.sportTypeRaw)
      : DASH;
    const mapping = workout && workout.sportTypeMapping ? String(workout.sportTypeMapping) : DASH;
    const range = workout && toMs(workout.startAt) !== null && toMs(workout.endAt) !== null
      ? P.fmt.range(workout.startAt, workout.endAt)
      : DASH;
    const facts = [
      finite(workout && workout.durationMin) ? durationText(workout.durationMin) : null,
      finite(workout && workout.steps) ? stepsText(workout.steps) : null,
      finite(workout && workout.distanceM) ? distanceText(workout.distanceM) : null,
      finite(workout && workout.kcal) ? `${Math.round(workout.kcal)} 千卡` : null,
    ].filter(Boolean);

    return h(ui.Row, {
      key: `w-${index}`,
      title: label
        ? `${label}（原始码 ${raw}）`
        : `未映射的运动类型（原始码 ${raw}）`,
      meta: [
        range,
        `映射来源 ${mapping === 'upstream_const' ? '上游常量表' : mapping}`,
        facts.length ? facts.join(' · ') : '来源没有给时长/距离等明细',
      ].join(' · '),
      side: workout && workout.quality
        ? h(ui.Badge, { tone: 'neutral' }, QUALITY_LABEL[workout.quality] || String(workout.quality))
        : null,
    });
  }

  function activitySection(ctx) {
    const { today, steps, days, bundle } = ctx;
    const trend = steps || null;
    const workouts = today && Array.isArray(today.workouts) ? today.workouts : [];
    const activity = today ? today.activity : null;
    const points = trend && Array.isArray(trend.points) ? trend.points : [];
    const aggregate = trend && trend.aggregate ? trend.aggregate : null;

    return h('div', { className: 'cpxp-hl-stack' },
      h(ui.Band, {
        title: `近 ${days} 天步数`,
        hint: '纯 CSS 条形图：每根柱子是一天的步数，虚线刻度表示那天没有读数（不是 0 步）。',
      }, [
        !trend
          ? readError(bundle.steps.error, '步数趋势')
          : trend.supported === false
            ? h(ui.Empty, { title: '步数趋势 — 来源不支持', hint: '这个来源没有日报步数，所以没有图可画。' })
            : points.some((point) => finite(point && point.value))
              ? h('div', { className: 'cpxp-hl-stack' },
                h(TrendBars, {
                  points,
                  label: '步数',
                  unit: ' 步',
                  format: (value) => `${Math.round(value)} 步`,
                }),
                aggregate
                  ? h('p', { className: 'cpxp-hl-note' },
                    `有读数 ${aggregate.coveredDays ?? DASH} 天 · 缺测 ${aggregate.missingDays ?? DASH} 天 · `
                    + `平均 ${finite(aggregate.mean) ? Math.round(aggregate.mean) : DASH} 步 · `
                    + `最高 ${finite(aggregate.max) ? Math.round(aggregate.max) : DASH} 步 · `
                    + `最低 ${finite(aggregate.min) ? Math.round(aggregate.min) : DASH} 步`)
                  : null)
              : h(ui.Empty, { title: '步数趋势 — 暂无来源数据', hint: '这段时间里一天都没有步数读数。' }),
        activity && finite(activity.stepGoal) && finite(activity.steps)
          ? h(ui.Meter, {
            value: activity.steps,
            max: activity.stepGoal,
            label: '今日步数 / 目标（目标值来自来源）',
          })
          : null,
      ]),

      h(ui.Band, {
        title: '今天的运动会话',
        info: '运动类型同时显示原始码与上游映射标签；映射是上游常量表的文本，我们没有核实过。',
      }, [
        workouts.length
          ? h(ui.List, { label: '运动会话' }, workouts.map(sportRow))
          : h(ui.Empty, {
            title: '运动会话 — 今天没有记录',
            hint: today ? '今天云端没有回传训练记录。' : '今天的接口没有读到，先刷新看看。',
            compact: true,
          }),
      ]),

      h(ui.Diagnostic, { title: '高级诊断', hint: 'trend / workouts 原始字段。' },
        h(ui.KeyValue, {
          items: [
            { k: 'trend.metric', v: trend && trend.metric ? trend.metric : DASH, mono: true },
            { k: 'trend.unit', v: trend && trend.unit ? String(trend.unit) : DASH, mono: true },
            { k: 'trend.points', v: String(points.length), mono: true },
            { k: 'today.workouts', v: String(workouts.length), mono: true },
            { k: 'sportTypeMapping', v: workouts.length ? String(workouts[0].sportTypeMapping || DASH) : DASH, mono: true },
          ],
        })));
  }

  // ---------------------------------------------------------------------------
  // 8. 段四：关怀与证据（本轮只读占位）
  // ---------------------------------------------------------------------------
  function careSection(ctx) {
    const { status } = ctx;
    const consents = status && status.consents && typeof status.consents === 'object' ? status.consents : null;

    const consentRows = CONSENT_ROWS.map((row) => {
      const value = consents ? consents[row.key] : undefined;
      const state = value === true ? 'ok' : value === false ? 'idle' : 'warn';
      const text = value === true ? '已启用' : value === false ? '未启用' : '状态未知';
      return h(ui.Row, {
        key: `consent-${row.key}`,
        title: row.label,
        meta: row.note,
        status: h(ui.StateLine, { state, text }),
      });
    });

    return h('div', { className: 'cpxp-hl-stack' },
      h(ui.Callout, { tone: 'info', title: '本轮未启用' }),

      h(ui.Band, {
        title: '为什么考虑 / 为什么沉默',
        info: '这一段是占位：后端本轮没有 health.care.* 的任何代码路径（能力键 health.care.proactive 默认关闭且无法打开），所以既没有候选，也没有"考虑了但选择不说"的记录。这一页不会伪造候选，也不会出现发送按钮；等 P2.5 的 QQ 回执与授权确认完成后，才谈得上"要不要主动关怀"。',
      }, h(ui.List, { label: '关怀候选占位' },
        h(ui.Row, {
          key: 'care-why',
          title: '为什么考虑',
          meta: '本期没有候选生成路径。',
          status: h(ui.Badge, { tone: 'neutral' }, '未启用'),
        }),
        h(ui.Row, {
          key: 'care-silent',
          title: '为什么沉默',
          meta: '本期也没有沉默记录。',
          status: h(ui.Badge, { tone: 'neutral' }, '未启用'),
        }))),

      h(ui.Band, {
        title: '授权开关（只读）',
        info: '这些开关在健康服务自己的 consents 表里；本页只显示当前状态，不提供修改入口。',
      }, h(ui.List, { label: '健康能力授权状态' }, consentRows)),

      h(ui.Band, {
        title: '每项能力的支持状态',
        info: '来源自己声明的能力边界；「来源支持·暂无数据」和「来源不支持」是两件事。',
      }, (() => {
        const list = Array.isArray(ctx.sources) ? ctx.sources : [];
        if (!list.length) {
          return h(ui.Empty, {
            title: '能力状态 — 读不到来源清单',
            hint: ctx.bundle.sources.error
              ? P.failText(ctx.bundle.sources.error, 'sources 路由没有返回数据。')
              : '健康服务没有给出来源清单。',
            compact: true,
          });
        }
        return h('div', { className: 'cpxp-hl-stack' }, list.map((source) => {
          const capabilities = source && source.capabilities ? source.capabilities : {};
          const sleep = capabilities.sleep && typeof capabilities.sleep === 'object' ? capabilities.sleep : null;
          return h(ui.List, { key: `caps-${source.id || 'source'}`, label: `${source.name || source.id || '来源'} 能力` }, [
            ...CAPABILITY_ROWS.map((row) => {
              const value = capabilities[row.key];
              return h(ui.Row, {
                key: `cap-${row.key}`,
                title: row.label,
                meta: value ? (CAPABILITY_NOTE[value] || String(value)) : '来源没有声明这项能力',
                status: h(ui.StateLine, {
                  state: value ? (CAPABILITY_TONE[value] || 'idle') : 'idle',
                  text: value ? (CAPABILITY_LABEL[value] || String(value)) : '未声明',
                }),
              });
            }),
            h(ui.Row, {
              key: 'cap-sleep',
              title: '睡眠',
              meta: sleep
                ? `阶段保真度：${STAGE_FIDELITY_LABEL[sleep.stageFidelity] || DASH}`
                : '来源没有声明睡眠能力',
              status: h(ui.StateLine, {
                state: sleep ? (sleep.supported ? 'ok' : 'idle') : 'idle',
                text: sleep ? (CAPABILITY_LABEL[sleep.status] || String(sleep.status || '未知')) : '未声明',
              }),
            }),
          ]);
        }));
      })()));
  }

  // ---------------------------------------------------------------------------
  // 9. 页面
  // ---------------------------------------------------------------------------
  const SECTION_OPTIONS = [
    { id: 'overview', label: '概览' },
    { id: 'sleep', label: '睡眠' },
    { id: 'activity', label: '活动与运动' },
    { id: 'care', label: '关怀与证据' },
  ];

  const DAY_OPTIONS = [
    { id: '7', label: '近 7 天' },
    { id: '30', label: '近 30 天' },
  ];

  function HealthPage() {
    const [section, setSection] = P.useState('overview');
    const [days, setDays] = P.useState(7);
    const [busy, setBusy] = P.useState(null);
    const [actionError, setActionError] = P.useState(null);
    const [actionNotice, setActionNotice] = P.useState(null);

    const query = P.useApi(() => loadHealth(days), [days]);
    const bundle = query.data || null;

    const notify = (message, tone) => {
      try {
        if (typeof P.notice === 'function') P.notice(message, tone);
      } catch { /* 通知只是提示 */ }
    };

    const status = bundle && bundle.status ? bundle.status.value : null;
    const sources = bundle && bundle.sources ? bundle.sources.value : null;
    const today = bundle && bundle.today ? bundle.today.value : null;
    const sleep = bundle && bundle.sleep ? bundle.sleep.value : null;
    const steps = bundle && bundle.steps ? bundle.steps.value : null;

    const source = status && status.source ? status.source : null;
    const sourceFreshness = source && source.freshness ? source.freshness : null;
    const auth = source && source.auth ? source.auth : null;
    const nowMs = Date.now();

    const runSync = () => {
      if (busy) return;
      setActionError(null);
      setActionNotice(null);
      setBusy('sync');
      healthPost('sync', { days, reason: 'studio-ui' }).then((result) => {
        const state = result && result.status ? String(result.status) : 'unknown';
        const label = SYNC_STATUS_LABEL[state] || state;
        if (state === 'error' || state === 'rate_limited') {
          setActionError({ title: `同步没有成功：${label}`, detail: result && result.errorCode ? String(result.errorCode) : '来源没有给出错误码' });
        } else {
          setActionNotice(`${label}${result && finite(result.itemsSeen) ? `（看到 ${result.itemsSeen} 条）` : ''}`);
        }
        notify(label, state === 'ok' ? 'ok' : 'warn');
        query.reload();
      }).catch((error) => {
        const message = P.failText(error, '同步请求没有完成。');
        setActionError({ title: '同步没有成功', detail: message });
        notify(`同步失败 — ${message}`, 'danger');
      }).then(() => setBusy(null), () => setBusy(null));
    };

    const statusLine = h(P.Fragment, null,
      h(ui.StateLine, {
        state: sourceFreshness
          ? (sourceFreshness.status === 'fresh' ? 'ok'
            : sourceFreshness.status === 'delayed' ? 'warn'
              : sourceFreshness.status === 'stale' ? 'danger' : 'idle')
          : 'idle',
        text: sourceFreshness
          ? `来源${FRESH_LABEL[sourceFreshness.status] || '状态未知'}`
          : '来源状态未知',
      }),
      sourceFreshness && sourceFreshness.newestSampleAt
        ? h(ui.Timestamp, { at: sourceFreshness.newestSampleAt, prefix: '最新样本' })
        : h('span', null, '最新样本 —'),
      h(ui.Badge, { tone: auth ? (AUTH_TONE[auth.status] || 'neutral') : 'neutral' },
        auth ? (AUTH_LABEL[auth.status] || String(auth.status)) : '鉴权未知'),
      h('span', { className: 'cpxp-hl-note' }, '只读页面'));

    const toolbar = h('div', { className: 'cpxp-hl-toolbar' },
      h(ui.Segmented, {
        options: SECTION_OPTIONS,
        value: section,
        onChange: (id) => setSection(id),
        label: '健康与睡眠的分段',
      }),
      h('div', { className: 'cpxp-hl-tools' },
        h('span', { className: 'cpxp-hl-tools-label' }, '时间窗口'),
        h(ui.Segmented, {
          options: DAY_OPTIONS,
          value: String(days),
          onChange: (id) => setDays(Number(id) === 30 ? 30 : 7),
          label: '趋势与睡眠的时间窗口',
        })));

    const allUnavailable = bundle
      && isUnavailable(bundle.status.error)
      && isUnavailable(bundle.today.error)
      && isUnavailable(bundle.sleep.error);

    let body = null;
    if (query.loading && !bundle) {
      body = h(ui.Skeleton, { rows: 6 });
    } else if (query.error) {
      body = h(ui.ErrorBox, { error: query.error, onRetry: query.reload });
    } else if (allUnavailable) {
      // 华为云那条链路整条不在场时，实时心跳仍然可能活着（BLE 不经过云端）：
      // 所以这一张卡单独留着，其余部分照旧说"没接入"。
      body = h('div', { className: 'cpxp-hl-stack' },
        pulseBand(null, query.reload),
        h(ui.Empty, {
          title: '华为运动健康还没接入这套组合',
          hint: '面板没有拿到 /api/companion-health 的服务（health-unavailable）。这里不编造任何读数，等健康服务挂上之后刷新即可。',
        }));
    } else if (!bundle) {
      body = h(ui.Empty, { title: '没有读到健康数据', hint: '接口返回了空结果，点页头的刷新再试一次。' });
    } else {
      const ctx = { bundle, status, sources, today, sleep, steps, days, nowMs, onStatusReload: query.reload };
      let panel = null;
      if (section === 'sleep') panel = sleepSection(ctx);
      else if (section === 'activity') panel = activitySection(ctx);
      else if (section === 'care') panel = careSection(ctx);
      else panel = overviewSection(ctx);

      const failed = ['status', 'sources', 'today', 'sleep', 'steps']
        .filter((key) => bundle[key] && bundle[key].error && !isUnavailable(bundle[key].error));

      body = h('div', { className: 'cpxp-hl-stack' },
        failed.length
          ? h(ui.Callout, {
            tone: 'warn',
            title: '有几项这次没读到',
            action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: query.reload }, '重试'),
          }, h('span', null, failed.map((key) => {
            const label = { status: '来源状态', sources: '来源能力', today: '今天', sleep: '睡眠', steps: '步数趋势' }[key] || key;
            return `${label}：${P.failText(bundle[key].error, '没有返回原因')}`;
          }).join('；')))
          : null,
        actionError
          ? h(ui.Callout, { tone: 'danger', title: actionError.title },
            h('span', null, actionError.detail))
          : null,
        actionNotice
          ? h(ui.Callout, { tone: 'ok', title: '同步结果' }, h('span', null, actionNotice))
          : null,
        toolbar,
        panel);
    }

    const actions = [
      h(ui.Button, {
        key: 'sync',
        variant: 'ghost',
        onClick: runSync,
        loading: busy === 'sync',
        disabled: Boolean(busy),
        title: '让本地采集器立刻向华为 CN 云拉一次（同一时间只跑一次，有冷却）',
      }, '立即同步'),
      h(ui.Button, {
        key: 'refresh',
        variant: 'primary',
        onClick: query.reload,
        loading: query.loading,
        disabled: Boolean(busy),
      }, '刷新'),
    ];

    return h(ui.Page, {
      title: '健康与睡眠',
      lead: '华为运动健康回传的身体数据。',
      status: statusLine,
      actions,
    }, body);
  }

  // 二级 tab 的容器是 core.js 的 NAV 常量（'life' 原本没有 tabs）。这里只把本页挂进
  // 「生活与日程」的 tabs 里，不动 NAV 的其它字段，也不改 core.js。
  (function attachTab() {
    const nav = P.NAV;
    if (!Array.isArray(nav)) return;
    const life = nav.find((item) => item && item.id === 'life');
    if (!life) return;
    if (!Array.isArray(life.tabs)) life.tabs = [life.id || 'life'];
    if (life.tabs.indexOf('life') < 0) life.tabs.unshift('life');
    if (life.tabs.indexOf('health') < 0) life.tabs.push('health');
  })();

  P.registerPage({ id: 'health', label: '健康与睡眠', order: 21, component: HealthPage });
})(P);

// ==== src/client/pages-vault.js ====
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

// ==== src/client/pages-wiki.js ====
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

// ==== src/client/pages-timeline.js ====
// 时间线页片段：按天分组的事件流 + 真实筛选（kind / limit）+ 页内时间收窄。
// 纯脚本 IIFE，无 import/export/require/JSX。端点（以 lib/read.mjs 为准）：
//   GET timeline?limit=&kind=   对话事件摘要（limit 1..200 默认 50；kind 匹配 sourceKind 或 role）
//   GET companion               事实事件流（sections.events：kind / occurred_at / reality_status / evidence_status）
(function (P) {
  'use strict';

  const { h, useState, useMemo, ui, api, fmt } = P;

  P.css(`
.cpxp-tl-controls { display: flex; flex-wrap: wrap; gap: var(--cpx-s4, 16px); align-items: flex-end; min-width: 0; }
.cpxp-tl-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.7; overflow-wrap: anywhere; }
.cpxp-tl-groups { display: flex; flex-direction: column; gap: var(--cpx-s5, 24px); min-width: 0; }
.cpxp-tl-day { display: flex; flex-direction: column; gap: var(--cpx-s2, 8px); min-width: 0; }
.cpxp-tl-day-head { display: flex; align-items: center; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-tl-day-label { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); letter-spacing: .04em; white-space: nowrap; }
.cpxp-tl-rule { flex: 1 1 auto; height: 1px; background: var(--dsw-alias-border-l1); }
.cpxp-tl-side { display: inline-flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); align-items: center; }
.cpxp-tl-clock { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cpxp-tl-foot { display: flex; flex-wrap: wrap; gap: var(--cpx-s3, 12px); align-items: center; }
`);

  const PAGE_STEP = 50;
  // GET timeline 把 limit 夹在 1..200，页面不能承诺更多。
  const MAX_LIMIT = 200;
  const MAX_TECH_ROWS = 80;

  const KIND_OPTIONS = [
    { id: 'all', label: '全部' },
    { id: 'user', label: '用户消息' },
    { id: 'assistant', label: '助手回复' },
    { id: 'imported', label: '导入材料' },
  ];
  const LIMIT_OPTIONS = [
    { id: '50', label: '50 条' },
    { id: '100', label: '100 条' },
    { id: '200', label: '200 条' },
  ];
  const RANGE_OPTIONS = [
    { id: 'all', label: '全部' },
    { id: 'today', label: '今天' },
    { id: '7d', label: '近 7 天' },
    { id: '30d', label: '近 30 天' },
  ];
  const STREAM_OPTIONS = [
    { id: 'messages', label: '对话事件' },
    { id: 'facts', label: '事实事件' },
  ];

  const TYPE_LABEL = {
    desktop_conversation: '桌面对话',
    desktop_fact: '桌面事实',
    astrbot_import: '旧库导入',
    manual: '手工写入',
    system: '系统',
    extracted: '抽取',
  };
  const ROLE_LABEL = { user: '用户', assistant: '助手', imported: '导入', system: '系统', tool: '工具' };
  const ROLE_TONE = { user: 'brand', assistant: 'ok', imported: 'warn', system: 'neutral', tool: 'neutral' };

  // companion-runtime/lib/events.mjs 的 REALITY_STATUS / EVIDENCE_STATUS。
  const REALITY_INFO = {
    actual_tool_activity: { label: '真实活动', tone: 'ok' },
    simulated_world: { label: '模拟世界', tone: 'warn' },
    hypothetical: { label: '假设', tone: 'warn' },
  };
  const EVIDENCE_INFO = {
    observed: { label: '已观察', tone: 'brand' },
    inferred: { label: '推断', tone: 'warn' },
    confirmed: { label: '已确认', tone: 'ok' },
  };
  const KIND_SUBJECT = {
    goal: '目标', commitment: '承诺', belief: '判断', agenda: '日程', memory: '记忆',
    topic: '话题', autonomy: '自主', perception: '感知', contact: '联系', plan: '计划',
    activity: '活动', share: '分享', receipt: '回执', state: '状态', bridge: '桥接',
  };
  const KIND_ACTION = {
    proposed: '提出', accepted: '接受', started: '开始', paused: '暂停', resumed: '恢复',
    completed: '完成', cancelled: '取消', step: '推进', updated: '更新', overdue: '逾期',
    made: '作出', closed: '结束', asserted: '写入', evidence: '补充证据', corrected: '纠正',
    expired: '过期', 'ingest-request': '请求入库', 'correction-request': '请求纠正',
    created: '创建', 'occurrence-generated': '生成触发', 'occurrence-rescheduled': '改期',
    'occurrence-cancelled': '取消触发', 'occurrence-due': '到点', 'occurrence-skipped': '跳过',
    'occurrence-expired': '过期未触发', 'occurrence-dispatched': '已派发',
    'plan-committed': '计划提交', 'plan-slot': '计划时段', opportunity: '机会',
    interest: '兴趣', 'switch': '切换', interjection: '插话', resume: '接续',
  };

  const text = (value) => (value === null || value === undefined ? '' : String(value));
  const countOf = (value) => (Number.isFinite(Number(value)) ? fmt.number(Number(value)) : '—');
  // P.ui.* 的 onChange 有的给值、有的给事件。
  const readValue = (input, fallback) => {
    if (input && typeof input === 'object' && input.target && 'value' in input.target) return input.target.value;
    if (typeof input === 'string' || typeof input === 'number') return input;
    return fallback;
  };

  // 事件时间可能是 ISO 字符串，也可能是 epoch 毫秒（domain_events 存毫秒）。
  function toMillis(value) {
    if (value === null || value === undefined || value === '') return NaN;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 1e11) return numeric;
    const parsed = new Date(String(value)).getTime();
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  function isoOf(value) {
    if (value === null || value === undefined || value === '') return '';
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 1e11) return new Date(numeric).toISOString();
    return String(value);
  }
  // 分天一律按 Asia/Shanghai，和 ui.Timestamp 的时区保持一致。
  function dayKeyOf(value) {
    const ms = typeof value === 'number' ? value : toMillis(value);
    if (!Number.isFinite(ms)) return 'unknown';
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(ms));
    } catch {
      return String(new Date(ms).toISOString()).slice(0, 10);
    }
  }
  function dayLabel(day) {
    if (!day || day === 'unknown') return '时间未知';
    // 只借 UTC 解析取出这一天是星期几，不参与任何时间换算。
    const parsed = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime())) return day;
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][parsed.getUTCDay()];
    return `${day} · ${weekday}`;
  }
  function rangeStart(range) {
    if (range === 'today') {
      const today = dayKeyOf(Date.now());
      const parsed = new Date(`${today}T00:00:00+08:00`);
      return Number.isFinite(parsed.getTime()) ? parsed.getTime() : NaN;
    }
    if (range === '7d') return Date.now() - 7 * 86400000;
    if (range === '30d') return Date.now() - 30 * 86400000;
    return null;
  }
  function kindLabel(kind) {
    const raw = text(kind);
    if (!raw) return '未标注类型';
    const [subject, action] = raw.split('/');
    const subjectLabel = KIND_SUBJECT[subject];
    const actionLabel = KIND_ACTION[action];
    if (subjectLabel && actionLabel) return `${subjectLabel} · ${actionLabel}`;
    if (subjectLabel) return `${subjectLabel} · ${action || '事件'}`;
    return raw;
  }
  function realityOf(value) {
    const found = REALITY_INFO[text(value)];
    if (found) return found;
    return { label: text(value) || '未标注', tone: 'neutral' };
  }
  function evidenceOf(value) {
    const found = EVIDENCE_INFO[text(value)];
    if (found) return found;
    return { label: text(value) || '未标注', tone: 'neutral' };
  }
  function sessionShort(sessionId) {
    const value = text(sessionId);
    if (!value) return '';
    return value.length <= 10 ? value : `${value.slice(0, 10)}…`;
  }
  // Table 的 render 可能收到 (value, row) 或 (row)。
  const cellRow = (value, row) => (row && typeof row === 'object' ? row : value) || {};

  function groupByDay(rows, timeOf) {
    const buckets = new Map();
    for (const row of rows) {
      const day = dayKeyOf(timeOf(row));
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day).push(row);
    }
    return [...buckets.entries()]
      .map(([day, list]) => ({
        day,
        rows: list.sort((left, right) => {
          const a = timeOf(left);
          const b = timeOf(right);
          if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
          if (!Number.isFinite(a)) return 1;
          if (!Number.isFinite(b)) return -1;
          return b - a;
        }),
      }))
      .sort((left, right) => {
        if (left.day === 'unknown') return 1;
        if (right.day === 'unknown') return -1;
        return right.day.localeCompare(left.day);
      });
  }

  function TimelinePage() {
    const [stream, setStream] = useState('messages');
    const [kind, setKind] = useState('all');
    const [limit, setLimit] = useState(50);
    const [range, setRange] = useState('all');

    // 只有真参数：kind 与 limit 直接进 query，其余不猜。
    const messagesApi = P.useApi(
      () => api.get('timeline', kind === 'all' ? { limit } : { limit, kind }),
      [limit, kind],
      { enabled: stream === 'messages' },
    );
    const factsApi = P.useApi(() => api.get('companion'), [], { enabled: stream === 'facts' });

    const messagesData = messagesApi.data && typeof messagesApi.data === 'object' ? messagesApi.data : null;
    const allMessages = messagesData && Array.isArray(messagesData.items) ? messagesData.items.filter(Boolean) : [];
    const factsData = factsApi.data && typeof factsApi.data === 'object' ? factsApi.data : null;
    const factRows = factsData && factsData.sections && Array.isArray(factsData.sections.events)
      ? factsData.sections.events.filter(Boolean)
      : [];
    const factsUnavailable = Boolean(factsData && Array.isArray(factsData.unavailable)
      && factsData.unavailable.includes('events'));

    const cutoff = rangeStart(range);
    const messages = useMemo(() => {
      if (cutoff === null) return allMessages;
      return allMessages.filter((item) => {
        const ms = toMillis(item && item.at);
        return !Number.isFinite(ms) || ms >= cutoff;
      });
    }, [allMessages, cutoff]);
    const facts = useMemo(() => {
      if (cutoff === null) return factRows;
      return factRows.filter((row) => {
        const ms = toMillis(row && row.occurred_at);
        return !Number.isFinite(ms) || ms >= cutoff;
      });
    }, [factRows, cutoff]);

    const loaded = stream === 'messages' ? allMessages : factRows;
    const shown = stream === 'messages' ? messages : facts;
    const timeOf = stream === 'messages'
      ? (item) => toMillis(item && item.at)
      : (row) => toMillis(row && row.occurred_at);
    const groups = useMemo(() => groupByDay(shown, timeOf), [shown, stream]);
    const unknownTime = shown.filter((row) => !Number.isFinite(timeOf(row))).length;

    const activeLoading = stream === 'messages' ? messagesApi.loading : factsApi.loading;
    const activeError = stream === 'messages' ? messagesApi.error : factsApi.error;
    const reloadActive = () => (stream === 'messages' ? messagesApi.reload() : factsApi.reload());

    const fetchedAt = useMemo(() => new Date().toISOString(), [messagesData]);
    const observedAt = text(factsData && factsData.observedAt);
    const maxReached = limit >= MAX_LIMIT;
    // 带 kind 时后端会多取 4 倍再过滤，短页不能当成到底。
    const noMore = maxReached || (kind === 'all' && messagesData ? allMessages.length < limit : false);

    const statusNode = stream === 'messages'
      ? h('span', { className: 'cpxp-tl-note' },
        '读取于 ', h(ui.Timestamp, { at: fetchedAt }),
        ` · 已载入 ${countOf(allMessages.length)} 条`)
      : h('span', { className: 'cpxp-tl-note' },
        observedAt ? ['事件表读取于 ', h(ui.Timestamp, { key: 'at', at: observedAt })] : '事件表读取时间未知',
        ` · 事实事件 ${countOf(factRows.length)} 条`);

    const renderMessageRow = (item, index) => {
      const role = text(item && item.role) || 'unknown';
      const type = text(item && item.type);
      const hidden = Boolean(item && item.hidden);
      const preview = text(item && item.preview);
      const session = text(item && item.sessionId);
      const roleLabel = ROLE_LABEL[role] || role;
      const typeLabel = TYPE_LABEL[type] || type || '类型未知';
      return h(ui.Row, {
        key: `${session || 'session'}-${text(item && item.seq)}-${index}`,
        title: hidden ? '（按表达策略隐藏，不展示内容）' : (preview || '（空消息）'),
        meta: [typeLabel, session ? `会话 ${sessionShort(session)}` : ''].filter(Boolean).join(' · '),
        side: h('span', { className: 'cpxp-tl-side' },
          h(ui.Timestamp, { at: isoOf(item && item.at), className: 'cpxp-tl-clock' }),
          h(ui.Badge, { tone: ROLE_TONE[role] || 'neutral' }, roleLabel)),
        ariaLabel: `${roleLabel}，${typeLabel}`,
      });
    };

    const renderFactRow = (row, index) => {
      const reality = realityOf(row && row.reality_status);
      const evidence = evidenceOf(row && row.evidence_status);
      const label = kindLabel(row && row.kind);
      return h(ui.Row, {
        key: text(row && row.event_id) || `fact-${index}`,
        title: label,
        // 属性放进 meta：那里会换行；side 是 nowrap，长内容会把窄屏撑横。
        meta: h('span', { className: 'cpxp-tl-side' },
          h('span', { className: 'cpxp-tl-note' }, '现实属性'),
          h(ui.Badge, { tone: reality.tone }, reality.label),
          h('span', { className: 'cpxp-tl-note' }, '证据属性'),
          h(ui.Badge, { tone: evidence.tone }, evidence.label)),
        side: h(ui.Timestamp, { at: isoOf(row && row.occurred_at), className: 'cpxp-tl-clock' }),
        ariaLabel: `${label}，现实 ${reality.label}，证据 ${evidence.label}`,
      });
    };

    const eventsBody = (() => {
      if (activeError) {
        return h(ui.ErrorBox, { error: activeError, onRetry: reloadActive });
      }
      if (activeLoading && !shown.length) return h(ui.Skeleton, { rows: 5 });
      if (stream === 'facts' && factsUnavailable) {
        return h(ui.Callout, {
          tone: 'warn',
          title: '事件表读不到',
          children: '后端没有提供事件表数据，不是页面故障。',
        });
      }
      if (!shown.length) {
        if (stream === 'facts') {
          return h(ui.Empty, {
            title: '还没有事实事件',
            hint: '还没有发生过这类动作。',
          });
        }
        return h(ui.Empty, {
          title: allMessages.length ? '这个时间范围里没有事件' : '还没有对话事件',
          hint: allMessages.length
            ? '都不在选中的范围里，点「看全部时间」。'
            : (kind === 'all'
              ? '真实对话被捕获后出现在这里。'
              : '当前类型下没有事件，切回「全部」再看看。'),
          action: range !== 'all'
            ? h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setRange('all') }, '看全部时间')
            : (kind === 'all'
              ? null
              : h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setKind('all') }, '看全部类型')),
        });
      }
      return h('div', { className: 'cpxp-tl-groups' }, groups.map((group) => h('section', {
        key: group.day,
        className: 'cpxp-tl-day',
        'aria-label': `${dayLabel(group.day)}，${group.rows.length} 条`,
      },
      h('div', { className: 'cpxp-tl-day-head' },
        h('span', { className: 'cpxp-tl-day-label' }, dayLabel(group.day)),
        h('span', { className: 'cpxp-tl-rule' }),
        h('span', { className: 'cpxp-tl-day-label' }, `${countOf(group.rows.length)} 条`)),
      h(ui.List, { label: dayLabel(group.day) },
        group.rows.map(stream === 'messages' ? renderMessageRow : renderFactRow)))));
    })();

    const techColumns = stream === 'messages'
      ? [
        { key: 'at', label: '时间（ISO）', width: 200, render: (value, row) => text(cellRow(value, row).at) || '—' },
        { key: 'role', label: '角色', width: 80, render: (value, row) => text(cellRow(value, row).role) || '—' },
        { key: 'type', label: '类型', width: 150, render: (value, row) => text(cellRow(value, row).type) || '—' },
        { key: 'session', label: '会话', width: 220, render: (value, row) => text(cellRow(value, row).sessionId) || '—' },
        { key: 'seq', label: '序号', width: 70, align: 'right', render: (value, row) => text(cellRow(value, row).seq) || '—' },
      ]
      : [
        { key: 'occurred', label: '发生时间（原始）', width: 190, render: (value, row) => text(cellRow(value, row).occurred_at) || '—' },
        { key: 'kind', label: 'kind', width: 190, render: (value, row) => text(cellRow(value, row).kind) || '—' },
        { key: 'reality', label: 'reality_status', width: 170, render: (value, row) => text(cellRow(value, row).reality_status) || '—' },
        { key: 'evidence', label: 'evidence_status', width: 150, render: (value, row) => text(cellRow(value, row).evidence_status) || '—' },
        { key: 'id', label: 'event_id', width: 200, render: (value, row) => text(cellRow(value, row).event_id) || '—' },
      ];

    return h(ui.Page, {
      title: '时间线',
      lead: '按天回看发生过的事。',
      status: statusNode,
      actions: h(ui.Button, {
        variant: 'primary',
        onClick: reloadActive,
        loading: Boolean(activeLoading),
        disabled: Boolean(activeLoading),
      }, '刷新'),
    },
    h(ui.Band, {
      flush: true,
      title: '筛选',
      info: [
        stream === 'messages'
          ? `时间范围只收窄已载入的 ${countOf(allMessages.length)} 条，不会去后端补更早的记录；类型与载入窗口是真参数。`
          : `时间范围只收窄已载入的 ${countOf(factRows.length)} 条（事件表固定给最近 100 条）。`,
        unknownTime ? `其中 ${countOf(unknownTime)} 条时间未知，按范围无法判断，仍留在列表里。` : '',
      ].filter(Boolean).join(' '),
    },
      h('div', { className: 'cpxp-tl-controls' },
        h(ui.Segmented, {
          label: '看哪条流',
          options: STREAM_OPTIONS,
          value: stream,
          onChange: (next) => setStream(text(readValue(next, stream)) || 'messages'),
        }),
        stream === 'messages'
          ? h(ui.Segmented, {
            label: '类型',
            options: KIND_OPTIONS,
            value: kind,
            onChange: (next) => { setKind(text(readValue(next, kind)) || 'all'); },
          })
          : null,
        stream === 'messages'
          ? h(ui.Segmented, {
            label: '载入窗口',
            options: LIMIT_OPTIONS,
            value: String(limit),
            onChange: (next) => setLimit(Number(readValue(next, limit)) || 50),
          })
          : null,
        h(ui.Segmented, {
          label: '时间范围',
          options: RANGE_OPTIONS,
          value: range,
          onChange: (next) => setRange(text(readValue(next, range)) || 'all'),
        }))),
    h(ui.Band, {
      title: '事件流',
      info: '只展示摘要（每条 ≤160 字符）与会话定位；完整正文不出接口。',
      actions: h(ui.Badge, { tone: 'neutral' }, `显示 ${countOf(shown.length)} / ${countOf(loaded.length)} 条`),
    },
      eventsBody,
      stream === 'messages'
        ? h('div', { className: 'cpxp-tl-foot' },
          h(ui.Button, {
            variant: 'ghost',
            size: 'sm',
            disabled: Boolean(activeLoading) || noMore,
            onClick: () => setLimit(Math.min(MAX_LIMIT, limit + PAGE_STEP)),
          }, noMore ? '已经到底了' : `加载更早的 ${PAGE_STEP} 条`),
          h('span', { className: 'cpxp-tl-note' },
            `当前窗口 ${countOf(limit)} 条${maxReached ? '（接口上限 200 条）' : ''}`))
        : null),
    h(ui.Band, { title: '技术明细', hint: '原始字段。' },
      h(ui.Diagnostic, { title: '当前已载入事件的原始字段', hint: `最多列前 ${MAX_TECH_ROWS} 条` },
        h(ui.Table, {
          columns: techColumns,
          rows: shown.slice(0, MAX_TECH_ROWS),
          emptyText: '这一条流里还没有可列出的事件。',
        }),
        shown.length > MAX_TECH_ROWS
          ? h('p', { className: 'cpxp-tl-note' }, `还有 ${countOf(shown.length - MAX_TECH_ROWS)} 条没列出。`)
          : null)));
  }

  P.registerPage({ id: 'timeline', label: '时间线', order: 50, component: TimelinePage });
})(P);

// ==== src/client/pages-review.js ====
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

// ==== src/client/pages-microscope.js ====
// 召回显微镜片段：一次真实检索的诊断视图（设置 › 高级诊断）。
// 纯脚本 IIFE，无 import/export/require/JSX。端点只有一个（以 lib/read.mjs 为准）：
//   GET preview?q=&limit=   → {query, characters, budgetChars, truncated, entries[], explain{}, rendered}
// 默认只显示人能读懂的一层；评分、阈值、explain 原始 JSON 全部收进 ui.Diagnostic。
(function (P) {
  'use strict';

  const { h, useState, ui, api, fmt } = P;

  P.css(`
.cpxp-ms-query { display: flex; flex-direction: column; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-ms-controls { display: flex; flex-wrap: wrap; gap: var(--cpx-s4, 16px); align-items: flex-end; min-width: 0; }
.cpxp-ms-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.7; overflow-wrap: anywhere; }
.cpxp-ms-head { display: flex; flex-direction: column; gap: var(--cpx-s2, 8px); min-width: 0; }
.cpxp-ms-title { margin: 0; font-size: var(--cpx-fs-section, 17px); font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.cpxp-ms-line { display: flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); align-items: center; min-width: 0; }
.cpxp-ms-reasons { display: flex; flex-direction: column; gap: var(--cpx-s3, 12px); min-width: 0; }
.cpxp-ms-reason { display: flex; flex-direction: column; gap: var(--cpx-s1, 4px); min-width: 0; overflow-wrap: anywhere; }
.cpxp-ms-reason-head { display: flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); align-items: center; }
.cpxp-ms-side { display: inline-flex; flex-wrap: wrap; gap: var(--cpx-s2, 8px); align-items: center; }
@media (max-width: 900px) { .cpxp-ms-controls { gap: var(--cpx-s3, 12px); } }
`);

  const LIMIT_OPTIONS = [
    { id: '8', label: '8 条' },
    { id: '12', label: '12 条' },
    { id: '20', label: '20 条' },
  ];

  // 过滤原因词典：覆盖 lib/retrieve.mjs 的 filteredReasons 与设计文档里的示意码；
  // 未收录的码原样展示并标注「未识别」。说明只留一句，细节交给技术明细。
  const REASON_INFO = {
    coverage_below_floor: ['覆盖度不足', 'warn', '查询词命中太少'],
    'low-coverage': ['覆盖度不足', 'warn', '查询词命中太少'],
    scope_denied: ['作用域不可见', 'warn', '属于别的用户或角色'],
    'scope-mismatch': ['作用域不可见', 'warn', '属于别的用户或角色'],
    pending: ['待审核', 'brand', '候选还没确认'],
    'status-pending': ['待审核', 'brand', '候选还没确认'],
    superseded: ['已被取代', 'neutral', '有更新的纠正版本'],
    'status-superseded': ['已被取代', 'neutral', '有更新的纠正版本'],
    archived: ['已归档', 'neutral', '已归档不参与召回'],
    'status-archived': ['已归档', 'neutral', '已归档不参与召回'],
    retracted: ['已撤回', 'neutral', '用户要求遗忘'],
    'status-retracted': ['已撤回', 'neutral', '用户要求遗忘'],
    expired: ['已过期', 'warn', '超出有效期'],
    'not-yet-valid': ['尚未生效', 'warn', '生效时间还没到'],
    inactive: ['已失效', 'warn', '状态或时效不满足'],
    mention_policy: ['表达策略受限', 'danger', '只留占位，不注入正文'],
    mmr_dedup: ['近重复去重', 'neutral', '与已选条目近重复'],
    budget_exceeded: ['超出注入预算', 'warn', '超出注入预算被丢弃'],
    'semantic-degraded': ['向量降级', 'danger', '向量降级，本轮无语义通道'],
    'semantic-off': ['语义通道关闭', 'neutral', '向量提供器关闭'],
    'semantic-no-overlap': ['无共享词元', 'neutral', '向量无共享词元'],
    'semantic-below-floor': ['余弦低于阈值', 'neutral', '相似度低于阈值'],
    'semantic-empty': ['查询向量为空', 'neutral', '查询向量为空'],
    'missing-vector': ['缺少向量', 'neutral', '还没写入向量索引'],
    'missing-record': ['记录缺失', 'neutral', '记忆行已不存在'],
    'empty-candidate-pool': ['候选为空', 'neutral', '没有可打分的候选'],
    'lexical-error': ['字面通道异常', 'danger', '全文检索失败'],
    'vector-error': ['向量读取异常', 'danger', '向量读取失败'],
    'recent-error': ['候选池读取异常', 'danger', '候选池读取失败'],
    'semantic-error': ['语义通道异常', 'danger', '向量通道报错'],
    'recall-error': ['召回异常', 'danger', '召回整体失败'],
    'no-database': ['记忆库不可用', 'danger', '记忆库未就绪'],
    'no-viewer': ['身份不可用', 'danger', '身份不可用'],
  };

  const SCOPE_LABEL = {
    user_global: '现实',
    user_persona: '关系',
    persona_self: '角色自我',
    roleplay_world: '剧情世界',
    session_recent: '近期状态',
  };
  const POLICY_LABEL = {
    direct: '直接使用',
    soft_echo: '轻回响',
    tone_only: '仅语气',
    avoid_unless_asked: '需明确询问',
  };
  const KIND_LABEL = {
    fact: '事实', preference: '偏好', profile: '画像', event: '事件', commitment: '约定',
    relationship: '关系', summary: '摘要', bot_action: '角色行为', artifact: '产出物', note: '备注',
  };
  const REASON_LABEL = { lexical: '字面命中', semantic: '语义命中', recent: '最近记忆', hybrid: '双通道命中' };

  const text = (value) => (value === null || value === undefined ? '' : String(value));
  const labelOf = (map, key) => map[text(key)] || text(key) || '—';
  const countOf = (value) => (Number.isFinite(Number(value)) ? fmt.number(Number(value)) : '—');
  const percentOf = (value) => (Number.isFinite(Number(value)) ? fmt.percent(Number(value)) : '—');
  const fixed = (value, digits) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—');
  const readValue = (input, fallback) => {
    if (input && typeof input === 'object' && input.target && 'value' in input.target) return input.target.value;
    if (typeof input === 'string' || typeof input === 'number') return input;
    return fallback;
  };
  const reasonInfo = (code) => {
    const found = REASON_INFO[text(code)];
    if (found) return { label: found[0], tone: found[1], hint: found[2], known: true };
    return { label: text(code) || '未知原因', tone: 'neutral', hint: '未识别的原因码', known: false };
  };
  // Table 的 render 可能收到 (value, row) 或 (row)。
  const cellRow = (value, row) => (row && typeof row === 'object' ? row : value) || {};

  function MicroscopePage() {
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState('8');
    const [submitted, setSubmitted] = useState(null);
    // 只有提交过查询才请求后端：页面挂载时不发任何请求。
    const previewApi = P.useApi(
      () => (submitted ? api.get('preview', { q: submitted.q, limit: submitted.limit }) : null),
      [submitted],
      { enabled: Boolean(submitted) },
    );

    const data = previewApi.data && typeof previewApi.data === 'object' ? previewApi.data : null;
    const loading = Boolean(submitted) && Boolean(previewApi.loading);
    const error = previewApi.error || null;

    const entries = data && Array.isArray(data.entries) ? data.entries.filter(Boolean) : [];
    const explain = data && data.explain && typeof data.explain === 'object' ? data.explain : null;
    const rendered = data ? text(data.rendered) : '';
    const characters = data && Number.isFinite(Number(data.characters)) ? Number(data.characters) : rendered.length;
    const budgetChars = data && Number.isFinite(Number(data.budgetChars)) ? Number(data.budgetChars) : null;
    const truncated = Boolean(data && data.truncated);
    const coverage = explain && explain.coverage && typeof explain.coverage === 'object' ? explain.coverage : null;
    const channels = explain && explain.channels && typeof explain.channels === 'object' ? explain.channels : null;
    const reasonCounts = explain && explain.filteredReasons && typeof explain.filteredReasons === 'object'
      ? Object.keys(explain.filteredReasons)
        .filter((code) => Number(explain.filteredReasons[code]) > 0)
        .map((code) => [code, Number(explain.filteredReasons[code])])
        .sort((left, right) => right[1] - left[1])
      : [];

    const run = (typed) => {
      const value = text(typeof typed === 'string' ? typed : query).trim();
      if (!value) return;
      const size = Number(limit);
      setSubmitted({ q: value, limit: Number.isFinite(size) && size > 0 ? size : 8, nonce: Date.now() });
    };

    const resultBody = (() => {
      if (error) return h(ui.ErrorBox, { error, onRetry: () => previewApi.reload() });
      if (loading) return h(ui.Skeleton, { rows: 4 });
      if (!data) {
        return h(ui.Empty, {
          title: '还没有运行诊断',
          hint: '输入一句你会问的话，回车运行。',
        });
      }
      const hit = entries.length;
      const summary = h('div', { className: 'cpxp-ms-head' },
        h('h3', { className: 'cpxp-ms-title' }, `用「${text(data.query) || '（空）'}」检索，命中 ${countOf(hit)} 条记忆`),
        h('div', { className: 'cpxp-ms-line' },
          h(ui.Badge, { tone: hit ? 'ok' : 'warn' }, hit ? `命中 ${countOf(hit)} 条` : '没有命中'),
          h(ui.Badge, { tone: truncated ? 'warn' : 'neutral' }, truncated ? '注入按预算截断' : '注入未截断'),
          budgetChars === null
            ? h(ui.Badge, { tone: 'neutral' }, `注入 ${countOf(characters)} 字符`)
            : null,
          h('span', { className: 'cpxp-ms-note' }, `耗时 ${explain && Number.isFinite(Number(explain.elapsedMs)) ? `${countOf(explain.elapsedMs)} ms` : '—'}`)),
        budgetChars === null
          ? null
          : h(ui.Meter, {
            value: characters,
            max: budgetChars,
            label: `注入字符数 ${countOf(characters)} / 上限 ${countOf(budgetChars)}`,
            tone: characters > budgetChars ? 'warn' : 'ok',
          }));
      const list = hit
        ? h(ui.List, { label: '命中的记忆' }, entries.map((entry, index) => {
          const policy = text(entry.policy);
          const risky = policy === 'avoid_unless_asked';
          return h(ui.Row, {
            key: text(entry.id) || `entry-${index}`,
            title: text(entry.preview) || '（按表达策略不展示正文）',
            meta: `${labelOf(KIND_LABEL, entry.kind)} · ${labelOf(SCOPE_LABEL, entry.scope)}`,
            side: h(ui.Badge, { tone: risky ? 'danger' : 'neutral' }, labelOf(POLICY_LABEL, policy)),
            ariaLabel: `命中第 ${index + 1} 条，${labelOf(KIND_LABEL, entry.kind)}，${labelOf(POLICY_LABEL, policy)}`,
          });
        }))
        : h(ui.Empty, {
          title: '这次没有命中的条目',
          hint: reasonCounts.length
            ? `主因：${reasonInfo(reasonCounts[0][0]).label}。`
            : '问题和已有记忆没有交集。',
        });
      return h('div', { className: 'cpxp-ms-query' }, summary, list);
    })();

    const reasonBand = data && !error && !loading
      ? h(ui.Band, {
        title: '为什么没命中',
        info: '按后端返回的过滤原因翻译成人话；原始原因码与数字在下方技术明细。',
        actions: h(ui.Badge, { tone: reasonCounts.length ? 'warn' : 'ok' },
          reasonCounts.length ? `${countOf(reasonCounts.length)} 类原因` : '没有过滤原因'),
      },
        reasonCounts.length
          ? h('div', { className: 'cpxp-ms-reasons' }, reasonCounts.map(([code, count]) => {
            const info = reasonInfo(code);
            return h('div', { key: code, className: 'cpxp-ms-reason' },
              h('div', { className: 'cpxp-ms-reason-head' },
                h(ui.Badge, { tone: info.tone }, info.label),
                h('span', { className: 'cpxp-ms-note' }, `× ${countOf(count)} 条`),
                info.known ? null : h(ui.Badge, { tone: 'neutral' }, '未识别')),
              h('p', { className: 'cpxp-ms-note' }, info.hint));
          }))
          : h('p', { className: 'cpxp-ms-note' }, '没有过滤原因。'))
      : null;

    const techItems = data && !error && !loading
      ? [
        { k: '后端通道', v: text(explain && explain.backend) || '—', mono: true },
        { k: '候选数', v: countOf(explain && explain.candidates) },
        { k: '过滤后', v: countOf(explain && explain.afterFilter) },
        { k: '去重后', v: countOf(explain && explain.afterDedupe) },
        { k: '字面通道', v: channels ? countOf(channels.lexical) : '—' },
        { k: '语义通道', v: channels ? countOf(channels.semantic) : '—' },
        { k: '耗时', v: explain && Number.isFinite(Number(explain.elapsedMs)) ? `${countOf(explain.elapsedMs)} ms` : '—' },
        { k: '覆盖度门槛', v: fixed(coverage && coverage.floor, 3), mono: true },
        { k: '最佳覆盖度', v: percentOf(coverage && coverage.best), mono: true },
        {
          k: '覆盖度通过',
          v: coverage
            ? `${countOf(coverage.kept)} / ${countOf(coverage.total)}（词元 ${countOf(coverage.terms)}）`
            : '—',
        },
      ]
      : [];

    const scoreColumns = [
      {
        key: 'preview',
        label: '条目',
        render: (value, row) => {
          const item = cellRow(value, row);
          return text(item.preview) || text(item.id) || '—';
        },
      },
      { key: 'kind', label: '类型', width: 90, render: (value, row) => labelOf(KIND_LABEL, cellRow(value, row).kind) },
      { key: 'scope', label: '作用域', width: 100, render: (value, row) => labelOf(SCOPE_LABEL, cellRow(value, row).scope) },
      { key: 'policy', label: '策略', width: 110, render: (value, row) => text(cellRow(value, row).policy) || '—' },
      { key: 'score', label: '分数', width: 84, align: 'right', render: (value, row) => fixed(cellRow(value, row).score, 4) },
      { key: 'reason', label: '命中通道', width: 110, render: (value, row) => labelOf(REASON_LABEL, cellRow(value, row).reason) },
      { key: 'id', label: '记忆编号', width: 170, render: (value, row) => text(cellRow(value, row).id) || '—' },
    ];

    return h(ui.Page, {
      title: '召回显微镜',
      lead: '命中几条、为什么没命中。',
      status: h('span', { className: 'cpxp-ms-note' },
        `只读诊断 · 条数上限 ${countOf(limit)} 条`,
        submitted ? [' · 最近运行 ', h(ui.Timestamp, { key: 'at', at: new Date(submitted.nonce).toISOString() })] : ' · 还没有运行'),
      actions: h(ui.Button, {
        variant: 'primary',
        onClick: () => run(),
        loading,
        disabled: loading || !text(query).trim(),
      }, submitted ? '再运行一次' : '运行诊断'),
    },
    h(ui.Band, {
      flush: true,
      title: '查询',
      info: '诊断视图：只读，不写库，不触发模型，也不影响真实回复。q 与 limit 是真参数（limit 1..20，默认 8）。',
    },
      h('div', { className: 'cpxp-ms-query' },
        h(ui.Search, {
          value: query,
          label: '要检索的问题',
          placeholder: '例如：我们之前约定过什么？',
          onChange: (input) => setQuery(text(readValue(input, ''))),
          onEnter: (input) => run(typeof input === 'string' ? input : query),
        }),
        h('div', { className: 'cpxp-ms-controls' },
          h(ui.Segmented, {
            label: '最多看几条',
            options: LIMIT_OPTIONS,
            value: limit,
            onChange: (next) => setLimit(text(readValue(next, limit)) || '8'),
          })),
        text(query).trim() ? null : h('p', { className: 'cpxp-ms-note' }, '先输入一个问题。'))),
    h(ui.Band, { title: '这一次检索' }, resultBody),
    reasonBand,
    h(ui.Band, { title: '技术明细', hint: '评分、阈值与原始 JSON。' },
      h(ui.Diagnostic, { title: '检索诊断（explain）', hint: '通道计数、覆盖度、耗时、每条评分' },
        data && !error && !loading
          ? [
            h(ui.KeyValue, { key: 'kv', items: techItems }),
            h(ui.Table, {
              key: 'score',
              columns: scoreColumns,
              rows: entries,
              emptyText: '这一轮没有进入候选的条目。',
            }),
            h('p', { key: 'note', className: 'cpxp-ms-note' }, '原始 explain JSON'),
            h(ui.Pre, { key: 'json', maxHeight: '260px' }, explain ? JSON.stringify(explain, null, 2) : '（后端未返回 explain）'),
          ]
          : h('p', { className: 'cpxp-ms-note' }, '先运行一次诊断，这里才会出现数字。')),
      h(ui.Diagnostic, { title: '模型实际看到的注入文本', hint: '逐行 JSON；空字符串＝未注入' },
        rendered
          ? h(ui.Pre, { maxHeight: '340px' }, rendered)
          : h('p', { className: 'cpxp-ms-note' }, '本轮注入为空。'))));
  }

  P.registerPage({ id: 'microscope', label: '召回显微镜', order: 30, component: MicroscopePage });
})(P);

// ==== src/client/pages-connections.js ====
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

      h(ui.Band, {
        key: 'qq',
        title: 'QQ 私聊通道',
        hint: '本地投递账本，不代表已读',
        actions: [info('计数来自本地投递账本：只说明消息离开队列，不代表对方已读，也不代表送达。'
          + '本页只读，不发送任何消息，也不会替你回消息。')],
      }, [
        contact
          ? h(ui.List, { key: 'qq-list', label: 'QQ 私聊投递账本' },
            h(ui.Row, {
              title: '投递账本',
              meta: '本地账本已写入',
              status: h(ui.StateLine, { state: 'ok', text: '已写入' }),
            }),
            h(ui.Row, {
              title: '统计日',
              meta: '不是今天时计数是旧的',
              side: contact.day ? String(contact.day) : '—',
            }),
            h(ui.Row, {
              title: '今日发送',
              meta: '本地账本记录的条数',
              side: contact.sentToday === null || contact.sentToday === undefined ? '—' : `${fmt.number(contact.sentToday)} 条`,
            }),
            h(ui.Row, {
              title: '连续未回复',
              meta: '她连续发出、你还没回',
              side: contact.unanswered === null || contact.unanswered === undefined ? '—' : `${fmt.number(contact.unanswered)} 条`,
            }),
            h(ui.Row, {
              title: '上次发送',
              meta: '最近一次离开队列',
              side: contact.lastSentAt ? h(ui.Timestamp, { at: contact.lastSentAt }) : '—',
            }))
          : h('div', { key: 'qq-empty' },
            h(ui.Row, {
              title: '投递账本',
              meta: '本地还没有账本文件',
              status: h(ui.StateLine, { state: 'idle', text: '未写入' }),
            }),
            h(ui.Callout, {
              tone: 'info',
              title: '还没有投递账本',
              children: '本地没有账本文件，发送情况无法判断。',
            })),
      ]),

      // 媒体能力：真实可编辑设置页（descriptor 渲染，保存走媒体插件自己的 API）。
      // 只读的「运行库视角」开关仍保留在新页面的诊断区里（GET companion · media）。
      P.mediaPage
        ? h(P.mediaPage.MediaBand, { key: 'media', media })
        : h(ui.Band, {
          key: 'media',
          title: '媒体能力',
        }, h(ui.Callout, { tone: 'warn', title: '媒体设置页没有构建' },
          h('span', null, '这个客户端的 pages-media.js 片段缺失，只能显示运行库读到的开关值。'))),

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

// ==== src/client/pages-media.js ====
// 连接与工具 → 工具 → 媒体能力：**真实可编辑**的设置页。
//
// 单一权威：页面只按 `companion-media` 给的 descriptor 渲染（字段、label、类型、
// 当前值、状态文案、端点、canTest/canEnable 全部来自它），保存只走
// `POST /api/companion-media/config`。Studio 不写媒体 JSON，也不复制第二份服务商
// 逻辑（不硬编码 provider id、端点路径、必填项或校验规则）。
//
// 三条硬规则（都在代码里落实，不是文档承诺）：
//   1. 密钥只写：`type:'secret'` 的值恒为 `{configured, mask}`；输入框恒空；
//      留空保存 = 保留原密钥；清除是一次显式动作，且**先关能力再清密钥**（同一个
//      patch 里一起发，避免撞后端 400）。
//   2. 测试/预览只由按钮触发：加载页面只读 page 与 config；绝不自动调用 /test、
//      /preview、/image、/speech（descriptor 的 meta.testPolicy 是 explicit-only）。
//   3. 读不到就如实说：媒体模块没启用时给出可走通的启用路径，不假装页面坏了；
//      provider 侧失败（body.ok=false）绝不渲染成"测试通过"。
(function (P) {
  const { h, ui } = P;

  const MEDIA_BASE = 'api/companion-media/';

  // descriptor 声明的六种状态（未知值一律「未知」，不猜）。
  const STATE_LABELS = {
    disabled: '功能关闭',
    unconfigured: '未配置',
    'not-connected': '尚未接入',
    'saved-untested': '已保存、未测试',
    'test-ok': '测试通过',
    'test-failed': '测试失败',
  };
  const STATE_TONES = {
    disabled: 'idle',
    unconfigured: 'warn',
    'not-connected': 'neutral',
    'saved-untested': 'idle',
    'test-ok': 'ok',
    'test-failed': 'danger',
  };

  // 只用于识别"这个字段是密钥 + 不要泄漏进 DOM"；字段类型仍以 descriptor 为准。
  const SECRET_FIELD_NAMES = ['apiKey', 'accessToken', 'token'];
  const PRESET_LABELS = { applyDefaults: '启用这一族预设', positive: '正向提示词', negative: '反向提示词' };

  const ENABLE_SNIPPET = [
    '{',
    '  "modules": {',
    '    "media": true',
    '  }',
    '}',
  ].join('\n');

  P.css(`
    .cpxp-media-sec { border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.18)); border-radius:10px; padding:var(--cpx-s3,12px); margin:0 0 var(--cpx-s4,16px); }
    .cpxp-media-sec-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--cpx-s3,12px); flex-wrap:wrap; }
    .cpxp-media-sec-title { margin:0; font-size:var(--cpx-fs-body,14px); font-weight:600; }
    .cpxp-media-note { margin:4px 0 0; font-size:var(--cpx-fs-small,12px); line-height:1.7; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; max-width:78ch; }
    .cpxp-media-note-inline { margin:0 0 var(--cpx-s3,12px); font-size:var(--cpx-fs-small,12px); color:var(--dsw-alias-label-secondary); }
    .cpxp-media-card { border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.18)); border-radius:10px; padding:var(--cpx-s3,12px); background:var(--dsw-alias-bg-elevated,transparent); }
    .cpxp-media-card + .cpxp-media-card { margin-top:var(--cpx-s3,12px); }
    .cpxp-media-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
    .cpxp-media-card-title { margin:0; font-size:var(--cpx-fs-body,14px); font-weight:600; }
    .cpxp-media-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:var(--cpx-s3,12px); margin-top:var(--cpx-s3,12px); }
    .cpxp-media-field-wide { grid-column:1 / -1; }
    .cpxp-media-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:var(--cpx-s3,12px); }
    .cpxp-media-secret { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .cpxp-media-error { margin:4px 0 0; font-size:var(--cpx-fs-small,12px); color:var(--dsw-alias-label-danger,#c0392b); overflow-wrap:anywhere; }
    .cpxp-media-presets { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:var(--cpx-s3,12px); }
    .cpxp-media-badge-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  `);

  // -------------------------------------------------------------------------
  // 纯函数：视图模型与请求体构造（单测只测这些，不靠"字符串包含"）
  // -------------------------------------------------------------------------

  function configAt(config, dotted) {
    if (!config) return undefined;
    return configAtParts(config, Array.isArray(dotted) ? dotted : String(dotted || '').split('.'));
  }

  function configAtParts(config, parts) {
    let node = config;
    for (const key of parts || []) {
      if (node === null || node === undefined) return undefined;
      node = node[key];
    }
    return node;
  }

  /** 用 pathParts 写入：NAI 预设族叫 `4.5`，按点号切分会把路径拆坏。 */
  function setParts(target, parts, value) {
    let node = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!node[key] || typeof node[key] !== 'object') node[key] = {};
      node = node[key];
    }
    node[parts[parts.length - 1]] = value;
    return target;
  }

  function partsOf(path, pathParts) {
    if (Array.isArray(pathParts) && pathParts.length) return pathParts.slice();
    return String(path || '').split('.');
  }

  function secretInfo(value) {
    if (value && typeof value === 'object') {
      return { configured: value.configured === true, mask: String(value.mask || ''), source: value.source || '' };
    }
    return { configured: String(value || '').trim() !== '', mask: '', source: '' };
  }

  function stateLabel(states, id) {
    const found = (states || []).find(item => item && item.id === id);
    if (found && found.label) return String(found.label);
    return STATE_LABELS[id] || '未知';
  }

  function stateTone(id) {
    return STATE_TONES[id] || 'neutral';
  }

  /** `'GET /api/companion-media/config'` → `'api/companion-media/config'`（端点以 descriptor 为准）。 */
  function apiPath(spec, fallback) {
    const text = String(spec || '');
    const match = text.match(/\s(\S+)$/);
    if (match && match[1].startsWith('/')) return match[1].replace(/^\//, '');
    return `${MEDIA_BASE}${fallback || ''}`;
  }

  function lastSegment(dotted) {
    return String(dotted || '').split('.').pop();
  }

  function parentPath(dotted) {
    const parts = String(dotted || '').split('.');
    parts.pop();
    return parts.join('.');
  }

  function fieldView(field, config, { locked = false } = {}) {
    const secret = field.type === 'secret' || SECRET_FIELD_NAMES.includes(lastSegment(field.path));
    // descriptor 现在带 value（密钥只给 {configured, mask}）；没有时回落到同一份 config。
    const fromDescriptor = field.value !== undefined && field.value !== null;
    const current = fromDescriptor ? field.value : configAt(config, field.path);
    const info = secret ? secretInfo(current) : null;
    const plain = current === undefined || current === null || typeof current === 'object';
    return {
      path: field.path,
      pathParts: Array.isArray(field.pathParts) ? field.pathParts.slice() : String(field.path || '').split('.'),
      label: field.label || lastSegment(field.path),
      type: field.type || 'text',
      hint: field.hint || '',
      locked: locked || field.writable === false,
      secret,
      configured: info ? info.configured : false,
      mask: info ? info.mask : '',
      // 视图里永不携带明文：secret 的值恒为 ''，靠 configured 表达"已配置"。
      value: secret || plain ? '' : current,
      original: secret || plain ? '' : current,
      options: Array.isArray(field.options) ? field.options.map(item => ({ value: String(item.value), label: String(item.label) })) : null,
    };
  }

  function providerView(provider, config, { locked = false, kind = 'image' } = {}) {
    const notConnected = provider.status === 'not-connected' || provider.state === 'not-connected';
    const rawFields = provider.fields || [];
    // 生图的"启用"是 section 的开关 + 协议选择，不存在 `image.<provider>.enabled` 这个键：
    // 渲染一个会写坏配置的开关比不渲染更糟，所以生图 provider 不显示 enabled 字段。
    const usable = kind === 'image' ? rawFields.filter(item => lastSegment(item.path) !== 'enabled') : rawFields;
    // 密钥可能来自环境变量：改页面不会生效，必须禁用输入并说明来源。
    const keyInfo = provider.key && typeof provider.key === 'object' ? provider.key : null;
    const keyFromEnv = Boolean(keyInfo && keyInfo.source === 'env');
    const fields = usable.map((item) => {
      const view = fieldView(item, config, { locked: locked || notConnected });
      if (view.secret && keyFromEnv) {
        return { ...view, locked: true, fromEnv: true, envVar: keyInfo.envVar || '', configured: keyInfo.configured === true };
      }
      return view;
    });
    // provider 的配置前缀：由 descriptor 的 pathParts 推出来，不写死 id。
    const firstParts = usable[0] && Array.isArray(usable[0].pathParts) ? usable[0].pathParts : null;
    const prefix = firstParts && firstParts.length > 1
      ? firstParts.slice(0, -1).join('.')
      : (kind === 'tts' ? `tts.providers.${provider.id}` : `image.${provider.id}`);
    const enableField = fields.find(field => lastSegment(field.path) === 'enabled') || null;
    const syntheticEnablePath = enableField || kind === 'image' ? null : `${prefix}.enabled`;
    return {
      id: provider.id,
      kind,
      label: provider.label || provider.id,
      prefix,
      status: provider.status || '',
      state: provider.state || 'unconfigured',
      stateNote: provider.stateNote || provider.stateDetail || provider.reason || '',
      notConnected,
      keyInfo,
      keyFromEnv,
      // descriptor 明确给了"能不能测/能不能启用"，页面不再自己猜（也不硬编码 id）。
      canTest: provider.canTest !== undefined ? provider.canTest === true : !notConnected,
      canEnable: provider.canEnable !== undefined ? provider.canEnable === true : !notConnected,
      enableField,
      enablePath: enableField ? enableField.path : syntheticEnablePath,
      // 清密钥前必须先关能力：tts 关 provider 自己的开关，生图关 section 的「启用生图」。
      disablePath: (enableField ? enableField.path : syntheticEnablePath) || (kind === 'image' ? 'image.enabled' : null),
      enabled: enableField ? enableField.original === true
        : (syntheticEnablePath ? configAt(config, syntheticEnablePath) === true : configAt(config, 'image.enabled') === true && configAt(config, 'image.provider') === provider.id),
      missing: Array.isArray(provider.missing) ? provider.missing : [],
      evidence: provider.evidence || null,
      endpoint: provider.endpoint || '',
      auth: provider.auth || '',
      responseFormat: provider.responseFormat || '',
      voiceListing: provider.voiceListing || '',
      rateLimit: provider.rateLimit || '',
      license: provider.license || '',
      version: provider.version || '',
      fields,
    };
  }

  function presetView(section, config) {
    const spec = section && section.presets;
    if (!spec) return null;
    // 新形状：descriptor 直接给两族字段 + 独立的画师串字段；渲染以它为准。
    if (Array.isArray(spec.families) && spec.families.length) {
      const families = spec.families.filter(family => family && family.field).map(family => ({
        family: String(family.family ?? ''),
        label: family.label || String(family.family ?? '预设'),
        path: family.field.path,
        fields: [fieldView(family.field, config)],
      }));
      return {
        path: spec.path || '',
        note: spec.note || '',
        families,
        artist: spec.artistString ? fieldView(spec.artistString, config) : null,
      };
    }
    // 旧形状兜底：按配置里的真实结构逐族展开（不把"预设"写死成两份代码）。
    const bag = configAt(config, spec.path);
    if (!bag || typeof bag !== 'object') return null;
    const families = Object.keys(bag).map((family) => {
      const entry = bag[family];
      if (!entry || typeof entry !== 'object') return null;
      const fields = Object.keys(entry).map((key) => {
        const value = entry[key];
        return {
          path: `${spec.path}.${family}.${key}`,
          pathParts: [...spec.path.split('.'), family, key],
          key,
          label: PRESET_LABELS[key] || key,
          type: typeof value === 'boolean' ? 'boolean' : (key === 'positive' || key === 'negative' ? 'textarea' : 'text'),
          hint: '',
          locked: false,
          secret: false,
          configured: false,
          mask: '',
          options: null,
          value: typeof value === 'boolean' ? value : String(value ?? ''),
          original: typeof value === 'boolean' ? value : String(value ?? ''),
        };
      });
      return {
        family,
        label: family === '5' ? 'V5 预设' : family === '4.5' ? '4.5 预设' : `${family} 预设`,
        path: `${spec.path}.${family}`,
        fields,
      };
    }).filter(Boolean);
    return { path: spec.path, note: spec.note || '', families, artist: null };
  }

  function sectionView(section, config) {
    const locked = section.locked === true;
    const toggle = section.toggle ? {
      path: section.toggle.path,
      label: section.toggle.label || section.toggle.path,
      value: configAt(config, section.toggle.path) === true,
      original: configAt(config, section.toggle.path) === true,
      disabled: locked || section.toggle.disabled === true,
      why: section.toggle.why || '',
    } : null;
    const selector = section.selector ? {
      path: section.selector.path,
      label: section.selector.label || section.selector.path,
      value: String(configAt(config, section.selector.path) ?? 'none'),
      original: String(configAt(config, section.selector.path) ?? 'none'),
      options: (section.selector.options || []).map(item => ({ value: String(item.value), label: String(item.label) })),
      disabled: locked,
    } : null;
    const kind = section.id === 'tts' ? 'tts' : 'image';
    return {
      id: section.id,
      title: section.title || section.id,
      status: section.status || '',
      note: section.note || '',
      locked,
      toggle,
      selector,
      providers: (section.providers || []).map(provider => providerView(provider, config, { locked, kind })),
      presets: section.id === 'image' ? presetView(section, config) : null,
      preview: section.preview || null,
      fields: (section.fields || []).map(field => fieldView(field, config, { locked })),
    };
  }

  function buildView(descriptor, config) {
    return {
      id: descriptor.id || 'companion-media',
      title: descriptor.title || '媒体能力',
      subtitle: descriptor.subtitle || '',
      states: descriptor.states || [],
      api: descriptor.api || {},
      meta: descriptor.meta || {},
      sections: (descriptor.sections || []).map(section => sectionView(section, config)),
    };
  }

  /** path -> {type, secret, locked, original, parts}；保存与字段合并都只看这张表。 */
  function fieldIndex(view) {
    const index = Object.create(null);
    const add = (entry) => {
      if (!entry || !entry.path) return;
      index[entry.path] = {
        type: entry.type || (typeof entry.original === 'boolean' ? 'boolean' : 'text'),
        secret: entry.secret === true,
        locked: entry.locked === true || entry.disabled === true,
        original: entry.original,
        parts: partsOf(entry.path, entry.pathParts),
      };
    };
    (view.sections || []).forEach((section) => {
      add(section.toggle);
      if (section.selector) {
        index[section.selector.path] = {
          type: 'select',
          secret: false,
          locked: section.selector.disabled === true,
          original: section.selector.original,
          parts: partsOf(section.selector.path, section.selector.pathParts),
        };
      }
      (section.fields || []).forEach(add);
      (section.providers || []).forEach((provider) => {
        (provider.fields || []).forEach(add);
        if (provider.enablePath && !provider.enableField) {
          index[provider.enablePath] = {
            type: 'boolean',
            secret: false,
            locked: provider.canEnable !== true,
            original: provider.enabled === true,
            parts: partsOf(provider.enablePath),
          };
        }
      });
      const presets = section.presets;
      (presets ? presets.families : []).forEach(family => family.fields.forEach(add));
      if (presets && presets.artist) add(presets.artist);
    });
    return index;
  }

  /** 表单初值：密钥恒为空（只写），其余取当前配置。 */
  function draftFrom(view) {
    const draft = {};
    const index = fieldIndex(view);
    Object.keys(index).forEach((path) => {
      if (index[path].secret || index[path].locked) return;
      draft[path] = typeof index[path].original === 'boolean' ? index[path].original : String(index[path].original ?? '');
    });
    return draft;
  }

  function coerce(type, value) {
    if (type === 'boolean') return value === true || value === 'true';
    if (type === 'number') {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    return value;
  }

  /** 值相等判定：数字/字符串/布尔混用时不产生"假改动"（例如 '1' 与 1）。 */
  function sameValue(next, original) {
    const asBool = (value) => value === true || value === 'true';
    if (typeof next === 'boolean' || typeof original === 'boolean') return asBool(next) === asBool(original);
    if (next === null || next === undefined) return original === null || original === undefined || String(original) === '';
    if (original === null || original === undefined) return String(next) === '';
    return String(next) === String(original);
  }

  /**
   * `POST /config` 的 patch：只带真正改动的字段；密钥只在用户输入过时出现；
   * 清除走 `{clear:true}`。prefix 用于"只保存某个 provider / 某一块"。
   * 后端是稀疏深合并：没发的 provider 段原样保留，所以这里绝不能把整份配置塞回去。
   */
  function patchFrom(view, draft, secrets, clears, prefix, include) {
    const index = fieldIndex(view);
    const patch = {};
    const extra = Array.isArray(include) ? include : [];
    const within = path => !prefix || extra.includes(path) || String(path) === prefix || String(path).startsWith(`${prefix}.`);
    Object.keys(draft || {}).forEach((path) => {
      if (!within(path)) return;
      const meta = index[path];
      if (!meta || meta.locked || meta.secret) return;
      const next = coerce(meta.type, draft[path]);
      if (next === null) return; // 数字框留空：不发，交给用户补
      if (sameValue(next, meta.original)) return;
      setParts(patch, meta.parts, next);
    });
    Object.keys(secrets || {}).forEach((path) => {
      const text = String(secrets[path] ?? '').trim();
      if (!text || !within(path)) return;
      const meta = index[path];
      setParts(patch, partsOf(path, meta && meta.parts), text);
    });
    Object.keys(clears || {}).forEach((path) => {
      if (!clears[path] || !within(path)) return;
      const meta = index[path];
      setParts(patch, partsOf(path, meta && meta.parts), { clear: true });
    });
    return patch;
  }

  /** 400 响应里的 `errors[]` -> `{path: message}`；没有 path 的归到 `$`。 */
  function errorMap(errors) {
    const map = {};
    (Array.isArray(errors) ? errors : []).forEach((item) => {
      if (!item) return;
      const path = String(item.path || '$');
      if (!map[path]) map[path] = String(item.message || item.code || '校验没有通过');
    });
    return map;
  }

  function errorCount(patch) {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return 0;
      return Object.values(node).reduce((sum, value) => sum + (value && typeof value === 'object' ? walk(value) : 1), 0);
    };
    return walk(patch);
  }

  /** 媒体模块没启用/没接上：页面要能说清怎么启用。 */
  function isModuleDisabled(error) {
    if (!error) return false;
    const code = String(error.code || '');
    if (code === 'no-connection' || code === 'not-registered' || code === 'module-disabled') return true;
    // 路由没注册时宿主回 404；这种情况也要落到"模块没启用"的解释页。
    return Number(error.status) === 404;
  }

  /** 诊断区只展示这份：apiKey/token 一律替换成 {configured}，不落明文。 */
  function redactForDebug(value, depth = 0) {
    if (depth > 8) return '…';
    if (Array.isArray(value)) return value.map(item => redactForDebug(item, depth + 1));
    if (!value || typeof value !== 'object') {
      return typeof value === 'string' ? value.replace(/(sk|key|token)[-_A-Za-z0-9]{12,}/gi, '[redacted]') : value;
    }
    const out = {};
    Object.keys(value).forEach((key) => {
      if (SECRET_FIELD_NAMES.includes(key)) {
        out[key] = { configured: value[key] && typeof value[key] === 'object' ? value[key].configured === true : Boolean(value[key]) };
        return;
      }
      out[key] = redactForDebug(value[key], depth + 1);
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // 网络：媒体 API（`{ok, ...}` 平铺信封，端点取自 descriptor.api）
  // -------------------------------------------------------------------------

  function mediaUrl(path) {
    try {
      return new URL(path, document.baseURI).href;
    } catch {
      return `/${path}`;
    }
  }

  /** 永不抛：返回 { ok, status, payload }，调用方自己决定怎么说。 */
  function mediaFetch(path, method, body) {
    const hasBody = body !== undefined;
    return fetch(mediaUrl(path), {
      method: method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
    }).then(
      response => response.json().then(
        payload => ({ ok: Boolean(payload && payload.ok === true), status: response.status, payload: payload || null }),
        () => ({ ok: false, status: response.status, payload: null, badJson: true }),
      ),
      () => ({ ok: false, status: 0, payload: null, network: true }),
    );
  }

  function asApiError(result, fallback) {
    const error = (result && result.payload && result.payload.error) || {};
    return new P.ApiError(
      error.message || fallback || `媒体接口请求失败（HTTP ${result ? result.status : '?'}）。`,
      result ? result.status : 0,
      error.code || (result && result.badJson ? 'bad-response' : 'unknown'),
    );
  }

  /** 先读 page（端点也在它里面），再按 `api.config` 读配置。 */
  function loadMedia() {
    return mediaFetch(`${MEDIA_BASE}page`).then((page) => {
      if (!page.ok) throw asApiError(page, '读不到媒体能力的页面描述。');
      const api = (page.payload.page && page.payload.page.api) || {};
      return mediaFetch(apiPath(api.config, 'config')).then((config) => {
        if (!config.ok) throw asApiError(config, '读不到媒体配置。');
        return { page: page.payload, config: config.payload, api };
      });
    });
  }

  // -------------------------------------------------------------------------
  // 组件
  // -------------------------------------------------------------------------

  function SecretField({ entry, value, configured, mask, disabled, fromEnv, envVar, error, onChange }) {
    const status = fromEnv
      ? h(ui.StateLine, { state: 'idle', text: `来自环境变量${envVar ? `（${envVar}）` : ''}` })
      : h(ui.StateLine, { state: configured ? 'ok' : 'idle', text: configured ? (mask || '已配置') : '未配置' });
    const hint = fromEnv
      ? '这个 provider 的密钥来自环境变量：在这里改不会生效，请改环境变量本身'
      : (entry.hint || '只写：保存后只显示「已配置」；留空表示不修改');
    return h(ui.Field, { label: entry.label, hint, id: `media-${entry.path}` },
      h('div', { className: 'cpxp-media-secret' },
        h(ui.Input, {
          type: 'password',
          value: value || '',
          placeholder: fromEnv ? '由环境变量提供' : (configured ? '已配置（留空 = 不修改）' : '尚未配置'),
          disabled: Boolean(disabled || fromEnv),
          ariaLabel: entry.label,
          onChange: text => onChange(text),
        }),
        status),
      error ? h('p', { className: 'cpxp-media-error' }, error) : null);
  }

  function FieldControl({ entry, value, disabled, error, onChange }) {
    if (entry.type === 'boolean') {
      return h('div', null,
        h(ui.Toggle, { checked: value === true, disabled, label: entry.label, hint: entry.hint, onChange: next => onChange(next) }),
        error ? h('p', { className: 'cpxp-media-error' }, error) : null);
    }
    let control;
    if (entry.type === 'textarea') {
      control = h(ui.TextArea, { value: value ?? '', disabled, rows: 3, ariaLabel: entry.label, onChange: text => onChange(text) });
    } else if (entry.options && entry.options.length) {
      control = h(ui.Select, { value: value ?? '', disabled, ariaLabel: entry.label, options: entry.options, onChange: text => onChange(text) });
    } else {
      control = h(ui.Input, {
        type: entry.type === 'number' ? 'number' : 'text',
        value: value ?? '',
        disabled,
        ariaLabel: entry.label,
        onChange: text => onChange(text),
      });
    }
    return h(ui.Field, { label: entry.label, hint: entry.hint, id: `media-${entry.path}` },
      control,
      error ? h('p', { className: 'cpxp-media-error' }, error) : null);
  }

  function ProviderCard({ provider, selected, states, draft, secrets, clears, errors, testing, busy, onDraft, onSecret, onClear, onSave, onTest }) {
    const [open, setOpen] = P.useState(selected);
    // Follow protocol changes while retaining manual expand/collapse between selections.
    P.useEffect(() => setOpen(selected), [selected]);
    const status = testing[provider.id] || null;
    const dirty = provider.fields.some(field => (
      (field.secret ? Boolean(secrets[field.path]) : String(draft[field.path] ?? '') !== String(field.original ?? ''))
      || Boolean(clears[field.path])
    ));
    const badge = h('div', { className: 'cpxp-media-badge-row' },
      h(ui.Badge, { tone: stateTone(provider.state) }, stateLabel(states, provider.state)),
      provider.notConnected ? h(ui.Badge, { tone: 'neutral' }, '尚未接入') : null,
      provider.enabled === true ? h(ui.Badge, { tone: 'ok' }, '已启用') : null);
    const header = h('div', { className: 'cpxp-media-card-head' },
      h('div', null, h('h4', { className: 'cpxp-media-card-title' }, provider.label), badge),
      h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        onClick: () => setOpen(!open),
        title: open ? '收起这个 provider 的配置' : '展开这个 provider 的配置',
      }, open ? '收起' : '展开'));
    if (!open) {
      return h('div', { key: `provider-${provider.id}`, className: 'cpxp-media-card' },
        header,
        h('p', { className: 'cpxp-media-note' }, provider.stateNote || ''),
        status ? testResultLine(status) : null);
    }
    const fieldNodes = provider.fields.map((field) => {
      const error = errors[field.path];
      if (field.secret) {
        // 环境变量来的密钥：页面只能显示来源，不能改、也不能"清除"（会被覆盖回去）。
        const clearButton = field.configured && !field.locked && !field.fromEnv
          ? h('div', { className: 'cpxp-media-actions' },
            h(ui.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: Boolean(busy),
              onClick: () => onClear(field.path, provider),
              title: provider.enabled ? '清除前会先把「启用」关掉：后端不允许在启用态清空必填密钥' : '把已保存的密钥从配置里删掉（需要保存）',
            }, clears[field.path] ? '将清除（待保存）' : '清除已保存的密钥'),
            provider.enabled && clears[field.path]
              ? h('p', { className: 'cpxp-media-note' }, '第二步：保存时会把「启用」一起关掉，再把密钥清空（否则后端会拒绝）。')
              : null)
          : null;
        return h('div', { key: field.path, className: 'cpxp-media-field-wide' },
          h(SecretField, {
            entry: field,
            value: secrets[field.path] || '',
            configured: field.configured,
            mask: field.mask,
            fromEnv: field.fromEnv === true,
            envVar: field.envVar || '',
            disabled: field.locked || Boolean(busy),
            error,
            onChange: text => onSecret(field.path, text),
          }),
          clearButton);
      }
      return h('div', { key: field.path, className: field.type === 'textarea' ? 'cpxp-media-field-wide' : '' },
        h(FieldControl, {
          entry: field,
          value: draft[field.path],
          disabled: field.locked || Boolean(busy),
          error,
          onChange: text => onDraft(field.path, text),
        }));
    });
    const actions = h('div', { className: 'cpxp-media-actions' },
      h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        loading: busy === `save:${provider.prefix}`,
        disabled: !dirty || Boolean(busy),
        onClick: () => onSave(provider.prefix),
        title: '只保存这个 provider 的改动（留空的密钥不会被写回）',
      }, '保存这个 provider'),
      h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        loading: busy === `test:${provider.id}`,
        disabled: !provider.canTest || Boolean(busy),
        onClick: () => onTest(provider.id, provider.kind, !provider.canTest),
        title: provider.canTest ? '由你点一下才发起一次轻量探测（不会生成图片/语音）' : '尚未接入，无法测试',
      }, '测试连接'),
      status ? testResultLine(status) : null);
    const evidence = h(ui.Diagnostic, { title: '协议与证据（只读）', hint: provider.label },
      h(ui.KeyValue, {
        items: [
          { k: 'endpoint', v: provider.endpoint || '—', mono: true, breakable: true },
          { k: 'auth', v: provider.auth || '—' },
          { k: 'response', v: provider.responseFormat || '—' },
          { k: 'voice', v: provider.voiceListing || '—' },
          { k: 'rateLimit', v: provider.rateLimit || '—' },
          { k: 'license', v: provider.license || '—' },
          { k: 'evidence', v: provider.evidence && provider.evidence.level ? `${provider.evidence.level} 级` : '—' },
        ],
      }));
    return h('div', { key: `provider-${provider.id}`, className: 'cpxp-media-card' },
      header,
      h('p', { className: 'cpxp-media-note' }, provider.stateNote || ''),
      h('div', { className: 'cpxp-media-fields' }, fieldNodes),
      actions,
      status && status.detail ? h('p', { className: 'cpxp-media-note' }, status.detail) : null,
      evidence);
  }

  function testResultLine(status) {
    if (!status) return null;
    if (status.running) return h(ui.StateLine, { state: 'idle', text: '测试中…' });
    if (status.ok) return h(ui.StateLine, { state: 'ok', text: `测试通过（证据等级 ${status.level || 'none'}）` });
    return h(ui.StateLine, { state: 'danger', text: `测试失败${status.code ? ` · ${status.code}` : ''}` });
  }

  function PresetEditor({ presets, draft, busy, onDraft }) {
    if (!presets) return null;
    const familyCards = presets.families.map(family => h('div', { key: family.path, className: 'cpxp-media-card' },
      h('h4', { className: 'cpxp-media-card-title' }, family.label),
      h('div', { className: 'cpxp-media-fields' },
        family.fields.map(field => h('div', { key: field.path, className: 'cpxp-media-field-wide' },
          h(FieldControl, {
            entry: field,
            value: draft[field.path],
            disabled: Boolean(busy),
            onChange: text => onDraft(field.path, text),
          }))))));
    const artist = presets.artist;
    const artistCard = artist
      ? h('div', { key: 'preset-artist', className: 'cpxp-media-card' },
        h('h4', { className: 'cpxp-media-card-title' }, artist.label || '画师串'),
        h('div', { className: 'cpxp-media-fields' },
          h('div', { className: 'cpxp-media-field-wide' },
            h(FieldControl, {
              entry: artist,
              value: draft[artist.path],
              disabled: Boolean(busy),
              onChange: text => onDraft(artist.path, text),
            }))))
      : null;
    return h('div', null,
      h('p', { className: 'cpxp-media-note' }, presets.note || 'V5 与 4.5 的预设分开存储，互不串用；切换模型不会把一族的预设套到另一族。'),
      h('div', { className: 'cpxp-media-presets' }, familyCards),
      artistCard);
  }

  function PreviewTool({ spec, preview, form, busy, onForm, onRun }) {
    if (!spec) return null;
    const resolution = preview && preview.resolution ? preview.resolution : null;
    const defaults = spec.values || {};
    const aspects = [
      { value: 'portrait', label: '竖图' },
      { value: 'landscape', label: '横图' },
      { value: 'square', label: '方图' },
    ];
    return h('div', { className: 'cpxp-media-card' },
      h('h4', { className: 'cpxp-media-card-title' }, spec.label || '自动分辨率预览'),
      h('p', { className: 'cpxp-media-note' }, spec.note || '按画幅与目标像素计算并取整到 64 的倍数；同一输入同一结果，越界会明确报错。'),
      h('div', { className: 'cpxp-media-actions' },
        h(ui.Select, {
          value: form.aspect || defaults.aspect || 'portrait',
          ariaLabel: '画幅',
          options: aspects,
          onChange: value => onForm({ ...form, aspect: value }),
        }),
        h(ui.Input, {
          value: String(form.targetPixels || defaults.targetPixels || ''),
          ariaLabel: '目标像素',
          width: 150,
          onChange: value => onForm({ ...form, targetPixels: value }),
        }),
        h(ui.Button, {
          variant: 'ghost',
          size: 'sm',
          loading: busy === 'preview',
          onClick: onRun,
          title: '只在点击时计算；不生成图片、不调用模型',
        }, '预览')),
      resolution
        ? h('p', { className: 'cpxp-media-note' }, resolution.ok
          ? `结果：${resolution.size || '—'}（取整到 64 的倍数）`
          : `计算失败：${resolution.error || resolution.code || '参数不合法'}（按后端返回照实显示，页面不改写）`)
        : null);
  }

  function sectionDirty(section, draft, secrets, clears) {
    const fields = [];
    if (section.toggle && !section.toggle.disabled) fields.push({ path: section.toggle.path, original: section.toggle.original, secret: false });
    if (section.selector && !section.selector.disabled) fields.push({ path: section.selector.path, original: section.selector.original, secret: false });
    section.fields.forEach((field) => { if (!field.locked) fields.push(field); });
    section.providers.forEach((provider) => {
      provider.fields.forEach((field) => { if (!field.locked) fields.push(field); });
      if (provider.enablePath && !provider.enableField && provider.canEnable) {
        fields.push({ path: provider.enablePath, original: provider.enabled === true, secret: false });
      }
    });
    const presets = section.presets;
    (presets ? presets.families : []).forEach(family => family.fields.forEach(field => fields.push(field)));
    if (presets && presets.artist) fields.push(presets.artist);
    return fields.some((field) => {
      if (clears[field.path]) return true;
      if (field.secret) return Boolean(secrets[field.path]);
      const value = draft[field.path];
      if (typeof field.original === 'boolean') return (value === true) !== (field.original === true);
      return String(value ?? '') !== String(field.original ?? '');
    });
  }

  function SectionCard({ section, states, testing, draft, secrets, clears, errors, busy, onDraft, onSecret, onClear, onSave, onTest }) {
    const [open, setOpen] = P.useState(true);
    const dirty = sectionDirty(section, draft, secrets, clears);
    const selectedProvider = section.selector ? (draft[section.selector.path] ?? section.selector.value) : null;
    const toggleNode = section.toggle
      ? h('div', { className: 'cpxp-media-actions' },
        h(ui.Toggle, {
          checked: Boolean(draft[section.toggle.path] ?? section.toggle.value),
          disabled: section.toggle.disabled,
          label: section.toggle.label,
          hint: section.toggle.disabled ? (section.toggle.why || '这一项本轮不可操作') : '',
          onChange: next => onDraft(section.toggle.path, next),
        }))
      : null;
    const selectorNode = section.selector
      ? h('div', { className: 'cpxp-media-actions' },
        h(ui.Field, { label: section.selector.label, id: `media-${section.selector.path}` },
          h(ui.Select, {
            value: selectedProvider,
            disabled: section.selector.disabled,
            ariaLabel: section.selector.label,
            options: section.selector.options,
            onChange: value => onDraft(section.selector.path, value),
          })))
      : null;
    const fieldNodes = section.fields.length
      ? h('div', { className: 'cpxp-media-fields' }, section.fields.map(field => h('div', {
        key: field.path,
        className: field.type === 'textarea' ? 'cpxp-media-field-wide' : '',
      }, h(FieldControl, {
        entry: field,
        value: field.secret ? '' : draft[field.path],
        disabled: field.locked || Boolean(busy),
        error: errors[field.path],
        onChange: text => (field.secret ? onSecret(field.path, text) : onDraft(field.path, text)),
      }))))
      : null;
    const providerNodes = section.providers.length
      ? h('div', null, section.providers.map(provider => h(ProviderCard, {
        key: provider.id,
        provider,
        selected: provider.id === selectedProvider,
        states,
        draft,
        secrets,
        clears,
        errors,
        testing,
        busy,
        onDraft,
        onSecret,
        onClear,
        onSave,
        onTest,
      })))
      : null;
    const saveNode = h('div', { className: 'cpxp-media-actions' },
      h(ui.Button, {
        variant: 'ghost',
        size: 'sm',
        loading: busy === `save:${section.id}`,
        disabled: section.locked || !dirty || Boolean(busy),
        onClick: () => onSave(section.id),
        title: section.locked ? '这一块本轮不可编辑' : '保存这一块的改动',
      }, '保存这一块'));
    return h('section', { key: `section-${section.id}`, className: 'cpxp-media-sec' },
      h('div', { className: 'cpxp-media-sec-head' },
        h('div', null,
          h('h3', { className: 'cpxp-media-sec-title' }, section.title),
          h('p', { className: 'cpxp-media-note' }, section.note)),
        h('div', { className: 'cpxp-media-actions' },
          section.status ? h(ui.Badge, { tone: section.status === 'on' ? 'ok' : 'neutral' }, section.status === 'on' ? '已启用' : '未启用') : null,
          h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => setOpen(!open) }, open ? '收起' : '展开'))),
      open
        ? h('div', null,
          toggleNode,
          selectorNode,
          fieldNodes,
          providerNodes,
          section.presets ? h(PresetEditor, { presets: section.presets, draft, busy, onDraft }) : null,
          saveNode)
        : null);
  }

  function runtimeFlagList(media) {
    const rows = [
      { key: 'enabled', label: '媒体总开关' },
      { key: 'vision', label: '识图' },
      { key: 'speech', label: '语音表达' },
      { key: 'image', label: '图片创作' },
      { key: 'screen', label: '屏幕感知' },
    ];
    return h(ui.Diagnostic, { key: 'runtime-flags', title: '运行库视角（GET companion · media）', hint: '只说明运行库读到的开关；本页的配置以媒体插件为准' },
      h(ui.List, { label: '运行库读到的媒体开关' }, rows.map(row => h(ui.Row, {
        key: `rt-${row.key}`,
        title: row.label,
        meta: '来自 GET companion',
        status: h(ui.StateLine, {
          state: media && media[row.key] === true ? 'ok' : 'idle',
          text: media && media[row.key] === true ? '已启用' : media && media[row.key] === false ? '已关闭' : '未读到',
        }),
      }))));
  }

  function MediaBand({ media }) {
    const state = P.useApi(loadMedia, []);
    const [draft, setDraft] = P.useState({});
    const [secrets, setSecrets] = P.useState({});
    const [clears, setClears] = P.useState({});
    const [errors, setErrors] = P.useState({});
    const [busy, setBusy] = P.useState('');
    const [flash, setFlash] = P.useState(null);
    const [testing, setTesting] = P.useState({});
    const [preview, setPreview] = P.useState(null);
    const [previewForm, setPreviewForm] = P.useState({});

    const bundle = state.data || null;
    const descriptor = bundle && bundle.page ? bundle.page.page : null;
    const configBundle = bundle && bundle.config ? bundle.config : null;
    const config = configBundle && configBundle.config ? configBundle.config : null;
    const api = bundle && bundle.api ? bundle.api : {};
    // 必须 memo：每次渲染新建 view 会让下面的"重置表单"effect 反复触发（无限渲染）。
    const view = P.useMemo(
      () => (descriptor && config ? buildView(descriptor, config) : null),
      [descriptor, config],
    );

    P.useEffect(() => {
      if (!view) return;
      setDraft(draftFrom(view));
      setSecrets({});
      setClears({});
      setErrors({});
    }, [view]);

    const validation = configBundle && configBundle.validation ? configBundle.validation : null;
    const setSecret = (path, value) => setSecrets(previous => ({ ...previous, [path]: value }));

    /** 切换默认协议时，如果新协议还没配好，先把能力关掉——否则后端会以 400 拒绝整次保存。 */
    const setField = (path, value) => {
      setDraft(previous => ({ ...previous, [path]: value }));
      if (!view) return;
      const section = view.sections.find(item => item.selector && item.selector.path === path);
      if (!section || !section.toggle || section.toggle.value !== true) return;
      const provider = section.providers.find(item => item.id === value);
      if (!provider || provider.missing.length === 0) return;
      setFieldDirect(section.toggle.path, false);
      setFlash({
        tone: 'warn',
        title: `已先关闭「${section.toggle.label}」`,
        text: `新选的协议还没配置完整（缺 ${provider.missing.join('、')}）。启用态下保存会被后端拒绝，所以先把开关关掉；补齐后再打开。`,
      });
    };
    const setFieldDirect = (path, value) => setDraft(previous => ({ ...previous, [path]: value }));

    const setClear = (path, provider) => {
      const needsDisable = Boolean(provider && provider.enabled && provider.disablePath);
      if (!clears[path] && typeof P.confirm === 'function') {
        const message = needsDisable
          ? `清除「${provider.label}」的密钥需要两步：\n1) 先关掉「${provider.kind === 'tts' ? '这个后端的启用' : '启用生图'}」\n2) 再清空密钥\n\n点「保存」会把这两步一起提交（后端不允许在启用态清空必填密钥）。`
          : `清除「${provider ? provider.label : path}」已保存的密钥？\n\n点「保存」之后才会真正删掉；输入框留空不会删除密钥。`;
        if (!P.confirm(message)) return;
      }
      // 两步引导：启用态下清密钥 = 同一个 patch 里先把开关关掉，避免撞后端 400。
      if (needsDisable) setFieldDirect(provider.disablePath, false);
      setClears(previous => ({ ...previous, [path]: !previous[path] }));
    };

    /** 这个密钥字段属于哪个 provider（清除时要连带关掉它的能力开关）。 */
    const providerOfField = (path) => {
      if (!view) return null;
      for (const section of view.sections) {
        for (const provider of section.providers) {
          if (provider.fields.some(field => field.path === path)) return provider;
        }
      }
      return null;
    };

    const doSave = (prefix) => {
      if (!view) return;
      // 清除密钥必须"先关能力"：把被清 provider 的开关路径强制带进这份 patch。
      const forced = Object.keys(clears)
        .filter(path => clears[path])
        .map((path) => providerOfField(path))
        .filter(provider => provider && provider.enabled && provider.disablePath)
        .map(provider => provider.disablePath);
      const patch = patchFrom(view, draft, secrets, clears, prefix, forced);
      // 兜底：即使草稿里没留下关开关这一步，也要把它写进 patch（后端不许启用态清密钥）。
      forced.forEach((path) => {
        const parts = partsOf(path);
        if (configAtParts(patch, parts) === undefined) setParts(patch, parts, false);
      });
      if (!Object.keys(patch).length) {
        setFlash({ tone: 'info', title: '没有需要保存的修改', text: '只有改过的字段才会被提交。' });
        return;
      }
      setBusy(`save:${prefix || 'all'}`);
      setErrors({});
      mediaFetch(apiPath(api.save, 'config'), 'POST', { patch }).then((result) => {
        setBusy('');
        if (!result.ok) {
          setErrors(errorMap(result.payload && result.payload.errors));
          const first = result.payload && result.payload.error ? result.payload.error.message : '';
          setFlash({ tone: 'danger', title: '保存失败', text: first || asApiError(result).message });
          return;
        }
        const savedCount = errorCount(patch);
        const nextConfig = result.payload && result.payload.config ? result.payload.config : null;
        const stillConfigured = Object.keys(clears).filter(path => clears[path]).filter((path) => {
          const value = configAt(nextConfig, path);
          return secretInfo(value).configured;
        });
        setSecrets({});
        setClears({});
        if (stillConfigured.length) {
          setFlash({
            tone: 'warn',
            title: `已保存 ${savedCount} 项，但清除没有生效`,
            text: '后端仍报告这些密钥处于配置状态。页面不会把"已清除"写在结果里——这需要媒体插件支持显式清除动作。',
          });
        } else {
          setFlash({ tone: 'ok', title: `已保存 ${savedCount} 项`, text: '已写入媒体配置文件；页面会重新读一遍同一份数据，可对照回读。' });
          if (typeof P.notice === 'function') P.notice('媒体配置已保存', 'ok');
        }
        state.reload();
      }, () => {
        setBusy('');
        setFlash({ tone: 'danger', title: '保存失败', text: '网络请求没有完成。' });
      });
    };

    const doTest = (id, kind, blocked) => {
      if (blocked) return;
      setBusy(`test:${id}`);
      setTesting(previous => ({ ...previous, [id]: { running: true } }));
      mediaFetch(apiPath(api.test, 'test'), 'POST', { kind: kind === 'tts' ? 'tts' : 'image', id }).then((result) => {
        setBusy('');
        const payload = result.payload || {};
        // 语义：provider 侧失败是 HTTP 200 + body.ok:false（只有未知 provider 才是 400）。
        setTesting(previous => ({
          ...previous,
          [id]: { ok: payload.ok === true, level: payload.level, code: payload.code, detail: payload.detail },
        }));
        if (typeof P.notice === 'function') P.notice(payload.ok === true ? '测试通过（只到这一级证据）' : '测试失败', payload.ok === true ? 'ok' : 'danger');
      }, () => {
        setBusy('');
        setTesting(previous => ({ ...previous, [id]: { ok: false, detail: '网络请求没有完成' } }));
      });
    };

    const runPreview = (spec) => {
      const values = (spec && spec.values) || {};
      const query = new URLSearchParams({
        mode: 'auto',
        aspect: previewForm.aspect || values.aspect || 'portrait',
        targetPixels: String(previewForm.targetPixels || values.targetPixels || ''),
      }).toString();
      if (values.model) query.model = String(values.model);
      setBusy('preview');
      mediaFetch(`${apiPath(api.preview, 'preview')}?${query}`).then((result) => {
        setBusy('');
        const payload = result.payload || {};
        setPreview(payload.resolution ? payload : { resolution: { ok: false, error: '读不到结果' } });
      }, () => {
        setBusy('');
        setPreview({ resolution: { ok: false, error: '网络请求没有完成' } });
      });
    };

    const header = {
      key: 'media-settings',
      title: '媒体能力',
      hint: '配置直接来自媒体插件；保存只走它自己的接口',
      actions: [state.data ? h(ui.Button, {
        key: 'reload',
        variant: 'ghost',
        size: 'sm',
        onClick: state.reload,
        title: '重新读一遍页面描述与配置（不会发起任何测试或生成）',
      }, '刷新') : null],
    };

    if (state.loading && !bundle) {
      return h(ui.Band, header, h(ui.Skeleton, { rows: 4 }));
    }
    if (isModuleDisabled(state.error)) {
      return h(ui.Band, header,
        h(ui.Callout, { tone: 'warn', title: '套件里没有启用「媒体」模块' },
          h('div', null,
            h('p', { className: 'cpxp-media-note' }, '这一页仍然能被打开，但媒体插件没有挂载时没有任何配置可读可写——这不是页面坏了。'),
            h('p', { className: 'cpxp-media-note' }, '启用路径：编辑套件里的 config/suite.json，把 modules.media 改成 true，然后重启套件（npm run start），再用 npm run doctor 复核。'),
            h(ui.Pre, { maxHeight: 160 }, ENABLE_SNIPPET),
            h('p', { className: 'cpxp-media-note' }, 'config/suite.json 是套件级本地配置（不入库），模板是 config/suite.example.json；npm run setup 不会覆盖已有文件。'))),
        runtimeFlagList(media));
    }
    if (!view) {
      return h(ui.Band, header,
        h(ui.Callout, { tone: state.error ? 'danger' : 'warn', title: '读不到媒体能力页面' },
          h('span', null, P.failText(state.error, '媒体接口没有返回页面描述或配置。'))),
        runtimeFlagList(media));
    }

    const sectionNodes = view.sections.map(section => h('div', { key: `sec-wrap-${section.id}` },
      h(SectionCard, {
        section,
        states: view.states,
        testing,
        draft,
        secrets,
        clears,
        errors,
        busy,
        onDraft: setField,
        onSecret: setSecret,
        onClear: setClear,
        onSave: doSave,
        onTest: doTest,
      }),
      section.preview
        ? h(PreviewTool, {
          key: `preview-${section.id}`,
          spec: section.preview,
          preview,
          form: previewForm,
          busy,
          onForm: setPreviewForm,
          onRun: () => runPreview(section.preview),
        })
        : null));

    return h(ui.Band, header, [
      flash ? h(ui.Callout, { key: 'flash', tone: flash.tone === 'ok' ? 'info' : flash.tone, title: flash.title }, h('span', null, flash.text)) : null,
      validation && validation.ok === false
        ? h(ui.Callout, { key: 'validation', tone: 'warn', title: '当前配置文件本身有校验问题' },
          h('ul', { className: 'cpxp-media-note' }, (validation.errors || []).slice(0, 6).map(item => h('li', { key: String(item.path || item.message) }, `${item.path || '$'}：${item.message || item.code || ''}`))))
        : null,
      h('p', { key: 'test-hint', className: 'cpxp-media-note-inline' },
        '测试与预览只在你点按钮时发起：打开这一页只读 page 与 config，不会生成图片、不会调用模型、不会向外发送消息。'),
      h('div', { key: 'sections' }, sectionNodes),
      runtimeFlagList(media),
      h(ui.Diagnostic, { key: 'raw', title: '原始页面描述与配置（只读）', hint: '排查用；密钥已脱敏' },
        h(ui.Pre, { maxHeight: 320 }, JSON.stringify({ page: redactForDebug(descriptor), config: redactForDebug(config) }, null, 2))),
    ]);
  }

  P.mediaPage = {
    MediaBand,
    buildView,
    fieldIndex,
    draftFrom,
    patchFrom,
    errorMap,
    errorCount,
    isModuleDisabled,
    redactForDebug,
    stateLabel,
    stateTone,
    secretInfo,
    configAt,
    apiPath,
    STATE_LABELS,
    STATE_TONES,
    MEDIA_BASE,
    ENABLE_SNIPPET,
  };
})(P);

// ==== src/client/pages-workspace.js ====
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

// ==== src/client/pages-settings.js ====
// 陪伴空间 · 设置（page id: settings）
//
// 读：GET settings（白名单 21 个可写字段 + 密钥是否已配置）、GET companion（角色 / 连接只读状态）。
// 写：POST settings（只收白名单字段；密钥只写不读）、POST settings/test（模型探测）、POST maintenance。
// 边界：接口永不回传密钥明文，本页也永不回显完整值；写入的是本机 memory.config.json，重启后生效。
(function (P) {
  const h = P.h;
  const ui = P.ui;
  const api = P.api;
  const fmt = P.fmt;
  const useState = P.useState;
  const useEffect = P.useEffect;

  // 页面自有样式只用 cpxp- 前缀，颜色一律走 alias / cpx token。
  P.css(`
.cpxp-set-field { display: flex; flex-direction: column; gap: var(--cpx-s1, 4px); padding: var(--cpx-s3, 12px) 0; border-top: 1px solid var(--dsw-alias-border-l1); min-width: 0; }
.cpxp-set-field:first-child { border-top: 0; padding-top: 0; }
.cpxp-set-field[data-dirty="true"] { border-left: 2px solid var(--dsw-alias-brand-primary); padding-left: var(--cpx-s3, 12px); }
.cpxp-set-field[data-dirty="false"] { border-left: 0; padding-left: 0; }
.cpxp-set-inline { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cpx-s2, 8px); min-width: 0; }
.cpxp-set-inline > * { min-width: 0; max-width: 100%; }
.cpxp-set-disabled { opacity: .5; pointer-events: none; }
.cpxp-set-sub { margin: var(--cpx-s4, 16px) 0 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); font-weight: 600; letter-spacing: .04em; }
.cpxp-set-secret { color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); }
.cpxp-set-secret[data-set="true"] { color: var(--dsw-alias-state-success-primary); }
.cpxp-set-secret[data-set="false"] { color: var(--dsw-alias-label-secondary); }
.cpxp-set-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; overflow-wrap: anywhere; word-break: break-all; }
.cpxp-set-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--cpx-fs-small, 12.5px); line-height: 1.7; overflow-wrap: anywhere; }
`);

  const text = value => (value === null || value === undefined ? '' : String(value));
  // 布尔值可能来自 JSON 的 true 或字符串 'true'（旧配置里两种都出现过）。
  const isOn = value => value === true || text(value) === 'true';
  // 失败原因统一带上后端错误码，排障时能对上。
  const failText = (error, fallback) => (typeof P.failText === 'function'
    ? P.failText(error, fallback || '未知错误')
    : (error && error.message ? error.message : (fallback || '未知错误')));

  // ---------------------------------------------------------------------------
  // 白名单字段：与 lib/write.mjs 的 SETTINGS_SPEC 一一对应，范围以源码为准。
  // section 决定它落在哪个分区；path 是 memory.config.json 里的真实写入路径。
  // ---------------------------------------------------------------------------
  const FIELDS = {
    extractionEnabled: {
      section: 'extract', label: '自动提炼记忆', control: 'toggle', path: 'extraction.enabled',
      hint: '会产生模型调用',
    },
    minMessages: {
      section: 'extract', label: '提炼批次阈值', control: 'integer', min: 2, max: 50, path: 'extraction.minMessages',
      hint: '',
    },
    semanticEnabled: {
      section: 'retrieval', label: '语义检索通道', control: 'toggle', path: 'retrieval.semanticEnabled',
      hint: '',
    },
    topK: {
      section: 'retrieval', label: '每轮召回条数', control: 'integer', min: 1, max: 20, path: 'retrieval.topK',
      hint: '',
    },
    budgetChars: {
      section: 'retrieval', label: '注入字符预算', control: 'integer', min: 400, max: 8000, path: 'injection.budgetChars',
      hint: '不是 token',
    },
    wikiAutoCompile: {
      section: 'wiki', label: '自动编译 Wiki', control: 'toggle', path: 'wiki.autoCompile',
      hint: '',
    },
    wikiMaxEntriesPerTopic: {
      section: 'wiki', label: '每主题条目上限', control: 'integer', min: 1, max: 2000, path: 'wiki.maxEntriesPerTopic',
      hint: '',
    },
    rrfK: {
      section: 'retrieval', label: 'RRF 常数', control: 'integer', min: 1, max: 120, path: 'retrieval.rrfK',
      hint: '',
    },
    mmrLambda: {
      section: 'retrieval', label: 'MMR λ', control: 'number', min: 0, max: 1, path: 'retrieval.mmrLambda',
      hint: '',
    },
    coverageFloor: {
      section: 'retrieval', label: '覆盖度门槛', control: 'number', min: 0, max: 1, path: 'retrieval.coverageFloor',
      hint: '',
    },
    embeddingProvider: {
      section: 'embedding', label: '向量提供器', control: 'select', path: 'embedding.provider',
      options: [
        { value: 'local', label: 'local（本地哈希，不联网）' },
        { value: 'remote', label: 'remote（远端模型）' },
        { value: 'off', label: 'off（关闭向量通道）' },
      ],
      hint: '远端失败自动降级',
    },
    embeddingBaseUrl: {
      section: 'embedding', label: '向量 API 地址', control: 'url', path: 'embedding.baseUrl',
      placeholder: 'https://api.siliconflow.cn/v1',
      hint: '可留空',
    },
    embeddingModel: {
      section: 'embedding', label: '向量模型名', control: 'text', path: 'embedding.model',
      placeholder: 'BAAI/bge-m3',
      hint: 'remote 必填',
    },
    embeddingDimensions: {
      section: 'embedding', label: '向量维度', control: 'integer', min: 64, max: 4096, path: 'embedding.dimensions',
      hint: '需与模型输出一致',
    },
    rerankEnabled: {
      section: 'rerank', label: '启用重排序', control: 'toggle', path: 'rerank.enabled',
      hint: '',
    },
    rerankBaseUrl: {
      section: 'rerank', label: '重排序 API 地址', control: 'url', path: 'rerank.baseUrl',
      placeholder: 'https://api.jina.ai/v1/rerank',
      hint: '',
    },
    rerankModel: {
      section: 'rerank', label: '重排序模型名', control: 'text', path: 'rerank.model',
      placeholder: 'jina-reranker-v2-base-multilingual',
      hint: '启用时必填',
    },
    rerankTimeoutMs: {
      section: 'rerank', label: '重排序超时（毫秒）', control: 'integer', min: 500, max: 30000, path: 'rerank.timeoutMs',
      hint: '超时放弃重排',
    },
    rerankTopN: {
      section: 'rerank', label: '重排候选上限', control: 'integer', min: 0, max: 50, path: 'rerank.topN',
      hint: '0 = 全部候选',
    },
    rerankBlend: {
      section: 'rerank', label: '重排权重 blend', control: 'number', min: 0, max: 1, path: 'rerank.blend',
      hint: '',
    },
    backend: {
      section: 'storage', label: '存储后端', control: 'select', path: 'backend',
      options: [
        { value: 'sqlite', label: 'sqlite（新记忆库）' },
        { value: 'legacy', label: 'legacy（旧 JSON 快照）' },
      ],
      hint: '回滚不同步新库内容',
    },
  };

  // 只写字段：POST 接受，GET 永不返回明文，界面也无法回填。
  const SECRET_LABELS = { embeddingApiKey: '向量模型 API Key', rerankApiKey: '重排序模型 API Key' };
  const API_KEY_MIN = 8;
  const API_KEY_MAX = 512;

  const THEME_OPTIONS = [
    { id: 'system', label: '跟随系统' },
    { id: 'light', label: '浅色' },
    { id: 'dark', label: '深色' },
  ];
  const THEME_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' };
  const SCHEME_LABELS = { light: '浅色', dark: '深色' };

  // 探测接口只回固定 code，不回服务端原文；这里逐条翻成人话。
  const PROBE_ERRORS = {
    'no-key': '还没有保存 API Key',
    'not-configured': '这项还没配置（缺地址或模型）',
    network: '网络不可达（检查代理或防火墙）',
    timeout: '请求超时',
    'http-401': '鉴权失败（401，key 可能无效）',
    'http-403': '没有权限（403）',
    'http-404': '接口不存在（404，检查地址是否需要带 /v1）',
    'http-4xx': '请求被拒绝（4xx）',
    'http-5xx': '服务端错误（5xx）',
    'bad-shape': '响应不是标准的 embeddings / rerank 结构',
    'dimension-mismatch': '返回维度与配置不一致',
    'empty-vectors': '返回了空向量',
  };

  const THEME_KEYS = ['system', 'light', 'dark'];

  // ---------------------------------------------------------------------------
  // 健康与睡眠：/api/companion-health/*（契约 §13）
  //
  // core.js 的 apiBase() 只指向 api/companion-memory/，所以这里照抄 pages-health.js
  // 顶部那套 fetch 语义（同源 cookie、no-store、信封解包、错误一律 ApiError）。
  // 两个片段互相不能 require，改动时两边要一起看。
  // ---------------------------------------------------------------------------
  const HEALTH_BASE = 'api/companion-health/';

  function healthBase() {
    try {
      return new URL(HEALTH_BASE, document.baseURI).href;
    } catch {
      return `/${HEALTH_BASE}`;
    }
  }

  function healthUrl(path, params) {
    let url = healthBase() + String(path || '').replace(/^\/+/, '');
    if (params) {
      const search = Object.keys(params)
        .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
        .join('&');
      if (search) url += (url.indexOf('?') >= 0 ? '&' : '?') + search;
    }
    return url;
  }

  const HEALTH_FAIL_FALLBACK = {
    'health-unavailable': '健康服务没有挂载到这个面板上。',
    'health-db-unavailable': '健康数据库还没打开，所以读不到数据。',
    'health-read-denied': '这项读取被授权开关挡下了。',
    'unsupported-action': '健康服务没有暴露这个动作。',
  };

  function healthError(apiError, errorCode) {
    const reason = errorCode == null ? '' : String(errorCode).trim();
    if (reason) apiError.errorCode = reason;
    return apiError;
  }

  /** 信封解包：§11 的只读失败也长成 {ok:false, code, message}，套在 data 里。 */
  function unwrapHealth(body, httpStatus) {
    if (!body || body.ok !== true) {
      const error = (body && body.error) || {};
      const code = error.code || 'unknown';
      const message = error.message || HEALTH_FAIL_FALLBACK[code] || `健康接口请求失败（HTTP ${httpStatus}）。`;
      throw healthError(new P.ApiError(message, httpStatus, code), error.errorCode);
    }
    const data = body.data;
    if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
      const code = data.code || 'unknown';
      throw healthError(
        new P.ApiError(data.message || HEALTH_FAIL_FALLBACK[code] || '健康服务没有给出原因。', httpStatus, code),
        data.errorCode,
      );
    }
    return data;
  }

  function healthRequest(path, options) {
    const settings = options || {};
    const hasBody = settings.body !== undefined;
    return fetch(healthUrl(path, settings.params), {
      method: settings.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(hasBody ? { body: JSON.stringify(settings.body) } : {}),
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
    }).then(
      response => response.json().then(
        body => unwrapHealth(body, response.status),
        () => { throw new P.ApiError(`健康接口返回不是 JSON（HTTP ${response.status}）。`, response.status, 'bad-response'); },
      ),
      () => { throw new P.ApiError('无法连接宿主（桌面可能已关闭）。', 0, 'network'); },
    );
  }

  const healthGet = (path, params) => healthRequest(path, { params });
  const healthPost = (path, body) => healthRequest(path, { method: 'POST', body: body || {} });

  /** 健康服务自己的授权表：只认布尔，读不到就是 null（未知），不猜。 */
  function consentOf(status, key) {
    const consents = status && status.consents && typeof status.consents === 'object' ? status.consents : null;
    if (!consents) return null;
    const value = consents[key];
    return value === true || value === false ? value : null;
  }

  const COLLECTOR_CONSENT = 'health.connect';
  const PULSE_CONSENT = 'health.pulse.live';
  const CARE_CONSENT = 'health.care.proactive';

  /**
   * 主题状态：偏好读 P.theme.preference()（与左栏那组三档开关同源），
   * 实际生效的配色交给 P.theme.dark()；读不到就降级为 null，不抛错。
   */
  function readTheme() {
    const themeApi = P.theme;
    let preference = null;
    if (themeApi && typeof themeApi.preference === 'function') {
      try {
        const value = themeApi.preference();
        if (typeof value === 'string' && THEME_KEYS.indexOf(value) >= 0) preference = value;
      } catch {
        preference = null;
      }
    }
    let scheme = null;
    if (themeApi && typeof themeApi.dark === 'function') {
      try { scheme = themeApi.dark() ? 'dark' : 'light'; } catch { scheme = null; }
    }
    if (!scheme) {
      const service = P.services && P.services.theme;
      if (service && typeof service.getTheme === 'function') {
        try {
          const snapshot = service.getTheme();
          const active = snapshot && snapshot.active && typeof snapshot.active === 'object' ? snapshot.active : null;
          if (active && typeof active.colorScheme === 'string') scheme = active.colorScheme;
        } catch {
          scheme = null;
        }
      }
    }
    if (!scheme && preference && preference !== 'system') scheme = preference;
    if (!scheme && typeof matchMedia === 'function') {
      try { scheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { scheme = null; }
    }
    return { preference, scheme };
  }

  /** 订阅宿主主题变化：左栏开关与本页共用同一个值，不各自维护状态。 */
  function useThemeState() {
    const [state, setState] = useState(readTheme);
    useEffect(() => {
      const themeApi = P.theme;
      if (!themeApi || typeof themeApi.subscribe !== 'function') return undefined;
      let unsubscribe = null;
      try {
        unsubscribe = themeApi.subscribe(() => setState(readTheme()));
      } catch {
        unsubscribe = null;
      }
      // 订阅建立后立刻对齐一次，别错过挂载与订阅之间的变化。
      setState(readTheme());
      return () => {
        if (typeof unsubscribe === 'function') {
          try { unsubscribe(); } catch { /* 退订失败不影响页面 */ }
        }
      };
    }, []);
    return [state, () => setState(readTheme())];
  }

  function probeText(target, payload) {
    const label = target === 'rerank' ? '重排序' : '向量';
    const data = payload && typeof payload === 'object' ? payload : {};
    if (data.ok !== false) {
      const bits = [`${label}端点正常`];
      const latency = Number(data.latencyMs);
      if (Number.isFinite(latency)) bits.push(`延迟 ${Math.round(latency)} ms`);
      if (data.model) bits.push(`模型 ${text(data.model)}`);
      const dimensions = Number(data.dimensions);
      if (Number.isFinite(dimensions) && dimensions > 0) bits.push(`维度 ${dimensions}`);
      return bits.join(' · ');
    }
    const code = text(data.error);
    const detail = PROBE_ERRORS[code] || (code ? `未知错误（${code}）` : '未知原因');
    const actual = Number(data.dimensions);
    if (code === 'dimension-mismatch' && Number.isFinite(actual) && actual > 0) {
      return `${label}端点连不上：${detail}。对方实际返回 ${actual} 维，把「向量维度」改成 ${actual} 再测一次。`;
    }
    return `${label}端点连不上：${detail}。`;
  }

  const MAINTENANCE_LABELS = { rebuild: '重建索引', integrity: '完整性检查', extract: '立即提炼' };

  function SettingsPage() {
    const notify = (message, tone) => {
      // 外壳只渲染 P.notice / P.toastOnce 推来的提示（ToastHost 挂在 Shell 上）。
      if (typeof P.notice === 'function') P.notice(message, tone || 'neutral');
    };
    const remote = P.useApi(() => api.get('settings'), []);
    const companion = P.useApi(() => api.get('companion'), []);

    const [draft, setDraft] = useState(null);
    const [dirty, setDirty] = useState([]);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState('');
    const [loadedAt, setLoadedAt] = useState(null);
    const [maint, setMaint] = useState(null);
    // 密钥只在浏览器内存里待一会儿：保存成功后立刻清空，绝不写进任何草稿对象。
    const [secretDraft, setSecretDraft] = useState({ embeddingApiKey: '', rerankApiKey: '' });
    const [secretBusy, setSecretBusy] = useState('');
    const [probe, setProbe] = useState(null);
    const [theme, refreshTheme] = useThemeState();
    // 健康与睡眠：真开关，读一次状态再渲染，写成功后回读（不做乐观置位）。
    const healthStatus = P.useApi(() => healthGet('status'), []);
    const healthCare = P.useApi(() => healthGet('care'), []);
    const [healthBusy, setHealthBusy] = useState('');
    const [healthNotice, setHealthNotice] = useState(null);

    const data = remote.data && typeof remote.data === 'object' ? remote.data : null;
    const editable = data && data.editable && typeof data.editable === 'object' ? data.editable : null;
    const keys = editable ? Object.keys(editable) : [];
    const secretsKeySet = {
      embeddingApiKey: Boolean(data && data.embeddingKeySet),
      rerankApiKey: Boolean(data && data.rerankKeySet),
    };

    // 数据到达（含保存后重新读取）时重建草稿并清空未保存标记。
    useEffect(() => {
      if (!editable) return;
      const next = {};
      for (const key of Object.keys(editable)) next[key] = editable[key];
      setDraft(next);
      setDirty([]);
      setLoadedAt(new Date().toISOString());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data]);

    const hasDirty = dirty.length > 0;
    const secretPending = Boolean(text(secretDraft.embeddingApiKey).trim() || text(secretDraft.rerankApiKey).trim());
    const locked = Boolean(busy);

    // 刷新 / 关闭窗口时拦一次：草稿和刚粘贴的密钥都还没落盘。
    useEffect(() => {
      if (!hasDirty && !secretPending) return undefined;
      const onBeforeUnload = event => {
        event.preventDefault();
        event.returnValue = '有还没保存的改动。';
        return '有还没保存的改动。';
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [hasDirty, secretPending]);

    const say = (tone, message) => {
      setNotice({ tone, message });
      if (tone === 'ok') notify(message, 'ok');
    };

    const fieldValue = key => {
      if (draft && Object.prototype.hasOwnProperty.call(draft, key)) return draft[key];
      if (editable && Object.prototype.hasOwnProperty.call(editable, key)) return editable[key];
      return '';
    };

    const setField = (key, value) => {
      setDraft(previous => {
        const next = { ...(previous || {}) };
        next[key] = value;
        return next;
      });
      setDirty(previous => (previous.indexOf(key) >= 0 ? previous : previous.concat(key)));
      setNotice(null);
    };

    const buildPatch = () => {
      const patch = {};
      const errors = [];
      for (const key of dirty) {
        // 只提交白名单里的键：本页没描述的字段永远不进 patch（也永远不会被整表覆盖）。
        const spec = FIELDS[key];
        if (!spec) continue;
        const raw = fieldValue(key);
        if (spec.control === 'toggle') {
          patch[key] = Boolean(raw);
          continue;
        }
        if (spec.control === 'select') {
          const fallback = spec.options && spec.options[0] ? spec.options[0].value : '';
          patch[key] = text(raw) || fallback;
          continue;
        }
        if (spec.control === 'integer' || spec.control === 'number') {
          const trimmed = text(raw).trim();
          if (!trimmed) {
            errors.push(`${spec.label} 不能为空`);
            continue;
          }
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed)) {
            errors.push(`${spec.label} 必须是数字`);
            continue;
          }
          if (spec.control === 'integer' && !Number.isInteger(parsed)) {
            errors.push(`${spec.label} 必须是整数`);
            continue;
          }
          if (spec.min !== undefined && parsed < spec.min) {
            errors.push(`${spec.label} 不能小于 ${spec.min}`);
            continue;
          }
          if (spec.max !== undefined && parsed > spec.max) {
            errors.push(`${spec.label} 不能大于 ${spec.max}`);
            continue;
          }
          patch[key] = parsed;
          continue;
        }
        const value = text(raw).trim();
        if (spec.control === 'url') {
          if (value.length > 500) {
            errors.push(`${spec.label} 太长了（最多 500 字符）`);
            continue;
          }
          if (value && !/^https?:\/\/\S+$/i.test(value)) {
            errors.push(`${spec.label} 必须以 http:// 或 https:// 开头，并且不含空格`);
            continue;
          }
          patch[key] = value;
          continue;
        }
        if (value.length > 200) {
          errors.push(`${spec.label} 太长了（最多 200 字符）`);
          continue;
        }
        patch[key] = value;
      }
      return { patch, errors };
    };

    // 后端会做同一组跨字段校验，这里先拦一次，省得白跑一趟。
    const crossChecks = () => {
      const problems = [];
      if (text(fieldValue('embeddingProvider')) === 'remote') {
        if (!text(fieldValue('embeddingBaseUrl')).trim()) problems.push('向量提供器选了 remote，必须填 API 地址');
        if (!text(fieldValue('embeddingModel')).trim()) problems.push('向量提供器选了 remote，必须填模型名');
      }
      if (isOn(fieldValue('rerankEnabled'))) {
        if (!text(fieldValue('rerankBaseUrl')).trim()) problems.push('启用重排序必须填 API 地址');
        if (!text(fieldValue('rerankModel')).trim()) problems.push('启用重排序必须填模型名');
      }
      return problems;
    };

    const save = () => {
      if (locked || !hasDirty) return;
      const built = buildPatch();
      if (built.errors.length) {
        setNotice({ tone: 'danger', message: `没有保存：${built.errors.join('；')}。改动都还留在页面上。` });
        return;
      }
      const problems = crossChecks();
      if (problems.length) {
        setNotice({ tone: 'danger', message: `没有保存：${problems.join('；')}。` });
        return;
      }
      const patch = built.patch;
      const currentBackend = text(editable && editable.backend);
      if (patch.backend === 'legacy' && currentBackend !== 'legacy') {
        const proceed = typeof P.confirm === 'function'
          ? P.confirm('确认把存储后端切回 legacy？\n\n新的 SQLite 记忆库里的记忆、修订与向量都不会同步回旧 JSON；切换后检索和提炼的结果都会变。建议先备份配置文件与记忆库文件。')
          : false;
        if (!proceed) return;
      }
      setBusy('save');
      setNotice(null);
      api.post('settings', { patch }).then(result => {
        if (result && result.ok === false) {
          setNotice({ tone: 'danger', message: `保存失败：${text(result.error || result.message) || '后端拒绝了这次写入'}。改动都还留在页面上。` });
          return;
        }
        const changed = result && Array.isArray(result.changed) ? result.changed : Object.keys(patch);
        const labels = changed.map(key => (FIELDS[key] ? FIELDS[key].label : text(key)));
        say('ok', `已写入 ${labels.length ? labels.join('、') : '（没有实际变化）'}；重启桌面后生效。`);
        remote.reload();
      }, error => {
        setNotice({
          tone: 'danger',
          message: `保存失败：${failText(error)}。改动都还留在页面上。`,
        });
      }).then(() => setBusy(''));
    };

    const reloadSafely = () => {
      if (hasDirty) {
        const proceed = typeof P.confirm === 'function'
          ? P.confirm('还有没保存的改动，重新读取会丢掉它们。继续？')
          : false;
        if (!proceed) return;
      }
      remote.reload();
    };

    const setSecretField = (field, value) => {
      setSecretDraft(previous => ({ ...previous, [field]: value }));
      setNotice(null);
    };

    // 密钥走单独的 patch：空串 = 不改，null = 清除；后端直接写 remote-models.json。
    const saveSecrets = entries => {
      if (locked || secretBusy) return;
      const patch = {};
      for (const [key, value] of Object.entries(entries || {})) {
        if (value === null) patch[key] = null;
        else if (typeof value === 'string' && value.trim()) patch[key] = value.trim();
      }
      if (!Object.keys(patch).length) {
        say('warn', '先在输入框里粘贴 API Key（留空不会提交）。');
        return;
      }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) continue;
        if (/\s/.test(value)) {
          setNotice({ tone: 'danger', message: `${SECRET_LABELS[key]} 不能包含空白字符。` });
          return;
        }
        if (value.length < API_KEY_MIN || value.length > API_KEY_MAX) {
          setNotice({ tone: 'danger', message: `${SECRET_LABELS[key]} 长度必须在 ${API_KEY_MIN}–${API_KEY_MAX} 之间。` });
          return;
        }
      }
      setSecretBusy('save');
      setNotice(null);
      api.post('settings', { patch }).then(result => {
        if (result && result.ok === false) {
          setNotice({ tone: 'danger', message: `密钥没存下：${text(result.error || result.message) || '后端拒绝了这次写入'}。` });
          return;
        }
        setSecretDraft({ embeddingApiKey: '', rerankApiKey: '' });
        say('ok', '密钥已写入本机的 remote-models.json；重启桌面后生效。');
        remote.reload();
      }, error => {
        setNotice({ tone: 'danger', message: `密钥没存下：${failText(error)}。` });
      }).then(() => setSecretBusy(''));
    };

    const clearSecret = (target, field) => {
      const proceed = typeof P.confirm === 'function'
        ? P.confirm(`清除${SECRET_LABELS[field]}？\n\n清除后远端${target === 'rerank' ? '重排序' : '向量'}调用会失败（降级或直接跳过），重启后生效。`)
        : false;
      if (proceed) saveSecrets({ [field]: null });
    };

    const canProbe = target => {
      const baseUrlKey = target === 'rerank' ? 'rerankBaseUrl' : 'embeddingBaseUrl';
      const modelKey = target === 'rerank' ? 'rerankModel' : 'embeddingModel';
      return Boolean(text(fieldValue(baseUrlKey)).trim() && text(fieldValue(modelKey)).trim());
    };

    // 探测带上当前草稿（含刚粘贴还没保存的 key），可以先测通再保存。
    const runProbe = target => {
      if (locked || secretBusy || (probe && probe.pending)) return;
      const numeric = key => {
        const parsed = Number(text(fieldValue(key)));
        return Number.isFinite(parsed) ? parsed : null;
      };
      const payload = {
        // 探测永远按远端端点跑：本地哈希向量没有可探测的网络地址。
        provider: 'remote',
        baseUrl: text(fieldValue(target === 'rerank' ? 'rerankBaseUrl' : 'embeddingBaseUrl')).trim(),
        model: text(fieldValue(target === 'rerank' ? 'rerankModel' : 'embeddingModel')).trim(),
      };
      if (target === 'embedding') {
        const dimensions = numeric('embeddingDimensions');
        if (dimensions) payload.dimensions = dimensions;
        const typed = text(secretDraft.embeddingApiKey).trim();
        if (typed) payload.apiKey = typed;
      } else {
        const timeoutMs = numeric('rerankTimeoutMs');
        if (timeoutMs) payload.timeoutMs = timeoutMs;
        const topN = numeric('rerankTopN');
        if (topN !== null) payload.topN = topN;
        const blend = numeric('rerankBlend');
        if (blend !== null) payload.blend = blend;
        const typed = text(secretDraft.rerankApiKey).trim();
        if (typed) payload.apiKey = typed;
      }
      setProbe({ target, pending: true, ok: null, text: '' });
      api.post('settings/test', { target, draft: payload }).then(result => {
        setProbe({ target, pending: false, ok: !(result && result.ok === false), text: probeText(target, result) });
      }, error => {
        setProbe({
          target,
          pending: false,
          ok: false,
          text: `探测没能完成：${failText(error)}。`,
        });
      });
    };

    // 维护动作直接作用于当前记忆库；失败原因原样显示，不做静默成功。
    const runMaintenance = action => {
      if (locked) return;
      setBusy(action);
      setMaint(null);
      setNotice(null);
      api.post('maintenance', { action }).then(result => {
        if (result && result.ok === false) {
          setMaint({ action, ok: false, message: text(result.error || result.message) || '后端拒绝了这次维护' });
          return;
        }
        setMaint({ action, ok: true, receipt: result && result.result ? result.result : result });
        say('ok', `${MAINTENANCE_LABELS[action] || action}完成。`);
      }, error => {
        setMaint({ action, ok: false, message: failText(error) });
      }).then(() => setBusy(''));
    };

    const confirmRebuild = () => {
      const proceed = typeof P.confirm === 'function'
        ? P.confirm('重建检索索引、补齐向量并重编译 Wiki？\n\n这会写入记忆库，期间检索结果可能短暂不完整；耗时随库大小增长。')
        : false;
      if (proceed) runMaintenance('rebuild');
    };

    const applyTheme = id => {
      const service = P.services && P.services.theme;
      if (!service || typeof service.setTheme !== 'function') return;
      let ok = false;
      try {
        // 优先走 P.theme.set：它同时写 localStorage 并通知订阅者，和左栏那组开关同源。
        ok = typeof P.theme.set === 'function' ? P.theme.set(id) : false;
        if (!ok) {
          service.setTheme(id);
          ok = true;
        }
      } catch (error) {
        refreshTheme();
        setNotice({ tone: 'danger', message: `切换外观失败：${P.failText(error, '宿主拒绝了这次切换')}` });
        return;
      }
      refreshTheme();
      if (ok) notify(`外观已切换为「${THEME_LABELS[id] || id}」。`, 'ok');
    };

    const goConnections = () => {
      const nav = P.nav;
      if (!nav || typeof nav.go !== 'function') return;
      try { nav.go('connections'); } catch { setNotice({ tone: 'danger', message: '外壳没有「连接与工具」页，暂时跳不过去。' }); }
    };

    // -- 表单控件 -------------------------------------------------------------

    const controlFor = key => {
      const spec = FIELDS[key];
      const value = fieldValue(key);
      if (spec.control === 'toggle') {
        return h(ui.Toggle, {
          checked: isOn(value),
          label: isOn(value) ? '已开启' : '已关闭',
          disabled: locked,
          onChange: next => setField(key, Boolean(next)),
        });
      }
      if (spec.control === 'select') {
        return h(ui.Select, {
          value: text(value),
          options: spec.options || [],
          disabled: locked,
          ariaLabel: spec.label,
          onChange: next => setField(key, text(next)),
        });
      }
      if (spec.control === 'integer' || spec.control === 'number') {
        return h(ui.Input, {
          type: 'number',
          value: text(value),
          width: '140px',
          disabled: locked,
          ariaLabel: spec.label,
          onChange: next => setField(key, text(next)),
        });
      }
      return h(ui.Input, {
        value: text(value),
        placeholder: spec.placeholder || '',
        disabled: locked,
        ariaLabel: spec.label,
        onChange: next => setField(key, text(next)),
      });
    };

    const fieldRow = key => {
      const spec = FIELDS[key];
      const changed = dirty.indexOf(key) >= 0;
      return h('div', { key, className: 'cpxp-set-field', 'data-dirty': changed ? 'true' : 'false' },
        h(ui.Field, {
          label: spec.label,
          hint: changed ? (spec.hint ? `${spec.hint} · 未保存` : '未保存') : spec.hint,
        }, controlFor(key)));
    };

    // -- 密钥行 ---------------------------------------------------------------

    const secretRow = (target, field) => {
      const label = SECRET_LABELS[field];
      const isSet = secretsKeySet[field];
      const active = probe && probe.target === target ? probe : null;
      const draftValue = secretDraft[field] || '';
      const busyHere = Boolean(locked || secretBusy);
      return h('div', { key: `secret-${target}`, className: 'cpxp-set-field', 'data-dirty': 'false' },
        h(ui.Field, {
          label: `${label}（只写不读）`,
          hint: '密钥只存本机，接口只回「是否已配置」，界面不回显、不预填。',
        },
          h('div', { className: 'cpxp-set-inline' },
            h(ui.Input, {
              type: 'password',
              value: draftValue,
              width: '220px',
              placeholder: isSet ? '已配置（不显示内容）' : '粘贴 API Key',
              disabled: busyHere,
              ariaLabel: label,
              onChange: value => setSecretField(field, value),
              onEnter: () => saveSecrets({ [field]: draftValue }),
            }),
            h('span', { className: 'cpxp-set-secret', 'data-set': isSet ? 'true' : 'false' }, isSet ? '已配置' : '未配置'),
            h(ui.Button, {
              size: 'sm',
              disabled: busyHere || !text(draftValue).trim(),
              loading: secretBusy === 'save',
              onClick: () => saveSecrets({ [field]: draftValue }),
            }, '保存密钥'),
            isSet ? h(ui.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: busyHere,
              onClick: () => clearSecret(target, field),
            }, '清除') : null,
            h(ui.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: busyHere || (!canProbe(target) && !(active && active.pending)),
              loading: Boolean(active && active.pending),
              title: canProbe(target) ? '发一个最小的真实请求验证端点' : '先填好 API 地址与模型名才能测',
              onClick: () => runProbe(target),
            }, '测试连接'))),
        active && active.pending ? h('p', { className: 'cpxp-set-note' }, '正在测试连接…') : null,
        active && !active.pending
          ? h(ui.Callout, {
            tone: active.ok ? 'ok' : 'danger',
            title: active.ok ? '端点可用' : '端点没通过',
            action: h(ui.Button, { variant: 'ghost', size: 'sm', disabled: busyHere, onClick: () => runProbe(target) }, '再测一次'),
          }, active.text)
          : null);
    };

    // -- 分区 -----------------------------------------------------------------

    const renderAppearance = () => {
      const service = P.services && P.services.theme;
      const canSet = Boolean(service && typeof service.setTheme === 'function');
      // 每次渲染都从 P.theme 现读一次偏好：即使订阅链路出问题，切换页面回来也是对的。
      let preference = theme && theme.preference ? theme.preference : null;
      try {
        if (P.theme && typeof P.theme.preference === 'function') {
          const live = P.theme.preference();
          if (typeof live === 'string' && THEME_KEYS.indexOf(live) >= 0) preference = live;
        }
      } catch { /* 读不到就沿用订阅状态 */ }
      const scheme = theme && theme.scheme ? theme.scheme : null;
      const schemeText = SCHEME_LABELS[scheme] || '—';
      const currentText = preference
        ? (preference === 'system'
          ? `当前生效：${schemeText}（跟随系统）`
          : `当前生效：${schemeText}（手动固定）`)
        : '当前生效：读不到宿主主题状态。';
      const segmented = h(ui.Segmented, {
        options: THEME_OPTIONS,
        value: preference || 'system',
        label: '主题',
        onChange: canSet ? applyTheme : undefined,
      });
      return h(ui.Band, {
        title: '外观',
        hint: '不需要重启',
        info: '只影响这个面板的配色；和左栏底部那组三档是同一个值（P.theme 同步）。',
        children: [
          h(ui.Field, { key: 'theme', label: '主题', hint: currentText },
            canSet
              ? h('div', { className: 'cpxp-set-inline' }, segmented)
              : h('div', { className: 'cpxp-set-disabled', 'aria-disabled': 'true' }, segmented)),
          canSet
            ? null
            : h(ui.Callout, {
              key: 'theme-state',
              tone: 'warn',
              title: '宿主主题服务不可用，这组开关已禁用',
            }),
        ],
      });
    };

    const renderRole = () => {
      const companionData = companion.data && typeof companion.data === 'object' ? companion.data : null;
      const runtime = companionData && companionData.runtime && typeof companionData.runtime === 'object'
        ? companionData.runtime
        : null;
      const persona = companionData ? text(companionData.persona) : '';
      const runtimeKnown = Boolean(runtime);
      const available = runtime && runtime.available === true;
      return h(ui.Band, {
        title: '角色',
        hint: '只读',
        info: '角色身份由宿主绑定（owner 视角），本页不提供改名或切换；人设、语气、关系都不在记忆引擎的配置白名单里。运行库的开关在下面「生活与运行库」里只读展示。',
        children: [
          companion.error
            ? h(ui.Callout, {
              key: 'role-error',
              tone: 'warn',
              title: '读不到角色状态',
              action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: companion.reload }, '重试'),
            }, companion.error instanceof Error ? companion.error.message : String(companion.error))
            : null,
          !companion.error && companion.loading && !companionData
            ? h(ui.Skeleton, { key: 'role-loading', rows: 2 })
            : null,
          h('div', { key: 'role', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, { label: '角色标识' },
              h('code', { className: 'cpxp-set-mono' }, persona || '—'))),
          h('div', { key: 'role-runtime', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, { label: '陪伴运行库' },
              h(ui.Badge, { tone: runtimeKnown ? (available ? 'ok' : 'warn') : 'neutral' },
                runtimeKnown ? (available ? '可读' : '不可读') : '未知'))),
        ],
      });
    };

    // -- 记忆与档案：21 个白名单键按六小组归位 --------------------------------

    const MEMORY_GROUPS = [
      { id: 'storage', title: '存储', keys: ['backend'] },
      { id: 'extract', title: '提炼', keys: ['extractionEnabled', 'minMessages'] },
      {
        id: 'retrieval',
        title: '检索',
        keys: ['semanticEnabled', 'topK', 'budgetChars', 'rrfK', 'mmrLambda', 'coverageFloor'],
      },
      { id: 'embedding', title: '向量（embedding）', keys: ['embeddingProvider', 'embeddingBaseUrl', 'embeddingModel', 'embeddingDimensions'] },
      {
        id: 'rerank',
        title: '重排（rerank）',
        keys: ['rerankEnabled', 'rerankBaseUrl', 'rerankModel', 'rerankTimeoutMs', 'rerankTopN', 'rerankBlend'],
      },
      { id: 'wiki', title: 'Wiki', keys: ['wikiAutoCompile', 'wikiMaxEntriesPerTopic'] },
    ];

    const renderMemoryArchive = () => {
      const known = Object.keys(FIELDS);
      const placed = [].concat(...MEMORY_GROUPS.map(group => group.keys));
      // 防御：真出现未归组的新白名单键，也别让它在页面上消失。
      const leftovers = known.filter(key => placed.indexOf(key) < 0);
      const groups = leftovers.length
        ? MEMORY_GROUPS.concat([{ id: 'other', title: '其它', keys: leftovers }])
        : MEMORY_GROUPS;
      return h(ui.Band, {
        title: '记忆与档案',
        hint: '重启后生效',
        info: '记忆引擎的 21 个可写项，按存储 / 提炼 / 检索 / 向量 / 重排 / Wiki 排；写入 memory.config.json，重启桌面后生效。对话模型与推理强度不在白名单里，本页读不到也改不了。',
        children: [].concat(...groups.map(group => [
          h('p', { key: `mem-sub-${group.id}`, className: 'cpxp-set-sub' }, group.title),
          ...group.keys.map(fieldRow),
          group.id === 'embedding' ? secretRow('embedding', 'embeddingApiKey') : null,
          group.id === 'rerank' ? secretRow('rerank', 'rerankApiKey') : null,
        ]).filter(Boolean)),
      });
    };

    // -- 健康与睡眠：真开关（POST api/companion-health/*）---------------------

    const AUTH_LABELS = {
      valid: '鉴权有效',
      expiring: '即将过期',
      expired: '已过期',
      unknown: '未知',
      required: '需要重新授权',
    };

    const runHealth = (label, request, done) => {
      if (healthBusy) return;
      setHealthBusy(label);
      setHealthNotice(null);
      request().then(result => {
        setHealthNotice({ tone: 'ok', text: done ? done(result) : `${label}已完成。` });
        // 回读：以服务端为准，不做乐观置位。
        healthStatus.reload();
        healthCare.reload();
      }, error => {
        setHealthNotice({ tone: 'danger', text: `${label}没有成功：${failText(error)}` });
      }).then(() => setHealthBusy(''));
    };

    const renderHealthSection = () => {
      const status = healthStatus.data && typeof healthStatus.data === 'object' ? healthStatus.data : null;
      const care = healthCare.data && typeof healthCare.data === 'object' ? healthCare.data : null;
      const collectorOn = consentOf(status, COLLECTOR_CONSENT);
      const pulseOn = consentOf(status, PULSE_CONSENT);
      const careOn = consentOf(status, CARE_CONSENT);
      const collector = status && status.collector && typeof status.collector === 'object' ? status.collector : null;
      const source = status && status.source && typeof status.source === 'object' ? status.source : null;
      const auth = source && source.auth && typeof source.auth === 'object' ? source.auth : null;
      const reason = healthStatus.error ? failText(healthStatus.error) : '';
      const busyHere = Boolean(healthBusy);
      const switchable = !reason && !busyHere;
      const stateText = value => (value === true ? '已启用' : value === false ? '未启用' : '未知');

      return h(ui.Band, {
        title: '健康与睡眠',
        hint: '真开关，写完整回读',
        info: '数据采集写 health.connect 授权（POST maintenance pause/resume），实时心率写 health.pulse.live（POST pulse consent）；主动关怀目前没有写入接口，只能看。这两个开关和「健康与睡眠」页是同一套接口，改哪边都一样。',
        children: [
          reason
            ? h(ui.Callout, {
              key: 'health-error',
              tone: 'warn',
              title: '读不到健康服务，开关先禁用',
              action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: () => { healthStatus.reload(); healthCare.reload(); } }, '重试'),
            }, reason)
            : null,
          healthNotice
            ? h(ui.Callout, {
              key: 'health-notice',
              tone: healthNotice.tone === 'danger' ? 'danger' : 'ok',
              title: healthNotice.tone === 'danger' ? '这一步没成功' : '已生效',
            }, healthNotice.text)
            : null,
          healthStatus.loading && !status
            ? h(ui.Skeleton, { key: 'health-loading', rows: 3 })
            : null,
          h('div', { key: 'health-collector', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, {
              label: '数据采集',
              hint: collector
                ? `配置：${stateText(collectorOn)} · 采集器：${collector.running === true ? '运行中' : '已停止'}`
                : `配置：${stateText(collectorOn)}`,
            },
            h(ui.Toggle, {
              checked: collectorOn === true,
              disabled: !switchable,
              label: '启用采集',
              onChange: next => runHealth(
                next ? '恢复采集' : '暂停采集',
                () => healthPost('maintenance', { action: next ? 'resume' : 'pause' }),
                () => (next ? '已恢复采集。' : '已暂停采集。'),
              ),
            }))),
          h('div', { key: 'health-pulse', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, { label: '实时心率读取', hint: `当前：${stateText(pulseOn)}` },
              h(ui.Toggle, {
                checked: pulseOn === true,
                disabled: !switchable,
                label: '允许读取实时心率',
                onChange: next => runHealth(
                  next ? '打开实时心率' : '关闭实时心率',
                  () => healthPost('pulse', { action: 'consent', consent: next === true }),
                  () => (next ? '已打开实时心率读取。' : '已关闭实时心率读取。'),
                ),
              }))),
          h('div', { key: 'health-care', className: 'cpxp-set-field', 'data-dirty': 'false' },
            h(ui.Field, { label: '主动关怀', hint: '这个开关没有写入接口，只能看' },
              h(ui.StateLine, {
                state: careOn === true ? 'ok' : careOn === false ? 'idle' : 'warn',
                text: stateText(careOn) + (care && care.enabled === true ? '（本轮已开启）' : ''),
              }))),
          h(ui.List, { key: 'health-readonly', label: '健康服务只读状态' }, [
            h(ui.Row, {
              key: 'health-source',
              title: '数据来源',
              meta: '配置文件里的 adapter 开关，本页只读',
              side: source
                ? h(ui.Badge, { tone: source.enabled === true ? 'ok' : 'neutral' }, text(source.displayName) || '—')
                : h(ui.Badge, { tone: 'neutral' }, '未知'),
            }),
            h(ui.Row, {
              key: 'health-auth',
              title: '云端鉴权',
              meta: '过期后需要重新授权',
              side: auth
                ? h(ui.Badge, { tone: auth.status === 'valid' ? 'ok' : auth.status === 'expired' ? 'danger' : 'warn' },
                  AUTH_LABELS[auth.status] || text(auth.status) || '未知')
                : h(ui.Badge, { tone: 'neutral' }, '未知'),
            }),
            h(ui.Row, {
              key: 'health-sync',
              title: '最近成功同步',
              meta: source && source.lastErrorCode ? `最近错误：${text(source.lastErrorCode)}` : '',
              side: source && source.lastSuccessAt
                ? h(ui.Timestamp, { at: source.lastSuccessAt })
                : h('span', { className: 'cpxp-set-note' }, '—'),
            }),
          ]),
        ],
      });
    };

    // -- 生活与运行库：只读（没有写入接口）-----------------------------------

    const renderRuntime = () => {
      const companionData = companion.data && typeof companion.data === 'object' ? companion.data : null;
      const runtime = companionData && companionData.runtime && typeof companionData.runtime === 'object' ? companionData.runtime : null;
      const switches = companionData && companionData.life && companionData.life.switches && typeof companionData.life.switches === 'object'
        ? companionData.life.switches
        : null;
      const mark = value => (value === true
        ? h(ui.Badge, { tone: 'ok' }, '已启用')
        : value === false
          ? h(ui.Badge, { tone: 'neutral' }, '未启用')
          : h(ui.Badge, { tone: 'neutral' }, '未知'));
      return h(ui.Band, {
        title: '生活与运行库',
        hint: '只读，没有写入接口',
        info: '运行库的 enabled / mode / 自主规划 / 心跳 / 分享都写在 home/companion/runtime.config.json 里，studio 没有写入接口，所以这里只显示当前值，不做成 disabled 开关冒充配置项。',
        children: [
          companion.error
            ? h(ui.Callout, {
              key: 'runtime-error',
              tone: 'warn',
              title: '读不到运行库状态',
              action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: companion.reload }, '重试'),
            }, failText(companion.error))
            : null,
          h(ui.List, { key: 'runtime-list', label: '运行库配置（只读）' }, [
            h(ui.Row, {
              key: 'runtime-enabled',
              title: '运行库总开关',
              meta: '配置项；开着不代表进程正在跑',
              side: mark(runtime ? runtime.enabled : null),
            }),
            h(ui.Row, {
              key: 'runtime-mode',
              title: '运行模式',
              side: h('span', { className: 'cpxp-set-mono' }, runtime ? text(runtime.mode) || '—' : '—'),
            }),
            h(ui.Row, {
              key: 'runtime-planning',
              title: '自主规划（日程）',
              meta: '关掉以后不会自己排日程',
              side: mark(switches ? switches.planning : null),
            }),
            h(ui.Row, {
              key: 'runtime-heartbeat',
              title: '心跳规则',
              meta: '定期自查的节奏',
              side: mark(runtime ? runtime.heartbeat : null),
            }),
            h(ui.Row, {
              key: 'runtime-share',
              title: '分享候选',
              meta: '交给联系通道处理',
              side: mark(switches ? switches.share : null),
            }),
          ]),
        ],
      });
    };

    const renderConnections = () => {
      const companionData = companion.data && typeof companion.data === 'object' ? companion.data : null;
      const runtime = companionData && companionData.runtime && typeof companionData.runtime === 'object' ? companionData.runtime : null;
      const media = companionData && companionData.media && typeof companionData.media === 'object' ? companionData.media : null;
      const contact = companionData && companionData.contact && typeof companionData.contact === 'object' ? companionData.contact : null;
      const mediaRow = (key, label) => h(ui.Row, {
        key: `media-${key}`,
        title: label,
        side: media ? h(ui.Badge, { tone: media[key] ? 'ok' : 'neutral' }, media[key] ? '已启用' : '未启用') : h(ui.Badge, { tone: 'neutral' }, '未配置'),
      });
      const navReady = Boolean(P.nav && typeof P.nav.go === 'function');
      return h(ui.Band, {
        title: '连接与工具',
        hint: '只读，没有写入接口',
        info: '这里显示运行库配置里的媒体、QQ 投递与记忆桥接状态；「连接与工具」里也只读展示，本页不修改它们，也不会代为发送任何消息。「已启用」只说明配置开着，不说明这条通道此刻可用。',
        actions: [
          h(ui.Button, {
            key: 'go-connections',
            variant: 'ghost',
            size: 'sm',
            disabled: !navReady,
            title: navReady ? '打开「连接与工具」（只读）' : '外壳还没提供导航服务',
            onClick: goConnections,
          }, '查看连接状态'),
        ],
        children: [
          h(ui.List, { key: 'media-list', label: '媒体能力' }, [
            mediaRow('enabled', '媒体总开关'),
            mediaRow('vision', '图片理解'),
            mediaRow('speech', '语音'),
            mediaRow('image', '生图'),
            mediaRow('screen', '屏幕'),
          ]),
          h(ui.List, { key: 'channel-list', label: '通道与桥接' }, [
            h(ui.Row, {
              key: 'bridge',
              title: '记忆桥接',
              meta: '配置开关，不代表正在同步',
              side: runtime
                ? h(ui.Badge, { tone: runtime.bridge ? 'ok' : 'neutral' }, runtime.bridge ? '已启用' : '未启用')
                : h(ui.Badge, { tone: 'neutral' }, '未知'),
            }),
            h(ui.Row, {
              key: 'qq',
              title: 'QQ 投递计数',
              meta: contact
                ? `今天已发 ${text(contact.sentToday) || '0'} 条 · 连续未回 ${text(contact.unanswered) || '0'} 次`
                : '还没有投递记录（通道可能未接入）',
              side: contact && contact.lastSentAt
                ? h(ui.Timestamp, { at: contact.lastSentAt, prefix: '最近 ' })
                : h('span', { className: 'cpxp-set-note' }, '—'),
            }),
          ]),
        ],
      });
    };

    const renderAdvanced = () => {
      const otherKeys = keys.filter(key => !Object.prototype.hasOwnProperty.call(FIELDS, key)
        && !Object.prototype.hasOwnProperty.call(SECRET_LABELS, key));
      const pathMap = Object.keys(FIELDS)
        .filter(key => typeof FIELDS[key].path === 'string')
        .map(key => `${key}  →  ${FIELDS[key].path}`)
        .join('\n');
      const rawEditable = editable ? JSON.stringify(editable, null, 2) : '—';
      const receipt = maint && maint.receipt ? maint.receipt : null;
      return h(ui.Band, {
        title: '高级',
        hint: '危险操作需确认',
        info: '维护动作与原始配置都在这里。重建索引会写数据库并二次确认，完整性检查只读、不改数据；「立即提炼」需要会话上下文，在 studio 里恒不可用。存储后端在「记忆与档案 › 存储」里改。',
        children: [
          h(ui.Diagnostic, {
            key: 'storage',
            title: '维护与原始配置',
            children: [
              h(ui.Toolbar, { key: 'maint', label: '维护动作' }, [
                h(ui.Button, {
                  key: 'rebuild',
                  variant: 'danger',
                  size: 'sm',
                  disabled: locked,
                  loading: busy === 'rebuild',
                  onClick: confirmRebuild,
                }, '重建索引'),
                h(ui.Button, {
                  key: 'integrity',
                  variant: 'ghost',
                  size: 'sm',
                  disabled: locked,
                  loading: busy === 'integrity',
                  onClick: () => runMaintenance('integrity'),
                }, '完整性检查'),
                h(ui.Button, {
                  key: 'extract',
                  variant: 'ghost',
                  size: 'sm',
                  disabled: true,
                  title: '提炼需要会话上下文：studio 里没有对话，后端会直接拒绝（bad-request）',
                }, '立即提炼（不可用）'),
              ]),
              maint && !maint.ok
                ? h(ui.Callout, {
                  key: 'maint-error',
                  tone: 'danger',
                  title: `${MAINTENANCE_LABELS[maint.action] || maint.action}失败`,
                  action: h(ui.Button, {
                    variant: 'ghost',
                    size: 'sm',
                    disabled: locked,
                    onClick: () => runMaintenance(maint.action),
                  }, '重试'),
                }, maint.message)
                : null,
              maint && maint.ok
                ? h(ui.Callout, { key: 'maint-ok', tone: 'ok', title: `${MAINTENANCE_LABELS[maint.action] || maint.action}完成` },
                  h(ui.Pre, { maxHeight: '220px' },
                    typeof receipt === 'string' ? receipt : JSON.stringify(receipt, null, 2)))
                : null,
            ],
          }),
          h(ui.Diagnostic, {
            key: 'paths',
            title: '配置文件与白名单',
            hint: '仅白名单可写',
            children: [
              h(ui.KeyValue, {
                key: 'config-kv',
                items: [
                  { k: '配置文件', v: text(data && data.configPath) || '（未返回）', mono: true, breakable: true },
                  { k: '当前运行后端', v: text(data && data.backend) || '—', mono: true },
                  { k: '可写字段', v: `${fmt.number(keys.length)} 个（白名单）` },
                  { k: '待保存', v: hasDirty ? `${fmt.number(dirty.length)} 项` : '无' },
                  { k: '密钥状态', v: `${secretsKeySet.embeddingApiKey ? '向量已配置' : '向量未配置'} · ${secretsKeySet.rerankApiKey ? '重排已配置' : '重排未配置'}` },
                ],
              }),
              h(ui.Pre, { key: 'path-map', maxHeight: '220px' }, pathMap),
              otherKeys.length
                ? h('div', { key: 'other-keys' },
                  h('p', { className: 'cpxp-set-note' }, '未描述的白名单键（只读）：'),
                  h(ui.KeyValue, {
                    items: otherKeys.map(key => ({
                      k: key,
                      v: text(fieldValue(key)) || '—',
                      mono: true,
                      breakable: true,
                    })),
                  }))
                : null,
              h(ui.Pre, { key: 'editable-raw', maxHeight: '260px' }, rawEditable),
            ],
          }),
          h(ui.Diagnostic, {
            key: 'boundary',
            title: '安全边界',
            children: [
              h('p', { key: 'boundary-text', className: 'cpxp-set-note' },
                '浏览器不接受 userId / personaId / worldId 参数，所有查询都按宿主绑定的 owner 视角执行；'
                + '本页不展示记忆正文，也没有导出原始数据库或备份路径的入口。'),
            ],
          }),
        ],
      });
    };

    // -- 组装 -----------------------------------------------------------------

    const pageStatus = data
      ? [
        h(ui.Timestamp, { key: 'at', at: loadedAt, prefix: '配置读取于 ' }),
        ` · ${hasDirty ? `未保存 ${dirty.length} 项` : '没有未保存改动'} · 运行后端 ${text(data.backend) || '—'}`,
      ]
      : '正在读取配置…';

    const headProps = {
      title: '设置',
      lead: '改的是本机配置文件，密钥不回显。',
      actions: [
        h(ui.Button, {
          key: 'save',
          variant: 'primary',
          onClick: save,
          disabled: !hasDirty || locked,
          loading: busy === 'save',
          title: hasDirty ? '把所有未保存项一次性写入本机配置' : '没有未保存的改动',
        }, hasDirty ? `保存 ${dirty.length} 项改动` : '没有待保存改动'),
        h(ui.Button, {
          key: 'reload',
          variant: 'ghost',
          onClick: reloadSafely,
          disabled: locked || Boolean(remote.loading && data),
          loading: Boolean(remote.loading && !data),
        }, '重新读取'),
      ],
      status: pageStatus,
    };

    if (remote.error && !data) {
      return h(ui.Page, headProps, h(ui.ErrorBox, { error: remote.error, onRetry: remote.reload }));
    }
    if (remote.loading && !data) {
      return h(ui.Page, headProps, h(ui.Skeleton, { rows: 8 }));
    }
    if (!data || !editable) {
      return h(ui.Page, headProps, h(ui.Empty, {
        title: '没有可编辑的配置',
        hint: '可写字段是空的，引擎可能还没初始化。',
        action: h(ui.Button, { variant: 'ghost', onClick: remote.reload }, '重新读取'),
      }));
    }

    return h(ui.Page, headProps,
      remote.error
        ? h(ui.Callout, {
          key: 'stale',
          tone: 'warn',
          title: '这次刷新失败，下面是上一次读到的配置',
          action: h(ui.Button, { variant: 'ghost', size: 'sm', onClick: remote.reload }, '重试'),
        }, remote.error instanceof Error ? remote.error.message : String(remote.error))
        : null,
      notice
        ? h(ui.Callout, {
          key: 'notice',
          tone: notice.tone,
          title: notice.tone === 'danger' ? '这一步没成功' : notice.tone === 'warn' ? '还差一步' : '已生效（重启后）',
        }, notice.message)
        : null,
      data.restartRequiredHint === false
        ? null
        : h(ui.Callout, { key: 'restart', tone: 'info', title: '改动要重启桌面才生效' }, '保存成功不等于已生效。'),
      renderAppearance(),
      renderRole(),
      renderMemoryArchive(),
      renderHealthSection(),
      renderRuntime(),
      renderConnections(),
      renderAdvanced());
  }

  P.registerPage({ id: 'settings', label: '设置', order: 70, component: SettingsPage });
})(P);

// ==== src/client/pages-overview.js ====
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

    return { inject: ['slots', 'locale'], apply };
  },
});
