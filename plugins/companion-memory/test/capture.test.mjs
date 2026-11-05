import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openMemoryDatabase } from '../lib/db.mjs';
import {
  EXTRACT_JOB_TYPE,
  captureCursorKey,
  captureEvent,
  messageFromEvent,
  noteCaptureBatch,
  pendingBatches,
  readCaptureCursor,
  shouldCapture,
  toSourceEvent,
  unbatchedEvents,
} from '../lib/capture.mjs';
import { reasonCodes, runJobs } from '../lib/jobs.mjs';

const USER_ID = 'user_local';
const PERSONA_ID = 'march7';
const VIEWER = { userId: USER_ID, personaId: PERSONA_ID, worldId: '' };
const PERSONA = { id: PERSONA_ID, name: '三月七' };
const BASE_TIME = Date.parse('2026-03-07T10:00:00.000Z');
const SESSION_ID = 'sess_capture_1';

const CONFIG = { extraction: { enabled: true, minMessages: 3, maxMessages: 10 } };

// --- harness -----------------------------------------------------------------

// Every test owns a throwaway directory; handles are closed before removal
// because Windows keeps a lock on open SQLite files.
function createHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-capture-'));
  const file = path.join(dir, 'memory.db');
  const opened = [];
  const open = async () => {
    const db = await openMemoryDatabase({ file });
    opened.push(db);
    return db;
  };
  t.after(() => {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, open };
}

// --- event builders (shape matches the DSH session/event payload) ------------

function userEvent(seq, body, overrides = {}) {
  return {
    type: 'user/message',
    seq,
    time: new Date(BASE_TIME + seq * 1000).toISOString(),
    data: {
      message: {
        role: 'user',
        source: { kind: 'user', form: overrides.form ?? 'desktop' },
        content: [{ type: 'text', text: body }],
      },
    },
    ...overrides.event,
  };
}

function assistantEvent(seq, body, overrides = {}) {
  return {
    type: 'assistant/message',
    seq,
    time: new Date(BASE_TIME + seq * 1000).toISOString(),
    data: {
      message: {
        role: 'assistant',
        source: { kind: 'assistant' },
        content: [{ type: 'text', text: body }],
      },
    },
    ...overrides.event,
  };
}

function injectedEvent(seq, kind, body = '这是系统注入的材料') {
  return {
    type: 'user/message',
    seq,
    time: new Date(BASE_TIME + seq * 1000).toISOString(),
    data: {
      message: {
        role: 'user',
        source: { kind },
        content: [{ type: 'text', text: body }],
      },
    },
  };
}

function capture(db, event, { sessionId = SESSION_ID, viewer = VIEWER } = {}) {
  return captureEvent({ db, sessionId, event, viewer });
}

function captureAll(db, sessionId, events, viewer = VIEWER) {
  const results = [];
  for (const event of events) results.push(capture(db, event, { sessionId, viewer }));
  return results;
}

function sessionRows(db, sessionId, viewer = VIEWER) {
  return db.eventsForSession(sessionId, { limit: 200 })
    .filter(row => row.userId === viewer.userId && row.personaId === viewer.personaId);
}

/** Only rows capture would accept as conversation (desktop origin + chat role). */
function conversationRows(db, sessionId, viewer = VIEWER) {
  return sessionRows(db, sessionId, viewer)
    .filter(row => row.sourceKind === 'desktop_conversation')
    .filter(row => row.role === 'user' || row.role === 'assistant');
}

function userIds(db, sessionId, viewer = VIEWER) {
  return sessionRows(db, sessionId, viewer).filter(row => row.role === 'user').map(row => row.sourceId);
}

/** Seed one raw evidence row without going through capture. */
function seedEvent(db, overrides = {}) {
  return db.appendEvent({
    eventKey: `seed:${overrides.eventKey ?? '1'}`,
    role: 'user',
    sourceKind: 'desktop_conversation',
    occurredAt: new Date(BASE_TIME).toISOString(),
    content: '种子证据',
    userId: USER_ID,
    personaId: PERSONA_ID,
    worldId: '',
    ...overrides,
  });
}

function stubLlm(output) {
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      return typeof output === 'function' ? output(request) : output;
    },
  };
}

function failingLlm(message = 'network down') {
  const calls = [];
  return {
    calls,
    async complete() {
      calls.push(Date.now());
      throw new Error(message);
    },
  };
}

function candidate(overrides = {}) {
  return {
    kind: 'preference',
    scope: 'user_global',
    subject: 'user',
    predicate: 'prefers_drink',
    value: '用户喜欢喝乌龙茶',
    evidence_source_ids: [],
    confidence: 0.9,
    importance: 0.6,
    validity: 'current',
    suggested_operation: 'insert',
    mention_policy: 'direct',
    ...overrides,
  };
}

// --- capture: event shape and echo guard -------------------------------------

test('shouldCapture 只接受真实用户消息与有文本的助手消息', () => {
  const userMessage = userEvent(1, '我想记住我喜欢乌龙茶');
  const decided = shouldCapture(userMessage, { viewer: VIEWER });
  assert.equal(decided.capture, true);
  assert.equal(decided.message?.role, 'user');
  assert.match(decided.reason, /用户消息/);

  const assistant = shouldCapture(assistantEvent(2, '好呀，我记下啦。'), { viewer: VIEWER });
  assert.equal(assistant.capture, true);
  assert.match(assistant.reason, /助手/);

  // Old host shape: `data` is the message itself.
  const legacy = { type: 'user/message', seq: 3, time: new Date(BASE_TIME).toISOString(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '旧形态的消息' }] } };
  assert.equal(shouldCapture(legacy, { viewer: VIEWER }).capture, true);
  assert.equal(messageFromEvent(legacy)?.content?.[0]?.text, '旧形态的消息');

  // No text part: tool cards and empty bodies are not conversation.
  const toolCard = { type: 'assistant/message', seq: 4, data: { message: { role: 'assistant', content: [{ type: 'tool-call', name: 'x', args: {} }] } } };
  assert.equal(shouldCapture(toolCard, { viewer: VIEWER }).capture, false);
  assert.match(shouldCapture(toolCard, { viewer: VIEWER }).reason, /没有可捕获的文本/);

  const blank = userEvent(5, '   ');
  assert.equal(shouldCapture(blank, { viewer: VIEWER }).capture, false);

  // Non message events are ignored outright.
  assert.equal(shouldCapture({ type: 'session/start', seq: 0 }, { viewer: VIEWER }).capture, false);
  assert.equal(shouldCapture(null, { viewer: VIEWER }).capture, false);
});

