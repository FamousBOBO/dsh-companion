import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// E4 / E6 —— **端到端**：真的拉起 foundation 的 `mountCompanion()`，再真的走规划材料装配，
// 断言 **planner prompt 的正文**（不是只看 p2Materials 的中间结构）。
//
// 为什么这样写：A4 审计点出的失败模式是"测试绿、生产空"，而我上一轮只用 `mountRuntime` 断言了
// runtime 侧的中间结构 —— 那是"读代码得出的结论"。这一条把 foundation 的装配、materials 端口、
// runtime 的材料合并、prompt 渲染全部串起来跑一遍；任何一环没接上，这里就会红。
//
// `mountCompanion` 需要宿主模块根（`@deepseek-ai/dsh-tools` / `dsh-llm`），所以本文件：
//   - 优先用 `DSH_COMPANION_MODULE_ROOT`；
//   - 否则尝试本机 DSH 安装路径；
//   - 都没有就 **skip**（并说明原因），绝不伪装成通过。

function hostModuleRoot() {
  // An explicit env var wins **exclusively**: if the operator points at something unusable, this
  // suite must skip and say so rather than quietly falling back and reporting a pass.
  const explicit = process.env.DSH_COMPANION_MODULE_ROOT;
  if (explicit) {
    return fs.existsSync(path.join(explicit, '@deepseek-ai/dsh-tools/lib/index.js'))
      && fs.existsSync(path.join(explicit, '@deepseek-ai/dsh-llm/lib/index.js')) ? explicit : '';
  }
  const builtin = 'C:\\Users\\bobo\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules';
  return fs.existsSync(path.join(builtin, '@deepseek-ai/dsh-tools/lib/index.js')) ? builtin : '';
}

const T0 = Date.UTC(2026, 10, 4, 3, 0, 0);
const DAY = '2026-11-04';
const SKIP = hostModuleRoot() === '' ? 'host module root not found (set DSH_COMPANION_MODULE_ROOT)' : false;

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-foundation-'));
  for (const dir of ['home/companion', 'logs', 'workspace', 'memory']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), 'bot\n', 'utf8');
  // A complete, local-owner identity: `createIdentity` validates every field and refuses anything
  // partial (that refusal is exactly how the production config gets caught).
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1,
    owner: { id: 'owner-1', displayName: '主人' },
    persona: 'bot',
    desktop: { mode: 'local-owner', userId: 'owner-1' },
    sessions: {},
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    agenda: { enabled: true },
    p2: { planning: { enabled: true }, activities: { enabled: true } },
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

