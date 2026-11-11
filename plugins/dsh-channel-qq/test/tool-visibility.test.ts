/** 表情工具**可见性**诊断的测试（`adapters/dsh-host/tool-visibility.ts`）。
 *
 * 这份诊断的意义是「把三种看起来一样的失败分开」：模块没挂、工具没注册、会话看不见、
 * 发送器看不见。测试盯的正是这四个结论各自能被认出来，以及**读不出来时说不知道**，
 * 不许把「没读到」说成「没有」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  probeToolVisibility, EXPRESSION_TOOL_NAMES, SENDER_TOOL_NAMES,
} = await import('../src/adapters/dsh-host/tool-visibility.js')

type Getter = (name: string) => unknown

/** 一套探测依赖：`global` 控制全局层，`session` 控制会话层。 */
function deps(over: {
  service?: unknown
  global?: Getter
  session?: (name: string, agent: unknown) => unknown
  agents?: () => ReadonlyArray<{ room: string; agent: unknown }>
} = {}) {
  return {
    serviceOf: () => (over.service === undefined ? null : over.service),
    getGlobal: over.global ?? (() => undefined),
    ...(over.session === undefined ? {} : { getInSession: over.session }),
    agents: over.agents ?? (() => []),
  }
}

/** 一个「全都在」的双层假工具表。 */
function everything(names: readonly string[], session = true) {
  return {
    global: (name: string) => (names.includes(name) ? { name } : undefined),
    session: session ? (name: string) => (names.includes(name) ? { name } : undefined) : undefined,
  }
}

test('模块没挂载：结论直接指向 companion-expression，不去猜工具', () => {
  const report = probeToolVisibility(deps())
  assert.equal(report.module, 'no')
  assert.match(report.hint, /companion-expression 未挂载/)
  // 四个工具都如实报 no（全局层没有），不是 unknown。
  for (const name of EXPRESSION_TOOL_NAMES) assert.equal(report.registered[name], 'no')
})

test('模块在、工具没注册：结论指向 ctx.tools.register', () => {
  const report = probeToolVisibility(deps({ service: { ok: true } }))
  assert.equal(report.module, 'yes')
  assert.match(report.hint, /都没注册到宿主工具表/)
})

test('工具全在、没有会话：结论指向「只剩素材授权与 delivery.enabled」', () => {
  const all = [...EXPRESSION_TOOL_NAMES, ...SENDER_TOOL_NAMES]
  const report = probeToolVisibility(deps({ service: { ok: true }, ...everything(all) }))
  for (const name of EXPRESSION_TOOL_NAMES) assert.equal(report.registered[name], 'yes')
  for (const name of SENDER_TOOL_NAMES) assert.equal(report.sender[name], 'yes')
  assert.deepEqual(report.sessions, [])
  assert.match(report.hint, /素材授权与 delivery\.enabled/)
})

test('会话层看不见：结论点出具体房间（会话作用域 / tools.restrict）', () => {
  const all = [...EXPRESSION_TOOL_NAMES, ...SENDER_TOOL_NAMES]
  const report = probeToolVisibility(deps({
    service: { ok: true },
    ...everything(all),
    // 会话层什么都看不见（例如群预设做了 restrict）。
    session: () => undefined,
    agents: () => [{ room: 'group-1000000003', agent: {} }, { room: 'dm-1000000002', agent: {} }],
  }))
  assert.equal(report.sessions.length, 2)
  assert.equal(report.sessions[0]?.expression.expression_reply, 'no')
  assert.match(report.hint, /group-1000000003/)
  assert.match(report.hint, /dm-1000000002/)
})

test('发送器不可见：结论指向 tool-not-visible（图库那边看不出来的那种失败）', () => {
  const report = probeToolVisibility(deps({
    service: { ok: true },
    global: (name: string) => (EXPRESSION_TOOL_NAMES.includes(name) ? { name } : undefined),
  }))
  for (const name of SENDER_TOOL_NAMES) assert.equal(report.sender[name], 'no')
  assert.match(report.hint, /tool-not-visible/)
})

test('读不出来是 unknown，不是 no：没有 tools.get 时不许下判断', () => {
  const throwing = () => {
    throw new Error('no tools service')
  }
  const report = probeToolVisibility(deps({ service: { ok: true }, global: throwing }))
  for (const name of EXPRESSION_TOOL_NAMES) assert.equal(report.registered[name], 'unknown')
  assert.match(report.hint, /读不出来/)

  // serviceOf 抛错同样只影响 module 这一层。
  const badService = probeToolVisibility({
    serviceOf: () => {
      throw new Error('ctx exploded')
    },
    getGlobal: () => undefined,
    agents: () => [],
  })
  assert.equal(badService.module, 'unknown')
})

test('部分工具缺：结论点名缺的是哪几个，不笼统说「都不可用」', () => {
  const present = EXPRESSION_TOOL_NAMES.filter(name => name !== 'expression_sticker_note')
  const report = probeToolVisibility(deps({
    service: { ok: true },
    global: (name: string) => (present.includes(name) ? { name } : undefined),
  }))
  assert.equal(report.registered.expression_sticker_note, 'no')
  assert.match(report.hint, /expression_sticker_note/)
})

test('会话最多探测 12 个（后台刷新不能被会话数量拖死）', () => {
  const all = [...EXPRESSION_TOOL_NAMES, ...SENDER_TOOL_NAMES]
  const report = probeToolVisibility(deps({
    service: { ok: true },
    ...everything(all),
    agents: () => Array.from({ length: 40 }, (_, index) => ({ room: `group-${1000 + index}`, agent: {} })),
  }))
  assert.equal(report.sessions.length, 12)
})

test('agents() 抛错只是没有会话，不让整份诊断失败', () => {
  const all = [...EXPRESSION_TOOL_NAMES, ...SENDER_TOOL_NAMES]
  const report = probeToolVisibility(deps({
    service: { ok: true },
    ...everything(all),
    agents: () => {
      throw new Error('registry gone')
    },
  }))
  assert.deepEqual(report.sessions, [])
  assert.equal(report.module, 'yes')
})

test('私聊与群聊两个会话都看得见：没有一个会话被落下', () => {
  const all = [...EXPRESSION_TOOL_NAMES, ...SENDER_TOOL_NAMES]
  const rooms = ['dm-1000000002', 'group-1000000003']
  const report = probeToolVisibility(deps({
    service: { ok: true },
    ...everything(all),
    agents: () => rooms.map(room => ({ room, agent: { room } })),
  }))
  assert.equal(report.sessions.length, 2)
  for (const session of report.sessions) {
    for (const name of EXPRESSION_TOOL_NAMES) {
      assert.equal(session.expression[name], 'yes', `${session.room} 必须看得见 ${name}`)
    }
    for (const name of SENDER_TOOL_NAMES) {
      assert.equal(session.sender[name], 'yes', `${session.room} 必须看得见发送器 ${name}`)
    }
  }
  assert.match(report.hint, /三层都可见/)
})

test('输出里不带任何凭据形状的字段（工具名之外只有三态）', () => {
  const all = [...EXPRESSION_TOOL_NAMES, ...SENDER_TOOL_NAMES]
  const report = probeToolVisibility(deps({ service: { ok: true }, ...everything(all) }))
  const text = JSON.stringify(report)
  assert.equal(/https?:\/\//.test(text), false)
  assert.equal(/token|secret|password/i.test(text), false)
  for (const value of Object.values(report.registered)) assert.ok(['yes', 'no', 'unknown'].includes(value))
})
