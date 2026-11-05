// Tests for the legacy -> structured memory migration (CONTRACT.md §7).
//
// Data policy for this file:
//   * Exact-count tests (dedupe, refresh, idempotency, CLI) use a small synthetic
//     fixture written into a temp directory, so they never depend on how long the
//     live conversation journal happens to be.
//   * The real local corpus (`home/memory/astrbot-import.json`,
//     `home/memory/conversation.jsonl`) is only read, never modified, and its
//     expectations are computed at runtime. The live journal grows every time the
//     desktop writes a message, so hard-coded totals here would rot. When the real
//     files are missing those tests `t.skip` instead of failing.
//   * Every write goes to a temporary directory or to the in-memory fake of the
//     CONTRACT §6 database; when `lib/db.mjs` exists, extra tests exercise the real
//     SQLite store inside a temp directory.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  IMPORT_MANIFEST_VERSION, IMPORT_TAG, SUMMARY_IMPORTANCE_CAP, aggregateDrafts, classifyArchiveRow,
  classifyConversationRecord, createBackup, formatStamp, mapArchiveRow, mapConversationRecord, mapStateFact,
  readLegacyState, reconciliation, runImport,
} from '../lib/import.mjs';
import { toSourceEvent } from '../lib/capture.mjs';
import { contentHash } from '../lib/text.mjs';
import { isActive, isPromptEligible } from '../lib/policy.mjs';

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../..');
const REAL_ARCHIVE = path.join(REPO_ROOT, 'home/memory/astrbot-import.json');
const REAL_CONVERSATION = path.join(REPO_ROOT, 'home/memory/conversation.jsonl');
const REAL_IDENTITY = path.join(REPO_ROOT, 'home/companion/identity.json');
const REAL_DB_MODULE = path.join(PLUGIN_ROOT, 'lib/db.mjs');
const CLI = path.join(PLUGIN_ROOT, 'scripts/migrate-memory.mjs');

const USER_ID = '10001';
const PERSONA_ID = 'bot';
const CLOCK = Date.parse('2026-10-27T16:39:12Z');
const STAMP = '20261027T163912Z';

// ---------------------------------------------------------------------------
// temp roots, synthetic fixtures and the read-only real corpus
// ---------------------------------------------------------------------------

function tempRoot(t, prefix = 'dsh-companion-import-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function journalRecord({ sessionId, seq, role, text }) {
  return {
    id: `${sessionId}:${seq}`,
    sessionId,
    seq,
    at: '2026-10-25T09:17:05.655Z',
    role,
    text,
    source: 'desktop_conversation',
    persona: PERSONA_ID,
    userId: USER_ID,
  };
}

/** One legacy archive row in the shape `scripts/import-astrbot-memory.py` wrote. */
function archiveRow({
  sourceId, memoryType, value, evidence = '', importance, confidence,
  occurredAt = '2026-06-20T10:00:00+08:00', updatedAt = '2026-08-19T04:18:11+00:00',
  validTo = '', tags = [], owner = USER_ID, persona = PERSONA_ID,
}) {
  return {
    id: `astrbot:${sourceId}`, sourceId, key: memoryType, value, evidence, memoryType,
    realityLevel: 'real_user_fact', sayability: 'direct', occurredAt, updatedAt, validTo,
    importance, confidence, tags, persona, owner, bot: '2668517323', source: 'astrbot_snapshot',
    sourceSession: '', sourceOwnerId: '', sourcePlatform: '',
  };
}

/**
 * Deterministic archive covering every mapping branch. `summaries` controls how
 * many `conversation_summary` rows exist (they exercise the 0.6 importance cap).
 */
function buildArchiveFixture({ summaries = 4 } = {}) {
  const memories = [
    archiveRow({
      sourceId: 'mem_core_1', memoryType: 'core_memory', value: '用户偏好热茶',
      evidence: '记住：我更喜欢喝茶', importance: 0.85, confidence: 1, tags: ['core_memory'],
    }),
    archiveRow({ sourceId: 'mem_core_2', memoryType: 'core_memory', value: '用户作息偏晚', importance: 0.82, confidence: 1 }),
    archiveRow({ sourceId: 'mem_profile_1', memoryType: 'user_profile', value: '用户喜欢角色扮演', importance: 0.9, confidence: 0.9 }),
    archiveRow({ sourceId: 'mem_pref_1', memoryType: 'user_preference', value: '用户希望多收到消息', importance: 0.8, confidence: 0.9 }),
    archiveRow({ sourceId: 'mem_fact_1', memoryType: 'explicit_memory', value: '用户约定今晚早睡', importance: 0.95, confidence: 0.9 }),
    archiveRow({
      sourceId: 'mem_fact_expired_1', memoryType: 'explicit_memory', value: '已经过期的旧约定',
      importance: 0.9, confidence: 0.9, validTo: '2026-02-01T00:00:00+08:00',
    }),
    archiveRow({ sourceId: 'mem_rel_1', memoryType: 'relationship_claim', value: '双方确认恋爱关系', importance: 0.9, confidence: 0.95 }),
    archiveRow({
      sourceId: 'mem_tool_1', memoryType: 'tool_memory', value: '用户在私聊里更偏好某类照片',
      evidence: '要是平时多给我发一些就好了', importance: 0.72, confidence: 0.62,
    }),
    archiveRow({ sourceId: 'mem_bot_1', memoryType: 'proactive_message', value: 'Bot 主动发送：夜深了', importance: 0.57, confidence: 0.92 }),
    archiveRow({ sourceId: 'mem_bot_2', memoryType: 'proactive_message', value: 'Bot 主动发送：早安', importance: 0.6, confidence: 0.92 }),
    archiveRow({ sourceId: 'mem_photo_1', memoryType: 'photo_generation', value: 'Bot 生成并发送了一张自拍', importance: 0.53, confidence: 0.86 }),
  ];
  for (let index = 0; index < summaries; index++) {
    memories.push(archiveRow({
      sourceId: `mem_summary_${index + 1}`, memoryType: 'conversation_summary',
      value: `第 ${index + 1} 段旧对话摘要`, evidence: `第 ${index + 1} 段旧对话原文`,
      importance: 0.7 + index * 0.05, confidence: 0.55,
    }));
  }
  const memoryTypes = {};
  for (const row of memories) memoryTypes[row.memoryType] = (memoryTypes[row.memoryType] ?? 0) + 1;
  return {
    manifest: {
      schemaVersion: 1,
      exportedAt: '2026-10-25T08:41:12.312328+00:00',
      source: 'fixture',
      snapshot: 'fixture',
      snapshotSha256: '',
      owner: USER_ID,
      bot: '2668517323',
      persona: 'bot',
      sourceCount: memories.length,
      importedCount: memories.length,
      identityAliases: {},
      excluded: {},
      memoryTypes,
      mode: 'independent-snapshot',
      policy: 'fixture',
      policyHashes: {},
    },
    memories,
  };
}

/** Interleaved user/assistant journal; sequences are unique per session. */
function buildJournalFixture({ user = 2, assistant = 2, sessionId = 'session-fixture-1', startSeq = 8 } = {}) {
  const records = [];
  let seq = startSeq;
  for (let index = 0; index < Math.max(user, assistant); index++) {
    if (index < user) records.push(journalRecord({ sessionId, seq: seq++, role: 'user', text: `用户第 ${index + 1} 句话` }));
    if (index < assistant) records.push(journalRecord({ sessionId, seq: seq++, role: 'assistant', text: `bot第 ${index + 1} 句回复` }));
  }
  return records;
}

/** Write a small self-contained legacy home/ into a temp root. */
function seedSyntheticRoot(root, { archive = buildArchiveFixture(), journal = buildJournalFixture(), state = null } = {}) {
  fs.mkdirSync(path.join(root, 'home/memory'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/memory/astrbot-import.json'), JSON.stringify(archive, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(root, 'home/memory/conversation.jsonl'),
    journal.map(record => JSON.stringify(record)).join('\n') + (journal.length ? '\n' : ''),
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1,
    persona: PERSONA_ID,
    owner: { id: USER_ID, platform: 'qq', displayName: '槑' },
    desktop: { mode: 'local-owner', userId: USER_ID },
    sessions: {},
    boundAt: '2026-10-25T10:01:53.269025+00:00',
    source: 'fixture',
  }, null, 2), 'utf8');
  if (state) fs.writeFileSync(path.join(root, 'home/companion/state.json'), JSON.stringify(state, null, 2), 'utf8');
  return { archive, journal, archiveFile: path.join(root, 'home/memory/astrbot-import.json') };
}

/** Counts derived from a fixture so no test hard-codes a total. */
function fixtureCounts(archive, journal) {
  const byType = {};
  for (const row of archive.memories) byType[row.memoryType] = (byType[row.memoryType] ?? 0) + 1;
  const byRole = {};
  for (const record of journal) byRole[record.role] = (byRole[record.role] ?? 0) + 1;
  return {
    archive: archive.memories.length,
    journal: journal.length,
    total: archive.memories.length + journal.length,
    byType,
    byRole,
    archived: archive.memories.filter(row => row.validTo && Date.parse(String(row.validTo).replace(' ', 'T')) <= CLOCK).length,
  };
}

