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
  { id: 'chat', label: '聊天', icon: 'chat', hint: '回复、延时、免打扰与群聊行为' },
  { id: 'persona', label: '人格', icon: 'heart', hint: '性格、语气与相处方式' },
  { id: 'qq-web', label: 'QQ 连接', icon: 'chat', hint: 'NapCat / SnowLuma 网页面板' },
  { id: 'life', label: '生活与日程', icon: 'calendar', hint: '今天、接下来，以及她的计划' },
  { id: 'health', label: '运动健康', icon: 'heart', hint: '活动、睡眠与实时心率' },
  { id: 'memory', label: '记忆与档案', icon: 'book', hint: '记忆库、Wiki、时间线与待核对', tabs: ['vault', 'wiki', 'timeline', 'review', 'microscope'] },
  { id: 'connections', label: '连接与工具', icon: 'plug', hint: '管理连接与工具' },
  { id: 'media', label: '媒体能力', icon: 'image', hint: '图片生成与语音合成' },
  { id: 'workspace', label: '工作区', icon: 'folder', hint: '回到文件、会话与开发现场' },
  { id: 'settings', label: '设置', icon: 'sliders', hint: '外观、角色、模型与记忆', tabs: ['settings', 'overview'] },
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
  post: async (path, payload) => {
    const result=await request(path, { method: 'POST', body: JSON.stringify(payload || {}) });
    if(result?.restartRequired===true||(Array.isArray(result?.restartRequired)&&result.restartRequired.length))window.dispatchEvent(new Event('companion:restart-required'));
    return result;
  },
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
  image: ['M4 4h16v16H4z','M4 15l5-5 5 5 3-3 3 3','M15 8h.01'],
  audio: ['M10 5a2 2 0 0 1 4 0v7a2 2 0 0 1-4 0z','M7 11v1a5 5 0 0 0 10 0v-1','M12 17v4','M9 21h6'],
  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z','M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'],
  heart: ['M20.8 9.2c0 4.5-8.8 10-8.8 10s-8.8-5.5-8.8-10a4.8 4.8 0 0 1 8.8-2.5 4.8 4.8 0 0 1 8.8 2.5z'],
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
  if (!text || /不编造|不等于|不会替|真实的|合同|演示数字|未知一律|接口失败|没有回执|只来自|只读：|来自本地留存|每 20 秒|只说明/.test(text)) return null;
  return h('span', { className: 'cpx-info', tabIndex: 0, role: 'img', 'aria-label': text, 'data-tip': text, title: label });
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

