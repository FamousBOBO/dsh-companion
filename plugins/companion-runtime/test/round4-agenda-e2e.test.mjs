import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mountRuntime } from '../index.mjs';
import { createAgendaPort } from '../../companion-foundation/agenda-port.mjs';

// C4-1 组合测试：**真** foundation 端口 + **真** runtime agenda 服务。
//
// 审查要求"创建 → next → CAS → mark 全链路走通（不是每层各自用宽松桩）"。之前只验了"参数带过去了"，
// 而参数带过去 ≠ runtime 能解出 scope —— 那正是第三轮 B3 断掉的地方。

const T0 = Date.UTC(2026, 10, 20, 3, 0, 0);

function build(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-e2e-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'companion', 'runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    agenda: { enabled: true },
    p2: { activities: { enabled: false }, planning: { enabled: false }, share: { enabled: false } },
  }, null, 2), 'utf8');
  const identity = {
    owner: () => ({ id: 'owner-1', displayName: 'owner-1', platform: 'local' }),
    resolve: sessionId => ({ userId: 'owner-1', personaId: 'march7', displayName: 'owner-1', sessionId }),
  };
  const runtime = mountRuntime(null, root, { memory: null, identity, dbFile: path.join(root, 'home', 'companion', 'runtime.db'), now: () => T0 });
  t.after(() => {
    try { runtime.dispose?.(); } catch { /* disposed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  });
  return { runtime, root };
}

test('C4-1：真端口 + 真 runtime —— 创建 → next → CAS → mark 全链路走通', t => {
  const { runtime } = build(t);
  // The port receives the runtime exactly as the reminder channel would.
  const port = createAgendaPort({ cognitive: runtime, timeZone: 'Asia/Shanghai', now: () => T0 });

  const created = port.createSchedule({
    text: '喝水', at: T0, room: 'dm', target: 123, createdBy: 123, sessionId: 'session-a',
  });
  assert.equal(created.ok, true, `create must succeed (got ${JSON.stringify(created)})`);
  assert.ok(created.occurrenceId, 'a real occurrence id came back');

  const next = port.nextOccurrence({ occurrenceId: created.occurrenceId, at: T0, sessionId: 'session-a' });
  assert.equal(next.ok !== false || next.code !== 'not-found', true,
    `the runtime resolved the scope for nextOccurrence (got ${JSON.stringify(next)})`);

  const cas = port.casOccurrence({ occurrenceId: created.occurrenceId, revision: created.revision, at: T0, sessionId: 'session-a' });
  assert.equal(cas.ok, true, `CAS must succeed against the real occurrence (got ${JSON.stringify(cas)})`);
  assert.equal(cas.occurrenceId, created.occurrenceId);
  assert.equal(Number(cas.revision) >= Number(created.revision), true, `the CAS answered with a real revision (created=${created.revision}, cas=${cas.revision})`);

  const marked = port.markOccurrenceDispatched({
    occurrenceId: created.occurrenceId, revision: cas.revision, at: T0, sessionId: 'session-a',
    receipt: { at: T0, room: 'dm' },
  });
  assert.equal(marked.ok, true, `mark must succeed (got ${JSON.stringify(marked)})`);
  assert.equal(Number(marked.revision) >= Number(cas.revision), true, `and mark answered with a real revision (cas=${cas.revision}, marked=${marked.revision})`);
});

test('C4-1：没有 sessionId 时 runtime 解不出 scope（对照，证明上面的成功不是靠宽松桩）', t => {
  const { runtime } = build(t);
  const port = createAgendaPort({ cognitive: runtime, timeZone: 'Asia/Shanghai', now: () => T0 });
  const created = port.createSchedule({ text: '散步', at: T0, room: 'dm', target: 123, createdBy: 123, sessionId: 'session-a' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const withoutIdentity = port.casOccurrence({ occurrenceId: created.occurrenceId, revision: created.revision, at: T0 });
  assert.equal(withoutIdentity.ok, false, `without an identity the runtime cannot resolve the scope (got ${JSON.stringify(withoutIdentity)})`);
});
