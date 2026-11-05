// C4 短期状态纯函数测试（A09）。
// 固定时间原点 + 固定事件时间线，不读真实时钟、不碰数据库、不调用模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STATE_DEFS, STATE_SCHEMA_VERSION, BUDGET_WEIGHTS, BUDGET_DEFAULTS, DISABLED_BY_DEFAULT,
  createStateSlice, applyImpulse, advance, normalize, injectionBudget, normalizedBudget,
  ablate, describe, applyStateEvent,
} from '../lib/state.mjs';

const T0 = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DEF = Object.fromEntries(STATE_DEFS.map((def) => [def.id, def]));
const DEF_IDS = STATE_DEFS.map((def) => def.id);

// ---------------------------------------------------------------- 固定夹具
// 注入预算的固定夹具：每条夹具用同一时间原点重放，决策只取夹具求值时刻的预算。
const BUDGET_FIXTURES = [
  { id: 'quiet', at: T0 + 30 * MINUTE, events: [] },
  { id: 'interrupted', at: T0, events: [{ id: 'fx-interrupt', amount: 0.9, at: T0 }] },
  { id: 'recovered', at: T0, events: [{ id: 'fx-recover', kind: 'state/recovered', amount: 1, at: T0 }] },
  { id: 'half-decayed', at: T0 + 5 * MINUTE, events: [{ id: 'fx-burst', amount: 0.8, at: T0 }] },
];

// 会动但没有任何预算系数的变量：用来验证「无关变量必须默认关闭」这条规则本身。
const PROBE_DEFS = [
  ...STATE_DEFS,
  { id: 'probe', baseline: 0.5, tauMs: 600 * SECOND, min: 0, max: 1, weights: { 'state/impulse': 1, 'state/recovered': -1 } },
];

function assertClose(actual, expected, tolerance, label) {
  const error = Math.abs(actual - expected);
  assert.ok(error <= tolerance, `${label}: |${actual} - ${expected}| = ${error} > ${tolerance}`);
}

function assertValuesClose(actual, expected, tolerance = 1e-12) {
  for (const id of DEF_IDS) assertClose(actual[id], expected[id], tolerance, id);
}

function replayFixture(fixture, { ablateIds = [], defs } = {}) {
  let slice = createStateSlice(T0, defs ? { defs } : {});
  if (ablateIds.length) slice = ablate(slice, ablateIds, T0);
  return advance(slice, fixture.at, fixture.events);
}

/** 每个变量：在多少条夹具上改变预算决策、最大可见变化（字符数）。 */
function variableRelevance(defs) {
  const relevance = new Map();
  for (const def of defs) {
    let decisions = 0;
    let maxDelta = 0;
    for (const fixture of BUDGET_FIXTURES) {
      const full = injectionBudget(replayFixture(fixture, { defs }), fixture.at);
      const without = injectionBudget(replayFixture(fixture, { defs, ablateIds: [def.id] }), fixture.at);
      if (full !== without) {
        decisions += 1;
        maxDelta = Math.max(maxDelta, Math.abs(full - without));
      }
    }
    relevance.set(def.id, { decisions, maxDelta });
  }
  return relevance;
}

// A09 事件时间线：发生时刻刻意不与任何采样步长对齐，并包含一次上界 clip 和两种 kind。
const A09_TIMELINE = [
  { id: 'a09-1', amount: 0.55, at: T0 + 7_500 },
  { id: 'a09-2', amount: 0.35, at: T0 + 42_000 },
  { id: 'a09-3', kind: 'state/recovered', amount: 0.8, at: T0 + 130_500 },
  { id: 'a09-4', amount: 1.4, at: T0 + 301_000 },
  { id: 'a09-5', amount: 0.6, at: T0 + 600_000 },
  { id: 'a09-6', kind: 'state/recovered', amount: 0.45, at: T0 + 905_000 },
  { id: 'a09-7', amount: 0.2, at: T0 + 1_200_000 },
  { id: 'a09-8', amount: 0.75, at: T0 + 1_500_000 },
];
const A09_FINAL = T0 + 1_800_000; // 30 分钟：可被 10/60/300 秒整除

