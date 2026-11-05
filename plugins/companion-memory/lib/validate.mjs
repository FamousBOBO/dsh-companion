// Hand-written validation and promotion gate for extracted memory candidates.
// Deliberately dependency free: the candidate shape is small, and explicit
// checks keep every failure message auditable in logs. Chinese `reasons` are
// returned on every decision because operators read them in the desktop UI.
//
// Two stages:
//   parseCandidate(raw)      -> structural shape / enum / range checks
//   gateCandidate(cand, ctx) -> evidence ownership + reality classification
//   mergeDecision({...})     -> what to do with an already stored value

import {
  KINDS,
  REAL_USER_SCOPES,
  SCOPES,
  defaultImportance,
  defaultMentionPolicy,
} from './policy.mjs';
import { normalizeText, redactSecrets, terms } from './text.mjs';

export const CANDIDATE_SCHEMA_VERSION = 1;

/** Upper bound on candidates accepted from a single extraction batch. */
export const MAX_CANDIDATES_PER_BATCH = 8;
export const MAX_VALUE_LENGTH = 1000;
export const MAX_PREDICATE_LENGTH = 64;
export const MAX_SUBJECT_LENGTH = 64;
export const MAX_EVIDENCE_IDS = 12;

/** Below this confidence a candidate may be stored, but only as `pending`. */
export const MIN_ACCEPT_CONFIDENCE = 0.5;

export const VALIDITY_VALUES = Object.freeze(['current', 'planned', 'historical', 'uncertain']);
export const SUGGESTED_OPERATIONS = Object.freeze(['insert', 'update', 'upsert', 'supersede', 'duplicate', 'ignore']);

/** Roles that represent a fresh conversation turn. Anything else is material. */
export const CONVERSATION_ROLES = Object.freeze(['user', 'assistant']);
/**
 * Source kinds that carry migrated or system material. Rows with these kinds
 * keep their original role label but never count as a new user statement.
 */
export const NON_CONVERSATION_SOURCE_KINDS = Object.freeze(['astrbot_import', 'manual', 'system']);

/** Kinds that describe one stable attribute; a new value replaces the old one. */
export const SINGLE_VALUE_KINDS = Object.freeze(['fact', 'profile', 'preference', 'relationship']);
/** Kinds that naturally accumulate multiple rows (interests, promises, events). */
export const MULTI_VALUE_KINDS = Object.freeze(['commitment', 'event', 'note', 'summary', 'artifact', 'bot_action']);

/**
 * Predicates whose values may coexist even under a single-value kind.
 * `multi:` is the prefix contract from CONTRACT.md §6 (rememberFact).
 */
export const MULTI_VALUE_PREDICATES = Object.freeze(new Set([
  'hobby', 'hobbies', 'interest', 'interests', 'like', 'likes', 'dislike', 'dislikes',
  'favorite_food', 'favorite_drinks', 'favorite_music', 'favorite_games', 'pet', 'pets',
  'skill', 'skills', 'language', 'languages', 'collection', 'collections', 'friend', 'friends',
  'game', 'games', 'habit', 'habits', 'trip_plan', 'travel_plan', 'gift_ideas', 'wish', 'wishes',
]));

const STRUCTURAL_FIELDS = new Set([
  'kind', 'scope', 'subject', 'predicate', 'value', 'evidence_source_ids',
  'confidence', 'importance', 'validity', 'suggested_operation', 'mention_policy',
]);

const KIND_ALIASES = new Map([
  ['fact', 'fact'], ['preference', 'preference'], ['profile', 'profile'], ['event', 'event'],
  ['commitment', 'commitment'], ['relationship', 'relationship'], ['summary', 'summary'],
  ['bot_action', 'bot_action'], ['artifact', 'artifact'], ['note', 'note'],
]);

const MENTION_ALIASES = new Map([
  ['direct', 'direct'],
  ['soft', 'soft_echo'], ['soft_echo', 'soft_echo'], ['softecho', 'soft_echo'],
  ['tone', 'tone_only'], ['tone_only', 'tone_only'], ['toneonly', 'tone_only'],
  ['avoid', 'avoid_unless_asked'], ['avoid_unless_asked', 'avoid_unless_asked'],
]);

const VALIDITY_ALIASES = new Map([
  ['current', 'current'], ['present', 'current'], ['now', 'current'],
  ['planned', 'planned'], ['future', 'planned'], ['plan', 'planned'],
  ['historical', 'historical'], ['past', 'historical'], ['history', 'historical'],
  ['uncertain', 'uncertain'], ['unknown', 'uncertain'], ['maybe', 'uncertain'],
]);

const OPERATION_ALIASES = new Map([
  ['insert', 'insert'], ['add', 'insert'], ['create', 'insert'],
  ['update', 'update'], ['merge', 'update'], ['upsert', 'upsert'],
  ['supersede', 'supersede'], ['replace', 'supersede'], ['correct', 'supersede'],
  ['duplicate', 'duplicate'], ['skip', 'duplicate'], ['ignore', 'ignore'],
]);

// --- heuristic marker tables -------------------------------------------------
// These are intentionally narrow keyword lists: a false positive only costs a
// `pending` (never a destructive write), while a false negative would promote
// fiction into the user's reality layer.

