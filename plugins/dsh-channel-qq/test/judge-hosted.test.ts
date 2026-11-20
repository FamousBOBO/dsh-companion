/** 云端 Jev 判断的协议与端口：**用假 HttpClient**，不打真网络。
 *
 * 为什么假 HTTP 而不打真端点：真端点要钱、要网络、还会抖。这里要钉的是
 * **我们自己的形状**——请求体键名、UA、答案读取规则、错误分类、成本记账。
 * 真端点上的实测数字在 `docs/groups/jev-opencode-backend.md` 里。
 *
 * 五条断言各挡一个真实会发生的错：
 *   1. 请求体里**没有** `messages`（Jev 不是聊天模型，发错会被 400 挡）；
 *   2. `User-Agent` 必须带自定义值（空 UA 会被 Cloudflare 挡 1010，且错误体无提示）；
 *   3. `choice` 用 `max(probabilities)` 而**不是** `confidence`（实测前者更大，
 *      用后者会让 `phraseMinProbability` 门槛系统性收紧）；
 *   4. 401/429/5xx/超时 → `no-route`（不累积失败），400/形状错 → `invalid`（累积）；
 *   5. 每次成功都进成本账本（否则"一个月多少钱"永远算不出来）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHostedJudge } from '../src/adapters/jev/hosted-judge.js'
import { answersOf, buildQuestions, targetIdsOf, usageOf } from '../src/adapters/jev/hosted-protocol.js'
import type { HttpClient, HttpOptions, HttpResponse } from '../src/ports/http.js'
import type { JudgeLine } from '../src/app/inbound/judge-port.js'

const GATES = ['tech_issue', 'help_open', 'one_to_one', 'conflict', 'privacy'] as const
const SCENES = ['tech'] as const
const NOW = 1_792_000_000_000

/** 一行旁听（发送者不是我）。 */
function line(id: number, text: string, self = false): JudgeLine {
  return { messageId: id, name: '', userId: 10001, text, self, atMs: NOW - 60_000 }
}

/** 一次判断的入参。 */
function request(lines: readonly JudgeLine[]) {
  return {
    groupId: 4,
    lines,
    state: 'State:\n[消息 1] [成员 uid 10001] [时间 20:41] 报错了\n现在是 20:45。',
    nowMs: NOW,
    replyMaxChars: 70,
    windowMs: 600_000,
  }
}

/** 假 HttpClient：记录每次调用，返回预设响应。 */
function fakeHttp(responses: Array<{ status: number; body: string }>): HttpClient & { calls: HttpOptions[] } {
  const calls: HttpOptions[] = []
  let index = 0
  return {
    calls,
    async request(_url: string, options: HttpOptions = {}): Promise<HttpResponse> {
      calls.push(options)
      const pick = responses[Math.min(index, responses.length - 1)] ?? { status: 500, body: '' }
      index += 1
      const bytes = new TextEncoder().encode(pick.body)
      return {
        status: pick.status,
        ok: pick.status >= 200 && pick.status < 300,
        url: 'https://example.invalid',
        bytes,
        truncated: false,
        header: () => null,
        headerValues: () => [],
        text: () => pick.body,
        json: <T = unknown>(): T => JSON.parse(pick.body) as T,
      }
    },
  }
}

/** 一份正常的云端回复（九门全 false、tech 库选 ask_more、目标选第 2 条）。 */
function replyBody(): string {
  return JSON.stringify({
    model: 'jev-1.13',
    answers: {
      tech_issue: { type: 'noul', noul: 0.98 },
      help_open: { type: 'noul', noul: 0.89 },
      one_to_one: { type: 'noul', noul: 0.03 },
      conflict: { type: 'noul', noul: 0.02 },
      privacy: { type: 'noul', noul: 0.10 },
      'phrase:tech': {
        type: 'choice',
        choice: 'me_too',
        confidence: 0.51,
        probabilities: { me_too: 0.63, ask_more: 0.21, try_this: 0.10, same_here: 0.06 },
      },
      target: { type: 'choice', choice: '9102', confidence: 0.18, probabilities: { '9101': 0.41, '9102': 0.59 } },
    },
    usage: {
      input_tokens: 932,
      output_tokens: 213,
      cost: 0.00003914,
      opencode: { billing_source: 'balance', list_cost: 0.00003914 },
    },
  })
}

