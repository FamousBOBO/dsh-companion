/**
 * What the migration CLI is allowed to move.
 *
 * A domain is a named group of files under the suite data directory. Each item
 * declares how it is copied (`sqlite`, `json`, `json-glob`, `tree`) and which
 * transform — if any — is applied on the way out. Transforms only ever *remove*
 * information; there is no transform that adds a credential back.
 *
 * The three lists at the bottom are the reason this file exists: they are the
 * machine-checked version of the rules in docs/04-migration.md. Asking for a
 * forbidden domain is an argument error (exit 2), not a warning.
 */

/** Domains exported unless the operator narrows the set with `--domains`. */
export const DEFAULT_DOMAINS = ['memory', 'runtime', 'identity', 'reminders', 'health', 'qq'];

/** Domains that only export when explicitly requested. */
export const OPTIONAL_DOMAINS = ['memory-wiki'];

/**
 * Never exportable, with no override flag. The names are accepted as arguments
 * only so the CLI can explain *why* they are refused instead of failing with
 * "unknown domain".
 */
export const FORBIDDEN_DOMAINS = [
  'credentials',
  'secrets',
  'auth',
  'sessions',
  'desktop-data',
  'logs',
  'media',
  'media-artifacts',
  'media-output',
  'cache',
  'node-modules',
  'venv',
  'bili-credentials',
];

/** Human explanation per forbidden domain, surfaced in the JSON error. */
export const FORBIDDEN_REASONS = {
  credentials: '凭据永不导出：迁移后重新登录 / 重新授权。',
  secrets: '密钥永不导出：迁移后重新填写。',
  auth: '登录态永不导出：迁移后重新扫码登录。',
  sessions: '宿主会话缓存是本机的，导出无意义且含聊天正文。',
  'desktop-data': 'Electron user-data 含登录态与缓存，永不导出。',
  logs: '日志可能含正文与个人标识，不随迁移包移动。',
  media: '媒体产物（图片 / 语音）不进迁移包，只迁移账本索引。',
  'media-artifacts': '媒体产物不进迁移包。',
  'media-output': '媒体产物不进迁移包。',
  cache: '缓存可重建，不进迁移包。',
  'node-modules': '依赖由 npm ci 重建。',
  venv: 'Python 虚拟环境由用户重建。',
  'bili-credentials': 'B 站登录凭证永不导出：迁移后重新扫码。',
};

/**
 * `from` paths are relative to the suite data directory (D2: `<dataRoot>/...`).
 * `to` is relative to the bundle root.
 */
export const DOMAIN_SPECS = {
  memory: {
    label: '长期记忆库',
    description: 'SQLite 记忆库（记忆、证据、修订链、向量）。',
    items: [
      {
        kind: 'sqlite',
        from: 'home/memory/companion-memory.db',
        to: 'domains/memory/companion-memory.db',
        required: false,
        countCandidates: ['memories', 'memory_records', 'memories_v2', 'memory_items'],
      },
    ],
  },
  'memory-wiki': {
    label: '编译后的记忆 Wiki',
    description: '由记忆库编译出的主题页；可重建，因此默认不导出。',
    items: [{ kind: 'tree', from: 'home/memory/wiki', to: 'domains/memory-wiki', required: false }],
  },
  runtime: {
    label: '认知运行时',
    description: '事件、目标、信念、工作记忆、日程、活动的 SQLite 库。',
    items: [
      {
        kind: 'sqlite',
        from: 'home/companion/companion-runtime.db',
        to: 'domains/runtime/companion-runtime.db',
        required: false,
        countCandidates: ['events', 'runtime_events', 'agenda_items', 'goals'],
      },
    ],
  },
  identity: {
    label: '身份绑定',
    description: '主人 / 人格绑定。导出时丢弃 per-host 的会话绑定。',
    items: [
      {
        kind: 'json',
        from: 'home/companion/identity.json',
        to: 'domains/identity/identity.json',
        transform: 'identity',
        required: false,
      },
    ],
  },
  reminders: {
    label: '提醒清单（只读档案）',
    description: '导出成清单供人核对；导入时一律置为已发并暂停，绝不补发。',
    items: [
      {
        kind: 'json',
        from: 'home/channel-qq/reminders.json',
        to: 'domains/reminders/reminders.json',
        transform: 'reminders',
        required: false,
      },
      {
        kind: 'json',
        from: 'workspace/reminders.json',
        to: 'domains/reminders/reminders.workspace.json',
        transform: 'reminders',
        required: false,
      },
    ],
  },
  health: {
    label: '健康派生数据',
    description: '只含派生统计（日汇总 / 基线 / 心跳会话），不含原始心搏曲线。',
    items: [
      {
        kind: 'sqlite',
        from: 'home/health/health.db',
        to: 'domains/health/health.db',
        required: false,
        countCandidates: ['health_pulse_sessions', 'health_daily', 'health_metrics'],
      },
    ],
  },
  qq: {
    label: 'QQ 去重集（无正文）',
    description: '已发送消息的 dedupe 键，只保留 messageId 与时间，用于人工核对外发历史。',
    items: [
      {
        kind: 'json-glob',
        from: 'home/channel-qq/sent-*.json',
        to: 'domains/qq/suppression.json',
        transform: 'suppression',
        required: false,
      },
    ],
  },
};

