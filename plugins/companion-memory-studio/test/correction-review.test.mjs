import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudioHandlers } from '../server.mjs';

// task-40：纠正裁决的 UI 入口（只读列表 + 一个受控写入口）。
//
// 这里不起真记忆库，而是给 studio 的 handler 层一个**假引擎**（`internal()` 里的 `db` 只回
// `getMemory`）与一个**假 runtime**——于是每条断言都在问"UI 到底把什么递给了 runtime"，
// 而不是"runtime 对不对"（那是 runtime 侧测试的事）。
//
// 六条对应任务书：列表内容/截断、压 1 条、全不选、失败理由原样、空态、零写语句。

const VIEWER = { userId: '10001', personaId: 'bot', worldId: '', sessionId: 's1' };

/** 假记忆库：只实现被用到的 `getMemory`，并且**故意没有写方法**（写了就说明 UI 想直连库）。 */
function fakeEngine(records = {}) {
  const reads = [];
  return {
    reads,
    engine: {
      internal: async () => ({
        viewer: () => VIEWER,
        db: {
          getMemory(id) {
            reads.push(id);
            return records[id] ?? null;
          },
        },
      }),
    },
  };
}

/** 假 runtime：记录每次调用的入参，返回可编排的结果。 */
function fakeRuntime(options = {}) {
  const calls = [];
  const reviewResult = options.review ?? {
    ok: true, count: 0, resolved: 0, pendingRetries: 0, recent: [],
  };
  const resolveResult = options.resolve ?? { ok: true, recordId: 'rec_1', resolution: { supersedeIds: [] } };
  const listResolvedResult = options.listResolved ?? { ok: true, resolved: [] };
  return {
    calls,
    api: {
      correctionReview(input) { calls.push({ fn: 'correctionReview', input }); return reviewResult; },
      async resolveAmbiguousCorrection(input) {
        calls.push({ fn: 'resolveAmbiguousCorrection', input });
        return typeof resolveResult === 'function' ? resolveResult(input) : resolveResult;
      },
      correctionResolution() { return { ok: true, resolved: null }; },
      // runtime task-39 的只读明细；`options.listResolved === 'absent'` 时**不提供**这个方法，
      // 用来验证"运行库没有这个接口"时页面说的是"看不到"而不是"没有记录"。
      ...(options.listResolved === 'absent'
        ? {}
        : { listResolved(input) { calls.push({ fn: 'listResolved', input }); return listResolvedResult; } }),
    },
  };
}

function handlers(runtime, engine) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-corr-'));
  return { root, table: createStudioHandlers({ engine: engine.engine, root, runtime: () => runtime.api }) };
}

const getCorrections = async (table, query = '') =>
  await (await table['GET /api/companion-memory/corrections'](new Request(`http://localhost/api/companion-memory/corrections${query}`))).json();

const postCorrection = async (table, body) =>
  await (await table['POST /api/companion-memory/corrections'](new Request('http://localhost/api/companion-memory/corrections', {
    method: 'POST',
    body: JSON.stringify(body),
  }))).json();

const longText = '我喜欢在雨天读诗，尤其是傍晚。'.repeat(20);

// ── 1. 只读列表：计数 + 候选正文 + truncated ────────────────────────────────