test('注入材料被拒：记忆回声、运行时上下文、dsh-* 与 system 都不写库', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const injectedKinds = ['companion-memory', 'runtime-context', 'dsh-memory', 'dsh-context', 'system', 'system-reminder', 'tool'];
  for (const [index, kind] of injectedKinds.entries()) {
    const event = injectedEvent(index + 1, kind);
    const decision = shouldCapture(event, { viewer: VIEWER });
    assert.equal(decision.capture, false, `${kind} 必须被拒绝`);
    assert.match(decision.reason, /注入材料/, `${kind} 的拒绝原因应说明注入`);
    assert.equal(toSourceEvent({ sessionId: SESSION_ID, event, viewer: VIEWER }), null);

    const captured = capture(db, event);
    assert.equal(captured.captured, false);
  }

  // A user message whose source.kind is not 'user' is not user speech either.
  const notUser = injectedEvent(20, 'assistant');
  assert.equal(shouldCapture(notUser, { viewer: VIEWER }).capture, false);
  assert.match(shouldCapture(notUser, { viewer: VIEWER }).reason, /不是真实用户消息/);

  assert.equal(db.stats().events, 0, '注入材料不得写入 source_events');
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 0);
});

test('toSourceEvent 生成稳定事件键、角色与身份字段', () => {
  const event = userEvent(7, '我喜欢下雨天。');
  const row = toSourceEvent({ sessionId: SESSION_ID, event, viewer: VIEWER, clock: BASE_TIME });
  assert.ok(row);
  assert.equal(row.eventKey, `${SESSION_ID}:7`);
  assert.equal(row.seq, 7);
  assert.equal(row.role, 'user');
  assert.equal(row.sourceKind, 'desktop_conversation');
  assert.equal(row.occurredAt, new Date(BASE_TIME + 7000).toISOString());
  assert.equal(row.userId, USER_ID);
  assert.equal(row.personaId, PERSONA_ID);
  assert.equal(row.worldId, '');
  assert.equal(row.content, '我喜欢下雨天。');
  assert.equal(row.meta.eventType, 'user/message');
  assert.equal(row.meta.redacted, false);

  const assistantRow = toSourceEvent({ sessionId: SESSION_ID, event: assistantEvent(8, '记住啦。'), viewer: VIEWER });
  assert.equal(assistantRow.role, 'assistant');
  assert.equal(assistantRow.eventKey, `${SESSION_ID}:8`);

  // No identity => no evidence row.
  assert.equal(toSourceEvent({ sessionId: SESSION_ID, event, viewer: {} }), null);
  // No session id => unusable evidence.
  assert.equal(toSourceEvent({ sessionId: '', event, viewer: VIEWER }), null);
});

test('重复捕获同一事件只写一行，并且不改写原文', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const first = capture(db, userEvent(3, '我养了一只叫团子的猫。'));
  assert.equal(first.captured, true);
  assert.match(first.sourceId, /^evt_/);

  // Same event re-delivered (retry/HMR) with a different body: still one row,
  // and the original text wins because evidence is immutable.
  const second = capture(db, userEvent(3, '我养了一只叫团子的狗。'));
  assert.equal(second.captured, false);
  assert.equal(second.sourceId, first.sourceId);

  const rows = sessionRows(db, SESSION_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '我养了一只叫团子的猫。');
  assert.equal(rows[0].eventKey, `${SESSION_ID}:3`);
  assert.equal(db.stats().events, 1);
});

test('捕获内容会脱敏并截断', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const secrets = '我的密钥是 sk-abcdefghijklmnop，password: hunter2026，token=abcd12345，别告诉别人。';
  const captured = capture(db, userEvent(1, secrets));
  assert.equal(captured.captured, true);

  const stored = db.getEvent(captured.sourceId);
  assert.ok(!stored.content.includes('sk-abcdefghijklmnop'), 'sk- 密钥必须脱敏');
  assert.ok(!stored.content.includes('hunter2026'), '密码必须脱敏');
  assert.ok(!stored.content.includes('abcd12345'), 'token 必须脱敏');
  assert.ok(stored.content.includes('[REDACTED]'));
  assert.equal(stored.meta.redacted, true);
  assert.ok(stored.content.endsWith('别告诉别人。'), '脱敏不能破坏其余正文');

  // Truncation (plan §5.1 keeps the raw text but bounded).
  const long = captureEvent({ db, sessionId: 'sess_long', event: userEvent(1, '长'.repeat(400)), viewer: VIEWER, maxChars: 100 });
  const trimmed = db.getEvent(long.sourceId);
  assert.equal(trimmed.content.length, 100);
  assert.ok(trimmed.content.endsWith('…'));
  assert.equal(trimmed.meta.truncated, true);
});

// --- capture: batching and cursor -------------------------------------------