/** 按 stepMs 采样推进到 finalAt；每个采样点把「已发生」的事件整批交给 advance。 */
function sampleTimeline(events, stepMs, finalAt) {
  let slice = createStateSlice(T0);
  for (let edge = T0 + stepMs; edge <= finalAt; edge += stepMs) {
    slice = advance(slice, edge, events.filter((event) => event.at <= edge));
  }
  return slice;
}

// ---------------------------------------------------------------- 冻结签名
test('exports the frozen names and the engineering parameters from the contract', () => {
  assert.deepEqual(DEF_IDS, ['tension', 'energy', 'focus']);
  assert.equal(DEF.tension.baseline, 0.2);
  assert.equal(DEF.tension.tauMs, 1_800_000);
  assert.equal(DEF.energy.baseline, 0.65);
  assert.equal(DEF.energy.tauMs, 3_600_000);
  assert.equal(DEF.focus.baseline, 0.5);
  assert.equal(DEF.focus.tauMs, 900_000);
  for (const def of STATE_DEFS) {
    assert.equal(def.min, 0);
    assert.equal(def.max, 1);
    assert.notEqual(def.weights['state/impulse'], 0);
  }
  assert.ok(Object.isFrozen(STATE_DEFS) && Object.isFrozen(DISABLED_BY_DEFAULT) && Object.isFrozen(BUDGET_WEIGHTS));
  assert.equal(STATE_SCHEMA_VERSION, 1);
  for (const id of DISABLED_BY_DEFAULT) assert.ok(DEF_IDS.includes(id), `unknown disabled variable ${id}`);
});

test('module stays pure: no clock, randomness, I/O or extra imports', () => {
  const source = readFileSync(new URL('../lib/state.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Date\.now|performance\.now|Math\.random|new Date\(/);
  assert.doesNotMatch(source, /node:fs|node:net|node:http|node:sqlite|fetch\(/);
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(specifiers)], ['./errors.mjs']);
});

test('a new slice sits on the baseline and survives a JSON round trip', () => {
  const slice = createStateSlice(T0);
  assert.equal(slice.evaluatedAt, T0);
  assert.deepEqual(slice.values, { tension: 0.2, energy: 0.65, focus: 0.5 });
  assert.deepEqual(slice.pinned, []);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(slice)), T0), normalize(slice, T0));
});

// ---------------------------------------------------------------- 数学语义
test('a single impulse decays exponentially back to the baseline', () => {
  const slice = createStateSlice(T0);
  const kicked = applyImpulse(slice, { id: 'impulse-1', amount: 0.6, at: T0 });
  assertClose(kicked.values.tension, 0.8, 1e-12, 'tension +1 * 0.6');
  assertClose(kicked.values.energy, 0.65 - 0.7 * 0.6, 1e-12, 'energy -0.7 * 0.6');
  assertClose(kicked.values.focus, 0, 1e-12, 'focus 0.5 - 0.9 * 0.6 must clip at 0');

  // 段内公式：s(t+Δ) = b + (s(t)-b)·e^(-Δ/τ)，未裁剪的变量按 1e-12 复算。
  for (const deltaMs of [SECOND, 30 * SECOND, DEF.tension.tauMs, 10 * MINUTE]) {
    const later = advance(kicked, T0 + deltaMs, []);
    const expected = DEF.tension.baseline + (0.8 - DEF.tension.baseline) * Math.exp(-deltaMs / DEF.tension.tauMs);
    assert.ok(Math.abs(later.values.tension - expected) <= 1e-12, `tension after ${deltaMs}ms`);
  }

  // 20 个最长 τ 之后全部回到基线 1e-6 以内，且从不下穿基线。
  const horizon = T0 + 20 * Math.max(...STATE_DEFS.map((def) => def.tauMs));
  const settled = advance(kicked, horizon, []);
  assert.ok(Math.abs(settled.values.tension - DEF.tension.baseline) <= 1e-6);
  assert.ok(settled.values.tension >= DEF.tension.baseline);
  assert.ok(Math.abs(settled.values.energy - DEF.energy.baseline) <= 1e-6);
  assert.ok(Math.abs(settled.values.focus - DEF.focus.baseline) <= 1e-6);
});