function fakeCtx() {
  const registered = [];
  const sections = [];
  return {
    registered,
    sections,
    tools: { register: (spec, ...rest) => { registered.push(String(spec?.name ?? spec ?? '').slice(0, 60)); return rest; } },
    systemPrompt: { section: entry => { sections.push(String(entry?.name ?? '')); } },
    get: () => undefined,
    set: () => {},
    provide: () => {},
    on: () => {}, once: () => {}, off: () => {}, emit: () => {},
    effect: fn => (typeof fn === 'function' ? fn() : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

/** Mount the real plugin and return { mounted, ctx, promptFor }. */
async function mounted(t) {
  const root = tempRoot(t);
  process.env.DSH_COMPANION_MODULE_ROOT = hostModuleRoot();
  const [{ mountCompanion }, { buildPlanningPrompt }] = await Promise.all([
    import('../index.mjs'),
    import('../../companion-runtime/lib/planner.mjs'),
  ]);
  const ctx = fakeCtx();
  const m = mountCompanion(ctx, root);
  assert.ok(m?.cognitive, 'the cognitive runtime mounted');
  t.after(() => { try { m.cognitive.dispose?.(); } catch { /* disposed */ } });
  const scopeKey = m.cognitive.status({ sessionId: 'e2e' }).scopeKey || 'u:owner-1|p:bot|w:world:default';

  /** The production path: foundation materials port → runtime merge → planner prompt text. */
  const promptFor = async () => {
    const material = await m.cognitive.p2Materials({ scopeKey, day: DAY, now: T0 });
    const built = buildPlanningPrompt({
      material, day: DAY, timeZone: 'Asia/Shanghai', now: T0,
      windowStart: T0, windowEnd: T0 + 24 * 3600 * 1000,
    });
    return { material, text: String(built?.input ?? '') };
  };
  return { m, ctx, root, scopeKey, promptFor };
}

test('E4 端到端：真挂载后 planner prompt 里出现目标与承诺的正文', { skip: SKIP }, async t => {
  const { m, ctx, promptFor } = await mounted(t);
  assert.equal(ctx.registered.length > 0, true, 'tools were registered by the real mount');

  assert.equal(m.cognitive.proposeGoal({ sessionId: 'e2e', title: '把阳台收拾出来' }).ok, true);
  assert.equal(m.cognitive.makeCommitment({ sessionId: 'e2e', text: '周末把照片整理完', dueAt: T0 + 3 * 86400 * 1000 }).ok, true);

  const { material, text } = await promptFor();
  assert.equal(material.continuityState, 'ok', 'the continuity provider answered');
  assert.equal(text.includes('把阳台收拾出来'), true, 'the goal title reaches the prompt');
  assert.equal(text.includes('周末把照片整理完'), true, 'the commitment text reaches the prompt');
  assert.equal(text.includes('你在意的事'), true, 'and it is under a real section');
});

test('E4 端到端：provider 返回 not-wired 时 prompt 明说看不到，且 sources 标 not-wired', { skip: SKIP }, async t => {
  const { m, promptFor } = await mounted(t);
  m.cognitive.proposeGoal({ sessionId: 'e2e', title: '这条不该被看到' });
  // The provider is intact; the *runtime* is made to fail, which is what a broken store looks like.
  m.cognitive.continuitySnapshot = () => ({ ok: false, code: 'store-unavailable' });

  const { material, text } = await promptFor();
  assert.equal(material.sources.goals, 'not-wired', 'the source is visibly not wired');
  assert.equal(material.continuityState, 'not-wired');
  assert.equal(text.includes('这一轮看不到用户的目标与承诺'), true);
  assert.equal(text.includes('store-unavailable'), true, 'the reason is rendered, not swallowed');
  assert.equal(text.includes('不要据此推断'), true, 'and the "no goals" inference is explicitly forbidden');
  assert.equal(text.includes('这条不该被看到'), false, 'the goal is not silently half-shown');
});

test('E4 端到端：provider 超时（>25ms）时同样降级且标 timeout', { skip: SKIP }, async t => {
  const { m, promptFor } = await mounted(t);
  m.cognitive.continuitySnapshot = () => {
    const started = Date.now();
    while (Date.now() - started < 40) { /* burn the budget on purpose */ }
    return { ok: true, goals: [{ goalId: 'g', title: '迟到的目标' }], commitments: [] };
  };
  const { material, text } = await promptFor();
  assert.equal(material.continuityState, 'timeout', 'an over-budget call is reported as a timeout');
  assert.equal(material.sources.goals, 'not-wired');
  assert.equal(text.includes('这一轮看不到用户的目标与承诺'), true);
  assert.equal(text.includes('迟到的目标'), false, 'a late answer is not used half-way');
});

test('E6 端到端：纠正后第 2 轮 planner prompt 旧说法消失、新说法出现', { skip: SKIP }, async t => {
  const { m, promptFor } = await mounted(t);
  assert.equal(m.cognitive.assertBelief({
    sessionId: 'e2e', proposition: '用户喜欢在雨天散步', rootEvidenceIds: ['ev-1'], confidence: 0.8, source: 'conversation',
  }).ok, true);
  const belief = m.cognitive.listBeliefs({ sessionId: 'e2e' }).beliefs[0];
  assert.ok(belief, 'the belief exists');

  const first = await promptFor();
  assert.equal(first.text.includes('雨天散步'), true, 'round 1 sees the belief');
  assert.equal(first.text.includes('已知事实，不要当成新发现'), true, 'and it is labelled as known');

  const corrected = m.cognitive.correctBelief({
    sessionId: 'e2e', beliefId: belief.beliefId, byEvidenceId: 'ev-2',
    reason: '用户说不再喜欢了', replacement: '用户现在不喜欢在雨天散步',
  });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.equal(corrected.memoryCorrection?.kind, 'memory/correction-request', 'the correction is queued for memory');

  const second = await promptFor();
  assert.equal(second.text.includes('用户喜欢在雨天散步'), false, 'the old statement is gone from the prompt');
  assert.equal(second.text.includes('不喜欢在雨天散步'), true, 'the corrected statement is what remains');
});
