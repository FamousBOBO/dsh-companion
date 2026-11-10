/**
 * **真实模型通道的环境变量约定**（P5-C / 计划 §2.3、§9 任务 04）。
 *
 * 与仓库既有的 `eval/lib/llm-review.mjs` 同一套做法：端点走环境变量、**未配置就明确说没配**，
 * 不猜、不探测、不建默认连接。区别只在于用途——那边是"给失败条目加一段评审意见"，
 * 这里是"把生产提示词发给真实模型，看它给出哪一档决策"。两件事共用一套 $EVAL_*  风格的名字，
 * 前缀分开（`EVAL_GROUP_LLM_*` 而不是 `EVAL_LLM_*`），避免两个通道互相串配置。
 *
 * | 变量 | 必填 | 默认 | 说明 |
 * |---|---|---|---|
 * | `EVAL_GROUP_LLM_BASE_URL` | **是** | — | OpenAI 兼容端点，如 `http://127.0.0.1:8000/v1`（可以带尾斜杠） |
 * | `EVAL_GROUP_LLM_MODEL` | 否 | `default` | 模型名（与 `llm-review.mjs` 同口径） |
 * | `EVAL_GROUP_LLM_API_KEY` | 否 | — | 需要鉴权时给；**不进报告**（报告只记"是否配置"） |
 * | `EVAL_GROUP_LLM_TEMPERATURE` | 否 | `0` | 默认 0：同一条样例重跑应当稳定；采样波动见 `EVAL_GROUP_LLM_REPEAT` |
 * | `EVAL_GROUP_LLM_TIMEOUT_MS` | 否 | `60000` | 单次请求超时，夹在 [1000, 600000] |
 * | `EVAL_GROUP_LLM_REPEAT` | 否 | `1` | 同一条跑几次（夹在 [1, 20]），用于报告非确定性 |
 * | `EVAL_GROUP_LLM_PRICE_INPUT_PER_MTOK` | 否 | — | 每百万 input token 的价格（**不填就不报钱**） |
 * | `EVAL_GROUP_LLM_PRICE_OUTPUT_PER_MTOK` | 否 | — | 每百万 output token 的价格 |
 * | `EVAL_GROUP_LLM_OUT` | 否 | `eval/group/llm/out` | 逐条日志与报告的落盘目录 |
 *
 * 三条口径：
 *   1. **没配就是没配**：`EVAL_GROUP_LLM_BASE_URL` 缺失时运行器退出码 2 并打印怎么配，
 *      而不是失败（退出码 1 留给"配置好了但跑不出成绩"）。这与离线通道的 0/1/2 语义一致。
 *   2. **价格是用户给的，不是我们编的**：没有配价格就只报 token 数，报告里明写"未配置价格"。
 *   3. **端点只用于这一次运行**：不写配置、不改 `config/suite.json`、不联网探测。
 */

/** 环境变量名（报告与说明里引用同一份常量，避免文档与代码写歪）。 */
export const ENV = Object.freeze({
  baseUrl: 'EVAL_GROUP_LLM_BASE_URL',
  model: 'EVAL_GROUP_LLM_MODEL',
  apiKey: 'EVAL_GROUP_LLM_API_KEY',
  temperature: 'EVAL_GROUP_LLM_TEMPERATURE',
  timeoutMs: 'EVAL_GROUP_LLM_TIMEOUT_MS',
  repeat: 'EVAL_GROUP_LLM_REPEAT',
  priceIn: 'EVAL_GROUP_LLM_PRICE_INPUT_PER_MTOK',
  priceOut: 'EVAL_GROUP_LLM_PRICE_OUTPUT_PER_MTOK',
  outDir: 'EVAL_GROUP_LLM_OUT',
})

/** 默认落盘目录（相对 `eval/group/llm/`；已 gitignore）。 */
export const DEFAULT_OUT = 'out'

/** 默认模型名：与 `eval/lib/llm-review.mjs` 一致（那边也默认 `default`）。 */
export const DEFAULT_MODEL = 'default'