test('clip runs only after an impulse, plain decay never clips', () => {
  const slice = createStateSlice(T0);
  const up = applyImpulse(slice, { id: 'clip-up', amount: 9, at: T0 });
  assert.equal(up.values.tension, 1);
  assert.equal(up.values.energy, 0);
  assert.equal(up.values.focus, 0);
  const down = applyImpulse(slice, { id: 'clip-down', amount: -9, at: T0 });
  assert.equal(down.values.tension, 0);
  assert.equal(down.values.energy, 1);
  assert.equal(down.values.focus, 1);

  // 上界值只按指数回落：不裁剪、不贴边、不越过基线。
  let previous = 1;
  for (let step = 1; step <= 20; step += 1) {
    const value = advance(up, T0 + step * (DEF.tension.tauMs / 10), []).values.tension;
    assert.ok(value < previous, 'decay must be strictly monotone toward the baseline');
    assert.ok(value > DEF.tension.baseline);
    assert.ok(value <= 1);
    previous = value;
  }
  // 采样本身不改变轨迹（同一次推进 vs 分很多次推进）。
  const once = advance(createStateSlice(T0), T0 + 10 * MINUTE, [{ id: 'seg', amount: 0.6, at: T0 }]);
  const many = advance(advance(slice, T0, [{ id: 'seg', amount: 0.6, at: T0 }]), T0 + 10 * MINUTE, []);
  assert.ok(Math.abs(once.values.tension - many.values.tension) <= 1e-12);
});

test('out-of-order events give exactly the sorted-order trajectory', () => {
  const events = [
    { id: 'o-3', amount: 0.3, at: T0 + 90_000 },
    { id: 'o-1', amount: 0.7, at: T0 + 15_000 },
    { id: 'o-4', kind: 'state/recovered', amount: 0.5, at: T0 + 200_000 },
    { id: 'o-2', amount: 0.9, at: T0 + 45_000 },
  ];
  const sorted = [...events].sort((left, right) => left.at - right.at);
  const shuffled = [events[2], events[0], events[3], events[1]];
  const expected = advance(createStateSlice(T0), A09_FINAL, sorted);
  const actual = advance(createStateSlice(T0), A09_FINAL, shuffled);
  assert.deepEqual(actual.values, expected.values);
  assert.deepEqual(actual.applied, expected.applied);
  // 事件真的在发生点结算：15s 处的冲击在 60s 前已经衰减，而不是攒到末尾批量施加。
  const batched = advance(advance(createStateSlice(T0), A09_FINAL, []), A09_FINAL, [
    { id: 'o-1', amount: 0.7, at: A09_FINAL },
  ]);
  assert.notEqual(actual.values.tension, batched.values.tension);
});

test('duplicate delivery is idempotent, keyed by (id, at)', () => {
  const slice = createStateSlice(T0);
  const event = { id: 'dup-1', amount: 0.5, at: T0 + 1_000 };
  const once = advance(slice, T0 + 5 * MINUTE, [event]);
  const thrice = advance(slice, T0 + 5 * MINUTE, [event, { ...event }, { ...event }]);
  assert.deepEqual(thrice.values, once.values);
  // 之后再投递同一 (id, at)（哪怕金额被改）不再生效。
  const redelivered = advance(once, T0 + 10 * MINUTE, [{ ...event, amount: -0.9 }]);
  const clean = advance(slice, T0 + 10 * MINUTE, [event]);
  assertValuesClose(redelivered.values, clean.values);
  // 同一 id 的不同发生时刻是两个事件。
  const twoMoments = advance(slice, T0 + 10 * MINUTE, [
    { id: 'dup-2', amount: 0.3, at: T0 },
    { id: 'dup-2', amount: 0.3, at: T0 + 60_000 },
  ]);
  const singleMoment = advance(slice, T0 + 10 * MINUTE, [{ id: 'dup-2', amount: 0.3, at: T0 }]);
  assert.notEqual(twoMoments.values.tension, singleMoment.values.tension);
  assert.equal(twoMoments.applied.length, 2);
});