test('不足阈值不建作业，达到阈值建作业且游标正确', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  capture(db, userEvent(1, '我最近在学吉他。'));
  capture(db, userEvent(2, '我比较喜欢指弹。'));
  assert.equal(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 3, maxMessages: 10 }), null);
  assert.equal(pendingBatches({ db }).length, 0);
  assert.equal(readCaptureCursor({ db, viewer: VIEWER }), null);

  const third = capture(db, userEvent(3, '每周三晚上有课。'));
  const noted = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 3, maxMessages: 10 });
  assert.ok(noted, '达到阈值必须创建作业');
  assert.equal(noted.messageCount, 3);
  assert.equal(noted.cursor, 3);
  assert.equal(noted.sourceIds.length, 3);
  assert.equal(noted.reused, undefined);

  const jobs = pendingBatches({ db });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, noted.jobId);
  assert.equal(jobs[0].type, EXTRACT_JOB_TYPE);
  assert.equal(jobs[0].state, 'pending');
  assert.equal(jobs[0].streamKey, `${USER_ID}:${PERSONA_ID}:-`);
  assert.equal(jobs[0].cursor, 3);
  assert.equal(jobs[0].payload.messageCount, 3);
  assert.deepEqual(jobs[0].payload.sourceIds, noted.sourceIds);
  assert.ok(jobs[0].payload.sourceIds.includes(third.sourceId));

  const cursor = readCaptureCursor({ db, viewer: VIEWER });
  assert.equal(cursor.batched, 3);
  assert.equal(cursor.afterSourceId, third.sourceId);
  assert.equal(db.meta(captureCursorKey(VIEWER)), JSON.stringify({
    version: cursor.version ?? 1,
    batched: 3,
    afterOccurredAt: cursor.afterOccurredAt,
    afterSourceId: third.sourceId,
    updatedAt: cursor.updatedAt,
  }));

  // Nothing new: no second job, cursor untouched.
  assert.equal(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 3, maxMessages: 10 }), null);
  assert.equal(pendingBatches({ db }).length, 1);
  assert.deepEqual(unbatchedEvents({ db, viewer: VIEWER }), []);

  // A new batch may be queued while an earlier one is still in flight
  // (enqueueJob force): exactly one extra job, and the two source id lists
  // must never overlap.
  const fourth = capture(db, userEvent(4, '老师说我有进步。'));
  const second = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 1, maxMessages: 10 });
  assert.ok(second, '在飞作业不得吞掉新批');
  assert.notEqual(second.jobId, noted.jobId);
  assert.equal(second.messageCount, 1);
  assert.deepEqual(second.sourceIds, [fourth.sourceId]);
  assert.ok(!second.sourceIds.some(id => noted.sourceIds.includes(id)), '两批 sourceIds 不得重叠');
  assert.equal(pendingBatches({ db }).length, 2, '一轮在飞只多出 1 个新作业');
  assert.equal(readCaptureCursor({ db, viewer: VIEWER }).batched, 4);

  // Same call again with no new messages: still two jobs, no duplicate batch.
  assert.equal(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 1, maxMessages: 10 }), null);
  assert.equal(pendingBatches({ db }).length, 2);
  assert.deepEqual(unbatchedEvents({ db, viewer: VIEWER }), []);
});

test('单批受 maxMessages 限制，游标按批累计', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  for (let seq = 1; seq <= 5; seq++) capture(db, userEvent(seq, `第 ${seq} 条消息`));

  const first = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 3 });
  assert.equal(first.messageCount, 3);
  assert.equal(first.cursor, 3);
  assert.equal(first.sourceIds.length, 3);

  const drained = await runJobs({ db, llm: stubLlm('[]'), config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(drained.processed, 1);
  assert.equal(drained.failed, 0);

  const second = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 3 });
  assert.equal(second.messageCount, 2);
  assert.equal(second.cursor, 5);
  const allIds = sessionRows(db, SESSION_ID).map(row => row.sourceId);
  assert.deepEqual(second.sourceIds, allIds.slice(3), '第二批必须正好是剩余消息');
  assert.equal(readCaptureCursor({ db, viewer: VIEWER }).batched, 5);
});

// --- jobs: happy path --------------------------------------------------------

test('假 llm 返回候选：落库 + 证据 + 作业完成 + 游标推进', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  captureAll(db, SESSION_ID, [
    userEvent(1, '我平常喜欢喝乌龙茶，不太喝咖啡。'),
    assistantEvent(2, '好的，乌龙茶记下了。'),
    userEvent(3, '周末一般在家看书。'),
  ]);
  const noted = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 3, maxMessages: 10 });
  assert.ok(noted);

  const evidenceId = userIds(db, SESSION_ID)[0];
  const llm = stubLlm(JSON.stringify([candidate({ evidence_source_ids: [evidenceId] })]));

  const summary = await runJobs({ db, llm, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(summary.failed, 0);
  assert.equal(summary.processed, 1);
  const result = summary.results[0];
  assert.equal(result.outcome, 'done');
  assert.equal(result.candidates, 1);
  assert.equal(result.accepted, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.evidence, 1);
  assert.deepEqual(result.errors, []);

  const memories = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: '' });
  assert.equal(memories.length, 1);
  const memory = memories[0];
  assert.equal(memory.status, 'confirmed');
  assert.equal(memory.kind, 'preference');
  assert.equal(memory.scope, 'user_global');
  assert.equal(memory.predicate, 'prefers_drink');
  assert.equal(memory.value, '用户喜欢喝乌龙茶');
  assert.equal(memory.sourceKind, 'extracted');
  assert.equal(memory.sourceId, evidenceId);
  assert.equal(memory.userId, USER_ID);
  assert.ok(memory.tags.includes('auto_extracted'));
  assert.equal(memory.occurredAt, new Date(BASE_TIME + 1000).toISOString());

  const evidence = db.evidenceFor(memory.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].sourceId, evidenceId);
  assert.ok(evidence[0].content.includes('乌龙茶'));

  const [job] = db.jobs({ type: EXTRACT_JOB_TYPE, limit: 5 });
  assert.equal(job.state, 'done');
  assert.equal(job.attempts, 0);
  assert.equal(job.cursor, 3);
  assert.equal(job.lastError, '');

  // The model saw the batched messages through the prompt.
  assert.ok(llm.calls.length === 1);
  assert.ok(llm.calls[0].input.includes(`[id=${evidenceId}] user:`));
});

test('pending 候选落库为 status=pending 并把闸门原因写进 tags', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  captureAll(db, SESSION_ID, [userEvent(1, '我猜我大概是喜欢喝茶的吧。'), assistantEvent(2, '嗯嗯。')]);
  assert.ok(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 10 }));

  const evidenceId = userIds(db, SESSION_ID)[0];
  const llm = stubLlm(JSON.stringify([
    candidate({ evidence_source_ids: [evidenceId], confidence: 0.2 }),
  ]));
  const summary = await runJobs({ db, llm, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(summary.processed, 1);
  assert.equal(summary.results[0].pending, 1);

  const pending = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: '', status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');
  assert.ok(pending[0].tags.includes('pending'));
  assert.ok(pending[0].tags.some(tag => tag.startsWith('reason:')), 'pending 必须带 reason:<code> 标签');
  assert.ok(pending[0].tags.includes('reason:low_confidence'));
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: '', status: 'confirmed' }).length, 0);

  // reasonCodes is the same mapping used for the pending list.
  const codes = reasonCodes({ flags: { evidenceCount: 1, missingIds: [], guess: ['我猜'] }, normalized: { scope: 'user_global', confidence: 0.2 }, minAcceptConfidence: 0.5 });
  assert.ok(codes.includes('guess'));
  assert.ok(codes.includes('low_confidence'));
});