/**
 * Read the live local corpus read-only and derive the expectations the importer
 * must meet. The journal keeps growing while the desktop runs, so every count is
 * computed here instead of being written down.
 */
function loadRealCorpus() {
  if (!fs.existsSync(REAL_ARCHIVE) || !fs.existsSync(REAL_CONVERSATION)) return null;
  const archive = JSON.parse(fs.readFileSync(REAL_ARCHIVE, 'utf8'));
  const lines = fs.readFileSync(REAL_CONVERSATION, 'utf8').split(/\r?\n/).filter(Boolean);
  const records = [];
  let invalidLines = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      invalidLines += 1;
    }
  }
  // Mirror the importer's journal filter so the expectation is the mapped count.
  const mapped = records.filter(record => (record.role === 'user' || record.role === 'assistant')
    && typeof record.id === 'string' && record.id.trim() !== ''
    && String(record.text ?? '').trim() !== ''
    && (!record.userId || record.userId === USER_ID)
    && (!record.persona || record.persona === PERSONA_ID));
  const unique = new Map();
  for (const record of mapped) if (!unique.has(record.id)) unique.set(record.id, record);
  return {
    archive,
    journal: [...unique.values()],
    invalidLines,
    archiveCount: archive.memories.length,
    journalCount: unique.size,
    byRole: [...unique.values()].reduce((acc, record) => {
      acc[record.role] = (acc[record.role] ?? 0) + 1;
      return acc;
    }, {}),
    archived: archive.memories.filter(row => row.validTo && Date.parse(String(row.validTo).replace(' ', 'T')) <= CLOCK).length,
  };
}

/** Copy the real legacy inputs into a temp root so writes never touch home/. */
function seedRealRoot(root) {
  fs.mkdirSync(path.join(root, 'home/memory'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  fs.copyFileSync(REAL_ARCHIVE, path.join(root, 'home/memory/astrbot-import.json'));
  fs.copyFileSync(REAL_CONVERSATION, path.join(root, 'home/memory/conversation.jsonl'));
  fs.copyFileSync(REAL_IDENTITY, path.join(root, 'home/companion/identity.json'));
}

function sha256File(file) {
  return contentHash(fs.readFileSync(file));
}

/** Run the migration CLI against a temp root; never the real home/ or logs/. */
function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 120000,
    ...options,
  });
}

/**
 * Minimal CONTRACT §6 store: unique dedupeKey and eventKey, immutable evidence.
 * Records every write so a dry run can be proven to write nothing.
 */
function createFakeDb() {
  const memories = new Map();
  const memoryByDedupe = new Map();
  const events = new Map();
  const eventByKey = new Map();
  const evidence = new Map();
  const writes = [];
  const updates = [];

  const list = (filter = {}) => {
    let rows = [...memories.values()];
    if (filter.userId) rows = rows.filter(row => row.userId === filter.userId);
    if (filter.personaId) rows = rows.filter(row => row.personaId === filter.personaId);
    if (filter.scope) rows = rows.filter(row => row.scope === filter.scope);
    if (filter.kind) rows = rows.filter(row => row.kind === filter.kind);
    if (filter.status) rows = rows.filter(row => row.status === filter.status);
    if (filter.subject) rows = rows.filter(row => row.subject === filter.subject);
    if (filter.predicate) rows = rows.filter(row => row.predicate === filter.predicate);
    const offset = Number(filter.offset ?? 0);
    const limited = filter.limit == null ? rows : rows.slice(offset, offset + filter.limit);
    return limited.map(row => ({ ...row, tags: [...(row.tags ?? [])] }));
  };

  const db = {
    file: ':memory:',
    transaction(fn) {
      writes.push('transaction');
      return fn();
    },
    appendEvent(row) {
      if (eventByKey.has(row.eventKey)) {
        return { inserted: false, sourceId: eventByKey.get(row.eventKey) };
      }
      const sourceId = row.sourceId ?? `evt_fake_${events.size}`;
      const stored = { ...row, sourceId, contentHash: contentHash(row.content ?? '') };
      events.set(sourceId, stored);
      eventByKey.set(row.eventKey, sourceId);
      writes.push('appendEvent');
      return { inserted: true, sourceId };
    },
    getEvent(sourceId) {
      return events.get(sourceId) ?? null;
    },
    insertMemory(record) {
      if (record.dedupeKey && memoryByDedupe.has(record.dedupeKey)) {
        writes.push('insertMemory:dedupe');
        return { record: memories.get(memoryByDedupe.get(record.dedupeKey)), inserted: false };
      }
      assert.ok(record.scope && record.kind && record.userId && record.personaId, 'insertMemory needs scope/kind/owner');
      assert.ok(!memories.has(record.id), 'insertMemory id must be unique');
      const stored = {
        worldId: '', content: '', validFrom: null, validTo: null, occurredAt: null, revision: 1,
        ...record,
        tags: [...(record.tags ?? [])],
        createdAt: record.createdAt ?? new Date(CLOCK).toISOString(),
        updatedAt: record.updatedAt ?? new Date(CLOCK).toISOString(),
      };
      memories.set(stored.id, stored);
      memoryByDedupe.set(stored.dedupeKey, stored.id);
      writes.push('insertMemory');
      return { record: { ...stored, tags: [...stored.tags] }, inserted: true };
    },
    getMemory(id) {
      const row = memories.get(id);
      return row ? { ...row, tags: [...row.tags] } : null;
    },
    updateMemory(id, patch = {}, { reason = '', actor = 'system' } = {}) {
      const row = memories.get(id);
      if (!row) throw new Error(`记忆不存在：${id}`);
      Object.assign(row, patch, {
        revision: (row.revision ?? 1) + 1,
        updatedAt: new Date(CLOCK).toISOString(),
      });
      updates.push({ id, patch: { ...patch }, reason, actor });
      writes.push('updateMemory');
      return { ...row, tags: [...row.tags] };
    },
    addEvidence(memoryId, sourceId, options = {}) {
      const links = evidence.get(memoryId) ?? [];
      if (!links.some(item => item.sourceId === sourceId)) {
        links.push({ sourceId, evidenceKind: options.evidenceKind ?? 'supports', confidence: options.confidence ?? 0.5 });
      }
      evidence.set(memoryId, links);
      writes.push('addEvidence');
    },
    evidenceFor(memoryId) {
      return (evidence.get(memoryId) ?? []).map(item => {
        const event = events.get(item.sourceId) ?? {};
        return {
          sourceId: item.sourceId,
          role: event.role ?? '',
          occurredAt: event.occurredAt ?? '',
          content: event.content ?? '',
          confidence: item.confidence,
        };
      });
    },
    listMemories: list,
    countMemories(filter = {}) {
      return list({ ...filter, limit: null, offset: 0 }).length;
    },
    stats() {
      return { memories: memories.size, events: events.size };
    },
    // test helpers
    _writes: writes,
    _updates: updates,
    _memories: memories,
    _events: events,
    _evidence: evidence,
  };
  return db;
}

// ---------------------------------------------------------------------------
// pure mapping on the real archive (read-only, totals computed from the manifest)
// ---------------------------------------------------------------------------

test('real archive mapping covers every archived row with the contract scopes', (t) => {
  const corpus = loadRealCorpus();
  if (!corpus) {
    t.skip('缺少 home/memory/astrbot-import.json 或 conversation.jsonl，跳过真实语料用例');
    return;
  }
  const { archive } = corpus;
  const archiveCount = corpus.archiveCount;
  t.diagnostic(`真实归档 archiveCount=${archiveCount}，manifest.importedCount=${archive.manifest.importedCount}`);
  assert.equal(archive.manifest.importedCount, archiveCount, '清单声明条数必须与归档数组长度一致');

  const drafts = [];
  const skipped = {};
  for (const row of archive.memories) {
    const result = classifyArchiveRow(row, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK });
    if (result.ok) drafts.push(result.draft);
    else skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
  }
  assert.deepEqual(skipped, {}, '每一行旧档案都必须能安全映射');
  assert.equal(drafts.length, archiveCount);

  // Expectations come from the manifest, so a refreshed export keeps passing.
  const types = archive.manifest.memoryTypes;
  const expectedScope = {
    user_global: types.core_memory + types.user_profile + types.user_preference + types.explicit_memory + types.tool_memory,
    user_persona: types.conversation_summary + types.relationship_claim,
    persona_self: types.proactive_message + types.photo_generation,
  };
  const expectedKind = {
    profile: types.core_memory + types.user_profile,
    preference: types.user_preference + types.tool_memory,
    fact: types.explicit_memory,
    relationship: types.relationship_claim,
    summary: types.conversation_summary,
    bot_action: types.proactive_message,
    artifact: types.photo_generation,
  };
  const aggregate = aggregateDrafts(drafts);
  assert.deepEqual(aggregate.byScope, expectedScope);
  assert.deepEqual(aggregate.byKind, expectedKind);
  const expectedStatus = { confirmed: archiveCount - corpus.archived };
  if (corpus.archived > 0) expectedStatus.archived = corpus.archived;
  assert.deepEqual(aggregate.byStatus, expectedStatus);

  // Stable identity: derived from the legacy id, unique per row.
  assert.equal(new Set(drafts.map(draft => draft.id)).size, archiveCount);
  assert.equal(new Set(drafts.map(draft => draft.dedupeKey)).size, archiveCount);
  assert.equal(new Set(drafts.map(draft => draft.eventKey)).size, archiveCount);

  for (const [index, draft] of drafts.entries()) {
    const row = archive.memories[index];
    const type = row.memoryType;
    assert.match(draft.id, /^mem_[0-9a-f]{20}$/);
    assert.equal(draft.dedupeKey, `import:astrbot:${row.sourceId}`);
    assert.equal(draft.eventKey, `astrbot:${row.sourceId}`);
    assert.equal(draft.predicate, `import:${type}`);
    assert.equal(draft.sourceKind, 'astrbot_import');
    assert.equal(draft.userId, USER_ID);
    assert.equal(draft.personaId, PERSONA_ID);
    assert.equal(draft.worldId, '');
    assert.ok(draft.tags.includes(IMPORT_TAG));
    assert.ok(draft.tags.includes(`import:${type}`));
    assert.equal(draft.event.role, 'imported');
    assert.equal(draft.event.sourceKind, 'astrbot_import');
    assert.equal(draft.event.eventKey, draft.eventKey);
    assert.equal(draft.event.userId, USER_ID);
    assert.ok(draft.event.occurredAt, '证据必须有发生时间');
    assert.ok(draft.event.content.length > 0);
    assert.ok(draft.searchText.length > 0);
    assert.ok(draft.value.length > 0);
  }
});