test('A09: 10/60/300 s sampling agree at the same final instant (|Δ| <= 1e-6)', () => {
  const sampled = {
    '10s': sampleTimeline(A09_TIMELINE, 10 * SECOND, A09_FINAL),
    '60s': sampleTimeline(A09_TIMELINE, 60 * SECOND, A09_FINAL),
    '300s': sampleTimeline(A09_TIMELINE, 300 * SECOND, A09_FINAL),
    'single-shot': advance(createStateSlice(T0), A09_FINAL, A09_TIMELINE),
  };
  const names = Object.keys(sampled);
  const normalized = Object.fromEntries(names.map((name) => [name, normalize(sampled[name], A09_FINAL)]));
  let maxError = 0;
  let worst = 'none';
  for (const left of names) {
    for (const right of names) {
      if (left >= right) continue;
      for (const id of DEF_IDS) {
        const error = Math.abs(normalized[left][id] - normalized[right][id]);
        if (error > maxError) {
          maxError = error;
          worst = `${id}: ${left} vs ${right}`;
        }
      }
    }
  }
  console.log(`A09 max |Δ normalized| = ${maxError.toExponential(3)} (worst ${worst}, limit 1e-6)`);
  assert.ok(maxError <= 1e-6, `A09 sampling invariance failed: ${maxError} (${worst})`);
  for (const name of names) assert.equal(sampled[name].evaluatedAt, A09_FINAL);
  // 误差小只有在状态确实动过时才有意义。
  const initial = normalize(createStateSlice(T0), T0);
  assert.ok(DEF_IDS.some((id) => Math.abs(normalized['10s'][id] - initial[id]) > 1e-3), 'timeline must move the state');
  // 敏感度自证：把同一批事件攒到区间末尾才施加（错误实现）必须远超阈值。
  const batched = advance(createStateSlice(T0), A09_FINAL, A09_TIMELINE.map((event) => ({ ...event, at: A09_FINAL })));
  const batchedError = Math.max(...DEF_IDS.map((id) => Math.abs(normalize(batched, A09_FINAL)[id] - normalized['10s'][id])));
  console.log(`A09 sensitivity: batching impulses at the interval end would differ by ${batchedError.toExponential(3)}`);
  assert.ok(batchedError > 1e-3, 'the sampling-invariance check must be sensitive to event-time batching');
});

// ---------------------------------------------------------------- 消融
test('ablation pins a variable to its baseline while the others keep moving', () => {
  const slice = createStateSlice(T0);
  const ablated = ablate(slice, ['tension'], T0);
  assert.deepEqual(ablated.pinned, ['tension']);
  assert.equal(ablated.values.tension, DEF.tension.baseline);
  const kicked = advance(ablated, A09_FINAL, A09_TIMELINE);
  assert.equal(normalize(kicked, A09_FINAL).tension, DEF.tension.baseline);
  assert.notEqual(normalize(kicked, A09_FINAL).energy, DEF.energy.baseline);
  assert.notEqual(normalize(kicked, A09_FINAL).focus, DEF.focus.baseline);
  // 消融 + 充分回落 == 该变量从一开始就在基线。
  const settled = injectionBudget(kicked, A09_FINAL + 24 * 60 * MINUTE);
  const quietPinned = injectionBudget(createStateSlice(T0, { disabled: ['tension'] }), T0);
  assert.equal(settled, quietPinned);
  // 消融等价于「该变量当前值就是基线」。
  const manual = { ...kicked, values: { ...kicked.values, tension: DEF.tension.baseline }, pinned: [] };
  assert.equal(injectionBudget(manual, A09_FINAL), injectionBudget(kicked, A09_FINAL));
});

