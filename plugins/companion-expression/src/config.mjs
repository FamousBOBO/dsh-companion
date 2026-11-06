/**
 * `home/expression/config.json` — defaults, validation and atomic persistence.
 *
 * Three rules, all of which are proven by `test/config.test.mjs`:
 *   1. The file is created **once**, atomically, and never silently rewritten afterwards. An
 *      operator who edited it (or turned a switch off) must not be overridden by a later load.
 *   2. Invalid values fall back to the default **and** surface as `warnings`, so a broken file
 *      degrades into "runs with known defaults, says so" instead of "runs with a wrong number".
 *   3. Every switch that can send something to another human, or spend money, defaults to OFF.
 *      The suite-level `modules.expression` gate is separate and checked by the plugin entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveStageRoot } from './paths.mjs';

export const CONFIG_VERSION = 1;

/** Whether an uncertain classification may still be used, or is held for review. */
export const UNCERTAIN_MODES = Object.freeze(['review', 'quarantine']);
/** Whether a remote vision model may be called for a captured image. */
export const CLOUD_VISION_MODES = Object.freeze(['deny', 'allow']);
/** Analysis strength. `host-vision` is opt-in and needs `cloudVision: 'allow'`. */
export const ANALYSIS_MODES = Object.freeze(['off', 'heuristics', 'host-vision']);
/** Private-peer capture policy. */
export const PEER_POLICIES = Object.freeze(['opt_in', 'off']);

/**
 * Defaults. Every number here is a *baseline*, not a fixed rate: the design document's §6.1 asks
 * for parameters that get iterated after human evaluation, so they live in config and not code.
 */
export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_VERSION,
  enabled: true,
  capture: {
    ownerPrivate: true,
    groupEnabled: false,
    groups: [],
    privatePeers: 'opt_in',
    peers: [],
    maxDownloadBytes: 10 * 1024 * 1024,
    maxPerHour: 60,
    uncertain: 'review',
    cloudVision: 'deny',
  },
  analysis: { mode: 'heuristics', minConfidence: 0.55 },
  retrieval: { candidatesToModel: 5, minFitScore: 0.72 },
  delivery: {
    enabled: false,
    maxPerTurn: 1,
    dmCooldownSeconds: 300,
    dmCooldownTurns: 3,
    groupCooldownSeconds: 600,
    maxDmPerHour: 4,
    maxGroupPerHour: 2,
    repeatWindowDmHours: 48,
    repeatWindowGroupHours: 168,
    stageRoot: 'home/media/expression-out',
    stageTtlSeconds: 600,
    failClosed: true,
    fallbackToText: true,
  },
  privacy: { crossRoomReuse: false, publicRequiresApproval: true, deleteOnRevocation: true },
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInt(value, min, max, fallback) {
  return Math.trunc(clampNumber(value, min, max, fallback));
}

function pick(value, allowed, fallback) {
  const text = String(value ?? '').trim();
  return allowed.includes(text) ? text : fallback;
}

