// 两门分离的专项测试（计划 §5 A.4 / A.5）。
//
// 只用合成记录对象：本文件不起数据库、不读任何真实记忆文件。
// 四类 mentionPolicy 各给负例理由码，并证明「可见」与「可自动注入正文」是两个问题。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowAutoInjection,
  allowRetrieval,
  carriesBody,
  carriesBodyInAuto,
  countInjectionRenders,
  eligibleForRetrieval,
  injectionDecision,
} from '../lib/injection-gate.mjs';

const NOW = Date.parse('2026-03-07T12:00:00.000Z');
const VIEWER = Object.freeze({ userId: 'user_synth', personaId: 'bot', worldId: '' });

function row(overrides = {}) {
  return {
    id: 'mem_synth_1',
    scope: 'user_global',
    kind: 'event',
    subject: 'user',
    value: '合成的示例记忆正文',
    status: 'confirmed',
    userId: 'user_synth',
    personaId: 'bot',
    worldId: '',
    mentionPolicy: 'direct',
    realityLevel: 'explicit_user_statement',
    validFrom: '2026-03-01T00:00:00.000Z',
    validTo: null,
    occurredAt: '2026-03-01T08:00:00.000Z',
    ...overrides,
  };
}

const auto = { viewer: VIEWER, now: NOW, purpose: 'auto' };
const explicit = { viewer: VIEWER, now: NOW, purpose: 'explicit' };

test('门 1 只回答「能不能读」：状态/作用域/有效期/有效性', () => {
  assert.deepEqual(eligibleForRetrieval(row(), auto), { ok: true, reason: '' });
  assert.equal(allowRetrieval(row(), auto), true);

  assert.equal(eligibleForRetrieval(null, auto).reason, 'missing-record');
  assert.equal(eligibleForRetrieval(row(), {}).reason, 'no-viewer');
  assert.equal(eligibleForRetrieval(row(), { viewer: { userId: 'user_synth' }, now: NOW }).reason, 'no-viewer');
  assert.equal(eligibleForRetrieval(row({ status: 'pending' }), auto).reason, 'status-pending');
  assert.equal(eligibleForRetrieval(row({ status: 'superseded' }), auto).reason, 'status-superseded');
  assert.equal(eligibleForRetrieval(row({ userId: 'user_other' }), auto).reason, 'scope-mismatch');
  assert.equal(eligibleForRetrieval(row({ personaId: 'other' }), auto).reason, 'scope-mismatch');
  // 别世界的剧情行：作用域先报，不是过期。
  assert.equal(
    eligibleForRetrieval(row({ scope: 'roleplay_world', worldId: 'w1', realityLevel: 'roleplay_fiction' }), auto).reason,
    'scope-mismatch',
  );
  assert.equal(eligibleForRetrieval(row({ validTo: '2026-03-05T00:00:00.000Z' }), auto).reason, 'expired');
  assert.equal(eligibleForRetrieval(row({ validFrom: '2026-04-01T00:00:00.000Z' }), auto).reason, 'not-yet-valid');

  // 门 1 与用途无关：同一条记录在自动/显式两种用途下资格一致。
  for (const policy of ['direct', 'soft_echo', 'tone_only', 'avoid_unless_asked']) {
    const record = row({ mentionPolicy: policy });
    assert.equal(eligibleForRetrieval(record, auto).ok, true, `${policy} 自身是可见的`);
    assert.equal(eligibleForRetrieval(record, explicit).ok, true, `${policy} 在显式用途下同样可见`);
  }
  // 推断（助手猜的事实）也可见，只是不能以正文形态自动注入（见门 2）。
  const inferred = row({ realityLevel: 'inferred' });
  assert.equal(eligibleForRetrieval(inferred, auto).ok, true, '门 1 不靠现实级别做呈现判断');
});

test('门 2 负例：私密（avoid_unless_asked）在两种用途下都只给占位', () => {
  const secret = row({ kind: 'note', mentionPolicy: 'avoid_unless_asked', value: '不愿被主动提起的旧事' });
  const inAuto = injectionDecision(secret, auto);
  assert.equal(inAuto.allow, true, '记录存在这件事仍可见（模型可以问）');
  assert.equal(inAuto.render, 'placeholder');
  assert.equal(inAuto.reason, 'avoid-unless-asked');
  assert.equal(carriesBody(secret, auto), false, '自动注入不得携带正文');
  assert.equal(carriesBodyInAuto(secret, auto), false);

  const asExplicit = injectionDecision(secret, explicit);
  assert.equal(asExplicit.render, 'placeholder', '召回工具也不是「请给我这段私密正文」的授权');
  assert.equal(carriesBody(secret, explicit), false);
  assert.equal(allowAutoInjection(secret, auto), true, '占位允许出现');
});