test('disabled variables from createStateSlice behave like ablations', () => {
  const disabled = createStateSlice(T0, { disabled: ['focus'] });
  assert.deepEqual(disabled.pinned, ['focus']);
  const after = advance(disabled, A09_FINAL, A09_TIMELINE);
  assert.equal(normalize(after, A09_FINAL).focus, DEF.focus.baseline);
  const ablated = advance(ablate(createStateSlice(T0), ['focus'], T0), A09_FINAL, A09_TIMELINE);
  assert.deepEqual(normalize(after, A09_FINAL), normalize(ablated, A09_FINAL));
});

// ---------------------------------------------------------------- 注入预算
test('injectionBudget is a deterministic integer derived only from normalized values', () => {
  for (const fixture of BUDGET_FIXTURES) {
    const slice = replayFixture(fixture);
    const budget = injectionBudget(slice, fixture.at);
    assert.ok(Number.isInteger(budget));
    assert.ok(budget >= BUDGET_DEFAULTS.min && budget <= BUDGET_DEFAULTS.max);
    assert.equal(budget, injectionBudget(slice, fixture.at));
    assert.equal(budget, normalizedBudget(normalize(slice, fixture.at)));
  }
  // 不同轨迹、同一归一化状态 -> 同一预算。
  const pinned = ablate(createStateSlice(T0), DEF_IDS, T0);
  const left = advance(pinned, T0 + 10 * MINUTE, [{ id: 'only-1', amount: 0.9, at: T0 }]);
  const right = advance(pinned, T0 + 10 * MINUTE, [{ id: 'only-2', amount: -0.4, at: T0 + 5_000 }]);
  assert.deepEqual(normalize(left, T0 + 10 * MINUTE), normalize(right, T0 + 10 * MINUTE));
  assert.equal(injectionBudget(left, T0 + 10 * MINUTE), injectionBudget(right, T0 + 10 * MINUTE));
});

test('injectionBudget is bounded and monotone in every variable', () => {
  const steps = [0, 0.2, 0.4, 0.6, 0.8, 1];
  for (const focus of steps) {
    for (const energy of steps) {
      let previous = Infinity;
      for (const tension of steps) {
        const budget = normalizedBudget({ tension, energy, focus });
        assert.ok(Number.isInteger(budget));
        assert.ok(budget >= BUDGET_DEFAULTS.min && budget <= BUDGET_DEFAULTS.max);
        assert.ok(budget <= previous, `tension ${tension} must not raise the budget`);
        previous = budget;
      }
    }
  }
  for (const focus of steps) {
    for (const tension of steps) {
      let previous = Infinity;
      for (const energy of steps) {
        const budget = normalizedBudget({ tension, energy, focus });
        assert.ok(budget <= previous, `energy ${energy} must not raise the budget`);
        previous = budget;
      }
    }
  }
  for (const energy of steps) {
    for (const tension of steps) {
      let previous = -Infinity;
      for (const focus of steps) {
        const budget = normalizedBudget({ tension, energy, focus });
        assert.ok(budget >= previous, `focus ${focus} must not lower the budget`);
        previous = budget;
      }
    }
  }
  // 自定义参数同样取整且有界；参数非法时报 invalid-input。
  for (const point of [{ tension: 0, energy: 0, focus: 1 }, { tension: 1, energy: 1, focus: 0 }]) {
    const budget = normalizedBudget(point, { base: 240, min: 90, max: 260 });
    assert.ok(Number.isInteger(budget));
    assert.ok(budget >= 90 && budget <= 260);
  }
  assert.equal(normalizedBudget({}), Math.round(BUDGET_DEFAULTS.base));
  assert.throws(() => normalizedBudget({}, { min: 300, max: 100 }), (error) => error.code === 'invalid-input');
});

