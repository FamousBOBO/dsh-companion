import assert from 'node:assert/strict'
import type { Mutation } from '../../src/features/reminders/store-contract.js'

/** **期望业务成功**：取 `Mutation` 的 `value`；业务拒绝（`ok:false`）直接断言失败。 */
export function expectOk<T>(mutation: Mutation<T>, what = 'mutation'): T {
  assert.equal(mutation.ok, true, `${what} 应当是业务成功`)
  if (!mutation.ok) throw new Error('unreachable')
  return mutation.value
}

/** **期望业务拒绝**：存储故障不走这里（那是 reject）。 */
export function expectRejected<T>(mutation: Mutation<T>, what = 'mutation'): { code: string; message: string } {
  assert.equal(mutation.ok, false, `${what} 应当是业务拒绝`)
  if (mutation.ok) throw new Error('unreachable')
  return { code: mutation.code, message: mutation.message }
}
