import fs from 'node:fs';
import path from 'node:path';
import { runtimeDir } from './scope.mjs';

export const CONFIG_VERSION = 'p1-cognitive-continuity-v1';
export const MODES = Object.freeze(['off', 'shadow', 'active']);

// Defaults are deliberately inert: installing the plugin must not change chat or
// memory behaviour. Shadow and active modes are opt-in.
export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  mode: 'off',
  timeZone: 'Asia/Shanghai',
  leaseTtlMs: 120000,
  injection: { budgetChars: 320 },
  state: { disabled: [] },
  goals: { maxActivePerScope: 8 },
  beliefs: { defaultTtlMs: 86400000, maxCurrent: 20 },
  shadow: { maxProposals: 200 },
  bridge: { enabled: false, transformVersion: 'v1', callTimeoutMs: 30000 },
  // H1/H2 are independent switches on purpose: enabling the cognitive runtime must not
  // start a background agenda or heartbeat. Both default to off (C5 §12.1).
  agenda: {
    enabled: false,
    maxItemsPerScope: 64,
    generationHorizonHours: 72,
    maxGeneratePerCall: 64,
    querySpanDays: 14,
  },
  heartbeat: {
    enabled: false,
    pollIntervalMs: 60000,
    jitterMs: 2500,
    maxScopesPerCycle: 8,
    maxDueItemsPerCycle: 64,
    maxNewOccurrencesPerCycle: 128,
    maxCatchupHorizonHours: 24,
    maxAttempts: 5,
    maxTimeBudgetMs: 2000,
    // A `due` occurrence has no downstream consumer in this round, so it must not
    // accumulate forever: after this retention it expires with a reason (A1-B1).
    dueRetentionHours: 24,
    // Fairness backoff for a scope whose own transaction failed (A1-B4).
    maxRetryBackoffMs: 1800000,
    // P2.5-1 (Slice A): how many P2 plan slots this heartbeat may *claim* per cycle. The
    // heartbeat never executes anything — a claim is one `autonomy/plan-slot` append, and the
    // asynchronous P2 pump owns the actual activity. 0 turns the section off entirely, which is
    // also what an uninjected `activityDispatch` hook does (fail-closed rollback switch).
    maxDispatchPerCycle: 1,
    // Reserved and still unused: the hook injection (`activityDispatch`) is what decides
    // whether the heartbeat may claim P2 slots, not this string (C5 §12.5.4 kept for
    // compatibility; `agenda/occurrence-dispatched` is still never produced).
    activityConsumer: '',
  },
  // P2 autonomous day + real activities (contract logs/p2-autonomous-day/contract-p2.md).
  // Every switch below defaults to off; enabling the existing P1/H1/H2 must never start
  // autonomous planning, activities or sharing.
  p2: {
    planning: {
      enabled: false,
      paused: false,
      wakeHour: 8,
      latestStartHour: 22,
      maxSlots: 8,
      hardMaxSlots: 12,
      maxOutputTokens: 4096,
      maxInputChars: 16000,
      timeoutMs: 90000,
      maxAttempts: 2,
      coalesceMs: 600000,
      softDirectionDays: 7,
    },
    activities: {
      enabled: false,
      paused: false,
      // P2.5-1 gray-release switch — **not** an execution switch. `enabled` decides whether an
      // activity may run at all; `dispatchEnabled` decides whether the H2 heartbeat may *claim* a
      // due plan slot (`autonomy/plan-slot` `planned → started`) so the pump can pick it up.
      // Default false on purpose (plan §6: "activityDispatch.enabled 初始 false，先 dry-run 看
      // due 决策"); turning on `enabled` alone must not silently start autonomous dispatch.
      dispatchEnabled: false,
      chunkUnits: 1200,
      maxUnitsPerStep: 4000,
      maxSourceBytes: 200000,
      maxExcerptChars: 4000,
      artifactRoot: 'home/companion/works',
    },
    budget: {
      maxRequestsPerDay: 64,
      maxInputTokensPerDay: 160000,
      maxOutputTokensPerDay: 24000,
      recoveryReserveRatio: 0.2,
      maxConcurrent: 2,
      chatPriority: true,
      maxCostPerDay: 0,
    },
    autonomy: {
      allowedSources: [],
      scopeAcknowledgedAt: 0,
      maxExplorePerDay: 6,
      maxWritesPerDay: 4,
    },
    share: { enabled: false, maxPending: 5 },
  },
});