// Strong markers mean the message itself is roleplay; weak markers only hint at
// it (a user may legitimately say "喜欢看剧情片"), so they become `pending`
// outside a world-bound session instead of a hard reject.
const ROLEPLAY_STRONG_PATTERNS = [
  /角色扮演/g, /扮演/g, /入戏/g, /来演/g, /演一下/g, /演一场/g, /当一回/g,
  /设定里/g, /设定成/g, /设定是/g, /世界观/g, /剧本/g, /平行世界/g, /异世界/g,
  /故事里/g, /小说里/g, /if\s*线/gi, /假装(?:你|我)(?:是|在)/g, /[（(]\s*剧情/g,
];

const ROLEPLAY_WEAK_PATTERNS = [
  /剧情(?!片|向|类|游戏|党|爱|介绍|简介|梗)/g, /假装/g, /设定/g, /演戏/g,
];

const JOKE_PATTERNS = [
  /开玩笑/g, /逗你/g, /逗你的/g, /别当真/g, /随口一说/g, /随便说说/g, /玩梗/g,
  /不是真的/g, /反话/g, /口胡/g, /骗你的/g, /说笑的/g, /胡说八道/g,
];

const GUESS_PATTERNS = [
  /我猜/g, /我估计/g, /估计是/g, /说不定/g, /可能吧/g, /不确定/g, /记不清/g,
  /大概是/g, /应该是/g, /应该是吧/g, /也许/g, /好像/g,
];

const QUOTED_PATTERNS = [
  /他说/g, /她说/g, /他们说/g, /别人说/g, /有人说/g, /网上说/g, /听说/g, /据说/g,
  /新闻说/g, /新闻上/g, /书里说/g, /据.{0,4}说/g, /我(?:的)?(?:朋友|同事|同学|室友|家人|妈|爸|哥|姐|弟|妹)/g,
];

const PLAN_INTENT_PATTERNS = [
  /打算/g, /计划/g, /准备(?:要|去|做|买|学|搬|辞|考|见)/g, /要约/g, /约好/g,
  /说好了?/g, /回头(?:再|去|给)/g, /下次一起/g, /一起去/g, /一起看/g,
  /等我/g, /想去看/g, /想去/g, /要去/g, /会去/g, /会来/g, /见面/g,
];

const FUTURE_TIME_PATTERNS = [
  /明天/g, /后天/g, /大后天/g, /下周/g, /下星期/g, /下个月/g, /明年/g, /今晚/g,
  /晚点/g, /回头/g, /待会/g, /一会儿/g, /下次/g, /以后/g, /将来/g,
];

const SENSITIVE_EMOTION_PATTERNS = [
  /难过/g, /难受/g, /伤心/g, /想哭/g, /哭了/g, /崩溃/g, /焦虑/g, /失眠/g,
  /睡不着/g, /压力(?:很|好|大)/g, /烦死/g, /好烦/g, /孤独/g, /委屈/g, /痛苦/g,
  /绝望/g, /抑郁/g, /心累/g, /撑不住/g, /害怕/g, /恐惧/g, /分手/g, /吵架/g,
  /生病/g, /住院/g, /手术/g, /去世/g,
];

const PRIVACY_PATTERNS = [
  /别告诉/g, /不要告诉/g, /别跟别人说/g, /别说出去/g, /保密/g, /秘密/g,
  /不想提/g, /不想说/g, /别问/g, /删掉/g, /只有你知道/g, /就当没发生/g,
];

const REMEMBER_REQUEST_PATTERNS = [
  /记住/g, /记一下/g, /记着/g, /别忘了/g, /帮我记/g, /存一下/g, /保存下/g,
];

/** Markers that let a world-bound session still write real user facts. */
const REALITY_MARKERS = [/现实里/g, /现实中/g, /现实世界/g, /真人/g, /三次元/g];

const DECISION_SEVERITY = { accept: 0, pending: 1, reject: 2 };

// --- small helpers -----------------------------------------------------------

function pickField(raw, ...names) {
  for (const name of names) {
    if (raw[name] !== undefined && raw[name] !== null) return { name, value: raw[name] };
  }
  return { name: names[0], value: undefined };
}

function toUnitNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function collectHits(patterns, text) {
  const source = String(text ?? '');
  if (!source) return [];
  const hits = new Set();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const found = source.match(pattern);
    if (found) for (const item of found) hits.add(item.trim());
  }
  return [...hits];
}

function hasHan(value) {
  return /\p{Script=Han}/u.test(String(value ?? ''));
}

/**
 * Is this evidence row a genuine conversation turn (usable as first-hand proof
 * of a user statement)? Migrated archive rows (`role='imported'`), system rows
 * and anything with an import/manual/system source kind are *material*, not a
 * new statement: they may hint at a fact but must not confirm one.
 */
export function isConversationEvidence({ role, sourceKind } = {}) {
  const roleLabel = String(role ?? '').trim().toLowerCase();
  const kind = String(sourceKind ?? '').trim().toLowerCase();
  if (!CONVERSATION_ROLES.includes(roleLabel)) return false;
  if (NON_CONVERSATION_SOURCE_KINDS.includes(kind)) return false;
  return true;
}

function splitClauses(text) {
  return String(text ?? '')
    .split(/[。！？!?；;\n，,、]+/)
    .map(clause => clause.trim())
    .filter(Boolean);
}

function shareTerms(value, clause) {
  const valueTerms = new Set(terms(value));
  if (!valueTerms.size) return 0;
  const clauseTerms = new Set(terms(clause));
  let shared = 0;
  for (const term of valueTerms) if (clauseTerms.has(term)) shared++;
  return shared;
}

/**
 * Plan markers only count for a candidate when they sit in the same clause as
 * the candidate's own wording. A message like "下周打算去杭州看展，对了我不喝咖啡"
 * must not turn the coffee preference into a commitment.
 */
function planSupportingHits(value, evidenceRows) {
  const hits = new Set();
  const needed = Math.min(2, Math.max(1, new Set(terms(value)).size));
  for (const row of evidenceRows) {
    for (const clause of splitClauses(row.content)) {
      const clauseHits = collectHits(PLAN_INTENT_PATTERNS, clause);
      if (!clauseHits.length) continue;
      if (shareTerms(value, clause) < needed) continue;
      for (const hit of clauseHits) hits.add(hit);
    }
  }
  return [...hits];
}

