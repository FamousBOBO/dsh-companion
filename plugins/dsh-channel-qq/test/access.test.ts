/** 访问门控（安全）：配对审批、白名单、管理员豁免、冷却与持久化。
 *
 * 防的是"没批准就进 agent"和"陌生人每发一句就刷屏主人"：第一次只通知一次，
 * 同一请求者冷却期内只回一句。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { AccessStore } = await import('../src/features/access/store.js')
const { AccessService } = await import('../src/features/access/service.js')
const { parseAccessCommand, renderPending, maybeHandleAccessCommand } = await import('../src/features/access/commands.js')

const OWNER = 280
const STRANGER = 999
const GROUP = 107

/** 等一个条件成立（IO 在慢盘上可能比 15ms 慢；固定 sleep 会抖）。 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

function harness(mode: 'pairing' | 'allowlist' | 'open' = 'pairing', overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'access-'))
  const store = new AccessStore(path.join(dir, 'access.json'), () => {})
  const sent: Array<{ kind: 'user' | 'group'; id: number; text: string }> = []
  let now = 1_000_000
  const config = {
    mode,
    groupPolicy: 'pairing' as 'pairing' | 'member' | 'allowlist',
    allowUsers: [] as number[],
    allowGroups: [] as number[],
    notifyOwner: true,
    replyCooldownMin: 30,
    replyPendingInGroups: false,
      friendRequests: false,
    ...overrides,
  }
  const root = {
    ...config,
    requireMention: true,
    keywordTriggers: [] as string[],
    primaryGroup: 107,
    talkValue: 0.6,
    primaryTalkValue: null,
  }
  const service = new AccessService({
    api: () => ({
      sendPrivateMessage: async (id: number, message: Array<{ data: { text: string } }>) => {
        sent.push({ kind: 'user', id, text: message[0]!.data.text })
        return { message_id: sent.length }
      },
      sendGroupMessage: async (id: number, message: Array<{ data: { text: string } }>) => {
        sent.push({ kind: 'group', id, text: message[0]!.data.text })
        return { message_id: sent.length }
      },
      getGroupInfo: async () => ({ group_id: 107, group_name: '测试群' }),
    }) as never,
    out: () => ({ push: async (task: () => Promise<unknown>) => await task() }) as never,
    persona: () => ({ render: (key: string) => `[${key}]` }) as never,
    config: () => config,
    rootConfig: () => root as never,
    admins: () => [OWNER],
    store,
    now: () => now,
    log: () => {},
  })
  return {
    dir,
    store,
    service,
    config,
    sent,
    advance(ms: number) { now += ms },
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

const dm = (userId = STRANGER) => ({
  time: 0, self_id: 1, post_type: 'message', message_type: 'private', message_id: 1, user_id: userId,
  sender: { user_id: userId, nickname: '陌生人' },
}) as never

const group = (groupId = GROUP) => ({
  time: 0, self_id: 1, post_type: 'message', message_type: 'group', message_id: 2, user_id: STRANGER,
  group_id: groupId, sender: { user_id: STRANGER, nickname: '群友' },
  message: [{ type: 'text', data: { text: '随便聊聊' } }],
}) as never

/** 群里叫了咱的一条消息（@）。 */
const groupAt = (groupId = GROUP) => ({
  time: 0, self_id: 1, post_type: 'message', message_type: 'group', message_id: 3, user_id: STRANGER,
  group_id: groupId, sender: { user_id: STRANGER, nickname: '群友' },
  message: [{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: ' 在吗' } }],
}) as never

test('门控：open 全部放行；pairing 下管理员与主人私聊放行', async () => {
  const open = harness('open')
  assert.equal(open.service.allow(dm()), true)
  open.cleanup()

  const h = harness('pairing')
  assert.equal(h.service.allow(dm(OWNER)), true, '管理员始终允许')
  assert.equal(h.sent.length, 0)
  h.cleanup()
})

