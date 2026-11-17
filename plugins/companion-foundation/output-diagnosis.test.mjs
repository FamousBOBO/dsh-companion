import { test } from 'node:test';
import assert from 'node:assert/strict';

// P5 输出诊断的离线故障注入。全部是合成事件：没有 DB、没有 provider、没有网络。
// 覆盖计划 §5-D 要求的最小集，并且每一条都同时断言两件事：
//   1. 长度/状态码确实被识别；
//   2. reasoning 绝不会被算进正文（`visibleChars` 不因 reasoning 增长）。

const { diagnoseOutput, needsRecovery, scanStream, OUTPUT_CODES } = await import('./output-diagnosis.mjs');

/** 一个完整的 turn：turn/start … assistant/message … turn/end。 */
function turn(events, reason = { kind: 'completed' }) {
  return [...events, { type: 'turn/end', data: { reason } }];
}

/** assistant/message 事件：content 只放长度，stream 用宿主打包形状。 */
function message({ text = '', reasoning = '', finish = { kind: 'stop' }, streamText = null, interrupted = false } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (reasoning) content.push({ type: 'reasoning', text: reasoning });
  const stream = [];
  const streamed = streamText === null ? text : streamText;
  if (streamed) stream.push({ type: 'text-chunks', time0: 0, index: 0, dt: [0], texts: [streamed] });
  if (reasoning) stream.push({ type: 'reasoning-chunks', time0: 0, index: 1, dt: [0], texts: [reasoning] });
  if (finish) stream.push({ type: 'chunk', time: 0, chunk: { type: 'finish', reason: finish } });
  return {
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', content },
      stream,
      ...(interrupted ? { interrupted: true } : {}),
    },
  };
}

const LIMITS = { maxOutputTokens: 4096 };
const body = diagnosis => diagnosis.visibleChars;

test('1. 空正文：没有任何文本块，emptyBody=true 且不存在 reasoning 冒充正文', () => {
  const diagnosis = diagnoseOutput({
    events: turn([message({ text: '', reasoning: '' })]),
    limits: LIMITS,
  });
  assert.equal(diagnosis.emptyBody, true);
  assert.equal(diagnosis.visibleChars, 0);
  assert.equal(diagnosis.reasoningPresent, false);
  assert.ok(diagnosis.codes.includes('output-empty'));
  assert.ok(diagnosis.layers.template.includes('output-empty'));
  assert.equal(diagnosis.streamCompleted, true);
  assert.equal(diagnosis.stopReason, 'completed');
  // 没有副作用 ⇒ 允许恢复
  assert.equal(needsRecovery(diagnosis), true);
});

