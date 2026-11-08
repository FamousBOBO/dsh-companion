/**
 * **两个端口**：真实模型的补全端口（发请求）+ 平台端口的**绊线**（一次都不许真发）。
 *
 * 这个文件里没有任何判定：动作合不合法、目标在不在、限频放不放行，全都由
 * `build/lib/app/inbound/presence-flow.js`（`runPresenceCycle`）与
 * `group-social-decision.js`（`parseSocialDecision` / `validateSocialDecision`）判。
 * 这里只做三件事：
 *
 *   1. 把生产提示词（`request.prompt`）原样投给 OpenAI 兼容端点，取回那一行决策 JSON；
 *   2. **把平台端口变成绊线**：`sendGroupMessage` / `sendPrivateMessage` / `sendTo`（以及任何
 *      以 `send` 开头的方法）一旦被调用，先记一次、再直接抛错。抛错让这次决策变成
 *      `failed`，而记录让运行器把它升级成 HARD FAIL——**零发送不是靠"我们没调"，是靠会炸**；
 *   3. 记下 token、耗时、HTTP 状态与原始响应，供报告与成本核算使用。
 *
 * 为什么用"抛错"而不是"返回假回执"：假回执会让流程以为发成功了，于是记一次发言、
 * 推进冷却、写 sent-log——评测结果看起来更"完整"，但它证明的是"假回执能用"，
 * 而不是"没有真的发出去"。抛错让这条路径在评测里就是一条明确的失败，谁碰谁红。
 *
 * 为什么平台端口还要做成 Proxy：真实发送分支不止一个（文字、引用、表情包、私聊、
 * 主动联系、将来的语音）。只拦 `sendGroupMessage` 会和 `check-layers` 里 R5/R6 的
 * 教训一样——**拦一处，等于没拦**。这里对"看起来像发送的任何一个方法名"统一处理。
 */

/** 评测用的**固定假群号**（19 位 QQ 群号的形状，但它是编的；报告里也只出现这个）。 */
export const FAKE_GROUP_ID = 1000000003

/** 评测用的**固定假 selfId**（同上：只用来填端口字段，不指向任何人）。 */
export const FAKE_SELF_ID = 88888

/** 平台端口上**必须**被绊住的方法名（任务 §2.3 点名的三个）。 */
const REQUIRED_TRIPWIRES = Object.freeze(['sendGroupMessage', 'sendPrivateMessage', 'sendTo'])

/** 名字看起来像发送的一律也绊住（新增发送路径不需要改这里，见文件头）。 */
const SEND_LIKE = /^send/i

/**
 * 造一个**只记不发**的平台端口。
 *
 * @param {object} [options]
 * @param {string} [options.label] 记录里用的来源标签（例如 'presence-cycle'）
 * @returns {{platform: object, trips: {method: string, groupId: unknown, message: unknown, stack: string}[], hit: () => boolean}}
 */
export function createTripwirePlatform({ label = 'presence-cycle' } = {}) {
  /** 每一次被绊住就 push 一条；非空 = 这次评测出现了真实发送尝试 = HARD FAIL。 */
  const trips = []

  const trip = (method) => (...args) => {
    const record = {
      method,
      label,
      groupId: args[0] ?? null,
      message: args[1] ?? null,
      stack: new Error('tripwire').stack?.split('\n').slice(1, 4).join(' | ') ?? '',
    }
    trips.push(record)
    throw new Error(
      `tripwire: 评测期间调用了 ${method}——影子运行不允许任何 QQ 发送（HARD FAIL）`,
    )
  }

  /** 把"看起来像发送的方法"换成抛错版本；其余属性原样透传。 */
  const guard = (target) => new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'string' && (REQUIRED_TRIPWIRES.includes(prop) || SEND_LIKE.test(prop))) {
        return trip(prop)
      }
      return Reflect.get(obj, prop, receiver)
    },
  })

  const api = guard({})
  const platform = guard({
    selfId: FAKE_SELF_ID,
    isConnected: () => true,
    api,
  })

  return {
    platform,
    trips,
    hit: () => trips.length > 0,
  }
}

/** 绊线自测（`--selftest` 与运行时都会用到）：真的调一次，确认它炸了并且被记下来。 */
export function tripwireSelfTest() {
  const { platform, trips } = createTripwirePlatform({ label: 'selftest' })
  const results = []
  const call = (fn) => {
    try {
      fn()
      return { threw: false }
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) }
    }
  }
  results.push({ method: 'api.sendGroupMessage', ...call(() => platform.api.sendGroupMessage(FAKE_GROUP_ID, [])) })
  results.push({ method: 'api.sendPrivateMessage', ...call(() => platform.api.sendPrivateMessage(1, [])) })
  results.push({ method: 'sendTo', ...call(() => platform.sendTo(1, [])) })
  // 将来新增的发送方法（名字以 send 开头）也必须被绊住，不需要改这个文件。
  results.push({ method: 'api.sendGroupVoice', ...call(() => platform.api.sendGroupVoice(FAKE_GROUP_ID, {})) })
  const nonSend = { isConnected: typeof platform.isConnected === 'function', selfId: platform.selfId }
  return {
    ok: trips.length === results.length && results.every((item) => item.threw) && nonSend.isConnected === true,
    trips: trips.length,
    results,
    nonSend,
  }
}

/** 一次请求的记录（报告与 JSONL 都从这里取；**不含** API key）。 */
function emptyUsage() {
  return { promptTokens: null, completionTokens: null, totalTokens: null }
}

