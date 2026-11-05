/** 供应商实测：按协议发真实请求，五档逐步加码。
 *
 * 为什么要分档：2026-10-17 实测过一个供应商——139KB 请求 12 秒正常、600KB+
 * 直接挂死。只测"能连通"会给出假阳性，真切过去才发现机器人回不了话。
 *
 * 三种协议各自的形状（pi-ai 的协议枚举）：
 *   openai-completions  POST {base}/chat/completions   Authorization: Bearer
 *   openai-responses    POST {base}/responses          Authorization: Bearer
 *   anthropic-messages  POST {base}/messages           x-api-key + anthropic-version
 * anthropic 的 baseURL 要带 `/v1`（如 https://api.anthropic.com/v1）。
 */

import { systemHttp } from '../http/client.js'

export interface ProbeTarget {
  protocol: string
  baseURL: string
  key: string
  model: string
  /** 用户自定义头（已校验；保留名不会走到这里）。 */
  headers: Record<string, string>
}

export interface ProbeStep {
  step: string
  ok: boolean
  ms: number
  httpStatus?: number
  note?: string
}

const USER = '回复一个字：好'
const TOOL = { name: 'echo', description: '回显 text' }

/** 生成填充体（1 汉字 ≈ 3 字节 UTF-8）。 */
function filler(chars: number): string {
  return '字'.repeat(chars)
}

interface BodyOptions {
  fillerChars?: number
  stream?: boolean
  tools?: boolean
}

/** 按协议拼请求体。 */
export function buildBody(protocol: string, model: string, opts: BodyOptions = {}): string {
  const text = opts.fillerChars === undefined ? USER : `${filler(opts.fillerChars)}\n${USER}`
  if (protocol === 'anthropic-messages') {
    const body: Record<string, unknown> = {
      model, max_tokens: 16, messages: [{ role: 'user', content: text }],
    }
    if (opts.stream === true) body.stream = true
    if (opts.tools === true) {
      body.tools = [{ ...TOOL, input_schema: { type: 'object', properties: { text: { type: 'string' } } } }]
    }
    return JSON.stringify(body)
  }
  if (protocol === 'openai-responses') {
    const body: Record<string, unknown> = { model, input: text, max_output_tokens: 16 }
    if (opts.stream === true) body.stream = true
    if (opts.tools === true) {
      body.tools = [{ type: 'function', ...TOOL, parameters: { type: 'object', properties: { text: { type: 'string' } } } }]
    }
    return JSON.stringify(body)
  }
  const messages = opts.fillerChars === undefined
    ? [{ role: 'user', content: text }]
    : [{ role: 'system', content: filler(opts.fillerChars) }, { role: 'user', content: USER }]
  const body: Record<string, unknown> = { model, messages, max_tokens: 16 }
  if (opts.stream === true) body.stream = true
  if (opts.tools === true) {
    body.tools = [{ type: 'function', function: { ...TOOL, parameters: { type: 'object', properties: { text: { type: 'string' } } } } }]
  }
  return JSON.stringify(body)
}

/** 协议对应的请求路径。 */
export function probeUrl(baseURL: string, protocol: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (protocol === 'anthropic-messages') return `${base}/messages`
  if (protocol === 'openai-responses') return `${base}/responses`
  return `${base}/chat/completions`
}

/** 认证头：anthropic 用 x-api-key + anthropic-version，其余 Bearer。 */
export function authHeaders(protocol: string, key: string, custom: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...custom }
  const has = (name: string): boolean => Object.keys(headers).some((k) => k.toLowerCase() === name)
  if (protocol === 'anthropic-messages') {
    if (!has('x-api-key')) headers['x-api-key'] = key
    if (!has('anthropic-version')) headers['anthropic-version'] = '2023-06-01'
  } else if (!has('authorization')) {
    headers.authorization = `Bearer ${key}`
  }
  return headers
}

/** 判定一档的结果：2xx 且响应体是该协议的一次完整回复。 */
export function grade(protocol: string, status: number, ok: boolean, text: string, expectStream: boolean): { ok: boolean; note?: string } {
  if (!ok) return { ok: false, note: `HTTP ${status}：${text.slice(0, 160)}` }
  if (expectStream) return text.trimStart().startsWith('data:') ? { ok: true } : { ok: false, note: `非流式响应：${text.slice(0, 100)}` }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, note: '响应不是对象' }
    const record = parsed as Record<string, unknown>
    const shape = protocol === 'anthropic-messages'
      ? record.type === 'message' || Array.isArray(record.content)
      : protocol === 'openai-responses'
        ? record.object === 'response' || Array.isArray(record.output) || typeof record.id === 'string'
        : Array.isArray(record.choices)
    return shape ? { ok: true } : { ok: false, note: `响应形状不符：${text.slice(0, 100)}` }
  } catch {
    return { ok: false, note: `非 JSON 响应：${text.slice(0, 100)}` }
  }
}

interface Probe {
  step: string
  timeoutMs: number
  opts: BodyOptions
}

export const PROBES: readonly Probe[] = [
  { step: '连通', timeoutMs: 20_000, opts: {} },
  { step: '中等体量(~150KB)', timeoutMs: 45_000, opts: { fillerChars: 50_000 } },
  { step: '大请求(~600KB)', timeoutMs: 60_000, opts: { fillerChars: 200_000 } },
  { step: '流式', timeoutMs: 30_000, opts: { stream: true } },
  { step: '工具调用', timeoutMs: 30_000, opts: { tools: true } },
]

async function runOne(target: ProbeTarget, probe: Probe): Promise<ProbeStep> {
  const started = Date.now()
  const body = buildBody(target.protocol, target.model, probe.opts)
  try {
    const res = await systemHttp.request(probeUrl(target.baseURL, target.protocol), {
      method: 'POST',
      headers: authHeaders(target.protocol, target.key, target.headers),
      body,
      timeoutMs: probe.timeoutMs,
      limit: 512 * 1024,
      // 供应商地址由运维在后台填写（含本机中转如 127.0.0.1:3123），属于
      // ports/http.ts 允许打开私网的第一类。
      allowPrivateHosts: true,
    })
    const graded = grade(target.protocol, res.status, res.ok, res.text(), probe.opts.stream === true)
    return {
      step: probe.step, ok: graded.ok, ms: Date.now() - started, httpStatus: res.status,
      ...graded.note === undefined ? {} : { note: graded.note },
    }
  } catch (error) {
    return {
      step: probe.step, ok: false, ms: Date.now() - started,
      note: String(error instanceof Error ? error.message : error).slice(0, 200),
    }
  }
}

/** 依次跑五档；一档失败也继续（报告要能看出"挂在哪一档"）。 */
export async function runProbes(target: ProbeTarget): Promise<ProbeStep[]> {
  const steps: ProbeStep[] = []
  for (const probe of PROBES) steps.push(await runOne(target, probe))
  return steps
}
