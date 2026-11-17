// P5 正文可靠性：离线"输出诊断"。
//
// 目的是把「这一轮为什么没有正文」变成一个**可复现的状态判定**，而不是一句猜测。
// 这个模块只做一件事：读一组**合成**的 session 事件，输出长度与状态码。
//
// 硬口径（照计划 §5-D 与 §8 的证据要求）：
//   * 只统计**长度**与**状态码**；reasoning 正文、正文正文、工具参数一律不保留、不返回。
//     所以这里没有 `text` 字段，只有 `visibleChars` / `reasoningChars`。
//   * **不预设根因**：所有结论都是具名码（`codes`），并且每个码归到一层候选
//     （template / budget / provider / stream / host），由读报告的人自己判断。
//   * `needsRecovery()` 是**安全边界**而不是重试按钮：可见正文为空、且**没有任何**
//     有副作用（或副作用未知）的工具被调用过，才返回 true。副作用未知按"有副作用"处理
//     （fail-closed），因为重跑一次写操作比少一次重答贵得多。
//   * reasoning 永远不会被复制、截取或拼接进正文。`reasoning-present-without-body`
//     这个码只说明"有思考、没正文"，它不等于"可以拿思考当正文"。
//
// 事件形状（合成用例可直接照抄，字段都取自宿主 session 事件）：
//   { type: 'assistant/message', data: { message: { content: [...] }, stream: [...], usage?: {...}, interrupted?: true } }
//   { type: 'assistant/attempt',  data: { stream: [...] } }        // 有尝试、没落成消息
//   { type: 'tool/call',          data: { callId, name, sideEffect?: boolean, kind?: 'read'|'write' } }
//   { type: 'tool/result',        data: { callId, message: { isError }, error?: {code} } }
//   { type: 'turn/end',           data: { reason: { kind } } }
// `limits` 只接受宿主真的能给的计数器：`{ maxOutputTokens }`。拿不到就写 unavailable。

/** 每个码一句话。只有码与长度，没有正文。 */
export const OUTPUT_CODES = Object.freeze({
  'no-assistant-message': '这一轮没有 assistant/message：模型步骤没有产出可投影的消息',
  'provider-attempt-without-message': '有 assistant/attempt 但没有落成 assistant/message（provider/流式层没交付）',
  'output-empty': '可见正文为空（trim 后 0 字符）',
  'reasoning-present-without-body': '有 reasoning 长度、可见正文为空；reasoning 不得充当正文',
  'host-message-empty-though-stream-saw-text': '流里有文本增量，但合成后的消息没有文本块（宿主消息合成）',
  'stream-not-completed': '流式没有 finish chunk（被中断或截断）',
  'stream-error': 'finish 是 error',
  'stream-aborted': 'finish 是 aborted',
  'budget-truncated': '输出预算截断（finish 或 turn/end 是 max-tokens）',
  'turn-not-closed': '没有 turn/end（这一轮没有闭合）',
  'turn-error': 'turn/end = error',
  'turn-aborted': 'turn/end = aborted',
  'turn-interrupted': 'turn/end = interrupted（崩溃后补的闭合，不代表行为已完成）',
  'turn-blocked': 'turn/end = blocked',
  'limits-unavailable': '没有可靠的输出预算计数器（maxOutputTokens 未提供）',
  'side-effect-attempted': '有副作用（或副作用未知）的工具已被调用过',
  'side-effect-outcome-unknown': '有副作用工具的调用没有对应结果（结果未知，绝不能重跑）',
  'recovery-blocked-by-side-effect': '正文为空，但有副作用工具执行过：禁止自动重跑',
});

export const OUTPUT_CODE_LAYERS = Object.freeze({
  template: Object.freeze(['output-empty', 'reasoning-present-without-body']),
  budget: Object.freeze(['budget-truncated']),
  provider: Object.freeze([
    'no-assistant-message', 'provider-attempt-without-message', 'stream-error', 'stream-aborted',
    'turn-error', 'turn-blocked', 'limits-unavailable',
  ]),
  stream: Object.freeze(['stream-not-completed', 'turn-not-closed', 'turn-interrupted', 'turn-aborted']),
  host: Object.freeze(['host-message-empty-though-stream-saw-text']),
});

/** 码 → 一句话；未知码原样返回，不抛。 */
export function describeOutputCode(code) {
  return OUTPUT_CODES[code] ?? String(code ?? '');
}

const textChars = value => (typeof value === 'string' ? value.trim().length : 0);

/** 一类 content block 的字符数（trim 后累加）。只看长度，不读内容。 */
function blockChars(blocks, type) {
  if (!Array.isArray(blocks)) return 0;
  return blocks.reduce((sum, block) => {
    if (!block || block.type !== type) return sum;
    return sum + textChars(block.text);
  }, 0);
}

/**
 * 读一份 compact stream：文本增量、reasoning 增量与最后一个 finish。
 *
 * 宿主把增量打包成 `text-chunks` / `reasoning-chunks`（`texts` 数组），其余保留为
 * 原始 `chunk` 记录；两种形状都只用来累加长度。
 */