/** Put the decisive reasons first so operators read the outcome immediately. */
function orderReasons(reasons) {
  const weight = reason => (reason.startsWith('拒绝') ? 0 : reason.startsWith('待定') ? 1 : reason.startsWith('接受') ? 3 : 2);
  return reasons
    .map((reason, index) => ({ reason, index, weight: weight(reason) }))
    .sort((a, b) => a.weight - b.weight || a.index - b.index)
    .map(item => item.reason);
}

/** Normalize an evidence row that may use snake_case (db row) or camelCase. */
export function normalizeEvidenceRow(row) {
  if (!row || typeof row !== 'object') return null;
  const read = (...names) => {
    for (const name of names) {
      if (row[name] !== undefined && row[name] !== null) return row[name];
    }
    return undefined;
  };
  const sourceId = read('sourceId', 'source_id', 'id');
  if (sourceId === undefined || sourceId === '') return null;
  // Keep the original role label (`imported`, `system`, `tool`, ...): rewriting
  // an unknown role to 'user' would launder migrated material into "the user
  // said so" and resurrect the very trust level the importer downgraded.
  const roleRaw = String(read('role') ?? '').trim().toLowerCase();
  const sourceKind = String(read('sourceKind', 'source_kind') ?? '').trim().toLowerCase();
  return {
    sourceId: String(sourceId),
    role: roleRaw || sourceKind || 'unknown',
    sourceKind,
    conversation: isConversationEvidence({ role: roleRaw, sourceKind }),
    content: String(read('content', 'text') ?? ''),
    occurredAt: read('occurredAt', 'occurred_at', 'time') ?? null,
    userId: read('userId', 'user_id') ?? undefined,
    personaId: read('personaId', 'persona_id') ?? undefined,
    worldId: read('worldId', 'world_id') ?? undefined,
  };
}

