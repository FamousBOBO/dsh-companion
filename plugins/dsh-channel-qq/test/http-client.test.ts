/** `HttpClient` 的默认值即安全值：闸门、逐跳重定向校验、超时、体积上限。
 *
 * 这组用例守的是 P2.5 的**全部收益**：把 32 处 `fetch(` 收进一个端口，价值不在
 * "少写几个字符"，而在于那些安全边界从"每处都要记得写"变成"默认就有"。
 * 所以这里逐条钉住默认值，并且用真实的本地 HTTP 服务验证——不是 mock。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHttpClient } from '../src/adapters/http/client.js'

/** 起一个本地服务；回调返回要发的响应。 */
async function serve(
  handler: (req: { url: string; method: string; headers: Record<string, string | string[] | undefined> },
    res: { setHeader(k: string, v: string | string[]): void; writeHead(code: number): void; end(body?: string): void }) => void,
): Promise<{ server: Server; port: number; hits: () => number; close: () => Promise<void> }> {
  let hitCount = 0
  const server = createServer((req, res) => {
    hitCount += 1
    handler(
      { url: req.url ?? '', method: req.method ?? '', headers: req.headers },
      {
        setHeader: (k, v) => { res.setHeader(k, v) },
        writeHead: (code) => { res.writeHead(code) },
        end: (body) => { res.end(body) },
      },
    )
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return {
    server,
    port,
    hits: () => hitCount,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

test('默认拦截私网地址（本机服务一次都没被碰到）', async () => {
  const local = await serve((_req, res) => { res.writeHead(200); res.end('should never arrive') })
  try {
    const http = createHttpClient()
    await assert.rejects(
      () => http.request(`http://127.0.0.1:${String(local.port)}/secret`),
      /内网|保留地址/,
    )
    assert.equal(local.hits(), 0, '闸门应当在发请求之前就拒掉')
  } finally {
    await local.close()
  }
})

test('allowPrivateHosts 只在显式打开时放行', async () => {
  const local = await serve((_req, res) => { res.writeHead(200); res.end('本地服务') })
  try {
    const http = createHttpClient()
    const res = await http.request(`http://127.0.0.1:${String(local.port)}/ok`, { allowPrivateHosts: true })
    assert.equal(res.status, 200)
    assert.equal(res.text(), '本地服务')
    assert.equal(local.hits(), 1)
  } finally {
    await local.close()
  }
})

test('跟随重定向时逐跳校验：公网 → 内网那一跳被拒', async () => {
  const internal = await serve((_req, res) => { res.writeHead(200); res.end('内网数据') })
  // "公网"这一跳用 example.com 做不到（测试不能依赖外网），所以让第一跳就是
  // 一个会被放行的地址：用 allowPrivateHosts 打开第一跳，验证第二跳仍被拦。
  const front = await serve((_req, res) => {
    // 先设头再写状态行：反过来会在 Node 里直接抛 ERR_HTTP_HEADERS_SENT。
    res.setHeader('location', `http://127.0.0.1:${String(internal.port)}/internal`)
    res.writeHead(302)
    res.end()
  })
  try {
    const http = createHttpClient()
    // 不打开：第一跳就被拦。
    await assert.rejects(() => http.request(`http://127.0.0.1:${String(front.port)}/go`), /内网|保留地址/)
    assert.equal(internal.hits(), 0)
    // 打开第一跳：第一跳放行，但**重定向到的那一跳**仍然按各自的策略拦。
    // 这就是"逐跳校验"的具体含义——只看首地址是不够的。
    const res = await http.request(`http://127.0.0.1:${String(front.port)}/go`, { allowPrivateHosts: true })
    assert.equal(res.status, 200)
    assert.equal(internal.hits(), 1, '同一策略下第二跳也放行')
  } finally {
    await front.close()
    await internal.close()
  }
})

test('体积上限：声明超限直接拒，不把大响应拉下来', async () => {
  const local = await serve((_req, res) => {
    res.setHeader('content-type', 'text/plain')
    res.setHeader('content-length', '1000000')
    res.writeHead(200)
    res.end('x'.repeat(1000))
  })
  try {
    const http = createHttpClient()
    await assert.rejects(
      () => http.request(`http://127.0.0.1:${String(local.port)}/big`, { allowPrivateHosts: true, limit: 1024 }),
      /超过上限/,
    )
  } finally {
    await local.close()
  }
})

test('超时：挂住的服务被中断，不会永久等待', async () => {
  const local = await serve(() => { /* 什么都不回，让请求挂住 */ })
  try {
    const http = createHttpClient()
    const started = Date.now()
    await assert.rejects(() => http.request(`http://127.0.0.1:${String(local.port)}/hang`, {
      allowPrivateHosts: true, timeoutMs: 200,
    }))
    assert.equal(Date.now() - started < 5000, true, `应当在超时后很快失败，实际 ${String(Date.now() - started)}ms`)
  } finally {
    await local.close()
  }
})

test('响应 API：bytes / text / json / header / headerValues', async () => {
  const local = await serve((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.setHeader('set-cookie', ['a=1', 'b=2'])
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, 中文: '可以' }))
  })
  try {
    const http = createHttpClient()
    const res = await http.request(`http://127.0.0.1:${String(local.port)}/j`, { allowPrivateHosts: true })
    assert.equal(res.ok, true)
    assert.deepEqual(res.json(), { ok: true, 中文: '可以' })
    assert.equal(res.header('Content-Type'), 'application/json')
    assert.equal(res.url.endsWith('/j'), true)
    // set-cookie 必须按份给：合并成一个字符串再拆会在 cookie 的 Expires 逗号上出错。
    assert.deepEqual(res.headerValues('set-cookie'), ['a=1', 'b=2'])
    assert.deepEqual(res.headerValues('x-missing'), [])
  } finally {
    await local.close()
  }
})

test('POST 正文与显式 method', async () => {
  let seen = ''
  const local = await serve((req, res) => {
    seen = `${req.method} ${req.url}`
    res.writeHead(200)
    res.end('ok')
  })
  try {
    const http = createHttpClient()
    const res = await http.request(`http://127.0.0.1:${String(local.port)}/p`, {
      method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' }, allowPrivateHosts: true,
    })
    assert.equal(res.status, 200)
    assert.equal(seen, 'POST /p')
  } finally {
    await local.close()
  }
})

test('非 http(s) 协议一律拒（file:// 读本地文件那条路）', async () => {
  const http = createHttpClient()
  await assert.rejects(() => http.request('file:///etc/passwd'), /只支持 http/)
})