test('同一 predicate 的新值走修订链：旧值 superseded，新值成为当前事实', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  captureAll(db, 'sess_a', [userEvent(1, '我平常喜欢喝乌龙茶。')]);
  assert.ok(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 1, maxMessages: 10 }));
  const firstId = userIds(db, 'sess_a')[0];
  await runJobs({
    db,
    llm: stubLlm(JSON.stringify([candidate({ evidence_source_ids: [firstId] })])),
    config: CONFIG,
    viewer: VIEWER,
    persona: PERSONA,
  });

  captureAll(db, 'sess_b', [userEvent(2, '我最近改喝美式咖啡了，乌龙茶太淡。')]);
  assert.ok(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 1, maxMessages: 10 }));
  const secondId = userIds(db, 'sess_b')[0];
  const summary = await runJobs({
    db,
    llm: stubLlm(JSON.stringify([candidate({ evidence_source_ids: [secondId], value: '用户更喜欢喝美式咖啡' })])),
    config: CONFIG,
    viewer: VIEWER,
    persona: PERSONA,
  });
  assert.equal(summary.processed, 1);
  assert.equal(summary.results[0].superseded, 1);

  const confirmed = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: '', status: 'confirmed' });
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].value, '用户更喜欢喝美式咖啡');
  // A superseded row has closed its validity window, so it only shows up when
  // expired rows are requested explicitly (db.listMemories filters them out).
  const superseded = db.listMemories({
    userId: USER_ID, personaId: PERSONA_ID, worldId: '', status: 'superseded', includeExpired: true,
  });
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].value, '用户喜欢喝乌龙茶');
  assert.ok(superseded[0].validTo, '被取代的记录必须关闭有效期');
  assert.ok(db.revisionsFor(confirmed[0].id).length >= 1);
  assert.equal(db.evidenceFor(confirmed[0].id).length, 1);
});

// --- jobs: failure handling --------------------------------------------------

test('llm 抛错：作业失败但原文与游标保留，退避后可重试成功', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  captureAll(db, SESSION_ID, [
    userEvent(1, '我下周三要去看牙医。'),
    userEvent(2, '最近睡眠不太好。'),
  ]);
  const noted = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 10 });
  assert.ok(noted);
  const evidenceId = userIds(db, SESSION_ID)[0];

  const failing = failingLlm('network down');
  const failed = await runJobs({ db, llm: failing, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(failed.failed, 1);
  assert.equal(failed.processed, 0);
  assert.equal(failed.results[0].outcome, 'failed');
  assert.equal(failed.results[0].requeued, false, '失败批次不得自动重排');
  assert.equal(failed.results[0].requeueable, true, '存储层支持 requeueJob 时应提示可人工重跑');

  let [job] = db.jobs({ type: EXTRACT_JOB_TYPE, limit: 5 });
  assert.equal(job.state, 'pending', '未超过重试上限时回到 pending 等待退避');
  assert.equal(job.attempts, 1);
  assert.ok(job.lastError.includes('network down'));
  assert.ok(job.nextRetryAt, '失败必须记录下次重试时间');
  assert.equal(job.payload.messageCount, 2, '载荷里的原文游标必须保留');

  // Raw text and the capture cursor survive the failure.
  assert.equal(sessionRows(db, SESSION_ID).length, 2);
  assert.ok(sessionRows(db, SESSION_ID).some(row => row.content.includes('牙医')));
  assert.equal(readCaptureCursor({ db, viewer: VIEWER }).batched, 2);

  // Immediate retry: still inside the backoff window, so nothing is claimed.
  const tooEarly = await runJobs({ db, llm: stubLlm('[]'), config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(tooEarly.processed, 0);
  assert.equal(tooEarly.failed, 0);

  // After the backoff the same job is retried and now succeeds.
  const retry = await runJobs({
    db,
    llm: stubLlm(JSON.stringify([candidate({ evidence_source_ids: [evidenceId] })])),
    config: CONFIG,
    viewer: VIEWER,
    persona: PERSONA,
    now: Date.now() + 60_000,
  });
  assert.equal(retry.processed, 1);
  assert.equal(retry.failed, 0);
  [job] = db.jobs({ type: EXTRACT_JOB_TYPE, limit: 5 });
  assert.equal(job.state, 'done');
  assert.equal(job.cursor, 2);
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: '' }).length, 1);
});

test('连续失败到上限后作业转 failed，可用 requeueJob 人工重跑', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  captureAll(db, SESSION_ID, [userEvent(1, '我养了一只叫团子的猫。'), userEvent(2, '它今年三岁了。')]);
  const noted = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 10 });
  assert.ok(noted);
  const evidenceId = userIds(db, SESSION_ID)[0];

  // db.mjs parks a job after 5 attempts; zero backoff keeps the loop fast while
  // the claim clock still moves forward.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const run = await runJobs({
      db,
      llm: failingLlm('provider offline'),
      config: CONFIG,
      viewer: VIEWER,
      persona: PERSONA,
      retryDelayMs: 0,
      now: Date.now() + attempt * 1000,
    });
    assert.equal(run.failed, 1, `第 ${attempt} 次失败必须计入`);
    assert.equal(run.results[0].requeueable, true);
  }

  let [job] = db.jobs({ type: EXTRACT_JOB_TYPE, limit: 5 });
  assert.equal(job.state, 'failed');
  assert.equal(job.attempts, 5);
  assert.match(job.lastError, /provider offline/);
  assert.equal(job.payload.sourceIds.length, 2, '失败作业必须保留原文 id');
  assert.equal(sessionRows(db, SESSION_ID).length, 2, '原文必须保留');
  assert.equal(readCaptureCursor({ db, viewer: VIEWER }).batched, 2, '捕获游标不得回退');
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 0);

  // Operator path: the parked batch is never re-queued automatically, but
  // requeueJob puts it back and a healthy model finally lands the fact.
  const requeued = db.requeueJob(job.jobId, { resetAttempts: true });
  assert.equal(requeued.ok, true);
  assert.equal(requeued.job.state, 'pending');
  assert.equal(requeued.job.attempts, 0);

  const retry = await runJobs({
    db,
    llm: stubLlm(JSON.stringify([candidate({ evidence_source_ids: [evidenceId] })])),
    config: CONFIG,
    viewer: VIEWER,
    persona: PERSONA,
    now: Date.now() + 120_000,
  });
  assert.equal(retry.processed, 1);
  [job] = db.jobs({ type: EXTRACT_JOB_TYPE, limit: 5 });
  assert.equal(job.state, 'done');
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 1);
});