function normalizeEvidenceList(list) {
  if (!Array.isArray(list)) return [];
  const rows = [];
  for (const item of list) {
    const row = normalizeEvidenceRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

/** Does this evidence row belong to the viewer's user/persona/world? */
function belongsToViewer(row, viewer) {
  const userId = viewer?.userId;
  const personaId = viewer?.personaId;
  const worldId = viewer?.worldId ?? '';
  if (userId && row.userId && String(row.userId) !== String(userId)) return false;
  if (personaId && row.personaId && String(row.personaId) !== String(personaId)) return false;
  if (row.worldId !== undefined && row.worldId !== null) {
    if (String(row.worldId ?? '') !== String(worldId ?? '')) return false;
  }
  return true;
}

export function normalizeMentionPolicy(value) {
  if (typeof value !== 'string') return '';
  return MENTION_ALIASES.get(value.trim().toLowerCase()) ?? '';
}

function normalizeValidity(value) {
  if (typeof value !== 'string') return { value: '', known: false };
  const normalized = VALIDITY_ALIASES.get(value.trim().toLowerCase());
  return normalized ? { value: normalized, known: true } : { value: '', known: false };
}

function normalizeOperation(value) {
  if (typeof value !== 'string') return { value: '', known: false };
  const normalized = OPERATION_ALIASES.get(value.trim().toLowerCase());
  return normalized ? { value: normalized, known: true } : { value: '', known: false };
}

function normalizePredicate(value) {
  return String(value ?? '').trim().replace(/\s+/g, '_').toLowerCase();
}

// --- stage 1: structural validation -----------------------------------------

/**
 * Validate one raw candidate emitted by a language model.
 * @returns {{ok: true, candidate: object, warnings: string[]} | {ok: false, errors: string[]}}
 */
export function parseCandidate(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['候选必须是一个 JSON 对象'] };
  }

  const errors = [];
  const warnings = [];

  // kind / scope are storage-critical enums: a wrong value drops the candidate.
  const kindPick = pickField(raw, 'kind', 'type');
  const kindInput = typeof kindPick.value === 'string' ? kindPick.value.trim().toLowerCase() : '';
  const kind = KIND_ALIASES.get(kindInput) ?? '';
  if (!kindPick.value) errors.push('缺少 kind');
  else if (!kind) errors.push(`kind 不在允许范围：${String(kindPick.value)}（允许：${KINDS.join('|')}）`);
  else if (kindPick.name !== 'kind') warnings.push(`字段名建议用 kind（收到 ${kindPick.name}）`);

  const scopePick = pickField(raw, 'scope');
  const scopeInput = typeof scopePick.value === 'string' ? scopePick.value.trim().toLowerCase() : '';
  const scope = SCOPES.includes(scopeInput) ? scopeInput : '';
  if (!scopePick.value) errors.push('缺少 scope');
  else if (!scope) errors.push(`scope 不在允许范围：${String(scopePick.value)}（允许：${SCOPES.join('|')}）`);

  // subject defaults to the user; persona/world rows should say so explicitly.
  const subjectPick = pickField(raw, 'subject', 'entity');
  let subject = 'user';
  if (subjectPick.value === undefined) {
    warnings.push('缺少 subject，按 user 处理');
  } else if (typeof subjectPick.value !== 'string' || !subjectPick.value.trim()) {
    errors.push('subject 必须是非空字符串');
  } else {
    subject = subjectPick.value.trim();
    if (subject.length > MAX_SUBJECT_LENGTH) errors.push(`subject 过长（${subject.length} > ${MAX_SUBJECT_LENGTH} 字）`);
  }

  const predicatePick = pickField(raw, 'predicate', 'key');
  let predicate = '';
  if (predicatePick.value === undefined || predicatePick.value === null) {
    errors.push('缺少 predicate（英文 snake_case，例如 prefers_drink）');
  } else if (typeof predicatePick.value !== 'string') {
    errors.push('predicate 必须是字符串');
  } else {
    predicate = normalizePredicate(predicatePick.value);
    if (!predicate) errors.push('predicate 不能为空');
    else if (predicate.length > MAX_PREDICATE_LENGTH) {
      errors.push(`predicate 过长（${predicate.length} > ${MAX_PREDICATE_LENGTH} 字）`);
    } else if (!/^[a-z][a-z0-9_:.-]*$/.test(predicate)) {
      warnings.push(`predicate 建议使用英文 snake_case（收到 ${predicate.slice(0, 40)}）`);
    }
  }

  let value = '';
  if (raw.value === undefined || raw.value === null) {
    errors.push('缺少 value');
  } else if (typeof raw.value === 'number' && Number.isFinite(raw.value)) {
    value = String(raw.value);
    warnings.push('value 是数字，已转成字符串');
  } else if (typeof raw.value !== 'string') {
    errors.push('value 必须是字符串');
  } else {
    value = raw.value.trim();
    if (!value) errors.push('value 不能为空');
    else if (value.length > MAX_VALUE_LENGTH) {
      errors.push(`value 过长（${value.length} > ${MAX_VALUE_LENGTH} 字）`);
    }
    const redacted = redactSecrets(value);
    if (redacted !== value) {
      value = redacted;
      warnings.push('value 中的密钥/密码已脱敏');
    }
  }

  const evidencePick = pickField(raw, 'evidence_source_ids', 'evidenceSourceIds', 'evidence_ids', 'source_ids');
  let evidenceIds = [];
  if (evidencePick.value === undefined) {
    errors.push('缺少 evidence_source_ids：每条候选都必须引用 messages 里的 id');
  } else {
    const list = Array.isArray(evidencePick.value)
      ? evidencePick.value
      : (typeof evidencePick.value === 'string' || typeof evidencePick.value === 'number'
        ? [evidencePick.value]
        : null);
    if (!list) {
      errors.push('evidence_source_ids 必须是字符串数组');
    } else {
      const ids = [];
      for (const item of list) {
        if (typeof item === 'string' || typeof item === 'number') {
          const id = String(item).trim();
          if (id) ids.push(id);
        } else {
          errors.push('evidence_source_ids 只能包含字符串 id');
        }
      }
      evidenceIds = [...new Set(ids)];
      if (!evidenceIds.length) errors.push('evidence_source_ids 不能为空：至少引用一条真实消息 id');
      if (evidenceIds.length > MAX_EVIDENCE_IDS) {
        warnings.push(`证据 id 超过 ${MAX_EVIDENCE_IDS} 个，已截断`);
        evidenceIds = evidenceIds.slice(0, MAX_EVIDENCE_IDS);
      }
      if (evidencePick.name !== 'evidence_source_ids') {
        warnings.push(`字段名建议用 evidence_source_ids（收到 ${evidencePick.name}）`);
      }
    }
  }

  let confidence = MIN_ACCEPT_CONFIDENCE;
  const confidencePick = pickField(raw, 'confidence', 'score');
  if (confidencePick.value === undefined) {
    warnings.push('缺少 confidence，按 0.5 处理');
  } else {
    const number = toUnitNumber(confidencePick.value);
    if (number === null) errors.push(`confidence 必须是数字（收到 ${JSON.stringify(confidencePick.value)}）`);
    else if (number < 0 || number > 1) errors.push(`confidence 必须在 0..1 之间（收到 ${number}）`);
    else confidence = number;
  }

  const kindForDefaults = kind || 'fact';
  let importance = defaultImportance(kindForDefaults);
  const importancePick = pickField(raw, 'importance');
  if (importancePick.value === undefined) {
    warnings.push(`缺少 importance，按 ${importance} 处理`);
  } else {
    const number = toUnitNumber(importancePick.value);
    if (number === null) errors.push(`importance 必须是数字（收到 ${JSON.stringify(importancePick.value)}）`);
    else if (number < 0 || number > 1) errors.push(`importance 必须在 0..1 之间（收到 ${number}）`);
    else importance = number;
  }

  let validity = 'current';
  const validityPick = pickField(raw, 'validity');
  if (validityPick.value === undefined) {
    warnings.push('缺少 validity，按 current 处理');
  } else {
    const normalized = normalizeValidity(validityPick.value);
    if (!normalized.known) {
      errors.push(`validity 不在允许范围：${String(validityPick.value)}（允许：${VALIDITY_VALUES.join('|')}）`);
    } else {
      validity = normalized.value;
    }
  }

  let suggestedOperation = 'upsert';
  const operationPick = pickField(raw, 'suggested_operation', 'suggestedOperation', 'operation');
  if (operationPick.value === undefined) {
    warnings.push('缺少 suggested_operation，按 upsert 处理');
  } else {
    const normalized = normalizeOperation(operationPick.value);
    // Advisory only: an unknown operation degrades to upsert instead of dropping data.
    if (!normalized.known) warnings.push(`suggested_operation 无法识别（${String(operationPick.value)}），按 upsert 处理`);
    else suggestedOperation = normalized.value;
  }

  let mentionPolicy = '';
  const mentionPick = pickField(raw, 'mention_policy', 'mentionPolicy');
  if (mentionPick.value === undefined) {
    warnings.push('缺少 mention_policy，将由闸门按默认策略补齐');
  } else {
    const normalized = normalizeMentionPolicy(mentionPick.value);
    if (!normalized) warnings.push(`mention_policy 无法识别（${String(mentionPick.value)}），将由闸门按默认策略补齐`);
    else mentionPolicy = normalized;
  }

  const unknownFields = Object.keys(raw).filter(key => !STRUCTURAL_FIELDS.has(key));
  if (unknownFields.length) warnings.push(`已忽略未知字段：${unknownFields.join(', ')}`);

  if (errors.length) return { ok: false, errors };
  if (hasHan(predicate)) warnings.push('predicate 含中文，建议改成英文 snake_case 以便跨版本复用');

  const candidate = {
    kind,
    scope,
    subject,
    predicate,
    value,
    evidence_source_ids: evidenceIds,
    confidence,
    importance,
    validity,
    suggested_operation: suggestedOperation,
    mention_policy: mentionPolicy,
    schema_version: CANDIDATE_SCHEMA_VERSION,
  };
  return { ok: true, candidate, warnings };
}