/**
 * Which domains the importer is allowed to write back. Everything else is an
 * archive for the operator to read.
 */
export const IMPORTABLE_DOMAINS = ['memory', 'memory-wiki', 'runtime', 'identity', 'reminders', 'health'];

/** Domains exported for audit only; import reports them in `notReplayed[]`. */
export const ARCHIVE_ONLY_DOMAINS = ['qq'];

/**
 * Where a bundle-relative file lands in the target data directory.
 * Exact matches win; prefixes cover the wiki tree.
 */
export const IMPORT_TARGETS = {
  'domains/memory/companion-memory.db': 'home/memory/companion-memory.db',
  'domains/runtime/companion-runtime.db': 'home/companion/companion-runtime.db',
  'domains/health/health.db': 'home/health/health.db',
  'domains/identity/identity.json': 'home/companion/identity.json',
  'domains/reminders/reminders.json': 'home/channel-qq/reminders.json',
  'domains/reminders/reminders.workspace.json': 'workspace/reminders.json',
};

export const IMPORT_TARGET_PREFIXES = {
  'domains/memory-wiki/': 'home/memory/wiki/',
};

/** Map a bundle-relative path to a target path relative to the data root. */
export function resolveImportTarget(bundleRelative) {
  if (IMPORT_TARGETS[bundleRelative]) return IMPORT_TARGETS[bundleRelative];
  for (const [prefix, target] of Object.entries(IMPORT_TARGET_PREFIXES)) {
    if (bundleRelative.startsWith(prefix)) return target + bundleRelative.slice(prefix.length);
  }
  return null;
}

/** Normalise a `--domains a,b,c` argument. */
export function parseDomainList(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const list = String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

/**
 * Validate a requested domain list.
 * @returns {{ok:true, domains:string[]} | {ok:false, code:'forbidden-domain'|'unknown-domain', message:string, domain:string}}
 */
export function validateDomains(requested) {
  const known = new Set([...Object.keys(DOMAIN_SPECS)]);
  const forbidden = new Set(FORBIDDEN_DOMAINS);
  const domains = [];
  for (const domain of requested) {
    if (forbidden.has(domain)) {
      return {
        ok: false,
        code: 'forbidden-domain',
        domain,
        message: `域「${domain}」永不导出。${FORBIDDEN_REASONS[domain] ?? ''}`.trim(),
      };
    }
    if (!known.has(domain)) {
      return {
        ok: false,
        code: 'unknown-domain',
        domain,
        message: `未知域「${domain}」。可用域：${[...known].join(', ')}`,
      };
    }
    domains.push(domain);
  }
  return { ok: true, domains };
}

/** Transforms: each returns the value to store plus what it removed. */
export function applyTransform(name, raw, context = {}) {
  const now = context.now ?? new Date().toISOString();

  if (name === 'identity') {
    const value = { ...(raw ?? {}) };
    const sessions = value.sessions && typeof value.sessions === 'object' ? value.sessions : {};
    const dropped = Object.keys(sessions).length;
    delete value.sessions;
    return {
      value,
      redactions: dropped
        ? [{
          what: 'identity.sessions',
          how: 'dropped',
          count: dropped,
          reason: '会话绑定属于本机宿主；导入后会重新绑定，不搬运旧会话 id。',
        }]
        : [],
    };
  }

  if (name === 'reminders') {
    const reminders = Array.isArray(raw?.reminders) ? raw.reminders : [];
    return {
      value: {
        ...(raw && typeof raw === 'object' ? raw : {}),
        reminders: reminders.map((item) => ({
          ...item,
          fired: true,
          paused: true,
          pausedAt: now,
          pausedReason: 'imported: 旧提醒不重放，仅存档',
        })),
        importedPaused: true,
      },
      redactions: reminders.length
        ? [{
          what: 'reminders.status',
          how: 'paused',
          count: reminders.length,
          reason: '停机期间的提醒一律不补发；条目保留为清单。',
        }]
        : [],
    };
  }

  if (name === 'suppression') {
    const list = Array.isArray(raw) ? raw : [];
    const entries = list
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({ messageId: item.messageId ?? null, time: item.time ?? null }));
    return {
      value: { entries },
      redactions: list.length
        ? [{
          what: 'sent-message.text',
          how: 'dropped',
          count: list.length,
          reason: '只保留 dedupe 键（messageId / time），不搬运消息正文。',
        }]
        : [],
    };
  }

  return { value: raw, redactions: [] };
}

export default {
  DEFAULT_DOMAINS,
  OPTIONAL_DOMAINS,
  FORBIDDEN_DOMAINS,
  FORBIDDEN_REASONS,
  DOMAIN_SPECS,
  IMPORTABLE_DOMAINS,
  ARCHIVE_ONLY_DOMAINS,
  IMPORT_TARGETS,
  IMPORT_TARGET_PREFIXES,
  resolveImportTarget,
  parseDomainList,
  validateDomains,
  applyTransform,
};