/** 造一个端口（key 固定给值）。 */
function judgeOn(http: HttpClient & { calls: HttpOptions[] }, onUsage?: (usage: { costUsd: number }) => void) {
  return createHostedJudge({
    http,
    endpoint: 'https://opencode.ai/inference/systemone/v1/systemone',
    model: 'jev-1.13',
    apiKey: async () => 'sk-test',
    userAgent: 'dsh-companion/jev-opencode',
    timeoutMs: 8000,
    log: () => {},
    gates: [...GATES],
    scenes: [...SCENES],
    limits: { phraseMinProbability: 0.3, replyMaxChars: 70, windowMs: 600_000 },
    targetWindow: 6,
    onUsage: (usage) => onUsage?.(usage),
  })
}

test('请求体：只有 model/state/questions，没有 messages；UA 是自定义值', async () => {
  const http = fakeHttp([{ status: 200, body: replyBody() }])
  await judgeOn(http).decide(request([line(9101, '报错了'), line(9102, '看日志')]))
  const sent = http.calls[0]
  assert.ok(sent !== undefined, '一次请求都没发出去')
  const body = JSON.parse(String(sent.body)) as Record<string, unknown>
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state'])
  assert.equal(body['model'], 'jev-1.13')
  // Jev 不是聊天模型：带 `messages` 会被 400 `ModelProtocolUnsupported` 挡回。
  assert.equal(body['messages'], undefined)
  const headers = sent.headers ?? {}
  assert.equal(headers['user-agent'], 'dsh-companion/jev-opencode', 'UA 必须自定义（空 UA 会被 1010 挡）')
  assert.equal(headers['Authorization'], 'Bearer sk-test')
})

test('问句：九门 noul + 短语 choice + 目标 choice（目标选项名是消息号）', async () => {
  const http = fakeHttp([{ status: 200, body: replyBody() }])
  await judgeOn(http).decide(request([line(9101, 'a'), line(9102, 'b')]))
  const body = JSON.parse(String(http.calls[0]?.body)) as { questions: Record<string, unknown> }
  const questions = body.questions as Record<string, { type?: string }>
  assert.deepEqual(Object.keys(questions).sort(), [
    'conflict', 'help_open', 'one_to_one', 'phrase:tech', 'privacy', 'target', 'tech_issue',
  ])
  const target = questions['target'] as { type: string; criteria: Record<string, unknown> }
  assert.equal(target.type, 'choice')
  assert.deepEqual(Object.keys(target.criteria).sort(), ['9101', '9102'])
})

test('答案解析：choice 用 max(probabilities) 而不是 confidence', async () => {
  const http = fakeHttp([{ status: 200, body: replyBody() }])
  const verdict = await judgeOn(http).decide(request([line(9101, 'a'), line(9102, 'b')]))
  // 九门里 tech_issue 与 help_open 都是 true，决策表给 `reply`（有人问了还没人答）。
  assert.equal(verdict.kind, 'decision')
  if (verdict.kind !== 'decision') return
  assert.equal(verdict.action, 'reply')
  assert.equal(verdict.text, '我也踩过这个坑')
  // confidence 是 0.51，max(probabilities) 是 0.63 —— 折判按后者判断门槛，所以这一轮过了。
  assert.equal(verdict.targetMessageId, 9102)
})

test('答案解析：confidence 低于门槛但 max(probabilities) 高于门槛时仍然说话', async () => {
  const shape = { gates: [...GATES], scenes: [...SCENES], targets: [9101, 9102] }
  const payload = {
    answers: {
      phrase: undefined,
      'phrase:tech': {
        type: 'choice',
        choice: 'me_too',
        // 故意的：confidence 0.28 < 门槛 0.3，但最高概率 0.42 >= 0.3。
        confidence: 0.28,
        probabilities: { me_too: 0.42, ask_more: 0.3, try_this: 0.2, same_here: 0.08 },
      },
    },
  }
  const answers = answersOf(payload, shape)
  assert.ok(answers !== null)
  assert.equal(answers.phrases.tech?.topProbability, 0.42, '必须取 max(probabilities)（0.42），不是 confidence（0.28）')
})

test('答案解析：形状不对返回 null（调用方折成 invalid:shape）', () => {
  const shape = { gates: [...GATES], scenes: [...SCENES], targets: [] as number[] }
  assert.equal(answersOf(null, shape), null)
  assert.equal(answersOf({}, shape), null)
  assert.equal(answersOf({ answers: 'nope' }, shape), null)
  // 门缺席**不算**形状错：决策表会把缺席的按 false 处理（保守方向）。
  const partial = answersOf({ answers: { tech_issue: { type: 'noul', noul: 0.9 } } }, shape)
  assert.ok(partial !== null)
  assert.equal(partial.gates.tech_issue?.answer, 'true')
})