// --- stage 2: promotion gate -------------------------------------------------

function resolveThresholds(context) {
  const config = context?.config ?? {};
  const extraction = config.extraction ?? config;
  const gate = extraction?.gate ?? {};
  const minAcceptConfidence = toUnitNumber(gate.minAcceptConfidence ?? extraction?.minAcceptConfidence);
  const minEvidenceCount = toUnitNumber(gate.minEvidenceCount ?? extraction?.minEvidenceCount);
  return {
    minAcceptConfidence: minAcceptConfidence === null
      ? MIN_ACCEPT_CONFIDENCE
      : Math.min(1, Math.max(0, minAcceptConfidence)),
    minEvidenceCount: minEvidenceCount === null ? 1 : Math.max(1, Math.round(minEvidenceCount)),
  };
}

function inferRealityLevel({ kind, scope, flags, confidence }) {
  if (scope === 'roleplay_world') return 'roleplay_fiction';
  if (kind === 'bot_action' || kind === 'artifact') return 'bot_action';
  if (flags.guess.length) return 'inferred';
  // Imported/system material can never lift a row to "the user stated it".
  if (flags.nonConversationEvidence.length) {
    return flags.conversationEvidence ? 'user_utterance_not_verified_fact' : 'imported_summary';
  }
  if (flags.rememberRequest.length && confidence >= 0.6) return 'explicit_user_statement';
  if (confidence >= 0.9 && flags.evidenceCount >= 2) return 'explicit_user_statement';
  return 'user_utterance_not_verified_fact';
}

/**
 * Decide whether one validated candidate may become a stored fact.
 *
 * @param {object} candidate parsed candidate (parseCandidate output)
 * @param {object} context   { evidence, viewer, now, config }
 * @returns {{decision: 'accept'|'pending'|'reject', reasons: string[],
 *            normalized: object|null, flags: object}}
 */