test('real archive keeps user facts, summaries and bot actions apart', (t) => {
  const corpus = loadRealCorpus();
  if (!corpus) {
    t.skip('缺少真实归档，跳过');
    return;
  }
  const byType = new Map();
  for (const row of corpus.archive.memories) {
    const draft = mapArchiveRow(row, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK });
    assert.ok(draft, `mapping failed for ${row.id}`);
    if (!byType.has(row.memoryType)) byType.set(row.memoryType, []);
    byType.get(row.memoryType).push(draft);
  }

  for (const draft of byType.get('core_memory') ?? []) {
    assert.equal(draft.scope, 'user_global');
    assert.equal(draft.kind, 'profile');
    assert.equal(draft.realityLevel, 'imported_fact');
    assert.equal(draft.mentionPolicy, 'direct');
    assert.equal(draft.subject, 'user');
  }
  for (const draft of byType.get('user_profile') ?? []) {
    assert.equal(draft.scope, 'user_global');
    assert.equal(draft.kind, 'profile');
  }
  for (const draft of byType.get('user_preference') ?? []) {
    assert.equal(draft.scope, 'user_global');
    assert.equal(draft.kind, 'preference');
    assert.equal(draft.mentionPolicy, 'direct');
  }
  for (const draft of byType.get('explicit_memory') ?? []) {
    assert.equal(draft.scope, 'user_global');
    assert.equal(draft.kind, 'fact');
    assert.equal(draft.realityLevel, 'imported_fact');
  }
  for (const draft of byType.get('relationship_claim') ?? []) {
    assert.equal(draft.scope, 'user_persona');
    assert.equal(draft.kind, 'relationship');
    assert.equal(draft.mentionPolicy, 'soft_echo');
  }
  for (const draft of byType.get('conversation_summary') ?? []) {
    assert.equal(draft.scope, 'user_persona');
    assert.equal(draft.kind, 'summary');
    assert.equal(draft.realityLevel, 'imported_summary');
    assert.equal(draft.mentionPolicy, 'soft_echo');
    assert.equal(draft.status, 'confirmed');
    assert.ok(draft.importance <= SUMMARY_IMPORTANCE_CAP, `摘要 importance ${draft.importance} 必须 ≤ ${SUMMARY_IMPORTANCE_CAP}`);
  }
  for (const draft of byType.get('tool_memory') ?? []) {
    assert.equal(draft.realityLevel, 'inferred');
    assert.equal(draft.mentionPolicy, 'soft_echo');
    assert.ok(draft.confidence <= 0.6, `tool_memory confidence ${draft.confidence} must stay <= 0.6`);
    assert.equal(draft.kind, 'preference');
  }
  for (const type of ['proactive_message', 'photo_generation']) {
    for (const draft of byType.get(type) ?? []) {
      assert.equal(draft.scope, 'persona_self');
      assert.equal(draft.subject, 'persona');
      assert.equal(draft.realityLevel, 'bot_action');
      assert.equal(draft.mentionPolicy, 'tone_only');
      assert.ok(draft.importance <= 0.35, `${type} importance must stay <= 0.35`);
      assert.equal(draft.kind, type === 'proactive_message' ? 'bot_action' : 'artifact');
      assert.ok(!['user_global', 'user_persona', 'session_recent'].includes(draft.scope));
    }
  }

  // The hard rule: no bot action may hide in a real-user scope.
  const leaked = [...byType.values()].flat()
    .filter(draft => ['bot_action', 'artifact'].includes(draft.kind) && draft.scope !== 'persona_self');
  assert.deepEqual(leaked, []);
});

test('only summaries are importance-capped; confirmed facts keep their archive weight', (t) => {
  const corpus = loadRealCorpus();
  if (!corpus) {
    t.skip('缺少真实归档，跳过');
    return;
  }
  const rows = corpus.archive.memories;
  const summaries = rows.filter(row => row.memoryType === 'conversation_summary');
  assert.ok(summaries.length > 0, '真实归档应包含对话摘要');
  // The old archive rated summaries above plain preferences — the bug being fixed.
  assert.ok(Math.min(...summaries.map(row => Number(row.importance))) > SUMMARY_IMPORTANCE_CAP);
  for (const row of summaries) {
    const draft = mapArchiveRow(row, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK });
    assert.equal(draft.importance, SUMMARY_IMPORTANCE_CAP);
  }
  // Everything else keeps the archive importance (bot actions keep their own cap).
  for (const type of ['core_memory', 'user_profile', 'user_preference', 'explicit_memory', 'relationship_claim']) {
    const row = rows.find(item => item.memoryType === type);
    assert.ok(row, `真实归档应包含 ${type}`);
    const draft = mapArchiveRow(row, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK });
    assert.equal(draft.importance, Number(row.importance), `${type} 的 importance 不应被摘要上限影响`);
  }
  const tool = rows.find(row => row.memoryType === 'tool_memory');
  assert.equal(mapArchiveRow(tool, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK }).importance, Number(tool.importance));
});

// ---------------------------------------------------------------------------
// pure mapping on synthetic rows (edge cases)
// ---------------------------------------------------------------------------

test('expired archive rows import as archived and keep their evidence', () => {
  const base = {
    sourceId: 'mem_expired_1', memoryType: 'explicit_memory', value: '旧约定已经过期',
    evidence: '旧证据', occurredAt: '2026-01-01T00:00:00+08:00', updatedAt: '2026-01-02T00:00:00+08:00',
    importance: 0.9, confidence: 0.9, owner: USER_ID, persona: PERSONA_ID, tags: ['stable_fact'],
  };
  const past = mapArchiveRow({ ...base, validTo: '2026-02-01T00:00:00+08:00' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK });
  assert.equal(past.status, 'archived');
  assert.equal(past.validTo, '2026-01-31T16:00:00.000Z');
  assert.equal(past.occurredAt, '2025-12-31T16:00:00.000Z');
  assert.equal(past.event.content, '旧证据');

  const future = mapArchiveRow({ ...base, sourceId: 'mem_future_1', validTo: '2027-02-01T00:00:00+08:00' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK });
  assert.equal(future.status, 'confirmed');
  assert.equal(future.validTo, '2027-01-31T16:00:00.000Z');

  const open = mapArchiveRow({ ...base, sourceId: 'mem_open_1', validTo: '' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK });
  assert.equal(open.status, 'confirmed');
  assert.equal(open.validTo, null);

  // Archived imports must stay out of automatic recall.
  assert.equal(isActive(past, CLOCK), false);
  assert.equal(isPromptEligible(past, CLOCK), false);
  assert.equal(isActive(future, CLOCK), true);
  assert.equal(isPromptEligible(open, CLOCK), true);
});

test('archive rows from another owner or persona are skipped, never coerced', () => {
  const row = {
    sourceId: 'mem_foreign', memoryType: 'user_preference', value: '别人的偏好',
    evidence: '', owner: '999999', persona: PERSONA_ID,
  };
  assert.equal(mapArchiveRow(row, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK }), null);
  assert.deepEqual(
    classifyArchiveRow(row, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK }),
    { ok: false, reason: 'owner_mismatch' },
  );
  assert.equal(
    classifyArchiveRow({ ...row, owner: USER_ID, persona: 'other' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK }).reason,
    'persona_mismatch',
  );
  assert.equal(
    classifyArchiveRow({ ...row, owner: USER_ID, memoryType: 'unknown_type' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK }).reason,
    'unknown_memory_type',
  );
  assert.equal(
    classifyArchiveRow({ ...row, owner: USER_ID, value: '   ' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK }).reason,
    'empty_value',
  );
});