test('every enabled variable changes a fixture decision; every disabled one changes none', () => {
  const relevance = variableRelevance(STATE_DEFS);
  const inert = DEF_IDS.filter((id) => relevance.get(id).decisions === 0).sort();
  // 双向断言：无收益的变量必须进 DISABLED_BY_DEFAULT，反之亦然。
  assert.deepEqual([...DISABLED_BY_DEFAULT].sort(), inert);
  const enabled = DEF_IDS.filter((id) => !DISABLED_BY_DEFAULT.includes(id));
  for (const id of enabled) {
    const { decisions, maxDelta } = relevance.get(id);
    assert.ok(decisions >= 1, `${id} must change at least one fixture decision`);
    assert.ok(maxDelta >= 1, `${id} must visibly change the integer budget`);
    console.log(`fixture relevance ${id}: ${decisions}/${BUDGET_FIXTURES.length} decisions, max |Δ budget| = ${maxDelta}`);
  }
  // 规则自检：会动、但没有预算系数的变量必须被判为无关（否则上面的检查就是空转）。
  assert.equal(BUDGET_WEIGHTS.probe, undefined);
  const probe = variableRelevance(PROBE_DEFS);
  assert.equal(probe.get('probe').decisions, 0);
  assert.notEqual(normalize(advance(createStateSlice(T0, { defs: PROBE_DEFS }), T0, [
    { id: 'probe-1', amount: 0.6, at: T0 },
  ]), T0).probe, 0.5, 'the probe variable must actually move');
  for (const id of DEF_IDS) assert.ok(probe.get(id).decisions >= 1);
});

test('budget reacts to time: a burst lowers it, decay restores the quiet value', () => {
  const quiet = injectionBudget(replayFixture(BUDGET_FIXTURES[0]), BUDGET_FIXTURES[0].at);
  const interrupted = injectionBudget(replayFixture(BUDGET_FIXTURES[1]), BUDGET_FIXTURES[1].at);
  const halfDecayed = injectionBudget(replayFixture(BUDGET_FIXTURES[3]), BUDGET_FIXTURES[3].at);
  assert.ok(interrupted < halfDecayed, 'decay must relax the budget back toward the quiet value');
  assert.ok(halfDecayed < quiet);
  const settled = advance(replayFixture(BUDGET_FIXTURES[1]), T0 + 24 * 60 * MINUTE, []);
  assert.equal(injectionBudget(settled, T0 + 24 * 60 * MINUTE), quiet);
});

test('describe reports values, normalized, budgetChars and evaluatedAt', () => {
  const slice = replayFixture(BUDGET_FIXTURES[3]);
  const described = describe(slice, slice.evaluatedAt);
  assert.deepEqual(Object.keys(described).sort(), ['budgetChars', 'evaluatedAt', 'normalized', 'values']);
  assert.equal(described.evaluatedAt, slice.evaluatedAt);
  assert.deepEqual(described.values, slice.values);
  assert.deepEqual(described.normalized, normalize(slice, slice.evaluatedAt));
  assert.equal(described.budgetChars, injectionBudget(slice, slice.evaluatedAt));
  assert.ok(Number.isInteger(described.budgetChars));
  for (const id of DEF_IDS) {
    assert.ok(described.normalized[id] >= 0 && described.normalized[id] <= 1);
  }
  const custom = describe(slice, slice.evaluatedAt, { base: 200, min: 100, max: 120 });
  assert.ok(custom.budgetChars >= 100 && custom.budgetChars <= 120);
});