test('配置关闭抽取时空完成，不堆积失败次数', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  captureAll(db, SESSION_ID, [userEvent(1, '随便聊聊今天的天气。'), userEvent(2, '外面在下雨。')]);
  assert.ok(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 10 }));

  const summary = await runJobs({
    db,
    llm: stubLlm('[]'),
    config: { extraction: { enabled: false, minMessages: 2, maxMessages: 10 } },
    viewer: VIEWER,
    persona: PERSONA,
  });
  assert.equal(summary.empty, 1);
  assert.equal(summary.failed, 0);

  const [job] = db.jobs({ type: EXTRACT_JOB_TYPE, limit: 5 });
  assert.equal(job.state, 'done');
  assert.equal(job.attempts, 0, '配置禁用不得消耗重试次数');
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 0);
  assert.equal(sessionRows(db, SESSION_ID).length, 2, '原文必须保留');
});

test('未配置模型时作业失败但仍可重试，runJobs 不抛错', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  captureAll(db, SESSION_ID, [userEvent(1, '我住在杭州。'), userEvent(2, '工作在滨江。')]);
  assert.ok(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 10 }));

  const summary = await runJobs({ db, llm: null, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(summary.failed, 1);
  const [job] = db.jobs({ type: EXTRACT_JOB_TYPE, limit: 5 });
  assert.equal(job.attempts, 1);
  assert.match(job.lastError, /语言模型|llm/);

  // Degraded inputs never throw at the caller.
  const noDb = await runJobs({ db: null, llm: null, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(noDb.processed, 0);
  assert.ok(noDb.reason);

  const noIdentity = await runJobs({ db, llm: null, config: CONFIG, viewer: {}, persona: PERSONA });
  assert.equal(noIdentity.processed, 0);
  assert.ok(noIdentity.reason);

  const brokenDb = await runJobs({
    db: {
      claimJob() {
        throw new Error('database is locked');
      },
    },
    llm: null,
    config: CONFIG,
    viewer: VIEWER,
    persona: PERSONA,
  });
  assert.equal(brokenDb.processed, 0);
  assert.match(brokenDb.reason, /无法领取作业|database is locked/);
});

// --- isolation ---------------------------------------------------------------

test('跨 user/persona 不串：游标、批次与落库互不可见', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const viewerA = { userId: 'user_a', personaId: 'march7', worldId: '' };
  const viewerB = { userId: 'user_b', personaId: 'march7', worldId: '' };
  const viewerC = { userId: 'user_a', personaId: 'other_persona', worldId: '' };

  // Both streams queue a batch before either is drained: the stream-aware claim
  // must hand each worker only its own job, whatever the queue head is.
  captureAll(db, 'sess_a', [userEvent(1, 'A 喜欢下雨天。'), userEvent(2, 'A 养了一只猫。')], viewerA);
  captureAll(db, 'sess_b', [userEvent(1, 'B 喜欢晒太阳。'), userEvent(2, 'B 养了一只狗。')], viewerB);

  const notedA = noteCaptureBatch({ db, viewer: viewerA, minMessages: 2, maxMessages: 10 });
  const notedB = noteCaptureBatch({ db, viewer: viewerB, minMessages: 2, maxMessages: 10 });
  assert.ok(notedA);
  assert.ok(notedB);
  assert.notEqual(notedA.jobId, notedB.jobId);
  assert.equal(pendingBatches({ db }).length, 2);

  const idsA = sessionRows(db, 'sess_a', viewerA).map(row => row.sourceId);
  const idsB = sessionRows(db, 'sess_b', viewerB).map(row => row.sourceId);
  assert.deepEqual(notedA.sourceIds, idsA);
  assert.deepEqual(notedB.sourceIds, idsB);
  assert.ok(!notedA.sourceIds.some(id => idsB.includes(id)));
  // Each stream keeps its own schema_meta cursor.
  assert.equal(readCaptureCursor({ db, viewer: viewerA }).afterSourceId, idsA[1]);
  assert.equal(readCaptureCursor({ db, viewer: viewerB }).afterSourceId, idsB[1]);
  assert.equal(readCaptureCursor({ db, viewer: viewerC }), null, '别的 persona 游标不得被推进');

  // A drains only A: B's job must stay untouched (state and attempts).
  const llmA = stubLlm(JSON.stringify([candidate({ evidence_source_ids: [idsA[0]] })]));
  const summaryA = await runJobs({ db, llm: llmA, config: CONFIG, viewer: viewerA, persona: PERSONA });
  assert.equal(summaryA.processed, 1);
  assert.equal(summaryA.results[0].streamKey, 'user_a:march7:-');
  assert.equal(summaryA.results[0].inserted, 1);

  const bJob = db.jobs({ type: EXTRACT_JOB_TYPE }).find(job => job.jobId === notedB.jobId);
  assert.equal(bJob.state, 'pending', 'A 的抽取不得领取 B 的作业');
  assert.equal(bJob.attempts, 0);
  assert.equal(db.listMemories({ userId: 'user_a', personaId: 'march7' }).length, 1);
  assert.equal(db.listMemories({ userId: 'user_b', personaId: 'march7' }).length, 0, 'A 的抽取不得写进 B');

  // B's batch cannot cite A's evidence: the gate keeps it out of B's store.
  const llmB = stubLlm(JSON.stringify([candidate({ evidence_source_ids: [idsA[0]] })]));
  const summaryB = await runJobs({ db, llm: llmB, config: CONFIG, viewer: viewerB, persona: PERSONA });
  assert.equal(summaryB.processed, 1);
  assert.equal(summaryB.results[0].streamKey, 'user_b:march7:-');
  assert.equal(summaryB.results[0].pending, 1, '越界证据只能是 pending');
  const bMemories = db.listMemories({ userId: 'user_b', personaId: 'march7' });
  assert.equal(bMemories.length, 1);
  assert.equal(bMemories[0].status, 'pending');
  assert.ok(bMemories[0].tags.includes('reason:missing_evidence'));
  assert.equal(db.evidenceFor(bMemories[0].id).length, 0, '越界证据不得挂到 B 的记忆上');

  // A's store is untouched by B's run.
  const aMemories = db.listMemories({ userId: 'user_a', personaId: 'march7' });
  assert.equal(aMemories.length, 1);
  assert.equal(aMemories[0].status, 'confirmed');
  assert.equal(aMemories[0].userId, 'user_a');
  assert.equal(db.listMemories({ userId: 'user_a', personaId: 'other_persona' }).length, 0);

  // C's stream is still untouched and can be batched on its own.
  captureAll(db, 'sess_c', [userEvent(1, 'C 喜欢雪天。'), userEvent(2, 'C 养了一只鸟。')], viewerC);
  const notedC = noteCaptureBatch({ db, viewer: viewerC, minMessages: 2, maxMessages: 10 });
  assert.ok(notedC);
  assert.deepEqual(notedC.sourceIds, sessionRows(db, 'sess_c', viewerC).map(row => row.sourceId));
  assert.equal(readCaptureCursor({ db, viewer: viewerA }).afterSourceId, idsA[1], 'A 的游标不得被 C 推动');
  assert.equal(pendingBatches({ db }).length, 1);
});

// --- audited P1 regressions --------------------------------------------------

test('P1-1 建批只取真实对话证据：导入/手工/系统证据不得被重新包装成用户原话', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const captured = captureAll(db, SESSION_ID, [
    userEvent(1, '我平常喜欢喝乌龙茶。'),
    assistantEvent(2, '好呀，我记下了。'),
  ]);
  const realIds = captured.map(row => row.sourceId);

  // Migration/tool evidence: same owner, but never conversation. Re-extracting
  // it would launder an imported summary into a confirmed user fact.
  const imported = seedEvent(db, {
    eventKey: 'astrbot:summary', role: 'imported', sourceKind: 'astrbot_import',
    content: '旧库摘要：用户说他喜欢咖啡。', occurredAt: new Date(BASE_TIME + 3000).toISOString(),
  });
  const botAction = seedEvent(db, {
    eventKey: 'astrbot:proactive', role: 'imported', sourceKind: 'astrbot_import',
    content: '二月主动发过一条晚安消息。', occurredAt: new Date(BASE_TIME + 4000).toISOString(),
  });
  const manual = seedEvent(db, {
    eventKey: 'manual:1', role: 'user', sourceKind: 'manual',
    content: '手工写入的事实。', occurredAt: new Date(BASE_TIME + 5000).toISOString(),
  });
  const system = seedEvent(db, {
    eventKey: 'system:1', role: 'system', sourceKind: 'system',
    content: '系统注入内容。', occurredAt: new Date(BASE_TIME + 6000).toISOString(),
  });

  const noted = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 10 });
  assert.ok(noted);
  assert.deepEqual(noted.sourceIds, realIds, '批次只能包含真实对话消息');
  for (const row of [imported, botAction, manual, system]) {
    assert.ok(!noted.sourceIds.includes(row.sourceId), `${row.sourceId} 不得进入抽取批次`);
  }
  assert.deepEqual(conversationRows(db, SESSION_ID).map(row => row.sourceId), realIds);
  assert.deepEqual(unbatchedEvents({ db, viewer: VIEWER }), [], '未批队列同样只含真实对话');

  // The model sees the real batch; importing evidence must not be cited either.
  const llm = stubLlm(JSON.stringify([candidate({ evidence_source_ids: [realIds[0]] })]));
  const summary = await runJobs({ db, llm, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(summary.processed, 1);
  assert.equal(llm.calls.length, 1);
  for (const row of [imported, botAction, manual, system]) {
    assert.ok(!llm.calls[0].input.includes(row.sourceId), '导入证据不得出现在提示词里');
  }
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 1);
});

