/**
 * 端到端离线测试：假 SSE 源 → 镜像 → 假 OneBot WS → 假测试客户端。
 *
 * 这条链路里**没有** NapCat、没有 QQ、没有任何真实网络对端。它要证明的是：
 * 事件能从"上游推过来"一路走到"测试客户端收到"，而且这一路上：
 *
 *   - 白名单外的群、私聊、坏帧都进不来；
 *   - 重连之后旧消息不会再来一遍；
 *   - 测试客户端发动作会被拒且计数。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'
import WebSocket from 'ws'

import { normalizeMirrorConfig } from '../src/config.mjs'
import { createMirror } from '../src/mirror.mjs'

const GROUP = 145326153
const OTHER = 900000001
const SOURCE_TOKEN = 'source-token-for-tests'
const FAKE_TOKEN = 'fake-ws-token-for-tests'

/**
 * 极简假 SSE 源：连上就把 frames 按顺序推出去，然后保持连接。
 *
 * **端口由系统分配**（`listen(0)`），不是写死的 31492。写死端口意味着这一组 e2e 会被同机任何
 * 一个占着 31492/31493 的进程整组打红——`verify` 把 tools 的测试并进发布闸门之后，一个巧合的
 * 端口冲突就会变成"发布不通过"。回环地址 + 随机端口是同样真实的本地链路，但没有这个脆弱点。
 */
function fakeSseServer() {
  const clients = new Set()
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '')
    if (auth !== 'Bearer ' + SOURCE_TOKEN) {
      res.writeHead(403).end('forbidden')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.flushHeaders?.()
    clients.add(res)
    req.on('close', () => clients.delete(res))
  })
  return {
    server,
    port: 0,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          this.port = server.address().port
          resolve(this.port)
        })
      })
    },
    close: () => {
      for (const res of clients) { try { res.end() } catch { /* 已断 */ } }
      clients.clear()
      return new Promise((resolve) => server.close(resolve))
    },
    /**
     * 只断开**已建立的连接**，服务端继续监听同一个端口。
     *
     * 重连用例需要的是"上游链路断了"，不是"上游换了地址"：把监听也关掉会让镜像对着一个
     * 已经不存在的端口重连，而那测的就不是重连了。
     */
    drop: () => {
      const dropped = clients.size
      for (const res of clients) { try { res.destroy() } catch { /* 已断 */ } }
      clients.clear()
      return dropped
    },
    push: (event) => {
      for (const res of clients) res.write('data: ' + JSON.stringify(event) + '\n\n')
    },
    get clients() { return clients.size },
  }
}

function groupEvent(over = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    time: 1_700_000_000,
    self_id: 10000001,
    group_id: GROUP,
    user_id: 20_001,
    message_id: 7001,
    message: [{ type: 'text', data: { text: '今晚谁在线' } }],
    raw_message: '今晚谁在线',
    ...over,
  }
}

let sse
let mirror
let client
/** 客户端收到的事件（每个用例前清空）。必须在连上之后注册监听，否则拿到的是空数组。 */
const received = []

before(async () => {
  sse = fakeSseServer()
  await sse.listen()
  const config = normalizeMirrorConfig(
    {
      enabled: true,
      sourceUrl: 'http://127.0.0.1:' + sse.port + '/_events',
      sourceTokenEnv: 'S',
      allowedGroups: [GROUP],
      // 0 = 系统分配（见 config.mjs 的说明）；真实端口在 start() 之后再读回来。
      fakeOneBotPort: 0,
      fakeOneBotTokenEnv: 'F',
      maxQueueEntries: 5,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
    },
    { S: SOURCE_TOKEN, F: FAKE_TOKEN },
  )
  mirror = createMirror({ config })
  await mirror.start()

  // 等 SSE 连上
  for (let i = 0; i < 100 && mirror.source.stats.connects === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(mirror.source.stats.connects, 1, '镜像应该已经连上假 SSE 源')

  // 假测试客户端（模拟测试 DSH 的 OneBotClient）；端口是刚绑定到的那个，不是常量。
  const wsPort = mirror.ws.address()?.port ?? mirror.ws.port
  assert.equal(Number.isInteger(wsPort) && wsPort > 0, true, '假 WS 必须报出真实端口')
  client = new WebSocket('ws://127.0.0.1:' + wsPort + '/', { headers: { Authorization: 'Bearer ' + FAKE_TOKEN } })
  client.on('message', (data) => { try { received.push(JSON.parse(String(data))) } catch { /* 坏帧 */ } })
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
})

after(async () => {
  try { client?.close() } catch { /* 已断 */ }
  await mirror?.stop()
  await sse?.close()
})


test('端到端：白名单群的群消息能一路走到测试客户端', async () => {
  received.length = 0
  sse.push(groupEvent())
  for (let i = 0; i < 100 && received.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20))
  assert.equal(received.length, 1)
  assert.equal(received[0].group_id, GROUP)
  assert.equal(received[0].message_id, 7001)
  assert.equal(mirror.stats.delivered, 1)
})