/** 未配置时打印的说明（可复现命令写在这里，README 引用同一段文字）。 */
export const NOT_CONFIGURED_LINES = Object.freeze([
  '真实模型通道没有配置端点，本次**不运行**（这不是失败，退出码 2）。',
  '',
  '先把要用的 OpenAI 兼容端点指过来（下面四条是 PowerShell 与 bash 都能用的写法）：',
  '  EVAL_GROUP_LLM_BASE_URL = http://127.0.0.1:8000/v1',
  '  EVAL_GROUP_LLM_MODEL    = <你的模型名>',
  '  EVAL_GROUP_LLM_API_KEY  = <需要鉴权时才填>',
  '  EVAL_GROUP_LLM_REPEAT   = 1        # 同一条跑几次（>1 用来观察采样波动）',
  '',
  '然后再跑：',
  '  cd plugins/dsh-channel-qq && node eval/group/llm/run.mjs',
  '  cd plugins/dsh-channel-qq && npm run eval:group:llm',
  '',
  '不接触任何模型也能验证这条通道本身（本地起假 OpenAI 服务，绝不联网）：',
  '  node eval/group/llm/run.mjs --selftest',
  '',
  '注意：本通道**永不发送 QQ 消息**——平台端口是绊线，任何一次发送调用都会直接抛错并记 HARD FAIL。',
])

/** 一个整数环境变量：缺省/非法给默认值，给了就夹在区间里。 */
function intOf(value, fallback, { min, max }) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  return Math.min(max, Math.max(min, rounded))
}

/** 一个价格（>0 才有意义）：没配/非法/负数一律当"没配"，绝不拿 0 冒充价格。 */
function priceOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** 端点必须是 http(s)；只留协议+主机+端口进报告（路径里可能带着 key）。 */
function parseBaseUrl(raw) {
  const text = String(raw ?? '').trim().replace(/\/+$/, '')
  if (text === '') return { error: '为空' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { error: '不是合法 URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: `协议只支持 http/https（拿到 ${url.protocol}）` }
  return { baseUrl: text, origin: url.origin }
}

/**
 * 读配置。**绝不抛**：配置坏了要能打印"坏在哪一条"，而不是丢一段 stack。
 *
 * @returns {{ok: boolean, problems: string[], config: object}}
 */
export function readConfig(env = process.env) {
  const problems = []
  const rawBase = env[ENV.baseUrl]
  const parsed = parseBaseUrl(rawBase)
  if (rawBase === undefined || String(rawBase).trim() === '') problems.push(`缺少 ${ENV.baseUrl}`)
  else if (parsed.error !== undefined) problems.push(`${ENV.baseUrl} ${parsed.error}`)
  const apiKey = typeof env[ENV.apiKey] === 'string' ? env[ENV.apiKey].trim() : ''
  const priceIn = priceOf(env[ENV.priceIn])
  const priceOut = priceOf(env[ENV.priceOut])
  const config = {
    baseUrl: parsed.baseUrl ?? '',
    origin: parsed.origin ?? '',
    model: typeof env[ENV.model] === 'string' && env[ENV.model].trim() !== '' ? env[ENV.model].trim() : DEFAULT_MODEL,
    apiKey,
    apiKeySet: apiKey !== '',
    temperature: intOf(env[ENV.temperature], 0, { min: 0, max: 2 }),
    timeoutMs: intOf(env[ENV.timeoutMs], 60_000, { min: 1_000, max: 600_000 }),
    repeat: intOf(env[ENV.repeat], 1, { min: 1, max: 20 }),
    prices: { inputPerMTok: priceIn, outputPerMTok: priceOut },
    outDir: typeof env[ENV.outDir] === 'string' && env[ENV.outDir].trim() !== '' ? env[ENV.outDir].trim() : DEFAULT_OUT,
  }
  return { ok: problems.length === 0, problems, config }
}

/**
 * 进报告的那几项（**不含** API key、不含完整端点路径）。
 *
 * 只记 origin 是刻意的：反向代理常见 `https://host/proxy/<token>/v1`，把完整 URL 写进
 * JSONL 等于把凭据抄一份到磁盘上并可能被贴进工单。
 */
export function describeConfig(config) {
  return {
    endpointOrigin: config.origin,
    model: config.model,
    apiKeyConfigured: config.apiKeySet,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    repeat: config.repeat,
    pricesConfigured: config.prices.inputPerMTok !== null || config.prices.outputPerMTok !== null,
  }
}