test('C1 待审 2 条：count=2、两条候选正文都出来、超长的那条标 truncated', async () => {
  const runtime = fakeRuntime({
    review: {
      ok: true, count: 2, resolved: 3, pendingRetries: 0,
      recent: [
        { recordId: 'rec_1', at: 1762000000000, candidates: ['mem_a', 'mem_b'] },
        { recordId: 'rec_2', at: 1762000001000, candidates: ['mem_c'] },
      ],
    },
  });
  const engine = fakeEngine({
    mem_a: { id: 'mem_a', kind: 'fact', value: longText, updatedAt: 1761999000000 },
    mem_b: { id: 'mem_b', kind: 'preference', value: '喜欢安静', updatedAt: 1761999001000 },
    mem_c: { id: 'mem_c', kind: 'fact', value: '住在杭州', updatedAt: 1761999002000 },
  });
  const { root, table } = handlers(runtime, engine);
  try {
    const payload = await getCorrections(table);
    const data = payload.data;
    assert.equal(data.available, true);
    assert.equal(data.count, 2);
    assert.equal(data.resolved, 3, 'resolved 计数也要给出来');
    assert.equal(data.recent.length, 2);
    assert.deepEqual(data.recent[0].candidates.map(item => item.recordId), ['mem_a', 'mem_b']);
    assert.ok(data.recent[0].candidates[0].text.startsWith('我喜欢在雨天读诗'), '候选正文必须来自记忆库');
    assert.equal(data.recent[0].candidates[0].truncated, true, '超出展示上限必须标 truncated');
    assert.equal(data.recent[0].candidates[1].text, '喜欢安静');
    assert.equal(data.recent[0].candidates[1].truncated, false);
    assert.equal(data.recent[0].candidates[0].kind, 'fact');
    // 身份与"将要记下的那句话"：前端要能展示给主人确认。
    assert.equal(data.operator, 'u:10001');
    assert.match(String(data.evidenceHint), /^后台人工裁决 at .+ by u:10001$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 2. 压 1 条：参数只含选中项、operator 来自宿主、evidence 非空 ────────────

test('C2 只勾 1 条：supersedeIds 只含选中项，operator 来自宿主身份，evidence 非空', async () => {
  const runtime = fakeRuntime();
  const { root, table } = handlers(runtime, fakeEngine({ mem_a: { id: 'mem_a', value: '旧说法' } }));
  try {
    const payload = await postCorrection(table, {
      recordId: 'rec_1',
      supersedeIds: ['mem_b'],
      // 前端自报的名字必须被**忽略**（身份只能来自宿主）。
      operator: '我自己说我是主人',
      evidence: '前端想改写证据',
    });
    assert.equal(payload.ok, true);
    const call = runtime.calls.find(item => item.fn === 'resolveAmbiguousCorrection');
    assert.notEqual(call, undefined, '必须调 runtime 的既有 API');
    assert.deepEqual(call.input.supersedeIds, ['mem_b'], '只许带选中的那条');
    assert.equal(call.input.recordId, 'rec_1');
    assert.equal(call.input.operator, 'u:10001', 'operator 只能是宿主身份');
    assert.match(String(call.input.evidence), /^后台人工裁决 at .+ by u:10001$/, 'evidence 由服务端生成');
    // 回执里把真正记下的证据回给前端（供页面显示"已记录：…"）。
    assert.equal(payload.data.operator, 'u:10001');
    assert.match(String(payload.data.evidence), /后台人工裁决/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 3. 全不选 = [] ────────────────────────────────────────────────────────

test('C3 一个都不选：supersedeIds 以空数组提交（新说法是补充不是替换）', async () => {
  const runtime = fakeRuntime();
  const { root, table } = handlers(runtime, fakeEngine());
  try {
    const payload = await postCorrection(table, { recordId: 'rec_2', supersedeIds: [] });
    assert.equal(payload.ok, true);
    const call = runtime.calls.find(item => item.fn === 'resolveAmbiguousCorrection');
    assert.deepEqual(call.input.supersedeIds, [], '空数组必须原样传下去，不能变成"全部"');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 4. 失败理由原样 ───────────────────────────────────────────────────────

test('C4 失败理由原样显示：not-a-candidate / already-resolved / operator-required 都不翻译', async () => {
  for (const code of ['not-a-candidate', 'already-resolved', 'operator-required', 'not-queued']) {
    const runtime = fakeRuntime({ resolve: { ok: false, code, recordId: 'rec_1' } });
    const { root, table } = handlers(runtime, fakeEngine());
    try {
      const payload = await postCorrection(table, { recordId: 'rec_1', supersedeIds: ['mem_x'] });
      assert.equal(payload.ok, true, 'HTTP 层是成功的（业务失败放在 data.ok）');
      assert.equal(payload.data.ok, false);
      assert.equal(payload.data.code, code, `runtime 的 code 必须原样出现（${code}）`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  // runtime 抛错：不冒充业务码，如实 internal。
  const throwing = {
    api: {
      correctionReview: () => ({ ok: true, count: 0, resolved: 0, recent: [] }),
      resolveAmbiguousCorrection: () => { throw new Error('db locked'); },
    },
  };
  const { root, table } = handlers(throwing, fakeEngine());
  try {
    const payload = await postCorrection(table, { recordId: 'rec_1', supersedeIds: [] });
    assert.equal(payload.data.ok, false);
    assert.equal(payload.data.code, 'internal');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 5. 空态 ───────────────────────────────────────────────────────────────

test('C5 没有待裁决的纠正：available=true、count=0、recent 为空（页面据此显示"没有待裁决的纠正"）', async () => {
  const runtime = fakeRuntime();
  const { root, table } = handlers(runtime, fakeEngine());
  try {
    const data = (await getCorrections(table)).data;
    assert.equal(data.available, true);
    assert.equal(data.count, 0);
    assert.deepEqual(data.recent, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  // runtime 不在场时必须**明确说看不到**，而不是给一个空列表冒充"没有待办"。
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-corr2-'));
  try {
    const table = createStudioHandlers({ engine: fakeEngine().engine, root: root2, runtime: () => null });
    const data = (await (await table['GET /api/companion-memory/corrections'](new Request('http://localhost/api/companion-memory/corrections'))).json()).data;
    assert.equal(data.available, false);
    assert.equal(data.reason, 'correction-review-unavailable');
    assert.deepEqual(data.recent, []);
  } finally { fs.rmSync(root2, { recursive: true, force: true }); }
});

// ── 7. 已裁决明细（只读 band） ─────────────────────────────────────────────

test('C7 已裁决明细：outcome / supersededIds / operator / recordId / 时间 都出来，且不回读正文', async () => {
  const runtime = fakeRuntime({
    listResolved: {
      ok: true,
      resolved: [
        { recordId: 'rec_done_1', supersededIds: ['mem_old_1', 'mem_old_2'], operator: 'u:10001', at: 1761590000000, outcome: 'resolved-superseded' },
        { recordId: 'rec_done_2', supersededIds: [], operator: 'u:10001', at: 1761590001000, outcome: 'resolved-none' },
      ],
    },
  });
  // 记忆库里**故意**留着 mem_old_1：如果实现去回读正文，`engine.reads` 就会非空。
  const engine = fakeEngine({ mem_old_1: { id: 'mem_old_1', value: '已被作废的旧说法' } });
  const { root, table } = handlers(runtime, engine);
  try {
    const data = (await getCorrections(table)).data;
    assert.equal(data.resolvedListAvailable, true);
    assert.equal(data.resolvedRecent.length, 2);
    const [first, second] = data.resolvedRecent;
    assert.equal(first.recordId, 'rec_done_1');
    assert.equal(first.outcome, 'resolved-superseded');
    assert.deepEqual(first.supersededIds, ['mem_old_1', 'mem_old_2']);
    assert.equal(first.operator, 'u:10001');
    assert.equal(first.at, 1761590000000);
    assert.equal(second.outcome, 'resolved-none');
    assert.deepEqual(second.supersededIds, []);
    assert.deepEqual(engine.reads, [], '已裁决明细不回读正文：那些记忆本来就被作废了');
    const listCall = runtime.calls.find(item => item.fn === 'listResolved');
    assert.notEqual(listCall, undefined, '必须走 runtime 的 listResolved');
    assert.equal(listCall.input.limit, 5);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('C8 没有已裁决记录：resolvedRecent 为空（页面显「还没有已裁决的纠正」）；运行库没有该接口时明确标 unavailable', async () => {
  const runtime = fakeRuntime();
  const { root, table } = handlers(runtime, fakeEngine());
  try {
    const data = (await getCorrections(table)).data;
    assert.equal(data.resolvedListAvailable, true);
    assert.deepEqual(data.resolvedRecent, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  // 老版本 runtime（没有 listResolved）⇒ 页面必须说"看不到明细"，不能装作"没有记录"。
  const older = fakeRuntime({ listResolved: 'absent' });
  const { root: root2, table: table2 } = handlers(older, fakeEngine());
  try {
    const data = (await getCorrections(table2)).data;
    assert.equal(data.resolvedListAvailable, false);
    assert.deepEqual(data.resolvedRecent, []);
  } finally { fs.rmSync(root2, { recursive: true, force: true }); }
});

// ── 6. 渲染过程零写语句 ────────────────────────────────────────────────────

test('C6 列表与提交都不直连数据库写：假引擎只有读方法，且源码里没有写 SQL', async () => {
  // ① 运行期：假引擎只提供 `getMemory`，整趟列表 + 提交跑完，没有任何写调用（写了就 TypeError）。
  const runtime = fakeRuntime({
    review: { ok: true, count: 1, resolved: 0, recent: [{ recordId: 'rec_1', at: 1, candidates: ['mem_a'] }] },
  });
  const engine = fakeEngine({ mem_a: { id: 'mem_a', value: '旧说法' } });
  const { root, table } = handlers(runtime, engine);
  try {
    const data = (await getCorrections(table)).data;
    assert.equal(data.count, 1);
    assert.deepEqual(engine.reads, ['mem_a'], '只读一次记忆正文，且走的是 getMemory（读方法）');
    const payload = await postCorrection(table, { recordId: 'rec_1', supersedeIds: ['mem_a'] });
    assert.equal(payload.data.ok, true);
    assert.equal(engine.reads.length, 1, '提交阶段不再读库（也不写）');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  // ② 源码护栏：这两个 handler 所在文件里没有写 SQL，也没有直连 SQLite。
  for (const file of ['read.mjs', 'write.mjs']) {
    const source = fs.readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
    assert.ok(!/new\s+DatabaseSync/i.test(source), `${file} 不该自己开 SQLite`);
    const writes = source.match(/(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)/gi) ?? [];
    assert.deepEqual(writes, [], `${file} 里不该出现写 SQL：${writes.join(' | ')}`);
  }
});