/**
 * 真实模型补全端口（OpenAI 兼容 `POST {base}/chat/completions`）。
 *
 * 形状严格照 `presence-flow.ts` 的 `CompletePort`：`complete(request) → CompleteResult`，
 * **绝不抛**（抛了会让 `runPresenceCycle` 的"绝不抛"保证失效，评测就变成崩而不是记）。
 *
 * @param {object} options
 * @param {object} options.config `readConfig()` 的 `config`
 * @param {typeof fetch} [options.fetchImpl] 注入点（自测用它打本地假服务，绝不联网）
 * @param {(request: object) => void} [options.onRequest]
 * @param {(record: object) => void} [options.onResponse]
 */
export function createModelPort({ config, fetchImpl = globalThis.fetch, onRequest, onResponse }) {
  /** 这个端口发出的全部请求（按发出顺序；报告里的 token/耗时都从这里算）。 */
  const requests = []

  async function complete(request) {
    const startedAt = Date.now()
    const record = {
      /** 生产提示词原文（只在本地落盘；JSONL 里只写它的哈希）。 */
      prompt: request.prompt,
      promptChars: [...String(request.prompt ?? '')].length,
      maxTokens: request.maxTokens ?? null,
      timeoutMs: request.timeoutMs ?? config.timeoutMs,
      preferredEffort: request.preferredEffort ?? null,
      sessionId: request.sessionId ?? null,
      model: config.model,
      temperature: config.temperature,
      httpStatus: null,
      latencyMs: 0,
      usage: emptyUsage(),
      /** 端点的原始输出（决策 JSON 或坏文本；报告里的"原始输出"就是它）。 */
      text: '',
      errorCode: null,
      detail: '',
    }
    onRequest?.(record)
    const finish = (result, code) => {
      record.latencyMs = Date.now() - startedAt
      record.errorCode = code ?? null
      record.resultKind = result.kind
      requests.push(record)
      onResponse?.(record)
      return result
    }
    const headers = { 'content-type': 'application/json' }
    if (config.apiKeySet) headers.authorization = `Bearer ${config.apiKey}`
    let response
    try {
      response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          max_tokens: record.maxTokens ?? undefined,
          messages: [{ role: 'user', content: request.prompt }],
        }),
        signal: AbortSignal.timeout(record.timeoutMs ?? config.timeoutMs),
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const detail = error instanceof Error ? error.message : String(error)
      // 超时单独一档：模型太慢与端点不可达是两种运维动作。
      const timeout = name === 'TimeoutError' || name === 'AbortError' || /timeout|aborted/i.test(detail)
      return finish({ kind: timeout ? 'timeout' : 'failed', detail }, timeout ? 'timeout' : 'network')
    }
    record.httpStatus = response.status
    let payload = null
    try {
      payload = await response.json()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return finish({ kind: 'failed', detail: `响应不是 JSON（HTTP ${String(response.status)}）：${detail}` }, 'bad-json')
    }
    if (!response.ok) {
      return finish({
        kind: 'failed',
        detail: `HTTP ${String(response.status)}：${tail(JSON.stringify(payload))}`,
      }, 'http-error')
    }
    const text = payload?.choices?.[0]?.message?.content
    record.usage = usageOf(payload?.usage)
    record.text = typeof text === 'string' ? text : ''
    if (typeof text !== 'string' || text.trim() === '') {
      return finish({ kind: 'failed', detail: '模型返回空内容' }, 'empty-content')
    }
    return finish({ kind: 'text', text })
  }

  return { complete, requests }
}

/** token 用量：兼容 `prompt_tokens/completion_tokens` 与 `input_tokens/output_tokens` 两种叫法。 */
export function usageOf(usage) {
  if (usage === null || typeof usage !== 'object') return emptyUsage()
  const pick = (...keys) => {
    for (const key of keys) {
      const value = usage[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    }
    return null
  }
  const promptTokens = pick('prompt_tokens', 'input_tokens')
  const completionTokens = pick('completion_tokens', 'output_tokens')
  const totalTokens = pick('total_tokens') ?? (
    promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null
  )
  return { promptTokens, completionTokens, totalTokens }
}

/**
 * 成本：**只用用户给的单价**，没给就是 `null`（绝不编一个价格出来）。
 *
 * 单价口径是"每百万 token"的计价单位，与端点的账单同一单位；报告里不写货币符号，
 * 因为不同服务的计价单位不同（美元/元/点数），猜错比留空更糟。
 */
export function costOf(usage, prices) {
  const inputPerMTok = prices?.inputPerMTok ?? null
  const outputPerMTok = prices?.outputPerMTok ?? null
  const inputUsd = inputPerMTok !== null && usage?.promptTokens !== null && usage?.promptTokens !== undefined
    ? (usage.promptTokens / 1_000_000) * inputPerMTok
    : null
  const outputUsd = outputPerMTok !== null && usage?.completionTokens !== null && usage?.completionTokens !== undefined
    ? (usage.completionTokens / 1_000_000) * outputPerMTok
    : null
  const total = inputUsd !== null && outputUsd !== null ? inputUsd + outputUsd : null
  return {
    input: inputUsd,
    output: outputUsd,
    total,
    unit: 'price-per-MTok',
    /** 缺哪一侧的单价（报告里要写清楚为什么没有总价）。 */
    missing: [
      inputPerMTok === null ? 'EVAL_GROUP_LLM_PRICE_INPUT_PER_MTOK' : '',
      outputPerMTok === null ? 'EVAL_GROUP_LLM_PRICE_OUTPUT_PER_MTOK' : '',
    ].filter((item) => item !== ''),
  }
}

/** 响应正文截一段（诊断用；不落盘完整错误体，免得把端点返回的敏感内容抄一份）。 */
function tail(text, max = 200) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