test('门控：陌生私聊 → 不进 agent、记请求、回一句、只通知主人一次', async () => {
  const h = harness()
  assert.equal(h.service.allow(dm()), false)
  await waitFor(() => h.sent.length >= 2)
  assert.equal(h.store.pending().length, 1)
  assert.deepEqual(h.store.pending()[0]?.kind, 'user')
  assert.deepEqual(h.sent.map((m) => `${m.kind}:${m.id}:${m.text}`), [
    `user:${STRANGER}:[access/pending]`,
    `user:${OWNER}:新的访问请求：QQ ${STRANGER}（陌生人）。回复「放行 ${STRANGER}」或在后台「安全」页批准。`,
  ])

  // 冷却期内再来一条：不重复回复、不重复通知
  assert.equal(h.service.allow(dm()), false)
  await wait()
  assert.equal(h.sent.length, 2)

  // 冷却过后：只补一句「待批准」，不再通知主人
  h.advance(31 * 60_000)
  assert.equal(h.service.allow(dm()), false)
  await waitFor(() => h.sent.length >= 3)
  assert.equal(h.sent.at(-1)?.text, '[access/pending]')
  h.cleanup()
})

test('门控：批准后放行并通知对方；拒绝后仍拒绝', async () => {
  const h = harness()
  h.service.allow(dm())
  await waitFor(() => h.store.pending().length === 1)
  await h.service.approve('user', STRANGER)
  assert.equal(h.service.allow(dm()), true)
  assert.equal(h.sent.at(-1)?.text, '[access/approved]')
  assert.equal(h.store.pending().length, 0)

  await h.service.reject('user', 777)
  assert.equal(h.service.allow(dm(777)), false, '被拒绝的仍然要走配对')
  h.cleanup()
})

test('门控：groupPolicy=member 时在群里就放行，不产生待批', async () => {
  const h = harness('pairing', { groupPolicy: 'member' })
  assert.equal(h.service.allow(group()), true)
  await wait()
  assert.equal(h.store.pending().length, 0)
  assert.equal(h.sent.length, 0)
  h.cleanup()
})

test('门控：groupPolicy=allowlist 时未列名单的群直接拒绝、不配对', async () => {
  const h = harness('pairing', { groupPolicy: 'allowlist' })
  assert.equal(h.service.allow(group()), false)
  await wait()
  assert.equal(h.store.pending().length, 0)
  h.cleanup()
})

test('门控：未批准的群里，没人叫咱的消息不建请求、不回话', async () => {
  const h = harness()
  assert.equal(h.service.allow(group()), false)
  await wait()
  assert.equal(h.store.pending().length, 0)
  assert.equal(h.sent.length, 0)
  h.cleanup()
})

test('门控：未批准的群里被 @ → 建请求但默认不在群里回话', async () => {
  const h = harness()
  assert.equal(h.service.allow(groupAt()), false)
  await waitFor(() => h.sent.some((m) => m.id === OWNER))
  assert.equal(h.sent.some((m) => m.kind === 'group'), false, '默认群里安静')
  assert.equal(h.sent.some((m) => m.id === OWNER), true, '主人收到通知')
  h.cleanup()
})

test('门控：打开 replyPendingInGroups 后每个请求只回一次', async () => {
  const h = harness('pairing', { replyPendingInGroups: true })
  assert.equal(h.service.allow(groupAt()), false)
  await waitFor(() => h.sent.some((m) => m.kind === 'group'))
  const count = h.sent.filter((m) => m.kind === 'group').length
  assert.equal(count, 1)
  assert.equal(h.service.allow(groupAt()), false)
  await wait()
  assert.equal(h.sent.filter((m) => m.kind === 'group').length, 1, 'pending 期间不重复回')
  h.cleanup()
})

test('门控：群按房间批准，未批准时整群不触发（带群名）', async () => {
  const h = harness()
  assert.equal(h.service.allow(groupAt()), false)
  await waitFor(() => h.store.pending().length === 1)
  assert.equal(h.store.pending()[0]?.kind, 'group')
  assert.equal(h.store.pending()[0]?.id, GROUP)
  assert.equal(h.store.pending()[0]?.name, '测试群')
  await h.service.approve('group', GROUP)
  assert.equal(h.service.allow(group()), true)
  h.cleanup()
})

