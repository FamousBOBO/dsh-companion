// Persisted per-slot retry state; a restart must not reset an exhausted start.
export function startRetryGate(db, scope, slot, now) {
  const key = `p2_start_retry:${scope}:${slot}`;
  let state = {};
  try { state = JSON.parse(db.metaGet(key, '{}')); } catch {}
  const failures = Math.max(0, Number(state.failures) || 0);
  return { key, failures, allowed: failures < 3 && now >= (Number(state.nextAt) || 0) };
}
export function recordStartFailure(db, gate, now, code) {
  const failures = gate.failures + 1;
  db.metaSet(gate.key, JSON.stringify({ failures, nextAt: now + 300000 * failures, code: String(code ?? 'failed').slice(0, 80) }));
}