// ---------------------------------------------------------------- reducer 适配
test('applyStateEvent matches applyImpulse and reports reason codes only', () => {
  const slice = createStateSlice(T0);
  const event = { eventId: 'evt-state-1', kind: 'state/impulse', occurredAt: T0 + 1_000, payload: { amount: 0.5 } };
  const applied = applyStateEvent({ event, slice, now: T0 });
  assert.deepEqual(applied.slice.values, applyImpulse(slice, { id: 'evt-state-1', amount: 0.5, at: T0 + 1_000 }).values);
  assert.equal(applied.result.applied, true);
  assert.equal(applied.result.kind, 'state/impulse');
  for (const key of ['eventId', 'text', 'content', 'reason']) assert.equal(applied.result[key], undefined);

  // 重复投递同一个信封：值不变，只报理由码。
  const again = applyStateEvent({ event, slice: applied.slice, now: T0 + 2_000 });
  assert.deepEqual(again.slice.values, applied.slice.values);
  assert.equal(again.result.applied, false);
  assert.equal(again.result.reason, 'duplicate-applied-impulse');

  // 未参与状态的事件 kind、以及缺失切片（从事件时刻自建）。
  const ignored = applyStateEvent({ event: { ...event, eventId: 'evt-topic', kind: 'topic/switch' }, slice, now: T0 });
  assert.equal(ignored.result.applied, false);
  assert.equal(ignored.result.reason, 'kind-not-weighted');
  assert.deepEqual(ignored.slice.values, slice.values);
  const fresh = applyStateEvent({ event, now: T0 });
  assert.deepEqual(fresh.slice.values, applied.slice.values);
  // state/recovered 有独立权重。
  const recovered = applyStateEvent({
    event: { eventId: 'evt-recovered', kind: 'state/recovered', occurredAt: T0, payload: {} }, slice, now: T0,
  });
  assert.equal(recovered.slice.values.tension, 0); // 0.2 - 0.6 在下界裁到 0
  assert.equal(recovered.slice.values.energy, 1); // 0.65 + 0.5 在上界裁到 1
  assertClose(recovered.slice.values.focus, DEF.focus.baseline + 0.4, 1e-12, 'recovered focus');
});

test('functions never mutate their input slice', () => {
  const slice = advance(createStateSlice(T0), T0 + MINUTE, [{ id: 'pure-1', amount: 0.4, at: T0 }]);
  const snapshot = JSON.parse(JSON.stringify(slice));
  applyImpulse(slice, { id: 'pure-2', amount: 0.2, at: T0 + 2 * MINUTE });
  advance(slice, T0 + 5 * MINUTE, [{ id: 'pure-3', amount: 0.1, at: T0 + 3 * MINUTE }]);
  normalize(slice, T0 + MINUTE);
  injectionBudget(slice, T0 + MINUTE);
  describe(slice, T0 + MINUTE);
  ablate(slice, ['energy'], T0 + MINUTE);
  assert.deepEqual(JSON.parse(JSON.stringify(slice)), snapshot);
});

test('malformed input is rejected with the typed invalid-input code', () => {
  const invalid = (error) => error.code === 'invalid-input';
  assert.throws(() => createStateSlice(undefined), invalid);
  assert.throws(() => createStateSlice(T0, { disabled: ['mood'] }), invalid);
  assert.throws(() => createStateSlice(T0, { defs: [] }), invalid);
  const slice = createStateSlice(T0);
  assert.throws(() => applyImpulse(slice, { id: 'bad', amount: Number.NaN, at: T0 }), invalid);
  assert.throws(() => applyImpulse(slice, { amount: 1, at: T0 }), invalid);
  assert.throws(() => applyImpulse(slice, { id: 'bad', amount: 1, at: 'later' }), invalid);
  assert.throws(() => advance(slice, Number.NaN, []), invalid);
  assert.throws(() => advance(slice, T0, 'nope'), invalid);
  assert.throws(() => ablate(slice, ['mood'], T0), invalid);
  assert.throws(() => normalize({ ...slice, defs: undefined }, T0), invalid);
});