test('P1-1 手工伪造的作业载荷也不能把导入证据送进模型', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const imported = seedEvent(db, {
    eventKey: 'astrbot:summary2', role: 'imported', sourceKind: 'astrbot_import',
    content: '旧库摘要：用户住在上海。', occurredAt: new Date(BASE_TIME).toISOString(),
  });
  const manual = seedEvent(db, {
    eventKey: 'manual:2', role: 'user', sourceKind: 'manual',
    content: '手工事实：用户是工程师。', occurredAt: new Date(BASE_TIME + 1000).toISOString(),
  });

  assert.equal(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 1, maxMessages: 10 }), null, '没有真实对话就不建批');

  db.enqueueJob({
    type: EXTRACT_JOB_TYPE,
    streamKey: `${USER_ID}:${PERSONA_ID}:invalid`,
    cursor: 0,
    payload: {
      version: 1, userId: USER_ID, personaId: PERSONA_ID, worldId: '',
      sourceIds: [imported.sourceId, manual.sourceId], messageCount: 2,
    },
  });
  // Same owner but a foreign stream key: not ours to drain.
  const skipped = await runJobs({ db, llm: stubLlm('[]'), config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(skipped.processed, 0);

  // Drain it as its own stream (simulating a buggy producer that reuses our key).
  db.enqueueJob({
    type: EXTRACT_JOB_TYPE,
    streamKey: `${USER_ID}:${PERSONA_ID}:-`,
    cursor: 0,
    force: true,
    payload: {
      version: 1, userId: USER_ID, personaId: PERSONA_ID, worldId: '',
      sourceIds: [imported.sourceId, manual.sourceId], messageCount: 2,
    },
  });
  const llm = stubLlm('[]');
  const summary = await runJobs({ db, llm, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(llm.calls.length, 0, '非对话证据不得触发模型调用');
  assert.equal(summary.empty, 1);
  assert.equal(summary.failed, 0);
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 0);
  const job = db.jobs({ type: EXTRACT_JOB_TYPE }).find(row => row.streamKey === `${USER_ID}:${PERSONA_ID}:-`);
  assert.equal(job.state, 'done');
  assert.equal(job.attempts, 0);
});

test('P1-1 材料证据导致的 pending 带 reason:non_conversation_evidence 标签', async t => {
  // The batch loader filters material evidence out (P1-1), so the gate's own
  // second line of defence is exercised directly here: whatever the extractor
  // flags must map to a stable `reason:<code>` tag for the pending list.
  const { gateCandidate, parseCandidate } = await import('../lib/validate.mjs');

  const parsed = parseCandidate({
    ...candidate({ evidence_source_ids: ['evt_old'] }),
  });
  assert.equal(parsed.ok, true);

  const gated = gateCandidate(parsed.candidate, {
    evidence: [{
      sourceId: 'evt_old',
      role: 'imported',
      sourceKind: 'astrbot_import',
      content: '旧库摘要：用户说他喜欢咖啡。',
      userId: USER_ID,
      personaId: PERSONA_ID,
      worldId: '',
      occurredAt: new Date(BASE_TIME).toISOString(),
    }],
    viewer: VIEWER,
    now: BASE_TIME,
    config: CONFIG,
  });
  assert.equal(gated.decision, 'pending');
  assert.equal(gated.flags.conversationEvidence, 0);
  assert.deepEqual(gated.flags.nonConversationEvidence, ['evt_old']);

  const codes = reasonCodes({
    flags: gated.flags,
    normalized: gated.normalized,
    minAcceptConfidence: 0.5,
  });
  assert.ok(codes.includes('non_conversation_evidence'), '材料证据必须映射成稳定代码');
  const tags = ['auto_extracted', 'pending', ...codes.map(code => `reason:${code}`)];
  assert.ok(tags.includes('reason:non_conversation_evidence'));

  // Ordinary conversation evidence must not grow that tag.
  const healthy = reasonCodes({
    flags: { evidenceCount: 1, conversationEvidence: 1, nonConversationEvidence: [] },
    normalized: { scope: 'user_global', confidence: 0.9 },
    minAcceptConfidence: 0.5,
  });
  assert.ok(!healthy.includes('non_conversation_evidence'));
});

test('P1-2 keyset 分页：第 1000 条之后的消息仍然能建批', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const total = 1005;
  const ids = [];
  for (let index = 1; index <= total; index++) {
    const appended = db.appendEvent({
      eventKey: `bulk:${index}`,
      sessionId: 'sess_bulk',
      seq: index,
      role: 'user',
      sourceKind: 'desktop_conversation',
      occurredAt: new Date(BASE_TIME + index * 1000).toISOString(),
      content: `第 ${index} 条消息`,
      userId: USER_ID,
      personaId: PERSONA_ID,
      worldId: '',
    });
    ids.push(appended.sourceId);
  }
  assert.equal(ids.length, total);

  const batches = [];
  for (let round = 0; round < 5; round++) {
    const noted = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 1, maxMessages: 400 });
    if (!noted) break;
    batches.push(noted);
    const drained = await runJobs({ db, llm: stubLlm('[]'), config: CONFIG, viewer: VIEWER, persona: PERSONA });
    assert.equal(drained.processed, 1);
  }

  assert.equal(batches.length, 3, '1005 条消息应分三批消化');
  assert.deepEqual(batches.map(batch => batch.messageCount), [400, 400, 205]);
  assert.deepEqual(batches[0].sourceIds, ids.slice(0, 400));
  assert.ok(!batches[0].sourceIds.includes(ids[1000]), '第一批不可能包含第 1001 条');
  assert.deepEqual(batches[2].sourceIds, ids.slice(800), '第三批必须包含第 1001 条之后的消息');
  assert.ok(batches[2].sourceIds.includes(ids[1000]));
  assert.equal(batches[2].sourceIds.at(-1), ids.at(-1));
  assert.equal(readCaptureCursor({ db, viewer: VIEWER }).batched, total);
  assert.equal(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 1, maxMessages: 400 }), null, '消化完后不再建批');
  assert.deepEqual(unbatchedEvents({ db, viewer: VIEWER }), []);
});