test('state facts become explicit user facts with stable keys', () => {
  const fact = {
    key: '称呼', value: '用户希望被叫作凡博', updatedAt: '2026-10-25T09:00:00.000Z', userId: USER_ID, persona: PERSONA_ID,
  };
  const draft = mapStateFact(fact, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK });
  assert.equal(draft.scope, 'user_global');
  assert.equal(draft.kind, 'fact');
  assert.equal(draft.realityLevel, 'explicit_user_statement');
  assert.equal(draft.mentionPolicy, 'direct');
  assert.equal(draft.status, 'confirmed');
  assert.equal(draft.sourceKind, 'desktop_fact');
  assert.equal(draft.predicate, 'import:state:称呼');
  assert.equal(draft.dedupeKey, `import:state:${USER_ID}:${PERSONA_ID}:称呼`);
  assert.equal(draft.event.role, 'imported');
  assert.equal(draft.event.sourceKind, 'desktop_fact');
  assert.equal(draft.occurredAt, '2026-10-25T09:00:00.000Z');
  assert.ok(draft.tags.includes(IMPORT_TAG));

  // Same key, same ids: the fact identity is the key, not the timestamp.
  const again = mapStateFact({ ...fact, updatedAt: '2026-10-26T09:00:00.000Z' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK + 86400000 });
  assert.equal(again.dedupeKey, draft.dedupeKey);
  assert.equal(again.id, draft.id);
  assert.equal(again.eventKey, draft.eventKey);

  assert.equal(mapStateFact({ ...fact, userId: 'someone-else' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK }), null);
  assert.equal(mapStateFact({ ...fact, value: '' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK }), null);
});

test('conversation records map to evidence plus low-trust continuity rows', () => {
  const userRecord = journalRecord({ sessionId: 'session-x', seq: 9, role: 'user', text: '我更喜欢喝茶' });
  const mapped = mapConversationRecord(userRecord, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK });
  assert.ok(mapped);
  // The evidence key must be identical to capture.toSourceEvent: `${sessionId}:${seq}`.
  assert.equal(mapped.event.eventKey, 'session-x:9');
  assert.equal(mapped.event.eventKey, userRecord.id);
  assert.equal(mapped.event.role, 'imported');
  assert.equal(mapped.event.sourceKind, 'desktop_conversation');
  assert.equal(mapped.event.seq, 9);
  assert.equal(mapped.memory.scope, 'user_persona');
  assert.equal(mapped.memory.kind, 'event');
  assert.equal(mapped.memory.realityLevel, 'user_utterance_not_verified_fact');
  assert.equal(mapped.memory.mentionPolicy, 'soft_echo');
  assert.equal(mapped.memory.dedupeKey, 'import:conversation:session-x:9');
  assert.equal(mapped.memory.sourceId, mapped.event.sourceId);
  assert.equal(mapped.memory.tags.includes('import:conversation_user'), true);

  const assistant = mapConversationRecord(
    { ...userRecord, role: 'assistant', id: 'session-x:10', seq: 10 },
    { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK },
  );
  assert.equal(assistant.memory.scope, 'persona_self');
  assert.equal(assistant.memory.kind, 'bot_action');
  assert.equal(assistant.memory.realityLevel, 'bot_action');
  assert.equal(assistant.memory.mentionPolicy, 'tone_only');
  assert.equal(assistant.memory.subject, 'persona');

  assert.equal(mapConversationRecord({ ...userRecord, role: 'system' }, { userId: USER_ID, personaId: PERSONA_ID }), null);
  assert.equal(mapConversationRecord({ ...userRecord, userId: 'someone-else' }, { userId: USER_ID, personaId: PERSONA_ID }), null);
  assert.equal(mapConversationRecord({ ...userRecord, text: '  ' }, { userId: USER_ID, personaId: PERSONA_ID }), null);

  // A journal id that disagrees with session/seq still has to meet capture's key.
  const derived = classifyConversationRecord(
    { ...userRecord, id: 'legacy:weird' }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK },
  );
  assert.equal(derived.ok, true);
  assert.equal(derived.result.event.eventKey, 'session-x:9');
  assert.equal(derived.warning, 'conversation_event_key_derived');
  assert.equal(derived.result.memory.dedupeKey, 'import:conversation:session-x:9');

  // No session/seq at all: a namespaced, reported fallback instead of a silent clash.
  const noSession = classifyConversationRecord(
    { ...userRecord, sessionId: '', seq: null }, { userId: USER_ID, personaId: PERSONA_ID, now: CLOCK },
  );
  assert.equal(noSession.ok, true);
  assert.equal(noSession.result.event.eventKey, 'conversation:session-x:9');
  assert.equal(noSession.warning, 'conversation_event_key_prefixed');

  // Nothing usable as an identity: skipped rather than inventing a shared key.
  assert.equal(
    classifyConversationRecord({ ...userRecord, id: '', sessionId: '', seq: null }, { userId: USER_ID, personaId: PERSONA_ID }).reason,
    'missing_event_key',
  );
});

// ---------------------------------------------------------------------------
// exact-count behaviour on the synthetic fixture (fake db)
// ---------------------------------------------------------------------------

test('conversation import shares capture’s eventKey: one message, one evidence row', async (t) => {
  const root = tempRoot(t);
  const { archive, journal } = seedSyntheticRoot(root);
  const counts = fixtureCounts(archive, journal);
  const record = journal.find(item => item.role === 'user');
  assert.ok(record);

  // Capture the same message the way the host would, with the real capture module.
  const captured = toSourceEvent({
    sessionId: record.sessionId,
    event: {
      type: 'user/message',
      seq: record.seq,
      time: record.at,
      data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: record.text }] } },
    },
    viewer: { userId: USER_ID, personaId: PERSONA_ID, worldId: '' },
    clock: CLOCK,
  });
  assert.ok(captured, 'capture.toSourceEvent 应接受这条事件');
  assert.equal(captured.eventKey, record.id, 'capture 与 journal 的事件键必须一致');

  const db = createFakeDb();
  const appended = db.appendEvent(captured);
  assert.equal(appended.inserted, true);

  const result = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  // The already captured message is not stored a second time...
  assert.equal(result.report.totals.eventsInserted, counts.total - 1);
  assert.equal(result.report.totals.eventsDeduped, 1);
  const keys = [...db._events.values()].map(row => row.eventKey);
  assert.equal(keys.length, counts.total);
  assert.equal(new Set(keys).size, counts.total, 'source_events 不得出现重复事件键');
  assert.equal(keys.filter(key => key === record.id).length, 1);
  // ...but its memory row still lands and links to the captured evidence row.
  const memory = [...db._memories.values()].find(item => item.dedupeKey === `import:conversation:${record.id}`);
  assert.ok(memory);
  assert.equal(memory.sourceId, appended.sourceId);
  const evidence = db.evidenceFor(memory.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].sourceId, appended.sourceId);
  assert.equal(result.report.reconciliation.ok, true);
  assert.equal(result.report.reconciliation.summary.evidence.failed, 0);

  // A second import run keeps both tables at the same size.
  const second = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 1000 });
  assert.equal(second.inserted, 0);
  assert.equal(db._events.size, counts.total);
  assert.equal(db._memories.size, counts.total);
});

