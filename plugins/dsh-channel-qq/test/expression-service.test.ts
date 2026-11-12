/** 出站表情服务解析（`adapters/dsh-host/expression-service.ts`）的时序测试。
 *
 * 这条路径回答的问题是「这回能不能发图」。它有一个非常容易写错的实现方式：
 * 把「找不到」也缓存起来。那样在「QQ 通道先起来、companion-expression 后挂载」
 * 这个**最普通**的启动顺序里，出站配图会一辈子接不上，而日志里只有一句
 * `no-service`——看起来像配置没开，其实是缓存了一个空的结论。
 *
 * 所以这里按四种时序分别钉住，再加两条与缓存无关但同样重要的对照：
 *   - 多 ctx 之间不串味（每个会话各自问自己的作用域）；
 *   - 登记表抛错时按「没有」处理，且下一次仍能恢复。
 *
 * 只用假服务：`candidates`/`reply` 的**真实**策略（授权、冷却、配额、审核）在
 * `companion-expression` 里，这里测的是「我们有没有把它问对、问到了没有」。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const PORT = Symbol.for('dsh.companion.expression.v1')

// 数据根钉住：注册表的 `Map` 形态按它分区；也免得测试读宿主机上真实的数据目录。
const DATA_ROOT = 'D:\\test-data\\expression-service'
process.env.DSH_COMPANION_DATA_DIR = DATA_ROOT

const mod = await import('../src/adapters/dsh-host/expression-service.js')
const {
  expressionServiceOf, sendSticker, resetExpressionServiceCache, expressionServiceState,
} = mod

/** 一个形状正确的最小服务：只有 `candidates` 与 `reply`，两个都是函数。 */
interface FakeService {
  candidates: (input: Record<string, unknown>) => unknown
  reply: (input: Record<string, unknown>) => unknown
  tag: string
}

function fakeService(tag = 'v1'): FakeService {
  return {
    tag,
    candidates: () => ({ ok: true, candidates: [{ assetId: 'ast_abc123456' }] }),
    reply: () => ({ ok: true, messageId: 4242 }),
  }
}

/** 把服务装进进程级注册表（裸对象形态，与 companion-expression 的 publish 一致）。 */
function publish(service: unknown): void {
  Object.defineProperty(process, PORT, { value: { version: 1, service }, configurable: true, writable: true })
}

/** 把服务装进 `Map<dataRoot, …>` 形态（另一种真实形态：多数据根同进程）。 */
function publishMap(entries: Array<[string, unknown]>): void {
  Object.defineProperty(process, PORT, { value: new Map(entries), configurable: true, writable: true })
}

/** 卸载端口（模拟 companion-expression 的 disposer：删掉槽位）。 */
function unpublish(): void {
  Object.defineProperty(process, PORT, { value: undefined, configurable: true, writable: true })
}

/** 永远给不出服务的宿主上下文。 */
const noContext = (): unknown => null

/** 给出指定服务的宿主上下文。 */
const contextOf = (service: unknown) => (): unknown => ({ get: (name: string) => (name === 'companionExpression' ? service : undefined) })

after(() => {
  unpublish()
  resetExpressionServiceCache()
})

// ── 四种时序 ────────────────────────────────────────────────────────────────

test('时序 ①：QQ 先初始化、图库后挂载 —— 第一次没有，挂载后第二次拿到', async () => {
  unpublish()
  resetExpressionServiceCache()
  const first = expressionServiceOf(noContext)
  assert.equal(first.service, null, '图库还没挂载时必须是 null，不能编一个空壳')
  assert.equal(first.reason, 'registry-miss')

  const service = fakeService('late')
  publish(service)

  const second = expressionServiceOf(noContext)
  assert.equal(second.service, service, '后挂载的图库必须在下一次解析里被看到')
  assert.equal(second.reason, 'registry')
  assert.equal(expressionServiceState().available, true)
})

test('时序 ②：图库先挂载 —— 第一次就能拿到，且走注册表那一路', async () => {
  resetExpressionServiceCache()
  const service = fakeService('early')
  publish(service)
  const found = expressionServiceOf(noContext)
  assert.equal(found.service, service)
  assert.equal(found.reason, 'registry')
})

test('时序 ③：首次解析失败（登记表抛错）后第二次成功', async () => {
  resetExpressionServiceCache()
  // 登记表的 getter 抛错：Reflect.get 会抛，实现必须吞掉并当作「没有」。
  Object.defineProperty(process, PORT, {
    configurable: true,
    get() { throw new Error('registry exploded') },
  })
  const first = expressionServiceOf(noContext)
  assert.equal(first.service, null, '登记表抛错不能传染给调用方')
  assert.equal(first.reason, 'registry-threw')

  const service = fakeService('recovered')
  publish(service)
  const second = expressionServiceOf(noContext)
  assert.equal(second.service, service, '异常不能被缓存成永久结论')
})

test('时序 ④：服务卸载后重新挂载 —— 调用方拿到的是新对象，不是旧的', async () => {
  resetExpressionServiceCache()
  const oldService = fakeService('old')
  publish(oldService)
  assert.equal(expressionServiceOf(noContext).service, oldService)

  unpublish()
  const between = expressionServiceOf(noContext)
  assert.equal(between.service, null, '卸载期间必须如实报「没有」')
  assert.equal(expressionServiceState().available, false)

  const newService = fakeService('new')
  publish(newService)
  const afterRemount = expressionServiceOf(noContext)
  assert.equal(afterRemount.service, newService, '重新挂载后必须是新服务')
  assert.notEqual(afterRemount.service, oldService, '不能把旧对象当作当前服务')
})

