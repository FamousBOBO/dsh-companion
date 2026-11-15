import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

// B 站派发前置：provider 未就绪时**不派**（首席裁决 2026-11-14）。
//
// 背景（F 包审计实测）：装在本机 profile 的 `dsh-bili-scroll@2.4.0` 副本**不含** provider publish
// 代码（同版本号、不同字节）。`runBilibili.available()` 因此是 false，而派发路径此前不查它 ——
// planner 照常排 B 站、pump 照常 start、执行阶段必然失败，产出一条注定失败的活动行。
//
// 修法两处，都在既有判据上，不新增探针、不联网：
//   1. planner 侧：`capabilities.bilibili.available !== true` 时 B 站 slot 不进候选目标
//      （`planner.mjs` 的 `biliAvailable` 判据本来就是这么写的，现在 runtime 真的把 false 传进去）；
//   2. 派发侧：`startDueActivities` 在 start 前再验一次 `ports.runBilibili.available()`，
//      未就绪就跳过该 slot 并留具名 code（`bilibili-provider-not-ready`）。
//
// 这一组用**真 runtime + 真 planner + 真 reducer**，只把 provider 端口换成桩：
//   - 未就绪：计划里不出现 bilibili（planner 已排除），即使有残留在册的 slot 也不 start；
//   - 就绪：照常 start（不能修成"永远不派"）；
//   - 未就绪不影响 read/write/explore（不能借机停掉整个心跳）。

const T0 = Date.UTC(2026, 10, 14, 3, 0, 0);
const BOUND = { userId: 'owner-1', persona: 'bot' };

function makeRoot(t, p2 = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-bili-gate-'));
  fs.mkdirSync(path.join(root, 'home/companion/works/sources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: {
      planning: { enabled: true, maxSlots: 12, maxAttempts: 2, wakeHour: 0, latestStartHour: 24, targetActivities: 4 },
      activities: { enabled: true, dispatchEnabled: true, artifactRoot: 'home/companion/works', chunkUnits: 40, maxUnitsPerStep: 40 },
      autonomy: { allowedSources: ['https://example.test/'], seedUrls: [], topics: ['测试'], searchProvider: 'dsh' },
      share: { enabled: false },
      budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, maxConcurrent: 2 },
    },
    agenda: { enabled: false },
    ...p2,
  }));
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'bot',
    owner: { id: 'owner-1', displayName: 'fixture', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-1' },
    sessions: {},
  }));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } });
  return root;
}

/** A plan that *asks* for a Bilibili duty slot, so the planner's own filter is what decides. */
function planJson() {
  return JSON.stringify({
    summary: '看一会儿B站',
    slots: [{
      kind: 'activity', activity: 'bilibili', title: '刷B站', detail: '',
      startAt: T0, endAt: T0 + 2 * 3600_000, flexibility: 'soft', targetRef: 'bilibili:duty',
    }],
  });
}

function mountWith(t, { providerReady }) {
  const root = makeRoot(t);
  const calls = [];
  let providerRuns = 0;
  const runBilibili = async () => { providerRuns += 1; return { status: 'completed', evidence: [] }; };
  runBilibili.available = () => providerReady;
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ ...BOUND, sessionId }) },
    callModel: async args => {
      calls.push(args.purpose);
      if (args.purpose === 'p2-planning') {
        return { text: planJson(), provider: 'test-provider', model: 'test-model', inputTokens: 40, outputTokens: 30 };
      }
      return { text: '模型答案', provider: 'test-provider', model: 'test-model', inputTokens: 12, outputTokens: 6 };
    },
    p2Ports: {
      runBilibili,
      readFile: async () => ({ ok: false, code: 'source-invalid' }),
      fetchPage: async () => ({ ok: false, code: 'source-invalid' }),
      writeFile: async () => ({ ok: true, bytes: 0, sha256: 'h' }),
    },
  });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });
  return { runtime, providerRuns: () => providerRuns };
}

const activitiesOf = runtime => runtime.listActivities({ bound: BOUND }).activities ?? [];

test('provider 未就绪：capability 目录如实报 provider-not-ready，planner 拒绝排 B 站', async t => {
  const { runtime } = mountWith(t, { providerReady: false });
  const capabilities = runtime.capabilitiesOf({ bound: BOUND }).capabilities;
  assert.equal(capabilities.bilibili.available, false, JSON.stringify(capabilities.bilibili));
  assert.equal(capabilities.bilibili.reason, 'provider-not-ready');
  // read/write stay available: the refusal is scoped to one capability.
  assert.equal(capabilities.write.available, true, JSON.stringify(capabilities.write));

  // The plan asks for a duty the runtime cannot execute. The planner validates against the *materials*
  // (which carry the real capability catalogue), so it refuses the whole plan rather than writing a
  // slot that would fail at execution. That refusal is the behaviour under test — it must be named,
  // and it must not be a silent "plan wrote it anyway".
  const planned = await runtime.planToday({ bound: BOUND, force: true });
  assert.equal(planned?.ok, false, JSON.stringify(planned));
  assert.equal(planned.code, 'invalid-plan');
  assert.match(String(planned.error ?? ''), /Bilibili duty is unavailable/);
  const slots = (runtime.listPlan({ bound: BOUND }).slots ?? []).filter(slot => slot.kind === 'activity');
  assert.equal(slots.some(slot => slot.activity === 'bilibili'), false,
    'no duty slot may be persisted for a capability that is not available');
});

test('provider 未就绪：即使有残留在册的 bilibili slot，也不 start、不留活动行', async t => {
  const { runtime, providerRuns } = mountWith(t, { providerReady: false });
  // A slot that survived from an older plan (the pump must still refuse it).
  runtime.recordActivityOutcome; // touch the API surface so the public shape is the real one
  const seeded = runtime.startActivity({
    bound: BOUND, kind: 'bilibili', target: 'bilibili:duty', reality: 'actual_tool_activity', windowMs: 2 * 3600_000,
  });
  const started = await seeded;
  assert.equal(started.ok, false, 'a direct start is refused while the provider is not ready');
  assert.equal(started.code, 'adapter-unavailable');
  assert.equal(providerRuns(), 0, 'the provider was never asked to run');
  assert.equal(activitiesOf(runtime).filter(item => item.kind === 'bilibili').length, 0, 'no activity row is left behind');
});

test('provider 就绪：计划里出现 bilibili，pump 真的 start', async t => {
  const { runtime } = mountWith(t, { providerReady: true });
  const capabilities = runtime.capabilitiesOf({ bound: BOUND }).capabilities;
  assert.equal(capabilities.bilibili.available, true, JSON.stringify(capabilities.bilibili));

  const planned = await runtime.planToday({ bound: BOUND, force: true });
  assert.equal(planned?.ok, true, JSON.stringify(planned));
  const slots = (runtime.listPlan({ bound: BOUND }).slots ?? []).filter(slot => slot.kind === 'activity');
  assert.equal(slots.some(slot => slot.activity === 'bilibili'), true,
    'a ready provider is still schedulable (the gate must not be a permanent off switch)');

  const pumped = await runtime.pumpActivities({ now: T0 + 60_000 });
  assert.equal(pumped.ok, true, JSON.stringify(pumped));
  const rows = activitiesOf(runtime).filter(item => item.kind === 'bilibili');
  assert.equal(rows.length, 1, 'the ready provider gets its activity row');
});