test('答案解析：选中的目标不在候选里 → 不给目标（reply 会降级成 react）', () => {
  const shape = { gates: [...GATES], scenes: [...SCENES], targets: [9101, 9102] }
  const answers = answersOf({
    answers: { target: { type: 'choice', choice: '9103', probabilities: { '9101': 0.2, '9102': 0.3 } } },
  }, shape)
  assert.ok(answers !== null)
  assert.equal(answers.target, undefined)
})

test('目标候选：排除她自己发的与合成消息', () => {
  // 合成消息的判据是 `messageId === null`（见 `judge-port.ts` 的 `JudgeLine` 注释），
  // 不是 0——0 在某些平台上是合法号。所以这里用 null，与 `candidateTargets` 同口径。
  const synthetic: JudgeLine = { ...line(9101, 'c'), messageId: null }
  const lines = [line(9101, 'a'), line(9102, 'b', true), synthetic]
  const ids = targetIdsOf(request(lines), 6)
  assert.deepEqual(ids, [9101], '自己发的与合成的（messageId null）都不许当引用目标')
})

test('错误分类：401/403/429/500 → no-route（不累积失败）', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const http = fakeHttp([{ status, body: '{"error":{"type":"x"}}' }])
    const verdict = await judgeOn(http).decide(request([line(9101, 'a')]))
    assert.equal(verdict.kind, 'no-route', `${String(status)} 应当按"这一轮没判"处理，不是判错`)
  }
})

test('错误分类：400 与坏 JSON → invalid（要修配置或代码）', async () => {
  const http = fakeHttp([{ status: 400, body: '{"detail":{"error_type":"api_usage_error"}}' }])
  const verdict = await judgeOn(http).decide(request([line(9101, 'a')]))
  assert.equal(verdict.kind, 'invalid')
  if (verdict.kind === 'invalid') assert.match(verdict.reason, /bad-request|api_usage_error/)

  const http2 = fakeHttp([{ status: 200, body: 'not json' }])
  const verdict2 = await judgeOn(http2).decide(request([line(9101, 'a')]))
  assert.equal(verdict2.kind, 'invalid')
})

test('错误分类：传输层抛错 → no-route（含超时）', async () => {
  const failing: HttpClient = {
    async request(): Promise<HttpResponse> {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    },
  }
  const verdict = await judgeOn(failing as HttpClient & { calls: HttpOptions[] }).decide(request([line(9101, 'a')]))
  assert.equal(verdict.kind, 'no-route')
  if (verdict.kind === 'no-route') assert.match(verdict.detail, /transport/)
})

test('凭据缺失 → no-route，且一次网络都不发', async () => {
  const http = fakeHttp([{ status: 200, body: replyBody() }])
  const port = createHostedJudge({
    http,
    endpoint: 'https://example.invalid',
    model: 'jev-1.13',
    apiKey: async () => null,
    userAgent: 'ua',
    timeoutMs: 8000,
    log: () => {},
    gates: [...GATES],
    scenes: [...SCENES],
    limits: { phraseMinProbability: 0.3, replyMaxChars: 70, windowMs: 600_000 },
    targetWindow: 6,
  })
  const verdict = await port.decide(request([line(9101, 'a')]))
  assert.equal(verdict.kind, 'no-route')
  assert.equal(http.calls.length, 0, '没 key 就不该发请求（那会白挨一次 401）')
})

test('成本账本：每次成功都回调 onUsage，字段取自 usage', async () => {
  const http = fakeHttp([{ status: 200, body: replyBody() }])
  const seen: number[] = []
  await judgeOn(http, (usage) => seen.push(usage.costUsd)).decide(request([line(9101, 'a')]))
  assert.deepEqual(seen, [0.00003914])
  const usage = usageOf(JSON.parse(replyBody()))
  assert.equal(usage.inputTokens, 932)
  assert.equal(usage.billing, 'balance')
})

test('buildQuestions：没有候选目标时不发 target 问句', () => {
  const questions = buildQuestions({ gates: [...GATES], scenes: [...SCENES], targets: [] })
  assert.equal(Object.prototype.hasOwnProperty.call(questions, 'target'), false,
    '没有候选时问"回应哪一条"等于让对端在空集合里选，会拿到垃圾答案')
})
