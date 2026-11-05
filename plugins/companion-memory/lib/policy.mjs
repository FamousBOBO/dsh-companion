// Scope, status, reality and expression policy for the companion memory engine.
// Everything that decides "may this row be read / may this row be shown / how
// may it be phrased" lives here so write paths and read paths cannot drift.

export const SCOPES = ['user_global', 'user_persona', 'persona_self', 'roleplay_world', 'session_recent'];

export const KINDS = [
  'fact', 'preference', 'profile', 'event', 'commitment', 'relationship',
  'summary', 'bot_action', 'artifact', 'note',
];

export const MENTION_POLICIES = ['direct', 'soft_echo', 'tone_only', 'avoid_unless_asked'];

export const STATUSES = ['confirmed', 'pending', 'superseded', 'retracted', 'archived'];

export const REALITY_LEVELS = [
  'explicit_user_statement',      // the user stated it and it was confirmed
  'user_utterance_not_verified_fact', // captured from chat, not yet gated
  'imported_fact',                // imported AstrBot stable fact
  'imported_summary',             // imported conversation summary, may be wrong
  'bot_action',                   // something the bot did, never a user fact
  'roleplay_fiction',             // in-world fiction, must not leak to reality
  'inferred',                     // derived, lowest trust
];

export const SOURCE_KINDS = ['desktop_conversation', 'desktop_fact', 'astrbot_import', 'extracted', 'manual', 'system'];

/** Scopes whose rows belong to the real user rather than the fiction layer. */
export const REAL_USER_SCOPES = new Set(['user_global', 'user_persona', 'session_recent']);

/** Default importance per kind; used when an extractor does not provide one. */
const KIND_IMPORTANCE = {
  profile: 0.9, relationship: 0.85, commitment: 0.8, preference: 0.75, fact: 0.7,
  event: 0.6, summary: 0.5, note: 0.4, bot_action: 0.3, artifact: 0.25,
};

/** Character budget for the automatic injection, matching the verified baseline. */
export const BUDGET = Object.freeze({
  total: 2400,
  identity: 480,
  stableFacts: 0.32,
  related: 0.32,
  current: 0.12,
  reserve: 160,
});

export const RETRIEVAL_DEFAULTS = Object.freeze({
  candidates: 32,
  topK: 8,
  rrfK: 60,
  mmrLambda: 0.72,
  minScore: 0.0001,
});

export const SESSION_STATE_TTL_MS = 6 * 60 * 60 * 1000;

export function isScope(value) {
  return SCOPES.includes(value);
}

export function defaultMentionPolicy({ kind, realityLevel, scope }) {
  if (realityLevel === 'bot_action') return 'tone_only';
  if (scope === 'roleplay_world') return 'soft_echo';
  if (kind === 'relationship' || kind === 'commitment') return 'soft_echo';
  if (kind === 'profile' || kind === 'preference' || kind === 'fact') return 'direct';
  if (realityLevel === 'imported_summary' || realityLevel === 'inferred') return 'soft_echo';
  return 'direct';
}

export function defaultImportance(kind) {
  return KIND_IMPORTANCE[kind] ?? 0.5;
}

/**
 * Viewer identity used for every read. Rows are only visible when the user,
 * persona and world match; the fiction layer never leaks into another world.
 */
export function scopeMatches(row, viewer) {
  if (!row || !viewer) return false;
  if (!viewer.userId || row.userId !== viewer.userId) return false;
  if (!viewer.personaId || row.personaId !== viewer.personaId) return false;
  const rowWorld = row.worldId ?? '';
  const viewerWorld = viewer.worldId ?? '';
  if (row.scope === 'roleplay_world' || rowWorld) {
    return Boolean(viewerWorld) && rowWorld === viewerWorld;
  }
  return true;
}

export function isActive(row, now = Date.now()) {
  if (!row) return false;
  if (row.status !== 'confirmed') return false;
  if (row.validFrom && Date.parse(row.validFrom) > now) return false;
  if (row.validTo && Date.parse(row.validTo) <= now) return false;
  if (row.scope === 'session_recent' && row.occurredAt) {
    if (Date.parse(row.occurredAt) + SESSION_STATE_TTL_MS <= now) return false;
  }
  return true;
}

/** May this row participate in automatic context injection? */
export function isPromptEligible(row, now = Date.now()) {
  if (!isActive(row, now)) return false;
  if (row.mentionPolicy === 'avoid_unless_asked') return true; // present, but rendered as a hint
  return true;
}

/** Reality label rendered next to a row so the model can weight it. */
export function realityLabel(row) {
  switch (row.realityLevel) {
    case 'explicit_user_statement': return '用户明确说过';
    case 'imported_fact': return '旧库确认事实';
    case 'imported_summary': return '旧库对话摘要（可能有误）';
    case 'user_utterance_not_verified_fact': return '用户聊天原话（未确认）';
    case 'bot_action': return '角色自身行为';
    case 'roleplay_fiction': return '剧情设定';
    case 'inferred': return '推断';
    default: return '来源不明';
  }
}

export function scopeLabel(scope) {
  switch (scope) {
    case 'user_global': return '现实';
    case 'user_persona': return '关系';
    case 'persona_self': return '角色自我';
    case 'roleplay_world': return '剧情世界';
    case 'session_recent': return '近期状态';
    default: return scope;
  }
}