export function scanStream(stream) {
  const result = { textChars: 0, reasoningChars: 0, sawTextDelta: false, hasFinish: false, finishKind: null };
  for (const record of Array.isArray(stream) ? stream : []) {
    if (record?.type === 'text-chunks' && Array.isArray(record.texts)) {
      for (const fragment of record.texts) {
        const length = textChars(fragment);
        result.textChars += length;
        if (length > 0) result.sawTextDelta = true;
      }
      continue;
    }
    if (record?.type === 'reasoning-chunks' && Array.isArray(record.texts)) {
      for (const fragment of record.texts) result.reasoningChars += textChars(fragment);
      continue;
    }
    if (record?.type !== 'chunk') continue;
    const chunk = record.chunk ?? {};
    if (chunk.type === 'text-delta') {
      const length = textChars(chunk.text ?? chunk.delta ?? chunk.content);
      result.textChars += length;
      if (length > 0) result.sawTextDelta = true;
    } else if (chunk.type === 'reasoning-delta') {
      result.reasoningChars += textChars(chunk.text ?? chunk.delta ?? chunk.content);
    } else if (chunk.type === 'finish') {
      result.hasFinish = true;
      result.finishKind = String(chunk.reason?.kind ?? 'unknown');
    }
  }
  return result;
}

/** 一次工具调用的副作用档位。`undefined` = 不知道 ⇒ 按有副作用处理（fail-closed）。 */
function sideEffectOf(data) {
  if (data?.sideEffect === true) return 'write';
  if (data?.sideEffect === false) return 'read';
  const kind = String(data?.kind ?? '');
  if (kind === 'write') return 'write';
  if (kind === 'read') return 'read';
  return 'unknown';
}

/** 结果是否算失败：结构化 error 与 `isError` 都算；没有结果算"未知"。 */
function resultState(result) {
  if (!result) return 'unknown';
  const data = result.data ?? result;
  if (data?.error != null) return 'failed';
  if (data?.message?.isError === true) return 'failed';
  if (data?.isError === true) return 'failed';
  return 'succeeded';
}

/**
 * 诊断一层输出。只返回长度、状态码与预算事实。
 *
 * @param {{events?: ReadonlyArray<object>, limits?: {maxOutputTokens?: number}}} input
 * @returns {{
 *   visibleChars: number, reasoningChars: number, reasoningPresent: boolean,
 *   finishReason: string|null, stopReason: string|null, streamCompleted: boolean,
 *   emptyBody: boolean, budget: object, codes: string[], layers: object,
 *   sideEffects: object, toolCalls: object, messageCount: number, attemptCount: number,
 *   interrupted: boolean, unavailable: string[]
 * }}
 */