test('runImport maps the whole fixture, then a second run inserts nothing', async (t) => {
  const root = tempRoot(t);
  const { archive, journal } = seedSyntheticRoot(root);
  const counts = fixtureCounts(archive, journal);
  const types = counts.byType;
  const archiveFile = path.join(root, 'home/memory/astrbot-import.json');
  const conversationFile = path.join(root, 'home/memory/conversation.jsonl');
  const identityFile = path.join(root, 'home/companion/identity.json');
  const before = {
    archive: sha256File(archiveFile),
    conversation: sha256File(conversationFile),
    identity: sha256File(identityFile),
    archiveMtime: fs.statSync(archiveFile).mtimeMs,
    conversationMtime: fs.statSync(conversationFile).mtimeMs,
  };

  const db = createFakeDb();
  const first = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });

  assert.equal(first.report.manifestVersion, IMPORT_MANIFEST_VERSION);
  assert.equal(first.report.mode, 'apply');
  assert.equal(first.report.totals.candidates, counts.total);
  assert.equal(first.inserted, counts.total);
  assert.equal(first.deduped, 0);
  assert.equal(first.skipped, 0);
  assert.equal(first.report.totals.eventsInserted, counts.total);
  assert.equal(first.report.totals.evidenceLinked, counts.total);
  assert.equal(first.report.totals.evidenceExisting, 0);
  assert.equal(first.report.totals.evidenceFailed, 0);
  assert.equal(first.report.totals.refreshed, 0);
  assert.equal(db._memories.size, counts.total);
  assert.equal(db._events.size, counts.total);
  assert.equal(db._evidence.size, counts.total);

  // Every memory has exactly one immutable evidence row from the same origin.
  for (const memory of db._memories.values()) {
    const evidence = db.evidenceFor(memory.id);
    assert.equal(evidence.length, 1, `memory ${memory.id} needs exactly one evidence row`);
    assert.equal(evidence[0].role, 'imported');
    assert.ok(evidence[0].sourceId);
    assert.equal(memory.userId, USER_ID);
    assert.equal(memory.personaId, PERSONA_ID);
    assert.equal(memory.worldId, '');
    assert.ok(memory.tags.includes(IMPORT_TAG));
    assert.ok(memory.searchText.length > 0);
    assert.ok(memory.dedupeKey.startsWith('import:'));
    if (['proactive_message', 'photo_generation'].some(type => memory.tags.includes(`import:${type}`))) {
      assert.equal(memory.scope, 'persona_self');
    }
  }

  // Backup first: checksummed copies of all inputs, source files untouched.
  assert.equal(first.backupDir, path.join(root, 'home/memory/backups', STAMP));
  const backupManifest = JSON.parse(fs.readFileSync(path.join(first.backupDir, 'manifest.json'), 'utf8'));
  const backedUp = new Map(backupManifest.files.map(record => [record.name, record]));
  for (const name of ['astrbot-import.json', 'conversation.jsonl', 'identity.json']) {
    assert.ok(backedUp.has(name), `backup must contain ${name}`);
    assert.equal(backedUp.get(name).exists, true);
    assert.equal(backedUp.get(name).verified, true);
    assert.equal(backedUp.get(name).sha256, sha256File(path.join(first.backupDir, name)));
  }
  assert.equal(backedUp.get('state.json').exists, false, '缺少 state.json 时备份只记录缺失');
  assert.equal(backedUp.get('astrbot-import.json').sha256, before.archive, '备份内容必须与迁移前的原始文件一致');
  assert.equal(sha256File(archiveFile), before.archive);
  assert.equal(sha256File(conversationFile), before.conversation);
  assert.equal(sha256File(identityFile), before.identity);
  assert.equal(fs.statSync(archiveFile).mtimeMs, before.archiveMtime);
  assert.equal(fs.statSync(conversationFile).mtimeMs, before.conversationMtime);

  // Report lives in logs/, contains ids/counts only, never memory text.
  assert.equal(first.reportPath, path.join(root, 'logs', `memory-migration-${STAMP}.json`));
  const reportText = fs.readFileSync(first.reportPath, 'utf8');
  for (const secret of ['用户偏好热茶', '双方确认恋爱关系', '夜深了', '自拍']) {
    assert.ok(!reportText.includes(secret), `报告不得包含记忆正文（${secret}）`);
  }
  const report = JSON.parse(reportText);
  assert.equal(report.byStatus.archived, counts.archived);
  assert.equal(report.byStatus.confirmed, counts.total - counts.archived);
  assert.equal(report.byMemoryType.conversation_summary.count, types.conversation_summary);
  assert.equal(report.byMemoryType.proactive_message.count, types.proactive_message);
  assert.equal(report.byMemoryType.photo_generation.count, types.photo_generation);
  assert.equal(report.byMemoryType.conversation_user.count, counts.byRole.user);
  assert.equal(report.byMemoryType.conversation_assistant.count, counts.byRole.assistant);
  assert.equal(
    report.byScope.user_global,
    types.core_memory + types.user_profile + types.user_preference + types.explicit_memory + types.tool_memory,
  );
  assert.equal(
    report.byScope.persona_self,
    types.proactive_message + types.photo_generation + counts.byRole.assistant,
  );
  assert.equal(report.memoryIds.length, counts.total);
  assert.equal(report.eventKeys.length, counts.total);
  assert.equal(report.checksums.memoryIds.length, 64);
  assert.ok(report.warnings.some(warning => warning.code === 'state_missing'));
  assert.equal(report.inputs.find(input => input.name === 'state').exists, false);
  assert.equal(report.reconciliation.ok, true, JSON.stringify(report.reconciliation.checks.filter(check => !check.ok)));
  assert.equal(report.reconciliation.mode, 'store');
  assert.equal(report.reconciliation.summary.total, counts.total);
  assert.equal(report.reconciliation.summary.archived, counts.archived);
  assert.equal(report.reconciliation.summary.duplicates, 0);

  // Second run, one second later: zero new rows, everything deduped.
  const second = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 1000 });
  assert.equal(second.inserted, 0);
  assert.equal(second.deduped, counts.total);
  assert.equal(second.skipped, 0);
  assert.equal(second.report.totals.eventsInserted, 0);
  assert.equal(second.report.totals.eventsDeduped, counts.total);
  // Evidence links are immutable: a repeat run must not rewrite them.
  assert.equal(second.report.totals.evidenceLinked, 0);
  assert.equal(second.report.totals.evidenceExisting, counts.total);
  assert.equal(second.report.reconciliation.summary.evidence.linked, 0);
  assert.equal(second.report.reconciliation.summary.evidence.existing, counts.total);
  assert.equal(db._memories.size, counts.total);
  assert.equal(db._events.size, counts.total);
  assert.equal(second.report.reconciliation.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'home/memory/backups', formatStamp(CLOCK + 1000))));
});

test('refresh repairs drifted importance/policy/status once, then is a no-op', async (t) => {
  const root = tempRoot(t);
  const { archive, journal } = seedSyntheticRoot(root);
  const counts = fixtureCounts(archive, journal);
  const db = createFakeDb();
  const first = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  assert.equal(first.report.totals.refreshed, 0, '全新导入没有可刷新行');
  assert.equal(first.report.refresh, false);

  // Simulate a store written by the previous mapping: summaries too important,
  // one mentionPolicy drift, one status drift.
  const rows = [...db._memories.values()];
  const summaries = rows.filter(row => row.kind === 'summary');
  assert.equal(summaries.length, counts.byType.conversation_summary);
  for (const row of summaries) row.importance = 0.861;
  const preference = rows.find(row => row.kind === 'preference' && row.mentionPolicy === 'direct');
  assert.ok(preference);
  preference.mentionPolicy = 'tone_only';
  const relationship = rows.find(row => row.kind === 'relationship');
  assert.ok(relationship);
  relationship.status = 'superseded';
  const expectedRefresh = summaries.length + 2;

  // Identity snapshot: refresh must never touch these.
  const identityBefore = new Map(rows.map(row => [row.id, {
    value: row.value, dedupeKey: row.dedupeKey, subject: row.subject,
    predicate: row.predicate, occurredAt: row.occurredAt, scope: row.scope,
  }]));

  // Without refresh: still "0 new, 0 changes" — and reconciliation flags the cap.
  const plain = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 1000 });
  assert.equal(plain.inserted, 0);
  assert.equal(plain.deduped, counts.total);
  assert.equal(plain.report.totals.refreshed, 0);
  assert.equal(db._memories.get(summaries[0].id).importance, 0.861, '非 refresh 不得改写已有行');
  assert.equal(db._memories.get(relationship.id).status, 'superseded');
  assert.equal(plain.report.reconciliation.ok, false);
  const capCheck = plain.report.reconciliation.checks.find(check => check.name === 'store_importance_within_bounds');
  assert.ok(capCheck);
  assert.equal(capCheck.ok, false);
  assert.equal(capCheck.actual, summaries.length);

  // Refresh once: exactly the drifted rows are repaired.
  const refreshed = await runImport({
    root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 2000, refresh: true,
  });
  assert.equal(refreshed.report.refresh, true);
  assert.equal(refreshed.inserted, 0);
  assert.equal(refreshed.deduped, counts.total);
  assert.equal(refreshed.report.totals.refreshed, expectedRefresh, '摘要 + 1 条 policy + 1 条 status');
  assert.equal(refreshed.report.totals.refreshFailed, 0);
  assert.equal(refreshed.report.totals.evidenceLinked, 0, '刷新不得重写证据');
  assert.equal(refreshed.report.totals.evidenceExisting, counts.total);
  assert.equal(db._memories.size, counts.total, '刷新不得新增或删除行');
  for (const row of db._memories.values()) {
    if (row.kind === 'summary') assert.equal(row.importance, SUMMARY_IMPORTANCE_CAP);
    const beforeRow = identityBefore.get(row.id);
    assert.equal(row.value, beforeRow.value, '刷新不得改正文');
    assert.equal(row.dedupeKey, beforeRow.dedupeKey);
    assert.equal(row.subject, beforeRow.subject);
    assert.equal(row.predicate, beforeRow.predicate);
    assert.equal(row.occurredAt, beforeRow.occurredAt);
    assert.equal(row.scope, beforeRow.scope);
  }
  assert.equal(db._memories.get(relationship.id).status, 'confirmed');
  assert.equal(db._memories.get(preference.id).mentionPolicy, 'direct');
  assert.equal(refreshed.report.reconciliation.ok, true, JSON.stringify(refreshed.report.reconciliation.checks.filter(check => !check.ok)));
  assert.equal(refreshed.report.reconciliation.checks.find(check => check.name === 'store_importance_within_bounds').ok, true);
  assert.equal(db._updates.length, expectedRefresh);
  assert.ok(db._updates.every(call => call.reason === 'migration-refresh'), '刷新必须带 migration-refresh 理由');
  for (const call of db._updates) {
    const keys = Object.keys(call.patch);
    assert.ok(keys.length > 0);
    for (const key of keys) {
      assert.ok(
        ['importance', 'mentionPolicy', 'status'].includes(key),
        `刷新只能改 importance/mentionPolicy/status，实际改了 ${key}`,
      );
    }
  }

  // Second refresh: nothing left to repair.
  const again = await runImport({
    root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 3000, refresh: true,
  });
  assert.equal(again.report.totals.refreshed, 0);
  assert.equal(again.report.totals.refreshFailed, 0);
  assert.equal(db._updates.length, expectedRefresh, '幂等：第二次刷新不得再写 updateMemory');

  // Dry run can rehearse the refresh count without writing.
  const preview = await runImport({
    root, db, userId: USER_ID, personaId: PERSONA_ID, dryRun: true, refresh: true, clock: CLOCK + 4000,
  });
  assert.equal(preview.report.totals.refreshed, 0);
  assert.equal(db._writes.filter(operation => operation === 'updateMemory').length, expectedRefresh);
});