test('P1-3 作业流按世界隔离：别的世界不得领取、不得空完成', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const w1 = { userId: USER_ID, personaId: PERSONA_ID, worldId: 'w1' };
  const w2 = { userId: USER_ID, personaId: PERSONA_ID, worldId: 'w2' };

  const captured = captureAll(db, 'sess_w1', [
    userEvent(1, '现实里我更喜欢喝乌龙茶。'),
    assistantEvent(2, '嗯，记住了。'),
  ], w1);
  const evidenceId = captured[0].sourceId;

  const noted = noteCaptureBatch({ db, viewer: w1, minMessages: 2, maxMessages: 10 });
  assert.ok(noted);
  let [job] = db.jobs({ type: EXTRACT_JOB_TYPE });
  assert.equal(job.streamKey, `${USER_ID}:${PERSONA_ID}:w1`);

  const llmW2 = stubLlm(JSON.stringify([candidate({ evidence_source_ids: [evidenceId] })]));
  const wrongWorld = await runJobs({ db, llm: llmW2, config: CONFIG, viewer: w2, persona: PERSONA });
  assert.equal(wrongWorld.processed, 0);
  assert.equal(wrongWorld.failed, 0);
  assert.equal(wrongWorld.reason, 'world-mismatch');
  assert.equal(llmW2.calls.length, 0, '别的世界不得触发模型调用');
  [job] = db.jobs({ type: EXTRACT_JOB_TYPE });
  assert.equal(job.state, 'pending', 'w1 的作业必须原样留在队列里');
  assert.equal(job.attempts, 0);

  // Its own world drains it, and only that world gets the fact.
  const llmW1 = stubLlm(JSON.stringify([candidate({ evidence_source_ids: [evidenceId] })]));
  const own = await runJobs({ db, llm: llmW1, config: CONFIG, viewer: w1, persona: PERSONA });
  assert.equal(own.processed, 1);
  assert.equal(own.results[0].streamKey, `${USER_ID}:${PERSONA_ID}:w1`);
  [job] = db.jobs({ type: EXTRACT_JOB_TYPE });
  assert.equal(job.state, 'done');
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: 'w1' }).length, 1);
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: 'w2' }).length, 0);
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: '' }).length, 0);
});