test('门 2 负例：tone_only 在自动注入里只给提示行，只有显式查询才给正文', () => {
  const tone = row({ kind: 'event', mentionPolicy: 'tone_only', value: '那晚争吵的具体经过' });
  const inAuto = injectionDecision(tone, auto);
  assert.equal(inAuto.render, 'hint');
  assert.equal(inAuto.reason, 'tone-only-auto');
  assert.equal(inAuto.allow, true, '提示行允许出现（影响语气），正文不出现');
  assert.equal(carriesBody(tone, auto), false);

  const asExplicit = injectionDecision(tone, explicit);
  assert.equal(asExplicit.render, 'full', '用户明确来问时才给正文');
  assert.equal(asExplicit.reason, 'tone-only-explicit');
  assert.equal(carriesBody(tone, explicit), true);
  assert.equal(carriesBodyInAuto(tone, explicit), false, '快捷函数恒定按 auto 判断');
});

test('门 2 负例：soft_echo 只在正文旁带呼应标签，不阻断也不隐藏', () => {
  const soft = row({ kind: 'relationship', mentionPolicy: 'soft_echo', value: '一起看过一次夜空' });
  for (const ctx of [auto, explicit]) {
    const decision = injectionDecision(soft, ctx);
    assert.equal(decision.render, 'soft');
    assert.equal(decision.reason, 'soft-echo');
    assert.equal(decision.allow, true);
  }
  assert.equal(carriesBody(soft, auto), true, '共同经历可以自然呼应');
  assert.equal(carriesBodyInAuto(soft, auto), true);
});

test('门 2 负例：推断内容在自动注入里只给提示，显式查询才给正文', () => {
  const inferred = row({ realityLevel: 'inferred', value: '助手推断：用户最近压力大' });
  assert.equal(injectionDecision(inferred, auto).render, 'hint');
  assert.equal(injectionDecision(inferred, auto).reason, 'inferred-hint-only');
  assert.equal(carriesBodyInAuto(inferred, auto), false, '助手自己的猜测不得作为事实自动注入');
  assert.equal(injectionDecision(inferred, explicit).render, 'full');
  assert.equal(carriesBody(inferred, explicit), true);
});

test('门 2 正例基线：direct 与缺字段的旧数据都按可注入处理', () => {
  const direct = row();
  assert.deepEqual(injectionDecision(direct, auto), { allow: true, render: 'full', reason: 'direct' });
  const legacy = row({ mentionPolicy: undefined });
  assert.equal(injectionDecision(legacy, auto).render, 'full', '旧数据缺 mentionPolicy 时不能静默丢内容');
  const unknown = row({ mentionPolicy: 'weird-legacy-value' });
  assert.equal(injectionDecision(unknown, auto).render, 'full');
  assert.equal(injectionDecision(null, auto).render, 'skip');
});

test('门 2 负例：门 1 不通过的行在门 2 一律 skip（两道门不互相代偿）', () => {
  const pending = row({ status: 'pending', mentionPolicy: 'direct' });
  assert.deepEqual(injectionDecision(pending, auto), { allow: false, render: 'skip', reason: 'status-pending' });
  assert.equal(allowAutoInjection(pending, auto), false);

  const expiring = row({ validTo: '2026-03-05T00:00:00.000Z', mentionPolicy: 'soft_echo' });
  assert.equal(injectionDecision(expiring, auto).render, 'skip');
  assert.equal(injectionDecision(expiring, auto).reason, 'expired');
  assert.equal(carriesBody(expiring, auto), false);
});

test('不相关但可见的旧亲密记录：可见 ≠ 允许自动注入正文', () => {
  // 一条旧亲密记录（tone_only）与一句无关问候放在一起。旧实现会把正文塞进提示词，
  // 因为渲染层只认识 avoid_unless_asked。现在门 2 会把它压成提示行。
  const intimate = row({
    kind: 'event',
    scope: 'user_persona',
    mentionPolicy: 'tone_only',
    value: '那年夏天的亲密旧事，具体细节只说过一次',
    importance: 0.9,
  });
  assert.equal(eligibleForRetrieval(intimate, auto).ok, true, '门 1 不拦它：它确实属于本用户');
  assert.equal(injectionDecision(intimate, auto).render, 'hint');
  assert.equal(carriesBodyInAuto(intimate, auto), false, '无关场合不得自动把旧亲密细节摆出来');
});

test('countInjectionRenders 只返回计数，用于 explain/日志', () => {
  const rows = [
    row({ id: 'a', mentionPolicy: 'direct' }),
    row({ id: 'b', mentionPolicy: 'soft_echo', kind: 'relationship' }),
    row({ id: 'c', mentionPolicy: 'tone_only' }),
    row({ id: 'd', mentionPolicy: 'avoid_unless_asked' }),
    row({ id: 'e', status: 'archived' }),
    row({ id: 'f', realityLevel: 'inferred' }),
  ];
  assert.deepEqual(
    countInjectionRenders(rows, auto),
    { full: 1, soft: 1, hint: 2, placeholder: 1, skip: 1 },
  );
  assert.deepEqual(countInjectionRenders(null, auto), { full: 0, soft: 0, hint: 0, placeholder: 0, skip: 0 });
});