export function gateCandidate(candidate, context = {}) {
  const reasons = [];
  const flags = {
    evidenceCount: 0,
    missingIds: [],
    foreignIds: [],
    roleplay: [],
    roleplayStrong: [],
    roleplayWeak: [],
    joke: [],
    guess: [],
    quoted: [],
    plan: [],
    future: [],
    sensitive: [],
    privacy: [],
    rememberRequest: [],
    assistantOnly: false,
    worldBoundSession: false,
    conversationEvidence: 0,
    nonConversationEvidence: [],
  };

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { decision: 'reject', reasons: ['候选不是对象，无法入库'], normalized: null, flags };
  }

  let decision = 'accept';
  const escalate = (level, reason) => {
    if (DECISION_SEVERITY[level] > DECISION_SEVERITY[decision]) decision = level;
    if (reason) reasons.push(reason);
  };

  const viewer = context.viewer ?? {};
  const thresholds = resolveThresholds(context);
  const viewerWorld = String(viewer.worldId ?? '');

  const kindInput = String(candidate.kind ?? '').trim();
  const kind = KINDS.includes(kindInput) ? kindInput : '';
  if (!kind) escalate('reject', `拒绝入库：kind 无效（${kindInput || '空'}）`);

  const scopeInput = String(candidate.scope ?? '').trim();
  const scope = SCOPES.includes(scopeInput) ? scopeInput : '';
  if (!scope) escalate('reject', `拒绝入库：scope 无效（${scopeInput || '空'}）`);

  const subject = String(candidate.subject ?? 'user').trim() || 'user';
  const predicate = normalizePredicate(candidate.predicate);
  // The gate may receive a raw candidate (not put through parseCandidate), so
  // apply the same secret redaction before anything can be stored.
  const value = redactSecrets(String(candidate.value ?? '').trim());
  if (!predicate) escalate('reject', '拒绝入库：predicate 为空，无法做冲突判定');
  if (!value) escalate('reject', '拒绝入库：value 为空');

  let confidence = toUnitNumber(candidate.confidence);
  if (confidence === null) confidence = MIN_ACCEPT_CONFIDENCE;
  confidence = Math.min(1, Math.max(0, confidence));
  let importance = toUnitNumber(candidate.importance);
  if (importance === null) importance = defaultImportance(kind || 'fact');
  importance = Math.min(1, Math.max(0, importance));
  const validityInput = normalizeValidity(candidate.validity).value || 'current';
  const suggestedOperation = normalizeOperation(candidate.suggested_operation).value || 'upsert';
  let mentionPolicy = normalizeMentionPolicy(candidate.mention_policy);

  // --- evidence ownership ---------------------------------------------------
  const citedIds = Array.isArray(candidate.evidence_source_ids)
    ? candidate.evidence_source_ids.map(id => String(id)).filter(Boolean)
    : [];
  const evidenceById = new Map();
  for (const row of normalizeEvidenceList(context.evidence)) {
    if (!evidenceById.has(row.sourceId)) evidenceById.set(row.sourceId, row);
  }
  const found = [];
  for (const id of citedIds) {
    const row = evidenceById.get(id);
    if (!row) {
      flags.missingIds.push(id);
      continue;
    }
    if (!belongsToViewer(row, viewer)) {
      flags.foreignIds.push(id);
      continue;
    }
    found.push(row);
  }
  flags.evidenceCount = found.length;
  const foundIds = found.map(row => row.sourceId);

  if (!citedIds.length) {
    escalate('pending', '待定：候选没有引用任何证据消息，不能直接成为事实');
  } else if (!found.length && flags.foreignIds.length) {
    escalate('reject', `拒绝入库：证据属于其它用户/角色/世界（${flags.foreignIds.join(', ')}），不能写入当前记忆`);
  } else if (!found.length) {
    escalate('pending', `待定：找不到引用的证据消息（${flags.missingIds.slice(0, 3).join(', ')}），可能是编造或已过期`);
  } else if (flags.missingIds.length || flags.foreignIds.length) {
    const parts = [];
    if (flags.missingIds.length) parts.push(`缺失 ${flags.missingIds.slice(0, 3).join(', ')}`);
    if (flags.foreignIds.length) parts.push(`越界 ${flags.foreignIds.slice(0, 3).join(', ')}`);
    escalate('pending', `待定：部分证据无法核对（${parts.join('；')}），需人工确认`);
  }

  // User facts need the user as the speaker; the persona's own lines are not evidence.
  if (REAL_USER_SCOPES.has(scope) && found.length) {
    flags.assistantOnly = found.every(row => row.role === 'assistant');
    if (flags.assistantOnly) {
      escalate('pending', '待定：只有角色自己的发言（assistant）作为证据，不能当作用户事实');
    }
  }

  // Migrated archive rows (`role='imported'`), system/manual material and any
  // unknown role are material, not a fresh user statement: they may point at a
  // fact but can never confirm one on their own.
  if (found.length) {
    const conversationRows = found.filter(row => row.conversation);
    flags.conversationEvidence = conversationRows.length;
    flags.nonConversationEvidence = found.filter(row => !row.conversation).map(row => row.sourceId);
    if (!conversationRows.length) {
      escalate('pending', '待定[non_conversation_evidence]：证据全部来自迁移旧记录或系统材料，不能作为新的用户陈述');
    } else if (flags.nonConversationEvidence.length) {
      reasons.push(`提示：部分证据来自迁移旧记录或系统材料（${flags.nonConversationEvidence.slice(0, 3).join(', ')}），信任等级按未核实处理`);
    }
  }

  // --- scope / kind coherence ----------------------------------------------
  if (REAL_USER_SCOPES.has(scope) && (kind === 'bot_action' || kind === 'artifact')) {
    escalate('reject', `拒绝入库：kind=${kind} 属于角色自身行为或产物，不能写入用户现实作用域 ${scope}`);
  }
  if (scope === 'user_global' && subject === 'persona') {
    escalate('pending', '待定：subject=persona 的内容应写入 user_persona 或 persona_self，而不是 user_global');
  }
  if (scope === 'roleplay_world' && !viewerWorld) {
    escalate('pending', '待定：当前会话没有绑定剧情世界（worldId 为空），剧情记忆无法归属');
  }
  if (suggestedOperation === 'ignore') {
    escalate('reject', '拒绝入库：模型建议忽略这条候选');
  }
  if (validityInput === 'uncertain') {
    escalate('pending', '待定：候选自评 validity=uncertain，需要更多证据才能成为事实');
  }

  // --- reality classification (plan §5.3) ----------------------------------
  const candidateText = `${predicate} ${value} ${subject}`;
  const evidenceText = found.map(row => row.content).join('\n');
  flags.roleplayStrong = [...new Set([
    ...collectHits(ROLEPLAY_STRONG_PATTERNS, candidateText),
    ...collectHits(ROLEPLAY_STRONG_PATTERNS, evidenceText),
  ])];
  flags.roleplayWeak = [...new Set([
    ...collectHits(ROLEPLAY_WEAK_PATTERNS, candidateText),
    ...collectHits(ROLEPLAY_WEAK_PATTERNS, evidenceText),
  ])];
  flags.roleplay = [...new Set([...flags.roleplayStrong, ...flags.roleplayWeak])];
  flags.joke = [...new Set([...collectHits(JOKE_PATTERNS, candidateText), ...collectHits(JOKE_PATTERNS, evidenceText)])];
  flags.guess = [...new Set([...collectHits(GUESS_PATTERNS, candidateText), ...collectHits(GUESS_PATTERNS, evidenceText)])];
  flags.quoted = [...new Set([...collectHits(QUOTED_PATTERNS, candidateText), ...collectHits(QUOTED_PATTERNS, evidenceText)])];
  flags.plan = [...new Set([
    ...planSupportingHits(value, found),
    // If the model already classified the candidate as a promise, a plan marker
    // anywhere in its evidence is enough to require validity=planned.
    ...(kind === 'commitment' ? collectHits(PLAN_INTENT_PATTERNS, evidenceText) : []),
  ])];
  flags.future = collectHits(FUTURE_TIME_PATTERNS, evidenceText);
  flags.rememberRequest = collectHits(REMEMBER_REQUEST_PATTERNS, evidenceText);

  const sensitiveFromCandidate = collectHits(SENSITIVE_EMOTION_PATTERNS, candidateText);
  const sensitiveFromEvidence = collectHits(SENSITIVE_EMOTION_PATTERNS, evidenceText);
  const sensitiveKind = ['note', 'event', 'summary', 'relationship'].includes(kind);
  flags.sensitive = sensitiveFromCandidate.length
    ? sensitiveFromCandidate
    : (sensitiveKind ? sensitiveFromEvidence : []);
  flags.privacy = [...new Set([...collectHits(PRIVACY_PATTERNS, candidateText), ...collectHits(PRIVACY_PATTERNS, evidenceText)])];
  flags.worldBoundSession = Boolean(viewerWorld);

  if (flags.roleplay.length) {
    const hit = flags.roleplay.slice(0, 3).join('、');
    const strong = flags.roleplayStrong.length > 0;
    if (scope === 'roleplay_world') {
      reasons.push(`剧情内容（命中：${hit}）在 roleplay_world 作用域内正常记录，不会进入现实召回`);
    } else if (scope === 'persona_self') {
      escalate('pending', `待定：剧情场景里的角色表现（命中：${hit}）不能直接沉淀为角色自我记忆`);
    } else if (strong || flags.worldBoundSession) {
      escalate('reject', `拒绝入库：证据带剧情/角色扮演标记（命中：${hit}），不能提升为用户现实事实（scope=${scope}）；如需保留请把 scope 写成 roleplay_world`);
    } else {
      escalate('pending', `待定：证据提到剧情或设定（命中：${hit}），需确认是现实陈述还是剧情内容`);
    }
  }

  if (flags.worldBoundSession && REAL_USER_SCOPES.has(scope) && scope !== 'session_recent') {
    const realityHits = collectHits(REALITY_MARKERS, evidenceText);
    if (!realityHits.length && !flags.roleplay.length) {
      escalate('pending', `待定：当前会话绑定在剧情世界（worldId=${viewerWorld}），现实事实需要用户明确说明（例如“现实里…”）`);
    }
  }

  const formalKinds = ['fact', 'profile', 'preference', 'relationship', 'commitment'];
  if (formalKinds.includes(kind)) {
    if (flags.quoted.length) {
      escalate('pending', `待定：引用他人说法（命中：${flags.quoted.slice(0, 2).join('、')}），需用户本人确认后才算用户事实`);
    }
    if (flags.joke.length) {
      escalate('pending', `待定：可能是玩笑（命中：${flags.joke.slice(0, 2).join('、')}），不能直接写为事实`);
    }
    if (flags.guess.length) {
      escalate('pending', `待定：含推测语气（命中：${flags.guess.slice(0, 2).join('、')}），不能直接写为事实`);
    }
  }

  // --- future plans become commitments -------------------------------------
  let normalizedKind = kind || 'fact';
  let normalizedValidity = validityInput;
  const planned = validityInput === 'planned'
    || flags.plan.length > 0
    || (flags.future.length > 0 && kind === 'commitment');
  if (planned) {
    const why = flags.plan.length ? flags.plan.slice(0, 2).join('、') : 'validity=planned';
    normalizedKind = 'commitment';
    normalizedValidity = 'planned';
    reasons.push(`记录为未完成约定（kind=commitment、validity=planned、mentionPolicy=soft_echo）：证据含未来指向（命中：${why}）`);
  }

  // --- sensitive material only colours the tone ----------------------------
  if (flags.privacy.length) {
    mentionPolicy = 'avoid_unless_asked';
    reasons.push(`表达策略改为 avoid_unless_asked：用户表示不愿公开（命中：${flags.privacy.slice(0, 2).join('、')}）`);
  } else if (flags.sensitive.length) {
    mentionPolicy = 'tone_only';
    reasons.push(`表达策略改为 tone_only：含敏感情绪（命中：${flags.sensitive.slice(0, 2).join('、')}），只影响语气不主动披露`);
  } else if (planned) {
    mentionPolicy = 'soft_echo';
  }

  if (!flags.evidenceCount) {
    // Nothing else can rescue a candidate without evidence.
    if (decision === 'accept') escalate('pending', '待定：没有可核对证据');
  }

  if (confidence < thresholds.minAcceptConfidence) {
    escalate('pending', `待定：模型置信度偏低（${confidence} < ${thresholds.minAcceptConfidence}），先进入待定区`);
  } else if (flags.evidenceCount < thresholds.minEvidenceCount) {
    escalate('pending', `待定：证据条数不足（${flags.evidenceCount} < ${thresholds.minEvidenceCount}）`);
  }

  // --- finalize normalized draft -------------------------------------------
  const realityLevel = inferRealityLevel({ kind: normalizedKind, scope, flags, confidence });
  if (scope === 'roleplay_world') {
    if (mentionPolicy === 'direct') mentionPolicy = 'soft_echo';
  }
  if (!mentionPolicy) {
    mentionPolicy = defaultMentionPolicy({ kind: normalizedKind, realityLevel, scope });
  }

  if (decision === 'accept') {
    const evidenceNote = flags.evidenceCount ? `证据 ${flags.evidenceCount} 条` : '无证据';
    reasons.push(`接受：证据与作用域校验通过（scope=${scope}，${evidenceNote}）`);
  }

  const normalized = {
    kind: normalizedKind,
    scope,
    subject,
    predicate,
    value,
    confidence,
    importance,
    validity: normalizedValidity,
    mentionPolicy,
    realityLevel,
    status: decision === 'accept' ? 'confirmed' : (decision === 'pending' ? 'pending' : null),
    evidenceSourceIds: foundIds,
    suggestedOperation,
    decision,
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
  };

  return { decision, reasons: orderReasons(reasons), normalized, flags };
}