// `id` 必须落到真正的控件上：`ui.Field` 只负责 `<label htmlFor>`，点标签能不能聚焦
// 取决于控件自己的 id（2026-11-06 UI 审核：label.for 有值、控件 id 为空 → 点了没反应）。
function Input({ value, onChange, placeholder, onEnter, type, disabled, width, ariaLabel, id }) {
  return h('input', {
    id,
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

function TextArea({ value, onChange, rows, placeholder, monospace, disabled, ariaLabel, id }) {
  return h('textarea', {
    id,
    value: value ?? '',
    rows: rows || 4,
    placeholder,
    disabled: Boolean(disabled),
    'aria-label': ariaLabel || placeholder,
    className: cx('cmx-input', 'cmx-textarea', monospace ? 'cmx-mono' : ''),
    onChange: (event) => onChange && onChange(event.target.value),
  });
}

function Select({ value, onChange, options, width, disabled, ariaLabel, id }) {
  return h('select', {
    id,
    value: value ?? '',
    disabled: Boolean(disabled),
    'aria-label': ariaLabel,
    className: 'cmx-select',
    style: width ? { width } : undefined,
    onChange: (event) => onChange && onChange(event.target.value),
  }, (options || []).map((option) => h('option', { key: option.value, value: option.value }, option.label)));
}

function Toggle({ checked, onChange, label, hint, disabled, id }) {
  return h('label', { className: 'cmx-toggle' },
    h('input', {
      id,
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

function Field({ label, hint, info, children, id }) {
  return h('div', { className: 'cpx-field' },
    h('label', { className: 'cpx-field-label', htmlFor: id }, label, info ? h(Info, { text: info }) : null),
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
    id: 'qq', label: 'QQ连接状态', page: 'connections', probe: 'companion', source: 'GET companion · QQ连接',
    judge: ({data}) => {
      const qq=data?.qqConnection;
      if(!qq||typeof qq.connected!=='boolean')return {state:'unknown',note:'尚未读取到QQ连接状态'};
      if(!qq.connected)return {state:'down',note:'QQ连接已断开'};
      if(qq.online===false)return {state:'warn',note:'QQ账号未在线'};
      return {state:'ok',note:'QQ已连接'};
    },
  },
  {
    id: 'media', label: '媒体能力', page: 'media', probe: 'companion', source: 'GET companion · media',
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
.cmx-textarea { max-height:320px; max-width:100%; overflow:auto; resize:vertical; }
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

function Rail({ currentPage, collapsed, onToggle, compact, onCompact, compactAvailable }) {
  const page = currentPage;

  const activeNavId = React.useMemo(() => {
    const direct = NAV.find((item) => item.id === page);
    if (direct) return direct.id;
    const group = NAV.find((item) => Array.isArray(item.tabs) && item.tabs.includes(page));
    return group ? group.id : 'home';
  }, [page]);

  const groups = [
    { label: '陪伴', ids: ['home', 'chat', 'persona', 'qq-web', 'life', 'health'] },
    { label: '记录', ids: ['memory'] },
    { label: '工具', ids: ['connections', 'media', 'workspace'] },
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
      h('span', { className: 'cpx-brand-mark' }, h(Icon, { name: 'heart', size: 20 })),
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
    currentPage: page,
    collapsed,
    onToggle: () => setCollapsed((value) => !value),
    compact,
    onCompact: toggleCompact,
    compactAvailable: P.hostLayout.canToggle(),
  }),
  h('div', { className: 'cpx-drawer-backdrop', onClick: () => setDrawer(false), 'aria-hidden': 'true' }),
  h('main', { className: 'cpx-main', id: 'cpx-main', ref: mainRef, tabIndex: -1 },
    P.ui.RestartNotice?h(P.ui.RestartNotice):null,
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
P.css(`
/* Shared product polish: contained layout, legible actions and consistent surfaces. */
.cpx-root { min-width:0; width:100%; }
.cpx-app { width:100%; min-width:0; --cpx-fs-title:28px; --cpx-fs-section:19px; }
.cpx-scroll { padding-inline:0; scrollbar-gutter:stable; }
.cpx-page, .cpxp-page { width:100%; min-width:0; max-width:1280px; margin-inline:auto; padding:32px clamp(20px,3vw,48px) 80px; display:flex; flex-direction:column; gap:28px; }
.cpx-page-head, .cpxp-page-head { min-width:0; }
.cpx-title, .cpxp-page-title { font-size:28px; font-weight:650; letter-spacing:-.6px; }
.cpx-page-heading, .cpx-band-head > div, .cpxp-media-sec-head > div { min-width:0; }
.cpx-rail { min-width:0; overflow-x:hidden; background:var(--dsw-alias-bg-layer-1); }
.cpx-brand-mark { width:36px; height:36px; border:0; border-radius:12px; background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent); color:var(--dsw-alias-brand-primary); }
.cpx-brand-name { font-size:16px; letter-spacing:.1px; }
.cpx-nav-item { min-height:42px; border-radius:9px; }
.cpx-band { border-top:0; gap:18px; }
.cpx-app .cmx-btn { min-height:38px; padding:8px 16px; display:inline-flex; align-items:center; justify-content:center; gap:7px; border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; font-weight:600; cursor:pointer; transition:background .15s,border-color .15s; }
.cpx-app .cmx-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2)); }
.cpx-app .cmx-btn-primary { background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base,#15161c); border-color:var(--dsw-alias-brand-primary); }
.cpx-app .cmx-btn-primary:hover:not(:disabled) { background:color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,white); }
.cpx-app .cmx-btn:disabled { opacity:.42; cursor:default; }
.cpx-app .cmx-btn-sm { min-height:32px; padding:5px 11px; font-size:12px; }
.cpx-app .cmx-input,.cpx-app .cmx-select,.cpx-app .cmx-textarea { min-width:0; max-width:100%; border-radius:9px; min-height:42px; padding:10px 12px; font-size:14px; }
.cpx-field { min-width:0; }
.cpx-segmented { display:flex; flex-wrap:wrap; gap:4px; padding:4px; border:1px solid var(--dsw-alias-border-l1); border-radius:11px; background:var(--dsw-alias-bg-layer-1); width:fit-content; max-width:100%; }
.cpx-segment { border:0; border-radius:8px; padding:9px 18px; color:var(--dsw-alias-label-secondary); font:inherit; font-size:13px; cursor:pointer; background:transparent; }
.cpx-segment-active { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2)); box-shadow:0 1px 5px #0002; }
.cpx-health { padding:22px; border:1px solid var(--dsw-alias-border-l1); border-radius:16px; background:var(--dsw-alias-bg-layer-1); }
.cpx-health-grid { grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
.cpx-health-item { width:100%; min-height:105px; padding:16px; border-radius:12px; }
.cpx-health-name { font-size:14px; }
.cpx-health-head { margin-bottom:6px; }
@media(max-width:760px) { .cpx-page,.cpxp-page { padding:22px 16px 56px; gap:22px; } .cpx-health { padding:16px; } .cpx-health-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:420px) { .cpx-health-grid { grid-template-columns:1fr; } }
`);

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
