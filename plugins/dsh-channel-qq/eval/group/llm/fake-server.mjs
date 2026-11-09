/**
 * **本地假 OpenAI 服务**（只给 `--selftest` 用；监听 127.0.0.1，绝不联网）。
 *
 * 它存在的理由不是"省一次模型调用"，而是**证明整条通道真的跑通了**：
 * 提示词真的被发到 http 上、响应真的被解析、整份语料真的走完了
 * `runPresenceCycle` → `parseSocialDecision` → `validateSocialDecision`。用假补全端口
 * （离线的 `fakeComplete`）可以证明解析，但证明不了"这条 URL 真的能通"。
 *
 * 响应形状与 OpenAI `/chat/completions` 一致（`choices[0].message.content` + `usage`），
 * 并按请求序号轮换几种**已知**形态，好让自测覆盖到三档：
 *   reply（目标取提示词里最后一条真实消息号）/ silent / 坏 JSON / 编造的号 / observe / 数组。
 * 轮换是**假模型的设定**，不是判定：谁对谁错仍然由生产解析器说了算。
 */

import { createServer } from 'node:http'

/** 假服务的几种模式（自测里用来验证错误码路径）。 */
export const FAKE_MODES = Object.freeze(['mixed', 'unauthorized', 'garbage'])

/** 从提示词里取最后一条 `[消息 <号>]`，让 reply 的目标是个真实存在过的号。 */
export function lastMessageIdOf(prompt) {
  const found = [...String(prompt ?? '').matchAll(/\[消息 (\d+)\]/g)]
  if (found.length === 0) return null
  const last = found[found.length - 1]
  return last === undefined ? null : Number(last[1])
}

/** 按序号给出"模型输出"（自测用；轮换六种形态）。 */
export function fakeReplyAt(index, prompt) {
  const target = lastMessageIdOf(prompt)
  const pool = [
    () => (target === null
      ? { content: '{"action":"silent","reason":"自测：没有可用目标"}' }
      : { content: `{"action":"reply","targetMessageId":${String(target)},"text":"自测：接到最后一条上","reason":"自测 reply"}` }),
    () => ({ content: '{"action":"silent","reason":"自测：沉默"}' }),
    () => ({ content: '{"action": "reply", "targetMessageId": ' }),
    () => ({ content: '{"action":"reply","targetMessageId":999999,"text":"自测：编造的目标号","reason":"自测 bad-target"}' }),
    () => ({ content: '{"action":"observe","topic":"自测话题","reason":"自测 observe"}' }),
    () => ({ content: '[{"action":"reply","targetMessageId":1,"text":"数组不该被接受"}]' }),
  ]
  return pool[index % pool.length]()
}

/**
 * 起一个假服务。
 *
 * @param {object} [options]
 * @param {number} [options.port] 0 = 让系统分配（自测用 0，避免撞端口）
 * @param {'mixed'|'unauthorized'|'garbage'} [options.mode]
 * @returns {Promise<{url: string, origin: string, requests: object[], close: () => Promise<void>}>}
 */
export async function startFakeServer({ port = 0, mode = 'mixed' } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body })
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (mode === 'unauthorized') {
        send(401, { error: { message: 'fake: unauthorized' } })
        return
      }
      if (mode === 'garbage') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('not json at all')
        return
      }
      if (!String(req.url ?? '').endsWith('/chat/completions')) {
        send(404, { error: { message: 'fake: unknown path' } })
        return
      }
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        send(400, { error: { message: 'fake: bad request body' } })
        return
      }
      const prompt = parsed?.messages?.[0]?.content ?? ''
      const reply = fakeReplyAt(requests.length - 1, prompt)
      send(200, {
        id: `fake-${String(requests.length)}`,
        object: 'chat.completion',
        model: parsed?.model ?? 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: reply.content }, finish_reason: 'stop' }],
        // usage 故意给两种叫法中的一种（真实端点两种都有），用来验证 `usageOf` 的兼容。
        usage: { prompt_tokens: 100 + requests.length, completion_tokens: 20, total_tokens: 120 + requests.length },
      })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    url: `http://127.0.0.1:${String(actualPort)}/v1`,
    origin: `http://127.0.0.1:${String(actualPort)}`,
    requests,
    close: () => new Promise((resolve) => { server.close(() => resolve(undefined)) }),
  }
}

/** `--serve` 模式：起服务、把地址打到 stdout、等被 kill（自测用子进程，见 run.mjs）。 */
export async function serveForever({ port = 0, mode = 'mixed' } = {}) {
  const server = await startFakeServer({ port, mode })
  // 父进程按这一行取地址（只有一行 JSON，别加日志噪声）。
  console.log(JSON.stringify({ url: server.url, mode }))
  await new Promise(() => {})
}