test('P1-3 旧 key 队列仍可认领，但世界不符时退回 pending', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const captured = captureAll(db, SESSION_ID, [
    userEvent(1, '我住在杭州。'),
    userEvent(2, '工作在滨江。'),
  ]);
  const ids = captured.map(row => row.sourceId);
  const legacyKey = `${USER_ID}:${PERSONA_ID}`;

  // Pre-upgrade queue row: legacy stream key, payload without a world.
  db.enqueueJob({
    type: EXTRACT_JOB_TYPE,
    streamKey: legacyKey,
    cursor: 2,
    payload: {
      version: 1, userId: USER_ID, personaId: PERSONA_ID, worldId: '',
      sourceIds: ids, messageCount: 2,
      afterOccurredAt: sessionRows(db, SESSION_ID).at(-1).occurredAt,
      afterSourceId: ids.at(-1),
    },
  });
  const llm = stubLlm(JSON.stringify([candidate({ evidence_source_ids: [ids[0]] })]));
  const drained = await runJobs({ db, llm, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(drained.processed, 1, '旧 key 作业必须能被同 user/persona 认领');
  const legacyJob = db.jobs({ type: EXTRACT_JOB_TYPE }).find(row => row.streamKey === legacyKey);
  assert.equal(legacyJob.state, 'done');

  // Another legacy row that belongs to a different world must not be claimed.
  const foreign = db.enqueueJob({
    type: EXTRACT_JOB_TYPE,
    streamKey: legacyKey,
    cursor: 0,
    payload: {
      version: 1, userId: USER_ID, personaId: PERSONA_ID, worldId: 'w9',
      sourceIds: [], messageCount: 0,
    },
  });
  const blocked = await runJobs({ db, llm: stubLlm('[]'), config: CONFIG, viewer: VIEWER, persona: PERSONA });
  assert.equal(blocked.processed, 0);
  assert.equal(blocked.failed, 0);
  assert.equal(blocked.reason, 'world-mismatch');
  const foreignRow = db.jobs({ type: EXTRACT_JOB_TYPE }).find(row => row.jobId === foreign.jobId);
  assert.equal(foreignRow.state, 'pending', '别的世界的作业不得被完成');
  assert.equal(foreignRow.attempts, 0);
});

test('P1-4 原文读取失败不得吞成空批次：作业失败、游标不动、原文还在', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  captureAll(db, SESSION_ID, [userEvent(1, '我在杭州工作。'), userEvent(2, '每天通勤一小时。')]);
  assert.ok(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 10 }));

  const llm = stubLlm('[]');
  const original = db.getEvent;
  db.getEvent = () => {
    throw new Error('disk io error');
  };
  let failed;
  try {
    failed = await runJobs({ db, llm, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  } finally {
    db.getEvent = original;
  }

  assert.equal(failed.failed, 1);
  assert.equal(failed.processed, 0);
  assert.equal(failed.results[0].outcome, 'failed');
  assert.ok(
    failed.results[0].errors.some(error => String(error).includes('原文读取失败')),
    'errors[] 必须带上读取失败的原因',
  );
  const [job] = db.jobs({ type: EXTRACT_JOB_TYPE });
  assert.equal(job.state, 'pending', '读取失败不得把作业标 done');
  assert.equal(job.attempts, 1);
  assert.equal(job.cursor, 2, '失败不得推进游标');
  assert.match(job.lastError, /disk io error/);
  assert.equal(llm.calls.length, 0, '读不到原文就不该调用模型');
  assert.equal(sessionRows(db, SESSION_ID).length, 2, '原文必须仍在');
  assert.equal(readCaptureCursor({ db, viewer: VIEWER }).batched, 2, '捕获游标不得回退');
});

test('P1-4 候选读取/落库失败整批失败：findDuplicates 与 insertMemory 抛错都不 completeJob', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const captured = captureAll(db, SESSION_ID, [userEvent(1, '我平常喜欢喝乌龙茶。'), userEvent(2, '周末常去爬山。')]);
  const evidenceId = captured[0].sourceId;
  assert.ok(noteCaptureBatch({ db, viewer: VIEWER, minMessages: 2, maxMessages: 10 }));
  const llm = stubLlm(JSON.stringify([candidate({ evidence_source_ids: [evidenceId] })]));

  // 1) A failed duplicate lookup must abort the batch, not look like "no rows".
  const originalFind = db.findDuplicates;
  db.findDuplicates = () => {
    throw new Error('index corrupted');
  };
  let first;
  try {
    first = await runJobs({ db, llm, config: CONFIG, viewer: VIEWER, persona: PERSONA });
  } finally {
    db.findDuplicates = originalFind;
  }
  assert.equal(first.failed, 1);
  assert.equal(first.results[0].errors.some(error => String(error).includes('候选入库失败')), true);
  let [job] = db.jobs({ type: EXTRACT_JOB_TYPE });
  assert.notEqual(job.state, 'done');
  assert.equal(job.cursor, 2);
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 0);

  // 2) A failed insert must do the same (after the retry window opens).
  const originalInsert = db.insertMemory;
  db.insertMemory = () => {
    throw new Error('database is locked');
  };
  let second;
  try {
    second = await runJobs({
      db, llm, config: CONFIG, viewer: VIEWER, persona: PERSONA, now: Date.now() + 60_000,
    });
  } finally {
    db.insertMemory = originalInsert;
  }
  assert.equal(second.failed, 1);
  [job] = db.jobs({ type: EXTRACT_JOB_TYPE });
  assert.notEqual(job.state, 'done');
  assert.equal(job.cursor, 2);
  assert.match(job.lastError, /database is locked/);
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 0);

  // 3) With the store healthy the same job finally succeeds (nothing lost).
  const third = await runJobs({
    db, llm, config: CONFIG, viewer: VIEWER, persona: PERSONA, now: Date.now() + 180_000,
  });
  assert.equal(third.processed, 1);
  [job] = db.jobs({ type: EXTRACT_JOB_TYPE });
  assert.equal(job.state, 'done');
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 1);
});