export function configFile(root) {
  return path.join(runtimeDir(root), 'runtime.config.json');
}

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      merged[key] = merge(base[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function sanitize(config) {
  const next = { ...config };
  if (!MODES.includes(next.mode)) next.mode = 'off';
  // `enabled: false` always wins: no mode may resurrect a disabled runtime.
  if (next.enabled !== true) next.mode = 'off';
  next.injection = { budgetChars: Math.max(80, Math.min(1200, Number(next.injection?.budgetChars) || 320)) };
  next.leaseTtlMs = Math.max(5000, Number(next.leaseTtlMs) || 120000);
  next.goals = { maxActivePerScope: Math.max(1, Math.min(50, Number(next.goals?.maxActivePerScope) || 8)) };
  next.beliefs = {
    defaultTtlMs: Math.max(60000, Number(next.beliefs?.defaultTtlMs) || 86400000),
    maxCurrent: Math.max(1, Math.min(200, Number(next.beliefs?.maxCurrent) || 20)),
  };
  next.shadow = { maxProposals: Math.max(10, Math.min(5000, Number(next.shadow?.maxProposals) || 200)) };
  next.bridge = {
    enabled: next.bridge?.enabled === true,
    transformVersion: String(next.bridge?.transformVersion || 'v1'),
    callTimeoutMs: Math.max(1000, Math.min(300000, Number(next.bridge?.callTimeoutMs) || 30000)),
  };
  next.state = { disabled: Array.isArray(next.state?.disabled) ? next.state.disabled.map(String) : [] };
  const clamp = (value, low, high, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(low, Math.min(high, Math.trunc(number)));
  };
  // Both new capabilities stay off unless the on-disk config says `true` explicitly;
  // there is no mode or env shortcut that resurrects them.
  next.agenda = {
    enabled: next.agenda?.enabled === true,
    maxItemsPerScope: clamp(next.agenda?.maxItemsPerScope, 1, 200, 64),
    generationHorizonHours: clamp(next.agenda?.generationHorizonHours, 1, 720, 72),
    maxGeneratePerCall: clamp(next.agenda?.maxGeneratePerCall, 1, 500, 64),
    querySpanDays: clamp(next.agenda?.querySpanDays, 1, 90, 14),
  };
  next.heartbeat = {
    enabled: next.heartbeat?.enabled === true,
    pollIntervalMs: clamp(next.heartbeat?.pollIntervalMs, 5000, 3600000, 60000),
    jitterMs: clamp(next.heartbeat?.jitterMs, 0, 60000, 2500),
    maxScopesPerCycle: clamp(next.heartbeat?.maxScopesPerCycle, 1, 64, 8),
    maxDueItemsPerCycle: clamp(next.heartbeat?.maxDueItemsPerCycle, 1, 512, 64),
    maxNewOccurrencesPerCycle: clamp(next.heartbeat?.maxNewOccurrencesPerCycle, 1, 512, 128),
    maxCatchupHorizonHours: clamp(next.heartbeat?.maxCatchupHorizonHours, 1, 720, 24),
    maxAttempts: clamp(next.heartbeat?.maxAttempts, 1, 20, 5),
    maxTimeBudgetMs: clamp(next.heartbeat?.maxTimeBudgetMs, 50, 30000, 2000),
    dueRetentionHours: clamp(next.heartbeat?.dueRetentionHours, 1, 720, 24),
    maxRetryBackoffMs: clamp(next.heartbeat?.maxRetryBackoffMs, 5000, 86400000, 1800000),
    // 0 is legal and means "claim nothing"; the upper bound keeps a typo from turning one
    // heartbeat tick into an unbounded claim batch (P2.5-1 §6 "每 tick 最大新派发").
    maxDispatchPerCycle: clamp(next.heartbeat?.maxDispatchPerCycle, 0, 20, 1),
    activityConsumer: String(next.heartbeat?.activityConsumer ?? '').slice(0, 60),
  };
  // P2: sanitisation keeps every switch strictly boolean-false unless the file says true,
  // and every bound inside a sane range so a typo cannot turn the autonomous day into an
  // unbounded loop (contract section 4).
  const p2 = next.p2 ?? {};
  next.p2 = {
    planning: {
      enabled: p2.planning?.enabled === true,
      paused: p2.planning?.paused === true,
      wakeHour: clamp(p2.planning?.wakeHour, 0, 23, 8),
      latestStartHour: clamp(p2.planning?.latestStartHour, 1, 24, 22),
      maxSlots: clamp(p2.planning?.maxSlots, 0, 12, 8),
      targetActivities: clamp(p2.planning?.targetActivities, 0, 8, 0),
      hardMaxSlots: 12,
      maxOutputTokens: clamp(p2.planning?.maxOutputTokens, 256, 8192, 4096),
      maxInputChars: clamp(p2.planning?.maxInputChars, 1000, 40000, 16000),
      timeoutMs: clamp(p2.planning?.timeoutMs, 5000, 300000, 90000),
      maxAttempts: clamp(p2.planning?.maxAttempts, 1, 4, 2),
      coalesceMs: clamp(p2.planning?.coalesceMs, 60000, 3600000, 600000),
      softDirectionDays: clamp(p2.planning?.softDirectionDays, 1, 30, 7),
    },
    activities: {
      enabled: p2.activities?.enabled === true,
      paused: p2.activities?.paused === true,
      // Strictly boolean-false unless the file says true: a typo, a string or a missing key all
      // mean "the gray release stays off" (P2.5-1 §6).
      dispatchEnabled: p2.activities?.dispatchEnabled === true,
      chunkUnits: clamp(p2.activities?.chunkUnits, 100, 20000, 1200),
      maxUnitsPerStep: clamp(p2.activities?.maxUnitsPerStep, 100, 50000, 4000),
      maxSourceBytes: clamp(p2.activities?.maxSourceBytes, 1000, 2000000, 200000),
      maxTotalUnits: clamp(p2.activities?.maxTotalUnits, 1000, 2000000, 200000),
      readFullSource: p2.activities?.readFullSource === true,
      maxExcerptChars: clamp(p2.activities?.maxExcerptChars, 200, 20000, 4000),
      artifactRoot: String(p2.activities?.artifactRoot ?? 'home/companion/works').slice(0, 200),
      draftsDir: String(p2.activities?.draftsDir ?? 'drafts').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'drafts',
      readRoots: Array.isArray(p2.activities?.readRoots) ? p2.activities.readRoots.map(String).slice(0, 20) : [],
    },
    budget: {
      maxRequestsPerDay: clamp(p2.budget?.maxRequestsPerDay, 1, 2000, 64),
      maxInputTokensPerDay: clamp(p2.budget?.maxInputTokensPerDay, 1000, 5000000, 160000),
      maxOutputTokensPerDay: clamp(p2.budget?.maxOutputTokensPerDay, 1000, 500000, 24000),
      recoveryReserveRatio: Math.max(0, Math.min(0.5, Number(p2.budget?.recoveryReserveRatio) || 0.2)),
      maxConcurrent: clamp(p2.budget?.maxConcurrent, 1, 4, 2),
      chatPriority: p2.budget?.chatPriority !== false,
      maxCostPerDay: Math.max(0, Number(p2.budget?.maxCostPerDay) || 0),
    },
    autonomy: {
      allowedSources: Array.isArray(p2.autonomy?.allowedSources) ? p2.autonomy.allowedSources.map(String).slice(0, 50) : [],
      scopeAcknowledgedAt: Math.max(0, Number(p2.autonomy?.scopeAcknowledgedAt) || 0),
      topics: Array.isArray(p2.autonomy?.topics) ? p2.autonomy.topics.map(String).slice(0, 20) : [],
      maxSearchesPerDay: clamp(p2.autonomy?.maxSearchesPerDay, 1, 24, 6),
      maxExplorePerDay: clamp(p2.autonomy?.maxExplorePerDay, 0, 50, 6),
      maxWritesPerDay: clamp(p2.autonomy?.maxWritesPerDay, 0, 50, 4),
      // Public entry points and discovery are configuration, not a hard-coded example URL: they
      // must survive sanitising or the planner can never be offered a real source.
      seedUrls: Array.isArray(p2.autonomy?.seedUrls)
        ? p2.autonomy.seedUrls.map(value => String(value).trim()).filter(value => /^https?:\/\//i.test(value)).slice(0, 16)
        : [],
      searchProvider: ['dsh', 'wikipedia', 'duckduckgo', 'none'].includes(String(p2.autonomy?.searchProvider ?? ''))
        ? String(p2.autonomy.searchProvider)
        : 'wikipedia',
      maxLinksPerPage: clamp(p2.autonomy?.maxLinksPerPage, 1, 50, 12),
    },
    share: {
      enabled: p2.share?.enabled === true,
      maxPending: clamp(p2.share?.maxPending, 0, 50, 5),
    },
  };
  return next;
}

/** Read the on-disk runtime config; invalid JSON or bad values fall back, never throw. */
export function loadConfig(root, { env = process.env, override = null } = {}) {
  let fromDisk = {};
  let error = null;
  try {
    const file = configFile(root);
    if (fs.existsSync(file)) fromDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  let fromEnv = {};
  if (env.DSH_COMPANION_RUNTIME_MODE) fromEnv.mode = env.DSH_COMPANION_RUNTIME_MODE;
  if (env.DSH_COMPANION_RUNTIME_ENABLED === '1') fromEnv.enabled = true;
  const merged = merge(merge(DEFAULT_CONFIG, fromDisk), merge(fromEnv, override ?? {}));
  const config = sanitize(merged);
  return { config, file: configFile(root), error };
}

/** Effective mode also accounts for the writer lease and the memory service. */
export function effectiveMode(config, { writable = true } = {}) {
  if (config.enabled !== true) return 'off';
  if (!MODES.includes(config.mode) || config.mode === 'off') return 'off';
  if (!writable) return 'off';
  return config.mode;
}

export function formatInstant(ms, timeZone = 'Asia/Shanghai') {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}