function flag(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

/** A positive safe integer, or null. Chat ids are never stored as strings in the database. */
function chatId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Normalise one `groups[]` entry.
 *
 * Listening, storing and replying are **three independent switches** (design §4): a group may be
 * listened to without ever contributing usable material, and may use the library without ever
 * being captured from. Anything missing is `false`.
 */
function normalizeGroup(entry, warnings, index) {
  if (!isPlainObject(entry)) {
    warnings.push(`capture.groups[${index}] 不是对象，已丢弃`);
    return null;
  }
  const id = chatId(entry.chatId ?? entry.id);
  if (id === null) {
    warnings.push(`capture.groups[${index}] 缺少合法 chatId，已丢弃`);
    return null;
  }
  const use = entry.use === undefined ? (entry.reply === undefined ? false : flag(entry.reply, false)) : flag(entry.use, false);
  return {
    chatId: id,
    capture: flag(entry.capture, false),
    store: flag(entry.store, entry.capture === undefined ? false : flag(entry.capture, false)),
    use,
  };
}

function normalizePeer(entry, warnings, index) {
  if (!isPlainObject(entry)) {
    warnings.push(`capture.peers[${index}] 不是对象，已丢弃`);
    return null;
  }
  const id = chatId(entry.chatId ?? entry.id);
  if (id === null) {
    warnings.push(`capture.peers[${index}] 缺少合法 chatId，已丢弃`);
    return null;
  }
  return { chatId: id, approved: flag(entry.approved, false) };
}

/**
 * Normalise a whole config object (loaded from disk, or posted by the Studio page).
 *
 * @param {unknown} raw
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig(raw) {
  const warnings = [];
  const input = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) warnings.push('配置文件不是 JSON 对象，已整份回退默认值');

  const captureIn = isPlainObject(input.capture) ? input.capture : {};
  const analysisIn = isPlainObject(input.analysis) ? input.analysis : {};
  const retrievalIn = isPlainObject(input.retrieval) ? input.retrieval : {};
  const deliveryIn = isPlainObject(input.delivery) ? input.delivery : {};
  const privacyIn = isPlainObject(input.privacy) ? input.privacy : {};

  const groups = Array.isArray(captureIn.groups)
    ? captureIn.groups.map((entry, index) => normalizeGroup(entry, warnings, index)).filter(Boolean)
    : [];
  const peers = Array.isArray(captureIn.peers)
    ? captureIn.peers.map((entry, index) => normalizePeer(entry, warnings, index)).filter(Boolean)
    : [];

  const config = {
    schemaVersion: CONFIG_VERSION,
    enabled: flag(input.enabled, DEFAULT_CONFIG.enabled),
    capture: {
      ownerPrivate: flag(captureIn.ownerPrivate, DEFAULT_CONFIG.capture.ownerPrivate),
      groupEnabled: flag(captureIn.groupEnabled, DEFAULT_CONFIG.capture.groupEnabled),
      groups,
      privatePeers: pick(captureIn.privatePeers, PEER_POLICIES, DEFAULT_CONFIG.capture.privatePeers),
      peers,
      maxDownloadBytes: clampInt(captureIn.maxDownloadBytes, 64 * 1024, 64 * 1024 * 1024, DEFAULT_CONFIG.capture.maxDownloadBytes),
      maxPerHour: clampInt(captureIn.maxPerHour, 0, 600, DEFAULT_CONFIG.capture.maxPerHour),
      uncertain: pick(captureIn.uncertain, UNCERTAIN_MODES, DEFAULT_CONFIG.capture.uncertain),
      cloudVision: pick(captureIn.cloudVision, CLOUD_VISION_MODES, DEFAULT_CONFIG.capture.cloudVision),
    },
    analysis: {
      mode: pick(analysisIn.mode, ANALYSIS_MODES, DEFAULT_CONFIG.analysis.mode),
      minConfidence: clampNumber(analysisIn.minConfidence, 0, 1, DEFAULT_CONFIG.analysis.minConfidence),
    },
    retrieval: {
      candidatesToModel: clampInt(retrievalIn.candidatesToModel, 1, 10, DEFAULT_CONFIG.retrieval.candidatesToModel),
      minFitScore: clampNumber(retrievalIn.minFitScore, 0, 1, DEFAULT_CONFIG.retrieval.minFitScore),
    },
    delivery: {
      enabled: flag(deliveryIn.enabled, DEFAULT_CONFIG.delivery.enabled),
      maxPerTurn: clampInt(deliveryIn.maxPerTurn, 0, 3, DEFAULT_CONFIG.delivery.maxPerTurn),
      dmCooldownSeconds: clampInt(deliveryIn.dmCooldownSeconds, 0, 86_400, DEFAULT_CONFIG.delivery.dmCooldownSeconds),
      dmCooldownTurns: clampInt(deliveryIn.dmCooldownTurns, 0, 100, DEFAULT_CONFIG.delivery.dmCooldownTurns),
      groupCooldownSeconds: clampInt(deliveryIn.groupCooldownSeconds, 0, 86_400, DEFAULT_CONFIG.delivery.groupCooldownSeconds),
      maxDmPerHour: clampInt(deliveryIn.maxDmPerHour, 0, 120, DEFAULT_CONFIG.delivery.maxDmPerHour),
      maxGroupPerHour: clampInt(deliveryIn.maxGroupPerHour, 0, 120, DEFAULT_CONFIG.delivery.maxGroupPerHour),
      repeatWindowDmHours: clampInt(deliveryIn.repeatWindowDmHours, 0, 24 * 365, DEFAULT_CONFIG.delivery.repeatWindowDmHours),
      repeatWindowGroupHours: clampInt(deliveryIn.repeatWindowGroupHours, 0, 24 * 365, DEFAULT_CONFIG.delivery.repeatWindowGroupHours),
      stageRoot: String(deliveryIn.stageRoot ?? DEFAULT_CONFIG.delivery.stageRoot).trim() || DEFAULT_CONFIG.delivery.stageRoot,
      stageTtlSeconds: clampInt(deliveryIn.stageTtlSeconds, 10, 3_600, DEFAULT_CONFIG.delivery.stageTtlSeconds),
      failClosed: flag(deliveryIn.failClosed, DEFAULT_CONFIG.delivery.failClosed),
      fallbackToText: flag(deliveryIn.fallbackToText, DEFAULT_CONFIG.delivery.fallbackToText),
    },
    privacy: {
      crossRoomReuse: flag(privacyIn.crossRoomReuse, DEFAULT_CONFIG.privacy.crossRoomReuse),
      publicRequiresApproval: flag(privacyIn.publicRequiresApproval, DEFAULT_CONFIG.privacy.publicRequiresApproval),
      deleteOnRevocation: flag(privacyIn.deleteOnRevocation, DEFAULT_CONFIG.privacy.deleteOnRevocation),
    },
  };

  // A mode combination that cannot work is reported, not silently "fixed": the operator has to be
  // able to read why the vision model will not be called.
  if (config.analysis.mode === 'host-vision' && config.capture.cloudVision !== 'allow') {
    warnings.push('analysis.mode=host-vision 需要 capture.cloudVision=allow；本轮按 heuristics 运行');
  }
  for (const group of config.capture.groups) {
    if (group.use && !group.store && !group.capture) {
      warnings.push(`群 ${group.chatId} 开了「可用于回复」但没开收集：它只会用库里其它来源的素材`);
    }
  }
  return { config, warnings };
}

/**
 * Validate a candidate config written by the Studio page.
 *
 * The difference from `normalizeConfig` matters: a *save* is refused when a value is out of range,
 * because silently writing a different number than the operator typed is worse than an error.
 *
 * @returns {{ok: true, config: object, warnings: string[]} | {ok: false, error: string}}
 */
export function validateConfig(raw) {
  const { config, warnings } = normalizeConfig(raw);
  if (!isPlainObject(raw)) return { ok: false, error: '配置必须是 JSON 对象。' };
  for (const [section, shape] of Object.entries(DEFAULT_CONFIG)) {
    if (section === 'schemaVersion') continue;
    if (shape && typeof shape === 'object' && !Array.isArray(shape) && raw[section] !== undefined && !isPlainObject(raw[section])) {
      return { ok: false, error: `${section} 必须是对象。` };
    }
  }
  const delivery = raw.delivery ?? {};
  if (delivery.maxPerTurn !== undefined && !(Number(delivery.maxPerTurn) >= 0 && Number(delivery.maxPerTurn) <= 3)) {
    return { ok: false, error: 'delivery.maxPerTurn 必须是 0–3 的整数。' };
  }
  const capture = raw.capture ?? {};
  if (capture.maxDownloadBytes !== undefined) {
    const bytes = Number(capture.maxDownloadBytes);
    if (!Number.isFinite(bytes) || bytes < 64 * 1024 || bytes > 64 * 1024 * 1024) {
      return { ok: false, error: 'capture.maxDownloadBytes 必须是 65536–67108864 之间的字节数。' };
    }
  }
  if (Array.isArray(capture.groups)) {
    for (const entry of capture.groups) {
      if (!isPlainObject(entry) || chatId(entry.chatId ?? entry.id) === null) {
        return { ok: false, error: 'capture.groups 每一项都必须带合法 chatId。' };
      }
    }
  }
  if (Array.isArray(capture.peers)) {
    for (const entry of capture.peers) {
      if (!isPlainObject(entry) || chatId(entry.chatId ?? entry.id) === null) {
        return { ok: false, error: 'capture.peers 每一项都必须带合法 chatId。' };
      }
    }
  }
  return { ok: true, config, warnings };
}

/**
 * Effective staging directory for this config. Always inside `home/media`.
 * @param {string} dataRoot
 * @param {object} config
 */
export function stageRootOf(dataRoot, config) {
  return resolveStageRoot(dataRoot, config?.delivery?.stageRoot);
}

/**
 * Read the config. A missing file is created once (atomically); an unreadable or invalid file is
 * reported with warnings and replaced **in memory only** — the operator's file stays untouched
 * until they save from the UI.
 *
 * @param {{file: string, dataRoot: string, env?: object}} options
 * @returns {{config: object, warnings: string[], exists: boolean, created: boolean, file: string}}
 */
export function loadConfig({ file, dataRoot }) {
  const warnings = [];
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      warnings.push(`读取 ${file} 失败：${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
  if (text === null) {
    const { config } = normalizeConfig(DEFAULT_CONFIG);
    let created = false;
    try {
      writeConfigFile(file, config);
      created = true;
    } catch (error) {
      warnings.push(`首次创建 ${file} 失败：${String(error?.message ?? error).slice(0, 160)}`);
    }
    if (!created) warnings.push('配置只在内存里存在；保存前不会写盘');
    return { config, warnings, exists: false, created, file };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnings.push(`${file} 不是合法 JSON（${String(error?.message ?? error).slice(0, 80)}），已按默认值运行；原文件未改动`);
    const { config } = normalizeConfig(DEFAULT_CONFIG);
    return { config, warnings, exists: true, created: false, file };
  }
  const { config, warnings: normalWarnings } = normalizeConfig(parsed);
  warnings.push(...normalWarnings);
  const root = resolveStageRoot(dataRoot, config.delivery.stageRoot);
  if (!root.ok) {
    warnings.push(`delivery.stageRoot 越界（必须在 home/media 内），已回退 ${DEFAULT_CONFIG.delivery.stageRoot}`);
    config.delivery.stageRoot = DEFAULT_CONFIG.delivery.stageRoot;
  }
  return { config, warnings, exists: true, created: false, file };
}

/** Atomic write: temp file in the same directory, fsync, rename. */
export function writeConfigFile(file, config) {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.config-${randomUUID()}.tmp`);
  const body = `${JSON.stringify(config, null, 2)}\n`;
  try {
    fs.writeFileSync(temp, body, 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return target;
}

/**
 * Save a config posted by the UI (or by an explicit tool call).
 *
 * @returns {{ok: true, config: object, warnings: string[]} | {ok: false, error: string}}
 */
export function saveConfig({ file, dataRoot, raw }) {
  const checked = validateConfig(raw);
  if (checked.ok === false) return checked;
  const { config, warnings } = checked;
  const root = resolveStageRoot(dataRoot, config.delivery.stageRoot);
  if (!root.ok) {
    warnings.push('delivery.stageRoot 不在 home/media 内，已写回默认值');
    config.delivery.stageRoot = DEFAULT_CONFIG.delivery.stageRoot;
  }
  try {
    writeConfigFile(file, config);
  } catch (error) {
    return { ok: false, error: `写入配置失败：${String(error?.message ?? error).slice(0, 160)}` };
  }
  return { ok: true, config, warnings };
}

export default {
  CONFIG_VERSION, DEFAULT_CONFIG, normalizeConfig, validateConfig, loadConfig, saveConfig,
  writeConfigFile, stageRootOf, UNCERTAIN_MODES, CLOUD_VISION_MODES, ANALYSIS_MODES, PEER_POLICIES,
};