test('2. 流中断：没有 finish chunk ⇒ streamCompleted=false，并给 stream 层码', () => {
  const diagnosis = diagnoseOutput({
    events: [
      message({ text: '半句', finish: null }),
      { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ],
    limits: LIMITS,
  });
  assert.equal(diagnosis.streamCompleted, false);
  assert.equal(diagnosis.finishReason, null);
  assert.equal(diagnosis.stopReason, 'aborted');
  assert.ok(diagnosis.codes.includes('stream-not-completed'));
  assert.ok(diagnosis.codes.includes('turn-aborted'));
  assert.ok(diagnosis.layers.stream.includes('stream-not-completed'));
  assert.ok(diagnosis.layers.stream.includes('turn-aborted'));
  assert.equal(diagnosis.visibleChars, 2, '中断时已交付的正文仍然计入长度');
  // 有正文 ⇒ 不需要恢复
  assert.equal(needsRecovery(diagnosis), false);
});

test('3. reasoning 很长但正文为空：长度分开统计，正文仍然 emptyBody，reasoning 不得被复制', () => {
  const reasoning = '思考'.repeat(2000); // 4000 字符的思考
  const diagnosis = diagnoseOutput({
    events: turn([message({ text: '', reasoning, finish: { kind: 'stop' } })]),
    limits: LIMITS,
  });
  assert.equal(diagnosis.visibleChars, 0);
  assert.equal(diagnosis.reasoningChars, reasoning.trim().length);
  assert.equal(diagnosis.reasoningPresent, true);
  assert.equal(diagnosis.emptyBody, true);
  assert.ok(diagnosis.codes.includes('reasoning-present-without-body'));
  // 关键断言：诊断对象里没有任何字段携带 reasoning 文本，也没有把长度挪进正文。
  const serialized = JSON.stringify(diagnosis);
  assert.equal(serialized.includes('思考'), false, '诊断结果不得包含 reasoning 原文');
  assert.equal(serialized.includes(reasoning.slice(0, 8)), false);
  const bodyOnly = body(diagnosis);
  assert.equal(bodyOnly, 0, 'reasoning 长度绝不能算成正文长度');
});

test('4. 只有 reasoning 无正文 ⇒ emptyBody:true，且 codes 同时给出 template 层两层码', () => {
  const diagnosis = diagnoseOutput({
    events: [
      message({ text: '', reasoning: 'internal monologue that is long enough to matter', finish: { kind: 'stop' } }),
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
    limits: LIMITS,
  });
  assert.equal(diagnosis.emptyBody, true);
  assert.equal(diagnosis.visibleChars, 0);
  assert.equal(diagnosis.reasoningChars > 0, true);
  assert.deepEqual(
    [...diagnosis.layers.template].sort(),
    ['output-empty', 'reasoning-present-without-body'],
  );
  assert.equal(needsRecovery(diagnosis), true);
});

test('5. 预算截断：finish=max-tokens ⇒ budget.exhausted=true 并给 budget 层码', () => {
  const diagnosis = diagnoseOutput({
    events: [
      message({ text: '写到一半', finish: { kind: 'max-tokens' } }),
      { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } },
    ],
    limits: { maxOutputTokens: 512 },
  });
  assert.equal(diagnosis.finishReason, 'max-tokens');
  assert.equal(diagnosis.budget.exhausted, true);
  assert.equal(diagnosis.budget.maxOutputTokens, 512);
  assert.equal(diagnosis.budget.source, 'limits');
  assert.ok(diagnosis.codes.includes('budget-truncated'));
  assert.ok(diagnosis.layers.budget.includes('budget-truncated'));
  // max-tokens 不是 error/aborted ⇒ 流本身算完成
  assert.equal(diagnosis.streamCompleted, true);
  assert.equal(needsRecovery(diagnosis), false, '有正文时不需要恢复');
});

test('6. 正常完整输出：无问题码，streamCompleted=true，不需要恢复', () => {
  const diagnosis = diagnoseOutput({
    events: turn([message({ text: '好的，今天下雨，记得带伞。', finish: { kind: 'stop' } })]),
    limits: LIMITS,
  });
  assert.equal(diagnosis.emptyBody, false);
  assert.equal(diagnosis.visibleChars, diagnosis.visibleChars);
  assert.ok(diagnosis.visibleChars > 0);
  assert.equal(diagnosis.reasoningChars, 0);
  assert.equal(diagnosis.streamCompleted, true);
  assert.equal(diagnosis.stopReason, 'completed');
  assert.deepEqual(
    diagnosis.codes.filter(code => code !== 'limits-unavailable'),
    [],
    `完整输出不该带任何问题码，实际：${diagnosis.codes.join(',')}`,
  );
  assert.equal(needsRecovery(diagnosis), false);
});

test('7. 有副作用工具失败后的空正文：recovery 必须 false', () => {
  const diagnosis = diagnoseOutput({
    events: [
      { type: 'tool/call', data: { callId: 'c1', name: 'qq_send_text', sideEffect: true } },
      { type: 'tool/result', data: { callId: 'c1', message: { isError: true }, error: { name: 'Error', code: 'SEND_FAILED' } } },
      ...turn([message({ text: '', reasoning: '', finish: { kind: 'stop' } })]),
    ],
    limits: LIMITS,
  });
  assert.equal(diagnosis.emptyBody, true);
  assert.equal(diagnosis.sideEffects.attempted, 1);
  assert.equal(diagnosis.sideEffects.failed, 1);
  assert.equal(diagnosis.sideEffects.succeeded, 0);
  assert.ok(diagnosis.codes.includes('side-effect-attempted'));
  assert.ok(diagnosis.codes.includes('recovery-blocked-by-side-effect'));
  assert.equal(needsRecovery(diagnosis), false, '有副作用工具失败后严禁自动重跑');
});

test('8. 无副作用空正文：recovery 必须 true（这是唯一允许恢复的一类）', () => {
  const diagnosis = diagnoseOutput({
    events: [
      // 只读工具调用不构成副作用。
      { type: 'tool/call', data: { callId: 'r1', name: 'companion_life_status', sideEffect: false, kind: 'read' } },
      { type: 'tool/result', data: { callId: 'r1', message: { isError: false } } },
      ...turn([message({ text: '   ', reasoning: 'plan', finish: { kind: 'stop' } })]),
    ],
    limits: LIMITS,
  });
  assert.equal(diagnosis.emptyBody, true);
  assert.equal(diagnosis.sideEffects.attempted, 0);
  assert.equal(diagnosis.toolCalls.total, 1);
  assert.equal(diagnosis.toolCalls.readOnly, 1);
  assert.equal(needsRecovery(diagnosis), true);

  // 副作用档位未知时（没有 kind/sideEffect 声明）必须 fail-closed。
  const unknown = diagnoseOutput({
    events: [
      { type: 'tool/call', data: { callId: 'u1', name: 'mystery_tool' } },
      ...turn([message({ text: '', finish: { kind: 'stop' } })]),
    ],
    limits: LIMITS,
  });
  assert.equal(unknown.sideEffects.unknownKind, 1);
  assert.equal(needsRecovery(unknown), false, '副作用未知按有副作用处理');

  // 有调用但没有结果（结果未知）同样不许恢复。
  const noResult = diagnoseOutput({
    events: [
      { type: 'tool/call', data: { callId: 'n1', name: 'companion_share_activity', sideEffect: true } },
      ...turn([message({ text: '', finish: { kind: 'stop' } })]),
    ],
    limits: LIMITS,
  });
  assert.equal(noResult.sideEffects.unknownOutcome, 1);
  assert.ok(noResult.codes.includes('side-effect-outcome-unknown'));
  assert.equal(needsRecovery(noResult), false);
});

test('9. 流里有文本但消息为空 ⇒ host 层码（宿主消息合成），不是"模型没写"', () => {
  const diagnosis = diagnoseOutput({
    events: turn([message({ text: '', streamText: '明明是有的正文', finish: { kind: 'stop' } })]),
    limits: LIMITS,
  });
  assert.equal(diagnosis.visibleChars, 0);
  assert.equal(diagnosis.emptyBody, true);
  assert.ok(diagnosis.codes.includes('host-message-empty-though-stream-saw-text'));
  assert.ok(diagnosis.layers.host.includes('host-message-empty-though-stream-saw-text'));
  // 这一条同时落 template 层的 output-empty：两层都报告，不预设根因。
  assert.ok(diagnosis.codes.includes('output-empty'));
});

test('10. 没有 assistant/message（只有 attempt）或没有 turn/end ⇒ 具名码，不猜根因', () => {
  const attemptOnly = diagnoseOutput({
    events: [
      { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'error' } } }] } },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'provider down', code: 'E_PROVIDER' } } } },
    ],
    limits: LIMITS,
  });
  assert.equal(attemptOnly.messageCount, 0);
  assert.equal(attemptOnly.attemptCount, 1);
  assert.ok(attemptOnly.codes.includes('provider-attempt-without-message'));
  assert.ok(attemptOnly.codes.includes('no-assistant-message'));
  assert.ok(attemptOnly.codes.includes('turn-error'));
  assert.ok(attemptOnly.layers.provider.includes('turn-error'));
  // 没有消息、没有副作用 ⇒ 允许恢复
  assert.equal(needsRecovery(attemptOnly), true);
  assert.equal(attemptOnly.unavailable.some(entry => entry.includes('assistant/attempt')), true);

  const openTurn = diagnoseOutput({ events: [message({ text: 'ok' })], limits: LIMITS });
  assert.equal(openTurn.stopReason, null);
  assert.ok(openTurn.codes.includes('turn-not-closed'));
  assert.ok(openTurn.layers.stream.includes('turn-not-closed'));
  assert.equal(openTurn.streamCompleted, true);
});