// --- stage 3: merge against an existing row ---------------------------------

export function isMultiValueAttribute({ kind, predicate } = {}) {
  const normalized = normalizePredicate(predicate);
  if (!normalized) return MULTI_VALUE_KINDS.includes(kind);
  if (normalized.startsWith('multi:')) return true;
  const head = normalized.split(':')[0];
  if (MULTI_VALUE_PREDICATES.has(normalized) || MULTI_VALUE_PREDICATES.has(head)) return true;
  if (MULTI_VALUE_KINDS.includes(kind)) return true;
  return false;
}

function draftOf(input) {
  if (!input || typeof input !== 'object') return null;
  const read = (...names) => {
    for (const name of names) {
      if (input[name] !== undefined && input[name] !== null) return input[name];
    }
    return undefined;
  };
  const evidenceRaw = read('evidenceSourceIds', 'evidence_source_ids', 'evidenceIds', 'evidence_ids');
  let evidenceIds = Array.isArray(evidenceRaw)
    ? evidenceRaw.map(id => String(id)).filter(Boolean)
    : [];
  if (!evidenceIds.length) {
    // Storage drafts keep a single representative `sourceId`; treat it as the
    // evidence anchor so a caller cannot silently lose the "has evidence" signal.
    const single = read('sourceId', 'source_id');
    if (single !== undefined && String(single).trim()) evidenceIds = [String(single)];
  }
  return {
    id: read('id'),
    kind: String(read('kind') ?? ''),
    scope: String(read('scope') ?? ''),
    subject: String(read('subject') ?? 'user'),
    predicate: normalizePredicate(read('predicate')),
    value: String(read('value') ?? ''),
    confidence: toUnitNumber(read('confidence')),
    status: read('status') ?? '',
    mentionPolicy: read('mentionPolicy', 'mention_policy') ?? '',
    decision: String(read('decision') ?? ''),
    evidenceSourceIds: evidenceIds,
    updatedAt: read('updatedAt', 'updated_at') ?? '',
  };
}