test('门控：allowlist 模式不配对、不回复；名单命中才放行', async () => {
  const h = harness('allowlist', { allowUsers: [555], allowGroups: [666] })
  assert.equal(h.service.allow(dm(555)), true)
  assert.equal(h.service.allow(group(666)), true)
  assert.equal(h.service.allow(dm(777)), false)
  await wait()
  assert.equal(h.sent.length, 0)
  assert.equal(h.store.pending().length, 0)
  h.cleanup()
})

test('门控仓库：批准/拒绝落盘，重开能读回', async () => {
  const h = harness()
  await h.service.approve('user', 111)
  await h.service.approve('group', 222)
  await h.store.request('user', 333, 'x', 1)
  const again = new AccessStore(path.join(h.dir, 'access.json'), () => {})
  await again.load()
  assert.deepEqual(again.users(), [111])
  assert.deepEqual(again.groups(), [222])
  assert.equal(again.pending().length, 1)
  h.cleanup()
})


// ── 管理员 QQ 命令 ──────────────────────────────────────────────────────────

test('QQ 命令解析：待批/放行/放行群/拒绝访问/拒绝访问群，其余不认', () => {
  assert.deepEqual(parseAccessCommand('待批访问'), { verb: 'list' })
  assert.deepEqual(parseAccessCommand('/访问请求'), { verb: 'list' })
  assert.deepEqual(parseAccessCommand('放行 999'), { verb: 'approve', kind: 'user', id: 999 })
  assert.deepEqual(parseAccessCommand('放行群 107'), { verb: 'approve', kind: 'group', id: 107 })
  assert.deepEqual(parseAccessCommand('拒绝访问 999'), { verb: 'reject', kind: 'user', id: 999 })
  assert.deepEqual(parseAccessCommand('拒绝访问群 107'), { verb: 'reject', kind: 'group', id: 107 })
  assert.equal(parseAccessCommand('放行'), null, '缺 id')
  assert.equal(parseAccessCommand('批准 999'), null, '不抢审批网关的动词')
  assert.equal(parseAccessCommand('你好'), null)
})

test('QQ 命令：列表带可复制命令；管理员私聊放行后立即生效', async () => {
  const h = harness()
  await h.store.request('user', STRANGER, '陌生人', 1)
  const list = h.service.list()
  const text = renderPending(list)
  assert.match(text, /待批 1 条/)
  assert.match(text, /放行 999/)

  const sent: string[] = []
  const host = {
    config: { admins: [OWNER], access: h.config },
    get: (name: string) => name === 'access' ? h.service : name === 'platform'
      ? {
          api: { sendPrivateMessage: async (_id: number, message: Array<{ data: { text: string } }>) => {
            sent.push(message[0]!.data.text)
            return { message_id: 1 }
          } },
          out: { push: async (task: () => Promise<unknown>) => await task() },
        }
      : undefined,
    log: () => {},
  } as never
  const event = {
    time: 0, self_id: 1, post_type: 'message', message_type: 'private', message_id: 9,
    user_id: OWNER, message: [{ type: 'text', data: { text: '放行 999' } }],
  } as never
  assert.equal(await maybeHandleAccessCommand(host, event), true)
  assert.equal(h.service.allow(dm()), true, '放行后陌生人私聊直接通过')
  assert.match(sent.at(-1) ?? '', /已放行私聊 999/)

  const strangerEvent = {
    time: 0, self_id: 1, post_type: 'message', message_type: 'private', message_id: 10,
    user_id: STRANGER, message: [{ type: 'text', data: { text: '放行 999' } }],
  } as never
  assert.equal(await maybeHandleAccessCommand(host, strangerEvent), false, '非管理员不处理')
  h.cleanup()
})