test('dry run reads everything and writes nothing', async (t) => {
  const root = tempRoot(t);
  const { archive, journal } = seedSyntheticRoot(root);
  const counts = fixtureCounts(archive, journal);
  const db = createFakeDb();
  const before = sha256File(path.join(root, 'home/memory/astrbot-import.json'));

  const result = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, dryRun: true, clock: CLOCK });
  assert.equal(result.report.mode, 'dry_run');
  assert.equal(result.report.totals.candidates, counts.total);
  assert.equal(result.inserted, counts.total, '演练应预测出将新增的数量');
  assert.equal(result.deduped, 0);
  assert.equal(result.backupDir, '');
  assert.equal(result.reportPath, '', '演练默认不写报告文件');
  assert.deepEqual(db._writes, [], '演练不得对存储层发起任何写操作');
  assert.equal(db._memories.size, 0);
  assert.equal(fs.existsSync(path.join(root, 'home/memory/backups')), false);
  assert.equal(fs.existsSync(path.join(root, 'logs')), false);
  assert.equal(sha256File(path.join(root, 'home/memory/astrbot-import.json')), before);
  assert.equal(result.report.reconciliation.mode, 'report_only');
  assert.equal(result.report.reconciliation.ok, true);
});

test('dry run can predict dedupe after a real import', async (t) => {
  const root = tempRoot(t);
  const { archive, journal } = seedSyntheticRoot(root);
  const counts = fixtureCounts(archive, journal);
  const db = createFakeDb();
  await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  const writes = db._writes.length;
  const preview = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, dryRun: true, clock: CLOCK + 5000 });
  assert.equal(preview.inserted, 0);
  assert.equal(preview.deduped, counts.total);
  assert.equal(db._writes.length, writes, '演练不得新增写操作');
});

test('a corrupt state.json falls back to state.json.previous and is still backed up', async (t) => {
  const root = tempRoot(t);
  seedSyntheticRoot(root);
  const stateFile = path.join(root, 'home/companion/state.json');
  const previousFile = path.join(root, 'home/companion/state.json.previous');
  fs.writeFileSync(stateFile, '{broken', 'utf8');
  fs.writeFileSync(previousFile, JSON.stringify({
    schemaVersion: 1,
    revision: 2,
    memories: {
      工作: {
        key: '工作', value: '用户在做一个陪伴基座项目', updatedAt: '2026-10-24T00:00:00.000Z',
        source: 'desktop', persona: PERSONA_ID, userId: USER_ID,
      },
    },
    events: [],
  }), 'utf8');

  const db = createFakeDb();
  const result = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  assert.equal(result.report.origins.state.mapped, 1);
  assert.ok(result.report.warnings.some(warning => warning.code === 'state_previous_used'));
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{broken', '损坏的 state.json 不得被覆盖');
  const facts = [...db._memories.values()].filter(memory => memory.tags.includes('import:state_fact'));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].scope, 'user_global');
  assert.equal(facts[0].kind, 'fact');
  assert.equal(facts[0].realityLevel, 'explicit_user_statement');
  // The file that was actually read is the one preserved in the backup.
  const backupManifest = JSON.parse(fs.readFileSync(path.join(result.backupDir, 'manifest.json'), 'utf8'));
  const stateEntry = backupManifest.files.find(record => record.name === 'state.json');
  assert.equal(stateEntry.exists, true);
  assert.equal(stateEntry.source, previousFile);

  // Missing state.json and .previous are tolerated.
  const root2 = tempRoot(t);
  seedSyntheticRoot(root2);
  const result2 = await runImport({ root: root2, db: createFakeDb(), userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  assert.ok(result2.report.warnings.some(warning => warning.code === 'state_missing'));
  assert.equal(result2.report.origins.state.mapped, 0);
});

test('runImport refuses a foreign archive owner instead of importing it', async (t) => {
  const root = tempRoot(t);
  const archive = buildArchiveFixture();
  const journal = buildJournalFixture();
  archive.manifest.owner = '999999';
  seedSyntheticRoot(root, { archive, journal });
  const counts = fixtureCounts(archive, journal);
  const db = createFakeDb();
  const result = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  assert.equal(result.report.origins.archive.mapped, 0);
  assert.equal(result.report.origins.archive.skipped, counts.archive);
  assert.ok(result.report.warnings.some(warning => warning.code === 'archive_owner_mismatch'));
  assert.equal([...db._memories.values()].filter(memory => memory.sourceKind === 'astrbot_import').length, 0);
  assert.equal(result.report.reconciliation.ok, false, '归属不符时对账必须失败');
});

test('reconciliation reports failures when a bot action leaks into user_global', async (t) => {
  const root = tempRoot(t);
  const { archive } = seedSyntheticRoot(root);
  const db = createFakeDb();
  const first = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  assert.equal(first.report.reconciliation.ok, true);

  const victim = [...db._memories.values()].find(memory => memory.tags.includes('import:proactive_message'));
  assert.ok(victim);
  victim.scope = 'user_global';
  const report = JSON.parse(fs.readFileSync(first.reportPath, 'utf8'));
  const result = reconciliation({ archive, db, report });
  assert.equal(result.ok, false);
  const failed = result.checks.filter(check => !check.ok).map(check => check.name);
  assert.ok(failed.includes('store_bot_action_not_in_user_scope'), failed.join(','));
  assert.ok(result.summaryText.some(line => line.includes('对账未通过')));

  // A duplicate dedupeKey is caught as well.
  victim.scope = 'persona_self';
  const clone = { ...victim, id: 'mem_duplicate_probe', tags: [...victim.tags] };
  db._memories.set(clone.id, clone);
  const duplicateRun = reconciliation({ archive, db, report });
  assert.equal(duplicateRun.ok, false);
  assert.ok(duplicateRun.checks.some(check => check.name === 'store_duplicates' && !check.ok));
});

test('report and backup stay deterministic for a fixed clock', async (t) => {
  const root = tempRoot(t);
  const { archive } = seedSyntheticRoot(root);
  const db = createFakeDb();
  const result = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  assert.equal(formatStamp(CLOCK), STAMP);
  assert.equal(result.report.stamp, STAMP);
  assert.equal(result.report.checksums.memoryIds, contentHash([...result.report.memoryIds].join('\n')));
  const archiveCopy = path.join(root, 'home/memory/astrbot-import.json');
  assert.equal(result.report.inputs.find(input => input.name === 'archive').sha256, sha256File(archiveCopy));
  assert.equal(result.report.archive.manifestSha256, result.report.inputs.find(input => input.name === 'archive').sha256);
  assert.deepEqual(result.report.archive.memoryTypes, archive.manifest.memoryTypes);
});

test('createBackup never overwrites an existing backup directory', (t) => {
  const root = tempRoot(t);
  seedSyntheticRoot(root);
  const archiveCopy = path.join(root, 'home/memory/astrbot-import.json');
  const first = createBackup({
    root, clock: CLOCK, identity: { userId: USER_ID, personaId: PERSONA_ID },
    files: [{ name: 'astrbot-import.json', file: archiveCopy }],
  });
  const second = createBackup({
    root, clock: CLOCK, identity: { userId: USER_ID, personaId: PERSONA_ID },
    files: [{ name: 'astrbot-import.json', file: archiveCopy }],
  });
  assert.notEqual(first.dir, second.dir);
  assert.equal(second.dir, `${first.dir}-2`);
  assert.ok(fs.existsSync(path.join(first.dir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(second.dir, 'manifest.json')));
});

test('readLegacyState tolerates a missing state file', (t) => {
  const root = tempRoot(t);
  const result = readLegacyState({
    file: path.join(root, 'home/companion/state.json'),
    previousFile: path.join(root, 'home/companion/state.json.previous'),
    userId: USER_ID,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'state_missing');
  assert.equal(result.state, null);
});

test('a longer journal only scales the totals (path injection, real files untouched)', async (t) => {
  const root = tempRoot(t);
  const { archive, journal } = seedSyntheticRoot(root);
  // Build a much longer journal outside home/ and inject it via conversationPath.
  const longer = [...journal];
  let seq = 1000;
  for (let index = 0; index < 40; index++) {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    longer.push(journalRecord({ sessionId: 'session-extra', seq: seq++, role, text: `${role} 追加第 ${index + 1} 条` }));
  }
  const longerPath = path.join(root, 'longer-journal.jsonl');
  fs.writeFileSync(longerPath, longer.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  const longerHash = sha256File(longerPath);

  const db = createFakeDb();
  const total = archive.memories.length + longer.length;
  const result = await runImport({
    root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK, conversationPath: longerPath,
  });
  assert.equal(result.report.totals.candidates, total);
  assert.equal(result.inserted, total);
  assert.equal(db.stats().events, total);
  assert.equal(
    result.report.byMemoryType.conversation_user.count,
    longer.filter(record => record.role === 'user').length,
  );
  assert.equal(result.report.reconciliation.ok, true);
  assert.equal(sha256File(longerPath), longerHash, '注入的 journal 不得被修改');

  const second = await runImport({
    root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 1000, conversationPath: longerPath,
  });
  assert.equal(second.inserted, 0);
  assert.equal(second.deduped, total);
});

// ---------------------------------------------------------------------------
// CLI (scripts/migrate-memory.mjs) — synthetic temp root only
// ---------------------------------------------------------------------------

test('CLI --help documents the flags', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--dry-run', '--backup', '--report', '--refresh', '--root', '--db']) {
    assert.ok(result.stdout.includes(flag), `帮助里缺少 ${flag}`);
  }
});

test('CLI --dry-run previews the migration without writing anything', (t) => {
  const root = tempRoot(t);
  const { archive, journal } = seedSyntheticRoot(root);
  const total = archive.memories.length + journal.length;
  const result = runCli(['--root', root, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`合计 ${total} 条`));
  assert.match(result.stdout, new RegExp(`新增 ${total} 条`));
  assert.match(result.stdout, /对账 \d+ 项全部通过（report_only）/);
  assert.equal(fs.existsSync(path.join(root, 'home/memory/companion-memory.db')), false, '演练不得创建数据库');
  assert.equal(fs.existsSync(path.join(root, 'logs')), false, '演练默认不写报告');
  assert.equal(fs.existsSync(path.join(root, 'home/memory/backups')), false, '演练默认不备份');
});

test('CLI backs up first, imports, then a second run inserts nothing', (t) => {
  const root = tempRoot(t);
  const { archive, journal } = seedSyntheticRoot(root);
  const total = archive.memories.length + journal.length;
  const first = runCli(['--root', root]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /备份目录/);
  assert.match(first.stdout, new RegExp(`新增 ${total} 条`));
  assert.match(first.stdout, /对账 18 项全部通过（store）/);

  const dbFile = path.join(root, 'home/memory/companion-memory.db');
  assert.equal(fs.existsSync(dbFile), true, '正式迁移必须写出数据库');
  const reports = fs.readdirSync(path.join(root, 'logs')).filter(name => name.startsWith('memory-migration-'));
  assert.equal(reports.length, 1);
  assert.equal(fs.readdirSync(path.join(root, 'home/memory/backups')).length, 1);

  const second = runCli(['--root', root]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, new RegExp(`新增 0 条；去重跳过 ${total} 条`));
  assert.match(second.stdout, /对账 18 项全部通过（store）/);
  const reportsAfter = fs.readdirSync(path.join(root, 'logs')).filter(name => name.startsWith('memory-migration-'));
  assert.equal(reportsAfter.length, 2, `报告不可覆盖：${reportsAfter.join(', ')}`);
  for (const name of reportsAfter) assert.match(name, /^memory-migration-\d{8}T\d{6}Z(-\d+)?\.json$/);
  assert.equal(fs.readdirSync(path.join(root, 'home/memory/backups')).length, 2);
});

test('CLI --report writes the dry-run report and --json prints it', (t) => {
  const root = tempRoot(t);
  const { archive, journal } = seedSyntheticRoot(root);
  const total = archive.memories.length + journal.length;
  const result = runCli(['--root', root, '--dry-run', '--report', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const reports = fs.readdirSync(path.join(root, 'logs')).filter(name => name.startsWith('memory-migration-'));
  assert.equal(reports.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(root, 'logs', reports[0]), 'utf8'));
  assert.equal(written.mode, 'dry_run');
  assert.equal(written.totals.candidates, total);
  assert.equal(written.reconciliation.ok, true);
  assert.ok(result.stdout.includes('"schema": "memory-migration-report/v2"'));
  assert.equal(fs.existsSync(path.join(root, 'home/memory/companion-memory.db')), false);
});

test('CLI --dry-run --backup snapshots the inputs without importing', (t) => {
  const root = tempRoot(t);
  seedSyntheticRoot(root);
  const result = runCli(['--root', root, '--dry-run', '--backup']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /备份目录/);
  const backupDirs = fs.readdirSync(path.join(root, 'home/memory/backups'));
  assert.equal(backupDirs.length, 1);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'home/memory/backups', backupDirs[0], 'manifest.json'), 'utf8',
  ));
  assert.equal(manifest.mode, 'dry_run');
  assert.equal(manifest.files.find(file => file.name === 'astrbot-import.json').exists, true);
  assert.equal(fs.existsSync(path.join(root, 'home/memory/companion-memory.db')), false, '备份演练不得写库');
  assert.equal(fs.existsSync(path.join(root, 'logs')), false);
});