// ── 宿主上下文优先，且多 ctx 不串味 ────────────────────────────────────────

test('ctx 里有服务时优先用 ctx；两个 ctx 各自拿自己的，不串味', async () => {
  resetExpressionServiceCache()
  // 注册表里放一个「不该被选中的」服务：ctx 命中时必须优先 ctx。
  publish(fakeService('registry'))
  const svcA = fakeService('A')
  const svcB = fakeService('B')
  assert.equal(expressionServiceOf(contextOf(svcA)).service, svcA)
  assert.equal(expressionServiceOf(contextOf(svcB)).service, svcB, '第二个 ctx 不能被第一个的结果顶替')
  assert.equal((expressionServiceOf(noContext).service as FakeService | null)?.tag, 'registry', 'ctx 没有服务时才回落到注册表')
})

test('ctx.get 抛错时按「没有」处理，继续试注册表', async () => {
  resetExpressionServiceCache()
  const service = fakeService('registry')
  publish(service)
  const throwing = (): unknown => ({ get() { throw new Error('ctx exploded') } })
  assert.equal(expressionServiceOf(throwing).service, service)
})

test('形状不对的服务（缺 reply）不算接上', async () => {
  resetExpressionServiceCache()
  publish({ candidates: () => ({ ok: true }) })
  const found = expressionServiceOf(noContext)
  assert.equal(found.service, null)
  assert.equal(found.reason, 'registry-shape')
})

test('Map 形态的注册表按数据根取；只有一个分区且没设数据根时用那一个', async () => {
  resetExpressionServiceCache()
  const mine = fakeService('mine')
  const other = fakeService('other')
  publishMap([[DATA_ROOT, { version: 1, service: mine }], ['D:\\elsewhere', { version: 1, service: other }]])
  assert.equal(expressionServiceOf(noContext).service, mine)

  // 没设数据根 + 只有一个分区：仍然能取到（单进程单数据根是最常见形态）。
  const saved = process.env.DSH_COMPANION_DATA_DIR
  delete process.env.DSH_COMPANION_DATA_DIR
  try {
    publishMap([['D:\\only-one', { version: 1, service: other }]])
    assert.equal(expressionServiceOf(noContext).service, other)
  } finally {
    if (saved !== undefined) process.env.DSH_COMPANION_DATA_DIR = saved
  }
})

// ── 发图本身的口径没被这次修改带偏 ──────────────────────────────────────────

test('sendSticker awaits async services and respects candidate refusal', async () => {
  let replies = 0
  const attempt = { groupId: 1, query: 'happy', text: '', mode: 'sticker_only' as const, log: () => {} }
  const service = {
    candidates: async () => ({ ok: true, send: true, candidates: [{ assetId: 'ast_abc123456' }] }),
    reply: async () => { replies++; return { ok: true, messageId: 42 } },
  }
  assert.equal((await sendSticker(service, attempt)).kind, 'sent')
  assert.equal(replies, 1)
  service.candidates = async () => ({ ok: true, send: false, candidates: [{ assetId: 'ast_abc123456' }] })
  assert.equal((await sendSticker(service, attempt)).kind, 'declined')
  assert.equal(replies, 1)
  service.candidates = async () => ({ ok: true, send: true, candidates: [{ assetId: 'ast_abc123456' }] })
  assert.equal((await sendSticker(service, { ...attempt, canSend: () => false })).kind, 'declined')
  assert.equal(replies, 1)
})

test('sendSticker：没有服务 → unavailable/no-service（不抛）', async () => {
  const outcome = await sendSticker(null, {
    groupId: 1, query: '开心', text: '好呀', mode: 'text_then_sticker', log: () => {},
  })
  assert.equal(outcome.kind, 'unavailable')
  assert.equal(outcome.kind === 'unavailable' ? outcome.reason : '', 'no-service')
})

test('sendSticker：没有回执（messageId）不算发过，且不重试', async () => {
  let replies = 0
  const service = {
    candidates: () => ({ ok: true, candidates: [{ assetId: 'ast_abc123456' }] }),
    reply: () => { replies += 1; return { ok: true } },
  }
  const outcome = await sendSticker(service as never, {
    groupId: 1, query: '开心', text: '好呀', mode: 'text_then_sticker', log: () => {},
  })
  assert.equal(outcome.kind, 'declined')
  assert.equal(outcome.kind === 'declined' ? outcome.reason : '', 'no-receipt')
  assert.equal(replies, 1, '没有回执也不许重试')
})

test('sendSticker：图库没给候选时不做「随便挑一张」的兜底', async () => {
  const service = {
    candidates: () => ({ ok: true, candidates: [] }),
    reply: () => { throw new Error('不该走到这里') },
  }
  const outcome = await sendSticker(service as never, {
    groupId: 1, query: '开心', text: '', mode: 'sticker_only', log: () => {},
  })
  assert.equal(outcome.kind, 'declined')
  assert.equal(outcome.kind === 'declined' ? outcome.reason : '', 'no-candidate')
})

test('expressionServiceState：从没解析过时是 never-resolved，且不含任何路径/URL 字段', async () => {
  unpublish()
  resetExpressionServiceCache()
  // 先解析一次「没有」，把快照写成可观察的状态。
  expressionServiceOf(noContext)
  const state = expressionServiceState()
  const keys = Object.keys(state).sort()
  assert.deepEqual(keys, ['available', 'capabilities', 'checkedAt', 'reason'])
  assert.equal(state.reason, 'registry-miss')

  const fresh = (() => { resetExpressionServiceCache(); return expressionServiceState() })()
  assert.equal(fresh.reason, 'never-resolved')
  assert.equal(fresh.available, false)
})
