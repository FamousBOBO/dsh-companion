import test from 'node:test'
import assert from 'node:assert/strict'
import { expressionHint } from '../src/features/messaging/expression-hint.js'

test('successful final DM surfaces a bounded approved shortlist without sending', async () => {
  const calls: unknown[] = []
  const result = await expressionHint({ log() {}, expressionCandidates(input) {
    calls.push(input)
    return { send: true, candidates: [1, 2, 3, 4], reasonCode: 'send' }
  } }, { target: 123, isGroup: false }, '抱抱')
  assert.deepEqual(calls, [{ target: '123', isGroup: false, query: '抱抱', limit: 3 }])
  assert.deepEqual((result.expression as { candidates: unknown[] }).candidates, [1, 2, 3])
})

test('group, progress and unavailable library do not query', async () => {
  const deps = { log() {}, expressionCandidates() { throw new Error('must not query') } }
  assert.deepEqual(await expressionHint(deps, { isGroup: true }, '抱抱'), {})
  assert.deepEqual(await expressionHint(deps, { phase: 'progress' }, '抱抱'), {})
  assert.deepEqual(await expressionHint({ log() {} }, {}, '抱抱'), {})
})

test('declines and library failures leave successful text delivery unchanged', async () => {
  for (const response of [{ send: false, candidates: [1] }, { send: true, candidates: [] }]) {
    const result = await expressionHint({ log() {}, expressionCandidates: () => response }, { target: 123 }, '正文')
    assert.deepEqual(result, { expression: { checked: true, send: false, reason: 'no-candidates' } })
  }
  assert.deepEqual(await expressionHint({ log() {}, expressionCandidates() { throw Error('offline') } }, { target: 123 }, '正文'), {})
})