function sameKey(a, b) {
  if (!a || !b) return false;
  return a.scope === b.scope
    && a.subject === b.subject
    && a.predicate === b.predicate
    && a.predicate !== '';
}

function isConfirmed(row) {
  return row.status === 'confirmed' || row.status === '';
}

/**
 * Decide how an incoming candidate relates to already stored rows.
 * `existing` may be a single record, an array of same-key records, or null.
 *
 * @returns {{operation: 'insert'|'update'|'supersede'|'duplicate'|'conflict',
 *            targetId?: string, reasons: string[]}}
 */
export function mergeDecision({ incoming, existing } = {}) {
  const draft = draftOf(incoming);
  if (!draft || !draft.value) {
    return { operation: 'conflict', reasons: ['没有可合并的候选（value 为空）'] };
  }
  const rows = (Array.isArray(existing) ? existing : [existing])
    .map(row => (row && typeof row === 'object' ? { ...row, _draft: draftOf(row) } : null))
    .filter(row => row && row._draft);
  const keys = rows.filter(row => row._draft.predicate);
  const sameKeys = keys.filter(row => sameKey(draft, row._draft));

  if (!rows.length) {
    return { operation: 'insert', reasons: ['没有同键既有记录，直接插入'] };
  }
  if (!sameKeys.length) {
    return { operation: 'insert', reasons: ['既有记录 predicate/scope 不同，不构成同键冲突'] };
  }

  const incomingValue = normalizeText(draft.value);
  // A same-value row that is still current means there is nothing to write.
  // Superseded/archived rows are ignored on purpose: switching back to an old
  // value must produce a new current row, not a silent no-op.
  const duplicate = sameKeys.find(row => isConfirmed(row._draft) && normalizeText(row._draft.value) === incomingValue);
  if (duplicate) {
    return {
      operation: 'duplicate',
      targetId: duplicate.id ?? undefined,
      reasons: ['同 predicate 下已有相同值，跳过重复写入'],
    };
  }
  const pendingSameValue = sameKeys.find(
    row => row._draft.status === 'pending' && normalizeText(row._draft.value) === incomingValue,
  );

  const evidenceCount = draft.evidenceSourceIds.length;
  if (!evidenceCount) {
    return {
      operation: 'conflict',
      reasons: ['候选没有证据，不能自动覆盖既有值，交由人工或后续批次确认'],
    };
  }
  if (draft.decision === 'pending' || draft.status === 'pending') {
    return {
      operation: 'conflict',
      reasons: ['候选仍处于待定状态（证据或置信度不足），不与已入库值自动合并'],
    };
  }
  if (draft.confidence !== null && draft.confidence < MIN_ACCEPT_CONFIDENCE) {
    return {
      operation: 'conflict',
      reasons: [`候选置信度偏低（${draft.confidence} < ${MIN_ACCEPT_CONFIDENCE}），需人工确认后再覆盖`],
    };
  }

  const confirmed = sameKeys.filter(row => isConfirmed(row._draft));
  const pending = sameKeys.filter(row => row._draft.status === 'pending');
  if (pendingSameValue) {
    return {
      operation: 'update',
      targetId: pendingSameValue.id ?? undefined,
      reasons: ['已有同值待定记录，证据已充分：把该条升级为确认事实（update）'],
    };
  }
  if (!confirmed.length) {
    if (pending.length) {
      return {
        operation: 'conflict',
        reasons: ['同键既有记录仍在待定状态，不能自动覆盖新值'],
      };
    }
    return { operation: 'insert', reasons: ['同键既有记录已归档或被取代，新建当前记录'] };
  }

  const target = confirmed
    .slice()
    .sort((a, b) => String(b._draft.updatedAt).localeCompare(String(a._draft.updatedAt)))[0];
  if (isMultiValueAttribute({ kind: draft.kind, predicate: draft.predicate })) {
    return {
      operation: 'insert',
      targetId: target.id ?? undefined,
      reasons: ['多值属性（兴趣/约定/事件等）允许并存，去重后退旧值仍有效，新值另起一条记录'],
    };
  }
  return {
    operation: 'supersede',
    targetId: target.id ?? undefined,
    reasons: ['单值稳定属性的新值与既有值冲突，走修订链：旧值转 superseded，新值成为当前事实'],
  };
}

/** Stable grouping key used by callers to look up same-key rows. */
export function factKey(record) {
  const scope = String(record?.scope ?? '');
  const subject = String(record?.subject ?? 'user');
  const predicate = normalizePredicate(record?.predicate);
  return `${scope}|${subject}|${predicate}`;
}