export function diagnoseOutput({ events = [], limits = {} } = {}) {
  const list = Array.isArray(events) ? events : [];
  let lastMessage = null;
  let attemptCount = 0;
  let sawTurnEnd = false;
  let turnEndKind = null;
  const calls = [];
  const results = [];

  for (const event of list) {
    const type = String(event?.type ?? '');
    const data = event?.data ?? event ?? {};
    if (type === 'assistant/message') lastMessage = data;
    else if (type === 'assistant/attempt') attemptCount += 1;
    else if (type === 'turn/end') {
      sawTurnEnd = true;
      turnEndKind = String(data?.reason?.kind ?? data?.kind ?? 'unknown');
    } else if (type === 'tool/call') calls.push(data);
    else if (type === 'tool/result') results.push(data);
  }

  // 配对：先按 callId，再按出现顺序兜底（宿主总是先记 call 再记 result）。
  const resultByCallId = new Map();
  for (const result of results) {
    const id = String(result?.callId ?? result?.message?.toolCallId ?? '');
    if (id) resultByCallId.set(id, result);
  }
  const usedResults = new Set();
  const paired = calls.map((call, index) => {
    const id = String(call?.callId ?? '');
    let result = id ? resultByCallId.get(id) : undefined;
    if (!result && results[index] && !usedResults.has(results[index])) result = results[index];
    if (result) usedResults.add(result);
    return { call, result, state: resultState(result) };
  });

  const messageContent = Array.isArray(lastMessage?.message?.content) ? lastMessage.message.content : [];
  const visibleChars = blockChars(messageContent, 'text');
  const reasoningChars = blockChars(messageContent, 'reasoning');
  const messageStream = scanStream(lastMessage?.stream);
  // 本模块不保留 attempt 的流：它只说明"有过一次没落成消息的尝试"，理由不猜。
  const attemptStreams = [];

  const finishReason = messageStream.hasFinish ? messageStream.finishKind : null;
  const streamCompleted = Boolean(messageStream.hasFinish)
    && finishReason !== 'error'
    && finishReason !== 'aborted';

  const limitsValue = Number(limits?.maxOutputTokens);
  const hasLimit = Number.isFinite(limitsValue) && limitsValue > 0;
  const budgetExhausted = finishReason === 'max-tokens' || turnEndKind === 'max-tokens';

  const sideEffects = { attempted: 0, succeeded: 0, failed: 0, unknownOutcome: 0, unknownKind: 0, names: [] };
  for (const item of paired) {
    const kind = sideEffectOf(item.call);
    if (kind === 'read') continue;
    sideEffects.attempted += 1;
    if (kind === 'unknown') sideEffects.unknownKind += 1;
    const name = String(item.call?.name ?? '').slice(0, 64);
    if (name && !sideEffects.names.includes(name)) sideEffects.names.push(name);
    if (item.state === 'succeeded') sideEffects.succeeded += 1;
    else if (item.state === 'failed') sideEffects.failed += 1;
    else sideEffects.unknownOutcome += 1;
  }

  const codes = [];
  const push = code => { if (!codes.includes(code)) codes.push(code); };
  if (attemptCount > 0 && lastMessage === null) push('provider-attempt-without-message');
  if (lastMessage === null) push('no-assistant-message');
  if (visibleChars === 0) push('output-empty');
  if (visibleChars === 0 && reasoningChars > 0) push('reasoning-present-without-body');
  // 流里有文本、消息里没有文本块：说明交付层把文本丢了，而不是模型没写。
  if (lastMessage !== null && messageStream.sawTextDelta && visibleChars === 0) push('host-message-empty-though-stream-saw-text');
  if (lastMessage !== null && !messageStream.hasFinish) push('stream-not-completed');
  if (finishReason === 'error') push('stream-error');
  if (finishReason === 'aborted') push('stream-aborted');
  if (budgetExhausted) push('budget-truncated');
  if (!sawTurnEnd) push('turn-not-closed');
  if (turnEndKind === 'error') push('turn-error');
  if (turnEndKind === 'aborted') push('turn-aborted');
  if (turnEndKind === 'interrupted') push('turn-interrupted');
  if (turnEndKind === 'blocked') push('turn-blocked');
  if (!hasLimit) push('limits-unavailable');
  if (sideEffects.attempted > 0) push('side-effect-attempted');
  if (sideEffects.unknownOutcome > 0) push('side-effect-outcome-unknown');
  if (visibleChars === 0 && sideEffects.attempted > 0) push('recovery-blocked-by-side-effect');

  const layers = { template: [], budget: [], provider: [], stream: [], host: [] };
  for (const code of codes) {
    for (const [layer, members] of Object.entries(OUTPUT_CODE_LAYERS)) {
      if (members.includes(code)) layers[layer].push(code);
    }
  }

  const unavailable = [];
  if (!hasLimit) unavailable.push('maxOutputTokens（宿主未提供输出预算计数器）');
  unavailable.push('provider usage / TTFT（本模块只读事件，不读 provider 计数）');
  if (attemptCount > 0 && lastMessage === null && attemptStreams.length === 0) {
    unavailable.push('assistant/attempt 的 finish（未保存 attempt 流，不猜它为什么没落成消息）');
  }

  return {
    visibleChars,
    reasoningChars,
    reasoningPresent: reasoningChars > 0,
    finishReason,
    stopReason: sawTurnEnd ? turnEndKind : null,
    streamCompleted,
    emptyBody: visibleChars === 0,
    budget: {
      maxOutputTokens: hasLimit ? limitsValue : null,
      source: hasLimit ? 'limits' : 'unavailable',
      exhausted: budgetExhausted,
      visibleChars,
      reasoningChars,
    },
    codes,
    layers,
    sideEffects,
    toolCalls: {
      total: paired.length,
      readOnly: paired.length - sideEffects.attempted,
      withResult: paired.filter(item => item.state !== 'unknown').length,
      failed: paired.filter(item => item.state === 'failed').length,
    },
    messageCount: lastMessage === null ? 0 : 1,
    attemptCount,
    interrupted: lastMessage?.interrupted === true,
    unavailable,
  };
}

/**
 * 是否需要（且**被允许**）恢复一次正文。
 *
 * 只有一种情况返回 true：可见正文为空，并且没有任何副作用档位的工具被调用过。
 * 有副作用、副作用未知、或"调用了但结果未知"一律返回 false —— 宁可少一次重答，
 * 也不能把已经发生的写操作/外发再跑一遍。
 *
 * @param {ReturnType<typeof diagnoseOutput>} diagnosis
 * @returns {boolean}
 */
export function needsRecovery(diagnosis) {
  if (!diagnosis || typeof diagnosis !== 'object') return false;
  if (diagnosis.emptyBody !== true) return false;
  const attempted = Number(diagnosis.sideEffects?.attempted);
  if (Number.isFinite(attempted) && attempted > 0) return false;
  // 缺字段时同样保守：拿不到"没有副作用"的证据就不恢复。
  if (!Number.isFinite(attempted)) return false;
  return true;
}

export default { diagnoseOutput, needsRecovery, scanStream, describeOutputCode, OUTPUT_CODES, OUTPUT_CODE_LAYERS };