test('CLI rejects an unknown flag with exit code 2', () => {
  const result = runCli(['--nope']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未知参数/);
});

test('CLI --refresh repairs drifted importance on the real store', async (t) => {
  if (!fs.existsSync(REAL_DB_MODULE)) {
    t.skip('lib/db.mjs 尚未就绪，CLI 刷新用例跳过');
    return;
  }
  const { openMemoryDatabase } = await import('../lib/db.mjs');
  // Windows needs the handles released before the temp directory can go.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-companion-cli-refresh-'));
  const handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) {
      try { handle.close(); } catch { /* already closed */ }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const { archive, journal } = seedSyntheticRoot(root);
  const total = archive.memories.length + journal.length;
  const first = runCli(['--root', root]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /刷新 0 条/);
  assert.match(first.stdout, new RegExp(`新增 ${total} 条`));

  const file = path.join(root, 'home/memory/companion-memory.db');
  const db = await openMemoryDatabase({ file });
  handles.push(db);
  const summary = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, kind: 'summary', limit: 1 })[0];
  assert.ok(summary);
  assert.equal(summary.importance, SUMMARY_IMPORTANCE_CAP);
  db.updateMemory(summary.id, { importance: 0.9 }, { reason: 'cli-test-drift' });
  db.close();

  const refreshed = runCli(['--root', root, '--refresh']);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.match(refreshed.stdout, /刷新 1 条/);
  assert.match(refreshed.stdout, /对账 18 项全部通过（store）/);
  const again = runCli(['--root', root, '--refresh']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /刷新 0 条/);
});

// ---------------------------------------------------------------------------
// real SQLite store integration (only when the store-engine module is available)
// ---------------------------------------------------------------------------