test('11. 预算没有可靠计数器时写 unavailable，不写 0 冒充"没有预算"', () => {
  const diagnosis = diagnoseOutput({ events: turn([message({ text: '有正文' })]) });
  assert.equal(diagnosis.budget.maxOutputTokens, null);
  assert.equal(diagnosis.budget.source, 'unavailable');
  assert.equal(diagnosis.budget.exhausted, false);
  assert.ok(diagnosis.codes.includes('limits-unavailable'));
  assert.ok(diagnosis.unavailable.some(entry => entry.startsWith('maxOutputTokens')));
  assert.ok(diagnosis.unavailable.some(entry => entry.includes('provider usage')));
});

test('12. codes 词表与文档一致；scanStream 只累加长度', () => {
  const stream = [
    { type: 'text-chunks', time0: 0, index: 0, dt: [0, 1], texts: ['你', '好'] },
    { type: 'reasoning-chunks', time0: 0, index: 1, dt: [0], texts: ['想'] },
    { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ];
  const scan = scanStream(stream);
  assert.deepEqual(
    { textChars: scan.textChars, reasoningChars: scan.reasoningChars, hasFinish: scan.hasFinish, finishKind: scan.finishKind },
    { textChars: 2, reasoningChars: 1, hasFinish: true, finishKind: 'stop' },
  );
  for (const diagnosis of [
    diagnoseOutput({ events: [], limits: LIMITS }),
    diagnoseOutput({ events: turn([message({ text: 'ok' })]), limits: LIMITS }),
  ]) {
    for (const code of diagnosis.codes) assert.equal(typeof OUTPUT_CODES[code], 'string', `未登记的码：${code}`);
  }
  // 空事件列表也要给出可读结果，而不是抛。
  const empty = diagnoseOutput({});
  assert.equal(empty.emptyBody, true);
  assert.equal(empty.messageCount, 0);
});