test('端到端：其它群与私聊一条都进不来', async () => {
  const before = mirror.stats.delivered
  received.length = 0
  sse.push(groupEvent({ group_id: OTHER, message_id: 8001 }))
  sse.push(groupEvent({ message_type: 'private', message_id: 8002 }))
  sse.push({ post_type: 'notice', notice_type: 'group_recall', group_id: GROUP })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(received.length, 0, '非白名单 / 私聊 / 通知都不该到客户端')
  assert.equal(mirror.stats.delivered, before)
  assert.equal(mirror.stats.rejected.group, 1)
  assert.equal(mirror.stats.rejected.type, 2)
})

test('端到端：同一条消息号重复推送只投递一次', async () => {
  const before = mirror.stats.delivered
  received.length = 0
  sse.push(groupEvent({ message_id: 9001 }))
  sse.push(groupEvent({ message_id: 9001 }))
  for (let i = 0; i < 100 && received.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(received.length, 1)
  assert.equal(mirror.stats.delivered, before + 1)
  assert.ok(mirror.stats.duplicates >= 1)
})

test('端到端：坏 JSON 不崩、不投递', async () => {
  const before = mirror.stats.delivered
  received.length = 0
  // 直接写一帧坏数据（走假 SSE 的底层）
  sse.push({ __raw: true })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(mirror.stats.delivered, before)
})

test('端到端：测试客户端发 send_group_msg 被拒，且计为越权尝试', async () => {
  const before = mirror.ws.stats.forbiddenActionAttempts
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等回执超时')), 3000)
    client.once('message', (data) => { clearTimeout(timer); resolve(JSON.parse(String(data))) })
    client.send(JSON.stringify({ action: 'send_group_msg', params: { group_id: GROUP, message: 'x' }, echo: 'probe-1' }))
  })
  assert.equal(reply.status, 'failed')
  assert.equal(reply.data, null)
  assert.equal(reply.echo, 'probe-1')
  assert.equal(mirror.ws.stats.forbiddenActionAttempts, before + 1)
  assert.equal(mirror.ws.stats.lastForbidden.action, 'send_group_msg')
})

test('端到端：SSE 断开后自行重连，旧消息不会补发', async () => {
  const connectsBefore = mirror.source.stats.connects
  // 踢掉已建立的 SSE 连接，模拟上游断链；**源仍在同一端口监听**（端口是系统分配的，
  // 关掉监听再换一个新端口就不是"重连"了）。
  const dropped = sse.drop()
  assert.equal(dropped >= 1, true, '这一拍必须真的断开了一条已建立的连接')
  for (let i = 0; i < 200 && mirror.source.stats.connects <= connectsBefore; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.ok(mirror.source.stats.connects > connectsBefore, '镜像应该自己重连了')
  // 重连之后把之前那条 9001 再推一次：去重表还没过期，不该再投递
  const before = mirror.stats.delivered
  received.length = 0
  sse.push(groupEvent({ message_id: 9001 }))
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(received.length, 0, '重连不能回放已处理过的消息')
  assert.equal(mirror.stats.delivered, before)
})