test('real SQLite store: migration is idempotent, links capture evidence and refreshes', async (t) => {
  if (!fs.existsSync(REAL_DB_MODULE)) {
    t.skip('lib/db.mjs 尚未就绪，真实库集成测试跳过');
    return;
  }
  const { openMemoryDatabase } = await import('../lib/db.mjs');
  // The SQLite handles must be released before the temp directory can be removed
  // on Windows, so cleanup order is managed here instead of in tempRoot().
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-companion-import-db-'));
  const handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) {
      try { handle.close(); } catch { /* already closed */ }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const { archive, journal } = seedSyntheticRoot(root);
  const counts = fixtureCounts(archive, journal);
  const file = path.join(root, 'home/memory/companion-memory.db');
  const db = await openMemoryDatabase({ file });
  handles.push(db);

  // The host already captured one journal message; the import must reuse that
  // evidence row instead of writing a second one (capture and import share eventKey).
  const capturedRecord = journal.find(item => item.role === 'assistant');
  assert.ok(capturedRecord);
  const capturedRow = toSourceEvent({
    sessionId: capturedRecord.sessionId,
    event: {
      type: 'assistant/message',
      seq: capturedRecord.seq,
      time: capturedRecord.at,
      data: { message: { content: [{ type: 'text', text: capturedRecord.text }] } },
    },
    viewer: { userId: USER_ID, personaId: PERSONA_ID, worldId: '' },
    clock: CLOCK,
  });
  assert.ok(capturedRow);
  assert.equal(capturedRow.eventKey, capturedRecord.id);
  const capturedAppend = db.appendEvent(capturedRow);
  assert.equal(capturedAppend.inserted, true);

  const first = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  assert.equal(first.inserted, counts.total);
  assert.equal(first.deduped, 0);
  assert.equal(first.report.totals.eventsInserted, counts.total - 1);
  assert.equal(first.report.totals.eventsDeduped, 1);
  assert.equal(db.stats().events, counts.total);
  const sharedMemory = db.listMemories({
    userId: USER_ID, personaId: PERSONA_ID, predicate: 'import:conversation_reply', limit: 100,
  }).find(row => row.dedupeKey === `import:conversation:${capturedRecord.id}`);
  assert.ok(sharedMemory, '同一条 journal 记录仍要落一条记忆');
  assert.equal(sharedMemory.sourceId, capturedAppend.sourceId, '记忆应指向 capture 写下的证据行');
  assert.deepEqual(
    db.evidenceFor(sharedMemory.id).map(item => item.sourceId),
    [capturedAppend.sourceId],
  );
  // `includeExpired` matters: the fixture contains one archived row.
  assert.equal(
    db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, includeExpired: true }),
    counts.total,
  );
  assert.equal(first.report.totals.evidenceFailed, 0);
  assert.equal(first.report.totals.evidenceExisting, 0);
  assert.equal(first.report.reconciliation.ok, true, JSON.stringify(first.report.reconciliation.checks.filter(check => !check.ok)));

  // Spot-check the store through the contract read path.
  const sample = db.getMemory(first.report.memoryIds[0]);
  assert.ok(sample);
  assert.equal(sample.userId, USER_ID);
  assert.equal(sample.personaId, PERSONA_ID);
  assert.ok(Array.isArray(sample.tags) && sample.tags.includes(IMPORT_TAG));
  assert.ok(db.evidenceFor(sample.id).length >= 1);

  const second = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 1000 });
  assert.equal(second.inserted, 0);
  assert.equal(second.deduped, counts.total);
  assert.equal(second.report.totals.evidenceLinked, 0, '重复运行不得重写证据关联');
  assert.equal(second.report.totals.evidenceExisting, counts.total);
  assert.equal(second.report.totals.refreshed, 0, '未开启 refresh 时不得改动已有行');
  assert.equal(second.report.reconciliation.ok, true);
  const summaryBefore = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, kind: 'summary', limit: 1 })[0];
  assert.equal(summaryBefore.importance, SUMMARY_IMPORTANCE_CAP);

  // Refresh repairs a drifted row once and is a no-op afterwards.
  db.updateMemory(summaryBefore.id, { importance: 0.9 }, { reason: 'test-drift' });
  const drifted = db.getMemory(summaryBefore.id);
  assert.equal(drifted.importance, 0.9);
  const refreshRun = await runImport({
    root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 2000, refresh: true,
  });
  assert.equal(refreshRun.inserted, 0);
  assert.equal(refreshRun.report.totals.refreshed, 1);
  assert.equal(refreshRun.report.totals.refreshFailed, 0);
  assert.equal(db.getMemory(summaryBefore.id).importance, SUMMARY_IMPORTANCE_CAP);
  assert.equal(db.getMemory(summaryBefore.id).revision, drifted.revision + 1);
  assert.equal(refreshRun.report.reconciliation.ok, true, JSON.stringify(refreshRun.report.reconciliation.checks.filter(check => !check.ok)));
  const idempotentRefresh = await runImport({
    root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 3000, refresh: true,
  });
  assert.equal(idempotentRefresh.report.totals.refreshed, 0);
  assert.equal(
    db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, includeExpired: true }),
    counts.total,
  );
  assert.equal(db.stats().events, counts.total);
  db.close();

  // Data survives a close/reopen cycle.
  const reopened = await openMemoryDatabase({ file });
  handles.push(reopened);
  assert.equal(
    reopened.countMemories({ userId: USER_ID, personaId: PERSONA_ID, includeExpired: true }),
    counts.total,
  );
});

// ---------------------------------------------------------------------------
// real local corpus acceptance (read-only; skipped when the files are absent)
// ---------------------------------------------------------------------------

test('real corpus (read-only): full import, reconciliation and idempotent re-import', async (t) => {
  const corpus = loadRealCorpus();
  if (!corpus) {
    t.skip('缺少 home/memory/astrbot-import.json 或 conversation.jsonl，跳过真实语料验收');
    return;
  }
  const archiveCount = corpus.archiveCount;
  const journalCount = corpus.journalCount;
  const total = archiveCount + journalCount;
  t.diagnostic(
    `真实语料：archiveCount=${archiveCount}（manifest.importedCount=${corpus.archive.manifest.importedCount}）`
    + ` journalCount=${journalCount}（user=${corpus.byRole.user ?? 0} assistant=${corpus.byRole.assistant ?? 0}`
    + ` invalidLines=${corpus.invalidLines}） total=${total}`,
  );
  assert.equal(corpus.archive.manifest.importedCount, archiveCount, '清单声明条数必须与归档数组长度一致');
  assert.equal(
    new Set(corpus.archive.memories.map(row => row.sourceId)).size,
    archiveCount,
    '归档 sourceId 必须唯一（否则 dedupe 期望会变）',
  );

  const root = tempRoot(t);
  seedRealRoot(root);
  const archiveFile = path.join(root, 'home/memory/astrbot-import.json');
  const conversationFile = path.join(root, 'home/memory/conversation.jsonl');
  const before = { archive: sha256File(archiveFile), conversation: sha256File(conversationFile) };

  const db = createFakeDb();
  const first = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK });
  assert.equal(first.report.totals.candidates, total);
  assert.equal(first.inserted, total);
  assert.equal(first.deduped, 0);
  assert.equal(first.skipped, 0);
  assert.equal(first.report.totals.evidenceLinked, total);
  assert.equal(first.report.byMemoryType.conversation_user.count, corpus.byRole.user ?? 0);
  assert.equal(first.report.byMemoryType.conversation_assistant.count, corpus.byRole.assistant ?? 0);
  assert.equal(first.report.byStatus.archived ?? 0, corpus.archived);
  assert.equal(first.report.reconciliation.ok, true, JSON.stringify(first.report.reconciliation.checks.filter(check => !check.ok)));
  assert.equal(first.report.reconciliation.summary.total, total);
  assert.equal(first.report.reconciliation.summary.duplicates, 0);
  assert.equal(db._memories.size, total);
  assert.equal(db._events.size, total);
  // Source data must stay byte-identical.
  assert.equal(sha256File(archiveFile), before.archive);
  assert.equal(sha256File(conversationFile), before.conversation);

  const second = await runImport({ root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 1000 });
  assert.equal(second.inserted, 0);
  assert.equal(second.deduped, total);
  assert.equal(second.report.totals.eventsInserted, 0);
  assert.equal(second.report.reconciliation.ok, true);
  assert.equal(db._memories.size, total);
  assert.equal(db._events.size, total);
});

test('real corpus survives journal growth: a longer copy imports with scaled totals', async (t) => {
  const corpus = loadRealCorpus();
  if (!corpus) {
    t.skip('缺少真实 journal，跳过增长仿真');
    return;
  }
  const root = tempRoot(t);
  seedRealRoot(root);

  // Grow the journal the way the desktop would: keep every real line, append new
  // messages with fresh unique ids. Real files are never touched.
  const grown = [...corpus.journal];
  const lastSeq = grown.reduce((max, record) => Math.max(max, Number(record.seq) || 0), 0);
  const extra = 120;
  for (let index = 0; index < extra; index++) {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    grown.push(journalRecord({
      sessionId: 'session-growth-simulation',
      seq: lastSeq + 1 + index,
      role,
      text: `${role} 增长仿真第 ${index + 1} 条`,
    }));
  }
  const grownPath = path.join(root, 'grown-journal.jsonl');
  fs.writeFileSync(grownPath, grown.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  const grownHash = sha256File(grownPath);
  const total = corpus.archiveCount + grown.length;
  t.diagnostic(`增长仿真：journalCount=${grown.length}（原 ${corpus.journalCount}） total=${total}`);

  const db = createFakeDb();
  const first = await runImport({
    root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK, conversationPath: grownPath,
  });
  assert.equal(first.report.totals.candidates, total);
  assert.equal(first.inserted, total);
  assert.equal(first.deduped, 0);
  assert.equal(first.report.totals.eventsInserted, total);
  assert.equal(first.report.reconciliation.ok, true, JSON.stringify(first.report.reconciliation.checks.filter(check => !check.ok)));
  assert.equal(
    first.report.byMemoryType.conversation_user.count,
    grown.filter(record => record.role === 'user').length,
  );
  assert.equal(sha256File(grownPath), grownHash, '注入的 journal 不得被修改');
  // The real files are still untouched by the growth simulation.
  assert.equal(
    sha256File(path.join(root, 'home/memory/conversation.jsonl')),
    sha256File(REAL_CONVERSATION),
  );

  const second = await runImport({
    root, db, userId: USER_ID, personaId: PERSONA_ID, clock: CLOCK + 1000, conversationPath: grownPath,
  });
  assert.equal(second.inserted, 0);
  assert.equal(second.deduped, total);
  assert.equal(db._memories.size, total);
  assert.equal(db._events.size, total);
});
