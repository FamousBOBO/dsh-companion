// Capability consents (INTERFACES.md §10).
//
// The list is deliberately split in two:
//
//   * `DEFAULT_ON` — reading your own data on demand. On by default because the
//     user asked for the feature.
//   * the *gated* set (`health.context.auto`, `health.memory.habits`,
//     `health.schedule.adjust`, `health.care.proactive`) plus `export`/`delete` —
//     **off by default and with no code path that turns them on this round**.
//     Only this table's own read/write API can change them, so the UI can label
//     them "本轮不可启用" and be telling the truth.
//
// `isAllowed` is the single question the rest of the plugin is allowed to ask.

export const CAPABILITIES = Object.freeze([
  'health.connect',
  'health.read.on_demand',
  'health.dashboard',
  'health.sleep.read',
  'health.pulse.live',
  'health.context.auto',
  'health.memory.habits',
  'health.schedule.adjust',
  'health.care.proactive',
  'health.export',
  'health.delete',
]);

export const DEFAULT_ON = Object.freeze([
  'health.connect',
  'health.read.on_demand',
  'health.dashboard',
  'health.sleep.read',
  // Live pulse is on by default for the same reason `health.read.on_demand` is: the owner
  // asked for this feature. It is still fenced twice — an explicit per-scene session must be
  // opened, and the BLE sidecar has to be started by hand — so a default-on row cannot make a
  // number reach a prompt on its own.
  'health.pulse.live',
]);

/**
 * Capabilities no code path may open in this round. Kept as a data structure so
 * the UI and the tests agree with the implementation instead of with a comment.
 */
export const GATED_OFF = Object.freeze([
  'health.context.auto',
  'health.memory.habits',
  'health.schedule.adjust',
  'health.care.proactive',
  'health.export',
  'health.delete',
]);

export const CONSENT_VERSION = 1;

function badCapability(capability) {
  const error = new Error(`未知的健康能力：${String(capability)}`);
  error.code = 'bad-capability';
  return error;
}

function dbUsable(db) {
  return Boolean(db) && typeof db.all === 'function';
}

function defaults() {
  const out = {};
  for (const capability of CAPABILITIES) out[capability] = DEFAULT_ON.includes(capability);
  return out;
}

/**
 * Effective consent map: defaults overlaid with whatever the table holds.
 *
 * An unknown row (a capability a newer build wrote) is ignored rather than
 * honoured — an unrecognised capability has no consumer here, and pretending to
 * know its default would be a guess.
 */
export function loadConsents(db) {
  const out = defaults();
  if (!dbUsable(db)) return out;
  let rows = [];
  try {
    rows = db.all('SELECT capability, enabled FROM health_consents');
  } catch {
    return out;
  }
  for (const row of rows) {
    const capability = String(row?.capability ?? '');
    if (!CAPABILITIES.includes(capability)) continue;
    out[capability] = Number(row.enabled) === 1;
  }
  return out;
}

/**
 * Write one consent. Throws `bad-capability` (with `.code`) for anything not in
 * `CAPABILITIES` — a typo must never silently create a permission.
 */
export function setConsent(db, capability, enabled) {
  const name = String(capability ?? '');
  if (!CAPABILITIES.includes(name)) throw badCapability(name);
  if (!db || typeof db.run !== 'function') throw new Error('健康数据库尚未就绪');
  const value = enabled ? 1 : 0;
  const at = Date.now();
  db.run(
    `INSERT INTO health_consents (capability, enabled, consent_version, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(capability) DO UPDATE SET
       enabled = excluded.enabled,
       consent_version = excluded.consent_version,
       updated_at = excluded.updated_at`,
    [name, value, CONSENT_VERSION, at],
  );
  return { capability: name, enabled: Boolean(enabled), consentVersion: CONSENT_VERSION, updatedAt: at };
}

/** The one question callers ask. Unknown capability is a hard "no". */
export function isAllowed(db, capability) {
  const name = String(capability ?? '');
  if (!CAPABILITIES.includes(name)) return false;
  return loadConsents(db)[name] === true;
}

/** True for capabilities this round cannot enable at all (UI labelling). */
export function isGated(capability) {
  return GATED_OFF.includes(String(capability ?? ''));
}

/** Presentational view: what is on, what is gated, and why each one matters. */
export function describeConsents(db) {
  const current = loadConsents(db);
  return CAPABILITIES.map(capability => ({
    capability,
    enabled: current[capability],
    defaultOn: DEFAULT_ON.includes(capability),
    gated: GATED_OFF.includes(capability),
    note: GATED_OFF.includes(capability)
      ? '本轮不可启用；只有同意表本身的读写接口能改，没有任何代码路径会打开它。'
      : '只读能力：仅在本机读取你授权的数据。',
  }));
}
